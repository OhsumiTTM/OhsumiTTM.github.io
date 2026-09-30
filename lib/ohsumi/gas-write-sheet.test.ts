// gas/Code.gs: 書き込みのシートの呼び出しを減らすこと。
//   - 行への書き込み(updateRowFields)は、シートを1回の呼び出しで読み、同じ実行の中の2回目からは読み直さない。
//     隣り合う列は1回の setValues にまとめ、離れた列は間のセルを書き換えない
//   - 通知の準備(日程の変更の通知)は、タスクの行を読み直さず、メンバー・メールアドレス・設定を
//     スナップショットとキャッシュから引く(シートを読まない)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Cell = string | number
const ROLES = JSON.stringify([
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'r-lead', name: '班長', tier: 'admin' },
  { id: 'top', name: '代表', tier: 'top' },
])

class FakeSheet {
  constructor(public name: string, public rows: Cell[][], private calls: string[]) {}
  getName() { return this.name }
  getLastRow() { this.calls.push(`${this.name}.getLastRow`); return this.rows.length }
  getLastColumn() { this.calls.push(`${this.name}.getLastColumn`); return this.rows[0]?.length ?? 0 }
  getDataRange() { return this.range(1, 1, this.rows.length, this.rows[0]?.length ?? 0) }
  getRange(row: number, col: number, numRows = 1, numCols = 1) { return this.range(row, col, numRows, numCols) }
  deleteRow(r: number) { this.calls.push(`${this.name}.deleteRow`); this.rows.splice(r - 1, 1) }
  appendRow(row: Cell[]) { this.calls.push(`${this.name}.appendRow`); this.rows.push(row) }
  private range(row: number, col: number, numRows: number, numCols: number) {
    return {
      getValues: () => {
        this.calls.push(`${this.name}.read`)
        return Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? ''))
      },
      getDisplayValues: () => {
        this.calls.push(`${this.name}.read`)
        return Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => String(this.rows[row - 1 + r]?.[col - 1 + c] ?? '')))
      },
      setValue: (v: Cell) => {
        this.calls.push(`${this.name}.write(${row},${col})`)
        this.rows[row - 1][col - 1] = v
      },
      setValues: (vs: Cell[][]) => {
        this.calls.push(`${this.name}.write(${row},${col}x${vs[0].length})`)
        vs.forEach((line, r) => line.forEach((v, c) => { this.rows[row - 1 + r][col - 1 + c] = v }))
      },
    }
  }
}

function setup() {
  const calls: string[] = []
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1', MEMBER_EMAILS_VERSION: 'e1' }
  const sheets: Record<string, FakeSheet> = {}
  const add = (name: string, rows: Cell[][]) => { sheets[name] = new FakeSheet(name, rows, calls) }
  add('Tasks', [
    ['id', 'title', 'assignee_id', 'creator_id', 'project_id', 'start_date', 'due_date', 'status', 'history_json', 'last_activity'],
    ['t1', 'タスク1', 'm-base', 'm-lead', 'p1', '', '', 'todo', '[]', ''],
    ['t2', 'タスク2', 'm-base', 'm-lead', 'p1', '', '', 'todo', '[]', ''],
  ])
  add('Members', [
    ['id', 'name', 'role', 'project_ids', 'permission_overrides_json', 'reports_to_id', 'notify_new_task', 'locale'],
    ['m-top', '代表', 'top', '', '[]', '', 'TRUE', 'ja'],
    ['m-lead', '班長', 'r-lead', '', '[]', '', '', 'en'],
    ['m-base', '一般', 'base', '', '[]', 'm-lead', '', 'ja'],
  ])
  add('Settings', [['key', 'value'], ['roles', ROLES], ['org_notification_emails', 'org@example.com']])
  add('Projects', [['id', 'name', 'member_ids'], ['p1', 'P', 'm-base']])
  add('MemberEmails', [['id', 'email'], ['m-top', 'top@example.com'], ['m-lead', 'lead@example.com'], ['m-base', 'base@example.com']])
  const mails: { to: string; subject: string }[] = []
  const blob = (d: Buffer | string) => {
    const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
    return { getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') }
  }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({
      get: (k: string) => cache.get(k) ?? null,
      getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      put: (k: string, v: string) => { cache.set(k, v) },
      putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, v) },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: {
      flush() { calls.push('flush') },
      getActiveSpreadsheet: () => ({
        getSheetByName: (n: string) => { calls.push(`getSheetByName(${n})`); return sheets[n] ?? null },
        getSheets: () => Object.values(sheets),
      }),
    },
    MailApp: { sendEmail: (m: { to: string; subject: string }) => { mails.push(m) } },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      formatDate: () => '2026-10-01',
      newBlob: (d: Buffer | string) => blob(d),
      gzip: (b: unknown) => b,
      ungzip: (b: unknown) => b,
      base64Encode: (bytes: Buffer) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s: string) => Buffer.from(s, 'base64'),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.authenticateRequest = (body: { sessionToken?: string }) => ({ memberId: body.sessionToken, renewed: null })
  // スナップショットの作り直し(Sheets API)は、シートを1回で読んだことにする
  c.readSheetTablesViaApi = (names: string[]) => {
    calls.push('api:snapshot')
    const tables: Record<string, { headers: string[]; rows: string[][] }> = {}
    for (const n of names) {
      const rows = sheets[n]?.rows ?? []
      tables[n] = { headers: (rows[0] ?? []).map(String), rows: rows.slice(1).map((r) => r.map(String)) }
    }
    return { tables }
  }
  c.isTestEnvironment = () => false
  c.syncCalendarForTask = () => {}
  const gas = ctx as unknown as { doPost: (e: object) => { text: string } } & Record<string, (...a: unknown[]) => unknown>
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  // 読み取り(ログイン後の状態): スナップショットとメールアドレスのキャッシュができる
  const warm = () => {
    post({ action: 'getBackgroundData', sessionToken: 'm-top' })
    calls.length = 0
  }
  const sheetCalls = (name: string) => calls.filter((x) => x.startsWith(name + '.') || x === `getSheetByName(${name})`)
  return { gas, c, post, sheets, calls, mails, warm, sheetCalls }
}

describe('行への書き込み', () => {
  it('同じ実行の中で同じシートに2回書いても、シートは1回しか読まない', () => {
    const t = setup()
    t.warm()
    const history = [{ id: 'h1', at: '2026-10-01', byId: 'm-lead', field: 'deadline', from: '', to: '2026-10-10' }]
    const res = t.post({ action: 'batch', sessionToken: 'm-lead', ops: [
      { action: 'updateHistory', taskId: 't1', history },
      { action: 'updateSchedule', taskId: 't1', startDate: '2026-10-01', deadline: '2026-10-10' },
    ] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const tasks = t.sheetCalls('Tasks')
    expect(tasks.filter((x) => x === 'Tasks.read')).toHaveLength(1)
    // 開始日と期限は隣り合う列なので1回の setValues。記録は別の列
    expect(tasks.filter((x) => x.startsWith('Tasks.write'))).toEqual(['Tasks.write(2,6x2)', 'Tasks.write(2,9x1)'])
    expect(t.sheets.Tasks.rows[1].slice(5, 7)).toEqual(['2026-10-01', '2026-10-10'])
    // 1回ずつ getLastRow・getLastColumn を呼んでいた読み方はしない
    expect(tasks.filter((x) => x.endsWith('getLastRow') || x.endsWith('getLastColumn'))).toEqual([])
  })

  it('離れた列は、間のセルを書き換えないよう別々に書く', () => {
    const t = setup()
    t.sheets.Tasks.rows[1][3] = '=A1' // 間の列(creator_id)に数式が入っていても消さない
    ;(t.gas.updateRowFields as (s: string, id: string, f: object) => unknown)('Tasks', 't1', { title: '新', project_id: 'p2' })
    expect(t.calls.filter((x) => x.startsWith('Tasks.write'))).toEqual(['Tasks.write(2,2x1)', 'Tasks.write(2,5x1)'])
    expect(t.sheets.Tasks.rows[1][3]).toBe('=A1')
    expect(t.gas.contiguousColumnRuns([{ col: 7, value: 'b' }, { col: 6, value: 'a' }, { col: 9, value: 'c' }, { col: 6, value: 'a2' }]))
      .toEqual([[{ col: 6, value: 'a2' }, { col: 7, value: 'b' }], [{ col: 9, value: 'c' }]])
  })

  it('行を削除した後は読み直す(行番号がずれるため)。追加した行は、見つからない時に読み直して見つける', () => {
    const t = setup()
    const update = t.gas.updateRowFields as (s: string, id: string, f: object) => unknown
    update('Tasks', 't2', { title: 'A' })
    // 行の削除(removeTask と同じく deleteRow の後に忘れる)
    ;(t.gas.removeTask as (id: string) => unknown)('t1')
    update('Tasks', 't2', { title: 'B' })
    expect(t.sheets.Tasks.rows.find((r) => r[0] === 't2')![1]).toBe('B')
    expect(t.sheets.Tasks.rows.find((r) => r[0] === 't1')).toBeUndefined()
    t.sheets.Tasks.rows.push(['t3', 'タスク3', '', '', 'p1', '', '', 'todo', '[]', ''])
    update('Tasks', 't3', { title: 'C' })
    expect(t.sheets.Tasks.rows.find((r) => r[0] === 't3')![1]).toBe('C')
    expect(() => update('Tasks', 'nope', { title: 'X' })).toThrow(/row not found/)
  })

  it('シートに無い列だけの時は、これまでどおりエラーにする', () => {
    const t = setup()
    expect(() => (t.gas.updateRowFields as (s: string, id: string, f: object) => unknown)('Tasks', 't1', { no_such_column: 1 })).toThrow(/列が見つかりません/)
  })
})

describe('日程の変更の通知', () => {
  it('タスクの行を読み直さず、宛先(上長・団体の通知先)と言語をスナップショットとキャッシュから引く', () => {
    const t = setup()
    t.warm()
    const res = t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    // 担当者(m-base)の上長(m-lead)と、団体の通知先に送る。m-lead は英語
    expect(t.mails.map((m) => [m.to, m.subject]).sort()).toEqual([
      ['lead@example.com', '[Ohsumi] Task schedule changed'],
      ['org@example.com', '[Ohsumi] タスクの日程が変更されました'],
    ])
    // シートを読んだのは、書き込みの前の Tasks の1回だけ(メンバー・メールアドレス・設定は読まない)
    const reads = t.calls.filter((x) => x.endsWith('.read'))
    expect(reads).toEqual(['Tasks.read'])
    expect(t.calls.filter((x) => x === 'api:snapshot')).toEqual([])
    expect(res.timing).toMatchObject({ actionMs: expect.any(Number), recipientsMs: expect.any(Number) })
  })

  it('キャッシュが無い時(ログインの直後でない時)も、同じ宛先に送る', () => {
    const t = setup()
    t.calls.length = 0
    const res = t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(t.mails.map((m) => m.to).sort()).toEqual(['lead@example.com', 'org@example.com'])
  })

  it('通知の本文には、書いたばかりの日程が入る', () => {
    const t = setup()
    t.warm()
    const bodies: string[] = []
    t.c.sendMail = (m: { body: string }) => { bodies.push(m.body) }
    t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '2026-10-01', deadline: '2026-10-10' })
    expect(bodies.length).toBeGreaterThan(0)
    for (const b of bodies) expect(b).toMatch(/2026-10-01[\s\S]*2026-10-10/)
  })
})
