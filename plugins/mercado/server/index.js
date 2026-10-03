import http from 'http'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { Router } from 'express'
import { authRequired } from '../../../server/lib/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MERCADO_DIR = path.resolve(__dirname, '../../../mercado-libre')

let backendPort = 0
let backendProcess = null
let backendError = '美客多数据服务还在启动'

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function waitForHealth(port, timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve()
        else retry()
      })
      req.on('error', retry)
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error('美客多数据服务启动超时'))
        return
      }
      setTimeout(tick, 400)
    }
    tick()
  })
}

function pythonCommand() {
  return process.env.MERCADO_PYTHON || 'py'
}

export async function start() {
  if (backendProcess) return
  const port = await reserveLocalPort()
  const args = pythonCommand() === 'py'
    ? ['-3', '-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', String(port)]
    : ['-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', String(port)]
  const child = spawn(pythonCommand(), args, {
    cwd: MERCADO_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  backendProcess = child
  backendPort = port
  let log = ''
  const capture = (chunk) => {
    log = (log + chunk.toString()).slice(-2000)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.on('exit', (code) => {
    if (backendProcess === child) {
      backendProcess = null
      backendPort = 0
      backendError = `美客多数据服务已退出（代码 ${code ?? '未知'}）`
      if (log.trim()) console.error('[mercado]', log.trim())
    }
  })
  try {
    await waitForHealth(port)
    backendError = ''
    console.log(`[mercado] 数据服务已随门户启动，只监听本机，对外只使用门户端口`)
  } catch (error) {
    backendError = error.message
    console.error('[mercado]', error.message)
    if (log.trim()) console.error('[mercado]', log.trim())
  }
}

export async function stop() {
  const child = backendProcess
  backendProcess = null
  backendPort = 0
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  child.kill()
}

export const router = Router()
router.use(authRequired)
router.use((req, res) => {
  if (!backendPort) {
    res.status(502).json({ error: backendError || '美客多数据服务未启动' })
    return
  }
  const headers = { ...req.headers }
  delete headers.host
  delete headers.connection
  delete headers['content-length']

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: backendPort,
    path: `/api${req.url || '/'}`,
    method: req.method,
    headers
  }, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers }
    delete responseHeaders['transfer-encoding']
    res.writeHead(proxyRes.statusCode || 502, responseHeaders)
    proxyRes.pipe(res)
  })

  proxyReq.on('error', () => {
    if (res.headersSent) return
    res.status(502).json({ error: '美客多数据服务暂时连不上，请刷新后再试' })
  })

  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') {
    proxyReq.end()
    return
  }
  const data = JSON.stringify(req.body ?? {})
  proxyReq.setHeader('content-type', 'application/json; charset=utf-8')
  proxyReq.setHeader('content-length', Buffer.byteLength(data))
  proxyReq.end(data)
})

export default { router, start, stop }
