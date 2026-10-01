'use client'

// メールの1日の上限(管理画面の上部。代表・全権管理者だけ)。団体の GAS は、GAS を動かすアカウントの
// メールの上限を全員で分け合うので、今日の上限に達して送れなかったメールがあれば知らせる
// (gas/Code.gs の mailQuotaStatus_。送れなかった通知は、次の朝のまとめで送る)
import { useEffect, useState } from 'react'
import { MailWarning } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type MailQuotaStatus } from '@/lib/ohsumi/remote'

// これ以下になったら、上限に近いことを知らせる
const MAIL_LOW_REMAINING = 20

export function MailQuotaBanner() {
  const { t } = useI18n()
  const [status, setStatus] = useState<MailQuotaStatus | null>(null)

  useEffect(() => {
    if (!isRemoteConfigured) return
    let alive = true
    remoteApi.getMailQuotaStatus().then(
      (s) => { if (alive) setStatus(s) },
      () => { /* 確かめられない時は何も出さない */ },
    )
    return () => { alive = false }
  }, [])

  if (!status) return null
  const reached = status.skipped > 0
  const low = !reached && typeof status.remaining === 'number' && status.remaining <= MAIL_LOW_REMAINING
  if (!reached && !low) return null
  return (
    <div role="status" data-mail-quota-banner className="flex items-start gap-1.5 border-b border-border bg-warning-muted px-4 py-2 text-xs text-warning">
      <MailWarning className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 break-words">
        <p className="font-medium">
          {reached
            ? t('admin.mailQuota.reached', { count: String(status.skipped) })
            : t('admin.mailQuota.low', { remaining: String(status.remaining) })}
        </p>
        <p className="mt-0.5">{t('admin.mailQuota.hint')}</p>
      </div>
    </div>
  )
}
