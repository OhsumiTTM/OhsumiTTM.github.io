// レジストリ(registry/Code.gs)の R1-c: 団体の登録(registerOrg)・再登録コード・総当たりの対策を確かめる
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const DAY = 24 * 3600 * 1000
const secretFor = (name: string) => `nonce-secret-${name}-0123456789`
const nonceOf = (secret: string) => 'registry-admin.' + createHash('sha256').update(secret).digest('base64url')
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const ORG_B = 'org_BBBBBBBBBBBBBBBBBBBB'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const URL_A2 = 'https://script.google.com/macros/s/AKfyA2/exec'
const URL_B = 'https://script.google.com/macros/s/AKfyB/exec'
// 団体の GAS が作ってスクリプトプロパティに保存する乱数(registerNonce。43文字以上)
const REQ = (n: number) => `register-nonce-${String(n).padStart(8, '0')}-abcdefghijklmnopqrstu`

function ready() {
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(Math.floor(Date.now() / 1000) + 3600), iat: String(Math.floor(Date.now() / 1000)), nonce: nonceOf(secretFor('a1')),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secretFor('a1') }).result.session.token
  const issue = (extra: Record<string, unknown> = {}) =>
    t.post({ action: 'issueRegistrationCode', session, orgName: 'テスト団体A', contactName: '山田', contactEmail: 'yamada@example.org', ...extra })
  type RegisterResult = { ok: boolean; result?: Record<string, unknown>; replayed?: boolean; error?: string }
  const register = (body: Record<string, unknown>, now = Date.now()): RegisterResult => {
    try {
      return (t.gas.registerOrg_ as (b: object, n: number) => RegisterResult)(body, now)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  const rows = (name: string) => t.sheets.get(name)!.rows
  const audit = () => rows('AuditLog').slice(1).map((r) => ({ actor: r[1], action: r[2], target: r[3], before: r[4], after: r[5] }))
  return { ...t, session, issue, register, rows, audit }
}

describe('団体の登録(registerOrg)', () => {
  it('登録コードで団体を登録し、共有鍵を受け取る。団体・担当者・共有鍵を保存し、操作の記録に残す', () => {
    const t = ready()
    const code = t.issue().result.code
    const res = t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: URL_A, gasVersion: 'r1c-1', registerNonce: REQ(1) })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ orgId: ORG_A, keyGen: 1, displayName: 'テスト団体A', kind: 'new' })
    expect(String(res.result.registryKey).length).toBeGreaterThanOrEqual(64)
    expect(t.rows('Orgs').filter((r) => r[0] === ORG_A)).toHaveLength(1)
    const org = t.rows('Orgs').find((r) => r[0] === ORG_A)!
    expect(org.slice(0, 5)).toEqual([ORG_A, URL_A, 'active', 'standard', 'テスト団体A'])
    expect(t.rows('Contacts').slice(1)).toEqual([[ORG_A, '山田', 'yamada@example.org', '']])
    expect(t.rows('Secrets').slice(1).map((r) => [r[0], r[2]])).toEqual([[ORG_A, 1]])
    expect(t.audit()).toContainEqual(expect.objectContaining({ actor: 'org:' + ORG_A, action: 'registerOrg', target: ORG_A }))
    // 管理画面の一覧に出る(共有鍵は出さない)
    const overview = t.post({ action: 'adminOverview', session: t.session })
    expect(overview.result.orgs).toContainEqual(expect.objectContaining({ orgId: ORG_A, displayName: 'テスト団体A', gasUrl: URL_A, state: 'active', checkState: 'never' }))
    expect(JSON.stringify(overview)).not.toContain(res.result.registryKey)
    // 記録の無い変更として監視に知らされない(指紋を覚えている)
    expect((t.gas.findUnrecordedOrgEdits_ as () => string[])()).toEqual([])
  })

  it('登録コードは1回だけ使える。ほかの団体・別の登録(別の registerNonce)では使えない', () => {
    const t = ready()
    const code = t.issue().result.code
    expect(t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }).ok).toBe(true)
    const again = t.register({ code, orgId: ORG_B, gasUrl: URL_B, registerNonce: REQ(2) })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/使えなくなっています/)
    expect(t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(3) }).ok).toBe(false)
    expect(t.rows('Orgs').slice(1)).toHaveLength(1)
  })

  it('期限切れ(14日を過ぎた)・取り消し済み・無いコードでは登録できない(理由は区別しない)', () => {
    const t = ready()
    const now = Date.now()
    const expired = t.issue().result.code
    const late = t.register({ code: expired, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now + 14 * DAY + 60_000)
    expect(late.ok).toBe(false)
    const revoked = t.issue().result
    expect(t.post({ action: 'revokeRegistrationCode', session: t.session, codeId: revoked.codeId, reason: 'テスト' }).ok).toBe(true)
    const r2 = t.register({ code: revoked.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(2) }, now)
    const r3 = t.register({ code: 'AAAA-BBBB-CCCC-DDDD', orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(3) }, now)
    expect([late.error, r2.error, r3.error].every((e) => e === late.error && /使えなくなっています/.test(String(e)))).toBe(true)
    expect(t.rows('Orgs').slice(1)).toHaveLength(0)
  })

  it('通信が途中で失われて送り直した時(同じ registerNonce・同じコード)は、同じ結果(同じ共有鍵)を返し、二重に登録しない', () => {
    const t = ready()
    const code = t.issue().result.code
    const body = { action: 'registerOrg', code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }
    const first = t.post(body)
    const second = t.post(body)
    const third = t.post({ ...body, code: code.toLowerCase().replace(/-/g, ' ') })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: true, replayed: true })
    expect(second.result).toEqual(first.result)
    expect(third.result).toEqual(first.result)
    expect(t.rows('Orgs').slice(1)).toHaveLength(1)
    expect(t.rows('Secrets').slice(1)).toHaveLength(1)
    expect(t.audit().filter((a) => a.action === 'registerOrg')).toHaveLength(1)
  })

  it('送り直しは、コードを持っている時だけ・登録から24時間までだけ受け付ける', () => {
    const t = ready()
    const now = Date.now()
    const code = t.issue().result.code
    expect(t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now).ok).toBe(true)
    // registerNonce だけ知っていても、コードが違えば受け付けない
    expect(t.register({ code: 'AAAA-BBBB-CCCC-DDDD', orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now).ok).toBe(false)
    expect(t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now + 25 * 3600 * 1000).ok).toBe(false)
  })

  it('使用済みの登録コードを手に入れても、登録の時の registerNonce が合わなければ共有鍵を受け取れない(ほかの失敗と同じエラー)', () => {
    const t = ready()
    const now = Date.now()
    const code = t.issue().result.code
    const first = t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now)
    expect(first.ok).toBe(true)
    const invalid = t.register({ code: 'AAAA-BBBB-CCCC-DDDD', orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(9) }, now).error
    expect(invalid).toMatch(/使えなくなっています/)
    const failsBefore = Number(t.cache.get('regfail:' + Math.floor(now / 3600_000)) ?? 0)
    const attempts = [
      // 同じ団体ID・同じコード・違う registerNonce(24時間以内)
      t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(2) }, now + 60_000),
      // 別の接続先を名乗っても同じ
      t.register({ code, orgId: ORG_A, gasUrl: URL_B, registerNonce: REQ(3) }, now + 60_000),
      // registerNonce は合っていても、団体ID が違う
      t.register({ code, orgId: ORG_B, gasUrl: URL_B, registerNonce: REQ(1) }, now + 60_000),
      // registerNonce・団体ID・コードが合っていても、登録から24時間を過ぎた
      t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now + 24 * 3600_000 + 60_000),
    ]
    for (const a of attempts) {
      expect(a.ok).toBe(false)
      expect(a.error).toBe(invalid)
      expect(JSON.stringify(a)).not.toContain(String(first.result!.registryKey))
    }
    // 総当たりの失敗として数える(24時間後の1回は別の時間帯)
    expect(Number(t.cache.get('regfail:' + Math.floor(now / 3600_000)))).toBe(failsBefore + 3)
    // 登録は変わらない(共有鍵・接続先・鍵の世代)
    expect(t.rows('Secrets').slice(1).map((r) => [r[0], String(r[1]).replace(/^'/, ''), r[2]])).toEqual([[ORG_A, first.result!.registryKey, 1]])
    expect(t.rows('Orgs').slice(1).map((r) => [r[0], r[1]])).toEqual([[ORG_A, URL_A]])
    // 合っている送り直しは、24時間以内なら同じ結果
    expect(t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now + 23 * 3600_000)).toMatchObject({ ok: true, replayed: true, result: first.result })
  })

  it('レジストリは registerNonce そのものを保存しない(SHA-256 だけ)', () => {
    const t = ready()
    expect(t.register({ code: t.issue().result.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }).ok).toBe(true)
    const everything = JSON.stringify([...t.sheets.values()].map((sh) => sh.rows)) + t.logs.join('\n')
    expect(everything).not.toContain(REQ(1))
    expect(t.rows('Secrets')[0]).toContain('register_nonce_hash')
    expect(String(t.rows('Secrets')[1][4])).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('新しい団体の登録コードで、登録済みの団体を登録し直そうとした時は、再登録コードを使うよう知らせる(コードは使わない)', () => {
    const t = ready()
    expect(t.register({ code: t.issue().result.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }).ok).toBe(true)
    const code2 = t.issue().result
    const res = t.register({ code: code2.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(2) })
    expect(res.error).toMatch(/登録済み/)
    expect(t.post({ action: 'adminOverview', session: t.session }).result.codes.find((c: { codeId: string }) => c.codeId === code2.codeId).state).toBe('unused')
  })

  it('形の違う団体ID・接続先の URL は受け付けない', () => {
    const t = ready()
    const code = t.issue().result.code
    expect(t.register({ code, orgId: 'org_short', gasUrl: URL_A, registerNonce: REQ(1) }).error).toMatch(/団体ID/)
    for (const bad of [
      'https://script.google.com/macros/u/1/s/AKfyA/exec',
      'https://script.google.com/macros/s/AKfyA/dev',
      'https://script.google.com/a/macros/example.org/s/AKfyA/exec',
      'https://script.google.com/macros/s/AKfyA/exec?x=1',
      'https://script.google.com/macros/s/AKfyA/exec/',
      'http://script.google.com/macros/s/AKfyA/exec',
    ]) expect(t.register({ code, orgId: ORG_A, gasUrl: bad, registerNonce: REQ(1) }).error, bad).toMatch(/URL/)
    expect(t.register({ code, orgId: ORG_A, gasUrl: URL_A, registerNonce: 'short-nonce-0123456789' }).error).toMatch(/形/)
  })
})

describe('再登録コード(共有鍵が漏れた時の作り直し・接続先の変更)', () => {
  it('管理画面で登録済みの団体を選んで発行し、その団体が使うと新しい共有鍵に入れ替わる。接続先も新しくなる', () => {
    const t = ready()
    const first = t.register({ code: t.issue().result.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) })
    const re = t.issue({ kind: 'reissue', targetOrgId: ORG_A, orgName: '無視される名前' })
    expect(re.ok, JSON.stringify(re)).toBe(true)
    expect(re.result).toMatchObject({ kind: 'reissue', targetOrgId: ORG_A, orgName: 'テスト団体A' })
    // ほかの団体では使えない
    expect(t.register({ code: re.result.code, orgId: ORG_B, gasUrl: URL_B, registerNonce: REQ(2) }).ok).toBe(false)
    const second = t.register({ code: re.result.code, orgId: ORG_A, gasUrl: URL_A2, registerNonce: REQ(3) })
    expect(second.ok, JSON.stringify(second)).toBe(true)
    expect(second.result).toMatchObject({ orgId: ORG_A, keyGen: 2, kind: 'reissue' })
    expect(second.result!.registryKey).not.toBe(first.result!.registryKey)
    expect(t.rows('Secrets').slice(1).map((r) => [r[0], String(r[1]).replace(/^'/, ''), r[2]])).toEqual([[ORG_A, second.result!.registryKey, 2]])
    expect(t.rows('Orgs').slice(1).map((r) => r[1])).toEqual([URL_A2])
    expect(t.audit()).toContainEqual(expect.objectContaining({ action: 'reregisterOrg', target: ORG_A }))
    expect((t.gas.findUnrecordedOrgEdits_ as () => string[])()).toEqual([])
  })

  it('登録されていない団体向けの再登録コードは発行できない', () => {
    const t = ready()
    const res = t.issue({ kind: 'reissue', targetOrgId: ORG_B })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/見つかりません/)
  })
})

describe('登録コードの総当たりの対策', () => {
  it('コードが違う登録が1時間に30回を超えたら、その1時間は正しいコードでも登録を受け付けない', () => {
    const t = ready()
    const now = Date.now()
    const good = t.issue().result.code
    for (let i = 0; i < 30; i++) {
      expect(t.register({ code: `WRNG-${String(i).padStart(4, 'A')}-CCCC-DDDD`, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(100 + i) }, now).ok).toBe(false)
    }
    const blocked = t.register({ code: good, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now)
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toMatch(/しばらく登録を受け付けていません/)
    // 監視の「断ったリクエスト」にも数える
    expect((t.gas.rejectedCount_ as (n: number) => number)(now)).toBeGreaterThan(0)
    // 次の1時間には登録できる
    expect(t.register({ code: good, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) }, now + 3600 * 1000).ok).toBe(true)
  })

  it('登録の問い合わせは1分に10回まで(レジストリ全体)', () => {
    const t = ready()
    const results = Array.from({ length: 12 }, (_, i) => t.post({ action: 'registerOrg', code: 'AAAA-BBBB-CCCC-DDDD', orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(i) }))
    expect(results.slice(0, 10).every((r) => !r.retryLater)).toBe(true)
    expect(results.slice(10).every((r) => r.retryLater === true)).toBe(true)
  })
})

describe('共有鍵・登録コードを残さない', () => {
  it('共有鍵と登録コードは、操作の記録・実行ログ・管理画面の一覧に元の形で出ない', () => {
    const t = ready()
    const issued = t.issue().result
    const res = t.post({ action: 'registerOrg', code: issued.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(1) })
    const re = t.issue({ kind: 'reissue', targetOrgId: ORG_A })
    const res2 = t.post({ action: 'registerOrg', code: re.result.code, orgId: ORG_A, gasUrl: URL_A, registerNonce: REQ(2) })
    const secrets = [res.result.registryKey, res2.result.registryKey, issued.code, issued.code.replace(/-/g, ''), re.result.code.replace(/-/g, '')]
    const overview = JSON.stringify(t.post({ action: 'adminOverview', session: t.session }))
    const places = { audit: JSON.stringify(t.rows('AuditLog')), logs: t.logs.join('\n'), overview }
    for (const [where, text] of Object.entries(places)) {
      for (const s of secrets) expect(text, where).not.toContain(s)
    }
    // 登録コードはハッシュだけ
    expect(JSON.stringify(t.rows('RegistrationCodes'))).not.toContain(issued.code.replace(/-/g, ''))
  })
})
