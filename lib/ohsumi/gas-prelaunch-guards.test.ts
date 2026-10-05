// 公開前に GAS へ入れた確かめ: タスク・プロジェクトの削除の制限、メンバーのメールアドレスの必須、
// 幹部限定のタスクを担当者に見せる、退会の時に確認者・報告先・プロジェクトから外す
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

const cell = (h: ReturnType<typeof guardHarness>, sheet: string, id: string, col: string) => {
  const rows = h.sheets[sheet].rows
  return rows.find((r) => r[0] === id)![rows[0].indexOf(col)]
}
const setCell = (h: ReturnType<typeof guardHarness>, sheet: string, id: string, col: string, v: string) => {
  const rows = h.sheets[sheet].rows
  rows.find((r) => r[0] === id)![rows[0].indexOf(col)] = v
  h.props.DATA_VERSION = 'v' + Math.random()
}

describe('公開前の確かめ', () => {
  it('完了・確認待ちのタスクは削除できない', () => {
    const h = guardHarness()
    for (const st of ['done', 'review']) {
      setCell(h, 'Tasks', 't1', 'status', st)
      const r = h.post({ action: 'removeTask', sessionToken: 'm-top', taskId: 't1' })
      expect(r.ok, st).toBe(false)
      expect(String(r.error)).toContain('削除できません')
    }
  })

  it('タスクがあるプロジェクトは削除できない', () => {
    const h = guardHarness()
    const r = h.post({ action: 'removeProject', sessionToken: 'm-top', projectId: 'p1' })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('アーカイブ')
  })

  it('メールアドレスの無いメンバーは追加できない', () => {
    const h = guardHarness()
    for (const email of ['', 'abc', 'a b@c.com']) {
      expect(h.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email, role: 'base' }).ok, email).toBe(false)
    }
  })

  it('幹部限定のタスクも、担当者には見える', () => {
    const h = guardHarness()
    setCell(h, 'Tasks', 't-exec', 'assignee_id', 'm-base')
    const tasks = h.post({ action: 'getInitialData', sessionToken: 'm-base' }).result.sheets.Tasks
    expect(tasks.rows.map((r: string[]) => r[tasks.headers.indexOf('id')])).toContain('t-exec')
    const other = h.post({ action: 'getInitialData', sessionToken: 'm-other' })
    if (other.ok) {
      const t2 = other.result.sheets.Tasks
      expect(t2.rows.map((r: string[]) => r[t2.headers.indexOf('id')])).not.toContain('t-exec')
    }
  })

  it('退会すると、確認者・ほかのメンバーの報告先・プロジェクトのメンバーから外れる', () => {
    const h = guardHarness()
    setCell(h, 'Tasks', 't1', 'reviewer_ids', 'm-lead,m-top')
    const r = h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-lead' })
    expect(r.ok, r.error).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'reviewer_ids')).toBe('m-top')
    expect(cell(h, 'Members', 'm-base', 'reports_to_id')).toBe('')
    expect(r.result.cleanup.reportsTo).toEqual(['一般'])
    const r2 = h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-other' })
    expect(r2.ok, r2.error).toBe(true)
    expect(cell(h, 'Projects', 'p1', 'member_ids')).toBe('m-base')
  })
})
