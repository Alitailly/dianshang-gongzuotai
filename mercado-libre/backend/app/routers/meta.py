"""数据可查时间规则 — 广告 T+1 次日 10:00(巴西) 定档，未定档日期不可查"""

from __future__ import annotations

from fastapi import APIRouter

from src.timeutil import (
    AD_FINALIZE_HOUR,
    br_date_str,
    br_latest_finalized_date,
    br_now,
)

from .. import db

router = APIRouter(prefix="/api/meta", tags=["meta"])


@router.get("/data-status")
def data_status() -> dict:
    """返回最新可查截止日、数据源实时性说明、快照最早日期"""
    conn = db.get_conn()
    earliest = conn.execute("SELECT MIN(date) FROM daily_snapshot").fetchone()[0]
    conn.close()

    return {
        "br_now": br_now().isoformat(timespec="seconds"),
        "br_today": br_date_str(),
        "latest_finalized_date": br_latest_finalized_date(),
        "earliest_date": earliest,  # 快照最早一天，之前无数据
        "ad_finalize_time": f"{AD_FINALIZE_HOUR:02d}:00",
        "ad_timezone": "America/Sao_Paulo (UTC-3)",
        "data_sources": {
            "products": {"real_time": True, "note": "标题/价格/库存/销量，实时"},
            "orders": {"real_time": True, "note": "订单支付后实时可见"},
            "visits": {"real_time": False, "note": "已停用：ML 访客 API 仅按天去重独立访客，无含重复点击的总访客口径，且含今天的窗口与后台定档口径有差值"},
            "performance": {"real_time": False, "note": "体验分按天更新"},
            "ads": {
                "real_time": False,
                "note": "广告 T+1，次日 10:00 巴西时间定档（此前仅后台实时预览，不可作最终口径）",
            },
        },
    }
