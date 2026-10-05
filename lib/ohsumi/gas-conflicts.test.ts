// 書き込みの競合チェック(PR J)
//   - 行の版: 画面が開いた時の版(baseVersions)と今の版が違い、最後に変えたのが自分でない時は、上書きせずに断る(conflict)
//   - 記録の一覧(コメント・1on1 など)は、項目ごとの差分(listOps)で受け取る。差分に無い項目は、管理者の操作でも消さない
//   - 一覧を丸ごと送る古い画面からの保存は断り、読み込み直してもらう
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, type Cell } from './gas-guard-harness'
import { LIST_ACTIONS } from './list-diff'

type H = ReturnType<typeof guardHarness>
const json = (h: H, sheet: string, id: string, col: string) => {
  const rows = h.sheets[sheet].rows
  const head = rows[0].map(String)
  return JSON.parse(String(rows.find((r) => r[0] === id)![head.indexOf(col)] || '[]'))
}
const cell = (h: H, sheet: string, id: string, col: string) => {
  const rows = h.sheets[sheet].rows
  return rows.find((r) => r[0] === id)![rows[0].map(String).indexOf(col)]
}
// 版の列を足した Tasks・Members(setupOhsumi の後の形)
function withVersions(h: H) {
  for (const name of ['Tasks', 'Members']) {
    const rows = h.sheets[name].rows
    rows[0].push('row_version', 'row_updated_by')
    rows.slice(1).forEach((r: Cell[]) => r.push('r0', ''))
  }
  // 1on1 の記録の列
  const m = h.sheets.Members.rows
  m[0].push('one_on_ones_json')
  m.slice(1).forEach((r: Cell[]) => r.push('[]'))
  return h
}
let n = 0
const rid = () => 'req-conflict-' + ++n

describe('行の版', () => {
  it('開いた時の版のまま保存すれば通り、版が新しくなる', () => {
    const h = withVersions(guardHarness())
    const res = h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', baseVersions: { 'Tasks:t1': 'r0' }, requestId: rid() })
    expect(res.ok, res.error).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'row_version')).not.toBe('r0')
    expect(cell(h, 'Tasks', 't1', 'row_updated_by')).toBe('m-lead')
  })

  it('ほかの人が先に変えていたら、上書きせずに conflict で断る', () => {
    const h = withVersions(guardHarness())
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-top', taskId: 't1', priority: 'low', baseVersions: { 'Tasks:t1': 'r0' }, requestId: rid() }).ok).toBe(true)
    const res = h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', baseVersions: { 'Tasks:t1': 'r0' }, requestId: rid() })
    expect(res).toMatchObject({ ok: false, conflict: { sheet: 'Tasks', id: 't1' } })
    expect(res.error).toContain('ほかの人が先に')
    expect(cell(h, 'Tasks', 't1', 'priority')).not.toBe('高')
  })

  it('自分が続けて保存した時(版を変えたのが自分)は通す', () => {
    const h = withVersions(guardHarness())
    const base = { sessionToken: 'm-lead', taskId: 't1', baseVersions: { 'Tasks:t1': 'r0' } }
    expect(h.post({ action: 'updatePriority', priority: 'low', ...base, requestId: rid() }).ok).toBe(true)
    expect(h.post({ action: 'updatePriority', priority: 'high', ...base, requestId: rid() }).ok).toBe(true)
  })

  it('記録の列だけの書き込み(コメントなど)は版を変えず、ほかの人の内容の保存を断らない', () => {
    const h = withVersions(guardHarness())
    expect(h.post({ action: 'updateComments', sessionToken: 'm-other', taskId: 't1', listOps: [{ op: 'add', entry: { id: 'c-n', byId: 'm-other', text: 'こんにちは', at: '2026-10-01' } }], requestId: rid() }).ok).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'row_version')).toBe('r0')
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', baseVersions: { 'Tasks:t1': 'r0' }, requestId: rid() }).ok).toBe(true)
  })

  it('まとめて送った時(batch)も、操作ごとの版で確かめる', () => {
    const h = withVersions(guardHarness())
    h.post({ action: 'updatePriority', sessionToken: 'm-top', taskId: 't1', priority: 'low', requestId: rid() })
    const res = h.post({ action: 'batch', sessionToken: 'm-lead', requestId: rid(), ops: [
      { action: 'updatePriority', taskId: 't1', priority: 'high', baseVersions: { 'Tasks:t1': 'r0' } },
    ] })
    expect(res.result.results[0]).toMatchObject({ ok: false, conflict: { id: 't1' } })
  })
})

describe('記録の一覧の差分(listOps)', () => {
  const comment = (id: string, byId: string, text: string) => ({ id, byId, text, at: '2026-10-01' })

  it('ほかの人が後から足したコメントは、管理者の保存でも消えない', () => {
    const h = withVersions(guardHarness())
    // 代表の画面は、前からのコメントだけを知っている。その間に、ほかの人がコメントを足した
    expect(h.post({ action: 'updateComments', sessionToken: 'm-other', taskId: 't1', listOps: [{ op: 'add', entry: comment('c-other', 'm-other', '後から') }], requestId: rid() }).ok).toBe(true)
    const res = h.post({ action: 'updateComments', sessionToken: 'm-top', taskId: 't1', listOps: [{ op: 'add', entry: comment('c-top', 'm-top', '代表') }], requestId: rid() })
    expect(res.ok, res.error).toBe(true)
    expect(json(h, 'Tasks', 't1', 'comments_json').map((c: { id: string }) => c.id)).toEqual(['c-old', 'c-other', 'c-top'])
  })

  it('変える・消す時に、ほかの人が先に変えていたら conflict で断る(シートは変えない)', () => {
    const h = withVersions(guardHarness())
    const old = json(h, 'Tasks', 't1', 'comments_json')[0]
    expect(h.post({ action: 'updateComments', sessionToken: 'm-lead', taskId: 't1', listOps: [{ op: 'update', key: 'c-old', before: old, entry: { ...old, text: '班長が直した' } }], requestId: rid() }).ok).toBe(true)
    const before = JSON.stringify(h.sheets.Tasks.rows)
    const res = h.post({ action: 'updateComments', sessionToken: 'm-top', taskId: 't1', listOps: [{ op: 'remove', key: 'c-old', before: old }], requestId: rid() })
    expect(res).toMatchObject({ ok: false, conflict: { sheet: 'Tasks', id: 't1' } })
    expect(JSON.stringify(h.sheets.Tasks.rows)).toBe(before)
  })

  it('既に消えている項目を消す差分は、何もせずに通す(同じ操作の送り直しなど)', () => {
    const h = withVersions(guardHarness())
    const old = json(h, 'Tasks', 't1', 'comments_json')[0]
    const op = { action: 'updateComments', sessionToken: 'm-lead', taskId: 't1', listOps: [{ op: 'remove', key: 'c-old', before: old }] }
    expect(h.post({ ...op, requestId: rid() }).ok).toBe(true)
    expect(h.post({ ...op, requestId: rid() }).ok).toBe(true)
    expect(json(h, 'Tasks', 't1', 'comments_json')).toEqual([])
  })

  it('一般のメンバーは、差分でもほかの人のコメントを消せない', () => {
    const h = withVersions(guardHarness())
    const old = json(h, 'Tasks', 't1', 'comments_json')[0]
    const res = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'remove', key: 'c-old', before: old }], requestId: rid() })
    expect(res.ok).toBe(false)
    expect(json(h, 'Tasks', 't1', 'comments_json')).toHaveLength(1)
  })

  it('メンバーの記録(1on1)も、項目ごとに当てる', () => {
    const h = withVersions(guardHarness())
    const a = { id: 'o1', date: '2026-09-01', note: 'A' }
    const b = { id: 'o2', date: '2026-09-15', note: 'B' }
    expect(h.post({ action: 'updateOneOnOnes', sessionToken: 'm-lead', memberId: 'm-base', listOps: [{ op: 'add', entry: a }], requestId: rid() }).ok).toBe(true)
    expect(h.post({ action: 'updateOneOnOnes', sessionToken: 'm-top', memberId: 'm-base', listOps: [{ op: 'add', entry: b }], requestId: rid() }).ok).toBe(true)
    // 相手(行った人)は、記録を足した本人になる
    expect(json(h, 'Members', 'm-base', 'one_on_ones_json')).toEqual([{ ...a, withId: 'm-lead' }, { ...b, withId: 'm-top' }])
  })

  it('一覧を丸ごと送る古い画面からの保存は、読み込み直してもらう', () => {
    const h = withVersions(guardHarness())
    const res = h.postRaw({ action: 'updateComments', sessionToken: 'm-top', taskId: 't1', comments: [], requestId: rid() })
    expect(res).toMatchObject({ ok: false, reloadRequired: true })
    expect(json(h, 'Tasks', 't1', 'comments_json')).toHaveLength(1)
  })

  it('記録の一覧の操作は、GAS と画面(list-diff.ts)で同じ', () => {
    const block = CODE_GS.slice(CODE_GS.indexOf('var LIST_ACTIONS = {'), CODE_GS.indexOf('\n}\n', CODE_GS.indexOf('var LIST_ACTIONS = {')) + 2)
    const gas = new Function(block + '; return LIST_ACTIONS')() as typeof LIST_ACTIONS
    expect(gas).toEqual(LIST_ACTIONS)
  })
})

describe('守る処理を外すと失敗する', () => {
  const mutated = (from: string, to: string) => {
    const code = CODE_GS.replace(from, to)
    expect(code, from).not.toBe(CODE_GS)
    return code
  }

  it('行の版の確かめを外すと、ほかの人の変更を上書きする', () => {
    const h = withVersions(guardHarness({ code: mutated('if (current !== expected && lastBy !== actor) throw conflictError_(sheetName, rowId)', '') }))
    h.post({ action: 'updatePriority', sessionToken: 'm-top', taskId: 't1', priority: 'low', requestId: rid() })
    expect(h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', baseVersions: { 'Tasks:t1': 'r0' }, requestId: rid() }).ok).toBe(true)
  })

  it('古い画面の保存を断るのを外すと、管理者が一覧を丸ごと書き換えてほかの人のコメントを消す', () => {
    const h = withVersions(guardHarness({ code: mutated('    if (listOpsList.some(legacyListWrite_)) {', '    if (false) {') }))
    expect(h.postRaw({ action: 'updateComments', sessionToken: 'm-top', taskId: 't1', comments: [], requestId: rid() }).ok).toBe(true)
    expect(json(h, 'Tasks', 't1', 'comments_json')).toEqual([])
  })

  it('ロックの後の当て直しで競合を確かめないと、ほかの人が先に直したコメントとぶつかっても知らせない', () => {
    const h = withVersions(guardHarness({ code: mutated("    expandListOps_(body, true)\n", "    expandListOps_(body, false)\n") }))
    const old = json(h, 'Tasks', 't1', 'comments_json')[0]
    h.post({ action: 'updateComments', sessionToken: 'm-lead', taskId: 't1', listOps: [{ op: 'update', key: 'c-old', before: old, entry: { ...old, text: '直した' } }], requestId: rid() })
    const res = h.post({ action: 'updateComments', sessionToken: 'm-top', taskId: 't1', listOps: [{ op: 'remove', key: 'c-old', before: old }], requestId: rid() })
    expect(res.conflict).toBeUndefined()
  })
})
