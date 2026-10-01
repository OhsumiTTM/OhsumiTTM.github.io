'use client'

// バックアップを作れなかった日(管理画面の上部。代表だけ)。gas/Code.gs の backupStatus_
import { useEffect, useState } from 'react'
import { DatabaseBackup } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type BackupStatus } from '@/lib/ohsumi/remote'

export function BackupBanner() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<BackupStatus | null>(null)

  useEffect(() => {
    if (!isRemoteConfigured) return
    let alive = true
    remoteApi.getBackupStatus().then(
      (s) => { if (alive) setStatus(s) },
      () => { /* 確かめられない時(古い GAS など)は何も出さない */ },
    )
    return () => { alive = false }
  }, [])

  if (!status || !status.failed) return null
  const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.failedAt))
  return (
    <div role="status" data-backup-banner className="flex items-start gap-1.5 border-b border-border bg-warning-muted px-4 py-2 text-xs text-warning">
      <DatabaseBackup className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 break-words">
        <p className="font-medium">{t('backup.failedBanner', { date, error: status.error })}</p>
        <p className="mt-0.5">{t('backup.failedHint')}</p>
      </div>
    </div>
  )
}
