// gas/Code.gs の性能計測用ダミーデータ(seedPerformanceTestData /
// deletePerformanceTestData)を、メモリ上の簡易なスプレッドシートで確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

// getRange / getValues / setValues / deleteRows だけを持つ簡易なシート
class FakeSheet {
  constructor(public rows: string[][]) {}
  getLastRow() {
    return this.rows.length
  }
  getLastColumn() {
    return this.rows[0]?.length ?? 0
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () =>
        Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? ''),
        ),
      setValues: (values: string[][]) => {
        values.forEach((v, r) => {
          this.rows[row - 1 + r] = [...v]
        })
      },
      setNumberFormat: () => undefined,
    }
  }
  deleteRows(row: number, count: number) {
    this.rows.splice(row - 1, count)
  }
}

function setup(testEnvironment: string | null) {
  const sheets: Record<string, FakeSheet> = {
    Members: new FakeSheet([
      ['id', 'name', 'role', 'reports_to_id', 'evaluation_history_json', 'skill_levels_json'],
      ['1', '本物の代表', '代表', '', '', ''],
    ]),
    Projects: new FakeSheet([['id', 'name', 'member_ids', 'description'], ['10', '本物のプロジェクト', '', '']]),
    Tasks: new FakeSheet([
      ['id', 'title', 'visibility', 'approval_status', 'comments_json', 'history_json', 'project_id'],
      ['100', '本物のタスク', 'all', '', '', '', '10'],
    ]),
  }
  const props: Record<string, string> = testEnvironment == null ? {} : { TEST_ENVIRONMENT: testEnvironment }
  const context = vm.createContext({
    console: { log: () => undefined },
    Logger: { log: () => undefined },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props[k] ?? null,
        setProperty: (k: string, v: string) => {
          props[k] = v
        },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (name: string) => sheets[name] ?? null }),
    },
  })
  vm.runInContext(CODE_GS, context)
  const gas = context as unknown as Record<string, () => string>
  return { gas, sheets, props }
}

const dataRows = (s: FakeSheet) => s.rows.slice(1)
const col = (s: FakeSheet, name: string) => s.rows[0].indexOf(name)

describe('性能計測用のダミーデータ', () => {
  it('TEST_ENVIRONMENT が true でなければ作成も削除もしない', () => {
    for (const value of [null, 'false', 'TRUE ']) {
      const { gas, sheets } = setup(value)
      expect(() => gas.seedPerformanceTestData()).toThrow(/テスト環境ではない/)
      expect(() => gas.deletePerformanceTestData()).toThrow(/テスト環境ではない/)
      expect(dataRows(sheets.Tasks)).toHaveLength(1)
    }
  })

  it('メンバー50人・プロジェクト20件・タスク500件を、実際に近い割合で作る', () => {
    const { gas, sheets, props } = setup('true')
    const before = props.DATA_VERSION
    gas.seedPerformanceTestData()
    expect(dataRows(sheets.Members)).toHaveLength(51)
    expect(dataRows(sheets.Projects)).toHaveLength(21)
    expect(dataRows(sheets.Tasks)).toHaveLength(501)
    // 読み取りキャッシュを無効にする(データの版が変わる)
    expect(props.DATA_VERSION).not.toBe(before)

    const roles = dataRows(sheets.Members).slice(1).map((r) => r[col(sheets.Members, 'role')])
    expect(roles.filter((r) => r === '代表')).toHaveLength(1)
    expect(roles.filter((r) => r === '一般')).toHaveLength(40)

    const tasks = dataRows(sheets.Tasks).slice(1)
    const ratio = (pred: (r: string[]) => boolean) => tasks.filter(pred).length / tasks.length
    expect(ratio((r) => r[col(sheets.Tasks, 'visibility')] === '幹部')).toBeGreaterThan(0.05)
    expect(ratio((r) => r[col(sheets.Tasks, 'visibility')] === '幹部')).toBeLessThan(0.2)
    expect(ratio((r) => r[col(sheets.Tasks, 'approval_status')] === '承認待ち')).toBeGreaterThan(0.01)
    expect(ratio((r) => r[col(sheets.Tasks, 'approval_status')] === '承認待ち')).toBeLessThan(0.12)
    expect(ratio((r) => r[col(sheets.Tasks, 'comments_json')] !== '')).toBeGreaterThan(0.2)
    expect(ratio((r) => r[col(sheets.Tasks, 'history_json')] !== '')).toBeGreaterThan(0.4)
    // コメント・履歴は JSON として読める
    tasks.forEach((r) => {
      const c = r[col(sheets.Tasks, 'comments_json')]
      if (c) expect(Array.isArray(JSON.parse(c))).toBe(true)
    })
    // シートに無い列は書き込まない
    expect(sheets.Tasks.rows[0]).toHaveLength(7)
  })

  it('既にダミーデータがある場合は重ねて作らない', () => {
    const { gas, sheets } = setup('true')
    gas.seedPerformanceTestData()
    expect(() => gas.seedPerformanceTestData()).toThrow(/既に/)
    expect(dataRows(sheets.Tasks)).toHaveLength(501)
  })

  it('削除するとダミーデータだけが消え、元の行は残る', () => {
    const { gas, sheets } = setup('true')
    gas.seedPerformanceTestData()
    // ダミー行の間に本物の行が挟まっていても、本物の行は消さない
    sheets.Tasks.rows.splice(200, 0, ['101', '途中に追加された本物のタスク', 'all', '', '', '', '10'])
    gas.deletePerformanceTestData()
    expect(dataRows(sheets.Members).map((r) => r[0])).toEqual(['1'])
    expect(dataRows(sheets.Projects).map((r) => r[0])).toEqual(['10'])
    expect(dataRows(sheets.Tasks).map((r) => r[0])).toEqual(['100', '101'])
  })
})
