import type { TickerProfile, NewsItem } from './prices'
import type { ScoreRecord } from './types'
import { parseScoreNote, methodByName } from './analysis'

export function fmtMktCap(n?: number): string {
  if (!n) return '—'
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toFixed(0)}`
}

export type Tone = 'good' | 'mid' | 'bad'
export interface ScoreDelta { key: 'value' | 'quality' | 'momentum' | 'safety' | 'composite'; label: string; prev: number; cur: number; delta: number }
export interface ChangeInfo {
  firstScore: boolean
  sinceDate?: string
  composite?: ScoreDelta      // omitted on first score
  movers: ScoreDelta[]        // pillars that moved meaningfully, biggest first
  text: string                // human-readable sentence
}
export interface Synth {
  intro?: string
  headline?: string
  plain?: string              // easy-to-read narrative read of the score
  noScoreMsg?: string
  change?: ChangeInfo
  flags: string[]
  footer: string
  sentiment: { pos: number; neg: number; neu: number }
}

const band = (v: number) =>
  v >= 80 ? 'excellent' : v >= 68 ? 'strong' : v >= 55 ? 'solid' : v >= 45 ? 'middling' : v >= 32 ? 'weak' : 'poor'

// Pillars need to move at least this much to be called out as a "main move".
const MOVE_THRESHOLD = 3

// A plain-language judgement built from the app's own score + the previous run + recent news.
// No external LLM — a rules-based digest. The per-pillar mechanics live on the Full analysis tab;
// this view is the easy-to-read story: where the score sits, what changed, and what's in the news.
export function aiSummary(
  ticker: string,
  profile: TickerProfile | null | undefined,
  score: ScoreRecord | null | undefined,
  prevScore?: ScoreRecord | null,
  news: NewsItem[] = [],
): Synth {
  const flags: string[] = []
  const who = profile?.name || ticker

  const intro = profile?.name
    ? `${profile.name} (${ticker})${profile.industry ? ` in ${profile.industry.toLowerCase()}` : ''}, market cap ${fmtMktCap(profile.market_cap)}${profile.employees ? `, ~${profile.employees.toLocaleString()} employees` : ''}.`
    : undefined

  let headline: string | undefined
  let plain: string | undefined
  let noScoreMsg: string | undefined
  let change: ChangeInfo | undefined

  if (!score) {
    noScoreMsg = 'No score yet — run Auto-score or score it on the Score tab to anchor a view.'
  } else {
    const parsed = parseScoreNote(score.note)
    const md = methodByName(parsed.method)
    headline = `Scores ${score.composite}/100 (${score.verdict})${parsed.method ? ` — ${parsed.method} method` : ''}.`

    // ── Easy-to-read narrative: overall stance + framing + standout / soft spot ──
    const ps: { key: 'value' | 'quality' | 'momentum' | 'safety'; label: string; v: number }[] = [
      { key: 'value', label: 'value', v: score.value },
      { key: 'quality', label: 'quality', v: score.quality },
      { key: 'momentum', label: 'momentum', v: score.momentum },
      { key: 'safety', label: 'safety', v: score.safety },
    ]
    const best = [...ps].sort((a, b) => b.v - a.v)[0]
    const worst = [...ps].sort((a, b) => a.v - b.v)[0]
    const framing = md?.short ? ` ${md.short}.` : ''
    const spread = best.v - worst.v
    const balance = spread <= 8
      ? `The four pillars are fairly even, around ${Math.round((best.v + worst.v) / 2)}/100.`
      : `Its standout is ${best.label} (${band(best.v)}, ${best.v}/100); the soft spot is ${worst.label} (${band(worst.v)}, ${worst.v}/100).`
    plain = `${who} scores ${score.composite}/100 — a "${score.verdict}".${framing} ${balance}`

    // ── Score change vs the previous run ──
    change = buildChange(score, prevScore)

    if (score.momentum >= 70 && score.quality < 40) flags.push('High momentum with low quality — watch for a junk rally; cap conviction.')
    if (score.value >= 70 && score.quality < 30) flags.push('Cheap but low quality — possible value trap; demand a real margin of safety.')
    if (score.safety < 35 && score.momentum >= 70) flags.push('Strong run but high risk — gains can reverse sharply; mind position size and stops.')
    if (parsed.lowConf.length) flags.push(`Lower confidence: ${parsed.lowConf.join(', ')} were missing at scoring time, so those inputs defaulted toward neutral.`)
  }

  // News sentiment tilt (used to colour the news block)
  const pos = news.filter(n => n.sentiment === 'positive').length
  const neg = news.filter(n => n.sentiment === 'negative').length
  const neu = news.length - pos - neg

  return {
    intro, headline, plain, noScoreMsg, change, flags,
    footer: 'Plain-language digest of your own score, its change since the last run, and recent news — a decision aid, not advice, and not a generative model.',
    sentiment: { pos, neg, neu },
  }
}

const PILLAR_LABELS: Record<'value' | 'quality' | 'momentum' | 'safety', string> = {
  value: 'Value', quality: 'Quality', momentum: 'Momentum', safety: 'Safety',
}

// Compare the current score to the previous run and describe what moved.
function buildChange(score: ScoreRecord, prevScore?: ScoreRecord | null): ChangeInfo {
  if (!prevScore) {
    return { firstScore: true, movers: [], text: 'First score on record — no earlier run to compare against yet.' }
  }
  const sinceDate = parseScoreNote(prevScore.note).date || prevScore.created_at?.slice(0, 10)
  const composite: ScoreDelta = { key: 'composite', label: 'Composite', prev: prevScore.composite, cur: score.composite, delta: score.composite - prevScore.composite }
  const keys: ('value' | 'quality' | 'momentum' | 'safety')[] = ['value', 'quality', 'momentum', 'safety']
  const movers: ScoreDelta[] = keys
    .map(k => ({ key: k, label: PILLAR_LABELS[k], prev: prevScore[k], cur: score[k], delta: score[k] - prevScore[k] }))
    .filter(d => Math.abs(d.delta) >= MOVE_THRESHOLD)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const sgn = (n: number) => (n > 0 ? `+${n}` : `${n}`)
  let text: string
  if (composite.delta === 0 && movers.length === 0) {
    text = `Unchanged since the previous score${sinceDate ? ` (${sinceDate})` : ''}.`
  } else {
    const dir = composite.delta > 0 ? 'rose' : composite.delta < 0 ? 'fell' : 'held'
    const head = composite.delta === 0
      ? `Composite held at ${composite.cur}`
      : `Composite ${dir} ${sgn(composite.delta)} (${composite.prev} → ${composite.cur})`
    const moves = movers.length ? ` Main moves: ${movers.map(m => `${m.label} ${sgn(m.delta)}`).join(', ')}.` : ''
    text = `${head}${sinceDate ? ` since ${sinceDate}` : ''}.${moves}`
  }
  return { firstScore: false, sinceDate, composite, movers, text }
}
