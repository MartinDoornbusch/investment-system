import { fmtAgo } from '../lib/format'

/** Feed-level "updated X ago" badge. Turns amber when older than `staleHours`. */
export function Freshness({ at, label, staleHours, className = '' }: {
  at?: string | null; label?: string; staleHours?: number; className?: string
}) {
  if (!at) return <span className={`text-[11px] text-dim ${className}`}>{label ? `${label}: ` : ''}—</span>
  const ageH = (Date.now() - new Date(at).getTime()) / 3_600_000
  const stale = staleHours != null && ageH > staleHours
  const abs = new Date(at).toLocaleString()
  return (
    <span className={`text-[11px] ${stale ? 'text-amber-400' : 'text-dim'} ${className}`} title={`${label ? label + ' — ' : ''}last updated ${abs}${stale ? ` (older than ${staleHours}h)` : ''}`}>
      {label ? `${label} ` : ''}updated {fmtAgo(at)}{stale ? ' ⚠' : ''}
    </span>
  )
}
