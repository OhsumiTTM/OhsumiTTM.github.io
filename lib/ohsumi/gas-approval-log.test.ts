// 承認の記録(gas/src/41-approval-log.gs)と、担当の候補の決め方の設定(assign_candidate_rules)
//   - タスクの登録の承認・却下を ApprovalLog に残す(誰が・いつ・名前・プロジェクト・理由)。承認済みのタスクの承認は残さない
//   - 読めるのは代表・管理者。担当プロジェクトを持つ管理者は、そのプロジェクトの分だけ
//   - 保存期間(365日)を過ぎた行は、毎日の処理で消す。バックアップから戻しても戻さない
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
type Fn = (...a: unknown[]) => unknown
const fn = (h: H, name: string) => h.c[name] as Fn
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

let seq = 0
const post = (h: H, token: string, body: Record<string, unknown>) => h.post({ sessionToken: token, requestId: 'al-' + ++seq, ...body })
const ok = (h: H, token: string, body: Record<string, unknown>) => {
  const res = post(h, token, body)
  if (!res.ok) throw new Error(JSON.stringify(res))
  return res
}
const newTask = (title: string, projectId = 'p1') => ({
  tempId: 'tmp-' + title, title, projectId, department: '', category: '', skills: [], difficulty: 'beginner', priority: 'medium',
  deadline: '2026-10-20', assigneeIds: [],
})
const create = (h: H, token: string, title: string, projectId = 'p1') =>
  ok(h, token, { action: 'createTasks', tasks: [newTask(title, projectId)] }).result[0].id as string
const log = (h: H, token: string) => ok(h, token, { action: 'getApprovalLog' }).result as { entries: Record<string, string>[]; keepDays: number }

describe('承認の記録', () => {
  it('承認・却下を、操作した人・名前・プロジェクト・登録した人・理由と一緒に残す(新しい順)', () => {
    const h = guardHarness()
    const a = create(h, 'm-base', '承認されるタスク')
    const b = create(h, 'm-base', '却下されるタスク')
    ok(h, 'm-top', { action: 'approveTask', taskId: a })
    ok(h, 'm-top', { action: 'rejectTask', taskId: b, reason: '重複しています' })
    const res = log(h, 'm-top')
    expect(res.keepDays).toBe(365)
    expect(res.entries.map((e) => [e.action, e.title])).toEqual([['rejected', '却下されるタスク'], ['approved', '承認されるタスク']])
    expect(res.entries[0]).toMatchObject({ kind: 'task_registration', targetId: b, projectId: 'p1', creatorId: 'm-base', byId: 'm-top', reason: '重複しています' })
    expect(res.entries[1]).toMatchObject({ targetId: a, byId: 'm-top', reason: '' })
  })

  it('承認待ちでないタスクの承認・削除は残さない', () => {
    const h = guardHarness()
    const a = create(h, 'm-base', '一度承認')
    ok(h, 'm-top', { action: 'approveTask', taskId: a })
    ok(h, 'm-top', { action: 'approveTask', taskId: a })
    ok(h, 'm-top', { action: 'approveTask', taskId: 't1' })
    expect(log(h, 'm-top').entries).toHaveLength(1)
  })

  it('一般のメンバーは読めない。全権でない管理者は、担当プロジェクトの分だけ(承認待ちの一覧と同じ)', () => {
    const h = guardHarness()
    const a = create(h, 'm-base', 'p1 のタスク')
    ok(h, 'm-top', { action: 'approveTask', taskId: a })
    const other = { ...plain(log(h, 'm-top').entries[0]) }
    // ほかのプロジェクトの記録を足す
    fn(h, 'appendApprovalLog_')('approved', { id: 'x9', title: 'p2 のタスク', project_id: 'p2', creator_id: 'm-top' }, 'm-top', '')
    expect(log(h, 'm-top').entries).toHaveLength(2)
    // 全権の管理者はすべて
    expect(log(h, 'm-lead').entries).toHaveLength(2)
    // 制限のある管理者(restricted)は、担当プロジェクト(p1)の分だけ
    const settings = h.sheets.Settings.rows
    const i = settings.findIndex((r) => r[0] === 'roles')
    settings[i][1] = JSON.stringify(JSON.parse(String(settings[i][1])).map((r: { id: string }) => (r.id === 'r-lead' ? { ...r, restricted: true } : r)))
    fn(h, 'invalidateRoles_')()
    fn(h, 'bumpDataVersion')()
    expect(log(h, 'm-lead').entries.map((e) => e.title)).toEqual([other.title])
    const res = post(h, 'm-base', { action: 'getApprovalLog' })
    expect(res.ok).toBe(false)
  })

  it('保存期間を過ぎた行は、毎日の処理で消す', () => {
    const h = guardHarness()
    fn(h, 'appendApprovalLog_')('approved', { id: 'old', title: '古い', project_id: 'p1' }, 'm-top', '')
    fn(h, 'appendApprovalLog_')('approved', { id: 'new', title: '新しい', project_id: 'p1' }, 'm-top', '')
    const rows = h.sheets.ApprovalLog.rows
    const atCol = rows[0].indexOf('at')
    rows[1][atCol] = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString()
    expect(fn(h, 'purgeOldApprovalLog_')(Date.now())).toBe(1)
    expect(log(h, 'm-top').entries.map((e) => e.title)).toEqual(['新しい'])
  })

  it('バックアップから戻す時は、承認の記録を戻さない', () => {
    const h = guardHarness()
    expect(plain(h.c.RESTORE_EXCLUDED_SHEETS)).toContain('ApprovalLog')
  })

  it('タスクの名前・理由が式として書かれないよう、セルを書式なしテキストにする', () => {
    const h = guardHarness()
    expect(plain((h.c.FORMULA_INJECTION_PROTECTED_COLUMNS as Record<string, string[]>).ApprovalLog)).toEqual(['title', 'reason'])
  })
})

describe('担当の候補の決め方(assign_candidate_rules)', () => {
  it('メンターのレベルは 1〜5 の整数だけ受け付ける。知らない項目は断る', () => {
    const h = guardHarness()
    ok(h, 'm-top', { action: 'updateSetting', key: 'assign_candidate_rules', value: JSON.stringify({ mentor_min_level: 4 }) })
    expect(JSON.stringify(h.sheets.Settings.rows)).toContain('mentor_min_level')
    for (const bad of [{ mentor_min_level: 0 }, { mentor_min_level: 6 }, { mentor_min_level: 2.5 }, { mentor_min_level: '3' }, { other: 1 }]) {
      expect(post(h, 'm-top', { action: 'updateSetting', key: 'assign_candidate_rules', value: JSON.stringify(bad) }).ok).toBe(false)
    }
  })
})
