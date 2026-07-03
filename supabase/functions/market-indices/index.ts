// Market-index strip data via Yahoo (keyless). Price + 200-day MA + day % for requested indices,
// plus a US-driven regime (S&P 500 & Nasdaq-100 vs 200DMA; distribution days from SPY/QQQ) — mirrors the My Stocks app.
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const r2 = (x: number) => Math.round(x * 100) / 100

async function yChart(sym: string): Promise<{ price: number; ma200: number | null; chg: number | null; closes: number[]; vols: number[] } | null> {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const j = await r.json(); const res = j?.chart?.result?.[0]; if (!res) return null
    const q = res.indicators?.quote?.[0] ?? {}
    const closes = (q.close ?? []).filter((x: any) => typeof x === 'number')
    const vols = (q.volume ?? []).map((x: any) => (typeof x === 'number' ? x : 0))
    if (!closes.length) return null
    // Day change = last two DAILY closes (not Yahoo meta.chartPreviousClose, which on a 1y range is ~a year ago).
    const price = closes[closes.length - 1]
    const chg = closes.length >= 2 && closes[closes.length - 2] ? ((price / closes[closes.length - 2]) - 1) * 100 : null
    const ma200 = closes.slice(-200).reduce((a: number, b: number) => a + b, 0) / Math.min(200, closes.length)
    return { price, ma200, chg, closes, vols }
  } catch { return null }
}
function distDays(closes: number[], vols: number[]): number {
  let n = 0; const len = closes.length
  for (let i = Math.max(1, len - 25); i < len; i++) {
    const dn = (closes[i] / closes[i - 1] - 1) * 100
    if (dn <= -0.2 && vols[i] && vols[i - 1] && vols[i] > vols[i - 1]) n++
  }
  return n
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const extra: string[] = Array.isArray(body.extra) ? body.extra.filter((s: any) => typeof s === 'string') : []
    const syms = Array.from(new Set(['^GSPC', '^NDX', ...extra]))
    const indices: Record<string, any> = {}
    const cache: Record<string, any> = {}
    for (const s of syms) { const d = await yChart(s); await sleep(150); if (d) { cache[s] = d; indices[s] = { price: r2(d.price), ma200: d.ma200 != null ? r2(d.ma200) : null, chg: d.chg != null ? r2(d.chg) : null } } }
    const spy = await yChart('SPY'); await sleep(150); const qqq = await yChart('QQQ')
    const ds: number[] = []
    if (spy) ds.push(distDays(spy.closes, spy.vols))
    if (qqq) ds.push(distDays(qqq.closes, qqq.vols))
    const dist = ds.length ? Math.max(...ds) : 0
    const spx = cache['^GSPC'], ndx = cache['^NDX']
    let state = '—', m = 1
    if (spx && ndx && spx.ma200 != null && ndx.ma200 != null) {
      const su = spx.price > spx.ma200, nu = ndx.price > ndx.ma200
      if (su && nu && dist < 4) { state = 'Confirmed uptrend'; m = 3 }
      else if (su && nu) { state = 'Uptrend under pressure'; m = 1 }
      else if (!su && !nu) { state = 'Bear market'; m = 0 }
      else { state = 'Mixed signals'; m = 1 }
    }
    return new Response(JSON.stringify({ ok: true, indices, state, m, dist }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
