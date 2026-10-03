import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isValidVersion, validatePluginManifest } from '../server/kernel/plugin-manager.js'

test('插件版本号只接受可识别的语义化格式', () => {
  assert.equal(isValidVersion('1.2.3'), true)
  assert.equal(isValidVersion('1.2.3-beta.1'), true)
  assert.equal(isValidVersion('1.2'), true)
  assert.equal(isValidVersion('latest'), false)
  assert.equal(isValidVersion('1'), false)
  assert.equal(isValidVersion('1.2.3 beta'), false)
})

test('插件后端入口必须留在插件目录且挂载在 /api 下', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-plugin-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'entry.js'), 'export default () => {}')
    const valid = validatePluginManifest({ name: 'demo', api: { mount: '/api/demo', module: './entry.js' } }, { dir, dirName: 'demo' })
    assert.equal(valid.name, 'demo')
    assert.throws(() => validatePluginManifest({ name: 'demo', api: { mount: '/market', module: './entry.js' } }, { dir, dirName: 'demo' }))
    assert.throws(() => validatePluginManifest({ name: 'demo', api: { mount: '/api/demo', module: '../outside.js' } }, { dir, dirName: 'demo' }))
    const outside = path.join(os.tmpdir(), `rpa-outside-${Date.now()}.js`)
    fs.writeFileSync(outside, 'export default () => {}')
    try {
      fs.symlinkSync(outside, path.join(dir, 'linked.js'))
      assert.throws(() => validatePluginManifest({ name: 'demo', api: { mount: '/api/demo', module: './linked.js' } }, { dir, dirName: 'demo' }))
    } finally {
      fs.rmSync(outside, { force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
