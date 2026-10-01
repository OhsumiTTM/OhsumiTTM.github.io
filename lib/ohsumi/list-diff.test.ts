// 記録の一覧の差分(list-diff.ts)と、画面が覚える行の版・一覧(sync-state.ts)
import { describe, expect, it } from 'vitest'
import { canonicalJson, diffList } from './list-diff'
import { baseVersionsFor, listOpsFor, rememberServerRows } from './sync-state'

describe('diffList', () => {
  const a = { id: 'a', text: 'A' }
  const b = { id: 'b', text: 'B' }
  it('足す・変える・消すを、キーで見分ける(足す項目は次の一覧の順番)', () => {
    const c = { id: 'c', text: 'C' }
    expect(diffList([a, b], [{ id: 'a', text: 'A2' }, c], 'id')).toEqual([
      { op: 'update', key: 'a', before: a, entry: { id: 'a', text: 'A2' } },
      { op: 'add', entry: c },
      { op: 'remove', key: 'b', before: b },
    ])
  })
  it('キーの順番・undefined の違いは、変更に数えない', () => {
    expect(diffList([{ text: 'A', id: 'a' }], [{ id: 'a', text: 'A', note: undefined }], 'id')).toEqual([])
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}')
  })
  it('スキルはスキルの名前で見分ける', () => {
    expect(diffList([{ skill: 'x', level: 1 }], [{ skill: 'x', level: 2 }], 'skill')).toEqual([
      { op: 'update', key: 'x', before: { skill: 'x', level: 1 }, entry: { skill: 'x', level: 2 } },
    ])
  })
})

describe('sync-state', () => {
  it('読み込んだ行の版を、書き込みに付ける(知らない行には付けない)', () => {
    rememberServerRows({ Tasks: [{ id: 't1', row_version: 'r1' }], Members: [{ id: 'm1', row_version: 'r9' }] })
    expect(baseVersionsFor({ taskId: 't1', memberId: 'm1' })).toEqual({ 'Tasks:t1': 'r1', 'Members:m1': 'r9' })
    expect(baseVersionsFor({ taskId: 'unknown' })).toBeUndefined()
  })

  it('一覧は、読み込んだ一覧との差分で送り、送った一覧を次の基準にする。失敗したら基準を戻す', () => {
    const old = { id: 'c-old', byId: 'm2', text: '前から' }
    rememberServerRows({ Tasks: [{ id: 't1', comments_json: JSON.stringify([old]) }] })
    const mine = { id: 'c-new', byId: 'm1', text: '新しい' }
    const first = listOpsFor('updateComments', 't1', [old, mine])
    expect(first.listOps).toEqual([{ op: 'add', entry: mine }])
    // 続けて消した時は、前の保存を基準にする
    expect(listOpsFor('updateComments', 't1', [old]).listOps).toEqual([{ op: 'remove', key: 'c-new', before: mine }])
    const third = listOpsFor('updateComments', 't1', [])
    third.restore()
    expect(listOpsFor('updateComments', 't1', [old]).listOps).toEqual([])
  })

  it('変更の記録(足すだけの一覧)は、足す差分だけを送る', () => {
    const h1 = { id: 'h1', field: 'status', from: '未着手', to: '完了' }
    rememberServerRows({ Tasks: [{ id: 't1', history_json: JSON.stringify([h1]) }] })
    const h2 = { id: 'h2', field: 'status', from: 'done', to: 'todo' }
    expect(listOpsFor('updateHistory', 't1', [h2, { ...h1, from: 'todo', to: 'done' }]).listOps).toEqual([{ op: 'add', entry: h2 }])
  })
})
