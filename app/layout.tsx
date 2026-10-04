import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
import { FrameGuard } from '@/components/ohsumi/frame-guard'
import './globals.css'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: 'Ohsumi —  仕事を進めるほど、組織が見えてくる。 ',
  description:
    'Ohsumi は 仕事を中心に、人・プロジェクト・組織・知識をつなぐ組織運営プラットフォームです。',
}

export const viewport: Viewport = {
  themeColor: '#f6f8fc',
  colorScheme: 'light',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} bg-background`}
    >
      <body className="font-sans antialiased">
        <FrameGuard>{children}</FrameGuard>
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      </body>
    </html>
  )
}
