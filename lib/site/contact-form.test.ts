import { describe, expect, it } from 'vitest'
import { OTHER_CHOICE } from './apply-form'
import { buildContactBody, validateContact } from './contact-form'

const filled = () => ({
  name: '山田 太郎', org: 'テスト団体', email: 'taro@example.com', orgType: '学生団体',
  headcount: '11〜30名', inquiry: 'デモ希望', message: 'デモを見たいです', consent: ['プライバシーポリシーに同意して送信します'],
})

describe('お問い合わせフォーム', () => {
  it('そろっていれば問題なし。同意は送らない', () => {
    expect(validateContact(filled())).toEqual({})
    const body = buildContactBody(filled())
    expect(body.get('entry.913886079')).toBe('デモ希望')
    expect([...body.keys()].filter((k) => k.startsWith('entry.'))).toHaveLength(7)
  })
  it('同意が無い・メールの形が違うと知らせる', () => {
    const e = validateContact({ ...filled(), consent: [], email: 'x' })
    expect(Object.keys(e).sort()).toEqual(['consent', 'email'])
  })
  it('「その他」は自由記入をまとめて送る', () => {
    const body = buildContactBody({ ...filled(), orgType: OTHER_CHOICE, 'orgType.other': '研究室' })
    expect(body.get('entry.105049402')).toBe('その他(研究室)')
  })
})
