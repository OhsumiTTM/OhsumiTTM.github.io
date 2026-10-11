// 自由入力の文の自動翻訳(gas/Code.gs の translateTexts_)と、画面の覚え方(lib/ohsumi/translate.ts)
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import { looksUntranslated } from './translate'

function harness(translate: (s: string, from: string, to: string) => string) {
  const h = guardHarness()
  const calls: string[] = []
  h.c.LanguageApp = { translate: (s: string, from: string, to: string) => { calls.push(s); return translate(s, from, to) } }
  const tr = (texts: string[], extra: Record<string, unknown> = {}) =>
    h.post({ action: 'translateText', sessionToken: 'm-base', texts, targetLang: 'en', ...extra })
  return { h, calls, tr }
}

describe('translateTexts_', () => {
  it('訳した文を覚え、同じ文はメンバーをまたいで訳し直さない', () => {
    const { h, calls, tr } = harness((s) => 'EN:' + s)
    expect(tr(['会議', '', '資料']).result).toEqual(['EN:会議', '', 'EN:資料'])
    expect(h.post({ action: 'translateText', sessionToken: 'm-other', texts: ['資料', '予算'], targetLang: 'en' }).result).toEqual(['EN:資料', 'EN:予算'])
    expect(calls).toEqual(['会議', '資料', '予算'])
  })

  it('markFailed の時は、訳せなかった文を null で返し、覚えない(古い画面には原文を返す)', () => {
    let fail = true
    const { calls, tr } = harness((s) => { if (fail && s === '失敗') throw new Error('Translation failed'); return 'EN:' + s })
    expect(tr(['成功', '失敗'], { markFailed: true }).result).toEqual(['EN:成功', null])
    expect(tr(['失敗']).result).toEqual(['失敗'])
    fail = false
    expect(tr(['失敗'], { markFailed: true }).result).toEqual(['EN:失敗'])
    expect(calls.filter((c) => c === '失敗')).toHaveLength(3)
  })

  it('上限に達したら、残りの文は LanguageApp を呼ばずに失敗にし、種類をエラーの記録に残す', () => {
    const { h, calls, tr } = harness(() => { throw new Error('Service invoked too many times for one day: translate.') })
    expect(tr(['一', '二', '三'], { markFailed: true }).result).toEqual([null, null, null])
    expect(calls).toEqual(['一'])
    const log = h.sheets.ErrorLog?.rows ?? []
    expect(log.some((r) => r.includes('translateText') && r.some((v) => String(v).startsWith('quota:')))).toBe(true)
  })

  it('知らない言語は断る', () => {
    const { h } = harness((s) => s)
    expect(h.post({ action: 'translateText', sessionToken: 'm-base', texts: ['a'], targetLang: '<x>' }).ok).toBe(false)
  })
})

describe('looksUntranslated(古い GAS が原文を返した時)', () => {
  it('日本語の文を英語に訳して原文のままなら、訳せなかったとみなす', () => {
    expect(looksUntranslated('会議の準備', '会議の準備', 'en')).toBe(true)
    expect(looksUntranslated('会議の準備', 'Meeting prep', 'en')).toBe(false)
    // 固有名詞・英語の文は、原文のままでもよい
    expect(looksUntranslated('Ohsumi', 'Ohsumi', 'en')).toBe(false)
    expect(looksUntranslated('会議', '会議', 'ja')).toBe(false)
  })
})
