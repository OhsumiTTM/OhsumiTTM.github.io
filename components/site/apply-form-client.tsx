'use client'

import { APPLY_FORM_ACTION, APPLY_SECTIONS, buildApplyBody, validateApply } from '@/lib/site/apply-form'
import { GoogleBackedForm } from './google-form'

export function ApplyForm() {
  return (
    <GoogleBackedForm
      sections={APPLY_SECTIONS}
      action={APPLY_FORM_ACTION}
      validate={validateApply}
      build={buildApplyBody}
      storageKey="ohsumi-site-apply-sent"
      submitLabel="申請を送信する"
      successTitle="Ohsumi 利用契約書の発行申請を受け付けました"
      successBody={'ご回答いただいた内容をもとに、未来宇宙産業フォーラム(FSIF)にて契約書および個別申込書を作成いたします。\n内容の確認が必要な場合は、FSIF の担当者よりご連絡する場合があります。\n契約書類の準備が完了しましたら、ご入力いただいたメールアドレス宛にご案内いたします。\nこの度は Ohsumi をご検討いただき、ありがとうございます。'}
    />
  )
}
