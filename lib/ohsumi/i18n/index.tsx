'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import { ja } from './ja'
import { en } from './en'
import type { TaskStatus, Priority, Difficulty, TaskImportance, ScheduleResponseValue } from '../types'

// 新しい言語を追加するときは: 1) この配列に追記 2) 対応する辞書ファイル
// （xx.ts）を作り `satisfies Record<keyof typeof ja, string>` で型チェック
// 3) 下の DICTS に登録する。これ以外の変更は不要 — UI側は t() だけを使う。
export type Locale = 'ja' | 'en'

export const SUPPORTED_LOCALES: { code: Locale; label: string }[] = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: 'English' },
]

export const DEFAULT_LOCALE: Locale = 'ja'

export type TranslationKey = keyof typeof ja

const DICTS: Record<Locale, Record<TranslationKey, string>> = { ja, en }

const LOCALE_STORAGE_KEY = 'ohsumi-locale'

// TaskStatus（内部enum、GAS/シートにもこのまま保存される）から翻訳キーへの
// マッピング。types.ts の STATUS_LABEL（日本語固定）と役割が重複するが、
// STATUS_LABEL はExcel出力など「常に日本語で残したい」箇所向けに残し、
// UI表示は段階的にこちら（t(STATUS_KEY[s])）へ移行する。
export const STATUS_KEY: Record<TaskStatus, TranslationKey> = {
  todo: 'status.todo',
  hold: 'status.hold',
  progress: 'status.progress',
  support: 'status.support',
  review: 'status.review',
  fix: 'status.fix',
  done: 'status.done',
}

// 部門(Department)・優先度(Priority)・難易度(Difficulty)は types.ts で固定
// された定数集合なので、TaskStatus と同様に安全に辞書化できる。組織が
// Admin > Tags で自由に追加できるロール名（BASE_ROLE=一般以外）はここでは
// 扱わない — lib/ohsumi/translate.ts の機械翻訳（自由入力向け）に任せる。
export const DEPARTMENT_KEY: Record<string, TranslationKey> = {
  ops: 'department.ops',
  pr: 'department.pr',
  dev: 'department.dev',
  design: 'department.design',
  relations: 'department.relations',
  event: 'department.event',
  research: 'department.research',
  '': 'department.none',
}

// 部門の表示名。一覧に無い部門(以前の独自の部門名)は、その値をそのまま表示する
export function departmentLabel(t: (key: TranslationKey) => string, department: string | null | undefined): string {
  const key = DEPARTMENT_KEY[department ?? '']
  return key ? t(key) : String(department)
}

export const PRIORITY_KEY: Record<Priority, TranslationKey> = {
  high: 'priority.high',
  medium: 'priority.medium',
  low: 'priority.low',
}

export const DIFFICULTY_KEY: Record<Difficulty, TranslationKey> = {
  anyone: 'difficulty.anyone',
  beginner: 'difficulty.beginner',
  some_exp: 'difficulty.some_exp',
  experienced: 'difficulty.experienced',
  advanced: 'difficulty.advanced',
}

export const IMPORTANCE_KEY: Record<TaskImportance, TranslationKey> = {
  normal: 'importance.normal',
  important: 'importance.important',
  external: 'importance.external',
}

// 日程調整の回答。gas/Code.gs の通知の文面(NOTIFY_LABELS)も同じ表示名を
// 使う(一致することを lib/ohsumi/codes.test.ts で確かめる)
export const SCHEDULE_ANSWER_KEY: Record<ScheduleResponseValue, TranslationKey> = {
  yes: 'scheduleAnswer.yes',
  maybe: 'scheduleAnswer.maybe',
  no: 'scheduleAnswer.no',
}

// BASE_ROLE（'一般'）のみ辞書化。それ以外の組織定義ロールはこの関数を通さず
// 元の文字列のまま（または自動翻訳経由で）表示する。
export function roleLabelKey(role: string): TranslationKey | null {
  return role === '一般' ? 'role.一般' : null
}

function isLocale(v: string | null): v is Locale {
  return v === 'ja' || v === 'en'
}

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  // hydrate from localStorage once (browser-only setting; server login
  // profiles keep their own timezone separately, see lib/ohsumi/timezone.ts)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY)
      if (isLocale(saved)) setLocaleState(saved)
    } catch {
      /* ignore */
    }
  }, [])

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, l)
    } catch {
      /* ignore */
    }
  }, [])

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let str = DICTS[locale][key] ?? DICTS[DEFAULT_LOCALE][key] ?? key
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
      }
      return str
    },
    [locale],
  )

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
