import type { Metadata } from 'next'
import { PageHero } from '@/components/site/blocks'
import { ApplyForm } from '@/components/site/apply-form-client'
import { Container, Em } from '@/components/site/primitives'

export const metadata: Metadata = {
  title: 'Apply 利用契約書の発行申請',
  description: 'Ohsumi の利用契約書・個別申込書の発行を申請するページです。',
  alternates: { canonical: '/apply' },
}

export default function ApplyPage() {
  return (
    <>
      <PageHero
        eyebrow="Apply"
        title={
          <>
            Ohsumi 利用契約書の
            <br />
            <Em>発行を申請する</Em>
          </>
        }
        description="ご入力いただいた内容をもとに、FSIF にて利用契約書および個別申込書を作成し、ご担当者様へご連絡します。このフォームの送信だけでは利用契約は成立しません。契約書類の内容をご確認いただき、双方の手続きが完了した時点で契約成立となります。"
      />
      <section className="bg-surface py-14 md:py-20">
        <Container className="max-w-3xl">
          <ApplyForm />
        </Container>
      </section>
    </>
  )
}
