import type { ScoreInput, SystemConfig } from './types'

export function composite(inp: ScoreInput, w: ScoreInput): number {
  const wsum = w.value + w.quality + w.momentum + w.safety || 1
  const raw = inp.value * w.value + inp.quality * w.quality + inp.momentum * w.momentum + inp.safety * w.safety
  return Math.round(raw / wsum)
}

export function verdict(score: number, cfg: SystemConfig): string {
  if (score >= cfg.strong_threshold) return 'Strong candidate'
  if (score >= cfg.watch_threshold) return 'Watchlist'
  return 'Pass'
}

// Guardrail: momentum without quality is capped (avoid junk rallies); value needs a real margin of safety.
export function guardrailNote(inp: ScoreInput): string | null {
  if (inp.momentum >= 70 && inp.quality < 40) return 'High momentum but low quality — possible junk rally. Cap conviction.'
  if (inp.value >= 70 && inp.quality < 30) return 'Cheap but low quality — possible value trap. Demand a real margin of safety.'
  return null
}
