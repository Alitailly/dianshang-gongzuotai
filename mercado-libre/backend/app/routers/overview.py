"""经营总览接口 — 日期范围 + 按天趋势 + 排行榜"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from .. import repository

router = APIRouter(prefix="/api/overview", tags=["overview"])

# 排行榜支持的类型（对应 repository.list_items 的排序列）
_RANKING_TYPES = ["sold_quantity", "revenue", "settlement", "ad_cost", "ad_sales", "ad_roas"]


@router.get("")
def get_overview(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    result = repository.overview(store, date_from, date_to)

    return result


@router.get("/trend")
def get_trend(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    return repository.trend(store, date_from, date_to)


@router.get("/rankings")
def get_rankings(
    type: str = Query("revenue", description="排行类型"),
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
    limit: int = Query(10, ge=1, le=50),
):
    if type not in _RANKING_TYPES:
        type = "revenue"
    data = repository.list_items(
        store=store,
        sort_by=type,
        order="desc",
        page=1,
        page_size=limit,
        date_from=date_from,
        date_to=date_to,
    )
    ranked = []
    for i, it in enumerate(data["items"], start=1):
        ranked.append(
            {
                "rank": i,
                "store": it["store"],
                "item_id": it["item_id"],
                "title": it["title"],
                "value": it.get(type, 0),
            }
        )
    return {"type": type, "items": ranked}
