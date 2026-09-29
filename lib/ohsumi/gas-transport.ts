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
//    JSON ではない応答を受け取った時は、応答の状態・最終的な URL(クエリは除く)・本文の先頭
//    (タグを除いた文字。トークンのような文字列は伏せる)も記録する。
//    成功した時は、往復の時間と GAS の中での処理時間の内訳(gas/Code.gs の timing)を記録する。
// 4. Google のログイン情報(Cookie)は送らない(credentials: 'omit')。GAS が GET で受け取った時
//    (POST が転送の途中で GET に変わり、本文が失われた)は getReceived を返すので、原因を記録して送り直す。

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
  // GAS の doGet が応答した(POST の本文が失われて GET で届いた。何も処理していない)
  getReceived?: boolean
  // GAS の中での処理時間の内訳(gas/Code.gs の jsonOutput)
  timing?: GasTiming
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

// 1回の送信を待つ上限。GAS の処理(実行ログでは最長でも数秒)より十分に長くする。
// 1本ずつ送るので、止まった1本がほかを長く待たせないよう、読み取りは短めにする。
// 超えたら打ち切って送り直す(書き込みは requestId があるので二重にならない)
export const ATTEMPT_TIMEOUT_MS = { read: 20000, write: 45000 }

export function attemptTimeoutOf(action: string): number {
  return isWriteAction(action) || NO_RETRY_ACTIONS.has(action) ? ATTEMPT_TIMEOUT_MS.write : ATTEMPT_TIMEOUT_MS.read
}

// fetch の設定。Google のログイン情報(Cookie)を送らない・キャッシュしない・転送はたどる
export const FETCH_INIT: RequestInit = {
  method: 'POST',
  mode: 'cors',
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'follow',
  referrerPolicy: 'no-referrer',
  // text/plain にして CORS の事前確認(OPTIONS)を避ける(Apps Script は OPTIONS を受けない)
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
}

export interface GasTiming {
  totalMs?: number
  authMs?: number
  lockMs?: number
  cache?: 'unchanged' | 'hit' | 'miss'
  cacheReadMs?: number
  cacheWriteMs?: number
  readMs?: number
  read?: 'api' | 'spreadsheetApp'
  readError?: string
  filterMs?: number
  verifyMs?: number
}

// ---- コンソールに出す文字の整え方 ----

/** 応答の URL から、クエリ(echo の user_content_key など)と # 以降を除く */
export function safeResponseUrl(url: string | undefined): string {
  if (!url) return '(不明)'
  try {
    const u = new URL(url)
    return u.origin + u.pathname + (u.search ? '?…' : '')
  } catch {
    return '(不明)'
  }
}

// トークンや鍵のように見える文字列を伏せる
function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[伏せた値]')
    .replace(/\bv1\.[\w-]+\.[\w-]+/g, '[伏せた値]')
    .replace(/\bya29\.[\w.-]+/g, '[伏せた値]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[伏せた値]')
}

/**
 * JSON ではない応答の本文の先頭(最大300文字)。HTML ならタグ・スクリプトを除いた文字にする。
 * JSON の途中で切れたように見える場合は、データを含む可能性があるので中身を出さない
 */
export function bodySnippet(text: string, max = 300): string {
  const trimmed = text.trim()
  if (!trimmed) return '(空)'
  if (/^[{[]/.test(trimmed)) return `(JSON の途中で切れた可能性があります。${trimmed.length}文字。中身は出しません)`
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed)?.[1]?.trim()
  const visible = trimmed
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const out = (title && !visible.startsWith(title) ? `[${title}] ` : '') + visible
  return redact(out).slice(0, max)
}

function describeTiming(timing: GasTiming | undefined): string {
  if (!timing || typeof timing.totalMs !== 'number') return 'GAS の内訳なし'
  const parts: string[] = []
  if (timing.authMs != null) parts.push(`認証 ${timing.authMs}`)
  if (timing.lockMs != null) parts.push(`ロック待ち ${timing.lockMs}`)
  if (timing.verifyMs != null) parts.push(`IDトークン確認 ${timing.verifyMs}`)
  if (timing.cache) parts.push(`キャッシュ ${timing.cache}${timing.cacheReadMs != null ? ` ${timing.cacheReadMs}` : ''}`)
  if (timing.readMs != null) parts.push(`シート読み込み ${timing.readMs}(${timing.read === 'api' ? 'Sheets API' : '予備の方式'})`)
  if (timing.readError) parts.push(`Sheets API で読めなかった理由: ${timing.readError}`)
  if (timing.cacheWriteMs != null) parts.push(`キャッシュ書き込み ${timing.cacheWriteMs}`)
  if (timing.filterMs != null) parts.push(`絞り込み ${timing.filterMs}`)
  return `GAS ${timing.totalMs}ms${parts.length ? `: ${parts.join('・')}` : ''}`
}

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

type FetchedResponse = Pick<Response, 'status' | 'text'> & Partial<Pick<Response, 'url' | 'redirected'>>

interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<FetchedResponse>
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

// task には、列に並んでから送り始めるまでの待ち時間(ミリ秒)を渡す
function enqueue<T>(priority: GasPriority, task: (queuedMs: number) => Promise<T>): Promise<T> {
  const queuedAt = Date.now()
  return new Promise<T>((resolve, reject) => {
    queues[priority].push(() => task(Date.now() - queuedAt).then(resolve, reject))
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

type Attempt = { kind: 'ok'; json: GasResponse; ms: number } | { kind: 'fail'; reason: string; detail?: string }

async function fetchWithTimeout(url: string, body: string, timeoutMs: number): Promise<FetchedResponse> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 先に理由を決めてから通信を止める(止めた時のエラーより、こちらを原因として記録する)
      reject(new Error(`${timeoutMs / 1000}秒待っても応答がありません`))
      controller?.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([deps.fetch(url, { ...FETCH_INIT, body, signal: controller?.signal }), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function attemptOnce(url: string, body: string, timeoutMs: number): Promise<Attempt> {
  const started = Date.now()
  let res: FetchedResponse
  try {
    res = await fetchWithTimeout(url, body, timeoutMs)
  } catch (err) {
    return { kind: 'fail', reason: `通信エラー(${err instanceof Error ? err.message : String(err)})` }
  }
  let text: string
  try {
    text = await res.text()
  } catch {
    return { kind: 'fail', reason: `応答を読み取れませんでした(HTTP ${res.status})` }
  }
  const where = `応答の URL: ${safeResponseUrl(res.url)}${res.redirected ? '(転送あり)' : ''}`
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'fail', reason: `JSON ではない応答(HTTP ${res.status})`, detail: `${where}、本文の先頭: ${bodySnippet(text)}` }
  }
  if (!json || typeof json !== 'object') {
    return { kind: 'fail', reason: `JSON ではない応答(HTTP ${res.status})`, detail: `${where}、本文の先頭: ${bodySnippet(text)}` }
  }
  const r = json as GasResponse
  if (r.getReceived) return { kind: 'fail', reason: 'GAS に GET で届きました(POST の本文が転送の途中で失われた)', detail: where }
  if (r.retryLater) return { kind: 'fail', reason: `GAS が処理できませんでした(${r.error ?? '混み合っています'})` }
  return { kind: 'ok', json: r, ms: Date.now() - started }
}

async function sendWithRetry<T>(url: string, action: string, body: string, maxAttempts: number, queuedMs: number): Promise<GasResponse<T>> {
  const started = Date.now()
  let reason = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      deps.log.warn(`[ohsumi] GAS ${action}: 再試行 ${attempt - 1}/${maxAttempts - 1}(原因: ${reason})`)
      await deps.sleep(RETRY_DELAYS_MS[attempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
    }
    const r = await attemptOnce(url, body, attemptTimeoutOf(action))
    if (r.kind === 'ok') {
      if (attempt > 1) deps.log.info(`[ohsumi] GAS ${action}: 再試行 ${attempt - 1}回目で成功しました`)
      if (r.json.replayed) deps.log.info(`[ohsumi] GAS ${action}: 前回の処理の結果を受け取りました(処理はやり直していません)`)
      deps.log.info(
        `[ohsumi] GAS ${action}: ${queuedMs + (Date.now() - started)}ms(列の待ち ${queuedMs}ms・往復 ${r.ms}ms` +
          `${attempt > 1 ? `・${attempt}回目` : ''}・${describeTiming(r.json.timing)})`,
      )
      return r.json as GasResponse<T>
    }
    reason = r.reason
    if (r.detail) deps.log.warn(`[ohsumi] GAS ${action}: ${r.reason}。${r.detail}`)
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
  return enqueue(priorityOf(action), (queuedMs) => sendWithRetry<T>(url, action, text, maxAttemptsOf(action), queuedMs))
}
