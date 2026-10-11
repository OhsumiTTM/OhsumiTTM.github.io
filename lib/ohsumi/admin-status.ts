// 管理画面の上部の知らせ(components/ohsumi/admin/*-banner.tsx)の状態を、1回の通信(getAdminStatus)でまとめて読む。
//   - 知らせごとに別々に読むと、1回の往復(1〜2秒)が GAS の処理(0.1〜0.5秒)よりずっと長く、並んで待たされていた
//   - 同じ時に頼まれた分は1回にまとめ、ADMIN_STATUS_TTL_MS の間は読み直さない(管理画面を開き直すたびに読まない)
//   - 古い GAS(getAdminStatus が無い)の団体では、今まで通りそれぞれの操作で読む
//   - その部分を見られない人(GAS が入れなかった部分)は、失敗として扱う(知らせは何も出さない。今までと同じ)
import { remoteApi } from './remote'

export const ADMIN_STATUS_TTL_MS = 60_000

type Parts = {
  announcements: Awaited<ReturnType<typeof remoteApi.getAnnouncements>>
  gasUpdate: Awaited<ReturnType<typeof remoteApi.getGasUpdateStatus>>
  mailQuota: Awaited<ReturnType<typeof remoteApi.getMailQuotaStatus>>
  ops: Awaited<ReturnType<typeof remoteApi.getOpsStatus>>
  backup: Awaited<ReturnType<typeof remoteApi.getBackupStatus>>
  personalData: Awaited<ReturnType<typeof remoteApi.getPersonalDataStatus>>
}
export type AdminStatusKey = keyof Parts
export type AdminStatus = Partial<Parts> & { errors?: Partial<Record<AdminStatusKey, string>> }

// 古い GAS の時に、それぞれ読む操作
const SINGLE: { [K in AdminStatusKey]: () => Promise<Parts[K]> } = {
  announcements: () => remoteApi.getAnnouncements(),
  gasUpdate: () => remoteApi.getGasUpdateStatus(),
  mailQuota: () => remoteApi.getMailQuotaStatus(),
  ops: () => remoteApi.getOpsStatus(),
  backup: () => remoteApi.getBackupStatus(),
  personalData: () => remoteApi.getPersonalDataStatus(),
}

let cached: { at: number; promise: Promise<AdminStatus | 'unsupported'> } | null = null

export function isUnknownActionError(err: unknown): boolean {
  return err instanceof Error && /^Unknown action: getAdminStatus/.test(err.message)
}

function loadAll(fetchAll: () => Promise<AdminStatus>, now: number): Promise<AdminStatus | 'unsupported'> {
  if (cached && now - cached.at < ADMIN_STATUS_TTL_MS) return cached.promise
  const promise = fetchAll().catch((err: unknown) => {
    if (isUnknownActionError(err)) return 'unsupported' as const
    throw err
  })
  const entry = { at: now, promise }
  cached = entry
  // 失敗した時は覚えない(次に頼まれた時に読み直す)
  promise.catch(() => { if (cached === entry) cached = null })
  return promise
}

/** 管理画面の上部の知らせの1つの部分を読む。見られない部分・失敗した部分は reject */
export async function adminStatusPart<K extends AdminStatusKey>(
  key: K,
  deps: { fetchAll?: () => Promise<AdminStatus>; single?: () => Promise<Parts[K]>; now?: number } = {},
): Promise<Parts[K]> {
  const all = await loadAll(deps.fetchAll ?? (() => remoteApi.getAdminStatus()), deps.now ?? Date.now())
  if (all === 'unsupported') return (deps.single ?? SINGLE[key])()
  const part = all[key]
  if (part === undefined) throw new Error(all.errors?.[key] || 'この知らせは見られません')
  return part as Parts[K]
}

/** 状態を変えた後(共有の確かめ直しなど)に、次は読み直す */
export function forgetAdminStatus() {
  cached = null
}
