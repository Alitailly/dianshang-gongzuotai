#!/usr/bin/env python3
"""RPA 询盘日志监控(03 期间)
- 频率: 前30分钟每5分钟 / 30-60分钟每10分钟 / 之后每30分钟
- 异常检测: 错误规格回归(伸缩隔离带)、报错、Traceback、CDP失败、发送失败、日志停滞
- 发现异常 → macOS 系统通知 + 写入 monitor_report.md
停止: pkill -f monitor_logs.py
"""
import os
import time
import subprocess
from datetime import datetime

LOG_DIR = os.path.expanduser("~/Desktop/飞书多维表格管理工具星系核/logs")
REPORT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".release-local", "monitor_report.md")
START = time.time()

# 异常模式(名称, 关键字)
ALERTS = [
    ("错误规格回归", "伸缩隔离带"),
    ("报错", "报错"),
    ("异常堆栈", "Traceback"),
    ("CDP失败", "CDP失败"),
    ("发送失败", "发送失败"),
]

_last_notify = {}  # 模式 -> 上次通知时间(限频:同模式30分钟一次)


def notify(title, msg):
    # 参数数组调用,避免 shell 拼接;同时去掉引号/反斜杠,防止破坏 AppleScript 字符串语法
    safe_msg = str(msg).replace("\\", "").replace('"', " ")[:200]
    safe_title = str(title).replace("\\", "").replace('"', " ")[:80]
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{safe_msg}" with title "{safe_title}"'],
            timeout=10, capture_output=True)
    except Exception:
        pass


def log_report(line):
    try:
        with open(REPORT, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%m-%d %H:%M:%S')}] {line}\n")
    except Exception:
        pass


def current_interval():
    el = time.time() - START
    if el < 30 * 60:
        return 300   # 5 分钟
    if el < 60 * 60:
        return 600   # 10 分钟
    return 1800      # 30 分钟


def main():
    # 选择今天的日志,不存在则取最新
    today = datetime.now().strftime("%Y%m%d")
    path = os.path.join(LOG_DIR, f"bot_{today}.log")
    if not os.path.exists(path):
        logs = sorted(f for f in os.listdir(LOG_DIR)
                      if f.startswith("bot_") and f.endswith(".log"))
        if not logs:
            notify("RPA监控", "未找到 bot 日志,请检查星系核 logs 目录")
            return
        path = os.path.join(LOG_DIR, logs[-1])
    log_file = path
    print(f"[monitor] 监控日志: {log_file}", flush=True)
    log_report(f"监控启动: {log_file}")

    offset = os.path.getsize(log_file)
    last_round = ""
    while True:
        time.sleep(current_interval())
        now = time.time()
        try:
            size = os.path.getsize(log_file)
            if size < offset:
                offset = 0  # 日志轮转
            with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                f.seek(offset)
                new = f.read()
                offset = f.tell()

            for line in new.splitlines():
                if "=== 第" in line and "轮" in line:
                    last_round = line.strip()[:100]
                for name, kw in ALERTS:
                    if kw in line:
                        msg = f"{name}: {line.strip()[:120]}"
                        if _last_notify.get(name, 0) + 1800 > now:
                            continue  # 限频
                        _last_notify[name] = now
                        print(f"[monitor][ALERT] {msg}", flush=True)
                        log_report(f"⚠️ {msg}")
                        notify("RPA 监控-异常", msg[:80])

            # 停滞检测:日志超过 3 个间隔未更新
            mtime = os.path.getmtime(log_file)
            if now - mtime > current_interval() * 3:
                if _last_notify.get("停滞", 0) + 3600 <= now:
                    _last_notify["停滞"] = now
                    mins = int((now - mtime) // 60)
                    log_report(f"⚠️ 日志停滞 {mins} 分钟无更新(可能卡住或任务已结束)")
                    notify("RPA 监控", f"日志 {mins} 分钟未更新,可能卡住或已结束")

            if last_round:
                log_report(f"进度: {last_round}")
                last_round = ""
        except Exception as e:
            log_report(f"监控自身异常: {e}")


if __name__ == "__main__":
    main()
