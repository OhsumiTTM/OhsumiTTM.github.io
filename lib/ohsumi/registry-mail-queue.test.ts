// レジストリ(registry/Code.gs)のメールの1日の上限(PR R): 送る前に残りを確かめ、足りない分は MailQueue に残して翌日以降に送る。
// 送る順は、停止の予告 → リマインド → アンケートの送付。送れていない件数を管理画面と監視の毎朝のまとめに出す
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const DAY = 24 * 3600 * 1000
const jstKey = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
const ORGS = ['org_AAAAAAAAAAAAAAAAAAAA', 'org_BBBBBBBBBBBBBBBBBBBB', 'org_CCCCCCCCCCCCCCCCCCCC']

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
  ORGS.forEach((orgId, i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, orgName: '団体' + i, contactName: '担当', contactEmail: 'c' + i + '@example.org' }).result.code
    expect(t.post({ action: 'registerOrg', code, orgId, gasUrl: 'https://script.google.com/macros/s/AKfy' + i + '/exec', registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' }).ok).toBe(true)
    t.post({ action: 'setOrgPlan', session, orgId, plan: 'ohsumi', reason: '' })
  })
  const queue = () => {
    const rows = t.sheets.get('MailQueue')!.rows
    const h = rows[0] as string[]
    return rows.slice(1).map((r) => ({ kind: r[h.indexOf('kind')], sentAt: r[h.indexOf('sent_at')], to: r[h.indexOf('to')] }))
  }
  const setCell = (sheet: string, keyCol: string, key: string, col: string, v: unknown) => {
    const rows = t.sheets.get(sheet)!.rows
    const h = rows[0] as string[]
    rows.find((r) => r[h.indexOf(keyCol)] === key)![h.indexOf(col)] = v
  }
  return { ...t, session, queue, setCell }
}

describe('レジストリのメールの1日の上限', () => {
  it('毎日の処理は、停止の予告 → リマインド → アンケートの送付の順に送り、残りが足りない分は翌日以降に回す', () => {
    const t = ready()
    // アンケート: 団体A・B は7日目(リマインド)、団体C は今日が送付日
    const send = (orgId: string, form: string) => t.post({ action: 'sendSurvey', session: t.session, title: 'アンケート', formUrl: form, sendDate: jstKey(Date.now() + DAY), target: { kind: 'orgs', orgIds: [orgId] } }).result.sent[0].surveyId
    const a = send(ORGS[0], 'https://forms.gle/a')
    const b = send(ORGS[1], 'https://forms.gle/b')
    const c = send(ORGS[2], 'https://forms.gle/c')
    t.setCell('Surveys', 'survey_id', a, 'send_date', jstKey(Date.now() - 7 * DAY))
    t.setCell('Surveys', 'survey_id', a, 'reminders_json', JSON.stringify([{ day: 0 }]))
    t.setCell('Surveys', 'survey_id', b, 'send_date', jstKey(Date.now() - 7 * DAY))
    t.setCell('Surveys', 'survey_id', b, 'reminders_json', JSON.stringify([{ day: 0 }]))
    t.setCell('Surveys', 'survey_id', c, 'send_date', jstKey(Date.now()))
    // 団体C に停止の予告(7日前)
    t.setCell('Orgs', 'org_id', ORGS[2], 'suspend_at', new Date(Date.now() + 6.5 * DAY).toISOString())
    t.setCell('Orgs', 'org_id', ORGS[2], 'suspend_kind', 'suspend')
    t.mails.length = 0
    t.mailQuota.remaining = 2
    t.gas.dailyRegistryBackup()
    // 予告(団体C)とリマインド(団体A)を送り、リマインド(団体B)とアンケートの送付(団体C)を残す
    expect(t.mails.map((m) => m.to)).toEqual(['c2@example.org', 'c0@example.org'])
    expect(t.mails[0].subject).toContain('提供を停止します')
    const pending = t.queue().filter((q) => !q.sentAt)
    expect(pending.map((q) => q.kind)).toEqual(['reminder', 'send'])
    const ov = t.post({ action: 'adminOverview', session: t.session }).result
    expect(ov.mailQueue).toMatchObject({ pending: 2, recipients: 2, byKind: { reminder: 1, send: 1 }, remainingToday: 0 })
    // 監視の毎朝のまとめにも出す
    expect(t.post({ action: 'health', key: 'health-key', summary: true }).mailQueue).toMatchObject({ pending: 2 })
    // 翌日(残りが戻った): 残ったものを送る。同じリマインドを二重に入れない
    t.mailQuota.remaining = 100
    t.gas.dailyRegistryBackup()
    expect(t.mails.slice(2).map((m) => m.to)).toEqual(['c1@example.org', 'c2@example.org'])
    expect(t.queue().filter((q) => !q.sentAt)).toEqual([])
    expect(t.mails).toHaveLength(4)
  })

  it('管理画面の操作で送るメールは、残りがあればその場で送り、無ければ翌日以降に回す', () => {
    const t = ready()
    t.mailQuota.remaining = 0
    const res = t.post({ action: 'sendSurvey', session: t.session, title: 'アンケート', formUrl: 'https://forms.gle/x', sendDate: jstKey(Date.now()), target: { kind: 'orgs', orgIds: [ORGS[0]] } })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(t.mails).toHaveLength(0)
    expect(t.queue()).toEqual([expect.objectContaining({ kind: 'send', to: 'c0@example.org', sentAt: '' })])
    const gas = t.post({ action: 'requestGasUpdate', session: t.session, orgId: ORGS[1], reason: '' })
    expect(gas.result).toEqual({ sentTo: 1, queued: true })
    t.mailQuota.remaining = 100
    t.gas.dailyRegistryBackup()
    expect(t.mails.map((m) => m.to)).toEqual(['c0@example.org', 'c1@example.org'])
    // 毎日の処理は、同じアンケートの送付を二重に入れない
    expect(t.mails.filter((m) => m.to === 'c0@example.org')).toHaveLength(1)
  })

  it('送ってから30日を過ぎた行は消す', () => {
    const t = ready()
    t.gas.registryMail_({ to: ['x@example.org'], subject: 's', body: 'b' }, 'other', '', Date.now())
    ;(t.gas as Record<string, unknown>)._mailBatch = true
    t.gas.registryMail_({ to: ['y@example.org'], subject: 's', body: 'b' }, 'other', '', Date.now())
    ;(t.gas as Record<string, unknown>)._mailBatch = false
    t.gas.flushMailQueue_(Date.now())
    expect(t.queue()).toHaveLength(1)
    t.gas.flushMailQueue_(Date.now() + 31 * DAY)
    expect(t.queue()).toHaveLength(0)
  })
})
