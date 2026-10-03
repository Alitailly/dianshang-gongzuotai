export interface ProductVariation {
  store: string
  item_id: string
  variation_id: string | null
  title: string | null
  seller_sku: string | null
  gtin: string | null
  price: number | null
  available_quantity: number | null
  sold_quantity: number | null
  currency_id: string | null
  revenue: number | null
  commission: number | null
  shipping_fee: number | null
  settlement: number | null
  performance_score: number | null
  performance_level: string | null
  has_ads: boolean
  ad_clicks: number | null
  ad_impressions: number | null
  ad_ctr: number | null
  ad_cost: number | null
  ad_roas: number | null
  attributes: Record<string, any> | null
  updated_at: string | null
}

export interface ProductListResult {
  items: ProductVariation[]
  total: number
  page: number
  page_size: number
}

export interface VariationDetail {
  variation_id: string | null
  seller_sku: string | null
  gtin: string | null
  price: number | null
  available_quantity: number | null
  sold_quantity: number | null
  attributes: Record<string, any> | null
}

export interface ItemListItem {
  store: string
  item_id: string
  title: string | null
  seller_sku: string | null
  currency_id: string | null
  variation_count: number
  available_quantity: number | null
  sold_quantity: number | null
  revenue: number | null
  commission: number | null
  shipping_fee: number | null
  settlement: number | null
  total_visits: number | null
  natural_visits: number | null
  natural_visits_rate: number | null
  ad_click_rate: number | null
  natural_sales: number | null
  natural_sales_rate: number | null
  ad_share: number | null
  discount_total: number | null
  unit_commission: number | null
  unit_shipping: number | null
  unit_income: number | null
  performance_score: number | null
  performance_level: string | null
  has_ads: boolean
  ad_clicks: number | null
  ad_impressions: number | null
  ad_ctr: number | null
  ad_cost: number | null
  ad_roas: number | null
  ad_sales: number | null
  ad_acos: number | null
  price: number | null
  last_price: number | null
  full_price: number | null
  coupon_amount: number | null
  original_price: number | null
  ref_original_price: number | null
  sale_price: number | null
  promotion_type: string | null
  platform_shipping: number | null
  status: string | null
  listing_type: string | null
  free_shipping: boolean | null
  shipping_payer: string | null
  item_status: string | null
  commission_rate_actual: number | null
  discount_reason: string | null
  discount_rate: number | null
  commission_rate: number | null
  settlement_rate: number | null
  ad_net: number | null
  breakeven_roas: number | null
  updated_at: string | null
  variations: VariationDetail[]
}

export interface ItemListResult {
  items: ItemListItem[]
  total: number
  page: number
  page_size: number
}

export interface StoreInfo {
  name: string
  display_name: string
  site_id: string
}

export interface StoreAgg {
  store: string
  skus: number
  items: number
  sold: number
  orders: number
  ad_cost: number
  revenue: number
}

export interface OverviewResult {
  total_skus: number
  total_items: number
  store_count: number
  total_orders: number
  total_sold: number
  total_revenue: number
  total_commission: number
  total_shipping_fee: number
  total_settlement: number
  total_ad_cost: number
  prev_sold: number
  prev_orders: number
  prev_revenue: number
  prev_settlement: number
  prev_ad_cost: number
  yesterday_sold: number
  yesterday_orders: number
  yesterday_revenue: number
  yesterday_settlement: number
  yesterday_ad_cost: number | null
  active_listings: number
  sold_listings: number
  sold_rate: number
  prev_sold_rate: number
  by_store: StoreAgg[]
}

export interface TrendDay {
  date: string
  sold: number
  revenue: number
  commission: number
  shipping_fee: number
  orders: number
  ad_cost: number
}

export interface RankingItem {
  rank: number
  store: string
  item_id: string
  title: string | null
  value: number
}

export interface RankingResult {
  type: string
  items: RankingItem[]
}

export interface AdsMetrics {
  cost: number
  sales: number
  clicks: number
  impressions: number
  ad_items: number
  roas: number
  acos: number
  ctr: number
  cpc: number
}

export interface AdsSummary {
  ad_finalized_date: string
  current: AdsMetrics
  prev: AdsMetrics | null
  yesterday: AdsMetrics | null
}

export interface AdsTrendDay {
  date: string
  cost: number
  sales: number
  clicks: number
  impressions: number
  finalized: boolean
}

export interface AdsItem {
  store: string
  item_id: string
  title: string | null
  ad_cost: number | null
  ad_clicks: number | null
  ad_impressions: number | null
  ad_ctr: number | null
  ad_sales: number | null
  ad_roas: number | null
  ad_acos: number | null
}

export interface AdsItemListResult {
  items: AdsItem[]
  total: number
  page: number
  page_size: number
}

export interface DataSourceStatus {
  real_time: boolean
  note: string
}

export interface DataStatus {
  br_now: string
  br_today: string
  latest_finalized_date: string
  earliest_date: string | null
  ad_finalize_time: string
  ad_timezone: string
  data_sources: Record<string, DataSourceStatus>
}

// ===== 广告投放监控 + 决策辅助 =====
export interface AdManageItem {
  store: string
  item_id: string
  title: string
  thumbnail: string
  permalink: string
  status: string // active / hold
  status_raw: string
  campaign_id: number | null
  ad_group_id: number | null
  current_level: string // green / newbie
  buy_box_winner: boolean
  deferred_stock: boolean
  has_discount: boolean
  image_quality: string
  recommended: boolean
  logistic_type: string
  listing_type_id: string
  price: number | null
  ad_cost: number
  ad_sales: number
  ad_clicks: number
  ad_impressions: number
  ad_ctr: number
  ad_roas: number
  ad_acos: number
  breakeven_roas: number
  settlement_rate: number
  commission: number
  shipping_fee: number
  revenue: number
  attention: boolean
  last_op: { op_type: string; note: string; created_at: string } | null
}

export interface AdManageListResult {
  items: AdManageItem[]
  total: number
  page: number
  page_size: number
}

export interface AdManageSummary {
  active_count: number
  hold_count: number
  total_count: number
  ad_cost: number
  ad_sales: number
  roas: number
  acos: number
  buy_box_rate: number
  avg_breakeven_roas: number
  ad_finalized_date: string | null
}

export interface AdOp {
  id: number
  store: string
  item_id: string
  campaign_id: string | null
  ad_group_id: string | null
  op_type: string
  op_label: string
  note: string
  created_at: string
}

// ===== AI：广告助手 =====
export interface AdBlock {
  metric: string
  value: string
  advice: string
}

export interface AdSummaryMetrics {
  cost: number
  sales: number
  clicks: number
  impressions: number
  ad_items: number
  roas: number
  acos: number
  ctr: number
  cpc: number
}

export interface AdAnalysisResult {
  ok: boolean
  reason?: 'no_data' | 'llm_error' | 'parse_error'
  message?: string
  date_from?: string
  date_to?: string
  ad_finalized_date?: string
  summary?: AdSummaryMetrics
  overview?: string
  blocks?: AdBlock[]
}

// ===== AI：站内信消息工作台 =====
export type MessageTag = 'pre_sale' | 'post_sale'
export type MessageStatus = 'new' | 'draft' | 'sent' | 'skipped'

export interface MessageItem {
  id: number
  store: string
  pack_id: string
  message_id: string
  tag: MessageTag
  sender_id: string
  sender_name: string
  message_text: string
  item_id: string | null
  order_id: string | null
  received_at: string | null
  draft: string | null
  status: MessageStatus
  created_at: string
  updated_at: string
}

export interface MessageHistoryMsg {
  id: string
  from: { user_id: number | string; name?: string } | null
  text: string
  date_created?: string
  item_id?: string
  order_id?: string
  _author?: '买家' | '卖家' | '未知'
}

export interface MessageDetail {
  ok: boolean
  message?: string
  item?: MessageItem
  history?: MessageHistoryMsg[]
}

export interface MessageActionResult {
  ok: boolean
  message: string
  draft?: string
}

export interface MessageSyncResult {
  ok: boolean
  new: number
  failed: number
  stores?: Array<{
    store: string
    new?: number
    failed?: number
    error?: string
  }>
}
