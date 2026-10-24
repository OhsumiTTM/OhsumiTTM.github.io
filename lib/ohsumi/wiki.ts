// ナレッジのページ(手順書・Wiki。v1.2。団体の GAS は gas/src/43-wiki.gs)。
// 見られる人なら誰でも作成・変更を「提案」でき、ナレッジの管理の権限(capability: knowledge)を持つ人の承認で反映する。
// 管理の権限を持つ人が直すと、すぐ反映する。ページごとの公開範囲・フォルダ(階層)・タグ・前の版・画像(wiki:<ファイルID>)
export type WikiAudienceKind = 'all' | 'leaders' | 'projects' | 'departments'
export interface WikiAudience {
  kind: WikiAudienceKind
  ids: string[]
}

export interface WikiPageSummary {
  id: string
  folder: string
  title: string
  tags: string[]
  version: number
  updatedAt: string
  updatedBy: string
  // 管理の権限を持つ人にだけ届く
  audience?: WikiAudience
}

export interface WikiRevisionSummary {
  version: number
  byId: string
  approvedBy: string
  at: string
}

export interface WikiPage extends WikiPageSummary {
  body: string
  createdBy: string
  createdAt: string
  audience: WikiAudience
  revisions: WikiRevisionSummary[]
}

export interface WikiRevision {
  pageId: string
  version: number
  title: string
  folder: string
  body: string
  tags: string[]
  byId: string
  approvedBy: string
  at: string
}

export type WikiProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

export interface WikiProposalSummary {
  id: string
  pageId: string
  baseVersion: number
  title: string
  folder: string
  byId: string
  at: string
  status: WikiProposalStatus
  decidedBy: string
  decidedAt: string
  reason: string
}

export interface WikiProposal extends WikiProposalSummary {
  body: string
  tags: string[]
  audience: WikiAudience
  current?: { title: string; folder: string; body: string; version: number; tags: string[]; audience: WikiAudience }
}

export interface WikiList {
  pages: WikiPageSummary[]
  myProposals: WikiProposalSummary[]
  manager: boolean
  pending?: WikiProposalSummary[]
}

export interface WikiSearchResult {
  id: string
  title: string
  folder: string
  snippet: string
}

/** 提案・直す時に送る内容(GAS の proposeWikiEdit の page) */
export interface WikiDraft {
  pageId?: string
  baseVersion?: number
  title: string
  folder: string
  tags: string[]
  audience: WikiAudience
  body: string
}

// GAS と同じ上限(gas/src/43-wiki.gs)
export const WIKI_LIMITS = { title: 120, body: 45000, folderDepth: 5, folderPart: 40, tags: 10, tag: 30 } as const

/** フォルダの文字を、GAS と同じ形にする('a>b' → 'a > b'。空の段は除く) */
export function normalizeFolder(folder: string): string {
  return folder.split('>').map((p) => p.trim()).filter(Boolean).join(' > ')
}

/** 下書きの確かめ(GAS と同じ決まり)。問題が無ければ null、あれば理由のキー */
export function draftProblem(d: WikiDraft): 'title' | 'titleLong' | 'bodyLong' | 'folderDeep' | 'folderLong' | 'tagsMany' | 'tagLong' | 'audienceIds' | null {
  const title = d.title.trim()
  if (!title) return 'title'
  if (title.length > WIKI_LIMITS.title) return 'titleLong'
  if (d.body.length > WIKI_LIMITS.body) return 'bodyLong'
  const parts = normalizeFolder(d.folder).split(' > ').filter(Boolean)
  if (parts.length > WIKI_LIMITS.folderDepth) return 'folderDeep'
  if (parts.some((p) => p.length > WIKI_LIMITS.folderPart)) return 'folderLong'
  const tags = d.tags.map((t) => t.trim()).filter(Boolean)
  if (tags.length > WIKI_LIMITS.tags) return 'tagsMany'
  if (tags.some((t) => t.length > WIKI_LIMITS.tag)) return 'tagLong'
  if ((d.audience.kind === 'projects' || d.audience.kind === 'departments') && d.audience.ids.length === 0) return 'audienceIds'
  return null
}

// ---- フォルダの木 ----

export interface WikiFolderNode {
  name: string
  path: string
  children: WikiFolderNode[]
  pages: WikiPageSummary[]
}

/** ページの一覧からフォルダの木を作る(名前の順。フォルダの無いページは根に) */
export function folderTree(pages: readonly WikiPageSummary[]): WikiFolderNode {
  const root: WikiFolderNode = { name: '', path: '', children: [], pages: [] }
  for (const p of pages) {
    let node = root
    const parts = normalizeFolder(p.folder).split(' > ').filter(Boolean)
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join(' > ')
      let child = node.children.find((c) => c.name === name)
      if (!child) {
        child = { name, path, children: [], pages: [] }
        node.children.push(child)
      }
      node = child
    })
    node.pages.push(p)
  }
  const sort = (n: WikiFolderNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    n.pages.sort((a, b) => a.title.localeCompare(b.title, 'ja'))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

/** 最近更新したページ(新しい順) */
export function recentPages(pages: readonly WikiPageSummary[], limit = 10): WikiPageSummary[] {
  return [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
}

/** 本文の画像(wiki:<ファイルID>)の ID */
export function wikiImageIds(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/wiki:([A-Za-z0-9_-]{10,200})/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** 画像の参照を、ファイルの取得の仕組み(lib/ohsumi/files.ts)が読める URL にする */
export function wikiImageUrl(fileId: string): string {
  return `https://lh3.googleusercontent.com/d/${fileId}=w1600`
}

// ---- 安全なリンク ----

/** ページの中のリンクとして開いてよいか(http・https・mailto だけ) */
export function safeWikiHref(href: string): string | null {
  const h = href.trim()
  if (/^https?:\/\/[^\s]+$/i.test(h)) return h
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(h)) return h
  return null
}

/** 2つの文章の行ごとの違い(承認の時に、今のページと提案を比べる)。同じ行・消えた行・足した行 */
export function lineDiff(before: string, after: string): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // 最長共通部分列(行の数が多い時は、比べずに全部を消した・足したとして出す)
  if (a.length * b.length > 400000) return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))]
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { kind: 'same' | 'removed' | 'added'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'removed', text: a[i++] })
    else out.push({ kind: 'added', text: b[j++] })
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) out.push({ kind: 'added', text: b[j++] })
  return out
}

// ---- 本文(Markdown)を部品に分ける。HTML は使わず、決まった書き方だけ(表示は components/ohsumi/knowledge/wiki-markdown.tsx) ----

export type WikiBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; text: string }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; rows: string[][] }

const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const isSpecial = (line: string) =>
  /^#{1,6}\s/.test(line) || /^\s*(-|\d+\.)\s+/.test(line) || line.trim().startsWith('|') || line.trim().startsWith('>') || line.trim().startsWith('```') || /^\s*-{3,}\s*$/.test(line)

export function parseWikiMarkdown(source: string): WikiBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: WikiBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (line.trim().startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    if (/^\s*-{3,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() }); i++; continue }
    if (line.trim().startsWith('|') && TABLE_SEPARATOR.test((lines[i + 1] ?? '').trim())) {
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]))
      blocks.push({ type: 'table', header, rows })
      continue
    }
    if (line.trim().startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''))
      blocks.push({ type: 'quote', lines: quote })
      continue
    }
    const listType = /^\s*-\s+/.test(line) ? 'ul' : /^\s*\d+\.\s+/.test(line) ? 'ol' : null
    if (listType) {
      const marker = listType === 'ul' ? /^\s*-\s+/ : /^\s*\d+\.\s+/
      const items: string[] = []
      while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, ''))
      blocks.push({ type: listType, items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) para.push(lines[i++])
    if (para.length === 0) para.push(lines[i++])
    blocks.push({ type: 'paragraph', lines: para })
  }
  return blocks
}
