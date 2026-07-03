import type { SystemConfig, Bucket } from './types'

// Asset-allocation layer (v2). Equity sub-buckets are grouped under one "Equities" class;
// Bonds / Real assets / Cash are their own classes. Used to group buckets consistently
// across Rules, Dashboard and Portfolio.
export const EQUITY_BUCKETS: Bucket[] = ['Core-Index', 'Core-Quality', 'Growth', 'Speculative', 'Concentrated']

// Broad index funds / ETFs → classified Core-Index. Single source of truth (used by Screener + Watchlist).
export const INDEX_RE = /^(VWRL|IWDA|CSPX|SPY|QQQ|IVV|VTI|XDWD|ACWI|VUSA|ISF|SWRD|EUNL|VEUR|IUSA|VWCE|SSAC|AGGH|EMB)/i

/** Heuristic bucket from a company profile (sector + market cap). Index ETFs → Core-Index.
 *  Shared by the Screener fallback and the Watchlist auto-assign so both classify alike. */
export function profileBucket(ticker: string, profile: { market_cap?: number | null; industry?: string | null }): Bucket {
  if (INDEX_RE.test(ticker)) return 'Core-Index'
  const cap = profile.market_cap ?? 0
  const ind = (profile.industry ?? '').toLowerCase()
  if (cap > 0 && cap < 2e9) return 'Speculative'
  if (cap > 50e9) {
    const q = ind.includes('drug') || ind.includes('pharmaceutical') || ind.includes('utilities') || ind.includes('waste') ||
      ind.includes('water') || ind.includes('bank') || ind.includes('insurance') || ind.includes('asset management') ||
      ind.includes('consumer defensive') || ind.includes('food') || ind.includes('beverage') ||
      (ind.includes('semiconductor') && cap > 100e9) || (ind.includes('software') && cap > 200e9)
    if (q) return 'Core-Quality'
  }
  return 'Growth'
}
export const ASSET_CLASSES: { label: string; buckets: Bucket[] }[] = [
  { label: 'Equities', buckets: EQUITY_BUCKETS },
  { label: 'Bonds', buckets: ['Bonds'] },
  { label: 'Real assets', buckets: ['Real-Assets'] },
  { label: 'Cash', buckets: ['Cash'] },
]

// Structured "why I'm watching" reasons. Stored on watchlist.reasons as the short `key`.
// Each maps to a theory/bucket in the knowledge base so the watchlist stays analyzable.
export const WATCH_REASONS: { key: string; label: string; desc: string }[] = [
  { key: 'value', label: 'Value', desc: 'Undervalued / margin of safety' },
  { key: 'quality', label: 'Quality', desc: 'Quality compounder — durable moat, high ROIC' },
  { key: 'growth', label: 'Growth', desc: 'Growth (GARP / CANSLIM)' },
  { key: 'momentum', label: 'Momentum', desc: 'Momentum / trend' },
  { key: 'diversifier', label: 'Diversifier', desc: 'Low correlation / defensive ballast' },
  { key: 'income', label: 'Income', desc: 'Income / dividend' },
  { key: 'catalyst', label: 'Catalyst', desc: 'Catalyst / event (earnings, product, spinoff)' },
  { key: 'turnaround', label: 'Turnaround', desc: 'Turnaround / cyclical' },
  { key: 'theme', label: 'Theme', desc: 'Thematic / secular trend' },
]
export const WATCH_REASON_LABEL: Record<string, string> = Object.fromEntries(WATCH_REASONS.map(r => [r.key, r.label]))
export const WATCH_REASON_DESC: Record<string, string> = Object.fromEntries(WATCH_REASONS.map(r => [r.key, r.desc]))

// Display layer for buckets. The STORED VALUES (holdings.bucket, config keys, classifier output)
// stay as the keys below — only the visible label changes. 'Concentrated' shows as 'Conviction'.
export const BUCKET_LABEL: Record<Bucket, string> = {
  'Core-Index': 'Core-Index',
  'Core-Quality': 'Core-Quality',
  'Growth': 'Growth',
  'Speculative': 'Speculative',
  'Concentrated': 'Conviction',
  'Bonds': 'Bonds',
  'Real-Assets': 'Real assets',
  'Cash': 'Cash',
}
export const BUCKET_DESC: Record<Bucket, string> = {
  'Core-Index': 'Passive core — broad, low-cost index funds/ETFs that capture the whole market cheaply. Your anchor; not scored individually.',
  'Core-Quality': 'Quality core — individual high-quality compounders (durable moat, high ROIC, stable) held at normal weight. Scored as a quality-value compounder.',
  'Growth': 'Growth satellite — companies owned for expansion rather than cheapness. Scored GARP / CANSLIM (P/S + revenue growth, momentum-weighted).',
  'Speculative': 'Speculative satellite — small-cap or unprofitable, high-risk/high-variance bets. Scored on momentum/trend. Cap this bucket the hardest.',
  'Concentrated': 'Conviction (stored as “Concentrated”) — a deliberate, oversized, thesis-driven position such as a legacy/RSU holding. Defined by its role and size, not just company quality. Never auto-assigned.',
  'Bonds': 'Bonds — fixed income for ballast and income. An asset class you set manually; not equity-scored.',
  'Real-Assets': 'Real assets — property, commodities, infrastructure and other inflation hedges. Set manually; not equity-scored.',
  'Cash': 'Cash — dry powder and liquidity. Set manually; not scored.',
}
export const BUCKET_COLOR: Record<string, string> = {
  'Core-Index': 'text-sky-400', 'Core-Quality': 'text-indigo-400', 'Growth': 'text-violet-400',
  'Speculative': 'text-orange-400', 'Concentrated': 'text-yellow-400', 'Bonds': 'text-teal-400', 'Real-Assets': 'text-amber-400', 'Cash': 'text-dim',
}
export const bucketLabel = (b?: string) => (b && BUCKET_LABEL[b as Bucket]) || b || ''

export const DEFAULT_CONFIG: SystemConfig = {
  targets: {
    // v2 two-level: equity sub-buckets sum to 70; Bonds/Real-Assets/Cash complete the asset-allocation layer.
    'Core-Index': 30,
    'Core-Quality': 25,
    'Growth': 12,
    'Speculative': 3,
    'Concentrated': 0,
    'Bonds': 15,
    'Real-Assets': 8,
    'Cash': 7,
  },
  single_name_cap: 10,
  speculative_cap: 5,
  trail_stops: {
    'Core-Index':   null,  // disabled — buy-and-hold; stops cause sell-low behaviour
    'Core-Quality': 28,    // wide — needs room for quarterly volatility in quality names
    'Growth':       20,    // moderate — volatile but real businesses underneath
    'Speculative':  15,    // tight — cut early before small bets go to zero
    'Concentrated': null,  // thesis-driven (NOW: hold to $200+) — price rule wrong here
    'Bonds':        null,  // diversifier sleeve — buy-and-hold
    'Real-Assets':  null,  // diversifier sleeve — buy-and-hold
    'Cash':         null,  // n/a
  },
  weights: {
    // Each row sums to 100. Tune to match how you actually pick stocks in that category.
    'Core-Index':   { value: 25, quality: 25, momentum: 25, safety: 25 }, // market; rarely scored
    'Core-Quality': { value: 25, quality: 40, momentum: 15, safety: 20 }, // quality of business dominates
    'Growth':       { value: 20, quality: 25, momentum: 40, safety: 15 }, // trajectory + momentum
    'Speculative':  { value: 15, quality: 20, momentum: 50, safety: 15 }, // momentum / narrative plays
    'Concentrated': { value: 30, quality: 40, momentum: 15, safety: 15 }, // thesis-driven: value + quality
    'Bonds':        { value: 25, quality: 25, momentum: 25, safety: 25 }, // diversifier; not equity-scored
    'Real-Assets':  { value: 25, quality: 25, momentum: 25, safety: 25 }, // diversifier; not equity-scored
    'Cash':         { value: 25, quality: 25, momentum: 25, safety: 25 }, // placeholder; rarely scored
  },
  strong_threshold: 75,
  watch_threshold: 60,
  eur_usd: 1.1429,
  rules_text: [
    'Asset allocation (v2, the dominant decision): target 70% equity / 15% bonds / 8% real assets / 7% cash. NOW-trim proceeds fund the bond & real-asset sleeves first — diversification across asset classes, not just stocks.',
    'Core-satellite (within equities): a low-cost diversified core (index + quality) plus size-capped satellites for active bets.',
    'New money goes first to the most-underweight bucket.',
    'No single name above the cap (ex core-index). 5% = watch/no-adds.',
    'Speculative: each ticket small; total under the speculative cap; never average down.',
    'Rebalance on the 5/25 rule; review twice a year. No decisions on a price move alone.',
    'Every buy/sell needs a logged rule + rationale (process over outcomes).',
  ].join('\n'),
}

// Leon's current portfolio (seed). Prices are entry/cost basis; live prices come from FMP.
export const SEED_HOLDINGS = [
  { ticker: 'NOW', name: 'ServiceNow', bucket: 'Concentrated', currency: 'USD', shares: 1470, entry_price: 93.69941176, notes: 'Sonja owns 70.25' },
  { ticker: 'ASML.AS', name: 'ASML Holding', bucket: 'Core-Quality', currency: 'EUR', shares: 15, entry_price: 682.733333 },
  { ticker: 'VWRL.AS', name: 'Vanguard FTSE All-World', bucket: 'Core-Index', currency: 'EUR', shares: 134, entry_price: 76.501641 },
  { ticker: 'NVDA', name: 'NVIDIA', bucket: 'Core-Quality', currency: 'USD', shares: 100, entry_price: 49.559 },
  { ticker: 'SHOP', name: 'Shopify', bucket: 'Growth', currency: 'USD', shares: 100, entry_price: 96.68 },
  { ticker: 'VST', name: 'Vistra', bucket: 'Growth', currency: 'USD', shares: 43, entry_price: 125.4967 },
  { ticker: 'LLY', name: 'Eli Lilly', bucket: 'Core-Quality', currency: 'USD', shares: 6, entry_price: 773.01 },
  { ticker: 'ABNB', name: 'Airbnb', bucket: 'Growth', currency: 'USD', shares: 45, entry_price: 181.415384 },
  { ticker: 'WM', name: 'Waste Management', bucket: 'Core-Quality', currency: 'USD', shares: 25, entry_price: 207.63 },
  { ticker: 'SOUN', name: 'SoundHound AI', bucket: 'Speculative', currency: 'USD', shares: 627, entry_price: 7.96866 },
  { ticker: 'TSLA', name: 'Tesla', bucket: 'Growth', currency: 'USD', shares: 9, entry_price: 36.133333 },
  { ticker: 'NIO', name: 'NIO', bucket: 'Speculative', currency: 'USD', shares: 605, entry_price: 7.497351 },
  { ticker: 'NU', name: 'Nu Holdings', bucket: 'Growth', currency: 'USD', shares: 201, entry_price: 12.57 },
  { ticker: 'MU', name: 'Micron', bucket: 'Core-Quality', currency: 'USD', shares: 1, entry_price: 930 },
  { ticker: 'GRAB', name: 'Grab Holdings', bucket: 'Speculative', currency: 'USD', shares: 304, entry_price: 3.54 },
  { ticker: 'CPNG', name: 'Coupang', bucket: 'Growth', currency: 'USD', shares: 45, entry_price: 23.18 },
  { ticker: 'TTMI', name: 'TTM Technologies', bucket: 'Speculative', currency: 'USD', shares: 3, entry_price: 173 },
  { ticker: 'VOYG', name: 'Voyager Technologies', bucket: 'Speculative', currency: 'USD', shares: 13, entry_price: 45 },
  { ticker: 'RGTI', name: 'Rigetti', bucket: 'Speculative', currency: 'USD', shares: 22, entry_price: 26.01 },
  { ticker: 'QBTS', name: 'D-Wave Quantum', bucket: 'Speculative', currency: 'USD', shares: 19, entry_price: 29.29 },
  { ticker: 'IONQ', name: 'IonQ', bucket: 'Speculative', currency: 'USD', shares: 8, entry_price: 64 },
  { ticker: 'RKLB', name: 'Rocket Lab', bucket: 'Speculative', currency: 'USD', shares: 4, entry_price: 135 },
  { ticker: 'LUNR', name: 'Intuitive Machines', bucket: 'Speculative', currency: 'USD', shares: 15, entry_price: 39 },
] as const
