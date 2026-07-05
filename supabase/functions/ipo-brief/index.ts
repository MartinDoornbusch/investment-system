// AI IPO brief: find the company's S-1/F-1 on SEC EDGAR, fetch the prospectus, and summarize it with Claude,
// strictly grounded in the filing text. Cached 7 days per (user,ticker) in feed_cache. On-demand only.
// F-1 = the foreign private issuer equivalent of an S-1, so we search both (many NASDAQ IPOs are foreign filers).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chatCompletion, llmConfigured } from '../_shared/llm.ts'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const UA = 'investment-system research tool'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || ''
const json = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#8217;|&rsquo;/gi, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"').replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim()
}

// Strip a trailing legal-entity suffix so the phrase search matches ("Koei Group Co. Ltd." -> "Koei Group",
// which phrase-matches "Koei Group Co., Ltd." in the filing text). Keeps distinctive words like "Group".
function coreName(name: string): string {
  const c = String(name || '').replace(/[\s,]+(co\.?|company|corp\.?|corporation|inc\.?|incorporated|ltd\.?|limited|llc|plc|l\.?p\.?|s\.?a\.?|n\.?v\.?|a\.?g\.?|a\.?b\.?)\b.*$/i, '').trim()
  return c.length >= 3 ? c : String(name || '').trim()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!llmConfigured()) return json({ ok: false, error: 'No LLM key set (GROQ_API_KEY / CEREBRAS_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY / ANTHROPIC_API_KEY)' })
    const body = await req.json().catch(() => ({}))
    const ticker = String(body.ticker || '').toUpperCase().trim()
    const company = String(body.company || '').trim()
    if (!company && !ticker) return json({ ok: false, error: 'no company/ticker' })
    const force = !!body.force
    const uc = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } })
    const cacheKind = `ipo-brief:${ticker || company}`.slice(0, 120)
    if (!force) {
      try { const { data } = await uc.from('feed_cache').select('payload,updated_at').eq('kind', cacheKind).maybeSingle()
        if (data?.updated_at && (Date.now() - new Date(data.updated_at).getTime()) < 7 * 86400000) return json(data.payload) } catch (_) {}
    }

    // 1. EDGAR full-text search for the S-1 or F-1 registration statement.
    const nameQ = coreName(company) || ticker
    const q = encodeURIComponent(`"${nameQ}"`)
    const efts = await fetch(`https://efts.sec.gov/LATEST/search-index?q=${q}&forms=S-1,F-1`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!efts.ok) return json({ ok: false, error: `EDGAR search failed (${efts.status}) — SEC may be throttling; try again shortly.` })
    const ej = await efts.json()
    const hits: any[] = ej?.hits?.hits ?? []
    // Keep only the primary prospectus doc (file_type starts S-1/F-1, which excludes EX-* exhibits).
    const isReg = (h: any) => /^(S-1|F-1)/.test(h?._source?.file_type || '')
    const tickMatch = (h: any) => !ticker || (h?._source?.display_names || []).some((n: string) => n.includes(`(${ticker})`))
    const byDate = (a: any, b: any) => String(b?._source?.file_date || '').localeCompare(String(a?._source?.file_date || ''))
    const pick = hits.filter((h) => isReg(h) && tickMatch(h)).sort(byDate)[0] ?? hits.filter(isReg).sort(byDate)[0]
    if (!pick) return json({ ok: false, error: 'No S-1/F-1 prospectus found on SEC EDGAR for this company yet. Very new or non-US filers may not be indexed.' })
    const src = pick._source
    const cik = String((src.ciks || [])[0] || '').replace(/^0+/, '')
    const adsh = String(src.adsh || '').replace(/-/g, '')
    const fileName = String(pick._id || '').split(':')[1] || ''
    if (!cik || !adsh || !fileName) return json({ ok: false, error: 'Could not resolve the EDGAR filing URL.' })
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh}/${fileName}`

    // 2. Fetch the prospectus and extract text.
    const docR = await fetch(filingUrl, { headers: { 'User-Agent': UA } })
    if (!docR.ok) return json({ ok: false, error: `Could not fetch the prospectus (${docR.status}).`, filingUrl })
    const text = stripHtml(await docR.text()).slice(0, 60000)
    if (text.length < 500) return json({ ok: false, error: 'Prospectus text could not be extracted.', filingUrl })

    // 3. Summarize with Claude, grounded strictly in the filing text.
    const formName = String(src.file_type || 'S-1').split('/')[0]
    const system = `You summarize a company's SEC Form ${formName} IPO prospectus for an investor. Use ONLY the provided prospectus text; never add outside facts, and if a detail is not in the text say "not stated". Output concise plain markdown with these sections and headers exactly:
**What they do** — 2-3 sentences on the business and how it makes money.
**Financials** — revenue, growth, profit/loss and cash position, with figures if present.
**The offering** — deal size and use of proceeds.
**Key risks** — 3-4 short bullets of the most material risk factors.
Keep it neutral and under ~260 words. This is informational, not investment advice.`
    let brief: string, model: string
    try {
      const out = await chatCompletion({
        system,
        user: `Company: ${company} (${ticker})\nForm ${formName} filed: ${src.file_date}\n\nProspectus text (excerpt):\n${text}`,
        maxTokens: 900,
      })
      brief = out.text; model = out.model
    } catch (e) { return json({ ok: false, error: `AI summary failed: ${String(e).slice(0, 200)}`, filingUrl }) }
    const payload = { ok: true, brief, filingUrl, filedAt: src.file_date, form: formName, model }
    try { const { data: { user } } = await uc.auth.getUser(); if (user) await uc.from('feed_cache').upsert({ user_id: user.id, kind: cacheKind, payload, updated_at: new Date().toISOString() }) } catch (_) {}
    return json(payload)
  } catch (e) { console.error('ipo-brief', e); return json({ ok: false, error: String(e) }) }
})
