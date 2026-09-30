// gas/Code.gs: 裏での読み込みで、キャッシュに無い表(経費・フォームの回答・候補者・メールアドレス表)を
// Sheets API で1回にまとめて読むこと。値は SpreadsheetApp の getValues と同じ形(日付は Date)にそろえ、
// 1枚ずつ読んだ時(これまで)と同じ結果になることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const TZ = 'Asia/Tokyo'
const ROLES = JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }, { id: 'top', name: '代表', tier: 'top' }])

type Cell = string | number | boolean | Date

// スプレッドシートのタイムゾーンでの日時(壁時計の時刻)の Date。getValues が返すものと同じ
function wall(iso: string, tz = TZ): Date {
  const guess = new Date(iso + 'Z')
  const offset = offsetMs(guess, tz)
  return new Date(guess.getTime() - offset)
}

function formatInTz(date: Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  )
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}`
}

function offsetMs(date: Date, tz: string): number {
  return Date.parse(formatInTz(date, tz) + 'Z') - date.getTime()
}

// Date → スプレッドシートのシリアル値(スプレッドシートのタイムゾーンの壁時計の時刻で数える)
function serialOf(d: Date, tz = TZ): number {
  const wallMs = Date.parse(formatInTz(d, tz) + 'Z')
  return wallMs / 86400000 + 25569
}

// Sheets API の spreadsheets.get(includeGridData)の1枚分。日付は DATE_TIME のシリアル値、数・文字・真偽は
// それぞれの値。書式だけのセル・空の行(値の範囲の外)も入れて、getDataRange と同じ範囲に切ることを確かめる
function gridOf(values: Cell[][]) {
  const rowData = values.map((row) => ({
    values: [
      ...row.map((v) => {
        if (v === '') return { effectiveFormat: { numberFormat: { type: 'TEXT' } } }
        if (v instanceof Date) return { effectiveValue: { numberValue: serialOf(v) }, effectiveFormat: { numberFormat: { type: 'DATE_TIME' } } }
        if (typeof v === 'number') return { effectiveValue: { numberValue: v }, effectiveFormat: { numberFormat: { type: 'NUMBER' } } }
        if (typeof v === 'boolean') return { effectiveValue: { boolValue: v } }
        return { effectiveValue: { stringValue: v } }
      }),
      // 値の無い、書式だけのセル(getDataRange の範囲の外)
      { effectiveFormat: { numberFormat: { type: 'DATE' } } },
    ],
  }))
  return { rowData: [...rowData, {}, { values: [{ effectiveFormat: {} }] }] }
}

const SHEETS: Record<string, Cell[][]> = {
  Expenses: [
    ['id', 'applicant_id', 'amount', 'category_id', 'receipt_url', 'justification', 'purpose', 'custom_field_answers_json', 'approval_steps_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason'],
    ['e1', 'm-top', 1200, 'c1', '', '交通費', '', '{}', '[]', '[]', 0, 'pending', wall('2026-09-30T09:15:30'), ''],
    ['e2', 'm-top', 3456.5, 'c2', 'https://example.com/r', '', '備品', '{"a":1}', '[{"type":"role","role":"top"}]', '[]', 1, 'approved', wall('2026-01-02T00:00:00'), ''],
    // 日付が文字(ISO)で入っている行・金額が文字の行
    ['e3', 'm-top', '500', 'c1', '', '', '', '', '', '', '', 'pending', '2026-09-01T00:00:00.000Z', ''],
  ],
  FormSubmissions: [
    ['id', 'form_id', 'submitter_id', 'answers_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason'],
    ['f1', 'form-a', 'm-top', '{"q1":"はい"}', '[]', 0, 'pending', wall('2026-09-29T23:59:59'), ''],
  ],
  Candidates: [
    ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at'],
    ['c1', '山田', 'y@example.com', 9012345678, '', 'メモ', 'candidate', wall('2026-09-01T10:00:00'), wall('2026-09-02T18:30:00')],
    ['c2', '佐藤', '', '', '', '', 'interview', '2026-08-01', true],
  ],
  MemberEmails: [
    ['id', 'email'],
    ['m-top', 'top@example.com'],
    ['m-base', 'base@example.com'],
  ],
}

function setup(opts: { apiFails?: boolean } = {}) {
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1' }
  const calls: string[] = []
  const blob = (d: Buffer | string) => {
    const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
    return { getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') }
  }
  // getValues の Date は、GAS を動かす環境(vm)の Date にする(instanceof Date が効くように)
  let VmDate: DateConstructor = Date
  const clone = (values: Cell[][]) => values.map((r) => r.map((v) => (v instanceof Date ? new VmDate(v.getTime()) : v)))
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({
      get: (k: string) => cache.get(k) ?? null,
      getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      put: (k: string, v: string) => { cache.set(k, v) },
      putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, v) },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: {
      flush() {},
      getActiveSpreadsheet: () => ({
        getId: () => 'SHEET-ID',
        getSheetByName: (name: string) => {
          calls.push('sheet:' + name)
          const values = SHEETS[name]
          return values ? { getDataRange: () => ({ getValues: () => clone(values) }) } : null
        },
      }),
    },
    UrlFetchApp: {
      fetch: (url: string) => {
        calls.push('api')
        if (opts.apiFails) return { getResponseCode: () => 503, getContentText: () => '{"error":{"message":"unavailable"}}' }
        const names = [...url.matchAll(/ranges=([^&]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/^'|'$/g, ''))
        // 応答のシートの順番は、スプレッドシートの並び(頼んだ順とは限らない)
        const body = { properties: { timeZone: TZ }, sheets: [...names].reverse().map((n) => ({ properties: { title: n }, data: [gridOf(SHEETS[n])] })) }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) }
      },
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    Session: { getScriptTimeZone: () => TZ },
    Utilities: {
      formatDate: (d: Date, tz: string) => formatInTz(d, tz),
      newBlob: (d: Buffer | string) => blob(d),
      gzip: (b: unknown) => b,
      ungzip: (b: unknown) => b,
      base64Encode: (bytes: Buffer) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s: string) => Buffer.from(s, 'base64'),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  VmDate = vm.runInContext('Date', ctx) as DateConstructor
  const c = ctx as unknown as Record<string, unknown>
  c.authenticateRequest_ = (body: { sessionToken?: string }) => ({ memberId: body.sessionToken, renewed: null })
  c.readSheetTables_ = () => ({
    Members: { headers: ['id', 'name', 'role', 'project_ids', 'permission_overrides_json'], rows: [['m-top', '代表', 'top', '', '[]']] },
    Settings: { headers: ['key', 'value'], rows: [['roles', ROLES]] },
  })
  const gas = ctx as unknown as { doPost: (e: object) => { text: string } } & Record<string, (...a: unknown[]) => unknown>
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  return { c, gas, post, calls }
}

const BACKGROUND_SHEETS = ['Expenses', 'FormSubmissions', 'Candidates', 'MemberEmails']

describe('Sheets API の値を getValues と同じ形にする', () => {
  it('日付は Date、数・文字・真偽はそのまま、空は ""。値のある範囲(getDataRange と同じ)に切る', () => {
    const t = setup()
    for (const name of BACKGROUND_SHEETS) {
      const res = t.gas.sheetValuesFromGridResponse_({ properties: { timeZone: TZ }, sheets: [{ properties: { title: name }, data: [gridOf(SHEETS[name])] }] }, [name]) as { values: Record<string, Cell[][]> }
      const got = res.values[name]
      const want = SHEETS[name]
      expect(got.length, name).toBe(want.length)
      got.forEach((row, i) => {
        expect(row.length, `${name} ${i}`).toBe(want[i].length)
        row.forEach((v, j) => {
          const w = want[i][j]
          if (w instanceof Date) {
            // vm の中の Date は別の Date なので、instanceof ではなく時刻で比べる
            expect(Object.prototype.toString.call(v), `${name} ${i},${j}`).toBe('[object Date]')
            expect((v as Date).getTime(), `${name} ${i},${j}`).toBe(w.getTime())
          } else {
            expect(v, `${name} ${i},${j}`).toBe(w)
          }
        })
      })
    }
  })

  it('エラーのセルは getValues と同じくエラーの表示にする。空のシートは [[""]]', () => {
    const t = setup()
    expect(t.gas.cellValueFromApi_({ effectiveValue: { errorValue: { type: 'N_A', message: 'x' } } }, TZ)).toBe('#N/A')
    expect(t.gas.cellValueFromApi_({ effectiveValue: { numberValue: 0 } }, TZ)).toBe(0)
    expect(t.gas.gridDataToValues_({ rowData: [{}, { values: [{ effectiveFormat: {} }] }] }, TZ)).toEqual([['']])
  })

  it('夏時間のあるタイムゾーンでも、壁時計の時刻をそのまま Date にする', () => {
    const t = setup()
    for (const iso of ['2026-07-01T12:00:00', '2026-01-15T08:30:00', '2026-03-08T03:30:00', '2026-11-01T01:30:00']) {
      const d = wall(iso, 'America/New_York')
      const got = t.gas.sheetSerialToDate_(serialOf(d, 'America/New_York'), 'America/New_York') as Date
      expect(formatInTz(got, 'America/New_York'), iso).toBe(formatInTz(d, 'America/New_York'))
    }
  })

  it('応答にシートが無ければ失敗にする(1枚ずつ読み直す)', () => {
    const t = setup()
    const res = t.gas.sheetValuesFromGridResponse_({ sheets: [] }, ['Expenses']) as { error?: string }
    expect(res.error).toContain('Expenses')
  })
})

describe('裏での読み込み(キャッシュが無い時)', () => {
  const load = (opts: { apiFails?: boolean } = {}) => {
    const t = setup(opts)
    const res = t.post({ action: 'getBackgroundData', sessionToken: 'm-top' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    return { t, res }
  }

  it('4つの表を Sheets API の1回で読み、1枚ずつ読んだ時(これまで)と同じ結果を返す', () => {
    const batched = load()
    const oneByOne = load({ apiFails: true })
    expect(batched.res.result.errors).toEqual({})
    for (const key of ['expenses', 'formSubmissions', 'candidates', 'myEmail']) {
      expect(batched.res.result[key], key).toEqual(oneByOne.res.result[key])
    }
    // 日付は、これまでと同じ ISO の文字
    expect(batched.res.result.expenses.find((e: { id: string }) => e.id === 'e1').createdAt).toBe(wall('2026-09-30T09:15:30').toISOString())
    expect(batched.res.result.candidates.find((c: { id: string }) => c.id === 'c1')).toMatchObject({ phone: '9012345678', updatedAt: wall('2026-09-02T18:30:00').toISOString() })
    expect(batched.res.result.myEmail).toBe('top@example.com')

    // まとめた方は API を1回だけ呼び、4つの表をシートから読まない
    expect(batched.t.calls.filter((c) => c === 'api')).toHaveLength(1)
    expect(batched.t.calls.filter((c) => BACKGROUND_SHEETS.some((n) => c === 'sheet:' + n))).toEqual([])
    expect(batched.res.timing).toMatchObject({ batchRead: 'api', batchReadSheets: 4, expensesRows: 3, expensesCols: 14 })
    expect(batched.res.timing.expensesSheetMs).toBeUndefined()

    // API で読めなかった時は、1枚ずつ読み直す(理由を内訳に出す)
    expect(oneByOne.res.timing.batchRead).toBe('spreadsheetApp')
    expect(oneByOne.res.timing.batchReadError).toContain('503')
    expect(oneByOne.t.calls.filter((c) => BACKGROUND_SHEETS.some((n) => c === 'sheet:' + n))).toHaveLength(4)
  })

  it('キャッシュにある表は読まない。キャッシュに無い表が1つだけなら、これまでどおり1枚で読む', () => {
    const t = setup()
    t.post({ action: 'getBackgroundData', sessionToken: 'm-top' })
    t.calls.length = 0
    // 2回目: すべてキャッシュにある
    const second = t.post({ action: 'getBackgroundData', sessionToken: 'm-top' })
    expect(t.calls.filter((c) => c === 'api' || BACKGROUND_SHEETS.some((n) => c === 'sheet:' + n))).toEqual([])
    expect(second.timing).toMatchObject({ expensesCache: 'hit', formSubmissionsCache: 'hit', candidatesCache: 'hit', myEmailCache: 'hit' })
    expect(second.timing.batchReadMs).toBeUndefined()
    // 経費だけ変わった
    ;(t.gas.bumpTableVersion_ as (x: string) => void)('expenses')
    t.calls.length = 0
    const third = t.post({ action: 'getBackgroundData', sessionToken: 'm-top' })
    expect(t.calls.filter((c) => c === 'api' || BACKGROUND_SHEETS.some((n) => c === 'sheet:' + n))).toEqual(['sheet:Expenses'])
    expect(third.timing.batchReadMs).toBeUndefined()
    expect(third.result.expenses).toHaveLength(3)
  })
})
