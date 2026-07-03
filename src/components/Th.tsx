import type { ReactNode } from 'react'

interface Props<T> { label: string; k: keyof T; sort: { key?: keyof T; dir: 'asc' | 'desc'; onSort: (k: keyof T) => void }; align?: 'left' | 'right' | 'center'; tip?: string; filter?: ReactNode }
export function Th<T>({ label, k, sort, align = 'left', tip, filter }: Props<T>) {
  const active = sort.key === k
  const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
  const title = tip ? `${tip}\n\n(Click to sort)` : 'Click to sort'
  return (
    <th className={`th align-top text-${align}`}>
      <button type="button" className="cursor-pointer select-none hover:text-navy" onClick={() => sort.onSort(k)} title={title}>
        {label}<span className="text-brandblue">{arrow}</span>{tip ? <span className="ml-0.5 text-slate-300">ⓘ</span> : null}
      </button>
      {filter && <div className="mt-1" onClick={e => e.stopPropagation()}>{filter}</div>}
    </th>
  )
}
