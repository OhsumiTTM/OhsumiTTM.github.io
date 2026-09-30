// 楽観的な更新(画面はすぐに変更を表示し、裏で保存する)で、保存に失敗した時に元に戻す。
//
// 戻すのは、その操作で変えた項目と、その操作で足した変更の記録(history)だけ。
// 保存を待っている間に同じ項目をさらに変えていた(今の値が、その操作の後の値と違う)時は、
// 新しい変更を消さないよう戻さない(新しい変更の保存の結果に任せる)。
import type { Task } from './types'

export function revertTaskChange<K extends keyof Task>(
  tasks: Task[],
  id: string,
  before: Task | undefined,
  after: Task | undefined,
  fields: readonly K[],
): Task[] {
  if (!before || !after) return tasks
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
  const beforeHistoryIds = new Set((before.history ?? []).map((h) => h.id))
  const addedHistoryIds = new Set((after.history ?? []).map((h) => h.id).filter((hid) => !beforeHistoryIds.has(hid)))
  return tasks.map((t) => {
    if (t.id !== id) return t
    if (fields.some((f) => !same(t[f], after[f]))) return t
    const restored: Task = { ...t }
    for (const f of fields) restored[f] = before[f]
    if (addedHistoryIds.size > 0) restored.history = (t.history ?? []).filter((h) => !addedHistoryIds.has(h.id))
    return restored
  })
}
