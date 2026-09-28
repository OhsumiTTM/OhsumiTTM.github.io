'use client'

// 紹介ページ・プライバシーポリシー・利用規約へのリンク(ログイン画面とアプリのフッター)
import { useI18n } from '@/lib/ohsumi/i18n'
import { cn } from '@/lib/utils'

export const LEGAL_PAGES = [
  { href: '/about/', key: 'footer.about' },
  { href: '/privacy/', key: 'footer.privacy' },
  { href: '/terms/', key: 'footer.terms' },
] as const

export function LegalLinks({ className }: { className?: string }) {
  const { t } = useI18n()
  return (
    <nav className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {LEGAL_PAGES.map((p) => (
        <a key={p.href} href={p.href} className="underline-offset-2 hover:text-foreground hover:underline">
          {t(p.key)}
        </a>
      ))}
    </nav>
  )
}
