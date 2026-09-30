'use client'

// レジストリの管理画面(/registry-admin/)。Ohsumi 本体の画面からはリンクしない。
// ログイン(許可リストの管理者だけ)・団体の一覧・登録コードの発行と取り消し・操作の記録を表示する。
// 判定はすべてレジストリの GAS が行い、この画面は表示と入力だけを受け持つ。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { waitForGIS } from '@/lib/ohsumi/google-sheet-sync'
import {
  REGISTRY_CLIENT_ID,
  RegistryError,
  adminLogin,
  adminOverview,
  clearAdminSession,
  createAdminNonce,
  isRegistryAdminConfigured,
  issueRegistrationCode,
  loadAdminSession,
  needsReauth,
  revokeRegistrationCode,
  saveIssueDraft,
  takeIssueDraft,
  type AdminSession,
  type AuditEntry,
  type CheckState,
  type CodeState,
  type CodeSummary,
  type IssueInput,
  type IssuedCode,
  type OrgState,
  type OrgSummary,
  type Overview,
} from '@/lib/registry/admin-api'

export const ORG_STATE_LABELS: Record<OrgState, string> = { active: '有効', scheduled: '停止予定', suspended: '停止' }
export const CHECK_STATE_LABELS: Record<CheckState, string> = { ok: '', stale: '確認が7日以上ありません', never: 'まだ確認がありません' }
export const CONTRACT_LABELS: Record<string, string> = { active: '契約中', ending: '終了予定', ended: '終了', '': '未設定' }
export const CODE_STATE_LABELS: Record<CodeState, string> = { unused: '未使用', used: '使用済み', expired: '期限切れ', revoked: '取り消し済み' }
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  adminLogin: 'ログイン',
  adminLoginDenied: 'ログインを断った(許可リストに無い)',
  issueRegistrationCode: '登録コードの発行',
  revokeRegistrationCode: '登録コードの取り消し',
  rotateAdminSessionKey: 'セッションの鍵の作り直し',
}
export const TABS = [
  { id: 'orgs', label: '団体' },
  { id: 'codes', label: '登録コード' },
  { id: 'audit', label: '操作の記録' },
] as const
type TabId = (typeof TABS)[number]['id']

// このページで Google のログインを準備したか。同じページで initialize を2回呼ばないよう、
// ログインし直す時はページを読み込み直す
let gisInitialized = false

function reloadPage() {
  try { window.location.reload() } catch { /* テストの環境など */ }
}

function fmt(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const EMPTY_INPUT: IssueInput = { orgName: '', contactName: '', contactEmail: '', note: '' }

export function RegistryAdmin() {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [checked, setChecked] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<TabId>('orgs')
  const [draft, setDraft] = useState<IssueInput | null>(null)

  const endSession = useCallback((message?: string) => {
    clearAdminSession()
    // このページで Google のログインを準備済みなら、読み込み直してから準備し直す
    if (gisInitialized) {
      reloadPage()
      return
    }
    setSession(null)
    setOverview(null)
    if (message) setError(message)
  }, [])

  const load = useCallback(async (s: AdminSession) => {
    setLoading(true)
    try {
      setOverview(await adminOverview(s))
      setError(null)
    } catch (e) {
      if (e instanceof RegistryError && e.authError) endSession(e.message)
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [endSession])

  useEffect(() => {
    const s = loadAdminSession()
    const d = takeIssueDraft()
    if (d) {
      setDraft(d)
      setTab('codes')
    }
    setSession(s)
    setChecked(true)
    if (s) void load(s)
  }, [load])

  const onLoggedIn = useCallback((s: AdminSession) => {
    setSession(s)
    setError(null)
    void load(s)
  }, [load])

  const logout = useCallback(() => {
    clearAdminSession()
    reloadPage()
  }, [])

  if (!isRegistryAdminConfigured) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          レジストリの管理画面は、この環境では設定されていません(NEXT_PUBLIC_REGISTRY_URL と NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID)。
        </p>
      </Shell>
    )
  }
  if (!checked) return <Shell><p className="text-sm text-muted-foreground">読み込み中…</p></Shell>
  if (!session) {
    return (
      <Shell>
        <LoginCard onLoggedIn={onLoggedIn} error={error} />
      </Shell>
    )
  }

  return (
    <Shell
      right={
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">{session.email}</span>
          <Button variant="outline" size="sm" onClick={logout}>ログアウト</Button>
        </div>
      }
    >
      <nav className="mb-4 flex gap-1 border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground'}`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="sm" onClick={() => void load(session)} disabled={loading}>
            {loading ? '読み込み中…' : '読み直す'}
          </Button>
        </div>
      </nav>
      {error && <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">{error}</p>}
      {!overview ? (
        <p className="text-sm text-muted-foreground">{loading ? '読み込み中…' : '一覧を読み込めませんでした。「読み直す」を押してください。'}</p>
      ) : tab === 'orgs' ? (
        <OrgList orgs={overview.orgs} />
      ) : tab === 'codes' ? (
        <CodesPanel
          session={session}
          codes={overview.codes}
          ttlDays={overview.codeTtlDays}
          initialInput={draft}
          onChanged={() => void load(session)}
          onAuthError={endSession}
        />
      ) : (
        <AuditList audit={overview.audit} />
      )}
    </Shell>
  )
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl bg-background px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">Ohsumi レジストリ 管理画面</h1>
        {right}
      </header>
      {children}
    </main>
  )
}

function LoginCard({ onLoggedIn, error }: { onLoggedIn: (s: AdminSession) => void; error: string | null }) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState<string | null>(error)
  const [busy, setBusy] = useState(false)
  const onLoggedInRef = useRef(onLoggedIn)
  onLoggedInRef.current = onLoggedIn

  useEffect(() => {
    let cancelled = false
    // Google のログインは、このページで1回だけ準備する
    if (gisInitialized) return
    void (async () => {
      try {
        await waitForGIS()
        const { nonce, secret } = await createAdminNonce()
        if (cancelled || gisInitialized) return
        const id = window.google?.accounts?.id
        if (!id) throw new Error('Google のログインを読み込めませんでした')
        gisInitialized = true
        id.initialize({
          client_id: REGISTRY_CLIENT_ID!,
          nonce,
          auto_select: false,
          use_fedcm_for_prompt: true,
          itp_support: true,
          callback: async (response) => {
            if (!response.credential) return
            setBusy(true)
            setMessage(null)
            try {
              onLoggedInRef.current(await adminLogin(response.credential, secret))
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e))
              setBusy(false)
            }
          },
        })
        if (buttonRef.current) id.renderButton(buttonRef.current, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' })
      } catch (e) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <section className="rounded-lg border border-border p-4">
      <p className="mb-3 text-sm">FSIF の管理者の Google アカウントでログインしてください。許可された管理者だけが使えます。</p>
      <div ref={buttonRef} className="min-h-10" />
      {busy && <p className="mt-3 text-sm text-muted-foreground">確認しています…</p>}
      {message && (
        <div className="mt-3 space-y-2">
          <p className="text-sm break-words text-destructive">{message}</p>
          {/* Google のログインは1ページにつき1回だけ準備するので、もう一度試す時は読み込み直す */}
          <Button size="sm" variant="outline" onClick={reloadPage}>読み込み直してもう一度ログイン</Button>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">ログインしたまま30分たつと、ログインし直しになります。</p>
    </section>
  )
}

function Badge({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad' }) {
  const color = {
    muted: 'bg-muted text-muted-foreground',
    ok: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-800',
    bad: 'bg-red-50 text-red-700',
  }[tone]
  return <span className={`inline-block rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap ${color}`}>{children}</span>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 text-xs">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  )
}

function OrgList({ orgs }: { orgs: OrgSummary[] }) {
  if (!orgs.length) return <p className="text-sm text-muted-foreground">登録された団体はまだありません(団体の登録は R1-c で作ります)。</p>
  return (
    <ul className="space-y-3">
      {orgs.map((o) => (
        <li key={o.orgId} className="rounded-lg border border-border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="min-w-0 font-medium break-words">{o.displayName || o.orgId}</span>
            <Badge tone={o.state === 'active' ? 'ok' : o.state === 'scheduled' ? 'warn' : 'bad'}>{ORG_STATE_LABELS[o.state]}</Badge>
            {o.checkState !== 'ok' && <Badge tone="warn">{CHECK_STATE_LABELS[o.checkState]}</Badge>}
          </div>
          <dl className="space-y-1">
            <Field label="契約の状態">{CONTRACT_LABELS[o.contractStatus] ?? o.contractStatus}{o.contractUntil ? `(${fmt(o.contractUntil)} まで)` : ''}</Field>
            <Field label="最後の確認">{fmt(o.lastCheckAt)}</Field>
            <Field label="登録日">{fmt(o.createdAt)}</Field>
            {o.suspendAt && <Field label="停止の予定">{fmt(o.suspendAt)}{o.suspendReason ? `(${o.suspendReason})` : ''}</Field>}
            <Field label="団体ID">{o.orgId}</Field>
            <Field label="接続先">{o.gasUrl || '—'}</Field>
            {o.contractNote && <Field label="契約のメモ">{o.contractNote}</Field>}
          </dl>
        </li>
      ))}
    </ul>
  )
}

function CodesPanel({
  session,
  codes,
  ttlDays,
  initialInput,
  onChanged,
  onAuthError,
}: {
  session: AdminSession
  codes: CodeSummary[]
  ttlDays: number
  initialInput: IssueInput | null
  onChanged: () => void
  onAuthError: (message?: string) => void
}) {
  const [input, setInput] = useState<IssueInput>(initialInput ?? EMPTY_INPUT)
  const [issued, setIssued] = useState<IssuedCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(initialInput ? 'ログインし直しました。内容を確かめて、もう一度「発行する」を押してください。' : null)
  const [copied, setCopied] = useState(false)

  // 5分以内の Google でのログインが必要。古ければ入力を残して、ページを読み込み直してログインし直す
  const reauth = useCallback(() => {
    saveIssueDraft(input)
    onAuthError()
  }, [input, onAuthError])

  const issue = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.orgName.trim()) {
      setMessage('どの団体向けかが分かるよう、団体名(契約先の名前)を入れてください。')
      return
    }
    if (needsReauth(session)) {
      reauth()
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const res = await issueRegistrationCode(session, input)
      setIssued(res)
      setCopied(false)
      setInput(EMPTY_INPUT)
      onChanged()
    } catch (err) {
      if (err instanceof RegistryError && err.reauthRequired) reauth()
      else if (err instanceof RegistryError && err.authError) onAuthError(err.message)
      else setMessage(`${err instanceof Error ? err.message : String(err)}(発行されたかどうかは、下の一覧で確かめてください)`)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const set = (k: keyof IssueInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setInput({ ...input, [k]: e.target.value })
  const inputClass = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm'

  return (
    <div className="space-y-5">
      {issued && (
        <section className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3" aria-live="polite">
          <p className="text-sm font-medium">「{issued.orgName}」向けの登録コード</p>
          <p className="my-2 font-mono text-lg tracking-wider break-all select-all">{issued.code}</p>
          <p className="text-xs">有効期限: {fmt(issued.expiresAt)}(1回だけ使えます)</p>
          <p className="mt-1 text-xs font-medium text-amber-900">このコードは今だけ表示されます。レジストリには元に戻せない形でしか残りません。担当者へ別の連絡手段で渡してください。</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void copy()}>{copied ? 'コピーしました' : 'コピー'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>表示を消す</Button>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-border p-3">
        <h2 className="mb-2 text-sm font-medium">登録コードを発行する</h2>
        <form onSubmit={(e) => void issue(e)} className="space-y-2">
          <label className="block text-xs">
            団体名(契約先の名前・必須)
            <input className={inputClass} value={input.orgName} onChange={set('orgName')} maxLength={100} required />
          </label>
          <label className="block text-xs">
            担当者の名前
            <input className={inputClass} value={input.contactName} onChange={set('contactName')} maxLength={100} />
          </label>
          <label className="block text-xs">
            担当者のメールアドレス
            <input className={inputClass} type="email" value={input.contactEmail} onChange={set('contactEmail')} maxLength={200} />
          </label>
          <label className="block text-xs">
            メモ
            <textarea className={inputClass} rows={2} value={input.note} onChange={set('note')} maxLength={500} />
          </label>
          <p className="text-xs text-muted-foreground">有効期限は{ttlDays}日です。発行の前に、5分以内の Google でのログインが必要です(古ければログインし直します)。</p>
          <Button type="submit" disabled={busy}>{busy ? '発行しています…' : '発行する'}</Button>
          {message && <p className="text-sm break-words text-destructive">{message}</p>}
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">発行済みの登録コード</h2>
        {!codes.length ? (
          <p className="text-sm text-muted-foreground">まだありません。</p>
        ) : (
          <ul className="space-y-3">
            {codes.map((c) => <CodeItem key={c.codeId} code={c} session={session} onChanged={onChanged} onAuthError={onAuthError} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

function CodeItem({ code, session, onChanged, onAuthError }: { code: CodeSummary; session: AdminSession; onChanged: () => void; onAuthError: (m?: string) => void }) {
  const [revoking, setRevoking] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const tone = code.state === 'unused' ? 'ok' : code.state === 'used' ? 'muted' : 'bad'

  const revoke = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await revokeRegistrationCode(session, code.codeId, reason)
      setRevoking(false)
      onChanged()
    } catch (e) {
      if (e instanceof RegistryError && e.authError) onAuthError(e.message)
      else setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-words">{code.orgName || '(団体名なし)'}</span>
        <Badge tone={tone}>{CODE_STATE_LABELS[code.state]}</Badge>
      </div>
      <dl className="space-y-1">
        <Field label="有効期限">{fmt(code.expiresAt)}</Field>
        <Field label="発行">{fmt(code.issuedAt)} {code.issuedBy}</Field>
        {(code.contactName || code.contactEmail) && <Field label="担当者">{[code.contactName, code.contactEmail].filter(Boolean).join(' ')}</Field>}
        {code.note && <Field label="メモ">{code.note}</Field>}
        {code.usedAt && <Field label="使用">{fmt(code.usedAt)} {code.usedOrgId}</Field>}
        {code.revokedAt && <Field label="取り消し">{fmt(code.revokedAt)} {code.revokedBy}</Field>}
        <Field label="コードの番号">{code.codeId}</Field>
      </dl>
      {code.state === 'unused' && !revoking && (
        <div className="mt-2">
          <Button size="sm" variant="destructive" onClick={() => setRevoking(true)}>取り消す</Button>
        </div>
      )}
      {revoking && (
        <div className="mt-2 space-y-2 rounded-md bg-muted/50 p-2">
          <p className="text-xs">このコードを取り消すと、もう使えません(元に戻せません)。</p>
          <label className="block text-xs">
            理由
            <input className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void revoke()}>{busy ? '取り消しています…' : '取り消しを確定'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setRevoking(false)}>やめる</Button>
          </div>
        </div>
      )}
      {message && <p className="mt-2 text-sm break-words text-destructive">{message}</p>}
    </li>
  )
}

function AuditList({ audit }: { audit: AuditEntry[] }) {
  if (!audit.length) return <p className="text-sm text-muted-foreground">記録はまだありません。</p>
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">新しい順に最大200件。記録はレジストリの AuditLog シートに追記され、書き換えられません。</p>
      <ul className="space-y-2">
        {audit.map((a, i) => (
          <li key={`${a.at}-${i}`} className="rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex flex-wrap gap-x-2">
              <span className="text-muted-foreground">{fmt(a.at)}</span>
              <span className="min-w-0 break-all">{a.actor}</span>
              <span className="font-medium">{AUDIT_ACTION_LABELS[a.action] ?? a.action}</span>
              {a.target && <span className="min-w-0 break-all text-muted-foreground">{a.target}</span>}
            </div>
            {(a.after || a.reason) && (
              <p className="mt-1 break-all text-muted-foreground">{[a.after, a.reason && `理由: ${a.reason}`].filter(Boolean).join(' / ')}</p>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
