import type { Metadata } from 'next'
import SiteLayout from '@/app/(site)/layout'
import { HomePage } from '@/components/site/home-page'
import { RootSwitch } from '@/components/site/root-switch'

export const metadata: Metadata = {
  title: { absolute: 'Ohsumi（オオスミ）| 仕事を進めるほど、組織が見えてくる。組織運営プラットフォーム' },
  alternates: { canonical: '/' },
}

// ?org= があれば Ohsumi の画面、無ければホームページ(components/site/root-switch.tsx)
export default function Page() {
  return (
    <RootSwitch
      home={
        <SiteLayout>
          <HomePage />
        </SiteLayout>
      }
    />
  )
}
