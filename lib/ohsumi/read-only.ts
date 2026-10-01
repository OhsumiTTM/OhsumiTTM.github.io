// 機能停止中(読み取り専用。R1-e)の画面の扱い。
//
// 1. 入力欄: 文字・数値・日付などを書く欄と、ファイルの選択は、最初から使えなくする(書いた文章が保存できずに
//    消えることが無いように)。検索・期間・絞り込みなど、閲覧のための欄には data-read-only-ok を付けて残す。
//    選択肢(select)・チェックボックス・ボタンは止めない(表示の切り替え・並び替え・書き出しに使うため)。
// 2. 作成・編集の操作: 画面の状態を変える前に止め(store の関数を包む)、「読み取り専用のため、保存できません」を出す。
// 3. 万一 GAS に断られた時: 読み込み直さずに知らせ、送ろうとした文章をコピーできるように出す。

import type { ContractInfo } from './contract'

export const READ_ONLY_OK_ATTR = 'data-read-only-ok'
const DISABLED_MARK = 'data-read-only-disabled'

// 止める input の type(文字・数値・日付などを書く欄と、ファイルの選択)
const WRITING_INPUT_TYPES = new Set(['', 'text', 'number', 'date', 'datetime-local', 'time', 'month', 'week', 'email', 'url', 'tel', 'password', 'file'])

/** 読み取り専用か(GAS が機能停止中と伝えた時だけ) */
export function isReadOnlyContract(c: ContractInfo): boolean {
  return c.phase === 'inEffect' && c.kind === 'restrict'
}

// 作成・編集を止めた時刻。止めた直後の「保存しました」などの知らせを出さないために使う(toast.tsx)
let lastBlockedAt = 0

/** 今、作成・編集を止めたばかりか */
export function blockedJustNow(nowMs = Date.now()): boolean {
  return nowMs - lastBlockedAt < 1000
}

interface ElementLike {
  tagName: string
  getAttribute(name: string): string | null
  closest(selector: string): unknown
}

/** 読み取り専用の時に止める欄か */
export function shouldDisableForReadOnly(el: ElementLike): boolean {
  if (el.closest(`[${READ_ONLY_OK_ATTR}]`)) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag !== 'input') return false
  return WRITING_INPUT_TYPES.has(String(el.getAttribute('type') ?? '').toLowerCase())
}

/**
 * root の中の欄を、読み取り専用なら止め、そうでなければ(自分が止めた欄だけ)戻す。止めた欄の数を返す。
 * もともと使えない欄(disabled)は変えない
 */
export function applyReadOnlyInputs(root: ParentNode, readOnly: boolean, title: string): number {
  let count = 0
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((el) => {
    if (readOnly) {
      if (el.disabled || !shouldDisableForReadOnly(el)) return
      el.disabled = true
      el.setAttribute(DISABLED_MARK, el.getAttribute('title') ?? '')
      el.setAttribute('title', title)
      count++
    } else if (el.hasAttribute(DISABLED_MARK)) {
      const prevTitle = el.getAttribute(DISABLED_MARK) ?? ''
      el.disabled = false
      if (prevTitle) el.setAttribute('title', prevTitle)
      else el.removeAttribute('title')
      el.removeAttribute(DISABLED_MARK)
    }
  })
  return count
}

// ---- 送ろうとした文章(コピーできるように出す) ----

const SKIP_KEYS = new Set(['action', 'sessionToken', 'clientVersion', 'requestId', 'id'])

function looksLikeText(s: string): boolean {
  const v = s.trim()
  if (!v) return false
  if (/^data:/i.test(v)) return false // 画像・ファイル
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(v)) return false // 日付
  if (/^https?:\/\/\S+$/.test(v)) return false
  // ID・コード(英数字と記号だけの短いもの)は除く
  if (/^[\w.:@/-]+$/.test(v) && v.length < 40) return false
  return true
}

/** 送ろうとした内容(引数・リクエスト)から、人が書いた文章らしいものを取り出す(重複は除く。長い順) */
// ---- 保存できなかった文章を、読み込み直しの後まで残す ----------------------------------
//
// ログインが切れた・提供停止になった時は、ページを読み込み直してログイン画面に戻す。その時に送れなかった文章を
// このタブの sessionStorage に残し、読み込み直した画面(ログイン画面・ログインした後)でコピーできるように出す。
// 閉じれば消す。自分でログアウトした時も消す(共有の端末に残さない)
export type UnsavedNoticeKind = 'readOnly' | 'sessionEnded' | 'orgSuspended' | 'reloadRequired' | 'cellTooLong' | 'conflict'
const UNSENT_KEY = 'ohsumi-unsent-texts'

function tabStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** 送れなかった文章を残す(前に残した分に足す) */
export function keepUnsentTexts(kind: UnsavedNoticeKind, texts: string[]): void {
  if (!texts.length) return
  const s = tabStorage()
  try {
    const before = takeUnsentTexts()
    const merged = [...new Set([...(before?.texts ?? []), ...texts])]
    s?.setItem(UNSENT_KEY, JSON.stringify({ kind, texts: merged }))
  } catch {
    /* 残せなくても、画面の知らせは出す */
  }
}

/** 残した文章(消さない。閉じた時に clearUnsentTexts で消す) */
export function takeUnsentTexts(): { kind: UnsavedNoticeKind; texts: string[] } | null {
  try {
    const raw = tabStorage()?.getItem(UNSENT_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { kind?: string; texts?: unknown }
    const texts = Array.isArray(v.texts) ? v.texts.filter((t): t is string => typeof t === 'string' && !!t) : []
    if (!texts.length) return null
    const kind = (['sessionEnded', 'orgSuspended', 'reloadRequired', 'readOnly', 'cellTooLong', 'conflict'] as const).find((k) => k === v.kind) ?? 'sessionEnded'
    return { kind, texts }
  } catch {
    return null
  }
}

export function clearUnsentTexts(): void {
  try { tabStorage()?.removeItem(UNSENT_KEY) } catch { /* ignore */ }
}

export function extractUnsavedTexts(value: unknown, depth = 0): string[] {
  const out: string[] = []
  const visit = (v: unknown, key: string, d: number) => {
    if (d > 6 || v == null) return
    if (typeof v === 'string') {
      if (!SKIP_KEYS.has(key) && !/Ids?$/.test(key) && looksLikeText(v)) out.push(v.trim())
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, key, d + 1))
      return
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k, d + 1)
    }
  }
  visit(value, '', depth)
  return [...new Set(out)].sort((a, b) => b.length - a.length)
}

// ---- store の作成・編集の操作を止める ----

// 読み取り専用の時も使える store の関数(読み取り・表示の切り替え・この端末だけの記録・ログイン)。
// これ以外の関数は、作成・編集として止める(新しく足した関数も、ここに無ければ止まる)
export const READ_SAFE_STORE_FUNCTIONS = new Set([
  'refreshAll',
  'retryLoad',
  'isAdminRef',
  'isTopRef',
  'departmentOptions',
  'departmentNameOf',
  'refreshWebhookStatus',
  'fetchDailyReports',
  'clearSkillCertifiedEvent',
  'markMentionSeen',
  'dismissNotification',
  'skipOnboarding',
  'login',
  'logout',
  'signInWithGoogle',
  'revokeAllMySessions',
  'revokeMemberSessions',
  'setMode',
  'getMember',
  'getProject',
  'getInput',
  'getProjectMembers',
  'closeReadOnlyNotice',
  // 表示の言語・タイムゾーン(この端末の表示はすぐ変わる。シートへの保存は GAS が断り、上部に知らせを出す)
  'setMemberLocale',
  'setMemberTimezone',
])

export class ReadOnlyBlockedError extends Error {
  constructor() {
    super('読み取り専用のため、保存できません。')
    this.name = 'ReadOnlyBlockedError'
  }
}

/**
 * store の値のうち、作成・編集の関数を包み、呼ばれても何も変えずに onBlocked を呼ぶ。
 * 包んだ関数は、失敗した Promise を返す(await している呼び出し元は、失敗として扱う)
 */
export function guardStoreWrites<T extends object>(value: T, onBlocked: (name: string, args: unknown[]) => void): T {
  const out = { ...value } as Record<string, unknown>
  for (const [name, v] of Object.entries(value)) {
    if (typeof v !== 'function' || READ_SAFE_STORE_FUNCTIONS.has(name)) continue
    out[name] = (...args: unknown[]) => {
      lastBlockedAt = Date.now()
      onBlocked(name, args)
      const p = Promise.reject(new ReadOnlyBlockedError())
      // 結果を使わない呼び出し元で、処理されない失敗として出さない
      p.catch(() => {})
      return p
    }
  }
  return out as T
}

/** 人が押した・入力した直後か(ブラウザが分からない時は true)。自動で呼ばれた操作では、知らせを出さない */
export function hasUserActivation(): boolean {
  try {
    const ua = (typeof navigator !== 'undefined' ? (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation : undefined)
    return ua ? ua.isActive : true
  } catch {
    return true
  }
}
