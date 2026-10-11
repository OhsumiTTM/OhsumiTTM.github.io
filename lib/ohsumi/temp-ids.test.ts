// 作ったばかりのタスク(仮の ID)への書き込みと、読み込みの途中の書き込み(lib/ohsumi/temp-ids.ts・remote.ts)
//   - 仮の ID のタスクへの書き込みは、createTasks の応答を待ち、本当の ID で送る。作成に失敗したら送らない
//   - 読み込み(getInitialData)を待つ間に書き込みを送った時は、その応答で画面を上書きしない
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTestOrg } from './test-org'

type Remote = typeof import('./remote')
type Body = Record<string, unknown> & { action: string; ops?: (Record<string, unknown> & { action: string })[] }

let remote: Remote
let tempIds: typeof import('./temp-ids')
let sent: Body[]
// 操作ごとの応答。Promise を返せば、それが解決するまで応答を止める
let reply: (body: Body) => unknown | Promise<unknown>

beforeEach(async () => {
  vi.resetModules()
  await useTestOrg('https://script.example/exec')
  sent = []
  reply = () => ({ ok: true, result: {} })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Body
      sent.push(body)
      const out =
        body.action === 'batch'
          ? { ok: true, result: { results: await Promise.all(body.ops!.map(async (op) => await reply(op))) } }
          : await reply(body)
      return { text: async () => JSON.stringify(out) }
    }),
  )
  remote = await import('./remote')
  tempIds = await import('./temp-ids')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// 送った操作(まとめて送ったものは中の操作)
const actions = () => sent.flatMap((b) => (b.action === 'batch' ? b.ops! : [b]))

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}

const payload = (tempId: string) => ({ tempId, title: '新しいタスク', projectId: 'p1', department: 'd', category: 'c', skills: [], difficulty: 'beginner' as const, priority: 'medium' as const, deadline: null })

describe('仮の ID のタスクへの書き込み', () => {
  it('createTasks の応答を待ってから、本当の ID で送る(続けて送ったコメントの差分も本当の ID の一覧で作る)', async () => {
    const g = gate()
    reply = async (b) => {
      if (b.action === 'createTasks') {
        await g.p
        return { ok: true, result: [{ tempId: 't-new', id: '42' }] }
      }
      return { ok: true, result: {} }
    }
    const created = remote.remoteApi.createTasks([payload('t-new')])
    const priority = remote.remoteApi.updatePriority('t-new', 'high')
    const comment = remote.remoteApi.addComment('t-new', { id: 'c1', text: 'はじめのコメント', byId: 'm1', at: '2026-10-11' })
    await new Promise((r) => setTimeout(r, 20))
    // 作成の応答まで、変更は送らない
    expect(actions().map((a) => a.action)).toEqual(['createTasks'])
    g.open()
    await Promise.all([created, priority, comment])
    const later = actions().filter((a) => a.action !== 'createTasks')
    expect(later.map((a) => [a.action, a.taskId])).toEqual([
      ['updatePriority', '42'],
      ['updateComments', '42'],
    ])
    expect(tempIds.currentTaskId('t-new')).toBe('42')
    // 本当の ID に差し替えた後の書き込みは、仮の ID で送った一覧を基準にする(同じコメントを送り直さない)
    await remote.remoteApi.addComment('42', { id: 'c2', text: '次のコメント', byId: 'm1', at: '2026-10-11' })
    expect(actions().at(-1)).toMatchObject({ action: 'updateComments', taskId: '42', listOps: [{ op: 'add', entry: { id: 'c2' } }] })
  })

  it('作成に失敗したら、待っていた書き込みは送らずに失敗にする', async () => {
    reply = (b) => (b.action === 'createTasks' ? { ok: false, error: '作れませんでした' } : { ok: true, result: {} })
    const created = remote.remoteApi.createTasks([payload('t-bad')])
    const priority = remote.remoteApi.updatePriority('t-bad', 'high')
    await expect(created).rejects.toThrow('作れませんでした')
    await expect(priority).rejects.toBeInstanceOf(tempIds.TempTaskCreateFailedError)
    expect(actions().map((a) => a.action)).toEqual(['createTasks'])
  })

  it('仮の ID でない書き込みは、待たずにそのまま送る', () => {
    const p = { taskId: '7', priority: 'high' }
    expect(tempIds.resolveTempIdsIn(p)).toBe(p)
  })

  it('swapTaskIds は、タスクの ID とほかのタスクの dependsOnIds を差し替える', () => {
    const tasks = [
      { id: 't-a', dependsOnIds: [] as string[] },
      { id: 't-b', dependsOnIds: ['t-a', '3'] },
      { id: '3' },
    ]
    expect(tempIds.swapTaskIds(tasks, new Map([['t-a', '10'], ['t-b', '11']]))).toEqual([
      { id: '10', dependsOnIds: [] },
      { id: '11', dependsOnIds: ['10', '3'] },
      { id: '3' },
    ])
  })
})

const initial = (title: string) => ({
  ok: true,
  result: {
    memberId: '1',
    version: `v-${title}`,
    sheets: {
      Members: { headers: ['id', 'name'], rows: [['1', 'A']] },
      Projects: { headers: ['id', 'name'], rows: [] },
      Tasks: { headers: ['id', 'title', 'project_id'], rows: [['5', title, 'p1']] },
      Settings: { headers: ['key', 'value'], rows: [] },
    },
  },
})

describe('読み込みの途中の書き込み', () => {
  it('読み込みを待つ間に書き込みを送ったら、その応答は使わずに読み込み直す', async () => {
    const g = gate()
    let reads = 0
    reply = async (b) => {
      if (b.action !== 'getInitialData') return { ok: true, result: {} }
      reads++
      if (reads === 1) {
        await g.p
        return initial('古い')
      }
      return initial('新しい')
    }
    const loading = remote.fetchInitialData()
    await new Promise((r) => setTimeout(r, 10))
    await remote.remoteApi.updatePriority('5', 'high').catch(() => {})
    g.open()
    const res = await loading
    expect(reads).toBe(2)
    expect(res.data?.tasks[0]?.name).toBe('新しい')
  })

  it('書き込みが続く時は、前に読み込んだ内容があれば、画面を変えない(unchanged)', async () => {
    reply = async (b) => {
      if (b.action !== 'getInitialData') return { ok: true, result: {} }
      // 応答を返す前に、毎回書き込みが入る
      void remote.remoteApi.updatePriority('5', 'low')
      await new Promise((r) => setTimeout(r, 5))
      return initial('古い')
    }
    const res = await remote.fetchInitialData('v-known')
    expect(res).toEqual({ memberId: '1', unchanged: true })
  })

  it('書き込みが無ければ、1回で読み込む', async () => {
    let reads = 0
    reply = (b) => {
      if (b.action === 'getInitialData') reads++
      return b.action === 'getInitialData' ? initial('今') : { ok: true, result: {} }
    }
    const res = await remote.fetchInitialData()
    expect(reads).toBe(1)
    expect(res.data?.tasks[0]?.name).toBe('今')
  })
})
