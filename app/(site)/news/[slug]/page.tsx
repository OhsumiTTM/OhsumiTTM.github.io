import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { CTASection } from '@/components/site/blocks'
import { Container } from '@/components/site/primitives'
import { NEWS, formatDate } from '@/lib/site/content'

export function generateStaticParams() {
  return NEWS.map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const post = NEWS.find((p) => p.slug === slug)
  if (!post) return {}
  return { title: post.title, description: post.excerpt, alternates: { canonical: `/news/${slug}/` } }
}

export default async function NewsDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = NEWS.find((p) => p.slug === slug)
  if (!post) notFound()

  return (
    <>
      <article className="bg-background py-14 md:py-20">
        <Container className="flex max-w-3xl flex-col gap-8">
          <Link href="/news" className="inline-flex w-fit items-center gap-1.5 text-sm font-bold text-primary hover:underline">
            <ArrowLeft className="size-4" aria-hidden />
            News / Updates 一覧
          </Link>
          <header className="flex flex-col gap-4 border-b border-border pb-8">
            <div className="flex items-center gap-3 text-sm">
              <time dateTime={post.date} className="font-bold tabular-nums text-muted-foreground">
                {formatDate(post.date)}
              </time>
              <span className="rounded-md bg-pale px-2 py-0.5 text-xs font-bold text-secondary-foreground">{post.category}</span>
            </div>
            <h1 className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-foreground md:text-4xl">{post.title}</h1>
          </header>
          <div className="flex flex-col gap-5">
            {post.body.map((para) => (
              <p key={para} className="text-base leading-loose text-foreground">
                {para}
              </p>
            ))}
          </div>
        </Container>
      </article>
      <CTASection />
    </>
  )
}
