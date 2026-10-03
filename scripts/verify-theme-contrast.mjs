#!/usr/bin/env node
/**
 * 主题对比度回归校验
 *
 * 职责:
 *   解析 src/styles/theme.css(默认 black-air)、src/themes/*.css 以及
 *   src/styles/creative.css 中的 CSS 变量覆盖,按 WCAG 2.x 相对亮度公式
 *   校验核心「文字色 / 背景色」组合,低于阈值即输出中文错误并返回非 0。
 *
 * 覆盖项:
 *   1. --app-text-primary/regular/secondary  对 --app-bg、--app-card-bg      ≥ 4.5
 *   2. --el-text-color-primary/regular/secondary 对 --el-bg-color、page      ≥ 4.5
 *   3. --app-text-placeholder / --el-text-color-placeholder                  ≥ 3(推荐 4.5)
 *   4. --app-table-th-text / --app-table-head-text 对表头背景                  ≥ 4.5
 *   5. --app-log-text / --app-log-muted 对 --app-log-bg                      ≥ 4.5
 *   6. --app-header-text 对 --app-header-bg(含渐变各色标)                    ≥ 4.5
 *   7. --app-menu-text 对 --app-sidebar-bg                                   ≥ 4.5
 *   8. --app-menu-active-color 对 active/hover 背景(半透明色先与侧栏合成)  ≥ 4.5
 *   9. --app-title-color / 标题渐变 对顶栏背景                                ≥ 4.5
 *
 * 说明:
 *   - 解析会忽略 CSS 注释;
 *   - 支持 :root、[data-theme="x"]、:root[data-theme="x"] 三种写法;
 *   - creative.css 的艺术层覆盖会合并进对应主题(黑空默认层计入 black-air)。
 *
 * 用法: npm run test:themes
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const themeCorePath = path.join(root, 'src/styles/theme.css')
const themesDir = path.join(root, 'src/themes')
const creativePath = path.join(root, 'src/styles/creative.css')
const defaultTheme = 'black-air'

const errors = []
const summary = []

/* ------------------------------------------------------------------ 解析 */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 找出所有「选择器 { 声明体 }」块。声明体内不允许嵌套 {} ,
 * 因此 @keyframes / @media 这类嵌套规则会被内层块匹配,主题变量块正常匹配。
 */
function findBlocks(css) {
  const blocks = []
  const re = /([^{}]*?)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    blocks.push({ selector: m[1].trim(), body: m[2] })
  }
  return blocks
}

function parseDeclarations(body) {
  const vars = {}
  for (const part of body.split(';')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    if (!key.startsWith('--')) continue
    const value = part.slice(idx + 1).replace(/!important\s*$/, '').trim()
    vars[key] = value
  }
  return vars
}

/** 判断一个选择器属于哪个主题;:root(无 data-theme)归属默认 black-air */
function themeOfSelector(selector) {
  const attr = selector.match(/\[data-theme="([^"]+)"\]/)
  if (attr) return attr[1]
  if (/(^|,)\s*:root\s*(,|$)/.test(selector)) return defaultTheme
  return null
}

function loadThemeVariables() {
  const files = [
    themeCorePath,
    ...fs.readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort().map((f) => path.join(themesDir, f)),
    creativePath
  ]
  const all = {}
  for (const file of files) {
    const css = stripComments(fs.readFileSync(file, 'utf8'))
    for (const block of findBlocks(css)) {
      const theme = themeOfSelector(block.selector)
      if (!theme) continue
      if (!all[theme]) all[theme] = {}
      Object.assign(all[theme], parseDeclarations(block.body))
    }
  }
  return all
}

/* --------------------------------------------------------------- 颜色计算 */

function parseColor(input) {
  if (input === undefined || input === null) return null
  const value = String(input).trim()
  if (/^(transparent|none|inherit|currentcolor)$/i.test(value)) return null
  let m = /^#([0-9a-f]{8})$/i.exec(value)
  if (m) {
    const h = m[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255 }
  }
  m = /^#([0-9a-f]{6})$/i.exec(value)
  if (m) {
    const h = m[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
  }
  m = /^#([0-9a-f]{3})$/i.exec(value)
  if (m) {
    const h = m[1]
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value)
  if (m) {
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) }
  }
  return null
}

function blend(foreground, background) {
  const a = foreground.a === undefined ? 1 : foreground.a
  return {
    r: foreground.r * a + background.r * (1 - a),
    g: foreground.g * a + background.g * (1 - a),
    b: foreground.b * a + background.b * (1 - a),
    a: 1
  }
}

function relativeLuminance(color) {
  const channel = (x) => {
    const v = x / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

function gradientStops(value) {
  if (value === undefined || !/gradient\(/i.test(String(value))) return null
  const stops = [...String(value).matchAll(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)].map((m) => m[1])
  return stops.length ? stops : null
}

/** 把任意颜色/渐变解析为不透明 RGB 数组(渐变各色标先与 base 合成) */
function resolveColors(value, base) {
  const stops = gradientStops(value)
  if (stops) {
    return stops
      .map((s) => parseColor(s))
      .filter(Boolean)
      .map((c) => blend(c, base))
  }
  const color = parseColor(value)
  return color ? [blend(color, base)] : []
}

/* ------------------------------------------------------------------ 校验 */

const themeVars = loadThemeVariables()
const themeNames = Object.keys(themeVars)
if (!themeNames.length) {
  console.error('✗ 未解析到任何主题变量')
  process.exit(1)
}

function get(theme, name) {
  return themeVars[theme] ? themeVars[theme][name] : undefined
}

function required(theme, name) {
  const value = get(theme, name)
  if (value === undefined) errors.push(`主题 "${theme}" 缺少变量 ${name}`)
  return value
}

/** 对每套主题执行一次检查,返回该主题所有组合里的最低对比度 */
function check(theme, { label, foreground, background, threshold, baseVar, recommendedThreshold }) {
  const base = parseColor(get(theme, baseVar || '--app-card-bg')) || { r: 255, g: 255, b: 255, a: 1 }
  const fgColors = resolveColors(get(theme, foreground), base)
  const bgColors = resolveColors(get(theme, background), base)
  if (!fgColors.length || !bgColors.length) {
    errors.push(`主题 "${theme}" 无法解析对比度检查「${label}」(${foreground} / ${background})`)
    return
  }
  let min = Infinity
  for (const fg of fgColors) {
    for (const bg of bgColors) {
      min = Math.min(min, contrastRatio(fg, bg))
    }
  }
  const value = Number(min.toFixed(2))
  const pass = value >= threshold
  const recommend = recommendedThreshold != null && value < recommendedThreshold
  if (!pass) {
    errors.push(`主题 "${theme}" 对比度不足:${label} 仅 ${value}:1(要求 ≥ ${threshold}:1)`)
  }
  summary.push({ theme, label, value, threshold, pass, recommend })
}

/** 表头背景优先使用 creative 艺术层 --app-table-head-bg,否则回退 --app-table-th-bg */
function tableHeadBgVar(theme) {
  return get(theme, '--app-table-head-bg') !== undefined ? '--app-table-head-bg' : '--app-table-th-bg'
}

for (const theme of themeNames) {
  // 1. 业务正文
  for (const fg of ['--app-text-primary', '--app-text-regular', '--app-text-secondary']) {
    required(theme, fg)
    for (const bg of ['--app-bg', '--app-card-bg']) {
      required(theme, bg)
      check(theme, { label: `${fg} 对 ${bg}`, foreground: fg, background: bg, threshold: 4.5, baseVar: bg })
    }
  }

  // 2. Element Plus 文字
  for (const fg of ['--el-text-color-primary', '--el-text-color-regular', '--el-text-color-secondary']) {
    required(theme, fg)
    for (const bg of ['--el-bg-color', '--el-bg-color-page']) {
      required(theme, bg)
      check(theme, { label: `${fg} 对 ${bg}`, foreground: fg, background: bg, threshold: 4.5, baseVar: bg })
    }
  }

  // 3. 占位符
  required(theme, '--app-text-placeholder')
  for (const bg of ['--app-bg', '--app-card-bg']) {
    check(theme, { label: `--app-text-placeholder 对 ${bg}`, foreground: '--app-text-placeholder', background: bg, threshold: 3, baseVar: bg, recommendedThreshold: 4.5 })
  }
  required(theme, '--el-text-color-placeholder')
  for (const bg of ['--el-bg-color', '--el-bg-color-page']) {
    check(theme, { label: `--el-text-color-placeholder 对 ${bg}`, foreground: '--el-text-color-placeholder', background: bg, threshold: 3, baseVar: bg, recommendedThreshold: 4.5 })
  }

  // 4. 表头
  if (get(theme, '--app-table-th-text') !== undefined) {
    check(theme, { label: '--app-table-th-text 对 --app-table-th-bg', foreground: '--app-table-th-text', background: '--app-table-th-bg', threshold: 4.5, baseVar: '--app-card-bg' })
  }
  if (get(theme, '--app-table-head-text') !== undefined) {
    check(theme, { label: '--app-table-head-text 对表头背景', foreground: '--app-table-head-text', background: tableHeadBgVar(theme), threshold: 4.5, baseVar: '--app-card-bg' })
  }

  // 5. 日志
  required(theme, '--app-log-bg')
  for (const fg of ['--app-log-text', '--app-log-muted']) {
    required(theme, fg)
    check(theme, { label: `${fg} 对 --app-log-bg`, foreground: fg, background: '--app-log-bg', threshold: 4.5, baseVar: '--app-log-bg' })
  }

  // 6. 顶栏文字(支持纯色与渐变)
  required(theme, '--app-header-text')
  required(theme, '--app-header-bg')
  check(theme, { label: '--app-header-text 对 --app-header-bg', foreground: '--app-header-text', background: '--app-header-bg', threshold: 4.5, baseVar: '--app-card-bg' })

  // 7. 菜单文字对侧栏
  required(theme, '--app-menu-text')
  required(theme, '--app-sidebar-bg')
  check(theme, { label: '--app-menu-text 对 --app-sidebar-bg', foreground: '--app-menu-text', background: '--app-sidebar-bg', threshold: 4.5, baseVar: '--app-sidebar-bg' })

  // 8. 菜单选中色对 active / hover 背景(半透明色以侧栏为底合成)
  required(theme, '--app-menu-active-color')
  for (const bg of ['--app-menu-active-bg', '--app-menu-hover-bg']) {
    if (get(theme, bg) === undefined) continue
    check(theme, { label: `--app-menu-active-color 对 ${bg}`, foreground: '--app-menu-active-color', background: bg, threshold: 4.5, baseVar: '--app-sidebar-bg' })
  }

  // 9. 顶栏标题:纯色标题色或渐变标题色
  const titleColor = get(theme, '--app-title-color')
  const titleBackground = get(theme, '--app-title-background')
  if (titleColor && !/^(transparent|none)$/i.test(String(titleColor).trim())) {
    check(theme, { label: '--app-title-color 对 --app-header-bg', foreground: '--app-title-color', background: '--app-header-bg', threshold: 4.5, baseVar: '--app-card-bg' })
  } else if (gradientStops(titleBackground)) {
    check(theme, { label: '标题渐变对 --app-header-bg', foreground: '--app-title-background', background: '--app-header-bg', threshold: 4.5, baseVar: '--app-card-bg' })
  } else {
    errors.push(`主题 "${theme}" 的标题既没有可解析的 --app-title-color,也没有可解析的 --app-title-background`)
  }

  // 10. 语义反色文字：按钮/徽标文字必须与主色、主按钮渐变两端、成功/危险色可分辨
  const semanticChecks = [
    ['--app-on-primary', ['--app-primary-gradient', '--app-primary-gradient-hover', '--app-accent']],
    ['--app-accent-contrast', ['--app-accent']],
    ['--app-on-success', ['--app-success', '--el-color-success']],
    ['--app-on-danger', ['--app-danger', '--el-color-danger']],
  ]
  for (const [fg, backgrounds] of semanticChecks) {
    if (get(theme, fg) === undefined) continue
    for (const bg of backgrounds) {
      if (get(theme, bg) === undefined) continue
      check(theme, { label: `${fg} 对 ${bg}`, foreground: fg, background: bg, threshold: 4.5, baseVar: bg })
    }
  }
}

/* --------------------------------------------------------------- 输出结果 */

console.log('=== 主题对比度审计 ===')
console.log(`主题: ${themeNames.join(', ')}`)
for (const item of summary) {
  const mark = item.pass ? '✓' : '✗'
  const tip = item.recommend ? `(推荐 ≥ 4.5)` : ''
  console.log(`${mark} [${item.theme}] ${item.label}: ${item.value}:1 / ≥${item.threshold}${tip}`)
}

if (errors.length) {
  console.error(`\n✗ 主题对比度校验失败 (${errors.length} 个问题)`)
  errors.forEach((e) => console.error(`  - ${e}`))
  process.exit(1)
}

console.log(`\n✓ 主题对比度校验通过:${themeNames.length} 套主题,共 ${summary.length} 项核心文字/背景组合达到阈值`)
