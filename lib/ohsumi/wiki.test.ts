import { describe, expect, it } from 'vitest'
import { draftProblem, folderTree, lineDiff, normalizeFolder, parseWikiMarkdown, recentPages, safeWikiHref, wikiImageIds, type WikiDraft, type WikiPageSummary } from './wiki'

const page = (id: string, folder: string, title: string, updatedAt: string): WikiPageSummary => ({ id, folder, title, tags: [], version: 1, updatedAt, updatedBy: 'm1' })
const draft = (patch: Partial<WikiDraft> = {}): WikiDraft => ({ title: '手順', folder: '', tags: [], audience: { kind: 'all', ids: [] }, body: '', ...patch })

describe('ナレッジ', () => {
  it('フォルダを GAS と同じ形にする', () => {
    expect(normalizeFolder(' 新入生 >手続き>  > 書類 ')).toBe('新入生 > 手続き > 書類')
    expect(normalizeFolder('')).toBe('')
  })

  it('下書きの決まり(GAS と同じ上限)', () => {
    expect(draftProblem(draft())).toBeNull()
    expect(draftProblem(draft({ title: '  ' }))).toBe('title')
    expect(draftProblem(draft({ title: 'あ'.repeat(121) }))).toBe('titleLong')
    expect(draftProblem(draft({ body: 'x'.repeat(45001) }))).toBe('bodyLong')
    expect(draftProblem(draft({ folder: 'a>b>c>d>e>f' }))).toBe('folderDeep')
    expect(draftProblem(draft({ folder: 'x'.repeat(41) }))).toBe('folderLong')
    expect(draftProblem(draft({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }))).toBe('tagsMany')
    expect(draftProblem(draft({ tags: ['x'.repeat(31)] }))).toBe('tagLong')
    expect(draftProblem(draft({ audience: { kind: 'projects', ids: [] } }))).toBe('audienceIds')
  })

  it('フォルダの木と最近のページ', () => {
    const pages = [page('p1', '会計 > 経費', '精算', '2026-10-01'), page('p2', '会計', '予算', '2026-10-03'), page('p3', '', 'はじめに', '2026-10-02')]
    const root = folderTree(pages)
    expect(root.pages.map((p) => p.id)).toEqual(['p3'])
    expect(root.children.map((c) => c.path)).toEqual(['会計'])
    expect(root.children[0].pages.map((p) => p.id)).toEqual(['p2'])
    expect(root.children[0].children[0].path).toBe('会計 > 経費')
    expect(recentPages(pages, 2).map((p) => p.id)).toEqual(['p2', 'p3'])
  })

  it('リンクは http・https・mailto だけ', () => {
    expect(safeWikiHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeWikiHref('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(safeWikiHref('javascript:alert(1)')).toBeNull()
    expect(safeWikiHref('data:text/html,x')).toBeNull()
  })

  it('画像の ID を拾う(重ならない)', () => {
    expect(wikiImageIds('![a](wiki:abcdefghij12) と ![b](wiki:abcdefghij12) ![c](wiki:ZZZZZZZZZZ_9)')).toEqual(['abcdefghij12', 'ZZZZZZZZZZ_9'])
  })

  it('行ごとの違い', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('Markdown を決まった部品に分ける(HTML はそのまま文字)', () => {
    const blocks = parseWikiMarkdown('# 見出し\n本文<script>x</script>\n\n- a\n- b\n\n| 列 | 値 |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```\n---\n> 引用')
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'ul', 'table', 'code', 'hr', 'quote'])
    expect(blocks[1]).toEqual({ type: 'paragraph', lines: ['本文<script>x</script>'] })
  })
})
