import { describe, expect, it } from 'vitest'
import { APPLY_FIELDS, OTHER_CHOICE, buildApplyBody, validateApply } from './apply-form'

const filled = () => ({
  contactName: '山田 太郎', email: 'taro@example.com', orgName: 'テスト団体', orgKana: 'テストダンタイ',
  orgType: '学生団体', address: '東京都', repTitle: '代表', repName: '山田 花子', website: 'なし',
  headcount: '1〜10名', startDate: '2026-10-20', plan: 'Ohsumiプラン', sendTo: '団体代表者',
  confirm: APPLY_FIELDS.find((f) => f.key === 'confirm')!.options!, notes: 'なし',
})

describe('利用契約書の発行申請フォーム', () => {
  it('必須の項目がそろっていれば問題なし', () => {
    expect(validateApply(filled())).toEqual({})
  })
  it('必須の空欄・メールの形・確認事項の不足・選択肢にない値を知らせる', () => {
    const v = { ...filled(), contactName: '', email: 'abc', confirm: ['x'], headcount: '1000名' }
    const e = validateApply(v)
    expect(Object.keys(e).sort()).toEqual(['confirm', 'contactName', 'email', 'headcount'])
  })
  it('「その他」は内容が要り、自由記入として送る', () => {
    const v = { ...filled(), orgType: OTHER_CHOICE }
    expect(validateApply(v).orgType).toBeTruthy()
    const body = buildApplyBody({ ...v, 'orgType.other': '研究室' })
    expect(body.get('entry.661018689')).toBe(OTHER_CHOICE)
    expect(body.get('entry.661018689.other_option_response')).toBe('研究室')
  })
  it('確認事項は選んだ数だけ送り、ページの通り道も送る', () => {
    const body = buildApplyBody(filled())
    expect(body.getAll('entry.746384353')).toHaveLength(4)
    expect(body.get('pageHistory')).toBe('0,1,2,3,4,5,6')
    expect(body.get('entry.271996791')).toBe('taro@example.com')
  })
})
