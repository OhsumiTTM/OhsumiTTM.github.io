import type { Metadata } from 'next'
import { StaticPage } from '@/components/ohsumi/static-page'

export const metadata: Metadata = { title: 'プライバシーポリシー | Ohsumi' }

export default function Page() {
  return <StaticPage name="privacy" />
}
