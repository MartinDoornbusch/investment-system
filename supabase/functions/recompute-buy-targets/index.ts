// Weekly watchlist buy-target recompute (deterministic KB margin-of-safety + quality-premium).
// Ports the former Cowork 'weekly-watchlist-buy-targets' task to the cloud.
// Sets price-alert levels only: writes watchlist.target_buy / target_note / target_set_at.
// NEVER touches the `thesis` column. Secret-guarded for pg_cron; also callable by a signed-in user.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const num = (x: any): number | null => { const n = Number(x); return Number.isFinite(n) ? n : null }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const roundTarget = (v: number) => v > 50 ? Math.round(v) : Math.round(v * 100) / 100

const SKIP_BUCKETS = new Set(['Speculative', 'Bonds', 'Real-Assets', 'Cash'])
const MOS: Record<string, number> = { 'Core-Index': 0.20, 'Core-Quality': 0.20, 'Concentrated': 0.18, 'Growth': 0.25 }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const dryRun = !!body.dryRun
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const auth = req.headers.get('Authorization') ?? ''
    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } })
    const { data: { user } } = await userClient.auth.getUser()
    const cronOk = !user && body.secret && body.secret === Deno.env.get('CRON_SECRET')
    if (!user && !cronOk) return new Response(JSON.stringify({ ok: false, error: 'not signed in' }), { status: 401, headers: cors })
    const admin = createClient(url, serviceKey)

    // 1. Watchlist
    const { data: wl, error: wlErr } = await admin.from('watchlist').select('id,user_id,ticker,bucket,target_buy,target_note')
    if (wlErr) return new Response(JSON.stringify({ ok: false, error: wlErr.message }), { status: 500, headers: cors })
    const tickers = Array.from(new Set((wl ?? []).map((w: any) => w.ticker)))
    if (!tickers.length) return new Response(JSON.stringify({ ok: true, updated: 0, rows: [], note: 'empty watchlist' }), { headers: { ...cors, 'Content-Type': 'application/json' } })

    // 2. Refresh prices first (best-effort, synchronous). Anon key as Bearer matches the gateway's verify_jwt.
    let priceRefresh = 'ok'
    try {
      const pr = await fetch(`${url}/functions/v1/refresh-prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${anon}` },
        body: JSON.stringify({ tickers }),
      })
      priceRefresh = pr.ok ? 'ok' : `http ${pr.status}`
    } catch (e) { priceRefresh = `error ${e}` }

    // 3. Inputs
    const [{ data: prices }, { data: funds }] = await Promise.all([
      admin.from('prices').select('ticker,price'),
      admin.from('fundamentals').select('ticker,pe,rev_growth,roic,beta,vol'),
    ])
    const pMap: Record<string, any> = {}; (prices ?? []).forEach((p: any) => { pMap[p.ticker] = p })
    const fMap: Record<string, any> = {}; (funds ?? []).forEach((f: any) => { fMap[f.ticker] = f })

    const today = new Date().toISOString().slice(0, 10)
    const report: any[] = []
    let updated = 0

    for (const w of (wl ?? [])) {
      const t = w.ticker, bucket = w.bucket || 'Growth'
      const price = num(pMap[t]?.price)
      const f = fMap[t] || {}
      const pe = num(f.pe), revg = num(f.rev_growth), roic = num(f.roic), beta = num(f.beta), vol = num(f.vol)

      let skip: string | null = null
      if (price == null) skip = 'no price'
      else if (pe == null || pe <= 0) skip = 'pe missing/<=0'
      else if (pe > 80) skip = 'pe > 80 (distorted)'
      else if (SKIP_BUCKETS.has(bucket)) skip = `bucket ${bucket}`
      else if (vol != null && vol > 60) skip = `vol ${vol.toFixed(0)}% > 60`
      if (skip) { report.push({ ticker: t, bucket, price, skip }); continue }

      const g = Math.min(revg ?? 0, 40)
      const floor = roic == null ? 12 : roic >= 25 ? 28 : roic >= 18 ? 22 : roic >= 12 ? 16 : 12
      const fairPE = clamp(Math.max(g, floor), 12, 40)
      let mos = MOS[bucket] ?? 0.20
      if (beta != null && beta > 1.8) mos += 0.05
      const eps = price! / pe!
      const fairPrice = fairPE * eps
      const target = roundTarget(Math.min(fairPrice * (1 - mos), price!))
      const note = `KB ${today}: ROIC ${roic ?? 'n/a'} -> fair P/E ${fairPE} x EPS ~$${eps.toFixed(2)} = $${fairPrice.toFixed(2)}; -${Math.round(mos * 100)}% margin (${bucket}) -> $${target}.`

      report.push({ ticker: t, bucket, price, fairPE, mos: Math.round(mos * 100), old: num(w.target_buy), new: target })
      if (!dryRun) {
        const { error } = await admin.from('watchlist').update({ target_buy: target, target_note: note, target_set_at: new Date().toISOString() }).eq('id', w.id)
        if (error) { report[report.length - 1].writeError = error.message; continue }
      }
      updated++
    }

    return new Response(JSON.stringify({ ok: true, dryRun, priceRefresh, count: tickers.length, updated, rows: report }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
