"""SQLite 快照存储 — 商品元数据表 + 每日快照表"""

from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "dashboard.db"

# 商品元数据列（当前状态：标题/价格/库存/体验分等）
COLUMNS = [
    "store", "item_id", "variation_id", "title", "seller_sku", "gtin",
    "price", "available_quantity", "currency_id",
    "performance_score", "performance_level", "has_ads",
    "original_price", "sale_price", "promotion_type",
    "platform_shipping", "status", "listing_type", "free_shipping", "official_fee_rate", "shipping_payer", "date_created", "attributes", "updated_at",
]

# 每日快照列（时间序列：广告 + 销售/佣金/物流 + 订单数 + 成交单价/订单级原价/优惠券）
DAILY_COLUMNS = [
    "store", "item_id", "date",
    "ad_cost", "ad_clicks", "ad_impressions", "ad_ctr", "ad_sales", "ad_roas", "ad_acos",
    "sold_quantity", "revenue", "commission", "shipping_fee", "order_count",
    "unit_price", "full_unit_price", "coupon_amount", "gross_amount",
]

_DDL = """
CREATE TABLE IF NOT EXISTS product_variation (
    store TEXT NOT NULL,
    item_id TEXT NOT NULL,
    variation_id TEXT,
    title TEXT,
    seller_sku TEXT,
    gtin TEXT,
    price REAL,
    available_quantity INTEGER,
    currency_id TEXT,
    performance_score REAL,
    performance_level TEXT,
    has_ads INTEGER DEFAULT 0,
    original_price REAL,
    sale_price REAL,
    promotion_type TEXT,
    platform_shipping REAL,
    status TEXT,
    listing_type TEXT,
    free_shipping INTEGER DEFAULT 0,
    official_fee_rate REAL,
    shipping_payer TEXT,
    date_created TEXT,
    attributes TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_store ON product_variation (store);
CREATE INDEX IF NOT EXISTS idx_product_item ON product_variation (item_id);

CREATE TABLE IF NOT EXISTS daily_snapshot (
    store TEXT NOT NULL,
    item_id TEXT NOT NULL,
    date TEXT NOT NULL,
    ad_cost REAL,
    ad_clicks REAL,
    ad_impressions REAL,
    ad_ctr REAL,
    ad_sales REAL,
    ad_roas REAL,
    ad_acos REAL,
    sold_quantity REAL,
    revenue REAL,
    commission REAL,
    shipping_fee REAL,
    order_count INTEGER DEFAULT 0,
    unit_price REAL,
    full_unit_price REAL,
    coupon_amount REAL,
    gross_amount REAL,
    PRIMARY KEY (store, item_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_snapshot (date);
CREATE INDEX IF NOT EXISTS idx_daily_item ON daily_snapshot (item_id);

-- 每日商品状态快照：每天记录每个商品"当天"的 库存/价格/体验分 等聚合值
-- （ML 不提供历史库存，只能自己从启用日起记录；飞书历史行用它显示当天的真实值，
--   无快照的日子回退到 product_variation 当前值）
CREATE TABLE IF NOT EXISTS daily_stock (
    store TEXT NOT NULL,
    item_id TEXT NOT NULL,
    date TEXT NOT NULL,
    available_quantity REAL,
    price REAL,
    original_price REAL,
    performance_score REAL,
    has_ads INTEGER DEFAULT 0,
    variation_count INTEGER DEFAULT 0,
    official_fee_rate REAL,
    listing_type TEXT,
    platform_shipping REAL,
    shipping_payer TEXT,
    PRIMARY KEY (store, item_id, date)
);
CREATE INDEX IF NOT EXISTS idx_dstock_date ON daily_stock (date);
CREATE INDEX IF NOT EXISTS idx_dstock_item ON daily_stock (item_id);

CREATE TABLE IF NOT EXISTS ad_ops_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store TEXT NOT NULL,
    item_id TEXT NOT NULL,
    campaign_id TEXT,
    ad_group_id TEXT,
    op_type TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adops_item ON ad_ops_log (item_id);
CREATE INDEX IF NOT EXISTS idx_adops_store ON ad_ops_log (store);

-- 站内信消息工作台：待审队列（状态机 new → draft → sent / skipped）
CREATE TABLE IF NOT EXISTS message_workbench (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT 'pre_sale',
    sender_id TEXT,
    sender_name TEXT,
    message_text TEXT NOT NULL,
    item_id TEXT,
    order_id TEXT,
    received_at TEXT,
    draft TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (store, message_id)
);
CREATE INDEX IF NOT EXISTS idx_mw_status ON message_workbench (status);
CREATE INDEX IF NOT EXISTS idx_mw_store ON message_workbench (store);
"""


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn) -> None:
    """老库缺列时 ALTER 补齐（无需删库重建）"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(product_variation)").fetchall()}
    for col, typ in (("original_price", "REAL"), ("sale_price", "REAL"), ("promotion_type", "TEXT"), ("platform_shipping", "REAL"), ("status", "TEXT"), ("listing_type", "TEXT"), ("free_shipping", "INTEGER"), ("official_fee_rate", "REAL"), ("shipping_payer", "TEXT"), ("date_created", "TEXT")):
        if col not in cols:
            conn.execute(f"ALTER TABLE product_variation ADD COLUMN {col} {typ}")
    dcols = {r[1] for r in conn.execute("PRAGMA table_info(daily_snapshot)").fetchall()}
    for col, typ in (("unit_price", "REAL"), ("full_unit_price", "REAL"), ("coupon_amount", "REAL"), ("gross_amount", "REAL")):
        if col not in dcols:
            conn.execute(f"ALTER TABLE daily_snapshot ADD COLUMN {col} {typ}")


def init_db() -> None:
    conn = get_conn()
    conn.executescript(_DDL)
    _migrate(conn)
    conn.commit()
    conn.close()
