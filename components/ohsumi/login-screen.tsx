'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useI18n } from '@/lib/ohsumi/i18n'
import { OhsumiMark } from './primitives'
import { Loader2, TriangleAlert } from 'lucide-react'
import {
  isGoogleOAuthConfigured,
  requestGoogleLoginToken,
  fetchGoogleUserInfo,
  setGasAuthToken,
} from '@/lib/ohsumi/google-sheet-sync'
import { fetchLoginConfig, isRemoteConfigured } from '@/lib/ohsumi/remote'
import {
  hasSavedSession,
  loadCachedLoginConfig,
  loadRememberPreference,
  prepareGoogleSignIn,
  saveLoginConfig,
  saveRememberPreference,
} from '@/lib/ohsumi/session'
import { LegalLinks } from './legal-links'

// ログインの方式:
//   id     新しい方式。Googleでログイン(IDトークン)→ 団体の GAS がセッショントークンを発行する。
//          「この端末にログイン情報を保存する」がチェックありなら、再読み込み後もログインしたまま
//   legacy 以前の方式(アクセストークン)。団体の GAS がまだ新しい方式に対応していない場合と、
//          GAS を使わないローカルのデモ環境で使う
//   checking 団体の設定(団体ID)を確認中
// continueAs: 以前の方式で、再読み込み後に前回ログインしていた人の名前
export function LoginScreen({ continueAs }: { continueAs?: string } = {}) {
  const { login, logout, signIn, signInWithGoogle, resolveLoginMember } = useOhsumi()
  const { t, locale } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const useIdLogin = isRemoteConfigured && isGoogleOAuthConfigured()
  const [mode, setMode] = useState<'checking' | 'id' | 'legacy'>(useIdLogin ? 'checking' : 'legacy')
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
  // GAS が新しい方式に対応していなければ、以前の方式に切り替える
  useEffect(() => {
    if (!useIdLogin) return
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
        setMode('legacy')
      }
    })
  }, [useIdLogin])

  const toggleRemember = (value: boolean) => {
    setRemember(value)
    rememberRef.current = value
    saveRememberPreference(value)
  }

  // Googleでログインのボタンを用意する。nonce は1回ごとに作り直すため、ログインを
  // 試すたびに呼び直す。初回だけ自動ログイン・One Tap も試す
  const prepare = useCallback(() => {
    if (!orgId) return
    const autoPrompt = !autoPromptedRef.current
    autoPromptedRef.current = true
    prepareGoogleSignIn({
      orgId,
      button: buttonRef.current,
      // 保存したセッションで自動的にログインし直す場合は、Google の自動ログインは試さない
      shouldAutoPrompt: () => autoPrompt && mountedRef.current && !hasSavedSession(),
      locale,
      onCredential: async (idToken, secret) => {
        setLoading(true)
        setError(false)
        setLoginError(null)
        try {
          const result = await signInWithGoogle(idToken, secret, rememberRef.current, orgId)
          if (result.status === 'notRegistered') {
            // 同じアカウントで自動ログインを繰り返さないようにする
            window.google?.accounts?.id?.disableAutoSelect()
            if (mountedRef.current) setLoginError(t('login.notRegistered', { email: result.email ?? '' }))
          }
        } catch (e) {
          if (mountedRef.current) setLoginError(e instanceof Error ? e.message : t('login.failed'))
        } finally {
          if (mountedRef.current) {
            setLoading(false)
            prepare()
          }
        }
      },
    }).catch(() => {
      if (mountedRef.current) setError(true)
    })
  }, [orgId, locale, signInWithGoogle, t])

  useEffect(() => {
    if (mode === 'id') prepare()
  }, [mode, prepare])

  const handleGoogle = async () => {
    setError(false)
    setLoginError(null)

    if (!isGoogleOAuthConfigured()) {
      setLoginError(t('login.oauthNotConfigured'))
      return
    }

    setLoading(true)
    try {
      const token = await requestGoogleLoginToken()
      if (isRemoteConfigured) {
        // 以前の方式: トークンを渡して、ログイン(メンバーの特定)と初期データの
        // 読み込みを GAS の getInitialData でまとめて行う
        const result = await signIn(token, !continueAs)
        if (result === 'notRegistered') {
          const info = await fetchGoogleUserInfo(token).catch(() => null)
          if (continueAs) logout()
          setLoginError(t('login.notRegistered', { email: info?.email ?? '' }))
        }
        return
      }
      // Cache the token so every subsequent GAS write can include it
      // for server-side authentication without re-prompting the user.
      setGasAuthToken(token)
      const userInfo = await fetchGoogleUserInfo(token)
      const matchedId = await resolveLoginMember(userInfo.email)
      if (matchedId) {
        login(matchedId)
      } else {
        setGasAuthToken(null)
        setLoginError(t('login.notRegistered', { email: userInfo.email }))
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

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
          {mode === 'legacy' ? (
            <>
              <Button
                size="lg"
                variant="outline"
                className="h-11 w-full border-border-strong text-[15px]"
                onClick={handleGoogle}
                disabled={loading}
              >
                <GoogleGlyph />
                {loading
                  ? t('login.signingIn')
                  : continueAs
                    ? t('login.continueAs', { name: continueAs })
                    : t('login.googleSignIn')}
              </Button>

              {continueAs && !loading && (
                <button
                  type="button"
                  onClick={logout}
                  className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  {t('login.useAnotherAccount')}
                </button>
              )}
            </>
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

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  )
}
