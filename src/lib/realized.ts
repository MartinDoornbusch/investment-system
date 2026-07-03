import type { Transaction, CorporateAction } from './types'

// Realized P/L from the transaction ledger.
// - ServiceNow rows carry explicit gain/loss (USD) -> summed directly.
// - DeGiro rows: FIFO in EUR (total_eur is net of fees).
//   Corporate actions are handled two ways:
//     * A broker-recorded split/migration (same-day near-equal BUY+SELL pair) is still
//       quarantined for manual review — the pair is ambiguous and would corrupt FIFO.
//     * A MANUAL split from the corporate_actions table (e.g. a forward split the broker
//       feed didn't carry) is applied as a dated RATIO to the open FIFO lots: each lot's
//       qty *= ratio and per-share cost /= ratio, so the lot's total value is unchanged and
//       a post-split SELL matches post-split lot quantities correctly. Without this, a split
//       between a buy and a later sell matches post-split sell quantities against pre-split
//       lots and produces a badly wrong realized figure.
export interface RealizedRow { ticker: string; realizedEur: number; soldQty: number }
export interface ReviewRow { ticker: string; reason: string }
export interface RealizedReport {
  deg: RealizedRow[]; degTotalEur: number
  review: ReviewRow[]
  snUsd: number; snCount: number
}

function sameDayEqualPair(rows: Transaction[]): boolean {
  const byDate: Record<string, Transaction[]> = {}
  rows.forEach(r => { (byDate[r.date] ||= []).push(r) })
  for (const d in byDate) {
    const g = byDate[d]
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j]
      if (a.action !== b.action) {
        const av = Math.abs(a.total_eur ?? a.value_eur ?? 0), bv = Math.abs(b.total_eur ?? b.value_eur ?? 0)
        const mx = Math.max(av, bv)
        if (mx > 0 && Math.abs(av - bv) / mx < 0.02) return true // split or listing migration
      }
    }
  }
  return false
}

export function realizedReport(tx: Transaction[], actions: CorporateAction[] = []): RealizedReport {
  const deg = tx.filter(t => !(t.source || '').startsWith('ServiceNow'))
  const groups: Record<string, Transaction[]> = {}
  deg.forEach(t => { const k = t.ticker || t.name || '?'; (groups[k] ||= []).push(t) })

  // Manual splits only (broker_handled ones are already in the trade feed as a same-day pair
  // and are quarantined below — re-applying the ratio would double-count).
  const actByTicker: Record<string, CorporateAction[]> = {}
  actions.filter(a => !a.broker_handled && a.ratio > 0)
    .forEach(a => { (actByTicker[a.ticker] ||= []).push(a) })
  Object.values(actByTicker).forEach(list => list.sort((a, b) => a.effective_date.localeCompare(b.effective_date)))

  const out: RealizedRow[] = []; const review: ReviewRow[] = []
  for (const tk of Object.keys(groups)) {
    const rows = groups[tk]
    if (!rows.some(r => r.action === 'SELL')) continue // nothing realized
    if (rows.some(r => (r.price ?? 0) === 0)) { review.push({ ticker: tk, reason: 'rights / 0-price corporate action' }); continue }
    if (sameDayEqualPair(rows)) { review.push({ ticker: tk, reason: 'split or listing migration' }); continue }
    const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date))
    const acts = actByTicker[tk] || []
    let ai = 0
    const lots: { qty: number; cost: number }[] = []
    // Apply any manual split whose effective_date has been reached: re-denominate open lots.
    const applyActionsThrough = (date: string) => {
      while (ai < acts.length && acts[ai].effective_date <= date) {
        const ratio = acts[ai++].ratio
        for (const lot of lots) { lot.qty *= ratio; lot.cost /= ratio }
      }
    }
    let realized = 0, sold = 0, incomplete = false
    for (const r of ordered) {
      applyActionsThrough(r.date)
      const per = Math.abs((r.total_eur ?? r.value_eur ?? 0) / r.quantity)
      if (r.action === 'BUY') lots.push({ qty: r.quantity, cost: per })
      else {
        let q = r.quantity
        while (q > 1e-9 && lots.length) {
          const lot = lots[0]; const m = Math.min(q, lot.qty)
          realized += (per - lot.cost) * m; sold += m; lot.qty -= m; q -= m
          if (lot.qty <= 1e-9) lots.shift()
        }
        if (q > 1e-9) incomplete = true
      }
    }
    if (incomplete) review.push({ ticker: tk, reason: 'sells exceed imported buys (older history)' })
    else out.push({ ticker: tk, realizedEur: realized, soldQty: sold })
  }
  out.sort((a, b) => b.realizedEur - a.realizedEur)
  const sn = tx.filter(t => (t.source || '').startsWith('ServiceNow') && t.action === 'SELL')
  return {
    deg: out, degTotalEur: out.reduce((s, r) => s + r.realizedEur, 0),
    review, snUsd: sn.reduce((s, t) => s + (t.gain_loss || 0), 0), snCount: sn.length,
  }
}
