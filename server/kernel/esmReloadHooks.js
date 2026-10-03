/**
 * 插件后端热重载用的 ESM 模块钩子（只用 node: 内置，无新依赖）。
 *
 * 为什么需要它
 * ------------
 * ESM 模块表以「完整 URL」为键，给入口加 `?v=xxx` 只能让**入口**拿到新实例；
 * 入口里的相对说明符（`import './routes/x.js'`）会解析成**不带 query** 的 URL，
 * 于是子模块仍命中旧缓存 —— 实测：只改入口时，inquiry 的 12 个子模块、market 的 56 个文件
 * 全部不会更新，等于绝大多数改动刷不到。
 *
 * 做法：注册一个**同步 resolve 钩子**，仅当「父模块 URL 带重载标记」且「解析结果落在
 * 本次重载的插件目录内」时，给子模块 URL 补同一个标记，沿 import 图递归生效。
 *
 * 作用域红线
 * ----------
 * 插件目录之外（server/lib、其它插件、node_modules）一律不改写。
 * 否则 server/lib/botClient.js 会被重新实例化：插件里的 setBotVersionGuard 改的是新副本，
 * 内核持有的仍是旧副本，模块级全局单例就此分叉。
 */

import fs from 'node:fs'
import module from 'node:module'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT_DIR } from '../lib/config.js'

/** 重载标记的 query 参数名；带此参数的模块 URL 视为「本次重载的 import 图」 */
export const MARKER_KEY = '__rpa_reload'

// 插件自己的 .cjs 走 CommonJS 缓存，需要 require.cache 才能清（见 purgePluginCjsCache）
const require = createRequire(path.join(ROOT_DIR, 'server.js'))

/** token -> { raw, real } 两个目录前缀（raw 原路径；real 是 realpathSync 后的，兼容 macOS /var → /private/var 软链） */
const scopes = new Map()
let installed = false

/** 当前 Node 是否支持同步 resolve 钩子（Node ≥ 22.15）。不支持时调用方降级为「仅入口生效」。 */
export const deepReloadSupported = () => typeof module.registerHooks === 'function'

/**
 * 登记本次重载允许改写的目录。必须在 import 入口之前调用。
 * @param {string} token 本次重载的唯一标记
 * @param {string} dir 插件根目录（绝对路径）
 */
export function registerReloadScope(token, dir) {
  const raw = path.resolve(dir)
  let real = raw
  try {
    real = fs.realpathSync.native(raw)
  } catch {
    /* 目录不存在时退回 raw，交给下面的 startsWith 判断自然不匹配 */
  }
  const sep = path.sep
  scopes.set(token, {
    raw: raw.endsWith(sep) ? raw : raw + sep,
    real: real.endsWith(sep) ? real : real + sep
  })
}

/**
 * 安装重载钩子（幂等，只装一次）。返回是否支持「含子模块」的深度重载。
 * 钩子只在父模块 URL 带标记时才可能改写；普通 import 直接原样返回，零影响。
 */
export function installReloadHooks() {
  if (installed) return deepReloadSupported()
  installed = true
  if (typeof module.registerHooks !== 'function') return false

  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      try {
        const parent = context.parentURL || ''
        const at = parent.indexOf(`${MARKER_KEY}=`)
        if (at < 0) return result // 普通 import：完全不干预
        if (result.url.includes(`${MARKER_KEY}=`)) return result
        if (!result.url.startsWith('file:')) return result // 裸包名 / node: 内置
        const token = parent.slice(at + MARKER_KEY.length + 1).split('&')[0]
        const scope = scopes.get(token)
        if (!scope) return result

        const filePath = decodeURIComponent(new URL(result.url).pathname)
        let realPath = filePath
        try {
          realPath = fs.realpathSync.native(filePath)
        } catch {
          /* 文件可能尚未落盘；用原路径比对 */
        }
        // 目录外一律保持共享单例，绝不改写（见文件头的「作用域红线」）
        if (!filePath.startsWith(scope.raw) && !realPath.startsWith(scope.real)) {
          return result
        }
        const url = new URL(result.url)
        url.searchParams.set(MARKER_KEY, token)
        return { ...result, url: url.href, shortCircuit: true }
      } catch {
        return result // 钩子自身出错绝不阻断 import
      }
    }
  })
  return true
}

/**
 * 清掉插件目录内 .cjs 的 CommonJS 缓存，让它们也走新代码（ESM 的 ?v= 管不到 CJS）。
 * 只清插件自己目录下的；server/lib/pluginDataPaths.cjs 这类共享模块保持缓存不动。
 */
export function purgePluginCjsCache(pluginDir) {
  const prefix = pluginDir.endsWith(path.sep) ? pluginDir : pluginDir + path.sep
  const keys = Object.keys(require.cache).filter((k) => k.startsWith(prefix))
  for (const k of keys) delete require.cache[k]
  return keys.length
}
