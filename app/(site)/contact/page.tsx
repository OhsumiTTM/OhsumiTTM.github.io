import type { Metadata } from 'next'
import { ExternalLink, Mail } from 'lucide-react'
import { PageHero } from '@/components/site/blocks'
import { Container, Em } from '@/components/site/primitives'
import { CONTACT } from '@/lib/site/config'

export const metadata: Metadata = {
  title: 'Contact お問い合わせ',
  description: 'Ohsumiの導入相談・デモ希望・機能についてのお問い合わせはこちらから。',
  alternates: { canonical: '/contact' },
}

// 問い合わせは、外部のフォーム(Google フォーム)をリンクで開く。このサイトは静的なページで、
// ログインを守る安全の設定(CSP)を緩めないため、フォームの埋め込みやサーバーでの送信はしない
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
        description="導入の検討段階でも構いません。導入相談・デモ希望・機能についてのご質問など、フォームからお送りください。"
      />
      <section className="bg-surface py-14 md:py-20">
        <Container className="max-w-3xl">
          <div className="rounded-2xl border border-border bg-card p-6 md:p-8">
            <h2 className="text-lg font-semibold">お問い合わせフォーム</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              団体名・ご担当者・お問い合わせの種類(導入相談・デモ希望・機能について・その他)をお書きください。
              2〜3営業日以内に、FSIF からご連絡します。
            </p>
            <a
              href={CONTACT.formUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              フォームを開く
              <ExternalLink className="size-4" aria-hidden />
            </a>
            <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
              <Mail className="size-4" aria-hidden />
              メールの場合:
              <a href={`mailto:${CONTACT.email}`} className="font-medium text-primary underline underline-offset-2">
                {CONTACT.email}
              </a>
            </p>
          </div>
        </Container>
      </section>
    </>
  )
}
