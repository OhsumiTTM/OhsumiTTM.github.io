import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import Script from 'next/script'
import { FrameGuard } from '@/components/ohsumi/frame-guard'
import { SITE } from '@/lib/site/config'
import { IS_DEMO } from '@/lib/demo/config'
import './globals.css'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-geist-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

const DESCRIPTION =
  'Ohsumi(オオスミ)は、タスク・人材・育成をつなぐ組織運営プラットフォームです。仕事を進めるほど、組織の状況と人の成長が見えてきます。未来宇宙産業フォーラム(FSIF)が開発・提供しています。'

// 検索・SNS で表示する情報。サイトの URL は直接書かず、ビルドの時の NEXT_PUBLIC_SITE_URL(GitHub の変数 SITE_URL)から作る
export const metadata: Metadata = {
  ...(SITE.url ? { metadataBase: new URL(SITE.url) } : {}),
  title: 'Ohsumi — 仕事を進めるほど、組織が見えてくる。',
  description: DESCRIPTION,
  applicationName: 'Ohsumi',
  openGraph: {
    type: 'website',
    siteName: 'Ohsumi',
    locale: 'ja_JP',
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Ohsumi — 仕事を進めるほど、組織が見えてくる。' }],
  },
  twitter: { card: 'summary_large_image', images: ['/og.png'] },
  // デモ(/demo/)は検索に出さない
  ...(IS_DEMO ? { title: 'Ohsumi デモ', robots: { index: false, follow: false } } : {}),
}

// ブラウザの上部の色: 端末の設定(prefers-color-scheme)に合わせる。Ohsumi の画面で選んだ表示があれば、
// 下のスクリプトと lib/ohsumi/theme.tsx がそれに合わせる(ホームページなどは明るい表示だけ)
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f8fc' },
    { media: '(prefers-color-scheme: dark)', color: '#08111f' },
  ],
  colorScheme: 'light dark',
}

// 最初の描画の前に動くスクリプト(CSP のハッシュは scripts/csp.mjs がビルドの時に入れる)
//   ・?org= か ?login= がある時は、ホームページを描く前に隠す(Ohsumi の画面を出すため。components/site/root-switch.tsx)。
//     表示は、画面で選んだ表示(ohsumi-theme)、無ければ端末の設定にする(lib/ohsumi/theme.tsx と同じ決め方)
//   ・それ以外(ホームページなど)は明るい表示だけ
//   ・ブラウザの上部の色も、その表示に合わせる
const BEFORE_PAINT_SCRIPT =
  "(function(){var d=document.documentElement,t='light';" +
  "if(" + (IS_DEMO ? 'true' : "/[?&](org|login)=/.test(location.search)") + "){d.classList.add('ohsumi-app');" +
  "try{t=localStorage.getItem('ohsumi-theme')}catch(e){t=null}" +
  "if(t!=='light'&&t!=='dark')t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';" +
  "if(t==='dark')d.classList.add('dark')}" +
  "d.style.colorScheme=t;" +
  "document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('meta[name=theme-color]')" +
  ".forEach(function(m){m.setAttribute('content',t==='dark'?'#08111f':'#f6f8fc')})})})()"

// 版の画面(lib/ohsumi/site-version.ts)。ほかの描画より先に動く:
//   ・版の画面(/_v/<版>/ に置いたビルド)では、アドレスバーを /?org=…&task=… に戻す(リンクは今と同じに見せる)
//   ・main の画面で /_v/ の下が開いた時は、その版の画面が無い(404)。覚えた移る先を消して / に戻す
//   ・main の画面で Ohsumi を開いた時(?org= か ?login=)は、その団体の移る先(端末に覚えた screen)があれば、すぐそこに移る
//     (このタブで1分に3回まで。同じ所を行ったり来たりしないように)
const SITE_VERSION = process.env.NEXT_PUBLIC_SITE_VERSION || ''
const SITE_SCRIPT =
  "(function(){var V=" + JSON.stringify(SITE_VERSION) + ",l=location,P=/^\\d{4}\\.\\d{2}\\.\\d{2}-\\d+$/;" +
  "if(V){if(l.pathname.indexOf('/_v/'+V+'/')===0)history.replaceState(history.state,'','/'+l.search+l.hash);return}" +
  "var bad=l.pathname.indexOf('/_v/')===0;if(!bad&&!/[?&](org|login)=/.test(l.search))return;" +
  "try{var m=/[?&]org=([^&#]*)/.exec(l.search),id=m?decodeURIComponent(m[1]):localStorage.getItem('ohsumi-current-org')," +
  "list=JSON.parse(localStorage.getItem('ohsumi-orgs')||'[]'),o=null,i;" +
  "for(i=0;i<list.length;i++)if(list[i]&&list[i].orgId===id)o=list[i];" +
  "if(bad){if(o){o.screen='';localStorage.setItem('ohsumi-orgs',JSON.stringify(list))}l.replace('/'+l.search+l.hash);return}" +
  "var s=o&&o.screen;if(typeof s!=='string'||!P.test(s))return;" +
  "var k='ohsumi-site-hops',now=Date.now(),h=JSON.parse(sessionStorage.getItem(k)||'null'),f=h&&now-h.at<60000,n=f?h.n||0:0;" +
  "if(n>=3)return;sessionStorage.setItem(k,JSON.stringify({n:n+1,at:f?h.at:now}));" +
  "l.replace('/_v/'+s+'/'+l.search+l.hash)}catch(e){if(bad)l.replace('/'+l.search+l.hash)}})()"

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ja"
      suppressHydrationWarning
      // 版の画面のビルドだけに付ける(どの画面が開いたかを scripts/check-layout.mjs で確かめる)
      data-site-version={SITE_VERSION || undefined}
      className={`${geistSans.variable} ${geistMono.variable} bg-background`}
    >
      <head>
        {!IS_DEMO && <script dangerouslySetInnerHTML={{ __html: SITE_SCRIPT }} />}
        <script dangerouslySetInnerHTML={{ __html: BEFORE_PAINT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <FrameGuard>{children}</FrameGuard>
        {/* デモは Google のログインを使わない(外部のスクリプトを読まない) */}
        {!IS_DEMO && <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />}
      </body>
    </html>
  )
}
