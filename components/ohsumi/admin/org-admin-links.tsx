'use client'

// 団体のスプレッドシートと Apps Script の編集画面を開くボタン(最上位の役職の人だけ)。
// URL は GAS が初期データで最上位の役職の人にだけ渡す(古い GAS では届かないので、ボタンを出さない)
import { ExternalLink } from 'lucide-react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { cn } from '@/lib/utils'

export function OrgAdminLinks({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { adminLinks, isTopRef, currentUser } = useOhsumi()
  const { t } = useI18n()
  if (!adminLinks || !isTopRef(currentUser?.role)) return null
  const button = cn(
    'inline-flex items-center gap-1 rounded-md border bg-background font-medium text-foreground transition-colors hover:bg-secondary',
    compact ? 'border-warning/40 px-2 py-1 text-xs' : 'border-border px-3 py-1.5 text-sm',
  )
  return (
    <div className={className} data-org-admin-links>
      <div className="flex flex-wrap items-center gap-2">
        <a href={adminLinks.scriptEditUrl} target="_blank" rel="noopener noreferrer" className={button} data-open-script>
          <ExternalLink className="size-3.5" />
          {t('orgAdminLinks.openScript')}
        </a>
        <a href={adminLinks.spreadsheetUrl} target="_blank" rel="noopener noreferrer" className={button} data-open-sheet>
          <ExternalLink className="size-3.5" />
          {t('orgAdminLinks.openSheet')}
        </a>
      </div>
      <p className={cn('mt-1', compact ? 'text-xs' : 'text-xs text-muted-foreground')}>{t('orgAdminLinks.accountHint')}</p>
    </div>
  )
}
