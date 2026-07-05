// Price cache refresher (free sources):
//  - US tickers      : Finnhub /quote (price + today's % change + prev close).
//  - Non-US (.AS/.KS): Yahoo v8 chart (keyless, native currency). ASML.AS falls back to USD ADR ÷ EUR/USD.
// Secret: FINNHUB_API_KEY (SUPABASE_URL/SERVICE_ROLE auto-provided).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const FINN = 'https://finnhub.io/api/v1'
const KEY = Deno.env.get('FINNHUB_API_KEY') || ''
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Amsterdam listings that have a US-listed equivalent we can FX-convert as a fallback.
const US_EQUIV: Record<string, string> = { 'ASML.AS': 'ASML' }

async function fquote(t: string, tries = 3): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${FINN}/quote?symbol=${encodeURIComponent(t)}&token=${KEY}`)
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue }
      if (!r.ok) return null
      return await r.json()
    } catch { await sleep(400) }
  }
  return null
}
// Yahoo v8 chart — keyless, returns native-currency price + previous close.
async function yahooQuote(t: string): Promise<{ price: number; prevClose: number | null; changePct: number | null } | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=5d`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const j = await r.json()
    const m = j?.chart?.result?.[0]?.meta
    if (!m || typeof m.regularMarketPrice !== 'number') return null
    const price = m.regularMarketPrice
    const prev = typeof m.chartPreviousClose === 'number' ? m.chartPreviousClose : (typeof m.previousClose === 'number' ? m.previousClose : null)
    const changePct = prev && prev !== 0 ? ((price - prev) / prev) * 100 : null
    return { price, prevClose: prev, changePct }
  } catch { return null }
}

// Crypto (e.g. BTC-EUR) via Bitvavo's public ticker — keyless, EUR-native.
async function bitvavoQuote(market: string): Promise<{ price: number; changePct: number | null; prevClose: number | null } | null> {
  try {
    const r = await fetch(`https://api.bitvavo.com/v2/ticker/24h?market=${encodeURIComponent(market)}`)
    if (!r.ok) return null
    const j = await r.json()
    const last = Number(j?.last), open = Number(j?.open)
    if (!isFinite(last) || last <= 0) return null
    const changePct = isFinite(open) && open > 0 ? ((last - open) / open) * 100 : null
    return { price: last, changePct, prevClose: isFinite(open) && open > 0 ? open : null }
  } catch { return null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    if (!KEY) return new Response(JSON.stringify({ ok: false, error: 'FINNHUB_API_KEY not set' }), { status: 500, headers: cors })

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Explicit list from the caller, or (cron / body.all) every holdings + watchlist ticker — so crypto
    // is priced automatically and the list never goes stale when holdings change.
    let tickers: string[] = Array.isArray(body.tickers) ? body.tickers : []
    if (!tickers.length || body.all) {
      const [{ data: h }, { data: w }] = await Promise.all([admin.from('holdings').select('ticker'), admin.from('watchlist').select('ticker')])
      tickers = Array.from(new Set([...(h ?? []), ...(w ?? [])].map((x: any) => x.ticker).filter(Boolean)))
    }
    if (!tickers.length)
      return new Response(JSON.stringify({ ok: false, error: 'no tickers' }), { status: 400, headers: cors })
    // USD→EUR conversion rate (USD per 1 EUR). Prefer a live ECB rate (frankfurter.app — free, keyless),
    // fall back to the configured value, then a hardcoded constant. Persisting the live rate back into
    // config (with a timestamp) means every consumer that reads cfg.eur_usd stops silently drifting.
    const { data: cfgRow } = await admin.from('system_config').select('user_id,config').maybeSingle()
    let eurUsd = Number(cfgRow?.config?.eur_usd) > 0 ? Number(cfgRow!.config.eur_usd) : 1.1429
    let fxAt: string | null = null
    try {
      const fr = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD')
      if (fr.ok) { const fj = await fr.json(); const live = Number(fj?.rates?.USD); if (live > 0) { eurUsd = live; fxAt = new Date().toISOString() } }
    } catch { /* keep configured/fallback value */ }

    const rows: any[] = []
    const errors: string[] = []
    for (const raw of tickers) {
      const t = String(raw)
      if (t.endsWith('-EUR')) {
        // Crypto (Bitvavo public ticker) — already in EUR.
        const c = await bitvavoQuote(t); await sleep(120)
        if (c) rows.push({ ticker: t, price: c.price, change_pct: c.changePct, prev_close: c.prevClose, updated_at: new Date().toISOString() })
        else errors.push(`${t}:bitvavo-fail`)
        continue
      }
      if (t.includes('.')) {
        // Non-US listing — prefer the native Yahoo quote (correct local currency, real local close).
        const y = await yahooQuote(t); await sleep(250)
        if (y) { rows.push({ ticker: t, price: y.price, change_pct: y.changePct, prev_close: y.prevClose, updated_at: new Date().toISOString() }); continue }
        // Fallback: a US-listed ADR converted USD→EUR (only currency-correct for EUR listings like ASML.AS).
        if (US_EQUIV[t]) {
          const q = await fquote(US_EQUIV[t]); await sleep(250)
          if (q && typeof q.c === 'number' && q.c !== 0) {
            rows.push({ ticker: t, price: q.c / eurUsd, change_pct: typeof q.dp === 'number' ? q.dp : null, prev_close: typeof q.pc === 'number' ? q.pc / eurUsd : null, updated_at: new Date().toISOString() })
          } else errors.push(`${t}:noprice`)
        } else errors.push(`${t}:yahoo-fail`)  // leave at cost basis
        continue
      }
      // US ticker via Finnhub
      const q = await fquote(t)
      await sleep(250)
      if (!q || typeof q.c !== 'number' || q.c === 0) { errors.push(`${t}:noprice`); continue }
      rows.push({
        ticker: t,
        price: q.c,
        change_pct: typeof q.dp === 'number' ? q.dp : null,
        prev_close: typeof q.pc === 'number' ? q.pc : null,
        updated_at: new Date().toISOString(),
      })
    }
    if (rows.length) { const { error } = await admin.from('prices').upsert(rows); if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors }) }
    // Persist the live FX rate + timestamp so cfg.eur_usd stays current everywhere it's read.
    if (fxAt && cfgRow?.user_id) {
      const merged = { ...(cfgRow.config ?? {}), eur_usd: eurUsd, eur_usd_at: fxAt }
      await admin.from('system_config').upsert({ user_id: cfgRow.user_id, config: merged })
    }
    return new Response(JSON.stringify({ ok: true, updated: rows.length, errors, eur_usd: eurUsd, eur_usd_at: fxAt }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors })
  }
})
