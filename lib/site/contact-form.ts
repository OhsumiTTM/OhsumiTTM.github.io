// 「Ohsumiお問い合わせ」(Google フォーム)の定義。apply-form.ts と同じく、サイトのフォームから裏で送る。
// Google フォームの質問はすべて自由記入なので、選択肢はサイトの側で決めて、選んだ文字をそのまま送る。
// 「その他」を選んだ時は「その他(自由記入)」の形で送る
import type { ApplySection, ApplyValues } from './apply-form'
import { OTHER_CHOICE } from './apply-form'

export const CONTACT_FORM_ID = '1FAIpQLScTOMS80EQU77swv0atIXwk2im_SJ9hBqxnUtHcFKORuRKwxw'
export const CONTACT_FORM_ACTION = `https://docs.google.com/forms/d/e/${CONTACT_FORM_ID}/formResponse`

export const CONTACT_SECTIONS: ApplySection[] = [
  {
    title: 'お問い合わせ',
    description: '導入の検討段階でも構いません。2〜3営業日以内に、FSIF からご連絡します。',
    fields: [
      { key: 'name', entry: '380305617', label: '氏名', type: 'text', required: true },
      { key: 'org', entry: '1611879815', label: '団体・企業名', type: 'text', required: true },
      { key: 'email', entry: '1758386114', label: 'メールアドレス', help: 'ご返信に使います。', type: 'email', required: true },
      {
        key: 'orgType', entry: '105049402', label: '組織種別', type: 'radio', required: true, other: true,
        options: ['企業', '学生団体', 'NPO・一般社団法人', '研究機関・大学', '行政・公共団体'],
      },
      {
        key: 'headcount', entry: '551740235', label: '想定利用人数', type: 'radio', required: true,
        options: ['1〜10名', '11〜30名', '31〜50名', '51〜100名', '101名以上', '未定'],
      },
      {
        key: 'inquiry', entry: '913886079', label: '問い合わせ種別', type: 'radio', required: true, other: true,
        options: ['導入相談', 'デモ希望', '機能について', '料金・プランについて'],
      },
      { key: 'message', entry: '625758134', label: '相談内容', type: 'textarea', required: true },
      {
        key: 'consent', entry: '', label: '個人情報の取り扱い', type: 'checks', required: true, allRequired: true,
        options: ['プライバシーポリシーに同意して送信します'],
      },
    ],
  },
]

const FIELDS = CONTACT_SECTIONS.flatMap((s) => s.fields)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_LEN = 4000

export function validateContact(values: ApplyValues): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of FIELDS) {
    const v = values[f.key]
    if (f.type === 'checks') {
      const list = Array.isArray(v) ? v : []
      if (f.allRequired && (f.options ?? []).some((o) => !list.includes(o))) errors[f.key] = 'チェックしてください。'
      continue
    }
    const s = typeof v === 'string' ? v.trim() : ''
    if (f.required && !s) { errors[f.key] = f.type === 'radio' ? '選んでください。' : '入力してください。'; continue }
    if (s.length > MAX_LEN) { errors[f.key] = `${MAX_LEN}文字以内でご入力ください。`; continue }
    if (f.type === 'email' && s && !EMAIL.test(s)) errors[f.key] = 'メールアドレスの形が正しくありません。'
    if (f.type === 'radio' && s) {
      if (s === OTHER_CHOICE) {
        if (!String(values[f.key + '.other'] ?? '').trim()) errors[f.key] = '「その他」の内容をご入力ください。'
      } else if (!(f.options ?? []).includes(s)) errors[f.key] = '選択肢から選んでください。'
    }
  }
  return errors
}

export function buildContactBody(values: ApplyValues): URLSearchParams {
  const body = new URLSearchParams()
  for (const f of FIELDS) {
    if (!f.entry) continue // サイトだけの項目(同意)は送らない
    const v = values[f.key]
    let s = typeof v === 'string' ? v.trim() : ''
    if (f.type === 'radio' && s === OTHER_CHOICE) s = 'その他(' + String(values[f.key + '.other'] ?? '').trim() + ')'
    if (s) body.append('entry.' + f.entry, s)
  }
  body.append('fvv', '1')
  body.append('pageHistory', '0')
  return body
}
