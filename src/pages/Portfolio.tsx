import { useEffect, useState } from 'react'
import { getConfig, listHoldings, seedHoldings, deleteHolding, upsertHolding, listTransactions, listCorporateActions, listScores, feedTimestamps, addScore } from '../lib/db'
import { Freshness } from '../components/Freshness'
import { getPricesWithChange, refreshPrices, autoScore, screen, refreshFundamentals } from '../lib/prices'
import { buildRows, type Row } from '../lib/portfolio'
import { reconcile, type ReconRow } from '../lib/reconcile'
import { DEFAULT_CONFIG, SEED_HOLDINGS, bucketLabel, ASSET_CLASSES } from '../lib/defaults'
import { AllocationVsTarget } from '../components/AllocationVsTarget'
import { BucketTag } from '../components/BucketTag'
import { Collapsible } from '../components/Collapsible'
import type { SystemConfig, Holding, Bucket, ScoreRecord } from '../lib/types'
import { fmtMoney, fmtPct, fmtNum, cSym, verdictChip, fmtDate } from '../lib/format'
import { useSort } from '../lib/useSort'
import { Th } from '../components/Th'
import { TickerModal } from '../components/TickerModal'
import { parseScoreNote, scoreSrc } from '../lib/analysis'
import { G } from '../lib/glossary'

const BUCKETS: Bucket[] = ['Core-Index', 'Core-Quality', 'Growth', 'Speculative', 'Concentrated', 'Bonds', 'Real-Assets', 'Cash']

/**
 * Parse a score note for data-quality signals.
 * - lowConf: key financial metrics were missing; fallback defaults used
 * - fmpOnly: momentum/safety derived from beta + 1Y return (no Massive price history)
 */
function parseConf(note?: string): { lowConf: boolean; missing: string; fmpOnly: boolean } {
  if (!note) return { lowConf: false, missing: '', fmpOnly: false }
  const lowConf = note.includes('low-conf:')
  const m = note.match(/low-conf:\s*missing ([^|]+)/)
  const missing = m ? m[1].trim() : ''
  const fmpOnly = note.includes('src FMP') || (note.includes('(beta/') && !note.includes('Massive'))
  return { lowConf, missing, fmpOnly }
}

export default function Portfolio() {
  const [cfg, setCfg] = useState<SystemConfig>(DEFAULT_CONFIG)
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [scoreMap, setScoreMap] = useState<Record<string, ScoreRecord>>({})
  const [recon, setRecon] = useState<ReconRow[]>([])
  const [showRecon, setShowRecon] = useState(false)
  const [bucketFilter, setBucketFilter] = useState('All')
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({})
  const [entryEdits, setEntryEdits] = useState<Record<string, string>>({})
  const [scoring, setScoring] = useState<Record<string, 'busy' | 'done' | 'error'>>({})
  const [feeds, setFeeds] = useState<{ prices: string | null; fundamentals: string | null; universe: string | null }>({ prices: null, fundamentals: null, universe: null })
  const shown = bucketFilter === 'All' ? rows : rows.filter(r => r.bucket === bucketFilter)
  const sort = useSort<Row>(shown, 'composite', 'desc')
  const reconSort = useSort<ReconRow>(recon) // no initial key → keeps reconcile()'s status-priority order until a header is clicked
  const bucketsPresent = BUCKETS.filter(b => rows.some(r => r.bucket === b))
  // Target mix derived live from cfg.targets (same grouping the chart uses) so the label can't drift from Rules.
  const targetMix = ASSET_CLASSES.map(cls => cls.buckets.reduce((s, b) => s + (cfg.targets[b] || 0), 0)).join(' / ')
  // Holdings whose latest score used the Finnhub proxy. Now that Yahoo bars cover non-US listings too,
  // any name here just needs a market-data refresh (Massive for US, Yahoo for .AS/.KS/.KQ) to get real risk metrics.
  const finnhubHoldings = rows.filter(r => scoreSrc(scoreMap[r.ticker]?.note) === 'Finnhub').map(r => r.ticker)

  async function load() {
    const [c, h, p, tx, acts, allScores, fts] = await Promise.all([
      getConfig(), listHoldings(), getPricesWithChange(), listTransactions(), listCorporateActions(), listScores(), feedTimestamps()
    ])
    setCfg(c); setHoldings(h); setFeeds(fts)
    const { rows, totalEur } = buildRows(h, p, c)
    // Build latest-score-per-ticker map (scores come back desc by date)
    const sm: Record<string, ScoreRecord> = {}
    for (const s of allScores) { if (!sm[s.ticker]) sm[s.ticker] = s }
    setScoreMap(sm)
    // Enrich rows with score data so Score/Verdict columns are sortable
    const enriched = rows.map(r => ({
      ...r,
      composite: sm[r.ticker]?.composite,
      scoreVerdict: sm[r.ticker]?.verdict,
    }))
    setRows(enriched); setTotal(totalEur)
    setRecon(tx.length ? reconcile(tx, h, acts) : [])
  }
  useEffect(() => { load() }, [])

  async function applyRecon(r: ReconRow) {
    const h = holdings.find(x => x.id === r.holdingId)
    if (!h || r.txAvgCost == null) return
    await upsertHolding({ ...h, shares: r.txShares, entry_price: r.txAvgCost })
    await load()
  }

  async function doRefresh() {
    setBusy('Refreshing prices…')
    const res = await refreshPrices(rows.map(r => r.ticker))
    setBusy(res.ok ? '' : `Price refresh failed: ${res.error}`)
    await load()
  }
  async function doSeed() { setBusy('Loading portfolio…'); await seedHoldings(SEED_HOLDINGS as unknown as Holding[]); setBusy(''); await load() }
  // Per-row full score for a single holding (same guards as the Screener: won't bury a better score, skips identical).
  async function scoreHolding(r: Row) {
    setScoring(prev => ({ ...prev, [r.ticker]: 'busy' }))
    try {
      const res = await screen({ mode: 'tickers', tickers: [{ ticker: r.ticker, bucket: r.bucket }] })
      const x = res.results?.[0]
      if (!res.ok || !x || x.error) throw new Error(x?.error || res.error || 'No result')
      const existing = scoreMap[r.ticker]
      const exSrc = scoreSrc(existing?.note)
      const degradeVsReal = x.src === 'Finnhub' && (exSrc === 'Massive' || exSrc === 'Yahoo')
      const degradeVsConf = !!x.lowConf?.length && !!existing && !/low-conf/i.test(existing.note ?? '')
      const identical = existing && existing.composite === x.composite && existing.value === x.value && existing.quality === x.quality && existing.momentum === x.momentum && existing.safety === x.safety
      if (!degradeVsReal && !degradeVsConf && !identical) {
        await addScore({ ticker: x.ticker, value: x.value, quality: x.quality, momentum: x.momentum, safety: x.safety, composite: x.composite, verdict: x.verdict, note: `From portfolio ${fmtDate(new Date().toISOString())} | ${x.bucket}${x.weights ? ' ' + x.weights : ''}${x.method ? ` | ${x.method}` : ''} | src ${x.src}${x.lowConf?.length ? ` | low-conf: missing ${x.lowConf.join(', ')}` : ''}` })
      }
      await load()
      setScoring(prev => ({ ...prev, [r.ticker]: 'done' }))
      setTimeout(() => setScoring(prev => { const n = { ...prev }; delete n[r.ticker]; return n }), 2000)
    } catch {
      setScoring(prev => ({ ...prev, [r.ticker]: 'error' }))
      setTimeout(() => setScoring(prev => { const n = { ...prev }; delete n[r.ticker]; return n }), 3000)
    }
  }
  // Refresh the fundamentals + risk-metric cache (Finnhub fundamentals + Massive/Yahoo vol/mom/dd).
  // Paced in small batches to respect the free API limits, so loop until the backlog is drained.
  async function doRefreshData() {
    let total = 0, refreshed = 0
    setBusy('Refreshing market data… respects free API limits, ~1 min per few tickers.')
    for (let guard = 0; guard < 15; guard++) {
      const res = await refreshFundamentals(4)
      if (!res.ok) { setBusy(`Refresh market data failed: ${res.error}`); return }
      total = res.total ?? total
      refreshed += res.refreshed?.length ?? 0
      if ((res.remaining ?? 0) <= 0) break
      setBusy(`Refreshing market data… ${total - (res.remaining ?? 0)}/${total} tickers.`)
    }
    // Fundamentals only re-fetch when >12h stale (the nightly job keeps them fresh), so a manual
    // click often has nothing to pull — say so explicitly instead of a vague "up to date".
    setBusy(
      refreshed > 0
        ? `Refreshed ${refreshed} ticker${refreshed > 1 ? 's' : ''}. Now click Auto-score holdings.`
        : 'Fundamentals already current — nothing to refresh. (A manual pull only fetches data older than 12h; the nightly job keeps it fresh.)'
    )
    await load()
  }
  async function doAutoScore() {
    setBusy('Auto-scoring holdings…')
    const res = await autoScore()
    if (!res.ok) { setBusy(`Auto-score failed: ${res.error}`); return }
    setBusy(
      `Scored ${res.scored} holdings, skipped ${res.skipped} (index/cash — no stock rubric)` +
      (res.keptMassive?.length ? `. Kept the Massive-backed score for ${res.keptMassive.join(', ')} (cache lacks Massive data right now)` : '') +
      (res.uncached?.length ? `. ${res.uncached.length} not cached yet (${res.uncached.join(', ')}) — click Refresh market data first.` : '.')
    )
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-navy">Portfolio</h1>
        <div className="flex gap-2">
          <button className="btn-ghost border border-slate-300" onClick={doRefresh}>&#8635; Refresh prices</button>
          <button className="btn-ghost border border-slate-300" onClick={doRefreshData}>&#x27F3; Refresh market data</button>
          <button className="btn-ghost border border-slate-300" onClick={doAutoScore}>&#x21BB; Auto-score holdings</button>
          {rows.length === 0 && <button className="btn-primary" onClick={doSeed}>Load my current portfolio</button>}
        </div>
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <Freshness label="Prices" at={feeds.prices} staleHours={24} />
        <Freshness label="Fundamentals" at={feeds.fundamentals} staleHours={168} />
        <span className="text-[11px] text-dim" title="USD per 1 EUR, used for all € conversions. Live ECB rate, refreshed when you refresh prices.">EUR/USD {cfg.eur_usd ? cfg.eur_usd.toFixed(4) : '—'}</span>
        <Freshness label="FX" at={cfg.eur_usd_at ?? null} staleHours={72} />
      </div>
      {finnhubHoldings.length > 0 && (
        <div className="text-[12px] text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
          ⚠ {finnhubHoldings.length} holding{finnhubHoldings.length > 1 ? 's' : ''} scored on the Finnhub proxy (no price history at scoring time): <span className="font-medium">{finnhubHoldings.join(', ')}</span>. Momentum &amp; Safety came from beta + 52-week return, which tends to flatter low-beta names. Run <span className="font-medium">Refresh market data</span> on the Score tab, then Auto-score, to move them onto real risk metrics.
        </div>
      )}
      {busy && <div className="text-sm text-dim">{busy}</div>}
      <p className="text-xs text-dim">Tip: click a column header to sort, filter by Bucket, or click a ticker for details.</p>

      {rows.length > 0 && (
        <Collapsible id="portfolio-allocation" title="Allocation vs target" subtitle={`· actual vs target (${targetMix})`}>
          <AllocationVsTarget rows={rows} cfg={cfg} onBucket={setBucketFilter} />
          <p className="text-[11px] text-dim mt-3">Equity sub-buckets are grouped under Equities (bold = asset-class subtotal). Bar = actual · line = target. Red = over-allocated, amber = under-allocated. Click a row to filter the table below.</p>
        </Collapsible>
      )}

      {/* Mobile: condensed holding cards */}
      <div className="md:hidden space-y-2">
        {sort.sorted.map(r => {
          const sc = scoreMap[r.ticker]
          const verdictColor = sc ? verdictChip(sc.verdict) : ''
          const up = r.changePct != null && r.changePct >= 0
          const dir = r.changePct == null ? '' : up ? 'text-green-400' : 'text-red-400'
          return (
            <button key={r.id || r.ticker} onClick={() => setSel(r.ticker)} className="card w-full text-left flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-[#e6edf3]">{r.ticker} <span className="text-[10px] font-normal align-middle ml-1"><BucketTag bucket={r.bucket} /></span></div>
                {r.name && <div className="text-[11px] text-dim truncate">{r.name}</div>}
                <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                  <span className="text-[#e6edf3]">{fmtMoney(r.valueEur)}</span>
                  <span className={r.retPct >= 0 ? 'text-green-400' : 'text-red-400'}>{r.retPct >= 0 ? '+' : ''}{fmtPct(r.retPct, 0)}</span>
                  {sc && <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${verdictColor}`}>{sc.composite} {sc.verdict}</span>}
                  {(() => {
                    if (r.trailStop == null || r.pctToStop == null) return null
                    const triggered = r.pctToStop <= 0, near = r.pctToStop > 0 && r.pctToStop < 5
                    if (!triggered && !near) return null
                    return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${triggered ? 'bg-red-900/50 text-red-300' : 'bg-amber-900/40 text-amber-300'}`}>{triggered ? '⚠ Stop hit' : '⚠ Near stop'}</span>
                  })()}
                </div>
              </div>
              <div className={`text-right shrink-0 ${dir}`}>
                <div className="flex items-center justify-end gap-1 font-medium">
                  {r.changePct != null && <span className="text-[10px]">{up ? '▲' : '▼'}</span>}
                  <span className="text-sm"><span className="text-dim text-[10px]">{cSym(r.currency)}</span>{fmtNum(r.price)}</span>
                </div>
                {r.changePct != null && <div className="text-[10px]">{up ? '+' : ''}{r.changePct.toFixed(2)}%</div>}
              </div>
            </button>
          )
        })}
        {sort.sorted.length === 0 && <div className="card text-sm text-dim">No holdings.</div>}
      </div>

      <div className="card overflow-x-auto hidden md:block">
        <table className="w-full min-w-[960px]">
          <thead><tr>
            <Th<Row> label="Ticker" k="ticker" sort={sort} tip={G.ticker} />
            <Th<Row> label="Bucket" k="bucket" sort={sort} tip={G.bucket} filter={
              <select className="filter-select" value={bucketFilter} onChange={e => setBucketFilter(e.target.value)}>
                <option value="All">All</option>
                {bucketsPresent.map(b => <option key={b} value={b}>{bucketLabel(b)}</option>)}
              </select>} />
            <Th<Row> label="Price" k="price" sort={sort} align="right" tip={G.price} />
            <Th<Row> label="Return" k="retPct" sort={sort} align="right" tip={G.ret} />
            <Th<Row> label="Trail Stop" k="pctToStop" sort={sort} align="right" tip={[
              'Trailing stop = high-water mark (max of entry & current price) × (1 − stop%).',
              'Sort ascending to see most at-risk positions first.',
              '',
              'Per-bucket stops (configure in Rules):',
              ...(['Core-Index','Core-Quality','Growth','Speculative','Concentrated','Cash'] as const).map(b => {
                const s = cfg.trail_stops?.[b]
                return `  ${bucketLabel(b)}: ${s != null ? s + '%' : 'disabled'}`
              }),
            ].join('\n')} />
            <Th<Row> label="Shares" k="shares" sort={sort} align="right" tip={G.shares} />
            <Th<Row> label="Entry" k="entry_price" sort={sort} align="right" tip="Average cost (entry) price in the position's native currency — editable. Click to hand-correct; saves on blur." />
            <Th<Row> label="Score" k="composite" sort={sort} align="right" tip={G.composite} />
            <Th<Row> label="Verdict" k="scoreVerdict" sort={sort} tip={G.verdict} />
            <th className="th">Notes</th>
            <th className="th"></th>
          </tr></thead>
          <tbody>
            {sort.sorted.map(r => {
              const sc = scoreMap[r.ticker]
              const verdictColor = sc ? verdictChip(sc.verdict) : ''
              return (
                <tr key={r.id || r.ticker}>
                  <td className="td">
                    <button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(r.ticker)}>{r.ticker}</button>
                    <div className="text-[11px] text-dim">{r.name}</div>
                  </td>
                  <td className="td text-xs">
                    <select
                      className="bg-transparent text-xs text-dim rounded px-1 py-0.5 outline-none cursor-pointer hover:bg-[#21262d]/60 focus:bg-[#21262d] focus:text-[#e6edf3] transition-colors"
                      title="Reassign this holding's bucket"
                      value={r.bucket}
                      onChange={async e => {
                        const h = holdings.find(x => x.id === r.id)
                        if (h) { await upsertHolding({ ...h, bucket: e.target.value as Bucket }); await load() }
                      }}
                    >
                      {BUCKETS.map(b => <option key={b} value={b} className="bg-[#161b22] text-[#e6edf3]">{bucketLabel(b)}</option>)}
                    </select>
                  </td>
                  <td className="td text-right">
                    {(() => {
                      const up = r.changePct != null && r.changePct >= 0
                      const dir = r.changePct == null ? '' : up ? 'text-green-400' : 'text-red-400'
                      return <>
                        <div className={`flex items-center justify-end gap-1 font-medium ${dir}`} title={r.changePct != null ? `Today: ${up ? '+' : ''}${r.changePct.toFixed(2)}%` : 'No intraday change data'}>
                          {r.changePct != null && <span className="text-[11px]">{up ? '▲' : '▼'}</span>}
                          <span><span className="text-dim text-[10px]">{cSym(r.currency)}</span>{fmtNum(r.price)}</span>
                        </div>
                        {r.changePct != null && (
                          <div className={`text-[10px] font-medium ${dir}`}>{up ? '+' : ''}{r.changePct.toFixed(2)}%</div>
                        )}
                      </>
                    })()}
                  </td>
                  <td className={`td text-right ${r.retPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.retPct >= 0 ? '+' : ''}{fmtPct(r.retPct, 0)}</td>
                  {/* Trail stop: just the stop price with color indicator */}
                  <td className="td text-right">
                    {r.trailStop != null ? (() => {
                      const triggered = r.pctToStop! <= 0
                      const near = r.pctToStop! > 0 && r.pctToStop! < 5
                      const stopPct = cfg.trail_stops?.[r.bucket]
                      const hwm = Math.max(r.entry_price, r.price)
                      const color = triggered ? 'text-red-400' : near ? 'text-amber-400' : 'text-green-400'
                      return (
                        <span
                          className={`text-xs font-medium ${color}`}
                          title={`${triggered ? '⚠ TRIGGERED — ' : near ? '⚠ Near — ' : ''}${r.bucket} stop: ${stopPct}% | HWM: ${fmtNum(hwm)} | ${r.pctToStop!.toFixed(1)}% above stop`}
                        >
                          {triggered ? '▼ ' : near ? '⚠ ' : ''}<span className="opacity-70 text-[10px]">{cSym(r.currency)}</span>{fmtNum(r.trailStop)}
                        </span>
                      )
                    })() : (
                      <span className="text-[10px] text-dim italic" title={`Stop disabled for ${r.bucket} — see Rules for rationale`}>off</span>
                    )}
                  </td>
                  <td className="td text-right">{fmtNum(r.shares, 0)}</td>
                  {/* Entry — inline editable cost basis, saves on blur */}
                  <td className="td text-right">
                    <span className="text-dim text-[10px] mr-0.5">{cSym(r.currency)}</span>
                    <input
                      type="number"
                      step="any"
                      className="bg-transparent text-xs text-right w-16 outline-none rounded px-1 py-0.5 hover:bg-[#21262d]/60 focus:bg-[#21262d] focus:text-[#e6edf3] transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      title="Entry (average cost) price — saves on blur"
                      value={entryEdits[r.id ?? r.ticker] ?? String(r.entry_price)}
                      onChange={e => setEntryEdits(prev => ({ ...prev, [r.id ?? r.ticker]: e.target.value }))}
                      onBlur={async e => {
                        const key = r.id ?? r.ticker
                        const clearEdit = () => setEntryEdits(prev => { const n = { ...prev }; delete n[key]; return n })
                        const num = parseFloat(e.target.value)
                        if (e.target.value.trim() === '' || isNaN(num) || num <= 0 || num === r.entry_price) { clearEdit(); return }
                        const h = holdings.find(x => x.id === r.id)
                        if (h) { await upsertHolding({ ...h, entry_price: num }); await load() }
                        clearEdit()
                      }}
                    />
                  </td>
                  {/* Score — sortable via composite field on Row; data-quality indicator when confidence is low */}
                  <td className="td text-right">
                    {sc ? (() => {
                      const { lowConf, missing, fmpOnly } = parseConf(sc.note)
                      const color = lowConf ? 'text-amber-400' : fmpOnly ? 'text-[#8b949e]' : 'text-[#e6edf3]'
                      const tip = [
                        lowConf ? `⚠ Missing data: ${missing}. Fallback defaults used in scoring.` : '',
                        fmpOnly ? '~ Momentum & safety estimated from beta + 1-year return (no Massive price history).' : '',
                      ].filter(Boolean).join(' ')
                      return (
                        <span className={`text-sm font-bold ${color}`} title={tip || undefined}>
                          {lowConf ? '⚠ ' : fmpOnly ? '~ ' : ''}{sc.composite}
                        </span>
                      )
                    })() : <span className="text-dim text-xs" title="No score yet — use the Score button in Watchlist or run Auto-score">—</span>}
                  </td>
                  {/* Verdict — score band + trailing-stop action flag */}
                  <td className="td">
                    {sc ? <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${verdictColor}`}>{sc.verdict}</span> : <span className="text-dim text-xs">—</span>}
                    {(() => {
                      if (r.trailStop == null || r.pctToStop == null) return null
                      const triggered = r.pctToStop <= 0, near = r.pctToStop > 0 && r.pctToStop < 5
                      if (!triggered && !near) return null
                      const stopPct = cfg.trail_stops?.[r.bucket]
                      return <div className="mt-0.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${triggered ? 'bg-red-900/50 text-red-300' : 'bg-amber-900/40 text-amber-300'}`}
                          title={`${r.bucket} trailing stop ${stopPct}% — price is ${Math.abs(r.pctToStop).toFixed(1)}% ${triggered ? 'BELOW the stop (exit/trim trigger)' : 'above the stop'}. Stop level ${cSym(r.currency)}${fmtNum(r.trailStop)}.`}>
                          {triggered ? '⚠ Stop hit' : '⚠ Near stop'}
                        </span>
                      </div>
                    })()}
                    {sc && parseScoreNote(sc.note).method && <div className="text-[10px] text-dim mt-0.5 max-w-[120px] truncate" title={parseScoreNote(sc.note).method}>{parseScoreNote(sc.note).method}</div>}
                  </td>
                  {/* Notes — inline editable, saves on blur */}
                  <td className="td max-w-[200px]">
                    <input
                      className="bg-transparent text-xs text-dim w-full outline-none hover:bg-[#21262d]/60 focus:bg-[#21262d] focus:text-[#e6edf3] rounded px-1 py-0.5 transition-colors placeholder:text-[#484f58]"
                      placeholder="Add note…"
                      title={noteEdits[r.id ?? r.ticker] ?? r.notes ?? undefined}
                      value={noteEdits[r.id ?? r.ticker] ?? r.notes ?? ''}
                      onChange={e => setNoteEdits(prev => ({ ...prev, [r.id ?? r.ticker]: e.target.value }))}
                      onBlur={async e => {
                        const newNote = e.target.value
                        if (newNote === (r.notes ?? '')) {
                          setNoteEdits(prev => { const n = { ...prev }; delete n[r.id ?? r.ticker]; return n })
                          return
                        }
                        const h = holdings.find(x => x.id === r.id)
                        if (h) { await upsertHolding({ ...h, notes: newNote }); await load() }
                        setNoteEdits(prev => { const n = { ...prev }; delete n[r.id ?? r.ticker]; return n })
                      }}
                    />
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    {(() => { const st = scoring[r.ticker]; return (
                      <button disabled={st === 'busy'} title="Run the full per-ticker score (Massive/Yahoo price history) for this holding"
                        className={`text-xs hover:underline disabled:opacity-50 mr-3 ${st === 'done' ? 'text-green-400' : st === 'error' ? 'text-red-400' : 'text-brandblue'}`}
                        onClick={() => scoreHolding(r)}>{st === 'busy' ? '…' : st === 'done' ? '✓' : st === 'error' ? '!' : 'Score'}</button>
                    ) })()}
                    <button className="text-dim hover:text-red-400" title="Remove holding" onClick={() => r.id && deleteHolding(r.id).then(load)}>&#x2715;</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
          {sort.sorted.length > 0 && (
            <tfoot><tr>
              <td className="td font-bold text-dim text-xs" colSpan={11}>
                {sort.sorted.length} positions &middot; {fmtMoney(bucketFilter === 'All' ? total : sort.sorted.reduce((s, r) => s + r.valueEur, 0))}
              </td>
            </tr></tfoot>
          )}
        </table>
      </div>

      {recon.length > 0 && (() => {
        const mism = recon.filter(r => r.status === 'mismatch').length
        const inc = recon.filter(r => r.status === 'incomplete' || r.status === 'extra').length
        const badge: Record<ReconRow['status'], string> = {
          mismatch: 'bg-amber-900/40 text-amber-400', incomplete: 'bg-red-900/40 text-red-400',
          extra: 'bg-blue-900/40 text-blue-400', match: 'bg-green-900/40 text-green-400', closed: 'bg-[#21262d] text-dim',
        }
        return (
          <div className="card">
            <button className="w-full flex items-center justify-between" onClick={() => setShowRecon(s => !s)}>
              <h2 className="font-semibold">Reconcile with transactions</h2>
              <span className="text-sm text-dim">
                {mism > 0 && <span className="text-amber-400 font-medium">{mism} mismatch{mism > 1 ? 'es' : ''}</span>}
                {mism > 0 && inc > 0 && ' · '}
                {inc > 0 && <span className="text-red-400 font-medium">{inc} need review</span>}
                {mism === 0 && inc === 0 && <span className="text-green-400">all reconciled</span>}
                <span className="ml-2">{showRecon ? '▲' : '▼'}</span>
              </span>
            </button>
            {showRecon && (
              <div className="mt-3 overflow-x-auto">
                <p className="text-xs text-dim mb-2">
                  Positions and average cost rebuilt from your imported transactions (splits &amp; listing
                  migrations handled). Average cost is in the native currency, comparable to Entry. "Apply"
                  overwrites that holding's shares + entry price with the transaction-derived figures — only
                  enabled where the imported history is complete. <strong>Incomplete</strong> = sells without
                  matching buys (e.g. NOW: only ServiceNow sell-to-cover rows; the RSU grants were never
                  imported) — these are never auto-applied.
                </p>
                <table className="w-full min-w-[720px] text-sm">
                  <thead><tr>
                    <Th<ReconRow> label="Ticker" k="ticker" sort={reconSort} tip="Stock symbol." />
                    <Th<ReconRow> label="Holding" k="holdingShares" sort={reconSort} align="right" tip="Shares currently recorded in your holdings." />
                    <Th<ReconRow> label="Tx shares" k="txShares" sort={reconSort} align="right" tip="Share count rebuilt from your imported transactions (stock splits and listing migrations applied)." />
                    <Th<ReconRow> label="Tx avg cost" k="txAvgCost" sort={reconSort} align="right" tip="Average cost per share rebuilt from transactions, in the position's native currency — directly comparable to Entry." />
                    <Th<ReconRow> label="Entry" k="holdingEntry" sort={reconSort} align="right" tip="Your holding's recorded entry (average cost) price, native currency." />
                    <Th<ReconRow> label="Status" k="status" sort={reconSort} tip="match = ties out · mismatch = holding differs from transactions · incomplete = history missing (e.g. unimported RSU grants) · extra = in transactions but not in holdings · closed = fully sold (nets to 0). Hover a row for details." />
                    <th className="th"></th>
                  </tr></thead>
                  <tbody>
                    {reconSort.sorted.map(r => (
                      <tr key={r.ticker} title={r.reason || ''}>
                        <td className="td font-semibold">{r.ticker}</td>
                        <td className="td text-right">{r.holdingShares ?? '—'}</td>
                        <td className={`td text-right ${r.status === 'mismatch' ? 'font-bold text-amber-400' : ''}`}>{fmtNum(r.txShares, 2)}</td>
                        <td className="td text-right">{r.txAvgCost != null ? `${cSym(r.currency || 'USD')}${fmtNum(r.txAvgCost)}` : '—'}</td>
                        <td className="td text-right">{r.holdingEntry != null ? fmtNum(r.holdingEntry) : '—'}</td>
                        <td className="td"><span className={`px-2 py-0.5 rounded text-xs ${badge[r.status]}`}>{r.status}</span></td>
                        <td className="td text-right">
                          {(r.status === 'mismatch') && r.holdingId && r.txAvgCost != null
                            ? <button className="text-brandblue hover:underline text-xs" onClick={() => applyRecon(r)}>Apply</button>
                            : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[11px] text-dim mt-2">
                  Estimate from imported history; verify against your broker. Not tax advice.
                </p>
              </div>
            )}
          </div>
        )
      })()}

      {sel && <TickerModal ticker={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
