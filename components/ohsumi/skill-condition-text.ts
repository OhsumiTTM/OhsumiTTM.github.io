// スキルのレベルの条件の表示(lib/ohsumi/skill-levels.ts の LevelCondition)
import type { LevelCondition } from '@/lib/ohsumi/skill-levels'
import type { TranslationKey } from '@/lib/ohsumi/i18n'

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string

export function conditionText(c: LevelCondition, t: T): string {
  if (c.type === 'quiz') return t('skillLevels.cond.quiz')
  if (c.type === 'approval') return t('skillLevels.cond.approval')
  if (c.type === 'tasksDone') return t('skillLevels.cond.tasksDone', { min: c.min })
  return t(c.external ? 'skillLevels.cond.qualificationExternal' : 'skillLevels.cond.qualification', { min: c.min })
}
