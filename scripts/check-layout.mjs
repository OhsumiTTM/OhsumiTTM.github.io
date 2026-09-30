// スマホの幅(375px)で主な画面を開き、横にはみ出す箇所が無いことを確かめる(CI で実行する)。
//
//   1. テスト用の設定(GAS の URL など)でビルドする(--no-build で省略)
//   2. gas/Code.gs のサンプルのデータ(buildSampleData_)を、GAS の読み取りの絞り込み
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
const ORG = 'org_LAYOUTLAYOUTLAYOUT01'
// 招待リンクで開く、レジストリに無い団体
const MISSING_ORG = 'org_MISSINGMISSINGMISS01'
const MEMBER = 'sample-m-05' // 一般のメンバー(サンプルのデータの base の枠)
export const ADMIN_MEMBER = 'sample-m-01' // 代表(サンプルのデータの top の枠)

// 画面を開く手順。ラベルは日本語の画面の表示(lib/ohsumi/i18n/ja.ts)と同じ文字にする
// (lib/ohsumi/check-layout.test.ts で、ja.ts にあることを確かめる)
export const STEPS = [
  { name: 'ログイン画面', do: 'login' },
  { name: 'ログイン画面(団体を選ぶ)', do: 'loginOrgs' },
  { name: 'ログイン画面(招待リンクの団体が見つからない)', do: 'loginMissingOrg' },
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
  // 提供停止・機能停止(R1-e): 画面の上部の知らせ(文は ja.ts の app.contract*)
  { name: 'OUTPUT(機能停止中の知らせ)', do: 'contract', contract: { phase: 'inEffect', kind: 'restrict', suspendAt: '2026-10-01T00:00:00.000Z' }, expect: 'アンケートへの回答をお願いします' },
  { name: 'OUTPUT(提供停止の予告)', do: 'contract', contract: { phase: 'scheduled', kind: 'suspend', days: 6 }, expect: '提供を停止します' },
]

// 代表で開く管理画面。ラベルは管理画面の左のメニュー(components/ohsumi/admin/admin-screen.tsx の
// buildNav と、ja.ts の admin.nav.*)と同じ文字にする(lib/ohsumi/check-layout.test.ts で確かめる)
export const ADMIN_STEPS = [
  { name: '管理画面(Dashboard)', do: 'admin' },
  ...['幹部 View', 'Approvals', 'Assignments', 'Projects', 'Members', 'Analytics', 'Tags', 'Org Tree', '検定', '学習コンテンツ',
    'レーダー', '経費申請', 'フォーム', '人材DB', '日報・週報', '採用'].map((text) => ({ name: `管理画面(${text})`, do: 'click', text, from: 'aside nav button' })),
]

// 機能停止中(読み取り専用。R1-e)に、閲覧のための欄・ボタンと書き出しが使えること、書く欄が止まることを確かめる。
// ラベルは日本語の表示(ja.ts)と同じ文字にする(lib/ohsumi/check-layout.test.ts で確かめる)
export const READ_ONLY_CONTRACT = { phase: 'inEffect', kind: 'restrict', suspendAt: '2026-10-01T00:00:00.000Z' }
export const READ_ONLY_STEPS = [
  { name: '機能停止中: ワークスペース(期間・プロジェクト・表示・並び替え・表示項目)', do: 'readOnlyWorkspace',
    labels: ['一覧', 'すべてのプロジェクト', '表示項目', '表示順', 'ワークフロー', 'リスト', 'カレンダー', 'ガント'] },
  { name: '機能停止中: リスト(検索・Excel 出力)', do: 'readOnlyList', labels: ['リスト', 'Excel出力'] },
  { name: '機能停止中: タスク詳細(書く欄は使えない)', do: 'readOnlyTask', view: 'リスト', text: '担当者が多いタスク' },
  { name: '機能停止中: 管理画面(検索・絞り込み・書き出し)', do: 'readOnlyAdmin', labels: ['全データをExcel出力', 'Members', '日報・週報', '人材DB'] },
  // 主な作成の操作が、保存の手前で止まること(GAS に書き込みを送らない。止めた知らせを出し、書いた文章を残す)。
  // 偽の GAS は書き込みも受け付けるので、画面の止め方に漏れがあれば、送った書き込みとして見つかる
  { name: '機能停止中: タスクの追加が保存の手前で止まる', do: 'readOnlyAddTask', labels: ['INPUT', 'イベント準備の4タスクを入力', 'タスクを整理する', '選択したタスクを登録'] },
  { name: '機能停止中: コメントが保存の手前で止まる', do: 'readOnlyComment', view: 'リスト', text: '担当者が多いタスク', labels: ['送信'] },
  { name: '機能停止中: 経費申請が保存の手前で止まる', do: 'readOnlyExpense', labels: ['経費申請', '申請する'] },
  { name: '機能停止中: 承認が保存の手前で止まる', do: 'readOnlyApprove', labels: ['Approvals', '承認する'] },
]

// 読み取り(GAS の READ_ONLY_ACTIONS と同じ)。これ以外を画面が送ったら、書き込みとして数える
export const LAYOUT_READ_ACTIONS = ['ping', 'getLoginConfig', 'exchangeIdToken', 'getInitialData', 'getBackgroundData', 'getMyEmails', 'getExpenses',
  'getFiles', 'getWebhookStatus', 'getCandidates', 'getFormSubmissions', 'fetchDailyReports', 'translateText', 'revokeMySessions',
  'revokeMemberSessions', 'updateLastLogin']

// レジストリの管理画面(/registry-admin/)。ラベルは components/registry/registry-admin.tsx の TABS と同じ文字にする
// (lib/ohsumi/check-layout.test.ts で確かめる)
export const REGISTRY_URL = 'https://script.google.com/macros/s/LAYOUT_REGISTRY/exec'
export const REGISTRY_STEPS = [
  { name: 'レジストリ管理(ログイン)', do: 'registryLogin' },
  { name: 'レジストリ管理(団体)', do: 'registry' },
  { name: 'レジストリ管理(停止の予定を入れる)', do: 'registrySuspend' },
  { name: 'レジストリ管理(登録コード)', do: 'click', text: '登録コード', from: '[role=tab]' },
  { name: 'レジストリ管理(登録コードを発行した後)', do: 'registryIssue' },
  { name: 'レジストリ管理(操作の記録)', do: 'click', text: '操作の記録', from: '[role=tab]' },
]

// レジストリの偽の応答(長い団体名・URL・メールで、はみ出しを確かめる)
export function registryResponse(body) {
  const long = 'とても長い名前の特定非営利活動法人テスト団体ロングネームの会'
  const iso = (d) => new Date(Date.UTC(2026, 9, d)).toISOString()
  switch (body.action) {
    case 'adminOverview':
      return {
        me: { email: 'registry.admin.with.a.long.address@example.com', authAt: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 1800 },
        codeTtlDays: 14,
        orgs: [
          { orgId: 'org_' + 'x'.repeat(40), displayName: long, status: 'active', state: 'active', checkState: 'ok', contractStatus: 'active', contractUntil: iso(31), contractNote: '', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: '', suspendReason: '', suspendKind: 'suspend', suspendScheduledBy: '', noticesSent: [], channel: 'standard', gasUrl: 'https://script.google.com/macros/s/' + 'A'.repeat(70) + '/exec', gasVersion: 'r1e-1' },
          { orgId: 'org_b', displayName: '停止予定の団体', status: 'active', state: 'scheduled', checkState: 'stale', contractStatus: 'ending', contractUntil: '', contractNote: '契約の更新なし', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: iso(15), suspendReason: '契約の終了', suspendKind: 'suspend', suspendScheduledBy: 'registry.admin.with.a.long.address@example.com', noticesSent: [14, 7], channel: 'standard', gasUrl: '', gasVersion: '' },
          { orgId: 'org_r', displayName: '機能停止中の団体', status: 'active', state: 'restricted', checkState: 'ok', contractStatus: 'active', contractUntil: '', contractNote: '', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: iso(2), suspendReason: 'アンケートの未回答'.repeat(4), suspendKind: 'restrict', suspendScheduledBy: 'registry.admin.with.a.long.address@example.com', noticesSent: [14, 7, 1], channel: 'standard', gasUrl: '', gasVersion: 'r1e-1' },
          { orgId: 'org_c', displayName: '停止中の団体', status: 'suspended', state: 'suspended', checkState: 'never', contractStatus: 'ended', contractUntil: '', contractNote: '', lastCheckAt: '', createdAt: iso(1), suspendAt: iso(1), suspendReason: '契約の終了', suspendKind: 'suspend', suspendScheduledBy: '', noticesSent: [14, 7, 1], channel: '', gasUrl: '', gasVersion: '' },
        ],
        codes: ['unused', 'used', 'expired', 'revoked'].map((state, i) => ({
          codeId: 'rc_' + i + 'abcdefghij', kind: 'new', orgName: i ? '団体' + i : long, contactName: '担当 太郎', contactEmail: 'contact.person.long.address@example.org', note: i ? '' : 'とても長いメモ'.repeat(8),
          state, expiresAt: iso(14), issuedBy: 'registry.admin.with.a.long.address@example.com', issuedAt: iso(1), usedAt: state === 'used' ? iso(2) : '', usedOrgId: state === 'used' ? 'org_' + 'y'.repeat(40) : '', revokedAt: state === 'revoked' ? iso(3) : '', revokedBy: state === 'revoked' ? 'registry.admin.with.a.long.address@example.com' : '',
        })),
        audit: [
          { at: iso(4), actor: 'registry.admin.with.a.long.address@example.com', action: 'scheduleSuspension', target: 'org_r', before: '', after: JSON.stringify({ kind: 'restrict', suspendAt: iso(2) }), reason: 'アンケートの未回答' },
          { at: iso(3), actor: 'registry.admin.with.a.long.address@example.com', action: 'issueRegistrationCode', target: 'rc_0abcdefghij', before: '', after: JSON.stringify({ orgName: long, contactEmail: 'contact.person.long.address@example.org', expiresAt: iso(14) }), reason: '' },
          { at: iso(2), actor: 'stranger@example.com', action: 'adminLoginDenied', target: '', before: '', after: '', reason: '許可リスト(ADMIN_EMAILS)に無いアカウント' },
        ],
      }
    case 'issueRegistrationCode':
      return { code: 'ABCD-EFGH-JKMN-PQRS', codeId: 'rc_new', expiresAt: new Date(Date.UTC(2026, 9, 15)).toISOString(), orgName: body.orgName }
    default:
      return {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ヘッドレスの Chrome を起動し、操作の窓口(remote debugging)が開くまで待つ。
// CI のランナーでは起動が遅いことがあるので、1回に30秒まで待ち、開かなければ別のポートで起動し直す(3回まで)
async function launchChrome(chromePath) {
  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = 9300 + Math.floor(Math.random() * 500)
    const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
    let exited = null
    chrome.on('exit', (code) => { exited = code })
    for (let i = 0; i < 150 && exited === null; i++) {
      await sleep(200)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) return { chrome, targets }
      } catch { /* 起動中 */ }
    }
    lastError = exited !== null ? `Chrome が終了しました(終了コード ${exited})` : '30秒待っても操作の窓口が開きません'
    chrome.kill()
    console.warn(`Chrome の起動に失敗しました(${attempt}回目: ${lastError})`)
  }
  throw new Error(`Chrome を起動できませんでした(${lastError})`)
}

// ---- サンプルのデータ(一般のメンバーが受け取る分) ----
export function viewerData(memberId = MEMBER) {
  const code = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
  vm.runInContext(code, ctx)
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const data = ctx.buildSampleData_(today, {})
  const settings = ctx.mergeSampleSettings_({}, data.settings).values
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
  return ctx.buildViewerData_(JSON.parse(JSON.stringify(snapshot)), memberId)
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
    const env = { ...process.env, NEXT_PUBLIC_GAS_URL: GAS_URL, NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: '000000000000-layout.apps.googleusercontent.com',
      NEXT_PUBLIC_REGISTRY_URL: REGISTRY_URL, NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID: '000000000000-registry.apps.googleusercontent.com' }
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
  const { chrome, targets } = await launchChrome(chromePath)
  const failures = []
  try {
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
    const evaluate = async (expression, userGesture = false) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
      return r.result?.result?.value
    }

    // 画面の上部の知らせを確かめる時に、GAS の応答に付ける停止の状態(R1-e)
    let contract = null
    // 画面が送った書き込み(読み取りの一覧に無い操作)
    let sentWrites = []
    // GAS・Google への通信には偽の応答を返す(外には出さない)
    const gas = (body) => {
      if (!LAYOUT_READ_ACTIONS.includes(body.action)) {
        sentWrites.push(body.action === 'batch' ? 'batch(' + (body.ops || []).map((o) => o.action).join(',') + ')' : body.action)
      }
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
      if (url.href.startsWith(GAS_URL)) return fulfill('application/json', JSON.stringify({ ok: true, result: gas(JSON.parse(request.postData || '{}')), ...(contract ? { contract } : {}) }))
      if (url.href.startsWith(REGISTRY_URL)) {
        const body = JSON.parse(request.postData || '{}')
        // 接続先の解決: 一覧に無い団体(招待リンクの団体が見つからない画面)
        if (body.action === 'resolveOrg') return fulfill('application/json', JSON.stringify({ ok: false, notFound: true, error: '団体が見つかりません。' }))
        return fulfill('application/json', JSON.stringify({ ok: true, result: registryResponse(body) }))
      }
      if (url.href.startsWith('https://accounts.google.com/gsi/client')) {
        return fulfill('text/javascript', 'window.google={accounts:{id:{initialize(){},renderButton(){},prompt(){},disableAutoSelect(){},cancel(){}},oauth2:{initTokenClient(){return{requestAccessToken(){}}}}}}')
      }
      return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    })
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: WIDTH < 600 ? 2 : 1, mobile: WIDTH < 600 })

    const navigate = async (path = '/') => { await send('Page.navigate', { url: base + path }); await sleep(3000) }
    // gesture: 人が押した時と同じ扱いにする(機能停止中の知らせは、人が操作した時だけ出る)
    const clickText = (text, from = 'button, a, [role=tab]', gesture = false) => evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(from)})]
      const el = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)}) || els.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))
      if (!el) throw new Error('見つかりません: ' + ${JSON.stringify(text)})
      el.click(); return true })()`, gesture)
    // この端末の団体の一覧(lib/ohsumi/org-directory.ts)。2つ目は名前がとても長い団体
    const saveOrgs = (withSecond) => evaluate(`localStorage.setItem('ohsumi-orgs', JSON.stringify([
        { orgId: '${ORG}', gasUrl: '${GAS_URL}', source: 'default', checkedAt: Date.now(), name: 'サンプル団体' },
        ${withSecond ? `{ orgId: 'org_SECONDSECONDSECOND01', gasUrl: 'https://script.google.com/macros/s/SECOND/exec', source: 'registry', checkedAt: Date.now(), maxAgeSec: 86400,
          name: 'とても長い名前の特定非営利活動法人テスト団体ロングネームの会' },` : ''}
      ])); localStorage.setItem('ohsumi-current-org', '${ORG}')`)
    const signIn = async () => {
      await saveOrgs(false)
      await evaluate(`localStorage.setItem('ohsumi-session-${ORG}', JSON.stringify({ token: 'v1.layout.check', exp: Math.floor(Date.now() / 1000) + 86400 }))`)
    }

    await navigate('/')
    const passes = [
      { member: MEMBER, steps: STEPS },
      { member: ADMIN_MEMBER, steps: ADMIN_STEPS },
      { member: ADMIN_MEMBER, steps: REGISTRY_STEPS },
      { member: ADMIN_MEMBER, steps: READ_ONLY_STEPS, contract: READ_ONLY_CONTRACT },
    ]
    const registrySession = () => evaluate(`sessionStorage.setItem('ohsumi-registry-admin-session', JSON.stringify({ token: 'ra1.layout.check', exp: Math.floor(Date.now() / 1000) + 1800, email: 'registry.admin.with.a.long.address@example.com', authAt: Math.floor(Date.now() / 1000) }))`)
    for (const pass of passes) {
    member = pass.member
    view = viewerData(pass.member)
    for (const step of pass.steps) {
      try {
        if (step.do === 'login') { await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/') }
        if (step.do === 'loginOrgs') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await saveOrgs(true); await navigate('/')
          const shown = await evaluate(`!!document.querySelector('select option[value="org_SECONDSECONDSECOND01"]')`)
          if (!shown) throw new Error('団体を選ぶ欄が表示されません')
        }
        if (step.do === 'loginMissingOrg') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/?org=' + MISSING_ORG)
          const shown = await evaluate(`document.body.textContent.includes('団体が見つかりません')`)
          if (!shown) throw new Error('「団体が見つかりません」が表示されません')
        }
        if (step.do === 'home' || step.do === 'admin') contract = null
        if (step.do.startsWith('readOnly')) {
          contract = pass.contract
          // 経費申請には、カテゴリが1つ要る(サンプルのデータには無いので、設定に足す)
          if (step.do === 'readOnlyExpense' && !view.Settings.rows.some((r) => r[0] === 'expense_categories')) {
            view.Settings.rows.push(['expense_categories', JSON.stringify([{ id: 'travel', label: '交通費', approvalSteps: [] }])])
          }
          if (step.do !== 'readOnlyTask') {
            await signIn(); await navigate('/')
            await clickText('あとで設定する').catch(() => {})
            await sleep(800)
            // 書き出しの数を数える(ファイルは実際には保存しない)
            await evaluate(`(() => { window.__exports = 0; URL.createObjectURL = () => { window.__exports++; return 'blob:layout-check' }; HTMLAnchorElement.prototype.click = function () {}; return true })()`)
            if (!(await evaluate(`document.body.textContent.includes('アンケートへの回答をお願いします')`))) throw new Error('機能停止中の知らせが表示されません')
          }
          // 閲覧のための欄が使えて、値を変えられること
          const usable = (selector) => evaluate(`(() => {
            const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
            if (!els.length) throw new Error('見つかりません: ' + ${JSON.stringify(selector)})
            const off = els.filter((e) => e.disabled)
            if (off.length) throw new Error('使えない欄があります: ' + ${JSON.stringify(selector)})
            return els.length })()`)
          const setValue = (selector, value) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)})
            const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true })()`)
          const noNotice = async (what) => {
            if (await evaluate(`!!document.getElementById('read-only-notice-title')`)) throw new Error(what + 'で「読み取り専用のため、保存できません」が出ました')
          }
          const exported = async (label) => {
            const before = await evaluate('window.__exports')
            await clickText(label); await sleep(1500)
            if ((await evaluate('window.__exports')) <= before) throw new Error(label + ' で書き出せません')
            await noNotice(label)
          }
          if (step.do === 'readOnlyWorkspace') {
            await clickText('一覧'); await sleep(800)
            // 期間(年/月/日)・プロジェクトの選択
            await usable('input[type=date]')
            await setValue('input[type=date]', '2026-01-01'); await sleep(300)
            if ((await evaluate(`document.querySelector('input[type=date]').value`)) !== '2026-01-01') throw new Error('期間を入れられません')
            const select = `[...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.text === 'すべてのプロジェクト'))`
            if (await evaluate(`${select}.disabled`)) throw new Error('プロジェクトを選べません')
            await evaluate(`(() => { const s = ${select}; s.value = s.options[s.options.length - 1].value; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
            await sleep(300)
            // 表示項目・表示順(並び替え)
            await clickText('表示項目'); await sleep(300)
            await clickText('担当者', 'div.absolute button').catch(() => clickText('期限', 'div.absolute button')); await sleep(300)
            await noNotice('表示項目')
            await clickText('表示順'); await sleep(300)
            await clickText('優先度', 'div.absolute button'); await sleep(300)
            await noNotice('表示順')
            // 表示の切り替え
            for (const view of ['リスト', 'カレンダー', 'ガント', 'ワークフロー']) { await clickText(view); await sleep(600) }
            await noNotice('表示の切り替え')
          }
          if (step.do === 'readOnlyList') {
            await clickText('一覧'); await sleep(500)
            await clickText('リスト'); await sleep(800)
            await usable('input[placeholder]:not([type])[data-read-only-ok]')
            await exported('Excel出力')
          }
          if (step.do === 'readOnlyTask') {
            await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
            await clickText(step.view); await sleep(800)
            await clickText(step.text, 'td, span, div, button'); await sleep(1200)
            // 書く欄(コメント・説明など)は止まっている
            const open = await evaluate(`[...document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=number], input[type=file]')]
              .filter((e) => !e.closest('[data-read-only-ok]') && !e.disabled).map((e) => e.outerHTML.slice(0, 80))`)
            if (open.length) throw new Error('書く欄が使えます: ' + open.join(' / '))
            if (!(await evaluate(`document.querySelectorAll('textarea[disabled], input[data-read-only-disabled]').length`))) throw new Error('止まった書く欄がありません')
            // 編集の操作(優先度を変える)は、画面を変えずに止まり、知らせが出る(人が操作した時)
            const priority = `[...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'high') && [...s.options].some((o) => o.value === 'low'))`
            const before = await evaluate(`${priority}.value`)
            await evaluate(`(() => { const s = ${priority}; s.value = s.value === 'low' ? 'high' : 'low'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`, true)
            await sleep(500)
            if (!(await evaluate(`!!document.getElementById('read-only-notice-title')`))) throw new Error('編集の操作で「読み取り専用のため、保存できません」が出ません')
            if ((await evaluate(`${priority}.value`)) !== before) throw new Error('編集の操作で画面が変わりました')
            await clickText('閉じる', '[role=dialog] button'); await sleep(300)
          }
          // 止まった書く欄にも、画面の状態として文章を入れる(止まる前に書いていた時と同じ)
          const forceText = (finder, value) => evaluate(`(() => {
            const el = ${finder}
            if (!el) throw new Error('書く欄が見つかりません')
            if (!el.disabled) throw new Error('書く欄が使えます(止まっていません)')
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true })()`)
          // 保存の手前で止まったか: 知らせが出て、書いた文章を残し、GAS に書き込みを送らず、「保存しました」を出さない
          const expectBlocked = async (what, text) => {
            await sleep(1200)
            if (!(await evaluate(`!!document.getElementById('read-only-notice-title')`))) throw new Error(what + 'で「読み取り専用のため、保存できません」が出ません')
            if (text && !(await evaluate(`[...document.getElementById('read-only-notice-title').closest('[role=dialog]').querySelectorAll('textarea')].some((t) => t.value.includes(${JSON.stringify(text)}))`))) {
              throw new Error(what + 'で、書いた文章が知らせに残っていません')
            }
            if (sentWrites.length) throw new Error(what + 'で、GAS に書き込みを送りました: ' + sentWrites.join(', '))
            const toasts = await evaluate(`[...document.querySelectorAll('.fixed.bottom-6 > div')].map((d) => d.textContent)`)
            if (toasts.length) throw new Error(what + 'で、保存したかのような知らせが出ました: ' + toasts.join(' / '))
            await evaluate(`(() => { const d = document.getElementById('read-only-notice-title').closest('[role=dialog]'); [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '閉じる').click(); return true })()`)
            await sleep(300)
          }
          sentWrites = []
          if (step.do === 'readOnlyAddTask') {
            await clickText('INPUT'); await sleep(1000)
            if (!(await evaluate(`[...document.querySelectorAll('main textarea')].every((t) => t.disabled)`))) throw new Error('タスクを書く欄が使えます')
            await clickText('イベント準備の4タスクを入力'); await sleep(300)
            await clickText('タスクを整理する'); await sleep(2500)
            await clickText('選択したタスクを登録', 'button', true)
            await expectBlocked('タスクの追加', '')
          }
          if (step.do === 'readOnlyComment') {
            await clickText('一覧'); await sleep(500)
            await clickText(step.view); await sleep(800)
            await clickText(step.text, 'td, span, div, button'); await sleep(1200)
            const comment = 'コメントの本文です。保存できなくても消えないこと'
            await forceText(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '送信').parentElement.querySelector('textarea')`, comment)
            await sleep(300)
            await clickText('送信', 'button', true)
            await expectBlocked('コメント', comment)
          }
          if (step.do === 'readOnlyExpense') {
            await clickText('経費申請'); await sleep(1000)
            const modal = `[...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes('申請する'))`
            await evaluate(`(() => { const s = ${modal}.querySelector('select'); if (!s || !s.options.length) throw new Error('経費のカテゴリがありません'); s.value = s.options[0].value; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
            await forceText(`${modal}.querySelector('input[type=number], input[inputmode=numeric]') || [...${modal}.querySelectorAll('input')].find((i) => i.placeholder && i.placeholder.includes('3500'))`, '3500')
            const why = '会場の下見の交通費です(領収書がありません)'
            await forceText(`${modal}.querySelector('textarea')`, why)
            await sleep(300)
            await evaluate(`(() => { [...${modal}.querySelectorAll('button')].find((b) => b.textContent.trim() === '申請する').click(); return true })()`, true)
            await expectBlocked('経費申請', why)
          }
          if (step.do === 'readOnlyApprove') {
            await clickText('ADMIN'); await sleep(1500)
            await clickText('Approvals', 'aside nav button'); await sleep(1000)
            await clickText('承認する', 'button', true)
            await expectBlocked('承認', '')
          }
          if (step.do === 'readOnlyAdmin') {
            await clickText('ADMIN'); await sleep(1500)
            await exported('全データをExcel出力')
            await clickText('Members', 'aside nav button'); await sleep(1000)
            await usable('input[data-read-only-ok]')
            await clickText('日報・週報', 'aside nav button'); await sleep(1000)
            await usable('input[type=date][data-read-only-ok]')
            await clickText('人材DB', 'aside nav button'); await sleep(1000)
            await usable('th input[data-read-only-ok]')
          }
        }
        if (step.do === 'contract') {
          const c = step.contract
          contract = c.days ? { phase: c.phase, kind: c.kind, suspendAt: new Date(Date.now() + c.days * 24 * 3600 * 1000).toISOString() } : c
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          const shown = await evaluate(`document.body.textContent.includes(${JSON.stringify(step.expect)})`)
          if (!shown) throw new Error('停止の知らせが表示されません')
        }
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
        if (step.do === 'registryLogin') { await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/registry-admin/') }
        if (step.do === 'registry') { await registrySession(); await navigate('/registry-admin/') }
        if (step.do === 'registrySuspend') {
          await clickText('停止の予定を入れる…'); await sleep(500)
          const shown = await evaluate(`!!document.querySelector('input[type=datetime-local]')`)
          if (!shown) throw new Error('停止の予定を入れる欄が表示されません')
        }
        if (step.do === 'registryIssue') {
          // 団体名を入れて発行する(React の入力は、値を直接変えた後に input を送る)
          await evaluate(`(() => {
            const el = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith('団体名')).querySelector('input')
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'とても長い名前の特定非営利活動法人テスト団体ロングネームの会')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true })()`)
          await sleep(300); await clickText('発行する'); await sleep(1500)
          const shown = await evaluate(`document.body.textContent.includes('ABCD-EFGH-JKMN-PQRS')`)
          if (!shown) throw new Error('発行した登録コードが表示されません')
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
