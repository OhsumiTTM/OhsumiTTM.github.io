'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { OhsumiApp } from '@/components/ohsumi/ohsumi-app'
import { ReloginWindow } from '@/components/ohsumi/relogin-window'
import { isReloginSearch } from '@/lib/ohsumi/multi-org'

// サイトのトップ(/)の出し分け:
//   ・?org=(招待リンク・通知のリンク・ブックマーク・ホーム画面のアイコン)か ?login= がある → Ohsumi の画面
//   ・どちらも無い → Ohsumi のホームページ
//   ・?org=<団体ID>&relogin=1 → 兼部の統合表示から開く、その団体に切り替えずにログインし直す小さい窓
// ページの HTML にはホームページを書き出しておき(検索・OGP のため)、?org= がある時は、
// app/layout.tsx の最初のスクリプトが <html> に ohsumi-app を付けて、ホームページを描く前に隠す(一瞬も見えないように)
export function wantsApp(search: string): boolean {
  return /[?&](org|login)=/.test(search)
}

export function RootSwitch({ home }: { home: ReactNode }) {
  const [app, setApp] = useState<'app' | 'relogin' | null>(null)
  useEffect(() => {
    const search = window.location.search
    setApp(isReloginSearch(search) ? 'relogin' : wantsApp(search) ? 'app' : null)
  }, [])
  if (app === 'relogin') return <ReloginWindow />
  if (app) return <OhsumiApp />
  return <div data-site-home="">{home}</div>
}
