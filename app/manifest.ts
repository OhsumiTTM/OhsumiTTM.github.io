import type { MetadataRoute } from 'next'

// ホーム画面に追加した時のアイコンと名前(Android)。アイコンはロゴのシンボルだけ(scripts/brand-icons.mjs で作る)。
// 開く URL は決めない(アドレスバーの /?org=<団体ID> を開かせ、団体が残るように。lib/ohsumi/home-screen.test.ts)
export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Ohsumi',
    short_name: 'Ohsumi',
    display: 'standalone',
    background_color: '#f6f8fc',
    theme_color: '#f6f8fc',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
