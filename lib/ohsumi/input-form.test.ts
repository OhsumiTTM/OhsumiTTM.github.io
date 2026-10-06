import { describe, expect, it } from 'vitest'
import { blankParsedTask, formHistoryText, hasBlockingProblems, isFormDirty, nextParsedTask, parsedTaskProblems } from './input-form'
import { toCreatePayload } from './remote'

const projects = [{ id: 'p1' }, { id: 'p2' }]

describe('INPUT の「項目を入れて追加」', () => {
  it('空の枠: タスク名とプロジェクトが空で、ほかは登録できる既定', () => {
    const t = blankParsedTask()
    expect(t).toMatchObject({ name: '', description: '', projectId: '', approved: true, skills: [], assigneeIds: [], priority: 'medium', importance: 'normal', visibility: 'all' })
    expect(parsedTaskProblems(t, projects)).toEqual(['name', 'project'])
    expect(blankParsedTask().id).not.toBe(t.id)
  })

  it('「＋ もう1件」: 直前の枠のプロジェクト・領域・カテゴリだけを引き継ぐ', () => {
    const prev = { ...blankParsedTask(), name: '前のタスク', description: '説明', projectId: 'p2', department: 'pr', category: '告知', skills: ['SNS'], assigneeIds: ['m1'], deadline: '2026-10-10' }
    const next = nextParsedTask(prev)
    expect(next).toMatchObject({ projectId: 'p2', department: 'pr', category: '告知', name: '', description: '', skills: [], assigneeIds: [], deadline: null })
    expect(next.id).not.toBe(prev.id)
    expect(nextParsedTask(undefined).projectId).toBe('')
  })

  it('必須: タスク名(空白だけは空)とプロジェクト(無いプロジェクトも足りない)', () => {
    const ok = { ...blankParsedTask(), name: '受付の準備', projectId: 'p1' }
    expect(parsedTaskProblems(ok, projects)).toEqual([])
    expect(parsedTaskProblems({ ...ok, name: '   ' }, projects)).toEqual(['name'])
    expect(parsedTaskProblems({ ...ok, projectId: 'gone' }, projects)).toEqual(['project'])
  })

  it('登録のボタンは、チェックの入った枠に足りない項目がある時だけ止める', () => {
    const ok = { ...blankParsedTask(), name: 'A', projectId: 'p1' }
    const bad = blankParsedTask()
    expect(hasBlockingProblems([ok], projects)).toBe(false)
    expect(hasBlockingProblems([ok, bad], projects)).toBe(true)
    expect(hasBlockingProblems([ok, { ...bad, approved: false }], projects)).toBe(false)
  })

  it('書きかけの判定: 空の枠1つだけなら書きかけではない。何か入れた・枠を足したら書きかけ', () => {
    expect(isFormDirty([])).toBe(false)
    expect(isFormDirty([blankParsedTask()])).toBe(false)
    expect(isFormDirty([{ ...blankParsedTask(), name: 'x' }])).toBe(true)
    expect(isFormDirty([{ ...blankParsedTask(), description: '説明' }])).toBe(true)
    expect(isFormDirty([{ ...blankParsedTask(), projectId: 'p1' }])).toBe(true)
    expect(isFormDirty([{ ...blankParsedTask(), priority: 'high' }])).toBe(true)
    expect(isFormDirty([blankParsedTask(), blankParsedTask()])).toBe(true)
  })

  it('入力履歴の文字は、登録したタスク名を1行ずつ', () => {
    expect(formHistoryText([{ ...blankParsedTask(), name: ' A ' }, { ...blankParsedTask(), name: 'B' }])).toBe('A\nB')
  })
})

describe('詳細(説明)を GAS に送る', () => {
  it('toCreatePayload は詳細を送る(無ければ空文字。承認待ちのまま)', () => {
    const t = { ...blankParsedTask(), name: 'A', projectId: 'p1', description: '背景と完了の条件' }
    expect(toCreatePayload('tmp', t)).toMatchObject({ title: 'A', description: '背景と完了の条件', pendingApproval: true })
    const { description: _omit, ...noDescription } = t
    expect(toCreatePayload('tmp', noDescription).description).toBe('')
  })
})
