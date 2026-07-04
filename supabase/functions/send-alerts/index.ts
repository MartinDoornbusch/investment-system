// Daily alert push: for every user with a push subscription, compute the rule breaches that matter
// (trailing-stop triggered, watchlist buy-target hit, single-name cap breached) from cached prices +
// holdings + config, and deliver one Web Push digest per device. Cron-triggered (CRON_SECRET).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//          VAPID_SUBJECT (mailto: or https URL).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const num = (x: unknown): number => (typeof x === 'number' && isFinite(x) ? x : Number(x) || 0)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    if (!body?.secret || body.secret !== Deno.env.get('CRON_SECRET'))
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: cors })

    const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY')
    if (!pub || !priv) return new Response(JSON.stringify({ ok: false, error: 'VAPID keys not set' }), { status: 500, headers: cors })
    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:alerts@invsys.local', pub, priv)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: subs } = await admin.from('push_subscriptions').select('*')
    if (!subs?.length) return new Response(JSON.stringify({ ok: true, note: 'no subscriptions', sent: 0 }), { headers: { ...cors, 'Content-Type': 'application/json' } })

    // Shared price cache (native currency), and per-user data.
    const { data: priceRows } = await admin.from('prices').select('ticker,price')
    const priceMap: Record<string, number> = {}
    ;(priceRows ?? []).forEach((p: any) => { priceMap[p.ticker] = num(p.price) })

    const userIds = [...new Set(subs.map((s: any) => s.user_id))]
    let sent = 0, removed = 0
    const perUser: Record<string, number> = {}

    for (const uid of userIds) {
      const [{ data: holdings }, { data: cfgRow }, { data: watch }] = await Promise.all([
        admin.from('holdings').select('ticker,bucket,shares,entry_price,currency').eq('user_id', uid),
        admin.from('system_config').select('config').eq('user_id', uid).maybeSingle(),
        admin.from('watchlist').select('ticker,target_buy').eq('user_id', uid),
      ])
      const cfg = cfgRow?.config ?? {}
      const eurUsd = num(cfg.eur_usd) || 1.14
      const trailStops = cfg.trail_stops ?? {}
      const singleCap = num(cfg.single_name_cap) || 10

      const rows = (holdings ?? []).map((h: any) => {
        const price = priceMap[h.ticker] ?? num(h.entry_price)
        const valueEur = h.currency === 'EUR' ? price * num(h.shares) : (price * num(h.shares)) / eurUsd
        return { ...h, price, valueEur }
      })
      const totalEur = rows.reduce((s: number, r: any) => s + r.valueEur, 0) || 1

      const alerts: string[] = []
      for (const r of rows) {
        // Trailing stop (per-bucket; null = disabled)
        const stopPct = trailStops[r.bucket]
        if (stopPct != null && r.price > 0) {
          const hwm = Math.max(num(r.entry_price), r.price)
          const stop = hwm * (1 - num(stopPct) / 100)
          if (r.price < stop) alerts.push(`⚠️ ${r.ticker}: stop hit (${r.price.toFixed(2)} < ${stop.toFixed(2)})`)
        }
        // Single-name concentration (ex core-index)
        const weight = (r.valueEur / totalEur) * 100
        if (r.bucket !== 'Core-Index' && weight > singleCap) alerts.push(`⚠️ ${r.ticker}: ${weight.toFixed(0)}% of portfolio (cap ${singleCap}%)`)
      }
      // Watchlist buy-target hits
      for (const w of (watch ?? [])) {
        const price = priceMap[w.ticker]
        if (w.target_buy != null && price != null && price <= num(w.target_buy))
          alerts.push(`🎯 ${w.ticker}: at/below buy target (${price.toFixed(2)} ≤ ${num(w.target_buy).toFixed(2)})`)
      }
      if (!alerts.length) continue

      const payload = JSON.stringify({
        title: `InvSys — ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`,
        body: alerts.slice(0, 6).join('\n') + (alerts.length > 6 ? `\n…and ${alerts.length - 6} more` : ''),
        url: '/', tag: 'invsys-daily',
      })

      for (const s of subs.filter((x: any) => x.user_id === uid)) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
          sent++; perUser[uid] = (perUser[uid] || 0) + 1
        } catch (e: any) {
          const code = e?.statusCode
          if (code === 404 || code === 410) { await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint); removed++ }
        }
      }
    }
    return new Response(JSON.stringify({ ok: true, users: userIds.length, sent, removed, perUser }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors })
  }
})
