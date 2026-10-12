'use client'

// 承認の履歴(管理画面「承認待ち」の下)。今の記録から集めて、新しい順に並べる。
//   - タスクの登録の承認・却下: 団体の GAS の承認の記録(getApprovalLog。gas/src/41-approval-log.gs)。古い GAS では出せない
//   - タスクの確認: 確認者の承認(reviewApprovals)と、差し戻し(変更の記録の「確認待ち → 修正中」)
//   - 経費・申請フォーム: 承認・却下の記録(approvals)
// 見える範囲は、承認待ちと同じ(画面に見えているタスク・申請だけ。登録の記録は GAS が担当プロジェクトで絞る)。
// 「承認の履歴を表示する」を押した時に読む(承認待ちを開くたびには読まない)
import { useMemo, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useTaskDrawer } from '@/lib/ohsumi/task-drawer'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type ApprovalLogEntry } from '@/lib/ohsumi/remote'
import { cn } from '@/lib/utils'

type Kind = 'registration' | 'review' | 'expense' | 'form'
type Action = 'approved' | 'rejected' | 'returned'

interface HistoryItem {
  id: string
  at: string
  kind: Kind
  action: Action
  title: string
  byId: string
  note: string
  taskId?: string
}

const KINDS: Kind[] = ['registration', 'review', 'expense', 'form']
const KIND_KEY: Record<Kind, TranslationKey> = {
  registration: 'approvalHistory.kind.registration',
  review: 'approvalHistory.kind.review',
  expense: 'approvalHistory.kind.expense',
  form: 'approvalHistory.kind.form',
}
const ACTION_KEY: Record<Action, TranslationKey> = {
  approved: 'approvalHistory.action.approved',
  rejected: 'approvalHistory.action.rejected',
  returned: 'approvalHistory.action.returned',
}
const ACTION_STYLE: Record<Action, string> = {
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  rejected: 'bg-destructive/10 text-destructive',
  returned: 'bg-warning-muted text-warning',
}
const PERIODS = [30, 90, 365] as const
const PAGE = 100

export function ApprovalHistory({ className }: { className?: string }) {
  const { t, locale } = useI18n()
  const { adminTasks, expenseApplications, expenseCategories, customFormSubmissions, customFormDefs, getMember } = useOhsumi()
  const { openTask } = useTaskDrawer()
  const [shown, setShown] = useState(false)
  const [loading, setLoading] = useState(false)
  const [log, setLog] = useState<ApprovalLogEntry[]>([])
  const [keepDays, setKeepDays] = useState(365)
  // 登録の記録が読めなかった理由(古い GAS・ほかのエラー)
  const [logNote, setLogNote] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind | 'all'>('all')
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(90)
  const [by, setBy] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const show = () => {
    setShown(true)
    if (!isRemoteConfigured) return
    setLoading(true)
    setLogNote(null)
    remoteApi.getApprovalLog().then(
      (r) => { setLog(r.entries ?? []); if (r.keepDays) setKeepDays(r.keepDays) },
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        setLogNote(/getApprovalLog|Unknown action/i.test(msg) ? t('approvalHistory.oldGas') : msg)
      },
    ).finally(() => setLoading(false))
  }

  const items = useMemo<HistoryItem[]>(() => {
    if (!shown) return []
    const out: HistoryItem[] = []
    for (const e of log) {
      out.push({ id: 'reg-' + e.id, at: e.at, kind: 'registration', action: e.action, title: e.title, byId: e.byId, note: e.reason, taskId: e.targetId })
    }
    for (const task of adminTasks) {
      task.reviewApprovals?.forEach((a, i) => {
        out.push({ id: `rv-${task.id}-${i}`, at: a.at, kind: 'review', action: 'approved', title: task.name, byId: a.memberId, note: a.comment ?? '', taskId: task.id })
      })
      task.history?.forEach((h) => {
        if (h.field === 'status' && h.from === 'review' && h.to === 'fix') {
          out.push({ id: `rt-${h.id}`, at: h.at, kind: 'review', action: 'returned', title: task.name, byId: h.byId, note: '', taskId: task.id })
        }
      })
    }
    for (const app of expenseApplications) {
      const category = expenseCategories.find((c) => c.id === app.categoryId)
      const title = t('approvalHistory.expenseTitle', { category: category?.label ?? app.categoryId, amount: app.amount.toLocaleString() })
      app.approvals.forEach((a, i) => {
        out.push({ id: `ex-${app.id}-${i}`, at: a.at, kind: 'expense', action: a.action, title, byId: a.memberId, note: a.comment ?? '' })
      })
    }
    for (const sub of customFormSubmissions) {
      const title = customFormDefs.find((f) => f.id === sub.formId)?.title ?? sub.formId
      sub.approvals.forEach((a, i) => {
        out.push({ id: `fm-${sub.id}-${i}`, at: a.at, kind: 'form', action: a.action, title, byId: a.memberId, note: a.comment ?? '' })
      })
    }
    return out.filter((x) => !Number.isNaN(Date.parse(x.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  }, [shown, log, adminTasks, expenseApplications, expenseCategories, customFormSubmissions, customFormDefs, t])

  const since = Date.now() - period * 24 * 3600 * 1000
  const inPeriod = items.filter((x) => Date.parse(x.at) >= since && (kind === 'all' || x.kind === kind))
  const approvers = [...new Set(inPeriod.map((x) => x.byId))].filter(Boolean)
  const filtered = inPeriod.filter((x) => !by || x.byId === by)
  const nameOf = (id: string) => {
    const m = getMember(id)
    return m ? m.displayName || m.name : t('approvalHistory.unknownMember')
  }
  const fmt = (iso: string) => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  const taskExists = (id?: string) => !!id && adminTasks.some((x) => x.id === id)
  const selectClass = 'h-8 rounded-md border border-border bg-transparent px-2 text-xs'

  return (
    <div className={cn('max-w-4xl', className)} data-approval-history>
      <div className="flex items-center gap-1.5">
        <History className="size-4 text-muted-foreground" />
        <SectionLabel>{t('approvalHistory.title')}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('approvalHistory.desc', { days: keepDays })}</p>
      {!shown ? (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={show} data-approval-history-show>
            {t('approvalHistory.show')}
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className={selectClass} value={kind} onChange={(e) => { setKind(e.target.value as Kind | 'all'); setLimit(PAGE) }} aria-label={t('approvalHistory.filter.kind')}>
              <option value="all">{t('approvalHistory.filter.allKinds')}</option>
              {KINDS.map((k) => <option key={k} value={k}>{t(KIND_KEY[k])}</option>)}
            </select>
            <select className={selectClass} value={period} onChange={(e) => { setPeriod(Number(e.target.value) as (typeof PERIODS)[number]); setLimit(PAGE) }} aria-label={t('approvalHistory.filter.period')}>
              {PERIODS.map((d) => <option key={d} value={d}>{t('approvalHistory.filter.days', { days: d })}</option>)}
            </select>
            <select className={selectClass} value={by} onChange={(e) => { setBy(e.target.value); setLimit(PAGE) }} aria-label={t('approvalHistory.filter.by')}>
              <option value="">{t('approvalHistory.filter.anyone')}</option>
              {approvers.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
            </select>
            {loading && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('common.loading')}</span>}
          </div>
          {logNote && <p className="mt-2 text-xs break-words text-muted-foreground" data-approval-history-note>{logNote}</p>}
          {filtered.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">{t('approvalHistory.empty')}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card" data-approval-history-list>
              {filtered.slice(0, limit).map((x) => {
                const canOpen = taskExists(x.taskId)
                return (
                  <li key={x.id} className="flex flex-col gap-1 px-4 py-2.5 text-xs sm:flex-row sm:items-start sm:gap-3" data-approval-history-item={x.kind}>
                    <span className="shrink-0 text-muted-foreground sm:w-36">{fmt(x.at)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t(KIND_KEY[x.kind])}</span>
                        <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-semibold', ACTION_STYLE[x.action])}>{t(ACTION_KEY[x.action])}</span>
                        {canOpen ? (
                          <button type="button" className="min-w-0 break-words text-left font-medium text-foreground hover:underline" onClick={() => openTask(x.taskId!)}>{x.title}</button>
                        ) : (
                          <span className="min-w-0 break-words font-medium text-foreground">{x.title}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-muted-foreground">{t('approvalHistory.by', { name: nameOf(x.byId) })}</p>
                      {x.note && <p className="mt-0.5 break-words whitespace-pre-wrap text-foreground/80">{x.note}</p>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {filtered.length > limit && (
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setLimit((n) => n + PAGE)}>
              {t('approvalHistory.more', { count: filtered.length - limit })}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
