'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { OhsumiMark } from './primitives'
import { Loader2, TriangleAlert } from 'lucide-react'
import { isGoogleOAuthConfigured } from '@/lib/ohsumi/google-sheet-sync'
import { fetchLoginConfig, isRemoteConfigured } from '@/lib/ohsumi/remote'
import {
  loadSavedOrgs,
  resolveAndActivate,
  startOrg,
  switchToOrg,
  takeLoginNotice,
  type LoginNotice,
  type SavedOrg,
} from '@/lib/ohsumi/org-directory'
import {
  hasSavedSession,
  loadCachedLoginConfig,
  loadRememberPreference,
  prepareGoogleSignIn,
  resetGoogleSignIn,
  saveLoginConfig,
  saveRememberPreference,
} from '@/lib/ohsumi/session'
import { LegalLinks } from './legal-links'

// ログイン画面の状態:
//   checking      団体の設定(団体ID)を確認中
//   id            Googleでログイン(IDトークン)→ 団体の GAS がセッショントークンを発行する。
//                 「この端末にログイン情報を保存する」がチェックありなら、再読み込み後もログインしたまま
//   gasOutdated   団体の設定を取得できない(GAS が古い・接続できない)。管理者に GAS の更新を促す
//   notConfigured GAS の URL・OAuth クライアントIDが設定されていない
//   demo          開発環境(pnpm dev)で GAS を設定していない場合: ローカルのモックデータのメンバーを選んでログインする
//   resolving     招待リンクの団体の接続先を、レジストリに問い合わせ中(初めての端末だけ。lib/ohsumi/org-directory.ts)
//   orgNotFound・orgSuspended・orgUnavailable・orgMismatch  招待リンクの団体を使えない(見つからない・停止中・
//                 レジストリに確認できない(再試行できる)・接続先の団体ID が違う)
//   noOrg         つなぐ団体が無い(既定の団体が無く、招待リンクからも開いていない)
type LoginMode =
  | 'checking'
  | 'id'
  | 'gasOutdated'
  | 'notConfigured'
  | 'demo'
  | 'resolving'
  | 'orgNotFound'
  | 'orgSuspended'
  | 'orgUnavailable'
  | 'orgMismatch'
  | 'noOrg'

// 団体を使えない画面と、その説明の文
const ORG_PROBLEM_TEXT = {
  orgNotFound: 'login.orgNotFound',
  orgSuspended: 'login.orgSuspended',
  orgUnavailable: 'login.orgUnavailable',
  orgMismatch: 'login.orgMismatch',
  noOrg: 'login.noOrg',
} as const
const ORG_PROBLEM_MODES = Object.keys(ORG_PROBLEM_TEXT) as LoginMode[]

// デモ用のログイン画面(メンバーを選ぶだけでログインできる)は開発環境だけで読み込む。
// 条件はビルド時に決まるため、本番のビルドでは demo-login.tsx ごと取り除かれる
// (scripts/check-no-demo-login.mjs がビルドの最後に確かめる)。
const DemoLogin =
  process.env.NODE_ENV === 'development' ? dynamic(() => import('./demo-login'), { ssr: false }) : null

const isDemo = DemoLogin !== null && !isRemoteConfigured

function initialMode(): LoginMode {
  if (isRemoteConfigured && isGoogleOAuthConfigured()) return 'checking'
  return isDemo ? 'demo' : 'notConfigured'
}

export function LoginScreen() {
  const { signInWithGoogle } = useOhsumi()
  const { t, locale } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [mode, setMode] = useState<LoginMode>(initialMode)
  const [orgId, setOrgId] = useState<string | null>(null)
  // この端末の団体の一覧(2つ以上あれば、ログインの前に選べる)
  const [savedOrgs, setSavedOrgs] = useState<SavedOrg[]>([])
  // 招待リンクの団体(レジストリに確認できなかった時に、もう一度試す)
  const [inviteOrgId, setInviteOrgId] = useState<string | null>(null)
  // 読み込み直す前に決まった知らせ(接続先が変わった・停止した・見つからない)
  const [notice, setNotice] = useState<LoginNotice | null>(null)
  const [remember, setRemember] = useState(loadRememberPreference)
  const rememberRef = useRef(remember)
  // 初期設定コード(団体を始める最初の代表だけ)。入れてから Google でログインすると、同じ通信で送る
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupCode, setSetupCode] = useState('')
  const setupCodeRef = useRef('')
  setupCodeRef.current = setupOpen ? setupCode.trim() : ''
  const buttonRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const autoPromptedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 招待リンクの団体をレジストリで調べ、その GAS の団体ID が同じなら使う(初めての端末だけ。1回待つ)
  const resolveInvite = useCallback((id: string) => {
    setInviteOrgId(id)
    setMode('resolving')
    resolveAndActivate(id, (gasUrl) => fetchLoginConfig(gasUrl).then((c) => c?.orgId ?? null)).then((res) => {
      if (!mountedRef.current) return
      setSavedOrgs(loadSavedOrgs())
      if (res.status === 'ok') {
        setOrgId(res.org.orgId)
        setMode('id')
        return
      }
      setMode(
        res.status === 'suspended' ? 'orgSuspended'
          : res.status === 'notFound' ? 'orgNotFound'
            : res.status === 'mismatch' ? 'orgMismatch'
              : 'orgUnavailable',
      )
    })
  }, [])

  // 使う団体を決め、団体ID を確認する(lib/ohsumi/org-directory.ts)。
  // 一覧にある団体は、前回の団体ID をすぐに使い、裏で確認し直す。
  // 既定の団体の団体ID を取得できない(GAS が古い・接続できない)場合は、管理者に GAS の更新を促す
  useEffect(() => {
    if (mode !== 'checking') return
    setNotice(takeLoginNotice())
    const decision = startOrg()
    setSavedOrgs(loadSavedOrgs())
    if (decision.kind === 'invalidInvite') return setMode('orgNotFound')
    if (decision.kind === 'none') return setMode('noOrg')
    if (decision.kind === 'resolve') return resolveInvite(decision.orgId)
    const cached = loadCachedLoginConfig()
    if (cached) {
      setOrgId(cached.orgId)
      setMode('id')
      // この端末に保存したセッションがあれば、再読み込みの直後は保存したセッションでの再開
      // (getInitialData)が先に走る。団体ID の確認は同時に送らず、前回の値を使う
      if (hasSavedSession()) return
    }
    fetchLoginConfig().then((config) => {
      if (!mountedRef.current) return
      if (config) {
        // レジストリで調べた団体の GAS が、別の団体ID を返した(接続先の設定の誤り): ログインしない
        if (decision.kind === 'use' && decision.org.source === 'registry' && config.orgId !== decision.org.orgId) {
          setOrgId(null)
          setMode('orgMismatch')
          return
        }
        saveLoginConfig(config)
        setOrgId(config.orgId)
        setSavedOrgs(loadSavedOrgs())
        setMode('id')
      } else if (!cached) {
        setMode('gasOutdated')
      }
    })
    // 最初の1回だけ確認する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const orgLabel = (o: SavedOrg) => o.name || t('login.orgUnnamed', { id: o.orgId.slice(4, 10) })
  // 団体を選ぶ欄: 一覧に2つ以上ある時(使えない団体の画面では、1つでもほかの団体があれば出す)
  const pickable = savedOrgs.filter((o) => o.orgId !== orgId || mode === 'id')
  const showPicker = mode !== 'resolving' && mode !== 'checking' && !loading &&
    (mode === 'id' ? savedOrgs.length >= 2 : ORG_PROBLEM_MODES.includes(mode) && pickable.length > 0)

  const toggleRemember = (value: boolean) => {
    setRemember(value)
    rememberRef.current = value
    saveRememberPreference(value)
  }

  // 再描画のたびに変わる値は ref で参照し、準備(google.accounts.id.initialize)を
  // 呼び直す原因にしない
  const signInRef = useRef(signInWithGoogle)
  signInRef.current = signInWithGoogle
  const tRef = useRef(t)
  tRef.current = t
  const localeRef = useRef(locale)
  localeRef.current = locale

  // Googleでログインのボタンを用意する。initialize はログインの試行ごとに1回だけ
  // (lib/ohsumi/session.ts)。何度呼んでも、準備済みならボタンを出し直すだけ。
  // 初回だけ自動ログイン・One Tap も試す
  const prepare = useCallback(() => {
    if (!orgId) return
    const autoPrompt = !autoPromptedRef.current
    autoPromptedRef.current = true
    // ログインに失敗した時は、新しい nonce(新しい試行)で準備し直す
    const retry = () => {
      resetGoogleSignIn()
      if (mountedRef.current) prepareRef.current()
    }
    prepareGoogleSignIn({
      orgId,
      button: buttonRef.current,
      // 保存したセッションで自動的にログインし直す場合は、Google の自動ログインは試さない
      shouldAutoPrompt: () => autoPrompt && mountedRef.current && !hasSavedSession(),
      locale: localeRef.current,
      onCredential: async (idToken, secret) => {
        setLoading(true)
        setError(false)
        setLoginError(null)
        let ok = false
        try {
          const result = await signInRef.current(idToken, secret, rememberRef.current, orgId, setupCodeRef.current || undefined)
          ok = result.status === 'ok'
          if (result.status === 'notRegistered') {
            // 同じアカウントで自動ログインを繰り返さないようにする
            window.google?.accounts?.id?.disableAutoSelect()
            if (mountedRef.current) {
              setLoginError(tRef.current('login.notRegistered', { email: result.email ?? '' }))
              // 最初の代表の場合に備えて、初期設定コードの欄を開く
              setSetupOpen(true)
            }
          }
        } catch (e) {
          if (mountedRef.current) setLoginError(e instanceof Error ? e.message : tRef.current('login.failed'))
        } finally {
          if (mountedRef.current) setLoading(false)
          // 成功した場合は準備し直さない(このままアプリの画面に切り替わる)
          if (!ok) retry()
        }
      },
      onNonceMismatch: () => {
        if (mountedRef.current) setLoginError(tRef.current('login.failed'))
        retry()
      },
    }).catch(() => {
      if (mountedRef.current) setError(true)
    })
  }, [orgId])
  const prepareRef = useRef(prepare)
  prepareRef.current = prepare

  useEffect(() => {
    if (mode === 'id') prepare()
    // 言語を切り替えた時は、準備済みの試行のままボタンの表示だけやり直す
  }, [mode, prepare, locale])

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      {/* subtle ellipse accent */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <svg
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-border"
          width="760"
          height="760"
          viewBox="0 0 760 760"
          fill="none"
        >
          <ellipse cx="380" cy="380" rx="220" ry="120" stroke="currentColor" strokeWidth="1" transform="rotate(-24 380 380)" />
          <ellipse cx="380" cy="380" rx="330" ry="180" stroke="currentColor" strokeWidth="1" transform="rotate(-24 380 380)" opacity="0.6" />
        </svg>
      </div>

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center text-center">
        <div className="flex items-center gap-2">
          <OhsumiMark size={30} />
          <span className="text-2xl font-semibold tracking-tight">Ohsumi</span>
        </div>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground text-balance">
          {t('login.tagline')}
        </p>

        <div className="mt-9 w-full rounded-2xl border border-border bg-card p-6 shadow-[0_1px_3px_rgba(16,24,40,0.06)]">
          {notice && (
            <div role="status" className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-left text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>{t(`login.${notice}`)}</span>
            </div>
          )}
          {showPicker && (
            <label className="mb-4 block text-left text-xs">
              <span className="font-medium">{t('login.orgLabel')}</span>
              <select
                value={mode === 'id' && orgId ? orgId : ''}
                onChange={(e) => e.target.value && switchToOrg(e.target.value)}
                className="mt-1 w-full min-w-0 truncate rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              >
                {mode !== 'id' && <option value="">—</option>}
                {(mode === 'id' ? savedOrgs : pickable).map((o) => (
                  <option key={o.orgId} value={o.orgId}>{orgLabel(o)}</option>
                ))}
              </select>
            </label>
          )}
          {mode === 'resolving' ? (
            <div className="flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('login.resolving')}
            </div>
          ) : ORG_PROBLEM_MODES.includes(mode) ? (
            <div role="alert" className="text-left text-sm text-muted-foreground">
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>{t(ORG_PROBLEM_TEXT[mode as keyof typeof ORG_PROBLEM_TEXT])}</span>
              </div>
              {mode === 'orgUnavailable' && inviteOrgId && (
                <button
                  type="button"
                  onClick={() => resolveInvite(inviteOrgId)}
                  className="mt-3 w-full rounded-md border border-border px-3 py-1.5 text-sm font-medium"
                >
                  {t('login.retry')}
                </button>
              )}
            </div>
          ) : mode === 'gasOutdated' || mode === 'notConfigured' ? (
            <div role="alert" className="flex items-start gap-2 text-left text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{mode === 'gasOutdated' ? t('login.gasOutdated') : t('login.notConfigured')}</span>
            </div>
          ) : mode === 'demo' && DemoLogin ? (
            <DemoLogin />
          ) : (
            <>
              {/* Google が表示する「Googleでログイン」ボタン(IDトークン) */}
              <div className="relative flex min-h-11 justify-center">
                <div ref={buttonRef} className={loading ? 'pointer-events-none opacity-40' : undefined} />
                {(mode === 'checking' || loading) && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {loading ? t('login.signingIn') : t('login.preparing')}
                  </div>
                )}
              </div>

              <div className="mt-4 text-left">
                {setupOpen ? (
                  <label className="block text-xs">
                    <span className="font-medium">{t('login.setupCodeLabel')}</span>
                    <input
                      value={setupCode}
                      onChange={(e) => setSetupCode(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={40}
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      className="mt-1 w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm tracking-wider"
                    />
                    <span className="mt-1 block text-muted-foreground">{t('login.setupCodeHint')}</span>
                  </label>
                ) : (
                  <button type="button" onClick={() => setSetupOpen(true)} className="text-xs text-muted-foreground underline underline-offset-2">
                    {t('login.setupCodeToggle')}
                  </button>
                )}
              </div>

              <label className="mt-5 flex cursor-pointer items-start gap-2 text-left text-sm">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => toggleRemember(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>{t('login.remember')}</span>
              </label>
              <div
                role="note"
                className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{t('login.sharedDeviceWarning')}</span>
              </div>
            </>
          )}

          {error && (
            <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-destructive">
              <TriangleAlert className="size-3.5" />
              {t('login.failed')}
            </div>
          )}

          {loginError && (
            <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-destructive">
              <TriangleAlert className="size-3.5 shrink-0" />
              {loginError}
            </div>
          )}

          <p className="mt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('login.poweredByGoogle')}
          </p>
        </div>
        <LegalLinks className="mt-6" />
      </div>
    </main>
  )
}
