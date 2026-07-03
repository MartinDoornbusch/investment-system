import { useEffect, useRef, useState } from 'react'
import { getConfig, listHoldings, listWatch, sectorMap } from '../lib/db'
import { getPricesWithChange } from '../lib/prices'
import { buildRows, bucketWeights, alerts, type Row } from '../lib/portfolio'
import { DEFAULT_CONFIG, bucketLabel } from '../lib/defaults'
import { marketFeed, ipoBrief, getNewsDigest, type EarningsItem, type IpoItem, type NewsDigestItem } from '../lib/feed'
import { categoryMeta, catTone } from '../lib/news'
import type { SystemConfig } from '../lib/types'
import { fmtMoney, fmtNum, LOCALE } from '../lib/format'
import { Info } from '../components/Info'
import { G } from '../lib/glossary'
import { TickerModal } from '../components/TickerModal'
import { Collapsible } from '../components/Collapsible'

// ── types ────────────────────────────────────────────────────────────────────
type DrillMode =
  | { kind: 'bucket'; bucket: string }
  | { kind: 'top'; sort: 'value' | 'return' | 'loss' }
  | null

// ── helpers ──────────────────────────────────────────────────────────────────
function ChangeChip({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-[11px] text-dim">—</span>
  const pos = pct >= 0
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${pos ? 'text-green-400' : 'text-red-400'}`}>
      {pos ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
    </span>
  )
}

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  )
}

// ── News digest row: priority dot + ticker + classification tags + summary + action ─
function Tag({ label, tone }: { label: string; tone: string }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone}`}>{label}</span>
}
function NewsDigestRow({ n, onTicker }: { n: NewsDigestItem; onTicker: (t: string) => void }) {
  const horizonTone = n.horizon_impact === 'thesis-change' ? 'bg-red-900/40 text-red-300'
    : n.horizon_impact === 'monitor' ? 'bg-amber-900/40 text-amber-300' : 'bg-[#21262d] text-dim'
  const consTone = n.consensus === 'surprise' ? 'bg-violet-900/40 text-violet-300' : 'bg-[#21262d] text-dim'
  const dot = n.priority != null && n.priority <= 2 ? 'bg-red-500' : n.priority === 3 ? 'bg-amber-500' : 'bg-slate-500'
  return (
    <li className="border-b border-[#21262d] pb-2 last:border-0">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot}`} title={`priority ${n.priority ?? '—'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            {n.ticker && <button className="text-[11px] font-semibold text-brandblue hover:underline" onClick={() => onTicker(n.ticker!)}>{n.ticker}</button>}
            {n.category && (() => { const m = categoryMeta(n.category); return <Tag label={m.label} tone={catTone(m.materiality)} /> })()}
            {n.horizon_impact && <Tag label={n.horizon_impact} tone={horizonTone} />}
            {n.consensus && <Tag label={n.consensus} tone={consTone} />}
          </div>
          {n.url
            ? <a href={n.url} target="_blank" rel="noreferrer" className="text-sm text-[#e6edf3] hover:text-brandblue">{n.headline}</a>
            : <span className="text-sm text-[#e6edf3]">{n.headline}</span>}
          {n.summary && <p className="text-[11px] text-dim mt-0.5">{n.summary}</p>}
          {n.actionable && <p className="text-[11px] text-green-400 mt-0.5"><b>Action:</b> {n.actionable}</p>}
        </div>
      </div>
    </li>
  )
}

// ── Drill panel ───────────────────────────────────────────────────────────────
function DrillPanel({
  title, rows, onClose, onTicker
}: {
  title: string
  rows: Row[]
  onClose: () => void
  onTicker: (t: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div ref={ref} className="relative z-50 w-[min(420px,95vw)] h-full bg-[#161b22] border-l border-[#30363d] flex flex-col shadow-2xl">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d]">
          <span className="text-sm font-semibold text-[#e6edf3]">{title}</span>
          <button onClick={onClose} className="text-dim hover:text-[#e6edf3] transition-colors text-lg leading-none">✕</button>
        </div>
        {/* rows */}
        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 && <p className="p-4 text-sm text-dim">No holdings here.</p>}
          {rows.map(r => (
            <button
              key={r.ticker}
              onClick={() => onTicker(r.ticker)}
              className="w-full flex items-center gap-3 px-4 py-3 border-b border-[#21262d] hover:bg-[#1c2128] transition-colors text-left group"
            >
              <div className="w-9 h-9 rounded-lg bg-[#1f3a5f] flex items-center justify-center shrink-0">
                <span className="text-[10px] font-bold text-brandblue">{r.ticker.slice(0, 3)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[#e6edf3]">{r.ticker}</span>
                  <span className="text-sm font-semibold text-[#e6edf3]">{fmtMoney(r.valueEur)}</span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[11px] text-dim truncate mr-2">{r.name || bucketLabel(r.bucket)}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] ${r.retPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {r.retPct >= 0 ? '+' : ''}{fmtNum(r.retPct, 1)}% total
                    </span>
                    <ChangeChip pct={r.changePct} />
                  </div>
                </div>
              </div>
              <ChevronRight />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
const ACCENT_STYLES: Record<string, { bar: string; border: string }> = {
  blue:   { bar: 'bg-brandblue',  border: 'border-t-brandblue' },
  purple: { bar: 'bg-purple-500', border: 'border-t-purple-500' },
  green:  { bar: 'bg-green-500',  border: 'border-t-green-500' },
  red:    { bar: 'bg-red-500',    border: 'border-t-red-500' },
  teal:   { bar: 'bg-teal-500',   border: 'border-t-teal-500' },
  amber:  { bar: 'bg-amber-500',  border: 'border-t-amber-500' },
}

function Stat({
  label, value, tone, accent = 'blue', sub, tip, change, onClick
}: {
  label: string; value: string; tone?: 'pos' | 'neg'
  accent?: string; sub?: string; tip?: string
  change?: number | null   // today's % change (for ChangeChip)
  onClick?: () => void
}) {
  const a = ACCENT_STYLES[accent] ?? ACCENT_STYLES.blue
  return (
    <button
      onClick={onClick}
      className={`card border-t-2 ${a.border} flex flex-col gap-1 text-left w-full
        ${onClick ? 'cursor-pointer hover:bg-[#1c2128] transition-colors' : 'cursor-default'}`}
    >
      <div className="text-[11px] text-dim uppercase tracking-widest flex items-center gap-1">
        {label}{tip && <Info text={tip} />}
        {onClick && <span className="ml-auto text-dim opacity-50 group-hover:opacity-100"><ChevronRight /></span>}
      </div>
      <div className={`text-xl font-bold leading-tight ${
        tone === 'pos' ? 'text-green-400' : tone === 'neg' ? 'text-red-400' : 'text-[#e6edf3]'
      }`}>
        {value}
      </div>
      <div className="flex items-center gap-2">
        {sub && <span className={`text-xs font-medium ${
          tone === 'pos' ? 'text-green-500' : tone === 'neg' ? 'text-red-500' : 'text-dim'
        }`}>{sub}</span>}
        {change !== undefined && <ChangeChip pct={change ?? null} />}
      </div>
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
function IpoInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-dim uppercase tracking-wide">{label}</div>
      <div className="text-[#e6edf3]">{value}</div>
    </div>
  )
}

// Shared row for the Earnings + IPO feed widgets so both read as aligned columns:
// [ date / sub ]  [ ticker / subtitle ]  [ metric / sub ] (right-aligned).
function FeedRow({ dateMain, dateSub, dateColor, ticker, onTicker, badge, subtitle, metaMain, metaSub }: {
  dateMain: string; dateSub?: string; dateColor?: string; ticker: string; onTicker?: () => void; badge?: string; subtitle?: string; metaMain?: string; metaSub?: string
}) {
  return (
    <li className="grid grid-cols-[3.6rem_1fr_auto] items-center gap-2 py-1.5">
      <div className="leading-tight">
        <div className={`text-[11px] tabular-nums ${dateColor ?? 'text-[#e6edf3]'}`}>{dateMain}</div>
        {dateSub && <div className="text-[10px] text-dim tabular-nums truncate">{dateSub}</div>}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          {onTicker
            ? <button className="font-semibold text-sm text-brandblue hover:underline shrink-0" onClick={onTicker}>{ticker}</button>
            : <span className="font-semibold text-sm text-[#e6edf3] shrink-0">{ticker}</span>}
          {badge && <span className="text-[10px] text-dim shrink-0">{badge}</span>}
        </div>
        {subtitle && <div className="text-[10px] text-dim truncate">{subtitle}</div>}
      </div>
      <div className="text-right leading-tight whitespace-nowrap">
        {metaMain && <div className="text-[11px] text-[#e6edf3]">{metaMain}</div>}
        {metaSub && <div className="text-[10px] text-dim">{metaSub}</div>}
      </div>
    </li>
  )
}

// Detail popover for a pending IPO. Pending IPOs aren't trading yet, so the normal ticker detail
// (price history) is empty — instead we surface the offering details we already have, a link to the
// SEC S-1 prospectus, and a best-effort news lookup (usually sparse until the stock lists).
function IpoModal({ ipo, onClose }: { ipo: IpoItem; onClose: () => void }) {
  const [news, setNews] = useState<any[] | null>(null)
  const [brief, setBrief] = useState<{ loading: boolean; text?: string; filingUrl?: string; filedAt?: string; error?: string } | null>(null)
  async function genBrief() {
    setBrief({ loading: true })
    const r = await ipoBrief(ipo.name || ipo.symbol || '', ipo.symbol || undefined)
    setBrief(r.ok ? { loading: false, text: r.brief, filingUrl: r.filingUrl, filedAt: r.filedAt } : { loading: false, error: r.error || 'Failed to generate brief' })
  }
  useEffect(() => {
    let alive = true
    if (ipo.symbol) {
      marketFeed('news', { tickers: [ipo.symbol], days: 90, perTicker: 8 })
        .then(r => { if (alive) setNews(r?.ok ? (r.results || []) : []) })
        .catch(() => { if (alive) setNews([]) })
    } else setNews([])
    return () => { alive = false }
  }, [ipo.symbol])
  const d = ipo.date ? new Date(ipo.date) : null
  const ann = d && !isNaN(d.getTime()) ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
  const idt = ipo.ipoDate ? new Date(ipo.ipoDate) : null
  const ipoDateLabel = idt && !isNaN(idt.getTime()) ? idt.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Expected — TBD'
  const size = typeof ipo.value === 'number' ? (ipo.value >= 1e9 ? `$${(ipo.value / 1e9).toFixed(1)}B` : `$${Math.round(ipo.value / 1e6)}M`) : '—'
  const shares = typeof ipo.shares === 'number' ? ipo.shares.toLocaleString(LOCALE) : '—'
  const fmtUsd = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`
  const cap = typeof ipo.impliedCap === 'number' ? fmtUsd(ipo.impliedCap) : '—'
  const edgar = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(ipo.name || ipo.symbol || '')}&type=S-1&dateb=&owner=include&count=40`
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-[#0d1117] border border-[#30363d] rounded-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-[#e6edf3]">{ipo.symbol}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300 uppercase tracking-wide">{ipo.status || 'pending'} IPO</span>
            </div>
            <div className="text-sm text-dim truncate">{ipo.name}</div>
          </div>
          <button className="text-dim hover:text-[#e6edf3] text-2xl leading-none shrink-0" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm mb-4">
          <IpoInfoRow label="Exchange" value={ipo.exchange || '—'} />
          <IpoInfoRow label="Industry" value={ipo.industry || '—'} />
          <IpoInfoRow label="Announced" value={ann} />
          <IpoInfoRow label="Expected IPO date" value={ipoDateLabel} />
          <IpoInfoRow label="Offer price" value={ipo.price ? `$${ipo.price}` : '—'} />
          <IpoInfoRow label="Shares offered" value={shares} />
          <IpoInfoRow label="Offer size" value={size} />
          <IpoInfoRow label="Implied mkt cap" value={cap} />
        </div>
        <a href={edgar} target="_blank" rel="noreferrer" className="inline-block text-xs text-brandblue hover:underline mb-4">Read the prospectus / S-1 filing on SEC EDGAR ↗</a>
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-semibold text-dim uppercase tracking-wide">AI brief · from the S-1</div>
            {!brief && <button className="text-xs text-brandblue hover:underline" onClick={genBrief}>Generate ↗</button>}
          </div>
          {!brief ? <p className="text-xs text-dim">Summarize the prospectus — business, financials, offering and key risks — with AI, grounded in the SEC filing.</p>
            : brief.loading ? <p className="text-xs text-dim">Reading the S-1 and summarizing… (~15s)</p>
            : brief.error ? <p className="text-xs text-amber-400">{brief.error}</p>
            : <div className="text-[13px] text-dim space-y-1.5 leading-relaxed">
                {(brief.text || '').split('\n').filter(Boolean).map((line, i) => {
                  const parts = line.split('**')
                  const bullet = line.trim().startsWith('-') || line.trim().startsWith('•')
                  return <p key={i} className={bullet ? 'ml-3' : ''}>{parts.map((p, j) => j % 2 ? <strong key={j} className="text-[#e6edf3]">{p}</strong> : p)}</p>
                })}
                <p className="text-[10px] text-dim pt-1">AI summary{brief.filedAt ? ` of the S-1 filed ${brief.filedAt}` : ''} — informational, not advice.{brief.filingUrl ? <> · <a href={brief.filingUrl} target="_blank" rel="noreferrer" className="text-brandblue hover:underline">source</a></> : null}</p>
              </div>}
        </div>
        <div>
          <div className="text-[11px] font-semibold text-dim uppercase tracking-wide mb-2">Recent news</div>
          {news == null ? <p className="text-xs text-dim">Loading news…</p>
            : news.length === 0 ? <p className="text-xs text-dim">No recent news yet — common before an IPO starts trading. The EDGAR filing above is the best primary source.</p>
            : <ul className="space-y-2.5">{news.slice(0, 6).map((n: any, i: number) => (
                <li key={i} className="text-sm">
                  <a href={n.url} target="_blank" rel="noreferrer" className="text-[#e6edf3] hover:text-brandblue font-medium">{n.headline}</a>
                  <div className="text-[10px] text-dim">{n.source}{n.datetime ? ` · ${new Date(n.datetime).toLocaleDateString(LOCALE)}` : ''}</div>
                  {n.summary && <div className="text-[11px] text-dim mt-0.5">{n.summary}</div>}
                </li>
              ))}</ul>}
        </div>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [cfg, setCfg] = useState<SystemConfig>(DEFAULT_CONFIG)
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [pricesLoaded, setPricesLoaded] = useState(true)
  const [drill, setDrill] = useState<DrillMode>(null)
  const [modalTicker, setModalTicker] = useState<string | null>(null)
  const [earnings, setEarnings] = useState<EarningsItem[]>([])
  const [earnMeta, setEarnMeta] = useState<{ source?: string; coverage?: string }>({})
  const [sectors, setSectors] = useState<Record<string, string>>({})
  const [ipos, setIpos] = useState<IpoItem[]>([])
  const [ipoDetail, setIpoDetail] = useState<IpoItem | null>(null)
  const [digest, setDigest] = useState<{ date: string | null; items: NewsDigestItem[] }>({ date: null, items: [] })

  useEffect(() => { (async () => {
    const [c, h, p, w] = await Promise.all([getConfig(), listHoldings(), getPricesWithChange(), listWatch()])
    setCfg(c)
    setPricesLoaded(Object.keys(p).length > 0)
    const { rows, totalEur } = buildRows(h, p, c)
    setRows(rows); setTotal(totalEur)
    const tickers = Array.from(new Set([...(h ?? []).map((x: any) => x.ticker), ...((w as any[]) ?? []).map((x: any) => x.ticker)].filter(Boolean)))
    // Feeds load independently and best-effort, so a slow/empty feed never blocks the dashboard.
    getNewsDigest().then(setDigest).catch(() => {})
    sectorMap().then(setSectors).catch(() => {})
    marketFeed('earnings', { tickers, days: 90 }).then(r => { if (r?.ok) { setEarnings(r.results || []); setEarnMeta({ source: r.source, coverage: r.coverage }) } }).catch(() => {})
    marketFeed('ipo', { days: 90 }).then(r => { if (r?.ok) setIpos(r.results || []) }).catch(() => {})
  })() }, [])

  const bw = bucketWeights(rows, total)
  const al = alerts(rows, bw, cfg)
  const cost = rows.reduce((s, r) => s + (r.entry_price * r.shares) / (r.currency === 'EUR' ? 1 : cfg.eur_usd), 0)
  const pl = total - cost
  const plPct = cost > 0 ? (pl / cost) * 100 : 0

  // Today's portfolio P/L from per-position changePct
  const todayPL = rows.some(r => r.changePct != null)
    ? rows.reduce((s, r) => s + (r.changePct != null ? r.valueEur * (r.changePct / 100) : 0), 0)
    : null
  const todayPct = total > 0 && todayPL != null ? (todayPL / (total - (todayPL ?? 0))) * 100 : null

  // Portfolio-level change% (weighted avg for ChangeChip)
  const portChangePct = total > 0 && todayPL != null ? (todayPL / total) * 100 : null

  // Drill panel rows
  const drillRows: Row[] = (() => {
    if (!drill) return []
    if (drill.kind === 'bucket') return rows.filter(r => r.bucket === drill.bucket)
    if (drill.sort === 'value') return [...rows].sort((a, b) => b.valueEur - a.valueEur).slice(0, 10)
    if (drill.sort === 'return') return [...rows].filter(r => r.retPct >= 0).sort((a, b) => b.retPct - a.retPct).slice(0, 10)
    if (drill.sort === 'loss') return [...rows].filter(r => r.retPct < 0).sort((a, b) => a.retPct - b.retPct).slice(0, 10)
    return []
  })()

  const drillTitle = !drill ? '' :
    drill.kind === 'bucket' ? `${drill.bucket} holdings` :
    drill.sort === 'value' ? 'Top holdings by value' :
    drill.sort === 'return' ? 'Best performers' : 'Biggest losers'

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[#e6edf3]">Dashboard</h1>
        <span className="text-xs text-dim">{new Date().toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>

      {rows.length === 0 && (
        <div className="card text-sm text-dim">
          No holdings yet. Go to <b className="text-[#e6edf3]">Portfolio → Load my current portfolio</b>.
        </div>
      )}
      {rows.length > 0 && !pricesLoaded && (
        <div className="card text-sm text-amber-400 border-amber-800 bg-[#2d1e00]">
          ⚠️ Live prices not loaded — values shown at entry price. Click <b>↻ Refresh prices</b> on the Portfolio tab.
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Total value" value={fmtMoney(total)} accent="blue" tip={G.total_value}
          change={portChangePct}
          onClick={() => setDrill({ kind: 'top', sort: 'value' })}
        />
        <Stat
          label="Cost basis" value={fmtMoney(cost)} accent="purple" tip={G.cost_basis}
        />
        <Stat
          label="Unrealised P/L" value={fmtMoney(pl)} accent={pl >= 0 ? 'green' : 'red'}
          tone={pl >= 0 ? 'pos' : 'neg'}
          sub={`${pl >= 0 ? '+' : ''}${fmtNum(plPct, 1)}%`} tip={G.unrealised_pl}
          onClick={() => setDrill({ kind: 'top', sort: pl >= 0 ? 'return' : 'loss' })}
        />
        <Stat
          label="Positions" value={String(rows.length)} accent="teal" tip={G.positions}
          onClick={() => setDrill({ kind: 'top', sort: 'value' })}
        />
      </div>

      {/* Today P/L card — only shown if we have change data */}
      {todayPL != null && (
        <div className={`card border-t-2 ${todayPL >= 0 ? 'border-t-green-500' : 'border-t-red-500'} flex items-center justify-between`}>
          <div>
            <div className="text-[11px] text-dim uppercase tracking-widest">Today's P&amp;L</div>
            <div className={`text-lg font-bold mt-0.5 ${todayPL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {todayPL >= 0 ? '+' : ''}{fmtMoney(todayPL)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {todayPct != null && (
              <span className={`text-sm font-semibold ${todayPL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {todayPL >= 0 ? '+' : ''}{fmtNum(todayPct, 2)}%
              </span>
            )}
            <div className="text-right">
              <div className="text-[11px] text-dim mb-1">Top movers today</div>
              <div className="flex gap-2">
                {rows.filter(r => r.changePct != null).sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)).slice(0, 3).map(r => (
                  <button key={r.ticker} onClick={() => setModalTicker(r.ticker)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1c2128] hover:bg-[#30363d] transition-colors">
                    <span className="text-[11px] text-[#e6edf3] font-medium">{r.ticker}</span>
                    <ChangeChip pct={r.changePct} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* News digest */}
      <Collapsible id="dash-news" title="News digest" subtitle="· classified & prioritized for your book"
        right={digest.date ? <span className="text-[11px] text-dim">{digest.date}</span> : undefined}>
        {digest.items.length === 0
          ? <p className="text-xs text-dim">No digest yet — it’s generated by a daily task that classifies your tickers’ news (consensus, thesis-impact, actionability). Ask me to run it now to populate it.</p>
          : <ul className="space-y-2">{digest.items.slice(0, 12).map(n => <NewsDigestRow key={n.id} n={n} onTicker={setModalTicker} />)}</ul>}
      </Collapsible>

      {/* Earnings + IPOs */}
      <div className="grid md:grid-cols-2 gap-4">
        <Collapsible id="dash-earnings" title="Upcoming earnings" subtitle={`· your portfolio & watchlist${earnMeta.coverage ? ` · ${earnMeta.source} · ${earnMeta.coverage}` : ''}`}>
          {earnings.length === 0 ? <p className="text-xs text-dim">No earnings dates in the next 90 days (or still loading).</p> : (
            <ul className="divide-y divide-[#21262d]">
              {earnings.slice(0, 10).map((e, i) => {
                const d = new Date(e.date)
                const valid = !isNaN(d.getTime())
                const dlabel = valid ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : e.date
                const days = valid ? Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400000)) : null
                const rel = days == null ? '' : days === 0 ? 'today' : days === 1 ? 'in 1d' : `in ${days}d`
                const when = e.hour === 'bmo' ? 'pre' : e.hour === 'amc' ? 'AMC' : ''
                return (
                  <FeedRow key={i} dateMain={dlabel} dateSub={rel} ticker={e.ticker} onTicker={() => setModalTicker(e.ticker)}
                    badge={when || undefined} subtitle={sectors[e.ticker] || undefined}
                    metaMain={e.epsEstimate != null ? `EPS ${fmtNum(e.epsEstimate)}` : undefined} />
                )
              })}
            </ul>
          )}
        </Collapsible>
        <Collapsible id="dash-ipos" title="IPOs" subtitle="· pending · Ann = announced, IPO = expected · click a ticker">
          {ipos.length === 0 ? <p className="text-xs text-dim">No pending IPOs found (or still loading).</p> : (
            <ul className="divide-y divide-[#21262d]">
              {ipos.slice(0, 10).map((x, i) => {
                const d = x.date ? new Date(x.date) : null
                const ann = d && !isNaN(d.getTime()) ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : ''
                const idd = x.ipoDate ? new Date(x.ipoDate) : null
                const ipoD = idd && !isNaN(idd.getTime()) ? idd.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : ''
                const subtitle = [x.name, x.industry].filter(Boolean).join(' · ')
                return (
                  <FeedRow key={i} dateMain={ipoD || ann || '—'} dateColor={ipoD ? 'text-green-400' : undefined}
                    dateSub={ipoD ? (ann ? `Ann ${ann}` : undefined) : (ann ? 'announced' : undefined)}
                    ticker={x.symbol || x.name || '—'} onTicker={x.symbol ? () => setIpoDetail(x) : undefined}
                    subtitle={subtitle || undefined}
                    metaMain={x.price ? `$${x.price}` : undefined} metaSub={x.exchange || undefined} />
                )
              })}
            </ul>
          )}
        </Collapsible>
      </div>

      {/* Alerts */}
      <Collapsible id="dash-alerts" title="Alerts" right={<Info text={G.alerts} />}>
        {al.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            No rule breaches
          </div>
        ) : (
          <ul className="space-y-2">
            {al.map((a, i) => (
              <li key={i} className={`text-sm flex gap-2 ${a.level === 'warn' ? 'text-red-400' : 'text-dim'}`}>
                <span className="mt-0.5 shrink-0">{a.level === 'warn' ? '⚠' : 'ℹ'}</span>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Collapsible>

      {/* Drill-down panel */}
      {drill && (
        <DrillPanel
          title={drillTitle}
          rows={drillRows}
          onClose={() => setDrill(null)}
          onTicker={t => { setDrill(null); setModalTicker(t) }}
        />
      )}

      {/* Ticker modal */}
      {modalTicker && <TickerModal ticker={modalTicker} onClose={() => setModalTicker(null)} />}
      {ipoDetail && <IpoModal ipo={ipoDetail} onClose={() => setIpoDetail(null)} />}
    </div>
  )
}
