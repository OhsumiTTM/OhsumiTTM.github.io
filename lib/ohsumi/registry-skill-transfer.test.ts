// レジストリ(registry/Code.gs)の団体をまたいだスキルの引き継ぎ(v1.2): 署名・1回だけ受け取れる・同じ団体では使えない・
// A→B→C で A の分も届く(指紋で書き換えを見つける)・取り消し・期限(180日)・入れまちがいの上限・名前やメールアドレスを持たない
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { setup, type TokenInfo } from './registry-harness'

const CLIENT = 'registry-client.apps.googleusercontent.com'
const ORGS = { A: 'org_AAAAAAAAAAAAAAAAAAAA', B: 'org_BBBBBBBBBBBBBBBBBBBB', C: 'org_CCCCCCCCCCCCCCCCCCCC' } as const
type Org = keyof typeof ORGS

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
  const keys = {} as Record<Org, string>
  ;(Object.keys(ORGS) as Org[]).forEach((o, i) => {
    const code = t.post({ action: 'issueRegistrationCode', session, plan: 'ohsumi', orgName: '団体' + o }).result.code
    keys[o] = String(t.post({ action: 'registerOrg', code, orgId: ORGS[o], gasUrl: 'https://script.google.com/macros/s/AKf' + o + '/exec',
      registerNonce: 'register-nonce-0000000' + i + '-abcdefghijklmnopqrstuvwxyz0123' }).result.registryKey)
  })
  const sign = (o: Org, kind: string, ts: number, extra: string, key = keys[o]) =>
    createHmac('sha256', key).update('skillTransfer.' + kind + '.' + ORGS[o] + '.' + ts + '.' + extra).digest('base64url')
  const ts = () => Math.floor(Date.now() / 1000)
  const create = (o: Org, record: unknown, opts: { key?: string } = {}) => {
    const text = JSON.stringify(record)
    const at = ts()
    return t.post({ action: 'createSkillTransfer', orgId: ORGS[o], ts: at, record: text, sig: sign(o, 'create', at, text, opts.key) })
  }
  const claim = (o: Org, code: string) => {
    const norm = code.toUpperCase().replace(/[\s\-_]/g, '')
    const at = ts()
    return t.post({ action: 'claimSkillTransfer', orgId: ORGS[o], ts: at, code, sig: sign(o, 'claim', at, norm) })
  }
  const cancel = (o: Org, transferId: string) => {
    const at = ts()
    return t.post({ action: 'cancelSkillTransfer', orgId: ORGS[o], ts: at, transferId, sig: sign(o, 'cancel', at, transferId) })
  }
  const rows = () => t.sheets.get('SkillTransfers')!.rows as unknown[][]
  return { ...t, keys, sign, create, claim, cancel, rows }
}

const recordA = { originKey: 'person-a-0001', own: { points: { デザイン: 120, Canva: 30 }, levels: [{ skill: 'デザイン', level: 2 }], qualifications: [{ name: '色彩検定3級', acquiredDate: '2025-06-01', issuer: '協会' }] }, carried: [] }

describe('スキルの引き継ぎ(レジストリ)', () => {
  it('コードを作り、ほかの団体が1回だけ受け取れる。元の団体の名前はレジストリが付ける。中身は受け取った後に消す', () => {
    const t = ready()
    const made = t.create('A', recordA)
    expect(made.ok, JSON.stringify(made)).toBe(true)
    expect(made.result.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    const days = (Date.parse(made.result.expiresAt) - Date.now()) / 86400000
    expect(days).toBeGreaterThan(179.9)
    expect(days).toBeLessThan(180.1)
    // 同じ団体では使えない
    expect(t.claim('A', made.result.code).error).toContain('同じ団体')
    const got = t.claim('B', made.result.code.toLowerCase())
    expect(got.ok, JSON.stringify(got)).toBe(true)
    expect(got.result.entries).toEqual([expect.objectContaining({ transferId: made.result.transferId, originOrgName: '団体A', via: '',
      points: { Canva: 30, デザイン: 120 }, levels: [{ skill: 'デザイン', level: 2 }] })])
    expect(t.claim('C', made.result.code).error).toContain('使えなくなっています')
    const row = t.rows().find((r) => r[0] === made.result.transferId)!
    const head = t.rows()[0]
    expect(row[head.indexOf('status')]).toBe('claimed')
    expect(row[head.indexOf('payload_json')]).toBe('')
    // 名前・メールアドレス・コードそのものは持たない
    expect(JSON.stringify(t.rows())).not.toContain(made.result.code.replace(/-/g, ''))
  })

  it('A→B→C: B が A の分を転送すると C に A の分も届く。書き換えた転送は断る', () => {
    const t = ready()
    const a = t.create('A', recordA)
    const fromA = t.claim('B', a.result.code).result.entries[0]
    const ownB = { points: { 企画: 40 }, levels: [], qualifications: [] }
    const carried = { transferId: fromA.transferId, points: fromA.points, levels: fromA.levels, qualifications: fromA.qualifications }
    // 点数を書き換えた転送は断る
    expect(t.create('B', { originKey: 'person-b-0001', own: ownB, carried: [{ ...carried, points: { デザイン: 9999 } }] }).error).toContain('中身と違います')
    expect(t.create('B', { originKey: 'person-b-0001', own: ownB, carried: [{ ...carried, transferId: 'st_nope' }] }).error).toContain('中身と違います')
    const b = t.create('B', { originKey: 'person-b-0001', own: ownB, carried: [carried] })
    expect(b.ok, JSON.stringify(b)).toBe(true)
    const got = t.claim('C', b.result.code).result.entries
    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ originOrgName: '団体B', via: '', points: { 企画: 40 } })
    expect(got[1]).toMatchObject({ transferId: fromA.transferId, originOrgName: '団体A', via: '団体B', points: { Canva: 30, デザイン: 120 } })
    // 出どころの印はレジストリが覚えた値(団体ID + 元の団体が付けた印)
    expect(got[0].originKey).toBe(ORGS.B + ':person-b-0001')
    expect(got[1].originKey).toBe(ORGS.A + ':person-a-0001')
    expect(t.create('A', { own: recordA.own, carried: [] }).error).toContain('originKey')
  })

  it('取り消し(作った団体だけ)・180日で使えなくなる・署名違い・入れまちがいの上限', () => {
    const t = ready()
    const a = t.create('A', recordA)
    expect(t.cancel('B', a.result.transferId).ok).toBe(false)
    expect(t.cancel('A', a.result.transferId).result).toEqual({ status: 'cancelled' })
    expect(t.claim('B', a.result.code).ok).toBe(false)
    // 期限
    const b = t.create('A', recordA)
    const later = Date.now() + 181 * 86400000
    const at = Math.floor(later / 1000)
    const norm = b.result.code.replace(/-/g, '')
    expect(() => t.gas.claimSkillTransfer_({ orgId: ORGS.B, ts: at, code: b.result.code, sig: t.sign('B', 'claim', at, norm) }, later)).toThrow(/使えなくなっています/)
    // 署名違い
    expect(t.create('A', recordA, { key: 'wrong' })).toMatchObject({ ok: false, authError: true })
    // 入れまちがいは1時間20回まで
    for (let i = 0; i < 20; i++) expect(t.claim('C', 'ZZZZ-ZZZZ-ZZZ' + 'ABCDEFGHJKMNPQRSTUVW'[i]).ok).toBe(false)
    const c = t.create('A', recordA)
    expect(t.claim('C', c.result.code).error).toContain('1時間ほど')
  })
})
