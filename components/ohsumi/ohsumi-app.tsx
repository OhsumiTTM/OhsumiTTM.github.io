'use client'

import { useEffect } from 'react'
import { OhsumiProvider, useOhsumi } from '@/lib/ohsumi/store'
import { NavProvider, useNav } from '@/lib/ohsumi/nav'
import { ThemeProvider } from '@/lib/ohsumi/theme'
import { I18nProvider, useI18n, SUPPORTED_LOCALES } from '@/lib/ohsumi/i18n'
import { TaskDrawerProvider, useTaskDrawer } from '@/lib/ohsumi/task-drawer'
import { ContractBanner } from './contract-banner'
import { ReadOnlyInputs, ReadOnlyNotice, SessionExpiryBanner } from './read-only-guard'
import { LONG_RECORDS_EVENT, NOTIFY_LIMITED_EVENT, isRemoteConfigured, remoteApi } from '@/lib/ohsumi/remote'
import { installClientErrorReporter } from '@/lib/ohsumi/error-report'
import type { LongRecordWritten } from '@/lib/ohsumi/gas-transport'
import { cellFieldLabel } from '@/lib/ohsumi/cell-limits'
import { ToastProvider, useToast } from './toast'
import { LoginScreen } from './login-screen'
import { OnboardingScreen } from './onboarding-screen'
import { Header } from './header'
import { InputScreen } from './input/input-screen'
import { OutputHome } from './output/all-orgs-view'
import { PersonDetail } from './people/person-detail'
import { PersonalSettingsScreen } from './people/personal-settings'
import { ProjectDetail } from './projects/project-detail'
import { AdminScreen } from './admin/admin-screen'
import { FeedbackScreen } from './feedback-screen'
import { ActivityScreen } from './activity-screen'
import { DailyReportScreen } from './daily-report-screen'
import { SurveyScreen } from './survey-screen'
import { OrgSettingsScreen } from './org-settings-screen'
import { SkillGridScreen } from './skill-grid-screen'
import { LearningContentScreen } from './learning-content-screen'
import { TaskDetailDrawer } from './output/task-detail-drawer'
import { OhsumiMark } from './primitives'
import { themeColorCss } from '@/lib/ohsumi/theme-color'
import { TriangleAlert } from 'lucide-react'
import { LegalLinks } from './legal-links'

// shown while a persisted session (currentUserId from localStorage) is
// waiting on the spreadsheet fetch to resolve who that is
function RemoteLoadingScreen() {
  const { t } = useI18n()
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <OhsumiMark size={30} />
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <span className="relative flex size-3">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40" />
          <span className="relative inline-flex size-3 rounded-full bg-primary" />
        </span>
        {t('app.loading')}
      </div>
    </main>
  )
}

// shown when that same fetch has failed outright (even after the automatic
// retries in gas-transport.ts), instead of silently falling back to the login
// screen (which would look like a sign-out)
function RemoteLoadErrorScreen({ message }: { message: string | null }) {
  const { t } = useI18n()
  const { retryLoad, logout } = useOhsumi()
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
      <OhsumiMark size={30} />
      <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
        <TriangleAlert className="size-4 shrink-0" />
        {t('app.loadFailed')}
      </div>
      {message && <p className="max-w-sm text-xs text-muted-foreground">{message}</p>}
      <button
        type="button"
        onClick={retryLoad}
        className="mt-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary"
      >
        {t('app.retryLoad')}
      </button>
      <button type="button" onClick={logout} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
        {t('header.menu.logout')}
      </button>
    </main>
  )
}

// 通知の回数の上限を超えて、GAS が一部の通知を送らなかった時に知らせる(操作そのものは済んでいる)
function NotifyLimitedWatcher() {
  const toast = useToast()
  const { t } = useI18n()
  useEffect(() => {
    const on = () => toast(t('app.notifyLimited'))
    window.addEventListener(NOTIFY_LIMITED_EVENT, on)
    return () => window.removeEventListener(NOTIFY_LIMITED_EVENT, on)
  }, [toast, t])
  return null
}

// 画面のエラーを、団体のエラーの記録に送る(種類と操作の名前だけ。lib/ohsumi/error-report.ts)
function ClientErrorReporter() {
  useEffect(() => (isRemoteConfigured ? installClientErrorReporter(remoteApi.reportClientError) : undefined), [])
  return null
}

// 1つの記録が上限(5万文字)の8割を超えた時に、書いた人に知らせる(保存は済んでいる。代表にはまとめのメールで知らせる)
function LongRecordsWatcher() {
  const toast = useToast()
  const { t } = useI18n()
  useEffect(() => {
    const on = (e: Event) => {
      const records = (e as CustomEvent<LongRecordWritten[]>).detail ?? []
      records.forEach((r) => toast(t('app.longRecordWritten', {
        name: r.name || r.id, field: cellFieldLabel(r.field, t), length: r.length.toLocaleString(), max: r.max.toLocaleString(),
      })))
    }
    window.addEventListener(LONG_RECORDS_EVENT, on)
    return () => window.removeEventListener(LONG_RECORDS_EVENT, on)
  }, [toast, t])
  return null
}

// ログイン画面にも、保存できなかった文章の知らせ(ログインが切れた・提供停止で読み込み直した時)を出す
function LoginWithNotice() {
  return (
    <>
      <LoginScreen />
      <ReadOnlyNotice />
    </>
  )
}

// lives inside ToastProvider so it can surface store-level events that
// don't have a specific screen to render into (skill auto-certification)
function SkillCertifiedWatcher() {
  const { skillCertifiedEvent, clearSkillCertifiedEvent } = useOhsumi()
  const toast = useToast()
  const { t } = useI18n()

  useEffect(() => {
    if (!skillCertifiedEvent) return
    toast(t('app.skillCertifiedToast', { name: skillCertifiedEvent.memberName, skill: skillCertifiedEvent.skill }))
    clearSkillCertifiedEvent()
  }, [skillCertifiedEvent, clearSkillCertifiedEvent, toast, t])

  return null
}

// 団体設定（org-settings-screen.tsx）で選んだテーマの色を、--primary・--primary-foreground に反映する。
// 明るい表示はそのままの色、暗い表示は暗い背景の上で読める明るさにした色(lib/ohsumi/theme-color.ts)。
// <html> に直接書くと .dark の色より強くなってしまうので、表示ごとの規則を <style> で入れる。未設定なら何もしない
const THEME_COLOR_STYLE_ID = 'ohsumi-theme-color'
function ThemeColorWatcher() {
  const { themeColor } = useOhsumi()

  useEffect(() => {
    const css = themeColorCss(themeColor)
    let el = document.getElementById(THEME_COLOR_STYLE_ID)
    if (!css) {
      el?.remove()
      return
    }
    if (!el) {
      el = document.createElement('style')
      el.id = THEME_COLOR_STYLE_ID
      document.head.appendChild(el)
    }
    el.textContent = css
  }, [themeColor])

  return null
}

// currentUser.locale（スプレッドシート保存済みの言語設定）が分かった時点で
// I18nの表示言語に反映する。ブラウザのlocalStorage（ログイン前のデフォルト、
// 未ログイン状態でも機能する）より、ログイン後はこちらを優先する。
// 本人が言語を変更した場合は setMemberLocale が両方を更新するので
// ここでの上書きとは競合しない。
function LocaleSyncWatcher() {
  const { currentUser } = useOhsumi()
  const { locale, setLocale } = useI18n()

  useEffect(() => {
    const saved = currentUser?.locale
    if (!saved || saved === locale) return
    if (!SUPPORTED_LOCALES.some((l) => l.code === saved)) return
    setLocale(saved as (typeof SUPPORTED_LOCALES)[number]['code'])
  }, [currentUser?.locale, locale, setLocale])

  return null
}

function Router() {
  const { currentUser, currentUserId, needsOnboarding, remoteEnabled, remoteStatus, remoteError, remoteReverted, remoteRestricted, loadError, retryLoad, refreshing, dataReady, sessionResuming, metricsSharingNotice } =
    useOhsumi()
  const { screen } = useNav()
  const { openTaskId, closeTask } = useTaskDrawer()
  const { t } = useI18n()

  if (!currentUser) {
    // currentUserId persists across reloads (localStorage), but resolving
    // it to a real member depends on the spreadsheet fetch. Without this
    // check, the gap between mount and fetch completion would show the
    // login screen even though the person is (or was) logged in — looking
    // like they got signed out, and worse, letting Admin screens briefly
    // compute permissions against no/stale data (see admin-screen.tsx).
    // この端末に保存したセッションで、自動的にログインし直している途中
    if (remoteEnabled && sessionResuming) return <RemoteLoadingScreen />
    // 保存したセッションでの再開が、再試行しても失敗した(セッションは残っている)。
    // ログイン画面に戻すとログアウトしたように見えるので、「もう一度試す」を出す
    if (remoteEnabled && remoteStatus === 'error') return <RemoteLoadErrorScreen message={loadError} />
    if (remoteEnabled && currentUserId) {
      // 保存したセッションが無い場合はログイン画面に戻る
      if (remoteStatus === 'idle') return <LoginWithNotice />
      if (!dataReady) return <RemoteLoadingScreen />
    }
    return <LoginWithNotice />
  }
  if (needsOnboarding) return <OnboardingScreen />

  return (
    <div className="min-h-screen bg-background">
      {remoteEnabled && remoteError && (
        <div className="flex items-center justify-center gap-1.5 bg-warning-muted px-4 py-1.5 text-center text-xs font-medium text-warning">
          <TriangleAlert className="size-3.5 shrink-0" />
          {t(remoteRestricted ? 'app.restrictedWriteBanner' : remoteReverted ? 'app.saveRevertedBanner' : 'app.syncFailedBanner')}
        </div>
      )}
      {remoteEnabled && <ContractBanner />}
      {remoteEnabled && <SessionExpiryBanner />}
      <ReadOnlyInputs />
      <ReadOnlyNotice />
      {remoteEnabled && loadError && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-warning-muted px-4 py-1.5 text-center text-xs font-medium text-warning">
          <span className="flex items-center gap-1.5">
            <TriangleAlert className="size-3.5 shrink-0" />
            {t('app.loadFailedBanner')}
          </span>
          <button
            type="button"
            onClick={retryLoad}
            disabled={refreshing}
            className="shrink-0 whitespace-nowrap rounded-md border border-warning/40 bg-card px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
          >
            {t('app.retryLoad')}
          </button>
        </div>
      )}
      <Header />
      <div key={JSON.stringify(screen)} className="animate-in fade-in duration-200">
        {screen.name === 'input' && <InputScreen />}
        {screen.name === 'output' && <OutputHome />}
        {screen.name === 'person' && <PersonDetail key={screen.id} id={screen.id} />}
        {screen.name === 'personal-settings' && <PersonalSettingsScreen />}
        {screen.name === 'project' && <ProjectDetail id={screen.id} />}
        {screen.name === 'admin' && <AdminScreen section={screen.section} />}
        {screen.name === 'feedback' && <FeedbackScreen />}
        {screen.name === 'activity' && <ActivityScreen />}
        {screen.name === 'dailyreport' && <DailyReportScreen />}
        {screen.name === 'survey' && <SurveyScreen />}
        {screen.name === 'org-settings' && <OrgSettingsScreen />}
        {screen.name === 'skillgrid' && <SkillGridScreen />}
        {screen.name === 'learning' && <LearningContentScreen />}
      </div>
      <footer className="border-t border-border px-4 py-4">
        {metricsSharingNotice && (
          <p className="mb-2 text-center text-xs break-words text-muted-foreground" data-metrics-notice>{t('metrics.memberNotice')}</p>
        )}
        <LegalLinks />
      </footer>
      <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />
    </div>
  )
}

export function OhsumiApp() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <OhsumiProvider>
          <ToastProvider>
            <SkillCertifiedWatcher />
            <NotifyLimitedWatcher />
            <LongRecordsWatcher />
            <ClientErrorReporter />
            <LocaleSyncWatcher />
            <ThemeColorWatcher />
            <NavProvider>
              <TaskDrawerProvider>
                <Router />
              </TaskDrawerProvider>
            </NavProvider>
          </ToastProvider>
        </OhsumiProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
