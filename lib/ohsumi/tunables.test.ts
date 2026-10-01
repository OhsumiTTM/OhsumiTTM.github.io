// 上限・しきい値(PR X): レジストリから配り、団体の GAS は安全な範囲に収めて使う。
//   - 団体の GAS の TUNABLES と、レジストリの TUNABLE_RANGES がそろっていること(既定の値は、これまでの定数と同じ)
//   - 範囲の外の値・数でない値が届いても、範囲の端・既定の値を使うこと
//   - 管理画面で全団体・1つの団体の値を変えると、checkIn で伝わること(団体の値が優先)
// 団体の GAS とレジストリは、本物の認証のまま動かす(lib/ohsumi/e2e/world.ts)
import { beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type Org, type World } from './e2e/world'

type Range = { def: number; min: number; max: number; label: string }
type Fn = (...a: unknown[]) => unknown
const gasOf = (org: Org) => org.gas as unknown as Record<string, Fn> & Record<string, unknown>

describe('上限・しきい値の一覧', () => {
  const w = createWorld()
  const A = w.launchOrg('団体A', 'contact@a.example')
  const g = gasOf(A.org)
  const gasTable = g.TUNABLES as unknown as Record<string, Range>
  const regTable = (w.reg.gas as unknown as Record<string, unknown>).TUNABLE_RANGES as Record<string, Range>

  it('団体の GAS とレジストリで、キー・既定・範囲・名前がそろっている', () => {
    expect(Object.keys(gasTable).length).toBeGreaterThanOrEqual(10)
    expect(JSON.parse(JSON.stringify(regTable))).toEqual(JSON.parse(JSON.stringify(gasTable)))
  })

  it('既定の値は、これまでの定数と同じで、範囲の中にある(何も届かなければ、これまでどおり動く)', () => {
    const rate = g.RATE_LIMITS as unknown as Record<string, { limit: number; tunable?: string }>
    for (const spec of Object.values(rate)) if (spec.tunable) expect(gasTable[spec.tunable].def, spec.tunable).toBe(spec.limit)
    const consts: Record<string, string> = {
      inviteMailPerHour: 'INVITE_MAIL_LIMIT', digestMailReserve: 'DIGEST_MAIL_RESERVE', dailyJobStaleHours: 'DAILY_JOB_STALE_HOURS',
      hourlyJobStaleHours: 'HOURLY_JOB_STALE_HOURS', personalDataNoticeDays: 'PERSONAL_DATA_NOTICE_DAYS', metricsRetryMaxHours: 'METRICS_RETRY_MAX_HOURS',
      contractRecheckIdleSec: 'CONTRACT_RECHECK_IDLE_SEC', announcementsCacheSec: 'ANNOUNCEMENTS_CACHE_SEC',
    }
    for (const [key, name] of Object.entries(consts)) expect(gasTable[key].def, key).toBe(g[name])
    for (const [key, r] of Object.entries(gasTable)) {
      expect(r.min <= r.def && r.def <= r.max, key).toBe(true)
      expect(g.tunable_(key), key).toBe(r.def)
    }
  })

  it('範囲の外の値は範囲の端にし、数でない値・知らないキーは使わない', () => {
    expect(g.parseTunables_({ notifyPerHour: 99999, mentionPerHour: -5, translatePerHour: '100', digestMailReserve: 12.6, noSuchKey: 1, inviteMailPerHour: NaN }))
      .toEqual({ notifyPerHour: 300, mentionPerHour: 5, digestMailReserve: 13 })
    expect(g.parseTunables_(null)).toEqual({})
    expect(g.parseTunables_([1, 2])).toEqual({})
    // レジストリが範囲の外の値を送ってきても(古い・壊れたレジストリ)、範囲の端を使う
    A.org.props.CONTRACT_STATE = JSON.stringify({ phase: 'none', tunables: { contractRecheckIdleSec: 86400, notifyPerHour: 1 } })
    g.resetRequestProps_()
    expect(g.tunable_('contractRecheckIdleSec')).toBe(1800)
    expect(g.tunable_('notifyPerHour', 60)).toBe(10)
  })
})

describe('レジストリから配る', () => {
  let w: World
  let A: ReturnType<World['launchOrg']>
  let B: ReturnType<World['launchOrg']>
  beforeEach(() => {
    w = createWorld()
    A = w.launchOrg('団体A', 'contact@a.example')
    B = w.launchOrg('団体B', 'contact@b.example')
  })
  const set = (target: Record<string, unknown>, values: Record<string, unknown>, reason = '大きな団体のため') =>
    w.reg.post({ action: 'setTunables', session: w.adminSession, ...target, values, reason })
  // checkIn で受け取り直し、このリクエストの中で読んだスクリプトプロパティを捨てる
  const refresh = (org: Org) => { gasOf(org).refreshContractState_(); gasOf(org).resetRequestProps_() }
  const value = (org: Org, key: string) => gasOf(org).tunable_(key)

  it('全団体の値に、団体ごとの値を重ねて伝える。消すと既定に戻る。操作の記録に残る', () => {
    expect(set({ scope: 'global' }, { translatePerHour: 1000, inviteMailPerHour: 5 }).ok).toBe(true)
    expect(set({ scope: 'org', orgId: A.orgId }, { inviteMailPerHour: 1 }).result).toMatchObject({ orgId: A.orgId, tunables: { inviteMailPerHour: 1 } })
    refresh(A.org)
    refresh(B.org)
    expect([value(A.org, 'translatePerHour'), value(A.org, 'inviteMailPerHour')]).toEqual([1000, 1])
    expect([value(B.org, 'translatePerHour'), value(B.org, 'inviteMailPerHour')]).toEqual([1000, 5])
    const overview = w.reg.post({ action: 'adminOverview', session: w.adminSession }).result
    expect(overview.tunables.global).toEqual({ translatePerHour: 1000, inviteMailPerHour: 5 })
    expect(overview.tunables.catalog.find((c: { key: string }) => c.key === 'inviteMailPerHour')).toMatchObject({ def: 3, min: 1, max: 10 })
    expect(overview.audit[0]).toMatchObject({ action: 'setTunables', target: A.orgId, reason: '大きな団体のため' })
    // 消す(空の値は既定・全団体の値に戻す)
    set({ scope: 'global' }, {})
    set({ scope: 'org', orgId: A.orgId }, { inviteMailPerHour: '' })
    refresh(A.org)
    expect([value(A.org, 'translatePerHour'), value(A.org, 'inviteMailPerHour')]).toEqual([500, 3])
  })

  it('届いた上限で数える(1人1時間の通知)。代表の管理画面に、既定と違う値が出る', () => {
    set({ scope: 'org', orgId: A.orgId }, { notifyPerHour: 10 })
    refresh(A.org)
    const g = gasOf(A.org)
    const results = Array.from({ length: 11 }, () => g.takeRateLimit_('notify', 'm1', 1))
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(results[10]).toBe(false)
    expect(g.tunablesForClient_()).toEqual([{ key: 'notifyPerHour', label: '通知(1人1時間)', value: 10, def: 60 }])
  })

  it('範囲の外・整数でない・知らない項目・理由が無い時・5分以内のログインが無い時は、保存せずに断る', () => {
    expect(set({ scope: 'global' }, { notifyPerHour: 301 })).toMatchObject({ ok: false, error: expect.stringContaining('10〜300') })
    expect(set({ scope: 'global' }, { notifyPerHour: 20.5 }).ok).toBe(false)
    expect(set({ scope: 'global' }, { noSuchKey: 1 }).ok).toBe(false)
    expect(set({ scope: 'global' }, { notifyPerHour: 20 }, '').ok).toBe(false)
    const body = { session: w.adminSession, scope: 'global', values: { notifyPerHour: 20 }, reason: 'x' }
    expect(() => (w.reg.gas.setTunables_ as (b: object, n: number) => unknown)(body, Date.now() + 6 * 60 * 1000)).toThrow(/もう一度 Google でログイン/)
    expect(w.reg.post({ action: 'adminOverview', session: w.adminSession }).result.tunables.global).toEqual({})
  })
})
