/**
 * 表格展示工具(2026-08-12 抽取:TableView / ScreeningAnalysisView / FirstInquiryView 三处重复)
 * 只放纯函数(不依赖组件内部状态);formatCell 等依赖组件状态的保留在各组件内
 */

// 状态类字段:颜色标注 + 显示映射 + 排序
export const STATUS_COLS = ['产品情况', '是否已询盘', '状态', '完成情况']
export const isStatusCol = (name) => STATUS_COLS.includes(name)

const STATUS_TAG_TYPE = {
  '已分析': 'success', '已筛选': 'success', '是': 'success', '已完成': 'success', '已完成（三轮）': 'success',
  '未分析': 'info', '未筛选': 'info', '否': 'info', '未回复': 'info',
  '部分完成': 'warning', '未完成': 'primary', '进行中': 'primary', '询盘中': 'primary',
  '异常': 'danger',
}
export const statusTagType = (v) => STATUS_TAG_TYPE[String(v ?? '')] || 'info'

// 表内数据值 → 界面文案(已筛选→已分析/是→已询盘等;其余原样)
export const statusDisplay = (v) => {
  const s = String(v ?? '')
  if (s === '已筛选') return '已分析'
  if (s === '未筛选') return '未分析'
  if (s === '是') return '已询盘'
  if (s === '否') return '未询盘'
  return s
}

// 状态排序优先级:异常/部分完成/未完成在前(需处理),已完成/已分析在后
export const STATUS_ORDER = {
  '异常': 0, '部分完成': 1, '未完成': 2, '进行中': 2, '询盘中': 2,
  '未回复': 3, '已完成': 4, '已完成（三轮）': 4, '已分析': 4, '已筛选': 4, '是': 4,
  '未分析': 5, '未筛选': 5, '否': 5,
}
export const sortByStatusFor = (colName) => (a, b) => {
  const av = String(a[colName] ?? ''), bv = String(b[colName] ?? '')
  const ao = STATUS_ORDER[av] ?? 9, bo = STATUS_ORDER[bv] ?? 9
  if (ao !== bo) return ao - bo
  return av.localeCompare(bv, 'zh-CN')
}

// 通用排序:空值/空数组/空字符串排在后面,数值列按数字排序,其余按文本排序
export const isCellValueEmpty = (v) => {
  if (v === null || v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  return String(v).trim() === ''
}

const sortableValueText = (v) => {
  if (Array.isArray(v)) {
    return v.map(x => {
      if (!x) return ''
      if (typeof x === 'string') return x
      return x.name || x.text || x.link || x.url || x.title || x.en_name || ''
    }).filter(Boolean).join(' ')
  }
  if (v && typeof v === 'object') {
    return String(v.text || v.name || v.link || v.url || v.title || v.en_name || '')
  }
  return String(v ?? '')
}

export const sortByValueFor = (colName) => (a, b) => {
  const av = a?.[colName]
  const bv = b?.[colName]
  const aEmpty = isCellValueEmpty(av)
  const bEmpty = isCellValueEmpty(bv)
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1
  const as = sortableValueText(av).trim()
  const bs = sortableValueText(bv).trim()
  const numericRe = /^-?\d+(\.\d+)?$/
  const an = Number(as)
  const bn = Number(bs)
  if (numericRe.test(as) && numericRe.test(bs) && !Number.isNaN(an) && !Number.isNaN(bn)) {
    return an - bn
  }
  return as.localeCompare(bs, 'zh-CN')
}

// 附件/图片值判断与取 token
// 注意:不能把「id」当作图片凭据——飞书人员/群组等字段的对象也带 id,
// 例如 推荐人(人员字段)返回 [{ id, name, avatar_url }],若按 id 判断会被误当成图片。
export const isImageValue = (value) =>
  Array.isArray(value) && value.length > 0 &&
  typeof value[0] === 'object' && value[0] !== null &&
  Boolean(value[0].file_token || value[0].attachmentToken)

export const imageToken = (img) => img?.file_token || img?.attachmentToken || ''

// 新多维表格附件下载需要 extra 参数(bitablePerm):
// 优先取附件对象顶层 extra 字段，其次从附件 url/tmp_url 的 query 中提取
export const imageExtra = (img) => {
  if (img?.extra) {
    return typeof img.extra === 'string' ? img.extra : JSON.stringify(img.extra)
  }
  const url = img?.url || img?.tmp_url || ''
  try {
    return new URL(url).searchParams.get('extra') || ''
  } catch {
    return ''
  }
}

// 飞书链接字段(美客多链接/大麦链接等)可能返回 { link, text } 对象
export const isUrlValue = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) &&
  Boolean(value.link || value.url)

export const urlLink = (value) => value?.link || value?.url || ''

// 体积类字段(平均内箱体积(立方米) 等):原始值极小(0.004687、0.000117),
// 统一按两位小数显示会一律变成 0.00,因此按字段名放宽到 6 位小数。
const VOLUME_FIELD_RE = /体积|立方米/
export const isVolumeField = (colName) => VOLUME_FIELD_RE.test(String(colName ?? ''))

// 至多 6 位小数,去掉末尾多余的 0(整数照常显示为整数);小于 1e-6 的极小值用有效数字兜底
export const formatVolumeValue = (n) => {
  if (!Number.isFinite(n) || n === 0) return '0'
  const fixed = n.toFixed(6)
  if (Number(fixed) === 0) return String(Number(n.toPrecision(3)))
  return String(Number(fixed))
}
