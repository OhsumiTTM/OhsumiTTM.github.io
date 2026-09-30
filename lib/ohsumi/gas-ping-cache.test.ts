// gas/Code.gs: 切り分け用の ping、送り返された GET(doGet)の応答、初期データと裏での読み込みを
// 1回で返すこと(withBackground)、メンバーの削除・役職・部門の変更とスプレッドシートの直接の編集で
// 読み取りの認証に使うスナップショットが作り直されることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Table = { headers: string[]; rows: string[][] }

function setup() {
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1' }
  let propsReads = 0
  // シート(直接の編集は、この表を書き換えるだけ。版は変わらない)
  const sheet: Record<string, Table> = {
    Members: {
      headers: ['id', 'name', 'role', 'project_ids', 'permission_overrides_json', 'department_path'],
      rows: [
        ['m1', '代表', 'top', '', '[]', ''],
        ['m2', '班長', 'top', '', '[]', '広報'],
      ],
    },
    Settings: { headers: ['key', 'value'], rows: [] },
  }
  const clone = () => JSON.parse(JSON.stringify(sheet)) as Record<string, Table>
  const blob = (d: Buffer | string) => {
    const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
    return { getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') }
  }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties: () => {
        propsReads++
        return {
          getProperties: () => ({ ...props }),
          getProperty: (k: string) => props[k] ?? null,
          setProperty: (k: string, v: string) => { props[k] = v },
        }
      },
    },
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
    // gzip は Apps Script だけのため、そのまま通す
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
  const DateInCtx = vm.runInContext('Date', ctx) as { now: () => number }
  let now = Date.parse('2026-10-01T00:00:00Z')
  DateInCtx.now = () => now
  const calls: string[] = []
  c.authenticateRequest_ = (body: { sessionToken: string }) => ({ memberId: body.sessionToken, renewed: null })
  c.authorizeAction_ = () => {}
  c.assertTopRemains_ = () => {}
  c.requireKnownRole_ = () => {}
  c.sheetRoleRef_ = (r: string) => r
  c.readSheetTables_ = () => { calls.push('readSheets'); return clone() }
  c.buildViewerData_ = (data: Record<string, Table>) => data
  // シートから引く(書き込みの認証・スナップショットに見つからない時)
  c.getActingMemberById_ = (id: string) => {
    calls.push('sheet:Members')
    const row = sheet.Members.rows.find((r) => r[0] === id)
    if (!row) throw (c.userError_ as (m: string) => Error)('メンバー登録が見つかりません。管理者にお問い合わせください。')
    return { id, role: row[2], project_ids: [], permission_overrides: [] }
  }
  const col = (name: string) => sheet.Members.headers.indexOf(name)
  c.updateMemberFields_ = (id: string, fields: Record<string, string>) => {
    const row = sheet.Members.rows.find((r) => r[0] === id)!
    for (const [k, v] of Object.entries(fields)) if (col(k) >= 0) row[col(k)] = v
    return { ok: true }
  }
  c.removeMember_ = (id: string) => { sheet.Members.rows = sheet.Members.rows.filter((r) => r[0] !== id); return { ok: true } }
  c.getExpenses_ = (acting: { id: string; role: string }) => { calls.push('getExpenses:' + acting.id + ':' + acting.role); return [{ id: 'e1' }] }
  c.getFormSubmissions_ = () => []
  c.getCandidates_ = () => []
  c.getMemberEmailValue_ = (id: string) => id + '@example.com'
  c.getMemberEmailValueCached_ = (id: string) => id + '@example.com'
  const gas = ctx as unknown as {
    doPost: (e: object) => { text: string }
    doGet: (e: object) => { text: string }
    onSpreadsheetChange: (e: object) => void
    loadSnapshot_: () => { data: Record<string, Table> }
    LOCK_EXEMPT_ACTIONS: string[]
    SNAPSHOT_MAX_AGE_MS: number
  }
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  return {
    gas, c, post, calls, props, sheet, cache,
    propsReads: () => propsReads,
    advance: (ms: number) => { now += ms },
  }
}

describe('ping(切り分け用)', () => {
  it('認証・スクリプトプロパティ・シートを読まずに、すぐ pong と GAS の中の時間を返す', () => {
    const t = setup()
    t.c.authenticateRequest_ = () => { throw new Error('認証してはいけない') }
    const before = t.propsReads()
    const res = t.post({ action: 'ping' })
    expect(res).toMatchObject({ ok: true, result: { pong: true } })
    expect(typeof res.timing.totalMs).toBe('number')
    expect(t.propsReads()).toBe(before)
    expect(t.calls).toEqual([])
  })
})

describe('送り返された GET(doGet)', () => {
  it('bounced: true の JSON をすぐ返す(プロパティもシートも読まない)', () => {
    const t = setup()
    const before = t.propsReads()
    const res = JSON.parse(t.gas.doGet({ parameter: {} }).text)
    expect(res).toMatchObject({ ok: false, getReceived: true, bounced: true })
    expect(res.error).toMatch(/送り返された/)
    expect(typeof res.timing.totalMs).toBe('number')
    expect(t.propsReads()).toBe(before)
    expect(t.calls).toEqual([])
  })
})

describe('初期データと裏での読み込みを1回で返す(withBackground)', () => {
  it('getInitialData: 同じ応答に background が入り、スナップショットは1回だけ読む', () => {
    const t = setup()
    const res = t.post({ action: 'getInitialData', sessionToken: 'm1', withBackground: true })
    expect(res.ok).toBe(true)
    expect(res.result.sheets.Members.rows).toHaveLength(2)
    expect(res.result.background).toMatchObject({ expenses: [{ id: 'e1' }], candidates: [], formSubmissions: [], myEmail: 'm1@example.com', errors: {} })
    expect(t.calls.filter((x) => x === 'readSheets')).toHaveLength(1)
    expect(typeof res.timing.backgroundMs).toBe('number')
    expect(res.timing.authFrom).toBe('snapshot')
  })

  it('版が同じ(unchanged)でも background は返す。withBackground が無ければ返さない', () => {
    const t = setup()
    const same = t.post({ action: 'getInitialData', sessionToken: 'm1', knownVersion: 'v1', withBackground: true })
    expect(same.result.unchanged).toBe(true)
    expect(same.result.background.expenses).toEqual([{ id: 'e1' }])
    const plain = t.post({ action: 'getInitialData', sessionToken: 'm1' })
    expect(plain.result.background).toBeUndefined()
  })

  it('裏での読み込みが失敗しても、初期データは返す(backgroundError)', () => {
    const t = setup()
    t.c.getBackgroundData_ = () => { throw new Error('boom') }
    const res = t.post({ action: 'getInitialData', sessionToken: 'm1', withBackground: true })
    expect(res.ok).toBe(true)
    expect(res.result.sheets).toBeDefined()
    expect(res.result.background).toBeUndefined()
    expect(typeof res.result.backgroundError).toBe('string')
  })

  it('exchangeIdToken: ログインの応答にも background が入る', () => {
    const t = setup()
    t.c.verifyGoogleIdToken_ = () => ({ email: 'm1@example.com' })
    t.c.findMemberIdByEmailCached_ = () => 'm1'
    t.c.issueSessionToken_ = () => 'session'
    t.c.recordLastLogin_ = () => true
    const res = t.post({ action: 'exchangeIdToken', idToken: 'x', nonceSecret: 'y', withBackground: true })
    expect(res.ok).toBe(true)
    expect(res.result.session).toBe('session')
    expect(res.result.background.myEmail).toBe('m1@example.com')
  })
})

describe('読み取りの認証に使うスナップショットの作り直し', () => {
  it('メンバーの削除・役職・部門の変更は、ロックを取る書き込み(終わった時にデータの版を変える)', () => {
    const t = setup()
    for (const action of ['removeMember', 'updateRole', 'updateRoles', 'updateMemberDepartmentPath', 'updatePermissionOverrides', 'addMember']) {
      expect(t.gas.LOCK_EXEMPT_ACTIONS, action).not.toContain(action)
    }
  })

  it('役職の変更の直後、次の読み取りは新しい役職で判定する', () => {
    const t = setup()
    t.post({ action: 'getExpenses', sessionToken: 'm2' })
    expect(t.post({ action: 'getExpenses', sessionToken: 'm2' }).timing.cache).toBe('hit')
    const before = t.props.DATA_VERSION
    expect(t.post({ action: 'updateRole', sessionToken: 'm1', memberId: 'm2', role: 'base' }).ok).toBe(true)
    expect(t.props.DATA_VERSION).not.toBe(before)
    const res = t.post({ action: 'getExpenses', sessionToken: 'm2' })
    expect(res.timing).toMatchObject({ cache: 'miss', authFrom: 'snapshot' })
    expect(t.calls.at(-1)).toBe('getExpenses:m2:base')
  })

  it('部門の変更の直後、スナップショットは新しい部門になる', () => {
    const t = setup()
    t.post({ action: 'getExpenses', sessionToken: 'm2' })
    const before = t.props.DATA_VERSION
    t.post({ action: 'updateMemberDepartmentPath', sessionToken: 'm1', memberId: 'm2', departmentPath: '総務' })
    expect(t.props.DATA_VERSION).not.toBe(before)
    const members = t.gas.loadSnapshot_().data.Members
    expect(members.rows.find((r) => r[0] === 'm2')![members.headers.indexOf('department_path')]).toBe('総務')
  })

  it('削除の直後、削除されたメンバーの読み取りは断る', () => {
    const t = setup()
    expect(t.post({ action: 'getExpenses', sessionToken: 'm2' }).ok).toBe(true)
    t.post({ action: 'removeMember', sessionToken: 'm1', memberId: 'm2' })
    const res = t.post({ action: 'getExpenses', sessionToken: 'm2' })
    expect(res).toMatchObject({ ok: false, authError: true })
    expect(res.timing.authFrom).toBe('sheet') // スナップショットに見つからず、シートでも見つからない
  })

  it('スプレッドシートの直接の編集: 変更検知のトリガー(onSpreadsheetChange)で、すぐ作り直す', () => {
    const t = setup()
    t.post({ action: 'getExpenses', sessionToken: 'm2' })
    t.sheet.Members.rows[1][2] = 'base' // 版を変えずにシートだけ変える
    t.post({ action: 'getExpenses', sessionToken: 'm2' })
    expect(t.calls.at(-1)).toBe('getExpenses:m2:top') // トリガーが動くまでは前のまま
    t.gas.onSpreadsheetChange({})
    const res = t.post({ action: 'getExpenses', sessionToken: 'm2' })
    expect(res.timing.cache).toBe('miss')
    expect(t.calls.at(-1)).toBe('getExpenses:m2:base')
  })

  it('トリガーが動かなくても、作ってから5分を過ぎたスナップショットは使わない', () => {
    const t = setup()
    expect(t.gas.SNAPSHOT_MAX_AGE_MS).toBe(5 * 60 * 1000)
    t.post({ action: 'getExpenses', sessionToken: 'm2' })
    t.sheet.Members.rows[1][2] = 'base'
    t.advance(5 * 60 * 1000 - 1000)
    expect(t.post({ action: 'getExpenses', sessionToken: 'm2' }).timing.cache).toBe('hit')
    expect(t.calls.at(-1)).toBe('getExpenses:m2:top')
    t.advance(2000)
    expect(t.post({ action: 'getExpenses', sessionToken: 'm2' }).timing.cache).toBe('miss')
    expect(t.calls.at(-1)).toBe('getExpenses:m2:base')
    // 前の形式の目録(作った時刻が無い)は使わない
    const metaKey = [...t.cache.keys()].find((k) => k.endsWith(':meta'))!
    t.cache.set(metaKey, '1')
    expect(t.post({ action: 'getExpenses', sessionToken: 'm2' }).timing.cache).toBe('miss')
  })
})
