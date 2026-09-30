// 接続先の団体(R1-d)。団体ID から、その団体の GAS の URL を決める。
//
// - この端末の「所属する団体の一覧」(localStorage の ohsumi-orgs)に、団体ID・接続先・団体名・確かめた時刻を保存する。
//   今使っている団体は ohsumi-current-org
// - 招待リンク(<サイトの URL>/?org=<団体ID>)で開いた時: 一覧に無ければ、レジストリ(resolveOrg)に問い合わせて待つ
//   (初めての端末だけ)。開いた後は、アドレスバーから ?org= を消す
// - 一覧にある団体は、問い合わせずにすぐ使う。確かめてから maxAgeSec(24時間)を過ぎていれば、ログイン・再開と
//   並べて裏で問い合わせ、答えが違った時(接続先が変わった・停止・見つからない)だけ、ログインし直してもらう
// - レジストリが止まっている時: 一覧にあればそのまま使う。初めての端末では「接続先を確認できません」と再試行を出す
// - ビルド時の NEXT_PUBLIC_GAS_URL(GitHub Secrets の CSV_GAS)は「既定の団体」。招待リンクも一覧の団体も無い端末は、
//   今までどおりここにつながる(R1-f まで)。団体ID は、その GAS の getLoginConfig で分かった時に一覧に入れる
// - レジストリから分かった接続先は、初めて使う前に、その GAS の getLoginConfig の団体ID が同じか確かめる
// - ログインの情報(セッション)は団体ごとに分けて保存する(session.ts の ohsumi-session-<団体ID>)。
//   団体を切り替える時は、ページを読み込み直す(Google のログインの準備は1ページに1回のため)
import { FETCH_INIT } from './gas-transport'
import { CANONICAL_GAS_URL } from './gas-url'

export const DEFAULT_GAS_URL = process.env.NEXT_PUBLIC_GAS_URL || ''
export const REGISTRY_URL = process.env.NEXT_PUBLIC_REGISTRY_URL || ''

export const ORG_ID_PATTERN = /^org_[A-Za-z0-9_-]{16,64}$/
export const ORGS_STORAGE_KEY = 'ohsumi-orgs'
export const CURRENT_ORG_STORAGE_KEY = 'ohsumi-current-org'
// R1-d より前の、既定の団体の団体ID(session.ts が保存していた)
export const LEGACY_LOGIN_CONFIG_KEY = 'ohsumi-login-config'
// 読み込み直した後のログイン画面に出す知らせ(このタブだけ)
export const LOGIN_NOTICE_KEY = 'ohsumi-login-notice'
// 接続先が変わった・停止した時に window に送るイベント(store.tsx がログイン画面に戻す)
export const ORG_CHANGED_EVENT = 'ohsumi:org-changed'
const DEFAULT_MAX_AGE_SEC = 24 * 3600
const REGISTRY_TIMEOUT_MS = 20000

export interface SavedOrg {
  orgId: string
  gasUrl: string
  // 団体名(ログインの後に分かる。ログイン画面の一覧に出す)
  name?: string
  // registry: 招待リンクからレジストリで調べた / default: ビルド時の既定の団体
  source: 'registry' | 'default'
  checkedAt: number // ミリ秒
  maxAgeSec?: number
}

export type LoginNotice = 'orgMoved' | 'orgSuspended' | 'orgNotFound'

// ---- 保存 ----------------------------------------------------------------------

function storage(kind: 'local' | 'session' = 'local'): Storage | null {
  try {
    return typeof window === 'undefined' ? null : kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

function isSavedOrg(v: unknown): v is SavedOrg {
  const o = v as Partial<SavedOrg> | null
  return !!o && typeof o.orgId === 'string' && ORG_ID_PATTERN.test(o.orgId) && typeof o.gasUrl === 'string' &&
    CANONICAL_GAS_URL.test(o.gasUrl) && (o.source === 'registry' || o.source === 'default') && typeof o.checkedAt === 'number'
}

/** この端末の、所属する団体の一覧(最後に使った順) */
export function loadSavedOrgs(): SavedOrg[] {
  try {
    const raw = storage()?.getItem(ORGS_STORAGE_KEY)
    const list = raw ? (JSON.parse(raw) as unknown[]) : []
    return Array.isArray(list) ? list.filter(isSavedOrg) : []
  } catch {
    return []
  }
}

function writeSavedOrgs(list: SavedOrg[]) {
  try {
    storage()?.setItem(ORGS_STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 保存できなくても、このページの間は使える */
  }
}

/** 一覧に入れる(同じ団体ID は置き換え、先頭にする)。前の団体名は、新しい値が無ければ残す */
export function upsertSavedOrg(org: SavedOrg): void {
  const list = loadSavedOrgs()
  const prev = list.find((o) => o.orgId === org.orgId)
  writeSavedOrgs([{ ...org, name: org.name ?? prev?.name }, ...list.filter((o) => o.orgId !== org.orgId)])
}

export function removeSavedOrg(orgId: string): void {
  writeSavedOrgs(loadSavedOrgs().filter((o) => o.orgId !== orgId))
  if (getCurrentOrgId() === orgId) {
    try { storage()?.removeItem(CURRENT_ORG_STORAGE_KEY) } catch { /* ignore */ }
  }
}

/** ログインの後、団体名を覚える(ログイン画面の一覧に出す) */
export function rememberOrgName(orgId: string, name: string): void {
  const list = loadSavedOrgs()
  const org = list.find((o) => o.orgId === orgId)
  if (!org || !name || org.name === name) return
  writeSavedOrgs(list.map((o) => (o.orgId === orgId ? { ...o, name } : o)))
}

export function getCurrentOrgId(): string | null {
  try {
    const v = storage()?.getItem(CURRENT_ORG_STORAGE_KEY) ?? null
    return v && ORG_ID_PATTERN.test(v) ? v : null
  } catch {
    return null
  }
}

export function setCurrentOrgId(orgId: string): void {
  try {
    storage()?.setItem(CURRENT_ORG_STORAGE_KEY, orgId)
  } catch {
    /* ignore */
  }
}

/** R1-d より前の端末: 既定の団体の団体ID(ohsumi-login-config)を、一覧に移す(ログインしたままにするため) */
export function migrateLegacyLoginConfig(now = Date.now()): void {
  const s = storage()
  if (!s || !DEFAULT_GAS_URL || !CANONICAL_GAS_URL.test(DEFAULT_GAS_URL)) return
  try {
    const raw = s.getItem(LEGACY_LOGIN_CONFIG_KEY)
    if (!raw) return
    const orgId = (JSON.parse(raw) as { orgId?: unknown }).orgId
    s.removeItem(LEGACY_LOGIN_CONFIG_KEY)
    if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId) || loadSavedOrgs().some((o) => o.orgId === orgId)) return
    upsertSavedOrg({ orgId, gasUrl: DEFAULT_GAS_URL, source: 'default', checkedAt: now })
    if (!getCurrentOrgId()) setCurrentOrgId(orgId)
  } catch {
    /* ignore */
  }
}

export function setLoginNotice(notice: LoginNotice): void {
  try { storage('session')?.setItem(LOGIN_NOTICE_KEY, notice) } catch { /* ignore */ }
}

/** 読み込み直した後に出す知らせ(1回だけ) */
export function takeLoginNotice(): LoginNotice | null {
  try {
    const s = storage('session')
    const v = s?.getItem(LOGIN_NOTICE_KEY) ?? null
    s?.removeItem(LOGIN_NOTICE_KEY)
    return v === 'orgMoved' || v === 'orgSuspended' || v === 'orgNotFound' ? v : null
  } catch {
    return null
  }
}

// ---- 招待リンク ----------------------------------------------------------------

/** URL の ?org=。無ければ null、形が違えば 'invalid' */
export function readInviteOrgId(search: string): string | 'invalid' | null {
  const v = new URLSearchParams(search).get('org')
  if (v === null) return null
  return ORG_ID_PATTERN.test(v) ? v : 'invalid'
}

/** アドレスバーから ?org= を消す(ブックマーク・共有に残さない。ページは読み込み直さない) */
export function stripInviteParam(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('org')) return
    url.searchParams.delete('org')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch {
    /* ignore */
  }
}

/** 招待リンク(団体の担当者が配る) */
export function inviteLink(origin: string, basePath: string, orgId: string): string {
  return `${origin}${basePath || ''}/?org=${encodeURIComponent(orgId)}`
}

// ---- レジストリへの問い合わせ ----------------------------------------------------

export type ResolveAnswer =
  | { kind: 'found'; gasUrl: string; checkedAt: number; maxAgeSec: number }
  | { kind: 'suspended' }
  | { kind: 'notFound' }
  | { kind: 'unavailable' }

type Fetcher = (url: string, init: RequestInit) => Promise<Pick<Response, 'text'>>
let fetcher: Fetcher = (url, init) => fetch(url, init)

export function setOrgDirectoryFetchForTest(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init))
}

async function resolveOnce(orgId: string): Promise<ResolveAnswer | null> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), REGISTRY_TIMEOUT_MS)
  try {
    const res = await fetcher(REGISTRY_URL, { ...FETCH_INIT, body: JSON.stringify({ action: 'resolveOrg', orgId }), signal: controller?.signal })
    const json = JSON.parse(await res.text()) as {
      ok?: boolean
      notFound?: boolean
      retryLater?: boolean
      getReceived?: boolean
      result?: { orgId?: string; gasUrl?: string; status?: string; checkedAt?: string; maxAgeSec?: number }
    }
    if (!json || typeof json !== 'object' || json.retryLater || json.getReceived) return null
    if (!json.ok) return json.notFound ? { kind: 'notFound' } : null
    const r = json.result ?? {}
    // 問い合わせた団体の答えだけを使う
    if (r.orgId !== orgId) return null
    if (r.status === 'suspended') return { kind: 'suspended' }
    if (r.status !== 'active' || !CANONICAL_GAS_URL.test(String(r.gasUrl ?? ''))) return null
    const checkedAt = Date.parse(String(r.checkedAt ?? ''))
    return {
      kind: 'found',
      gasUrl: String(r.gasUrl),
      checkedAt: Number.isFinite(checkedAt) ? checkedAt : Date.now(),
      maxAgeSec: Number(r.maxAgeSec) > 0 ? Number(r.maxAgeSec) : DEFAULT_MAX_AGE_SEC,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** レジストリに団体の接続先を問い合わせる(答えが無ければ1回だけ送り直す) */
export async function resolveOrg(orgId: string): Promise<ResolveAnswer> {
  if (!REGISTRY_URL || !ORG_ID_PATTERN.test(orgId)) return REGISTRY_URL ? { kind: 'notFound' } : { kind: 'unavailable' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await resolveOnce(orgId)
    if (answer) return answer
  }
  return { kind: 'unavailable' }
}

// ---- 使う団体を決める ------------------------------------------------------------

export type StartDecision =
  // 一覧にある団体をすぐ使う(refresh: 裏でレジストリに確かめ直す)
  | { kind: 'use'; org: SavedOrg; refresh: boolean }
  // 招待リンクの団体が一覧に無い: レジストリの答えを待つ
  | { kind: 'resolve'; orgId: string }
  // 既定の団体(団体ID は getLoginConfig で分かる)
  | { kind: 'default' }
  // 招待リンクの形が違う
  | { kind: 'invalidInvite' }
  // つなぐ先が無い(招待リンクから開いてもらう)
  | { kind: 'none' }

export function isStale(org: SavedOrg, now: number): boolean {
  return org.source === 'registry' && now - org.checkedAt > (org.maxAgeSec ?? DEFAULT_MAX_AGE_SEC) * 1000
}

/** 使う団体を決める(純粋な関数) */
export function decideStartOrg(input: {
  invite: string | 'invalid' | null
  saved: SavedOrg[]
  currentId: string | null
  defaultGasUrl: string
  now: number
}): StartDecision {
  const { invite, saved, currentId, defaultGasUrl, now } = input
  if (invite === 'invalid') return { kind: 'invalidInvite' }
  if (invite) {
    const org = saved.find((o) => o.orgId === invite)
    return org ? { kind: 'use', org, refresh: isStale(org, now) } : { kind: 'resolve', orgId: invite }
  }
  const current = currentId ? saved.find((o) => o.orgId === currentId) : undefined
  if (current) return { kind: 'use', org: current, refresh: isStale(current, now) }
  if (defaultGasUrl) {
    const def = saved.find((o) => o.source === 'default' && o.gasUrl === defaultGasUrl)
    return def ? { kind: 'use', org: def, refresh: false } : { kind: 'default' }
  }
  if (saved.length) return { kind: 'use', org: saved[0], refresh: isStale(saved[0], now) }
  return { kind: 'none' }
}

/**
 * 保存した団体と、レジストリの新しい答えを比べる(純粋な関数)。
 * same: 同じ(確かめた時刻だけ新しくする) / moved: 接続先が変わった / suspended・notFound: 使えなくなった /
 * unavailable: 答えが無い(保存した接続先を使い続ける)
 */
export function compareResolved(org: SavedOrg, answer: ResolveAnswer): { outcome: 'same' | 'moved' | 'suspended' | 'notFound' | 'unavailable'; updated?: SavedOrg } {
  if (answer.kind === 'unavailable') return { outcome: 'unavailable' }
  if (answer.kind === 'suspended' || answer.kind === 'notFound') return { outcome: answer.kind }
  const updated: SavedOrg = { ...org, gasUrl: answer.gasUrl, checkedAt: answer.checkedAt, maxAgeSec: answer.maxAgeSec, source: 'registry' }
  return { outcome: answer.gasUrl === org.gasUrl ? 'same' : 'moved', updated }
}

// ---- このページで使う接続先 ------------------------------------------------------

let activeGasUrl = DEFAULT_GAS_URL
let activeOrgId: string | null = null
let startDecision: StartDecision | null = null

/** このページで GAS に送る先。既定は NEXT_PUBLIC_GAS_URL */
export function getActiveGasUrl(): string {
  return activeGasUrl
}

/** このページで使う団体(分かっていれば) */
export function getActiveOrg(): { orgId: string | null; gasUrl: string } {
  return { orgId: activeOrgId, gasUrl: activeGasUrl }
}

/** この団体を使う(一覧に入れ、今の団体にする) */
export function activateOrg(org: SavedOrg): void {
  activeGasUrl = org.gasUrl
  activeOrgId = org.orgId
  upsertSavedOrg(org)
  setCurrentOrgId(org.orgId)
}

/** 既定の団体の団体ID が getLoginConfig で分かった時 */
export function rememberDefaultOrg(orgId: string, now = Date.now()): void {
  if (!DEFAULT_GAS_URL || activeGasUrl !== DEFAULT_GAS_URL || !ORG_ID_PATTERN.test(orgId)) return
  activateOrg({ orgId, gasUrl: DEFAULT_GAS_URL, source: 'default', checkedAt: now })
}

/**
 * このページで使う団体を決める(ページごとに1回。何度呼んでも同じ答え)。
 * 一覧にある団体なら、すぐに接続先を切り替え、必要なら裏でレジストリに確かめ直す
 */
export function startOrg(): StartDecision {
  if (startDecision) return startDecision
  if (typeof window === 'undefined') return { kind: DEFAULT_GAS_URL ? 'default' : 'none' }
  migrateLegacyLoginConfig()
  const invite = readInviteOrgId(window.location?.search ?? '')
  stripInviteParam()
  const decision = decideStartOrg({ invite, saved: loadSavedOrgs(), currentId: getCurrentOrgId(), defaultGasUrl: DEFAULT_GAS_URL, now: Date.now() })
  startDecision = decision
  if (decision.kind === 'use') {
    activateOrg(decision.org)
    if (decision.refresh) void refreshInBackground(decision.org)
  }
  return decision
}

/** 招待リンクの団体をレジストリで調べ、その GAS の団体ID が同じなら使う */
export async function resolveAndActivate(
  orgId: string,
  fetchOrgIdOf: (gasUrl: string) => Promise<string | null>,
): Promise<{ status: 'ok'; org: SavedOrg } | { status: 'suspended' | 'notFound' | 'unavailable' | 'mismatch' }> {
  const answer = await resolveOrg(orgId)
  if (answer.kind !== 'found') return { status: answer.kind }
  const actual = await fetchOrgIdOf(answer.gasUrl)
  if (actual === null) return { status: 'unavailable' }
  if (actual !== orgId) return { status: 'mismatch' }
  const org: SavedOrg = { orgId, gasUrl: answer.gasUrl, source: 'registry', checkedAt: answer.checkedAt, maxAgeSec: answer.maxAgeSec }
  activateOrg(org)
  return { status: 'ok', org }
}

/** 保存した接続先が古い時、裏で確かめ直す。違っていれば ORG_CHANGED_EVENT を送る */
export async function refreshInBackground(org: SavedOrg): Promise<void> {
  const { outcome, updated } = compareResolved(org, await resolveOrg(org.orgId))
  if (outcome === 'unavailable') return
  if (outcome === 'same') {
    upsertSavedOrg(updated!)
    return
  }
  if (outcome === 'moved') upsertSavedOrg(updated!)
  else removeSavedOrg(org.orgId)
  const notice: LoginNotice = outcome === 'moved' ? 'orgMoved' : outcome === 'suspended' ? 'orgSuspended' : 'orgNotFound'
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ORG_CHANGED_EVENT, { detail: { orgId: org.orgId, notice } }))
}

// 団体ごとの内容が残る、この端末の保存(団体を切り替える時に消す)。
// 表示言語・テーマ・「ログイン情報を保存する」の選択・団体の一覧は残す
export const ORG_SCOPED_STORAGE_KEYS = [
  'ohsumi-state-v2',
  'ohsumi-org-name',
  'ohsumi-org-logo-url',
  'ohsumi-theme-color',
  'ohsumi-dismissed-notifications',
  'ohsumi-1on1-questions',
  'ohsumi-seen-mention-ids',
  'ohsumi-onboarded-ids',
]

/** ほかの団体に切り替える: 今の団体にし、団体ごとの保存を消して、ページを読み込み直す */
export function switchToOrg(orgId: string, reload: () => void = () => window.location.reload()): void {
  setCurrentOrgId(orgId)
  const s = storage()
  for (const key of ORG_SCOPED_STORAGE_KEYS) {
    try { s?.removeItem(key) } catch { /* ignore */ }
  }
  reload()
}

// テスト用: ページを読み込み直した状態に戻す
export function resetOrgDirectoryForTest(): void {
  activeGasUrl = DEFAULT_GAS_URL
  activeOrgId = null
  startDecision = null
}
