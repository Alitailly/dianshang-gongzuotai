import axios from 'axios'
import type { AdAnalysisResult, AdManageItem, AdManageListResult, AdManageSummary, AdOp, AdsItemListResult, AdsSummary, AdsTrendDay, DataStatus, ItemListResult, MessageActionResult, MessageDetail, MessageItem, MessageSyncResult, OverviewResult, ProductListResult, RankingResult, StoreInfo, TrendDay } from '../types'

const API_BASE = String(import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '')
const http = axios.create({ baseURL: API_BASE, timeout: 120000 })

export const api = {
  getStores: (): Promise<StoreInfo[]> => http.get('/stores').then((r) => r.data),
  getDataStatus: (): Promise<DataStatus> => http.get('/meta/data-status').then((r) => r.data),
  getOverview: (params: Record<string, any>): Promise<OverviewResult> =>
    http.get('/overview', { params }).then((r) => r.data),
  getTrend: (params: Record<string, any>): Promise<TrendDay[]> =>
    http.get('/overview/trend', { params }).then((r) => r.data),
  getRankings: (params: Record<string, any>): Promise<RankingResult> =>
    http.get('/overview/rankings', { params }).then((r) => r.data),
  getAdsSummary: (params: Record<string, any>): Promise<AdsSummary> =>
    http.get('/ads/summary', { params }).then((r) => r.data),
  getAdsTrend: (params: Record<string, any>): Promise<AdsTrendDay[]> =>
    http.get('/ads/trend', { params }).then((r) => r.data),
  getAdsItems: (params: Record<string, any>): Promise<AdsItemListResult> =>
    http.get('/ads/items', { params }).then((r) => r.data),
  getAdManageItems: (params: Record<string, any>): Promise<AdManageListResult> =>
    http.get('/ad-manage/items', { params }).then((r) => r.data),
  getAdManageSummary: (params: Record<string, any>): Promise<AdManageSummary> =>
    http.get('/ad-manage/summary', { params }).then((r) => r.data),
  getAdOps: (params: Record<string, any>): Promise<AdOp[]> =>
    http.get('/ad-manage/ops', { params }).then((r) => r.data),
  createAdOp: (body: Record<string, any>): Promise<{ id: number }> =>
    http.post('/ad-manage/ops', body).then((r) => r.data),
  getProducts: (params: Record<string, any>): Promise<ProductListResult> =>
    http.get('/products', { params }).then((r) => r.data),
  getItems: (params: Record<string, any>): Promise<ItemListResult> =>
    http.get('/items', { params }).then((r) => r.data),
  sync: (): Promise<{ running: boolean; message: string }> =>
    http.post('/sync').then((r) => r.data),
  syncStatus: (): Promise<any> => http.get('/sync/status').then((r) => r.data),
  exportUrl: (params: Record<string, any>) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null) as any,
    ).toString()
    return `${API_BASE}/export/products.csv${qs ? '?' + qs : ''}`
  },
  // ===== AI 功能 =====
  analyzeAds: (params: Record<string, any>): Promise<AdAnalysisResult> =>
    http.get('/ai/ad-analysis', { params }).then((r) => r.data),
  getMessages: (params: Record<string, any>): Promise<{ items: MessageItem[] }> =>
    http.get('/messages', { params }).then((r) => r.data),
  getMessageDetail: (id: number): Promise<MessageDetail> =>
    http.get(`/messages/${id}`).then((r) => r.data),
  generateDraft: (id: number): Promise<MessageActionResult> =>
    http.post(`/messages/${id}/draft`).then((r) => r.data),
  sendMessageReply: (id: number, draft?: string): Promise<MessageActionResult> =>
    http.post(`/messages/${id}/send`, { draft }).then((r) => r.data),
  skipMessage: (id: number): Promise<MessageActionResult> =>
    http.post(`/messages/${id}/skip`).then((r) => r.data),
  syncMessages: (store?: string): Promise<MessageSyncResult> =>
    http.post('/messages/sync', null, { params: store ? { store } : {} }).then((r) => r.data),
}
