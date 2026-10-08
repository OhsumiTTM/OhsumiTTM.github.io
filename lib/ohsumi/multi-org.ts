// 兼部の統合表示(docs/design-multi-org-view.md)。
//
// - この端末に保存している団体(org-directory.ts の ohsumi-orgs)のうち、ログインが残っている団体ごとに、
//   その団体の GAS に getMyDigest(本人の分だけ。gas/src/40-my-digest.gs)を送り、答えを画面の中でだけまとめる
// - まとめた結果は、このページのメモリにだけ置く(端末にもサーバーにも保存しない)。サーバーは足さない
// - 同時に送るのは4団体まで。1団体15秒で答えが無ければ、その団体だけ「読み込めませんでした」にする
// - ログインが切れた団体は、その団体に切り替えずに、小さい窓(/?org=<団体ID>&relogin=1)でログインし直せる。
//   窓はログインした後、セッションを開いた画面に postMessage で渡して閉じる(同じオリジンだけ受け取る)
// - ほかの団体のタスクを開く時は、その団体に切り替えて(読み込み直して)、そのタスクを開く
import { CLIENT_VERSION } from './codes'
import { sendToGas, type GasResponse } from './gas-transport'
import { getCurrentOrgId, loadSavedOrgs, type SavedOrg } from './org-directory'
import { loadSession, storeSessionFor, type StoredSession } from './session'

export type DigestRole = 'assignee' | 'reviewTarget' | 'invitee'

export interface DigestCandidate {
  id: string
  label: string
  date: string
  startTime: string
  endTime: string
}

export interface DigestTask {
  id: string
  title: string
  status: string
  role: DigestRole
  overdue: boolean
  dueDate: string
  dueTime: string
  startDate: string
  priority: string
  importance: string
  projectName: string
  candidates?: DigestCandidate[] | null
  inviteKind?: 'schedule' | 'form'
}

export interface MyDigest {
  orgName: string
  themeColor: string
  memberId: string
  memberName: string
  contract: { phase: string; kind: string }
  tasks: DigestTask[]
  truncated: boolean
  counts: { assigned: number; reviewWaiting: number; overdue: number; unanswered: number }
  version: string
}

// 団体ごとの読み込みの結果
export type OrgDigestState =
  | { kind: 'loading' }
  | { kind: 'ok'; digest: MyDigest }
  // ログインが無い・切れた(小さい窓でログインし直せる)
  | { kind: 'loginNeeded' }
  // 提供停止中
  | { kind: 'suspended' }
  // 団体の GAS が古い(getMyDigest が無い)
  | { kind: 'oldGas' }
  // 答えが無い・失敗した
  | { kind: 'error'; message: string }

export interface DigestOrg {
  orgId: string
  gasUrl: string
  name: string
  current: boolean
}

export const DIGEST_TIMEOUT_MS = 15000
export const DIGEST_CONCURRENCY = 4
export const DIGEST_DAYS = 28
export const RELOGIN_MESSAGE_TYPE = 'ohsumi-relogin'
const OPEN_TASK_KEY = 'ohsumi-open-task'

/** 統合表示に出す団体(今の団体が先頭。あとは最後に使った順) */
export function digestOrgs(): DigestOrg[] {
  const current = getCurrentOrgId()
  const list = loadSavedOrgs()
  const sorted = [...list.filter((o) => o.orgId === current), ...list.filter((o) => o.orgId !== current)]
  return sorted.map((o) => ({ orgId: o.orgId, gasUrl: o.gasUrl, name: o.name || '', current: o.orgId === current }))
}

/** 切り替えを出すか: この端末に団体が2つ以上ある時だけ(兼部していない人には出さない) */
export function hasMultipleOrgs(): boolean {
  return loadSavedOrgs().length >= 2
}

/** 団体名の短い表示(4文字まで) */
export function shortOrgName(name: string): string {
  const chars = Array.from(name.trim())
  return chars.length <= 4 ? chars.join('') : chars.slice(0, 4).join('')
}

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function digestRange(now: Date): { from: string; to: string } {
  const to = new Date(now.getTime())
  to.setDate(to.getDate() + DIGEST_DAYS)
  return { from: localDate(now), to: localDate(to) }
}

// ---- 読み込み ------------------------------------------------------------------------

// このページのメモリだけに置く、団体ごとの前回の答え(データの版が同じなら、GAS は unchanged だけを返す)
const memory = new Map<string, { from: string; digest: MyDigest }>()

export function clearDigestMemoryForTest(): void {
  memory.clear()
}

type Sender = (url: string, body: Record<string, unknown> & { action: string }) => Promise<GasResponse<unknown>>
let sender: Sender = (url, body) => sendToGas(url, body)

export function setDigestSenderForTest(s: Sender | null): void {
  sender = s ?? ((url, body) => sendToGas(url, body))
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 1つの団体の getMyDigest を読む(ログインが無ければ送らない) */
export async function fetchOrgDigest(org: Pick<DigestOrg, 'orgId' | 'gasUrl'>, now: Date = new Date(), timeoutMs = DIGEST_TIMEOUT_MS): Promise<OrgDigestState> {
  const session = loadSession(org.orgId)
  if (!session) return { kind: 'loginNeeded' }
  const range = digestRange(now)
  const prev = memory.get(org.orgId)
  const knownVersion = prev && prev.from === range.from ? prev.digest.version : undefined
  let json: GasResponse<unknown> | 'timeout'
  try {
    json = await withTimeout(
      sender(org.gasUrl, { action: 'getMyDigest', sessionToken: session.token, clientVersion: CLIENT_VERSION, ...range, ...(knownVersion ? { knownVersion } : {}) }),
      timeoutMs,
    )
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if (json === 'timeout') return { kind: 'error', message: 'timeout' }
  // 延長されたトークンは、その団体の保存に入れる(保存場所は元のまま)
  if (json.session && typeof json.session === 'object') {
    const renewed = json.session as { token?: unknown; exp?: unknown }
    if (typeof renewed.token === 'string' && typeof renewed.exp === 'number') storeSessionFor(org.orgId, { token: renewed.token, exp: renewed.exp, remember: session.remember })
  }
  if (!json.ok) {
    if (json.authError) return { kind: 'loginNeeded' }
    if (json.orgSuspended) return { kind: 'suspended' }
    if (/^Unknown action/.test(String(json.error ?? ''))) return { kind: 'oldGas' }
    return { kind: 'error', message: String(json.error ?? '') }
  }
  const result = json.result as (MyDigest & { unchanged?: boolean }) | undefined
  if (!result) return { kind: 'error', message: '' }
  if (result.unchanged && prev) return { kind: 'ok', digest: prev.digest }
  if (!Array.isArray(result.tasks)) return { kind: 'error', message: '' }
  memory.set(org.orgId, { from: range.from, digest: result })
  return { kind: 'ok', digest: result }
}

/** 団体ごとに読む(同時に DIGEST_CONCURRENCY 団体まで)。1団体読むごとに onResult を呼ぶ */
export async function fetchAllDigests(
  orgs: Pick<DigestOrg, 'orgId' | 'gasUrl'>[],
  onResult: (orgId: string, state: OrgDigestState) => void,
  now: Date = new Date(),
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < orgs.length) {
      const org = orgs[next++]
      onResult(org.orgId, await fetchOrgDigest(org, now))
    }
  }
  await Promise.all(Array.from({ length: Math.min(DIGEST_CONCURRENCY, orgs.length) }, worker))
}

// ---- まとめる(純粋な関数) ---------------------------------------------------------

export interface CombinedTask extends DigestTask {
  orgId: string
  orgName: string
  themeColor: string
}

export interface CombinedDigest {
  // 期限切れ・今日が期限(担当)
  today: CombinedTask[]
  // 確認待ち(本人が確認する人)
  review: CombinedTask[]
  // 日程調整・フォームの回答待ち(日程調整の候補は「予定」に出さず、ここに出す)
  unanswered: CombinedTask[]
  // これから7日の予定(担当で、期限か開始日が7日以内)
  week: CombinedTask[]
  // 団体ごとの数
  perOrg: { orgId: string; orgName: string; themeColor: string; counts: MyDigest['counts'] | null; state: OrgDigestState['kind'] }[]
}

const byDue = (a: CombinedTask, b: CombinedTask) => (a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99') || (a.dueTime || '').localeCompare(b.dueTime || '')

export function combineDigests(orgs: DigestOrg[], states: Record<string, OrgDigestState | undefined>, today: string): CombinedDigest {
  const weekEnd = (() => {
    const d = new Date(today + 'T00:00:00')
    d.setDate(d.getDate() + 7)
    return localDate(d)
  })()
  const out: CombinedDigest = { today: [], review: [], unanswered: [], week: [], perOrg: [] }
  for (const org of orgs) {
    const state = states[org.orgId] ?? { kind: 'loading' as const }
    const digest = state.kind === 'ok' ? state.digest : null
    const orgName = digest?.orgName || org.name
    const themeColor = digest?.themeColor || ''
    out.perOrg.push({ orgId: org.orgId, orgName, themeColor, counts: digest?.counts ?? null, state: state.kind })
    for (const t of digest?.tasks ?? []) {
      const task: CombinedTask = { ...t, orgId: org.orgId, orgName, themeColor }
      if (t.role === 'invitee') out.unanswered.push(task)
      else if (t.role === 'reviewTarget') out.review.push(task)
      else if (t.overdue || (t.dueDate && t.dueDate <= today)) out.today.push(task)
      else if ((t.dueDate && t.dueDate <= weekEnd) || (t.startDate && t.startDate >= today && t.startDate <= weekEnd)) out.week.push(task)
    }
  }
  out.today.sort(byDue)
  out.review.sort(byDue)
  out.unanswered.sort(byDue)
  out.week.sort((a, b) => (a.dueDate || a.startDate).localeCompare(b.dueDate || b.startDate))
  return out
}

// ---- ほかの団体のタスクを開く ----------------------------------------------------------

/** 切り替えた後に開くタスクを覚える(このタブだけ) */
export function rememberTaskToOpen(orgId: string, taskId: string): void {
  try { window.sessionStorage.setItem(OPEN_TASK_KEY, JSON.stringify({ orgId, taskId })) } catch { /* 開けないだけ */ }
}

/** 切り替えた後に開くタスク(今の団体の分だけ。1回だけ) */
export function takeTaskToOpen(orgId: string | null): string | null {
  try {
    const raw = window.sessionStorage.getItem(OPEN_TASK_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(OPEN_TASK_KEY)
    const v = JSON.parse(raw) as { orgId?: unknown; taskId?: unknown }
    return v.orgId === orgId && typeof v.taskId === 'string' ? v.taskId : null
  } catch {
    return null
  }
}

// ---- 切り替えずにログインし直す -------------------------------------------------------

export interface ReloginMessage {
  type: typeof RELOGIN_MESSAGE_TYPE
  orgId: string
  session: StoredSession
}

export function reloginUrl(orgId: string, base: string = typeof window !== 'undefined' ? window.location.pathname : '/'): string {
  return `${base.replace(/\/?$/, '/')}?org=${encodeURIComponent(orgId)}&relogin=1`
}

/** ログインし直す窓の URL か */
export function isReloginSearch(search: string): boolean {
  const p = new URLSearchParams(search)
  return p.get('relogin') === '1' && !!p.get('org')
}

/** 窓から受け取ったメッセージを確かめる(同じオリジン・この端末の団体・形が正しい時だけ) */
export function parseReloginMessage(e: { origin: string; data: unknown }, origin: string, saved: SavedOrg[] = loadSavedOrgs()): ReloginMessage | null {
  if (e.origin !== origin) return null
  const d = e.data as Partial<ReloginMessage> | null
  if (!d || typeof d !== 'object' || d.type !== RELOGIN_MESSAGE_TYPE || typeof d.orgId !== 'string') return null
  if (!saved.some((o) => o.orgId === d.orgId)) return null
  const s = d.session as Partial<StoredSession> | undefined
  if (!s || typeof s.token !== 'string' || typeof s.exp !== 'number') return null
  return { type: RELOGIN_MESSAGE_TYPE, orgId: d.orgId, session: { token: s.token, exp: s.exp, remember: s.remember === true } }
}
