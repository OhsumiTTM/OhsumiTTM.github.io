'use client'

// 評価に付けるスキルの上限(管理画面「スキルの決まり」)。lib/ohsumi/evaluation-skills.ts
//   - 1回の評価で、1つのスキルに付けられる点数(0〜1000。既定 100)
//   - 同じ人が、同じ相手の同じスキルに付け直せるまでの日数(0〜365。既定 30。0 で制限なし)
// 団体の設定(Settings の evaluation_skill_rules)。団体のルール(org.rules)が無い人は見るだけ
import { useState } from 'react'
import { CapabilityNote } from '@/components/ohsumi/primitives'
import { Button } from '@/components/ui/button'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import { EVALUATION_SKILL_LIMITS, validEvaluationSkillRules, type EvaluationSkillRules } from '@/lib/ohsumi/evaluation-skills'

type Key = keyof EvaluationSkillRules
const KEYS: Key[] = ['maxPoints', 'cooldownDays']

export function EvaluationSkillRulesEditor() {
  const { t } = useI18n()
  const toast = useToast()
  const { evaluationSkillRules, updateEvaluationSkillRules, evaluationSkillsSupported, can } = useOhsumi()
  const canEdit = can('org.rules') && evaluationSkillsSupported
  const [draft, setDraft] = useState<Record<Key, string> | null>(null)
  const shown = draft ?? { maxPoints: String(evaluationSkillRules.maxPoints), cooldownDays: String(evaluationSkillRules.cooldownDays) }
  const parsed: EvaluationSkillRules = { maxPoints: Number(shown.maxPoints), cooldownDays: Number(shown.cooldownDays) }
  const valid = KEYS.every((k) => shown[k].trim() !== '') && validEvaluationSkillRules(parsed)
  const changed = parsed.maxPoints !== evaluationSkillRules.maxPoints || parsed.cooldownDays !== evaluationSkillRules.cooldownDays
  const save = () => {
    if (!valid || !changed) return
    updateEvaluationSkillRules(parsed)
    setDraft(null)
    toast(t('admin.evaluationSkills.saved'))
  }
  return (
    <div data-evaluation-skill-rules>
      <p className="text-xs text-muted-foreground">{t('admin.evaluationSkills.desc')}</p>
      {!evaluationSkillsSupported && <p className="mt-2 text-xs text-warning" data-evaluation-skill-rules-unsupported>{t('admin.evaluationSkills.unsupported')}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {KEYS.map((k) => (
          <label key={k} className="min-w-0 text-xs">
            <span className="block text-muted-foreground">{t(k === 'maxPoints' ? 'admin.evaluationSkills.maxPoints' : 'admin.evaluationSkills.cooldownDays')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={EVALUATION_SKILL_LIMITS[k].min}
              max={EVALUATION_SKILL_LIMITS[k].max}
              className="mt-1 h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm"
              value={shown[k]}
              disabled={!canEdit}
              data-evaluation-skill-rule={k}
              onChange={(e) => setDraft({ ...shown, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {!valid && <p className="mt-2 text-xs text-warning" data-evaluation-skill-rules-invalid>{t('admin.evaluationSkills.invalid')}</p>}
      {canEdit && (
        <Button size="sm" className="mt-3" disabled={!valid || !changed} onClick={save} data-evaluation-skill-rules-save data-gas-action="updateSetting">
          {t('common.save')}
        </Button>
      )}
      {evaluationSkillsSupported && <CapabilityNote cap="org.rules" className="mt-3" />}
    </div>
  )
}
