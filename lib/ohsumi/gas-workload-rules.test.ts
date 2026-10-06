// 稼働の目安の決め方(Settings の workload_rules): GAS は範囲と大小の関係を確かめ、おかしな値は保存しない。
// 範囲は画面(lib/ohsumi/workload-rules.ts)と同じ。団体のルールを持たない人は保存できない
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import { DEFAULT_WORKLOAD_RULES, WORKLOAD_RULE_RANGES } from './workload-rules'

type H = ReturnType<typeof guardHarness>
const put = (h: H, value: unknown, token = 'm-top') =>
  h.post({ action: 'updateSetting', sessionToken: token, key: 'workload_rules', value: typeof value === 'string' ? value : JSON.stringify(value) })
const saved = (h: H) => h.sheets.Settings.rows.find((r) => r[0] === 'workload_rules')?.[1]

describe('workload_rules の確かめ(GAS)', () => {
  it('範囲は画面と同じ', () => {
    const gas = (guardHarness().c as Record<string, unknown>).WORKLOAD_RULE_RANGES as Record<string, { min: number; max: number; integer?: boolean }>
    const strip = (r: Record<string, { min: number; max: number; integer?: boolean }>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { min: v.min, max: v.max, integer: !!v.integer }]))
    expect(strip(gas)).toEqual(strip(WORKLOAD_RULE_RANGES))
  })

  it('画面が送る値は通す(既定・端の値・一部だけ・空にする)', () => {
    const h = guardHarness()
    expect(put(h, DEFAULT_WORKLOAD_RULES).ok).toBe(true)
    expect(JSON.parse(String(saved(h)))).toEqual(DEFAULT_WORKLOAD_RULES)
    const mins = Object.fromEntries(Object.entries(WORKLOAD_RULE_RANGES).map(([k, r]) => [k, r.min]))
    expect(put(h, { ...mins, full_ratio: 0.1, available_ratio: 0.05, count_hold_and_review: false }).ok).toBe(true)
    const maxs = Object.fromEntries(Object.entries(WORKLOAD_RULE_RANGES).map(([k, r]) => [k, r.max]))
    expect(put(h, maxs).ok).toBe(true)
    expect(put(h, { window_days: 30 }).ok).toBe(true)
    expect(put(h, '').ok).toBe(true)
  })

  it('おかしな値は断り、保存しない', () => {
    const h = guardHarness()
    const bad: unknown[] = [
      '{not json',
      [1, 2],
      { available_ratio: 1.2, full_ratio: 1.2 },
      { available_ratio: 2, full_ratio: 1 },
      { full_ratio: 0.5 }, // 既定の available_ratio(0.6)以下
      { available_ratio: 1.5 }, // 既定の full_ratio(1.2)以上
      { window_days: 13 },
      { window_days: 366 },
      { window_days: 30.5 },
      { fallback_hours: 0.4 },
      { fallback_hours: 41 },
      { no_history_normal_max_hours: -1 },
      { no_history_normal_max_hours: 201 },
      { low_workload_task_threshold: 11 },
      { low_workload_task_threshold: 0.5 },
      { count_hold_and_review: 'yes' },
      { available_ratio: '0.6' },
      { magic: 1 },
    ]
    for (const v of bad) expect(put(h, v).ok, JSON.stringify(v)).toBe(false)
    expect(saved(h)).toBeUndefined()
  })

  it('団体のルールを持たない人は保存できない', () => {
    const h = guardHarness()
    expect(put(h, { window_days: 30 }, 'm-base').ok).toBe(false)
    expect(saved(h)).toBeUndefined()
  })
})
