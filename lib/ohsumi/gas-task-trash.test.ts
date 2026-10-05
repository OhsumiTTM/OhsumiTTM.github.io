// タスクのゴミ箱: 削除はゴミ箱に入れる(行は残す)。ゴミ箱のタスクは代表・全権管理者にだけ返し、ほかの操作を断る。
// 元に戻す・完全に消すのは代表・全権管理者だけ。完全に消す時に前提タスクの一覧から外す。30日たったら毎日の処理が消す
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
function setup() {
  const h = guardHarness()
  const rows = h.sheets.Tasks.rows
  rows[0].push('deleted_at', 'deleted_by')
  rows.slice(1).forEach((r) => r.push('', ''))
  // t-bid が t1 を前提にしている
  rows.find((r) => r[0] === 't-bid')![rows[0].indexOf('depends_on_ids')] = 't1'
  return h
}
const row = (h: H, id: string) => {
  const head = h.sheets.Tasks.rows[0]
  const r = h.sheets.Tasks.rows.find((x) => x[0] === id)
  return r ? Object.fromEntries(head.map((k, i) => [String(k), r[i]])) : undefined
}
const visibleIds = (h: H, who: string) =>
  (h.post({ action: 'getInitialData', sessionToken: who }).result.sheets.Tasks.rows as string[][]).map((r) => r[0])

describe('タスクのゴミ箱', () => {
  it('削除はゴミ箱に入れ、代表・全権管理者にだけ返す。ゴミ箱のタスクはほかの操作を断る', () => {
    const h = setup()
    expect(h.post({ action: 'removeTask', sessionToken: 'm-lead', taskId: 't1' }).ok).toBe(true)
    expect(row(h, 't1')).toMatchObject({ deleted_by: 'm-lead' })
    expect(String(row(h, 't1')!.deleted_at)).toMatch(/^\d{4}-/)
    // 前提タスクの一覧からは、まだ外さない
    expect(row(h, 't-bid')!.depends_on_ids).toBe('t1')
    expect(visibleIds(h, 'm-top')).toContain('t1')
    expect(visibleIds(h, 'm-base')).not.toContain('t1')
    for (const who of ['m-top', 'm-base']) {
      const res = h.post({ action: 'updateProgress', sessionToken: who, taskId: 't1', progressPercent: 10 })
      expect(res.ok, who).toBe(false)
      expect(res.error).toContain('ゴミ箱')
    }
    expect(h.post({ action: 'removeTask', sessionToken: 'm-top', taskId: 't1' }).ok).toBe(false)
  })

  it('元に戻す・完全に消すのは代表・全権管理者だけ。完全に消す時に前提タスクの一覧から外す', () => {
    const h = setup()
    h.post({ action: 'removeTask', sessionToken: 'm-top', taskId: 't1' })
    expect(h.post({ action: 'restoreTask', sessionToken: 'm-base', taskId: 't1' }).ok).toBe(false)
    expect(h.post({ action: 'restoreTask', sessionToken: 'm-top', taskId: 't1' }).ok).toBe(true)
    expect(row(h, 't1')).toMatchObject({ deleted_at: '', deleted_by: '' })
    expect(h.post({ action: 'purgeTask', sessionToken: 'm-top', taskId: 't1' }).ok).toBe(false)
    h.post({ action: 'removeTask', sessionToken: 'm-top', taskId: 't1' })
    expect(h.post({ action: 'purgeTask', sessionToken: 'm-base', taskId: 't1' }).ok).toBe(false)
    expect(h.post({ action: 'purgeTask', sessionToken: 'm-top', taskId: 't1' }).ok).toBe(true)
    expect(row(h, 't1')).toBeUndefined()
    expect(row(h, 't-bid')!.depends_on_ids).toBe('')
  })

  it('30日たったゴミ箱のタスクを、毎日の処理が完全に消す', () => {
    const h = setup()
    const head = h.sheets.Tasks.rows[0]
    const set = (id: string, iso: string) => { h.sheets.Tasks.rows.find((r) => r[0] === id)![head.indexOf('deleted_at')] = iso }
    const now = Date.parse('2026-10-31T00:00:00Z')
    set('t1', '2026-09-30T00:00:00Z')
    set('t-bid', '2026-10-02T00:00:00Z')
    expect((h.c.purgeExpiredTrashLocked_ as (n: number) => string[])(now)).toEqual(['t1'])
    expect(row(h, 't1')).toBeUndefined()
    expect(row(h, 't-bid')).toBeDefined()
  })

  it('集計(週ごとの数字)から外す', () => {
    const h = setup()
    const before = (h.c.metricsSnapshot_ as (n: number) => { tasks: number })(Date.now()).tasks
    h.post({ action: 'removeTask', sessionToken: 'm-top', taskId: 't1' })
    ;(h.c.forgetSheetGrid_ as () => void)()
    ;(h.c.resetRequestProps_ as () => void)?.()
    expect((h.c.metricsSnapshot_ as (n: number) => { tasks: number })(Date.now()).tasks).toBe(before - 1)
  })
})
