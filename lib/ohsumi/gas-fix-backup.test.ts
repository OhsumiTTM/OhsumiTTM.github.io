// バックアップから戻す・個人情報の削除・古いタスクを移す・記録を1件1行で持つ、の不具合の直し(gas/src/29・30・35・36・39)。
// どれも直す前のコードでは失敗する:
//   1. 全体を戻した後の個人情報の削除が、戻す前の記録の持ち方(スナップショットの Settings)で書き、1on1 の記録が残る
//   2. 全体を戻しても TasksArchive が残り、次の毎日の処理が戻したタスクを消す / 移す時に TasksArchive の古い行を残す
//   3. 消した人の個人情報が、戻すと元に戻り、ログインできる状態に戻る
//   4. 移したタスクを一部だけ戻すと、バックアップの後に付いたコメントが消える(記録を行に持っている時)
//   5. 変更の記録を1件足すたびに、前からの記録の行を全部書き直す(順番 seq がずれるため)
//   6. シートの大きさの外に書いてエラーになる(戻す時は、先に消してから書くので Tasks が空になる)
//   7. 手で作ったバックアップ・戻す前のバックアップが、毎日の分の数に数えられる。移行の前のバックアップを30日以内に消す
import { describe, expect, it } from 'vitest'
import { FakeSheet, guardHarness, type Cell } from './gas-guard-harness'
import { withDrive } from './gas-drive-fake'

type H = ReturnType<typeof guardHarness>
const DAY = 24 * 3600 * 1000
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const head = (h: H, sheet: string) => h.sheets[sheet].rows[0].map(String)
const rowOf = (h: H, sheet: string, id: string) => {
  const rows = h.sheets[sheet]?.rows ?? []
  const r = rows.slice(1).find((x) => String(x[0]) === id)
  return r ? Object.fromEntries(rows[0].map((k, i) => [String(k), r[i] ?? ''])) as Record<string, Cell> : null
}
const setCell = (h: H, sheet: string, id: string, col: string, v: Cell) => {
  const hd = head(h, sheet)
  h.sheets[sheet].rows.find((r) => String(r[0]) === id)![hd.indexOf(col)] = v
  h.props.DATA_VERSION = 'v' + Math.random()
}
const ids = (h: H, sheet: string) => (h.sheets[sheet]?.rows ?? []).slice(1).map((r) => String(r[0])).filter(Boolean)
const records = (h: H, sheet: 'TaskRecords' | 'MemberRecords', parent: string, kind?: string) =>
  (h.sheets[sheet]?.rows ?? []).slice(1).filter((r) => String(r[0]) && String(r[1]) === parent && (!kind || String(r[2]) === kind))
const state = (h: H) => {
  const row = h.sheets.Settings.rows.find((r) => r[0] === 'record_rows_state')
  return row ? JSON.parse(String(row[1])).state : 'none'
}
const viewList = (h: H, sheet: 'Tasks' | 'Members', id: string, col: string) => {
  const t = h.post({ action: 'getInitialData', sessionToken: 'm-top' }).result.sheets[sheet] as { headers: string[]; rows: string[][] }
  const row = t.rows.find((r) => r[t.headers.indexOf('id')] === id)
  return JSON.parse(row?.[t.headers.indexOf(col)] || '[]') as { id: string }[]
}
const latestBackup = (d: ReturnType<typeof withDrive>, suffix = '') =>
  d.live().filter((f) => (suffix ? f.name.endsWith(suffix) : !/\)$/.test(f.name))).at(-1)!.id

// 退会・1on1 の列と、完了の日の列を足した団体
function setup() {
  const h = guardHarness()
  const d = withDrive(h)
  const m = h.sheets.Members.rows
  for (const c of ['withdrawn_at', 'purge_at', 'personal_data_purged_at', 'will_tags', 'one_on_ones_json', 'evaluation_history_json']) {
    m[0].push(c)
    m.slice(1).forEach((r) => r.push(''))
  }
  setCell(h, 'Members', 'm-base', 'will_tags', 'デザイン')
  const t = h.sheets.Tasks.rows
  t[0].push('completed_date')
  t.slice(1).forEach((r) => r.push(''))
  return { h, d }
}
// m-base を、退会から40日たった状態にする(保存期間30日を過ぎている)
const withdrawnLongAgo = (h: H) => {
  setCell(h, 'Members', 'm-base', 'withdrawn_at', new Date(Date.now() - 40 * DAY).toISOString())
  setCell(h, 'Members', 'm-base', 'inactive', 'TRUE')
}
const ONE_ON_ONE = JSON.stringify([{ id: 'o1', withId: 'm-lead', date: '2026-09-01', notes: '1on1 の記録' }])

describe('1. 全体を戻した後の個人情報の削除は、戻した記録の持ち方で書く', () => {
  it('行に持っている時に、セルに持っていた頃のバックアップに戻す(done → none): 消したメンバーの 1on1 をセルに残さない', () => {
    const { h, d } = setup()
    setCell(h, 'Members', 'm-base', 'one_on_ones_json', ONE_ON_ONE)
    withdrawnLongAgo(h)
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    expect(h.post({ action: 'migrateRecordsToRows', sessionToken: 'm-top' }).result.state).toBe('done')
    // 読み込みでスナップショットを作っておく(戻す書き込みは、その Settings を読んでいた)
    h.post({ action: 'getInitialData', sessionToken: 'm-top' })
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    expect(state(h)).toBe('none')
    const m = rowOf(h, 'Members', 'm-base')!
    expect(String(m.personal_data_purged_at)).toMatch(/^\d{4}-/)
    expect(m.one_on_ones_json).toBe('')
    expect(records(h, 'MemberRecords', 'm-base')).toHaveLength(0)
  })

  it('セルに持っている時に、行に持っていた頃のバックアップに戻す(none → done): 消したメンバーの 1on1 の行を残さない', () => {
    const { h, d } = setup()
    setCell(h, 'Members', 'm-base', 'one_on_ones_json', ONE_ON_ONE)
    expect(h.post({ action: 'migrateRecordsToRows', sessionToken: 'm-top' }).result.state).toBe('done')
    withdrawnLongAgo(h)
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    expect(h.post({ action: 'revertRecordRows', sessionToken: 'm-top' }).result.state).toBe('none')
    h.post({ action: 'getInitialData', sessionToken: 'm-top' })
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    expect(state(h)).toBe('done')
    expect(String(rowOf(h, 'Members', 'm-base')!.personal_data_purged_at)).toMatch(/^\d{4}-/)
    expect(records(h, 'MemberRecords', 'm-base')).toHaveLength(0)
    expect(viewList(h, 'Members', 'm-base', 'one_on_ones_json')).toEqual([])
  })
})

describe('2. 全体を戻すと TasksArchive も戻す。移す時は TasksArchive の古い行を書き換える', () => {
  const finishLongAgo = (h: H, id: string) => {
    setCell(h, 'Tasks', id, 'status', 'done')
    setCell(h, 'Tasks', id, 'completed_date', new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10))
  }

  it('バックアップに無い TasksArchive は見出しだけにする(戻したタスクが、次の毎日の処理で消えない)', () => {
    const { h, d } = setup()
    finishLongAgo(h, 't1')
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    expect(call(h, 'archiveOldTasksLocked_', Date.now())).toEqual(['t1'])
    expect(ids(h, 'TasksArchive')).toEqual(['t1'])
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    expect(ids(h, 'Tasks')).toContain('t1')
    expect(ids(h, 'TasksArchive')).toEqual([])
    expect(head(h, 'TasksArchive')).toContain('archived_at')
    // 戻した後に名前を変えてから移すと、変えた後の内容が TasksArchive に入る
    setCell(h, 'Tasks', 't1', 'title', '戻した後に変えた名前')
    expect(call(h, 'archiveOldTasksLocked_', Date.now())).toEqual(['t1'])
    expect(ids(h, 'TasksArchive')).toEqual(['t1'])
    expect(rowOf(h, 'TasksArchive', 't1')!.title).toBe('戻した後に変えた名前')
  })

  it('TasksArchive に同じ ID の行が既にある時は、その行を Tasks の今の内容で書き換えてから Tasks の行を消す', () => {
    const { h } = setup()
    finishLongAgo(h, 't1')
    call(h, 'archiveOldTasksLocked_', Date.now())
    // TasksArchive に古い内容が残ったまま、Tasks にも同じタスクがある(途中で止まった後・戻した後)
    const archived = h.sheets.TasksArchive.rows.find((r) => r[0] === 't1')!
    h.sheets.Tasks.rows.push(head(h, 'Tasks').map((c) => archived[head(h, 'TasksArchive').indexOf(c)] ?? ''))
    setCell(h, 'Tasks', 't1', 'title', '新しい内容')
    expect(call(h, 'archiveOldTasksLocked_', Date.now())).toEqual(['t1'])
    expect(ids(h, 'Tasks')).not.toContain('t1')
    expect(ids(h, 'TasksArchive')).toEqual(['t1'])
    expect(rowOf(h, 'TasksArchive', 't1')!.title).toBe('新しい内容')
  })
})

describe('3. 消した人の個人情報は、戻しても戻らない', () => {
  const CANDIDATE_HEADERS = ['id', 'name', 'email', 'status', 'updated_at', 'rejected_at', 'purge_at']
  const withCandidate = (h: H) => h.addSheet('Candidates', [CANDIDATE_HEADERS,
    CANDIDATE_HEADERS.map((k) => ({ id: 'cand-no', name: '不採用の人', email: 'no@example.com', status: 'candidate', updated_at: '2026-09-01T00:00:00.000Z' } as Record<string, string>)[k] ?? '')])

  it('退会の前のバックアップに戻しても、消したメンバー(すぐ消した)・候補者は消したまま。ログインできる状態に戻らない', () => {
    const { h, d } = setup()
    withCandidate(h)
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    expect(h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-base' }).ok).toBe(true)
    call(h, 'purgePersonalDataNow_', 'member', 'm-base', 'm-top', Date.now())
    setCell(h, 'Candidates', 'cand-no', 'status', 'rejected')
    setCell(h, 'Candidates', 'cand-no', 'rejected_at', new Date().toISOString())
    call(h, 'purgePersonalDataNow_', 'candidate', 'cand-no', 'm-top', Date.now())
    expect(rowOf(h, 'Members', 'm-base')!.name).toBe('退会したメンバー')
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    const m = rowOf(h, 'Members', 'm-base')!
    expect(m.name).toBe('退会したメンバー')
    expect(m.will_tags).toBe('')
    expect(m.inactive).toBe('TRUE')
    expect(String(m.withdrawn_at)).toMatch(/^\d{4}-/)
    expect(String(m.personal_data_purged_at)).toMatch(/^\d{4}-/)
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(false)
    expect(rowOf(h, 'Candidates', 'cand-no')).toBeNull()
    expect(h.sheets.AuditLog.rows.some((r) => r[2] === 'reapplyPersonalDataPurge')).toBe(true)
    // ほかのメンバーはそのまま
    expect(rowOf(h, 'Members', 'm-other')!.name).toBe('他人')
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-other')).toBe(true)
  })

  it('印(スクリプトプロパティ)を残す前に消した人も、操作の記録(AuditLog。戻さない)から読んで消し直す', () => {
    const { h, d } = setup()
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-base' })
    call(h, 'purgePersonalDataNow_', 'member', 'm-base', 'm-top', Date.now())
    for (const k of Object.keys(h.props)) if (k.startsWith('PURGED_PERSONAL_DATA_')) delete h.props[k]
    expect(h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId }).ok).toBe(true)
    expect(rowOf(h, 'Members', 'm-base')!.will_tags).toBe('')
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(false)
  })

  it('一部のタスクを戻した後にも、戻ってきていた MemberEmails の行を消す', () => {
    const { h, d } = setup()
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-base' })
    call(h, 'purgePersonalDataNow_', 'member', 'm-base', 'm-top', Date.now())
    h.sheets.MemberEmails.rows.push(['m-base', 'base@example.com'])
    expect(h.post({ action: 'restoreTasks', sessionToken: 'm-top', backupId, taskIds: ['t1'] }).ok).toBe(true)
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(false)
  })

  it('消した人の一覧は、9KB に収まるように分けて持つ', () => {
    const { h } = setup()
    for (let i = 0; i < 600; i++) call(h, 'rememberPurgedId_', 'candidate', 'cand-' + 'x'.repeat(20) + i)
    const keys = Object.keys(h.props).filter((k) => k.startsWith('PURGED_PERSONAL_DATA_'))
    expect(keys.length).toBeGreaterThan(1)
    for (const k of keys) expect(Buffer.byteLength(h.props[k], 'utf8')).toBeLessThan(9000)
    expect(Object.keys((call(h, 'purgedPersonalIds_') as { candidate: Record<string, boolean> }).candidate)).toHaveLength(600)
  })
})

describe('4. 移したタスクを一部だけ戻す時は、TaskRecords の記録と合わせる(記録を行に持っている時)', () => {
  it('バックアップの後に付いたコメント・進み具合を消さない', () => {
    const { h, d } = setup()
    expect(h.post({ action: 'migrateRecordsToRows', sessionToken: 'm-top' }).result.state).toBe('done')
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    const add = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1',
      comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-after', byId: 'm-base', text: 'バックアップの後のコメント' }] })
    expect(add.ok, add.error).toBe(true)
    expect(records(h, 'TaskRecords', 't1', 'comment').map((r) => r[3])).toContain('c-after')
    setCell(h, 'Tasks', 't1', 'status', 'done')
    setCell(h, 'Tasks', 't1', 'completed_date', new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10))
    expect(call(h, 'archiveOldTasksLocked_', Date.now())).toEqual(['t1'])
    const res = h.post({ action: 'restoreTasks', sessionToken: 'm-top', backupId, taskIds: ['t1'] })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.restored).toEqual([{ id: 't1', title: 'タスク1', state: 'unarchived' }])
    expect(viewList(h, 'Tasks', 't1', 'comments_json').map((c) => c.id)).toEqual(['c-old', 'c-after'])
    expect(viewList(h, 'Tasks', 't1', 'progress_history_json').map((c) => c.id)).toEqual(['pg-old'])
  })
})

describe('5. 変更の記録を足しても、前からの記録の行を書き直さない', () => {
  const history = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: 'h' + (from + n - i), at: '2026-09-0' + ((i % 9) + 1), byId: 'm-lead', field: 'title', from: 'a', to: 'b' }))
  const cfg = (h: H) => (h.c.RECORD_LISTS as { column: string }[]).find((c) => c.column === 'history_json')
  const sync = (h: H, list: unknown[]) => {
    h.props.DATA_VERSION = 'v' + Math.random()
    return call(h, 'syncRecordListsBulk_', 'TaskRecords', [{ cfg: cfg(h), parentId: 't1', list }]) as number
  }

  it('新しい順の一覧の先頭に足すと、足した1行だけを書く。読む順番は一覧と同じ', () => {
    const { h } = setup()
    setCell(h, 'Tasks', 't1', 'history_json', JSON.stringify(history(5)))
    expect(h.post({ action: 'migrateRecordsToRows', sessionToken: 'm-top' }).result.state).toBe('done')
    const before = records(h, 'TaskRecords', 't1', 'history').map((r) => r.join('|'))
    let list = history(5)
    for (let k = 1; k <= 3; k++) {
      list = [{ id: 'new' + k, at: '2026-10-0' + k, byId: 'm-base', field: 'status', from: 'todo', to: 'doing' }, ...list]
      expect(sync(h, list), 'k=' + k).toBe(1)
    }
    // 前からの行は書き換えていない(seq も updated_at もそのまま)
    const after = records(h, 'TaskRecords', 't1', 'history').map((r) => r.join('|'))
    for (const r of before) expect(after).toContain(r)
    expect(viewList(h, 'Tasks', 't1', 'history_json').map((e) => e.id)).toEqual(list.map((e) => e.id))
    // 間に足す・並べ替える・消す時も、読む順番は一覧と同じ
    list = [list[0], { id: 'mid', at: '2026-10-05', byId: 'm-base', field: 'x', from: '', to: '' }, ...list.slice(1)]
    expect(sync(h, list)).toBe(1)
    expect(viewList(h, 'Tasks', 't1', 'history_json').map((e) => e.id)).toEqual(list.map((e) => e.id))
    list = list.slice().reverse().filter((e) => e.id !== 'h3')
    sync(h, list)
    expect(viewList(h, 'Tasks', 't1', 'history_json').map((e) => e.id)).toEqual(list.map((e) => e.id))
  })

  it('seq の決め方(純粋な関数)', () => {
    const { h } = setup()
    const seqs = (olds: (number | null)[]) => call(h, 'assignRecordSeqs_', olds) as number[]
    expect(seqs([null, null, null])).toEqual([0, 1, 2])
    expect(seqs([null, 0, 1, 2])).toEqual([-1, 0, 1, 2])
    expect(seqs([null, null, -1, 0])).toEqual([-3, -2, -1, 0])
    expect(seqs([0, 1, null, null])).toEqual([0, 1, 2, 3])
    expect(seqs([0, null, 1])).toEqual([0, 0.5, 1])
    // 並べ替えた時は振り直す
    expect(seqs([2, 1, null])).toEqual([0, 1, 2])
  })
})

// 実際のスプレッドシートと同じく、シートの大きさ(行の数)の外を getRange するとエラーになるシート
class SizedSheet extends FakeSheet {
  maxRows: number
  constructor(name: string, rows: Cell[][]) {
    super(name, rows)
    this.maxRows = Math.max(rows.length, 1)
  }
  getMaxRows() { return this.maxRows }
  insertRowsAfter(_after: number, n: number) { this.maxRows += n }
  appendRow(row: Cell[]) { super.appendRow(row); this.maxRows = Math.max(this.maxRows, this.rows.length) }
  deleteRow(r: number) { super.deleteRow(r); this.maxRows = Math.max(this.maxRows - 1, 1) }
  getRange(a: number | string, col = 1, numRows = 1, numCols = 1) {
    const row = typeof a === 'number' ? a : 1
    if (row + numRows - 1 > this.maxRows) throw new Error('範囲の座標がシートの大きさの外です')
    return super.getRange(a, col, numRows, numCols)
  }
}
const sized = (h: H, name: string) => { h.sheets[name] = new SizedSheet(name, h.sheets[name].rows) }

describe('6. シートの大きさの外に書かない', () => {
  it('全体を戻す: 今の Tasks より行が多いバックアップでも戻せる(途中で失敗して Tasks が空にならない)', () => {
    const { h, d } = setup()
    h.sheets.Tasks.rows.push(head(h, 'Tasks').map((c) => (c === 'id' ? 't-extra' : c === 'title' ? '後で消したタスク' : '')))
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    sized(h, 'Tasks')
    ;(h.sheets.Tasks as SizedSheet).deleteRow(h.sheets.Tasks.rows.length)
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    expect(ids(h, 'Tasks')).toEqual(['t1', 't-bid', 't-exec', 't-extra'])
  })

  it('移す・一部のタスクを戻す・移したタスクを戻す・団体の保存: 最後の行まで埋まったシートにも足せる', () => {
    const { h, d } = setup()
    setCell(h, 'Tasks', 't1', 'status', 'done')
    setCell(h, 'Tasks', 't1', 'completed_date', new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10))
    call(h, 'dailyBackup_', Date.now())
    const backupId = latestBackup(d)
    call(h, 'tasksArchiveSheet_', true)
    sized(h, 'TasksArchive')
    expect(call(h, 'archiveOldTasksLocked_', Date.now())).toEqual(['t1'])
    expect(ids(h, 'TasksArchive')).toEqual(['t1'])
    sized(h, 'Tasks')
    expect(h.post({ action: 'restoreTasks', sessionToken: 'm-top', backupId, taskIds: ['t1'] }).ok).toBe(true)
    expect(ids(h, 'Tasks')).toContain('t1')
    // 移したタスクを戻す
    call(h, 'archiveOldTasksLocked_', Date.now())
    sized(h, 'Tasks')
    expect((call(h, 'unarchiveTasks_', ['t1']) as { restored: string[] }).restored).toEqual(['t1'])
    expect(ids(h, 'Tasks')).toContain('t1')
    // 団体の保存
    call(h, 'orgStoreSheet_', true)
    sized(h, 'OrgStore')
    expect(() => call(h, 'setOrgStorage_', { id: 'm-top', role: 'top' }, 'k1', 'x'.repeat(90000))).not.toThrow()
    expect(h.sheets.OrgStore.rows.slice(1).filter((r) => r[0] === 'k1')).toHaveLength(3)
  })
})

describe('7. バックアップを残す数', () => {
  const keysOf = (e: { at: number }) => {
    const day = new Date(e.at).toISOString().slice(0, 10)
    return { day, week: day, month: day.slice(0, 7) }
  }
  const NOW = Date.parse('2026-10-10T00:00:00Z')

  it('手で作った分・戻す前の分は、毎日の分の7つに数えない。移行の前の分は30日のあいだ消さない', () => {
    const { h } = setup()
    const entries = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: 'manual' + i, at: NOW - i * 3600 * 1000, kind: 'manual' })),
      { id: 'before-restore', at: NOW - 5 * 3600 * 1000, kind: 'beforeRestore' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: 'daily' + i, at: NOW - (i + 1) * DAY, kind: 'daily' })),
      { id: 'migration', at: NOW - 20 * DAY, kind: 'beforeMigration' },
      { id: 'old-migration', at: NOW - 40 * DAY, kind: 'beforeMigration' },
    ].sort((a, b) => b.at - a.at)
    const keep = call(h, 'backupsToKeep_', entries, keysOf, NOW) as Record<string, boolean>
    for (let i = 0; i < 7; i++) expect(keep['daily' + i], 'daily' + i).toBe(true)
    for (let i = 0; i < 4; i++) expect(keep['manual' + i], 'manual' + i).toBe(true)
    expect(keep['before-restore']).toBe(true)
    expect(keep.migration).toBe(true)
    expect(keep['old-migration']).toBeUndefined()
  })

  it('手で作ったバックアップは名前の最後に「(手動)」を付け、一覧では種類で見分ける', () => {
    const { h, d } = setup()
    const r = h.post({ action: 'createBackupNow', sessionToken: 'm-top' })
    expect(r.ok, r.error).toBe(true)
    expect(r.result.backup.name).toMatch(/\(手動\)$/)
    expect(call(h, 'backupKindOfName_', d.live()[0].name)).toBe('manual')
    expect(call(h, 'backupKindOfName_', 'Ohsumi バックアップ 2026-10-01 06:00(移行の前)')).toBe('beforeMigration')
    expect(call(h, 'backupKindOfName_', 'Ohsumi バックアップ 2026-10-01 06:00')).toBe('daily')
  })
})
