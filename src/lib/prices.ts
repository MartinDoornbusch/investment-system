import { supabase } from './supabase'
import type { PriceRow } from './types'

// ── localStorage keys ────────────────────────────────────────────────────────
const LS_PREV = 'invsys_prev_prices'       // { ticker: price }
const LS_DATE = 'invsys_prev_prices_date'  // 'Mon Jun 23 2026'

// Snapshot today's prices into localStorage so tomorrow we can show daily change.
// Only snapshots once per calendar day — safe to call on every page load.
async function maybeSnaphotPrices(): Promise<void> {
  const today = new Date().toDateString()
  if (localStorage.getItem(LS_DATE) === today) return  // already done today
  const { data } = await supabase.from('prices').select('ticker,price')
  if (!data || data.length === 0) return
  const map: Record<string, number> = {}
  ;(data as PriceRow[]).forEach(r => { map[r.ticker] = Number(r.price) })
  localStorage.setItem(LS_PREV, JSON.stringify(map))
  localStorage.setItem(LS_DATE, today)
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Returns current prices keyed by ticker. */
export async function getPrices(): Promise<Record<string, number>> {
  await maybeSnaphotPrices()
  const { data } = await supabase.from('prices').select('ticker,price')
  const map: Record<string, number> = {}
  ;(data as PriceRow[] | null)?.forEach(r => { map[r.ticker] = Number(r.price) })
  return map
}

/** Returns current prices + daily change % (null if no baseline yet). */
export async function getPricesWithChange(): Promise<Record<string, { price: number; changePct: number | null }>> {
  await maybeSnaphotPrices()
  const { data } = await supabase.from('prices').select('ticker,price,change_pct')
  const prev: Record<string, number> = JSON.parse(localStorage.getItem(LS_PREV) || '{}')
  const today = new Date().toDateString()
  const snapDate = localStorage.getItem(LS_DATE)
  const hasPrev = snapDate !== today  // snapshot from a previous day means it's yesterday's prices

  const map: Record<string, { price: number; changePct: number | null }> = {}
  ;(data as PriceRow[] | null)?.forEach(r => {
    const price = Number(r.price)
    // Prefer DB-stored change_pct (populated by edge function), fall back to localStorage diff
    let changePct: number | null = r.change_pct ?? null
    if (changePct == null && hasPrev && prev[r.ticker]) {
      changePct = ((price - prev[r.ticker]) / prev[r.ticker]) * 100
    }
    map[r.ticker] = { price, changePct }
  })
  return map
}

/** Triggers the Edge Function to fetch fresh quotes for the given tickers.
 *  The function (Finnhub /quote) stores price + today's change_pct + prev_close directly,
 *  so no client-side change% computation is needed. */
export async function refreshPrices(tickers: string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('refresh-prices', { body: { tickers } })
    if (error) return { ok: false, error: error.message }
    localStorage.removeItem(LS_DATE) // refresh the localStorage snapshot baseline on next load
    return { ok: true, ...(data || {}) }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'refresh failed' }
  }
}

// ── Other edge-function wrappers (unchanged) ─────────────────────────────────

export async function autoScore(): Promise<{ ok: boolean; scored?: number; skipped?: number; uncached?: string[]; keptMassive?: string[]; missingMassive?: string[]; unchanged?: string[]; errors?: string[]; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('auto-score', { body: {} })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'auto-score failed' } }
}

export interface TickerProfile {
  ticker: string; name?: string; description?: string; industry?: string; sic_code?: number
  exchange?: string; currency?: string; market_cap?: number; employees?: number
  homepage?: string; logo?: string | null; list_date?: string
}
export interface NewsItem { id: string; title: string; publisher?: string; url: string; image?: string; published?: string; description?: string; sentiment?: string | null; tickers?: string[] }
export interface TickerDetail {
  ok: boolean; profile?: TickerProfile | null; bars?: { t: number; c: number; v: number }[] | null
  news?: { own: NewsItem[]; peers: { ticker: string; articles: NewsItem[] }[] } | null
  error?: string
}
export async function tickerDetail(ticker: string): Promise<TickerDetail> {
  try {
    const { data, error } = await supabase.functions.invoke('ticker-detail', { body: { ticker, peers: true } })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'ticker-detail failed' } }
}

export async function screen(payload: any): Promise<any> {
  try { const { data, error } = await supabase.functions.invoke('screen', { body: payload }); if (error) return { ok: false, error: error.message }; return data }
  catch (e: any) { return { ok: false, error: e?.message ?? 'screen failed' } }
}

// Refresh the candidate universe. step:'membership' re-fetches the S&P 1500 constituent lists; step:'enrich'
// (default) does a paced Finnhub fundamentals batch. A bare number is treated as a batch size (back-compat).
export async function refreshUniverse(opts: number | { step?: 'membership' | 'enrich'; batch?: number } = {}): Promise<{ ok: boolean; refreshed?: string[]; remaining?: number; pending?: number; upserted?: number; counts?: any; total?: number; error?: string }> {
  const body = typeof opts === 'number' ? { batch: opts } : opts
  try {
    const { data, error } = await supabase.functions.invoke('refresh-universe', { body })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'refresh failed' } }
}

// Refresh an international region's universe (Europe v1): one TradingView scanner pull replaces the whole
// region in universe_cache — no membership/enrich split, no pacing needed (single POST server-side).
export async function refreshUniverseIntl(region: string = 'europe'): Promise<{ ok: boolean; written?: number; counts?: any; skipped?: any; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('refresh-universe-intl', { body: { region } })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'refresh failed' } }
}

export async function refreshFundamentals(batch = 4): Promise<{ ok: boolean; refreshed?: string[]; remaining?: number; total?: number; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('refresh-fundamentals', { body: { batch } })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'refresh failed' } }
}

export async function bitvavoSync(): Promise<{ ok: boolean; coins?: number; inserted?: number; updated?: number; removed?: number; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('bitvavo-sync', { body: {} })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'sync failed' } }
}
