// 評価をスキルの根拠にする(v1.2。GAS は gas/src/42-evaluation-skills.gs。同じ決まり)
//   ・評価の1件に、スキルの見立て(スキル・レベル・点数・理由)を付けられる
//   ・点数はその人のスキルの点数に足す。評価を消すと引く(0 より下にしない)。レベルは下げない
//   ・見立ては、レベルの条件「承認」に数える
//   ・付けられるのは代表と、上長・部署長・メンター・プロジェクトの責任者。自分自身には付けられない
//   ・上限は団体の設定 evaluation_skill_rules(1回の点数の上限・同じスキルに付け直せるまでの日数)
import { audienceAllows, type AudienceContext } from './field-audiences'
import type { EvaluationRecord, SkillAssessment } from './types'
import type { SkillApproval } from './skill-levels'

export interface EvaluationSkillRules {
  /** 1回の評価で、1つのスキルに付けられる点数の上限(0〜1000) */
  maxPoints: number
  /** 同じ人が同じ相手の同じスキルに付けられるのは、この日数に1回(0 で制限なし。0〜365) */
  cooldownDays: number
}

export const DEFAULT_EVALUATION_SKILL_RULES: EvaluationSkillRules = { maxPoints: 100, cooldownDays: 30 }
export const EVALUATION_SKILL_LIMITS = {
  maxPoints: { min: 0, max: 1000 },
  cooldownDays: { min: 0, max: 365 },
} as const
export const EVALUATION_SKILLS_MAX = 20
export const EVALUATION_SKILL_NOTE_MAX = 500

const DAY_MS = 24 * 60 * 60 * 1000

function inRange(v: unknown, key: keyof typeof EVALUATION_SKILL_LIMITS): v is number {
  const r = EVALUATION_SKILL_LIMITS[key]
  return typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max
}

/** Settings の値を読む。壊れた値・範囲の外の項目は既定 */
export function parseEvaluationSkillRules(raw: string | undefined | null): EvaluationSkillRules {
  const out = { ...DEFAULT_EVALUATION_SKILL_RULES }
  if (!raw) return out
  let v: unknown
  try { v = JSON.parse(raw) } catch { return out }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const o = v as Record<string, unknown>
  if (inRange(o.maxPoints, 'maxPoints')) out.maxPoints = o.maxPoints
  if (inRange(o.cooldownDays, 'cooldownDays')) out.cooldownDays = o.cooldownDays
  return out
}

/** 保存する値(既定と同じ項目は書かない。すべて既定なら空 = 設定を消す) */
export function serializeEvaluationSkillRules(rules: EvaluationSkillRules): string {
  const o: Partial<EvaluationSkillRules> = {}
  if (rules.maxPoints !== DEFAULT_EVALUATION_SKILL_RULES.maxPoints) o.maxPoints = rules.maxPoints
  if (rules.cooldownDays !== DEFAULT_EVALUATION_SKILL_RULES.cooldownDays) o.cooldownDays = rules.cooldownDays
  return Object.keys(o).length ? JSON.stringify(o) : ''
}

export function validEvaluationSkillRules(rules: EvaluationSkillRules): boolean {
  return inRange(rules.maxPoints, 'maxPoints') && inRange(rules.cooldownDays, 'cooldownDays')
}

/** 評価に付けたスキルの見立てを、レベルの条件「承認」の形にする */
export function evaluationApprovals(entries: readonly EvaluationRecord[] | undefined): SkillApproval[] {
  const out: SkillApproval[] = []
  for (const e of entries ?? []) {
    for (const a of e.skillAssessments ?? []) {
      out.push({ id: `${e.id}:${a.skill}`, skill: a.skill, level: a.level, reason: a.note ?? '', byId: e.evaluatorId, at: a.at })
    }
  }
  return out
}

/** 前の一覧から次の一覧にした時の、スキルごとの点数の増減(新しい評価の見立ては足し、消した評価の見立ては引く) */
export function assessmentPointDelta(prev: readonly EvaluationRecord[] | undefined, next: readonly EvaluationRecord[]): Record<string, number> {
  const delta: Record<string, number> = {}
  const add = (a: SkillAssessment, sign: 1 | -1) => { delta[a.skill] = (delta[a.skill] ?? 0) + sign * a.points }
  const prevIds = new Set((prev ?? []).map((e) => e.id))
  const nextIds = new Set(next.map((e) => e.id))
  for (const e of next) if (!prevIds.has(e.id)) (e.skillAssessments ?? []).forEach((a) => add(a, 1))
  for (const e of prev ?? []) if (!nextIds.has(e.id)) (e.skillAssessments ?? []).forEach((a) => add(a, -1))
  for (const k of Object.keys(delta)) if (!delta[k]) delete delta[k]
  return delta
}

/** 点数に増減を当てる(0 より下にしない) */
export function applyPointDelta(points: Record<string, number> | undefined, delta: Record<string, number>): Record<string, number> {
  const out = { ...(points ?? {}) }
  for (const [skill, d] of Object.entries(delta)) out[skill] = Math.max(0, (out[skill] ?? 0) + d)
  return out
}

/** この人(evaluatorId)が、このスキルにまだ付けられない時は、次に付けられる日時。付けられるなら null */
export function cooldownUntil(
  entries: readonly EvaluationRecord[] | undefined,
  evaluatorId: string,
  skill: string,
  rules: EvaluationSkillRules,
  now: number = Date.now(),
): Date | null {
  if (rules.cooldownDays <= 0) return null
  let latest = 0
  for (const e of entries ?? []) {
    if (e.evaluatorId !== evaluatorId) continue
    for (const a of e.skillAssessments ?? []) {
      if (a.skill !== skill) continue
      const t = Date.parse(a.at)
      if (Number.isFinite(t) && t > latest) latest = t
    }
  }
  const until = latest + rules.cooldownDays * DAY_MS
  return latest && until > now ? new Date(until) : null
}

/** 評価にスキルを付けられるか(代表と、上長・部署長・メンター・プロジェクトの責任者。自分自身は不可) */
export function canAssessSkill(viewerId: string, memberId: string, ctx: AudienceContext): boolean {
  if (!viewerId || viewerId === memberId) return false
  return audienceAllows(['boss', 'deptHead', 'mentor', 'projectOwner'], viewerId, memberId, ctx)
}
