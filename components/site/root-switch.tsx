'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { OhsumiApp } from '@/components/ohsumi/ohsumi-app'

// サイトのトップ(/)の出し分け:
//   ・?org=(招待リンク・通知のリンク・ブックマーク・ホーム画面のアイコン)か ?login= がある → Ohsumi の画面
//   ・どちらも無い → Ohsumi のホームページ
// ページの HTML にはホームページを書き出しておき(検索・OGP のため)、?org= がある時は、
// app/layout.tsx の最初のスクリプトが <html> に ohsumi-app を付けて、ホームページを描く前に隠す(一瞬も見えないように)
export function wantsApp(search: string): boolean {
  return /[?&](org|login)=/.test(search)
}

export function RootSwitch({ home }: { home: ReactNode }) {
  const [app, setApp] = useState<boolean | null>(null)
  useEffect(() => {
    setApp(wantsApp(window.location.search))
  }, [])
  if (app) return <OhsumiApp />
  return <div data-site-home="">{home}</div>
}
