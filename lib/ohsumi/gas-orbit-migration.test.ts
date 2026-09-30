// Orbit からの移行のための関数(gas/Code.gs。docs/orbit-migration-plan.md の 4.2 の N1〜N3)を確かめる:
//   N1 migrationReport: 移行の前(日本語)と後(内部コード)で同じ数になる・見つからない参照・ファイル・前回との違い
//   N2 renameOrbitCalendarEvents: dryRun では変えない・apply で「[Orbit] 」だけを変える・戻す向き
//   N3 listChangesFromOrbit: 移行しただけなら差分が無い・Ohsumi で変えた行だけを日本語で出す・メールアドレスを出さない
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Table = { headers: string[]; rows: unknown[][] }

class FakeSheet {
  constructor(public rows: unknown[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
    }
  }
}

// Orbit のシート(日本語の値・役職名)
function orbitTables(): Record<string, Table> {
  const t = (headers: string[], rows: Record<string, unknown>[]): Table => ({ headers, rows: rows.map((o) => headers.map((h) => o[h] ?? '')) })
  return {
    Members: t(['id', 'name', 'role', 'inactive', 'permission_overrides_json', 'avatar_url', 'reports_to_id', 'last_login'], [
      { id: 'm1', name: '代表さん', role: '代表', avatar_url: 'https://lh3.googleusercontent.com/d/FILE_OK_000001=w256' },
      { id: 'm2', name: '班長さん', role: '班長', permission_overrides_json: '[{"targetType":"task","targetId":"t1","access":"view"}]', reports_to_id: 'm1' },
      { id: 'm3', name: '一般さん', role: '一般', reports_to_id: 'm9' }, // 見つからない報告先
      { id: 'm4', name: '休止さん', role: '一般', inactive: 'TRUE' },
    ]),
    MemberEmails: t(['id', 'email'], [{ id: 'm1', email: 'daihyo@example.org' }, { id: 'm2', email: 'hancho@example.org' }, { id: 'm3', email: 'ippan@example.org' }]),
    Projects: t(['id', 'name', 'archived', 'owner_id'], [{ id: 'p1', name: 'プロジェクト', owner_id: 'm1' }, { id: 'p2', name: '終わった', archived: 'TRUE' }]),
    Tasks: t(['id', 'title', 'status', 'priority', 'visibility', 'department', 'assignee_id', 'depends_on_ids', 'project_id'], [
      { id: 't1', title: '企画書', status: '進行中', priority: '高', visibility: '幹部', department: '広報', assignee_id: 'm2', project_id: 'p1' },
      { id: 't2', title: '会場', status: '完了', priority: '中', visibility: '全員', department: '未分類', assignee_id: 'm2,m3', depends_on_ids: 't1', project_id: 'p1' },
      { id: 't3', title: '古い', status: '確認待ち', priority: '低', visibility: '', department: '運営', assignee_id: 'm8', project_id: 'p1' }, // 見つからない担当者
    ]),
    Settings: t(['key', 'value'], [{ key: 'role_levels', value: '班長,代表' }, { key: 'org_name', value: 'FSIF' }, { key: 'org_logo_url', value: 'https://drive.google.com/uc?id=FILE_NG_000002' }]),
    Expenses: t(['id', 'applicant_id', 'status', 'receipt_url', 'approval_steps_json'], [
      { id: 'e1', applicant_id: 'm3', status: 'approved', receipt_url: 'https://drive.google.com/file/d/FILE_OK_000003/view', approval_steps_json: '[{"id":"s1","type":"role","role":"班長"}]' },
    ]),
    FormSubmissions: t(['id', 'status'], []),
    DailyReports: t(['id'], [{ id: 'd1' }]),
    Candidates: t(['id', 'status'], [{ id: 'c1', status: 'interview' }]),
  }
}

function setup(opts: { active?: Record<string, Table>; orbit?: Record<string, Table>; props?: Record<string, string>; events?: { title: string; start: Date }[] } = {}) {
  const props: Record<string, string> = { ...(opts.props ?? {}) }
  const logs: string[] = []
  const toSs = (tables: Record<string, Table>) => ({
    getName: () => 'スプレッドシート',
    getSheetByName: (n: string) => (tables[n] ? new FakeSheet([tables[n].headers, ...tables[n].rows]) : null),
  })
  const events = (opts.events ?? []).map((e) => ({ ...e, getTitle() { return this.title }, getStartTime() { return this.start }, setTitle(t: string) { this.title = t } }))
  const searched: unknown[] = []
  const ctx = vm.createContext({
    console: { log: (m: string) => logs.push(String(m)), warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => toSs(opts.active ?? orbitTables()),
      openById: (id: string) => { expect(id).toBe('ORBIT_ID'); return toSs(opts.orbit ?? orbitTables()) },
    },
    DriveApp: { getFileById: (id: string) => ({ id }) },
    CalendarApp: { getDefaultCalendar: () => ({ getEvents: (s: Date, e: Date, o: unknown) => { searched.push([s, e, o]); return events } }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: (d: Date) => d.toISOString().slice(0, 10) },
  })
  vm.runInContext(CODE_GS, ctx)
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown>
  // 役職・部門・アップロード先は、テストのシートから決める(本物はスナップショットのキャッシュから読む)
  const c = ctx as unknown as Record<string, unknown>
  c.getRoles_ = () => {
    const active = opts.active ?? orbitTables()
    const st = active.Settings
    const settings = Object.fromEntries(st.rows.map((r) => [String(r[0]), String(r[1])]))
    return gas.parseRolesSetting_(settings.roles) ?? gas.rolesFromLegacy_(settings)
  }
  c.getDepartments_ = () => gas.departmentsFromSettings_({})
  c.allowedUploadFolderIds_ = () => ['FOLDER']
  c.isInAllowedFolder_ = (file: { id: string }) => file.id.startsWith('FILE_OK')
  return { gas, props, logs, events, searched }
}

// 移行した後のシート(migrateToInternalCodes と同じ変換。役職の ID は新しく作る)
function migrated(): Record<string, Table> {
  const { gas } = setup()
  return JSON.parse(JSON.stringify(gas.convertOrbitTables_(orbitTables(), [], null)))
}

describe('N1 migrationReport(移行の前と後の数)', () => {
  it('日本語のままのシートと、内部コードに移した後のシートで、同じ数になる', () => {
    const before = setup({ active: orbitTables() }).gas.migrationReport() as { counts: Record<string, number> }
    const after = setup({ active: migrated() }).gas.migrationReport() as { counts: Record<string, number> }
    // 移行で増える Settings のキー(roles)だけが違う
    const diff = Object.keys({ ...before.counts, ...after.counts }).filter((k) => before.counts[k] !== after.counts[k])
    expect(diff).toEqual(['Settings.キー'])
    expect(after.counts['Settings.キー']).toBe(before.counts['Settings.キー'] + 1)
  })

  it('行数・有効と休止中・役職ごと・コードにそろえたステータスや部門・見つからない参照・ファイルを数える', () => {
    const { counts } = setup().gas.migrationReport() as { counts: Record<string, number> }
    expect(counts).toMatchObject({
      'Members.行': 4, 'Members.有効': 3, 'Members.休止中': 1, 'MemberEmails.行': 3, 'Members.メールアドレスが無い': 1,
      'Members.役職.代表': 1, 'Members.役職.班長': 1, 'Members.役職.一般': 2, 'Members.最上位の役職の有効なメンバー': 1,
      'Members.権限の例外がある人': 1, 'Members.権限の例外の件数': 1,
      'Projects.行': 2, 'Projects.アーカイブ済み': 1,
      'Tasks.行': 3, 'Tasks.status.progress': 1, 'Tasks.status.done': 1, 'Tasks.status.review': 1,
      'Tasks.visibility.leaders': 1, 'Tasks.visibility.all': 2, 'Tasks.department.pr': 1, 'Tasks.department.ops': 1, 'Tasks.department.(未分類)': 1,
      'Expenses.行': 1, 'Expenses.status.approved': 1, 'DailyReports.行': 1, 'Candidates.status.interview': 1,
      '見つからない参照.Tasks.assignee_id': 1, '見つからない参照.Members.reports_to_id': 1, '見つからない参照.Tasks.depends_on_ids': 0,
      'ファイル.プロフィール画像': 1, 'ファイル.領収書': 1, 'ファイル.団体ロゴ': 1, 'ファイル.開けない': 1,
    })
  })

  it('結果を覚え、次に実行した時に前回と違う数を出す。メールアドレスは実行ログに出さない', () => {
    const first = setup()
    first.gas.migrationReport()
    expect(first.logs.join('\n')).toContain('前回の結果はありません')
    const changed = orbitTables()
    changed.Tasks.rows[0][2] = '完了'
    const second = setup({ active: changed, props: { MIGRATION_REPORT_LAST: first.props.MIGRATION_REPORT_LAST } })
    second.gas.migrationReport()
    const log = second.logs.join('\n')
    expect(log).toContain('と違う数: 2件')
    expect(log).toContain('Tasks.status.done: 1 → 2')
    expect(log).toContain('Tasks.status.progress: 1 → 0')
    expect(first.logs.join('\n') + log).not.toMatch(/@example\.org/)
  })
})

describe('N2 renameOrbitCalendarEvents(カレンダーの予定の名前)', () => {
  const events = () => [
    { title: '[Orbit] 企画書', start: new Date('2026-10-10T00:00:00Z') },
    { title: '[Orbit] 会場', start: new Date('2026-10-12T00:00:00Z') },
    { title: '個人の予定 [Orbit]', start: new Date('2026-10-12T00:00:00Z') },
    { title: '[Ohsumi] 既にある', start: new Date('2026-10-13T00:00:00Z') },
  ]

  it('dryRun(既定)では、件数と例を出すだけで名前を変えない', () => {
    const t = setup({ events: events() })
    expect(t.gas.renameOrbitCalendarEvents()).toEqual({ count: 2, renamed: 0 })
    expect(t.events.map((e) => e.title)).toEqual(events().map((e) => e.title))
    expect(t.logs.join('\n')).toContain('[Orbit] 企画書 → [Ohsumi] 企画書')
    // 今日から2年先まで
    const [start, end] = t.searched[0] as [Date, Date]
    expect(Math.round((end.getTime() - start.getTime()) / 86400000)).toBe(730)
  })

  it('apply で「[Orbit] 」で始まる予定だけを「[Ohsumi] 」に変え、dryRun に戻す', () => {
    const t = setup({ events: events(), props: { CALENDAR_RENAME_MODE: 'apply' } })
    expect(t.gas.renameOrbitCalendarEvents()).toEqual({ count: 2, renamed: 2 })
    expect(t.events.map((e) => e.title)).toEqual(['[Ohsumi] 企画書', '[Ohsumi] 会場', '個人の予定 [Orbit]', '[Ohsumi] 既にある'])
    expect(t.props.CALENDAR_RENAME_MODE).toBe('dryRun')
  })

  it('戻す時(CALENDAR_RENAME_DIRECTION=toOrbit)は逆向きに変える', () => {
    const t = setup({ events: events(), props: { CALENDAR_RENAME_MODE: 'apply', CALENDAR_RENAME_DIRECTION: 'toOrbit' } })
    t.gas.renameOrbitCalendarEvents()
    expect(t.events.map((e) => e.title)).toEqual(['[Orbit] 企画書', '[Orbit] 会場', '個人の予定 [Orbit]', '[Orbit] 既にある'])
  })
})

describe('N3 listChangesFromOrbit(元の Orbit と比べて変わった行)', () => {
  type Diff = Record<string, { added: Record<string, string>[]; deleted: Record<string, string>[]; changed: { id: string; columns: { name: string }[] }[] }>
  const total = (d: Diff) => Object.values(d).reduce((n, s) => n + s.added.length + s.deleted.length + s.changed.length, 0)

  it('ORBIT_SPREADSHEET_ID が無ければ、設定のしかたを知らせる', () => {
    expect(() => setup().gas.listChangesFromOrbit()).toThrow(/ORBIT_SPREADSHEET_ID/)
  })

  it('移行しただけ(役職の ID が新しく作られていても)なら、変わった行は無い', () => {
    const t = setup({ active: migrated(), props: { ORBIT_SPREADSHEET_ID: 'ORBIT_ID' } })
    const diff = t.gas.listChangesFromOrbit() as Diff
    expect(total(diff)).toBe(0)
    expect(t.logs.join('\n')).toContain('変わった行はありません')
  })

  it('Ohsumi で変えた・足した・消した行だけを、日本語の値で出す(自動で変わる列・移行の日時は出さない)', () => {
    const now = migrated()
    const col = (table: Table, name: string) => table.headers.indexOf(name)
    now.Tasks.rows[0][col(now.Tasks, 'status')] = 'done' // 進行中 → 完了
    now.Tasks.rows.push(now.Tasks.headers.map((h) => ({ id: 't9', title: '新しいタスク', status: 'todo', priority: 'high' } as Record<string, string>)[h] ?? ''))
    now.Projects.rows.splice(1, 1) // p2 を消した
    now.Members.rows[1][col(now.Members, 'last_login')] = '2026-10-20T09:00:00Z' // 自動で変わる列
    now.MemberEmails.rows[2][1] = 'new-address@example.org'
    now.Settings.rows.push(['migrated_at', '2026-10-19T00:00:00Z'])
    const t = setup({ active: now, props: { ORBIT_SPREADSHEET_ID: 'ORBIT_ID' } })
    const diff = t.gas.listChangesFromOrbit() as Diff
    expect(diff.Tasks.changed.map((c) => [c.id, c.columns.map((x) => x.name)])).toEqual([['t1', ['status']]])
    expect(diff.Tasks.added.map((r) => r.id)).toEqual(['t9'])
    expect(diff.Projects.deleted.map((r) => r.id)).toEqual(['p2'])
    expect(diff.Members.changed).toEqual([])
    expect(diff.Settings.added).toEqual([])
    expect(diff.MemberEmails.changed.map((c) => c.id)).toEqual(['m3'])
    expect(total(diff)).toBe(4)
    const log = t.logs.join('\n')
    expect(log).toContain('変更 id t1「企画書」: status 「進行中」→「完了」')
    expect(log).toContain('追加 id t9「新しいタスク」')
    expect(log).toContain('status=未着手')
    expect(log).toContain('priority=高')
    expect(log).toContain('削除 id p2「終わった」')
    expect(log).toContain('メールアドレス。実行ログには出しません')
    expect(log).not.toMatch(/@example\.org/)
  })

  it('役職を変えたメンバーは、役職名で出す', () => {
    const now = migrated()
    const roles = JSON.parse(String(now.Settings.rows.find((r) => r[0] === 'roles')![1])) as { id: string; name: string }[]
    const col = now.Members.headers.indexOf('role')
    now.Members.rows[2][col] = roles.find((r) => r.name === '班長')!.id // 一般 → 班長
    const t = setup({ active: now, props: { ORBIT_SPREADSHEET_ID: 'ORBIT_ID' } })
    t.gas.listChangesFromOrbit()
    expect(t.logs.join('\n')).toContain('変更 id m3「一般さん」: role 「一般」→「班長」')
  })
})
