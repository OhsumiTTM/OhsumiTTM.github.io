'use client'

// FSIF に送る集計値(団体の設定の画面。代表だけ)。gas/Code.gs の「定量データ」
//   - プランと、送るか(Ohsumiプランは必須。ほかのプランは代表が選ぶ)
//   - 次に送る時刻と、次に送る内容(プレビュー。個人を特定しない数だけ)
//   - 送信の履歴(失敗した時は、時間を置いて送り直す)
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useToast } from '@/components/ohsumi/toast'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { remoteApi, type MetricsStatus } from '@/lib/ohsumi/remote'

const METRIC_ORDER = ['members', 'active_7d', 'active_30d', 'logins_7d', 'opens_7d', 'writes_7d', 'tasks', 'tasks_open', 'tasks_done',
  'tasks_overdue', 'tasks_created_7d', 'tasks_completed_7d', 'projects', 'errors_7d'] as const
const PLAN_KEYS: Record<MetricsStatus['plan'], TranslationKey> = {
  '': 'metrics.plan.unset',
  cosmo_base: 'metrics.plan.cosmo_base',
  ohsumi: 'metrics.plan.ohsumi',
  paid: 'metrics.plan.paid',
}

export function MetricsPanel() {
  const { t, locale } = useI18n()
  const toast = useToast()
  const { refreshAll } = useOhsumi()
  const [status, setStatus] = useState<MetricsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const fmt = (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—')

  const load = useCallback(async () => {
    try {
      setStatus(await remoteApi.getMetricsStatus())
    } catch (e) {
      setError(message(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await remoteApi.setMetricsSharing(enabled))
      toast(enabled ? t('metrics.enabledToast') : t('metrics.disabledToast'))
      refreshAll()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-metrics-panel>
      <div className="flex items-center gap-1.5">
        <Send className="size-4 text-muted-foreground" />
        <SectionLabel>{t('metrics.title')}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('metrics.desc')}</p>
      {!status && !error && <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('backup.loading')}</p>}
      {status && (
        <div className="mt-3 space-y-3 text-xs">
          <p className="break-words">
            {t('metrics.planLine', { plan: t(PLAN_KEYS[status.plan]) })}{' '}
            {status.mandatory ? t('metrics.mandatory') : status.defaultOn ? t('metrics.defaultOn') : t('metrics.defaultOff')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium" data-metrics-state>{status.enabled ? t('metrics.stateOn') : t('metrics.stateOff')}</span>
            {!status.mandatory && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(!status.enabled)}>
                {status.enabled ? t('metrics.turnOff') : t('metrics.turnOn')}
              </Button>
            )}
          </div>
          {status.enabled && <p>{t('metrics.nextAt', { at: fmt(status.nextAt) })}</p>}
          <div>
            <p className="font-medium">{t('metrics.preview', { version: String(status.definitionsVersion) })}</p>
            <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5" data-metrics-preview>
              {METRIC_ORDER.filter((k) => k in status.preview).map((k) => (
                <div key={k} className="contents">
                  <dt className="min-w-0 break-words text-muted-foreground">{t(`metrics.key.${k}` as TranslationKey)}</dt>
                  <dd className="text-right tabular-nums">{status.preview[k]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <p className="font-medium">{t('metrics.history')}</p>
            {status.history.length === 0 ? (
              <p className="text-muted-foreground">{t('metrics.historyNone')}</p>
            ) : (
              <ul className="mt-1 space-y-0.5" data-metrics-history>
                {status.history.map((h, i) => (
                  <li key={i} className="flex min-w-0 flex-wrap gap-x-2">
                    <span className="shrink-0 text-muted-foreground">{fmt(h.at)}</span>
                    <span className="min-w-0 break-words">
                      {h.ok ? t('metrics.sentOk', { period: h.period }) : t('metrics.sentFailed', { period: h.period, error: h.error, attempt: String(h.attempt) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs break-words text-destructive">{error}</p>}
    </div>
  )
}
