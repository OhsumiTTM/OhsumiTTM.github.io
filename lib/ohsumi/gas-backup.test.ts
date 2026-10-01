// バックアップ(PR F): 毎日のコピー・残す数・失敗の記録・全体を戻す・一部のタスクだけ戻す・戻している間の書き込みの停止
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, type Cell } from './gas-guard-harness'
import { withDrive } from './gas-drive-fake'

type H = ReturnType<typeof guardHarness>
const DAY = 24 * 3600 * 1000
// 書き込みの例: コメントを足す
const writeSomething = (h: H) => h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1',
  comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-w' + Math.random(), byId: 'm-base', text: '書き込み' }] })
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

const rowOf = (h: H, sheet: string, id: string) => {
  const rows = h.sheets[sheet].rows
  const r = rows.find((x) => x[0] === id)
  return r ? Object.fromEntries(rows[0].map((k, i) => [String(k), r[i]])) : null
}
const setCell = (h: H, sheet: string, id: string, col: string, v: Cell) => {
  const rows = h.sheets[sheet].rows
  rows.find((x) => x[0] === id)![rows[0].indexOf(col)] = v
  h.props.DATA_VERSION = 'v' + Math.random()
}

describe('毎日のバックアップ', () => {
  it('毎日の処理で、スプレッドシートだけをバックアップのフォルダにコピーし、GAS のアカウント以外に共有しない', () => {
    const h = guardHarness()
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    expect(d.copies).toEqual(['ss'])
    expect(d.live()).toHaveLength(1)
    const f = d.live()[0]
    expect(f.name).toMatch(/^Ohsumi バックアップ /)
    expect(f.folder).toBe('backup-folder')
    expect(f.editorsRemoved).toEqual(['editor@example.com', 'viewer@example.com'])
    expect(f.sharing).toEqual([['PRIVATE', 'NONE']])
    expect(call(h, 'backupStatus_')).toMatchObject({ failed: false, lastSuccessAt: expect.stringMatching(/^\d{4}-/) })
  })

  it('作るのに失敗した日は記録し、代表の管理画面に出す(次に作れたら消える)。代表以外は読めない', () => {
    const h = guardHarness()
    withDrive(h, { failCopy: true })
    call(h, 'dailyMaintenance')
    const st = h.post({ action: 'getBackupStatus', sessionToken: 'm-top' })
    expect(st.result).toMatchObject({ failed: true, error: 'Drive の容量が足りません', failedAt: expect.stringMatching(/^\d{4}-/) })
    expect(h.post({ action: 'getBackupStatus', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
    withDrive(h)
    call(h, 'dailyMaintenance')
    expect(h.post({ action: 'getBackupStatus', sessionToken: 'm-top' }).result.failed).toBe(false)
  })

  it('残す数は、毎日の分7つ・毎週の分4つ・毎月の分3つ。超えた古いものはゴミ箱に移す(最長で約3か月)', () => {
    const h = guardHarness()
    const d = withDrive(h)
    // 日本時間の日・週(月曜から)・月
    h.c.backupPeriodKeys_ = (ms: number) => {
      const j = new Date(ms + 9 * 3600 * 1000)
      const day = j.toISOString().slice(0, 10)
      const mon = new Date(j.getTime() - ((j.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10)
      return { day, week: mon, month: day.slice(0, 7) }
    }
    const start = Date.parse('2026-06-01T06:00:00+09:00')
    for (let i = 0; i < 120; i++) {
      d.setNow(start + i * DAY)
      call(h, 'dailyBackup_', start + i * DAY)
    }
    const kept = d.live().map((f) => f.created).sort((a, b) => b - a)
    const newest = start + 119 * DAY
    // 毎日の分: 新しい7つ
    expect(kept.slice(0, 7)).toEqual(Array.from({ length: 7 }, (_, i) => newest - i * DAY))
    // 毎週の分(週の最後の日曜日)と毎月の分(月末)を足しても、14以下。一番古いものは3か月以内
    expect(kept.length).toBeLessThanOrEqual(14)
    expect(newest - kept.at(-1)!).toBeLessThan(92 * DAY)
    // 毎月の分: 7・8・9月の月末
    for (const m of ['2026-07-31', '2026-08-31']) expect(kept).toContain(Date.parse(m + 'T06:00:00+09:00'))
    expect(d.files.filter((f) => f.trashed).length).toBe(120 - kept.length)
  })
})

describe('全体を戻す', () => {
  it('戻す前に件数の差を見せる。戻す前に今の状態をバックアップし、データのシートを置き換え、操作の記録は残す。データの版を上げる', () => {
    const h = guardHarness()
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    const backupId = d.live()[0].id
    // バックアップの後の変更: タスクを1つ足し、名前を変え、操作の記録を書く
    h.sheets.Tasks.rows.push(h.sheets.Tasks.rows[1].map((v, i) => (i === 0 ? 't-new' : v)))
    setCell(h, 'Tasks', 't1', 'title', '変えた名前')
    h.addSheet('AuditLog', [['at', 'actor_id', 'action', 'target', 'detail_json'], ['2026-10-01', 'm-top', 'other', '', '{}']])
    const preview = h.post({ action: 'previewRestore', sessionToken: 'm-top', backupId })
    expect(preview.ok, preview.error).toBe(true)
    expect(preview.result.sheets).toContainEqual({ name: 'Tasks', current: 4, backup: 3 })
    expect(preview.result.sheets.map((s: { name: string }) => s.name)).not.toContain('AuditLog')

    const before = { data: h.props.DATA_VERSION, emails: h.props.MEMBER_EMAILS_VERSION }
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.beforeRestore.name).toMatch(/\(戻す前\)$/)
    expect(rowOf(h, 'Tasks', 't-new')).toBeNull()
    expect(rowOf(h, 'Tasks', 't1')!.title).toBe('タスク1')
    // 戻す前のバックアップには、戻す前の内容が入っている
    expect(d.live().find((f) => f.name.endsWith('(戻す前)'))!.sheets.Tasks.some((r) => r[0] === 't-new')).toBe(true)
    // 操作の記録は残り、戻したことが足される
    const audit = h.sheets.AuditLog.rows.slice(1)
    expect(audit[0][2]).toBe('other')
    expect(audit.at(-1)!.slice(1, 3)).toEqual(['m-top', 'restoreBackup'])
    expect(h.props.DATA_VERSION).not.toBe(before.data)
    expect(h.props.MEMBER_EMAILS_VERSION).not.toBe(before.emails)
    expect(h.props.RESTORE_IN_PROGRESS).toBeUndefined()
  })

  it('戻している間は書き込みを止める(読み取りは受け付ける)。印が残ったままでも30分を過ぎたら受け付ける', () => {
    const h = guardHarness()
    h.props.RESTORE_IN_PROGRESS = JSON.stringify({ by: 'm-top', startedAt: new Date().toISOString() })
    const write = writeSomething(h)
    expect(write).toMatchObject({ ok: false, restoring: true })
    expect(write.error).toContain('バックアップから戻しています')
    expect(h.post({ action: 'getBackgroundData', sessionToken: 'm-base' }).ok).toBe(true)
    h.props.RESTORE_IN_PROGRESS = JSON.stringify({ by: 'm-top', startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })
    expect(writeSomething(h).ok).toBe(true)
  })

  it('戻すのは代表だけ。バックアップのフォルダに無いファイルは開かない', () => {
    const h = guardHarness()
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    for (const who of ['m-lead', 'm-base']) {
      expect(h.post({ action: 'restoreBackup', sessionToken: who, backupId: d.live()[0].id })).toMatchObject({ ok: false, forbidden: true })
      expect(h.post({ action: 'listBackups', sessionToken: who })).toMatchObject({ ok: false, forbidden: true })
    }
    const other = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId: 'ss' })
    expect(other.ok).toBe(false)
    expect(other.error).toContain('そのバックアップは見つかりません')
    expect(h.post({ action: 'listBackups', sessionToken: 'm-top' }).result.backups).toHaveLength(1)
  })
})

describe('一部のタスクだけ戻す', () => {
  const comments = (list: { id: string; text: string }[]) => JSON.stringify(list.map((c) => ({ ...c, byId: 'm-lead', at: '2026-09-01' })))

  it('名前で探し、今の内容との違いを並べる。今は消えているタスクは「復元」', () => {
    const h = guardHarness()
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    setCell(h, 'Tasks', 't1', 'status', 'done')
    h.sheets.Tasks.rows = h.sheets.Tasks.rows.filter((r) => r[0] !== 't-bid')
    const res = h.post({ action: 'searchBackupTasks', sessionToken: 'm-top', backupId: d.live()[0].id, query: 'タスク' })
    expect(res.ok, res.error).toBe(true)
    const byId = Object.fromEntries(res.result.tasks.map((t: { id: string }) => [t.id, t]))
    expect(byId.t1).toMatchObject({ state: 'changed', diffs: [{ field: 'status', current: 'done', backup: 'todo' }] })
    expect(byId['t-bid']).toMatchObject({ state: 'missing' })
    expect(byId['t-exec']).toMatchObject({ state: 'same' })
  })

  it('選んだタスクの行と記録だけを戻す。バックアップの後に付いたコメントは残し、戻したことを履歴と操作の記録に残す', () => {
    const h = guardHarness()
    const d = withDrive(h)
    setCell(h, 'Tasks', 't1', 'comments_json', comments([{ id: 'c-a', text: '前からのコメント' }, { id: 'c-b', text: '後で消したコメント' }]))
    call(h, 'dailyMaintenance')
    const backupId = d.live()[0].id
    // バックアップの後: 名前を変え、コメントを1つ消して1つ足し、別のタスクも変え、1つ消す
    setCell(h, 'Tasks', 't1', 'title', '壊れた名前')
    setCell(h, 'Tasks', 't1', 'comments_json', comments([{ id: 'c-a', text: '前からのコメント' }, { id: 'c-c', text: '後で足したコメント' }]))
    setCell(h, 'Tasks', 't-exec', 'title', 'そのままにする変更')
    h.sheets.Tasks.rows = h.sheets.Tasks.rows.filter((r) => r[0] !== 't-bid')
    const members = h.sheets.Members.rows.length
    const res = h.post({ action: 'restoreTasks', sessionToken: 'm-top', backupId, taskIds: ['t1', 't-bid'] })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.restored).toEqual([{ id: 't1', title: 'タスク1', state: 'restored' }, { id: 't-bid', title: '公募タスク', state: 'recreated' }])
    const t1 = rowOf(h, 'Tasks', 't1')!
    expect(t1.title).toBe('タスク1')
    expect(JSON.parse(String(t1.comments_json)).map((c: { id: string }) => c.id)).toEqual(['c-a', 'c-b', 'c-c'])
    const history = JSON.parse(String(t1.history_json))
    expect(history[0]).toMatchObject({ field: 'restored', byId: 'm-top', from: expect.stringMatching(/^\d{4}-/) })
    expect(rowOf(h, 'Tasks', 't-bid')!.title).toBe('公募タスク')
    // ほかのタスク・メンバーは変えない
    expect(rowOf(h, 'Tasks', 't-exec')!.title).toBe('そのままにする変更')
    expect(h.sheets.Members.rows.length).toBe(members)
    expect(h.sheets.AuditLog.rows.at(-1)!.slice(1, 3)).toEqual(['m-top', 'restoreTasks'])
  })
})

describe('守る処理を外すと失敗する', () => {
  const mutated = (from: string, to: string) => {
    const code = CODE_GS.replace(from, to)
    expect(code, from).not.toBe(CODE_GS)
    return code
  }

  it('戻している間の書き込みの停止を外すと、書き込みが通ってしまう', () => {
    const h = guardHarness({ code: mutated('if (!readOnlyAllows_(body) && restoreInProgress_())', 'if (false)') })
    h.props.RESTORE_IN_PROGRESS = JSON.stringify({ by: 'm-top', startedAt: new Date().toISOString() })
    expect(writeSomething(h).ok).toBe(true)
  })

  it('バックアップのフォルダの確かめを外すと、ほかのファイルを開いてしまう', () => {
    const h = guardHarness({ code: mutated("if (!found) throw userError_('そのバックアップは見つかりません。一覧を読み直してください。')", "if (!found) found = { id: id, name: id, at: new Date().toISOString() }") })
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    expect(h.post({ action: 'previewRestore', sessionToken: 'm-top', backupId: d.live()[0].id }).ok).toBe(true)
    expect(h.post({ action: 'previewRestore', sessionToken: 'm-top', backupId: 'bk-other' }).error).not.toContain('見つかりません')
  })

  it('記録を合わせる処理を外すと、バックアップの後に付いたコメントが消える', () => {
    const h = guardHarness({ code: mutated('var merged = mergeTaskList_(parseJsonList_(bt[h]), parseJsonList_(cur ? cur[c] : \'[]\'), h === \'history_json\')', 'var merged = parseJsonList_(bt[h])') })
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    setCell(h, 'Tasks', 't1', 'comments_json', JSON.stringify([{ id: 'c-c', text: '後で足した', byId: 'm-lead', at: '2026-10-01' }]))
    h.post({ action: 'restoreTasks', sessionToken: 'm-top', backupId: d.live()[0].id, taskIds: ['t1'] })
    expect(String(rowOf(h, 'Tasks', 't1')!.comments_json)).not.toContain('c-c')
  })

  it('戻す前のバックアップを外すと、戻す前の状態が残らない', () => {
    const h = guardHarness({ code: mutated("var before = createBackup_('beforeRestore', nowMs)", "var before = { name: '' }") })
    const d = withDrive(h)
    call(h, 'dailyMaintenance')
    h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId: d.live()[0].id })
    expect(d.live().some((f) => f.name.endsWith('(戻す前)'))).toBe(false)
  })
})

// 使わない値の警告を避ける
void plain
