'use client'

// 「すべての団体」の「カレンダー」(兼部の統合表示の第3段階。lib/ohsumi/multi-org.ts の calendarEntries)。
// 団体ごとの getMyDigest(本人の分だけ)を、見ている月の終わりまでの期間で読み、日付ごとに並べる。
// 見た目と動き(月・週・日、前へ・次へ・今日)は、1つの団体の「カレンダー」(calendar-view.tsx)と同じ。
// 団体はテーマの色の印と短い名前で見分け、団体ごとに出す・出さないを選べる。押すと、その団体に切り替えてタスクを開く。
// まとめた内容は、この画面のメモリの中でだけ使う(端末に保存しない)
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import {
  calendarEntries,
  fetchAllDigests,
  localDate,
  monthDigestRange,
  shortOrgName,
  type CalendarEntry,
  type CalendarEntryKind,
  type CombinedTask,
  type DigestOrg,
  type OrgDigestState,
} from '@/lib/ohsumi/multi-org'
import { SegmentedButton, SegmentedControl } from '../segmented'

type CalView = 'month' | 'week' | 'day'

const KIND_LABEL: Record<CalendarEntryKind, TranslationKey> = {
  due: 'multiOrg.calendar.kind.due',
  start: 'multiOrg.calendar.kind.start',
  review: 'multiOrg.calendar.kind.review',
  candidate: 'multiOrg.calendar.kind.candidate',
  form: 'multiOrg.calendar.kind.form',
}

const startOfWeek = (d: Date) => {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  s.setDate(s.getDate() - s.getDay())
  return s
}

export function AllOrgsCalendar({ orgs, onOpen, refreshKey = 0 }: { orgs: DigestOrg[]; onOpen: (task: CombinedTask) => void; refreshKey?: number }) {
  const { t } = useI18n()
  const weekdays = t('taskDrawer.schedule.weekdayShort').split(',')
  const today = localDate(new Date())
  const [view, setView] = useState<CalView>('month')
  const [cursor, setCursor] = useState<Date>(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), n.getDate())
  })
  const [hidden, setHidden] = useState<string[]>([])
  const [states, setStates] = useState<Record<string, OrgDigestState>>({})
  const [loading, setLoading] = useState(false)

  // 見ている範囲の最後の日の月(週・日の表示で月をまたぐ時も、その終わりまで読む)
  const lastShown = useMemo(() => {
    if (view === 'month') return new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
    if (view === 'week') {
      const e = startOfWeek(cursor)
      e.setDate(e.getDate() + 6)
      return e
    }
    return cursor
  }, [view, cursor])
  const rangeKey = `${lastShown.getFullYear()}-${lastShown.getMonth()}`

  useEffect(() => {
    const range = monthDigestRange(lastShown.getFullYear(), lastShown.getMonth())
    let alive = true
    setLoading(true)
    setStates(Object.fromEntries(orgs.map((o) => [o.orgId, { kind: 'loading' } as OrgDigestState])))
    void fetchAllDigests(orgs, (orgId, state) => { if (alive) setStates((prev) => ({ ...prev, [orgId]: state })) }, new Date(), range)
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [orgs, rangeKey, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => calendarEntries(orgs, states, hidden), [orgs, states, hidden])

  const move = (delta: number) => {
    const d = new Date(cursor)
    if (view === 'month') d.setMonth(d.getMonth() + delta, 1)
    else if (view === 'week') d.setDate(d.getDate() + delta * 7)
    else d.setDate(d.getDate() + delta)
    setCursor(d)
  }
  const goToday = () => {
    const n = new Date()
    setCursor(new Date(n.getFullYear(), n.getMonth(), n.getDate()))
  }

  const header = () => {
    if (view === 'month') return t('calendar.header.month', { year: cursor.getFullYear(), month: cursor.getMonth() + 1 })
    if (view === 'week') {
      const s = startOfWeek(cursor)
      const e = new Date(s)
      e.setDate(e.getDate() + 6)
      return t('calendar.header.week', { startMonth: s.getMonth() + 1, startDay: s.getDate(), endMonth: e.getMonth() + 1, endDay: e.getDate() })
    }
    return t('calendar.header.day', { year: cursor.getFullYear(), month: cursor.getMonth() + 1, day: cursor.getDate(), weekday: weekdays[cursor.getDay()] })
  }

  // 団体の色(読めた団体の色。読めない間は今の色)
  const orgColor = (orgId: string) => {
    const s = states[orgId]
    return s && s.kind === 'ok' ? s.digest.themeColor : ''
  }
  const orgName = (o: DigestOrg) => {
    const s = states[o.orgId]
    return (s && s.kind === 'ok' && s.digest.orgName) || o.name
  }

  const chip = (e: CalendarEntry, compact: boolean) => (
    <button
      key={e.kind + ':' + e.task.orgId + ':' + e.task.id + ':' + e.time}
      type="button"
      onClick={() => onOpen(e.task)}
      title={e.task.orgName + ' / ' + e.task.title}
      className={cn(
        'flex w-full min-w-0 items-center gap-1 rounded-md border px-1.5 py-1 text-left transition-colors',
        e.kind === 'due' && e.task.overdue ? 'border-danger-border bg-danger-muted hover:brightness-95' : 'border-border bg-secondary hover:bg-muted',
        e.kind === 'start' && 'opacity-75',
      )}
      data-calendar-entry={e.kind}
      data-calendar-org={e.task.orgId}
    >
      <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: e.task.themeColor || 'var(--primary)' }} aria-hidden />
      {!compact && <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">{shortOrgName(e.task.orgName) || '—'}</span>}
      {e.time && <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{e.time}</span>}
      {e.kind !== 'due' && <span className="shrink-0 text-[10px] text-muted-foreground">{t(KIND_LABEL[e.kind])}</span>}
      <span className="truncate text-[11px] font-medium leading-tight">{e.task.title}</span>
    </button>
  )

  const dayEntries = (d: Date) => byDay.get(localDate(d)) ?? []

  return (
    <div className="rounded-xl border border-border bg-card" data-all-orgs-calendar={view}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={() => move(-1)} aria-label={t('calendar.nav.prev')}>
            <ChevronRight className="size-4 rotate-180" />
          </Button>
          <h3 className="min-w-[160px] text-center text-sm font-semibold" data-calendar-header>{header()}</h3>
          <Button variant="outline" size="icon-sm" onClick={() => move(1)} aria-label={t('calendar.nav.next')}>
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={goToday}>{t('calendar.nav.today')}</Button>
          {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('multiOrg.state.loading')} />}
        </div>
        <SegmentedControl ariaLabel={t('multiOrg.calendar.viewLabel')}>
          {(['month', 'week', 'day'] as const).map((v) => (
            <SegmentedButton key={v} active={view === v} onClick={() => setView(v)}>{t(`calendar.view.${v}` as TranslationKey)}</SegmentedButton>
          ))}
        </SegmentedControl>
      </div>

      {/* 団体ごとに出す・出さない */}
      <fieldset className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2" data-calendar-orgs>
        <legend className="sr-only">{t('multiOrg.calendar.orgsLabel')}</legend>
        {orgs.map((o) => {
          const on = !hidden.includes(o.orgId)
          const state = states[o.orgId]
          const problem = state && state.kind !== 'ok' && state.kind !== 'loading'
          return (
            <label
              key={o.orgId}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs has-[:checked]:bg-secondary"
              title={orgName(o)}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--primary)]"
                checked={on}
                onChange={() => setHidden((h) => (on ? [...h, o.orgId] : h.filter((x) => x !== o.orgId)))}
                data-calendar-org-toggle={o.orgId}
              />
              <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: orgColor(o.orgId) || 'var(--primary)' }} aria-hidden />
              <span className="min-w-0 truncate">{shortOrgName(orgName(o)) || '—'}</span>
              {problem && <span className="text-[10px] text-destructive">{t('multiOrg.calendar.notLoaded')}</span>}
            </label>
          )
        })}
      </fieldset>

      {view === 'month' && (() => {
        const y = cursor.getFullYear()
        const m = cursor.getMonth()
        const first = new Date(y, m, 1)
        const days = new Date(y, m + 1, 0).getDate()
        const cells: (Date | null)[] = []
        for (let i = 0; i < first.getDay(); i++) cells.push(null)
        for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d))
        while (cells.length % 7 !== 0) cells.push(null)
        return (
          <>
            <div className="grid grid-cols-7 border-b border-border">
              {weekdays.map((w, i) => (
                <div key={w} className={cn('py-2 text-center text-xs font-medium', i === 0 ? 'text-danger' : i === 6 ? 'text-primary' : 'text-muted-foreground')}>{w}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d, i) => {
                const entries = d ? dayEntries(d) : []
                const isToday = d && localDate(d) === today
                return (
                  <div key={d ? localDate(d) : 'empty-' + i} className={cn('min-h-[104px] min-w-0 border-b border-r border-border p-1.5 [&:nth-child(7n)]:border-r-0', !d && 'bg-secondary/30')} data-calendar-day={d ? localDate(d) : undefined}>
                    {d && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setCursor(d); setView('day') }}
                          className={cn('mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs hover:bg-secondary', isToday ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground')}
                        >
                          {d.getDate()}
                        </button>
                        <div className="space-y-1">
                          {entries.slice(0, 3).map((e) => chip(e, true))}
                          {entries.length > 3 && (
                            <button type="button" onClick={() => { setCursor(d); setView('day') }} className="w-full text-left text-[10px] text-muted-foreground hover:underline">
                              {t('multiOrg.calendar.more', { count: entries.length - 3 })}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )
      })()}

      {view === 'week' && (() => {
        const s = startOfWeek(cursor)
        const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(s); d.setDate(d.getDate() + i); return d })
        return (
          <div className="grid grid-cols-1 sm:grid-cols-7">
            {days.map((d, i) => {
              const entries = dayEntries(d)
              const isToday = localDate(d) === today
              return (
                <div key={localDate(d)} className="min-h-[88px] min-w-0 border-b border-border p-2 sm:border-r sm:[&:nth-child(7n)]:border-r-0" data-calendar-day={localDate(d)}>
                  <p className={cn('mb-1 text-xs font-medium', isToday ? 'text-primary' : i === 0 ? 'text-danger' : 'text-muted-foreground')}>
                    {d.getMonth() + 1}/{d.getDate()}({weekdays[d.getDay()]})
                  </p>
                  <div className="space-y-1">{entries.map((e) => chip(e, false))}</div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {view === 'day' && (
        <div className="p-4" data-calendar-day={localDate(cursor)}>
          {dayEntries(cursor).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('multiOrg.empty')}</p>
          ) : (
            <div className="space-y-1.5">{dayEntries(cursor).map((e) => chip(e, false))}</div>
          )}
        </div>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">{t('multiOrg.calendar.note')}</p>
    </div>
  )
}
