// 公開前の通しテスト(lib/ohsumi/e2e-release.test.ts・e2e/browser.e2e.ts)で使う「世界」:
// レジストリ(registry/Code.gs)と、複数の団体の GAS(gas/Code.gs)を、それぞれ空のスプレッドシートから動かす。
// ほかのテストと違い、ログイン・セッション・権限の確かめは本物のコードのまま動かす(差し替えるのは Google のサービスだけ):
//   - Google の ID トークンの確かめ(tokeninfo)は、トークンの中身(base64url の JSON)をそのまま返す偽物
//   - スプレッドシート・プロパティ・キャッシュはメモリの上。メール・Drive・カレンダー・トリガーは何もしない(メールは記録する)
//   - 団体の GAS からレジストリへの通信は、この世界のレジストリにつなぐ
import { createHash, createHmac } from 'node:crypto'
import vm from 'node:vm'
import { CLIENT_VERSION } from '../codes'
import { CODE_GS, FakeSheet, noop, type Cell } from '../gas-guard-harness'
import { setup as setupRegistry, type TokenInfo } from '../registry-harness'

export const REGISTRY_URL = 'https://script.google.com/macros/s/E2E_REGISTRY/exec'
export const OAUTH_CLIENT_ID = 'e2e-client.apps.googleusercontent.com'
const REGISTRY_ADMIN = 'fsif.admin@example.com'

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
export const sha256B64url = (s: string) => createHash('sha256').update(s).digest('base64url')

/** 画面が Google から受け取るのと同じ形の ID トークン(署名は偽物。中身は tokeninfo の偽物がそのまま返す) */
export function fakeIdToken(payload: Record<string, unknown>): string {
  return b64url(JSON.stringify({ alg: 'RS256' })) + '.' + b64url(JSON.stringify(payload)) + '.sig'
}

// tokeninfo の偽物: トークンの中身に、Google が付ける項目(発行先・発行元・期限・確認済み)を足して返す
function tokeninfoFor(url: string, aud: string): { code: number; body: Record<string, unknown> } {
  const token = decodeURIComponent(url.split('id_token=')[1] ?? '')
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
    if (payload.invalid) return { code: 400, body: { error: 'invalid_token' } }
    const now = Math.floor(Date.now() / 1000)
    return { code: 200, body: { aud, iss: 'https://accounts.google.com', exp: String(now + 3600), iat: String(now), email_verified: 'true', ...payload } }
  } catch {
    return { code: 400, body: { error: 'invalid_token' } }
  }
}

export type Org = ReturnType<typeof createOrg>

/** 空のスプレッドシートに、団体の GAS を置いて setupOhsumi を実行したもの */
function createOrg(name: string, gasUrl: string, regPost: (payload: string) => unknown) {
  const sheets: Record<string, FakeSheet> = {}
  const props: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID, REGISTRY_URL, OHSUMI_WEBAPP_URL: gasUrl }
  const cache = new Map<string, string>()
  const mails: { to: string; subject: string; body: string }[] = []
  const logs: string[] = []
  // Drive のコピー(バックアップ)。作ったコピーの名前だけを覚える
  const driveCopies: { id: string; name: string; at: Date }[] = []
  const driveFile = (id: string) => noop({
    getId: () => id,
    makeCopy: (copyName: string) => {
      const copy = { id: 'copy-' + (driveCopies.length + 1), name: copyName, at: new Date() }
      driveCopies.push(copy)
      return noop({ getId: () => copy.id, getName: () => copy.name, getDateCreated: () => copy.at })
    },
  })
  const driveFolder = (id: string) => noop({
    getId: () => id,
    getFiles: () => {
      let i = 0
      return { hasNext: () => i < driveCopies.length, next: () => { const c = driveCopies[i++]; return noop({ getId: () => c.id, getName: () => c.name, getDateCreated: () => c.at }) } }
    },
  })
  const spreadsheet = noop({
    getName: () => name,
    getId: () => 'ss-' + name,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/ss-' + encodeURIComponent(name) + '/edit',
    getSheetByName: (n: string) => (sheets[n] ? noop(sheets[n]) : null),
    getSheets: () => Object.values(sheets).map((s) => noop(s)),
    insertSheet: (n: string) => { sheets[n] = new FakeSheet(n, []); return noop(sheets[n]) },
  })
  const ctx = vm.createContext({
    console: { log: (m: unknown) => logs.push(String(m)), warn: (m: unknown) => logs.push(String(m)), error: (m: unknown) => logs.push(String(m)) },
    Logger: { log: (m: unknown) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: unknown) => { props[k] = String(v) },
      setProperties: (o: Record<string, string>) => { Object.assign(props, o) },
      deleteProperty: (k: string) => { delete props[k] },
      getKeys: () => Object.keys(props),
    }) },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({
      get: (k: string) => cache.get(k) ?? null,
      getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      put: (k: string, v: string) => { cache.set(k, v) },
      putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, v) },
      remove: (k: string) => { cache.delete(k) },
      removeAll: (ks: string[]) => { ks.forEach((k) => cache.delete(k)) },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: noop({ flush() {}, getActiveSpreadsheet: () => spreadsheet, getActive: () => spreadsheet, openById: () => spreadsheet }),
    MailApp: {
      sendEmail: (a: unknown, b?: string, c?: string) => {
        const m = typeof a === 'string' ? { to: a, subject: String(b), body: String(c) } : a as { to: string; subject: string; body: string }
        mails.push({ to: String(m.to), subject: String(m.subject), body: String(m.body) })
      },
      getRemainingDailyQuota: () => 100,
    },
    LanguageApp: { translate: (s: string) => s },
    Session: noop({ getScriptTimeZone: () => 'Asia/Tokyo' }),
    DriveApp: noop({ createFolder: () => driveFolder('folder-backup'), getFolderById: (id: string) => driveFolder(id), getFileById: (id: string) => driveFile(id) }),
    CalendarApp: noop({}),
    ScriptApp: noop({ getService: () => ({ getUrl: () => gasUrl }), getProjectTriggers: () => [], getScriptId: () => 'script-' + gasUrl.split('/')[5] }),
    UrlFetchApp: {
      fetch: (url: string, o: { payload?: string } = {}) => {
        if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          const r = tokeninfoFor(url, OAUTH_CLIENT_ID)
          return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) }
        }
        if (url === REGISTRY_URL) {
          const out = regPost(String(o.payload))
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(out) }
        }
        // 登録の前の、この GAS の URL の確かめ(GET。doGet と同じ応答)
        if (url === gasUrl) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: false, getReceived: true, bounced: true }) }
        return { getResponseCode: () => 200, getContentText: () => '{}' }
      },
    },
    Utilities: noop({
      formatDate: (d: Date, _tz: string, fmt: string) => {
        const j = new Date(d.getTime() + 9 * 3600 * 1000).toISOString()
        if (fmt === 'yyyy-MM-dd') return j.slice(0, 10)
        if (fmt === 'HH') return j.slice(11, 13)
        return j.slice(0, 16).replace('T', ' ')
      },
      newBlob: (d: Buffer | string | number[]) => {
        const bytes = Array.isArray(d) ? Buffer.from(d.map((b) => b & 0xff)) : Buffer.from(d as Buffer | string)
        return noop({ getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') })
      },
      gzip: (b: unknown) => b,
      ungzip: (b: unknown) => b,
      base64Encode: (bytes: Buffer) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s: string) => Array.from(Buffer.from(s, 'base64')),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_a: string, text: string) => Array.from(createHash('sha256').update(String(text)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (v: number[] | string) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff))).toString('base64url'),
      base64DecodeWebSafe: (s: string) => Array.from(Buffer.from(s, 'base64url')),
      computeHmacSha256Signature: (value: string | number[], key: string | number[]) =>
        Array.from(createHmac('sha256', Buffer.from(typeof key === 'string' ? key : key.map((b) => b & 0xff))).update(typeof value === 'string' ? value : Buffer.from(value.map((b) => b & 0xff))).digest()),
      sleep: () => {},
    }),
  })
  vm.runInContext(CODE_GS, ctx)
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown>
  ;(gas.setupOhsumi as () => void)()
  // 画面と同じく clientVersion を付けて送る(付けない古い画面は reloadRequired になる)
  const post = (body: Record<string, unknown>) => postRaw({ clientVersion: CLIENT_VERSION, ...body })
  const postRaw = (body: Record<string, unknown>) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: JSON.stringify(body) } }).text)
  return { postRaw, name, gasUrl, gas, sheets, props, cache, mails, logs, post, driveCopies }
}

/** レジストリと団体の GAS の世界。団体は registerOrg で、本番と同じ手順(登録コード → 登録 → 初期設定コード)で立ち上げる */
export function createWorld() {
  const now = Math.floor(Date.now() / 1000)
  const adminSecret = 'e2e-registry-admin-secret-0001'
  const tokens: Record<string, TokenInfo> = {
    'hdr.admin.sig': { aud: 'e2e-registry-client', iss: 'https://accounts.google.com', email: REGISTRY_ADMIN, email_verified: 'true',
      exp: String(now + 3600), iat: String(now), nonce: 'registry-admin.' + sha256B64url(adminSecret) },
  }
  const reg = setupRegistry({ props: { ADMIN_EMAILS: REGISTRY_ADMIN, OAUTH_CLIENT_ID: 'e2e-registry-client' }, tokeninfo: tokens })
  reg.gas.setupRegistry()
  const adminSession = reg.post({ action: 'adminLogin', idToken: 'hdr.admin.sig', nonceSecret: adminSecret }).result.session.token as string
  const orgs = new Map<string, Org>()

  /** 新しい団体を立ち上げる: 登録コードの発行 → 団体の GAS で登録 → 初期設定コード */
  const launchOrg = (name: string, contactEmail: string) => {
    const issued = reg.post({ action: 'issueRegistrationCode', session: adminSession, orgName: name, contactName: '担当', contactEmail })
    if (!issued.ok) throw new Error('登録コードを発行できません: ' + issued.error)
    const gasUrl = 'https://script.google.com/macros/s/E2E_' + (orgs.size + 1) + '/exec'
    const org = createOrg(name, gasUrl, (payload) => reg.post(payload))
    const res = (org.gas.registerWithRegistry_ as (c: string) => Record<string, unknown>)(issued.result.code)
    if (!res.setupCode) throw new Error('団体を登録できません: ' + JSON.stringify(res))
    orgs.set(String(org.props.ORG_ID), org)
    return { org, orgId: String(org.props.ORG_ID), setupCode: String(res.setupCode) }
  }

  /** 画面と同じ手順で Google のログインをする(nonce = 団体ID + '.' + SHA-256(この端末の乱数)) */
  const googleLogin = (org: Org, email: string, opts: { setupCode?: string; nonceOrgId?: string; remember?: boolean } = {}) => {
    const nonceSecret = 'nonce-' + crypto.randomUUID()
    const idToken = fakeIdToken({ email, nonce: (opts.nonceOrgId ?? org.props.ORG_ID) + '.' + sha256B64url(nonceSecret) })
    return org.post({ action: 'exchangeIdToken', idToken, nonceSecret, setupCode: opts.setupCode, remember: opts.remember ?? true })
  }

  /** ログインした人として操作する(画面の postToGas と同じ形) */
  let seq = 0
  const call = (org: Org, token: string | undefined, action: string, payload: Record<string, unknown> = {}) =>
    org.post({ action, sessionToken: token, requestId: 'e2e-' + (++seq), ...payload })

  return { reg, adminSession, orgs, launchOrg, googleLogin, call }
}

export type World = ReturnType<typeof createWorld>
export type { Cell }
