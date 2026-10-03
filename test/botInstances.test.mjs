import test from 'node:test'
import assert from 'node:assert/strict'
import { TargetResolutionError, parseControlPort, resolveTarget } from '../server/lib/botInstances.js'

test('显式的无效 bot 目标会被拒绝，不回退到本机', () => {
  assert.throws(() => resolveTarget({ instanceId: '__missing_instance__' }), TargetResolutionError)
  assert.throws(() => resolveTarget({ ip: '8.8.8.8' }), TargetResolutionError)
  assert.throws(() => resolveTarget({ ip: '192.168.1.10', control_port: 70000 }), TargetResolutionError)
})

test('未指定目标时仍可使用既有默认解析策略', () => {
  assert.ok(resolveTarget({}).id)
  assert.equal(parseControlPort('18810'), 18810)
  assert.equal(parseControlPort('0'), null)
})
