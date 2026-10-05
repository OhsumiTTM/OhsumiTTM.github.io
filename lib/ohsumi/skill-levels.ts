// スキルのレベルの決め方(PR Z)。画面とGAS(gas/Code.gs の skillLevelOf_)で同じ決まりを使う
// (lib/ohsumi/skill-levels.test.ts が、同じ入力で同じ結果になることを確かめる)。
//
// レベル L になるのは、累計の点数がそのレベルの点数以上で、そのレベルの条件をすべて満たした時。
// 満たすレベルのうち、いちばん高いものになる(下のレベルの条件は問わない。これまでの計算と同じ)。
//   点数: スキルごとの一覧 → 団体の既定の一覧 → 組み込みの [50, 150, 350, 550, 750]
//   条件: レベルごとに、スキルごとの条件 → 団体の既定の条件 → 組み込みの条件
//         (組み込み: Lv.4 は関連する資格が1件以上、Lv.5 は外部評価の資格が3件以上)
//         空の一覧を設定すると、そのレベルは条件なしになる
// 何も設定しなければ、これまでの画面の計算(utils.ts の computeSkillLevel)と同じ結果になる。
// 保存されたレベルは下げない(レベルは上がる時だけ書き換える)。新しい計算より高いレベルが保存されている人は、
// 保存されたレベルのまま表示し、次のレベルまでの進み具合は 0 以上・必要な点数を超えないようにする(levelProgress)
import type { Qualification, SkillLevelValue } from './types'

export const SKILL_LEVELS = [1, 2, 3, 4, 5] as const
/** 組み込みの累計の点数(Lv.1〜5) */
export const BUILTIN_LEVEL_POINTS: readonly number[] = [50, 150, 350, 550, 750]

/** レベルに上がる条件 */
export type LevelCondition =
  // 関連する資格(relatedSkills にこのスキルを含む)が min 件以上。external: 外部評価の資格だけを数える
  | { type: 'qualification'; min: number; external?: boolean }
  // このスキルの検定(目標のレベルがこのレベル以上)に合格している
  | { type: 'quiz' }
  // このスキルを含む、担当して完了したタスクが min 件以上
  | { type: 'tasksDone'; min: number }
  // 見る立場の人・代表が、このスキルをこのレベル以上と認めている(Members の skill_approvals_json)
  | { type: 'approval' }

export type LevelConditions = Partial<Record<'1' | '2' | '3' | '4' | '5', LevelCondition[]>>

export interface SkillRule {
  /** Lv.1〜5 に必要な累計の点数(5つ。増えていく 0 以上の整数) */
  points?: number[]
  conditions?: LevelConditions
}

/** 団体の設定(Settings の skill_level_rules) */
export interface SkillLevelRules {
  default?: SkillRule
  skills?: Record<string, SkillRule>
}

export const BUILTIN_LEVEL_CONDITIONS: LevelConditions = {
  '4': [{ type: 'qualification', min: 1 }],
  '5': [{ type: 'qualification', min: 3, external: true }],
}

/** 検定の合格の記録(Members の quiz_passes_json) */
export interface QuizPass {
  quizId: string
  skill: string
  level: SkillLevelValue
  at: string
}

/** スキルのレベルの承認(Members の skill_approvals_json。GAS の approveSkillLevel が記録する) */
export interface SkillApproval {
  id: string
  skill: string
  level: SkillLevelValue
  reason: string
  /** 認めた人のメンバーID */
  byId: string
  at: string
}

/** 条件を確かめるための、その人の記録 */
export interface SkillEvidence {
  qualifications: Qualification[]
  quizPasses: QuizPass[]
  /** スキル → 担当して完了したタスクの数 */
  doneTaskCounts: Record<string, number>
  /** スキルのレベルの承認(無ければ空とみなす) */
  approvals?: SkillApproval[]
}

export const EMPTY_EVIDENCE: SkillEvidence = { qualifications: [], quizPasses: [], doneTaskCounts: {}, approvals: [] }

/** 点数の一覧として使えるか(5つ・0 以上の整数・増えていく) */
export function validLevelPoints(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length !== 5) return false
  for (let i = 0; i < 5; i++) {
    const n = v[i]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) return false
    if (i > 0 && n <= (v[i - 1] as number)) return false
  }
  return true
}

function validCondition(c: unknown): c is LevelCondition {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  if (o.type === 'quiz' || o.type === 'approval') return true
  if (o.type === 'qualification' || o.type === 'tasksDone') return typeof o.min === 'number' && Number.isInteger(o.min) && o.min >= 1 && o.min <= 1000
  return false
}

/** 設定の JSON を、使える形だけにする(壊れた部分は捨てる) */
export function parseSkillLevelRules(raw: unknown): SkillLevelRules {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}') } catch { obj = {} }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const src = obj as Record<string, unknown>
  const rule = (r: unknown): SkillRule | undefined => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined
    const o = r as Record<string, unknown>
    const out: SkillRule = {}
    if (validLevelPoints(o.points)) out.points = [...o.points]
    if (o.conditions && typeof o.conditions === 'object' && !Array.isArray(o.conditions)) {
      const conds: LevelConditions = {}
      for (const l of SKILL_LEVELS) {
        const list = (o.conditions as Record<string, unknown>)[String(l)]
        if (Array.isArray(list)) conds[String(l) as '1'] = list.filter(validCondition).map((c) => ({ ...c }))
      }
      if (Object.keys(conds).length) out.conditions = conds
    }
    return out.points || out.conditions ? out : undefined
  }
  const out: SkillLevelRules = {}
  const d = rule(src.default)
  if (d) out.default = d
  if (src.skills && typeof src.skills === 'object' && !Array.isArray(src.skills)) {
    const skills: Record<string, SkillRule> = {}
    for (const [name, r] of Object.entries(src.skills as Record<string, unknown>)) {
      const parsed = rule(r)
      if (parsed && name.trim()) skills[name.trim().slice(0, 100)] = parsed
    }
    if (Object.keys(skills).length) out.skills = skills
  }
  return out
}

/** そのスキルの点数の一覧 */
export function levelPointsFor(rules: SkillLevelRules, skill: string): number[] {
  return rules.skills?.[skill]?.points ?? rules.default?.points ?? [...BUILTIN_LEVEL_POINTS]
}

/** そのスキル・レベルの条件 */
export function levelConditionsFor(rules: SkillLevelRules, skill: string, level: SkillLevelValue): LevelCondition[] {
  const key = String(level) as '1'
  return rules.skills?.[skill]?.conditions?.[key] ?? rules.default?.conditions?.[key] ?? BUILTIN_LEVEL_CONDITIONS[key] ?? []
}

export function conditionMet(c: LevelCondition, skill: string, level: SkillLevelValue, ev: SkillEvidence): boolean {
  if (c.type === 'qualification') {
    const related = ev.qualifications.filter((q) => q.relatedSkills?.includes(skill) && (!c.external || q.external))
    return related.length >= c.min
  }
  if (c.type === 'quiz') return ev.quizPasses.some((p) => p.skill === skill && p.level >= level)
  if (c.type === 'approval') return (ev.approvals ?? []).some((a) => a.skill === skill && a.level >= level)
  return (ev.doneTaskCounts[skill] ?? 0) >= c.min
}

/** 点数と記録から決まるレベル(どのレベルにも届かなければ undefined) */
export function skillLevelOf(points: number, skill: string, ev: SkillEvidence, rules: SkillLevelRules = {}): SkillLevelValue | undefined {
  const table = levelPointsFor(rules, skill)
  for (let i = SKILL_LEVELS.length - 1; i >= 0; i--) {
    const level = SKILL_LEVELS[i]
    if (points < table[i]) continue
    if (levelConditionsFor(rules, skill, level).every((c) => conditionMet(c, skill, level, ev))) return level
  }
  return undefined
}

/**
 * 画面に出す今のレベルと、次のレベルまでの進み具合。
 * 今のレベルは、保存されたレベルと計算したレベルの高い方(保存されたレベルは下げない)。
 * 進み具合は、今のレベルの点数から次のレベルの点数までの間で数える。保存されたレベルが計算より高く、
 * 点数が今のレベルの点数に届いていない人は、0 から数える(負にしない)
 */
export interface LevelProgress {
  level: SkillLevelValue | 0
  nextLevel: SkillLevelValue | null
  /** 次のレベルに必要な累計の点数(最高レベルなら null) */
  nextPoints: number | null
  /** 次のレベルまで、あと何点か(0 以上) */
  remaining: number
  /** 0〜1 */
  ratio: number
  /** 点数は届いているが、条件を満たしていない(次のレベルの条件) */
  pendingConditions: LevelCondition[]
}

export function levelProgress(stored: SkillLevelValue | undefined, points: number, skill: string, ev: SkillEvidence, rules: SkillLevelRules = {}): LevelProgress {
  const pts = Number.isFinite(points) && points > 0 ? points : 0
  const computed = skillLevelOf(pts, skill, ev, rules) ?? 0
  const level = Math.max(stored ?? 0, computed) as SkillLevelValue | 0
  if (level >= 5) return { level, nextLevel: null, nextPoints: null, remaining: 0, ratio: 1, pendingConditions: [] }
  const table = levelPointsFor(rules, skill)
  const nextLevel = (level + 1) as SkillLevelValue
  const nextPoints = table[nextLevel - 1]
  const base = level === 0 ? 0 : Math.min(table[level - 1], nextPoints)
  const span = Math.max(1, nextPoints - base)
  const ratio = Math.min(1, Math.max(0, (pts - base) / span))
  const remaining = Math.max(0, nextPoints - pts)
  const pendingConditions = remaining === 0 ? levelConditionsFor(rules, skill, nextLevel).filter((c) => !conditionMet(c, skill, nextLevel, ev)) : []
  return { level, nextLevel, nextPoints, remaining, ratio, pendingConditions }
}

/** 担当して完了したタスクの数(スキルごと) */
export function doneTaskCountsOf(memberId: string, tasks: { assigneeIds: string[]; status: string; skills: string[] }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of tasks) {
    if (t.status !== 'done' || !t.assigneeIds.includes(memberId)) continue
    for (const s of t.skills) out[s] = (out[s] ?? 0) + 1
  }
  return out
}
