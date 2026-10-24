// プランと配る版(レジストリ): 登録コードで選ぶプラン、FSIF の団体(internal)、プランごとに配る版(PlanReleases)と、
// それを基準にした版の判定・checkIn の返事・管理画面の「プランごとに配る版」
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo, checkInTs } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORGS = ['org_AAAAAAAAAAAAAAAAAAAA', 'org_BBBBBBBBBBBBBBBBBBBB', 'org_CCCCCCCCCCCCCCCCCCCC']
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const FORM = 'https://forms.gle/survey00001'
const jstKey = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10)

// 試しの版の一覧(新しい順)。V0 はサイトに置いていない版
const V3 = '2026.12.03-1'
const V2 = '2026.12.02-1'
const V1 = '2026.12.01-1'
const V0 = '2026.11.01-1'
const TEST_VERSIONS = [
  { version: V3, security: false, required: false, released: true, note: '' },
  { version: V2, security: true, required: false, released: true, note: '' },
  { version: V1, security: false, required: true, released: true, note: '' },
  { version: V0, security: false, required: false, note: '' },
]

function ready(opts: { versions?: boolean; plans?: string[] } = {}) {
  const secret = 'nonce-secret-a1-0123456789'
  const now = Math.floor(Date.now() / 1000)
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(now + 3600), iat: String(now), nonce: 'registry-admin.' + createHash('sha256').update(secret).digest('base64url'),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT, HEALTH_KEY: 'hk', SITE_ORIGINS: 'https://ohsumi.example.org' }, tokeninfo: tokens })
  t.gas.setupRegistry()
  if (opts.versions !== false) {
    const known = t.gas.KNOWN_GAS_VERSIONS as unknown as object[]
    known.splice(0, known.length, ...TEST_VERSIONS.map((v) => ({ ...v })))
    ;(t.gas.forgetGasVersions_ as () => void)()
  }
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const keys: Record<string, string> = {}
  ;(opts.plans ?? ['ohsumi']).forEach((plan, i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, plan, orgName: '団体' + i, contactName: '担当', contactEmail: 'c' + i + '@example.org' }).result.code
    const reg = t.post({ action: 'registerOrg', code, orgId: ORGS[i], gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' })
    expect(reg.ok, JSON.stringify(reg)).toBe(true)
    keys[ORGS[i]] = String(reg.result.registryKey)
  })
  const checkIn = (gasVersion: string, orgId = ORGS[0]) => {
    const ts = checkInTs()
    return t.post({ action: 'checkIn', orgId, ts, gasVersion, sig: createHmac('sha256', keys[orgId]).update('checkIn.' + orgId + '.' + ts).digest('base64url') })
  }
  const overview = () => t.post({ action: 'adminOverview', session }).result
  const org = (orgId = ORGS[0]) => overview().orgs.find((o: { orgId: string }) => o.orgId === orgId)
  const release = (plan: string, version: string, extra: Record<string, unknown> = {}) =>
    t.post({ action: 'setPlanRelease', session, plan, version, reason: 'FSIF で確かめた', ...extra })
  const sheetRow = (name: string, col: string, value: string) => {
    const rows = t.sheets.get(name)!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[h.indexOf(col)] === value)!
    return { get: (n: string) => row[h.indexOf(n)], set: (n: string, v: unknown) => { row[h.indexOf(n)] = v } }
  }
  const audit = () => t.sheets.get('AuditLog')!.rows.slice(1).map((r) => ({ action: r[2], target: r[3], before: String(r[4]), after: String(r[5]) }))
  return { ...t, session, keys, checkIn, overview, org, release, sheetRow, audit }
}

type View = {
  plans: { plan: string; setting: string; version: string; source: string; problem: string; templateUrl: string; orgs: number; outdated: number; updateRequired: number }[]
  newest: string; fallback: string; released: string[]; removable: string[]; pendingSecurity: { version: string; plans: string[] }[]
}
const planOf = (v: View, plan: string) => v.plans.find((p) => p.plan === plan)!

describe('登録コードで選ぶプラン', () => {
  it('新しい団体の登録コードはプランが必須。登録すると Orgs の plan に入る(記録・一覧にも出る)', () => {
    const t = ready({ plans: [] })
    expect(t.post({ action: 'issueRegistrationCode', session: t.session, orgName: '団体X' }).error).toMatch(/プラン\(Cosmo Base・Ohsumi・有償・FSIF\)を選んでください/)
    expect(t.post({ action: 'issueRegistrationCode', session: t.session, orgName: '団体X', plan: 'gold' }).error).toMatch(/プラン/)
    const issued = t.post({ action: 'issueRegistrationCode', session: t.session, orgName: '団体X', plan: 'internal' })
    expect(issued.result).toMatchObject({ kind: 'new', plan: 'internal' })
    expect(t.overview().codes[0]).toMatchObject({ codeId: issued.result.codeId, plan: 'internal' })
    expect(t.audit().find((a) => a.action === 'issueRegistrationCode')!.after).toContain('"plan":"internal"')
    const reg = t.post({ action: 'registerOrg', code: issued.result.code, orgId: ORGS[0], gasUrl: 'https://script.google.com/macros/s/AKfyX/exec', registerNonce: 'register-nonce-00000009-abcdefghijklmnopqrstuvwxyz0123' })
    expect(reg.ok, JSON.stringify(reg)).toBe(true)
    expect(t.org().plan).toBe('internal')
    expect(t.audit().find((a) => a.action === 'registerOrg')!.after).toContain('"plan":"internal"')
    // 登録したプランは、記録の無い変更に数えない
    expect(t.gas.findUnrecordedOrgEdits_()).toEqual([])
  })

  it('再登録コードはプランを受け付けず、再登録しても今のプランのまま', () => {
    const t = ready()
    expect(t.post({ action: 'setOrgPlan', session: t.session, orgId: ORGS[0], plan: 'paid', reason: '契約' }).ok).toBe(true)
    const issued = t.post({ action: 'issueRegistrationCode', session: t.session, kind: 'reissue', targetOrgId: ORGS[0], plan: 'cosmo_base' })
    expect(issued.result).toMatchObject({ kind: 'reissue', plan: '' })
    const reg = t.post({ action: 'registerOrg', code: issued.result.code, orgId: ORGS[0], gasUrl: 'https://script.google.com/macros/s/AKfyR/exec', registerNonce: 'register-nonce-00000008-abcdefghijklmnopqrstuvwxyz0123' })
    expect(reg.ok, JSON.stringify(reg)).toBe(true)
    expect(t.org()).toMatchObject({ plan: 'paid', gasUrl: 'https://script.google.com/macros/s/AKfyR/exec' })
  })

  it('プランを選ぶ前に発行したコード(plan が空)で登録すると、今までどおりプランは未設定', () => {
    const t = ready({ plans: [] })
    const issued = t.post({ action: 'issueRegistrationCode', session: t.session, orgName: '団体Y', plan: 'ohsumi' })
    t.sheetRow('RegistrationCodes', 'code_id', issued.result.codeId).set('plan', '')
    t.post({ action: 'registerOrg', code: issued.result.code, orgId: ORGS[0], gasUrl: 'https://script.google.com/macros/s/AKfyY/exec', registerNonce: 'register-nonce-00000007-abcdefghijklmnopqrstuvwxyz0123' })
    expect(t.org().plan).toBe('')
  })

  it('RegistrationCodes に plan の列が無い(setupRegistry を実行していない)時は、発行しない', () => {
    const t = ready({ plans: [] })
    const rows = t.sheets.get('RegistrationCodes')!.rows
    const i = (rows[0] as string[]).indexOf('plan')
    rows.forEach((r) => (r as unknown[]).splice(i, 1))
    expect(t.post({ action: 'issueRegistrationCode', session: t.session, orgName: '団体Z', plan: 'ohsumi' }).ok).toBe(false)
    expect(t.sheets.get('RegistrationCodes')!.rows).toHaveLength(1)
  })
})

describe('FSIF の団体(internal)', () => {
  it('アンケートは上限なしで送れる(有償は4件まで)', () => {
    const t = ready({ plans: ['internal', 'paid'] })
    for (let i = 0; i < 5; i++) {
      const res = t.post({ action: 'sendSurvey', session: t.session, title: '試し' + i, formUrl: FORM + i, sendDate: jstKey(Date.now() + DAY), target: { kind: 'all' }, reason: '' })
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(res.result.sent.map((s: { orgId: string }) => s.orgId)).toContain(ORGS[0])
      if (i < 4) expect(res.result.sent.map((s: { orgId: string }) => s.orgId)).toContain(ORGS[1])
      else expect(res.result.skipped[0]).toMatchObject({ orgId: ORGS[1], reason: expect.stringContaining('有償プランの上限') })
    }
  })

  it('機能停止は入れられない(提供停止は入れられる)。機能停止の予定がある団体は、先に取り消さないと FSIF にできない', () => {
    const t = ready({ plans: ['internal', 'ohsumi'] })
    const schedule = (orgId: string, kind: string) => t.post({ action: 'scheduleSuspension', session: t.session, orgId, kind, suspendAt: new Date(Date.now() + 20 * DAY).toISOString(), reason: '試し' })
    expect(schedule(ORGS[0], 'restrict').error).toMatch(/FSIF の団体には、機能停止を入れられません/)
    expect(schedule(ORGS[0], 'suspend').ok).toBe(true)
    expect(schedule(ORGS[1], 'restrict').ok).toBe(true)
    expect(t.post({ action: 'setOrgPlan', session: t.session, orgId: ORGS[1], plan: 'internal', reason: '' }).error).toMatch(/FSIFにする前に、取り消す・解除してください/)
  })

  it('KPI(利用中の団体の数・プラン別の数)に数える。お知らせはプラン指定で FSIF に出せる', () => {
    const t = ready({ plans: ['internal', 'ohsumi'] })
    expect(t.overview().kpis).toMatchObject({ activeOrgs: 2, byPlan: { internal: 1, ohsumi: 1, cosmo_base: 0, paid: 0, '': 0 } })
    const pub = t.post({ action: 'publishAnnouncement', session: t.session, title: 'FSIF だけ', body: '新しい版を試します', importance: 'normal', target: { kind: 'plan', plan: 'internal' } })
    expect(pub.ok, JSON.stringify(pub)).toBe(true)
    const fetch = (orgId: string) => {
      const ts = checkInTs()
      return t.post({ action: 'fetchAnnouncements', orgId, ts, sig: createHmac('sha256', t.keys[orgId]).update('announcements.' + orgId + '.' + ts).digest('base64url') }).result.announcements
    }
    expect(fetch(ORGS[0]).map((a: { title: string }) => a.title)).toEqual(['FSIF だけ'])
    expect(fetch(ORGS[1])).toEqual([])
  })
})

describe('プランごとに配る版', () => {
  it('行が無い時は、全プランが一番新しい版(今までと同じ)', () => {
    const t = ready()
    const v = t.overview().planReleases as View
    expect(v.plans.map((p) => [p.plan, p.version, p.source])).toEqual([['cosmo_base', V3, 'default'], ['ohsumi', V3, 'default'], ['paid', V3, 'default'], ['internal', V3, 'latest']])
    expect(v).toMatchObject({ newest: V3, fallback: V3, released: [V3, V2, V1], removable: [V2, V1], pendingSecurity: [] })
    expect(t.checkIn(V3).result.gasUpdate).toEqual({ required: false, outdated: false, latest: V3, minimum: V2, security: false })
  })

  it('配る版を基準に判定する。配る版より新しい版があっても「古い」にしない。配る版より新しい印は求めない', () => {
    const t = ready({ plans: ['ohsumi', 'internal', 'cosmo_base'] })
    const res = t.release('ohsumi', V1)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    // 配る版と同じ → 最新(V3・安全の修正の V2 があっても)
    expect(t.checkIn(V1).result.gasUpdate).toEqual({ required: false, outdated: false, latest: V1, minimum: V1, security: false })
    expect(t.org().gasStatus).toMatchObject({ versionState: 'latest', latest: V1 })
    // 配る版より古い → 印の付いた V1 より古いので、更新が要る
    expect(t.checkIn(V0).result.gasUpdate).toMatchObject({ required: true, outdated: true, latest: V1, minimum: V1 })
    // 配る版より新しい版(FSIF から移ってきた団体など) → 最新
    expect(t.checkIn(V3).result.gasUpdate).toMatchObject({ required: false, outdated: false, latest: V1 })
    // FSIF は一番新しい版。Cosmo Base(行が無い)は、念のための既定(配る版のうち一番古い V1)
    expect(t.checkIn(V2, ORGS[1]).result.gasUpdate).toMatchObject({ outdated: true, required: false, latest: V3 })
    expect(t.checkIn(V1, ORGS[2]).result.gasUpdate).toMatchObject({ outdated: false, latest: V1 })
    const v = t.overview().planReleases as View
    expect(planOf(v, 'ohsumi')).toMatchObject({ setting: V1, version: V1, source: 'set', orgs: 1, outdated: 0 })
    expect(planOf(v, 'internal')).toMatchObject({ version: V3, orgs: 1, outdated: 1, updateRequired: 0 })
    expect(v.fallback).toBe(V1)
    // 安全の修正の V2 は、FSIF にしか配っていない
    expect(v.pendingSecurity).toEqual([{ version: V2, plans: ['cosmo_base', 'ohsumi', 'paid'] }])
    expect(v.removable).toEqual([V2])
    // 配る版を V2 に上げる → V1 の団体は更新が要る(安全の修正)
    t.release('ohsumi', V2)
    expect(t.checkIn(V1).result.gasUpdate).toMatchObject({ required: true, latest: V2, minimum: V2, security: true })
    // 操作の記録
    const a = t.audit().filter((x) => x.action === 'setPlanRelease')
    expect(a.map((x) => x.target)).toEqual(['ohsumi', 'ohsumi'])
    expect(a[1].before).toContain(V1)
    expect(a[1].after).toContain(V2)
  })

  it('デモの団体は一番新しい版。プランが未設定の団体は念のための既定', () => {
    const t = ready({ plans: ['ohsumi', 'ohsumi'] })
    t.release('ohsumi', V1)
    expect(t.post({ action: 'setOrgDemo', session: t.session, orgId: ORGS[1], demo: true, reason: '立ち上げ' }).ok).toBe(true)
    expect(t.checkIn(V1, ORGS[1]).result.gasUpdate).toMatchObject({ outdated: true, latest: V3 })
    t.sheetRow('Orgs', 'org_id', ORGS[0]).set('plan', '')
    expect(t.checkIn(V1).result.gasUpdate).toMatchObject({ outdated: false, latest: V1 })
  })

  it('選べる版はサイトに置いた版だけ(latest は FSIF だけ)。テンプレートのリンクの形を確かめる', () => {
    const t = ready()
    expect(t.release('ohsumi', V0).error).toMatch(/サイトにコードを置いた版/)
    expect(t.release('ohsumi', '2099.01.01-1').error).toMatch(/サイトにコードを置いた版/)
    expect(t.release('ohsumi', 'latest').error).toMatch(/サイトにコードを置いた版/)
    expect(t.release('gold', V1).error).toMatch(/プラン/)
    expect(t.release('internal', 'latest').ok).toBe(true)
    expect(t.release('paid', V1, { templateUrl: 'https://example.com/copy' }).error).toMatch(/テンプレートのリンク/)
    expect(t.release('paid', V1, { templateUrl: 'https://docs.google.com/spreadsheets/d/abc_DEF-123/edit' }).error).toMatch(/テンプレートのリンク/)
    const ok = t.release('paid', V1, { templateUrl: 'https://docs.google.com/spreadsheets/d/abc_DEF-123/copy' })
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(planOf(ok.result.planReleases, 'paid')).toMatchObject({ version: V1, templateUrl: 'https://docs.google.com/spreadsheets/d/abc_DEF-123/copy' })
    expect(planOf(ok.result.planReleases, 'internal')).toMatchObject({ setting: 'latest', version: V3, source: 'latest' })
    expect(t.sheets.get('PlanReleases')!.rows).toHaveLength(3)
    // シートを直接書き換えた、形の違うリンクは使わない(画面のリンクに出さない)
    t.sheetRow('PlanReleases', 'plan', 'paid').set('template_url', 'javascript:alert(1)')
    ;(t.gas.forgetPlanReleases_ as () => void)()
    expect(planOf(t.overview().planReleases, 'paid').templateUrl).toBe('')
  })

  it('5分以内のログインが要る。ログインしていない人は断る', () => {
    const t = ready()
    expect(() => t.gas.setPlanRelease_({ session: t.session, plan: 'ohsumi', version: V1 }, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(t.post({ action: 'setPlanRelease', session: 'ra1.x.y', plan: 'ohsumi', version: V1 }).authError).toBe(true)
    expect(t.sheets.get('PlanReleases')!.rows).toHaveLength(1)
  })

  it('配る版の版をサイトから外した(released を外した)時は、念のための既定に戻して知らせる', () => {
    const t = ready()
    t.release('ohsumi', V1)
    const known = t.gas.KNOWN_GAS_VERSIONS as unknown as { version: string; released?: boolean }[]
    known.find((v) => v.version === V1)!.released = false
    ;(t.gas.forgetGasVersions_ as () => void)()
    const v = t.overview().planReleases as View
    expect(planOf(v, 'ohsumi')).toMatchObject({ setting: V1, version: V3, source: 'default', problem: 'unreleased' })
    expect(t.checkIn(V3).result.gasUpdate).toMatchObject({ latest: V3, outdated: false })
  })

  it('サイトに置いた版が1つも無い時は、今までどおり一覧の一番新しい版', () => {
    const t = ready({ versions: false })
    const list = t.gas.gasVersionList_() as { version: string }[]
    const v = t.overview().planReleases as View
    expect(v.newest).toBe(list[0].version)
    expect(t.checkIn(list[0].version).result.gasUpdate).toMatchObject({ outdated: false, latest: list[0].version })
  })

  it('更新のお願いのメールに、そのプランで配っている版と、その版のコードの場所を書く', () => {
    const t = ready()
    t.release('ohsumi', V1)
    t.checkIn(V0)
    const res = t.post({ action: 'requestGasUpdate', session: t.session, orgId: ORGS[0], reason: '' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(t.mails.at(-1)!.body).toContain('このプランで配っている版: ' + V1)
    expect(t.mails.at(-1)!.body).toContain('https://ohsumi.example.org/gas/' + V1 + '/Code.gs')
  })
})

describe('プランごとの画面の版(resolveOrg の siteVersion)', () => {
  const site = (t: ReturnType<typeof ready>, orgId = ORGS[0]) => t.post({ action: 'resolveOrg', orgId }).result.siteVersion

  it('一番新しい配る版のプラン・FSIF・デモの団体は main の画面(空)。古い版を配るプランは、その版', () => {
    const t = ready({ plans: ['ohsumi', 'internal', 'cosmo_base'] })
    // 行が無い時は全プランが一番新しい版 → どれも main の画面
    expect([site(t, ORGS[0]), site(t, ORGS[1]), site(t, ORGS[2])]).toEqual(['', '', ''])
    t.release('ohsumi', V1)
    // 配る版を変えたら、覚えた答えを消すので、すぐに変わる
    expect(site(t, ORGS[0])).toBe(V1)
    // FSIF は、配る版に関わらず main の画面(先に試す)
    t.release('internal', V2)
    expect(site(t, ORGS[1])).toBe('')
    // Cosmo Base(行が無い)は念のための既定(配る版のうち一番古い V1)
    expect(site(t, ORGS[2])).toBe(V1)
    // デモの団体は一番新しい版 = main の画面
    expect(t.post({ action: 'setOrgDemo', session: t.session, orgId: ORGS[0], demo: true, reason: '立ち上げ' }).ok).toBe(true)
    t.cache.clear()
    expect(site(t, ORGS[0])).toBe('')
  })

  it('一番新しい版に上げたプランは main の画面に戻る。提供停止中の団体には返さない', () => {
    const t = ready()
    t.release('ohsumi', V2)
    expect(site(t)).toBe(V2)
    t.release('ohsumi', V3)
    expect(site(t)).toBe('')
    t.release('ohsumi', V1)
    t.sheetRow('Orgs', 'org_id', ORGS[0]).set('status', 'suspended')
    t.cache.clear()
    const r = t.post({ action: 'resolveOrg', orgId: ORGS[0] }).result
    expect(r.status).toBe('suspended')
    expect(r.siteVersion).toBe('')
  })
})
