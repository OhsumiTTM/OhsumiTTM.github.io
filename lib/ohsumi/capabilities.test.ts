// できる操作の定義と計算(lib/ohsumi/capabilities.ts・roles.ts)が、GAS(gas/src/38-capabilities.gs)と一致すること
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_ACTIONS, CAPABILITY_KEYS, TOP_ONLY_ACTIONS, capabilityOfAction, normalizeCapabilities } from './capabilities'
import { memberCapabilities, parseRolesSetting, resolveMemberCapabilities, roleAssignBlock, roleCapabilities, rolesFromLegacy, type RoleDef } from './roles'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

function loadGas(roles: RoleDef[], members: { id: string; role: string }[]) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.readRoleSettings_ = () => ({ roles: JSON.stringify(roles) })
  c.authFindRow_ = (_sheet: string, id: string) => members.find((m) => m.id === id) ?? null
  return ctx as unknown as Record<string, (...a: unknown[]) => unknown> & Record<string, unknown>
}

const ROLES: RoleDef[] = [
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'r_lead', name: '班長', tier: 'admin', restricted: true },
  { id: 'r_lead2', name: '会計', tier: 'admin', restricted: true, capabilities: ['members.role', 'recruiting'] },
  { id: 'r_admin', name: '事業責任者', tier: 'admin', restricted: false },
  { id: 'r_hr', name: '人事', tier: 'admin', restricted: false, capabilities: ['members.add', 'members.role', 'org.rules', 'trash'] },
  { id: 'r_none', name: '見るだけ', tier: 'admin', restricted: false, capabilities: [] },
  { id: 'r_super', name: '副代表', tier: 'admin', restricted: false, capabilities: [...CAPABILITY_KEYS] },
  { id: 'top', name: '代表', tier: 'top' },
]
const MEMBERS = ROLES.map((r) => ({ id: 'm-' + r.id, role: r.id })).concat([{ id: 'm-ghost', role: '一覧に無い役職' }])
const REFS = [...ROLES.map((r) => r.id), ...ROLES.map((r) => r.name), '', '一覧に無い役職']

describe('GAS と同じ定義', () => {
  const gas = loadGas(ROLES, MEMBERS)
  it('まとまりのキー・操作・最上位だけの操作', () => {
    expect(plain(gas.CAPABILITY_KEYS)).toEqual([...CAPABILITY_KEYS])
    expect(plain(gas.CAPABILITY_ACTIONS)).toEqual(plain(CAPABILITY_ACTIONS))
    expect(plain(gas.TOP_ONLY_ACTIONS)).toEqual([...TOP_ONLY_ACTIONS])
    expect(plain(gas.FULL_ADMIN_DEFAULT_CAPABILITIES)).toEqual(['org.rules', 'trash'])
    for (const [key, actions] of Object.entries(CAPABILITY_ACTIONS)) for (const a of actions) expect(capabilityOfAction(a)).toBe(key)
  })
  it('正規化(知らないキーを除き、決まった順に)', () => {
    for (const list of [[], ['trash', 'org.rules'], ['x', 'members.add', 'members.add'], ['org.logo', 'recruiting', 'members.hr']]) {
      expect(plain(gas.normalizeCapabilities_(list))).toEqual(normalizeCapabilities(list))
    }
  })
  it('役職の設定に書いたできる操作の読み込み(管理者の役職だけ)', () => {
    const value = JSON.stringify([...ROLES, { id: 'r_x', name: 'X', tier: 'admin', capabilities: ['nope', 'trash'] }].map((r) => (r.tier === 'base' ? { ...r, capabilities: ['members.remove'] } : r)))
    expect(plain(gas.parseRolesSetting_(value))).toEqual(plain(parseRolesSetting(value)))
  })
  it('役職のできる操作(roles の設定がある団体・今までの設定の団体)', () => {
    for (const ref of REFS) expect(plain(gas.roleCapabilities_(ROLES, ref)), ref).toEqual(roleCapabilities(ROLES, ref))
    const legacy = rolesFromLegacy({ role_levels: '班長,事業責任者,代表', restricted_roles: '班長' })
    for (const ref of ['班長', '事業責任者', '代表', '一般', '', 'ほか']) {
      expect(plain(gas.roleCapabilities_(plain(legacy), ref)), ref).toEqual(roleCapabilities(legacy, ref))
    }
  })
  it('人ごとの例外を合わせたできる操作', () => {
    const overrideSets = [
      [],
      [{ targetType: 'recruiting', targetId: 'all', access: 'edit' }],
      [{ targetType: 'recruiting', targetId: 'all', access: 'approve' }],
      [{ targetType: 'recruiting', targetId: 'all', access: 'view' }],
      [{ targetType: 'project', targetId: 'p1', access: 'approve' }],
    ] as const
    for (const ref of REFS) for (const ov of overrideSets) {
      expect(plain(gas.memberCapabilities_(ROLES, ref, plain(ov))), ref + JSON.stringify(ov)).toEqual(memberCapabilities(ROLES, ref, plain(ov)))
    }
  })
  it('役職を付けられるか(画面で選べる役職と、GAS が受け付ける役職が同じ)', () => {
    for (const actor of MEMBERS) {
      for (const target of [undefined, ...MEMBERS]) {
        for (const roleRef of [...ROLES.map((r) => r.id), '代表', '存在しない']) {
          let gasOk = true
          try {
            ;(gas.assertRoleAssignable_ as (a: unknown, r: string, t: string | null) => void)(actor, roleRef, target ? target.id : null)
          } catch {
            gasOk = false
          }
          // 最上位の人は GAS の authorizeAction_ が先に許可する(assertRoleAssignable_ を呼ばない)
          if (actor.role === 'top') continue
          const block = roleAssignBlock(ROLES, actor, roleRef, target)
          expect(block === null, `${actor.id} → ${target?.id ?? '(登録)'}: ${roleRef} (${block})`).toBe(gasOk)
        }
      }
    }
  })
})

describe('画面で使うできる操作(GAS が一覧を送らない時)', () => {
  const legacy = rolesFromLegacy({ role_levels: '班長,事業責任者,代表', restricted_roles: '班長' })
  const twoTops: RoleDef[] = [...ROLES.slice(0, -1), { id: 'r_chair', name: '会長', tier: 'top' }, ROLES[ROLES.length - 1]]
  it('古い GAS(一覧が無い): 画面と同じ計算をする。最上位はすべてできる', () => {
    expect(resolveMemberCapabilities({ remote: true, server: null, roles: ROLES, role: 'top', overrides: [] })).toEqual([...CAPABILITY_KEYS])
    expect(resolveMemberCapabilities({ remote: true, server: null, roles: legacy, role: '代表', overrides: [] })).toEqual([...CAPABILITY_KEYS])
    expect(resolveMemberCapabilities({ remote: true, server: null, roles: ROLES, role: 'r_admin', overrides: [] })).toEqual(['trash', 'org.rules'])
    expect(resolveMemberCapabilities({ remote: true, server: null, roles: ROLES, role: 'base', overrides: [] })).toEqual([])
  })
  it('最上位が2つある団体: 代表でない最上位もすべてできる(役職の名前・ID のどちらで書かれていても)', () => {
    for (const ref of ['r_chair', '会長']) expect(resolveMemberCapabilities({ remote: true, server: null, roles: twoTops, role: ref, overrides: [] }), ref).toEqual([...CAPABILITY_KEYS])
  })
  it('GAS が送った一覧があれば、それを使う', () => {
    expect(resolveMemberCapabilities({ remote: true, server: ['trash'], roles: ROLES, role: 'top', overrides: [] })).toEqual(['trash'])
    expect(resolveMemberCapabilities({ remote: true, server: [], roles: ROLES, role: 'top', overrides: [] })).toEqual([])
  })
  it('store は、一覧の無い応答(unchanged・古い GAS)で受け取った一覧を消さない。消すのはログアウトの時だけ', () => {
    const store = readFileSync(join(__dirname, 'store.tsx'), 'utf8')
    const sets = [...store.matchAll(/setServerCapabilities\(([^)]*)\)/g)].map((m) => m[1])
    expect(sets).toEqual(['res.capabilities', 'null'])
    expect(store).toMatch(/if \(res\.capabilities\) setServerCapabilities\(res\.capabilities\)/)
  })
})
