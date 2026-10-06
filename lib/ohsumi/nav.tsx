'use client'

import { createContext, useContext, useState, useCallback, useRef } from 'react'

import type { AdminSection, Department } from './types'

export type OutputTarget = 'all' | 'people' | 'projects'
export type OutputView = 'workflow' | 'list' | 'calendar' | 'difficulty'

export type Screen =
  | { name: 'input' }
  | {
      name: 'output'
      target?: OutputTarget
      view?: OutputView
      department?: Department
    }
  | { name: 'person'; id: string }
  | { name: 'project'; id: string }
  | {
      name: 'admin'
      section: AdminSection
    }
  | { name: 'feedback' }
  // item 6: 個人コメント・進捗報告横断一覧
  | { name: 'activity' }
  // item 23: 日報・週報
  | { name: 'dailyreport' }
  // item 22: メンバー体験定点測定アンケート
  | { name: 'survey' }
  // 団体設定（Admin権限者向け）
  | { name: 'org-settings' }
  // item 10/11: スキル表グリッド（縦軸=メンバー、横軸=スキル）
  | { name: 'skillgrid' }
  // LRN-001: 学習コンテンツ一覧（メンバー向け閲覧画面）
  | { name: 'learning' }

// 画面を離れる前の確かめ(書きかけの入力がある画面が登録する)。true を返したら移動を止め、
// 画面が確かめの知らせを出す。続けてよければ proceed() で移動する。target は移動先(戻る時は無し)
export type LeaveGuard = (proceed: () => void, target?: Screen) => boolean

interface NavValue {
  screen: Screen
  // after: 実際に移動した時だけ呼ぶ(離れる前の確かめで止めた時は呼ばない)
  go: (s: Screen, after?: () => void) => void
  goBack: () => void
  canGoBack: boolean
  setLeaveGuard: (guard: LeaveGuard | null) => void
}

const NavContext = createContext<NavValue | null>(null)

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>({ name: 'output' })
  const [history, setHistory] = useState<Screen[]>([])
  const guardRef = useRef<LeaveGuard | null>(null)
  const setLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    guardRef.current = guard
  }, [])
  // 確かめを通ったら、確かめは外す(移動した先の画面には残さない)
  const guarded = useCallback((proceed: () => void, target?: Screen) => {
    const guard = guardRef.current
    const run = () => {
      guardRef.current = null
      proceed()
    }
    if (guard && guard(run, target)) return
    proceed()
  }, [])
  const go = useCallback((s: Screen, after?: () => void) => {
    guarded(() => {
      setScreen((prev) => {
        setHistory((h) => [...h, prev])
        return s
      })
      after?.()
      if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
    }, s)
  }, [guarded])
  const goBack = useCallback(() => {
    guarded(() => {
      setHistory((h) => {
        if (h.length === 0) return h
        const prev = h[h.length - 1]
        setScreen(prev)
        if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
        return h.slice(0, -1)
      })
    })
  }, [guarded])
  return (
    <NavContext.Provider value={{ screen, go, goBack, canGoBack: history.length > 0, setLeaveGuard }}>
      {children}
    </NavContext.Provider>
  )
}

export function useNav() {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav must be used within NavProvider')
  return ctx
}
