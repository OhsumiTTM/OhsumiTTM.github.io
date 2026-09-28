// アップロードしたファイル(プロフィール画像・団体ロゴ・領収書・アンケート画像)
// の表示。ファイルは非公開で保存されているため、URLを直接 <img> に渡しても
// 表示できない。シートに保存されているURLからファイルIDを取り出し、GAS の
// getFiles で権限を確認したうえで取得して、blob URL(このタブのメモリ上
// だけにある一時的なURL)にして表示する。ログアウト時に clearFileCache で破棄する。
//
// Drive 以外のURL(手入力した外部の画像URLなど)や、アップロード直後の
// data: URL はそのまま表示する。
'use client'

import { useEffect, useState } from 'react'
import { isRemoteConfigured, remoteApi } from './remote'

// シートに保存されているURLの形式:
//   https://lh3.googleusercontent.com/d/<ID>=w256-h256-c (プロフィール画像・ロゴ・アンケート画像)
//   https://drive.google.com/file/d/<ID>/view?...        (領収書)
// 手入力された Drive の共有リンク(open?id= / uc?id= / thumbnail?id=)も対象にする
export function extractDriveFileId(url: string | undefined | null): string | null {
  if (!url) return null
  const patterns = [
    /^https:\/\/lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]{10,})/,
    /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/,
    /^https:\/\/drive\.google\.com\/(?:open|uc|thumbnail)\?(?:.*&)?id=([A-Za-z0-9_-]{10,})/,
  ]
  for (const re of patterns) {
    const m = url.match(re)
    if (m) return m[1]
  }
  return null
}

// fileId → blob URL(取得できなかった場合は null)
const cache = new Map<string, Promise<string | null>>()
const resolved = new Map<string, string | null>()

// 同じタイミングで要求されたファイルをまとめて1回の getFiles で取得する
// (GAS 側の上限は1回30件)
const BATCH_SIZE = 30
let queue: { id: string; resolve: (url: string | null) => void }[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

async function flush() {
  flushTimer = null
  const pending = queue
  queue = []
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE)
    try {
      const files = await remoteApi.getFiles(batch.map((b) => b.id))
      const byId = new Map(files.map((f) => [f.id, f]))
      const retry: typeof batch = []
      batch.forEach((b) => {
        const f = byId.get(b.id)
        if (f?.ok && f.data) {
          b.resolve(URL.createObjectURL(base64ToBlob(f.data, f.mimeType || 'application/octet-stream')))
        } else if (f?.error === 'batchTooLarge') {
          retry.push(b)
        } else {
          b.resolve(null)
        }
      })
      // 1回の応答の合計サイズ上限を超えた分は、1件ずつ取り直す
      for (const b of retry) {
        try {
          const [f] = await remoteApi.getFiles([b.id])
          b.resolve(f?.ok && f.data ? URL.createObjectURL(base64ToBlob(f.data, f.mimeType || 'application/octet-stream')) : null)
        } catch {
          b.resolve(null)
        }
      }
    } catch {
      batch.forEach((b) => b.resolve(null))
    }
  }
}

function loadFile(id: string): Promise<string | null> {
  const existing = cache.get(id)
  if (existing) return existing
  const promise = new Promise<string | null>((resolve) => {
    queue.push({ id, resolve })
    if (!flushTimer) flushTimer = setTimeout(flush, 30)
  }).then((url) => {
    resolved.set(id, url)
    return url
  })
  cache.set(id, promise)
  return promise
}

// 表示用のURLを返す。GAS 経由で取得するファイルは、取得できるまで undefined
// (呼び出し側は色とイニシャルなどの代わりの表示を出す)。取得できなかった
// 場合も undefined。
export function useFileUrl(url: string | undefined | null): string | undefined {
  const id = isRemoteConfigured ? extractDriveFileId(url) : null
  const [, forceRender] = useState(0)
  useEffect(() => {
    if (!id || resolved.has(id)) return
    let active = true
    loadFile(id).then(() => {
      if (active) forceRender((n) => n + 1)
    })
    return () => {
      active = false
    }
  }, [id])
  if (!url) return undefined
  if (!id) return url
  return resolved.get(id) ?? undefined
}

// 領収書などを新しいタブで開く。ポップアップを防がれないよう、クリックの
// 直後(同期的に)タブを開いてから、取得できたファイルを表示する。
export async function openStoredFile(url: string): Promise<boolean> {
  const id = isRemoteConfigured ? extractDriveFileId(url) : null
  if (!id) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  }
  const win = window.open('', '_blank')
  const blobUrl = await loadFile(id)
  if (!blobUrl) {
    win?.close()
    return false
  }
  if (win) win.location.href = blobUrl
  else window.location.href = blobUrl
  return true
}

// ログアウト時: 取得したファイルをメモリから破棄する
export function clearFileCache() {
  resolved.forEach((url) => {
    if (url) URL.revokeObjectURL(url)
  })
  resolved.clear()
  cache.clear()
  queue = []
}
