// 古いタスクを移す(TasksArchive): 完了してから決めた日数(taskArchiveDays。既定365日)がたったタスクを毎日の処理で移す。
// ふだんの読み込みには入れない。検索(見てよいタスクだけ)・スキルの条件・バックアップから戻す、に使う。戻す操作は代表・全権管理者だけ
import { describe, expect, it } from 'vitest'
import { CODE_GS, FakeSheet, guardHarness, noop } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const NOW = Date.parse('2026-10-05T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString().slice(0, 10)
const setup = () => {
  const h = guardHarness()
  const rows = h.sheets.Tasks.rows
  for (const c of ['completed_date', 'skills', 'deleted_at']) { rows[0].push(c); rows.slice(1).forEach((r) => r.push('')) }
  const add = (o: Record<string, string>) => rows.push(rows[0].map((k) => o[String(k)] ?? ''))
  add({ id: '50', title: '去年の企画書', project_id: 'p1', assignee_id: 'm-base', status: 'done', visibility: 'all', completed_date: daysAgo(400), skills: '企画' })
  add({ id: '51', title: '最近の完了', project_id: 'p1', assignee_id: 'm-base', status: 'done', visibility: 'all', completed_date: daysAgo(30) })
  add({ id: '52', title: '去年の幹部の仕事', project_id: 'p1', assignee_id: 'm-lead', status: 'done', visibility: 'leaders', completed_date: daysAgo(500) })
  add({ id: '53', title: '去年のゴミ箱', project_id: 'p1', status: 'done', visibility: 'all', completed_date: daysAgo(500), deleted_at: '2026-10-01T00:00:00Z' })
  add({ id: '54', title: '前提の古いタスク', project_id: 'p1', status: 'done', visibility: 'all', completed_date: daysAgo(500) })
  add({ id: '55', title: '去年の未完了', project_id: 'p1', status: 'todo', visibility: 'all', due_date: daysAgo(500) })
  rows.find((r) => r[0] === 't1')![rows[0].indexOf('depends_on_ids')] = '54'
  return h
}
const ids = (h: H, sheet: string) => (h.sheets[sheet]?.rows ?? []).slice(1).map((r) => String(r[0]))
const archive = (h: H) => (h.c.archiveOldTasksLocked_ as (n: number) => string[])(NOW)
const restrictLead = (h: H) => {
  const roles = JSON.parse(String(h.sheets.Settings.rows[1][1])) as { id: string; restricted?: boolean }[]
  roles.find((r) => r.id === 'r-lead')!.restricted = true
  h.sheets.Settings.rows[1][1] = JSON.stringify(roles)
}

describe('古いタスクを移す', () => {
  it('完了から365日たったタスクだけを移す(最近の完了・未完了・ゴミ箱・前提として参照されているタスクは残す)', () => {
    const h = setup()
    expect(archive(h).sort()).toEqual(['50', '52'])
    expect(ids(h, 'Tasks')).toEqual(['t1', 't-bid', 't-exec', '51', '53', '54', '55'])
    expect(ids(h, 'TasksArchive')).toEqual(['50', '52'])
    const head = h.sheets.TasksArchive.rows[0].map(String)
    expect(String(h.sheets.TasksArchive.rows[1][head.indexOf('archived_at')])).toBe(new Date(NOW).toISOString())
    expect(String(h.sheets.TasksArchive.rows[1][head.indexOf('title')])).toBe('去年の企画書')
    // ふだんの読み込みには入らない
    const tasks = h.post({ action: 'getInitialData', sessionToken: 'm-top' }).result.sheets.Tasks as { rows: string[][] }
    expect(tasks.rows.map((r) => r[0])).not.toContain('50')
    // 2回目は何もしない
    expect(archive(h)).toEqual([])
    // 毎日の処理から呼ぶ
    expect(/function dailyMaintenanceUnrecorded_\(\) \{[\s\S]*?archiveOldTasksLocked_\(/.test(CODE_GS)).toBe(true)
  })

  it('日数はレジストリから変えられる(範囲の外は端の値)', () => {
    const h = setup()
    h.props.CONTRACT_STATE = JSON.stringify({ tunables: { taskArchiveDays: 10 } }) // 90日に収める
    expect(archive(h).sort()).toEqual(['50', '52'])
    const h2 = setup()
    h2.props.CONTRACT_STATE = JSON.stringify({ tunables: { taskArchiveDays: 450 } })
    expect(archive(h2)).toEqual(['52'])
  })

  it('移したタスクの ID は使い直さない。プロジェクトは消せない。スキルの条件の「完了したタスクの数」に数える', () => {
    const h = setup()
    archive(h)
    h.sheets.Tasks.rows = h.sheets.Tasks.rows.filter((r) => !['51', '53', '54', '55'].includes(String(r[0])))
    h.sheets.Tasks.rows.find((r) => r[0] === 't1')![h.sheets.Tasks.rows[0].indexOf('depends_on_ids')] = ''
    h.props.DATA_VERSION = 'v2'
    const res = h.post({ action: 'createTasks', sessionToken: 'm-top', tasks: [{ tempId: 'a', title: '新しい', projectId: 'p1', department: 'ops', category: '', skills: [], difficulty: 'anyone', priority: 'medium', deadline: null }] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(Number((res.result as { id: string }[])[0].id)).toBeGreaterThan(52)
    h.sheets.Projects.rows.push(['p2', 'P2', '', ''])
    h.sheets.TasksArchive.rows[1][h.sheets.TasksArchive.rows[0].indexOf('project_id')] = 'p2'
    h.props.DATA_VERSION = 'v3'
    const rm = h.post({ action: 'removeProject', sessionToken: 'm-top', projectId: 'p2' })
    expect(rm.ok).toBe(false)
    expect(rm.error).toContain('移した古いタスク')
    const ev = (h.c.skillEvidenceOf_ as (row: object, id: string) => { doneTaskCounts: Record<string, number> })({}, 'm-base')
    expect(ev.doneTaskCounts['企画']).toBe(1)
  })

  it('検索は、見てよいタスクだけを返す', () => {
    const h = setup()
    archive(h)
    const search = (who: string, body: Record<string, unknown>) => h.post({ action: 'searchArchivedTasks', sessionToken: who, ...body })
    const titles = (res: { result: { headers: string[]; rows: string[][] } }) => res.result.rows.map((r) => r[res.result.headers.indexOf('title')])
    expect(titles(search('m-other', { query: '去年' }))).toEqual(['去年の企画書'])
    expect(titles(search('m-lead', { query: '去年' })).sort()).toEqual(['去年の企画書', '去年の幹部の仕事'])
    expect(titles(search('m-base', { memberId: 'm-base' }))).toEqual(['去年の企画書'])
    const res = search('m-other', { query: '企画' })
    expect(res.result.archivedAt['50']).toBe(new Date(NOW).toISOString())
    expect(res.result.headers).not.toContain('calendar_event_id')
    expect(search('m-other', { query: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('戻す操作は代表・全権管理者だけ。戻すと Tasks に戻り、TasksArchive から消える', () => {
    const h = setup()
    restrictLead(h)
    archive(h)
    for (const who of ['m-base', 'm-lead']) {
      expect(h.post({ action: 'unarchiveTasks', sessionToken: who, taskIds: ['50'] }).ok, who).toBe(false)
    }
    expect(ids(h, 'TasksArchive')).toEqual(['50', '52'])
    expect(h.post({ action: 'unarchiveTasks', sessionToken: 'm-top', taskIds: ['nope'] }).ok).toBe(false)
    const res = h.post({ action: 'unarchiveTasks', sessionToken: 'm-top', taskIds: ['50'] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(ids(h, 'Tasks')).toContain('50')
    expect(ids(h, 'TasksArchive')).toEqual(['52'])
  })

  it('バックアップから戻す: 移したタスクは移した内容と比べ、戻すと Tasks に戻す(二重にならない)', () => {
    const h = setup()
    const backupSheet = new FakeSheet('Tasks', h.sheets.Tasks.rows.map((r) => r.slice()))
    archive(h)
    const orig = h.c.SpreadsheetApp as { getActiveSpreadsheet: () => unknown }
    h.c.SpreadsheetApp = noop({ flush() {}, getActiveSpreadsheet: () => orig.getActiveSpreadsheet(), openById: () => noop({ getSheetByName: () => noop(backupSheet) }) })
    h.c.backupById_ = () => ({ id: 'b1', name: 'バックアップ', at: NOW })
    h.c.purgeExpiredPersonalData_ = () => ({})
    const found = (h.c.searchBackupTasks_ as (b: string, q: string) => { tasks: { id: string; state: string; archived?: boolean }[] })('b1', '去年の企画書')
    expect(found.tasks).toEqual([expect.objectContaining({ id: '50', state: 'same', archived: true })])
    const done = (h.c.restoreTasks_ as (b: string, ids: string[], a: string, n: number) => { restored: { id: string; state: string }[] })('b1', ['50'], 'm-top', NOW)
    expect(done.restored).toEqual([expect.objectContaining({ id: '50', state: 'unarchived' })])
    expect(ids(h, 'Tasks').filter((x) => x === '50')).toHaveLength(1)
    expect(ids(h, 'TasksArchive')).toEqual(['52'])
  })
})
