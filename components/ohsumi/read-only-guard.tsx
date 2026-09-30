'use client'

// 機能停止中(読み取り専用。R1-e)の画面の扱い(lib/ohsumi/read-only.ts)。
//   ReadOnlyInputs: 文字・数値・日付などを書く欄とファイルの選択を、最初から使えなくする
//                   (閲覧のための欄は data-read-only-ok で残す)。後から出た欄(開いた画面・ダイアログ)にも効かせる
//   ReadOnlyNotice: 作成・編集の操作を止めた時・GAS に断られた時の知らせ。送ろうとした文章をコピーできるように出す
import { useEffect, useState } from 'react'
import { Copy, Lock } from 'lucide-react'
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
  return (
    <Modal open onClose={closeReadOnlyNotice} labelledBy="read-only-notice-title">
      <div {...{ [READ_ONLY_OK_ATTR]: '' }}>
        <h2 id="read-only-notice-title" className="flex items-center gap-2 text-base font-semibold">
          <Lock className="size-4 shrink-0" />
          {t('app.readOnlyNoticeTitle')}
        </h2>
        <p className="mt-2 text-sm break-words text-muted-foreground">{t('app.contractRestricted')}</p>
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
        <div className="mt-4 flex justify-end">
          <Button onClick={closeReadOnlyNotice}>{t('common.close')}</Button>
        </div>
      </div>
    </Modal>
  )
}
