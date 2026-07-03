import { useState, type ReactNode } from 'react'

/** A card whose body collapses when the header is clicked. Open/closed state persists per `id`. */
export function Collapsible({ id, title, subtitle, right, defaultOpen = true, children }: {
  id: string
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const key = `collapse:${id}`
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(key); return v == null ? defaultOpen : v === '1' } catch { return defaultOpen }
  })
  const toggle = () => setOpen(o => {
    const n = !o
    try { localStorage.setItem(key, n ? '1' : '0') } catch { /* ignore */ }
    return n
  })
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <button onClick={toggle} aria-expanded={open} className="flex items-center gap-2 text-left min-w-0">
          <span className={`text-dim text-xs transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}>▸</span>
          <h2 className="font-semibold truncate">{title}{subtitle && <span className="text-xs font-normal text-dim"> {subtitle}</span>}</h2>
        </button>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}
