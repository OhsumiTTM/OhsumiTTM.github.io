'use client'

// 明るい表示・暗い表示。画面で選んだ表示(この端末に保存)を使い、選んでいない時は端末の設定
// (prefers-color-scheme)に合わせる。端末の設定が変わった時も、選んでいなければ合わせる。
// 最初の描画の前の表示は app/layout.tsx の最初のスクリプトが決める(同じ決め方。ちらつかないように)。
// ブラウザの上部の色(<meta name="theme-color">)と color-scheme も、表示に合わせる
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'

export type Theme = 'light' | 'dark'

interface ThemeValue {
  // 今の表示
  theme: Theme
  // 画面で選んだ表示(選んでいない = 端末に合わせる時は null)
  choice: Theme | null
  // 表示を選ぶ。null は「端末に合わせる」(保存した選択を消して、端末の設定に戻す)
  setChoice: (choice: Theme | null) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeValue | null>(null)
export const THEME_STORAGE_KEY = 'ohsumi-theme'
// app/layout.tsx の viewport.themeColor と同じ(--background)
export const BROWSER_THEME_COLORS: Record<Theme, string> = { light: '#f6f8fc', dark: '#08111f' }
const DARK_QUERY = '(prefers-color-scheme: dark)'

function savedTheme(): Theme | null {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'light' || saved === 'dark' ? saved : null
  } catch {
    return null
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 表示を <html> とブラウザの上部の色に反映する */
export function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', BROWSER_THEME_COLORS[theme]))
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 選んだ表示(選んでいなければ null)と、端末の設定
  const [choice, setChoice] = useState<Theme | null>(null)
  const [system, setSystem] = useState<Theme>('light')

  useEffect(() => {
    setChoice(savedTheme())
    setSystem(systemTheme())
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia(DARK_QUERY) } catch { mq = null }
    if (!mq) return
    const onChange = () => setSystem(mq!.matches ? 'dark' : 'light')
    mq.addEventListener?.('change', onChange)
    return () => mq!.removeEventListener?.('change', onChange)
  }, [])

  const theme = choice ?? system

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setChoice(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [theme])

  const choose = useCallback((next: Theme | null) => {
    setChoice(next)
    try {
      if (next) window.localStorage.setItem(THEME_STORAGE_KEY, next)
      else window.localStorage.removeItem(THEME_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, choice, setChoice: choose, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
