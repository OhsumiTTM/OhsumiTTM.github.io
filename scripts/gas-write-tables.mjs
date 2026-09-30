// gas/Code.gs を読み、doPost の操作ごとに「書き込むかもしれない表」を調べる(テストで使う)。
//
// 調べ方(多めに見積もる。見落とすよりは、関係の無い表のキャッシュを捨てる方が安全なため):
//   1. 関数ごとに、表を指す名前(SHEET_EXPENSES・ensureExpensesSheet_() など)と、書き込みの呼び出し
//      (setValue・appendRow・deleteRow・updateRowFields_ など)を持つかを見る
//   2. 表を指す名前を持ち、自分で書き込むか、書き込みの関数を呼ぶ関数を「その表に書く関数」とする
//   3. runWriteAction_(doPost が呼ぶ)の case の中から呼ばれる関数を、呼び出しをたどって集め、書く表を合わせる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TABLE_IDENTIFIERS = {
  expenses: ['SHEET_EXPENSES', 'ensureExpensesSheet_'],
  formSubmissions: ['SHEET_FORM_SUBMISSIONS', 'ensureFormSubmissionsSheet_'],
  candidates: ['SHEET_CANDIDATES', 'ensureCandidatesSheet_'],
  snapshot: ['SHEET_MEMBERS', 'SHEET_PROJECTS', 'SHEET_TASKS', 'SHEET_SETTINGS', 'updateSetting_', 'updateMemberFields_', 'updateTaskFields_', 'getSettingsSheet_'],
}
const WRITE_CALL = /\.(setValue|setValues|appendRow|deleteRow|deleteRows|insertRowAfter|insertRowBefore|insertRows|clearContent|setFormula|setNumberFormat)\(/

export function parseFunctions(code) {
  const fns = {}
  const re = /^function (\w+)\s*\(/gm
  const starts = [...code.matchAll(re)].map((m) => ({ name: m[1], index: m.index }))
  starts.forEach((s, i) => { fns[s.name] = code.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : code.length) })
  return fns
}

export function analyze(code) {
  const fns = parseFunctions(code)
  const names = Object.keys(fns)
  const calls = {}
  for (const n of names) {
    const body = fns[n].replace(/^function \w+/, '')
    calls[n] = names.filter((m) => m !== n && new RegExp('\\b' + m + '\\s*\\(').test(body))
  }
  const writer = {}
  for (const n of names) writer[n] = WRITE_CALL.test(fns[n])
  // 書き込みの関数を(呼び出しをたどって)呼ぶか
  const writesSomehow = {}
  const reachWriter = (n, seen = new Set()) => {
    if (writesSomehow[n] !== undefined) return writesSomehow[n]
    if (seen.has(n)) return false
    seen.add(n)
    const r = writer[n] || calls[n].some((m) => reachWriter(m, seen))
    writesSomehow[n] = r
    return r
  }
  names.forEach((n) => reachWriter(n))
  const direct = {}
  for (const n of names) {
    direct[n] = new Set()
    for (const [table, ids] of Object.entries(TABLE_IDENTIFIERS)) {
      if (ids.some((id) => new RegExp('\\b' + id + '\\b').test(fns[n].replace(/^function \w+/, ''))) && writesSomehow[n]) direct[n].add(table)
    }
  }
  const memo = {}
  const tablesOf = (n, seen = new Set()) => {
    if (memo[n]) return memo[n]
    if (seen.has(n)) return new Set()
    seen.add(n)
    const out = new Set(direct[n] ?? [])
    for (const m of calls[n] ?? []) for (const t of tablesOf(m, seen)) out.add(t)
    memo[n] = out
    return out
  }
  // doPost が呼ぶ runWriteAction の case ごと
  const runner = fns.runWriteAction_
  const sw = runner.slice(runner.indexOf('switch (body.action)'))
  const caseRe = /case '(\w+)':/g
  const cases = [...sw.matchAll(caseRe)]
  const result = {}
  cases.forEach((c, i) => {
    const end = i + 1 < cases.length ? cases[i + 1].index : sw.indexOf('default:')
    const body = sw.slice(c.index, end)
    const tables = new Set()
    for (const n of names) if (new RegExp('\\b' + n + '\\s*\\(').test(body)) for (const t of tablesOf(n)) tables.add(t)
    for (const [table, ids] of Object.entries(TABLE_IDENTIFIERS)) if (ids.some((id) => new RegExp('\\b' + id + '\\b').test(body))) tables.add(table)
    // 空の case(次の case と同じ処理)は、次の case の結果を使う
    result[c[1]] = { body, tables }
  })
  const actions = Object.keys(result)
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i]
    if (!/\S/.test(result[a].body.replace(/case '\w+':/, '')) && i + 1 < actions.length) result[a].tables = result[actions[i + 1]].tables
  }
  return Object.fromEntries(actions.map((a) => [a, [...result[a].tables].sort()]))
}

if (process.argv[1] && process.argv[1].endsWith('gas-write-tables.mjs')) {
  const code = readFileSync(join(process.cwd(), 'gas', 'Code.gs'), 'utf8')
  const r = analyze(code)
  for (const t of ['expenses', 'formSubmissions', 'candidates']) console.log(t + ':', Object.keys(r).filter((a) => r[a].includes(t)).join(' '))
  console.log('no snapshot:', Object.keys(r).filter((a) => !r[a].includes('snapshot')).join(' '))
}
