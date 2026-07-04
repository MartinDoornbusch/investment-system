import { useEffect, useState, Fragment } from 'react'
import { getConfig, saveConfig } from '../lib/db'
import { DEFAULT_CONFIG, ASSET_CLASSES, bucketLabel } from '../lib/defaults'
import type { SystemConfig, Bucket, ScoreInput } from '../lib/types'
import { Info } from '../components/Info'
import { PushToggle } from '../components/PushToggle'
import { SCORING_METHODS, UNSCORED_NOTE } from '../lib/analysis'
import { G } from '../lib/glossary'

const BUCKETS: Bucket[] = ['Core-Index', 'Core-Quality', 'Growth', 'Speculative', 'Concentrated', 'Bonds', 'Real-Assets', 'Cash']
const PILLARS: (keyof ScoreInput)[] = ['value', 'quality', 'momentum', 'safety']

// Rationale shown in tooltip per bucket trailing stop
const TRAIL_RATIONALE: Record<Bucket, string> = {
  'Core-Index':
    'Default: disabled.\n\nIndex funds should be held through downturns — that is the entire point of passive investing. A trailing stop would cause you to sell at market lows and miss the recovery, systematically buying high and selling low. Never use a mechanical stop on a broad market ETF.',
  'Core-Quality':
    'Default: 28% (wide).\n\nQuality compounders like ASML, NVDA, and LLY can drop 20–25% on a single bad quarter, sector rotation, or macro shock — and recover fully within months. A tight stop would shake you out of positions you should hold for years. Set wide enough that only genuine fundamental deterioration (not noise) triggers an exit.',
  'Growth':
    'Default: 20% (moderate).\n\nGrowth stocks are more volatile than quality names but still have real businesses underneath. 20% gives breathing room for earnings misses and sentiment swings without letting a position fall off a cliff. Reassess the thesis rather than auto-exiting.',
  'Speculative':
    'Default: 15% (tight).\n\nSmall speculative bets (quantum, early-stage tech) can fall 80–90% before the market declares them impaired. Your primary protection is position size, but a tighter trailing stop ensures you cut early. These positions are never averaged down — exiting on weakness is correct behaviour here.',
  'Concentrated':
    'Default: disabled.\n\nNOW (ServiceNow) is a thesis-driven concentrated position with a specific price target ($200+). A mechanical trailing stop would work against the plan — you are explicitly willing to hold through drawdowns to reach that target. Any exit decision here should come from a thesis review, not a price rule.',
  'Bonds':
    'Not applicable / disabled.\n\nBonds are ballast held for income and low correlation to equities — manage them with the rebalancing band, not a price trailing stop.',
  'Real-Assets':
    'Default: disabled.\n\nGold, broad commodities, REITs and TIPS are diversifiers held for low correlation to stocks and inflation protection — exit via rebalancing toward target, not a mechanical trailing stop.',
  'Cash':
    'Not applicable. Cash has no price movement to trail against.',
}

// Scoring weight rationale per bucket
const WEIGHT_RATIONALE: Record<Bucket, string> = {
  'Core-Index':
    'Equal-weighted (25/25/25/25). Index funds are the market — no single factor outperforms on a consistent basis when you own everything. Scoring an index fund is more about confirming you want broad exposure than selecting a winner.',
  'Core-Quality':
    'Quality-heavy (25/40/15/20). You hold these for years because the business compounds. ROIC vs WACC, margins, moat, and pricing power are the primary lens. Value matters but not at the expense of quality. Momentum is the weakest signal for a 5-year hold.',
  'Growth':
    'Momentum-heavy (20/25/40/15). Growth stocks are priced on trajectory, not current earnings. Relative strength and trend tell you whether the market believes the growth story. Quality (unit economics, revenue quality) is second. Pure valuation is least useful because these names are almost always "expensive."',
  'Speculative':
    'Momentum-dominant (15/20/50/15). Small speculative bets live and die by narrative and price action. A ticker that loses momentum often means the story has changed. Enter with tight thesis, exit when momentum dies — do not use valuation to justify holding a falling speculative name.',
  'Concentrated':
    'Thesis-driven: value + quality (30/40/15/15). NOW is held to a price target based on its long-term earnings power. Quality of business (ROIC, moat, FCF conversion) and fundamental value matter most. Momentum is secondary — you are explicitly holding through drawdowns.',
  'Bonds':
    'Not equity-scored. Bonds are an asset-allocation sleeve (ballast / low correlation), chosen by duration and credit quality rather than the equity pillar rubric.',
  'Real-Assets':
    'Not equity-scored. Gold, commodities, REITs and TIPS are a diversifier sleeve — held for inflation protection and low correlation, not stock-style pillar scoring.',
  'Cash':
    'Placeholder weights (25/25/25/25). Cash is rarely scored. If you are evaluating a money-market instrument or short-duration bond, safety should dominate.',
}

export default function Rules() {
  const [cfg, setCfg] = useState<SystemConfig>(DEFAULT_CONFIG)
  const [msg, setMsg] = useState('')
  useEffect(() => { getConfig().then(setCfg) }, [])

  const targetSum = BUCKETS.reduce((s, b) => s + (cfg.targets[b] || 0), 0)

  function setTarget(b: Bucket, raw: string) {
    setCfg({ ...cfg, targets: { ...cfg.targets, [b]: +raw || 0 } })
  }
  function setWeight(b: Bucket, p: keyof ScoreInput, raw: string) {
    const bw = { ...(cfg.weights[b] ?? DEFAULT_CONFIG.weights[b]) }
    bw[p] = +raw || 0
    setCfg({ ...cfg, weights: { ...cfg.weights, [b]: bw } })
  }
  function setTrailStop(b: Bucket, raw: string) {
    const val = raw.trim() === '' ? null : Number(raw)
    setCfg({ ...cfg, trail_stops: { ...cfg.trail_stops, [b]: val } })
  }

  async function save() {
    setMsg('Saving…')
    const { error } = await saveConfig(cfg) as { error?: { message: string } }
    setMsg(error ? `Error: ${error.message}` : 'Saved ✓')
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-navy">Rules / Investment Policy</h1>
      <p className="text-sm text-dim">Your written system. Hover the &#x24d8; icons for details and rationale.</p>

      <PushToggle />

      {/* === Unified bucket table: Target + Scoring weights === */}
      <div className="card overflow-x-auto">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <h2 className="font-semibold">Bucket policy</h2>
          <span className={`text-sm ${targetSum === 100 ? 'text-green-400' : 'text-amber-400'}`}>
            · target sum {targetSum}
          </span>
          <Info text={
            'Target %: your intended allocation per bucket. New money goes to the most-underweight bucket first.\n\n' +
            'V / Q / M / S: scoring weights per bucket (Value, Quality, Momentum, Safety). Each row should sum to 100. ' +
            'Different buckets warrant different emphases — a Growth bucket cares more about Momentum; a Core-Quality bucket cares more about Quality. ' +
            'These weights drive the composite score shown in Portfolio and Watchlist.\n\n' +
            'Stop %: trailing stop distance below the high-water mark (max of entry price & current price). Leave blank to disable. ' +
            'A warning fires in Portfolio when price breaches this level.\n\n' +
            'Hover the ⓘ on each bucket name for rationale behind default weights and stops.'
          } />
        </div>
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="th text-left py-2">Bucket</th>
              <th className="th text-right py-2" title="Target allocation %">Target %<Info text={G.targets} /></th>
              <th className="th text-right py-2" title={G.value}>V<Info text={G.value} /></th>
              <th className="th text-right py-2" title={G.quality}>Q<Info text={G.quality} /></th>
              <th className="th text-right py-2" title={G.momentum}>M<Info text={G.momentum} /></th>
              <th className="th text-right py-2" title={G.safety}>S<Info text={G.safety} /></th>
              <th className="th text-right py-2">Sum</th>
              <th className="th text-right py-2">Stop %<Info text={'Trailing stop % below the high-water mark. Leave blank to disable for that bucket.'} /></th>
            </tr>
          </thead>
          <tbody>
            {ASSET_CLASSES.map(cls => {
              const clsTarget = cls.buckets.reduce((s, b) => s + (cfg.targets[b] || 0), 0)
              const multi = cls.buckets.length > 1
              return (
              <Fragment key={cls.label}>
                {/* Asset-class subsection header (with class target subtotal) */}
                <tr className="bg-[#0d1117] border-b border-border">
                  <td className="td py-1.5 text-[11px] font-bold uppercase tracking-widest text-brandblue">{cls.label}</td>
                  <td className="td py-1.5 text-right text-[11px] font-bold text-brandblue" title={`${cls.label} target subtotal`}>{clsTarget}%</td>
                  <td className="td" colSpan={6}></td>
                </tr>
                {cls.buckets.map(b => {
              const bw = cfg.weights?.[b] ?? DEFAULT_CONFIG.weights[b]
              const wsum = PILLARS.reduce((s, p) => s + (bw[p] || 0), 0)
              return (
                <tr key={b} className="border-b border-border/40 hover:bg-[#161b22]/40">
                  <td className={`td py-2 pr-3 whitespace-nowrap font-medium text-[#e6edf3] ${multi ? 'pl-5' : ''}`}>
                    {bucketLabel(b)} <Info text={WEIGHT_RATIONALE[b]} />
                  </td>
                  <td className="td py-1 text-right">
                    <input
                      className="input text-right w-16"
                      type="number"
                      min="0"
                      max="100"
                      value={cfg.targets[b]}
                      onChange={e => setTarget(b, e.target.value)}
                    />
                  </td>
                  {PILLARS.map(p => (
                    <td key={p} className="td py-1 text-right">
                      <input
                        className="input text-right w-16"
                        type="number"
                        min="0"
                        max="100"
                        value={bw[p]}
                        onChange={e => setWeight(b, p, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className={`td py-2 text-right font-bold ${wsum === 100 ? 'text-green-400' : 'text-amber-400'}`}>
                    {wsum}
                  </td>
                  <td className="td py-1 text-right">
                    <input
                      className={`input text-right w-16 ${cfg.trail_stops?.[b] == null ? 'opacity-50' : ''}`}
                      type="number"
                      min="1"
                      max="99"
                      placeholder="off"
                      title={TRAIL_RATIONALE[b]}
                      value={cfg.trail_stops?.[b] ?? ''}
                      onChange={e => setTrailStop(b, e.target.value)}
                    />
                  </td>
                </tr>
              )
                })}
              </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className={`td py-2 text-sm font-medium ${targetSum === 100 ? 'text-green-400' : 'text-amber-400'}`}>
                Total
              </td>
              <td className={`td py-2 text-right font-bold ${targetSum === 100 ? 'text-green-400' : 'text-amber-400'}`}>
                {targetSum}
              </td>
              <td className="td" colSpan={6}></td>
            </tr>
          </tfoot>
        </table>
        <p className="text-[11px] text-dim mt-2">
          V = Value &middot; Q = Quality &middot; M = Momentum &middot; S = Safety &middot; each row's V+Q+M+S should equal 100.
          Stop % = trailing stop below high-water mark; blank = disabled.
          Hover any Stop % input for the rationale.
        </p>
      </div>

      {/* === Scoring methods reference === */}
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="font-semibold">Scoring methods</h2>
          <Info text={'Each bucket is scored by a different named method — not just different weights, but different pillar formulas. This is the link between the investment theories in your knowledge base and the composite score. Use it to see which approach drives each name, and to design your own blends.'} />
        </div>
        <p className="text-sm text-dim mb-3">How each bucket is scored, and the theory behind it. The same four pillars are combined differently per bucket; only Safety is computed identically everywhere.</p>
        <div className="grid md:grid-cols-2 gap-3">
          {SCORING_METHODS.map(m => (
            <div key={m.name} className="rounded-lg border border-border bg-surface-2 p-3">
              <div className="flex items-center justify-between flex-wrap gap-1 mb-1">
                <span className="font-semibold text-brandblue">{m.name}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#0d1117] border border-border text-dim">{m.weights}</span>
              </div>
              <div className="text-[11px] text-dim mb-2">Bucket{m.buckets.length > 1 ? 's' : ''}: <span className="text-[#e6edf3] font-medium">{m.buckets.join(', ')}</span></div>
              <p className="text-xs text-[#e6edf3] mb-2">{m.emphasis}</p>
              <div className="text-[11px] text-dim space-y-1 border-t border-border pt-2">
                <div><span className="font-semibold text-[#e6edf3]">Value:</span> {m.pillarHow.value}</div>
                <div><span className="font-semibold text-[#e6edf3]">Quality:</span> {m.pillarHow.quality}</div>
                <div><span className="font-semibold text-[#e6edf3]">Momentum:</span> {m.pillarHow.momentum}</div>
                <div><span className="font-semibold text-[#e6edf3]">Safety:</span> {m.pillarHow.safety}</div>
              </div>
              <p className="text-[11px] text-dim mt-2 italic border-t border-border pt-2">Theory: {m.theory}</p>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-dim mt-3">{UNSCORED_NOTE}</p>
      </div>

      {/* Risk caps + score thresholds */}
      <div className="card grid grid-cols-2 md:grid-cols-4 gap-3">
        <div><label className="label">Single-name cap %<Info text={G.single_name_cap} /></label><input className="input" type="number" value={cfg.single_name_cap} onChange={e => setCfg({ ...cfg, single_name_cap: +e.target.value })} /></div>
        <div><label className="label">Speculative cap %<Info text={G.speculative_cap} /></label><input className="input" type="number" value={cfg.speculative_cap} onChange={e => setCfg({ ...cfg, speculative_cap: +e.target.value })} /></div>
        <div><label className="label">Strong &#x2265;<Info text={G.strong_threshold} /></label><input className="input" type="number" value={cfg.strong_threshold} onChange={e => setCfg({ ...cfg, strong_threshold: +e.target.value })} /></div>
        <div><label className="label">Watch &#x2265;<Info text={G.watch_threshold} /></label><input className="input" type="number" value={cfg.watch_threshold} onChange={e => setCfg({ ...cfg, watch_threshold: +e.target.value })} /></div>
      </div>

      {/* EUR/USD + free-text rules */}
      <div className="card">
        <label className="label">EUR/USD<Info text={G.eur_usd} /></label>
        <input className="input md:w-40" type="number" step="0.0001" value={cfg.eur_usd} onChange={e => setCfg({ ...cfg, eur_usd: +e.target.value })} />
        <p className="text-[11px] text-dim mb-3 mt-0.5">Auto-updated to the live ECB rate each time you refresh prices{cfg.eur_usd_at ? ` (last: ${new Date(cfg.eur_usd_at).toLocaleString()})` : ''}. A manual value here is used until the next refresh overwrites it.</p>
        <label className="label">My rules (free text)</label>
        <textarea className="input" rows={8} value={cfg.rules_text} onChange={e => setCfg({ ...cfg, rules_text: e.target.value })} />
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save}>Save policy</button>
        <span className="text-sm text-dim">{msg}</span>
      </div>
    </div>
  )
}
