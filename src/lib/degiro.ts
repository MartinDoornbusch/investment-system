// DeGiro "Transactions" CSV import.
// Parses the export from DeGiro (Account → Transactions → Export → CSV), in Dutch or English,
// into rows for the `transactions` table. DeGiro settles in your account currency (EUR for NL),
// so `total_eur` / `value_eur` / `fees_eur` are already in euro; `price` + `currency` are the
// native trade currency. DeGiro gives no ticker — only Product name + ISIN — so the caller
// resolves ISIN → ticker (see guessTickerMap) before inserting.
import type { Transaction } from './types'

export type ParsedTx = Omit<Transaction, 'id'>

export interface DegiroParseResult {
  rows: ParsedTx[]
  products: { isin: string; name: string; count: number }[]  // distinct products, for ticker mapping
  warnings: string[]
}

// ── CSV parsing (handles quoted fields with embedded commas/quotes) ──────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cur = '', inQ = false
  const t = text.replace(/^﻿/, '') // strip BOM
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++ } else inQ = false }
      else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c === '\r') { /* ignore */ }
    else cur += c
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows
}

// Accepts both "1.234,56" (nl) and "1,234.56" / "1234.56" (en). Returns null when not numeric.
export function parseNum(s?: string): number | null {
  if (s == null) return null
  let t = String(s).trim().replace(/\s/g, '')
  if (!t || t === '-') return null
  const hasComma = t.includes(','), hasDot = t.includes('.')
  if (hasComma && hasDot) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  } else if (hasComma) t = t.replace(',', '.')
  const n = Number(t)
  return isFinite(n) ? n : null
}

// DeGiro dates are DD-MM-YYYY. Return ISO YYYY-MM-DD.
function toIso(s?: string): string | null {
  if (!s) return null
  const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  const iso = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null
}

const norm = (s: string) => s.trim().toLowerCase()

/** Locate the columns we need by header label (nl + en). DeGiro interleaves unnamed currency
 *  columns right after each amount, so a currency lives at (amount index + 1). */
function columnIndex(header: string[]) {
  const at = (pred: (h: string) => boolean) => header.findIndex(h => pred(norm(h)))
  const date = at(h => h === 'datum' || h === 'date')
  const product = at(h => h === 'product')
  const isin = at(h => h === 'isin')
  const quantity = at(h => h === 'aantal' || h === 'quantity')
  const price = at(h => h === 'koers' || h === 'price')
  const value = at(h => h === 'waarde' || h === 'value')          // in EUR (excl. fees)
  const fx = at(h => h === 'wisselkoers' || h === 'exchange rate')
  const fees = at(h => h.includes('kosten') || h.includes('cost') || h.includes(' fee'))
  const total = at(h => h === 'totaal' || h === 'total')          // in EUR (incl. fees)
  const orderId = at(h => h.replace(/[\s-]/g, '') === 'orderid')
  return { date, product, isin, quantity, price, value, fx, fees, total, orderId }
}

export function parseDegiroCsv(text: string): DegiroParseResult {
  const warnings: string[] = []
  const grid = parseCsv(text).filter(r => r.some(c => c.trim() !== ''))
  if (grid.length < 2) return { rows: [], products: [], warnings: ['Empty or unreadable CSV.'] }

  const header = grid[0]
  const col = columnIndex(header)
  const missing = (['date', 'product', 'isin', 'quantity'] as const).filter(k => col[k] < 0)
  if (missing.length) {
    return { rows: [], products: [], warnings: [`This does not look like a DeGiro Transactions export (missing columns: ${missing.join(', ')}). Use Account → Transactions → Export → CSV.`] }
  }

  const rows: ParsedTx[] = []
  const productMap = new Map<string, { isin: string; name: string; count: number }>()

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]
    const cell = (idx: number) => (idx >= 0 ? (r[idx] ?? '').trim() : '')
    const date = toIso(cell(col.date))
    const qtyRaw = parseNum(cell(col.quantity))
    const name = cell(col.product)
    const isin = cell(col.isin)
    if (!date || qtyRaw == null || qtyRaw === 0 || !name) continue // skip non-trade / blank rows

    const priceCurIdx = col.price >= 0 ? col.price + 1 : -1
    const row: ParsedTx = {
      date,
      name,
      isin: isin || undefined,
      action: qtyRaw < 0 ? 'SELL' : 'BUY',
      quantity: Math.abs(qtyRaw),
      price: parseNum(cell(col.price)) ?? 0,
      currency: (cell(priceCurIdx) || 'EUR').toUpperCase(),
      value_eur: parseNum(cell(col.value)) ?? undefined,
      fx: parseNum(cell(col.fx)) ?? undefined,
      fees_eur: col.fees >= 0 ? Math.abs(parseNum(cell(col.fees)) ?? 0) : undefined,
      total_eur: parseNum(cell(col.total)) ?? undefined,   // signed: negative = cash out (a buy)
      order_id: cell(col.orderId) || undefined,
      source: 'DeGiro',
    }
    rows.push(row)
    if (isin) {
      const p = productMap.get(isin) ?? { isin, name, count: 0 }
      p.count++; productMap.set(isin, p)
    }
  }

  if (!rows.length) warnings.push('No transaction rows found in the file.')
  const products = [...productMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, products, warnings }
}

// Best-effort ISIN → ticker guess by matching a DeGiro product name to an existing holding's name.
const cleanName = (s: string) => norm(s)
  .replace(/[.,]/g, ' ')
  .replace(/\b(inc|corp|corporation|company|co|nv|sa|plc|ltd|ag|holding|holdings|adr|the|class [a-c]|cl [a-c])\b/g, ' ')
  .replace(/\s+/g, ' ').trim()

export function guessTickerMap(
  products: { isin: string; name: string }[],
  holdings: { ticker: string; name?: string }[],
): Record<string, string> {
  const byName = holdings.filter(h => h.name).map(h => ({ ticker: h.ticker, key: cleanName(h.name!) }))
  const out: Record<string, string> = {}
  for (const p of products) {
    const pk = cleanName(p.name)
    const hit = byName.find(h => h.key && (h.key === pk || pk.startsWith(h.key) || h.key.startsWith(pk)))
    if (hit) out[p.isin] = hit.ticker
  }
  return out
}

const LS_KEY = 'degiro:isinTicker'
export function loadTickerMemory(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}
export function saveTickerMemory(map: Record<string, string>) {
  try {
    const prev = loadTickerMemory()
    const merged = { ...prev, ...Object.fromEntries(Object.entries(map).filter(([, v]) => v)) }
    localStorage.setItem(LS_KEY, JSON.stringify(merged))
  } catch { /* ignore */ }
}
