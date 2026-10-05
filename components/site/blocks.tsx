import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate, type Feature, type NewsPost, type UseCase } from '@/lib/site/content'
import { Container, CtaPair, Eyebrow, SectionHeader } from './primitives'

export function PageHero({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="border-b border-border bg-surface">
      <Container className="flex flex-col gap-6 py-16 md:py-24">
        <SectionHeader as="h1" eyebrow={eyebrow} title={title} description={description} />
        {children}
      </Container>
    </section>
  )
}

export function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const Icon = feature.icon
  return (
    <li className="h-full">
      <Link
        href={`/features#${feature.slug}`}
        className="group flex h-full flex-col gap-4 rounded-xl border border-border bg-card p-6 outline-none transition-colors hover:border-primary/40 hover:bg-pale/40 focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <div className="flex items-center justify-between">
          <span className="flex size-10 items-center justify-center rounded-lg bg-pale text-primary">
            <Icon className="size-5" aria-hidden />
          </span>
          <span className="text-xs font-bold tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-extrabold text-foreground">{feature.name}</h3>
          <p className="text-xs font-bold text-muted-foreground">{feature.jpName}</p>
        </div>
        <p className="flex-1 text-sm leading-relaxed text-muted-foreground">{feature.summary}</p>
        <span className="inline-flex items-center gap-1 text-sm font-bold text-primary">
          詳しく見る
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </Link>
    </li>
  )
}

export function UseCaseCard({ useCase }: { useCase: UseCase }) {
  return (
    <li className="flex h-full flex-col gap-4 rounded-xl border border-border bg-card p-6">
      <h3 className="text-lg font-extrabold text-foreground">{useCase.role}</h3>
      <p className="flex-1 text-sm leading-relaxed text-muted-foreground">{useCase.summary}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label={`${useCase.role}が確認できること`}>
        {useCase.points.map((p) => (
          <li key={p} className="rounded-md bg-pale px-2 py-1 text-xs font-bold text-secondary-foreground">
            {p}
          </li>
        ))}
      </ul>
    </li>
  )
}

export function FlowSteps({
  steps,
  variant = 'compact',
}: {
  steps: { title: string; body?: string; items?: string[] }[]
  variant?: 'compact' | 'detailed'
}) {
  if (variant === 'compact') {
    return (
      <ol className="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-0">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-center gap-3 md:flex-1 md:gap-0">
            <div className="flex flex-1 items-center gap-3 rounded-xl border border-border bg-card px-4 py-4 md:flex-col md:gap-2 md:text-center">
              <span className="text-xs font-bold tracking-[0.14em] text-primary">{`STEP ${String(i + 1).padStart(2, '0')}`}</span>
              <span className="text-base font-extrabold text-foreground">{s.title}</span>
            </div>
            {i < steps.length - 1 && (
              <ArrowRight className="hidden size-4 shrink-0 text-primary md:mx-2 md:block" aria-hidden />
            )}
          </li>
        ))}
      </ol>
    )
  }
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.title} className="relative flex gap-5 pb-10 last:pb-0 md:gap-8">
          {i < steps.length - 1 && <span className="absolute top-12 bottom-0 left-6 w-0.5 bg-primary/25" aria-hidden />}
          <span className="relative z-10 flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-extrabold text-primary-foreground">
            {String(i + 1).padStart(2, '0')}
          </span>
          <div className="flex flex-1 flex-col gap-3 rounded-xl border border-border bg-card p-6">
            <p className="text-xs font-bold tracking-[0.14em] text-primary">{`STEP ${String(i + 1).padStart(2, '0')}`}</p>
            <h3 className="text-xl font-extrabold text-foreground">{s.title}</h3>
            {s.body && <p className="text-base leading-relaxed text-muted-foreground">{s.body}</p>}
            {s.items && (
              <ul className="flex flex-wrap gap-2">
                {s.items.map((it) => (
                  <li key={it} className="inline-flex items-center gap-1.5 rounded-md bg-pale px-2.5 py-1 text-sm font-bold text-secondary-foreground">
                    <Check className="size-3.5" aria-hidden />
                    {it}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function ComparisonTable({
  rows,
  caption,
}: {
  rows: { aspect: string; general: string; ohsumi: string }[]
  caption: string
}) {
  return (
    <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 overflow-hidden rounded-xl border border-border text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="w-32 border-b border-border bg-surface px-5 py-4 text-sm font-bold text-muted-foreground">
              観点
            </th>
            <th scope="col" className="border-b border-border bg-surface px-5 py-4 text-sm font-bold text-muted-foreground">
              一般的なタスク管理
            </th>
            <th scope="col" className="border-b border-primary bg-primary px-5 py-4 text-sm font-bold text-primary-foreground">
              Ohsumi
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const border = i < rows.length - 1 ? 'border-b border-border' : ''
            return (
              <tr key={r.aspect}>
                <th scope="row" className={cn('bg-background px-5 py-5 text-sm font-extrabold text-foreground', border)}>
                  {r.aspect}
                </th>
                <td className={cn('bg-background px-5 py-5 text-sm leading-relaxed text-muted-foreground', border)}>{r.general}</td>
                <td className={cn('bg-pale px-5 py-5 text-sm font-bold leading-relaxed text-foreground', border)}>{r.ohsumi}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function NewsCard({ post, headingLevel = 'h3' }: { post: NewsPost; headingLevel?: 'h2' | 'h3' }) {
  const Heading = headingLevel
  return (
    <li>
      <Link
        href={`/news/${post.slug}`}
        className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-6 outline-none transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <div className="flex items-center gap-3 text-xs">
          <time dateTime={post.date} className="font-bold tabular-nums text-muted-foreground">
            {formatDate(post.date)}
          </time>
          <span className="rounded-md bg-pale px-2 py-0.5 font-bold text-secondary-foreground">{post.category}</span>
        </div>
        <Heading className="text-pretty text-base font-extrabold leading-snug text-foreground group-hover:text-primary">
          {post.title}
        </Heading>
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{post.excerpt}</p>
      </Link>
    </li>
  )
}

export function CTASection({
  title = (
    <>
      仕事を進めるほど、
      <br />
      組織が見えてくる。
    </>
  ),
  description = 'Ohsumiがあなたの組織でどのように使えるか、一緒に考えます。',
}: {
  title?: ReactNode
  description?: ReactNode
}) {
  return (
    <section className="bg-background py-20 md:py-28">
      <Container>
        <div className="relative overflow-hidden rounded-3xl bg-navy px-6 py-14 text-navy-foreground md:px-16 md:py-20">
          <svg className="pointer-events-none absolute -right-24 -bottom-40 size-[28rem] text-primary md:-right-10" viewBox="0 0 100 100" aria-hidden>
            <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="0.6" />
            <circle cx="50" cy="50" r="26" fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.6" />
            <circle cx="78.3" cy="21.7" r="2.4" fill="currentColor" />
          </svg>
          <div className="relative flex max-w-2xl flex-col gap-6">
            <Eyebrow className="text-navy-foreground/70">Get started</Eyebrow>
            <h2 className="text-balance text-3xl font-extrabold leading-tight tracking-tight md:text-5xl">{title}</h2>
            <p className="text-base leading-relaxed text-navy-foreground/80 md:text-lg">{description}</p>
            <CtaPair className="pt-2 [&>a:last-child]:border-navy-foreground/30 [&>a:last-child]:bg-transparent [&>a:last-child]:text-navy-foreground [&>a:last-child]:hover:bg-navy-foreground/10" />
          </div>
        </div>
      </Container>
    </section>
  )
}
