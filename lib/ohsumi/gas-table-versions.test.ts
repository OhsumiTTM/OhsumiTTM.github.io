// gas/Code.gs: 表ごとの版。関係の無い書き込み・編集で、ほかの表のキャッシュを捨てないこと。
// 権限の判定に使うメンバー・役職(スナップショット)は、メンバーや役職の変更で確実に作り直されること
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { analyze } from '../../scripts/gas-write-tables.mjs'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

function setup() {
  const props: Record<string, string> = { DATA_VERSION: 's0', TABLE_VERSION_expenses: 'e0', TABLE_VERSION_formSubmissions: 'f0', TABLE_VERSION_candidates: 'c0', MEMBER_EMAILS_VERSION: 'm0' }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, getAll: () => ({}), putAll() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { flush() {} },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026-10-01' },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.authenticateRequest = () => ({ memberId: 'm1', renewed: null })
  c.getActingMember = () => ({ id: 'm1', role: 'top', project_ids: [], permission_overrides: [] })
  c.authorizeAction = () => {}
  // 書き込みの中身は呼ばない(版の変わり方だけを見る)
  for (const f of ['updateTaskFields', 'submitExpenseApplication', 'updateMemberFields', 'addCandidate', 'setMemberEmail', 'notifyReview', 'requireKnownRole', 'assertTopRemains', 'sheetRoleRef', 'removeMember', 'rejectFormSubmission']) {
    c[f] = () => ({ ok: true })
  }
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown> & { LOCK_EXEMPT_ACTIONS: string[]; TABLE_WRITE_ACTIONS: Record<string, string[]>; SNAPSHOT_UNTOUCHED_ACTIONS: string[] }
  const post = (body: object) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: JSON.stringify(body) } }).text)
  const snap = () => ({ snapshot: props.DATA_VERSION, expenses: props.TABLE_VERSION_expenses, formSubmissions: props.TABLE_VERSION_formSubmissions, candidates: props.TABLE_VERSION_candidates, emails: props.MEMBER_EMAILS_VERSION })
  return { gas, props, post, snap }
}

function changed(before: Record<string, string>, after: Record<string, string>) {
  return Object.keys(before).filter((k) => before[k] !== after[k]).sort()
}

describe('アプリからの書き込み', () => {
  it('タスクの書き込みは、スナップショットの版だけを変える(経費・フォームの回答・候補者のキャッシュは残る)', () => {
    const t = setup()
    const before = t.snap()
    expect(t.post({ action: 'updateTaskStatus', sessionToken: 's', taskId: 't1', status: 'doing' }).ok).toBe(true)
    expect(changed(before, t.snap())).toEqual(['snapshot'])
  })

  it('経費の申請は、経費の版を変える', () => {
    const t = setup()
    const before = t.snap()
    t.post({ action: 'submitExpenseApplication', sessionToken: 's', application: {} })
    expect(changed(before, t.snap())).toContain('expenses')
    expect(changed(before, t.snap())).not.toContain('candidates')
  })

  it('候補者の追加は、候補者の版だけを変える', () => {
    const t = setup()
    const before = t.snap()
    t.post({ action: 'addCandidate', sessionToken: 's', candidate: {} })
    expect(changed(before, t.snap())).toEqual(['candidates'])
  })

  it('メンバーの削除・役職・部門の変更は、スナップショット(権限の判定に使うメンバー・役職)の版を必ず変える', () => {
    for (const action of ['removeMember', 'updateRole', 'updateRoles', 'updateMemberDepartmentPath', 'updatePermissionOverrides', 'updateMemberProjects', 'addMember']) {
      expect(setup().gas.SNAPSHOT_UNTOUCHED_ACTIONS, action).not.toContain(action)
    }
    const t = setup()
    const before = t.snap()
    t.post({ action: 'updateRole', sessionToken: 's', memberId: 'm2', role: 'base' })
    expect(changed(before, t.snap())).toContain('snapshot')
  })

  it('一覧は、Code.gs を調べた結果(操作が書くかもしれない表)を必ず含む。新しい操作を足した時に、ここで気付ける', () => {
    const t = setup()
    const written = analyze(CODE_GS) as Record<string, string[]>
    const exempt = new Set(t.gas.LOCK_EXEMPT_ACTIONS)
    const missing: string[] = []
    for (const [action, tables] of Object.entries(written)) {
      if (exempt.has(action)) continue
      for (const table of ['expenses', 'formSubmissions', 'candidates']) {
        if (tables.includes(table) && !t.gas.TABLE_WRITE_ACTIONS[table].includes(action)) missing.push(`${action} → ${table}`)
      }
      if (tables.includes('snapshot') && t.gas.SNAPSHOT_UNTOUCHED_ACTIONS.includes(action)) missing.push(`${action} → snapshot`)
    }
    expect(missing).toEqual([])
    // 調べ方が働いていること(経費・候補者・スナップショットに書く代表的な操作を見つける)
    expect(written.submitExpenseApplication).toContain('expenses')
    expect(written.addCandidate).toContain('candidates')
    expect(written.updateRole).toContain('snapshot')
  })
})

describe('スプレッドシートの直接の編集', () => {
  const edit = (t: ReturnType<typeof setup>, sheet: string) => t.gas.onSpreadsheetEdit({ range: { getSheet: () => ({ getName: () => sheet }) } })

  it('セルの編集は、編集したシートの版だけを変える', () => {
    const cases: [string, string[]][] = [
      ['Members', ['snapshot']],
      ['Settings', ['snapshot']],
      ['Tasks', ['snapshot']],
      ['Expenses', ['expenses']],
      ['FormSubmissions', ['formSubmissions']],
      ['Candidates', ['candidates']],
      ['MemberEmails', ['emails']],
    ]
    for (const [sheet, expected] of cases) {
      const t = setup()
      const before = t.snap()
      edit(t, sheet)
      expect(changed(before, t.snap()), sheet).toEqual(expected)
    }
  })

  it('知らないシート・シートが分からない編集は、すべての版を変える', () => {
    for (const e of [{ range: { getSheet: () => ({ getName: () => 'SomethingNew' }) } }, {}]) {
      const t = setup()
      const before = t.snap()
      t.gas.onSpreadsheetEdit(e)
      expect(changed(before, t.snap())).toEqual(['candidates', 'emails', 'expenses', 'formSubmissions', 'snapshot'])
    }
  })

  it('変更検知(onChange): 編集トリガーがあればセルの編集は任せ、行の追加・削除などはすべての版を変える', () => {
    const t = setup()
    t.props.EDIT_TRIGGER_INSTALLED = 'true'
    let before = t.snap()
    t.gas.onSpreadsheetChange({ changeType: 'EDIT' })
    expect(changed(before, t.snap())).toEqual([])
    before = t.snap()
    t.gas.onSpreadsheetChange({ changeType: 'REMOVE_ROW' })
    expect(changed(before, t.snap())).toEqual(['candidates', 'emails', 'expenses', 'formSubmissions', 'snapshot'])
    // 編集トリガーが無い団体(setupOhsumi を実行し直していない)は、編集もすべて変える
    const old = setup()
    before = old.snap()
    old.gas.onSpreadsheetChange({ changeType: 'EDIT' })
    expect(changed(before, old.snap())).toHaveLength(5)
  })

  it('setupOhsumi が編集トリガー(onSpreadsheetEdit)を作る', () => {
    expect(CODE_GS).toMatch(/ScriptApp\.newTrigger\('onSpreadsheetEdit'\)\.forSpreadsheet\(ss\)\.onEdit\(\)\.create\(\)/)
    expect(CODE_GS).toMatch(/setProperty\('EDIT_TRIGGER_INSTALLED', 'true'\)/)
  })
})
