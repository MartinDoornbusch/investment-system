// Market feed + news digest helpers (redeploy trigger 2026-06-25)
import { supabase } from './supabase'

export interface EarningsItem { ticker: string; date: string; hour: string | null; epsEstimate: number | null; revenueEstimate: number | null; quarter: number | null; year: number | null }
export interface IpoItem { symbol: string | null; name: string; date: string; exchange: string | null; price: string | null; shares: number | null; value: number | null; status: string | null; impliedCap?: number | null; sharesOut?: number | null; ipoDate?: string | null; industry?: string | null }
export interface NewsDigestItem {
  id: string; ticker: string | null; bucket: string | null; headline: string; url: string | null; source: string | null
  published_at: string | null; category: string | null; priority: number | null
  consensus: string | null; horizon_impact: string | null; actionable: string | null; summary: string | null; digest_date: string
}

/** Invoke the Finnhub-backed market-feed edge function. */
export async function marketFeed(mode: 'earnings' | 'ipo' | 'news', body: Record<string, any> = {}): Promise<any> {
  try {
    const { data, error } = await supabase.functions.invoke('market-feed', { body: { mode, ...body } })
    if (error) return { ok: false, error: error.message }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'market-feed failed' } }
}

/** AI-generated brief of a company's S-1 IPO prospectus (SEC EDGAR + Claude). Cached server-side. */
export async function ipoBrief(company: string, ticker?: string): Promise<{ ok: boolean; brief?: string; filingUrl?: string; filedAt?: string; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('ipo-brief', { body: { company, ticker } })
    if (error) {
      // supabase-js collapses any non-2xx into "…non-2xx status code"; dig the real message out of the response body.
      let msg = error.message
      try { const b = await (error as any)?.context?.json?.(); if (b?.error) msg = b.error } catch { /* keep generic */ }
      return { ok: false, error: msg }
    }
    return data
  } catch (e: any) { return { ok: false, error: e?.message ?? 'ipo-brief failed' } }
}

/** Read the most recent daily news digest (written by the scheduled task). */
export async function getNewsDigest(): Promise<{ date: string | null; items: NewsDigestItem[] }> {
  const { data: latest } = await supabase.from('news_digest').select('digest_date').order('digest_date', { ascending: false }).limit(1)
  const date = (latest as any)?.[0]?.digest_date ?? null
  if (!date) return { date: null, items: [] }
  const { data } = await supabase.from('news_digest').select('*').eq('digest_date', date)
    .order('priority', { ascending: true }).order('published_at', { ascending: false })
  return { date, items: (data as NewsDigestItem[]) ?? [] }
}

// ── Market index strip ──────────────────────────────────────────────────────
export interface IndexQuote { price: number; ma200: number | null; chg: number | null }
export interface MarketData { indices: Record<string, IndexQuote>; state: string; m: number; dist: number }

/** Index levels + 200-DMA + day % for the requested extra indices (US S&P/Nasdaq always included), plus market regime. */
export async function getMarketIndices(extra: string[]): Promise<MarketData | null> {
  try {
    const { data, error } = await supabase.functions.invoke('market-indices', { body: { extra } })
    if (error || !data?.ok) return null
    return data as MarketData
  } catch { return null }
}
