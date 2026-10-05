// 「Ohsumi 利用契約書 発行申請フォーム」(Google フォーム)の定義。
// サイトの見た目のフォームから、裏で Google フォームの受付先(formResponse)に送る(埋め込みは使わない)。
//
// Google フォームの質問を変えた時は、ここの entry の番号・選択肢を合わせて直す
// (選択肢の文字は Google フォームと完全に同じでないと、回答に入らない)。
// 番号は、Google フォームの「事前入力した URL を取得」か、公開ページのソースの FB_PUBLIC_LOAD_DATA_ で分かる。

export const APPLY_FORM_ID = '1FAIpQLSfABf-ortXPSrh8TwvNZviIHvrK2-nPTqV0N4Jt7n9Y4ZLExQ'
export const APPLY_FORM_ACTION = `https://docs.google.com/forms/d/e/${APPLY_FORM_ID}/formResponse`
// Google フォームのページ(はじめの説明のページ + 質問の6つのセクション)。全部を通ったことにして送る
const PAGE_HISTORY = '0,1,2,3,4,5,6'
const OTHER = '__other_option__'

export type FieldType = 'text' | 'email' | 'textarea' | 'radio' | 'date' | 'checks'

export interface ApplyField {
  key: string
  entry: string
  label: string
  help?: string
  type: FieldType
  required: boolean
  options?: string[]
  // 「その他」を選べる(選んだ時は自由記入を一緒に送る)
  other?: boolean
  // すべての選択肢にチェックが要る(確認事項)
  allRequired?: boolean
  placeholder?: string
}

export interface ApplySection {
  title: string
  description?: string
  fields: ApplyField[]
}

export const APPLY_SECTIONS: ApplySection[] = [
  {
    title: 'ご担当者様について',
    description: '契約書類の作成・確認・送付にあたり、FSIF からご連絡する際の窓口となる方についてご入力ください。',
    fields: [
      { key: 'contactName', entry: '1658356965', label: 'ご担当者氏名', help: '契約手続きに関する窓口となる方のお名前', type: 'text', required: true },
      { key: 'email', entry: '271996791', label: 'メールアドレス', help: '契約書類の送付や内容確認のご連絡に使います。日常的に確認できるアドレスをご入力ください。', type: 'email', required: true },
      { key: 'department', entry: '818412706', label: '所属部署・役職', help: '部署名や役職がある場合', type: 'text', required: false },
      { key: 'fsifContact', entry: '291828629', label: 'FSIF の担当者', help: 'すでに FSIF の担当者とやり取りしている場合は、その担当者名', type: 'text', required: false },
    ],
  },
  {
    title: 'ご契約団体について',
    description: '契約書および個別申込書に記載する団体情報です。正式名称・所在地・代表者名などは、契約書類にそのまま使う場合があります。',
    fields: [
      { key: 'orgName', entry: '1719442258', label: '団体・法人名', help: '法人登記上の名称、または団体として正式に使っている名称', type: 'text', required: true },
      { key: 'orgKana', entry: '2126767728', label: '団体・法人名(フリガナ)', type: 'text', required: true },
      {
        key: 'orgType', entry: '661018689', label: '団体種別', help: '最も近いものをお選びください。', type: 'radio', required: true, other: true,
        options: ['株式会社', '合同会社', '一般社団法人', 'NPO法人', '学生団体', '任意団体', 'プロジェクト・チーム'],
      },
      { key: 'address', entry: '744786248', label: '所在地', help: '法人の場合は、原則として登記上の所在地', type: 'text', required: true },
      { key: 'repTitle', entry: '213997492', label: '代表者役職', placeholder: '例: 代表取締役、代表理事、代表、部長', type: 'text', required: true },
      { key: 'repName', entry: '1718973910', label: '代表者氏名', type: 'text', required: true },
      { key: 'website', entry: '794182366', label: 'Webサイト・SNS', help: '団体について確認できる Web サイトや公式 SNS。無い場合は「なし」とご入力ください。', type: 'textarea', required: true },
    ],
  },
  {
    title: 'Ohsumi の利用について',
    description: '利用環境や初期設定を準備するため、想定している利用方法をお聞かせください。',
    fields: [
      {
        key: 'headcount', entry: '930521738', label: '利用予定人数', help: '決まっていない場合は「未定」をお選びください。', type: 'radio', required: true,
        options: ['1〜10名', '11〜30名', '31〜50名', '51〜100名', '101名以上', '未定'],
      },
      { key: 'startDate', entry: '1255065093', label: '利用開始希望日', help: '契約手続きや準備の状況により、ご希望に沿えない場合があります。', type: 'date', required: true },
    ],
  },
  {
    title: '契約条件について',
    description: 'FSIF の担当者と事前に合意している条件や、個別申込書に記載する内容があればお知らせください。',
    fields: [
      {
        key: 'plan', entry: '250080162', label: '利用区分', help: '判断が難しい場合は「その他」をお選びください。まだパートナーでない場合は、パートナーの締結についても合わせてご案内します。', type: 'radio', required: true, other: true,
        options: ['Cosmo Baseプラン', 'Ohsumiプラン', '有償プラン'],
      },
      { key: 'conditions', entry: '1751922689', label: '個別条件・特記事項', help: '利用期間・利用料金・利用人数・特定機能の利用条件・実証利用の条件など。特にない場合は空欄で構いません。', type: 'textarea', required: false },
    ],
  },
  {
    title: '契約書類の送付について',
    fields: [
      {
        key: 'sendTo', entry: '2088374614', label: '契約書類の送付先', help: '契約書類を最初に確認する方', type: 'radio', required: true, other: true,
        options: ['本フォームに入力したご担当者様', '団体代表者'],
      },
      { key: 'sendToName', entry: '1936052529', label: '契約書類の送付先の氏名', help: '「その他」を選んだ場合', type: 'text', required: false },
    ],
  },
  {
    title: '最終確認',
    fields: [
      {
        key: 'confirm', entry: '746384353', label: '確認事項', type: 'checks', required: true, allRequired: true,
        options: [
          '入力した団体情報および担当者情報に誤りがないことを確認しました。',
          '本フォームの送信のみではOhsumiの利用契約が成立しないことを確認しました。',
          '契約書類の作成にあたり、FSIFから内容確認の連絡を行う場合があることを確認しました。',
          '作成された契約書類の内容を確認したうえで、正式な契約手続きを行うことを確認しました。',
        ],
      },
      { key: 'notes', entry: '1939103158', label: 'その他・連絡事項', help: '事前に伝えておきたいこと・ご質問・ご要望。無い場合は「なし」とご入力ください。', type: 'textarea', required: true },
    ],
  },
]

export const APPLY_FIELDS: ApplyField[] = APPLY_SECTIONS.flatMap((s) => s.fields)

// 入力の値: 文字の項目は文字、選択肢は選んだ文字(「その他」は OTHER_CHOICE)、チェックは選んだ文字の配列
export const OTHER_CHOICE = OTHER
export type ApplyValues = Record<string, string | string[]>

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_LEN = 2000

/** 入力を確かめる。項目ごとの問題(無ければ空のオブジェクト)を返す */
export function validateApply(values: ApplyValues): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of APPLY_FIELDS) {
    const v = values[f.key]
    if (f.type === 'checks') {
      const list = Array.isArray(v) ? v : []
      if (f.allRequired && (f.options ?? []).some((o) => !list.includes(o))) errors[f.key] = 'すべての項目にチェックしてください。'
      continue
    }
    const s = typeof v === 'string' ? v.trim() : ''
    if (f.required && !s) { errors[f.key] = '入力してください。'; continue }
    if (s.length > MAX_LEN) { errors[f.key] = `${MAX_LEN}文字以内でご入力ください。`; continue }
    if (f.type === 'email' && s && !EMAIL.test(s)) errors[f.key] = 'メールアドレスの形が正しくありません。'
    if (f.type === 'date' && s && !DATE.test(s)) errors[f.key] = '日付を選んでください。'
    if (f.type === 'radio' && s) {
      if (s === OTHER) {
        const other = String(values[f.key + '.other'] ?? '').trim()
        if (!f.other) errors[f.key] = '選択肢から選んでください。'
        else if (!other) errors[f.key] = '「その他」の内容をご入力ください。'
      } else if (!(f.options ?? []).includes(s)) errors[f.key] = '選択肢から選んでください。'
    }
  }
  return errors
}

/** Google フォームの受付先に送る内容 */
export function buildApplyBody(values: ApplyValues): URLSearchParams {
  const body = new URLSearchParams()
  for (const f of APPLY_FIELDS) {
    const v = values[f.key]
    if (f.type === 'checks') {
      for (const o of Array.isArray(v) ? v : []) body.append('entry.' + f.entry, o)
      continue
    }
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) continue
    body.append('entry.' + f.entry, s)
    if (f.type === 'radio' && s === OTHER) body.append('entry.' + f.entry + '.other_option_response', String(values[f.key + '.other'] ?? '').trim())
  }
  body.append('fvv', '1')
  body.append('pageHistory', PAGE_HISTORY)
  return body
}
