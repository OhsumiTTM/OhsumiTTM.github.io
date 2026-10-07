// メールの頻度(本人の設定 notify_settings の種類ごとのキー)。まだ選んでいない種類は、GAS が「その都度」として送る
// (gas/src/15-input-checks.gs の getNotifyFrequency_)ので、画面でも「その都度」と出す
import type { NotifyFrequency, NotifyKind, NotifySettings } from './types'

export const DEFAULT_NOTIFY_FREQUENCY: NotifyFrequency = 'immediate'

export function notifyFrequencyOf(settings: NotifySettings | undefined, kind: NotifyKind): NotifyFrequency {
  return settings?.[kind] ?? DEFAULT_NOTIFY_FREQUENCY
}

// 頻度を押した時の新しい設定。選んでいる頻度をもう一度押すと「送らない」にする
export function toggleNotifyFrequency(settings: NotifySettings | undefined, kind: NotifyKind, freq: NotifyFrequency): NotifySettings {
  const current = notifyFrequencyOf(settings, kind)
  return { ...(settings ?? {}), [kind]: current === freq ? 'none' : freq }
}
