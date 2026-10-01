// 画面のエラーを、団体のエラーの記録(gas/Code.gs の ErrorLog)に送る。送るのはエラーの種類(TypeError など)と、
// 分かる時は操作の名前だけ。エラーの文・画面の中身・個人情報は送らない。1回の読み込みで MAX_REPORTS 件まで
import { getSessionToken } from './session'

const MAX_REPORTS = 5
let sent = 0

/** エラーの種類(英数字と記号だけ。分からなければ Error) */
export function errorKindOf(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
  const safe = name.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60)
  return safe || 'Error'
}

export function reportClientError(report: (kind: string, action?: string) => Promise<unknown>, err: unknown, action?: string): void {
  if (sent >= MAX_REPORTS || !getSessionToken()) return
  sent++
  report('client:' + errorKindOf(err), action).catch(() => { /* 送れなくても画面は続ける */ })
}

/** window のエラーと、受け取られなかった Promise の失敗を送る。外す関数を返す */
export function installClientErrorReporter(report: (kind: string, action?: string) => Promise<unknown>): () => void {
  if (typeof window === 'undefined') return () => {}
  const onError = (e: ErrorEvent) => reportClientError(report, e.error ?? { name: 'ErrorEvent' }, 'window')
  const onRejection = (e: PromiseRejectionEvent) => reportClientError(report, e.reason, 'promise')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

export function resetClientErrorReportsForTest(): void {
  sent = 0
}
