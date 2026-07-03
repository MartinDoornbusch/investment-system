import { useMemo, useState } from 'react'
export type SortDir = 'asc' | 'desc'
export function useSort<T>(rows: T[], initialKey?: keyof T, initialDir: SortDir = 'asc') {
  const [key, setKey] = useState<keyof T | undefined>(initialKey)
  const [dir, setDir] = useState<SortDir>(initialDir)
  const sorted = useMemo(() => {
    if (!key) return rows
    // Null/undefined always sink to the bottom, regardless of sort direction.
    return [...rows].sort((a, b) => {
      const av = a[key] as unknown, bv = b[key] as unknown
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true })
      return dir === 'asc' ? cmp : -cmp
    })
  }, [rows, key, dir])
  const onSort = (k: keyof T) => {
    if (k === key) setDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setKey(k); setDir('asc') }
  }
  return { sorted, key, dir, onSort }
}
