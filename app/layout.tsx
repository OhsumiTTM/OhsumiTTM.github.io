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
  title: 'Ohsumi — タスクを打ち上げ、組織を軌道に乗せる',
  description:
    'Ohsumi は Task Management × Talent Management × Human Development を接続する組織運営システムです。',
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
      <head>
        {/* ?org= か ?login= がある時は、ホームページを描く前に隠す(Ohsumi の画面を出すため。components/site/root-switch.tsx) */}
        <script
          dangerouslySetInnerHTML={{
            __html: "if(/[?&](org|login)=/.test(location.search))document.documentElement.classList.add('ohsumi-app')",
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <FrameGuard>{children}</FrameGuard>
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      </body>
    </html>
  )
}
