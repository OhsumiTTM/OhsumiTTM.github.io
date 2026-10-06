// 団体のテーマの色: 明るい表示は今までどおり、暗い表示は暗い背景の上で読める明るさにする
import { describe, expect, it } from 'vitest'
import { readableAvatar, DARK_BUTTON_TEXT, DARK_SURFACES, contrastRatio, darkPrimary, lightButtonText, themeColorCss, themeColorVars } from './theme-color'

const SAMPLES = ['#2948e8', '#e11d48', '#000000', '#0c1b32', '#123456', '#059669', '#d97706', '#8b5cf6', '#ffff00', '#ffffff', '#777', '#f0f']

describe('団体のテーマの色', () => {
  it('明るい表示は、団体の色をそのまま使い、ボタンの文字の決め方も今までどおり', () => {
    expect(themeColorVars('#2948e8')!.light).toEqual({ primary: '#2948e8', foreground: '#ffffff' })
    expect(themeColorVars('#ffff00')!.light).toEqual({ primary: '#ffff00', foreground: '#0d0d0f' })
    expect(lightButtonText('#2948e8')).toBe('#ffffff')
  })

  it('暗い表示は、暗い背景・カード・メニュー・タブの上で 4.5:1 以上。ボタンの文字も 4.5:1 以上', () => {
    for (const c of SAMPLES) {
      const dark = themeColorVars(c)!.dark
      for (const bg of DARK_SURFACES) expect(contrastRatio(dark.primary, bg), `${c} → ${dark.primary} / ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(dark.foreground).toBe(DARK_BUTTON_TEXT)
      expect(contrastRatio(dark.primary, dark.foreground), c).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('読める色はそのまま、読めない色は色合いを変えずに明るくする', () => {
    expect(darkPrimary('#ffff00')).toBe('#ffff00')
    const lifted = darkPrimary('#2948e8')
    expect(lifted).not.toBe('#2948e8')
    // 青のまま(青の成分がいちばん大きい)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(lifted.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('CSS は暗い表示の規則を、明るい表示の規則と .dark の既定の色より強く入れる。正しくない色は何も入れない', () => {
    const css = themeColorCss('#2948e8')
    expect(css).toMatch(/^html:root\{--primary:#2948e8;--primary-foreground:#ffffff\}html\.dark\{--primary:#[0-9a-f]{6};/)
    expect(themeColorCss('blue')).toBe('')
    expect(themeColorCss('')).toBe('')
  })

  it('暗い表示の既定の色(--primary #7d9bff)とロゴの色も、暗い背景の上で読める', () => {
    for (const bg of DARK_SURFACES) {
      expect(contrastRatio('#7d9bff', bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio('#a8b4c9', bg)).toBeGreaterThanOrEqual(4.5) // --muted-foreground
    }
  })
  it('アイコンの丸の文字は、どのメンバーの色でも 4.5:1 以上(読めない中くらいの色は丸を少し暗くする)', () => {
    for (const c of ['#2948e8', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6', '#e11d48', '#0891b2', '#ffff00', '#808080']) {
      const a = readableAvatar(c)
      expect(contrastRatio(a.bg, a.fg), c).toBeGreaterThanOrEqual(4.5)
    }
    expect(readableAvatar('#2948e8')).toEqual({ bg: '#2948e8', fg: '#ffffff' })
  })
})
