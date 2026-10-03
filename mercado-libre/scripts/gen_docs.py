#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从代码提取「唯一事实源」，回填 docs 中的 GEN 占位符区域。

用法:
    .venv/bin/python scripts/gen_docs.py            # 回填生成内容
    .venv/bin/python scripts/gen_docs.py --check    # 只检查是否同步（CI 用，不同步退出码 1）

占位符区域写法（markdown 注释包裹，脚本替换 BEGIN/END 之间的内容，勿手改中间内容）：
    <!-- GEN:columns_table:BEGIN -->
    （此区域由脚本从代码生成）
    <!-- GEN:columns_table:END -->

支持的关键字：
    columns_table    飞书子表列清单（来源 backend/app/routers/bitable.py FIELD_DEFS）
    schedule_table   每日定时任务时间点（来源 backend/app/main.py add_job CronTrigger）
    month_table_name 飞书子表名格式（来源 bitable.py _month_table_name）
    finalized_rule   广告定档截止规则（来源 src/timeutil.py AD_FINALIZE_HOUR）
    formula_table    派生列公式表（来源 bitable.py DERIVED_FORMULAS）
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
BITABLE = ROOT / "backend" / "app" / "routers" / "bitable.py"
MAIN = ROOT / "backend" / "app" / "main.py"
TIMEUTIL = ROOT / "src" / "timeutil.py"

MARKER_BEGIN = "<!-- GEN:{key}:BEGIN -->"
MARKER_END = "<!-- GEN:{key}:END -->"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


# ---------- 各关键字的内容生成器 ----------

def gen_columns_table() -> str:
    """从 bitable.py 的 TEXT_FIELDS / NUM_FIELDS（含分组注释）生成列清单表格"""
    src = _read(BITABLE)
    text = re.search(r"TEXT_FIELDS\s*=\s*\[(.*?)\]", src, re.S).group(1)
    num = re.search(r"NUM_FIELDS\s*=\s*\[(.*?)\]", src, re.S).group(1)
    text_cols = re.findall(r'"([^"]+)"', text)

    groups = []  # (label, [cols])
    cur_label = "其他"
    cur_cols: list[str] = []
    for line in num.splitlines():
        line = line.strip()
        if line.startswith("#"):
            if cur_cols:
                groups.append((cur_label, cur_cols))
                cur_cols = []
            cur_label = line.lstrip("#").strip()
        else:
            m = re.match(r'"([^"]+)"', line)
            if m:
                cur_cols.append(m.group(1))
    if cur_cols:
        groups.append((cur_label, cur_cols))

    out = ["| 分组 | 列 |", "|---|---|"]
    out.append(f"| 结构（文本） | {' / '.join(text_cols)} |")
    for label, cols in groups:
        out.append(f"| {label} | {' / '.join(cols)} |")
    return "\n".join(out)


def gen_schedule_table() -> str:
    """从 main.py 的 add_job CronTrigger 提取每日定时任务（含北京时间换算，巴西=北京-11h）"""
    src = _read(MAIN)
    jobs = re.findall(
        r'_scheduler\.add_job\(\s*_run_daily_update,\s*CronTrigger\(hour=(\d+),\s*minute=(\d+),\s*timezone=(\w+)\),\s*id="([^"]+)"',
        src,
    )
    tz_map = {"cn": "Asia/Shanghai", "br": "America/Sao_Paulo"}
    out = ["| 任务 id | 触发时间（本地） | 北京时间 |", "|---|---|---|"]
    for hour, minute, tz, jid in jobs:
        local = f"{int(hour):02d}:{int(minute):02d}"
        if tz == "cn":
            bj = local
        else:  # br → 北京 = 巴西 + 11h
            bj_h = (int(hour) + 11) % 24
            bj = f"{bj_h:02d}:{int(minute):02d}"
        out.append(f"| `{jid}` | {tz_map.get(tz, tz)} {local} | {bj} |")
    return "\n".join(out)


def gen_month_table_name() -> str:
    """从 bitable.py _month_table_name 的 f-string 提取表名格式"""
    src = _read(BITABLE)
    m = re.search(r'return\s+f"([^"]+)"', src)
    if not m:
        raise SystemExit("bitable.py 找不到 _month_table_name 的 return f-string")
    pat = m.group(1)
    pat = (
        pat.replace("{display}", "{店铺}")
        .replace("{month[:4]}", "{YYYY}")
        .replace("{int(month[5:7])}", "{M}")
    )
    return f"表名 = `{pat}`（如 `BA05 2026年8月`）"


def gen_finalized_rule() -> str:
    """从 timeutil.py 的 AD_FINALIZE_HOUR 生成广告定档截止规则表"""
    src = _read(TIMEUTIL)
    m = re.search(r"AD_FINALIZE_HOUR\s*=\s*(\d+)", src)
    h = int(m.group(1))
    return (
        "| 当前巴西时间 | 广告定档截止日 |\n"
        "|---|---|\n"
        f"| < {h:02d}:00 | 前天 |\n"
        f"| ≥ {h:02d}:00 | 昨天 |"
    )


def gen_formula_table() -> str:
    """从 bitable.py 的 DERIVED_FORMULAS 字典生成派生列公式表"""
    src = _read(BITABLE)
    m = re.search(r"DERIVED_FORMULAS\s*(?::\s*[^=]+)?=\s*\{(.*?)\n\}", src, re.S)
    if not m:
        raise SystemExit("bitable.py 找不到 DERIVED_FORMULAS")
    pairs = re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', m.group(1))
    if not pairs:
        raise SystemExit("DERIVED_FORMULAS 解析为空")
    out = ["| 列 | 公式 |", "|---|---|"]
    for name, expr in pairs:
        out.append(f"| {name} | {expr} |")
    return "\n".join(out)


GENERATORS = {
    "columns_table": gen_columns_table,
    "schedule_table": gen_schedule_table,
    "month_table_name": gen_month_table_name,
    "finalized_rule": gen_finalized_rule,
    "formula_table": gen_formula_table,
}


def process_doc(path: Path, check: bool) -> int:
    text = _read(path)
    changed = False
    for key, fn in GENERATORS.items():
        begin = MARKER_BEGIN.format(key=key)
        end = MARKER_END.format(key=key)
        if begin not in text:
            continue
        if end not in text:
            raise SystemExit(f"{path}: 有 {key} 的 BEGIN 但没有 END")
        content = fn()
        new = re.sub(
            re.escape(begin) + r".*?" + re.escape(end),
            begin + "\n" + content + "\n" + end,
            text,
            flags=re.S,
        )
        if new != text:
            text = new
            changed = True
    if changed and not check:
        path.write_text(text, encoding="utf-8")
        print(f"[gen_docs] 已更新: {path.name}")
    elif changed and check:
        print(f"[gen_docs] 需更新: {path.name}")
    return 1 if (check and changed) else 0


def main() -> None:
    check = "--check" in sys.argv
    rc = 0
    for p in sorted(DOCS.glob("*.md")):
        rc |= process_doc(p, check)
    if check:
        print("[gen_docs] OK: 占位符已与代码同步" if rc == 0
              else "[gen_docs] 占位符与代码不同步，请运行 scripts/gen_docs.py")
        sys.exit(rc)


if __name__ == "__main__":
    main()
