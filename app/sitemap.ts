import type { MetadataRoute } from 'next'
import { SITE } from '@/lib/site/config'
import { NEWS } from '@/lib/site/content'
import { SITEMAP_PATHS } from '@/lib/site/sitemap-paths'

export const dynamic = 'force-static'

// 検索エンジンに知らせるページの一覧。NEXT_PUBLIC_SITE_URL が無いビルドでは空にする
export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE.url.replace(/\/+$/, '')
  if (!base) return []
  const pages = SITEMAP_PATHS.map((path) => ({ url: base + path, changeFrequency: 'monthly' as const, priority: path === '/' ? 1 : 0.7 }))
  const news = NEWS.map((post) => ({ url: `${base}/news/${post.slug}/`, lastModified: post.date, changeFrequency: 'yearly' as const, priority: 0.5 }))
  return [...pages, ...news]
}
