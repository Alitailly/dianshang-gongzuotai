#!/usr/bin/env node
/**
 * 主题系统完整性校验
 *
 * 职责:
 *   1. THEMES 注册表与 src/themes/*.css 文件/块一一对应；
 *   2. 每套注册主题在 src/styles/creative.css 中存在艺术层覆盖块；
 *   3. 每套主题文件均覆盖核心变量，避免切换后出现未定义样式；
 *   4. 注册表内不得出现重复名称/标签。
 *
 * 用法: npm run test:themes
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = path.join(root, 'src/composables/useTheme.js')
const themesDir = path.join(root, 'src/themes')
const creativePath = path.join(root, 'src/styles/creative.css')
const defaultTheme = 'black-air'

const registrySource = fs.readFileSync(registryPath, 'utf8')
const creativeSource = fs.readFileSync(creativePath, 'utf8')
const themeCoreSource = fs.readFileSync(path.join(root, 'src/styles/theme.css'), 'utf8')

const registryEntries = [...registrySource.matchAll(/\{\s*name:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
  .map((m) => ({ name: m[1], label: m[2] }))

const requiredThemeVars = [
  '--el-color-primary',
  '--app-bg',
  '--app-card-bg',
  '--app-card-border',
  '--app-text-primary',
  '--app-text-regular',
  '--app-header-bg',
  '--app-sidebar-bg',
  '--app-content-padding',
  '--app-radius-card',
  '--app-gap'
]

const errors = []

// 1) 读取主题 CSS 文件
if (!/\[data-theme="black-air"\]/.test(themeCoreSource)) {
  errors.push('默认主题 black-air 未在 src/styles/theme.css 中声明')
}

const themeFiles = fs.readdirSync(themesDir)
  .filter((f) => f.endsWith('.css'))
  .sort()

const fileBlocks = new Map()
for (const file of themeFiles) {
  const text = fs.readFileSync(path.join(themesDir, file), 'utf8')
  const blocks = [...text.matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1])
  fileBlocks.set(file, blocks)

  if (blocks.length === 0) {
    errors.push(`主题文件 ${file} 未包含任何 [data-theme="..."] 块`)
  }
  for (const block of blocks) {
    for (const v of requiredThemeVars) {
      // 简化校验:至少每个主题文件应声明业务核心变量(允许在块外继承时不单独出现)
      if (!text.includes(`${v}:`)) {
        errors.push(`${file} 的 ${block} 缺少核心变量 ${v}`)
      }
    }
  }
}

// 2) 注册表与文件互相校验
const registeredNames = new Set(registryEntries.map((e) => e.name))
const cssBlockNames = new Set()
for (const blocks of fileBlocks.values()) {
  blocks.forEach((b) => cssBlockNames.add(b))
}

for (const entry of registryEntries) {
  if (entry.name === defaultTheme) continue
  if (!cssBlockNames.has(entry.name)) {
    errors.push(`注册表主题 "${entry.name}" 在 src/themes/*.css 中没有对应块`)
  }
}

for (const name of cssBlockNames) {
  if (!registeredNames.has(name)) {
    errors.push(`主题 CSS 包含未注册的 "${name}"`)
  }
}

// 3) 艺术层覆盖块
const creativeBlocks = new Set([...creativeSource.matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1]))
for (const entry of registryEntries) {
  if (entry.name === defaultTheme) continue
  if (!creativeBlocks.has(entry.name)) {
    errors.push(`注册表主题 "${entry.name}" 在 creative.css 中缺少艺术层块`)
  }
}

// 4) 重复检查
const seenNames = new Set()
const seenLabels = new Set()
for (const entry of registryEntries) {
  if (seenNames.has(entry.name)) errors.push(`重复注册主题 name: ${entry.name}`)
  if (seenLabels.has(entry.label)) errors.push(`重复注册主题 label: ${entry.label}`)
  seenNames.add(entry.name)
  seenLabels.add(entry.label)
}

if (errors.length) {
  console.error(`✗ 主题系统校验失败 (${errors.length} 个问题)`)
  errors.forEach((e) => console.error(`  - ${e}`))
  process.exit(1)
}

console.log(`✓ 主题系统校验通过：${registryEntries.length} 套主题，${themeFiles.length} 个独立主题 CSS 文件（默认黑空科技位于 theme.css）`)
console.log(`  主题列表: ${registryEntries.map((e) => e.name).join(', ')}`)
