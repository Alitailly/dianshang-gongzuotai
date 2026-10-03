/**
 * 小型运行时文件的可靠写入工具。
 *
 * 先同步临时文件，再以 rename 替换目标文件，避免进程中断留下半个 JSON 文件。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export function atomicWriteFile(file, content, { mode } = {}) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  let fd
  try {
    fd = fs.openSync(temp, 'w', mode)
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch { /* 临时文件可能尚未创建 */ }
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  try {
    fs.renameSync(temp, file)
    if (mode !== undefined) fs.chmodSync(file, mode)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch { /* 临时文件可能已被 rename */ }
    throw error
  }
}

export function atomicWriteJson(file, value, options = {}) {
  atomicWriteFile(file, JSON.stringify(value, null, 2), options)
}
