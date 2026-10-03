#!/usr/bin/env node
/**
 * 插件数据“先归属、后搬家”迁移工具（默认只演练，不写任何文件）。
 *
 * 用法：
 *   node scripts/migrate-plugin-data.mjs            # dry-run，只列出会复制什么
 *   node scripts/migrate-plugin-data.mjs --apply     # 真正复制到 data/plugins/...
 *   node scripts/migrate-plugin-data.mjs --apply --force  # 目标已存在时也覆盖
 *
 * 安全约束：
 *   - 不删除旧文件；旧路径保留只读兼容。
 *   - 复制前先备份旧文件到项目 .release-local/migration-backup-<时间>/。
 *   - 文件复制后校验 sha256 + 文件大小；目录复制后校验文件清单与内容 sha256。
 *   - 不启动、不停止、不重启任何服务；请在维护窗口自行停止写入后再 --apply。
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const FORCE = args.includes('--force')

const PLUGIN_DATA_ROOT = process.env.RPA_PLUGIN_DATA_DIR || path.join(ROOT_DIR, 'data', 'plugins')
const INQUIRY_DATA_DIR = process.env.INQUIRY_DATA_DIR || path.join(PLUGIN_DATA_ROOT, 'inquiry')
const MARKET_DATA_DIR = process.env.MARKET_DATA_DIR || path.join(PLUGIN_DATA_ROOT, 'market')
const MARKET_SCRIPTS_DIR = path.join(ROOT_DIR, 'plugins', 'market', 'scripts')
const BACKUP_DIR = path.join(ROOT_DIR, '.release-local', `migration-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)

function fileEntry(name, legacy, target, sensitive = false) {
  return { kind: 'file', name, legacy, target, sensitive }
}

function collectEntries() {
  const entries = [
    fileEntry('inquiry/settings.json', path.join(ROOT_DIR, 'server', 'data', 'inquiry-settings.json'), path.join(INQUIRY_DATA_DIR, 'settings.json')),
    fileEntry('inquiry/bot_instances.json', path.join(ROOT_DIR, 'server', 'bot_instances.json'), path.join(INQUIRY_DATA_DIR, 'bot_instances.json'), true),
    fileEntry('inquiry/task_history.json', path.join(ROOT_DIR, 'server', 'task_history.json'), path.join(INQUIRY_DATA_DIR, 'task_history.json')),
    {
      kind: 'dir',
      name: 'inquiry/cache/first-inquiry-pick',
      legacy: path.join(ROOT_DIR, 'server', 'cache', 'first-inquiry-pick'),
      target: path.join(INQUIRY_DATA_DIR, 'cache', 'first-inquiry-pick'),
      sensitive: false,
    },
    fileEntry('market/config/schedule_config.json', path.join(MARKET_SCRIPTS_DIR, 'schedule_config.json'), path.join(MARKET_DATA_DIR, 'config', 'schedule_config.json')),
    fileEntry('market/state/schedule_state.json', path.join(MARKET_SCRIPTS_DIR, 'schedule_state.json'), path.join(MARKET_DATA_DIR, 'state', 'schedule_state.json')),
    fileEntry('market/config/damai_config.json', path.join(MARKET_SCRIPTS_DIR, 'damai_config.json'), path.join(MARKET_DATA_DIR, 'config', 'damai_config.json'), true),
    fileEntry('market/config/snoopy_body.json', path.join(MARKET_SCRIPTS_DIR, 'ml-scraper', 'snoopy_body.json'), path.join(MARKET_DATA_DIR, 'config', 'snoopy_body.json'), true),
    fileEntry('market/state/batch_state.json', path.join(MARKET_SCRIPTS_DIR, 'batch_state.json'), path.join(MARKET_DATA_DIR, 'state', 'batch_state.json')),
    fileEntry('market/state/batch_ctl.json', path.join(MARKET_SCRIPTS_DIR, 'batch_ctl.json'), path.join(MARKET_DATA_DIR, 'state', 'batch_ctl.json')),
    fileEntry('market/state/integrity_status.json', path.join(MARKET_SCRIPTS_DIR, 'integrity_status.json'), path.join(MARKET_DATA_DIR, 'state', 'integrity_status.json')),
    fileEntry('market/state/publish_progress.json', path.join(MARKET_SCRIPTS_DIR, 'publish_progress.json'), path.join(MARKET_DATA_DIR, 'state', 'publish_progress.json')),
    fileEntry('market/state/publish_approval.json', path.join(MARKET_SCRIPTS_DIR, 'publish_approval.json'), path.join(MARKET_DATA_DIR, 'state', 'publish_approval.json')),
    fileEntry('market/state/run_copy.lock', path.join(MARKET_SCRIPTS_DIR, 'run_copy.lock'), path.join(MARKET_DATA_DIR, 'state', 'run_copy.lock')),
    fileEntry('market/cache/self_blackair.jsonl', path.join(MARKET_SCRIPTS_DIR, 'self_blackair.jsonl'), path.join(MARKET_DATA_DIR, 'cache', 'self_blackair.jsonl')),
    fileEntry('market/cache/queue_images.jsonl', path.join(MARKET_SCRIPTS_DIR, 'queue_images.jsonl'), path.join(MARKET_DATA_DIR, 'cache', 'queue_images.jsonl')),
    fileEntry('market/cache/tr_cache.json', path.join(MARKET_SCRIPTS_DIR, 'ml-scraper', 'tr_cache.json'), path.join(MARKET_DATA_DIR, 'cache', 'tr_cache.json')),
    fileEntry('market/audit/market-operation-audit.jsonl', path.join(ROOT_DIR, 'server', 'data', 'market-operation-audit.jsonl'), path.join(MARKET_DATA_DIR, 'audit', 'market-operation-audit.jsonl')),
  ]

  // 动态收集 goods_*.jsonl / run_*.log（迁移时存在多少就搬多少）
  if (fs.existsSync(MARKET_SCRIPTS_DIR)) {
    for (const name of fs.readdirSync(MARKET_SCRIPTS_DIR)) {
      if (/^goods_.+\.jsonl$/.test(name)) {
        entries.push(fileEntry(`market/cache/${name}`, path.join(MARKET_SCRIPTS_DIR, name), path.join(MARKET_DATA_DIR, 'cache', name)))
      }
      if (/^run_.+\.log$/.test(name)) {
        entries.push(fileEntry(`market/logs/${name}`, path.join(MARKET_SCRIPTS_DIR, name), path.join(MARKET_DATA_DIR, 'logs', name)))
      }
    }
  }
  return entries
}

const entries = collectEntries()

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full))
  }
  return out.sort()
}

function dirSnapshot(dir) {
  const files = listFiles(dir)
  return { files, hashes: Object.fromEntries(files.map((f) => [f, sha256File(path.join(dir, f))])) }
}

function copyFileEntry(entry) {
  const stat = fs.statSync(entry.legacy)
  fs.mkdirSync(path.dirname(entry.target), { recursive: true })
  fs.copyFileSync(entry.legacy, entry.target)
  if (entry.sensitive) {
    try { fs.chmodSync(entry.target, 0o600) } catch { /* 忽略权限设置失败 */ }
  }
  const targetStat = fs.statSync(entry.target)
  const sourceHash = sha256File(entry.legacy)
  const targetHash = sha256File(entry.target)
  const ok = sourceHash === targetHash && stat.size === targetStat.size
  return { ok, sourceHash, targetHash, size: stat.size }
}

function copyDirEntry(entry) {
  const before = dirSnapshot(entry.legacy)
  fs.mkdirSync(entry.target, { recursive: true })
  fs.cpSync(entry.legacy, entry.target, { recursive: true, force: true })
  const after = dirSnapshot(entry.target)
  const ok = before.files.length === after.files.length
    && before.files.every((f, i) => after.files[i] === f && before.hashes[f] === after.hashes[f])
  return { ok, files: before.files.length }
}

function backupEntry(entry) {
  const backupPath = path.join(BACKUP_DIR, entry.name)
  if (entry.kind === 'dir') {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.cpSync(entry.legacy, backupPath, { recursive: true, force: true })
  } else {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.copyFileSync(entry.legacy, backupPath)
  }
  return backupPath
}

console.log(`[migrate] 模式：${APPLY ? 'APPLY（会复制文件）' : 'DRY-RUN（只演练）'}`)
console.log(`[migrate] 新数据根：${PLUGIN_DATA_ROOT}`)
console.log('[migrate] 提醒：请在维护窗口、停止写入后再执行 --apply；本工具不会停止或重启服务。\n')

const results = []
for (const entry of entries) {
  if (!fs.existsSync(entry.legacy)) {
    results.push({ ...entry, status: 'missing-legacy' })
    continue
  }
  if (entry.kind === 'file' && !APPLY && entry.sensitive) {
    const targetExists = fs.existsSync(entry.target)
    results.push({ ...entry, status: targetExists && !FORCE ? 'target-exists-skip' : 'would-copy' })
    continue
  }

  if (fs.existsSync(entry.target) && !FORCE) {
    if (entry.kind === 'file') {
      const sourceHash = sha256File(entry.legacy)
      const targetHash = sha256File(entry.target)
      if (sourceHash === targetHash) {
        results.push({ ...entry, status: 'already-migrated', sourceHash, targetHash })
        continue
      }
    }
    results.push({ ...entry, status: 'target-exists-skip' })
    continue
  }

  if (!APPLY) {
    results.push({ ...entry, status: entry.kind === 'dir' ? 'would-copy-dir' : 'would-copy' })
    continue
  }

  const backupPath = backupEntry(entry)
  const copyResult = entry.kind === 'dir' ? copyDirEntry(entry) : copyFileEntry(entry)
  results.push({ ...entry, status: copyResult.ok ? 'copied' : 'copy-failed', backupPath, ...copyResult })
}

for (const r of results) {
  const kind = r.kind === 'dir' ? 'dir ' : 'file'
  console.log(`- ${r.status.padEnd(18)} [${kind}] ${path.relative(ROOT_DIR, r.legacy)} -> ${path.relative(ROOT_DIR, r.target)}`)
  if (r.backupPath) console.log(`  备份：${path.relative(ROOT_DIR, r.backupPath)}`)
  if (r.sensitive) console.log('  （敏感文件：新路径已按 0600 权限尝试设置）')
}

const failed = results.filter((r) => r.status === 'copy-failed')
if (failed.length) {
  console.error(`\n[migrate] 有 ${failed.length} 项复制失败，请检查磁盘/权限；旧数据未删除。`)
  process.exitCode = 1
} else if (APPLY) {
  console.log('\n[migrate] 复制完成。旧文件仍保留；重启服务前请确认新路径内容与权限无误。')
} else {
  console.log('\n[migrate] 这是演练结果；确认无误后加 --apply 再执行。')
}
