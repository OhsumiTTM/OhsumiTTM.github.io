// レジストリ(registry/Code.gs)の R1-e: 提供停止・機能停止の予定・解除、団体の GAS の確認(checkIn)、
// 接続先の解決での状態、担当者への予告(14日前・7日前・1日前)を確かめる
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const DAY = 24 * 3600 * 1000
const NONCE = 'register-nonce-00000001-abcdefghijklmnopqrstuvwxyz0123'

function ready() {
  const secret = 'nonce-secret-a1-0123456789'
  const now = Math.floor(Date.now() / 1000)
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': {
      aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true',
      exp: String(now + 3600), iat: String(now),
      nonce: 'registry-admin.' + createHash('sha256').update(secret).digest('base64url'),
    },
  }
  const t = setup({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  t.gas.setupRegistry()
  const session = t.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: secret }).result.session.token
  const code = t.post({ action: 'issueRegistrationCode', session, orgName: 'テスト団体A', contactName: '山田', contactEmail: 'yamada@example.org' }).result.code
  const reg = t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: URL_A, registerNonce: NONCE })
  expect(reg.ok, JSON.stringify(reg)).toBe(true)
  const key = String(reg.result.registryKey)
  const schedule = (kind: string, at: number, reason = '契約の終了') =>
    t.post({ action: 'scheduleSuspension', session, orgId: ORG_A, kind, suspendAt: new Date(at).toISOString(), reason })
  const clear = (reason = '') => t.post({ action: 'clearSuspension', session, orgId: ORG_A, reason })
  const checkIn = (opts2: { ts?: number; sig?: string; key?: string } = {}) => {
    const ts = opts2.ts ?? Math.floor(Date.now() / 1000)
    const sig = opts2.sig ?? createHmac('sha256', opts2.key ?? key).update('checkIn.' + ORG_A + '.' + ts).digest('base64url')
    return t.post({ action: 'checkIn', orgId: ORG_A, ts, gasVersion: 'r1e-1', sig })
  }
  const org = () => t.post({ action: 'adminOverview', session }).result.orgs.find((o: { orgId: string }) => o.orgId === ORG_A)
  const audit = () => t.sheets.get('AuditLog')!.rows.slice(1).map((r) => ({ actor: r[1], action: r[2], target: r[3], reason: r[6] }))
  const orgsRow = () => {
    const rows = t.sheets.get('Orgs')!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[0] === ORG_A)!
    return { get: (n: string) => row[h.indexOf(n)], set: (n: string, v: unknown) => { row[h.indexOf(n)] = v } }
  }
  return { ...t, session, key, schedule, clear, checkIn, org, audit, orgsRow }
}

describe('停止の予定(管理画面)', () => {
  it('提供停止・機能停止のどちらかを選び、14日より後の日時と理由を入れる。操作の記録に残る', () => {
    const t = ready()
    const at = Date.now() + 20 * DAY
    const res = t.schedule('restrict', at, 'アンケートの未回答')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ state: 'scheduled', suspendKind: 'restrict', suspendReason: 'アンケートの未回答', suspendScheduledBy: 'admin@example.com' })
    expect(t.org()).toMatchObject({ state: 'scheduled', suspendKind: 'restrict', suspendAt: new Date(at).toISOString() })
    expect(t.audit()).toContainEqual(expect.objectContaining({ actor: 'admin@example.com', action: 'scheduleSuspension', target: ORG_A, reason: 'アンケートの未回答' }))
    // 記録の無い変更として監視に知らされない
    expect((t.gas.findUnrecordedOrgEdits_ as () => string[])()).toEqual([])
  })

  it('14日より前・種類なし・理由なし・日時なしは断る', () => {
    const t = ready()
    expect(t.schedule('suspend', Date.now() + 13 * DAY).error).toMatch(/14日より後/)
    expect(t.schedule('other', Date.now() + 20 * DAY).error).toMatch(/種類/)
    expect(t.schedule('suspend', Date.now() + 20 * DAY, '').error).toMatch(/理由/)
    expect(t.post({ action: 'scheduleSuspension', session: t.session, orgId: ORG_A, kind: 'suspend', reason: 'x' }).error).toMatch(/日時/)
    expect(t.org().state).toBe('active')
  })

  it('停止の予定を入れるには、5分以内に Google でログインし直している必要がある', () => {
    const t = ready()
    const body = { session: t.session, orgId: ORG_A, kind: 'suspend', suspendAt: new Date(Date.now() + 20 * DAY).toISOString(), reason: 'x' }
    expect(() => (t.gas.scheduleSuspension_ as (b: object, n: number) => unknown)(body, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(t.org().state).toBe('active')
  })

  it('予定を取り消せる(取り消し)。停止中なら解除できる(解除)。どちらも記録に残り、元の状態に戻る', () => {
    const t = ready()
    t.schedule('suspend', Date.now() + 20 * DAY)
    expect(t.clear('契約を更新').ok).toBe(true)
    expect(t.org()).toMatchObject({ state: 'active', suspendAt: '', suspendKind: 'suspend', noticesSent: [] })
    t.schedule('restrict', Date.now() + 20 * DAY, 'アンケートの未回答')
    t.orgsRow().set('suspend_at', new Date(Date.now() - 1000).toISOString()) // 予定の日時を過ぎた
    t.cache.clear()
    expect(t.org().state).toBe('restricted')
    expect(t.clear('回答を確認').ok).toBe(true)
    expect(t.org().state).toBe('active')
    expect(t.audit().map((a) => a.action)).toEqual(expect.arrayContaining(['cancelSuspension', 'liftSuspension']))
    expect(t.clear().error).toMatch(/停止の予定も停止もありません/)
  })

  it('停止中の団体には、新しい予定を入れられない(先に解除する)', () => {
    const t = ready()
    t.orgsRow().set('status', 'suspended')
    expect(t.schedule('suspend', Date.now() + 20 * DAY).error).toMatch(/停止中/)
  })

  it('R1-d までに覚えた指紋は、停止の種類を入れない限り変わらない(記録の無い変更と間違えない)', () => {
    const t = ready()
    const fp = t.gas.orgFingerprint_ as (v: Record<string, string>) => string
    const values = { gas_url: URL_A, status: 'active', channel: 'standard', suspend_at: '' }
    expect(fp({ ...values, suspend_kind: '' })).toBe(fp(values))
    expect(fp({ ...values, suspend_kind: 'restrict' })).not.toBe(fp(values))
  })
})

describe('接続先の解決(resolveOrg)での状態', () => {
  it('予定の間は active。提供停止になったら接続先を返さない。機能停止は接続先を返して restricted', () => {
    const t = ready()
    t.schedule('suspend', Date.now() + 20 * DAY)
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result).toMatchObject({ status: 'active', gasUrl: URL_A })
    t.orgsRow().set('suspend_at', new Date(Date.now() - 1000).toISOString())
    t.cache.clear()
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result).toMatchObject({ status: 'suspended', gasUrl: '' })
    t.orgsRow().set('suspend_kind', 'restrict')
    t.cache.clear()
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result).toMatchObject({ status: 'restricted', gasUrl: URL_A })
  })

  it('予定を入れた・解除した時は、覚えた答えを消す(すぐ新しい状態を返す)', () => {
    const t = ready()
    t.schedule('restrict', Date.now() + 20 * DAY)
    t.orgsRow().set('suspend_at', new Date(Date.now() - 1000).toISOString())
    t.cache.clear()
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result.status).toBe('restricted')
    t.clear()
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result.status).toBe('active')
  })
})

describe('団体の GAS の確認(checkIn)', () => {
  it('共有鍵の署名が合えば、契約の状態を返し、最後に確認に来た時刻と GAS の版を書く', () => {
    const t = ready()
    const at = Date.now() + 20 * DAY
    t.schedule('restrict', at, 'アンケートの未回答')
    const res = t.checkIn()
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ phase: 'scheduled', kind: 'restrict', suspendAt: new Date(at).toISOString(), reason: 'アンケートの未回答' })
    expect(t.orgsRow().get('gas_version')).toBe('r1e-1')
    expect(Date.parse(String(t.orgsRow().get('last_check_at')))).toBeGreaterThan(Date.now() - 60_000)
    expect(t.org().checkState).toBe('ok')
  })

  it('署名が違う・鍵が違う・時刻が5分より離れている時は断り、断ったリクエストとして数える', () => {
    const t = ready()
    const before = Number(t.cache.get('rj:' + Math.floor(Date.now() / 3600000)) ?? 0)
    expect(t.checkIn({ sig: 'x'.repeat(43) })).toMatchObject({ ok: false, authError: true })
    expect(t.checkIn({ key: 'wrong-key' })).toMatchObject({ ok: false, authError: true })
    expect(t.checkIn({ ts: Math.floor(Date.now() / 1000) - 400 })).toMatchObject({ ok: false, authError: true })
    expect(Number(t.cache.get('rj:' + Math.floor(Date.now() / 3600000)))).toBe(before + 3)
    expect(t.orgsRow().get('last_check_at')).toBe('')
  })

  it('停止の予定が無ければ none、停止中なら inEffect を返す', () => {
    const t = ready()
    expect(t.checkIn().result).toMatchObject({ phase: 'none' })
    t.orgsRow().set('status', 'suspended')
    expect(t.checkIn().result).toMatchObject({ phase: 'inEffect', kind: 'suspend' })
  })
})

describe('担当者への予告(毎日の処理)', () => {
  const run = (t: ReturnType<typeof ready>, at: number) => (t.gas.sendSuspensionNotices_ as (n: number) => string[])(at)

  it('14日前・7日前・1日前に、担当者にメールを送る(同じ予告は1回だけ)。記録に残す', () => {
    const t = ready()
    const now = Date.now()
    const at = now + 20 * DAY
    t.schedule('suspend', at, '契約の終了')
    expect(run(t, now)).toEqual([]) // まだ14日より前
    expect(run(t, at - 14 * DAY + 1000)).toEqual([ORG_A])
    expect(run(t, at - 13 * DAY)).toEqual([]) // 14日前の予告は送った
    expect(run(t, at - 7 * DAY + 1000)).toEqual([ORG_A])
    expect(run(t, at - 1 * DAY + 1000)).toEqual([ORG_A])
    expect(run(t, at - 1000)).toEqual([])
    expect(t.mails).toHaveLength(3)
    expect(t.mails.every((m) => m.to === 'yamada@example.org')).toBe(true)
    expect(t.mails[0].subject).toContain('提供を停止します(あと14日)')
    expect(t.mails[0].body).toContain('契約の終了')
    expect(t.org().noticesSent).toEqual([14, 7, 1])
    expect(t.audit().filter((a) => a.action === 'sendSuspensionNotice')).toHaveLength(3)
  })

  it('機能停止の予告は、読み取り専用になることとアンケートへの回答のお願いを書く', () => {
    const t = ready()
    const at = Date.now() + 20 * DAY
    t.schedule('restrict', at, 'アンケートの未回答')
    run(t, at - 14 * DAY + 1000)
    expect(t.mails[0].subject).toMatch(/読み取り専用になります/)
    expect(t.mails[0].body).toMatch(/アンケートへの回答をお願いします/)
  })

  it('予定を入れたのが7日前より後でも(14日を過ぎて入れ直した時など)、近い方の予告を1回だけ送る', () => {
    const t = ready()
    const at = Date.now() + 20 * DAY
    t.schedule('suspend', at)
    expect(run(t, at - 5 * DAY)).toEqual([ORG_A])
    expect(t.mails[0].subject).toMatch(/あと7日/)
    expect(run(t, at - 5 * DAY + 1000)).toEqual([])
  })

  it('予定を入れ直すと、予告の記録も最初から', () => {
    const t = ready()
    const at = Date.now() + 20 * DAY
    t.schedule('suspend', at)
    run(t, at - 14 * DAY + 1000)
    t.schedule('suspend', at + DAY)
    expect(t.org().noticesSent).toEqual([])
  })

  it('毎日の処理(dailyRegistryBackup)から送る。送れなくてもバックアップは続ける', () => {
    const t = ready()
    t.schedule('suspend', Date.now() + 20 * DAY)
    t.orgsRow().set('suspend_at', new Date(Date.now() + 13 * DAY).toISOString()) // 14日前を過ぎた
    ;(t.gas.dailyRegistryBackup as () => unknown)()
    expect(t.mails).toHaveLength(1)
    ;(t.gas as Record<string, unknown>).sendSuspensionNotices_ = () => { throw new Error('mail quota') }
    expect(() => (t.gas.dailyRegistryBackup as () => unknown)()).not.toThrow()
    expect(t.props.LAST_BACKUP_AT).toBeTruthy()
  })
})

describe('テスト環境で、14日待たずに確かめる(エディタから実行する関数)', () => {
  const call = (t: ReturnType<typeof ready>, name: string) => (t.gas[name] as () => unknown)()

  it('REGISTRY_TEST_MODE が true のレジストリでだけ動く(本番では何も変えない)', () => {
    const t = ready()
    t.props.TEST_ORG_ID = ORG_A
    for (const name of ['testSuspendNow', 'testScheduleSuspension', 'testLiftSuspension']) {
      expect(() => call(t, name), name).toThrow(/テスト環境のレジストリだけ/)
    }
    expect(t.org().state).toBe('active')
  })

  it('REGISTRY_TEST_ORG_IDS に無い団体(本番の団体)は、何も変えずに止まる', () => {
    const t = ready()
    for (const ids of [undefined, '', 'org_TESTTESTTESTTEST01', 'org_AAAAAAAAAAAAAAAAAAA']) {
      Object.assign(t.props, { REGISTRY_TEST_MODE: 'true', TEST_ORG_ID: ORG_A, TEST_SUSPEND_KIND: 'suspend', TEST_SUSPEND_DAYS: '6.9' })
      if (ids === undefined) delete t.props.REGISTRY_TEST_ORG_IDS
      else t.props.REGISTRY_TEST_ORG_IDS = ids
      for (const name of ['testSuspendNow', 'testScheduleSuspension', 'testLiftSuspension']) {
        expect(() => call(t, name), `${name} ${ids}`).toThrow(/本番の団体は止められません。何も変えていません/)
      }
    }
    // TEST_ORG_ID が無い時も
    Object.assign(t.props, { REGISTRY_TEST_ORG_IDS: ORG_A, TEST_ORG_ID: '' })
    expect(() => call(t, 'testSuspendNow')).toThrow(/未設定/)
    expect(t.org()).toMatchObject({ state: 'active', suspendAt: '' })
    expect(t.mails).toHaveLength(0)
    expect(t.audit().map((a) => a.action)).not.toContain('testSuspendNow')
  })

  it('今すぐ停止する(種類を選べる)。団体の GAS の checkIn にもすぐ出る。解除で元に戻る。操作の記録に残る', () => {
    const t = ready()
    Object.assign(t.props, { REGISTRY_TEST_MODE: 'true', REGISTRY_TEST_ORG_IDS: 'org_TESTTESTTESTTEST01, ' + ORG_A, TEST_ORG_ID: ORG_A, TEST_SUSPEND_KIND: 'restrict' })
    call(t, 'testSuspendNow')
    expect(t.org()).toMatchObject({ state: 'restricted', suspendKind: 'restrict' })
    expect(t.checkIn().result).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    t.props.TEST_SUSPEND_KIND = 'suspend'
    call(t, 'testSuspendNow')
    expect(t.org().state).toBe('suspended')
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result).toMatchObject({ status: 'suspended', gasUrl: '' })
    call(t, 'testLiftSuspension')
    expect(t.org().state).toBe('active')
    expect(t.checkIn().result).toMatchObject({ phase: 'none' })
    expect(t.audit().map((a) => a.action)).toEqual(expect.arrayContaining(['testSuspendNow', 'testLiftSuspension']))
    // 記録の無い直接の編集には数えない
    expect(t.gas.findUnrecordedOrgEdits_()).toEqual([])
    t.props.TEST_SUSPEND_KIND = 'other'
    expect(() => call(t, 'testSuspendNow')).toThrow(/TEST_SUSPEND_KIND/)
  })

  it('TEST_SUSPEND_DAYS 日後に予定を入れ(14日より前でもよい)、その時期の予告を担当者にすぐ送る', () => {
    const t = ready()
    Object.assign(t.props, { REGISTRY_TEST_MODE: 'true', REGISTRY_TEST_ORG_IDS: 'org_TESTTESTTESTTEST01, ' + ORG_A, TEST_ORG_ID: ORG_A, TEST_SUSPEND_KIND: 'suspend' })
    for (const [days, notice] of [['13.9', 14], ['6.9', 7], ['0.9', 1]] as const) {
      t.props.TEST_SUSPEND_DAYS = days
      call(t, 'testScheduleSuspension')
      expect(t.org()).toMatchObject({ state: 'scheduled', noticesSent: [notice] })
      expect(t.mails.at(-1)!.subject).toContain(`あと${notice}日`)
      expect(t.mails.at(-1)!.to).toBe('yamada@example.org')
    }
    // 予告の時期より前なら送らない
    t.props.TEST_SUSPEND_DAYS = '20'
    call(t, 'testScheduleSuspension')
    expect(t.mails).toHaveLength(3)
    t.props.TEST_SUSPEND_DAYS = ''
    expect(() => call(t, 'testScheduleSuspension')).toThrow(/TEST_SUSPEND_DAYS/)
  })
})

describe('プラン(cosmo_base・ohsumi・paid)', () => {
  const setPlan = (t: ReturnType<typeof ready>, plan: string, reason = '契約の更新') =>
    t.post({ action: 'setOrgPlan', session: t.session, orgId: ORG_A, plan, reason })

  it('管理画面でプランを記録し、一覧に出す。操作の記録に残り、記録の無い変更には数えない', () => {
    const t = ready()
    expect(t.org().plan).toBe('')
    expect(setPlan(t, 'ohsumi').ok).toBe(true)
    expect(t.org().plan).toBe('ohsumi')
    expect(setPlan(t, 'paid').ok).toBe(true)
    expect(t.orgsRow().get('plan')).toBe('paid')
    expect(t.audit()).toContainEqual(expect.objectContaining({ actor: 'admin@example.com', action: 'setOrgPlan', target: ORG_A, reason: '契約の更新' }))
    expect(t.gas.findUnrecordedOrgEdits_()).toEqual([])
    // 知らないプラン・セッションが無い時は断る
    expect(setPlan(t, 'gold').error).toMatch(/プラン/)
    expect(t.post({ action: 'setOrgPlan', orgId: ORG_A, plan: 'ohsumi' }).ok).toBe(false)
    // シートを直接書き換えたプランは、記録の無い変更として見つかる
    t.orgsRow().set('plan', 'cosmo_base')
    expect(t.gas.findUnrecordedOrgEdits_()).toEqual([ORG_A])
  })

  it('有償の団体には、機能停止を入れられない(提供停止は入れられる)。テスト環境の関数でも同じ', () => {
    const t = ready()
    setPlan(t, 'paid')
    const res = t.schedule('restrict', Date.now() + 20 * DAY, 'アンケートの未回答')
    expect(res).toMatchObject({ ok: false })
    expect(res.error).toMatch(/有償プランの団体には、機能停止を入れられません/)
    expect(t.org().state).toBe('active')
    expect(t.schedule('suspend', Date.now() + 20 * DAY).ok).toBe(true)
    t.clear()
    Object.assign(t.props, { REGISTRY_TEST_MODE: 'true', REGISTRY_TEST_ORG_IDS: ORG_A, TEST_ORG_ID: ORG_A, TEST_SUSPEND_KIND: 'restrict' })
    expect(() => (t.gas.testSuspendNow as () => unknown)()).toThrow(/有償プランの団体には、機能停止を入れられません/)
  })

  it('機能停止の予定が入っている団体は、先に取り消さないと有償にできない', () => {
    const t = ready()
    setPlan(t, 'ohsumi')
    t.schedule('restrict', Date.now() + 20 * DAY, 'アンケートの未回答')
    expect(setPlan(t, 'paid').error).toMatch(/有償プランにする前に/)
    expect(t.org().plan).toBe('ohsumi')
    t.clear()
    expect(setPlan(t, 'paid').ok).toBe(true)
  })
})

describe('提供停止を当日に(緊急)', () => {
  const now = (t: ReturnType<typeof ready>, extra: Record<string, unknown> = {}) =>
    t.post({ action: 'scheduleSuspension', session: t.session, orgId: ORG_A, kind: 'suspend', immediate: true, confirm: true, reason: '規約違反(緊急)', ...extra })

  it('提供停止だけ、今すぐ停止できる。担当者にその場で知らせ、操作の記録に残す', () => {
    const t = ready()
    const res = now(t)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(t.org()).toMatchObject({ state: 'suspended', suspendKind: 'suspend', suspendReason: '規約違反(緊急)', noticesSent: [0] })
    expect(t.checkIn().result).toMatchObject({ phase: 'inEffect', kind: 'suspend' })
    expect(t.post({ action: 'resolveOrg', orgId: ORG_A }).result).toMatchObject({ status: 'suspended', gasUrl: '' })
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0]).toMatchObject({ to: 'yamada@example.org' })
    expect(t.mails[0].subject).toContain('提供を停止しました')
    expect(t.mails[0].body).toContain('規約違反(緊急)')
    expect(t.audit()).toContainEqual(expect.objectContaining({ actor: 'admin@example.com', action: 'suspendNow', target: ORG_A, reason: '規約違反(緊急)' }))
    // 毎日の予告は送らない(もう停止中)
    ;(t.gas.dailyRegistryBackup as () => unknown)()
    expect(t.mails).toHaveLength(1)
    expect(t.gas.findUnrecordedOrgEdits_()).toEqual([])
  })

  it('機能停止は当日にできない(14日より後だけ)。確認・理由・5分以内のログインが無い時も断る', () => {
    const t = ready()
    expect(now(t, { kind: 'restrict' }).error).toMatch(/当日に停止できるのは、提供停止だけです/)
    expect(now(t, { confirm: false }).error).toMatch(/確認の画面/)
    expect(now(t, { reason: '' }).error).toMatch(/理由/)
    // 当日にしない時は、提供停止も14日より後だけ
    expect(t.schedule('suspend', Date.now() + DAY).error).toMatch(/14日より後[\s\S]*当日に提供停止にする/)
    const body = { session: t.session, orgId: ORG_A, kind: 'suspend', immediate: true, confirm: true, reason: '緊急' }
    expect(() => (t.gas.scheduleSuspension_ as (b: object, n: number) => unknown)(body, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(t.org().state).toBe('active')
    expect(t.mails).toHaveLength(0)
  })
})

describe('サイトの origin の一覧(checkIn で団体の GAS に配る)', () => {
  it('SITE_ORIGINS の https の origin だけを、書いた順に返す(パス付き・http・重複は捨てる)', () => {
    const t = ready()
    expect(t.checkIn().result.siteOrigins).toEqual([])
    t.props.SITE_ORIGINS = 'https://Site-A.example.com/, https://b.example.jp\nhttp://c.example.com https://d.example.com/path https://site-a.example.com https://u:p@e.example.com https://f.example.com:8443'
    expect(t.checkIn().result.siteOrigins).toEqual(['https://site-a.example.com', 'https://b.example.jp', 'https://f.example.com:8443'])
  })
})
