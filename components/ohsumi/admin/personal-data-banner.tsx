'use client'

// 個人情報を消す7日前からの知らせ(管理画面の上部。代表だけ)。gas/Code.gs の personalDataStatus_
import { useEffect, useState } from 'react'
import { UserX } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type PersonalDataStatus } from '@/lib/ohsumi/remote'

export function PersonalDataBanner() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<PersonalDataStatus | null>(null)

  useEffect(() => {
    if (!isRemoteConfigured) return
    let alive = true
    remoteApi.getPersonalDataStatus().then(
      (s) => { if (alive) setStatus(s) },
      () => { /* 確かめられない時(古い GAS など)は何も出さない */ },
    )
    return () => { alive = false }
  }, [])

  const orphans = status?.orphanEmails?.length ?? 0
  if (!status || (status.upcoming.length === 0 && orphans === 0)) return null
  const fmt = (d: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { month: 'short', day: 'numeric' }).format(new Date(d + 'T00:00:00'))
  return (
    <div role="status" data-personal-data-banner className="flex items-start gap-1.5 border-b border-border bg-warning-muted px-4 py-2 text-xs text-warning">
      <UserX className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 break-words">
        {status.upcoming.map((u) => (
          <p key={u.date} className="font-medium">{t('privacy.upcoming', { count: String(u.count), date: fmt(u.date) })}</p>
        ))}
        {orphans > 0 && <p className="font-medium">{t('privacy.orphanEmails', { count: String(orphans) })}</p>}
        <p className="mt-0.5">{t('privacy.upcomingHint')}</p>
      </div>
    </div>
  )
}
