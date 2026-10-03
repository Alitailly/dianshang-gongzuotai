# RPA Portal

RPA 门户基础工程：Vue 3 + Element Plus 前端，Express 5 服务端。

本仓库包含门户的通用能力：登录鉴权、用户管理、主题切换、设置页、本地文件下载、运行日志、静态资源托管。`plugins/` 是本地插件挂载目录，`inquiry`（询盘自动化）与 `market`（竞品选品）两个插件各自维护在独立仓库中，**不随本仓库提交**。Bot 程序也是独立的 Python 进程和独立仓库，不在本仓库内，通过控制接口与本门户协作。

本目录后来又并入了美客多运营看板，源码在 `mercado-libre/`。它和询盘 Bot 不是同一个程序。看板页面挂在门户左侧「美客多」菜单下，详细说明见下方「美客多运营」。

## 技术栈

- 前端：Vue 3、Vue Router、Element Plus、ECharts、Vite
- 服务端：Node.js 18+、Express 5
- 测试：Node.js 内置 test runner

## 启动方式（网页端）

### 1. 环境要求

- Node.js 18+（推荐当前 nvm 安装版本）
- 首次运行先安装依赖：

```bash
cd ~/Desktop/RPA
npm install
```

### 2. 准备环境变量

```bash
cp .env.example .env
# 编辑 .env，至少设置 RPA_CONTROL_TOKEN
# RPA_CONTROL_TOKEN 必须与 Bot 所在机器的控制令牌一致
```

常用变量：

- `EXCEL_SERVER_PORT`：门户端口，默认 `5055`；
- `RPA_CONTROL_TOKEN`：门户与 Bot 控制接口的共享令牌；
- `GALAXY_DIR`：Bot 项目目录，默认 `~/Desktop/飞书多维表格管理工具星系核`；
- `ALLOWED_ORIGINS`：允许访问的浏览器来源，不填时由启动脚本自动补充本机地址。

### 3. 构建前端

```bash
cd ~/Desktop/RPA
npm run build
```

开发调试可改用：

```bash
npm run dev
```

Vite 开发服务器默认监听 `5173`，并把 `/api` 代理到 `5055`。

### 4. 启动门户

推荐使用本地启动脚本（只启动网页端，不会自动启动 Bot）：

```bash
cd ~/Desktop/RPA
./start-local.sh
```

也可以直接启动 Express 服务端：

```bash
cd ~/Desktop/RPA
npm run server
```

启动后：

- 本机访问：`http://127.0.0.1:5055`
- 局域网访问：`http://<本机 IP>:5055`

### 5. 停止门户

- 前台运行时：按 `Ctrl+C`；
- 后台运行时：先找到监听 `5055` 的进程，再发送 `SIGTERM`：

```bash
lsof -nP -iTCP:5055 -sTCP:LISTEN
kill -TERM <PID>
```

### 6. Bot 程序单独启动

门户不会自动启动 Bot（本机 Bot 需要在对应机器上单独启动）：

```bash
cd ~/Desktop/飞书多维表格管理工具星系核
venv/bin/python bot.py
```

Bot 控制接口默认监听 `18810`。如果 Bot 不在线，门户仍可启动，但机器人状态、询盘任务等功能会显示离线。

### 7. 当前数据目录

迁移后的运行时数据默认在：

```text
RPA/data/plugins/inquiry/    # 询盘实例、设置、任务历史、候选图缓存
RPA/data/plugins/market/     # 市场调度、状态、缓存、日志、审计
```

兼容期仍会回退读取旧路径，例如 `server/bot_instances.json`、`plugins/market/scripts/schedule_config.json`。

## 美客多运营

美客多运营是后加入本目录的项目，源码在 `mercado-libre/`。门户左侧「美客多」菜单分成三类：

| 分组 | 页面 |
|---|---|
| 经营 | 经营总览、商品分析 |
| 广告 | 广告流量、广告投放、广告助手 |
| 消息 | 消息工作台 |

对外只打开门户一个地址：`http://127.0.0.1:5055`。执行 `npm run server` 或 `node server.js` 时，门户会在本机拉起美客多数据服务，浏览器不需要再开第二个端口。数据服务只监听本机，页面通过 `/api/mercado` 访问它。

首次在新电脑上使用前，先安装美客多的 Python 依赖：

```bash
cd mercado-libre
py -3 -m pip install -r backend/requirements.txt
```

看板自己的口径、飞书同步和店铺接入说明仍在 `mercado-libre/docs/`，入口是 `mercado-libre/README.md`。

这些文件含店铺令牌、飞书密钥或经营数据，只留在本机，不要提交：

- `mercado-libre/.env`
- `mercado-libre/feishu.env`
- `mercado-libre/stores.d/`
- `mercado-libre/data/`

## 可用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务器（默认 5173，代理 `/api` 到 5055） |
| `npm run build` | 构建生产资源到 `dist/` |
| `npm run preview` | 预览 Vite 构建结果 |
| `npm run server` | 启动 Express 服务端 |
| `npm test` | 运行 Node.js 自动化测试 |
| `npm run test:themes` | 运行主题与对比度校验脚本 |
| `npm run check:connectivity` | 检查本地配置的连通性目标 |

## 配置说明

配置优先读取系统环境变量，其次读取项目根目录 `.env` 或 `server/.env`。

| 变量 | 说明 |
|---|---|
| `EXCEL_SERVER_PORT` | 服务端端口，默认 `5055` |
| `RPA_CONTROL_TOKEN` | 控制接口鉴权令牌，必须与本机业务程序配置一致 |
| `ALLOWED_ORIGINS` | 允许的浏览器 Origin，多个用逗号分隔；不填时自动加入本机地址 |
| `RPA_ENV_FILE` | 可选，指定额外的 `.env` 文件路径 |
| `LATEST_BOT_VERSION` | 兼容期默认对接 Bot 版本；询盘设置页可覆盖，Bot 实际版本不可在网站设置 |
| `CDP_HOST` / `CDP_PORTS` | 本机调试端口探测配置 |
| `GALAXY_DIR` | 本机业务程序运行目录 |
| `BOT_EXEC` / `CHROME_EXEC` | 可选，打包产物模式的执行文件路径 |

示例配置只使用占位值，不要提交真实令牌、密码、Cookie 或密钥。

## 仓库

这是个人项目「电商工作台」，仓库地址是 `https://github.com/Alitailly/dianshang-gongzuotai`。

本地的 `plugins/inquiry` 和 `plugins/market` 不随这个仓库提交。Bot 程序也不在这个仓库里。

## 目录结构

```text
server/           Express 服务端内核：鉴权、用户、设置、静态托管与通用工具
server/kernel/    插件内核：扫描、装载、启停、版本与设置声明
server/routes/    服务端 HTTP 接口
server/lib/       通用库：配置、鉴权、安全校验、文件存储、路径解析等
plugins/          本地插件挂载目录（inquiry、market 各自独立仓库，不随本仓库提交）
mercado-libre/   美客多运营看板源码（后加入本目录；页面从门户左侧「美客多」进入）
src/              Vue 前端代码
src/views/        页面视图（设置、插件管理、用户管理、账号等）
src/components/   通用组件
src/composables/  前端组合式函数
src/themes/       主题样式
public/           公共静态资源
scripts/          本地辅助脚本（含 migrate-plugin-data.mjs、monitor_logs.py）
test/             自动化测试
data/plugins/     插件运行时数据（本地忽略，不进入 Git）
server.js         服务端入口
start-local.sh    本地启动脚本（只启动网页端）
vite.config.js    前端构建配置
.env.example      环境变量示例
```

## 鉴权与会话

- 服务端使用 HMAC 签名令牌，默认 24 小时滑动有效期。
- 登录成功后令牌同时支持 `Authorization: Bearer` 和 HttpOnly Cookie。
- 密码使用 scrypt 加盐哈希存储，不保存明文密码。
- 登录失败按来源 IP 做轻量限速。
- 用户管理、服务端设置等管理操作需要管理员权限。

## 本地数据与安全

- `.env`、`server/users.json`、`server/.secret`、`server/.sessions.json` 等本地运行文件已被 Git 忽略。
- `.env.example`、`server/*.example.json` 等示例文件只使用占位值。
- 提交前请确认没有真实令牌、密码、Cookie、密钥或运行数据进入暂存区。
- 首次启动生成的默认管理员密码只在控制台显示一次，登录后请立即修改。

## CI

推送到 `main` 分支时，仓库内的 GitHub Actions 会发送通知。
