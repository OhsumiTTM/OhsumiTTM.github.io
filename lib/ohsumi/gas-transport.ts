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
  // 提供停止中(R1-e): すべての操作を断った
  orgSuspended?: boolean
  // 機能停止中(R1-e): 読み取り専用のため、作成・編集を断った
  restricted?: boolean
  // 停止の予定・停止中の時だけ付く({ phase, kind, suspendAt }。lib/ohsumi/contract.ts)
  contract?: unknown
  // GAS が同じ requestId の処理をまだ実行中(少し待ってから送り直す)
  retryLater?: boolean
  // 同じ requestId の前回の結果を返した(処理はやり直していない)
  replayed?: boolean
  // まとめて送った書き込みで、前提の操作(変更そのものなど)が保存されなかったため、行わなかった
  skipped?: boolean
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

export interface GasTiming extends SheetReadTiming {
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
  // ロックを取った後に版が変わっていて、シートから判定し直した(書き込み)
  authRecheck?: 'sheet'
  authRecheckMs?: number
  // 書き込みの内訳: 送り直しの確認と記録・処理の全体とその内訳・書き込みの確定・版の更新
  replayMs?: number
  actionMs?: number
  sheetReadMs?: number
  sheetWriteMs?: number
  notifyMs?: number
  // 通知の宛先・言語を調べる(メンバー・メールアドレス・団体の通知先)
  recipientsMs?: number
  mailMs?: number
  mailCount?: number
  chatMs?: number
  calendarMs?: number
  actionOtherMs?: number
  flushMs?: number
  versionBumpMs?: number
  // まとめて送った書き込みの件数
  batchOps?: number
  // 裏での読み込みで、キャッシュに無い表をまとめて読んだ(Sheets API を1回)
  batchReadMs?: number
  batchReadSheets?: number
  batchRead?: 'api' | 'spreadsheetApp'
  batchReadError?: string
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
  // 最終ログイン日時: recent(1時間以内に記録済みで書かない)・queued(書き込み待ちに入れた)・
  // dropped(書き込み待ちが上限に達していて入れなかった)
  lastLogin?: 'recent' | 'queued' | 'dropped'
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

// シートを読んだ時の内訳(<prefix>SheetMs・<prefix>Rows・<prefix>Cols)
type SheetReadTiming = { [K in `${'expenses' | 'formSubmissions' | 'candidates' | 'myEmail'}${'SheetMs' | 'Rows' | 'Cols'}`]?: number }

function withCache(ms: number | undefined, cache: string | undefined, timing?: GasTiming, prefix?: string): string {
  const t = timing as (GasTiming & Record<string, unknown>) | undefined
  const sheetMs = prefix && t ? t[`${prefix}SheetMs`] : undefined
  const rows = prefix && t ? t[`${prefix}Rows`] : undefined
  const size = `${rows ?? '?'}行×${(prefix && t ? t[`${prefix}Cols`] : undefined) ?? '?'}列`
  // シートを1枚で読んだ時は時間も出す。まとめて読んだ時(時間は「シートをまとめて読み込み」)は行数・列数だけ
  const sheet = typeof sheetMs === 'number' ? `(シート ${sheetMs}ms・${size})` : typeof rows === 'number' ? `(まとめて読み込み・${size})` : ''
  return `${ms}${cache ? ` ${cache}` : ''}${sheet}`
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
  if (timing.authMs != null) parts.push(`認証 ${timing.authMs}${timing.authFrom ? `(${timing.authFrom === 'snapshot' ? 'キャッシュ' : 'シート'})` : ''}`)
  if (timing.lockMs != null) parts.push(`ロック待ち ${timing.lockMs}`)
  if (timing.authRecheckMs != null) parts.push(`権限の判定し直し ${timing.authRecheckMs}(版が変わったためシートから)`)
  if (timing.replayMs != null) parts.push(`送り直しの確認と記録 ${timing.replayMs}`)
  if (timing.actionMs != null) {
    const inner: string[] = []
    if (timing.batchOps != null) inner.push(`${timing.batchOps}件をまとめて`)
    if (timing.sheetReadMs != null) inner.push(`行の読み込み ${timing.sheetReadMs}`)
    if (timing.sheetWriteMs != null) inner.push(`シートへの書き込み ${timing.sheetWriteMs}`)
    if (timing.recipientsMs != null) inner.push(`宛先を調べる ${timing.recipientsMs}`)
    if (timing.notifyMs != null) inner.push(`通知の準備 ${timing.notifyMs}`)
    if (timing.mailMs != null) inner.push(`メール ${timing.mailMs}(${timing.mailCount ?? 0}件)`)
    if (timing.chatMs != null) inner.push(`チャット ${timing.chatMs}`)
    if (timing.calendarMs != null) inner.push(`カレンダー ${timing.calendarMs}`)
    if (timing.actionOtherMs != null) inner.push(`そのほか ${timing.actionOtherMs}`)
    parts.push(`処理 ${timing.actionMs}${inner.length ? `(${inner.join('・')})` : ''}`)
  }
  if (timing.flushMs != null) parts.push(`書き込みの確定 ${timing.flushMs}`)
  if (timing.versionBumpMs != null) parts.push(`版の更新 ${timing.versionBumpMs}`)
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
    if (timing.batchReadMs != null) {
      inner.push(
        `シートをまとめて読み込み ${timing.batchReadMs}(${timing.batchReadSheets ?? '?'}枚・` +
          `${timing.batchRead === 'api' ? 'Sheets API' : `Sheets API で読めず1枚ずつ${timing.batchReadError ? `: ${timing.batchReadError}` : ''}`})`,
      )
    }
    if (timing.expensesMs != null) inner.push(`経費 ${withCache(timing.expensesMs, timing.expensesCache, timing, 'expenses')}`)
    if (timing.formSubmissionsMs != null) inner.push(`フォームの回答 ${withCache(timing.formSubmissionsMs, timing.formSubmissionsCache, timing, 'formSubmissions')}`)
    if (timing.candidatesMs != null) inner.push(`候補者 ${withCache(timing.candidatesMs, timing.candidatesCache, timing, 'candidates')}`)
    if (timing.myEmailMs != null) inner.push(`メール ${withCache(timing.myEmailMs, timing.myEmailCache, timing, 'myEmail')}`)
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
    const how =
      timing.lastLogin === 'recent' ? '(1時間以内に記録済み)'
        : timing.lastLogin === 'queued' ? '(書き込み待ちに追加)'
          : timing.lastLogin === 'dropped' ? '(書き込み待ちが上限のため記録せず)'
            : ''
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
  // 次のタスクまで待つ(同じ操作から続けて呼ばれた書き込みを、まとめて送るため)
  defer: () => Promise<void>
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
  defer: () => new Promise((resolve) => setTimeout(resolve, 0)),
  log: console,
  newId: randomId,
}
let deps: Deps = defaultDeps

export function setGasTransportDepsForTest(partial: Partial<Deps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps
  batchUnsupported = false
  readQueues.foreground.length = 0
  readQueues.background.length = 0
  readsRunning = 0
  writeChain = Promise.resolve()
  pendingWrites.length = 0
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

// ---- 書き込みをまとめて送る(batch) ----
//
// 画面の1回の操作から続けて呼ばれた書き込み(例: 日程の変更と変更の記録)は、1回の通信にまとめて送る
// (GAS の batch。中の操作は、1本ずつ送った時と同じ権限の確認をして順番に実行する)。
// 書き込みの列が空いた時に、それまでに呼ばれた書き込みをまとめる。列が空いていても、同じ操作から
// 続けて呼ばれたものを待つため、次のタスク(setTimeout 0)まで待ってから送る。
// 結果は操作ごとに分けて、1本ずつ送った時と同じ形で返す。送り直しは、まとめた1本ごとに行う

// まとめて送れる件数の上限(GAS の BATCH_MAX_OPS と同じ)
export const BATCH_MAX_OPS = 20

// まとめて送らない書き込み: ファイルのアップロード(本文が大きい)と、GAS がロックを取らない操作
// (gas/Code.gs の LOCK_EXEMPT_ACTIONS のうち書き込み。lib/ohsumi/gas-write-batch.test.ts で確かめる)
export const UNBATCHED_WRITE_ACTIONS = new Set([
  'revokeMySessions',
  'revokeMemberSessions',
  'checkAndGenerateRecurringTasks',
  'testDiscordWebhook',
  'testSlackWebhook',
])

export function isBatchableWrite(action: string): boolean {
  return !batchUnsupported && isWriteAction(action) && !UNBATCHED_WRITE_ACTIONS.has(action) && !/^upload/.test(action)
}

// 同じ送り先・同じセッションで、間にまとめない書き込みを挟んでいない間だけ、まとめてよい
function sameBatch(a: PendingWrite, b: PendingWrite): boolean {
  return a.url === b.url && a.epoch === b.epoch && a.body.sessionToken === b.body.sessionToken && a.body.clientVersion === b.body.clientVersion
}

// まとめない書き込み(アップロードなど)を呼んだ回数。それより前と後の書き込みは、同じ束にしない
// (まとめると、後から呼ばれた書き込みが、まとめない書き込みより先に送られてしまう)
let writeEpoch = 0

type PendingWrite = {
  url: string
  epoch: number
  body: Record<string, unknown> & { action: string }
  queuedAt: number
  resolve: (r: GasResponse) => void
  reject: (e: unknown) => void
}

const pendingWrites: PendingWrite[] = []

// GAS が batch を知らない(GAS を更新する前に画面だけ新しくなった)時は、このページではまとめない
let batchUnsupported = false

// 古い GAS が batch を断った時の応答(「Unknown action: batch」「未分類のaction: batch」)
export function isBatchUnknownResponse(r: GasResponse): boolean {
  return !r.ok && typeof r.error === 'string' && /action: batch\b/.test(r.error)
}

function enqueueBatchableWrite<T>(url: string, body: Record<string, unknown> & { action: string }): Promise<GasResponse<T>> {
  return new Promise<GasResponse<T>>((resolve, reject) => {
    const entry: PendingWrite = { url, epoch: writeEpoch, body, queuedAt: Date.now(), resolve: resolve as (r: GasResponse) => void, reject }
    pendingWrites.push(entry)
    const run = writeChain.then(async () => {
      // 前の束と一緒に送った
      if (!pendingWrites.includes(entry)) return
      // 同じ操作から続けて呼ばれる書き込みを待つ
      await deps.defer()
      const group = takeGroup()
      await sendGroup(group)
    })
    writeChain = run.catch(() => undefined)
  })
}

// 列の先頭から、まとめてよいものを取り出す
function takeGroup(): PendingWrite[] {
  const first = pendingWrites.shift()
  if (!first) return []
  const group = [first]
  while (group.length < BATCH_MAX_OPS && pendingWrites.length > 0 && sameBatch(first, pendingWrites[0])) {
    group.push(pendingWrites.shift()!)
  }
  return group
}

// 変更の記録(updateHistory)は配列を丸ごと置き換える。同じタスクの記録が同じ束に2つ以上あれば、
// 最後のもの(それまでの記録を含む)だけを送り、前のものにも同じ結果を返す
function coalesce(group: PendingWrite[]): { sent: PendingWrite[]; sameAs: Map<PendingWrite, PendingWrite> } {
  const sameAs = new Map<PendingWrite, PendingWrite>()
  const lastHistory = new Map<string, PendingWrite>()
  for (const p of group) if (p.body.action === 'updateHistory') lastHistory.set(String(p.body.taskId), p)
  const sent = group.filter((p) => {
    if (p.body.action !== 'updateHistory') return true
    const last = lastHistory.get(String(p.body.taskId))!
    if (last === p) return true
    sameAs.set(p, last)
    return false
  })
  return { sent, sameAs }
}

// まとめずに1本ずつ順番に送る(1件だけの時・GAS が batch を知らない時)
async function sendOneByOne(group: PendingWrite[], sent: PendingWrite[], sameAs: Map<PendingWrite, PendingWrite>, queuedMs: number): Promise<void> {
  const results = new Map<PendingWrite, { r?: GasResponse; err?: unknown }>()
  for (const p of sent) {
    try {
      results.set(p, { r: await sendWithRetry(p.url, p.body.action, JSON.stringify(p.body), maxAttemptsOf(p.body.action), queuedMs) })
    } catch (err) {
      results.set(p, { err })
    }
  }
  for (const p of group) {
    const out = results.get(sameAs.get(p) ?? p)!
    if (out.r) p.resolve(out.r)
    else p.reject(out.err)
  }
}

async function sendGroup(group: PendingWrite[]): Promise<void> {
  if (group.length === 0) return
  const queuedMs = Date.now() - group[0].queuedAt
  const { sent, sameAs } = coalesce(group)
  if (sent.length === 1 || batchUnsupported) {
    await sendOneByOne(group, sent, sameAs, queuedMs)
    return
  }
  const first = sent[0]
  const ops = sent.map((p) => {
    // セッション・画面の版は、まとめた本体に1回だけ入れる
    const { sessionToken: _s, clientVersion: _v, ...op } = p.body
    return op
  })
  const batch = {
    action: 'batch',
    sessionToken: first.body.sessionToken,
    clientVersion: first.body.clientVersion,
    ops,
    requestId: deps.newId(),
  }
  const label = `batch(${sent.map((p) => p.body.action).join('+')})`
  let r: GasResponse<{ results?: GasResponse[] }>
  try {
    r = await sendWithRetry<{ results?: GasResponse[] }>(first.url, 'batch', JSON.stringify(batch), maxAttemptsOf('batch'), queuedMs, label)
  } catch (err) {
    for (const p of group) p.reject(err)
    return
  }
  if (isBatchUnknownResponse(r)) {
    // 古い GAS(何も処理していない)。1本ずつ送り直し、このページではもうまとめない
    batchUnsupported = true
    deps.log.warn('[ohsumi] GAS が書き込みのまとめ送り(batch)に対応していないため、1本ずつ送ります。GAS を更新してください')
    await sendOneByOne(group, sent, sameAs, 0)
    return
  }
  const results = r.ok && Array.isArray(r.result?.results) && r.result!.results.length === sent.length ? r.result!.results : null
  const responseOf = (p: PendingWrite): GasResponse => {
    // まとめた本体が断られた(セッションが無効・画面の版が古いなど)時は、どの操作にも同じ応答を返す
    if (!results) return r.ok ? { ok: false, error: 'まとめて送った書き込みの結果を読めませんでした。' } : r
    const one = results[sent.indexOf(p)] ?? { ok: false, error: '結果がありません' }
    return { ...one, session: r.session, replayed: r.replayed }
  }
  for (const p of group) p.resolve(responseOf(sameAs.get(p) ?? p))
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

async function sendWithRetry<T>(
  url: string,
  action: string,
  body: string,
  maxAttempts: number,
  queuedMs: number,
  label: string = action,
): Promise<GasResponse<T>> {
  const started = Date.now()
  let reason = ''
  let bounced = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      // 送り返された読み取りは、GAS が何も処理していないので待たずに送り直す
      const immediate = bounced && !isWriteAction(action)
      deps.log.warn(`[ohsumi] GAS ${label}: 再試行 ${attempt - 1}/${maxAttempts - 1}${immediate ? '(すぐ送り直します)' : ''}(原因: ${reason})`)
      if (!immediate) await deps.sleep(RETRY_DELAYS_MS[attempt - 2] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])
    }
    const r = await attemptOnce(url, body, attemptTimeoutOf(action))
    if (r.kind === 'ok') {
      if (attempt > 1) deps.log.info(`[ohsumi] GAS ${label}: 再試行 ${attempt - 1}回目で成功しました`)
      if (r.json.replayed) deps.log.info(`[ohsumi] GAS ${label}: 前回の処理の結果を受け取りました(処理はやり直していません)`)
      deps.log.info(
        `[ohsumi] GAS ${label}: ${queuedMs + (Date.now() - started)}ms(列の待ち ${queuedMs}ms・往復 ${r.ms}ms(${describeRoundTrip(r.split)})・応答 ${r.kb}KB` +
          `${attempt > 1 ? `・${attempt}回目` : ''}・${describeTiming(r.json.timing)})`,
      )
      return r.json as GasResponse<T>
    }
    reason = r.reason
    bounced = r.bounced === true
    if (r.detail) deps.log.warn(`[ohsumi] GAS ${label}: ${r.reason}。${r.detail}`)
  }
  deps.log.error(`[ohsumi] GAS ${label}: ${maxAttempts}回送りましたが、応答を受け取れませんでした(原因: ${reason})`)
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
  if (isBatchableWrite(action)) return enqueueBatchableWrite<T>(url, payload)
  const text = JSON.stringify(payload)
  const task = (queuedMs: number) => sendWithRetry<T>(url, action, text, maxAttemptsOf(action), queuedMs)
  if (!READ_ACTIONS.has(action)) {
    writeEpoch++
    return enqueueWrite(task)
  }
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
