// サイトマップに載せるページ(紹介サイト・規約)。Ohsumi の画面(?org=)と、レジストリの管理画面は入れない。
// URL は末尾が / の形(next.config の trailingSlash と同じ)。お知らせ(/news/<slug>/)は app/sitemap.ts で足す
export const SITEMAP_PATHS = [
  '/', '/overview/', '/features/', '/use-cases/', '/onboarding/', '/security/', '/faq/', '/news/', '/contact/', '/apply/',
  '/about/', '/terms/', '/privacy/',
]
