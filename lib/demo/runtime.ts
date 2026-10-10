// デモのビルドだけで動く部分(lib/demo/entry.demo.tsx が最初に読み込む)。画面のほかのコードより前に、次を差し替える:
//   1. localStorage・sessionStorage を、デモ専用のメモリの保存に替える。中身はブラウザの本物の sessionStorage の
//      'ohsumi-demo:' で始まる名前にだけ書く(タブを閉じると消える)。同じサイトの本番の Ohsumi のログイン・団体の一覧は、
//      読みも書きもしない
//   2. fetch を包み、デモのレジストリ・団体の GAS(実在しない URL)への通信を、ブラウザの中の GAS(engine.ts)に渡す。
//      同じサイト以外への通信は、すべて断る(本物のレジストリ・Google・フォームなどには送らない)
import {
  DEMO_BASE_PATH,
  DEMO_CLIENT_ID,
  DEMO_GAS_URL,
  DEMO_ORG_ID,
  DEMO_REGISTRY_URL,
  DEMO_STORAGE_PREFIX,
} from './config'
import { createDemoOrg, DEMO_ORG_NAME, type DemoGasFactory, type DemoOrg } from './engine'
import type { DemoGasState } from './google-env'

// 本番のビルドに、デモの部品が入っていないことを確かめる目印(scripts/check-no-demo-login.mjs と同じ文字列)。
// デモの画面に data-demo として出す(デモのビルドには、必ず入っている)
export const DEMO_RUNTIME_MARKER = 'ohsumi-demo-runtime-only-in-demo-build'

const GAS_STATE_KEY = DEMO_STORAGE_PREFIX + 'gas'

// ---- 保存 ----------------------------------------------------------------------

class DemoStorage implements Storage {
  private map: Map<string, string>
  constructor(private backing: Storage | null, private backingKey: string) {
    let entries: [string, string][] = []
    try { entries = JSON.parse(backing?.getItem(backingKey) ?? '[]') } catch { /* 読めなければ空から */ }
    this.map = new Map(Array.isArray(entries) ? entries : [])
  }
  private persist() {
    try { this.backing?.setItem(this.backingKey, JSON.stringify([...this.map])) } catch { /* 保存できなくても、このページの間は使える */ }
  }
  get length() { return this.map.size }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(k: string) { return this.map.has(String(k)) ? this.map.get(String(k))! : null }
  setItem(k: string, v: string) { this.map.set(String(k), String(v)); this.persist() }
  removeItem(k: string) { this.map.delete(String(k)); this.persist() }
  clear() { this.map.clear(); this.persist() }
}

let realSession: Storage | null = null

function installStorage() {
  try { realSession = window.sessionStorage } catch { realSession = null }
  const local = new DemoStorage(realSession, DEMO_STORAGE_PREFIX + 'local')
  const session = new DemoStorage(realSession, DEMO_STORAGE_PREFIX + 'session')
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => local })
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => session })
  // デモの団体を、この端末の団体の一覧に入れておく(招待リンクを開かなくても、すぐにログイン画面になる)
  if (!local.getItem('ohsumi-orgs')) {
    local.setItem('ohsumi-orgs', JSON.stringify([{
      orgId: DEMO_ORG_ID, gasUrl: DEMO_GAS_URL, name: DEMO_ORG_NAME, source: 'registry', checkedAt: Date.now(), maxAgeSec: 10 * 365 * 24 * 3600,
    }]))
  }
  if (!local.getItem('ohsumi-current-org')) local.setItem('ohsumi-current-org', DEMO_ORG_ID)
}

/** 最初からやり直す: デモの保存(本物の sessionStorage の 'ohsumi-demo:' で始まるもの)を消して、読み込み直す */
export function resetDemo() {
  try {
    const s = realSession
    if (s) for (const k of Object.keys(s)) if (k.startsWith(DEMO_STORAGE_PREFIX)) s.removeItem(k)
  } catch { /* ignore */ }
  window.location.href = DEMO_BASE_PATH + '/'
}

// ---- ブラウザの中の団体の GAS ------------------------------------------------------

let orgPromise: Promise<DemoOrg> | null = null

function loadFactory(): Promise<DemoGasFactory> {
  const w = window as unknown as { __ohsumiDemoGas?: DemoGasFactory }
  if (w.__ohsumiDemoGas) return Promise.resolve(w.__ohsumiDemoGas)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = DEMO_BASE_PATH + '/demo-gas.js'
    s.onload = () => (w.__ohsumiDemoGas ? resolve(w.__ohsumiDemoGas) : reject(new Error('デモの準備ができませんでした')))
    s.onerror = () => reject(new Error('デモの準備ができませんでした。読み込み直してください。'))
    document.head.appendChild(s)
  })
}

function demoOrg(): Promise<DemoOrg> {
  orgPromise ??= loadFactory().then((factory) => {
    let state: DemoGasState | null = null
    try { state = JSON.parse(realSession?.getItem(GAS_STATE_KEY) ?? 'null') } catch { state = null }
    const org = createDemoOrg(factory, { gasUrl: DEMO_GAS_URL, registryUrl: DEMO_REGISTRY_URL, clientId: DEMO_CLIENT_ID, orgId: DEMO_ORG_ID, state })
    saveState(org)
    return org
  })
  orgPromise.catch(() => { orgPromise = null })
  return orgPromise
}

function saveState(org: DemoOrg) {
  try { realSession?.setItem(GAS_STATE_KEY, JSON.stringify(org.state())) } catch { /* 保存できなくても、このページの間は使える */ }
}

// ---- 通信 ----------------------------------------------------------------------

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

async function bodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (init?.body != null) return typeof init.body === 'string' ? init.body : await new Response(init.body).text()
  return input instanceof Request ? await input.text() : ''
}

async function handleGas(text: string) {
  const org = await demoOrg()
  let body: Record<string, unknown>
  try { body = JSON.parse(text || '{}') } catch { return { ok: false, error: '送った内容を読めませんでした' } }
  const out = org.post(body)
  saveState(org)
  return out
}

function handleRegistry(text: string) {
  let body: { action?: string; orgId?: string } = {}
  try { body = JSON.parse(text || '{}') } catch { /* 下で断る */ }
  if (body.action === 'resolveOrg' && body.orgId === DEMO_ORG_ID) {
    return { ok: true, result: { orgId: DEMO_ORG_ID, gasUrl: DEMO_GAS_URL, status: 'active', checkedAt: new Date().toISOString(), maxAgeSec: 24 * 3600 } }
  }
  if (body.action === 'resolveOrg') return { ok: false, notFound: true, error: 'デモの団体ではありません' }
  return { ok: false, error: 'デモではレジストリにつながりません' }
}

function installFetch() {
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(DEMO_GAS_URL)) return json(await handleGas(await bodyText(input, init)))
    if (url.startsWith(DEMO_REGISTRY_URL)) return json(handleRegistry(await bodyText(input, init)))
    let sameOrigin = false
    try { sameOrigin = new URL(url, window.location.href).origin === window.location.origin } catch { sameOrigin = false }
    if (sameOrigin) return realFetch(input, init)
    throw new TypeError('デモでは、外部のサービスにはつなぎません')
  }
}

if (typeof window !== 'undefined') {
  installStorage()
  installFetch()
  // 開いたらすぐ準備を始める(ログイン画面の「団体の確認」を待たせない)
  void demoOrg().catch(() => { /* ログイン画面がエラーを出す */ })
}
