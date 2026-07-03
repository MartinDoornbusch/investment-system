export type Bucket = 'Core-Index' | 'Core-Quality' | 'Growth' | 'Speculative' | 'Concentrated' | 'Bonds' | 'Real-Assets' | 'Cash'

export interface Holding {
  id?: string
  user_id?: string
  ticker: string
  name?: string
  bucket: Bucket
  currency: string
  shares: number
  entry_price: number
  notes?: string
}

export interface PriceRow { ticker: string; price: number; updated_at?: string; change_pct?: number | null; prev_close?: number | null }

export interface ScoreInput {
  value: number      // 0-100
  quality: number    // 0-100
  momentum: number   // 0-100
  safety: number     // 0-100
}

export interface ScoreRecord extends ScoreInput {
  id?: string
  user_id?: string
  ticker: string
  composite: number
  verdict: string
  note?: string
  created_at?: string
}

export interface WatchItem {
  id?: string
  user_id?: string
  ticker: string
  thesis?: string
  reasons?: string[]      // WATCH_REASONS keys — structured "why I'm watching"
  target_buy?: number
  target_note?: string
  bucket?: Bucket
  created_at?: string
}

// Cached fundamentals (Finnhub + Massive) — margins/returns/growth are already percentages.
export interface Fundamentals {
  ticker: string
  beta?: number; roic?: number; opm?: number; gm?: number; netm?: number
  pe?: number; peg?: number; ps?: number; de?: number; fcf_yield?: number; rev_growth?: number
  ret1y?: number; mom?: number; vol?: number; dd?: number
  market_cap?: number; sector?: string; updated_at?: string
}

export interface JournalEntry {
  id?: string
  user_id?: string
  date: string
  action: 'BUY' | 'SELL' | 'TRIM' | 'ADD' | 'NOTE'
  ticker: string
  weight_pct?: number
  score?: number
  rule?: string
  rationale?: string
}

export interface SystemConfig {
  targets: Record<Bucket, number>      // percentages summing ~100
  single_name_cap: number              // %
  speculative_cap: number              // %
  trail_stops: Record<Bucket, number | null>  // % below high-water mark per bucket; null = disabled
  weights: Record<Bucket, ScoreInput>  // scoring pillar weights per bucket (each should sum to 100)
  strong_threshold: number             // composite >= -> strong
  watch_threshold: number              // composite >= -> watch
  eur_usd: number
  eur_usd_at?: string                  // ISO timestamp of the last live-FX update (set by refresh-prices)
  rules_text: string
}

export interface Transaction {
  id?: string
  date: string
  ticker?: string
  name?: string
  isin?: string
  exchange?: string
  action: string
  quantity: number
  price: number
  currency: string
  value_eur?: number
  fx?: number
  fees_eur?: number
  total_eur?: number
  order_id?: string
  source?: string
  cost_basis?: number
  proceeds?: number
  gain_loss?: number
}

export interface CorporateAction {
  id?: string
  user_id?: string
  ticker: string
  effective_date: string        // YYYY-MM-DD; ratio applies to shares held on/before this date
  type: 'split' | 'reverse_split' | 'other'
  ratio: number                 // new shares per old (5 = 5:1 forward; 0.5 = 1-for-2 reverse)
  broker_handled?: boolean      // true = already encoded in the broker feed (e.g. DeGiro pair) -> informational, NOT re-applied by reconcile
  note?: string
  created_at?: string
}
