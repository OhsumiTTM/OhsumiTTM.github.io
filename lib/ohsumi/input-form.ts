// INPUT の「項目を入れて追加」: 最初から入力欄のある枠でタスクを書く。枠は文章から整理した時の確認の画面
// (ParsedTaskCard)と同じものを使い、ここでは空の枠・「＋ もう1件」の引き継ぎ・必須の確かめを決める
import type { ParsedTask, Project } from './types'
import { UNCATEGORIZED_DEPARTMENT } from './types'

// 枠の ID(画面の中だけで使う。登録の時に GAS が本当の ID を付ける)
const newId = () => `form-${Math.random().toString(36).slice(2, 9)}`

// 空の枠。必須はタスク名とプロジェクトだけで、どちらも空から始める
export function blankParsedTask(): ParsedTask {
  return {
    id: newId(),
    name: '',
    description: '',
    projectId: '',
    department: UNCATEGORIZED_DEPARTMENT,
    startDate: null,
    deadline: null,
    dueTime: null,
    category: '',
    skills: [],
    difficulty: 'beginner',
    priority: 'medium',
    assigneeIds: [],
    approved: true,
    visibility: 'all',
    importance: 'normal',
  }
}

// 「＋ もう1件」: 直前の枠のプロジェクト・領域・カテゴリを引き継いだ空の枠
export function nextParsedTask(previous: ParsedTask | undefined): ParsedTask {
  const blank = blankParsedTask()
  if (!previous) return blank
  return { ...blank, projectId: previous.projectId, department: previous.department, category: previous.category }
}

export type ParsedTaskProblem = 'name' | 'project'

// 登録できない理由(タスク名が空・プロジェクトが選ばれていないか、無いプロジェクト)
export function parsedTaskProblems(task: ParsedTask, projects: Pick<Project, 'id'>[]): ParsedTaskProblem[] {
  const out: ParsedTaskProblem[] = []
  if (!task.name.trim()) out.push('name')
  if (!task.projectId || !projects.some((p) => p.id === task.projectId)) out.push('project')
  return out
}

// 登録する枠(チェックの入った枠)に、足りない項目のある枠があるか
export function hasBlockingProblems(tasks: ParsedTask[], projects: Pick<Project, 'id'>[]): boolean {
  return tasks.some((t) => t.approved && parsedTaskProblems(t, projects).length > 0)
}

// 書きかけか(画面を離れる時に、消えることを確かめる)。空の枠が1つだけなら、まだ何も書いていない
export function isFormDirty(tasks: ParsedTask[]): boolean {
  if (tasks.length > 1) return true
  const t = tasks[0]
  if (!t) return false
  const blank = blankParsedTask()
  return (
    !!t.name.trim() ||
    !!(t.description ?? '').trim() ||
    !!t.projectId ||
    t.department !== blank.department ||
    !!t.category ||
    !!t.startDate ||
    !!t.deadline ||
    t.skills.length > 0 ||
    t.assigneeIds.length > 0 ||
    t.estimatedHours != null ||
    t.difficulty !== blank.difficulty ||
    t.priority !== blank.priority ||
    (t.visibility ?? 'all') !== 'all' ||
    (t.importance ?? 'normal') !== 'normal'
  )
}

// 入力履歴に残す文字(項目で入れた時は、登録したタスク名を1行ずつ)
export function formHistoryText(tasks: ParsedTask[]): string {
  return tasks.map((t) => t.name.trim()).join('\n')
}
