// レジストリの管理画面(/registry-admin/)から、レジストリの GAS へ送る処理。
//
// - 送り先はビルド時の NEXT_PUBLIC_REGISTRY_URL(団体の GAS とは別)
// - ログインは Google の ID トークン。OAuth クライアントはレジストリ用(NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID)
// - 管理画面のセッションは、このタブの sessionStorage にだけ保存する(30分で切れ、延長しない)
// - 読み取り(一覧)は、JSON が返らなければ2回まで送り直す。書き込み(登録コードの発行・取り消し)は
//   送り直さない(二重に発行しないため。失敗した時は一覧を読み直して確かめる)
import { FETCH_INIT } from '../ohsumi/gas-transport'

export const REGISTRY_URL = process.env.NEXT_PUBLIC_REGISTRY_URL
export const REGISTRY_CLIENT_ID = process.env.NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID
export const isRegistryAdminConfigured = !!REGISTRY_URL && !!REGISTRY_CLIENT_ID

export const ADMIN_NONCE_PREFIX = 'registry-admin.'
const SESSION_KEY = 'ohsumi-registry-admin-session'
const DRAFT_KEY = 'ohsumi-registry-admin-draft'
const TIMEOUT_MS = 45000

export interface AdminSession {
  token: string
  exp: number // Unix 秒
  email: string
  authAt: number // Google でログインした時刻(Unix 秒)
}

export type OrgState = 'active' | 'scheduled' | 'suspended'
export type CheckState = 'ok' | 'stale' | 'never'
export type CodeState = 'unused' | 'used' | 'expired' | 'revoked'

export interface OrgSummary {
  orgId: string
  displayName: string
  status: string
  state: OrgState
  checkState: CheckState
  contractStatus: string
  contractUntil: string
  contractNote: string
  lastCheckAt: string
  createdAt: string
  suspendAt: string
  suspendReason: string
  channel: string
  gasUrl: string
  gasVersion: string
}

export interface CodeSummary {
  codeId: string
  // new: 新しい団体の登録コード / reissue: 登録済みの団体の再登録コード(共有鍵の作り直し・接続先の変更)
  kind: string
  // 再登録コードの対象の団体ID
  targetOrgId?: string
  orgName: string
  contactName: string
  contactEmail: string
  note: string
  state: CodeState
  expiresAt: string
  issuedBy: string
  issuedAt: string
  usedAt: string
  usedOrgId: string
  revokedAt: string
  revokedBy: string
}

export interface AuditEntry {
  at: string
  actor: string
  action: string
  target: string
  before: string
  after: string
  reason: string
}

export interface Overview {
  me: { email: string; authAt: number; exp: number }
  orgs: OrgSummary[]
  codes: CodeSummary[]
  audit: AuditEntry[]
  codeTtlDays: number
}

export interface IssuedCode {
  code: string
  codeId: string
  expiresAt: string
  orgName: string
  kind?: 'new' | 'reissue'
  targetOrgId?: string
}

export interface IssueInput {
  // new: 新しい団体(団体名が必須) / reissue: 登録済みの団体の再登録(targetOrgId が必須。団体名はレジストリが入れる)
  kind?: 'new' | 'reissue'
  targetOrgId?: string
  orgName: string
  contactName: string
  contactEmail: string
  note: string
}

/** レジストリが返した失敗。authError はセッションが無効、reauthRequired は Google でのログインし直しが必要 */
export class RegistryError extends Error {
  constructor(
    message: string,
    readonly authError = false,
    readonly reauthRequired = false,
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

interface RegistryResponse<T> {
  ok: boolean
  result?: T
  error?: string
  authError?: boolean
  reauthRequired?: boolean
  getReceived?: boolean
  retryLater?: boolean
}

type Fetcher = (url: string, init: RequestInit) => Promise<Pick<Response, 'text' | 'status'>>
let fetcher: Fetcher = (url, init) => fetch(url, init)

export function setRegistryFetchForTest(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init))
}

async function sendOnce<T>(body: Record<string, unknown>): Promise<RegistryResponse<T> | null> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(REGISTRY_URL!, { ...FETCH_INIT, body: JSON.stringify(body), signal: controller?.signal })
    const text = await res.text()
    try {
      const json = JSON.parse(text) as RegistryResponse<T>
      if (!json || typeof json !== 'object' || json.getReceived || json.retryLater) return null
      return json
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** レジストリへ送る。retry: JSON が返らなければ、あと何回送り直すか */
export async function callRegistry<T>(action: string, payload: Record<string, unknown>, retry = 0): Promise<T> {
  if (!REGISTRY_URL) throw new RegistryError('レジストリの URL(NEXT_PUBLIC_REGISTRY_URL)が設定されていません。')
  for (let attempt = 0; attempt <= retry; attempt++) {
    const json = await sendOnce<T>({ action, ...payload })
    if (!json) continue
    if (!json.ok) throw new RegistryError(json.error || 'レジストリで処理できませんでした。', !!json.authError, !!json.reauthRequired)
    return json.result as T
  }
  throw new RegistryError('レジストリから応答を受け取れませんでした。少し待ってから、もう一度試してください。')
}

// ---- ログイン(nonce) ----

function base64Url(bytes: Uint8Array): string {
  let s = ''
  bytes.forEach((b) => { s += String.fromCharCode(b) })
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** ログイン1回分の乱数と、ID トークンに入れる nonce('registry-admin.' + base64url(SHA-256(乱数))) */
export async function createAdminNonce(): Promise<{ nonce: string; secret: string }> {
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  const secret = base64Url(random)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return { nonce: ADMIN_NONCE_PREFIX + base64Url(digest), secret }
}

export async function adminLogin(idToken: string, nonceSecret: string): Promise<AdminSession> {
  const res = await callRegistry<{ session: AdminSession }>('adminLogin', { idToken, nonceSecret })
  saveAdminSession(res.session)
  return res.session
}

export function adminOverview(session: AdminSession): Promise<Overview> {
  return callRegistry<Overview>('adminOverview', { session: session.token }, 2)
}

export function issueRegistrationCode(session: AdminSession, input: IssueInput): Promise<IssuedCode> {
  return callRegistry<IssuedCode>('issueRegistrationCode', { session: session.token, ...input })
}

export function revokeRegistrationCode(session: AdminSession, codeId: string, reason: string): Promise<{ codeId: string }> {
  return callRegistry<{ codeId: string }>('revokeRegistrationCode', { session: session.token, codeId, reason })
}

// ---- このタブに保存するもの ----

function tabStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function saveAdminSession(session: AdminSession) {
  try { tabStorage()?.setItem(SESSION_KEY, JSON.stringify(session)) } catch { /* 保存できなくても、この画面の間は使える */ }
}

export function loadAdminSession(nowSec = Math.floor(Date.now() / 1000)): AdminSession | null {
  try {
    const raw = tabStorage()?.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as AdminSession
    if (!s?.token || !(s.exp > nowSec)) {
      tabStorage()?.removeItem(SESSION_KEY)
      return null
    }
    return s
  } catch {
    return null
  }
}

export function clearAdminSession() {
  try { tabStorage()?.removeItem(SESSION_KEY) } catch { /* ignore */ }
}

/** 登録コードの発行の前に、ログインし直しが必要か(5分以内に Google でログインしたか) */
export function needsReauth(session: AdminSession, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return nowSec - session.authAt > 5 * 60
}

// 発行の入力の途中でログインし直す時に、入力を残す(このタブだけ)
export function saveIssueDraft(input: IssueInput) {
  try { tabStorage()?.setItem(DRAFT_KEY, JSON.stringify(input)) } catch { /* ignore */ }
}

export function takeIssueDraft(): IssueInput | null {
  try {
    const raw = tabStorage()?.getItem(DRAFT_KEY)
    tabStorage()?.removeItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as IssueInput) : null
  } catch {
    return null
  }
}
