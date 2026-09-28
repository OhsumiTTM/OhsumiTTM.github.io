'use client'

// 開発環境(pnpm dev)で GAS を設定していない場合だけ使う、デモ用のログイン画面。
// ローカルのモックデータのメンバーを選ぶだけでログインできるため、**本番のビルドには
// 絶対に含めない**。login-screen.tsx から NODE_ENV === 'development' の時だけ読み込み、
// 本番のビルドではこのファイルごと取り除かれる。取り除かれていることは、ビルドの最後に
// scripts/check-no-demo-login.mjs が下の目印の文字列を探して確かめる(見つかればビルド失敗)。
import { Button } from '@/components/ui/button'
import { isRemoteConfigured } from '@/lib/ohsumi/remote'
import { useOhsumi } from '@/lib/ohsumi/store'

export const DEMO_LOGIN_MARKER = 'ohsumi-demo-login-only-in-development'

export default function DemoLogin() {
  const { login, members } = useOhsumi()
  // 念のため、ここでも開発環境・GAS 未設定の場合以外は何も表示しない
  if (process.env.NODE_ENV !== 'development' || isRemoteConfigured) return null
  return (
    <div data-marker={DEMO_LOGIN_MARKER}>
      <p className="text-left text-sm text-muted-foreground">
        開発用のデモ(ローカルのモックデータ)です。ログインするメンバーを選んでください。
      </p>
      <div className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto">
        {members.map((m) => (
          <Button key={m.id} variant="outline" className="justify-start" onClick={() => login(m.id)}>
            {m.displayName || m.name}
            <span className="ml-auto text-xs text-muted-foreground">{m.role}</span>
          </Button>
        ))}
      </div>
    </div>
  )
}
