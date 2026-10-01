// 記録の一覧(コメント・1on1 の記録・経歴など)を、丸ごとではなく項目ごとの差分(listOps)で送るための道具。
// gas/Code.gs の「記録の一覧の差分(listOps)」と同じ決まり(LIST_ACTIONS は Code.gs と同じ内容。
// lib/ohsumi/list-diff.test.ts で確かめる)。
//   { op: 'add', entry }                 足す
//   { op: 'update', key, before, entry } 変える(before: 画面が知っている変える前の内容。GAS は今の内容と比べ、違えば競合として断る)
//   { op: 'remove', key, before }        消す
// 差分に無い項目(ほかの人が後から足した記録など)は、GAS が消さない。

export interface ListActionDef {
  sheet: 'Tasks' | 'Members'
  idParam: 'taskId' | 'memberId'
  column: string
  param: string
  key: string
  addAt?: 'start'
  cap?: number
  addOnly?: boolean
}

export const LIST_ACTIONS: Record<string, ListActionDef> = {
  updateComments: { sheet: 'Tasks', idParam: 'taskId', column: 'comments_json', param: 'comments', key: 'id' },
  updateProgress: { sheet: 'Tasks', idParam: 'taskId', column: 'progress_history_json', param: 'progressHistory', key: 'id' },
  updateHistory: { sheet: 'Tasks', idParam: 'taskId', column: 'history_json', param: 'history', key: 'id', addAt: 'start', cap: 50, addOnly: true },
  updateDeliverables: { sheet: 'Tasks', idParam: 'taskId', column: 'deliverables_json', param: 'deliverables', key: 'id' },
  updateCareerHistory: { sheet: 'Members', idParam: 'memberId', column: 'career_history_json', param: 'entries', key: 'id' },
  updateQualifications: { sheet: 'Members', idParam: 'memberId', column: 'qualifications_json', param: 'entries', key: 'id' },
  updateEvaluationHistory: { sheet: 'Members', idParam: 'memberId', column: 'evaluation_history_json', param: 'entries', key: 'id' },
  updateTransferHistory: { sheet: 'Members', idParam: 'memberId', column: 'transfer_history_json', param: 'entries', key: 'id' },
  updateSkillLevels: { sheet: 'Members', idParam: 'memberId', column: 'skill_levels_json', param: 'levels', key: 'skill' },
  updateCompetencies: { sheet: 'Members', idParam: 'memberId', column: 'competencies_json', param: 'competencies', key: 'name' },
  updateTrainingHistory: { sheet: 'Members', idParam: 'memberId', column: 'training_history_json', param: 'entries', key: 'id' },
  updateDevelopmentPlan: { sheet: 'Members', idParam: 'memberId', column: 'development_plan_json', param: 'entries', key: 'id' },
  updateOneOnOnes: { sheet: 'Members', idParam: 'memberId', column: 'one_on_ones_json', param: 'entries', key: 'id' },
}

export type ListOp =
  | { op: 'add'; entry: unknown }
  | { op: 'update'; key: string; before: unknown; entry: unknown }
  | { op: 'remove'; key: string; before: unknown }

/** 比べるための形(キーの順番をそろえ、undefined を除く。gas/Code.gs の canonicalJson_ と同じ) */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

/** base(画面が知っている一覧)から next(変えた後の一覧)への差分。足す項目は next の順番のまま */
export function diffList(base: readonly unknown[] | undefined, next: readonly unknown[], key: string): ListOp[] {
  const keyOf = (e: unknown) => {
    const v = e && typeof e === 'object' ? (e as Record<string, unknown>)[key] : undefined
    return v === undefined || v === null ? '' : String(v)
  }
  const before = new Map<string, unknown>()
  for (const e of base ?? []) if (keyOf(e)) before.set(keyOf(e), e)
  const seen = new Set<string>()
  const ops: ListOp[] = []
  for (const e of next) {
    const k = keyOf(e)
    if (!k || seen.has(k)) continue
    seen.add(k)
    const old = before.get(k)
    if (old === undefined) ops.push({ op: 'add', entry: e })
    else if (canonicalJson(old) !== canonicalJson(e)) ops.push({ op: 'update', key: k, before: old, entry: e })
  }
  for (const [k, old] of before) if (!seen.has(k)) ops.push({ op: 'remove', key: k, before: old })
  return ops
}

/**
 * 一覧を丸ごと入れた書き込み(body)を、差分(listOps)の書き込みにする。baseOf は、その行の今の一覧を返す。
 * batch は中の操作ごとに変える(テストで、今の画面と同じ送り方にするのに使う)
 */
export function withListOps<T extends Record<string, unknown>>(body: T, baseOf: (def: ListActionDef, id: string) => unknown[]): T {
  if (body.action === 'batch' && Array.isArray(body.ops)) {
    return { ...body, ops: (body.ops as Record<string, unknown>[]).map((op) => withListOps(op, baseOf)) }
  }
  const def = LIST_ACTIONS[String(body.action)]
  if (!def || body.listOps !== undefined || body[def.param] === undefined) return body
  const next = Array.isArray(body[def.param]) ? (body[def.param] as unknown[]) : []
  const out: Record<string, unknown> = { ...body, listOps: diffList(baseOf(def, String(body[def.idParam] ?? '')), next, def.key) }
  delete out[def.param]
  return out as T
}

/** セルの値(JSON の一覧)を読む。読めなければ空 */
export function parseListCell(raw: unknown): unknown[] {
  try {
    const v = JSON.parse(String(raw || '[]'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
