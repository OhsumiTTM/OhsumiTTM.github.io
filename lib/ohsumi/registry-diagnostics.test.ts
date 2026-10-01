// レジストリ(registry/Code.gs)の診断情報(PR Q): 署名の確かめ・受付番号・送り直し・1日の上限・メールアドレスを残さない
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'

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
  const code = t.post({ action: 'issueRegistrationCode', session, orgName: '団体A' }).result.code
  const key = String(t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: 'https://script.google.com/macros/s/AKfyA/exec', registerNonce: 'register-nonce-00000001-abcdefghijklmnopqrstuvwxyz0123' }).result.registryKey)
  const send = (diagId: string, diag: unknown, opts: { key?: string } = {}) => {
    const ts = Math.floor(Date.now() / 1000)
    const text = typeof diag === 'string' ? diag : JSON.stringify(diag)
    const sig = createHmac('sha256', opts.key ?? key).update('diagnostics.' + ORG_A + '.' + ts + '.' + diagId + '.' + text).digest('base64url')
    return t.post({ action: 'receiveDiagnostics', orgId: ORG_A, ts, diagId, diagnostics: text, sig })
  }
  return { ...t, session, send }
}

describe('receiveDiagnostics', () => {
  it('受付番号を返し、同じ診断ID の送り直しは同じ受付番号。管理画面で受付番号から中身を見られる', () => {
    const t = ready()
    const a = t.send('dg_abcdefgh01', { version: '2026.10.01-13', note: 'contact me at x@example.com' })
    expect(a.ok, JSON.stringify(a)).toBe(true)
    expect(a.result.receiptNo).toMatch(/^D\d{6}-[A-Z0-9]{4}$/)
    expect(t.send('dg_abcdefgh01', { version: '2026.10.01-13' }).result).toMatchObject({ receiptNo: a.result.receiptNo, duplicate: true })
    const report = t.post({ action: 'getDiagnosticsReport', session: t.session, receiptNo: a.result.receiptNo })
    expect(report.result).toMatchObject({ orgId: ORG_A, orgName: '団体A', gasVersion: '2026.10.01-13', diagnostics: { note: 'contact me at (メールアドレス)' } })
    expect(t.post({ action: 'getDiagnosticsReport', session: t.session, receiptNo: 'D000000-ZZZZ' }).error).toContain('見つかりません')
    expect(t.post({ action: 'getDiagnosticsReport', session: 'bad', receiptNo: a.result.receiptNo })).toMatchObject({ ok: false, authError: true })
  })

  it('署名が違う・形が違う・大きすぎるものは断る。1団体1日20件まで', () => {
    const t = ready()
    expect(t.send('dg_abcdefgh01', { a: 1 }, { key: 'wrong' })).toMatchObject({ ok: false, authError: true })
    expect(t.send('bad', { a: 1 })).toMatchObject({ ok: false })
    expect(t.send('dg_abcdefgh02', '[1,2]')).toMatchObject({ ok: false })
    expect(t.send('dg_abcdefgh03', { big: 'x'.repeat(30001) }).error).toContain('大きすぎ')
    for (let i = 0; i < 20; i++) expect(t.send('dg_daily' + String(i).padStart(4, '0'), { i }).ok).toBe(true)
    expect(t.send('dg_daily9999', { i: 99 }).error).toContain('1日20件まで')
  })
})
