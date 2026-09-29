// 移行の前(日本語)と後(コード)のシートの行が、画面で使うデータとして
// 完全に同じになること。同じシートの中で2つの形式が混ざっていても同じ
import { describe, expect, it } from 'vitest'
import { mapRemoteData, parseSettings } from './remote'

const TASK_BASE = { project_id: 'p1', assignee_id: 'm1', due_date: '2026-10-01', category: '企画' }

// 移行前の行と、移行の関数が作る行の組
const TASK_PAIRS: [Record<string, string>, Record<string, string>][] = [
  [
    { id: '1', title: 'A', status: '確認待ち', difficulty: '少し経験必要', priority: '高', importance: '対外公開', visibility: '幹部', approval_status: '承認待ち', department: 'デザイン' },
    { id: '1', title: 'A', status: 'review', difficulty: 'some_exp', priority: 'high', importance: 'external', visibility: 'leaders', approval_status: 'pending', department: 'design' },
  ],
  [
    { id: '2', title: 'B', status: '完了', difficulty: '', priority: '', importance: '', visibility: '全員', approval_status: '', department: '未分類' },
    { id: '2', title: 'B', status: 'done', difficulty: '', priority: '', importance: '', visibility: 'all', approval_status: '', department: '' },
  ],
  [
    { id: '3', title: 'C', status: '保留', difficulty: '上級者向け', priority: '低', importance: '一般', visibility: 'all', approval_status: '承認済み', department: '独自の部門',
      history_json: JSON.stringify([{ id: 'h1', at: '2026-09-01', byId: 'm1', field: 'status', from: '未着手', to: '進行中' },
        { id: 'h2', at: '2026-09-02', byId: 'm1', field: 'department', from: '未分類', to: '渉外' },
        { id: 'h3', at: '2026-09-03', byId: 'm1', field: 'title', from: '高', to: '低' }]),
      schedule_json: JSON.stringify({ candidates: [{ id: 'c1', label: '10/1' }], invitedIds: ['m1'], responses: { m1: { c1: '△' } } }) },
    { id: '3', title: 'C', status: 'hold', difficulty: 'advanced', priority: 'low', importance: 'normal', visibility: 'all', approval_status: 'approved', department: '独自の部門',
      history_json: JSON.stringify([{ id: 'h1', at: '2026-09-01', byId: 'm1', field: 'status', from: 'todo', to: 'progress' },
        { id: 'h2', at: '2026-09-02', byId: 'm1', field: 'department', from: '', to: 'relations' },
        { id: 'h3', at: '2026-09-03', byId: 'm1', field: 'title', from: '高', to: '低' }]),
      schedule_json: JSON.stringify({ candidates: [{ id: 'c1', label: '10/1' }], invitedIds: ['m1'], responses: { m1: { c1: 'maybe' } } }) },
  ],
]

const MEMBER_PAIR: [Record<string, string>, Record<string, string>] = [
  { id: 'm1', name: '一般さん', role: '一般', permission_overrides_json: JSON.stringify([{ targetType: 'department', targetId: '広報', access: 'edit' }, { targetType: 'task', targetId: '3', access: 'view' }]) },
  { id: 'm1', name: '一般さん', role: '一般', permission_overrides_json: JSON.stringify([{ targetType: 'department', targetId: 'pr', access: 'edit' }, { targetType: 'task', targetId: '3', access: 'view' }]) },
]

const withBase = (r: Record<string, string>) => ({ ...TASK_BASE, ...r })
const view = (members: Record<string, string>[], tasks: Record<string, string>[]) =>
  mapRemoteData(members, [{ id: 'p1', name: 'P' }], tasks.map(withBase))

describe('移行の前後で、画面のデータが変わらない', () => {
  it('タスク・メンバーの行', () => {
    const before = view([MEMBER_PAIR[0]], TASK_PAIRS.map(([oldRow]) => oldRow))
    const after = view([MEMBER_PAIR[1]], TASK_PAIRS.map(([, newRow]) => newRow))
    expect(after).toEqual(before)
    // 画面ではコードで持つ
    expect(before.tasks[0]).toMatchObject({ status: 'review', difficulty: 'some_exp', priority: 'high', importance: 'external', visibility: 'leaders', pendingApproval: true, department: 'design' })
    expect(before.tasks[1]).toMatchObject({ status: 'done', difficulty: 'beginner', priority: 'medium', importance: undefined, visibility: 'all', pendingApproval: false, department: '' })
    expect(before.members[0].permissionOverrides?.[0]).toEqual({ targetType: 'department', targetId: 'pr', access: 'edit' })
  })

  it('同じシートの中で2つの形式が混ざっていても同じ', () => {
    const before = view([MEMBER_PAIR[0]], TASK_PAIRS.map(([oldRow]) => oldRow))
    const mixed = view([MEMBER_PAIR[1]], TASK_PAIRS.map(([oldRow, newRow], i) => (i % 2 ? oldRow : newRow)))
    expect(mixed).toEqual(before)
  })

  it('Settings のテンプレート・定期タスク・スキルの閾値', () => {
    const settings = (department: string, difficulty: string, priority: string, trigger: string, defaultKey: string) => parseSettings([
      { key: 'project_templates', value: JSON.stringify({ T: [{ id: 'a', name: 'x', department, category: 'c', skills: [], difficulty, priority }] }) },
      { key: 'task_set_templates', value: JSON.stringify([{ id: 's', name: 'S', items: [{ id: 'i', name: 'y', department, category: 'c', skills: [], difficulty, priority }] }]) },
      { key: 'recurring_rules', value: JSON.stringify([{ id: 'r', name: 'z', projectId: 'p1', department, category: 'c', skills: [], difficulty, priority, frequency: 'weekly', active: true, triggerOnStatus: trigger }]) },
      { key: 'skill_level_thresholds', value: JSON.stringify({ [defaultKey]: 120, デザイン: 150 }) },
    ])
    const before = settings('イベント', '新人歓迎', '高', '完了', 'デフォルト')
    const after = settings('event', 'beginner', 'high', 'done', '_default')
    expect(after).toEqual(before)
    expect(before.projectTemplates.T[0]).toMatchObject({ department: 'event', difficulty: 'beginner', priority: 'high' })
    expect(before.recurringRules[0].triggerOnStatus).toBe('done')
    expect(before.skillLevelThresholds).toEqual({ _default: 120, デザイン: 150 })
  })
})
