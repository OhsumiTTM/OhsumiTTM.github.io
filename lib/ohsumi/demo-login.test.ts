// 開発環境専用のデモ用ログイン画面(メンバーを選ぶだけでログインできる)が、本番のビルドに
// 含まれない仕組みを固定する。実際のビルド結果は pnpm build の最後に
// scripts/check-no-demo-login.mjs が確かめる(CI・デプロイとも pnpm build を実行する)。
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as check from '../../scripts/check-no-demo-login.mjs'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p)
    return /\.(ts|tsx|mjs)$/.test(name) ? [p] : []
  })
}

describe('デモ用のログイン画面', () => {
  it('ビルドの確認は、demo-login.tsx の目印の文字列を探す(目印が一致している)', () => {
    const src = read('components/ohsumi/demo-login.tsx')
    expect(src).toContain(`DEMO_LOGIN_MARKER = '${check.DEMO_LOGIN_MARKER}'`)
    // 画面に目印を出している(ビルドに含まれれば必ず文字列が残る)
    expect(src).toMatch(/data-marker=\{DEMO_LOGIN_MARKER\}/)
  })

  it('pnpm build の最後に確認を実行する', () => {
    const build = JSON.parse(read('package.json')).scripts.build as string
    expect(build).toMatch(/node scripts\/check-no-demo-login\.mjs/)
  })

  it('demo-login.tsx を読み込むのはログイン画面だけで、開発環境の条件の中だけ', () => {
    const importers = [...sourceFiles(join(ROOT, 'components')), ...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'app'))]
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => /['"]\.{1,2}\/(?:[\w-]+\/)*demo-login['"]|@\/components\/ohsumi\/demo-login/.test(readFileSync(f, 'utf8')))
    expect(importers.map((f) => f.slice(ROOT.length + 1))).toEqual(['components/ohsumi/login-screen.tsx'])
    const login = read('components/ohsumi/login-screen.tsx')
    // 静的な import は使わない(使うと本番のビルドにも含まれる)
    expect(login).not.toMatch(/^import .*demo-login/m)
    expect(login).toMatch(
      /process\.env\.NODE_ENV === 'development' \? dynamic\(\(\) => import\('\.\/demo-login'\)[^)]*\) : null/,
    )
    // 目印の文字列そのものはログイン画面に書かない
    expect(login).not.toContain(check.DEMO_LOGIN_MARKER)
  })

  it('ビルドの結果に目印があれば見つけ、無ければ何も返さない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-login-'))
    mkdirSync(join(dir, '_next', 'static', 'chunks'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    writeFileSync(join(dir, '_next', 'static', 'chunks', 'a.js'), 'console.log(1)')
    expect(check.findDemoLogin(dir)).toEqual([])
    writeFileSync(join(dir, '_next', 'static', 'chunks', 'b.js'), `x="${check.DEMO_LOGIN_MARKER}"`)
    expect(check.findDemoLogin(dir)).toEqual([join(dir, '_next', 'static', 'chunks', 'b.js')])
  })
})
