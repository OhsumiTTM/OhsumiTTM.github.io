// gas/Code.gs の読み取りの絞り込み(READ_POLICY / buildViewerData)を、
// Apps Script を使わずに Node の vm で読み込んでテストする。
// 役職ごとに「見えるべきもの」「見えてはいけないもの」を確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const CODE_GS = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')

type Table = { headers: string[]; rows: string[][] }
type ViewerData = { Members: Table; Projects: Table; Tasks: Table; Settings: Table }

// Code.gs はトップレベルで関数と var の定義しか行わないため、そのまま評価できる
function loadGas(): Record<string, (...args: unknown[]) => unknown> & { READ_POLICY: Record<string, unknown> } {
  const context = vm.createContext({ console })
  vm.runInContext(CODE_GS, context)
  return context as never
}

const gas = loadGas()

function table(headers: string[], objects: Record<string, string>[]): Table {
  return { headers, rows: objects.map((o) => headers.map((h) => o[h] ?? '')) }
}

const MEMBER_HEADERS = [
  'id', 'name', 'role', 'avatar_url', 'reports_to_id', 'skill_levels_json',
  'evaluation_history_json', 'one_on_ones_json', 'survey_responses_json', 'last_login',
  'notify_settings', 'locale', 'permission_overrides_json', 'last_inactive_notified',
  'email', // 旧シートに残っている列 — 規則が無いので誰にも返らないこと
]
const members = table(MEMBER_HEADERS, [
  { id: 'boss', name: '代表さん', role: '代表', evaluation_history_json: '[{"e":"boss"}]', notify_settings: '{"n":"boss"}', last_inactive_notified: '2026-01-01', email: 'boss@example.com' },
  { id: 'lead', name: '班長さん', role: '班長', evaluation_history_json: '[{"e":"lead"}]', permission_overrides_json: '[{"p":"lead"}]' },
  { id: 'exec', name: '事業責任者さん', role: '事業責任者', evaluation_history_json: '[{"e":"exec"}]' },
  { id: 'a', name: '一般A', role: '一般', reports_to_id: 'lead', evaluation_history_json: '[{"e":"a"}]', one_on_ones_json: '[{"o":"a"}]', survey_responses_json: '[{"s":"a"}]', last_login: '2026-09-01', notify_settings: '{"n":"a"}', locale: 'ja', permission_overrides_json: '[{"p":"a"}]', skill_levels_json: '[{"skill":"x","level":2}]' },
  { id: 'b', name: '一般B', role: '一般', evaluation_history_json: '[{"e":"b"}]', notify_settings: '{"n":"b"}', permission_overrides_json: '[{"p":"b"}]' },
])

const TASK_HEADERS = ['id', 'title', 'visibility', 'approval_status', 'creator_id', 'assignee_id', 'comments_json']
const tasks = table(TASK_HEADERS, [
  { id: 't-open', title: '通常', visibility: 'all', comments_json: '[{"c":1}]' },
  { id: 't-exec', title: '幹部限定', visibility: '幹部' },
  { id: 't-pend-a', title: 'Aが作成した承認待ち', approval_status: '承認待ち', creator_id: 'a' },
  { id: 't-pend-b', title: 'Bが担当の承認待ち', approval_status: '承認待ち', creator_id: 'lead', assignee_id: 'x, b' },
  { id: 't-pend-lead', title: '班長の承認待ち', approval_status: '承認待ち', creator_id: 'lead' },
])

const projects = table(['id', 'name', 'health_override'], [{ id: 'p1', name: 'P1', health_override: 'watch' }])

const QUIZ = JSON.stringify([
  { id: 'q1', title: '検定', questions: [{ id: 'x', text: '?', choices: ['a', 'b'], correctIndex: 1 }] },
])
const settings = table(['key', 'value'], [
  { key: 'org_name', value: 'テスト団体' },
  { key: 'restricted_roles', value: '班長' },
  { key: 'org_notification_emails', value: 'org@example.com' },
  { key: 'survey_invited_ids', value: 'a,lead' },
  { key: 'quiz_definitions', value: QUIZ },
  { key: 'unknown_internal_key', value: 'secret' },
])

const snapshot = { Members: members, Projects: projects, Tasks: tasks, Settings: settings }

function viewAs(memberId: string): ViewerData {
  return gas.buildViewerData(JSON.parse(JSON.stringify(snapshot)), memberId) as ViewerData
}

function cell(t: Table, rowId: string, column: string): string | undefined {
  const idCol = t.headers.indexOf('id')
  const col = t.headers.indexOf(column)
  const row = t.rows.find((r) => r[idCol] === rowId)
  if (!row || col < 0) return undefined
  return row[col]
}

function taskIds(d: ViewerData): string[] {
  const idCol = d.Tasks.headers.indexOf('id')
  return d.Tasks.rows.map((r) => r[idCol]).sort()
}

function setting(d: ViewerData, key: string): string | undefined {
  return d.Settings.rows.find((r) => r[0] === key)?.[1]
}

describe('getInitialData の絞り込み: タスク', () => {
  it('代表・全権管理者・制限付きの役職は、幹部限定と全員分の承認待ちが見える', () => {
    for (const id of ['boss', 'exec', 'lead']) {
      expect(taskIds(viewAs(id))).toEqual(['t-exec', 't-open', 't-pend-a', 't-pend-b', 't-pend-lead'])
    }
  })

  it('一般は幹部限定が見えず、承認待ちは自分が作成者か担当者のものだけ見える', () => {
    expect(taskIds(viewAs('a'))).toEqual(['t-open', 't-pend-a'])
    expect(taskIds(viewAs('b'))).toEqual(['t-open', 't-pend-b'])
  })

  it('行が見える人には全列を返す', () => {
    expect(cell(viewAs('b').Tasks, 't-open', 'comments_json')).toBe('[{"c":1}]')
  })
})

describe('getInitialData の絞り込み: メンバー', () => {
  it('全員の行を返し、全員に見せる列は誰にでも返す', () => {
    const d = viewAs('b')
    expect(d.Members.rows).toHaveLength(5)
    expect(cell(d.Members, 'a', 'name')).toBe('一般A')
    expect(cell(d.Members, 'a', 'reports_to_id')).toBe('lead')
    expect(cell(d.Members, 'a', 'skill_levels_json')).toBe('[{"skill":"x","level":2}]')
  })

  it('キャリア・評価などは本人と一般以外の役職だけに返す', () => {
    expect(cell(viewAs('b').Members, 'a', 'evaluation_history_json')).toBe('')
    expect(cell(viewAs('b').Members, 'a', 'one_on_ones_json')).toBe('')
    expect(cell(viewAs('b').Members, 'a', 'survey_responses_json')).toBe('')
    expect(cell(viewAs('b').Members, 'a', 'last_login')).toBe('')
    expect(cell(viewAs('a').Members, 'a', 'evaluation_history_json')).toBe('[{"e":"a"}]')
    expect(cell(viewAs('lead').Members, 'a', 'evaluation_history_json')).toBe('[{"e":"a"}]')
    expect(cell(viewAs('lead').Members, 'a', 'survey_responses_json')).toBe('[{"s":"a"}]')
    expect(cell(viewAs('boss').Members, 'a', 'one_on_ones_json')).toBe('[{"o":"a"}]')
  })

  it('通知設定・表示言語は本人だけに返す(管理者にも返さない)', () => {
    expect(cell(viewAs('a').Members, 'a', 'notify_settings')).toBe('{"n":"a"}')
    expect(cell(viewAs('a').Members, 'b', 'notify_settings')).toBe('')
    expect(cell(viewAs('boss').Members, 'a', 'notify_settings')).toBe('')
    expect(cell(viewAs('boss').Members, 'a', 'locale')).toBe('')
  })

  it('権限の例外設定は本人と全権管理者だけに返す(制限付きの役職には返さない)', () => {
    expect(cell(viewAs('a').Members, 'a', 'permission_overrides_json')).toBe('[{"p":"a"}]')
    expect(cell(viewAs('exec').Members, 'a', 'permission_overrides_json')).toBe('[{"p":"a"}]')
    expect(cell(viewAs('lead').Members, 'a', 'permission_overrides_json')).toBe('')
    expect(cell(viewAs('lead').Members, 'lead', 'permission_overrides_json')).toBe('[{"p":"lead"}]')
    expect(cell(viewAs('b').Members, 'a', 'permission_overrides_json')).toBe('')
  })

  it('規則のない列(旧シートの email など)や画面で使わない列は誰にも返さない', () => {
    for (const id of ['boss', 'a']) {
      const d = viewAs(id)
      expect(d.Members.headers).not.toContain('email')
      expect(d.Members.headers).not.toContain('last_inactive_notified')
    }
  })
})

describe('getInitialData の絞り込み: 設定', () => {
  it('団体の通知先メールは全権管理者だけに返す', () => {
    expect(setting(viewAs('boss'), 'org_notification_emails')).toBe('org@example.com')
    expect(setting(viewAs('exec'), 'org_notification_emails')).toBe('org@example.com')
    expect(setting(viewAs('lead'), 'org_notification_emails')).toBeUndefined()
    expect(setting(viewAs('a'), 'org_notification_emails')).toBeUndefined()
  })

  it('検定の正解番号は全権管理者だけに返す', () => {
    const correct = (d: ViewerData) => JSON.parse(setting(d, 'quiz_definitions')!)[0].questions[0].correctIndex
    expect(correct(viewAs('boss'))).toBe(1)
    expect(correct(viewAs('exec'))).toBe(1)
    expect(correct(viewAs('lead'))).toBeUndefined()
    expect(correct(viewAs('a'))).toBeUndefined()
    expect(JSON.parse(setting(viewAs('a'), 'quiz_definitions')!)[0].questions[0].choices).toEqual(['a', 'b'])
  })

  it('アンケートの回答対象者一覧は、一般には自分が対象かどうかだけを返す', () => {
    expect(setting(viewAs('lead'), 'survey_invited_ids')).toBe('a,lead')
    expect(setting(viewAs('a'), 'survey_invited_ids')).toBe('a')
    const forB = setting(viewAs('b'), 'survey_invited_ids')!
    expect(forB.split(',')).not.toContain('b')
    expect(forB).not.toContain('a')
    expect(forB).not.toBe('')
  })

  it('規則のないキーは誰にも返さない', () => {
    expect(setting(viewAs('boss'), 'unknown_internal_key')).toBeUndefined()
    expect(setting(viewAs('a'), 'org_name')).toBe('テスト団体')
  })

  it('登録されていないメンバーには何も返さない', () => {
    expect(gas.buildViewerData(JSON.parse(JSON.stringify(snapshot)), 'nobody')).toBeNull()
  })
})

// ---- 網羅性: 新しい列・キーを追加したら READ_POLICY への登録が必要 ----------

function headerArray(name: string): string[] {
  const match = CODE_GS.match(new RegExp(`var ${name} = (\\[[\\s\\S]*?\\n  \\])`))
  if (!match) throw new Error(`${name} not found in Code.gs`)
  return new Function(`return ${match[1]}`)() as string[]
}

function columnsReadByMapper(source: string, fnName: string): string[] {
  const start = source.indexOf(`function ${fnName}(`)
  const end = source.indexOf('\n}\n', start)
  const body = source.slice(start, end)
  return Array.from(new Set(Array.from(body.matchAll(/\br\.([a-z_]+)/g), (m) => m[1])))
}

describe('READ_POLICY の網羅性', () => {
  const policy = gas.READ_POLICY as unknown as Record<string, { columns?: Record<string, unknown>; keys?: Record<string, unknown> }>
  const remote = readFileSync(join(ROOT, 'lib', 'ohsumi', 'remote.ts'), 'utf8')

  it.each([
    ['Members', 'MEMBERS_HEADERS', 'mapMemberRow'],
    ['Projects', 'PROJECTS_HEADERS', 'mapProjectRow'],
    ['Tasks', 'TASKS_HEADERS', 'mapTaskRow'],
  ])('%s: シートの列とフロントが読む列はすべて規則を持つ', (sheet, headersVar, mapper) => {
    const columns = policy[sheet].columns!
    const missing = [...headerArray(headersVar), ...columnsReadByMapper(remote, mapper)].filter(
      (c) => !(c in columns),
    )
    expect(missing).toEqual([])
  })

  it('Settings: フロントが読むキーはすべて規則を持つ', () => {
    const keys = Array.from(remote.matchAll(/byKey\.get\('([a-z_]+)'\)/g), (m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !(k in policy.Settings.keys!))).toEqual([])
  })
})

describe('getExpenses の絞り込み(canViewExpense)', () => {
  const app = {
    id: 'e1',
    applicantId: 'a',
    approvalSteps: [
      { id: 's1', type: 'member', memberId: 'lead' },
      { id: 's2', type: 'role', role: '会計' },
    ],
  }
  const viewer = (over: Record<string, unknown>) => ({
    id: 'x', role: '一般', isFullAdmin: false, canOpenExpensesSection: false, ...over,
  })
  const can = (v: Record<string, unknown>) => gas.canViewExpense(viewer(v), app) as boolean

  it('申請者本人と承認ステップの担当者は見える', () => {
    expect(can({ id: 'a' })).toBe(true)
    expect(can({ id: 'lead', role: '班長' })).toBe(true)
    expect(can({ id: 'k', role: '会計' })).toBe(true)
  })

  it('全権管理者と、経費セクションを許可された役職は見える', () => {
    expect(can({ id: 'boss', role: '代表', isFullAdmin: true })).toBe(true)
    expect(can({ id: 'm', role: '班長', canOpenExpensesSection: true })).toBe(true)
  })

  it('それ以外の人は見えない', () => {
    expect(can({ id: 'b' })).toBe(false)
    expect(can({ id: 'l2', role: '班長' })).toBe(false)
  })
})
