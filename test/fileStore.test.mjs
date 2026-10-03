import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson } from '../server/lib/fileStore.js'

test('原子 JSON 写入会完整替换原文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-file-store-'))
  const file = path.join(dir, 'state.json')
  try {
    atomicWriteJson(file, { version: 1 })
    atomicWriteJson(file, { version: 2, ready: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, ready: true })
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
