// デモ(<サイト>/demo/)で、団体の GAS(gas/Code.gs)をブラウザの中で動かすための、偽の Google のサービス。
// lib/ohsumi/e2e/world.ts(公開前の通しテスト)と同じ考え方で、node の機能を使わずに作る。
//   - スプレッドシート・スクリプトプロパティ・キャッシュは、メモリの上(FakeSheet)
//   - Google の ID トークンの確かめ(tokeninfo)は、デモのログイン画面が作った偽のトークンの中身をそのまま返す。
//     本物の Google には一切つながない(UrlFetchApp はどこにも通信しない)
//   - メール・Drive・カレンダー・トリガー・翻訳は何もしない(メールは記録だけする)
import { FakeSheet, noop, type Cell } from '../ohsumi/gas-fakes'
import { hmacSha256, sha256 } from './sha256'

// ---- バイト列(GAS のバイト列は -128〜127 の数の配列) --------------------------------------

const enc = new TextEncoder()
const dec = new TextDecoder()

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (Array.isArray(v)) return Uint8Array.from(v as number[], (b) => b & 0xff)
  return enc.encode(String(v ?? ''))
}
const toSigned = (b: Uint8Array): number[] => Array.from(b, (x) => (x > 127 ? x - 256 : x))

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
function b64decode(s: string): Uint8Array {
  const bin = atob(String(s).replace(/\s+/g, ''))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const toWebSafe = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_')
const fromWebSafe = (s: string) => String(s).replace(/-/g, '+').replace(/_/g, '/')

/** base64url(パディングなし)。デモのログイン画面が偽の ID トークンを作る時にも使う */
export function base64UrlOf(text: string): string {
  return toWebSafe(b64encode(enc.encode(text))).replace(/=+$/, '')
}
export function sha256Base64Url(text: string): string {
  return toWebSafe(b64encode(sha256(enc.encode(text)))).replace(/=+$/, '')
}

function blob(bytes: Uint8Array, contentType = '', name = ''): Record<string, unknown> {
  let type = contentType
  let fileName = name
  const self: Record<string, unknown> = {
    getBytes: () => toSigned(bytes),
    getDataAsString: () => dec.decode(bytes),
    getContentType: () => type,
    setContentType: (t: string) => { type = t; return self },
    getName: () => fileName,
    setName: (n: string) => { fileName = n; return self },
    copyBlob: () => blob(bytes.slice(), type, fileName),
    getBlob: () => self,
  }
  return noop(self)
}

// ---- 日時 ----------------------------------------------------------------------------

function formatDate(d: Date, tz: string, fmt: string): string {
  let parts: Record<string, string>
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Asia/Tokyo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }).formatToParts(d).map((p) => [p.type, p.value]))
  } catch {
    return formatDate(d, 'Asia/Tokyo', fmt)
  }
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  const tokens: Record<string, string> = {
    yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, SSS: ms,
    H: String(Number(parts.hour)), E: parts.weekday,
  }
  // 'T' のような引用符の中はそのまま
  return String(fmt).replace(/'([^']*)'|yyyy|SSS|MM|dd|HH|mm|ss|H|E/g, (m, lit) => (lit !== undefined ? lit : tokens[m] ?? m))
}

// ---- ID トークン(デモのログイン画面が作る偽物) -----------------------------------------

function tokeninfo(url: string, clientId: string): { code: number; body: Record<string, unknown> } {
  const token = decodeURIComponent(url.split('id_token=')[1] ?? '')
  try {
    const payload = JSON.parse(dec.decode(b64decode(fromWebSafe(token.split('.')[1] ?? '').padEnd(Math.ceil((token.split('.')[1] ?? '').length / 4) * 4, '=')))) as Record<string, unknown>
    const now = Math.floor(Date.now() / 1000)
    return { code: 200, body: { aud: clientId, iss: 'https://accounts.google.com', exp: String(now + 3600), iat: String(now), email_verified: 'true', ...payload } }
  } catch {
    return { code: 400, body: { error: 'invalid_token' } }
  }
}

// ---- 環境 ----------------------------------------------------------------------------

// Drive に置いたファイル(アップロードした画像)。data は base64
export interface DemoDriveFile {
  id: string
  name: string
  mimeType: string
  data: string
  parentId: string
  trashed?: boolean
  createdAt: number
}

export interface DemoGasState {
  name: string
  sheets: Record<string, Cell[][]>
  props: Record<string, string>
  cache: [string, string][]
  files?: DemoDriveFile[]
}

// 保存するファイルの合計の上限(ブラウザの sessionStorage は 5MB ほど。超えた分は、このページの間だけ使える)
const PERSIST_FILES_MAX_CHARS = 1_500_000

export interface DemoGoogleEnv {
  env: Record<string, unknown>
  state: () => DemoGasState
  mails: { to: string; subject: string }[]
  logs: string[]
}

export function createGoogleEnv(opts: { gasUrl: string; clientId: string; state: DemoGasState }): DemoGoogleEnv {
  const { gasUrl, clientId } = opts
  const name = opts.state.name
  const sheets: Record<string, FakeSheet> = {}
  for (const [n, rows] of Object.entries(opts.state.sheets)) sheets[n] = new FakeSheet(n, rows)
  const props: Record<string, string> = { ...opts.state.props }
  const cache = new Map<string, string>(opts.state.cache)
  const mails: { to: string; subject: string }[] = []
  const logs: string[] = []
  const log = (...m: unknown[]) => { logs.push(m.map(String).join(' ')); if (logs.length > 200) logs.shift() }

  // ---- Drive(メモリの上。アップロードした画像を、このタブの中だけで扱う) ----
  const files = new Map<string, DemoDriveFile>((opts.state.files ?? []).map((f) => [f.id, f]))
  const newId = (prefix: string) => prefix + crypto.randomUUID().replace(/-/g, '')
  const iter = <T,>(items: T[]) => { let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] } }
  const shareStub = { setSharing: () => {}, getSharingAccess: () => 'PRIVATE', getSharingPermission: () => 'NONE', getEditors: () => [], getViewers: () => [], addEditor: () => {}, removeEditor: () => {} }
  const fileObj = (f: DemoDriveFile): Record<string, unknown> => noop({
    ...shareStub,
    getId: () => f.id,
    getName: () => f.name,
    setName: (n: string) => { f.name = String(n) },
    getMimeType: () => f.mimeType,
    getSize: () => Math.floor((f.data.length * 3) / 4),
    getBlob: () => blob(b64decode(f.data), f.mimeType, f.name),
    getUrl: () => '',
    getDateCreated: () => new Date(f.createdAt),
    getLastUpdated: () => new Date(f.createdAt),
    getParents: () => iter([folderObj(f.parentId)]),
    isTrashed: () => !!f.trashed,
    setTrashed: (v: boolean) => { f.trashed = !!v },
    makeCopy: (n: string, folder?: { getId: () => string }) => {
      const copy: DemoDriveFile = { ...f, id: newId('demofile'), name: String(n), parentId: folder?.getId() ?? f.parentId, createdAt: Date.now() }
      files.set(copy.id, copy)
      return fileObj(copy)
    },
  })
  const missing = (id: string) => { throw new Error('ファイルが見つかりません: ' + id) }
  const folderObj = (id: string): Record<string, unknown> => noop({
    ...shareStub,
    getId: () => id,
    getName: () => id,
    getUrl: () => '',
    createFile: (b: { getBytes: () => number[]; getContentType?: () => string; getName?: () => string }) => {
      const f: DemoDriveFile = {
        id: newId('demofile'), name: b.getName?.() || 'file', mimeType: b.getContentType?.() || 'application/octet-stream',
        data: b64encode(toBytes(b.getBytes())), parentId: id, createdAt: Date.now(),
      }
      files.set(f.id, f)
      return fileObj(f)
    },
    createFolder: (n: string) => folderObj(newId('demofolder') + '-' + String(n).length),
    getFiles: () => iter([...files.values()].filter((f) => f.parentId === id && !f.trashed).map(fileObj)),
    getFilesByName: (n: string) => iter([...files.values()].filter((f) => f.parentId === id && f.name === n && !f.trashed).map(fileObj)),
    getFolders: () => iter([]),
    getFoldersByName: () => iter([]),
  })
  const spreadsheetFile = noop({ ...shareStub, getId: () => 'demo-spreadsheet', getName: () => name, makeCopy: () => noop({ getId: () => newId('democopy'), getName: () => name }) })

  const spreadsheet = noop({
    getName: () => name,
    getId: () => 'demo-spreadsheet',
    getUrl: () => '',
    getSpreadsheetTimeZone: () => 'Asia/Tokyo',
    getSheetByName: (n: string) => (sheets[n] ? noop(sheets[n]) : null),
    getSheets: () => Object.values(sheets).map((s) => noop(s)),
    insertSheet: (n: string) => { sheets[n] = new FakeSheet(n, []); return noop(sheets[n]) },
  })

  const env: Record<string, unknown> = {
    console: { log, info: log, warn: log, error: log },
    Logger: { log },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({ ...props }),
        getProperty: (k: string) => props[k] ?? null,
        setProperty: (k: string, v: unknown) => { props[k] = String(v) },
        setProperties: (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) props[k] = String(v) },
        deleteProperty: (k: string) => { delete props[k] },
        deleteAllProperties: () => { for (const k of Object.keys(props)) delete props[k] },
        getKeys: () => Object.keys(props),
      }),
    },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    HtmlService: noop({}),
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cache.get(k) ?? null,
        getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
        put: (k: string, v: string) => { cache.set(k, String(v)) },
        putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, String(v)) },
        remove: (k: string) => { cache.delete(k) },
        removeAll: (ks: string[]) => { ks.forEach((k) => cache.delete(k)) },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {}, hasLock: () => true }) },
    SpreadsheetApp: noop({ flush() {}, getActiveSpreadsheet: () => spreadsheet, getActive: () => spreadsheet, openById: () => spreadsheet }),
    MailApp: {
      sendEmail: (a: unknown, b?: string) => {
        const m = typeof a === 'string' ? { to: a, subject: String(b) } : (a as { to: string; subject: string })
        mails.push({ to: String(m.to), subject: String(m.subject) })
      },
      getRemainingDailyQuota: () => 100,
    },
    // 自動翻訳はしない(原文のまま)
    LanguageApp: { translate: (s: string) => s },
    Session: noop({ getScriptTimeZone: () => 'Asia/Tokyo', getEffectiveUser: () => noop({ getEmail: () => '' }), getActiveUser: () => noop({ getEmail: () => '' }) }),
    DriveApp: noop({
      getRootFolder: () => folderObj('root'),
      createFolder: () => folderObj(newId('demofolder')),
      getFolderById: (id: string) => folderObj(String(id)),
      getFileById: (id: string) => {
        if (id === 'demo-spreadsheet') return spreadsheetFile
        const f = files.get(String(id))
        return f && !f.trashed ? fileObj(f) : missing(String(id))
      },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT', NONE: 'NONE' },
      Access: { PRIVATE: 'PRIVATE', ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK' },
    }),
    CalendarApp: noop({}),
    ScriptApp: noop({
      getService: () => ({ getUrl: () => gasUrl }),
      getProjectTriggers: () => [],
      getScriptId: () => 'demo-script',
      getOAuthToken: () => 'demo',
      newTrigger: () => noop({}),
    }),
    UrlFetchApp: {
      fetch: (url: string) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          const r = tokeninfo(url, clientId)
          return noop({ getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) })
        }
        // ほかの通信(レジストリ・Sheets API・Webhook など)はしない。使えない応答を返す(GAS はそれぞれの代わりの処理に進む)
        return noop({ getResponseCode: () => 503, getContentText: () => '{"error":"demo"}', getHeaders: () => ({}) })
      },
      fetchAll: (reqs: unknown[]) => reqs.map(() => noop({ getResponseCode: () => 503, getContentText: () => '{"error":"demo"}' })),
    },
    Utilities: noop({
      formatDate: (d: Date, tz: string, fmt: string) => formatDate(d instanceof Date ? d : new Date(d as unknown as string), tz, fmt),
      newBlob: (d: unknown, type?: string, n?: string) => blob(toBytes(d), type, n),
      gzip: (b: { getBytes: () => number[] }) => blob(toBytes(b.getBytes()), 'application/x-gzip'),
      ungzip: (b: { getBytes: () => number[] }) => blob(toBytes(b.getBytes())),
      base64Encode: (v: unknown) => b64encode(toBytes(v)),
      base64Decode: (s: string) => toSigned(b64decode(s)),
      base64EncodeWebSafe: (v: unknown) => toWebSafe(b64encode(toBytes(v))),
      base64DecodeWebSafe: (s: string) => {
        const t = fromWebSafe(s)
        return toSigned(b64decode(t.padEnd(Math.ceil(t.length / 4) * 4, '=')))
      },
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      MacAlgorithm: { HMAC_SHA_256: 'hmacsha256' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_a: string, v: unknown) => toSigned(sha256(toBytes(v))),
      computeHmacSha256Signature: (value: unknown, key: unknown) => toSigned(hmacSha256(toBytes(key), toBytes(value))),
      sleep: () => {},
    }),
  }

  const state = (): DemoGasState => {
    // 新しいファイルから、上限までを保存する(古いものは、このページの間だけ)
    const kept: DemoDriveFile[] = []
    let total = 0
    for (const f of [...files.values()].filter((x) => !x.trashed).sort((a, b) => b.createdAt - a.createdAt)) {
      if (total + f.data.length > PERSIST_FILES_MAX_CHARS) continue
      total += f.data.length
      kept.push(f)
    }
    return {
      name,
      sheets: Object.fromEntries(Object.entries(sheets).map(([n, s]) => [n, s.rows])),
      props: { ...props },
      // 画像のキャッシュ(file:)は保存しない(ファイルから作り直せる)
      cache: [...cache.entries()].filter(([k]) => !k.startsWith('file:')),
      files: kept,
    }
  }
  return { env, state, mails, logs }
}
