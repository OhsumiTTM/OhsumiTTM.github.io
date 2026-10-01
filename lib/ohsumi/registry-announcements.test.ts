// レジストリ(registry/Code.gs)のお知らせ(PR P): 全団体・プラン別・団体別に出す・取り下げ・掲載の終わり・
// 団体の GAS が共有鍵の署名で取りに来る(fetchAnnouncements)
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const ORG_B = 'org_BBBBBBBBBBBBBBBBBBBB'
const DAY = 24 * 3600 * 1000

function ready() {
  const secret = 'nonce-secret-a1-0123456789'
  const now = Math.floor(Date.now() / 1000)
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(now + 3600), iat: String(now), nonce: 'registry-admin.' + createHash('sha256').update(secret).digest('base64url'),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const keys: Record<string, string> = {}
  ;[ORG_A, ORG_B].forEach((orgId, i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, orgName: '団体' + i }).result.code
    const reg = t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' })
    keys[orgId] = String(reg.result.registryKey)
  })
  const plan = (orgId: string, p: string) => t.post({ action: 'setOrgPlan', session, orgId, plan: p, reason: '' })
  const publish = (extra: Record<string, unknown> = {}) =>
    t.post({ action: 'publishAnnouncement', session, title: 'メンテナンスのお知らせ', body: '10月10日の夜に\nメンテナンスをします。', importance: 'normal', target: { kind: 'all' }, ...extra })
  const fetchFor = (orgId: string, opts: { key?: string; ts?: number } = {}) => {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000)
    return t.post({ action: 'fetchAnnouncements', orgId, ts, sig: createHmac('sha256', opts.key ?? keys[orgId]).update('announcements.' + orgId + '.' + ts).digest('base64url') })
  }
  const titles = (orgId: string) => fetchFor(orgId).result.announcements.map((a: { title: string }) => a.title)
  return { ...t, session, plan, publish, fetchFor, titles }
}

describe('お知らせ', () => {
  it('全団体に出し、団体の GAS が署名で取りに来る。本文の改行は残す。操作の記録に残る', () => {
    const t = ready()
    const res = t.publish({ importance: 'urgent' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ importance: 'urgent', state: 'active', targetKind: 'all', createdBy: 'admin@example.com' })
    // 省いた時の掲載の終わりは30日後
    expect(Date.parse(res.result.expiresAt) - Date.now()).toBeGreaterThan(29 * DAY)
    const got = t.fetchFor(ORG_A).result.announcements
    expect(got).toEqual([expect.objectContaining({ title: 'メンテナンスのお知らせ', body: '10月10日の夜に\nメンテナンスをします。', importance: 'urgent' })])
    expect(t.titles(ORG_B)).toEqual(['メンテナンスのお知らせ'])
    expect(t.post({ action: 'adminOverview', session: t.session }).result.announcements).toHaveLength(1)
    expect(t.sheets.get('AuditLog')!.rows.some((r) => r[2] === 'publishAnnouncement')).toBe(true)
  })

  it('プラン別・団体別に出せる。プラン別は、団体の今のプランで決める', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    t.plan(ORG_B, 'paid')
    expect(t.publish({ title: 'Ohsumi向け', target: { kind: 'plan', plan: 'ohsumi' } }).ok).toBe(true)
    expect(t.publish({ title: 'B向け', target: { kind: 'orgs', orgIds: [ORG_B] } }).ok).toBe(true)
    expect(t.titles(ORG_A)).toEqual(['Ohsumi向け'])
    expect(t.titles(ORG_B)).toEqual(['B向け'])
    t.plan(ORG_B, 'ohsumi')
    expect(t.titles(ORG_B).sort()).toEqual(['B向け', 'Ohsumi向け'])
  })

  it('取り下げたもの・掲載の終わりを過ぎたものは出さない', () => {
    const t = ready()
    const a = t.publish({ title: '取り下げる' }).result
    t.publish({ title: '残る' })
    expect(t.post({ action: 'withdrawAnnouncement', session: t.session, announcementId: a.announcementId, reason: '誤り' }).result.state).toBe('withdrawn')
    expect(t.titles(ORG_A)).toEqual(['残る'])
    expect(t.post({ action: 'withdrawAnnouncement', session: t.session, announcementId: a.announcementId }).error).toContain('取り下げ済み')
    // 掲載の終わりを過ぎた
    const rows = t.sheets.get('Announcements')!.rows
    const h = rows[0] as string[]
    rows.slice(1).forEach((r) => { r[h.indexOf('expires_at')] = new Date(Date.now() - 1000).toISOString() })
    expect(t.titles(ORG_A)).toEqual([])
    expect(t.post({ action: 'adminOverview', session: t.session }).result.announcements.map((x: { state: string }) => x.state).sort()).toEqual(['expired', 'withdrawn'])
  })

  it('入力の形が違うもの・署名の違う取りに来たものは断る', () => {
    const t = ready()
    expect(t.publish({ title: '' }).error).toContain('題')
    expect(t.publish({ body: '' }).error).toContain('本文')
    expect(t.publish({ body: 'あ'.repeat(1001) }).error).toContain('1000文字')
    expect(t.publish({ importance: 'critical' }).error).toContain('重要度')
    expect(t.publish({ target: { kind: 'orgs', orgIds: ['org_unknown'] } }).error).toContain('見つからない')
    expect(t.publish({ expiresAt: new Date(Date.now() - DAY).toISOString() }).error).toContain('今より後')
    expect(t.publish({ expiresAt: new Date(Date.now() + 400 * DAY).toISOString() }).error).toContain('365日以内')
    expect(t.fetchFor(ORG_A, { key: 'wrong' })).toMatchObject({ ok: false, authError: true })
    expect(t.fetchFor(ORG_A, { ts: Math.floor(Date.now() / 1000) - 3600 })).toMatchObject({ ok: false })
  })
})
