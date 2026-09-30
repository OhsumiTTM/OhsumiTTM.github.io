// ほかの端末で開く: 団体の GAS が、ログインしている本人の登録済みのアドレスにだけ招待リンクを送ること
// (宛先は画面から受け取らない・1人1時間に3回まで・レジストリに確かめた origin だけ・機能停止中も使える・テスト環境の宛先)
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const ORG = 'org_INVITEINVITEINVITE01'
const HOUR = 3600 * 1000

type Mail = { to: string; subject: string; body: string }

function setup(opts: { contract?: Record<string, unknown> | null; props?: Record<string, string>; emails?: Record<string, string> } = {}) {
  const cache = new Map<string, string>()
  const mails: Mail[] = []
  const clock = { now: Date.UTC(2026, 9, 1, 3) }
  const contract = opts.contract === undefined
    ? { phase: 'none', kind: 'suspend', suspendAt: '', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['https://site.example.com', 'https://new.example.jp'] }
    : opts.contract
  const props: Record<string, string> = { ORG_ID: ORG, ...(contract ? { CONTRACT_STATE: JSON.stringify(contract) } : {}), ...(opts.props ?? {}) }
  const emails = opts.emails ?? { m1: 'me@example.com, me.alt@example.com', m2: '' }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log(m: string) { if (process.env.DEBUG_INVITE) console.error(m) } },
    Date: class extends Date {
      constructor(...args: unknown[]) { if (args.length) super(args[0] as number); else super(clock.now) }
      static now() { return clock.now }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: string) => { props[k] = v } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v) } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { flush() {} },
    MailApp: { sendEmail: (m: Mail) => { mails.push(m) } },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      formatDate: () => '2026-10-01',
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a: string, v: string) => [...createHash('sha256').update(v, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (b: number[]) => Buffer.from(b.map((x) => x & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.authenticateRequest_ = (body: { sessionToken: string }) => ({ memberId: body.sessionToken })
  c.getActingMember_ = (id: string) => ({ id, role: '一般', project_ids: [], permission_overrides: [] })
  c.getActingMemberById_ = c.getActingMember_
  c.getMemberEmailValueCached_ = (id: string) => emails[id] ?? ''
  c.readRoleSettings_ = () => ({})
  c.getSettingValue_ = (k: string) => (k === 'org_name' ? 'テスト団体' : '')
  // レジストリへの確認はしない(CONTRACT_STATE をそのまま使う)
  c.refreshContractState_ = () => null
  let requestNo = 0
  const post = (body: Record<string, unknown>) => {
    const out = (ctx as unknown as { doPost: (e: object) => { text: string } }).doPost({ postData: { contents: JSON.stringify({ sessionToken: 'm1', requestId: 'req-' + String(++requestNo).padStart(8, '0'), ...body }) } })
    return JSON.parse(out.text)
  }
  return { post, mails, clock, props, cache }
}

describe('本人あての招待リンクのメール(sendInviteLinkToMe)', () => {
  it('本人の登録済みのアドレス(すべて)にだけ、団体ID だけを入れたリンクを送る。宛先・リンクは画面から受け取らない', () => {
    const t = setup()
    const res = t.post({ action: 'sendInviteLinkToMe', siteOrigin: 'https://site.example.com', to: 'attacker@evil.example', email: 'attacker@evil.example', link: 'https://evil.example/' })
    expect(res.ok, res.error).toBe(true)
    expect(res.result).toMatchObject({ sent: true, count: 2, remaining: 2 })
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0].to).toBe('me@example.com,me.alt@example.com')
    expect(t.mails[0].body).toContain('https://site.example.com/?org=' + ORG)
    expect(t.mails[0].body).not.toMatch(/evil|sessionToken|m1|me@example\.com/)
    expect(t.mails[0].subject).toContain('テスト団体')
  })

  it('画面が開いている origin が一覧にあればそれを、無ければ一覧の最初を使う', () => {
    const t = setup()
    t.post({ action: 'sendInviteLinkToMe', siteOrigin: 'https://new.example.jp/' })
    t.post({ action: 'sendInviteLinkToMe', siteOrigin: 'https://evil.example' })
    expect(t.mails[0].body).toContain('https://new.example.jp/?org=' + ORG)
    expect(t.mails[1].body).toContain('https://site.example.com/?org=' + ORG)
    expect(t.mails[1].body).not.toContain('evil')
  })

  it('送れるのは1人1時間に3回まで。1時間たてば、また送れる。ほかのメンバーは別に数える', () => {
    const t = setup({ emails: { m1: 'me@example.com', m3: 'other@example.com' } })
    for (let i = 0; i < 3; i++) expect(t.post({ action: 'sendInviteLinkToMe' }).ok).toBe(true)
    const over = t.post({ action: 'sendInviteLinkToMe' })
    expect(over).toMatchObject({ ok: false })
    expect(over.error).toMatch(/1時間に3回まで/)
    expect(t.mails).toHaveLength(3)
    expect(t.post({ action: 'getInviteMailStatus' }).result).toMatchObject({ available: false, reason: 'limit', remaining: 0 })
    expect(t.post({ action: 'sendInviteLinkToMe', sessionToken: 'm3' }).ok).toBe(true)
    t.clock.now += HOUR + 1000
    expect(t.post({ action: 'sendInviteLinkToMe' }).ok).toBe(true)
    expect(t.mails).toHaveLength(5)
  })

  it('同じ requestId で送り直されても、2通目は送らない', () => {
    const t = setup()
    t.post({ action: 'sendInviteLinkToMe', requestId: 'invite-00000001' })
    const again = t.post({ action: 'sendInviteLinkToMe', requestId: 'invite-00000001' })
    expect(again).toMatchObject({ ok: true, replayed: true })
    expect(t.mails).toHaveLength(1)
  })

  it.each([
    ['レジストリに一度も確かめていない', null],
    ['確かめたが origin の一覧が無い(古いレジストリ)', { phase: 'none', kind: 'suspend', suspendAt: '', checkedAt: '2026-10-01T00:00:00.000Z' }],
    ['一覧の形が違う', { phase: 'none', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['http://site.example.com', 'https://a.example.com/path'] }],
  ])('%s団体では送れない', (_label, contract) => {
    const t = setup({ contract })
    expect(t.post({ action: 'getInviteMailStatus' }).result).toMatchObject({ available: false, reason: 'notChecked' })
    const res = t.post({ action: 'sendInviteLinkToMe' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/まだメールで送れません/)
    expect(t.mails).toHaveLength(0)
  })

  it('メールアドレスが登録されていなければ送れない', () => {
    const t = setup()
    expect(t.post({ action: 'getInviteMailStatus', sessionToken: 'm2' }).result).toMatchObject({ available: false, reason: 'noEmail' })
    expect(t.post({ action: 'sendInviteLinkToMe', sessionToken: 'm2' }).ok).toBe(false)
    expect(t.mails).toHaveLength(0)
  })

  it('機能停止中(読み取り専用)も使える。提供停止中は使えない', () => {
    const restricted = setup({ contract: { phase: 'inEffect', kind: 'restrict', suspendAt: '2026-09-01T00:00:00.000Z', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['https://site.example.com'] } })
    expect(restricted.post({ action: 'getInviteMailStatus' }).result).toMatchObject({ available: true, remaining: 3 })
    expect(restricted.post({ action: 'sendInviteLinkToMe' }).ok).toBe(true)
    expect(restricted.mails).toHaveLength(1)
    const suspended = setup({ contract: { phase: 'inEffect', kind: 'suspend', suspendAt: '2026-09-01T00:00:00.000Z', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['https://site.example.com'] } })
    expect(suspended.post({ action: 'sendInviteLinkToMe' })).toMatchObject({ ok: false, orgSuspended: true })
    expect(suspended.mails).toHaveLength(0)
  })

  it('テスト環境では、TEST_NOTIFICATION_EMAIL にだけ送る(未設定なら送らない)', () => {
    const t = setup({ props: { TEST_ENVIRONMENT: 'true', TEST_NOTIFICATION_EMAIL: 'test-inbox@example.com' } })
    expect(t.post({ action: 'sendInviteLinkToMe' }).ok).toBe(true)
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0].to).toBe('test-inbox@example.com')
    expect(t.mails[0].subject).toMatch(/^\[テスト\]/)
    const none = setup({ props: { TEST_ENVIRONMENT: 'true' } })
    expect(none.post({ action: 'sendInviteLinkToMe' }).ok).toBe(true)
    expect(none.mails).toHaveLength(0)
  })

  it('locale が en なら英語の文面にする', () => {
    const t = setup()
    t.post({ action: 'sendInviteLinkToMe', locale: 'en' })
    expect(t.mails[0].subject).toMatch(/another device/)
  })
})
