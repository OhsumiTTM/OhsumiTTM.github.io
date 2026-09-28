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

/**
 * Googleでログイン(IDトークン)を準備する。nonce は1回のログインごとに作り直す
 * ため、ログインが終わるたび(成功・失敗とも)に呼び直す。
 * shouldAutoPrompt() が true なら、自動ログイン・One Tap も試す(以前このアプリにログインし、
 * ブラウザの Google アカウントが1つの場合は、クリックなしでログインできる)。
 */
export async function prepareGoogleSignIn(options: {
  orgId: string
  button: HTMLElement | null
  // 自動ログイン・One Tap を試すか(直前に確かめる。画面が変わった場合などは試さない)
  shouldAutoPrompt: () => boolean
  locale?: string
  onCredential: (idToken: string, secret: string) => void
}): Promise<void> {
  if (!CLIENT_ID) throw new Error('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID が設定されていません')
  await waitForGIS()
  const id = window.google?.accounts?.id
  if (!id) throw new Error('Google Identity Services を読み込めませんでした')
  const { nonce, secret } = await createLoginNonce(options.orgId)
  id.initialize({
    client_id: CLIENT_ID,
    nonce,
    auto_select: true,
    use_fedcm_for_prompt: true,
    itp_support: true,
    cancel_on_tap_outside: true,
    callback: (response) => {
      if (response.credential) options.onCredential(response.credential, secret)
    },
  })
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
  if (options.shouldAutoPrompt()) id.prompt()
}
