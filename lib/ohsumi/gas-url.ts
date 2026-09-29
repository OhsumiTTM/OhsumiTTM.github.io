// 団体の GAS(ウェブアプリ)の URL の形を確かめる。
// 使うのはデプロイの「ウェブアプリの URL」そのもの(https://script.google.com/macros/s/<ID>/exec)。
//   - /dev の URL は編集者だけが使えるテスト用で、ログインしていない画面からは使えない
//   - /u/1/ などを含む URL は、ブラウザで複数の Google アカウントにログインしている時に
//     アドレスバーからコピーしたもの。Google が転送し、POST が GET に変わって本文が失われる
//   - /a/macros/<ドメイン>/ の URL は Google Workspace のもの。動くことが多いが、
//     ログインを求める転送が入ることがあるので、/macros/s/ の形をすすめる
// scripts/check-gas-url.mjs(ビルドの前の確認)と同じ決まり。lib/ohsumi/gas-url.test.ts で一致を確かめる

export type GasUrlCheck = { level: 'ok' | 'warn' | 'error'; message: string }

export const CANONICAL_GAS_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/
const WORKSPACE_GAS_URL = /^https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\/[A-Za-z0-9_-]+\/exec$/

export function checkGasUrl(url: string | undefined): GasUrlCheck {
  const u = String(url ?? '').trim()
  if (!u) return { level: 'ok', message: 'GAS の URL は未設定です' }
  if (CANONICAL_GAS_URL.test(u)) return { level: 'ok', message: 'GAS の URL はウェブアプリの /exec の形です' }
  if (/\/u\/\d+\//.test(u)) {
    return { level: 'error', message: 'GAS の URL に /u/数字/ が含まれています。デプロイの「ウェブアプリの URL」(https://script.google.com/macros/s/…/exec)をそのまま使ってください' }
  }
  if (/\/dev(\?|$)/.test(u)) {
    return { level: 'error', message: 'GAS の URL が /dev(テスト用)です。デプロイの「ウェブアプリの URL」(…/exec)を使ってください' }
  }
  if (WORKSPACE_GAS_URL.test(u)) {
    return { level: 'warn', message: 'GAS の URL が Google Workspace の形(/a/macros/…)です。ログインを求める転送が入ることがあるため、https://script.google.com/macros/s/…/exec の形をおすすめします' }
  }
  return { level: 'error', message: 'GAS の URL の形が正しくありません。デプロイの「ウェブアプリの URL」(https://script.google.com/macros/s/…/exec)を使ってください' }
}
