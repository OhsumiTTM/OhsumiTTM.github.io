'use client'

// データの持ち方(団体の設定の画面。代表だけ)。gas/src/39-record-rows.gs
//   コメント・進み具合・変更の記録・1on1・評価を、1件1行のシート(TaskRecords・MemberRecords)に移す・戻す。
//   試す(書かずに件数と問題を見る) → 移す(実行の前に自動でバックアップ。1回ずつ進め、終わるまで続けて呼ぶ。
//   途中で止まっても「続きから移す」) → 照合して切り替える。戻すも同じ(自動でバックアップを取ってから)
// 古い GAS(初期データに recordRows が無い)では出さない
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Rows3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useToast } from '@/components/ohsumi/toast'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { remoteApi, type RecordRowsStatus, type RecordRowsStep } from '@/lib/ohsumi/remote'

const KINDS = ['comment', 'progress', 'history', 'one_on_one', 'evaluation'] as const
const STEP_LIMIT = 50

export function RecordRowsPanel() {
  const { t } = useI18n()
  const toast = useToast()
  const { recordRows, refreshAll } = useOhsumi()
  const [status, setStatus] = useState<RecordRowsStatus | null>(null)
  const [trial, setTrial] = useState<RecordRowsStep | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'' | 'load' | 'try' | 'run'>('')
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const load = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      setStatus(await remoteApi.getRecordRowsStatus())
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }, [])
  useEffect(() => { if (recordRows) void load() }, [load, recordRows])
  if (!recordRows) return null

  const rowsOn = status?.state === 'done'
  const counts = (rowsOn ? status?.rows : status?.cells) ?? {}

  const tryIt = async () => {
    setBusy('try')
    setError(null)
    setTrial(null)
    setConfirmed(false)
    try {
      setTrial(rowsOn ? await remoteApi.revertRecordRows(true) : await remoteApi.migrateRecordsToRows(true))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }

  // 終わる(done)・照合が合わない(failed)まで、1回ずつ進める
  const run = async () => {
    setBusy('run')
    setError(null)
    try {
      let last: RecordRowsStep | null = null
      for (let i = 0; i < STEP_LIMIT; i++) {
        last = rowsOn ? await remoteApi.revertRecordRows(false) : await remoteApi.migrateRecordsToRows(false)
        if (last.done || last.state === 'failed') break
        setProgress(t('recordRows.progress', { sheet: last.cursor?.sheet ?? '', index: String(last.cursor?.index ?? 0) }))
      }
      if (last?.state === 'failed') setError(t('recordRows.failed', { where: (last.mismatches ?? []).slice(0, 5).join('、') }))
      else if (last?.done) toast(t(rowsOn ? 'recordRows.revertedToast' : 'recordRows.migratedToast'))
      setTrial(null)
      setConfirmed(false)
      refreshAll()
    } catch (e) {
      setError(message(e))
    } finally {
      setProgress('')
      setBusy('')
      void load()
    }
  }

  const stateKey = `recordRows.state.${status?.state ?? 'none'}` as TranslationKey
  const problems = trial?.problems
  const trialOk = trial ? trial.ok !== false : false

  return (
    <div className="flex flex-col gap-3" data-record-rows={status?.state ?? ''}>
      <SectionLabel>{t('recordRows.title')}</SectionLabel>
      <p className="text-xs text-muted-foreground">{t('recordRows.desc')}</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Rows3 className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{status ? t(stateKey) : t('recordRows.loading')}</span>
        {status?.backup && <span className="min-w-0 break-all text-xs text-muted-foreground">{t('recordRows.backup', { name: status.backup })}</span>}
      </div>
      {status && (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {KINDS.map((k) => (
            <li key={k} className="flex justify-between gap-2">
              <span className="text-muted-foreground">{t(`recordRows.kind.${k}` as TranslationKey)}</span>
              <span className="tabular-nums">{counts[k] ?? 0}</span>
            </li>
          ))}
        </ul>
      )}
      {status?.state === 'migrating' && <p className="text-xs text-amber-700 dark:text-amber-400">{t('recordRows.resumeHint')}</p>}
      {status?.message && <p className="text-xs text-destructive">{status.message}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!!busy || !status} onClick={tryIt}>
          {busy === 'try' && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {t(rowsOn ? 'recordRows.tryRevert' : 'recordRows.tryMigrate')}
        </Button>
        {status?.state === 'migrating' && (
          <Button type="button" size="sm" disabled={!!busy} onClick={run}>{t('recordRows.resume')}</Button>
        )}
      </div>

      {trial && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs" data-record-rows-trial>
          {rowsOn ? (
            <p>{trialOk ? t('recordRows.revertTrialOk') : t('recordRows.revertTrialNg', { list: (trial.tooLong ?? []).slice(0, 5).join('、') })}</p>
          ) : (
            <>
              <p>{t('recordRows.migrateTrial', { count: String(trial.entries ?? 0) })}</p>
              {problems && (problems.unreadable.length > 0 || problems.tooLong.length > 0) && (
                <p className="break-all text-destructive">{t('recordRows.problems', { list: [...problems.unreadable, ...problems.tooLong].slice(0, 5).join('、') })}</p>
              )}
              {problems && problems.duplicates.length > 0 && (
                <p className="break-all text-muted-foreground">{t('recordRows.duplicates', { count: String(problems.duplicates.length) })}</p>
              )}
            </>
          )}
          {trialOk && (
            <>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>{t(rowsOn ? 'recordRows.confirmRevert' : 'recordRows.confirmMigrate')}</span>
              </label>
              <div>
                <Button type="button" size="sm" disabled={!confirmed || !!busy} onClick={run}>
                  {busy === 'run' && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {t(rowsOn ? 'recordRows.revert' : 'recordRows.migrate')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {progress && <p className="text-xs text-muted-foreground" aria-live="polite">{progress}</p>}
      {error && <p className="break-all text-xs text-destructive" role="alert">{error}</p>}
    </div>
  )
}
