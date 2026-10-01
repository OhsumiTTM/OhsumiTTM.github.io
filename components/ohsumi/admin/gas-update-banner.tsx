'use client'

// この団体の GAS の更新(管理画面の上部。代表・全権管理者だけ)。レジストリが checkIn で「更新が要る」と返した時に出す
// (gas/Code.gs の gasUpdateStatus_。代表には、最新の版ごとに1回メールでも知らせる)
import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type GasUpdateStatus } from '@/lib/ohsumi/remote'

export function GasUpdateBanner() {
  const { t } = useI18n()
  const [status, setStatus] = useState<GasUpdateStatus | null>(null)

  useEffect(() => {
    if (!isRemoteConfigured) return
    let alive = true
    remoteApi.getGasUpdateStatus().then(
      (s) => { if (alive) setStatus(s) },
      () => { /* 確かめられない時(古い GAS など)は何も出さない */ },
    )
    return () => { alive = false }
  }, [])

  if (!status || !status.required) return null
  return (
    <div role="status" data-gas-update-banner className="flex items-start gap-1.5 border-b border-border bg-warning-muted px-4 py-2 text-xs text-warning">
      <ShieldAlert className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 break-words">
        <p className="font-medium">{t('admin.gasUpdate.required', { current: status.current, latest: status.latest })}</p>
        {status.security && <p className="mt-0.5 font-medium">{t('admin.gasUpdate.security')}</p>}
        <p className="mt-0.5">{t('admin.gasUpdate.hint')}</p>
      </div>
    </div>
  )
}
