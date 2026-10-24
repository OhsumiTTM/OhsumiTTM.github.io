'use client'

// タスク・プロジェクト・テンプレートにつないだナレッジのページ(v1.2)。見る人が見られるページだけを出す
// (題は listWikiPages の答えから引く。見られないページは一覧に無いので、題も数も出ない)。
// 直せる人は、題で探して足す・外す。onChange には見られるページの並びを渡す(見られないページのリンクは GAS が残す)
import { useMemo, useState } from 'react'
import { BookOpen, Plus, X } from 'lucide-react'
import { useNav } from '@/lib/ohsumi/nav'
import { useTaskDrawer } from '@/lib/ohsumi/task-drawer'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useWikiPageList } from '@/lib/ohsumi/wiki-list'
import { WIKI_LINKS_MAX } from '@/lib/ohsumi/wiki'
import { cn } from '@/lib/utils'

export function WikiLinks({
  ids,
  canEdit,
  onChange,
  open = true,
  compact = false,
}: {
  ids: string[] | undefined
  canEdit: boolean
  onChange: (ids: string[]) => void
  /** 押すとナレッジの画面でそのページを開く(テンプレートの編集では開かない) */
  open?: boolean
  /** 見出しを出さない(テンプレートの行の中など) */
  compact?: boolean
}) {
  const { t } = useI18n()
  const { go } = useNav()
  const { closeTask } = useTaskDrawer()
  const { pages, loaded } = useWikiPageList()
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const linked = (ids ?? []).map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    const taken = new Set(ids ?? [])
    return pages
      .filter((p) => !taken.has(p.id) && (!q || p.title.toLowerCase().includes(q) || p.folder.toLowerCase().includes(q) || p.tags.some((tag) => tag.toLowerCase().includes(q))))
      .slice(0, 8)
  }, [pages, ids, query])

  // 見られるページが無く、直せない人には何も出さない
  if (!canEdit && linked.length === 0) return null
  const visibleIds = linked.map((p) => p.id)
  const full = visibleIds.length >= WIKI_LINKS_MAX

  return (
    <div className="min-w-0" data-wiki-links>
      {!compact && (
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <BookOpen className="size-3.5" />
          {t('wikiLinks.header')}
        </p>
      )}
      {linked.length > 0 ? (
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {linked.map((p) => (
            <li key={p.id} className="flex min-w-0 max-w-full items-center rounded-md border border-border bg-secondary/40 text-xs" data-wiki-link={p.id}>
              {open ? (
                <button type="button" onClick={() => { closeTask(); go({ name: 'knowledge', pageId: p.id }) }} className="min-w-0 truncate px-2 py-1 text-left text-primary hover:underline">
                  {p.title}
                </button>
              ) : (
                <span className="min-w-0 truncate px-2 py-1">{p.title}</span>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onChange(visibleIds.filter((id) => id !== p.id))}
                  className="shrink-0 px-1.5 py-1 text-muted-foreground hover:text-foreground"
                  aria-label={t('wikiLinks.remove', { title: p.title })}
                  data-wiki-link-remove={p.id}
                >
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : compact ? null : (
        <p className="text-xs text-muted-foreground">{t('wikiLinks.empty')}</p>
      )}
      {canEdit && !adding && !full && (
        <button type="button" onClick={() => setAdding(true)} className={cn(linked.length > 0 || !compact ? 'mt-2' : '', 'inline-flex items-center gap-1 text-xs text-primary hover:underline')} data-wiki-link-add>
          <Plus className="size-3.5" />
          {t(compact ? 'wikiLinks.templateAdd' : 'wikiLinks.add')}
        </button>
      )}
      {canEdit && full && <p className="mt-2 text-[11px] text-muted-foreground">{t('wikiLinks.full', { max: WIKI_LINKS_MAX })}</p>}
      {canEdit && adding && !full && (
        <div className="mt-2 min-w-0 space-y-1.5" data-wiki-link-picker>
          <div className="flex min-w-0 gap-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('wikiLinks.searchPlaceholder')}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              data-wiki-link-search
            />
            <button type="button" onClick={() => { setAdding(false); setQuery('') }} className="shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary">
              {t('common.close')}
            </button>
          </div>
          {!loaded ? (
            <p className="text-xs text-muted-foreground">{t('knowledge.loading')}</p>
          ) : candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('wikiLinks.noMatch')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {candidates.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => { onChange([...visibleIds, p.id]); setQuery('') }}
                    className="flex w-full min-w-0 flex-col px-2 py-1.5 text-left hover:bg-secondary/50"
                    data-wiki-link-candidate={p.id}
                  >
                    <span className="min-w-0 truncate text-sm">{p.title}</span>
                    {p.folder && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{p.folder}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
