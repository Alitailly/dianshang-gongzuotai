/** server/lib/security.js — SSRF 防护、URL 校验与受限下载。 */
import net from 'net'
import dns from 'dns/promises'
import { MAX_REDIRECTS, MAX_IMAGE_SIZE, DOWNLOAD_TIMEOUT_MS } from './config.js'

/** 把 IPv6 展开成 8 个 16-bit 分组；解析失败返回 null（支持压缩 :: 与十六进制形式） */
function expandIPv6(ip) {
  let s = String(ip || '').toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone) // 去掉 zone id
  s = s.replace(/^\[|\]$/g, '')
  if (!s.includes(':')) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part) => {
    if (!part) return []
    const out = []
    for (const h of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null
      out.push(parseInt(h, 16))
    }
    return out
  }
  const head = parseGroups(halves[0])
  const tail = halves.length === 2 ? parseGroups(halves[1]) : []
  if (!head || !tail) return null
  if (halves.length === 1) {
    if (head.length !== 8) return null
    return head
  }
  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...new Array(missing).fill(0), ...tail]
}

/** 由 IPv6 最后两个分组还原内嵌 IPv4 点分形式 */
function groupsToIPv4(groups) {
  const n = (((groups[6] << 16) >>> 0) + groups[7]) >>> 0
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
}

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 共享地址
    if (a === 169 && b === 254) return false // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0) return false // 192.0.0.0/24、192.0.2.0/24 保留/文档
    if (a === 198 && (b === 18 || b === 19)) return false // 基准测试 198.18.0.0/15
    if (a === 198 && b === 51) return false // 文档 198.51.100.0/24
    if (a === 203 && b === 0) return false // 文档 203.0.113.0/24
    if (a >= 224) return false // 组播/保留
    return true
  }
  if (net.isIPv6(ip)) {
    const raw = String(ip).toLowerCase()
    // 点分形式的 IPv4-mapped/compatible，如 ::ffff:1.2.3.4（net.isIPv6 已校验过）
    const dotted = raw.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (dotted && net.isIPv4(dotted[1])) return isPublicIp(dotted[1])

    const g = expandIPv6(raw)
    if (!g) return false
    // :: 与 ::1
    if (g.every(x => x === 0)) return false
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return false
    // IPv4-mapped ::ffff:a.b.c.d（含 ::ffff:7f00:1 / 0:0:0:0:0:ffff:7f00:1 等压缩/十六进制形式）
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
      return isPublicIp(groupsToIPv4(g))
    }
    // IPv4-compatible ::a.b.c.d（已废弃，仍可能指向 127/私有网段）
    if (g.slice(0, 6).every(x => x === 0)) {
      return isPublicIp(groupsToIPv4(g))
    }
    // NAT64 64:ff9b::/96
    if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
      return isPublicIp(groupsToIPv4(g))
    }
    if ((g[0] & 0xfe00) === 0xfc00) return false // ULA fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return false // 链路本地 fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return false // 站点本地(废弃) fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return false // 组播 ff00::/8
    if (g[0] === 0x2001 && g[1] === 0x0db8) return false // 文档 2001:db8::/32
    if (g[0] === 0x2002) return false // 6to4 2002::/16
    if (g[0] === 0x2001 && g[1] === 0x0000) return false // Teredo 2001::/32
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false // 丢弃前缀 100::/64
    if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return false // ORCHID 2001:10::/28、2001:20::/28
    return true
  }
  return false
}

export async function isSafeUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(hostname)) return isPublicIp(hostname)

  try {
    const records = await dns.lookup(hostname, { all: true })
    if (records.length === 0) return false
    return records.every(r => isPublicIp(r.address))
  } catch {
    return false
  }
}

// 不含 svg+xml：SVG 可内嵌 <script>，一旦落到同源的静态目录即是存储型 XSS。
// server/feishu.js 早就明确禁用了 SVG，这里保持一致（原先两份策略互相矛盾）。
const IMAGE_CONTENT_TYPE = /^image\/(?:avif|bmp|gif|jpeg|png|webp)$/i

/** 下载并限制:重定向次数、超时、大小上限;每次跳转前重新做 SSRF 检查 */
export async function downloadWithLimits(startUrl, { maxBytes = MAX_IMAGE_SIZE, allowedContentType, headers = {} } = {}) {
  let currentUrl = startUrl
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!(await isSafeUrl(currentUrl))) {
      throw new Error('URL 不合法或指向内网地址')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    let response
    try {
      // 注意：这里不能再传 `agent`——Node 内置 fetch(undici) 不识别该选项，
      // 传了会被静默忽略。自签名证书场景由 config.js 的 ALLOW_INSECURE_HTTPS
      // 通过 NODE_TLS_REJECT_UNAUTHORIZED 处理。
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers
      })
    } catch (error) {
      clearTimeout(timer)
      throw error
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer)
      const location = response.headers.get('location')
      if (!location) throw new Error('重定向目标缺失')
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    if (!response.ok) {
      clearTimeout(timer)
      throw new Error(`下载失败: ${response.status} ${response.statusText}`)
    }
    const contentType = response.headers.get('content-type') || ''
    if (allowedContentType && !allowedContentType.test(contentType)) {
      clearTimeout(timer)
      throw new Error(`下载内容类型不允许：${contentType || '未提供 Content-Type'}`)
    }
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      clearTimeout(timer)
      throw new Error(`文件超过大小限制 ${maxBytes / 1024 / 1024}MB`)
    }

    try {
      const chunks = []
      let total = 0
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > maxBytes) {
          throw new Error(`文件超过大小限制 ${maxBytes / 1024 / 1024}MB`)
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`)
}

/** 仅接受常见图片 MIME 类型的受限下载。 */
export function downloadImageWithLimits(url, options = {}) {
  return downloadWithLimits(url, { ...options, allowedContentType: IMAGE_CONTENT_TYPE })
}
