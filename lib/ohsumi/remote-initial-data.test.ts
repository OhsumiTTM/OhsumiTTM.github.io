// fetchInitialData: GAS の getInitialData の応答(見出し+行の配列)を、以前の
// 公開CSV読み込みと同じ Member / Project / Task / 設定の形に変換できること
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Remote = typeof import('./remote')
let remote: Remote
let lastBody: Record<string, unknown> | null = null

function mockGas(result: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      lastBody = JSON.parse(init.body)
      return { text: async () => JSON.stringify({ ok: true, result }) }
    }),
  )
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_GAS_URL', 'https://script.example/exec')
  remote = await import('./remote')
  lastBody = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('fetchInitialData', () => {
  it('GAS の応答を画面で使う形に変換する(値の前後の空白も除く)', async () => {
    mockGas({
      memberId: '2',
      version: 'v1',
      sheets: {
        Members: {
          headers: ['id', 'name', 'role', 'project_ids', 'will_tags', 'evaluation_history_json'],
          rows: [
            ['1', ' 代表さん ', '代表', '', '企画, 広報', '[{"date":"2026-01-01"}]'],
            // 閲覧権限のない列は空で届く
            ['2', '一般さん', '一般', 'p1', '', ''],
          ],
        },
        Projects: { headers: ['id', 'name', 'archived'], rows: [['p1', 'プロジェクト1', 'FALSE']] },
        Tasks: {
          headers: ['id', 'title', 'project_id', 'status', 'visibility', 'approval_status'],
          rows: [['10', 'タスク', 'p1', '進行中', 'all', '']],
        },
        Settings: {
          headers: ['key', 'value'],
          rows: [
            ['org_name', 'テスト団体'],
            ['restricted_roles', '班長'],
            ['survey_invited_ids', '__not_invited__'],
          ],
        },
      },
    })
    const res = await remote.fetchInitialData()
    expect(lastBody?.action).toBe('getInitialData')
    expect(res.memberId).toBe('2')
    expect(res.version).toBe('v1')
    const [boss, me] = res.data!.members
    expect(boss.name).toBe('代表さん')
    expect(boss.will).toEqual(['企画', '広報'])
    expect(boss.evaluationHistory).toEqual([{ date: '2026-01-01' }])
    expect(me.evaluationHistory).toBeUndefined()
    expect(me.affiliation).toBe('プロジェクト1')
    expect(res.data!.projects[0]).toMatchObject({ id: 'p1', archived: false })
    expect(res.data!.tasks[0]).toMatchObject({
      id: '10',
      name: 'タスク',
      status: 'progress',
      visibility: 'all',
      pendingApproval: false,
    })
    expect(res.settings!.orgName).toBe('テスト団体')
    expect(res.settings!.restrictedRoles).toEqual(['班長'])
    // 一般に届く「対象外」の値は、どのメンバーIDとも一致しない
    expect(res.settings!.surveyInvitedIds).toEqual(['__not_invited__'])
  })

  it('前回の版を送り、変わっていなければ中身を受け取らない', async () => {
    mockGas({ memberId: '2', version: 'v1', unchanged: true })
    const res = await remote.fetchInitialData('v1')
    expect(lastBody?.knownVersion).toBe('v1')
    expect(res).toEqual({ memberId: '2', version: 'v1', unchanged: true })
  })

  it('登録されていないアカウントでは memberId が null になる', async () => {
    mockGas({ memberId: null })
    const res = await remote.fetchInitialData()
    expect(res.memberId).toBeNull()
    expect(res.data).toBeUndefined()
  })
})
