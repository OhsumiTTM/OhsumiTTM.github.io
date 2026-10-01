// レジストリ(registry/Code.gs)のテストで使う、メモリ上のスプレッドシート・Drive・Google の tokeninfo
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

export const CODE = readFileSync(join(__dirname, '..', '..', 'registry', 'Code.gs'), 'utf8')

export class FakeSheet {
  rows: unknown[][] = []
  protections: object[] = []
  constructor(public name: string) {}
  getLastRow() { return this.rows.length }
  getLastColumn() { return Math.max(0, ...this.rows.map((r) => r.length)) }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      // 本物のシートと同じく、先頭の ' (文字として入れる印。safeCell が付ける)は読み取りの値に含めない
      getValues: () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => {
        const v = this.rows[row - 1 + r]?.[col - 1 + c] ?? ''
        return typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v
      })),
      setValues: (vals: unknown[][]) => vals.forEach((vs, r) => {
        const target = (this.rows[row - 1 + r] ??= [])
        vs.forEach((v, c) => { target[col - 1 + c] = v })
      }),
    }
  }
  appendRow(values: unknown[]) { this.rows.push(values) }
  deleteRow(row: number) { this.rows.splice(row - 1, 1) }
  setFrozenRows() {}
  getProtections() { return this.protections }
  protect() {
    const p = { description: '', removed: [] as string[], setDescription(d: string) { this.description = d; return this }, getEditors: () => ['someone@example.com'], removeEditor(u: string) { this.removed.push(u) } }
    this.protections.push(p)
    return p
  }
}

type DriveFile = { name: string; created: number; trashed: boolean; removedEditors: string[]; removedViewers: string[]; sharing: unknown[] }

// Google の tokeninfo の偽物: ID トークン → 応答(無ければ 400)
export type TokenInfo = Record<string, unknown>

export function setup(opts: { props?: Record<string, string>; now?: number; tokeninfo?: Record<string, TokenInfo> } = {}) {
  const sheets = new Map<string, FakeSheet>()
  const cache = new Map<string, string>()
  // スクリプトプロパティ。テストが直接書き換えた時は、キャッシュに置いた写し(registryProps_)を捨てる
  // (本物では、エディタで書き換えてから最大5分で反映される)
  let ctxRef: Record<string, unknown> | null = null
  const forget = () => { cache.delete('registry:props'); if (ctxRef) ctxRef._registryProps = null }
  const props: Record<string, string> = new Proxy({ ...(opts.props ?? {}) } as Record<string, string>, {
    set: (o, k, v) => { o[k as string] = v; forget(); return true },
    deleteProperty: (o, k) => { delete o[k as string]; forget(); return true },
  })
  // 覚えた秒数(CacheService.put の3つ目)
  const cacheTtl = new Map<string, number>()
  const triggers: { handler: string; hour?: number }[] = []
  const files: DriveFile[] = []
  const logs: string[] = []
  // 送ったメール(停止の予告)
  const mails: { to: string; subject: string; body: string }[] = []
  const mailQuota = { remaining: 100 }
  const newFile = (name: string, created = Date.now()): DriveFile => ({ name, created, trashed: false, removedEditors: [], removedViewers: [], sharing: [] })
  const driveHandle = (f: DriveFile) => ({
    getName: () => f.name,
    getId: () => 'folder-1',
    getDateCreated: () => new Date(f.created),
    setTrashed: (v: boolean) => { f.trashed = v },
    getEditors: () => ['editor@example.com'],
    getViewers: () => ['viewer@example.com'],
    removeEditor: (u: string) => f.removedEditors.push(u),
    removeViewer: (u: string) => f.removedViewers.push(u),
    setSharing: (...a: unknown[]) => f.sharing.push(a),
  })
  const folder = newFile('folder')
  const folderHandle = {
    ...driveHandle(folder),
    getFiles: () => {
      const list = files.filter((f) => !f.trashed)
      let i = 0
      return { hasNext: () => i < list.length, next: () => driveHandle(list[i++]) }
    },
  }
  const ctx = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error() {} },
    Logger: { log() {} },
    // 1日に送れる宛先の残り(mailQuota.remaining。テストで変えられる)。送るたびに宛先の数だけ減る
    MailApp: {
      sendEmail: (m: { to: string; subject: string; body: string }) => {
        const n = String(m.to).split(',').filter(Boolean).length
        if (mailQuota.remaining < n) throw new Error('Service invoked too many times for one day: email.')
        mailQuota.remaining -= n
        mails.push(m)
      },
      getRemainingDailyQuota: () => mailQuota.remaining,
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string, ttl?: number) => { cache.set(k, v); cacheTtl.set(k, ttl ?? 600) }, remove: (k: string) => { cache.delete(k) } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_a: string, text: string) => Array.from(createHash('sha256').update(String(text)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (v: number[] | string) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff))).toString('base64url'),
      base64DecodeWebSafe: (s: string) => Array.from(Buffer.from(s, 'base64url')),
      newBlob: (bytes: number[]) => ({ getDataAsString: () => Buffer.from(bytes.map((b) => b & 0xff)).toString('utf8') }),
      computeHmacSha256Signature: (value: string, key: string) => Array.from(createHmac('sha256', key).update(value).digest()),
      getUuid: () => Math.random().toString(36),
      formatDate: () => '2026-10-01',
    },
    SpreadsheetApp: {
      ProtectionType: { SHEET: 'SHEET' },
      getActiveSpreadsheet: () => ({
        getId: () => 'ss1',
        getSheetByName: (n: string) => sheets.get(n) ?? null,
        insertSheet: (n: string) => { const s = new FakeSheet(n); sheets.set(n, s); return s },
      }),
    },
    UrlFetchApp: {
      fetch: (url: string) => {
        const token = decodeURIComponent(url.split('id_token=')[1] ?? '')
        const info = opts.tokeninfo?.[token]
        return { getResponseCode: () => (info ? 200 : 400), getContentText: () => JSON.stringify(info ?? { error: 'invalid_token' }) }
      },
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      Permission: { NONE: 'NONE' },
      createFolder: () => folderHandle,
      getFolderById: () => folderHandle,
      getFileById: () => ({ makeCopy: (name: string) => { const f = newFile(name); files.push(f); return driveHandle(f) } }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, t })),
      deleteTrigger: (h: { t: object }) => { triggers.splice(triggers.indexOf(h.t as never), 1) },
      newTrigger: (handler: string) => {
        const t: { handler: string; hour?: number } = { handler }
        const b = { timeBased: () => b, everyDays: () => b, atHour: (h: number) => { t.hour = h; return b }, create: () => { triggers.push(t) } }
        return b
      },
    },
  })
  vm.runInContext(CODE, ctx)
  ctxRef = ctx as unknown as Record<string, unknown>
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown> & Record<string, unknown>
  const post = (body: unknown) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text)
  return { gas, props, sheets, cache, cacheTtl, triggers, files, logs, mails, mailQuota, post, newFile }
}

