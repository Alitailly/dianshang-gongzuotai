"""导出接口 — CSV（商品级）"""

from __future__ import annotations

import csv
import io
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from src.atoms import products as products_atom
from src.store import Store, list_stores
from src.timeutil import br_date_str, br_days_ago

from .. import repository

router = APIRouter(prefix="/api/export", tags=["export"])

# 导出 CSV 列：英文列名 → 中文表头（与商品分析页面列完全一致）
_CSV_FIELDS = [
    # 商品信息
    ("store", "店铺"),
    ("seller_sku", "SKU"),
    ("item_id", "商品ID"),
    ("title", "商品名称"),
    ("variation_count", "变体数"),
    ("price", "现价"),
    ("original_price", "原价"),
    ("unit_commission", "佣金/件"),
    ("platform_shipping", "平台运费"),
    ("unit_income", "实际收入/件"),
    # 库存
    ("sold_quantity", "已售"),
    ("available_quantity", "可售库存"),
    # 流量
    ("total_visits", "全流量总访问"),
    ("natural_visits", "自然访问(估算)"),
    ("ad_clicks", "广告点击"),
    ("ad_impressions", "曝光"),
    ("natural_visits_rate", "自然访问占比(访问)"),
    ("ad_click_rate", "广告点击占比(访问)"),
    ("natural_sales", "自然销售额"),
    ("ad_sales", "广告销售额"),
    ("natural_sales_rate", "自然销售额占比(销售)"),
    ("ad_share", "广告销售额占比(销售)"),
    # 广告·加投决策
    ("ad_cost", "广告花费"),
    ("ad_roas", "ROAS"),
    ("breakeven_roas", "保本ROAS"),
    ("ad_acos", "ACOS%"),
    ("ad_ctr", "CTR%"),
    # 质量
    ("performance_score", "体验分"),
    ("has_ads", "有广告"),
]


@router.get("/products.csv")
def export_products(
    store: Optional[str] = None,
    keyword: Optional[str] = None,
    has_ads: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
    sort_by: str = "item_id",
    order: str = "asc",
):
    data = repository.list_items(
        store=store, keyword=keyword, has_ads=has_ads,
        sort_by=sort_by, order=order, page=1, page_size=100000,
        date_from=date_from, date_to=date_to,
    )
    buf = io.StringIO()
    # UTF-8 BOM：Excel/WPS 打开 CSV 时正确识别中文（不加会乱码/打不开）
    buf.write("\ufeff")
    # 用中文表头写第一行；CRLF 换行是 Excel 的标准要求（LF 会导致旧版 Excel 数据挤进第一行）
    buf.write(",".join(h for _, h in _CSV_FIELDS) + "\r\n")
    writer = csv.DictWriter(
        buf,
        fieldnames=[k for k, _ in _CSV_FIELDS],
        extrasaction="ignore",
        quoting=csv.QUOTE_MINIMAL,
        lineterminator="\r\n",
    )

    # 全流量总访问（按天去重独立访客口径；结束日恒截断到巴西昨天）按所选范围补齐
    items = data["items"]
    if items:
        store_map = {}
        for name in list_stores():
            try:
                s = Store(name)
                store_map[s.display_name] = s
            except Exception:  # noqa: BLE001
                continue
        v_to = br_days_ago(1)
        if date_to and date_to < br_date_str():
            v_to = date_to
        v_from = date_from or br_days_ago(29)
        if v_from > v_to:
            v_from = v_to
        by_store: dict = {}
        for it in items:
            by_store.setdefault(it["store"], []).append(it["item_id"])
        visits: dict = {}
        for sname, iids in by_store.items():
            s = store_map.get(sname)
            if s:
                visits.update(products_atom.get_visits_range(s, iids, v_from, v_to))
        for it in items:
            total = visits.get(it["item_id"], 0) or 0
            clicks = it.get("ad_clicks") or 0
            it["total_visits"] = total
            it["natural_visits"] = max(total - clicks, 0)
            it["natural_visits_rate"] = round(it["natural_visits"] / total * 100, 1) if total else 0.0
            it["ad_click_rate"] = round(clicks / total * 100, 1) if total else 0.0

    for item in items:
        row = {k: item.get(k) for k, _ in _CSV_FIELDS}
        if "has_ads" in row:
            row["has_ads"] = "是" if row.get("has_ads") else "否"
        # 数值统一保留 2 位（避免 452.72999999999996 这类浮点长尾）
        for k, v in row.items():
            if isinstance(v, float):
                row[k] = round(v, 2)
        writer.writerow(row)

    buf.seek(0)
    # 文件名带店铺名 + 数据区间 + 导出时间，便于归档识别
    from datetime import datetime
    from src.timeutil import br_now

    store_label = store or "全店铺"
    ts = br_now().strftime("%Y%m%d-%H%M")
    if date_from and date_to:
        fname = f"商品分析_{store_label}_{date_from}_{date_to}_{ts}.csv"
    else:
        fname = f"商品分析_{store_label}_{ts}.csv"

    # 中文文件名：RFC 5987 编码（filename*），兼容 Excel/浏览器下载；
    # filename 兜底必须纯 ASCII（latin-1 无法编码中文）
    from urllib.parse import quote

    ascii_name = store or "all"
    ascii_fallback = f"products_{ascii_name}_{date_from or 'range'}_{ts}.csv" if date_from else f"products_{ascii_name}_{ts}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(fname)}",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
