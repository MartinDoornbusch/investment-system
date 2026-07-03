// Ticker detail: profile + ~2y daily bars + ticker & sector-peer news, from Massive.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const BASE = (Deno.env.get('MASSIVE_BASE_URL') || 'https://api.massive.com').replace(/\/$/, '')
const KEY = Deno.env.get('MASSIVE_API_KEY') || ''
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function url(path, params = {}) {
  const u = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  u.searchParams.set('apiKey', KEY)
  return u.toString()
}
async function getJson(path, params) {
  const r = await fetch(url(path, params))
  if (!r.ok) throw new Error(`${path}:${r.status}`)
  return r.json()
}
async function logoDataUri(u) {
  if (!u) return null
  try {
    const sep = u.includes('?') ? '&' : '?'
    const r = await fetch(u + sep + 'apiKey=' + KEY)
    if (!r.ok) return null
    const ct = r.headers.get('content-type') || 'image/png'
    const bytes = new Uint8Array(await r.arrayBuffer())
    let bin = ''; const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    return `data:${ct};base64,${btoa(bin)}`
  } catch (_) { return null }
}
const ageOk = (ts, ms) => !!ts && (Date.now() - new Date(ts).getTime()) < ms
const DAY = 86400000

function mapProfile(res) {
  if (!res) return null
  return {
    ticker: res.ticker, name: res.name, description: res.description,
    industry: res.sic_description, sic_code: res.sic_code,
    exchange: res.primary_exchange, currency: res.currency_name,
    market_cap: res.market_cap, employees: res.total_employees,
    homepage: res.homepage_url, logo: null, list_date: res.list_date,
  }
}
function mapNews(arr = []) {
  return arr.slice(0, 10).map(a => ({
    id: a.id, title: a.title, publisher: a.publisher?.name, url: a.article_url,
    image: a.image_url, published: a.published_utc, description: a.description,
    sentiment: (a.insights || []).find((i) => i.ticker)?.sentiment || null,
    tickers: a.tickers || [],
  }))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!KEY) throw new Error('MASSIVE_API_KEY not set')
    const { ticker, peers = true } = await req.json()
    const t = String(ticker || '').toUpperCase().trim()
    if (!t) return new Response(JSON.stringify({ ok: false, error: 'no ticker' }), { status: 400, headers: cors })
    const base = t.replace(/\.[A-Z]+$/, '')

    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    const { data: cached } = await admin.from('ticker_cache').select('*').eq('ticker', t).maybeSingle()

    let profile = cached?.profile ?? null
    let bars = cached?.bars ?? null
    let news = cached?.news ?? null
    const out = { profile_at: cached?.profile_at ?? null, bars_at: cached?.bars_at ?? null, news_at: cached?.news_at ?? null }
    const errors = []

    if (!ageOk(cached?.profile_at, 30 * DAY)) {
      try {
        const res = (await getJson(`/v3/reference/tickers/${base}`)).results
        profile = mapProfile(res)
        if (profile) profile.logo = await logoDataUri(res?.branding?.icon_url || res?.branding?.logo_url)
        out.profile_at = new Date().toISOString()
      } catch (e) { errors.push(String(e)) }
    }
    if (!ageOk(cached?.bars_at, DAY)) {
      try {
        const to = new Date().toISOString().slice(0, 10)
        const from = new Date(Date.now() - 740 * DAY).toISOString().slice(0, 10)
        const j = await getJson(`/v2/aggs/ticker/${base}/range/1/day/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: '900' })
        bars = (j.results || []).map((b) => ({ t: b.t, c: b.c, v: b.v }))
        out.bars_at = new Date().toISOString()
      } catch (e) { errors.push(String(e)) }
    }
    if (!ageOk(cached?.news_at, 2 * 3600 * 1000)) {
      try {
        const own = mapNews((await getJson('/v2/reference/news', { ticker: base, limit: '8' })).results)
        let peersNews = []
        const sic = profile?.sic_code
        if (peers && sic) {
          await sleep(120)
          const plist = (await getJson('/v3/reference/tickers', { sic_code: String(sic), active: 'true', limit: '12' })).results || []
          const peerTickers = plist.map((p) => p.ticker).filter((x) => x && x !== base).slice(0, 2)
          for (const pt of peerTickers) {
            await sleep(120)
            try { const pn = mapNews((await getJson('/v2/reference/news', { ticker: pt, limit: '3' })).results); peersNews.push({ ticker: pt, articles: pn }) }
            catch (_) {}
          }
        }
        news = { own, peers: peersNews }
        out.news_at = new Date().toISOString()
      } catch (e) { errors.push(String(e)) }
    }

    await admin.from('ticker_cache').upsert({
      ticker: t, profile, bars, news,
      profile_at: out.profile_at, bars_at: out.bars_at, news_at: out.news_at,
    })

    return new Response(JSON.stringify({ ok: true, ticker: t, profile, bars, news, cached_at: out, errors }),
      { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors })
  }
})
