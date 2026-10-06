'use client'

import { useCanOpenOrgSettings } from '@/lib/ohsumi/use-capabilities'
import { useEffect, useRef, useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useNav } from '@/lib/ohsumi/nav'
import { useTheme } from '@/lib/ohsumi/theme'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useTaskDrawer } from '@/lib/ohsumi/task-drawer'
import { Avatar, OhsumiLogo } from './primitives'
import { SegmentedButton, SegmentedControl } from './segmented'
import { OrgSwitcher } from './org-switcher'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  AtSign,
  Bell,
  BookOpen,
  Building2,
  CalendarClock,
  CheckCheck,
  Check,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Clock,
  LogOut,
  MessageSquare,
  Moon,
  RefreshCw,
  Search,
  Sun,
  User,
  X,
  Activity,
  Grid3x3,
  TrendingDown,
  GraduationCap,
  Smartphone,
  Repeat,
} from 'lucide-react'
import { OtherDeviceModal, currentInviteLink } from './other-device'
import { getCurrentOrgId, loadSavedOrgs, switchToOrg } from '@/lib/ohsumi/org-directory'


export function Header() {
  const { isAdminRef,
    currentUser,
    setMode,
    logout,
    notifications,
    notificationHistory,
    markNotificationRead,
    markAllNotificationsRead,
    remoteEnabled,
    refreshing,
    refreshAll,
    visibleTasks: tasks,
    getProject,
    markMentionSeen,
    orgName,
    orgLogoUrl,
    isFullAdmin,
    surveyInvitedIds,
  } = useOhsumi()
  const canAccessSurvey =
    surveyInvitedIds.length === 0 ||
    isFullAdmin ||
    (!!currentUser && surveyInvitedIds.includes(currentUser.id))
  const { screen, go, goBack, canGoBack } = useNav()
  const { theme, toggle } = useTheme()
  const canOpenOrgSettings = useCanOpenOrgSettings()
  const { t } = useI18n()
  const { openTask } = useTaskDrawer()
  const [menuOpen, setMenuOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  // 通知の一覧: 未読(今の通知のうち読んでいないもの)・すべて(履歴。既読・対応済みを含む)
  const [notifTab, setNotifTab] = useState<'unread' | 'all'>('unread')
  const [otherDeviceOpen, setOtherDeviceOpen] = useState(false)
  const [query, setQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)

  // 通知を開く: 既読にして、開く先(承認の一覧・メンバー・タスク)へ移る
  const openNotification = (n: { id: string; kind: string; taskId: string; commentId?: string; memberId?: string }) => {
    setNotifOpen(false)
    markNotificationRead(n.id)
    if (n.kind === 'mention' && n.commentId) markMentionSeen(n.commentId)
    if (n.kind === 'approval') {
      go({ name: 'admin', section: 'approvals' })
      return
    }
    if (n.memberId) {
      go({ name: 'person', id: n.memberId })
      return
    }
    if (n.taskId) openTask(n.taskId)
  }

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  if (!currentUser) return null

  const handleMode = (m: 'input' | 'output') => {
    setMode(m)
    go({ name: m })
  }

  // item 19: 組織ナレッジ横断検索 — searches task names/descriptions/
  // progress notes/comments/deliverables/振り返り for a query, so past
  // decisions and know-how surface even if you don't remember which task
  // they're on. Matches within visibleTasks only (same visibility rules
  // as everywhere else).
  const searchResults = (() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return tasks
      .map((t) => {
        let snippet: string | null = null
        if (t.name.toLowerCase().includes(q)) snippet = t.name
        else if (t.description?.toLowerCase().includes(q)) snippet = t.description
        else if (t.progress?.toLowerCase().includes(q)) snippet = t.progress
        else {
          const comment = t.comments?.find((c) => c.text.toLowerCase().includes(q))
          if (comment) snippet = comment.text
          else {
            // KNO-004: 成果物のラベルだけでなくURLにもマッチしたら検索結果に含める。
            // snippetにはラベルを出す(URLそのものより人間が読みやすいため)
            const deliverable = t.deliverables?.find(
              (d) => d.label.toLowerCase().includes(q) || d.url.toLowerCase().includes(q),
            )
            if (deliverable) snippet = deliverable.label
            else if (t.retrospective) {
              const r = t.retrospective
              if (r.good?.toLowerCase().includes(q)) snippet = r.good
              else if (r.bad?.toLowerCase().includes(q)) snippet = r.bad
              else if (r.improve?.toLowerCase().includes(q)) snippet = r.improve
            }
          }
        }
        return snippet ? { task: t, snippet } : null
      })
      .filter((r): r is { task: (typeof tasks)[number]; snippet: string } => r !== null)
      .slice(0, 8)
  })()

  const isInputActive = screen.name === 'input'
  const isOutputActive =
    screen.name === 'output' ||
    screen.name === 'person' ||
    screen.name === 'project'
  const isAdminActive = screen.name === 'admin'
  const isAdmin = isAdminRef(currentUser.role)

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto grid h-14 max-w-[1400px] grid-cols-[auto_1fr_auto] items-center gap-2 px-4 sm:grid-cols-[1fr_auto_1fr] sm:gap-4 sm:px-6">
        {/* left */}
        <div className="flex min-w-0 items-center gap-1">
          {canGoBack && (
            <button
              type="button"
              onClick={goBack}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={t('header.back.aria')}
              title={t('header.back')}
            >
              <ArrowLeft className="size-[18px]" />
            </button>
          )}
          <button
            type="button"
            onClick={() => handleMode('output')}
            className="flex shrink-0 items-center rounded-md p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('header.home.aria')}
            title={t('header.home.aria')}
          >
            <OhsumiLogo size={22} text="sm" />
          </button>
          <OrgSwitcher orgName={orgName} orgLogoUrl={orgLogoUrl} />
        </div>

        {/* center: mode switch */}
        <div className="flex min-w-0 items-center justify-center">
          <SegmentedControl ariaLabel={t('header.mode.aria')}>
            <ModeButton
              active={isInputActive}
              onClick={() => handleMode('input')}
              sub={t('header.mode.input')}
            >
              INPUT
            </ModeButton>
            <ModeButton
              active={isOutputActive}
              onClick={() => handleMode('output')}
              sub={t('header.mode.output')}
            >
              OUTPUT
            </ModeButton>
            {isAdmin && (
              <ModeButton
                active={isAdminActive}
                onClick={() => go({ name: 'admin', section: 'dashboard' })}
                sub={t('header.mode.admin')}
              >
                ADMIN
              </ModeButton>
            )}
          </SegmentedControl>
        </div>

        {/* right */}
        <div className="flex min-w-0 items-center justify-end gap-1">
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setNotifOpen((o) => !o)}
              className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={t('header.notifications')}
              aria-expanded={notifOpen}
            >
              <Bell className="size-[18px]" />
              {notifications.length > 0 && (
                <span className="absolute right-1.5 top-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                  {notifications.length > 9 ? '9+' : notifications.length}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-lg animate-in fade-in slide-in-from-top-1">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="text-sm font-semibold">{t('header.notifications')}</span>
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={markAllNotificationsRead}
                      className="shrink-0 text-xs text-primary hover:underline"
                    >
                      {t('header.notifications.markAllRead')}
                    </button>
                  )}
                </div>
                <div className="flex border-b border-border text-xs" role="tablist">
                  {(['unread', 'all'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={notifTab === tab}
                      onClick={() => setNotifTab(tab)}
                      className={cn(
                        'flex-1 px-3 py-1.5 font-medium transition-colors',
                        notifTab === tab ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(tab === 'unread' ? 'header.notifications.tab.unread' : 'header.notifications.tab.all')}
                      {tab === 'unread' && notifications.length > 0 ? ` (${notifications.length})` : ''}
                    </button>
                  ))}
                </div>
                <div className="max-h-96 overflow-y-auto ohsumi-scroll">
                  {notifTab === 'unread' && notifications.length === 0 && (
                    <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                      <CheckCheck className="size-4" />
                      {t('header.notifications.empty')}
                    </div>
                  )}
                  {notifTab === 'unread' && notifications.map((n) => (
                    <div
                      key={n.id}
                      className="flex items-start border-b border-border last:border-0"
                    >
                      <button
                        onClick={() => openNotification(n)}
                        className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-secondary"
                      >
                        <NotificationIcon kind={n.kind} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{n.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{n.detail}</p>
                        </div>
                      </button>
                      <button
                        onClick={() => markNotificationRead(n.id)}
                        className="flex size-8 shrink-0 items-center justify-center self-center text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={t('header.notifications.markRead')}
                        title={t('header.notifications.markRead')}
                      >
                        <Check className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  {notifTab === 'all' && notificationHistory.length === 0 && (
                    <div className="px-3 py-6 text-sm text-muted-foreground">{t('header.notifications.historyEmpty')}</div>
                  )}
                  {notifTab === 'all' && notificationHistory.map((r) => {
                    const state = r.resolvedAt ? 'resolved' : r.readAt ? 'read' : 'unread'
                    return (
                      <button
                        key={r.id}
                        onClick={() => openNotification(r)}
                        className={cn(
                          'flex w-full min-w-0 items-start gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-secondary',
                          state !== 'unread' && 'opacity-70',
                        )}
                      >
                        <NotificationIcon kind={r.kind} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{r.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                            <span
                              className={cn(
                                'rounded px-1.5 py-px font-medium',
                                state === 'unread' ? 'bg-primary/10 text-primary' : 'bg-secondary',
                              )}
                            >
                              {t(`header.notifications.state.${state}`)}
                            </span>
                            <span className="tabular-nums">{formatNotifiedAt(r.at)}</span>
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {remoteEnabled && (
            <button
              type="button"
              onClick={refreshAll}
              disabled={refreshing}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60"
              aria-label={t('header.refresh')}
              title={t('header.refresh')}
            >
              <RefreshCw className={cn('size-[18px]', refreshing && 'animate-spin')} />
            </button>
          )}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 transition-colors hover:bg-secondary"
              aria-expanded={menuOpen}
              data-account-menu
            >
              <Avatar member={currentUser} size={28} />
              <span className="hidden text-sm font-medium sm:inline">
                {currentUser.displayName || currentUser.name}
              </span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg animate-in fade-in slide-in-from-top-1">
                {/* Search */}
                <div className="px-1 pb-1">
                  <div className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1.5">
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                      value={query}
                      data-read-only-ok
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t('header.search.placeholder')}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                    {query && (
                      <button onClick={() => setQuery('')} aria-label={t('header.search.clear')}>
                        <X className="size-3.5 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                  {query.trim() && (
                    <div className="mt-1 max-h-56 overflow-y-auto ohsumi-scroll rounded-lg">
                      {searchResults.length === 0 ? (
                        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                          {t('header.search.empty')}
                        </div>
                      ) : (
                        searchResults.map(({ task: t, snippet }) => (
                          <button
                            key={t.id}
                            onClick={() => {
                              setMenuOpen(false)
                              setQuery('')
                              openTask(t.id)
                            }}
                            className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-secondary"
                          >
                            <span className="flex items-center gap-1.5 text-sm font-medium">
                              {t.name}
                              <span className="text-xs font-normal text-muted-foreground">
                                {getProject(t.projectId)?.name}
                              </span>
                            </span>
                            {snippet !== t.name && (
                              <span className="line-clamp-1 text-xs text-muted-foreground">{snippet}</span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <div className="my-1 h-px bg-border" />
                {/* User info */}
                <div className="flex items-center gap-2.5 px-2.5 py-2">
                  <Avatar member={currentUser} size={34} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {currentUser.displayName || currentUser.name}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {currentUser.affiliation}
                    </div>
                  </div>
                </div>
                <div className="my-1 h-px bg-border" />
                {/* Theme toggle */}
                <MenuItem onClick={toggle}>
                  {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  {theme === 'dark' ? t('header.theme.light') : t('header.theme.dark')}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    go({ name: 'person', id: currentUser.id })
                  }}
                >
                  <User className="size-4" />
                  {t('header.menu.profile')}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    go({ name: 'activity' })
                  }}
                >
                  <Activity className="size-4" />
                  {t('header.menu.activity')}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    go({ name: 'dailyreport' })
                  }}
                >
                  <BookOpen className="size-4" />
                  {t('header.menu.dailyreport')}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    go({ name: 'skillgrid' })
                  }}
                >
                  <Grid3x3 className="size-4" />
                  {t('header.menu.skillGrid')}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    go({ name: 'learning' })
                  }}
                >
                  <GraduationCap className="size-4" />
                  {t('header.menu.learning')}
                </MenuItem>
                {canAccessSurvey && (
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false)
                      go({ name: 'survey' })
                    }}
                  >
                    <ClipboardList className="size-4" />
                    {t('header.menu.survey')}
                  </MenuItem>
                )}
                {canOpenOrgSettings && (
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false)
                      go({ name: 'org-settings' })
                    }}
                  >
                    <Building2 className="size-4" />
                    {t('header.menu.orgSettings')}
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    go({ name: 'feedback' })
                  }}
                >
                  <MessageSquare className="size-4" />
                  {t('header.menu.feedback')}
                </MenuItem>
                {currentInviteLink() && (
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false)
                      setOtherDeviceOpen(true)
                    }}
                  >
                    <Smartphone className="size-4" />
                    {t('header.menu.otherDevice')}
                  </MenuItem>
                )}
                {/* 団体の切り替え: この端末に保存したほかの団体へ移る(団体ごとのログインはそのまま)。読み込み直す */}
                {(() => {
                  const current = getCurrentOrgId()
                  const others = loadSavedOrgs().filter((o) => o.orgId !== current)
                  if (others.length === 0) return null
                  return (
                    <>
                      <div className="my-1 h-px bg-border" />
                      <div className="px-3 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{t('header.menu.switchOrg')}</div>
                      {others.map((o) => (
                        <MenuItem
                          key={o.orgId}
                          onClick={() => {
                            setMenuOpen(false)
                            switchToOrg(o.orgId)
                          }}
                        >
                          <Repeat className="size-4" />
                          <span className="truncate" data-switch-org={o.orgId}>{o.name || o.orgId}</span>
                        </MenuItem>
                      ))}
                    </>
                  )
                })()}
                <div className="my-1 h-px bg-border" />
                <MenuItem onClick={logout}>
                  <LogOut className="size-4" />
                  {t('header.menu.logout')}
                </MenuItem>
              </div>
            )}
          </div>
        </div>
      </div>
      <OtherDeviceModal open={otherDeviceOpen} onClose={() => setOtherDeviceOpen(false)} />
    </header>
  )
}

function ModeButton({
  active,
  onClick,
  children,
  sub,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  sub: string
}) {
  return (
    <SegmentedButton active={active} onClick={onClick} className="flex-col gap-0 px-3 py-1 sm:min-w-[204px] sm:px-4">
      <span className="text-[13px] tracking-wide">{children}</span>
      <span className="hidden text-[10px] font-normal leading-none sm:block">{sub}</span>
    </SegmentedButton>
  )
}

function MenuItem({
  children,
  onClick,
  highlight,
}: {
  children: React.ReactNode
  onClick?: () => void
  highlight?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-secondary',
        highlight ? 'font-medium text-accent-foreground' : 'text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function NotificationIcon({ kind }: { kind: string }) {
  if (kind === 'deadline') return <CalendarClock className="mt-0.5 size-4 shrink-0 text-warning" />
  if (kind === 'stale') return <Clock className="mt-0.5 size-4 shrink-0 text-warning" />
  if (kind === 'mention') return <AtSign className="mt-0.5 size-4 shrink-0 text-primary" />
  if (kind === 'lowWorkload') return <TrendingDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  return <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-primary" />
}

// 履歴の時刻(この端末の時刻で「10/05 14:30」)
function formatNotifiedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
