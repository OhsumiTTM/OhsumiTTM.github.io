'use client'

// タスク名・説明などの自由入力テキストをUIの表示言語に自動翻訳する。
// GAS側の LanguageApp.translate()（無料、追加APIキー不要）を使うため、
// 呼び出し過多を避けるバッチング + 永続キャッシュが要。
//
// 設計:
// - 同じ text+targetLang の組は一度翻訳したら localStorage にキャッシュし、
//   二度と GAS を呼ばない（無料枠のクォータにも配慮）
// - 同じ描画タイミングで複数コンポーネントが要求した翻訳は、短い
//   デバウンス（80ms）で1回のGASリクエストにまとめてバッチ送信する
// - 初回表示は原文のまま返し、翻訳が届いたら該当コンポーネントだけ
//   再レンダリングする（progressive enhancement — 翻訳の遅延がUIをブロック
//   しない）
// - 訳せなかった文(GAS が null を返した・通信に失敗した)は覚えない。原文を出し、RETRY_AFTER_MS の後に訳し直す
//   (以前は、失敗して GAS が返した原文を訳として覚えてしまい、二度と訳し直さなかった)
import { useEffect, useState } from 'react'
import { remoteApi, isRemoteConfigured } from './remote'

const CACHE_KEY = 'ohsumi-translate-cache-v2'
// 以前のキャッシュ(失敗した時の原文が訳として入っていることがある)。読まずに消す
const OLD_CACHE_KEYS = ['ohsumi-translate-cache']
const RETRY_AFTER_MS = 10 * 60 * 1000
// 訳せなかった文と、次に訳し直してよい時刻(このページの間だけ)
const failedUntil = new Map<string, number>()

// 古い GAS は、訳せなかった時に原文をそのまま返す。日本語・中国語などの文字を含む文を、それらの文字を使わない言語に
// 訳したのに原文のままなら、訳せなかったとみなす(覚えずに後で訳し直す)
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/
const CJK_LANGS = ['ja', 'zh-CN', 'zh-TW', 'ko']
export function looksUntranslated(text: string, result: string, lang: string): boolean {
  return result === text && CJK.test(text) && !CJK_LANGS.includes(lang)
}
type Cache = Record<string, string> // `${targetLang}::${text}` -> translated text

let memoryCache: Cache | null = null

// ログアウト時: 翻訳のキャッシュ(タスク本文などの翻訳が入る)を消す
export function clearTranslateCache() {
  memoryCache = null
  failedUntil.clear()
  try {
    window.localStorage.removeItem(CACHE_KEY)
    OLD_CACHE_KEYS.forEach((k) => window.localStorage.removeItem(k))
  } catch {
    /* ignore */
  }
}

function loadCache(): Cache {
  if (memoryCache) return memoryCache
  try {
    OLD_CACHE_KEYS.forEach((k) => window.localStorage.removeItem(k))
    const raw = window.localStorage.getItem(CACHE_KEY)
    memoryCache = raw ? (JSON.parse(raw) as Cache) : {}
  } catch {
    memoryCache = {}
  }
  return memoryCache
}

function saveCache(cache: Cache) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* ignore — cache is best-effort */
  }
}

// 同一タスク内で発生した複数の翻訳要求を1回のGASリクエストにまとめる
let pendingTexts = new Set<string>()
let pendingLang: string | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let pendingListeners: (() => void)[] = []

function scheduleFlush(lang: string) {
  pendingLang = lang
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const texts = Array.from(pendingTexts)
    const lang2 = pendingLang
    const listeners = pendingListeners
    pendingTexts = new Set()
    pendingLang = null
    pendingListeners = []
    if (texts.length === 0 || !lang2) return
    remoteApi
      .translateTexts(texts, lang2)
      .then((results) => {
        const cache = loadCache()
        const list = Array.isArray(results) ? results : []
        texts.forEach((text, i) => {
          const r = list[i]
          if (typeof r === 'string' && !looksUntranslated(text, r, lang2)) cache[`${lang2}::${text}`] = r
          else failedUntil.set(`${lang2}::${text}`, Date.now() + RETRY_AFTER_MS)
        })
        saveCache(cache)
        listeners.forEach((l) => l())
      })
      .catch(() => {
        // best-effort — 原文を出したまま、しばらくしてから訳し直す
        texts.forEach((text) => failedUntil.set(`${lang2}::${text}`, Date.now() + RETRY_AFTER_MS))
      })
  }, 80)
}

// text をロケール locale 向けに自動翻訳して返す。locale が 'ja'（原文の
// 言語）のときや未リモート構成時は何もせず原文を返す。翻訳が届くまでは
// 原文を返し、届いた時点で再レンダリングされる。
export function useAutoTranslate(text: string, locale: string): string {
  const [, forceRerender] = useState(0)
  const shouldTranslate = isRemoteConfigured && locale !== 'ja' && !!text.trim()
  const cache = loadCache()
  const key = `${locale}::${text}`
  const cached = shouldTranslate ? cache[key] : undefined

  useEffect(() => {
    if (!shouldTranslate || cached !== undefined) return
    if ((failedUntil.get(key) ?? 0) > Date.now()) return
    pendingTexts.add(text)
    pendingListeners.push(() => forceRerender((n) => n + 1))
    scheduleFlush(locale)
  }, [text, locale, shouldTranslate, cached, key])

  return shouldTranslate ? (cached ?? text) : text
}
