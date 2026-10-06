'use client'

// ヘッダー左上の団体のロゴ・団体名。押すと、この端末に保存した団体(loadSavedOrgs)の一覧が開き、選ぶと切り替える。
//   ・今の団体に印(チェック)を付ける
//   ・ほかの団体が無い時は、今の団体名だけを出す(ボタンにしない。切り替えの印 ▼ も出さない)
//   ・スマートフォンでは団体名を出さないので、ロゴ(無ければ頭文字)を押して開く
//   ・キーボード: Enter・Space・↓ で開く、↑↓ で選ぶ、Home・End、Esc で閉じてボタンに戻る
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { getCurrentOrgId, loadSavedOrgs, switchToOrg, type SavedOrg } from '@/lib/ohsumi/org-directory'
import { cn } from '@/lib/utils'
import { StoredImage } from './primitives'

function OrgMark({ name, logoUrl }: { name: string; logoUrl: string }) {
  const { t } = useI18n()
  if (logoUrl) return <StoredImage url={logoUrl} alt={name || t('header.logoAlt')} className="size-[18px] shrink-0 rounded object-contain" />
  // ロゴが無い時は頭文字(スマートフォンでは団体名を出さないため、これを押して開く)
  return (
    <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center rounded bg-primary-muted text-[10px] font-semibold text-foreground sm:hidden">
      {Array.from(name.trim())[0]?.toUpperCase() ?? ''}
    </span>
  )
}

export function OrgSwitcher({ orgName, orgLogoUrl }: { orgName: string; orgLogoUrl: string }) {
  const { t } = useI18n()
  const [others, setOthers] = useState<SavedOrg[]>([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // 保存した団体はこの端末の保存から読む(描画の後に読む)
  useEffect(() => {
    const current = getCurrentOrgId()
    setOthers(loadSavedOrgs().filter((o) => o.orgId !== current))
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (!orgName && !orgLogoUrl) return null
  const name = orgName || ''

  // ほかの団体が無い: 団体名だけ(切り替えの印は出さない)
  if (others.length === 0) {
    return (
      <span className="flex min-w-0 items-center gap-2" data-org-current>
        <span className="hidden text-muted-foreground/40 sm:inline" aria-hidden>|</span>
        {orgLogoUrl && <StoredImage url={orgLogoUrl} alt={name || t('header.logoAlt')} className="size-[18px] shrink-0 rounded object-contain" />}
        {name && <span className="hidden truncate text-[13px] text-muted-foreground sm:inline">{name}</span>}
      </span>
    )
  }

  // 一覧の項目: 0 = 今の団体、1〜 = ほかの団体
  const count = others.length + 1
  const focusItem = (i: number) => itemRefs.current[(i + count) % count]?.focus()
  const openMenu = (focus: number) => {
    setOpen(true)
    requestAnimationFrame(() => focusItem(focus))
  }
  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }
  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu(0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu(count - 1)
    }
  }
  const onMenuKey = (e: KeyboardEvent) => {
    const at = itemRefs.current.findIndex((el) => el === document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(at + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(at - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0) }
    else if (e.key === 'End') { e.preventDefault(); focusItem(count - 1) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className="relative flex min-w-0 items-center" ref={rootRef}>
      <span className="mr-1 hidden text-muted-foreground/40 sm:inline" aria-hidden>|</span>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu(0))}
        onKeyDown={onButtonKey}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="ohsumi-org-menu"
        aria-label={t('header.org.menuAria', { name: name || t('header.logoAlt') })}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-org-switcher
      >
        <OrgMark name={name} logoUrl={orgLogoUrl} />
        {name && <span className="hidden truncate text-[13px] sm:inline">{name}</span>}
        <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div
          id="ohsumi-org-menu"
          role="menu"
          aria-label={t('header.menu.switchOrg')}
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg animate-in fade-in slide-in-from-top-1"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{t('header.menu.switchOrg')}</div>
          <button
            ref={(el) => { itemRefs.current[0] = el }}
            type="button"
            role="menuitemradio"
            aria-checked
            onClick={() => close()}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
          >
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{t('header.org.current')}</span>
          </button>
          {others.map((o, i) => (
            <button
              key={o.orgId}
              ref={(el) => { itemRefs.current[i + 1] = el }}
              type="button"
              role="menuitemradio"
              aria-checked={false}
              onClick={() => { setOpen(false); switchToOrg(o.orgId) }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
              data-switch-org={o.orgId}
            >
              <span className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{o.name || o.orgId}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
