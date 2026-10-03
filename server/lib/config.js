/** server/lib/config.js — 全局配置常量(从 server.js 抽出) */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) // server/lib -> server -> RPA 根
const __dirname = ROOT_DIR

// ---------- 本地 .env 加载(兼容网站与 bot 分机部署) ----------
// process.env 优先;项目根 .env、server/.env 依次加载,已有值不覆盖。
// 这样在只有网站项目、没有星系核目录的机器上也能直接 npm run server。
function loadLocalEnvFile() {
  const envFiles = process.env.RPA_ENV_FILE
    ? [process.env.RPA_ENV_FILE]
    : [path.join(ROOT_DIR, '.env'), path.join(ROOT_DIR, 'server', '.env')]
  for (const file of envFiles) {
    let content
    try {
      content = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const rawLine of content.split(/\r?\n/)) {
      let line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('export ')) line = line.slice(7).trim()
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      if (process.env[key] !== undefined) continue
      let value = line.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      } else {
        // 未加引号时支持 `KEY=value # comment` 写法
        const hash = value.search(/\s+#/)
        if (hash >= 0) value = value.slice(0, hash).trimEnd()
      }
      process.env[key] = value
    }
  }
}
loadLocalEnvFile()

const DEFAULT_GALAXY_DIR = process.env.GALAXY_DIR || path.join(os.homedir(), 'Desktop', '飞书多维表格管理工具星系核')

export const PORT = process.env.EXCEL_SERVER_PORT || 5055
export const LOCAL_PLUGINS_DIR = path.join(__dirname, 'plugins')
export const LOG_DIR = process.env.RPA_LOG_DIR || path.join(DEFAULT_GALAXY_DIR, 'logs')
export const LOG_FILE_RE = /^bot_\d{8}(?:_\d{3})?\.log$/
export const CHAT_DIR = process.env.RPA_CHAT_DIR || path.join(DEFAULT_GALAXY_DIR, 'chat_records')
export const CHAT_FILE_RE = /^inquiry_\d{8}_\d{6}\.json$/

// 飞书应用配置(唯一加载入口,server/feishu.js 从此处复用;密钥仅服务端使用)
export const FEISHU_CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'server', 'feishu.config.json'), 'utf-8'))
  } catch {
    console.warn('[server] 缺少 server/feishu.config.json,机器人指令转发不可用')
    return {}
  }
})()

// 本地机器人(bot.py)控制接口地址
export const BOT_CONTROL_URL = process.env.BOT_CONTROL_URL || 'http://127.0.0.1:18810/api/command'

// 优先使用环境变量;未设置时自动从星系核 .env 读取,避免直接 node server.js 时丢失控制鉴权
// [P2] 与 start-local.sh 解析保持一致：剥离首尾空白与外层单/双引号
function cleanTokenValue(v) {
  let s = String(v == null ? '' : v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

function loadBotControlToken() {
  if (process.env.RPA_CONTROL_TOKEN) return cleanTokenValue(process.env.RPA_CONTROL_TOKEN)
  try {
    const galaxyDir = DEFAULT_GALAXY_DIR
    const envContent = fs.readFileSync(path.join(galaxyDir, '.env'), 'utf-8')
    const match = envContent.match(/^RPA_CONTROL_TOKEN=(.*)$/m)
    return match ? cleanTokenValue(match[1]) : ''
  } catch {
    return ''
  }
}
export const BOT_CONTROL_TOKEN = loadBotControlToken()

// 门户认可的最新 bot 程序版本号（与星系核 config.py 的 BOT_VERSION 保持同步）
// 可通过环境变量覆盖；机器人状态页会用该值与 bot 上报的版本比对并给出醒目提醒。
// （原 BOT_VERSION 为遗留死导出：全仓库无人 import，真正生效的是下面这个。）
export const LATEST_BOT_VERSION = process.env.LATEST_BOT_VERSION || '1.3.1'

// CDP Chrome 端口探测配置(网页内置探测,不依赖 bot 在线)
export const CDP_HOST = process.env.CDP_HOST || '127.0.0.1' // 内网模式可配 B 电脑的 IP
export const CDP_PORTS = (process.env.CDP_PORTS || '18800,18801,18802,18803,18804')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)

// 星系核目录(调用 launch_chrome.py 启动 Chrome)
export const GALAXY_DIR = DEFAULT_GALAXY_DIR

// 首轮询盘候选图片本地缓存目录:bot 推送候选后由门户下载到本地磁盘,
// 经 /pick-imgs 静态托管给前端 <img>(无需鉴权头),用户选择完成后整体清理
export const PICK_IMAGE_DIR = path.join(__dirname, 'server', 'cache', 'first-inquiry-pick')

// 网站根目录下的文件下载目录:任何电脑访问网站都能看到/下载该目录内容
export const XXH_DOWN_DIR = process.env.XXH_DOWN_DIR || path.join(ROOT_DIR, 'xxh_down')

// 打包产物模式:优先用 BOT_EXEC / CHROME_EXEC 启动 PyInstaller 打包后的可执行文件
// 为空时使用星系核源码模式：python3 bot.py / python3 launch_chrome.py。
export const BOT_EXEC = process.env.BOT_EXEC || ''
export const CHROME_EXEC = process.env.CHROME_EXEC || ''

// ---------- 配置 ----------
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // token 有效期 24h(滑动续期,活跃不退出)
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 图片大小上限 10MB
export const MAX_REDIRECTS = 5
export const DOWNLOAD_TIMEOUT_MS = 10000
export const SECRET_FILE = path.join(__dirname, 'server', '.secret')
export const SESSION_FILE = path.join(__dirname, 'server', '.sessions.json')
// 未显式配置时自动放行 localhost + 本机所有非回环 IPv4,
// 避免局域网部署时因忘记设置 ALLOWED_ORIGINS 导致浏览器请求 403。
function defaultAllowedOrigins() {
  const origins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ])
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) {
        origins.add(`http://${info.address}:${PORT}`)
      }
    }
  }
  return [...origins]
}

export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : defaultAllowedOrigins())
  .map(s => s.trim()).filter(Boolean)

// 开发自签名证书场景可用 ALLOW_INSECURE_HTTPS=true 显式放开 TLS 校验。
//
// 2026-09-19 修正：原实现导出一个 node:https 的 Agent 并在 fetch 里以 `agent` 选项传入，
// 但 Node 内置 fetch 走的是 undici，**不识别 agent 选项**——该参数被静默丢弃，
// 于是这个开关一直是空转的（自签名证书照样报 DEPTH_ZERO_SELF_SIGNED_CERT）。
// undici 的 dispatcher 才是正解，但仓库没有 undici 依赖；这里改用 Node 自带的
// NODE_TLS_REJECT_UNAUTHORIZED，效果等价、无需新增依赖。
// 注意：它是进程级的，且 Node 会在 stderr 打印警告——这符合"显式选择不安全"的语义。
if (process.env.ALLOW_INSECURE_HTTPS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  console.warn('[config] ⚠️ ALLOW_INSECURE_HTTPS=true：已全局关闭 TLS 证书校验，仅供开发自签名证书场景使用')
}

export { ROOT_DIR }
