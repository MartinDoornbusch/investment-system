import { describe, it, expect } from 'vitest'
import { realizedReport } from './realized'
import { reconcile } from './reconcile'
import { toEur } from './portfolio'
import type { Transaction, Holding, CorporateAction } from './types'

// ---- helpers -------------------------------------------------------------
// DeGiro-style buy/sell. total_eur is net of fees; per-share = total_eur / qty.
function deg(date: string, action: 'BUY' | 'SELL', qty: number, perShareEur: number, ticker = 'AAA'): Transaction {
  return { date, ticker, action, quantity: qty, price: perShareEur, currency: 'EUR', total_eur: qty * perShareEur, source: 'DeGiro' }
}
function sn(date: string, gain_loss: number): Transaction {
  return { date, ticker: 'NOW', action: 'SELL', quantity: 1, price: 0, currency: 'USD', gain_loss, source: 'ServiceNow' }
}
function split(ticker: string, effective_date: string, ratio: number, broker_handled = false): CorporateAction {
  return { ticker, effective_date, type: 'split', ratio, broker_handled }
}
function holding(ticker: string, shares: number, entry_price: number, currency = 'EUR'): Holding {
  return { ticker, bucket: 'Growth', currency, shares, entry_price }
}

// ---- toEur (FX) ----------------------------------------------------------
describe('toEur', () => {
  it('passes EUR through unchanged', () => {
    expect(toEur(100, 'EUR', 1.1)).toBe(100)
  })
  it('converts USD to EUR by dividing by eur/usd', () => {
    expect(toEur(114.29, 'USD', 1.1429)).toBeCloseTo(100, 6)
  })
})

// ---- realized P/L --------------------------------------------------------
describe('realizedReport', () => {
  it('computes FIFO realized gain across two buy lots', () => {
    const tx = [
      deg('2024-01-01', 'BUY', 10, 100),
      deg('2024-02-01', 'BUY', 10, 120),
      deg('2024-03-01', 'SELL', 15, 130),
    ]
    const rep = realizedReport(tx)
    expect(rep.review).toHaveLength(0)
    // 10 @ (130-100) + 5 @ (130-120) = 300 + 50 = 350
    expect(rep.deg[0].realizedEur).toBeCloseTo(350, 6)
    expect(rep.deg[0].soldQty).toBeCloseTo(15, 6)
    expect(rep.degTotalEur).toBeCloseTo(350, 6)
  })

  it('applies a manual forward split to open lots before a later sell', () => {
    const tx = [
      deg('2024-01-01', 'BUY', 10, 100),   // lot: 10 @ 100
      deg('2024-06-01', 'SELL', 20, 60),   // post 2:1 split: 20 shares @ 60
    ]
    const acts = [split('AAA', '2024-03-01', 2)] // 2:1 -> lot becomes 20 @ 50
    const rep = realizedReport(tx, acts)
    expect(rep.review).toHaveLength(0)          // NOT quarantined
    expect(rep.deg[0].realizedEur).toBeCloseTo(200, 6) // (60-50)*20
    expect(rep.deg[0].soldQty).toBeCloseTo(20, 6)
  })

  it('without the split action the same sell is flagged incomplete (guards the fix)', () => {
    const tx = [
      deg('2024-01-01', 'BUY', 10, 100),
      deg('2024-06-01', 'SELL', 20, 60),
    ]
    const rep = realizedReport(tx) // no actions passed
    expect(rep.review.some(r => r.ticker === 'AAA')).toBe(true)
  })

  it('sums ServiceNow explicit gain/loss separately', () => {
    const rep = realizedReport([sn('2024-05-01', 500), sn('2024-05-02', -120)])
    expect(rep.snUsd).toBeCloseTo(380, 6)
    expect(rep.snCount).toBe(2)
  })

  it('quarantines a position whose sells exceed imported buys', () => {
    const rep = realizedReport([deg('2024-01-01', 'SELL', 5, 100)])
    expect(rep.review.some(r => /exceed/.test(r.reason))).toBe(true)
    expect(rep.deg).toHaveLength(0)
  })
})

// ---- reconcile -----------------------------------------------------------
describe('reconcile', () => {
  it('rebuilds shares and average cost and matches the holding', () => {
    const tx = [deg('2024-01-01', 'BUY', 10, 100), deg('2024-02-01', 'BUY', 10, 120)]
    const rows = reconcile(tx, [holding('AAA', 20, 110)])
    const r = rows.find(x => x.ticker === 'AAA')!
    expect(r.txShares).toBeCloseTo(20, 6)
    expect(r.txAvgCost).toBeCloseTo(110, 6) // (10*100 + 10*120)/20
    expect(r.status).toBe('match')
  })

  it('applies a manual split ratio to reconciled shares and average cost', () => {
    const tx = [deg('2024-01-01', 'BUY', 10, 100)]
    const rows = reconcile(tx, [holding('AAA', 20, 50)], [split('AAA', '2024-03-01', 2)])
    const r = rows.find(x => x.ticker === 'AAA')!
    expect(r.txShares).toBeCloseTo(20, 6)   // 10 * 2
    expect(r.txAvgCost).toBeCloseTo(50, 6)  // total cost 1000 / 20
  })

  it('flags a sells-only position as incomplete', () => {
    const rows = reconcile([deg('2024-01-01', 'SELL', 5, 100)], [holding('AAA', 0, 0)])
    const r = rows.find(x => x.ticker === 'AAA')!
    expect(r.status).toBe('incomplete')
  })
})
