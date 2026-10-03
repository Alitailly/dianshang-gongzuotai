"""飞书多维表格同步 — 凭证/子表/字段/记录（支持多店铺子表 + 增量 upsert）"""

from __future__ import annotations

import time
from pathlib import Path

import requests
from dotenv import dotenv_values

_CFG_PATH = Path(__file__).resolve().parent.parent.parent / "feishu.env"

_cfg = None
_token: str = ""
_token_expire: float = 0.0


def _config() -> dict:
    global _cfg
    if _cfg is None:
        _cfg = dotenv_values(str(_CFG_PATH))
    return _cfg


def get_token() -> str:
    """tenant_access_token（2h 过期，本地缓存，提前 60s 刷新）"""
    global _token, _token_expire
    now = time.time()
    if _token and now < _token_expire - 60:
        return _token
    cfg = _config()
    r = requests.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": cfg.get("FEISHU_APP_ID", ""), "app_secret": cfg.get("FEISHU_APP_SECRET", "")},
        timeout=15,
    )
    d = r.json()
    if d.get("code") != 0:
        raise RuntimeError(f"飞书获取 token 失败: {d.get('code')} {d.get('msg')}")
    _token = d["tenant_access_token"]
    _token_expire = now + int(d.get("expire", 7200))
    return _token


def _headers() -> dict:
    return {"Authorization": f"Bearer {get_token()}", "Content-Type": "application/json"}


def _app_url() -> str:
    cfg = _config()
    return f"https://open.feishu.cn/open-apis/bitable/v1/apps/{cfg.get('FEISHU_APP_TOKEN', '')}"


def _table_url(table_id: str) -> str:
    return f"{_app_url()}/tables/{table_id}"


def _check(d: dict) -> dict:
    if d.get("code") != 0:
        raise RuntimeError(f"飞书 API 错误: {d.get('code')} {d.get('msg')}")
    return d


# ---------- 子表 ----------

def list_tables() -> list[dict]:
    """返回 [{table_id, name}]"""
    r = requests.get(f"{_app_url()}/tables", headers=_headers(), timeout=15)
    return _check(r.json())["data"]["items"]


def get_table_id(name: str) -> str | None:
    for t in list_tables():
        if t["name"] == name:
            return t["table_id"]
    return None


def create_table(name: str, fields: list[dict]) -> str:
    """创建子表（含字段），返回 table_id"""
    r = requests.post(
        f"{_app_url()}/tables",
        headers=_headers(),
        json={"table": {"name": name, "fields": fields}},
        timeout=30,
    )
    return _check(r.json())["data"]["table_id"]


def ensure_table(name: str, fields: list[dict]) -> str:
    """子表不存在则创建（含字段），返回 table_id"""
    tid = get_table_id(name)
    if tid:
        return tid
    return create_table(name, fields)


# ---------- 字段 ----------

def list_fields(table_id: str) -> list[dict]:
    r = requests.get(f"{_table_url(table_id)}/fields", headers=_headers(), timeout=15)
    return _check(r.json())["data"]["items"]


def ensure_fields(table_id: str, fields: list[dict]) -> int:
    exist = {f["field_name"] for f in list_fields(table_id)}
    created = 0
    for f in fields:
        if f["field_name"] in exist:
            continue
        r = requests.post(f"{_table_url(table_id)}/fields", headers=_headers(), json=f, timeout=15)
        _check(r.json())
        created += 1
    return created


# ---------- 记录 ----------

def list_records(table_id: str) -> list[dict]:
    """返回 [{record_id, fields}]（全量分页）"""
    out = []
    page_token = ""
    while True:
        params = {"page_size": 500}
        if page_token:
            params["page_token"] = page_token
        r = requests.get(f"{_table_url(table_id)}/records", headers=_headers(), params=params, timeout=15)
        d = _check(r.json())["data"]
        out.extend(d.get("items", []))
        if not d.get("has_more"):
            break
        page_token = d.get("page_token", "")
    return out


def create_records(table_id: str, records: list[dict]) -> int:
    """批量插入（每批 ≤500）。records: [{字段名: 值}]"""
    n = 0
    for i in range(0, len(records), 500):
        chunk = [{"fields": rec} for rec in records[i : i + 500]]
        r = requests.post(
            f"{_table_url(table_id)}/records/batch_create",
            headers=_headers(),
            json={"records": chunk},
            timeout=60,
        )
        _check(r.json())
        n += len(chunk)
    return n


def update_records(table_id: str, records: list[dict]) -> int:
    """批量更新（每批 ≤500）。records: [{record_id, fields}]"""
    n = 0
    for i in range(0, len(records), 500):
        chunk = records[i : i + 500]
        r = requests.post(
            f"{_table_url(table_id)}/records/batch_update",
            headers=_headers(),
            json={"records": chunk},
            timeout=60,
        )
        _check(r.json())
        n += len(chunk)
    return n


def delete_records(table_id: str, record_ids: list[str]) -> int:
    n = 0
    for i in range(0, len(record_ids), 500):
        chunk = record_ids[i : i + 500]
        r = requests.post(
            f"{_table_url(table_id)}/records/batch_delete",
            headers=_headers(),
            json={"records": chunk},
            timeout=30,
        )
        _check(r.json())
        n += len(chunk)
    return n
