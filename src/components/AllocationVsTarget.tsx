import { ASSET_CLASSES, bucketLabel } from '../lib/defaults'
import type { Row } from '../lib/portfolio'
import type { SystemConfig } from '../lib/types'
import { fmtNum } from '../lib/format'

function ChevronRight() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
}

function AllocRow({ label, cur, tgt, bold, indent, onClick }: {
  label: string; cur: number; tgt: number; bold?: boolean; indent?: boolean; onClick?: () => void
}) {
  const over = cur > tgt + 2, under = cur < tgt - 2
  const drillable = !!onClick
  return (
    <button onClick={onClick} disabled={!drillable}
      className={`w-full text-left ${drillable ? 'cursor-pointer group' : 'cursor-default'} ${indent ? 'pl-4' : ''}`}>
      <div className="flex justify-between text-xs mb-1">
        <span className={`flex items-center gap-1 transition-colors ${bold ? 'font-bold text-[#e6edf3] uppercase tracking-wide text-[11px]' : 'text-[#e6edf3] group-hover:text-brandblue'}`}>
          {label}{drillable && <span className="opacity-0 group-hover:opacity-60 transition-opacity"><ChevronRight /></span>}
        </span>
        <span className={over ? 'text-red-400' : under ? 'text-amber-400' : bold ? 'text-[#e6edf3] font-semibold' : 'text-dim'}>
          {fmtNum(cur, 1)}% <span className="text-[#484f58]">/ {tgt}%</span>
        </span>
      </div>
      <div className={`relative bg-[#21262d] rounded-full overflow-hidden ${bold ? 'h-2' : 'h-1.5'}`}>
        <div className="absolute top-0 h-full w-0.5 bg-[#484f58] rounded-full z-10" style={{ left: `${Math.min(100, tgt)}%` }} />
        <div className={`h-full rounded-full transition-all duration-500 ${over ? 'bg-red-500' : under ? 'bg-amber-500' : bold ? 'bg-brandblue' : 'bg-brandblue/60'}`}
          style={{ width: `${Math.min(100, cur)}%` }} />
      </div>
    </button>
  )
}

/** Grouped allocation-vs-target: equity sub-buckets under one Equities subtotal, then Bonds / Real assets / Cash. */
export function AllocationVsTarget({ rows, cfg, onBucket }: { rows: Row[]; cfg: SystemConfig; onBucket?: (b: string) => void }) {
  const bw: Record<string, number> = {}
  rows.forEach(r => { bw[r.bucket] = (bw[r.bucket] || 0) + (r.weight || 0) })
  const hasRows = (b: string) => rows.some(r => r.bucket === b)
  // Concentration cap checks (mirrors lib/portfolio alerts): single-name cap excludes diversified index funds.
  const singleCap = cfg.single_name_cap, specCap = cfg.speculative_cap
  const overSingles = rows.filter(r => r.bucket !== 'Core-Index' && (r.weight || 0) > singleCap).sort((a, b) => (b.weight || 0) - (a.weight || 0))
  const specW = rows.filter(r => r.bucket === 'Speculative').reduce((s, r) => s + (r.weight || 0), 0)
  const capChecks = [
    { label: `Single-name ≤ ${singleCap}%`, breach: overSingles.length > 0, detail: overSingles.length ? overSingles.map(r => `${r.ticker} ${fmtNum(r.weight, 1)}%`).join(', ') : 'all within cap' },
    { label: `Speculative ≤ ${specCap}%`, breach: specW > specCap, detail: `${fmtNum(specW, 1)}% of portfolio` },
  ]
  return (
    <div className="space-y-4">
      {ASSET_CLASSES.map(cls => {
        const clsCur = cls.buckets.reduce((s, b) => s + (bw[b] || 0), 0)
        const clsTgt = cls.buckets.reduce((s, b) => s + (cfg.targets[b] || 0), 0)
        if (clsCur === 0 && clsTgt === 0) return null
        const multi = cls.buckets.length > 1
        const members = cls.buckets.filter(b => (cfg.targets[b] || 0) > 0 || (bw[b] || 0) > 0)
        const sb = cls.buckets[0]
        return (
          <div key={cls.label} className="space-y-2">
            <AllocRow label={cls.label} cur={clsCur} tgt={clsTgt} bold={multi}
              onClick={!multi && onBucket && hasRows(sb) ? () => onBucket(sb) : undefined} />
            {multi && members.map(b => (
              <AllocRow key={b} label={bucketLabel(b)} cur={bw[b] || 0} tgt={cfg.targets[b] || 0} indent
                onClick={onBucket && hasRows(b) ? () => onBucket(b) : undefined} />
            ))}
          </div>
        )
      })}
      <div className="pt-3 border-t border-[#21262d] space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-dim">Concentration rules</div>
        {capChecks.map(c => (
          <div key={c.label} className="flex items-start justify-between gap-3 text-[11px]">
            <span className={c.breach ? 'text-red-400 font-medium' : 'text-emerald-400'}>{c.breach ? '⚠' : '✓'} {c.label}</span>
            <span className={`text-right ${c.breach ? 'text-red-400' : 'text-dim'}`}>{c.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
