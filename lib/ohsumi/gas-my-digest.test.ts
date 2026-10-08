// 兼部の統合表示のための読み取り(getMyDigest。gas/src/40-my-digest.gs): 本人の担当・確認待ち・回答待ちだけを返し、
// ほかの人のデータ・団体の設定・説明やコメントは返さない
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const set = (h: H, id: string, fields: Record<string, string>) => {
  const [head, ...rows] = h.sheets.Tasks.rows
  const row = rows.find((r) => r[0] === id)!
  for (const [k, v] of Object.entries(fields)) row[head.indexOf(k)] = v
  h.props.DATA_VERSION = 'v' + Math.random()
}
const digest = (h: H, who: string, extra: Record<string, unknown> = {}) => h.post({ action: 'getMyDigest', sessionToken: who, from: '2026-10-01', to: '2026-10-31', ...extra })

describe('getMyDigest', () => {
  it('本人が担当の、完了していないタスクだけ。返す項目は決めたものだけ(説明・コメント・ほかの人の名前は無い)', () => {
    const h = guardHarness()
    set(h, 't1', { due_date: '2026-10-20', description: '秘密の説明', schedule_json: '' })
    const res = digest(h, 'm-base')
    expect(res.ok, res.error).toBe(true)
    expect(Object.keys(res.result).sort()).toEqual(['contract', 'counts', 'memberId', 'memberName', 'orgName', 'tasks', 'themeColor', 'truncated', 'version'])
    expect(res.result.orgName).toBe('テスト団体')
    expect(res.result.tasks.map((t: { id: string }) => t.id)).toEqual(['t1'])
    expect(Object.keys(res.result.tasks[0]).sort()).toEqual(['dueDate', 'dueTime', 'id', 'importance', 'overdue', 'priority', 'projectName', 'role', 'startDate', 'status', 'title'])
    expect(res.result.tasks[0]).toMatchObject({ role: 'assignee', projectName: 'P', dueDate: '2026-10-20' })
    const text = JSON.stringify(res.result)
    for (const secret of ['秘密の説明', '前からのコメント', '班長の進捗', '幹部限定タスク', 'org@example.com', '他人']) expect(text).not.toContain(secret)
    // 完了したタスク・期間より後の期限は返さない
    set(h, 't1', { due_date: '2026-12-01' })
    expect(digest(h, 'm-base').result.tasks).toEqual([])
    set(h, 't1', { due_date: '2026-10-20', status: 'done' })
    expect(digest(h, 'm-base').result.tasks).toEqual([])
  })

  it('幹部限定のタスクは、見えない人には返さない。担当している幹部には返す', () => {
    const h = guardHarness()
    expect(digest(h, 'm-base').result.tasks.some((t: { id: string }) => t.id === 't-exec')).toBe(false)
    expect(digest(h, 'm-lead').result.tasks.some((t: { id: string }) => t.id === 't-exec')).toBe(true)
  })

  it('確認待ち: 確認する人に reviewTarget で返す(担当者本人には出さない)', () => {
    const h = guardHarness()
    set(h, 't1', { status: 'review', reviewer_ids: 'm-other', schedule_json: '' })
    const other = digest(h, 'm-other').result
    expect(other.tasks).toEqual([expect.objectContaining({ id: 't1', role: 'reviewTarget' })])
    expect(other.counts.reviewWaiting).toBe(1)
    expect(digest(h, 'm-base').result.tasks.find((t: { id: string }) => t.id === 't1')?.role).not.toBe('reviewTarget')
  })

  it('日程調整に答えていない人には、回答待ち(invitee)で候補ごと返す。答えた人には返さない', () => {
    const h = guardHarness()
    set(h, 't1', { schedule_json: JSON.stringify({ candidates: [{ id: 'c1', label: '10/10 10:00', date: '2026-10-10', startTime: '10:00' }], invitedIds: ['m-other', 'm-base'], responses: { 'm-base': { c1: 'yes' } } }) })
    const other = digest(h, 'm-other').result
    expect(other.tasks).toEqual([expect.objectContaining({ id: 't1', role: 'invitee', inviteKind: 'schedule', candidates: [expect.objectContaining({ id: 'c1', date: '2026-10-10' })] })])
    expect(other.counts.unanswered).toBe(1)
    expect(digest(h, 'm-base').result.tasks[0].role).toBe('assignee')
  })

  it('データの版が同じなら unchanged だけ。期間は62日まで', () => {
    const h = guardHarness()
    const first = digest(h, 'm-base').result
    expect(digest(h, 'm-base', { knownVersion: first.version }).result).toEqual({ version: first.version, unchanged: true })
    expect(digest(h, 'm-base', { from: '2026-10-01', to: '2027-01-01' })).toMatchObject({ ok: false })
    expect(digest(h, 'm-base', { from: '2026/10/01' })).toMatchObject({ ok: false })
  })
})
