'use client'

import { useEffect, useRef, useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { isRemoteConfigured as remoteConfigured } from '@/lib/ohsumi/remote'
import { useToast } from '@/components/ohsumi/toast'
import { Tag, SectionLabel, CapabilityNote, StoredImage } from '@/components/ohsumi/primitives'
import { AdminToc } from '@/components/ohsumi/admin/admin-page'
import { NotifySettingsEditor } from '@/components/ohsumi/admin/admin-tags'
import { Button } from '@/components/ui/button'
import { Building2, ImageUp, Loader2, Mail, MessageSquare, X, Plus, Palette } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { BackupPanel } from './backup-panel'
import { PersonalDataPanel } from './personal-data-panel'
import { UsagePanel } from './usage-panel'
import { MetricsPanel } from './metrics-panel'
import { DiagnosticsPanel } from './diagnostics-panel'
import { checkImageFile } from '@/lib/ohsumi/image-upload'

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target?.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function Section({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-20 rounded-xl border border-border bg-card p-5">
      {children}
    </div>
  )
}

// 団体設定。右上のメニューからも、管理画面の「団体設定」のタブ(embedded)からも開く。上に目次を出す
export function OrgSettingsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const {
    orgName,
    setOrgName,
    orgLogoUrl,
    setOrgLogoUrl,
    themeColor,
    setThemeColor,
    uploadOrgLogo,
    driveEnabled,
    orgNotificationEmails,
    addOrgNotificationEmail,
    removeOrgNotificationEmail,
    refreshWebhookStatus,
    isTopRef,
    currentUser,
    can,
  } = useOhsumi()
  // バックアップ・個人情報の削除・利用の状況・集計値・診断情報は代表だけ(どの設定でも渡さない)
  const isDaihyo = isTopRef(currentUser?.role)
  // 団体名・ロゴの URL・テーマの色・通知先・Webhook は団体のルール(org.rules)、ロゴのアップロードは org.logo
  const canRules = can('org.rules')
  const canLogo = can('org.logo')
  const toast = useToast()
  const { t } = useI18n()

  const [orgNameDraft, setOrgNameDraft] = useState(orgName)
  const [themeColorDraft, setThemeColorDraft] = useState(themeColor)
  const themeColorValid = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(themeColorDraft)
  const [orgEmailDraft, setOrgEmailDraft] = useState('')
  // Discord / Slack の連携状態を取得する(URL そのものは GAS から返らない)
  useEffect(() => {
    if (canRules) void refreshWebhookStatus()
  }, [refreshWebhookStatus, canRules])

  const [uploadingLogo, setUploadingLogo] = useState(false)
  const logoFileRef = useRef<HTMLInputElement>(null)

  const remoteOk = remoteConfigured

  return (
    <div className={embedded ? 'mx-auto max-w-3xl px-6 py-6' : 'mx-auto max-w-2xl px-4 py-8'}>
      {!embedded && (
        <>
          <div className="mb-6 flex items-center gap-2.5">
            <Building2 className="size-5 text-primary" />
            <h1 className="text-xl font-semibold">{t('orgSettings.title')}</h1>
          </div>
          <p className="mb-6 text-sm text-muted-foreground">
            {t('orgSettings.subtitle')}
          </p>
        </>
      )}

      <div className="mb-5">
        <AdminToc
          items={[
            { id: 'org-name-logo', label: t('orgSettings.nameLogo.label') },
            { id: 'org-theme', label: t('orgSettings.themeColor.label') },
            ...(canRules ? [{ id: 'org-email', label: t('orgSettings.email.label') }] : []),
            { id: 'org-notify', label: t('admin.tags.notify.title') },
            ...(canRules ? [{ id: 'org-webhooks', label: t('orgSettings.toc.webhooks') }] : []),
            ...(isDaihyo && remoteOk ? [
              { id: 'org-backup', label: t('orgSettings.toc.backup') },
              { id: 'org-personal-data', label: t('orgSettings.toc.personalData') },
              { id: 'org-usage', label: t('orgSettings.toc.usage') },
              { id: 'org-metrics', label: t('orgSettings.toc.metrics') },
              { id: 'org-diagnostics', label: t('orgSettings.toc.diagnostics') },
            ] : []),
          ]}
        />
      </div>

      <div className="flex flex-col gap-5">
        <Section id="org-name-logo">
          <SectionLabel>{t('orgSettings.nameLogo.label')}</SectionLabel>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('orgSettings.nameLogo.desc')}
          </p>

          <div className="mt-4">
            <label className="block text-xs font-medium text-muted-foreground">{t('orgSettings.nameLogo.nameLabel')}</label>
            <CapabilityNote cap="org.rules" className="mt-1.5" />
            {!canRules && <p className="mt-1.5 text-sm font-medium">{orgName || '—'}</p>}
            {canRules && <div className="mt-1.5 flex gap-2" data-gas-action="updateSetting">
              <input
                value={orgNameDraft}
                onChange={(e) => setOrgNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  if (e.key === 'Enter') { setOrgName(orgNameDraft.trim()); toast(t('orgSettings.nameLogo.savedToast')) }
                }}
                placeholder={t('orgSettings.nameLogo.namePlaceholder')}
                className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
              <Button size="sm" onClick={() => { setOrgName(orgNameDraft.trim()); toast(t('orgSettings.nameLogo.savedToast')) }}>
                {t('orgSettings.nameLogo.save')}
              </Button>
            </div>}
          </div>

          <div className="mt-4">
            <label className="block text-xs font-medium text-muted-foreground">{t('orgSettings.nameLogo.logoLabel')}</label>
            <input
              ref={logoFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                if (!driveEnabled) { toast(t('orgSettings.nameLogo.driveNotConfiguredToast')); return }
                const check = checkImageFile(file)
                if (check !== 'ok') { toast(t(check === 'type' ? 'upload.image.badType' : 'upload.image.tooLarge')); e.target.value = ''; return }
                setUploadingLogo(true)
                try {
                  await uploadOrgLogo(await fileToDataUrl(file), 'org-logo.jpg')
                  toast(t('orgSettings.nameLogo.uploadedToast'))
                } catch {
                  toast(t('orgSettings.nameLogo.uploadFailedToast'))
                } finally {
                  setUploadingLogo(false)
                  e.target.value = ''
                }
              }}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {orgLogoUrl && (
                <StoredImage url={orgLogoUrl} alt={t('orgSettings.nameLogo.altText')} className="h-10 w-10 rounded-md border border-border object-contain" />
              )}
              {canRules && (
                <input
                  value={orgLogoUrl}
                  onChange={(e) => setOrgLogoUrl(e.target.value)}
                  data-gas-action="updateSetting"
                  placeholder={t('orgSettings.nameLogo.urlPlaceholder')}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-xs outline-none focus:border-primary"
                />
              )}
              {driveEnabled && canLogo && (
                <Button size="sm" variant="outline" disabled={uploadingLogo} onClick={() => logoFileRef.current?.click()} className="gap-1.5" data-gas-action="uploadOrgLogo">
                  {uploadingLogo ? <Loader2 className="size-3.5 animate-spin" /> : <ImageUp className="size-3.5" />}
                  {t('orgSettings.nameLogo.upload')}
                </Button>
              )}
              {orgLogoUrl && canRules && (
                <button type="button" onClick={() => setOrgLogoUrl('')} data-gas-action="updateSetting" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive">
                  <X className="size-3.5" />{t('orgSettings.nameLogo.remove')}
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('orgSettings.nameLogo.hint')}
            </p>
            {/* ロゴのアップロードは、できる操作 org.logo の人だけ(既定は代表だけ) */}
            {driveEnabled && <CapabilityNote cap="org.logo" className="mt-1.5" />}
          </div>
        </Section>

        <Section id="org-theme">
          <div className="flex items-center gap-1.5">
            <Palette className="size-4 text-muted-foreground" />
            <SectionLabel>{t('orgSettings.themeColor.label')}</SectionLabel>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('orgSettings.themeColor.desc')}
          </p>
          {!canRules && (
            <p className="mt-3 flex items-center gap-2 text-sm">
              <span className="inline-block size-5 rounded border border-border" style={{ backgroundColor: themeColor || '#2948e8' }} />
              {themeColor || '—'}
            </p>
          )}
          {canRules && <div className="mt-3 flex flex-wrap items-center gap-2" data-gas-action="updateSetting">
            <input
              type="color"
              value={themeColorValid ? themeColorDraft : '#2948e8'}
              onChange={(e) => setThemeColorDraft(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-border bg-background p-0.5"
            />
            <input
              value={themeColorDraft}
              onChange={(e) => setThemeColorDraft(e.target.value)}
              placeholder="#2948e8"
              className="h-9 w-28 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
            />
            <Button
              size="sm"
              disabled={themeColorDraft.trim() !== '' && !themeColorValid}
              onClick={() => { setThemeColor(themeColorDraft.trim()); toast(t('orgSettings.themeColor.savedToast')) }}
            >
              {t('orgSettings.nameLogo.save')}
            </Button>
            {themeColor && (
              <button
                type="button"
                onClick={() => { setThemeColor(''); setThemeColorDraft('') }}
                className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground hover:text-destructive"
              >
                <X className="size-3.5" />{t('orgSettings.themeColor.reset')}
              </button>
            )}
          </div>}
          {canRules && themeColorDraft.trim() !== '' && !themeColorValid && (
            <p className="mt-1.5 text-xs text-destructive">{t('orgSettings.themeColor.invalidHint')}</p>
          )}
          <CapabilityNote cap="org.rules" className="mt-1.5" />
        </Section>

        {canRules && (
          <Section id="org-email">
            <div className="flex items-center gap-1.5">
              <Mail className="size-4 text-muted-foreground" />
              <SectionLabel>{t('orgSettings.email.label')}</SectionLabel>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('orgSettings.email.desc')}
            </p>
            {!remoteOk && (
              <p className="mt-1 text-xs text-warning">{t('orgSettings.remoteWarning')}</p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {orgNotificationEmails.map((email) => (
                <Tag key={email} onRemove={() => removeOrgNotificationEmail(email)}>{email}</Tag>
              ))}
              {orgNotificationEmails.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('orgSettings.email.empty')}</p>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2" data-gas-action="updateSetting">
              <input
                value={orgEmailDraft}
                onChange={(e) => setOrgEmailDraft(e.target.value)}
                placeholder="info@example.com"
                type="email"
                className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
              <Button className="h-9 shrink-0" disabled={!orgEmailDraft.trim()} onClick={() => { addOrgNotificationEmail(orgEmailDraft.trim()); setOrgEmailDraft('') }}>
                <Plus className="size-4" />{t('orgSettings.email.add')}
              </Button>
            </div>
          </Section>
        )}

        {/* 通知の受け取り方(以前は Tags にあった説明) */}
        <div id="org-notify" className="scroll-mt-20">
          <SectionLabel>{t('admin.tags.notify.title')}</SectionLabel>
          <div className="mt-2"><NotifySettingsEditor /></div>
        </div>

        {canRules && (
          <>
            <div id="org-webhooks" className="scroll-mt-20" />
            <WebhookSection kind="discord" remoteOk={remoteOk} placeholder="https://discord.com/api/webhooks/..." />
            <WebhookSection kind="slack" remoteOk={remoteOk} placeholder="https://hooks.slack.com/services/..." />
          </>
        )}

        {isDaihyo && remoteOk && (
          <Section id="org-backup">
            <BackupPanel />
          </Section>
        )}
        {isDaihyo && remoteOk && (
          <Section id="org-personal-data">
            <PersonalDataPanel />
          </Section>
        )}
        {isDaihyo && remoteOk && (
          <Section id="org-usage">
            <UsagePanel />
          </Section>
        )}
        {isDaihyo && remoteOk && (
          <Section id="org-metrics">
            <MetricsPanel />
          </Section>
        )}
        {isDaihyo && remoteOk && (
          <Section id="org-diagnostics">
            <DiagnosticsPanel />
          </Section>
        )}
      </div>
    </div>
  )
}

// Discord / Slack の Webhook 連携。未連携ならURLの入力欄を、連携済みなら
// 「テスト送信」と「連携を解除」を表示する。URLを変更したい場合は、解除して
// から入れ直す(URLは秘密情報のため、保存後は画面に表示しない)。
function WebhookSection({
  kind,
  remoteOk,
  placeholder,
}: {
  kind: 'discord' | 'slack'
  remoteOk: boolean
  placeholder: string
}) {
  const { setDiscordWebhookUrl, setSlackWebhookUrl, webhookStatus, refreshWebhookStatus, testWebhook } = useOhsumi()
  const toast = useToast()
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'unlink' | null>(null)
  const setUrl = kind === 'discord' ? setDiscordWebhookUrl : setSlackWebhookUrl
  const status = webhookStatus?.[kind] ?? null
  const label = kind === 'discord' ? t('orgSettings.discord.label') : t('orgSettings.slack.label')

  // 保存するだけでなく実際にテストメッセージを送って接続確認する
  // (URLの入力ミス等があっても「保存しました」しか出ないと気づけないため)
  const handleSave = async () => {
    const url = draft.trim()
    setBusy('save')
    const result = await setUrl(url)
    await refreshWebhookStatus()
    setBusy(null)
    if (result.ok) {
      setDraft('')
      toast(t(kind === 'discord' ? 'orgSettings.discord.testSuccessToast' : 'orgSettings.slack.testSuccessToast'))
    } else {
      toast(t(kind === 'discord' ? 'orgSettings.discord.testFailToast' : 'orgSettings.slack.testFailToast', { error: result.error ?? '' }))
    }
  }

  const handleTest = async () => {
    setBusy('test')
    const result = await testWebhook(kind)
    setBusy(null)
    toast(result.ok ? t('orgSettings.webhook.testOkToast') : t('orgSettings.webhook.testFailToast', { error: result.error ?? '' }))
  }

  const handleUnlink = async () => {
    if (!window.confirm(t('orgSettings.webhook.unlinkConfirm', { name: label }))) return
    setBusy('unlink')
    const result = await setUrl('')
    await refreshWebhookStatus()
    setBusy(null)
    toast(result.ok ? t('orgSettings.webhook.unlinkedToast') : t('orgSettings.webhook.unlinkFailToast', { error: result.error ?? '' }))
  }

  const formatAt = (iso: string) => {
    const d = new Date(iso)
    return isNaN(d.getTime()) ? iso : d.toLocaleString(locale)
  }

  return (
    <Section>
      <div className="flex items-center gap-1.5">
        <MessageSquare className="size-4 text-muted-foreground" />
        <SectionLabel>{label}</SectionLabel>
        {status && (
          <span
            className={
              status.configured
                ? 'ml-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-400'
                : 'ml-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground'
            }
          >
            {status.configured ? t('orgSettings.webhook.connected') : t('orgSettings.webhook.notConnected')}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(kind === 'discord' ? 'orgSettings.discord.desc' : 'orgSettings.slack.desc')}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{t('orgSettings.discord.urlNote')}</p>
      {!remoteOk && <p className="mt-1 text-xs text-warning">{t('orgSettings.remoteWarning')}</p>}

      {status?.configured ? (
        <>
          <p className="mt-3 text-xs text-muted-foreground">
            {status.lastTest
              ? status.lastTest.ok
                ? t('orgSettings.webhook.lastTestOk', { at: formatAt(status.lastTest.at) })
                : t('orgSettings.webhook.lastTestFail', { at: formatAt(status.lastTest.at), error: status.lastTest.error })
              : t('orgSettings.webhook.noTest')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button className="h-9" disabled={!remoteOk || busy !== null} onClick={handleTest}>
              {busy === 'test' && <Loader2 className="size-3.5 animate-spin" />}
              {busy === 'test' ? t('orgSettings.discord.testingLabel') : t('orgSettings.webhook.testButton')}
            </Button>
            <Button variant="outline" className="h-9" disabled={!remoteOk || busy !== null} onClick={handleUnlink}>
              {busy === 'unlink' && <Loader2 className="size-3.5 animate-spin" />}
              {t('orgSettings.webhook.unlinkButton')}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{t('orgSettings.webhook.changeHint')}</p>
        </>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <Button className="h-9 shrink-0" disabled={!draft.trim() || !remoteOk || busy !== null} onClick={handleSave}>
            {busy === 'save' && <Loader2 className="size-3.5 animate-spin" />}
            {busy === 'save' ? t('orgSettings.discord.testingLabel') : t('orgSettings.nameLogo.save')}
          </Button>
        </div>
      )}
    </Section>
  )
}
