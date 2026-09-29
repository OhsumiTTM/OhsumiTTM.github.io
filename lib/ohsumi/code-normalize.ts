// シートから読んだ値(移行前の日本語・移行後のコードのどちらでも)を、画面で
// 使う内部コードにそろえる。表は codes.ts。GAS 側の同じ処理は
// gas/Code.gs の normalizeCode / normalizeHistoryEntry など
import { normalizeCode, normalizeThresholdKeys, type CodeKind } from './codes'
import type {
  ProjectTemplateTask,
  RecurringTaskRule,
  PermissionOverride,
  TaskHistoryEntry,
  TaskSchedule,
  TaskSetTemplate,
} from './types'

// 変更の記録(history_json)のうち、値がコードになる項目
export const HISTORY_CODE_FIELDS: Partial<Record<TaskHistoryEntry['field'], CodeKind>> = {
  status: 'status',
  priority: 'priority',
  difficulty: 'difficulty',
  visibility: 'visibility',
  importance: 'importance',
  department: 'department',
}

export function normalizeHistoryEntry(h: TaskHistoryEntry): TaskHistoryEntry {
  const kind = h?.field ? HISTORY_CODE_FIELDS[h.field] : undefined
  if (!kind) return h
  return { ...h, from: normalizeCode(kind, h.from), to: normalizeCode(kind, h.to) }
}

export function normalizeSchedule(schedule: TaskSchedule | undefined): TaskSchedule | undefined {
  if (!schedule?.responses) return schedule
  const responses: TaskSchedule['responses'] = {}
  for (const [memberId, answers] of Object.entries(schedule.responses)) {
    const out: Record<string, TaskSchedule['responses'][string][string]> = {}
    for (const [candidateId, answer] of Object.entries(answers ?? {})) {
      out[candidateId] = normalizeCode('scheduleAnswer', answer)
    }
    responses[memberId] = out
  }
  return { ...schedule, responses }
}

type WithTaskCodes = { department: string; difficulty: string; priority: string }

function normalizeTaskCodes<T extends WithTaskCodes>(item: T): T {
  return {
    ...item,
    department: normalizeCode('department', item.department),
    difficulty: normalizeCode('difficulty', item.difficulty || 'beginner'),
    priority: normalizeCode('priority', item.priority || 'medium'),
  }
}

export function normalizeProjectTemplates(
  templates: Record<string, ProjectTemplateTask[]>,
): Record<string, ProjectTemplateTask[]> {
  const out: Record<string, ProjectTemplateTask[]> = {}
  for (const [name, items] of Object.entries(templates ?? {})) {
    out[name] = Array.isArray(items) ? items.map(normalizeTaskCodes) : items
  }
  return out
}

export function normalizeTaskSetTemplates(templates: TaskSetTemplate[]): TaskSetTemplate[] {
  return (Array.isArray(templates) ? templates : []).map((tpl) => ({
    ...tpl,
    items: Array.isArray(tpl?.items) ? tpl.items.map(normalizeTaskCodes) : tpl?.items,
  }))
}

export function normalizeRecurringRules(rules: RecurringTaskRule[]): RecurringTaskRule[] {
  return (Array.isArray(rules) ? rules : []).map((rule) => ({
    ...normalizeTaskCodes(rule),
    triggerOnStatus: rule.triggerOnStatus ? normalizeCode('status', rule.triggerOnStatus) : undefined,
  }))
}

// 権限の例外のうち、部門を対象にしたものの対象(以前は部門名)を部門IDにそろえる
export function normalizePermissionOverride(ov: PermissionOverride): PermissionOverride {
  if (ov?.targetType !== 'department') return ov
  return { ...ov, targetId: normalizeCode('department', ov.targetId) }
}

export { normalizeThresholdKeys }
