// レジストリ(registry/Code.gs)のアンケート(PR O): 送る・プランごとの上限(直近12か月)・リマインド・回答済み・
// 期限を過ぎた団体への28日目の機能停止・checkIn で団体の GAS に伝える
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const ORG_B = 'org_BBBBBBBBBBBBBBBBBBBB'
const DAY = 24 * 3600 * 1000
const FORM = 'https://docs.google.com/forms/d/e/FORMID/viewform'
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
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const keys: Record<string, string> = {}
  ;[[ORG_A, '団体A', 'a@example.org'], [ORG_B, '団体B', 'b@example.org']].forEach(([orgId, name, email], i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, orgName: name, contactName: '担当', contactEmail: email }).result.code
    const reg = t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' })
    expect(reg.ok, JSON.stringify(reg)).toBe(true)
    keys[orgId] = String(reg.result.registryKey)
  })
  const plan = (orgId: string, p: string) => expect(t.post({ action: 'setOrgPlan', session, orgId, plan: p, reason: '' }).ok).toBe(true)
  const send = (extra: Record<string, unknown> = {}) =>
    t.post({ action: 'sendSurvey', session, title: '2026年秋のアンケート', formUrl: FORM, sendDate: jstKey(Date.now()), target: { kind: 'all' }, reason: '', ...extra })
  const sheetRow = (name: string, col: string, value: string) => {
    const rows = t.sheets.get(name)!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[h.indexOf(col)] === value)!
    return { get: (n: string) => row[h.indexOf(n)], set: (n: string, v: unknown) => { row[h.indexOf(n)] = v } }
  }
  // 送付日を days 日前にずらす(送ったメールの記録はそのまま)
  const age = (surveyId: string, days: number) => sheetRow('Surveys', 'survey_id', surveyId).set('send_date', jstKey(Date.now() - days * DAY))
  const overview = () => t.post({ action: 'adminOverview', session }).result
  const checkIn = (orgId: string) => {
    const ts = Math.floor(Date.now() / 1000)
    return t.post({ action: 'checkIn', orgId, ts, gasVersion: '2026.10.01-11', sig: createHmac('sha256', keys[orgId]).update('checkIn.' + orgId + '.' + ts).digest('base64url') })
  }
  const audit = () => t.sheets.get('AuditLog')!.rows.slice(1).map((r) => r[2])
  return { ...t, session, plan, send, sheetRow, age, overview, checkIn, audit }
}

describe('アンケートを送る', () => {
  it('送付日が今日なら担当者にその場でメールを送り、代表の管理画面に出せるよう checkIn で伝える', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    t.plan(ORG_B, 'cosmo_base')
    const res = t.send()
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result.sent.map((s: { orgId: string }) => s.orgId).sort()).toEqual([ORG_A, ORG_B])
    expect(res.result.sent[0].mailed).toBe(1)
    expect(t.mails.map((m) => m.to).sort()).toEqual(['a@example.org', 'b@example.org'])
    expect(t.mails[0].subject).toContain('アンケートへのご回答のお願い')
    expect(t.mails[0].body).toContain(FORM)
    const surveys = t.checkIn(ORG_A).result.surveys
    expect(surveys).toHaveLength(1)
    expect(surveys[0]).toMatchObject({ title: '2026年秋のアンケート', formUrl: FORM, overdue: false, restrictAt: '' })
    expect(t.audit()).toContain('sendSurvey')
    // 毎日の処理で、同じメールを送り直さない
    t.gas.sendSurveyMails_(Date.now())
    expect(t.mails).toHaveLength(2)
  })

  it('プラン別・団体を選んで送れる。プランが未設定の団体には送らない', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    expect(t.send({ target: { kind: 'plan', plan: 'cosmo_base' } })).toMatchObject({ ok: false, error: '送る団体がありません。' })
    expect(t.send({ target: { kind: 'plan', plan: 'ohsumi' } }).result.sent).toHaveLength(1)
    const res = t.send({ target: { kind: 'orgs', orgIds: [ORG_B] }, formUrl: 'https://forms.gle/abc123' })
    expect(res.result.sent).toEqual([])
    expect(res.result.skipped[0]).toMatchObject({ orgId: ORG_B, reason: expect.stringContaining('プランが未設定') })
  })

  it('送付日が先なら、その日の毎日の処理で送る。checkIn では送付日まで伝えない', () => {
    const t = ready()
    t.plan(ORG_A, 'paid')
    const res = t.send({ target: { kind: 'orgs', orgIds: [ORG_A] }, sendDate: jstKey(Date.now() + 3 * DAY) })
    expect(res.result.sent[0].mailed).toBe(0)
    expect(t.mails).toHaveLength(0)
    expect(t.checkIn(ORG_A).result.surveys).toEqual([])
    expect(t.overview().surveys[0]).toMatchObject({ state: 'scheduled', day: -3 })
    t.gas.sendSurveyMails_(Date.now())
    expect(t.mails).toHaveLength(0)
    t.age(res.result.sent[0].surveyId, 0)
    t.gas.sendSurveyMails_(Date.now())
    expect(t.mails).toHaveLength(1)
  })

  it('URL・送付日・対象の形が違うものは断る', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    expect(t.send({ formUrl: 'https://example.com/form' }).error).toContain('Google フォームの URL')
    expect(t.send({ sendDate: jstKey(Date.now() - DAY) }).error).toContain('今日より後')
    expect(t.send({ sendDate: '2026-02-30' }).error).toContain('送付日')
    expect(t.send({ target: { kind: 'orgs', orgIds: [] } }).error).toContain('送る団体')
    expect(t.send({ title: '' }).error).toContain('名前')
    expect(t.send({ formUrl: 'https://docs.google.com/forms/d/' + 'x'.repeat(300) }).error).toContain('300文字まで')
  })

  it('プランごとの上限(直近12か月で Ohsumi 24・Cosmo Base 12・有償 4)を超えて送れない。取り消したものは数えない', () => {
    const t = ready()
    t.plan(ORG_A, 'paid')
    t.plan(ORG_B, 'cosmo_base')
    for (let i = 0; i < 4; i++) {
      const r = t.send({ formUrl: 'https://forms.gle/f' + i })
      expect(r.result.sent.length, JSON.stringify(r)).toBe(2)
    }
    const fifth = t.send({ formUrl: 'https://forms.gle/f4' })
    expect(fifth.result.sent.map((s: { orgId: string }) => s.orgId)).toEqual([ORG_B])
    expect(fifth.result.skipped[0]).toMatchObject({ orgId: ORG_A, reason: expect.stringContaining('有償プランの上限(直近12か月で4件)') })
    const first = t.overview().surveys.find((s: { orgId: string; formUrl: string }) => s.orgId === ORG_A && s.formUrl === 'https://forms.gle/f0')
    expect(t.post({ action: 'cancelSurvey', session: t.session, surveyId: first.surveyId, reason: '送り間違い' }).ok).toBe(true)
    expect(t.send({ formUrl: 'https://forms.gle/f5', target: { kind: 'orgs', orgIds: [ORG_A] } }).result.sent).toHaveLength(1)
    const ov = t.overview()
    expect(ov.surveyLimits).toEqual({ ohsumi: 24, cosmo_base: 12, paid: 4 })
    expect(ov.survey12mCounts[ORG_A]).toBe(4)
    expect(ov.survey12mCounts[ORG_B]).toBe(5)
  })

  it('上限は暦年ではなく直近12か月で数える。12か月より前のものは数えない', () => {
    const t = ready()
    t.plan(ORG_A, 'paid')
    const only = { target: { kind: 'orgs', orgIds: [ORG_A] } }
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(t.send({ ...only, formUrl: 'https://forms.gle/y' + i }).result.sent[0].surveyId)
    // 4件とも、去年の今ごろより後(12か月以内)に送った: まだ送れない
    ids.forEach((id, i) => t.age(id, 300 - i * 30))
    expect(t.send({ ...only, formUrl: 'https://forms.gle/y9' }).result.skipped[0].reason).toContain('直近12か月で4件')
    // 1件が12か月より前になれば、送れる
    t.age(ids[0], 370)
    expect(t.send({ ...only, formUrl: 'https://forms.gle/y9' }).result.sent).toHaveLength(1)
  })

  it('先の送付日の予定も数える(どの12か月の間でも上限を超えない)', () => {
    const t = ready()
    const peak = t.gas.surveyPeak12m_ as (dates: string[], day: string) => number
    expect(peak(['2026-01-10', '2026-06-01', '2026-12-01'], '2026-10-01')).toBe(4)
    expect(peak(['2025-09-01', '2026-01-10'], '2026-10-01')).toBe(2)
    expect(peak(['2025-10-02'], '2026-10-01')).toBe(2)
    expect(peak(['2025-10-01'], '2026-10-01')).toBe(1)
    expect((t.gas.addMonthsKey_ as (k: string, m: number) => string)('2026-03-31', -1)).toBe('2026-02-28')
  })

  it('同じフォームを回答待ちの団体には、二重に送らない', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    expect(t.send({ target: { kind: 'orgs', orgIds: [ORG_A] } }).result.sent).toHaveLength(1)
    expect(t.send({ target: { kind: 'orgs', orgIds: [ORG_A] } }).result.skipped[0].reason).toContain('同じフォーム')
  })
})

describe('リマインド', () => {
  it('7・10・14日目、期限の後は15・21・26・27日目に送る。止まっていた時は、いちばん新しいものだけを送る', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    const id = t.send({ target: { kind: 'orgs', orgIds: [ORG_A] } }).result.sent[0].surveyId
    const sentDays = () => JSON.parse(String(t.sheetRow('Surveys', 'survey_id', id).get('reminders_json'))).map((r: { day: number }) => r.day)
    const at = (day: number) => { t.age(id, day); t.gas.sendSurveyMails_(Date.now()) }
    at(6)
    expect(sentDays()).toEqual([0])
    at(7)
    at(7)
    expect(sentDays()).toEqual([0, 7])
    at(14)
    expect(sentDays()).toEqual([0, 7, 14])
    expect(t.mails.at(-1)!.subject).toContain('本日が回答期限です')
    at(15)
    expect(t.mails.at(-1)!.subject).toContain('過ぎています')
    at(25)
    at(27)
    expect(sentDays()).toEqual([0, 7, 14, 15, 21, 27])
    at(40)
    expect(sentDays()).toHaveLength(6)
    expect(t.audit().filter((a) => a === 'sendSurveyReminder')).toHaveLength(5)
  })

  it('回答済み・取り消しのアンケートには送らない', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    const id = t.send({ target: { kind: 'orgs', orgIds: [ORG_A] } }).result.sent[0].surveyId
    expect(t.post({ action: 'markSurveyAnswered', session: t.session, surveyId: id, reason: '' }).result).toMatchObject({ state: 'answered', answeredBy: 'admin@example.com' })
    t.age(id, 7)
    t.gas.sendSurveyMails_(Date.now())
    expect(t.mails).toHaveLength(1)
    expect(t.checkIn(ORG_A).result.surveys).toEqual([])
    expect(t.post({ action: 'markSurveyAnswered', session: t.session, surveyId: id }).error).toContain('回答済み')
  })
})

describe('期限を過ぎた団体の機能停止', () => {
  it('期限を過ぎた団体に、28日目の機能停止を1回の操作で入れる。リマインドに停止の日時が入り、停止の予告は別に送らない', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    t.plan(ORG_B, 'cosmo_base')
    const sent = t.send().result.sent
    const ids = sent.map((s: { surveyId: string }) => s.surveyId)
    ids.forEach((id: string) => t.age(id, 16))
    const overdue = t.overview().surveys.filter((s: { state: string }) => s.state === 'overdue')
    expect(overdue).toHaveLength(2)
    expect(overdue.every((s: { canRestrict: boolean }) => s.canRestrict)).toBe(true)
    const before = t.mails.length
    const res = t.post({ action: 'scheduleSurveyRestriction', session: t.session, surveyIds: ids, reason: '' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result.scheduled).toHaveLength(2)
    const sendKey = jstKey(Date.now() - 16 * DAY)
    const expected = new Date(Date.parse(sendKey + 'T00:00:00Z') - 9 * 3600 * 1000 + 28 * DAY).toISOString()
    expect(res.result.scheduled[0].restrictAt).toBe(expected)
    expect(t.mails.length).toBe(before + 2)
    expect(t.mails.at(-1)!.body).toContain('読み取り専用になります')
    const org = t.overview().orgs.find((o: { orgId: string }) => o.orgId === ORG_A)
    expect(org).toMatchObject({ state: 'scheduled', suspendKind: 'restrict', suspendAt: expected })
    expect(org.suspendReason).toContain('2026年秋のアンケート')
    // 停止の予告(14・7・1日前)は送らない
    const count = t.mails.length
    t.gas.sendSuspensionNotices_(Date.now() + 11 * DAY)
    expect(t.mails.length).toBe(count)
    // 団体の GAS には、停止の予定と、アンケートの停止の日時が伝わる
    const ci = t.checkIn(ORG_A).result
    expect(ci).toMatchObject({ phase: 'scheduled', kind: 'restrict' })
    expect(ci.surveys[0]).toMatchObject({ overdue: true, restrictAt: expected })
    // 21日目のリマインドに、停止の日時が入る
    ids.forEach((id: string) => t.age(id, 21))
    t.gas.sendSurveyMails_(Date.now())
    expect(t.mails.at(-1)!.body).toContain('読み取り専用になります')
    expect(t.audit()).toContain('scheduleSurveyRestriction')
  })

  it('回答済みにすると、このアンケートで入れた機能停止(停止中も)を止める', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    const id = t.send({ target: { kind: 'orgs', orgIds: [ORG_A] } }).result.sent[0].surveyId
    t.age(id, 30)
    expect(t.post({ action: 'scheduleSurveyRestriction', session: t.session, surveyIds: [id] }).result.scheduled).toHaveLength(1)
    // 28日目を過ぎていたので、翌日の0時
    const org = t.sheetRow('Orgs', 'org_id', ORG_A)
    expect(Date.parse(String(org.get('suspend_at'))) - Date.now()).toBeLessThanOrEqual(DAY)
    // 停止中にする
    org.set('suspend_at', new Date(Date.now() - 1000).toISOString())
    expect(t.checkIn(ORG_A).result).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    expect(t.post({ action: 'markSurveyAnswered', session: t.session, surveyId: id }).ok).toBe(true)
    expect(t.checkIn(ORG_A).result).toMatchObject({ phase: 'none', surveys: [] })
    expect(org.get('suspend_survey_id')).toBe('')
  })

  it('有償プラン・期限内・ほかの停止の予定がある団体には入れない', () => {
    const t = ready()
    t.plan(ORG_A, 'paid')
    t.plan(ORG_B, 'ohsumi')
    const [a, b] = t.send().result.sent.map((s: { surveyId: string }) => s.surveyId)
    t.age(a, 16)
    expect(t.overview().surveys.find((s: { surveyId: string }) => s.surveyId === a)).toMatchObject({ state: 'overdue', canRestrict: false })
    const res = t.post({ action: 'scheduleSurveyRestriction', session: t.session, surveyIds: [a, b] }).result
    expect(res.scheduled).toEqual([])
    expect(res.skipped.map((s: { reason: string }) => s.reason)).toEqual([expect.stringContaining('有償プラン'), expect.stringContaining('回答期限を過ぎて')])
    t.age(b, 16)
    expect(t.post({ action: 'scheduleSuspension', session: t.session, orgId: ORG_B, kind: 'suspend', suspendAt: new Date(Date.now() + 20 * DAY).toISOString(), reason: '契約の終了' }).ok).toBe(true)
    expect(t.post({ action: 'scheduleSurveyRestriction', session: t.session, surveyIds: [b] }).result.skipped[0].reason).toContain('ほかの停止')
  })

  it('停止の予定を取り消すと、アンケートとのつながりも消える', () => {
    const t = ready()
    t.plan(ORG_A, 'ohsumi')
    const id = t.send({ target: { kind: 'orgs', orgIds: [ORG_A] } }).result.sent[0].surveyId
    t.age(id, 16)
    t.post({ action: 'scheduleSurveyRestriction', session: t.session, surveyIds: [id] })
    expect(t.post({ action: 'clearSuspension', session: t.session, orgId: ORG_A, reason: '' }).ok).toBe(true)
    expect(t.sheetRow('Orgs', 'org_id', ORG_A).get('suspend_survey_id')).toBe('')
    expect(t.overview().surveys[0]).toMatchObject({ restrictAt: '', canRestrict: true })
  })
})
