// Helpers for the "Full analysis" tab: explain how each pillar score and the composite were derived.
import type { Fundamentals } from './types'

export interface PillarInfo { key: 'value' | 'quality' | 'momentum' | 'safety'; label: string; measures: string; inputs: string; high: string }

export const PILLARS: PillarInfo[] = [
  { key: 'value', label: 'Value', measures: 'How cheaply the stock trades vs its intrinsic worth and peers.',
    inputs: 'Core/Concentrated: PEG ratio (primary) + forward P/E penalty above 40×. Growth: price/sales vs revenue growth.', high: 'cheap — low PEG / reasonable multiple' },
  { key: 'quality', label: 'Quality', measures: 'How durable and profitable the underlying business is.',
    inputs: 'Core/Concentrated: ROIC, operating margin, moat (0–2 from ROIC). Growth: profitability, positive free cash flow, gross/operating margin.', high: 'durable — high ROIC & margins, low debt' },
  { key: 'momentum', label: 'Momentum', measures: 'Strength and direction of the recent price trend.',
    inputs: '12-minus-1 month total return (last 12 months, skipping the most recent month). Growth blends 60% revenue growth + 40% price momentum.', high: 'confirmed uptrend' },
  { key: 'safety', label: 'Safety', measures: 'How much downside risk the position carries.',
    inputs: 'Annualised volatility + max drawdown (from price history); falls back to beta when Massive risk data is missing.', high: 'lower risk — low volatility / low beta' },
]

export interface ParsedNote { sources?: string; date?: string; bucket?: string; method?: string; weights?: { value: number; quality: number; momentum: number; safety: number }; lowConf: string[] }

export function parseScoreNote(note?: string): ParsedNote {
  const out: ParsedNote = { lowConf: [] }
  if (!note) return out
  const dateM = note.match(/(\d{4}-\d{2}-\d{2})/); if (dateM) out.date = dateM[1]
  out.sources = note.split(/\s+\d{4}-\d{2}-\d{2}/)[0].replace(/^Auto\s*/, '').trim()
  const parts = note.split('|').map(s => s.trim())
  const wPart = parts.find(p => /\/(?:Saf|V|Q|M)/.test(p) || /(?:V|Q|M|Saf)\d/.test(p))
  if (wPart) {
    out.bucket = wPart.replace(/\s+\S*\d.*$/, '').trim() || wPart.split(' ')[0]
    const v = wPart.match(/\bV(\d+)/), q = wPart.match(/Q(\d+)/), s = wPart.match(/Saf(\d+)/), m = wPart.match(/M(\d+)/)
    if (v && q && s && m) out.weights = { value: +v[1], quality: +q[1], momentum: +m[1], safety: +s[1] }
    // The segment after the weights is the named scoring method (e.g. "Quality-Value compounder").
    const wIdx = parts.indexOf(wPart)
    const next = wIdx >= 0 ? parts[wIdx + 1] : undefined
    if (next && !/low-conf/i.test(next)) out.method = next
  }
  const lc = note.match(/low-conf:\s*missing\s*([^|]+)/i)
  if (lc) out.lowConf = lc[1].split(',').map(s => s.trim()).filter(Boolean)
  return out
}

/**
 * Which momentum/safety data source a saved score used, inferred from its note.
 * Handles both note styles — screener ('… | src Massive' / 'src Finnhub') and auto-score
 * ('Auto (cache) +Massive(vol/DD/12-1)' / '+Finnhub(beta/1Y)'), plus legacy 'src FMP' / '(beta/…'.
 * 'Finnhub' means the Massive price-history path was unavailable and the beta + 52-week-return
 * proxies were used — a degraded read worth flagging so it isn't mistaken for the rigorous one.
 */
export function scoreSrc(note?: string | null): 'Massive' | 'Yahoo' | 'Finnhub' | null {
  if (!note) return null
  if (/Massive/i.test(note)) return 'Massive'
  if (/Yahoo/i.test(note)) return 'Yahoo'   // real daily-bar risk metrics for non-US listings — a good source, not a fallback
  if (/Finnhub|FMP|\(beta\//i.test(note)) return 'Finnhub'
  return null
}

// Pillars carrying <20% of the composite are visually de-emphasised — they barely move the score.
export const LOW_WEIGHT_THRESHOLD = 20

// ── Scoring-method reference ────────────────────────────────────────────────
// Canonical explanations of each per-bucket scoring profile, shared by the Rules
// "Scoring methods" card and the ticker Full-analysis hook. `name` must match the
// strings emitted by the screen / auto-score edge functions exactly.
export interface ScoringMethod {
  name: string
  buckets: string[]
  theory: string          // knowledge-base lineage
  weights: string         // composite weights V/Q/M/S
  emphasis: string        // which pillars dominate, and why
  short: string           // one-line blurb for the contextual hook
  pillarHow: { value: string; quality: string; momentum: string; safety: string }
}

export const SCORING_METHODS: ScoringMethod[] = [
  {
    name: 'Quality-Value compounder',
    buckets: ['Core-Quality'],
    theory: 'Buffett-style quality investing, Quality-Minus-Junk (Asness/AQR), and Greenblatt’s Magic Formula (high ROIC bought at a fair price).',
    weights: 'V25 / Q40 / M15 / S20',
    emphasis: 'Quality dominates: you hold these for years, so durability of the business (ROIC, margins, moat) matters more than near-term price action. Momentum is the weakest input.',
    short: 'Durable compounders bought at a reasonable price — scored mostly on business quality, with value as a sanity check and momentum barely counted.',
    pillarHow: {
      value: 'PEG ladder (price/earnings ÷ growth); a penalty applies when forward P/E exceeds 40×. Cheaper PEG → higher score.',
      quality: 'ROIC ladder + operating margin + a 0–2 moat bump derived from ROIC. High return on capital and fat margins score highest.',
      momentum: '12-minus-1 month total return (last 12 months, skipping the most recent), as a plain price-trend read.',
      safety: 'Annualised volatility + max drawdown from price history; falls back to beta when risk data is missing.',
    },
  },
  {
    name: 'Thesis-driven (quality + value)',
    buckets: ['Concentrated'],
    theory: 'Concentration / conviction investing (Buffett–Munger; Kelly-style sizing). Same quality lens as a compounder, but valuation carries more weight because the position is held to a price target.',
    weights: 'V30 / Q40 / M15 / S15',
    emphasis: 'Value + quality drive it; momentum is deliberately minor because you hold through drawdowns toward a thesis target (e.g. NOW to $200+).',
    short: 'A high-conviction hold judged on business quality and fundamental value toward a price target — momentum is intentionally down-weighted.',
    pillarHow: {
      value: 'Same PEG ladder + forward-P/E penalty as the compounder, but weighted higher — valuation discipline anchors the thesis.',
      quality: 'ROIC ladder + operating margin + moat bump. The business must be durable enough to hold through volatility.',
      momentum: '12-minus-1 month price trend, kept small — you are explicitly willing to sit through drawdowns.',
      safety: 'Volatility + max drawdown (or beta fallback).',
    },
  },
  {
    name: 'GARP / CANSLIM',
    buckets: ['Growth'],
    theory: 'Growth-at-a-reasonable-price (Peter Lynch), O’Neil’s CAN SLIM, and the academic momentum factor.',
    weights: 'V20 / Q25 / M40 / S15',
    emphasis: 'Momentum-heavy: growth names are priced on trajectory, so trend + revenue growth tell you whether the market believes the story. Pure valuation is least useful because these are almost always “expensive”.',
    short: 'Growth at a reasonable price — led by momentum (blended with revenue growth), with unit-economics quality second and valuation a light filter.',
    pillarHow: {
      value: 'Price/sales judged relative to revenue growth (a cheap multiple for the growth rate scores higher) — P/E is unreliable here.',
      quality: 'Profitability, positive free cash flow, and gross/operating margins — does the growth convert to real economics?',
      momentum: 'Blend: 60% revenue-growth score + 40% 12-minus-1 price momentum, so fundamentals and trend both count.',
      safety: 'Volatility + max drawdown (or beta fallback).',
    },
  },
  {
    name: 'Momentum / trend',
    buckets: ['Speculative'],
    theory: 'Momentum / trend-following plus the factor-investing momentum premium; fundamentals are deliberately light because many of these names are pre-profit.',
    weights: 'V15 / Q20 / M50 / S15',
    emphasis: 'Momentum-dominant: a speculative ticket lives and dies by narrative and price action. When momentum fades the thesis has usually changed — exit, and never average down.',
    short: 'A narrative/price-action bet: scored mostly on raw price momentum, with valuation and quality kept minor on purpose.',
    pillarHow: {
      value: 'Price/sales vs revenue growth (most speculatives are unprofitable, so P/E-based value is meaningless) — kept low-weight.',
      quality: 'Profitability + free cash flow + margins; usually weak here, and intentionally minor.',
      momentum: 'Pure 12-minus-1 month price return — the dominant signal.',
      safety: 'Volatility + max drawdown (or beta fallback); position size is your real protection.',
    },
  },
]

export function methodByName(name?: string): ScoringMethod | undefined {
  if (!name) return undefined
  return SCORING_METHODS.find(m => m.name === name)
}

// Buckets that are NOT pillar-scored, with the reason — shown as a footnote in the Rules card.
export const UNSCORED_NOTE = 'Core-Index isn’t pillar-scored — an index fund is the market, so it’s held for broad exposure, not selected on factors. Bonds, Real assets and Cash are asset-allocation sleeves, chosen by duration, credit quality and diversification rather than the equity pillar rubric.'

export interface BarMetrics { last: number; ret12_1: number | null; vol: number | null; maxDD: number | null; vsMA50: number | null; vsMA200: number | null }

const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length

// ── Shared per-pillar figure strings (used by both the AI summary and the Full analysis) ───────────
const keepFigs = (a: (string | null | undefined)[]) => a.filter(Boolean) as string[]
export function pillarFigures(fund?: Fundamentals | null, bm?: BarMetrics | null, bucket?: string): Record<'value' | 'quality' | 'momentum' | 'safety', string[]> {
  const growthLike = bucket === 'Growth' || bucket === 'Speculative'
  const vol = bm?.vol ?? fund?.vol, dd = bm?.maxDD ?? fund?.dd
  return {
    value: growthLike
      ? keepFigs([fund?.ps != null ? `P/S ${fund.ps.toFixed(1)}×` : null, fund?.rev_growth != null ? `rev ${fund.rev_growth >= 0 ? '+' : ''}${fund.rev_growth.toFixed(0)}% YoY` : null])
      : keepFigs([fund?.pe != null ? `P/E ${fund.pe.toFixed(0)}×` : null, fund?.peg != null ? `PEG ${fund.peg.toFixed(1)}` : null, fund?.ps != null ? `P/S ${fund.ps.toFixed(1)}×` : null]),
    quality: keepFigs([
      fund?.roic != null ? `Return on capital ${fund.roic.toFixed(0)}%` : null,
      fund?.opm != null ? `op margin ${fund.opm.toFixed(0)}%` : null,
      fund?.netm != null ? `net margin ${fund.netm.toFixed(0)}%` : null,
      fund?.fcf_yield != null ? `FCF yield ${fund.fcf_yield.toFixed(1)}%` : null,
      fund?.de != null ? `D/E ${fund.de.toFixed(1)}` : null,
    ]),
    momentum: keepFigs([
      bm?.ret12_1 != null ? `12−1m ${bm.ret12_1 >= 0 ? '+' : ''}${bm.ret12_1.toFixed(0)}%` : (fund?.ret1y != null ? `1y ${fund.ret1y >= 0 ? '+' : ''}${fund.ret1y.toFixed(0)}%` : null),
      bm?.vsMA50 != null ? `${bm.vsMA50 >= 0 ? '+' : ''}${bm.vsMA50.toFixed(0)}% vs 50-day` : null,
      growthLike && fund?.rev_growth != null ? `rev ${fund.rev_growth >= 0 ? '+' : ''}${fund.rev_growth.toFixed(0)}% YoY` : null,
    ]),
    safety: keepFigs([
      vol != null ? `vol ~${vol.toFixed(0)}%/yr` : null,
      dd != null ? `max drawdown ${dd.toFixed(0)}%` : null,
      fund?.beta != null ? `beta ${fund.beta.toFixed(2)}` : null,
    ]),
  }
}

// ── Rules-based action suggestion (decision aid, NOT advice) ────────────────────────────────────────
export interface ActionSuggestion { stance: string; tone: 'good' | 'mid' | 'bad'; rationale: string }
export function suggestAction(p: {
  composite: number; verdict: string; value: number; quality: number; momentum: number; safety: number
  bucket?: string; held?: boolean; retPct?: number | null
}): ActionSuggestion {
  const { verdict, value, quality, momentum, safety, bucket, held, retPct } = p
  const tier = /Strong/i.test(verdict) ? 'strong' : /Watch/i.test(verdict) ? 'watch' : 'weak'
  const cheap = value >= 65, expensive = value <= 35, weakQuality = quality < 40
  const strongMom = momentum >= 65, weakMom = momentum < 40, lowSafety = safety < 40
  const risk: string[] = []
  if (lowSafety) risk.push('size for volatility / use a stop')
  if (cheap && weakQuality) risk.push('possible value trap — demand a margin of safety')

  let stance = 'Hold', tone: 'good' | 'mid' | 'bad' = 'mid', why = ''
  switch (bucket) {
    case 'Core-Index':
      stance = 'Hold — core exposure'; tone = 'good'
      why = 'Index sleeve: add on a schedule (DCA) and rebalance toward target, not on a score.'
      break
    case 'Concentrated':
      stance = 'Hold to thesis'; tone = 'mid'
      why = 'Conviction position — hold to your price target; trim only on a genuine thesis break, not on price moves. (NOW: hold to $200+, then diversify per your plan.) It is oversized, so plan to trim toward your single-name cap as it recovers.'
      if (tier === 'weak' && weakQuality) why += ' Score and quality are soft — watch for thesis erosion.'
      break
    case 'Growth':
      if (tier !== 'weak' && strongMom) { stance = 'Hold / add with a stop'; tone = 'good'; why = 'Growth name with the trend behind it; the multiple is rich, so it must keep delivering — ride it with a trailing stop.' }
      else if (weakMom || tier === 'weak') { stance = 'Trim / avoid'; tone = 'bad'; why = 'Growth names live on momentum and the trend is rolling over (or the score is weak); reduce rather than hope.' }
      else { stance = 'Hold — monitor'; tone = 'mid'; why = 'Decent but not decisive; watch guidance and the trend.' }
      break
    case 'Speculative':
      if (tier !== 'weak' && strongMom) { stance = 'Hold the runner — trail a stop'; tone = 'mid'; why = 'Momentum is intact; keep the position tiny and trail a stop. Do not add beyond your cap.' }
      else { stance = 'Cut'; tone = 'bad'; why = 'Momentum has faded — for a speculative ticket that usually means the thesis changed. Exit; never average down.' }
      break
    default: // Core-Quality + fallback
      if (tier === 'strong') { stance = expensive ? 'Hold — add on weakness' : 'Accumulate / hold'; tone = 'good'; why = expensive ? 'High-quality compounder but valuation is full — prefer adding on pullbacks.' : 'High-quality compounder at a reasonable price — your framework favours holding/accumulating.' }
      else if (tier === 'watch') { stance = 'Hold — monitor'; tone = 'mid'; why = 'Solid but not a standout right now; hold and watch quality and valuation.' }
      else { stance = 'Review — trim if quality slipped'; tone = 'bad'; why = 'Weak score; re-examine the moat and margins, and trim if the durable thesis has deteriorated.' }
      if (weakQuality && tier !== 'strong') why += ' Quality looks soft — reassess the moat.'
  }
  if (held && retPct != null && retPct < -25 && bucket === 'Speculative') why += ' You are well underwater — resist averaging down (your rule).'
  if (risk.length) why += ` Risk: ${risk.join('; ')}.`
  return { stance, tone, rationale: why }
}

export function barMetrics(bars?: { t: number; c: number }[] | null): BarMetrics | null {
  if (!bars || bars.length < 30) return null
  const c = bars.map(b => b.c)
  const n = c.length
  const last = c[n - 1]
  // 12-1 month momentum: ~21 trading days ago vs ~252 trading days ago. Standard 12-1 skips the most
  // recent month (return from t-12mo to t-1mo) and matches the backend scorer's 252-day base — the
  // displayed figure and the scored figure must use the same window.
  let ret12_1: number | null = null
  if (n > 252) ret12_1 = (c[n - 1 - 21] / c[n - 1 - 252] - 1) * 100
  // annualised volatility over last ~252 days
  let vol: number | null = null
  const w = c.slice(Math.max(1, n - 252))
  if (w.length > 20) {
    const rets: number[] = []
    for (let i = Math.max(1, n - 252); i < n; i++) rets.push(Math.log(c[i] / c[i - 1]))
    const m = avg(rets)
    const sd = Math.sqrt(avg(rets.map(r => (r - m) ** 2)))
    vol = sd * Math.sqrt(252) * 100
  }
  // max drawdown over last ~252 days
  let maxDD: number | null = null
  const dw = c.slice(Math.max(0, n - 252))
  let peak = dw[0], mdd = 0
  for (const p of dw) { if (p > peak) peak = p; const dd = (p / peak - 1) * 100; if (dd < mdd) mdd = dd }
  maxDD = mdd
  const vsMA50 = n >= 50 ? (last / avg(c.slice(n - 50)) - 1) * 100 : null
  const vsMA200 = n >= 200 ? (last / avg(c.slice(n - 200)) - 1) * 100 : null
  return { last, ret12_1, vol, maxDD, vsMA50, vsMA200 }
}
