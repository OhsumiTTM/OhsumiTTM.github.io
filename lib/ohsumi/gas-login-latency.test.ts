// gas/Code.gs: ログインを待たせないための仕組みを確かめる
//   - 最終ログイン日時: 1時間以内は書かない・シートには書かずに書き込み待ちに入れる・トリガーでまとめて書く
//   - 裏での読み込み: 経費・フォームの回答・候補者はデータの版ごとにキャッシュし、閲覧の絞り込みは毎回行う。
//     メールはメールアドレス表の版ごとにキャッシュする
//   - getFiles: ファイルの種類と画像をキャッシュし、2回目は Drive を開かない。内訳の時間を返す
//   - ログインの応答に、キャッシュにある画像(団体ロゴ・プロフィール画像)を入れる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Cell = string | number | Date

class FakeSheet {
  reads = 0
  writes = 0
  constructor(public rows: Cell[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () => {
        if (row > 1) this.reads++
        return Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? ''))
      },
      setValues: (values: Cell[][]) => {
        this.writes++
        values.forEach((vr, r) => vr.forEach((v, c) => { this.rows[row - 1 + r][col - 1 + c] = v }))
      },
      setValue: (v: Cell) => {
        this.writes++
        this.rows[row - 1][col - 1] = v
      },
    }
  }
}

const ROLES = JSON.stringify([
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'top', name: '代表', tier: 'top' },
])

function setup() {
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1', MEMBER_EMAILS_VERSION: 'e1', UPLOAD_FOLDER_ID: 'folder-ok' }
  const sheets: Record<string, FakeSheet> = {
    Members: new FakeSheet([
      ['id', 'name', 'role', 'avatar_url', 'last_login'],
      ['m1', '代表', 'top', 'https://lh3.googleusercontent.com/d/AVATAR_M1_xxxxx=w256', ''],
      ['m2', '一般', 'base', 'https://lh3.googleusercontent.com/d/AVATAR_M2_xxxxx=w256', ''],
    ]),
    Expenses: new FakeSheet([
      ['id', 'applicant_id', 'amount', 'receipt_url', 'created_at', 'status'],
      ['x1', 'm1', 100, '', '2026-09-01', 'pending'],
      ['x2', 'm2', 200, 'https://drive.google.com/file/d/RECEIPT_X2_xxxxx/view', '2026-09-02', 'pending'],
    ]),
    MemberEmails: new FakeSheet([['id', 'email'], ['m1', 'boss@example.com'], ['m2', 'a@example.com, b@example.com']]),
  }
  // Drive: ファイルID → { 名前, 親フォルダ, 中身 }
  const driveFiles: Record<string, { name: string; parent: string; data: string }> = {
    AVATAR_M1_xxxxx: { name: 'avatar_m1.png', parent: 'folder-ok', data: 'm1-image' },
    AVATAR_M2_xxxxx: { name: 'avatar_m2.png', parent: 'folder-ok', data: 'm2-image' },
    RECEIPT_X2_xxxxx: { name: 'expense_receipt_x2.png', parent: 'folder-ok', data: 'receipt' },
    OUTSIDE_xxxxxxx: { name: 'avatar_x.png', parent: 'somewhere-else', data: 'secret' },
  }
  const driveCalls: string[] = []
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
      deleteProperty: (k: string) => { delete props[k] },
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
      flush() {},
      getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null }),
    },
    DriveApp: {
      getFileById: (id: string) => {
        driveCalls.push(id)
        const f = driveFiles[id]
        if (!f) throw new Error('not found')
        let parentsLeft = [f.parent]
        return {
          getName: () => f.name,
          getParents: () => ({ hasNext: () => parentsLeft.length > 0, next: () => ({ getId: () => parentsLeft.shift() }) }),
          getSize: () => f.data.length,
          getBlob: () => ({ getContentType: () => 'image/png', getBytes: () => Buffer.from(f.data) }),
        }
      },
    },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      formatDate: () => '2026-10-01',
      newBlob: (d: Buffer | string) => {
        const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
        return { getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') }
      },
      gzip: (b: unknown) => b,
      ungzip: (b: unknown) => b,
      base64Encode: (bytes: Buffer) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s: string) => Buffer.from(s, 'base64'),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.authenticateRequest = (body: { sessionToken: string }) => ({ memberId: body.sessionToken, renewed: null })
  c.readRoleSettings = () => ({ roles: ROLES })
  c.bumpDataVersion = () => { props.DATA_VERSION = 'v' + (Number(props.DATA_VERSION.slice(1)) + 1) }
  // スナップショット(Members・Settings)
  c.readSheetTables = () => ({
    Members: { headers: sheets.Members.rows[0].map(String), rows: sheets.Members.rows.slice(1).map((r) => r.map(String)) },
    Settings: { headers: ['key', 'value'], rows: [['roles', ROLES], ['org_logo_url', 'https://lh3.googleusercontent.com/d/AVATAR_M2_xxxxx=w64']] },
  })
  const gas = ctx as unknown as Record<string, (...args: unknown[]) => unknown>
  const post = (body: object) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: JSON.stringify(body) } }).text)
  return { gas, c, post, props, cache, sheets, driveCalls }
}

describe('最終ログイン日時', () => {
  it('シートには書かず、書き込み待ち(スクリプトプロパティ)に入れる。1時間以内の2回目は何もしない', () => {
    const t = setup()
    const now = Date.parse('2026-10-01T09:00:00Z')
    expect(t.gas.recordLastLogin('m2', now)).toBe(true)
    expect(t.sheets.Members.writes).toBe(0)
    expect(t.props.LAST_LOGIN_PENDING_m2).toBe('2026-10-01T09:00:00.000Z')
    delete t.props.LAST_LOGIN_PENDING_m2
    expect(t.gas.recordLastLogin('m2', now + 30 * 60 * 1000)).toBe(true)
    expect(t.props.LAST_LOGIN_PENDING_m2).toBeUndefined()
  })

  it('このリクエストで読んだスナップショットの last_login が1時間以内なら、書き込み待ちにも入れない', () => {
    const t = setup()
    t.sheets.Members.rows[2][4] = '2026-10-01T08:30:00.000Z'
    t.gas.startRequestTiming()
    t.gas.loadSnapshot()
    expect(t.gas.recordLastLogin('m2', Date.parse('2026-10-01T09:00:00Z'))).toBe(true)
    expect(t.props.LAST_LOGIN_PENDING_m2).toBeUndefined()
  })

  it('ログインの応答: 最終ログイン日時の記録はシートを読み書きしない(内訳に queued / recent)', () => {
    const t = setup()
    t.c.verifyGoogleIdToken = (x: string) => ({ email: x })
    t.c.findMemberIdByEmailCached = (x: string) => x
    t.c.issueSessionToken = () => ({ token: 's', exp: 1 })
    const first = t.post({ action: 'exchangeIdToken', idToken: 'm2', nonceSecret: 'n', withBackground: true })
    expect(first.result.lastLoginRecorded).toBe(true)
    expect(first.timing.lastLogin).toBe('queued')
    expect(t.sheets.Members.writes).toBe(0)
    const second = t.post({ action: 'exchangeIdToken', idToken: 'm2', nonceSecret: 'n', withBackground: true })
    expect(second.timing.lastLogin).toBe('recent')
  })

  it('書き込み待ちは、トリガーでまとめて1回で書き、書いたものを消す(書いている間の新しい日時は残す)', () => {
    const t = setup()
    t.props.LAST_LOGIN_PENDING_m1 = '2026-10-01T09:00:00.000Z'
    t.props.LAST_LOGIN_PENDING_m2 = '2026-10-01T09:05:00.000Z'
    t.props.LAST_LOGIN_PENDING_gone = '2026-10-01T09:06:00.000Z' // 行の無いメンバー
    expect(t.gas.flushPendingLastLogins()).toBe(2)
    expect(t.sheets.Members.writes).toBe(1)
    expect(t.sheets.Members.rows[1][4]).toBe('2026-10-01T09:00:00.000Z')
    expect(t.sheets.Members.rows[2][4]).toBe('2026-10-01T09:05:00.000Z')
    expect(Object.keys(t.props).filter((k) => k.startsWith('LAST_LOGIN_PENDING_'))).toEqual([])
    expect(t.gas.flushPendingLastLogins()).toBe(0)
    // 毎時・毎日のトリガーから呼ぶ
    expect(CODE_GS).toMatch(/function sendBatchNotifications\(\) \{\n\s+\/\/.*\n\s+try \{ flushPendingLastLogins\(\) \}/)
    expect(CODE_GS).toMatch(/try \{ flushPendingLastLogins\(\) \} catch \(err\) \{ \}\n\s+try \{ notifyInactiveMembers\(\) \}/)
  })
})

describe('裏での読み込みのキャッシュ', () => {
  it('経費はデータの版ごとにキャッシュし、閲覧の絞り込みは毎回メンバーごとに行う。版が変われば読み直す', () => {
    const t = setup()
    const a = t.post({ action: 'getBackgroundData', sessionToken: 'm2' })
    expect(a.result.expenses.map((e: { id: string }) => e.id)).toEqual(['x2']) // 一般は自分の申請だけ
    expect(a.timing.expensesCache).toBe('miss')
    const reads = t.sheets.Expenses.reads
    const b = t.post({ action: 'getBackgroundData', sessionToken: 'm1' })
    expect(b.result.expenses.map((e: { id: string }) => e.id)).toEqual(['x2', 'x1']) // 代表は全部(新しい順)
    expect(b.timing.expensesCache).toBe('hit')
    expect(t.sheets.Expenses.reads).toBe(reads)
    ;(t.c.bumpDataVersion as () => void)()
    const c = t.post({ action: 'getBackgroundData', sessionToken: 'm1' })
    expect(c.timing.expensesCache).toBe('miss')
  })

  it('自分のメールは、メールアドレス表の版ごとにキャッシュする', () => {
    const t = setup()
    const a = t.post({ action: 'getBackgroundData', sessionToken: 'm2' })
    expect(a.result.myEmail).toBe('a@example.com, b@example.com')
    expect(a.timing.myEmailCache).toBe('miss')
    const reads = t.sheets.MemberEmails.reads
    const b = t.post({ action: 'getBackgroundData', sessionToken: 'm1' })
    expect(b.result.myEmail).toBe('boss@example.com')
    expect(b.timing.myEmailCache).toBe('hit')
    expect(t.sheets.MemberEmails.reads).toBe(reads)
    t.props.MEMBER_EMAILS_VERSION = 'e2'
    expect(t.post({ action: 'getBackgroundData', sessionToken: 'm1' }).timing.myEmailCache).toBe('miss')
  })
})

describe('getFiles', () => {
  it('2回目は、ファイルの種類と画像をキャッシュから返し、Drive を開かない。内訳の時間を返す', () => {
    const t = setup()
    const first = t.post({ action: 'getFiles', sessionToken: 'm2', fileIds: ['AVATAR_M1_xxxxx'] })
    expect(first.result[0]).toMatchObject({ ok: true, mimeType: 'image/png' })
    expect(t.driveCalls).toEqual(['AVATAR_M1_xxxxx'])
    for (const k of ['folderPropsMs', 'driveMs', 'fileCacheMs', 'blobMs', 'otherMs']) expect(typeof first.timing[k], k).toBe('number')
    const second = t.post({ action: 'getFiles', sessionToken: 'm2', fileIds: ['AVATAR_M1_xxxxx'] })
    expect(second.result[0].data).toBe(first.result[0].data)
    expect(t.driveCalls).toHaveLength(1)
    expect(second.timing.fileCacheHits).toBe(1)
    expect(second.timing.driveMs).toBeUndefined()
  })

  it('アップロード用フォルダの外のファイルは返さず、種類も覚えない', () => {
    const t = setup()
    expect(t.post({ action: 'getFiles', sessionToken: 'm1', fileIds: ['OUTSIDE_xxxxxxx'] }).result[0]).toMatchObject({ ok: false, error: 'notFound' })
    expect(t.post({ action: 'getFiles', sessionToken: 'm1', fileIds: ['OUTSIDE_xxxxxxx'] }).result[0]).toMatchObject({ ok: false, error: 'notFound' })
    expect(t.driveCalls).toEqual(['OUTSIDE_xxxxxxx', 'OUTSIDE_xxxxxxx'])
  })

  it('領収書は、キャッシュした経費で権限を毎回確かめ、中身はキャッシュしない', () => {
    const t = setup()
    t.sheets.Members.rows.push(['m3', '別の一般', 'base', '', ''])
    expect(t.post({ action: 'getFiles', sessionToken: 'm2', fileIds: ['RECEIPT_X2_xxxxx'] }).result[0]).toMatchObject({ ok: true })
    expect(t.post({ action: 'getFiles', sessionToken: 'm3', fileIds: ['RECEIPT_X2_xxxxx'] }).result[0]).toMatchObject({ ok: false, error: 'forbidden' })
    expect([...t.cache.keys()].some((k) => k === 'file:RECEIPT_X2_xxxxx')).toBe(false)
  })
})

describe('ログインの応答に入れる画像', () => {
  it('団体ロゴ → 本人 → ほかのメンバーの順に、キャッシュにある画像だけ入れる(Drive は開かない)', () => {
    const t = setup()
    const snap = { Members: { headers: ['id', 'avatar_url'], rows: [['m1', 'https://lh3.googleusercontent.com/d/AVATAR_M1_xxxxx=w1'], ['m2', 'https://lh3.googleusercontent.com/d/AVATAR_M2_xxxxx=w1']] }, Settings: { headers: ['key', 'value'], rows: [['org_logo_url', 'https://drive.google.com/open?id=LOGO_xxxxxxxxxx']] } }
    expect(t.gas.initialImageFileIds(snap, 'm2')).toEqual(['LOGO_xxxxxxxxxx', 'AVATAR_M2_xxxxx', 'AVATAR_M1_xxxxx'])

    const cold = t.post({ action: 'getBackgroundData', sessionToken: 'm2' })
    expect(cold.result.files).toEqual([])
    expect(t.driveCalls).toEqual([])
    // 画面が getFiles で取った後(キャッシュに入った後)は、ログインの応答に入る
    t.post({ action: 'getFiles', sessionToken: 'm2', fileIds: ['AVATAR_M2_xxxxx'] })
    const calls = t.driveCalls.length
    const warm = t.post({ action: 'getBackgroundData', sessionToken: 'm2' })
    expect(warm.result.files.map((f: { id: string }) => f.id)).toEqual(['AVATAR_M2_xxxxx'])
    expect(t.driveCalls).toHaveLength(calls)
    expect(typeof warm.timing.filesMs).toBe('number')
  })
})
