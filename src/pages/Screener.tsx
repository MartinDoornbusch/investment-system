import { useEffect, useState } from 'react'
import { addWatch, addScore, listScores, listHoldings, feedTimestamps } from '../lib/db'
import { Freshness } from '../components/Freshness'
import { screen, refreshUniverse, refreshUniverseIntl, getPricesWithChange, refreshPrices } from '../lib/prices'
import type { TickerProfile } from '../lib/prices'
import type { Bucket, ScoreRecord, Holding } from '../lib/types'
import { TickerModal } from '../components/TickerModal'
import { BucketTag } from '../components/BucketTag'
import { bucketLabel, profileBucket } from '../lib/defaults'
import { fmtDate, fmtNum, verdictText, verdictChip } from '../lib/format'
import { readNameCache, writeNameCache } from '../lib/nameCache'
import { scoreSrc } from '../lib/analysis'

const BUCKETS: Bucket[] = ['Core-Quality', 'Growth', 'Speculative', 'Core-Index', 'Concentrated', 'Bonds', 'Real-Assets', 'Cash']
const SECTORS = ['', 'Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical', 'Industrials', 'Energy', 'Utilities', 'Communication Services', 'Consumer Defensive', 'Basic Materials', 'Real Estate']
// International rows come from the TradingView scanner, which uses its own sector taxonomy (not Finnhub's).
const TV_SECTORS = ['', 'Electronic Technology', 'Technology Services', 'Health Technology', 'Health Services', 'Finance', 'Consumer Non-Durables', 'Consumer Durables', 'Consumer Services', 'Retail Trade', 'Producer Manufacturing', 'Process Industries', 'Industrial Services', 'Commercial Services', 'Distribution Services', 'Energy Minerals', 'Non-Energy Minerals', 'Transportation', 'Communications', 'Utilities']
const REGIONS: [string, string][] = [['us', 'US (S&P 1500)'], ['europe', 'Europe (dev., $2B+)']]

// Fallback bucket heuristic (the universe scan now returns a KB-grounded bucket; this only fills gaps).
// Delegates to the shared profileBucket so Screener and Watchlist classify identically.
function fallbackBucket(ticker: string, profile: TickerProfile): Bucket {
  return profileBucket(ticker, profile)
}


// Price with today's up/down marker (matches the Portfolio indicator).
function PriceCell({ p, chg }: { p: number | null; chg: number | null }) {
  if (p == null) return <span className="text-dim text-xs">—</span>
  const up = chg != null && chg >= 0
  const dir = chg == null ? '' : up ? 'text-green-400' : 'text-red-400'
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${dir}`} title={chg != null ? `Today ${up ? '+' : ''}${chg.toFixed(2)}%` : 'No intraday change data'}>
      {chg != null && <span className="text-[11px]">{up ? '▲' : '▼'}</span>}{fmtNum(p)}
    </span>
  )
}

export default function Screener() {
  const [mode, setMode] = useState<'tickers' | 'universe'>('universe')
  const [tickers, setTickers] = useState('')
  const [lens, setLens] = useState<Bucket>('Core-Quality')
  const [filters, setFilters] = useState({ marketCapMoreThan: '', betaLowerThan: '', sector: '', capBand: 'Any', minDollarVol: '' })
  const [region, setRegion] = useState('us')
  const [results, setResults] = useState<any[]>([])
  const [busy, setBusy] = useState('')
  const [uni, setUni] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState('')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [bucketFilter, setBucketFilter] = useState('All')
  const [scores, setScores] = useState<Record<string, ScoreRecord>>({})
  const [prices, setPrices] = useState<Record<string, { price: number; changePct: number | null }>>({})
  const [holdingBuckets, setHoldingBuckets] = useState<Record<string, Bucket>>({})
  const [, setNames] = useState<Record<string, string>>(readNameCache)
  const [universeAt, setUniverseAt] = useState<string | null>(null)

  function cacheName(ticker: string, name: string) {
    setNames(prev => { const u = { ...prev, [ticker]: name }; writeNameCache(u); return u })
  }
  async function loadData() {
    const [sc, hs, fts] = await Promise.all([listScores(), listHoldings(), feedTimestamps()])
    setUniverseAt(fts.universe)
    const latest: Record<string, ScoreRecord> = {}
    sc.forEach((s: ScoreRecord) => { if (!latest[s.ticker]) latest[s.ticker] = s })
    setScores(latest)
    const bm: Record<string, Bucket> = {}
    hs.forEach((h: Holding) => { bm[h.ticker] = h.bucket })
    setHoldingBuckets(bm)
  }
  useEffect(() => { loadData() }, [])
  useEffect(() => {
    setResults([]); setSortKey('')
    // Sector taxonomies differ per region (Finnhub vs TradingView) — a stale selection would silently filter everything out.
    setFilters(f => ({ ...f, sector: '' }))
    if (mode === 'universe') runScreen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, region])

  async function doRefreshUniverse() {
    if (region !== 'us') {
      // International: one scanner pull replaces the whole region — no membership/enrich phases.
      setUni(`Refreshing ${region} universe (TradingView scanner)…`)
      const r = await refreshUniverseIntl(region)
      if (!r.ok) { setUni(`Refresh failed: ${r.error || 'check refresh-universe-intl logs'}`); return }
      setUni(`Universe ready — ${r.written ?? '—'} names (${r.counts?.large ?? '—'} large / ${r.counts?.mid ?? '—'} mid). Auto-refreshes weekly (Sun).`)
      runScreen()
      return
    }
    // 1) Refresh membership (S&P 1500 constituent lists). 2) Enrich a quick sample now; the nightly cron fills the rest.
    setUni('Refreshing membership (S&P 1500)…')
    const m = await refreshUniverse({ step: 'membership' })
    if (!m.ok) { setUni(`Membership refresh failed: ${m.error || 'check function logs'}`); return }
    setUni(`Universe: ${m.upserted ?? '—'} names. Enriching a sample…`)
    let pending = 1, guard = 0
    while (pending > 0 && guard++ < 6) {
      const r = await refreshUniverse({ step: 'enrich', batch: 10 })
      if (!r.ok) { setUni(`Enrichment failed: ${r.error || 'is FINNHUB_API_KEY set?'}`); break }
      pending = r.remaining ?? 0
    }
    setUni(`Universe ready — ${m.upserted ?? ''} names. Fundamentals refresh nightly${pending > 0 ? ` (${pending} still pending)` : ''}.`)
    runScreen()
  }

  async function runScreen(override?: { marketCapMoreThan: string; betaLowerThan: string; sector: string; capBand?: string; minDollarVol?: string }) {
    setBusy('Screening…'); setResults([])
    try {
      if (mode === 'tickers') {
        const list = tickers.split(/[\s,]+/).filter(Boolean).map(t => ({ ticker: t.toUpperCase(), bucket: lens }))
        if (!list.length) { setBusy('Enter one or more tickers.'); return }
        const res = await screen({ mode: 'tickers', tickers: list })
        if (!res || !res.ok) { setBusy(`Failed: ${res?.error || 'No response — check edge function logs'}`); return }
        const r: any[] = res.results || []
        r.forEach(item => { if (item.ticker && item.name) cacheName(item.ticker, item.name) })
        setResults(r)
        // Auto-save the scores and pull a fresh price + today's move for the screened names.
        const ok = r.filter((x: any) => !x.error)
        const { kept, unchanged } = ok.length ? await autoSaveScores(ok) : { kept: [], unchanged: [] }
        const ts = ok.map((x: any) => x.ticker)
        try { if (ts.length) await refreshPrices(ts) } catch { /* price refresh is best-effort */ }
        try { setPrices(await getPricesWithChange()) } catch { /* ignore */ }
        const savedFallback = ok.filter((x: any) => x.src === 'Finnhub' && !kept.includes(x.ticker) && !unchanged.includes(x.ticker)).map((x: any) => x.ticker)
        const savedN = ok.length - kept.length - unchanged.length
        setBusy(r.length === 0 ? 'No results returned.' : ok.length
          ? `Scored & saved ${savedN} ✓`
            + (unchanged.length ? ` · ${unchanged.length} unchanged (identical to last score)` : '')
            + (kept.length ? ` · kept the existing higher-confidence score for ${kept.join(', ')} (this run was degraded — Massive unavailable or fundamentals missing)` : '')
            + (savedFallback.length ? ` · ⚠ ${savedFallback.join(', ')} saved on the Finnhub proxy (no price history) — re-run in ~1 min for real risk metrics` : '')
          : '')
      } else {
        const fil = override ?? filters
        const f: any = { region }
        if (fil.marketCapMoreThan) f.marketCapMoreThan = Number(fil.marketCapMoreThan)
        if (fil.betaLowerThan) f.betaLowerThan = Number(fil.betaLowerThan)
        if (fil.sector) f.sector = fil.sector
        if ((fil as any).capBand && (fil as any).capBand !== 'Any') f.capBand = (fil as any).capBand
        if ((fil as any).minDollarVol) f.minDollarVol = Number((fil as any).minDollarVol)
        const res = await screen({ mode: 'universe', filters: f, perBucket: 10 })
        if (!res || !res.ok) { setBusy(`Universe scan failed: ${res?.error || 'No response'}`); return }
        const r: any[] = res.results || []
        r.forEach(item => { if (item.ticker && item.name) cacheName(item.ticker, item.name) })
        setResults(r)
        setSortKey('quickScore'); setSortDir('desc')   // prioritize by quick score by default
        try { setPrices(await getPricesWithChange()) } catch { /* ignore */ }
        setBusy(r.length === 0 ? 'No results — run Refresh universe, or loosen filters.' : '')
      }
    } catch (e: any) { setBusy(`Error: ${e?.message ?? 'Unexpected error'}`) }
  }

  async function toWatch(ticker: string, bucket?: Bucket) { await addWatch({ ticker, thesis: '', bucket: bucket || lens }) }
  // `kept` = protected a better existing score from a degraded re-score; `unchanged` = identical re-score, skipped.
  async function autoSaveScores(list: any[]): Promise<{ kept: string[]; unchanged: string[] }> {
    const kept: string[] = []; const unchanged: string[] = []
    for (const r of list) {
      if (r.name) cacheName(r.ticker, r.name)
      const existing = scores[r.ticker]
      if (existing) {
        // Protect a better existing score from a degraded re-score: (a) a Finnhub proxy vs an existing
        // real (Massive/Yahoo) score, or (b) a low-confidence run (missing fundamentals) vs an existing full-conf one.
        const exSrc = scoreSrc(existing.note)
        const degradeVsReal = r.src === 'Finnhub' && (exSrc === 'Massive' || exSrc === 'Yahoo')
        const degradeVsConf = !!r.lowConf?.length && !/low-conf/i.test(existing.note ?? '')
        if (degradeVsReal || degradeVsConf) { kept.push(r.ticker); continue }
        // Skip a re-score identical to the latest saved one — avoids piling duplicate rows in the history.
        if (existing.composite === r.composite && existing.value === r.value && existing.quality === r.quality && existing.momentum === r.momentum && existing.safety === r.safety) { unchanged.push(r.ticker); continue }
      }
      await addScore({ ticker: r.ticker, value: r.value, quality: r.quality, momentum: r.momentum, safety: r.safety, composite: r.composite, verdict: r.verdict, note: `From screener ${fmtDate(new Date().toISOString())} | ${r.bucket}${r.weights ? ' ' + r.weights : ''}${r.method ? ` | ${r.method}` : ''} | src ${r.src}${r.lowConf?.length ? ` | low-conf: missing ${r.lowConf.join(', ')}` : ''}` })
    }
    await loadData()
    return { kept, unchanged }
  }

  const isIntl = region !== 'us'
  const COLS: [string, string, string][] = mode === 'tickers'
    ? [['Ticker', 'ticker', 'Stock symbol — click to open full details'], ['Price', '_price', 'Latest price · ▲/▼ = today’s move'], ['Composite', 'composite', 'Weighted 0–100 score across the four pillars (weights depend on the bucket)'], ['Verdict', 'verdict', 'Strong ≥75 · Watchlist 60–74 · Pass <60'], ['V', 'value', 'Value pillar — cheapness vs intrinsic value & peers (PEG, P/E)'], ['Q', 'quality', 'Quality pillar — durability & profitability (ROIC, margins, moat)'], ['M', 'momentum', 'Momentum pillar — 12-minus-1 month price trend'], ['S', 'safety', 'Safety pillar — volatility, drawdown, beta'], ['Src', 'src', 'Source for momentum/safety: Massive price bars, else Finnhub'], ['', '', '']]
    : [
        ['Ticker', 'ticker', 'Stock symbol — click to open full details'], ['Name', 'name', 'Company name'],
        ...(isIntl ? [['Ctry', 'country', 'Country of domicile (region membership follows domicile, not listing venue)'] as [string, string, string]] : []),
        ['P/E', 'pe', 'Price ÷ earnings (TTM). Lower = cheaper vs profits; very high or “—” = expensive or unprofitable'], ['Mkt cap', 'marketCap', 'Market capitalisation = share price × shares outstanding (company size)'], ['Band', 'capBand', 'Market-cap band: large ≥$10B · mid $2–10B · small <$2B. Results show the top 10 per band.'], ['Liq', 'advUsd', isIntl ? 'Average daily dollar volume (USD, ECB FX). Higher = easier to trade without moving the price.' : 'Average daily dollar volume (liquidity). Higher = easier to trade without moving the price. Derived from Finnhub avg volume × price.'], ['Beta', 'beta', 'Volatility vs the market: 1 = moves with it, >1 more volatile, <1 calmer'], ['Sector', 'sector', isIntl ? 'Industry classification (TradingView taxonomy)' : 'Industry classification (from Finnhub)'], ['Bucket', 'bucket', 'Auto-assigned strategy bucket from profitability, ROE, beta & growth — cap-agnostic knowledge-base rules. A heuristic; editable when you add the name'], ['Quick', 'quickScore', isIntl ? 'Quick triage score 0–100. Europe scoring per the international metric proposal: Value = PEG + EV/EBITDA (financials: P/B + ROE), Momentum from 12-1 return, Safety from beta + debt/equity.' : 'Quick triage score 0–100 from cached metrics — same per-bucket pillars as the full score, but momentum from the 52-week return and safety from beta (no live calls). Sort to prioritize, then click Score for the precise Massive-backed composite.'], ['Score', 'savedComposite', 'Your saved composite score for this name, if any — click Score to compute it'], ['', '', ''],
      ]

  function sortBy(k: string) {
    if (!k) return
    if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }
  const enriched: any[] = mode === 'universe'
    ? results.map(r => ({
        ...r,
        bucket: r.bucket ?? holdingBuckets[r.ticker] ?? fallbackBucket(r.ticker, { ticker: r.ticker, market_cap: r.marketCap, industry: r.sector } as TickerProfile),
        savedComposite: scores[r.ticker]?.composite ?? null,
        savedVerdict: scores[r.ticker]?.verdict ?? null,
        savedSrc: scoreSrc(scores[r.ticker]?.note),
      }))
    : results.map(r => ({ ...r, _price: prices[r.ticker]?.price ?? null, _chg: prices[r.ticker]?.changePct ?? null }))
  const filtered = mode === 'universe' && bucketFilter !== 'All' ? enriched.filter(r => r.bucket === bucketFilter) : enriched
  const sortedResults = sortKey
    ? [...filtered].sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      })
    : filtered

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy">Screener</h1>

      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex gap-2">
            <button className={mode === 'universe' ? 'btn-primary' : 'btn-ghost border border-border'} onClick={() => setMode('universe')}>Universe (beta)</button>
            <button className={mode === 'tickers' ? 'btn-primary' : 'btn-ghost border border-border'} onClick={() => setMode('tickers')}>By ticker</button>
          </div>
          {mode === 'universe' && (
            <div className="flex items-center gap-3">
              {uni ? <span className="text-[11px] text-dim">{uni}</span> : <Freshness label="Universe" at={universeAt} staleHours={168} />}
              <button className="btn-ghost border border-border text-xs" onClick={doRefreshUniverse}>↻ Refresh universe</button>
            </div>
          )}
        </div>

        {mode === 'tickers' ? (
          <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
            <input className="input md:col-span-3" placeholder="Tickers, e.g. COST V MA" value={tickers} onChange={e => setTickers(e.target.value)} />
            <select className="input md:col-span-2" value={lens} onChange={e => setLens(e.target.value as Bucket)}>{BUCKETS.map(b => <option key={b} value={b}>{bucketLabel(b)}</option>)}</select>
            <button className="btn-primary" onClick={() => runScreen()}>Screen</button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
              <div><label className="label">Region</label><select className="input" value={region} onChange={e => setRegion(e.target.value)} title="US = S&P 1500 via Finnhub · Europe = developed-Europe large+mid caps via TradingView scanner, refreshed weekly">{REGIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label className="label">Cap band</label><select className="input" value={filters.capBand} onChange={e => setFilters({ ...filters, capBand: e.target.value })}>{([['Any', 'Any band'], ['large', 'Large ≥$10B'], ['mid', 'Mid $2–10B']] as [string, string][]).concat(region === 'us' ? [['small', 'Small <$2B']] : []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label className="label">Min liquidity ($/day)</label><input className="input" value={filters.minDollarVol} onChange={e => setFilters({ ...filters, minDollarVol: e.target.value })} placeholder="e.g. 3000000" title="Minimum average daily dollar volume — filters out thinly-traded names" /></div>
              <div><label className="label">Min market cap ($)</label><input className="input" value={filters.marketCapMoreThan} onChange={e => setFilters({ ...filters, marketCapMoreThan: e.target.value })} placeholder="optional" /></div>
              <div><label className="label">Max beta</label><input className="input" value={filters.betaLowerThan} onChange={e => setFilters({ ...filters, betaLowerThan: e.target.value })} placeholder="e.g. 1.1" /></div>
              <div><label className="label">Sector</label><select className="input" value={filters.sector} onChange={e => setFilters({ ...filters, sector: e.target.value })}>{(region === 'us' ? SECTORS : TV_SECTORS).map(s => <option key={s} value={s}>{s || 'Any'}</option>)}</select></div>
              <div className="flex items-end"><button className="btn-primary w-full" onClick={() => runScreen()}>Run scan</button></div>
            </div>
          </div>
        )}
        {busy && <p className={`text-sm ${busy.startsWith('Error') || busy.startsWith('Failed') || busy.startsWith('Universe scan failed') ? 'text-red-400' : 'text-dim'}`}>{busy}</p>}
        <p className="text-[11px] text-dim">{region === 'us'
          ? 'Universe ranks the S&P 1500 (large + mid + small, from S&P 500 / 400 / 600 constituents, enriched via Finnhub) and returns the top 10 per cap band, auto-bucketed by cap-agnostic KB rules. By-ticker scores any symbol against your bucket rubric (Finnhub+Massive). Use ＋Watch to track a name, or Score to evaluate it.'
          : 'Europe ranks developed-Europe large + mid caps ($2B+, domicile-based, via the TradingView scanner, refreshed weekly) and returns the top 10 per band. Scoring follows the international metric proposal: Value = PEG + EV/EBITDA (financials: P/B + ROE), Momentum = 12-1 return, Safety = beta + debt/equity. Scores use the same absolute bands as US — a 75 means the same thing in both regions — but cross-region accounting differences add noise; compare within region first. Note: ADRs are excluded; check broker availability before acting on a name.'}</p>

        {/* Mobile: condensed result cards */}
        {results.length > 0 && (
          <div className="md:hidden space-y-2">
            {sortedResults.map((r, i) => mode === 'tickers' ? (
              <div key={i} className="card flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <button onClick={() => setSel(r.ticker)} className="font-semibold text-brandblue hover:underline">{r.ticker}</button>
                  {r.name && <div className="text-[11px] text-dim truncate">{r.name}</div>}
                  {r.error ? <div className="text-[11px] text-dim mt-0.5">{r.error}</div> : (
                    <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[#e6edf3]">{r.composite}</span>
                      <span className={verdictText(r.verdict)}>{r.verdict}</span>
                      {r.method && <span className="text-[10px] text-dim">{r.method}</span>}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <PriceCell p={r._price} chg={r._chg} />
                  <div className="mt-1"><button className="text-xs text-brandblue hover:underline" onClick={() => toWatch(r.ticker, r.bucket)}>＋Watch</button></div>
                </div>
              </div>
            ) : (
              <div key={i} className="card flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <button onClick={() => setSel(r.ticker)} className="font-semibold text-brandblue hover:underline">{r.ticker}</button>
                  {r.name && <div className="text-[11px] text-dim truncate">{r.name}</div>}
                  <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                    <BucketTag bucket={r.bucket} />
                    {r.quickScore != null && <span className={`px-1.5 py-0.5 rounded font-semibold ${verdictChip(r.quickVerdict)}`} title={`Scored as ${r.bucket}${r.method ? ' — ' + r.method : ''}${r.weights ? ' · weights ' + r.weights : ''}`}>Q {r.quickScore}</span>}
                    <span className="text-dim">P/E {r.pe != null ? fmtNum(r.pe) : '—'}</span>
                    {r.marketCap ? <span className="text-dim">{fmtNum(r.marketCap / 1e9, 1)}B</span> : null}
                    {r.capBand ? <span className="text-dim capitalize">· {r.capBand}</span> : null}
                    {isIntl && r.country ? <span className="text-dim">· {r.country}</span> : null}
                    {r.savedComposite != null && <span className="font-semibold text-[#e6edf3]">{r.savedComposite}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-1">
                  <button className="text-xs text-brandblue hover:underline" onClick={() => { setLens(r.bucket as Bucket); setMode('tickers'); setTickers(r.ticker) }}>Score</button>
                  <button className="text-xs text-brandblue hover:underline" onClick={() => toWatch(r.ticker, r.bucket)}>＋Watch</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {results.length > 0 && (
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead><tr>
                {COLS.map(([label, key, tip]) => (
                  <th key={label} className={`th align-top ${key ? 'cursor-pointer select-none hover:text-[#e6edf3]' : ''}`} title={tip || undefined} onClick={() => sortBy(key)}>
                    <span>{label}{sortKey === key && key ? <span className="text-brandblue">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span> : ''}{tip ? <span className="ml-0.5 text-dim">ⓘ</span> : null}</span>
                    {key === 'bucket' && (
                      <div className="mt-1 font-normal" onClick={e => e.stopPropagation()}>
                        <select className="filter-select" value={bucketFilter} onChange={e => setBucketFilter(e.target.value)}>
                          <option value="All">All</option>
                          {(['Core-Quality', 'Growth', 'Speculative', 'Core-Index'] as Bucket[]).map(b => <option key={b} value={b}>{bucketLabel(b)}</option>)}
                        </select>
                      </div>
                    )}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {sortedResults.map((r, i) => mode === 'tickers' ? (
                  <tr key={i}>
                    <td className="td">
                      <button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(r.ticker)}>{r.ticker}</button>
                      {r.name && <div className="text-[11px] text-dim">{r.name}</div>}
                    </td>
                    <td className="td"><PriceCell p={r._price} chg={r._chg} /></td>
                    {r.error ? <td className="td text-dim" colSpan={7}>{r.error}</td> : <>
                      <td className="td font-bold">{r.composite}</td>
                      <td className={`td font-medium ${verdictText(r.verdict)}`}>{r.verdict}{r.method && <div className="text-[10px] text-dim font-normal mt-0.5 max-w-[120px] truncate" title={r.method}>{r.method}</div>}</td>
                      <td className="td">{r.value}</td><td className="td">{r.quality}</td><td className="td">{r.momentum}</td><td className="td">{r.safety}</td>
                      <td className="td text-[11px]">{(r.src === 'Massive' || r.src === 'Yahoo')
                        ? <span className="px-1.5 py-0.5 rounded bg-[#21262d] text-dim" title="Momentum & Safety from real daily price history (realized volatility, drawdown, 12-1 momentum). Massive for US names, Yahoo for non-US listings (.AS/.KS/.KQ).">{r.src}</span>
                        : <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300" title="No price history available (Massive and Yahoo both unavailable). Momentum fell back to the 52-week return and Safety to beta — a degraded proxy that tends to flatter low-beta names. Re-run to retry.">~ {r.src} fallback</span>}</td></>}
                    <td className="td whitespace-nowrap">
                      <button className="text-xs text-brandblue hover:underline mr-2" onClick={() => toWatch(r.ticker, r.bucket)}>＋Watch</button>
                      {!r.error && <span className="text-[11px] text-green-400">✓ saved</span>}
                    </td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td className="td"><button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(r.ticker)}>{r.ticker}</button></td><td className="td">{r.name}</td>
                    {isIntl && <td className="td text-[11px] text-dim">{r.country ?? '—'}</td>}
                    <td className="td">{r.pe != null ? fmtNum(r.pe) : '—'}</td>
                    <td className="td">{r.marketCap ? fmtNum(r.marketCap / 1e9, 1) + ' B' : '—'}</td>
                    <td className="td text-[11px] text-dim capitalize">{r.capBand ?? '—'}</td>
                    <td className="td text-[11px] text-dim whitespace-nowrap">{r.advUsd != null ? (r.advUsd >= 1e9 ? '$' + fmtNum(r.advUsd / 1e9, 1) + 'B' : '$' + fmtNum(r.advUsd / 1e6, 0) + 'M') : '—'}</td>
                    <td className="td">{r.beta != null ? fmtNum(r.beta) : '—'}</td>
                    <td className="td text-xs">{r.sector}</td>
                    <td className="td text-xs"><BucketTag bucket={r.bucket} /></td>
                    <td className="td">{r.quickScore != null
                      ? <span className={`font-semibold ${verdictText(r.quickVerdict)}`} title={`Scored as ${r.bucket}${r.method ? ' — ' + r.method : ''}${r.weights ? ' · weights ' + r.weights : ''} · ${r.quickVerdict}. Each bucket uses different pillar formulas and weights, so the same name scores differently in another bucket.`}>{r.quickScore}</span>
                      : <span className="text-dim text-xs">—</span>}</td>
                    <td className="td">{r.savedComposite != null
                      ? <span className="inline-flex items-center gap-1">
                          <span className={`font-semibold ${verdictText(r.savedVerdict)}`} title={r.savedVerdict}>{r.savedComposite}</span>
                          {r.savedSrc === 'Finnhub' && <span className="text-amber-400 text-[10px] cursor-help" title="This saved score used the Finnhub fallback (Massive price history was unavailable): Momentum from the 52-week return, Safety from beta. Tends to flatter low-beta names — click Score to recompute with Massive.">~</span>}
                        </span>
                      : <span className="text-dim text-xs">—</span>}</td>
                    <td className="td whitespace-nowrap">
                      <button className="text-xs text-brandblue hover:underline mr-2" onClick={() => { setLens(r.bucket as Bucket); setMode('tickers'); setTickers(r.ticker) }}>Score</button>
                      <button className="text-xs text-brandblue hover:underline" onClick={() => toWatch(r.ticker, r.bucket)}>＋Watch</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sel && <TickerModal ticker={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
