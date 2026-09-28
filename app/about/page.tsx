import type { Metadata } from 'next'
import { StaticPage } from '@/components/ohsumi/static-page'

export const metadata: Metadata = { title: 'Ohsumi について | Ohsumi' }

export default function Page() {
  return <StaticPage title="Ohsumi について" />
}
