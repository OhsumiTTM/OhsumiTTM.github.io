// 幹部の取り込み(createTasks の import: true): 状態・確認者・必要な承認数・想定/実績の時間・成果物・前提タスク・公募かどうか・
// 保留の理由を受け付ける。承認待ちにしない。完了として取り込んだタスクには、スキルの点数を付けない
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const base = { projectId: 'p1', department: 'ops', category: '', skills: ['デザイン'], difficulty: 'anyone', priority: 'medium', deadline: null }
const tasks = (h: H) => {
  const [head, ...rows] = h.sheets.Tasks.rows
  return rows.map((r) => Object.fromEntries(head.map((k, i) => [String(k), r[i]])))
}
const withColumns = (h: H) => {
  const rows = h.sheets.Tasks.rows
  for (const c of ['reviewer_id', 'required_approvals', 'assign_type', 'completed_date', 'awarded_points_json', 'approval_status']) {
    if (!rows[0].includes(c)) { rows[0].push(c); rows.slice(1).forEach((r) => r.push('')) }
  }
  return h
}

describe('幹部の取り込み', () => {
  it('状態・確認者・承認数・時間・成果物・前提タスク・公募・保留の理由を入れ、承認待ちにしない', () => {
    const h = withColumns(guardHarness())
    const res = h.post({ action: 'createTasks', sessionToken: 'm-top', tasks: [
      { ...base, tempId: 'a', title: '取り込みA', import: true, status: '完了', completedDate: '2026-09-01', assigneeIds: ['m-base'],
        reviewerIds: ['m-lead', 'm-top'], requiredApprovals: 'all', estimatedHours: 3, actualHours: 4.5,
        deliverables: [{ label: '資料', url: 'https://example.com/a' }], openBid: false },
      { ...base, tempId: 'b', title: '取り込みB', import: true, status: 'hold', holdReason: '予算待ち', dependsOnTempIds: ['a'], requiredApprovals: 1, reviewerIds: ['m-lead'] },
    ] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const [a, b] = res.result as { id: string }[]
    const ta = tasks(h).find((t) => t.id === a.id)!
    const tb = tasks(h).find((t) => t.id === b.id)!
    expect(ta).toMatchObject({ status: '完了', completed_date: '2026-09-01', reviewer_ids: 'm-lead,m-top', reviewer_id: 'm-lead', required_approvals: 'all',
      estimated_hours: 3, actual_hours: 4.5, assign_type: 'manager_assign', approval_status: '承認済み', creator_id: 'm-top' })
    expect(JSON.parse(String(ta.deliverables_json))).toEqual([{ id: `d-${a.id}-1`, label: '資料', url: 'https://example.com/a' }])
    expect(tb).toMatchObject({ status: '保留', hold_reason_note: '予算待ち', depends_on_ids: a.id, required_approvals: '1', approval_status: '承認済み', assign_type: 'open_bid' })
    // 完了として取り込んだタスクには、スキルの点数を付けない
    const award = h.post({ action: 'awardSkillPoints', sessionToken: 'm-top', taskId: a.id, memberId: 'm-base', points: { 'デザイン': 10 } })
    expect(award.ok).toBe(false)
    expect(award.error).toContain('取り込んだ')
    // 承認待ちの通知を送らない
    expect(h.allSent().filter((s) => s.text.includes('取り込み'))).toEqual([])
  })

  it('おかしな値が1つでもあれば、何も作らない', () => {
    const bad: Record<string, unknown>[] = [
      { status: 'unknown' },
      { reviewerIds: ['m-nobody'] },
      { reviewerIds: ['m-lead'], requiredApprovals: 2 },
      { requiredApprovals: 1 },
      { actualHours: -1 },
      { deliverables: [{ label: 'x', url: 'javascript:alert(1)' }] },
      { dependsOnTempIds: ['other-import'] },
      { dependsOnTempIds: ['self'] },
      { holdReason: '保留ではない' },
    ]
    for (const extra of bad) {
      const h = withColumns(guardHarness())
      const before = h.sheets.Tasks.rows.length
      const res = h.post({ action: 'createTasks', sessionToken: 'm-top', tasks: [
        { ...base, tempId: 'ok', title: '正しい', import: true },
        { ...base, tempId: 'self', title: 'おかしい', import: true, ...extra },
      ] })
      expect(res.ok, JSON.stringify(extra)).toBe(false)
      expect(h.sheets.Tasks.rows.length, JSON.stringify(extra)).toBe(before)
    }
  })

  it('一般のメンバーは取り込めない。取り込みでない作成は、これまでどおり', () => {
    const h = withColumns(guardHarness())
    const res = h.post({ action: 'createTasks', sessionToken: 'm-base', tasks: [{ ...base, tempId: 'x', title: '一般の取り込み', import: true, status: 'done' }] })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('幹部だけ')
    const plain = h.post({ action: 'createTasks', sessionToken: 'm-base', tasks: [{ ...base, tempId: 'y', title: '普通の作成', status: 'done', reviewerIds: ['m-lead'] }] })
    expect(plain.ok, JSON.stringify(plain)).toBe(true)
    const row = tasks(h).find((t) => t.title === '普通の作成')!
    expect(row).toMatchObject({ status: '未着手', approval_status: '承認待ち', reviewer_ids: '' })
  })
})
