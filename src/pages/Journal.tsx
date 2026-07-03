import { useEffect, useState } from 'react'
import { listJournal, addJournal, deleteJournal } from '../lib/db'
import type { JournalEntry } from '../lib/types'
import { TickerModal } from '../components/TickerModal'

const ACTIONS: JournalEntry['action'][] = ['BUY', 'SELL', 'TRIM', 'ADD', 'NOTE']

export default function Journal() {
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [j, setJ] = useState<JournalEntry>({ date: new Date().toISOString().slice(0, 10), action: 'BUY', ticker: '' })
  const [sel, setSel] = useState<string | null>(null)

  async function load() { setJournal(await listJournal()) }
  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy">Decision Journal</h1>
      <p className="text-sm text-dim">Log every buy/sell with the rule that triggered it and your rationale — process over outcomes.</p>

      <div className="card">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
          <input className="input" type="date" value={j.date} onChange={e => setJ({ ...j, date: e.target.value })} />
          <select className="input" value={j.action} onChange={e => setJ({ ...j, action: e.target.value as JournalEntry['action'] })}>{ACTIONS.map(a => <option key={a}>{a}</option>)}</select>
          <input className="input" placeholder="Ticker" value={j.ticker} onChange={e => setJ({ ...j, ticker: e.target.value.toUpperCase() })} />
          <input className="input" placeholder="Rule" value={j.rule || ''} onChange={e => setJ({ ...j, rule: e.target.value })} />
          <input className="input" placeholder="Rationale" value={j.rationale || ''} onChange={e => setJ({ ...j, rationale: e.target.value })} />
          <button className="btn-primary" onClick={async () => { if (j.ticker) { await addJournal(j); setJ({ date: new Date().toISOString().slice(0, 10), action: 'BUY', ticker: '' }); load() } }}>Log</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr>{['Date', 'Action', 'Ticker', 'Rule', 'Rationale', ''].map(h => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>
              {journal.map(e => (
                <tr key={e.id}>
                  <td className="td">{e.date}</td><td className="td font-semibold">{e.action}</td>
                  <td className="td"><button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(e.ticker)}>{e.ticker}</button></td>
                  <td className="td text-dim">{e.rule}</td><td className="td text-dim">{e.rationale}</td>
                  <td className="td"><button className="text-dim hover:text-red-400" onClick={() => e.id && deleteJournal(e.id).then(load)}>✕</button></td>
                </tr>
              ))}
              {journal.length === 0 && <tr><td className="td text-dim" colSpan={6}>No entries yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {sel && <TickerModal ticker={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
