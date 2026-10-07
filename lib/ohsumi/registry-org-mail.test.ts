// 団体あてのメールを、団体の GAS に送ってもらう(checkIn の mailTasks / mailDone)。レジストリが送るのは、
// 対応していない古い版の団体と、最後の checkIn から24時間を超えた団体(団体の GAS が止まっている)だけ
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const DAY = 24 * 3600 * 1000
const FORM = 'https://docs.google.com/forms/d/e/FORMID/viewform'
const jstKey = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
type Task = { key: string; to: string[]; subject: string; body: string }

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
  const code = t.post({ action: 'issueRegistrationCode', session, orgName: '団体A', contactName: '担当', contactEmail: 'a@example.org' }).result.code
  const reg = t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: 'https://script.google.com/macros/s/AKfy0/exec', registerNonce: 'register-nonce-00000000-abcdefghijklmnopqrstuvwxyz0123' })
  expect(reg.ok, JSON.stringify(reg)).toBe(true)
  const key = String(reg.result.registryKey)
  expect(t.post({ action: 'setOrgPlan', session, orgId: ORG_A, plan: 'ohsumi', reason: '' }).ok).toBe(true)
  const NEW = String((t.gas as unknown as { ORG_MAIL_DELIVERY_SINCE: string }).ORG_MAIL_DELIVERY_SINCE)
  const checkIn = (extra: Record<string, unknown> = {}, gasVersion = NEW) => {
    const ts = Math.floor(Date.now() / 1000)
    const res = t.post({ action: 'checkIn', orgId: ORG_A, ts, gasVersion, sig: createHmac('sha256', key).update('checkIn.' + ORG_A + '.' + ts).digest('base64url'), ...extra })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    return res.result as { mailTasks?: Task[] }
  }
  const sheetRow = (name: string, col: string, value: string) => {
    const rows = t.sheets.get(name)!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[h.indexOf(col)] === value)!
    return { get: (n: string) => row[h.indexOf(n)], set: (n: string, v: unknown) => { row[h.indexOf(n)] = v } }
  }
  const org = () => sheetRow('Orgs', 'org_id', ORG_A)
  const send = () => t.post({ action: 'sendSurvey', session, title: '秋のアンケート', formUrl: FORM, sendDate: jstKey(Date.now()), target: { kind: 'all' }, reason: '' })
  return { ...t, session, NEW, checkIn, sheetRow, org, send }
}

describe('団体の GAS がメールを送る(対応した版)', () => {
  it('アンケートの送付は、レジストリからは送らず、checkIn の mailTasks で団体の GAS に渡す。送ったら記録し、二重に送らない', () => {
    const t = ready()
    expect(t.checkIn().mailTasks).toEqual([])
    const res = t.send()
    expect(res.result.sent[0].mailed).toBe(0)
    expect(t.mails).toHaveLength(0)
    const surveyId = String(res.result.sent[0].surveyId)
    const tasks = t.checkIn().mailTasks!
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ key: `sv.${surveyId}.0`, to: ['a@example.org'] })
    expect(tasks[0].subject).toContain('アンケートへのご回答のお願い')
    expect(tasks[0].body).toContain(FORM)
    // 団体自身のアカウントから届くので、件名と本文の最初に、FSIF からのお知らせであることを書く
    expect(tasks[0].subject.startsWith('[Ohsumi(FSIF)からのお知らせ] ')).toBe(true)
    expect(tasks[0].body.startsWith('Ohsumi(FSIF)からのお知らせです。')).toBe(true)
    expect(tasks[0].body).toContain('担当者と代表')
    // 送ったことを伝えると記録し、次からは渡さない。毎日の処理でもレジストリからは送らない
    expect(t.checkIn({ mailDone: [tasks[0].key, 'sv.unknown.0', 'bad key'] }).mailTasks).toEqual([])
    expect(JSON.parse(String(t.sheetRow('Surveys', 'survey_id', surveyId).get('reminders_json')))).toEqual([expect.objectContaining({ day: 0, via: 'org' })])
    t.gas.sendSurveyMails_(Date.now())
    expect(t.mails).toHaveLength(0)
    // 7日目のリマインド
    t.sheetRow('Surveys', 'survey_id', surveyId).set('send_date', jstKey(Date.now() - 7 * DAY))
    expect(t.checkIn().mailTasks!.map((x) => x.key)).toEqual([`sv.${surveyId}.7`])
  })

  it('最後の checkIn から24時間を超えた団体(団体の GAS が止まっている)には、毎日の処理でレジストリが代わりに送る', () => {
    const t = ready()
    t.checkIn()
    t.send()
    expect(t.mails).toHaveLength(0)
    t.org().set('last_check_at', new Date(Date.now() - 25 * 3600 * 1000).toISOString())
    t.gas.sendSurveyMails_(Date.now())
    t.gas.flushMailQueue_(Date.now())
    expect(t.mails.map((m) => m.to)).toEqual(['a@example.org'])
  })

  it('古い版の団体には、今までどおりレジストリから送り、mailTasks は返さない', () => {
    const t = ready()
    t.checkIn({}, '2026.10.01-11')
    t.send()
    expect(t.mails.map((m) => m.to)).toEqual(['a@example.org'])
    expect(t.checkIn({}, '2026.10.01-11').mailTasks).toBeUndefined()
  })

  it('停止の予告(14・7・1日前)も、団体の GAS に渡す。止まっている団体には、レジストリが送る', () => {
    const t = ready()
    t.checkIn()
    const at = Date.now() + 10 * DAY
    t.org().set('suspend_at', new Date(at).toISOString())
    t.org().set('suspend_kind', 'suspend')
    t.org().set('suspend_reason', '契約の終了')
    const tasks = t.checkIn().mailTasks!
    expect(tasks.map((x) => x.key)).toEqual([`sn.14s.${at}`])
    expect(tasks[0].subject).toContain('提供を停止します(あと14日)')
    t.gas.sendSuspensionNotices_(Date.now())
    expect(t.mails).toHaveLength(0)
    t.checkIn({ mailDone: [tasks[0].key] })
    expect(JSON.parse(String(t.org().get('suspend_notices_json')))).toEqual([expect.objectContaining({ days: 14, via: 'org' })])
    expect(t.checkIn().mailTasks).toEqual([])
    // 7日前になり、団体の GAS が止まっている
    t.org().set('suspend_at', new Date(Date.now() + 6 * DAY).toISOString())
    t.org().set('suspend_notices_json', JSON.stringify([{ days: 14 }]))
    t.org().set('last_check_at', new Date(Date.now() - 2 * DAY).toISOString())
    t.gas.sendSuspensionNotices_(Date.now())
    t.gas.flushMailQueue_(Date.now())
    expect(t.mails.map((m) => m.subject)).toEqual([expect.stringContaining('あと7日')])
  })

  it('28日目の機能停止の知らせは、入れた時にレジストリからは送らず、次の checkIn で団体の GAS に渡す', () => {
    const t = ready()
    t.checkIn()
    const surveyId = String(t.send().result.sent[0].surveyId)
    t.checkIn({ mailDone: [`sv.${surveyId}.0`] })
    t.sheetRow('Surveys', 'survey_id', surveyId).set('send_date', jstKey(Date.now() - 16 * DAY))
    t.sheetRow('Surveys', 'survey_id', surveyId).set('reminders_json', JSON.stringify([0, 7, 10, 14, 15].map((day) => ({ day }))))
    t.checkIn()
    const res = t.post({ action: 'scheduleSurveyRestriction', session: t.session, surveyIds: [surveyId], reason: '' })
    expect(res.result.scheduled, JSON.stringify(res)).toHaveLength(1)
    expect(t.mails).toHaveLength(0)
    const tasks = t.checkIn().mailTasks!
    const restrict = tasks.find((x) => x.key.startsWith('sr.'))!
    expect(restrict.key).toBe(`sr.${surveyId}.${Date.parse(res.result.scheduled[0].restrictAt)}`)
    expect(restrict.body).toContain('読み取り専用になります')
    t.checkIn({ mailDone: tasks.map((x) => x.key) })
    expect(t.checkIn().mailTasks!.some((x) => x.key.startsWith('sr.'))).toBe(false)
  })
})

describe('版で分ける', () => {
  it('対応した版(ORG_MAIL_DELIVERY_SINCE)は、レジストリの版の一覧にあり、今の団体の GAS はその版以降で mailDone を送る', () => {
    const root = join(__dirname, '..', '..')
    const registry = readFileSync(join(root, 'registry', 'Code.gs'), 'utf8')
    const code = readFileSync(join(root, 'gas', 'Code.gs'), 'utf8')
    const since = registry.match(/^var ORG_MAIL_DELIVERY_SINCE = '([^']+)'$/m)![1]
    expect(registry).toContain(`{ version: '${since}',`)
    const t = ready()
    const current = code.match(/^var OHSUMI_GAS_VERSION = '([^']+)'$/m)![1]
    expect(t.gas.compareGasVersions_(current, since)).toBeGreaterThanOrEqual(0)
    expect(code).toContain('mailDone: mailDone')
  })
})
