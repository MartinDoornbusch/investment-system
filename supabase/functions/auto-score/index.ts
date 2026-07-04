// Auto-score holdings from the `fundamentals` cache (Finnhub + Massive/Yahoo). Per-bucket scoring profiles + config-driven weights.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x)))
function momentum(ret) { if (ret == null) return 50; if (ret >= 50) return 92; if (ret >= 25) return 78; if (ret >= 10) return 66; if (ret >= 0) return 58; if (ret >= -10) return 48; if (ret >= -25) return 38; return 28 }
function safetyBeta(beta, netcash) { let s = 60; if (beta == null) s = 55; else if (beta <= 0.5) s = 92; else if (beta <= 0.7) s = 84; else if (beta <= 0.9) s = 74; else if (beta <= 1.2) s = 62; else if (beta <= 1.5) s = 50; else if (beta <= 1.8) s = 42; else if (beta <= 2.2) s = 34; else s = 28; if (netcash) s += 5; return clamp(s) }
function safetyFromRisk(vol, dd) { let s; if (vol <= 15) s = 85; else if (vol <= 20) s = 75; else if (vol <= 25) s = 67; else if (vol <= 35) s = 55; else if (vol <= 50) s = 45; else if (vol <= 70) s = 35; else s = 28; s += dd >= -15 ? 6 : dd >= -30 ? 0 : dd >= -45 ? -4 : -10; return clamp(s) }
function qualityCQ(roic, opm, moat) { let s; const r = roic ?? 15; if (r >= 80) s = 96; else if (r >= 50) s = 90; else if (r >= 35) s = 82; else if (r >= 25) s = 74; else if (r >= 18) s = 66; else if (r >= 12) s = 56; else s = 46; const o = opm ?? 15; s += o >= 40 ? 6 : o >= 25 ? 3 : o >= 15 ? 0 : -4; s += moat * 4; return clamp(s) }
function valueCQ(peg, fwdPe) { if (peg == null) return 50; let s; if (peg <= 0.3) s = 96; else if (peg <= 0.6) s = 88; else if (peg <= 1.0) s = 76; else if (peg <= 1.5) s = 64; else if (peg <= 2.0) s = 52; else if (peg <= 2.5) s = 44; else s = 34; if (fwdPe && fwdPe > 40) s -= 6; return clamp(s) }
function growthMom(rev, momScore) { const r = rev ?? 10; const g = r >= 40 ? 92 : r >= 25 ? 80 : r >= 15 ? 66 : r >= 8 ? 54 : 40; return Math.round(0.6 * g + 0.4 * momScore) }
function qualityG(opm, fcfPos, profitable, gm) { let s = 50; s += profitable ? 12 : -10; s += fcfPos ? 10 : -8; const o = opm ?? 0; s += o >= 20 ? 12 : o >= 10 ? 6 : o >= 0 ? 0 : -8; const g = gm ?? 0; s += g >= 60 ? 8 : g >= 40 ? 4 : 0; return clamp(s) }
// Growth-value pillar for names that often have no earnings (P/E undefined) -> P/S per point of
// REVENUE growth. No 1% floor: a shrinking company must not score like a 1% grower. Negative/zero
// growth = failed growth premise -> low score (margin-of-safety: a cheap price can be a falling knife).
function valueG(ps, rev) { if (ps == null) return 50; if (rev == null) return 50; if (rev <= 0) return 30; const psg = ps / rev; if (psg <= 0.15) return 88; if (psg <= 0.3) return 76; if (psg <= 0.5) return 64; if (psg <= 0.8) return 50; return 36 }

const DEFAULT_WEIGHTS = {
  'Core-Index': { v: 25, q: 25, m: 25, s: 25 }, 'Core-Quality': { v: 25, q: 40, m: 15, s: 20 },
  'Growth': { v: 20, q: 25, m: 40, s: 15 }, 'Speculative': { v: 15, q: 20, m: 50, s: 15 },
  'Concentrated': { v: 30, q: 40, m: 15, s: 15 }, 'Bonds': { v: 25, q: 25, m: 25, s: 25 },
  'Real-Assets': { v: 25, q: 25, m: 25, s: 25 }, 'Cash': { v: 25, q: 25, m: 25, s: 25 },
}
function weightsFor(bucket, cw) {
  const c = cw?.[bucket]
  if (c && c.value != null) return { v: c.value, q: c.quality, m: c.momentum, s: c.safety }
  return DEFAULT_WEIGHTS[bucket] ?? { v: 25, q: 25, m: 25, s: 25 }
}
function scoreProfile(bucket, x) {
  const profitable = (x.netm ?? -1) > 0, fcfPos = (x.fcf ?? 0) > 0
  if (bucket === 'Growth') return { value: valueG(x.ps, x.revg), quality: qualityG(x.opm, fcfPos, profitable, x.gm), mom: growthMom(x.revg, x.momScore), method: 'GARP / CANSLIM' }
  if (bucket === 'Speculative') return { value: valueG(x.ps, x.revg), quality: qualityG(x.opm, fcfPos, profitable, x.gm), mom: x.momScore, method: 'Momentum / trend' }
  if (bucket === 'Concentrated') return { value: valueCQ(x.peg, x.pe), quality: qualityCQ(x.roic, x.opm, x.moat), mom: x.momScore, method: 'Thesis-driven (quality + value)' }
  return { value: valueCQ(x.peg, x.pe), quality: qualityCQ(x.roic, x.opm, x.moat), mom: x.momScore, method: 'Quality-Value compounder' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const auth = req.headers.get('Authorization') ?? ''
    const userClient = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } } })
    const { data: { user } } = await userClient.auth.getUser()
    // Two entry paths: an interactive user (JWT), or a scheduled job carrying CRON_SECRET (no user).
    const cronSecret = Deno.env.get('CRON_SECRET')
    const cronOk = !user && !!body?.secret && !!cronSecret && body.secret === cronSecret
    if (!user && !cronOk) return new Response(JSON.stringify({ ok: false, error: 'not signed in' }), { status: 401, headers: cors })

    // Always read/write via the service role, scoped explicitly by user_id — this lets one cron run
    // score every user, while an interactive call still only touches its own rows.
    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    const { data: fundRows } = await admin.from('fundamentals').select('*') // shared cache (no user_id)
    const fmap = {}
    ;(fundRows ?? []).forEach((f) => { fmap[f.ticker] = f })

    let userIds
    if (user) userIds = [user.id]
    else {
      const { data: us } = await admin.from('holdings').select('user_id')
      userIds = [...new Set((us ?? []).map((r) => r.user_id))]
    }

    const scoredBuckets = new Set(['Core-Quality', 'Growth', 'Concentrated', 'Speculative'])
    const today = new Date().toISOString().slice(0, 10)
    let totalScored = 0, totalSkipped = 0
    const uncached = [], keptMassive = [], missingMassive = []

    for (const uid of userIds) {
      const [{ data: holdings }, { data: cfgRow }, { data: existingScores }] = await Promise.all([
        admin.from('holdings').select('ticker,bucket').eq('user_id', uid),
        admin.from('system_config').select('config').eq('user_id', uid).maybeSingle(),
        admin.from('scores').select('ticker,note,created_at,composite,value,quality,momentum,safety').eq('user_id', uid).order('created_at', { ascending: false }),
      ])
      const configWeights = cfgRow?.config?.weights
      // Latest saved score per ticker → the set that was real (Massive/Yahoo price history), so a fresh Finnhub
      // proxy won't bury a better score (#3). Notes carry the source ('Massive…'/'Yahoo…' vs 'Finnhub…').
      const lastMassive = new Set(); const seenScore = new Set()
      ;(existingScores ?? []).forEach((s) => { if (!seenScore.has(s.ticker)) { seenScore.add(s.ticker); if (s.note && /Massive|Yahoo/i.test(s.note)) lastMassive.add(s.ticker) } })
      const rows = []

      for (const h of (holdings ?? [])) {
        if (!scoredBuckets.has(h.bucket)) { totalSkipped++; continue }
        const f = fmap[h.ticker]
        if (!f) { uncached.push(h.ticker); continue }
        const beta = f.beta, roic = f.roic, opm = f.opm, gm = f.gm, netm = f.netm
        const pe = f.pe, ps = f.ps, de = f.de, fcf = f.fcf_yield, revg = f.rev_growth
        let peg = f.peg
        const netcash = de != null && de < 0.3
        // Missing ROIC -> no moat credit (was +1, which rewarded absent data). And because "roic" here is
        // really Finnhub ROI/ROE (leverage-inflated), cap a high reading to narrow-moat when debt is high:
        // ROE can look great on borrowed money, but the KB's moat test is ROIC durably above cost of capital.
        const levered = de != null && de > 2
        let moat = roic != null ? (roic >= 25 ? 2 : roic >= 15 ? 1 : 0) : 0
        if (levered) moat = Math.min(moat, 1)
        if (peg == null && pe != null && revg && revg > 0) peg = pe / revg
        const hasMassive = f.vol != null && f.mom != null
        if (!hasMassive) missingMassive.push(h.ticker)
        // #3: skip a fresh Finnhub-proxy re-score when a real (Massive/Yahoo) score already exists for this ticker.
        if (!hasMassive && lastMassive.has(h.ticker)) { keptMassive.push(h.ticker); continue }
        const momScore = hasMassive ? momentum(f.mom) : momentum(f.ret1y)
        const safety = hasMassive ? safetyFromRisk(f.vol, f.dd) : safetyBeta(beta, netcash)
        const msSrc = hasMassive ? `${f.price_src || 'Massive'}(vol/DD/12-1)` : 'Finnhub(beta/1Y)'

        const p = scoreProfile(h.bucket, { peg, pe, ps, revg, roic, opm, gm, netm, fcf, moat, momScore })
        const w = weightsFor(h.bucket, configWeights)
        const compositeRaw = Math.round((p.value * w.v + p.quality * w.q + p.mom * w.m + safety * w.s) / 100)
        // Only flag inputs the bucket's method actually uses. Growth/Speculative score Value via P/S (valueG),
        // so PEG/ROIC are irrelevant there; quality buckets use PEG + ROIC.
        const growthLike = h.bucket === 'Growth' || h.bucket === 'Speculative'
        const missing = (growthLike
          ? [ps == null && 'P/S', revg == null && 'revGrowth', opm == null && 'margins']
          : [roic == null && 'ROIC', peg == null && 'PEG']).filter(Boolean)
        // Penalize + flag low-confidence scores: missing Value/Quality inputs fall back to neutral defaults,
        // so without a penalty a data-starved name can outrank a fully-analyzed one. Dock the composite in
        // proportion to missing critical data so it can't.
        const critCount = growthLike ? 3 : 2
        const conf = (critCount - missing.length) / critCount
        const penalty = Math.round((1 - conf) * 18)
        const composite = clamp(compositeRaw - penalty)
        const verdict = composite >= 75 ? 'Strong' : composite >= 60 ? 'Watch' : 'Pass/Review'
        const note = `Auto (cache) +${msSrc} ${today} | ${h.bucket} V${w.v}/Q${w.q}/M${w.m}/Saf${w.s} | ${p.method}` + (missing.length ? ` | low-conf ${Math.round(conf * 100)}% (−${penalty}): missing ${missing.join(', ')}` : '')
        rows.push({ user_id: uid, ticker: h.ticker, value: p.value, quality: p.quality, momentum: p.mom, safety, composite, verdict, note })
      }
      if (rows.length) { const { error } = await admin.from('scores').insert(rows); if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors }) }
      totalScored += rows.length
    }
    return new Response(JSON.stringify({ ok: true, scored: totalScored, users: userIds.length, skipped: totalSkipped, uncached, keptMassive, missingMassive }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors }) }
})
