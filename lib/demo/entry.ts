// 本番のビルドでは、デモの部品は何も無い(null)。
// デモのビルド(NEXT_PUBLIC_OHSUMI_DEMO=1)だけ、next.config.mjs がこのファイルを lib/demo/entry.demo.tsx に差し替える。
// こうすると、本番のビルドにはデモのログイン(役割を選ぶだけで入れる)・ブラウザの中の GAS が入らない
// (scripts/check-no-demo-login.mjs がビルドの最後に確かめる)。
import type { ComponentType } from 'react'

export interface DemoHooks {
  // ログイン画面の「Google でログイン」の代わり(役割を選んで入る)
  LoginPanel: ComponentType<{ orgId: string }>
  // 画面の上の「デモです」の帯
  Banner: ComponentType
}

export const demo: DemoHooks | null = null
