// ナレッジのページを、タスク・プロジェクトにつなぐ(v1.2。gas/src/43-wiki.gs の updateWikiLinks_・checkWikiPageIds_)。
// 付け外しできる人・見られないページの扱い(断る・残す)・上限・テンプレートから作る時の引き継ぎ
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
type Res = { ok: boolean; error?: string; result?: Record<string, unknown> }

const call = (h: H, who: string, action: string, body: Record<string, unknown> = {}) => h.post({ action, sessionToken: who, ...body }) as Res
const create = (h: H, title: string, audience: Record<string, unknown> = { kind: 'all' }) => {
  const res = call(h, 'm-top', 'proposeWikiEdit', { page: { title, folder: '', tags: [], body: '本文', audience } })
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return String(res.result!.pageId)
}
const cell = (h: H, sheet: string, id: string, col: string) => {
  const [head, ...rows] = h.sheets[sheet].rows
  const r = rows.find((x) => String(x[0]) === id)
  return r ? String(r[head.indexOf(col)] ?? '') : undefined
}
const setOwner = (h: H, projectId: string, memberId: string) => {
  const rows = h.sheets.Projects.rows
  if (!rows[0].includes('owner_id')) { rows[0].push('owner_id'); rows.slice(1).forEach((r) => r.push('')) }
  rows.find((r) => r[0] === projectId)![rows[0].indexOf('owner_id')] = memberId
}

describe('ナレッジ: タスクにページをつなぐ', () => {
  it('担当者はつなげる(列が無いシートには足す)。担当でない一般のメンバーは断られる', () => {
    const h = guardHarness()
    const a = create(h, '会計の手順')
    const res = call(h, 'm-base', 'updateTaskWikiPages', { taskId: 't1', pageIds: [a, a] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'wiki_page_ids')).toBe(a)
    expect(call(h, 'm-other', 'updateTaskWikiPages', { taskId: 't1', pageIds: [] }).ok).toBe(false)
    expect(cell(h, 'Tasks', 't1', 'wiki_page_ids')).toBe(a)
  })

  it('無いページ・見られないページ・11ページ以上は断る', () => {
    const h = guardHarness()
    const leaders = create(h, '幹部の手順', { kind: 'leaders' })
    expect(call(h, 'm-base', 'updateTaskWikiPages', { taskId: 't1', pageIds: ['no-such-page'] }).error).toMatch(/見る権限のない/)
    expect(call(h, 'm-base', 'updateTaskWikiPages', { taskId: 't1', pageIds: [leaders] }).error).toMatch(/見る権限のない/)
    const many = Array.from({ length: 11 }, (_, i) => create(h, 'ページ' + i))
    expect(call(h, 'm-top', 'updateTaskWikiPages', { taskId: 't1', pageIds: many }).error).toMatch(/10ページまで/)
    expect(call(h, 'm-base', 'updateTaskWikiPages', { taskId: 't1', pageIds: 'abc' }).ok).toBe(false)
  })

  it('見られないページのリンクは、その人が直しても残す', () => {
    const h = guardHarness()
    const open = create(h, 'みんなの手順')
    const leaders = create(h, '幹部の手順', { kind: 'leaders' })
    expect(call(h, 'm-top', 'updateTaskWikiPages', { taskId: 't1', pageIds: [open, leaders] }).ok).toBe(true)
    // 一般のメンバー(担当者)には、幹部の手順は見えない。見えるページを外しても、幹部の手順は残る
    const res = call(h, 'm-base', 'updateTaskWikiPages', { taskId: 't1', pageIds: [] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'wiki_page_ids')).toBe(leaders)
    // 見られる人は外せる
    expect(call(h, 'm-top', 'updateTaskWikiPages', { taskId: 't1', pageIds: [] }).ok).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'wiki_page_ids')).toBe('')
  })
})

describe('ナレッジ: プロジェクトにページをつなぐ', () => {
  it('責任者(一般の役職でも)と管理者はつなげる。ほかの一般のメンバーは断られる', () => {
    const h = guardHarness()
    setOwner(h, 'p1', 'm-other')
    const a = create(h, 'プロジェクトの進め方')
    expect(call(h, 'm-base', 'updateProjectWikiPages', { projectId: 'p1', pageIds: [a] }).ok).toBe(false)
    const byOwner = call(h, 'm-other', 'updateProjectWikiPages', { projectId: 'p1', pageIds: [a] })
    expect(byOwner.ok, JSON.stringify(byOwner)).toBe(true)
    expect(cell(h, 'Projects', 'p1', 'wiki_page_ids')).toBe(a)
    const byLead = call(h, 'm-lead', 'updateProjectWikiPages', { projectId: 'p1', pageIds: [] })
    expect(byLead.ok, JSON.stringify(byLead)).toBe(true)
    expect(cell(h, 'Projects', 'p1', 'wiki_page_ids')).toBe('')
  })

  it('プロジェクトを作る時にページを付けられる(見られないページは除く)', () => {
    const h = guardHarness()
    const a = create(h, '立ち上げの手順')
    const res = call(h, 'm-top', 'createProject', { name: '新しいプロジェクト', description: '', wikiPageIds: [a, 'gone'] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(cell(h, 'Projects', String(res.result!.id), 'wiki_page_ids')).toBe(a)
  })
})

describe('ナレッジ: テンプレートから作るタスクに引き継ぐ', () => {
  it('createTasks の wikiPageIds を書く。無い・見られないページは除き、作るのは止めない', () => {
    const h = guardHarness()
    const open = create(h, 'イベントの手順')
    const leaders = create(h, '幹部の手順', { kind: 'leaders' })
    const res = call(h, 'm-base', 'createTasks', { tasks: [{ tempId: 'x', title: 'テンプレートのタスク', projectId: 'p1', department: '', category: '', skills: [],
      difficulty: 'beginner', priority: 'medium', deadline: null, assigneeIds: [], pendingApproval: true, wikiPageIds: [open, leaders, 'gone'] }] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const [head, ...rows] = h.sheets.Tasks.rows
    const made = rows.find((r) => r[head.indexOf('title')] === 'テンプレートのタスク')!
    expect(String(made[head.indexOf('wiki_page_ids')])).toBe(open)
    const tooMany = Array.from({ length: 11 }, (_, i) => 'p' + i)
    expect(call(h, 'm-base', 'createTasks', { tasks: [{ tempId: 'y', title: 'x', projectId: 'p1', pendingApproval: true, wikiPageIds: tooMany }] }).ok).toBe(false)
  })
})
