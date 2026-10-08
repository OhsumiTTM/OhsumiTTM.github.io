'use client'

// ホームの「この団体 / すべての団体」(兼部の統合表示。lib/ohsumi/multi-org.ts)。
// この端末に団体が2つ以上ある時だけ、切り替えを出す(兼部していない人には出さない)。
// 「すべての団体」は、団体ごとの getMyDigest(本人の分だけ)を、この画面のメモリの中でだけまとめて出す
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CalendarClock, Inbox, Loader2, LogIn, RefreshCw, TriangleAlert, UserCheck } from 'lucide-react'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { useTaskDrawer } from '@/lib/ohsumi/task-drawer'
import { useOhsumi } from '@/lib/ohsumi/store'
import { getActiveOrg, switchToOrg } from '@/lib/ohsumi/org-directory'
import {
  combineDigests,
  digestOrgs,
  fetchAllDigests,
  fetchOrgDigest,
  hasMultipleOrgs,
  localDate,
  parseReloginMessage,
  rememberTaskToOpen,
  reloginUrl,
  shortOrgName,
  takeTaskToOpen,
  type CombinedTask,
  type DigestOrg,
  type OrgDigestState,
} from '@/lib/ohsumi/multi-org'
import { storeSessionFor } from '@/lib/ohsumi/session'
import { SegmentedButton, SegmentedControl } from '../segmented'
import { OutputScreen } from './output-screen'

type Scope = 'org' | 'all'
const SCOPE_KEY = 'ohsumi-home-scope'

function loadScope(): Scope {
  try { return window.localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'org' } catch { return 'org' }
}

function saveScope(scope: Scope) {
  try { window.localStorage.setItem(SCOPE_KEY, scope) } catch { /* このページの間だけ */ }
}

/** ホーム(OUTPUT)。兼部している時だけ、上に「この団体 / すべての団体」を出す */
export function OutputHome() {
  const { t } = useI18n()
  const { dataReady } = useOhsumi()
  const { openTask } = useTaskDrawer()
  const [multi] = useState(hasMultipleOrgs)
  const [scope, setScopeState] = useState<Scope>(() => (hasMultipleOrgs() ? loadScope() : 'org'))
  const setScope = (s: Scope) => {
    setScopeState(s)
    saveScope(s)
  }

  // ほかの団体の統合表示から切り替えてきた時は、そのタスクを開く
  useEffect(() => {
    if (!dataReady) return
    const id = takeTaskToOpen(getActiveOrg().orgId)
    if (id) openTask(id)
  }, [dataReady, openTask])

  if (!multi) return <OutputScreen />
  return (
    <>
      <div className="mx-auto w-full max-w-[1360px] px-4 pt-4 sm:px-6 lg:px-8" data-home-scope={scope}>
        <SegmentedControl ariaLabel={t('multiOrg.scope.label')}>
          <SegmentedButton active={scope === 'org'} onClick={() => setScope('org')}>{t('multiOrg.scope.org')}</SegmentedButton>
          <SegmentedButton active={scope === 'all'} onClick={() => setScope('all')}>{t('multiOrg.scope.all')}</SegmentedButton>
        </SegmentedControl>
      </div>
      {scope === 'all' ? <AllOrgsView onOpenCurrent={(id) => { setScope('org'); openTask(id) }} onLeave={() => setScope('org')} /> : <OutputScreen />}
    </>
  )
}

const STATE_TEXT: Record<Exclude<OrgDigestState['kind'], 'ok'>, TranslationKey> = {
  loading: 'multiOrg.state.loading',
  loginNeeded: 'multiOrg.state.loginNeeded',
  suspended: 'multiOrg.state.suspended',
  oldGas: 'multiOrg.state.oldGas',
  error: 'multiOrg.state.error',
}

function AllOrgsView({ onOpenCurrent, onLeave }: { onOpenCurrent: (taskId: string) => void; onLeave: () => void }) {
  const { t } = useI18n()
  const [orgs] = useState<DigestOrg[]>(digestOrgs)
  const [states, setStates] = useState<Record<string, OrgDigestState>>({})
  const [loading, setLoading] = useState(false)
  const today = localDate(new Date())

  const loadAll = useCallback(() => {
    setLoading(true)
    setStates(Object.fromEntries(orgs.map((o) => [o.orgId, { kind: 'loading' } as OrgDigestState])))
    void fetchAllDigests(orgs, (orgId, state) => setStates((prev) => ({ ...prev, [orgId]: state }))).finally(() => setLoading(false))
  }, [orgs])

  useEffect(() => { loadAll() }, [loadAll])

  // 開いた「ログインし直す」窓(この窓から来たメッセージだけを受け取る)
  const popupRef = useRef<Window | null>(null)

  // ログインし直す窓から、セッションを受け取る(同じオリジン・この画面が開いた窓・この端末の団体だけ)。その団体だけ読み直す
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!popupRef.current || e.source !== popupRef.current) return
      const msg = parseReloginMessage(e, window.location.origin)
      if (!msg) return
      storeSessionFor(msg.orgId, msg.session)
      const org = orgs.find((o) => o.orgId === msg.orgId)
      if (!org) return
      setStates((prev) => ({ ...prev, [org.orgId]: { kind: 'loading' } }))
      void fetchOrgDigest(org).then((state) => setStates((prev) => ({ ...prev, [org.orgId]: state })))
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [orgs])

  const combined = useMemo(() => combineDigests(orgs, states, today), [orgs, states, today])

  // ボタンを押した時に、そのまま(await を挟まずに)窓を開く。スマートフォンの Safari は、押した操作の中で
  // 開いた窓だけを許す(非同期の後に開くと止められる)
  const relogin = (org: DigestOrg) => {
    const w = window.open(reloginUrl(org.orgId), 'ohsumi-relogin', 'popup,width=480,height=640')
    // 小さい窓を開けない(止められた)時は、その団体に切り替えてログインする
    if (!w) {
      switchToOrg(org.orgId)
      return
    }
    popupRef.current = w
  }

  const open = (task: CombinedTask) => {
    const org = orgs.find((o) => o.orgId === task.orgId)
    if (org?.current) {
      onOpenCurrent(task.id)
      return
    }
    rememberTaskToOpen(task.orgId, task.id)
    onLeave()
    switchToOrg(task.orgId)
  }

  const sections: { key: string; title: TranslationKey; icon: typeof AlertCircle; tasks: CombinedTask[] }[] = [
    { key: 'today', title: 'multiOrg.section.today', icon: AlertCircle, tasks: combined.today },
    { key: 'review', title: 'multiOrg.section.review', icon: UserCheck, tasks: combined.review },
    { key: 'unanswered', title: 'multiOrg.section.unanswered', icon: Inbox, tasks: combined.unanswered },
    { key: 'week', title: 'multiOrg.section.week', icon: CalendarClock, tasks: combined.week },
  ]

  return (
    <div className="mx-auto w-full max-w-[1360px] px-4 py-6 sm:px-6 lg:px-8" data-all-orgs>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t('multiOrg.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('multiOrg.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={loadAll}
          disabled={loading}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {t('multiOrg.reload')}
        </button>
      </div>

      <section className="mb-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('multiOrg.section.orgs')}>
        {combined.perOrg.map((o) => {
          const org = orgs.find((x) => x.orgId === o.orgId)!
          return (
            <div key={o.orgId} className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-border bg-card" data-org-card={o.orgId} data-org-state={o.state}>
              <span className="w-1.5 shrink-0" style={{ background: o.themeColor || 'var(--primary)' }} aria-hidden />
              <div className="min-w-0 flex-1 px-3 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{o.orgName || t('login.orgUnnamed', { id: o.orgId.slice(4, 10) })}</span>
                  {org.current && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t('multiOrg.current')}</span>}
                </div>
                {o.counts ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('multiOrg.counts', { assigned: o.counts.assigned, overdue: o.counts.overdue, review: o.counts.reviewWaiting, unanswered: o.counts.unanswered })}
                  </p>
                ) : (
                  <p className={'mt-0.5 flex items-center gap-1 text-xs ' + (o.state === 'loading' ? 'text-muted-foreground' : 'text-warning')}>
                    {o.state === 'loading' ? <Loader2 className="size-3 animate-spin" /> : <TriangleAlert className="size-3 shrink-0" />}
                    {t(STATE_TEXT[o.state as Exclude<OrgDigestState['kind'], 'ok'>])}
                  </p>
                )}
                {o.state === 'loginNeeded' && (
                  <button
                    type="button"
                    onClick={() => relogin(org)}
                    className="mt-1.5 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-secondary"
                    data-relogin-org={o.orgId}
                  >
                    <LogIn className="size-3.5" />
                    {t('multiOrg.relogin.button')}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((s) => (
          <section key={s.key} className="min-w-0 rounded-xl border border-border bg-card p-3" data-all-orgs-section={s.key}>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
              <s.icon className="size-4 text-muted-foreground" />
              {t(s.title)}
              <span className="text-xs font-normal text-muted-foreground">{s.tasks.length}</span>
            </h2>
            {s.tasks.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">{t('multiOrg.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {s.tasks.map((task) => (
                  <li key={task.orgId + ':' + task.id}>
                    <button
                      type="button"
                      onClick={() => open(task)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                      data-all-orgs-task={task.id}
                    >
                      <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-muted-foreground" title={task.orgName} data-org-badge>
                        <span className="h-4 w-1 rounded-full" style={{ background: task.themeColor || 'var(--primary)' }} aria-hidden />
                        {shortOrgName(task.orgName) || '—'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{task.title}</span>
                        {task.projectName && <span className="block truncate text-[11px] text-muted-foreground">{task.projectName}</span>}
                        {task.role === 'invitee' && task.candidates && task.candidates.length > 0 && (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {t('multiOrg.candidates', { list: task.candidates.slice(0, 3).map((c) => c.label || c.date).join('・') })}
                          </span>
                        )}
                      </span>
                      <span className={'shrink-0 text-xs ' + (task.overdue ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
                        {task.role === 'invitee'
                          ? t(task.inviteKind === 'form' ? 'multiOrg.invite.form' : 'multiOrg.invite.schedule')
                          : task.dueDate
                            ? task.dueDate.slice(5).replace('-', '/') + (task.overdue ? ' ' + t('multiOrg.overdue') : '')
                            : s.key === 'week' && task.startDate ? t('multiOrg.starts', { date: task.startDate.slice(5).replace('-', '/') }) : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t('multiOrg.privacyNote')}</p>
    </div>
  )
}
