'use client'

// この団体の GAS の更新(管理画面の上部。代表・全権管理者だけ)。レジストリが checkIn で「更新が要る」と返した時に出す
// (gas/Code.gs の gasUpdateStatus_。代表には、最新の版ごとに1回メールでも知らせる)。
// 「コードをコピー」は、このサイトの /gas/Code.gs(ビルドの時に置く)を読み、最新の版と同じ時だけクリップボードに入れる
// (lib/ohsumi/gas-code-copy.ts)。GitHub を開かずに更新できるよう、短い手順も出す
import { OrgAdminLinks } from './org-admin-links'
import { useEffect, useState } from 'react'
import { Copy, ShieldAlert } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type GasUpdateStatus } from '@/lib/ohsumi/remote'
import { copySiteGasCode } from '@/lib/ohsumi/gas-code-copy'

type CopyState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'copied'; version: string }
  | { kind: 'error'; message: string }

export function GasUpdateBanner() {
  const { t } = useI18n()
  const [status, setStatus] = useState<GasUpdateStatus | null>(null)
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' })

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

  const copyCode = async () => {
    setCopy({ kind: 'busy' })
    const r = await copySiteGasCode(status.latest)
    if (r.ok) setCopy({ kind: 'copied', version: r.version })
    else if (r.reason === 'mismatch') setCopy({ kind: 'error', message: t('admin.gasUpdate.copy.mismatch', { site: r.version ?? '', latest: status.latest }) })
    else if (r.reason === 'clipboard') setCopy({ kind: 'error', message: t('admin.gasUpdate.copy.clipboard') })
    else setCopy({ kind: 'error', message: t('admin.gasUpdate.copy.fetch') })
  }

  return (
    <div role="status" data-gas-update-banner className="flex items-start gap-1.5 border-b border-border bg-warning-muted px-4 py-2 text-xs text-warning">
      <ShieldAlert className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 break-words">
        <p className="font-medium">{t('admin.gasUpdate.required', { current: status.current, latest: status.latest })}</p>
        {status.security && <p className="mt-0.5 font-medium">{t('admin.gasUpdate.security')}</p>}
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          <li>{t('admin.gasUpdate.step.copy')}</li>
          <li>{t('admin.gasUpdate.step.paste')}</li>
          <li>{t('admin.gasUpdate.step.setup')}</li>
          <li>{t('admin.gasUpdate.step.deploy')}</li>
        </ol>
        {/* Apps Script・スプレッドシートを直接開く(最上位の役職の人だけ。新しい GAS が URL を渡した時だけ) */}
        <OrgAdminLinks compact className="mt-1.5" />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            data-gas-copy-code
            onClick={copyCode}
            disabled={copy.kind === 'busy'}
            className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-background px-2 py-1 font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
          >
            <Copy className="size-3.5" />
            {t('admin.gasUpdate.copy.button', { latest: status.latest })}
          </button>
          {copy.kind === 'copied' && <span data-gas-copy-result className="text-foreground">{t('admin.gasUpdate.copy.done', { version: copy.version })}</span>}
          {copy.kind === 'error' && <span data-gas-copy-result role="alert" className="font-medium">{copy.message}</span>}
        </div>
      </div>
    </div>
  )
}
