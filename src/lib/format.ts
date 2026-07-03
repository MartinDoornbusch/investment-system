// Dutch (nl-NL) locale formatting: € 1.234,56 · 12,3% · 23-06-2026
export const LOCALE = 'nl-NL'
export const fmtMoney = (n: number, cur = 'EUR') =>
  new Intl.NumberFormat(LOCALE, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n || 0)
export const fmtNum = (n: number, d = 2) =>
  new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)
export const fmtPct = (n: number, d = 1) => `${fmtNum(n || 0, d)}%`
// Currency symbol for a code: € for EUR, $ for USD (default). Use instead of showing the code text.
export const cSym = (c?: string | null) => (c === 'EUR' ? '€' : '$')
export const cls = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ')
export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(LOCALE) : '')
// Relative "time ago" for freshness badges; falls back to a date for anything older than a month.
export const fmtAgo = (iso?: string | null) => {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d ago`
  return new Date(iso).toLocaleDateString(LOCALE)
}
export const fmtDateTime = (iso?: string) => (iso ? new Date(iso).toLocaleString(LOCALE, { hour12: false }) : '')

// Verdict → Tailwind classes. Single source of truth for score-verdict coloring.
// verdictText = colored text; verdictChip = pill with background.
export const verdictText = (v?: string) =>
  v?.includes('Strong') ? 'text-green-400' : v?.includes('Buy') ? 'text-brandblue' : v?.includes('Watch') ? 'text-amber-400' : 'text-dim'
export const verdictChip = (v?: string) =>
  v?.includes('Strong') ? 'bg-green-900/40 text-green-400' : v?.includes('Buy') ? 'bg-brandblue/20 text-brandblue' : v?.includes('Watch') ? 'bg-amber-900/40 text-amber-400' : 'bg-[#21262d] text-dim'
