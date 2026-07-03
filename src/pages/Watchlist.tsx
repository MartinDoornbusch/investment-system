import { useEffect, useMemo, useRef, useState } from 'react'
import { listWatch, addWatch, updateWatch, deleteWatch, addScore, upsertHolding, listScores, listHoldings, feedTimestamps } from '../lib/db'
import { Freshness } from '../components/Freshness'
import { WATCH_REASONS, WATCH_REASON_DESC, profileBucket } from '../lib/defaults'
import { getPricesWithChange, screen, tickerDetail, autoScore } from '../lib/prices'
import type { WatchItem, Bucket, ScoreRecord, Holding } from '../lib/types'
import type { TickerProfile } from '../lib/prices'
import { TickerModal } from '../components/TickerModal'
import { BucketTag } from '../components/BucketTag'
import { Th } from '../components/Th'
import { useSort } from '../lib/useSort'
import { parseScoreNote, scoreSrc } from '../lib/analysis'
import { G } from '../lib/glossary'
import { fmtDate, fmtNum, verdictText, verdictChip } from '../lib/format'
import { readNameCache, writeNameCache } from '../lib/nameCache'

/** Auto-assign bucket from profile (sector/market cap). Override order: portfolio > watchlist > heuristic. */
function profileToBucket(ticker: string, profile: TickerProfile, holdingBuckets: Record<string, Bucket>, watchItems: WatchItem[]): Bucket {
  if (holdingBuckets[ticker]) return holdingBuckets[ticker]
  const existing = watchItems.find(w => w.ticker === ticker)
  if (existing?.bucket) return existing.bucket
  return profileBucket(ticker, profile)
}

function ScoreBadge({ sc }: { sc: ScoreRecord }) {
  const method = parseScoreNote(sc.note).method
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-bold text-[#e6edf3]">{sc.composite}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${verdictChip(sc.verdict)}`}>{sc.verdict}</span>
      </div>
      {method && <div className="text-[10px] text-dim mt-0.5 max-w-[130px] truncate" title={method}>{method}</div>}
    </div>
  )
}

const vColor = verdictText
const BLANK: WatchItem = { ticker: '', thesis: '', reasons: [], bucket: 'Growth' }

/** Toggleable reason tags. `selected` = array of WATCH_REASONS keys. */
function ReasonEditor({ selected, onToggle }: { selected: string[]; onToggle: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {WATCH_REASONS.map(r => {
        const on = selected.includes(r.key)
        return (
          <button key={r.key} type="button" title={r.desc} onClick={() => onToggle(r.key)}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${on ? 'bg-brandblue/20 text-brandblue border-brandblue/40' : 'bg-[#161b22] text-dim border-[#21262d] hover:border-[#484f58]'}`}>
            {r.label}
          </button>
        )
      })}
    </div>
  )
}

/** Read-only pills for the selected reasons. */
function ReasonPills({ reasons }: { reasons?: string[] }) {
  if (!reasons || reasons.length === 0) return <span className="text-dim text-xs">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {reasons.map(k => WATCH_REASON_DESC[k] && (
        <span key={k} title={WATCH_REASON_DESC[k]} className="text-[10px] px-1.5 py-0.5 rounded bg-brandblue/15 text-brandblue border border-brandblue/30">
          {WATCH_REASONS.find(r => r.key === k)?.label ?? k}
        </span>
      ))}
    </div>
  )
}

export default function Watchlist() {
  const [watch, setWatch] = useState<WatchItem[]>([])
  const [prices, setPrices] = useState<Record<string, { price: number; changePct: number | null }>>({})
  const [scores, setScores] = useState<Record<string, ScoreRecord>>({})
  const [holdings, setHoldings] = useState<Set<string>>(new Set())
  const [holdingBuckets, setHoldingBuckets] = useState<Record<string, Bucket>>({})
  const [scoring, setScoring] = useState<Record<string, 'busy' | 'done' | 'error'>>({})
  const [names, setNames] = useState<Record<string, string>>(readNameCache)
  const [sel, setSel] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)   // thesis being edited
  const [editVal, setEditVal] = useState('')
  const [reasonsOpen, setReasonsOpen] = useState<string | null>(null)  // row whose reason editor is open
  const [pricesAt, setPricesAt] = useState<string | null>(null)
  const [autoMsg, setAutoMsg] = useState('')

  const [w, setW] = useState<WatchItem>(BLANK)
  const [formPrice, setFormPrice] = useState<number | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const detailTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cacheName(ticker: string, name: string) {
    setNames(prev => { const u = { ...prev, [ticker]: name }; writeNameCache(u); return u })
  }
  async function loadWatch() {
    const [wl, p, sc, hs, fts] = await Promise.all([listWatch(), getPricesWithChange(), listScores(), listHoldings(), feedTimestamps()])
    setWatch(wl); setPrices(p); setPricesAt(fts.prices)
    setHoldings(new Set(hs.map((h: Holding) => h.ticker)))
    const bm: Record<string, Bucket> = {}; hs.forEach((h: Holding) => { bm[h.ticker] = h.bucket }); setHoldingBuckets(bm)
    const latest: Record<string, ScoreRecord> = {}; sc.forEach((s: ScoreRecord) => { if (!latest[s.ticker]) latest[s.ticker] = s }); setScores(latest)
  }
  useEffect(() => { loadWatch() }, [])

  function onTickerChange(raw: string) {
    const t = raw.toUpperCase()
    const currentPrice = prices[t]?.price ?? null
    setFormPrice(currentPrice)
    setW(prev => ({ ...prev, ticker: t, target_buy: prev.target_buy == null && currentPrice != null ? Math.round(currentPrice * 0.9 * 100) / 100 : prev.target_buy }))
    if (detailTimer.current) clearTimeout(detailTimer.current)
    if (t.length < 1) { setLookingUp(false); return }
    detailTimer.current = setTimeout(async () => {
      setLookingUp(true)
      try {
        const detail = await tickerDetail(t)
        if (detail.ok && detail.profile) {
          if (detail.profile.name) cacheName(t, detail.profile.name)
          const bucket = profileToBucket(t, detail.profile, holdingBuckets, watch)
          setW(prev => prev.ticker === t ? { ...prev, bucket } : prev)
        }
      } finally { setLookingUp(false) }
    }, 700)
  }

  async function runAutoScore() {
    setAutoMsg('Auto-scoring holdings…')
    const res = await autoScore()
    if (!res.ok) { setAutoMsg(`Auto-score failed: ${res.error}`); return }
    setAutoMsg(
      `Scored ${res.scored} holdings, skipped ${res.skipped} (index/speculative)` +
      (res.unchanged?.length ? `. ${res.unchanged.length} unchanged (identical to last score)` : '') +
      (res.keptMassive?.length ? `. Kept the Massive-backed score for ${res.keptMassive.join(', ')} (cache lacks Massive data right now)` : '') +
      (res.uncached?.length ? `. ${res.uncached.length} not cached yet (${res.uncached.join(', ')}) — run Refresh market data on the Score tab first.` : '.')
    )
    await loadWatch()
  }
  async function addItem() { if (!w.ticker) return; await addWatch(w); setW(BLANK); setFormPrice(null); await loadWatch() }
  function patchLocal(id: string, patch: Partial<WatchItem>) { setWatch(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x)) }
  async function saveThesis(item: WatchItem) {
    const val = editVal.trim(); setEditId(null)
    if (!item.id || (item.thesis ?? '') === val) return
    patchLocal(item.id, { thesis: val }); await updateWatch(item.id, { thesis: val })
  }
  async function toggleReason(item: WatchItem, key: string) {
    if (!item.id) return
    const cur = item.reasons ?? []
    const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
    patchLocal(item.id, { reasons: next }); await updateWatch(item.id, { reasons: next })
  }
  function formToggleReason(key: string) {
    setW(prev => { const cur = prev.reasons ?? []; return { ...prev, reasons: cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key] } })
  }
  async function toPortfolio(ticker: string, bucket?: Bucket) {
    await upsertHolding({ ticker, bucket: (bucket || 'Growth') as Bucket, currency: 'USD', shares: 0, entry_price: 0 }); await loadWatch()
  }
  async function scoreItem(item: WatchItem) {
    setScoring(prev => ({ ...prev, [item.ticker]: 'busy' }))
    try {
      const res = await screen({ mode: 'tickers', tickers: [{ ticker: item.ticker, bucket: item.bucket || 'Growth' }] })
      const r = res.results?.[0]
      if (!res.ok || !r || r.error) throw new Error(r?.error || res.error || 'No result')
      if (r.name) cacheName(r.ticker, r.name)
      // Skip an identical re-score, and don't let a degraded run (Finnhub proxy, or missing fundamentals) bury a better score.
      const existing = scores[r.ticker]
      const exSrc = scoreSrc(existing?.note)
      const degrade = (r.src === 'Finnhub' && (exSrc === 'Massive' || exSrc === 'Yahoo')) || (!!r.lowConf?.length && !!existing && !/low-conf/i.test(existing.note ?? ''))
      const identical = existing && existing.composite === r.composite && existing.value === r.value && existing.quality === r.quality && existing.momentum === r.momentum && existing.safety === r.safety
      if (!degrade && !identical) {
        await addScore({ ticker: r.ticker, value: r.value, quality: r.quality, momentum: r.momentum, safety: r.safety, composite: r.composite, verdict: r.verdict, note: `Watchlist score ${fmtDate(new Date().toISOString())} | ${r.bucket || item.bucket}${r.weights ? ' ' + r.weights : ''}${r.method ? ` | ${r.method}` : ''} | src ${r.src}${r.lowConf?.length ? ` | low-conf: missing ${r.lowConf.join(', ')}` : ''}` })
        await loadWatch()
      }
      setScoring(prev => ({ ...prev, [item.ticker]: 'done' }))
      setTimeout(() => setScoring(prev => { const n = { ...prev }; delete n[item.ticker]; return n }), 2000)
    } catch {
      setScoring(prev => ({ ...prev, [item.ticker]: 'error' }))
      setTimeout(() => setScoring(prev => { const n = { ...prev }; delete n[item.ticker]; return n }), 3000)
    }
  }

  const formScore = w.ticker ? scores[w.ticker] : undefined

  // Enriched rows so derived columns (price, score, distance-to-target) are sortable.
  type WRow = WatchItem & { _price: number | null; _change: number | null; _score: number | null; _verdict: string; _pct: number | null }
  const rows = useMemo<WRow[]>(() => watch.map(item => {
    const e = prices[item.ticker]; const px = e?.price ?? null
    const sc = scores[item.ticker]
    const pct = item.target_buy != null && px != null ? (px / item.target_buy - 1) * 100 : null
    return { ...item, _price: px, _change: e?.changePct ?? null, _score: sc?.composite ?? null, _verdict: sc?.verdict ?? '', _pct: pct }
  }), [watch, prices, scores])
  const { sorted, key, dir, onSort } = useSort<WRow>(rows, '_score', 'desc')
  const sortP = { key, dir, onSort }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-navy">Watchlist</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <Freshness label="Prices" at={pricesAt} staleHours={24} />
          <button className="btn-ghost border border-border disabled:opacity-50" onClick={runAutoScore}>&#x21BB; Auto-score holdings</button>
        </div>
      </div>
      {autoMsg && <p className="text-xs text-dim">{autoMsg}</p>}

      <div className="card">
        {/* Add form — bucket is auto-assigned */}
        <div className="bg-[#161b22] rounded-lg p-3 mb-4 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <div className="md:col-span-1">
              <input className="input w-full" placeholder="Ticker" value={w.ticker} onChange={e => onTickerChange(e.target.value)} />
            </div>
            <input className="input md:col-span-2" placeholder="Thesis" value={w.thesis} onChange={e => setW({ ...w, thesis: e.target.value })} />
            <div>
              <input className="input w-full" type="number" placeholder="Buy target" title="The price at which you'd want to buy. Alert fires when current price drops to this level."
                value={w.target_buy ?? ''} onChange={e => setW({ ...w, target_buy: e.target.value ? +e.target.value : undefined })} />
              {formPrice != null && w.target_buy == null && (
                <button className="text-[10px] text-brandblue hover:underline mt-0.5 pl-1" onClick={() => setW({ ...w, target_buy: Math.round(formPrice * 0.9 * 100) / 100 })}>
                  ↳ suggest {fmtNum(Math.round(formPrice * 0.9 * 100) / 100)} (−10%)
                </button>
              )}
            </div>
            <button className="btn-primary md:col-span-2" onClick={addItem}>Add to watchlist</button>
          </div>
          <div className="flex items-start gap-2 pl-1">
            <span className="text-[11px] text-dim pt-1 shrink-0">Why watch:</span>
            <ReasonEditor selected={w.reasons ?? []} onToggle={formToggleReason} />
          </div>
          {w.ticker && (
            <div className="text-[11px] text-dim pl-1 flex flex-wrap gap-3">
              {lookingUp ? <span className="animate-pulse">Looking up {w.ticker}…</span> : <>
                {names[w.ticker] && <span className="text-[#e6edf3]">{names[w.ticker]}</span>}
                <span>Bucket: <BucketTag bucket={w.bucket} /></span>
                {formPrice != null && <span>Price: <span className="text-[#e6edf3] font-medium">{fmtNum(formPrice)}</span></span>}
                {formScore && <span className={`font-medium ${vColor(formScore.verdict)}`}>{formScore.composite} · {formScore.verdict}</span>}
              </>}
            </div>
          )}
          <p className="text-[10px] text-dim">Bucket is auto-assigned from company profile (sector + market cap). Buy target = the price you want to buy at; the alert fires when price drops to it.</p>
        </div>

        {/* Mobile: condensed watch cards */}
        <div className="md:hidden space-y-2">
          {sorted.map(item => {
            const entry = prices[item.ticker]
            const px = entry?.price
            const changePct = entry?.changePct ?? null
            const sc = scores[item.ticker]
            const hit = item.target_buy != null && px != null && px <= item.target_buy
            const scoreSt = scoring[item.ticker]
            const pctToTarget = item.target_buy != null && px != null ? (px / item.target_buy - 1) * 100 : null
            return (
              <div key={item.id} className="card">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold"><button className="text-brandblue hover:underline" onClick={() => setSel(item.ticker)}>{item.ticker}</button><span className="text-[10px] font-normal ml-1.5"><BucketTag bucket={item.bucket} /></span></div>
                    {names[item.ticker] && <div className="text-[11px] text-dim truncate">{names[item.ticker]}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    {px != null ? <div className="text-sm text-[#e6edf3]">{fmtNum(px)}{changePct != null && <span className={`ml-1 text-[10px] font-medium ${changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{changePct >= 0 ? '▲' : '▼'}{Math.abs(changePct).toFixed(1)}%</span>}</div> : <span className="text-dim text-xs">—</span>}
                    {sc && <div className={`text-[10px] font-medium ${vColor(sc.verdict)}`}>{sc.composite} · {sc.verdict}</div>}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[#21262d]">
                  <div className="text-[11px] min-w-0">
                    {item.target_buy != null && <span className="text-dim" title={(item as any).target_note || undefined}>target {fmtNum(item.target_buy)} · </span>}
                    {item.target_buy != null
                      ? (hit ? <span className="text-green-400 font-medium">▼ buy reached</span>
                        : px != null ? <span className="text-amber-400">{pctToTarget!.toFixed(0)}% above</span>
                          : <span className="text-dim">—</span>)
                      : <span className="text-dim">no target</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs shrink-0">
                    <button disabled={scoreSt === 'busy'} className={`hover:underline disabled:opacity-50 ${scoreSt === 'done' ? 'text-green-400' : scoreSt === 'error' ? 'text-red-400' : 'text-brandblue'}`} onClick={() => scoreItem(item)}>{scoreSt === 'busy' ? '…' : scoreSt === 'done' ? '✓' : scoreSt === 'error' ? '!' : 'Score'}</button>
                    {holdings.has(item.ticker) ? <span className="text-[10px] text-dim italic">held</span> : <button className="text-brandblue hover:underline" onClick={() => toPortfolio(item.ticker, item.bucket)}>→ Add</button>}
                    <button className="text-dim hover:text-red-400" onClick={() => item.id && deleteWatch(item.id).then(loadWatch)}>✕</button>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-[#21262d] space-y-1.5">
                  {reasonsOpen === item.id
                    ? <ReasonEditor selected={item.reasons ?? []} onToggle={k => toggleReason(item, k)} />
                    : <button type="button" className="text-left w-full" onClick={() => setReasonsOpen(item.id ?? null)}><ReasonPills reasons={item.reasons} /></button>}
                  {editId === item.id
                    ? <textarea autoFocus rows={2} className="input w-full text-xs" value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={() => saveThesis(item)} />
                    : <button type="button" title={item.thesis || undefined} className="text-left text-[11px] text-dim hover:text-[#e6edf3] w-full whitespace-pre-wrap" onClick={() => { setEditId(item.id ?? null); setEditVal(item.thesis ?? '') }}>{item.thesis || <span className="italic">add thesis…</span>}</button>}
                </div>
              </div>
            )
          })}
          {watch.length === 0 && <div className="card text-sm text-dim">Nothing on the watchlist. Add a ticker above, or use the Screener and click ＋Watch.</div>}
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead><tr>
              <Th<WRow> label="Ticker" k="ticker" sort={sortP} tip={G.ticker} />
              <Th<WRow> label="Bucket" k="bucket" sort={sortP} tip={G.bucket} />
              <Th<WRow> label="Buy target" k="target_buy" sort={sortP} align="right" tip={G.buy_target} />
              <Th<WRow> label="Price" k="_price" sort={sortP} tip={G.price} />
              <Th<WRow> label="Signal" k="_pct" sort={sortP} tip={G.signal} />
              <Th<WRow> label="Latest score" k="_score" sort={sortP} tip={G.composite} />
              <th className="th" title="Run the full per-ticker score (Massive-backed) for this name">Score</th>
              <th className="th" title="Add this name to your portfolio as a 0-share holding to fill in later">→ Portfolio</th>
              <th className="th" title={G.reasons}>Reasons</th>
              <Th<WRow> label="Thesis" k="thesis" sort={sortP} tip={G.thesis} />
              <th className="th"></th>
            </tr></thead>
            <tbody>
              {sorted.map(item => {
                const entry = prices[item.ticker]
                const px = entry?.price
                const changePct = entry?.changePct ?? null
                const sc = scores[item.ticker]
                const hit = item.target_buy != null && px != null && px <= item.target_buy
                const scoreSt = scoring[item.ticker]
                const pctToTarget = item.target_buy != null && px != null ? (px / item.target_buy - 1) * 100 : null
                const targetSignal = item.target_buy != null
                  ? hit ? <span className="text-[11px] font-medium text-green-400">▼ Buy price reached</span>
                    : px != null ? <span className="text-[11px] text-amber-400" title={`Price must fall ${pctToTarget!.toFixed(1)}% to reach your Buy target`}>{pctToTarget!.toFixed(0)}% above target</span>
                      : <span className="text-dim text-xs">—</span>
                  : null
                const scoreSignal = sc ? <span className={`text-[11px] font-medium ${vColor(sc.verdict)}`}>{sc.verdict}</span> : null
                return (
                  <tr key={item.id}>
                    <td className="td">
                      <button className="font-semibold text-brandblue hover:underline" onClick={() => setSel(item.ticker)}>{item.ticker}</button>
                      {names[item.ticker] && <div className="text-[11px] text-dim">{names[item.ticker]}</div>}
                    </td>
                    <td className="td text-xs"><BucketTag bucket={item.bucket} /></td>
                    <td className="td text-right">{item.target_buy != null
                      ? <span title={(item as any).target_note || undefined} className={(item as any).target_note ? 'border-b border-dotted border-[#484f58] cursor-help' : ''}>{fmtNum(item.target_buy)}</span>
                      : <span className="text-dim text-xs">—</span>}</td>
                    <td className="td">
                      {px != null ? (
                        <div><span className="text-sm">{fmtNum(px)}</span>
                          {changePct != null && <span className={`ml-1.5 text-[11px] font-medium ${changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{changePct >= 0 ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%</span>}
                        </div>
                      ) : <span className="text-dim text-xs">—</span>}
                    </td>
                    <td className="td">
                      <div className="flex flex-col gap-0.5">
                        {targetSignal}{scoreSignal}
                        {!targetSignal && !scoreSignal && <span className="text-dim text-xs">—</span>}
                      </div>
                    </td>
                    <td className="td">{sc ? <ScoreBadge sc={sc} /> : <span className="text-dim text-xs">none</span>}</td>
                    <td className="td">
                      <button disabled={scoreSt === 'busy'} className={`text-xs hover:underline disabled:opacity-50 ${scoreSt === 'done' ? 'text-green-400' : scoreSt === 'error' ? 'text-red-400' : 'text-brandblue'}`} onClick={() => scoreItem(item)}>
                        {scoreSt === 'busy' ? '…' : scoreSt === 'done' ? '✓ Scored' : scoreSt === 'error' ? '! Failed' : 'Score'}
                      </button>
                    </td>
                    <td className="td">
                      {holdings.has(item.ticker) ? <span className="text-[11px] text-dim italic">in portfolio</span>
                        : <button className="text-xs text-brandblue hover:underline" onClick={() => toPortfolio(item.ticker, item.bucket)}>&#x2192; Add</button>}
                    </td>
                    <td className="td align-top min-w-[150px] max-w-[220px]">
                      {reasonsOpen === item.id
                        ? <div className="space-y-1">
                            <ReasonEditor selected={item.reasons ?? []} onToggle={k => toggleReason(item, k)} />
                            <button className="text-[10px] text-brandblue hover:underline" onClick={() => setReasonsOpen(null)}>done</button>
                          </div>
                        : <button type="button" className="text-left w-full" title="Click to edit reasons" onClick={() => setReasonsOpen(item.id ?? null)}>
                            <ReasonPills reasons={item.reasons} />
                          </button>}
                    </td>
                    <td className="td align-top max-w-[240px]">
                      {editId === item.id
                        ? <textarea autoFocus rows={2} className="input w-full text-xs min-w-[200px]" value={editVal}
                            onChange={e => setEditVal(e.target.value)} onBlur={() => saveThesis(item)} />
                        : <button type="button" title={item.thesis || 'Click to add a thesis'} className="text-left text-xs text-dim hover:text-[#e6edf3] w-full whitespace-pre-wrap"
                            onClick={() => { setEditId(item.id ?? null); setEditVal(item.thesis ?? '') }}>
                            {item.thesis || <span className="italic">add thesis…</span>}
                          </button>}
                    </td>
                    <td className="td align-top"><button className="text-dim hover:text-red-400" onClick={() => item.id && deleteWatch(item.id).then(loadWatch)}>&#x2715;</button></td>
                  </tr>
                )
              })}
              {watch.length === 0 && <tr><td className="td text-dim" colSpan={11}>Nothing on the watchlist. Add a ticker above, or use the Screener and click ＋Watch.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-dim mt-2">Buy target = entry price you want to buy at. Signal turns green when price drops to/below that level. →Add creates a 0-share portfolio holding to fill in later.</p>
      </div>

      {sel && <TickerModal ticker={sel} onClose={() => setSel(null)} />}
    </div>
  )
}
