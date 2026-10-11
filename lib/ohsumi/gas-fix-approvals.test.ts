// 承認(経費・申請フォーム・タスクの確認者の承認)の不具合の直し
// 1. 必要な数 'all' の段が終わらない(人の段は 1、役職の段はその役職の在籍中の人数)
// 2. 取り下げ・却下・差し戻し・承認済みの申請を承認・却下・差し戻し・取り下げできた(承認待ちの時だけ。取り下げは差し戻しの時も)
// 3. 同じ人の2回の承認を2人分に数えた(1人1回。2回目は断る)
// 4. 担当でない班長が、どの申請でも却下・差し戻しできた(今の承認ステップの担当者だけ。代表はどれでも)
// 5. 承認者に指定した一般のメンバーが承認できなかった(役職より先に、承認ステップの担当者かを確かめる)
// 6. 確認者が複数要るタスクを、1人の確認者・管理者が updateTaskStatus の「完了」で完了にできた
// 7. 確認者から外れた人・確認者でない管理者の承認を数えた。確認待ちから戻しても承認が残った
import { describe, expect, it } from 'vitest'
import { guardHarness, type Cell } from './gas-guard-harness'
import { approvalStepNeeded, currentReviewApprovals, reviewApprovalsNeeded, stepApproverIds } from './permissions'
import type { RoleDef } from './roles'

type H = ReturnType<typeof guardHarness>
type Step = { id: string; type: 'member' | 'role'; memberId?: string; role?: string; requiredCount?: number | 'all' }

const rowOf = (h: H, sheet: string, id: string) => {
  const [head, ...rows] = h.sheets[sheet].rows
  const row = rows.find((r) => String(r[0]) === id)!
  return Object.fromEntries(head.map((k, i) => [String(k), row[i]])) as Record<string, Cell>
}
const setCells = (h: H, sheet: string, id: string, fields: Record<string, Cell>) => {
  const rows = h.sheets[sheet].rows
  const head = rows[0]
  for (const k of Object.keys(fields)) if (!head.includes(k)) rows.forEach((r, i) => r.push(i === 0 ? k : ''))
  const row = rows.find((r, i) => i > 0 && String(r[0]) === id)!
  for (const [k, v] of Object.entries(fields)) row[head.indexOf(k)] = v
}

// 経費申請を1件入れる(承認の段は申請に保存した分を使う)
function addExpense(h: H, steps: Step[], o: { id?: string; status?: string; idx?: number; approvals?: unknown[]; applicant?: string } = {}) {
  const headers = h.c.EXPENSES_HEADERS as string[]
  if (!h.sheets.Expenses) h.addSheet('Expenses', [headers])
  const id = o.id ?? 'exp-1'
  const v: Record<string, Cell> = {
    id, applicant_id: o.applicant ?? 'm-base', amount: 1000, category_id: 'c1', approval_steps_json: JSON.stringify(steps),
    approvals_json: JSON.stringify(o.approvals ?? []), current_step_index: o.idx ?? 0, status: o.status ?? 'pending', created_at: '2026-10-01',
  }
  h.sheets.Expenses.rows.push(headers.map((k) => v[k] ?? ''))
  return id
}
// 申請フォーム(承認の段は団体の設定のフォーム)と、その回答を1件入れる
function addForm(h: H, steps: Step[], o: { status?: string; idx?: number; approvals?: unknown[] } = {}) {
  h.sheets.Settings.rows.push(['custom_form_defs', JSON.stringify([{ id: 'f1', title: '備品', fields: [], approvalSteps: steps }])])
  const headers = h.c.FORM_SUBMISSIONS_HEADERS as string[]
  if (!h.sheets.FormSubmissions) h.addSheet('FormSubmissions', [headers])
  const v: Record<string, Cell> = {
    id: 'fs-1', form_id: 'f1', submitter_id: 'm-base', answers_json: '{}', approvals_json: JSON.stringify(o.approvals ?? []),
    current_step_index: o.idx ?? 0, status: o.status ?? 'pending', created_at: '2026-10-01',
  }
  h.sheets.FormSubmissions.rows.push(headers.map((k) => v[k] ?? ''))
  return 'fs-1'
}

const approveExp = (h: H, who: string, stepId = 's1', id = 'exp-1') => h.post({ action: 'approveExpenseStep', sessionToken: who, applicationId: id, stepId })
const rejectExp = (h: H, who: string, id = 'exp-1') => h.post({ action: 'rejectExpense', sessionToken: who, applicationId: id, reason: '理由' })
const returnExp = (h: H, who: string, id = 'exp-1') => h.post({ action: 'returnExpense', sessionToken: who, applicationId: id, reason: '理由' })
const withdrawExp = (h: H, who: string, id = 'exp-1') => h.post({ action: 'withdrawExpense', sessionToken: who, applicationId: id })
const approveForm = (h: H, who: string, stepId = 's1') => h.post({ action: 'approveFormStep', sessionToken: who, submissionId: 'fs-1', stepId })
const rejectForm = (h: H, who: string) => h.post({ action: 'rejectFormSubmission', sessionToken: who, submissionId: 'fs-1', reason: '理由' })
const expStatus = (h: H, id = 'exp-1') => String(rowOf(h, 'Expenses', id).status)
const formStatus = (h: H) => String(rowOf(h, 'FormSubmissions', 'fs-1').status)

describe('1. 必要な数が「全員」(all)の段', () => {
  it('役職の段: その役職の在籍中の人数(休止・退会は数えない)。全員の承認で終わる', () => {
    const h = guardHarness()
    setCells(h, 'Members', 'm-other', { role: 'r-lead' })
    setCells(h, 'Members', 'm-off', { role: 'r-lead' }) // 休止中は数えない
    setCells(h, 'Members', 'm-victim', { role: 'r-lead', withdrawn_at: '2026-09-01T00:00:00Z' }) // 退会した人も数えない
    addExpense(h, [{ id: 's1', type: 'role', role: 'r-lead', requiredCount: 'all' }])
    expect(approveExp(h, 'm-lead').ok).toBe(true)
    expect(expStatus(h)).toBe('pending')
    expect(approveExp(h, 'm-other').ok).toBe(true)
    expect(expStatus(h)).toBe('approved')
  })

  it('役職の人が1人なら、その人の承認で終わる(以前は Infinity で終わらなかった)', () => {
    const h = guardHarness()
    addExpense(h, [{ id: 's1', type: 'role', role: 'r-lead', requiredCount: 'all' }, { id: 's2', type: 'member', memberId: 'm-top', requiredCount: 'all' }])
    expect(approveExp(h, 'm-lead').ok).toBe(true)
    expect(Number(rowOf(h, 'Expenses', 'exp-1').current_step_index)).toBe(1)
    // 人の段の all は 1
    expect(approveExp(h, 'm-top', 's2').ok).toBe(true)
    expect(expStatus(h)).toBe('approved')
  })

  it('申請フォームも同じ', () => {
    const h = guardHarness()
    addForm(h, [{ id: 's1', type: 'role', role: 'r-lead', requiredCount: 'all' }])
    expect(approveForm(h, 'm-lead').ok).toBe(true)
    expect(formStatus(h)).toBe('approved')
  })

  it('画面の決まり(permissions.ts)も同じ', () => {
    const roles: RoleDef[] = [{ id: 'base', name: '一般', tier: 'base' }, { id: 'r-lead', name: '班長', tier: 'admin' }]
    const members = [
      { id: 'a', role: 'r-lead' }, { id: 'b', role: 'r-lead' }, { id: 'c', role: 'r-lead', inactive: true },
      { id: 'd', role: 'r-lead', withdrawnAt: '2026-09-01' }, { id: 'e', role: 'base' },
    ]
    expect(approvalStepNeeded({ id: 's', type: 'role', role: 'r-lead', requiredCount: 'all' }, members, roles)).toBe(2)
    expect(approvalStepNeeded({ id: 's', type: 'role', role: 'nobody', requiredCount: 'all' }, members, roles)).toBe(1)
    expect(approvalStepNeeded({ id: 's', type: 'member', memberId: 'a', requiredCount: 'all' }, members, roles)).toBe(1)
    expect(approvalStepNeeded({ id: 's', type: 'role', role: 'r-lead', requiredCount: 2 }, members, roles)).toBe(2)
    expect(approvalStepNeeded({ id: 's', type: 'role', role: 'r-lead' }, members, roles)).toBe(1)
    expect(stepApproverIds([
      { stepId: 's', memberId: 'a', at: '', action: 'approved' }, { stepId: 's', memberId: 'a', at: '', action: 'approved' },
      { stepId: 's', memberId: 'b', at: '', action: 'rejected' }, { stepId: 't', memberId: 'c', at: '', action: 'approved' },
    ], 's')).toEqual(['a'])
  })
})

describe('2. 承認待ちでない申請', () => {
  it.each(['withdrawn', 'rejected', 'returned', 'approved'])('%s の経費申請は、代表でも承認できない', (status) => {
    const h = guardHarness()
    addExpense(h, [{ id: 's1', type: 'member', memberId: 'm-lead' }], { status })
    expect(approveExp(h, 'm-lead').ok).toBe(false)
    expect(approveExp(h, 'm-top').ok).toBe(false)
    expect(expStatus(h)).toBe(status)
    expect(rowOf(h, 'Expenses', 'exp-1').approvals_json).toBe('[]')
  })

  it('却下・差し戻しは承認待ちの時だけ', () => {
    for (const status of ['withdrawn', 'rejected', 'returned', 'approved']) {
      const h = guardHarness()
      addExpense(h, [{ id: 's1', type: 'member', memberId: 'm-lead' }], { status })
      expect(rejectExp(h, 'm-top').ok, status).toBe(false)
      expect(returnExp(h, 'm-top').ok, status).toBe(false)
      expect(expStatus(h)).toBe(status)
    }
  })

  it('取り下げは、申請者本人が承認待ち・差し戻しの時だけ', () => {
    for (const status of ['approved', 'rejected', 'withdrawn']) {
      const h = guardHarness()
      addExpense(h, [{ id: 's1', type: 'member', memberId: 'm-lead' }], { status })
      expect(withdrawExp(h, 'm-base').ok, status).toBe(false)
      expect(expStatus(h)).toBe(status)
    }
    for (const status of ['pending', 'returned']) {
      const h = guardHarness()
      addExpense(h, [{ id: 's1', type: 'member', memberId: 'm-lead' }], { status })
      expect(withdrawExp(h, 'm-other').ok, status).toBe(false) // 申請者でない人
      expect(withdrawExp(h, 'm-base').ok, status).toBe(true)
      expect(expStatus(h)).toBe('withdrawn')
    }
  })

  it('申請フォーム: 承認・却下は承認待ちの時だけ', () => {
    const h = guardHarness()
    addForm(h, [{ id: 's1', type: 'member', memberId: 'm-lead' }], { status: 'rejected' })
    expect(approveForm(h, 'm-top').ok).toBe(false)
    expect(formStatus(h)).toBe('rejected')
    const h2 = guardHarness()
    addForm(h2, [{ id: 's1', type: 'member', memberId: 'm-lead' }], { status: 'approved', idx: 1 })
    expect(rejectForm(h2, 'm-top').ok).toBe(false)
    expect(formStatus(h2)).toBe('approved')
  })
})

describe('3. 同じ人の2回の承認', () => {
  it('2人要る段を、1人が2回承認しても終わらない(2回目は断る)', () => {
    const h = guardHarness()
    setCells(h, 'Members', 'm-other', { role: 'r-lead' })
    addExpense(h, [{ id: 's1', type: 'role', role: 'r-lead', requiredCount: 2 }])
    expect(approveExp(h, 'm-lead').ok).toBe(true)
    const again = approveExp(h, 'm-lead')
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/すでに承認/)
    expect(expStatus(h)).toBe('pending')
    expect(approveExp(h, 'm-other').ok).toBe(true)
    expect(expStatus(h)).toBe('approved')
  })

  it('申請フォームも同じ', () => {
    const h = guardHarness()
    setCells(h, 'Members', 'm-other', { role: 'r-lead' })
    addForm(h, [{ id: 's1', type: 'role', role: 'r-lead', requiredCount: 2 }])
    expect(approveForm(h, 'm-lead').ok).toBe(true)
    expect(approveForm(h, 'm-lead').ok).toBe(false)
    expect(formStatus(h)).toBe('pending')
    expect(approveForm(h, 'm-other').ok).toBe(true)
    expect(formStatus(h)).toBe('approved')
  })
})

describe('4. 却下・差し戻しは、今の承認ステップの担当者だけ', () => {
  it('担当でない班長は、経費申請を却下・差し戻しできない。担当者・代表はできる', () => {
    const h = guardHarness()
    addExpense(h, [{ id: 's1', type: 'member', memberId: 'm-other' }])
    expect(rejectExp(h, 'm-lead').ok).toBe(false)
    expect(returnExp(h, 'm-lead').ok).toBe(false)
    expect(expStatus(h)).toBe('pending')
    expect(returnExp(h, 'm-other').ok).toBe(true)
    expect(expStatus(h)).toBe('returned')

    const h2 = guardHarness()
    addExpense(h2, [{ id: 's1', type: 'member', memberId: 'm-other' }])
    expect(rejectExp(h2, 'm-top').ok).toBe(true)
    expect(expStatus(h2)).toBe('rejected')
  })

  it('担当でない班長は、申請フォームを却下できない', () => {
    const h = guardHarness()
    addForm(h, [{ id: 's1', type: 'member', memberId: 'm-other' }])
    expect(rejectForm(h, 'm-lead').ok).toBe(false)
    expect(formStatus(h)).toBe('pending')
    expect(rejectForm(h, 'm-other').ok).toBe(true)
    expect(formStatus(h)).toBe('rejected')
  })

  it('役職の段は、その役職の人が却下できる', () => {
    const h = guardHarness()
    addExpense(h, [{ id: 's1', type: 'role', role: 'r-lead' }])
    expect(rejectExp(h, 'm-other').ok).toBe(false)
    expect(rejectExp(h, 'm-lead').ok).toBe(true)
  })
})

describe('5. 承認者に指定した一般のメンバー', () => {
  it('経費申請を承認できる。担当でない一般のメンバーはできない', () => {
    const h = guardHarness()
    addExpense(h, [{ id: 's1', type: 'member', memberId: 'm-other' }], { applicant: 'm-victim' })
    expect(approveExp(h, 'm-base').ok).toBe(false)
    const res = approveExp(h, 'm-other')
    expect(res.ok, res.error).toBe(true)
    expect(expStatus(h)).toBe('approved')
  })

  it('申請フォームを承認できる', () => {
    const h = guardHarness()
    addForm(h, [{ id: 's1', type: 'member', memberId: 'm-other' }])
    expect(approveForm(h, 'm-other').ok).toBe(true)
    expect(formStatus(h)).toBe('approved')
  })

  it('一般の役職の段は、一般のメンバーが承認できる', () => {
    const h = guardHarness()
    addExpense(h, [{ id: 's1', type: 'role', role: 'base' }])
    expect(approveExp(h, 'm-other').ok).toBe(true)
    expect(expStatus(h)).toBe('approved')
  })
})

// 確認者が2人(m-other・m-victim)、必要な承認が2のタスク t1(担当は m-base)
function reviewTask(h: H, fields: Record<string, Cell> = {}) {
  setCells(h, 'Tasks', 't1', { reviewer_ids: 'm-other,m-victim', required_approvals: '2', review_approvals_json: '', ...fields })
}
const taskRow = (h: H) => rowOf(h, 'Tasks', 't1')
const isDone = (h: H) => /done|完了/.test(String(taskRow(h).status))
const approvalIds = (h: H) => (JSON.parse(String(taskRow(h).review_approvals_json || '[]')) as { memberId: string }[]).map((a) => a.memberId)
const statusTo = (h: H, who: string, status: string) => h.post({ action: 'updateTaskStatus', sessionToken: who, taskId: 't1', status })
const approveReview = (h: H, who: string) => h.post({ action: 'approveTaskReview', sessionToken: who, taskId: 't1' })

describe('6. 確認者が複数要るタスクの「完了」', () => {
  it('1人の確認者の「完了」は、その人の承認として記録し、完了にしない(2人目で完了)', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'review' })
    const res = statusTo(h, 'm-other', 'done')
    expect(res.ok, res.error).toBe(true)
    expect(isDone(h)).toBe(false)
    expect(approvalIds(h)).toEqual(['m-other'])
    expect(statusTo(h, 'm-victim', 'done').ok).toBe(true)
    expect(isDone(h)).toBe(true)
  })

  it('確認者でも担当者でもない全権管理者(班長)は「完了」にできない。代表はできる', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'review' })
    expect(statusTo(h, 'm-lead', 'done').ok).toBe(false)
    expect(isDone(h)).toBe(false)
    expect(statusTo(h, 'm-top', 'done').ok).toBe(true)
    expect(isDone(h)).toBe(true)
  })

  it('担当者の「完了」は今までどおり確認待ちになる', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'progress' })
    const res = statusTo(h, 'm-base', 'done')
    expect(res.ok, res.error).toBe(true)
    expect(res.result.status).toBe('review')
    expect(isDone(h)).toBe(false)
  })

  it('承認ボタン(approveTaskReview)で2人の承認が揃うと完了', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'review' })
    expect(approveReview(h, 'm-other').ok).toBe(true)
    expect(approveReview(h, 'm-other').ok).toBe(true) // 同じ人の2回目は数えない(冪等)
    expect(isDone(h)).toBe(false)
    expect(approveReview(h, 'm-victim').ok).toBe(true)
    expect(isDone(h)).toBe(true)
  })
})

describe('7. 確認者の承認は、今の確認者の分だけ数える', () => {
  it('確認者から外れた人・確認者でない管理者の承認(以前の記録)は数えない', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'review', review_approvals_json: JSON.stringify([{ memberId: 'm-base', at: 'x' }, { memberId: 'm-lead', at: 'x' }]) })
    expect(approveReview(h, 'm-other').ok).toBe(true)
    expect(isDone(h)).toBe(false)
    expect(approveReview(h, 'm-victim').ok).toBe(true)
    expect(isDone(h)).toBe(true)
  })

  it('確認者でない全権管理者(班長)は承認できない。代表は完了にできるが、確認者の承認には入れない', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'review' })
    expect(approveReview(h, 'm-lead').ok).toBe(false)
    expect(approvalIds(h)).toEqual([])
    expect(approveReview(h, 'm-top').ok).toBe(true)
    expect(isDone(h)).toBe(true)
    expect(approvalIds(h)).toEqual([])
  })

  it('確認待ちから修正中・進行中に戻すと、承認の記録を消す(次の確認待ちで前の承認を数えない)', () => {
    const h = guardHarness()
    reviewTask(h, { status: 'review', review_approvals_json: JSON.stringify([{ memberId: 'm-other', at: 'x' }]) })
    expect(statusTo(h, 'm-base', 'fix').ok).toBe(true)
    expect(String(taskRow(h).review_approvals_json)).toBe('')
    expect(statusTo(h, 'm-base', 'review').ok).toBe(true)
    expect(approveReview(h, 'm-victim').ok).toBe(true)
    expect(isDone(h)).toBe(false)
  })

  it('画面の決まり(permissions.ts)も同じ', () => {
    const task = { reviewerIds: ['a', 'b'], requiredApprovals: 'all' as const, reviewApprovals: [{ memberId: 'x', at: '' }, { memberId: 'a', at: '' }, { memberId: 'a', at: '' }] }
    expect(currentReviewApprovals(task).map((a) => a.memberId)).toEqual(['a'])
    expect(reviewApprovalsNeeded(task)).toBe(2)
    expect(reviewApprovalsNeeded({ reviewerIds: ['a'] })).toBe(1)
  })
})
