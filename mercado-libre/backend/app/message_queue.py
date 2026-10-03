"""站内信消息工作台 — 待审队列（SQLite 状态机）+ 草稿生成（tag 分流）

状态机：new（待生成/生成失败）→ draft（待人工审）→ sent / skipped（终态，不可回改）。
人审闸门：任何发送都由 send_reply 触发（只来自人工确认），系统不自动发送。
外部依赖（ML 消息接入层、LLM）在边界注入，测试用假替身。
"""

from __future__ import annotations

from datetime import datetime

from . import db, llm, messages, repository

# 售后消息数据源：新路径 /marketplace/messages/* 当前 app 缺 Messaging 模块权限（403），
# 未启用；售前（Questions API）已可正常拉取。
_POST_SALE_ENABLED = False

# 商品简介注入草稿提示词的最大字符数（防御超长简介撑爆上下文；实测商品均 < 3200）
_DESCRIPTION_MAX_CHARS = 4000

DRAFT_SYSTEM = """你是美客多巴西站（MLB）卖家的客服助手。你根据买家消息、上下文（商品/订单信息）和对话历史起草给买家的回复。
要求：
- 回复使用巴西葡萄牙语，语气专业、友好、简洁
- 只输出回复正文，不要任何解释、前缀、引号或语气词
- 信息不足时如实说明，不要编造物流/库存信息"""


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _row_dict(row) -> dict:
    return dict(row)


def _get_row(row_id: int) -> dict | None:
    conn = db.get_conn()
    row = conn.execute(
        "SELECT * FROM message_workbench WHERE id = ?", (row_id,)
    ).fetchone()
    conn.close()
    return _row_dict(row) if row else None


def get_row(row_id: int) -> dict | None:
    """单条队列消息（供路由等外部调用，_get_row 为内部快捷）"""
    return _get_row(row_id)


def _set_status(row_id: int, status: str) -> None:
    conn = db.get_conn()
    conn.execute(
        "UPDATE message_workbench SET status = ?, updated_at = ? WHERE id = ?",
        (status, _now(), row_id),
    )
    conn.commit()
    conn.close()


def _as_user_id(v) -> int | str:
    try:
        return int(v)
    except (TypeError, ValueError):
        return v


def _pre_sale_context(api, item_id: str) -> str:
    """售前上下文 = 商品信息（product_variation 当前值）+ 商品简介（实时拉取）

    简介是独立端点内容，取不到（网络/无简介）时降级为不带简介、不阻断草稿。
    """
    p = repository.get_product(item_id) if item_id else None
    if not p:
        return "（未能定位到商品信息）"
    parts = [
        f"商品：{p.get('title') or item_id}",
        f"价格：{p.get('price')} {p.get('currency_id')}",
        f"库存：{p.get('available_quantity')}",
        f"平台运费：{p.get('platform_shipping')}",
        f"运费承担：{p.get('shipping_payer')}",
    ]
    try:
        desc = api.get_item_description(item_id) if item_id else ""
    except Exception:  # noqa: BLE001 — 简介拉取失败不阻断草稿
        desc = ""
    if desc:
        parts.append(f"商品简介：\n{desc[:_DESCRIPTION_MAX_CHARS]}")
    return "\n".join(parts)


def _post_sale_context(api, order_id: str) -> str:
    """售后上下文 = 订单/物流实时查询（复用单订单/单物流封装，非聚合）"""
    parts = []
    if order_id:
        try:
            order = api.get_order(order_id)
            if order:
                parts.append(f"订单 {order_id}：状态 {order.get('status')}，下单时间 {order.get('date_created')}")
                shipment_id = (order.get("shipping") or {}).get("id")
                if shipment_id:
                    try:
                        ship = api.get_shipment(shipment_id)
                        if ship:
                            parts.append(
                                f"物流 {shipment_id}：状态 {ship.get('status')}，运单号 {ship.get('tracking_number')}"
                            )
                    except Exception:  # noqa: BLE001 — 物流查询失败不阻断草稿
                        parts.append(f"物流 {shipment_id}：查询失败")
        except Exception:  # noqa: BLE001
            parts.append(f"订单 {order_id}：查询失败")
    return "\n".join(parts) if parts else "（未能定位到订单/物流信息）"


def _draft_user_prompt(row: dict, context: str, history: list[dict], seller_user_id) -> str:
    tag_label = "售前咨询" if row["tag"] == "pre_sale" else "售后问题"
    lines = [
        f"消息类型：{tag_label}",
        f"买家消息：{row['message_text']}",
        f"上下文：\n{context}",
    ]
    if history:
        lines.append("对话历史（旧→新）：")
        for m in history:
            lines.append(f"- {messages.message_author(m, seller_user_id)}: {m.get('text') or ''}")
    lines.append("请给出回复正文（巴西葡萄牙语）：")
    return "\n".join(lines)


def _generate(row: dict, api, llm_chat) -> dict:
    """生成一条草稿并落库（仅由人工点击「生成草稿」触发，不在拉取时批量跑）"""
    tag = row["tag"]
    if tag == "pre_sale":
        context = _pre_sale_context(api, row.get("item_id") or "")
    else:
        context = _post_sale_context(api, row.get("order_id") or "")
    history = []
    seller_user_id = api.get_my_user().get("id")
    if tag == "pre_sale":
        # 售前为单轮提问，买家消息已在 prompt 里，无历史可言（避免重复）
        history = []
    else:
        try:
            history = messages.pack_messages(api, api.get_pack(row["pack_id"]))
        except Exception:  # noqa: BLE001 — 历史拉不到不阻断，上下文里没有历史
            history = []
    prompt = _draft_user_prompt(row, context, history, seller_user_id)
    try:
        draft = llm_chat(DRAFT_SYSTEM, [{"role": "user", "content": prompt}])
    except Exception as e:  # noqa: BLE001 — 外部 LLM 依赖任何失败都不崩溃，保持 new 可重试
        return {"ok": False, "message": f"草稿生成失败：{e}"}
    if not draft or not draft.strip():
        return {"ok": False, "message": "草稿生成失败：LLM 返回为空"}
    conn = db.get_conn()
    conn.execute(
        "UPDATE message_workbench SET draft = ?, status = 'draft', updated_at = ? WHERE id = ?",
        (draft.strip(), _now(), row["id"]),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "message": "草稿已生成", "draft": draft.strip()}


# ---------- 对外服务 ----------

_INSERT_SQL = """
INSERT OR IGNORE INTO message_workbench
    (store, pack_id, message_id, tag, sender_id, sender_name,
     message_text, item_id, order_id, received_at, draft, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _promote_answered(conn, store: str, message_id: str, answer_text: str) -> None:
    """本地仍是待处理的提问，若卖家已在 ML 后台回复（拉取时 status 变 ANSWERED）→ 提升为 sent"""
    conn.execute(
        """
        UPDATE message_workbench
           SET status = 'sent', draft = ?, updated_at = ?
         WHERE store = ? AND message_id = ? AND status NOT IN ('sent', 'skipped')
        """,
        (answer_text, _now(), store, message_id),
    )


def _ingest_pre_sale(api, conn, store: str, now: str, result: dict) -> None:
    """售前 = 商品提问（Questions API）。未回复 → new（待人审）；已回复 → sent（只读问答记录）"""
    try:
        questions = api.list_questions()
    except Exception:  # noqa: BLE001
        result["failed"] += 1
        return
    for q in questions:
        qid = q.get("id")
        if not qid:
            continue
        answered = q.get("status") == "ANSWERED"
        ans = q.get("answer") or {}
        from_ = q.get("from") or {}
        cur = conn.execute(
            _INSERT_SQL,
            (
                store,
                str(qid),
                str(qid),
                "pre_sale",
                str(from_.get("id") or ""),
                from_.get("name") or "",
                q.get("text") or "",
                str(q.get("item_id") or ""),
                "",
                q.get("date_created") or "",
                (ans.get("text") or "") if answered else None,
                "sent" if answered else "new",
                now,
                now,
            ),
        )
        if cur.rowcount > 0:
            result["new"] += 1
        elif answered:
            # 本地已有该行（可能仍是待处理）→ 卖家已在 ML 后台回复，提升为终态
            _promote_answered(conn, store, str(qid), ans.get("text") or "")


def _ingest_post_sale(api, conn, store: str, now: str, result: dict, seller_uid) -> None:
    """售后 = 订单私信（Messaging packs）。默认关闭，需 app 开通 Messaging 权限后启用"""
    try:
        packs = api.list_packs(tag="post_sale")
    except Exception:  # noqa: BLE001
        result["failed"] += 1
        return
    for pack in packs:
        try:
            msgs = messages.pack_messages(api, pack)
        except Exception:  # noqa: BLE001
            result["failed"] += 1
            continue
        for msg in msgs:
            msg_id = msg.get("id")
            if not msg_id:
                continue
            from_ = msg.get("from") or {}
            # 只收买家消息；卖家自己发的回复只出现在 pack 历史（多轮上下文）里
            if str(from_.get("user_id")) == str(seller_uid):
                continue
            cur = conn.execute(
                _INSERT_SQL,
                (
                    store,
                    str(pack.get("id")),
                    str(msg_id),
                    pack.get("tag") or "post_sale",
                    str(from_.get("user_id") or ""),
                    from_.get("name") or "",
                    msg.get("text") or "",
                    messages.item_id_of(msg, pack),
                    messages.order_id_of(msg, pack),
                    msg.get("date_created") or "",
                    None,
                    "new",
                    now,
                    now,
                ),
            )
            if cur.rowcount > 0:
                result["new"] += 1


def ingest(api, *, store: str) -> dict:
    """拉取新消息入库（按消息 id 去重）。不生成草稿——草稿只由人工点击触发。

    售前从 Questions API 拉取；售后（packs）默认关闭（app 缺权限）。
    已回复的提问入库为 sent（只读展示问答记录），未回复的为 new（待人审）。
    api: MessagingAPI 或同构 fake。
    返回 {"new": 新增行数, "failed": 拉取失败数}。
    """
    now = _now()
    result = {"new": 0, "failed": 0}
    seller_uid = api.get_my_user().get("id")
    conn = db.get_conn()
    try:
        _ingest_pre_sale(api, conn, store, now, result)
        if _POST_SALE_ENABLED:
            _ingest_post_sale(api, conn, store, now, result, seller_uid)
        conn.commit()
    finally:
        conn.close()
    return result


def list_messages(store: str | None = None, tag: str | None = None, status: str | None = None) -> list[dict]:
    """列工作台消息。不传 status → 返回全部状态（前端按状态下拉分类查看）"""
    where, params = [], []
    if store:
        where.append("store = ?")
        params.append(store)
    if tag:
        where.append("tag = ?")
        params.append(tag)
    if status:
        where.append("status = ?")
        params.append(status)
    sql = (
        "SELECT * FROM message_workbench"
        + (f" WHERE {' AND '.join(where)}" if where else "")
        + " ORDER BY id DESC"
    )
    conn = db.get_conn()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [_row_dict(r) for r in rows]


def get_message_with_history(row_id: int, api) -> dict:
    """单条队列消息 + 对话历史（售前=提问/回答，售后=pack 多轮，实时拉取）"""
    row = _get_row(row_id)
    if not row:
        return {"ok": False, "message": "消息不存在"}
    seller_uid = api.get_my_user().get("id")
    if row["tag"] == "pre_sale":
        history = messages.question_history(row, seller_uid)
    else:
        try:
            history = messages.pack_messages(api, api.get_pack(row["pack_id"]))
        except Exception:  # noqa: BLE001
            history = []
    annotated = []
    for m in history:
        d = dict(m)
        if isinstance(d.get("from"), dict):
            d["_author"] = "卖家" if str(d["from"].get("user_id")) == str(seller_uid) else "买家"
        else:
            d["_author"] = "未知"
        annotated.append(d)
    return {"ok": True, "message": row, "item": row, "history": annotated}


def generate_draft(row_id: int, api, llm_chat=None) -> dict:
    """手动重试生成草稿（new/draft 可生成，终态不可）"""
    row = _get_row(row_id)
    if not row:
        return {"ok": False, "message": "消息不存在"}
    if row["status"] in ("sent", "skipped"):
        return {"ok": False, "message": "消息已是终态，不可再生成草稿"}
    return _generate(row, api, llm_chat or llm.chat)


def send_reply(row_id: int, api, draft: str | None = None) -> dict:
    """人审确认后发回买家（仅人工触发；终态不可回改）。

    draft 为人审编辑后的草稿（网页编辑回写），非空则以它为准发送并落库；
    不传时用 DB 里已有的草稿。
    """
    row = _get_row(row_id)
    if not row:
        return {"ok": False, "message": "消息不存在"}
    if row["status"] in ("sent", "skipped"):
        return {"ok": False, "message": "消息已是终态，不可再次发送"}
    text = draft.strip() if draft else (row["draft"] or "")
    if not text:
        return {"ok": False, "message": "没有草稿，请先生成草稿"}
    if not row["sender_id"]:
        return {"ok": False, "message": "缺少收件人信息，无法发送"}
    if draft and draft.strip():
        conn = db.get_conn()
        conn.execute(
            "UPDATE message_workbench SET draft = ?, updated_at = ? WHERE id = ?",
            (text, _now(), row_id),
        )
        conn.commit()
        conn.close()
    if row["tag"] == "pre_sale":
        api.answer_question(messages.question_id_of(row), text=text)
    else:
        from_user_id = api.get_my_user().get("id")
        api.send_message(
            row["pack_id"],
            from_user_id=from_user_id,
            recipient_ids=[_as_user_id(row["sender_id"])],
            text=text,
        )
    _set_status(row_id, "sent")
    return {"ok": True, "message": "回复已发送"}


def skip(row_id: int) -> dict:
    row = _get_row(row_id)
    if not row:
        return {"ok": False, "message": "消息不存在"}
    if row["status"] == "sent":
        return {"ok": False, "message": "消息已发送，不可跳过"}
    if row["status"] == "skipped":
        return {"ok": False, "message": "消息已跳过"}
    _set_status(row_id, "skipped")
    return {"ok": True, "message": "已跳过"}
