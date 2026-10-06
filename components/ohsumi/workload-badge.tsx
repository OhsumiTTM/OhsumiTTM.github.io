'use client'

import { cn } from '@/lib/utils'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import type { WorkloadCapacity } from '@/lib/ohsumi/utils'

// 稼働の目安(memberWorkloadCapacity)の言葉と色。担当者を選ぶ画面・メンバーの一覧で同じものを使う
export const WORKLOAD_CAPACITY_RANK: Record<WorkloadCapacity, number> = { available: 0, normal: 1, full: 2 }
export const WORKLOAD_CAPACITY_LABEL_KEY: Record<WorkloadCapacity, TranslationKey> = {
  available: 'taskDrawer.assign.capacity.available',
  normal: 'taskDrawer.assign.capacity.normal',
  full: 'taskDrawer.assign.capacity.full',
}
export const WORKLOAD_CAPACITY_BADGE_CLASS: Record<WorkloadCapacity, string> = {
  available: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  normal: 'bg-secondary text-muted-foreground',
  full: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
}

export function WorkloadBadge({ capacity, className }: { capacity: WorkloadCapacity; className?: string }) {
  const { t } = useI18n()
  return (
    <span
      data-workload={capacity}
      className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', WORKLOAD_CAPACITY_BADGE_CLASS[capacity], className)}
    >
      {t(WORKLOAD_CAPACITY_LABEL_KEY[capacity])}
    </span>
  )
}
