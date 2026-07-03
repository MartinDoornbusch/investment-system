interface Props<T> { label: string; k: keyof T; sort: { key?: keyof T; dir: 'asc' | 'desc'; onSort: (k: keyof T) => void }; align?: 'left' | 'right' | 'center'; tip?: string }
export function Th<T>({ label, k, sort, align = 'left', tip }: Props<T>) {
  const active = sort.key === k
  const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
  const title = tip ? `${tip}\n\n(Click to sort)` : 'Click to sort'
  return (
    <th className={`th cursor-pointer select-none hover:text-navy text-${align}`} onClick={() => sort.onSort(k)} title={title}>
      {label}<span className="text-brandblue">{arrow}</span>{tip ? <span className="ml-0.5 text-slate-300">ⓘ</span> : null}
    </th>
  )
}
