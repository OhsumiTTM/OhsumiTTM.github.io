import type { MetadataRoute } from 'next'
import { SITE } from '@/lib/site/config'

// 静的に書き出す(output: 'export')
export const dynamic = 'force-static'

// 検索エンジンに、すべてのページを見てよいと伝える。レジストリの管理画面はページ側で noindex にしている
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    ...(SITE.url ? { sitemap: `${SITE.url.replace(/\/+$/, '')}/sitemap.xml` } : {}),
  }
}
