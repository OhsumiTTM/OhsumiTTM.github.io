// ビルドの前に、団体の GAS の URL(NEXT_PUBLIC_GAS_URL)と、レジストリの URL(NEXT_PUBLIC_REGISTRY_URL)の形を確かめる。
// /u/数字/ を含む URL・/dev の URL・形の違う URL ならビルドを止める(lib/ohsumi/gas-url.ts と同じ決まり)。
// 値そのものは表示しない。
//
// 使い方: node scripts/check-gas-url.mjs
import { pathToFileURL } from 'node:url'

const CANONICAL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/
const WORKSPACE = /^https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\/[A-Za-z0-9_-]+\/exec$/

/** @returns {'ok' | 'error'} */
export function registryUrlLevel(url) {
  const u = String(url ?? '').trim()
  return !u || CANONICAL.test(u) ? 'ok' : 'error'
}

/** @returns {'ok' | 'warn' | 'error'} */
export function gasUrlLevel(url) {
  const u = String(url ?? '').trim()
  if (!u || CANONICAL.test(u)) return 'ok'
  if (WORKSPACE.test(u) && !/\/u\/\d+\//.test(u)) return 'warn'
  return 'error'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const level = gasUrlLevel(process.env.NEXT_PUBLIC_GAS_URL)
  if (level === 'error') {
    console.error(
      'NEXT_PUBLIC_GAS_URL(GitHub Secrets の CSV_GAS)の形が正しくありません。' +
        'デプロイの「ウェブアプリの URL」(https://script.google.com/macros/s/…/exec)をそのまま使ってください。' +
        '/u/1/ などを含む URL(複数の Google アカウントにログインしたブラウザのアドレスバーからコピーしたもの)や /dev の URL は使えません。',
    )
    process.exit(1)
  }
  if (level === 'warn') {
    console.warn('NEXT_PUBLIC_GAS_URL が Google Workspace の形(/a/macros/…)です。https://script.google.com/macros/s/…/exec の形をおすすめします。')
  }
  // レジストリはレジストリ専用の個人向け Google アカウントに置くので、/macros/s/…/exec の形だけを受け付ける
  if (registryUrlLevel(process.env.NEXT_PUBLIC_REGISTRY_URL) === 'error') {
    console.error(
      'NEXT_PUBLIC_REGISTRY_URL(GitHub Secrets の REGISTRY_URL)の形が正しくありません。' +
        'レジストリのデプロイの「ウェブアプリの URL」(https://script.google.com/macros/s/…/exec)をそのまま使ってください。',
    )
    process.exit(1)
  }
}
