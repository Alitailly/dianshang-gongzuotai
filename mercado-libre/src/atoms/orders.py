"""原子：订单聚合 — 按商品按天聚合 销量/收入/佣金/物流费"""

from __future__ import annotations

from ..timeutil import br_iso_range


def _seller_shipping_cost(store, seller_uid: str, shipment_id) -> float:
    """发货单里卖家的物流成本（平台物流费，对应蓝鲸「物流费(支出)」）"""
    try:
        data = store.client.get(f"/shipments/{shipment_id}/costs")
    except Exception:  # noqa: BLE001
        return 0.0
    for s in data.get("senders", []):
        if str(s.get("user_id")) == str(seller_uid):
            return s.get("cost") or 0.0
    return sum(s.get("cost") or 0.0 for s in data.get("senders", []))


def collect_daily_orders(store, *, days: int = 90) -> dict:
    """拉取近 days 天已支付订单，按 (item_id, 日期) 聚合 销量/收入/佣金/物流费

    优化：先拉全部订单，再并发获取各发货单的卖家物流成本（原串行逐单调用太慢）。"""
    from concurrent.futures import ThreadPoolExecutor

    user = store.client.get_my_user()
    uid = user["id"]
    start, end = br_iso_range(days)

    # 1) 拉全部订单
    all_orders = []
    offset = 0
    limit = 50
    while True:
        data = store.client.get(
            "/orders/search",
            params={
                "seller": uid,
                "order.status": "paid",
                "order.date_created.from": start,
                "order.date_created.to": end,
                "limit": limit,
                "offset": offset,
            },
        )
        results = data.get("results", [])
        all_orders.extend(results)
        offset += len(results)
        if not results or offset >= data.get("paging", {}).get("total", 0):
            break
    # 按订单时间倒序（最新在前），价格字段取"最新一笔"（setdefault 只记第一条=最新）
    all_orders.sort(key=lambda o: o.get("date_created") or "", reverse=True)

    # 2) 并发获取每个发货单的卖家物流成本（去重 shipment_id）
    ship_ids = {
        (o.get("shipping") or {}).get("id")
        for o in all_orders
        if (o.get("shipping") or {}).get("id")
    }
    ship_costs: dict = {}

    def _fetch(sid):
        ship_costs[sid] = _seller_shipping_cost(store, uid, sid)

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(_fetch, ship_ids))

    # 3) 聚合
    from datetime import datetime

    from ..timeutil import BR_TZ

    def _br_date(raw: str) -> str:
        """订单日期按巴西时区归日：ML 的 date_created 可能是 -03:00 或 -04:00 等，
        直接 [:10] 切片会让跨零点的订单归错天（如 08-06 00:43(-03:00) 写成 08-05T23:43(-04:00)）。"""
        if not raw:
            return ""
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(BR_TZ).strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            return raw[:10]

    metrics = {}
    for order in all_orders:
        date = _br_date(order.get("date_created") or "")  # 订单日期（巴西时区归日）
        shipment_id = (order.get("shipping") or {}).get("id")
        shipping_cost = ship_costs.get(shipment_id, 0.0)
        items = order.get("order_items", [])
        order_amount = sum(
            (it.get("unit_price") or 0.0) * (it.get("quantity") or 0)
            for it in items
        )
        # 销售额口径 = 订单总金额 order.total_amount（=后台「Desempenho do seu anúncio」的销售额，
        # 含买家运费等，比 Σunit_price×qty 略大；多商品单按金额占比分摊）
        order_total = order.get("total_amount") or order_amount
        coupon = order.get("coupon") or {}
        coupon_amount = coupon.get("amount") or 0.0
        for it in items:
            item = it.get("item") or {}
            item_id = item.get("id")
            if not item_id:
                continue
            qty = it.get("quantity") or 0
            unit_price = it.get("unit_price") or 0.0
            sale_fee = it.get("sale_fee") or 0.0
            item_amount = unit_price * qty
            ship_share = (
                shipping_cost * item_amount / order_amount if order_amount else 0.0
            )
            # 销售额按 total_amount 分摊到每个商品（单商品订单即 total_amount 本身）
            revenue_item = (
                order_total * item_amount / order_amount if order_amount else item_amount
            )

            key = (item_id, date)
            m = metrics.setdefault(
                key,
                {
                    "sold_quantity": 0.0,
                    "revenue": 0.0,
                    "commission": 0.0,
                    "shipping_fee": 0.0,
                    "order_ids": set(),
                    "unit_price": None,
                    "full_unit_price": None,
                    "coupon_amount": 0.0,
                    "gross_amount": 0.0,
                },
            )
            m["order_ids"].add(order.get("id"))
            m["sold_quantity"] += qty
            m["revenue"] += revenue_item
            m["gross_amount"] += it.get("gross_price") or 0.0
            # 最近一笔（本日最新订单）的成交单价 / 订单级原价(gross_price÷数量) / 优惠券
            if m["unit_price"] is None:
                m["unit_price"] = unit_price
                m["full_unit_price"] = (it.get("gross_price") or 0.0) / qty if qty else unit_price
                m["coupon_amount"] = coupon_amount
            m["commission"] += sale_fee * qty
            m["shipping_fee"] += ship_share

    for m in metrics.values():
        m["order_count"] = len(m["order_ids"])
        m.pop("order_ids", None)
        m["revenue"] = round(m["revenue"], 2)
        m["commission"] = round(m["commission"], 2)
        m["shipping_fee"] = round(m["shipping_fee"], 2)

    return metrics
