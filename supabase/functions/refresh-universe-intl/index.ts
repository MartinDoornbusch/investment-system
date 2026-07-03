// International universe refresh — Europe v1 (per International-Screener-Metric-Proposal.md).
// One TradingView scanner POST replaces the per-ticker enrich model: /global/scan returns the whole
// region with all factor columns. Unofficial endpoint (ToS-gray) — hence: response-shape validation,
// results cached in universe_cache (a broken fetch degrades to stale data, never a broken app).
// Dry-run findings baked in (2026-07-02):
//  - /global/scan normalizes market caps across currencies (per-market scan returns local) -> US $10B/$2B
//    cap-band thresholds apply directly, keeping cap_band semantics identical app-wide.
//  - is_primary does NOT exclude foreign lines (e.g. Exxon's Milan listing) -> domicile filter required.
//  - GBX (pence) and ZAC (SA cents) are subunit currencies -> ÷100 before price×volume math.
//  - EV/EBITDA nulls concentrate in financials (metric undefined for banks) -> financials scored on P/B+ROE
//    in the screen function, not here.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. No API key needed for the scanner.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const num = (x: unknown): number | null => (typeof x === 'number' && isFinite(x) ? x : null)
const bandOf = (mc: number | null) => (mc == null ? null : mc >= 1e10 ? 'large' : mc >= 2e9 ? 'mid' : 'small')

// FTSE-developed-Europe convention. markets selects EXCHANGES; domicile (country) decides membership.
const EUROPE_MARKETS = ['netherlands', 'germany', 'france', 'uk', 'switzerland', 'sweden', 'denmark', 'norway', 'finland', 'italy', 'spain', 'belgium', 'austria', 'portugal', 'ireland']
const EUROPE_DOMICILES = new Set(['Netherlands', 'Germany', 'France', 'United Kingdom', 'Switzerland', 'Sweden', 'Denmark', 'Norway', 'Finland', 'Italy', 'Spain', 'Belgium', 'Austria', 'Portugal', 'Ireland', 'Luxembourg'])

// TradingView exchange -> Yahoo-style suffix (keeps ticker format consistent with the rest of the app:
// yahooMetrics and ticker-detail already handle .AS/.PA/... suffixes). EURONEXT hosts four countries,
// so its suffix resolves via domicile.
const EX_SUFFIX: Record<string, string> = { XETR: 'DE', FWB: 'F', LSE: 'L', SIX: 'SW', OMXSTO: 'ST', OMXCOP: 'CO', OMXHEX: 'HE', OSL: 'OL', MIL: 'MI', BME: 'MC', WBAG: 'VI' }
const EURONEXT_BY_COUNTRY: Record<string, string> = { Netherlands: 'AS', France: 'PA', Belgium: 'BR', Portugal: 'LS', Ireland: 'IR' }

const COLUMNS = [
  'name', 'description', 'market_cap_basic', 'close', 'currency', 'exchange', 'country', 'sector',
  'price_earnings_ttm', 'price_revenue_ttm', 'price_book_fq', 'enterprise_value_ebitda_ttm',
  'return_on_invested_capital', 'return_on_equity', 'operating_margin', 'after_tax_margin', 'gross_margin',
  'free_cash_flow_margin_ttm', 'price_free_cash_flow_ttm', 'debt_to_equity', 'current_ratio',
  'total_revenue_yoy_growth_ttm', 'earnings_per_share_diluted_yoy_growth_ttm',
  'Perf.Y', 'Perf.1M', 'beta_1_year', 'average_volume_30d_calc', 'dividend_yield_recent',
] as const
const col = (row: unknown[], name: typeof COLUMNS[number]) => row[COLUMNS.indexOf(name)]

// ECB reference rates (free, keyless) for the USD liquidity floor. Subunit currencies quoted per 100.
async function fxToUsd(): Promise<Record<string, number>> {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD')
    if (!r.ok) return {}
    const j = await r.json()
    const rates: Record<string, number> = { USD: 1 }
    for (const [cur, perUsd] of Object.entries(j?.rates ?? {})) if (typeof perUsd === 'number' && perUsd > 0) rates[cur] = 1 / perUsd
    if (rates.GBP) rates.GBX = rates.GBP / 100
    if (rates.ZAR) rates.ZAC = rates.ZAR / 100
    return rates
  } catch { return {} }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const region = body.region ?? 'europe'
    if (region !== 'europe') return new Response(JSON.stringify({ ok: false, error: `region '${region}' not implemented yet (europe only in v1)` }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })

    const payload = {
      columns: COLUMNS,
      filter: [
        { left: 'type', operation: 'equal', right: 'stock' },
        { left: 'is_primary', operation: 'equal', right: true },
      ],
      markets: EUROPE_MARKETS,
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [0, 1500], // dry run: rank-800 cap was ~$2.4B, so 1500 rows safely covers the >= $2B (mid) floor
    }
    const res = await fetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (investment-system universe refresh)' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return new Response(JSON.stringify({ ok: false, error: `scanner HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    const json = await res.json()
    const data: Array<{ s: string; d: unknown[] }> = json?.data
    // Shape validation: the endpoint is unofficial; if the schema drifts, fail loudly instead of caching garbage.
    if (!Array.isArray(data) || data.length < 100 || !data[0]?.s || !Array.isArray(data[0]?.d) || data[0].d.length !== COLUMNS.length) {
      return new Response(JSON.stringify({ ok: false, error: 'scanner response shape unexpected — schema drift? Aborting without writing.', sample: JSON.stringify(json)?.slice(0, 300) }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const fx = await fxToUsd()
    const rows: Record<string, unknown>[] = []
    const skipped = { domicile: 0, band: 0, suffix: 0, dupe: 0 }
    const seen = new Set<string>()
    for (const r of data) {
      const country = String(col(r.d, 'country') ?? '')
      if (!EUROPE_DOMICILES.has(country)) { skipped.domicile++; continue } // kills foreign lines (MIL:1XOM) + odd domiciles
      const mc = num(col(r.d, 'market_cap_basic'))
      const band = bandOf(mc)
      if (band !== 'large' && band !== 'mid') { skipped.band++; continue } // large+mid only ex-US (approved scope)
      const [ex, local] = r.s.split(':')
      const suffix = ex === 'EURONEXT' ? EURONEXT_BY_COUNTRY[country] : EX_SUFFIX[ex]
      if (!suffix || !local) { skipped.suffix++; continue }
      const ticker = `${local}.${suffix}`
      if (seen.has(ticker)) { skipped.dupe++; continue }
      seen.add(ticker)

      const cur = String(col(r.d, 'currency') ?? '')
      const close = num(col(r.d, 'close'))
      const adv = num(col(r.d, 'average_volume_30d_calc'))
      const advUsd = adv != null && close != null && fx[cur] != null ? adv * close * fx[cur] : null
      const perfY = num(col(r.d, 'Perf.Y'))
      const perf1M = num(col(r.d, 'Perf.1M'))
      // 12-1 momentum, compounded (NOT subtracted): strip the most recent month per Jegadeesh-Titman.
      const ret121 = perfY != null && perf1M != null && perf1M > -100 ? ((1 + perfY / 100) / (1 + perf1M / 100) - 1) * 100 : perfY
      const pfcf = num(col(r.d, 'price_free_cash_flow_ttm'))
      rows.push({
        ticker,
        tv_symbol: r.s,
        region: 'europe',
        source: 'tv-europe',
        name: (col(r.d, 'description') as string) ?? (col(r.d, 'name') as string) ?? null,
        sector: (col(r.d, 'sector') as string) ?? null,
        exchange: ex,
        country,
        currency: cur || null,
        market_cap: mc,
        cap_band: band,
        beta: num(col(r.d, 'beta_1_year')),
        pe: num(col(r.d, 'price_earnings_ttm')),
        ps: num(col(r.d, 'price_revenue_ttm')),
        pb: num(col(r.d, 'price_book_fq')),
        ev_ebitda: num(col(r.d, 'enterprise_value_ebitda_ttm')),
        roe: num(col(r.d, 'return_on_equity')),
        roic: num(col(r.d, 'return_on_invested_capital')),
        opm: num(col(r.d, 'operating_margin')),
        netm: num(col(r.d, 'after_tax_margin')),
        gm: num(col(r.d, 'gross_margin')),
        de: num(col(r.d, 'debt_to_equity')),
        div_yield: num(col(r.d, 'dividend_yield_recent')),
        rev_growth: num(col(r.d, 'total_revenue_yoy_growth_ttm')),
        ret1y: ret121, // 12-1 momentum for intl rows (US rows keep plain 52w return; momentum() bands both)
        fcf_yield: pfcf && pfcf !== 0 ? 1 / pfcf : null,
        avg_dollar_vol: advUsd,
        updated_at: new Date().toISOString(),
      })
    }
    if (rows.length < 100) return new Response(JSON.stringify({ ok: false, error: `only ${rows.length} rows after filters — refusing to write (expected several hundred)`, skipped }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Replace-then-upsert per region: constituents drop out of the band over time; stale rows must go.
    const { error: delErr } = await admin.from('universe_cache').delete().eq('region', 'europe')
    if (delErr) return new Response(JSON.stringify({ ok: false, error: `delete: ${delErr.message}` }), { status: 500, headers: cors })
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from('universe_cache').upsert(rows.slice(i, i + 500))
      if (error) return new Response(JSON.stringify({ ok: false, error: `upsert: ${error.message}`, at: i }), { status: 500, headers: cors })
    }
    const counts = rows.reduce((a: Record<string, number>, r) => { const b = String(r.cap_band); a[b] = (a[b] || 0) + 1; return a }, {})
    return new Response(JSON.stringify({ ok: true, region: 'europe', written: rows.length, counts, skipped, fxLoaded: Object.keys(fx).length > 0, totalScanned: data.length }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors })
  }
})
