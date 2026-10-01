// 1つのセルの記録の長さ(gas/Code.gs の「1つのセルの長さ」)。画面に出す、記録の種類の名前
import type { TranslationKey } from './i18n'

const FIELD_KEYS: Record<string, TranslationKey> = {
  comments_json: 'cells.field.comments_json',
  history_json: 'cells.field.history_json',
  progress_history_json: 'cells.field.progress_history_json',
  one_on_ones_json: 'cells.field.one_on_ones_json',
  career_history_json: 'cells.field.career_history_json',
  evaluation_history_json: 'cells.field.evaluation_history_json',
  survey_responses_json: 'cells.field.survey_responses_json',
  training_history_json: 'cells.field.training_history_json',
  development_plan_json: 'cells.field.development_plan_json',
  transfer_history_json: 'cells.field.transfer_history_json',
  qualifications_json: 'cells.field.qualifications_json',
  description: 'cells.field.description',
  value: 'cells.field.value',
}

/** 記録の種類(シートの列)の名前。知らない列は、列の名前のまま */
export function cellFieldLabel(field: string, t: (key: TranslationKey) => string): string {
  const key = FIELD_KEYS[field]
  return key ? t(key) : field
}
