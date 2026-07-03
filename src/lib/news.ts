import type { NewsItem } from './prices'
import type { NewsDigestItem } from './feed'

// News classification + prioritization. ONE canonical taxonomy shared by the per-ticker view and the
// Dashboard digest. Per-ticker ranking is a deterministic heuristic (materiality 50% / recency 30% /
// source quality 20%, clickbait penalty, near-duplicate dedup). When an article also appears in today's
// LLM-written digest, that richer judgement (category, consensus, horizon-impact, actionable) overrides
// the heuristic and boosts priority.

export type Materiality = 'high' | 'medium' | 'low'

// Canonical categories + their materiality tier and display label. Both engines map onto this.
const CANON: Record<string, { label: string; mat: Materiality }> = {
  earnings:   { label: 'Earnings',   mat: 'high' },
  guidance:   { label: 'Guidance',   mat: 'high' },
  'm&a':      { label: 'M&A',        mat: 'high' },
  regulatory: { label: 'Regulatory', mat: 'high' },
  legal:      { label: 'Legal',      mat: 'high' },
  management: { label: 'Management', mat: 'high' },
  analyst:    { label: 'Analyst',    mat: 'medium' },
  product:    { label: 'Product',    mat: 'medium' },
  macro:      { label: 'Macro',      mat: 'low' },
  other:      { label: 'Other',      mat: 'low' },
}
const SYN: Record<string, string> = { mergers: 'm&a', acquisition: 'm&a', 'm & a': 'm&a', ma: 'm&a', 'm and a': 'm&a' }

/** Normalize any category string (heuristic key or digest label) to a canonical label + materiality. */
export function categoryMeta(cat?: string): { key: string; label: string; materiality: Materiality } {
  const raw = (cat || '').toLowerCase().trim()
  const key = CANON[raw] ? raw : (SYN[raw] || 'other')
  const c = CANON[key]
  return { key, label: c.label, materiality: c.mat }
}
/** Shared chip tone by materiality — used in both the modal and the Dashboard digest. */
export const catTone = (m: Materiality) =>
  m === 'high' ? 'bg-amber-900/40 text-amber-300' : m === 'medium' ? 'bg-brandblue/20 text-brandblue' : 'bg-[#21262d] text-dim'

export interface RankedNews extends NewsItem {
  category: string; materiality: Materiality; rankScore: number; peerTicker?: string
  fromDigest?: boolean; consensus?: string | null; horizon?: string | null; actionable?: string | null; priority?: number | null
}

// Heuristic classifier — first match wins, so high-materiality patterns are listed first.
const CAT_RULES: { key: string; re: RegExp }[] = [
  { key: 'earnings',   re: /\b(earnings|results|revenue|profit|eps|beats?|miss(es|ed)?|quarter(ly)?|q[1-4]\b|full[- ]year|sales)\b/i },
  { key: 'guidance',   re: /\b(guidance|forecast|outlook|raises?|cuts?|lowers?|warn(s|ing)?|guides?)\b/i },
  { key: 'm&a',        re: /\b(acquir\w*|acquisition|merger|merges?|takeover|buyout|to buy|buys? \w+|stake|spin-?off|divest\w*)\b/i },
  { key: 'regulatory', re: /\b(sec\b|antitrust|regulat\w*|probe|investigat\w*|fined?|doj|ftc|subpoena|recall|sanction|approval|fda|compliance)\b/i },
  { key: 'legal',      re: /\b(lawsuit|sued?|court|settlement|litigation|patent|verdict|class action|damages|injunction)\b/i },
  { key: 'management', re: /\b(ceo|cfo|coo|resign\w*|appoint\w*|steps? down|chair(man|person)?|board|dividend|buyback|repurchase|insider)\b/i },
  { key: 'analyst',    re: /\b(upgrade|downgrade|price target|initiat\w*|reiterat\w*|overweight|underweight|outperform|underperform|\brating\b|analyst)\b/i },
  { key: 'product',    re: /\b(launch\w*|unveil\w*|partnership|partners? with|contract|deal with|integrat\w*|new (product|chip|model|platform)|expansion|rollout)\b/i },
  { key: 'macro',      re: /\b(tariff|rate cut|interest rates?|inflation|the fed\b|sector|industry|economy|gdp)\b/i },
]
const NOISE_RE = /(\b\d+\s+(reasons|stocks|things|charts)\b|should you buy|is it (a )?(buy|sell)|better buy|stocks? to (buy|watch|consider)|here'?s why|motley fool|could make you|millionaire|best stocks|why .* (could|might|may))/i
const T1 = /(reuters|bloomberg|wall street journal|wsj|financial times|\bft\b|cnbc|barron|associated press|\bap\b|dow jones|the economist)/i
const T3 = /(motley fool|zacks|investorplace|simply wall|gurufocus|insider monkey|benzinga|tipranks|stocktwits|24\/7 wall|invezz)/i

const classifyKey = (a: NewsItem) => {
  const txt = `${a.title || ''} ${a.description || ''}`
  for (const r of CAT_RULES) if (r.re.test(txt)) return r.key
  return 'other'
}
const matW = (m: Materiality) => (m === 'high' ? 1 : m === 'medium' ? 0.6 : 0.25)
const sourceScore = (pub?: string) => { const p = pub || ''; return T1.test(p) ? 1 : T3.test(p) ? 0.3 : 0.55 }
const recency = (published?: string) => {
  if (!published) return 0.3
  const days = (Date.now() - new Date(published).getTime()) / 86400000
  return Math.max(0, Math.min(1, 1 - days / 21))
}
const normTitle = (t?: string) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 7).join(' ')
const normUrl = (u?: string) => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#?].*$/, '').replace(/\/+$/, '')

export type DigestIndex = Map<string, NewsDigestItem>
/** Index today's digest items by normalized URL and headline for fast per-article lookup. */
export function buildDigestIndex(items: NewsDigestItem[] = []): DigestIndex {
  const m: DigestIndex = new Map()
  for (const it of items) {
    if (it.url) m.set('u:' + normUrl(it.url), it)
    if (it.headline) m.set('h:' + normTitle(it.headline), it)
  }
  return m
}

function scoreOne(a: NewsItem, peerTicker?: string, idx?: DigestIndex): RankedNews {
  const h = categoryMeta(classifyKey(a))
  const noise = NOISE_RE.test(a.title || '') ? 0.4 : 1
  let score = 100 * (0.5 * matW(h.materiality) + 0.3 * recency(a.published) + 0.2 * sourceScore(a.publisher)) * noise
  let label = h.label, mat = h.materiality
  const extra: Partial<RankedNews> = {}
  const d = idx ? (idx.get('u:' + normUrl(a.url)) || idx.get('h:' + normTitle(a.title))) : undefined
  if (d) {
    const dm = categoryMeta(d.category || h.key)
    label = dm.label; mat = dm.materiality
    extra.fromDigest = true; extra.consensus = d.consensus; extra.horizon = d.horizon_impact; extra.actionable = d.actionable; extra.priority = d.priority
    score += 20 + (d.horizon_impact === 'thesis-change' ? 30 : d.horizon_impact === 'monitor' ? 15 : 0) + (d.priority ? (5 - d.priority) * 5 : 0)
  }
  return { ...a, category: label, materiality: mat, rankScore: Math.round(score), peerTicker, ...extra }
}
function dedupTop(items: RankedNews[], limit: number): RankedNews[] {
  const seen = new Map<string, RankedNews>()
  for (const a of [...items].sort((x, y) => y.rankScore - x.rankScore)) {
    const k = normTitle(a.title); if (!k || seen.has(k)) continue
    seen.set(k, a)
  }
  return [...seen.values()].sort((a, b) => b.rankScore - a.rankScore).slice(0, limit)
}

/** Classify + rank a single ticker's news, returning the top `limit`. Pass a digest index to overlay LLM labels. */
export function rankNews(items: NewsItem[] = [], limit = 3, idx?: DigestIndex): RankedNews[] {
  return dedupTop(items.map(a => scoreOne(a, undefined, idx)), limit)
}
/** Rank across ALL peers' news (each row keeps its ticker), returning the best `limit` overall. */
export function rankPeerNews(peers: { ticker: string; articles: NewsItem[] }[] = [], limit = 3, idx?: DigestIndex): RankedNews[] {
  const flat: RankedNews[] = []
  for (const p of peers) for (const a of p.articles || []) flat.push(scoreOne(a, p.ticker, idx))
  return dedupTop(flat, limit)
}
