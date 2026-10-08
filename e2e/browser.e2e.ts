// 公開前の通しテスト(画面の部分): ビルドした画面(out/)をヘッドレスの Chrome で開き、画面からの通信を
// この世界の団体の GAS・レジストリ(lib/ohsumi/e2e/world.ts。本物の gas/Code.gs・registry/Code.gs)につなぐ。
// Google のログインのボタンは、画面が Google に渡す設定(nonce)を使って、ID トークンを受け取ったことにする。
//   pnpm test:e2e            … ビルドしてから確かめる
//   E2E_SKIP_BUILD=1 pnpm test:e2e … 前のビルド(out/。check:layout と同じ設定)を使う
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorld, fakeIdToken, type Org, type World } from '../lib/ohsumi/e2e/world'
import { diffList } from '../lib/ohsumi/list-diff'
import { CAPABILITY_ACTIONS, CAPABILITY_KEYS, capabilityOfAction, TOP_ONLY_ACTIONS, type Capability } from '../lib/ohsumi/capabilities'

const ROOT = join(__dirname, '..')
// ビルドの設定(scripts/check-layout.mjs と同じ。GAS の接続先はレジストリの接続先の解決で決まる)
const BUILD_REGISTRY_URL = 'https://script.google.com/macros/s/LAYOUT_REGISTRY/exec'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function build() {
  if (process.env.E2E_SKIP_BUILD && existsSync(join(ROOT, 'out', 'index.html'))) return
  const env = { ...process.env, NEXT_PUBLIC_GAS_URL: '', NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: '000000000000-layout.apps.googleusercontent.com',
    NEXT_PUBLIC_REGISTRY_URL: BUILD_REGISTRY_URL, NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID: '000000000000-registry.apps.googleusercontent.com' }
  const b = spawnSync('pnpm', ['exec', 'next', 'build'], { cwd: ROOT, env, stdio: 'inherit' })
  if (b.status !== 0) throw new Error('ビルドに失敗しました')
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' }
function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    let file = join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) && existsSync(file + '.html')) file += '.html'
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': MIME['.html'] }); res.end(readFileSync(join(dir, '404.html'))); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function findChrome(): string | null {
  const c = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean) as string[]
  for (const p of c) if (existsSync(p)) return p
  try { return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim() || null } catch { return null }
}

// Chrome の操作の窓口(DevTools Protocol)
class Page {
  private id = 0
  private waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>()
  listeners: ((m: { method: string; params: Record<string, unknown> }) => void)[] = []
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data))
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id) } else if (m.method) this.listeners.forEach((l) => l(m))
    }
  }
  send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise<{ result?: unknown; error?: unknown }>((r) => this.waiting.set(id, r))
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const res = r.result as { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }
    if (res.exceptionDetails) throw new Error('画面の中で失敗しました: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text))
    return res.result?.value as T
  }
}

let world: World
let topTokenA = ''
// true の間、団体の GAS の応答から「できる操作」と URL を消す(古い GAS の団体のふり)
let oldGasMode = false
let A: ReturnType<World['launchOrg']>
let B: ReturnType<World['launchOrg']>
let server: Server
let chrome: ChildProcess
let page: Page
let base = ''
const available = !!findChrome()

// 世界の準備: 団体A(代表・一般を登録済み)と団体B
function prepareWorld() {
  world = createWorld()
  A = world.launchOrg('団体A', 'contact@a.example')
  B = world.launchOrg('団体B', 'contact@b.example')
  const topA = world.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode }).result.session.token
  topTokenA = topA
  world.call(A.org, topA, 'addMember', { name: '一般さん', email: 'base@a.example', affiliation: '', role: 'base', sendInvite: false })
  const topId = world.googleLogin(A.org, 'top@a.example').result.memberId
  world.call(A.org, topA, 'createTasks', { tasks: [{ tempId: 't1', title: '団体Aのタスク', projectId: '', department: '', category: '', skills: [], difficulty: 'normal', priority: 'medium', deadline: null, assigneeIds: [topId], creatorId: topId }] })
  world.googleLogin(B.org, 'top@b.example', { setupCode: B.setupCode })
  // 以前の計算で保存されたレベル: 100点で Lv.2(新しい計算では Lv.1)。画面では Lv.2 のまま出す(PR Z)
  const members = A.org.sheets.Members.rows
  const head = members[0].map(String)
  const top = members.find((r) => String(r[head.indexOf('id')]) === topId)!
  top[head.indexOf('skill_levels_json')] = JSON.stringify([{ skill: 'デザイン', level: 2, acquiredAt: '2026-01-01' }])
  top[head.indexOf('skill_points_json')] = JSON.stringify({ デザイン: 100 })
  A.org.cache.clear()
}

const orgByUrl = (url: string): Org | null => [...world.orgs.values()].find((o) => url.startsWith(o.gasUrl)) ?? null

async function openBrowser() {
  const port = 9800 + Math.floor(Math.random() * 100)
  chrome = spawn(findChrome()!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
  let targets: { type: string; webSocketDebuggerUrl: string }[] = []
  for (let i = 0; i < 150 && !targets.some((t) => t.type === 'page'); i++) {
    await sleep(200)
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { /* 起動中 */ }
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  page = new Page(ws)
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  page.listeners.push((m) => {
    if (m.method !== 'Fetch.requestPaused') return
    const { requestId, request } = m.params as { requestId: string; request: { url: string; postData?: string } }
    if (request.url.startsWith(base)) { void page.send('Fetch.continueRequest', { requestId }); return }
    const fulfill = (type: string, body: string) => page.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: b64(body),
      responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }] })
    if (request.url.startsWith(BUILD_REGISTRY_URL)) { void fulfill('application/json', JSON.stringify(world.reg.post(request.postData ?? '{}'))); return }
    const org = orgByUrl(request.url)
    if (org) {
      const out = org.postRaw(JSON.parse(request.postData || '{}'))
      // 古い GAS のふり: 起動時のデータに「できる操作」と URL を入れない
      if (oldGasMode && out?.result && typeof out.result === 'object') { delete out.result.capabilities; delete out.result.adminLinks }
      void fulfill('application/json', JSON.stringify(out)); return
    }
    // Google のログインのスクリプト: 画面が渡した設定(コールバック・nonce)を覚えるだけの偽物
    if (request.url.startsWith('https://accounts.google.com/gsi/client')) {
      void fulfill('text/javascript', 'window.google={accounts:{id:{initialize(c){window.__gsiConfig=c},renderButton(e){e.setAttribute("data-e2e-gsi","1")},prompt(){},disableAutoSelect(){},cancel(){}},oauth2:{initTokenClient(){return{requestAccessToken(){}}}}}}')
      return
    }
    void page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
  })
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
}

const navigate = async (path: string) => { await page.send('Page.navigate', { url: base + path }); await sleep(2500) }
const text = () => page.evaluate<string>("document.body?.innerText ?? ''")
// 隠れている要素(閉じた知らせ・メニュー)も含めた文字。データが漏れていないかは、こちらで確かめる
const allText = () => page.evaluate<string>("document.body?.textContent ?? ''")
const waitFor = async (fn: () => Promise<boolean>, what: string, ms = 10000) => {
  for (let t = 0; t < ms; t += 250) { if (await fn()) return; await sleep(250) }
  throw new Error(what + '(' + ms / 1000 + '秒待ちました)。画面: ' + (await text()).slice(0, 300))
}
// Google のボタンで email のアカウントを選んだことにする(nonce は画面が Google に渡したもの)
const googleSignIn = async (email: string) => {
  await waitFor(() => page.evaluate<boolean>('!!window.__gsiConfig'), 'Google のログインが準備されません')
  const nonce = await page.evaluate<string>('window.__gsiConfig.nonce')
  await page.evaluate(`window.__gsiConfig.callback({ credential: ${JSON.stringify(fakeIdToken({ email, nonce }))} })`)
}
// ログインした後の画面(初めてのログインは「ようこそ」の画面を「あとで設定する」で閉じる)
const loggedIn = () => page.evaluate<boolean>(`(() => {
  const later = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'あとで設定する')
  if (later) later.click()
  // ログアウトなどで読み込み直している途中は body が無いことがある
  return !!document.body && document.body.innerText.includes('OUTPUT') && !document.querySelector('[data-e2e-gsi]')
})()`)
const clearDevice = () => page.evaluate('localStorage.clear(); sessionStorage.clear(); true')
// 1件1行のシート(TaskRecords・MemberRecords。新しい団体は最初から)の、親の1つの一覧(順番どおり)
const recordList = (org: Org, sheet: 'TaskRecords' | 'MemberRecords', parentId: string, kind: string) => {
  const [head, ...rows] = (org.sheets[sheet]?.rows ?? [[]]).map((r) => r.map(String))
  const col = (n: string) => head.indexOf(n)
  return rows.filter((r) => r[col(sheet === 'TaskRecords' ? 'task_id' : 'member_id')] === parentId && r[col('kind')] === kind)
    .sort((a, b) => Number(a[col('seq')]) - Number(b[col('seq')])).map((r) => JSON.parse(r[col('body_json')]))
}

beforeAll(async () => {
  if (!available) return
  build()
  prepareWorld()
  server = await serve(join(ROOT, 'out'))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await openBrowser()
})

afterAll(() => {
  chrome?.kill()
  server?.close()
})

describe.skipIf(!available)('公開前の通しテスト(画面)', () => {
  it('未ログイン: 招待リンク(?org=)で開くと、その団体のログイン画面になり、団体のデータは出ない', async () => {
    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-e2e-gsi]")'), 'ログインのボタンが出ません')
    expect(await allText()).not.toContain('団体Aのタスク')
    expect(await page.evaluate('localStorage.getItem("ohsumi-current-org")')).toBe(A.orgId)
  })

  it('ログイン: 登録されていないアカウントは入れず、登録されたアカウント(代表)は入れる。管理の画面に入れる', async () => {
    await googleSignIn('stranger@example.com')
    await waitFor(async () => (await text()).includes('stranger@example.com'), '登録されていないアカウントの知らせが出ません')
    expect(await loggedIn()).toBe(false)
    await navigate('/?org=' + A.orgId)
    await googleSignIn('top@a.example')
    await waitFor(loggedIn, '代表がログインできません')
    // 団体のデータ(代表あての承認依頼の知らせに、団体Aのタスク)が届き、管理の画面(ADMIN)が出る
    await waitFor(async () => (await allText()).includes('団体Aのタスク'), '団体のデータが出ません')
    await waitFor(async () => (await text()).includes('ADMIN'), '代表に管理の画面(ADMIN)が出ません')
  })

  it('スキルのレベル: 以前の計算で保存されたレベル(100点で Lv.2)は、そのまま出す。次のレベルまでの進み具合は負にならない', async () => {
    await page.evaluate(`document.querySelector('[data-account-menu]').click(); true`)
    const profileItem = `[...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.trim() === 'プロフィール')`
    await waitFor(() => page.evaluate<boolean>(`!!${profileItem}`), 'アカウントのメニューが開きません')
    await page.evaluate(`${profileItem}.click(); true`)
    const careerTab = `[...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent.trim() === '経歴・キャリア')`
    await waitFor(() => page.evaluate<boolean>(`!!${careerTab}`), '個人ページが開きません')
    await page.evaluate(`${careerTab}.click(); true`)
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-skill-progress="デザイン"]')`), 'スキルの進み具合が出ません')
    const shown = await page.evaluate<{ level: string; ratio: string; remaining: string; text: string; bar: string }>(`(() => {
      const p = document.querySelector('[data-skill-progress="デザイン"]')
      const row = p.closest('li')
      return { level: row.querySelector('[data-skill-level]').getAttribute('data-skill-level'), ratio: p.getAttribute('data-ratio'),
        remaining: p.getAttribute('data-remaining'), text: row.textContent, bar: p.querySelector('[aria-hidden] span')?.style.width ?? '' }
    })()`)
    expect(shown.level).toBe('2')
    expect(shown.text).toContain('Lv.2')
    expect(shown.ratio).toBe('0.000')
    expect(shown.remaining).toBe('250')
    expect(shown.bar).toBe('0%')
    expect(shown.text).toContain('次の Lv.3 まで あと 250 点(累計 100 / 350 点)')
    expect(shown.text).not.toMatch(/-\d|NaN|Infinity|Lv\.1/)
  })

  it('ログアウト: ログイン画面に戻り、読み込み直してもログインしたままにならない', async () => {
    // ヘッダーの右端(アカウント)のメニューを開いて「ログアウト」
    // メニューが開くまでの時間は、端末の混み具合で変わる(決まった時間を待たず、「ログアウト」が出るまで待つ)
    const logoutItem = `[...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.trim() === 'ログアウト')`
    await page.evaluate(`document.querySelector('[data-account-menu]').click(); true`)
    await waitFor(() => page.evaluate<boolean>(`!!${logoutItem}`), 'アカウントのメニューが開きません')
    await page.evaluate(`${logoutItem}.click(); true`)
    await waitFor(async () => !(await loggedIn()), 'ログアウトできません')
    // 読み込み直した後も団体のログイン画面のまま(?org= が残り、ホームページにならない)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-e2e-gsi]")'), 'ログアウトの後に団体のログイン画面になりません')
    expect(await page.evaluate<string>('location.search')).toContain('org=')
    expect(await page.evaluate(`localStorage.getItem('ohsumi-session-${A.orgId}')`)).toBeNull()
    await navigate('/?org=' + A.orgId)
    expect(await loggedIn()).toBe(false)
    expect(await allText()).not.toContain('団体Aのタスク')
  })

  it('一般のメンバー: ログインできるが、管理の画面(ADMIN)は出ない', async () => {
    await googleSignIn('base@a.example')
    await waitFor(loggedIn, '一般のメンバーがログインできません')
    expect(await text()).not.toContain('ADMIN')
  })

  it('団体の分離: 団体A にログインしたまま団体B の招待リンクを開くと、団体B のログイン画面になり、団体A のデータは出ない', async () => {
    await navigate('/?org=' + B.orgId)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-e2e-gsi]")'), '団体B のログイン画面になりません')
    expect(await allText()).not.toContain('団体Aのタスク')
    // 団体A のログインで団体B に入ろうとしても入れない(nonce が団体B のもの・団体B のメンバーではない)
    await googleSignIn('top@a.example')
    await sleep(2500)
    expect(await loggedIn()).toBe(false)
    expect(await allText()).not.toContain('団体Aのタスク')
  })

  it('トップ: 団体コード(?org=)が無ければホームページ、ログインから Ohsumi の画面に入れる', async () => {
    await navigate('/')
    await waitFor(() => page.evaluate<boolean>("(document.body?.innerText ?? '').includes('仕事を進めるほど')"), 'ホームページが出ません')
    expect(await page.evaluate<boolean>('!!document.querySelector("[data-e2e-gsi]")')).toBe(false)
    expect(await allText()).not.toContain('団体Aのタスク')
    await navigate('/?login=1')
    await waitFor(() => page.evaluate<boolean>("!(document.body?.innerText ?? '').includes('仕事を進めるほど')"), 'ログインから Ohsumi の画面になりません')
  })

  it('URL の直打ち: 公開のページは開け、無いページは 404、知らない団体は「見つかりません」、レジストリの管理画面はログインが要る', async () => {
    for (const path of ['/about/', '/terms/', '/privacy/']) {
      await navigate(path)
      expect((await text()).length, path).toBeGreaterThan(50)
    }
    for (const path of ['/admin', '/members', '/settings/', '/api/tasks']) {
      await navigate(path)
      const t = await text()
      expect(await allText(), path).not.toContain('団体Aのタスク')
      expect(t, path).toMatch(/404|見つかりません|not be found/i)
    }
    await clearDevice()
    await navigate('/?org=org_UNKNOWNUNKNOWNUNKNOWN')
    await waitFor(async () => /見つかりません/.test(await text()), '知らない団体の知らせが出ません')
    await navigate('/registry-admin/')
    await waitFor(async () => (await text()).includes('許可された管理者だけが使えます'), 'レジストリの管理画面のログインが出ません')
    expect(await text()).not.toContain('団体A')
  })
})

// ---- できる操作(capability): 5人の役職で ADMIN の全タブを開き、出ている操作が GAS で通ること・
// 出ていない操作は GAS でも断られることを確かめる(lib/ohsumi/capabilities.ts の対応表) ----

type Persona = { email: string; label: string; caps: Capability[]; admin: boolean }
const ALL_CAPS = [...CAPABILITY_KEYS]
const PERSONAS: Persona[] = [
  { email: 'top@a.example', label: '代表', caps: ALL_CAPS, admin: true },
  { email: 'full@a.example', label: '全権管理者(制限なし・既定)', caps: ['trash', 'org.rules'], admin: true },
  { email: 'lead@a.example', label: '制限ありの管理者', caps: [], admin: true },
  { email: 'base@a.example', label: '一般', caps: [], admin: false },
  { email: 'hr@a.example', label: 'members.role を渡した管理者', caps: ['members.role', 'trash', 'org.rules'], admin: true },
]

// 制限ありの役職・members.role を渡した役職を足し、それぞれの人を登録する(代表の操作で)
function preparePersonas() {
  const gas = A.org.gas as unknown as Record<string, (...a: unknown[]) => unknown>
  gas.invalidateRoles_()
  const roles = JSON.parse(JSON.stringify(gas.getRoles_())) as { id: string; tier: string }[]
  const topIndex = roles.findIndex((r) => r.tier === 'top')
  roles.splice(topIndex, 0,
    { id: 'r_lead_e2e', name: '班長(制限あり)', tier: 'admin', restricted: true } as never,
    { id: 'r_hr_e2e', name: '人事', tier: 'admin', restricted: false, capabilities: ['members.role', 'org.rules', 'trash'] } as never)
  const saved = world.call(A.org, topTokenA, 'updateRoles', { roles })
  if (!saved.ok) throw new Error('役職を保存できません: ' + saved.error)
  const manager = roles.find((r) => r.tier === 'admin' && (r as { restricted?: boolean }).restricted === false && r.id !== 'r_hr_e2e')!.id
  for (const [name, email, role] of [['全権さん', 'full@a.example', manager], ['班長さん', 'lead@a.example', 'r_lead_e2e'], ['人事さん', 'hr@a.example', 'r_hr_e2e']]) {
    const added = world.call(A.org, topTokenA, 'addMember', { name, email, affiliation: '', role, sendInvite: false })
    if (!added.ok) throw new Error('メンバーを登録できません: ' + added.error)
  }
  A.org.cache.clear()
}

const memberIdOf = (email: string) => String(world.googleLogin(A.org, email).result.memberId)

// GAS の判定(authorizeAction_)だけを、その人として確かめる(操作は実行しない)
function gasAllows(email: string, action: string, body: Record<string, unknown>): boolean {
  const gas = A.org.gas as unknown as Record<string, (...a: unknown[]) => unknown>
  gas.invalidateRoles_()
  try {
    gas.authorizeAction_(gas.getActingMemberById_(memberIdOf(email)), action, body)
    return true
  } catch {
    return false
  }
}

type Shown = { action: string; memberId: string | null; options: string[] }
// 今のタブに出ている(見えていて押せる)data-gas-action の部品
const shownActions = () => page.evaluate<Shown[]>(`(() => {
  const out = []
  for (const el of document.querySelectorAll('[data-gas-action]')) {
    if (!el.getClientRects().length) continue
    if (el.disabled || el.closest('fieldset[disabled]')) continue
    const options = el.tagName === 'SELECT' ? [...el.options].filter((o) => !o.disabled).map((o) => o.value) : []
    out.push({ action: el.getAttribute('data-gas-action'), memberId: el.getAttribute('data-member-id'), options })
  }
  return out
})()`)

describe.skipIf(!available)('できる操作(capability): 5人の役職で ADMIN の全タブ', () => {
  const genericBody = (personaEmail: string) => {
    const base = memberIdOf('base@a.example')
    const other = personaEmail === 'base@a.example' ? memberIdOf('full@a.example') : base
    return { memberId: other, projectId: 'p-e2e', taskId: 't-e2e', candidateId: 'c-e2e', name: 'E2E', email: 'e2e@example.com' }
  }

  it('GAS がログインした人に渡すできる操作が、役職の設定どおり', () => {
    preparePersonas()
    for (const p of PERSONAS) {
      const login = world.googleLogin(A.org, p.email)
      expect(login.ok, p.label + ': ' + JSON.stringify(login).slice(0, 200)).toBe(true)
      expect(login.result.capabilities, p.label).toEqual(p.caps)
    }
  })

  it.each(PERSONAS)('$label: 出ている操作はすべて GAS で通り、出ていない操作は GAS でも断られる', async (p) => {
    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await googleSignIn(p.email)
    await waitFor(loggedIn, p.label + ' がログインできません')
    const seen: Shown[] = []
    if (p.admin) {
      await waitFor(async () => (await text()).includes('ADMIN'), p.label + ' に ADMIN が出ません')
      await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('ADMIN')).click(); true`)
      await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-admin-tab]")'), p.label + ' の ADMIN のタブが出ません')
      const tabs = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-admin-tab]')].map((b) => b.getAttribute('data-admin-tab'))`)
      expect(tabs.length, p.label).toBeGreaterThan(0)
      // 団体設定のタブは、団体のルール・ロゴを変えられる人と代表だけ
      expect(tabs.includes('orgSettings'), p.label + ' の団体設定のタブ').toBe(p.caps.includes('org.rules') || p.caps.includes('org.logo'))
      for (const tab of tabs) {
        await page.evaluate(`document.querySelector('[data-admin-tab="${tab}"]').click(); true`)
        await sleep(700)
        seen.push(...(await shownActions()))
      }
    } else {
      expect(await text()).not.toContain('ADMIN')
    }
    const body = genericBody(p.email)
    // 出ている操作: そのまとまりを持っていて、GAS で通る
    for (const s of seen) {
      const cap = capabilityOfAction(s.action)
      if (cap) expect(p.caps, `${p.label}: ${s.action} が出ている`).toContain(cap)
      else expect((TOP_ONLY_ACTIONS as readonly string[]).includes(s.action) && p.caps.length === ALL_CAPS.length, `${p.label}: ${s.action}`).toBe(true)
      if (s.action === 'updateRole') {
        expect(s.memberId, 'updateRole の部品にはメンバーの ID').toBeTruthy()
        for (const role of s.options) expect(gasAllows(p.email, 'updateRole', { memberId: s.memberId, role }), `${p.label}: ${s.memberId} を ${role} に`).toBe(true)
      } else {
        expect(gasAllows(p.email, s.action, body), `${p.label}: ${s.action}`).toBe(true)
      }
    }
    // 出ていない操作: 持っていないまとまりの操作は、部品が無く、GAS でも断られる
    for (const cap of CAPABILITY_KEYS.filter((c) => !p.caps.includes(c))) {
      for (const action of CAPABILITY_ACTIONS[cap]) {
        expect(seen.some((s) => s.action === action), `${p.label}: ${action} の部品が出ている`).toBe(false)
        expect(gasAllows(p.email, action, body), `${p.label}: ${action} が GAS で通ってしまう`).toBe(false)
      }
    }
    // 渡せない操作(代表だけ)は、代表でなければ GAS で断られる
    if (p.caps.length !== ALL_CAPS.length) {
      for (const action of [...TOP_ONLY_ACTIONS, 'listBackups', 'restoreBackup', 'purgePersonalDataNow', 'getUsageStatus', 'getMetricsStatus', 'getDiagnostics']) {
        expect(gasAllows(p.email, action, body), `${p.label}: ${action}`).toBe(false)
      }
    }
    // 空振りでないこと: できる人には、その操作の部品が実際に出ている
    const shownSet = new Set(seen.map((x) => x.action))
    if (p.caps.includes('org.rules')) expect(shownSet.has('updateSetting'), p.label + ': 団体の設定の部品').toBe(true)
    if (p.caps.includes('members.add')) expect(shownSet.has('addMember'), p.label + ': メンバーの登録').toBe(true)
    if (p.caps.includes('members.remove')) expect(shownSet.has('removeMember'), p.label + ': 退会').toBe(true)
    if (p.caps.includes('members.hr')) expect(shownSet.has('updateReportsTo'), p.label + ': 報告先').toBe(true)
    if (p.caps.includes('trash')) expect(shownSet.has('updateRoles') || shownSet.has('updateSetting'), p.label).toBe(true)
    // members.role を渡した管理者: 役職の選択が出ていて、選べる役職だけが並ぶ(最上位・自分・代表の行は選べない)
    if (p.email === 'hr@a.example') {
      const selects = seen.filter((s) => s.action === 'updateRole')
      expect(selects.length).toBeGreaterThan(0)
      expect(selects.some((s) => s.memberId === memberIdOf('top@a.example')), '代表の役職の選択').toBe(false)
      expect(selects.some((s) => s.memberId === memberIdOf('hr@a.example')), '自分の役職の選択').toBe(false)
      for (const s of selects) expect(s.options, '最上位の役職を選べない').not.toContain('top')
    }
  })
})

// ---- 古い GAS(できる操作を送らない)の団体・最上位が2つある団体でも、最上位の人が何もできなくならない ----
describe.skipIf(!available)('最上位の役職の人(古い GAS・最上位が2つ)', () => {
  const openAdminAs = async (email: string) => {
    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await googleSignIn(email)
    await waitFor(loggedIn, email + ' がログインできません')
    await waitFor(async () => (await text()).includes('ADMIN'), email + ' に ADMIN が出ません')
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('ADMIN')).click(); true`)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-admin-tab]")'), 'ADMIN のタブが出ません')
  }
  const openTab = async (tab: string) => {
    await page.evaluate(`document.querySelector('[data-admin-tab="${tab}"]').click(); true`)
    await sleep(800)
  }
  const shown = (selector: string) => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)

  it('古い GAS の団体の代表: 画面と同じ計算で、すべての操作の部品が出る(GAS とスプレッドシートのボタンは出ない)', async () => {
    oldGasMode = true
    try {
      await openAdminAs('top@a.example')
      const tabs = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-admin-tab]')].map((b) => b.getAttribute('data-admin-tab'))`)
      expect(tabs).toContain('orgSettings')
      await openTab('members')
      await waitFor(() => shown('[data-gas-action="addMember"]'), '古い GAS の代表に、メンバーの登録が出ません')
      expect(await shown('[data-gas-action="removeMember"]')).toBe(true)
      await openTab('orgSettings')
      await waitFor(() => shown('[data-gas-action="updateSetting"]'), '古い GAS の代表に、団体設定の編集が出ません')
      expect(await shown('[data-org-admin-links]')).toBe(false)
    } finally {
      oldGasMode = false
    }
  })

  it('最上位が2つある団体の、代表でない最上位: すべての操作ができ、GAS とスプレッドシートを開ける', async () => {
    const gas = A.org.gas as unknown as Record<string, (...a: unknown[]) => unknown>
    gas.invalidateRoles_()
    const roles = JSON.parse(JSON.stringify(gas.getRoles_())) as { id: string; tier: string }[]
    if (!roles.some((r) => r.id === 'r_chair_e2e')) {
      roles.push({ id: 'r_chair_e2e', name: '会長', tier: 'top' } as never)
      const saved = world.call(A.org, topTokenA, 'updateRoles', { roles })
      expect(saved.ok, JSON.stringify(saved)).toBe(true)
      const added = world.call(A.org, topTokenA, 'addMember', { name: '会長さん', email: 'chair@a.example', affiliation: '', role: 'r_chair_e2e', sendInvite: false })
      expect(added.ok, JSON.stringify(added)).toBe(true)
      A.org.cache.clear()
    }
    const login = world.googleLogin(A.org, 'chair@a.example')
    expect(login.result.capabilities).toEqual([...CAPABILITY_KEYS])
    expect(login.result.adminLinks?.scriptEditUrl).toMatch(/^https:\/\/script\.google\.com\/d\/[\w-]+\/edit$/)
    // 代表だけの操作も、GAS で通る
    const g = A.org.gas as unknown as Record<string, (...a: unknown[]) => unknown>
    g.invalidateRoles_()
    expect(() => g.authorizeAction_(g.getActingMemberById_(login.result.memberId), 'listBackups', {})).not.toThrow()

    await openAdminAs('chair@a.example')
    await openTab('members')
    await waitFor(() => shown('[data-gas-action="addMember"]'), '代表でない最上位に、メンバーの登録が出ません')
    await openTab('orgSettings')
    await waitFor(() => shown('[data-org-admin-links]'), '最上位の人に、GAS とスプレッドシートのボタンが出ません')
    const links = await page.evaluate<{ script: string; sheet: string; rel: string[] }>(`(() => {
      const s = document.querySelector('[data-open-script]'), d = document.querySelector('[data-open-sheet]')
      return { script: s.href, sheet: d.href, rel: [s.rel, d.rel] }
    })()`)
    expect(links.script).toMatch(/^https:\/\/script\.google\.com\/d\/[\w-]+\/edit$/)
    expect(links.sheet).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\//)
    for (const rel of links.rel) expect(rel).toBe('noopener noreferrer')
    // 最上位でない人には URL を渡さない
    expect(world.googleLogin(A.org, 'full@a.example').result.adminLinks).toBeUndefined()
  })
})

describe.skipIf(!available)('稼働の目安(workload_rules): 団体のルールを持つ人が変え、持たない人は見るだけ', () => {
  // 制限ありの管理者(lead@a.example)は、できる操作の確かめで登録する。このまとまりだけ動かす時は、ここで登録する
  beforeAll(() => {
    if (available && !world.googleLogin(A.org, 'lead@a.example').result?.memberId) preparePersonas()
  })
  const openTaskSettings = async (email: string) => {
    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await googleSignIn(email)
    await waitFor(loggedIn, email + ' がログインできません')
    await waitFor(async () => (await text()).includes('ADMIN'), email + ' に ADMIN が出ません')
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('ADMIN')).click(); true`)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector(\'[data-admin-tab="taskSettings"]\')'), email + ' にタスクの設定のタブが出ません')
    await page.evaluate(`document.querySelector('[data-admin-tab="taskSettings"]').click(); true`)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-workload-rules]")'), email + ' に稼働の目安が出ません')
  }
  const setRule = (key: string, value: string) => page.evaluate(`(() => {
    const el = document.querySelector('[data-workload-rule="${key}"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const savedRules = () => {
    A.org.cache.clear()
    const row = A.org.sheets.Settings.rows.find((r) => r[0] === 'workload_rules')
    return row && row[1] ? JSON.parse(String(row[1])) : null
  }

  it('代表: 入力を変えると人数の見込みが出て、保存すると GAS に残る。既定に戻すと設定を消す', async () => {
    await openTaskSettings('top@a.example')
    expect(await page.evaluate<string>(`document.querySelector('[data-workload-preview]').textContent`)).toMatch(/この設定だと 余力あり \d+人・普通 \d+人・余力なし \d+人/)
    await setRule('window_days', '400')
    await waitFor(() => page.evaluate<boolean>(`document.querySelector('[data-workload-save]').disabled && document.querySelector('[data-workload-rules]').textContent.includes('14〜365 の整数にしてください')`), '範囲の外の値で保存を止めません')
    await setRule('window_days', '30')
    await setRule('fallback_hours', '4')
    await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-workload-save]').disabled`), '正しい値で保存のボタンが押せません')
    await page.evaluate(`document.querySelector('[data-workload-save]').click(); true`)
    await waitFor(async () => savedRules()?.window_days === 30, 'GAS に稼働の目安が保存されません')
    expect(savedRules()).toMatchObject({ window_days: 30, fallback_hours: 4, available_ratio: 0.6, full_ratio: 1.2, count_hold_and_review: true })
  })

  it('団体のルールを持たない管理者: 今の値を見るだけ(入力は止まり、保存・既定に戻すのボタンが無い)', async () => {
    await openTaskSettings('lead@a.example')
    const shown = await page.evaluate<{ window: string; disabled: boolean; save: boolean; reset: boolean; note: boolean; preview: string }>(`(() => {
      const box = document.querySelector('[data-workload-rules]')
      return { window: box.querySelector('[data-workload-rule="window_days"]').value,
        disabled: [...box.querySelectorAll('input')].every((i) => i.disabled),
        save: !!box.querySelector('[data-workload-save]'), reset: !!box.querySelector('[data-workload-reset]'),
        note: !!box.querySelector('[data-capability-note="org.rules"]'), preview: box.querySelector('[data-workload-preview]').textContent }
    })()`)
    expect(shown).toMatchObject({ window: '30', disabled: true, save: false, reset: false, note: true })
    expect(shown.preview).toMatch(/この設定だと 余力あり \d+人/)
    // GAS も断る
    expect(gasAllows('lead@a.example', 'updateSetting', { key: 'workload_rules', value: '{"window_days":60}' })).toBe(false)
  })

  it('代表: 既定に戻して保存すると、設定を消す(空 = 既定)', async () => {
    await openTaskSettings('top@a.example')
    expect(await page.evaluate<string>(`document.querySelector('[data-workload-rule="window_days"]').value`)).toBe('30')
    await page.evaluate(`document.querySelector('[data-workload-reset]').click(); true`)
    await waitFor(() => page.evaluate<boolean>(`document.querySelector('[data-workload-rule="window_days"]').value === '90' && !document.querySelector('[data-workload-save]').disabled`), '既定に戻すで入力が既定になりません')
    await page.evaluate(`document.querySelector('[data-workload-save]').click(); true`)
    await waitFor(async () => savedRules() === null, '既定に戻した時に、設定が消えません')
  })
})

describe.skipIf(!available)('INPUT の「項目を入れて追加」: 一般のメンバーが項目で書いたタスクは、詳細つきで承認待ちになる', () => {
  const setValue = (selector: string, value: string, index = 0) => page.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    return true
  })()`)
  const taskRow = (title: string) => {
    const [head, ...rows] = A.org.sheets.Tasks.rows.map((r) => r.map(String))
    const row = rows.find((r) => r[head.indexOf('title')] === title)
    return row ? Object.fromEntries(head.map((h, i) => [h, row[i]])) : null
  }

  it('2件を項目で書いて登録すると、GAS に詳細つき・承認待ちで残り、入力履歴に「項目で入力」と出る', async () => {
    // プロジェクトが要る(代表が作る)
    if (!A.org.sheets.Projects.rows.slice(1).length) {
      const made = world.call(A.org, topTokenA, 'createProject', { name: 'E2E プロジェクト', description: '' })
      if (!made.ok) throw new Error('プロジェクトを作れません: ' + made.error)
      A.org.cache.clear()
    }
    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await googleSignIn('base@a.example')
    await waitFor(loggedIn, '一般のメンバーがログインできません')
    const inputButton = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('INPUT'))`
    await waitFor(() => page.evaluate<boolean>(`!!${inputButton}`), 'INPUT のボタンが出ません')
    await page.evaluate(`${inputButton}.click(); true`)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector("[data-input-form-start]") && !document.querySelector("[data-input-form-start]").disabled'), '「項目を入れて追加」が押せません')
    await page.evaluate(`document.querySelector('[data-input-form-start]').click(); true`)
    await waitFor(() => page.evaluate<boolean>('document.querySelectorAll("[data-parsed-task]").length === 1'), '空の枠が出ません')
    expect(await page.evaluate<boolean>('document.querySelector("[data-input-register]").disabled')).toBe(true)
    const project = await page.evaluate<string>(`[...document.querySelector('[data-parsed-field="project"]').options].map((o) => o.value).find(Boolean)`)
    await setValue('[data-parsed-field="name"]', '項目で書いたE2Eのタスク1')
    await setValue('[data-parsed-field="project"]', project)
    await setValue('[data-parsed-field="description"]', '背景: 受付を早くしたい\n完了の条件: 名簿ができている')
    await page.evaluate(`document.querySelector('[data-input-add-another]').click(); true`)
    await waitFor(() => page.evaluate<boolean>('document.querySelectorAll("[data-parsed-task]").length === 2'), '「＋ もう1件」で枠が足されません')
    expect(await page.evaluate<string>(`document.querySelectorAll('[data-parsed-field="project"]')[1].value`)).toBe(project)
    await setValue('[data-parsed-field="name"]', '項目で書いたE2Eのタスク2', 1)
    await waitFor(() => page.evaluate<boolean>('!document.querySelector("[data-input-register]").disabled'), '必須を入れても登録のボタンが押せません')
    await page.evaluate(`document.querySelector('[data-input-register]').click(); true`)
    await waitFor(async () => !!taskRow('項目で書いたE2Eのタスク1') && !!taskRow('項目で書いたE2Eのタスク2'), 'GAS にタスクが残りません')
    const first = taskRow('項目で書いたE2Eのタスク1')!
    expect(first.description).toBe('背景: 受付を早くしたい\n完了の条件: 名簿ができている')
    expect(first.project_id).toBe(project)
    expect(first.approval_status).toMatch(/pending|承認待ち/)
    expect(taskRow('項目で書いたE2Eのタスク2')!.project_id).toBe(project)
    await waitFor(() => page.evaluate<boolean>('!!document.querySelector(\'[data-input-kind="form"]\')'), '入力履歴に「項目で入力」が出ません')
  })
})

describe.skipIf(!available)('コメントへの返信と、ベルの通知の設定', () => {
  const openBell = async () => {
    await page.evaluate(`document.querySelector('button[aria-label="通知"]').click(); true`)
    await sleep(400)
  }
  const signInAs = async (email: string) => {
    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await googleSignIn(email)
    await waitFor(loggedIn, email + ' がログインできません')
  }
  const taskComments = (title: string) => {
    A.org.cache.clear()
    const [head, ...rows] = A.org.sheets.Tasks.rows.map((r) => r.map(String))
    const row = rows.find((r) => r[head.indexOf('title')] === title)
    return row ? (recordList(A.org, 'TaskRecords', row[head.indexOf('id')], 'comment') as { id: string; byId: string; text: string; replyToId?: string }[]) : []
  }
  const TITLE = '返信のE2Eのタスク'
  let topId = ''
  let baseId = ''

  it('メンションされた人がベルから開くと、そのコメントの位置が開き、「返信」で返すと元のコメントの書き手にメールが届く', async () => {
    topId = memberIdOf('top@a.example')
    baseId = memberIdOf('base@a.example')
    const made = world.call(A.org, topTokenA, 'createTasks', { tasks: [{ tempId: 'tr', title: TITLE, projectId: '', department: '', category: '', skills: [], difficulty: 'beginner', priority: 'medium', deadline: null, assigneeIds: [baseId], creatorId: topId, pendingApproval: false }] })
    expect(made.ok, made.error).toBe(true)
    const taskId = String((made.result as { id: string }[])[0].id)
    // 一覧の保存は、画面と同じく差分(listOps)で送る
    const ask = world.call(A.org, topTokenA, 'updateComments', { taskId, listOps: diffList([], [{ id: 'c-ask', byId: topId, text: '@一般さん 確認をお願いします', at: new Date().toISOString(), mentionedIds: [baseId] }], 'id') })
    expect(ask.ok, ask.error).toBe(true)
    A.org.cache.clear()

    await signInAs('base@a.example')
    await openBell()
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-notification="mention-c-ask"]')`), 'メンションの通知が出ません')
    await page.evaluate(`document.querySelector('[data-notification="mention-c-ask"]').click(); true`)
    await waitFor(() => page.evaluate<boolean>(`(document.querySelector('[data-comment-id="c-ask"]')?.className ?? '').includes('border-primary')`), 'メンションのコメントの位置が開きません')

    const mailsBefore = A.org.mails.length
    await page.evaluate(`(() => { const b = document.querySelector('[data-comment-id="c-ask"] [data-comment-reply-button]'); b.click(); return true })()`)
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-comment-reply-box] textarea')`), '返信の欄が出ません')
    await page.evaluate(`(() => {
      const el = document.querySelector('[data-comment-reply-box] textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '確認しました。問題ありません')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await page.evaluate(`document.querySelector('[data-comment-send-reply]').click(); true`)
    await waitFor(async () => taskComments(TITLE).some((c) => c.replyToId === 'c-ask'), 'GAS に返信が残りません')
    const reply = taskComments(TITLE).find((c) => c.replyToId === 'c-ask')!
    expect(reply).toMatchObject({ byId: baseId, text: '確認しました。問題ありません' })
    // 画面では元のコメントの下に字下げして並ぶ
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-comment-replies] [data-comment-id="${reply.id}"]')`), '返信が元のコメントの下に並びません')
    // 元のコメントの書き手(代表)に、急ぎのメールで届く
    const mail = A.org.mails.slice(mailsBefore).find((m) => m.to.includes('top@a.example'))
    expect(mail?.subject).toContain('返信しました')
    expect(mail?.body).toContain('確認しました。問題ありません')

    // メンションの既読は本人の保存に残る(ほかの端末でも既読)
    const baseToken = String(world.googleLogin(A.org, 'base@a.example').result.session.token)
    await waitFor(async () => {
      const res = world.call(A.org, baseToken, 'getMyStorage', { keys: ['notification-history'] })
      const raw = String((res.result as { values?: Record<string, string> })?.values?.['notification-history'] ?? '')
      return /"id":"mention-c-ask"[^}]*"readAt"/.test(raw)
    }, 'メンションの既読が本人の保存に残りません')
  })

  it('返信された人のベルに「返信しました」が出て、押すとそのコメントの位置が開く', async () => {
    const reply = taskComments(TITLE).find((c) => c.replyToId === 'c-ask')!
    await signInAs('top@a.example')
    await openBell()
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-notification="reply-${reply.id}"]')`), '返信の通知が出ません')
    expect(await page.evaluate<string>(`document.querySelector('[data-notification="reply-${reply.id}"]').textContent`)).toContain('返信しました')
    await page.evaluate(`document.querySelector('[data-notification="reply-${reply.id}"]').click(); true`)
    await waitFor(() => page.evaluate<boolean>(`(document.querySelector('[data-comment-id="${reply.id}"]')?.className ?? '').includes('border-primary')`), '返信のコメントの位置が開きません')
  })

  it('ベルの通知を種類ごとにオフにでき、本人の設定に残る(ほかの端末でも同じ)。オフにした種類はベルに出ない', async () => {
    await signInAs('base@a.example')
    await page.evaluate(`document.querySelector('[data-account-menu]').click(); true`)
    // 個人設定は、アカウントのメニューの「個人設定」から開く(自分のページのタブには無い)
    const settingsItem = `[...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.trim() === '個人設定')`
    await waitFor(() => page.evaluate<boolean>(`!!${settingsItem}`), 'アカウントのメニューが開きません')
    await page.evaluate(`${settingsItem}.click(); true`)
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-personal-settings]')`), '個人設定が開きません')
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-bell-kind="invite"]')`), 'ベルの通知の設定が出ません')
    await page.evaluate(`document.querySelector('[data-bell-kind="mention"]').click(); true`)
    await waitFor(() => page.evaluate<boolean>(`(document.querySelector('[data-bell-mention-warning]')?.textContent ?? '').includes('見落としの原因になります')`), '見落としの注意が出ません')
    const saved = () => {
      A.org.cache.clear()
      const [head, ...rows] = A.org.sheets.Members.rows.map((r) => r.map(String))
      const row = rows.find((r) => r[head.indexOf('id')] === baseId)!
      try { return JSON.parse(row[head.indexOf('notify_settings')] || '{}') } catch { return {} }
    }
    await waitFor(async () => saved().bell?.mention === false, 'ベルの通知の設定が本人の設定に残りません')
    // ほかの人のコメントでメンションされても、ベルには出さない
    const taskId = (() => {
      const [head, ...rows] = A.org.sheets.Tasks.rows.map((r) => r.map(String))
      return rows.find((r) => r[head.indexOf('title')] === TITLE)![head.indexOf('id')]
    })()
    const current = taskComments(TITLE)
    const again = world.call(A.org, topTokenA, 'updateComments', { taskId, listOps: diffList(current, [...current, { id: 'c-ask2', byId: topId, text: '@一般さん もう一つ', at: new Date().toISOString(), mentionedIds: [baseId] }], 'id') })
    expect(again.ok, again.error).toBe(true)
    await signInAs('base@a.example')
    await openBell()
    await sleep(800)
    expect(await page.evaluate<boolean>(`!!document.querySelector('[data-notification="mention-c-ask2"]')`)).toBe(false)
  })
})

describe.skipIf(!available)('担当者が「完了」を選ぶと、確認待ちになる', () => {
  const TITLE = '完了から確認待ちのE2Eのタスク'
  const taskRow = (title: string) => {
    A.org.cache.clear()
    const [head, ...rows] = A.org.sheets.Tasks.rows.map((r) => r.map(String))
    const row = rows.find((r) => r[head.indexOf('title')] === title)
    return row ? Object.fromEntries(head.map((h, i) => [h, row[i]])) : null
  }

  it('タスクの詳細で「完了」を選ぶと、GAS で確認待ちになり、確認する人にメールが届く。誰に届くかが詳細に出る', async () => {
    const topId = memberIdOf('top@a.example')
    const baseId = memberIdOf('base@a.example')
    const made = world.call(A.org, topTokenA, 'createTasks', { tasks: [{ tempId: 'td', title: TITLE, projectId: '', department: '', category: '', skills: [], difficulty: 'beginner', priority: 'medium', deadline: null, assigneeIds: [baseId], creatorId: topId, pendingApproval: false }] })
    expect(made.ok, made.error).toBe(true)
    A.org.cache.clear()

    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + A.orgId)
    await googleSignIn('base@a.example')
    await waitFor(loggedIn, 'base@a.example がログインできません')
    // 詳細は OUTPUT(自分のタスク)のカードから開く(前のテストでメンションのベルをオフにしているため)
    await page.evaluate(`[...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === 'OUTPUT')?.click(); true`)
    const card = `[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(TITLE)})`
    await waitFor(() => page.evaluate<boolean>(`!!${card}`), '一覧にタスクが出ません')
    await page.evaluate(`${card}.click(); true`)
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-review-targets]')`), '確認待ちが届く人が詳細に出ません')
    expect(await page.evaluate<string>(`document.querySelector('[data-review-targets]').textContent`)).toContain('確認待ちが届く人')
    expect(await page.evaluate<string>('document.body.innerText')).toContain('確認者の承認で完了になります')

    const mailsBefore = A.org.mails.length
    await page.evaluate(`(() => {
      const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'done') && [...s.options].some((o) => o.value === 'review'))
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'done')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await waitFor(async () => /review|確認待ち/.test(taskRow(TITLE)?.status ?? ''), 'GAS で確認待ちになりません')
    await waitFor(async () => A.org.mails.slice(mailsBefore).some((m) => m.subject.includes('確認をお願いします')), '確認する人にメールが届きません')
    expect(A.org.mails.slice(mailsBefore).some((m) => m.to.includes('base@a.example') && m.subject.includes('確認をお願いします'))).toBe(false)
  })
})

describe.skipIf(!available)('データの持ち方: 代表が団体設定から、記録を1件1行のシートに移し、戻す', () => {
  const TITLE = '移行のE2Eのタスク'
  const settingState = () => {
    const row = B.org.sheets.Settings.rows.find((r) => String(r[0]) === 'record_rows_state')
    return row ? JSON.parse(String(row[1])).state : 'none'
  }
  const taskRow = () => {
    const [head, ...rows] = B.org.sheets.Tasks.rows.map((r) => r.map(String))
    const row = rows.find((r) => r[head.indexOf('title')] === TITLE)!
    return { id: row[head.indexOf('id')], comments: row[head.indexOf('comments_json')] }
  }
  const panelText = () => page.evaluate<string>(`document.querySelector('[data-record-rows]')?.textContent ?? ''`)
  const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  const clickByText = (label: string) => page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-record-rows] button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); b.click(); return true })()`)

  it('記録をセルに持つ団体(移行の前)で、試す → 移す: バックアップを取ってから行に写し、セルを空にする。画面のコメントはそのまま', async () => {
    expect(settingState()).toBe('done') // 新しい団体は最初から行に持つ
    // 移行の前の団体のふり: 印を none にしてから、タスクとコメントを書く(セルに入る)
    const settings = B.org.sheets.Settings.rows
    settings.find((r) => String(r[0]) === 'record_rows_state')![1] = JSON.stringify({ state: 'none' })
    B.org.props.DATA_VERSION = 'legacy-' + Date.now()
    B.org.cache.clear()
    const topB = String(world.googleLogin(B.org, 'top@b.example').result.session.token)
    const topId = String(world.googleLogin(B.org, 'top@b.example').result.memberId)
    const made = world.call(B.org, topB, 'createTasks', { tasks: [{ tempId: 'tm', title: TITLE, projectId: '', department: '', category: '', skills: [], difficulty: 'beginner', priority: 'medium', deadline: null, assigneeIds: [topId], creatorId: topId, pendingApproval: false }] })
    expect(made.ok, made.error).toBe(true)
    const c = world.call(B.org, topB, 'updateComments', { taskId: taskRow().id, listOps: diffList([], [{ id: 'c-legacy', byId: topId, text: '移行の前のコメント', at: new Date().toISOString() }], 'id') })
    expect(c.ok, c.error).toBe(true)
    expect(taskRow().comments).toContain('c-legacy')

    await navigate('/')
    await clearDevice()
    await navigate('/?org=' + B.orgId)
    await googleSignIn('top@b.example')
    await waitFor(loggedIn, 'top@b.example がログインできません')
    await page.evaluate(`document.querySelector('[data-account-menu]').click(); true`)
    const item = `[...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.trim() === '団体設定')`
    await waitFor(() => page.evaluate<boolean>(`!!${item}`), 'アカウントのメニューに団体設定がありません')
    await page.evaluate(`${item}.click(); true`)
    await waitFor(async () => (await panelText()).includes('セルにまとめて持っています'), '団体設定に、データの持ち方が出ません')
    await clickByText('試す')
    await waitFor(async () => (await panelText()).includes('件の記録を移せます'), '試した結果が出ません')
    await click('[data-record-rows-trial] input[type=checkbox]')
    await clickByText('移す')
    await waitFor(async () => settingState() === 'done', 'GAS で行に移りません', 20000)
    expect(taskRow().comments).toBe('')
    expect(recordList(B.org, 'TaskRecords', taskRow().id, 'comment').map((x: { id: string }) => x.id)).toEqual(['c-legacy'])
    await waitFor(async () => (await panelText()).includes('1件1行のシートに持っています'), '画面の状態が「行に持っている」になりません')
    // 自動のバックアップを取ったことが、操作の記録に残る
    expect(JSON.stringify(B.org.sheets.AuditLog?.rows ?? [])).toContain('migrateRecordsToRows')
  })

  it('試す → 戻す: バックアップを取ってから、セルに同じ一覧を戻し、行を空にする', async () => {
    await clickByText('試す')
    await waitFor(async () => (await panelText()).includes('戻せます'), '戻す前の確かめが出ません')
    await click('[data-record-rows-trial] input[type=checkbox]')
    await clickByText('戻す')
    await waitFor(async () => settingState() === 'none', 'GAS でセルに戻りません', 20000)
    expect(JSON.parse(taskRow().comments).map((x: { id: string }) => x.id)).toEqual(['c-legacy'])
    expect(recordList(B.org, 'TaskRecords', taskRow().id, 'comment')).toEqual([])
    await waitFor(async () => (await panelText()).includes('セルにまとめて持っています'), '画面の状態が「セル」に戻りません')
  })
})
