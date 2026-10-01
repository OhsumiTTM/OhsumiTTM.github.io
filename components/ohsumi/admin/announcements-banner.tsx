'use client'

// FSIF からのお知らせ(管理画面の上部。代表・管理者)。gas/Code.gs の announcementsStatus_ が、レジストリから取ったもの
//   - 重要度(通常・重要・緊急)で色を分け、緊急・重要・通常の順に出す
//   - 既読はこの端末に覚える(localStorage)。緊急のお知らせは、掲載の間は既読にできない
//   - 本文は文字としてだけ出す(リンクや HTML にしない)
import { useEffect, useState } from 'react'
import { Megaphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { isRemoteConfigured, remoteApi, type Announcement, type AnnouncementImportance, type AnnouncementsStatus } from '@/lib/ohsumi/remote'

const READ_KEY = 'ohsumi-announcements-read'
const ORDER: Record<AnnouncementImportance, number> = { urgent: 0, important: 1, normal: 2 }
const TONES: Record<AnnouncementImportance, string> = {
  urgent: 'bg-destructive/10 text-destructive',
  important: 'bg-warning-muted text-warning',
  normal: 'bg-muted/60 text-foreground',
}
const LABEL_KEYS: Record<AnnouncementImportance, TranslationKey> = {
  urgent: 'announcements.importance.urgent',
  important: 'announcements.importance.important',
  normal: 'announcements.importance.normal',
}

function loadRead(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(READ_KEY) || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function saveRead(ids: string[]) {
  try { localStorage.setItem(READ_KEY, JSON.stringify(ids.slice(-200))) } catch { /* 覚えられなくても、この画面の間は使える */ }
}

/** 出す順(緊急・重要・通常、同じ重要度は新しい順)と、既読で隠すもの */
export function arrangeAnnouncements(list: Announcement[], read: string[]): { shown: Announcement[]; hidden: Announcement[] } {
  const sorted = [...list].sort((a, b) => ORDER[a.importance] - ORDER[b.importance] || b.publishedAt.localeCompare(a.publishedAt))
  return {
    shown: sorted.filter((a) => a.importance === 'urgent' || !read.includes(a.announcementId)),
    hidden: sorted.filter((a) => a.importance !== 'urgent' && read.includes(a.announcementId)),
  }
}

export function AnnouncementsBanner() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useState<AnnouncementsStatus | null>(null)
  const [read, setRead] = useState<string[]>([])
  const [showRead, setShowRead] = useState(false)

  useEffect(() => {
    if (!isRemoteConfigured) return
    let alive = true
    setRead(loadRead())
    remoteApi.getAnnouncements().then(
      (s) => { if (alive) setStatus(s) },
      () => { /* 確かめられない時(古い GAS など)は何も出さない */ },
    )
    return () => { alive = false }
  }, [])

  if (!status || !status.announcements.length) return null
  const { shown, hidden } = arrangeAnnouncements(status.announcements, read)
  const fmt = (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium' }).format(new Date(iso)) : '')
  const markRead = (id: string) => {
    const next = [...read.filter((x) => x !== id), id]
    setRead(next)
    saveRead(next)
  }
  const item = (a: Announcement, isRead: boolean) => (
    <li key={a.announcementId} data-announcement={a.importance} className={'rounded-md px-3 py-2 text-xs ' + TONES[a.importance]}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="rounded bg-background/70 px-1.5 py-0.5 font-medium">{t(LABEL_KEYS[a.importance])}</span>
        <span className="min-w-0 font-medium break-words">{a.title}</span>
        <span className="text-foreground/70">{t('announcements.published', { date: fmt(a.publishedAt) })}</span>
      </div>
      <p className="mt-1 break-words whitespace-pre-wrap text-foreground/90">{a.body}</p>
      {!isRead && a.importance !== 'urgent' && (
        <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => markRead(a.announcementId)}>{t('announcements.markRead')}</Button>
      )}
    </li>
  )

  return (
    <section data-announcements className="border-b border-border px-4 py-2">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <Megaphone className="size-3.5 shrink-0" />
        {t('announcements.title')}
      </p>
      {status.stale && <p className="mb-1.5 text-xs text-muted-foreground">{t('announcements.stale')}</p>}
      <ul className="space-y-1.5">
        {shown.map((a) => item(a, false))}
        {showRead && hidden.map((a) => item(a, true))}
      </ul>
      {hidden.length > 0 && (
        <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => setShowRead((v) => !v)}>
          {showRead ? t('announcements.hideRead') : t('announcements.showRead', { count: String(hidden.length) })}
        </Button>
      )}
      {shown.some((a) => a.importance === 'urgent') && <p className="mt-1 text-[11px] text-muted-foreground">{t('announcements.urgentNote')}</p>}
    </section>
  )
}
