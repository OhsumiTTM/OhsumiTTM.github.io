// 部門の一覧。
//
// Settings の departments(JSON)に [{ id, name, archived? }] の形で持つ。未設定なら既定の7部門
// (ID は codes.ts と同じ ops・pr・dev・design・relations・event・research、名前は今の日本語)。
// 未分類は部門ではなく空で表す。
//
// タスクなどの部門の値は、内部コードへの移行(VALUE_FORMAT=codes)の前は部門名、後は部門 ID。
// 部門は ID でも名前でも引ける(findDepartment)ので、移行の途中でも同じ部門として扱う。
// 移行前は部門名で引くため、部門の名前の変更は移行の後にできる。
//
// 使われている部門を削除すると「アーカイブ」になる(新しいタスクでは選べないが、既存のタスクでは
// そのまま表示され、絞り込みにも使える)。どこでも使われていなければ一覧から消す。
//
// gas/Code.gs にも同じ関数がある(一致することを lib/ohsumi/departments.test.ts で確かめる)。
import { VALUE_CODES } from './codes'

export interface DepartmentDef {
  id: string
  name: string
  archived?: boolean
}

export const UNCATEGORIZED_NAME = '未分類'

const DEFAULT_LABELS: Record<string, string> = VALUE_CODES.department.sheetLabels

// 既定の部門(未分類を除く)
export function defaultDepartments(): DepartmentDef[] {
  return VALUE_CODES.department.codes.filter((c) => c !== '').map((id) => ({ id, name: DEFAULT_LABELS[id] }))
}

export function validateDepartments(list: DepartmentDef[]): string[] {
  const errors: string[] = []
  const ids: Record<string, boolean> = {}
  const names: Record<string, boolean> = {}
  for (const d of list) {
    if (!d.id || !d.name) errors.push('領域の ID と名前は空にできません')
    if (d.name === UNCATEGORIZED_NAME) errors.push('「未分類」は領域の名前に使えません')
    if (ids[d.id]) errors.push('領域の ID が重複しています: ' + d.id)
    if (names[d.name]) errors.push('領域の名前が重複しています: ' + d.name)
    ids[d.id] = true
    names[d.name] = true
  }
  return errors
}

// Settings の departments を読む。形式が正しくなければ null(既定の部門を使う)
export function parseDepartmentsSetting(value: string | undefined): DepartmentDef[] | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const list: DepartmentDef[] = []
  for (const d of parsed) {
    if (!d || typeof d !== 'object') return null
    const o = d as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.name !== 'string') return null
    const dept: DepartmentDef = { id: o.id, name: o.name }
    if (o.archived === true) dept.archived = true
    list.push(dept)
  }
  return validateDepartments(list).length === 0 ? list : null
}

export function departmentsFromSettings(settings: Record<string, string | undefined>): DepartmentDef[] {
  return parseDepartmentsSetting(settings.departments) ?? defaultDepartments()
}

// ID でも名前でも引く。見つからなければ、既定の部門の以前の名前(運営など)でも引く
export function findDepartment(list: DepartmentDef[], ref: string | null | undefined): DepartmentDef | undefined {
  const v = String(ref ?? '').trim()
  if (!v || v === UNCATEGORIZED_NAME) return undefined
  const found = list.find((d) => d.id === v) ?? list.find((d) => d.name === v)
  if (found) return found
  for (const id of Object.keys(DEFAULT_LABELS)) {
    if (id && DEFAULT_LABELS[id] === v) return list.find((d) => d.id === id)
  }
  return undefined
}

// どの形式の値でも部門 ID にそろえる。未分類(空・「未分類」)は空。一覧に無い値はそのまま残す
export function normalizeDepartment(list: DepartmentDef[], ref: string | null | undefined): string {
  const v = String(ref ?? '').trim()
  if (!v || v === UNCATEGORIZED_NAME) return ''
  return findDepartment(list, v)?.id ?? v
}

// シートに書く値(移行前は部門名、移行後は部門 ID。未分類は移行前「未分類」、移行後は空)
export function sheetDepartmentRef(list: DepartmentDef[], ref: string | null | undefined, codes: boolean): string {
  const id = normalizeDepartment(list, ref)
  if (!id) return codes ? '' : UNCATEGORIZED_NAME
  const dept = findDepartment(list, id)
  if (!dept) return id
  return codes ? dept.id : dept.name
}

// 団体での部門名(部署ツリーとの照合・Excel の書き出し・カレンダーの説明文など、翻訳しない所で使う)
export function departmentNameOf(list: DepartmentDef[], ref: string | null | undefined): string {
  const id = normalizeDepartment(list, ref)
  if (!id) return UNCATEGORIZED_NAME
  return findDepartment(list, id)?.name ?? id
}

// 既定の部門で、名前が既定のままか(画面では翻訳して表示する)
export function hasDefaultName(dept: DepartmentDef): boolean {
  return Object.prototype.hasOwnProperty.call(DEFAULT_LABELS, dept.id) && DEFAULT_LABELS[dept.id] === dept.name
}

// 新しい部門の ID
export function newDepartmentId(): string {
  return 'd_' + Math.random().toString(36).slice(2, 8)
}
