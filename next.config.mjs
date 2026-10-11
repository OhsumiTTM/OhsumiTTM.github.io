// The site is served from the root of its domain (a <user>.github.io site or a
// custom domain), so no basePath / assetPrefix is needed.
//
// デモ(NEXT_PUBLIC_OHSUMI_DEMO=1。scripts/build-demo.mjs)だけは /demo/ に置く。
// その時だけ lib/demo/entry.ts を lib/demo/entry.demo.tsx に差し替える(本番のビルドにはデモの部品を入れない)。
const isDemo = process.env.NEXT_PUBLIC_OHSUMI_DEMO === '1'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // /about/ などを about/index.html として出力する(GitHub Pages で末尾が / の URL を開けるように)
  trailingSlash: true,
  agentRules: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  ...(isDemo
    ? {
        basePath: '/demo',
        turbopack: { resolveAlias: { '@/lib/demo/entry': './lib/demo/entry.demo.tsx' } },
      }
    : {}),
}

export default nextConfig
