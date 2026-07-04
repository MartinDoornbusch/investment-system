import { supabase } from './supabase'
import type { Holding, ScoreRecord, WatchItem, JournalEntry, SystemConfig, CorporateAction, Fundamentals } from './types'
import { DEFAULT_CONFIG } from './defaults'

async function uid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser()
  return data.user?.id ?? null
}

export async function getConfig(): Promise<SystemConfig> {
  const id = await uid(); if (!id) return DEFAULT_CONFIG
  const { data } = await supabase.from('system_config').select('config').eq('user_id', id).maybeSingle()
  return (data?.config as SystemConfig) ?? DEFAULT_CONFIG
}
export async function saveConfig(config: SystemConfig) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('system_config').upsert({ user_id: id, config }).select()
}

export async function listHoldings(): Promise<Holding[]> {
  const { data } = await supabase.from('holdings').select('*').order('ticker')
  return (data as Holding[]) ?? []
}
export async function upsertHolding(h: Holding) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('holdings').upsert({ ...h, user_id: id }).select()
}
export async function deleteHolding(id: string) {
  return supabase.from('holdings').delete().eq('id', id)
}
export async function seedHoldings(rows: Omit<Holding, 'user_id' | 'id'>[]) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('holdings').insert(rows.map(r => ({ ...r, user_id: id })))
}

export async function listScores(): Promise<ScoreRecord[]> {
  const { data } = await supabase.from('scores').select('*').order('created_at', { ascending: false })
  return (data as ScoreRecord[]) ?? []
}
export async function addScore(s: ScoreRecord) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('scores').insert({ ...s, user_id: id }).select()
}

export async function listWatch(): Promise<WatchItem[]> {
  const { data } = await supabase.from('watchlist').select('*').order('created_at', { ascending: false })
  return (data as WatchItem[]) ?? []
}
export async function addWatch(w: WatchItem) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('watchlist').insert({ ...w, user_id: id }).select()
}
/** Latest updated_at per data feed, for freshness badges. */
export async function feedTimestamps(): Promise<{ prices: string | null; fundamentals: string | null; universe: string | null }> {
  const [p, f, u] = await Promise.all([
    supabase.from('prices').select('updated_at').order('updated_at', { ascending: false }).limit(1),
    supabase.from('fundamentals').select('updated_at').order('updated_at', { ascending: false }).limit(1),
    supabase.from('universe_cache').select('updated_at').order('updated_at', { ascending: false }).limit(1),
  ])
  return {
    prices: (p.data as any)?.[0]?.updated_at ?? null,
    fundamentals: (f.data as any)?.[0]?.updated_at ?? null,
    universe: (u.data as any)?.[0]?.updated_at ?? null,
  }
}
export async function fundamentalsByTicker(ticker: string): Promise<Fundamentals | null> {
  const { data } = await supabase.from('fundamentals').select('*').eq('ticker', ticker).maybeSingle()
  return (data as Fundamentals) ?? null
}
/** ticker -> sector, from the cached fundamentals table. Used to label feed rows with an industry. */
export async function sectorMap(): Promise<Record<string, string>> {
  const { data } = await supabase.from('fundamentals').select('ticker,sector')
  const m: Record<string, string> = {}
  ;(data as any[] ?? []).forEach(r => { if (r?.ticker && r?.sector) m[r.ticker] = r.sector })
  return m
}
export async function updateWatch(id: string, patch: Partial<WatchItem>) {
  return supabase.from('watchlist').update(patch).eq('id', id)
}
export async function deleteWatch(id: string) { return supabase.from('watchlist').delete().eq('id', id) }

export async function listJournal(): Promise<JournalEntry[]> {
  const { data } = await supabase.from('journal').select('*').order('date', { ascending: false })
  return (data as JournalEntry[]) ?? []
}
export async function addJournal(j: JournalEntry) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('journal').insert({ ...j, user_id: id }).select()
}
export async function deleteJournal(id: string) { return supabase.from('journal').delete().eq('id', id) }

export async function holdingByTicker(ticker: string): Promise<Holding | null> {
  const { data } = await supabase.from('holdings').select('*').eq('ticker', ticker).limit(1).maybeSingle()
  return (data as Holding) ?? null
}
export async function latestScoreByTicker(ticker: string): Promise<ScoreRecord | null> {
  const { data } = await supabase.from('scores').select('*').eq('ticker', ticker).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as ScoreRecord) ?? null
}

export async function scoresByTicker(ticker: string): Promise<ScoreRecord[]> {
  const { data } = await supabase.from('scores').select('*').eq('ticker', ticker).order('created_at', { ascending: false })
  return (data as ScoreRecord[]) ?? []
}

export async function listTransactions(): Promise<import('./types').Transaction[]> {
  const { data } = await supabase.from('transactions').select('*').order('date', { ascending: false })
  return (data as import('./types').Transaction[]) ?? []
}
/** Order IDs already stored, so a re-import skips rows that are already in the ledger. */
export async function existingOrderIds(): Promise<Set<string>> {
  const { data } = await supabase.from('transactions').select('order_id')
  return new Set(((data as any[]) ?? []).map(r => r.order_id).filter(Boolean))
}
export async function insertTransactions(rows: Omit<import('./types').Transaction, 'id'>[]) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('transactions').insert(rows.map(r => ({ ...r, user_id: id }))).select()
}

export async function listCorporateActions(): Promise<CorporateAction[]> {
  const { data } = await supabase.from('corporate_actions').select('*').order('effective_date', { ascending: false })
  return (data as CorporateAction[]) ?? []
}
export async function addCorporateAction(a: CorporateAction) {
  const id = await uid(); if (!id) throw new Error('not signed in')
  return supabase.from('corporate_actions').insert({ ...a, user_id: id }).select()
}
export async function deleteCorporateAction(id: string) {
  return supabase.from('corporate_actions').delete().eq('id', id)
}
