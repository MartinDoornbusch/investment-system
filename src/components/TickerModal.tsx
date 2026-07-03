import { useEffect, useMemo, useState } from 'react'
import { holdingByTicker, scoresByTicker, getConfig, fundamentalsByTicker } from '../lib/db'
import { getNewsDigest, type NewsDigestItem } from '../lib/feed'
import { getPrices, tickerDetail, type TickerDetail, type NewsItem } from '../lib/prices'
import { aiSummary, fmtMktCap } from '../lib/summary'
import { parseScoreNote, barMetrics, pillarFigures, suggestAction, PILLARS, LOW_WEIGHT_THRESHOLD, methodByName } from '../lib/analysis'
import { PriceChart } from './PriceChart'
import { BucketTag } from './BucketTag'
import { rankNews, rankPeerNews, buildDigestIndex, catTone, type RankedNews } from '../lib/news'
import { Freshness } from './Freshness'
import type { Holding, ScoreRecord, Fundamentals } from '../lib/types'
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct, cSym } from '../lib/format'

type Tab = 'overview' | 'analysis' | 'summary' | 'news'

function SentChip({ s }: { s?: string | null }) {
  if (!s) return null
  const c = s === 'positive' ? 'bg-green-900/40 text-green-400' : s === 'negative' ? 'bg-red-900/40 text-red-400' : 'bg-[#21262d] text-dim'
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${c}`}>{s}</span>
}
function NewsRow({ a }: { a: RankedNews }) {
  const hzTone = a.horizon === 'thesis-change' ? 'bg-red-900/40 text-red-300'
    : a.horizon === 'monitor' ? 'bg-amber-900/40 text-amber-300' : 'bg-[#21262d] text-dim'
  return (
    <a href={a.url} target="_blank" rel="noreferrer" className="flex gap-2 py-2 border-b border-[#21262d] hover:bg-surface-2 rounded px-1 transition-colors">
      {a.image && <img src={a.image} alt="" className="w-14 h-14 object-cover rounded shrink-0" />}
      <div className="min-w-0">
        <div className="text-sm font-medium text-[#e6edf3] line-clamp-2">{a.title}</div>
        <div className="text-[11px] text-dim flex items-center gap-2 mt-0.5 flex-wrap">
          {a.peerTicker && <span className="font-semibold text-brandblue">{a.peerTicker}</span>}
          {a.category && <span className={`px-1.5 py-0.5 rounded text-[10px] ${catTone(a.materiality)}`} title={`${a.category} · ${a.materiality} materiality`}>{a.category}</span>}
          {a.fromDigest && a.horizon && <span className={`px-1.5 py-0.5 rounded text-[10px] ${hzTone}`} title="From your daily AI digest">{a.horizon}</span>}
          {a.fromDigest && a.consensus && a.consensus !== 'unclear' && <span className={`px-1.5 py-0.5 rounded text-[10px] ${a.consensus === 'surprise' ? 'bg-violet-900/40 text-violet-300' : 'bg-[#21262d] text-dim'}`}>{a.consensus}</span>}
          <span>{a.publisher}</span>{a.published && <span>· {fmtDate(a.published)}</span>}<SentChip s={a.sentiment} />
        </div>
        {a.fromDigest && a.actionable && <p className="text-[11px] text-green-400 mt-0.5"><b>Action:</b> {a.actionable}</p>}
      </div>
    </a>
  )
}

export function TickerModal({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const [h, setH] = useState<Holding | null>(null)
  const [scores, setScores] = useState<ScoreRecord[]>([])
  const [price, setPrice] = useState<number | null>(null)
  const [eurUsd, setEurUsd] = useState(1.1429)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<TickerDetail | null>(null)
  const [fund, setFund] = useState<Fundamentals | null>(null)
  const [digestItems, setDigestItems] = useState<NewsDigestItem[]>([])
  const [tab, setTab] = useState<Tab>('overview')
  const [showDesc, setShowDesc] = useState(false)

  useEffect(() => {
    let live = true
    ;(async () => {
      const [hh, ss, prices, cfg, fnd, dg] = await Promise.all([holdingByTicker(ticker), scoresByTicker(ticker), getPrices(), getConfig(), fundamentalsByTicker(ticker), getNewsDigest()])
      if (!live) return
      setH(hh); setScores(ss); setPrice(prices[ticker] ?? null); setEurUsd(cfg.eur_usd || 1.1429); setFund(fnd); setDigestItems(dg.items); setLoading(false)
      const d = await tickerDetail(ticker)
      if (live) setDetail(d)
    })()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { live = false; window.removeEventListener('keydown', onKey) }
  }, [ticker, onClose])

  const latest = scores[0]
  const latestNote = latest ? parseScoreNote(latest.note) : null
  const profile = detail?.profile ?? null
  const digIdx = useMemo(() => buildDigestIndex(digestItems), [digestItems])
  const pill = (label: string, val?: number) => (
    <div className="rounded-lg bg-surface-2 border border-border p-2 text-center">
      <div className="text-[10px] uppercase tracking-widest text-dim">{label}</div>
      <div className="text-lg font-bold text-[#e6edf3]">{val ?? '—'}</div>
    </div>
  )

  let pos: null | { px: number; valN: number; valE: number; ret: number; cur: string } = null
  if (h) {
    const px = price ?? h.entry_price
    const valN = px * h.shares
    const toEur = (v: number) => (h.currency === 'EUR' ? v : v / eurUsd)
    pos = { px, valN, valE: toEur(valN), ret: h.entry_price ? (px / h.entry_price - 1) * 100 : 0, cur: h.currency }
  }

  const TABS: [Tab, string][] = [['overview', 'Overview'], ['analysis', 'Full analysis'], ['summary', 'AI summary'], ['news', 'News']]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[88vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-3">
            {profile?.logo && <img src={profile.logo} alt="" className="w-9 h-9 rounded object-contain bg-[#1c2128] border border-border" />}
            <div>
              <h2 className="text-xl font-bold text-navy">{ticker}</h2>
              <div className="text-sm text-dim">{profile?.name || h?.name}</div>
              <div className="text-[11px] text-dim opacity-70">
                {[profile?.exchange, profile?.industry, profile?.market_cap ? fmtMktCap(profile.market_cap) : null].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>

        {/* tabs */}
        <div className="flex gap-1 border-b border-border mb-3">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-sm font-medium -mb-px border-b-2 transition-colors ${tab === k ? 'border-brandblue text-brandblue' : 'border-transparent text-dim hover:text-[#e6edf3]'}`}>{label}</button>
          ))}
        </div>

        {loading ? <p className="text-sm text-dim">Loading…</p> : (
          <div className="space-y-4">
            {tab === 'overview' && <>
              {latest && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm">Latest score <span className="font-normal text-[11px] text-dim" title={`Score recorded ${fmtDateTime(latest.created_at)}`}>· {latestNote?.date || fmtDateTime(latest.created_at)}</span></span>
                    <span className="text-sm font-bold">{latest.composite}/100 · {latest.verdict}</span>
                  </div>
                  {latestNote?.method && <div className="text-[11px] mb-1"><span className="text-dim">Method:</span> <span className="font-semibold text-brandblue">{latestNote.method}</span></div>}
                  <div className="grid grid-cols-4 gap-2">{pill('Value', latest.value)}{pill('Quality', latest.quality)}{pill('Momentum', latest.momentum)}{pill('Safety', latest.safety)}</div>
                </div>
              )}

              {detail === null ? <p className="text-xs text-dim">Loading market data…</p>
                : detail.bars && detail.bars.length > 1 ? <PriceChart bars={detail.bars} currency={profile?.currency?.toUpperCase() || pos?.cur || 'USD'} />
                : <p className="text-xs text-dim">No price history available for this symbol.</p>}

              {profile?.description && (
                <p className="text-sm text-dim">
                  {showDesc || profile.description.length < 240 ? profile.description : profile.description.slice(0, 240) + '… '}
                  {profile.description.length >= 240 && <button className="text-brandblue text-xs" onClick={() => setShowDesc(s => !s)}>{showDesc ? 'less' : 'more'}</button>}
                </p>
              )}

              {h ? (
                <div className="text-sm grid grid-cols-2 gap-y-1 border-t border-border pt-2">
                  <span className="text-dim">Bucket</span><span className="text-right"><BucketTag bucket={h.bucket} /></span>
                  <span className="text-dim">Shares</span><span className="text-right text-[#e6edf3]">{fmtNum(h.shares, 0)}</span>
                  <span className="text-dim">Entry price</span><span className="text-right text-[#e6edf3]">{cSym(h.currency)}{fmtNum(h.entry_price)}</span>
                </div>
              ) : <p className="text-sm text-dim">Not a current holding.</p>}

              {pos && (
                <div className="text-sm grid grid-cols-2 gap-y-1">
                  <span className="text-dim">Price</span><span className="text-right text-[#e6edf3]">{cSym(pos.cur)}{fmtNum(pos.px)}{price == null && <span className="text-[10px] text-amber-400"> (entry — refresh prices)</span>}</span>
                  <span className="text-dim">Value (native)</span><span className="text-right font-medium text-[#e6edf3]">{fmtMoney(pos.valN, pos.cur)}</span>
                  <span className="text-dim">Value (€)</span><span className="text-right font-medium text-[#e6edf3]">{fmtMoney(pos.valE)}</span>
                  <span className="text-dim">Return</span><span className={`text-right font-semibold ${pos.ret >= 0 ? 'text-green-400' : 'text-red-400'}`}>{pos.ret >= 0 ? '+' : ''}{fmtPct(pos.ret, 0)}</span>
                </div>
              )}
            </>}

            {tab === 'analysis' && (latest ? (() => {
              const parsed = parseScoreNote(latest.note)
              const bm = barMetrics(detail?.bars)
              const w = parsed.weights
              const sc: Record<'value' | 'quality' | 'momentum' | 'safety', number> = { value: latest.value, quality: latest.quality, momentum: latest.momentum, safety: latest.safety }
              const figs = pillarFigures(fund, bm, parsed.bucket || h?.bucket)
              const toneCls = (t: string) => t === 'good' ? 'text-green-400' : t === 'bad' ? 'text-red-400' : 'text-amber-400'
              const pillarTone = (v: number) => v >= 55 ? 'good' : v >= 45 ? 'mid' : 'bad'
              return <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Composite {latest.composite}/100</span>
                  <span className="text-sm font-bold">{latest.verdict}</span>
                </div>
                <div className="text-[11px] text-dim">Scored {parsed.date || fmtDateTime(latest.created_at)}{parsed.bucket ? ` · ${parsed.bucket} bucket` : ''}{parsed.sources ? ` · data: ${parsed.sources}` : ''}</div>
                <p className="text-[11px] text-dim">A suggested action for this holding is on the <span className="text-brandblue">AI summary</span> tab.</p>

                {parsed.method && (() => {
                  const md = methodByName(parsed.method)
                  return (
                    <details className="text-[11px] bg-surface-2 border border-border rounded p-2 group">
                      <summary className="cursor-pointer list-none flex items-center gap-1">
                        <span className="text-dim group-open:rotate-90 transition-transform">▸</span>
                        <span className="text-dim">Method:</span> <span className="font-semibold text-brandblue">{parsed.method}</span>
                        {w ? <span className="text-dim"> — driven by {[...PILLARS].sort((a, b) => w[b.key] - w[a.key]).slice(0, 2).map(p => p.label.toLowerCase()).join(' + ')}</span> : null}
                      </summary>
                      {md ? <div className="mt-1.5 pl-3 space-y-1 text-dim">
                        <p className="text-[#e6edf3]">{md.short}</p>
                        <p><span className="font-semibold">Theory:</span> {md.theory}</p>
                        <p className="opacity-80">Full breakdown of every method is on the <span className="text-brandblue">Rules → Scoring methods</span> card.</p>
                      </div> : <p className="mt-1.5 pl-3 text-dim">See <span className="text-brandblue">Rules → Scoring methods</span> for how this is computed.</p>}
                    </details>
                  )
                })()}

                {w && (
                  <div className="bg-surface-2 border border-border rounded p-2 text-xs">
                    <div className="font-semibold mb-1 text-[#e6edf3]">How the composite is built — weighted average of the four pillars</div>
                    {PILLARS.map(p => (
                      <div key={p.key} className="flex justify-between"><span>{p.label} {sc[p.key]} × {w[p.key]}%</span><span className="text-dim">{(sc[p.key] * w[p.key] / 100).toFixed(1)}</span></div>
                    ))}
                    <div className="flex justify-between border-t border-border mt-0.5 pt-0.5 font-semibold text-[#e6edf3]"><span>Composite</span><span>= {(PILLARS.reduce((s, p) => s + sc[p.key] * w[p.key], 0) / 100).toFixed(1)} → {latest.composite}</span></div>
                  </div>
                )}

                <div className="space-y-2">
                  {PILLARS.map(p => {
                    const minor = w ? w[p.key] < LOW_WEIGHT_THRESHOLD : false
                    return (
                    <div key={p.key} className={`border border-border rounded-lg p-2 ${minor ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-sm text-[#e6edf3]">{p.label}{minor && <span className="ml-1 text-[10px] font-normal text-dim">· minor for this bucket</span>}</span>
                        <span className={`text-sm font-bold ${toneCls(pillarTone(sc[p.key]))}`}>{sc[p.key]}/100{w ? ` · ${w[p.key]}%` : ''}</span>
                      </div>
                      {figs[p.key].length > 0 && <p className="text-[11px] text-brandblue/90 mt-1">{figs[p.key].join('  ·  ')}</p>}
                      <p className="text-[11px] text-dim mt-1">{p.measures}</p>
                      <p className="text-[11px] text-dim mt-0.5 opacity-80"><b>Inputs:</b> {p.inputs} High = {p.high}.</p>
                    </div>
                  )})}
                </div>

                {parsed.lowConf.length > 0 && (
                  <p className="text-[11px] text-amber-400 bg-[#2d1e00] border border-amber-800/40 rounded p-2">⚠ Lower confidence — these inputs were unavailable at scoring time: {parsed.lowConf.join(', ')}. Those components defaulted toward neutral (50).</p>
                )}
                <p className="text-[10px] text-dim">Scores are point-in-time from the {parsed.date || 'last'} run; Value &amp; Quality use the fundamentals captured then. The Momentum/Safety figures above are recomputed live from current prices, so they can drift from the stored score.</p>

                {scores.length > 1 && (
                  <div>
                    <div className="font-semibold mb-1 text-sm">Score history</div>
                    <table className="w-full text-sm">
                      <thead><tr><th className="th">Date</th><th className="th text-right">Comp</th><th className="th text-right">V</th><th className="th text-right">Q</th><th className="th text-right">M</th><th className="th text-right">S</th></tr></thead>
                      <tbody>{scores.map(s => (
                        <tr key={s.id}><td className="td whitespace-nowrap text-dim">{fmtDate(s.created_at)}</td><td className="td text-right font-semibold">{s.composite}</td><td className="td text-right">{s.value}</td><td className="td text-right">{s.quality}</td><td className="td text-right">{s.momentum}</td><td className="td text-right">{s.safety}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            })() : <p className="text-sm text-dim">No score yet — run Auto-score or score it on the Score tab.</p>)}

            {tab === 'summary' && (() => {
              const syn = aiSummary(ticker, profile, latest, scores[1], detail?.news?.own || [])
              const toneCls = (t: string) => t === 'good' ? 'text-green-400' : t === 'bad' ? 'text-red-400' : 'text-amber-400'
              const deltaCls = (d: number) => d > 0 ? 'text-green-400' : d < 0 ? 'text-red-400' : 'text-dim'
              const sgn = (n: number) => n > 0 ? `+${n}` : `${n}`
              const notable = rankNews(detail?.news?.own || [], 3, digIdx)
              const sentTilt = syn.sentiment.pos > syn.sentiment.neg * 1.5 ? 'leaning positive'
                : syn.sentiment.neg > syn.sentiment.pos * 1.5 ? 'leaning negative'
                : (syn.sentiment.pos === 0 && syn.sentiment.neg === 0) ? 'neutral' : 'mixed'
              const action = latest ? suggestAction({ composite: latest.composite, verdict: latest.verdict, value: latest.value, quality: latest.quality, momentum: latest.momentum, safety: latest.safety, bucket: parseScoreNote(latest.note).bucket || h?.bucket, held: !!h, retPct: pos?.ret ?? null }) : null
              const actBorder = action?.tone === 'good' ? 'border-green-700/50' : action?.tone === 'bad' ? 'border-red-700/50' : 'border-amber-700/50'
              return <div className="space-y-3 text-sm text-[#e6edf3]">
                {/* Suggested action — rules-derived decision aid (leads the summary) */}
                {action && (
                  <div className={`rounded-lg border ${actBorder} bg-surface-2 p-2.5`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-widest text-dim">Suggested action</span>
                      <span className={`text-sm font-bold ${toneCls(action.tone)}`}>{action.stance}</span>
                    </div>
                    <p className="text-[12px] text-dim mt-1">{action.rationale}</p>
                    <p className="text-[10px] text-dim mt-1 opacity-70">Derived from your score + per-bucket rules — a decision aid, not financial advice.</p>
                  </div>
                )}

                {syn.intro && <p className="text-[12px] text-dim">{syn.intro}</p>}
                {syn.noScoreMsg && <p className="text-dim">{syn.noScoreMsg}</p>}

                {/* Easy-to-read narrative */}
                {syn.plain && <p className="leading-relaxed">{syn.plain}</p>}

                {/* What changed since the previous score, with recent news as the backdrop */}
                {syn.change && (
                  <div className="rounded-lg border border-border bg-surface-2 p-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[10px] uppercase tracking-widest text-dim">What changed</span>
                      {syn.change.composite && <span className={`text-sm font-bold ${deltaCls(syn.change.composite.delta)}`}>{syn.change.composite.prev} → {syn.change.composite.cur}/100</span>}
                    </div>
                    <p className="text-[12px] text-dim">{syn.change.text}</p>
                    {syn.change.movers.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {syn.change.movers.map(m => (
                          <span key={m.key} className={`px-1.5 py-0.5 rounded text-[10px] bg-[#21262d] ${deltaCls(m.delta)}`}>{m.label} {sgn(m.delta)} <span className="text-dim">({m.prev}→{m.cur})</span></span>
                        ))}
                      </div>
                    )}
                    {notable.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border">
                        <div className="text-[10px] uppercase tracking-widest text-dim mb-1">Around this period — notable developments ({sentTilt})</div>
                        <ul className="space-y-1">
                          {notable.map(a => (
                            <li key={a.id} className="text-[12px] flex items-start gap-1.5">
                              {a.category && <span className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${catTone(a.materiality)}`}>{a.category}</span>}
                              <a href={a.url} target="_blank" rel="noreferrer" className="text-[#e6edf3] hover:text-brandblue line-clamp-2">{a.title}</a>
                              <SentChip s={a.sentiment} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {syn.flags.length > 0 && (
                  <ul className="space-y-1 list-none">
                    {syn.flags.map((f, i) => <li key={i} className="text-[12px] text-amber-400 flex gap-1.5"><span>⚠</span><span>{f}</span></li>)}
                  </ul>
                )}

                <div className="pt-1 border-t border-border space-y-0.5">
                  {fund?.updated_at && <Freshness label="Fundamentals" at={fund.updated_at} staleHours={168} />}
                  <p className="text-[11px] text-dim">{syn.footer}</p>
                </div>
              </div>
            })()}

            {tab === 'news' && (
              detail === null ? <p className="text-xs text-dim">Loading news…</p> : (() => {
                const own = rankNews(detail.news?.own || [], 3, digIdx)
                const peers = rankPeerNews(detail.news?.peers || [], 3, digIdx)
                return (
                  <div>
                    <p className="text-[11px] text-dim mb-1">Top 3, ranked by materiality, recency &amp; source quality.</p>
                    {own.length === 0 ? <p className="text-sm text-dim">No recent news found.</p> : own.map(a => <NewsRow key={a.id} a={a} />)}
                    {peers.length > 0 && (
                      <div className="mt-3">
                        <div className="text-xs font-semibold text-dim mb-1">Sector peers — top 3</div>
                        {peers.map(a => <NewsRow key={a.id} a={a} />)}
                      </div>
                    )}
                  </div>
                )
              })()
            )}
          </div>
        )}
      </div>
    </div>
  )
}
