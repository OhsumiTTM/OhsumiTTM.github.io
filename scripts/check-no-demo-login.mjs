// 本番のビルド(out/)に、開発環境専用のデモ用ログイン画面(components/ohsumi/demo-login.tsx)が
// 含まれていないことを確かめる。含まれていればビルドを失敗させる。
// (デモ用のログイン画面は、メンバーを選ぶだけで誰でもログインできてしまうため)
//
// 使い方: node scripts/check-no-demo-login.mjs [出力フォルダ(既定: out)]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// demo-login.tsx の DEMO_LOGIN_MARKER と同じ文字列(テストで一致を確かめる)
export const DEMO_LOGIN_MARKER = 'ohsumi-demo-login-only-in-development'
// 営業用のデモ(/demo/。lib/demo/runtime.ts の DEMO_RUNTIME_MARKER)。役割を選ぶだけで入れるログインと、
// ブラウザの中の GAS は、デモのビルドだけに入る。本番のビルドに入っていたら失敗させる
export const DEMO_RUNTIME_MARKER = 'ohsumi-demo-runtime-only-in-demo-build'

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

/** 目印の文字列を含むファイルの一覧 */
export function findDemoLogin(outDir, marker = DEMO_LOGIN_MARKER) {
  return files(outDir).filter((f) => readFileSync(f).includes(marker))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  // --demo: デモのビルド(scripts/build-demo.mjs)を確かめる。開発用のログインは無く、デモの部品はある
  const demo = args.includes('--demo')
  const outDir = args.find((a) => !a.startsWith('--')) ?? 'out'
  const found = findDemoLogin(outDir)
  if (found.length) {
    console.error(`開発環境専用のデモ用ログイン画面が本番のビルドに含まれています:\n  ${found.join('\n  ')}`)
    process.exit(1)
  }
  const runtime = findDemoLogin(outDir, DEMO_RUNTIME_MARKER)
  if (!demo && runtime.length) {
    console.error(`営業用のデモの部品(役割を選ぶだけのログイン)が本番のビルドに含まれています:\n  ${runtime.join('\n  ')}`)
    process.exit(1)
  }
  if (demo && !runtime.length) {
    console.error('デモのビルドに、デモの部品が入っていません(next.config.mjs の差し替えが効いていません)')
    process.exit(1)
  }
  console.log('デモ用のログイン画面が含まれていないことを確認しました')
}
