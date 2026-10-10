'use client'

// デモのビルドだけで使う部品(next.config.mjs が lib/demo/entry.ts をこのファイルに差し替える)。
// 読み込んだ時点で、保存と通信をデモ用に差し替える(./runtime)。本番のビルドには入らない。
// 保存・通信の差し替え(./runtime)は、ほかの部品より先に読み込む
import { DEMO_RUNTIME_MARKER, resetDemo } from './runtime'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useOhsumi } from '@/lib/ohsumi/store'
import { DEMO_ACCOUNTS, DEMO_ORG_NAME, type DemoSlot } from './engine'
import { base64UrlOf, sha256Base64Url } from './google-env'
import type { DemoHooks } from './entry'

// ログインできる見本のメンバー(gas/sample/30-showcase-data.gs。名前は架空)
const ROLES: { slot: DemoSlot; role: string; name: string; note: string }[] = [
  { slot: 'top', role: '代表', name: '森田 葵', note: '団体全体の設定・メンバー・集計まで、すべて見られます' },
  { slot: 'admin', role: '班長', name: '石井 拓真', note: 'タスクの割り振り・承認、メンバーの育成を担当します' },
  { slot: 'base', role: 'メンバー', name: '藤井 ひなた', note: '自分のタスクの進め方・成長の記録を体験できます' },
  { slot: 'base_en', role: 'Member (English)', name: 'Lena Fischer', note: '英語表示のメンバーとして見られます' },
]

function randomSecret(): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** 本物と同じログインの手順を、偽の ID トークンで通す(確かめるのはブラウザの中の GAS だけ) */
function demoIdToken(email: string, orgId: string, secret: string): string {
  return base64UrlOf('{"alg":"none"}') + '.' + base64UrlOf(JSON.stringify({ email, nonce: orgId + '.' + sha256Base64Url(secret) })) + '.demo'
}

function LoginPanel({ orgId }: { orgId: string }) {
  const { signInWithGoogle } = useOhsumi()
  const [busy, setBusy] = useState<DemoSlot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const signIn = async (slot: DemoSlot) => {
    setBusy(slot)
    setError(null)
    try {
      const secret = randomSecret()
      const res = await signInWithGoogle(demoIdToken(DEMO_ACCOUNTS[slot], orgId, secret), secret, true, orgId)
      if (res.status !== 'ok') setError('ログインできませんでした。「最初からやり直す」を押してください。')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインできませんでした。')
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="text-left" data-demo={DEMO_RUNTIME_MARKER}>
      <p className="text-sm font-medium">デモの団体「{DEMO_ORG_NAME}」に入る</p>
      <p className="mt-1 text-xs text-muted-foreground">役割を選ぶと、その人として Ohsumi を操作できます。役割によって、見える範囲とできることが変わります。</p>
      <div className="mt-3 flex flex-col gap-2">
        {ROLES.map((r) => (
          <button
            key={r.slot}
            type="button"
            disabled={busy !== null}
            onClick={() => signIn(r.slot)}
            className="flex w-full min-w-0 flex-col items-start rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
          >
            <span className="flex w-full min-w-0 items-baseline gap-2">
              <span className="text-sm font-semibold">{r.role}</span>
              <span className="truncate text-xs text-muted-foreground">{r.name}</span>
              {busy === r.slot && <span className="ml-auto shrink-0 text-xs text-muted-foreground">準備中…</span>}
            </span>
            <span className="mt-0.5 text-xs text-muted-foreground">{r.note}</span>
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      <p className="mt-4 text-[11px] text-muted-foreground">
        人の名前・団体はすべて架空です。操作した内容は、このタブの中だけに残り、ほかの人には見えません。タブを閉じると消えます。
      </p>
    </div>
  )
}

function Banner() {
  return (
    <div
      role="note"
      data-demo={DEMO_RUNTIME_MARKER}
      className="flex min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-primary px-3 py-1.5 text-center text-xs text-primary-foreground"
    >
      <span className="min-w-0">
        <span className="font-semibold">デモ</span>
        <span className="opacity-90">
          <span className="sm:hidden">(架空の団体)</span>
          <span className="hidden sm:inline">: 架空の団体「{DEMO_ORG_NAME}」です。操作はこのタブの中だけに残ります。</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <button type="button" onClick={resetDemo} className="inline-flex items-center gap-1 underline underline-offset-2">
          <RotateCcw className="size-3" />
          最初からやり直す
        </button>
        <a href="/" className="underline underline-offset-2">Ohsumi のサイトへ</a>
      </span>
    </div>
  )
}

export const demo: DemoHooks | null = { LoginPanel, Banner }
