// Cache refresher: fundamentals from Finnhub (/stock/metric, free 60/min) + Massive price metrics.
// FMP's free tier plan-gates ratios-ttm/key-metrics/financial-growth, so fundamentals come from Finnhub.
// Modes: default = stalest `batch` tickers; body.all = every holding/watchlist ticker;
// body.tickers = forced list; body.skipMassive = fundamentals-only (preserves existing vol/mom/dd, fast backfill).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const FINN = 'https://finnhub.io/api/v1'
const FINN_KEY = Deno.env.get('FINNHUB_API_KEY') || ''
const MASSIVE_KEY = Deno.env.get('MASSIVE_API_KEY')
const MASSIVE_BASE = Deno.env.get('MASSIVE_BASE_URL') ?? 'https://api.massive.com'
const STALE_HOURS = 12
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const num = (x: any): number | null => (typeof x === 'number' && isFinite(x) ? x : null)

// Finnhub returns margins / ROI / growth as PERCENTAGES already (e.g. 25.3 = 25.3%) — no ×100, unlike FMP.
async function fj(path: string, tries = 3): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${FINN}${path}${path.includes('?') ? '&' : '?'}token=${FINN_KEY}`)
      if (r.status === 429) { console.log(`Finnhub 429 ${path.split('?')[0]} (try ${i + 1})`); await sleep(1300 * (i + 1)); continue }
      if (!r.ok) { console.log(`Finnhub ${r.status} ${path.split('?')[0]}`); return null }
      return await r.json()
    } catch (e) { console.log(`Finnhub error ${e}`); await sleep(600) }
  }
  return null
}

async function massiveMetrics(t: string): Promise<{ mom: number; vol: number; dd: number } | null> {
  if (!MASSIVE_KEY || t.includes('.')) return null
  try {
    const to = new Date(), from = new Date(); from.setDate(from.getDate() - 400)
    const url = `${MASSIVE_BASE}/v2/aggs/ticker/${t}/range/1/day/${from.toISOString().slice(0,10)}/${to.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=500&apiKey=${MASSIVE_KEY}`
    const r = await fetch(url); if (!r.ok) return null
    const j = await r.json(); const res = j?.results; if (!Array.isArray(res) || res.length < 60) return null
    const closes = res.map((b: any) => b.c).filter((x: any) => typeof x === 'number'); const n = closes.length
    const baseIdx = n >= 252 ? n - 252 : 0, recentIdx = n - 21 > baseIdx ? n - 21 : n - 1
    const mom = (closes[recentIdx] / closes[baseIdx] - 1) * 100
    const start = Math.max(1, n - 252); const rets: number[] = []
    for (let i = start; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1)
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100
    let peak = closes[start], dd = 0
    for (let i = start; i < n; i++) { peak = Math.max(peak, closes[i]); dd = Math.min(dd, closes[i] / peak - 1) }
    return { mom, vol, dd: dd * 100 }
  } catch { return null }
}

// Yahoo daily-bar risk metrics — same math as massiveMetrics, but keyless and covers non-US listings
// (.AS, .KS, .KQ) that Massive can't price. Uses adjusted close so momentum reflects total return.
async function yahooMetrics(t: string): Promise<{ mom: number; vol: number; dd: number } | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=2y`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const j = await r.json(); const res = j?.chart?.result?.[0]
    const raw = res?.indicators?.adjclose?.[0]?.adjclose ?? res?.indicators?.quote?.[0]?.close
    if (!Array.isArray(raw)) return null
    const closes = raw.filter((x: any) => typeof x === 'number' && isFinite(x)); const n = closes.length
    if (n < 60) return null
    const baseIdx = n >= 252 ? n - 252 : 0, recentIdx = n - 21 > baseIdx ? n - 21 : n - 1
    const mom = (closes[recentIdx] / closes[baseIdx] - 1) * 100
    const start = Math.max(1, n - 252); const rets: number[] = []
    for (let i = start; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1)
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100
    let peak = closes[start], dd = 0
    for (let i = start; i < n; i++) { peak = Math.max(peak, closes[i]); dd = Math.min(dd, closes[i] / peak - 1) }
    return { mom, vol, dd: dd * 100 }
  } catch { return null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (!FINN_KEY) return new Response(JSON.stringify({ ok: false, error: 'FINNHUB_API_KEY not set' }), { status: 500, headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const batch = Math.min(body.batch ?? 6, 30)
    const skipMassive = !!body.skipMassive
    const auth = req.headers.get('Authorization') ?? ''
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } })
    const { data: { user } } = await userClient.auth.getUser()
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const cronOk = !user && body.secret && body.secret === Deno.env.get('CRON_SECRET')
    if (!user && !cronOk) return new Response(JSON.stringify({ ok: false, error: 'not signed in' }), { status: 401, headers: cors })
    const src = user ? userClient : admin

    const [{ data: holdings }, { data: watch }, { data: fund }] = await Promise.all([
      src.from('holdings').select('ticker'),
      src.from('watchlist').select('ticker'),
      admin.from('fundamentals').select('ticker,updated_at,vol,mom,dd,price_src,market_cap,sector'),
    ])
    const want = Array.from(new Set([...(holdings ?? []), ...(watch ?? [])].map((x: any) => x.ticker)))
    const prev: Record<string, any> = {}
    ;(fund ?? []).forEach((f: any) => { prev[f.ticker] = f })
    const cutoff = Date.now() - STALE_HOURS * 3600 * 1000
    const stale = want.filter(t => { const u = prev[t]?.updated_at; return !u || new Date(u).getTime() < cutoff })
    const forced: string[] | null = Array.isArray(body.tickers) && body.tickers.length
      ? body.tickers.map((s: any) => String(s).toUpperCase()) : null
    const todo = body.all ? want : (forced ?? stale.slice(0, batch))

    const refreshed: string[] = []; const errors: string[] = []; const missingMassive: string[] = []
    for (const t of todo) {
      // Finnhub uses the base US symbol; strip exchange suffix (ASML.AS -> ASML). ETFs (VWRL) simply won't resolve.
      const fsym = t.includes('.') ? t.split('.')[0] : t
      const met = await fj(`/stock/metric?symbol=${fsym}&metric=all`)
      await sleep(300)
      const prof = await fj(`/stock/profile2?symbol=${fsym}`)
      await sleep(250)
      const m = (met?.metric ?? {}) as Record<string, any>
      const mcapM = num(prof?.marketCapitalization)   // Finnhub returns market cap in millions
      // Risk metrics: Massive (US) first, then Yahoo bars (covers non-US .AS/.KS/.KQ), else leave to Finnhub proxy.
      let mv = skipMassive ? null : await massiveMetrics(t); let mvSrc: string | null = mv ? 'Massive' : null
      if (!skipMassive && !mv) { mv = await yahooMetrics(t); if (mv) mvSrc = 'Yahoo' }

      const pe = num(m.peTTM) ?? num(m.peBasicExclExtraTTM) ?? num(m.peNormalizedAnnual)
      const ps = num(m.psTTM)
      const revg = num(m.revenueGrowthTTMYoy) ?? num(m.revenueGrowthQuarterlyYoy)
      let peg = num(m.pegRatioTTM)
      if (peg == null && pe != null && revg != null && revg > 0) peg = pe / revg
      const roic = num(m.roiTTM) ?? num(m.roaeTTM) ?? num(m.roeTTM)   // roiTTM = return on investment (ROIC proxy)
      const pfcf = num(m.pfcfShareTTM)
      const row: any = {
        ticker: t,
        beta: num(m.beta),
        roic,
        opm: num(m.operatingMarginTTM),
        gm: num(m.grossMarginTTM),
        netm: num(m.netProfitMarginTTM) ?? num(m.netMarginTTM),
        pe, ps, peg,
        de: num(m['totalDebt/totalEquityQuarterly']) ?? num(m['totalDebt/totalEquityAnnual']) ?? num(m['longTermDebt/equityQuarterly']),
        fcf_yield: pfcf && pfcf !== 0 ? 1 / pfcf : null,
        rev_growth: revg,
        ret1y: num(m['52WeekPriceReturnDaily']),
        market_cap: mcapM != null ? mcapM * 1e6 : (prev[t]?.market_cap ?? null),
        sector: prof?.finnhubIndustry ?? (prev[t]?.sector ?? null),
        // Preserve existing risk metrics when this run skips them.
        mom: mv ? mv.mom : (prev[t]?.mom ?? null),
        vol: mv ? mv.vol : (prev[t]?.vol ?? null),
        dd: mv ? mv.dd : (prev[t]?.dd ?? null),
        price_src: mv ? mvSrc : (prev[t]?.price_src ?? 'Finnhub'),
        updated_at: new Date().toISOString(),
      }
      const okFund = pe != null || ps != null || roic != null || row.opm != null
      if (!okFund) errors.push(t)
      if (row.vol == null || row.mom == null) missingMassive.push(t)  // still on Finnhub proxy for scoring
      console.log(`refresh ${t} (finnhub ${fsym}): pe=${pe} ps=${ps} roic=${roic} opm=${row.opm} revg=${revg} fund=${okFund} risk=${mvSrc ?? 'none'}`)
      await admin.from('fundamentals').upsert(row)
      refreshed.push(t)
      if (!skipMassive) await sleep(mvSrc === 'Massive' ? 13000 : 1000) // Massive ~5/min; Yahoo/none needs no long wait
    }
    return new Response(JSON.stringify({ ok: true, refreshed, errors, missingMassive, remaining: Math.max(0, stale.length - todo.length), total: want.length }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
