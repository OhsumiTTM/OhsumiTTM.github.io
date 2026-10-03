import { describe, expect, it } from 'vitest'
import { isValidEmail, needsGoogleAccountCheck } from './member-email'

describe('メンバーのメールアドレス', () => {
  it('形の正しいアドレスだけを受け付ける', () => {
    for (const v of ['a@gmail.com', ' taro.yamada@example.ac.jp ']) expect(isValidEmail(v), v).toBe(true)
    for (const v of ['', '   ', 'abc', 'a@b', 'a b@c.com', 'a@b.com,c@d.com', undefined, null]) expect(isValidEmail(v as string), String(v)).toBe(false)
  })
  it('Gmail 以外のアドレスには、Google でログインできるかの注意を出す', () => {
    expect(needsGoogleAccountCheck('a@gmail.com')).toBe(false)
    expect(needsGoogleAccountCheck('a@GoogleMail.com')).toBe(false)
    expect(needsGoogleAccountCheck('a@keio.jp')).toBe(true)
    expect(needsGoogleAccountCheck('')).toBe(false)
  })
})
