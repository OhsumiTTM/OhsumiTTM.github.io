'use client'

// 個人ページの、項目ごとの公開範囲(lib/ohsumi/field-audiences.ts)に関わる部品:
//   FieldAudienceSummary  自分のページに「自分のデータを見られる人」を出す(団体の設定の範囲)
//   MemberDailyReports    その人の日報・週報(団体の GAS が、見られる分だけを返す。日報を見る権限の人はすべて)
//   useFieldVisible       見る人が、その人の項目を見られるか(タブを出すかの判断だけに使う。値を送るかは GAS が決める)
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import {
  CUSTOM_FIELD_PREFIX, DAILY_REPORTS_DEF, FIELD_GROUPS, MEMBER_FIELDS, audienceAllows, audiencesOf, describeAudiences,
  type AudienceContext, type FieldDef,
} from '@/lib/ohsumi/field-audiences'
import type { DailyReportEntry } from '@/lib/ohsumi/types'

export function useFieldVisible(ownerId: string) {
  const { currentUser, members, projects, departmentTreeConfig, memberFieldVisibility, isAdminRef, isTopRef } = useOhsumi()
  const ctx: AudienceContext = useMemo(() => ({
    members, projects, departmentTree: departmentTreeConfig,
    isAdminRole: (r: string) => isAdminRef(r), isTopRole: (r: string) => isTopRef(r),
  }), [members, projects, departmentTreeConfig, isAdminRef, isTopRef])
  return useCallback(
    (key: string) => !!currentUser && audienceAllows(audiencesOf(key, memberFieldVisibility), currentUser.id, ownerId, ctx),
    [currentUser, memberFieldVisibility, ownerId, ctx],
  )
}

export function FieldAudienceSummary() {
  const { t, locale } = useI18n()
  const { memberFieldVisibility, customMemberColumns, fieldAudiencesSupported } = useOhsumi()
  const lang = locale === 'en' ? 'en' : 'ja'
  if (!fieldAudiencesSupported) return null
  const fields: FieldDef[] = [
    ...MEMBER_FIELDS,
    ...customMemberColumns.map((c) => ({ key: CUSTOM_FIELD_PREFIX + c.key, ja: c.label, en: c.label, group: 'other' as const, default: [] })),
    DAILY_REPORTS_DEF,
  ]
  return (
    <details className="mt-4 rounded-xl border border-border bg-card p-3" data-field-audience-summary-self>
      <summary className="cursor-pointer text-sm font-semibold">{t('person.fieldAudience.summaryTitle')}</summary>
      <p className="mt-1 text-xs text-muted-foreground">{t('person.fieldAudience.summaryDesc')}</p>
      {FIELD_GROUPS.map((g) => {
        const list = fields.filter((f) => f.group === g.key)
        if (!list.length) return null
        return (
          <div key={g.key} className="mt-3">
            <h4 className="text-xs font-semibold text-muted-foreground">{g[lang]}</h4>
            <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
              {list.map((f) => (
                <div key={f.key} className="flex min-w-0 justify-between gap-2 border-b border-border/60 py-1">
                  <dt className="min-w-0 break-words">{f[lang]}</dt>
                  <dd className="shrink-0 text-right text-muted-foreground">{describeAudiences(audiencesOf(f.key, memberFieldVisibility), lang)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )
      })}
    </details>
  )
}

const SHOWN_REPORTS = 10

export function MemberDailyReports({ memberId }: { memberId: string }) {
  const { t } = useI18n()
  const { fetchDailyReports, fieldAudiencesSupported } = useOhsumi()
  const [reports, setReports] = useState<DailyReportEntry[] | null>(null)
  useEffect(() => {
    if (!fieldAudiencesSupported) return
    let alive = true
    fetchDailyReports().then(
      (list) => { if (alive) setReports(list.filter((r) => r.memberId === memberId).sort((a, b) => b.date.localeCompare(a.date))) },
      () => { if (alive) setReports([]) },
    )
    return () => { alive = false }
  }, [fetchDailyReports, memberId, fieldAudiencesSupported])
  if (!reports || !reports.length) return null
  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-3" data-member-daily-reports>
      <h3 className="text-sm font-semibold">{t('person.dailyReports.title')}</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {reports.slice(0, SHOWN_REPORTS).map((r) => (
          <li key={r.id} className="min-w-0 rounded-lg bg-secondary px-3 py-2 text-xs">
            <p className="font-medium">{t('dailyReport.history.badge', { type: t(r.type === 'weekly' ? 'dailyReport.type.weekly' : 'dailyReport.type.daily'), date: r.date })}</p>
            {r.done && <p className="mt-1 whitespace-pre-wrap break-words"><span className="text-muted-foreground">{t('dailyReport.history.doneLabel')}: </span>{r.done}</p>}
            {r.todo && <p className="mt-0.5 whitespace-pre-wrap break-words"><span className="text-muted-foreground">{t('dailyReport.history.todoLabel')}: </span>{r.todo}</p>}
            {r.issues && <p className="mt-0.5 whitespace-pre-wrap break-words"><span className="text-muted-foreground">{t('dailyReport.history.issuesLabel')}: </span>{r.issues}</p>}
          </li>
        ))}
      </ul>
      {reports.length > SHOWN_REPORTS && <p className="mt-2 text-xs text-muted-foreground">{t('person.dailyReports.more', { count: reports.length - SHOWN_REPORTS })}</p>}
    </section>
  )
}
