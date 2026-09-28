// The site is served from the root of its domain (a <user>.github.io site or a
// custom domain), so no basePath / assetPrefix is needed.

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
}

export default nextConfig
