// 部門の一覧(lib/ohsumi/departments.ts)と GAS(gas/Code.gs)の同じ関数が一致すること、
// 部門名・部門 ID のどちらの値でも同じ部門になること、表示名の決まり、画面のデータが
// 移行の前後で変わらないことを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as D from './departments'
import { departmentLabel } from './i18n'
import { ja } from './i18n/ja'
import { en } from './i18n/en'
import { mapRemoteData, parseSettings } from './remote'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
vm.runInContext(CODE_GS, ctx)
const gas = ctx as unknown as Record<string, (...args: unknown[]) => unknown>
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

// 団体が部門を足し・名前を変え・アーカイブした一覧
const CUSTOM: D.DepartmentDef[] = [
  { id: 'ops', name: '総務' }, // 名前を変えた既定の部門
  { id: 'pr', name: '広報' },
  { id: 'd_fin', name: '会計' }, // 足した部門
  { id: 'research', name: 'リサーチ', archived: true },
]

describe('GAS と同じ結果になる', () => {
  it('既定の部門・設定の読み込み・決まりごと', () => {
    expect(plain(gas.defaultDepartments())).toEqual(D.defaultDepartments())
    for (const raw of [JSON.stringify(CUSTOM), '[{"id":"a","name":"未分類"}]', '[{"id":"a","name":"x"},{"id":"a","name":"y"}]', '{', '']) {
      expect(plain(gas.parseDepartmentsSetting(raw)), raw).toEqual(D.parseDepartmentsSetting(raw))
      expect(plain(gas.departmentsFromSettings({ departments: raw })), raw).toEqual(D.departmentsFromSettings({ departments: raw }))
    }
  })

  it('部門の値のそろえ方・シートに書く値・部門名', () => {
    const refs = ['ops', '運営', '総務', 'd_fin', '会計', 'research', 'リサーチ', '', '未分類', ' 広報 ', '昔の部門', undefined, null]
    for (const list of [D.defaultDepartments(), CUSTOM]) {
      for (const ref of refs) {
        const label = `${String(ref)} in ${list[0].name}`
        expect(gas.normalizeDepartment(list, ref), label).toBe(D.normalizeDepartment(list, ref))
        expect(gas.departmentNameOf(list, ref), label).toBe(D.departmentNameOf(list, ref))
        for (const codes of [true, false]) {
          expect(gas.sheetDepartmentRef(list, ref, codes), `${label} codes=${codes}`).toBe(D.sheetDepartmentRef(list, ref, codes))
        }
      }
    }
  })
})

describe('部門の値', () => {
  it('部門名・部門 ID・既定の部門の以前の名前のどれでも、同じ部門 ID になる', () => {
    expect(D.normalizeDepartment(CUSTOM, '総務')).toBe('ops')
    expect(D.normalizeDepartment(CUSTOM, '運営')).toBe('ops') // 名前を変える前の値
    expect(D.normalizeDepartment(CUSTOM, '会計')).toBe('d_fin')
    expect(D.normalizeDepartment(CUSTOM, 'リサーチ')).toBe('research') // アーカイブした部門も引ける
    expect(D.normalizeDepartment(CUSTOM, '未分類')).toBe('')
    expect(D.normalizeDepartment(CUSTOM, '昔の部門')).toBe('昔の部門') // 一覧に無い値は残す
  })

  it('シートに書く値は、移行前は部門名(未分類は「未分類」)、移行後は部門 ID(未分類は空)', () => {
    expect(D.sheetDepartmentRef(CUSTOM, 'd_fin', false)).toBe('会計')
    expect(D.sheetDepartmentRef(CUSTOM, '会計', true)).toBe('d_fin')
    expect(D.sheetDepartmentRef(CUSTOM, '', false)).toBe('未分類')
    expect(D.sheetDepartmentRef(CUSTOM, '未分類', true)).toBe('')
  })
})

describe('表示名(departmentLabel)', () => {
  const tJa = (k: keyof typeof ja) => ja[k]
  const tEn = (k: keyof typeof en) => en[k]

  it('既定の部門の名前が既定のままなら翻訳し、変えた名前・足した部門はそのまま', () => {
    expect(departmentLabel(tEn, CUSTOM, 'pr')).toBe(en['department.pr'])
    expect(departmentLabel(tEn, CUSTOM, 'research')).toBe(en['department.research'])
    expect(departmentLabel(tEn, CUSTOM, 'ops')).toBe('総務')
    expect(departmentLabel(tEn, CUSTOM, 'd_fin')).toBe('会計')
    expect(departmentLabel(tJa, CUSTOM, '')).toBe('未分類')
    expect(departmentLabel(tEn, CUSTOM, '')).toBe(en['department.none'])
    expect(departmentLabel(tEn, CUSTOM, '昔の部門')).toBe('昔の部門')
  })
})

describe('移行の前後で画面のデータが変わらない(足した部門を含む)', () => {
  const settingsRow = { key: 'departments', value: JSON.stringify(CUSTOM) }

  it('タスク・テンプレート・権限の例外の部門', () => {
    const settings = parseSettings([
      settingsRow,
      { key: 'recurring_rules', value: JSON.stringify([{ id: 'r', name: 'x', projectId: 'p', department: '会計', category: '', skills: [], difficulty: '', priority: '', frequency: 'weekly', active: true }]) },
    ])
    expect(settings.departments).toEqual(CUSTOM)
    expect(settings.recurringRules[0].department).toBe('d_fin')
    const rows = (dept: string, target: string) => mapRemoteData(
      [{ id: 'm1', name: 'A', role: '一般', permission_overrides_json: JSON.stringify([{ targetType: 'department', targetId: target, access: 'edit' }]) }],
      [{ id: 'p', name: 'P' }],
      [{ id: 't', title: 'T', project_id: 'p', department: dept, status: '進行中' }],
      undefined,
      settings.departments,
    )
    const before = rows('会計', '総務')
    const after = rows('d_fin', 'ops')
    expect(after).toEqual(before)
    expect(before.tasks[0].department).toBe('d_fin')
    expect(before.members[0].permissionOverrides?.[0].targetId).toBe('ops')
  })
})
