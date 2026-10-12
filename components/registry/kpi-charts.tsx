'use client'

// レジストリの管理画面の KPI のグラフ(SVG で自作する。グラフのライブラリは使わない)。
// - 折れ線(重ねる)・棒・コホートのマス目・小さな推移・横棒の一覧
// - 色は決まった順(--kpi-1〜5。app/globals.css)。色だけに頼らず、凡例に名前と一番新しい値を出す
// - 幅は入れ物に合わせる(375px でもはみ出さない)。線・点を押す・重ねると、その週の値を出す
import { useEffect, useRef, useState } from 'react'
import { formatValue, weekLabel, type KpiUnit } from '@/lib/registry/kpi'

export const SERIES_COLORS = ['var(--kpi-1)', 'var(--kpi-2)', 'var(--kpi-3)', 'var(--kpi-4)', 'var(--kpi-5)']

/** 入れ物の幅(ResizeObserver) */
function useWidth<T extends HTMLElement>(fallback = 320): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(Math.max(160, Math.floor(el.clientWidth)))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/** 目盛り(0 を含む、きりのよい値) */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) max = min + 1
  const raw = (max - min) / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const start = Math.floor(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(10)))
  if (out[out.length - 1] < max) out.push(Number((out[out.length - 1] + step).toFixed(10)))
  return out
}

function axisLabel(v: number, unit: KpiUnit): string {
  if (unit === 'percent') return `${Math.round(v * 100)}%`
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}k`
  return unit === 'count' ? String(Math.round(v)) : String(Number(v.toFixed(2)))
}

export interface LineSeries { name: string; values: (number | null)[]; color?: string }

/** 折れ線(重ねる)。値の無い週は線を切る */
export function LineChart({ weeks, series, unit, height = 180, label }: { weeks: string[]; series: LineSeries[]; unit: KpiUnit; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null)
  const pad = { l: 40, r: 8, t: 8, b: 22 }
  const ticks = niceTicks(Math.min(0, ...all), all.length ? Math.max(...all) : 1)
  const lo = ticks[0]
  const hi = ticks[ticks.length - 1]
  const plotW = width - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const x = (i: number) => pad.l + (weeks.length <= 1 ? plotW / 2 : (plotW * i) / (weeks.length - 1))
  const y = (v: number) => pad.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH
  const xLabels = weeks.length <= 1 ? [0] : [0, Math.floor((weeks.length - 1) / 2), weeks.length - 1]
  const paths = series.map((s) => {
    let d = ''
    let open = false
    s.values.forEach((v, i) => {
      if (v === null) { open = false; return }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
      open = true
    })
    return d
  })
  const last = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return vals[i]; return null }
  return (
    <figure className="min-w-0" data-kpi-line>
      <div ref={ref} className="relative w-full min-w-0">
        <svg width={width} height={height} role="img" aria-label={label} className="block text-muted-foreground" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.5 : 0.15} />
              <text x={pad.l - 4} y={y(t) + 3} textAnchor="end" fontSize={10} fill="currentColor">{axisLabel(t, unit)}</text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 && weeks.length > 1 ? 'start' : i === weeks.length - 1 && weeks.length > 1 ? 'end' : 'middle'} fontSize={10} fill="currentColor">{weeks[i] ? weekLabel(weeks[i]) : ''}</text>
          ))}
          {series.map((s, si) => (
            <g key={s.name}>
              <path d={paths[si]} fill="none" stroke={s.color ?? SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => v !== null && (s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null ? (
                <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color ?? SERIES_COLORS[si % SERIES_COLORS.length]} />
              ) : null)}
            </g>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} stroke="currentColor" strokeOpacity={0.4} />}
          {hover !== null && series.map((s, si) => s.values[hover] !== null && (
            <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] as number)} r={4} fill={s.color ?? SERIES_COLORS[si % SERIES_COLORS.length]} stroke="var(--background)" strokeWidth={2} />
          ))}
          {weeks.map((w, i) => (
            <rect key={w} x={x(i) - plotW / Math.max(1, weeks.length - 1) / 2} y={pad.t} width={plotW / Math.max(1, weeks.length - 1)} height={plotH} fill="transparent"
              onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
          ))}
        </svg>
        {hover !== null && (
          <div data-kpi-tooltip className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
            style={x(hover) > width / 2 ? { right: width - x(hover) + 8 } : { left: x(hover) + 8 }}>
            <p className="font-medium">{weeks[hover]}</p>
            {series.map((s, si) => (
              <p key={s.name} className="flex items-center gap-1 whitespace-nowrap">
                <span className="inline-block size-2 rounded-full" style={{ background: s.color ?? SERIES_COLORS[si % SERIES_COLORS.length] }} />
                {s.name}: {formatValue(s.values[hover], unit)}
              </p>
            ))}
          </div>
        )}
      </div>
      {series.length > 1 && (
        <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs" data-kpi-legend>
          {series.map((s, si) => (
            <span key={s.name} className="inline-flex min-w-0 items-center gap-1">
              <span className="inline-block h-0.5 w-3 shrink-0" style={{ background: s.color ?? SERIES_COLORS[si % SERIES_COLORS.length] }} />
              <span className="min-w-0 break-all">{s.name}</span>
              <span className="text-muted-foreground">{formatValue(last(s.values), unit)}</span>
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  )
}

/** 縦の棒(週ごとの数・分布)。labels は棒の下の文字(多い時は間引く) */
export function BarChart({ labels, values, unit = 'count', height = 140, label, titles }: { labels: string[]; values: (number | null)[]; unit?: KpiUnit; height?: number; label: string; titles?: string[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const pad = { l: 34, r: 4, t: 8, b: 20 }
  const nums = values.filter((v): v is number => v !== null)
  const ticks = niceTicks(Math.min(0, ...nums), nums.length ? Math.max(...nums) : 1, 3)
  const lo = ticks[0]
  const hi = ticks[ticks.length - 1]
  const plotW = width - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const slot = plotW / Math.max(1, values.length)
  const barW = Math.max(1, slot - 2)
  const y = (v: number) => pad.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH
  const every = Math.max(1, Math.ceil(values.length / Math.max(1, Math.floor(plotW / 44))))
  return (
    <div ref={ref} className="w-full min-w-0" data-kpi-bars>
      <svg width={width} height={height} role="img" aria-label={label} className="block text-muted-foreground">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.5 : 0.15} />
            <text x={pad.l - 4} y={y(t) + 3} textAnchor="end" fontSize={10} fill="currentColor">{axisLabel(t, unit)}</text>
          </g>
        ))}
        {values.map((v, i) => v === null ? null : (
          <rect key={i} x={pad.l + i * slot + 1} y={Math.min(y(v), y(0))} width={barW} height={Math.max(v === 0 ? 0 : 1, Math.abs(y(v) - y(0)))} rx={Math.min(2, barW / 2)} fill="var(--kpi-1)">
            <title>{`${titles?.[i] ?? labels[i]}: ${formatValue(v, unit)}`}</title>
          </rect>
        ))}
        {labels.map((l, i) => i % every === 0 && (
          <text key={i} x={pad.l + i * slot + slot / 2} y={height - 6} textAnchor="middle" fontSize={10} fill="currentColor">{l}</text>
        ))}
      </svg>
    </div>
  )
}

/** 横棒の一覧(版・属性の数など。文字が長くても折り返す) */
export function HBarList({ items, unit = 'count', label }: { items: { label: string; value: number }[]; unit?: KpiUnit; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) return <p className="text-xs text-muted-foreground">ありません。</p>
  return (
    <ul className="space-y-1" aria-label={label} data-kpi-hbars>
      {items.map((it) => (
        <li key={it.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-xs">
          <span className="min-w-0 break-all">{it.label || '(未設定)'}</span>
          <span className="tabular-nums text-muted-foreground">{formatValue(it.value, unit)}</span>
          <span className="col-span-2 h-1.5 rounded-full bg-muted">
            <span className="block h-1.5 rounded-full" style={{ width: `${(it.value / max) * 100}%`, background: 'var(--kpi-1)' }} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** 小さな推移(表の中) */
export function Sparkline({ values, label, width = 72, height = 22 }: { values: (number | null)[]; label: string; width?: number; height?: number }) {
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length < 2) return <span className="text-muted-foreground">—</span>
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const x = (i: number) => 1 + ((width - 2) * i) / Math.max(1, values.length - 1)
  const y = (v: number) => height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4)
  let d = ''
  let open = false
  values.forEach((v, i) => {
    if (v === null) { open = false; return }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    open = true
  })
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block" data-kpi-spark>
      <path d={d} fill="none" stroke="var(--kpi-1)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** 登録した週ごとの続き具合(コホート)のマス目。値は割合(0〜1)と数 */
export function CohortGrid({ rows, maxOffset, label }: { rows: { week: string; size: number; counts: number[] }[]; maxOffset: number; label: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">この期間に登録した団体はありません。</p>
  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i)
  return (
    <div className="max-w-full overflow-x-auto" data-kpi-cohort>
      <table className="border-separate border-spacing-0.5 text-[11px]" aria-label={label}>
        <thead>
          <tr>
            <th className="px-1 text-left font-normal text-muted-foreground">登録した週</th>
            <th className="px-1 font-normal text-muted-foreground">団体</th>
            {offsets.map((o) => <th key={o} className="px-1 font-normal text-muted-foreground">{o}週</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.week}>
              <td className="px-1 whitespace-nowrap">{r.week}</td>
              <td className="px-1 text-center tabular-nums">{r.size}</td>
              {offsets.map((o) => {
                if (o >= r.counts.length) return <td key={o} />
                const rate = r.size ? r.counts[o] / r.size : 0
                return (
                  <td key={o} className="min-w-9 rounded px-1 py-0.5 text-center tabular-nums" title={`${r.week} 登録・${o}週目: ${r.counts[o]} / ${r.size}`}
                    style={{ background: `color-mix(in oklab, var(--kpi-1) ${Math.round(rate * 85)}%, transparent)`, color: rate > 0.55 ? '#ffffff' : undefined }}>
                    {Math.round(rate * 100)}%
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
