"""一次性端到端冒烟：临时库 + fake 环境变量下走通新 API 路由（验证 wiring，不属于测试接缝）"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

# 临时库 + 无 key（llm 调用会报配置错误 → 验证错误语义路径）
_tmp = tempfile.mkdtemp()
os.environ["DASHBOARD_DB"] = str(Path(_tmp) / "smoke.db")

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402

# 让 db 用临时库：monkeypatch 环境变量在 import 后不生效，直接改模块常量
db.DB_PATH = Path(_tmp) / "smoke.db"
db.init_db()

# 塞一条广告快照，让 ad-analysis 走到 LLM 调用路径（预期 llm_error，证明数据/服务接线正常）
import sqlite3  # noqa: E402

conn = sqlite3.connect(str(db.DB_PATH))
conn.execute(
    "INSERT INTO product_variation (store, item_id, title) VALUES (?,?,?)",
    ("BA05", "MLB1", "商品A"),
)
conn.execute(
    "INSERT INTO daily_snapshot (store, item_id, date, ad_cost, ad_sales, ad_clicks, ad_impressions) VALUES (?,?,?,?,?,?,?)",
    ("BA05", "MLB1", "2026-08-25", 10.0, 30.0, 100, 5000),
)
conn.commit()
conn.close()

c = TestClient(app)

r = c.get("/api/health")
print("health:", r.status_code, r.json())

r = c.get("/api/ai/ad-analysis", params={"store": "BA05", "date_from": "2026-08-25", "date_to": "2026-08-25"})
print("ad-analysis:", r.status_code, r.json().get("ok"), r.json().get("reason"))

r = c.get("/api/messages", params={"store": "BA05"})
print("messages list:", r.status_code, r.json())

r = c.post("/api/messages/999/draft")
print("messages draft(not found):", r.status_code, r.json())

r = c.post("/api/messages/999/send")
print("messages send(not found):", r.status_code, r.json())

r = c.post("/api/messages/999/skip")
print("messages skip(not found):", r.status_code, r.json())
