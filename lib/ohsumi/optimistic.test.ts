// 楽観的な更新の取り消し(lib/ohsumi/optimistic.ts): 保存に失敗した時に、その操作で変えた項目と
// 足した変更の記録だけを元に戻すこと。待っている間に同じ項目をさらに変えていたら戻さないこと
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { revertTaskChange } from './optimistic'
import type { Task, TaskHistoryEntry } from './types'

const h = (id: string, field: TaskHistoryEntry['field']): TaskHistoryEntry => ({ id, at: '2026-10-01', byId: 'm1', field, from: '', to: 'x' })

const base = {
  id: 't1',
  name: 'タスク',
  projectId: 'p1',
  department: 'd1',
  assigneeIds: [],
  deadline: '2026-10-05',
  startDate: '2026-10-01',
  category: '',
  skills: [],
  difficulty: 'anyone',
  priority: 'medium',
  status: 'todo',
  lastActivity: '2026-10-01',
  history: [h('old', 'priority')],
} as unknown as Task

describe('保存に失敗した時の取り消し', () => {
  it('日程と、その操作で足した変更の記録だけを元に戻す', () => {
    const before = base
    const after: Task = { ...base, startDate: '2026-10-02', deadline: '2026-10-10', history: [h('n2', 'startDate'), h('n1', 'deadline'), ...base.history!] }
    const other: Task = { ...base, id: 't2' }
    // 待っている間に、ほかの項目(優先度)とほかのタスクは変わった
    const now = [{ ...after, priority: 'high' } as Task, other]
    const out = revertTaskChange(now, 't1', before, after, ['startDate', 'deadline'])
    expect(out[0]).toMatchObject({ startDate: '2026-10-01', deadline: '2026-10-05', priority: 'high' })
    expect(out[0].history!.map((x) => x.id)).toEqual(['old'])
    expect(out[1]).toBe(other)
  })

  it('待っている間に同じ項目をさらに変えていたら、新しい変更を消さない', () => {
    const after: Task = { ...base, deadline: '2026-10-10' }
    const newer = [{ ...after, deadline: '2026-10-20' } as Task]
    expect(revertTaskChange(newer, 't1', base, after, ['deadline'])).toEqual(newer)
  })

  it('配列の項目(確認者など)は中身で比べる', () => {
    const before = { ...base, reviewerIds: ['a'] } as Task
    const after = { ...base, reviewerIds: ['a', 'b'] } as Task
    const now = [{ ...after, reviewerIds: ['a', 'b'] } as Task]
    expect(revertTaskChange(now, 't1', before, after, ['reviewerIds'])[0].reviewerIds).toEqual(['a'])
  })

  it('変える前・後が分からない時(タスクが消えていた)は、何もしない', () => {
    const now = [base]
    expect(revertTaskChange(now, 't1', undefined, undefined, ['deadline'])).toBe(now)
  })

  it('日程・優先度・難易度・詳細・前提タスク・確認者の変更は、失敗した時に元に戻す(store.tsx)', () => {
    const store = readFileSync(join(__dirname, 'store.tsx'), 'utf8')
    for (const name of ['updateSchedule', 'updatePriority', 'updateDifficulty', 'updateTaskDetails', 'updateDependsOn', 'updateReviewer', 'updateReviewers']) {
      const start = store.indexOf(`const ${name} = useCallback(`)
      expect(start, name).toBeGreaterThan(0)
      const body = store.slice(start, store.indexOf('\n  )\n', start))
      expect(body, name).toContain('changeTaskOptimistically(')
      expect(body, name).not.toMatch(/runRemote\(remoteApi\./)
    }
  })
})
