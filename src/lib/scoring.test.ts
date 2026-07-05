import { describe, expect, it } from 'vitest'
import { composite, guardrailNote, verdict } from './scoring'
import type { ScoreInput, SystemConfig } from './types'

const inp = (value: number, quality: number, momentum: number, safety: number): ScoreInput =>
  ({ value, quality, momentum, safety })

const cfg = { strong_threshold: 70, watch_threshold: 50 } as SystemConfig

describe('composite', () => {
  it('averages with equal weights', () => {
    expect(composite(inp(80, 60, 40, 20), inp(25, 25, 25, 25))).toBe(50)
  })

  it('applies pillar weights', () => {
    // value dominant: 100*70 + 0*10*3 = 7000 / 100 = 70
    expect(composite(inp(100, 0, 0, 0), inp(70, 10, 10, 10))).toBe(70)
  })

  it('normalizes weights that do not sum to 100', () => {
    // same ratio as 25/25/25/25 -> identical result
    expect(composite(inp(80, 60, 40, 20), inp(1, 1, 1, 1))).toBe(50)
  })

  it('rounds to nearest integer', () => {
    // (33+34)/2 = 33.5 -> 34
    expect(composite(inp(33, 34, 0, 0), inp(50, 50, 0, 0))).toBe(34)
  })

  it('returns 0 instead of NaN when all weights are zero', () => {
    expect(composite(inp(80, 80, 80, 80), inp(0, 0, 0, 0))).toBe(0)
  })
})

describe('verdict', () => {
  it('is Strong candidate at or above strong_threshold', () => {
    expect(verdict(70, cfg)).toBe('Strong candidate')
    expect(verdict(100, cfg)).toBe('Strong candidate')
  })

  it('is Watchlist between watch and strong threshold', () => {
    expect(verdict(50, cfg)).toBe('Watchlist')
    expect(verdict(69, cfg)).toBe('Watchlist')
  })

  it('is Pass below watch_threshold', () => {
    expect(verdict(49, cfg)).toBe('Pass')
    expect(verdict(0, cfg)).toBe('Pass')
  })
})

describe('guardrailNote', () => {
  it('flags junk rally: high momentum, low quality', () => {
    expect(guardrailNote(inp(50, 39, 70, 50))).toMatch(/junk rally/)
  })

  it('flags value trap: cheap but low quality', () => {
    expect(guardrailNote(inp(70, 29, 30, 50))).toMatch(/value trap/)
  })

  it('junk-rally check takes precedence when both apply', () => {
    expect(guardrailNote(inp(70, 20, 70, 50))).toMatch(/junk rally/)
  })

  it('returns null for healthy scores', () => {
    expect(guardrailNote(inp(60, 60, 60, 60))).toBeNull()
    expect(guardrailNote(inp(50, 40, 70, 50))).toBeNull()  // quality exactly at 40
    expect(guardrailNote(inp(70, 30, 30, 50))).toBeNull()  // quality exactly at 30
  })
})
