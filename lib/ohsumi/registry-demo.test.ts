// レジストリ(registry/Code.gs)のデモの団体(PR S): 印の付け外し・定量データの集計と KPI から外す・
// アンケートの送付の対象から外す・停止の予定を入れられない(解除はできる)
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const REAL = 'org_AAAAAAAAAAAAAAAAAAAA'
const DEMO = 'org_DDDDDDDDDDDDDDDDDDDD'
const DAY = 24 * 3600 * 1000
const jstKey = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)

function ready() {
  const secret = 'nonce-secret-a1-0123456789'
  const now = Math.floor(Date.now() / 1000)
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(now + 3600), iat: String(now), nonce: 'registry-admin.' + createHash('sha256').update(secret).digest('base64url'),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT, HEALTH_KEY: 'health-key' }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const keys: Record<string, string> = {}
  ;[REAL, DEMO].forEach((orgId, i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, orgName: i ? 'デモ団体' : '本番の団体', contactName: '担当', contactEmail: 'c' + i + '@example.org' }).result.code
    keys[orgId] = String(t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' }).result.registryKey)
    t.post({ action: 'setOrgPlan', session, orgId, plan: 'ohsumi', reason: '' })
  })
  const setDemo = (orgId: string, demo: boolean) => t.post({ action: 'setOrgDemo', session, orgId, demo, reason: '立ち上げのテスト' })
  const report = (orgId: string, period: string, metrics: Record<string, number>) => {
    const ts = Math.floor(Date.now() / 1000)
    const m = { version: 1, ...metrics }
    const sig = createHmac('sha256', keys[orgId]).update('metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(m)).digest('base64url')
    return t.post({ action: 'reportMetrics', orgId, ts, period, metrics: m, sig })
  }
  const overview = () => t.post({ action: 'adminOverview', session }).result
  return { ...t, session, setDemo, report, overview }
}

describe('デモの団体', () => {
  it('印を付け外しでき、一覧に出る。操作の記録に残る', () => {
    const t = ready()
    expect(t.setDemo(DEMO, true).result).toMatchObject({ orgId: DEMO, demo: true })
    expect(t.overview().orgs.find((o: { orgId: string }) => o.orgId === DEMO).demo).toBe(true)
    expect(t.overview().orgs.find((o: { orgId: string }) => o.orgId === REAL).demo).toBe(false)
    expect(t.sheets.get('AuditLog')!.rows.some((r) => r[2] === 'setOrgDemo' && r[3] === DEMO)).toBe(true)
    expect(t.setDemo(DEMO, false).result.demo).toBe(false)
  })

  it('定量データの集計・KPI の数(プラン別・利用中の団体)から外す。デモの時に受け取った集計値は、印を外した後も入れない', () => {
    const t = ready()
    t.setDemo(DEMO, true)
    t.report(REAL, '2026-09-28', { members: 10, tasks: 40 })
    t.report(DEMO, '2026-09-28', { members: 99, tasks: 999 })
    const k = t.overview().kpis
    expect(k).toMatchObject({ activeOrgs: 1, demoOrgs: 1, byPlan: { ohsumi: 1 }, metrics: { reportingOrgs: 1, latestPeriod: '2026-09-28', totals: { members: 10, tasks: 40 } } })
    t.setDemo(DEMO, false)
    expect(t.overview().kpis.metrics.totals).toEqual({ members: 10, tasks: 40 })
    expect(t.overview().kpis.byPlan.ohsumi).toBe(2)
    // 監視の毎朝のまとめの「利用中の団体」にも入れない
    t.setDemo(DEMO, true)
    expect(t.post({ action: 'health', key: 'health-key', summary: true }).gasVersions).toMatchObject({ orgs: 1, demo: 1 })
  })

  it('アンケートの送付の対象から外す(団体を選んでも送らない)', () => {
    const t = ready()
    t.setDemo(DEMO, true)
    const res = t.post({ action: 'sendSurvey', session: t.session, title: 'アンケート', formUrl: 'https://forms.gle/a', sendDate: jstKey(Date.now()), target: { kind: 'all' } })
    expect(res.result.sent.map((s: { orgId: string }) => s.orgId)).toEqual([REAL])
    expect(res.result.skipped).toEqual([{ orgId: DEMO, reason: expect.stringContaining('デモの団体') }])
    const only = t.post({ action: 'sendSurvey', session: t.session, title: 'アンケート', formUrl: 'https://forms.gle/b', sendDate: jstKey(Date.now()), target: { kind: 'orgs', orgIds: [DEMO] } })
    expect(only.result.sent).toEqual([])
  })

  it('停止の予定(提供停止・機能停止・当日の提供停止)を入れられない。解除はできる', () => {
    const t = ready()
    // 先に入れた予定がある団体には、印を付けられない(取り消してから)
    expect(t.post({ action: 'scheduleSuspension', session: t.session, orgId: DEMO, kind: 'suspend', suspendAt: new Date(Date.now() + 20 * DAY).toISOString(), reason: 'テスト' }).ok).toBe(true)
    expect(t.setDemo(DEMO, true).error).toContain('取り消す・解除')
    expect(t.post({ action: 'clearSuspension', session: t.session, orgId: DEMO, reason: '' }).ok).toBe(true)
    expect(t.setDemo(DEMO, true).ok).toBe(true)
    for (const body of [
      { kind: 'suspend', suspendAt: new Date(Date.now() + 20 * DAY).toISOString() },
      { kind: 'restrict', suspendAt: new Date(Date.now() + 20 * DAY).toISOString() },
      { kind: 'suspend', immediate: true, confirm: true },
    ]) {
      expect(t.post({ action: 'scheduleSuspension', session: t.session, orgId: DEMO, reason: '誤操作', ...body }).error).toContain('デモの団体には、停止の予定を入れられません')
    }
    // シートを直接書き換えて停止中になっていても、解除はできる
    const rows = t.sheets.get('Orgs')!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[0] === DEMO)!
    row[h.indexOf('status')] = 'suspended'
    expect(t.post({ action: 'clearSuspension', session: t.session, orgId: DEMO, reason: '' }).ok).toBe(true)
  })
})
