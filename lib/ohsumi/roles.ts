// 役職の一覧と判定。
//
// 役職は Settings の roles(JSON)に、上下関係の順(一般 → … → 最上位)で持つ。
//   { id, name, tier: 'top' | 'admin' | 'base', restricted?, sections?, requiredSkills?, capabilities? }
// - tier: top = 最上位(代表専用の操作ができる)、admin = 管理者、base = 一般(1つだけ)
// - restricted: 制限付きの管理者(sections の管理画面だけ見える)。false なら全権管理者
//
// 内部コードへの移行(VALUE_FORMAT=codes)の前は roles が無く、今までの設定
// (role_levels・restricted_roles・role_permissions・job_requirements)から組み立てる。
// その場合の役職 ID は役職名そのもの(メンバーの role 列も役職名のまま)。
// 役職は ID でも名前でも引ける(findRole)ので、移行の途中でも判定は変わらない。
//
// gas/Code.gs にも同じ関数がある(一致することを lib/ohsumi/roles.test.ts で確かめる)。
import { DEFAULT_NON_TOP_SECTIONS, type AdminSection } from './types'
import { CAPABILITY_KEYS, FULL_ADMIN_DEFAULT_CAPABILITIES, normalizeCapabilities, type Capability } from './capabilities'
import type { PermissionOverride } from './types'

export type RoleTier = 'top' | 'admin' | 'base'

export interface RoleDef {
  id: string
  name: string
  tier: RoleTier
  // 制限付きの管理者(tier が admin の時だけ意味がある)
  restricted?: boolean
  // 制限付きの管理者が見られる管理画面のセクション。未設定なら既定
  sections?: AdminSection[]
  // この役職に求めるスキル(人材DB の「職務要件」)
  requiredSkills?: string[]
  // できる操作(capabilities.ts。管理者の役職だけ)。未設定なら既定(制限なし: org.rules・trash、制限あり: なし)
  capabilities?: Capability[]
}

export const TOP_ROLE_ID = 'top'
export const BASE_ROLE_ID = 'base'
// 最上位・一般の既定の名前。名前がこのままなら画面では翻訳して表示する
export const DEFAULT_TOP_ROLE_NAME = '代表'
export const DEFAULT_BASE_ROLE_NAME = '一般'
// role_levels が未設定の団体の既定(一般より上、低い順)
export const DEFAULT_ROLE_LEVELS = ['班長', '事業責任者', '代表']
// Settings のうち役職の設定
export const ROLE_SETTING_KEYS = ['roles', 'role_levels', 'restricted_roles', 'role_permissions', 'job_requirements'] as const

// 新しく導入する団体の最初の roles(setupOhsumi が Settings に書く)
export function defaultRoles(): RoleDef[] {
  return [
    { id: BASE_ROLE_ID, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: 'r_manager', name: '事業責任者', tier: 'admin', restricted: false },
    { id: TOP_ROLE_ID, name: DEFAULT_TOP_ROLE_NAME, tier: 'top' },
  ]
}

function splitList(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseObject(value: string | undefined): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined
}

// 今までの設定(移行前)から役職の一覧を組み立てる。ID は役職名
export function rolesFromLegacy(settings: Record<string, string | undefined>): RoleDef[] {
  const levels = splitList(settings.role_levels)
  const names = (levels.length ? levels : DEFAULT_ROLE_LEVELS).filter((n) => n !== DEFAULT_BASE_ROLE_NAME)
  if (!names.includes(DEFAULT_TOP_ROLE_NAME)) names.push(DEFAULT_TOP_ROLE_NAME)
  const restricted = splitList(settings.restricted_roles)
  // restricted_roles にだけある役職も、今までどおり制限付きの管理者として扱う
  for (const n of restricted) {
    if (!names.includes(n) && n !== DEFAULT_BASE_ROLE_NAME && n !== DEFAULT_TOP_ROLE_NAME) names.splice(names.indexOf(DEFAULT_TOP_ROLE_NAME), 0, n)
  }
  const permissions = parseObject(settings.role_permissions)
  const requirements = parseObject(settings.job_requirements)
  const roles: RoleDef[] = [{ id: DEFAULT_BASE_ROLE_NAME, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' }]
  const baseSkills = stringArray(requirements[DEFAULT_BASE_ROLE_NAME])
  if (baseSkills) roles[0].requiredSkills = baseSkills
  const seen: Record<string, boolean> = {}
  for (const name of names) {
    if (seen[name]) continue
    seen[name] = true
    const role: RoleDef = { id: name, name, tier: name === DEFAULT_TOP_ROLE_NAME ? 'top' : 'admin' }
    if (role.tier === 'admin') role.restricted = restricted.includes(name)
    const sections = stringArray(permissions[name])
    if (sections) role.sections = sections as AdminSection[]
    const skills = stringArray(requirements[name])
    if (skills) role.requiredSkills = skills
    roles.push(role)
  }
  return roles
}

// Settings の roles を読む。形式が正しくなければ null(今までの設定から組み立てる)
export function parseRolesSetting(value: string | undefined): RoleDef[] | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const roles: RoleDef[] = []
  for (const r of parsed) {
    if (!r || typeof r !== 'object') return null
    const o = r as Record<string, unknown>
    const tier = o.tier
    if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name) return null
    if (tier !== 'top' && tier !== 'admin' && tier !== 'base') return null
    const role: RoleDef = { id: o.id, name: o.name, tier }
    if (tier === 'admin') role.restricted = o.restricted === true
    const sections = stringArray(o.sections)
    if (sections) role.sections = sections as AdminSection[]
    const skills = stringArray(o.requiredSkills)
    if (skills) role.requiredSkills = skills
    const caps = stringArray(o.capabilities)
    if (caps && tier === 'admin') role.capabilities = normalizeCapabilities(caps)
    roles.push(role)
  }
  return validateRoles(roles).length === 0 ? roles : null
}

// Settings(key → value)から役職の一覧を作る。roles があればそれを、無ければ今までの設定から
export function rolesFromSettings(settings: Record<string, string | undefined>): RoleDef[] {
  return parseRolesSetting(settings.roles) ?? rolesFromLegacy(settings)
}

// 役職の一覧の決まりごと。問題があれば、その説明の一覧を返す
export function validateRoles(roles: RoleDef[]): string[] {
  const errors: string[] = []
  const ids: Record<string, boolean> = {}
  const names: Record<string, boolean> = {}
  for (const r of roles) {
    if (ids[r.id]) errors.push('役職のIDが重複しています: ' + r.id)
    if (names[r.name]) errors.push('役職の名前が重複しています: ' + r.name)
    ids[r.id] = true
    names[r.name] = true
  }
  if (roles.filter((r) => r.tier === 'base').length !== 1) errors.push('一般の役職はちょうど1つ必要です')
  if (roles.filter((r) => r.tier === 'top').length < 1) errors.push('最上位の役職が1つ以上必要です')
  return errors
}

// ID でも名前でも引く(移行の途中で両方が混ざっていても同じ役職になる)
export function findRole(roles: RoleDef[], ref: string | null | undefined): RoleDef | undefined {
  const v = String(ref ?? '').trim()
  if (!v) return undefined
  return roles.find((r) => r.id === v) ?? roles.find((r) => r.name === v)
}

// 役職の種類。空は一般。一覧に無い役職は、今までと同じく(制限の無い)管理者として扱う
export function roleTier(roles: RoleDef[], ref: string | null | undefined): RoleTier {
  const v = String(ref ?? '').trim()
  if (!v) return 'base'
  return findRole(roles, v)?.tier ?? 'admin'
}

export function isTopRoleRef(roles: RoleDef[], ref: string | null | undefined): boolean {
  return roleTier(roles, ref) === 'top'
}

export function isAdminRoleRef(roles: RoleDef[], ref: string | null | undefined): boolean {
  return roleTier(roles, ref) !== 'base'
}

// 全権管理者: 最上位、または制限の無い管理者
export function isFullAdminRoleRef(roles: RoleDef[], ref: string | null | undefined): boolean {
  const tier = roleTier(roles, ref)
  if (tier === 'top') return true
  if (tier === 'base') return false
  return !findRole(roles, ref)?.restricted
}

// 同じ役職か(承認ステップの役職と本人の役職の比較など)。ID・名前のどちらで書かれていてもよい
export function sameRole(roles: RoleDef[], a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? '').trim()
  const y = String(b ?? '').trim()
  if (!x || !y) return false
  if (x === y) return true
  const rx = findRole(roles, x)
  const ry = findRole(roles, y)
  return !!rx && !!ry && rx.id === ry.id
}

// 制限付きの管理者が見られる管理画面のセクション(全権管理者・一般には使わない)
export function restrictedSections(roles: RoleDef[], ref: string | null | undefined): AdminSection[] {
  return findRole(roles, ref)?.sections ?? DEFAULT_NON_TOP_SECTIONS
}

// 移行前の保存先(今までの設定)に書く値
export function rolesToLegacySettings(roles: RoleDef[]): Record<string, string> {
  const nonBase = roles.filter((r) => r.tier !== 'base')
  const permissions: Record<string, AdminSection[]> = {}
  const requirements: Record<string, string[]> = {}
  for (const r of roles) {
    if (r.sections) permissions[r.name] = r.sections
    if (r.requiredSkills) requirements[r.name] = r.requiredSkills
  }
  return {
    role_levels: nonBase.map((r) => r.name).join(','),
    restricted_roles: nonBase.filter((r) => r.tier === 'admin' && r.restricted).map((r) => r.name).join(','),
    role_permissions: JSON.stringify(permissions),
    job_requirements: JSON.stringify(requirements),
  }
}

// 新しい役職の ID(移行後)
export function newRoleId(): string {
  return 'r_' + Math.random().toString(36).slice(2, 8)
}

// 移行前(roles が無い間)は、メンバーの role 列にある役職名が役職の一覧に無いことがある
// (今までの画面では、それも役職の選択肢に出していた)。制限の無い管理者として一覧に足す
// (GAS の roleTier と同じ扱い)
export function withMemberRoles(roles: RoleDef[], memberRoles: string[]): RoleDef[] {
  const extra: RoleDef[] = []
  for (const ref of memberRoles) {
    const v = String(ref ?? '').trim()
    if (!v || findRole(roles, v) || extra.some((r) => r.id === v)) continue
    extra.push({ id: v, name: v, tier: 'admin', restricted: false })
  }
  return extra.length ? [...roles, ...extra] : roles
}

// ---- できる操作(capabilities.ts)。gas/src/38-capabilities.gs と同じ ----------------------

// 役職のできる操作(人ごとの例外は含まない)。最上位はすべて、一般はなし。
// 管理者で書いていなければ既定(制限なし: org.rules・trash、制限あり: なし)。一覧に無い役職は制限なしの管理者
export function roleCapabilities(roles: RoleDef[], ref: string | null | undefined): Capability[] {
  const tier = roleTier(roles, ref)
  if (tier === 'top') return [...CAPABILITY_KEYS]
  if (tier === 'base') return []
  const role = findRole(roles, ref)
  if (role && Array.isArray(role.capabilities)) return normalizeCapabilities(role.capabilities)
  return role?.restricted ? [] : normalizeCapabilities(FULL_ADMIN_DEFAULT_CAPABILITIES)
}

// 役職に書いたできる操作が既定と同じか(同じなら書かずに既定のままにする)
export function defaultRoleCapabilities(role: Pick<RoleDef, 'tier' | 'restricted'>): Capability[] {
  return roleCapabilities([{ id: '_', name: '_', tier: role.tier, restricted: role.restricted }], '_')
}

// ログインした人のできる操作。役職の分と、人ごとの採用の例外(編集以上)の分
export function memberCapabilities(
  roles: RoleDef[],
  roleRef: string | null | undefined,
  overrides: readonly PermissionOverride[] | undefined,
): Capability[] {
  const caps = roleCapabilities(roles, roleRef)
  const recruiting = (overrides ?? []).some((o) => o?.targetType === 'recruiting' && (o.access === 'edit' || o.access === 'approve'))
  return recruiting && !caps.includes('recruiting') ? normalizeCapabilities([...caps, 'recruiting']) : caps
}

export type RoleAssignBlock = 'self' | 'targetTop' | 'targetStronger' | 'unknownRole' | 'topRole' | 'strongerRole'

// 最上位でない人が役職を付ける時の決まり(GAS の assertRoleAssignable_ と同じ)。付けられなければその理由。
// targetRole は役職を変える相手の今の役職(登録の時は undefined)
export function roleAssignBlock(
  roles: RoleDef[],
  acting: { id: string; role: string | null | undefined },
  roleRef: string | null | undefined,
  target?: { id: string; role: string | null | undefined },
): RoleAssignBlock | null {
  if (isTopRoleRef(roles, acting.role)) return null
  const actorCaps = roleCapabilities(roles, acting.role)
  const actorFull = isFullAdminRoleRef(roles, acting.role)
  const containsAll = (need: Capability[]) => need.every((c) => actorCaps.includes(c))
  if (target) {
    if (target.id === acting.id) return 'self'
    if (isTopRoleRef(roles, target.role)) return 'targetTop'
    if (!containsAll(roleCapabilities(roles, target.role)) || (!actorFull && isFullAdminRoleRef(roles, target.role))) return 'targetStronger'
  }
  const ref = String(roleRef ?? '').trim()
  if (!ref) return null
  const role = findRole(roles, ref)
  if (!role) return 'unknownRole'
  if (role.tier === 'top') return 'topRole'
  if (!containsAll(roleCapabilities(roles, role.id)) || (!actorFull && isFullAdminRoleRef(roles, role.id))) return 'strongerRole'
  return null
}
