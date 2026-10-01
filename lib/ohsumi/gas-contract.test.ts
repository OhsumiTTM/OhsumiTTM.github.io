// 団体の GAS(gas/Code.gs)の R1-e: レジストリの checkIn で提供停止・機能停止の状態を確かめ、
// 提供停止中はすべて断り、機能停止中は読み取りだけを受け付けること。停止の予告を代表にメールで送ること。
// レジストリへの通信は、テストの中でレジストリのコード(registry/Code.gs)につなぐ
import { describe, expect, it } from 'vitest'
import { CODE_GS, org, registry } from './gas-org-harness'

const DAY = 24 * 3600 * 1000
// この GAS の版(日付の形。pnpm gas:version で上げる)
const GAS_VERSION = CODE_GS.match(/^var OHSUMI_GAS_VERSION = '([^']+)'$/m)![1]
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
    expect(sent).toMatchObject({ action: 'checkIn', orgId: p.o.props.ORG_ID, gasVersion: GAS_VERSION })
    expect(sent.sig).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(sent)).not.toContain(p.o.props.REGISTRY_SHARED_KEY)
    expect(String(p.orgValue('last_check_at'))).toMatch(/^\d{4}-/)
    expect(p.orgValue('gas_version')).toBe(GAS_VERSION)
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

describe('メールの1日の上限をレジストリに伝える', () => {
  it('checkIn で、メールの残りの数・今日送れなかった数・最後に上限に達した日を伝え、レジストリに残る', () => {
    const p = pair()
    p.o.c.mailQuotaToday_ = () => '2026-10-01'
    p.o.c.MailApp = { getRemainingDailyQuota: () => 0 }
    p.o.props.MAIL_QUOTA_STATE = JSON.stringify({ date: '2026-10-01', skipped: 3, reachedAt: '2026-10-01T03:00:00.000Z', lastReachedDate: '2026-10-01' })
    check(p)
    expect(p.o.sent.at(-1)!.mail).toEqual({ remaining: 0, skipped: 3, date: '2026-10-01', lastReachedDate: '2026-10-01' })
    expect([p.orgValue('mail_remaining'), p.orgValue('mail_skipped'), p.orgValue('mail_date'), p.orgValue('mail_limit_date')]).toEqual([0, 3, '2026-10-01', '2026-10-01'])
  })
})

describe('この GAS の版の更新(PR E)', () => {
  const mark = (p: Pair, version: string, marks: Record<string, unknown>) =>
    p.reg.post({ action: 'setGasVersionMarks', session: p.reg.session, version, ...marks })

  it('レジストリが「更新が要る」と返したら覚え、代表に最新の版ごとに1回だけメールで知らせる', () => {
    const p = pair()
    check(p)
    expect(p.g.gasUpdateStatus_()).toMatchObject({ current: GAS_VERSION, known: true, required: false, latest: GAS_VERSION })
    expect(p.o.mails).toEqual([])
    // 新しい版に「安全の修正」が付いた
    expect(mark(p, '2099.01.01-1', { security: true }).ok).toBe(true)
    check(p)
    expect(p.g.gasUpdateStatus_()).toMatchObject({ known: true, required: true, outdated: true, latest: '2099.01.01-1', minimum: '2099.01.01-1', security: true })
    expect(p.o.mails.map((m) => m.to)).toEqual(['top@example.com'])
    expect(p.o.mails[0].subject).toContain('団体の GAS の更新が要ります(最新の版 2099.01.01-1)')
    expect(p.o.mails[0].body).toContain('今の版: ' + GAS_VERSION)
    expect(p.o.mails[0].body).toContain('安全の修正が含まれます')
    check(p)
    expect(p.o.mails).toHaveLength(1)
    // さらに新しい版が出たら、もう1回
    mark(p, '2099.02.01-1', {})
    check(p)
    expect(p.o.mails.map((m) => m.subject)).toEqual([expect.stringContaining('2099.01.01-1'), expect.stringContaining('2099.02.01-1')])
  })

  it('古いだけ(更新が要る印が無い)なら、メールは送らない。メールの上限で送れなかった時は、次の確認で送り直す', () => {
    const p = pair()
    mark(p, '2099.01.01-1', {})
    check(p)
    expect(p.g.gasUpdateStatus_()).toMatchObject({ required: false, outdated: true, latest: '2099.01.01-1' })
    expect(p.o.mails).toEqual([])
    mark(p, '2099.01.01-1', { required: true })
    p.o.c.sendMail_ = () => false
    check(p)
    expect(p.o.props.GAS_UPDATE_NOTIFIED).toBeUndefined()
    p.o.c.sendMail_ = (m: { to: string; subject: string; body: string }) => { p.o.mails.push(m); return true }
    check(p)
    expect(p.o.props.GAS_UPDATE_NOTIFIED).toBe('2099.01.01-1')
  })

  it('貼り替えて版が変わった後は、次の確認まで古い判定を出さない', () => {
    const p = pair()
    mark(p, '2099.01.01-1', { required: true })
    check(p)
    const st = state(p)
    st.gasUpdate.judgedVersion = '2026.01.01-1'
    p.o.props.CONTRACT_STATE = JSON.stringify(st)
    expect(p.g.gasUpdateStatus_()).toMatchObject({ known: false, required: false })
  })

  it('代表・全権管理者は、管理画面で読める(読み取りの操作。機能停止中も使える)', () => {
    expect(CODE_GS.match(/var READ_ONLY_ACTIONS = \[[^\]]*\]/)![0]).toContain("'getGasUpdateStatus'")
    expect(CODE_GS).toMatch(/action === 'getGasUpdateStatus' \|\|/)
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
    expect(GAS_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/)
  })
})


// doPost が受け付ける操作: runWriteAction_ の case(新しく足した操作も、自動でここに入る)と、その前で扱う操作
function acceptedActions(): string[] {
  const start = CODE_GS.indexOf('function runWriteAction_(')
  const body = CODE_GS.slice(start, CODE_GS.indexOf('\nfunction ', start + 10))
  const cases = [...body.matchAll(/case '(\w+)':/g)].map((m) => m[1])
  return [...new Set([...cases, 'exchangeIdToken', 'getInitialData', 'getLoginConfig', 'ping', 'batch'])]
}

describe('機能停止中は、読み取りの一覧に無い操作をすべて断る(どの経路でも)', () => {
  // 機能停止中の団体(レジストリでも機能停止中。確かめ直しても変わらない)。処理まで進んだ操作を数える
  function restricted() {
    const p = pair()
    p.setOrg({ suspend_at: iso(Date.now() - 1000), suspend_kind: 'restrict' })
    check(p)
    expect(state(p)).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    const reached: string[] = []
    const c = p.o.c
    for (const f of ['authenticateRequest_', 'runWriteAction_', 'runBatch_', 'exchangeIdToken_', 'claimInitialSetup_']) {
      const orig = c[f] as (...a: unknown[]) => unknown
      c[f] = (...a: unknown[]) => { reached.push(f); return orig(...a) }
    }
    return { ...p, reached }
  }
  const readOnly = () => ((/var READ_ONLY_ACTIONS = \[([\s\S]*?)\]/.exec(CODE_GS)![1].match(/'(\w+)'/g) ?? []).map((x) => x.slice(1, -1)))

  it('受け付ける操作は125以上あり、読み取りの一覧はその一部だけ(読み取り・ログイン)', () => {
    const all = acceptedActions()
    expect(all.length).toBeGreaterThan(125)
    for (const a of readOnly()) expect(all, a).toContain(a)
    expect(readOnly()).not.toContain('createTasks')
    expect(readOnly()).not.toContain('batch')
  })

  it('1本ずつ送った時: 読み取りの一覧に無い操作は、処理(認証も)に進まずに断る', () => {
    const t = restricted()
    const writes = acceptedActions().filter((a) => !readOnly().includes(a) && a !== 'getLoginConfig' && a !== 'ping')
    expect(writes).toContain('createTasks')
    for (const action of writes) {
      const res = t.o.post({ action, sessionToken: 'session-m1', tasks: [{ name: 'x' }], taskId: 't1', text: '本文' })
      expect(res, action).toMatchObject({ ok: false, restricted: true })
    }
    expect(t.reached).toEqual([])
  })

  it('batch で送った時: 中の操作が何でも、処理に進まずに断る(読み取りの一覧の操作を混ぜても)', () => {
    const t = restricted()
    const ops = acceptedActions().filter((a) => a !== 'batch')
    for (const action of ops) {
      const res = t.o.post({ action: 'batch', sessionToken: 'session-m1', ops: [{ action, taskId: 't1' }] })
      expect(res, action).toMatchObject({ ok: false, restricted: true })
    }
    expect(t.reached).toEqual([])
  })

  it('初期設定コードで代表を入れるログインは断る(メンバーを足すため)。ふつうのログインは受け付ける', () => {
    const t = restricted()
    expect(t.o.login('new@example.com', 'AAAA-BBBB-CCCC-DDDD')).toMatchObject({ ok: false, restricted: true })
    expect(t.reached).toEqual([])
    expect(t.o.login('top@example.com').restricted).toBeUndefined()
    expect(t.reached).toContain('exchangeIdToken_')
  })

  it('GAS がまだ停止を知らない時も、書き込みの前にレジストリに確かめ直して断る(予定のみ・予定なしと覚えていた時)', () => {
    for (const known of [
      { phase: 'scheduled', kind: 'restrict', suspendAt: iso(Date.now() + 0.9 * DAY) },
      { phase: 'none', kind: '', suspendAt: '' },
    ]) {
      const p = pair()
      p.o.props.CONTRACT_STATE = JSON.stringify(known)
      // レジストリでは今すぐ機能停止にした(テスト環境の testSuspendNow と同じ)
      p.setOrg({ suspend_at: iso(Date.now() - 1000), suspend_kind: 'restrict' })
      const res = p.o.post({ action: 'createTasks', sessionToken: 'session-m1', tasks: [{ name: 'x' }] })
      expect(res, known.phase).toMatchObject({ ok: false, restricted: true, contract: { phase: 'inEffect', kind: 'restrict' } })
      expect(state(p).phase).toBe('inEffect')
    }
  })

  it('読み取りでは、予定なしの時にレジストリへ問い合わせない(読み込みを遅くしない)', () => {
    const p = pair()
    check(p)
    const before = p.o.fetches()
    p.o.post({ action: 'getInitialData', sessionToken: 'session-m1' })
    expect(p.o.fetches()).toBe(before)
  })
})
