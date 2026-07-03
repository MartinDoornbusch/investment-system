import type { Holding, SystemConfig, Bucket } from './types'

export interface Row extends Holding {
  price: number
  valueNative: number
  valueEur: number
  weight: number
  retPct: number
  changePct: number | null    // today's price change %
  trailStop: number | null    // stop level; null = disabled for this bucket
  pctToStop: number | null    // +ve = above stop, −ve = triggered; null = disabled
  composite?: number          // latest composite score (populated from scoreMap in Portfolio)
  scoreVerdict?: string       // latest verdict string
}

export function toEur(value: number, currency: string, eurUsd: number) {
  return currency === 'EUR' ? value : value / eurUsd
}

export function buildRows(
  holdings: Holding[],
  prices: Record<string, number> | Record<string, { price: number; changePct: number | null }>,
  cfg: SystemConfig
): { rows: Row[]; totalEur: number } {
  const rows = holdings.map(h => {
    // Accept both plain price map and enriched price map
    const priceEntry = (prices as Record<string, any>)[h.ticker]
    const price = typeof priceEntry === 'object' ? priceEntry.price : (priceEntry ?? h.entry_price)
    const changePct: number | null = typeof priceEntry === 'object' ? (priceEntry.changePct ?? null) : null
    const valueNative = price * h.shares
    const valueEur = toEur(valueNative, h.currency, cfg.eur_usd)
    const retPct = h.entry_price ? (price / h.entry_price - 1) * 100 : 0

    // Per-bucket trailing stop — null means disabled for this bucket
    const stopPct = cfg.trail_stops?.[h.bucket] ?? null
    const highWaterMark = Math.max(h.entry_price, price)
    const trailStop = stopPct != null ? highWaterMark * (1 - stopPct / 100) : null
    const pctToStop = trailStop != null && price > 0 ? ((price / trailStop) - 1) * 100 : null

    return { ...h, price, valueNative, valueEur, weight: 0, retPct, changePct, trailStop, pctToStop }
  })
  const totalEur = rows.reduce((s, r) => s + r.valueEur, 0) || 1
  rows.forEach(r => { r.weight = (r.valueEur / totalEur) * 100 })
  rows.sort((a, b) => b.valueEur - a.valueEur)
  return { rows, totalEur }
}

export function bucketWeights(rows: Row[], totalEur: number): Record<string, number> {
  const m: Record<string, number> = {}
  rows.forEach(r => { m[r.bucket] = (m[r.bucket] || 0) + r.valueEur })
  Object.keys(m).forEach(k => { m[k] = (m[k] / (totalEur || 1)) * 100 })
  return m
}

export interface Alert { level: 'warn' | 'info'; text: string }

export function alerts(rows: Row[], bw: Record<string, number>, cfg: SystemConfig): Alert[] {
  const out: Alert[] = []
  // Single-name cap breaches
  rows.forEach(r => {
    if (r.bucket !== 'Core-Index' && r.weight > cfg.single_name_cap)
      out.push({ level: 'warn', text: `${r.ticker} is ${r.weight.toFixed(1)}% — above the ${cfg.single_name_cap}% single-name cap. Trim toward target.` })
  })
  // Speculative cap
  const spec = bw['Speculative'] || 0
  if (spec > cfg.speculative_cap) out.push({ level: 'warn', text: `Speculative bucket is ${spec.toFixed(1)}% — above the ${cfg.speculative_cap}% cap.` })
  // Trailing stop triggers (only for buckets where stop is enabled)
  rows.forEach(r => {
    if (r.pctToStop != null && r.pctToStop < 0) {
      const stopPct = cfg.trail_stops?.[r.bucket]
      out.push({ level: 'warn', text: `${r.ticker} trailing stop triggered: price ${r.price.toFixed(2)} is ${Math.abs(r.pctToStop).toFixed(1)}% below the ${stopPct}% ${r.bucket} stop level (${r.trailStop!.toFixed(2)}).` })
    }
  })
  // Allocation drift (5/25 rule)
  ;(Object.keys(cfg.targets) as Bucket[]).forEach(b => {
    const cur = bw[b] || 0; const tgt = cfg.targets[b]
    const drift = cur - tgt
    if (tgt > 0 && Math.abs(drift) >= 5) out.push({ level: 'info', text: `${b}: ${cur.toFixed(1)}% vs ${tgt}% target (drift ${drift > 0 ? '+' : ''}${drift.toFixed(1)}pt) — 5/25 rebalance trigger.` })
  })
  return out
}
