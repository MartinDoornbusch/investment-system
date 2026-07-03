/** Shared localStorage cache for company names, populated by Watchlist/Screener lookups. */
const KEY = 'invsys_names'

export function readNameCache(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}

export function writeNameCache(names: Record<string, string>) {
  try { localStorage.setItem(KEY, JSON.stringify(names)) } catch {}
}
