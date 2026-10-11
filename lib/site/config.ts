export const SITE = {
  name: 'Ohsumi',
  reading: 'オオスミ',
  // サイトの URL は直接書かない(独自ドメインの切り替えに合わせて NEXT_PUBLIC_SITE_URL で渡す)
  url: process.env.NEXT_PUBLIC_SITE_URL ?? '',
  fsifUrl: 'https://www.fsif.jp',
  operator: '未来宇宙産業フォーラム(FSIF)',
  operatorShort: 'FSIF',
} as const

export const CTA = {
  primary: { label: '導入を相談する', href: '/contact' },
  // デモ(/demo/)は別にビルドした画面なので、サイトの中の移動(next/link)ではなく、ふつうのリンクで開く
  secondary: { label: 'デモを触る', href: '/demo/' },
  features: { label: '詳しい機能を見る', href: '/features' },
  onboarding: { label: '導入について見る', href: '/onboarding' },
  background: { label: '開発背景を見る', href: SITE.fsifUrl },
} as const

export const NAV = [
  { href: '/overview', label: 'Ohsumiとは' },
  { href: '/features', label: '機能' },
  { href: '/use-cases', label: '利用シーン' },
  { href: '/onboarding', label: '導入について' },
  { href: '/security', label: 'セキュリティ' },
  { href: '/faq', label: 'FAQ' },
] as const

export const FOOTER_NAV = [
  { href: '/overview', label: 'Ohsumiとは' },
  { href: '/features', label: '機能' },
  { href: '/use-cases', label: '利用シーン' },
  { href: '/onboarding', label: '導入について' },
  { href: '/security', label: 'Security' },
  { href: '/faq', label: 'FAQ' },
  { href: '/news', label: 'News / Updates' },
  { href: '/about', label: 'About' },
  { href: '/apply', label: '利用の申請' },
  { href: '/contact', label: 'Contact' },
] as const

// 問い合わせの連絡先(フォームは lib/site/contact-form.ts)
export const CONTACT = {
  email: 'fsif.official@gmail.com',
} as const

