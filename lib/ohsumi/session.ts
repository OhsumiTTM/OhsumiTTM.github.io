// ログイン(IDトークン方式)とセッショントークンの扱い。
//
// 1. getLoginConfig で団体ID(orgId)を取得する(このブラウザにも覚えておく)
// 2. 乱数 secret を作り、nonce = orgId + "." + base64url(SHA-256(secret)) を指定して
//    Google Identity Services(google.accounts.id)から IDトークンを受け取る
// 3. exchangeIdToken に IDトークンと secret を送ると、団体の GAS がセッショントークンを返す
// 4. 以降の通信はセッショントークンで行う(lib/ohsumi/remote.ts の postToGas)
//
// セッショントークンの保存場所:
//   「この端末にログイン情報を保存する」あり → localStorage(再読み込み・再起動後もログインしたまま)
//   なし → sessionStorage(タブを閉じると消える)
// キーは団体ごとに分ける(ohsumi-session-<orgId>)。
'use client'

import { CLIENT_ID, waitForGIS } from './google-sheet-sync'

export interface LoginConfig {
  orgId: string
}

export interface StoredSession {
  token: string
  exp: number // Unix 秒
  remember: boolean
}

const LOGIN_CONFIG_KEY = 'ohsumi-login-config'
const REMEMBER_PREF_KEY = 'ohsumi-remember-login'
const SESSION_KEY_PREFIX = 'ohsumi-session-'

function sessionKey(orgId: string) {
  return `${SESSION_KEY_PREFIX}${orgId}`
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

// ---- 団体の設定 ----------------------------------------------------------------

export function loadCachedLoginConfig(): LoginConfig | null {
  try {
    const raw = safeStorage('local')?.getItem(LOGIN_CONFIG_KEY)
    const v = raw ? (JSON.parse(raw) as Partial<LoginConfig>) : null
    return v && typeof v.orgId === 'string' && v.orgId ? { orgId: v.orgId } : null
  } catch {
    return null
  }
}

export function saveLoginConfig(config: LoginConfig): void {
  try {
    safeStorage('local')?.setItem(LOGIN_CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* ignore */
  }
}

// ---- 「この端末にログイン情報を保存する」の前回の選択(初期値はチェックあり) --------

export function loadRememberPreference(): boolean {
  try {
    return safeStorage('local')?.getItem(REMEMBER_PREF_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveRememberPreference(remember: boolean): void {
  try {
    safeStorage('local')?.setItem(REMEMBER_PREF_KEY, remember ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

// ---- セッショントークン ----------------------------------------------------------

let active: { orgId: string; session: StoredSession } | null = null

const nowSec = () => Math.floor(Date.now() / 1000)

/** 保存されているセッション(期限切れは消して null)。localStorage → sessionStorage の順に探す */
export function loadSession(orgId: string): StoredSession | null {
  for (const kind of ['local', 'session'] as const) {
    const storage = safeStorage(kind)
    try {
      const raw = storage?.getItem(sessionKey(orgId))
      if (!raw) continue
      const v = JSON.parse(raw) as Partial<StoredSession>
      if (typeof v.token === 'string' && typeof v.exp === 'number' && v.exp > nowSec()) {
        return { token: v.token, exp: v.exp, remember: kind === 'local' }
      }
      storage?.removeItem(sessionKey(orgId))
    } catch {
      /* ignore */
    }
  }
  return null
}

/** この端末に、使えるセッションが保存されているか(再読み込み後に自動でログインし直せるか) */
export function hasSavedSession(): boolean {
  const config = loadCachedLoginConfig()
  return !!config && !!loadSession(config.orgId)
}

/** セッションを保存し、以降の通信で使う */
export function saveSession(orgId: string, session: StoredSession): void {
  active = { orgId, session }
  const target = safeStorage(session.remember ? 'local' : 'session')
  const other = safeStorage(session.remember ? 'session' : 'local')
  try {
    other?.removeItem(sessionKey(orgId))
    target?.setItem(sessionKey(orgId), JSON.stringify(session))
  } catch {
    /* 保存できなくても、このタブの間はメモリ上のセッションで使える */
  }
}

/** 保存済みのセッションを、以降の通信で使うようにする */
export function activateSession(orgId: string, session: StoredSession): void {
  active = { orgId, session }
}

/** 延長されたトークン(GAS の応答の session)に差し替える。保存場所は元のまま */
export function applyRenewedSession(renewed: { token: string; exp: number }): void {
  if (!active) return
  saveSession(active.orgId, { ...active.session, token: renewed.token, exp: renewed.exp })
}

export function getSessionToken(): string | null {
  if (!active) return null
  if (active.session.exp <= nowSec()) return null
  return active.session.token
}

export function getActiveOrgId(): string | null {
  return active?.orgId ?? null
}

/** この端末のログインを終える(保存したトークンを消し、Google の自動ログインも止める) */
export function clearSession(orgId?: string | null): void {
  const target = orgId ?? active?.orgId
  active = null
  // 次のログインは新しい nonce で準備する
  resetGoogleSignIn()
  if (target) {
    for (const kind of ['local', 'session'] as const) {
      try {
        safeStorage(kind)?.removeItem(sessionKey(target))
      } catch {
        /* ignore */
      }
    }
  }
  try {
    window.google?.accounts?.id?.disableAutoSelect()
  } catch {
    /* ignore */
  }
}

// ---- nonce ----------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let bin = ''
  bytes.forEach((b) => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** IDトークンの nonce(団体ID + この画面だけが知る乱数のハッシュ)と、GAS に送る乱数を作る */
export async function createLoginNonce(orgId: string): Promise<{ nonce: string; secret: string }> {
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  const secret = base64Url(random)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return { nonce: `${orgId}.${base64Url(digest)}`, secret }
}

// ---- Google Identity Services(IDトークン) -------------------------------------
//
// google.accounts.id.initialize() は「1回のログインの試行」につき1回だけ呼ぶ。
//   - 画面の再描画やログイン画面の作り直しでは呼び直さない(同じ試行を使い続け、
//     ボタンの表示だけやり直す)。initialize を呼び直すと、表示中の自動ログイン・
//     One Tap(FedCM)が中断され、以前の nonce で発行された IDトークンが新しい
//     callback に届くことがあるため
//   - 新しい試行(新しい nonce と乱数)にするのは、ログインに失敗した時と、
//     ログアウト・セッション切れ(clearSession)の後だけ。乱数は使い回さない
//   - 受け取った IDトークンの nonce が、この試行の nonce と一致する時だけ乱数を送る
//     (IDトークンの nonce と送る乱数が必ず対応する)

interface SignInAttempt {
  orgId: string
  nonce: string
  secret: string
  // ready: IDトークン待ち / used: IDトークンを受け取り、乱数を送った(再利用しない)
  status: 'ready' | 'used'
}

interface SignInHandlers {
  onCredential: (idToken: string, secret: string) => void
  // IDトークンの nonce が今の試行と一致しない(古い試行の IDトークン)。乱数は送らない
  onNonceMismatch?: () => void
}

let attempt: SignInAttempt | null = null
// このページで initialize を呼んだか。ログアウト・セッション切れでログイン画面に戻る時は、
// ページを読み込み直して、新しい試行の initialize をそのページの1回目にする(同じページで2回呼ばない)
let initializedThisPage = false
let creating: { orgId: string; promise: Promise<SignInAttempt | null> } | null = null
let handlers: SignInHandlers | null = null

/** IDトークンの nonce(署名は確かめない。検証は GAS が行う) */
export function nonceOfIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0))
    const nonce = (JSON.parse(new TextDecoder().decode(bytes)) as { nonce?: unknown }).nonce
    return typeof nonce === 'string' ? nonce : null
  } catch {
    return null
  }
}

function handleCredential(response: { credential?: string }) {
  const current = attempt
  if (!response.credential || !current || !handlers) return
  // この試行の乱数は送った後。同じ乱数は2回送らない(ログインの処理はそのまま続ける)
  if (current.status !== 'ready') return
  if (nonceOfIdToken(response.credential) !== current.nonce) {
    handlers.onNonceMismatch?.()
    return
  }
  current.status = 'used'
  handlers.onCredential(response.credential, current.secret)
}

async function createAttempt(orgId: string): Promise<SignInAttempt | null> {
  const id = window.google?.accounts?.id
  if (!id) throw new Error('Google Identity Services を読み込めませんでした')
  const { nonce, secret } = await createLoginNonce(orgId)
  // 待っている間に別の試行に切り替わった(団体IDが変わった・ログアウトした)場合は使わない
  if (creating?.orgId !== orgId) return null
  id.initialize({
    client_id: CLIENT_ID!,
    nonce,
    auto_select: true,
    use_fedcm_for_prompt: true,
    itp_support: true,
    cancel_on_tap_outside: true,
    callback: handleCredential,
  })
  initializedThisPage = true
  attempt = { orgId, nonce, secret, status: 'ready' }
  return attempt
}

/** このページで google.accounts.id.initialize() を呼んだか */
export function googleSignInInitializedThisPage(): boolean {
  return initializedThisPage
}

/** ページを読み込み直す(ログイン画面を新しいページで出す) */
export function reloadPage(): void {
  try {
    window.location.reload()
  } catch {
    /* テストの環境など、読み込み直せない時は何もしない */
  }
}

/** 今のログインの試行を終える。次に prepareGoogleSignIn を呼ぶと、新しい nonce で準備し直す */
export function resetGoogleSignIn(): void {
  attempt = null
  creating = null
}

/**
 * Googleでログイン(IDトークン)を準備する。準備済みの試行があれば initialize は呼ばず、
 * ボタンの表示と callback の差し替えだけ行う(何度呼んでもよい)。
 * ログインに失敗した後は resetGoogleSignIn() を呼んでから呼び直す。
 * shouldAutoPrompt() が true なら、新しく準備した時だけ自動ログイン・One Tap も試す
 * (以前このアプリにログインし、ブラウザの Google アカウントが1つの場合は、クリックなしでログインできる)。
 */
export async function prepareGoogleSignIn(options: {
  orgId: string
  button: HTMLElement | null
  // 自動ログイン・One Tap を試すか(直前に確かめる。画面が変わった場合などは試さない)
  shouldAutoPrompt: () => boolean
  locale?: string
  onCredential: (idToken: string, secret: string) => void
  onNonceMismatch?: () => void
}): Promise<void> {
  if (!CLIENT_ID) throw new Error('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID が設定されていません')
  await waitForGIS()
  handlers = { onCredential: options.onCredential, onNonceMismatch: options.onNonceMismatch }
  let created = false
  if (attempt?.orgId !== options.orgId) {
    if (creating?.orgId !== options.orgId) {
      const next = { orgId: options.orgId, promise: createAttempt(options.orgId) }
      creating = next
      // 失敗した場合は、次に呼んだ時に作り直す
      next.promise.catch(() => {
        if (creating === next) creating = null
      })
      created = true
    }
    const result = await creating.promise
    if (!result || result !== attempt) return
  }
  // IDトークンを受け取って交換中(またはログイン済み)なら、ボタンは出し直さない
  const current = attempt
  if (!current || current.orgId !== options.orgId || current.status !== 'ready') return
  const id = window.google!.accounts!.id!
  if (options.button) {
    options.button.innerHTML = ''
    id.renderButton(options.button, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'rectangular',
      width: 300,
      locale: options.locale,
    })
  }
  if (created && options.shouldAutoPrompt()) id.prompt()
}
