// Market feed. Modes:
//  earnings : next upcoming earnings per given ticker (within `days`, default 90). ONE FMP bulk
//             earnings-calendar call (not per-ticker — that burned the free quota), a Finnhub bulk
//             gap-fill, then a Finnhub per-symbol fallback for names still missing. Cached 6h in
//             feed_cache so the free daily quotas aren't burned by repeated loads (body.force bypasses).
//  ipo      : upcoming (pending) IPOs. Massive /vX/reference/ipos, FMP + Finnhub fallback. Cached 12h.
//  news     : company-news for the given tickers (last `days`, default 5) - Finnhub. Not cached.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const FINN = 'https://finnhub.io/api/v1'
const KEY = Deno.env.get('FINNHUB_API_KEY') || ''
const FMP = Deno.env.get('FMP_API_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || ''
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const base = (t: string) => (t.includes('.') ? t.split('.')[0] : t)
const jsonResp = (obj: any) => new Response(JSON.stringify(obj), { headers: { ...cors, 'Content-Type': 'application/json' } })

// Strip a trailing legal-entity suffix so an EDGAR phrase search matches ("Koei Group Co. Ltd." -> "Koei Group").
function coreName(name: string): string {
  const c = String(name || '').replace(/[\s,]+(co\.?|company|corp\.?|corporation|inc\.?|incorporated|ltd\.?|limited|llc|plc|l\.?p\.?|s\.?a\.?|n\.?v\.?|a\.?g\.?|a\.?b\.?)\b.*$/i, '').trim()
  return c.length >= 3 ? c : String(name || '').trim()
}
// Map an SEC SIC code to a short industry label. 4-digit specifics first, else 2-digit major group.
function sicIndustry(code: string): string | null {
  const c = String(code || '').padStart(4, '0')
  const four: Record<string, string> = { '6770': 'SPAC / blank check', '7372': 'Software', '7370': 'IT services', '7371': 'IT services', '7373': 'IT services', '7374': 'IT / data services', '7375': 'IT services', '3674': 'Semiconductors', '2834': 'Pharmaceuticals', '2836': 'Biotech', '8731': 'Biotech / R&D', '3841': 'Medical devices', '3845': 'Medical devices', '6199': 'Finance services', '6221': 'Commodity trading' }
  if (four[c]) return four[c]
  const two: Record<string, string> = { '01': 'Agriculture', '02': 'Agriculture', '07': 'Agriculture', '08': 'Forestry', '09': 'Fishing', '10': 'Metal mining', '12': 'Coal mining', '13': 'Oil & gas', '14': 'Mining', '15': 'Construction', '16': 'Construction', '17': 'Construction', '20': 'Food & beverage', '21': 'Tobacco', '22': 'Textiles', '23': 'Apparel', '24': 'Wood products', '25': 'Furniture', '26': 'Paper', '27': 'Publishing', '28': 'Chemicals', '29': 'Petroleum refining', '30': 'Plastics & rubber', '31': 'Leather', '32': 'Glass & concrete', '33': 'Metals', '34': 'Fabricated metals', '35': 'Machinery & computers', '36': 'Electronics', '37': 'Transportation equipment', '38': 'Instruments & medical', '39': 'Manufacturing', '40': 'Railroads', '41': 'Transit', '42': 'Trucking & logistics', '44': 'Shipping', '45': 'Airlines', '46': 'Pipelines', '47': 'Transport services', '48': 'Communications', '49': 'Utilities', '50': 'Wholesale', '51': 'Wholesale', '52': 'Retail', '53': 'Retail', '54': 'Retail (food)', '55': 'Auto & retail', '56': 'Apparel retail', '57': 'Home retail', '58': 'Restaurants', '59': 'Retail', '60': 'Banking', '61': 'Consumer finance', '62': 'Securities & investing', '63': 'Insurance', '64': 'Insurance', '65': 'Real estate', '67': 'Holding & investment', '70': 'Hotels & lodging', '72': 'Consumer services', '73': 'Business & IT services', '75': 'Auto services', '78': 'Media & film', '79': 'Leisure & recreation', '80': 'Healthcare', '81': 'Legal services', '82': 'Education', '83': 'Social services', '87': 'Engineering & research', '99': 'Diversified' }
  return two[c.slice(0, 2)] || null
}

async function fj(path: string, tries = 3): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${FINN}${path}${path.includes('?') ? '&' : '?'}token=${KEY}`)
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue }
      if (!r.ok) return null
      return await r.json()
    } catch { await sleep(400) }
  }
  return null
}

// Best-effort per-user cache in feed_cache (keyed by kind). Never throws — falls back to a live fetch.
function uclient(req: Request) {
  const auth = req.headers.get('Authorization') ?? ''
  return createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } } })
}
async function readCache(uc: any, kind: string, ttlMs: number): Promise<any[] | null> {
  try {
    const { data } = await uc.from('feed_cache').select('payload,updated_at').eq('kind', kind).maybeSingle()
    if (data?.updated_at && (Date.now() - new Date(data.updated_at).getTime()) < ttlMs) return data.payload as any[]
  } catch (_) { /* ignore */ }
  return null
}
async function writeCache(uc: any, kind: string, payload: any[]): Promise<void> {
  try {
    const { data: { user } } = await uc.auth.getUser()
    if (user) await uc.from('feed_cache').upsert({ user_id: user.id, kind, payload, updated_at: new Date().toISOString() })
  } catch (_) { /* ignore */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const mode = body.mode ?? 'earnings'
    const now = new Date()
    const force = !!body.force

    if (mode === 'earnings') {
      const uc = uclient(req)
      if (!force) { const c = await readCache(uc, 'earnings', 6 * 3600 * 1000); if (c) { const w = new Set((Array.isArray(body.tickers) ? body.tickers : []).map((t: any) => base(String(t))).filter(Boolean)).size; return jsonResp({ ok: true, mode, source: 'cache', results: c, coverage: `${c.length}/${w}` }) } }
      const days = Math.min(body.days ?? 90, 180)
      const to = new Date(now); to.setDate(to.getDate() + days)
      const fromYmd = ymd(now), toYmd = ymd(to)
      const orig: string[] = Array.isArray(body.tickers) ? body.tickers : []
      const baseToOrig: Record<string, string> = {}
      orig.forEach(t => { baseToOrig[base(String(t))] = String(t) })
      const wanted = Object.keys(baseToOrig).filter(Boolean)
      const results: any[] = []
      const covered = new Set<string>()
      const srcs: string[] = []
      const take = (sym: string, rec: any) => { if (baseToOrig[sym] && !covered.has(sym)) { results.push(rec); covered.add(sym) } }

      // 1. FMP: ONE bulk earnings-calendar call for the whole window, filtered to holdings, earliest per
      //    ticker. (Was 23 per-ticker calls — that alone could exhaust the ~250/day free quota in a few loads.)
      if (FMP) {
        try {
          const r = await fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${fromYmd}&to=${toYmd}&apikey=${FMP}`)
          if (r.ok) {
            const arr = await r.json()
            const earliest: Record<string, any> = {}
            for (const e of (Array.isArray(arr) ? arr : [])) {
              const sym = base(String(e?.symbol || ''))
              if (!baseToOrig[sym] || !e?.date || e.date < fromYmd || e.date > toYmd) continue
              if (!earliest[sym] || String(e.date).localeCompare(earliest[sym].date) < 0) earliest[sym] = e
            }
            for (const [sym, e] of Object.entries(earliest)) take(sym, { ticker: baseToOrig[sym], date: e.date, hour: null, epsEstimate: e.epsEstimated ?? null, revenueEstimate: e.revenueEstimated ?? null, quarter: null, year: null })
            if (covered.size) srcs.push('fmp')
          }
        } catch (_) { /* fall through to Finnhub */ }
      }
      // 2. Finnhub bulk window gap-fill for tickers FMP didn't cover (FMP throttled/gated).
      if (KEY && covered.size < wanted.length) {
        const cal = await fj(`/calendar/earnings?from=${fromYmd}&to=${toYmd}`)
        let hit = false
        for (const e of (cal?.earningsCalendar ?? []).sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))) {
          const sym = base(String(e.symbol || ''))
          if (baseToOrig[sym] && !covered.has(sym)) { take(sym, { ticker: baseToOrig[sym], date: e.date, hour: e.hour || null, epsEstimate: e.epsEstimate ?? null, revenueEstimate: e.revenueEstimate ?? null, quarter: e.quarter ?? null, year: e.year ?? null }); hit = true }
        }
        if (hit) srcs.push('finnhub')
      }
      // 3. Finnhub per-symbol fallback: the free bulk calendar can be capped/incomplete (it missed TSLA),
      //    so query each still-missing name directly. Only runs for the gaps, so it's cheap.
      if (KEY && covered.size < wanted.length) {
        let hit = false
        for (const sym of wanted) {
          if (covered.has(sym)) continue
          const cal = await fj(`/calendar/earnings?from=${fromYmd}&to=${toYmd}&symbol=${encodeURIComponent(sym)}`)
          await sleep(110)
          const up = (cal?.earningsCalendar ?? [])
            .filter((e: any) => e?.date && e.date >= fromYmd && e.date <= toYmd)
            .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))[0]
          if (up) { take(sym, { ticker: baseToOrig[sym], date: up.date, hour: up.hour || null, epsEstimate: up.epsEstimate ?? null, revenueEstimate: up.revenueEstimate ?? null, quarter: up.quarter ?? null, year: up.year ?? null }); hit = true }
        }
        if (hit) srcs.push('finnhub-sym')
      }
      results.sort((a, b) => String(a.date).localeCompare(String(b.date)))
      if (results.length) await writeCache(uc, 'earnings', results)
      return jsonResp({ ok: true, mode, source: srcs.join('+') || 'none', results, coverage: `${covered.size}/${wanted.length}` })
    }

    if (mode === 'ipo') {
      const uc = uclient(req)
      if (!force) { const c = await readCache(uc, 'ipo', 12 * 3600 * 1000); if (c) return jsonResp({ ok: true, mode, source: 'cache', results: c }) }
      const days = Math.min(body.days ?? 90, 180)
      const to = new Date(now); to.setDate(to.getDate() + days)
      const MASSIVE_KEY = Deno.env.get('MASSIVE_API_KEY')
      const MASSIVE_BASE = Deno.env.get('MASSIVE_BASE_URL') ?? 'https://api.massive.com'
      const EX: Record<string, string> = { XNAS: 'NASDAQ', XNYS: 'NYSE', ARCX: 'NYSE Arca', BATS: 'Cboe', XASE: 'NYSE American' }
      const NOISE = /\b(units?|warrants?|rights?|rts)\b/i
      let list: any[] = []
      let src = 'none'
      if (MASSIVE_KEY) {
        try {
          const r = await fetch(`${MASSIVE_BASE}/vX/reference/ipos?ipo_status=pending&limit=100&apiKey=${MASSIVE_KEY}`)
          if (r.ok) {
            const j = await r.json()
            const res = Array.isArray(j?.results) ? j.results : []
            list = res
              .filter((x: any) => x && x.ticker)
              .filter((x: any) => x.security_type !== 'SP' && !NOISE.test(String(x.security_description || '')))
              .map((x: any) => {
                const lo = x.lowest_offer_price, hi = x.highest_offer_price
                const price = (typeof lo === 'number' && typeof hi === 'number') ? (lo === hi ? String(lo) : `${lo}–${hi}`) : (typeof x.final_issue_price === 'number' ? String(x.final_issue_price) : null)
                const mid = (typeof lo === 'number' && typeof hi === 'number') ? (lo + hi) / 2 : (typeof x.final_issue_price === 'number' ? x.final_issue_price : null)
                const sharesOut = typeof x.shares_outstanding === 'number' ? x.shares_outstanding : null
                const impliedCap = (sharesOut != null && mid != null) ? Math.round(sharesOut * mid) : null
                return { symbol: x.ticker, name: x.issuer_name ?? x.ticker, date: x.announced_date ?? null, exchange: EX[x.primary_exchange] ?? x.primary_exchange ?? null, price, shares: typeof x.max_shares_offered === 'number' ? x.max_shares_offered : null, value: typeof x.total_offer_size === 'number' ? x.total_offer_size : null, status: x.ipo_status ?? 'pending', sharesOut, impliedCap, ipoDate: null, industry: null }
              })
              .sort((a: any, b: any) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
              .slice(0, 25)
            if (list.length) src = 'massive'
          }
        } catch (_) { /* fall through */ }
      }
      if (!list.length && FMP) {
        try {
          const r = await fetch(`https://financialmodelingprep.com/stable/ipos-calendar?from=${ymd(now)}&to=${ymd(to)}&apikey=${FMP}`)
          if (r.ok) {
            const arr = await r.json()
            list = (Array.isArray(arr) ? arr : [])
              .filter((x: any) => x && x.symbol && x.date)
              .filter((x: any) => String(x.actions || '').toLowerCase() !== 'withdrawn')
              .filter((x: any) => !NOISE.test(String(x.company || '')))
              .map((x: any) => ({ symbol: x.symbol, name: x.company ?? x.symbol, date: x.date, exchange: x.exchange ?? null, price: x.priceRange ?? null, shares: typeof x.shares === 'number' ? x.shares : null, value: typeof x.marketCap === 'number' ? x.marketCap : null, status: x.actions ?? null, ipoDate: x.date ?? null, industry: null }))
              .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))
            if (list.length) src = 'fmp'
          }
        } catch (_) {}
      }
      if (!list.length && KEY) {
        const cal = await fj(`/calendar/ipo?from=${ymd(now)}&to=${ymd(to)}`)
        list = (cal?.ipoCalendar ?? [])
          .filter((x: any) => x.status !== 'withdrawn')
          .map((x: any) => ({ symbol: x.symbol || null, name: x.name, date: x.date, exchange: x.exchange || null, price: x.price || null, shares: x.numberOfShares || null, value: x.totalSharesValue || null, status: x.status || null, ipoDate: x.date || null, industry: null }))
          .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))
        if (list.length) src = 'finnhub'
      }
      // Massive only carries announced_date; enrich with an expected IPO/listing date from Finnhub's IPO
      // calendar (its `date` = expected offering date), matched by ticker. Partial coverage; null when unknown.
      if (src === 'massive' && KEY && list.length) {
        const cal = await fj(`/calendar/ipo?from=${ymd(now)}&to=${ymd(to)}`)
        const m: Record<string, string> = {}
        for (const x of (cal?.ipoCalendar ?? [])) { const s = base(String(x.symbol || '')); if (s && x.date) m[s] = x.date }
        list = list.map((it: any) => ({ ...it, ipoDate: (it.symbol && m[base(String(it.symbol))]) ? m[base(String(it.symbol))] : null }))
      }
      // Industry via SEC EDGAR: full-text search each IPO's S-1/F-1, read its SIC code, map to a label.
      // Free and fairly reliable; partial coverage (the name must match a filing). Cached 12h with the feed.
      if (src === 'massive' && list.length) {
        const UA = 'investment-system research tool (contact: leon@vermaas.net)'
        for (const it of list) {
          try {
            const nm = coreName(String(it.name || it.symbol || ''))
            if (!nm) continue
            const r = await fetch(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${nm}"`)}&forms=S-1,F-1`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
            if (r.ok) {
              const j = await r.json()
              const sic = String((((j?.hits?.hits ?? [])[0]?._source?.sics) ?? [])[0] || '')
              if (sic) it.industry = sicIndustry(sic)
            }
          } catch (_) { /* skip */ }
          await sleep(120)
        }
      }
      if (list.length) await writeCache(uc, 'ipo', list)
      return jsonResp({ ok: true, mode, source: src, results: list })
    }

    if (mode === 'news') {
      if (!KEY) return new Response(JSON.stringify({ ok: false, error: 'FINNHUB_API_KEY not set' }), { status: 500, headers: cors })
      const days = Math.min(body.days ?? 5, 30)
      const perTicker = Math.min(body.perTicker ?? 6, 15)
      const from = new Date(now); from.setDate(from.getDate() - days)
      const orig: string[] = body.tickers ?? []
      const out: any[] = []
      const seen = new Set<string>()
      for (const t of orig) {
        const sym = base(String(t))
        if (seen.has(sym)) continue; seen.add(sym)
        const arr = await fj(`/company-news?symbol=${encodeURIComponent(sym)}&from=${ymd(from)}&to=${ymd(now)}`)
        await sleep(220)
        if (!Array.isArray(arr)) continue
        arr.slice(0, perTicker).forEach((n: any) => out.push({ ticker: String(t), headline: n.headline, summary: n.summary || '', url: n.url, source: n.source, datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : null, category: n.category || null }))
      }
      return jsonResp({ ok: true, mode, results: out })
    }

    return new Response(JSON.stringify({ ok: false, error: 'unknown mode' }), { status: 400, headers: cors })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
