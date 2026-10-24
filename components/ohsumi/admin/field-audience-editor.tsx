'use client'

// ADMIN > 人材DB >「項目の公開範囲」。人材データの項目ごとに、見せる相手(上長・部署長・メンター・プロジェクトの責任者・
// 幹部・全員)を選ぶ(団体の設定 member_field_visibility。lib/ohsumi/field-audiences.ts)。変えられるのは団体のルール
// (org.rules)を持つ人だけ(持たない人には今の範囲を見るだけで出す)。判定は団体の GAS が読み取りの時に行う。
// 「この人から見ると」で、見る人と見られる人を選ぶと、保存の前の範囲で見られる項目を出す
import { useMemo, useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import { CapabilityNote } from '@/components/ohsumi/primitives'
import { Button } from '@/components/ui/button'
import { isActiveMember } from '@/lib/ohsumi/utils'
import {
  AUDIENCE_LABELS, CUSTOM_FIELD_PREFIX, DAILY_REPORTS_DEF, FIELD_GROUPS, MEMBER_FIELDS, allowedAudiences, audienceAllows,
  audiencesOf, describeAudiences, sameAudiences, type AudienceContext, type FieldAudience, type FieldAudienceSetting, type FieldDef,
} from '@/lib/ohsumi/field-audiences'

export function FieldAudienceEditor() {
  const { t, locale } = useI18n()
  const toast = useToast()
  const {
    memberFieldVisibility, updateMemberFieldVisibility, fieldAudiencesSupported, can, members, projects, departmentTreeConfig,
    customMemberColumns, isAdminRef, isTopRef,
  } = useOhsumi()
  const lang = locale === 'en' ? 'en' : 'ja'
  const canEdit = can('org.rules') && fieldAudiencesSupported
  const [draft, setDraft] = useState<FieldAudienceSetting | null>(null)
  const shown = draft ?? memberFieldVisibility
  const [viewerId, setViewerId] = useState('')
  const [subjectId, setSubjectId] = useState('')

  // 独自の項目(1つずつ)と日報・週報を、決まった項目のあとに足す
  const fields: FieldDef[] = useMemo(() => [
    ...MEMBER_FIELDS,
    ...customMemberColumns.map((c) => ({
      key: CUSTOM_FIELD_PREFIX + c.key, ja: t('admin.fieldAudience.customField', { name: c.label }), en: t('admin.fieldAudience.customField', { name: c.label }),
      group: 'other' as const, default: audiencesOf('custom_fields_json', {}),
    })),
    DAILY_REPORTS_DEF,
  ], [customMemberColumns, t])

  const changed = JSON.stringify(shown) !== JSON.stringify(memberFieldVisibility)
  const setField = (key: string, audiences: FieldAudience[] | null) => {
    const next = { ...shown }
    if (audiences === null) delete next[key]
    else next[key] = audiences
    setDraft(next)
  }
  const toggle = (f: FieldDef, a: FieldAudience) => {
    const cur = audiencesOf(f.key, shown)
    const nextList = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]
    // 既定と同じになったら設定を外す(独自の項目のキーは「まとめて」の範囲と同じなら外す)
    const base = f.key.startsWith(CUSTOM_FIELD_PREFIX) ? audiencesOf('custom_fields_json', shown) : f.default
    setField(f.key, sameAudiences(nextList, base) ? null : nextList)
  }
  const save = () => {
    if (!changed) return
    updateMemberFieldVisibility(shown)
    setDraft(null)
    toast(t('admin.fieldAudience.saved'))
  }

  const active = useMemo(() => members.filter(isActiveMember), [members])
  const ctx: AudienceContext = useMemo(() => ({
    members, projects, departmentTree: departmentTreeConfig,
    isAdminRole: (r: string) => isAdminRef(r), isTopRole: (r: string) => isTopRef(r),
  }), [members, projects, departmentTreeConfig, isAdminRef, isTopRef])
  const visible = viewerId && subjectId
    ? fields.filter((f) => audienceAllows(audiencesOf(f.key, shown), viewerId, subjectId, ctx))
    : null

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-field-audiences>
      <p className="text-xs text-muted-foreground">{t('admin.fieldAudience.desc')}</p>
      {!fieldAudiencesSupported && <p className="mt-2 text-xs text-warning" data-field-audiences-unsupported>{t('admin.fieldAudience.unsupported')}</p>}
      {fieldAudiencesSupported && <CapabilityNote cap="org.rules" className="mt-2" />}
      {FIELD_GROUPS.map((g) => {
        const list = fields.filter((f) => f.group === g.key)
        if (!list.length) return null
        return (
          <section key={g.key} className="mt-4" data-field-audience-group={g.key}>
            <h3 className="text-xs font-semibold text-muted-foreground">{g[lang]}</h3>
            <ul className="mt-1 divide-y divide-border">
              {list.map((f) => {
                const cur = audiencesOf(f.key, shown)
                const isSet = !!shown[f.key]
                return (
                  <li key={f.key} className="min-w-0 py-2" data-field-audience={f.key}>
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                      <span className="min-w-0 break-words text-sm font-medium">{f[lang]}</span>
                      <span className="text-[11px] text-muted-foreground" data-field-audience-summary>
                        {describeAudiences(cur, lang)}
                        {!isSet && ' · ' + t('admin.fieldAudience.defaultIs', { value: describeAudiences(f.default, lang) })}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {allowedAudiences(f.key).map((a) => (
                        <label
                          key={a}
                          className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:disabled]:cursor-default"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-[var(--primary)]"
                            disabled={!canEdit}
                            checked={cur.includes(a)}
                            data-field-audience-option={a}
                            onChange={() => toggle(f, a)}
                          />
                          {AUDIENCE_LABELS[a][lang]}
                        </label>
                      ))}
                      {isSet && canEdit && (
                        <button type="button" className="px-1 text-xs text-muted-foreground underline" onClick={() => setField(f.key, null)} data-field-audience-reset>
                          {t('admin.fieldAudience.reset')}
                        </button>
                      )}
                    </div>
                    {f.key === DAILY_REPORTS_DEF.key && <p className="mt-1 text-[11px] text-muted-foreground">{t('admin.fieldAudience.reportsNote')}</p>}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

      <section className="mt-4 rounded-md bg-secondary p-3" data-field-audience-preview>
        <h3 className="text-xs font-semibold">{t('admin.fieldAudience.previewTitle')}</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs">
            <span className="block text-muted-foreground">{t('admin.fieldAudience.previewViewer')}</span>
            <select className="mt-1 h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs" value={viewerId} onChange={(e) => setViewerId(e.target.value)} data-field-audience-viewer>
              <option value="">—</option>
              {active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-xs">
            <span className="block text-muted-foreground">{t('admin.fieldAudience.previewSubject')}</span>
            <select className="mt-1 h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} data-field-audience-subject>
              <option value="">—</option>
              {active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs break-words" data-field-audience-preview-result aria-live="polite">
          {visible === null
            ? t('admin.fieldAudience.previewPick')
            : visible.length
              ? t('admin.fieldAudience.previewResult', { count: visible.length }) + ' ' + visible.map((f) => f[lang]).join(lang === 'en' ? ', ' : '・')
              : t('admin.fieldAudience.previewNone')}
        </p>
      </section>

      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!changed} onClick={save} data-field-audience-save data-gas-action="updateSetting">
            {t('common.save')}
          </Button>
          {draft && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </Button>
          )}
          {changed && <span className="text-xs text-warning">{t('admin.fieldAudience.unsaved')}</span>}
        </div>
      )}
    </div>
  )
}
