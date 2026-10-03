"""广告流量接口 — 汇总/趋势/商品广告列表（广告截至定档日）"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from .. import repository

router = APIRouter(prefix="/api/ads", tags=["ads"])

# 商品广告列表可排序列（对应 repository.list_items 的广告列）
_ADS_SORTS = ["ad_cost", "ad_sales", "ad_clicks", "ad_impressions", "ad_ctr", "ad_roas", "ad_acos"]


@router.get("/summary")
def ads_summary(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    return repository.ads_summary(store, date_from, date_to)


@router.get("/trend")
def ads_trend(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    return repository.ads_trend(store, date_from, date_to)


@router.get("/items")
def ads_items(
    store: Optional[str] = None,
    keyword: Optional[str] = None,
    sort_by: str = "ad_cost",
    order: str = "desc",
    page: int = 1,
    page_size: int = Query(50, ge=1, le=500),
    date_from: str = "",
    date_to: str = "",
):
    if sort_by not in _ADS_SORTS:
        sort_by = "ad_cost"
    result = repository.list_items(
        store=store,
        keyword=keyword,
        ad_active="1",  # 只列所选区间内有广告数据（曝光/花费/点击>0）的商品，与汇总的 ad_items 同口径
        sort_by=sort_by,
        order=order,
        page=page,
        page_size=page_size,
        date_from=date_from,
        date_to=date_to,
    )
    # 只保留广告相关列
    keys = [
        "store", "item_id", "title", "ad_cost", "ad_clicks", "ad_impressions",
        "ad_ctr", "ad_sales", "ad_roas", "ad_acos",
    ]
    result["items"] = [{k: it.get(k) for k in keys} for it in result["items"]]
    return result
