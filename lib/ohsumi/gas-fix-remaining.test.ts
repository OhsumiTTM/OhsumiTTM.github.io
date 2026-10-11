// 残っていた4つの直し:
// 1. 一覧に無い役職(書き間違い・roles が読めない時)を、管理者ではなく一般として扱う
// 2. 検定の受験の回数の上限(点数から正解を総当たりで探られないように)
// 3. updateLastLogin は、常にログインしている本人の日時だけを書く
// 4. 毎日の処理の個人情報の削除に時間の上限を付け、ほかの毎日の処理の後に行う
import { describe, expect, it } from 'vitest'
import { guardHarness, type Cell } from './gas-guard-harness'
import * as R from './roles'

type H = ReturnType<typeof guardHarness>
const DAY = 24 * 3600 * 1000
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const memberCol = (h: H, col: string) => {
  const rows = h.sheets.Members.rows
  const head = rows[0] as string[]
  if (head.indexOf(col) < 0) {
    head.push(col)
    for (const r of rows.slice(1)) while (r.length < head.length) r.push('')
  }
  return head.indexOf(col)
}
const setMember = (h: H, id: string, col: string, v: Cell) => {
  const i = memberCol(h, col)
  h.sheets.Members.rows.find((r) => r[0] === id)![i] = v
}
const getMember = (h: H, id: string, col: string) => h.sheets.Members.rows.find((r) => r[0] === id)![memberCol(h, col)]
const setSetting = (h: H, key: string, value: string) => {
  const rows = h.sheets.Settings.rows
  const r = rows.find((x) => x[0] === key)
  if (r) r[1] = value
  else rows.push([key, value])
  call(h, 'invalidateRoles_')
}

describe('1. 一覧に無い役職は一般として扱う', () => {
  const CODED: R.RoleDef[] = [
    { id: 'base', name: '一般', tier: 'base' },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: 'top', name: '代表', tier: 'top' },
  ]

  it('GAS と画面で同じ判定: 一覧に無い役職は一般(管理者でも最上位でもない・できる操作なし)', () => {
    const h = guardHarness()
    for (const roles of [CODED, R.rolesFromLegacy({})]) {
      for (const ref of ['書き間違い', 'r_deleted', 'Top', ' ']) {
        expect(call(h, 'roleTier_', roles, ref), ref).toBe('base')
        expect(R.roleTier(roles, ref), ref).toBe('base')
        expect(call(h, 'isAdminRoleRef_', roles, ref)).toBe(false)
        expect(call(h, 'isFullAdminRoleRef_', roles, ref)).toBe(false)
        expect(call(h, 'isTopRoleRef_', roles, ref)).toBe(false)
        expect(plain(call(h, 'roleCapabilities_', roles, ref))).toEqual([])
        expect(R.roleCapabilities(roles, ref)).toEqual([])
        expect(call(h, 'roleHasCapability_', roles, ref, 'trash')).toBe(false)
      }
    }
  })

  it('今までの役職名(役職の一覧・既定の役職・制限だけの役職)は、今までどおり', () => {
    const h = guardHarness()
    const legacy = call(h, 'rolesFromLegacy_', { restricted_roles: '会計係' }) as R.RoleDef[]
    expect(call(h, 'roleTier_', legacy, '班長')).toBe('admin')
    expect(call(h, 'isFullAdminRoleRef_', legacy, '事業責任者')).toBe(true)
    expect(call(h, 'roleTier_', legacy, '代表')).toBe('top')
    expect(call(h, 'roleTier_', legacy, '会計係')).toBe('admin')
    expect(call(h, 'isFullAdminRoleRef_', legacy, '会計係')).toBe(false)
    expect(call(h, 'roleTier_', legacy, '一般')).toBe('base')
  })

  it('役職の列を書き間違えたメンバーは、管理者の操作ができない', () => {
    const h = guardHarness()
    // 管理者(一般以外)だけが使える操作(FSIF からのお知らせ)で確かめる
    const auth = (actor: string) => { try { call(h, 'authorizeAction_', { id: actor, role: getMember(h, actor, 'role') }, 'getAnnouncements', {}); return 'ok' } catch (e) { return String((e as Error).message) } }
    expect(auth('m-lead')).toBe('ok')
    setMember(h, 'm-lead', 'role', '班長さん')
    call(h, 'invalidateRoles_')
    expect(auth('m-lead')).toContain('代表・管理者だけ')
  })

  it('roles が壊れている時は、今までの設定から組み立てず、一般と最上位だけにする(管理者が増えない)', () => {
    for (const raw of ['[壊れた', JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }]), '{"a":1}']) {
      const settings = { roles: raw, role_levels: '班長,事業責任者,代表' }
      const h = guardHarness()
      const roles = plain(call(h, 'rolesFromSettings_', settings))
      expect(roles, raw).toEqual(R.rolesFromSettings(settings))
      expect(roles).toEqual([{ id: 'base', name: '一般', tier: 'base' }, { id: 'top', name: '代表', tier: 'top' }])
      // 移行の後に残った役職名・役職 ID は、どちらも一般
      for (const ref of ['班長', '事業責任者', 'r_leader']) {
        expect(call(h, 'roleTier_', roles, ref), ref).toBe('base')
        expect(R.roleTier(roles, ref), ref).toBe('base')
      }
      // 最上位の人は、Settings を直せるように最上位のまま
      expect(call(h, 'roleTier_', roles, 'top')).toBe('top')
      expect(call(h, 'roleTier_', roles, '代表')).toBe('top')
    }
    // roles が無い(移行前)時は、今までの設定から組み立てる
    const h = guardHarness()
    expect(plain(call(h, 'rolesFromSettings_', { role_levels: '班長,代表' }))).toEqual(R.rolesFromSettings({ role_levels: '班長,代表' }))
    expect(call(h, 'roleTier_', call(h, 'rolesFromSettings_', { role_levels: '班長,代表' }), '班長')).toBe('admin')
  })

  it('roles が壊れている団体: 班長(r-lead)は管理者の操作ができず、代表はできる。roles は上書きしない', () => {
    const h = guardHarness()
    setSetting(h, 'roles', '[壊れた')
    expect(call(h, 'isAdminRoleRef_', call(h, 'getRoles_'), 'r-lead')).toBe(false)
    expect(call(h, 'isTopRoleRef_', call(h, 'getRoles_'), 'top')).toBe(true)
    expect(() => call(h, 'authorizeAction_', { id: 'm-lead', role: 'r-lead' }, 'getAnnouncements', {})).toThrow('代表・管理者だけ')
    expect(() => call(h, 'authorizeAction_', { id: 'm-top', role: 'top' }, 'getAnnouncements', {})).not.toThrow()
    h.c.isCodesFormat_ = () => true
    expect(call(h, 'setupRolesSetting_')).toBe('broken')
    expect(h.sheets.Settings.rows.find((r) => r[0] === 'roles')![1]).toBe('[壊れた')
  })
})

describe('2. 検定の受験の回数の上限', () => {
  const QUIZ = { id: 'q1', title: '検定', targetSkill: 'デザイン', targetLevel: 2, passRate: 100,
    questions: [{ text: 'a', choices: ['x', 'y'], correctIndex: 1 }, { text: 'b', choices: ['x', 'y'], correctIndex: 0 }] }
  const setup = () => {
    const h = guardHarness()
    setSetting(h, 'quiz_definitions', JSON.stringify([QUIZ]))
    memberCol(h, 'skill_levels_json')
    memberCol(h, 'skill_points_json')
    memberCol(h, 'quiz_passes_json')
    return h
  }
  const submit = (h: H, actor: string, memberId: string, answers: number[]) =>
    h.post({ action: 'submitQuizResult', sessionToken: actor, quizId: 'q1', memberId, answers })

  it('1人1時間に10回まで。11回目は断る(ほかの人は受けられる)', () => {
    const h = setup()
    for (let i = 0; i < 10; i++) {
      const r = submit(h, 'm-base', 'm-base', [0, 1])
      expect(r.ok, r.error).toBe(true)
    }
    const over = submit(h, 'm-base', 'm-base', [1, 0])
    expect(over.ok).toBe(false)
    expect(over.error).toContain('1時間に10回まで')
    // 断った回は採点も記録もしない
    expect(getMember(h, 'm-base', 'quiz_passes_json')).toBe('')
    expect(submit(h, 'm-other', 'm-other', [1, 0]).ok).toBe(true)
  })

  it('返すのは合否・点数・新しいレベルだけ(どの設問が正解かは返さない)', () => {
    const h = setup()
    const r = submit(h, 'm-base', 'm-base', [1, 1])
    expect(r.ok).toBe(true)
    expect(Object.keys(r.result).sort()).toEqual(['newLevel', 'ok', 'passed', 'score'])
    expect(r.result).toMatchObject({ passed: false, score: 50 })
    expect(JSON.stringify(r)).not.toContain('correctIndex')
    const pass = submit(h, 'm-base', 'm-base', [1, 0])
    expect(pass.result).toMatchObject({ passed: true, score: 100, newLevel: 2 })
  })

  it('管理者が代わりに受けても、操作した人の回数として数える', () => {
    const h = setup()
    for (let i = 0; i < 10; i++) expect(submit(h, 'm-lead', i % 2 ? 'm-base' : 'm-other', [0, 1]).ok).toBe(true)
    expect(submit(h, 'm-lead', 'm-base', [0, 1]).error).toContain('1時間に10回まで')
    expect(submit(h, 'm-base', 'm-base', [0, 1]).ok).toBe(true)
  })
})

describe('3. updateLastLogin は本人の日時だけを書く', () => {
  it('body.memberId にほかの人を書いても、ログインしている本人の日時を書く', () => {
    const h = guardHarness()
    memberCol(h, 'last_login')
    setMember(h, 'm-other', 'last_login', '2026-01-01T00:00:00.000Z')
    const r = h.post({ action: 'updateLastLogin', sessionToken: 'm-base', memberId: 'm-other' })
    expect(r.ok, r.error).toBe(true)
    expect(getMember(h, 'm-other', 'last_login')).toBe('2026-01-01T00:00:00.000Z')
    expect(String(getMember(h, 'm-base', 'last_login'))).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('画面と同じく自分の ID を送っても、memberId を送らなくても動く', () => {
    const h = guardHarness()
    memberCol(h, 'last_login')
    expect(h.post({ action: 'updateLastLogin', sessionToken: 'm-base', memberId: 'm-base' }).ok).toBe(true)
    expect(String(getMember(h, 'm-base', 'last_login'))).toMatch(/^\d{4}-/)
    expect(h.post({ action: 'updateLastLogin', sessionToken: 'm-other' }).ok).toBe(true)
    expect(String(getMember(h, 'm-other', 'last_login'))).toMatch(/^\d{4}-/)
  })
})

describe('4. 毎日の処理の個人情報の削除', () => {
  const withdrawBoth = (h: H) => {
    for (const id of ['m-base', 'm-other']) {
      const r = h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: id })
      expect(r.ok, r.error).toBe(true)
    }
  }
  const purged = (h: H, id: string) => String(getMember(h, id, 'personal_data_purged_at') || '') !== ''

  it('時間の上限を過ぎていたら消さずに次の日に回し、回した人数を返す', () => {
    const h = guardHarness()
    withdrawBoth(h)
    const later = Date.now() + 60 * DAY
    const done = plain(call(h, 'purgeExpiredPersonalData_', later, 'system', Date.now() - 1))
    expect(done).toEqual({ members: [], candidates: [], deferred: 2 })
    expect(purged(h, 'm-base')).toBe(false)
    expect(purged(h, 'm-other')).toBe(false)
    // 次の日(上限なし)に消す
    const next = plain(call(h, 'purgeExpiredPersonalData_', later + DAY, 'system'))
    expect(next.members.sort()).toEqual(['m-base', 'm-other'])
    expect(next.deferred).toBeUndefined()
    expect(purged(h, 'm-base')).toBe(true)
  })

  it('1人目で時間を使い切ったら、2人目は次の日に回す(1人目は最後まで消す)', () => {
    const h = guardHarness()
    withdrawBoth(h)
    const realTrash = h.c.trashAvatarFiles_ as (id: string) => number
    h.c.trashAvatarFiles_ = (id: string) => {
      const until = Date.now() + 30
      while (Date.now() < until) { /* 時間のかかる処理のかわり */ }
      return realTrash(id)
    }
    const done = plain(call(h, 'purgeExpiredPersonalData_', Date.now() + 60 * DAY, 'system', Date.now() + 10))
    expect(done.members).toHaveLength(1)
    expect(done.deferred).toBe(1)
    const first = done.members[0] as string
    const second = first === 'm-base' ? 'm-other' : 'm-base'
    expect(purged(h, first)).toBe(true)
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === first)).toBe(false)
    expect(purged(h, second)).toBe(false)
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === second)).toBe(true)
  })

  it('1人分の途中で止まったら、消した印を付けない(次の日にもう一度消す)', () => {
    const h = guardHarness()
    withdrawBoth(h)
    h.c.trashAvatarFiles_ = () => { throw new Error('時間切れ') }
    expect(() => call(h, 'purgeMember_', 'm-base', Date.now())).toThrow('時間切れ')
    expect(purged(h, 'm-base')).toBe(false)
    const pending = plain(call(h, 'pendingPersonalData_', 30)) as { id: string }[]
    expect(pending.some((p) => p.id === 'm-base')).toBe(true)
  })

  it('毎日の処理: 個人情報の削除は最後に行い、時間の上限を渡す。削除に失敗しても、ほかの処理は済んでいる', () => {
    const h = guardHarness()
    const order: string[] = []
    const stub = (name: string, fn: (...a: unknown[]) => unknown = () => undefined) => {
      h.c[name] = (...a: unknown[]) => { order.push(name); return fn(...a) }
    }
    h.c.contractSuspendedNow_ = () => false
    h.c.restoreInProgress_ = () => false
    for (const n of ['dailyBackup_', 'purgeExpiredTrashLocked_', 'archiveOldTasksLocked_', 'generateRecurringTasksLocked_',
      'notifyOverdueTasksToDiscord_', 'notifyOverdueTasksToAssignees_', 'flushPendingLastLogins_', 'notifyInactiveMembers_',
      'flushDailyDigests_', 'checkSharing_', 'bumpDataVersion']) stub(n)
    let deadline = 0
    const startedAt = Date.now()
    stub('purgeExpiredPersonalData_', (_now, actor, d) => {
      expect(actor).toBe('system')
      deadline = d as number
      throw new Error('削除に失敗')
    })
    call(h, 'dailyMaintenanceUnrecorded_')
    expect(order.at(-1)).toBe('purgeExpiredPersonalData_')
    for (const n of ['archiveOldTasksLocked_', 'generateRecurringTasksLocked_', 'flushDailyDigests_', 'checkSharing_', 'bumpDataVersion']) {
      expect(order.indexOf(n), n).toBeGreaterThanOrEqual(0)
      expect(order.indexOf(n), n).toBeLessThan(order.indexOf('purgeExpiredPersonalData_'))
    }
    const budget = h.c.PURGE_TIME_BUDGET_MS as number
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThanOrEqual(180 * 1000)
    expect(deadline).toBeGreaterThanOrEqual(startedAt + budget)
    expect(deadline).toBeLessThanOrEqual(Date.now() + budget)
  })
})
