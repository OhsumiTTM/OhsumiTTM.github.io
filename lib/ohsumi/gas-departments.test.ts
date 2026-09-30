// gas/Code.gs の部門の編集(updateDepartments・deleteDepartment・moveDepartmentTasks)と、
// リクエストの部門の値・シートに書く値(移行前は部門名、移行後は部門 ID)を確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { defaultDepartments, type DepartmentDef } from './departments'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

class FakeSheet {
  constructor(public rows: unknown[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return { getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')) }
  }
}

const CUSTOM: DepartmentDef[] = [...defaultDepartments(), { id: 'd_fin', name: '会計' }]

function setup(opts: { tasks?: [string, string][]; settings?: Record<string, string>; overrides?: object[]; codes?: boolean } = {}) {
  const sheets: Record<string, FakeSheet> = {
    Tasks: new FakeSheet([['id', 'title', 'department'], ...(opts.tasks ?? []).map(([id, dept]) => [id, id, dept])]),
    Settings: new FakeSheet([['key', 'value'], ...Object.entries(opts.settings ?? {})]),
    Members: new FakeSheet([['id', 'role', 'permission_overrides_json'], ['m1', '一般', JSON.stringify(opts.overrides ?? [])]]),
  }
  const props: Record<string, string> = opts.codes ? { VALUE_FORMAT: 'codes' } : {}
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: (k: string) => props[k] ?? null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null }) },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  const writes: Record<string, string> = {}
  c.updateSetting_ = (key: string, value: string) => {
    writes[key] = value
    const row = sheets.Settings.rows.find((r, i) => i > 0 && r[0] === key)
    if (row) row[1] = value
    else sheets.Settings.rows.push([key, value])
    return { key }
  }
  c.updateTaskFields_ = (id: string, fields: Record<string, string>) => {
    const row = sheets.Tasks.rows.find((r, i) => i > 0 && r[0] === id)!
    row[2] = fields.department
    return { ok: true }
  }
  const gas = ctx as unknown as Record<string, (...args: unknown[]) => unknown>
  const act = <T,>(fn: () => T): T => { gas.resetRequestProps_(); return fn() }
  const deptOf = (id: string) => String(sheets.Tasks.rows.find((r) => r[0] === id)![2])
  return { gas, writes, act, deptOf }
}

describe('部門の一覧の保存(updateDepartments)', () => {
  it('部門を足す・並べ替える。一覧から消す変更は受け付けない', () => {
    const t = setup()
    const next = [{ id: 'd_fin', name: '会計' }, ...defaultDepartments()]
    t.act(() => t.gas.updateDepartments_(next))
    expect(JSON.parse(t.writes.departments)).toEqual(next)
    expect(() => t.act(() => t.gas.updateDepartments_(next.slice(1)))).toThrow(/部門の削除を使って/)
    expect(() => t.act(() => t.gas.updateDepartments_([...next, { id: 'x', name: '未分類' }]))).toThrow(/未分類/)
  })

  it('名前の変更は移行の後だけ', () => {
    const renamed = defaultDepartments().map((d) => (d.id === 'ops' ? { ...d, name: '総務' } : d))
    const legacy = setup()
    expect(() => legacy.act(() => legacy.gas.updateDepartments_(renamed))).toThrow(/移行の後/)
    const t = setup({ codes: true })
    t.act(() => t.gas.updateDepartments_(renamed))
    expect(JSON.parse(t.writes.departments)[0].name).toBe('総務')
  })
})

describe('部門の削除(deleteDepartment)', () => {
  const settings = { departments: JSON.stringify(CUSTOM) }

  it('どこでも使われていなければ、一覧から消す', () => {
    const t = setup({ settings })
    const res = t.act(() => t.gas.deleteDepartment_('d_fin')) as { archived: boolean }
    expect(res.archived).toBe(false)
    expect(JSON.parse(t.writes.departments).map((d: DepartmentDef) => d.id)).not.toContain('d_fin')
  })

  it('タスク(部門名・部門 ID のどちらでも)・設定・権限の例外で使われていれば、アーカイブにする', () => {
    for (const opts of [
      { tasks: [['t1', '会計']] as [string, string][] },
      { tasks: [['t1', 'd_fin']] as [string, string][] },
      { settings: { ...settings, recurring_rules: JSON.stringify([{ id: 'r', department: '会計' }]) } },
      { overrides: [{ targetType: 'department', targetId: 'd_fin', access: 'edit' }] },
    ]) {
      const t = setup({ settings, ...opts })
      const res = t.act(() => t.gas.deleteDepartment_('d_fin')) as { archived: boolean }
      expect(res.archived, JSON.stringify(opts)).toBe(true)
      expect(JSON.parse(t.writes.departments).find((d: DepartmentDef) => d.id === 'd_fin')).toEqual({ id: 'd_fin', name: '会計', archived: true })
    }
  })

  it('アーカイブした部門のタスクは、そのまま部門を引ける(表示・絞り込みに使える)', () => {
    const list = [...defaultDepartments(), { id: 'd_fin', name: '会計', archived: true }]
    expect(setup().gas.normalizeDepartment_(list, '会計')).toBe('d_fin')
  })
})

describe('タスクを別の部門へ移す(moveDepartmentTasks)', () => {
  const settings = { departments: JSON.stringify(CUSTOM) }
  const tasks: [string, string][] = [['t1', '会計'], ['t2', 'd_fin'], ['t3', '運営']]

  it('移行前は部門名で、移行後は部門 ID で書く。ほかの部門のタスクは変えない', () => {
    const legacy = setup({ settings, tasks })
    expect(legacy.act(() => legacy.gas.moveDepartmentTasks_('d_fin', 'pr'))).toEqual({ moved: 2 })
    expect([legacy.deptOf('t1'), legacy.deptOf('t2'), legacy.deptOf('t3')]).toEqual(['広報', '広報', '運営'])
    const coded = setup({ settings, tasks, codes: true })
    coded.act(() => coded.gas.moveDepartmentTasks_('会計', ''))
    expect([coded.deptOf('t1'), coded.deptOf('t2')]).toEqual(['', ''])
    const legacyNone = setup({ settings, tasks })
    legacyNone.act(() => legacyNone.gas.moveDepartmentTasks_('d_fin', ''))
    expect(legacyNone.deptOf('t1')).toBe('未分類')
  })

  it('知らない部門へは移さない', () => {
    const t = setup({ settings, tasks })
    expect(() => t.act(() => t.gas.moveDepartmentTasks_('d_fin', 'x_none'))).toThrow(/見つかりません/)
  })
})

describe('リクエストの部門の値', () => {
  const settings = { departments: JSON.stringify(CUSTOM) }

  it('足した部門の名前(古いタブ)も ID もそろえ、今のシートの形式で書く', () => {
    for (const codes of [false, true]) {
      const t = setup({ settings, codes })
      for (const value of ['会計', 'd_fin']) {
        const body = { action: 'updateTaskDetails', department: value }
        t.act(() => t.gas.normalizeRequestCodes_(body))
        expect(body.department).toBe('d_fin')
        expect(t.gas.sheetValue_('department', body.department)).toBe(codes ? 'd_fin' : '会計')
      }
    }
  })

  it('部門を対象にした権限の例外は、足した部門でも名前・ID のどちらでも一致する', () => {
    const t = setup({ settings })
    t.gas.resetRequestProps_()
    expect(t.gas.overridesGrant_([{ targetType: 'department', targetId: '会計', access: 'edit' }], { department: 'd_fin' }, 1)).toBe(true)
    expect(t.gas.overridesGrant_([{ targetType: 'department', targetId: 'd_fin', access: 'edit' }], { department: '会計' }, 1)).toBe(true)
  })

  it('updateSetting で departments を直接書くことはできない(部門の編集から変える)', () => {
    const src = CODE_GS.slice(CODE_GS.indexOf("case 'updateSetting':"), CODE_GS.indexOf("case 'uploadOrgLogo':"))
    expect(src).toMatch(/body\.key === 'departments'\) throw userError_/)
  })
})
