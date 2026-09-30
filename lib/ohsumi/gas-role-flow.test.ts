// gas/Code.gs: 役職ごと(代表・全権管理者・制限付きの管理者・一般)に、ログイン → 裏での読み込み → 再読み込み →
// 情報更新が通ることを、本物の権限の判定(authorizeAction)で確かめる。
// 代表・管理者だけのテストでは、一般のメンバーだけが断られる不具合(getBackgroundData の登録漏れ)を見つけられなかった
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Table = { headers: string[]; rows: string[][] }

const ROLES = JSON.stringify([
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'r-lead', name: '班長', tier: 'admin', restricted: true, sections: ['expenses'] },
  { id: 'r-admin', name: '事業責任者', tier: 'admin' },
  { id: 'top', name: '代表', tier: 'top' },
])

// 役職ごとのテスト用アカウント(メンバーID = 役職の説明)
const ACCOUNTS = [
  { id: 'm-top', role: 'top', label: '代表(top)' },
  { id: 'm-admin', role: 'r-admin', label: '全権管理者(admin)' },
  { id: 'm-lead', role: 'r-lead', label: '制限付きの管理者(admin・restricted)' },
  { id: 'm-base', role: 'base', label: '一般(base)' },
]

function setup() {
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1' }
  const sheet: Record<string, Table> = {
    Members: {
      headers: ['id', 'name', 'role', 'project_ids', 'permission_overrides_json'],
      rows: ACCOUNTS.map((a) => [a.id, a.label, a.role, '', '[]']),
    },
    Settings: { headers: ['key', 'value'], rows: [['roles', ROLES]] },
  }
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
    SpreadsheetApp: { flush() {} },
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
  // 時計(内訳の時間を確かめるため、処理ごとに進める)
  const DateInCtx = vm.runInContext('Date', ctx) as { now: () => number }
  let now = Date.parse('2026-10-01T00:00:00Z')
  DateInCtx.now = () => now
  const advance = (ms: number) => { now += ms }

  // セッショントークン = メンバーID。IDトークンのメール = メンバーID
  c.authenticateRequest = (body: { sessionToken?: string }) => {
    if (!body.sessionToken) throw (c.userError as (m: string) => Error)('ログインしていません。再ログインしてください。')
    return { memberId: body.sessionToken, renewed: null }
  }
  c.verifyGoogleIdToken = (idToken: string) => ({ email: idToken })
  c.findMemberIdByEmailCached = (email: string) => email
  c.issueSessionToken = (id: string) => ({ token: 'session-' + id, exp: 1 })
  c.recordLastLogin = () => true
  const originalReadSheetTables = c.readSheetTables
  c.readSheetTables = () => JSON.parse(JSON.stringify(sheet))
  c.readRoleSettings = () => ({ roles: ROLES })
  c.getActingMemberById = (id: string) => {
    const row = sheet.Members.rows.find((r) => r[0] === id)
    if (!row) throw (c.userError as (m: string) => Error)('メンバー登録が見つかりません。')
    return { id, role: row[2], project_ids: [], permission_overrides: [] }
  }
  c.buildViewerData = (data: Record<string, Table>) => data
  c.getExpenses = () => [{ id: 'e1' }]
  c.getFormSubmissions = () => []
  c.getCandidates = () => []
  c.getMemberEmailValue = (id: string) => id + '@example.com'
  c.getMemberEmailValueCached = (id: string) => id + '@example.com'
  c.bumpDataVersion = () => {}
  const gas = ctx as unknown as { doPost: (e: object) => { text: string } }
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  return { c, post, advance, originalReadSheetTables }
}

describe.each(ACCOUNTS)('$label のアカウント', (account) => {
  it('ログイン → 裏での読み込み → 再読み込み → 情報更新が通り、ログイン画面に戻される応答(authError)が無い', () => {
    const t = setup()
    // ログイン: 初期データと裏での読み込みを1回で受け取る
    const login = t.post({ action: 'exchangeIdToken', idToken: account.id, nonceSecret: 'x', withBackground: true })
    expect(login.ok, JSON.stringify(login)).toBe(true)
    expect(login.result.memberId).toBe(account.id)
    expect(login.result.backgroundError).toBeUndefined()
    expect(login.result.background).toMatchObject({ expenses: [{ id: 'e1' }], formSubmissions: [], candidates: [], myEmail: account.id + '@example.com', errors: {} })

    // 裏での読み込みを別に送った場合(GAS が background を返さなかった時など)
    const bg = t.post({ action: 'getBackgroundData', sessionToken: account.id })
    expect(bg.ok, JSON.stringify(bg)).toBe(true)
    expect(bg.authError).toBeUndefined()
    expect(bg.forbidden).toBeUndefined()
    expect(bg.result.errors).toEqual({})

    // 再読み込み(保存したセッションで入り直す)
    const reload = t.post({ action: 'getInitialData', sessionToken: account.id, withBackground: true })
    expect(reload.ok).toBe(true)
    expect(reload.result.sheets.Members.rows).toHaveLength(ACCOUNTS.length)
    expect(reload.result.background.errors).toEqual({})

    // 情報更新(版が同じなら中身は送らず、裏での読み込みだけ)
    const refresh = t.post({ action: 'getInitialData', sessionToken: account.id, knownVersion: reload.result.version, withBackground: true })
    expect(refresh.ok).toBe(true)
    expect(refresh.result.unchanged).toBe(true)
    expect(refresh.result.background.errors).toEqual({})

    // 個別の読み取りも通る
    for (const action of ['getExpenses', 'getFormSubmissions', 'getCandidates', 'getMyEmails']) {
      const res = t.post({ action, sessionToken: account.id })
      expect(res.ok, action + ': ' + JSON.stringify(res)).toBe(true)
    }
  })
})

describe('権限が足りない時と、セッションが無効な時の違い', () => {
  it('一般のメンバーが管理者の操作を送ると forbidden(authError ではない。ログイン画面に戻さない)', () => {
    const t = setup()
    const res = t.post({ action: 'removeTask', sessionToken: 'm-base', taskId: 't1' })
    expect(res).toMatchObject({ ok: false, forbidden: true })
    expect(res.authError).toBeUndefined()
    expect(res.error).toMatch(/管理者/)
  })

  it('セッションが無い・メンバーが見つからない時だけ authError', () => {
    const t = setup()
    expect(t.post({ action: 'getBackgroundData' })).toMatchObject({ ok: false, authError: true })
    expect(t.post({ action: 'getBackgroundData', sessionToken: 'm-removed' })).toMatchObject({ ok: false, authError: true })
  })

  it('裏での読み込みのうち、権限の無い部分は失敗ではなく空で返す', () => {
    const t = setup()
    const real = t.c.authorizeAction as (a: unknown, action: string, b: unknown) => void
    t.c.authorizeAction = (a: unknown, action: string, b: unknown) => {
      if (action === 'getCandidates' || action === 'getExpenses') throw (t.c.userError as (m: string) => Error)('権限がありません')
      real(a, action, b)
    }
    const res = t.post({ action: 'getBackgroundData', sessionToken: 'm-base' })
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ candidates: [], expenses: [], errors: {} })
  })
})

describe('権限の一覧への登録漏れ', () => {
  it('doPost で扱うすべての操作(runWriteAction)が、authorizeAction のどれかの一覧に入っている(既定の「管理者のみ」に落ちない)', () => {
    const start = CODE_GS.indexOf('function runWriteAction(')
    const doPost = CODE_GS.slice(start, CODE_GS.indexOf('\nfunction ', start + 10))
    const cases = new Set([...doPost.matchAll(/case '(\w+)':/g)].map((m) => m[1]))
    const aStart = CODE_GS.indexOf('function authorizeAction(')
    const auth = CODE_GS.slice(aStart, CODE_GS.indexOf('\nfunction ', aStart + 10))
    const listed = new Set([...auth.matchAll(/'(\w+)'/g)].map((m) => m[1]))
    expect([...cases].filter((a) => !listed.has(a))).toEqual([])
    expect(cases.has('getBackgroundData')).toBe(true)
  })
})

describe('処理時間の内訳(otherMs)', () => {
  it('ログイン: IDトークン確認・メールの照合・セッションの発行・最終ログイン日時も内訳に出し、残りを otherMs にする', () => {
    const t = setup()
    t.c.verifyGoogleIdToken = (idToken: string) => { t.advance(400); return { email: idToken } }
    t.c.findMemberIdByEmailCached = (email: string) => { t.advance(100); return email }
    t.c.issueSessionToken = () => { t.advance(50); return { token: 's', exp: 1 } }
    t.c.recordLastLogin = () => { t.advance(900); return true }
    const res = t.post({ action: 'exchangeIdToken', idToken: 'm-base', nonceSecret: 'x', withBackground: true })
    expect(res.timing).toMatchObject({ verifyMs: 400, emailLookupMs: 100, sessionMs: 50, lastLoginMs: 900, otherMs: 0 })
    expect(res.timing.totalMs).toBe(1450)
    for (const k of ['propsMs', 'versionMs', 'filterMs', 'backgroundMs']) expect(typeof res.timing[k], k).toBe('number')
  })

  it('区間の中で記録した時間(認証の中のシートの読み込み)は、外側と重ねて数えない', () => {
    const t = setup()
    // シートの読み込み(readSheetTables の中で readMs を記録する)に300ms
    t.c.readSheetTables = t.originalReadSheetTables
    t.c.readSheetTablesViaApi = () => {
      t.advance(300)
      return { tables: { Members: { headers: ['id', 'role'], rows: [['m-base', 'base']] }, Settings: { headers: ['key', 'value'], rows: [['roles', ROLES]] } } }
    }
    const normalize = t.c.normalizeRequestCodes as (b: object) => void
    t.c.normalizeRequestCodes = (b: object) => { t.advance(70); normalize(b) } // 内訳に無い処理
    const res = t.post({ action: 'getBackgroundData', sessionToken: 'm-base' })
    expect(res.timing.authMs).toBe(300)
    expect(res.timing.readMs).toBe(300)
    expect(res.timing.totalMs).toBe(370)
    expect(res.timing.otherMs).toBe(70)
  })
})
