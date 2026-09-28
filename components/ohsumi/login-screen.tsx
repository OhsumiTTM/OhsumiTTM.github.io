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
type LoginMode = 'checking' | 'id' | 'gasOutdated' | 'notConfigured' | 'demo'

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
  const [remember, setRemember] = useState(loadRememberPreference)
  const rememberRef = useRef(remember)
  const buttonRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const autoPromptedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 団体ID を確認する。前回の値があればすぐに使い、裏で確認し直す。
  // 取得できない(GAS が古い・接続できない)場合は、管理者に GAS の更新を促す
  useEffect(() => {
    if (mode !== 'checking') return
    const cached = loadCachedLoginConfig()
    if (cached) {
      setOrgId(cached.orgId)
      setMode('id')
    }
    fetchLoginConfig().then((config) => {
      if (!mountedRef.current) return
      if (config) {
        saveLoginConfig(config)
        setOrgId(config.orgId)
        setMode('id')
      } else if (!cached) {
        setMode('gasOutdated')
      }
    })
    // 最初の1回だけ確認する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          const result = await signInRef.current(idToken, secret, rememberRef.current, orgId)
          ok = result.status === 'ok'
          if (result.status === 'notRegistered') {
            // 同じアカウントで自動ログインを繰り返さないようにする
            window.google?.accounts?.id?.disableAutoSelect()
            if (mountedRef.current) setLoginError(tRef.current('login.notRegistered', { email: result.email ?? '' }))
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
          {mode === 'gasOutdated' || mode === 'notConfigured' ? (
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
