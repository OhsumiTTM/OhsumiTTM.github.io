import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { FOOTER_NAV, SITE } from '@/lib/site/config'
import { OhsumiLogo } from './logo'
import { Container } from './primitives'

export function SiteFooter() {
  return (
    <footer className="bg-navy text-navy-foreground">
      <Container className="flex flex-col gap-12 py-16">
        <div className="flex flex-col justify-between gap-10 md:flex-row">
          <div className="flex max-w-xs flex-col gap-4">
            <Link href="/" className="w-fit rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/60">
              <OhsumiLogo inverted />
              <span className="sr-only">Ohsumi トップページ</span>
            </Link>
            <p className="text-sm leading-relaxed text-navy-foreground/70">
              仕事を中心に、人・プロジェクト・組織・知識をつなぐ組織運営プラットフォーム。
            </p>
          </div>
          <nav aria-label="フッターナビゲーション">
            <ul className="grid grid-cols-2 gap-x-12 gap-y-3 sm:grid-cols-3">
              {FOOTER_NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-sm text-navy-foreground/80 hover:text-navy-foreground hover:underline">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="flex flex-col gap-6 border-t border-navy-foreground/15 pt-8 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-xs uppercase tracking-[0.18em] text-navy-foreground/60">Developed &amp; Operated by</p>
            <a
              href={SITE.fsifUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1 text-sm font-bold hover:underline"
            >
              {SITE.operator}
              <ArrowUpRight className="size-4" aria-hidden />
              <span className="sr-only">（FSIF公式サイトが開きます）</span>
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-navy-foreground/60">
            <Link href="/terms" className="hover:text-navy-foreground hover:underline">
              利用規約
            </Link>
            <Link href="/privacy" className="hover:text-navy-foreground hover:underline">
              プライバシーポリシー
            </Link>
            <p>{`© ${new Date().getFullYear()} ${SITE.operator}`}</p>
          </div>
        </div>
      </Container>
    </footer>
  )
}
