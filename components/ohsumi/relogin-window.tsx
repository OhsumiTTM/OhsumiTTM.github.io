'use client'

// 兼部の統合表示で、ログインが切れた団体に、その団体に切り替えずにログインし直す小さい窓(/?org=<団体ID>&relogin=1)。
//
// - 今使っている団体(ohsumi-current-org)・団体ごとの保存・アドレスバーは変えない(org-directory.ts の startOrg・
//   activateOrg を呼ばない)。接続先は、この端末の団体の一覧(ohsumi-orgs)に保存したものだけを使う
// - ログインしたら、セッションをその団体の保存に入れ(storeSessionFor)、開いた画面に postMessage で渡して閉じる。
//   渡す先は同じオリジンだけ。開いた画面が無い時(直接開いた時)は「この窓を閉じてください」を出す
import { useEffect, useRef, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { I18nProvider, useI18n } from '@/lib/ohsumi/i18n'
import { ThemeProvider } from '@/lib/ohsumi/theme'
import { CLIENT_VERSION } from '@/lib/ohsumi/codes'
import { sendToGas } from '@/lib/ohsumi/gas-transport'
import { loadSavedOrgs, type SavedOrg } from '@/lib/ohsumi/org-directory'
import { loadRememberPreference, prepareGoogleSignIn, saveRememberPreference, storeSessionFor, type StoredSession } from '@/lib/ohsumi/session'
import { RELOGIN_MESSAGE_TYPE, type ReloginMessage } from '@/lib/ohsumi/multi-org'
import { OhsumiLogo } from './primitives'

type Phase = 'ready' | 'sending' | 'done' | 'noOrg' | 'failed'

function ReloginBody() {
  const { t, locale } = useI18n()
  const [org] = useState<SavedOrg | null>(() => {
    const id = new URLSearchParams(window.location.search).get('org')
    return loadSavedOrgs().find((o) => o.orgId === id) ?? null
  })
  const [phase, setPhase] = useState<Phase>(org ? 'ready' : 'noOrg')
  const [error, setError] = useState('')
  const [remember, setRemember] = useState(loadRememberPreference)
  const rememberRef = useRef(remember)
  const buttonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = t('multiOrg.relogin.title')
  }, [t])

  useEffect(() => {
    if (!org) return
    let cancelled = false
    prepareGoogleSignIn({
      orgId: org.orgId,
      button: buttonRef.current,
      shouldAutoPrompt: () => !cancelled,
      locale,
      onCredential: (idToken, secret) => {
        setPhase('sending')
        const remember = rememberRef.current
        sendToGas<{ memberId?: string | null; session?: { token: string; exp: number } }>(org.gasUrl, {
          action: 'exchangeIdToken', idToken, nonceSecret: secret, remember, clientVersion: CLIENT_VERSION,
        }).then((json) => {
          const s = json.ok ? json.result?.session : undefined
          if (!s || !json.result?.memberId) {
            setError(json.error || t('multiOrg.relogin.notMember'))
            setPhase('failed')
            return
          }
          const session: StoredSession = { token: s.token, exp: s.exp, remember }
          storeSessionFor(org.orgId, session)
          const message: ReloginMessage = { type: RELOGIN_MESSAGE_TYPE, orgId: org.orgId, session }
          setPhase('done')
          try {
            if (window.opener && window.opener !== window) {
              ;(window.opener as Window).postMessage(message, window.location.origin)
              window.close()
            }
          } catch {
            /* 開いた画面に渡せなくても、セッションはこの端末に保存した */
          }
        }, (e: unknown) => {
          setError(e instanceof Error ? e.message : String(e))
          setPhase('failed')
        })
      },
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    })
    return () => { cancelled = true }
    // 1回だけ準備する(ログインの試行は、ページごとに1回)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const name = org?.name || org?.orgId || ''
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 py-8 text-center" data-relogin={phase}>
      <OhsumiLogo />
      {phase === 'noOrg' ? (
        <p className="flex max-w-sm items-center gap-1.5 text-sm text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          {t('multiOrg.relogin.noOrg')}
        </p>
      ) : phase === 'done' ? (
        <p className="max-w-sm text-sm font-medium">{t('multiOrg.relogin.done', { name })}</p>
      ) : (
        <>
          <div className="max-w-sm">
            <h1 className="text-base font-semibold break-words">{t('multiOrg.relogin.heading', { name })}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{t('multiOrg.relogin.desc')}</p>
          </div>
          {phase === 'sending' && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('multiOrg.relogin.sending')}
            </p>
          )}
          {phase === 'failed' && (
            <p className="flex max-w-sm items-start gap-1.5 text-left text-xs break-words text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}
          <div ref={buttonRef} className={phase === 'ready' ? '' : 'hidden'} />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked)
                rememberRef.current = e.target.checked
                saveRememberPreference(e.target.checked)
              }}
            />
            {t('login.remember')}
          </label>
        </>
      )}
    </main>
  )
}

export function ReloginWindow() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ReloginBody />
      </I18nProvider>
    </ThemeProvider>
  )
}
