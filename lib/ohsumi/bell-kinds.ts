// ベル(画面の中のお知らせ)の通知の種類ごとのオン・オフ。保存先はメールの通知の設定と同じ
// Members の notify_settings(JSON)の bell キー(本人の設定。ほかの端末でも同じ)。書いていない種類はオン。
// GAS は保存の前に、知らない種類・真偽値でない値を断る(gas/src/37-value-checks.gs の checkNotifySettings_)。
// メールの頻度(new_task・review などのキー)とは別に効く
import type { NotificationItem } from './types'

export const BELL_KINDS = [
  'approval', // 承認依頼
  'review', // 確認待ち
  'staleReview', // 確認待ちが○日経過
  'staleProgress', // ○日間更新なし
  'deadline', // 期限
  'mention', // メンション・返信
  'lowWorkload', // 稼働に余裕があるようです
  'inactive', // ○日間未ログイン
  'expense', // 経費
  'invite', // 日程調整・フォームの招待
] as const
export type BellKind = (typeof BELL_KINDS)[number]
export type BellSettings = Partial<Record<BellKind, boolean>>

export function isBellKind(v: unknown): v is BellKind {
  return typeof v === 'string' && (BELL_KINDS as readonly string[]).includes(v)
}

/** 保存された値を読む(知らない種類・真偽値でない値は捨てる) */
export function parseBellSettings(raw: unknown): BellSettings {
  const out: BellSettings = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isBellKind(k) && typeof v === 'boolean') out[k] = v
  }
  return out
}

export function bellEnabled(settings: BellSettings | undefined, kind: BellKind): boolean {
  return settings?.[kind] !== false
}

/** オフにした種類の通知を外す。種類の無い通知(団体からのお知らせなど)はいつも出す */
export function filterByBellSettings<T extends Pick<NotificationItem, 'bell'>>(items: T[], settings: BellSettings | undefined): T[] {
  return items.filter((n) => !n.bell || bellEnabled(settings, n.bell))
}
