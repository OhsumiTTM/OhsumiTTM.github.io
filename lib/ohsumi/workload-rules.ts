// 稼働の目安(余力あり・普通・余力なし)の決め方。団体ごとに Settings の workload_rules(JSON)で変えられる。
// 書いていない項目・範囲の外の値は既定に戻す。GAS は保存の前に同じ範囲を確かめる
// (gas/src/37-value-checks.gs の checkWorkloadRules_)。
export interface WorkloadRules {
  // 「余力あり」の上限(今の負荷 ÷ 普段のペース がこれ未満)
  available_ratio: number
  // 「余力なし」の下限(これ以上)。available_ratio より大きい
  full_ratio: number
  // 普段のペースを数える期間(日)
  window_days: number
  // 想定時間が空のタスクの時間
  fallback_hours: number
  // 完了したタスクが無い人の「普通」の上限(時間)
  no_history_normal_max_hours: number
  // 今の負荷に保留・確認待ちを含めるか
  count_hold_and_review: boolean
  // 「稼働に余裕があるようです」と知らせる未完了のタスクの件数(これ以下)
  low_workload_task_threshold: number
}

export const DEFAULT_WORKLOAD_RULES: WorkloadRules = Object.freeze({
  available_ratio: 0.6,
  full_ratio: 1.2,
  window_days: 90,
  fallback_hours: 2,
  no_history_normal_max_hours: 6,
  count_hold_and_review: true,
  low_workload_task_threshold: 1,
})

type NumberKey = Exclude<keyof WorkloadRules, 'count_hold_and_review'>

// 数の項目の範囲(GAS の WORKLOAD_RULE_RANGES と同じ)。integer は整数だけ
export const WORKLOAD_RULE_RANGES: Record<NumberKey, { min: number; max: number; step: number; integer?: boolean }> = {
  available_ratio: { min: 0.05, max: 5, step: 0.05 },
  full_ratio: { min: 0.1, max: 10, step: 0.05 },
  window_days: { min: 14, max: 365, step: 1, integer: true },
  fallback_hours: { min: 0.5, max: 40, step: 0.5 },
  no_history_normal_max_hours: { min: 0, max: 200, step: 0.5 },
  low_workload_task_threshold: { min: 0, max: 10, step: 1, integer: true },
}

export const WORKLOAD_RULE_NUMBER_KEYS = Object.keys(WORKLOAD_RULE_RANGES) as NumberKey[]

export type WorkloadRuleProblem = { key: keyof WorkloadRules; kind: 'range' | 'order' }

function numberInRange(key: NumberKey, v: unknown): boolean {
  const r = WORKLOAD_RULE_RANGES[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  if (r.integer && Math.floor(v) !== v) return false
  return v >= r.min && v <= r.max
}

// 入力の確かめ(画面で、保存の前に)。問題が無ければ空
export function workloadRuleProblems(rules: WorkloadRules): WorkloadRuleProblem[] {
  const out: WorkloadRuleProblem[] = []
  for (const key of WORKLOAD_RULE_NUMBER_KEYS) if (!numberInRange(key, rules[key])) out.push({ key, kind: 'range' })
  if (
    numberInRange('available_ratio', rules.available_ratio) &&
    numberInRange('full_ratio', rules.full_ratio) &&
    !(rules.full_ratio > rules.available_ratio)
  ) {
    out.push({ key: 'full_ratio', kind: 'order' })
  }
  return out
}

// 保存されている値を読む。範囲の外・形の違う項目は既定にする。大小の関係が崩れていたら2つとも既定にする
export function normalizeWorkloadRules(raw: unknown): WorkloadRules {
  const out: WorkloadRules = { ...DEFAULT_WORKLOAD_RULES }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const obj = raw as Record<string, unknown>
  for (const key of WORKLOAD_RULE_NUMBER_KEYS) if (numberInRange(key, obj[key])) out[key] = obj[key] as number
  if (typeof obj.count_hold_and_review === 'boolean') out.count_hold_and_review = obj.count_hold_and_review
  if (!(out.full_ratio > out.available_ratio)) {
    out.available_ratio = DEFAULT_WORKLOAD_RULES.available_ratio
    out.full_ratio = DEFAULT_WORKLOAD_RULES.full_ratio
  }
  return out
}

export function parseWorkloadRules(value: string | undefined): WorkloadRules {
  if (!value) return { ...DEFAULT_WORKLOAD_RULES }
  try {
    return normalizeWorkloadRules(JSON.parse(value))
  } catch {
    return { ...DEFAULT_WORKLOAD_RULES }
  }
}

export function isDefaultWorkloadRules(rules: WorkloadRules): boolean {
  return (Object.keys(DEFAULT_WORKLOAD_RULES) as (keyof WorkloadRules)[]).every((k) => rules[k] === DEFAULT_WORKLOAD_RULES[k])
}
