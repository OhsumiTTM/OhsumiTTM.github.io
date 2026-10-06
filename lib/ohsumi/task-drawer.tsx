'use client'

// A single, app-root-level task detail drawer that any screen can open
// without navigating away first (e.g. Admin's "対応が必要" panels, the
// header's notification dropdown) — separate from the per-screen drawers
// OUTPUT/person/project pages already render locally for in-context use.
import { createContext, useContext, useState } from 'react'

interface TaskDrawerContextValue {
  openTaskId: string | null
  // commentId: 通知から開く時の、見せるコメント(コメントの欄のその位置まで送って目立たせる)
  openTask: (id: string, opts?: { commentId?: string }) => void
  closeTask: () => void
  focusCommentId: string | null
  clearFocusComment: () => void
}

const TaskDrawerContext = createContext<TaskDrawerContextValue | null>(null)

export function TaskDrawerProvider({ children }: { children: React.ReactNode }) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null)
  return (
    <TaskDrawerContext.Provider
      value={{
        openTaskId,
        openTask: (id: string, opts?: { commentId?: string }) => {
          setOpenTaskId(id)
          setFocusCommentId(opts?.commentId ?? null)
        },
        closeTask: () => {
          setOpenTaskId(null)
          setFocusCommentId(null)
        },
        focusCommentId,
        clearFocusComment: () => setFocusCommentId(null),
      }}
    >
      {children}
    </TaskDrawerContext.Provider>
  )
}

export function useTaskDrawer() {
  const ctx = useContext(TaskDrawerContext)
  if (!ctx) throw new Error('useTaskDrawer must be used within TaskDrawerProvider')
  return ctx
}

/** 通知から開いた時に見せるコメント(TaskDrawerProvider の外では無し) */
export function useFocusComment(): { focusCommentId: string | null; clearFocusComment: () => void } {
  const ctx = useContext(TaskDrawerContext)
  return { focusCommentId: ctx?.focusCommentId ?? null, clearFocusComment: ctx?.clearFocusComment ?? (() => {}) }
}
