import type { Metadata } from 'next'
import { StaticPage } from '@/components/ohsumi/static-page'

export const metadata: Metadata = { title: '利用規約 | Ohsumi' }

export default function Page() {
  return <StaticPage title="利用規約" />
}
