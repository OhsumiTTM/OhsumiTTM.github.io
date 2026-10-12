// レジストリ(registry/Code.gs)の不具合の修正(2): 担当者のメールアドレスの形、当日の提供停止のメールの失敗、
// MailQueue の送り直し、団体の GAS が止まった時の停止の予告、予告の時期(毎日の処理)、checkIn の送り直しの防止、
// 版の印、団体の GAS が送ったメールの記録
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkInTs, setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const NONCE = 'register-nonce-00000001-abcdefghijklmnopqrstuvwxyz0123'
const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000

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
  const code = t.post({ action: 'issueRegistrationCode', session, plan: 'ohsumi', orgName: 'テスト団体A', contactName: '山田', contactEmail: 'yamada@example.org' }).result.code
  const reg = t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: URL_A, registerNonce: NONCE })
  expect(reg.ok, JSON.stringify(reg)).toBe(true)
  const key = String(reg.result.registryKey)
  const NEW = String((t.gas as unknown as { ORG_MAIL_DELIVERY_SINCE: string }).ORG_MAIL_DELIVERY_SINCE)
  const sign = (ts: number) => createHmac('sha256', key).update('checkIn.' + ORG_A + '.' + ts).digest('base64url')
  const checkIn = (extra: Record<string, unknown> = {}, ts = checkInTs()) =>
    t.post({ action: 'checkIn', orgId: ORG_A, ts, gasVersion: NEW, sig: sign(ts), ...extra })
  const sheetRow = (name: string, col: string, value: string) => {
    const rows = t.sheets.get(name)!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[h.indexOf(col)] === value)!
    return { get: (n: string) => row[h.indexOf(n)], set: (n: string, v: unknown) => { row[h.indexOf(n)] = v } }
  }
  const org = () => sheetRow('Orgs', 'org_id', ORG_A)
  const audit = () => t.sheets.get('AuditLog')!.rows.slice(1).map((r) => ({ actor: r[1], action: r[2], target: r[3], after: r[5] }))
  const queue = () => {
    const rows = t.sheets.get('MailQueue')!.rows
    const h = rows[0] as string[]
    return rows.slice(1).map((r) => ({ subject: r[h.indexOf('subject')], sentAt: r[h.indexOf('sent_at')], attempts: r[h.indexOf('attempts')], lastError: r[h.indexOf('last_error')], kind: r[h.indexOf('kind')] }))
  }
  // 停止の予定を直接入れる(予告の記録も)
  const scheduleAt = (at: number, sentDays: number[] = []) => {
    org().set('suspend_at', new Date(at).toISOString())
    org().set('suspend_kind', 'suspend')
    org().set('suspend_reason', '契約の終了')
    org().set('suspend_notices_json', JSON.stringify(sentDays.map((days) => ({ days }))))
  }
  const notices = () => (t.gas.sendSuspensionNotices_ as (n: number) => string[])
  return { ...t, session, key, NEW, sign, checkIn, sheetRow, org, audit, queue, scheduleAt, notices }
}

describe('1. 担当者のメールアドレスの形', () => {
  it('登録コードの発行は、担当者の画面と同じ形(CONTACT_EMAIL_PATTERN)で確かめ、, ; の入ったアドレスを断る', () => {
    const t = ready()
    const issue = (contactEmail: string) => t.post({ action: 'issueRegistrationCode', session: t.session, plan: 'ohsumi', orgName: '団体B', contactName: '佐藤', contactEmail })
    expect(issue('taro@example.co,jp').error).toMatch(/メールアドレスの形が正しくありません/)
    expect(issue('taro@example.co;jp').error).toMatch(/メールアドレスの形が正しくありません/)
    expect(issue('a@example.com,b@example.com').error).toMatch(/メールアドレスの形が正しくありません/)
    expect(issue('taro@example.co.jp').ok).toBe(true)
    expect(issue('').ok).toBe(true)
  })

  it('担当者(Contacts)のメールアドレスも同じ形のものだけを宛先にする(カンマで別の宛先に分かれない)', () => {
    const t = ready()
    const sheet = t.sheets.get('Contacts')!
    const h = sheet.rows[0] as string[]
    for (const email of ['bad@example.co,jp', 'two@example.org;x@example.org', 'nodot@localhost']) {
      sheet.appendRow(h.map((c) => (c === 'org_id' ? ORG_A : c === 'email' ? email : '')))
    }
    expect((t.gas.contactEmails_ as () => Record<string, string[]>)()[ORG_A]).toEqual(['yamada@example.org'])
  })
})

describe('2. 当日の提供停止で、メールが送れない時', () => {
  it('停止・操作の記録・知らせの記録は残し、メールは MailQueue に入れて毎日の処理で送る', () => {
    const t = ready()
    const real = t.gas.MailApp
    ;(t.gas as Record<string, unknown>).MailApp = { sendEmail: () => { throw new Error('Gmail のエラー') }, getRemainingDailyQuota: () => 100 }
    const res = t.post({ action: 'scheduleSuspension', session: t.session, orgId: ORG_A, kind: 'suspend', immediate: true, confirm: true, reason: '規約違反(緊急)' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ state: 'suspended', noticesSent: [0] })
    const row = t.audit().find((a) => a.action === 'suspendNow')!
    expect(row).toMatchObject({ actor: 'admin@example.com', target: ORG_A })
    expect(JSON.parse(String(row.after))).toMatchObject({ kind: 'suspend', mail: 'queued' })
    expect(t.queue()).toEqual([expect.objectContaining({ kind: 'notice', sentAt: '', lastError: expect.stringContaining('Gmail のエラー') })])
    expect(JSON.parse(String(t.org().get('suspend_notices_json')))).toEqual([expect.objectContaining({ days: 0, queued: true })])
    // Gmail が直ったら、毎日の処理で送る
    ;(t.gas as Record<string, unknown>).MailApp = real
    expect((t.gas.flushMailQueue_ as (n: number) => object)(Date.now())).toMatchObject({ sent: 1 })
    expect(t.mails.map((m) => m.subject)).toEqual([expect.stringContaining('提供を停止しました')])
  })
})

describe('3. MailQueue の送り直し', () => {
  it('1通が失敗しても、後のメールは送る。失敗した行に理由と回数を書き、5回で送り直しをやめて管理画面に数を出す', () => {
    const t = ready()
    const q = (subject: string, to = ['x@example.org']) => (t.gas.queueRegistryMail_ as (...a: unknown[]) => unknown)({ to, subject, body: '本文' }, 'notice', ORG_A, Date.now(), '')
    q('1通目')
    q('壊れたメール')
    q('3通目')
    const real = t.gas.MailApp as unknown as { sendEmail: (m: { subject: string }) => void; getRemainingDailyQuota: () => number }
    let tried = 0
    ;(t.gas as Record<string, unknown>).MailApp = {
      sendEmail: (m: { to: string; subject: string; body: string }) => { if (m.subject === '壊れたメール') { tried++; throw new Error('Invalid email') } real.sendEmail(m) },
      getRemainingDailyQuota: () => real.getRemainingDailyQuota(),
    }
    const flush = () => (t.gas.flushMailQueue_ as (n: number) => { sent: number; left: number; failed: number })(Date.now())
    expect(flush()).toEqual({ sent: 2, left: 1, failed: 0 })
    expect(t.mails.map((m) => m.subject)).toEqual(['1通目', '3通目'])
    expect(t.queue().find((r) => r.subject === '壊れたメール')).toMatchObject({ sentAt: '', attempts: 1, lastError: 'Invalid email' })
    // 4回目まで送り直し、5回目で送り直しをやめる
    for (let i = 0; i < 3; i++) flush()
    expect(flush()).toEqual({ sent: 0, left: 0, failed: 1 })
    expect(tried).toBe(5)
    expect(flush()).toEqual({ sent: 0, left: 0, failed: 0 })
    expect(tried).toBe(5)
    expect(t.gas.mailQueueStatus_()).toMatchObject({ pending: 0, failed: 1, failedByKind: { notice: 1 } })
    expect(t.post({ action: 'adminOverview', session: t.session }).result.mailQueue).toMatchObject({ pending: 0, failed: 1 })
  })

  it('1日の上限に達した時だけ止める(回数に数えない。送る順を守る)', () => {
    const t = ready()
    const q = (subject: string, to: string[]) => (t.gas.queueRegistryMail_ as (...a: unknown[]) => unknown)({ to, subject, body: '本文' }, 'other', ORG_A, Date.now(), '')
    q('A', ['a@example.org', 'b@example.org'])
    q('B', ['c@example.org'])
    t.mailQuota.remaining = 1
    expect((t.gas.flushMailQueue_ as (n: number) => object)(Date.now())).toEqual({ sent: 0, left: 2, failed: 0 })
    expect(t.queue().map((r) => r.attempts)).toEqual([0, 0])
    // 送る直前に上限に達した(例外)時も、回数に数えずに止める
    t.mailQuota.remaining = 3
    const real = t.gas.MailApp as unknown as { sendEmail: (m: object) => void; getRemainingDailyQuota: () => number }
    ;(t.gas as Record<string, unknown>).MailApp = {
      sendEmail: () => { t.mailQuota.remaining = 0; throw new Error('Service invoked too many times for one day: email.') },
      getRemainingDailyQuota: () => real.getRemainingDailyQuota(),
    }
    expect((t.gas.flushMailQueue_ as (n: number) => object)(Date.now())).toEqual({ sent: 0, left: 2, failed: 0 })
    expect(t.queue().map((r) => r.attempts)).toEqual([0, 0])
  })
})

describe('4. 団体の GAS が送る団体で、団体の GAS が止まった時の停止の予告', () => {
  it('最後の checkIn から2時間を超えていれば、24時間を待たずにレジストリが代わりに送る(団体の GAS には渡さない)', () => {
    const t = ready()
    expect(t.checkIn().ok).toBe(true)
    t.scheduleAt(Date.now() + 1.5 * DAY, [14, 7])
    t.org().set('last_check_at', new Date(Date.now() - 3 * HOUR).toISOString())
    expect(t.notices()(Date.now())).toEqual([ORG_A])
    ;(t.gas.flushMailQueue_ as (n: number) => object)(Date.now())
    expect(t.mails.map((m) => m.subject)).toEqual([expect.stringContaining('あと1日')])
    expect(t.checkIn().result.mailTasks).toEqual([])
  })

  it('確認に来ている団体は、団体の GAS が送るのを待つ。ただし送る時刻から2時間を過ぎた・次の毎日の処理では遅すぎる時は代わりに送る', () => {
    const t = ready()
    t.checkIn()
    // 団体の GAS は残り1日で送る。まだその時刻ではなく、次の毎日の処理(1日後)でも残り0.9日ある → 待つ
    t.scheduleAt(Date.now() + 1.9 * DAY, [14, 7])
    expect(t.notices()(Date.now())).toEqual([])
    // 次の毎日の処理では、残りが12時間を切る → 今送る
    t.scheduleAt(Date.now() + 1.4 * DAY, [14, 7])
    expect(t.notices()(Date.now())).toEqual([ORG_A])
    // 団体の GAS が送るはずの時刻から2時間を過ぎても、送ったと伝えられていない → 送る
    t.scheduleAt(Date.now() + 1 * DAY - 3 * HOUR, [14, 7])
    expect(t.notices()(Date.now())).toEqual([ORG_A])
    // 送ったと伝えられていれば、送らない
    t.scheduleAt(Date.now() + 1 * DAY - 3 * HOUR, [14, 7, 1])
    expect(t.notices()(Date.now())).toEqual([])
  })
})

describe('5. 予告の時期(毎日の処理)', () => {
  it('「あと1日」は、残りが1日以上ある最後の毎日の処理(残り2日以内)で送る。二重に送らない', () => {
    const t = ready()
    const at = Date.now() + 2.1 * DAY
    t.scheduleAt(at, [14, 7])
    expect(t.notices()(Date.now())).toEqual([])
    expect(t.notices()(at - 1.9 * DAY)).toEqual([ORG_A])
    expect(t.notices()(at - 0.9 * DAY)).toEqual([])
    ;(t.gas.flushMailQueue_ as (n: number) => object)(at - 1.9 * DAY)
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0].subject).toContain('あと1日')
    // 本文には、停止の日時をそのまま書く
    expect(t.mails[0].body).toContain('から、Ohsumi の提供を停止します')
    expect(JSON.parse(String(t.org().get('suspend_notices_json'))).map((n: { days: number }) => n.days)).toEqual([14, 7, 1])
  })

  it('団体の GAS が送る分(checkIn の mailTasks。1時間ごと)は早めない', () => {
    const t = ready()
    t.scheduleAt(Date.now() + 1.9 * DAY, [14, 7])
    expect(t.checkIn().result.mailTasks).toEqual([])
    t.scheduleAt(Date.now() + 0.9 * DAY, [14, 7])
    expect(t.checkIn().result.mailTasks.map((x: { key: string }) => x.key)).toEqual([expect.stringMatching(/^sn\.1s\./)])
  })

  it('純粋な関数: leadDays を省くと今までどおり(残り days 日以内)', () => {
    const t = ready()
    const due = t.gas.dueSuspensionNotice_ as (v: object, n: number, l?: number) => number | null
    const now = Date.now()
    const values = { status: 'active', suspend_at: new Date(now + 7.5 * DAY).toISOString(), suspend_kind: 'suspend', suspend_notices_json: JSON.stringify([{ days: 14 }]) }
    expect(due(values, now)).toBeNull()
    expect(due(values, now, 1)).toBe(7)
  })
})

describe('6. checkIn の送り直し(リプレイ)を断る', () => {
  it('同じ署名(団体ID・時刻)の2回目は断り、何も書かない。時刻が違えば受け付ける', () => {
    const t = ready()
    const ts = checkInTs()
    expect(t.checkIn({}, ts).ok).toBe(true)
    t.org().set('last_check_at', '')
    const before = Number(t.cache.get('rj:' + Math.floor(Date.now() / 3600000)) ?? 0)
    const again = t.checkIn({ mailDone: ['sn.14s.1'] }, ts)
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/同じ確認がもう届いています/)
    expect(again.authError).toBeUndefined()
    expect(t.org().get('last_check_at')).toBe('')
    expect(Number(t.cache.get('rj:' + Math.floor(Date.now() / 3600000)))).toBe(before + 1)
    // 覚える時間は、時刻の幅(前後5分)を覆う
    const replayKey = [...t.cacheTtl.keys()].find((k) => k.startsWith('ci:'))!
    expect(t.cacheTtl.get(replayKey)).toBeGreaterThanOrEqual(600)
    expect(t.checkIn().ok).toBe(true)
  })

  it('署名の違う(偽の)要求は、署名の確かめで断る(使った署名として覚えない)', () => {
    const t = ready()
    const ts = checkInTs()
    expect(t.post({ action: 'checkIn', orgId: ORG_A, ts, gasVersion: t.NEW, sig: 'x'.repeat(43) })).toMatchObject({ ok: false, authError: true })
    expect(t.checkIn({}, ts).ok).toBe(true)
  })
})

describe('7. 版の印', () => {
  const marks = (t: ReturnType<typeof ready>, version: string, m: Record<string, unknown> = {}) =>
    t.post({ action: 'setGasVersionMarks', session: t.session, version, reason: '試し', ...m })

  it('コードの一覧(KNOWN_GAS_VERSIONS)に無い版には、印を付けられない(一番新しい版より新しい版も)', () => {
    const t = ready()
    const known = (t.gas.KNOWN_GAS_VERSIONS as unknown as { version: string }[]).map((v) => v.version)
    expect(marks(t, '2099.01.01-1', { required: true }).error).toMatch(/KNOWN_GAS_VERSIONS/)
    expect(marks(t, '2099.01.01-1').error).toMatch(/KNOWN_GAS_VERSIONS/)
    expect(marks(t, '2020.01.01-1', { security: true }).error).toMatch(/KNOWN_GAS_VERSIONS/)
    expect((t.gas.gasVersionList_ as () => { version: string }[])()[0].version).toBe(known[0])
    const res = marks(t, known[1], { required: true, note: 'メモ' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result.versions.find((v: { version: string }) => v.version === known[1])).toMatchObject({ required: true, note: 'メモ' })
  })

  it('GasVersions に前から残っている知らない版: 一番新しい版より新しいものは使わない。古いものは印を外すことだけできる', () => {
    const t = ready()
    const known = (t.gas.KNOWN_GAS_VERSIONS as unknown as { version: string }[]).map((v) => v.version)
    const sheet = t.sheets.get('GasVersions')!
    const h = sheet.rows[0] as string[]
    const row = (v: Record<string, unknown>) => sheet.appendRow(h.map((c) => v[c] ?? ''))
    row({ version: '2099.01.01-1', required: true })
    row({ version: '2020.01.01-1', required: true })
    ;(t.gas.forgetGasVersions_ as () => void)()
    const list = (t.gas.gasVersionList_ as () => { version: string }[])()
    expect(list[0].version).toBe(known[0])
    expect(list.map((v) => v.version)).toContain('2020.01.01-1')
    expect(list.map((v) => v.version)).not.toContain('2099.01.01-1')
    expect(marks(t, '2020.01.01-1', { required: true }).error).toMatch(/KNOWN_GAS_VERSIONS/)
    expect(marks(t, '2020.01.01-1').ok).toBe(true)
    expect(marks(t, '2099.01.01-1').error).toMatch(/KNOWN_GAS_VERSIONS/)
  })

  it('5分以内に Google でログインし直している必要がある(reauthRequired)', () => {
    const t = ready()
    const known = (t.gas.KNOWN_GAS_VERSIONS as unknown as { version: string }[]).map((v) => v.version)
    const body = { session: t.session, version: known[0], required: true, reason: 'x' }
    let err: { message?: string; reauth?: boolean } = {}
    try { (t.gas.setGasVersionMarks_ as (b: object, n: number) => unknown)(body, Date.now() + 6 * 60 * 1000) } catch (e) { err = e as typeof err }
    expect(err.message).toMatch(/版の印の変更の前に、もう一度 Google でログイン/)
    expect(err.reauth).toBe(true)
    expect(t.audit().map((a) => a.action)).not.toContain('setGasVersionMarks')
  })
})

describe('8. 団体の GAS が送ったメールの記録(recordOrgMailDone_)', () => {
  it('ロックを取り、行を読み直してから書く(古い読み取りで、ほかの記録を消さない)', () => {
    const t = ready()
    const at = Date.now() + 6 * DAY
    t.scheduleAt(at, [])
    const stale = (t.gas.findOrgRow_ as (id: string) => { row: number; values: Record<string, unknown> })(ORG_A)
    // 読んだ後に、毎日の処理が14日前の予告を記録した
    t.org().set('suspend_notices_json', JSON.stringify([{ days: 14, at: new Date().toISOString() }]))
    let locks = 0
    const realLock = t.gas.LockService as unknown as { getScriptLock: () => { waitLock: () => void; releaseLock: () => void } }
    ;(t.gas as Record<string, unknown>).LockService = { getScriptLock: () => ({ waitLock() { locks++ }, releaseLock() {} }) }
    const n = (t.gas.recordOrgMailDone_ as (...a: unknown[]) => number)(stale, [], ['sn.7s.' + at], Date.now())
    ;(t.gas as Record<string, unknown>).LockService = realLock
    expect(n).toBe(1)
    expect(locks).toBe(1)
    expect(JSON.parse(String(t.org().get('suspend_notices_json'))).map((x: { days: number }) => x.days)).toEqual([14, 7])
    // 渡した行にも、読み直した値が入る(続けて作る mailTasks が新しい記録を見る)
    expect(JSON.parse(String(stale.values.suspend_notices_json)).map((x: { days: number }) => x.days)).toEqual([14, 7])
  })

  it('checkIn の mailDone でも、記録の後の mailTasks に同じ予告を入れない', () => {
    const t = ready()
    const at = Date.now() + 6.5 * DAY
    t.scheduleAt(at, [14])
    const tasks = t.checkIn().result.mailTasks as { key: string }[]
    expect(tasks.map((x) => x.key)).toEqual([`sn.7s.${at}`])
    expect(t.checkIn({ mailDone: [`sn.7s.${at}`] }).result.mailTasks).toEqual([])
    expect(JSON.parse(String(t.org().get('suspend_notices_json'))).map((x: { days: number }) => x.days)).toEqual([14, 7])
  })
})
