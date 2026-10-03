# CONTEXT.md — 项目词汇表与决策记录

> 由 grill-with-docs 建档（2026-09-01）。共享语言：所有技能（to-spec / to-tickets / implement / triage / domain-modeling）以此为基准。

## 一、领域词汇（定档）

| 词 | 定义 |
|---|---|
| 店铺（store） | 一个 Mercado Libre 账号/站点应用，`stores.d/<店>.env` 一份凭证 |
| 定档 | 数据到达「最终可用」状态的时点（如广告 T+1 巴西 10:00 定档）；定档前标记「未定档·预览」 |
| 快照（snapshot） | `daily_snapshot` 表：按 店铺×商品×天 的广告+销售指标时间序列 |
| 商品变体（variation） | `product_variation`：商品元数据当前值（标题/价格/库存/体验分/佣金率） |
| 广告指标 | ad_cost 花费 / ad_clicks 点击 / ad_impressions 曝光 / ad_ctr 点击率 / ad_sales 广告销售额 / ad_roas 投产比 / ad_acos 广告成本占比 |
| 站内信（message） | 买家在 ML 平台发的消息；按 tag 分 pre_sale（售前）/ post_sale（售后） |
| pack | ML 消息会话（一个订单/商品下的消息线程），天然的多轮上下文 |
| 消息工作台 | 本课新增：站内信收→LLM草稿→人审→发回的完整客服系统 |
| 广告助手 | 本课新增：读广告聚合数据 → LLM 出优化建议（一次性分析） |
| LLM 底座 | 共享的 DeepSeek 接入模块（后端封装，key 不进前端） |

## 二、决策记录（本课 grill 结论）

| # | 决策 | 结论 | 依据 |
|---|------|------|------|
| R1 | LLM 供应商 | **DeepSeek** | 国内直连稳定、API 兼容 OpenAI、成本低 |
| R2 | LLM key 与调用位置 | 后端 `backend/app/llm.py` 封装，key 进 `.env` | 前端碰不到 key，沿用 `feishu.env` 不入库先例 |
| R3 | 底座共享策略 | 最小 LLM 接入模块，广告助手先用，客服复用 | 垂直切片：不为未做的功能预造模块 |
| R4 | 广告助手形态 | **独立页面**（views/AdAssistant.vue + 路由） | 不碰现有 4 个页面，最小回归风险 |
| R5 | 广告助手数据 | 复用 `/api/ads/summary` + `/trend` + `/items` 聚合 → prompt | 不新造数据管道，LLM 只消费跑通的查询 |
| R6 | 广告助手交互 | **一次性分析**（非对话）：总览 + 3~5 条建议卡片 | 垂直切片最小版；对话式后续增强 |
| R7 | 客服范围 | **售前（pre_sale）+ 售后（post_sale）都做** | 用户决策；按消息 tag 分流 |
| R8 | 客服数据 | 售前=product_variation 商品上下文；售后=ML 订单/物流 API（复用 orders.py 模式） | 草稿生成时的上下文来源 |
| R9 | 客服形态 | **站内信消息工作台**（不是内部聊天页）：收→草稿→审→发 | ML 站内信自动对接（用户确认）；复用 APScheduler 轮询 |
| R10 | 客服人审模式 | **LLM 草稿 → 人校验 → 确认后通过 ML API 发回**（HITL 保留） | 信任闸门；不全自动回买家 |
| R11 | 售后单订单查询 | 新增 `/orders/{id}` + `/shipments/{id}` 封装 | 本地只有订单聚合，明细需实时查 |
| R12 | 售前/售后分流 | **消息 tag 分流**（pre_sale/post_sale），不用 LLM 判断 | ML API 自带 tag，比模型分类更可靠 |
| R13 | 客服多轮记忆 | **pack 内消息历史即上下文**（售前单轮为主，售后天然多轮） | pack 是消息线程，拉取即得历史；R14 修正 |
| R14 | 多轮上下文实现 | 生成草稿时拉取 **pack 完整消息**作上下文（后端无状态） | 来源是 ML API 不是前端持有；无持久化需求 |
| R15 | 消息轮询 | **复用 APScheduler 加定时 job**（间隔 spec 定，建议 5~10 分钟） | 现有定时基础设施现成；ML 无 webhook 时轮询为主 |

## 三、未决（进 spec 细化）

- 新消息架构的 **agent ID** 获取与确认（MLB/MLC 收件人用国家 agent ID，非买家 ID）
- 消息 scope 实测（现有 read/write 是否够）
- 轮询间隔、markAsRead 策略
- 待审队列的 SQLite 表结构（草稿状态机：new→draft→sent/skipped）
- 广告助手建议卡片的具体 schema
- 第一版明确不做：FAQ 知识库、ad_ops_log 写入、对话式追问、飞书客服、买家公开入口、消息自动发送（永远人审）
