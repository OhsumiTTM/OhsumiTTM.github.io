// 項目ごとの公開範囲(画面の側。lib/ohsumi/field-audiences.ts)。GAS(gas/src/33-member-field-visibility.gs・26-read-policy.gs)と
// 項目の一覧・今までの範囲・狭めるだけの項目・判定がそろっていることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  type AudienceContext, type FieldAudience, MEMBER_FIELDS, NARROW_ONLY_FIELDS, allowedAudiences, audienceAllows, audiencesOf,
  describeAudiences, parseFieldAudiences, serializeFieldAudiences,
} from './field-audiences'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const gas = (() => {
  const ctx = vm.createContext({ console })
  vm.runInContext(CODE_GS, ctx)
  return ctx as unknown as Record<string, unknown> & { READ_POLICY: { Members: { columns: Record<string, string> } } }
})()
const RULE_TO_AUDIENCES: Record<string, FieldAudience[]> = { all: ['all'], selfOrAdminRole: ['leaders'], selfOrSupervisor: ['boss', 'mentor', 'projectOwner'], self: [] }

describe('GAS とそろっている', () => {
  it('設定できる項目の一覧と、狭めるだけの項目', () => {
    expect(MEMBER_FIELDS.map((f) => f.key).sort()).toEqual([...(gas.MEMBER_FIELD_VISIBILITY_COLUMNS as string[])].sort())
    expect([...NARROW_ONLY_FIELDS].sort()).toEqual([...(gas.MEMBER_FIELD_NARROW_ONLY as string[])].sort())
    expect([...(gas.FIELD_AUDIENCES as string[])]).toEqual(['boss', 'deptHead', 'mentor', 'projectOwner', 'leaders', 'all'])
  })
  it('今までの範囲(既定)は READ_POLICY と同じ', () => {
    for (const f of MEMBER_FIELDS) {
      expect(f.default, f.key).toEqual(RULE_TO_AUDIENCES[gas.READ_POLICY.Members.columns[f.key]])
    }
  })
})

describe('設定の読み書き', () => {
  it('以前の範囲は同じ意味の組み合わせ。使えない値は入れない(今までどおり)', () => {
    const s = parseFieldAudiences(JSON.stringify({
      university: 'supervisor', faculty: 'self', grade_year: ['deptHead', 'boss'], career_plan: ['all'], name: ['all'],
      'custom:hobby': ['all'], daily_reports: ['boss'], joined_at: ['nobody'],
    }))
    expect(s).toEqual({ university: ['boss', 'mentor', 'projectOwner'], faculty: [], grade_year: ['boss', 'deptHead'], 'custom:hobby': ['all'], daily_reports: ['boss'] })
    expect(parseFieldAudiences('{oops')).toEqual({})
  })
  it('保存する値は決まった順。空なら設定を消す', () => {
    expect(serializeFieldAudiences({ university: ['all', 'boss'] })).toBe('{"university":["boss","all"]}')
    expect(serializeFieldAudiences({})).toBe('')
  })
  it('選べる相手: 狭めるだけの項目に幹部・全員は無い', () => {
    expect(allowedAudiences('career_plan')).toEqual(['boss', 'deptHead', 'mentor', 'projectOwner'])
    expect(allowedAudiences('university')).toContain('all')
  })
  it('独自の項目のキーは、設定が無ければ「独自の項目(まとめて)」の範囲。日報は本人だけ', () => {
    expect(audiencesOf('custom:x', {})).toEqual(['leaders'])
    expect(audiencesOf('custom:x', { custom_fields_json: ['boss'] })).toEqual(['boss'])
    expect(audiencesOf('daily_reports', {})).toEqual([])
  })
  it('説明', () => {
    expect(describeAudiences([])).toBe('本人だけ')
    expect(describeAudiences(['boss', 'deptHead'])).toBe('上長・部署長')
    expect(describeAudiences(['boss', 'all'])).toBe('全員')
  })
})

describe('判定(設定の画面の「この人から見ると」)', () => {
  const ctx: AudienceContext = {
    members: [
      { id: 'top', role: 'top' }, { id: 'lead', role: 'lead' },
      { id: 'me', role: 'base', reportsToId: 'mid', mentorId: 'men', departmentPaths: ['本部 > 開発'] },
      { id: 'mid', role: 'base', reportsToId: 'lead' }, { id: 'men', role: 'base' }, { id: 'head', role: 'base' }, { id: 'po', role: 'base' }, { id: 'x', role: 'base' },
    ],
    projects: [{ id: 'p', ownerId: 'po', memberIds: [] }, { id: 'c', parentId: 'p', memberIds: ['me'] }],
    departmentTree: [{ path: '本部', headIds: ['head'] }],
    isAdminRole: (r) => r !== 'base', isTopRole: (r) => r === 'top',
  }
  const who = (a: FieldAudience[]) => ['me', 'top', 'lead', 'mid', 'men', 'head', 'po', 'x'].filter((v) => audienceAllows(a, v, 'me', ctx))
  it('本人・代表と、選んだ相手だけ', () => {
    expect(who([])).toEqual(['me'])
    expect(who(['boss'])).toEqual(['me', 'top', 'lead', 'mid'])
    expect(who(['deptHead'])).toEqual(['me', 'top', 'head'])
    expect(who(['mentor'])).toEqual(['me', 'top', 'men'])
    expect(who(['projectOwner'])).toEqual(['me', 'top', 'po'])
    expect(who(['leaders'])).toEqual(['me', 'top', 'lead'])
    expect(who(['all'])).toEqual(['me', 'top', 'lead', 'mid', 'men', 'head', 'po', 'x'])
  })
})
