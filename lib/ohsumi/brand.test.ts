// ブランド(ブランドガイドライン v0.4。docs/brand.md): 基本の色の定義・ロゴの決まり・画面に旧名が無いこと
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
function files(dir: string, exts = /\.(tsx?|css|svg|json|md)$/): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = join(dir, name)
    return statSync(join(ROOT, p)).isDirectory() ? files(p, exts) : exts.test(name) ? [p] : []
  })
}

describe('ブランド', () => {
  it('基本の4色を変数として定義し、背景・文字・CTA・カードに使う', () => {
    const css = read('app/globals.css')
    for (const [name, hex] of [['navy', '#0c1b32'], ['blue', '#2948e8'], ['pale-blue', '#eef3ff'], ['off-white', '#f6f8fc']]) {
      expect(css).toContain(`--ohsumi-${name}: ${hex};`)
    }
    expect(css).toMatch(/--background: var\(--ohsumi-off-white\)/)
    expect(css).toMatch(/--foreground: var\(--ohsumi-navy\)/)
    expect(css).toMatch(/--primary: var\(--ohsumi-blue\)/)
    expect(css).toMatch(/--card: var\(--ohsumi-pale-blue\)/)
  })

  it('ロゴは団体のテーマの色(--primary)ではなく、ブランドの変数を使う。回転しない', () => {
    const src = read('components/ohsumi/primitives.tsx')
    const mark = src.slice(src.indexOf('export function OhsumiMark'), src.indexOf('/** シンボル + 「Ohsumi」の文字'))
    expect(mark).toContain("color: 'var(--ohsumi-symbol)'")
    // シンボルの色: 明るい表示は Ohsumi Blue、暗い表示は明るい青(案 C)
    const css = read('app/globals.css')
    expect(css).toContain('--ohsumi-symbol: var(--ohsumi-blue);')
    expect(css.slice(css.indexOf('.dark {'))).toContain('--ohsumi-symbol: #7d9bff;')
    expect(mark).not.toMatch(/text-primary|--primary|rotate|transform/)
    expect(mark).toContain("aspectRatio: '1 / 1'")
    expect(read('app/icon.svg')).not.toMatch(/rotate|transform|<rect/)
  })

  it('回してよいのは、読み込み中のシンボル単体だけ(ガイドライン v0.9)。形・色は OhsumiMark と同じで、輪の中心で回す', () => {
    const src = read('components/ohsumi/primitives.tsx')
    const loading = src.slice(src.indexOf('export function OhsumiLoadingMark'), src.indexOf('/** シンボル + 「Ohsumi」の文字'))
    // 文字は付けない(文字付きロゴは常に回転禁止)・ブランドの変数の色・同じ形(OHSUMI_SYMBOL_PATHS)
    expect(loading).not.toContain('Ohsumi<')
    expect(loading).toContain("color: 'var(--ohsumi-symbol)'")
    expect(loading).toContain('OHSUMI_SYMBOL_PATHS')
    expect(loading).not.toMatch(/text-primary|--primary/)
    // 図の真ん中 = 輪の中心(回しても輪が揺れない)
    expect(loading).toContain('${ring.cx - reach} ${ring.cy - reach} ${reach * 2} ${reach * 2}')
    const css = read('app/globals.css')
    expect(css).toMatch(/\.ohsumi-spin \{\s*transform-origin: 50% 50%;/)
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.ohsumi-spin \{ animation: none; \}/)
    // 回すクラスを使うのは、読み込み中のシンボルだけ
    expect(src.match(/ohsumi-spin/g)?.length).toBe(2)
  })

  it('画面(components・app・文言)に旧名(Orbit・Osumi)が無い', () => {
    const targets = [...files('components'), ...files('app'), ...files('lib/ohsumi/i18n')]
    const hits = targets.filter((f) => /orbit|(?<!h)osumi/i.test(read(f).replace(/ohsumi/gi, '')))
    expect(hits).toEqual([])
  })

  it('Orbit のキャッチコピー(タスクを打ち上げ、組織を軌道に乗せる)を使わない', () => {
    const targets = [...files('components'), ...files('app'), ...files('lib/ohsumi/i18n'), ...files('lib/site'), ...files('content')]
    const hits = targets.filter((f) => /打ち上げ、組織|軌道に乗せ|Launch your tasks|get your team on track/i.test(read(f)))
    expect(hits).toEqual([])
  })
})
