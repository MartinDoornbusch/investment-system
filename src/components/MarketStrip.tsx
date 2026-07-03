import { useEffect, useState } from 'react'
import { listHoldings } from '../lib/db'
import { getMarketIndices, type MarketData } from '../lib/feed'
import { fmtNum } from '../lib/format'

// Exchange suffix -> benchmark index (Yahoo symbol + display name). US (no suffix) -> S&P 500 + Nasdaq-100.
const SUFFIX_INDEX: Record<string, { sym: string; name: string }> = {
  AS: { sym: '^AEX', name: 'AEX' },          // Euronext Amsterdam
  L:  { sym: '^FTSE', name: 'FTSE 100' },    // London
  DE: { sym: '^GDAXI', name: 'DAX' },        // Xetra
  PA: { sym: '^FCHI', name: 'CAC 40' },      // Euronext Paris
  BR: { sym: '^BFX', name: 'BEL 20' },       // Euronext Brussels
  MI: { sym: 'FTSEMIB.MI', name: 'FTSE MIB' },// Borsa Italiana
  SW: { sym: '^SSMI', name: 'SMI' },         // SIX Swiss
  TO: { sym: '^GSPTSE', name: 'TSX' },       // Toronto
  HK: { sym: '^HSI', name: 'Hang Seng' },    // Hong Kong
  T:  { sym: '^N225', name: 'Nikkei 225' },  // Tokyo
}

/** Top strip of benchmark indices for the exchanges the holdings actually trade on, + market-regime pill. */
export function MarketStrip({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<MarketData | null>(null)
  const [shown, setShown] = useState<{ sym: string; name: string }[]>([])

  useEffect(() => { (async () => {
    const h = await listHoldings()
    let hasUS = false
    const extras = new Map<string, string>()  // sym -> name
    ;(h as any[] ?? []).forEach(x => {
      const t = String(x.ticker || ''); const dot = t.lastIndexOf('.')
      if (dot < 0) { hasUS = true; return }
      const m = SUFFIX_INDEX[t.slice(dot + 1).toUpperCase()]
      if (m) extras.set(m.sym, m.name)
    })
    const list: { sym: string; name: string }[] = []
    if (hasUS) list.push({ sym: '^GSPC', name: 'S&P 500' }, { sym: '^NDX', name: 'Nasdaq-100' })
    extras.forEach((name, sym) => list.push({ sym, name }))
    setShown(list)
    if (list.length) setData(await getMarketIndices([...extras.keys()]))
  })() }, [])

  if (!data || shown.length === 0) return null
  const stateCls = data.state.includes('Confirmed') ? 'bg-green-900/40 text-green-400 border-green-800/50'
    : data.state.includes('Bear') ? 'bg-red-900/40 text-red-400 border-red-800/50'
    : data.state === '—' ? 'bg-[#21262d] text-dim border-border'
    : 'bg-amber-900/40 text-amber-300 border-amber-800/50'

  return (
    <div className={`flex items-center gap-2 text-xs ${compact ? 'justify-end' : 'flex-wrap mb-4'}`}>
      {shown.map(({ sym, name }) => {
        const q = data.indices[sym]; if (!q) return null
        const up = q.ma200 != null ? q.price > q.ma200 : null
        const chgUp = q.chg != null && q.chg >= 0
        return (
          <div key={sym} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface border border-border"
            title={`${name}: ${fmtNum(q.price, 0)}. Dot = ${up == null ? 'trend unknown' : up ? 'above' : 'below'} the 200-day MA (${q.ma200 != null ? fmtNum(q.ma200, 0) : '—'}) — green = long-term uptrend.`}>
            <span className={`w-1.5 h-1.5 rounded-full ${up == null ? 'bg-dim' : up ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-dim">{name}</span>
            <span className="font-semibold text-[#e6edf3]">{fmtNum(q.price, 0)}</span>
            {q.chg != null && <span className={chgUp ? 'text-green-400' : 'text-red-400'}>{chgUp ? '▲' : '▼'}{Math.abs(q.chg).toFixed(2)}%</span>}
          </div>
        )
      })}
      {data.state !== '—' && (
        <span className={`px-2.5 py-1 rounded-lg border font-medium ${stateCls}`}
          title={`Market regime from the S&P 500 & Nasdaq-100 vs their 200-day MA, with ${data.dist} distribution days in the last 25 sessions (4+ downgrades a 'Confirmed uptrend'). Non-US indices are informational. M-score ${data.m}/3.`}>
          {data.state}
        </span>
      )}
    </div>
  )
}
