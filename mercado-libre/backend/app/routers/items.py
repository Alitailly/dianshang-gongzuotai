"""商品级（分组）列表接口 — 支持日期范围筛选 + 访客实时查询（按天去重独立访客）"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query

from src.atoms import products as products_atom
from src.store import Store, list_stores
from src.timeutil import br_date_str, br_days_ago

from .. import repository

router = APIRouter(prefix="/api/items", tags=["items"])


def _store_map() -> dict:
    m = {}
    for name in list_stores():
        try:
            s = Store(name)
            m[s.display_name] = s
        except Exception:  # noqa: BLE001
            continue
    return m


def _visits_window(date_from: str, date_to: str) -> tuple[str, str]:
    """访客查询窗口：结束日恒截断到巴西昨天（今天数据不完整，与后台定档口径一致）。
    所选范围已在昨天之前时按原范围。"""
    v_to = br_days_ago(1)
    if date_to and date_to < br_date_str():
        v_to = date_to
    v_from = date_from or br_days_ago(29)
    if v_from > v_to:
        v_from = v_to
    return v_from, v_to


@router.get("")
def list_items(
    store: Optional[str] = None,
    keyword: Optional[str] = None,
    has_ads: Optional[str] = None,
    sort_by: str = "revenue",
    order: str = "desc",
    page: int = 1,
    page_size: int = Query(50, ge=1, le=500),
    date_from: str = "",
    date_to: str = "",
):
    result = repository.list_items(
        store=store,
        keyword=keyword,
        has_ads=has_ads,
        sort_by=sort_by,
        order=order,
        page=page,
        page_size=page_size,
        date_from=date_from,
        date_to=date_to,
    )

    # 全流量总访问（按天去重独立访客口径；恒截断到巴西昨天）按访客窗口实时查询
    if result["items"]:
        store_map = _store_map()
        by_store: dict = {}
        for it in result["items"]:
            by_store.setdefault(it["store"], []).append(it["item_id"])
        v_from, v_to = _visits_window(date_from, date_to)
        visits: dict = {}
        for sname, iids in by_store.items():
            s = store_map.get(sname)
            if s:
                visits.update(products_atom.get_visits_range(s, iids, v_from, v_to))
        for it in result["items"]:
            total = visits.get(it["item_id"], 0) or 0
            clicks = it.get("ad_clicks") or 0
            # 全流量总访问 = 商品 visits 接口（按天去重，恒截断到昨日）；
            # 自然访问 = 全流量总访问 − 广告访问；广告 API 无「广告访问」字段，用广告点击近似（估算，标注偏差）
            it["total_visits"] = total
            it["natural_visits"] = max(total - clicks, 0)
            it["natural_visits_rate"] = round(it["natural_visits"] / total * 100, 1) if total else 0.0
            it["ad_click_rate"] = round(clicks / total * 100, 1) if total else 0.0

    return result
