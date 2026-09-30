// gas/Code.gs の採用の候補者(getCandidates)とフォームの回答(getFormSubmissions)の読み取りを、
// メモリ上の簡易なスプレッドシートで確かめる。権限の無い人に返らないことを固定する。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

class FakeSheet {
  constructor(public rows: unknown[][]) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()) }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? '')),
    }
  }
}

type Acting = { id: string; role: string; project_ids: string[]; permission_overrides: { targetType: string; targetId: string; access: string }[] }
const acting = (id: string, role: string, overrides: Acting['permission_overrides'] = []): Acting => ({ id, role, project_ids: [], permission_overrides: overrides })

const CANDIDATE_HEADERS = ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at']

function setup(settings: Record<string, string> = {}, extraCandidateColumn = false) {
  const candidateHeaders = extraCandidateColumn ? [...CANDIDATE_HEADERS, 'secret_memo'] : CANDIDATE_HEADERS
  const candidateRow = ['c1', '候補 一郎', 'ichiro@example.com', '090-0000-0000', '履歴書の本文', '面接のメモ', 'candidate', '2026-09-01', '2026-09-02']
  const sheets: Record<string, FakeSheet> = {
    Settings: new FakeSheet([['key', 'value'], ...Object.entries(settings)]),
    Candidates: new FakeSheet([candidateHeaders, extraCandidateColumn ? [...candidateRow, '誰にも見せないメモ'] : candidateRow]),
    FormSubmissions: new FakeSheet([
      ['id', 'form_id', 'submitter_id', 'answers_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason'],
      ['s1', 'form-a', 'm-submitter', '{"item":"プロジェクター"}', '[]', '0', 'pending', '2026-09-01', ''],
      ['s2', 'form-b', 'm-other', '{"item":"延長コード"}', '[]', '0', 'pending', '2026-09-02', ''],
    ]),
  }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, getProperties: () => ({}) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null }) },
  })
  vm.runInContext(CODE_GS, ctx)
  return ctx as unknown as Record<string, (...args: unknown[]) => unknown>
}

const defaultSettings = {
  restricted_roles: '班長,会計係,フォーム係',
  role_permissions: JSON.stringify({ 班長: ['dashboard'], フォーム係: ['forms'] }),
  custom_form_defs: JSON.stringify([
    { id: 'form-a', approvalSteps: [{ id: 'st1', type: 'member', memberId: 'm-approver' }] },
    { id: 'form-b', approvalSteps: [{ id: 'st1', type: 'role', role: '会計係' }] },
  ]),
}

describe('採用の候補者(getCandidates)', () => {
  it('代表・全権管理者には、個人情報を含めて返す', () => {
    const gas = setup(defaultSettings)
    for (const a of [acting('m1', '代表'), acting('m2', '事業責任者')]) {
      expect(gas.getCandidates(a)).toEqual([
        { id: 'c1', name: '候補 一郎', email: 'ichiro@example.com', phone: '090-0000-0000', resumeText: '履歴書の本文', interviewNotes: '面接のメモ',
          status: 'candidate', createdAt: '2026-09-01', updatedAt: '2026-09-02' },
      ])
    }
  })

  it('採用の権限の例外(edit・approve)を持つ人には返す', () => {
    const gas = setup(defaultSettings)
    for (const access of ['edit', 'approve']) {
      const a = acting('m3', '一般', [{ targetType: 'recruiting', targetId: '', access }])
      expect((gas.getCandidates(a) as unknown[]).length).toBe(1)
    }
  })

  it('権限の無い人には何も返さない(一般・制限付きの管理者・閲覧だけの例外・別の種類の例外)', () => {
    const gas = setup(defaultSettings)
    const denied = [
      acting('m4', '一般'),
      acting('m5', '班長'), // restricted_roles に含まれる管理者
      acting('m6', '一般', [{ targetType: 'recruiting', targetId: '', access: 'view' }]),
      acting('m7', '一般', [{ targetType: 'project', targetId: 'p1', access: 'approve' }]),
      acting('m8', ''),
    ]
    for (const a of denied) expect(gas.getCandidates(a), a.id).toEqual([])
  })

  it('規則の無い列は、権限があっても返さない(READ_POLICY と同じ考え方)', () => {
    const gas = setup(defaultSettings, true)
    const [c] = gas.getCandidates(acting('m1', '代表')) as Record<string, unknown>[]
    expect(JSON.stringify(c)).not.toContain('誰にも見せないメモ')
    // 規則はシートの列の一覧とちょうど同じ(列を足したら規則も決める)
    const policy = (gas as unknown as { CANDIDATES_READ_POLICY: { columns: Record<string, string> } }).CANDIDATES_READ_POLICY
    const headers = (gas as unknown as { SHEET_HEADERS: Record<string, string[]> }).SHEET_HEADERS.Candidates
    expect(Object.keys(policy.columns).sort()).toEqual([...headers].sort())
  })
})

describe('フォームの回答(getFormSubmissions)', () => {
  const ids = (gas: ReturnType<typeof setup>, a: Acting) => (gas.getFormSubmissions(a) as { id: string }[]).map((s) => s.id).sort()

  it('申請者本人には、自分の回答だけを返す', () => {
    const gas = setup(defaultSettings)
    expect(ids(gas, acting('m-submitter', '一般'))).toEqual(['s1'])
  })

  it('承認ステップの担当者(指定メンバー・同じ役職)には、そのフォームの回答を返す', () => {
    const gas = setup(defaultSettings)
    expect(ids(gas, acting('m-approver', '一般'))).toEqual(['s1'])
    expect(ids(gas, acting('m-accountant', '会計係'))).toEqual(['s2'])
  })

  it('全権管理者と、フォームのセクションを許可された役職には、すべて返す', () => {
    const gas = setup(defaultSettings)
    expect(ids(gas, acting('m1', '代表'))).toEqual(['s1', 's2'])
    expect(ids(gas, acting('m2', '事業責任者'))).toEqual(['s1', 's2'])
    expect(ids(gas, acting('m9', 'フォーム係'))).toEqual(['s1', 's2'])
  })

  it('それ以外の人には返さない(一般・フォームを許可されていない制限付きの管理者)', () => {
    const gas = setup(defaultSettings)
    expect(ids(gas, acting('m4', '一般'))).toEqual([])
    expect(ids(gas, acting('m5', '班長'))).toEqual([])
  })

  it('回答の中身を画面の形で返す', () => {
    const gas = setup(defaultSettings)
    const [s] = gas.getFormSubmissions(acting('m-submitter', '一般')) as Record<string, unknown>[]
    expect(s).toEqual({ id: 's1', formId: 'form-a', submitterId: 'm-submitter', answers: { item: 'プロジェクター' }, approvals: [],
      currentStepIndex: 0, status: 'pending', createdAt: '2026-09-01', rejectionReason: undefined })
  })
})

describe('読み取りのアクション', () => {
  it('ログインしている人なら呼べる(返す行は関数の中で絞り込む)。書き込みのロックは取らない', () => {
    const gas = setup(defaultSettings)
    for (const action of ['getCandidates', 'getFormSubmissions']) {
      expect(() => gas.authorizeAction(acting('m4', '一般'), action, {}), action).not.toThrow()
      expect((gas as unknown as { LOCK_EXEMPT_ACTIONS: string[] }).LOCK_EXEMPT_ACTIONS).toContain(action)
    }
  })
})
