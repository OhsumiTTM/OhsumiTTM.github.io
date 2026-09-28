// Google Identity Services (GIS) — token client for OAuth flows.
// The GIS script is loaded globally in app/layout.tsx.
// No npm packages needed: GIS is loaded via <script> tag, Sheets API via fetch().
//
// フロントが要求するスコープはこのファイルの定数だけにまとめる(他のファイルで
// スコープの文字列を書かない)。既定で要求するのは非機密のスコープだけ:
//   LOGIN_SCOPE      'openid email'  ログインと、Apps Script への本人確認
//   DRIVE_FILE_SCOPE drive.file      個人スプレッドシート(アプリが作ったファイルだけ)
// CALENDAR_SCOPE(機密)は、features.ts の isGoogleCalendarReadEnabled が true の
// 場合だけ要求する(既定では無効)。

import { isGoogleCalendarReadEnabled } from './features'

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: { access_token?: string; error?: string }) => void
          }) => {
            requestAccessToken: (options?: { prompt?: string }) => void
          }
        }
      }
    }
  }
}

export const LOGIN_SCOPE = 'openid email'
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

function waitForGIS(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('ブラウザ環境でのみ使用できます'))
      return
    }
    if (window.google?.accounts?.oauth2) {
      resolve()
      return
    }
    let attempts = 0
    const interval = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(interval)
        resolve()
      } else if (++attempts > 100) {
        clearInterval(interval)
        reject(new Error('Google Identity Services の読み込みタイムアウト'))
      }
    }, 100)
  })
}

function requestToken(scope: string, silent = false): Promise<string> {
  if (!CLIENT_ID) return Promise.reject(new Error('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID が設定されていません'))
  return waitForGIS().then(
    () =>
      new Promise((resolve, reject) => {
        const client = window.google!.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID!,
          scope,
          callback: (resp) => {
            if (resp.error || !resp.access_token) {
              reject(new Error(resp.error ?? '認証に失敗しました'))
            } else {
              resolve(resp.access_token)
            }
          },
        })
        client.requestAccessToken(silent ? { prompt: '' } : undefined)
      }),
  )
}

// ---- login (openid email) ----------------------------------------

export function isGoogleOAuthConfigured(): boolean {
  return !!CLIENT_ID
}

export function requestGoogleLoginToken(): Promise<string> {
  return requestToken(LOGIN_SCOPE)
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<{ email: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error('ユーザー情報の取得に失敗しました')
  return res.json() as Promise<{ email: string }>
}

// ---- GAS auth token cache (module-level, browser-only) -------------------
// The access token from requestGoogleLoginToken() is reused for every GAS
// write request. It is stored here after login and cleared on logout.

let _gasAuthToken: string | null = null

export function setGasAuthToken(token: string | null): void {
  _gasAuthToken = token
}

export function getGasAuthToken(): string | null {
  return _gasAuthToken
}

/** Silently requests a new Google access token (no popup) and updates the cache. */
export function refreshGasAuthToken(): Promise<string> {
  return requestToken(LOGIN_SCOPE, /* silent= */ true).then((token) => {
    _gasAuthToken = token
    return token
  })
}

// ---- personal sheet sync (drive.file scope) -------------------------------
// drive.file では、アプリが作成したファイルにしか触れられない。そのため、
// 同期先のスプレッドシートはアプリが新しく作成する(既存のシートの URL を
// 貼り付けて連携する方式は廃止した)。

export function requestDriveFileToken(silent = false): Promise<string> {
  return requestToken(DRIVE_FILE_SCOPE, silent)
}

export interface PersonalSheet {
  id: string
  title: string
}

/** 同期用のスプレッドシートを新しく作成する(Sheets API の spreadsheets.create)。 */
export async function createPersonalSpreadsheet(accessToken: string, title: string): Promise<PersonalSheet> {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: SHEET_NAME } }],
    }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(data?.error?.message ?? `作成エラー HTTP ${res.status}`)
  }
  const data = await res.json() as { spreadsheetId: string; properties?: { title?: string } }
  return { id: data.spreadsheetId, title: data.properties?.title ?? title }
}

export function personalSheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`
}

/** 同期先のシートにアクセスできない(削除された・アプリが作ったものではない)エラー */
export class PersonalSheetUnavailableError extends Error {}

export interface SyncRow {
  taskName: string
  project: string
  department: string
  assignees: string
  status: string
  priority: string
  difficulty: string
  category: string
  skills: string
  startDate: string
  deadline: string
  completedDate: string
  progress: string
  description: string
}

const SHEET_NAME = 'Ohsumi Sync'

const HEADER = [
  'タスク名', 'プロジェクト', '部門', '担当者', 'ステータス',
  '優先度', '難易度', 'カテゴリ', '必要スキル', '開始日', '期限', '完了日', '進捗', '説明',
]

export async function syncTasksToSheet(
  spreadsheetId: string,
  accessToken: string,
  rows: SyncRow[],
): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
  const values = [HEADER, ...rows.map((r) => [
    r.taskName, r.project, r.department, r.assignees, r.status,
    r.priority, r.difficulty, r.category, r.skills,
    r.startDate, r.deadline, r.completedDate, r.progress, r.description,
  ])]

  // Clear existing data, then write fresh
  await fetch(`${base}/values/${encodeURIComponent(SHEET_NAME)}:clear`, {
    method: 'POST', headers, body: JSON.stringify({}),
  }).catch(() => {}) // sheet may not exist yet — ignore clear failure

  const res = await fetch(
    `${base}/values/${encodeURIComponent(`${SHEET_NAME}!A1`)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers, body: JSON.stringify({ values }) },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: { message?: string } }
    if (res.status === 403 || res.status === 404) {
      throw new PersonalSheetUnavailableError(data?.error?.message ?? `HTTP ${res.status}`)
    }
    throw new Error(data?.error?.message ?? `書き込みエラー HTTP ${res.status}`)
  }
}

// ---- localStorage helpers (per-user, browser-only) -----------------------
// v2: アプリが作成したシート { id, title }。以前の方式(spreadsheets スコープで
// 既存のシートに連携)で保存したシートIDは LEGACY のキーに残っている場合がある。
// そのシートは drive.file では書き込めないため、新しいシートの作成を案内する。

function personalSheetKey(userId: string) {
  return `ohsumi-personal-sheet-v2-${userId}`
}

function legacyPersonalSheetKey(userId: string) {
  return `ohsumi-personal-sheet-id-${userId}`
}

export function loadPersonalSheet(userId: string): PersonalSheet | null {
  try {
    const raw = localStorage.getItem(personalSheetKey(userId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PersonalSheet>
    return typeof v.id === 'string' && v.id ? { id: v.id, title: String(v.title ?? '') } : null
  } catch {
    return null
  }
}

export function savePersonalSheet(userId: string, sheet: PersonalSheet | null): void {
  try {
    if (sheet) {
      localStorage.setItem(personalSheetKey(userId), JSON.stringify(sheet))
      localStorage.removeItem(legacyPersonalSheetKey(userId))
    } else {
      localStorage.removeItem(personalSheetKey(userId))
    }
  } catch {
    // ignore
  }
}

/** 以前の方式で連携したシートIDがブラウザに残っているか */
export function hasLegacyPersonalSheet(userId: string): boolean {
  try {
    return !!localStorage.getItem(legacyPersonalSheetKey(userId))
  } catch {
    return false
  }
}

export function clearLegacyPersonalSheet(userId: string): void {
  try {
    localStorage.removeItem(legacyPersonalSheetKey(userId))
  } catch {
    // ignore
  }
}

// ---- Google Calendar token cache (module-level, browser-only) -------------
// Separate from the GAS auth token — Calendar scope is requested incrementally
// when the user first accesses calendar features, not at login time.
//
// F13: メモリ上(モジュール変数)にのみ保持する。以前はsessionStorageにも
// 保存していたが、XSSが発生した場合にトークンを窃取されるリスクがあるため
// (sessionStorageはJSから読める)、永続化はせずページ再読み込みごとに
// 取り直す仕様にした(再度Calendarへのアクセス許可を求められることはある)。

let _calendarToken: string | null = null

export function getCalendarToken(): string | null {
  return _calendarToken
}

export function setCalendarToken(token: string | null): void {
  _calendarToken = token
}

/**
 * Request (or silently refresh) the Calendar scope token.
 * 予定の表示・空き時間の確認が無効(既定)の場合は、calendar スコープを要求せずに失敗する。
 */
export function requestCalendarToken(silent = false): Promise<string> {
  if (!isGoogleCalendarReadEnabled) {
    return Promise.reject(new Error('Googleカレンダーの予定の表示は現在ご利用いただけません'))
  }
  return requestToken(CALENDAR_SCOPE, silent).then((token) => {
    setCalendarToken(token)
    return token
  })
}
