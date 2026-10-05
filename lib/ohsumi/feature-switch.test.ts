// 機能のスイッチ(PR W): レジストリから団体の GAS の機能を止める。
//   - 止められる機能の一覧(gas/Code.gs の FEATURE_SWITCHES)に、ログイン・読み取りの操作が入っていないこと
//   - レジストリの一覧(registry/Code.gs の FEATURE_IDS)と ID がそろっていること
//   - 管理画面で止めると、checkIn で団体に伝わり、その機能の書き込みだけを断ること(ログイン・読み取り・ほかの機能は使える)
// 団体の GAS とレジストリは、本物の認証のまま動かす(lib/ohsumi/e2e/world.ts)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type Org, type World } from './e2e/world'

const GAS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const REGISTRY = readFileSync(join(__dirname, '..', '..', 'registry', 'Code.gs'), 'utf8')

const listOf = (name: string) => ((new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\n\\]').exec(GAS)![1].match(/'(\w+)'/g) ?? []).map((x) => x.slice(1, -1)))
const block = (src: string, name: string) => new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\n\\}').exec(src)![1]
const gasFeatures = () => {
  const out: Record<string, { actions: string[]; inside: boolean }> = {}
  for (const line of block(GAS, 'FEATURE_SWITCHES').split('\n')) {
    const m = /^ {2}(\w+): \{(.*)\},?$/.exec(line)
    if (!m) continue
    const actions = /actions: \[([^\]]*)\]/.exec(m[2])
    out[m[1]] = { actions: actions ? (actions[1].match(/'(\w+)'/g) ?? []).map((x) => x.slice(1, -1)) : [], inside: /inside: true/.test(m[2]) }
  }
  return out
}
const registryFeatureIds = () => [...block(REGISTRY, 'FEATURE_IDS').matchAll(/^ {2}(\w+): '/gm)].map((m) => m[1])
const acceptedActions = () => {
  const start = GAS.indexOf('function runWriteAction_(')
  const body = GAS.slice(start, GAS.indexOf('\nfunction ', start + 10))
  return [...new Set([...body.matchAll(/case '(\w+)':/g)].map((m) => m[1]))]
}

describe('止められる機能の一覧', () => {
  it('ログイン・読み取り(機能停止中も受け付ける操作)と、ログインの前の操作は入っていない', () => {
    const readOnly = listOf('READ_ONLY_ACTIONS')
    expect(readOnly).toContain('exchangeIdToken')
    const never = [...readOnly, 'ping', 'getLoginConfig', 'getInitialData', 'exchangeIdToken', 'batch', 'updateLastLogin', 'revokeMySessions', 'revokeMemberSessions']
    const features = gasFeatures()
    expect(Object.keys(features).length).toBeGreaterThanOrEqual(15)
    for (const [id, f] of Object.entries(features)) {
      for (const a of f.actions) expect(never, id + ': ' + a).not.toContain(a)
    }
  })

  it('操作で止める機能は、実際にある操作だけを持つ。処理の中で止める機能は、その処理で確かめている', () => {
    const accepted = acceptedActions()
    for (const [id, f] of Object.entries(gasFeatures())) {
      if (f.inside) {
        expect(f.actions, id).toEqual([])
        expect(GAS, id).toContain("featureDisabled_('" + id + "')")
      } else {
        expect(f.actions.length, id).toBeGreaterThan(0)
        for (const a of f.actions) expect(accepted, id + ': ' + a).toContain(a)
      }
    }
  })

  it('レジストリの一覧と同じ ID・同じ順番', () => {
    expect(registryFeatureIds()).toEqual(Object.keys(gasFeatures()))
  })
})

describe('レジストリから止める・再開する', () => {
  let w: World
  let A: ReturnType<World['launchOrg']>
  let B: ReturnType<World['launchOrg']>
  let topA = ''
  let topB = ''
  let meA = ''
  beforeEach(() => {
    w = createWorld()
    A = w.launchOrg('団体A', 'contact@a.example')
    B = w.launchOrg('団体B', 'contact@b.example')
    const loginA = w.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode }).result
    topA = loginA.session.token
    meA = loginA.memberId
    topB = w.googleLogin(B.org, 'top@b.example', { setupCode: B.setupCode }).result.session.token
  })
  const setSwitches = (target: Record<string, unknown>, features: string[], reason = '不具合の確認') =>
    w.reg.post({ action: 'setFeatureSwitches', session: w.adminSession, ...target, features, reason })
  // 書き込みの前の確かめ直し(10分に1回まで)の間隔を過ぎたことにする
  const elapse = (org: Org) => org.cache.delete('contract:recheck')
  const report = (org: Org, token: string) => w.call(org, token, 'submitDailyReport', { report: { type: 'daily', date: '2026-10-01', did: '確認', next: '', blockers: '' } })
  const createTask = (org: Org, token: string) => w.call(org, token, 'createTasks', { tasks: [{ tempId: 'tmp-1', title: '確認', projectId: '', department: '', category: '', skills: [],
    difficulty: 'normal', priority: 'medium', deadline: null, assigneeIds: [], creatorId: '', pendingApproval: false }] })

  it('全団体で止めると、次の確かめ直しで伝わり、その機能の書き込みだけを断る(featureDisabled)。ログイン・読み取り・ほかの機能は使える', () => {
    expect(report(A.org, topA).ok, JSON.stringify(report(A.org, topA))).toBe(true)
    expect(setSwitches({ scope: 'global' }, ['dailyReports', 'uploads']).ok).toBe(true)
    elapse(A.org)
    const denied = report(A.org, topA)
    expect(denied).toMatchObject({ ok: false, featureDisabled: 'dailyReports' })
    expect(denied.error).toContain('日報の提出')
    // ほかの機能・読み取り・ログインは使える
    expect(createTask(A.org, topA).ok).toBe(true)
    expect(w.call(A.org, topA, 'getInitialData').ok).toBe(true)
    expect(w.googleLogin(A.org, 'top@a.example').ok).toBe(true)
    // まとめて送った時は、止めた操作だけを断る
    const batch = w.call(A.org, topA, 'batch', { ops: [
      { action: 'submitDailyReport', report: { type: 'daily', date: '2026-10-02', did: 'x', next: '', blockers: '' } },
      { action: 'updateDisplayName', memberId: meA, displayName: '代表' },
    ] })
    expect(batch.ok).toBe(true)
    expect(batch.result.results[0]).toMatchObject({ ok: false, featureDisabled: 'dailyReports' })
    // 代表の管理画面に、止めている機能が出る
    expect(w.call(A.org, topA, 'getOpsStatus').result.disabledFeatures).toEqual([
      { id: 'uploads', label: 'ファイルのアップロード' },
      { id: 'dailyReports', label: '日報の提出' },
    ])
    // 再開する
    expect(setSwitches({ scope: 'global' }, []).ok).toBe(true)
    elapse(A.org)
    expect(report(A.org, topA).ok).toBe(true)
    expect(w.call(A.org, topA, 'getOpsStatus').result.disabledFeatures).toEqual([])
  })

  it('1つの団体だけ止められる(ほかの団体は使える)。知らない ID は捨てる。操作の記録に残る', () => {
    const res = setSwitches({ scope: 'org', orgId: A.orgId }, ['dailyReports', 'noSuchFeature'])
    expect(res.result).toMatchObject({ orgId: A.orgId, disabledFeatures: ['dailyReports'] })
    elapse(A.org)
    elapse(B.org)
    expect(report(A.org, topA)).toMatchObject({ ok: false, featureDisabled: 'dailyReports' })
    expect(report(B.org, topB).ok).toBe(true)
    const overview = w.reg.post({ action: 'adminOverview', session: w.adminSession }).result
    expect(overview.features.globalDisabled).toEqual([])
    expect(overview.features.catalog.map((f: { id: string }) => f.id)).toEqual(registryFeatureIds())
    expect(overview.orgs.find((o: { orgId: string }) => o.orgId === B.orgId).disabledFeatures).toEqual([])
    expect(overview.audit[0]).toMatchObject({ action: 'setFeatureSwitches', target: A.orgId, reason: '不具合の確認' })
    // checkIn は、全団体の分と団体の分を合わせて伝える
    setSwitches({ scope: 'global' }, ['uploads'])
    elapse(A.org)
    report(A.org, topA)
    expect(JSON.parse(A.org.props.CONTRACT_STATE!).disabledFeatures).toEqual(['uploads', 'dailyReports'])
  })

  it('理由が無い時・5分以内のログインが無い時は断る', () => {
    expect(setSwitches({ scope: 'global' }, ['uploads'], '').ok).toBe(false)
    const body = { session: w.adminSession, scope: 'global', features: ['uploads'], reason: 'x' }
    expect(() => (w.reg.gas.setFeatureSwitches_ as (b: object, n: number) => unknown)(body, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(w.reg.post({ action: 'adminOverview', session: w.adminSession }).result.features.globalDisabled).toEqual([])
  })

  it('処理の中で止める機能: 通知・定期タスク・集計値の送信は、止めている間は行わない(画面には失敗を返さない)', () => {
    setSwitches({ scope: 'global' }, ['chatNotify', 'recurringTasks', 'metricsSend', 'calendarSync'])
    elapse(A.org)
    report(A.org, topA)
    const g = A.org.gas as unknown as Record<string, (...a: unknown[]) => unknown>
    expect(g.featureDisabled_('chatNotify')).toBe(true)
    expect(w.call(A.org, topA, 'checkAndGenerateRecurringTasks')).toMatchObject({ ok: true, result: { generated: [] } })
    A.org.props.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/x'
    let fetched = 0
    const c = A.org.gas as unknown as Record<string, unknown>
    const orig = c.getDiscordWebhookUrl_
    c.getDiscordWebhookUrl_ = () => { fetched++; return 'https://discord.com/api/webhooks/1/x' }
    g.sendDiscordMessage_('テスト')
    expect(fetched).toBe(0)
    c.getDiscordWebhookUrl_ = orig
  })
})
