// レジストリ(registry/Code.gs)の団体の情報: 団体名・契約の状態・属性の変更(setOrgProfile)、担当者の入れ替え
// (setOrgContacts。5分以内のログインが要る)、担当者・属性・集計値の推移の読み出し(getOrgDetail)
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG = 'org_AAAAAAAAAAAAAAAAAAAA'
const OTHER = 'org_BBBBBBBBBBBBBBBBBBBB'

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
  ;[ORG, OTHER].forEach((orgId, i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, orgName: i ? 'ほかの団体' : 'つばさ学生会議', contactName: '担当', contactEmail: 'c' + i + '@example.org' }).result.code
    keys[orgId] = String(t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' }).result.registryKey)
  })
  const report = (orgId: string, period: string, metrics: Record<string, number>) => {
    const ts = Math.floor(Date.now() / 1000)
    const m = { version: 1, ...metrics }
    const sig = createHmac('sha256', keys[orgId]).update('metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(m)).digest('base64url')
    return t.post({ action: 'reportMetrics', orgId, ts, period, metrics: m, sig })
  }
  const org = (id = ORG) => t.post({ action: 'adminOverview', session }).result.orgs.find((o: { orgId: string }) => o.orgId === id)
  const audit = (action: string) => t.sheets.get('AuditLog')!.rows.filter((r) => r[2] === action)
  return { ...t, session, report, org, audit }
}

describe('団体の情報を変える(setOrgProfile)', () => {
  it('団体名・契約の状態・終了日・メモを変え、一覧に出る。操作の記録に変えた項目だけ残る', () => {
    const t = ready()
    const res = t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, displayName: 'つばさ学生会議 2027', contract: { status: 'ending', until: '2027-03-31', note: '年度末で終了の予定' }, reason: '名前の変更の連絡' })
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ displayName: 'つばさ学生会議 2027', contractStatus: 'ending', contractNote: '年度末で終了の予定' })
    expect(t.org()).toMatchObject({ displayName: 'つばさ学生会議 2027', contractStatus: 'ending' })
    expect(String(t.org().contractUntil)).toContain('2027-03-31')
    // ほかの団体は変わらない
    expect(t.org(OTHER).displayName).toBe('ほかの団体')
    const rows = t.audit('setOrgProfile')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(String(rows[0][4]))).toMatchObject({ display_name: 'つばさ学生会議' })
    expect(JSON.parse(String(rows[0][5]))).toMatchObject({ display_name: 'つばさ学生会議 2027', contract_status: 'ending' })
    expect(rows[0][6]).toBe('名前の変更の連絡')
  })

  it('同じ内容なら書き換えず、記録も残さない', () => {
    const t = ready()
    t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, contract: { status: 'active', until: '', note: '' } })
    t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, contract: { status: 'active', until: '', note: '' } })
    expect(t.audit('setOrgProfile')).toHaveLength(1)
  })

  it('属性(分野・規模・所属・設立年)を足し、変えられる', () => {
    const t = ready()
    t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, attributes: { field: '宇宙', size: '11〜30名', affiliation: '慶應義塾大学', started_year: '2024' } })
    t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, attributes: { field: '宇宙', size: '31〜50名', affiliation: '慶應義塾大学', started_year: '2024' } })
    expect(t.sheets.get('Attributes')!.rows.filter((r) => r[0] === ORG)).toHaveLength(1)
    expect(t.post({ action: 'getOrgDetail', session: t.session, orgId: ORG }).result.attributes).toEqual({ field: '宇宙', size: '31〜50名', affiliation: '慶應義塾大学', started_year: '2024' })
  })

  it('おかしな値は断る', () => {
    const t = ready()
    const bad = (extra: Record<string, unknown>) => t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, ...extra })
    expect(bad({ displayName: '  ' }).error).toContain('団体名')
    expect(bad({ contract: { status: 'paused' } }).error).toContain('契約の状態')
    expect(bad({ contract: { status: 'active', until: '2027/03/31' } }).error).toContain('YYYY-MM-DD')
    expect(bad({ attributes: { started_year: '令和6年' } }).error).toContain('設立年')
    expect(bad({}).error).toContain('変える項目')
    expect(t.post({ action: 'setOrgProfile', session: t.session, orgId: 'org_ZZZZZZZZZZZZZZZZZZZZ', displayName: 'x' }).error).toContain('見つかりません')
    // 式として読まれる値は、文字として入れる
    t.post({ action: 'setOrgProfile', session: t.session, orgId: ORG, displayName: '=HYPERLINK("x")' })
    expect(t.sheets.get('Orgs')!.rows.some((r) => String(r[4]).startsWith("'="))).toBe(true)
  })

  it('ログインしていなければ断る', () => {
    const t = ready()
    expect(t.post({ action: 'setOrgProfile', session: 'bad', orgId: ORG, displayName: 'x' }).ok).toBe(false)
    expect(t.post({ action: 'getOrgDetail', session: 'bad', orgId: ORG }).ok).toBe(false)
  })
})

describe('担当者(setOrgContacts)', () => {
  it('登録の時の担当者が見え、入れ替えられる。停止の予告などの宛先も変わる', () => {
    const t = ready()
    expect(t.post({ action: 'getOrgDetail', session: t.session, orgId: ORG }).result.contacts).toEqual([{ name: '担当', email: 'c0@example.org', phone: '' }])
    const res = t.post({ action: 'setOrgContacts', session: t.session, orgId: ORG, reason: '代表の交代', contacts: [
      { name: '森田 葵', email: 'Aoi.Morita@example.com', phone: '090-0000-0000' },
      { name: '石井 拓真', email: 'takuma@example.com' },
    ] })
    expect(res.ok).toBe(true)
    const detail = t.post({ action: 'getOrgDetail', session: t.session, orgId: ORG }).result
    expect(detail.contacts).toEqual([
      { name: '森田 葵', email: 'aoi.morita@example.com', phone: '090-0000-0000' },
      { name: '石井 拓真', email: 'takuma@example.com', phone: '' },
    ])
    // ほかの団体の担当者は消さない
    expect(t.post({ action: 'getOrgDetail', session: t.session, orgId: OTHER }).result.contacts).toEqual([{ name: '担当', email: 'c1@example.org', phone: '' }])
    expect((t.gas.contactEmails_ as () => Record<string, string[]>)()[ORG]).toEqual(['aoi.morita@example.com', 'takuma@example.com'])
    const rows = t.audit('setOrgContacts')
    expect(rows).toHaveLength(1)
    expect(rows[0][6]).toBe('代表の交代')
  })

  it('おかしな一覧は断る(空・多すぎる・アドレスの形・同じアドレス)', () => {
    const t = ready()
    const put = (contacts: unknown) => t.post({ action: 'setOrgContacts', session: t.session, orgId: ORG, contacts })
    expect(put([]).error).toContain('1人以上')
    expect(put(Array.from({ length: 6 }, (_, i) => ({ email: `a${i}@example.com` }))).error).toContain('5人まで')
    expect(put([{ email: 'not-an-email' }]).error).toContain('メールアドレス')
    expect(put([{ email: 'a@example.com' }, { email: 'A@example.com' }]).error).toContain('2回')
    expect(put('x').error).toContain('一覧')
    // 断った時は、今の担当者のまま
    expect(t.post({ action: 'getOrgDetail', session: t.session, orgId: ORG }).result.contacts).toHaveLength(1)
  })

  it('宛先が変わるので、5分以内のログインが要る(団体名などは要らない)', () => {
    const t = ready()
    const later = Date.now() + 6 * 60 * 1000
    const contacts = (t.gas.setOrgContacts_ as (b: object, n: number) => unknown)
    expect(() => contacts({ session: t.session, orgId: ORG, contacts: [{ email: 'a@example.com' }] }, later)).toThrow(/もう一度 Google でログイン/)
    const profile = (t.gas.setOrgProfile_ as (b: object, n: number) => { ok: boolean })
    expect(profile({ session: t.session, orgId: ORG, displayName: '新しい名前' }, later).ok).toBe(true)
  })
})

describe('団体ごとの集計値の推移(getOrgDetail)', () => {
  it('その団体の集計値だけを、新しい期間から返す', () => {
    const t = ready()
    t.report(ORG, '2026-09-21', { members: 10, tasks: 30 })
    t.report(ORG, '2026-09-28', { members: 11, tasks: 35 })
    t.report(OTHER, '2026-09-28', { members: 99 })
    const d = t.post({ action: 'getOrgDetail', session: t.session, orgId: ORG }).result
    expect(d.usage.map((u: { period: string }) => u.period)).toEqual(['2026-09-28', '2026-09-21'])
    expect(d.usage[0].metrics).toEqual({ members: 11, tasks: 35 })
    expect(d.metricKeys).toContain('members')
  })
})
