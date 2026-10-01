'use client'

// 個人情報の削除(団体の設定の画面。代表だけ)。gas/Code.gs の「個人情報の削除」
//   - 保存期間(7〜365日。既定30日)を変える
//   - 消す前の人(退会したメンバー・採用しなかった候補者)の一覧から、すぐ消す・延長・退会を取り消す
import { useCallback, useEffect, useState } from 'react'
import { Loader2, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useToast } from '@/components/ohsumi/toast'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { remoteApi, type PendingPersonalData, type PersonalDataStatus, type UnassignedTask } from '@/lib/ohsumi/remote'

export function PersonalDataPanel() {
  const { t, locale } = useI18n()
  const toast = useToast()
  const { refreshAll } = useOhsumi()
  const [status, setStatus] = useState<PersonalDataStatus | null>(null)
  const [days, setDays] = useState('')
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 退会を取り消した時の、退会の時に未アサインに戻したタスク
  const [unassigned, setUnassigned] = useState<{ name: string; tasks: UnassignedTask[] } | null>(null)
  const [confirmOrphans, setConfirmOrphans] = useState(false)
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const fmt = (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium' }).format(new Date(iso)) : '—')

  const load = useCallback(async () => {
    try {
      const s = await remoteApi.getPersonalDataStatus()
      setStatus(s)
      setDays(String(s.retentionDays))
    } catch (e) {
      setError(message(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      toast(done)
      setConfirming(null)
      setConfirmOrphans(false)
      await load()
      refreshAll()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy('')
    }
  }

  const n = Number(days)
  const daysValid = status !== null && Number.isInteger(n) && n >= status.min && n <= status.max
  const keyOf = (p: PendingPersonalData) => p.kind + ':' + p.id

  return (
    <div data-personal-data-panel>
      <div className="flex items-center gap-1.5">
        <UserX className="size-4 text-muted-foreground" />
        <SectionLabel>{t('privacy.title')}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('privacy.desc')}</p>
      {!status && !error && <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('backup.loading')}</p>}
      {status && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs">
              {t('privacy.retention')}
              <input
                type="number"
                min={status.min}
                max={status.max}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="h-9 w-20 rounded-lg border border-border bg-background px-2 text-sm"
                data-privacy-days
              />
              {t('privacy.daysUnit')}
            </label>
            <Button
              size="sm"
              disabled={!daysValid || n === status.retentionDays || busy !== ''}
              onClick={() => void run('days', () => remoteApi.setPersonalDataRetention(n), t('privacy.retentionSaved', { days: String(n) }))}
            >
              {t('orgSettings.nameLogo.save')}
            </Button>
          </div>
          {!daysValid && <p className="text-xs text-destructive">{t('privacy.retentionRange', { min: String(status.min), max: String(status.max) })}</p>}

          {unassigned && (
            <div className="space-y-1 rounded-md border border-border bg-muted/50 p-2 text-xs" data-privacy-unassigned>
              <p className="font-medium break-words">
                {unassigned.tasks.length
                  ? t('privacy.unassignedTasks', { name: unassigned.name, count: String(unassigned.tasks.length) })
                  : t('privacy.unassignedNone', { name: unassigned.name })}
              </p>
              {unassigned.tasks.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5">
                  {unassigned.tasks.map((task) => (
                    <li key={task.id} className="break-words">
                      {task.title}
                      {task.assigneeIds.length ? ` ${t('privacy.reassigned')}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {unassigned.tasks.length > 0 && <p className="text-muted-foreground">{t('privacy.unassignedHint')}</p>}
              <Button size="sm" variant="ghost" onClick={() => setUnassigned(null)}>{t('otherDevice.close')}</Button>
            </div>
          )}

          {(status.orphanEmails?.length ?? 0) > 0 && (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning-muted p-2 text-xs" data-privacy-orphans>
              <p className="font-medium text-warning">{t('privacy.orphanEmails', { count: String(status.orphanEmails!.length) })}</p>
              <p className="break-words">{t('privacy.orphanHint')}</p>
              <ul className="space-y-0.5">
                {status.orphanEmails!.map((o) => (
                  <li key={o.id + o.email} className="flex min-w-0 flex-wrap gap-x-2">
                    <span className="font-mono break-all text-muted-foreground">{o.id}</span>
                    <span className="min-w-0 break-all">{o.email}</span>
                  </li>
                ))}
              </ul>
              {confirmOrphans ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words">{t('privacy.orphanConfirm', { count: String(status.orphanEmails!.length) })}</span>
                  <Button size="sm" variant="destructive" disabled={busy !== ''}
                    onClick={() => void run('orphans', () => remoteApi.deleteOrphanEmails(status.orphanEmails!.map((o) => o.id)), t('privacy.orphanDeletedToast'))}>
                    {t('privacy.orphanDelete')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmOrphans(false)}>{t('admin.members.cancel')}</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => setConfirmOrphans(true)}>{t('privacy.orphanDelete')}</Button>
              )}
            </div>
          )}

          {status.pending.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('privacy.none')}</p>
          ) : (
            <ul className="space-y-2" data-privacy-pending>
              {status.pending.map((p) => (
                <li key={keyOf(p)} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-medium">{p.name || p.id}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {p.kind === 'member' ? t('privacy.kindMember') : t('privacy.kindCandidate')}
                    </span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {t('privacy.dates', { since: fmt(p.since), purgeAt: fmt(p.purgeAt) })}
                    {p.extended ? ` ${t('privacy.extended')}` : ''}
                  </p>
                  {confirming === keyOf(p) ? (
                    <div className="mt-2 space-y-2 rounded bg-destructive/5 p-2">
                      <p className="break-words">{t('privacy.confirmPurge', { name: p.name || p.id })}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="destructive" disabled={busy !== ''}
                          onClick={() => void run(keyOf(p), () => remoteApi.purgePersonalDataNow(p.kind, p.id), t('privacy.purgedToast', { name: p.name || p.id }))}>
                          {t('privacy.purgeNow')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t('admin.members.cancel')}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => setConfirming(keyOf(p))}>{t('privacy.purgeNow')}</Button>
                      <Button size="sm" variant="outline" disabled={busy !== ''}
                        onClick={() => void run(keyOf(p) + ':extend', () => remoteApi.extendPersonalData(p.kind, p.id), t('privacy.extendedToast', { days: String(status.retentionDays) }))}>
                        {t('privacy.extend', { days: String(status.retentionDays) })}
                      </Button>
                      {p.kind === 'member' && (
                        <Button size="sm" variant="ghost" disabled={busy !== ''}
                          onClick={() => void run(keyOf(p) + ':cancel', async () => {
                            const res = await remoteApi.cancelWithdrawal(p.id)
                            setUnassigned({ name: p.name || p.id, tasks: res.unassignedTasks ?? [] })
                          }, t('privacy.cancelledToast', { name: p.name || p.id }))}>
                          {t('privacy.cancelWithdrawal')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs break-words text-destructive">{error}</p>}
    </div>
  )
}
