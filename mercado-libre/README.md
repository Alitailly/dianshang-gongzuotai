# 美客多数据看板（Mercado Libre Multi-Store Dashboard）

对接 Mercado Libre（美客多）**多店铺** API，拉取商品/订单/广告/访客数据，落本地 SQLite，提供
**蓝鲸 BI 风格 Web 看板**，并把每日明细**自动同步到飞书多维表格**（按 店铺×月份 分表）。

> 定档版本：v1.0（2026-08-19）。无登录/RBAC，内部工具。

## 一、整体数据流

```
美客多 API (ML)
  ├─ 商品/变体/价格/库存/体验分/广告状态      ┐
  ├─ 订单（已售/销售额/佣金/物流费，近 N 天）  ├→ SQLite ─→ ① Web 看板（Vue3）
  └─ 广告报表（点击/曝光/花费/收入，按天）    │   daily_snapshot   ② 飞书多维表格（自动）
     └─ 访客（全流量总访问，按天）            ┘   product_variation   （店铺×月份子表）
```

- **看板**：`http://localhost:5173`（前端）→ `http://localhost:8000`（后端 FastAPI）
- **飞书**：每日三个时间点自动同步（见 `docs/03-飞书同步与定时任务.md`）
- **广告 T+1**：广告数据次日巴西 10:00 定档，定档前标记「未定档·广告预览」且广告列留空（见 `docs/02-数据口径与计算公式.md`）

## 二、技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.9 + FastAPI + SQLite（stdlib `sqlite3`）+ APScheduler 3.11 |
| 前端 | Vue 3 + TypeScript + Element Plus + ECharts + Vite |
| 数据源 | Mercado Libre API（OAuth2 PKCE，每店一应用）、飞书多维表格 Bitable API |
| 运行 | `uvicorn backend.app.main:app`（常开，定时任务跑在进程内） |

## 三、目录结构

```
mercado-libre-project/
├── src/                      # ML 数据源原子模块（拉取逻辑）
│   ├── store.py              #   多店铺加载（stores.d/*.env）
│   ├── auth.py / client.py   #   OAuth / API 客户端（仅 GET）
│   ├── atoms/products.py     #   商品/变体/详情/访客/体验分/广告报表
│   ├── atoms/orders.py       #   订单聚合（销售额/佣金/物流分摊）
│   ├── timeutil.py           #   巴西时区 / 广告定档规则
│   └── oauth_authorize.py    #   新店铺 OAuth 授权脚本
├── backend/
│   ├── app/main.py           # FastAPI 入口 + APScheduler（每日三时间点）
│   ├── app/db.py             # SQLite 表结构（product_variation / daily_snapshot）
│   ├── app/sync.py           # ML→SQLite 同步服务（增量 upsert）
│   ├── app/repository.py     # 看板查询/指标计算（商品分析页）
│   ├── app/feishu.py         # 飞书 Bitable API（token/表/字段/记录/视图）
│   ├── app/routers/          # API 路由（sync/products/orders/ads/export/bitable…）
│   └── app/routers/bitable.py# 飞书每日同步（表组装/派生列/upsert）
├── frontend/                 # Vue3 看板
├── stores.d/                 # 店铺配置（一店一 .env，含 token，已 gitignore）
├── data/dashboard.db         # SQLite 数据（商品+每日快照）
├── feishu.env                # 飞书应用凭证 + Bitable app_token（已 gitignore）
└── docs/                     # 定档文档（见下）
```

## 四、快速启动

```bash
# 1. 安装依赖
pip install -r requirements.txt            # 或使用 .venv

# 2. 配置店铺（已有 ba05 / store2 可跳过）
cp stores.d/store.example.env stores.d/<店名>.env   # 填 CLIENT_ID/SECRET/STORE_NAME/ML_SITE_ID
python -m src.oauth_authorize <店名>                 # 浏览器授权，写回 token

# 3. 配置飞书（feishu.env：APP_ID/APP_SECRET/APP_TOKEN/TABLE_ID）
#    测试 base 与正式 base 迁移见 docs/04

# 4. 启动后端（常开；定时任务在进程内）
.venv/bin/python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000

# 5. 启动前端
cd frontend && npm run dev                 # http://localhost:5173

# 6. 首次全量同步（也可等定时任务）
curl -X POST http://127.0.0.1:8000/api/sync
curl -X POST http://127.0.0.1:8000/api/export/bitable/daily
```

## 五、关键 API

| 接口 | 说明 |
|---|---|
| `POST /api/sync?days_back=N` | ML→SQLite 同步（默认 90 全量；定时增量 4） |
| `GET /api/sync/status` | 同步状态 |
| `GET /api/stores` | 店铺列表（前端下拉动态读取） |
| `GET /api/meta/data-status` | 巴西今天 / 广告定档截止日 / 快照最早日期 |
| `GET /api/items…` / `GET /api/products…` | 看板商品/广告/订单查询 |
| `POST /api/export/bitable/daily` | SQLite→飞书全区间同步（自动建月份表） |
| `POST /api/export/bitable/daily/verify` | 飞书 vs 本地逐字段校验 |
| `POST /api/export/bitable/daily/backfill?days_back=N` | 手动回填最近 N 天 |

## 六、文档导航

| 文档 | 内容 |
|---|---|
| `docs/01-系统架构与数据流.md` | 三层架构、表结构、模块职责 |
| `docs/02-数据口径与计算公式.md` | 所有字段口径、广告 T+1、派生列公式 |
| `docs/03-飞书同步与定时任务.md` | 飞书表结构、三个同步时间点、幂等机制、校验 |
| `docs/04-店铺接入与正式表格迁移.md` | 加新店步骤、测试→正式飞书迁移 |
| `docs/05-部署与运维.md` | uvicorn 常开、systemd、日志、故障排查 |
| `docs/06-逻辑疑点-待确认.md` | 与后台对账存疑的口径清单 |
| `docs/07-变更记录.md` | 变更日志 |
| `docs/archive/` | 历史设计稿（已过时，仅供追溯） |

> **文档维护**：`docs` 中 `<!-- GEN:xxx:BEGIN/END -->` 标记区域的内容（列清单/定时时间/表名格式/定档规则）
> **由代码生成**，勿手改。改了对应代码后运行：
> `.venv/bin/python scripts/gen_docs.py`（回填）或 `--check`（CI 校验是否同步）。
