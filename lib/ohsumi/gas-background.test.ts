// gas/Code.gs: 読み取りだけの操作はスナップショットで認証すること、裏での読み込みを1回で返す
// getBackgroundData、ログインの中での最終ログイン日時の記録、doGet の記録を確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

function setup(opts: { lockBusy?: boolean } = {}) {
  const cache = new Map<string, string>()
  const logs: string[] = []
  const ctx = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ DATA_VERSION: 'v1' }), getProperty: (k: string) => (k === 'DATA_VERSION' ? 'v1' : null), setProperty() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v) } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => !opts.lockBusy, releaseLock() {} }) },
    SpreadsheetApp: { flush() {} },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026-10-01' },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  const calls: string[] = []
  c.authenticateRequest = () => ({ memberId: 'm1', renewed: null })
  c.bumpDataVersion = () => {}
  // スナップショット: m1 は制限付きの管理者(roles の設定を使う)
  const roles = JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }, { id: 'r-lead', name: '班長', tier: 'admin', restricted: true, sections: ['expenses'] }, { id: 'top', name: '代表', tier: 'top' }])
  const snapshot = {
    Members: { headers: ['id', 'name', 'role', 'project_ids', 'permission_overrides_json'], rows: [['m1', 'A', 'r-lead', 'p1, p2', '[]']] },
    Settings: { headers: ['key', 'value'], rows: [['roles', roles]] },
  }
  c.loadSnapshot = () => { calls.push('loadSnapshot'); return { version: 'v1', data: snapshot, cacheHit: true } }
  c.getActingMemberById = () => { calls.push('sheet:Members'); return { id: 'm1', role: 'top', project_ids: [], permission_overrides: [] } }
  c.readRoleSettings = () => { calls.push('sheet:Settings'); return { roles } }
  c.getExpenses = (acting: { id: string; role: string; project_ids: string[] }) => { calls.push('getExpenses:' + acting.role + ':' + acting.project_ids.join('|')); return [{ id: 'e1' }] }
  c.getFormSubmissions = () => { throw (c.userError as (m: string) => Error)('フォームを読めません') }
  c.getCandidates = () => []
  c.getMemberEmailValue = (id: string) => id + '@example.com'
  c.getMemberEmailValueCached = (id: string) => id + '@example.com'
  c.updateTaskFields = () => ({ ok: true })
  const lastLogins: string[] = []
  c.updateMemberFields = (id: string, fields: { last_login: string }) => { lastLogins.push(id + ':' + fields.last_login); return {} }
  const gas = ctx as unknown as { doPost: (e: object) => { text: string }; doGet: (e: object) => { text: string }; recordLastLogin: (id: string) => boolean }
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  return { gas, post, calls, logs, lastLogins }
}

describe('裏での読み込み(getBackgroundData)', () => {
  it('経費・フォームの回答・候補者・自分のメールを1回で返す。1つが失敗しても、ほかは返す', () => {
    const t = setup()
    const res = t.post({ action: 'getBackgroundData', sessionToken: 's' })
    expect(res.ok).toBe(true)
    expect(res.result.expenses).toEqual([{ id: 'e1' }])
    expect(res.result.candidates).toEqual([])
    expect(res.result.myEmail).toBe('m1@example.com')
    expect(res.result.formSubmissions).toBeUndefined()
    expect(res.result.errors).toEqual({ formSubmissions: 'フォームを読めません' })
    for (const k of ['expensesMs', 'formSubmissionsMs', 'candidatesMs', 'myEmailMs']) expect(typeof res.timing[k], k).toBe('number')
  })
})

describe('読み取りの認証', () => {
  it('読み取りだけの操作は、スナップショットからメンバーと役職の設定を引く(シートを読まない)', () => {
    for (const action of ['getBackgroundData', 'getExpenses', 'getFiles', 'getFormSubmissions']) {
      const t = setup()
      const res = t.post({ action, sessionToken: 's', fileIds: [] })
      expect(res.timing.authFrom, action).toBe('snapshot')
      expect(t.calls.filter((c) => c.startsWith('sheet:')), action).toEqual([])
    }
    const t = setup()
    t.post({ action: 'getExpenses', sessionToken: 's' })
    // スナップショットの行から、役職・担当プロジェクトを読む
    expect(t.calls).toContain('getExpenses:r-lead:p1|p2')
  })

  it('普通の書き込みもスナップショットから判定する。権限そのものを変える操作は、これまでどおりシートから読む', () => {
    const t = setup()
    const res = t.post({ action: 'updateProgress', sessionToken: 's', taskId: 't1', progressPercent: 50 })
    expect(res.ok).toBe(true)
    expect(res.timing.authFrom).toBe('snapshot')
    expect(t.calls.filter((c) => c.startsWith('sheet:'))).toEqual([])

    const u = setup()
    u.post({ action: 'updateRole', sessionToken: 's', memberId: 'm2', role: 'base' })
    expect(u.calls).toContain('sheet:Members')
  })
})

describe('ログインの中での最終ログイン日時', () => {
  // 記録のしかた(1時間以内は書かない・書き込み待ち・まとめて書く)は gas-login-latency.test.ts
  it('exchangeIdToken は結果に lastLoginRecorded を付ける', () => {
    expect(CODE_GS).toMatch(/data\.lastLoginRecorded = .*recordLastLogin\(memberId\)/)
  })
})

describe('doGet の記録', () => {
  it('パラメータの名前と値の長さだけを実行ログに残す(値そのものは残さない)', () => {
    const t = setup()
    const res = JSON.parse(t.gas.doGet({ parameter: { q: '山田太郎のメール', token: 'secret-value' }, queryString: 'q=...&token=...', contentLength: -1 }).text)
    expect(res.getReceived).toBe(true)
    const line = t.logs.find((l) => l.startsWith('doGet に届きました'))!
    expect(line).toContain('q(8文字)')
    expect(line).toContain('token(12文字)')
    expect(line).not.toContain('山田')
    expect(line).not.toContain('secret-value')
  })
})
