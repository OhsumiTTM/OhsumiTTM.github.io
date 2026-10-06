'use client'

// ほかの端末で開く(ログイン後のメニュー。全員が使える)。
// この団体の招待リンク(<サイトの URL>/?org=<団体ID>。団体ID だけを入れ、セッション・メールアドレスは入れない)を、
//   1. QR コード(画面の中で作る。lib/ohsumi/qr.ts)
//   2. 共有(Web Share API。使えない端末ではコピーだけ)
//   3. 自分のメールに送る(団体の GAS が、本人の登録済みのアドレスにだけ送る。宛先は画面から送らない)
// で渡す。メールは、レジストリに確かめた団体だけが送れる(gas/Code.gs の sendInviteLinkToMe_)。
// どれもデータを書き換えないので、機能停止中(読み取り専用)も使える
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Mail, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from './modal'
import { useToast } from './toast'
import { useI18n } from '@/lib/ohsumi/i18n'
import { getActiveOrg, inviteLink } from '@/lib/ohsumi/org-directory'
import { qrMatrix, qrSvgPath } from '@/lib/ohsumi/qr'
import { isRemoteConfigured, remoteApi, type InviteMailStatus } from '@/lib/ohsumi/remote'

// gas/Code.gs の INVITE_MAIL_LIMIT と同じ
const INVITE_MAIL_LIMIT = 3

/** 今の団体の招待リンク(団体が決まっていない・デモの時は null) */
export function currentInviteLink(): string | null {
  const orgId = getActiveOrg().orgId
  if (!isRemoteConfigured || !orgId || typeof window === 'undefined') return null
  return inviteLink(window.location.origin, '', orgId)
}

function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

export function OtherDeviceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const link = open ? currentInviteLink() : null
  const qr = useMemo(() => (link ? qrSvgPath(qrMatrix(link)) : null), [link])
  const [status, setStatus] = useState<InviteMailStatus | 'loading' | 'error'>('loading')
  const [sending, setSending] = useState(false)
  const [shareable, setShareable] = useState(false)

  useEffect(() => {
    if (!open || !link) return
    setShareable(canShare())
    setStatus('loading')
    let alive = true
    remoteApi.getInviteMailStatus().then(
      (s) => { if (alive) setStatus(s) },
      () => { if (alive) setStatus('error') },
    )
    return () => { alive = false }
  }, [open, link])

  if (!link || !qr) return null

  const copy = () => {
    if (!navigator.clipboard) return toast(t('otherDevice.copyFailed'))
    navigator.clipboard.writeText(link).then(
      () => toast(t('otherDevice.copied')),
      () => toast(t('otherDevice.copyFailed')),
    )
  }
  const share = () => {
    navigator.share({ title: 'Ohsumi', url: link }).catch(() => {
      /* 共有の画面を閉じた時など。何もしない */
    })
  }
  const sendMail = async () => {
    setSending(true)
    try {
      const res = await remoteApi.sendInviteLinkToMe(window.location.origin, locale)
      toast(t('otherDevice.mailSent', { remaining: String(res.remaining) }))
      setStatus(res.remaining > 0 ? { available: true, remaining: res.remaining } : { available: false, reason: 'limit', remaining: 0 })
    } catch (e) {
      toast(t('otherDevice.mailFailed', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSending(false)
    }
  }

  const mailNote =
    status === 'loading' ? t('otherDevice.mailChecking')
      : status === 'error' ? t('otherDevice.mailUnknown')
        : status.available ? t('otherDevice.mailHint', { limit: String(INVITE_MAIL_LIMIT) })
          : status.reason === 'noEmail' ? t('otherDevice.mailNoEmail')
            : status.reason === 'limit' ? t('otherDevice.mailLimit', { limit: String(INVITE_MAIL_LIMIT) })
              : t('otherDevice.mailNotChecked')
  const mailReady = typeof status === 'object' && status.available && !sending

  // ヘッダー(backdrop-blur)の中に置くと画面全体に広がらないので、body に出す
  return createPortal(
    <Modal open={open} onClose={onClose} labelledBy="other-device-title" className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <h2 id="other-device-title" className="text-base font-semibold">{t('otherDevice.title')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('otherDevice.hint')}</p>

      <figure className="mt-4 flex flex-col items-center gap-2">
        {/* 読み取りやすいよう、テーマに関わらず白地に黒で描く */}
        <svg
          data-other-device-qr
          role="img"
          aria-label={t('otherDevice.qrLabel')}
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          shapeRendering="crispEdges"
          className="size-48 rounded-lg border border-border bg-white"
          data-allow-light
        >
          <path d={qr.d} fill="#000" />
        </svg>
        <figcaption className="text-xs text-muted-foreground">{t('otherDevice.qr')}</figcaption>
      </figure>

      <div className="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs"
          aria-label={t('otherDevice.linkLabel')}
        />
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" variant="outline" onClick={copy} className="flex-1 sm:flex-none">
            <Copy className="size-3.5" />
            {t('otherDevice.copy')}
          </Button>
          {shareable && (
            <Button type="button" size="sm" variant="outline" onClick={share} className="flex-1 sm:flex-none">
              <Share2 className="size-3.5" />
              {t('otherDevice.share')}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border p-3">
        <Button type="button" size="sm" variant="outline" disabled={!mailReady} onClick={sendMail} className="w-full" data-other-device-mail>
          <Mail className="size-3.5" />
          {t('otherDevice.mail')}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground" data-other-device-mail-note>{mailNote}</p>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t('otherDevice.homeScreen')}</p>

      <div className="mt-4 flex justify-end">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('otherDevice.close')}</Button>
      </div>
    </Modal>,
    document.body,
  )
}
