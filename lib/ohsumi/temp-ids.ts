// 作ったばかりのタスクの仮の ID('t-…')と、GAS が付けた本当の ID の対応。
// 画面はタスクを仮の ID ですぐに表示し、createTasks の応答で本当の ID に差し替える。
// 応答を待っている間に、そのタスクを変えた時の書き込みは、本当の ID が分かるまで待ってから送る
// (仮の ID のまま送ると、GAS にその行が無いので失敗する)。作成に失敗した時は、待っていた書き込みも失敗にする
import { renameServerRow } from './sync-state'

const pending = new Map<string, Promise<string>>()
const resolved = new Map<string, string>()

export class TempTaskCreateFailedError extends Error {
  constructor() {
    super('タスクの登録に失敗したため、このタスクへの変更は保存していません。')
    this.name = 'TempTaskCreateFailedError'
  }
}

/** createTasks の応答(仮の ID → 本当の ID)を待つ。応答が来たら、仮の ID で覚えた一覧も移す */
export function trackTempIds(tempIds: readonly string[], mapping: Promise<readonly { tempId: string; id: string }[]>): void {
  const settled = mapping.then(
    (list) => {
      for (const m of list) {
        if (!m?.tempId || !m.id) continue
        resolved.set(m.tempId, m.id)
        renameServerRow('Tasks', m.tempId, m.id)
      }
      for (const id of tempIds) pending.delete(id)
    },
    () => {
      for (const id of tempIds) pending.delete(id)
      throw new TempTaskCreateFailedError()
    },
  )
  for (const id of tempIds) {
    const p = settled.then(() => {
      const real = resolved.get(id)
      if (!real) throw new TempTaskCreateFailedError()
      return real
    })
    // 待つ書き込みが無くても、失敗を「処理されなかった Promise」にしない
    p.catch(() => {})
    pending.set(id, p)
  }
}

/** 今分かっている ID(本当の ID が分かっていれば、それ) */
export function currentTaskId(id: string): string {
  return resolved.get(id) ?? id
}

/** 応答を待っている仮の ID か */
export function isPendingTempId(id: string): boolean {
  return pending.has(id)
}

/** 本当の ID が分かるまで待つ(仮の ID でなければ、そのまま) */
export function resolveTaskId(id: string): Promise<string> | string {
  return pending.get(id) ?? currentTaskId(id)
}

// 書き込みの中でタスクの ID を入れる項目
const TASK_ID_KEYS = ['taskId'] as const
const TASK_ID_LIST_KEYS = ['dependsOnIds'] as const

function needsResolve(payload: Record<string, unknown>): boolean {
  for (const k of TASK_ID_KEYS) {
    const v = payload[k]
    if (typeof v === 'string' && (pending.has(v) || resolved.has(v))) return true
  }
  for (const k of TASK_ID_LIST_KEYS) {
    const v = payload[k]
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && (pending.has(x) || resolved.has(x)))) return true
  }
  return false
}

/**
 * 書き込みの中の仮の ID を、本当の ID に書き換える(応答を待っている時は待つ)。
 * 書き換えるものが無ければ、同じ payload をすぐに返す(Promise にしない。送る順番を変えないため)
 */
export function resolveTempIdsIn<T extends Record<string, unknown>>(payload: T): T | Promise<T> {
  if (!needsResolve(payload)) return payload
  return (async () => {
    const out: Record<string, unknown> = { ...payload }
    for (const k of TASK_ID_KEYS) {
      const v = out[k]
      if (typeof v === 'string') out[k] = await resolveTaskId(v)
    }
    for (const k of TASK_ID_LIST_KEYS) {
      const v = out[k]
      if (Array.isArray(v)) out[k] = await Promise.all(v.map((x) => (typeof x === 'string' ? resolveTaskId(x) : x)))
    }
    return out as T
  })()
}

/** タスクの一覧の仮の ID を、本当の ID に差し替える(ほかのタスクの dependsOnIds も) */
export function swapTaskIds<T extends { id: string; dependsOnIds?: string[] }>(tasks: T[], realId: ReadonlyMap<string, string>): T[] {
  if (realId.size === 0) return tasks
  return tasks.map((t) => {
    const id = realId.get(t.id) ?? t.id
    const deps = t.dependsOnIds?.some((d) => realId.has(d)) ? t.dependsOnIds.map((d) => realId.get(d) ?? d) : t.dependsOnIds
    return id === t.id && deps === t.dependsOnIds ? t : { ...t, id, dependsOnIds: deps }
  })
}

/** テスト用: 覚えている対応を消す */
export function resetTempIdsForTest(): void {
  pending.clear()
  resolved.clear()
}
