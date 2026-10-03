"""同步服务 — 拉取店铺元数据 + 每日快照，写入 SQLite"""

from __future__ import annotations

import json
import threading
from datetime import datetime

from . import db

_sync_state = {"running": False, "message": "", "counts": {}, "error": None}
_lock = threading.Lock()


def _num(value):
    if value == "" or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sync_store(store_name: str, days_back: int = 90) -> tuple[str, int]:
    from src.store import Store
    from src.atoms import orders, products
    from src.timeutil import br_date_str, br_days_ago

    store = Store(store_name)
    try:
        store.refresh_token()
    except Exception:  # noqa: BLE001
        pass

    # 1) 商品元数据 + 体验分 + 是否投广告
    flat = products.flatten_products(store)
    item_ids = list(dict.fromkeys(p["item_id"] for p in flat if "_error" not in p))
    performance = {iid: products.get_performance(store, iid) for iid in item_ids}
    advertiser_id = products.get_advertiser_id(store, store.site_id)
    ads_now = (
        products.get_ads_by_item(store, store.site_id, advertiser_id)
        if advertiser_id
        else {}
    )

    now = datetime.now().isoformat(timespec="seconds")
    conn = db.get_conn()
    conn.execute("DELETE FROM product_variation WHERE store = ?", (store.display_name,))

    rows = []
    for p in flat:
        if "_error" in p:
            continue
        item_id = p["item_id"]
        pdata = performance.get(item_id, {})
        score = pdata.get("score", "")
        score_val = score.get("score", "") if isinstance(score, dict) else score
        level = score.get("level", "") if isinstance(score, dict) else ""
        has_ads = bool(ads_now.get(item_id))
        attrs = p.get("attributes") or {}
        if not isinstance(attrs, (dict, list)):
            attrs = {}
        rows.append(
            (
                store.display_name,
                item_id,
                p.get("variation_id"),
                p.get("title"),
                p.get("seller_sku"),
                p.get("gtin"),
                _num(p.get("price")),
                _num(p.get("available_quantity")),
                p.get("currency_id"),
                _num(score_val),
                level,
                1 if has_ads else 0,
                _num(p.get("original_price")),
                _num(p.get("sale_price")),
                p.get("promotion_type") or "",
                _num(p.get("platform_shipping")),
                p.get("status") or "",
                p.get("listing_type") or "",
                1 if p.get("free_shipping") else 0,
                _num(p.get("official_fee_rate")),
                p.get("shipping_payer") or "meli",
                (p.get("date_created") or "")[:10],
                json.dumps(attrs, ensure_ascii=False),
                now,
            )
        )

    ph = ",".join("?" * len(db.COLUMNS))
    conn.executemany(
        f"INSERT INTO product_variation ({','.join(db.COLUMNS)}) VALUES ({ph})", rows
    )

    # 2) 每日商品状态快照（daily_stock）：记录"今天"每个商品的 库存/价格/体验分 等聚合值。
    #    聚合口径与飞书 _daily_rows 的 product_variation 子查询一致；每天多次同步，最后一次覆盖=当天终值。
    #    （ML 不提供历史库存，只能自己从启用日起记录；飞书历史行用它显示当天的真实值）
    conn.execute(
        """
        INSERT INTO daily_stock
            (store, item_id, date, available_quantity, price, original_price, performance_score,
             has_ads, variation_count, official_fee_rate, listing_type, platform_shipping, shipping_payer)
        SELECT store, item_id, ?, SUM(COALESCE(available_quantity,0)), MIN(price), MAX(original_price),
               MAX(performance_score), MAX(has_ads), COUNT(*), MAX(official_fee_rate),
               MAX(listing_type), MAX(platform_shipping), MAX(shipping_payer)
        FROM product_variation WHERE store = ? GROUP BY store, item_id
        ON CONFLICT(store, item_id, date) DO UPDATE SET
            available_quantity=excluded.available_quantity, price=excluded.price,
            original_price=excluded.original_price, performance_score=excluded.performance_score,
            has_ads=excluded.has_ads, variation_count=excluded.variation_count,
            official_fee_rate=excluded.official_fee_rate, listing_type=excluded.listing_type,
            platform_shipping=excluded.platform_shipping, shipping_payer=excluded.shipping_payer
        """,
        (br_date_str(), store.display_name),
    )

    # 3) 每日快照：广告 + 订单（只拉最近 days_back 天，按完整日历天）
    daily_ads = products.collect_daily_ads(store, days=days_back)
    daily_orders = orders.collect_daily_orders(store, days=days_back)

    daily_rows = []
    for key in set(daily_ads.keys()) | set(daily_orders.keys()):
        item_id, date = key
        ad = daily_ads.get(key, {})
        od = daily_orders.get(key, {})
        daily_rows.append(
            (
                store.display_name,
                item_id,
                date,
                ad.get("ad_cost", 0.0),
                ad.get("ad_clicks", 0.0),
                ad.get("ad_impressions", 0.0),
                ad.get("ad_ctr", 0.0),
                ad.get("ad_sales", 0.0),
                ad.get("ad_roas", 0.0),
                ad.get("ad_acos", 0.0),
                od.get("sold_quantity", 0.0),
                od.get("revenue", 0.0),
                od.get("commission", 0.0),
                od.get("shipping_fee", 0.0),
                od.get("order_count", 0),
                od.get("unit_price"),
                od.get("full_unit_price"),
                od.get("coupon_amount", 0.0),
                od.get("gross_amount", 0.0),
            )
        )

    # 窗口内先删后插（同一事务）：让「今天付款、之后取消」的订单/停投的广告从最近窗口移除，
    # 与后台保持一致；窗口之外的历史不受影响。主键 (store,item_id,date)。
    # 删除起点取「实际拉到的日期」而非计算值，防止时区/边界导致拉到窗口外一天 → UNIQUE 冲突。
    if daily_rows:
        min_date = min(r[2] for r in daily_rows)  # DAILY_COLUMNS 中 date 是第 3 列（索引 2）
        conn.execute(
            "DELETE FROM daily_snapshot WHERE store = ? AND date >= ?",
            (store.display_name, min_date),
        )
        dph = ",".join("?" * len(db.DAILY_COLUMNS))
        conn.executemany(
            f"INSERT INTO daily_snapshot ({','.join(db.DAILY_COLUMNS)}) VALUES ({dph})",
            daily_rows,
        )

    conn.commit()
    conn.close()
    return store.display_name, len(rows)


def run_sync(store_names: list[str] | None = None, days_back: int = 90) -> dict:
    global _sync_state
    with _lock:
        if _sync_state["running"]:
            return {"running": True, "message": "同步进行中"}
        _sync_state = {"running": True, "message": "同步中", "counts": {}, "error": None}

    try:
        from src.store import list_stores

        names = store_names or list_stores()
        counts = {}
        for name in names:
            display_name, cnt = _sync_store(name, days_back=days_back)
            counts[display_name] = cnt
        # 数据已更新，清空访客缓存，避免读到旧值
        from src.atoms import products

        products.clear_visits_cache()
        with _lock:
            _sync_state.update({"running": False, "message": "同步完成", "counts": counts})
    except Exception as e:  # noqa: BLE001
        with _lock:
            _sync_state.update({"running": False, "message": "同步失败", "error": str(e)})

    with _lock:
        return dict(_sync_state)


def start_sync_async(store_names: list[str] | None = None, days_back: int = 90) -> dict:
    global _sync_state
    with _lock:
        if _sync_state["running"]:
            return {"running": True, "message": "同步进行中"}

    t = threading.Thread(target=run_sync, args=(store_names, days_back), daemon=True)
    t.start()
    return {"running": True, "message": "同步已启动"}


def deep_refresh_ads(store_names: list[str] | None = None, days_back: int = 20) -> dict:
    """周对账：只重拉最近 N 天【广告】数据，upsert 广告列到 daily_snapshot。

    特点：
    - 不拉订单、不做"先删后插"（订单/销量数据不动），API 调用量小，防限流；
    - 覆盖 T+3 定档之外偶尔迟到的广告修正（如 08-15 第 10 天才补全的案例）。"""
    from src.store import Store, list_stores
    from src.atoms import products

    names = store_names or list_stores()
    counts = {}
    total = 0
    for name in names:
        store = Store(name)
        try:
            store.refresh_token()
        except Exception:  # noqa: BLE001
            pass
        daily_ads = products.collect_daily_ads(store, days=days_back)
        if not daily_ads:
            continue
        conn = db.get_conn()
        rows = [
            (
                store.display_name,
                item_id,
                date,
                v.get("ad_cost", 0.0),
                v.get("ad_clicks", 0.0),
                v.get("ad_impressions", 0.0),
                v.get("ad_ctr", 0.0),
                v.get("ad_sales", 0.0),
                v.get("ad_roas", 0.0),
                v.get("ad_acos", 0.0),
            )
            for (item_id, date), v in daily_ads.items()
        ]
        conn.executemany(
            """INSERT INTO daily_snapshot
                   (store, item_id, date, ad_cost, ad_clicks, ad_impressions, ad_ctr, ad_sales, ad_roas, ad_acos)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(store, item_id, date) DO UPDATE SET
                   ad_cost=excluded.ad_cost, ad_clicks=excluded.ad_clicks,
                   ad_impressions=excluded.ad_impressions, ad_ctr=excluded.ad_ctr,
                   ad_sales=excluded.ad_sales, ad_roas=excluded.ad_roas, ad_acos=excluded.ad_acos""",
            rows,
        )
        conn.commit()
        conn.close()
        counts[store.display_name] = len(rows)
        total += len(rows)
    from src.atoms import products as _p

    _p.clear_visits_cache()
    return {"days": f"最近{days_back}天", "rows": total, "counts": counts, "error": None}


def get_sync_status() -> dict:
    with _lock:
        return dict(_sync_state)
