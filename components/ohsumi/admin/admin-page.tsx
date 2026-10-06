'use client'

// 管理画面のタブの共通の形: 見出し(タブの名前)と1行の説明、まとまり(AdminBlock)ごとの見出し、
// 長い画面の上の目次(AdminToc。そのまとまりへ飛ぶ)
import type { ReactNode } from 'react'
import { useI18n } from '@/lib/ohsumi/i18n'

export function AdminPageHeader({ title, desc, actions }: { title: string; desc: string; actions?: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-6 pt-8" data-admin-page-header>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
        </div>
        {actions}
      </div>
    </div>
  )
}

export interface AdminTocItem {
  id: string
  label: string
}

export function AdminToc({ items }: { items: AdminTocItem[] }) {
  const { t } = useI18n()
  if (items.length < 2) return null
  return (
    <nav aria-label={t('admin.toc.aria')} className="rounded-lg border border-border bg-card p-3" data-admin-toc>
      <p className="text-[11px] font-semibold text-muted-foreground">{t('admin.toc.title')}</p>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`} className="text-sm text-primary underline-offset-2 hover:underline">
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function AdminBlock({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20" data-admin-block>
      <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">{title}</h2>
      {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** 目次とまとまりを並べたタブの中身 */
export function AdminBlocks({ blocks, note }: { blocks: { id: string; title: string; desc?: string; content: ReactNode }[]; note?: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-6">
      {note}
      <AdminToc items={blocks.map((b) => ({ id: b.id, label: b.title }))} />
      {blocks.map((b) => (
        <AdminBlock key={b.id} id={b.id} title={b.title} desc={b.desc}>{b.content}</AdminBlock>
      ))}
    </div>
  )
}
