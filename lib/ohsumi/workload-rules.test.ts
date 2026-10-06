import { describe, expect, it } from 'vitest'
import type { Member, Task, TaskStatus } from './types'
import {
  countWorkloadCapacities,
  isLowWorkloadMember,
  memberWeeklyThroughput,
  memberWorkloadCapacity,
  suggestWorkloadRebalance,
  type WorkloadCapacity,
} from './utils'
import {
  DEFAULT_WORKLOAD_RULES,
  isDefaultWorkloadRules,
  normalizeWorkloadRules,
  parseWorkloadRules,
  workloadRuleProblems,
} from './workload-rules'

// 設定を足す前の計算(定数で決めていた頃)の写し。既定の設定で結果が1つも変わらないことを確かめる
const LEGACY = { FALLBACK: 2, AVAILABLE: 0.6, FULL: 1.2, LOW: 1 }
function legacyThroughput(memberId: string, allTasks: Task[], now: Date, windowDays = 90): number {
  const cutoff = new Date(now.getTime() - windowDays * 86400000)
  const completed = allTasks.filter((t) => {
    if (t.status !== 'done' || !t.assigneeIds.includes(memberId) || !t.completedDate) return false
    const d = new Date(t.completedDate)
    return !Number.isNaN(d.getTime()) && d >= cutoff
  })
  if (completed.length === 0) return 0
  return completed.reduce((s, t) => s + (t.actualHours ?? t.estimatedHours ?? LEGACY.FALLBACK), 0) / (windowDays / 7)
}
function legacyCapacity(memberId: string, allTasks: Task[], now: Date): WorkloadCapacity {
  const load = allTasks
    .filter((t) => t.assigneeIds.includes(memberId) && t.status !== 'done')
    .reduce((s, t) => s + (t.estimatedHours ?? LEGACY.FALLBACK), 0)
  const avg = legacyThroughput(memberId, allTasks, now)
  if (avg === 0) {
    if (load === 0) return 'available'
    return load <= LEGACY.FALLBACK * 3 ? 'normal' : 'full'
  }
  const ratio = load / avg
  if (ratio < LEGACY.AVAILABLE) return 'available'
  if (ratio < LEGACY.FULL) return 'normal'
  return 'full'
}
function legacyLow(memberId: string, allTasks: Task[], now: Date): boolean {
  const n = allTasks.filter((t) => t.assigneeIds.includes(memberId) && t.status !== 'done').length
  if (n > LEGACY.LOW) return false
  return legacyCapacity(memberId, allTasks, now) === 'available'
}

// 決まった種から作る、いろいろなタスクの組み合わせ
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const STATUSES: TaskStatus[] = ['todo', 'hold', 'progress', 'support', 'review', 'fix', 'done']
const NOW = new Date('2026-10-06T00:00:00Z')
function randomWorld(seed: number) {
  const r = rng(seed)
  const memberIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
  const tasks: Task[] = []
  const n = Math.floor(r() * 40)
  for (let i = 0; i < n; i++) {
    const status = STATUSES[Math.floor(r() * STATUSES.length)]
    const assignees = memberIds.filter(() => r() < 0.3)
    const daysAgo = Math.floor(r() * 200)
    tasks.push({
      id: `t${i}`,
      assigneeIds: assignees,
      skills: r() < 0.5 ? ['react'] : ['python'],
      status,
      estimatedHours: r() < 0.3 ? undefined : Math.round(r() * 20 * 2) / 2,
      actualHours: r() < 0.5 ? undefined : Math.round(r() * 20 * 2) / 2,
      completedDate: status === 'done' && r() < 0.9 ? new Date(NOW.getTime() - daysAgo * 86400000).toISOString().slice(0, 10) : undefined,
    } as unknown as Task)
  }
  const members = memberIds.map((id, i) => ({ id, name: id, skills: i % 2 ? ['react'] : ['python'] }) as unknown as Member)
  return { tasks, members, memberIds }
}

describe('稼働の目安: 既定の設定では、今までと結果が1つも変わらない', () => {
  it('300 通りの組み合わせで、余力・ペース・低稼働の判定が同じ', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { tasks, memberIds } = randomWorld(seed)
      for (const id of memberIds) {
        expect(memberWeeklyThroughput(id, tasks, NOW)).toBe(legacyThroughput(id, tasks, NOW))
        expect(memberWorkloadCapacity(id, tasks, NOW)).toBe(legacyCapacity(id, tasks, NOW))
        expect(memberWorkloadCapacity(id, tasks, NOW, DEFAULT_WORKLOAD_RULES)).toBe(legacyCapacity(id, tasks, NOW))
        expect(memberWorkloadCapacity(id, tasks, NOW, parseWorkloadRules(''))).toBe(legacyCapacity(id, tasks, NOW))
        expect(isLowWorkloadMember(id, tasks, DEFAULT_WORKLOAD_RULES, NOW)).toBe(legacyLow(id, tasks, NOW))
      }
    }
  })

  it('負荷分散の提案も、設定を渡しても渡さなくても同じ', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { tasks, members } = randomWorld(seed)
      expect(suggestWorkloadRebalance(members, tasks, DEFAULT_WORKLOAD_RULES, NOW)).toEqual(suggestWorkloadRebalance(members, tasks, undefined, NOW))
    }
  })
})

describe('稼働の目安: 団体の設定を使う', () => {
  const task = (id: string, assignee: string, status: TaskStatus, extra: Partial<Task> = {}) =>
    ({ id, assigneeIds: [assignee], skills: [], status, ...extra }) as unknown as Task

  it('境目を変えると、同じ負荷でも結果が変わる', () => {
    // 普段のペース: 90日で 13h → 週 1.011h。今の負荷 1h → 比率 ≈ 0.99
    const tasks = [task('d', 'm', 'done', { actualHours: 13, completedDate: '2026-09-01' }), task('a', 'm', 'progress', { estimatedHours: 1 })]
    expect(memberWorkloadCapacity('m', tasks, NOW)).toBe('normal')
    expect(memberWorkloadCapacity('m', tasks, NOW, { ...DEFAULT_WORKLOAD_RULES, available_ratio: 1.0, full_ratio: 2 })).toBe('available')
    expect(memberWorkloadCapacity('m', tasks, NOW, { ...DEFAULT_WORKLOAD_RULES, full_ratio: 0.9 })).toBe('full')
  })

  it('保留・確認待ちを含めない設定では、今の負荷から除く', () => {
    const tasks = [1, 2, 3, 4].map((i) => task(`h${i}`, 'm', i % 2 ? 'hold' : 'review'))
    expect(memberWorkloadCapacity('m', tasks, NOW)).toBe('full')
    expect(memberWorkloadCapacity('m', tasks, NOW, { ...DEFAULT_WORKLOAD_RULES, count_hold_and_review: false })).toBe('available')
    expect(isLowWorkloadMember('m', tasks, { ...DEFAULT_WORKLOAD_RULES, count_hold_and_review: false }, NOW)).toBe(true)
  })

  it('想定時間が空のタスクの時間・完了の無い人の上限・期間を使う', () => {
    const tasks = [task('a', 'm', 'todo'), task('b', 'm', 'todo')]
    expect(memberWorkloadCapacity('m', tasks, NOW)).toBe('normal') // 4h ≤ 6h
    expect(memberWorkloadCapacity('m', tasks, NOW, { ...DEFAULT_WORKLOAD_RULES, fallback_hours: 4 })).toBe('full') // 8h > 6h
    expect(memberWorkloadCapacity('m', tasks, NOW, { ...DEFAULT_WORKLOAD_RULES, no_history_normal_max_hours: 3 })).toBe('full')
    const old = [task('d', 'm', 'done', { actualHours: 10, completedDate: '2026-08-01' })]
    expect(memberWeeklyThroughput('m', old, NOW)).toBeGreaterThan(0)
    expect(memberWeeklyThroughput('m', old, NOW, { ...DEFAULT_WORKLOAD_RULES, window_days: 30 })).toBe(0)
  })

  it('低稼働の知らせの件数', () => {
    const tasks = [task('a', 'm', 'todo', { estimatedHours: 0.5 }), task('b', 'm', 'todo', { estimatedHours: 0.5 })]
    expect(isLowWorkloadMember('m', tasks, DEFAULT_WORKLOAD_RULES, NOW)).toBe(false)
    expect(isLowWorkloadMember('m', tasks, { ...DEFAULT_WORKLOAD_RULES, no_history_normal_max_hours: 0, low_workload_task_threshold: 2 }, NOW)).toBe(false)
    expect(isLowWorkloadMember('m', [], { ...DEFAULT_WORKLOAD_RULES, low_workload_task_threshold: 0 }, NOW)).toBe(true)
  })

  it('人数の集計', () => {
    const members = ['a', 'b', 'c'].map((id) => ({ id }) as unknown as Member)
    const tasks = [1, 2, 3, 4].map((i) => task(`t${i}`, 'c', 'todo'))
    expect(countWorkloadCapacities(members, tasks, DEFAULT_WORKLOAD_RULES, NOW)).toEqual({ available: 2, normal: 0, full: 1 })
  })
})

describe('workload_rules の読み込みと確かめ', () => {
  it('空・壊れた値は既定', () => {
    expect(parseWorkloadRules(undefined)).toEqual(DEFAULT_WORKLOAD_RULES)
    expect(parseWorkloadRules('{oops')).toEqual(DEFAULT_WORKLOAD_RULES)
    expect(parseWorkloadRules('[1]')).toEqual(DEFAULT_WORKLOAD_RULES)
    expect(isDefaultWorkloadRules(parseWorkloadRules(''))).toBe(true)
  })

  it('書いた項目だけを使い、範囲の外は既定にする', () => {
    const r = parseWorkloadRules(JSON.stringify({ window_days: 30, fallback_hours: 100, count_hold_and_review: false, low_workload_task_threshold: 1.5 }))
    expect(r.window_days).toBe(30)
    expect(r.fallback_hours).toBe(2)
    expect(r.count_hold_and_review).toBe(false)
    expect(r.low_workload_task_threshold).toBe(1)
  })

  it('大小の関係が崩れていたら、境目を2つとも既定にする', () => {
    const r = normalizeWorkloadRules({ available_ratio: 2, full_ratio: 1 })
    expect([r.available_ratio, r.full_ratio]).toEqual([0.6, 1.2])
  })

  it('画面の確かめ: 範囲と大小の関係', () => {
    expect(workloadRuleProblems(DEFAULT_WORKLOAD_RULES)).toEqual([])
    expect(workloadRuleProblems({ ...DEFAULT_WORKLOAD_RULES, window_days: 13 })).toEqual([{ key: 'window_days', kind: 'range' }])
    expect(workloadRuleProblems({ ...DEFAULT_WORKLOAD_RULES, window_days: 20.5 })).toEqual([{ key: 'window_days', kind: 'range' }])
    expect(workloadRuleProblems({ ...DEFAULT_WORKLOAD_RULES, full_ratio: 0.6 })).toEqual([{ key: 'full_ratio', kind: 'order' }])
    expect(workloadRuleProblems({ ...DEFAULT_WORKLOAD_RULES, fallback_hours: Number.NaN })).toEqual([{ key: 'fallback_hours', kind: 'range' }])
  })
})
