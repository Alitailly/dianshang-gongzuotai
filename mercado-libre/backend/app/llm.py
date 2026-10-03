"""DeepSeek LLM 底座 — 统一「系统提示 + 消息列表 → 文本/结构化对象」接口

key 从项目根 .env 的 DEEPSEEK_API_KEY 或环境变量读取，前端永不接触；
超时/限流/解析失败有统一错误语义（全部派生自 LLMError），调用方按类捕获即可。
HTTP 边界可注入（http 参数），测试用 fake 替身，不花真实额度。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import dotenv_values

BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"

# 项目根 .env（与 feishu.env 同目录）
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


class LLMError(Exception):
    """LLM 调用失败基类"""


class LLMTimeoutError(LLMError):
    """请求超时"""


class LLMRateLimitError(LLMError):
    """限流（429）"""


class LLMHTTPError(LLMError):
    """HTTP/连接错误"""


class LLMParseError(LLMError):
    """响应解析失败（非 JSON / 缺内容）"""


def _config() -> dict:
    return dotenv_values(str(_ENV_PATH))


def api_key() -> str:
    return os.environ.get("DEEPSEEK_API_KEY", "") or _config().get("DEEPSEEK_API_KEY", "")


def default_model() -> str:
    return os.environ.get("DEEPSEEK_MODEL", "") or _config().get("DEEPSEEK_MODEL", "") or DEFAULT_MODEL


def _http_post(url: str, payload: dict, headers: dict, timeout: float):
    """默认 HTTP 实现：requests 直连 DeepSeek；超时归一为内置 TimeoutError 便于上层统一捕获"""
    import requests

    try:
        return requests.post(url, json=payload, headers=headers, timeout=timeout)
    except requests.exceptions.Timeout:
        raise TimeoutError("LLM 请求超时") from None


def chat(
    system_prompt: str,
    messages: list[dict],
    *,
    http=None,
    model: str | None = None,
    temperature: float = 0.3,
    json_mode: bool = False,
    timeout: float = 60,
) -> str | dict:
    """给系统提示 + 消息列表 → 返回文本；json_mode=True 时解析 content 为对象返回。

    http 可注入（测试替身），签名 http(url, payload, headers, timeout) -> 带 .status_code/.json() 的对象。
    """
    key = api_key()
    if http is None and not key:
        raise LLMError("未配置 DEEPSEEK_API_KEY（项目根 .env 的 DEEPSEEK_API_KEY 或环境变量）")
    if http is None:
        http = _http_post

    payload: dict = {
        "model": model or default_model(),
        "messages": [{"role": "system", "content": system_prompt}, *messages],
        "temperature": temperature,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    try:
        resp = http(f"{BASE_URL}/chat/completions", payload, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, timeout)
    except TimeoutError as e:
        raise LLMTimeoutError(str(e)) from None
    except Exception as e:  # noqa: BLE001 — 连接等未知失败统一归 HTTP 错误
        raise LLMHTTPError(f"LLM 请求失败: {e}") from None

    if resp.status_code == 429:
        raise LLMRateLimitError("LLM 限流（429），请稍后重试")
    if resp.status_code >= 400:
        raise LLMHTTPError(f"LLM HTTP {resp.status_code}")
    try:
        data = resp.json()
    except (TypeError, ValueError) as e:
        raise LLMParseError(f"LLM 响应非 JSON: {e}") from None

    content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
    if not content:
        raise LLMParseError("LLM 响应缺少内容")
    if not json_mode:
        return content
    try:
        return json.loads(content)
    except (TypeError, ValueError) as e:
        raise LLMParseError(f"LLM 返回内容非 JSON: {e}") from None
