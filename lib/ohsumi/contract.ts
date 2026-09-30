// 提供停止・機能停止(R1-e)の画面側。
// 団体の GAS は、停止の予定・停止中の時だけ応答に contract({ phase, kind, suspendAt })を付ける
// (gas/Code.gs の contractForClient_)。付いていない成功の応答は、停止の予定が無いことを表す。
//   phase: scheduled(予定あり。まだ前)/ inEffect(停止中)。kind: suspend(提供停止)/ restrict(機能停止)
// 画面の上部には、機能停止中はアンケートへの回答のお願いを、停止の予定が14日以内なら予告を出す。
// 停止中かどうかは、GAS が応答に付けた phase だけで決める(GAS が今その状態で動いている時だけ、画面も停止にする)。
// 予定の日時を過ぎても、画面は自分で停止中とはしない(GAS は予定の日時を過ぎたら自分で停止中として動き、次の応答で伝える)。
// 提供停止中は GAS がすべての操作を断る(orgSuspended)ので、画面はログイン画面に戻して知らせる

export type ContractPhase = 'none' | 'scheduled' | 'inEffect'
export type SuspendKind = 'suspend' | 'restrict'

export interface ContractInfo {
  phase: ContractPhase
  kind: SuspendKind | ''
  suspendAt: string
}

export const NO_CONTRACT: ContractInfo = { phase: 'none', kind: '', suspendAt: '' }

// 予告を画面に出すのは、停止の予定まで14日以内になってから(代表へのメールと同じ)
export const CONTRACT_BANNER_DAYS = 14
const DAY_MS = 24 * 3600 * 1000

/** GAS の応答の contract を読む。無い・形が違う時は null */
export function parseContract(raw: unknown): ContractInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.phase !== 'scheduled' && r.phase !== 'inEffect') return null
  const kind: SuspendKind = r.kind === 'restrict' ? 'restrict' : 'suspend'
  const at = Date.parse(String(r.suspendAt ?? ''))
  return { phase: r.phase, kind, suspendAt: Number.isFinite(at) ? new Date(at).toISOString() : '' }
}

/**
 * 応答から、今の状態を決める。contract があればそれ、無い成功の応答は「予定なし」、
 * 無い失敗の応答(通信・権限の失敗など)は分からないので null(前の状態のまま)
 */
export function contractFromResponse(json: { ok?: boolean; contract?: unknown } | null | undefined): ContractInfo | null {
  if (!json) return null
  const c = parseContract(json.contract)
  if (c) return c
  return json.ok ? NO_CONTRACT : null
}

export type ContractBanner =
  | { type: 'restricted' }
  | { type: 'scheduled'; kind: SuspendKind; suspendAt: string; daysLeft: number }

/** 画面の上部に出す知らせ(出さない時は null) */
export function contractBanner(c: ContractInfo, nowMs: number): ContractBanner | null {
  if (c.phase === 'inEffect') return c.kind === 'restrict' ? { type: 'restricted' } : null
  if (c.phase !== 'scheduled' || !c.suspendAt || !c.kind) return null
  const at = Date.parse(c.suspendAt)
  // 予定の日時を過ぎた(GAS が停止中と伝えるまで、画面は停止にしない)
  if (!(at > nowMs)) return null
  const left = (at - nowMs) / DAY_MS
  if (left > CONTRACT_BANNER_DAYS) return null
  return { type: 'scheduled', kind: c.kind, suspendAt: c.suspendAt, daysLeft: Math.max(1, Math.ceil(left)) }
}

// ---- 今の状態(応答を受け取るたびに更新し、変わったら知らせる) ----

let current: ContractInfo = NO_CONTRACT
const listeners = new Set<() => void>()

export function getContract(): ContractInfo {
  return current
}

export function subscribeContract(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** GAS の応答を受け取った時に呼ぶ(remote.ts) */
export function noteContractResponse(json: { ok?: boolean; contract?: unknown } | null | undefined): void {
  const next = contractFromResponse(json)
  if (!next) return
  if (next.phase === current.phase && next.kind === current.kind && next.suspendAt === current.suspendAt) return
  current = next
  listeners.forEach((fn) => fn())
}

// テスト用
export function resetContractForTest(): void {
  current = NO_CONTRACT
  listeners.clear()
}
