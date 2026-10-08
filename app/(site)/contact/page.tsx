import type { Metadata } from 'next'
import { Mail } from 'lucide-react'
import { PageHero } from '@/components/site/blocks'
import { ContactForm } from '@/components/site/contact-form-client'
import { Container, Em } from '@/components/site/primitives'
import { CONTACT } from '@/lib/site/config'

export const metadata: Metadata = {
  title: 'Contact お問い合わせ',
  description: 'Ohsumiの導入相談・デモ希望・機能についてのお問い合わせはこちらから。',
  alternates: { canonical: '/contact' },
}

// 問い合わせは、サイトのフォームから裏で Google フォームに送る(lib/site/contact-form.ts)。
// 埋め込み(iframe)やサーバーでの送信はしない(ログインを守る安全の設定 CSP を緩めないため)
export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title={
          <>
            Ohsumiの導入について、
            <br />
            <Em>お気軽にご相談ください。</Em>
          </>
        }
        description="導入相談・デモのご希望・機能や料金についてのご質問など、お気軽にお送りください。"
      />
      <section className="bg-surface py-14 md:py-20">
        <Container className="max-w-3xl">
          <p className="mb-4 text-sm text-muted-foreground">
            お預かりした情報は、お問い合わせへの回答のためだけに使います。詳しくは
            <a href="/privacy" className="mx-1 font-medium text-primary underline underline-offset-2">プライバシーポリシー</a>
            をご覧ください。
          </p>
          <p className="mb-4 text-sm text-muted-foreground">返信は、1週間以内を目安にしています。</p>
          <ContactForm />
          <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Mail className="size-4" aria-hidden />
            メールの場合:
            <a href={`mailto:${CONTACT.email}`} className="font-medium text-primary underline underline-offset-2">
              {CONTACT.email}
            </a>
          </p>
        </Container>
      </section>
    </>
  )
}
