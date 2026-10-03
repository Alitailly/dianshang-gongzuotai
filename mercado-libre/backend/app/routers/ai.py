"""AI 功能接口 — 广告助手分析 + 站内信消息工作台"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter

from .. import ad_assistant

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/ad-analysis")
def ad_analysis(
    store: Optional[str] = None,
    date_from: str = "",
    date_to: str = "",
):
    """广告助手：选店铺+时间范围 → 总览 + 建议卡片

    始终 200，结果带 ok 标记：true=分析成功；false 时 reason 为
    no_data / llm_error / parse_error，message 为给人看的提示。"""
    return ad_assistant.analyze(store, date_from, date_to)
