// レジストリ(registry/Code.gs)の R1-b: 管理者のログイン・管理画面の一覧・登録コードの発行と取り消し・
// 登録コードを使う処理(R1-c から呼ぶ)・操作の記録を確かめる
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ADMINS = 'Admin.One@example.com, admin2@example.com'
const DAY = 24 * 3600 * 1000
const secretFor = (name: string) => `nonce-secret-${name}-0123456789`
const nonceOf = (secret: string) => 'registry-admin.' + createHash('sha256').update(secret).digest('base64url')

// Google の ID トークン(tokeninfo の応答)。exp は十分に先
function token(email: string, name: string, extra: Partial<TokenInfo> = {}): [string, TokenInfo] {
  return [`hdr.${name}.sig`, {
    aud: CLIENT, iss: 'https://accounts.google.com', email, email_verified: 'true',
    exp: String(Math.floor(Date.now() / 1000) + 3600), iat: String(Math.floor(Date.now() / 1000)), nonce: nonceOf(secretFor(name)), ...extra,
  }]
}

function ready(extraTokens: [string, TokenInfo][] = []) {
  const tokens = Object.fromEntries([
    token('admin.one@example.com', 'a1'),
    token('Admin2@Example.com', 'a2'),
    token('stranger@example.com', 'x1'),
    ...extraTokens,
  ])
  const t = setup({ props: { ADMIN_EMAILS: ADMINS, OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const login = (name: string) => t.post({ action: 'adminLogin', idToken: `hdr.${name}.sig`, nonceSecret: secretFor(name) })
  const audit = () => t.sheets.get('AuditLog')!.rows.slice(1).map((r) => ({ actor: r[1], action: r[2], target: r[3], after: r[5], reason: r[6] }))
  const codesSheet = () => t.sheets.get('RegistrationCodes')!
  return { ...t, login, audit, codesSheet }
}

describe('管理者のログイン', () => {
  it('許可リスト(ADMIN_EMAILS)にある人は入れる。大文字・小文字の違いは同じとみなす', () => {
    const t = ready()
    const res = t.login('a1')
    expect(res.ok).toBe(true)
    expect(res.result.session.email).toBe('admin.one@example.com')
    expect(res.result.session.token).toMatch(/^ra1\./)
    expect(t.login('a2').ok).toBe(true)
    expect(t.audit().filter((a) => a.action === 'adminLogin').map((a) => a.actor)).toEqual(['admin.one@example.com', 'admin2@example.com'])
  })

  it('許可リストにない人は入れない。断ったことも記録する', () => {
    const t = ready()
    const res = t.login('x1')
    expect(res).toMatchObject({ ok: false, authError: true })
    expect(res.error).toMatch(/管理者として登録されていません/)
    expect(res.result).toBeUndefined()
    expect(t.audit()).toContainEqual(expect.objectContaining({ actor: 'stranger@example.com', action: 'adminLoginDenied' }))
  })

  it('発行元(aud)・nonce が違う・使い回した ID トークンは断る', () => {
    const t = ready([
      token('admin.one@example.com', 'wrongAud', { aud: 'ohsumi-main-client.apps.googleusercontent.com' }),
      token('admin.one@example.com', 'wrongNonce', { nonce: 'registry-admin.other' }),
      token('admin.one@example.com', 'unverified', { email_verified: 'false' }),
    ])
    expect(t.login('wrongAud').error).toMatch(/一致しません/)
    expect(t.login('wrongNonce').error).toMatch(/この画面のもの/)
    expect(t.login('unverified').error).toMatch(/確認されていない/)
    expect(t.login('a1').ok).toBe(true)
    expect(t.login('a1').error).toMatch(/既に使われています/)
  })

  it('セッションの鍵は本体とは別(setupRegistry が作る)。30分で切れ、許可リストから外した人は次の操作から断る', () => {
    const t = ready()
    expect(t.props.ADMIN_SESSION_KEY).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(t.props.SESSION_SIGNING_KEY).toBeUndefined()
    const session = t.login('a2').result.session.token
    expect(t.post({ action: 'adminOverview', session }).ok).toBe(true)
    const now = Date.now()
    expect(() => t.gas.adminOverview_({ session }, now + 31 * 60 * 1000)).toThrow(/有効期限/)
    t.props.ADMIN_EMAILS = 'admin.one@example.com'
    expect(t.post({ action: 'adminOverview', session })).toMatchObject({ ok: false, authError: true })
    // 署名を書き換えたトークン・鍵を作り直した後のトークンは使えない
    t.props.ADMIN_EMAILS = ADMINS
    expect(t.post({ action: 'adminOverview', session: session.slice(0, -2) + 'xx' })).toMatchObject({ ok: false, authError: true })
    t.gas.rotateAdminSessionKey()
    expect(t.post({ action: 'adminOverview', session })).toMatchObject({ ok: false, authError: true })
  })

  it('セッションが無い・知らない操作は断る', () => {
    const t = ready()
    expect(t.post({ action: 'adminOverview' })).toMatchObject({ ok: false, authError: true })
    expect(t.post({ action: 'issueRegistrationCode', orgName: 'x' })).toMatchObject({ ok: false, authError: true })
  })
})

describe('登録コード', () => {
  it('16文字(4文字ずつ区切り)で、読み間違えやすい文字を使わない。保存するのはハッシュだけ', () => {
    const t = ready()
    const session = t.login('a1').result.session.token
    const res = t.post({ action: 'issueRegistrationCode', session, orgName: 'テスト団体A', contactName: '山田', contactEmail: 'yamada@example.org', note: '9月契約分' })
    expect(res.ok).toBe(true)
    const code: string = res.result.code
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/)
    const plain = code.replace(/-/g, '')
    // シートにも記録にも、元のコードは残らない。ハッシュは SHA-256
    const everything = JSON.stringify([...t.sheets.values()].map((s) => s.rows)) + JSON.stringify(t.props)
    expect(everything).not.toContain(plain)
    expect(everything).not.toContain(code)
    const row = t.codesSheet().rows[1]
    const headers = t.codesSheet().rows[0] as string[]
    expect(row[headers.indexOf('code_hash')]).toBe('sha256:' + createHash('sha256').update(plain).digest('hex'))
    expect(row[headers.indexOf('org_name')]).toBe('テスト団体A')
    expect(row[headers.indexOf('note')]).toBe('9月契約分')
    expect(row[headers.indexOf('issued_by')]).toBe('admin.one@example.com')
    // 発行の記録に、コードもハッシュも入れない
    const issued = t.audit().find((a) => a.action === 'issueRegistrationCode')!
    expect(issued.actor).toBe('admin.one@example.com')
    expect(String(issued.after)).toContain('テスト団体A')
    expect(String(issued.after)).not.toContain('sha256')
  })

  it('有効期限は14日。1回だけ使え、期限を過ぎたら・取り消したら使えない(理由は区別しない)', () => {
    const t = ready()
    const session = t.login('a1').result.session.token
    const issue = (orgName: string) => t.post({ action: 'issueRegistrationCode', session, orgName }).result
    const now = Date.now()
    // 団体の登録(registerOrg)でコードを使う
    let n = 0
    const use = (code: string, at: number) => {
      n++
      return (t.gas.registerOrg_ as (b: object, at: number) => { ok: boolean })({
        code, orgId: 'org_' + String(n).padStart(20, 'A'), gasUrl: `https://script.google.com/macros/s/ORG${n}/exec`,
        registerNonce: `register-nonce-${n}-abcdefghijklmnopqrstuvwxyz0123456789`,
      }, at)
    }
    const a = issue('団体A')
    expect(Date.parse(a.expiresAt) - now).toBeGreaterThan(14 * DAY - 60_000)
    expect(Date.parse(a.expiresAt) - now).toBeLessThanOrEqual(14 * DAY + 1000)

    // 1回だけ(小文字・区切りなしでも同じコード)
    expect(use(a.code.toLowerCase().replace(/-/g, ''), now).ok).toBe(true)
    expect(() => use(a.code, now)).toThrow(/使えなくなっています/)

    // 14日を過ぎたら使えない(14日ちょうどの直前までは使える)
    const b = issue('団体B')
    const bExp = Date.parse(b.expiresAt)
    expect(() => use(b.code, bExp)).toThrow(/使えなくなっています/)
    expect(use(b.code, bExp - 1).ok).toBe(true)

    // 取り消したら使えない
    const c = issue('団体C')
    const revoked = t.post({ action: 'revokeRegistrationCode', session, codeId: c.codeId, reason: '契約の取りやめ' })
    expect(revoked.ok).toBe(true)
    expect(() => use(c.code, now)).toThrow(/使えなくなっています/)

    // 無いコードも同じエラー
    expect(() => use('AAAA-BBBB-CCCC-DDDD', now)).toThrow(/使えなくなっています/)
  })

  it('一覧には状態(未使用・使用済み・期限切れ・取り消し済み)が出て、ハッシュは出ない。未使用のものだけ取り消せる', () => {
    const t = ready()
    const session = t.login('a1').result.session.token
    const issue = (orgName: string) => t.post({ action: 'issueRegistrationCode', session, orgName }).result
    const now = Date.now()
    const used = issue('使用済みの団体')
    ;(t.gas.registerOrg_ as (b: object, at: number) => unknown)({ code: used.code, orgId: 'org_USEDUSEDUSEDUSEDUSED', gasUrl: 'https://script.google.com/macros/s/USED/exec', registerNonce: 'register-nonce-used-abcdefghijklmnopqrstuvwxyz0123456789' }, now)
    const toRevoke = issue('取り消す団体')
    t.post({ action: 'revokeRegistrationCode', session, codeId: toRevoke.codeId })
    const unused = issue('未使用の団体')
    const expired = issue('期限切れの団体')
    const headers = t.codesSheet().rows[0] as string[]
    const expiredRow = t.codesSheet().rows.find((r) => r[headers.indexOf('code_id')] === expired.codeId)!
    expiredRow[headers.indexOf('expires_at')] = new Date(now - 1000).toISOString()

    const overview = t.post({ action: 'adminOverview', session })
    const states = Object.fromEntries(overview.result.codes.map((c: { orgName: string; state: string }) => [c.orgName, c.state]))
    expect(states).toEqual({ 使用済みの団体: 'used', 取り消す団体: 'revoked', 未使用の団体: 'unused', 期限切れの団体: 'expired' })
    expect(JSON.stringify(overview.result.codes)).not.toContain('sha256')

    for (const c of [used, toRevoke, expired]) {
      expect(t.post({ action: 'revokeRegistrationCode', session, codeId: c.codeId }).error).toMatch(/未使用のコードだけ/)
    }
    expect(t.post({ action: 'revokeRegistrationCode', session, codeId: unused.codeId }).ok).toBe(true)
    const revokes = t.audit().filter((a) => a.action === 'revokeRegistrationCode')
    expect(revokes).toHaveLength(2)
    expect(revokes[0].actor).toBe('admin.one@example.com')
  })

  it('団体名は必須。発行は5分以内に Google でログインしたセッションだけ(古ければログインし直し)', () => {
    const t = ready()
    const session = t.login('a1').result.session.token
    expect(t.post({ action: 'issueRegistrationCode', session, orgName: '  ' }).error).toMatch(/団体名/)
    expect(t.post({ action: 'issueRegistrationCode', session, orgName: 'A', contactEmail: 'not-an-email' }).error).toMatch(/メールアドレス/)
    expect(() => t.gas.issueRegistrationCode_({ session, orgName: 'A' }, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(t.codesSheet().rows).toHaveLength(1) // 見出しだけ
  })

  it('スプレッドシートに書く文字列は、数式として扱われない', () => {
    const t = ready()
    const session = t.login('a1').result.session.token
    t.post({ action: 'issueRegistrationCode', session, orgName: '=IMPORTXML("x")', note: '+1' })
    const row = t.codesSheet().rows[1] as string[]
    expect(row).toContain("'=IMPORTXML(\"x\")")
    expect(row).toContain("'+1")
  })
})

describe('団体の一覧', () => {
  it('状態(有効・停止予定・停止)と、確認が7日以上無い印を分けて出す', () => {
    const t = ready()
    const now = Date.parse('2026-10-01T00:00:00Z')
    const s = (values: Record<string, string>) => t.gas.orgDisplayState_(values, now)
    expect(s({ status: 'active', last_check_at: '2026-09-30T00:00:00Z' })).toEqual({ state: 'active', checkState: 'ok' })
    expect(s({ status: 'active', suspend_at: '2026-10-14T00:00:00Z', last_check_at: '2026-09-20T00:00:00Z' })).toEqual({ state: 'scheduled', checkState: 'stale' })
    expect(s({ status: 'active', suspend_at: '2026-09-30T00:00:00Z' })).toEqual({ state: 'suspended', checkState: 'never' })
    expect(s({ status: 'suspended', last_check_at: '2026-09-24T00:00:01Z' })).toEqual({ state: 'suspended', checkState: 'ok' })
  })

  it('一覧に、契約の状態・最後の確認・登録日・接続先・停止の予定を含める(秘密は含めない)', () => {
    const t = ready()
    const orgs = t.sheets.get('Orgs')!
    const headers = orgs.rows[0] as string[]
    const row = headers.map(() => '')
    const set = (k: string, v: string) => { row[headers.indexOf(k)] = v }
    set('org_id', 'org_x'); set('display_name', 'テスト団体X'); set('status', 'active'); set('contract_status', 'active')
    set('created_at', '2026-09-01T00:00:00Z'); set('last_check_at', '2026-09-30T00:00:00Z'); set('gas_url', 'https://script.google.com/macros/s/X/exec')
    orgs.rows.push(row)
    t.sheets.get('Secrets')!.rows.push(['org_x', 'SECRET-KEY-VALUE', '1', ''])
    const session = t.login('a1').result.session.token
    const res = t.post({ action: 'adminOverview', session })
    expect(res.result.orgs).toEqual([expect.objectContaining({ orgId: 'org_x', displayName: 'テスト団体X', contractStatus: 'active', createdAt: '2026-09-01T00:00:00Z', lastCheckAt: '2026-09-30T00:00:00Z', gasUrl: 'https://script.google.com/macros/s/X/exec', state: 'active' })])
    expect(JSON.stringify(res)).not.toContain('SECRET-KEY-VALUE')
    expect(res.result.me.email).toBe('admin.one@example.com')
    // 最近の操作の記録(新しい順)
    expect(res.result.audit[0]).toMatchObject({ action: 'adminLogin', actor: 'admin.one@example.com' })
  })
})
