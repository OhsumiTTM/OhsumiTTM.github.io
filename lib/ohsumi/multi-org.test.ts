// 兼部の統合表示(lib/ohsumi/multi-org.ts)を確かめる: 団体ごとの読み込み(ログインが無い・切れた・停止・古い GAS・
// 時間切れ)、データの版が同じ時の使い回し、同時に読む数、まとめ方(日程調整の候補は「回答待ち」で予定に出さない)、
// 切り替えずにログインし直す窓からのメッセージの確かめ方、今の通信のセッションを変えないこと
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const ORG_B = 'org_BBBBBBBBBBBBBBBBBBBB'
const ORG_C = 'org_CCCCCCCCCCCCCCCCCCCC'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const URL_B = 'https://script.google.com/macros/s/AKfyB/exec'
const URL_C = 'https://script.google.com/macros/s/AKfyC/exec'
const ORIGIN = 'https://site.example'

let local: MemoryStorage
let session: MemoryStorage

beforeEach(() => {
  vi.resetModules()
  local = new MemoryStorage()
  session = new MemoryStorage()
  vi.stubGlobal('window', { localStorage: local, sessionStorage: session, location: { href: ORIGIN + '/', search: '', pathname: '/', origin: ORIGIN } })
  const saved = (orgId: string, gasUrl: string, name: string) => ({ orgId, gasUrl, name, source: 'registry', checkedAt: Date.now(), maxAgeSec: 86400 })
  local.setItem('ohsumi-orgs', JSON.stringify([saved(ORG_A, URL_A, '団体A'), saved(ORG_B, URL_B, '団体B'), saved(ORG_C, URL_C, '団体C')]))
  local.setItem('ohsumi-current-org', ORG_B)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const load = async () => ({ m: await import('./multi-org'), s: await import('./session') })
const future = () => Math.floor(Date.now() / 1000) + 3600
const login = (orgId: string, remember = true) =>
  (remember ? local : session).setItem('ohsumi-session-' + orgId, JSON.stringify({ token: 'tok-' + orgId, exp: future() }))

const digest = (over: Record<string, unknown> = {}) => ({
  orgName: '団体A', themeColor: '#123456', memberId: 'm1', memberName: '本人', contract: { phase: '', kind: '' },
  tasks: [], truncated: false, counts: { assigned: 0, reviewWaiting: 0, overdue: 0, unanswered: 0 }, version: 'v1', ...over,
})

describe('団体の一覧', () => {
  it('今の団体が先頭。団体が2つ以上ある時だけ切り替えを出す', async () => {
    const { m } = await load()
    expect(m.digestOrgs().map((o) => [o.orgId, o.current])).toEqual([[ORG_B, true], [ORG_A, false], [ORG_C, false]])
    expect(m.hasMultipleOrgs()).toBe(true)
    local.setItem('ohsumi-orgs', JSON.stringify([JSON.parse(local.getItem('ohsumi-orgs')!)[0]]))
    expect(m.hasMultipleOrgs()).toBe(false)
    expect(m.shortOrgName('とても長い団体の名前')).toBe('とても長')
  })
})

describe('fetchOrgDigest', () => {
  it('ログインが無い団体には送らない。答えの種類ごとに分ける', async () => {
    const { m } = await load()
    const sent: Record<string, unknown>[] = []
    let reply: Record<string, unknown> = {}
    m.setDigestSenderForTest(async (url, body) => { sent.push({ url, ...body }); return reply as never })
    const org = { orgId: ORG_A, gasUrl: URL_A }
    expect(await m.fetchOrgDigest(org)).toEqual({ kind: 'loginNeeded' })
    expect(sent).toHaveLength(0)
    login(ORG_A)
    reply = { ok: false, authError: true, error: 'x' }
    expect(await m.fetchOrgDigest(org)).toEqual({ kind: 'loginNeeded' })
    expect(sent[0]).toMatchObject({ url: URL_A, action: 'getMyDigest', sessionToken: 'tok-' + ORG_A })
    expect(sent[0].from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    reply = { ok: false, orgSuspended: true }
    expect(await m.fetchOrgDigest(org)).toEqual({ kind: 'suspended' })
    reply = { ok: false, error: 'Unknown action: getMyDigest' }
    expect(await m.fetchOrgDigest(org)).toEqual({ kind: 'oldGas' })
    reply = { ok: false, error: '失敗' }
    expect(await m.fetchOrgDigest(org)).toEqual({ kind: 'error', message: '失敗' })
    m.setDigestSenderForTest(() => new Promise(() => {}))
    expect(await m.fetchOrgDigest(org, new Date(), 20)).toEqual({ kind: 'error', message: 'timeout' })
  })

  it('データの版が同じなら、前の答えを使う(knownVersion を送る)。延長されたトークンは、その団体の保存に入れる', async () => {
    const { m, s } = await load()
    login(ORG_A, false)
    const sent: Record<string, unknown>[] = []
    const replies = [
      { ok: true, result: digest({ tasks: [{ id: 't1', title: 'A', role: 'assignee' }] }), session: { token: 'renewed', exp: future() } },
      { ok: true, result: { version: 'v1', unchanged: true } },
    ]
    m.setDigestSenderForTest(async (_url, body) => { sent.push(body); return replies.shift() as never })
    const first = await m.fetchOrgDigest({ orgId: ORG_A, gasUrl: URL_A })
    expect(first.kind).toBe('ok')
    // 保存場所は元のまま(sessionStorage)
    expect(JSON.parse(session.getItem('ohsumi-session-' + ORG_A)!).token).toBe('renewed')
    expect(local.getItem('ohsumi-session-' + ORG_A)).toBeNull()
    // 今の通信に使うセッションは変えない
    expect(s.getActiveOrgId()).toBeNull()
    const second = await m.fetchOrgDigest({ orgId: ORG_A, gasUrl: URL_A })
    expect(sent[1].knownVersion).toBe('v1')
    expect(sent[1].sessionToken).toBe('renewed')
    expect(second).toEqual(first)
  })

  it('同時に読むのは4団体まで', async () => {
    const { m } = await load()
    const orgs = Array.from({ length: 7 }, (_, i) => ({ orgId: `org_${String(i).repeat(20)}`, gasUrl: URL_A }))
    orgs.forEach((o) => login(o.orgId))
    let running = 0
    let peak = 0
    m.setDigestSenderForTest(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { ok: true, result: digest() } as never
    })
    const got: string[] = []
    await m.fetchAllDigests(orgs, (id) => got.push(id))
    expect(got.sort()).toEqual(orgs.map((o) => o.orgId).sort())
    expect(peak).toBe(4)
  })
})

describe('combineDigests', () => {
  it('期限切れ・今日・確認待ち・回答待ち・7日の予定に分ける。日程調整の候補は予定に出さず回答待ちに出す', async () => {
    const { m } = await load()
    const t = (id: string, over: Record<string, unknown>) => ({ id, title: id, status: 'in_progress', role: 'assignee', overdue: false, dueDate: '', dueTime: '', startDate: '', priority: '', importance: '', projectName: '', ...over })
    const orgs = m.digestOrgs()
    const combined = m.combineDigests(orgs, {
      [ORG_B]: { kind: 'ok', digest: digest({ orgName: '団体B', tasks: [
        t('late', { overdue: true, dueDate: '2026-10-01' }),
        t('today', { dueDate: '2026-10-08' }),
        t('soon', { dueDate: '2026-10-12' }),
        t('later', { dueDate: '2026-10-30' }),
        t('starts', { startDate: '2026-10-10' }),
        t('sched', { role: 'invitee', inviteKind: 'schedule', candidates: [{ id: 'c1', label: '10/10', date: '2026-10-10', startTime: '', endTime: '' }] }),
      ] }) as never },
      [ORG_A]: { kind: 'ok', digest: digest({ tasks: [t('rv', { role: 'reviewTarget', status: 'review', dueDate: '2026-10-09' })] }) as never },
      [ORG_C]: { kind: 'loginNeeded' },
    }, '2026-10-08')
    expect(combined.today.map((x) => x.id)).toEqual(['late', 'today'])
    expect(combined.review.map((x) => [x.id, x.orgName])).toEqual([['rv', '団体A']])
    expect(combined.unanswered.map((x) => x.id)).toEqual(['sched'])
    expect(combined.week.map((x) => x.id)).toEqual(['starts', 'soon'])
    expect(combined.perOrg.map((o) => [o.orgId, o.state])).toEqual([[ORG_B, 'ok'], [ORG_A, 'ok'], [ORG_C, 'loginNeeded']])
    // 読めていない団体は、保存した団体名で出す
    expect(combined.perOrg[2].orgName).toBe('団体C')
  })
})

describe('切り替えずにログインし直す', () => {
  it('同じオリジン・この端末の団体・正しい形のメッセージだけ受け取る', async () => {
    const { m } = await load()
    const session = { token: 't', exp: future(), remember: true }
    const ok = { origin: ORIGIN, data: { type: 'ohsumi-relogin', orgId: ORG_A, session } }
    expect(m.parseReloginMessage(ok, ORIGIN)).toEqual({ type: 'ohsumi-relogin', orgId: ORG_A, session })
    expect(m.parseReloginMessage({ ...ok, origin: 'https://evil.example' }, ORIGIN)).toBeNull()
    expect(m.parseReloginMessage({ origin: ORIGIN, data: { ...ok.data, orgId: 'org_ZZZZZZZZZZZZZZZZZZZZ' } }, ORIGIN)).toBeNull()
    expect(m.parseReloginMessage({ origin: ORIGIN, data: { ...ok.data, session: { token: 1 } } }, ORIGIN)).toBeNull()
    expect(m.parseReloginMessage({ origin: ORIGIN, data: 'hello' }, ORIGIN)).toBeNull()
    expect(m.isReloginSearch('?org=' + ORG_A + '&relogin=1')).toBe(true)
    expect(m.isReloginSearch('?org=' + ORG_A)).toBe(false)
    expect(m.reloginUrl(ORG_A, '/')).toBe('/?org=' + ORG_A + '&relogin=1')
  })

  it('ほかの団体のセッションを保存しても、今の団体・今の通信のセッション・団体ごとの保存は変えない', async () => {
    const { s } = await load()
    s.activateSession(ORG_B, { token: 'b', exp: future(), remember: true })
    local.setItem('ohsumi-state-v2', 'B の画面の状態')
    s.storeSessionFor(ORG_A, { token: 'a', exp: future(), remember: false })
    expect(s.getSessionToken()).toBe('b')
    expect(s.getActiveOrgId()).toBe(ORG_B)
    expect(JSON.parse(session.getItem('ohsumi-session-' + ORG_A)!).token).toBe('a')
    expect(local.getItem('ohsumi-current-org')).toBe(ORG_B)
    expect(local.getItem('ohsumi-state-v2')).toBe('B の画面の状態')
  })

  it('切り替えた後に開くタスクは、その団体の時だけ1回', async () => {
    const { m } = await load()
    m.rememberTaskToOpen(ORG_A, 't9')
    expect(m.takeTaskToOpen(ORG_B)).toBeNull()
    m.rememberTaskToOpen(ORG_A, 't9')
    expect(m.takeTaskToOpen(ORG_A)).toBe('t9')
    expect(m.takeTaskToOpen(ORG_A)).toBeNull()
  })

  it('送る側は postMessage の宛先を自分のサイトの origin に限り、受け取る側は origin とこの画面が開いた窓を確かめる', () => {
    const root = join(__dirname, '..', '..')
    const sender = readFileSync(join(root, 'components/ohsumi/relogin-window.tsx'), 'utf8')
    const receiver = readFileSync(join(root, 'components/ohsumi/output/all-orgs-view.tsx'), 'utf8')
    const posts = sender.match(/postMessage\([^)]*\)/g) ?? []
    expect(posts).toEqual(['postMessage(message, window.location.origin)'])
    expect(sender).not.toMatch(/postMessage\([^)]*['"]\*['"]/)
    expect(receiver).toContain('parseReloginMessage(e, window.location.origin)')
    expect(receiver).toContain('e.source !== popupRef.current')
    // 窓は、ボタンを押した処理の中で、await を挟まずに開く
    const relogin = receiver.slice(receiver.indexOf('const relogin = '), receiver.indexOf('popupRef.current = w'))
    expect(relogin).toContain('window.open(')
    expect(relogin).not.toMatch(/await|then\(|setTimeout/)
  })
})
