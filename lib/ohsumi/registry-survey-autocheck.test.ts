// レジストリ(registry/Code.gs)のアンケートの回答の自動の確認(v1.2): 団体ごとの受付コード入りのリンク・回答先のスプレッドシートの
// 「受付コード」の列だけを読む・合った団体を自動で回答済み(リマインドと機能停止を止める)・合わない回答は行番号だけ・入力の確かめ
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeSheet, setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const ORG_B = 'org_BBBBBBBBBBBBBBBBBBBB'
const FORM = 'https://docs.google.com/forms/d/e/FORMID/viewform'
const TEMPLATE = 'https://docs.google.com/forms/d/e/FORMID/viewform?usp=pp_url&entry.123456=OHSUMI_CODE'
const SHEET_ID = 'RESPONSESHEET0123456789abcdef'
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit#gid=0'
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
  ;[[ORG_A, '団体A', 'a@example.org'], [ORG_B, '団体B', 'b@example.org']].forEach(([orgId, name, email], i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, plan: 'ohsumi', orgName: name, contactName: '担当', contactEmail: email }).result.code
    expect(t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' }).ok).toBe(true)
    expect(t.post({ action: 'setOrgPlan', session, orgId, plan: 'ohsumi', reason: '' }).ok).toBe(true)
  })
  const send = (extra: Record<string, unknown> = {}) =>
    t.post({ action: 'sendSurvey', session, title: '2026年秋のアンケート', formUrl: FORM, sendDate: jstKey(Date.now()), target: { kind: 'all' }, reason: '', ...extra })
  // フォームの回答先(1行目が見出し。受付コードの列のほかに、読まない答えの列もある)
  const responses = (rows: string[][]) => {
    const sheet = new FakeSheet('フォームの回答 1')
    sheet.rows = [['タイムスタンプ', '満足度', '受付コード(変えずに送ってください)', '自由記述'], ...rows]
    t.external.set(SHEET_ID, [sheet])
  }
  const overview = () => t.post({ action: 'adminOverview', session }).result
  return { ...t, session, send, responses, overview }
}

describe('アンケートの回答の自動の確認', () => {
  it('団体ごとに受付コード入りのリンクで送り、回答先の受付コードの列で合った団体を自動で回答済みにする', () => {
    const t = ready()
    const res = t.send({ codeLinkTemplate: TEMPLATE, responseSheetUrl: SHEET_URL })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const surveys = t.overview().surveys as { surveyId: string; orgId: string; formUrl: string; receiptCode: string; autoCheck: boolean; state: string; answeredHow: string }[]
    expect(surveys).toHaveLength(2)
    const a = surveys.find((s) => s.orgId === ORG_A)!
    const b = surveys.find((s) => s.orgId === ORG_B)!
    expect(a.receiptCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(a.receiptCode).not.toBe(b.receiptCode)
    expect(a.formUrl).toBe(TEMPLATE.replace('OHSUMI_CODE', a.receiptCode))
    expect(a.autoCheck).toBe(true)
    // 送ったメールのリンクも受付コード入り
    expect(t.mails.some((m) => String(m.body).includes(a.formUrl))).toBe(true)

    // 団体A の回答(小文字・区切りなしでも合う)と、コードの無い回答・知らないコードの回答
    t.responses([['2026/10/25', '5', a.receiptCode.toLowerCase().replace('-', ''), 'とても良い'], ['2026/10/25', '3', '', ''], ['2026/10/25', '4', 'ZZZZ-ZZZZ', 'x']])
    const checked = t.post({ action: 'checkSurveyResponses', session: t.session })
    expect(checked.ok, JSON.stringify(checked)).toBe(true)
    expect(checked.result.answered).toEqual([expect.objectContaining({ surveyId: a.surveyId, orgId: ORG_A })])
    expect(checked.result.unmatched).toEqual([{ sheetId: SHEET_ID, count: 2, rows: [3, 4] }])
    const after = t.overview()
    expect(after.surveys.find((s: { orgId: string }) => s.orgId === ORG_A)).toMatchObject({ state: 'answered', answeredHow: 'auto' })
    expect(after.surveys.find((s: { orgId: string }) => s.orgId === ORG_B).state).not.toBe('answered')
    expect(after.surveyAutoCheck).toMatchObject({ answered: [expect.objectContaining({ orgId: ORG_A })] })
    // ほかの答え(満足度・自由記述)は残さない
    expect(JSON.stringify(t.sheets.get('Surveys')!.rows) + JSON.stringify(t.props)).not.toContain('とても良い')
    // 2回目は何もしない(もう回答済み)
    expect(t.post({ action: 'checkSurveyResponses', session: t.session }).result.answered).toEqual([])
    // 手で回答済みにしたものは manual
    expect(t.post({ action: 'markSurveyAnswered', session: t.session, surveyId: b.surveyId, reason: '' }).result.answeredHow).toBe('manual')
  })

  it('開けない回答先・受付コードの列が無い回答先は、理由を出す。自動の確認を使わないアンケートは今までどおり', () => {
    const t = ready()
    expect(t.send({ codeLinkTemplate: TEMPLATE, responseSheetUrl: SHEET_URL }).ok).toBe(true)
    expect(t.post({ action: 'checkSurveyResponses', session: t.session }).result.errors).toEqual([{ sheetId: SHEET_ID, error: expect.stringContaining('開けません') }])
    const sheet = new FakeSheet('回答')
    sheet.rows = [['タイムスタンプ', '満足度'], ['2026/10/25', '5']]
    t.external.set(SHEET_ID, [sheet])
    expect(t.post({ action: 'checkSurveyResponses', session: t.session }).result.errors[0].error).toContain('受付コード')
  })

  it('入力の確かめ: リンクのひな形には OHSUMI_CODE が要る・片方だけは断る・回答先は Google スプレッドシートの URL', () => {
    const t = ready()
    expect(t.send({ codeLinkTemplate: FORM + '?usp=pp_url&entry.1=abc', responseSheetUrl: SHEET_URL }).error).toContain('OHSUMI_CODE')
    expect(t.send({ codeLinkTemplate: TEMPLATE }).error).toContain('両方')
    expect(t.send({ codeLinkTemplate: TEMPLATE, responseSheetUrl: 'https://example.com/sheet' }).error).toContain('スプレッドシート')
    const plain = t.send()
    expect(plain.ok).toBe(true)
    const s = t.overview().surveys[0]
    expect(s).toMatchObject({ formUrl: FORM, receiptCode: '', autoCheck: false })
  })
})
