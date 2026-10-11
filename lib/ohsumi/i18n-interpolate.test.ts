// 翻訳の文章の {name} の置き換え(lib/ohsumi/i18n/index.tsx の interpolate)
import { describe, expect, it } from 'vitest'
import { interpolate } from './i18n'
import { startOfLocalDay } from './utils'

describe('interpolate', () => {
  it('{name} を値に置き換える(同じ名前が何度あっても)', () => {
    expect(interpolate('{n}件のうち{n}件', { n: 3 })).toBe('3件のうち3件')
    expect(interpolate('{a}と{b}', { a: 'A', b: 'B' })).toBe('AとB')
  })

  it('値の中の $& ・ $1 ・ $$ などを、置き換えの記号として扱わない', () => {
    expect(interpolate('名前: {name}', { name: '$&' })).toBe('名前: $&')
    expect(interpolate('{name}さん', { name: "a$1b$$c$`d$'" })).toBe("a$1b$$c$`d$'さん")
  })

  it('値の中の {ほかの名前} は置き換えない。渡していない名前はそのまま残す', () => {
    expect(interpolate('{a}/{b}', { a: '{b}', b: 'B' })).toBe('{b}/B')
    expect(interpolate('{a}/{missing}', { a: 'A' })).toBe('A/{missing}')
  })
})

describe('startOfLocalDay', () => {
  it('その日(端末の時刻)の0時にする(元の日付は変えない)', () => {
    const d = new Date(2026, 9, 11, 15, 30, 12, 345)
    const s = startOfLocalDay(d)
    expect([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes(), s.getSeconds(), s.getMilliseconds()]).toEqual([2026, 9, 11, 0, 0, 0, 0])
    expect(d.getHours()).toBe(15)
  })
})
