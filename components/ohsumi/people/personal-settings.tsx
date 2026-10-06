'use client'

// 個人設定(自分だけの画面): 通知(ベルのオン・オフ・メールの頻度)・メールアドレス・言語とタイムゾーン・
// ログイン中の端末・個人スプレッドシート連携。開き方は、右上のアカウントのメニューの「個人設定」と、
// 自分のページの上の「個人設定」のボタン。表示名・アイコン・所属・所属開始日は、自分のページの上で変える
import { useEffect, useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useNav } from '@/lib/ohsumi/nav'
import { useToast } from '@/components/ohsumi/toast'
import { CapabilityNote } from '@/components/ohsumi/primitives'
import { AdminBlock, AdminToc } from '@/components/ohsumi/admin/admin-page'
import { Button } from '@/components/ui/button'
import { BELL_KINDS, bellEnabled, type BellKind, type BellSettings } from '@/lib/ohsumi/bell-kinds'
import type { Member, NotifyFrequency, NotifyKind, NotifySettings } from '@/lib/ohsumi/types'
import { isRemoteConfigured } from '@/lib/ohsumi/remote'
import { useI18n, SUPPORTED_LOCALES, type TranslationKey } from '@/lib/ohsumi/i18n'
import { TIMEZONE_OPTIONS, DEFAULT_TIMEZONE } from '@/lib/ohsumi/timezone'
import { cn } from '@/lib/utils'
import { ArrowLeft, Check, Link2, Loader2, LogOut, Mail, RefreshCw, TriangleAlert, X } from 'lucide-react'
import {
  isGoogleOAuthConfigured,
  requestDriveFileToken,
  createPersonalSpreadsheet,
  personalSheetUrl,
  PersonalSheetUnavailableError,
  syncTasksToSheet,
  loadPersonalSheet,
  savePersonalSheet,
  hasLegacyPersonalSheet,
  clearLegacyPersonalSheet,
  type PersonalSheet,
  type SyncRow,
} from '@/lib/ohsumi/google-sheet-sync'

export function PersonalSettingsScreen() {
  const {
    currentUser,
    visibleTasks: tasks,
    members,
    getProject,
    myEmail,
    updateEmail,
    updateNotifySettings,
    setMemberTimezone,
    setMemberLocale,
    revokeAllMySessions,
    can,
  } = useOhsumi()
  const { go } = useNav()
  const toast = useToast()
  const { t, locale, setLocale } = useI18n()
  const [newEmail, setNewEmail] = useState('')
  const [personalSheet, setPersonalSheet] = useState<PersonalSheet | null>(null)
  // 以前の方式(既存のシートのURLを貼り付けて連携)で保存したシートが残っている
  const [legacySheet, setLegacySheet] = useState(false)
  const [sheetStatus, setSheetStatus] = useState<'idle' | 'creating' | 'syncing'>('idle')
  const [revokingSessions, setRevokingSessions] = useState(false)
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [sheetSyncedAt, setSheetSyncedAt] = useState<Date | null>(null)
  const member = currentUser
  const memberId = member?.id ?? ''
  useEffect(() => {
    if (!memberId) return
    setPersonalSheet(loadPersonalSheet(memberId))
    setLegacySheet(hasLegacyPersonalSheet(memberId))
  }, [memberId])
  if (!member) return null
  // 自分の担当のタスク(個人スプレッドシートに書き出す)
  const mine = tasks.filter((x) => x.assigneeIds.includes(member.id))

  // 自分自身のメールのみ扱える(セキュリティ対応でMembersの公開CSVから
  // emailを分離したため、member.emailはもう存在しない — myEmailは常に
  // 「今ログインしている本人」のメールで、この一覧は isSelf の時だけ
  // 表示されるのでそれで正しい)
  const emails = (myEmail ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  const addEmail = () => {
    const v = newEmail.trim()
    if (!v || emails.includes(v)) {
      setNewEmail('')
      return
    }
    updateEmail(member.id, [...emails, v].join(','))
    setNewEmail('')
  }
  const removeEmail = (email: string) => {
    updateEmail(member.id, emails.filter((e) => e !== email).join(','))
  }

  useEffect(() => {
    setPersonalSheet(loadPersonalSheet(member.id))
    setLegacySheet(hasLegacyPersonalSheet(member.id))
  }, [member.id])

  // 同期用のスプレッドシートをアプリが新しく作成する(drive.file スコープでは、
  // アプリが作成したファイルにしか書き込めないため)
  const handleSheetCreate = async () => {
    setSheetStatus('creating')
    setSheetError(null)
    try {
      const token = await requestDriveFileToken()
      const sheet = await createPersonalSpreadsheet(token, t('person.sheet.newSheetTitle', { name: member.name }))
      savePersonalSheet(member.id, sheet)
      setPersonalSheet(sheet)
      setLegacySheet(false)
      setSheetSyncedAt(null)
      toast(t('person.sheet.created'))
    } catch (e) {
      setSheetError(e instanceof Error ? e.message : t('person.sheet.authFailed'))
    } finally {
      setSheetStatus('idle')
    }
  }

  const handleSheetSync = async () => {
    setSheetStatus('syncing')
    setSheetError(null)
    try {
      if (!personalSheet) return
      const token = await requestDriveFileToken(true)
      const rows: SyncRow[] = mine.map((t) => ({
        taskName: t.name,
        project: getProject(t.projectId)?.name ?? '',
        department: member.affiliation,
        assignees: t.assigneeIds.map((aid) => members.find((m) => m.id === aid)?.name ?? aid).join(', '),
        status: t.status,
        priority: t.priority,
        difficulty: t.difficulty,
        category: t.category,
        skills: t.skills.join(', '),
        startDate: t.startDate ?? '',
        deadline: t.deadline ?? '',
        completedDate: t.completedDate ?? '',
        progress: String(t.progress ?? ''),
        description: t.description ?? '',
      }))
      await syncTasksToSheet(personalSheet.id, token, rows)
      setSheetSyncedAt(new Date())
      toast(t('person.sheet.synced'))
    } catch (e) {
      if (e instanceof PersonalSheetUnavailableError) {
        setSheetError(t('person.sheet.unavailable'))
      } else {
        setSheetError(e instanceof Error ? e.message : t('person.sheet.syncFailed'))
      }
    } finally {
      setSheetStatus('idle')
    }
  }

  // 連携を解除する(スプレッドシート自体は削除しない)
  const handleSheetDisconnect = () => {
    savePersonalSheet(member.id, null)
    setPersonalSheet(null)
    setSheetError(null)
    setSheetSyncedAt(null)
  }

  const dismissLegacySheet = () => {
    clearLegacyPersonalSheet(member.id)
    setLegacySheet(false)
  }

  const blocks: { id: string; title: string; desc?: string; content: React.ReactNode }[] = [
    {
      id: 'settings-notify',
      title: t('personalSettings.section.notify'),
      content: (
        <div className="rounded-xl border border-border bg-card p-4" data-settings-section="notify">
          <BellSettingsList member={member} onUpdate={(settings) => updateNotifySettings(member.id, settings)} />
          <p className="mt-5 text-xs font-semibold">{t('personalSettings.mailFrequency')}</p>
          <NotifySettingsTable member={member} onUpdate={(settings) => updateNotifySettings(member.id, settings)} />
        </div>
      ),
    },
    {
      id: 'settings-email',
      title: t('personalSettings.section.email'),
      desc: t('person.account.emailDesc'),
      content: (
        <div className="rounded-xl border border-border bg-card p-4" data-settings-section="email">
          {/* メールアドレスの変更(updateEmail)は、本人による変更も含めて、できる操作 members.hr の人だけ */}
          <CapabilityNote cap="members.hr" className="mb-1" />
          <div className="flex flex-wrap items-center gap-1.5">
            <Mail className="size-4 shrink-0 text-muted-foreground" />
            {emails.map((e) => (
              <span
                key={e}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-1.5 py-0.5 text-xs font-medium"
              >
                {e}
                {can('members.hr') && (
                  <button
                    onClick={() => removeEmail(e)}
                    data-gas-action="updateEmail"
                    className="opacity-60 hover:opacity-100"
                    aria-label={t('person.account.removeEmail', { email: e })}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
            {can('members.hr') && <input
              value={newEmail}
              onChange={(ev) => setNewEmail(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.nativeEvent.isComposing || ev.keyCode === 229) return
                if (ev.key === 'Enter') {
                  ev.preventDefault()
                  addEmail()
                }
              }}
              onBlur={() => {
                if (newEmail.trim()) addEmail()
              }}
              placeholder={t('person.account.emailPlaceholder')}
              type="email"
              data-gas-action="updateEmail"
              className="h-7 w-48 rounded-md border border-dashed border-border-strong bg-background px-2 text-xs outline-none focus:border-primary"
            />}
          </div>        </div>
      ),
    },
    {
      id: 'settings-language',
      title: t('personalSettings.section.language'),
      content: (
        <div className="rounded-xl border border-border bg-card p-4" data-settings-section="language">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select
                value={locale}
                onChange={(e) => {
                  const next = e.target.value as (typeof SUPPORTED_LOCALES)[number]['code']
                  setLocale(next)
                  setMemberLocale(member.id, next)
                }}
                aria-label={t('settings.language')}
                className="h-9 cursor-pointer rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-primary"
              >
                {SUPPORTED_LOCALES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <select
                value={member.timezone ?? DEFAULT_TIMEZONE}
                onChange={(e) => setMemberTimezone(member.id, e.target.value)}
                aria-label={t('settings.timezone')}
                className="h-9 cursor-pointer rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-primary"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ),
    },
    ...(isRemoteConfigured
      ? [{
          id: 'settings-sessions',
          title: t('person.account.sessionsTitle'),
          content: (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mt-0.5 text-xs text-muted-foreground">{t('person.account.sessionsDesc')}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 h-8 gap-1.5 border-destructive/40 text-xs text-destructive hover:bg-destructive/5 hover:text-destructive"
                disabled={revokingSessions}
                onClick={async () => {
                  if (!window.confirm(t('person.account.revokeAllConfirm'))) return
                  setRevokingSessions(true)
                  try {
                    await revokeAllMySessions()
                  } catch (e) {
                    toast(t('person.account.revokeAllFailed', { error: e instanceof Error ? e.message : String(e) }))
                    setRevokingSessions(false)
                  }
                }}
              >
                {revokingSessions ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                {t('person.account.revokeAll')}
              </Button>
            </div>
          ),
        }]
      : []),
    ...(isGoogleOAuthConfigured()
      ? [{
          id: 'settings-sheet',
          title: t('person.sheet.title'),
          content: (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">
                {t('person.sheet.description')}
              </p>

              {legacySheet && !personalSheet && (
                <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                  <p>{t('person.sheet.legacyNotice')}</p>
                  <button type="button" onClick={dismissLegacySheet} className="mt-1 underline underline-offset-2">
                    {t('person.sheet.legacyDismiss')}
                  </button>
                </div>
              )}

              {personalSheet ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href={personalSheetUrl(personalSheet.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-primary/25 bg-primary/5 px-2 py-1 text-xs font-medium text-accent-foreground hover:underline"
                  >
                    <Check className="size-3.5 text-primary" strokeWidth={3} />
                    {personalSheet.title || personalSheet.id}
                  </a>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 text-xs"
                    disabled={sheetStatus !== 'idle'}
                    onClick={handleSheetSync}
                  >
                    {sheetStatus === 'syncing' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    {sheetStatus === 'syncing' ? t('person.sheet.syncing') : t('person.sheet.syncNow')}
                  </Button>
                  <button
                    type="button"
                    onClick={handleSheetDisconnect}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                  >
                    <X className="size-3.5" />
                    {t('person.sheet.disconnect')}
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    disabled={sheetStatus !== 'idle'}
                    onClick={handleSheetCreate}
                  >
                    {sheetStatus === 'creating' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Link2 className="size-3.5" />
                    )}
                    {sheetStatus === 'creating' ? t('person.sheet.creating') : t('person.sheet.create')}
                  </Button>
                </div>
              )}

              {sheetError && (
                <p className="mt-2 text-xs text-destructive">{sheetError}</p>
              )}
              {sheetSyncedAt && !sheetError && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('person.sheet.lastSynced', { time: sheetSyncedAt.toLocaleTimeString('ja-JP') })}
                </p>
              )}
            </div>
          ),
        }]
      : []),
  ]

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 lg:px-8" data-personal-settings>
      <button
        onClick={() => go({ name: 'person', id: member.id })}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('personalSettings.backToProfile')}
      </button>
      <h1 className="text-xl font-semibold tracking-tight">{t('personalSettings.title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('personalSettings.desc')}</p>
      <div className="mt-5 space-y-8">
        <AdminToc items={blocks.map((b) => ({ id: b.id, label: b.title }))} />
        {blocks.map((b) => (
          <AdminBlock key={b.id} id={b.id} title={b.title} desc={b.desc}>{b.content}</AdminBlock>
        ))}
      </div>
    </div>
  )
}

const NOTIFY_KINDS: { kind: NotifyKind; labelKey: TranslationKey }[] = [
  { kind: 'new_task', labelKey: 'person.settings.notify.newTask' },
  { kind: 'review', labelKey: 'person.settings.notify.review' },
  { kind: 'mention', labelKey: 'person.settings.notify.mention' },
  { kind: 'rejected', labelKey: 'person.settings.notify.rejected' },
  { kind: 'deadline', labelKey: 'person.settings.notify.deadline' },
]

const NOTIFY_FREQS: { value: NotifyFrequency; labelKey: TranslationKey }[] = [
  { value: 'immediate', labelKey: 'person.settings.freq.immediate' },
  { value: '3h', labelKey: 'person.settings.freq.3h' },
  { value: '6h', labelKey: 'person.settings.freq.6h' },
  { value: '1d', labelKey: 'person.settings.freq.1d' },
  { value: 'none', labelKey: 'common.none' },
]

function NotifySettingsTable({
  member,
  onUpdate,
}: {
  member: Member
  onUpdate: (settings: NotifySettings) => void
}) {
  const { t } = useI18n()
  const settings = member.notifySettings ?? {}

  const toggle = (kind: NotifyKind, freq: NotifyFrequency) => {
    const current = settings[kind] ?? 'none'
    onUpdate({ ...settings, [kind]: current === freq ? 'none' : freq })
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[420px] text-xs">
        <thead>
          <tr>
            <th className="pb-1.5 pr-3 text-left font-medium text-muted-foreground">{t('person.settings.notify.kindHeader')}</th>
            {NOTIFY_FREQS.map((f) => (
              <th key={f.value} className="pb-1.5 px-1 text-center font-medium text-muted-foreground whitespace-nowrap">
                {t(f.labelKey)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NOTIFY_KINDS.map(({ kind, labelKey }) => {
            const current = settings[kind] ?? 'none'
            return (
              <tr key={kind} className="border-t border-border/50">
                <td className="py-1.5 pr-3 text-left font-medium">{t(labelKey)}</td>
                {NOTIFY_FREQS.map((f) => (
                  <td key={f.value} className="py-1.5 px-1 text-center">
                    <button
                      type="button"
                      onClick={() => toggle(kind, f.value)}
                      className={cn(
                        'h-6 min-w-[36px] rounded px-1.5 text-[11px] font-medium transition-colors',
                        current === f.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-muted-foreground hover:bg-secondary/80',
                      )}
                    >
                      {t(f.labelKey)}
                    </button>
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ベルの通知の種類ごとのオン・オフ(本人の設定 notify_settings.bell。既定はすべてオン)。メールの頻度とは別に効く
const BELL_KIND_LABEL: Record<BellKind, TranslationKey> = {
  approval: 'person.settings.bell.kind.approval',
  review: 'person.settings.bell.kind.review',
  staleReview: 'person.settings.bell.kind.staleReview',
  staleProgress: 'person.settings.bell.kind.staleProgress',
  deadline: 'person.settings.bell.kind.deadline',
  mention: 'person.settings.bell.kind.mention',
  lowWorkload: 'person.settings.bell.kind.lowWorkload',
  inactive: 'person.settings.bell.kind.inactive',
  expense: 'person.settings.bell.kind.expense',
  invite: 'person.settings.bell.kind.invite',
}

function BellSettingsList({ member, onUpdate }: { member: Member; onUpdate: (settings: NotifySettings) => void }) {
  const { t } = useI18n()
  const settings = member.notifySettings ?? {}
  const bell = settings.bell ?? {}
  const set = (kind: BellKind, on: boolean) => {
    const next: BellSettings = { ...bell }
    // オン(既定)は書かない
    if (on) delete next[kind]
    else next[kind] = false
    onUpdate({ ...settings, bell: next })
  }
  return (
    <div className="mt-5" data-bell-settings>
      <p className="text-xs font-semibold">{t('person.settings.bell.title')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('person.settings.bell.desc')}</p>
      <ul className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {BELL_KINDS.map((kind) => {
          const on = bellEnabled(bell, kind)
          return (
            <li key={kind} className="min-w-0">
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => set(kind, e.target.checked)}
                  data-bell-kind={kind}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--primary)]"
                />
                <span className="min-w-0">
                  {t(BELL_KIND_LABEL[kind])}
                  {/* メンション・返信をオフにすると、頼まれたことを見落としやすい(オフにはできる) */}
                  {kind === 'mention' && !on && (
                    <span className="mt-0.5 flex items-center gap-1 text-warning" data-bell-mention-warning>
                      <TriangleAlert className="size-3.5 shrink-0" />
                      {t('person.settings.bell.mentionWarning')}
                    </span>
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

