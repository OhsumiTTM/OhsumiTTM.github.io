// GAS への送り方(lib/ohsumi/gas-transport.ts): 1本ずつ順番に送ること、JSON が返らなかった時の
// 再試行、書き込みの requestId、コンソールへの記録を確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ATTEMPT_TIMEOUT_MS,
  GasTransportError,
  READ_ACTIONS,
  attemptTimeoutOf,
  bodySnippet,
  safeResponseUrl,
  RETRY_DELAYS_MS,
  isWriteAction,
  priorityOf,
  sendToGas,
  setGasTransportDepsForTest,
} from './gas-transport'

const URL = 'https://script.google.com/macros/s/TEST/exec'

type Reply = { status?: number; text?: string; throws?: string }
const json = (v: unknown): Reply => ({ status: 200, text: JSON.stringify(v) })
const echo404: Reply = { status: 404, text: '<html>Sorry, unable to open the file at this time.</html>' }

function harness(replies: (body: Record<string, unknown>) => Reply | Promise<Reply>) {
  const sent: Record<string, unknown>[] = []
  const logs: { level: string; text: string }[] = []
  const sleeps: number[] = []
  let inFlight = 0
  let maxInFlight = 0
  let ids = 0
  setGasTransportDepsForTest({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      sent.push(body)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise((r) => setTimeout(r, 1))
        const r = await replies(body)
        if (r.throws) throw new TypeError(r.throws)
        return { status: r.status ?? 200, text: async () => r.text ?? '' }
      } finally {
        inFlight--
      }
    },
    sleep: async (ms) => { sleeps.push(ms) },
    log: {
      info: (t: string) => logs.push({ level: 'info', text: t }),
      warn: (t: string) => logs.push({ level: 'warn', text: t }),
      error: (t: string) => logs.push({ level: 'error', text: t }),
    },
    newId: () => `req-${++ids}`,
  })
  return { sent, logs, sleeps, maxInFlight: () => maxInFlight }
}

afterEach(() => setGasTransportDepsForTest(null))

describe('同時に送らない', () => {
  it('同時に呼んでも1本ずつ送り、画面の操作(書き込み・初期データ)を裏の読み込みより先に送る', async () => {
    const h = harness(() => json({ ok: true, result: [] }))
    // 再読み込みの後と同じ順に呼ぶ
    await Promise.all([
      sendToGas(URL, { action: 'getInitialData' }),
      sendToGas(URL, { action: 'getExpenses' }),
      sendToGas(URL, { action: 'getFormSubmissions' }),
      sendToGas(URL, { action: 'getCandidates' }),
      sendToGas(URL, { action: 'checkAndGenerateRecurringTasks' }),
      sendToGas(URL, { action: 'updateLastLogin' }),
      sendToGas(URL, { action: 'getMyEmails' }),
    ])
    expect(h.maxInFlight()).toBe(1)
    expect(h.sent.map((b) => b.action)).toEqual([
      'getInitialData', 'updateLastLogin',
      'getExpenses', 'getFormSubmissions', 'getCandidates', 'checkAndGenerateRecurringTasks', 'getMyEmails',
    ])
  })

  it('裏の読み込みの種類', () => {
    for (const a of ['getExpenses', 'getFormSubmissions', 'getCandidates', 'getMyEmails', 'checkAndGenerateRecurringTasks', 'getLoginConfig']) {
      expect(priorityOf(a), a).toBe('background')
    }
    for (const a of ['getInitialData', 'exchangeIdToken', 'updateTaskStatus', 'getFiles']) expect(priorityOf(a), a).toBe('foreground')
  })
})

describe('JSON が返らなかった時の再試行', () => {
  it('読み取りは、echo の 404 の後に少し待って送り直し、回数と原因をコンソールに記録する', async () => {
    let n = 0
    const h = harness(() => (++n === 1 ? echo404 : json({ ok: true, result: { memberId: 'm1' } })))
    const res = await sendToGas(URL, { action: 'getInitialData', sessionToken: 't' })
    expect(res).toEqual({ ok: true, result: { memberId: 'm1' } })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0].requestId).toBeUndefined()
    expect(h.sleeps).toEqual([RETRY_DELAYS_MS[0]])
    expect(h.logs.map((l) => l.level + ' ' + l.text)).toEqual([
      'warn [ohsumi] GAS getInitialData: JSON ではない応答(HTTP 404)。応答の URL: (不明)、本文の先頭: Sorry, unable to open the file at this time.',
      'warn [ohsumi] GAS getInitialData: 再試行 1/2(原因: JSON ではない応答(HTTP 404))',
      'info [ohsumi] GAS getInitialData: 再試行 1回目で成功しました',
      expect.stringMatching(/^info \[ohsumi\] GAS getInitialData: \d+ms\(列の待ち \d+ms・往復 \d+ms・2回目・GAS の内訳なし\)$/),
    ])
  })

  it('通信エラー(CORS で読めない応答など)も送り直す', async () => {
    let n = 0
    const h = harness(() => (++n < 3 ? { throws: 'Failed to fetch' } : json({ ok: true, result: [] })))
    await sendToGas(URL, { action: 'getExpenses' })
    expect(h.sleeps).toEqual(RETRY_DELAYS_MS)
    expect(h.logs.filter((l) => l.level === 'warn').map((l) => l.text)).toEqual([
      '[ohsumi] GAS getExpenses: 再試行 1/2(原因: 通信エラー(Failed to fetch))',
      '[ohsumi] GAS getExpenses: 再試行 2/2(原因: 通信エラー(Failed to fetch))',
    ])
  })

  it('書き込みには requestId を付け、送り直しても同じ ID を使う(GAS は前回の結果を返す)', async () => {
    let n = 0
    const h = harness(() => (++n === 1 ? echo404 : json({ ok: true, replayed: true, result: { id: 't1' } })))
    const res = await sendToGas(URL, { action: 'updateTaskStatus', taskId: 't1' })
    expect(res.result).toEqual({ id: 't1' })
    expect(h.sent.map((b) => b.requestId)).toEqual(['req-1', 'req-1'])
    expect(h.logs.map((l) => l.text)).toContain('[ohsumi] GAS updateTaskStatus: 前回の処理の結果を受け取りました(処理はやり直していません)')
  })

  it('別の書き込みには別の ID を付ける', async () => {
    const h = harness(() => json({ ok: true }))
    await Promise.all([sendToGas(URL, { action: 'createTasks' }), sendToGas(URL, { action: 'createTasks' })])
    expect(h.sent.map((b) => b.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('GAS が混み合っている・同じ操作を処理中(retryLater)の時も送り直す', async () => {
    let n = 0
    const h = harness(() => (++n === 1 ? json({ ok: false, retryLater: true, error: '混み合っています。' }) : json({ ok: true })))
    await sendToGas(URL, { action: 'createTasks' })
    expect(h.sent).toHaveLength(2)
    expect(h.logs[0].text).toContain('混み合っています')
  })

  it('3回送っても JSON が返らなければ、GasTransportError にして記録する', async () => {
    const h = harness(() => echo404)
    const err = await sendToGas(URL, { action: 'getInitialData' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GasTransportError)
    expect((err as GasTransportError).attempts).toBe(3)
    expect((err as Error).message).toContain('3回試しました')
    expect(h.sent).toHaveLength(3)
    expect(h.logs.at(-1)).toEqual({ level: 'error', text: '[ohsumi] GAS getInitialData: 3回送りましたが、応答を受け取れませんでした(原因: JSON ではない応答(HTTP 404))' })
  })

  it('GAS が JSON でエラーを返した時(権限がない・入力の誤りなど)は送り直さない', async () => {
    const h = harness(() => json({ ok: false, error: '権限がありません' }))
    expect(await sendToGas(URL, { action: 'createTasks' })).toEqual({ ok: false, error: '権限がありません' })
    expect(h.sent).toHaveLength(1)
    expect(h.logs.filter((l) => l.level !== 'info')).toEqual([])
  })

  it('exchangeIdToken は送り直さない(IDトークンの nonce は1回しか使えない)', async () => {
    const h = harness(() => echo404)
    await expect(sendToGas(URL, { action: 'exchangeIdToken' })).rejects.toBeInstanceOf(GasTransportError)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].requestId).toBeUndefined()
  })

  it('失敗した1本の後も、次のリクエストは送る', async () => {
    const h = harness((b) => (b.action === 'getExpenses' ? echo404 : json({ ok: true })))
    const results = await Promise.allSettled([sendToGas(URL, { action: 'getExpenses' }), sendToGas(URL, { action: 'getCandidates' })])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(h.sent.at(-1)?.action).toBe('getCandidates')
  })
})

describe('原因を調べるための記録', () => {
  it('Cookie を送らない・キャッシュしない・転送はたどる設定で送る', async () => {
    const inits: RequestInit[] = []
    harness(() => json({ ok: true }))
    const base = { fetch: async (_u: string, init: RequestInit) => { inits.push(init); return { status: 200, text: async () => '{"ok":true}' } } }
    setGasTransportDepsForTest({ ...base, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
    await sendToGas(URL, { action: 'getInitialData' })
    expect(inits[0]).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'follow', mode: 'cors' })
    expect(inits[0].headers).toEqual({ 'Content-Type': 'text/plain;charset=utf-8' })
  })

  it('GAS の doGet が応答した(GET で届いた)時は、原因と応答の URL を記録して送り直す', async () => {
    let n = 0
    const logs: string[] = []
    setGasTransportDepsForTest({
      fetch: async () => (++n === 1
        ? { status: 200, url: 'https://script.googleusercontent.com/macros/echo?user_content_key=SECRETKEY123&lib=x', redirected: true, text: async () => JSON.stringify({ ok: false, getReceived: true, error: 'GET' }) }
        : { status: 200, text: async () => JSON.stringify({ ok: true, result: 1 }) }),
      sleep: async () => {},
      log: { info: (t: string) => logs.push(t), warn: (t: string) => logs.push(t), error: (t: string) => logs.push(t) },
    })
    expect((await sendToGas(URL, { action: 'getExpenses' })).result).toBe(1)
    expect(logs[0]).toBe('[ohsumi] GAS getExpenses: GAS に GET で届きました(POST の本文が転送の途中で失われた)。応答の URL: https://script.googleusercontent.com/macros/echo?…(転送あり)')
    expect(logs.join('\n')).not.toContain('SECRETKEY123')
  })

  it('JSON ではない応答の本文は、タグを除いた先頭300文字。トークンのような値と JSON の断片は出さない', () => {
    const html = '<!DOCTYPE html><html><head><title>Google Drive - Page Not Found</title><style>body{color:red}</style><script>var x=1</script></head>' +
      '<body><p>Sorry, unable to open the file at this time.</p><p>Please check the address and try again.</p></body></html>'
    expect(bodySnippet(html)).toBe('[Google Drive - Page Not Found] Google Drive - Page Not Found Sorry, unable to open the file at this time. Please check the address and try again.'.replace('[Google Drive - Page Not Found] ', ''))
    expect(bodySnippet('token v1.abcDEF.ghiJKL and eyJhbGciOi.eyJzdWIi.sig and ' + 'A'.repeat(40))).toBe('token [伏せた値] and [伏せた値] and [伏せた値]')
    expect(bodySnippet('{"ok":true,"result":{"members":[{"name":"山田')).toMatch(/^\(JSON の途中で切れた可能性があります。\d+文字。中身は出しません\)$/)
    expect(bodySnippet('x'.repeat(500)).length).toBeLessThanOrEqual(300)
    expect(bodySnippet('   ')).toBe('(空)')
  })

  it('応答が来ないまま止まった1本は、読み取りは20秒・書き込みは45秒で打ち切って送り直す', async () => {
    expect(attemptTimeoutOf('getInitialData')).toBe(ATTEMPT_TIMEOUT_MS.read)
    expect(attemptTimeoutOf('updateTaskStatus')).toBe(ATTEMPT_TIMEOUT_MS.write)
    expect(attemptTimeoutOf('exchangeIdToken')).toBe(ATTEMPT_TIMEOUT_MS.write)
    vi.useFakeTimers()
    try {
      let n = 0
      const logs: string[] = []
      setGasTransportDepsForTest({
        fetch: (_u, init) => (++n === 1
          ? new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
          : Promise.resolve({ status: 200, text: async () => '{"ok":true}' })),
        sleep: async () => {},
        log: { info: (t: string) => logs.push(t), warn: (t: string) => logs.push(t), error: (t: string) => logs.push(t) },
      })
      const p = sendToGas(URL, { action: 'getInitialData' })
      await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS.read)
      expect((await p).ok).toBe(true)
      expect(logs[0]).toBe('[ohsumi] GAS getInitialData: 再試行 1/2(原因: 通信エラー(20秒待っても応答がありません))')
    } finally {
      vi.useRealTimers()
    }
  })

  it('応答の URL は、クエリ(echo の user_content_key など)を除いて出す', () => {
    expect(safeResponseUrl('https://script.googleusercontent.com/macros/echo?user_content_key=abc&lib=M')).toBe('https://script.googleusercontent.com/macros/echo?…')
    expect(safeResponseUrl('https://script.google.com/macros/u/1/s/ID/exec')).toBe('https://script.google.com/macros/u/1/s/ID/exec')
    expect(safeResponseUrl(undefined)).toBe('(不明)')
  })

  it('成功した時は、往復の時間と GAS の中の内訳を1行で出す', async () => {
    const h = harness(() => json({ ok: true, timing: { totalMs: 812, authMs: 20, cache: 'miss', cacheReadMs: 15, readMs: 640, read: 'spreadsheetApp', readError: 'HTTP 403', filterMs: 90 } }))
    await sendToGas(URL, { action: 'getInitialData' })
    expect(h.logs.at(-1)!.text).toMatch(
      /^\[ohsumi\] GAS getInitialData: \d+ms\(列の待ち \d+ms・往復 \d+ms・GAS 812ms: 認証 20・キャッシュ miss 15・シート読み込み 640\(予備の方式\)・Sheets API で読めなかった理由: HTTP 403・絞り込み 90\)$/,
    )
  })
})

describe('GAS と食い違わない', () => {
  it('読み取りとして送るもの(送り直しても書き込まない)は、GAS でロックを取らない操作か、専用の入口の読み取り', () => {
    const code = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
    const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
    vm.runInContext(code, ctx)
    const exempt = (ctx as unknown as { LOCK_EXEMPT_ACTIONS: string[] }).LOCK_EXEMPT_ACTIONS
    for (const a of READ_ACTIONS) {
      if (a === 'getLoginConfig' || a === 'getInitialData') continue
      expect(exempt, a).toContain(a)
    }
    expect(isWriteAction('getInitialData')).toBe(false)
    expect(isWriteAction('updateTaskStatus')).toBe(true)
    expect(isWriteAction('checkAndGenerateRecurringTasks')).toBe(true)
  })
})
