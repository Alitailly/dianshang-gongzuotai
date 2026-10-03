/**
 * 插件后端热重载回归测试（2026-09-28）。
 *
 * 覆盖点（对应 docs 里的承诺）：
 *   - 改入口 / 改子模块后 reload 能拿到新代码（子模块那条锁住"递归缓存失效"这个关键机制）
 *   - 新代码 import 失败或未导出 router 时，旧实例零副作用地继续服务
 *   - setup() 不重跑、start/stop 顺序正确、并发被挡住
 *   - 禁用插件 / 纯前端插件拒绝重载；reloadAll 单点失败不中断整批
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mountPlugins } from '../server/kernel/plugin-manager.js'

const silentLogger = { info() {}, error() {}, warn() {}, log() {} }

/** 只实现 use 的最小 app：门禁挂在哪个路径、handler 是谁，都记下来供测试模拟请求 */
function createFakeApp() {
  const mounts = []
  return {
    mounts,
    use(routeOrHandler, maybeHandler) {
      const route = typeof routeOrHandler === 'string' ? routeOrHandler : '/api'
      const handler = typeof routeOrHandler === 'string' ? maybeHandler : routeOrHandler
      mounts.push({ route, handler })
      return this
    }
  }
}

/** 模拟一次请求穿过门禁（门禁里 rt.router 被换掉后，这里拿到的一定是新 router） */
function callPlugin(app, mount) {
  const entry = app.mounts.filter((m) => m.route === mount).pop()
  assert.ok(entry, `没有挂载在 ${mount} 的门禁`)
  return new Promise((resolve) => {
    const res = { json: (body) => resolve(body), status: () => res, end: () => resolve(null) }
    entry.handler({ method: 'GET', url: '/' }, res, () => resolve(null))
  })
}

/** 造一个临时插件：server/index.js 为入口，可选额外文件（用于测子模块热重载） */
function makePlugin(root, name, { entry, extraFiles = {}, manifest = {} } = {}) {
  const dir = path.join(root, 'plugins', name)
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  const full = {
    name,
    title: name,
    version: '1.0.0',
    api: { mount: `/api/${name}`, module: './server/index.js' },
    ...manifest
  }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(full, null, 2))
  if (entry !== null) fs.writeFileSync(path.join(dir, 'server', 'index.js'), entry)
  for (const [rel, body] of Object.entries(extraFiles)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

/** 插件源码模板：把可观测状态挂在导出对象上，测试通过 record.instance.state 读 */
function pluginSource({ tag = 'V1', noRouter = false, startDelayMs = 0, setupThrows = false, useLib = false } = {}) {
  const routerLine = noRouter
    ? ''
    : `router: (req, res) => res.json({ tag: ${useLib ? 'libTag' : 'state.tag'} }),`
  return `
import fs from 'node:fs'
${useLib ? "import { tag as libTag } from './lib/tag.js'" : ''}
export const state = { started: 0, stopped: 0, setupCalls: 0, tag: ${JSON.stringify(tag)} }
const log = (line) => { try { fs.appendFileSync(process.env.RPA_TEST_LOG, line + '\\n') } catch {} }
export default {
  ${routerLine}
  async setup(app) {
    state.setupCalls++
    ${setupThrows ? "throw new Error('setup boom')" : "log('setup'); app.use('/pick-imgs', (a, b, c) => c())"}
  },
  async start() {
    ${startDelayMs ? `await new Promise((r) => setTimeout(r, ${startDelayMs}))` : ''}
    state.started++
    log('start')
  },
  async stop() { state.stopped++; log('stop') },
  state
}
`
}

/** 建临时工程 + 挂载，返回 { root, app, ps, logFile, cleanup } */
async function setupProject(plugins, { stateFile } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-reload-test-'))
  const pluginDir = path.join(root, 'plugins')
  fs.mkdirSync(pluginDir, { recursive: true })
  for (const p of plugins) makePlugin(root, p.name, p)
  const logFile = path.join(root, 'calls.log')
  fs.writeFileSync(logFile, '')
  const prevLog = process.env.RPA_TEST_LOG
  process.env.RPA_TEST_LOG = logFile

  const app = createFakeApp()
  const ps = await mountPlugins(app, {
    logger: silentLogger,
    pluginDir,
    stateFile: stateFile || path.join(root, 'plugins.json')
  })
  const find = (name) => ps.plugins.find((p) => p.name === name)
  return {
    root,
    app,
    ps,
    find,
    /** 某个路径上被 app.use 挂了几次（门禁 / setup 里的静态挂载都算） */
    mountCount: (route) => app.mounts.filter((m) => m.route === route).length,
    logLines: () => fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean),
    entryPath: (name) => path.join(root, 'plugins', name, 'server', 'index.js'),
    cleanup() {
      if (prevLog === undefined) delete process.env.RPA_TEST_LOG
      else process.env.RPA_TEST_LOG = prevLog
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

test('重载入口文件：门禁立即返回新代码，且不会重复挂载', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V1')
    assert.equal(ctx.mountCount('/api/demo'), 1)

    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: 'V2' }))
    const r = await ctx.ps.reload('demo')

    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V2')
    assert.equal(r.record.loaded, true)
    assert.equal(r.record.error, null)
    assert.equal(r.deep, true)
    // 门禁仍只有一条，setup 里的静态挂载也没被挂第二遍
    assert.equal(ctx.mountCount('/api/demo'), 1)
    assert.equal(ctx.mountCount('/pick-imgs'), 1)
  } finally {
    ctx.cleanup()
  }
})

test('重载子模块：routes/、lib/ 里的改动同样生效（递归缓存失效）', async () => {
  const ctx = await setupProject([
    {
      name: 'demo',
      entry: pluginSource({ useLib: true }),
      extraFiles: { 'server/lib/tag.js': "export const tag = 'LIB-V1'\n" }
    }
  ])
  try {
    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'LIB-V1')

    // 只改子模块，入口一个字不动
    fs.writeFileSync(path.join(ctx.root, 'plugins/demo/server/lib/tag.js'), "export const tag = 'LIB-V2'\n")
    await ctx.ps.reload('demo')

    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'LIB-V2')
  } finally {
    ctx.cleanup()
  }
})

test('新代码 import 失败：报错但旧实例零副作用地继续服务', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    const oldInstance = ctx.find('demo').instance

    fs.writeFileSync(ctx.entryPath('demo'), "throw new Error('boom')\n")
    await assert.rejects(() => ctx.ps.reload('demo'), /boom/)

    // 旧代码照常服务，且连 stop() 都没被调用（阶段 A 失败不碰旧实例）
    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V1')
    assert.equal(oldInstance.state.stopped, 0)
    assert.equal(ctx.find('demo').loaded, true)
    assert.equal(ctx.find('demo').error, null)
  } finally {
    ctx.cleanup()
  }
})

test('新代码未导出 router：拒绝重载并保留旧版本', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    const oldInstance = ctx.find('demo').instance

    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ noRouter: true }))
    await assert.rejects(() => ctx.ps.reload('demo'), /未导出 Express router/)

    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V1')
    assert.equal(oldInstance.state.stopped, 0)
  } finally {
    ctx.cleanup()
  }
})

test('setup() 不重跑：旧实例只 setup 过一次，新实例一次都没有', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    const oldInstance = ctx.find('demo').instance
    assert.equal(oldInstance.state.setupCalls, 1)

    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: 'V2' }))
    const r = await ctx.ps.reload('demo')

    assert.equal(r.setupSkipped, true)
    assert.equal(r.restartRequired, true)
    assert.ok(r.warnings.some((w) => w.includes('setup()')))
    assert.equal(oldInstance.state.setupCalls, 1)
    assert.equal(ctx.find('demo').instance.state.setupCalls, 0)
    assert.equal(ctx.mountCount('/api/demo'), 1) // 门禁没重挂
    assert.equal(ctx.mountCount('/pick-imgs'), 1) // setup 里的静态挂载也没挂第二遍
  } finally {
    ctx.cleanup()
  }
})

test('重载顺序：先停旧再起新', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: 'V2' }))
    await ctx.ps.reload('demo')

    assert.deepEqual(ctx.logLines(), ['setup', 'start', 'stop', 'start'])
  } finally {
    ctx.cleanup()
  }
})

test('并发保护：同一插件重载中再次点击会被拒绝', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1', startDelayMs: 40 }) }])
  try {
    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: 'V2', startDelayMs: 40 }))
    const first = ctx.ps.reload('demo')
    await assert.rejects(() => ctx.ps.reload('demo'), /正在重载中/)
    await first
    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V2')
  } finally {
    ctx.cleanup()
  }
})

test('禁用中的插件拒绝重载（避免破坏「禁用=无副作用」的约定）', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    await ctx.ps.setEnabled('demo', false)
    await assert.rejects(() => ctx.ps.reload('demo'), /已禁用/)
  } finally {
    ctx.cleanup()
  }
})

test('纯前端插件没有后端入口，拒绝重载', async () => {
  const ctx = await setupProject([
    { name: 'pure', entry: null, manifest: { api: undefined, frontend: { entry: './frontend/index.js' } } }
  ])
  try {
    assert.equal(ctx.find('pure').hasBackend, false)
    await assert.rejects(() => ctx.ps.reload('pure'), /没有后端入口/)
  } finally {
    ctx.cleanup()
  }
})

test('reloadAll：一个改坏不影响其它插件，汇总如实统计', async () => {
  const ctx = await setupProject([
    { name: 'alpha', entry: pluginSource({ tag: 'A1' }) },
    { name: 'beta', entry: pluginSource({ tag: 'B1' }) }
  ])
  try {
    fs.writeFileSync(ctx.entryPath('alpha'), pluginSource({ tag: 'A2' }))
    fs.writeFileSync(ctx.entryPath('beta'), "throw new Error('beta boom')\n")

    const summary = await ctx.ps.reloadAll()

    assert.equal(summary.total, 2)
    assert.equal(summary.succeeded, 1)
    assert.equal(summary.failed, 1)
    assert.equal((await callPlugin(ctx.app, '/api/alpha')).tag, 'A2') // 成功的那个换了新代码
    assert.equal((await callPlugin(ctx.app, '/api/beta')).tag, 'B1') // 失败的那个仍在跑旧代码
    const beta = summary.results.find((r) => r.name === 'beta')
    assert.equal(beta.ok, false)
    assert.match(beta.error, /beta boom/)
  } finally {
    ctx.cleanup()
  }
})

test('首次加载 setup 抛错后，修好代码点重载即可恢复（且不重跑 setup）', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1', setupThrows: true }) }])
  try {
    assert.equal(ctx.find('demo').loaded, false)
    assert.match(ctx.find('demo').error, /setup boom/)

    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: 'V2' }))
    const r = await ctx.ps.reload('demo')

    assert.equal(r.record.loaded, true)
    assert.equal(r.record.error, null)
    assert.equal(ctx.find('demo').instance.state.setupCalls, 0)
    assert.equal(ctx.find('demo').instance.state.started, 1)
  } finally {
    ctx.cleanup()
  }
})

test('连续重载多次：每次都拿到当次代码，不残留旧版本', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'R0' }) }])
  try {
    const oldInstance = ctx.find('demo').instance
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: `R${i}` }))
      await ctx.ps.reload('demo')
      assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, `R${i}`)
    }
    // 每次都换新实例：旧实例只被 stop 一次，最终实例只 start 一次
    assert.equal(oldInstance.state.stopped, 1)
    assert.equal(ctx.find('demo').instance.state.started, 1)
    assert.equal(ctx.find('demo').instance.state.tag, 'R3')
  } finally {
    ctx.cleanup()
  }
})

test('没有 setup 的插件（market 那种形状）重载后不算 setupSkipped', async () => {
  const noSetup = `
import fs from 'node:fs'
export const state = { started: 0, stopped: 0, tag: 'N1' }
export default {
  router: (req, res) => res.json({ tag: state.tag }),
  async start() { state.started++ },
  async stop() { state.stopped++ },
  state
}
`
  const ctx = await setupProject([{ name: 'demo', entry: noSetup }])
  try {
    fs.writeFileSync(ctx.entryPath('demo'), noSetup.replace("tag: 'N1'", "tag: 'N2'"))
    const r = await ctx.ps.reload('demo')

    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'N2')
    assert.equal(r.setupSkipped, false)
    assert.equal(r.restartRequired, false)
    assert.deepEqual(r.warnings, []) // 不该凭空报「setup 未重新执行」
  } finally {
    ctx.cleanup()
  }
})

test('api.mount 变更：给 warning 但仍按旧挂载点服务（挂载位置启动期定死）', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    const manifestPath = path.join(ctx.root, 'plugins/demo/plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.api.mount = '/api/moved'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    fs.writeFileSync(ctx.entryPath('demo'), pluginSource({ tag: 'V2' }))

    const r = await ctx.ps.reload('demo')

    assert.ok(r.warnings.some((w) => w.includes('api.mount')))
    assert.equal(r.restartRequired, true)
    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V2') // 旧路径照常生效
    assert.equal(ctx.mountCount('/api/moved'), 0) // 新路径没有门禁，需重启才能挂上
  } finally {
    ctx.cleanup()
  }
})

test('插件清单被删/损坏：拒绝重载且旧实例继续服务', async () => {
  const ctx = await setupProject([{ name: 'demo', entry: pluginSource({ tag: 'V1' }) }])
  try {
    const oldInstance = ctx.find('demo').instance
    fs.rmSync(path.join(ctx.root, 'plugins/demo/plugin.json'))

    await assert.rejects(() => ctx.ps.reload('demo'))

    assert.equal((await callPlugin(ctx.app, '/api/demo')).tag, 'V1')
    assert.equal(oldInstance.state.stopped, 0)
  } finally {
    ctx.cleanup()
  }
})

test('内核路由：重载接口已注册，且把 pluginError.code 映射成正确的状态码', async () => {
  const { createPluginKernelRouter } = await import('../server/kernel/plugin-routes.js')
  const makeRes = () => {
    const res = { statusCode: 200 }
    res.status = (c) => { res.statusCode = c; return res }
    res.json = (b) => { res.body = b; return res }
    return res
  }
  const handlerFor = (router, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.post)
    assert.ok(layer, `没有注册 ${path}`)
    return layer.route.stack.map((s) => s.handle).pop() // 跳过 authRequired/adminRequired
  }

  // 未找到插件 → 404
  const notFound = createPluginKernelRouter({
    plugins: [],
    reload: async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }) }
  })
  let res = makeRes()
  await handlerFor(notFound, '/plugins/:name/reload')({ params: { name: 'nope' } }, res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.ok, false)

  // 并发中 → 409；成功 → 200 且带上前端构建提示
  const busy = createPluginKernelRouter({
    plugins: [{ name: 'demo', title: 'demo' }],
    reload: async () => { throw Object.assign(new Error('插件 demo 正在重载中，请稍候'), { code: 'BUSY' }) }
  })
  res = makeRes()
  await handlerFor(busy, '/plugins/:name/reload')({ params: { name: 'demo' } }, res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body.error, /正在重载中/)

  const ok = createPluginKernelRouter({
    plugins: [{ name: 'demo', title: 'demo' }],
    reload: async () => ({
      record: { name: 'demo', title: 'demo', loaded: true, error: null, hasBackend: true },
      deep: true,
      setupSkipped: false,
      warnings: [],
      restartRequired: false
    }),
    reloadAll: async () => ({ total: 1, succeeded: 1, failed: 0, skipped: [], results: [] })
  })
  res = makeRes()
  await handlerFor(ok, '/plugins/:name/reload')({ params: { name: 'demo' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.data.hasBackend, true)
  assert.equal(res.body.data.frontendBuildRequired, true) // 如实告知前端改动仍需 build

  res = makeRes()
  await handlerFor(ok, '/plugins/reload-all')({}, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.succeeded, 1)
})

test('server.js 降级 fallback 必须实现 reload / reloadAll（防回归）', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf-8')
  const fallback = src.slice(src.indexOf('pluginSystem = {'), src.indexOf("app.use('/api/kernel'"))
  assert.match(fallback, /reload:\s*async/)
  assert.match(fallback, /reloadAll:\s*async/)
})
