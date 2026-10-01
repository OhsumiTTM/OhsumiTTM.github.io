// GAS の版(PR E)のレジストリ側: 版の一覧と印、団体ごとの判定、checkIn の「更新が要る」、
// 担当者への更新のお願いのメール、監視の毎日のまとめの数、スクリプトプロパティのキャッシュ
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const NONCE = 'register-nonce-00000001-abcdefghijklmnopqrstuvwxyz0123'
const HOUR = 3600 * 1000
const CURRENT = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8').match(/^var OHSUMI_GAS_VERSION = '([^']+)'$/m)![1]
// 最初の「安全の修正」の版(PR A を含む)
const FIRST_SECURITY = '2026.10.01-1'

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
  const code = t.post({ action: 'issueRegistrationCode', session, orgName: 'テスト団体A', contactName: '山田', contactEmail: 'yamada@example.org' }).result.code
  const key = String(t.post({ action: 'registerOrg', code, orgId: ORG_A, gasUrl: URL_A, registerNonce: NONCE }).result.registryKey)
  const checkIn = (gasVersion: string) => {
    const ts = Math.floor(Date.now() / 1000)
    return t.post({ action: 'checkIn', orgId: ORG_A, ts, gasVersion, sig: createHmac('sha256', key).update('checkIn.' + ORG_A + '.' + ts).digest('base64url') })
  }
  const org = () => t.post({ action: 'adminOverview', session }).result.orgs.find((o: { orgId: string }) => o.orgId === ORG_A)
  const mark = (version: string, marks: { security?: boolean; required?: boolean; note?: string }, s = session) =>
    t.post({ action: 'setGasVersionMarks', session: s, version, reason: '試し', ...marks })
  const orgsRow = () => {
    const rows = t.sheets.get('Orgs')!.rows
    const h = rows[0] as string[]
    const row = rows.find((r) => r[0] === ORG_A)!
    return { set: (n: string, v: unknown) => { row[h.indexOf(n)] = v } }
  }
  return { ...t, session, checkIn, org, mark, orgsRow }
}

type Status = { current: string; latest: string; minimum: string; security: boolean; versionState: string; noCheck: boolean; judgement: string }
const status = (t: ReturnType<typeof ready>, version: string, lastCheckMsAgo: number | null, versions?: unknown[]) =>
  JSON.parse(JSON.stringify(t.gas.gasVersionStatus_(
    { gas_version: version, last_check_at: lastCheckMsAgo === null ? '' : new Date(Date.now() - lastCheckMsAgo).toISOString() },
    versions ?? t.gas.gasVersionList_(), Date.now()))) as Status

describe('版の判定', () => {
  it('最新・古い・更新が要る・24時間以上確認が無い', () => {
    const t = ready()
    const versions = [
      { version: '2026.12.01-1', security: false, required: false },
      { version: '2026.11.01-2', security: true, required: false },
      { version: '2026.10.01-1', security: false, required: true },
    ]
    expect(status(t, '2026.12.01-1', HOUR, versions)).toMatchObject({ versionState: 'latest', judgement: 'latest', security: false })
    // 一覧より新しい版も「最新」
    expect(status(t, '2027.01.01-1', HOUR, versions).judgement).toBe('latest')
    expect(status(t, '2026.11.01-2', HOUR, versions)).toMatchObject({ versionState: 'outdated', judgement: 'outdated', minimum: '2026.11.01-2' })
    // 安全の修正より古い → 更新が要る
    expect(status(t, '2026.11.01-1', HOUR, versions)).toMatchObject({ versionState: 'updateRequired', security: true })
    // 日付の形でない版(PR E より前)は、どれよりも古い
    expect(status(t, 'r1e-2', HOUR, versions).versionState).toBe('updateRequired')
    // 最後の確認から24時間を超えた・一度も無い(版の判定は残す)
    expect(status(t, '2026.12.01-1', 25 * HOUR, versions)).toMatchObject({ judgement: 'noCheck', versionState: 'latest', noCheck: true })
    expect(status(t, '2026.10.01-1', null, versions)).toMatchObject({ judgement: 'noCheck', versionState: 'updateRequired' })
  })

  it('最初の「安全の修正」の版より前の団体は、更新が要る', () => {
    const t = ready()
    const list = t.gas.gasVersionList_() as { version: string; security: boolean; required: boolean }[]
    expect(list[0].version).toBe(CURRENT)
    expect(list.filter((v) => v.security).at(-1)).toMatchObject({ version: FIRST_SECURITY, security: true, required: true })
    expect(status(t, 'r1e-2', HOUR).versionState).toBe('updateRequired')
    expect(status(t, CURRENT, HOUR).versionState).toBe('latest')
  })
})

describe('checkIn と管理画面の一覧', () => {
  it('checkIn の返事で「更新が要る」を伝える。管理画面の一覧に版と判定を出す', () => {
    const t = ready()
    expect(t.checkIn('r1e-2').result.gasUpdate).toEqual({ required: true, outdated: true, latest: CURRENT, minimum: FIRST_SECURITY, security: true })
    expect(t.org().gasStatus).toMatchObject({ current: 'r1e-2', judgement: 'updateRequired', latest: CURRENT })
    expect(t.checkIn(CURRENT).result.gasUpdate).toEqual({ required: false, outdated: false, latest: CURRENT, minimum: FIRST_SECURITY, security: false })
    expect(t.org().gasStatus.judgement).toBe('latest')
    t.orgsRow().set('last_check_at', new Date(Date.now() - 30 * HOUR).toISOString())
    expect(t.org().gasStatus.judgement).toBe('noCheck')
  })

  it('管理画面で印を付けられる(記録に残る)。新しい版に「更新が要る」を付けると、古い団体は更新が要る', () => {
    const t = ready()
    t.checkIn(CURRENT)
    const res = t.mark('2099.01.01-1', { required: true, note: '大事な修正' })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.versions[0]).toMatchObject({ version: '2099.01.01-1', required: true, security: false, note: '大事な修正', updatedBy: 'admin@example.com' })
    expect(t.org().gasStatus).toMatchObject({ versionState: 'updateRequired', minimum: '2099.01.01-1', security: false })
    expect(t.checkIn(CURRENT).result.gasUpdate.required).toBe(true)
    const audit = t.sheets.get('AuditLog')!.rows.slice(1).map((r) => [r[1], r[2], r[3]])
    expect(audit).toContainEqual(['admin@example.com', 'setGasVersionMarks', '2099.01.01-1'])
    // コードの一覧にある版の印も外せる
    t.mark('2099.01.01-1', {})
    t.mark(FIRST_SECURITY, { security: false, required: false })
    expect(t.org().gasStatus.versionState).toBe('outdated')
    expect(t.post({ action: 'adminOverview', session: t.session }).result.gasVersions.map((v: { version: string }) => v.version)[0]).toBe('2099.01.01-1')
  })

  it('形の違う版・ログインしていない人は断る', () => {
    const t = ready()
    expect(t.mark('2099-01-01', { required: true }).error).toMatch(/YYYY\.MM\.DD-N/)
    expect(t.mark('2099.01.01-1', { required: true }, 'ra1.x.y').authError).toBe(true)
  })
})

describe('担当者への更新のお願い', () => {
  it('担当者にメールを送り、記録に残す。同じ団体には24時間に1回まで', () => {
    const t = ready()
    t.checkIn('r1e-2')
    const res = t.post({ action: 'requestGasUpdate', session: t.session, orgId: ORG_A, reason: '安全の修正' })
    expect(res.ok, res.error).toBe(true)
    expect(res.result).toEqual({ sentTo: 1, queued: false })
    expect(t.mails.at(-1)).toMatchObject({ to: 'yamada@example.org', subject: '[Ohsumi] テスト団体A: 団体の GAS の更新のお願い' })
    expect(t.mails.at(-1)!.body).toContain('今の版: r1e-2')
    expect(t.mails.at(-1)!.body).toContain('最新の版: ' + CURRENT)
    expect(t.mails.at(-1)!.body).toContain('安全の修正が含まれます')
    const audit = t.sheets.get('AuditLog')!.rows.slice(1).map((r) => [r[2], r[3], r[6]])
    expect(audit).toContainEqual(['requestGasUpdate', ORG_A, '安全の修正'])
    expect(t.post({ action: 'requestGasUpdate', session: t.session, orgId: ORG_A }).error).toMatch(/24時間以内/)
    expect(t.post({ action: 'requestGasUpdate', session: 'ra1.x.y', orgId: ORG_A }).authError).toBe(true)
  })
})

describe('監視の毎日のまとめの数(health に summary を付けた時だけ)', () => {
  it('更新が要る団体の数と、24時間以上確認が無い団体の数を返す', () => {
    const t = ready()
    expect(t.post({ action: 'health', key: 'hk' }).gasVersions).toBeUndefined()
    // 一度も確認に来ていない(登録したばかり)
    expect(t.post({ action: 'health', key: 'hk', summary: true }).gasVersions).toEqual({ latest: CURRENT, updateRequired: 1, noCheck: 1, dailyJobStale: 0, orgs: 1 })
    t.checkIn(CURRENT)
    expect(t.post({ action: 'health', key: 'hk', summary: true }).gasVersions).toEqual({ latest: CURRENT, updateRequired: 0, noCheck: 0, dailyJobStale: 0, orgs: 1 })
    // 鍵が無い・違う時は返さない
    expect(t.post({ action: 'health', summary: true }).gasVersions).toBeUndefined()
    expect(t.post({ action: 'health', key: 'x', summary: true }).gasVersions).toBeUndefined()
  })
})

describe('スクリプトプロパティのキャッシュ', () => {
  it('通信のたびに読み直さず、5分キャッシュに置く。GAS が書き換えた時は捨てる', () => {
    const t = ready()
    t.post({ action: 'health', key: 'hk' })
    expect(t.cacheTtl.get('registry:props')).toBe(300)
    expect(JSON.parse(t.cache.get('registry:props')!).HEALTH_KEY).toBe('hk')
    // キャッシュがある間は、スクリプトプロパティを読まない
    let reads = 0
    const real = (t.gas.PropertiesService as unknown as { getScriptProperties: () => Record<string, unknown> }).getScriptProperties
    ;(t.gas as Record<string, unknown>).PropertiesService = { getScriptProperties: () => { const p = real(); return { ...p, getProperties: () => { reads++; return (p.getProperties as () => object)() } } } }
    t.post({ action: 'health', key: 'hk' })
    t.post({ action: 'adminOverview', session: t.session })
    expect(reads).toBe(0)
    // 指紋を覚え直す操作(プランの変更)の後は、捨てて読み直す
    t.post({ action: 'setOrgPlan', session: t.session, orgId: ORG_A, plan: 'ohsumi' })
    expect(t.cache.has('registry:props')).toBe(false)
    t.post({ action: 'health', key: 'hk' })
    expect(reads).toBe(1)
  })
})
