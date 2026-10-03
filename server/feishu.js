/**
 * 飞书多维表格服务(仅服务端使用,密钥在 server/feishu.config.json,已 gitignore)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FEISHU_CONFIG as config } from './lib/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let tokenCache = { token: null, expireAt: 0 }
let tokenRefreshPromise = null // 并发刷新锁:多个请求同时发现 token 过期时共享同一次刷新

async function getTenantToken() {
  if (!config) throw new Error('飞书配置缺失,请检查 server/feishu.config.json')
  if (tokenCache.token && Date.now() < tokenCache.expireAt - 60_000) {
    return tokenCache.token
  }
  // [2026-08-13] 并发刷新锁:token 过期瞬间的多个并发请求共享同一次刷新,避免重复调飞书
  if (tokenRefreshPromise) return tokenRefreshPromise
  tokenRefreshPromise = (async () => {
    try {
      const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: config.FEISHU_APP_ID, app_secret: config.FEISHU_APP_SECRET })
      })
      const data = await res.json()
      if (data.code !== 0) {
        throw new Error(`飞书 token 获取失败: ${data.msg || JSON.stringify(data)}`)
      }
      tokenCache = {
        token: data.tenant_access_token,
        expireAt: Date.now() + (data.expire || 7200) * 1000
      }
      return tokenCache.token
    } finally {
      tokenRefreshPromise = null
    }
  })()
  return tokenRefreshPromise
}

const FEISHU_DATA_NOT_READY_RETRIES = 5
const FEISHU_RETRY_BASE_MS = 500

async function feishuApi(pathname, options = {}) {
  // [2026-08-13] 429/5xx 重试:飞书限流(429)与偶发服务端错误(5xx)自动退避重试
  // [2026-09] "Data not ready" 是 Bitable 新建表/刚写入后常见的短暂未就绪错误,
  //          实际数据往往已经可用,因此单独放宽重试次数,避免前端误报"加载失败"。
  let lastError = null
  for (let attempt = 1; attempt <= FEISHU_DATA_NOT_READY_RETRIES; attempt++) {
    const token = await getTenantToken()
    const res = await fetch(`https://open.feishu.cn/open-apis${pathname}`, {
      method: options.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: options.body || undefined
    })
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`飞书 API 限流/服务错误 HTTP ${res.status}(${pathname})`)
      if (attempt < FEISHU_DATA_NOT_READY_RETRIES) {
        await new Promise(r => setTimeout(r, FEISHU_RETRY_BASE_MS * attempt))
        continue
      }
      throw lastError
    }
    const data = await res.json()
    if (data.code !== 0) {
      const msg = String(data.msg || '')
      const dataNotReady = /Data not ready|try again later/i.test(msg)
      if (dataNotReady && attempt < FEISHU_DATA_NOT_READY_RETRIES) {
        lastError = new Error(`飞书 API 数据未就绪: ${msg || JSON.stringify(data)}`)
        await new Promise(r => setTimeout(r, FEISHU_RETRY_BASE_MS * attempt))
        continue
      }
      throw new Error(`飞书 API 失败: ${msg || JSON.stringify(data)}`)
    }
    return data.data
  }
  throw lastError
}

/** 创建多维表格记录(2026-08-06: 网页抓取写入初筛表用) */
export async function createRecord(appToken, tableId, fields) {
  const data = await feishuApi(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    body: JSON.stringify({ fields })
  })
  return data.record
}

/** 更新多维表格记录的指定字段(2026-09-16: 自动询盘回报率测算表「预期月销量」网页编辑同步) */
export async function updateRecord(appToken, tableId, recordId, fields) {
  const data = await feishuApi(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT',
    body: JSON.stringify({ fields })
  })
  return data.record
}

/** 上传图片到飞书(bitable 附件字段用), 返回 file_token(2026-08-06) */
export async function uploadMedia(buffer, fileName, mimeType, appToken = config?.FEISHU_APP_TOKEN) {
  if (!config) throw new Error('飞书配置缺失')
  const token = await getTenantToken()
  const fd = new FormData()
  fd.append('file_name', fileName)
  fd.append('parent_type', 'bitable_image')
  fd.append('parent_node', appToken)
  fd.append('size', String(buffer.length))
  fd.append('file', new Blob([buffer], { type: mimeType }), fileName)
  const res = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd
  })
  const data = await res.json()
  if (data.code !== 0) throw new Error(`飞书图片上传失败: ${data.msg || JSON.stringify(data)}`)
  return data.data.file_token
}

/** 删除多维表格记录(2026-08-06: 查询表格右键删除用) */
export async function deleteRecord(appToken, tableId, recordId) {
  await feishuApi(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'DELETE'
  })
  return true
}

/** 列出多维表格下所有表格(2026-08-06: 查询表格"其他表格"下拉用) */
export async function listTables(appToken) {
  const tables = []
  let pageToken = ''
  do {
    const query = pageToken ? `?page_token=${pageToken}` : '?page_size=100'
    const data = await feishuApi(`/bitable/v1/apps/${appToken}/tables${query}`)
    tables.push(...(data.items || []).map(t => ({ table_id: t.table_id, name: t.name })))
    pageToken = data.has_more ? data.page_token : ''
  } while (pageToken)
  return tables
}

/** 表别名 → { app_token, table_id, view_id } 映射(接口层白名单,防止任意表名注入) */
const makeTableConfig = (appToken, tableId, viewId = '') => ({ app_token: appToken, table_id: tableId, view_id: viewId })

export const BITABLE_TABLES = {
  screening: makeTableConfig(config?.SCREENING_APP_TOKEN || config?.FEISHU_APP_TOKEN, config?.SCREENING_TABLE_ID, config?.SCREENING_VIEW_ID),
  final: makeTableConfig(config?.FINAL_APP_TOKEN || config?.FEISHU_APP_TOKEN, config?.FINAL_TABLE_ID, config?.FINAL_VIEW_ID),
  products: makeTableConfig(config?.PRODUCTS_APP_TOKEN || config?.FEISHU_APP_TOKEN, config?.PRODUCTS_TABLE_ID, config?.PRODUCTS_VIEW_ID), // 产品参数总表(询盘汇总,按产品名"名称"字段筛选)
  // 人工选品登记表。注意:「添加询盘记录」自 2026-09-28 起改为直接写 screening 表,
  // 此表仅保留给其它调用方读写(其「推荐人」是人员字段、「产品编号」是自动编号字段,写入限制见 routes/inquiry.js)
  inquiry_records: makeTableConfig(config?.SCREENING_APP_TOKEN || config?.FEISHU_APP_TOKEN, config?.INQUIRY_RECORDS_TABLE_ID)
}

/** 根据主表别名或 table_id 获取表配置;自定义 tbl 开头的表默认使用 FEISHU_APP_TOKEN */
export function getTableConfig(keyOrTableId) {
  const known = BITABLE_TABLES[keyOrTableId]
  if (known) return known
  if (/^tbl[A-Za-z0-9]+$/.test(String(keyOrTableId))) {
    return makeTableConfig(config?.FEISHU_APP_TOKEN, keyOrTableId)
  }
  return null
}

/** 表数据内存缓存(appToken:tableId → { data, expireAt })，TTL 60s：减少频繁进入页面的飞书往返等待 */
const TABLE_CACHE_TTL_MS = 60_000
const tableCache = new Map()
const cacheKey = (appToken, tableId) => `${appToken}:${tableId}`

/** 清空指定表的缓存(表数据被外部更新后调用,确保下次读取拉到最新);不传 tableId 清空全部 */
export function clearTableCache(tableId, appToken) {
  if (!tableId) {
    tableCache.clear()
    return
  }
  if (appToken) {
    tableCache.delete(cacheKey(appToken, tableId))
    return
  }
  // 未传 appToken 时按 tableId 后缀清理,兼容旧调用
  for (const key of tableCache.keys()) {
    if (key.endsWith(`:${tableId}`)) tableCache.delete(key)
  }
}

/** 读取指定多维表格:表结构 + 全部记录(字段/记录并行拉取,分页 page_size=500,带内存缓存) */
export async function getBitableTable(tableId, { forceRefresh = false, appToken } = {}) {
  if (!config) throw new Error('飞书配置缺失')
  const resolvedAppToken = appToken || getTableConfig(tableId)?.app_token || config.FEISHU_APP_TOKEN
  const key = cacheKey(resolvedAppToken, tableId)

  // 缓存命中(且未过期)直接返回,秒开;点「刷新」传 forceRefresh 绕过缓存
  if (!forceRefresh) {
    const hit = tableCache.get(key)
    if (hit && Date.now() < hit.expireAt) return { ...hit.data, fromCache: true }
  }

  // 字段结构与全部记录并行拉取(原先串行,省一次往返)
  const [fieldsData, rawRecords] = await Promise.all([
    feishuApi(`/bitable/v1/apps/${resolvedAppToken}/tables/${tableId}/fields?page_size=100`),
    (async () => {
      const records = []
      let pageToken = ''
      do {
        const query = pageToken ? `&page_token=${pageToken}` : ''
        const data = await feishuApi(`/bitable/v1/apps/${resolvedAppToken}/tables/${tableId}/records?page_size=500${query}`)
        records.push(...(data.items || []))
        pageToken = data.has_more ? data.page_token : ''
      } while (pageToken)
      return records
    })()
  ])

  const fields = (fieldsData.items || []).map(f => ({ name: f.field_name, type: f.type }))
  const data = {
    fields,
    records: rawRecords.map(r => ({ recordId: r.record_id, fields: r.fields })),
    total: rawRecords.length
  }

  tableCache.set(key, { data, expireAt: Date.now() + TABLE_CACHE_TTL_MS })
  return { ...data, fromCache: false }
}

/** 图片内存缓存(fileToken → { buffer, contentType, expireAt })，TTL 1h：避免每次进入页面都从飞书重复下载 */
const MEDIA_CACHE_TTL_MS = 60 * 60 * 1000
const MEDIA_CACHE_MAX = 500 // 缓存条目上限,超出淘汰最旧
const mediaCache = new Map()

// ---- 磁盘图片缓存(持久化到 server/cache/media/,重启不丢) ----
// 同一张图第一次从飞书下载后落盘,之后任何人/任何时间打开都直接读本地文件,不再请求飞书
const MEDIA_CACHE_DIR = path.join(__dirname, 'cache', 'media')
const MEDIA_CACHE_MAX_FILES = 2000 // 磁盘文件上限,超出清理最旧的 10%
// [P1 安全] 媒体代理只允许安全的位图 MIME；不再支持 image/svg+xml（可内嵌脚本 → 存储型 XSS）
const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
])
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
}
const diskMediaIndex = new Map() // fileToken -> { ext, contentType } 惰性记录,避免每次探测

function normalizeMediaType(contentType) {
  const raw = String(contentType || '').split(';')[0].trim().toLowerCase()
  return ALLOWED_MEDIA_TYPES.has(raw) ? raw : 'application/octet-stream'
}

function mediaFilePath(fileToken, ext) {
  // 纵深防御:即使调用方未校验,也必须落在缓存目录内(防路径穿越)
  const p = path.resolve(MEDIA_CACHE_DIR, `${fileToken}${ext || ''}`)
  if (p !== MEDIA_CACHE_DIR && !p.startsWith(MEDIA_CACHE_DIR + path.sep)) {
    throw new Error(`非法 fileToken: ${fileToken}`)
  }
  return p
}

/** 从磁盘读图片缓存;命中返回 { buffer, contentType },未命中返回 null */
function readDiskMedia(fileToken) {
  const known = diskMediaIndex.get(fileToken)
  if (known) {
    const p = mediaFilePath(fileToken, known.ext)
    try {
      if (fs.existsSync(p)) return { buffer: fs.readFileSync(p), contentType: normalizeMediaType(known.contentType) }
    } catch { /* 继续探测 */ }
  }
  // [P1 安全] 不再探测 .svg（历史上缓存的 SVG 忽略，重新走飞书下载并归一化为 octet-stream）
  const candidates = ['.jpg', '.png', '.gif', '.webp', '.bmp', '']
  for (const ext of candidates) {
    const p = mediaFilePath(fileToken, ext)
    try {
      if (fs.existsSync(p)) {
        const contentType = Object.keys(EXT_BY_TYPE).find(k => EXT_BY_TYPE[k] === ext) || (ext === '' ? 'application/octet-stream' : 'image/jpeg')
        diskMediaIndex.set(fileToken, { ext, contentType })
        return { buffer: fs.readFileSync(p), contentType }
      }
    } catch { /* 继续 */ }
  }
  return null
}

/** 图片落盘;失败不影响主流程 */
function writeDiskMedia(fileToken, buffer, contentType) {
  try {
    fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true })
    // 只给白名单位图分配扩展名，其余统一落成无扩展名，读取时按 application/octet-stream 处理
    const normalizedType = normalizeMediaType(contentType)
    const ext = EXT_BY_TYPE[normalizedType] || ''
    const p = mediaFilePath(fileToken, ext)
    if (fs.existsSync(p)) return
    fs.writeFileSync(p, buffer)
    diskMediaIndex.set(fileToken, { ext, contentType: normalizedType })
    // 超出文件数上限时清理最旧的 10%
    try {
      const files = fs.readdirSync(MEDIA_CACHE_DIR).map(f => ({ f, t: fs.statSync(path.join(MEDIA_CACHE_DIR, f)).mtimeMs }))
      if (files.length > MEDIA_CACHE_MAX_FILES) {
        files.sort((a, b) => a.t - b.t)
        for (const old of files.slice(0, Math.floor(files.length * 0.1))) {
          fs.unlinkSync(path.join(MEDIA_CACHE_DIR, old.f))
        }
      }
    } catch { /* 清理失败忽略 */ }
  } catch (e) {
    console.warn('[feishu] 图片磁盘缓存写入失败:', e.message)
  }
}

/** 下载附件图片(鉴权代理;飞书偶发 400 自动重试 3 次;读取顺序:内存缓存 → 磁盘缓存 → 飞书下载后落盘) */
export async function downloadMedia(fileToken, extra = '') {
  const cacheKey = `${fileToken}:${extra || ''}`
  const hit = mediaCache.get(cacheKey)
  if (hit && Date.now() < hit.expireAt) return hit

  // 磁盘缓存:本地已有图片直接返回,不再请求飞书
  const disk = readDiskMedia(fileToken)
  if (disk) {
    const result = { buffer: disk.buffer, contentType: disk.contentType }
    mediaCache.set(cacheKey, { ...result, expireAt: Date.now() + MEDIA_CACHE_TTL_MS })
    return result
  }

  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const token = await getTenantToken()
      const url = new URL(`https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`)
      if (extra) url.searchParams.set('extra', extra)
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const result = {
        buffer,
        // [P1 安全] 远端 MIME 白名单：非位图（含 svg）统一降级为 application/octet-stream
        contentType: normalizeMediaType(res.headers.get('content-type'))
      }
      // 写入内存缓存(超出上限时淘汰最旧的一条)
      if (mediaCache.size >= MEDIA_CACHE_MAX) {
        const oldestKey = mediaCache.keys().next().value
        if (oldestKey !== undefined) mediaCache.delete(oldestKey)
      }
      mediaCache.set(cacheKey, { ...result, expireAt: Date.now() + MEDIA_CACHE_TTL_MS })
      // 落盘:下次(含重启后)直接读本地,不请求飞书
      writeDiskMedia(fileToken, buffer, result.contentType)
      return result
    } catch (error) {
      lastError = error
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt))
      }
    }
  }
  throw new Error(`图片下载失败: ${lastError.message}`)
}
