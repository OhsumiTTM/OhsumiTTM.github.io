// スマホの幅(375px)で主な画面を開き、横にはみ出す箇所が無いことを確かめる(CI で実行する)。
//
//   1. テスト用の設定(GAS の URL など)でビルドする(--no-build で省略)
//   2. gas/Code.gs のサンプルのデータ(buildSampleData)を、GAS の読み取りの絞り込み
//      (buildViewerData)に通して、そのメンバーが受け取るデータを作る。
//      一般のメンバー(OUTPUT・タスク詳細・個人ページ)と、代表(管理画面のすべてのセクション)の2回開く
//   3. out/ を配信し、ヘッドレスの Chrome で開く。GAS・Google への通信は偽の応答を返す
//   4. 画面ごとに、ページの幅が画面より広くなっていないか・画面の外にはみ出した要素が無いか・
//      ボタンの文字が1文字ずつ折り返していないか・依存関係のカードの中身が切れていないかを調べる
//
// 使い方: node scripts/check-layout.mjs [--no-build]
// Chrome の場所は CHROME_PATH で指定できる(未指定なら、よくある場所を探す)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
export const WIDTH = Number(process.env.LAYOUT_WIDTH || 375)
const GAS_URL = 'https://script.google.com/macros/s/LAYOUT_CHECK/exec'
const ORG = 'org-layout'
const MEMBER = 'sample-m-05' // 一般のメンバー(サンプルのデータの base の枠)
export const ADMIN_MEMBER = 'sample-m-01' // 代表(サンプルのデータの top の枠)

// 画面を開く手順。ラベルは日本語の画面の表示(lib/ohsumi/i18n/ja.ts)と同じ文字にする
// (lib/ohsumi/check-layout.test.ts で、ja.ts にあることを確かめる)
export const STEPS = [
  { name: 'ログイン画面', do: 'login' },
  { name: 'OUTPUT(自分)', do: 'home' },
  { name: 'OUTPUT(一覧)', do: 'click', text: '一覧' },
  { name: 'ワークフロー', do: 'click', text: 'ワークフロー' },
  { name: 'リスト', do: 'click', text: 'リスト' },
  { name: 'カレンダー', do: 'click', text: 'カレンダー' },
  { name: '難易度', do: 'click', text: '難易度' },
  { name: '依存関係', do: 'click', text: '依存関係', dependencyCards: true },
  { name: 'ガント', do: 'click', text: 'ガント' },
  { name: '公募', do: 'click', text: '公募' },
  { name: 'タスク詳細(担当者が多い)', do: 'openTask', view: 'リスト', text: '担当者が多いタスク' },
  { name: 'タスク詳細(長い名前・説明)', do: 'openTask', view: 'リスト', text: 'とても長いタスク名の例' },
  { name: '個人ページ(タスク)', do: 'profile' },
  { name: '個人ページ(人材育成)', do: 'click', text: '人材育成' },
  { name: '個人ページ(経歴・キャリア)', do: 'click', text: '経歴・キャリア' },
  { name: '個人ページ(設定)', do: 'click', text: '設定' },
]

// 代表で開く管理画面。ラベルは管理画面の左のメニュー(components/ohsumi/admin/admin-screen.tsx の
// buildNav と、ja.ts の admin.nav.*)と同じ文字にする(lib/ohsumi/check-layout.test.ts で確かめる)
export const ADMIN_STEPS = [
  { name: '管理画面(Dashboard)', do: 'admin' },
  ...['幹部 View', 'Approvals', 'Assignments', 'Projects', 'Members', 'Analytics', 'Tags', 'Org Tree', '検定', '学習コンテンツ',
    'レーダー', '経費申請', 'フォーム', '人材DB', '日報・週報', '採用'].map((text) => ({ name: `管理画面(${text})`, do: 'click', text, from: 'aside nav button' })),
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- サンプルのデータ(一般のメンバーが受け取る分) ----
export function viewerData(memberId = MEMBER) {
  const code = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
  vm.runInContext(code, ctx)
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const data = ctx.buildSampleData(today, {})
  const settings = ctx.mergeSampleSettings({}, data.settings).values
  const table = (name, rows) => {
    const headers = ctx.SHEET_HEADERS[name]
    return { headers, rows: rows.map((r) => headers.map((h) => (r[h] == null ? '' : String(r[h])))) }
  }
  const snapshot = {
    Members: table('Members', data.sheets.Members),
    Projects: table('Projects', data.sheets.Projects),
    Tasks: table('Tasks', data.sheets.Tasks),
    Settings: { headers: ['key', 'value'], rows: Object.entries(settings).map(([k, v]) => [k, v]) },
  }
  return ctx.buildViewerData(JSON.parse(JSON.stringify(snapshot)), memberId)
}

// ---- out/ の配信 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' }
function serve(dir) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = join(dir, p)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) && existsSync(file + '.html')) file += '.html'
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  try { return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim() || null } catch { return null }
}

// ---- 画面の中で実行する調査(はみ出し・つぶれたボタン・切れたカード) ----
const MEASURE = `(() => {
  const W = document.documentElement.clientWidth
  const cls = (el) => (el && typeof el.className === 'string' ? el.className.split(' ').slice(0, 5).join('.') : '')
  const desc = (el) => el.tagName.toLowerCase() + '.' + cls(el) + ' "' + (el.textContent || '').trim().slice(0, 30) + '" (親: ' + cls(el.parentElement) + ' "' + (el.parentElement?.textContent || '').trim().slice(0, 30) + '")'
  const off = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height || r.right <= W + 1) continue
    if (getComputedStyle(el).position === 'fixed') continue
    let p = el.parentElement, clipped = false
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p.getBoundingClientRect().right <= W + 1) { clipped = true; break }
      if (cs.position === 'fixed') { clipped = true; break }
      p = p.parentElement
    }
    if (!clipped) off.push(desc(el) + ' (右端 ' + Math.round(r.right) + 'px)')
  }
  // 短いラベル(ボタン・タブ・バッジ・名前。8文字まで)の文字が、2行以上に折り返していないか
  const lines = (node) => {
    const range = document.createRange(); range.selectNodeContents(node)
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size
  }
  const squashed = [...document.querySelectorAll('button, a, [role=tab], span.rounded-md, span.rounded-full')].filter((b) => {
    const r = b.getBoundingClientRect()
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight * 3) return false
    const texts = []
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
    while (walk.nextNode()) { const t = walk.currentNode.textContent.trim(); if (t.length >= 2 && t.length <= 8) texts.push(walk.currentNode) }
    const wrapped = texts.find((t) => lines(t) > 1)
    if (wrapped) b.dataset.wrappedText = wrapped.textContent.trim()
    return !!wrapped
  }).map((b) => '「' + b.dataset.wrappedText + '」 in ' + desc(b))
  return JSON.stringify({ page: document.documentElement.scrollWidth, window: window.innerWidth, off: off.slice(0, 5), squashed: squashed.slice(0, 5) })
})()`
// カード全体、またはカードの中の行(文字が入ったもの)が、縦に押しつぶされて切れていないか
const MEASURE_CARDS = `JSON.stringify([...document.querySelectorAll('.cursor-grab.absolute')].filter((c) =>
  c.scrollHeight > c.clientHeight + 1 ||
  [...c.querySelectorAll('*')].some((k) => (k.textContent || '').trim() && k.getBoundingClientRect().height > 0 && k.scrollHeight > k.clientHeight + 1)
).map((c) => (c.textContent || '').trim().slice(0, 30)))`

async function run({ build = true } = {}) {
  if (build) {
    console.log('テスト用の設定でビルドします…')
    const env = { ...process.env, NEXT_PUBLIC_GAS_URL: GAS_URL, NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: '000000000000-layout.apps.googleusercontent.com' }
    const b = spawnSync('pnpm', ['exec', 'next', 'build'], { cwd: ROOT, env, stdio: 'inherit' })
    if (b.status !== 0) throw new Error('ビルドに失敗しました')
    const c = spawnSync('node', ['scripts/csp.mjs'], { cwd: ROOT, stdio: 'inherit' })
    if (c.status !== 0) throw new Error('CSP の確認に失敗しました')
  }
  const chromePath = findChrome()
  if (!chromePath) {
    if (process.env.CI) throw new Error('Chrome が見つかりません(CHROME_PATH で指定してください)')
    console.warn('Chrome が見つからないため、確認をとばしました')
    return []
  }
  // 開いているメンバーと、そのメンバーが受け取るデータ(2回目は代表に切り替える)
  let member = MEMBER
  let view = viewerData(MEMBER)
  const server = await serve(join(ROOT, 'out'))
  const base = `http://127.0.0.1:${server.address().port}`
  const port = 9300 + Math.floor(Math.random() * 500)
  const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
  const failures = []
  try {
    let targets = null
    for (let i = 0; i < 50 && !targets; i++) {
      await sleep(200)
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { /* 起動中 */ }
    }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r))
    let id = 0
    const pending = new Map()
    const listeners = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) listeners.forEach((l) => l(m))
    })
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
      return r.result?.result?.value
    }

    // GAS・Google への通信には偽の応答を返す(外には出さない)
    const gas = (body) => {
      switch (body.action) {
        case 'getLoginConfig': return { orgId: ORG }
        case 'getInitialData': return { memberId: member, version: 'layout', sheets: view }
        case 'getExpenses': case 'fetchDailyReports': case 'getFiles': case 'getFormSubmissions': case 'getCandidates': return []
        case 'getMyEmails': return { email: 'member@example.com' }
        case 'checkAndGenerateRecurringTasks': return { generated: [] }
        default: return {}
      }
    }
    const b64 = (s) => Buffer.from(s).toString('base64')
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    listeners.push((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      const url = new URL(request.url)
      if (url.origin === base) return send('Fetch.continueRequest', { requestId })
      const fulfill = (type, body) => send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: b64(body),
        responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }] })
      if (url.href.startsWith(GAS_URL)) return fulfill('application/json', JSON.stringify({ ok: true, result: gas(JSON.parse(request.postData || '{}')) }))
      if (url.href.startsWith('https://accounts.google.com/gsi/client')) {
        return fulfill('text/javascript', 'window.google={accounts:{id:{initialize(){},renderButton(){},prompt(){},disableAutoSelect(){},cancel(){}},oauth2:{initTokenClient(){return{requestAccessToken(){}}}}}}')
      }
      return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    })
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: WIDTH < 600 ? 2 : 1, mobile: WIDTH < 600 })

    const navigate = async (path = '/') => { await send('Page.navigate', { url: base + path }); await sleep(3000) }
    const clickText = (text, from = 'button, a, [role=tab]') => evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(from)})]
      const el = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)}) || els.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))
      if (!el) throw new Error('見つかりません: ' + ${JSON.stringify(text)})
      el.click(); return true })()`)
    const signIn = () => evaluate(`localStorage.setItem('ohsumi-login-config', JSON.stringify({ orgId: '${ORG}' }));
      localStorage.setItem('ohsumi-session-${ORG}', JSON.stringify({ token: 'v1.layout.check', exp: Math.floor(Date.now() / 1000) + 86400 }))`)

    await navigate('/')
    const passes = [
      { member: MEMBER, steps: STEPS },
      { member: ADMIN_MEMBER, steps: ADMIN_STEPS },
    ]
    for (const pass of passes) {
    member = pass.member
    view = viewerData(pass.member)
    for (const step of pass.steps) {
      try {
        if (step.do === 'login') { await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/') }
        if (step.do === 'home') {
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
        }
        if (step.do === 'admin') {
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          await clickText('ADMIN'); await sleep(1500)
        }
        if (step.do === 'click') { await clickText(step.text, step.from); await sleep(1200) }
        if (step.do === 'openTask') {
          await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
          await clickText(step.view); await sleep(800)
          await clickText(step.text, 'td, span, div, button'); await sleep(1200)
        }
        if (step.do === 'profile') {
          await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(400)
          await evaluate(`(() => { const bs = [...document.querySelectorAll('button[aria-expanded]')].filter((b) => b.querySelector('img, span.rounded-full')); bs[bs.length - 1].click() })()`)
          await sleep(500); await clickText('プロフィール'); await sleep(1500)
        }
        const m = JSON.parse(await evaluate(MEASURE))
        const problems = []
        if (m.page > WIDTH + 1 || m.window > WIDTH + 1) problems.push(`ページの幅が ${Math.max(m.page, m.window)}px(画面は ${WIDTH}px)`)
        m.off.forEach((o) => problems.push('はみ出し: ' + o))
        m.squashed.forEach((o) => problems.push('文字が折り返した短いラベル: ' + o))
        if (step.dependencyCards) JSON.parse(await evaluate(MEASURE_CARDS)).forEach((c) => problems.push('中身が切れたカード: ' + c))
        console.log(`${problems.length ? '✗' : '✓'} ${step.name}`)
        problems.forEach((p) => failures.push(`${step.name}: ${p}`))
      } catch (e) {
        console.log(`✗ ${step.name}`)
        failures.push(`${step.name}: 画面を開けませんでした(${e.message})`)
      }
    }
    }
    ws.close()
  } finally {
    chrome.kill()
    server.close()
  }
  return failures
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run({ build: !process.argv.includes('--no-build') }).then(
    (failures) => {
      if (failures.length) {
        console.error(`\n画面の幅 ${WIDTH}px で表示が崩れています:\n  ${failures.join('\n  ')}`)
        process.exit(1)
      }
      console.log(`\n画面の幅 ${WIDTH}px で、主な画面に横のはみ出しはありません`)
    },
    (e) => { console.error(e); process.exit(1) },
  )
}
