"""ML 站内信接入层 — 售前提问(questions) / 售后消息(packs) / 发回复 / 订单·物流明细

对 ML 端点的 SDK 风格封装（每个操作一个方法，返回固定形状），
外部依赖（HTTP 客户端）在构造时注入，测试用同构假替身。

数据源分野：
- 售前 = 买家对商品的提问，走 Questions API（`/questions/search`，实测可用）
- 售后 = 订单买卖家私信，走 Messaging packs（新路径 `/marketplace/messages/*`，
  当前 app 缺 Messaging 模块权限返回 403，未启用）
"""

from __future__ import annotations

_PACKS_PATH = "/messaging/messages/packs"
_QUESTIONS_PATH = "/questions/search"


def _as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return v


class MessagingAPI:
    """消息接入层：包装 ML 客户端，屏蔽端点细节"""

    def __init__(self, client):
        self._client = client

    def list_packs(self, tag: str | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
        params = {"limit": limit, "offset": offset}
        if tag:
            params["tag"] = tag
        data = self._client.get(_PACKS_PATH, params=params)
        return data.get("results", []) if isinstance(data, dict) else list(data or [])

    def get_pack(self, pack_id: str) -> dict:
        return self._client.get(f"{_PACKS_PATH}/{pack_id}")

    def get_messages(self, pack_id: str) -> list[dict]:
        data = self._client.get(f"{_PACKS_PATH}/{pack_id}/messages")
        return data.get("messages", []) if isinstance(data, dict) else list(data or [])

    def send_message(self, pack_id: str, *, from_user_id, recipient_ids: list, text: str) -> dict:
        body = {
            "from": {"user_id": from_user_id},
            "to": [{"user_id": rid} for rid in recipient_ids],
            "text": text,
        }
        return self._client.post(f"{_PACKS_PATH}/{pack_id}/messages", json=body)

    def get_order(self, order_id: str) -> dict:
        return self._client.get(f"/orders/{order_id}")

    def get_shipment(self, shipment_id: str) -> dict:
        return self._client.get(f"/shipments/{shipment_id}")

    def get_my_user(self) -> dict:
        return self._client.get_my_user()

    # ---------- 售前：商品提问（Questions API） ----------

    def list_questions(self, status: str | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
        """拉本店收到的商品提问（自动翻页，数组字段名是 questions 不是 results）"""
        seller_id = self.get_my_user().get("id")
        out: list[dict] = []
        while True:
            params = {"seller_id": seller_id, "limit": limit, "offset": offset}
            if status:
                params["status"] = status
            data = self._client.get(_QUESTIONS_PATH, params=params)
            batch = (data.get("questions") if isinstance(data, dict) else None) or []
            out.extend(batch)
            if len(batch) < limit:
                break
            offset += limit
        return out

    def get_question(self, question_id) -> dict:
        return self._client.get(f"/questions/{question_id}")

    def answer_question(self, question_id, *, text: str) -> dict:
        """回答提问（写操作，真实发给买家）"""
        return self._client.post("/answers", json={"question_id": _as_int(question_id), "text": text})

    def get_item_description(self, item_id) -> str:
        """商品简介纯文本（独立端点，不在商品主接口里）；无简介或取不到返回空串"""
        data = self._client.get(f"/items/{item_id}/description")
        if not isinstance(data, dict):
            return ""
        return (data.get("plain_text") or data.get("text") or "").strip()


def pack_messages(api, pack: dict) -> list[dict]:
    """取一个 pack 的消息：优先 pack 内嵌 messages，缺省则单独拉取"""
    msgs = pack.get("messages")
    if not isinstance(msgs, list) or not msgs:
        msgs = api.get_messages(pack["id"])
    return msgs or []


def item_id_of(message: dict, pack: dict) -> str:
    """从消息/会话里提取关联商品 id（结构字段不确定，逐级防御）"""
    for src in (message, pack):
        iid = src.get("item_id") or src.get("itemId") or ""
        if not iid and isinstance(src.get("item"), dict):
            iid = src["item"].get("id") or ""
        if iid:
            return str(iid)
    return ""


def order_id_of(message: dict, pack: dict) -> str:
    for src in (message, pack):
        oid = src.get("order_id") or src.get("orderId") or ""
        if not oid and isinstance(src.get("order"), dict):
            oid = src["order"].get("id") or ""
        if oid:
            return str(oid)
    return ""


def message_author(message: dict, seller_user_id) -> str:
    """作者：买家/卖家（用于多轮历史标注）"""
    from_id = (message.get("from") or {}).get("user_id")
    return "卖家" if str(from_id) == str(seller_user_id) else "买家"


def question_id_of(row: dict) -> str:
    """从工作台行取 canonical 提问 id（售前用 question id 顶 pack_id 作线程 id）"""
    return str(row.get("pack_id") or row.get("message_id") or "")


def question_history(row: dict, seller_user_id) -> list[dict]:
    """售前历史：单轮问答 → 合成为「买家提问(+ 卖家回答)」两条气泡。

    仅当该行已回复（status=sent）时，draft 才是真实答复；待处理行的 draft 只是草稿，不计入历史。
    """
    items = [
        {
            "id": str(row.get("message_id") or ""),
            "from": {"user_id": row.get("sender_id")},
            "text": row.get("message_text") or "",
            "date_created": row.get("received_at") or "",
        }
    ]
    if row.get("status") == "sent" and row.get("draft"):
        items.append(
            {
                "id": f"answer_{row.get('message_id')}",
                "from": {"user_id": seller_user_id},
                "text": row["draft"],
                "date_created": "",
            }
        )
    return items
