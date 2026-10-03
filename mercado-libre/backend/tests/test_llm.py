"""接缝①：LLM 客户端 — fake HTTP 下验证请求组装、JSON 解析、统一错误语义

只测 llm 模块对外契约（输入 system_prompt+messages → 输出文本/结构化对象/LLM 错误），
不测内部实现；外部依赖（HTTP）在边界处注入。
"""

from __future__ import annotations

import json

import pytest

from app import llm


class _Resp:
    def __init__(self, status: int, data: dict):
        self.status_code = status
        self._data = data

    def json(self) -> dict:
        return self._data


def _fake_http(captured: dict, *, status: int = 200, content: str = "回复"):
    def http(url: str, payload: dict, headers: dict, timeout: float):
        captured["url"] = url
        captured["payload"] = payload
        captured["headers"] = headers
        return _Resp(status, {"choices": [{"message": {"content": content}}]})

    return http


def test_chat_sends_system_prompt_and_messages():
    captured = {}
    result = llm.chat(
        "你是广告分析师",
        [{"role": "user", "content": "请分析"}],
        http=_fake_http(captured),
        model="test-model",
    )
    assert result == "回复"
    assert captured["payload"]["model"] == "test-model"
    assert captured["payload"]["messages"] == [
        {"role": "system", "content": "你是广告分析师"},
        {"role": "user", "content": "请分析"},
    ]
    assert captured["url"].endswith("/chat/completions")


def test_chat_json_mode_parses_content_into_object():
    captured = {}
    body = json.dumps({"overview": "表现良好"}, ensure_ascii=False)
    result = llm.chat(
        "s", [], http=_fake_http(captured, content=body), json_mode=True
    )
    assert result == {"overview": "表现良好"}
    assert captured["payload"]["response_format"] == {"type": "json_object"}


def test_chat_json_mode_raises_parse_error_on_invalid_json():
    with pytest.raises(llm.LLMParseError):
        llm.chat("s", [], http=_fake_http(captured={}, content="不是 JSON"), json_mode=True)


def test_chat_raises_timeout_error():
    def http(url, payload, headers, timeout):
        raise TimeoutError("连接超时")

    with pytest.raises(llm.LLMTimeoutError):
        llm.chat("s", [], http=http)


def test_chat_raises_rate_limit_error_on_429():
    def http(url, payload, headers, timeout):
        return _Resp(429, {})

    with pytest.raises(llm.LLMRateLimitError):
        llm.chat("s", [], http=http)


def test_chat_raises_http_error_on_5xx():
    def http(url, payload, headers, timeout):
        return _Resp(500, {})

    with pytest.raises(llm.LLMHTTPError):
        llm.chat("s", [], http=http)


def test_chat_raises_http_error_on_connection_failure():
    def http(url, payload, headers, timeout):
        raise ConnectionError("网络不可达")

    with pytest.raises(llm.LLMHTTPError):
        llm.chat("s", [], http=http)


def test_chat_raises_parse_error_when_response_missing_content():
    def http(url, payload, headers, timeout):
        return _Resp(200, {"choices": []})

    with pytest.raises(llm.LLMParseError):
        llm.chat("s", [], http=http)


def test_chat_without_key_and_without_injected_http_raises_config_error(monkeypatch):
    """没有配置 key 且没有注入 http → 明确配置错误，不是静默失败（也不许偷偷打真实 API）"""
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(llm, "_config", lambda: {})
    with pytest.raises(llm.LLMError):
        llm.chat("s", [], http=None)
