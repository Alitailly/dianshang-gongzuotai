/**
 * 插件数据目录 / 配置文件的“先归属、后搬家”路径解析器（CommonJS）。
 *
 * 设计目标：
 *   1. 代码先通过唯一入口解析路径，所有权清晰；
 *   2. 默认不改运行行为：旧路径存在就继续用旧路径；
 *   3. 以后把文件复制到新路径后，无需改代码即可自动切到新路径；
 *   4. 需要强制切换时用环境变量，避免新旧两处同时写。
 *
 * 解析优先级（读和写使用同一个结果，避免双写）：
 *   显式文件环境变量 > DATA_MODE=new > 新路径已存在 > 旧路径已存在 > 默认旧路径
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_PLUGIN_DATA_ROOT = path.join(ROOT_DIR, 'data', 'plugins');

function expandPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const expanded = raw.startsWith('~/') ? path.join(process.env.HOME || '', raw.slice(2)) : raw;
  return path.isAbsolute(expanded) ? expanded : path.resolve(ROOT_DIR, expanded);
}

function getPluginDataRoot() {
  return expandPath(process.env.RPA_PLUGIN_DATA_DIR) || DEFAULT_PLUGIN_DATA_ROOT;
}

function getPluginDataDir(name, envVar) {
  const cleanName = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(cleanName)) {
    throw new Error(`非法插件数据目录名：${name}`);
  }
  const override = envVar ? expandPath(process.env[envVar]) : '';
  return override || path.join(getPluginDataRoot(), cleanName);
}

function resolveManagedPath({ newPath, legacyPath, explicitEnvVar, modeEnvVar, defaultTo = 'legacy' }) {
  const explicit = explicitEnvVar ? expandPath(process.env[explicitEnvVar]) : '';
  if (explicit) return explicit;

  const mode = modeEnvVar ? String(process.env[modeEnvVar] || '').trim().toLowerCase() : '';
  if (mode === 'new') return newPath;

  if (fs.existsSync(newPath)) return newPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  return defaultTo === 'new' ? newPath : legacyPath;
}

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

module.exports = {
  ROOT_DIR,
  DEFAULT_PLUGIN_DATA_ROOT,
  expandPath,
  getPluginDataRoot,
  getPluginDataDir,
  resolveManagedPath,
  ensureParentDir,
};
