'use client'

// レジストリの管理画面: 団体ごとの情報(団体名・契約の状態・属性)・担当者(停止の予告・アンケートの宛先)・
// 受け取った集計値の推移。開いた時に getOrgDetail で読む。変えた内容は操作の記録に残る(registry/Code.gs)
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ja } from '@/lib/ohsumi/i18n/ja'
import {
  ORG_CONTACTS_MAX,
  RegistryError,
  contractDateKey,
  getOrgDetail,
  needsReauth,
  setOrgContacts,
  setOrgProfile,
  type AdminSession,
  type ContractStatus,
  type OrgAttributes,
  type OrgContact,
  type OrgDetail,
  type OrgSummary,
} from '@/lib/registry/admin-api'

const CONTRACT_OPTIONS: { value: ContractStatus; label: string }[] = [
  { value: '', label: '未設定' },
  { value: 'active', label: '契約中' },
  { value: 'ending', label: '終了予定' },
  { value: 'ended', label: '終了' },
]
const ATTRIBUTE_LABELS: Record<keyof OrgAttributes, string> = { field: '分野', size: '規模', affiliation: '所属(大学など)', started_year: '設立年' }
// 推移の表に出す期間の数
const USAGE_COLUMNS = 8

const inputClass = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm'
const metricLabel = (k: string) => (ja as Record<string, string>)[`metrics.key.${k}`] ?? k

type Props = { org: OrgSummary; session: AdminSession; onChanged: () => void; onAuthError: (m?: string) => void }

export function OrgProfilePanel(props: Props) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<OrgDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setDetail(await getOrgDetail(props.session, props.org.orgId))
    } catch (err) {
      if (err instanceof RegistryError && err.authError) props.onAuthError(err.message)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => { setOpen(true); void load() }}>団体の情報・担当者・集計値…</Button>
      </div>
    )
  }
  return (
    <div data-org-profile className="mt-2 space-y-3 rounded-md bg-muted/50 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">団体の情報・担当者・集計値</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>閉じる</Button>
      </div>
      {loading && !detail && <p className="text-xs text-muted-foreground">読み込んでいます…</p>}
      {error && <p className="text-sm break-words text-destructive">{error}</p>}
      {detail && (
        <>
          <ProfileForm {...props} detail={detail} onSaved={() => { props.onChanged(); void load() }} />
          <ContactsForm {...props} detail={detail} onSaved={() => void load()} />
          <UsageTable detail={detail} />
        </>
      )}
    </div>
  )
}

function useSubmit(props: Props) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      await fn()
      setMessage({ ok: true, text: done })
      return true
    } catch (err) {
      if (err instanceof RegistryError && err.authError) props.onAuthError(err.message)
      else setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, message, setMessage, run }
}

function Message({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null
  return <p className={'text-sm break-words ' + (message.ok ? 'text-emerald-700' : 'text-destructive')}>{message.text}</p>
}

function ProfileForm(props: Props & { detail: OrgDetail; onSaved: () => void }) {
  const { org, session, detail } = props
  const [name, setName] = useState(org.displayName)
  const [status, setStatus] = useState<ContractStatus>((['', 'active', 'ending', 'ended'] as const).find((s) => s === org.contractStatus) ?? '')
  const [until, setUntil] = useState(contractDateKey(org.contractUntil))
  const [note, setNote] = useState(org.contractNote)
  const [attrs, setAttrs] = useState<OrgAttributes>(detail.attributes)
  const [reason, setReason] = useState('')
  const { busy, message, setMessage, run } = useSubmit(props)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setMessage({ ok: false, text: '団体名を入れてください。' })
    const ok = await run(() => setOrgProfile(session, org.orgId, { displayName: name, contract: { status, until, note }, attributes: attrs }, reason), '保存しました。')
    if (ok) { setReason(''); props.onSaved() }
  }

  return (
    <form data-org-profile-form onSubmit={(e) => void save(e)} className="space-y-2">
      <p className="text-xs font-medium">団体の情報</p>
      <label className="block text-xs">
        団体名(管理画面・団体あてのメールに出す名前。団体の画面の団体名は、団体の設定で変わります)
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          契約の状態
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as ContractStatus)}>
            {CONTRACT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="block text-xs">
          契約の終了日(無ければ空)
          <input type="date" className={inputClass} value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      </div>
      <label className="block text-xs">
        契約のメモ
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(ATTRIBUTE_LABELS) as (keyof OrgAttributes)[]).map((k) => (
          <label key={k} className="block text-xs">
            {ATTRIBUTE_LABELS[k]}
            <input
              className={inputClass}
              value={attrs[k]}
              onChange={(e) => setAttrs({ ...attrs, [k]: e.target.value })}
              maxLength={100}
              inputMode={k === 'started_year' ? 'numeric' : undefined}
              placeholder={k === 'started_year' ? '2024' : undefined}
            />
          </label>
        ))}
      </div>
      <label className="block text-xs">
        理由・メモ(操作の記録に残します)
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <Button type="submit" size="sm" disabled={busy}>{busy ? '保存しています…' : '団体の情報を保存する'}</Button>
      <Message message={message} />
    </form>
  )
}

function ContactsForm(props: Props & { detail: OrgDetail; onSaved: () => void }) {
  const { org, session, detail } = props
  const blank = (): OrgContact => ({ name: '', email: '', phone: '' })
  const [list, setList] = useState<OrgContact[]>(detail.contacts.length ? detail.contacts : [blank()])
  const [reason, setReason] = useState('')
  const { busy, message, setMessage, run } = useSubmit(props)
  const update = (i: number, patch: Partial<OrgContact>) => setList(list.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const contacts = list.filter((c) => c.name.trim() || c.email.trim() || c.phone.trim())
    if (!contacts.length) return setMessage({ ok: false, text: '担当者を1人以上入れてください(停止の予告・アンケートの宛先になります)。' })
    // 宛先が変わるので、5分以内のログインが要る。古ければ先にログインし直してもらう(入力はここに残らない)
    if (needsReauth(session)) return setMessage({ ok: false, text: '担当者を変えるには、5分以内に Google でログインし直している必要があります。下の「ログインし直す」を押してから、もう一度入れてください。' })
    const ok = await run(() => setOrgContacts(session, org.orgId, contacts, reason), '担当者を保存しました。')
    if (ok) { setReason(''); props.onSaved() }
  }

  return (
    <form data-org-contacts-form onSubmit={(e) => void save(e)} className="space-y-2 border-t border-border pt-3">
      <p className="text-xs font-medium">担当者(停止の予告・アンケートのメールの宛先。最大{ORG_CONTACTS_MAX}人)</p>
      <ul className="space-y-2">
        {list.map((c, i) => (
          <li key={i} className="grid gap-1 rounded-md border border-border p-1 sm:grid-cols-[1fr_1.4fr_1fr_auto] sm:border-0 sm:p-0">
            <input aria-label="名前" className={inputClass} placeholder="名前" value={c.name} onChange={(e) => update(i, { name: e.target.value })} maxLength={100} />
            <input aria-label="メールアドレス" type="email" className={inputClass} placeholder="メールアドレス" value={c.email} onChange={(e) => update(i, { email: e.target.value })} maxLength={200} />
            <input aria-label="電話番号" className={inputClass} placeholder="電話番号(任意)" value={c.phone} onChange={(e) => update(i, { phone: e.target.value })} maxLength={30} />
            <Button type="button" size="sm" variant="ghost" onClick={() => setList(list.length > 1 ? list.filter((_, j) => j !== i) : [blank()])}>外す</Button>
          </li>
        ))}
      </ul>
      {list.length < ORG_CONTACTS_MAX && (
        <Button type="button" size="sm" variant="outline" onClick={() => setList([...list, blank()])}>担当者を足す</Button>
      )}
      <label className="block text-xs">
        理由・メモ(操作の記録に残します)
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? '保存しています…' : '担当者を保存する'}</Button>
        {needsReauth(session) && <Button type="button" size="sm" variant="outline" onClick={() => props.onAuthError()}>ログインし直す</Button>}
      </div>
      <Message message={message} />
    </form>
  )
}

function UsageTable({ detail }: { detail: OrgDetail }) {
  // 新しい週を左に(スマホの幅でも、最新の値が最初に見える)
  const periods = detail.usage.slice(0, USAGE_COLUMNS)
  if (!periods.length) {
    return (
      <div className="border-t border-border pt-3 text-xs">
        <p className="font-medium">集計値の推移</p>
        <p className="mt-1 text-muted-foreground">まだ集計値を受け取っていません(団体の GAS が週1回送ります。プランと団体の設定によっては送りません)。</p>
      </div>
    )
  }
  const keys = detail.metricKeys.filter((k) => periods.some((p) => p.metrics[k] !== undefined))
  return (
    <div data-org-usage className="border-t border-border pt-3 text-xs">
      <p className="font-medium">集計値の推移(週ごと。新しい順に{periods.length}週)</p>
      <div className="mt-1 max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse whitespace-nowrap">
          <thead>
            <tr>
              <th className="sticky left-0 bg-muted/90 px-2 py-1 text-left font-normal text-muted-foreground">項目</th>
              {periods.map((p) => (
                <th key={p.period} className="px-2 py-1 text-right font-normal text-muted-foreground">
                  {p.period.slice(5)}〜{p.demo && <span className="ml-1 text-violet-700">デモ</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t border-border/60">
                <td className="sticky left-0 bg-muted/90 px-2 py-1">{metricLabel(k)}</td>
                {periods.map((p) => (
                  <td key={p.period} className="px-2 py-1 text-right tabular-nums">{p.metrics[k] === undefined ? '—' : p.metrics[k].toLocaleString()}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
