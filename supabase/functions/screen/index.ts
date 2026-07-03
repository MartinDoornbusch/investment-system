// On-demand screener (does NOT persist).
//  'tickers'  : scores arbitrary tickers from Finnhub (fundamentals) + Massive (risk/momentum), per-bucket profiles + config weights.
//  'universe' : filters the Finnhub-backed universe_cache and auto-classifies buckets (KB rules).
// Secrets: FINNHUB_API_KEY, MASSIVE_API_KEY, SUPABASE_URL/SERVICE_ROLE_KEY/ANON_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const FINN = 'https://finnhub.io/api/v1'
const FINN_KEY = Deno.env.get('FINNHUB_API_KEY') || ''
const MASSIVE_KEY = Deno.env.get('MASSIVE_API_KEY')
const MASSIVE_BASE = Deno.env.get('MASSIVE_BASE_URL') ?? 'https://api.massive.com'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const num = (x: any): number | null => (typeof x === 'number' && isFinite(x) ? x : null)

// Finnhub returns margins / ROI / growth as PERCENTAGES already (no ×100). Retry on 429.
async function fj(path: string, tries = 3): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${FINN}${path}${path.includes('?') ? '&' : '?'}token=${FINN_KEY}`)
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue }
      if (!r.ok) return null
      return await r.json()
    } catch { await sleep(500) }
  }
  return null
}
// When Massive rate-limits (429), back off for a short window instead of disabling permanently.
// This flag lives at module scope and Supabase reuses warm instances across invocations, so a
// permanent disable used to "stick" — poisoning every later score until a cold start and making the
// same ticker flip between the Massive path and the Finnhub fallback run-to-run. A time-boxed
// cooldown avoids hammering the rate limit yet auto-recovers, so scores become reproducible again.
const MASSIVE_COOLDOWN_MS = 60_000
let massiveCooldownUntil = 0
async function massiveMetrics(t: string): Promise<{ mom: number; vol: number; dd: number } | null> {
  if (!MASSIVE_KEY || Date.now() < massiveCooldownUntil || t.includes('.')) return null
  try {
    const to = new Date(), from = new Date(); from.setDate(from.getDate() - 400)
    const url = `${MASSIVE_BASE}/v2/aggs/ticker/${t}/range/1/day/${from.toISOString().slice(0,10)}/${to.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=500&apiKey=${MASSIVE_KEY}`
    const r = await fetch(url); if (r.status === 429) { massiveCooldownUntil = Date.now() + MASSIVE_COOLDOWN_MS; return null }; if (!r.ok) return null
    const j = await r.json(); const res = j?.results; if (!Array.isArray(res) || res.length < 60) return null
    const closes = res.map((b: any) => b.c).filter((x: any) => typeof x === 'number'); const n = closes.length
    const baseIdx = n >= 252 ? n - 252 : 0; const recentIdx = n - 21 > baseIdx ? n - 21 : n - 1
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
// Yahoo daily-bar risk metrics — same math as massiveMetrics, keyless, covers non-US listings (.AS/.KS/.KQ)
// that Massive can't price. Also serves as a fallback for US names when Massive rate-limits.
async function yahooMetrics(t: string): Promise<{ mom: number; vol: number; dd: number } | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=2y`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const j = await r.json(); const res = j?.chart?.result?.[0]
    const raw = res?.indicators?.adjclose?.[0]?.adjclose ?? res?.indicators?.quote?.[0]?.close
    if (!Array.isArray(raw)) return null
    const closes = raw.filter((x: any) => typeof x === 'number' && isFinite(x)); const n = closes.length
    if (n < 60) return null
    const baseIdx = n >= 252 ? n - 252 : 0; const recentIdx = n - 21 > baseIdx ? n - 21 : n - 1
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
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)))
function momentum(r: number | null) { if (r == null) return 50; if (r>=50)return 92; if(r>=25)return 78; if(r>=10)return 66; if(r>=0)return 58; if(r>=-10)return 48; if(r>=-25)return 38; return 28 }
function safetyBeta(b: number | null, nc: boolean) { let s=60; if(b==null)s=55; else if(b<=0.5)s=92; else if(b<=0.7)s=84; else if(b<=0.9)s=74; else if(b<=1.2)s=62; else if(b<=1.5)s=50; else if(b<=1.8)s=42; else if(b<=2.2)s=34; else s=28; if(nc)s+=5; return clamp(s) }
function safetyRisk(vol: number, dd: number) { let s; if(vol<=15)s=85; else if(vol<=20)s=75; else if(vol<=25)s=67; else if(vol<=35)s=55; else if(vol<=50)s=45; else if(vol<=70)s=35; else s=28; s+= dd>=-15?6:dd>=-30?0:dd>=-45?-4:-10; return clamp(s) }
function qualityCQ(roic: number|null, opm: number|null, moat: number){ let s; const r=roic??15; if(r>=80)s=96;else if(r>=50)s=90;else if(r>=35)s=82;else if(r>=25)s=74;else if(r>=18)s=66;else if(r>=12)s=56;else s=46; const o=opm??15; s+= o>=40?6:o>=25?3:o>=15?0:-4; s+=moat*4; return clamp(s) }
function valueCQ(peg: number|null, pe: number|null){ if(peg==null)return 50; let s; if(peg<=0.3)s=96;else if(peg<=0.6)s=88;else if(peg<=1.0)s=76;else if(peg<=1.5)s=64;else if(peg<=2.0)s=52;else if(peg<=2.5)s=44;else s=34; if(pe&&pe>40)s-=6; return clamp(s) }
function growthMom(rev: number|null, m: number){ const r=rev??10; const g=r>=40?92:r>=25?80:r>=15?66:r>=8?54:40; return Math.round(0.6*g+0.4*m) }
function qualityG(opm:number|null,fcf:boolean,prof:boolean,gm:number|null){ let s=50; s+=prof?12:-10; s+=fcf?10:-8; const o=opm??0; s+=o>=20?12:o>=10?6:o>=0?0:-8; const g=gm??0; s+=g>=60?8:g>=40?4:0; return clamp(s) }
// No 1% growth floor: a shrinking company must not score like a 1% grower. Negative/zero revenue growth
// = failed growth premise -> low score (margin-of-safety: a cheap price can be a falling knife).
function valueG(ps:number|null,rev:number|null){ if(ps==null)return 50; if(rev==null)return 50; if(rev<=0)return 30; const psg=ps/rev; if(psg<=0.15)return 88; if(psg<=0.3)return 76; if(psg<=0.5)return 64; if(psg<=0.8)return 50; return 36 }

// --- International (Europe v1) scoring adjustments, per International-Screener-Metric-Proposal.md ---
// Value pillar for Europe = 60% PEG banding + 40% EV/EBITDA banding (EV/EBITDA is capital-structure- and
// tax-neutral across countries; Damodaran via KB valuation-multiples). Financials: EV/EBITDA is undefined
// and D/E meaningless -> Value scored on P/B contextualized by ROE (KB: P/B for banks/insurers).
const isFin = (sector: string | null) => !!sector && /financ|bank|insur/i.test(sector)
function evBand(ev: number | null): number | null { if (ev == null || ev <= 0) return null; if (ev<=6) return 90; if (ev<=8) return 78; if (ev<=10) return 66; if (ev<=12) return 56; if (ev<=15) return 46; return 36 }
function valueFin(pb: number | null, roe: number | null): number { if (pb == null) return 50; let s; if(pb<=0.5)s=88; else if(pb<=0.8)s=78; else if(pb<=1.0)s=68; else if(pb<=1.5)s=56; else if(pb<=2.5)s=44; else s=34; if(roe!=null){ if(roe>=12)s+=6; else if(roe<6)s-=6 } return clamp(s) }

const DEFAULT_WEIGHTS: Record<string, {v:number;q:number;m:number;s:number}> = { 'Core-Index': { v:25,q:25,m:25,s:25 }, 'Core-Quality': { v:25,q:40,m:15,s:20 }, 'Growth': { v:20,q:25,m:40,s:15 }, 'Speculative': { v:15,q:20,m:50,s:15 }, 'Concentrated': { v:30,q:40,m:15,s:15 }, 'Bonds': { v:25,q:25,m:25,s:25 }, 'Real-Assets': { v:25,q:25,m:25,s:25 }, 'Cash': { v:25,q:25,m:25,s:25 } }
function weightsFor(bucket: string, cw: any) { const c = cw?.[bucket]; if (c && c.value != null) return { v:c.value, q:c.quality, m:c.momentum, s:c.safety }; return DEFAULT_WEIGHTS[bucket] ?? { v:25,q:25,m:25,s:25 } }
function scoreProfile(bucket: string, x: any) {
  const prof = (x.netm ?? -1) > 0, fcfPos = (x.fcf ?? 0) > 0
  if (bucket === 'Growth') return { value: valueG(x.ps, x.revg), quality: qualityG(x.opm, fcfPos, prof, x.gm), mom: growthMom(x.revg, x.momScore), method: 'GARP / CANSLIM' }
  if (bucket === 'Speculative') return { value: valueG(x.ps, x.revg), quality: qualityG(x.opm, fcfPos, prof, x.gm), mom: x.momScore, method: 'Momentum / trend' }
  if (bucket === 'Concentrated') return { value: valueCQ(x.peg, x.pe), quality: qualityCQ(x.roic, x.opm, x.moat), mom: x.momScore, method: 'Thesis-driven (quality + value)' }
  return { value: valueCQ(x.peg, x.pe), quality: qualityCQ(x.roic, x.opm, x.moat), mom: x.momScore, method: 'Quality-Value compounder' }
}
const INDEX_RE = /^(VWRL|IWDA|CSPX|SPY|QQQ|IVV|VTI|XDWD|ACWI|VUSA|ISF|SWRD|EUNL|VEUR|IUSA|VWCE|SSAC|AGGH|EMB)/i
// Cap-agnostic style classifier (reworked 2026-06 to support mid/small caps). Size NO LONGER forces a bucket:
// a profitable, stable, high-return small-cap is a quality compounder, not "Speculative". Buckets here are a
// SCORING STYLE (which profile/weights to apply), not a portfolio role — a quality small-cap is still a satellite.
// Speculative is reserved for genuinely low-quality names: unprofitable AND not clearly growing, or no fundamentals.
// Quality signal = ROE (universe_cache has no ROIC); stability = beta; profitability prefers net margin, falls back to P/E.
function classifyBucket(x: any) {
  if (INDEX_RE.test(x.ticker || '')) return 'Core-Index'
  const beta = x.beta != null ? Number(x.beta) : null
  const pe = x.pe != null ? Number(x.pe) : null
  const roe = x.roe != null ? Number(x.roe) : null
  const revg = x.rev_growth != null ? Number(x.rev_growth) : null
  const netm = x.netm != null ? Number(x.netm) : null
  if (pe == null && roe == null && revg == null && netm == null) return 'Speculative' // no fundamentals
  const profitable = netm != null ? netm > 0 : (pe != null && pe > 0)
  if (!profitable) return (revg != null && revg >= 15) ? 'Growth' : 'Speculative'
  const stable = beta == null || beta <= 1.4
  const defensive = beta != null && beta <= 0.9
  const fastGrowth = revg != null && revg >= 20
  const qualityReturns = roe != null && ((roe >= 15 && stable) || (roe >= 10 && defensive))
  if (qualityReturns && !fastGrowth) return 'Core-Quality' // cap-agnostic: mid/small quality allowed
  return 'Growth'
}

// Quick triage score from cached universe metrics only (no live calls). Same per-bucket pillar logic as the
// full scorer, but Momentum uses the 52-week return and Safety uses beta (no Massive vol/drawdown).
function quickScore(x: any, bucket: string, cw: any): { score: number | null; verdict: string | null; method: string | null; weights: string | null } {
  const pe = num(x.pe), ps = num(x.ps), roic = num(x.roic), opm = num(x.opm), gm = num(x.gm)
  const netm = num(x.netm), revg = num(x.rev_growth), beta = num(x.beta), fcf = num(x.fcf_yield), ret1y = num(x.ret1y)
  if (roic == null && pe == null && ps == null) return { score: null, verdict: null, method: null, weights: null }
  const peg = (pe != null && revg != null && revg > 0) ? pe / revg : null
  const moat = roic != null ? (roic >= 25 ? 2 : roic >= 15 ? 1 : 0) : 0  // no ROIC -> no moat credit
  const momScore = momentum(ret1y) // intl rows store 12-1 momentum in ret1y; US rows plain 52w — same bands
  // Europe Safety: beta bands + D/E cushion/penalty (ex-financials, where D/E is structural not distress).
  const de = num(x.de), fin = isFin(x.sector ?? null)
  const safety = x.region === 'europe'
    ? clamp(safetyBeta(beta, !fin && de != null && de < 0.3) - (!fin && de != null && de > 2 ? 6 : 0))
    : safetyBeta(beta, false)
  const pr = scoreProfile(bucket, { peg, pe, ps, revg, roic, opm, gm, netm, fcf, moat, momScore })
  // Europe Value override for quality-value buckets: financials -> P/B+ROE; else blend in EV/EBITDA (60/40).
  if (x.region === 'europe' && bucket !== 'Growth' && bucket !== 'Speculative') {
    if (fin) pr.value = valueFin(num(x.pb), num(x.roe))
    else { const ev = evBand(num(x.ev_ebitda)); if (ev != null) pr.value = Math.round(0.6 * pr.value + 0.4 * ev) }
  }
  const w = weightsFor(bucket, cw)
  const raw = Math.round((pr.value * w.v + pr.quality * w.q + pr.mom * w.m + safety * w.s) / 100)
  // Penalize low-confidence quick scores in proportion to missing critical inputs (mirrors the full scorer).
  const growthLike = bucket === 'Growth' || bucket === 'Speculative'
  const miss = (growthLike ? [ps == null, revg == null, opm == null] : [roic == null, peg == null]).filter(Boolean).length
  const critN = growthLike ? 3 : 2
  const score = clamp(raw - Math.round((miss / critN) * 18))
  return { score, verdict: score >= 75 ? 'Strong' : score >= 60 ? 'Watch' : 'Pass/Review', method: pr.method, weights: `V${w.v}/Q${w.q}/M${w.m}/Saf${w.s}` }
}

async function scoreTicker(t: string, bucket: string, configWeights: any) {
  const fsym = t.includes('.') ? t.split('.')[0] : t
  const [met, prof, massiveMv] = await Promise.all([
    fj(`/stock/metric?symbol=${fsym}&metric=all`),
    fj(`/stock/profile2?symbol=${fsym}`),
    massiveMetrics(t),
  ])
  const m = (met?.metric ?? {}) as Record<string, any>
  const name = prof?.name ?? null
  const beta = num(m.beta)
  const pe = num(m.peTTM) ?? num(m.peBasicExclExtraTTM) ?? num(m.peNormalizedAnnual)
  const ps = num(m.psTTM)
  const revg = num(m.revenueGrowthTTMYoy) ?? num(m.revenueGrowthQuarterlyYoy)
  let peg = num(m.pegRatioTTM); if (peg == null && pe != null && revg != null && revg > 0) peg = pe / revg
  const roic = num(m.roiTTM) ?? num(m.roaeTTM) ?? num(m.roeTTM)
  const opm = num(m.operatingMarginTTM)
  const gm = num(m.grossMarginTTM)
  const netm = num(m.netProfitMarginTTM) ?? num(m.netMarginTTM)
  const de = num(m['totalDebt/totalEquityQuarterly']) ?? num(m['totalDebt/totalEquityAnnual']) ?? num(m['longTermDebt/equityQuarterly'])
  const pfcf = num(m.pfcfShareTTM); const fcfps = pfcf && pfcf !== 0 ? 1 / pfcf : null
  const ret1y = num(m['52WeekPriceReturnDaily'])
  // Risk metrics: Massive (US) first, then Yahoo bars (covers non-US .AS/.KS/.KQ, and US when Massive is rate-limited).
  let mv = massiveMv; let mvSrc: string | null = massiveMv ? 'Massive' : null
  if (!mv) { mv = await yahooMetrics(t); if (mv) mvSrc = 'Yahoo' }
  if (beta == null && roic == null && pe == null && ps == null && !mv) return { ticker: t, bucket, error: 'no data' }
  const nc = de != null && de < 0.3
  // no ROIC -> no moat credit; and cap a high "roic" (really Finnhub ROI/ROE) to narrow-moat when debt is
  // high, since ROE flatters on leverage while the KB moat test is ROIC durably above cost of capital.
  const levered = de != null && de > 2
  let moat = roic != null ? (roic >= 25 ? 2 : roic >= 15 ? 1 : 0) : 0; if (levered) moat = Math.min(moat, 1)
  const momScore = mv ? momentum(mv.mom) : momentum(ret1y); const safety = mv ? safetyRisk(mv.vol, mv.dd) : safetyBeta(beta, nc)
  const src = mv ? mvSrc : 'Finnhub'
  const pr = scoreProfile(bucket, { peg, pe, ps, revg, roic, opm, gm, netm, fcf: fcfps, moat, momScore })
  const w = weightsFor(bucket, configWeights)
  const rawComposite = Math.round((pr.value * w.v + pr.quality * w.q + pr.mom * w.m + safety * w.s) / 100)
  // Flag when the bucket's key Value/Quality inputs came back null — Finnhub /stock/metric intermittently
  // returns empty on the free tier, which silently defaults Value→50 / Quality→60. Surfacing this stops a
  // fundamentals-degraded score from masquerading as a clean one, and penalizes the composite in proportion
  // to missing critical data so a data-starved name can't outrank a fully-analyzed one (mirrors auto-score).
  const growthLike = bucket === 'Growth' || bucket === 'Speculative'
  const lowConf = (growthLike
    ? [ps == null && 'P/S', revg == null && 'revGrowth', opm == null && 'margins']
    : [roic == null && 'ROIC', peg == null && 'PEG']).filter(Boolean)
  const critN = growthLike ? 3 : 2
  const composite = clamp(rawComposite - Math.round((lowConf.length / critN) * 18))
  const verdict = composite >= 75 ? 'Strong' : composite >= 60 ? 'Watch' : 'Pass/Review'
  return { ticker: t, name, bucket, value: pr.value, quality: pr.quality, momentum: pr.mom, safety, composite, verdict, src, lowConf, method: pr.method, weights: `V${w.v}/Q${w.q}/M${w.m}/Saf${w.s}` }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const mode = body.mode ?? 'tickers'
    if (mode === 'universe') {
      const f = body.filters ?? {}
      const perBucket = Math.min(body.perBucket ?? 10, 50)
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      // Pull all ENRICHED rows (roic not null) in pages of 1000 — PostgREST caps a single response at 1000.
      const region = f.region && f.region !== 'Any' ? f.region : 'us' // default 'us': existing frontend unchanged
      const base = () => {
        let q = admin.from('universe_cache').select('*').not('roic', 'is', null).eq('region', region)
        if (f.capBand && f.capBand !== 'Any') q = q.eq('cap_band', f.capBand)
        if (f.source && f.source !== 'Any') q = q.eq('source', f.source)
        if (f.marketCapMoreThan) q = q.gte('market_cap', f.marketCapMoreThan)
        if (f.minDollarVol) q = q.gte('avg_dollar_vol', f.minDollarVol)
        if (f.betaLowerThan) q = q.lte('beta', f.betaLowerThan)
        if (f.betaMoreThan) q = q.gte('beta', f.betaMoreThan)
        if (f.sector && f.sector !== 'Any') q = q.ilike('sector', `%${f.sector}%`)
        return q
      }
      const rows: any[] = []
      for (let off = 0; ; off += 1000) {
        const { data, error } = await base().order('ticker').range(off, off + 999)
        if (error) return new Response(JSON.stringify({ ok: false, mode, error: error.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
        if (!data || !data.length) break
        rows.push(...data)
        if (data.length < 1000) break
      }
      const { count: universeSize } = await admin.from('universe_cache').select('*', { count: 'exact', head: true }).eq('region', region)
      let uniWeights: any = null
      try { const { data: cfgRow } = await admin.from('system_config').select('config').maybeSingle(); uniWeights = cfgRow?.config?.weights ?? null } catch (_) {}
      const scored = rows.map((x: any) => {
        const bucket = classifyBucket(x)
        const qs = quickScore(x, bucket, uniWeights)
        return { ticker: x.ticker, name: x.name, marketCap: x.market_cap, capBand: x.cap_band, exchange: x.exchange, source: x.source, region: x.region, country: x.country, beta: x.beta, sector: x.sector, pe: x.pe, ps: x.ps, pb: x.pb, evEbitda: x.ev_ebitda, de: x.de, roe: x.roe, divYield: x.div_yield, revGrowth: x.rev_growth, advUsd: x.avg_dollar_vol, bucket, method: qs.method, weights: qs.weights, quickScore: qs.score, quickVerdict: qs.verdict }
      }).filter((r: any) => r.quickScore != null)
      const bands = ['large', 'mid', 'small']
      const groups: Record<string, any[]> = {}
      for (const b of bands) groups[b] = scored.filter((r: any) => r.capBand === b).sort((a: any, c: any) => c.quickScore - a.quickScore).slice(0, perBucket)
      const results = bands.flatMap(b => groups[b])
      const note = scored.length === 0 ? 'No enriched rows yet — run refresh-universe (enrich).' : undefined
      return new Response(JSON.stringify({ ok: true, mode, groups, results, perBucket, enrichedSize: scored.length, universeSize: universeSize ?? 0, note }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (!FINN_KEY) return new Response(JSON.stringify({ ok: false, error: 'FINNHUB_API_KEY not set' }), { status: 500, headers: cors })
    let configWeights: any = null
    try { const uc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }); const { data: cfgRow } = await uc.from('system_config').select('config').maybeSingle(); configWeights = cfgRow?.config?.weights ?? null } catch (_) {}
    const items = (body.tickers ?? []).slice(0, 15)
    const results = []
    for (const it of items) results.push(await scoreTicker(it.ticker.toUpperCase(), it.bucket || 'Core-Quality', configWeights))
    return new Response(JSON.stringify({ ok: true, mode: 'tickers', results, massiveActive: !!MASSIVE_KEY && Date.now() >= massiveCooldownUntil }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
