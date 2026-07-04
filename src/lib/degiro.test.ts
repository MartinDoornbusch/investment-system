import { describe, it, expect } from 'vitest'
import { parseDegiroCsv, parseNum, guessTickerMap } from './degiro'

describe('parseNum', () => {
  it('parses nl (comma decimal, dot thousands)', () => {
    expect(parseNum('49,559')).toBeCloseTo(49.559)
    expect(parseNum('-4.335,62')).toBeCloseTo(-4335.62)
    expect(parseNum('1.234.567,89')).toBeCloseTo(1234567.89)
  })
  it('parses en (dot decimal, comma thousands) and plain', () => {
    expect(parseNum('1,234.56')).toBeCloseTo(1234.56)
    expect(parseNum('49.559')).toBeCloseTo(49.559)
  })
  it('returns null for blanks', () => {
    expect(parseNum('')).toBeNull()
    expect(parseNum('  ')).toBeNull()
    expect(parseNum('-')).toBeNull()
  })
})

// A minimal DeGiro (nl) Transactions export: one US buy, one EUR sell.
const NL_CSV = [
  'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde,,Wisselkoers,Transactiekosten en/of derden,,Totaal,,Order ID',
  '04-06-2025,15:30,"NVIDIA CORP",US67066G1040,NDQ,NDQ,100,"49,559",USD,"4.955,90",USD,"-4.335,12",EUR,"1,1429","-0,50",EUR,"-4.335,62",EUR,abc-123',
  '05-06-2025,10:00,ASML HOLDING,NL0010273215,EAM,EAM,-5,"682,70",EUR,"-3.413,50",EUR,"3.413,50",EUR,,"-2,00",EUR,"3.411,50",EUR,def-456',
].join('\n')

describe('parseDegiroCsv', () => {
  const { rows, products, warnings } = parseDegiroCsv(NL_CSV)

  it('parses both trade rows with no warnings', () => {
    expect(warnings).toHaveLength(0)
    expect(rows).toHaveLength(2)
  })

  it('maps a positive quantity to BUY with native price/currency and euro totals', () => {
    const buy = rows[0]
    expect(buy).toMatchObject({ date: '2025-06-04', action: 'BUY', quantity: 100, currency: 'USD', isin: 'US67066G1040', order_id: 'abc-123', source: 'DeGiro' })
    expect(buy.price).toBeCloseTo(49.559)
    expect(buy.fx).toBeCloseTo(1.1429)
    expect(buy.fees_eur).toBeCloseTo(0.5)      // absolute value of the cost
    expect(buy.total_eur).toBeCloseTo(-4335.62) // signed: negative = cash out
  })

  it('maps a negative quantity to SELL with a positive total', () => {
    const sell = rows[1]
    expect(sell).toMatchObject({ date: '2025-06-05', action: 'SELL', quantity: 5, currency: 'EUR' })
    expect(sell.total_eur).toBeCloseTo(3411.5)
  })

  it('lists distinct products for ticker mapping', () => {
    expect(products.map(p => p.isin).sort()).toEqual(['NL0010273215', 'US67066G1040'])
  })

  it('rejects a non-DeGiro file', () => {
    const r = parseDegiroCsv('a,b,c\n1,2,3')
    expect(r.rows).toHaveLength(0)
    expect(r.warnings[0]).toMatch(/DeGiro/)
  })
})

describe('guessTickerMap', () => {
  it('matches a product name to a holding, ignoring corporate suffixes', () => {
    const map = guessTickerMap(
      [{ isin: 'US67066G1040', name: 'NVIDIA CORP' }, { isin: 'NL0010273215', name: 'ASML HOLDING' }],
      [{ ticker: 'NVDA', name: 'NVIDIA' }],
    )
    expect(map['US67066G1040']).toBe('NVDA')
    expect(map['NL0010273215']).toBeUndefined() // no matching holding
  })
})
