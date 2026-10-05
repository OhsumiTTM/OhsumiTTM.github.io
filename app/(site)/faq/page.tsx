import type { Metadata } from 'next'
import { CTASection, PageHero } from '@/components/site/blocks'
import { FAQAccordion } from '@/components/site/faq-accordion'
import { Container } from '@/components/site/primitives'
import { FAQ } from '@/lib/site/content'

export const metadata: Metadata = {
  title: 'FAQ よくある質問',
  description: 'Ohsumiについてのよくある質問。一般的なタスク管理との違い、対象組織、導入、料金、データの保存先などについてお答えします。',
  alternates: { canonical: '/faq' },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.flatMap((c) => c.items).map((i) => ({
    '@type': 'Question',
    name: i.q,
    acceptedAnswer: { '@type': 'Answer', text: i.a },
  })),
}

export default function FaqPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <PageHero eyebrow="FAQ" title="よくある質問" description="掲載されていないご質問は、お問い合わせフォームからお気軽にどうぞ。">
        <nav aria-label="FAQカテゴリ">
          <ul className="flex flex-wrap gap-2 pt-2">
            {FAQ.map((c) => (
              <li key={c.id}>
                <a href={`#${c.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-border bg-background px-3 text-sm font-bold text-foreground hover:border-primary/40 hover:text-primary">
                  {c.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageHero>
      <section className="bg-background py-16 md:py-24">
        <Container className="flex max-w-4xl flex-col gap-14">
          {FAQ.map((c) => (
            <section key={c.id} id={c.id} aria-labelledby={`${c.id}-title`} className="flex scroll-mt-20 flex-col gap-5">
              <h2 id={`${c.id}-title`} className="text-2xl font-extrabold tracking-tight text-foreground">
                {c.label}
              </h2>
              <FAQAccordion items={c.items} />
            </section>
          ))}
        </Container>
      </section>
      <CTASection />
    </>
  )
}
