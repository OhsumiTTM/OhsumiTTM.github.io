// 団体の GAS(gas/Code.gs)の R1-c: レジストリへの登録(registerWithRegistry)と、初期設定コードで
// 最初の代表が団体に入ること(exchangeIdToken の setupCode)を確かめる。
// レジストリへの通信は、テストの中でレジストリのコード(registry/Code.gs)につなぐ
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { setup as setupRegistry, type TokenInfo } from './registry-harness'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const REGISTRY_URL = 'https://script.google.com/macros/s/REGISTRY/exec'
const ORG_URL = 'https://script.google.com/macros/s/ORGGAS/exec'
const ROLES = JSON.stringify([{ id: 'base', name: '一般', tier: 'base' }, { id: 'top', name: '代表', tier: 'top' }])
const HOUR = 3600 * 1000

// レジストリ(管理者のログインまで済ませ、登録コードを発行できる)
function registry() {
  const CLIENT = 'registry-client'
  const nonce = 'registry-admin.' + createHash('sha256').update('nonce-secret-a1-0123456789').digest('base64url')
  const tokens: Record<string, TokenInfo> = {
    'hdr.a1.sig': { aud: CLIENT, iss: 'https://accounts.google.com', email: 'admin@example.com', email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600), iat: String(Math.floor(Date.now() / 1000)), nonce },
  }
  const r = setupRegistry({ props: { ADMIN_EMAILS: 'admin@example.com', OAUTH_CLIENT_ID: CLIENT }, tokeninfo: tokens })
  r.gas.setupRegistry()
  const session = r.post({ action: 'adminLogin', idToken: 'hdr.a1.sig', nonceSecret: 'nonce-secret-a1-0123456789' }).result.session.token
  const issue = (extra: Record<string, unknown> = {}) => r.post({ action: 'issueRegistrationCode', session, orgName: '新しい団体', ...extra }).result
  return { ...r, issue }
}

type Reg = ReturnType<typeof registry>

// レジストリの Secrets に保存した共有鍵(先頭の ' は、シートが文字として扱う印なので除く)
const storedKey = (reg: Reg) => String(reg.sheets.get('Secrets')!.rows[1][1]).replace(/^'/, '')

function org(reg: Reg, opts: { members?: string[][]; lose?: number[]; props?: Record<string, string>; emails?: Record<string, string>; serviceUrl?: string } = {}) {
  const props: Record<string, string> = { REGISTRY_URL, OHSUMI_WEBAPP_URL: ORG_URL, GOOGLE_OAUTH_CLIENT_ID: 'x', ...(opts.props ?? {}) }
  const cache = new Map<string, string>()
  const logs: string[] = []
  const sent: Record<string, unknown>[] = []
  const members: string[][] = opts.members ?? [['id', 'name', 'role']]
  const added: { id: string; name: string; email: string; role: string }[] = []
  let fetches = 0
  const dialogs: { title: string; text: string }[] = []
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
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v) }, getAll: () => ({}), putAll() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
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
      getUuid: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      formatDate: () => '2026/10/01 12:00',
    },
    // レジストリへの通信: レジストリの doPost につなぐ。lose に入れた回は、処理はされたが応答が失われたことにする
    UrlFetchApp: {
      fetch: (url: string, o: { payload: string }) => {
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
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown>
  const post = (body: object) => JSON.parse((gas.doPost as (e: object) => { text: string })({ postData: { contents: JSON.stringify(body) } }).text)
  const register = (code: string, now?: number) => (gas.registerWithRegistry_ as (c: string, d?: object) => Record<string, unknown>)(code, now ? { now: () => now } : undefined)
  const login = (email: string, setupCode?: string) => post({ action: 'exchangeIdToken', idToken: email, nonceSecret: 'n', setupCode })
  const menu = (answer: string) => { promptAnswer = answer; (gas.registerWithRegistryFromMenu as () => void)() }
  return { gas, c, props, logs, sent, added, members, dialogs, post, register, login, menu, fetches: () => fetches }
}

describe('レジストリへの登録(団体の GAS)', () => {
  it('登録コードで登録し、共有鍵をスクリプトプロパティに保存する。代表がいなければ初期設定コードを作る', () => {
    const reg = registry()
    const o = org(reg)
    const code = reg.issue().code
    const out = o.register(code)
    expect(out).toMatchObject({ displayName: '新しい団体', keyGen: 1, kind: 'new' })
    expect(out.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    // 通信は1回
    expect(o.fetches()).toBe(1)
    // レジストリに登録された(団体ID・接続先)
    const orgRow = reg.sheets.get('Orgs')!.rows[1]
    expect(orgRow.slice(0, 2)).toEqual([o.props.ORG_ID, ORG_URL])
    // 共有鍵は団体の GAS のスクリプトプロパティに保存する(レジストリと同じ値)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
    expect(o.props.REGISTRY_PENDING).toBeUndefined()
    // 初期設定コードはハッシュだけを保存する(72時間)
    expect(o.props.INITIAL_SETUP_HASH).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Number(o.props.INITIAL_SETUP_EXPIRES) - Date.now()).toBeGreaterThan(71 * HOUR)
    expect(Number(o.props.INITIAL_SETUP_EXPIRES) - Date.now()).toBeLessThanOrEqual(72 * HOUR + 1000)
  })

  it('応答が失われても、同じ registerNonce で送り直し、同じ共有鍵を受け取る(二重に登録しない)', () => {
    const reg = registry()
    const o = org(reg, { lose: [1] })
    const out = o.register(reg.issue().code)
    expect(out.keyGen).toBe(1)
    expect(o.sent).toHaveLength(2)
    expect(o.sent[1].registerNonce).toBe(o.sent[0].registerNonce)
    // registerNonce は32バイトの乱数(base64url の43文字)
    expect(String(o.sent[0].registerNonce)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(1)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
  })

  it('3回とも応答が失われた後、メニューからやり直しても(同じ登録コード)、「使用済み」で失敗せず同じ結果になる', () => {
    const reg = registry()
    const o = org(reg, { lose: [1, 2, 3] })
    const code = reg.issue().code
    expect(() => o.register(code)).toThrow(/応答を受け取れませんでした[\s\S]*二重には登録されません/)
    expect(o.props.REGISTRY_SHARED_KEY).toBeUndefined()
    // 送る前にスクリプトプロパティに保存してある
    expect(JSON.parse(o.props.REGISTRY_PENDING).registerNonce).toBe(o.sent[0].registerNonce)
    const out = o.register(code)
    expect(out.keyGen).toBe(1)
    expect(new Set(o.sent.map((s) => s.registerNonce)).size).toBe(1)
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(1)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
  })

  it('使えない登録コードは、レジストリの理由をそのまま知らせる', () => {
    const reg = registry()
    const o = org(reg)
    expect(() => o.register('AAAA-BBBB-CCCC-DDDD')).toThrow(/使えなくなっています/)
    expect(o.props.REGISTRY_SHARED_KEY).toBeUndefined()
  })

  it('レジストリの URL・この GAS の URL が無い・形が違う時は、設定のしかたを知らせる', () => {
    const reg = registry()
    expect(() => org(reg, { props: { REGISTRY_URL: '' } }).register('AAAA')).toThrow(/REGISTRY_URL/)
    expect(() => org(reg, { props: { OHSUMI_WEBAPP_URL: 'https://script.google.com/macros/s/X/dev' } }).register('AAAA')).toThrow(/OHSUMI_WEBAPP_URL/)
  })

  it('この GAS の URL が /dev・/u/1/・/a/macros/<ドメイン>/・? 付きの時は、レジストリに送る前に断る', () => {
    const reg = registry()
    const cases: [string, RegExp][] = [
      ['https://script.google.com/macros/s/ORGGAS/dev', /\/dev はエディタで試すための URL/],
      ['https://script.google.com/macros/u/1/s/ORGGAS/exec', /\/u\/1\/ などは、複数の Google アカウント/],
      ['https://script.google.com/macros/u/0/s/ORGGAS/dev', /レジストリに登録できない形/],
      ['https://script.google.com/a/macros/example.org/s/ORGGAS/exec', /Google Workspace のドメインの中だけ/],
      ['https://script.google.com/macros/s/ORGGAS/exec?v=1', /\? や # の後ろは付けません/],
      ['https://script.google.com/macros/s/ORGGAS/exec/', /レジストリに登録できない形/],
    ]
    for (const [url, why] of cases) {
      // スクリプトプロパティに入れた時も、ScriptApp の URL を使う時も
      for (const o of [org(reg, { props: { OHSUMI_WEBAPP_URL: url } }), org(reg, { props: { OHSUMI_WEBAPP_URL: '' }, serviceUrl: url })]) {
        const code = reg.issue().code
        expect(() => o.register(code), url).toThrow(why)
        expect(o.fetches(), url).toBe(0)
        expect(o.props.REGISTRY_PENDING, url).toBeUndefined()
      }
    }
    expect(reg.sheets.get('Orgs')!.rows.slice(1)).toHaveLength(0)
  })

  it('メニューでは、登録する URL を送る前に表示する。URL の形が違えば、コードを聞かずに止める', () => {
    const reg = registry()
    const o = org(reg)
    o.menu(reg.issue().code)
    expect(o.dialogs[0].text).toContain(ORG_URL)
    expect(o.dialogs[1].title).toBe('登録しました')
    // 招待リンクの作り方(団体ID)も出す
    expect(o.dialogs[1].text).toContain('/?org=' + o.props.ORG_ID)
    const bad = org(reg, { props: { OHSUMI_WEBAPP_URL: 'https://script.google.com/macros/s/ORGGAS/dev' } })
    bad.menu(reg.issue().code)
    expect(bad.dialogs).toHaveLength(1)
    expect(bad.dialogs[0]).toMatchObject({ title: '登録できませんでした' })
    expect(bad.fetches()).toBe(0)
  })

  it('再登録コードで、新しい共有鍵に入れ替わる(代表がいれば初期設定コードは作らない)', () => {
    const reg = registry()
    const o = org(reg, { members: [['id', 'name', 'role'], ['1', '代表', 'top']] })
    const first = o.register(reg.issue().code)
    expect(first.setupCode).toBeUndefined()
    const key1 = o.props.REGISTRY_SHARED_KEY
    const re = reg.issue({ kind: 'reissue', targetOrgId: o.props.ORG_ID })
    const second = o.register(re.code)
    expect(second).toMatchObject({ kind: 'reissue', keyGen: 2 })
    expect(o.props.REGISTRY_SHARED_KEY).not.toBe(key1)
    expect(o.props.REGISTRY_SHARED_KEY).toBe(storedKey(reg))
  })
})

describe('初期設定コードで最初の代表が入る', () => {
  const started = () => {
    const reg = registry()
    const o = org(reg)
    const out = o.register(reg.issue().code)
    return { reg, o, setupCode: String(out.setupCode) }
  }

  it('未登録のアカウントが初期設定コードを付けてログインすると、代表として登録され、そのままログインできる(通信1回)', () => {
    const { o, setupCode } = started()
    const res = o.login('first@example.org', setupCode.toLowerCase())
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result.session.token).toBe('session-100')
    expect(o.added).toEqual([{ id: '100', name: 'first', email: 'first@example.org', role: 'top' }])
    expect(o.props.INITIAL_SETUP_HASH).toBeUndefined()
  })

  it('初期設定コードは1回だけ使える', () => {
    const { o, setupCode } = started()
    expect(o.login('first@example.org', setupCode).ok).toBe(true)
    const second = o.login('second@example.org', setupCode)
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/使えなくなっています/)
    expect(o.added).toHaveLength(1)
  })

  it('72時間を過ぎたら使えない', () => {
    const reg = registry()
    const o = org(reg)
    const out = o.register(reg.issue().code, Date.now() - 73 * HOUR)
    const res = o.login('first@example.org', String(out.setupCode))
    expect(res.ok).toBe(false)
    expect(o.added).toEqual([])
  })

  it('コードの間違いが10回続いたら、正しいコードも使えなくなる(メニューで作り直す)', () => {
    const { o, setupCode } = started()
    for (let i = 0; i < 9; i++) expect(o.login('x@example.org', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ').error).toMatch(/正しくない/)
    expect(o.login('x@example.org', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ').error).toMatch(/間違いが続いた/)
    expect(o.login('first@example.org', setupCode).ok).toBe(false)
    expect(o.added).toEqual([])
  })

  it('既に代表がいる団体では使えない', () => {
    const { o, setupCode } = started()
    o.members.push(['9', '代表', 'top'])
    expect(o.login('first@example.org', setupCode).error).toMatch(/既に代表がいます/)
    expect(o.added).toEqual([])
  })

  it('初期設定コードを付けないログインは、これまでどおり「登録されていない」を返す', () => {
    const { o } = started()
    expect(o.login('someone@example.org').result).toEqual({ memberId: null, email: 'someone@example.org' })
  })
})

describe('すでにメンバーと代表がいる団体の登録', () => {
  // 動いている団体: 代表・メンバーがいて、ログインの設定(団体ID・署名鍵・ログアウトの世代)がある
  const running = () => {
    const reg = registry()
    const before: Record<string, string> = {
      ORG_ID: 'org_RUNNINGRUNNINGRUN1', SESSION_SIGNING_KEY: 'signing-key-existing', SESSION_KEY_ID: 'kid00001', SESSION_GEN_m2: '3',
    }
    const members = [['id', 'name', 'role'], ['m1', '代表さん', '代表'], ['m2', 'メンバー', 'base']]
    const o = org(reg, { members, props: before, emails: { 'daihyo@example.org': 'm1', 'member@example.org': 'm2' } })
    return { reg, o, before, members: members.map((r) => r.slice()) }
  }

  it('登録しても、初期設定コードは作らず、団体ID・ログインの鍵・メンバーは変わらない', () => {
    const { reg, o, before, members } = running()
    const out = o.register(reg.issue().code)
    expect(out.setupCode).toBeUndefined()
    expect(Object.keys(o.props).filter((k) => k.startsWith('INITIAL_SETUP_'))).toEqual([])
    for (const [k, v] of Object.entries(before)) expect(o.props[k], k).toBe(v)
    expect(o.members).toEqual(members)
    expect(o.added).toEqual([])
    // レジストリには、今の団体ID で登録される
    expect(reg.sheets.get('Orgs')!.rows[1].slice(0, 2)).toEqual([before.ORG_ID, ORG_URL])
    // 登録で増えるスクリプトプロパティは、共有鍵まわりだけ
    expect(Object.keys(o.props).filter((k) => !(k in before)).sort()).toEqual(
      ['GOOGLE_OAUTH_CLIENT_ID', 'OHSUMI_WEBAPP_URL', 'REGISTRY_KEY_GEN', 'REGISTRY_REGISTERED_AT', 'REGISTRY_SHARED_KEY', 'REGISTRY_URL'])
  })

  it('今の代表・メンバーは、これまでどおりログインできる(初期設定コードを付けて来ても、代表にならず今のメンバーのまま)', () => {
    const { reg, o } = running()
    o.register(reg.issue().code)
    expect(o.login('daihyo@example.org').result.session.token).toBe('session-m1')
    expect(o.login('member@example.org').result.session.token).toBe('session-m2')
    expect(o.login('member@example.org', 'AAAA-BBBB-CCCC-DDDD').result.session.token).toBe('session-m2')
    expect(o.added).toEqual([])
  })

  it('メンバーでない人が初期設定コードらしきものを付けて来ても、団体に入れない(コードが作られていない)', () => {
    const { reg, o, members } = running()
    o.register(reg.issue().code)
    const res = o.login('stranger@example.org', 'AAAA-BBBB-CCCC-DDDD')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/使えなくなっています/)
    expect(o.members).toEqual(members)
    expect(o.login('stranger@example.org').result).toEqual({ memberId: null, email: 'stranger@example.org' })
  })

  it('「初期設定コードを作り直す」も、代表がいる団体では作らない', () => {
    const { reg, o } = running()
    o.register(reg.issue().code)
    ;(o.gas.regenerateInitialSetupCodeFromMenu as () => void)()
    expect(o.dialogs.at(-1)!.text).toMatch(/既に代表がいます/)
    expect(Object.keys(o.props).filter((k) => k.startsWith('INITIAL_SETUP_'))).toEqual([])
  })
})

describe('共有鍵・初期設定コードを残さない', () => {
  it('実行ログ・レジストリの操作の記録に、共有鍵・登録コード・初期設定コードが元の形で出ない', () => {
    const reg = registry()
    const o = org(reg)
    const code = reg.issue().code
    const out = o.register(code)
    o.login('first@example.org', String(out.setupCode))
    const secrets = [o.props.REGISTRY_SHARED_KEY, code, code.replace(/-/g, ''), String(out.setupCode), String(out.setupCode).replace(/-/g, '')]
    const places = {
      orgLogs: o.logs.join('\n'),
      registryLogs: reg.logs.join('\n'),
      audit: JSON.stringify(reg.sheets.get('AuditLog')!.rows),
      orgProps: JSON.stringify({ ...o.props, REGISTRY_SHARED_KEY: '' }),
    }
    for (const [where, text] of Object.entries(places)) for (const s of secrets) expect(text, where).not.toContain(s)
  })

  it('メニューの関数は、初期設定コードをダイアログにだけ出す(実行ログには出さない)', () => {
    const src = CODE_GS.slice(CODE_GS.indexOf('function registerWithRegistryFromMenu('), CODE_GS.indexOf('\nfunction ', CODE_GS.indexOf('function regenerateInitialSetupCodeFromMenu(') + 10))
    expect(src).toContain('ui.alert(')
    expect(src).not.toMatch(/console\.|Logger\./)
  })
})
