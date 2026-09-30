'use client'

// 画面の上部の知らせ(R1-e): 機能停止中はアンケートへの回答のお願い、停止の予定が14日以内なら予告。
// 状態は団体の GAS の応答(contract)から決まる(lib/ohsumi/contract.ts)
import { useSyncExternalStore } from 'react'
import { CalendarClock, TriangleAlert } from 'lucide-react'
import { NO_CONTRACT, contractBanner, getContract, subscribeContract } from '@/lib/ohsumi/contract'
import { useI18n } from '@/lib/ohsumi/i18n'

export function ContractBanner() {
  const { t, locale } = useI18n()
  const contract = useSyncExternalStore(subscribeContract, getContract, () => NO_CONTRACT)
  const banner = contractBanner(contract, Date.now())
  if (!banner) return null
  if (banner.type === 'restricted') {
    return (
      <div role="status" className="flex items-start justify-center gap-1.5 bg-warning-muted px-4 py-2 text-center text-xs font-medium text-warning">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{t('app.contractRestricted')}</span>
      </div>
    )
  }
  const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(banner.suspendAt))
  return (
    <div role="status" className="flex items-start justify-center gap-1.5 bg-warning-muted px-4 py-2 text-center text-xs font-medium text-warning">
      <CalendarClock className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        {t(banner.kind === 'restrict' ? 'app.contractScheduledRestrict' : 'app.contractScheduledSuspend', { date, days: banner.daysLeft })}
      </span>
    </div>
  )
}
