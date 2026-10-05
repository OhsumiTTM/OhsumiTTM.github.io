import type { Metadata } from 'next'
import { NewsCard, PageHero } from '@/components/site/blocks'
import { Container } from '@/components/site/primitives'
import { NEWS } from '@/lib/site/content'

export const metadata: Metadata = {
  title: 'News / Updates',
  description: 'Ohsumiのお知らせ・新機能・改善・セキュリティに関する最新情報。',
  alternates: { canonical: '/news' },
}

export default function NewsPage() {
  const posts = [...NEWS].sort((a, b) => b.date.localeCompare(a.date))
  return (
    <>
      <PageHero eyebrow="News / Updates" title="お知らせ・アップデート" description="新機能、改善、お知らせ、セキュリティに関する情報をお届けします。" />
      <section className="bg-background py-16 md:py-24">
        <Container>
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {posts.map((p) => (
              <NewsCard key={p.slug} post={p} headingLevel="h2" />
            ))}
          </ul>
        </Container>
      </section>
    </>
  )
}
