// gas/Code.gs の選択肢の値の扱い: 読む時はどちらの形式でもコードにそろえ、
// 書く時は VALUE_FORMAT が codes になるまで日本語で書く。移行の後は、版の無い
// (古いタブからの)リクエストを断る
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Fn = (...args: unknown[]) => unknown
type Gas = Record<string, Fn> & { resetRequestProps: () => void }

function loadGas(props: Record<string, string> = {}): Gas {
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: (k: string) => props[k] ?? null }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text: string) => ({ text, setMimeType() { return this } }),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  return ctx as unknown as Gas
}

const legacy = loadGas()
const coded = loadGas({ VALUE_FORMAT: 'codes' })

// 値を JSON を通して比べる(vm の中で作ったオブジェクトを、そのまま比べられる形にする)
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('書く時の形式(sheetCode)', () => {
  it('移行前は、コード・日本語のどちらを受け取っても日本語で書く', () => {
    expect(legacy.sheetCode('status', 'done')).toBe('完了')
    expect(legacy.sheetCode('status', '完了')).toBe('完了')
    expect(legacy.sheetCode('importance', 'external')).toBe('対外公開')
    expect(legacy.sheetCode('visibility', undefined)).toBe('全員')
    expect(legacy.sheetCode('department', '')).toBe('未分類')
    expect(legacy.sheetCode('department', '独自の部門')).toBe('独自の部門')
  })

  it('移行後(VALUE_FORMAT=codes)は、どちらを受け取ってもコードで書く', () => {
    expect(coded.sheetCode('status', '完了')).toBe('done')
    expect(coded.sheetCode('priority', '高')).toBe('high')
    expect(coded.sheetCode('department', '未分類')).toBe('')
    expect(coded.sheetCode('scheduleAnswer', '○')).toBe('yes')
  })

  it('設定の JSON(テンプレート・定期タスク・スキルの閾値)も、同じ規則で書く', () => {
    const templates = JSON.stringify({ イベント: [{ id: 'a', name: '会場', department: 'event', difficulty: 'beginner', priority: 'high', skills: [] }] })
    expect(JSON.parse(legacy.sheetSettingValue('project_templates', templates) as string)).toEqual({
      イベント: [{ id: 'a', name: '会場', department: 'イベント', difficulty: '新人歓迎', priority: '高', skills: [] }],
    })
    const rules = JSON.stringify([{ id: 'r', department: '運営', difficulty: '誰でも可', priority: '中', triggerOnStatus: 'done', active: true }])
    expect(JSON.parse(coded.sheetSettingValue('recurring_rules', rules) as string)).toEqual([
      { id: 'r', department: 'ops', difficulty: 'anyone', priority: 'medium', triggerOnStatus: 'done', active: true },
    ])
    const sets = JSON.stringify([{ id: 's', name: 'セット', items: [{ id: 'i', department: '', difficulty: 'advanced', priority: 'low' }] }])
    expect(JSON.parse(legacy.sheetSettingValue('task_set_templates', sets) as string)).toEqual([
      { id: 's', name: 'セット', items: [{ id: 'i', department: '未分類', difficulty: '上級者向け', priority: '低' }] },
    ])
    expect(JSON.parse(legacy.sheetSettingValue('skill_level_thresholds', '{"_default":120,"デザイン":150}') as string)).toEqual({ デフォルト: 120, デザイン: 150 })
    expect(JSON.parse(coded.sheetSettingValue('skill_level_thresholds', '{"デフォルト":120}') as string)).toEqual({ _default: 120 })
    // 対象外の設定・壊れた JSON はそのまま
    expect(legacy.sheetSettingValue('org_name', 'テスト')).toBe('テスト')
    expect(legacy.sheetSettingValue('project_templates', '{壊れた')).toBe('{壊れた')
  })

  it('スキルの閾値の既定値は、「デフォルト」・_default のどちらでも読む', () => {
    expect(legacy.defaultSkillThreshold({ デフォルト: 150 })).toBe(150)
    expect(legacy.defaultSkillThreshold({ _default: 80 })).toBe(80)
    expect(legacy.defaultSkillThreshold({})).toBe(100)
  })
})

describe('リクエストの値をコードにそろえる(normalizeRequestCodes)', () => {
  it('古いタブ(日本語)と新しいタブ(コード)の値が、同じコードになる', () => {
    for (const body of [
      { action: 'updateTaskDetails', department: 'デザイン', difficulty: '経験者向け', priority: '低', visibility: '幹部', importance: '重要' },
      { action: 'updateTaskDetails', department: 'design', difficulty: 'experienced', priority: 'low', visibility: 'leaders', importance: 'important' },
    ]) {
      legacy.normalizeRequestCodes(body)
      expect(body).toMatchObject({ department: 'design', difficulty: 'experienced', priority: 'low', visibility: 'leaders', importance: 'important' })
    }
    const status = { action: 'updateTaskStatus', status: '確認待ち' }
    legacy.normalizeRequestCodes(status)
    expect(status.status).toBe('review')
  })

  it('ほかのアクションの同じ名前の値(候補者の状態など)には触れない', () => {
    const body = { action: 'updateCandidate', status: 'interview', priority: '高' }
    legacy.normalizeRequestCodes(body)
    expect(body).toEqual({ action: 'updateCandidate', status: 'interview', priority: '高' })
  })

  it('変更の記録・日程調整・権限の例外の中の値もそろえる', () => {
    const body = {
      action: 'updateHistory',
      history: [
        { id: 'h1', field: 'status', from: '未着手', to: '進行中' },
        { id: 'h2', field: 'title', from: '高', to: '低' },
      ],
    }
    legacy.normalizeRequestCodes(body)
    expect(plain(body.history)).toEqual([
      { id: 'h1', field: 'status', from: 'todo', to: 'progress' },
      { id: 'h2', field: 'title', from: '高', to: '低' },
    ])
    const schedule = { action: 'updateTaskSchedule', schedule: { candidates: [], responses: { m1: { c1: '○', c2: '×' } } } }
    legacy.normalizeRequestCodes(schedule)
    expect(plain(schedule.schedule.responses)).toEqual({ m1: { c1: 'yes', c2: 'no' } })
    const overrides = { action: 'updatePermissionOverrides', overrides: [{ targetType: 'department', targetId: '広報', access: 'edit' }, { targetType: 'task', targetId: '広報', access: 'edit' }] }
    legacy.normalizeRequestCodes(overrides)
    expect(plain(overrides.overrides)).toEqual([
      { targetType: 'department', targetId: 'pr', access: 'edit' },
      { targetType: 'task', targetId: '広報', access: 'edit' },
    ])
  })
})

describe('古いタブの拒否(clientVersion)', () => {
  it('移行前は、版の無いリクエストも受け付ける', () => {
    expect(legacy.checkClientVersion({ action: 'getInitialData' })).toBeNull()
  })

  it('移行後は、版の無い(古い)リクエストを、再読み込みを促して断る', () => {
    const coded2 = loadGas({ VALUE_FORMAT: 'codes' })
    expect(coded2.checkClientVersion({ action: 'getInitialData' })).toMatch(/再読み込み/)
    expect(coded2.checkClientVersion({ action: 'getInitialData', clientVersion: 0 })).toMatch(/再読み込み/)
    expect(coded2.checkClientVersion({ action: 'getInitialData', clientVersion: coded2.MIN_CLIENT_VERSION })).toBeNull()
    // doPost の入口で、認証より前に断る(ログインは消さない)
    const out = coded2.doPost({ postData: { contents: JSON.stringify({ action: 'updateTaskStatus', sessionToken: 'x', status: '完了' }) } }) as { text: string }
    const res = JSON.parse(out.text)
    expect(res).toMatchObject({ ok: false, reloadRequired: true })
    expect(res.authError).toBeUndefined()
  })
})

describe('権限の判定は、どちらの形式の行でも同じ', () => {
  const viewer = { id: 'm-general', isAdminRole: false }
  const admin = { id: 'm-admin', isAdminRole: true }

  it('幹部限定・承認待ちのタスクの行(canViewTaskRow)', () => {
    const rows = [
      [{ visibility: '幹部' }, { visibility: 'leaders' }],
      [{ visibility: '全員' }, { visibility: 'all' }],
      [{ approval_status: '承認待ち', creator_id: 'x' }, { approval_status: 'pending', creator_id: 'x' }],
      [{ approval_status: '承認待ち', creator_id: 'm-general' }, { approval_status: 'pending', creator_id: 'm-general' }],
      [{ approval_status: '承認済み' }, { approval_status: 'approved' }],
    ]
    for (const [oldRow, newRow] of rows) {
      for (const v of [viewer, admin]) {
        expect(legacy.canViewTaskRow(v, newRow), JSON.stringify(newRow)).toBe(legacy.canViewTaskRow(v, oldRow))
      }
    }
    expect(legacy.canViewTaskRow(viewer, { visibility: 'leaders' })).toBe(false)
    expect(legacy.canViewTaskRow(viewer, { approval_status: 'pending', creator_id: 'x' })).toBe(false)
  })

  it('部門を対象にした権限の例外は、部門名・部門IDのどちらでも同じ部門として扱う', () => {
    const grant = (targetId: string, department: string) =>
      legacy.overridesGrant([{ targetType: 'department', targetId, access: 'edit' }], { department }, 1)
    expect(grant('広報', '広報')).toBe(true)
    expect(grant('pr', '広報')).toBe(true)
    expect(grant('広報', 'pr')).toBe(true)
    expect(grant('pr', 'デザイン')).toBe(false)
  })

  it('変更の記録: シートが日本語でも、コードで送られた同じ記録は「変更なし」と見なす', () => {
    const oldHistory = [{ id: 'h1', at: '2026-09-01', byId: 'm2', field: 'status', from: '未着手', to: '進行中' }]
    const task = { history_json: JSON.stringify(oldHistory) }
    const acting = { id: 'm1', role: '一般', permission_overrides: [] }
    const body = {
      action: 'updateHistory',
      history: [
        { id: 'h2', at: '2026-09-02', byId: 'm1', field: 'status', from: 'progress', to: 'review' },
        { id: 'h1', at: '2026-09-01', byId: 'm2', field: 'status', from: 'todo', to: 'progress' },
      ],
    }
    legacy.normalizeRequestCodes(body)
    const gas = loadGas({})
    ;(gas as unknown as { SpreadsheetApp: unknown }).SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: () => null }) }
    expect(() => gas.validateHistoryUpdate(task, body.history, acting)).not.toThrow()
    // 他の人の記録を書き換えたら拒否する(従来どおり)
    const tampered = [body.history[0], { ...body.history[1], to: 'done' }]
    expect(() => gas.validateHistoryUpdate(task, tampered, acting)).toThrow(/変更・削除/)
    // シートに書く時は移行前の形式にする
    expect(plain(legacy.sheetHistoryEntry(body.history[0]))).toMatchObject({ from: '進行中', to: '確認待ち' })
  })
})

describe('通知の文面', () => {
  it('日程調整の回答は、記号・コードのどちらでも同じ表示名にする', () => {
    expect(legacy.notifyLabel('scheduleAnswer', 'ja', '○')).toBe('○')
    expect(legacy.notifyLabel('scheduleAnswer', 'ja', 'yes')).toBe('○')
    expect(legacy.notifyLabel('scheduleAnswer', 'en', 'maybe')).toBe('△')
  })
})

describe('サンプルのデータ(seedSampleData)', () => {
  it('タスクの行は、今のシートの形式で書く', () => {
    const row = { id: 'sample-t-1', status: '確認待ち', priority: '高', visibility: '幹部', approval_status: '承認待ち', department: 'デザイン', title: '高',
      history_json: JSON.stringify([{ id: 'h', field: 'status', from: '未着手', to: '進行中' }]) }
    expect(plain(coded.sheetSampleTaskRow(row))).toMatchObject({ status: 'review', priority: 'high', visibility: 'leaders', approval_status: 'pending', department: 'design', title: '高',
      history_json: JSON.stringify([{ id: 'h', field: 'status', from: 'todo', to: 'progress' }]) })
    expect(plain(legacy.sheetSampleTaskRow(row))).toEqual(row)
  })
})
