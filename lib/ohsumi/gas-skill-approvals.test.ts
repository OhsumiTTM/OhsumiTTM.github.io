// スキルのレベルの承認(approveSkillLevel): 代表と、その人を見る立場の人(報告先をたどった上の人・メンター・
// その人が入るプロジェクトの責任者)だけが「スキル○○を Lv.○ と認める」を理由と一緒に記録できる。自分には記録できない。
// 誰が・いつ・何を認めたかを Members の skill_approvals_json に残す。skill_level_rules の条件 {type:'approval'} を満たす
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import { parseSkillLevelRules, skillLevelOf, EMPTY_EVIDENCE, type SkillApproval, type SkillLevelRules } from './skill-levels'

type H = ReturnType<typeof guardHarness>
const setup = (opts: { rules?: SkillLevelRules; points?: string } = {}) => {
  const h = guardHarness()
  const rows = h.sheets.Members.rows
  for (const c of ['withdrawn_at', 'mentor_id', 'skill_points_json', 'skill_levels_json', 'qualifications_json', 'quiz_passes_json']) {
    rows[0].push(c); rows.slice(1).forEach((r) => r.push(''))
  }
  const at = (c: string) => rows[0].indexOf(c)
  rows.find((r) => r[0] === 'm-base')![at('skill_points_json')] = opts.points ?? '{"企画":200}'
  rows.find((r) => r[0] === 'm-victim')![at('mentor_id')] = 'm-other'
  rows.find((r) => r[0] === 'm-off')![at('withdrawn_at')] = '2026-09-01T00:00:00Z'
  if (opts.rules) h.sheets.Settings.rows.push(['skill_level_rules', JSON.stringify(opts.rules)])
  return h
}
const approve = (h: H, who: string, memberId: string, extra: Record<string, unknown> = {}) =>
  h.post({ action: 'approveSkillLevel', sessionToken: who, memberId, skill: '企画', level: 2, reason: '企画書をまとめた', ...extra })
const member = (h: H, id: string) => {
  const [head, ...rows] = h.sheets.Members.rows
  const r = rows.find((x) => x[0] === id)!
  return Object.fromEntries(head.map((k, i) => [String(k), r[i]]))
}
const RULES: SkillLevelRules = { default: { conditions: { '2': [{ type: 'approval' }] } } }

describe('スキルのレベルの承認', () => {
  it('見る立場の人(報告先)・メンター・プロジェクトの責任者・代表は記録でき、誰が・いつ・何を認めたかが残る', () => {
    const h = setup()
    const res = approve(h, 'm-lead', 'm-base')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const list = JSON.parse(String(member(h, 'm-base').skill_approvals_json)) as SkillApproval[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ skill: '企画', level: 2, reason: '企画書をまとめた', byId: 'm-lead' })
    expect(Date.parse(list[0].at)).toBeGreaterThan(0)
    expect(approve(h, 'm-other', 'm-victim').ok).toBe(true) // メンター
    expect(approve(h, 'm-top', 'm-other').ok).toBe(true) // 代表
    const owner = setup()
    owner.sheets.Projects.rows[0].push('owner_id')
    owner.sheets.Projects.rows[1].push('m-victim')
    expect(approve(owner, 'm-victim', 'm-base').ok).toBe(true) // プロジェクトの責任者
  })

  it('自分自身・見る立場でない人(管理者の役職でも)・退会した相手・おかしな値は断り、何も書かない', () => {
    const h = setup()
    const refused: [string, string, Record<string, unknown>][] = [
      ['m-base', 'm-base', {}],
      ['m-top', 'm-top', {}],
      ['m-other', 'm-base', {}],
      ['m-lead', 'm-other', {}],
      ['m-top', 'm-off', {}],
      ['m-lead', 'm-base', { level: 6 }],
      ['m-lead', 'm-base', { level: '2' }],
      ['m-lead', 'm-base', { reason: '' }],
      ['m-lead', 'm-base', { reason: 'x'.repeat(501) }],
      ['m-lead', 'm-base', { skill: '' }],
      ['m-lead', 'm-base', { skill: { a: 1 } }],
    ]
    for (const [who, target, extra] of refused) {
      const res = approve(h, who, target, extra)
      expect(res.ok, `${who}→${target} ${JSON.stringify(extra)}`).toBe(false)
    }
    expect(h.sheets.Members.rows[0].includes('skill_approvals_json') ? String(member(h, 'm-base').skill_approvals_json || '') : '').toBe('')
  })

  it('条件「承認」: 認めた記録があればそのレベルに上がる。無ければ今までどおり', () => {
    const h = setup({ rules: RULES })
    const gas = h.c as unknown as { skillLevelOf_: (p: number, s: string, ev: object, r: object) => number; parseSkillLevelRules_: (r: unknown) => object }
    const rules = gas.parseSkillLevelRules_(JSON.stringify(RULES))
    expect(gas.skillLevelOf_(200, '企画', { approvals: [] }, rules)).toBe(1)
    const res = approve(h, 'm-lead', 'm-base')
    expect(res.result.newLevels).toEqual([expect.objectContaining({ skill: '企画', level: 2 })])
    expect(JSON.parse(String(member(h, 'm-base').skill_levels_json))).toEqual([expect.objectContaining({ skill: '企画', level: 2 })])
    // 別のスキル・低いレベルの承認では満たさない
    expect(gas.skillLevelOf_(200, '企画', { approvals: [{ skill: '企画', level: 1 }, { skill: '別', level: 5 }] }, rules)).toBe(1)
    // 承認だけでは、点数が足りないレベルにはならない
    expect(gas.skillLevelOf_(100, '企画', { approvals: [{ skill: '企画', level: 5 }] }, rules)).toBe(1)
  })

  it('画面と GAS で同じ結果になる(承認の条件)', () => {
    const h = setup()
    const gas = h.c as unknown as { skillLevelOf_: (p: number, s: string, ev: object, r: object) => number; parseSkillLevelRules_: (r: unknown) => object }
    const raw = { default: { conditions: { '2': [{ type: 'approval' }], '4': [{ type: 'approval' }, { type: 'qualification', min: 1 }] } } }
    const ts = parseSkillLevelRules(raw)
    const g = gas.parseSkillLevelRules_(JSON.stringify(raw))
    expect(ts.default?.conditions?.['2']).toEqual([{ type: 'approval' }])
    for (const points of [0, 60, 200, 400, 600, 800]) {
      for (const lvl of [0, 1, 2, 3, 4, 5]) {
        const approvals = lvl ? [{ id: 'a', skill: '企画', level: lvl, reason: 'r', byId: 'm', at: '' }] as SkillApproval[] : []
        const qualifications = [{ id: 'q', name: 'Q', relatedSkills: ['企画'] }]
        const ev = { ...EMPTY_EVIDENCE, approvals, qualifications }
        expect(gas.skillLevelOf_(points, '企画', ev, g), `${points}点・承認Lv${lvl}`).toBe(skillLevelOf(points, '企画', ev, ts) ?? 0)
      }
    }
  })

  it('承認の記録は、本人と見る立場の人にだけ返す', () => {
    const h = setup()
    approve(h, 'm-lead', 'm-base')
    const seen = (who: string) => {
      const t = h.post({ action: 'getInitialData', sessionToken: who }).result.sheets.Members as { headers: string[]; rows: string[][] }
      const row = t.rows.find((r) => r[t.headers.indexOf('id')] === 'm-base')!
      return row[t.headers.indexOf('skill_approvals_json')]
    }
    expect(seen('m-other')).toBe('')
    expect(seen('m-base')).toContain('企画書をまとめた')
    expect(seen('m-lead')).toContain('企画書をまとめた')
    expect(seen('m-top')).toContain('企画書をまとめた')
  })
})
