import type { Transaction, Holding, CorporateAction } from './types'

// Holdings reconciliation: rebuild positions + average cost (native currency) from the
// transaction ledger, then compare to the current holdings.
//
// Corporate actions are handled, not skipped:
//  - A stock SPLIT or listing MIGRATION is booked by brokers as a same-day BUY of the
//    new line + SELL of the old line of (near-)equal cash value but different quantity.
//    Treating that as a real buy+sell would invent cost. Instead we detect the pair and
//    apply it as a RATIO adjustment: shares *= buyQty/sellQty, total cost unchanged
//    (so average cost /= ratio). A 1:1 ratio (migration / ISIN change) is a no-op.
//  - Average cost is computed in NATIVE currency (the `price` column) so it is directly
//    comparable to a holding's entry_price.
//
// IMPORTANT: a position whose imported history has only sells (no buys) — e.g. NOW, where
// the RSU grants were never imported and only the ServiceNow sell-to-cover rows exist — is
// flagged INCOMPLETE and must NOT be auto-applied.

export type ReconStatus = 'mismatch' | 'incomplete' | 'extra' | 'match' | 'closed'

export interface ReconRow {
  ticker: string
  txShares: number
  txAvgCost: number | null   // native currency, comparable to holding.entry_price
  currency: string | null
  holdingShares: number | null
  holdingEntry: number | null
  holdingId?: string
  bucket?: string
  status: ReconStatus
  reason?: string
}

const EQ = 0.02 // 2% value tolerance for detecting a split/migration pair

function valueOf(t: Transaction): number {
  return Math.abs(t.total_eur ?? t.value_eur ?? (t.price * t.quantity))
}

export function reconcile(tx: Transaction[], holdings: Holding[], actions: CorporateAction[] = []): ReconRow[] {
  const byTicker: Record<string, Transaction[]> = {}
  tx.forEach(t => { const k = t.ticker; if (k) (byTicker[k] ||= []).push(t) })
  const actByTicker: Record<string, CorporateAction[]> = {}
  actions.forEach(a => { (actByTicker[a.ticker] ||= []).push(a) })
  const hmap: Record<string, Holding> = {}
  holdings.forEach(h => { hmap[h.ticker] = h })

  const tickers = new Set<string>([...Object.keys(byTicker), ...holdings.map(h => h.ticker)])
  const rows: ReconRow[] = []

  for (const tk of tickers) {
    const trs = (byTicker[tk] || []).slice().sort((a, b) => a.date.localeCompare(b.date))
    const onlySells = trs.length > 0 && !trs.some(r => r.action === 'BUY')
    // RSU grants / rights are booked with no purchase price; their cost basis (FMV at vest)
    // is not in the source, and granted units != net shares delivered. Such a position can
    // never be safely auto-applied.
    const costIncomplete = trs.some(r => r.action === 'BUY' && (r.price ?? 0) === 0)

    // index same-day rows so we can find split/migration pairs
    const byDay: Record<string, number[]> = {}
    trs.forEach((r, i) => { (byDay[r.date] ||= []).push(i) })
    const consumed = new Set<number>()

    // Manual corporate actions (splits the broker feed doesn't carry, e.g. NOW). Applied as
    // dated checkpoints: shares *= ratio, total cost unchanged (so average cost /= ratio).
    // Forward splits use ratio>1, reverse splits 0<ratio<1.
    // Skip broker_handled actions: those splits are already in the trade feed (e.g. DeGiro
    // same-day pair) and applying the ratio again would double-count. They stay listed in the
    // UI for completeness but are not re-applied here.
    const acts = (actByTicker[tk] || []).filter(a => !a.broker_handled).slice().sort((a, b) => a.effective_date.localeCompare(b.effective_date))
    let ai = 0, actionApplied = false

    let shares = 0, totalCost = 0 // native
    const applyActionsThrough = (date: string) => {
      while (ai < acts.length && acts[ai].effective_date <= date) {
        const a = acts[ai++]
        if (shares !== 0 && a.ratio > 0) { shares *= a.ratio; actionApplied = true }
      }
    }
    for (let i = 0; i < trs.length; i++) {
      applyActionsThrough(trs[i].date)
      if (consumed.has(i)) continue
      const r = trs[i]
      // find an unconsumed, same-day, opposite-action row of (near) equal cash value
      let pair = -1
      for (const j of byDay[r.date]) {
        if (j === i || consumed.has(j)) continue
        const o = trs[j]
        if (o.action === r.action) continue
        const rv = valueOf(r), ov = valueOf(o), mx = Math.max(rv, ov)
        if (mx > 0 && Math.abs(rv - ov) / mx < EQ) { pair = j; break }
      }
      if (pair >= 0) {
        const o = trs[pair]
        const buy = r.action === 'BUY' ? r : o
        const sell = r.action === 'BUY' ? o : r
        const ratio = sell.quantity > 0 ? buy.quantity / sell.quantity : 1
        if (shares > 0 && ratio > 0) {
          shares *= ratio // total cost unchanged -> avg cost re-denominated
        } else {
          // split/migration before any imported buy: seed from the post-action buy side
          shares += buy.quantity; totalCost += buy.quantity * buy.price
        }
        consumed.add(i); consumed.add(pair); continue
      }
      // normal trade (average-cost method)
      const avg = shares > 0 ? totalCost / shares : 0
      if (r.action === 'BUY') { shares += r.quantity; totalCost += r.quantity * r.price }
      else { totalCost -= avg * r.quantity; shares -= r.quantity }
    }
    applyActionsThrough('9999-12-31') // flush splits dated after the last trade

    const txShares = Math.round(shares * 1e6) / 1e6
    const txAvgCost = txShares > 0 ? totalCost / txShares : null
    const h = hmap[tk]
    const holdingShares = h ? Number(h.shares) : null

    let status: ReconStatus
    let reason: string | undefined
    if (onlySells || txShares < -1e-6) {
      status = 'incomplete'; reason = 'sells without matching buys — earlier history / RSU grants not imported'
    } else if (costIncomplete && h) {
      status = 'incomplete'; reason = 'contains zero-price RSU grant / rights lots — units granted ≠ net shares delivered and cost basis (FMV at vest) is not in the source; reconcile manually'
    } else if (!h && Math.abs(txShares) < 1e-6) {
      status = 'closed'
    } else if (!h) {
      status = 'extra'; reason = 'position in transactions but not in holdings'
    } else if (Math.abs(txShares - (holdingShares || 0)) < 1e-6) {
      status = 'match'
    } else if (holdingShares && holdingShares > 0 && txShares > 0 && txShares / holdingShares < 0.5) {
      // imported buys explain less than half the position -> earlier grants/history missing.
      // e.g. NOW: 171 ESPP buys - 50 sells = 121, but the holding is 1,470 (RSU grants not imported).
      status = 'incomplete'; reason = `imported buys cover only ${txShares} of ${holdingShares} shares — earlier grants/history not imported`
    } else {
      status = 'mismatch'; reason = `holding ${holdingShares} vs transactions ${txShares}${actionApplied ? ' (after corporate actions)' : ''}`
    }

    rows.push({
      ticker: tk, txShares, txAvgCost,
      currency: byTicker[tk]?.[0]?.currency || h?.currency || null,
      holdingShares, holdingEntry: h ? Number(h.entry_price) : null,
      holdingId: h?.id, bucket: h?.bucket, status, reason,
    })
  }

  const order: Record<ReconStatus, number> = { mismatch: 0, incomplete: 1, extra: 2, match: 3, closed: 4 }
  rows.sort((a, b) => order[a.status] - order[b.status] || a.ticker.localeCompare(b.ticker))
  return rows
}
