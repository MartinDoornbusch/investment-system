// Sync crypto balances from Bitvavo into `holdings`. Called by the user (JWT) from the Portfolio
// "Sync Bitvavo" button, or by cron (body.secret === CRON_SECRET). Read-only Bitvavo API key.
// Secrets: BITVAVO_API_KEY, BITVAVO_API_SECRET, CRON_SECRET (+ SUPABASE_URL/ANON/SERVICE_ROLE).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const KEY = Deno.env.get('BITVAVO_API_KEY') || ''
const SECRET = Deno.env.get('BITVAVO_API_SECRET') || ''
const BASE = 'https://api.bitvavo.com'
const num = (x: unknown) => { const n = Number(x); return isFinite(n) ? n : 0 }

async function sign(timestamp: string, method: string, path: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${method}${path}${body}`))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function bitvavo(path: string): Promise<any> {
  const ts = Date.now().toString()
  const r = await fetch(BASE + path, {
    headers: {
      'Bitvavo-Access-Key': KEY,
      'Bitvavo-Access-Signature': await sign(ts, 'GET', path, ''),
      'Bitvavo-Access-Timestamp': ts,
      'Bitvavo-Access-Window': '10000',
    },
  })
  if (!r.ok) throw new Error(`Bitvavo ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
async function priceOf(market: string): Promise<number> {
  try { const r = await fetch(`${BASE}/v2/ticker/price?market=${encodeURIComponent(market)}`); if (!r.ok) return 0; return num((await r.json())?.price) } catch { return 0 }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
  try {
    if (!KEY || !SECRET) return json({ ok: false, error: 'BITVAVO_API_KEY / BITVAVO_API_SECRET not set' }, 500)
    const body = await req.json().catch(() => ({}))
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
    const { data: { user } } = await userClient.auth.getUser()
    const cronOk = !user && body?.secret && body.secret === Deno.env.get('CRON_SECRET')
    if (!user && !cronOk) return json({ ok: false, error: 'not authorized' }, 401)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Single Bitvavo account => single user: the caller, or (cron) the one user that has holdings.
    let uid = user?.id
    if (!uid) { const { data } = await admin.from('holdings').select('user_id').limit(1); uid = (data ?? [])[0]?.user_id }
    if (!uid) return json({ ok: false, error: 'no user to attach holdings to' }, 400)

    // Balances -> desired crypto holdings (skip EUR and dust).
    const balances: any[] = await bitvavo('/v2/balance')
    const desired: Record<string, number> = {}
    for (const b of balances) {
      const sym = String(b.symbol || '').toUpperCase()
      if (!sym || sym === 'EUR') continue
      const qty = num(b.available) + num(b.inOrder)
      if (qty > 0) desired[`${sym}-EUR`] = qty
    }

    const { data: existing } = await admin.from('holdings').select('id,ticker,shares,entry_price').eq('user_id', uid).eq('bucket', 'Crypto')
    const byTicker: Record<string, any> = {}
    ;(existing ?? []).forEach((h: any) => { byTicker[h.ticker] = h })

    let inserted = 0, updated = 0, removed = 0
    for (const [ticker, shares] of Object.entries(desired)) {
      const cur = byTicker[ticker]
      if (cur) {
        if (Math.abs(num(cur.shares) - shares) > 1e-12) { await admin.from('holdings').update({ shares }).eq('id', cur.id); updated++ }
      } else {
        const entry = await priceOf(ticker) // seed cost basis at current price; user can correct
        await admin.from('holdings').insert({ user_id: uid, ticker, name: ticker.replace('-EUR', ''), bucket: 'Crypto', currency: 'EUR', shares, entry_price: entry })
        inserted++
      }
    }
    // Remove crypto holdings no longer held on Bitvavo.
    for (const h of (existing ?? [])) {
      if (!(h.ticker in desired)) { await admin.from('holdings').delete().eq('id', h.id); removed++ }
    }

    return json({ ok: true, coins: Object.keys(desired).length, inserted, updated, removed })
  } catch (e) { return json({ ok: false, error: String(e) }, 500) }
})
