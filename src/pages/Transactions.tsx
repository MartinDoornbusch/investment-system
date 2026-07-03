import { useEffect, useState } from 'react'
import { listTransactions, listCorporateActions, addCorporateAction, deleteCorporateAction } from '../lib/db'
import type { Transaction, CorporateAction } from '../lib/types'
import { useSort } from '../lib/useSort'
import { Th } from '../components/Th'
import { TickerModal } from '../components/TickerModal'
import { Collapsible } from '../components/Collapsible'
import { fmtDate, fmtNum, fmtMoney, cSym } from '../lib/format'
import { G } from '../lib/glossary'
import { realizedReport } from '../lib/realized'

const blankAction: CorporateAction = { ticker: '', effective_date: '', type: 'split', ratio: 0 }

export default function Transactions() {
  const [tx, setTx] = useState<Transaction[]>([])
  const [fTicker, setFTicker] = useState('All')
  const [fAction, setFAction] = useState('All')
  const [fSource, setFSource] = useState('All')
  const [sel, setSel] = useState<string | null>(null)
  const [actions, setActions] = useState<CorporateAction[]>([])
  const [af, setAf] = useState<CorporateAction>(blankAction)
  useEffect(() => { listTransactions().then(setTx); listCorporateActions().then(setActions) }, [])

  async function saveAction() {
    if (!af.ticker || !af.effective_date || !af.ratio) return
    await addCorporateAction({ ...af, ticker: af.ticker.toUpperCase() })
    setAf(blankAction); setActions(await listCorporateActions())
  }
  async function removeAction(id?: string) {
    if (!id) return
    await deleteCorporateAction(id); setActions(await listCorporateActions())
  }

  const uniq = (xs: (string | undefined)[]) => Array.from(new Set(xs.filter(Boolean) as string[])).sort()
  const tickers = uniq(tx.map(t => t.ticker))
  const actionsList = uniq(tx.map(t => t.action))
  const sources = uniq(tx.map(t => t.source))
  const filtered = tx.filter(t =>
    (fTicker === 'All' || t.ticker === fTicker) &&
    (fAction === 'All' || t.action === fAction) &&
    (fSource === 'All' || t.source === fSource))
  const sort = useSort<Transaction>(filtered, 'date', 'desc')
  const fees = tx.reduce((s, t) => s + (t.fees_eur || 0), 0)
  const net = tx.reduce((s, t) => s + (t.total_eur || 0), 0) // negative = net cash invested
  const rep = realizedReport(tx, actions)

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy">Transactions</h1>
      <p className="text-sm text-dim">Your broker trade ledger (imported from DeGiro). This is the factual record — the <b>Journal</b> is for decisions/rationale.</p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="card"><div className="text-xs text-dim">Transactions</div><div className="text-lg font-bold">{tx.length}</div></div>
        <div className="card"><div className="text-xs text-dim">Total fees</div><div className="text-lg font-bold">{fmtMoney(fees)}</div></div>
        <div className="card"><div className="text-xs text-dim">Net invested (buys − sells)</div><div className="text-lg font-bold">{fmtMoney(-net)}</div></div>
      </div>

      <Collapsible id="tx-realized" title="Realized P/L" subtitle="· FIFO, in €, net of fees · estimate, verify vs broker">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="flex justify-between text-sm font-semibold mb-1"><span>DeGiro (closed/partial, €)</span><span className={rep.degTotalEur >= 0 ? 'text-green-400' : 'text-red-400'}>{fmtMoney(rep.degTotalEur)}</span></div>
            <table className="w-full text-sm">
              <tbody>
                {rep.deg.map(r => (
                  <tr key={r.ticker}><td className="td">{r.ticker} <span className="text-[11px] text-dim">({fmtNum(r.soldQty,0)} sold)</span></td><td className={`td text-right ${r.realizedEur >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtMoney(r.realizedEur)}</td></tr>
                ))}
                {rep.deg.length === 0 && <tr><td className="td text-dim">No clean closed trades.</td></tr>}
              </tbody>
            </table>
          </div>
          <div>
            <div className="flex justify-between text-sm font-semibold mb-1"><span>ServiceNow RSU sales ($)</span><span className={rep.snUsd >= 0 ? 'text-green-400' : 'text-red-400'}>{fmtMoney(rep.snUsd, 'USD')}</span></div>
            <p className="text-[11px] text-dim mb-3">{rep.snCount} sell-to-cover lots; broker-reported gain/loss.</p>
            {rep.review.length > 0 && <>
              <div className="text-sm font-semibold mb-1 text-amber-400">Excluded — needs manual review</div>
              <ul className="text-xs text-dim space-y-0.5">
                {rep.review.map(r => <li key={r.ticker}>⚠️ <b>{r.ticker}</b> — {r.reason}</li>)}
              </ul>
            </>}
          </div>
        </div>
        <p className="text-[11px] text-dim mt-3">Method: FIFO matching of buys/sells per ticker in € (DeGiro amounts already net of fees and FX). Names with splits, listing migrations or rights are excluded to avoid corrupting the result — reconcile those against your broker. Not tax advice (NL Box 3 taxes wealth, not realized gains).</p>
      </Collapsible>

      <Collapsible id="tx-corpactions" title="Corporate actions" subtitle="· registry of splits affecting your holdings">
        <p className="text-[11px] text-dim mb-3">A split keeps total value and total cost basis unchanged — it only rescales shares (×ratio) and price (÷ratio). Two kinds: <b>Applied</b> = reconcile rescales your lots (e.g. NOW, held outside DeGiro). <b>In broker feed</b> = already encoded as a DeGiro same-day pair (e.g. NVDA, TSLA) — listed for completeness but <i>not</i> re-applied, to avoid double-counting. Ratio = new shares per old (5 = 5-for-1; 0.5 = 1-for-2 reverse).</p>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
          <div><label className="label">Ticker</label><input className="input" value={af.ticker} onChange={e => setAf({ ...af, ticker: e.target.value.toUpperCase() })} /></div>
          <div><label className="label">Effective date</label><input className="input" type="date" value={af.effective_date} onChange={e => setAf({ ...af, effective_date: e.target.value })} /></div>
          <div><label className="label">Type</label><select className="input" value={af.type} onChange={e => setAf({ ...af, type: e.target.value as CorporateAction['type'] })}><option value="split">split</option><option value="reverse_split">reverse_split</option><option value="other">other</option></select></div>
          <div><label className="label">Ratio</label><input className="input" type="number" step="0.01" value={af.ratio || ''} onChange={e => setAf({ ...af, ratio: +e.target.value })} /></div>
          <div className="md:col-span-1"><label className="label">Note</label><input className="input" value={af.note || ''} onChange={e => setAf({ ...af, note: e.target.value })} /></div>
          <div className="flex items-end"><button className="btn-primary w-full" onClick={saveAction}>Add</button></div>
        </div>
        <label className="flex items-center gap-2 text-xs text-dim mb-3">
          <input type="checkbox" checked={!!af.broker_handled} onChange={e => setAf({ ...af, broker_handled: e.target.checked })} />
          Already in my broker feed (informational — don’t apply in reconcile)
        </label>
        {actions.length > 0 && (
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Ticker</th><th className="th text-left">Effective</th><th className="th text-left">Type</th><th className="th text-right">Ratio</th><th className="th text-left">Status</th><th className="th text-left">Note</th><th className="th"></th></tr></thead>
            <tbody>
              {actions.map(a => (
                <tr key={a.id}>
                  <td className="td font-semibold">{a.ticker}</td>
                  <td className="td whitespace-nowrap">{fmtDate(a.effective_date)}</td>
                  <td className="td">{a.type}</td>
                  <td className="td text-right">{a.ratio}:1</td>
                  <td className="td"><span className={`px-1.5 py-0.5 rounded text-[10px] ${a.broker_handled ? 'bg-[#21262d] text-dim' : 'bg-green-900/40 text-green-400'}`}>{a.broker_handled ? 'in broker feed' : 'applied'}</span></td>
                  <td className="td text-[11px] text-dim">{a.note}</td>
                  <td className="td text-right"><button className="text-dim hover:text-red-600" onClick={() => removeAction(a.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Collapsible>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <h2 className="font-semibold">Trade ledger <span className="text-xs font-normal text-dim">· sort or filter in the column headers, click a ticker for details</span></h2>
        </div>
        {/* Mobile: condensed transaction cards */}
        <div className="md:hidden space-y-2">
          {sort.sorted.map(t => (
            <div key={t.id} className="rounded-lg border border-border bg-surface-2 p-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${t.action === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{t.action}</span>
                  {t.ticker
                    ? <button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(t.ticker!)}>{t.ticker}</button>
                    : <span className="text-dim">—</span>}
                </div>
                <div className="text-[11px] text-dim">{fmtDate(t.date)} · {t.source}</div>
              </div>
              <div className="text-right shrink-0 text-xs">
                <div className="text-[#e6edf3]">{fmtNum(t.quantity, 0)} @ {cSym(t.currency)}{fmtNum(t.price)}</div>
                {t.total_eur != null && <div className={(t.total_eur || 0) >= 0 ? 'text-green-400' : 'text-dim'}>{fmtMoney(t.total_eur)}</div>}
              </div>
            </div>
          ))}
          {tx.length === 0 && <div className="text-sm text-dim">No transactions.</div>}
        </div>

        <table className="w-full min-w-[820px] hidden md:table">
          <thead><tr>
            <Th<Transaction> label="Date" k="date" sort={sort} tip={G.date} />
            <Th<Transaction> label="Ticker" k="ticker" sort={sort} tip={G.ticker} filter={
              <select className="filter-select" value={fTicker} onChange={e => setFTicker(e.target.value)}><option value="All">All</option>{tickers.map(t => <option key={t}>{t}</option>)}</select>} />
            <Th<Transaction> label="Action" k="action" sort={sort} tip={G.tx_action} filter={
              <select className="filter-select" value={fAction} onChange={e => setFAction(e.target.value)}><option value="All">All</option>{actionsList.map(a => <option key={a}>{a}</option>)}</select>} />
            <Th<Transaction> label="Qty" k="quantity" sort={sort} align="right" tip={G.tx_quantity} />
            <Th<Transaction> label="Price" k="price" sort={sort} align="right" tip={G.tx_price} />
            <Th<Transaction> label="Fees (€)" k="fees_eur" sort={sort} align="right" tip={G.fees} />
            <Th<Transaction> label="Total (€)" k="total_eur" sort={sort} align="right" tip={G.tx_total} />
            <Th<Transaction> label="Source" k="source" sort={sort} tip={G.source} filter={
              <select className="filter-select" value={fSource} onChange={e => setFSource(e.target.value)}><option value="All">All</option>{sources.map(s => <option key={s}>{s}</option>)}</select>} />
          </tr></thead>
          <tbody>
            {sort.sorted.map(t => (
              <tr key={t.id}>
                <td className="td whitespace-nowrap">{fmtDate(t.date)}</td>
                <td className="td">{t.ticker
                  ? <button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(t.ticker!)}>{t.ticker}</button>
                  : <span className="text-dim">—</span>}
                  <div className="text-[11px] text-dim">{t.name}</div></td>
                <td className="td"><span className={t.action === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.action}</span></td>
                <td className="td text-right">{fmtNum(t.quantity, 0)}</td>
                <td className="td text-right">{cSym(t.currency)}{fmtNum(t.price)}</td>
                <td className="td text-right text-dim">{t.fees_eur != null ? fmtNum(t.fees_eur) : '—'}</td>
                <td className={`td text-right ${(t.total_eur || 0) >= 0 ? 'text-green-400' : ''}`}>{t.total_eur != null ? fmtMoney(t.total_eur) : <span className="text-dim">—</span>}</td>
                <td className="td text-[11px] text-dim">{t.source}</td>
              </tr>
            ))}
            {tx.length === 0 && <tr><td className="td text-dim" colSpan={8}>No transactions.</td></tr>}
          </tbody>
        </table>
      </div>
      {sel && <TickerModal ticker={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
