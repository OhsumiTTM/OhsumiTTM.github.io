'use client'

// 利用の状況(団体の設定の画面。代表だけ)。gas/Code.gs の「利用の集計とエラーの記録」
//   - 直近14日の、ログイン・画面の読み込み・書き込みの回数(日ごと。誰の操作かは残していない)
//   - 直近30日に多い操作
//   - 直近7日のエラーの件数と種類、直近の記録(日時・操作の名前・エラーの種類だけ)
import { useEffect, useState } from 'react'
import { Activity, Loader2 } from 'lucide-react'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useI18n } from '@/lib/ohsumi/i18n'
import { remoteApi, type UsageStatus } from '@/lib/ohsumi/remote'

export function UsagePanel() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<UsageStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    remoteApi.getUsageStatus().then(
      (s) => { if (alive) setStatus(s) },
      (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { alive = false }
  }, [])
  const fmtDay = (d: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { month: 'numeric', day: 'numeric' }).format(new Date(d + 'T00:00:00'))
  const fmtAt = (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—')
  const sum = (k: 'login' | 'open' | 'writes') => (status ? status.days.slice(-7).reduce((n, d) => n + d[k], 0) : 0)

  return (
    <div data-usage-panel>
      <div className="flex items-center gap-1.5">
        <Activity className="size-4 text-muted-foreground" />
        <SectionLabel>{t('usage.title')}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('usage.desc')}</p>
      {!status && !error && <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('backup.loading')}</p>}
      {error && <p className="mt-2 text-xs break-words text-destructive">{error}</p>}
      {status && (
        <div className="mt-3 space-y-3 text-xs">
          <p className="break-words" data-usage-week>{t('usage.week', { login: String(sum('login')), open: String(sum('open')), writes: String(sum('writes')) })}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[18rem] table-fixed">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-normal">{t('usage.date')}</th>
                  <th className="py-1 font-normal">{t('usage.login')}</th>
                  <th className="py-1 font-normal">{t('usage.open')}</th>
                  <th className="py-1 font-normal">{t('usage.writes')}</th>
                </tr>
              </thead>
              <tbody>
                {status.days.slice().reverse().map((d) => (
                  <tr key={d.date}>
                    <td className="py-0.5">{fmtDay(d.date)}</td>
                    <td className="py-0.5">{d.login}</td>
                    <td className="py-0.5">{d.open}</td>
                    <td className="py-0.5">{d.writes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {status.topActions.length > 0 && (
            <div>
              <p className="font-medium">{t('usage.topActions')}</p>
              <ul className="mt-1 space-y-0.5">
                {status.topActions.map((a) => (
                  <li key={a.action} className="flex min-w-0 justify-between gap-2">
                    <span className="min-w-0 font-mono break-all">{a.action}</span>
                    <span className="shrink-0">{a.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div data-usage-errors>
            <p className="font-medium">{t('usage.errors', { count: String(status.errors.last7Days) })}</p>
            {status.errors.byKind.length > 0 && (
              <p className="mt-0.5 break-words text-muted-foreground">
                {status.errors.byKind.map((k) => `${k.kind} ${k.count}`).join(locale === 'en' ? ', ' : '、')}
              </p>
            )}
            {status.errors.recent.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {status.errors.recent.slice(0, 10).map((r, i) => (
                  <li key={i} className="flex min-w-0 flex-wrap gap-x-2">
                    <span className="shrink-0 text-muted-foreground">{fmtAt(r.at)}</span>
                    <span className="min-w-0 font-mono break-all">{[r.source, r.action, r.kind].filter(Boolean).join(' / ')}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-muted-foreground">{t('usage.errorsHint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
