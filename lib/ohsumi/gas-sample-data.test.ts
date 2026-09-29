// gas/Code.gs の画面確認用のサンプルのデータ(seedSampleData / deleteSampleData)を確かめる。
// 作るデータの中身(buildSampleData)と、メモリ上の簡易なスプレッドシート・Drive での作成・削除。
import { DEFAULT_ROLE_LEVELS } from './roles'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { mapRemoteData, parseSettings } from './remote'

const ROOT = join(__dirname, '..', '..')
const CODE_GS = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')
const TODAY = '2026-09-28'

type Row = Record<string, string>
type SampleData = {
  sheets: Record<string, Row[]>
  settings: {
    lists: Record<string, string[]>
    items: Record<string, { id: string }[]>
    values: Record<string, unknown[]>
    maps: Record<string, Record<string, unknown>>
    scalars: Record<string, string>
  }
}

// ---- メモリ上の簡易なスプレッドシート・Drive ----

class FakeSheet {
  constructor(public name: string, public rows: unknown[][] = []) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return Math.max(0, ...this.rows.map((r) => r.length)) }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    const self = this
    return {
      getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => self.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
      setValues(values: unknown[][]) {
        values.forEach((v, r) => {
          const target = (self.rows[row - 1 + r] ??= [])
          v.forEach((x, c) => { target[col - 1 + c] = x })
        })
        return this
      },
      setValue(v: unknown) { (self.rows[row - 1] ??= [])[col - 1] = v; return this },
      setNumberFormat() { return this },
    }
  }
  appendRow(row: unknown[]) { this.rows.push([...row]) }
  deleteRows(row: number, count: number) { this.rows.splice(row - 1, count) }
}

function setup(props: Record<string, string>, initial: Record<string, unknown[][]> = {}) {
  const sheets: Record<string, FakeSheet> = {}
  for (const [name, rows] of Object.entries(initial)) sheets[name] = new FakeSheet(name, rows.map((r) => [...r]))
  const files: { id: string; name: string; trashed: boolean; sharing?: string; mime: string }[] = []
  let fileSeq = 0
  const makeFileHandle = (f: (typeof files)[number]) => ({
    getId: () => f.id,
    getName: () => f.name,
    setName: (n: string) => { f.name = n },
    setSharing: (access: string) => { f.sharing = access },
    setTrashed: (t: boolean) => { f.trashed = t },
    getUrl: () => `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
  })
  const folder = {
    createFile: (blob: { mime: string }) => {
      const f = { id: `FILE${String(++fileSeq).padStart(12, '0')}`, name: 'x', trashed: false, mime: blob.mime }
      files.push(f)
      return makeFileHandle(f)
    },
    getFiles: () => {
      const list = files.filter((f) => !f.trashed)
      let i = 0
      return { hasNext: () => i < list.length, next: () => makeFileHandle(list[i++]) }
    },
  }
  const store: Record<string, string> = { UPLOAD_FOLDER_ID: 'folder', ...props }
  const logs: string[] = []
  const context = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push('WARN ' + m), error: (m: string) => logs.push('ERR ' + m) },
    Logger: { log: () => undefined },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => store[k] ?? null,
        setProperty: (k: string, v: string) => { store[k] = v },
        deleteProperty: (k: string) => { delete store[k] },
        getProperties: () => ({ ...store }),
      }),
    },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => undefined, remove: () => undefined, removeAll: () => undefined }) },
    LockService: { getScriptLock: () => ({ waitLock: () => undefined, tryLock: () => true, releaseLock: () => undefined }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      formatDate: () => TODAY,
      base64Decode: (s: string) => Buffer.from(s, 'base64'),
      newBlob: (_data: unknown, mime: string) => ({ mime, getAs: (m: string) => ({ mime: m }) }),
      getUuid: () => 'uuid',
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { NONE: 'NONE', VIEW: 'VIEW' },
      getFolderById: () => folder,
      getFileById: (id: string) => {
        const f = files.find((x) => x.id === id)
        if (!f) throw new Error('not found')
        return makeFileHandle(f)
      },
    },
    SpreadsheetApp: {
      flush: () => undefined,
      getActiveSpreadsheet: () => ({
        getSheetByName: (name: string) => sheets[name] ?? null,
        insertSheet: (name: string) => (sheets[name] = new FakeSheet(name)),
      }),
    },
  })
  vm.runInContext(CODE_GS, context)
  const gas = context as unknown as Record<string, (...args: unknown[]) => unknown> & {
    SHEET_HEADERS: Record<string, string[]>
    SAMPLE_ACCOUNT_SLOTS: Record<string, string>
    SAMPLE_LIST_DEFAULTS: Record<string, string[]>
  }
  const records = (name: string): Row[] => {
    const s = sheets[name]
    if (!s || s.rows.length < 1) return []
    const [h, ...rest] = s.rows
    return rest.map((r) => Object.fromEntries(h.map((k, i) => [String(k), String(r[i] ?? '')])))
  }
  const settings = () => Object.fromEntries(records('Settings').map((r) => [r.key, r.value]))
  return { gas, sheets, store, files, logs, records, settings }
}

const base = setup({})
const data = base.gas.buildSampleData(TODAY, {
  avatar1: 'https://lh3.googleusercontent.com/d/AVATAR000000001=w256-h256-c',
  org_logo: 'https://lh3.googleusercontent.com/d/LOGO00000000001=w256-h256-c',
  receipt_png: 'https://drive.google.com/file/d/RECEIPT00000001/view',
  receipt_pdf: 'https://drive.google.com/file/d/RECEIPT00000002/view',
  survey_image: 'https://lh3.googleusercontent.com/d/SURVEY000000001=w512-h512-c',
}) as SampleData
const S = data.sheets
const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86400000

describe('サンプルのデータの中身', () => {
  it('すべての行の列はシートの一覧にあり、id は sample- で始まり重複しない', () => {
    for (const [sheet, rows] of Object.entries(S)) {
      expect(rows.length, sheet).toBeGreaterThan(0)
      for (const r of rows) {
        expect(Object.keys(r).filter((k) => !base.gas.SHEET_HEADERS[sheet].includes(k)), sheet).toEqual([])
        expect(r.id.startsWith('sample-'), `${sheet} ${r.id}`).toBe(true)
      }
      expect(new Set(rows.map((r) => r.id)).size, sheet).toBe(rows.length)
    }
    expect(S.Members).toHaveLength(20)
    expect(S.Projects).toHaveLength(8)
    expect(S.Tasks.length).toBeGreaterThanOrEqual(140)
    expect(S.Tasks.length).toBeLessThanOrEqual(160)
  })

  it('JSON の列はすべて読める', () => {
    for (const [sheet, rows] of Object.entries(S)) {
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (k.endsWith('_json') && v) expect(() => JSON.parse(v), `${sheet}.${k} ${r.id}`).not.toThrow()
        }
      }
    }
  })

  it('id の参照はすべてサンプルの中にある', () => {
    const members = new Set(S.Members.map((m) => m.id))
    const projects = new Set(S.Projects.map((p) => p.id))
    const tasks = new Set(S.Tasks.map((t) => t.id))
    const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
    for (const m of S.Members) {
      for (const ref of [m.reports_to_id, m.mentor_id].filter(Boolean)) expect(members.has(ref), m.id).toBe(true)
      for (const p of list(m.project_ids ?? '')) expect(projects.has(p)).toBe(true)
    }
    for (const p of S.Projects) {
      expect(members.has(p.owner_id)).toBe(true)
      for (const x of list(p.member_ids)) expect(members.has(x)).toBe(true)
      if (p.parent_id) expect(projects.has(p.parent_id)).toBe(true)
    }
    for (const t of S.Tasks) {
      expect(projects.has(t.project_id), t.id).toBe(true)
      for (const x of [...list(t.assignee_id), ...list(t.reviewer_ids ?? ''), ...list(t.open_bid_applicant_ids ?? '')]) expect(members.has(x), t.id).toBe(true)
      if (t.creator_id) expect(members.has(t.creator_id)).toBe(true)
      for (const x of list(t.depends_on_ids ?? '')) expect(tasks.has(x)).toBe(true)
      if (t.related_review_task_id) expect(tasks.has(t.related_review_task_id)).toBe(true)
    }
    const cats = new Set(data.settings.items.expense_categories.map((c) => c.id))
    for (const e of S.Expenses) {
      expect(members.has(e.applicant_id)).toBe(true)
      expect(cats.has(e.category_id)).toBe(true)
    }
    const forms = new Set(data.settings.items.custom_form_defs.map((f) => f.id))
    for (const f of S.FormSubmissions) expect(forms.has(f.form_id)).toBe(true)
    const questions = new Set(data.settings.items.survey_questions.map((q) => q.id))
    for (const m of S.Members.filter((x) => x.survey_responses_json)) {
      for (const r of JSON.parse(m.survey_responses_json)) for (const q of Object.keys(r.answers)) expect(questions.has(q)).toBe(true)
    }
  })

  it('日付は実行した日を基準にする(期限切れ・今日締切・来月開始・アーカイブ)', () => {
    for (const today of ['2026-09-28', '2027-03-01']) {
      const tasks = (base.gas.buildSampleData(today, {}) as SampleData).sheets.Tasks
      const open = tasks.filter((t) => t.status !== '完了')
      expect(open.some((t) => t.due_date && days(t.due_date, today) < 0), today).toBe(true)
      expect(open.some((t) => t.due_date === today && t.due_time), today).toBe(true)
      expect(open.some((t) => t.due_date && days(t.due_date, today) > 0 && days(t.due_date, today) <= 7), today).toBe(true)
      expect(open.some((t) => t.start_date && days(t.start_date, today) >= 28), today).toBe(true)
      const done = tasks.filter((t) => t.status === '完了')
      expect(done.every((t) => t.completed_date && days(t.completed_date, today) < 0), today).toBe(true)
      expect(done.some((t) => days(today, t.completed_date) < 14), today).toBe(true)
      expect(done.some((t) => days(today, t.completed_date) >= 14), today).toBe(true)
    }
  })

  it('メンバーに個性がある(豊富・ほぼ空・休止中・英語表示・長い名前)', () => {
    const byId = Object.fromEntries(S.Members.map((m) => [m.id, m]))
    expect(byId['sample-m-01'].role).toBe('代表')
    expect(JSON.parse(byId['sample-m-01'].career_history_json).length).toBeGreaterThan(1)
    expect(byId['sample-m-01'].avatar_url).toContain('lh3.googleusercontent.com')
    expect(byId['sample-m-07'].will_tags).toBe('')
    expect(byId['sample-m-07'].career_history_json ?? '').toBe('')
    expect(byId['sample-m-08'].inactive).toBe('TRUE')
    expect(byId['sample-m-06'].locale).toBe('en')
    expect(byId['sample-m-09'].name.length).toBeGreaterThan(20)
    // 枠のメンバーの役職
    expect(byId[base.gas.SAMPLE_ACCOUNT_SLOTS.admin].role).toBe('事業責任者')
    expect(byId[base.gas.SAMPLE_ACCOUNT_SLOTS.restricted].role).toBe('サンプル班長')
    expect(byId[base.gas.SAMPLE_ACCOUNT_SLOTS.base].role).toBe('一般')
    expect(byId[base.gas.SAMPLE_ACCOUNT_SLOTS.base_en].locale).toBe('en')
    // メールアドレスはサンプルのデータに含めない(テスト用のアカウントだけ別に登録する)
    expect(JSON.stringify(S.Members)).not.toMatch(/@[a-z0-9-]+\.[a-z]/i)
  })

  it('極端な例・英語の文章・定期タスクから作られたように見えるタスクがある', () => {
    const comments = S.Tasks.map((t) => (t.comments_json ? JSON.parse(t.comments_json).length : 0))
    expect(Math.max(...comments)).toBeGreaterThanOrEqual(150)
    expect(Math.max(...S.Tasks.map((t) => t.assignee_id.split(',').filter(Boolean).length))).toBeGreaterThanOrEqual(12)
    expect(Math.max(...S.Tasks.map((t) => t.title.length))).toBeGreaterThan(60)
    expect(S.Tasks.some((t) => t.assignee_id === 'sample-m-06' && /^[A-Za-z]/.test(t.title))).toBe(true)
    const rules = data.settings.items.recurring_rules as unknown as { name: string; active: boolean }[]
    expect(rules.every((r) => r.active === false)).toBe(true)
    const generated = S.Tasks.filter((t) => t.title === rules[0].name && t.creator_id === '')
    expect(generated.length).toBeGreaterThanOrEqual(3)
  })

  it('機能ごとのデータがある(公募・承認待ち・幹部限定・確認・依存・保留・日程調整・フォーム)', () => {
    const t = S.Tasks
    expect(t.some((x) => !x.assignee_id && x.open_bid_applicant_ids)).toBe(true)
    expect(t.filter((x) => x.approval_status === '承認待ち').map((x) => x.importance).sort()).toEqual(['一般', '対外公開', '重要'])
    expect(t.some((x) => x.visibility === '幹部')).toBe(true)
    expect(t.some((x) => x.status === '確認待ち' && x.review_approvals_json)).toBe(true)
    expect(t.some((x) => x.related_review_task_id)).toBe(true)
    expect(t.some((x) => (x.depends_on_ids ?? '').includes(','))).toBe(true)
    expect(t.some((x) => x.status === '保留' && x.hold_reason_note)).toBe(true)
    expect(t.some((x) => x.blocker_note)).toBe(true)
    expect(t.some((x) => x.schedule_json)).toBe(true)
    expect(t.some((x) => x.form_json)).toBe(true)
    expect(t.some((x) => x.retrospective_json && x.deliverables_json)).toBe(true)
    expect(new Set(S.Expenses.map((e) => e.status))).toEqual(new Set(['pending', 'approved', 'rejected', 'returned', 'withdrawn']))
    expect(S.Expenses.some((e) => e.receipt_url.includes('RECEIPT00000002'))).toBe(true)
  })

  it('推薦のために、普通のタスクのスキルは担当者の Will・Judgment と重なる', () => {
    const tags = Object.fromEntries(S.Members.map((m) => [m.id, `${m.will_tags},${m.judgment_tags}`.split(',').filter(Boolean)]))
    const regular = S.Tasks.filter((t) => /(\d+)\)$/.test(t.title) && t.assignee_id)
    expect(regular.length).toBeGreaterThan(80)
    for (const t of regular) expect(t.skills.split(',').some((s) => tags[t.assignee_id].includes(s)), t.title).toBe(true)
    // Fact(実績)のため、完了したタスクにポイントが付いている
    expect(regular.filter((t) => t.status === '完了' && t.awarded_points_json).length).toBeGreaterThan(20)
  })

  it('画面の読み込み(remote.ts)でそのまま読める', () => {
    const result = mapRemoteData(S.Members, S.Projects, S.Tasks)
    expect(result.members).toHaveLength(20)
    const hold = result.tasks.find((t) => t.status === 'hold' && t.holdReason)
    expect(hold?.holdReason?.note).toBeTruthy()
    const merged = base.gas.mergeSampleSettings({}, data.settings) as { values: Record<string, string> }
    const settings = parseSettings(Object.entries(merged.values).map(([key, value]) => ({ key, value })))
    expect(settings.roles.map((r) => r.name)).toEqual(expect.arrayContaining(['一般', '代表', '班長', '事業責任者', 'サンプル班長']))
    expect(settings.roles.filter((r) => r.restricted).map((r) => r.name)).toEqual(['サンプル班長'])
    expect(settings.quizDefinitions).toHaveLength(1)
    expect(settings.orgLogoUrl).toContain('LOGO')
  })
})

describe('Settings の追加と元に戻す処理', () => {
  const additions = data.settings

  it('空の設定に足して、削除すると空に戻る', () => {
    const merged = base.gas.mergeSampleSettings({}, additions) as { values: Record<string, string>; state: unknown }
    // 空の一覧は、画面の既定値に足す(既定値が消えないように)
    expect(merged.values.skill_options.split(',')).toEqual([...base.gas.SAMPLE_LIST_DEFAULTS.skill_options, 'データ分析'])
    const restored = base.gas.restoreSampleSettings(merged.values, merged.state) as Record<string, string>
    for (const v of Object.values(restored)) expect(v).toBe('')
  })

  it('既存の設定は変えずに足し、削除すると元の値に戻る。サンプルを入れた後に画面で足した設定は残す', () => {
    const current = {
      skill_options: 'デザイン,経理',
      recurring_rules: JSON.stringify([{ id: 'real-1', name: '本物の定期タスク' }]),
      role_permissions: JSON.stringify({ 班長: ['dashboard'] }),
      one_on_one_questions: JSON.stringify(['本物の質問']),
      org_name: '本物の団体',
      theme_color: '',
    }
    const merged = base.gas.mergeSampleSettings(current, additions) as { values: Record<string, string>; state: unknown }
    expect(merged.values.skill_options).toBe('デザイン,経理,データ分析')
    expect(JSON.parse(merged.values.recurring_rules)[0].id).toBe('real-1')
    expect(JSON.parse(merged.values.role_permissions).班長).toEqual(['dashboard'])
    expect(merged.values.org_name).toBe('サンプル団体')
    // 画面で足した設定
    const after = { ...merged.values }
    after.skill_options += ',新しいスキル'
    after.recurring_rules = JSON.stringify([...JSON.parse(after.recurring_rules), { id: 'real-2', name: '後から足した定期タスク' }])
    const restored = base.gas.restoreSampleSettings(after, merged.state) as Record<string, string>
    expect(restored.skill_options).toBe('デザイン,経理,新しいスキル')
    expect(JSON.parse(restored.recurring_rules).map((r: { id: string }) => r.id)).toEqual(['real-1', 'real-2'])
    expect(JSON.parse(restored.role_permissions)).toEqual({ 班長: ['dashboard'] })
    expect(JSON.parse(restored.one_on_one_questions)).toEqual(['本物の質問'])
    expect(restored.org_name).toBe('本物の団体')
    expect(restored.theme_color).toBe('')
  })

  it('一覧の既定値は、フロント(store.tsx)の既定値と同じ', () => {
    const store = readFileSync(join(ROOT, 'lib', 'ohsumi', 'store.tsx'), 'utf8')
    const arr = (name: string) => {
      const m = store.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\])`))
      return new Function(`return ${m![1]}`)() as string[]
    }
    expect(base.gas.SAMPLE_LIST_DEFAULTS.skill_options).toEqual(arr('DEFAULT_SKILL_OPTIONS'))
    expect(base.gas.SAMPLE_LIST_DEFAULTS.category_options).toEqual(arr('DEFAULT_CATEGORY_OPTIONS'))
    expect(base.gas.SAMPLE_LIST_DEFAULTS.skill_field_options).toEqual(arr('DEFAULT_SKILL_FIELD_OPTIONS'))
    // 役職の既定は roles.ts(GAS の DEFAULT_ROLE_LEVELS も同じ)
    expect(base.gas.SAMPLE_LIST_DEFAULTS.role_levels).toEqual(DEFAULT_ROLE_LEVELS)
    expect([...(base.gas as unknown as { DEFAULT_ROLE_LEVELS: string[] }).DEFAULT_ROLE_LEVELS]).toEqual(DEFAULT_ROLE_LEVELS)
  })
})

describe('テスト用のアカウント(TEST_ACCOUNTS)', () => {
  const parse = (raw: string) => base.gas.parseSampleTestAccounts(raw)

  it('枠ごとのアドレスを読む', () => {
    expect(parse('top=A@gmail.com, admin=b@gmail.com\nrestricted=c@gmail.com, base=d@gmail.com, base_en=e@gmail.com')).toEqual({
      top: 'a@gmail.com', admin: 'b@gmail.com', restricted: 'c@gmail.com', base: 'd@gmail.com', base_en: 'e@gmail.com',
    })
    expect(parse('')).toEqual({})
  })

  it('知らない枠・正しくないアドレス・重複はエラー', () => {
    expect(() => parse('代表=a@gmail.com')).toThrow(/知らない枠の名前/)
    expect(() => parse('top=not-an-email')).toThrow(/正しくありません/)
    expect(() => parse('top=a@gmail.com, top=b@gmail.com')).toThrow(/同じ枠/)
    expect(() => parse('top=a@gmail.com, base=a@gmail.com')).toThrow(/同じメールアドレス/)
  })

  it('サンプル以外のメンバーに登録されているアドレスはエラー(サンプルのメンバーなら問題ない)', () => {
    const accounts = parse('top=a@gmail.com')
    expect(() => base.gas.assertSampleAccountsUnregistered(accounts, [['12', 'x@gmail.com, A@gmail.com']])).toThrow(/サンプル以外のメンバー/)
    expect(() => base.gas.assertSampleAccountsUnregistered(accounts, [['sample-m-01', 'a@gmail.com']])).not.toThrow()
  })
})

describe('サンプルのデータの作成と削除', () => {
  const realRows = () => ({
    Members: [['id', 'name', 'role'], ['1', '本物の代表', '代表']],
    Tasks: [['id', 'title', 'creator_id'], ['100', '本物のタスク', '1']],
    MemberEmails: [['id', 'email'], ['1', 'real@gmail.com']],
    Settings: [['key', 'value'], ['org_name', '本物の団体'], ['skill_options', 'デザイン,経理']],
  })

  it('テスト環境でなければ動かない', () => {
    const t = setup({}, realRows())
    expect(() => t.gas.seedSampleData()).toThrow(/テスト環境ではない/)
    expect(() => t.gas.deleteSampleData()).toThrow(/テスト環境ではない/)
  })

  it('サンプル以外のメンバーのアドレスを指定すると、何も作らずに止まる', () => {
    const t = setup({ TEST_ENVIRONMENT: 'true', TEST_ACCOUNTS: 'top=real@gmail.com' }, realRows())
    expect(() => t.gas.seedSampleData()).toThrow(/サンプル以外のメンバー/)
    expect(t.records('Members')).toHaveLength(1)
  })

  it('作成して、何度実行しても重複せず、削除で元に戻る', () => {
    const t = setup({ TEST_ENVIRONMENT: 'true', TEST_ACCOUNTS: 'top=a@gmail.com, base_en=e@gmail.com', discord_webhook_url: 'https://discord.com/api/webhooks/1/x' }, realRows())
    t.gas.seedSampleData()
    const members = t.records('Members').length
    const tasks = t.records('Tasks').length
    expect(members).toBe(21)
    expect(tasks).toBeGreaterThan(140)
    // テスト用のアカウントだけ登録する
    expect(t.records('MemberEmails')).toEqual([
      { id: '1', email: 'real@gmail.com' },
      { id: 'sample-m-01', email: 'a@gmail.com' },
      { id: 'sample-m-06', email: 'e@gmail.com' },
    ])
    // ダミー画像は非公開で保存する
    expect(t.files.filter((f) => !f.trashed)).toHaveLength(8)
    expect(t.files.every((f) => f.sharing === 'PRIVATE')).toBe(true)
    expect(t.files.find((f) => f.name.startsWith('expense_receipt_sample_pdf_'))?.mime).toBe('application/pdf')
    expect(t.settings().org_name).toBe('サンプル団体')
    expect(t.settings().org_logo_url).toMatch(/lh3\.googleusercontent\.com\/d\/FILE/)
    expect(t.logs.some((l) => l.startsWith('WARN') && l.includes('TEST_ALLOW_CHAT'))).toBe(true)

    // 2回目: 消してから作り直す(重複しない)
    t.gas.seedSampleData()
    expect(t.records('Members')).toHaveLength(members)
    expect(t.records('Tasks')).toHaveLength(tasks)
    expect(t.records('MemberEmails')).toHaveLength(3)
    expect(t.files.filter((f) => !f.trashed)).toHaveLength(8)

    // テスト用のアカウントで操作して増えた行(サンプルのメンバーが作ったもの)も消す
    t.sheets.Tasks.appendRow(t.sheets.Tasks.rows[0].map((h) => (h === 'id' ? '101' : h === 'creator_id' ? 'sample-m-05' : '')))

    t.gas.deleteSampleData()
    expect(t.records('Members')).toEqual([{ id: '1', name: '本物の代表', role: '代表', ...Object.fromEntries(t.gas.SHEET_HEADERS.Members.slice(3).map((h) => [h, ''])) }])
    expect(t.records('Tasks').map((r) => r.id)).toEqual(['100'])
    expect(t.records('MemberEmails')).toEqual([{ id: '1', email: 'real@gmail.com' }])
    for (const name of ['Projects', 'Expenses', 'FormSubmissions', 'DailyReports', 'Candidates']) expect(t.records(name), name).toEqual([])
    expect(t.files.every((f) => f.trashed)).toBe(true)
    expect(t.settings().org_name).toBe('本物の団体')
    expect(t.settings().skill_options).toBe('デザイン,経理')
    expect(t.settings().recurring_rules).toBe('')
    expect(t.store.SAMPLE_SETTINGS_STATE).toBeUndefined()
  })
})
