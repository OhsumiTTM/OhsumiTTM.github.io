// サイトの URL(https://ohsumittm.github.io・独自ドメインの https://ohsumi.fsif.com)を
// コード・CSP・ビルドの設定に直接書いていないことを確かめる。
// 独自ドメインへ移る時に、コードを変えずに済むようにするため(CSP は 'self'、ログインの確認は OAuth クライアント ID で行う)。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPolicy } from '../../scripts/csp.mjs'

const ROOT = join(__dirname, '..', '..')
const CODE_DIRS = ['app', 'components', 'lib', 'scripts', 'gas', 'registry', '.github']
const CODE_FILES = ['next.config.mjs', 'package.json']
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|gs|json|ya?ml)$/
const SITE_URL = /ohsumittm\.github\.io|ohsumi\.fsif\.com/i

function codeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...codeFiles(path))
    else if (CODE_EXT.test(name)) out.push(path)
  }
  return out
}

describe('サイトの URL を直接書いていない', () => {
  it('コード・スクリプト・GAS・ワークフロー・ビルドの設定に、サイトの URL が無い', () => {
    const files = [...CODE_DIRS.flatMap((d) => codeFiles(join(ROOT, d))), ...CODE_FILES.map((f) => join(ROOT, f))]
      .filter((f) => !f.endsWith('site-url.test.ts'))
    expect(files.length).toBeGreaterThan(50)
    const hits = files.filter((f) => SITE_URL.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('CSP はサイトを self で指し、サイトの URL を含まない', () => {
    const policy = buildPolicy({ calendarRead: true })
    expect(policy).toContain("default-src 'self'")
    expect(policy).not.toMatch(SITE_URL)
    expect(policy).not.toMatch(/github\.io/)
  })
})
