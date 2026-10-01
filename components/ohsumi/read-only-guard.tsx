'use client'

// 機能停止中(読み取り専用。R1-e)の画面の扱い(lib/ohsumi/read-only.ts)。
//   ReadOnlyInputs: 文字・数値・日付などを書く欄とファイルの選択を、最初から使えなくする
//                   (閲覧のための欄は data-read-only-ok で残す)。後から出た欄(開いた画面・ダイアログ)にも効かせる
//   ReadOnlyNotice: 作成・編集の操作を止めた時・GAS に断られた時の知らせ。送ろうとした文章をコピーできるように出す。
//                   機能停止中のほか、ログインが切れた・提供停止・画面が古い時にも使う(kind。ログイン画面にも出す)
//   SessionExpiryBanner: ログインの期限が近づいたら、先に知らせる(書きかけを残したまま、ログインし直せる)
import { useEffect, useState } from 'react'
import { Clock, Copy, Lock, RefreshCw } from 'lucide-react'
import { getSessionExpiry, reloadPage } from '@/lib/ohsumi/session'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { applyReadOnlyInputs, READ_ONLY_OK_ATTR } from '@/lib/ohsumi/read-only'
import { Modal } from './modal'
import { Button } from '@/components/ui/button'

export function ReadOnlyInputs() {
  const { readOnly } = useOhsumi()
  const { t } = useI18n()
  useEffect(() => {
    const root = document.body
    const title = t('app.readOnlyInputTitle')
    applyReadOnlyInputs(root, readOnly, title)
    if (!readOnly) return
    // 開いた画面・ダイアログの欄と、画面が使えるように戻した欄にも効かせる
    const observer = new MutationObserver(() => { applyReadOnlyInputs(root, true, title) })
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
    return () => {
      observer.disconnect()
      applyReadOnlyInputs(root, false, title)
    }
  }, [readOnly, t])
  return null
}

export function ReadOnlyNotice() {
  const { readOnlyNotice, closeReadOnlyNotice } = useOhsumi()
  const { t } = useI18n()
  const [copied, setCopied] = useState<number | null>(null)
  if (!readOnlyNotice) return null
  const copy = async (i: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(i)
    } catch {
      setCopied(null)
    }
  }
  const kind = readOnlyNotice.kind ?? 'readOnly'
  const title = { readOnly: 'app.readOnlyNoticeTitle', sessionEnded: 'app.sessionEndedNoticeTitle', orgSuspended: 'app.orgSuspendedNoticeTitle', reloadRequired: 'app.reloadRequiredNoticeTitle', cellTooLong: 'app.cellTooLongNoticeTitle' } as const
  const body = { readOnly: 'app.contractRestricted', sessionEnded: 'app.sessionEndedNoticeBody', orgSuspended: 'app.orgSuspendedNoticeBody', reloadRequired: 'app.reloadRequiredNoticeBody', cellTooLong: 'app.cellTooLongNoticeBody' } as const
  return (
    <Modal open onClose={closeReadOnlyNotice} labelledBy="read-only-notice-title">
      <div {...{ [READ_ONLY_OK_ATTR]: '' }} data-unsaved-notice={kind}>
        <h2 id="read-only-notice-title" className="flex items-center gap-2 text-base font-semibold">
          <Lock className="size-4 shrink-0" />
          {t(title[kind])}
        </h2>
        <p className="mt-2 text-sm break-words text-muted-foreground">{t(body[kind])}</p>
        {readOnlyNotice.texts.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium">{t('app.readOnlyNoticeTexts')}</p>
            {readOnlyNotice.texts.map((text, i) => (
              <div key={i} className="space-y-1">
                <textarea
                  readOnly
                  value={text}
                  rows={Math.min(6, Math.max(2, text.split('\n').length))}
                  className="w-full min-w-0 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button size="sm" variant="outline" onClick={() => void copy(i, text)}>
                  <Copy className="size-3.5" />
                  {copied === i ? t('app.readOnlyNoticeCopied') : t('app.readOnlyNoticeCopy')}
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {kind === 'reloadRequired' && (
            // 読み込み直す(INPUT の書きかけは端末に残る。ここに出した文章は、読み込み直すと消える)
            <Button variant="outline" onClick={() => { closeReadOnlyNotice(); reloadPage() }}>
              <RefreshCw className="size-3.5" />
              {t('app.reloadRequiredReload')}
            </Button>
          )}
          <Button onClick={closeReadOnlyNotice}>{t('common.close')}</Button>
        </div>
      </div>
    </Modal>
  )
}

// ログインの期限まで、これより短くなったら知らせる
export const SESSION_EXPIRY_WARN_SEC = 15 * 60

/** ログインの期限が近づいたら、上部に知らせる。「ログインし直す」は、書きかけを残したままログイン画面に戻す */
export function SessionExpiryBanner() {
  const { restartLogin } = useOhsumi()
  const { t } = useI18n()
  const [left, setLeft] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => {
      const exp = getSessionExpiry()
      setLeft(exp ? exp - Math.floor(Date.now() / 1000) : null)
    }
    tick()
    const id = window.setInterval(tick, 30 * 1000)
    return () => window.clearInterval(id)
  }, [])
  if (left === null || left <= 0 || left > SESSION_EXPIRY_WARN_SEC) return null
  return (
    <div role="status" data-session-expiry className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-warning-muted px-4 py-1.5 text-center text-xs font-medium text-warning">
      <span className="flex items-center gap-1.5">
        <Clock className="size-3.5 shrink-0" />
        {t('app.sessionExpiryBanner', { minutes: String(Math.max(1, Math.ceil(left / 60))) })}
      </span>
      <button type="button" onClick={restartLogin} className="underline underline-offset-2">
        {t('app.sessionExpiryRelogin')}
      </button>
    </div>
  )
}
