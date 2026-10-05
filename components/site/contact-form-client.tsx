'use client'

import { CONTACT_FORM_ACTION, CONTACT_SECTIONS, buildContactBody, validateContact } from '@/lib/site/contact-form'
import { GoogleBackedForm } from './google-form'

export function ContactForm() {
  return (
    <GoogleBackedForm
      sections={CONTACT_SECTIONS}
      action={CONTACT_FORM_ACTION}
      validate={validateContact}
      build={buildContactBody}
      storageKey="ohsumi-site-contact-sent"
      submitLabel="送信する"
      successTitle="お問い合わせを受け付けました"
      successBody={'お問い合わせいただき、ありがとうございます。\n内容を確認のうえ、2〜3営業日以内に FSIF からご連絡します。'}
    />
  )
}
