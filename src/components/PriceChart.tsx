import { useEffect, useRef, useState } from 'react'
import { createChart, ColorType, type IChartApi } from 'lightweight-charts'

type Bar = { t: number; c: number; v: number }
const RANGES: Record<string, number> = { '1M': 22, '3M': 66, '6M': 126, '1Y': 252, '2Y': 100000 }

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function PriceChart({ bars, currency = 'USD' }: { bars: Bar[]; currency?: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [range, setRange] = useState('6M')

  useEffect(() => {
    if (!wrap.current || !bars || bars.length < 2) return
    const el = wrap.current
    const chart = createChart(el, {
      width: el.clientWidth, height: 240,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b949e', fontSize: 11 },
      grid: { horzLines: { color: '#21262d' }, vertLines: { visible: false } },
      rightPriceScale: { borderColor: '#30363d' },
      timeScale: { borderColor: '#30363d' },
      crosshair: { mode: 1 },
      handleScroll: false, handleScale: false,
    })
    chartRef.current = chart

    const closes = bars.map(b => b.c)
    const ma50 = sma(closes, 50), ma200 = sma(closes, 200)
    const n = RANGES[range]
    const start = Math.max(0, bars.length - n)
    const slice = bars.slice(start)
    const time = (i: number) => dayStr(bars[i].t)

    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    vol.setData(slice.map((b, k) => ({ time: time(start + k), value: b.v, color: k > 0 && b.c >= slice[k - 1].c ? '#bbf7d0' : '#fecaca' })))

    const area = chart.addAreaSeries({ lineColor: '#16a34a', topColor: 'rgba(22,163,74,0.28)', bottomColor: 'rgba(22,163,74,0.02)', lineWidth: 2, priceLineVisible: false })
    area.setData(slice.map((b, k) => ({ time: time(start + k), value: b.c })))
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } })

    const l50 = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false })
    l50.setData(slice.map((b, k) => ({ time: time(start + k), value: ma50[start + k] })).filter(p => p.value != null) as any)
    const l200 = chart.addLineSeries({ color: '#7c3aed', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false })
    l200.setData(slice.map((b, k) => ({ time: time(start + k), value: ma200[start + k] })).filter(p => p.value != null) as any)

    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }))
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null }
  }, [bars, range])

  if (!bars || bars.length < 2) return <p className="text-xs text-dim">No price history available.</p>

  const n = RANGES[range], slice = bars.slice(Math.max(0, bars.length - n))
  const chg = slice.length > 1 ? (slice[slice.length - 1].c / slice[0].c - 1) * 100 : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
        <div className="flex gap-1">
          {Object.keys(RANGES).map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${range === r ? 'bg-brandblue text-white' : 'text-dim hover:bg-[#21262d] hover:text-[#e6edf3]'}`}>{r}</button>
          ))}
        </div>
        <div className="text-xs flex items-center gap-2">
          <span className={chg >= 0 ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>{chg >= 0 ? '+' : ''}{chg.toFixed(1)}% in {range}</span>
          <span className="text-amber-400 text-[11px]">— MA50</span><span className="text-violet-400 text-[11px]">— MA200</span>
        </div>
      </div>
      <div ref={wrap} className="w-full" />
      <div className="text-[10px] text-dim text-right mt-0.5">Daily closes, split-adjusted · {currency} · source: Massive</div>
    </div>
  )
}
