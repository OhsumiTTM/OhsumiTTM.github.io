// 画面の1回の操作から続けて呼ばれた書き込みを、1回の通信(GAS の batch)にまとめて送ること
// (lib/ohsumi/gas-transport.ts)。例: タスクの日程の変更は、変更の記録(updateHistory)を開始日・期限の
// それぞれで送り、続けて updateSchedule を送る(lib/ohsumi/store.tsx の updateSchedule・appendHistory)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BATCH_MAX_OPS, READ_ACTIONS, UNBATCHED_WRITE_ACTIONS, isBatchableWrite, sendToGas, setGasTransportDepsForTest } from './gas-transport'

const URL = 'https://script.google.com/macros/s/TEST/exec'
const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Body = Record<string, unknown> & { action: string; ops?: (Record<string, unknown> & { action: string })[] }

function harness(reply: (body: Body, n: number) => unknown) {
  const sent: Body[] = []
  const logs: string[] = []
  let ids = 0
  setGasTransportDepsForTest({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Body
      sent.push(body)
      await new Promise((r) => setTimeout(r, 1))
      const out = reply(body, sent.length)
      return { status: 200, text: async () => (typeof out === 'string' ? out : JSON.stringify(out)) }
    },
    resourceTimings: () => [],
    sleep: async () => {},
    log: { info: (t: string) => logs.push(t), warn: (t: string) => logs.push(t), error: (t: string) => logs.push(t) },
    newId: () => `req-${++ids}`,
  })
  return { sent, logs }
}

afterEach(() => setGasTransportDepsForTest(null))

// GAS の batch と同じ形で、操作ごとに結果を返す
const okBatch = (body: Body) =>
  body.action === 'batch'
    ? { ok: true, result: { results: body.ops!.map((op) => ({ ok: true, result: { did: op.action } })) }, session: { token: 'new', exp: 9 } }
    : { ok: true, result: { did: body.action } }

const session = { sessionToken: 's1', clientVersion: 3 }

describe('書き込みをまとめて送る', () => {
  it('日程の変更(変更の記録2件 + updateSchedule)は、同じタスクの記録を1つにして、1回で送る', async () => {
    const h = harness(okBatch)
    const h1 = [{ id: 'a', field: 'deadline' }]
    const h2 = [{ id: 'b', field: 'startDate' }, ...h1]
    const results = await Promise.all([
      sendToGas(URL, { action: 'updateHistory', taskId: 't1', history: h1, ...session }),
      sendToGas(URL, { action: 'updateHistory', taskId: 't1', history: h2, ...session }),
      sendToGas(URL, { action: 'updateSchedule', taskId: 't1', startDate: '2026-10-01', deadline: '2026-10-10', ...session }),
    ])
    expect(h.sent).toHaveLength(1)
    const batch = h.sent[0]
    expect(batch.action).toBe('batch')
    // 変更の記録は配列を丸ごと置き換えるので、最後のもの(前の記録を含む)だけを送る
    expect(batch.ops!.map((o) => o.action)).toEqual(['updateHistory', 'updateSchedule'])
    expect(batch.ops![0].history).toEqual(h2)
    // セッションと画面の版は、まとめた本体に1回だけ入れる
    expect(batch.sessionToken).toBe('s1')
    expect(batch.clientVersion).toBe(3)
    expect(batch.ops![0].sessionToken).toBeUndefined()
    expect(batch.requestId).toBeTruthy()
    // 結果は操作ごとに分けて返す(送らなかった記録には、送った記録と同じ結果)
    expect(results.map((r) => r.result)).toEqual([{ did: 'updateHistory' }, { did: 'updateHistory' }, { did: 'updateSchedule' }])
    expect(results.every((r) => r.ok && r.session?.token === 'new')).toBe(true)
    expect(h.logs[0]).toContain('GAS batch(updateHistory+updateSchedule)')
  })

  it('別のタスクの記録は、どちらも送る', async () => {
    const h = harness(okBatch)
    await Promise.all([
      sendToGas(URL, { action: 'updateHistory', taskId: 't1', history: [], ...session }),
      sendToGas(URL, { action: 'updateHistory', taskId: 't2', history: [], ...session }),
    ])
    expect(h.sent[0].ops!.map((o) => o.taskId)).toEqual(['t1', 't2'])
  })

  it('操作ごとの断り(forbidden)・失敗は、その操作にだけ返す', async () => {
    harness((body) => ({
      ok: true,
      result: { results: [{ ok: true, result: 1 }, { ok: false, error: '管理者のみ', forbidden: true }] },
    }))
    const [a, b] = await Promise.all([
      sendToGas(URL, { action: 'updateProgress', taskId: 't1', ...session }),
      sendToGas(URL, { action: 'updateSchedule', taskId: 't1', ...session }),
    ])
    expect(a).toMatchObject({ ok: true, result: 1 })
    expect(b).toMatchObject({ ok: false, error: '管理者のみ', forbidden: true })
  })

  it('batch 全体が断られた時(セッションが無効など)は、どの操作にも同じ応答を返す', async () => {
    harness(() => ({ ok: false, error: 'ログインの有効期限が切れました', authError: true }))
    const rs = await Promise.all([
      sendToGas(URL, { action: 'updateProgress', ...session }),
      sendToGas(URL, { action: 'updateSchedule', ...session }),
    ])
    expect(rs.every((r) => r.ok === false && r.authError === true)).toBe(true)
  })

  it('応答が返らなければ、同じ batch(同じ requestId)を送り直す', async () => {
    const h = harness((body, n) => (n === 1 ? '<html>error</html>' : okBatch(body)))
    await Promise.all([sendToGas(URL, { action: 'updateProgress', ...session }), sendToGas(URL, { action: 'updateSchedule', ...session })])
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toEqual(h.sent[0])
  })

  it('前の書き込みを送っている間に呼ばれた書き込みは、次の1回にまとめる', async () => {
    const h = harness(okBatch)
    const first = sendToGas(URL, { action: 'createTasks', ...session })
    // createTasks を送り始めるまで待つ(次のタスクで送り始める)
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.sent.map((b) => b.action)).toEqual(['createTasks'])
    const rest = [sendToGas(URL, { action: 'updateProgress', ...session }), sendToGas(URL, { action: 'updateComments', ...session })]
    await Promise.all([first, ...rest])
    expect(h.sent.map((b) => b.action)).toEqual(['createTasks', 'batch'])
    expect(h.sent[1].ops!.map((o) => o.action)).toEqual(['updateProgress', 'updateComments'])
  })

  it('1件だけなら、これまでどおりそのまま送る', async () => {
    const h = harness(okBatch)
    const r = await sendToGas(URL, { action: 'updateSchedule', ...session })
    expect(h.sent.map((b) => b.action)).toEqual(['updateSchedule'])
    expect(r.result).toEqual({ did: 'updateSchedule' })
  })

  it('アップロード・ロックを取らない操作・別のセッションの書き込みは、まとめない', async () => {
    const h = harness(okBatch)
    await Promise.all([
      sendToGas(URL, { action: 'uploadExpenseReceipt', ...session }),
      sendToGas(URL, { action: 'revokeMySessions', ...session }),
      sendToGas(URL, { action: 'updateProgress', ...session }),
      sendToGas(URL, { action: 'updateComments', sessionToken: 'other', clientVersion: 3 }),
    ])
    expect(h.sent.map((b) => b.action)).toEqual(['uploadExpenseReceipt', 'revokeMySessions', 'updateProgress', 'updateComments'])
  })

  it('まとめない書き込みを挟んだ時は、その前後をまとめず、呼ばれた順に送る', async () => {
    const h = harness(okBatch)
    await Promise.all([
      sendToGas(URL, { action: 'updateProgress', ...session }),
      sendToGas(URL, { action: 'uploadExpenseReceipt', ...session }),
      sendToGas(URL, { action: 'updateComments', ...session }),
      sendToGas(URL, { action: 'updateSchedule', ...session }),
    ])
    expect(h.sent.map((b) => b.action)).toEqual(['updateProgress', 'uploadExpenseReceipt', 'batch'])
    expect(h.sent[2].ops!.map((o) => o.action)).toEqual(['updateComments', 'updateSchedule'])
  })

  it(`まとめるのは ${BATCH_MAX_OPS} 件まで(GAS の上限と同じ)`, async () => {
    const h = harness(okBatch)
    await Promise.all(Array.from({ length: BATCH_MAX_OPS + 3 }, (_, i) => sendToGas(URL, { action: 'updateProgress', taskId: 't' + i, ...session })))
    expect(h.sent.map((b) => b.ops?.length ?? 1)).toEqual([BATCH_MAX_OPS, 3])
    expect(CODE_GS).toContain(`var BATCH_MAX_OPS = ${BATCH_MAX_OPS}`)
  })

  it('GAS がロックを取らない操作(LOCK_EXEMPT_ACTIONS)は、読み取りか、まとめない書き込みのどちらか', () => {
    const list = CODE_GS.slice(CODE_GS.indexOf('var LOCK_EXEMPT_ACTIONS = ['), CODE_GS.indexOf(']', CODE_GS.indexOf('var LOCK_EXEMPT_ACTIONS = [')))
    const exempt = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1])
    expect(exempt.length).toBeGreaterThan(5)
    expect(exempt.filter((a) => isBatchableWrite(a))).toEqual([])
    for (const a of exempt) expect(READ_ACTIONS.has(a) || UNBATCHED_WRITE_ACTIONS.has(a), a).toBe(true)
  })
})

describe('GAS を更新する前に画面だけ新しくなった時', () => {
  it('古い GAS が batch を断ったら、1本ずつ送り直し、以後はまとめない', async () => {
    const h = harness((body) =>
      body.action === 'batch' ? { ok: false, error: 'この操作は代表または管理者のみ実行できます。(未分類のaction: batch)', forbidden: true } : { ok: true, result: body.action },
    )
    const rs = await Promise.all([sendToGas(URL, { action: 'updateProgress', ...session }), sendToGas(URL, { action: 'updateSchedule', ...session })])
    expect(rs.map((r) => r.result)).toEqual(['updateProgress', 'updateSchedule'])
    expect(h.sent.map((b) => b.action)).toEqual(['batch', 'updateProgress', 'updateSchedule'])
    // 以後はまとめない
    await Promise.all([sendToGas(URL, { action: 'updateComments', ...session }), sendToGas(URL, { action: 'updateProgress', ...session })])
    expect(h.sent.map((b) => b.action).slice(3)).toEqual(['updateComments', 'updateProgress'])
    expect(h.logs.some((l) => l.includes('GAS を更新してください'))).toBe(true)
  })
})
