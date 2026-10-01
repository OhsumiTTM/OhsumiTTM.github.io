// レジストリ(registry/Code.gs)の定量データ(PR N): 団体の GAS が週1回送る集計値(reportMetrics)と、checkIn のプラン
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'

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
  const code = t.post({ action: 'issueRegistrationCode', session, orgName: '団体A', contactName: '山田', contactEmail: 'yamada@example.org' }).result.code
  const reg = t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: URL_A, registerNonce: 'register-nonce-00000001-abcdefghijklmnopqrstuvwxyz0123' })
  const key = String(reg.result.registryKey)
  const report = (period: string, metrics: Record<string, unknown>, opts: { key?: string; ts?: number } = {}) => {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', opts.key ?? key).update('metrics.' + ORG_A + '.' + ts + '.' + period + '.' + JSON.stringify(metrics)).digest('base64url')
    return t.post({ action: 'reportMetrics', orgId: ORG_A, ts, period, metrics, sig })
  }
  const usage = () => t.sheets.get('Usage')!.rows.slice(1)
  return { ...t, session, key, report, usage }
}

describe('reportMetrics', () => {
  it('署名の合う集計値を受け付け、同じ期間の送り直しは1件として上書きする', () => {
    const t = ready()
    expect(t.report('2026-09-28', { version: 1, members: 10, tasks: 40 }).result).toEqual({ period: '2026-09-28', stored: 'new' })
    expect(t.report('2026-09-28', { version: 1, members: 11, tasks: 41 }).result).toEqual({ period: '2026-09-28', stored: 'updated' })
    expect(t.report('2026-10-05', { version: 1, members: 12 }).result.stored).toBe('new')
    const rows = t.usage()
    expect(rows).toHaveLength(2)
    expect(JSON.parse(String(rows[0][2]))).toEqual({ members: 11, tasks: 41 })
    expect(rows[0][3]).toBe(1)
  })

  it('知らない項目・負の数・数でない値は捨てる(個人の情報を置く場所を作らない)', () => {
    const t = ready()
    t.report('2026-09-28', { version: 1, members: 3, names: ['山田'], email: 'a@b.c', tasks: -1, projects: 'x', active_7d: 2.7 })
    expect(JSON.parse(String(t.usage()[0][2]))).toEqual({ members: 3, active_7d: 2 })
  })

  it('署名が違う・時刻がずれている・期間の形が違うものは断る', () => {
    const t = ready()
    expect(t.report('2026-09-28', { members: 1 }, { key: 'wrong' })).toMatchObject({ ok: false, authError: true })
    expect(t.report('2026-09-28', { members: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 })).toMatchObject({ ok: false })
    expect(t.report('2026/09/28', { members: 1 })).toMatchObject({ ok: false })
    expect(t.sheets.get('Usage')!.rows.length).toBe(1)
  })

  it('checkIn で、団体のプランを伝える', () => {
    const t = ready()
    const checkIn = () => {
      const ts = Math.floor(Date.now() / 1000)
      return t.post({ action: 'checkIn', orgId: ORG_A, ts, gasVersion: '2026.10.01-9', sig: createHmac('sha256', t.key).update('checkIn.' + ORG_A + '.' + ts).digest('base64url') })
    }
    expect(checkIn().result.plan).toBe('')
    expect(t.post({ action: 'setOrgPlan', session: t.session, orgId: ORG_A, plan: 'ohsumi', reason: 'テスト' }).ok).toBe(true)
    expect(checkIn().result.plan).toBe('ohsumi')
  })
})
