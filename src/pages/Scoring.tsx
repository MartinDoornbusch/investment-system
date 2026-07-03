import { useEffect, useState } from 'react'
import { getConfig, listScores } from '../lib/db'
import { readNameCache } from '../lib/nameCache'
import { DEFAULT_CONFIG } from '../lib/defaults'
import type { SystemConfig, ScoreRecord } from '../lib/types'
import { useSort } from '../lib/useSort'
import { Th } from '../components/Th'
import { TickerModal } from '../components/TickerModal'
import { fmtDateTime, verdictChip } from '../lib/format'
import { autoScore, refreshFundamentals } from '../lib/prices'
import { parseScoreNote } from '../lib/analysis'
import { G } from '../lib/glossary'

function parseConf(note?: string): { lowConf: boolean; missing: string; fmpOnly: boolean } {
  if (!note) return { lowConf: false, missing: '', fmpOnly: false }
  const lowConf = note.includes('low-conf:')
  const m = note.match(/low-conf:\s*missing ([^|]+)/)
  const missing = m ? m[1].trim() : ''
  const fmpOnly = note.includes('src FMP') || (note.includes('(beta/') && !note.includes('Massive'))
  return { lowConf, missing, fmpOnly }
}

export default function Scoring() {
  const [cfg, setCfg] = useState<SystemConfig>(DEFAULT_CONFIG)
  const [history, setHistory] = useState<ScoreRecord[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [names] = useState<Record<string, string>>(readNameCache)
  const [autoMsg, setAutoMsg] = useState('')
  const [refMsg, setRefMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const sort = useSort<ScoreRecord>(history, 'created_at', 'desc')

  async function load() { setCfg(await getConfig()); setHistory(await listScores()) }
  useEffect(() => { load() }, [])

  async function runAuto() {
    setAutoMsg('Auto-scoring from FMP…')
    const res = await autoScore()
    if (!res.ok) { setAutoMsg(`Failed: ${res.error}`); return }
    setAutoMsg(
      `Scored ${res.scored} holdings, skipped ${res.skipped} (index/speculative)` +
      (res.uncached?.length ? `. ${res.uncached.length} not cached yet (${res.uncached.join(', ')}) — run Refresh market data first.` : '.')
    )
    await load()
  }

  async function runRefresh() {
    setBusy(true); setRefMsg('Refreshing market data… respects free API limits, ~1 min per few tickers.')
    let guard = 0
    while (guard++ < 12) {
      const res = await refreshFundamentals(4)
      if (!res.ok) { setRefMsg('Failed: ' + res.error); setBusy(false); return }
      const done = (res.total ?? 0) - (res.remaining ?? 0)
      setRefMsg(`Refreshed ${done}/${res.total ?? 0} tickers…`)
      if ((res.remaining ?? 0) <= 0) break
    }
    setRefMsg('Market data cache is up to date. Now click Auto-score.')
    setBusy(false)
  }

  // Verdict badge colour (shared helper)
  const vColor = verdictChip

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy">Score History</h1>
      <p className="text-sm text-dim">
        Scores are generated automatically from FMP fundamentals (Auto-score), or manually from the
        Screener &amp; Watchlist tab. Click any ticker to see score trends.
      </p>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">All scores <span className="text-xs font-normal text-dim">· click a header to sort, a ticker for details &amp; trend</span></h2>
          <div className="flex gap-2">
            <button className="btn-ghost border border-border disabled:opacity-50" disabled={busy} onClick={runRefresh}>&#x27F3; Refresh market data</button>
            <button className="btn-ghost border border-border disabled:opacity-50" disabled={busy} onClick={runAuto}>&#x21BB; Auto-score holdings</button>
          </div>
        </div>
        {refMsg && <p className="text-xs text-dim mb-1">{refMsg}</p>}
        {autoMsg && <p className="text-xs text-dim mb-2">{autoMsg}</p>}
        <table className="w-full min-w-[620px]">
          <thead><tr>
            <Th<ScoreRecord> label="Date" k="created_at" sort={sort} tip={G.date} />
            <Th<ScoreRecord> label="Ticker" k="ticker" sort={sort} tip={G.ticker} />
            <Th<ScoreRecord> label="Composite" k="composite" sort={sort} align="right" tip={G.composite} />
            <th className="th" title={G.verdict}>Verdict</th>
            <Th<ScoreRecord> label="V" k="value" sort={sort} align="right" tip={G.value} />
            <Th<ScoreRecord> label="Q" k="quality" sort={sort} align="right" tip={G.quality} />
            <Th<ScoreRecord> label="M" k="momentum" sort={sort} align="right" tip={G.momentum} />
            <Th<ScoreRecord> label="S" k="safety" sort={sort} align="right" tip={G.safety} />
            <th className="th text-left" title={G.note}>Note</th>
          </tr></thead>
          <tbody>
            {sort.sorted.map(s => (
              <tr key={s.id}>
                <td className="td whitespace-nowrap text-dim text-xs">{fmtDateTime(s.created_at)}</td>
                <td className="td">
                  <button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(s.ticker)}>{s.ticker}</button>
                  {names[s.ticker] && <div className="text-[11px] text-dim">{names[s.ticker]}</div>}
                </td>
                <td className="td text-right font-bold">
                  {(() => {
                    const { lowConf, missing, fmpOnly } = parseConf(s.note)
                    const color = lowConf ? 'text-amber-400' : fmpOnly ? 'text-[#8b949e]' : 'text-[#e6edf3]'
                    const tip = [
                      lowConf ? `⚠ Missing data: ${missing}. Fallback defaults used in scoring.` : '',
                      fmpOnly ? '~ Momentum & safety estimated from beta + 1-year return (no Massive price history).' : '',
                    ].filter(Boolean).join(' ')
                    return (
                      <span className={color} title={tip || undefined}>
                        {lowConf ? '⚠ ' : fmpOnly ? '~ ' : ''}{s.composite}
                      </span>
                    )
                  })()}
                </td>
                <td className="td">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${vColor(s.verdict)}`}>{s.verdict}</span>
                  {parseScoreNote(s.note).method && <div className="text-[10px] text-dim mt-0.5 max-w-[120px] truncate" title={parseScoreNote(s.note).method}>{parseScoreNote(s.note).method}</div>}
                </td>
                <td className="td text-right text-dim">{s.value}</td>
                <td className="td text-right text-dim">{s.quality}</td>
                <td className="td text-right text-dim">{s.momentum}</td>
                <td className="td text-right text-dim">{s.safety}</td>
                <td className="td text-xs text-dim max-w-[200px] truncate" title={s.note}>{s.note || '—'}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr><td className="td text-dim" colSpan={9}>No scores yet. Use Screener &amp; Watchlist to score tickers, or click Auto-score to score your holdings automatically.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card flex gap-4 flex-wrap text-xs text-dim">
        <span className="font-medium text-[#e6edf3]">Score thresholds:</span>
        <span>Strong &#x2265; {cfg.strong_threshold}</span>
        <span>Watch &#x2265; {cfg.watch_threshold}</span>
        <span className="ml-auto text-[10px]">Weights are per-bucket — see Rules tab.</span>
      </div>

      {sel && <TickerModal ticker={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
