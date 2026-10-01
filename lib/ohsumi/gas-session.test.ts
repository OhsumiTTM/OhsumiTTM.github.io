// gas/Code.gs のログイン(IDトークン → セッショントークン)を、Apps Script のサービスを
// Node の crypto で置き換えて確かめる。改ざん・有効期限切れ・別の団体のトークン・
// 世代番号の不一致・nonce の不一致や使い回しが拒否されること。
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const CLIENT_ID = 'client-123.apps.googleusercontent.com'

const toSigned = (buf: Buffer) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b))
const toBuffer = (x: string | number[]) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map((b) => b & 255)))
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

class FakeSheet {
  constructor(public rows: string[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()) }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
      setValue: (v: string) => { this.rows[row - 1][col - 1] = v },
      // 退会は行を消さずに書き換える(withdrawn_at など)
      setValues: (vs: string[][]) => vs.forEach((line, r) => line.forEach((v, c) => { this.rows[row - 1 + r][col - 1 + c] = v })),
      setNumberFormat: () => {},
    }
  }
  appendRow(v: string[]) { this.rows.push(v) }
  deleteRow(r: number) { this.rows.splice(r - 1, 1) }
}

type IdClaims = Record<string, unknown>

function setup(opts: { orgId?: string; props?: Record<string, string> } = {}) {
  const props: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, ...(opts.props ?? {}) }
  const cache: Record<string, string> = {}
  let getPropertiesCalls = 0
  let idClaims: IdClaims = {}
  let tokeninfoCalls = 0
  const sheets: Record<string, FakeSheet> = {
    Members: new FakeSheet([['id', 'name', 'role', 'project_ids', 'permission_overrides_json'], ['m1', '代表', '代表', '', ''], ['m2', '一般', '一般', '', '']]),
    MemberEmails: new FakeSheet([['id', 'email'], ['m1', 'boss@example.com'], ['m2', 'member@example.com, alt@example.com']]),
    Tasks: new FakeSheet([['id', 'assignee_id']]),
  }
  const clock = { now: Date.UTC(2026, 9, 1) }
  const context = vm.createContext({
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    Logger: { log: () => undefined },
    Date: class extends Date {
      constructor(...args: unknown[]) {
        if (args.length) super(args[0] as string | number)
        else super(clock.now)
      }
      static now() { return clock.now }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props[k] ?? null,
        getProperties: () => { getPropertiesCalls++; return { ...props } },
        setProperty: (k: string, v: string) => { props[k] = v },
        deleteProperty: (k: string) => { delete props[k] },
      }),
    },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache[k] ?? null, put: (k: string, v: string) => { cache[k] = v } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => undefined, releaseLock: () => undefined }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null }), flush: () => undefined },
    ContentService: { createTextOutput: (text: string) => ({ text, setMimeType() { return this } }), MimeType: { JSON: 'json' } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_alg: string, value: string) => toSigned(crypto.createHash('sha256').update(toBuffer(value)).digest()),
      computeHmacSha256Signature: (value: string, key: string) => toSigned(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest()),
      base64EncodeWebSafe: (x: string | number[]) => toBuffer(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s: string) => toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (bytes: number[]) => ({ getDataAsString: () => toBuffer(bytes).toString('utf8') }),
    },
    UrlFetchApp: {
      fetch: (url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?id_token=')) {
          tokeninfoCalls++
          return { getResponseCode: () => (idClaims.__status as number) ?? 200, getContentText: () => JSON.stringify(idClaims) }
        }
        throw new Error('unexpected fetch ' + url)
      },
    },
  })
  vm.runInContext(CODE_GS, context)
  const gas = context as unknown as Record<string, (...a: unknown[]) => unknown>
  // 初期データの読み込み(シートの読み込み)はこのテストの対象外
  ;(context as Record<string, unknown>).getInitialDataForMember_ = (id: string) => ({ memberId: id, version: 'v1', sheets: {} })
  if (opts.orgId !== undefined) props.ORG_ID = opts.orgId
  gas.ensureSessionSecrets_()

  const post = (body: Record<string, unknown>) => {
    const out = gas.doPost({ postData: { contents: JSON.stringify(body) } }) as { text: string }
    return JSON.parse(out.text) as { ok: boolean; result?: Record<string, unknown>; error?: string; authError?: boolean; session?: { token: string; exp: number } }
  }
  // フロントと同じ手順で nonce を作り、IDトークン(tokeninfo の応答)を用意する
  const googleLogin = (email: string, override: IdClaims = {}, org = props.ORG_ID) => {
    const secret = b64url(crypto.randomBytes(32))
    const nonce = org + '.' + b64url(crypto.createHash('sha256').update(secret).digest())
    idClaims = {
      iss: 'https://accounts.google.com', aud: CLIENT_ID, email, email_verified: 'true', nonce,
      iat: String(Math.floor(clock.now / 1000)), exp: String(Math.floor(clock.now / 1000) + 3600),
      ...override,
    }
    return { idToken: 'aaa.bbb.ccc', nonceSecret: secret }
  }
  const login = (email = 'member@example.com', remember = true) => {
    const res = post({ action: 'exchangeIdToken', ...googleLogin(email), remember })
    expect(res.ok, res.error).toBe(true)
    return (res.result!.session as { token: string; exp: number }).token
  }
  return {
    gas, props, cache, sheets, clock, post, googleLogin, login,
    get getPropertiesCalls() { return getPropertiesCalls },
    get tokeninfoCalls() { return tokeninfoCalls },
  }
}

const tamper = (token: string, edit: (p: Record<string, unknown>) => void) => {
  const [v, payload, sig] = token.split('.')
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  edit(obj)
  return [v, b64url(Buffer.from(JSON.stringify(obj))), sig].join('.')
}

describe('IDトークンの交換(exchangeIdToken)', () => {
  it('確認に成功すると、団体の鍵で署名したセッショントークンと初期データを返す', () => {
    const t = setup()
    const res = t.post({ action: 'exchangeIdToken', ...t.googleLogin('Member@Example.com '.trim()), remember: true })
    expect(res.ok).toBe(true)
    expect(res.result!.memberId).toBe('m2')
    const session = res.result!.session as { token: string; exp: number; remember: boolean }
    expect(session.token).toMatch(/^v1\.[\w-]+\.[\w-]+$/)
    // チェックあり: 1回14日
    expect(session.exp - Math.floor(t.clock.now / 1000)).toBe(14 * 24 * 3600)
    expect(session.remember).toBe(true)
  })

  it('チェックなしのセッションは12時間', () => {
    const t = setup()
    const res = t.post({ action: 'exchangeIdToken', ...t.googleLogin('member@example.com'), remember: false })
    const session = res.result!.session as { exp: number; remember: boolean }
    expect(session.exp - Math.floor(t.clock.now / 1000)).toBe(12 * 3600)
    expect(session.remember).toBe(false)
  })

  it.each([
    ['aud が別のクライアント', { aud: 'other-client' }, /発行元がこのアプリと一致しません/],
    ['iss が Google ではない', { iss: 'https://evil.example.com' }, /発行元が不正/],
    ['email_verified が false', { email_verified: 'false' }, /確認されていない/],
    ['有効期限切れ', { exp: '1' }, /有効期限/],
    ['tokeninfo がエラー', { __status: 400 }, /確認できませんでした/],
  ])('%s の IDトークンは拒否する', (_label, override, message) => {
    const t = setup()
    const res = t.post({ action: 'exchangeIdToken', ...t.googleLogin('member@example.com', override), remember: true })
    expect(res.ok).toBe(false)
    expect(res.authError).toBe(true)
    expect(res.error).toMatch(message)
  })

  it('別の団体の nonce、別の画面の乱数、使い回しは拒否する', () => {
    const t = setup()
    const otherOrg = t.post({ action: 'exchangeIdToken', ...t.googleLogin('member@example.com', {}, 'org_other'), remember: true })
    expect(otherOrg.error).toMatch(/この団体・この画面のもの/)

    const login = t.googleLogin('member@example.com')
    const wrongSecret = t.post({ action: 'exchangeIdToken', idToken: login.idToken, nonceSecret: 'x'.repeat(43), remember: true })
    expect(wrongSecret.error).toMatch(/この団体・この画面のもの/)

    expect(t.post({ action: 'exchangeIdToken', ...login, remember: true }).ok).toBe(true)
    const reused = t.post({ action: 'exchangeIdToken', ...login, remember: true })
    expect(reused.ok).toBe(false)
    expect(reused.error).toMatch(/既に使われています/)
  })

  it('登録されていないアカウントは、本人のメールアドレスと団体名だけを返す(セッションは発行しない)', () => {
    const t = setup()
    t.gas.getSettingValue_ = ((k: string) => (k === 'org_name' ? 'テスト団体' : '')) as never
    const res = t.post({ action: 'exchangeIdToken', ...t.googleLogin('stranger@example.com'), remember: true })
    expect(res.result).toEqual({ memberId: null, email: 'stranger@example.com', orgName: 'テスト団体' })
  })

  it('getLoginConfig は団体IDだけを返し、setupOhsumi 前はエラーにする', () => {
    const t = setup({ orgId: 'org_fixed' })
    expect(t.post({ action: 'getLoginConfig' }).result).toEqual({ orgId: 'org_fixed' })
    delete t.props.ORG_ID
    expect(t.post({ action: 'getLoginConfig' }).ok).toBe(false)
  })
})

describe('ログインの送り直し(exchangeIdToken + requestId)', () => {
  it('同じ requestId・IDトークン・画面の乱数で送り直されたら、確認をやり直さずに同じセッションを返す', () => {
    const t = setup()
    const login = t.googleLogin('member@example.com')
    const first = t.post({ action: 'exchangeIdToken', ...login, remember: true, requestId: 'login-00000001' })
    expect(first.ok, first.error).toBe(true)
    const calls = t.tokeninfoCalls
    const again = t.post({ action: 'exchangeIdToken', ...login, remember: true, requestId: 'login-00000001' })
    expect(again.ok).toBe(true)
    expect((again as Record<string, unknown>).replayed).toBe(true)
    // 1回目と同じセッション。初期データは覚えないので、画面に読み直してもらう
    expect(again.result!.session).toEqual(first.result!.session)
    expect(again.result!.memberId).toBe('m2')
    expect(again.result!.reloadInitialData).toBe(true)
    expect(t.tokeninfoCalls).toBe(calls)
  })

  it('requestId・画面の乱数・IDトークンのどれかが違えば、覚えた結果は返さない(使い回しとして拒否)', () => {
    const t = setup()
    const login = t.googleLogin('member@example.com')
    expect(t.post({ action: 'exchangeIdToken', ...login, remember: true, requestId: 'login-00000002' }).ok).toBe(true)
    const otherId = t.post({ action: 'exchangeIdToken', ...login, remember: true, requestId: 'login-00000003' })
    expect(otherId.ok).toBe(false)
    expect(otherId.error).toMatch(/既に使われています/)
    const noId = t.post({ action: 'exchangeIdToken', ...login, remember: true })
    expect(noId.error).toMatch(/既に使われています/)
    const otherSecret = t.post({ action: 'exchangeIdToken', idToken: login.idToken, nonceSecret: 'x'.repeat(43), remember: true, requestId: 'login-00000002' })
    expect(otherSecret.ok).toBe(false)
    expect(otherSecret.result).toBeUndefined()
    const otherToken = t.post({ action: 'exchangeIdToken', idToken: 'ddd.eee.fff', nonceSecret: login.nonceSecret, remember: true, requestId: 'login-00000002' })
    expect(otherToken.ok).toBe(false)
    expect(otherToken.result).toBeUndefined()
  })

  it('1回目が失敗だった時は、同じ失敗を返す。処理中なら少し待つよう返す', () => {
    const t = setup()
    const bad = t.googleLogin('member@example.com', { aud: 'other-client' })
    const first = t.post({ action: 'exchangeIdToken', ...bad, remember: true, requestId: 'login-00000004' })
    expect(first.ok).toBe(false)
    const calls = t.tokeninfoCalls
    const again = t.post({ action: 'exchangeIdToken', ...bad, remember: true, requestId: 'login-00000004' })
    expect(again).toMatchObject({ ok: false, authError: true, error: first.error, replayed: true })
    expect(t.tokeninfoCalls).toBe(calls)

    const login = t.googleLogin('member@example.com')
    const key = t.gas.loginReplayKey_({ ...login, requestId: 'login-00000005' }) as string
    t.cache[key] = JSON.stringify({ inFlight: true })
    const busy = t.post({ action: 'exchangeIdToken', ...login, remember: true, requestId: 'login-00000005' }) as Record<string, unknown>
    expect(busy.ok).toBe(false)
    expect(busy.retryLater).toBe(true)
    expect(busy.authError).toBeUndefined()
  })

  it('覚えておく記録には、画面の乱数・IDトークンそのものは入れない', () => {
    const t = setup()
    const login = t.googleLogin('member@example.com')
    t.post({ action: 'exchangeIdToken', ...login, remember: true, requestId: 'login-00000006' })
    const keys = Object.keys(t.cache).filter((k) => k.startsWith('rqlogin:'))
    expect(keys).toHaveLength(1)
    const all = keys.join() + Object.values(t.cache).join()
    expect(all).not.toContain(login.nonceSecret)
    expect(all).not.toContain('login-00000006')
  })
})

describe('セッショントークンの確認', () => {
  it('正しいトークンで操作でき、Google には問い合わせない。プロパティは1リクエスト1回だけ読む', () => {
    const t = setup()
    const token = t.login()
    const calls = t.tokeninfoCalls
    const before = t.getPropertiesCalls
    const res = t.post({ action: 'getMyEmails', sessionToken: token })
    expect(res.ok, res.error).toBe(true)
    expect(t.tokeninfoCalls).toBe(calls)
    expect(t.getPropertiesCalls - before).toBe(1)
    expect(t.post({ action: 'getInitialData', sessionToken: token }).result).toMatchObject({ memberId: 'm2' })
  })

  it.each([
    ['中身の改ざん(別のメンバーになりすまし)', (tok: string) => tamper(tok, (p) => { p.sub = 'm1' })],
    ['署名の改ざん', (tok: string) => tok.slice(0, -2) + (tok.endsWith('AA') ? 'BB' : 'AA')],
    ['形式の不正', () => 'v1.abc'],
    ['別の版', (tok: string) => 'v2' + tok.slice(2)],
  ])('%s は拒否する', (_label, mutate) => {
    const t = setup()
    const res = t.post({ action: 'getMyEmails', sessionToken: mutate(t.login()) })
    expect(res.ok).toBe(false)
    expect(res.authError).toBe(true)
  })

  it('有効期限切れは拒否する(チェックなしは12時間後)', () => {
    const t = setup()
    const token = t.login('member@example.com', false)
    t.clock.now += 12 * 3600 * 1000 + 1000
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).error).toMatch(/有効期限が切れました/)
  })

  it('別の団体のトークン(その団体の鍵で正しく署名されたもの)は拒否する', () => {
    const a = setup({ orgId: 'org_a' })
    const b = setup({ orgId: 'org_b' })
    const tokenForB = b.login()
    expect(a.post({ action: 'getMyEmails', sessionToken: tokenForB }).ok).toBe(false)
    // 鍵が同じでも、団体IDが違えば拒否する
    a.props.SESSION_SIGNING_KEY = b.props.SESSION_SIGNING_KEY
    a.props.SESSION_KEY_ID = b.props.SESSION_KEY_ID
    expect(a.post({ action: 'getMyEmails', sessionToken: tokenForB }).error).toMatch(/この団体のログイン情報ではありません/)
  })

  it('秘密鍵を作り直すと、発行済みのトークンはすべて無効になる', () => {
    const t = setup()
    const token = t.login()
    t.gas.rotateSessionKey()
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).ok).toBe(false)
    expect(t.post({ action: 'getMyEmails', sessionToken: t.login() }).ok).toBe(true)
  })

  it('SESSION_NOT_BEFORE より前に発行されたトークンは無効になる', () => {
    const t = setup()
    const token = t.login()
    t.clock.now += 60 * 1000
    t.gas.revokeSessionsIssuedBefore()
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).ok).toBe(false)
    expect(t.post({ action: 'getMyEmails', sessionToken: t.login() }).ok).toBe(true)
    // 指定した日時で無効にする(プロパティ経由)。過去に戻すことはできない
    t.props.REVOKE_BEFORE_INPUT = '2026-01-01T00:00:00Z'
    t.gas.revokeSessionsIssuedBeforeInput()
    expect(Number(t.props.SESSION_NOT_BEFORE)).toBeGreaterThan(Date.UTC(2026, 0, 1) / 1000)
  })

  it('全端末でログアウトすると、そのメンバーのトークンだけが無効になる(世代番号の不一致)', () => {
    const t = setup()
    const mine = t.login('member@example.com')
    const other = t.login('member@example.com')
    const boss = t.login('boss@example.com')
    expect(t.post({ action: 'revokeMySessions', sessionToken: mine }).ok).toBe(true)
    expect(t.post({ action: 'getMyEmails', sessionToken: mine }).error).toMatch(/全端末でログアウト済み/)
    expect(t.post({ action: 'getMyEmails', sessionToken: other }).ok).toBe(false)
    expect(t.post({ action: 'getMyEmails', sessionToken: boss }).ok).toBe(true)
    expect(t.post({ action: 'getMyEmails', sessionToken: t.login('member@example.com') }).ok).toBe(true)
  })

  it('他のメンバーの全端末ログアウトは、代表・全権管理者だけができる', () => {
    const t = setup()
    const member = t.login('member@example.com')
    const boss = t.login('boss@example.com')
    expect(t.post({ action: 'revokeMemberSessions', sessionToken: member, memberId: 'm1' }).ok).toBe(false)
    expect(t.post({ action: 'getMyEmails', sessionToken: boss }).ok).toBe(true)
    expect(t.post({ action: 'revokeMemberSessions', sessionToken: boss, memberId: 'm2' }).ok).toBe(true)
    expect(t.post({ action: 'getMyEmails', sessionToken: member }).ok).toBe(false)
  })

  it('登録していたメールアドレスを外すと、そのメンバーのトークンは無効になる(追加だけなら有効のまま)', () => {
    const t = setup()
    const token = t.login('member@example.com')
    t.gas.setMemberEmail_('m2', 'member@example.com, alt@example.com, new@example.com')
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).ok).toBe(true)
    t.gas.setMemberEmail_('m2', 'member@example.com')
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).ok).toBe(false)
  })

  it('メンバーを削除すると、そのメンバーのトークンは無効になる', () => {
    const t = setup()
    const token = t.login('member@example.com')
    // 操作の記録(AuditLog シート)は、この偽のスプレッドシートでは作らない
    ;(t.gas as unknown as Record<string, unknown>).appendOrgAudit_ = () => {}
    t.gas.removeMember_('m2')
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).ok).toBe(false)
  })
})

describe('セッションの延長', () => {
  it('チェックありは残りが半分を切ると新しいトークンを返し、上限はログインから30日', () => {
    const t = setup()
    let token = t.login()
    const loginAt = Math.floor(t.clock.now / 1000)
    t.clock.now += 6 * 24 * 3600 * 1000
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).session).toBeUndefined()
    t.clock.now += 2 * 24 * 3600 * 1000
    const renewed = t.post({ action: 'getMyEmails', sessionToken: token }).session!
    expect(renewed.exp - Math.floor(t.clock.now / 1000)).toBe(14 * 24 * 3600)
    token = renewed.token
    // 延長を重ねても、ログインから30日を超えない
    for (let day = 0; day < 40; day++) {
      t.clock.now += 24 * 3600 * 1000
      const res = t.post({ action: 'getMyEmails', sessionToken: token })
      if (!res.ok) break
      if (res.session) {
        expect(res.session.exp).toBeLessThanOrEqual(loginAt + 30 * 24 * 3600)
        token = res.session.token
      }
    }
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).ok).toBe(false)
    expect(Math.floor(t.clock.now / 1000) - loginAt).toBeLessThanOrEqual(31 * 24 * 3600)
  })

  it('チェックなしは延長しない', () => {
    const t = setup()
    const token = t.login('member@example.com', false)
    t.clock.now += 11 * 3600 * 1000
    expect(t.post({ action: 'getMyEmails', sessionToken: token }).session).toBeUndefined()
  })
})

describe('セッショントークンが無いリクエスト', () => {
  it.each([
    ['トークンなし', {}],
    // 以前の方式(Google のアクセストークン)は受け付けない。Google にも問い合わせない
    ['アクセストークンだけ', { authToken: 'x'.repeat(40) }],
  ])('%s は拒否する', (_label, auth) => {
    const t = setup()
    const calls = t.tokeninfoCalls
    for (const action of ['getMyEmails', 'getInitialData', 'resolveLogin']) {
      const res = t.post({ action, ...auth })
      expect(res.ok).toBe(false)
      expect(res.authError).toBe(true)
    }
    expect(t.tokeninfoCalls).toBe(calls)
  })
})

describe('setupOhsumi の準備', () => {
  it('ORG_ID・秘密鍵・鍵IDは無ければ作り、既にあれば変えない', () => {
    const t = setup()
    const before = { ...t.props }
    expect(before.ORG_ID).toMatch(/^org_[\w-]{20}$/)
    expect(before.SESSION_SIGNING_KEY.length).toBeGreaterThanOrEqual(40)
    expect(t.gas.ensureSessionSecrets_()).toEqual([])
    expect(t.props.ORG_ID).toBe(before.ORG_ID)
    expect(t.props.SESSION_SIGNING_KEY).toBe(before.SESSION_SIGNING_KEY)
  })
})
