'use client'

// 毎日の処理の止まりと、共有の警告(管理画面の上部。代表だけ)。gas/Code.gs の jobStatus_・checkSharing_
//   - 毎日の処理が26時間以上成功していない: 最後に成功した日時と、最後のエラー・直し方を出す
//   - スプレッドシート・フォルダの共有に問題がある: 問題ごとに直し方を出し、直した後に「確かめ直す」で消せる
import { useEffect, useState } from 'react'
import { ShieldAlert, TimerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type OpsStatus, type SharingProblem } from '@/lib/ohsumi/remote'

const TARGET_KEYS: Record<SharingProblem['target'], TranslationKey> = {
  spreadsheet: 'ops.sharing.target.spreadsheet',
  uploads: 'ops.sharing.target.uploads',
  backups: 'ops.sharing.target.backups',
}
const KIND_KEYS: Record<SharingProblem['kind'], TranslationKey> = {
  link: 'ops.sharing.kind.link',
  editor: 'ops.sharing.kind.editor',
  viewer: 'ops.sharing.kind.viewer',
  unknown: 'ops.sharing.kind.unknown',
}
const FIX_KEYS: Record<SharingProblem['kind'], TranslationKey> = {
  link: 'ops.sharing.fix.link',
  editor: 'ops.sharing.fix.editor',
  viewer: 'ops.sharing.fix.viewer',
  unknown: 'ops.sharing.fix.unknown',
}

export function OpsBanner() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<OpsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isRemoteConfigured) return
    let alive = true
    remoteApi.getOpsStatus().then(
      (s) => { if (alive) setStatus(s) },
      () => { /* 確かめられない時(古い GAS など)は何も出さない */ },
    )
    return () => { alive = false }
  }, [])

  if (!status) return null
  const fmt = (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : t('ops.jobs.never'))
  const problems = status.sharing.problems
  if (!status.jobs.dailyStale && problems.length === 0) return null

  const recheck = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await remoteApi.recheckSharing())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-border">
      {status.jobs.dailyStale && (
        <div role="status" data-ops-jobs className="flex items-start gap-1.5 bg-warning-muted px-4 py-2 text-xs text-warning">
          <TimerOff className="mt-px size-3.5 shrink-0" />
          <div className="min-w-0 break-words">
            <p className="font-medium">{t('ops.jobs.stale', { hours: String(status.jobs.staleHours), at: fmt(status.jobs.dailyAt) })}</p>
            {status.jobs.dailyError && <p className="mt-0.5">{t('ops.jobs.lastError', { at: fmt(status.jobs.dailyFailedAt), error: status.jobs.dailyError })}</p>}
            <p className="mt-0.5">{t('ops.jobs.fix')}</p>
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <div role="status" data-ops-sharing className="flex items-start gap-1.5 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          <div className="min-w-0 flex-1 break-words">
            <p className="font-medium">{t('ops.sharing.title', { count: String(problems.length) })}</p>
            <ul className="mt-1 space-y-1">
              {problems.map((p, i) => (
                <li key={i}>
                  <span className="font-medium">{t(TARGET_KEYS[p.target])}</span>: {t(KIND_KEYS[p.kind], { detail: p.detail })}
                  <span className="block text-foreground/80">{t(FIX_KEYS[p.kind], { detail: p.detail })}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-foreground/80">{t('ops.sharing.allowed')}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void recheck()} data-ops-recheck>
                {busy ? t('ops.sharing.rechecking') : t('ops.sharing.recheck')}
              </Button>
              <span className="text-foreground/70">{t('ops.sharing.checkedAt', { at: fmt(status.sharing.checkedAt) })}</span>
            </div>
            {error && <p className="mt-1">{error}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
