import { ArrowRight } from 'lucide-react'
import { CTASection, FeatureCard, FlowSteps, UseCaseCard } from '@/components/site/blocks'
import { ValueCycle, WorkHub } from '@/components/site/diagrams'
import { ProductScreenshot } from '@/components/site/product-screenshot'
import { ScreenTabs } from '@/components/site/screen-tabs'
import { Container, CtaPair, Em, Eyebrow, PrimaryCta, Section, SectionHeader, TextLink } from '@/components/site/primitives'
import { CTA, SITE } from '@/lib/site/config'
import { FEATURES, HOME_SCREEN_TABS, ONBOARDING_STEPS, PROBLEMS, SCREENS, USE_CASES } from '@/lib/site/content'

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', name: SITE.operator, alternateName: SITE.operatorShort, url: SITE.fsifUrl },
    {
      '@type': 'SoftwareApplication',
      name: 'Ohsumi',
      alternateName: 'オオスミ',
      applicationCategory: 'BusinessApplication',
      description: '仕事を中心に、人・プロジェクト・組織・知識をつなぐ組織運営プラットフォーム。',
      url: SITE.url,
      publisher: { '@type': 'Organization', name: SITE.operator },
    },
  ],
}

export function HomePage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <section className="relative overflow-hidden bg-background">
        <svg className="pointer-events-none absolute top-1/2 -right-64 hidden size-[64rem] -translate-y-1/2 text-primary/15 lg:block" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="0.15" />
          <circle cx="50" cy="50" r="33" fill="none" stroke="currentColor" strokeWidth="0.15" />
        </svg>
        <Container className="relative grid items-center gap-12 py-14 md:py-20 lg:grid-cols-[1fr_1.25fr] lg:gap-10 lg:py-24">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Eyebrow>Work &amp; People Platform</Eyebrow>
              <p className="text-sm font-bold text-foreground">組織運営プラットフォーム</p>
            </div>
            <h1 className="text-balance text-4xl font-extrabold leading-[1.2] tracking-tight text-foreground sm:text-5xl lg:text-[3.5rem]">
              仕事を進めるほど、
              <br />
              <Em>組織が見えてくる。</Em>
            </h1>
            <p className="text-pretty text-base leading-relaxed text-muted-foreground md:text-lg">
              仕事を中心に、人・プロジェクト・組織・知識をつなぐ。
              <br className="hidden md:block" />
              仕事の実行を、組織のデータと次の成長につなげます。
            </p>
            <CtaPair className="pt-2 [&>a:first-child]:order-2 [&>a:last-child]:order-1 sm:[&>a:first-child]:order-1 sm:[&>a:last-child]:order-2" />
            <div className="flex flex-col gap-0.5 pt-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Developed &amp; Operated by</p>
              <p className="text-sm font-bold text-foreground">{SITE.operator}</p>
            </div>
          </div>
          <div className="lg:-mr-24 xl:-mr-40">
            <ProductScreenshot screen={SCREENS.dashboard} priority />
          </div>
        </Container>
      </section>

      <Section tone="surface">
        <SectionHeader
          title={
            <>
              組織の仕事、
              <br />
              こんな状態になっていませんか？
            </>
          }
        />
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {PROBLEMS.map((p, i) => (
            <li key={p.title} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
              <span className="text-sm font-extrabold tabular-nums text-primary">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="text-pretty text-base font-extrabold leading-snug text-foreground">{p.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <SectionHeader
          eyebrow="Value cycle"
          title={
            <>
              仕事をするほど、
              <br />
              <Em>組織のデータが育つ。</Em>
            </>
          }
          description="管理のためだけに情報を入力するのではなく、日々の仕事そのものを組織のデータとして残していく。"
        />
        <ValueCycle className="mt-12" />
      </Section>

      <Section tone="surface">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="flex flex-col gap-8">
            <SectionHeader
              eyebrow="Structure"
              title={
                <>
                  仕事を中心に、
                  <br />
                  組織の情報をつなぐ。
                </>
              }
              description="タスク・担当・期限だけでなく、要求スキル・成果物・登録の承認と完了の確認・実績・人材情報までを、1つの仕事に接続します。"
            />
            <TextLink href="/overview">Ohsumiとは</TextLink>
          </div>
          <WorkHub />
        </div>
      </Section>

      <Section>
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <SectionHeader
            eyebrow="Features"
            title={
              <>
                日々の仕事から、
                <br />
                組織運営まで。
              </>
            }
          />
          <TextLink href={CTA.features.href}>{CTA.features.label}</TextLink>
        </div>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.slug} feature={f} index={i} />
          ))}
        </ul>
      </Section>

      <Section tone="surface">
        <SectionHeader
          eyebrow="Product"
          title={
            <>
              Ohsumiを、
              <br />
              実際の画面で見る。
            </>
          }
          description="掲載している画面は、サンプルのデータを入れた Ohsumi の画面です。"
        />
        <div className="mt-12">
          <ScreenTabs screens={HOME_SCREEN_TABS.map((k) => SCREENS[k])} />
        </div>
      </Section>

      <Section>
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <SectionHeader
            eyebrow="For everyone"
            title={
              <>
                立場が違っても、
                <br />
                同じ仕事の情報を使える。
              </>
            }
          />
          <TextLink href="/use-cases">利用シーンを見る</TextLink>
        </div>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.slice(0, 4).map((u) => (
            <UseCaseCard key={u.slug} useCase={u} />
          ))}
        </ul>
      </Section>

      <section className="bg-navy py-20 text-navy-foreground md:py-28">
        <Container className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div className="flex flex-col gap-5">
            <Eyebrow className="text-navy-foreground/70">Origin</Eyebrow>
            <h2 className="text-balance text-3xl font-extrabold leading-tight tracking-tight md:text-4xl">
              実際の組織運営から、
              <br />
              Ohsumiは生まれました。
            </h2>
          </div>
          <div className="flex flex-col gap-6">
            <p className="text-base leading-relaxed text-navy-foreground/80">
              Ohsumiは、未来宇宙産業フォーラム(FSIF)の組織運営上の課題を起点に開発しています。自分たち自身が利用しながら、現場から得たフィードバックをもとに改善しています。
            </p>
            <a
              href={CTA.background.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-sm font-bold text-navy-foreground underline-offset-4 hover:underline"
            >
              {CTA.background.label}
              <ArrowRight className="size-4" aria-hidden />
              <span className="sr-only">（FSIF公式サイトが開きます）</span>
            </a>
          </div>
        </Container>
      </section>

      <Section tone="surface">
        <SectionHeader
          eyebrow="Onboarding"
          title={
            <>
              まずは、
              <br />
              あなたの組織の状況を聞かせてください。
            </>
          }
        />
        <div className="mt-12">
          <FlowSteps steps={ONBOARDING_STEPS} />
        </div>
        <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
          <PrimaryCta />
          <TextLink href={CTA.onboarding.href}>{CTA.onboarding.label}</TextLink>
        </div>
      </Section>

      <CTASection />
    </>
  )
}
