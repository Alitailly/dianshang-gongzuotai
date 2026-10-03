/**
 * 插件自身版本（plugin.json）读写工具。
 *
 * 版本所有权约定：
 *   - plugin.json.version  = 插件自身版本（插件自己维护）
 *   - server/data/plugins.json 的 expectedVersion = 网站“对接插件版本”
 *   - 两者不一致时，网站插件管理页只提示，不自动改插件代码或清单
 *
 * 本文件只负责单个插件自己的 plugin.json，不碰 portal 的插件状态文件。
 */
import fs from 'fs'
import path from 'path'
import { atomicWriteJson } from './fileStore.js'

export function isValidVersion(value) {
  return /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(value || '').trim())
}

export function readPluginManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, 'plugin.json')
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`插件清单不是对象：${manifestPath}`)
  }
  return parsed
}

export function getPluginOwnVersion(pluginDir) {
  try {
    const manifest = readPluginManifest(pluginDir)
    return isValidVersion(manifest.version) ? String(manifest.version).trim() : '1.0.0'
  } catch {
    return '1.0.0'
  }
}

function updateLocalReleaseManifest(pluginDir, { previousVersion, nextVersion }) {
  const manifestPath = path.join(pluginDir, '.release-local', 'release-manifest.json')
  if (!fs.existsSync(manifestPath)) return { updated: false, path: manifestPath }
  try {
    const current = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    const now = new Date().toISOString()
    const history = Array.isArray(current.versionHistory) ? current.versionHistory.slice(-19) : []
    history.push({ at: now, from: previousVersion, to: nextVersion, source: 'plugin-settings-page' })
    atomicWriteJson(manifestPath, {
      ...current,
      version: nextVersion,
      versionSource: 'plugin.json#/version',
      versionHistory: history,
      generatedAt: now
    })
    return { updated: true, path: manifestPath }
  } catch (e) {
    return { updated: false, path: manifestPath, error: e.message }
  }
}

export function setPluginOwnVersion(pluginDir, version) {
  const nextVersion = String(version || '').trim()
  if (!isValidVersion(nextVersion)) {
    throw new Error('版本号格式不正确，请使用如 1.2.3 或 1.2.3-beta.1')
  }
  const manifest = readPluginManifest(pluginDir)
  const previousVersion = isValidVersion(manifest.version) ? String(manifest.version).trim() : '1.0.0'
  const nextManifest = { ...manifest, version: nextVersion }
  atomicWriteJson(path.join(pluginDir, 'plugin.json'), nextManifest)
  const releaseManifest = updateLocalReleaseManifest(pluginDir, { previousVersion, nextVersion })
  return { previousVersion, version: nextVersion, releaseManifest }
}
