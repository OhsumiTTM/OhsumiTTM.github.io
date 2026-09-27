// The site is served from the root of its domain (a <user>.github.io site or a
// custom domain), so no basePath / assetPrefix is needed.

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  agentRules: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
