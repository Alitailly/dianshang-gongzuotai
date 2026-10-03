"""接缝②：广告助手服务 — fake LLM + 临时 SQLite（复用 repository 查询）验证输出结构与 prompt 内容"""

from __future__ import annotations

import pytest

from app import ad_assistant, llm
from conftest import seed_snapshot


def _fake_llm(captured: dict, response):
    def llm_chat(system_prompt: str, messages: list[dict], **kwargs):
        captured["system"] = system_prompt
        captured["user"] = messages[0]["content"]
        return response

    return llm_chat


def _seed_ad_data(db_path):
    # 商品元数据（list_items 数据来源）
    seed_snapshot(
        db_path,
        [
            {"store": "BA05", "item_id": "MLB1", "title": "商品A", "seller_sku": "SKU1"},
            {"store": "BA05", "item_id": "MLB2", "title": "商品B", "seller_sku": "SKU2"},
        ],
        table="product_variation",
        columns=["store", "item_id", "title", "seller_sku"],
    )
    # 两天广告数据：总花费 22.5、总销售额 60、点击 300、曝光 15000
    seed_snapshot(
        db_path,
        [
            {"store": "BA05", "item_id": "MLB1", "date": "2026-08-25",
             "ad_cost": 10.0, "ad_sales": 30.0, "ad_clicks": 100, "ad_impressions": 5000},
            {"store": "BA05", "item_id": "MLB2", "date": "2026-08-25",
             "ad_cost": 12.5, "ad_sales": 30.0, "ad_clicks": 200, "ad_impressions": 10000},
        ],
    )


def test_analyze_returns_overview_blocks_and_summary(tmp_db):
    _seed_ad_data(tmp_db)
    captured = {}
    fake = _fake_llm(
        captured,
        {
            "overview": "整体花费可控，ROAS 良好",
            "blocks": [
                {"metric": "广告花费", "value": "22.5 元", "advice": "提高出价"},
                {"metric": "CTR", "value": "2.0%", "advice": "优化主图"},
                {"metric": "ROAS", "value": "2.67", "advice": "维持投放"},
            ],
        },
    )
    result = ad_assistant.analyze("BA05", "2026-08-25", "2026-08-25", llm_chat=fake)
    assert result["ok"] is True
    assert result["overview"] == "整体花费可控，ROAS 良好"
    assert result["blocks"][0] == {"metric": "广告花费", "value": "22.5 元", "advice": "提高出价"}
    assert result["date_from"] == "2026-08-25"
    assert result["date_to"] == "2026-08-25"
    assert result["ad_finalized_date"]
    # summary 是精确聚合数字（来自 repository，非 LLM 生成），供前端渲染汇总行
    assert result["summary"]["cost"] == 22.5
    assert result["summary"]["sales"] == 60.0
    assert result["summary"]["roas"] == 2.67
    assert result["summary"]["ad_items"] == 2


def test_analyze_prompt_contains_ad_data_and_finalization_semantics(tmp_db):
    _seed_ad_data(tmp_db)
    captured = {}
    fake = _fake_llm(captured, {"overview": "x", "blocks": []})
    ad_assistant.analyze("BA05", "2026-08-25", "2026-08-25", llm_chat=fake)
    prompt = captured["system"] + "\n" + captured["user"]
    # prompt 必须包含所选范围的聚合数据（总花费 22.5）与定档语义说明
    assert "22.5" in prompt
    assert "定档" in prompt
    assert "商品A" in prompt


def test_analyze_blocks_missing_field_returns_parse_error(tmp_db):
    _seed_ad_data(tmp_db)
    fake = _fake_llm(
        {},
        {"overview": "x", "blocks": [{"metric": "广告花费", "value": "22.5"}]},  # 缺 advice
    )
    result = ad_assistant.analyze("BA05", "2026-08-25", "2026-08-25", llm_chat=fake)
    assert result["ok"] is False
    assert result["reason"] == "parse_error"


def test_analyze_no_data_returns_clear_message(tmp_db):
    captured = {}
    result = ad_assistant.analyze("BA05", "2026-08-25", "2026-08-25", llm_chat=_fake_llm(captured, {}))
    assert result["ok"] is False
    assert result["reason"] == "no_data"
    assert "广告" in result["message"]


def test_analyze_llm_error_returns_error_message(tmp_db):
    _seed_ad_data(tmp_db)

    def failing_llm(system_prompt, messages, **kwargs):
        raise llm.LLMRateLimitError("限流")

    result = ad_assistant.analyze("BA05", "2026-08-25", "2026-08-25", llm_chat=failing_llm)
    assert result["ok"] is False
    assert result["reason"] == "llm_error"
    assert "限流" in result["message"]


def test_analyze_invalid_structure_returns_parse_error(tmp_db):
    _seed_ad_data(tmp_db)
    result = ad_assistant.analyze(
        "BA05", "2026-08-25", "2026-08-25",
        llm_chat=_fake_llm({}, {"overview": 123, "blocks": []}),
    )
    assert result["ok"] is False
    assert result["reason"] == "parse_error"
