import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pluginDataPaths from '../server/lib/pluginDataPaths.cjs'

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-paths-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('未迁移时路径解析优先保留旧路径，迁移后自动切到新路径', () => {
  withTempDir((dir) => {
    const legacy = path.join(dir, 'legacy.json')
    const next = path.join(dir, 'next.json')
    assert.equal(pluginDataPaths.resolveManagedPath({ newPath: next, legacyPath: legacy }), legacy)
    fs.writeFileSync(legacy, 'legacy')
    assert.equal(pluginDataPaths.resolveManagedPath({ newPath: next, legacyPath: legacy }), legacy)
    fs.writeFileSync(next, 'next')
    assert.equal(pluginDataPaths.resolveManagedPath({ newPath: next, legacyPath: legacy }), next)
  })
})

test('MARKET_DATA_MODE=new 这类模式开关可强制使用新路径', () => {
  withTempDir((dir) => {
    const legacy = path.join(dir, 'legacy.json')
    const next = path.join(dir, 'next.json')
    fs.writeFileSync(legacy, 'legacy')
    assert.equal(pluginDataPaths.resolveManagedPath({ newPath: next, legacyPath: legacy, modeEnvVar: 'TEST_DATA_MODE' }), legacy)
    process.env.TEST_DATA_MODE = 'new'
    try {
      assert.equal(pluginDataPaths.resolveManagedPath({ newPath: next, legacyPath: legacy, modeEnvVar: 'TEST_DATA_MODE' }), next)
    } finally {
      delete process.env.TEST_DATA_MODE
    }
  })
})

test('显式文件环境变量优先级最高，并支持相对项目根目录', () => {
  withTempDir((dir) => {
    const legacy = path.join(dir, 'legacy.json')
    const next = path.join(dir, 'next.json')
    const explicit = path.join(dir, 'explicit.json')
    process.env.TEST_DATA_FILE = explicit
    try {
      assert.equal(pluginDataPaths.resolveManagedPath({ newPath: next, legacyPath: legacy, explicitEnvVar: 'TEST_DATA_FILE' }), explicit)
    } finally {
      delete process.env.TEST_DATA_FILE
    }
  })
})
