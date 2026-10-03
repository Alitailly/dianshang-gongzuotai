"""广告口径对齐 — 「投放商品」定义 + 广告/订单同窗不变量

背景：广告流量页的列表曾把全店商品都列出来（无广告数据也列），而汇总的 ad_items 只算有花费/点击的，
两处数字对不上；另外「结算 = 销售额 − 佣金 − 物流 − 广告花费」在区间含未定档日时会拿两个窗口相减。
本文件锁住两条约定：
1. 投放商品 = 所选区间内 曝光/花费/点击 任一 > 0（列表与 ad_items 同口径）；
2. 区间结束日不超过广告定档日时，订单与广告同窗 → 派生列自洽。
"""

from __future__ import annotations

from app import repository
from conftest import seed_snapshot

# 用远早于「今天」的日期，避免依赖 br_latest_finalized_date() 的取值
D1, D2 = "2026-08-20", "2026-08-21"


def _seed_products(db_path):
    seed_snapshot(
        db_path,
        [
            {"store": "BA05", "item_id": "MLB1", "title": "有花费", "seller_sku": "S1", "has_ads": 1},
            {"store": "BA05", "item_id": "MLB2", "title": "只有曝光", "seller_sku": "S2", "has_ads": 1},
            {"store": "BA05", "item_id": "MLB3", "title": "无广告", "seller_sku": "S3", "has_ads": 0},
        ],
        table="product_variation",
        columns=["store", "item_id", "title", "seller_sku", "has_ads"],
    )


def _seed_ad_rows(db_path):
    seed_snapshot(
        db_path,
        [
            # MLB1：有花费 100、销售额 300
            {"store": "BA05", "item_id": "MLB1", "date": D1,
             "ad_cost": 60.0, "ad_sales": 200.0, "ad_clicks": 30, "ad_impressions": 1000},
            {"store": "BA05", "item_id": "MLB1", "date": D2,
             "ad_cost": 40.0, "ad_sales": 100.0, "ad_clicks": 20, "ad_impressions": 500},
            # MLB2：只有曝光（花费/点击为 0）→ 仍算投放商品
            {"store": "BA05", "item_id": "MLB2", "date": D1,
             "ad_cost": 0.0, "ad_sales": 0.0, "ad_clicks": 0, "ad_impressions": 800},
            # MLB3：有订单快照但没有广告数据（全 0）→ 不算投放商品
            {"store": "BA05", "item_id": "MLB3", "date": D1,
             "ad_cost": 0.0, "ad_sales": 0.0, "ad_clicks": 0, "ad_impressions": 0},
        ],
    )


def test_ad_items_counts_impressions_only_items(tmp_db):
    """只有曝光、没有花费/点击的商品也要计入投放商品数"""
    _seed_products(tmp_db)
    _seed_ad_rows(tmp_db)
    cur = repository.ads_summary(None, D1, D2)["current"]
    assert cur["ad_items"] == 2  # MLB1（有花费）+ MLB2（只有曝光）
    assert cur["cost"] == 100.0


def test_ads_list_only_returns_ad_active_items(tmp_db):
    """广告流量页列表只列区间内有广告数据的商品，且条数与 ad_items 一致"""
    _seed_products(tmp_db)
    _seed_ad_rows(tmp_db)
    res = repository.list_items(ad_active="1", date_from=D1, date_to=D2, page_size=50)
    ids = sorted(it["item_id"] for it in res["items"])
    assert ids == ["MLB1", "MLB2"]
    assert res["total"] == repository.ads_summary(None, D1, D2)["current"]["ad_items"] == 2
    # 列表广告花费合计 == 汇总广告花费（同一窗口、同一来源）
    assert round(sum(it["ad_cost"] for it in res["items"]), 2) == 100.0


def test_list_items_without_ad_active_still_shows_all_products(tmp_db):
    """商品分析页不过滤广告：三个商品都要在（保持原行为）"""
    _seed_products(tmp_db)
    _seed_ad_rows(tmp_db)
    res = repository.list_items(date_from=D1, date_to=D2, page_size=50)
    assert res["total"] == 3


def test_ads_list_window_excludes_out_of_range_ad_spend(tmp_db):
    """区间外的广告花费不计入：查 D2 单日时 MLB1 只剩 40"""
    _seed_products(tmp_db)
    _seed_ad_rows(tmp_db)
    res = repository.list_items(ad_active="1", date_from=D2, date_to=D2, page_size=50)
    assert [it["item_id"] for it in res["items"]] == ["MLB1"]  # MLB2 的曝光只在 D1
    assert res["items"][0]["ad_cost"] == 40.0


def test_overview_settlement_uses_same_window_as_ad_cost(tmp_db):
    """区间不超过定档日时，结算 = 销售额 − 佣金 − 物流 − 广告花费（同窗自洽）"""
    seed_snapshot(
        tmp_db,
        [{"store": "BA05", "item_id": "MLB1", "title": "商品", "seller_sku": "S1", "has_ads": 1}],
        table="product_variation",
        columns=["store", "item_id", "title", "seller_sku", "has_ads"],
    )
    seed_snapshot(
        tmp_db,
        [{"store": "BA05", "item_id": "MLB1", "date": D1, "sold_quantity": 10, "revenue": 1000.0,
          "commission": 110.0, "shipping_fee": 50.0, "order_count": 5,
          "ad_cost": 100.0, "ad_sales": 300.0, "ad_clicks": 30, "ad_impressions": 1000}],
    )
    ov = repository.overview(None, D1, D1)
    assert ov["total_ad_cost"] == 100.0
    assert ov["total_settlement"] == 1000.0 - 110.0 - 50.0 - 100.0  # 740


def test_trend_marks_finalized_days(tmp_db):
    """趋势接口给每天打定档标记（未定档日不可用于汇总）"""
    _seed_products(tmp_db)
    _seed_ad_rows(tmp_db)
    rows = repository.trend(None, D1, D2)
    assert [r["date"] for r in rows] == [D1, D2]
    assert all(r["finalized"] for r in rows)  # D1/D2 远早于定档截止日
