import type { Metadata } from 'next'
import SiteLayout from '@/app/(site)/layout'
import { HomePage } from '@/components/site/home-page'
import { RootSwitch } from '@/components/site/root-switch'
import { IS_DEMO } from '@/lib/demo/config'

export const metadata: Metadata = IS_DEMO
  ? { title: { absolute: 'Ohsumi デモ' }, robots: { index: false, follow: false } }
  : {
      title: { absolute: 'Ohsumi | 仕事を進めるほど、組織が見えてくる。組織運営プラットフォーム' },
      alternates: { canonical: '/' },
    }

// ?org= があれば Ohsumi の画面、無ければホームページ(components/site/root-switch.tsx)。
// デモ(/demo/)は、いつも Ohsumi の画面なので、ホームページを書き出さない
export default function Page() {
  return (
    <RootSwitch
      home={
        IS_DEMO ? null : (
          <SiteLayout>
            <HomePage />
          </SiteLayout>
        )
      }
    />
  )
}
