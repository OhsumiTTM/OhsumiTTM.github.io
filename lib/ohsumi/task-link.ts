// タスクのリンク(<サイト>/?org=<団体ID>&task=<タスクID>)。
// 入れるのは団体ID とタスクID だけ(セッション・題名は入れない)。開けるかどうかは、今までどおり
// ログインと、団体の GAS が渡すタスクの範囲(gas/src/26-read-policy.gs)で決まる。
// タスクID は団体ごとの通し番号で、同じ ID がほかの団体にもあるので、団体を変える時は task も消す
// (org-directory.ts の syncOrgParam)
import { useEffect, useRef } from 'react'

export const TASK_PARAM = 'task'
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** タスクのリンク */
export function taskLink(origin: string, basePath: string, orgId: string, taskId: string): string {
  return `${origin}${basePath || ''}/?org=${encodeURIComponent(orgId)}&${TASK_PARAM}=${encodeURIComponent(taskId)}`
}

/** URL の ?task=。無い・形が違えば null */
export function readTaskParam(search: string): string | null {
  const v = new URLSearchParams(search).get(TASK_PARAM)
  return v !== null && TASK_ID_PATTERN.test(v) ? v : null
}

function replaceUrl(edit: (url: URL) => boolean): void {
  try {
    const url = new URL(window.location.href)
    if (!edit(url)) return
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  } catch {
    /* ignore */
  }
}

/** アドレスバーを、開いているタスクの &task=<ID> にする(?org= が無い時は付けない) */
export function setTaskParam(taskId: string): void {
  replaceUrl((url) => {
    if (!url.searchParams.get('org') || url.searchParams.get(TASK_PARAM) === taskId) return false
    url.searchParams.set(TASK_PARAM, taskId)
    return true
  })
}

/** アドレスバーの &task= を消す(taskId を渡した時は、そのタスクの時だけ消す) */
export function clearTaskParam(taskId?: string): void {
  replaceUrl((url) => {
    const v = url.searchParams.get(TASK_PARAM)
    if (v === null || (taskId !== undefined && v !== taskId)) return false
    url.searchParams.delete(TASK_PARAM)
    return true
  })
}

/**
 * タスクの詳細を開いている間、アドレスバーを &task=<ID> にし、閉じたら消す。
 * 詳細を出す場所は複数あり(全体・OUTPUT・人・プロジェクト)、閉じている場所が消さないよう、
 * 自分が付けた ID の時だけ消す
 */
export function useTaskParam(taskId: string | null, enabled: boolean): void {
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (taskId) {
      if (shown.current && shown.current !== taskId) clearTaskParam(shown.current)
      setTaskParam(taskId)
      shown.current = taskId
    } else if (shown.current) {
      clearTaskParam(shown.current)
      shown.current = null
    }
  }, [taskId, enabled])
  useEffect(
    () => () => {
      if (shown.current) clearTaskParam(shown.current)
      shown.current = null
    },
    [],
  )
}
