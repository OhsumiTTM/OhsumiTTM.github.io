'use client'

// バックアップから戻す(団体の設定の画面。代表だけ)。gas/Code.gs の「バックアップ」
//   - 全体を戻す: バックアップを選び、シートごとの件数の差を見てから戻す(戻す前の状態は自動でバックアップされる)
//   - 一部のタスクだけ戻す: バックアップを選び、タスクを名前で探して選ぶ。今との違いを並べ、今は消えているタスクは「復元」と出す
import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, Loader2, RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useToast } from '@/components/ohsumi/toast'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { remoteApi, type BackupEntry, type BackupStatus, type BackupTaskMatch, type RestorePreview } from '@/lib/ohsumi/remote'

type Mode = 'full' | 'tasks'

export function BackupPanel() {
  const { t, locale } = useI18n()
  const toast = useToast()
  const { refreshAll } = useOhsumi()
  const [list, setList] = useState<{ status: BackupStatus; backups: BackupEntry[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [backupId, setBackupId] = useState('')
  const [mode, setMode] = useState<Mode>('full')
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<BackupTaskMatch[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState<'' | 'list' | 'preview' | 'restore' | 'search'>('')
  const [error, setError] = useState<string | null>(null)

  const fmt = useCallback(
    (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—'),
    [locale],
  )
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const load = useCallback(async () => {
    setBusy('list')
    setLoadError(null)
    try {
      setList(await remoteApi.listBackups())
    } catch (e) {
      setLoadError(message(e))
    } finally {
      setBusy('')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const choose = async (id: string, nextMode: Mode = mode) => {
    setBackupId(id)
    setMode(nextMode)
    setPreview(null)
    setConfirmed(false)
    setMatches(null)
    setPicked([])
    setError(null)
    if (!id || nextMode !== 'full') return
    setBusy('preview')
    try {
      setPreview(await remoteApi.previewRestore(id))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }

  const restoreAll = async () => {
    setBusy('restore')
    setError(null)
    try {
      const res = await remoteApi.restoreBackup(backupId)
      toast(t('backup.restoredToast', { name: res.beforeRestore.name }))
      setBackupId('')
      setPreview(null)
      refreshAll()
      void load()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setBusy('search')
    setError(null)
    try {
      setMatches((await remoteApi.searchBackupTasks(backupId, query.trim())).tasks)
      setPicked([])
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy('')
    }
  }

  const restorePicked = async () => {
    setBusy('restore')
    setError(null)
    try {
      const res = await remoteApi.restoreTasks(backupId, picked)
      toast(t('backup.tasksRestoredToast', { count: String(res.restored.length) }))
      setMatches(null)
      setPicked([])
      refreshAll()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }

  const stateLabel = (s: BackupTaskMatch['state']) =>
    s === 'missing' ? t('backup.taskStateMissing') : s === 'changed' ? t('backup.taskStateChanged') : t('backup.taskStateSame')

  return (
    <div data-backup-panel>
      <div className="flex items-center gap-1.5">
        <DatabaseBackup className="size-4 text-muted-foreground" />
        <SectionLabel>{t('backup.title')}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('backup.desc')}</p>
      {list?.status.failed && (
        <p className="mt-2 text-xs break-words text-warning">{t('backup.failedBanner', { date: fmt(list.status.failedAt), error: list.status.error })}</p>
      )}
      {loadError && <p className="mt-2 text-xs break-words text-destructive">{loadError}</p>}
      {busy === 'list' && !list && <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('backup.loading')}</p>}

      {list && (
        <div className="mt-3 space-y-3">
          {list.backups.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('backup.none')}</p>
          ) : (
            <>
              <label className="block text-xs">
                {t('backup.pick')}
                <select
                  className="mt-1 h-9 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-sm"
                  value={backupId}
                  onChange={(e) => void choose(e.target.value)}
                  data-backup-select
                >
                  <option value="">{t('backup.pickPlaceholder')}</option>
                  {list.backups.map((b) => (
                    <option key={b.id} value={b.id}>
                      {fmt(b.at)}{b.kind === 'beforeRestore' ? ` ${t('backup.beforeRestore')}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {backupId && (
                <div className="flex flex-wrap gap-2" role="tablist">
                  <Button size="sm" variant={mode === 'full' ? 'default' : 'outline'} onClick={() => void choose(backupId, 'full')}>{t('backup.modeFull')}</Button>
                  <Button size="sm" variant={mode === 'tasks' ? 'default' : 'outline'} onClick={() => void choose(backupId, 'tasks')}>{t('backup.modeTasks')}</Button>
                </div>
              )}
            </>
          )}

          {backupId && mode === 'full' && (
            <div className="space-y-2 rounded-lg bg-muted/50 p-3" data-backup-preview>
              {busy === 'preview' && <p className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('backup.loading')}</p>}
              {preview && (
                <>
                  <p className="text-xs">{t('backup.previewDesc')}</p>
                  <table className="w-full table-fixed text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="w-1/2 py-1 font-normal">{t('backup.sheet')}</th>
                        <th className="py-1 font-normal">{t('backup.now')}</th>
                        <th className="py-1 font-normal">{t('backup.inBackup')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sheets.map((s) => (
                        <tr key={s.name} className={s.current !== s.backup ? 'font-medium' : ''}>
                          <td className="py-0.5 break-all">{s.name}</td>
                          <td className="py-0.5">{s.current ?? '—'}</td>
                          <td className="py-0.5">{s.backup ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    <span className="min-w-0 break-words">{t('backup.confirmFull')}</span>
                  </label>
                  <Button size="sm" variant="destructive" disabled={!confirmed || busy !== ''} onClick={() => void restoreAll()} data-backup-restore-all>
                    {busy === 'restore' ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                    {busy === 'restore' ? t('backup.restoring') : t('backup.restoreFull')}
                  </Button>
                </>
              )}
            </div>
          )}

          {backupId && mode === 'tasks' && (
            <div className="space-y-2 rounded-lg bg-muted/50 p-3" data-backup-tasks>
              <form onSubmit={(e) => void search(e)} className="flex min-w-0 gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('backup.searchPlaceholder')}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm"
                  aria-label={t('backup.searchPlaceholder')}
                />
                <Button type="submit" size="sm" variant="outline" disabled={busy !== '' || !query.trim()} className="shrink-0">
                  <Search className="size-3.5" />
                  {t('backup.search')}
                </Button>
              </form>
              {matches && matches.length === 0 && <p className="text-xs text-muted-foreground">{t('backup.noMatches')}</p>}
              {matches && matches.length > 0 && (
                <ul className="space-y-2">
                  {matches.map((m) => (
                    <li key={m.id} className="rounded-md border border-border bg-background p-2 text-xs">
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          disabled={m.state === 'same'}
                          checked={picked.includes(m.id)}
                          onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((id) => id !== m.id))}
                        />
                        <span className="min-w-0 flex-1 break-words font-medium">{m.title}</span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 ${m.state === 'missing' ? 'bg-primary/10 text-primary' : m.state === 'changed' ? 'bg-warning-muted text-warning' : 'bg-muted text-muted-foreground'}`}>
                          {stateLabel(m.state)}
                        </span>
                      </label>
                      {m.diffs.length > 0 && (
                        <dl className="mt-1.5 space-y-1 pl-5">
                          {m.diffs.map((d) => (
                            <div key={d.field} className="min-w-0">
                              <dt className="text-muted-foreground">{d.field}</dt>
                              <dd className="break-words">
                                {t('backup.diffLine', { current: d.current || '—', backup: d.backup || '—' })}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {matches && matches.length > 0 && (
                <>
                  <p className="text-xs text-muted-foreground">{t('backup.tasksNote')}</p>
                  <Button size="sm" disabled={!picked.length || busy !== ''} onClick={() => void restorePicked()} data-backup-restore-tasks>
                    {busy === 'restore' ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                    {t('backup.restoreTasks', { count: String(picked.length) })}
                  </Button>
                </>
              )}
            </div>
          )}
          {error && <p className="text-xs break-words text-destructive">{error}</p>}
        </div>
      )}
    </div>
  )
}
