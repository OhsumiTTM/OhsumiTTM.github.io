// レジストリ(registry/Code.gs)の R1-a: シートの用意・死活の確認・回数の上限・操作の記録・
// 記録の無い直接の編集の検出・毎日のバックアップを、メモリ上のスプレッドシートと Drive で確かめる
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE = readFileSync(join(__dirname, '..', '..', 'registry', 'Code.gs'), 'utf8')

class FakeSheet {
  rows: unknown[][] = []
  protections: object[] = []
  constructor(public name: string) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return Math.max(0, ...this.rows.map((r) => r.length)) }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
      setValues: (vals: unknown[][]) => vals.forEach((vs, r) => {
        const target = (this.rows[row - 1 + r] ??= [])
        vs.forEach((v, c) => { target[col - 1 + c] = v })
      }),
    }
  }
  appendRow(values: unknown[]) { this.rows.push(values) }
  setFrozenRows() {}
  getProtections() { return this.protections }
  protect() {
    const p = { description: '', removed: [] as string[], setDescription(d: string) { this.description = d; return this }, getEditors: () => ['someone@example.com'], removeEditor(u: string) { this.removed.push(u) } }
    this.protections.push(p)
    return p
  }
}

type DriveFile = { name: string; created: number; trashed: boolean; removedEditors: string[]; removedViewers: string[]; sharing: unknown[] }

function setup(opts: { props?: Record<string, string>; now?: number } = {}) {
  const props: Record<string, string> = { ...(opts.props ?? {}) }
  const sheets = new Map<string, FakeSheet>()
  const cache = new Map<string, string>()
  const triggers: { handler: string; hour?: number }[] = []
  const files: DriveFile[] = []
  const logs: string[] = []
  const newFile = (name: string, created = Date.now()): DriveFile => ({ name, created, trashed: false, removedEditors: [], removedViewers: [], sharing: [] })
  const driveHandle = (f: DriveFile) => ({
    getName: () => f.name,
    getId: () => 'folder-1',
    getDateCreated: () => new Date(f.created),
    setTrashed: (v: boolean) => { f.trashed = v },
    getEditors: () => ['editor@example.com'],
    getViewers: () => ['viewer@example.com'],
    removeEditor: (u: string) => f.removedEditors.push(u),
    removeViewer: (u: string) => f.removedViewers.push(u),
    setSharing: (...a: unknown[]) => f.sharing.push(a),
  })
  const folder = newFile('folder')
  const folderHandle = {
    ...driveHandle(folder),
    getFiles: () => {
      const list = files.filter((f) => !f.trashed)
      let i = 0
      return { hasNext: () => i < list.length, next: () => driveHandle(list[i++]) }
    },
  }
  const ctx = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v) } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_a: string, text: string) => Array.from(createHash('sha256').update(String(text)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (bytes: number[]) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64url'),
      getUuid: () => Math.random().toString(36),
      formatDate: () => '2026-10-01',
    },
    SpreadsheetApp: {
      ProtectionType: { SHEET: 'SHEET' },
      getActiveSpreadsheet: () => ({
        getId: () => 'ss1',
        getSheetByName: (n: string) => sheets.get(n) ?? null,
        insertSheet: (n: string) => { const s = new FakeSheet(n); sheets.set(n, s); return s },
      }),
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      Permission: { NONE: 'NONE' },
      createFolder: () => folderHandle,
      getFolderById: () => folderHandle,
      getFileById: () => ({ makeCopy: (name: string) => { const f = newFile(name); files.push(f); return driveHandle(f) } }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, t })),
      deleteTrigger: (h: { t: object }) => { triggers.splice(triggers.indexOf(h.t as never), 1) },
      newTrigger: (handler: string) => {
        const t: { handler: string; hour?: number } = { handler }
        const b = { timeBased: () => b, everyDays: () => b, atHour: (h: number) => { t.hour = h; return b }, create: () => { triggers.push(t) } }
        return b
      },
    },
  })
  vm.runInContext(CODE, ctx)
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown> & Record<string, unknown>
  const post = (body: unknown) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text)
  return { gas, props, sheets, cache, triggers, files, logs, post, newFile }
}

const EXPECTED_SHEETS = ['Orgs', 'Contacts', 'Attributes', 'Usage', 'RegistrationCodes', 'Secrets', 'AuditLog', 'Admins']

describe('シートの用意(setupRegistry)', () => {
  it('すべてのシートを見出し付きで作り、Secrets と AuditLog を保護し、鍵とバックアップのトリガーを作る', () => {
    const t = setup()
    t.gas.setupRegistry()
    expect([...t.sheets.keys()]).toEqual(EXPECTED_SHEETS)
    expect(t.sheets.get('Orgs')!.rows[0]).toEqual(['org_id', 'gas_url', 'status', 'channel', 'display_name', 'created_at', 'suspend_at', 'suspend_reason', 'last_check_at', 'gas_version'])
    expect(t.sheets.get('Secrets')!.protections).toHaveLength(1)
    expect(t.sheets.get('AuditLog')!.protections).toHaveLength(1)
    expect(t.sheets.get('Orgs')!.protections).toHaveLength(0)
    expect(t.props.HEALTH_KEY).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(t.props.BACKUP_FOLDER_ID).toBe('folder-1')
    expect(t.triggers).toEqual([{ handler: 'dailyRegistryBackup', hour: 3 }])
  })

  it('何度実行しても同じ結果(鍵は変えない・トリガーは1つ・保護は1つ)。足りない列だけを足す', () => {
    const t = setup()
    t.gas.setupRegistry()
    const key = t.props.HEALTH_KEY
    t.sheets.get('Contacts')!.rows[0] = ['org_id', 'name']
    t.gas.setupRegistry()
    expect(t.props.HEALTH_KEY).toBe(key)
    expect(t.triggers).toHaveLength(1)
    expect(t.sheets.get('Secrets')!.protections).toHaveLength(1)
    expect(t.sheets.get('Contacts')!.rows[0]).toEqual(['org_id', 'name', 'email', 'phone'])
  })

  it('団体のデータ(メンバー・タスク)を置くシートは無い', () => {
    const t = setup()
    t.gas.setupRegistry()
    const all = [...t.sheets.values()].flatMap((s) => s.rows[0] as string[])
    for (const col of ['member_id', 'members', 'tasks', 'task_id']) expect(all).not.toContain(col)
  })
})

describe('死活の確認(health)', () => {
  it('鍵が無い・違う時は、動いていることだけを返す', () => {
    const t = setup()
    t.gas.setupRegistry()
    for (const key of [undefined, 'wrong']) {
      const res = t.post({ action: 'health', key })
      expect(Object.keys(res).sort()).toEqual(['ok', 'time', 'version'])
      expect(res.ok).toBe(true)
    }
  })

  it('鍵が合えば、最後のバックアップ・記録の無い変更・断った回数を返す。団体の情報は返さない', () => {
    const t = setup()
    t.gas.setupRegistry()
    t.sheets.get('Orgs')!.appendRow(['org_secret_id', 'https://script.google.com/macros/s/x/exec', 'active'])
    t.gas.dailyRegistryBackup()
    const res = t.post({ action: 'health', key: t.props.HEALTH_KEY })
    expect(res).toMatchObject({ ok: true, unrecordedEdits: 1, rejectedLastHour: 0 })
    expect(res.lastBackupAt).toMatch(/^\d{4}-/)
    expect(JSON.stringify(res)).not.toContain('org_secret_id')
    expect(JSON.stringify(res)).not.toContain('script.google.com')
  })
})

describe('GET で届いた時(doGet)', () => {
  it('HTML ではなく、GET で届いたことが分かる JSON を返す(何も処理していない)', () => {
    const t = setup()
    const res = JSON.parse((t.gas.doGet as () => { text: string })().text)
    expect(res).toMatchObject({ ok: false, getReceived: true })
  })
})

describe('リクエストの受け付け', () => {
  it('大きすぎる本文・JSON でない本文・知らない操作は断る', () => {
    const t = setup()
    t.gas.setupRegistry()
    expect(t.post('x'.repeat(50001)).error).toMatch(/大きすぎ/)
    expect(t.post('{').error).toMatch(/形が正しくありません/)
    expect(t.post({ action: 'listOrgs' }).error).toMatch(/知らない操作/)
  })

  it('1分あたりの上限を超えたら、シートを読まずにすぐ断り、断った回数を数える', () => {
    const t = setup()
    t.gas.setupRegistry()
    const limit = (t.gas.RATE_LIMITS as unknown as { health: number }).health
    for (let i = 0; i < limit; i++) expect(t.post({ action: 'health' }).ok).toBe(true)
    const over = t.post({ action: 'health' })
    expect(over).toMatchObject({ ok: false, retryLater: true })
    expect(t.gas.rejectedCount(Date.now())).toBe(1)
  })

  it('レジストリ全体の上限', () => {
    const t = setup()
    const all = (t.gas.RATE_LIMITS as unknown as { all: number }).all
    const now = Date.parse('2026-10-01T00:00:10Z')
    for (let i = 0; i < all; i++) expect(t.gas.rateLimitExceeded('all', all, now)).toBe(false)
    expect(t.gas.rateLimitExceeded('all', all, now)).toBe(true)
    // 次の1分は数え直す
    expect(t.gas.rateLimitExceeded('all', all, now + 60000)).toBe(false)
  })
})

describe('操作の記録と、記録の無い直接の編集', () => {
  it('AuditLog に追記する。数式として扱われる文字列は、文字列のまま書く', () => {
    const t = setup()
    t.gas.setupRegistry()
    t.gas.appendAudit({ actor: 'a@example.com', action: 'setStatus', target: 'org_1', before: { status: 'active' }, after: { status: 'suspended' }, reason: '=HYPERLINK("x")' })
    const [headers, row] = t.sheets.get('AuditLog')!.rows as string[][]
    const rec = Object.fromEntries(headers.map((h, i) => [h, row[i]]))
    expect(rec).toMatchObject({ actor: 'a@example.com', action: 'setStatus', target: 'org_1', before: '{"status":"active"}', after: '{"status":"suspended"}', reason: '\'=HYPERLINK("x")' })
    expect(rec.at).toMatch(/^\d{4}-/)
    for (const v of ['+1', '-1', '@x']) expect(t.gas.safeCell(v)).toBe(`'${v}`)
    expect(t.gas.safeCell('ok')).toBe('ok')
  })

  it('記録を伴う変更の後に覚えた指紋と違う行・覚えていない行・消えた行を見つける', () => {
    const t = setup()
    t.gas.setupRegistry()
    const orgs = t.sheets.get('Orgs')!
    const row = (id: string, status: string) => [id, 'https://script.google.com/macros/s/' + id + '/exec', status, 'standard']
    orgs.appendRow(row('org_a', 'active'))
    orgs.appendRow(row('org_b', 'active'))
    const values = (r: unknown[]) => Object.fromEntries((orgs.rows[0] as string[]).map((h, i) => [h, r[i] ?? '']))
    t.gas.rememberOrgFingerprint('org_a', values(orgs.rows[1]))
    t.gas.rememberOrgFingerprint('org_b', values(orgs.rows[2]))
    expect(t.gas.findUnrecordedOrgEdits()).toEqual([])
    // 最後の確認の時刻・表示名は、記録なしで変わってよい
    ;(orgs.rows[1] as unknown[])[4] = '表示名'
    expect(t.gas.findUnrecordedOrgEdits()).toEqual([])
    // 状態を直接書き換えた・覚えていない行を足した・行を消した
    ;(orgs.rows[1] as unknown[])[2] = 'suspended'
    orgs.appendRow(row('org_c', 'active'))
    orgs.rows.splice(2, 1)
    expect([...(t.gas.findUnrecordedOrgEdits() as string[])].sort()).toEqual(['org_a', 'org_b', 'org_c'])
  })
})

describe('毎日のバックアップ', () => {
  it('コピーを誰とも共有しない形にし、30日より古いコピーをゴミ箱へ移し、時刻と記録の無い変更の数を残す', () => {
    const t = setup()
    t.gas.setupRegistry()
    const day = 24 * 3600 * 1000
    const old = t.newFile('古いコピー', Date.now() - 31 * day)
    const recent = t.newFile('新しいコピー', Date.now() - 29 * day)
    t.files.push(old, recent)
    const res = t.gas.dailyRegistryBackup() as { removed: number }
    expect(res.removed).toBe(1)
    expect(old.trashed).toBe(true)
    expect(recent.trashed).toBe(false)
    const copy = t.files.at(-1)!
    expect(copy.name).toBe('Ohsumi レジストリ バックアップ 2026-10-01')
    expect(copy.removedEditors).toEqual(['editor@example.com'])
    expect(copy.removedViewers).toEqual(['viewer@example.com'])
    expect(copy.sharing).toEqual([['PRIVATE', 'NONE']])
    expect(t.props.LAST_BACKUP_AT).toMatch(/^\d{4}-/)
    expect(t.props.LAST_UNRECORDED_EDITS).toBe('0')
  })
})
