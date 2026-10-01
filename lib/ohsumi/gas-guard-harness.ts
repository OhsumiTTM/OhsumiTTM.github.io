// 団体の GAS(gas/Code.gs)を、偽のスプレッドシートの上で実際に動かすテスト用の道具。
// 操作ごとに「通知(メール・Discord/Slack・通知のキュー)に何を送ったか」「タスクのシートを書き換えたか」を
// 調べられる(lib/ohsumi/gas-notify-guard.test.ts)。code を差し替えれば、守る処理を外した Code.gs でも動かせる
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

export const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

export type Cell = string | number | boolean
const ROLES = JSON.stringify([
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'r-lead', name: '班長', tier: 'admin' },
  { id: 'top', name: '代表', tier: 'top' },
])

// 偽のシート。Code.gs が使う呼び出しだけを実装し、知らない呼び出しは何もしない関数にする
export class FakeSheet {
  constructor(public name: string, public rows: Cell[][]) {}
  getName() { return this.name }
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getMaxColumns() { return this.rows[0]?.length ?? 0 }
  getMaxRows() { return this.rows.length }
  getDataRange() { return this.getRange(1, 1, Math.max(this.rows.length, 1), Math.max(this.rows[0]?.length ?? 0, 1)) }
  appendRow(row: Cell[]) { this.rows.push(row.slice()) }
  clearContents() { this.rows = [] }
  deleteRow(r: number) { this.rows.splice(r - 1, 1) }
  deleteRows(r: number, n: number) { this.rows.splice(r - 1, n) }
  getRange(a: number | string, col = 1, numRows = 1, numCols = 1) {
    const row = typeof a === 'number' ? a : 1
    const get = () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? ''))
    const set = (vs: Cell[][]) => vs.forEach((line, r) => line.forEach((v, c) => {
      while (this.rows.length < row + r) this.rows.push(new Array(this.getLastColumn()).fill(''))
      this.rows[row - 1 + r][col - 1 + c] = v
    }))
    return noop({
      getValues: get,
      getNumberFormats: () => get().map((l) => l.map(() => '@')),
      getDisplayValues: () => get().map((l) => l.map(String)),
      getValue: () => get()[0][0],
      setValue: (v: Cell) => set([[v]]),
      setValues: set,
    })
  }
}

// 知らない呼び出しには、何もしない関数(自分を返す)を返す
export function noop<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k]
      if (k === 'then') return undefined
      const f = () => noop({})
      return f
    },
  })
}

export interface Sent { kind: 'mail' | 'chat' | 'queue' | 'digest'; to: string; text: string }

// realCalendar: カレンダーの予定を作る処理を動かし、作った予定を events に記録する
export function guardHarness(opts: { code?: string; props?: Record<string, string>; realCalendar?: boolean } = {}) {
  const code = opts.code ?? CODE_GS
  const cache = new Map<string, string>()
  const props: Record<string, string> = {
    DATA_VERSION: 'v1', MEMBER_EMAILS_VERSION: 'e1', ORG_ID: 'org_GUARDGUARDGUARDGU01',
    SESSION_SIGNING_KEY: 'k'.repeat(43), SESSION_KEY_ID: 'kid1', GOOGLE_OAUTH_CLIENT_ID: 'client',
    ...(opts.props ?? {}),
  }
  const sheets: Record<string, FakeSheet> = {}
  const add = (name: string, rows: Cell[][]) => { sheets[name] = new FakeSheet(name, rows) }
  const trainings = JSON.stringify([
    { id: 'tr-pending', name: '保存した研修の名前', date: '2026-10-10', status: 'pending' },
    { id: 'tr-ok', name: '承認した研修', date: '2026-09-10', status: 'approved' },
  ])
  add('Members', [
    ['id', 'name', 'display_name', 'role', 'project_ids', 'permission_overrides_json', 'reports_to_id', 'notify_settings', 'locale', 'inactive', 'training_history_json'],
    ['m-top', '代表', '', 'top', '', '[]', '', '', 'ja', '', '[]'],
    ['m-lead', '班長', '', 'r-lead', 'p1', '[]', '', '', 'ja', '', '[]'],
    ['m-base', '一般', '', 'base', 'p1', '[]', 'm-lead', '', 'ja', '', trainings],
    ['m-other', '他人', '', 'base', 'p1', '[]', '', '', 'ja', '', '[]'],
    ['m-victim', '被害者', '', 'base', '', '[]', '', '', 'ja', '', '[]'],
    ['m-off', '休止', '', 'base', '', '[]', '', '', 'ja', 'TRUE', '[]'],
  ])
  const taskHeaders = ['id', 'title', 'description', 'project_id', 'assignee_id', 'creator_id', 'reviewer_ids', 'status', 'visibility',
    'approval_status', 'priority', 'difficulty', 'start_date', 'due_date', 'depends_on_ids', 'comments_json', 'progress_note',
    'progress_percent', 'progress_history_json', 'history_json', 'deliverables_json', 'estimated_hours', 'actual_hours',
    'retrospective_json', 'schedule_json', 'form_json', 'open_bid_applicant_ids', 'hold_reason_note', 'hold_reason_since',
    'blocker', 'last_activity', 'related_review_task_id']
  const row = (o: Record<string, Cell>) => taskHeaders.map((h) => o[h] ?? '')
  const schedule = JSON.stringify({ candidates: [{ id: 'c1', label: '10/1' }], invitedIds: ['m-base'], responses: { 'm-base': { c1: 'ok' } } })
  const form = JSON.stringify({ fields: [{ id: 'f1', label: '参加' }], invitedIds: ['m-base'], responses: { 'm-base': { f1: 'はい' } } })
  add('Tasks', [
    taskHeaders,
    row({ id: 't1', title: 'タスク1', project_id: 'p1', assignee_id: 'm-base', creator_id: 'm-lead', status: 'todo', visibility: 'all',
      comments_json: JSON.stringify([{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }]),
      progress_history_json: JSON.stringify([{ id: 'pg-old', byId: 'm-lead', text: '班長の進捗', at: '2026-09-01' }]),
      history_json: '[]', schedule_json: schedule, form_json: form }),
    row({ id: 't-bid', title: '公募タスク', project_id: 'p1', creator_id: 'm-lead', status: 'todo', visibility: 'all', open_bid_applicant_ids: 'm-lead' }),
    row({ id: 't-exec', title: '幹部限定タスク', project_id: 'p1', assignee_id: 'm-lead', creator_id: 'm-top', status: 'todo', visibility: 'leaders' }),
  ])
  add('Projects', [['id', 'name', 'member_ids', 'last_notified_health'], ['p1', 'P', 'm-base,m-other', '']])
  add('Settings', [['key', 'value'], ['roles', ROLES], ['org_notification_emails', 'org@example.com'], ['org_name', 'テスト団体']])
  add('MemberEmails', [['id', 'email'], ['m-top', 'top@example.com'], ['m-lead', 'lead@example.com'], ['m-base', 'base@example.com'],
    ['m-other', 'other@example.com'], ['m-victim', 'victim@example.com'], ['m-off', 'off@example.com']])

  const sent: Sent[] = []
  const events: { title: string; options: Record<string, unknown> }[] = []
  const calendar = noop({
    getEvents: () => [],
    createEvent: (title: string, _s: Date, _e: Date, options: Record<string, unknown>) => { events.push({ title, options }) },
    createAllDayEvent: (title: string, _d: Date, options: Record<string, unknown>) => { events.push({ title, options }) },
  })
  const blob = (d: Buffer | string) => {
    const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
    return noop({ getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') })
  }
  const spreadsheet = noop({
    getSheetByName: (n: string) => (sheets[n] ? noop(sheets[n]) : null),
    getSheets: () => Object.values(sheets).map((s) => noop(s)),
    insertSheet: (n: string) => { add(n, []); return noop(sheets[n]) },
    getId: () => 'ss',
  })
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = String(v) },
      setProperties: (o: Record<string, string>) => { Object.assign(props, o) },
      deleteProperty: (k: string) => { delete props[k] },
      getKeys: () => Object.keys(props),
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({
      get: (k: string) => cache.get(k) ?? null,
      getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      put: (k: string, v: string) => { cache.set(k, v) },
      putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, v) },
      remove: (k: string) => { cache.delete(k) },
      removeAll: (ks: string[]) => { ks.forEach((k) => cache.delete(k)) },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: noop({ flush() {}, getActiveSpreadsheet: () => spreadsheet, openById: () => spreadsheet }),
    MailApp: { sendEmail: (m: { to: string; subject: string; body: string }) => { sent.push({ kind: 'mail', to: String(m.to), text: m.subject + '\n' + m.body }) }, getRemainingDailyQuota: () => 100 },
    LanguageApp: { translate: (s: string) => '[訳]' + s },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    DriveApp: noop({}),
    CalendarApp: noop({ getDefaultCalendar: () => calendar }),
    ScriptApp: noop({ getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/GUARD/exec' }) }),
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    Utilities: noop({
      formatDate: () => '2026-10-01',
      newBlob: (d: Buffer | string) => blob(d),
      gzip: (b: unknown) => b,
      ungzip: (b: unknown) => b,
      base64Encode: (bytes: Buffer) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s: string) => Buffer.from(s, 'base64'),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => Math.random().toString(36).slice(2),
      computeDigest: (_a: string, text: string) => Array.from(createHash('sha256').update(String(text)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (v: number[] | string) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff))).toString('base64url'),
      base64DecodeWebSafe: (s: string) => Array.from(Buffer.from(s, 'base64url')),
      computeHmacSha256Signature: (value: string, key: string) => Array.from(createHmac('sha256', key).update(value).digest()),
      sleep: () => {},
    }),
  })
  vm.runInContext(code, ctx)
  const c = ctx as unknown as Record<string, unknown>
  // 認証: sessionToken をそのままメンバーID として扱う(トークンの確かめ方は gas-session.test.ts で確かめる)
  c.authenticateRequest_ = (body: { sessionToken?: string }) => {
    if (!body.sessionToken) throw (c.userError_ as (m: string) => Error)('ログインしていません。')
    return { memberId: body.sessionToken, renewed: null }
  }
  // スナップショットの作り直し(Sheets API)は、偽のシートをそのまま読む
  c.readSheetTablesViaApi_ = (names: string[]) => {
    const tables: Record<string, { headers: string[]; rows: string[][] }> = {}
    for (const n of names) {
      const rows = sheets[n]?.rows ?? []
      tables[n] = { headers: (rows[0] ?? []).map(String), rows: rows.slice(1).map((r) => r.map(String)) }
    }
    return { tables }
  }
  c.isTestEnvironment_ = () => false
  if (!opts.realCalendar) c.syncCalendarForTask_ = () => {}
  c.sendDiscordMessage_ = (content: string) => { sent.push({ kind: 'chat', to: 'discord', text: String(content) }) }
  c.sendSlackMessage_ = () => {}
  const gas = ctx as unknown as { doPost: (e: object) => { text: string } }
  const post = (body: Record<string, unknown>) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  // 通知のキュー(まとめて送る設定の人)に入ったもの
  // 毎日のまとめ(急ぎでない通知)に入ったもの(to は宛先のアドレス)
  const queued = (): Sent[] => [
    ...Object.entries(props).filter(([k]) => k.startsWith('notif_queue_'))
      .flatMap(([k, v]) => (JSON.parse(v) as { templates: Record<string, { subject: string; body: string }> }[])
        .map((q) => ({ kind: 'queue' as const, to: k.slice('notif_queue_'.length), text: JSON.stringify(q.templates) }))),
    ...digested(),
  ]
  const digested = (): Sent[] => Object.entries(props).filter(([k]) => k.startsWith('notif_digest_'))
    .flatMap(([, v]) => {
      const d = JSON.parse(v) as { email: string; items: { s: string; b: string }[] }
      return d.items.map((i) => ({ kind: 'digest' as const, to: d.email, text: i.s + '\n' + i.b }))
    })
  const allSent = () => [...sent, ...queued()]
  const tasksJson = () => JSON.stringify(sheets.Tasks.rows)
  const savedText = () => JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([n, s]) => [n, s.rows])))
  const registeredEmails = () => {
    const out = new Set<string>(['org@example.com'])
    for (const r of sheets.MemberEmails.rows.slice(1)) String(r[1]).split(/[\s,;]+/).filter(Boolean).forEach((e) => out.add(e.toLowerCase()))
    return out
  }
  const addSheet = (name: string, rows: Cell[][]) => add(name, rows)
  return { c, post, sheets, props, cache, sent, events, allSent, digested, tasksJson, savedText, registeredEmails, addSheet }
}

// doPost が受け付ける操作: runWriteAction_ の case(新しく足した操作も、自動でここに入る)
export function writeActions(code = CODE_GS): string[] {
  const start = code.indexOf('function runWriteAction_(')
  const body = code.slice(start, code.indexOf('\nfunction ', start + 10))
  return [...new Set([...body.matchAll(/case '(\w+)':/g)].map((m) => m[1]))]
}

// 画面から来るかもしれない、意地の悪い値(項目ごとに別の目印を入れる。どの項目が通知に漏れたか分かるように)
export const MARK = 'MARK'
export function hostileBody(action: string, actor: string): Record<string, unknown> {
  const m = (f: string) => `${MARK}_${f}_`
  return {
    action, sessionToken: actor,
    taskId: 't1', projectId: 'p1', memberId: 'm-victim', memberIds: ['m-victim'], creatorId: 'm-victim',
    assigneeIds: ['m-victim'], reviewerIds: ['m-victim'], applicantIds: ['m-victim', 'm-lead'],
    to: 'x@evil.example', email: 'x@evil.example', emails: ['x@evil.example'], recipients: ['x@evil.example'], cc: 'x@evil.example',
    commentText: m('commentText'), text: m('text'), reason: m('reason'), taskName: m('taskName'), trainingName: m('trainingName'),
    subject: m('subject'), message: m('message'), note: m('note'), content: m('content'), description: m('description'),
    name: m('name'), title: m('title'), label: m('label'),
    comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-new', byId: 'm-victim', text: m('comment') + ' @被害者' }],
    progressHistory: [{ id: 'pg-new', byId: 'm-victim', text: m('progress'), at: '2026-10-01' }],
    history: [], deliverables: [], texts: [m('texts')], targetLang: 'en', status: 'doing', health: 'attention',
    trainingId: 'tr-pending', approved: true, progressPercent: 50,
  }
}

// 通知に漏れた目印の項目(本文の中の MARK_<項目>_)
export function leakedFields(text: string): string[] {
  return [...text.matchAll(new RegExp(`${MARK}_(\\w+?)_`, 'g'))].map((x) => x[1])
}
