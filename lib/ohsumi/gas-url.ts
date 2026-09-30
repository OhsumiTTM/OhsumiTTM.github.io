// 団体の GAS(ウェブアプリ)の URL の形。使うのはデプロイの「ウェブアプリの URL」そのもの(https://script.google.com/macros/s/<ID>/exec)。
// 団体の接続先はレジストリが答え(org-directory.ts)、この形のものだけを使う。
//   - /dev の URL は編集者だけが使えるテスト用で、ログインしていない画面からは使えない
//   - /u/1/ などを含む URL は、Google が転送し、POST が GET に変わって本文が失われる
export const CANONICAL_GAS_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/
