// gas/Code.gs の役職の編集(updateRoles・deleteRole)と、最上位の役職の締め出し防止、
// 役職の設定の書き込み先(移行前は今までの設定、roles がある時は roles)を確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { defaultRoles, type RoleDef } from './roles'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

class FakeSheet {
  constructor(public rows: unknown[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return { getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')) }
  }
}

const MEMBER_HEADERS = ['id', 'name', 'role', 'inactive']

// members: [id, role, inactive?]、settings: key → value
function setup(members: [string, string, string?][], settings: Record<string, string> = {}, props: Record<string, string> = {}) {
  const sheets: Record<string, FakeSheet> = {
    Members: new FakeSheet([MEMBER_HEADERS, ...members.map(([id, role, inactive]) => [id, id, role, inactive ?? ''])]),
    Settings: new FakeSheet([['key', 'value'], ...Object.entries(settings)]),
  }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: (k: string) => props[k] ?? null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null }) },
  })
  vm.runInContext(CODE_GS, ctx)
  const gas = ctx as unknown as Record<string, (...args: unknown[]) => unknown>
  // 書き込みはメモリ上のシートに反映する
  const writes: Record<string, string> = {}
  ;(ctx as unknown as Record<string, unknown>).updateSetting_ = (key: string, value: string) => {
    writes[key] = value
    const row = sheets.Settings.rows.find((r, i) => i > 0 && r[0] === key)
    if (row) row[1] = value
    else sheets.Settings.rows.push([key, value])
    return { key }
  }
  ;(ctx as unknown as Record<string, unknown>).updateMemberFields_ = (id: string, fields: Record<string, string>) => {
    const row = sheets.Members.rows.find((r, i) => i > 0 && r[0] === id)!
    for (const [k, v] of Object.entries(fields)) row[MEMBER_HEADERS.indexOf(k)] = v
    return { ok: true }
  }
  const roleOfMember = (id: string) => String(sheets.Members.rows.find((r) => r[0] === id)![2])
  const roles = () => JSON.parse(JSON.stringify(gas.getRoles_())) as RoleDef[]
  const act = (fn: () => unknown) => { gas.resetRequestProps_(); return fn() }
  return { gas, sheets, writes, roleOfMember, roles, act }
}

const top = (id = 'm-top', role = '代表') => ({ id, role, permission_overrides: [] })
const fullAdmin = { id: 'm-admin', role: '事業責任者', permission_overrides: [] }

describe('移行前(roles が無い): 今までの設定に書く', () => {
  const members: [string, string][] = [['m-top', '代表'], ['m-admin', '事業責任者'], ['m-lead', '班長'], ['m-1', '一般']]

  it('並び順・制限・セクション・必要スキルを今までの設定に書く', () => {
    const t = setup(members)
    const next = t.roles().map((r) => (r.id === '班長' ? { ...r, restricted: true, sections: ['projects'], requiredSkills: ['企画'] } : r))
    t.act(() => t.gas.updateRoles_(fullAdmin, next))
    expect(t.writes).toEqual({
      role_levels: '班長,事業責任者,代表',
      restricted_roles: '班長',
      role_permissions: JSON.stringify({ 班長: ['projects'] }),
      job_requirements: JSON.stringify({ 班長: ['企画'] }),
    })
    expect(t.writes.roles).toBeUndefined()
    // 読み直すと同じ一覧
    t.gas.invalidateRoles_()
    expect(t.roles()).toEqual(next)
  })

  it('名前の変更と、代表以外の最上位の役職は受け付けない', () => {
    const t = setup(members)
    const renamed = t.roles().map((r) => (r.id === '班長' ? { ...r, name: 'リーダー' } : r))
    expect(() => t.act(() => t.gas.updateRoles_(top(), renamed))).toThrow(/移行の後/)
    const secondTop = t.roles().map((r) => (r.id === '班長' ? { ...r, tier: 'top' } : r))
    expect(() => t.act(() => t.gas.updateRoles_(top(), secondTop))).toThrow(/移行の後/)
  })

  it('メンバーのいる役職を削除すると、メンバーを移してから今までの設定から消す(メンバーの役職は役職名)', () => {
    const t = setup(members)
    t.act(() => t.gas.deleteRole_(top(), '班長', '事業責任者'))
    expect(t.roleOfMember('m-lead')).toBe('事業責任者')
    expect(t.writes.role_levels).toBe('事業責任者,代表')
  })

  it('updateSetting で今までの役職の設定を書くのは(古いタブのため)受け付け、roles は受け付けない', () => {
    const t = setup(members)
    expect(() => t.act(() => {
      // doPost の updateSetting と同じ確認
      if (t.gas.hasRolesSetting_()) throw new Error('rejected')
    })).not.toThrow()
    const src = CODE_GS.slice(CODE_GS.indexOf("case 'updateSetting':"), CODE_GS.indexOf("case 'uploadOrgLogo':"))
    expect(src).toMatch(/body\.key === 'roles' \|\| \(hasRolesSetting_\(\) && ROLE_SETTING_KEYS\.indexOf\(body\.key\) >= 0\)/)
  })
})

describe('移行後(roles がある): roles に書き、ID で扱う', () => {
  const settings = { roles: JSON.stringify(defaultRoles()) }
  const members: [string, string][] = [['m-top', 'top'], ['m-admin', 'r_manager'], ['m-lead', 'r_leader'], ['m-1', 'base'], ['m-old', '班長']]

  it('名前を変えても、メンバーの役職(ID)と判定は変わらない', () => {
    const t = setup(members, settings, { VALUE_FORMAT: 'codes' })
    const renamed = t.roles().map((r) => (r.id === 'top' ? { ...r, name: 'President' } : r.id === 'r_leader' ? { ...r, name: 'リーダー' } : r))
    t.act(() => t.gas.updateRoles_(top('m-top', 'top'), renamed))
    expect(JSON.parse(t.writes.roles)).toEqual(renamed)
    expect(t.writes.role_levels).toBeUndefined()
    t.gas.invalidateRoles_()
    // 最上位の名前を「President」にしても代表専用の操作ができる
    expect(() => t.act(() => t.gas.authorizeAction_(top('m-top', 'top'), 'updateRole', { memberId: 'm-1', role: 'r_leader' }))).not.toThrow()
    // 古い名前(班長)のまま残っていたメンバー(m-old)は、名前の変更と同時に役職の ID にそろえる
    expect(t.roleOfMember('m-old')).toBe('r_leader')
    expect(t.roleOfMember('m-lead')).toBe('r_leader')
    expect(t.gas.sameRole_(t.gas.getRoles_(), 'リーダー', 'r_leader')).toBe(true)
  })

  it('最上位の役職を増やせるのは最上位の役職の人だけ(全権管理者は不可)', () => {
    const t = setup(members, settings, { VALUE_FORMAT: 'codes' })
    const next = t.roles().map((r) => (r.id === 'r_manager' ? { ...r, tier: 'top', restricted: undefined } : r))
    expect(() => t.act(() => t.gas.updateRoles_({ ...fullAdmin, role: 'r_manager' }, next))).toThrow(/最上位の役職を持つメンバーだけ/)
    expect(() => t.act(() => t.gas.updateRoles_(top('m-top', 'top'), next))).not.toThrow()
  })

  it('役職を消す・一般の種類を変える変更は updateRoles では受け付けない', () => {
    const t = setup(members, settings, { VALUE_FORMAT: 'codes' })
    expect(() => t.act(() => t.gas.updateRoles_(top('m-top', 'top'), t.roles().filter((r) => r.id !== 'r_leader')))).toThrow(/役職の削除を使って/)
    const baseToAdmin = t.roles().map((r) => (r.id === 'base' ? { ...r, tier: 'admin' } : r))
    expect(() => t.act(() => t.gas.updateRoles_(top('m-top', 'top'), baseToAdmin))).toThrow()
  })

  it('削除: 一般・最初の最上位は削除できない。メンバーを移すのは最上位の人だけ。移した先は ID で書く', () => {
    const t = setup(members, settings, { VALUE_FORMAT: 'codes' })
    expect(() => t.act(() => t.gas.deleteRole_(top('m-top', 'top'), 'base', 'r_leader'))).toThrow(/削除できません/)
    expect(() => t.act(() => t.gas.deleteRole_(top('m-top', 'top'), 'top', 'r_leader'))).toThrow(/削除できません/)
    expect(() => t.act(() => t.gas.deleteRole_({ ...fullAdmin, role: 'r_manager' }, 'r_leader', 'base'))).toThrow(/最上位の役職を持つメンバーだけ/)
    expect(() => t.act(() => t.gas.deleteRole_(top('m-top', 'top'), 'r_leader', ''))).toThrow(/見つかりません/)
    t.act(() => t.gas.deleteRole_(top('m-top', 'top'), 'r_leader', 'base'))
    // 役職名のまま残っていたメンバー(班長)も移す
    expect(t.roleOfMember('m-lead')).toBe('base')
    expect(t.roleOfMember('m-old')).toBe('base')
    expect(JSON.parse(t.writes.roles).map((r: RoleDef) => r.id)).toEqual(['base', 'r_manager', 'top'])
  })

  it('メンバーのいない役職は、全権管理者も削除できる', () => {
    const t = setup([['m-top', 'top'], ['m-admin', 'r_manager']], settings, { VALUE_FORMAT: 'codes' })
    expect(() => t.act(() => t.gas.deleteRole_({ ...fullAdmin, role: 'r_manager' }, 'r_leader'))).not.toThrow()
  })
})

describe('最上位の役職を持つ有効なメンバーが0人になる操作は拒否する', () => {
  const settings = { roles: JSON.stringify(defaultRoles()) }
  const members: [string, string, string?][] = [['m-top', 'top'], ['m-top2', 'top', 'TRUE'], ['m-1', 'base']]

  it('役職の変更・メンバーの削除・休止', () => {
    const t = setup(members, settings, { VALUE_FORMAT: 'codes' })
    const change = (o: object) => t.act(() => t.gas.assertTopRemains_({ members: { 'm-top': o } }))
    expect(() => change({ role: 'base' })).toThrow(/0人/)
    expect(() => change({ removed: true })).toThrow(/0人/)
    expect(() => change({ inactive: true })).toThrow(/0人/)
    // 別の人を先に最上位にすれば変えられる
    expect(() => t.act(() => t.gas.assertTopRemains_({ members: { 'm-top': { role: 'base' }, 'm-1': { role: 'top' } } }))).not.toThrow()
    // 休止中の最上位は数えない
    expect(() => t.act(() => t.gas.assertTopRemains_({ members: { 'm-top': { role: 'base' }, 'm-top2': {} } }))).toThrow(/0人/)
  })

  it('役職の種類の変更・役職の削除でも確かめる', () => {
    const t = setup([['m-top', 'r_leader'], ['m-1', 'base']], { roles: JSON.stringify(defaultRoles().map((r) => (r.id === 'r_leader' ? { ...r, tier: 'top', restricted: undefined } : r))) }, { VALUE_FORMAT: 'codes' })
    const demote = t.roles().map((r) => (r.id === 'r_leader' ? { ...r, tier: 'admin', restricted: false } : r))
    expect(() => t.act(() => t.gas.updateRoles_(top('m-top', 'r_leader'), demote))).toThrow(/0人/)
    expect(() => t.act(() => t.gas.deleteRole_(top('m-top', 'r_leader'), 'r_leader', 'base'))).toThrow(/0人/)
  })

  it('doPost の役職の変更・メンバーの削除・休止で確かめている', () => {
    for (const action of ['updateRole', 'removeMember', 'updateMemberInactive']) {
      const src = CODE_GS.slice(CODE_GS.indexOf(`case '${action}':`))
      expect(src.slice(0, src.indexOf('break')), action).toMatch(/assertTopRemains_/)
    }
  })
})

describe('setupOhsumi での役職の設定', () => {
  it('コードで書く新しい団体では、既定の roles を作る', () => {
    const t = setup([], {}, { VALUE_FORMAT: 'codes' })
    expect(t.gas.setupRolesSetting_()).toBe('created')
    expect(JSON.parse(t.writes.roles)).toEqual(defaultRoles())
    expect(t.gas.setupRolesSetting_()).toBe('already')
  })

  it('今までの役職の設定がある団体では、それを元に ID を付けて作る(一般 → base、代表 → top)', () => {
    const t = setup([], { role_levels: '会計,代表', restricted_roles: '会計' }, { VALUE_FORMAT: 'codes' })
    t.gas.setupRolesSetting_()
    const roles = JSON.parse(t.writes.roles) as RoleDef[]
    expect(roles.map((r) => [r.name, r.tier])).toEqual([['一般', 'base'], ['会計', 'admin'], ['代表', 'top']])
    expect(roles[0].id).toBe('base')
    expect(roles[2].id).toBe('top')
    expect(roles[1].id).toMatch(/^r_/)
    expect(roles[1].restricted).toBe(true)
  })

  it('日本語で書く団体(移行前)では作らない', () => {
    const t = setup([], {})
    expect(t.gas.setupRolesSetting_()).toBe('legacy')
    expect(t.writes.roles).toBeUndefined()
  })
})

describe('サンプルのデータ', () => {
  it('roles を使う団体では、サンプルの役職(制限付き)を roles の1件として足す', () => {
    const t = setup([], {})
    const data = t.gas.buildSampleData_('2026-10-01', {}) as { settings: { lists: Record<string, unknown>; items: Record<string, RoleDef[]>; maps: Record<string, unknown> } }
    const converted = t.gas.sampleSettingsWithRoles_(data.settings) as typeof data.settings
    expect(converted.lists.role_levels).toBeUndefined()
    expect(converted.maps.role_permissions).toBeUndefined()
    expect(JSON.parse(JSON.stringify(converted.items.roles))).toEqual([
      { id: 'sample-role-restricted', name: 'サンプル班長', tier: 'admin', restricted: true,
        sections: ['dashboard', 'assignments', 'approvals', 'projects', 'dailyReports'], requiredSkills: ['イベント運営', 'コミュニケーション'] },
    ])
    // 既存の roles に足すと、制限付きの管理者として判定される
    const merged = t.gas.mergeSampleSettings_({ roles: JSON.stringify(defaultRoles()) }, converted) as { values: Record<string, string> }
    const roles = t.gas.parseRolesSetting_(merged.values.roles) as RoleDef[]
    expect(t.gas.isFullAdminRoleRef_(roles, 'サンプル班長')).toBe(false)
    expect(t.gas.isAdminRoleRef_(roles, 'サンプル班長')).toBe(true)
  })
})
