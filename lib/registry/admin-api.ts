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

// restricted: 機能停止中(読み取り専用)。suspended: 提供停止中
export type OrgState = 'active' | 'scheduled' | 'restricted' | 'suspended'
// 停止の種類(R1-e)。suspend: 提供停止(契約の終了・規約違反など)/ restrict: 機能停止(アンケートの未回答など)
export type SuspendKind = 'suspend' | 'restrict'
// プラン(利用契約書の案 第3条)。空は未設定。有償(paid)の団体には、機能停止を入れられない
export type Plan = 'cosmo_base' | 'ohsumi' | 'paid'
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
  // 停止の種類(停止の予定・停止中の時)
  suspendKind: SuspendKind
  plan: Plan | ''
  suspendScheduledBy: string
  // 送った予告(停止の何日前か。14・7・1)
  noticesSent: number[]
  channel: string
  gasUrl: string
  gasVersion: string
  // メールの1日の上限(団体の GAS が checkIn で伝えたもの。古いレジストリでは無い)
  mail?: OrgMailSummary
}

// reached: 最後に伝えられた日に上限に達した / low: 残りが少ない / ok / unknown: 伝えられていない
export type MailLevel = 'reached' | 'low' | 'ok' | 'unknown'

export interface OrgMailSummary {
  // 最後の確認の時の残りの数(分からなければ null)
  remaining: number | null
  // その日(date)に上限で送れなかった数
  skipped: number
  date: string
  // 最後に上限に達した日
  limitDate: string
  level: MailLevel
}

/** メールの上限に達した・近い団体の数(一覧の上に出す) */
export function mailLevelCounts(orgs: Pick<OrgSummary, 'mail'>[]): { reached: number; low: number } {
  let reached = 0
  let low = 0
  for (const o of orgs) {
    if (o.mail?.level === 'reached') reached++
    else if (o.mail?.level === 'low') low++
  }
  return { reached, low }
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

export interface SuspensionInput {
  orgId: string
  kind: SuspendKind
  suspendAt: string // ISO(当日の停止では使わない)
  reason: string
  // 当日の停止(緊急。提供停止だけ)。確認の画面を経た時だけ confirm を付けて送る
  immediate?: boolean
}

/** 停止の予定を入れる(今から14日より後。5分以内の Google でのログインが必要)。送り直さない */
export function scheduleSuspension(session: AdminSession, input: SuspensionInput): Promise<OrgSummary> {
  return callRegistry<OrgSummary>('scheduleSuspension', { session: session.token, ...input })
}

/** 提供停止を当日に行う(緊急)。確認の画面を経た時だけ呼ぶ。送り直さない */
export function suspendNow(session: AdminSession, orgId: string, reason: string): Promise<OrgSummary> {
  return callRegistry<OrgSummary>('scheduleSuspension', { session: session.token, orgId, kind: 'suspend', immediate: true, confirm: true, reason })
}

/** 団体のプランを記録する。送り直さない */
export function setOrgPlan(session: AdminSession, orgId: string, plan: Plan, reason: string): Promise<OrgSummary> {
  return callRegistry<OrgSummary>('setOrgPlan', { session: session.token, orgId, plan, reason })
}

/** 停止の予定を取り消す・停止を解除する。送り直さない */
export function clearSuspension(session: AdminSession, orgId: string, reason: string): Promise<OrgSummary> {
  return callRegistry<OrgSummary>('clearSuspension', { session: session.token, orgId, reason })
}

// 停止の予定を入れられる、いちばん早い日時(今から14日後。datetime-local の値 'YYYY-MM-DDTHH:mm')
export const SUSPEND_MIN_NOTICE_DAYS = 14
export function earliestSuspendLocal(nowMs = Date.now()): string {
  const d = new Date(nowMs + SUSPEND_MIN_NOTICE_DAYS * 24 * 3600 * 1000 + 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
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

// 停止の予定の入力の途中でログインし直す時に、入力を残す(このタブだけ)
const SUSPEND_DRAFT_KEY = 'ohsumi-registry-admin-suspend-draft'

export function saveSuspensionDraft(input: SuspensionInput) {
  try { tabStorage()?.setItem(SUSPEND_DRAFT_KEY, JSON.stringify(input)) } catch { /* ignore */ }
}

export function takeSuspensionDraft(): SuspensionInput | null {
  try {
    const raw = tabStorage()?.getItem(SUSPEND_DRAFT_KEY)
    tabStorage()?.removeItem(SUSPEND_DRAFT_KEY)
    return raw ? (JSON.parse(raw) as SuspensionInput) : null
  } catch {
    return null
  }
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
