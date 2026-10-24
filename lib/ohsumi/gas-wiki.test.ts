// ナレッジのページ(v1.2。gas/src/43-wiki.gs): 見られる人なら誰でも作成・変更を提案でき、ナレッジの管理の権限を持つ人が承認すると反映する
// (管理の権限を持つ人が直すとすぐ反映)。提案の後に直されていたら承認を断る。ページごとの公開範囲・前の版・検索・画像の閲覧
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
type Res = { ok: boolean; error?: string; result?: Record<string, unknown> & { [k: string]: unknown } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const call = (h: H, who: string, action: string, body: Record<string, unknown> = {}) => h.post({ action, sessionToken: who, ...body }) as Res
const page = (over: Record<string, unknown> = {}) => ({ title: '会計の手順', folder: '手順書 > 会計', tags: ['会計', '月末'], body: '# 会計\n\n月末に締める。', audience: { kind: 'all' }, ...over })
const propose = (h: H, who: string, over: Record<string, unknown> = {}) => call(h, who, 'proposeWikiEdit', { page: page(over) })
const list = (h: H, who: string) => call(h, who, 'listWikiPages').result as Any
const setup = () => {
  const h = guardHarness()
  const rows = h.sheets.Members.rows
  if (!rows[0].includes('department_path')) { rows[0].push('department_path'); rows.slice(1).forEach((r) => r.push('')) }
  rows.find((r) => r[0] === 'm-victim')![rows[0].indexOf('department_path')] = '本部>開発'
  return h
}
// 代表が直接作る(すぐ反映)
const create = (h: H, over: Record<string, unknown> = {}) => {
  const res = propose(h, 'm-top', over)
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return String(res.result!.pageId)
}

describe('ナレッジ: 提案と承認', () => {
  it('一般のメンバーの新しいページは提案になり、承認すると反映する。結果は提案した人に知らせる', () => {
    const h = setup()
    const res = propose(h, 'm-base')
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result).toMatchObject({ applied: false })
    expect(list(h, 'm-base').pages).toEqual([])
    expect(list(h, 'm-base').myProposals).toEqual([expect.objectContaining({ title: '会計の手順', status: 'pending' })])
    // 管理の権限を持つ人(代表)には、承認待ちに出て、メールで知らせる
    const top = list(h, 'm-top')
    expect(top.manager).toBe(true)
    expect(top.pending).toHaveLength(1)
    expect(h.sent.some((s) => s.kind === 'mail' && s.to.includes('top@example.com') && s.text.includes('会計の手順'))).toBe(true)
    // 一般のメンバーは、承認待ちを受け取らない・承認できない
    expect(list(h, 'm-base').pending).toBeUndefined()
    expect(call(h, 'm-base', 'decideWikiProposal', { proposalId: top.pending[0].id, approve: true }).ok).toBe(false)
    const decided = call(h, 'm-top', 'decideWikiProposal', { proposalId: top.pending[0].id, approve: true })
    expect(decided.ok, JSON.stringify(decided)).toBe(true)
    const pages = list(h, 'm-base').pages
    expect(pages).toEqual([expect.objectContaining({ title: '会計の手順', folder: '手順書 > 会計', tags: ['会計', '月末'], version: 1 })])
    const full = call(h, 'm-base', 'getWikiPage', { pageId: pages[0].id }).result as Any
    expect(full).toMatchObject({ body: '# 会計\n\n月末に締める。', createdBy: 'm-base', updatedBy: 'm-base' })
    expect(h.sent.some((s) => s.kind === 'mail' && s.to.includes('base@example.com') && s.text.includes('承認されました'))).toBe(true)
    expect(list(h, 'm-base').myProposals[0].status).toBe('approved')
  })

  it('管理の権限を持つ人が直すと、すぐ反映し、前の版を残す', () => {
    const h = setup()
    const id = create(h)
    const res = call(h, 'm-top', 'proposeWikiEdit', { page: { ...page({ body: '新しい本文' }), pageId: id, baseVersion: 1 } })
    expect(res.result).toMatchObject({ applied: true, version: 2 })
    const full = call(h, 'm-top', 'getWikiPage', { pageId: id }).result as Any
    expect(full.body).toBe('新しい本文')
    expect(full.revisions).toEqual([expect.objectContaining({ version: 1, byId: 'm-top' })])
    const old = call(h, 'm-base', 'getWikiRevision', { pageId: id, version: 1 }).result as Any
    expect(old.body).toBe('# 会計\n\n月末に締める。')
  })

  it('提案の後にほかの人がページを直していたら、承認を断る(上書きしない)。古い版を元にした提案は出せない', () => {
    const h = setup()
    const id = create(h)
    expect(call(h, 'm-base', 'proposeWikiEdit', { page: { ...page({ body: '一般の提案' }), pageId: id, baseVersion: 1 } }).ok).toBe(true)
    const pid = list(h, 'm-top').pending[0].id
    call(h, 'm-top', 'proposeWikiEdit', { page: { ...page({ body: '代表が先に直す' }), pageId: id, baseVersion: 1 } })
    const res = call(h, 'm-top', 'decideWikiProposal', { proposalId: pid, approve: true })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ほかの人がこのページを直しました')
    expect((call(h, 'm-top', 'getWikiPage', { pageId: id }).result as Any).body).toBe('代表が先に直す')
    // 却下はできる(理由を知らせる)
    expect(call(h, 'm-top', 'decideWikiProposal', { proposalId: pid, approve: false, reason: '先に直したため' }).ok).toBe(true)
    expect(h.sent.some((s) => s.kind === 'mail' && s.text.includes('理由: 先に直したため'))).toBe(true)
    expect(call(h, 'm-base', 'proposeWikiEdit', { page: { ...page(), pageId: id, baseVersion: 1 } }).error).toContain('ほかの人が先に')
  })

  it('役職に「ナレッジの管理」を渡すと、その役職の人も承認できる', () => {
    const h = setup()
    propose(h, 'm-base')
    const pid = list(h, 'm-top').pending[0].id
    expect(call(h, 'm-lead', 'decideWikiProposal', { proposalId: pid, approve: true }).ok).toBe(false)
    const roles = h.sheets.Settings.rows.find((r) => r[0] === 'roles')!
    roles[1] = JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }, { id: 'r-lead', name: '班長', tier: 'admin', capabilities: ['knowledge'] }, { id: 'top', name: '代表', tier: 'top' }])
    h.cache.clear?.()
    expect(list(h, 'm-lead').manager).toBe(true)
    const res = call(h, 'm-lead', 'decideWikiProposal', { proposalId: pid, approve: true })
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  it('取り下げは自分の承認待ちの提案だけ。ページを消せるのは管理の権限を持つ人だけ', () => {
    const h = setup()
    propose(h, 'm-base')
    const pid = list(h, 'm-top').pending[0].id
    expect(call(h, 'm-other', 'withdrawWikiProposal', { proposalId: pid }).ok).toBe(false)
    expect(call(h, 'm-base', 'withdrawWikiProposal', { proposalId: pid }).ok).toBe(true)
    expect(call(h, 'm-top', 'decideWikiProposal', { proposalId: pid, approve: true }).ok).toBe(false)
    const id = create(h)
    expect(call(h, 'm-base', 'deleteWikiPage', { pageId: id }).ok).toBe(false)
    expect(call(h, 'm-top', 'deleteWikiPage', { pageId: id }).ok).toBe(true)
    expect(list(h, 'm-top').pages).toEqual([])
    expect(call(h, 'm-top', 'getWikiPage', { pageId: id }).ok).toBe(false)
  })

  it('おかしな値は断る', () => {
    const h = setup()
    const bad: Record<string, unknown>[] = [
      { title: '' }, { title: 'x'.repeat(121) }, { body: 'x'.repeat(45001) }, { body: 1 },
      { folder: 'a>b>c>d>e>f' }, { folder: 'x'.repeat(41) }, { tags: 'a' }, { tags: Array.from({ length: 11 }, (_, i) => 't' + i) },
      { audience: { kind: 'secret' } }, { audience: { kind: 'projects', ids: [] } }, { audience: 'all' },
    ]
    for (const b of bad) expect(propose(h, 'm-base', b).ok, JSON.stringify(b).slice(0, 60)).toBe(false)
    expect(list(h, 'm-base').myProposals).toEqual([])
  })
})

describe('ナレッジ: 公開範囲・検索・前の版・画像', () => {
  it('幹部だけ・プロジェクト・部署の公開範囲は、GAS が読み取りの時に絞る(一覧・1ページ・検索・前の版)', () => {
    const h = setup()
    const leaders = create(h, { title: '幹部の手順', audience: { kind: 'leaders' } })
    const project = create(h, { title: 'P の手順', audience: { kind: 'projects', ids: ['p1'] } })
    const dept = create(h, { title: '開発の手順', body: '開発の秘密', audience: { kind: 'departments', ids: ['本部'] } })
    const titles = (who: string) => (list(h, who).pages as Any[]).map((p) => p.title).sort()
    expect(titles('m-lead')).toEqual(['幹部の手順'])
    expect(titles('m-base')).toEqual(['P の手順'])
    expect(titles('m-victim')).toEqual(['開発の手順'])
    expect(titles('m-top')).toEqual(['P の手順', '幹部の手順', '開発の手順'])
    expect(call(h, 'm-base', 'getWikiPage', { pageId: leaders }).ok).toBe(false)
    expect(call(h, 'm-victim', 'getWikiPage', { pageId: project }).ok).toBe(false)
    expect(call(h, 'm-base', 'getWikiPage', { pageId: dept }).ok).toBe(false)
    expect((call(h, 'm-base', 'searchWiki', { query: '秘密' }).result as Any).results).toEqual([])
    expect((call(h, 'm-victim', 'searchWiki', { query: '秘密' }).result as Any).results).toEqual([expect.objectContaining({ id: dept, title: '開発の手順' })])
    // 公開範囲は、管理の権限を持つ人にだけ一覧で返す
    expect((list(h, 'm-base').pages as Any[])[0].audience).toBeUndefined()
    expect((list(h, 'm-top').pages as Any[])[0].audience).toBeTruthy()
    // 見られないページへの提案は断る
    expect(call(h, 'm-base', 'proposeWikiEdit', { page: { ...page(), pageId: leaders, baseVersion: 1 } }).ok).toBe(false)
  })

  it('検索: タイトル・本文・タグ・フォルダの言葉をすべて含むページ。タイトルに入るものを先に', () => {
    const h = setup()
    create(h, { title: '月末の締め', body: '会計の作業' })
    create(h, { title: '会計の手順', body: '月末に締める' })
    const r = (call(h, 'm-base', 'searchWiki', { query: '会計 月末' }).result as Any).results as Any[]
    expect(r.map((x) => x.title)).toEqual(['会計の手順', '月末の締め'])
    expect((call(h, 'm-base', 'searchWiki', { query: 'x'.repeat(101) })).ok).toBe(false)
  })

  it('前の版は1ページ20版まで残す', () => {
    const h = setup()
    const id = create(h)
    for (let v = 1; v <= 22; v++) {
      expect(call(h, 'm-top', 'proposeWikiEdit', { page: { ...page({ body: '版' + (v + 1) }), pageId: id, baseVersion: v } }).ok).toBe(true)
    }
    const revs = (call(h, 'm-top', 'getWikiPage', { pageId: id }).result as Any).revisions as Any[]
    expect(revs).toHaveLength(20)
    expect(revs[0].version).toBe(22)
    expect(revs[19].version).toBe(3)
  })

  it('画像は、そのファイルIDを本文に含むページを見られる人だけが読める(自分の提案・管理の権限を持つ人も)', () => {
    const h = setup()
    const IMG_A = 'AAAAAAAAAAAAAAAAAAAA'
    const IMG_B = 'BBBBBBBBBBBBBBBBBBBB'
    const IMG_C = 'CCCCCCCCCCCCCCCCCCCC'
    create(h, { title: '全員', body: `![図](wiki:${IMG_A})` })
    create(h, { title: '幹部', body: `![図](wiki:${IMG_B})`, audience: { kind: 'leaders' } })
    propose(h, 'm-other', { title: '提案', body: `![図](wiki:${IMG_C})` })
    const ids = (who: string) => Object.keys((h.c.wikiImageIdsFor_ as (a: object) => Record<string, boolean>)({ id: who, role: who === 'm-top' ? 'top' : who === 'm-lead' ? 'r-lead' : 'base' })).sort()
    expect(ids('m-base')).toEqual([IMG_A])
    expect(ids('m-lead')).toEqual([IMG_A, IMG_B])
    expect(ids('m-other')).toEqual([IMG_A, IMG_C])
    expect(ids('m-top')).toEqual([IMG_A, IMG_B, IMG_C])
  })
})
