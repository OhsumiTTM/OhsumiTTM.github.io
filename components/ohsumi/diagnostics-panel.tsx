'use client'

// 診断情報(団体の設定の画面。代表だけ)。gas/Code.gs の「診断情報」
//   - 「送る内容を表示する」で、個人情報を含まない診断情報を集めて見せる
//   - 確かめてから「この内容を FSIF に送る」で送り、受付番号を出す(見せたものと同じものを送る)
//   - これまでに送った受付番号(直近10件)
import { useState } from 'react'
import { Loader2, Stethoscope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ohsumi/primitives'
import { useI18n } from '@/lib/ohsumi/i18n'
import { remoteApi, type DiagnosticsHistoryEntry, type DiagnosticsPreview } from '@/lib/ohsumi/remote'

export function DiagnosticsPanel() {
  const { t, locale } = useI18n()
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null)
  const [history, setHistory] = useState<DiagnosticsHistoryEntry[]>([])
  const [receipt, setReceipt] = useState<string | null>(null)
  const [busy, setBusy] = useState<'show' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fmt = (iso: string) => (iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—')

  const show = async () => {
    setBusy('show')
    setError(null)
    setReceipt(null)
    try {
      const p = await remoteApi.getDiagnostics()
      setPreview(p)
      setHistory(p.history)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const send = async () => {
    if (!preview) return
    setBusy('send')
    setError(null)
    try {
      const res = await remoteApi.sendDiagnostics(preview.diagId)
      setReceipt(res.receiptNo)
      setHistory(res.history)
      setPreview(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div data-diagnostics-panel>
      <div className="flex items-center gap-1.5">
        <Stethoscope className="size-4 text-muted-foreground" />
        <SectionLabel>{t('diagnostics.title')}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('diagnostics.desc')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void show()} data-diagnostics-show>
          {busy === 'show' ? <><Loader2 className="size-3.5 animate-spin" />{t('diagnostics.loading')}</> : t('diagnostics.show')}
        </Button>
      </div>
      {preview && (
        <div className="mt-2 space-y-2">
          <pre data-diagnostics-preview className="max-h-80 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-snug break-all whitespace-pre-wrap">
            {JSON.stringify(preview.diagnostics, null, 2)}
          </pre>
          <p className="text-xs text-muted-foreground">{t('diagnostics.expires')}</p>
          <Button size="sm" disabled={busy !== null} onClick={() => void send()} data-diagnostics-send>
            {busy === 'send' ? t('diagnostics.sending') : t('diagnostics.send')}
          </Button>
        </div>
      )}
      {receipt && (
        <div data-diagnostics-receipt className="mt-2 rounded-md border border-border p-2 text-xs">
          <p className="font-medium">{t('diagnostics.sent', { receiptNo: receipt })}</p>
          <p className="mt-0.5 text-muted-foreground">{t('diagnostics.sentHint')}</p>
        </div>
      )}
      {history.length > 0 && (
        <div className="mt-2 text-xs">
          <p className="text-muted-foreground">{t('diagnostics.history')}</p>
          <ul className="mt-0.5 space-y-0.5">
            {history.map((h) => <li key={h.receiptNo}><span className="font-mono">{h.receiptNo}</span>({fmt(h.at)})</li>)}
          </ul>
        </div>
      )}
      {error && <p className="mt-2 text-xs break-words text-destructive">{error}</p>}
    </div>
  )
}
