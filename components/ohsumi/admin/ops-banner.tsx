'use client'

// 毎日の処理の止まりと、共有の警告(管理画面の上部。代表だけ)。gas/Code.gs の jobStatus_・checkSharing_
//   - 毎日の処理が26時間以上成功していない: 最後に成功した日時と、最後のエラー・直し方を出す
//   - スプレッドシート・フォルダの共有に問題がある: 問題ごとに直し方を出し、直した後に「確かめ直す」で消せる
//   - 1つの記録が上限(5万文字)の8割を超えている: 記録の種類ごとに件数と記録を出す(gas/Code.gs の longRecords_)
//   - FSIF からの回答待ちのアンケート: 回答のリンク・回答期限・未回答で入る機能停止の日時を出す(gas/Code.gs の surveysStatus_)
import { useEffect, useState } from 'react'
import { ClipboardList, ExternalLink, FileWarning, ShieldAlert, TimerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type OpsStatus, type SharingProblem } from '@/lib/ohsumi/remote'
import { cellFieldLabel } from '@/lib/ohsumi/cell-limits'

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
// Google フォームの URL だけをリンクにする(GAS とレジストリでも確かめている)
const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/

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
  const longGroups = status.longRecords?.groups ?? []
  const longCount = longGroups.reduce((n, g) => n + g.count, 0)
  const surveys = (status.surveys ?? []).filter((s) => FORM_URL.test(s.formUrl))
  if (!status.jobs.dailyStale && problems.length === 0 && longCount === 0 && surveys.length === 0) return null
  const fmtDay = (key: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(new Date(key + 'T00:00:00+09:00'))

  const recheck = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await remoteApi.recheckSharing()
      setStatus((prev) => ({ ...next, longRecords: next.longRecords ?? prev?.longRecords, surveys: next.surveys ?? prev?.surveys }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-border">
      {surveys.length > 0 && (
        <div role="status" data-ops-surveys className={'flex items-start gap-1.5 px-4 py-2 text-xs ' + (surveys.some((s) => s.overdue) ? 'bg-destructive/10 text-destructive' : 'bg-warning-muted text-warning')}>
          <ClipboardList className="mt-px size-3.5 shrink-0" />
          <div className="min-w-0 flex-1 break-words">
            <p className="font-medium">{t('ops.surveys.title', { count: String(surveys.length) })}</p>
            <ul className="mt-1 space-y-1.5">
              {surveys.map((s) => (
                <li key={s.surveyId} data-ops-survey>
                  <span className="font-medium text-foreground">{s.title}</span>
                  <span className="block">{s.overdue ? t('ops.surveys.overdue', { date: fmtDay(s.dueDate) }) : t('ops.surveys.due', { date: fmtDay(s.dueDate) })}</span>
                  {s.restrictAt && <span className="block">{t('ops.surveys.restrict', { at: fmt(s.restrictAt) })}</span>}
                  <a href={s.formUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2">
                    {t('ops.surveys.open')}
                    <ExternalLink className="size-3" />
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-foreground/80">{t('ops.surveys.desc')}</p>
          </div>
        </div>
      )}
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
      {longCount > 0 && (
        <div role="status" data-ops-long-records className="flex items-start gap-1.5 bg-warning-muted px-4 py-2 text-xs text-warning">
          <FileWarning className="mt-px size-3.5 shrink-0" />
          <div className="min-w-0 flex-1 break-words">
            <p className="font-medium">{t('ops.long.title', { count: String(longCount) })}</p>
            <p className="mt-0.5 text-foreground/80">{t('ops.long.desc', { max: status.longRecords!.max.toLocaleString() })}</p>
            <ul className="mt-1 space-y-1">
              {longGroups.map((g) => (
                <li key={g.sheet + ':' + g.field}>
                  <span className="font-medium">{t('ops.long.group', { field: cellFieldLabel(g.field, t), count: String(g.count) })}</span>
                  <span className="block text-foreground/80">
                    {g.items.map((it) => t('ops.long.item', { name: it.name || it.id, length: it.length.toLocaleString() })).join(locale === 'en' ? ', ' : '、')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
