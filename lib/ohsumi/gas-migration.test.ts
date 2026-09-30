// gas/Code.gs の移行の関数(migrateToInternalCodes)を、メモリ上のスプレッドシートで確かめる。
// dryRun は何も書き込まないこと、apply の結果、2回目は何も変わらないこと、列や設定が無くても
// 動くこと、当てはまらない値(削除済みの役職名など)を残して報告すること、MIGRATION_TOP_ROLE_NAME、
// バックアップのコピーを共有しないこと、移行の後も画面のデータが変わらないことを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { mapRemoteData, parseSettings } from './remote'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

class FakeRange {
  constructor(private sheet: FakeSheet, private row: number, private col: number, private numRows: number, private numCols: number) {}
  getValues() {
    return Array.from({ length: this.numRows }, (_, r) => Array.from({ length: this.numCols }, (_, c) => this.sheet.rows[this.row - 1 + r]?.[this.col - 1 + c] ?? ''))
  }
  setValues(values: unknown[][]) {
    values.forEach((vals, r) => vals.forEach((v, c) => { this.sheet.rows[this.row - 1 + r][this.col - 1 + c] = v }))
  }
  setNumberFormat() { return this }
}
class FakeSheet {
  writes = 0
  constructor(public rows: unknown[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    const range = new FakeRange(this, row, col, numRows, numCols)
    const setValues = range.setValues.bind(range)
    range.setValues = (v: unknown[][]) => { this.writes++; setValues(v) }
    return range
  }
}

const T = (o: Record<string, string>) => o
function sheetOf(headers: string[], rows: Record<string, string>[]) {
  return new FakeSheet([headers, ...rows.map((o) => headers.map((h) => o[h] ?? ''))])
}

function setup(opts: { props?: Record<string, string>; noExpenses?: boolean; settings?: Record<string, string>; members?: Record<string, string>[] } = {}) {
  const props: Record<string, string> = { ...(opts.props ?? {}) }
  const sheets: Record<string, FakeSheet> = {
    Tasks: sheetOf(['id', 'title', 'status', 'difficulty', 'priority', 'importance', 'visibility', 'approval_status', 'department', 'history_json', 'schedule_json'], [
      T({ id: 't1', title: 'A', status: '確認待ち', difficulty: '少し経験必要', priority: '高', importance: '対外公開', visibility: '幹部', approval_status: '承認待ち', department: 'デザイン',
        history_json: JSON.stringify([{ id: 'h1', field: 'status', from: '未着手', to: '進行中' }, { id: 'h2', field: 'department', from: '未分類', to: '会計' }]),
        schedule_json: JSON.stringify({ candidates: [], responses: { m1: { c1: '○', c2: '△' } } }) }),
      T({ id: 't2', title: 'B', status: '完了', difficulty: '', priority: '', importance: '', visibility: '全員', approval_status: '', department: '未分類' }),
      T({ id: 't3', title: 'C', status: '謎のステータス', department: '会計' }), // 当てはまらない値 / 足した部門
    ]),
    Members: sheetOf(['id', 'name', 'role', 'inactive', 'permission_overrides_json'], opts.members ?? [
      T({ id: 'm1', name: '代表さん', role: '代表' }),
      T({ id: 'm2', name: '班長さん', role: '班長', permission_overrides_json: JSON.stringify([{ targetType: 'department', targetId: '広報', access: 'edit' }]) }),
      T({ id: 'm3', name: '会計さん', role: '会計係' }), // 役職の一覧に無い役職
      T({ id: 'm4', name: '一般さん', role: '一般' }),
    ]),
    Settings: new FakeSheet([['key', 'value'], ...Object.entries(opts.settings ?? {
      role_levels: '班長,事業責任者,代表',
      restricted_roles: '班長',
      role_permissions: JSON.stringify({ 班長: ['projects'] }),
      departments: JSON.stringify([{ id: 'ops', name: '運営' }, { id: 'pr', name: '広報' }, { id: 'design', name: 'デザイン' }, { id: 'd_fin', name: '会計' }]),
      recurring_rules: JSON.stringify([{ id: 'r1', department: '運営', difficulty: '誰でも可', priority: '中', triggerOnStatus: '完了' }]),
      skill_level_thresholds: JSON.stringify({ デフォルト: 120 }),
      custom_form_defs: JSON.stringify([{ id: 'f1', approvalSteps: [{ id: 's1', type: 'role', role: '班長' }, { id: 's2', type: 'role', role: '削除済みの役職' }] }]),
      expense_categories: JSON.stringify([{ id: 'c1', approvalSteps: [{ id: 's1', type: 'role', role: '事業責任者' }] }]),
    })]),
  }
  if (!opts.noExpenses) {
    sheets.Expenses = sheetOf(['id', 'status', 'approval_steps_json'], [
      T({ id: 'e1', status: 'approved', approval_steps_json: JSON.stringify([{ id: 's1', type: 'role', role: '班長' }, { id: 's2', type: 'member', memberId: 'm1' }]) }),
      T({ id: 'e2', status: 'pending', approval_steps_json: JSON.stringify([{ id: 's1', type: 'role', role: '昔の役職' }]) }),
    ])
  }
  const logs: string[] = []
  const copies: { name: string; removedEditors: string[]; removedViewers: string[]; sharing: unknown[] }[] = []
  const ctx = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null, getId: () => 'ss1', getName: () => '団体のデータ' }),
      flush() {},
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026-10-01 10:00' },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      Permission: { NONE: 'NONE' },
      getRootFolder: () => ({ id: 'root' }),
      getFileById: () => ({
        makeCopy: (name: string) => {
          const copy = { name, removedEditors: [] as string[], removedViewers: [] as string[], sharing: [] as unknown[] }
          copies.push(copy)
          return {
            getName: () => name, getUrl: () => 'https://drive.example/copy',
            getEditors: () => ['editor@example.com'], getViewers: () => ['viewer@example.com'],
            removeEditor: (u: string) => copy.removedEditors.push(u), removeViewer: (u: string) => copy.removedViewers.push(u),
            setSharing: (...a: unknown[]) => copy.sharing.push(a),
          }
        },
      }),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.updateSetting_ = (key: string, value: string) => {
    const row = sheets.Settings.rows.find((r, i) => i > 0 && r[0] === key)
    if (row) row[1] = value
    else sheets.Settings.rows.push([key, value])
    return { key }
  }
  c.bumpDataVersion = () => {}
  const gas = ctx as unknown as Record<string, (...args: unknown[]) => unknown>
  const snapshot = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, s]) => [k, s.rows]))))
  const setting = (key: string) => String(sheets.Settings.rows.find((r) => r[0] === key)?.[1] ?? '')
  const cell = (sheet: string, id: string, col: string) => {
    const rows = sheets[sheet].rows
    return String(rows.find((r) => r[0] === id)![rows[0].indexOf(col)])
  }
  return { gas, props, sheets, logs, copies, snapshot, setting, cell }
}

type Report = {
  counts: Record<string, number>; unknown: Record<string, Record<string, number>>; errors: string[]; createdRoles: string[]
  rolePlacements: { name: string; reason: string; below: string; above: string }[]
  roles: { id: string; name: string; tier: string; restricted: boolean }[]
}

describe('dryRun(既定)', () => {
  it('何も書き込まず、変換される件数・当てはまらない値・作られる役職を報告する', () => {
    const t = setup()
    const before = t.snapshot()
    const report = t.gas.migrateToInternalCodes() as Report
    expect(t.snapshot()).toEqual(before)
    expect(t.props.VALUE_FORMAT).toBeUndefined()
    expect(t.copies).toHaveLength(0)
    expect(report.counts['Tasks.status']).toBe(2)
    expect(report.counts['Members.role']).toBe(4)
    expect(report.unknown['Tasks.status']).toEqual({ 謎のステータス: 1 })
    expect(report.createdRoles).toEqual(['会計係'])
    expect(report.errors).toEqual([])
    expect(t.logs.join('\n')).toMatch(/dryRun のため、何も書き込んでいません/)
  })

  it('承認ステップの役職名のうち、役職の一覧に無いもの(削除済みの役職など)を当てはまらない値として報告する', () => {
    const report = setup().gas.migrateToInternalCodes() as Report
    expect(report.unknown['Settings.custom_form_defs(承認ステップの役職)']).toEqual({ 削除済みの役職: 1 })
    expect(report.unknown['Expenses.approval_steps_json(承認ステップの役職)']).toEqual({ 昔の役職: 1 })
  })
})

describe('apply', () => {
  const applied = () => {
    const t = setup({ props: { MIGRATION_MODE: 'apply' } })
    t.gas.migrateToInternalCodes()
    return t
  }

  it('タスクの選択肢の値・部門・変更の記録・日程調整をコードにする(当てはまらない値は残す)', () => {
    const t = applied()
    expect(['status', 'difficulty', 'priority', 'importance', 'visibility', 'approval_status', 'department'].map((c) => t.cell('Tasks', 't1', c)))
      .toEqual(['review', 'some_exp', 'high', 'external', 'leaders', 'pending', 'design'])
    expect(JSON.parse(t.cell('Tasks', 't1', 'history_json'))).toEqual([
      { id: 'h1', field: 'status', from: 'todo', to: 'progress' },
      { id: 'h2', field: 'department', from: '', to: 'd_fin' },
    ])
    expect(JSON.parse(t.cell('Tasks', 't1', 'schedule_json')).responses).toEqual({ m1: { c1: 'yes', c2: 'maybe' } })
    // 空はそのまま(読む時の既定と同じ)。未分類は空
    expect(['status', 'difficulty', 'importance', 'visibility', 'approval_status', 'department'].map((c) => t.cell('Tasks', 't2', c)))
      .toEqual(['done', '', '', 'all', '', ''])
    expect(t.cell('Tasks', 't3', 'status')).toBe('謎のステータス')
    expect(t.cell('Tasks', 't3', 'department')).toBe('d_fin')
  })

  it('役職を roles(ID 付き)にし、メンバーの役職・権限の例外の部門・承認ステップの役職を ID にする', () => {
    const t = applied()
    const roles = JSON.parse(t.setting('roles')) as { id: string; name: string; tier: string; restricted?: boolean; sections?: string[] }[]
    expect(roles.map((r) => [r.name, r.tier])).toEqual([['一般', 'base'], ['班長', 'admin'], ['事業責任者', 'admin'], ['会計係', 'admin'], ['代表', 'top']])
    const id = (name: string) => roles.find((r) => r.name === name)!.id
    expect(id('一般')).toBe('base')
    expect(id('代表')).toBe('top')
    expect(roles.find((r) => r.name === '班長')).toMatchObject({ restricted: true, sections: ['projects'] })
    expect(['m1', 'm2', 'm3', 'm4'].map((m) => t.cell('Members', m, 'role'))).toEqual(['top', id('班長'), id('会計係'), 'base'])
    expect(JSON.parse(t.cell('Members', 'm2', 'permission_overrides_json'))[0].targetId).toBe('pr')
    // 経費申請は、承認が済んだ過去の申請も含めてすべての行
    expect(JSON.parse(t.cell('Expenses', 'e1', 'approval_steps_json'))[0].role).toBe(id('班長'))
    expect(JSON.parse(t.cell('Expenses', 'e2', 'approval_steps_json'))[0].role).toBe('昔の役職') // 当てはまらない値は残す
    const defs = JSON.parse(t.setting('custom_form_defs'))
    expect(defs[0].approvalSteps.map((s: { role: string }) => s.role)).toEqual([id('班長'), '削除済みの役職'])
    expect(JSON.parse(t.setting('expense_categories'))[0].approvalSteps[0].role).toBe(id('事業責任者'))
  })

  it('Settings のテンプレート・定期タスク・スキルの閾値のキーも変え、移行の印を付ける', () => {
    const t = applied()
    expect(JSON.parse(t.setting('recurring_rules'))[0]).toMatchObject({ department: 'ops', difficulty: 'anyone', priority: 'medium', triggerOnStatus: 'done' })
    expect(JSON.parse(t.setting('skill_level_thresholds'))).toEqual({ _default: 120 })
    expect(t.setting('migrated_at')).toMatch(/^\d{4}-/)
    expect(t.props.VALUE_FORMAT).toBe('codes')
    expect(t.props.MIGRATION_MODE).toBe('dryRun')
  })

  it('バックアップのコピーを作り、誰とも共有しない。コピーの GAS をデプロイしないことと削除の目安をログに出す', () => {
    const t = applied()
    expect(t.copies).toHaveLength(1)
    expect(t.copies[0].removedEditors).toEqual(['editor@example.com'])
    expect(t.copies[0].removedViewers).toEqual(['viewer@example.com'])
    expect(t.copies[0].sharing).toEqual([['PRIVATE', 'NONE']])
    const log = t.logs.join('\n')
    expect(log).toMatch(/誰とも共有していません/)
    expect(log).toMatch(/コピーの GAS はデプロイしないでください/)
    expect(log).toMatch(/1か月/)
  })

  it('2回目は何も変わらない', () => {
    const t = applied()
    const after = t.snapshot()
    t.props.MIGRATION_MODE = 'apply'
    const report = t.gas.migrateToInternalCodes() as Report
    // migrated_at 以外は同じ
    const strip = (s: Record<string, unknown[][]>) => ({ ...s, Settings: s.Settings.filter((r) => r[0] !== 'migrated_at') })
    expect(strip(t.snapshot())).toEqual(strip(after))
    expect(report.counts).toEqual({})
  })

  it('移行の後も、画面のデータは移行の前と同じ(役職の ID・部門の ID を含む)', () => {
    const t = setup()
    const view = (tt: ReturnType<typeof setup>) => {
      const rec = (name: string) => {
        const [h, ...rows] = tt.sheets[name].rows
        return rows.map((r) => Object.fromEntries((h as string[]).map((k, i) => [k, String(r[i] ?? '')])))
      }
      const settings = parseSettings(rec('Settings').map((r) => ({ key: r.key, value: r.value })))
      const data = mapRemoteData(rec('Members'), [], rec('Tasks'), settings.roles, settings.departments)
      return {
        tasks: data.tasks,
        // 役職は ID が変わるので名前で比べる(移行前に一覧に無い役職名は、その値)
        members: data.members.map((m) => ({ ...m, role: settings.roles.find((r) => r.id === m.role || r.name === m.role)?.name ?? m.role })),
        recurring: settings.recurringRules,
        thresholds: settings.skillLevelThresholds,
      }
    }
    const before = view(t)
    t.props.MIGRATION_MODE = 'apply'
    t.gas.migrateToInternalCodes()
    const after = view(t)
    expect(after.tasks).toEqual(before.tasks)
    expect(after.members).toEqual(before.members)
    expect(after.recurring).toEqual(before.recurring)
    expect(after.thresholds).toEqual(before.thresholds)
  })
})

describe('列や設定が無くても動く', () => {
  it('Expenses シートが無い・設定が空でも、dryRun と apply ができる', () => {
    const t = setup({ noExpenses: true, settings: {}, props: { MIGRATION_MODE: 'apply' } })
    expect(() => t.gas.migrateToInternalCodes()).not.toThrow()
    expect(t.props.VALUE_FORMAT).toBe('codes')
    expect(JSON.parse(t.setting('roles')).map((r: { name: string }) => r.name)).toEqual(['一般', '班長', '事業責任者', '会計係', '代表'])
  })
})

describe('役職の並び順(一般 → 管理者の役職 → 最上位の役職)', () => {
  // テスト環境の dryRun で見つかった例: 一般17人・班長0人・事業責任者1人・代表2人・サンプル班長2人
  const members = [
    ...Array.from({ length: 17 }, (_, i) => T({ id: `g${i}`, name: `一般${i}`, role: '一般' })),
    T({ id: 'b1', name: '事業責任者さん', role: '事業責任者' }),
    T({ id: 'p1', name: '代表さん1', role: '代表' }), T({ id: 'p2', name: '代表さん2', role: '代表' }),
    T({ id: 's1', name: 'サンプル班長さん1', role: 'サンプル班長' }), T({ id: 's2', name: 'サンプル班長さん2', role: 'サンプル班長' }),
  ]
  const order = (report: Report) => report.roles.map((r) => [r.name, r.tier, r.restricted])
  const expected = (restricted: boolean) => [['一般', 'base', false], ['班長', 'admin', false], ['事業責任者', 'admin', false], ['サンプル班長', 'admin', restricted], ['代表', 'top', false]]

  it('role_levels に無い役職は、既存の管理者の役職の後ろ(最上位の役職のすぐ下)に入れ、位置を報告する', () => {
    const t = setup({ members, settings: { role_levels: '班長,事業責任者,代表' } })
    const report = t.gas.migrateToInternalCodes() as Report
    expect(order(report)).toEqual(expected(false))
    expect(report.rolePlacements).toEqual([{ name: 'サンプル班長', reason: 'created', below: '事業責任者', above: '代表' }])
    const log = t.logs.join('\n')
    expect(log).toMatch(/サンプル班長: 「事業責任者」の上、「代表」の下\(役職の一覧に無かった役職\)/)
    expect(log).toMatch(/サンプル班長\(admin、全権の管理者、ID: [^)]+\)2人/)
    expect(log).toMatch(/代表\(top、ID: top\)2人/)
    expect(log).toMatch(/一般\(base、ID: base\)17人/)
  })

  it('role_levels で最上位の役職より後ろに書いた役職(サンプルのデータを入れた団体など)も、最上位の役職のすぐ下へ移す', () => {
    const t = setup({ members, settings: { role_levels: '班長,事業責任者,代表,サンプル班長', restricted_roles: 'サンプル班長' }, props: { MIGRATION_MODE: 'apply' } })
    const report = t.gas.migrateToInternalCodes() as Report
    expect(order(report)).toEqual(expected(true))
    expect(report.rolePlacements).toEqual([{ name: 'サンプル班長', reason: 'moved', below: '事業責任者', above: '代表' }])
    expect(t.logs.join('\n')).toMatch(/サンプル班長: 「事業責任者」の上、「代表」の下\(最上位の役職より後ろに並んでいた役職\)/)
    // 書き込む roles も同じ順
    const roles = JSON.parse(t.setting('roles'))
    expect(roles.map((r: { name: string }) => r.name)).toEqual(['一般', '班長', '事業責任者', 'サンプル班長', '代表'])
    expect(t.cell('Members', 's1', 'role')).toBe(roles[3].id)
  })

  it('移行後の役職に、管理者の役職が制限付きかどうかを出す', () => {
    const t = setup({ members, settings: { role_levels: '班長,事業責任者,代表', restricted_roles: '班長' } })
    const report = t.gas.migrateToInternalCodes() as Report
    expect(report.roles.find((r) => r.name === '班長')!.restricted).toBe(true)
    const log = t.logs.join('\n')
    expect(log).toMatch(/班長\(admin、制限付きの管理者、ID: [^)]+\)0人/)
    expect(log).toMatch(/事業責任者\(admin、全権の管理者、ID: [^)]+\)1人/)
  })

  it('並べ替えの必要が無ければ、位置の報告は出さない', () => {
    const report = setup({ members: members.filter((m) => m.role !== 'サンプル班長'), settings: { role_levels: '班長,事業責任者,代表' } }).gas.migrateToInternalCodes() as Report
    expect(report.rolePlacements).toEqual([])
  })
})

describe('最上位の役職(MIGRATION_TOP_ROLE_NAME)', () => {
  const members = [T({ id: 'm1', name: '会長さん', role: '会長' }), T({ id: 'm2', name: '一般さん', role: '一般' })]

  it('代表のいない団体は、指定しないと apply できない(報告する)', () => {
    const t = setup({ members, settings: { role_levels: '会長' }, props: { MIGRATION_MODE: 'apply' } })
    expect(() => t.gas.migrateToInternalCodes()).toThrow(/エラーがあるため/)
    expect(t.logs.join('\n')).toMatch(/最上位の役職を持つ有効なメンバーがいません/)
    expect(t.props.VALUE_FORMAT).toBeUndefined()
    expect(t.copies).toHaveLength(0)
  })

  it('指定した役職を最上位(ID は top)にし、使われていない代表は作らない', () => {
    const t = setup({ members, settings: { role_levels: '会長' }, props: { MIGRATION_MODE: 'apply', MIGRATION_TOP_ROLE_NAME: '会長' } })
    t.gas.migrateToInternalCodes()
    const roles = JSON.parse(t.setting('roles'))
    expect(roles.map((r: { name: string; tier: string; id: string }) => [r.name, r.tier, r.id])).toEqual([['一般', 'base', 'base'], ['会長', 'top', 'top']])
    expect(t.cell('Members', 'm1', 'role')).toBe('top')
  })

  it('指定した役職が見つからなければ報告する', () => {
    const t = setup({ members, settings: { role_levels: '会長' }, props: { MIGRATION_TOP_ROLE_NAME: '理事長' } })
    const report = t.gas.migrateToInternalCodes() as Report
    expect(report.errors.join()).toMatch(/「理事長」が見つかりません/)
  })
})
