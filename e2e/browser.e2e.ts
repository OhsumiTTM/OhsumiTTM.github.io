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
  world.call(A.org, topA, 'addMember', { name: '一般さん', email: 'base@a.example', affiliation: '', role: 'base', sendInvite: false })
  const topId = world.googleLogin(A.org, 'top@a.example').result.memberId
  world.call(A.org, topA, 'createTasks', { tasks: [{ tempId: 't1', title: '団体Aのタスク', projectId: '', department: '', category: '', skills: [], difficulty: 'normal', priority: 'medium', deadline: null, assigneeIds: [topId], creatorId: topId }] })
  world.googleLogin(B.org, 'top@b.example', { setupCode: B.setupCode })
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
    if (org) { void fulfill('application/json', JSON.stringify(org.postRaw(JSON.parse(request.postData || '{}')))); return }
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
const text = () => page.evaluate<string>('document.body.innerText')
// 隠れている要素(閉じた知らせ・メニュー)も含めた文字。データが漏れていないかは、こちらで確かめる
const allText = () => page.evaluate<string>('document.body.textContent')
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
  return document.body.innerText.includes('OUTPUT') && !document.querySelector('[data-e2e-gsi]')
})()`)
const clearDevice = () => page.evaluate('localStorage.clear(); sessionStorage.clear(); true')

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

  it('ログアウト: ログイン画面に戻り、読み込み直してもログインしたままにならない', async () => {
    // ヘッダーの右端(アカウント)のメニューを開いて「ログアウト」
    // メニューが開くまでの時間は、端末の混み具合で変わる(決まった時間を待たず、「ログアウト」が出るまで待つ)
    const logoutItem = `[...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.trim() === 'ログアウト')`
    await page.evaluate(`document.querySelector('[data-account-menu]').click(); true`)
    await waitFor(() => page.evaluate<boolean>(`!!${logoutItem}`), 'アカウントのメニューが開きません')
    await page.evaluate(`${logoutItem}.click(); true`)
    await waitFor(async () => !(await loggedIn()), 'ログアウトできません')
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
