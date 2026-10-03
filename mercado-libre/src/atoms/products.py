"""原子：商品管理 — 查询店铺商品列表、详情、变体"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any


def list_all(store, *, limit: int = 1000) -> list[str]:
    """获取店铺所有商品 ID 列表（自动处理分页）"""
    user = store.client.get_my_user()
    user_id = user["id"]
    ids = []
    scroll_id = None
    path = f"/users/{user_id}/items/search"

    while True:
        params = {"limit": min(limit, 100)}
        if scroll_id:
            params["scroll_id"] = scroll_id
        result = store.client.get(path, params=params)
        ids.extend(result.get("results", []))
        scroll_id = result.get("scroll_id")
        if not scroll_id or len(ids) >= limit:
            break

    return ids


def get_platform_shipping(store, item_id: str, zip_code: str = "06465070") -> dict:
    """平台运费（卖家承担口径）

    设计原则（用户）：商品运费基本由买家承担；部分商品被平台强制要求卖家承担运费。
    返回 {"cost": 卖家运费成本, "free_by_meli": 是否ML包邮, "payer": 承担方}：
    - payer=seller（mandatory_free_shipping tag → 强制卖家付费）：卖家承担，显示卖家成本（free 端点 list_cost）；
    - payer=buyer（默认，shipping_options.cost>0 买家实付）：买家承担，卖家 0，显示「买家付」；
    - payer=meli（买家不付 cost=0 且 free_by_meli）：ML 包邮，卖家 0，显示「包邮」。"""
    try:
        det = store.client.get(f"/items/{item_id}")
        ship = det.get("shipping") or {}
        tags = ship.get("tags") or []
        uid = store.client.get_my_user()["id"]
        # 强制卖家付费（mandatory_free_shipping：商品超免运费限额，包邮成本卖家承担）
        if "mandatory_free_shipping" in tags:
            try:
                r = store.client.get(
                    f"/users/{uid}/shipping_options/free",
                    params={"item_id": item_id},
                )
                cov = (r.get("coverage") or {}).get("all_country") or {}
                cost = cov.get("list_cost")
                if cost:
                    return {"cost": float(cost), "free_by_meli": False, "payer": "seller"}
            except Exception:  # noqa: BLE001
                pass
            return {"cost": 0.0, "free_by_meli": True, "payer": "seller"}
        # 默认买家付：shipping_options 的 cost=买家实付（>0 → 买家承担）；cost=0 → ML 包邮
        try:
            r = store.client.get(
                f"/items/{item_id}/shipping_options",
                params={"zip_code": zip_code},
            )
            opts = r.get("options", []) or []
            rec = next((o for o in opts if o.get("display") == "recommended"), opts[0] if opts else None)
            if rec is not None and (rec.get("cost") or 0.0) > 0:
                # 买家承担运费 → 卖家实付 0
                return {"cost": 0.0, "free_by_meli": True, "payer": "buyer"}
        except Exception:  # noqa: BLE001
            pass
        # 买家不付（cost=0 或无法获取）→ ML 包邮
        return {"cost": 0.0, "free_by_meli": True, "payer": "meli"}
    except Exception:  # noqa: BLE001
        pass
    return {"cost": 0.0, "free_by_meli": True, "payer": "buyer"}


def get_official_fee(store, item_id: str, detail: dict) -> dict:
    """官方精确佣金：/sites/{site}/listing_prices?category_id=&price=&currency_id=&logistic_type=&shipping_mode=

    返回 {"percentage_fee": 佣金率%, "fee_amount": 佣金金额, "fixed_fee": 固定费}。
    按 类目+价格+物流类型 精确计算（如 AW13804 返回 16.5%，与后台/订单一致），
    比 /sites/MLB/listing_types 的基准（16%）准确。"""
    try:
        ship = detail.get("shipping") or {}
        price = detail.get("price") or detail.get("effective_price") or 0
        r = store.client.get(
            f"/sites/{store.site_id}/listing_prices",
            params={
                "category_id": detail.get("category_id") or "",
                "price": price,
                "currency_id": detail.get("currency_id") or "BRL",
                "logistic_type": ship.get("logistic_type") or "fulfillment",
                "shipping_mode": ship.get("mode") or "me2",
            },
        )
        for lt in r or []:
            if lt.get("listing_type_id") == detail.get("listing_type_id"):
                d = lt.get("sale_fee_details") or {}
                return {
                    "percentage_fee": d.get("percentage_fee") or 0.0,
                    "fee_amount": lt.get("sale_fee_amount") or 0.0,
                    "fixed_fee": d.get("fixed_fee") or 0.0,
                }
    except Exception:  # noqa: BLE001
        pass
    return {"percentage_fee": 0.0, "fee_amount": 0.0, "fixed_fee": 0.0}


def get_detail(store, item_id: str, *, include_attributes: bool = True) -> dict:
    """获取单个商品详情（含变体）+ 实际销售价（促销价）

    /items/{id} 的 price 是标准价（可能打折前的挂牌价），
    实际销售价在 /items/{id}/prices 的 type=promotion.amount。
    effective_price = 促销价（有）或标准价。"""
    params = {}
    if include_attributes:
        params["include_attributes"] = "all"
    detail = store.client.get(f"/items/{item_id}", params=params)
    # 补读价格表：优先促销价（当前实际售价），否则用标准价
    try:
        pd = store.client.get(f"/items/{item_id}/prices")
        prices = pd.get("prices", []) or []
        promo = next((p for p in prices if p.get("type") == "promotion"), None)
        std = next((p for p in prices if p.get("type") == "standard"), None)
        detail["effective_price"] = (
            promo.get("amount") if promo and promo.get("amount") else std.get("amount") if std else detail.get("price")
        )
        detail["effective_original_price"] = (
            (promo.get("regular_amount") or detail.get("original_price"))
            if promo else detail.get("original_price")
        )
    except Exception:  # noqa: BLE001
        detail["effective_price"] = detail.get("price")
        detail["effective_original_price"] = detail.get("original_price")
    # 平台计算运费（官方端点：包邮与否 + 官方价 + 承担方）
    _ship = get_platform_shipping(store, item_id)
    detail["platform_shipping"] = _ship["cost"]
    detail["free_shipping"] = _ship["free_by_meli"]
    detail["shipping_payer"] = _ship["payer"]
    # 官方精确佣金率（listing_prices 按类目+价格计算，如 16.5%）
    _fee = get_official_fee(store, item_id, detail)
    detail["official_fee_rate"] = _fee["percentage_fee"]
    detail["official_fee_amount"] = _fee["fee_amount"]
    detail["official_fee_fixed"] = _fee["fixed_fee"]
    return detail


def list_with_details(store, *, limit: int = 1000) -> list[dict]:
    """获取店铺所有商品 + 详情 + 变体（并发拉取，加速同步）"""
    from concurrent.futures import ThreadPoolExecutor

    ids = list_all(store, limit=limit)
    items: list = [None] * len(ids)

    def _fetch(idx: int, item_id: str):
        try:
            items[idx] = get_detail(store, item_id)
        except Exception as e:  # noqa: BLE001
            items[idx] = {"id": item_id, "_error": str(e)}

    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, iid in enumerate(ids):
            ex.submit(_fetch, i, iid)
    return items


def _promotion_type(item: dict) -> str:
    """优惠原因：促销价(prices 端点)／平台活动(promotions 数组)／卖家划线价／无"""
    # 优先：prices 端点有 promotion 类型 → 当前在促销
    if item.get("effective_price") and item.get("price") and item.get("effective_price") != item.get("price"):
        return "促销价"
    promos = item.get("promotions") or []
    if promos:
        names = [str(p.get("name") or p.get("type") or "") for p in promos]
        names = [n for n in names if n]
        return "平台活动：" + "、".join(names) if names else "平台活动"
    price = item.get("effective_price") or item.get("price") or 0
    op = item.get("effective_original_price") or item.get("original_price") or 0
    if op and price and op > price:
        return "卖家划线价"
    return ""


def extract_variations(item: dict) -> list[dict]:
    """从一个商品的 variations 数组中提取变体信息"""
    variations = item.get("variations", [])
    if not variations:
        # 单品，没有变体
        return [{
            "item_id": item["id"],
            "title": item["title"],
            "seller_sku": _get_sku(item),
            "gtin": _get_gtin(item),
            "price": item.get("effective_price") or item.get("price"),
            "available_quantity": item.get("available_quantity"),
            "sold_quantity": item.get("sold_quantity", 0),
            "currency_id": item.get("currency_id"),
            "original_price": item.get("effective_original_price") or item.get("original_price"),
            "sale_price": item.get("sale_price"),
            "platform_shipping": item.get("platform_shipping"),
            "free_shipping": item.get("free_shipping"),
            "official_fee_rate": item.get("official_fee_rate"),
            "shipping_payer": item.get("shipping_payer"),
            "status": item.get("status"),
            "listing_type": item.get("listing_type_id"),
            "promotion_type": _promotion_type(item),
            "date_created": item.get("date_created") or "",
        }]

    result = []
    for v in variations:
        attrs = {a["name"]: a["value_name"] for a in v.get("attribute_combinations", [])}
        v_sku = v.get("seller_custom_field") or ""
        v_gtin = ""
        for a in v.get("attributes", []):
            if a.get("id") == "GTIN":
                v_gtin = a.get("value_name", "")
            elif a.get("id") == "SELLER_SKU" and not v_sku:
                v_sku = a.get("value_name", "")
        # 变体级别没找到，回退到商品级别
        if not v_sku:
            v_sku = _get_sku(item)
        if not v_gtin:
            v_gtin = _get_gtin(item)
        result.append({
            "item_id": item["id"],
            "variation_id": v.get("id"),
            "title": item["title"],
            "attributes": attrs,
            "seller_sku": v_sku,
            "gtin": v_gtin,
            "price": item.get("effective_price") or v.get("price"),
            "available_quantity": v.get("available_quantity"),
            "sold_quantity": v.get("sold_quantity", 0),
            "currency_id": item.get("currency_id"),
            "original_price": item.get("effective_original_price") or item.get("original_price"),
            "sale_price": item.get("sale_price"),
            "platform_shipping": item.get("platform_shipping"),
            "free_shipping": item.get("free_shipping"),
            "official_fee_rate": item.get("official_fee_rate"),
            "shipping_payer": item.get("shipping_payer"),
            "status": item.get("status"),
            "listing_type": item.get("listing_type_id"),
            "promotion_type": _promotion_type(item),
            "date_created": item.get("date_created") or "",
        })
    return result


def flatten_products(store, *, limit: int = 1000) -> list[dict]:
    """获取所有商品的扁平化变体列表（每行一个变体）"""
    items = list_with_details(store, limit=limit)
    flat = []
    for item in items:
        if "_error" in item:
            flat.append(item)
        else:
            flat.extend(extract_variations(item))
    return flat


def _get_sku(item: dict) -> str:
    attrs = item.get("attributes", [])
    for a in attrs:
        if a.get("id") == "SELLER_SKU":
            return a.get("value_name", "")
    return ""


def _get_gtin(item: dict) -> str:
    attrs = item.get("attributes", [])
    for a in attrs:
        if a.get("id") == "GTIN":
            return a.get("value_name", "")
    return ""


def get_visits(store, item_id: str) -> dict:
    """获取商品最近访问量，依次尝试多个端点"""
    # 端点1: time_window（最近30天）— CBT 账号可能也支持
    try:
        return store.client.get(
            f"/items/{item_id}/visits/time_window",
            params={"last": 30, "unit": "day"},
        )
    except Exception:
        pass
    # 端点2: 按日期范围查
    try:
        from ..timeutil import br_date_str, br_days_ago

        return store.client.get(
            "/items/visits",
            params={"ids": item_id, "date_from": br_days_ago(30), "date_to": br_date_str()},
        )
    except Exception:
        pass
    # 端点3: 总量
    try:
        return store.client.get(f"/visits/items?ids={item_id}")
    except Exception:
        return {}


def get_performance(store, item_id: str) -> dict:
    """获取商品 Listing 质量评分（0-100）及改进建议"""
    try:
        return store.client.get(f"/item/{item_id}/performance")
    except Exception:
        return {}


def get_visits_range(
    store, item_ids: list[str], date_from: str, date_to: str, *, max_workers: int = 8
) -> dict:
    """按日期范围查访客，返回 {item_id: total_visits}。
    并发查询（默认 8 路）+ 30 分钟 TTL 缓存：可查截止日一天只变一次，
    同一天内重复打开/切换页面直接命中缓存，秒开。"""
    now = time.time()
    result: dict = {}
    missing: list[str] = []
    for iid in item_ids:
        key = (store.display_name, iid, date_from, date_to)
        hit = _VISITS_CACHE.get(key)
        if hit and now - hit[0] < _VISITS_TTL:
            result[iid] = hit[1]
        else:
            missing.append(iid)

    def _fetch(iid: str):
        try:
            d = store.client.get(
                f"/items/{iid}/visits",
                params={"date_from": date_from, "date_to": date_to},
            )
            return iid, d.get("total_visits", 0) or 0
        except Exception:  # noqa: BLE001
            return iid, 0

    if missing:
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            for iid, v in ex.map(_fetch, missing):
                result[iid] = v
                _VISITS_CACHE[(store.display_name, iid, date_from, date_to)] = (now, v)
    return result


# 访客缓存：key=(store, item_id, date_from, date_to) -> (时间戳, total_visits)
_VISITS_CACHE: dict = {}
_VISITS_TTL = 30 * 60  # 30 分钟


def clear_visits_cache() -> None:
    """清空访客缓存（同步完成后调用，下次查询实时重取）"""
    _VISITS_CACHE.clear()


def get_ads_by_item(store, site_id: str, advertiser_id: str, *, days: int = 30) -> dict[str, dict]:
    """拉取店铺全部 Product Ads 及其指标，返回 {item_id: ad}（ad 内含 metrics 字段）"""
    from ..timeutil import br_date_str, br_days_ago

    end = br_date_str()
    start = br_days_ago(days)

    ads = {}
    offset = 0
    limit = 50
    while True:
        data = store.client.get(
            f"/marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads/search",
            params={
                "metrics": "clicks,prints,ctr,cost,roas,total_amount,acos",
                "date_from": start,
                "date_to": end,
                "limit": limit,
                "offset": offset,
            },
            headers={"Api-Version": "2"},
        )
        results = data.get("results", [])
        for ad in results:
            item_id = ad.get("item_id")
            if item_id:
                ads[item_id] = ad
        offset += len(results)
        if not results or offset >= data.get("paging", {}).get("total", 0):
            break
    return ads


def get_product_ads(store, date_from: str, date_to: str) -> list[dict]:
    """拉取店铺全部 Product Ads（保留全部管理字段：status/campaign/buy_box 等）。

    与 get_ads_by_item 不同：不折叠成 {item_id: ad}，保留每条原始 ad 对象
    （含 status/status_raw/campaign_id/ad_group_id/current_level/buy_box_winner/
    deferred_stock/has_discount/image_quality/permalink/thumbnail 等 + metrics）。"""
    site_id = store.site_id
    advertiser_id = get_advertiser_id(store, site_id)
    if not advertiser_id:
        return []

    ads = []
    offset = 0
    limit = 50
    while True:
        data = store.client.get(
            f"/marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads/search",
            params={
                "metrics": "clicks,prints,ctr,cost,roas,total_amount,acos",
                "date_from": date_from,
                "date_to": date_to,
                "limit": limit,
                "offset": offset,
            },
            headers={"Api-Version": "2"},
        )
        results = data.get("results", [])
        ads.extend(results)
        offset += len(results)
        if not results or offset >= data.get("paging", {}).get("total", 0):
            break
    return ads


def get_advertiser_id(store, site_id: str) -> str:
    """获取 Product Ads 的 advertiser_id"""
    try:
        result = store.client.get("/advertising/advertisers", params={"product_id": "PADS"})
        # 找对应站点的 advertiser
        for adv in result.get("advertisers", []):
            if adv.get("site_id") == site_id:
                return str(adv.get("advertiser_id", ""))
    except Exception:
        pass
    return ""


def collect_daily_ads(store, *, days: int = 90) -> dict:
    """按天拉取 Product Ads，返回 {(item_id, date): {ad_*}}"""
    from datetime import timedelta

    from ..timeutil import br_now

    site_id = store.site_id
    advertiser_id = get_advertiser_id(store, site_id)
    if not advertiser_id:
        return {}

    result = {}
    for i in range(days):
        day = (br_now() - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        offset = 0
        while True:
            data = store.client.get(
                f"/marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads/search",
                params={
                    "metrics": "clicks,prints,ctr,cost,roas,total_amount,acos",
                    "date_from": day,
                    "date_to": day,
                    "limit": 50,
                    "offset": offset,
                },
                headers={"Api-Version": "2"},
            )
            results = data.get("results", [])
            for ad in results:
                item_id = ad.get("item_id")
                if not item_id:
                    continue
                m = ad.get("metrics", {})
                # 同一商品同一天可能命中多个广告（多广告活动/广告组）→ 必须累加，覆盖会少算
                entry = result.setdefault(
                    (item_id, day),
                    {"ad_cost": 0.0, "ad_clicks": 0.0, "ad_impressions": 0.0,
                     "ad_ctr": 0.0, "ad_sales": 0.0, "ad_roas": 0.0, "ad_acos": 0.0},
                )
                entry["ad_cost"] += m.get("cost") or 0.0
                entry["ad_clicks"] += m.get("clicks") or 0.0
                entry["ad_impressions"] += m.get("prints") or 0.0
                entry["ad_sales"] += m.get("total_amount") or 0.0
            offset += len(results)
            if not results or offset >= data.get("paging", {}).get("total", 0):
                break
    # 比率不能用单条值直接累加，用合计重算（单位与单条一致：ctr/acos=百分比，roas=倍数）
    for entry in result.values():
        clicks = entry["ad_clicks"]
        prints = entry["ad_impressions"]
        sales = entry["ad_sales"]
        cost = entry["ad_cost"]
        entry["ad_ctr"] = round(clicks / prints * 100, 2) if prints else 0.0
        entry["ad_roas"] = round(sales / cost, 2) if cost else 0.0
        entry["ad_acos"] = round(cost / sales * 100, 2) if sales else 0.0
    return result


def enrich_products(store, products: list[dict], *, limit: int = 1000) -> list[dict]:
    """为商品列表补充：访客量、质量评分、广告状态"""
    # 收集所有去重的 item_id
    item_ids = list(dict.fromkeys(p["item_id"] for p in products if "_error" not in p))

    # 批量预取
    site_id = store.site_id
    advertiser_id = get_advertiser_id(store, site_id)

    visits_cache = {}
    performance_cache = {}

    for item_id in item_ids:
        visits_cache[item_id] = get_visits(store, item_id)
        performance_cache[item_id] = get_performance(store, item_id)

    ads_cache = get_ads_by_item(store, site_id, advertiser_id) if advertiser_id else {}

    # 合并到每行
    for p in products:
        item_id = p.get("item_id", "")
        v_data = visits_cache.get(item_id, {})
        p_data = performance_cache.get(item_id, {})
        ad = ads_cache.get(item_id, {})

        # 访问量 — time_window 端点直接返回 total_visits
        p["total_visits"] = v_data.get("total_visits", "")

        # 质量评分
        score = p_data.get("score", "")
        p["performance_score"] = score.get("score", "") if isinstance(score, dict) else score
        p["performance_level"] = ""
        if isinstance(score, dict):
            p["performance_level"] = score.get("level", "")

        # 广告状态 + 指标
        metrics = ad.get("metrics", {})
        p["has_ads"] = bool(ad)
        p["ad_clicks"] = metrics.get("clicks", "")
        p["ad_impressions"] = metrics.get("prints", "")
        p["ad_ctr"] = metrics.get("ctr", "")
        p["ad_cost"] = metrics.get("cost", "")
        p["ad_roas"] = metrics.get("roas", "")
        p["ad_sales"] = metrics.get("total_amount", "")
        p["ad_acos"] = metrics.get("acos", "")

    return products


def find_by_sku(store, sku: str, *, limit: int = 1000) -> dict | None:
    """按 SELLER_SKU 查找商品变体"""
    all_variations = flatten_products(store, limit=limit)
    for v in all_variations:
        if v.get("seller_sku") == sku:
            return v
    return None
