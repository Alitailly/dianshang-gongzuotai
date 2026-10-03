"""快照查询 — 商品元数据 + 每日快照按日期范围聚合

广告只统计到「定档截止日」（次日 10:00 巴西定档，未定档日的广告不计入）；
销量/销售/佣金/物流等实时数据统计整个所选区间（含今天）。
"""

from __future__ import annotations

import json

from src.timeutil import br_latest_finalized_date

from . import db

# 平台官方销售佣金率（按 listing 类型，来自 /sites/MLB/listing_types/{id} 的 sale_fee_criteria.percentage_of_fee_amount）
_LISTING_COMMISSION = {
    "gold_pro": 16.0,
    "gold_special": 11.0,
    "gold": 0.0,
    "silver": 0.0,
    "bronze": 0.0,
}


def _official_commission_rate(listing_type: str) -> float | None:
    """平台官方佣金率；未知 listing 类型返回 None"""
    lt = (listing_type or "").strip()
    if not lt:
        return None
    return _LISTING_COMMISSION.get(lt)

# 广告聚合（只到定档截止日）
_AD_SUB = """
    SELECT store, item_id,
           SUM(COALESCE(ad_cost,0)) AS ad_cost,
           SUM(COALESCE(ad_clicks,0)) AS ad_clicks,
           SUM(COALESCE(ad_impressions,0)) AS ad_impressions,
           SUM(COALESCE(ad_sales,0)) AS ad_sales
    FROM daily_snapshot
    WHERE date >= ? AND date <= ?
    GROUP BY store, item_id
"""

# 「区间内有广告数据」= 曝光/花费/点击任一 > 0（与 ads_summary 的 ad_items 同口径）
_AD_ACTIVE_SQL = """
    EXISTS (
        SELECT 1 FROM daily_snapshot d
        WHERE d.store = p.store AND d.item_id = p.item_id
          AND d.date >= ? AND d.date <= ?
          AND (COALESCE(d.ad_impressions,0) > 0 OR COALESCE(d.ad_cost,0) > 0 OR COALESCE(d.ad_clicks,0) > 0)
    )
"""

# 订单/收支聚合（实时数据，整个所选区间，含今天）
_ORDER_SUB = """
    SELECT store, item_id,
           SUM(COALESCE(sold_quantity,0)) AS sold_quantity,
           SUM(COALESCE(revenue,0)) AS revenue,
           SUM(COALESCE(commission,0)) AS commission,
           SUM(COALESCE(shipping_fee,0)) AS shipping_fee,
           SUM(COALESCE(order_count,0)) AS order_count,
           SUM(COALESCE(gross_amount,0)) AS gross_amount
    FROM daily_snapshot
    WHERE date >= ? AND date <= ?
    GROUP BY store, item_id
"""

# 最近一笔成交：所选区间内最新一天有成交的 实付单价 / 订单级原价(gross_price÷数量) / 优惠券金额
_LAST_PRICE_SUB = """
    SELECT store, item_id, unit_price, full_unit_price, coupon_amount
    FROM daily_snapshot d
    WHERE d.sold_quantity > 0
      AND d.date = (
          SELECT MAX(d2.date) FROM daily_snapshot d2
          WHERE d2.store = d.store AND d2.item_id = d.item_id
            AND d2.date >= ? AND d2.date <= ? AND d2.sold_quantity > 0
      )
"""


def _ad_cap(date_to: str) -> str:
    """广告统计上界 = min(所选结束日, 广告定档截止日)"""
    cap = br_latest_finalized_date()
    if not date_to or date_to > cap:
        return cap
    return date_to


# 商品级排序列 → 表达式（a=广告聚合，o=订单聚合，p=元数据）
ITEM_SORT = {
    "price": "MIN(p.price)",
    "available_quantity": "SUM(COALESCE(p.available_quantity,0))",
    "performance_score": "MAX(p.performance_score)",
    "sold_quantity": "COALESCE(o.sold_quantity,0)",
    "revenue": "COALESCE(o.revenue,0)",
    "commission": "COALESCE(o.commission,0)",
    "shipping_fee": "COALESCE(o.shipping_fee,0)",
    "settlement": "(COALESCE(o.revenue,0) - COALESCE(o.commission,0) - COALESCE(o.shipping_fee,0) - COALESCE(a.ad_cost,0))",
    "ad_cost": "COALESCE(a.ad_cost,0)",
    "ad_clicks": "COALESCE(a.ad_clicks,0)",
    "ad_impressions": "COALESCE(a.ad_impressions,0)",
    "ad_sales": "COALESCE(a.ad_sales,0)",
    "ad_roas": "(CASE WHEN COALESCE(a.ad_cost,0) > 0 THEN COALESCE(a.ad_sales,0) / COALESCE(a.ad_cost,0) ELSE 0 END)",
    "ad_acos": "(CASE WHEN COALESCE(a.ad_sales,0) > 0 THEN COALESCE(a.ad_cost,0) / COALESCE(a.ad_sales,0) * 100 ELSE 0 END)",
    "ad_ctr": "(CASE WHEN COALESCE(a.ad_impressions,0) > 0 THEN COALESCE(a.ad_clicks,0) / COALESCE(a.ad_impressions,0) * 100 ELSE 0 END)",
    "original_price": "MAX(p.original_price)",
    "ref_original_price": "(CASE WHEN MAX(COALESCE(l.full_unit_price,0)) > 0 THEN MAX(l.full_unit_price) WHEN MAX(p.original_price) > 0 THEN MAX(p.original_price) WHEN COALESCE(l.unit_price, MIN(p.price)) < MIN(p.price) THEN MIN(p.price) ELSE 0 END)",
    "last_price": "MAX(COALESCE(l.unit_price, p.price))",
    "full_price": "MAX(COALESCE(l.full_unit_price, p.price))",
    "discount_rate": "(CASE WHEN MAX(p.original_price) > 0 AND MIN(p.price) > 0 THEN (1 - MIN(p.price) / MAX(p.original_price)) * 100 ELSE 0 END)",
    "settlement_rate": "(CASE WHEN COALESCE(o.revenue,0) > 0 THEN (COALESCE(o.revenue,0) - COALESCE(o.commission,0) - COALESCE(o.shipping_fee,0) - COALESCE(a.ad_cost,0)) / COALESCE(o.revenue,0) * 100 ELSE 0 END)",
    "commission_rate": "(CASE WHEN COALESCE(o.revenue,0) > 0 THEN COALESCE(o.commission,0) / COALESCE(o.revenue,0) * 100 ELSE 0 END)",
    "ad_net": "(COALESCE(o.revenue,0) - COALESCE(o.commission,0) - COALESCE(o.shipping_fee,0) - COALESCE(a.ad_cost,0))",
    "breakeven_roas": "(CASE WHEN COALESCE(o.revenue,0) - COALESCE(o.commission,0) - COALESCE(o.shipping_fee,0) - COALESCE(a.ad_cost,0) > 0 THEN COALESCE(o.revenue,0) / (COALESCE(o.revenue,0) - COALESCE(o.commission,0) - COALESCE(o.shipping_fee,0) - COALESCE(a.ad_cost,0)) ELSE 0 END)",
    "natural_sales": "(COALESCE(o.revenue,0) - COALESCE(a.ad_sales,0))",
    "ad_share": "(CASE WHEN COALESCE(o.revenue,0) > 0 THEN COALESCE(a.ad_sales,0) / COALESCE(o.revenue,0) * 100 ELSE 0 END)",
    "discount_total": "(COALESCE(o.gross_amount,0) - COALESCE(o.revenue,0))",
    "unit_commission": "(CASE WHEN p.listing_type = 'gold_special' THEN MAX(COALESCE(l.unit_price, p.price)) * 0.11 WHEN p.listing_type = 'gold_pro' THEN MAX(COALESCE(l.unit_price, p.price)) * 0.16 ELSE MAX(COALESCE(l.unit_price, p.price)) * 0.0 END)",
    "unit_income": "(CASE WHEN p.listing_type = 'gold_special' THEN MAX(COALESCE(l.unit_price, p.price)) * (1 - 0.11) - MAX(COALESCE(p.platform_shipping,0)) WHEN p.listing_type = 'gold_pro' THEN MAX(COALESCE(l.unit_price, p.price)) * (1 - 0.16) - MAX(COALESCE(p.platform_shipping,0)) ELSE MAX(COALESCE(l.unit_price, p.price)) - MAX(COALESCE(p.platform_shipping,0)) END)",
    "item_id": "p.item_id",
    "seller_sku": "MAX(NULLIF(p.seller_sku, ''))",
}


def _row_to_dict(row) -> dict:
    d = dict(row)
    if d.get("attributes"):
        try:
            d["attributes"] = json.loads(d["attributes"])
        except (TypeError, ValueError):
            d["attributes"] = {}
    d["has_ads"] = bool(d.get("has_ads"))
    return d


def _compute_ratios(d: dict) -> None:
    cost = d.get("ad_cost") or 0.0
    sales = d.get("ad_sales") or 0.0
    clicks = d.get("ad_clicks") or 0.0
    impr = d.get("ad_impressions") or 0.0
    revenue = d.get("revenue") or 0.0
    commission = d.get("commission") or 0.0
    shipping = d.get("shipping_fee") or 0.0
    d["ad_roas"] = round(sales / cost, 2) if cost > 0 else 0.0
    d["ad_acos"] = round(cost / sales * 100, 2) if sales > 0 else 0.0
    d["ad_ctr"] = round(clicks / impr * 100, 2) if impr > 0 else 0.0
    # 可以收到的（结算金额）= 销售额 − 费用总和（销售费用+运费+广告投入+其他服务费）
    # 此处先扣：佣金(销售费用) + 物流 + 广告花费；「其他服务费」API 读不到，待用户给口径
    settlement = revenue - commission - shipping - cost
    d["settlement"] = round(settlement, 2)
    # 折扣率：原价(挂牌价) vs 现价(折扣价)；原价为空时原价=现价（无打折），折扣率=0
    op = d.get("original_price") or 0.0
    price = d.get("price") or 0.0
    # 原价没设置（无划线/无促销）→ 原价显示=现价，不空着
    if not op:
        op = price
        d["original_price"] = price
    d["ref_original_price"] = round(op, 2) if op else None
    d["discount_rate"] = round((1 - price / op) * 100, 1) if op and price and op > price else 0.0
    # 优惠原因：促销价优先（extract 已标记 promotion_type），其次卖家划线
    d["discount_reason"] = d.get("promotion_type") or ("卖家划线价" if op > price else "")
    # 结算率：每 100 块销售额扣完佣金+物流后落袋多少
    d["settlement_rate"] = round(settlement / revenue * 100, 1) if revenue else 0.0
    # 佣金率：官方精确费率（listing_prices 按类目+价格计算，如 16.5%，与后台一致）；
    # 无精确值时 fallback 到 listing 类型基准
    d["commission_rate"] = (
        round(float(d["official_fee_rate"]), 2)
        if d.get("official_fee_rate")
        else _official_commission_rate(d.get("listing_type"))
    )
    d["commission_rate_actual"] = round(commission / revenue * 100, 1) if revenue else None
    # 广告后净得 = 结算金额（结算已含扣广告投入）
    d["ad_net"] = round(settlement, 2)
    # 保本 ROAS：ROAS 低于它，广告在吃利润
    d["breakeven_roas"] = round(revenue / settlement, 2) if settlement > 0 else 0.0
    # 自然销售额 / 广告占比（统一销售额口径，自然+广告恒=100%）
    d["natural_sales"] = round(revenue - sales, 2)
    d["ad_share"] = round(sales / revenue * 100, 1) if revenue else 0.0
    d["natural_sales_rate"] = round((revenue - sales) / revenue * 100, 1) if revenue else 0.0
    # 折扣总额 = 订单级原价合计(gross_amount) − 销售额（所有渠道让的利，含平台补贴与自己让的）
    d["discount_total"] = round((d.get("gross_amount") or 0.0) - revenue, 2)
    # 单件扣费与实收：每卖一件要扣的佣金/物流，和真正落袋的收入
    sold = d.get("sold_quantity") or 0
    # 商品状态：normal(上架有销量) / unsold(上架未卖出) / offline(未上架)
    st = d.get("status") or ""
    active = st == "active" or not st
    if active and sold > 0:
        d["item_status"] = "normal"
    elif active:
        d["item_status"] = "unsold"
    else:
        d["item_status"] = "offline"
    # 佣金/件 = 最近成交价 × 官方费率%（官方数据源，与是否上架/卖出无关，所有商品可算）
    last_price = d.get("last_price") or d.get("price") or 0
    cr = d.get("commission_rate")
    d["unit_commission"] = round(last_price * cr / 100, 2) if cr else None
    # 平台运费（卖家承担口径）：按承担方区分
    # - buyer（买家承担运费）→ 卖家实付 0，前端显示「买家付」
    # - meli（平台强制包邮）→ 卖家 0，前端显示「包邮」
    # - seller（卖家承担）→ 平台成本价 base_cost
    payer = d.get("shipping_payer") or ""
    ps = d.get("platform_shipping")
    d["shipping_payer"] = payer
    if payer == "seller" and ps and ps > 0:
        d["platform_shipping"] = round(float(ps), 2)
    elif payer == "buyer":
        d["platform_shipping"] = 0.0
    elif payer == "meli":
        d["platform_shipping"] = 0.0
    else:
        d["platform_shipping"] = None
    # 实际收入/件 = 最近成交价 − 佣金/件 − 运费成本（买家承担/包邮则运费为 0）
    if d["unit_commission"] is not None and d["platform_shipping"] is not None and last_price:
        d["unit_income"] = round(last_price - d["unit_commission"] - d["platform_shipping"], 2)
    else:
        d["unit_income"] = None


def list_items(
    store: str | None = None,
    keyword: str | None = None,
    has_ads: str | None = None,
    ad_active: str | None = None,
    sort_by: str = "revenue",
    order: str = "desc",
    page: int = 1,
    page_size: int = 50,
    date_from: str = "",
    date_to: str = "",
) -> dict:
    """商品级列表：元数据 + 广告(到定档日) + 订单(整个区间)（不含访客，访客由路由实时查）

    ad_active="1" 只保留所选区间内有广告数据（曝光/花费/点击>0）的商品，供广告流量页使用。
    """
    df = date_from or "0000-00-00"
    dt = date_to or "9999-99-99"
    ad_to = _ad_cap(dt)

    where = []
    params: list = []
    if store:
        where.append("p.store = ?")
        params.append(store)
    if keyword:
        like = f"%{keyword}%"
        where.append("(p.title LIKE ? OR p.seller_sku LIKE ? OR p.item_id LIKE ?)")
        params.extend([like, like, like])
    if has_ads in ("0", "1"):
        where.append("p.has_ads = ?")
        params.append(int(has_ads))
    if ad_active == "1":
        where.append(_AD_ACTIVE_SQL)
        params.extend([df, ad_to])
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""

    sort_expr = ITEM_SORT.get(sort_by, ITEM_SORT["revenue"])
    order_sql = "ASC" if order.lower() == "asc" else "DESC"

    conn = db.get_conn()
    total = conn.execute(
        f"SELECT COUNT(DISTINCT p.item_id) FROM product_variation p {where_sql}", params
    ).fetchone()[0]

    ad_params = [df, ad_to]
    order_params = [df, dt]
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"""
        SELECT
            p.store, p.item_id,
            MAX(p.title) AS title,
            MAX(p.currency_id) AS currency_id,
            MAX(NULLIF(p.seller_sku, '')) AS seller_sku,
            COUNT(*) AS variation_count,
            SUM(COALESCE(p.available_quantity,0)) AS available_quantity,
            MIN(p.price) AS price,
            MAX(p.performance_score) AS performance_score,
            MAX(p.performance_level) AS performance_level,
            MAX(p.has_ads) AS has_ads,
            MAX(p.updated_at) AS updated_at,
            MAX(p.original_price) AS original_price,
            MAX(p.sale_price) AS sale_price,
            MAX(p.promotion_type) AS promotion_type,
            MAX(COALESCE(p.platform_shipping,0)) AS platform_shipping,
            MAX(p.status) AS status,
            MAX(p.listing_type) AS listing_type,
            MAX(COALESCE(p.free_shipping,0)) AS free_shipping,
            MAX(COALESCE(p.official_fee_rate,0)) AS official_fee_rate,
            MAX(p.shipping_payer) AS shipping_payer,
            MAX(COALESCE(a.ad_cost,0)) AS ad_cost,
            MAX(COALESCE(a.ad_clicks,0)) AS ad_clicks,
            MAX(COALESCE(a.ad_impressions,0)) AS ad_impressions,
            MAX(COALESCE(a.ad_sales,0)) AS ad_sales,
            MAX(COALESCE(o.sold_quantity,0)) AS sold_quantity,
            MAX(COALESCE(o.revenue,0)) AS revenue,
            MAX(COALESCE(o.gross_amount,0)) AS gross_amount,
            MAX(COALESCE(o.commission,0)) AS commission,
            MAX(COALESCE(o.shipping_fee,0)) AS shipping_fee,
            MAX(COALESCE(l.unit_price, p.price)) AS last_price,
            MAX(COALESCE(l.full_unit_price, p.price)) AS full_price,
            MAX(COALESCE(l.coupon_amount, 0)) AS coupon_amount
        FROM product_variation p
        LEFT JOIN ({_AD_SUB}) a ON a.item_id = p.item_id AND a.store = p.store
        LEFT JOIN ({_ORDER_SUB}) o ON o.item_id = p.item_id AND o.store = p.store
        LEFT JOIN ({_LAST_PRICE_SUB}) l ON l.item_id = p.item_id AND l.store = p.store
        {where_sql}
        GROUP BY p.store, p.item_id
        ORDER BY {sort_expr} {order_sql} NULLS LAST
        LIMIT ? OFFSET ?
        """,
        ad_params + order_params + [df, dt] + params + [page_size, offset],
    ).fetchall()

    items = [dict(r) for r in rows]
    for d in items:
        d["has_ads"] = bool(d.get("has_ads"))
        _compute_ratios(d)

    if items:
        ids = [d["item_id"] for d in items]
        ph = ",".join("?" * len(ids))
        var_rows = conn.execute(
            f"""
            SELECT item_id, variation_id, seller_sku, gtin, price,
                   available_quantity, attributes
            FROM product_variation
            WHERE item_id IN ({ph})
            ORDER BY item_id, seller_sku
            """,
            ids,
        ).fetchall()
        var_by_item: dict = {}
        for v in var_rows:
            var_by_item.setdefault(v["item_id"], []).append(_row_to_dict(v))
        for d in items:
            d["variations"] = var_by_item.get(d["item_id"], [])

    conn.close()
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def get_product(item_id: str) -> dict | None:
    conn = db.get_conn()
    row = conn.execute(
        "SELECT * FROM product_variation WHERE item_id = ? LIMIT 1", (item_id,)
    ).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def _agg_range(conn, store: str | None, df: str, dt: str) -> dict:
    """某区间订单/广告合计（广告截至定档截止日）"""
    where = "AND store = ?" if store else ""
    params = [store] if store else []
    ad_to = _ad_cap(dt)
    order_row = conn.execute(
        f"""
        SELECT COALESCE(SUM(sold_quantity),0) AS sold,
               COALESCE(SUM(revenue),0) AS revenue,
               COALESCE(SUM(commission),0) AS commission,
               COALESCE(SUM(shipping_fee),0) AS shipping_fee,
               COALESCE(SUM(order_count),0) AS orders
        FROM daily_snapshot WHERE date >= ? AND date <= ? {where}
        """,
        [df, dt] + params,
    ).fetchone()
    ad_row = conn.execute(
        f"""
        SELECT COALESCE(SUM(ad_cost),0) AS ad_cost
        FROM daily_snapshot WHERE date >= ? AND date <= ? {where}
        """,
        [df, ad_to] + params,
    ).fetchone()
    return {
        "sold": order_row["sold"],
        "revenue": order_row["revenue"],
        "commission": order_row["commission"],
        "shipping_fee": order_row["shipping_fee"],
        "orders": order_row["orders"],
        "ad_cost": ad_row["ad_cost"],
    }


def _shift_range(df: str, dt: str) -> tuple[str, str] | None:
    """上一等长区间 [df-days, df-1]；解析失败返回 None"""
    from datetime import date, timedelta

    try:
        a = date.fromisoformat(df)
        b = date.fromisoformat(dt)
    except ValueError:
        return None
    days = (b - a).days + 1
    if days <= 0:
        return None
    return ((a - timedelta(days=days)).isoformat(), (a - timedelta(days=1)).isoformat())


def prev_range(date_from: str, date_to: str) -> tuple[str, str] | None:
    """上一等长区间（供路由计算环比/上一区间访客）"""
    return _shift_range(date_from, date_to)


def overview(store: str | None = None, date_from: str = "", date_to: str = "") -> dict:
    """经营总览：元数据 + 当前区间/环比区间/昨日 的订单与广告 + 动销率"""
    where = "WHERE store = ?" if store else ""
    and_where = "AND store = ?" if store else ""
    params = [store] if store else []
    df = date_from or "0000-00-00"
    dt = date_to or "9999-99-99"

    conn = db.get_conn()

    # 元数据聚合
    agg = conn.execute(
        f"""
        SELECT COUNT(*) AS total_skus,
               COUNT(DISTINCT item_id) AS total_items,
               COUNT(DISTINCT store) AS store_count
        FROM product_variation {where}
        """,
        params,
    ).fetchone()

    # 当前区间 + 环比区间 + 昨日
    cur = _agg_range(conn, store, df, dt)
    prev = _agg_range(conn, store, *(_shift_range(df, dt) or (df, dt)))
    from src.timeutil import br_days_ago

    yday = br_days_ago(1)
    yst = _agg_range(conn, store, yday, yday)

    # 动销率：有销量商品数 / 在售商品数
    active_listings = conn.execute(
        f"SELECT COUNT(DISTINCT item_id) AS n FROM product_variation {where}", params
    ).fetchone()["n"]
    sold_listings = conn.execute(
        f"""
        SELECT COUNT(DISTINCT item_id) AS n FROM daily_snapshot
        WHERE date >= ? AND date <= ? AND COALESCE(sold_quantity,0) > 0 {and_where}
        """,
        [df, dt] + params,
    ).fetchone()["n"]
    prev_sold_listings = conn.execute(
        f"""
        SELECT COUNT(DISTINCT item_id) AS n FROM daily_snapshot
        WHERE date >= ? AND date <= ? AND COALESCE(sold_quantity,0) > 0 {and_where}
        """,
        list(_shift_range(df, dt) or (df, dt)) + params,
    ).fetchone()["n"]
    prev_active = conn.execute(
        f"SELECT COUNT(DISTINCT item_id) AS n FROM product_variation {where}", params
    ).fetchone()["n"]

    # 每店：元数据 + 订单 + 广告
    meta_by_store = {
        r["store"]: dict(r)
        for r in conn.execute(
            f"""
            SELECT store, COUNT(*) AS skus, COUNT(DISTINCT item_id) AS items
            FROM product_variation {where} GROUP BY store
            """,
            params,
        ).fetchall()
    }
    order_by_store = {
        r["store"]: dict(r)
        for r in conn.execute(
            f"""
            SELECT store,
                   COALESCE(SUM(sold_quantity),0) AS sold,
                   COALESCE(SUM(revenue),0) AS revenue,
                   COALESCE(SUM(order_count),0) AS orders
            FROM daily_snapshot
            WHERE date >= ? AND date <= ? {and_where}
            GROUP BY store
            """,
            [df, dt] + params,
        ).fetchall()
    }
    ad_by_store = {
        r["store"]: dict(r)
        for r in conn.execute(
            f"""
            SELECT store, COALESCE(SUM(ad_cost),0) AS ad_cost
            FROM daily_snapshot
            WHERE date >= ? AND date <= ? {and_where}
            GROUP BY store
            """,
            [df, _ad_cap(dt)] + params,
        ).fetchall()
    }
    conn.close()

    by_store = []
    for sname, m in meta_by_store.items():
        od = order_by_store.get(sname, {"sold": 0, "revenue": 0, "orders": 0})
        ad = ad_by_store.get(sname, {"ad_cost": 0})
        by_store.append(
            {
                "store": sname,
                "skus": m["skus"],
                "items": m["items"],
                "sold": od["sold"],
                "orders": od["orders"],
                "ad_cost": ad["ad_cost"],
                "revenue": od["revenue"],
            }
        )

    def _settlement(a: dict) -> float:
        return round(a["revenue"] - a["commission"] - a["shipping_fee"] - a.get("ad_cost", 0.0), 2)

    sold_rate = round(sold_listings / active_listings * 100, 2) if active_listings else 0.0
    prev_rate = round(prev_sold_listings / prev_active * 100, 2) if prev_active else 0.0

    return {
        "total_skus": agg["total_skus"],
        "total_items": agg["total_items"],
        "store_count": agg["store_count"],
        # 当前区间
        "total_sold": cur["sold"],
        "total_orders": cur["orders"],
        "total_revenue": cur["revenue"],
        "total_commission": cur["commission"],
        "total_shipping_fee": cur["shipping_fee"],
        "total_settlement": _settlement(cur),
        "total_ad_cost": cur["ad_cost"],
        # 环比区间
        "prev_sold": prev["sold"],
        "prev_orders": prev["orders"],
        "prev_revenue": prev["revenue"],
        "prev_settlement": _settlement(prev),
        "prev_ad_cost": prev["ad_cost"],
        # 昨日（单日；广告未定档时为 None）
        "yesterday_sold": yst["sold"],
        "yesterday_orders": yst["orders"],
        "yesterday_revenue": yst["revenue"],
        "yesterday_settlement": _settlement(yst),
        "yesterday_ad_cost": yst["ad_cost"] if yday <= _ad_cap(yday) else None,
        # 动销
        "active_listings": active_listings,
        "sold_listings": sold_listings,
        "sold_rate": sold_rate,
        "prev_sold_rate": prev_rate,
        "by_store": by_store,
    }


def trend(store: str | None = None, date_from: str = "", date_to: str = "") -> list[dict]:
    """按天趋势：销量/销售额/佣金/物流/广告花费/订单数（daily_snapshot GROUP BY date）

    ad_cost 只到定档截止日可靠，与 ads_trend 一样给每天打 finalized 标记（未定档日勿用于汇总）。
    """
    where = "AND store = ?" if store else ""
    params = [store] if store else []
    df = date_from or "0000-00-00"
    dt = date_to or "9999-99-99"
    ad_to = _ad_cap(dt)
    conn = db.get_conn()
    rows = conn.execute(
        f"""
        SELECT date,
               COALESCE(SUM(sold_quantity),0) AS sold,
               COALESCE(SUM(revenue),0) AS revenue,
               COALESCE(SUM(commission),0) AS commission,
               COALESCE(SUM(shipping_fee),0) AS shipping_fee,
               COALESCE(SUM(order_count),0) AS orders,
               COALESCE(SUM(ad_cost),0) AS ad_cost
        FROM daily_snapshot
        WHERE date >= ? AND date <= ? {where}
        GROUP BY date ORDER BY date
        """,
        [df, dt] + params,
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["finalized"] = d["date"] <= ad_to
        out.append(d)
    return out


def ads_summary(store: str | None = None, date_from: str = "", date_to: str = "") -> dict:
    """广告汇总：当前/环比/昨日 的花费/销售额/点击/曝光 + 投放商品数（广告截至定档日）"""
    and_where = "AND store = ?" if store else ""
    params = [store] if store else []
    df = date_from or "0000-00-00"
    dt = date_to or "9999-99-99"

    conn = db.get_conn()

    def _agg(df: str, dt: str) -> dict | None:
        ad_to = _ad_cap(dt)
        row = conn.execute(
            f"""
            SELECT COALESCE(SUM(ad_cost),0) AS cost,
                   COALESCE(SUM(ad_sales),0) AS sales,
                   COALESCE(SUM(ad_clicks),0) AS clicks,
                   COALESCE(SUM(ad_impressions),0) AS impressions,
                   COUNT(DISTINCT CASE WHEN COALESCE(ad_impressions,0) > 0
                       OR COALESCE(ad_cost,0) > 0 OR COALESCE(ad_clicks,0) > 0
                       THEN item_id END) AS ad_items
            FROM daily_snapshot
            WHERE date >= ? AND date <= ? {and_where}
            """,
            [df, ad_to] + params,
        ).fetchone()
        return dict(row)

    def _ratios(a: dict) -> dict:
        a["roas"] = round(a["sales"] / a["cost"], 2) if a["cost"] else 0.0
        a["acos"] = round(a["cost"] / a["sales"] * 100, 2) if a["sales"] else 0.0
        a["ctr"] = round(a["clicks"] / a["impressions"] * 100, 2) if a["impressions"] else 0.0
        a["cpc"] = round(a["cost"] / a["clicks"], 2) if a["clicks"] else 0.0
        return a

    cur = _ratios(_agg(df, dt))
    prev = _ratios(_agg(*_shift_range(df, dt))) if _shift_range(df, dt) else None
    from src.timeutil import br_days_ago

    yday = br_days_ago(1)
    yst = _agg(yday, yday) if yday <= _ad_cap(yday) else None
    conn.close()

    return {
        "ad_finalized_date": _ad_cap(dt),
        "current": cur,
        "prev": prev,
        "yesterday": yst,
    }


def ads_trend(store: str | None = None, date_from: str = "", date_to: str = "") -> list[dict]:
    """广告按天趋势（含定档标记：定档日之后的数据为未定档预览）"""
    where = "AND store = ?" if store else ""
    params = [store] if store else []
    df = date_from or "0000-00-00"
    dt = date_to or "9999-99-99"
    ad_to = _ad_cap(dt)
    conn = db.get_conn()
    rows = conn.execute(
        f"""
        SELECT date,
               COALESCE(SUM(ad_cost),0) AS cost,
               COALESCE(SUM(ad_sales),0) AS sales,
               COALESCE(SUM(ad_clicks),0) AS clicks,
               COALESCE(SUM(ad_impressions),0) AS impressions
        FROM daily_snapshot
        WHERE date >= ? AND date <= ? {where}
        GROUP BY date ORDER BY date
        """,
        [df, dt] + params,
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["finalized"] = d["date"] <= ad_to
        out.append(d)
    return out
