// 役職の一覧と判定(lib/ohsumi/roles.ts)と、GAS(gas/Code.gs)の同じ関数が一致すること。
// 役職の名前を変えても判定が変わらないこと、表示名の決まりを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as R from './roles'
import { roleLabel } from './i18n'
import { ja } from './i18n/ja'
import { en } from './i18n/en'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
vm.runInContext(CODE_GS, ctx)
const gas = ctx as unknown as Record<string, (...args: unknown[]) => unknown> & Record<string, unknown>
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

// 今までの設定のいろいろな組み合わせ
const LEGACY_CASES: Record<string, string | undefined>[] = [
  {},
  { role_levels: '班長,事業責任者,代表' },
  { role_levels: '班長,代表', restricted_roles: '班長' },
  { role_levels: '事業責任者', restricted_roles: '会計係' }, // 代表が無い・制限だけの役職
  { role_levels: '一般,班長', role_permissions: '{"班長":["projects"]}', job_requirements: '{"一般":["企画"],"班長":["リーダー"]}' },
  { role_levels: '班長', role_permissions: '{壊れた' },
]

const CODED: R.RoleDef[] = [
  { id: 'base', name: '一般', tier: 'base', requiredSkills: ['企画'] },
  { id: 'r_leader', name: '班長', tier: 'admin', restricted: true, sections: ['projects'] },
  { id: 'r_manager', name: '事業責任者', tier: 'admin', restricted: false },
  { id: 'top', name: '代表', tier: 'top' },
]

describe('GAS と同じ結果になる', () => {
  it('今までの設定から組み立てた役職の一覧', () => {
    for (const settings of LEGACY_CASES) {
      expect(plain(gas.rolesFromLegacy(settings)), JSON.stringify(settings)).toEqual(R.rolesFromLegacy(settings))
    }
  })

  it('roles の読み込み(正しくない形式は今までの設定から)', () => {
    const cases = [
      JSON.stringify(CODED),
      JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }]), // 最上位が無い
      JSON.stringify([...CODED, { id: 'x', name: '代表', tier: 'admin' }]), // 名前の重複
      JSON.stringify([{ id: 'base', name: '一般', tier: 'boss' }]),
      '[壊れた',
      '',
    ]
    for (const raw of cases) {
      expect(plain(gas.parseRolesSetting(raw)), raw).toEqual(R.parseRolesSetting(raw))
      expect(plain(gas.rolesFromSettings({ roles: raw, restricted_roles: '班長' })), raw).toEqual(
        R.rolesFromSettings({ roles: raw, restricted_roles: '班長' }),
      )
    }
    expect(R.parseRolesSetting(JSON.stringify(CODED))).toEqual(CODED)
  })

  it('役職の判定(ID・名前・空・一覧に無い役職)', () => {
    const lists = [CODED, R.rolesFromLegacy({ restricted_roles: '班長' })]
    const refs = ['base', 'top', 'r_leader', 'r_manager', '一般', '代表', '班長', '事業責任者', '', '未知の役職', undefined]
    for (const roles of lists) {
      for (const ref of refs) {
        const label = `${JSON.stringify(ref)} in ${roles[0].id}`
        expect(gas.roleTier(roles, ref), label).toBe(R.roleTier(roles, ref))
        expect(gas.isTopRoleRef(roles, ref), label).toBe(R.isTopRoleRef(roles, ref))
        expect(gas.isAdminRoleRef(roles, ref), label).toBe(R.isAdminRoleRef(roles, ref))
        expect(gas.isFullAdminRoleRef(roles, ref), label).toBe(R.isFullAdminRoleRef(roles, ref))
        expect(plain(gas.restrictedSections(roles, ref)), label).toEqual(R.restrictedSections(roles, ref))
        for (const other of refs) expect(gas.sameRole(roles, ref, other), `${label} vs ${other}`).toBe(R.sameRole(roles, ref, other))
      }
    }
  })

  it('今までの設定に戻す値・決まりごと・既定の役職', () => {
    for (const roles of [CODED, R.rolesFromLegacy(LEGACY_CASES[4])]) {
      expect(plain(gas.rolesToLegacySettings(roles))).toEqual(R.rolesToLegacySettings(roles))
    }
    expect(plain(gas.validateRoles([CODED[0], CODED[0]]))).toEqual(R.validateRoles([CODED[0], CODED[0]]))
    expect(plain(gas.defaultRoles())).toEqual(R.defaultRoles())
    expect(gas.DEFAULT_NON_TOP_SECTIONS).toBeDefined()
    expect([...(gas.DEFAULT_NON_TOP_SECTIONS as unknown as string[])]).toEqual(R.restrictedSections([], 'x'))
  })
})

describe('今までの設定からの役職', () => {
  it('一般・今までの役職・代表の順で、ID は役職名', () => {
    expect(R.rolesFromLegacy({}).map((r) => [r.id, r.tier])).toEqual([
      ['一般', 'base'], ['班長', 'admin'], ['事業責任者', 'admin'], ['代表', 'top'],
    ])
  })

  it('restricted_roles にだけある役職も制限付きの管理者(今までと同じ)', () => {
    const roles = R.rolesFromLegacy({ role_levels: '事業責任者', restricted_roles: '会計係' })
    expect(R.isAdminRoleRef(roles, '会計係')).toBe(true)
    expect(R.isFullAdminRoleRef(roles, '会計係')).toBe(false)
  })

  it('今までの設定に戻すと、同じ一覧になる', () => {
    const roles = R.rolesFromLegacy(LEGACY_CASES[4])
    expect(R.rolesFromLegacy(R.rolesToLegacySettings(roles))).toEqual(roles)
  })
})

describe('名前を変えても判定は変わらない(移行後)', () => {
  const renamed = CODED.map((r) => ({ ...r, name: r.id === 'top' ? 'President' : r.id === 'base' ? 'Member' : r.name + '(改)' }))

  it('最上位・管理者・一般の判定', () => {
    for (const id of ['base', 'r_leader', 'r_manager', 'top']) {
      expect(R.roleTier(renamed, id)).toBe(R.roleTier(CODED, id))
      expect(R.isFullAdminRoleRef(renamed, id)).toBe(R.isFullAdminRoleRef(CODED, id))
      expect(R.restrictedSections(renamed, id)).toEqual(R.restrictedSections(CODED, id))
    }
  })

  it('承認ステップの役職は、ID・古い名前・新しい名前のどれでも同じ役職', () => {
    // 移行前の申請(役職名)と移行後の申請(ID)が混ざっていても、同じ人が承認者になる
    expect(R.sameRole(CODED, '班長', 'r_leader')).toBe(true)
    expect(R.sameRole(renamed, 'r_leader', '班長(改)')).toBe(true)
    expect(R.sameRole(CODED, '班長', '事業責任者')).toBe(false)
    expect(R.sameRole(CODED, '', 'r_leader')).toBe(false)
  })
})

describe('表示名(roleLabel)', () => {
  const tJa = (k: keyof typeof ja) => ja[k]
  const tEn = (k: keyof typeof en) => en[k]

  it('一般・代表の既定の名前のままなら翻訳する(英語で片方だけ日本語に残らない)', () => {
    expect(roleLabel(tEn, CODED, 'base')).toBe(en['role.base'])
    expect(roleLabel(tEn, CODED, 'top')).toBe(en['role.top'])
    expect(roleLabel(tEn, CODED, '代表')).toBe(en['role.top'])
    expect(roleLabel(tJa, CODED, 'top')).toBe('代表')
    expect(en['role.top']).not.toBe('代表')
  })

  it('団体が名前を変えた役職・そのほかの役職は、名前をそのまま表示する', () => {
    const renamed = CODED.map((r) => (r.tier === 'top' ? { ...r, name: '会長' } : r.tier === 'base' ? { ...r, name: '部員' } : r))
    expect(roleLabel(tEn, renamed, 'top')).toBe('会長')
    expect(roleLabel(tEn, renamed, 'base')).toBe('部員')
    expect(roleLabel(tEn, CODED, 'r_leader')).toBe('班長')
    // 一覧に無い役職はその値、空は一般
    expect(roleLabel(tEn, CODED, '昔の役職')).toBe('昔の役職')
    expect(roleLabel(tEn, CODED, '')).toBe(en['role.base'])
  })
})
