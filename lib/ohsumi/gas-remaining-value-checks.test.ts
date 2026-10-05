// 残りの値の確かめ(形と大きさ): 通知の設定・タイムゾーン・表示言語・アイコンの色・学歴・カスタム列・プロジェクトの健康状態・
// 候補者の項目・updateSetting の値(フォームの定義と承認の段・検定・定期タスクの規則・スキルのレベルの決め方)。
// おかしな値は保存せずに断り、画面が今送る値はこれまでどおり通す
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import { AVATAR_PALETTE } from './remote'
import { TIMEZONE_OPTIONS } from './timezone'
import { SUPPORTED_LOCALES } from './i18n'

type H = ReturnType<typeof guardHarness>
const withMemberColumns = (h: H) => {
  const rows = h.sheets.Members.rows
  for (const c of ['timezone', 'avatar_color', 'avatar_initials', 'avatar_url', 'university', 'faculty', 'department_name', 'grade_year', 'custom_fields_json']) {
    if (!rows[0].includes(c)) { rows[0].push(c); rows.slice(1).forEach((r) => r.push('')) }
  }
  const p = h.sheets.Projects.rows
  if (!p[0].includes('health_override')) { p[0].push('health_override'); p.slice(1).forEach((r) => r.push('')) }
  return h
}
const cell = (h: H, sheet: string, id: string, col: string) => {
  const [head, ...rows] = h.sheets[sheet].rows
  return rows.find((r) => r[0] === id)?.[head.indexOf(col)]
}
const me = (action: string, extra: Record<string, unknown>) => ({ action, sessionToken: 'm-base', memberId: 'm-base', ...extra })

describe('本人の設定・学歴・カスタム列', () => {
  it('画面が送る値は通す', () => {
    const h = withMemberColumns(guardHarness())
    expect(h.post(me('updateNotifySettings', { settings: { new_task: '3h', review: 'immediate', mention: 'none', rejected: '1d', deadline: '6h' } })).ok).toBe(true)
    for (const tz of TIMEZONE_OPTIONS.map((o) => o.value).concat([''])) expect(h.post(me('updateTimezone', { timezone: tz })).ok, tz).toBe(true)
    for (const l of SUPPORTED_LOCALES.map((o) => o.code as string).concat([''])) expect(h.post(me('updateLocale', { locale: l })).ok, l).toBe(true)
    for (const color of AVATAR_PALETTE) expect(h.post(me('updateAvatar', { avatarColor: color, initials: 'AB' })).ok, color).toBe(true)
    expect(h.post(me('updateEducationInfo', { university: '大学', faculty: '学部', departmentName: '学科', gradeYear: '3' })).ok).toBe(true)
    expect(h.post(me('updateEducationInfo', {})).ok).toBe(true)
    expect(h.post(me('updateCustomFields', { customFields: { shirt: 'M', joined: '2026-04-01', score: '12' } })).ok).toBe(true)
    expect(cell(h, 'Members', 'm-base', 'custom_fields_json')).toBe('{"shirt":"M","joined":"2026-04-01","score":"12"}')
  })

  it('おかしな値は断り、保存しない', () => {
    const h = withMemberColumns(guardHarness())
    const bad: [string, Record<string, unknown>][] = [
      ['updateNotifySettings', { settings: { new_task: 'sometimes' } }],
      ['updateNotifySettings', { settings: { hack: 'none' } }],
      ['updateNotifySettings', { settings: ['none'] }],
      ['updateTimezone', { timezone: '<script>' }],
      ['updateTimezone', { timezone: 'Asia/' + 'x'.repeat(80) }],
      ['updateLocale', { locale: 'japanese' }],
      ['updateAvatar', { avatarColor: 'red;background:url(x)', initials: 'AB' }],
      ['updateAvatar', { avatarColor: '#2948e8', initials: 'x'.repeat(5) }],
      ['updateEducationInfo', { university: 'x'.repeat(201) }],
      ['updateEducationInfo', { gradeYear: { a: 1 } }],
      ['updateCustomFields', { customFields: ['a'] }],
      ['updateCustomFields', { customFields: { a: { nested: true } } }],
      ['updateCustomFields', { customFields: { a: 'x'.repeat(2001) } }],
      ['updateCustomFields', { customFields: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['k' + i, 'v'])) }],
    ]
    for (const [action, extra] of bad) {
      const res = h.post(me(action, extra))
      expect(res.ok, `${action} ${JSON.stringify(extra).slice(0, 80)}`).toBe(false)
    }
    for (const col of ['notify_settings', 'timezone', 'avatar_color', 'university', 'custom_fields_json']) expect(cell(h, 'Members', 'm-base', col), col).toBe('')
    expect(cell(h, 'Members', 'm-base', 'locale')).toBe('ja')
  })
})

describe('プロジェクトの健康状態', () => {
  it('good・watch・attention(手動の上書きは空も)だけを通す', () => {
    const h = withMemberColumns(guardHarness())
    for (const v of ['good', 'watch', 'attention', null, '']) {
      expect(h.post({ action: 'updateProjectHealth', sessionToken: 'm-top', projectId: 'p1', healthOverride: v }).ok, String(v)).toBe(true)
    }
    expect(h.post({ action: 'updateProjectHealth', sessionToken: 'm-top', projectId: 'p1', healthOverride: 'burning' }).ok).toBe(false)
    expect(h.post({ action: 'notifyProjectHealth', sessionToken: 'm-top', projectId: 'p1', health: '=1+1' }).ok).toBe(false)
    expect(h.post({ action: 'notifyProjectHealth', sessionToken: 'm-top', projectId: 'p1', health: 'watch' }).ok).toBe(true)
    expect(h.post({ action: 'updateProjectHealthRecord', sessionToken: 'm-top', projectId: 'p1', health: 'x'.repeat(100) }).ok).toBe(false)
    expect(cell(h, 'Projects', 'p1', 'last_notified_health')).toBe('watch')
  })
})

describe('候補者の項目', () => {
  it('画面が送る値は通し、おかしな値は断る', () => {
    const h = guardHarness()
    expect(h.post({ action: 'addCandidate', sessionToken: 'm-top', candidate: { name: '候補', email: 'c@example.com', phone: '090-1234-5678 (携帯)', resumeText: '経歴', interviewNotes: '' } }).ok).toBe(true)
    expect(h.post({ action: 'addCandidate', sessionToken: 'm-top', candidate: { name: '名前だけ' } }).ok).toBe(true)
    const bad = [{ name: '' }, { name: 'x'.repeat(201) }, { name: 'a', email: 'not-mail' }, { name: 'a', phone: '1\n2' }, { name: 'a', status: 'interview' }, { name: 'a', resumeText: 'x'.repeat(50001) }, { name: { a: 1 } }]
    const before = h.sheets.Candidates.rows.length
    for (const c of bad) expect(h.post({ action: 'addCandidate', sessionToken: 'm-top', candidate: c }).ok, JSON.stringify(c).slice(0, 60)).toBe(false)
    expect(h.sheets.Candidates.rows.length).toBe(before)
    const id = String(h.sheets.Candidates.rows[1][0])
    expect(h.post({ action: 'updateCandidate', sessionToken: 'm-top', candidateId: id, fields: { status: 'hired' } }).ok).toBe(true)
    expect(h.post({ action: 'updateCandidate', sessionToken: 'm-top', candidateId: id, fields: { status: 'maybe' } }).ok).toBe(false)
    expect(h.post({ action: 'updateCandidate', sessionToken: 'm-top', candidateId: id, fields: { name: '' } }).ok).toBe(false)
  })
})

describe('updateSetting の値', () => {
  const put = (h: H, key: string, value: unknown) => h.post({ action: 'updateSetting', sessionToken: 'm-top', key, value: typeof value === 'string' ? value : JSON.stringify(value) })
  const form = { id: 'f1', title: '備品の申請', description: '', fields: [{ id: 'a', label: '品名', type: 'text', required: true }, { id: 'b', label: '種類', type: 'select', options: ['A', 'B'], required: false, description: '説明' }],
    approvalSteps: [{ id: 's1', type: 'role', role: 'r-lead' }, { id: 's2', type: 'member', memberId: 'm-top', requiredCount: 'all' }] }
  const quiz = { id: 'qz', title: '基礎', targetSkill: '企画', targetLevel: 2, passRate: 70, questions: [{ id: 'q1', text: 'Q', choices: ['a', 'b'], correctIndex: 1 }] }
  const rule = { id: 'rr-1', name: '週報', projectId: 'p1', department: 'ops', category: '', skills: ['企画'], difficulty: 'anyone', priority: 'medium', frequency: 'weekly', dayOfWeek: 1, dueInDays: 3, active: true, skipDates: ['2026-12-28'] }

  it('画面が送る値は通す(空にするのも通す)', () => {
    const h = guardHarness()
    expect(put(h, 'custom_form_defs', [form]).ok).toBe(true)
    expect(put(h, 'quiz_definitions', [quiz]).ok).toBe(true)
    expect(put(h, 'recurring_rules', [rule, { ...rule, id: 'rr-2', frequency: 'monthly', dayOfWeek: undefined, dayOfMonth: 28, lastGeneratedDate: '2026-09-28' }]).ok).toBe(true)
    expect(put(h, 'skill_level_rules', { default: { points: [10, 20, 30, 40, 50], conditions: { '2': [{ type: 'quiz' }, { type: 'approval' }], '3': [] } }, skills: { 企画: { conditions: { '4': [{ type: 'tasksDone', min: 3 }] } } } }).ok).toBe(true)
    for (const key of ['custom_form_defs', 'quiz_definitions', 'recurring_rules', 'skill_level_rules']) expect(put(h, key, '').ok, key).toBe(true)
    // 確かめの対象でないキーは、これまでどおり
    expect(put(h, 'org_name', '新しい団体名').ok).toBe(true)
  })

  it('おかしな値は断り、保存しない', () => {
    const h = guardHarness()
    const bad: [string, unknown][] = [
      ['custom_form_defs', '{not json'],
      ['custom_form_defs', { id: 'f1' }],
      ['custom_form_defs', [{ ...form, id: '' }]],
      ['custom_form_defs', [{ ...form, fields: [{ id: 'a', label: 'x', type: 'file' }] }]],
      ['custom_form_defs', [{ ...form, approvalSteps: [{ id: 's', type: 'anyone' }] }]],
      ['custom_form_defs', [{ ...form, approvalSteps: [{ id: 's', type: 'member' }] }]],
      ['custom_form_defs', [{ ...form, approvalSteps: [{ id: 's', type: 'role', role: 'r', requiredCount: 0 }] }]],
      ['custom_form_defs', [{ ...form, approvalSteps: Array.from({ length: 21 }, (_, i) => ({ id: 's' + i, type: 'role', role: 'r' })) }]],
      ['custom_form_defs', Array.from({ length: 101 }, (_, i) => ({ ...form, id: 'f' + i }))],
      ['quiz_definitions', [{ ...quiz, targetLevel: 9 }]],
      ['quiz_definitions', [{ ...quiz, passRate: 150 }]],
      ['quiz_definitions', [{ ...quiz, questions: [{ id: 'q', text: 'Q', choices: ['a'], correctIndex: 3 }] }]],
      ['quiz_definitions', [{ ...quiz, id: undefined }]],
      ['recurring_rules', [{ ...rule, frequency: 'hourly' }]],
      ['recurring_rules', [{ ...rule, dayOfWeek: 7 }]],
      ['recurring_rules', [{ ...rule, skipDates: ['2026-02-30'] }]],
      ['recurring_rules', [{ ...rule, active: 'yes' }]],
      ['skill_level_rules', { default: { points: [50, 10, 5, 1, 0] } }],
      ['skill_level_rules', { default: { conditions: { '2': [{ type: 'magic' }] } } }],
      ['skill_level_rules', { default: { conditions: { '9': [] } } }],
    ]
    for (const [key, value] of bad) {
      const res = put(h, key, value)
      expect(res.ok, `${key} ${JSON.stringify(value).slice(0, 80)}`).toBe(false)
    }
    expect(h.sheets.Settings.rows.map((r) => r[0])).not.toEqual(expect.arrayContaining(['custom_form_defs']))
    expect(h.sheets.Settings.rows.map((r) => String(r[0])).filter((k) => ['quiz_definitions', 'recurring_rules', 'skill_level_rules'].includes(k))).toEqual([])
  })
})
