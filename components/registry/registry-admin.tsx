'use client'

// レジストリの管理画面(/registry-admin/)。Ohsumi 本体の画面からはリンクしない。
// ログイン(許可リストの管理者だけ)・団体の一覧・停止の予定(提供停止・機能停止)の入力と取り消し・
// 登録コードの発行と取り消し・操作の記録を表示する。
// 判定はすべてレジストリの GAS が行い、この画面は表示と入力だけを受け持つ。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { waitForGIS } from '@/lib/ohsumi/google-sheet-sync'
import { inviteLink } from '@/lib/ohsumi/org-directory'
import {
  REGISTRY_CLIENT_ID,
  RegistryError,
  adminLogin,
  adminOverview,
  clearAdminSession,
  clearSuspension,
  createAdminNonce,
  isRegistryAdminConfigured,
  issueRegistrationCode,
  loadAdminSession,
  needsReauth,
  earliestSuspendLocal,
  revokeRegistrationCode,
  saveIssueDraft,
  saveSuspensionDraft,
  scheduleSuspension,
  setOrgPlan,
  suspendNow,
  takeIssueDraft,
  takeSuspensionDraft,
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
  type Plan,
  type SuspendKind,
  type SuspensionInput,
  mailLevelCounts,
  needsGasUpdate,
  requestGasUpdate,
  setGasVersionMarks,
  GAS_JUDGEMENT_LABELS,
  type GasJudgement,
  type GasVersionEntry,
  type OrgMailSummary,
} from '@/lib/registry/admin-api'

export const ORG_STATE_LABELS: Record<OrgState, string> = { active: '有効', scheduled: '停止予定', restricted: '機能停止中(読み取り専用)', suspended: '提供停止中' }
// 停止の2つの種類(R1-e)。予告(14日前・7日前・1日前)はどちらも同じ
// プラン(利用契約書の案 第3条)。有償の団体には、機能停止(②)を入れられない
export const PLAN_LABELS: Record<Plan | '', string> = { cosmo_base: 'Cosmo Baseプラン', ohsumi: 'Ohsumiプラン', paid: '有償プラン', '': '未設定' }
export const SUSPEND_KIND_LABELS: Record<SuspendKind, { title: string; description: string }> = {
  suspend: {
    title: '① 提供停止',
    description: '契約の終了・規約違反など。全員が使えなくなり(「利用を停止しています」を表示)、書き込み・通知・定期の処理も止まります。',
  },
  restrict: {
    title: '② 機能停止',
    description: 'アンケートの未回答など。全員が読み取り専用になります(閲覧と書き出しはできます)。画面の上部にアンケートへの回答のお願いを出します。通知・定期の処理は止めません。解除すると、すぐ元に戻ります。',
  },
}
export const CHECK_STATE_LABELS: Record<CheckState, string> = { ok: '', stale: '確認が7日以上ありません', never: 'まだ確認がありません' }
export const CONTRACT_LABELS: Record<string, string> = { active: '契約中', ending: '終了予定', ended: '終了', '': '未設定' }
export const CODE_STATE_LABELS: Record<CodeState, string> = { unused: '未使用', used: '使用済み', expired: '期限切れ', revoked: '取り消し済み' }
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  adminLogin: 'ログイン',
  adminLoginDenied: 'ログインを断った(許可リストに無い)',
  issueRegistrationCode: '登録コードの発行',
  revokeRegistrationCode: '登録コードの取り消し',
  registerOrg: '団体の登録',
  reregisterOrg: '団体の再登録(共有鍵の作り直し・接続先の変更)',
  rotateAdminSessionKey: 'セッションの鍵の作り直し',
  scheduleSuspension: '停止の予定を入れた',
  cancelSuspension: '停止の予定の取り消し',
  liftSuspension: '停止の解除',
  suspendNow: '当日の提供停止(緊急)',
  setOrgPlan: 'プランの変更',
  sendSuspensionNotice: '停止の予告を担当者に送った',
  testSuspendNow: '(テスト)今すぐ停止',
  testScheduleSuspension: '(テスト)停止の予定',
  testLiftSuspension: '(テスト)停止の解除',
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

const EMPTY_INPUT: IssueInput = { kind: 'new', targetOrgId: '', orgName: '', contactName: '', contactEmail: '', note: '' }

export function RegistryAdmin() {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [checked, setChecked] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<TabId>('orgs')
  const [draft, setDraft] = useState<IssueInput | null>(null)
  const [suspendDraft, setSuspendDraft] = useState<SuspensionInput | null>(null)

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
    setSuspendDraft(takeSuspensionDraft())
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
        <>
          {overview.gasVersions && <GasVersionsPanel versions={overview.gasVersions} session={session} onChanged={() => void load(session)} onAuthError={endSession} />}
          <OrgList orgs={overview.orgs} session={session} draft={suspendDraft} onChanged={() => void load(session)} onAuthError={endSession} />
        </>
      ) : tab === 'codes' ? (
        <CodesPanel
          session={session}
          codes={overview.codes}
          orgs={overview.orgs}
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

function mailText(m: OrgMailSummary): string {
  const parts: string[] = []
  if (m.remaining !== null) parts.push(`最後の確認の時の残り ${m.remaining} 件`)
  if (m.skipped > 0) parts.push(`${m.date} に送れなかった数 ${m.skipped} 件`)
  if (m.limitDate) parts.push(`最後に上限に達した日 ${m.limitDate}`)
  return parts.join('・') || '—'
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 text-xs">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  )
}

function OrgList({
  orgs,
  session,
  draft,
  onChanged,
  onAuthError,
}: {
  orgs: OrgSummary[]
  session: AdminSession
  draft: SuspensionInput | null
  onChanged: () => void
  onAuthError: (message?: string) => void
}) {
  const [onlyUpdate, setOnlyUpdate] = useState(false)
  if (!orgs.length) return <p className="text-sm text-muted-foreground">登録された団体はまだありません。</p>
  const mailCounts = mailLevelCounts(orgs)
  const updateCount = orgs.filter(needsGasUpdate).length
  const shown = onlyUpdate ? orgs.filter(needsGasUpdate) : orgs
  return (
    <>
    <label className="mb-3 flex items-center gap-2 text-sm" data-gas-update-filter>
      <input type="checkbox" checked={onlyUpdate} onChange={(e) => setOnlyUpdate(e.target.checked)} />
      GAS の更新が要る団体だけ({updateCount})
    </label>
    {(mailCounts.reached > 0 || mailCounts.low > 0) && (
      <p data-mail-level-summary className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs break-words text-amber-900">
        {mailCounts.reached > 0 && `メールの上限に達した団体: ${mailCounts.reached}`}
        {mailCounts.reached > 0 && mailCounts.low > 0 && '・'}
        {mailCounts.low > 0 && `メールの残りが少ない団体: ${mailCounts.low}`}
        (GAS を動かすアカウントの1日の上限。続く団体には、Google Workspace のアカウントで GAS を動かすよう勧めてください)
      </p>
    )}
    {shown.length === 0 && <p className="mb-3 text-sm text-muted-foreground">GAS の更新が要る団体はありません。</p>}
    <ul className="space-y-3">
      {shown.map((o) => (
        <li key={o.orgId} className="rounded-lg border border-border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="min-w-0 font-medium break-words">{o.displayName || o.orgId}</span>
            <Badge tone={o.state === 'active' ? 'ok' : o.state === 'suspended' ? 'bad' : 'warn'}>{ORG_STATE_LABELS[o.state]}</Badge>
            <Badge tone={o.plan ? 'muted' : 'warn'}>{PLAN_LABELS[o.plan]}</Badge>
            {o.state === 'scheduled' && <Badge tone="warn">{SUSPEND_KIND_LABELS[o.suspendKind].title}</Badge>}
            {o.checkState !== 'ok' && <Badge tone="warn">{CHECK_STATE_LABELS[o.checkState]}</Badge>}
            {o.mail?.level === 'reached' && <Badge tone="bad">メールの上限に達した</Badge>}
            {o.mail?.level === 'low' && <Badge tone="warn">メールの残り {o.mail.remaining}</Badge>}
            {o.gasStatus && <Badge tone={GAS_JUDGEMENT_TONES[o.gasStatus.judgement]}>GAS: {GAS_JUDGEMENT_LABELS[o.gasStatus.judgement]}</Badge>}
            {o.jobs?.dailyStale && <Badge tone="bad">毎日の処理が26時間以上成功していない</Badge>}
          </div>
          <dl className="space-y-1">
            <Field label="契約の状態">{CONTRACT_LABELS[o.contractStatus] ?? o.contractStatus}{o.contractUntil ? `(${fmt(o.contractUntil)} まで)` : ''}</Field>
            <Field label="最後の確認">{fmt(o.lastCheckAt)}</Field>
            <Field label="GAS の版">
              <span data-gas-version>
                {o.gasVersion || '不明'}
                {o.gasStatus && `(判定: ${GAS_JUDGEMENT_LABELS[o.gasStatus.judgement]}${o.gasStatus.noCheck && o.gasStatus.versionState !== 'latest' ? `・最後の版では${GAS_JUDGEMENT_LABELS[o.gasStatus.versionState]}` : ''}。最新: ${o.gasStatus.latest || '—'}${o.gasStatus.security ? '。安全の修正あり' : ''})`}
              </span>
            </Field>
            <Field label="登録日">{fmt(o.createdAt)}</Field>
            {o.jobs?.reported && <Field label="毎日・毎時の処理">最後に成功: 毎日 {fmt(o.jobs.dailyAt)}・毎時 {fmt(o.jobs.hourlyAt)}</Field>}
            {o.mail && o.mail.level !== 'unknown' && <Field label="メール">{mailText(o.mail)}</Field>}
            {o.suspendAt && (
              <>
                <Field label="停止">{SUSPEND_KIND_LABELS[o.suspendKind].title}・{fmt(o.suspendAt)} から{o.suspendScheduledBy ? `(入れた人: ${o.suspendScheduledBy})` : ''}</Field>
                {o.suspendReason && <Field label="停止の理由">{o.suspendReason}</Field>}
                <Field label="送った予告">{o.noticesSent.length ? o.noticesSent.map((d) => `${d}日前`).join('・') : 'まだありません'}</Field>
              </>
            )}
            <Field label="団体ID">{o.orgId}</Field>
            <Field label="接続先">{o.gasUrl || '—'}</Field>
            {/* 団体の担当者に伝える。メンバーは初めての端末でこのリンクから開く(R1-d) */}
            {typeof window !== 'undefined' && <Field label="招待リンク">{inviteLink(window.location.origin, '', o.orgId)}</Field>}
            {o.contractNote && <Field label="契約のメモ">{o.contractNote}</Field>}
          </dl>
          <PlanControl org={o} session={session} onChanged={onChanged} onAuthError={onAuthError} />
          {o.gasStatus && o.gasStatus.versionState !== 'latest' && <GasUpdateRequest org={o} session={session} onAuthError={onAuthError} />}
          <SuspensionControl
            org={o}
            session={session}
            draft={draft && draft.orgId === o.orgId ? draft : null}
            onChanged={onChanged}
            onAuthError={onAuthError}
          />
        </li>
      ))}
    </ul>
    </>
  )
}

// 停止の予定を入れる(①提供停止・②機能停止を選ぶ)・予定を取り消す・停止を解除する(R1-e)
function SuspensionControl({
  org,
  session,
  draft,
  onChanged,
  onAuthError,
}: {
  org: OrgSummary
  session: AdminSession
  draft: SuspensionInput | null
  onChanged: () => void
  onAuthError: (message?: string) => void
}) {
  const hasPlan = org.state !== 'active'
  const [open, setOpen] = useState(!!draft)
  const paid = org.plan === 'paid'
  const [kind, setKind] = useState<SuspendKind>(draft?.kind ?? (paid ? 'suspend' : 'restrict'))
  // 当日に提供停止にする(緊急)。押すと、確認の画面を挟む
  const [immediate, setImmediate] = useState(!!draft?.immediate)
  const [confirming, setConfirming] = useState(false)
  const [at, setAt] = useState(draft?.suspendAt ?? '')
  const [reason, setReason] = useState(draft?.reason ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(draft ? 'ログインし直しました。内容を確かめて、もう一度「停止の予定を入れる」を押してください。' : null)
  const inputClass = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm'
  const min = earliestSuspendLocal()

  const fail = (e: unknown) => {
    if (e instanceof RegistryError && e.authError) onAuthError(e.message)
    else setMessage(e instanceof Error ? e.message : String(e))
  }

  const now = immediate && kind === 'suspend'
  const schedule = async (e: React.FormEvent) => {
    e.preventDefault()
    const ms = Date.parse(at)
    if (!now && (!at || !Number.isFinite(ms))) return setMessage('停止の日時を入れてください。')
    if (!reason.trim()) return setMessage('停止の理由を入れてください(団体への予告に書きます)。')
    if (kind === 'restrict' && paid) return setMessage('有償プランの団体には、機能停止を入れられません。')
    const input: SuspensionInput = { orgId: org.orgId, kind, suspendAt: at, reason, immediate: now }
    // 5分以内の Google でのログインが必要。古ければ入力を残して、ログインし直す
    if (needsReauth(session)) {
      saveSuspensionDraft(input)
      onAuthError()
      return
    }
    // 当日の停止は、確認の画面を挟む(確認の画面の「今すぐ提供停止にする」で送る)
    if (now && !confirming) {
      setMessage(null)
      setConfirming(true)
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      if (now) await suspendNow(session, org.orgId, reason)
      else await scheduleSuspension(session, { ...input, suspendAt: new Date(ms).toISOString() })
      setOpen(false)
      setConfirming(false)
      onChanged()
    } catch (err) {
      if (err instanceof RegistryError && err.reauthRequired) {
        saveSuspensionDraft(input)
        onAuthError()
      } else fail(err)
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await clearSuspension(session, org.orgId, reason)
      setOpen(false)
      setReason('')
      onChanged()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const inEffect = org.state === 'suspended' || org.state === 'restricted'
  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant={hasPlan ? 'outline' : 'ghost'} onClick={() => { setOpen(true); setMessage(null) }}>
          {inEffect ? '停止を解除する…' : hasPlan ? '停止の予定を取り消す…' : '停止の予定を入れる…'}
        </Button>
      </div>
    )
  }

  if (hasPlan) {
    return (
      <div className="mt-2 space-y-2 rounded-md bg-muted/50 p-2">
        <p className="text-xs">
          {inEffect
            ? '停止を解除すると、団体の GAS が次に確かめた時(使われていれば1分以内、遅くとも1時間以内)に元に戻ります。'
            : '停止の予定を取り消します。送った予告の取り消しは、担当者に別に連絡してください。'}
        </p>
        <label className="block text-xs">
          理由(操作の記録に残します)
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void clear()}>{busy ? '処理しています…' : inEffect ? '停止を解除する' : '予定を取り消す'}</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>やめる</Button>
        </div>
        {message && <p className="text-sm break-words text-destructive">{message}</p>}
      </div>
    )
  }

  // 当日の提供停止の確認の画面
  if (confirming) {
    return (
      <form onSubmit={(e) => void schedule(e)} role="alertdialog" aria-labelledby={`suspend-now-${org.orgId}`} className="mt-2 space-y-2 rounded-md border-2 border-red-300 bg-red-50 p-2">
        <p id={`suspend-now-${org.orgId}`} className="text-sm font-medium break-words text-red-800">「{org.displayName || org.orgId}」を、今すぐ提供停止にしますか</p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-red-900">
          <li>団体の全員が、Ohsumi を使えなくなります(ログイン画面に「利用を停止しています」が出ます)。</li>
          <li>14日前の予告は送れません。担当者(レジストリの連絡先)には、この場でメールで知らせます。</li>
          <li>団体の GAS が次に状態を確かめた時に効きます(遅くとも1時間以内)。団体のデータは、団体のスプレッドシートに残ります。</li>
          <li>操作の記録に「当日の提供停止(緊急)」として残ります。解除は「停止を解除する…」から、いつでもできます。</li>
        </ul>
        <p className="text-xs break-words">理由: {reason}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="destructive" disabled={busy}>{busy ? '停止しています…' : '今すぐ提供停止にする'}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>戻る</Button>
        </div>
        {message && <p className="text-sm break-words text-destructive">{message}</p>}
      </form>
    )
  }

  return (
    <form onSubmit={(e) => void schedule(e)} className="mt-2 space-y-2 rounded-md bg-muted/50 p-2">
      <fieldset className="space-y-1 text-xs">
        <legend className="mb-1">停止の種類</legend>
        {(['suspend', 'restrict'] as const).map((k) => (
          <label key={k} className="flex items-start gap-2">
            <input type="radio" name={`suspend-kind-${org.orgId}`} checked={kind === k} onChange={() => setKind(k)} className="mt-0.5"
              disabled={k === 'restrict' && paid} />
            <span className="min-w-0">
              <span className="font-medium">{SUSPEND_KIND_LABELS[k].title}</span>: {SUSPEND_KIND_LABELS[k].description}
              {k === 'restrict' && paid && <span className="block text-muted-foreground">有償プランの団体には入れられません(回答が無い時は、サポートの停止のみです)。</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {kind === 'suspend' && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} className="mt-0.5" />
          <span className="min-w-0">当日に提供停止にする(緊急。14日前の予告をせず、今すぐ停止します。次に確認の画面が出ます)</span>
        </label>
      )}
      {!now && (
        <label className="block text-xs">
          停止の日時(今から14日より後)
          <input className={inputClass} type="datetime-local" value={at} min={min} onChange={(e) => setAt(e.target.value)} required />
        </label>
      )}
      <label className="block text-xs">
        理由(必須。担当者・代表への予告のメールに書きます)
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
      </label>
      <p className="text-xs text-muted-foreground">
        予告は、停止の14日前・7日前・1日前に、担当者(レジストリの連絡先)と団体の代表にメールで送ります。団体の画面にも、14日前から予告を出します。
        入れる前に、5分以内の Google でのログインが必要です(古ければログインし直します)。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant={now ? 'destructive' : 'default'} disabled={busy}>{busy ? '入れています…' : now ? '当日の提供停止へ進む…' : '停止の予定を入れる'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>やめる</Button>
      </div>
      {message && <p className="text-sm break-words text-destructive">{message}</p>}
    </form>
  )
}

// 団体のプランを記録する(表示と変更)
const GAS_JUDGEMENT_TONES: Record<GasJudgement, 'muted' | 'ok' | 'warn' | 'bad'> = { latest: 'ok', outdated: 'muted', updateRequired: 'bad', noCheck: 'warn' }

// 団体の担当者に、GAS の更新をお願いするメールを送る(同じ団体には24時間に1回まで。操作の記録に残る)
function GasUpdateRequest({ org, session, onAuthError }: { org: OrgSummary; session: AdminSession; onAuthError: (m?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const inputClass = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm'
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const res = await requestGasUpdate(session, org.orgId, reason)
      setOpen(false)
      setReason('')
      setMessage({ ok: true, text: `担当者 ${res.sentTo} 人に、更新のお願いを送りました。` })
    } catch (err) {
      if (err instanceof RegistryError && err.authError) onAuthError(err.message)
      else setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2">
      {!open ? (
        <Button size="sm" variant="ghost" onClick={() => { setOpen(true); setMessage(null) }} data-gas-update-request>担当者に更新のお願いを送る…</Button>
      ) : (
        <form onSubmit={(e) => void send(e)} className="space-y-2 rounded-md bg-muted/50 p-2">
          <p className="text-xs text-muted-foreground">
            担当者(登録の時の連絡先)に、今の版・最新の版と更新の手順をメールで送ります。同じ団体には24時間に1回までです。
          </p>
          <label className="block text-xs">
            理由・メモ(操作の記録に残します)
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>{busy ? '送っています…' : '送る'}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>やめる</Button>
          </div>
        </form>
      )}
      {message && <p className={`mt-1 text-sm break-words ${message.ok ? 'text-emerald-700' : 'text-destructive'}`}>{message.text}</p>}
    </div>
  )
}

// 団体の GAS の版の一覧と印(安全の修正・これより古ければ更新が要る)。印は付け直せる(操作の記録に残る)
function GasVersionsPanel({ versions, session, onChanged, onAuthError }: { versions: GasVersionEntry[]; session: AdminSession; onChanged: () => void; onAuthError: (m?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<{ version: string; security: boolean; required: boolean; note: string; reason: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputClass = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm'
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editing) return
    setBusy(true)
    setMessage(null)
    try {
      await setGasVersionMarks(session, editing.version.trim(), { security: editing.security, required: editing.required, note: editing.note }, editing.reason)
      setEditing(null)
      onChanged()
    } catch (err) {
      if (err instanceof RegistryError && err.authError) onAuthError(err.message)
      else setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mb-4 rounded-lg border border-border p-3" data-gas-versions>
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="min-w-0 break-words">団体の GAS の版の一覧(最新: {versions[0]?.version ?? '—'})</span>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? '閉じる' : '開く'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            「安全の修正」か「これより古ければ更新が要る」の印の付いた一番新しい版より古い団体を、「更新が要る」と判定します。版はコード(registry/Code.gs の KNOWN_GAS_VERSIONS)に足します。
          </p>
          <ul className="space-y-1">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">{v.version}</span>
                {v.security && <Badge tone="bad">安全の修正</Badge>}
                {v.required && <Badge tone="warn">これより古ければ更新が要る</Badge>}
                {v.note && <span className="min-w-0 break-words text-muted-foreground">{v.note}</span>}
                <Button size="sm" variant="ghost" onClick={() => { setEditing({ version: v.version, security: v.security, required: v.required, note: v.note, reason: '' }); setMessage(null) }}>印を変える…</Button>
              </li>
            ))}
          </ul>
          {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing({ version: '', security: false, required: false, note: '', reason: '' })}>版を足す…</Button>}
          {editing && (
            <form onSubmit={(e) => void save(e)} className="space-y-2 rounded-md bg-muted/50 p-2">
              <label className="block text-xs">
                版(YYYY.MM.DD-N)
                <input className={inputClass} value={editing.version} onChange={(e) => setEditing({ ...editing, version: e.target.value })} maxLength={20} />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={editing.security} onChange={(e) => setEditing({ ...editing, security: e.target.checked })} />
                安全の修正
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={editing.required} onChange={(e) => setEditing({ ...editing, required: e.target.checked })} />
                これより古ければ更新が要る
              </label>
              <label className="block text-xs">
                メモ
                <input className={inputClass} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} maxLength={500} />
              </label>
              <label className="block text-xs">
                理由(操作の記録に残します)
                <input className={inputClass} value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} maxLength={500} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy}>{busy ? '保存しています…' : '保存する'}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>やめる</Button>
              </div>
            </form>
          )}
          {message && <p className="text-sm break-words text-destructive">{message}</p>}
        </div>
      )}
    </section>
  )
}

function PlanControl({ org, session, onChanged, onAuthError }: { org: OrgSummary; session: AdminSession; onChanged: () => void; onAuthError: (m?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<Plan | ''>(org.plan)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputClass = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm'

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!plan) return setMessage('プランを選んでください。')
    setBusy(true)
    setMessage(null)
    try {
      await setOrgPlan(session, org.orgId, plan, reason)
      setOpen(false)
      setReason('')
      onChanged()
    } catch (err) {
      if (err instanceof RegistryError && err.authError) onAuthError(err.message)
      else setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => { setPlan(org.plan); setOpen(true); setMessage(null) }}>プランを変える…</Button>
      </div>
    )
  }
  return (
    <form onSubmit={(e) => void save(e)} className="mt-2 space-y-2 rounded-md bg-muted/50 p-2">
      <label className="block text-xs">
        プラン
        <select className={inputClass} value={plan} onChange={(e) => setPlan(e.target.value as Plan | '')}>
          {!org.plan && <option value="">未設定</option>}
          {(['cosmo_base', 'ohsumi', 'paid'] as const).map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
        </select>
      </label>
      <label className="block text-xs">
        理由・メモ(操作の記録に残します)
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      <p className="text-xs text-muted-foreground">有償プランの団体には、機能停止(②)を入れられません。機能停止の予定が入っている団体は、先に取り消してから有償にします。</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? '保存しています…' : '保存する'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>やめる</Button>
      </div>
      {message && <p className="text-sm break-words text-destructive">{message}</p>}
    </form>
  )
}

function CodesPanel({
  session,
  codes,
  orgs,
  ttlDays,
  initialInput,
  onChanged,
  onAuthError,
}: {
  session: AdminSession
  codes: CodeSummary[]
  orgs: OrgSummary[]
  ttlDays: number
  initialInput: IssueInput | null
  onChanged: () => void
  onAuthError: (message?: string) => void
}) {
  const [input, setInput] = useState<IssueInput>({ ...EMPTY_INPUT, ...(initialInput ?? {}) })
  const reissue = input.kind === 'reissue'
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
    if (reissue && !input.targetOrgId) {
      setMessage('再登録する団体を選んでください。')
      return
    }
    if (!reissue && !input.orgName.trim()) {
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
      const res = await issueRegistrationCode(session, reissue ? { ...input, orgName: '' } : { ...input, targetOrgId: '' })
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
          <p className="text-sm font-medium">「{issued.orgName}」向けの{issued.kind === 'reissue' ? '再登録コード' : '登録コード'}</p>
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
          <fieldset className="space-y-1 text-xs">
            <legend className="mb-1">種類</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="code-kind" checked={!reissue} onChange={() => setInput({ ...input, kind: 'new' })} className="mt-0.5" />
              <span>新しい団体の登録コード</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="code-kind" checked={reissue} onChange={() => setInput({ ...input, kind: 'reissue' })} className="mt-0.5" disabled={!orgs.length} />
              <span className="min-w-0">登録済みの団体の再登録コード(共有鍵が漏れた時の作り直し・接続先の変更)</span>
            </label>
          </fieldset>
          {reissue ? (
            <label className="block text-xs">
              再登録する団体(必須)
              <select className={inputClass} value={input.targetOrgId ?? ''} onChange={(e) => setInput({ ...input, targetOrgId: e.target.value })} required>
                <option value="">選んでください</option>
                {orgs.map((o) => (
                  <option key={o.orgId} value={o.orgId}>{o.displayName || o.orgId}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block text-xs">
              団体名(契約先の名前・必須)
              <input className={inputClass} value={input.orgName} onChange={set('orgName')} maxLength={100} required />
            </label>
          )}
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
          {reissue && (
            <p className="text-xs text-muted-foreground">団体の担当者が、団体のスプレッドシートの「Ohsumi」メニュー →「レジストリに登録する…」でこのコードを使うと、新しい共有鍵に入れ替わり、古い共有鍵は使えなくなります。接続先の URL も新しくなります。</p>
          )}
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
        {code.kind === 'reissue' && <Badge tone="muted">再登録</Badge>}
      </div>
      <dl className="space-y-1">
        <Field label="有効期限">{fmt(code.expiresAt)}</Field>
        <Field label="発行">{fmt(code.issuedAt)} {code.issuedBy}</Field>
        {(code.contactName || code.contactEmail) && <Field label="担当者">{[code.contactName, code.contactEmail].filter(Boolean).join(' ')}</Field>}
        {code.note && <Field label="メモ">{code.note}</Field>}
        {code.kind === 'reissue' && code.targetOrgId && <Field label="再登録する団体ID">{code.targetOrgId}</Field>}
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
