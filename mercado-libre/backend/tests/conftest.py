"""测试基建 — 路径注入 + 临时库 fixture（三个测试接缝共用）"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

for p in (BACKEND_DIR, PROJECT_ROOT):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))


@pytest.fixture
def tmp_db(monkeypatch, tmp_path):
    """把 SQLite 指向临时文件库并建表；repository / 服务层查询原样复用"""
    from app import db

    db_path = tmp_path / "test.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    db.init_db()
    return db_path


def seed_snapshot(
    db_path,
    rows: list[dict],
    table: str = "daily_snapshot",
    columns: list[str] | None = None,
) -> None:
    """往临时库插入快照/元数据行（直接走 sqlite，测服务不测写入）"""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cols = columns or list(rows[0].keys())
    ph = ",".join("?" * len(cols))
    conn.executemany(
        f"INSERT INTO {table} ({','.join(cols)}) VALUES ({ph})",
        [tuple(r.get(c) for c in cols) for r in rows],
    )
    conn.commit()
    conn.close()
