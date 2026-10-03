"""接缝③：消息工作台服务 — fake ML 客户端 + fake LLM + 真实 SQLite 表

验证状态流（收 → new；人工点「生成草稿」→ draft；确认发送/跳过 → 终态）、
售前(Questions)/售后(packs)数据源分流、待审队列持久化。只测服务对外行为
（ingest / list / generate_draft / send_reply / skip），外部依赖在边界注入。

关键约定：ingest 只入库不生成草稿（草稿消耗 LLM token，必须人工触发）；
已回复提问入库为 sent（只读问答记录），列表按状态分类、默认返回全部。
"""

from __future__ import annotations

import pytest

from app import message_queue
from conftest import seed_snapshot


class FakeMessagingAPI:
    """SDK 风格假替身：每个操作返回固定形状，无条件分支

    售前走 list_questions / answer_question（Questions API）；
    售后走 list_packs / get_messages / send_message（Messaging packs）。
    """

    def __init__(self, packs=(), pack_messages=None, orders=None, shipments=None, questions=(), descriptions=None):
        self._packs = list(packs)
        self._pack_messages = pack_messages or {}
        self._orders = orders or {}
        self._shipments = shipments or {}
        self._questions = list(questions)
        self._descriptions = descriptions or {}
        self.sent = []
        self.answered = []
        self.list_packs_calls = 0
        self.list_questions_calls = 0

    # ---- 售前：Questions ----
    def list_questions(self, status=None, limit=50, offset=0):
        self.list_questions_calls += 1
        qs = self._questions
        if status:
            qs = [q for q in qs if q.get("status") == status]
        return list(qs[offset : offset + limit])

    def get_question(self, question_id):
        return next((q for q in self._questions if str(q["id"]) == str(question_id)), {})

    def answer_question(self, question_id, *, text):
        self.answered.append({"question_id": question_id, "text": text})
        return {"id": f"ans_{len(self.answered)}"}

    def get_item_description(self, item_id):
        return self._descriptions.get(str(item_id), "")

    # ---- 售后：Messaging packs ----
    def list_packs(self, tag=None, limit=50, offset=0):
        self.list_packs_calls += 1
        if tag is None:
            return list(self._packs)
        return [p for p in self._packs if p.get("tag") == tag]

    def get_pack(self, pack_id):
        return next(p for p in self._packs if p["id"] == pack_id)

    def get_messages(self, pack_id):
        return list(self._pack_messages.get(pack_id, []))

    def get_order(self, order_id):
        return self._orders.get(order_id, {})

    def get_shipment(self, shipment_id):
        return self._shipments.get(shipment_id, {})

    def get_my_user(self):
        return {"id": 999}

    def send_message(self, pack_id, *, from_user_id, recipient_ids, text):
        self.sent.append({"pack_id": pack_id, "from": from_user_id, "to": recipient_ids, "text": text})
        return {"id": f"sent_{len(self.sent)}"}


def _fake_llm(captured: dict, text: str = "Olá! Podemos ajudar."):
    def llm_chat(system_prompt: str, messages: list[dict], **kwargs):
        captured["system"] = system_prompt
        captured["user"] = messages[0]["content"]
        return text

    return llm_chat


def _pre_sale_api():
    """一个未回复提问（UNANSWERED，含 item_id）+ 一个已回复提问（ANSWERED）"""
    questions = [
        {
            "id": 1001,
            "status": "UNANSWERED",
            "item_id": "MLB1",
            "date_created": "2026-09-01T10:00:00",
            "from": {"id": 123},
            "text": "Este produto tem estoque?",
            "answer": None,
        },
        {
            "id": 1002,
            "status": "ANSWERED",
            "item_id": "MLB1",
            "date_created": "2026-09-01T09:00:00",
            "from": {"id": 124},
            "text": "Faz desconto?",
            "answer": {"text": "Sim, 5% de desconto.", "status": "ACTIVE"},
        },
    ]
    return FakeMessagingAPI(questions=questions)


def _post_sale_api():
    """一个售后 pack：买家问订单物流（含 order_id）"""
    pack = {"id": "P2", "tag": "post_sale", "status": "unanswered"}
    msgs = {
        "P2": [
            {"id": "M0", "from": {"user_id": 999, "name": "卖家"},
             "text": "Obrigado pela compra!", "date_created": "2026-09-01T09:00:00"},
            {"id": "M1", "from": {"user_id": "123", "name": "买家A"},
             "text": "Quando meu pedido será enviado?", "order_id": "O1",
             "date_created": "2026-09-01T10:00:00"},
        ]
    }
    orders = {"O1": {"id": "O1", "status": "paid", "date_created": "2026-08-30",
                     "shipping": {"id": "S1", "status": "ready_to_ship"}}}
    shipments = {"S1": {"id": "S1", "status": "ready_to_ship", "tracking_number": "TRACK1"}}
    return FakeMessagingAPI([pack], msgs, orders, shipments)


def _seed_product(tmp_db):
    seed_snapshot(
        tmp_db,
        [{"store": "BA05", "item_id": "MLB1", "title": "商品A", "price": 99.9,
          "available_quantity": 5, "currency_id": "BRL", "shipping_payer": "seller",
          "platform_shipping": 15.0}],
        table="product_variation",
        columns=["store", "item_id", "title", "price", "available_quantity",
                 "currency_id", "shipping_payer", "platform_shipping"],
    )


def _row_by_msg(message_id, store="BA05"):
    return next(r for r in message_queue.list_messages(store=store) if r["message_id"] == message_id)


# ---------- 收 → 草稿 ----------

def test_ingest_does_not_generate_draft(tmp_db):
    """拉取只入库，不生成草稿（草稿由人工点击触发，避免批量烧 token）"""
    api = _pre_sale_api()
    r = message_queue.ingest(api, store="BA05")
    assert r["new"] == 2  # 未回复 1001 + 已回复 1002 都入库
    assert "drafted" not in r
    row = _row_by_msg("1001")
    assert row["status"] == "new"
    assert row["tag"] == "pre_sale"
    assert not row["draft"]
    assert row["pack_id"] == "1001"  # 售前用 question id 顶 pack_id 作线程 id


def test_ingest_dedups_by_message_id(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    message_queue.ingest(api, store="BA05")
    assert len(message_queue.list_messages(store="BA05")) == 2  # 1001/1002 各一条，不重复


def test_pre_sale_draft_context_uses_product_info(tmp_db):
    _seed_product(tmp_db)
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    captured = {}
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm(captured))
    # 售前草稿上下文必须来自商品表（标题/价格/库存）
    assert "商品A" in captured["user"]
    assert "99.9" in captured["user"]


def test_pre_sale_draft_context_includes_item_description(tmp_db):
    """商品简介（独立端点实时拉取）必须注入草稿上下文"""
    _seed_product(tmp_db)
    api = _pre_sale_api()
    api._descriptions["MLB1"] = "Compatível com Creta 2021. Fabricada em aço inox."
    message_queue.ingest(api, store="BA05")
    captured = {}
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm(captured))
    assert "Compatível com Creta 2021" in captured["user"]


def test_pre_sale_description_failure_does_not_block_draft(tmp_db):
    """简介端点挂了 → 降级为不带简介，商品信息与草稿照常"""
    _seed_product(tmp_db)
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")

    def boom(item_id):
        raise RuntimeError("简介端点 500")

    api.get_item_description = boom
    captured = {}
    mid = _row_by_msg("1001")["id"]
    r = message_queue.generate_draft(mid, api, _fake_llm(captured, "ok"))
    assert r["ok"] is True
    assert "商品A" in captured["user"]  # 商品信息仍在，草稿未被阻断
    assert "商品简介" not in captured["user"]  # 未注入空简介


def test_pre_sale_context_truncates_long_description(tmp_db):
    """超长简介按 _DESCRIPTION_MAX_CHARS 截断（边界不多不少）"""
    _seed_product(tmp_db)
    api = _pre_sale_api()
    api._descriptions["MLB1"] = "X" * (message_queue._DESCRIPTION_MAX_CHARS + 500)
    injected = message_queue._pre_sale_context(api, "MLB1").split("商品简介：\n", 1)[1]
    assert len(injected) == message_queue._DESCRIPTION_MAX_CHARS


def test_pre_sale_answered_maps_to_sent(tmp_db):
    """已回复提问入库为 sent，草稿位存卖家答复（抽屉按「客户问题与回复」只读展示）"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    row = _row_by_msg("1002")
    assert row["status"] == "sent"
    assert row["draft"] == "Sim, 5% de desconto."


def test_list_shows_all_statuses_and_filters(tmp_db):
    """列表默认返回全部状态（前端按状态下拉分类）；status 过滤仍精确生效"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    assert {r["status"] for r in message_queue.list_messages(store="BA05")} == {"new", "sent"}
    assert [r["message_id"] for r in message_queue.list_messages(store="BA05", status="new")] == ["1001"]
    assert [r["message_id"] for r in message_queue.list_messages(store="BA05", status="sent")] == ["1002"]


def test_sent_row_stays_visible_and_terminal(tmp_db):
    """人工发送后行仍可查（「已发送」分类里能看到），且终态不可再改"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm({}, "ok"))
    message_queue.send_reply(mid, api)
    assert message_queue.get_row(mid)["status"] == "sent"
    sent_ids = [r["id"] for r in message_queue.list_messages(store="BA05", status="sent")]
    assert mid in sent_ids  # 「已发送」分类里能看到（1002 是随拉取入库的另一条已回复提问）


def test_post_sale_disabled_by_default(tmp_db):
    api = _post_sale_api()
    r = message_queue.ingest(api, store="BA05")
    assert api.list_packs_calls == 0  # 售后数据源默认关闭（app 缺 Messaging 权限）
    assert r["failed"] == 0
    assert message_queue.list_messages(store="BA05") == []


def test_post_sale_draft_context_uses_order_and_history(tmp_db, monkeypatch):
    monkeypatch.setattr(message_queue, "_POST_SALE_ENABLED", True)
    api = _post_sale_api()
    message_queue.ingest(api, store="BA05")
    captured = {}
    mid = _row_by_msg("M1")["id"]
    message_queue.generate_draft(mid, api, _fake_llm(captured))
    # 售后草稿上下文必须含订单/物流信息 + pack 内完整历史（多轮）
    assert "O1" in captured["user"]
    assert "TRACK1" in captured["user"]
    assert "Obrigado pela compra" in captured["user"]


# ---------- 状态流转：草稿 → 发送 / 跳过（终态不可回改） ----------

def test_send_reply_pre_sale_calls_answers_endpoint(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm({}, "Sim, temos estoque!"))
    r = message_queue.send_reply(mid, api)
    assert r["ok"] is True
    assert message_queue.get_row(mid)["status"] == "sent"
    assert len(api.answered) == 1
    assert str(api.answered[0]["question_id"]) == "1001"
    assert api.answered[0]["text"] == "Sim, temos estoque!"
    assert api.sent == []  # 售前不走 messages 发送


def test_send_reply_is_terminal(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm({}, "draft"))
    message_queue.send_reply(mid, api)
    r = message_queue.send_reply(mid, api)
    assert r["ok"] is False
    assert len(api.answered) == 1  # 不重复发送


def test_send_reply_uses_edited_draft(tmp_db):
    """人审编辑回写：send_reply 传入编辑后的草稿 → 发送内容与落库都用编辑后文本"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm({}, "Sim, temos estoque!"))
    edited = "Sim, temos estoque! Entrega em 3 dias úteis."
    r = message_queue.send_reply(mid, api, draft=edited)
    assert r["ok"] is True
    assert api.answered[0]["text"] == edited
    assert message_queue.get_row(mid)["draft"] == edited


def test_skip_marks_skipped(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    r = message_queue.skip(mid)
    assert r["ok"] is True
    assert message_queue.get_row(mid)["status"] == "skipped"
    assert message_queue.skip(mid)["ok"] is False


def test_send_requires_draft(tmp_db):
    """无草稿不可发送（人审闸门）：未点「生成草稿」的行发不出去"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    r = message_queue.send_reply(mid, api)
    assert r["ok"] is False
    assert api.answered == []


# ---------- 持久化 / 失败不丢单 ----------

def test_queue_persists_across_connections(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    message_queue.generate_draft(mid, api, _fake_llm({}, "draft"))
    # 重新打开（tmp_db 是文件库），数据仍在
    rows = message_queue.list_messages(store="BA05")
    assert len(rows) == 2 and _row_by_msg("1001")["draft"] == "draft"


def test_generate_draft_failure_keeps_row_in_new(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")

    def failing_llm(system_prompt, messages, **kwargs):
        from app import llm

        raise llm.LLMTimeoutError("超时")

    mid = _row_by_msg("1001")["id"]
    r = message_queue.generate_draft(mid, api, failing_llm)
    assert r["ok"] is False
    row = message_queue.get_row(mid)
    assert row["status"] == "new"  # 不丢单，保留待重试
    assert not row["draft"]


def test_ingest_pull_failure_does_not_crash(tmp_db):
    class BrokenAPI(FakeMessagingAPI):
        def list_questions(self, status=None, limit=50, offset=0):
            raise RuntimeError("ML 挂了")

    api = BrokenAPI()
    r = message_queue.ingest(api, store="BA05")
    assert r["failed"] >= 1
    # 队列里没有半成品
    assert message_queue.list_messages(store="BA05") == []


def test_generate_draft_retry_succeeds_after_failure(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]

    def flaky_llm(system_prompt, messages, **kwargs):
        from app import llm

        raise llm.LLMRateLimitError("限流")

    assert message_queue.generate_draft(mid, api, flaky_llm)["ok"] is False
    r = message_queue.generate_draft(mid, api, _fake_llm({}, "重试成功"))
    assert r["ok"] is True
    row = message_queue.get_row(mid)
    assert row["status"] == "draft"
    assert row["draft"] == "重试成功"


# ---------- 售前：问答历史 / 外部回复提升 ----------

def test_pre_sale_history_is_question_plus_answer(tmp_db):
    """已回复的提问：问答记录 = 客户问题 + 卖家回复（抽屉只读展示这两条）"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1002")["id"]  # ANSWERED → sent
    res = message_queue.get_message_with_history(mid, api)
    assert res["ok"] is True
    assert res["item"]["id"] == mid  # 前端读 item
    assert [h["_author"] for h in res["history"]] == ["买家", "卖家"]


def test_pre_sale_history_unanswered_is_single(tmp_db):
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]  # 待处理，草稿不计入历史
    res = message_queue.get_message_with_history(mid, api)
    assert [h["_author"] for h in res["history"]] == ["买家"]


def test_ingest_promotes_externally_answered_question(tmp_db):
    """卖家在 ML 后台直接回复 → 再拉时该提问变 ANSWERED，本地待处理行应提升为 sent"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    assert message_queue.get_row(mid)["status"] == "new"

    api._questions[0] = {
        **api._questions[0],
        "status": "ANSWERED",
        "answer": {"text": "Sim, temos!", "status": "ACTIVE"},
    }
    message_queue.ingest(api, store="BA05")
    row = message_queue.get_row(mid)
    assert row["status"] == "sent"
    assert row["draft"] == "Sim, temos!"


def test_skipped_row_is_not_resurrected_by_external_answer(tmp_db):
    """本地显式跳过的提问，即使卖家后来在 ML 后台回复了，也保持 skipped（不覆盖人工决定）"""
    api = _pre_sale_api()
    message_queue.ingest(api, store="BA05")
    mid = _row_by_msg("1001")["id"]
    assert message_queue.skip(mid)["ok"] is True

    api._questions[0] = {
        **api._questions[0],
        "status": "ANSWERED",
        "answer": {"text": "Sim, temos!", "status": "ACTIVE"},
    }
    message_queue.ingest(api, store="BA05")
    row = message_queue.get_row(mid)
    assert row["status"] == "skipped"
    assert not row["draft"]


# ---------- 提问接口拉取（真实接入层，打桩 HTTP 客户端） ----------

def test_list_questions_paginates(tmp_db):
    from app.messages import MessagingAPI

    class StubClient:
        def __init__(self):
            self.calls = []

        def get_my_user(self):
            return {"id": 999}

        def get(self, path, params=None):
            self.calls.append(params)
            offset = params["offset"]
            if offset == 0:
                return {"total": 3, "questions": [{"id": i} for i in range(50)]}
            return {"total": 3, "questions": [{"id": 50}]}

    c = StubClient()
    api = MessagingAPI(c)
    qs = api.list_questions()
    assert len(qs) == 51  # 第一页满 50 → 继续翻页
    assert [p["offset"] for p in c.calls] == [0, 50]
    assert c.calls[0]["seller_id"] == 999


def test_answer_question_posts_answers_endpoint(tmp_db):
    from app.messages import MessagingAPI

    class StubClient:
        def __init__(self):
            self.posts = []

        def post(self, path, json=None, params=None):
            self.posts.append((path, json))
            return {"id": 1}

    c = StubClient()
    api = MessagingAPI(c)
    api.answer_question("1001", text="Olá")
    assert c.posts == [("/answers", {"question_id": 1001, "text": "Olá"})]


def test_get_item_description_prefers_plain_text_and_tolerates_absent(tmp_db):
    from app.messages import MessagingAPI

    class StubClient:
        def __init__(self, resp):
            self._resp = resp

        def get(self, path, params=None):
            assert path == "/items/MLB1/description"
            return self._resp

    # 优先 plain_text（text 可能带 markdown/HTML）
    assert MessagingAPI(StubClient({"text": "# <b>x</b>", "plain_text": "texto limpo"})).get_item_description("MLB1") == "texto limpo"
    # 无简介 → 空串（不抛）
    assert MessagingAPI(StubClient({"text": "", "plain_text": None})).get_item_description("MLB1") == ""
    # 端点返回非 dict（如 -1）→ 空串
    assert MessagingAPI(StubClient(-1)).get_item_description("MLB1") == ""


# ---------- HTTP 契约（路由层，防止请求体声明与前端形态漂移） ----------

def test_send_route_accepts_object_body(tmp_db):
    """前端发 JSON 对象 {"draft": ...}；若路由把 body 声明成裸标量会被 FastAPI 判 422。

    进程内直调 send_reply 抓不到这类契约问题，故走 TestClient 打路由。
    用不存在的 id：在触达任何 ML 依赖前就返回「消息不存在」，只验请求体绑定。
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import messages as messages_router

    app = FastAPI()
    app.include_router(messages_router.router)  # 只挂消息路由，不触发调度器/lifespan
    client = TestClient(app)

    r = client.post("/api/messages/999999/send", json={"draft": "olá"})
    assert r.status_code == 200  # 之前是 422（body 被当成裸字符串）
    assert r.json()["ok"] is False

    r = client.post("/api/messages/999999/send", json={})
    assert r.status_code == 200  # draft 可缺省（回退库内草稿）
