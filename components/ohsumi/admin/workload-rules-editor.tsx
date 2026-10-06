'use client'

import { useMemo, useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import { CapabilityNote } from '@/components/ohsumi/primitives'
import { Button } from '@/components/ui/button'
import { countWorkloadCapacities, isActiveMember } from '@/lib/ohsumi/utils'
import {
  DEFAULT_WORKLOAD_RULES,
  WORKLOAD_RULE_NUMBER_KEYS,
  WORKLOAD_RULE_RANGES,
  workloadRuleProblems,
  type WorkloadRules,
} from '@/lib/ohsumi/workload-rules'

type NumberKey = (typeof WORKLOAD_RULE_NUMBER_KEYS)[number]
type Draft = Record<NumberKey, string> & { count_hold_and_review: boolean }

const LABEL_KEY: Record<NumberKey | 'count_hold_and_review', TranslationKey> = {
  available_ratio: 'admin.workloadRules.available_ratio',
  full_ratio: 'admin.workloadRules.full_ratio',
  window_days: 'admin.workloadRules.window_days',
  fallback_hours: 'admin.workloadRules.fallback_hours',
  no_history_normal_max_hours: 'admin.workloadRules.no_history_normal_max_hours',
  count_hold_and_review: 'admin.workloadRules.count_hold_and_review',
  low_workload_task_threshold: 'admin.workloadRules.low_workload_task_threshold',
}

const draftOf = (r: WorkloadRules): Draft => ({
  ...(Object.fromEntries(WORKLOAD_RULE_NUMBER_KEYS.map((k) => [k, String(r[k])])) as Record<NumberKey, string>),
  count_hold_and_review: r.count_hold_and_review,
})

// 入力の文字を数にする(空・数でない時は NaN。範囲の確かめで止まる)
const rulesOf = (d: Draft): WorkloadRules => ({
  ...(Object.fromEntries(
    WORKLOAD_RULE_NUMBER_KEYS.map((k) => [k, d[k].trim() === '' ? Number.NaN : Number(d[k])]),
  ) as Record<NumberKey, number>),
  count_hold_and_review: d.count_hold_and_review,
})

const sameRules = (a: WorkloadRules, b: WorkloadRules) =>
  (Object.keys(DEFAULT_WORKLOAD_RULES) as (keyof WorkloadRules)[]).every((k) => a[k] === b[k])

// ADMIN > タスクの設定 >「稼働の目安」。団体の設定 workload_rules を変える(団体のルール org.rules を持つ人だけ。
// 持たない人には今の値を見るだけで出す)。入力を変えると、保存の前に人数の見込みを出す
export function WorkloadRulesEditor() {
  const { t } = useI18n()
  const toast = useToast()
  const { workloadRules, updateWorkloadRules, can, members, workloadTasks } = useOhsumi()
  const canEdit = can('org.rules')
  const [draft, setDraft] = useState<Draft | null>(null)
  const shown = draft ?? draftOf(workloadRules)
  const rules = rulesOf(shown)
  const problems = workloadRuleProblems(rules)
  const problemOf = (k: NumberKey) => problems.find((p) => p.key === k)
  const changed = !sameRules(rules, workloadRules)
  const activeMembers = useMemo(() => members.filter(isActiveMember), [members])
  const preview = problems.length ? null : countWorkloadCapacities(activeMembers, workloadTasks, rules)

  const set = (patch: Partial<Draft>) => setDraft({ ...shown, ...patch })
  const save = () => {
    if (problems.length || !changed) return
    updateWorkloadRules(rules)
    setDraft(null)
    toast(t('admin.workloadRules.saved'))
  }
  const field =
    'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs tabular-nums outline-none focus:border-primary disabled:opacity-60 aria-[invalid=true]:border-destructive'

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-workload-rules>
      <p className="text-xs text-muted-foreground">{t('admin.workloadRules.desc')}</p>
      <CapabilityNote cap="org.rules" className="mt-2" />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {WORKLOAD_RULE_NUMBER_KEYS.map((k) => {
          const range = WORKLOAD_RULE_RANGES[k]
          const problem = problemOf(k)
          const id = `workload-rule-${k}`
          return (
            <div key={k} className="min-w-0 text-xs">
              <label htmlFor={id} className="block font-medium">{t(LABEL_KEY[k])}</label>
              <input
                id={id}
                type="number"
                inputMode="decimal"
                min={range.min}
                max={range.max}
                step={range.step}
                disabled={!canEdit}
                aria-invalid={!!problem}
                aria-describedby={`${id}-hint`}
                data-workload-rule={k}
                className={field + ' mt-1'}
                value={shown[k]}
                onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)}
              />
              <p id={`${id}-hint`} className={problem ? 'mt-0.5 text-destructive' : 'mt-0.5 text-muted-foreground'}>
                {problem
                  ? problem.kind === 'order'
                    ? t('admin.workloadRules.error.order')
                    : t(range.integer ? 'admin.workloadRules.error.rangeInt' : 'admin.workloadRules.error.range', { min: range.min, max: range.max })
                  : t('admin.workloadRules.default', { value: DEFAULT_WORKLOAD_RULES[k] })}
              </p>
            </div>
          )
        })}
        <label className="flex min-w-0 items-start gap-2 text-xs sm:col-span-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--primary)] disabled:cursor-default"
            disabled={!canEdit}
            checked={shown.count_hold_and_review}
            data-workload-rule="count_hold_and_review"
            onChange={(e) => set({ count_hold_and_review: e.target.checked })}
          />
          <span>
            <span className="font-medium">{t(LABEL_KEY.count_hold_and_review)}</span>
            <span className="mt-0.5 block text-muted-foreground">{t('admin.workloadRules.defaultOn')}</span>
          </span>
        </label>
      </div>
      <p className="mt-3 rounded-md bg-secondary px-3 py-2 text-xs" data-workload-preview aria-live="polite">
        {preview
          ? t('admin.workloadRules.preview', { available: preview.available, normal: preview.normal, full: preview.full })
          : t('admin.workloadRules.previewInvalid')}
      </p>
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={!changed || problems.length > 0} onClick={save} data-workload-save data-gas-action="updateSetting">
            {t('common.save')}
          </Button>
          <Button size="sm" variant="outline" disabled={sameRules(rules, DEFAULT_WORKLOAD_RULES)} onClick={() => setDraft(draftOf(DEFAULT_WORKLOAD_RULES))} data-workload-reset>
            {t('admin.workloadRules.reset')}
          </Button>
          {draft && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
