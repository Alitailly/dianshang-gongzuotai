"""站内信消息工作台接口 — 列消息 / 会话历史 / 生成草稿 / 确认发送 / 跳过"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body

from .. import message_queue
from ..messages import MessagingAPI

router = APIRouter(prefix="/api/messages", tags=["messages"])


def _api_for(store_name: str) -> MessagingAPI:
    """按店铺显示名（STORE_NAME，即库里的 store 标识）反查配置构造接入层（含 token 刷新）"""
    from src.store import Store, list_stores

    store = None
    for name in list_stores():
        s = Store(name)
        if s.display_name == store_name:
            store = s
            break
    if store is None:
        raise ValueError(f"未知店铺: {store_name}")
    try:
        store.refresh_token()
    except Exception:  # noqa: BLE001
        pass
    return MessagingAPI(store.client)


def _row_api(row_id: int) -> MessagingAPI | None:
    row = message_queue.get_row(row_id)
    if not row:
        return None
    return _api_for(row["store"])


@router.get("")
def list_msgs(
    store: Optional[str] = None,
    tag: Optional[str] = None,
    status: Optional[str] = None,
):
    return {"items": message_queue.list_messages(store=store, tag=tag, status=status)}


@router.post("/sync")
def sync_messages(store: Optional[str] = None):
    """手动触发从美客多拉取新提问入库（不生成草稿，草稿由页面按钮触发）。

    store 为店铺显示名（STORE_NAME）；不传则同步全部店铺。同步执行并返回汇总。
    """
    from src.store import Store, list_stores

    if store:
        names = [store]
    else:
        names = [Store(n).display_name for n in list_stores()]
    keys = ("new", "failed")
    total = {k: 0 for k in keys}
    per = []
    for name in names:
        try:
            api = _api_for(name)
            r = message_queue.ingest(api, store=name)
            per.append({"store": name, **{k: r.get(k, 0) for k in keys}})
            for k in keys:
                total[k] += r.get(k, 0)
        except Exception as e:  # noqa: BLE001
            per.append({"store": name, "error": str(e)})
    return {"ok": True, **total, "stores": per}


@router.get("/{msg_id}")
def get_msg(msg_id: int):
    row = message_queue.get_row(msg_id)
    if not row:
        return {"ok": False, "message": "消息不存在"}
    return message_queue.get_message_with_history(msg_id, _api_for(row["store"]))


@router.post("/{msg_id}/draft")
def gen_draft(msg_id: int):
    api = _row_api(msg_id)
    if api is None:
        return {"ok": False, "message": "消息不存在"}
    return message_queue.generate_draft(msg_id, api)


@router.post("/{msg_id}/send")
def send_msg(msg_id: int, draft: Optional[str] = Body(None, embed=True)):
    """人审确认发送；draft 为人审编辑后的草稿（编辑回写，缺省用库内草稿）

    embed=True：前端发 JSON 对象 {"draft": "..."}（与 generateDraft 等对齐），
    缺省裸标量体会被 FastAPI 判 422。"""
    api = _row_api(msg_id)
    if api is None:
        return {"ok": False, "message": "消息不存在"}
    return message_queue.send_reply(msg_id, api, draft=draft)


@router.post("/{msg_id}/skip")
def skip_msg(msg_id: int):
    return message_queue.skip(msg_id)
