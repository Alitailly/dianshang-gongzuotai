import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadImageWithLimits, isPublicIp } from '../server/lib/security.js'

function mockResponse(contentType) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: { get: (name) => name === 'content-type' ? contentType : null },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close() } }),
  }
}

test('图片下载仅接受图片 MIME，且私网地址不属于可访问地址', async () => {
  assert.equal(isPublicIp('127.0.0.1'), false)
  assert.equal(isPublicIp('8.8.8.8'), true)
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => mockResponse('image/webp')
    assert.equal((await downloadImageWithLimits('http://8.8.8.8/image')).length, 3)
    globalThis.fetch = async () => mockResponse('text/html')
    await assert.rejects(() => downloadImageWithLimits('http://8.8.8.8/image'), /内容类型不允许/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
