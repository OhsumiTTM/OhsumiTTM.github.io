// gas/Code.gs のシートの列の一覧(SHEET_HEADERS)と、実際に書き込む列・画面が読む列・
// 読み取りの権限表(READ_POLICY)の列がずれていないことを確かめる。
// 一覧に無い列へ書き込むと、setupOhsumi() で作ったシートでは値が保存されない
// (updateRowFields は見つからない列をとばす)ため、新しく導入した団体で機能が壊れる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const CODE_GS = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')

type Gas = { SHEET_HEADERS: Record<string, string[]>; READ_POLICY: Record<string, { columns: Record<string, string> }> } & Record<
  string,
  unknown
>

function loadGas(context: Record<string, unknown> = {}): Gas {
  const ctx = vm.createContext({ console, ...context })
  vm.runInContext(CODE_GS, ctx)
  return ctx as unknown as Gas
}

const gas = loadGas()
const SHEET_BY_CONST: Record<string, string> = {}
for (const m of CODE_GS.matchAll(/^var (SHEET_[A-Z_]+) = '(\w+)'/gm)) SHEET_BY_CONST[m[1]] = m[2]

// ---- Code.gs から「どのシートのどの列に書くか」を集める ----------------------------

const functions = (() => {
  const starts = [...CODE_GS.matchAll(/^function (\w+)\s*\(/gm)].map((m) => ({ name: m[1], idx: m.index! }))
  return starts.map((s, i) => ({ name: s.name, body: CODE_GS.slice(s.idx, starts[i + 1]?.idx ?? CODE_GS.length) }))
})()

// { ... } の一番外側のキー(入れ子・文字列の中は見ない)
function topLevelKeys(text: string, openIndex: number): string[] {
  let depth = 0
  let buf = ''
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      i = text.indexOf(c, i + 1)
      if (depth === 1) buf += '""'
      continue
    }
    if ('{[('.includes(c)) {
      depth++
      if (depth === 1) continue
    }
    if ('}])'.includes(c)) {
      depth--
      if (depth === 0) break
    }
    if (depth === 1) buf += c
  }
  return [...buf.matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/g)].map((m) => m[1])
}

// 書き込み先の関数ごとに、関数の中で組み立てた書き込む値のキーを集める
function keysOfArgument(body: string, argStart: number): string[] {
  const rest = body.slice(argStart)
  if (rest[0] === '{') return topLevelKeys(body, argStart)
  const name = rest.match(/^(\w+)/)?.[1]
  if (!name) return []
  const keys: string[] = []
  const decl = body.match(new RegExp(`var ${name}\\s*=\\s*\\{`))
  if (decl) keys.push(...topLevelKeys(body, decl.index! + decl[0].length - 1))
  for (const m of body.matchAll(new RegExp(`\\b${name}(?:\\.([a-z_][a-z0-9_]*)|\\['([a-z_][a-z0-9_]*)'\\])\\s*=[^=]`, 'g'))) {
    keys.push(m[1] || m[2])
  }
  return keys
}

const WRITER_SHEET: Record<string, string> = { updateTaskFields_: 'Tasks', updateProjectFields_: 'Projects', updateMemberFields_: 'Members' }
const ENSURE_SHEET: Record<string, string> = {
  ensureExpensesSheet_: 'Expenses',
  ensureFormSubmissionsSheet_: 'FormSubmissions',
  ensureDailyReportsSheet_: 'DailyReports',
  ensureCandidatesSheet_: 'Candidates',
  getMemberEmailsSheet_: 'MemberEmails',
}

function collectWrites(): Record<string, Map<string, Set<string>>> {
  const out: Record<string, Map<string, Set<string>>> = {}
  const add = (sheet: string, key: string, where: string) => {
    const bySheet = (out[sheet] ??= new Map())
    if (!bySheet.has(key)) bySheet.set(key, new Set())
    bySheet.get(key)!.add(where)
  }
  for (const f of functions) {
    if (['updateTaskFields_', 'updateProjectFields_', 'updateMemberFields_', 'updateRowFields_', 'appendRowByHeaders_'].includes(f.name)) continue
    // updateTaskFields(id, {...}) など
    for (const m of f.body.matchAll(/\b(updateTaskFields_|updateProjectFields_|updateMemberFields_)\([^,]+,\s*/g)) {
      keysOfArgument(f.body, m.index! + m[0].length).forEach((k) => add(WRITER_SHEET[m[1]], k, f.name))
    }
    // updateRowFields(SHEET_X, id, {...}) / appendRowByHeaders(sheet, SHEET_X, {...})
    for (const m of f.body.matchAll(/\b(?:updateRowFields_\((SHEET_\w+),[^,]+,|appendRowByHeaders_\(\w+,\s*(SHEET_\w+),)\s*/g)) {
      keysOfArgument(f.body, m.index! + m[0].length).forEach((k) => add(SHEET_BY_CONST[m[1] || m[2]], k, f.name))
    }
    // 1つのシートだけを扱う関数の、列の位置の探し方(headers.indexOf('列'))と、
    // 見出しに合わせて行を組み立てる処理(headers.map の case 'x' / h === 'x')
    const touched = new Set<string>()
    for (const m of f.body.matchAll(/(?:getSheet_|getSheetByName)\((SHEET_\w+)\)/g)) touched.add(SHEET_BY_CONST[m[1]])
    for (const m of f.body.matchAll(/\b(ensure\w+Sheet_|getMemberEmailsSheet_)\(\)/g)) if (ENSURE_SHEET[m[1]]) touched.add(ENSURE_SHEET[m[1]])
    if (touched.size === 1) {
      const sheet = [...touched][0]
      for (const m of f.body.matchAll(/headers\.indexOf\('([a-z_][a-z0-9_]*)'\)/g)) add(sheet, m[1], `${f.name}(indexOf)`)
      if (/headers\.map\(/.test(f.body)) {
        for (const m of f.body.matchAll(/case '([a-z_][a-z0-9_]*)':|\bh === '([a-z_][a-z0-9_]*)'/g)) add(sheet, m[1] || m[2], `${f.name}(row)`)
      }
    }
  }
  return out
}

const writes = collectWrites()

describe('シートの列の一覧(SHEET_HEADERS)', () => {
  it('すべてのシートの一覧があり、列名に重複が無い', () => {
    expect(Object.keys(gas.SHEET_HEADERS).sort()).toEqual(
      ['Candidates', 'DailyReports', 'Expenses', 'FormSubmissions', 'MemberEmails', 'Members', 'OrgStore', 'PersonalStore', 'Projects', 'Settings', 'Tasks', 'TasksArchive'],
    )
    for (const [sheet, headers] of Object.entries(gas.SHEET_HEADERS)) {
      expect(new Set(headers).size, sheet).toBe(headers.length)
      expect(headers[0], sheet).toBe(sheet === 'Settings' ? 'key' : 'id')
    }
  })

  it('保留の理由の列がある(タスクを保留にすると書き込む)', () => {
    expect(gas.SHEET_HEADERS.Tasks).toEqual(expect.arrayContaining(['hold_reason_note', 'hold_reason_since']))
  })

  it('確認の仕組みが書き込みを見つけられている(空振りしていない)', () => {
    expect(writes.Tasks.get('hold_reason_note')).toBeDefined()
    expect(writes.Tasks.get('status')).toBeDefined()
    expect(writes.Members.get('survey_responses_json')).toBeDefined()
    expect(writes.Projects.get('health_override')).toBeDefined()
    expect(writes.Expenses.get('rejection_reason')).toBeDefined()
    expect(writes.FormSubmissions.get('answers_json')).toBeDefined()
    expect(writes.DailyReports.get('issues_text')).toBeDefined()
    expect(writes.Candidates.get('interview_notes')).toBeDefined()
    expect(writes.MemberEmails.get('email')).toBeDefined()
    expect(writes.Settings.get('value')).toBeDefined()
  })

  it('GAS が書き込む列(使う列)は、すべて一覧にある', () => {
    const missing: string[] = []
    for (const [sheet, keys] of Object.entries(writes)) {
      for (const [key, where] of keys) {
        if (!gas.SHEET_HEADERS[sheet]?.includes(key)) missing.push(`${sheet}.${key} (${[...where].join(', ')})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('行は列名で追加する(列の順番を前提にした配列では追加しない)', () => {
    const appends = [...CODE_GS.matchAll(/\.appendRow\(([^)]*)/g)].map((m) => m[1].trim())
    // 見出しの作成と、見出しに合わせて組み立てた行だけ
    for (const arg of appends) expect(arg).toMatch(/^(requiredHeaders|headers|row|headers\.map\(function \(h\))/)
    for (const f of functions.filter((fn) => /\.appendRow\(row\)/.test(fn.body))) {
      expect(f.body, f.name).toMatch(/var row = headers\.map\(/)
    }
  })

  it('読み取りの権限表(READ_POLICY)の列は、一覧とちょうど同じ', () => {
    for (const sheet of ['Members', 'Projects', 'Tasks']) {
      expect(Object.keys(gas.READ_POLICY[sheet].columns).sort(), sheet).toEqual([...gas.SHEET_HEADERS[sheet]].sort())
    }
  })

  it('画面が読む列(lib/ohsumi/remote.ts)は、すべて一覧にある', () => {
    const remote = readFileSync(join(ROOT, 'lib', 'ohsumi', 'remote.ts'), 'utf8')
    const section = (from: string, to: string) => remote.slice(remote.indexOf(from), remote.indexOf(to, remote.indexOf(from)))
    const read = {
      Members: section('function mapMemberRow', 'function mapProjectRow'),
      Projects: section('function mapProjectRow', 'function mapTaskRow'),
      Tasks: section('function mapTaskRow', 'function parseJsonArray'),
    }
    for (const [sheet, text] of Object.entries(read)) {
      const cols = [...new Set([...text.matchAll(/\br\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]))]
      expect(cols.length, sheet).toBeGreaterThan(3)
      expect(cols.filter((c) => !gas.SHEET_HEADERS[sheet].includes(c)), sheet).toEqual([])
    }
  })
})

describe('appendRowByHeaders_', () => {
  function fakeSheet(headers: string[]) {
    const rows: unknown[][] = [headers]
    return {
      rows,
      getLastRow: () => rows.length,
      getLastColumn: () => headers.length,
      getRange: (r: number, c: number, nr = 1, nc = 1) => ({
        getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setNumberFormat() { return this },
      }),
      appendRow: (row: unknown[]) => rows.push(row),
    }
  }

  it('シートの実際の列の順番に合わせて並べる(列が後から足された古いシートでもずれない)', () => {
    const g = loadGas()
    const sheet = fakeSheet(['id', 'member_id', 'created_at', 'type', 'report_date', 'done_text', 'todo_text', 'issues_text'])
    ;(g.appendRowByHeaders_ as (s: unknown, n: string, o: Record<string, unknown>) => void)(sheet, 'DailyReports', {
      id: 'r1', member_id: 'm1', type: 'daily', report_date: '2026-09-28', done_text: 'd', todo_text: 't', issues_text: 'i', created_at: 'now',
    })
    expect(sheet.rows[1]).toEqual(['r1', 'm1', 'now', 'daily', '2026-09-28', 'd', 't', 'i'])
  })

  it('一覧に無い列名はエラーにする', () => {
    const g = loadGas()
    const sheet = fakeSheet(['id', 'email'])
    expect(() =>
      (g.appendRowByHeaders_ as (s: unknown, n: string, o: Record<string, unknown>) => void)(sheet, 'MemberEmails', { id: 'm1', mail: 'x' }),
    ).toThrow(/列が見つかりません: mail/)
    expect(sheet.rows).toHaveLength(1)
  })
})
