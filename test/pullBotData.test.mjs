/**
 * 「一键拉取 bot 数据」的纯函数与参数白名单测试（2026-09-21 新增）。
 *
 * 覆盖两块最容易出错、又不需要联网的逻辑：
 *   1. scripts/pull-bot-data.mjs 的日期过滤 / 批次目录命名 / 目录名消毒；
 *   2. 路由侧 buildPullArgs 的参数白名单（防止请求体被拼进命令行）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseFileDate, withinSinceDays, batchDirName, safeDirName, limitFiles, claimBatchDir
} from '../scripts/pull-bot-data.mjs'
// 从 lib 导入而不是路由：routes/logs.js 会连带 import auth.js，
// 那会在模块加载时恢复/写回会话文件，测试不该有这种副作用。
import { buildPullArgs } from '../plugins/inquiry/server/lib/pullArgs.js'

const f = (name) => ({ name })

test('parseFileDate 能从聊天/日志文件名里取到日期', () => {
  // 用本地年月日断言：toISOString() 会转成 UTC，在东八区会把日期往前挪一天
  const d = parseFileDate('inquiry_20260919_151848.json')
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate()], [2026, 9, 19])
  const g = parseFileDate('bot_20260921.log')
  assert.deepEqual([g.getFullYear(), g.getMonth() + 1, g.getDate()], [2026, 9, 21])
  assert.equal(parseFileDate('manifest.json'), null)
})

test('withinSinceDays 只留窗口内的文件', () => {
  const now = Date.now()
  const day = 86400000
  const iso = (offsetDays) => {
    const d = new Date(now - offsetDays * day)
    const p = (n) => String(n).padStart(2, '0')
    return `inquiry_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_090000.json`
  }
  const files = [f(iso(1)), f(iso(40)), f(iso(200)), f('manifest.json')]

  const kept7 = withinSinceDays(files, 7).map((x) => x.name)
  assert.equal(kept7.length, 2, '7 天窗口应只留 1 天前的 + 无日期的那条')
  assert.ok(kept7.includes('manifest.json'), '解析不出日期的要保留，宁可多拉不能漏')

  assert.equal(withinSinceDays(files, 100).length, 3, '100 天窗口应排除 200 天前的')
  assert.equal(withinSinceDays(files, 0).length, 4, '0 表示不限')
})

test('batchDirName 形如 2026-09-21_1530', () => {
  const name = batchDirName(new Date(2026, 8, 21, 15, 30))
  assert.equal(name, '2026-09-21_1530')
  assert.match(batchDirName(), /^\d{4}-\d{2}-\d{2}_\d{4}$/)
})

test('同一分钟内的两次拉取不能落进同一个批次目录', async () => {
  // 实测过的真实场景：网页端点一次很快跑完，同一分钟内再点一次，
  // 两次结果混进同一个批次目录，两台机器的 manifest 各记着不同的一次拉取。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-batch-'))
  try {
    const now = new Date(2026, 8, 21, 16, 10)
    const first = await claimBatchDir(root, now)
    const second = await claimBatchDir(root, now)
    assert.notEqual(first, second, '同一分钟两次占用必须是不同目录')
    assert.equal(path.basename(first), '2026-09-21_1610')
    assert.equal(path.basename(second), '2026-09-21_1610_2')
    assert.ok(fs.existsSync(first) && fs.existsSync(second), '目录应被真实创建')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('claimBatchDir 会自动补上不存在的父目录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-batch-'))
  try {
    const nested = path.join(root, 'a', 'b')
    const dir = await claimBatchDir(nested)
    assert.ok(dir.startsWith(nested + path.sep) || dir === nested)
    assert.ok(fs.existsSync(dir))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('safeDirName 结果不能逃出输出目录', () => {
  // 断「安全性质」而不是具体字符串：真正要防的是 path.join 之后跑出 outDir。
  // 曾经的漏洞：点号在允许字符里，safeDirName('..') 原样返回 '..'，
  // path.join(outDir, '..') 直接跳到上一级。
  const outDir = '/tmp/pull-out'
  const cases = ['MAC1', '..', '.', '../../etc/passwd', 'a/b\\c', '  ',
    '.hidden', 'MAC..1', '~/x', 'a\x00b', '\\\\server\\share']
  for (const raw of cases) {
    const dir = safeDirName(raw)
    assert.ok(dir.length > 0, `${raw} 不能产出空目录名`)
    assert.ok(!dir.includes('/') && !dir.includes('\\'),
      `${raw} -> ${dir} 仍含路径分隔符`)
    assert.ok(dir !== '.' && dir !== '..', `${raw} -> ${dir} 是相对路径特殊段`)
    const joined = path.join(outDir, dir)
    assert.ok(joined.startsWith(outDir + path.sep),
      `${raw} -> ${joined} 逃出了输出目录`)
  }
})

test('safeDirName 保留正常机器名', () => {
  assert.equal(safeDirName('MAC1'), 'MAC1')
  assert.equal(safeDirName('媒体机-2'), '媒体机-2')
})

test('limitFiles: 0 表示全部，正数取最新 N 个', () => {
  const files = [f('bot_20260919.log'), f('bot_20260921.log'), f('bot_20260920.log')]
  assert.deepEqual(limitFiles(files, 0).map((x) => x.name),
    ['bot_20260921.log', 'bot_20260920.log', 'bot_20260919.log'])
  assert.deepEqual(limitFiles(files, 2).map((x) => x.name),
    ['bot_20260921.log', 'bot_20260920.log'])
})

test('buildPullArgs 默认带上批次与 30 天窗口', () => {
  const args = buildPullArgs({})
  assert.ok(args.includes('--batch'))
  assert.deepEqual(args.slice(args.indexOf('--since-days'), args.indexOf('--since-days') + 2),
    ['--since-days', '30'])
  assert.deepEqual(args.slice(args.indexOf('--instance'), args.indexOf('--instance') + 2),
    ['--instance', 'all'])
  assert.ok(!args.includes('--no-chat') && !args.includes('--no-logs'))
})

test('buildPullArgs 拒绝越界的 sinceDays', () => {
  for (const bad of [-1, 366, 1.5, 'abc', Number.NaN]) {
    assert.throws(() => buildPullArgs({ sinceDays: bad }), /sinceDays/, `应拒绝 ${bad}`)
  }
  assert.ok(buildPullArgs({ sinceDays: 0 }).includes('--since-days'))
  assert.ok(buildPullArgs({ sinceDays: 365 }).includes('--since-days'))
})

test('buildPullArgs 拒绝未配置的实例名（防注入）', () => {
  // 已配置实例之外的任何字符串都不能进命令行
  for (const bad of ['MAC9', '../../etc', 'all; rm -rf /', '$(whoami)', '--out']) {
    assert.throws(() => buildPullArgs({ instance: bad }), /未知实例/, `应拒绝 ${bad}`)
  }
})

test('buildPullArgs 允许已配置实例与 all', () => {
  assert.ok(buildPullArgs({ instance: 'all' }).includes('all'))
  // 配置里存在 MAC1/MAC2（见 server/bot_instances.json）
  assert.ok(buildPullArgs({ instance: 'MAC1' }).includes('MAC1'))
})

test('buildPullArgs: chat/logs 传 false 才追加 --no-*', () => {
  assert.ok(buildPullArgs({ chat: false }).includes('--no-chat'))
  assert.ok(buildPullArgs({ logs: false }).includes('--no-logs'))
  assert.ok(!buildPullArgs({ chat: true, logs: true }).includes('--no-chat'))
})
