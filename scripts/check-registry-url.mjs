// ビルドの前に、レジストリの URL(NEXT_PUBLIC_REGISTRY_URL)の形を確かめる。
// 形が違えばビルドを止める(値そのものは表示しない)。
// 団体の GAS の URL は、レジストリが団体ごとに答える(ビルド時の「既定の団体」NEXT_PUBLIC_GAS_URL・GitHub Secrets の CSV_GAS は
// R1-f 後半で消した)。設定が残っていたら、消し忘れとしてビルドを止める。
//
// 使い方: node scripts/check-registry-url.mjs
import { pathToFileURL } from 'node:url'

const CANONICAL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/

/** レジストリはレジストリ専用の個人向け Google アカウントに置くので、/macros/s/…/exec の形だけを受け付ける(未設定はよい) */
export function registryUrlLevel(url) {
  const u = String(url ?? '').trim()
  return !u || CANONICAL.test(u) ? 'ok' : 'error'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (String(process.env.NEXT_PUBLIC_GAS_URL ?? '').trim()) {
    console.error(
      'NEXT_PUBLIC_GAS_URL(GitHub Secrets の CSV_GAS)は使わなくなりました。団体の接続先はレジストリが答えます。' +
        '.github/workflows/deploy.yml と環境変数から NEXT_PUBLIC_GAS_URL を外してください。',
    )
    process.exit(1)
  }
  if (registryUrlLevel(process.env.NEXT_PUBLIC_REGISTRY_URL) === 'error') {
    console.error(
      'NEXT_PUBLIC_REGISTRY_URL(GitHub Secrets の REGISTRY_URL)の形が正しくありません。' +
        'レジストリのデプロイの「ウェブアプリの URL」(https://script.google.com/macros/s/…/exec)をそのまま使ってください。',
    )
    process.exit(1)
  }
}
