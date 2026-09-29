// 団体の GAS(Apps Script の Web アプリ)への通信の送り方。
//
// 1. 送る順番:
//    - 書き込みは1本ずつ、呼ばれた順に送る(requestId による二重の防止と合わせて、順番を守る)
//    - 読み取りは3本まで同時に送る。1本が詰まっても(echo の 404・打ち切り・再試行)、ほかの読み取りは
//      待たされない。画面の操作に必要な読み取り(初期データなど)を、裏での読み込みより先に送る
//    - 初期データ(getInitialData)は、それより前に呼ばれた書き込みが終わってから送る(書いた内容を読むため)
//    Apps Script の Web アプリは、結果を script.googleusercontent.com の echo の URL へ転送して返す。
//    GAS の処理は済んでいるのに、この受け渡しで止まる・404 になることがある。
// 2. JSON が返らなかった時(echo の 404・通信エラーなど)は、少し待ってから自動でもう一度送る。
//    - 読み取りは、そのまま送り直す
//    - 書き込みには、リクエストごとの ID(requestId)を付ける。GAS は同じ ID の結果を
//      しばらく覚えていて、送り直された時は処理をやり直さずに前回の結果を返す(二重に書かない)
//    - exchangeIdToken は送り直さない(IDトークンの nonce は1回しか使えないため。
//      失敗した時は、ログイン画面からもう一度ログインする)
// 3. 再試行の回数と原因は、コンソールに [ohsumi] で始まる行で記録する。
//    往復の時間は、ブラウザの記録(PerformanceResourceTiming)で exec への往復と echo の取得に分けられる
//    時は分けて出す(Google が Timing-Allow-Origin を付けていない時は分けられない)。
//    JSON ではない応答を受け取った時は、応答の状態・最終的な URL(クエリは除く)・本文の先頭
//    (タグを除いた文字。トークンのような文字列は伏せる)も記録する。
//    成功した時は、往復の時間と GAS の中での処理時間の内訳(gas/Code.gs の timing)を記録する。
// 4. Google のログイン情報(Cookie)は送らない(credentials: 'omit')。GAS が GET で受け取った時
//    (echo が返事を渡さずに exec への GET に送り返した・POST が転送の途中で GET に変わった)は
//    getReceived(bounced)を返すので、原因を記録して送り直す。読み取りは待たずにすぐ送り直す
//    (書き込みは requestId を保ったまま、いつもの待ち時間の後に送り直す)。
// 5. 切り分け用の ping(pingGas)。GAS は何もせずに返すので、往復の時間と GAS の中の時間を比べられる。

export interface GasResponse<T = unknown> {
  ok: boolean
  result?: T
  error?: string
  // セッションが無効・期限切れ(画面はログイン画面に戻す)
  authError?: boolean
  // 権限が足りない(セッションは有効。ログイン画面には戻さない)
  forbidden?: boolean
  reloadRequired?: boolean
  // GAS が同じ requestId の処理をまだ実行中(少し待ってから送り直す)
  retryLater?: boolean
  // 同じ requestId の前回の結果を返した(処理はやり直していない)
  replayed?: boolean
  // GAS の doGet が応答した(POST の本文が失われて GET で届いた。何も処理していない)
  getReceived?: boolean
  // doGet の応答(結果の受け渡しの途中で GET に送り返された)
  bounced?: boolean
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
  'getBackgroundData',
  'ping',
])

// 送り直さない(1回しか使えない値を送る)
export const NO_RETRY_ACTIONS = new Set(['exchangeIdToken'])

// 裏で読み込むもの。画面の操作のリクエストを先に送る
export const BACKGROUND_ACTIONS = new Set([
  'getLoginConfig',
  'getBackgroundData',
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
  authFrom?: 'snapshot' | 'sheet'
  // 初期データと同じ応答に入れた裏での読み込み(withBackground)
  backgroundMs?: number
  // スクリプトプロパティの読み込みと画面の版の確認
  propsMs?: number
  // ログイン: メールアドレスからメンバーを探す・セッションの発行・最終ログイン日時の記録
  emailLookupMs?: number
  sessionMs?: number
  lastLoginMs?: number
  // データの版の読み込み
  versionMs?: number
  // 内訳に無い時間(合計から、重ならない内訳を引いたもの)
  otherMs?: number
  // 最終ログイン日時: recent(1時間以内に記録済みで書かない)・queued(書き込み待ちに入れた)
  lastLogin?: 'recent' | 'queued'
  // 裏での読み込みの内訳(backgroundMs の中)と、それぞれのキャッシュ
  expensesMs?: number
  formSubmissionsMs?: number
  candidatesMs?: number
  myEmailMs?: number
  filesMs?: number
  // ログインの応答に入れた画像の件数と大きさ(base64 の KB)
  filesCount?: number
  filesKB?: number
  expensesCache?: 'hit' | 'miss'
  formSubmissionsCache?: 'hit' | 'miss'
  candidatesCache?: 'hit' | 'miss'
  myEmailCache?: 'hit' | 'miss'
  // getFiles の内訳
  folderPropsMs?: number
  driveMs?: number
  fileCacheMs?: number
  fileCacheHits?: number
  permissionMs?: number
  blobMs?: number
}

function withCache(ms: number | undefined, cache: string | undefined): string {
  return `${ms}${cache ? ` ${cache}` : ''}`
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
  if (timing.propsMs != null) parts.push(`設定の読み込み ${timing.propsMs}`)
  if (timing.authMs != null) parts.push(`認証 ${timing.authMs}`)
  if (timing.lockMs != null) parts.push(`ロック待ち ${timing.lockMs}`)
  if (timing.verifyMs != null) parts.push(`IDトークン確認 ${timing.verifyMs}`)
  if (timing.emailLookupMs != null) parts.push(`メンバーの照合 ${timing.emailLookupMs}`)
  if (timing.versionMs != null) parts.push(`版の読み込み ${timing.versionMs}`)
  if (timing.cache) parts.push(`キャッシュ ${timing.cache}${timing.cacheReadMs != null ? ` ${timing.cacheReadMs}` : ''}`)
  if (timing.readMs != null) parts.push(`シート読み込み ${timing.readMs}(${timing.read === 'api' ? 'Sheets API' : '予備の方式'})`)
  if (timing.readError) parts.push(`Sheets API で読めなかった理由: ${timing.readError}`)
  if (timing.cacheWriteMs != null) parts.push(`キャッシュ書き込み ${timing.cacheWriteMs}`)
  if (timing.filterMs != null) parts.push(`絞り込み ${timing.filterMs}`)
  if (timing.backgroundMs != null || timing.expensesMs != null) {
    const inner: string[] = []
    if (timing.expensesMs != null) inner.push(`経費 ${withCache(timing.expensesMs, timing.expensesCache)}`)
    if (timing.formSubmissionsMs != null) inner.push(`フォームの回答 ${withCache(timing.formSubmissionsMs, timing.formSubmissionsCache)}`)
    if (timing.candidatesMs != null) inner.push(`候補者 ${withCache(timing.candidatesMs, timing.candidatesCache)}`)
    if (timing.myEmailMs != null) inner.push(`メール ${withCache(timing.myEmailMs, timing.myEmailCache)}`)
    if (timing.filesMs != null) inner.push(`画像 ${timing.filesMs}${timing.filesCount != null ? `(${timing.filesCount}件 ${timing.filesKB ?? 0}KB)` : ''}`)
    const label = timing.backgroundMs != null ? `裏での読み込み ${timing.backgroundMs}` : '裏での読み込み'
    parts.push(inner.length ? `${label}(${inner.join('・')})` : label)
  }
  if (timing.folderPropsMs != null) parts.push(`フォルダの設定 ${timing.folderPropsMs}`)
  if (timing.driveMs != null) parts.push(`Drive ${timing.driveMs}`)
  if (timing.fileCacheMs != null) parts.push(`画像のキャッシュ ${timing.fileCacheMs}${timing.fileCacheHits ? `(${timing.fileCacheHits}件 hit)` : ''}`)
  if (timing.permissionMs != null) parts.push(`領収書の権限 ${timing.permissionMs}`)
  if (timing.blobMs != null) parts.push(`ファイルの読み込み ${timing.blobMs}`)
  if (timing.sessionMs != null) parts.push(`セッションの発行 ${timing.sessionMs}`)
  if (timing.lastLoginMs != null) {
    const how = timing.lastLogin === 'recent' ? '(1時間以内に記録済み)' : timing.lastLogin === 'queued' ? '(書き込み待ちに追加)' : ''
    parts.push(`最終ログイン日時の記録 ${timing.lastLoginMs}${how}`)
  }
  if (timing.otherMs != null) parts.push(`その他 ${timing.otherMs}`)
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

/**
 * exec への往復(Google が echo の URL へ転送するまで)と、echo の取得にかかった時間。
 * 同じ URL へ同時に送ることがあるので、送り始めた時刻に最も近い記録を使う。
 * Google が Timing-Allow-Origin を付けていない時は、転送の時刻が 0 になり、分けられない
 */
export function splitRoundTrip(entries: ResourceTimingLike[], startedAt: number): { execMs: number; echoMs: number } | null {
  const candidates = entries.filter((e) => e.startTime >= startedAt - 5).sort((a, b) => a.startTime - b.startTime)
  const e = candidates[0]
  if (!e || !(e.redirectEnd > 0) || e.redirectEnd < e.startTime || !(e.responseEnd >= e.redirectEnd)) return null
  return { execMs: Math.round(e.redirectEnd - e.startTime), echoMs: Math.round(e.responseEnd - e.redirectEnd) }
}

/** 応答の本文の大きさ(KB、UTF-8 のバイト数から) */
export function responseKB(text: string): number {
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
  return Math.round((bytes / 1024) * 10) / 10
}

function describeRoundTrip(split: { execMs: number; echoMs: number } | null): string {
  return split ? `exec ${split.execMs}ms・echo ${split.echoMs}ms` : 'exec と echo の内訳は取れません'
}

// ---- テストで差し替えるもの ----

type FetchedResponse = Pick<Response, 'status' | 'text'> & Partial<Pick<Response, 'url' | 'redirected'>>

// ブラウザの通信の記録(PerformanceResourceTiming)のうち、使う項目
export interface ResourceTimingLike {
  name: string
  startTime: number
  duration: number
  redirectStart: number
  redirectEnd: number
  responseEnd: number
}

interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<FetchedResponse>
  // performance.now() と、その URL への通信の記録
  perfNow: () => number
  resourceTimings: (url: string) => ResourceTimingLike[]
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

function browserResourceTimings(url: string): ResourceTimingLike[] {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return []
  const entries = performance.getEntriesByName(url, 'resource') as unknown as ResourceTimingLike[]
  // 記録の上限(既定250件)で新しい記録が捨てられないよう、多くなったら消す
  try {
    if (performance.getEntriesByType('resource').length > 200) performance.clearResourceTimings()
  } catch {
    /* 消せなくても続ける */
  }
  return entries
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  perfNow: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  resourceTimings: browserResourceTimings,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: console,
  newId: randomId,
}
let deps: Deps = defaultDeps

export function setGasTransportDepsForTest(partial: Partial<Deps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps
  readQueues.foreground.length = 0
  readQueues.background.length = 0
  readsRunning = 0
  writeChain = Promise.resolve()
}

// ---- 送る列 ----

// 同時に送る読み取りの上限
export const READ_CONCURRENCY = 3

// 書き込み: 呼ばれた順に1本ずつ(前の書き込みが終わってから次を送る)
let writeChain: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(task: (queuedMs: number) => Promise<T>): Promise<T> {
  const queuedAt = Date.now()
  const run = writeChain.then(() => task(Date.now() - queuedAt))
  // 失敗しても次の書き込みは送る
  writeChain = run.catch(() => undefined)
  return run
}

// 読み取り: READ_CONCURRENCY 本まで同時に。画面の操作に必要なものを先に
const readQueues: Record<GasPriority, (() => Promise<void>)[]> = { foreground: [], background: [] }
let readsRunning = 0

function enqueueRead<T>(priority: GasPriority, task: (queuedMs: number) => Promise<T>): Promise<T> {
  const queuedAt = Date.now()
  return new Promise<T>((resolve, reject) => {
    readQueues[priority].push(() => task(Date.now() - queuedAt).then(resolve, reject))
    startReads()
  })
}

function startReads(): void {
  while (readsRunning < READ_CONCURRENCY) {
    const job = readQueues.foreground.shift() ?? readQueues.background.shift()
    if (!job) return
    readsRunning++
    void job().finally(() => {
      readsRunning--
      startReads()
    })
  }
}

// ---- 1回送る ----

type Attempt =
  | { kind: 'ok'; json: GasResponse; ms: number; split: { execMs: number; echoMs: number } | null; kb: number }
  | { kind: 'fail'; reason: string; detail?: string; bounced?: boolean }

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
  const perfStarted = deps.perfNow()
  const split = () => {
    try {
      return splitRoundTrip(deps.resourceTimings(url), perfStarted)
    } catch {
      return null
    }
  }
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
  const where = `応答の URL: ${safeResponseUrl(res.url)}${res.redirected ? '(転送あり)' : ''}、${describeRoundTrip(split())}`
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
  if (r.getReceived) {
    return {
      kind: 'fail',
      reason: r.bounced
        ? 'GAS に GET で届きました(結果の受け渡し(echo)が exec への GET に送り返した)'
        : 'GAS に GET で届きました(POST の本文が転送の途中で失われた)',
      detail: `${where}、${Date.now() - started}ms`,
      bounced: true,
    }
  }
  if (r.retryLater) return { kind: 'fail', reason: `GAS が処理できませんでした(${r.error ?? '混み合っています'})` }
  return { kind: 'ok', json: r, ms: Date.now() - started, split: split(), kb: responseKB(text) }
}

async function sendWithRetry<T>(url: string, action: string, body: string, maxAttempts: number, queuedMs: number): Promise<GasResponse<T>> {
  const started = Date.now()
  let reason = ''
  let bounced = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // 送り返された読み取りは、GAS が何も処理していないので待たずに送り直す
      const immediate = bounced && !isWriteAction(action)
      deps.log.warn(`[ohsumi] GAS ${action}: 再試行 ${attempt - 1}/${maxAttempts - 1}${immediate ? '(すぐ送り直します)' : ''}(原因: ${reason})`)
      if (!immediate) await deps.sleep(RETRY_DELAYS_MS[attempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
    }
    const r = await attemptOnce(url, body, attemptTimeoutOf(action))
    if (r.kind === 'ok') {
      if (attempt > 1) deps.log.info(`[ohsumi] GAS ${action}: 再試行 ${attempt - 1}回目で成功しました`)
      if (r.json.replayed) deps.log.info(`[ohsumi] GAS ${action}: 前回の処理の結果を受け取りました(処理はやり直していません)`)
      deps.log.info(
        `[ohsumi] GAS ${action}: ${queuedMs + (Date.now() - started)}ms(列の待ち ${queuedMs}ms・往復 ${r.ms}ms(${describeRoundTrip(r.split)})・応答 ${r.kb}KB` +
          `${attempt > 1 ? `・${attempt}回目` : ''}・${describeTiming(r.json.timing)})`,
      )
      return r.json as GasResponse<T>
    }
    reason = r.reason
    bounced = r.bounced === true
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
  const task = (queuedMs: number) => sendWithRetry<T>(url, action, text, maxAttemptsOf(action), queuedMs)
  if (!READ_ACTIONS.has(action)) return enqueueWrite(task)
  if (action === 'getInitialData') {
    // それより前に呼ばれた書き込みが終わってから(書いた内容を読むため)
    const queuedAt = Date.now()
    return writeChain.then(() => enqueueRead('foreground', () => task(Date.now() - queuedAt)))
  }
  return enqueueRead(priorityOf(action), task)
}

// ---- 切り分け用の ping ----

export interface PingResult {
  ok: boolean
  // 画面から見た往復(fetch を始めてから JSON を受け取るまで)
  roundTripMs: number
  // exec への往復と echo の取得(分けられない時は null)
  split: { execMs: number; echoMs: number } | null
  // GAS の中の時間(ping は何もしないので、ほぼ実行の開始から終わりまで)
  gasMs: number | null
  error?: string
}

/**
 * 何もしない ping を count 回、1回ずつ順に送り、往復の時間と GAS の中の時間を並べてコンソールに出す。
 * 列には入れず(ほかのリクエストを待たない)、再試行もしない。ping でも遅ければ、Google 側か回線側の問題
 */
export async function pingGas(url: string, count = 3): Promise<PingResult[]> {
  const results: PingResult[] = []
  for (let i = 1; i <= count; i++) {
    const started = Date.now()
    const r = await attemptOnce(url, JSON.stringify({ action: 'ping' }), ATTEMPT_TIMEOUT_MS.read)
    const roundTripMs = Date.now() - started
    const result: PingResult =
      r.kind === 'ok'
        ? { ok: r.json.ok === true, roundTripMs, split: r.split, gasMs: r.json.timing?.totalMs ?? null, error: r.json.ok ? undefined : r.json.error }
        : { ok: false, roundTripMs, split: null, gasMs: null, error: r.reason }
    results.push(result)
    const line =
      `[ohsumi] ping ${i}/${count}: 往復 ${roundTripMs}ms(${describeRoundTrip(result.split)})・GAS の中 ${result.gasMs ?? '-'}ms` +
      (result.error ? `・失敗: ${result.error}` : '')
    if (result.ok) deps.log.info(line)
    else deps.log.warn(line + (r.kind === 'fail' && r.detail ? `。${r.detail}` : ''))
  }
  return results
}
