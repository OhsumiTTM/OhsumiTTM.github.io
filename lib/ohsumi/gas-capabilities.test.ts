// gas/Code.gs のできる操作(capability)。
// 1. 既定のままの役職では、操作の可否が入れる前(lib/ohsumi/__fixtures__/authorize-before.gs)と1つも変わらない
// 2. 昇権の防止(役職を付ける・役職の一覧を保存する時の決まり)
// 3. 画面に渡す「できる操作」の一覧(役職の分と人ごとの例外の分)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const BEFORE_GS = readFileSync(join(__dirname, '__fixtures__', 'authorize-before.gs'), 'utf8')

type Row = Record<string, string>
type Acting = { id: string; role: string; project_ids: string; permission_overrides: { targetType: string; targetId: string; access: string }[] }
type Gas = {
  authorizeAction_: (acting: Acting, action: string, body: object) => void
  authorizeActionBefore_: (acting: Acting, action: string, body: object) => void
  memberCapabilities_: (roles: unknown, role: string, overrides: unknown) => string[]
  roleCapabilities_: (roles: unknown, role: string) => string[]
  guardRolesChangeByNonTop_: (acting: Acting, current: unknown, parsed: unknown) => Record<string, unknown>[]
  getRoles_: () => Record<string, unknown>[]
  invalidateRoles_: () => void
  CAPABILITY_KEYS: string[]
  CAPABILITY_ACTIONS: Record<string, string[]>
}

const TASKS: Record<string, Row> = {
  t1: { id: 't1', project_id: 'p1', department: 'pr', importance: 'normal', creator_id: 'm-base', assignee_id: 'm-base', reviewer_ids: 'm-res', visibility: '', deleted_at: '' },
  t2: { id: 't2', project_id: 'p2', department: 'dev', importance: 'important', creator_id: 'm-full', assignee_id: 'm-full', reviewer_ids: '', visibility: 'leaders', deleted_at: '' },
  t3: { id: 't3', project_id: 'p1', department: '', importance: 'normal', creator_id: '', assignee_id: '', reviewer_ids: '', visibility: '', deleted_at: '' },
}

function loadGas(roleSettings: Record<string, string>, members: Row[]) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Logger: { log() {} } })
  vm.runInContext(CODE_GS, ctx)
  vm.runInContext(BEFORE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.readRoleSettings_ = () => roleSettings
  c.authFindRow_ = (sheet: string, id: string) => {
    if (sheet === 'Tasks') return TASKS[id] ?? null
    if (sheet === 'Members') return members.find((m) => m.id === id) ?? null
    return null
  }
  return ctx as unknown as Gas
}

// 結果: 許可 / 断る(利用者向けのエラー) / それ以外のエラー(中身も比べる)
function outcome(fn: () => void): string {
  try {
    fn()
    return 'allow'
  } catch (e) {
    const err = e as { isUserError?: boolean; message?: string }
    return err.isUserError ? 'deny' : 'error: ' + err.message
  }
}

// 既定のままの役職(roles の設定がある団体と、移行前の今までの設定の団体)
const CODES_ROLES = {
  roles: JSON.stringify([
    { id: 'base', name: '一般', tier: 'base' },
    { id: 'r_restricted', name: '会計', tier: 'admin', restricted: true, sections: ['expenses', 'dashboard'] },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: 'r_manager', name: '事業責任者', tier: 'admin', restricted: false },
    { id: 'top', name: '代表', tier: 'top' },
  ]),
}
const LEGACY_ROLES = { role_levels: '班長,事業責任者,代表', restricted_roles: '班長', role_permissions: JSON.stringify({ 班長: ['approvals'] }) }

const recruiting = { targetType: 'recruiting', targetId: 'all', access: 'edit' }
const recruitingView = { targetType: 'recruiting', targetId: 'all', access: 'view' }
const projectEdit = { targetType: 'project', targetId: 'p1', access: 'edit' }
const taskApprove = { targetType: 'task', targetId: 't1', access: 'approve' }

function actorsFor(roles: 'codes' | 'legacy'): Acting[] {
  const r = roles === 'codes'
    ? { top: 'top', full: 'r_leader', full2: 'r_manager', restricted: 'r_restricted', base: 'base' }
    : { top: '代表', full: '事業責任者', full2: '事業責任者', restricted: '班長', base: '一般' }
  return [
    { id: 'm-top', role: r.top, project_ids: '', permission_overrides: [] },
    { id: 'm-full', role: r.full, project_ids: '', permission_overrides: [] },
    { id: 'm-full2', role: r.full2, project_ids: 'p1', permission_overrides: [recruiting] },
    { id: 'm-res', role: r.restricted, project_ids: 'p1', permission_overrides: [] },
    { id: 'm-res2', role: r.restricted, project_ids: '', permission_overrides: [recruiting, projectEdit, taskApprove] },
    { id: 'm-base', role: r.base, project_ids: '', permission_overrides: [] },
    { id: 'm-base2', role: r.base, project_ids: '', permission_overrides: [recruiting, recruitingView, projectEdit] },
    { id: 'm-ghost', role: '一覧に無い役職', project_ids: '', permission_overrides: [] },
  ]
}

function membersFor(actors: Acting[]): Row[] {
  return actors.map((a) => ({ id: a.id, role: a.role, reports_to_id: a.id === 'm-base' ? 'm-res' : '', project_ids: a.project_ids }))
}

// 判定に使われうる操作の名前: 入れる前の authorizeAction_ に書いてあった名前と、できる操作のまとまりの操作
function allActionNames(gas: Gas): string[] {
  const names = new Set<string>()
  for (const m of BEFORE_GS.matchAll(/'([a-z][A-Za-z]+)'/g)) names.add(m[1])
  for (const list of Object.values(gas.CAPABILITY_ACTIONS)) for (const a of list) names.add(a)
  names.add('someFutureAction')
  return [...names].sort()
}

function bodiesFor(actor: Acting, roles: 'codes' | 'legacy'): object[] {
  const leader = roles === 'codes' ? 'r_leader' : '事業責任者'
  const top = roles === 'codes' ? 'top' : '代表'
  const base = roles === 'codes' ? 'base' : '一般'
  return [
    {},
    { taskId: 't1' },
    { taskId: 't1', status: 'done' },
    { taskId: 't2', status: 'in_progress' },
    { taskId: 't3', assigneeIds: [actor.id] },
    { projectId: 'p1' },
    { projectId: 'p2' },
    { memberId: actor.id },
    { memberId: 'm-base' },
    { memberId: 'm-base', role: leader },
    { memberId: 'm-full', role: base },
    { memberId: 'm-top', role: leader },
    { memberId: 'm-base', role: top },
    { name: '新しい人', role: leader },
    { candidateId: 'c1', role: base },
    { candidateId: 'c1', role: leader },
  ]
}

describe.each(['codes', 'legacy'] as const)('既定のままの役職(%s)では、操作の可否が今までと1つも変わらない', (roles) => {
  it('すべての操作・役職・入力で、入れる前の authorizeAction_ と同じ結果になる', () => {
    const actors = actorsFor(roles)
    const gas = loadGas(roles === 'codes' ? CODES_ROLES : LEGACY_ROLES, membersFor(actors))
    const actions = allActionNames(gas)
    expect(actions.length).toBeGreaterThan(150)
    const diffs: string[] = []
    let compared = 0
    for (const actor of actors) {
      for (const action of actions) {
        for (const body of bodiesFor(actor, roles)) {
          const before = outcome(() => gas.authorizeActionBefore_(actor, action, JSON.parse(JSON.stringify(body))))
          const after = outcome(() => gas.authorizeAction_(actor, action, JSON.parse(JSON.stringify(body))))
          compared++
          if (before !== after) diffs.push(`${actor.id}(${actor.role}) ${action} ${JSON.stringify(body)}: ${before} → ${after}`)
        }
      }
    }
    expect(compared).toBeGreaterThan(15000)
    expect(diffs).toEqual([])
  })
})

// できる操作を渡した役職のある団体
const CUSTOM_ROLES = [
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'r_lead', name: '班長', tier: 'admin', restricted: true },
  { id: 'r_admin', name: '事業責任者', tier: 'admin', restricted: false },
  // 人事: 役職の変更・登録と、全権管理者の既定
  { id: 'r_hr', name: '人事', tier: 'admin', restricted: false, capabilities: ['members.add', 'members.role', 'org.rules', 'trash'] },
  // 制限ありの人事(制限なしの役職は付けられない)
  { id: 'r_hr_lite', name: '人事補佐', tier: 'admin', restricted: true, capabilities: ['members.add', 'members.role'] },
  // 退会もできる管理者(人事の持っていない操作を持つ)
  { id: 'r_super', name: '副代表', tier: 'admin', restricted: false, capabilities: ['members.add', 'members.role', 'members.remove', 'org.rules', 'trash'] },
  { id: 'top', name: '代表', tier: 'top' },
]
const CUSTOM_MEMBERS: Row[] = [
  { id: 'm-top', role: 'top' },
  { id: 'm-admin', role: 'r_admin' },
  { id: 'm-hr', role: 'r_hr' },
  { id: 'm-hr-lite', role: 'r_hr_lite' },
  { id: 'm-super', role: 'r_super' },
  { id: 'm-lead', role: 'r_lead' },
  { id: 'm-base', role: 'base' },
]
const actingOf = (id: string): Acting => ({ id, role: CUSTOM_MEMBERS.find((m) => m.id === id)!.role, project_ids: '', permission_overrides: [] })
const customGas = () => loadGas({ roles: JSON.stringify(CUSTOM_ROLES) }, CUSTOM_MEMBERS)
const tryAuth = (gas: Gas, id: string, action: string, body: object) => {
  try {
    gas.authorizeAction_(actingOf(id), action, body)
    return 'ok'
  } catch (e) {
    return (e as Error).message
  }
}

describe('昇権の防止(members.role を持つ、最上位でない人)', () => {
  const gas = customGas()

  it('役職の変更: 自分の持っている範囲の役職を、ほかの人に付けられる', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-base', role: 'r_admin' })).toBe('ok')
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-base', role: 'r_lead' })).toBe('ok')
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-lead', role: 'base' })).toBe('ok')
  })

  it('最上位の役職は付けられない', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-base', role: 'top' })).toMatch(/最上位の役職は、最上位の役職の人だけが付けられます/)
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-base', role: '代表' })).toMatch(/最上位の役職は/)
  })

  it('最上位の役職の人の役職は変えられない', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-top', role: 'r_admin' })).toMatch(/最上位の役職の人の役職は/)
  })

  it('自分の役職は変えられない', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-hr', role: 'r_super' })).toMatch(/自分の役職は変えられません/)
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-hr', role: 'base' })).toMatch(/自分の役職は変えられません/)
  })

  it('自分が持っていない操作を持つ役職は付けられない', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-base', role: 'r_super' })).toMatch(/自分が持っていない操作ができる役職は付けられません/)
    // 制限ありの人は、制限なしの役職(範囲の広い役職)も付けられない
    expect(tryAuth(gas, 'm-hr-lite', 'updateRole', { memberId: 'm-base', role: 'r_admin' })).toMatch(/自分が持っていない操作ができる役職/)
    expect(tryAuth(gas, 'm-hr-lite', 'updateRole', { memberId: 'm-base', role: 'r_lead' })).toBe('ok')
  })

  it('自分が持っていない操作を持つ人の役職は変えられない(格下げで力を奪わない)', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-super', role: 'base' })).toMatch(/自分が持っていない操作ができる人の役職は変えられません/)
    expect(tryAuth(gas, 'm-hr-lite', 'updateRole', { memberId: 'm-admin', role: 'base' })).toMatch(/自分が持っていない操作ができる人の役職は変えられません/)
  })

  it('一覧に無い役職は付けられない', () => {
    expect(tryAuth(gas, 'm-hr', 'updateRole', { memberId: 'm-base', role: '存在しない役職' })).toMatch(/役職が見つかりません/)
  })

  it('メンバーの登録(役職を付けて登録)も同じ決まり', () => {
    expect(tryAuth(gas, 'm-hr', 'addMember', { name: 'A', role: 'r_admin' })).toBe('ok')
    expect(tryAuth(gas, 'm-hr', 'addMember', { name: 'A' })).toBe('ok')
    expect(tryAuth(gas, 'm-hr', 'addMember', { name: 'A', role: 'top' })).toMatch(/最上位の役職は/)
    expect(tryAuth(gas, 'm-hr', 'addMember', { name: 'A', role: 'r_super' })).toMatch(/自分が持っていない操作ができる役職/)
    expect(tryAuth(gas, 'm-hr-lite', 'addMember', { name: 'A', role: 'r_admin' })).toMatch(/自分が持っていない操作ができる役職/)
  })

  it('members.role を持たない管理者(既定の全権管理者)は、役職を変えられない', () => {
    expect(tryAuth(gas, 'm-admin', 'updateRole', { memberId: 'm-base', role: 'r_lead' })).toMatch(/メンバーの役職の変更/)
    expect(tryAuth(gas, 'm-admin', 'addMember', { name: 'A' })).toMatch(/メンバーの登録・招待/)
  })

  it('最上位の人は、これまでどおり何でも付けられる', () => {
    expect(tryAuth(gas, 'm-top', 'updateRole', { memberId: 'm-base', role: 'top' })).toBe('ok')
    expect(tryAuth(gas, 'm-top', 'updateRole', { memberId: 'm-super', role: 'base' })).toBe('ok')
  })

  it('候補者を一般以外の役職で登録するには、採用に加えてメンバーの登録と同じ確認が要る', () => {
    const roles = JSON.parse(JSON.stringify(CUSTOM_ROLES))
    roles.find((r: { id: string }) => r.id === 'r_hr').capabilities.push('recruiting')
    const g = loadGas({ roles: JSON.stringify(roles) }, CUSTOM_MEMBERS)
    expect(tryAuth(g, 'm-hr', 'convertCandidateToMember', { candidateId: 'c1', role: 'base' })).toBe('ok')
    expect(tryAuth(g, 'm-hr', 'convertCandidateToMember', { candidateId: 'c1', role: 'r_lead' })).toBe('ok')
    expect(tryAuth(g, 'm-hr', 'convertCandidateToMember', { candidateId: 'c1', role: 'top' })).toMatch(/最上位の役職は/)
    expect(tryAuth(g, 'm-hr', 'convertCandidateToMember', { candidateId: 'c1', role: 'r_super' })).toMatch(/自分が持っていない操作/)
  })
})

describe('役職のできる操作を変えられるのは最上位だけ(updateRoles)', () => {
  const gas = customGas()
  const current = () => gas.getRoles_()
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

  it('最上位でない人は、役職のできる操作を変えられない(足す・減らす)', () => {
    const add = clone(current())
    ;(add.find((r) => r.id === 'r_lead') as { capabilities?: string[] }).capabilities = ['members.remove']
    expect(() => gas.guardRolesChangeByNonTop_(actingOf('m-admin'), current(), add)).toThrow(/役職のできる操作は、最上位の役職の人だけが変えられます/)
    const remove = clone(current())
    ;(remove.find((r) => r.id === 'r_super') as { capabilities?: string[] }).capabilities = []
    expect(() => gas.guardRolesChangeByNonTop_(actingOf('m-hr'), current(), remove)).toThrow(/役職のできる操作は/)
  })

  it('画面ができる操作を送らなくても、書いてあったできる操作は残る', () => {
    const next = clone(current()).map((r) => { const o = { ...r }; delete o.capabilities; return o })
    const saved = gas.guardRolesChangeByNonTop_(actingOf('m-admin'), current(), next)
    expect(saved.find((r) => r.id === 'r_super')!.capabilities).toEqual(['members.add', 'members.role', 'members.remove', 'trash', 'org.rules'])
  })

  it('名前・見られるタブの変更は、今までどおりできる', () => {
    const next = clone(current())
    next.find((r) => r.id === 'r_lead')!.name = '班長(新)'
    next.find((r) => r.id === 'r_lead')!.sections = ['approvals', 'v2']
    expect(() => gas.guardRolesChangeByNonTop_(actingOf('m-admin'), current(), next)).not.toThrow()
  })

  it('既定のままの役職を全権管理者が制限なしにすると、今までどおり既定(org.rules・trash)になる', () => {
    const next = clone(current())
    next.find((r) => r.id === 'r_lead')!.restricted = false
    const saved = gas.guardRolesChangeByNonTop_(actingOf('m-admin'), current(), next)
    const lead = saved.find((r) => r.id === 'r_lead')!
    expect(lead.capabilities).toBeUndefined()
    expect(gas.roleCapabilities_(saved, 'r_lead')).toEqual(['trash', 'org.rules'])
  })

  it('制限ありの人は、役職の制限を変えられず、制限なしの役職を作れない', () => {
    const roles = clone(CUSTOM_ROLES)
    roles.find((r) => r.id === 'r_lead')!.capabilities = ['org.rules']
    const g = loadGas({ roles: JSON.stringify(roles) }, CUSTOM_MEMBERS)
    const cur = g.getRoles_()
    const flip = clone(cur)
    flip.find((r) => r.id === 'r_lead')!.restricted = false
    expect(() => g.guardRolesChangeByNonTop_(actingOf('m-lead'), cur, flip)).toThrow(/役職の制限/)
    const added = [...clone(cur)]
    added.splice(1, 0, { id: 'r_new', name: '新役職', tier: 'admin', restricted: false })
    expect(() => g.guardRolesChangeByNonTop_(actingOf('m-lead'), cur, added)).toThrow(/制限なしの役職は/)
  })

  it('新しい役職は、自分の持っている操作の範囲だけ', () => {
    const added = clone(current())
    added.splice(1, 0, { id: 'r_new', name: '新役職', tier: 'admin', restricted: true, capabilities: ['members.remove'] })
    expect(() => gas.guardRolesChangeByNonTop_(actingOf('m-admin'), current(), added)).toThrow(/自分が持っていない操作ができる役職は作れません/)
    const ok = clone(current())
    ok.splice(1, 0, { id: 'r_new', name: '新役職', tier: 'admin', restricted: false })
    expect(() => gas.guardRolesChangeByNonTop_(actingOf('m-admin'), current(), ok)).not.toThrow()
  })

  it('updateRoles_ は最上位でない人の保存に、この確かめを通す', () => {
    const start = CODE_GS.indexOf('function updateRoles_(')
    const body = CODE_GS.slice(start, CODE_GS.indexOf('\nfunction ', start + 10))
    expect(body).toMatch(/if \(!isTopRoleRef_\(current, acting\.role\)\) parsed = guardRolesChangeByNonTop_\(acting, current, parsed\)/)
  })
})

describe('渡せない操作(どの設定でも最上位だけ)', () => {
  it('すべてのできる操作を持つ役職でも、バックアップ・個人情報・利用の状況・診断・権限の例外の編集はできない', () => {
    const roles = JSON.parse(JSON.stringify(CUSTOM_ROLES))
    roles.find((r: { id: string }) => r.id === 'r_admin').capabilities = ['members.add', 'members.role', 'members.remove', 'members.hr', 'members.training', 'recruiting', 'projects.remove', 'trash', 'org.rules', 'org.logo']
    const g = loadGas({ roles: JSON.stringify(roles) }, CUSTOM_MEMBERS)
    for (const action of ['listBackups', 'restoreBackup', 'createBackupNow', 'purgePersonalDataNow', 'setPersonalDataRetention', 'getUsageStatus', 'getMetricsStatus', 'setMetricsSharing', 'getDiagnostics', 'sendDiagnostics', 'getOpsStatus', 'updatePermissionOverrides']) {
      expect(tryAuth(g, 'm-admin', action, { memberId: 'm-base' }), action).not.toBe('ok')
    }
    // 渡したものはできる
    for (const action of ['removeMember', 'updateReportsTo', 'notifyTrainingDecision', 'addCandidate', 'removeProject', 'uploadOrgLogo', 'purgeTask', 'updateSetting']) {
      expect(tryAuth(g, 'm-admin', action, { memberId: 'm-base', projectId: 'p1', taskId: 't1' }), action).toBe('ok')
    }
  })

  it('一般の役職には、設定に書いてあってもできる操作を渡さない', () => {
    const roles = JSON.parse(JSON.stringify(CUSTOM_ROLES))
    roles[0].capabilities = ['members.remove']
    const g = loadGas({ roles: JSON.stringify(roles) }, CUSTOM_MEMBERS)
    expect(g.roleCapabilities_(g.getRoles_(), 'base')).toEqual([])
    expect(tryAuth(g, 'm-base', 'removeMember', { memberId: 'm-lead' })).not.toBe('ok')
  })
})

describe('画面に渡すできる操作の一覧', () => {
  const gas = customGas()
  const roles = gas.getRoles_()
  it('既定: 最上位はすべて、制限なしの管理者は org.rules・trash、制限ありの管理者と一般はなし', () => {
    expect(gas.memberCapabilities_(roles, 'top', [])).toEqual(gas.CAPABILITY_KEYS)
    expect(gas.memberCapabilities_(roles, 'r_admin', [])).toEqual(['trash', 'org.rules'])
    expect(gas.memberCapabilities_(roles, 'r_lead', [])).toEqual([])
    expect(gas.memberCapabilities_(roles, 'base', [])).toEqual([])
    // 一覧に無い役職は、今までと同じく制限なしの管理者
    expect(gas.memberCapabilities_(roles, '一覧に無い役職', [])).toEqual(['trash', 'org.rules'])
  })
  it('役職に書いたできる操作を使う', () => {
    expect(gas.memberCapabilities_(roles, 'r_hr', [])).toEqual(['members.add', 'members.role', 'trash', 'org.rules'])
  })
  it('採用の例外(編集以上)があれば recruiting を足す。閲覧だけ・ほかの種類の例外では足さない', () => {
    expect(gas.memberCapabilities_(roles, 'base', [recruiting])).toEqual(['recruiting'])
    expect(gas.memberCapabilities_(roles, 'base', [recruitingView, projectEdit, taskApprove])).toEqual([])
  })
  it('起動時のデータ(getInitialDataForMember_)に入れる', () => {
    const start = CODE_GS.indexOf('function getInitialDataForMember_(')
    const body = CODE_GS.slice(start, CODE_GS.indexOf('\nfunction ', start + 10))
    expect(body).toMatch(/capabilities: capabilities/)
  })
})
