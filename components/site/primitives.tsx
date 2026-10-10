import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATUS_META, type ProvisionStatus } from '@/lib/site/content'
import { CTA } from '@/lib/site/config'

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-5 md:px-8', className)}>{children}</div>
}

export function Section({
  id,
  tone = 'white',
  className,
  children,
}: {
  id?: string
  tone?: 'white' | 'surface'
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} className={cn('py-20 md:py-28', tone === 'surface' ? 'bg-surface' : 'bg-background', className)}>
      <Container>{children}</Container>
    </section>
  )
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-xs font-semibold uppercase tracking-[0.2em] text-primary', className)}>{children}</p>
  )
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'left',
  as: Heading = 'h2',
  className,
}: {
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  align?: 'left' | 'center'
  as?: 'h1' | 'h2' | 'h3'
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex max-w-3xl flex-col gap-4',
        align === 'center' && 'mx-auto items-center text-center',
        className,
      )}
    >
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <Heading className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-foreground md:text-4xl">
        {title}
      </Heading>
      {description && (
        <p className="text-pretty text-base leading-relaxed text-muted-foreground md:text-lg">{description}</p>
      )}
    </div>
  )
}

export function Em({ children }: { children: ReactNode }) {
  return <span className="text-primary">{children}</span>
}

const ctaBase =
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-6 text-sm font-bold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40'

export function PrimaryCta({ className, href = CTA.primary.href, children = CTA.primary.label }: { className?: string; href?: string; children?: ReactNode }) {
  return (
    <Link href={href} className={cn(ctaBase, 'bg-primary text-primary-foreground hover:bg-primary/90', className)}>
      {children}
      <ArrowRight className="size-4" aria-hidden />
    </Link>
  )
}

export function SecondaryCta({ className, href = CTA.secondary.href, children = CTA.secondary.label }: { className?: string; href?: string; children?: ReactNode }) {
  const cls = cn(ctaBase, 'border border-border bg-background text-foreground hover:border-primary/40 hover:bg-pale', className)
  // デモ(/demo/)は別のビルドの画面なので、ページごと開く
  if (href.startsWith('/demo/')) return <a href={href} className={cls}>{children}</a>
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}

export function TextLink({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  const Icon = external ? ArrowUpRight : ArrowRight
  const content = (
    <>
      {children}
      <Icon className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </>
  )
  const cls =
    'group inline-flex items-center gap-1.5 text-sm font-bold text-primary underline-offset-4 hover:underline focus-visible:underline outline-none'
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {content}
      <span className="sr-only">（外部サイトが開きます）</span>
    </a>
  ) : (
    <Link href={href} className={cls}>
      {content}
    </Link>
  )
}

export function CtaPair({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row', className)}>
      <PrimaryCta />
      <SecondaryCta />
    </div>
  )
}

const statusStyle: Record<ProvisionStatus, string> = {
  available: 'border-primary bg-primary text-primary-foreground',
  developing: 'border-primary/30 bg-pale text-secondary-foreground',
  concept: 'border-dashed border-muted-foreground/50 bg-background text-muted-foreground',
}

const statusDot: Record<ProvisionStatus, string> = {
  available: 'bg-primary-foreground',
  developing: 'bg-primary',
  concept: 'border border-muted-foreground bg-transparent',
}

export function StatusBadge({ status, className }: { status: ProvisionStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold',
        statusStyle[status],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', statusDot[status])} aria-hidden />
      <span className="sr-only">提供状況：</span>
      {STATUS_META[status].label}
    </span>
  )
}

export function PendingNote({ children = '詳細は現在準備中です。正式提供内容に合わせて更新予定です。' }: { children?: ReactNode }) {
  return (
    <p className="inline-flex items-center gap-2 rounded-md border border-dashed border-border bg-surface px-3 py-1.5 text-sm text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full border border-muted-foreground" aria-hidden />
      {children}
    </p>
  )
}
