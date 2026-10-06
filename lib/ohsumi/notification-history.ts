// 通知の履歴。通知はデータから毎回作り直す(store.tsx の notifications)ので、初めて出た時に
// 種類・文面・開く先・時刻を記録し、既読・対応済みを残す。保存先は GAS の本人だけの保存
// (getMyStorage・setMyStorage のキー NOTIFICATION_HISTORY_KEY)。GAS に繋いでいない時は、この端末に保存する。
//   - 既読: 開いた・「既読にする」を押した通知。「未読」の一覧から外れ、「すべて(履歴)」に残る
//   - 対応済み: 通知の元の状態が無くなった(承認した・期限が過ぎて完了した など)。履歴に残る
//   - 90日を過ぎたもの・新しい順に200件を超えたものは消す
import type { NotificationItem } from './types'
import { isBellKind } from './bell-kinds'

export const NOTIFICATION_HISTORY_KEY = 'notification-history'
export const NOTIFICATION_HISTORY_DAYS = 90
export const NOTIFICATION_HISTORY_MAX = 200
const TITLE_MAX = 200
const DETAIL_MAX = 300

export interface NotificationRecord {
  id: string
  kind: NotificationItem['kind']
  title: string
  detail: string
  taskId: string
  commentId?: string
  memberId?: string
  applicationId?: string
  /** ベルの通知の種類(本人の設定でオフにした種類は、一覧に出さない) */
  bell?: import('./bell-kinds').BellKind
  /** まとめた通知の件数(増えたら未読に戻す) */
  count?: number
  /** 開く先が ADMIN のホームの一覧の時の印 */
  adminList?: 'stale' | 'staleReview'
  /** 初めて出た時刻(ISO) */
  at: string
  readAt?: string
  /** 元の状態が無くなった時刻(ISO)。また出たら消す */
  resolvedAt?: string
}

export interface NotificationHistory {
  v: 1
  items: NotificationRecord[]
}

export const EMPTY_HISTORY: NotificationHistory = { v: 1, items: [] }

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** 保存した値を読む(壊れた部分は捨てる) */
export function parseNotificationHistory(raw: unknown): NotificationHistory {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { return { ...EMPTY_HISTORY, items: [] } }
  }
  const list = obj && typeof obj === 'object' && Array.isArray((obj as { items?: unknown }).items) ? (obj as { items: unknown[] }).items : []
  const items: NotificationRecord[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id || typeof o.at !== 'string') continue
    const rec: NotificationRecord = {
      id: o.id.slice(0, 200), kind: (typeof o.kind === 'string' ? o.kind : 'info') as NotificationRecord['kind'],
      title: str(o.title, TITLE_MAX), detail: str(o.detail, DETAIL_MAX), taskId: str(o.taskId, 100), at: o.at,
    }
    for (const k of ['commentId', 'memberId', 'applicationId', 'readAt', 'resolvedAt'] as const) {
      if (typeof o[k] === 'string' && o[k]) rec[k] = (o[k] as string).slice(0, 100)
    }
    if (typeof o.count === 'number' && Number.isFinite(o.count) && o.count >= 0) rec.count = Math.floor(o.count)
    if (o.adminList === 'stale' || o.adminList === 'staleReview') rec.adminList = o.adminList
    if (isBellKind(o.bell)) rec.bell = o.bell
    items.push(rec)
  }
  return { v: 1, items }
}

function prune(items: NotificationRecord[], now: Date): NotificationRecord[] {
  const limit = now.getTime() - NOTIFICATION_HISTORY_DAYS * 24 * 3600 * 1000
  return items
    .filter((it) => {
      const t = Date.parse(it.at)
      return !Number.isFinite(t) || t >= limit
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, NOTIFICATION_HISTORY_MAX)
}

/**
 * 今の通知を履歴に入れる。新しい通知は記録し、文面は新しいものにする。
 * 履歴にあって今は無い通知は対応済みにし、また出た通知は未読に戻す。変わらなければ同じオブジェクトを返す
 */
export function mergeNotifications(history: NotificationHistory, current: NotificationItem[], now: Date = new Date()): NotificationHistory {
  const at = now.toISOString()
  const byId = new Map(history.items.map((it) => [it.id, it]))
  const currentIds = new Set(current.map((n) => n.id))
  let changed = false
  const items: NotificationRecord[] = history.items.map((it) => {
    if (currentIds.has(it.id) || it.resolvedAt) return it
    changed = true
    return { ...it, resolvedAt: at }
  })
  const index = new Map(items.map((it, i) => [it.id, i]))
  for (const n of current) {
    const title = n.title.slice(0, TITLE_MAX)
    const detail = n.detail.slice(0, DETAIL_MAX)
    const prev = byId.get(n.id)
    if (!prev) {
      const rec: NotificationRecord = { id: n.id, kind: n.kind, title, detail, taskId: n.taskId, at }
      if (n.commentId) rec.commentId = n.commentId
      if (n.memberId) rec.memberId = n.memberId
      if (n.applicationId) rec.applicationId = n.applicationId
      if (n.count != null) rec.count = n.count
      if (n.adminList) rec.adminList = n.adminList
      if (n.bell) rec.bell = n.bell
      items.push(rec)
      changed = true
      continue
    }
    const grew = n.count != null && n.count > (prev.count ?? 0)
    if (prev.resolvedAt || prev.title !== title || prev.detail !== detail || n.count !== prev.count || n.bell !== prev.bell) {
      const next: NotificationRecord = { ...prev, title, detail }
      if (n.bell) next.bell = n.bell
      else delete next.bell
      if (n.count != null) next.count = n.count
      else delete next.count
      // まとめた通知の件数が増えた時は、未読に戻す(減った時は既読のまま)
      if (grew && next.readAt) delete next.readAt
      if (prev.resolvedAt) {
        // 対応済みの後にまた出た通知は、新しい通知として未読にする
        delete next.resolvedAt
        delete next.readAt
        next.at = at
      }
      items[index.get(n.id)!] = next
      changed = true
    }
  }
  const pruned = prune(items, now)
  if (!changed && pruned.length === history.items.length) return history
  return { v: 1, items: pruned }
}

export function markNotificationRead(history: NotificationHistory, id: string, now: Date = new Date()): NotificationHistory {
  if (!history.items.some((it) => it.id === id && !it.readAt)) return history
  return { v: 1, items: history.items.map((it) => (it.id === id && !it.readAt ? { ...it, readAt: now.toISOString() } : it)) }
}

export function markAllNotificationsRead(history: NotificationHistory, now: Date = new Date()): NotificationHistory {
  if (!history.items.some((it) => !it.readAt && !it.resolvedAt)) return history
  const at = now.toISOString()
  return { v: 1, items: history.items.map((it) => (!it.readAt && !it.resolvedAt ? { ...it, readAt: at } : it)) }
}

/** これまでの「消す」(この端末の ohsumi-dismissed-notifications)を既読にする */
export function migrateDismissed(history: NotificationHistory, dismissedIds: string[], current: NotificationItem[], now: Date = new Date()): NotificationHistory {
  if (!dismissedIds.length) return history
  let next = mergeNotifications(history, current, now)
  for (const id of dismissedIds) next = markNotificationRead(next, id, now)
  return next
}

/** 今の通知のうち、まだ読んでいないもの */
export function unreadNotifications(history: NotificationHistory, current: NotificationItem[]): NotificationItem[] {
  const read = new Set(history.items.filter((it) => it.readAt).map((it) => it.id))
  return current.filter((n) => !read.has(n.id))
}

export type NotificationState = 'unread' | 'read' | 'resolved'
export function notificationState(rec: NotificationRecord): NotificationState {
  if (rec.resolvedAt) return 'resolved'
  return rec.readAt ? 'read' : 'unread'
}
