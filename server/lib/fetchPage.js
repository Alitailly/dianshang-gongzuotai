/** server/lib/fetchPage.js — 美客多 HTML 解析与 CDP 抓取。 */
import net from 'net'
import path from 'path'
import { execFile } from 'child_process'
import { CDP_HOST, GALAXY_DIR, CHROME_EXEC } from './config.js'

// 美客多(Mercado Libre)站点域名(含南美各国后缀;巴西为 mercadolivre)
// [安全 P0-3] 必须整段匹配主机名，避免 evilmercadolivre.com 之类的后缀伪装；
// 允许任意子域(如 www./api.)。
const MERCADOLIVRE_RE = /^(?:[a-z0-9-]+\.)*(?:mercadolibre\.(?:com(?:\.[a-z]{2,3})?|[a-z]{2})|mercadolivre\.(?:com(?:\.[a-z]{2})?|[a-z]{2}))$/i

export function isMercadoLivreUrl(rawUrl) {
  try { return MERCADOLIVRE_RE.test(new URL(rawUrl).hostname) } catch { return false }
}

/** 从 HTML 提取美客多结构化规格: "attributes":[{id/text|name/value_name},...] (括号配对解析, 容错跳过坏段) */
export function extractAttributes(html) {
  const results = []
  const startMark = '"attributes":'
  let idx = 0
  while ((idx = html.indexOf(startMark, idx)) !== -1) {
    const arrStart = html.indexOf('[', idx + startMark.length)
    if (arrStart === -1) break
    let depth = 0
    let end = -1
    for (let i = arrStart; i < html.length; i++) {
      const ch = html[i]
      if (ch === '[') depth++
      else if (ch === ']') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) break
    const raw = html.slice(arrStart, end + 1)
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === 'object') {
            const k = item.id || item.name || item.attribute_id || ''
            const v = item.text || item.value_name || item.value || item.value_id || ''
            if (k && v) results.push({ k: String(k), v: String(v) })
          }
        }
      }
    } catch { /* 坏段跳过 */ }
    idx = end + 1
  }
  const seen = new Set()
  return results.filter(r => r.k && !seen.has(r.k) && seen.add(r.k))
}

/**
 * 提取商品主图(美客多, 优先级从高到低):
 * 1. img.ui-pdp-gallery__figure__image(图册标准 class, data-index=0 即主图;取 data-zoom 高清/原图 src)
 * 2. "pictures" JSON 图册第一张
 * 3. -O 原图 URL(http2.mlstatic.com/...-O.webp)
 * 4. og:image(兜底——部分页面 og:image 可能是广告图)
 */
export function extractMainImage(html, mainImg, ogImage) {
  if (mainImg && /^https?:\/\//i.test(mainImg)) return mainImg
  const pm = html.match(/"pictures":\[\s*\{[^}]*?"url"\s*:\s*"([^"]+)"/)
  if (pm) return String(pm[1]).replace(/\\u002F/g, '/')
  const om = html.match(/https?:\/\/http2\.mlstatic\.com\/[^"'\\\s]+-O\.(?:webp|jpg|jpeg|png)/i)
  if (om) return om[0]
  if (ogImage && /^https?:\/\//i.test(ogImage)) return ogImage
  return ''
}

/** 从 HTML 提取基础信息(标题/描述/正文/主图) */
export function extractBasic(html) {
  const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const m = (re) => { const x = html.match(re); return x ? x[1] : '' }
  const title = strip(m(/<title[^>]*>([^<]*)<\/title>/i)) || strip(m(/property="og:title" content="([^"]*)"/i))
  const text = strip(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '))
  return {
    title,
    description: m(/name="description" content="([^"]*)"/i),
    h1: strip(m(/<h1[^>]*>([\s\S]*?)<\/h1>/i)),
    ogImage: m(/property="og:image" content="([^"]*)"/i),
    text: text.slice(0, 100000),
    length: text.length
  }
}

/** 从 HTML 的 JSON 数据提取价格三件套(美客多稳定字段): price/original_price/discount/currency_id */
export function extractPriceData(html) {
  const num = (k) => { const m = html.match(new RegExp('"' + k + '"\\s*:\\s*([\\d.]+)')); return m ? m[1] : '' }
  const str = (k) => { const m = html.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]+)"')); return m ? m[1] : '' }
  const price = num('price')
  const originalPrice = num('original_price')
  const discountPct = str('discount')
  const currency = str('currency_id')
  const symbol = currency === 'BRL' ? 'R$' : (currency ? currency + ' ' : '')
  const fmt = (v) => (v ? `${symbol}${v.includes('.') ? v.replace('.', ',') : v}` : '')
  return { price: fmt(price), originalPrice: fmt(originalPrice), discountPct }
}

/** 探测端口是否存活(CDP /json) */
export async function portAlive(p) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const r = await fetch(`http://${CDP_HOST}:${p}/json`, { signal: controller.signal })
    clearTimeout(timer)
    return r.ok
  } catch { return false }
}

/** 网页抓取专用端口(2026-09-28 用户决策:该功能只在 18804 上运行) */
export const FETCH_PORT = 18804

/**
 * 自动启动 18804 并等待就绪, 成功返回 true(2026-08-06 D2)。
 * [2026-09-28] 已不再被 pickFetchPort 自动调用:抓取端口没打开时要求直接报错拒绝执行,
 * 不允许门户自行拉起 Chrome(会在桌面弹出 about:blank 窗口)。保留该能力供人工调用。
 */
export async function autoLaunchFetchPort() {
  try {
    await new Promise((resolve, reject) => {
      if (CHROME_EXEC) {
        execFile(CHROME_EXEC, [String(FETCH_PORT)], { cwd: path.dirname(CHROME_EXEC), timeout: 20000 }, (err) => {
          if (err) reject(err); else resolve()
        })
      } else {
        execFile('python3', ['launch_chrome.py', String(FETCH_PORT)], { cwd: GALAXY_DIR, timeout: 20000 }, (err) => {
          if (err) reject(err); else resolve()
        })
      }
    })
    // 轮询等待端口就绪(≤10s)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (await portAlive(FETCH_PORT)) return true
    }
    return false
  } catch (e) {
    console.warn(`[fetch-page] 自动启动 ${FETCH_PORT} 失败:`, e.message)
    return false
  }
}

/**
 * 选抓取端口:只认 18804;端口没打开则返回 null,由调用方报错拒绝执行。
 * [2026-09-28] 取消两种兜底——「借 18800-18803 询盘端口」会干扰正在跑的询盘任务,
 * 「自动拉起 18804」会在桌面上弹出 about:blank 的 Chrome 窗口。
 */
export async function pickFetchPort() {
  return (await portAlive(FETCH_PORT)) ? FETCH_PORT : null
}

// CDP 超时常量。Chrome 端口"TCP 可连但不响应"(假死/被防火墙吞包)是真实会发生的状态：
// 那时 /json/version、WebSocket 握手、send() 都不会 resolve 也不会 reject，
// 没有超时就会把该 Express 请求连同 socket 永久挂住，用户重复点击还会不断累积。
const CDP_HTTP_TIMEOUT_MS = 5000
const CDP_WS_TIMEOUT_MS = 5000
const CDP_CMD_TIMEOUT_MS = 15000

/** 给任意 Promise 加超时(超时后 reject，不再永久 pending) */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms) })
  ]).finally(() => clearTimeout(timer))
}

/** 带超时的 fetch + json 解析 */
async function fetchJson(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  return r.json()
}

/**
 * 建一条 CDP 命令通道(WebSocket + 请求/应答配对)。
 * 每个命令都带超时；socket 出错/关闭时把在途命令一并 reject，
 * 避免调用方永久等待一个永远不会到来的应答。
 */
function openCdpChannel(ws) {
  let seq = 0
  const pend = new Map()

  /**
   * 结算一条在途命令:ok=true → resolve(p.res), ok=false → reject(p.rej)。
   * [2026-09-28 修复] 原实现把回调当参数传进来再调用(fn(arg))，而收到应答时传的是恒等函数
   * `(v) => v` —— 等于把应答直接丢掉，promise 永不 settle；等定时器到点时该条目已被 delete，
   * settle 提前 return，连 reject 都补不上。结果每条 CDP 命令都会永久挂起(创建出的抓取标签
   * 也因此永远等不到回收)。改为由 settle 直接调用该条目自己的 res/rej。
   */
  const settle = (key, ok, arg) => {
    const p = pend.get(key)
    if (!p) return
    pend.delete(key)
    clearTimeout(p.timer)
    if (ok) p.res(arg)
    else p.rej(arg)
  }

  const call = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq
    if (!ws || ws.readyState !== 1) {
      rej(new Error(`CDP ${method} 失败: WebSocket 未就绪`))
      return
    }
    pend.set(i, {
      res,
      rej,
      timer: setTimeout(() => settle(i, false, new Error(`CDP ${method} 超时(${CDP_CMD_TIMEOUT_MS}ms)`)), CDP_CMD_TIMEOUT_MS)
    })
    try {
      ws.send(JSON.stringify({ id: i, method, params }))
    } catch (e) {
      settle(i, false, e)
    }
  })

  ws.onmessage = (e) => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.method === 'Page.loadEventFired') settle('__load', true, true)
    if (m.id && pend.has(m.id)) settle(m.id, true, m)
  }
  // 连接断开:在途命令立刻失败,而不是挂到各自的超时
  ws.onclose = () => { for (const k of [...pend.keys()]) settle(k, false, new Error('CDP 连接已关闭')) }
  let rejectOpened = null
  ws.onerror = () => {
    const err = new Error('CDP WebSocket 连接错误')
    rejectOpened?.(err)
    for (const k of [...pend.keys()]) settle(k, false, err)
  }

  const opened = withTimeout(
    new Promise((res, rej) => {
      rejectOpened = rej
      ws.onopen = res
      if (ws.readyState === 1) res()
    }),
    CDP_WS_TIMEOUT_MS,
    'CDP WebSocket 握手'
  )

  /** 等 Page.loadEventFired；超时返回 false（原逻辑就是"最多等 15s 后照常继续提取"） */
  const waitLoad = (ms) => withTimeout(
    new Promise((res) => pend.set('__load', { res: () => res(true), rej: () => res(true), timer: null })),
    ms,
    'Page.loadEventFired'
  ).catch(() => false)

  /** 通道用完：关掉 socket，并在途命令立即失败 */
  const close = () => {
    try { ws.close() } catch { /* 忽略 */ }
    // 注意 settle 的第二个参数是「是否成功」:传 false 才会 reject。
    // 旧写法 settle(k, (e) => e, err) 在改造后会被当成 truthy → 把在途命令"成功"结算成
    // 一个 Error 对象,调用方拿到的是错误对象当结果用(与注释「立即失败」相反)。
    for (const k of [...pend.keys()]) settle(k, false, new Error('CDP 通道已关闭'))
  }

  return { call, opened, waitLoad, close }
}

/** CDP 渲染抓取: 新 tab → 导航 → 等渲染 → 提取(DOM + outerHTML 供 attributes 解析) */
export async function cdpFetchPage(url) {
  const port = await pickFetchPort()
  if (!port) return null
  const base = `http://${CDP_HOST}:${port}`
  const info = await fetchJson(`${base}/json/version`, CDP_HTTP_TIMEOUT_MS)
  const ws = new WebSocket(info.webSocketDebuggerUrl)
  const { call: send, opened: wsOpened, close: wsClose } = openCdpChannel(ws)
  await wsOpened

  // [2026-09-28] 新建标签之后的每一步(取 /json、找 target、建页面通道、WS 握手)都可能抛错。
  // 这些步骤原先写在 try 之外，一旦抛错就跳过 finally，把 about:blank 标签永久留在浏览器里
  // (路由还会重试一次，一次点击最多漏两个)。现在 targetId 一拿到就进 try，finally 无条件回收。
  let targetId = ''
  let twsClose = () => {}
  try {
      targetId = (await send('Target.createTarget', { url: 'about:blank' })).result.targetId
      const tabs = await fetchJson(`${base}/json`, CDP_HTTP_TIMEOUT_MS)
      const tab = tabs.find(t => t.id === targetId)
      if (!tab) throw new Error('CDP tab 创建失败')

      const tws = new WebSocket(tab.webSocketDebuggerUrl)
      const { call: tsend, opened: twsOpened, waitLoad, close } = openCdpChannel(tws)
      twsClose = close
      await twsOpened

      await tsend('Page.enable')
      const loadP = waitLoad(15000)
      await tsend('Page.navigate', { url })
      await loadP
      // 轮询等待页面内容出现(h1 或正文>500字,最多 12s)——SPA 渐进渲染需要足够缓冲
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const chk = await tsend('Runtime.evaluate', {
          expression: `document.querySelector('h1') || (document.body && document.body.innerText.length > 500) ? 'ready' : ''`,
          returnByValue: true
        }).catch(() => ({}))
        if (chk.result && chk.result.result && chk.result.result.value) break
      }
      // 额外:等待规格区渲染(美客多 "Características" 规格区/attributes 标记出现,最多 8s)
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const chk = await tsend('Runtime.evaluate', {
          expression: `(document.body && (document.body.innerText.includes('Caracter') || document.documentElement.outerHTML.includes('"attributes"'))) ? 'specs' : ''`,
          returnByValue: true
        }).catch(() => ({}))
        if (chk.result && chk.result.result && chk.result.result.value) break
      }

      const evalJs = `(() => {
        const q = (s) => document.querySelector(s)
        // 商品主图: 美客多图册标准 class ui-pdp-gallery__figure__image(data-index=0 即主图)
        // 取 data-zoom(2X 高清) 优先, 其次 src(-O 原图), 最后 currentSrc
        const mainImg = (() => {
          const el = q('img.ui-pdp-gallery__figure__image')
          if (!el) return ''
          return el.getAttribute('data-zoom') || el.getAttribute('src') || el.currentSrc || ''
        })()
        const imgs = [...document.querySelectorAll('img')].map(i => i.currentSrc || i.src).filter(s => s && s.startsWith('http'))
        const tables = []
        document.querySelectorAll('table').forEach(t => {
          const rows = []
          t.querySelectorAll('tr').forEach(tr => {
            const c = [...tr.querySelectorAll('th,td')].map(x => x.innerText.trim())
            if (c.length >= 2) rows.push(c)
          })
          if (rows.length >= 2) tables.push({ rows: rows.slice(0, 100) })
        })
        return JSON.stringify({
          title: document.title,
          h1: q('h1') ? q('h1').innerText.trim().slice(0, 300) : '',
          ogTitle: q('meta[property="og:title"]') ? q('meta[property="og:title"]').content : '',
          ogImage: q('meta[property="og:image"]') ? q('meta[property="og:image"]').content : '',
          mainImg,
          // 价格三件套: 折扣价(主价格行) / 原价(--previous 划线) / 折扣百分比
          price: (() => {
            const el = q('.ui-pdp-price__second-line .andes-money-amount') || q('.andes-money-amount--cents-superscript') || q('.andes-money-amount')
            return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''
          })(),
          originalPrice: (() => {
            const el = q('.andes-money-amount--previous')
            return el ? el.innerText.replace(/\s+/g, ' ').trim() : ''
          })(),
          discountPct: (() => {
            const el = q('.ui-pdp-price__percentage')
            return el ? el.innerText.trim() : ''
          })(),
          images: [...new Set(imgs)].slice(0, 50),
          tables,
          html: document.documentElement.outerHTML
        })
      })()`
      const ev = await tsend('Runtime.evaluate', { expression: evalJs, returnByValue: true })
      const data = JSON.parse(ev.result.result.value)
      // 反爬验证页检测(美客多 "Seguridad/Security" 验证页)
      const blockedTitle = /(seguridad|security|verificaci|robot|não somos robô|no somos robots)/i.test(data.title || '') ||
                           /(seguridad|security|verificaci)/i.test(data.h1 || '')
      if (blockedTitle || (data.title && data.title.trim() && !data.h1 && (data.html || '').length < 100)) {
        return { blocked: true, title: data.title || '', port, text: (data.html || '').slice(0, 500) }
      }
      const basic = extractBasic(data.html)
      const mainImage = extractMainImage(data.html, data.mainImg, data.ogImage || basic.ogImage)
      // 价格: JSON 稳定字段优先, DOM 提取兜底
      const pd = extractPriceData(data.html)
      const price = pd.price || data.price || ''
      const originalPrice = pd.originalPrice || data.originalPrice || ''
      const discountPct = pd.discountPct || data.discountPct || ''
      return {
        title: basic.title || data.title,
        description: basic.description,
        h1: data.h1 || basic.h1,
        ogImage: mainImage,
        price,
        originalPrice,
        discountPct,
        images: mainImage ? [mainImage] : [], // [2026-08-06] 仅商品主图(ui-pdp-gallery class 优先)
        tables: data.tables,
        attributes: extractAttributes(data.html),
        text: basic.text,
        length: basic.length
      }
  } finally {
    // targetId 为空 = createTarget 本身没成功,无需回收
    if (targetId) {
      try { await send('Target.closeTarget', { targetId }) } catch { /* 忽略 */ }
    }
    twsClose()
    wsClose()
  }
}
