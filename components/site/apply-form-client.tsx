'use client'

import { APPLY_FORM_ACTION, APPLY_SECTIONS, buildApplyBody, validateApply, type ApplyValues } from '@/lib/site/apply-form'
import { LOGO_ACCEPT, LOGO_UPLOAD_ENABLED, checkLogoFile, uploadLogo } from '@/lib/site/logo-upload'
import { GoogleBackedForm, type FileUploadOptions } from './google-form'

// 団体ロゴ: 送信を押した時に Supabase Storage に上げ、その公開 URL を Google フォームに送る(lib/site/logo-upload.ts)
const LOGO_UPLOAD: FileUploadOptions = {
  enabled: LOGO_UPLOAD_ENABLED,
  accept: LOGO_ACCEPT,
  check: checkLogoFile,
  upload: (file) => uploadLogo(file),
  uploadingLabel: 'ロゴを送っています…',
  disabledNote: 'いまロゴを受け付けられません。その他・連絡事項に書いてください。',
}
const validate = (v: ApplyValues) => validateApply(v, { fileUpload: LOGO_UPLOAD_ENABLED })

export function ApplyForm() {
  return (
    <GoogleBackedForm
      sections={APPLY_SECTIONS}
      action={APPLY_FORM_ACTION}
      validate={validate}
      fileUpload={LOGO_UPLOAD}
      build={buildApplyBody}
      storageKey="ohsumi-site-apply-sent"
      submitLabel="申請を送信する"
      successTitle="Ohsumi 利用契約書の発行申請を受け付けました"
      successBody={'ご回答いただいた内容をもとに、未来宇宙産業フォーラム(FSIF)にて契約書および個別申込書を作成いたします。\n内容の確認が必要な場合は、FSIF の担当者よりご連絡する場合があります。\n契約書類の準備が完了しましたら、ご入力いただいたメールアドレス宛にご案内いたします。\nこの度は Ohsumi をご検討いただき、ありがとうございます。'}
    />
  )
}
