// 評価をスキルの根拠にする(画面の決まり。GAS の gas/src/42-evaluation-skills.gs と同じ)
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVALUATION_SKILL_RULES, applyPointDelta, assessmentPointDelta, canAssessSkill, cooldownUntil, evaluationApprovals,
  parseEvaluationSkillRules, serializeEvaluationSkillRules, validEvaluationSkillRules,
} from './evaluation-skills'
import { guardHarness } from './gas-guard-harness'
import type { AudienceContext } from './field-audiences'
import type { EvaluationRecord } from './types'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-24T00:00:00Z')
const ev = (id: string, evaluatorId: string, assessments: [string, number, number, number?][] = []): EvaluationRecord => ({
  id, date: '2026-10-01', evaluatorId, rating: 'A',
  ...(assessments.length ? { skillAssessments: assessments.map(([skill, level, points, daysAgo = 0]) => ({ skill, level: level as 1, points, at: new Date(NOW - daysAgo * DAY).toISOString() })) } : {}),
})

describe('評価のスキルの上限の設定', () => {
  it('読む: 空・壊れた値・範囲の外は既定。書く: 既定と同じ項目は書かない', () => {
    expect(parseEvaluationSkillRules('')).toEqual(DEFAULT_EVALUATION_SKILL_RULES)
    expect(parseEvaluationSkillRules('{')).toEqual(DEFAULT_EVALUATION_SKILL_RULES)
    expect(parseEvaluationSkillRules('{"maxPoints":2000,"cooldownDays":7}')).toEqual({ maxPoints: 100, cooldownDays: 7 })
    expect(serializeEvaluationSkillRules(DEFAULT_EVALUATION_SKILL_RULES)).toBe('')
    expect(serializeEvaluationSkillRules({ maxPoints: 50, cooldownDays: 30 })).toBe('{"maxPoints":50}')
    expect(validEvaluationSkillRules({ maxPoints: 0, cooldownDays: 365 })).toBe(true)
    expect(validEvaluationSkillRules({ maxPoints: 1.5, cooldownDays: 1 })).toBe(false)
    expect(validEvaluationSkillRules({ maxPoints: 1, cooldownDays: NaN })).toBe(false)
  })

  it('GAS と同じ値を受け付ける(GAS の読み方と同じ結果)', () => {
    const gas = guardHarness().c as unknown as { parseEvaluationSkillRules_: (raw: string) => unknown }
    for (const raw of ['', '{', '[]', '{"maxPoints":0}', '{"maxPoints":1001,"cooldownDays":0}', '{"cooldownDays":365.5}', '{"maxPoints":"5"}']) {
      expect(gas.parseEvaluationSkillRules_(raw), raw).toEqual(parseEvaluationSkillRules(raw))
    }
  })
})

describe('評価のスキルの見立て', () => {
  it('点数の増減: 新しい評価は足し、消した評価は引く。0 より下にしない', () => {
    const a = ev('e1', 'm1', [['企画', 2, 60]])
    const b = ev('e2', 'm1', [['企画', 3, 30], ['デザイン', 1, 10]])
    expect(assessmentPointDelta([a], [a, b])).toEqual({ 企画: 30, デザイン: 10 })
    expect(assessmentPointDelta([a, b], [b])).toEqual({ 企画: -60 })
    expect(assessmentPointDelta([a], [a])).toEqual({})
    expect(applyPointDelta({ 企画: 20 }, { 企画: -60, デザイン: 5 })).toEqual({ 企画: 0, デザイン: 5 })
  })

  it('条件「承認」に数える形にする(付けた人・レベル)', () => {
    expect(evaluationApprovals([ev('e1', 'm1', [['企画', 2, 60]]), ev('e2', 'm2')])).toEqual([
      expect.objectContaining({ skill: '企画', level: 2, byId: 'm1' }),
    ])
  })

  it('日数の制限: 同じ人・同じスキルだけ。日数を過ぎれば付けられる。0 なら制限なし', () => {
    const list = [ev('e1', 'm1', [['企画', 2, 60, 10]]), ev('e2', 'm2', [['デザイン', 2, 60, 1]])]
    const rules = { maxPoints: 100, cooldownDays: 30 }
    expect(cooldownUntil(list, 'm1', '企画', rules, NOW)?.getTime()).toBe(NOW + 20 * DAY)
    expect(cooldownUntil(list, 'm1', 'デザイン', rules, NOW)).toBeNull()
    expect(cooldownUntil(list, 'm2', '企画', rules, NOW)).toBeNull()
    expect(cooldownUntil(list, 'm1', '企画', { maxPoints: 100, cooldownDays: 10 }, NOW)).toBeNull()
    expect(cooldownUntil(list, 'm1', '企画', { maxPoints: 100, cooldownDays: 0 }, NOW)).toBeNull()
  })

  it('付けられる人: 代表・上長・部署長・メンター・プロジェクトの責任者。自分自身と関係の無い人は不可', () => {
    const ctx: AudienceContext = {
      members: [
        { id: 'top', role: 'top', reportsToId: null, mentorId: null, departmentPaths: [] },
        { id: 'boss', role: 'base', reportsToId: null, mentorId: null, departmentPaths: [] },
        { id: 'mentor', role: 'base', reportsToId: null, mentorId: null, departmentPaths: [] },
        { id: 'head', role: 'base', reportsToId: null, mentorId: null, departmentPaths: [] },
        { id: 'owner', role: 'base', reportsToId: null, mentorId: null, departmentPaths: [] },
        { id: 'lead', role: 'lead', reportsToId: null, mentorId: null, departmentPaths: [] },
        { id: 'x', role: 'base', reportsToId: 'boss', mentorId: 'mentor', departmentPaths: ['本部>開発'] },
      ],
      projects: [{ id: 'p1', ownerId: 'owner', memberIds: ['x'], parentId: null }],
      departmentTree: [{ path: '本部', headIds: ['head'] }],
      isAdminRole: (r) => r === 'lead' || r === 'top',
      isTopRole: (r) => r === 'top',
    }
    for (const id of ['top', 'boss', 'mentor', 'head', 'owner']) expect(canAssessSkill(id, 'x', ctx), id).toBe(true)
    expect(canAssessSkill('lead', 'x', ctx)).toBe(false)
    expect(canAssessSkill('x', 'x', ctx)).toBe(false)
    expect(canAssessSkill('top', 'top', ctx)).toBe(false)
  })
})
