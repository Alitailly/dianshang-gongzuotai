"""FastAPI 入口（含每日自动更新调度：巴西 10:20 拉取最新数据 → 飞书同步/自动建新月份表）"""

from __future__ import annotations

import sys
from pathlib import Path

# 让 backend 能 import 项目根目录下的 src 包
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from . import db  # noqa: E402
from .routers import ad_manage, ads, ai, bitable, export, items, messages as messages_router, meta, overview, products, stores, sync  # noqa: E402

db.init_db()

app = FastAPI(title="美客多数据看板 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stores.router)
app.include_router(meta.router)
app.include_router(items.router)
app.include_router(ads.router)
app.include_router(products.router)
app.include_router(overview.router)
app.include_router(sync.router)
app.include_router(export.router)
app.include_router(ad_manage.router)
app.include_router(bitable.router)
app.include_router(ai.router)
app.include_router(messages_router.router)

# 每日更新运行标记（记录最近一次成功跑完的巴西日期，用于开机补跑判断）
_MARKER = Path(__file__).resolve().parents[2] / "data" / ".daily_update_marker"


def _last_daily_update_date() -> str | None:
    try:
        return _MARKER.read_text(encoding="utf-8").strip() or None
    except Exception:  # noqa: BLE001
        return None


def _record_daily_update() -> None:
    from src.timeutil import br_date_str

    try:
        _MARKER.parent.mkdir(parents=True, exist_ok=True)
        _MARKER.write_text(br_date_str(), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _days_since_last() -> int:
    """距上次成功运行的天数（0=今天已跑过；-1=未来，按 0 处理）"""
    from datetime import date

    from src.timeutil import br_date_str

    last = _last_daily_update_date()
    if not last:
        return 0
    try:
        return max((date.fromisoformat(br_date_str()) - date.fromisoformat(last)).days, 0)
    except Exception:  # noqa: BLE001
        return 0


def _days_back_since_last() -> int:
    """ML 拉取窗口：默认 5 天（覆盖广告 T+3 定档 + 余量）；停机越久越大（最多 14 天），覆盖停机期间的定档广告"""
    return min(max(_days_since_last() + 2, 5), 14)


def _run_daily_update() -> None:
    """每日自动更新：
    1) ML→SQLite：拉最近 N 天（广告/订单 5 天起，覆盖 T+3 定档修正）
    2) SQLite→飞书：窗口 = 最近 N 天（历史行冻结，diff 只写变化行，定档修正自动补全）；
       停机多天时窗口自动扩大，把漏掉的日子补建（新月份表自动创建、昨天广告定档补全）"""
    import threading

    def _job():
        try:
            from . import sync as sync_service  # 服务层（backend/app/sync.py），注意别和 routers.sync 混
            from src.timeutil import br_days_ago

            gap = _days_since_last()
            ml_days = min(max(gap + 2, 5), 14)
            r1 = sync_service.run_sync(days_back=ml_days)
            if r1.get("error"):
                print(f"[scheduler] 每日数据同步失败: {r1['error']}", flush=True)
                return
            # 飞书窗口：正常 5 天（覆盖 T+3）；停机 gap 天 → 覆盖到 gap+1 天（把缺的日子补建）
            fs_days = min(max(gap + 1, 5), 14)
            r2 = bitable.sync_daily(date_from=br_days_ago(fs_days - 1))
            _record_daily_update()
            print(
                f"[scheduler] 每日更新完成: 拉取{ml_days}天 sync={r1.get('counts')} "
                f"飞书窗口={fs_days}天({r2.get('date_from')}~{r2.get('date_to')})",
                flush=True,
            )
        except Exception as e:  # noqa: BLE001
            print(f"[scheduler] 每日更新失败: {e}", flush=True)

    threading.Thread(target=_job, daemon=True).start()


def _run_message_poll() -> None:
    """站内信轮询：每 10 分钟拉新提问入待审队列（不生成草稿，草稿由人工点击触发）"""
    import threading

    def _job():
        try:
            from src.store import Store, list_stores

            from . import message_queue
            from .messages import MessagingAPI

            total = {"new": 0, "failed": 0}
            for name in list_stores():
                store = Store(name)
                try:
                    store.refresh_token()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    r = message_queue.ingest(MessagingAPI(store.client), store=store.display_name)
                except Exception as e:  # noqa: BLE001
                    print(f"[scheduler] 店铺 {name} 站内信轮询失败: {e}", flush=True)
                    continue
                for k in total:
                    total[k] += r.get(k, 0)
            print(f"[scheduler] 站内信轮询完成: {total}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[scheduler] 站内信轮询失败: {e}", flush=True)

    threading.Thread(target=_job, daemon=True).start()


def _run_weekly_reconcile() -> None:
    """每周深度对账（默认周一巴西 10:30，广告定档后）：
    只重拉最近 20 天【广告】数据（不拉订单，省 API 调用防限流）→ 重同步飞书最近 20 天（diff 只写变化行），
    抓 T+3 之外偶尔迟到的修正（如 08-15 广告数据第 10 天才补全的案例）。"""
    import threading

    def _job():
        try:
            from . import sync as sync_service
            from src.timeutil import br_days_ago

            r1 = sync_service.deep_refresh_ads(days_back=20)
            if r1.get("error"):
                print(f"[scheduler] 周对账广告重拉失败: {r1['error']}", flush=True)
                return
            r2 = bitable.sync_daily(date_from=br_days_ago(19))
            print(
                f"[scheduler] 周对账完成: 广告重拉{sorted(set((d or '')[:10] for d in [r1.get('days', '')]))} "
                f"飞书={r2.get('date_from')}~{r2.get('date_to')}",
                flush=True,
            )
        except Exception as e:  # noqa: BLE001
            print(f"[scheduler] 周对账失败: {e}", flush=True)

    threading.Thread(target=_job, daemon=True).start()


_scheduler = None


@app.on_event("startup")
def _start_scheduler() -> None:
    """每日三个更新点自动更新（用户指定）：
    ① 北京 08:50（=巴西前一天 21:50） ② 北京 13:50（=巴西 02:50） ③ 巴西 10:20（广告定档后=北京 21:20）。
    启动时若巴西已过当天最早更新点(02:50)且今天还没成功跑过 → 补跑一次"""
    global _scheduler
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
        from apscheduler.triggers.interval import IntervalTrigger
        from datetime import datetime
        from zoneinfo import ZoneInfo

        from src.timeutil import br_date_str

        br = ZoneInfo("America/Sao_Paulo")
        cn = ZoneInfo("Asia/Shanghai")
        _scheduler = BackgroundScheduler(timezone=br)
        _scheduler.add_job(
            _run_daily_update,
            CronTrigger(hour=8, minute=50, timezone=cn),
            id="daily_update_cn_0850",
            replace_existing=True,
            misfire_grace_time=7200,
        )
        _scheduler.add_job(
            _run_daily_update,
            CronTrigger(hour=13, minute=50, timezone=cn),
            id="daily_update_cn_1350",
            replace_existing=True,
            misfire_grace_time=7200,
        )
        _scheduler.add_job(
            _run_daily_update,
            CronTrigger(hour=10, minute=20, timezone=br),
            id="daily_update_ad_finalize",
            replace_existing=True,
            misfire_grace_time=7200,
        )
        _scheduler.add_job(
            _run_weekly_reconcile,
            CronTrigger(day_of_week="mon", hour=10, minute=30, timezone=br),
            id="weekly_ad_reconcile",
            replace_existing=True,
            misfire_grace_time=7200,
        )
        _scheduler.add_job(
            _run_message_poll,
            IntervalTrigger(minutes=10),
            id="message_poll",
            replace_existing=True,
            misfire_grace_time=300,
        )
        _scheduler.start()
        print(
            "[scheduler] 定时任务已启动：北京 08:50 / 13:50 + 巴西 10:20（广告定档后）"
            "+ 周一 10:30 周广告对账 + 站内信每 10 分钟轮询",
            flush=True,
        )
        # 启动补跑：巴西已过当天最早更新点 02:50 且今天还没成功跑过 → 补一次
        now = datetime.now(br)
        if (now.hour > 2 or (now.hour == 2 and now.minute >= 50)) and _last_daily_update_date() != br_date_str():
            print("[scheduler] 启动时已过更新点且今天未跑，补跑", flush=True)
            _run_daily_update()
        # 启动即拉一次站内信（否则要等首个 10 分钟周期）
        _run_message_poll()
    except Exception as e:  # noqa: BLE001
        print(f"[scheduler] 定时任务启动失败: {e}", flush=True)


@app.on_event("shutdown")
def _stop_scheduler() -> None:
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception:  # noqa: BLE001
            pass


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}
