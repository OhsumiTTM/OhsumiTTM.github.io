'use client'

// ナレッジのページの一覧(見る人が見られるページだけ。GAS の listWikiPages)を、画面のあちこちで1回だけ読んで使い回す。
// タスク・プロジェクトにつないだページの題を出す・つなぐページを選ぶのに使う(見られないページは一覧に無いので出ない)
import { useCallback, useEffect, useState } from 'react'
import { isRemoteConfigured, remoteApi } from './remote'
import type { WikiList } from './wiki'

let cached: Promise<WikiList> | null = null
const listeners = new Set<() => void>()

/** 一覧を読み直す(ナレッジの画面でページを作った・承認した時) */
export function invalidateWikiList() {
  cached = null
  listeners.forEach((fn) => fn())
}

function load(): Promise<WikiList> {
  if (!isRemoteConfigured) return Promise.resolve({ pages: [], myProposals: [], manager: false })
  if (!cached) {
    cached = remoteApi.listWikiPages().catch((e: unknown) => {
      cached = null
      throw e
    })
  }
  return cached
}

export function useWikiPageList(enabled = true) {
  const [list, setList] = useState<WikiList | null>(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    listeners.add(reload)
    return () => { listeners.delete(reload) }
  }, [reload])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    load().then(
      (l) => { if (alive) { setList(l); setFailed(false) } },
      () => { if (alive) setFailed(true) },
    )
    return () => { alive = false }
  }, [enabled, tick])
  return { pages: list?.pages ?? [], loaded: !!list, failed }
}
