// Dynamic candidate universe = S&P 1500 family (S&P 500 large + S&P 400 mid + S&P 600 small).
// Two steps, both free + server-side fetchable:
//   step:'membership' -> fetch the 3 constituent lists, upsert identity rows (ticker/source/cap_band/exchange).
//                        Only touches identity columns, so it never clobbers existing fundamentals. Run monthly.
//   step:'enrich'     -> paced Finnhub refresh of rows missing/stale fundamentals (2 calls each). Run nightly in batches.
// Sources: S&P500 via datasets GitHub CSV; S&P400/600 via Wikipedia constituents tables (iShares/Russell are
// consent-gated and NOT server-side fetchable; FMP has no free Russell + unreliable bulk cap).
// Secrets: FINNHUB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const FINN = 'https://finnhub.io/api/v1'
const KEY = Deno.env.get('FINNHUB_API_KEY') || ''
const UA = 'Mozilla/5.0 (compatible; investment-system/1.0; +https://github.com)'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const num = (x: any) => (typeof x === 'number' && isFinite(x) ? x : null)

const SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'
const SP400_WIKI = 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies'
const SP600_WIKI = 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies'

const STALE_DAYS = 30
const bandOf = (mc: number | null) => (mc == null ? null : mc >= 1e10 ? 'large' : mc >= 2e9 ? 'mid' : 'small')
const sourceBand = (s: string | null) => (s === 'sp400' ? 'mid' : s === 'sp600' ? 'small' : 'large')

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,text/html,*/*' } })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return await r.text()
}

// Minimal CSV: split lines, parse first column (Symbol). Quotes handled only enough for the Symbol col (never quoted).
function parseSP500(csv: string): { ticker: string }[] {
  const out: { ticker: string }[] = []
  const lines = csv.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const sym = line.split(',')[0].trim().toUpperCase()
    if (/^[A-Z][A-Z0-9.\-]*$/.test(sym)) out.push({ ticker: sym })
  }
  return out
}

// Wikipedia constituents table: ticker links are the only external nyse.com / nasdaq.com quote links in the
// table region. Capture the link text (ticker) + derive exchange from the host. SEC links are sec.gov; company
// name links are internal /wiki/ -> neither matches.
function parseWiki(html: string): { ticker: string; exchange: string }[] {
  const start = html.indexOf('id="constituents"')
  const region = start >= 0 ? html.slice(start, html.indexOf('</table>', start) + 8) : html
  const out: { ticker: string; exchange: string }[] = []
  const re = /href="https:\/\/www\.(nyse|nasdaq)\.com\/[^"]*"[^>]*>([A-Z][A-Z0-9.\-]*)<\/a>/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = re.exec(region)) !== null) {
    const ex = m[1] === 'nyse' ? 'NYSE' : 'NASDAQ'
    const t = m[2].trim().toUpperCase()
    if (!seen.has(t)) { seen.add(t); out.push({ ticker: t, exchange: ex }) }
  }
  return out
}

async function fj(path: string) {
  try { const r = await fetch(`${FINN}${path}${path.includes('?') ? '&' : '?'}token=${KEY}`); if (!r.ok) return { __err: r.status }; return await r.json() } catch (e) { return { __err: String(e) } }
}

async function chunkedUpsert(admin: any, rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from('universe_cache').upsert(rows.slice(i, i + 500))
    if (error) throw new Error(error.message)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({}))
    const step = body.step ?? 'enrich'

    // ---- MEMBERSHIP: refresh which tickers are in the universe (cheap, identity-only) ----
    if (step === 'membership') {
      const errors: string[] = []
      const rowsByTicker = new Map<string, any>()
      const add = (ticker: string, source: string, exchange: string | null) => {
        if (!rowsByTicker.has(ticker)) rowsByTicker.set(ticker, { ticker, source, cap_band: sourceBand(source), exchange })
      }
      // Order matters for dedupe precedence: large first, then mid, then small (lists are disjoint anyway).
      try { for (const r of parseSP500(await fetchText(SP500_CSV))) add(r.ticker, 'sp500', null) } catch (e) { errors.push(`sp500:${e}`) }
      try { for (const r of parseWiki(await fetchText(SP400_WIKI))) add(r.ticker, 'sp400', r.exchange) } catch (e) { errors.push(`sp400:${e}`) }
      try { for (const r of parseWiki(await fetchText(SP600_WIKI))) add(r.ticker, 'sp600', r.exchange) } catch (e) { errors.push(`sp600:${e}`) }

      const rows = [...rowsByTicker.values()]
      if (!rows.length) return new Response(JSON.stringify({ ok: false, step, error: 'parsed 0 constituents', errors }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
      await chunkedUpsert(admin, rows)
      const counts = rows.reduce((a: any, r: any) => { a[r.source] = (a[r.source] || 0) + 1; return a }, {})
      return new Response(JSON.stringify({ ok: true, step, upserted: rows.length, counts, errors }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // ---- ENRICH: fill fundamentals for rows that are missing/stale (paced Finnhub) ----
    if (!KEY) return new Response(JSON.stringify({ ok: false, error: 'FINNHUB_API_KEY not set' }), { status: 500, headers: cors })
    const batch = Math.min(body.batch ?? 8, 15)
    const force = !!body.force
    const cutoffIso = new Date(Date.now() - STALE_DAYS * 86400000).toISOString()
    // Re-enrich rows missing fundamentals OR missing liquidity OR stale (so avg_dollar_vol backfills once).
    const staleFilter = `roic.is.null,avg_dollar_vol.is.null,updated_at.lt.${cutoffIso}`

    // Filter pending rows server-side (PostgREST caps .select() at 1000 rows, so never load the whole table).
    let todoQ = admin.from('universe_cache').select('ticker, source').order('ticker').limit(batch)
    if (!force) todoQ = todoQ.or(staleFilter)
    const { data: todo } = await todoQ

    let remQ = admin.from('universe_cache').select('*', { count: 'exact', head: true })
    if (!force) remQ = remQ.or(staleFilter)
    const { count: pendingCount } = await remQ

    const rows: any[] = []
    const errors: string[] = []
    for (const c of (todo || [])) {
      const t = c.ticker
      const prof = await fj(`/stock/profile2?symbol=${t}`)
      await sleep(300)
      const met = await fj(`/stock/metric?symbol=${t}&metric=all`)
      await sleep(300)
      const m = (met?.metric || {}) as Record<string, any>
      if (prof?.__err || met?.__err) errors.push(`${t}:${prof?.__err || met?.__err}`)
      const mcapM = typeof prof?.marketCapitalization === 'number' ? prof.marketCapitalization : null
      const mcap = mcapM != null ? mcapM * 1e6 : null
      const pfcf = num(m.pfcfShareTTM)
      // Average daily dollar volume (liquidity). Finnhub metric volume is in MILLIONS of shares; price ~= marketCap/shares.
      const avgVolM = num(m['10DayAverageTradingVolume']) ?? num(m['3MonthAverageTradingVolume'])
      const shareOutM = num(prof?.shareOutstanding)
      const price = (mcapM != null && shareOutM != null && shareOutM > 0) ? mcapM / shareOutM : null
      const advUsd = (avgVolM != null && price != null) ? avgVolM * 1e6 * price : null
      rows.push({
        ticker: t,
        name: prof?.name ?? null,
        sector: prof?.finnhubIndustry ?? null,
        exchange: prof?.exchange ?? null,
        market_cap: mcap,
        cap_band: bandOf(mcap) ?? sourceBand(c.source),
        beta: num(m.beta),
        pe: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
        ps: num(m.psTTM),
        roe: num(m.roeTTM),
        div_yield: num(m.currentDividendYieldTTM) ?? num(m.dividendYieldIndicatedAnnual),
        roic: num(m.roiTTM) ?? num(m.roaeTTM) ?? num(m.roeTTM),
        opm: num(m.operatingMarginTTM),
        netm: num(m.netProfitMarginTTM) ?? num(m.netMarginTTM),
        gm: num(m.grossMarginTTM),
        rev_growth: num(m.revenueGrowthTTMYoy) ?? num(m.revenueGrowthQuarterlyYoy),
        ret1y: num(m['52WeekPriceReturnDaily']),
        fcf_yield: pfcf && pfcf !== 0 ? 1 / pfcf : null,
        avg_dollar_vol: advUsd,
        updated_at: new Date().toISOString(),
      })
    }
    if (rows.length) { const { error } = await admin.from('universe_cache').upsert(rows); if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors }) }
    return new Response(JSON.stringify({ ok: true, step: 'enrich', refreshed: rows.map(r => r.ticker), remaining: Math.max(0, (pendingCount || 0) - rows.length), pending: pendingCount, errors }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
