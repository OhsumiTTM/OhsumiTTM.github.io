// gas/Code.gs の読み込み方式の計測(measureReadA〜D)と、メールアドレス表の
// キャッシュの版(MEMBER_EMAILS_VERSION)を、メモリ上の簡易なスプレッドシートで確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Cell = string | number | boolean | Date

// display は表示されている文字列。指定しなければ値をそのまま文字列にする
class FakeSheet {
  failDisplay = false
  constructor(
    public name: string,
    public rows: Cell[][],
    public display: string[][] | null = null,
  ) {}
  getName() {
    return this.name
  }
  getLastRow() {
    return this.rows.length
  }
  getLastColumn() {
    return this.rows[0]?.length ?? 0
  }
  getDataRange() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn())
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    const pick = <T,>(src: T[][], empty: T) =>
      Array.from({ length: numRows }, (_, r) =>
        Array.from({ length: numCols }, (_, c) => src[row - 1 + r]?.[col - 1 + c] ?? empty),
      )
    return {
      getValues: () => pick(this.rows, '' as Cell),
      getDisplayValues: () => {
        if (this.failDisplay) throw new Error('Service Spreadsheets timed out')
        return pick(this.display ?? this.rows.map((r) => r.map((v) => String(v))), '')
      },
      setValue: (v: Cell) => {
        this.rows[row - 1][col - 1] = v
        if (this.display) this.display[row - 1][col - 1] = String(v)
      },
    }
  }
  appendRow(values: Cell[]) {
    this.rows.push([...values])
  }
  deleteRow(row: number) {
    this.rows.splice(row - 1, 1)
  }
}

function setup(fetchResponse?: { code: number; body: unknown }) {
  const sheets: Record<string, FakeSheet> = {
    Members: new FakeSheet('Members', [
      ['id', 'name', 'role'],
      ['1', '代表さん', '代表'],
      ['2', '一般さん', '一般'],
      ['', '', ''],
    ]),
    Projects: new FakeSheet('Projects', [['id', 'name', 'archived'], ['p1', 'プロジェクト', 'FALSE']]),
    Tasks: new FakeSheet('Tasks', [['id', 'title', 'assignee_id'], ['t1', 'タスク', '2']]),
    Settings: new FakeSheet('Settings', [['key', 'value'], ['org_name', 'テスト団体']]),
    MemberEmails: new FakeSheet('MemberEmails', [['id', 'email'], ['1', 'boss@example.com'], ['2', 'a@example.com, b@example.com']]),
    Other: new FakeSheet('Other', [['x']]),
  }
  const props: Record<string, string> = { DATA_VERSION: 'v1' }
  const cache: Record<string, string> = {}
  const calls = { cachePut: 0, emailSheetReads: 0, fetchUrls: [] as string[] }
  const origGetRange = sheets.MemberEmails.getRange.bind(sheets.MemberEmails)
  sheets.MemberEmails.getRange = (row: number, col: number, numRows = 1, numCols = 1) => {
    if (row === 2 && numRows > 0) calls.emailSheetReads++
    return origGetRange(row, col, numRows, numCols)
  }
  const context = vm.createContext({
    console: { log: () => undefined, warn: () => undefined, error: () => undefined },
    Logger: { log: () => undefined },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props[k] ?? null,
        setProperty: (k: string, v: string) => {
          props[k] = v
        },
        deleteProperty: (k: string) => {
          delete props[k]
        },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cache[k] ?? null,
        put: (k: string, v: string) => {
          calls.cachePut++
          cache[k] = v
        },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name: string) => sheets[name] ?? null,
        getSheets: () => Object.values(sheets),
        getId: () => 'sheet-id',
        getSpreadsheetTimeZone: () => 'Asia/Tokyo',
      }),
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    Utilities: {
      formatDate: (d: Date) =>
        `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
    },
    UrlFetchApp: {
      fetch: (url: string, options: { headers: Record<string, string> }) => {
        calls.fetchUrls.push(url)
        expect(options.headers.Authorization).toBe('Bearer token')
        const res = fetchResponse ?? { code: 500, body: {} }
        return { getResponseCode: () => res.code, getContentText: () => JSON.stringify(res.body) }
      },
    },
  })
  vm.runInContext(CODE_GS, context)
  const gas = context as unknown as Record<string, (...args: unknown[]) => string>
  return { gas, sheets, props, cache, calls }
}

// batchGet の応答: 行末・末尾の空セルは省かれる
function batchGetBody(sheets: Record<string, FakeSheet>) {
  return {
    valueRanges: ['Members', 'Projects', 'Tasks', 'Settings'].map((name) => ({
      range: `${name}!A1:Z100`,
      values: sheets[name].rows
        .map((r) => {
          const row = r.map(String)
          while (row.length && row[row.length - 1] === '') row.pop()
          return row
        })
        .filter((r, i, all) => r.length > 0 || all.slice(i).some((x) => x.length > 0)),
    })),
  }
}

describe("読み込み方式の計測", () => {
  it('(a)〜(c) はシートごとの内訳を出し、結果が現在の方式と一致する', () => {
    for (const fn of ['measureReadA', 'measureReadB', 'measureReadC']) {
      const { gas } = setup()
      const text = gas[fn]()
      expect(text, fn).toMatch(/Members: 4行×3列=12セル/)
      expect(text, fn).toMatch(/所要時間\(合計\): \d+ ms/)
      expect(text, fn).toMatch(/結果の一致\(getDisplayValues と比べて\): 一致/)
    }
    expect(setup().gas.measureReadA()).toMatch(/スプレッドシートを開く \d+ms \/ シートの取得 \d+ms \/ 最終行・最終列\(4回\) \d+ms \/ getRange \d+ms \/ getDisplayValues \d+ms \/ 空行の除去/)
    expect(setup().gas.measureReadB()).toMatch(/シート数 6/)
    expect(setup().gas.measureReadC()).toMatch(/getValues \d+ms \/ 文字列への変換/)
  })

  it('(d) は batchGet を1回だけ呼び、省かれた空セルを補って一致させる', () => {
    const base = setup()
    const { gas, calls } = setup({ code: 200, body: batchGetBody(base.sheets) })
    const text = gas.measureReadD()
    expect(calls.fetchUrls).toHaveLength(1)
    expect(calls.fetchUrls[0]).toContain('/spreadsheets/sheet-id/values:batchGet?ranges=')
    expect(calls.fetchUrls[0]).toContain('valueRenderOption=FORMATTED_VALUE')
    expect(text).toMatch(/batchGet\(HTTP\) \d+ms/)
    expect(text).toMatch(/応答: HTTP 200/)
    expect(text).toMatch(/結果の一致\(getDisplayValues と比べて\): 一致/)
  })

  it('(d) で Sheets API が無効な場合は、エラーの内容と対処を出して終わる(例外を投げない)', () => {
    const { gas, props } = setup({
      code: 403,
      body: {
        error: {
          code: 403,
          status: 'PERMISSION_DENIED',
          message: 'Google Sheets API has not been used in project 123 before or it is disabled.',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      },
    })
    const text = gas.measureReadD()
    expect(text).toMatch(/HTTP 403 PERMISSION_DENIED \/ SERVICE_DISABLED/)
    expect(text).toMatch(/Google Sheets API を追加/)
    // 失敗した計測は記録しない
    expect(props.READ_MEASURE_HISTORY_d).toBeUndefined()
  })

  it('途中のシートで失敗しても、例外を投げず残りのシートを測る', () => {
    const { gas, sheets, props } = setup()
    sheets.Tasks.failDisplay = true
    const text = gas.measureReadA()
    expect(text).toMatch(/Tasks: .*❌ Error: Service Spreadsheets timed out/)
    expect(text).toMatch(/Settings: 2行×2列/)
    expect(text).toMatch(/一部のシートの読み込みに失敗しました/)
    expect(props.READ_MEASURE_HISTORY_a).toBeUndefined()
  })

  it('スプレッドシートを開けなくても例外を投げない', () => {
    const { gas } = setup()
    const ctx = gas as unknown as { SpreadsheetApp: unknown }
    ctx.SpreadsheetApp = {
      getActiveSpreadsheet: () => {
        throw new Error('boom')
      },
    }
    for (const fn of ['measureReadA', 'measureReadB', 'measureReadC', 'measureReadD']) {
      expect(() => gas[fn](), fn).not.toThrow()
      expect(gas[fn](), fn).toMatch(/❌/)
    }
  })

  it('データの版・メールアドレス表の版・キャッシュを変えない', () => {
    const base = setup()
    const { gas, props, calls } = setup({ code: 200, body: batchGetBody(base.sheets) })
    const before = { ...props }
    for (const fn of ['measureReadA', 'measureReadB', 'measureReadC', 'measureReadD']) gas[fn]()
    expect(props.DATA_VERSION).toBe(before.DATA_VERSION)
    expect(props.MEMBER_EMAILS_VERSION).toBe(before.MEMBER_EMAILS_VERSION)
    expect(calls.cachePut).toBe(0)
  })

  it('3回実行すると直近3回の中央値を出し、記録は5回分まで残す', () => {
    const { gas, props } = setup()
    expect(gas.measureReadB()).toMatch(/あと 2 回/)
    gas.measureReadB()
    expect(gas.measureReadB()).toMatch(/直近3回の中央値 \d+ ms/)
    for (let i = 0; i < 4; i++) gas.measureReadB()
    expect(JSON.parse(props.READ_MEASURE_HISTORY_b)).toHaveLength(5)
    expect(gas.showReadMeasurements()).toMatch(/\(b\).*直近3回の中央値/)
    expect(gas.showReadMeasurements()).toMatch(/\(a\).*記録なし/)
    gas.clearReadMeasurements()
    expect(props.READ_MEASURE_HISTORY_b).toBeUndefined()
  })

  it('(c) で表示形式と違う文字列になったセルは、不一致として件数と例を出す', () => {
    const { gas, sheets } = setup()
    sheets.Tasks.rows = [
      ['id', 'title', 'due_date', 'done'],
      ['t1', 'タスク', new Date(2026, 0, 5), true],
    ]
    sheets.Tasks.display = [
      ['id', 'title', 'due_date', 'done'],
      ['t1', 'タスク', '2026/1/5', 'TRUE'],
    ]
    const text = gas.measureReadC()
    expect(text).toMatch(/不一致 1 セル\(例: Tasks 2行目 due_date: "2026\/1\/5" → "2026\/01\/05"\)/)
  })
})

describe('メールアドレス表のキャッシュの版', () => {
  it('メールに関係のない書き込み(データの版の更新)ではキャッシュを使い続ける', () => {
    const { gas, calls } = setup()
    expect(gas.findMemberIdByEmailCached_('B@example.com ')).toBe('2')
    expect(calls.emailSheetReads).toBe(1)
    gas.bumpDataVersion()
    expect(gas.findMemberIdByEmailCached_('boss@example.com')).toBe('1')
    expect(calls.emailSheetReads).toBe(1)
  })

  it('メールの変更(setMemberEmail_)で版が変わり、新しいメールでログインできる', () => {
    const { gas, props, calls } = setup()
    expect(gas.findMemberIdByEmailCached_('new@example.com')).toBeNull()
    const before = props.MEMBER_EMAILS_VERSION
    gas.setMemberEmail_('2', 'new@example.com')
    expect(props.MEMBER_EMAILS_VERSION).not.toBe(before)
    expect(gas.findMemberIdByEmailCached_('new@example.com')).toBe('2')
    expect(gas.findMemberIdByEmailCached_('a@example.com')).toBeNull()
    expect(calls.emailSheetReads).toBeGreaterThanOrEqual(2)
    // 新しいメンバーの行を追加した場合も同じ
    gas.setMemberEmail_('3', 'third@example.com')
    expect(gas.findMemberIdByEmailCached_('third@example.com')).toBe('3')
  })

  it('書き込みに失敗しても版は新しくする', () => {
    const { gas, sheets, props } = setup()
    sheets.MemberEmails.appendRow = () => {
      throw new Error('write failed')
    }
    expect(() => gas.setMemberEmail_('9', 'x@example.com')).toThrow(/write failed/)
    expect(props.MEMBER_EMAILS_VERSION).toBeDefined()
  })

  it('メンバーの削除と、スプレッドシートの手動編集でも版が変わる', () => {
    const { gas, props } = setup()
    gas.removeMember_('2')
    const afterRemove = props.MEMBER_EMAILS_VERSION
    expect(afterRemove).toBeDefined()
    gas.onSpreadsheetChange({})
    expect(props.MEMBER_EMAILS_VERSION).not.toBe(afterRemove)
    expect(props.DATA_VERSION).not.toBe('v1')
    gas.resetMemberEmailsCache()
    expect(props.MEMBER_EMAILS_VERSION).not.toBe(afterRemove)
  })
})
