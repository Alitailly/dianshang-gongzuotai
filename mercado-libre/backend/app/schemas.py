"""Pydantic 数据模型 — 与蓝鲸 listing 字段对齐 + 店铺维度"""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel


class ProductVariation(BaseModel):
    store: str
    item_id: str
    variation_id: Optional[str] = None
    title: Optional[str] = None
    seller_sku: Optional[str] = None
    gtin: Optional[str] = None
    price: Optional[float] = None
    available_quantity: Optional[int] = None
    sold_quantity: Optional[int] = None
    currency_id: Optional[str] = None
    total_visits: Optional[float] = None
    performance_score: Optional[float] = None
    performance_level: Optional[str] = None
    has_ads: bool = False
    ad_clicks: Optional[float] = None
    ad_impressions: Optional[float] = None
    ad_ctr: Optional[float] = None
    ad_cost: Optional[float] = None
    ad_roas: Optional[float] = None
    attributes: Optional[dict] = None
    updated_at: Optional[str] = None


class StoreInfo(BaseModel):
    name: str
    display_name: str
    site_id: str


class ProductListResult(BaseModel):
    items: List[ProductVariation]
    total: int
    page: int
    page_size: int


class OverviewResult(BaseModel):
    total_skus: int
    total_items: int
    total_sold: float
    total_visits: float
    total_ad_cost: float
    ad_count: int
    avg_performance_score: Optional[float]
    avg_roas: Optional[float]
    store_count: int
    by_store: List[dict]
