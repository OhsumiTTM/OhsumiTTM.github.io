// 団体の GAS(gas/Code.gs)の R1-e: レジストリの checkIn で提供停止・機能停止の状態を確かめ、
// 提供停止中はすべて断り、機能停止中は読み取りだけを受け付けること。停止の予告を代表にメールで送ること。
// レジストリへの通信は、テストの中でレジストリのコード(registry/Code.gs)につなぐ
import { describe, expect, it } from 'vitest'
import { CODE_GS, org, registry } from './gas-org-harness'

const DAY = 24 * 3600 * 1000
const MEMBERS = [['id', 'name', 'role'], ['m1', '代表さん', 'top'], ['m2', '一般さん', 'base']]
const EMAILS = { 'top@example.com': 'm1', 'base@example.com': 'm2' }

// レジストリに登録した団体。reg.setOrg でレジストリの Orgs の行(停止の予定)を書き換える
function pair() {
  const reg = registry()
  const o = org(reg, { members: MEMBERS.map((r) => r.slice()), emails: EMAILS })
  o.register(reg.issue().code)
  const orgs = reg.sheets.get('Orgs')!
  const setOrg = (fields: Record<string, string>) => {
    for (const [k, v] of Object.entries(fields)) (orgs.rows[1] as unknown[])[(orgs.rows[0] as string[]).indexOf(k)] = v
  }
  const orgValue = (k: string) => (orgs.rows[1] as unknown[])[(orgs.rows[0] as string[]).indexOf(k)]
  const g = o.gas as unknown as Record<string, (...a: unknown[]) => unknown>
  return { reg, o, g, setOrg, orgValue }
}

type Pair = ReturnType<typeof pair>

const iso = (ms: number) => new Date(ms).toISOString()
const check = (p: Pair) => p.g.checkContractStatus()
const state = (p: Pair) => JSON.parse(p.o.props.CONTRACT_STATE ?? 'null')

describe('レジストリに状態を確かめる(checkIn)', () => {
  it('共有鍵の署名で確かめ、状態を CONTRACT_STATE に覚える。レジストリには確かめた時刻と版が残る。共有鍵は送らない', () => {
    const p = pair()
    check(p)
    expect(state(p)).toMatchObject({ phase: 'none' })
    const sent = p.o.sent.at(-1)!
    expect(sent).toMatchObject({ action: 'checkIn', orgId: p.o.props.ORG_ID, gasVersion: 'r1e-1' })
    expect(sent.sig).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(sent)).not.toContain(p.o.props.REGISTRY_SHARED_KEY)
    expect(String(p.orgValue('last_check_at'))).toMatch(/^\d{4}-/)
    expect(p.orgValue('gas_version')).toBe('r1e-1')
  })

  it('確かめられない時(鍵が違う・通信エラー)は null を返し、覚えた状態を変えない', () => {
    const p = pair()
    p.setOrg({ suspend_at: iso(Date.now() + 20 * DAY), suspend_kind: 'restrict' })
    check(p)
    const before = p.o.props.CONTRACT_STATE
    expect(state(p)).toMatchObject({ phase: 'scheduled', kind: 'restrict' })
    p.o.props.REGISTRY_SHARED_KEY = 'wrong-key'
    expect(p.g.refreshContractState_()).toBeNull()
    expect(p.g.refreshContractState_({ fetch: () => { throw new Error('offline') } })).toBeNull()
    expect(p.o.props.CONTRACT_STATE).toBe(before)
  })

  it('レジストリに登録していない団体は、問い合わせない', () => {
    const reg = registry()
    const o = org(reg)
    expect((o.gas as unknown as Record<string, () => unknown>).refreshContractState_()).toBeNull()
    expect(o.fetches()).toBe(0)
  })

  it('予定の日時を過ぎていれば、確かめ直す前でも停止中とする(純粋な関数)', () => {
    const p = pair()
    const now = Date.parse('2026-11-01T00:00:00Z')
    const eff = (s: unknown) => p.g.effectiveContract_(s, now)
    expect(eff(null)).toEqual({ phase: 'none', kind: '', suspendAt: '' })
    expect(eff({ phase: 'scheduled', kind: 'restrict', suspendAt: '2026-10-31T00:00:00Z' })).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    expect(eff({ phase: 'scheduled', kind: 'suspend', suspendAt: '2026-11-02T00:00:00Z' })).toMatchObject({ phase: 'scheduled', kind: 'suspend' })
    expect(eff({ phase: 'inEffect', kind: 'other' })).toMatchObject({ phase: 'inEffect', kind: 'suspend' })
    expect(eff({ phase: 'scheduled', suspendAt: 'x' })).toMatchObject({ phase: 'none' })
  })
})

describe('提供停止(suspend)', () => {
  it('ログインの設定以外のすべての操作を断り、ログイン画面には停止中と伝える', () => {
    const p = pair()
    p.setOrg({ suspend_at: iso(Date.now() - 1000), suspend_kind: 'suspend' })
    check(p)
    for (const action of ['createTasks', 'getInitialData', 'exchangeIdToken', 'batch']) {
      const res = p.o.post({ action, ops: [{ action: 'updateTaskStatus' }] })
      expect(res, action).toMatchObject({ ok: false, orgSuspended: true, error: 'この団体は、Ohsumi の利用を停止しています。' })
      expect(res.contract, action).toMatchObject({ phase: 'inEffect', kind: 'suspend' })
    }
    expect(p.o.post({ action: 'getLoginConfig' }).result).toEqual({ orgId: p.o.props.ORG_ID, suspended: true })
  })

  it('レジストリで解除すると、1分以内(次に確かめた時)に元に戻る', () => {
    const p = pair()
    p.setOrg({ suspend_at: iso(Date.now() - 1000) })
    check(p)
    expect(p.o.post({ action: 'createTasks' }).orgSuspended).toBe(true)
    p.setOrg({ suspend_at: '' })
    // 1分に1回までしか確かめ直さない
    expect(p.o.post({ action: 'createTasks' }).orgSuspended).toBe(true)
    p.o.cache.clear()
    const res = p.o.post({ action: 'createTasks' })
    expect(res.orgSuspended).toBeUndefined()
    // ログインしていないので、ここから先はセッションで断られる
    expect(res.authError).toBe(true)
    expect(res.contract).toBeUndefined()
  })

  it('レジストリに確かめられなくても、最後に届いた予定の日時を過ぎたら停止する', () => {
    const p = pair()
    p.o.props.CONTRACT_STATE = JSON.stringify({ phase: 'scheduled', kind: 'suspend', suspendAt: iso(Date.now() - 1000) })
    p.o.props.REGISTRY_URL = ''
    expect(p.o.post({ action: 'createTasks' }).orgSuspended).toBe(true)
  })

  it('通知と毎朝の処理を止める', () => {
    const p = pair()
    const c = p.o.c
    let notified = 0
    let generated = 0
    c.memberEmailsByIds_ = () => { notified++; return [] }
    c.flushPendingLastLogins_ = () => 0
    c.generateRecurringTasksLocked_ = () => { generated++ }
    for (const f of ['notifyOverdueTasksToDiscord_', 'notifyOverdueTasksToAssignees_', 'notifyInactiveMembers_', 'bumpDataVersion']) c[f] = () => undefined
    p.o.props.notif_queue_m1 = JSON.stringify([{ kind: 'x', ts: 0, templates: {} }])
    p.o.props.CONTRACT_STATE = JSON.stringify({ phase: 'inEffect', kind: 'suspend', suspendAt: iso(Date.now() - 1000) })
    p.g.sendBatchNotifications()
    p.g.dailyMaintenance()
    expect([notified, generated]).toEqual([0, 0])
    // 機能停止中は止めない
    p.o.props.CONTRACT_STATE = JSON.stringify({ phase: 'inEffect', kind: 'restrict', suspendAt: iso(Date.now() - 1000) })
    p.g.sendBatchNotifications()
    p.g.dailyMaintenance()
    expect([notified, generated]).toEqual([1, 1])
  })
})

describe('機能停止(restrict)', () => {
  it('作成・編集は断り、アンケートへの回答をお願いする。ログイン・読み取りは受け付ける', () => {
    const p = pair()
    p.setOrg({ suspend_at: iso(Date.now() - 1000), suspend_kind: 'restrict' })
    check(p)
    for (const action of ['createTasks', 'updateTaskStatus', 'updateLocale', 'submitExpenseApplication', 'batch']) {
      const res = p.o.post({ action, ops: [{ action: 'updateTaskStatus' }] })
      expect(res, action).toMatchObject({ ok: false, restricted: true })
      expect(res.error, action).toContain('アンケートへの回答をお願いします。回答が確認でき次第、再開します。')
    }
    // 読み取りは、停止では断らない(ここではログインしていないので、セッションで断られる)
    for (const action of ['getInitialData', 'getExpenses', 'getFiles', 'getBackgroundData']) {
      const res = p.o.post({ action })
      expect(res.restricted, action).toBeUndefined()
      expect(res.authError, action).toBe(true)
      expect(res.contract, action).toEqual({ phase: 'inEffect', kind: 'restrict', suspendAt: expect.stringMatching(/^\d{4}-/) })
    }
    expect(p.o.post({ action: 'getLoginConfig' }).result).toEqual({ orgId: p.o.props.ORG_ID })
  })
})

describe('停止の予定の予告', () => {
  it('14日前・7日前・1日前に、代表にだけメールで知らせる(同じ予告は1回)。画面には理由を渡さない', () => {
    const p = pair()
    const at = Date.now() + 13.5 * DAY
    p.setOrg({ suspend_at: iso(at), suspend_kind: 'restrict', suspend_reason: 'アンケートの未回答' })
    check(p)
    expect(p.o.mails).toHaveLength(1)
    expect(p.o.mails[0].to).toBe('top@example.com')
    expect(p.o.mails[0].subject).toContain('テスト団体: 2026/10/01 12:00 から読み取り専用になります(あと14日)')
    expect(p.o.mails[0].body).toContain('アンケートの未回答')
    check(p)
    expect(p.o.mails).toHaveLength(1)
    // 7日前・1日前
    const send = (now: number) => p.g.sendContractNotices_(state(p), now)
    expect(send(at - 6.5 * DAY)).toBe(7)
    expect(send(at - 6 * DAY)).toBeNull()
    expect(send(at - 0.5 * DAY)).toBe(1)
    expect(p.o.mails.map((m) => m.subject)).toEqual([
      expect.stringContaining('あと14日'), expect.stringContaining('あと7日'), expect.stringContaining('あと1日'),
    ])
    // 画面に渡す状態には、理由を入れない
    const res = p.o.post({ action: 'getInitialData' })
    expect(res.contract).toEqual({ phase: 'scheduled', kind: 'restrict', suspendAt: iso(at) })
  })

  it('予定が変わったら(日時・種類)、予告を数え直す。予定が無ければ送らない', () => {
    const p = pair()
    const at = Date.now() + 10 * DAY
    p.setOrg({ suspend_at: iso(at), suspend_kind: 'suspend' })
    check(p)
    expect(p.o.mails.map((m) => m.subject)).toEqual([expect.stringContaining('提供を停止します(あと14日)')])
    p.setOrg({ suspend_kind: 'restrict' })
    check(p)
    expect(p.o.mails).toHaveLength(2)
    p.setOrg({ suspend_at: '' })
    check(p)
    expect(p.o.mails).toHaveLength(2)
    expect(p.g.sendContractNotices_(null, Date.now())).toBeNull()
  })
})

describe('トリガーと版', () => {
  it('setupOhsumi で1時間ごとの checkContractStatus のトリガーを作る。レジストリに伝える版を上げる', () => {
    expect(CODE_GS).toMatch(/ScriptApp\.newTrigger\('checkContractStatus'\)\.timeBased\(\)\.everyHours\(1\)\.create\(\)/)
    expect(CODE_GS).toContain("var OHSUMI_GAS_VERSION = 'r1e-1'")
  })
})

