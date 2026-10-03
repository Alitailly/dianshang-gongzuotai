# Mercado Libre API 项目 — 多店铺管理工具

对接 Mercado Libre（美客多）平台的 Python 工具，支持多店铺管理、商品数据导出。

## 技术栈

- Python 3.9+
- requests, python-dotenv

## 项目结构

```
mercado-libre-project/
├── CLAUDE.md
├── stores.d/                    # 多店铺配置（每个店铺一个 .env）
│   ├── ba05.env                 # BA05（巴西站 MLB）
│   ├── store2.env               # AW04（巴西站 MLB）
│   └── store.example.env        # 新店铺模板
├── src/
│   ├── store.py                 # Store 类 — 加载店铺配置
│   ├── auth.py                  # OAuth/PKCE 认证
│   ├── client.py                # API 客户端（仅 GET 请求）
│   ├── cli.py                   # 命令行入口（商品导出）
│   ├── main.py                  # 连接测试 / 刷新 token
│   ├── oauth_authorize.py       # OAuth 授权脚本
│   └── atoms/                   # 原子化功能模块
│       ├── products.py          # 商品管理（列表/详情/变体/访客/评分/广告）
│       └── export.py            # 数据导出（CSV/JSON）
├── data/
│   └── exports/                 # 导出文件（CLI 实际输出到 桌面/美客多导出/）
└── requirements.txt
```

## 命令

```bash
# 安装依赖
pip install -r requirements.txt

# 导出商品数据（CSV + JSON，输出到 桌面/美客多导出/<店铺名>/）
python -m src.cli <store> products export

# 其他商品命令
python -m src.cli <store> products list          # 列出所有商品变体
python -m src.cli <store> products detail <id>   # 查看单品详情

# 连接测试 / 刷新 token
python -m src.main                    # 测试 ba05
python -m src.main <store> --test     # 测试指定店铺
python -m src.main <store> --refresh  # 刷新 token
python -m src.main --list             # 列出所有店铺
python -m src.cli --list-stores       # 列出所有店铺

# OAuth 授权（首次配置新店铺时用）
python -m src.oauth_authorize <store>
```

## 编码规范

- 遵循 PEP 8，函数/变量 snake_case，类名 PascalCase
- 原子模块间不直接调用，通过文件通信
- 不写无意义的注释

## 版本与回滚（git）

本仓库 2026-09-01 起用 git 管理，**纯本地仓库（无 remote）**——回滚只影响本机，误操作无法从远端找回，靠 reflog 短期恢复。项目根放 .env（DeepSeek key 等，gitignored）。

### 提交锚点（新 → 旧）

| 提交 | 内容 | 语义 |
|---|---|---|
| `b96f585` | 文档：回滚章节 + 变更记录 | 当前 HEAD（文档） |
| `a9ccf76` | 广告助手改「指标+建议」成对排版 | 广告助手当前形态 |
| `15f1de3` | 广告助手页面内店铺选择（默认不再全店铺） | AI 功能迭代 |
| `8340099` | AI 功能集：广告助手 + 站内信消息工作台 | AI 功能主体 |
| `v1.0`（= `754882c`） | v1.0 完整状态快照 | 基线（AI 功能之前），**已打 tag 永久锚点**（gc 永不清理） |

### 回滚操作（用户说「回滚到 <版本/提交>」时执行）

标准流程：先在当前 HEAD 建备份分支使回滚可逆，再回退。

1. `git status --short` —— 确认工作区干净；有未提交改动先 `git stash` 或提交，否则 reset 可能丢
2. `git branch backup-main` —— 备份当前所有提交（反悔时 `git checkout backup-main` 可回）
3. 按用户意图回退：
   - **彻底回到旧版、丢中间提交**：`git reset --hard <sha>`
   - **回退提交但保留代码改动**（想改一版再提交）：`git reset --soft <sha>`
   - **保留历史、反向撤销某次提交**：`git revert <sha>`
4. 回滚后验证：`git log --oneline` + `git status --short` + 启动 backend 冒烟

常用目标：回滚去掉 AI 功能 → `v1.0`（= `754882c`，tag 锚点不随 gc 失效，多久都能回）；去掉最近某次广告助手改动 → `15f1de3` 或 `8340099`。

> 未打 tag 的提交若被 reset 丢弃，默认 90 天（reflog）内可从 reflog / backup 分支找回，之后被 gc 清理；tag 是强引用，永不清。删 CLAUDE.md 不影响回滚能力，只影响新会话查找锚点。

### 提交身份

本机 git 未配置 user.name/email，任何提交需加临时身份：
`git -c user.name=alitailly -c user.email=alitailly@local commit -m "..."`
