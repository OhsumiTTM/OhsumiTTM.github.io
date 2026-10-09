// 団体の GAS(gas/Code.gs)と、テストの中でつないだレジストリ(registry/Code.gs)。
// 登録(R1-c)と、提供停止・機能停止の確認(R1-e)のテストで使う
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { expect } from 'vitest'
import { setup as setupRegistry, type TokenInfo } from './registry-harness'

export const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
export const REGISTRY_URL = 'https://script.google.com/macros/s/REGISTRY/exec'
export const ORG_URL = 'https://script.google.com/macros/s/ORGGAS/exec'
const ROLES = JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }, { id: 'top', name: '代表', tier: 'top' }])
export const HOUR = 3600 * 1000

// HtmlService のテンプレート(<? ?>・<?= ?>)を、テストの中で HTML にする。<?= ?> は HTML の文字としてエスケープする
// (GAS は文脈に合わせてエスケープする。ここでは、どの文脈でも安全な、HTML の5文字のエスケープで代わりにする)
export const escapeHtml = (v: unknown) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
export function renderTemplate(html: string, vars: Record<string, unknown>): string {
  if (html.includes('<?!=')) throw new Error('<?!= ?> (エスケープしない出力)は使わない')
  let js = 'var __out = "";\n'
  const re = /<\?(=?)([\s\S]*?)\?>/g
  let last = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    js += '__out += ' + JSON.stringify(html.slice(last, m.index)) + ';\n'
    js += m[1] ? '__out += __esc(' + m[2] + ');\n' : m[2] + '\n'
    last = re.lastIndex
  }
  js += '__out += ' + JSON.stringify(html.slice(last)) + ';\n__out'
  return vm.runInNewContext(js, { ...vars, __esc: escapeHtml }) as string
}

// レジストリ(管理者のログインまで済ませ、登録コードを発行できる)
export function registry() {
  const CLIENT = 'registry-client'
  const nonce = 'registry-admin.' + createHash('sha256').update('nonce-secret-a1-0123456789').digest('base64url')
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': { aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600), iat: String(Math.floor(Date.now() / 1000)), nonce },
  }
  const r = setupRegistry({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  r.gas.setupRegistry()
  const session = r.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: 'nonce-secret-a1-0123456789' }).result.session.token
  const issue = (extra: Record<string, unknown> = {}) => r.post({ action: 'issueRegistrationCode', session, orgName: '新しい団体', ...extra }).result
  return { ...r, issue, session }
}

export type Reg = ReturnType<typeof registry>

// レジストリの Secrets に保存した共有鍵(先頭の ' は、シートが文字として扱う印なので除く)
export const storedKey = (reg: Reg) => String(reg.sheets.get('Secrets')!.rows[1][1]).replace(/^'/, '')

// ownGet: 登録の前に、この GAS の URL に送る GET の応答(既定は、この GAS の doGet の応答)
export function org(reg: Reg, opts: { members?: string[][]; lose?: number[]; props?: Record<string, string>; emails?: Record<string, string>; serviceUrl?: string; ownGet?: { code: number; text: string } } = {}) {
  const props: Record<string, string> = { REGISTRY_URL, OHSUMI_WEBAPP_URL: ORG_URL, GOOGLE_OAUTH_CLIENT_ID: 'x', ...(opts.props ?? {}) }
  const cache = new Map<string, string>()
  const logs: string[] = []
  const sent: Record<string, unknown>[] = []
  const members: string[][] = opts.members ?? [['id', 'name', 'role']]
  const added: { id: string; name: string; email: string; role: string }[] = []
  let fetches = 0
  const ownGets: string[] = []
  const dialogs: { title: string; text: string; html?: string; sections?: { heading: string; value: string; link: boolean; notes: string[] }[] }[] = []
  let promptAnswer = ''
  const ctx = vm.createContext({
    console: { log: (m: string) => logs.push(String(m)), warn: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) },
    Logger: { log: (m: string) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v },
      deleteProperty: (k: string) => { delete props[k] },
    }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v) }, remove: (k: string) => { cache.delete(k) }, getAll: () => ({}), putAll() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    HtmlService: {
      createTemplate: (html: string) => {
        const t: Record<string, unknown> = {}
        t.evaluate = () => {
          const vars = Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'evaluate')) as never
          const out = { html: renderTemplate(html, vars), vars, setWidth() { return out }, setHeight() { return out } }
          return out
        }
        return t
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    SpreadsheetApp: {
      flush() {},
      // メニューのダイアログ(表示した文を覚える。入力欄には promptAnswer を返す)
      getUi: () => ({
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
        Button: { OK: 'OK', CANCEL: 'CANCEL' },
        alert: (title: string, text: string) => { dialogs.push({ title, text }) },
        prompt: (title: string, text: string) => {
          dialogs.push({ title, text })
          return { getSelectedButton: () => 'OK', getResponseText: () => promptAnswer }
        },
        // HtmlService のダイアログ: 表示した HTML と、文(見出し・値・説明をつなげたもの)を覚える
        showModalDialog: (out: { html: string; vars: { intro: string; sections: { heading: string; value: string; link: boolean; notes: string[] }[] } }, title: string) => {
          const { intro, sections } = out.vars
          const text = [intro, ...sections.flatMap((s) => [s.heading, s.value, ...s.notes])].filter(Boolean).join('\n')
          dialogs.push({ title, text, html: out.html, sections })
        },
      }),
      getActiveSpreadsheet: () => ({
        getSheetByName: (n: string) => (n === 'Members' ? { getDataRange: () => ({ getValues: () => members.map((r) => r.slice()) }) } : null),
      }),
    },
    ScriptApp: { getService: () => ({ getUrl: () => opts.serviceUrl ?? ORG_URL }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_a: string, text: string) => Array.from(createHash('sha256').update(String(text)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (v: number[] | string) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff))).toString('base64url'),
      computeHmacSha256Signature: (value: string, key: string) => Array.from(createHmac('sha256', key).update(value).digest()),
      getUuid: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      formatDate: () => '2026/10/01 12:00',
    },
    // レジストリへの通信: レジストリの doPost につなぐ。lose に入れた回は、処理はされたが応答が失われたことにする
    UrlFetchApp: {
      fetch: (url: string, o: { payload: string; method?: string }) => {
        // 登録の前の、この GAS の URL の確かめ(GET)
        if (o.method === 'get') {
          ownGets.push(url)
          if (opts.ownGet) return { getResponseCode: () => opts.ownGet!.code, getContentText: () => opts.ownGet!.text }
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: false, getReceived: true, bounced: true }) }
        }
        fetches++
        expect(url).toBe(REGISTRY_URL)
        sent.push(JSON.parse(o.payload))
        const out = reg.post(o.payload)
        if (opts.lose?.includes(fetches)) return { getResponseCode: () => 404, getContentText: () => '<html>Sorry, unable to open the file at this time.</html>' }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(out) }
      },
    },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.readRoleSettings_ = () => ({ roles: ROLES })
  c.addMember_ = (name: string, email: string, _aff: string, role: string) => {
    const id = String(100 + added.length)
    added.push({ id, name, email, role })
    members.push([id, name, role])
    return { id }
  }
  // ログインの確認(IDトークン = メールアドレス)と、その後の初期データ
  c.verifyGoogleIdToken_ = (idToken: string) => ({ email: idToken })
  c.findMemberIdByEmailCached_ = (email: string) => opts.emails?.[email] ?? added.find((a) => a.email === email)?.id ?? null
  c.getInitialDataForMember_ = (id: string) => ({ memberId: id })
  c.issueSessionToken_ = (id: string) => ({ token: 'session-' + id, exp: 1 })
  c.recordLastLogin_ = () => true
  // メール(停止の予告)は送らずに覚える。宛先は opts.emails(メールアドレス → メンバーID)から引く
  const mails: { to: string; subject: string; body: string }[] = []
  c.sendMail_ = (m: { to: string; subject: string; body: string }) => { mails.push(m); return true }
  c.getAllMemberEmails_ = () => Object.fromEntries(Object.entries(opts.emails ?? {}).map(([email, id]) => [id, email]))
  c.getSettingValue_ = (key: string) => (key === 'org_name' ? 'テスト団体' : '')
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown>
  const post = (body: object) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: JSON.stringify(body) } }).text)
  const register = (code: string, now?: number) => (gas.registerWithRegistry_ as (c: string, d?: object) => Record<string, unknown>)(code, now ? { now: () => now } : undefined)
  const login = (email: string, setupCode?: string) => post({ action: 'exchangeIdToken', idToken: email, nonceSecret: 'n', setupCode })
  const menu = (answer: string) => { promptAnswer = answer; (gas.registerWithRegistryFromMenu as () => void)() }
  return { gas, c, props, cache, logs, sent, mails, added, members, dialogs, post, register, login, menu, fetches: () => fetches, ownGets }
}
