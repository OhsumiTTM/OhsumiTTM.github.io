// gas/Code.gs の読み込み(readSheetTables): Sheets API の values.batchGet で読み、
// 失敗したら getSheets() + getDisplayValues() で読み直すこと、どちらで読んでも
// 同じ見え方になることを、メモリ上の簡易なスプレッドシートと API で確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const GAS_DIR = join(__dirname, '..', '..', 'gas')
const CODE_GS = readFileSync(join(GAS_DIR, 'Code.gs'), 'utf8')

// display は表示されている文字列の格子。末尾の空行・空列を含められる。
// getLastRow / getLastColumn は実物と同じく「値のある最後の行・列」を返す
class FakeSheet {
  constructor(
    public name: string,
    public display: string[][],
  ) {}
  getName() {
    return this.name
  }
  getLastRow() {
    for (let r = this.display.length; r > 0; r--) if (this.display[r - 1].some((v) => v !== '')) return r
    return 0
  }
  getLastColumn() {
    let last = 0
    this.display.forEach((row) => row.forEach((v, c) => { if (v !== '') last = Math.max(last, c + 1) }))
    return last
  }
  getDataRange() {
    // 空のシートでも A1 の1セルを返す
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1))
  }
  getRange(row: number, col: number, numRows: number, numCols: number) {
    return {
      getDisplayValues: () =>
        Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numCols }, (_, c) => this.display[row - 1 + r]?.[col - 1 + c] ?? ''),
        ),
    }
  }
}

// values.batchGet(FORMATTED_VALUE)の応答: 行末の空セルと、末尾の空行を省く
function apiValueRange(sheet: FakeSheet) {
  const rows = sheet.display.slice(0, sheet.getLastRow()).map((r) => {
    const row = [...r]
    while (row.length && row[row.length - 1] === '') row.pop()
    return row
  })
  const range = `'${sheet.name}'!A1:${String.fromCharCode(64 + Math.max(sheet.getLastColumn(), 1))}${Math.max(rows.length, 1)}`
  return rows.length ? { range, majorDimension: 'ROWS', values: rows } : { range, majorDimension: 'ROWS' }
}

type Fetch = (url: string) => { code: number; text: string }

function setup(sheets: FakeSheet[], fetch?: Fetch) {
  const byName = Object.fromEntries(sheets.map((s) => [s.name, s]))
  const logs: string[] = []
  const warns: string[] = []
  const fetchUrls: string[] = []
  const defaultFetch: Fetch = (url) => {
    const names = new URL(url).searchParams.getAll('ranges').map((r) => r.slice(1, -1).replace(/''/g, "'"))
    const missing = names.find((n) => !byName[n])
    if (missing) {
      return {
        code: 400,
        text: JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Unable to parse range: '${missing}'` } }),
      }
    }
    return { code: 200, text: JSON.stringify({ spreadsheetId: 'sheet-id', valueRanges: names.map((n) => apiValueRange(byName[n])) }) }
  }
  const context = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m), error: () => undefined },
    Logger: { log: () => undefined },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null, setProperty: () => undefined }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, getAll: () => ({}), put: () => undefined, putAll: () => undefined }) },
    Utilities: {
      gzip: () => ({ getBytes: () => [] }),
      newBlob: () => ({}),
      base64Encode: () => '',
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getId: () => 'sheet-id',
        getSheets: () => sheets,
        getSheetByName: (n: string) => byName[n] ?? null,
      }),
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: {
      fetch: (url: string, options: { headers: Record<string, string>; muteHttpExceptions: boolean }) => {
        fetchUrls.push(url)
        expect(options.headers.Authorization).toBe('Bearer token')
        expect(options.muteHttpExceptions).toBe(true)
        const res = (fetch ?? defaultFetch)(url)
        return { getResponseCode: () => res.code, getContentText: () => res.text }
      },
    },
  })
  vm.runInContext(CODE_GS, context)
  const gas = context as unknown as {
    readSheetTables_: (names: string[]) => Record<string, { headers: string[]; rows: string[][] }>
    readSheetTablesViaSpreadsheetApp_: (names: string[]) => Record<string, { headers: string[]; rows: string[][] }>
    readSheetTable: (name: string) => { headers: string[]; rows: string[][] }
    loadSnapshot_: () => { data: Record<string, unknown> }
    measureReadD: () => string
    SNAPSHOT_SHEETS: string[]
  }
  return { gas, logs, warns, fetchUrls, defaultFetch }
}

// 日付・TRUE/FALSE・数値・空のセル・末尾の空行と空列を含むシート
const sampleSheets = () => [
  new FakeSheet('Members', [
    ['id', 'name', 'joined_at', 'inactive', 'years_of_experience', '', ''],
    ['1', '代表さん', '2026/01/05', 'FALSE', '3', '', ''],
    ['2', '', '2026/4/1 9:30:00', 'TRUE', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['3', '途中に空行', '', '', '1,234.5', '', ''],
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
  ]),
  new FakeSheet('Projects', [
    ['id', 'name', 'archived', 'start_date'],
    ['p1', 'A', 'FALSE', ''],
    ['p2', '', 'TRUE', '2026年1月5日'],
  ]),
  new FakeSheet('Tasks', [
    ['id', 'title', 'progress_percent', 'estimated_hours', 'due_date', 'note'],
    ['t1', 'タスク', '50%', '0.5', '2026/12/31', ''],
    ['t2', '', '', '', '', 'メモ'],
    ['t3', '=1+1 と表示', '¥1,000', '#N/A', '', ''],
    ['', '', '', '', '', ''],
  ]),
  // 値のない列が見出しより右にある(見出しの無い列)
  new FakeSheet('Settings', [
    ['key', 'value', '', ''],
    ['org_name', 'テスト団体', '', ''],
    ['restricted_roles', '', '', 'メモ'],
  ]),
]

describe('readSheetTables_(Sheets API で読む)', () => {
  it('batchGet を1回だけ呼び、getDisplayValues と同じ見え方で読める', () => {
    const { gas, fetchUrls, logs, warns } = setup(sampleSheets())
    const names = ['Members', 'Projects', 'Tasks', 'Settings']
    const viaApi = gas.readSheetTables_(names)
    expect(fetchUrls).toHaveLength(1)
    expect(fetchUrls[0]).toContain('/spreadsheets/sheet-id/values:batchGet?')
    expect(fetchUrls[0]).toContain('valueRenderOption=FORMATTED_VALUE')
    expect(logs.some((m) => /Sheets API\(batchGet\)で読み込み/.test(m))).toBe(true)
    expect(warns).toHaveLength(0)
    // 予備の読み方 (b) と完全に同じ(見出し・行の幅・値)
    expect(JSON.parse(JSON.stringify(viaApi))).toEqual(JSON.parse(JSON.stringify(gas.readSheetTablesViaSpreadsheetApp_(names))))
    expect(viaApi.Members.headers).toEqual(['id', 'name', 'joined_at', 'inactive', 'years_of_experience'])
    expect(viaApi.Members.rows).toEqual([
      ['1', '代表さん', '2026/01/05', 'FALSE', '3'],
      ['2', '', '2026/4/1 9:30:00', 'TRUE', ''],
      ['3', '途中に空行', '', '', '1,234.5'],
    ])
    expect(viaApi.Settings.headers).toEqual(['key', 'value', '', ''])
    expect(viaApi.Settings.rows[0]).toEqual(['org_name', 'テスト団体', '', ''])
  })

  it('計測関数の「結果の一致」でも、(d) と getDisplayValues に違いが出ない', () => {
    const { gas } = setup(sampleSheets())
    expect(gas.measureReadD()).toMatch(/結果の一致\(getDisplayValues と比べて\): 一致/)
  })

  it('スナップショットは4シートを1回の batchGet で読む', () => {
    const { gas, fetchUrls } = setup(sampleSheets())
    const snap = gas.loadSnapshot_()
    expect(fetchUrls).toHaveLength(1)
    expect(Object.keys(snap.data)).toEqual(['Members', 'Projects', 'Tasks', 'Settings'])
  })

  it('空のシートは見出しも行も空になる(どちらの読み方でも)', () => {
    const sheets = sampleSheets()
    sheets[3] = new FakeSheet('Settings', [])
    const { gas } = setup(sheets)
    expect(JSON.parse(JSON.stringify(gas.readSheetTables_(['Settings'])))).toEqual({ Settings: { headers: [], rows: [] } })
    expect(JSON.parse(JSON.stringify(gas.readSheetTablesViaSpreadsheetApp_(['Settings'])))).toEqual({
      Settings: { headers: [], rows: [] },
    })
  })
})

describe('readSheetTables_(Sheets API が失敗した場合)', () => {
  const failures: [string, Fetch | 'throw', RegExp][] = [
    ['403 Sheets API が無効', () => ({
      code: 403,
      text: JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Sheets API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }),
    }), /HTTP 403 PERMISSION_DENIED \/ SERVICE_DISABLED/],
    ['429 利用上限', () => ({
      code: 429,
      text: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Read requests'", details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } }),
    }), /HTTP 429 RESOURCE_EXHAUSTED \/ RATE_LIMIT_EXCEEDED/],
    ['500', () => ({ code: 500, text: JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'Internal error' } }) }), /HTTP 500 INTERNAL/],
    ['503(JSON でない応答)', () => ({ code: 503, text: '<html>Service Unavailable</html>' }), /HTTP 503 <html>Service Unavailable/],
    ['通信エラー', 'throw', /通信エラー: Address unavailable/],
    ['200 だが JSON でない', () => ({ code: 200, text: 'oops' }), /JSON として読めません/],
    ['200 だが範囲の数が違う', () => ({ code: 200, text: JSON.stringify({ valueRanges: [] }) }), /範囲の数が違います/],
    ['200 だが範囲のシートが違う', () => ({
      code: 200,
      text: JSON.stringify({ valueRanges: ['Projects', 'Members', 'Tasks', 'Settings'].map((n) => ({ range: `${n}!A1:B2`, values: [] })) }),
    }), /範囲が違います/],
  ]

  for (const [label, behavior, reason] of failures) {
    it(`${label}: getSheets() + getDisplayValues で読み直し、理由をログに残す`, () => {
      const fetch: Fetch = behavior === 'throw'
        ? () => { throw new Error('Address unavailable: https://sheets.googleapis.com/...') }
        : behavior
      const expected = setup(sampleSheets()).gas.readSheetTablesViaSpreadsheetApp_(['Members', 'Projects', 'Tasks', 'Settings'])
      const { gas, warns } = setup(sampleSheets(), fetch)
      const tables = gas.readSheetTables_(['Members', 'Projects', 'Tasks', 'Settings'])
      expect(JSON.parse(JSON.stringify(tables))).toEqual(JSON.parse(JSON.stringify(expected)))
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatch(/SpreadsheetApp\(getDisplayValues\)で読み込み \d+ms。理由: /)
      expect(warns[0]).toMatch(reason)
    })
  }

  it('シートが無い(400 Unable to parse range)場合も読み直し、無いシートは空で返す', () => {
    const sheets = sampleSheets().slice(0, 3)
    const { gas, warns } = setup(sheets)
    const tables = gas.readSheetTables_(['Members', 'Projects', 'Tasks', 'Settings'])
    expect(tables.Settings).toEqual({ headers: [], rows: [] })
    expect(tables.Members.rows).toHaveLength(3)
    expect(warns[0]).toMatch(/HTTP 400 INVALID_ARGUMENT \/ Unable to parse range/)
  })
})

describe('appsscript.json', () => {
  const manifest = JSON.parse(readFileSync(join(GAS_DIR, 'appsscript.json'), 'utf8'))

  it('Google Sheets API(v4)のサービスを含む', () => {
    expect(manifest.dependencies.enabledAdvancedServices).toContainEqual({
      userSymbol: 'Sheets',
      serviceId: 'sheets',
      version: 'v4',
    })
  })

  it('権限(oauthScopes)は指定しない(Code.gs から自動で判定させる)', () => {
    expect(manifest.oauthScopes).toBeUndefined()
  })

  it('Web アプリは「実行するユーザー: 自分」「アクセスできるユーザー: 全員」', () => {
    expect(manifest.webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' })
    expect(manifest.runtimeVersion).toBe('V8')
  })
})
