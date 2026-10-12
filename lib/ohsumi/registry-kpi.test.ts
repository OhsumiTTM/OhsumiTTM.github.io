// レジストリ(registry/Code.gs)の KPI(管理画面の「KPI」タブ): 全体用(getKpiSummary)と、プラン別・団体別用(getKpiOrgs)
// 管理者だけ・デモの団体とデモの時の集計値を外す・期間・絞り込み・版1の団体・個人の情報を返さないこと
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const A = 'org_AAAAAAAAAAAAAAAAAAAA'
const B = 'org_BBBBBBBBBBBBBBBBBBBB'
const F = 'org_FFFFFFFFFFFFFFFFFFFF'
const DEMO = 'org_DDDDDDDDDDDDDDDDDDDD'
const DAY = 24 * 3600 * 1000
const jstKey = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
// 今の週の月曜日(日本時間)から n 週前の月曜日
const monday = (weeksAgo = 0) => {
  const key = jstKey(Date.now())
  const dow = new Date(key + 'T00:00:00Z').getUTCDay()
  return jstKey(Date.parse(key + 'T00:00:00Z') - 9 * 3600 * 1000 - ((dow + 6) % 7) * DAY - weeksAgo * 7 * DAY + 12 * 3600 * 1000)
}

function ready() {
  const secret = 'nonce-secret-a1-0123456789'
  const now = Math.floor(Date.now() / 1000)
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(now + 3600), iat: String(now), nonce: 'registry-admin.' + createHash('sha256').update(secret).digest('base64url'),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT, HEALTH_KEY: 'hk' }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const keys: Record<string, string> = {}
  ;([[A, 'ohsumi', '団体A'], [B, 'cosmo_base', '団体B'], [F, 'internal', 'FSIF の団体'], [DEMO, 'ohsumi', 'デモ団体']] as const).forEach(([orgId, plan, name], i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, plan, orgName: name, contactName: '担当の人', contactEmail: 'contact' + i + '@example.org' }).result.code
    keys[orgId] = String(t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' }).result.registryKey)
  })
  t.post({ action: 'setOrgProfile', session, orgId: A, attributes: { field: '宇宙', size: '11〜30名', affiliation: '大学', started_year: '2024' }, reason: '' })
  t.post({ action: 'setOrgProfile', session, orgId: B, attributes: { field: '環境', size: '1〜10名', affiliation: '高校', started_year: '2023' }, reason: '' })
  const report = (orgId: string, period: string, metrics: Record<string, number>, version = 2) => {
    const ts = Math.floor(Date.now() / 1000)
    const m = { version, ...metrics }
    const sig = createHmac('sha256', keys[orgId]).update('metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(m)).digest('base64url')
    const res = t.post({ action: 'reportMetrics', orgId, ts, period, metrics: m, sig })
    expect(res.ok, JSON.stringify(res)).toBe(true)
  }
  const summary = (extra: Record<string, unknown> = {}) => t.post({ action: 'getKpiSummary', session, ...extra })
  const orgs = (extra: Record<string, unknown> = {}) => t.post({ action: 'getKpiOrgs', session, ...extra })
  return { ...t, session, report, summary, orgs }
}

type Group = { count: number[]; sums: (number | null)[][]; has: number[][]; pos: number[][]; dsum: (number | null)[][]; dhas: number[][] }

describe('KPI(レジストリ)', () => {
  it('管理者のセッションが無ければ読めない', () => {
    const t = ready()
    expect(t.post({ action: 'getKpiSummary' }).authError).toBe(true)
    expect(t.post({ action: 'getKpiOrgs', session: 'ra1.x.y' }).authError).toBe(true)
  })

  it('期間の週(既定26週・4週・全期間)。週ごとの合計と、その週に送ってきた団体の数。デモの団体を外す', () => {
    const t = ready()
    t.post({ action: 'setOrgDemo', session: t.session, orgId: DEMO, demo: true, reason: '' })
    t.report(A, monday(1), { members: 10, active_7d: 5, active_30d: 8, members_logged_in: 9 })
    t.report(A, monday(0), { members: 12, active_7d: 6, active_30d: 9, members_logged_in: 10 })
    t.report(B, monday(0), { members: 4, active_7d: 0, active_30d: 2 }, 1)
    t.report(DEMO, monday(0), { members: 100, active_7d: 100 })
    t.report(A, monday(40), { members: 3 })
    const r = t.summary().result
    expect(r.filters).toMatchObject({ weeks: 26, plan: '', includeInternal: true })
    expect(r.weeks).toHaveLength(26)
    expect(r.weeks.at(-1)).toBe(monday(0))
    const k = (key: string) => r.sumKeys.indexOf(key)
    const all = r.groups.all as Group
    const v2 = r.groups.v2 as Group
    expect(all.count.at(-1)).toBe(2)
    expect(all.sums.at(-1)![k('members')]).toBe(16)
    expect(all.count.at(-2)).toBe(1)
    // 版2の項目: 版1の団体(B)は数えない(0 にしない)
    expect(v2.count.at(-1)).toBe(1)
    expect(v2.sums.at(-1)![k('members')]).toBe(12)
    expect(all.sums.at(-1)![k('members_logged_in')]).toBe(10)
    expect(all.has.at(-1)![k('members_logged_in')]).toBe(1)
    // 値が1つも無い項目は null
    expect(all.sums.at(-1)![k('comments_7d')]).toBeNull()
    // 前の週との差は、前の週も送ってきた団体だけで数える
    expect(all.dsum.at(-1)![k('members')]).toBe(2)
    expect(all.dhas.at(-1)![k('members')]).toBe(1)
    // 1以上の団体の数(機能の使われ方)
    expect(all.pos.at(-1)![k('active_7d')]).toBe(1)
    // 4週・全期間
    expect(t.summary({ weeks: 4 }).result.weeks).toHaveLength(4)
    expect(t.summary({ weeks: 0 }).result.weeks).toHaveLength(41)
    expect(t.summary({ weeks: 7 }).result.filters.weeks).toBe(26)
    // 団体の数(デモを除く)
    expect(r.orgs).toMatchObject({ total: 3, active: 3, byPlan: { ohsumi: 1, cosmo_base: 1, internal: 1 } })
  })

  it('デモの時に受け取った集計値は、後で印を外しても入れない', () => {
    const t = ready()
    t.post({ action: 'setOrgDemo', session: t.session, orgId: DEMO, demo: true, reason: '' })
    t.report(DEMO, monday(0), { members: 50 })
    t.post({ action: 'setOrgDemo', session: t.session, orgId: DEMO, demo: false, reason: '' })
    const r = t.summary().result
    expect(r.groups.all.count.at(-1)).toBe(0)
    expect(r.orgs.total).toBe(4)
  })

  it('絞り込み: FSIF を含めない・プラン・属性。選べる属性の値を返す', () => {
    const t = ready()
    t.report(A, monday(0), { members: 10 })
    t.report(B, monday(0), { members: 4 })
    t.report(F, monday(0), { members: 2 })
    const sum = (extra: Record<string, unknown>) => { const r = t.summary(extra).result; return r.groups.all.sums.at(-1)[r.sumKeys.indexOf('members')] }
    expect(sum({})).toBe(16)
    expect(sum({ includeInternal: false })).toBe(14)
    expect(sum({ plan: 'cosmo_base' })).toBe(4)
    expect(sum({ field: '宇宙' })).toBe(10)
    expect(sum({ size: '1〜10名' })).toBe(4)
    expect(t.summary({ plan: 'none' }).result.orgs.total).toBe(0)
    expect(t.summary().result.options).toEqual({ field: ['宇宙', '環境'], size: ['11〜30名', '1〜10名'].sort(), affiliation: ['大学', '高校'].sort() })
  })

  it('団体別のデータ: 団体×週×項目の数字の配列。送ってこなかった週は null。前の週の値も返す', () => {
    const t = ready()
    t.report(A, monday(2), { members: 8 })
    t.report(A, monday(0), { members: 10, active_7d: 4 })
    t.report(B, monday(1), { members: 3 }, 1)
    t.report(A, monday(4), { members: 7 })
    const r = t.orgs({ weeks: 4 }).result
    expect(r.weeks).toEqual([monday(3), monday(2), monday(1), monday(0)])
    expect(r.orgs.map((o: { orgId: string }) => o.orgId).sort()).toEqual([A, B, DEMO, F].sort())
    const i = r.orgs.findIndex((o: { orgId: string }) => o.orgId === A)
    const j = r.orgs.findIndex((o: { orgId: string }) => o.orgId === B)
    const m = r.metricKeys.indexOf('members')
    expect(r.values[i][0]).toBeNull()
    expect(r.values[i][1][m]).toBe(8)
    expect(r.values[i][3][m]).toBe(10)
    expect(r.values[i][3]).toHaveLength(r.metricKeys.length)
    expect(r.values[i][3][r.metricKeys.indexOf('comments_7d')]).toBeNull()
    expect(r.values[j][2][m]).toBe(3)
    expect(r.prev[i][m]).toBe(7)
    expect(r.prev[j]).toBeNull()
    expect(r.orgs[i]).toMatchObject({ name: '団体A', plan: 'ohsumi', state: 'active', attrs: { field: '宇宙' }, lastReportWeek: monday(0), mailLevel: 'unknown' })
  })

  it('連絡先・メールアドレスなどの個人の情報を返さない', () => {
    const t = ready()
    t.report(A, monday(0), { members: 10 })
    const text = JSON.stringify([t.summary().result, t.orgs().result])
    expect(text).not.toContain('@example.org')
    expect(text).not.toContain('担当の人')
    expect(text).not.toContain('admin@example.com')
    expect(text).not.toContain('registry_key')
  })

  it('登録した週ごとの続き具合・FSIF の運営(登録コード)・運用の数', () => {
    const t = ready()
    t.report(A, monday(0), { members: 10, active_7d: 3 })
    const r = t.summary().result
    expect(r.cohort.rows).toHaveLength(1)
    expect(r.cohort.rows[0]).toMatchObject({ week: monday(0), size: 4, reported: [1], active: [1] })
    expect(r.fsif.codes).toMatchObject({ issued: 4, used: 4 })
    expect(r.fsif.codes.daysToUse.n).toBe(4)
    expect(r.ops.versions['不明']).toBe(4)
    expect(r.dist.members).toEqual([10])
    expect(r.dist.ageDays).toHaveLength(4)
  })
})
