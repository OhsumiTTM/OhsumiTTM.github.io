'use client'

// 担当の候補の決め方(管理画面「スキルの決まり」)。lib/ohsumi/assign-candidates.ts
//   - メンターの候補にする、そのスキルのレベルの下限(1〜5。既定は 3)
// 団体の設定(Settings の assign_candidate_rules)。団体のルール(org.rules)が無い人は見るだけ
import { CapabilityNote } from '@/components/ohsumi/primitives'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import type { SkillLevelValue } from '@/lib/ohsumi/types'

const LEVELS: SkillLevelValue[] = [1, 2, 3, 4, 5]

export function AssignCandidateRulesEditor() {
  const { t } = useI18n()
  const toast = useToast()
  const { assignCandidateRules, updateAssignCandidateRules, can } = useOhsumi()
  const canEdit = can('org.rules')
  return (
    <div data-assign-candidate-rules>
      <p className="text-xs text-muted-foreground">{t('admin.assignRules.desc')}</p>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span>{t('admin.assignRules.mentorLevel')}</span>
        <select
          className="h-8 rounded-md border border-border bg-transparent px-2 text-sm"
          value={assignCandidateRules.mentor_min_level}
          disabled={!canEdit}
          data-gas-action="updateSetting"
          onChange={(e) => {
            updateAssignCandidateRules({ mentor_min_level: Number(e.target.value) as SkillLevelValue })
            toast(t('admin.assignRules.savedToast'))
          }}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{t('admin.assignRules.levelOption', { level: l })}</option>
          ))}
        </select>
      </label>
      <CapabilityNote cap="org.rules" className="mt-3" />
    </div>
  )
}
