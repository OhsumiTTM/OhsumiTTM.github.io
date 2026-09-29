// 団体の GAS(Apps Script の Web アプリ)への通信の送り方。
//
// 1. 同時に送らない: GAS へのリクエストは1本ずつ順番に送る。Apps Script の Web アプリは、
//    結果を script.googleusercontent.com の echo の URL へ転送して返す。同じ端末から同時に
//    何本も送ると、GAS の処理は成功しているのに、この転送先が 404 になることがある。
//    画面の操作(書き込み・初期データ)を先に、裏での読み込み(経費・候補者など)を後に送る。
// 2. JSON が返らなかった時(echo の 404・通信エラーなど)は、少し待ってから自動でもう一度送る。
//    - 読み取りは、そのまま送り直す
//    - 書き込みには、リクエストごとの ID(requestId)を付ける。GAS は同じ ID の結果を
//      しばらく覚えていて、送り直された時は処理をやり直さずに前回の結果を返す(二重に書かない)
//    - exchangeIdToken は送り直さない(IDトークンの nonce は1回しか使えないため。
//      失敗した時は、ログイン画面からもう一度ログインする)
// 3. 再試行の回数と原因は、コンソールに [ohsumi] で始まる行で記録する。

export interface GasResponse<T = unknown> {
  ok: boolean
  result?: T
  error?: string
  authError?: boolean
  reloadRequired?: boolean
  // GAS が同じ requestId の処理をまだ実行中(少し待ってから送り直す)
  retryLater?: boolean
  // 同じ requestId の前回の結果を返した(処理はやり直していない)
  replayed?: boolean
  // 残りが半分を切ったセッションは、GAS が新しいトークンを返す(差し替える)
  session?: { token: string; exp: number }
}

// 読み取り(送り直しても何も変わらない)。これ以外は書き込みとして requestId を付ける
export const READ_ACTIONS = new Set([
  'getLoginConfig',
  'getInitialData',
  'getExpenses',
  'getFormSubmissions',
  'getCandidates',
  'getFiles',
  'getMyEmails',
  'getWebhookStatus',
  'fetchDailyReports',
  'translateText',
])

// 送り直さない(1回しか使えない値を送る)
export const NO_RETRY_ACTIONS = new Set(['exchangeIdToken'])

// 裏で読み込むもの。画面の操作のリクエストを先に送る
export const BACKGROUND_ACTIONS = new Set([
  'getLoginConfig',
  'getExpenses',
  'getFormSubmissions',
  'getCandidates',
  'getMyEmails',
  'getWebhookStatus',
  'checkAndGenerateRecurringTasks',
])

// 再試行までの待ち時間(ミリ秒)。1回目の失敗の後に1秒、2回目の後に3秒待つ(最大3回送る)
export const RETRY_DELAYS_MS = [1000, 3000]

export type GasPriority = 'foreground' | 'background'

export function priorityOf(action: string): GasPriority {
  return BACKGROUND_ACTIONS.has(action) ? 'background' : 'foreground'
}

export function isWriteAction(action: string): boolean {
  return !READ_ACTIONS.has(action) && !NO_RETRY_ACTIONS.has(action)
}

export function maxAttemptsOf(action: string): number {
  return NO_RETRY_ACTIONS.has(action) ? 1 : RETRY_DELAYS_MS.length + 1
}

/** 何度送っても JSON の応答を受け取れなかった */
export class GasTransportError extends Error {
  constructor(
    readonly action: string,
    readonly reason: string,
    readonly attempts: number,
  ) {
    super(
      attempts > 1
        ? `GAS から応答を受け取れませんでした(${attempts}回試しました。原因: ${reason})。`
        : `GAS から応答を受け取れませんでした(原因: ${reason})。`,
    )
    this.name = 'GasTransportError'
  }
}

// ---- テストで差し替えるもの ----

interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'text'>>
  sleep: (ms: number) => Promise<void>
  log: Pick<Console, 'info' | 'warn' | 'error'>
  newId: () => string
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: console,
  newId: randomId,
}
let deps: Deps = defaultDeps

export function setGasTransportDepsForTest(partial: Partial<Deps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps
  queues.foreground.length = 0
  queues.background.length = 0
}

// ---- 1本ずつ送る列 ----

const queues: Record<GasPriority, (() => Promise<void>)[]> = { foreground: [], background: [] }
let pumping = false

function enqueue<T>(priority: GasPriority, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[priority].push(() => task().then(resolve, reject))
    void pump()
  })
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const job = queues.foreground.shift() ?? queues.background.shift()
      if (!job) break
      await job()
    }
  } finally {
    pumping = false
  }
}

// ---- 1回送る ----

type Attempt = { kind: 'ok'; json: GasResponse } | { kind: 'fail'; reason: string }

async function attemptOnce(url: string, body: string): Promise<Attempt> {
  let res: Pick<Response, 'status' | 'text'>
  try {
    // text/plain にして CORS の事前確認(OPTIONS)を避ける(Apps Script は OPTIONS を受けない)
    res = await deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body })
  } catch (err) {
    return { kind: 'fail', reason: `通信エラー(${err instanceof Error ? err.message : String(err)})` }
  }
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    return { kind: 'fail', reason: `応答を読み取れませんでした(HTTP ${res.status})` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'fail', reason: `JSON ではない応答(HTTP ${res.status})` }
  }
  if (!json || typeof json !== 'object') return { kind: 'fail', reason: `JSON ではない応答(HTTP ${res.status})` }
  if ((json as GasResponse).retryLater) return { kind: 'fail', reason: `GAS が処理できませんでした(${(json as GasResponse).error ?? '混み合っています'})` }
  return { kind: 'ok', json: json as GasResponse }
}

async function sendWithRetry<T>(url: string, action: string, body: string, maxAttempts: number): Promise<GasResponse<T>> {
  let reason = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      deps.log.warn(`[ohsumi] GAS ${action}: 再試行 ${attempt - 1}/${maxAttempts - 1}(原因: ${reason})`)
      await deps.sleep(RETRY_DELAYS_MS[attempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
    }
    const r = await attemptOnce(url, body)
    if (r.kind === 'ok') {
      if (attempt > 1) deps.log.info(`[ohsumi] GAS ${action}: 再試行 ${attempt - 1}回目で成功しました`)
      if (r.json.replayed) deps.log.info(`[ohsumi] GAS ${action}: 前回の処理の結果を受け取りました(処理はやり直していません)`)
      return r.json as GasResponse<T>
    }
    reason = r.reason
  }
  deps.log.error(`[ohsumi] GAS ${action}: ${maxAttempts}回送りましたが、応答を受け取れませんでした(原因: ${reason})`)
  throw new GasTransportError(action, reason, maxAttempts)
}

/**
 * GAS にリクエストを送る。1本ずつ順番に送り、JSON が返らなければ送り直す。
 * 書き込みには requestId を付ける(送り直しても同じ ID)。
 * 返り値は GAS の JSON の応答そのもの(ok: false もそのまま返す)
 */
export function sendToGas<T = unknown>(url: string, body: Record<string, unknown> & { action: string }): Promise<GasResponse<T>> {
  const action = body.action
  const payload = isWriteAction(action) ? { ...body, requestId: deps.newId() } : body
  const text = JSON.stringify(payload)
  return enqueue(priorityOf(action), () => sendWithRetry<T>(url, action, text, maxAttemptsOf(action)))
}
