'use client'

// 団体をまたいだスキルの引き継ぎ(v1.2。gas/src/44-skill-transfer.gs)。個人ページの「経歴・キャリア」に出す。
//   本人: 引き継ぎコードを作る(本人のメールにも届く)・作ったコードを取り消す・ほかの団体のコードを入れて受け取る
//   本人と代表: 受け取った分を出どころごとに消す
//   見られる人(点数と同じ範囲): ほかの団体から引き継いだ実績を出どころごとに見る
import { useState } from 'react'
import { ArrowRightLeft, Copy, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { useToast } from '@/components/ohsumi/toast'
import { isRemoteConfigured, remoteApi } from '@/lib/ohsumi/remote'
import type { Member } from '@/lib/ohsumi/types'

const day = (iso: string) => (iso ? iso.slice(0, 10) : '')

export function SkillTransferSection({ member }: { member: Member }) {
  const { t } = useI18n()
  const toast = useToast()
  const { currentUser, isTopRef, applySkillTransferState } = useOhsumi()
  const isSelf = !!currentUser && currentUser.id === member.id
  const canRemove = isSelf || (!!currentUser && isTopRef(currentUser.role))
  const [busy, setBusy] = useState<'' | 'create' | 'claim' | string>('')
  const [made, setMade] = useState<{ code: string; expiresAt: string; mailed: boolean } | null>(null)
  const [code, setCode] = useState('')
  const [log, setLog] = useState(member.skillTransfers ?? [])
  const entries = member.externalSkills ?? []

  if (!isSelf && entries.length === 0) return null
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e))

  const create = async () => {
    setBusy('create')
    try {
      const r = await remoteApi.createSkillTransferCode()
      setMade({ code: r.code, expiresAt: r.expiresAt, mailed: r.mailed })
      setLog((prev) => [{ transferId: r.transferId, at: new Date().toISOString(), expiresAt: r.expiresAt, status: 'pending' }, ...prev])
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  const cancel = async (transferId: string) => {
    if (!window.confirm(t('skillTransfer.cancelConfirm'))) return
    setBusy(transferId)
    try {
      const r = await remoteApi.cancelSkillTransferCode(transferId)
      setLog((prev) => prev.map((e) => (e.transferId === transferId ? { ...e, status: r.status as typeof e.status } : e)))
      if (made && log[0]?.transferId === transferId) setMade(null)
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  const claim = async () => {
    if (!code.trim()) return
    setBusy('claim')
    try {
      const r = await remoteApi.claimSkillTransferCode(code.trim())
      if (r.member) applySkillTransferState(member.id, r.member)
      setCode('')
      toast(r.added.length
        ? t('skillTransfer.claimedToast', { list: r.added.map((a) => (a.via ? t('skillTransfer.originVia', { origin: a.originOrgName, via: a.via }) : a.originOrgName)).join('、') })
        : t('skillTransfer.nothingNewToast'))
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  const remove = async (transferId: string, origin: string) => {
    if (!window.confirm(t('skillTransfer.removeConfirm', { origin }))) return
    setBusy(transferId)
    try {
      const r = await remoteApi.removeTransferredSkills(member.id, transferId)
      applySkillTransferState(member.id, r.member)
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast(t('skillTransfer.copied')), () => undefined)
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4" data-skill-transfer>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold"><ArrowRightLeft className="size-4" />{t('skillTransfer.title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('skillTransfer.desc')}</p>

      {entries.length > 0 && (
        <div className="mt-3" data-skill-transfer-entries>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('skillTransfer.receivedHeader')}</p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {entries.map((e) => (
              <li key={e.transferId} className="flex min-w-0 items-start justify-between gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-2 text-xs" data-skill-transfer-entry={e.transferId}>
                <div className="min-w-0">
                  <p className="break-words font-medium">{e.via ? t('skillTransfer.originVia', { origin: e.originOrgName, via: e.via }) : e.originOrgName}</p>
                  <p className="mt-0.5 break-words text-muted-foreground">
                    {Object.entries(e.points).map(([k, v]) => `${k} ${v}`).join('・') || t('skillTransfer.noPoints')}
                    {e.qualifications.length > 0 && ` / ${e.qualifications.map((q) => q.name).join('・')}`}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{t('skillTransfer.exportedAt', { date: day(e.exportedAt) })}</p>
                </div>
                {canRemove && isRemoteConfigured && (
                  <button type="button" onClick={() => void remove(e.transferId, e.originOrgName)} disabled={!!busy}
                    className="shrink-0 text-muted-foreground hover:text-destructive" aria-label={t('skillTransfer.remove')} data-skill-transfer-remove={e.transferId}>
                    {busy === e.transferId ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isSelf && isRemoteConfigured && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0" data-skill-transfer-send>
            <p className="text-xs font-medium">{t('skillTransfer.sendHeader')}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('skillTransfer.sendDesc')}</p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" disabled={!!busy} onClick={() => void create()} data-skill-transfer-create>
              {busy === 'create' && <Loader2 className="size-3.5 animate-spin" />}{t('skillTransfer.create')}
            </Button>
            {made && (
              <div className="mt-2 rounded-md border border-primary/30 bg-primary-muted/40 p-2.5" data-skill-transfer-code>
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 break-all font-mono text-base font-semibold tracking-wider">{made.code}</code>
                  <button type="button" onClick={() => copy(made.code)} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={t('skillTransfer.copy')}>
                    <Copy className="size-4" />
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('skillTransfer.codeNote', { date: day(made.expiresAt) })}{made.mailed ? ' ' + t('skillTransfer.mailed') : ''}
                </p>
              </div>
            )}
            {log.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-[11px] text-muted-foreground" data-skill-transfer-log>
                {log.slice(0, 5).map((e) => (
                  <li key={e.transferId} className="flex flex-wrap items-center gap-x-2">
                    <span>{t('skillTransfer.logLine', { date: day(e.at), until: day(e.expiresAt) })}</span>
                    <span>{t(`skillTransfer.status.${e.status}` as 'skillTransfer.status.pending')}</span>
                    {e.status === 'pending' && (
                      <button type="button" onClick={() => void cancel(e.transferId)} disabled={!!busy} className="text-primary hover:underline" data-skill-transfer-cancel={e.transferId}>
                        {t('skillTransfer.cancel')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0" data-skill-transfer-receive>
            <p className="text-xs font-medium">{t('skillTransfer.receiveHeader')}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('skillTransfer.receiveDesc')}</p>
            <div className="mt-2 flex min-w-0 gap-1.5">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" maxLength={20}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-sm uppercase" data-skill-transfer-input />
              <Button size="sm" disabled={!!busy || !code.trim()} onClick={() => void claim()} data-skill-transfer-claim>
                {busy === 'claim' && <Loader2 className="size-3.5 animate-spin" />}{t('skillTransfer.claim')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
