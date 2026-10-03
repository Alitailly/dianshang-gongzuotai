"""广告投放监控 + 决策辅助 — 实时拉 ads/search + 本地商品聚合 + 手工操作登记

ML Product Ads API 只读（官方文档 "monitor campaigns, ads, and metrics"），
无写操作端点；本页 = 只读监控 + 本地决策建议 + 手工登记操作留痕。
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from src.atoms import products as products_atom
from src.store import Store, list_stores

from .. import db, repository

router = APIRouter(prefix="/api/ad-manage", tags=["ad-manage"])

# ads/search 实时拉取缓存（5 分钟 TTL）：同日重复打开直接命中
_AD_CACHE: dict = {}
_AD_TTL = 5 * 60
_AD_LOCK = threading.Lock()

# 操作类型（登记用，不调 ML API）
OP_TYPES = {
    "pause": "暂停投放",
    "resume": "恢复投放",
    "change_bid": "调整出价",
    "change_budget": "调整预算",
    "optimize": "优化Listing",
    "other": "其他",
}

_SORTS = {
    "ad_cost": "ad_cost",
    "ad_sales": "ad_sales",
    "ad_roas": "ad_roas",
    "ad_acos": "ad_acos",
    "ad_clicks": "ad_clicks",
    "ad_impressions": "ad_impressions",
    "ad_ctr": "ad_ctr",
    "price": "price",
    "status": "status",
    "current_level": "current_level",
}


def _store_map() -> dict:
    m = {}
    for name in list_stores():
        try:
            s = Store(name)
            m[s.display_name] = s
        except Exception:  # noqa: BLE001
            continue
    return m


def _fetch_store_ads(s, date_from: str, date_to: str) -> list[dict]:
    """拉单个店铺 ads（失败返回空，不影响其他店）"""
    try:
        return products_atom.get_product_ads(s, date_from, date_to)
    except Exception:  # noqa: BLE001
        return []


def _load_ads(date_from: str, date_to: str) -> list[dict]:
    """实时拉全部店铺 ads + 与本地商品聚合 JOIN（保本ROAS/结算率等）。5 分钟缓存。"""
    key = (date_from, date_to)
    now = time.time()
    with _AD_LOCK:
        hit = _AD_CACHE.get(key)
        if hit and now - hit[0] < _AD_TTL:
            return hit[1]

    df = date_from or "0000-00-00"
    dt = date_to or "9999-99-99"
    ad_to = repository._ad_cap(dt)  # 广告只统计到定档截止日

    store_map = _store_map()
    rows: list[dict] = []
    if store_map:
        with ThreadPoolExecutor(max_workers=len(store_map)) as ex:
            futures = {
                ex.submit(_fetch_store_ads, s, df, ad_to): sname
                for sname, s in store_map.items()
            }
            for fut in futures:
                sname = futures[fut]
                for ad in fut.result():
                    m = ad.get("metrics") or {}
                    rows.append(
                        {
                            "store": sname,
                            "item_id": ad.get("item_id", ""),
                            "title": ad.get("title", ""),
                            "thumbnail": ad.get("thumbnail", ""),
                            "permalink": ad.get("permalink", ""),
                            "status": ad.get("status", ""),
                            "status_raw": ad.get("status_raw", ""),
                            "campaign_id": ad.get("campaign_id"),
                            "ad_group_id": ad.get("ad_group_id"),
                            "current_level": ad.get("current_level", ""),
                            "buy_box_winner": bool(ad.get("buy_box_winner")),
                            "deferred_stock": bool(ad.get("deferred_stock")),
                            "has_discount": bool(ad.get("has_discount")),
                            "image_quality": ad.get("image_quality", ""),
                            "recommended": bool(ad.get("recommended")),
                            "logistic_type": ad.get("logistic_type", ""),
                            "listing_type_id": ad.get("listing_type_id", ""),
                            "price": ad.get("price"),
                            "ad_cost": m.get("cost") or 0.0,
                            "ad_sales": m.get("total_amount") or 0.0,
                            "ad_clicks": m.get("clicks") or 0.0,
                            "ad_impressions": m.get("prints") or 0.0,
                            "ad_ctr": m.get("ctr") or 0.0,
                            "ad_roas": m.get("roas") or 0.0,
                            "ad_acos": m.get("acos") or 0.0,
                        }
                    )

    # 与本地商品聚合 JOIN：保本ROAS/结算率/佣金/物流（区间口径）
    if rows:
        item_ids = list({r["item_id"] for r in rows})
        local = repository.list_items(
            page_size=500, date_from=df, date_to=dt
        )["items"]
        local_by_id = {it["item_id"]: it for it in local}
        for r in rows:
            agg = local_by_id.get(r["item_id"], {})
            r["breakeven_roas"] = agg.get("breakeven_roas") or 0.0
            r["settlement_rate"] = agg.get("settlement_rate") or 0.0
            r["commission"] = agg.get("commission") or 0.0
            r["shipping_fee"] = agg.get("shipping_fee") or 0.0
            r["revenue"] = agg.get("revenue") or 0.0

        # 最近一次操作登记
        ph = ",".join("?" * len(item_ids))
        conn = db.get_conn()
        op_rows = conn.execute(
            f"""
            SELECT item_id, op_type, note, created_at
            FROM ad_ops_log
            WHERE item_id IN ({ph})
            ORDER BY id DESC
            """,
            item_ids,
        ).fetchall()
        conn.close()
        last_by_item: dict = {}
        for o in op_rows:
            last_by_item.setdefault(
                o["item_id"],
                {
                    "op_type": o["op_type"],
                    "note": o["note"],
                    "created_at": o["created_at"],
                },
            )
        for r in rows:
            r["last_op"] = last_by_item.get(r["item_id"])

    with _AD_LOCK:
        _AD_CACHE[key] = (now, rows)
    return rows


def _clear_ad_cache() -> None:
    with _AD_LOCK:
        _AD_CACHE.clear()


def _attention(r: dict) -> bool:
    """是否命中"需关注"建议（红/橙级，需行动）：缺货 / 亏损投放 / 无消耗 / 新手期。
    Buy Box 不纳入：自动投放模式下普遍拿不到，属全店现象而非单商品行动项。"""
    if r.get("deferred_stock"):
        return True
    if r.get("status") != "active":
        return False
    cost = r.get("ad_cost") or 0
    roas = r.get("ad_roas") or 0
    br = r.get("breakeven_roas") or 0
    # 亏损投放：有花费且 ROAS 低于保本（roas=0 也算，花了钱没卖出）
    if cost > 0 and br > 0 and roas < br:
        return True
    if cost == 0:
        return True
    if r.get("current_level") == "newbie":
        return True
    return False


@router.get("/items")
def ad_items(
    store: Optional[str] = None,
    keyword: Optional[str] = None,
    status: Optional[str] = None,
    attention: Optional[str] = None,
    sort_by: str = "ad_cost",
    order: str = "desc",
    page: int = 1,
    page_size: int = Query(50, ge=1, le=500),
    date_from: str = "",
    date_to: str = "",
):
    rows = _load_ads(date_from, date_to)
    if store:
        rows = [r for r in rows if r["store"] == store]
    if keyword:
        kw = keyword.lower()
        rows = [
            r
            for r in rows
            if kw in (r["title"] or "").lower() or kw in r["item_id"].lower()
        ]
    if status in ("active", "hold"):
        rows = [r for r in rows if r["status"] == status]
    if attention == "1":
        rows = [r for r in rows if _attention(r)]

    key = _SORTS.get(sort_by, "ad_cost")
    reverse = order.lower() != "asc"
    rows.sort(
        key=lambda r: (r.get(key) is None, r.get(key) or 0),
        reverse=reverse,
    )

    total = len(rows)
    start = (page - 1) * page_size
    items = rows[start : start + page_size]
    for r in items:
        r["attention"] = _attention(r)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/summary")
def ad_summary(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    rows = _load_ads(date_from, date_to)
    if store:
        rows = [r for r in rows if r["store"] == store]

    active = [r for r in rows if r["status"] == "active"]
    hold = [r for r in rows if r["status"] == "hold"]
    cost = sum(r["ad_cost"] for r in rows)
    sales = sum(r["ad_sales"] for r in rows)
    n = len(rows)
    breakevens = [r["breakeven_roas"] for r in rows if r["breakeven_roas"] > 0]

    return {
        "active_count": len(active),
        "hold_count": len(hold),
        "total_count": n,
        "ad_cost": round(cost, 2),
        "ad_sales": round(sales, 2),
        "roas": round(sales / cost, 2) if cost else 0.0,
        "acos": round(cost / sales * 100, 2) if sales else 0.0,
        "buy_box_rate": round(sum(1 for r in rows if r["buy_box_winner"]) / n * 100, 1) if n else 0.0,
        "avg_breakeven_roas": round(sum(breakevens) / len(breakevens), 2) if breakevens else 0.0,
        "ad_finalized_date": repository._ad_cap(date_to) if date_to else None,
    }


class AdOpIn(BaseModel):
    store: str
    item_id: str
    campaign_id: Optional[str] = None
    ad_group_id: Optional[str] = None
    op_type: str
    note: str


@router.post("/ops")
def create_op(op: AdOpIn):
    if op.op_type not in OP_TYPES:
        raise HTTPException(400, f"操作类型不合法: {op.op_type}")
    if not (op.note or "").strip():
        raise HTTPException(400, "备注不能为空")
    conn = db.get_conn()
    cur = conn.execute(
        """
        INSERT INTO ad_ops_log (store, item_id, campaign_id, ad_group_id, op_type, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            op.store,
            op.item_id,
            str(op.campaign_id) if op.campaign_id else None,
            str(op.ad_group_id) if op.ad_group_id else None,
            op.op_type,
            op.note.strip(),
            datetime.now().isoformat(timespec="seconds"),
        ),
    )
    conn.commit()
    conn.close()
    _clear_ad_cache()
    return {"id": cur.lastrowid}


@router.get("/ops")
def list_ops(
    item_id: Optional[str] = None,
    store: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
):
    where, params = [], []
    if item_id:
        where.append("item_id = ?")
        params.append(item_id)
    if store:
        where.append("store = ?")
        params.append(store)
    sql = "SELECT * FROM ad_ops_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    conn = db.get_conn()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["op_label"] = OP_TYPES.get(d["op_type"], d["op_type"])
        out.append(d)
    return out
