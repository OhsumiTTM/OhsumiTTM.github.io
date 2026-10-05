'use client'

import type React from 'react'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { CTA, NAV } from '@/lib/site/config'
import { OhsumiLogo } from './logo'
import { PrimaryCta, SecondaryCta } from './primitives'

export function SiteHeader() {
  const pathname = usePathname()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => setOpen(false), [pathname])

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <header
      className={cn(
        'sticky top-0 z-40 border-b bg-background/95 backdrop-blur transition-[border-color,box-shadow]',
        scrolled ? 'border-border shadow-[0_1px_12px_-6px_rgb(12_27_50/0.15)]' : 'border-transparent',
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-5 md:px-8">
        <Link href="/" className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
          <OhsumiLogo />
          <span className="sr-only">Ohsumi トップページ</span>
        </Link>

        <nav aria-label="メインナビゲーション" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/40',
                    isActive(item.href) ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          {/* 利用中の団体の人の入口。ページを読み込み直して Ohsumi の画面(保存した団体の一覧・招待リンクの案内)を出す */}
          <a href="/?login=1" className="px-3 text-sm font-medium text-foreground hover:text-primary">
            ログイン
          </a>
          <SecondaryCta className="min-h-10 px-4" />
          <PrimaryCta className="min-h-10 px-4" />
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            className="inline-flex size-11 items-center justify-center rounded-lg border border-border text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40 lg:hidden"
            aria-label="メニューを開く"
          >
            <Menu className="size-5" aria-hidden />
          </SheetTrigger>
          <SheetContent side="right" className="w-full max-w-sm gap-0 p-0">
            <SheetTitle className="sr-only">メニュー</SheetTitle>
            <div className="flex h-16 items-center border-b border-border px-5">
              <OhsumiLogo />
            </div>
            <nav aria-label="モバイルナビゲーション" className="flex-1 overflow-y-auto px-3 py-4">
              <ul className="flex flex-col">
                {[...NAV, { href: '/news', label: 'News / Updates' }, { href: '/about', label: 'About' }, { href: '/?login=1', label: 'ログイン' }].map((item) => (
                  <li key={item.href}>
                    <NavAnchor
                      href={item.href}
                      aria-current={isActive(item.href) ? 'page' : undefined}
                      className={cn(
                        'flex min-h-12 items-center rounded-md px-3 text-base font-medium hover:bg-pale',
                        isActive(item.href) ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {item.label}
                    </NavAnchor>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex flex-col gap-3 border-t border-border p-5">
              <PrimaryCta href={CTA.primary.href} />
              <SecondaryCta />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  )
}

// ?login= などで Ohsumi の画面へ切り替えるリンクは、読み込み直す(<a>)。ほかはページ内の移動(Link)
function NavAnchor(props: React.ComponentProps<typeof Link> & { href: string }) {
  if (props.href.startsWith('/?')) {
    const { href, children, className, ...rest } = props
    return <a href={href} className={className} aria-current={rest['aria-current']}>{children}</a>
  }
  return <Link {...props} />
}
