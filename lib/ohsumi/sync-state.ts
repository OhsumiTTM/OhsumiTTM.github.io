// 書き込みの競合チェック(PR J)のために、画面が最後に読んだ内容を覚える。gas/Code.gs の「書き込みの競合チェック」
//   - 行の版(row_version): 保存の時に、開いた時点の版として送る(baseVersions)。GAS はほかの人が先に変えていたら断る
//   - 記録の一覧(コメント・1on1 など): 画面が知っている一覧(base)。保存の時は base との差分(listOps)だけを送る
// 読み込み(getInitialData)のたびに作り直す。保存した時は、その一覧を base にする(続けて変えた時の差分のため)
import { LIST_ACTIONS, diffList, type ListActionDef, type ListOp } from './list-diff'

const rowVersions = new Map<string, string>()
const listBases = new Map<string, unknown[]>()

const listKey = (def: ListActionDef, id: string) => `${def.sheet}:${id}:${def.column}`

function parse(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null || raw === '') return []
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** 読み込んだ表(シートの行)から、行の版と記録の一覧を覚える */
export function rememberServerRows(tables: Partial<Record<'Members' | 'Projects' | 'Tasks', Record<string, string>[]>>): void {
  rowVersions.clear()
  listBases.clear()
  for (const [sheet, rows] of Object.entries(tables)) {
    for (const r of rows ?? []) {
      if (!r.id) continue
      if (r.row_version) rowVersions.set(`${sheet}:${r.id}`, r.row_version)
      for (const def of Object.values(LIST_ACTIONS)) {
        if (def.sheet !== sheet || !(def.column in r)) continue
        const list = parse(r[def.column])
        if (list) listBases.set(listKey(def, r.id), list)
      }
    }
  }
}

export function forgetServerRows(): void {
  rowVersions.clear()
  listBases.clear()
}

const ID_PARAMS: [string, 'Tasks' | 'Members' | 'Projects'][] = [['taskId', 'Tasks'], ['memberId', 'Members'], ['projectId', 'Projects']]

/** 書き込みに付ける、開いた時点の行の版(知らない行は付けない) */
export function baseVersionsFor(payload: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [param, sheet] of ID_PARAMS) {
    const id = payload[param]
    if (typeof id !== 'string' || !id) continue
    const v = rowVersions.get(`${sheet}:${id}`)
    if (v) out[`${sheet}:${id}`] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 記録の一覧の保存: 画面が知っている一覧との差分にし、その一覧を base にする。
 * 失敗した時に元に戻すための関数(restore)も返す(その後に別の保存で base が変わっていれば戻さない)
 */
export function listOpsFor(action: string, id: string, next: readonly unknown[]): { listOps: ListOp[]; restore: () => void } {
  const def = LIST_ACTIONS[action]
  const key = listKey(def, id)
  const before = listBases.get(key)
  // 足すだけの一覧(変更の記録)は、足す差分だけを送る(古い記録の切り捨ては GAS が行う)
  const listOps = diffList(before ?? [], next, def.key).filter((op) => !def.addOnly || op.op === 'add')
  const saved = next.slice()
  listBases.set(key, saved)
  return {
    listOps,
    restore: () => {
      if (listBases.get(key) !== saved) return
      if (before) listBases.set(key, before)
      else listBases.delete(key)
    },
  }
}
