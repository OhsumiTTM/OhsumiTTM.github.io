// 評価をスキルの根拠にする(v1.2。gas/src/42-evaluation-skills.gs):
// 評価に付けたスキルの見立ての点数をスキルの点数に足し、条件「承認」に数える。付けられるのは代表と、上長・部署長・メンター・
// プロジェクトの責任者だけ。上限(1回の点数・付け直せるまでの日数)は団体の設定で変えられる。評価を消すと点数を引く(レベルは下げない)
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import type { SkillLevelRules } from './skill-levels'

type H = ReturnType<typeof guardHarness>
type Res = { ok: boolean; error?: string; result?: unknown }
const RULES: SkillLevelRules = { default: { points: [50, 150, 350, 550, 750], conditions: { '2': [{ type: 'approval' }] } } }

const setup = (opts: { points?: string; settings?: [string, string][] } = {}) => {
  const h = guardHarness()
  const rows = h.sheets.Members.rows
  for (const c of ['mentor_id', 'department_path', 'skill_points_json', 'skill_levels_json', 'qualifications_json', 'quiz_passes_json', 'evaluation_history_json']) {
    if (rows[0].includes(c)) continue
    rows[0].push(c); rows.slice(1).forEach((r) => r.push(''))
  }
  const at = (c: string) => rows[0].indexOf(c)
  rows.find((r) => r[0] === 'm-base')![at('skill_points_json')] = opts.points ?? '{"企画":100}'
  rows.find((r) => r[0] === 'm-other')![at('department_path')] = '本部>開発'
  h.sheets.Settings.rows.push(['skill_level_rules', JSON.stringify(RULES)])
  for (const s of opts.settings ?? []) h.sheets.Settings.rows.push(s)
  return h
}
const member = (h: H, id: string) => {
  const [head, ...rows] = h.sheets.Members.rows
  const r = rows.find((x) => x[0] === id)!
  return Object.fromEntries(head.map((k, i) => [String(k), r[i]]))
}
const pointsOf = (h: H, id: string) => JSON.parse(String(member(h, id).skill_points_json || '{}')) as Record<string, number>
const levelsOf = (h: H, id: string) => JSON.parse(String(member(h, id).skill_levels_json || '[]')) as { skill: string; level: number }[]
const evalsOf = (h: H, id: string) => JSON.parse(String(member(h, id).evaluation_history_json || '[]')) as Record<string, unknown>[]
const now = () => new Date().toISOString()
const assessment = (extra: Record<string, unknown> = {}) => ({ skill: '企画', level: 2, points: 60, note: '企画書をまとめた', at: now(), ...extra })
const entry = (id: string, assessments?: unknown[], evaluatorId = 'm-lead') =>
  ({ id, date: '2026-10-20', evaluatorId, rating: 'A', ...(assessments ? { skillAssessments: assessments } : {}) })
const save = (h: H, who: string, memberId: string, entries: unknown[]) =>
  h.post({ action: 'updateEvaluationHistory', sessionToken: who, memberId, entries }) as Res

describe('評価をスキルの根拠にする', () => {
  it('上長が付けた見立ては、点数を足し、条件「承認」に数えてレベルを上げる', () => {
    const h = setup()
    const res = save(h, 'm-lead', 'm-base', [entry('e1', [assessment()])])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(pointsOf(h, 'm-base')).toEqual({ 企画: 160 })
    expect(levelsOf(h, 'm-base')).toEqual([expect.objectContaining({ skill: '企画', level: 2 })])
    expect(evalsOf(h, 'm-base')[0].skillAssessments).toEqual([expect.objectContaining({ skill: '企画', level: 2, points: 60 })])
  })

  it('見立ての無い評価は、今までどおり点数を変えない', () => {
    const h = setup()
    expect(save(h, 'm-lead', 'm-base', [entry('e1')]).ok).toBe(true)
    expect(pointsOf(h, 'm-base')).toEqual({ 企画: 100 })
  })

  it('付けられるのは代表と見る立場の人だけ。評価を書ける管理者でも、見る立場でなければ断る。自分自身には付けられない', () => {
    const h = setup()
    // m-lead は m-other の上長ではない(同じプロジェクトの班長として評価は書ける)
    const refused = save(h, 'm-lead', 'm-other', [entry('e1', [assessment()])])
    expect(refused.ok).toBe(false)
    expect(String(refused.error)).toMatch(/見る立場の人/)
    expect(save(h, 'm-lead', 'm-other', [entry('e1')]).ok).toBe(true)
    expect(save(h, 'm-top', 'm-other', [entry('e2', [assessment()], 'm-top')]).ok).toBe(true)
    expect(pointsOf(h, 'm-other')).toEqual({ 企画: 60 })
    expect(save(h, 'm-top', 'm-top', [entry('e3', [assessment()], 'm-top')]).ok).toBe(false)
  })

  it('部署長は、自分の部署(その下も)の人に付けられる', () => {
    const h = setup({ settings: [['department_tree_config', JSON.stringify([{ path: '本部', headIds: ['m-lead'] }])]] })
    const res = save(h, 'm-lead', 'm-other', [entry('e1', [assessment()])])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(pointsOf(h, 'm-other')).toEqual({ 企画: 60 })
  })

  it('点数の上限・日数の制限(既定 100点・30日)。団体の設定で変えられる', () => {
    const h = setup()
    expect(save(h, 'm-lead', 'm-base', [entry('e1', [assessment({ points: 101 })])]).error).toMatch(/100点まで/)
    expect(save(h, 'm-lead', 'm-base', [entry('e1', [assessment({ points: 100 })])]).ok).toBe(true)
    // 同じ人・同じスキルは30日に1回(別のスキルはよい)
    const first = evalsOf(h, 'm-base')
    const again = save(h, 'm-lead', 'm-base', [...first, entry('e2', [assessment()])])
    expect(again.error).toMatch(/30日/)
    expect(save(h, 'm-lead', 'm-base', [...first, entry('e2', [assessment({ skill: 'デザイン' })])]).ok).toBe(true)
    // ほかの見る立場の人(代表)は付けられる
    expect(save(h, 'm-top', 'm-base', [...evalsOf(h, 'm-base'), entry('e3', [assessment()], 'm-top')]).ok).toBe(true)

    const custom = setup({ settings: [['evaluation_skill_rules', JSON.stringify({ maxPoints: 300, cooldownDays: 0 })]] })
    expect(save(custom, 'm-lead', 'm-base', [entry('e1', [assessment({ points: 300 })])]).ok).toBe(true)
    expect(save(custom, 'm-lead', 'm-base', [...evalsOf(custom, 'm-base'), entry('e2', [assessment({ points: 300 })])]).ok).toBe(true)
    expect(pointsOf(custom, 'm-base')).toEqual({ 企画: 700 })
  })

  it('評価を消すと点数を引く(0 より下にしない)。レベルは下げない', () => {
    const h = setup({ points: '{"企画":100}' })
    expect(save(h, 'm-lead', 'm-base', [entry('e1', [assessment({ points: 80 })])]).ok).toBe(true)
    expect(pointsOf(h, 'm-base')).toEqual({ 企画: 180 })
    expect(levelsOf(h, 'm-base')).toEqual([expect.objectContaining({ skill: '企画', level: 2 })])
    expect(save(h, 'm-lead', 'm-base', []).ok).toBe(true)
    expect(pointsOf(h, 'm-base')).toEqual({ 企画: 100 })
    expect(levelsOf(h, 'm-base')).toEqual([expect.objectContaining({ skill: '企画', level: 2 })])
    // 点数が先に減っていても、0 より下にしない
    const low = setup({ points: '{}' })
    expect(save(low, 'm-lead', 'm-base', [entry('e1', [assessment({ points: 50 })])]).ok).toBe(true)
    low.sheets.Members.rows.find((r) => r[0] === 'm-base')![low.sheets.Members.rows[0].indexOf('skill_points_json')] = '{"企画":10}'
    expect(save(low, 'm-lead', 'm-base', []).ok).toBe(true)
    expect(pointsOf(low, 'm-base')).toEqual({ 企画: 0 })
  })

  it('付けた見立ては変えられない(評価のほかの項目は今までどおり)', () => {
    const h = setup()
    expect(save(h, 'm-lead', 'm-base', [entry('e1', [assessment()])]).ok).toBe(true)
    const stored = evalsOf(h, 'm-base')[0]
    const changed = { ...stored, skillAssessments: [{ ...(stored.skillAssessments as object[])[0], points: 100 }] }
    expect(save(h, 'm-lead', 'm-base', [changed]).error).toMatch(/変えられません/)
    expect(save(h, 'm-lead', 'm-base', [{ ...stored, skillAssessments: [] }]).ok).toBe(false)
    expect(save(h, 'm-lead', 'm-base', [{ ...stored, rating: 'B' }]).ok).toBe(true)
    expect(pointsOf(h, 'm-base')).toEqual({ 企画: 160 })
  })

  it('おかしな見立ては断り、何も書かない', () => {
    const h = setup()
    const bad: unknown[] = [
      'x', [assessment({ level: 6 })], [assessment({ level: '2' })], [assessment({ points: -1 })], [assessment({ points: 1.5 })],
      [assessment({ skill: '' })], [assessment({ skill: ' 企画' })], [assessment({ note: 'x'.repeat(501) })], [assessment({ extra: 1 })],
      [assessment(), assessment()], [assessment({ at: '2020-01-01T00:00:00Z' })], [assessment({ at: 'きのう' })],
      Array.from({ length: 21 }, (_, i) => assessment({ skill: 's' + i })),
    ]
    for (const a of bad) {
      const res = h.post({ action: 'updateEvaluationHistory', sessionToken: 'm-lead', memberId: 'm-base', entries: [{ ...entry('e1'), skillAssessments: a }] }) as Res
      expect(res.ok, JSON.stringify(a).slice(0, 80)).toBe(false)
    }
    expect(evalsOf(h, 'm-base')).toEqual([])
    expect(pointsOf(h, 'm-base')).toEqual({ 企画: 100 })
  })

  it('上限の設定の値を確かめる(代表が保存できる・範囲の外と知らない項目は断る)', () => {
    const h = setup()
    const set = (value: string) => h.post({ action: 'updateSetting', sessionToken: 'm-top', key: 'evaluation_skill_rules', value }) as Res
    expect(set(JSON.stringify({ maxPoints: 50, cooldownDays: 7 })).ok).toBe(true)
    for (const v of [{ maxPoints: 1001 }, { maxPoints: -1 }, { cooldownDays: 366 }, { cooldownDays: 1.5 }, { other: 1 }, []]) {
      expect(set(JSON.stringify(v)).ok, JSON.stringify(v)).toBe(false)
    }
    expect(set('{').ok).toBe(false)
  })

  it('スキルのレベルの承認(approveSkillLevel)も、部署長ができる', () => {
    const h = setup({ settings: [['department_tree_config', JSON.stringify([{ path: '本部', headIds: ['m-lead'] }])]] })
    const res = h.post({ action: 'approveSkillLevel', sessionToken: 'm-lead', memberId: 'm-other', skill: '企画', level: 2, reason: '企画書' }) as Res
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })
})
