import type { Metadata } from 'next'
import { RegistryAdmin } from '@/components/registry/registry-admin'

// レジストリの管理画面。Ohsumi 本体の画面からはリンクせず、検索エンジンにも載せない
export const metadata: Metadata = {
  title: 'レジストリ管理 | Ohsumi',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
}

export default function Page() {
  return <RegistryAdmin />
}
