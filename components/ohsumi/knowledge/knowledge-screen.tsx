'use client'

// ナレッジ(手順書・Wiki。lib/ohsumi/wiki.ts・gas/src/43-wiki.gs)。
//   ページ: フォルダの木・最近更新したページ・検索 → 1ページ(本文・タグ・前の版)
//   直す・新しいページ: 見られる人なら誰でも「提案」できる。ナレッジの管理の権限(knowledge)を持つ人の承認で反映する
//                       (管理の権限を持つ人が直すと、すぐ反映する)。画像は団体の Drive に置き、本文に ![説明](wiki:<ID>) と書く
//   自分の提案: 状態(承認待ち・承認・却下・取り下げ)と理由。承認待ちは取り下げられる
//   承認待ち(管理の権限を持つ人): 今のページとの違い(行ごと)を見て、承認・却下(理由)
// 中身は開いた時に団体の GAS から読む(起動時のデータには入れない)。見られないページは GAS が返さない
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronRight, FileText, Folder, History, ImagePlus, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import { remoteApi } from '@/lib/ohsumi/remote'
import { checkImageFile } from '@/lib/ohsumi/image-upload'
import { cn } from '@/lib/utils'
import { SegmentedButton, SegmentedControl } from '../segmented'
import { WikiMarkdown } from './wiki-markdown'
import {
  draftProblem,
  folderTree,
  lineDiff,
  normalizeFolder,
  recentPages,
  WIKI_LIMITS,
  type WikiAudience,
  type WikiDraft,
  type WikiFolderNode,
  type WikiList,
  type WikiPage,
  type WikiPageSummary,
  type WikiProposal,
  type WikiRevision,
  type WikiSearchResult,
} from '@/lib/ohsumi/wiki'

type Tab = 'pages' | 'mine' | 'pending'
type Pane =
  | { kind: 'home' }
  | { kind: 'page'; id: string }
  | { kind: 'revision'; id: string; version: number }
  | { kind: 'edit'; id?: string }
  | { kind: 'proposal'; id: string }

const fieldClass = 'h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm'
const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(String(e.target?.result ?? ''))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function KnowledgeScreen() {
  const { t } = useI18n()
  const toast = useToast()
  const { can, getMember } = useOhsumi()
  const [list, setList] = useState<WikiList | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('pages')
  const [pane, setPane] = useState<Pane>({ kind: 'home' })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WikiSearchResult[] | null>(null)
  const manager = !!list?.manager && can('knowledge')
  const nameOf = (id: string) => getMember(id)?.displayName || getMember(id)?.name || t('knowledge.unknownMember')

  const load = useCallback(() => {
    remoteApi.listWikiPages().then(
      (l) => { setList(l); setLoadError(null) },
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        setLoadError(/Unknown action|listWikiPages/i.test(msg) ? t('knowledge.oldGas') : msg)
      },
    )
  }, [t])
  useEffect(() => { load() }, [load])

  const search = () => {
    const q = query.trim()
    if (!q) { setResults(null); return }
    remoteApi.searchWiki(q).then((r) => setResults(r.results), (e: unknown) => toast(e instanceof Error ? e.message : String(e)))
  }

  const tree = useMemo(() => folderTree(list?.pages ?? []), [list])
  const pendingCount = list?.pending?.length ?? 0

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-[1360px] px-4 py-6 sm:px-6 lg:px-8" data-knowledge>
        <h1 className="text-xl font-semibold tracking-tight">{t('knowledge.title')}</h1>
        <p className="mt-3 text-sm text-warning" data-knowledge-error>{loadError}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1360px] px-4 py-6 sm:px-6 lg:px-8" data-knowledge>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><BookOpen className="size-5" />{t('knowledge.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{t(manager ? 'knowledge.subtitleManager' : 'knowledge.subtitle')}</p>
        </div>
        <Button size="sm" onClick={() => { setTab('pages'); setPane({ kind: 'edit' }) }} data-knowledge-new>
          <Plus className="size-4" />{t('knowledge.newPage')}
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SegmentedControl ariaLabel={t('knowledge.tabsLabel')}>
          <SegmentedButton active={tab === 'pages'} onClick={() => setTab('pages')}>{t('knowledge.tab.pages')}</SegmentedButton>
          <SegmentedButton active={tab === 'mine'} onClick={() => setTab('mine')}>{t('knowledge.tab.mine')}</SegmentedButton>
          {manager && (
            <SegmentedButton active={tab === 'pending'} onClick={() => setTab('pending')}>
              {t('knowledge.tab.pending')}{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </SegmentedButton>
          )}
        </SegmentedControl>
      </div>

      {!list ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('knowledge.loading')}</p>
      ) : tab === 'mine' ? (
        <MyProposals list={list} onChanged={load} onOpen={(id) => { setTab('pending'); setPane({ kind: 'proposal', id }) }} canReview={manager} />
      ) : tab === 'pending' && manager ? (
        pane.kind === 'proposal' ? (
          <ProposalReview id={pane.id} nameOf={nameOf} onDone={() => { setPane({ kind: 'home' }); load() }} onBack={() => setPane({ kind: 'home' })} />
        ) : (
          <PendingList list={list} nameOf={nameOf} onOpen={(id) => setPane({ kind: 'proposal', id })} />
        )
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-4" data-knowledge-nav>
            <div className="flex min-w-0 gap-1.5">
              <input
                className={fieldClass}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') search() }}
                placeholder={t('knowledge.searchPlaceholder')}
                maxLength={100}
                data-knowledge-search
              />
              <Button size="icon-sm" variant="outline" onClick={search} aria-label={t('knowledge.search')}><Search className="size-4" /></Button>
            </div>
            {results && (
              <section className="rounded-lg border border-border bg-card p-2" data-knowledge-results>
                <h2 className="px-1 text-xs font-semibold text-muted-foreground">{t('knowledge.results', { count: results.length })}</h2>
                <ul className="mt-1">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setPane({ kind: 'page', id: r.id })} className="w-full min-w-0 rounded-md px-2 py-1.5 text-left hover:bg-secondary" data-knowledge-result={r.id}>
                        <span className="block truncate text-sm font-medium">{r.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{r.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="rounded-lg border border-border bg-card p-2" data-knowledge-tree>
              <h2 className="px-1 text-xs font-semibold text-muted-foreground">{t('knowledge.folders')}</h2>
              {list.pages.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">{t('knowledge.noPages')}</p>
              ) : (
                <FolderNode node={tree} depth={0} activeId={pane.kind === 'page' ? pane.id : ''} onOpen={(id) => setPane({ kind: 'page', id })} />
              )}
            </section>
          </aside>
          <main className="min-w-0">
            {pane.kind === 'home' && <Recent pages={list.pages} nameOf={nameOf} onOpen={(id) => setPane({ kind: 'page', id })} />}
            {pane.kind === 'page' && (
              <PageView
                key={pane.id}
                id={pane.id}
                manager={manager}
                nameOf={nameOf}
                onEdit={() => setPane({ kind: 'edit', id: pane.id })}
                onRevision={(version) => setPane({ kind: 'revision', id: pane.id, version })}
                onDeleted={() => { setPane({ kind: 'home' }); load() }}
              />
            )}
            {pane.kind === 'revision' && <RevisionView id={pane.id} version={pane.version} nameOf={nameOf} onBack={() => setPane({ kind: 'page', id: pane.id })} />}
            {pane.kind === 'edit' && (
              <PageEditor
                key={pane.id ?? 'new'}
                id={pane.id}
                manager={manager}
                folders={[...new Set(list.pages.map((p) => normalizeFolder(p.folder)).filter(Boolean))].sort()}
                onCancel={() => setPane(pane.id ? { kind: 'page', id: pane.id } : { kind: 'home' })}
                onSaved={(res) => {
                  load()
                  if (res.applied && res.pageId) {
                    toast(t('knowledge.saved'))
                    setPane({ kind: 'page', id: res.pageId })
                  } else {
                    toast(t('knowledge.proposed'))
                    setTab('mine')
                    setPane({ kind: 'home' })
                  }
                }}
              />
            )}
          </main>
        </div>
      )}
    </div>
  )
}

function FolderNode({ node, depth, activeId, onOpen }: { node: WikiFolderNode; depth: number; activeId: string; onOpen: (id: string) => void }) {
  return (
    <div className="min-w-0">
      {node.children.map((c) => (
        <FolderBranch key={c.path} node={c} depth={depth} activeId={activeId} onOpen={onOpen} />
      ))}
      {node.pages.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onOpen(p.id)}
          className={cn('flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-1 text-left text-sm hover:bg-secondary', activeId === p.id && 'bg-secondary font-medium')}
          style={{ paddingLeft: 4 + depth * 12 }}
          data-knowledge-page={p.id}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{p.title}</span>
        </button>
      ))}
    </div>
  )
}

function FolderBranch({ node, depth, activeId, onOpen }: { node: WikiFolderNode; depth: number; activeId: string; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(depth < 1)
  return (
    <div className="min-w-0" data-knowledge-folder={node.path}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1 rounded-md py-1 pr-1 text-left text-sm font-medium hover:bg-secondary"
        style={{ paddingLeft: 4 + depth * 12 }}
        aria-expanded={open}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {open && <FolderNode node={node} depth={depth + 1} activeId={activeId} onOpen={onOpen} />}
    </div>
  )
}

function Recent({ pages, nameOf, onOpen }: { pages: WikiPageSummary[]; nameOf: (id: string) => string; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  const recent = recentPages(pages)
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-knowledge-recent>
      <h2 className="text-sm font-semibold">{t('knowledge.recent')}</h2>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('knowledge.noPagesYet')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {recent.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(p.id)} className="flex w-full min-w-0 flex-col gap-0.5 py-2 text-left hover:bg-secondary/50">
                <span className="truncate text-sm font-medium">{p.title}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {[p.folder, t('knowledge.updatedBy', { name: nameOf(p.updatedBy), at: fmt(p.updatedAt) })].filter(Boolean).join(' ・ ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function audienceText(a: WikiAudience | undefined, t: (k: TranslationKey, v?: Record<string, string | number>) => string, projectName: (id: string) => string) {
  if (!a) return ''
  if (a.kind === 'all') return t('knowledge.audience.all')
  if (a.kind === 'leaders') return t('knowledge.audience.leaders')
  if (a.kind === 'projects') return t('knowledge.audience.projectsOf', { list: a.ids.map(projectName).join('・') })
  return t('knowledge.audience.departmentsOf', { list: a.ids.join('・') })
}

function PageView({ id, manager, nameOf, onEdit, onRevision, onDeleted }: {
  id: string
  manager: boolean
  nameOf: (id: string) => string
  onEdit: () => void
  onRevision: (version: number) => void
  onDeleted: () => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const { projects, deleteWikiPage, can } = useOhsumi()
  const [page, setPage] = useState<WikiPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  useEffect(() => {
    remoteApi.getWikiPage(id).then(setPage, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [id])
  if (error) return <p className="text-sm text-warning">{error}</p>
  if (!page) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('knowledge.loading')}</p>
  const projectName = (pid: string) => projects.find((p) => p.id === pid)?.name ?? pid
  const remove = async () => {
    if (!window.confirm(t('knowledge.deleteConfirm', { title: page.title }))) return
    try {
      await deleteWikiPage(page.id)
      toast(t('knowledge.deleted'))
      onDeleted()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <article className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6" data-knowledge-view={page.id}>
      {page.folder && <p className="text-xs text-muted-foreground">{page.folder}</p>}
      <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight">{page.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{t('knowledge.updatedBy', { name: nameOf(page.updatedBy), at: fmt(page.updatedAt) })}</span>
        <span>{t('knowledge.version', { version: page.version })}</span>
        <span data-knowledge-audience>{audienceText(page.audience, t, projectName)}</span>
      </div>
      {page.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">{page.tags.map((tag) => <span key={tag} className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">#{tag}</span>)}</div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onEdit} data-knowledge-edit><Pencil className="size-3.5" />{t(manager ? 'knowledge.edit' : 'knowledge.proposeEdit')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setShowHistory((s) => !s)} data-knowledge-history-toggle><History className="size-3.5" />{t('knowledge.history', { count: page.revisions.length })}</Button>
        {manager && can('knowledge') && (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void remove()} data-knowledge-delete><Trash2 className="size-3.5" />{t('knowledge.delete')}</Button>
        )}
      </div>
      {showHistory && (
        <ul className="mt-3 rounded-md border border-border p-2 text-xs" data-knowledge-history>
          {page.revisions.length === 0 ? <li className="text-muted-foreground">{t('knowledge.noHistory')}</li> : page.revisions.map((r) => (
            <li key={r.version}>
              <button type="button" onClick={() => onRevision(r.version)} className="w-full rounded px-1.5 py-1 text-left hover:bg-secondary" data-knowledge-revision={r.version}>
                {t('knowledge.revisionLine', { version: r.version, name: nameOf(r.byId), at: fmt(r.at) })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 border-t border-border pt-2"><WikiMarkdown source={page.body} /></div>
    </article>
  )
}

function RevisionView({ id, version, nameOf, onBack }: { id: string; version: number; nameOf: (id: string) => string; onBack: () => void }) {
  const { t } = useI18n()
  const [rev, setRev] = useState<WikiRevision | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    remoteApi.getWikiRevision(id, version).then(setRev, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [id, version])
  return (
    <article className="min-w-0 rounded-xl border border-dashed border-border bg-card p-4 sm:p-6" data-knowledge-revision-view={version}>
      <Button size="sm" variant="ghost" onClick={onBack}>{t('knowledge.backToPage')}</Button>
      {error && <p className="mt-2 text-sm text-warning">{error}</p>}
      {rev && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">{t('knowledge.revisionLine', { version: rev.version, name: nameOf(rev.byId), at: fmt(rev.at) })}</p>
          <h1 className="mt-1 break-words text-xl font-semibold">{rev.title}</h1>
          <div className="mt-3 border-t border-border pt-2"><WikiMarkdown source={rev.body} /></div>
        </>
      )}
    </article>
  )
}

function PageEditor({ id, manager, folders, onCancel, onSaved }: {
  id?: string
  manager: boolean
  folders: string[]
  onCancel: () => void
  onSaved: (res: { applied: boolean; pageId?: string }) => void
}) {
  const { t } = useI18n()
  const toast = useToast()
  const { projects, departmentTreeConfig, members } = useOhsumi()
  const [draft, setDraft] = useState<WikiDraft | null>(id ? null : { title: '', folder: '', tags: [], audience: { kind: 'all', ids: [] }, body: '' })
  const [tagsText, setTagsText] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!id) return
    remoteApi.getWikiPage(id).then(
      (p) => { setDraft({ pageId: p.id, baseVersion: p.version, title: p.title, folder: p.folder, tags: p.tags, audience: p.audience, body: p.body }); setTagsText(p.tags.join(', ')) },
      (e: unknown) => toast(e instanceof Error ? e.message : String(e)),
    )
  }, [id, toast])
  const departments = useMemo(() => {
    const set = new Set<string>()
    departmentTreeConfig.forEach((n) => { if (n.path) set.add(n.path) })
    members.forEach((m) => (m.departmentPaths ?? []).forEach((p) => p && set.add(p)))
    return [...set].sort()
  }, [departmentTreeConfig, members])
  if (!draft) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('knowledge.loading')}</p>

  const set = (patch: Partial<WikiDraft>) => setDraft({ ...draft, ...patch })
  const full: WikiDraft = { ...draft, folder: normalizeFolder(draft.folder), tags: tagsText.split(/[,、]/).map((s) => s.trim()).filter(Boolean) }
  const problem = draftProblem(full)
  const toggleId = (pid: string) => set({ audience: { ...draft.audience, ids: draft.audience.ids.includes(pid) ? draft.audience.ids.filter((x) => x !== pid) : [...draft.audience.ids, pid] } })

  const insertImage = async (file: File | undefined) => {
    if (!file) return
    const check = checkImageFile(file)
    if (check !== 'ok') { toast(t(check === 'type' ? 'upload.image.badType' : 'upload.image.tooLarge')); return }
    setUploading(true)
    try {
      const res = await remoteApi.uploadWikiImage(await readAsDataUrl(file), file.name)
      const tag = `\n![${file.name.replace(/[[\]()]/g, '')}](wiki:${res.fileId})\n`
      const el = bodyRef.current
      const at = el ? el.selectionStart : draft.body.length
      set({ body: draft.body.slice(0, at) + tag + draft.body.slice(at) })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const save = async () => {
    if (problem) return
    setBusy(true)
    try {
      onSaved(await remoteApi.proposeWikiEdit(full))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6" data-knowledge-editor>
      <h2 className="text-base font-semibold">{t(id ? (manager ? 'knowledge.editTitle' : 'knowledge.proposeEditTitle') : manager ? 'knowledge.newTitle' : 'knowledge.proposeNewTitle')}</h2>
      {!manager && <p className="text-xs text-muted-foreground" data-knowledge-approval-note>{t('knowledge.approvalNote')}</p>}
      <label className="block text-xs">
        <span className="text-muted-foreground">{t('knowledge.field.title')}</span>
        <input className={fieldClass} value={draft.title} maxLength={WIKI_LIMITS.title} onChange={(e) => set({ title: e.target.value })} data-knowledge-field="title" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0 text-xs">
          <span className="text-muted-foreground">{t('knowledge.field.folder')}</span>
          <input className={fieldClass} value={draft.folder} list="knowledge-folders" onChange={(e) => set({ folder: e.target.value })} placeholder={t('knowledge.field.folderPlaceholder')} data-knowledge-field="folder" />
          <datalist id="knowledge-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <label className="block min-w-0 text-xs">
          <span className="text-muted-foreground">{t('knowledge.field.tags')}</span>
          <input className={fieldClass} value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder={t('knowledge.field.tagsPlaceholder')} data-knowledge-field="tags" />
        </label>
      </div>
      <fieldset className="min-w-0 rounded-md border border-border p-2 text-xs" data-knowledge-audience-field>
        <legend className="px-1 text-muted-foreground">{t('knowledge.field.audience')}</legend>
        <select
          className={fieldClass}
          value={draft.audience.kind}
          onChange={(e) => set({ audience: { kind: e.target.value as WikiAudience['kind'], ids: [] } })}
          data-knowledge-field="audience"
        >
          {(['all', 'leaders', 'projects', 'departments'] as const).map((k) => <option key={k} value={k}>{t(`knowledge.audience.${k}` as TranslationKey)}</option>)}
        </select>
        {(draft.audience.kind === 'projects' || draft.audience.kind === 'departments') && (
          <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {(draft.audience.kind === 'projects' ? projects.map((p) => ({ id: p.id, label: p.name })) : departments.map((d) => ({ id: d, label: d }))).map((o) => (
              <label key={o.id} className="flex min-w-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 has-[:checked]:bg-secondary">
                <input type="checkbox" className="size-3.5" checked={draft.audience.ids.includes(o.id)} onChange={() => toggleId(o.id)} />
                <span className="min-w-0 truncate">{o.label}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl ariaLabel={t('knowledge.field.body')}>
            <SegmentedButton active={!preview} onClick={() => setPreview(false)}>{t('knowledge.write')}</SegmentedButton>
            <SegmentedButton active={preview} onClick={() => setPreview(true)}>{t('knowledge.preview')}</SegmentedButton>
          </SegmentedControl>
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={(e) => void insertImage(e.target.files?.[0])} />
            <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()} data-knowledge-image>
              {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}{t('knowledge.addImage')}
            </Button>
          </div>
        </div>
        {preview ? (
          <div className="min-h-[240px] rounded-md border border-border p-3" data-knowledge-preview><WikiMarkdown source={draft.body} /></div>
        ) : (
          <textarea
            ref={bodyRef}
            className="min-h-[320px] w-full min-w-0 rounded-md border border-border bg-background p-2 font-mono text-sm leading-6"
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder={t('knowledge.bodyPlaceholder')}
            data-knowledge-field="body"
          />
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">{t('knowledge.markdownHelp')} {t('knowledge.length', { count: draft.body.length, max: WIKI_LIMITS.body })}</p>
      </div>
      {problem && <p className="text-xs text-warning" data-knowledge-problem>{t(`knowledge.problem.${problem}` as TranslationKey)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !!problem} onClick={() => void save()} data-knowledge-save>
          {busy && <Loader2 className="size-3.5 animate-spin" />}{t(manager ? 'knowledge.save' : 'knowledge.propose')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </div>
  )
}

const STATUS_KEY: Record<string, TranslationKey> = {
  pending: 'knowledge.status.pending',
  approved: 'knowledge.status.approved',
  rejected: 'knowledge.status.rejected',
  withdrawn: 'knowledge.status.withdrawn',
}

function MyProposals({ list, onChanged, onOpen, canReview }: { list: WikiList; onChanged: () => void; onOpen: (id: string) => void; canReview: boolean }) {
  const { t } = useI18n()
  const toast = useToast()
  const withdraw = async (id: string) => {
    try {
      await remoteApi.withdrawWikiProposal(id)
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-knowledge-mine>
      {list.myProposals.length === 0 ? <p className="text-sm text-muted-foreground">{t('knowledge.noProposals')}</p> : (
        <ul className="divide-y divide-border">
          {list.myProposals.map((q) => (
            <li key={q.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2" data-knowledge-proposal={q.id} data-status={q.status}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{q.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t(STATUS_KEY[q.status] ?? 'knowledge.status.pending')} ・ {fmt(q.at)}{q.reason ? ` ・ ${t('knowledge.reason', { reason: q.reason })}` : ''}
                </p>
              </div>
              <div className="flex gap-1.5">
                {canReview && q.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => onOpen(q.id)}>{t('knowledge.review')}</Button>}
                {q.status === 'pending' && <Button size="sm" variant="outline" onClick={() => void withdraw(q.id)} data-knowledge-withdraw>{t('knowledge.withdraw')}</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PendingList({ list, nameOf, onOpen }: { list: WikiList; nameOf: (id: string) => string; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  const pending = list.pending ?? []
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-knowledge-pending>
      {pending.length === 0 ? <p className="text-sm text-muted-foreground">{t('knowledge.noPending')}</p> : (
        <ul className="divide-y divide-border">
          {pending.map((q) => (
            <li key={q.id}>
              <button type="button" onClick={() => onOpen(q.id)} className="flex w-full min-w-0 flex-col gap-0.5 py-2 text-left hover:bg-secondary/50" data-knowledge-pending-item={q.id}>
                <span className="truncate text-sm font-medium">{q.title}</span>
                <span className="text-[11px] text-muted-foreground">{t(q.pageId ? 'knowledge.kind.edit' : 'knowledge.kind.new')} ・ {nameOf(q.byId)} ・ {fmt(q.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProposalReview({ id, nameOf, onDone, onBack }: { id: string; nameOf: (id: string) => string; onDone: () => void; onBack: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const { decideWikiProposal, can, projects } = useOhsumi()
  const [q, setQ] = useState<WikiProposal | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  useEffect(() => {
    remoteApi.getWikiProposal(id).then(setQ, (e: unknown) => toast(e instanceof Error ? e.message : String(e)))
  }, [id, toast])
  if (!q) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('knowledge.loading')}</p>
  const projectName = (pid: string) => projects.find((p) => p.id === pid)?.name ?? pid
  const decide = async (approve: boolean) => {
    if (!can('knowledge')) return
    setBusy(true)
    try {
      await decideWikiProposal(q.id, approve, reason)
      toast(t(approve ? 'knowledge.approvedToast' : 'knowledge.rejectedToast'))
      onDone()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const diff = lineDiff(q.current?.body ?? '', q.body)
  const changes: string[] = []
  if (q.current) {
    if (q.current.title !== q.title) changes.push(t('knowledge.change.title', { from: q.current.title, to: q.title }))
    if (q.current.folder !== q.folder) changes.push(t('knowledge.change.folder', { from: q.current.folder || '—', to: q.folder || '—' }))
    if (q.current.tags.join(',') !== q.tags.join(',')) changes.push(t('knowledge.change.tags', { from: q.current.tags.join('・') || '—', to: q.tags.join('・') || '—' }))
    const before = audienceText(q.current.audience, t, projectName)
    const after = audienceText(q.audience, t, projectName)
    if (before !== after) changes.push(t('knowledge.change.audience', { from: before, to: after }))
  }
  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6" data-knowledge-review={q.id}>
      <Button size="sm" variant="ghost" onClick={onBack}>{t('knowledge.backToPending')}</Button>
      <h2 className="break-words text-lg font-semibold">{q.title}</h2>
      <p className="text-xs text-muted-foreground">{t(q.pageId ? 'knowledge.kind.edit' : 'knowledge.kind.new')} ・ {nameOf(q.byId)} ・ {fmt(q.at)} ・ {audienceText(q.audience, t, projectName)}</p>
      {changes.length > 0 && <ul className="list-disc pl-5 text-xs" data-knowledge-meta-changes>{changes.map((c) => <li key={c} className="break-words">{c}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <SegmentedControl ariaLabel={t('knowledge.reviewView')}>
          <SegmentedButton active={!showPreview} onClick={() => setShowPreview(false)}>{t('knowledge.diff')}</SegmentedButton>
          <SegmentedButton active={showPreview} onClick={() => setShowPreview(true)}>{t('knowledge.preview')}</SegmentedButton>
        </SegmentedControl>
      </div>
      {showPreview ? (
        <div className="rounded-md border border-border p-3"><WikiMarkdown source={q.body} /></div>
      ) : (
        <pre className="max-h-[480px] overflow-auto rounded-md border border-border p-2 font-mono text-xs leading-5" data-knowledge-diff>
          {diff.map((l, i) => (
            <div key={i} className={cn('whitespace-pre-wrap break-words', l.kind === 'added' && 'bg-emerald-500/15', l.kind === 'removed' && 'bg-rose-500/15 line-through')}>
              {l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '- ' : '  '}{l.text}
            </div>
          ))}
        </pre>
      )}
      <label className="block text-xs">
        <span className="text-muted-foreground">{t('knowledge.reasonLabel')}</span>
        <input className={fieldClass} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-knowledge-reason />
      </label>
      {can('knowledge') && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void decide(true)} data-knowledge-approve>{t('knowledge.approve')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)} data-knowledge-reject>{t('knowledge.reject')}</Button>
        </div>
      )}
    </div>
  )
}
