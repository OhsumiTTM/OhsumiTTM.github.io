// レジストリからログインを一斉に切る(v1.2): 管理画面で全団体・1つの団体のログインを切ると、checkIn の返事の sessionsRevoke で伝わり、
// 団体の GAS はそれより前のログインを無効にする(securityRelogin で「セキュリティ保護のため…」をログイン画面に出す)。
// 代表には理由を書いたメールで1回だけ知らせる。理由は必須・5分以内のログインが必要・操作の記録に残る
import { beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type Org, type World } from './e2e/world'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('レジストリからログインを一斉に切る', () => {
  let w: World
  let A: ReturnType<World['launchOrg']>
  let B: ReturnType<World['launchOrg']>
  let topA = ''
  let topB = ''
  beforeEach(() => {
    w = createWorld()
    A = w.launchOrg('団体A', 'contact@a.example')
    B = w.launchOrg('団体B', 'contact@b.example')
    topA = w.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode }).result.session.token
    topB = w.googleLogin(B.org, 'top@b.example', { setupCode: B.setupCode }).result.session.token
  })
  const revoke = (target: Record<string, unknown>, reason = '端末の紛失') => w.reg.post({ action: 'revokeSessions', session: w.adminSession, ...target, reason })
  // 書き込みの前の確かめ直し(10分に1回まで)の間隔を過ぎたことにして、レジストリに確かめ直させる
  const recheck = (org: Org, token: string) => {
    org.cache.delete('contract:recheck')
    return w.call(org, token, 'updateDisplayName', { memberId: w.googleLogin(org, org === A.org ? 'top@a.example' : 'top@b.example').result.memberId, displayName: '代表' })
  }
  const read = (org: Org, token: string) => w.call(org, token, 'getInitialData')

  it('1つの団体のログインを切ると、その団体だけ前のログインが無効になり、理由をログイン画面に出す。ログインし直せる', async () => {
    await sleep(1100)
    const res = revoke({ scope: 'org', orgId: A.orgId })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ orgId: A.orgId, sessionsRevokeReason: '端末の紛失' })
    recheck(A.org, topA)
    recheck(B.org, topB)
    const denied = read(A.org, topA)
    expect(denied).toMatchObject({ ok: false, authError: true, securityRelogin: true, error: 'セキュリティ保護のため、もう一度ログインしてください。' })
    expect(read(B.org, topB).ok).toBe(true)
    // ログインし直したトークンは使える
    const again = w.googleLogin(A.org, 'top@a.example').result.session.token
    expect(read(A.org, again).ok).toBe(true)
    // 操作の記録に残る
    const overview = w.reg.post({ action: 'adminOverview', session: w.adminSession }).result
    expect(overview.audit[0]).toMatchObject({ action: 'revokeSessions', target: A.orgId, reason: '端末の紛失' })
  })

  it('代表には、理由を書いたメールで1回だけ知らせる', async () => {
    await sleep(1100)
    revoke({ scope: 'org', orgId: A.orgId }, '鍵の漏れの疑い')
    recheck(A.org, topA)
    const before = A.org.mails.length
    expect((A.org.gas.sendSessionsRevokeMail_ as () => boolean)()).toBe(true)
    const mail = A.org.mails[A.org.mails.length - 1]
    expect(mail.to).toContain('top@a.example')
    expect(mail.subject).toContain('セキュリティ保護のため')
    expect(mail.body).toContain('理由: 鍵の漏れの疑い')
    expect((A.org.gas.sendSessionsRevokeMail_ as () => boolean)()).toBe(false)
    expect(A.org.mails.length).toBe(before + 1)
    // 切っていない団体には送らない
    expect((B.org.gas.sendSessionsRevokeMail_ as () => boolean)()).toBe(false)
  })

  it('全団体のログインを切ると、どの団体の前のログインも無効になる', async () => {
    await sleep(1100)
    expect(revoke({ scope: 'global' }).ok).toBe(true)
    recheck(A.org, topA)
    recheck(B.org, topB)
    expect(read(A.org, topA)).toMatchObject({ ok: false, securityRelogin: true })
    expect(read(B.org, topB)).toMatchObject({ ok: false, securityRelogin: true })
    const overview = w.reg.post({ action: 'adminOverview', session: w.adminSession }).result
    expect(overview.sessionsRevoke).toMatchObject({ globalReason: '端末の紛失' })
    expect(overview.sessionsRevoke.globalRevokedAt).not.toBe('')
  })

  it('理由が無い・5分より前のログインの時は断り、何も切らない', () => {
    expect(revoke({ scope: 'global' }, '').ok).toBe(false)
    const body = { session: w.adminSession, scope: 'global', reason: 'x' }
    expect(() => (w.reg.gas.revokeSessions_ as (b: object, n: number) => unknown)(body, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(w.reg.post({ action: 'adminOverview', session: w.adminSession }).result.sessionsRevoke.globalRevokedAt).toBe('')
    recheck(A.org, topA)
    expect(read(A.org, topA).ok).toBe(true)
  })

  it('団体の GAS は、無効にする時刻を前にしか進めない。今より後の時刻は今に収める', () => {
    const apply = A.org.gas.applyRegistrySessionsRevoke_ as (r: unknown, nowMs: number) => boolean
    const now = Date.now()
    const nowSec = Math.floor(now / 1000)
    expect(apply({ at: nowSec + 3600, reason: '未来' }, now)).toBe(true)
    expect(Number(A.org.props.SESSION_NOT_BEFORE)).toBe(nowSec)
    expect(apply({ at: nowSec - 3600, reason: '過去' }, now)).toBe(false)
    expect(Number(A.org.props.SESSION_NOT_BEFORE)).toBe(nowSec)
    expect(apply(null, now)).toBe(false)
    expect(apply({ at: 'x' }, now)).toBe(false)
  })
})
