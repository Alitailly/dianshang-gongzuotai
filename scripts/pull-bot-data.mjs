#!/usr/bin/env node
/**
 * pull-bot-data.mjs — 只读拉取 bot 机器的聊天记录与终端日志
 *
 * 目标:
 *   给网页机上的本地 AI / Codex 类 Agent 准备一份可读的本地快照。
 *   脚本只调用 bot 控制接口的只读 action:
 *     - chat_list / chat_read
 *     - log_list / log_tail / log_back
 *   不会触发询盘、不会启停 bot、不会修改 bot 状态。
 *
 * 用法:
 *   node scripts/pull-bot-data.mjs
 *   node scripts/pull-bot-data.mjs --instance MAC1
 *   node scripts/pull-bot-data.mjs --instance 192.168.1.30 --batch
 *   node scripts/pull-bot-data.mjs --instance all --out data/remote
 *   node scripts/pull-bot-data.mjs --since-days 7 --dry-run
 *   node scripts/pull-bot-data.mjs --tail-logs 500        # 改回只拉日志尾部
 *
 * 常用参数:
 *   --instance <all|local|id|ip|account>  要拉取的实例, 默认 all
 *   --out <dir>                           输出根目录, 默认 <项目根>/data/remote
 *   --batch                               输出到 <out>/<YYYY-MM-DD_HHmm>/ 批次目录
 *   --since-days <n>                      只拉文件名日期在 n 天内的文件, 0=不限, 默认 30
 *   --chat / --no-chat                    是否拉聊天记录, 默认拉
 *   --logs / --no-logs                    是否拉终端日志, 默认拉
 *   --chat-limit <n>                      每个实例最多拉最新 n 个聊天文件, 0=全部, 默认 0
 *   --log-files <n>                       每个实例最多拉最新 n 个日志文件, 0=全部, 默认 0
 *   --full-logs                           拉完整日志(默认行为, 保留该参数仅为兼容)
 *   --tail-logs <n>                       只保留每个日志的尾部 n 行(大日志慎用)
 *   --timeout <ms>                        单次 bot 控制请求超时, 默认 20000
 *   --dry-run                             只打印将要拉取的实例与文件数, 不发起任何请求
 *   --help, -h                            显示帮助
 *
 * 进度协议:
 *   输出 `[PROGRESS] <已完成> <总数> <说明>` 行, 供网页后台任务解析进度条。
 *
 * 输出结构:
 *   data/remote/                          (不加 --batch)
 *     MAC1/
 *       manifest.json
 *       chat_records/inquiry_*.json
 *       logs/bot_*.log
 *   data/remote/2026-09-21_1530/MAC1/...  (加 --batch)
 *
 * 2026-09-21 改动:
 *   - 新增 --since-days / --batch / --tail-logs；默认改为「完整日志 + 不限文件个数」，
 *     原行为（尾部 500 行 + 只拉最新 3 个日志 / 20 个聊天）可用 --tail-logs 与
 *     --log-files / --chat-limit 还原。
 *   - 新增 [PROGRESS] 进度行；为此把"先列清单、再逐个下载"拆成两段，
 *     这样进度总数是准的（列清单只要 2 次请求/实例）。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getInstances } from '../server/lib/botInstances.js'
import { postToBot } from '../server/lib/botClient.js'
import { CHAT_DIR, LOG_DIR, ROOT_DIR, CHAT_FILE_RE, LOG_FILE_RE } from '../server/lib/config.js'

const DEFAULT_OUT_DIR = path.join(ROOT_DIR, 'data', 'remote')
const DEFAULT_TIMEOUT_MS = 20000
const FULL_LOG_CHUNK_BYTES = 2 * 1024 * 1024
const DEFAULT_SINCE_DAYS = 30

// 只读 action 白名单：任何非白名单 action 都会被脚本直接拒绝。
const READ_ONLY_ACTIONS = new Set(['chat_list', 'chat_read', 'log_list', 'log_tail', 'log_back'])

const LOCAL_IPS = new Set(['127.0.0.1', 'localhost', '::1'])
for (const infos of Object.values(os.networkInterfaces())) {
  for (const info of infos || []) {
    if (info.family === 'IPv4') LOCAL_IPS.add(info.address)
  }
}

// ── 进度协议（供网页后台任务解析）───────────────────────────────
let PROGRESS_TOTAL = 0
let PROGRESS_DONE = 0

function emitProgress(done, total, label) {
  // 进度行只走 stdout 且独占一行，网页侧用正则逐行解析
  process.stdout.write(`[PROGRESS] ${done} ${total} ${label}\n`)
}

function progressStart(total, label) {
  PROGRESS_TOTAL = total
  PROGRESS_DONE = 0
  emitProgress(0, total, label)
}

function progressStep(label) {
  PROGRESS_DONE += 1
  emitProgress(PROGRESS_DONE, PROGRESS_TOTAL, label)
}

function printHelp() {
  console.log(`用法: node scripts/pull-bot-data.mjs [选项]

选项:
  --instance <all|local|id|ip|account>  要拉取的实例, 默认 all
  --out <dir>                           输出根目录, 默认 ${DEFAULT_OUT_DIR}
  --batch                               输出到 <out>/<YYYY-MM-DD_HHmm>/ 批次目录
  --since-days <n>                      只拉文件名日期在 n 天内的文件, 0=不限, 默认 ${DEFAULT_SINCE_DAYS}
  --chat                                拉聊天记录(默认)
  --no-chat                             不拉聊天记录
  --logs                                拉终端日志(默认)
  --no-logs                             不拉终端日志
  --chat-limit <n>                      每个实例最多拉最新 n 个聊天文件, 0=全部, 默认 0
  --log-files <n>                       每个实例最多拉最新 n 个日志文件, 0=全部, 默认 0
  --full-logs                           拉完整日志(默认行为)
  --tail-logs <n>                       只保留每个日志的尾部 n 行
  --timeout <ms>                        单次 bot 请求超时, 默认 ${DEFAULT_TIMEOUT_MS}
  --dry-run                             只打印计划, 不发起请求
  --help, -h                            显示帮助`)
}

function parseArgs(argv) {
  const opts = {
    instance: 'all',
    outDir: DEFAULT_OUT_DIR,
    batch: false,
    sinceDays: DEFAULT_SINCE_DAYS,
    chat: true,
    logs: true,
    chatLimit: 0,
    logFiles: 0,
    fullLogs: true,
    logLines: 500,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--instance': {
        const value = String(argv[++i] || '').trim()
        if (!value) throw new Error('--instance 不能为空')
        opts.instance = value
        break
      }
      case '--out': {
        const value = String(argv[++i] || '').trim()
        if (!value) throw new Error('--out 不能为空')
        opts.outDir = path.resolve(value)
        break
      }
      case '--batch':
        opts.batch = true
        break
      case '--since-days':
        opts.sinceDays = parseNonNegativeInt('--since-days', argv[++i])
        break
      case '--chat':
        opts.chat = true
        break
      case '--no-chat':
        opts.chat = false
        break
      case '--logs':
        opts.logs = true
        break
      case '--no-logs':
        opts.logs = false
        break
      case '--chat-limit':
        opts.chatLimit = parseNonNegativeInt('--chat-limit', argv[++i])
        break
      case '--log-files':
        opts.logFiles = parseNonNegativeInt('--log-files', argv[++i])
        break
      case '--full-logs':
        opts.fullLogs = true
        break
      case '--tail-logs':
        opts.fullLogs = false
        opts.logLines = parsePositiveInt('--tail-logs', argv[++i])
        break
      case '--timeout':
        opts.timeoutMs = parsePositiveInt('--timeout', argv[++i])
        break
      case '--dry-run':
        opts.dryRun = true
        break
      default:
        throw new Error(`未知参数: ${arg}`)
    }
  }

  return opts
}

function parseNonNegativeInt(name, raw) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 需要 >= 0 的整数`)
  return value
}

function parsePositiveInt(name, raw) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 需要 > 0 的整数`)
  return value
}

function targetLabel(target) {
  const name = String(target.name || '').trim()
  const address = `${target.ip}:${target.control_port}`
  return name && name !== target.ip ? `${name} (${address})` : address
}

function safeDirName(value) {
  const text = String(value || '').trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    // 2026-09-21：点号在允许字符里，于是安全函数自己会漏出 `..`：
    // path.join(outDir, '..') 会跳出输出目录。机器名是管理员在设置页填的，
    // 虽然危害有限，但叫 safeDirName 就该真的安全——去掉开头的点，
    // 并且单独处理 `..` / `.`（去点后为空 → 回落 instance）。
    .replace(/^\.+/, '')
    .replace(/^_+|_+$/g, '')
  return text || 'instance'
}

function assignOutputDirs(targets) {
  const used = new Set()
  const result = new Map()
  for (const target of targets) {
    const base = safeDirName(target.name || target.ip || target.id)
    let dirName = base
    let seq = 2
    while (used.has(dirName)) {
      dirName = `${base}_${seq++}`
    }
    used.add(dirName)
    result.set(target, dirName)
  }
  return result
}

function isLocalTarget(target) {
  return LOCAL_IPS.has(String(target?.ip || '').trim().toLowerCase())
}

function sortByNameDesc(files) {
  return [...files].sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')))
}

function limitFiles(files, limit) {
  const sorted = sortByNameDesc(files)
  return limit > 0 ? sorted.slice(0, limit) : sorted
}

/** 从文件名里解析日期（inquiry_YYYYMMDD_HHMMSS.json / bot_YYYYMMDD.log）。 */
function parseFileDate(name) {
  const m = String(name || '').match(/(20\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 只保留文件名日期在最近 days 天内的文件。
 * days <= 0 表示不限；文件名解析不出日期的**保留**（宁可多拉，不要漏）。
 */
function withinSinceDays(files, days) {
  if (!days || days <= 0) return files
  const cutoff = new Date(Date.now() - days * 86400000)
  cutoff.setHours(0, 0, 0, 0)
  return files.filter((file) => {
    const d = parseFileDate(file.name)
    return !d || d >= cutoff
  })
}

/** 批次目录名：2026-09-21_1530 */
function batchDirName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `_${p(now.getHours())}${p(now.getMinutes())}`
}

/**
 * 占用一个批次目录并返回它的绝对路径。
 *
 * 2026-09-21：批次名只精确到**分钟**，于是同一分钟内发起的两次拉取会落进同一个
 * 目录 —— 实测网页端连点两次（第一次很快跑完）就复现了：MAC1 的 manifest 记的是
 * 30 天那次、MAC2 记的是 3 天那次，两份结果混成一个"批次"，manifest 与实际内容对不上。
 *
 * 这里用 mkdir 抢占用（不带 recursive 的 mkdir 在 POSIX 上是原子的，
 * 目录已存在会抛 EEXIST），已存在就退到 `_2` `_3`……既保留了
 * 「分日期分机器」的命名，又不会把两次拉取混在一起。
 */
async function claimBatchDir(rootDir, now = new Date()) {
  await fs.mkdir(rootDir, { recursive: true })
  const base = batchDirName(now)
  for (let seq = 1; seq <= 99; seq++) {
    const name = seq === 1 ? base : `${base}_${seq}`
    try {
      await fs.mkdir(path.join(rootDir, name))   // 原子占用；已存在抛 EEXIST
      return path.join(rootDir, name)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`同一分钟内批次目录过多（${base}）`)
}

async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, content)
  await fs.rename(tmp, filePath)
}

/** 只允许白名单中的只读 action，防止脚本未来误调用控制类指令。 */
async function botRead(target, body, opts) {
  const action = String(body?.action || '')
  if (!READ_ONLY_ACTIONS.has(action)) {
    throw new Error(`拒绝非只读 action: ${action || '(空)'}`)
  }
  return postToBot(body, { target, timeoutMs: opts.timeoutMs })
}

async function listLocalFiles(dir, re) {
  const names = await fs.readdir(dir)
  const files = []
  for (const name of names) {
    if (!re.test(name)) continue
    const filePath = path.join(dir, name)
    const st = await fs.stat(filePath)
    files.push({ name, size: st.size, mtime: st.mtime.toISOString() })
  }
  return sortByNameDesc(files)
}

/** 列出该实例本轮要拉的文件（不做下载）。 */
async function planInstance(target, opts) {
  const source = isLocalTarget(target) ? 'local' : 'remote'
  const plan = { source, chat: [], logs: [], remoteDirs: { chat: '', logs: '' }, errors: [] }

  if (opts.chat) {
    try {
      let files
      if (source === 'local') {
        files = await listLocalFiles(CHAT_DIR, CHAT_FILE_RE)
      } else {
        const list = await botRead(target, { action: 'chat_list' }, opts)
        files = Array.isArray(list.files) ? list.files : []
        plan.remoteDirs.chat = list.dir || `remote:${target.ip}`
      }
      plan.chat = limitFiles(withinSinceDays(files, opts.sinceDays), opts.chatLimit)
    } catch (error) {
      if (error.code === 'ENOENT' && source === 'local') {
        plan.errors.push(`chat: 本地聊天记录目录不存在: ${CHAT_DIR}`)
      } else {
        plan.errors.push(`chat: ${error.message}`)
      }
    }
  }

  if (opts.logs) {
    try {
      let files
      if (source === 'local') {
        files = await listLocalFiles(LOG_DIR, LOG_FILE_RE)
      } else {
        const list = await botRead(target, { action: 'log_list' }, opts)
        files = Array.isArray(list.files) ? list.files : []
        plan.remoteDirs.logs = list.dir || `remote:${target.ip}`
      }
      plan.logs = limitFiles(withinSinceDays(files, opts.sinceDays), opts.logFiles)
    } catch (error) {
      if (error.code === 'ENOENT' && source === 'local') {
        plan.errors.push(`logs: 本地日志目录不存在: ${LOG_DIR}`)
      } else {
        plan.errors.push(`logs: ${error.message}`)
      }
    }
  }

  return plan
}

function tailTextLines(content, lineCount) {
  const lines = String(content).split('\n')
  return lines.slice(-lineCount).join('\n')
}

async function pullLocalChatFile(outDir, file, opts) {
  const raw = await fs.readFile(path.join(CHAT_DIR, file.name), 'utf-8')
  await writeFileAtomic(path.join(outDir, 'chat_records', file.name), raw)
}

async function pullRemoteChatFile(target, outDir, file, opts) {
  const data = await botRead(target, { action: 'chat_read', file: file.name }, opts)
  await writeFileAtomic(
    path.join(outDir, 'chat_records', file.name),
    JSON.stringify(data, null, 2)
  )
}

async function pullLocalLogFile(outDir, file, opts) {
  const raw = await fs.readFile(path.join(LOG_DIR, file.name), 'utf-8')
  const content = opts.fullLogs ? raw : tailTextLines(raw, opts.logLines)
  await writeFileAtomic(path.join(outDir, 'logs', file.name), content)
}

async function pullRemoteLogFile(target, outDir, file, opts) {
  let content
  if (opts.fullLogs) {
    content = await pullRemoteFullLog(target, file, opts)
  } else {
    const result = await botRead(
      target, { action: 'log_tail', file: file.name, lines: opts.logLines }, opts
    )
    content = typeof result.content === 'string' ? result.content : ''
  }
  await writeFileAtomic(path.join(outDir, 'logs', file.name), content)
}

/** 分片往前拼接完整日志（单次 2MB，避免一次性 Buffer 过大）。 */
async function pullRemoteFullLog(target, file, opts) {
  let end = Number(file.size) || 0
  if (!end) {
    const info = await botRead(target, { action: 'log_tail', file: file.name, lines: 1 }, opts)
    end = Number(info.size) || 0
    if (!end) return ''
  }

  const chunks = []
  while (end > 0) {
    const result = await botRead(
      target,
      { action: 'log_back', file: file.name, offset: end, bytes: FULL_LOG_CHUNK_BYTES },
      opts
    )
    const content = typeof result.content === 'string' ? result.content : ''
    const next = Number(result.start)
    chunks.unshift(content)
    if (!Number.isFinite(next) || next >= end) break
    end = next
  }
  return chunks.join('')
}

/** 按已列好的清单下载该实例的文件，边下边报进度。 */
async function pullInstance(target, dirName, plan, opts) {
  const outDir = path.join(opts.outDir, dirName)
  const label = targetLabel(target)
  console.log(`[pull-bot-data] ${label} -> ${outDir} [${plan.source}]`)

  const manifest = {
    instance: {
      id: target.id,
      name: target.name,
      ip: target.ip,
      control_port: target.control_port,
      account: target.account || ''
    },
    source: plan.source,
    pulled_at: new Date().toISOString(),
    output_dir: outDir,
    since_days: opts.sinceDays,
    chat: {
      requested: opts.chat,
      limit: opts.chatLimit,
      files: [],
      remote_dir: plan.remoteDirs.chat
    },
    logs: {
      requested: opts.logs,
      limit: opts.logFiles,
      mode: opts.fullLogs ? 'full' : 'tail',
      lines: opts.fullLogs ? 0 : opts.logLines,
      files: [],
      remote_dir: plan.remoteDirs.logs
    },
    errors: [...plan.errors]
  }

  if (opts.dryRun) {
    manifest.chat.files = plan.chat.map((f) => ({ name: f.name }))
    manifest.logs.files = plan.logs.map((f) => ({ name: f.name }))
    return manifest
  }

  for (const file of plan.chat) {
    const name = String(file.name || '')
    if (!CHAT_FILE_RE.test(name)) continue
    try {
      if (plan.source === 'local') {
        await pullLocalChatFile(outDir, { ...file, name }, opts)
      } else {
        await pullRemoteChatFile(target, outDir, { ...file, name }, opts)
      }
      manifest.chat.files.push({ name, size: Number(file.size) || 0, mtime: file.mtime || '' })
      console.log(`[pull-bot-data]   聊天记录 ${name}`)
    } catch (error) {
      manifest.errors.push(`chat/${name}: ${error.message}`)
      console.error(`[pull-bot-data]   聊天记录失败 ${name}: ${error.message}`)
    }
    progressStep(`${target.name || target.ip} 聊天 ${name}`)
  }

  for (const file of plan.logs) {
    const name = String(file.name || '')
    if (!LOG_FILE_RE.test(name)) continue
    try {
      if (plan.source === 'local') {
        await pullLocalLogFile(outDir, { ...file, name }, opts)
      } else {
        await pullRemoteLogFile(target, outDir, { ...file, name }, opts)
      }
      manifest.logs.files.push({
        name,
        size: Number(file.size) || 0,
        mtime: file.mtime || '',
        mode: opts.fullLogs ? 'full' : 'tail'
      })
      console.log(`[pull-bot-data]   终端日志 ${name}`)
    } catch (error) {
      manifest.errors.push(`logs/${name}: ${error.message}`)
      console.error(`[pull-bot-data]   终端日志失败 ${name}: ${error.message}`)
    }
    progressStep(`${target.name || target.ip} 日志 ${name}`)
  }

  await writeFileAtomic(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

function selectTargets(selector) {
  const configured = getInstances()
  const localTarget = {
    id: 'local',
    name: '本机 Bot',
    ip: '127.0.0.1',
    control_port: 18810,
    account: '',
    token: ''
  }
  if (selector.toLowerCase() === 'all') {
    return configured.length ? configured : [localTarget]
  }
  if (selector.toLowerCase() === 'local') {
    return [localTarget]
  }
  const needle = selector.toLowerCase()
  const found = configured.find((item) => [
    item.id,
    item.name,
    item.ip,
    item.account
  ].some((value) => String(value || '').trim().toLowerCase() === needle))
  if (found) return [found]

  const available = configured.length
    ? configured.map((item) => `${item.id} (${item.name || item.ip})`).join(', ')
    : '无(可传 local)'
  throw new Error(`找不到实例: ${selector}; 可用实例: ${available}`)
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[pull-bot-data] 参数错误: ${error.message}`)
    printHelp()
    process.exit(2)
  }

  if (opts.help) {
    printHelp()
    return
  }

  if (opts.batch) {
    // dry-run 不能真去建目录（它的约定是"不产生任何副作用"）
    opts.outDir = opts.dryRun
      ? path.join(opts.outDir, batchDirName())
      : await claimBatchDir(opts.outDir)
    // 机器可读的批次目录，供网页后台任务解析后展示「结果在哪」
    console.log(`[BATCH] ${opts.outDir}`)
  }

  const targets = selectTargets(opts.instance)
  const dirNames = assignOutputDirs(targets)

  if (opts.dryRun) {
    // dry-run 不发任何请求（保持原语义）：只报会拉哪些实例、落到哪个目录
    console.log('[pull-bot-data] dry-run, 不发起任何请求')
    for (const target of targets) {
      console.log(`  - ${targetLabel(target)} -> ${path.join(opts.outDir, dirNames.get(target))}`
        + ` [${isLocalTarget(target) ? 'local' : 'remote'}]`)
    }
    console.log(`[pull-bot-data] dry-run 结束（聊天=${opts.chat} 日志=${opts.logs}`
      + ` 近${opts.sinceDays}天 日志模式=${opts.fullLogs ? '完整' : `尾部${opts.logLines}行`}）`)
    return
  }

  // 第一段：先列清单（每实例 2 次请求），这样进度总数是准的
  const plans = new Map()
  let total = 0
  for (const target of targets) {
    const plan = await planInstance(target, opts)
    plans.set(target, plan)
    total += plan.chat.length + plan.logs.length
  }

  progressStart(total, `准备拉取 ${targets.length} 个实例，共 ${total} 个文件`)

  // 第二段：逐个下载并报进度
  let failed = 0
  for (const target of targets) {
    const manifest = await pullInstance(target, dirNames.get(target), plans.get(target), opts)
    if (manifest.errors.length) failed++
  }

  if (failed) {
    console.error(`[pull-bot-data] 完成, ${failed}/${targets.length} 个实例有错误, 详见 manifest.json`)
    process.exit(1)
  }
  console.log(`[pull-bot-data] 完成, 共 ${targets.length} 个实例, ${total} 个文件`)
}

// 仅在「直接执行」时跑 main；被 import（单元测试）时不执行。
// 没有这道守卫的话，测试一 import 这个模块就会真的去拉数据。
const isDirectRun = !!process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[pull-bot-data] 异常: ${error.message}`)
    process.exit(1)
  })
}

// 导出纯函数供单元测试（不涉及 IO 的那几个）
export {
  parseFileDate, withinSinceDays, batchDirName, safeDirName, limitFiles,
  sortByNameDesc, claimBatchDir
}
