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

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

/** 目印の文字列を含むファイルの一覧 */
export function findDemoLogin(outDir) {
  return files(outDir).filter((f) => readFileSync(f).includes(DEMO_LOGIN_MARKER))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = process.argv[2] ?? 'out'
  const found = findDemoLogin(outDir)
  if (found.length) {
    console.error(`開発環境専用のデモ用ログイン画面が本番のビルドに含まれています:\n  ${found.join('\n  ')}`)
    process.exit(1)
  }
  console.log('デモ用のログイン画面が含まれていないことを確認しました')
}
