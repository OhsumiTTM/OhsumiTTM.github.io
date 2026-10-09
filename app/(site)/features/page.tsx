import type { Metadata } from 'next'
import Link from 'next/link'
import { Check } from 'lucide-react'
import { CTASection, PageHero } from '@/components/site/blocks'
import { ScreenFigure } from '@/components/site/product-screenshot'
import { Container, Em, StatusBadge } from '@/components/site/primitives'
import { cn } from '@/lib/utils'
import { FEATURES, SCREENS, STATUS_META, getFeature, type ProvisionStatus } from '@/lib/site/content'

export const metadata: Metadata = {
  title: '機能',
  description:
    'Ohsumiの機能一覧。タスク管理・プロジェクト管理・ワークフロー・承認と確認(登録の承認・完了の確認)・日報と申請・通知・人材情報・人材育成・分析・権限管理を、解決する課題と実際の画面とともに紹介します。',
  alternates: { canonical: '/features/' },
}

function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{children}</h3>
}

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title={
          <>
            仕事の実行から、
            <br />
            <Em>組織運営</Em>まで。
          </>
        }
        description="それぞれの機能が解決する課題と、実際の画面を紹介します。画面は、サンプルのデータを入れた Ohsumi の画面です。"
      >
        <nav aria-label="機能一覧" className="-mx-5 overflow-x-auto px-5 pt-2 md:mx-0 md:px-0">
          <ul className="flex gap-2 md:flex-wrap">
            {FEATURES.map((f) => (
              <li key={f.slug}>
                <a
                  href={`#${f.slug}`}
                  className="inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-border bg-background px-3 text-sm font-bold text-foreground hover:border-primary/40 hover:text-primary"
                >
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <dl className="flex flex-col gap-2 pt-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-6">
          {(Object.keys(STATUS_META) as ProvisionStatus[]).map((s) => (
            <div key={s} className="flex items-center gap-2">
              <dt>
                <StatusBadge status={s} />
              </dt>
              <dd className="text-muted-foreground">{STATUS_META[s].description}</dd>
            </div>
          ))}
        </dl>
      </PageHero>

      {FEATURES.map((f, idx) => {
        const Icon = f.icon
        return (
          <section
            key={f.slug}
            id={f.slug}
            aria-labelledby={`${f.slug}-title`}
            className={cn('scroll-mt-16 py-20 md:py-24', idx % 2 === 1 ? 'bg-surface' : 'bg-background')}
          >
            <Container className="flex flex-col gap-10">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-pale text-primary">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="text-sm font-extrabold tabular-nums text-primary">{String(idx + 1).padStart(2, '0')}</span>
                  <StatusBadge status={f.status} />
                </div>
                <h2 id={`${f.slug}-title`} className="text-3xl font-extrabold tracking-tight text-foreground md:text-4xl">
                  {f.name}
                  <span className="mt-1 block text-base font-bold text-muted-foreground md:text-lg">{f.jpName}</span>
                </h2>
              </div>

              <div className={cn('grid gap-10 lg:gap-14', f.screens.length > 0 && 'lg:grid-cols-[1fr_1.4fr]')}>
                <div className="flex flex-col gap-8">
                  <div className="flex flex-col gap-3 rounded-xl bg-navy p-6 text-navy-foreground">
                    <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-navy-foreground/70">解決する課題</h3>
                    <p className="text-base font-medium leading-relaxed">{f.problem}</p>
                  </div>

                  <div className="flex flex-col gap-3">
                    <Label>できること</Label>
                    <ul className="flex flex-col gap-2.5">
                      {f.capabilities.map((c) => (
                        <li key={c.text} className="flex items-start gap-3 text-base leading-relaxed text-foreground">
                          <Check className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
                          <span className="flex flex-1 flex-wrap items-center gap-2">
                            {c.text}
                            {c.status && <StatusBadge status={c.status} />}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="flex flex-col gap-3">
                    <Label>利用例</Label>
                    <p className="text-base leading-relaxed text-muted-foreground">{f.example}</p>
                  </div>

                  <div className="flex flex-col gap-3">
                    <Label>他機能とのつながり</Label>
                    <ul className="flex flex-wrap gap-2">
                      {f.connections.map((slug) => {
                        const c = getFeature(slug)
                        if (!c) return null
                        return (
                          <li key={slug}>
                            <Link
                              href={`#${slug}`}
                              className="inline-flex min-h-9 items-center rounded-md border border-primary/25 bg-pale px-3 text-sm font-bold text-secondary-foreground hover:border-primary"
                            >
                              {c.name}
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </div>

                {f.screens.length > 0 && (
                  <div className="flex flex-col gap-10">
                    {f.screens.map((key, i) => (
                      <ScreenFigure key={key} screen={SCREENS[key]} priority={idx === 0 && i === 0} />
                    ))}
                  </div>
                )}
              </div>
            </Container>
          </section>
        )
      })}

      <CTASection />
    </>
  )
}
