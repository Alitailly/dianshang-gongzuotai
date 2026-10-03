"""广告助手 — 读广告聚合数据 → LLM 出优化建议（一次性分析，非对话）

复用现有 repository 查询（ads_summary / ads_trend / list_items），不新造数据管道；
prompt 含指标定义与「定档」语义说明；LLM 边界可注入（llm_chat），测试用 fake。
"""

from __future__ import annotations

from . import llm, repository

SYSTEM_PROMPT = """你是美客多（Mercado Libre）广告投放分析师，面向巴西站 MLB 卖家。

指标口径（严格按以下定义，不要自己臆造）：
- ad_cost 广告花费；ad_sales 广告直接销售额；ad_clicks 广告点击；ad_impressions 广告曝光
- ad_ctr 点击率 = 点击 / 曝光 × 100%
- ad_roas 投产比 = 广告销售额 / 广告花费
- ad_acos 广告成本占比 = 广告花费 / 广告销售额 × 100%
- 广告数据按天定档（次日巴西 10:00 最终确认），未定档日的广告数字可能修正，只能看定档截止日之前的数据

你的任务：基于我提供的汇总、按天趋势与高花费商品清单，输出一段表现总览 + 3~5 个「指标 + 建议」块。
每个块针对一个广告指标，紧密对应：metric 是指标名，value 是该指标的具体数值（引用我提供的数据），advice 是针对该指标给出的具体建议（含问题描述与行动）。
只输出 JSON，不要输出其他文字：
{"overview": "总览（含关键数字）", "blocks": [{"metric": "指标名", "value": "指标数值", "advice": "建议"}]}"""


def _build_prompt(summary: dict, trend: list[dict], top_items: list[dict]) -> str:
    cur = summary["current"]
    lines = [
        "【汇总】",
        f"- 花费 {cur['cost']}、广告销售额 {cur['sales']}、点击 {cur['clicks']}、曝光 {cur['impressions']}",
        f"- CTR {cur['ctr']}%、ROAS {cur['roas']}、ACOS {cur['acos']}%、CPC {cur['cpc']}",
        f"- 有广告投入的商品数 {cur['ad_items']}",
        f"- 广告定档截止日：{summary['ad_finalized_date']}（之后日期未定档，不用于分析）",
        "【按天趋势（date, cost, sales, clicks, impressions, finalized 是否定档）】",
    ]
    for t in trend:
        lines.append(
            f"- {t['date']}: 花费 {t['cost']}、销售额 {t['sales']}、点击 {t['clicks']}、曝光 {t['impressions']}"
            f"{'（定档）' if t['finalized'] else '（未定档）'}"
        )
    lines.append("【高花费商品 Top（item, title, 花费, 销售额, ROAS, ACOS, 点击率）】")
    for it in top_items:
        lines.append(
            f"- {it['item_id']} {it['title']}: 花费 {it['ad_cost']}、销售额 {it['ad_sales']}、"
            f"ROAS {it['ad_roas']}、ACOS {it['ad_acos']}、CTR {it['ad_ctr']}"
        )
    lines.append("请只输出 JSON（见系统提示中的结构），总览要引用关键数字，建议 3~5 条。")
    return "\n".join(lines)


def _validate(result) -> str | None:
    """校验 LLM 输出结构，返回错误信息；合法返回 None"""
    if not isinstance(result, dict):
        return "LLM 返回结构无效"
    if not isinstance(result.get("overview"), str) or not result.get("overview"):
        return "LLM 返回缺少总览"
    blocks = result.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return "LLM 返回缺少指标建议块"
    if not 3 <= len(blocks) <= 5:
        return "指标建议块数量需为 3~5"
    for b in blocks:
        if not isinstance(b, dict):
            return "指标块不是对象"
        if not all(isinstance(b.get(k), str) and b.get(k) for k in ("metric", "value", "advice")):
            return "指标块缺少 metric/value/advice 字段"
    return None


def analyze(
    store: str | None,
    date_from: str,
    date_to: str,
    *,
    llm_chat=None,
) -> dict:
    """分析所选店铺+时间范围的广告数据，返回总览 + 指标建议块。

    成功: {"ok": True, "date_from", "date_to", "ad_finalized_date",
           "summary"(精确聚合数字), "overview", "blocks"[{metric,value,advice}]}
    无数据: {"ok": False, "reason": "no_data", "message"}
    LLM 失败: {"ok": False, "reason": "llm_error", "message"}
    结构无效: {"ok": False, "reason": "parse_error", "message"}
    """
    llm_chat = llm_chat or llm.chat
    summary = repository.ads_summary(store, date_from, date_to)
    trend = repository.ads_trend(store, date_from, date_to)
    top_items = repository.list_items(
        store=store, sort_by="ad_cost", date_from=date_from, date_to=date_to, page_size=5
    )["items"]

    cur = summary["current"] or {}
    has_data = any(cur.get(k) for k in ("cost", "sales", "clicks", "impressions"))
    if not has_data:
        return {
            "ok": False,
            "reason": "no_data",
            "message": "所选范围内没有广告数据（花费/点击/曝光/广告销售额均为 0），请调整店铺或时间范围",
            "date_from": date_from,
            "date_to": date_to,
            "ad_finalized_date": summary.get("ad_finalized_date", ""),
        }

    prompt = _build_prompt(summary, trend, top_items)
    try:
        raw = llm_chat(SYSTEM_PROMPT, [{"role": "user", "content": prompt}], json_mode=True)
    except llm.LLMError as e:
        return {"ok": False, "reason": "llm_error", "message": f"AI 分析失败：{e}"}

    err = _validate(raw)
    if err:
        return {"ok": False, "reason": "parse_error", "message": f"AI 分析结果格式异常：{err}"}

    return {
        "ok": True,
        "date_from": date_from,
        "date_to": date_to,
        "ad_finalized_date": summary.get("ad_finalized_date", ""),
        "summary": cur,  # 精确聚合数字（repository，非 LLM 生成），供前端渲染汇总行
        "overview": raw["overview"],
        "blocks": raw["blocks"],
    }
