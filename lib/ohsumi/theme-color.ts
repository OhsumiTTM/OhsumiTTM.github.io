// 団体のテーマの色(Settings の theme_color)を、画面の --primary に使う時の色の計算。
//   ・明るい表示: 団体の色をそのまま使う。ボタンの文字は、明るい色なら黒・それ以外は白(これまでと同じ)
//   ・暗い表示: 団体の色が暗い背景の上で読めない時は、色合いを変えずに明るくする。
//     暗い表示の背景・カード・メニュー・タブの地(DARK_SURFACES)のどれの上でも、文字として 4.5:1 以上になる明るさにする。
//     ボタンの文字は暗い表示の地の色(DARK_BUTTON_TEXT)にする(ボタンの色との比も 4.5:1 以上になる)
// 色の比は WCAG 2.x の相対輝度で計算する
export const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

// app/globals.css の .dark の --background・--card・--popover・--secondary と同じ
export const DARK_SURFACES = ['#08111f', '#0c1b32', '#12233f', '#142441']
export const DARK_BUTTON_TEXT = '#08111f'
export const MIN_TEXT_CONTRAST = 4.5

type Rgb = [number, number, number]

export function parseHex(hex: string): Rgb | null {
  const m = HEX_COLOR_RE.exec(hex.trim())
  if (!m) return null
  const full = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 明るい表示のボタンの文字(これまでと同じ決め方: 明るい色なら黒、それ以外は白) */
export function lightButtonText(hex: string): string {
  const rgb = parseHex(hex)
  if (!rgb) return '#ffffff'
  const [r, g, b] = rgb
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#0d0d0f' : '#ffffff'
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
  h /= 6
  return [h, s, l]
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const hue = (p: number, q: number, t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255]
}

function readableOnDark(hex: string): boolean {
  return DARK_SURFACES.every((bg) => contrastRatio(hex, bg) >= MIN_TEXT_CONTRAST)
}

/** 暗い表示で使う色。読める色はそのまま、読めない色は色合いを変えずに明るくする */
export function darkPrimary(hex: string): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const base = toHex(rgb)
  if (readableOnDark(base)) return base
  const [h, s, l] = rgbToHsl(rgb)
  for (let next = l + 0.01; next < 1; next += 0.01) {
    const candidate = toHex(hslToRgb([h, s, next]))
    if (readableOnDark(candidate)) return candidate
  }
  return '#ffffff'
}

/** 団体の色から、明るい表示・暗い表示の --primary と --primary-foreground を作る(色が正しくなければ null) */
export function themeColorVars(hex: string): { light: { primary: string; foreground: string }; dark: { primary: string; foreground: string } } | null {
  if (!parseHex(hex)) return null
  return {
    light: { primary: hex, foreground: lightButtonText(hex) },
    dark: { primary: darkPrimary(hex), foreground: DARK_BUTTON_TEXT },
  }
}

/** 画面に入れる CSS(明るい表示は :root、暗い表示は .dark。.dark の既定の色より強く効くように html を付ける) */
export function themeColorCss(hex: string): string {
  const v = themeColorVars(hex)
  if (!v) return ''
  return `html:root{--primary:${v.light.primary};--primary-foreground:${v.light.foreground}}` +
    `html.dark{--primary:${v.dark.primary};--primary-foreground:${v.dark.foreground};--ring:${v.dark.primary}}`
}

/**
 * アイコンの丸(メンバーの色)と文字の色。白か紺で 4.5:1 以上になる方を使い、
 * どちらも届かない中くらいの明るさの色は、色合いを変えずに丸を少し暗くして白い文字にする
 */
export function readableAvatar(bg: string): { bg: string; fg: string } {
  const rgb = parseHex(bg)
  if (!rgb) return { bg, fg: '#ffffff' }
  const base = toHex(rgb)
  if (contrastRatio(base, '#ffffff') >= MIN_TEXT_CONTRAST) return { bg: base, fg: '#ffffff' }
  if (contrastRatio(base, AVATAR_DARK_TEXT) >= MIN_TEXT_CONTRAST) return { bg: base, fg: AVATAR_DARK_TEXT }
  const [h, s, l] = rgbToHsl(rgb)
  for (let next = l - 0.01; next > 0; next -= 0.01) {
    const candidate = toHex(hslToRgb([h, s, next]))
    if (contrastRatio(candidate, '#ffffff') >= MIN_TEXT_CONTRAST) return { bg: candidate, fg: '#ffffff' }
  }
  return { bg: '#000000', fg: '#ffffff' }
}
export const AVATAR_DARK_TEXT = '#0c1b32'
