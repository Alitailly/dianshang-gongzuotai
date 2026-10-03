"""飞书多维表格同步 — 每日粒度、按店铺分子表（子表名=店铺名，行=商品×日期，增量 upsert）"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter

from src.atoms import products as products_atom
from src.store import Store, list_stores
from src.timeutil import br_date_str, br_days_ago

from .. import db, feishu, repository

router = APIRouter(prefix="/api/export/bitable", tags=["export"])

# 子表字段定义（每日快照；文本/数字）
# 表名已含 店铺+年月（如「BA05 2026年7月」），行内不再放「月份」列；
# 「日期」用文本 "MM-DD"（如 08-10）表示：不重复年份，且筛选"等于 08-10"即可查某一天。
# 列与看板「商品分析」对齐（同名同口径）：销量/销售额/广告列是"当日"值（表为每日明细），
# 属性列（变体/原价/佣金率%/佣金件/平台运费/实际收入件/广告）同商品每天相同
TEXT_FIELDS = ["日期", "店铺", "商品", "SKU", "商品ID", "广告状态", "同步时间", "广告"]
NUM_FIELDS = [
    # 商品信息（属性）
    "变体", "现价", "原价", "佣金率%", "佣金/件", "平台运费", "实际收入/件",
    # 库存
    "已售", "可售库存",
    # 流量·自然vs付费
    "全流量总访问", "自然访问(估算)", "广告点击", "曝光",
    "自然访问占比(访问)", "广告点击占比(访问)",
    "自然销售额", "广告收入", "自然销售额占比(销售)", "广告销售额占比(销售)",
    # 广告·加投决策
    "广告花费", "ROAS", "保本ROAS", "ACOS%", "CTR%",
    # 质量
    "体验分",
]

FIELD_DEFS = [{"field_name": n, "type": 1} for n in TEXT_FIELDS] + [
    {"field_name": n, "type": 2, "property": {"formatter": "0.00", "decimal_count": 2}} for n in NUM_FIELDS
]

# 广告 T+1 定档（次日 10:00 巴西）：定档日之前的行广告数据可靠，之后的为预览/不完整
AD_FINALIZED_KEY = "广告状态"
AD_FINALIZED_OK = "已定档"
AD_FINALIZED_PENDING = "未定档·广告预览"


def _to_num(v):
    if v is None or v == "" or v == "-":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _day_num(v):
    """日期列的"日"统一转 int（飞书 API 有时把数字字段返回成字符串）"""
    n = _to_num(v)
    return int(n) if n is not None else v


def _daily_rows(display: str, df: str, dt: str, ts: str) -> list[dict]:
    """读取本地 daily_snapshot（按天）join 商品当前字段，组装每日行记录"""
    conn = db.get_conn()
    rows = conn.execute(
        """
        SELECT d.date, d.item_id,
               COALESCE(d.sold_quantity,0) AS sold_quantity,
               COALESCE(d.revenue,0) AS revenue,
               COALESCE(d.commission,0) AS commission,
               COALESCE(d.shipping_fee,0) AS shipping_fee,
               COALESCE(d.order_count,0) AS order_count,
               COALESCE(d.ad_clicks,0) AS ad_clicks,
               COALESCE(d.ad_impressions,0) AS ad_impressions,
               COALESCE(d.ad_cost,0) AS ad_cost,
               COALESCE(d.ad_sales,0) AS ad_sales,
               p.title, p.seller_sku, p.date_created,
               -- 可售库存：只取"当天快照"（无快照=历史不可知→空白）；其余属性列优先快照、无快照回退商品当前值
               ds.available_quantity AS available_quantity,
               COALESCE(ds.price, p.price) AS price,
               COALESCE(ds.performance_score, p.performance_score) AS performance_score,
               COALESCE(ds.variation_count, p.variation_count) AS variation_count,
               COALESCE(ds.original_price, p.original_price) AS original_price,
               COALESCE(ds.official_fee_rate, p.official_fee_rate) AS official_fee_rate,
               COALESCE(ds.listing_type, p.listing_type) AS listing_type,
               COALESCE(ds.platform_shipping, p.platform_shipping) AS platform_shipping,
               COALESCE(ds.shipping_payer, p.shipping_payer) AS shipping_payer,
               COALESCE(ds.has_ads, p.has_ads) AS has_ads
        FROM daily_snapshot d
        LEFT JOIN (
            SELECT store, item_id,
                   MAX(title) AS title,
                   MAX(NULLIF(seller_sku, '')) AS seller_sku,
                   COUNT(*) AS variation_count,
                   SUM(COALESCE(available_quantity,0)) AS available_quantity,
                   MIN(price) AS price,
                   MAX(performance_score) AS performance_score,
                   MAX(date_created) AS date_created,
                   MAX(original_price) AS original_price,
                   MAX(official_fee_rate) AS official_fee_rate,
                   MAX(listing_type) AS listing_type,
                   MAX(platform_shipping) AS platform_shipping,
                   MAX(shipping_payer) AS shipping_payer,
                   MAX(has_ads) AS has_ads
            FROM product_variation GROUP BY store, item_id
        ) p
          ON p.store = d.store AND p.item_id = d.item_id
        LEFT JOIN daily_stock ds
          ON ds.store = d.store AND ds.item_id = d.item_id AND ds.date = d.date
        WHERE d.store = ? AND d.date >= ? AND d.date <= ?
          -- 过滤上架前的 00 行：只保留商品上架日（含）之后的数据
          AND d.date >= COALESCE(substr(p.date_created, 1, 10), '0000-00-00')
        ORDER BY d.date, d.item_id
        """,
        (display, df, dt),
    ).fetchall()
    conn.close()

    records = []
    from src.timeutil import br_latest_finalized_date

    finalized = br_latest_finalized_date()  # 广告定档截止日（未定档日=今天、10:00 前的昨天）

    def _make_rec(d, ad_ok):
        price = _to_num(d.get("price"))
        op = _to_num(d.get("original_price")) or price  # 原价没设置→原价=现价（与看板一致）
        # 佣金率%：官方精确费率（与看板 _compute_ratios 同口径：0/空视为未取到 → 按 listing 类型回退）
        fee = _to_num(d.get("official_fee_rate"))
        lt = (d.get("listing_type") or "").strip()
        cr = fee if fee else repository._official_commission_rate(lt)
        unit_comm = round(price * cr / 100, 2) if price is not None and cr is not None else None
        # 平台运费（按承担方，与看板一致）：seller→成本价；buyer/meli→0；未知→空
        payer = (d.get("shipping_payer") or "").strip()
        ps = _to_num(d.get("platform_shipping"))
        if payer == "seller" and ps:
            ship = round(ps, 2)
        elif payer in ("buyer", "meli"):
            ship = 0.0
        else:
            ship = ps
        unit_income = (
            round(price - unit_comm - ship, 2)
            if (price is not None and unit_comm is not None and ship is not None)
            else None
        )
        rec = {
            "日期": f"{d['date'][5:7]}-{d['date'][8:10]}" if len(d["date"]) >= 10 else None,  # 文本 MM-DD，如 08-10
            "_full_date": d["date"],  # 内部字段：按月份分组/访客查询用（_upsert 时剔除，不写入飞书）
            "店铺": display,
            "商品": d.get("title"),
            "SKU": d.get("seller_sku"),
            "商品ID": d["item_id"],
            "广告状态": AD_FINALIZED_OK if ad_ok else AD_FINALIZED_PENDING,
            "同步时间": ts,
            # 商品信息（属性列，同商品每天相同）
            "变体": d.get("variation_count"),
            "现价": price,
            "原价": op,
            "佣金率%": cr,
            "佣金/件": unit_comm,
            "平台运费": ship,
            "实际收入/件": unit_income,
            # 库存
            "已售": _to_num(d.get("sold_quantity")),
            "可售库存": _to_num(d.get("available_quantity")),
            # 内部字段：派生列（自然销售额/保本ROAS 等）计算用，_upsert 剔除、不写入飞书
            "_revenue": _to_num(d.get("revenue")),
            "_commission": _to_num(d.get("commission")),
            "_shipping": _to_num(d.get("shipping_fee")),
            # 质量
            "体验分": _to_num(d.get("performance_score")),
            "广告": ("有" if d.get("has_ads") else "无") if d.get("has_ads") is not None else "未知",
        }
        # 广告 T+1：已定档日填广告列；未定档日广告数据为预览/不完整 → 显式置空（batch_update 只更新传入字段）
        for k in ("广告点击", "曝光", "广告花费", "广告收入"):
            rec[k] = (
                _to_num(d.get({"广告点击": "ad_clicks", "曝光": "ad_impressions",
                               "广告花费": "ad_cost", "广告收入": "ad_sales"}[k]))
                if ad_ok else None
            )
        return rec

    present = set()
    present_by_day: dict = {}
    for r in rows:
        d = dict(r)
        present.add((d["item_id"], d["date"]))
        present_by_day.setdefault(d["date"], []).append(_make_rec(d, d["date"] <= finalized))

    # 补齐没广告/没订单的商品：每天一行（当日 0 + 当前库存/价格），保证"店铺里有什么商品"完整可见
    conn = db.get_conn()
    all_items = conn.execute(
        """
        SELECT item_id,
               MAX(title) AS title,
               MAX(NULLIF(seller_sku, '')) AS seller_sku,
               COUNT(*) AS variation_count,
               SUM(COALESCE(available_quantity,0)) AS available_quantity,
               MIN(price) AS price,
               MAX(performance_score) AS performance_score,
               MAX(date_created) AS date_created,
               MAX(original_price) AS original_price,
               MAX(official_fee_rate) AS official_fee_rate,
               MAX(listing_type) AS listing_type,
               MAX(platform_shipping) AS platform_shipping,
               MAX(shipping_payer) AS shipping_payer,
               MAX(has_ads) AS has_ads
        FROM product_variation WHERE store = ? GROUP BY item_id
        ORDER BY item_id
        """,
        (display,),
    ).fetchall()
    conn.close()

    from datetime import date, timedelta

    d0 = date.fromisoformat(df)
    d1 = date.fromisoformat(dt)
    days: list[str] = []
    cur = d0
    while cur <= d1:
        days.append(cur.isoformat())
        cur += timedelta(days=1)

    # 每日快照查表：(item_id, date) → 当天聚合值（补零行用；无快照的日子回退商品当前值）
    conn = db.get_conn()
    stock_by_day = {}
    for r in conn.execute(
        """SELECT item_id, date, available_quantity, price, original_price, performance_score,
                  has_ads, variation_count, official_fee_rate, listing_type,
                  platform_shipping, shipping_payer
           FROM daily_stock WHERE store = ?""",
        (display,),
    ).fetchall():
        stock_by_day[(r["item_id"], r["date"])] = r
    conn.close()

    # 补零行按"日"归组（day-major）：同一天的所有商品放一起，保证表内顺序 = 日期升序
    zero_by_day: dict = {}
    for it in all_items:
        iid = it["item_id"]
        created = (it["date_created"] or "")[:10]
        if not created:
            created = df
        for day in days:
            if day < created:
                continue
            if (iid, day) in present:
                continue
            snap = stock_by_day.get((iid, day))
            zero = {
                "date": day,
                "item_id": iid,
                "title": it["title"],
                "seller_sku": it["seller_sku"],
                # 可售库存：无快照（历史不可知）= None（空白）；其余属性列回退商品当前值
                "available_quantity": snap["available_quantity"] if snap else None,
                "price": snap["price"] if snap else it["price"],
                "performance_score": snap["performance_score"] if snap else it["performance_score"],
                "date_created": created,
                "variation_count": snap["variation_count"] if snap else it["variation_count"],
                "original_price": snap["original_price"] if snap else it["original_price"],
                "official_fee_rate": snap["official_fee_rate"] if snap else it["official_fee_rate"],
                "listing_type": snap["listing_type"] if snap else it["listing_type"],
                "platform_shipping": snap["platform_shipping"] if snap else it["platform_shipping"],
                "shipping_payer": snap["shipping_payer"] if snap else it["shipping_payer"],
                "has_ads": snap["has_ads"] if snap else it["has_ads"],
                "sold_quantity": 0, "revenue": 0, "commission": 0, "shipping_fee": 0, "order_count": 0,
                "ad_clicks": 0, "ad_impressions": 0, "ad_cost": 0, "ad_sales": 0,
            }
            zero_by_day.setdefault(day, []).append(_make_rec(zero, day <= finalized))

    # 按"日"合并输出：每天 = 有数据行 + 补零行（保证创建顺序=日期升序，默认视图不乱序）
    records = []
    for day in days:
        records.extend(present_by_day.get(day, []))
        records.extend(zero_by_day.get(day, []))
    return records


def _attach_daily_visits(store_obj, records: list[dict]) -> None:
    """给每日行补「全流量总访问」（visits API time_window 按天去重独立访客）"""
    if not records:
        return
    item_ids = list(dict.fromkeys(r["商品ID"] for r in records))
    per_item = {}
    for iid in item_ids:
        try:
            r = store_obj.client.get(f"/items/{iid}/visits/time_window", params={"last": 90, "unit": "day"})
            per_item[iid] = {x.get("date", "")[:10]: x.get("total", 0) for x in r.get("results", [])}
        except Exception:  # noqa: BLE001
            per_item[iid] = {}
    for rec in records:
        if rec.get("广告状态") == AD_FINALIZED_PENDING:
            rec["全流量总访问"] = None  # 未定档日：访客也是部分数据，显式置空
            continue
        rec["全流量总访问"] = per_item.get(rec["商品ID"], {}).get(rec.get("_full_date"), 0)


# 派生列公式（唯一事实源）：docs/02 §6 的公式表由 scripts/gen_docs.py 从本表生成，勿在文档里手抄。
# 改公式时同步改这里 + 下方 _derive_metrics 的实现。
DERIVED_FORMULAS: dict[str, str] = {
    "自然访问(估算)": "全流量总访问 − 广告点击（近似，见 docs/06 疑点#5）",
    "自然访问占比(访问)": "自然访问 ÷ 全流量总访问 × 100",
    "广告点击占比(访问)": "广告点击 ÷ 全流量总访问 × 100",
    "自然销售额": "销售额 − 广告收入（广告收入可能>销售额→负值，见 docs/06 疑点#2）",
    "自然销售额占比(销售)": "自然销售额 ÷ 销售额 × 100",
    "广告销售额占比(销售)": "广告收入 ÷ 销售额 × 100",
    "ROAS": "广告收入 ÷ 广告花费（花费>0，否则 0）",
    "保本ROAS": "销售额 ÷ (销售额 − 佣金 − 物流 − 广告花费)（分母>0；未扣「其他服务费」，见 docs/06 疑点#3）",
    "ACOS%": "广告花费 ÷ 广告收入 × 100（收入>0，否则 0）",
    "CTR%": "广告点击 ÷ 曝光 × 100（曝光>0，否则 0）",
}


def _derive_metrics(records: list[dict]) -> None:
    """按看板同口径补派生列（每日）：自然访问/占比/ROAS/保本ROAS/ACOS/CTR。
    依赖广告+访客；未定档日（广告列/访客为空）→ 派生列全部显式置空，避免误导。"""
    for rec in records:
        pending = rec.get("广告状态") == AD_FINALIZED_PENDING
        rev, comm, ship = rec.get("_revenue"), rec.get("_commission"), rec.get("_shipping")
        cost, sales = rec.get("广告花费"), rec.get("广告收入")
        clicks, impr = rec.get("广告点击"), rec.get("曝光")
        visits = rec.get("全流量总访问")
        if pending:
            for k in ("自然访问(估算)", "自然访问占比(访问)", "广告点击占比(访问)",
                      "自然销售额", "自然销售额占比(销售)", "广告销售额占比(销售)",
                      "ROAS", "保本ROAS", "ACOS%", "CTR%"):
                rec[k] = None
            continue
        nat_visits = round(visits - clicks, 0) if (visits is not None and clicks is not None) else None
        rec["自然访问(估算)"] = nat_visits
        rec["自然访问占比(访问)"] = round(nat_visits / visits * 100, 1) if visits else 0.0
        rec["广告点击占比(访问)"] = round(clicks / visits * 100, 1) if visits else 0.0
        nat_sales = round(rev - sales, 2) if (rev is not None and sales is not None) else None
        rec["自然销售额"] = nat_sales
        rec["自然销售额占比(销售)"] = round(nat_sales / rev * 100, 1) if rev else 0.0
        rec["广告销售额占比(销售)"] = round(sales / rev * 100, 1) if rev else 0.0
        rec["ROAS"] = round(sales / cost, 2) if cost else 0.0
        settlement = (rev or 0) - (comm or 0) - (ship or 0) - (cost or 0)
        rec["保本ROAS"] = round(rev / settlement, 2) if (rev and settlement > 0) else 0.0
        rec["ACOS%"] = round(cost / sales * 100, 2) if sales else 0.0
        rec["CTR%"] = round(clicks / impr * 100, 2) if impr else 0.0


# 每次同步都会变的字段（不同步时间戳，避免每行都被判定为"有变化"）
_VOLATILE = {"同步时间"}


def _val_norm(v):
    """值归一化用于比较：数字（含飞书返回的数字字符串）→ float，文本原样"""
    n = _to_num(v)
    return n if n is not None else v


def _fields_differ(old_f: dict, rec: dict) -> bool:
    """判断飞书已有行与期望行是否真有变化（跳过 同步时间 等易变字段）"""
    for k, v in rec.items():
        if k in _VOLATILE:
            continue
        a, b = _val_norm(old_f.get(k)), _val_norm(v)
        if a is None or b is None:
            if a is not b:
                return True
        elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
            if abs(a - b) > 0.005:
                return True
        elif a != b:
            return True
    return False


def _upsert(table_id: str, records: list[dict]) -> dict:
    """按 (商品ID, 日期) 增量 upsert：只创建缺失行、更新确有变化的行；
    已同步且值未变的行直接跳过（避免重复写已同步的数据浪费时间）"""
    old = feishu.list_records(table_id)
    key_to_rid = {}
    key_to_fields = {}
    for o in old:
        f = o.get("fields") or {}
        key = (f.get("商品ID"), _day_num(f.get("日期")))
        key_to_rid[key] = o["record_id"]
        key_to_fields[key] = f

    to_create, to_update = [], []
    for rec in records:
        rec = {k: v for k, v in rec.items() if not k.startswith("_")}  # 剔除内部字段（如 _full_date）
        key = (rec.get("商品ID"), rec.get("日期"))
        rid = key_to_rid.get(key)
        if rid:
            if _fields_differ(key_to_fields.get(key, {}), rec):
                to_update.append({"record_id": rid, "fields": rec})
        else:
            to_create.append(rec)

    created = feishu.create_records(table_id, to_create) if to_create else 0
    updated = feishu.update_records(table_id, to_update) if to_update else 0
    return {"created": created, "updated": updated}


def _resolve_store(store: Optional[str]) -> Optional[str]:
    """store 参数兼容：配置文件名（store2）或显示名（AW04）→ 返回配置文件名"""
    if not store:
        return None
    if store in list_stores():
        return store
    for name in list_stores():
        if Store(name).display_name == store:
            return name
    raise ValueError(f"未知店铺: {store}")


def _store_list(store: Optional[str]) -> list[str]:
    r = _resolve_store(store)
    return [r] if r else list_stores()


def _month_key(date_str: str) -> str:
    """YYYY-MM-DD → YYYY-MM"""
    return (date_str or "")[:7]


def _month_table_name(display: str, month: str) -> str:
    """子表名：{店铺} {YYYY}年{MM}月，如「BA05 2026年6月」"""
    return f"{display} {month[:4]}年{int(month[5:7])}月"


# 飞书同步窗口（天）：正常同步最近 N 天（含昨天~今天）。
# 按美客多广告定档规则：曝光/点击/花费/CTR/CPC 次日 10:00 定档(T+1)，销量/ROAS/ACOS/CVR T+3 定档，
# 窗口需覆盖 T+3 → 取 5 天（+1 天余量）；窗口内定档修正随同步自动补全（diff 只写变化行，历史冻结不受影响）。
SYNC_WINDOW_DAYS = 5


def sync_daily(store: Optional[str] = None, date_from: str = "", date_to: str = "") -> dict:
    """每日同步：子表按 店铺×月份（表名=店铺 年月），行=商品×日期，diff 增量 upsert。

    范围规则：
    - 显式传 date_from/date_to → 用指定区间；
    - 否则默认窗口 = 最近 SYNC_WINDOW_DAYS 天（含今天），窗口外历史行冻结不再动；
    - 特例：本店在飞书还没有任何月份表（新店/迁移/重建）→ 全量补建 快照最早一天~今天。"""
    # 快照最早一天（全量补建时用）
    conn = db.get_conn()
    row = conn.execute("SELECT MIN(date), MAX(date) FROM daily_snapshot").fetchone()
    df_full = row[0] or br_days_ago(90)
    conn.close()

    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    stores = _store_list(store)
    result = {
        "date_from": date_from or br_days_ago(SYNC_WINDOW_DAYS - 1),
        "date_to": date_to or br_date_str(),
        "synced_at": ts,
        "tables": {},
    }

    for sname in stores:
        store_obj = Store(sname)
        display = store_obj.display_name
        # access token 6h 过期，同步前刷新
        try:
            store_obj.refresh_token()
        except Exception:  # noqa: BLE001
            pass
        # 范围：显式指定优先；否则本店已有飞书表→昨天~今天；无表→全量补建
        if date_from and date_to:
            df, dt = date_from, date_to
        else:
            has_tables = any(
                t["name"].startswith(display + " ") for t in feishu.list_tables()
            )
            if has_tables:
                df = date_from or br_days_ago(SYNC_WINDOW_DAYS - 1)
                dt = date_to or br_date_str()
            else:
                df = date_from or df_full
                dt = date_to or br_date_str()
        if df > dt:
            df = dt
        records = _daily_rows(display, df, dt, ts)
        _attach_daily_visits(store_obj, records)
        _derive_metrics(records)
        # 按月份分组 → 每 (店铺, 月) 一个子表（用内部完整日期，行内日期只是"日"）
        by_month: dict = {}
        for rec in records:
            by_month.setdefault(_month_key(rec["_full_date"]), []).append(rec)
        for month in sorted(by_month):
            name = _month_table_name(display, month)
            table_id = feishu.ensure_table(name, FIELD_DEFS)
            feishu.ensure_fields(table_id, FIELD_DEFS)
            res = _upsert(table_id, by_month[month])
            result["tables"][name] = {"table_id": table_id, "rows": len(by_month[month]), **res}

    return result


def verify_daily(store: Optional[str] = None, date_from: str = "", date_to: str = "") -> dict:
    """校验：飞书 vs 本地 daily_snapshot（逐 (商品ID,日期) 逐字段对比）。
    默认只校验 昨天~今天（历史行已冻结，其属性列为同步时值，无法与当前值对比）。"""
    conn = db.get_conn()
    row = conn.execute("SELECT MIN(date), MAX(date) FROM daily_snapshot").fetchone()
    df = date_from or br_days_ago(SYNC_WINDOW_DAYS - 1)
    dt = date_to or br_date_str()
    conn.close()
    if df > dt:
        df = dt

    ts = ""
    stores = _store_list(store)
    result = {"date_from": df, "date_to": dt, "stores": {}}
    VERIFY_KEYS = ["已售", "可售库存", "现价", "体验分",
                   "变体", "原价", "佣金率%", "佣金/件", "平台运费", "实际收入/件",
                   "广告点击", "曝光", "广告花费", "广告收入", "全流量总访问",
                   "自然访问(估算)", "自然访问占比(访问)", "广告点击占比(访问)",
                   "自然销售额", "自然销售额占比(销售)", "广告销售额占比(销售)",
                   "ROAS", "保本ROAS", "ACOS%", "CTR%"]

    for sname in stores:
        display = Store(sname).display_name
        store_obj = Store(sname)
        # 键 = (月名, 商品ID, 日)：行内日期只是"日"，跨月表同一天需靠月名区分
        expect = {
            (f"{r['_full_date'][:4]}年{int(r['_full_date'][5:7])}月", r["商品ID"], r["日期"]): r
            for r in _daily_rows(display, df, dt, ts)
        }
        _attach_daily_visits(store_obj, list(expect.values()))
        _derive_metrics(list(expect.values()))
        # 表里实际：该店铺所有月份子表
        actual: dict = {}
        table_ids = {}
        for t in feishu.list_tables():
            if t["name"].startswith(display + " "):
                table_ids[t["name"]] = t["table_id"]
                month = t["name"].split(" ", 1)[1]  # "2026年7月"
                ym = f"{month[:4]}-{int(month.split('年')[1].rstrip('月')):02d}"  # "2026-07"
                for o in feishu.list_records(t["table_id"]):
                    f = o.get("fields") or {}
                    day_s = str(f.get("日期") or "")
                    if len(day_s) != 5:
                        continue
                    full = f"{ym}-{day_s[3:5]}"
                    if full < df or full > dt:
                        continue  # 窗口外 = 冻结历史，不参与校验
                    actual[(month, f.get("商品ID"), _day_num(f.get("日期")))] = f

        missing = [k for k in expect if k not in actual]
        extra = [k for k in actual if k not in expect]
        diffs = []
        for k in expect:
            if k not in actual:
                continue
            e, a = expect[k], actual[k]
            for key in VERIFY_KEYS:
                ev, av = _to_num(e.get(key)), _to_num(a.get(key))
                if ev is not None and av is not None and abs(ev - av) > 0.005:
                    diffs.append({"key": k, "field": key, "expect": ev, "actual": av})

        result["stores"][display] = {
            "expect_rows": len(expect),
            "actual_rows": len(actual),
            "tables": list(table_ids.keys()),
            "missing": len(missing),
            "missing_list": missing[:10],
            "extra": len(extra),
            "extra_list": extra[:10],
            "diff_count": len(diffs),
            "diffs": diffs[:10],
            "status": "OK" if (not missing and not extra and not diffs) else "MISMATCH",
        }

    return result


@router.post("/daily")
def export_bitable_daily(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    try:
        return sync_daily(store, date_from, date_to)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


@router.post("/daily/verify")
def export_bitable_daily_verify(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    try:
        return verify_daily(store, date_from, date_to)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


# ---------- 定时回填 ----------

def backfill_recent(days_back: int = 7) -> dict:
    """广告定档后的回填：重同步最近 days_back 天（截止巴西今天），
    把新定档日的广告列补全（upsert 只更新有变化的行）。供定时任务调用。"""
    df = br_days_ago(days_back)
    dt = br_date_str()
    return sync_daily(date_from=df, date_to=dt)


@router.post("/daily/backfill")
def export_bitable_backfill(days_back: int = 7):
    try:
        return backfill_recent(days_back)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
