"""同步接口 — 触发拉取 + 查询状态"""

from __future__ import annotations

from fastapi import APIRouter

from .. import sync as sync_service

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("")
def trigger_sync(days_back: int = 90) -> dict:
    """触发拉取。days_back：广告/订单拉取窗口天数（默认 90 全量；每日增量用 4 左右）"""
    return sync_service.start_sync_async(days_back=days_back)


@router.get("/status")
def status() -> dict:
    return sync_service.get_sync_status()
