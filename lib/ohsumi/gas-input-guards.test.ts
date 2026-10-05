// 画面から届いた値の確かめ(公開前の版の2回目): それぞれを破る送り方が、断られる(または本人の分以外は使われない)ことを確かめる
//   1. createTasks の承認なしは管理者だけ(確認タスク・日程調整/フォームのクイック追加は例外)。担当者は在籍しているメンバーだけ
//   2. 経費・申請フォーム・日報の申請者・ID・作った日時・承認の段は GAS が決める。金額は0以上
//   3. 自分の実績(持ち込みの点数・スキルのレベル・資格の「外部」・研修の承認)は本人には変えさせない
//   4. 変更の記録の、記録した人・日時は GAS が決め、既存の記録は全権管理者も書き換えられない
//   5. 日程調整・フォームの回答は本人の分だけ
//   6〜10. 数・日付・メンバー/タスク/プロジェクトの存在・輪・評価した人・メールアドレス
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
type Row = Record<string, unknown>

function setup() {
  const h = guardHarness()
  const addCols = (sheet: string, cols: string[]) => {
    const rows = h.sheets[sheet].rows
    for (const c of cols) if (!rows[0].includes(c)) { rows[0].push(c); rows.slice(1).forEach((r) => r.push('')) }
  }
  addCols('Members', ['withdrawn_at', 'skill_levels_json', 'qualifications_json', 'evaluation_history_json', 'one_on_ones_json', 'mentor_id', 'joined_at', 'unavailable_dates'])
  addCols('Tasks', ['reviewer_id', 'required_approvals', 'approval_status', 'estimated_hours', 'actual_hours', 'progress_percent', 'schedule_json', 'form_json', 'due_time'])
  addCols('Projects', ['owner_id', 'parent_id', 'start_date', 'end_date', 'description', 'type', 'goal'])
  const mh = h.sheets.Members.rows[0]
  h.sheets.Members.rows.push(mh.map((c) => (c === 'id' ? 'm-gone' : c === 'name' ? '退会' : c === 'role' ? 'base' : c === 'withdrawn_at' ? '2026-09-01T00:00:00Z' : '')))
  const ph = h.sheets.Projects.rows[0]
  h.sheets.Projects.rows.push(ph.map((c) => (c === 'id' ? 'p2' : c === 'name' ? 'P2' : c === 'parent_id' ? 'p1' : '')))
  h.sheets.Settings.rows.push(
    ['expense_categories', JSON.stringify([{ id: 'cat1', label: '交通費', approvalSteps: [{ id: 's1', type: 'member', memberId: 'm-top' }] }])],
    ['custom_form_defs', JSON.stringify([{ id: 'f1', name: '備品', fields: [], approvalSteps: [] }])],
  )
  return h
}
const rowOf = (h: H, sheet: string, id: string): Row => {
  const [head, ...rows] = h.sheets[sheet].rows
  const r = rows.find((x) => x[0] === id)
  return r ? Object.fromEntries(head.map((k, i) => [String(k), r[i]])) : {}
}
const lastRow = (h: H, sheet: string): Row => {
  const [head, ...rows] = h.sheets[sheet].rows
  return Object.fromEntries(head.map((k, i) => [String(k), rows[rows.length - 1][i]]))
}
const jsonOf = (h: H, sheet: string, id: string, col: string) => JSON.parse(String(rowOf(h, sheet, id)[col] || '[]'))
type Res = { ok: boolean; error?: string; result?: unknown }
const ok = (res: Res) => { expect(res.ok, JSON.stringify(res)).toBe(true); return res }
const ng = (res: Res, msg?: RegExp) => {
  expect(res.ok, JSON.stringify(res)).toBe(false)
  if (msg) expect(String(res.error)).toMatch(msg)
  return res
}
const base = { projectId: 'p1', department: 'ops', category: '', skills: [], difficulty: 'anyone', priority: 'medium', deadline: null }

describe('1. タスクの承認なし・担当者', () => {
  it('一般のメンバーの承認なしは、承認待ちにする。管理者は承認なしで作れる', () => {
    const h = setup()
    const r1 = ok(h.post({ action: 'createTasks', sessionToken: 'm-base', tasks: [{ ...base, tempId: 'a', title: '一般の承認なし', pendingApproval: false }] }))
    expect(rowOf(h, 'Tasks', (r1.result as { id: string }[])[0].id).approval_status).toBe('承認待ち')
    const r2 = ok(h.post({ action: 'createTasks', sessionToken: 'm-lead', tasks: [{ ...base, tempId: 'b', title: '班長の承認なし', pendingApproval: false }] }))
    expect(rowOf(h, 'Tasks', (r2.result as { id: string }[])[0].id).approval_status).toBe('承認済み')
  })

  it('例外: 確認タスク(元のタスクの担当者が、その確認者を担当にする時だけ)', () => {
    const h = setup()
    h.sheets.Tasks.rows.find((r) => r[0] === 't1')![h.sheets.Tasks.rows[0].indexOf('reviewer_ids')] = 'm-lead'
    const review = (who: string, assignees: string[]) => h.post({ action: 'createTasks', sessionToken: who, tasks: [
      { ...base, tempId: 'r', title: '確認: タスク1', pendingApproval: false, relatedReviewTaskId: 't1', assigneeIds: assignees }] })
    const okRes = ok(review('m-base', ['m-lead']))
    expect(rowOf(h, 'Tasks', (okRes.result as { id: string }[])[0].id).approval_status).toBe('承認済み')
    // 担当者ではない人・確認者ではない人を担当にした時は承認待ち
    const notAssignee = ok(review('m-other', ['m-lead']))
    expect(rowOf(h, 'Tasks', (notAssignee.result as { id: string }[])[0].id).approval_status).toBe('承認待ち')
    const notReviewer = ok(review('m-base', ['m-other']))
    expect(rowOf(h, 'Tasks', (notReviewer.result as { id: string }[])[0].id).approval_status).toBe('承認待ち')
  })

  it('例外: 日程調整・フォームのクイック追加(担当者なし・中身あり)。作る時に中身を保存し、回答は空にする', () => {
    const h = setup()
    const sched = { candidates: [{ id: 'c1', label: '10/10' }], invitedIds: ['m-other'], responses: { 'm-other': { c1: 'yes' } } }
    const r = ok(h.post({ action: 'createTasks', sessionToken: 'm-base', tasks: [{ ...base, tempId: 's', title: '日程', pendingApproval: false, quickKind: 'schedule', schedule: sched }] }))
    const row = rowOf(h, 'Tasks', (r.result as { id: string }[])[0].id)
    expect(row.approval_status).toBe('承認済み')
    expect(JSON.parse(String(row.schedule_json))).toMatchObject({ candidates: [{ id: 'c1' }], invitedIds: ['m-other'], responses: {} })
    ng(h.post({ action: 'createTasks', sessionToken: 'm-base', tasks: [{ ...base, tempId: 's2', title: '空の日程', pendingApproval: false, quickKind: 'schedule', schedule: { candidates: [], invitedIds: [] } }] }), /候補/)
    ng(h.post({ action: 'createTasks', sessionToken: 'm-base', tasks: [{ ...base, tempId: 's3', title: '担当つき', pendingApproval: false, quickKind: 'form', assigneeIds: ['m-other'], form: { fields: [{ id: 'q' }], invitedIds: [] } }] }), /担当者/)
  })

  it('担当者は在籍しているメンバーだけ。日付・時刻・工数の形を確かめる', () => {
    const h = setup()
    const create = (extra: Row) => h.post({ action: 'createTasks', sessionToken: 'm-lead', tasks: [{ ...base, tempId: 'x', title: 'x', ...extra }] })
    ng(create({ assigneeIds: ['m-nobody'] }), /登録されていない/)
    ng(create({ assigneeIds: ['m-gone'] }), /退会/)
    ng(create({ deadline: '2026/10/10' }), /YYYY-MM-DD/)
    ng(create({ deadline: '2026-02-30' }), /YYYY-MM-DD/)
    ng(create({ dueTime: '25:00' }), /HH:MM/)
    ng(create({ estimatedHours: -1 }), /工数/)
    ok(create({ assigneeIds: ['m-off'], deadline: '2026-10-10', dueTime: '09:30', estimatedHours: 2 }))
    ng(h.post({ action: 'assignTask', sessionToken: 'm-lead', taskId: 't1', assigneeIds: ['m-gone'] }), /退会/)
  })
})

describe('2. 経費・申請フォーム・日報', () => {
  it('経費: 申請者・ID・作った日時・承認の段は GAS が決める。金額は0以上、カテゴリは設定にあるものだけ', () => {
    const h = setup()
    const res = ok(h.post({ action: 'submitExpenseApplication', sessionToken: 'm-base', application: {
      id: 'chosen-id', applicantId: 'm-victim', amount: 1200, categoryId: 'cat1', createdAt: '2020-01-01T00:00:00Z',
      approvalSteps: [{ id: 'x', type: 'member', memberId: 'm-base' }] } }))
    const row = lastRow(h, 'Expenses')
    expect(row.id).toBe((res.result as { id: string }).id)
    expect(row.id).not.toBe('chosen-id')
    expect(row.applicant_id).toBe('m-base')
    expect(String(row.created_at)).not.toBe('2020-01-01T00:00:00Z')
    expect(JSON.parse(String(row.approval_steps_json))).toEqual([{ id: 's1', type: 'member', memberId: 'm-top' }])
    ng(h.post({ action: 'submitExpenseApplication', sessionToken: 'm-base', application: { amount: -5, categoryId: 'cat1' } }), /金額/)
    ng(h.post({ action: 'submitExpenseApplication', sessionToken: 'm-base', application: { amount: 'abc', categoryId: 'cat1' } }), /金額/)
    ng(h.post({ action: 'submitExpenseApplication', sessionToken: 'm-base', application: { amount: 100, categoryId: 'nope' } }), /カテゴリ/)
  })

  it('経費の再提出: 承認の段は送られても使わず、カテゴリの設定から決める。金額は0以上', () => {
    const h = setup()
    const id = (ok(h.post({ action: 'submitExpenseApplication', sessionToken: 'm-base', application: { amount: 100, categoryId: 'cat1' } })).result as { id: string }).id
    ok(h.post({ action: 'resubmitExpense', sessionToken: 'm-base', applicationId: id, fields: { amount: 150, categoryId: 'cat1', approvalSteps: [] } }))
    expect(JSON.parse(String(rowOf(h, 'Expenses', id).approval_steps_json))).toEqual([{ id: 's1', type: 'member', memberId: 'm-top' }])
    ng(h.post({ action: 'resubmitExpense', sessionToken: 'm-base', applicationId: id, fields: { amount: -1, categoryId: 'cat1' } }), /金額/)
  })

  it('申請フォーム・日報: 提出者・メンバー・ID・作った日時は GAS が決める', () => {
    const h = setup()
    ok(h.post({ action: 'submitCustomForm', sessionToken: 'm-base', submission: { id: 'mine', formId: 'f1', submitterId: 'm-victim', answers: { a: 1 }, createdAt: '2020-01-01' } }))
    const fs = lastRow(h, 'FormSubmissions')
    expect([fs.submitter_id, fs.id === 'mine', fs.created_at === '2020-01-01']).toEqual(['m-base', false, false])
    ng(h.post({ action: 'submitCustomForm', sessionToken: 'm-base', submission: { formId: 'nope', answers: {} } }), /フォーム/)
    ok(h.post({ action: 'submitDailyReport', sessionToken: 'm-base', report: { id: 'mine', memberId: 'm-victim', type: 'daily', date: '2026-10-05', done: 'x', createdAt: '2020-01-01' } }))
    const dr = lastRow(h, 'DailyReports')
    expect([dr.member_id, dr.id === 'mine', dr.report_date]).toEqual(['m-base', false, '2026-10-05'])
    ng(h.post({ action: 'submitDailyReport', sessionToken: 'm-base', report: { type: 'monthly', date: '2026-10-05' } }), /種類/)
    ng(h.post({ action: 'submitDailyReport', sessionToken: 'm-base', report: { type: 'daily', date: '10/05' } }), /YYYY-MM-DD/)
  })
})

describe('3. 自分の実績', () => {
  it('持ち込み: 本人の点数は足さない。負の点数は誰でも断る。管理者は足せる', () => {
    const h = setup()
    h.sheets.Members.rows[0].push('skill_points_json')
    h.sheets.Members.rows.slice(1).forEach((r) => r.push('{}'))
    const res = ok(h.post({ action: 'importPortableRecord', sessionToken: 'm-base', memberId: 'm-base', skillPoints: { 'デザイン': 500 }, qualifications: [{ name: '資格A' }] }))
    expect((res.result as { pointsSkipped: boolean }).pointsSkipped).toBe(true)
    expect(JSON.parse(String(rowOf(h, 'Members', 'm-base').skill_points_json))).toEqual({})
    expect(jsonOf(h, 'Members', 'm-base', 'qualifications_json')[0]).toMatchObject({ name: '資格A' })
    ng(h.post({ action: 'importPortableRecord', sessionToken: 'm-lead', memberId: 'm-base', skillPoints: { 'デザイン': -10 }, qualifications: [] }), /0以上/)
    ok(h.post({ action: 'importPortableRecord', sessionToken: 'm-lead', memberId: 'm-base', skillPoints: { 'デザイン': 30 }, qualifications: [] }))
    expect(JSON.parse(String(rowOf(h, 'Members', 'm-base').skill_points_json))).toEqual({ 'デザイン': 30 })
  })

  it('スキルのレベル: 本人は上げられない(新しいスキルは Lv.1 だけ。下げるのはよい)。管理者は上げられる', () => {
    const h = setup()
    const set = (who: string, levels: unknown) => h.post({ action: 'updateSkillLevels', sessionToken: who, memberId: 'm-base', levels })
    ok(set('m-base', [{ skill: 'デザイン', level: 1 }]))
    ng(set('m-base', [{ skill: 'デザイン', level: 3 }]), /上げられません/)
    ng(set('m-base', [{ skill: 'デザイン', level: 1 }, { skill: '新しい', level: 2 }]), /上げられません/)
    ok(set('m-lead', [{ skill: 'デザイン', level: 3 }]))
    ok(set('m-base', [{ skill: 'デザイン', level: 2 }]))
    ng(set('m-lead', [{ skill: 'デザイン', level: 9 }]), /1〜5/)
  })

  it('資格の「外部」の印: 本人は付けられない・外せない。管理者は付けられる', () => {
    const h = setup()
    const set = (who: string, entries: unknown) => h.post({ action: 'updateQualifications', sessionToken: who, memberId: 'm-base', entries })
    ng(set('m-base', [{ id: 'q1', name: 'A', external: true }]), /外部/)
    ok(set('m-base', [{ id: 'q1', name: 'A' }]))
    ok(set('m-lead', [{ id: 'q1', name: 'A', external: true }]))
    ng(set('m-base', [{ id: 'q1', name: 'A', external: false }]), /外部/)
    ok(set('m-base', [{ id: 'q1', name: 'A 改', external: true }]))
    ng(set('m-base', [{ id: 'q2', name: 'B', acquiredDate: '2026/1/1' }]), /YYYY-MM-DD/)
  })

  it('研修: 本人は承認済みにできない(新しい研修は申請中だけ)', () => {
    const h = setup()
    const stored = jsonOf(h, 'Members', 'm-base', 'training_history_json') as Row[]
    const set = (who: string, entries: unknown) => h.post({ action: 'updateTrainingHistory', sessionToken: who, memberId: 'm-base', entries })
    ng(set('m-base', stored.map((t) => (t.id === 'tr-pending' ? { ...t, status: 'approved' } : t))), /承認/)
    ng(set('m-base', [...stored, { id: 'tr-new', name: '新', date: '2026-11-01' }]), /承認/)
    ng(set('m-base', [...stored, { id: 'tr-new', name: '新', date: '2026-11-01', status: 'approved' }]), /承認/)
    ok(set('m-base', [...stored, { id: 'tr-new', name: '新', date: '2026-11-01', status: 'pending' }]))
    ok(set('m-lead', stored.map((t) => (t.id === 'tr-pending' ? { ...t, status: 'approved' } : t))))
  })
})

describe('4. 変更の記録', () => {
  it('新しい記録の、記録した人・日時は GAS が決める。既存の記録は全権管理者も書き換えられない', () => {
    const h = setup()
    const entry = { id: 'h1', at: '2000-01-01T00:00:00Z', byId: 'm-lead', field: 'deadline', from: '', to: '2026-10-10' }
    ok(h.post({ action: 'updateHistory', sessionToken: 'm-top', taskId: 't1', history: [entry] }))
    const saved = jsonOf(h, 'Tasks', 't1', 'history_json')[0]
    expect(saved.byId).toBe('m-top')
    expect(saved.at).not.toBe('2000-01-01T00:00:00Z')
    // 差分(listOps)で送っても、一覧を丸ごと送っても(古い画面)、既存の記録は変えられない
    ng(h.post({ action: 'updateHistory', sessionToken: 'm-top', taskId: 't1', history: [{ ...saved, to: '2030-01-01' }] }), /変更・削除|足すことだけ/)
    ng(h.post({ action: 'updateHistory', sessionToken: 'm-top', taskId: 't1', history: [] }), /変更・削除|足すことだけ/)
    // 一覧を丸ごと送る古い画面は、読み込み直すように断られる(既存の記録を書き換える道は無い)
    ng(h.postRaw({ action: 'updateHistory', sessionToken: 'm-top', taskId: 't1', history: [] }))
    expect(jsonOf(h, 'Tasks', 't1', 'history_json')).toHaveLength(1)
  })
})

describe('5. 日程調整・フォームの回答', () => {
  it('招待された人は自分の回答だけ。ほかの人の回答・候補は今の保存のまま。招待されていない人は断る', () => {
    const h = setup()
    const head = h.sheets.Tasks.rows[0]
    const t1 = h.sheets.Tasks.rows.find((r) => r[0] === 't1')!
    t1[head.indexOf('schedule_json')] = JSON.stringify({ candidates: [{ id: 'c1' }], invitedIds: ['m-other', 'm-victim'], responses: { 'm-victim': { c1: 'no' } } })
    ok(h.post({ action: 'updateTaskSchedule', sessionToken: 'm-other', taskId: 't1',
      schedule: { candidates: [{ id: 'c1' }, { id: 'evil' }], invitedIds: ['m-other'], responses: { 'm-other': { c1: 'yes' }, 'm-victim': { c1: 'yes' } } } }))
    const s = JSON.parse(String(rowOf(h, 'Tasks', 't1').schedule_json))
    expect(s.candidates).toEqual([{ id: 'c1' }])
    expect(s.invitedIds).toEqual(['m-other', 'm-victim'])
    expect(s.responses['m-other'].c1).toMatch(/yes|○/)
    expect(s.responses['m-victim'].c1).toMatch(/no|×/)
    ng(h.post({ action: 'updateTaskSchedule', sessionToken: 'm-off', taskId: 't1', schedule: { responses: { 'm-off': { c1: 'yes' } } } }), /招待/)
    // 作成者(班長)は候補を変えられるが、ほかの人の回答は変えられない
    ok(h.post({ action: 'updateTaskSchedule', sessionToken: 'm-lead', taskId: 't1',
      schedule: { candidates: [{ id: 'c1' }, { id: 'c2' }], invitedIds: ['m-other', 'm-victim'], responses: { 'm-victim': {} } } }))
    const s2 = JSON.parse(String(rowOf(h, 'Tasks', 't1').schedule_json))
    expect(s2.candidates).toHaveLength(2)
    expect(s2.responses['m-victim'].c1).toMatch(/no|×/)
  })

  it('フォームも同じ', () => {
    const h = setup()
    const head = h.sheets.Tasks.rows[0]
    h.sheets.Tasks.rows.find((r) => r[0] === 't1')![head.indexOf('form_json')] = JSON.stringify({ fields: [{ id: 'q' }], invitedIds: ['m-other', 'm-victim'], responses: { 'm-victim': { q: '元' } } })
    ok(h.post({ action: 'updateTaskForm', sessionToken: 'm-other', taskId: 't1', form: { fields: [], invitedIds: [], responses: { 'm-other': { q: '自分' }, 'm-victim': { q: '改ざん' } } } }))
    const f = JSON.parse(String(rowOf(h, 'Tasks', 't1').form_json))
    expect(f).toEqual({ fields: [{ id: 'q' }], invitedIds: ['m-other', 'm-victim'], responses: { 'm-victim': { q: '元' }, 'm-other': { q: '自分' } } })
    ng(h.post({ action: 'updateTaskForm', sessionToken: 'm-other', taskId: 't1', form: null }), /消せる/)
  })
})

describe('6・7. 数と日付', () => {
  it('進み具合0〜100・工数0以上・必要な承認の数・日付の形', () => {
    const h = setup()
    ng(h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: 120 }), /0〜100/)
    ng(h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: -1 }), /0〜100/)
    ok(h.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: 100 }))
    ng(h.post({ action: 'updateEstimatedHours', sessionToken: 'm-base', taskId: 't1', hours: -2 }), /工数/)
    ng(h.post({ action: 'updateActualHours', sessionToken: 'm-base', taskId: 't1', hours: 'x' }), /工数/)
    ok(h.post({ action: 'updateActualHours', sessionToken: 'm-base', taskId: 't1', hours: 1.5 }))
    ng(h.post({ action: 'updateReviewers', sessionToken: 'm-lead', taskId: 't1', reviewerIds: ['m-lead'], requiredApprovals: 2 }), /承認の数/)
    ng(h.post({ action: 'updateReviewers', sessionToken: 'm-lead', taskId: 't1', reviewerIds: ['m-lead'], requiredApprovals: 0 }), /承認の数/)
    ok(h.post({ action: 'updateReviewers', sessionToken: 'm-lead', taskId: 't1', reviewerIds: ['m-lead', 'm-top'], requiredApprovals: 'all' }))
    ng(h.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: 'tomorrow' }), /YYYY-MM-DD/)
    ng(h.post({ action: 'setBlocker', sessionToken: 'm-lead', taskId: 't1', note: '困った', since: '2026-13-01' }), /YYYY-MM-DD/)
    ng(h.post({ action: 'updateJoinedAt', sessionToken: 'm-top', memberId: 'm-base', joinedAt: '2026.04.01' }), /YYYY-MM-DD/)
    ng(h.post({ action: 'updateUnavailableDates', sessionToken: 'm-base', memberId: 'm-base', dates: ['2026-10-01', 'x'] }), /YYYY-MM-DD/)
    ng(h.post({ action: 'updateProjectDetails', sessionToken: 'm-lead', projectId: 'p1', name: 'P', startDate: '2026-1-1' }), /YYYY-MM-DD/)
  })
})

describe('8. 存在と輪', () => {
  it('確認者・前提タスク・プロジェクトのメンバー・責任者・親・報告先・メンター', () => {
    const h = setup()
    ng(h.post({ action: 'updateReviewers', sessionToken: 'm-lead', taskId: 't1', reviewerIds: ['m-nobody'] }), /登録されていない/)
    ng(h.post({ action: 'updateReviewer', sessionToken: 'm-lead', taskId: 't1', reviewerId: 'm-gone' }), /退会/)
    ng(h.post({ action: 'updateDependsOn', sessionToken: 'm-lead', taskId: 't1', dependsOnIds: ['t1'] }), /自身/)
    ng(h.post({ action: 'updateDependsOn', sessionToken: 'm-lead', taskId: 't1', dependsOnIds: ['t-none'] }), /見つからない/)
    ok(h.post({ action: 'updateDependsOn', sessionToken: 'm-lead', taskId: 't-bid', dependsOnIds: ['t1'] }))
    ng(h.post({ action: 'updateDependsOn', sessionToken: 'm-lead', taskId: 't1', dependsOnIds: ['t-bid'] }), /輪/)
    ng(h.post({ action: 'updateProjectMembers', sessionToken: 'm-top', projectId: 'p1', memberIds: ['m-base', 'm-gone'] }), /退会/)
    ng(h.post({ action: 'updateProjectOwner', sessionToken: 'm-top', projectId: 'p1', ownerId: 'm-nobody' }), /登録されていない/)
    ng(h.post({ action: 'updateProjectParent', sessionToken: 'm-top', projectId: 'p1', parentId: 'p1' }), /自分自身/)
    ng(h.post({ action: 'updateProjectParent', sessionToken: 'm-top', projectId: 'p1', parentId: 'p2' }), /輪/)
    ng(h.post({ action: 'updateProjectParent', sessionToken: 'm-top', projectId: 'p1', parentId: 'p-none' }), /見つかりません/)
    ng(h.post({ action: 'updateReportsTo', sessionToken: 'm-top', memberId: 'm-base', reportsToId: 'm-base' }), /自分自身/)
    // m-base の報告先は m-lead。m-lead の報告先を m-base にすると輪になる
    ng(h.post({ action: 'updateReportsTo', sessionToken: 'm-top', memberId: 'm-lead', reportsToId: 'm-base' }), /輪/)
    ng(h.post({ action: 'updateReportsTo', sessionToken: 'm-top', memberId: 'm-other', reportsToId: 'm-gone' }), /退会/)
    ng(h.post({ action: 'updateMentor', sessionToken: 'm-top', memberId: 'm-base', mentorId: 'm-base' }), /自分自身/)
    ok(h.post({ action: 'updateMentor', sessionToken: 'm-top', memberId: 'm-base', mentorId: 'm-lead' }))
  })
})

describe('9・10. 評価した人・メールアドレス', () => {
  it('評価・1on1 の「評価した人」「相手」は操作した本人。既存の記録の評価した人は変えさせない', () => {
    const h = setup()
    ok(h.post({ action: 'updateEvaluationHistory', sessionToken: 'm-lead', memberId: 'm-base', entries: [{ id: 'e1', date: '2026-10-01', evaluatorId: 'm-top', rating: 'A' }] }))
    expect(jsonOf(h, 'Members', 'm-base', 'evaluation_history_json')[0].evaluatorId).toBe('m-lead')
    ok(h.post({ action: 'updateEvaluationHistory', sessionToken: 'm-top', memberId: 'm-base', entries: [{ id: 'e1', date: '2026-10-01', evaluatorId: 'm-top', rating: 'B' }] }))
    expect(jsonOf(h, 'Members', 'm-base', 'evaluation_history_json')[0]).toMatchObject({ evaluatorId: 'm-lead', rating: 'B' })
    ng(h.post({ action: 'updateEvaluationHistory', sessionToken: 'm-lead', memberId: 'm-base', entries: [{ id: 'e2', date: '昨日', rating: 'A' }] }), /YYYY-MM-DD/)
    ok(h.post({ action: 'updateOneOnOnes', sessionToken: 'm-lead', memberId: 'm-base', entries: [{ id: 'o1', date: '2026-10-01', withId: 'm-top', notes: '' }] }))
    expect(jsonOf(h, 'Members', 'm-base', 'one_on_ones_json')[0].withId).toBe('m-lead')
  })

  it('メールアドレス: 形を確かめ、空にさせない', () => {
    const h = setup()
    ng(h.post({ action: 'updateEmail', sessionToken: 'm-top', memberId: 'm-base', email: '' }), /空/)
    ng(h.post({ action: 'updateEmail', sessionToken: 'm-top', memberId: 'm-base', email: 'not-an-address' }), /形/)
    ng(h.post({ action: 'updateEmail', sessionToken: 'm-top', memberId: 'm-base', email: 'ok@example.com, bad' }), /形/)
    ok(h.post({ action: 'updateEmail', sessionToken: 'm-top', memberId: 'm-base', email: 'new@example.com' }))
  })
})
