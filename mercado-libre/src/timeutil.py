"""时间工具 — 巴西时区(UTC-3)，ML 站点数据按此统计"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

BR_TZ = timezone(timedelta(hours=-3))


def br_now() -> datetime:
    """当前巴西时间（aware）"""
    return datetime.now(timezone.utc).astimezone(BR_TZ)


def br_date_str() -> str:
    """巴西今天 YYYY-MM-DD"""
    return br_now().strftime("%Y-%m-%d")


def br_days_ago(days: int) -> str:
    """巴西 N 天前 YYYY-MM-DD"""
    return (br_now() - timedelta(days=days)).strftime("%Y-%m-%d")


def br_iso_range(days: int) -> tuple[str, str]:
    """巴西 [days-1 天前的 00:00, 现在] 的 ISO 带时区范围。

    按完整日历天（days-1 天前 00:00 起），与 collect_daily_ads 的按天口径一致；
    避免从"now-days 当天时刻"起算导致窗口最旧一天只有半天数据、被增量 upsert 覆盖成残缺。"""
    now = br_now()
    end = now.strftime("%Y-%m-%dT%H:%M:%S.000-03:00")
    start = (now - timedelta(days=days - 1)).strftime("%Y-%m-%dT00:00:00.000-03:00")
    return start, end


# 广告数据定档规则：ML 后台实时可见，但正式定档在次日 10:00（巴西时间）。
# 定档前当天数据不完整，不可作为最终口径查询。
AD_FINALIZE_HOUR = 10  # 巴西时间


def br_latest_finalized_date() -> str:
    """最新可查截止日（广告已定档的数据）：
    巴西现在 <10:00 → 前天；>=10:00 → 昨天（今天永不完整）。"""
    now = br_now()
    if now.hour < AD_FINALIZE_HOUR:
        return (now - timedelta(days=2)).strftime("%Y-%m-%d")
    return (now - timedelta(days=1)).strftime("%Y-%m-%d")
