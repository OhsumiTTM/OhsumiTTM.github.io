import type { Metadata } from 'next'
import { Check } from 'lucide-react'
import { CTASection, PageHero } from '@/components/site/blocks'
import { ProductScreenshot } from '@/components/site/product-screenshot'
import { Container, Em, SecondaryCta } from '@/components/site/primitives'
import { cn } from '@/lib/utils'
import { SCREENS, USE_CASES } from '@/lib/site/content'

export const metadata: Metadata = {
  title: '利用シーン',
  description:
    'Ohsumiの利用シーン。一般メンバー・PJリーダー・管理者・育成担当・学生団体やPJ型組織など、立場ごとのタスク管理と人材育成・人材管理での使い方を紹介します。',
  alternates: { canonical: '/use-cases/' },
}

export default function UseCasesPage() {
  return (
    <>
      <PageHero
        eyebrow="Use cases"
        title={
          <>
            立場に合わせて、
            <br />
            <Em>Ohsumiの使い方</Em>を見る。
          </>
        }
      >
        <nav aria-label="利用者一覧" className="-mx-5 overflow-x-auto px-5 pt-2 md:mx-0 md:px-0">
          <ul className="flex gap-2 md:flex-wrap">
            {USE_CASES.map((u) => (
              <li key={u.slug}>
                <a href={`#${u.slug}`} className="inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-border bg-background px-3 text-sm font-bold text-foreground hover:border-primary/40 hover:text-primary">
                  {u.role}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageHero>

      {USE_CASES.map((u, i) => (
        <section key={u.slug} id={u.slug} aria-labelledby={`${u.slug}-title`} className={cn('scroll-mt-16 py-20 md:py-24', i % 2 === 1 ? 'bg-surface' : 'bg-background')}>
          <Container className={cn('grid items-center gap-10 lg:grid-cols-[1fr_1.3fr] lg:gap-14', i % 2 === 1 && 'lg:[&>*:first-child]:order-2')}>
            <div className="flex flex-col gap-6">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">For</p>
              <h2 id={`${u.slug}-title`} className="text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
                {u.role}
              </h2>
              <p className="text-lg font-bold leading-relaxed text-foreground">{u.summary}</p>
              <ul className="grid grid-cols-2 gap-2">
                {u.points.map((p) => (
                  <li key={p} className="flex items-center gap-2 rounded-lg bg-pale px-3 py-2.5 text-sm font-bold text-foreground">
                    <Check className="size-4 shrink-0 text-primary" aria-hidden />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="text-base leading-relaxed text-muted-foreground">{u.scenario}</p>
              <SecondaryCta href={u.cta.href} className="w-fit">
                {u.cta.label}
              </SecondaryCta>
            </div>
            <ProductScreenshot screen={SCREENS[u.screen]} />
          </Container>
        </section>
      ))}

      <CTASection />
    </>
  )
}
