// 営業用のデモ(/demo/)の確かめ。
//   - ブラウザの中の団体の GAS(scripts/demo-gas.mjs が作るスクリプト + lib/demo/google-env.ts の偽のサービス)が、
//     見本データで立ち上がり、本物と同じ手順でログイン・書き込み・画像のアップロードができること
//   - 保存した状態から作り直しても続きから使えること
//   - デモのビルドの設定(外につながない・本番に混ざらない)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDemoGasScript, DEMO_GAS_GLOBALS } from '../../scripts/demo-gas.mjs'
import { DEMO_REGISTRY_URL as BUILD_REGISTRY_URL } from '../../scripts/demo-config.mjs'
import { buildPolicy } from '../../scripts/csp.mjs'
import * as check from '../../scripts/check-no-demo-login.mjs'
import { CLIENT_VERSION } from '../ohsumi/codes'
import { DEMO_CLIENT_ID, DEMO_GAS_URL, DEMO_ORG_ID, DEMO_REGISTRY_URL } from './config'
import { createDemoOrg, DEMO_ACCOUNTS, type DemoGasFactory } from './engine'
import { demo } from './entry'
import { base64UrlOf, createGoogleEnv, sha256Base64Url } from './google-env'
import { hmacSha256, sha256 } from './sha256'
import { createHash, createHmac } from 'node:crypto'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function loadFactory(): DemoGasFactory {
  const script = buildDemoGasScript(read('gas/Code.gs'), read('gas/SampleData.gs'))
  const self: Record<string, unknown> = {}
  new Function('self', script)(self)
  return self.__ohsumiDemoGas as DemoGasFactory
}
const OPTS = { orgId: DEMO_ORG_ID, gasUrl: DEMO_GAS_URL, registryUrl: DEMO_REGISTRY_URL, clientId: DEMO_CLIENT_ID }
type Res = { ok: boolean; error?: string; result?: any }

function startDemo() {
  const org = createDemoOrg(loadFactory(), OPTS)
  const post = (b: Record<string, unknown>) => org.post({ clientVersion: CLIENT_VERSION, ...b }) as Res
  let seq = 0
  // デモのログイン画面と同じ手順(nonce = 団体ID + '.' + SHA-256(この画面の乱数))
  const login = (email: string) => {
    const secret = 'demo-secret-' + crypto.randomUUID()
    const idToken = base64UrlOf('{"alg":"none"}') + '.' + base64UrlOf(JSON.stringify({ email, nonce: DEMO_ORG_ID + '.' + sha256Base64Url(secret) })) + '.demo'
    return post({ action: 'exchangeIdToken', idToken, nonceSecret: secret, remember: true, requestId: 'login-' + ++seq })
  }
  return { org, post, login }
}

describe('ブラウザの中の団体の GAS', () => {
  it('見本データで立ち上がり、ログインできる枠の人だけが入れる', () => {
    const { post, login } = startDemo()
    expect(post({ action: 'getLoginConfig' }).result.orgId).toBe(DEMO_ORG_ID)
    expect(login(DEMO_ACCOUNTS.top).result.memberId).toBe('demo-m-01')
    expect(login(DEMO_ACCOUNTS.base).result.memberId).toBe('demo-m-05')
    expect(login(DEMO_ACCOUNTS.base_en).result.memberId).toBe('demo-m-06')
    // 枠に無いアドレスは、本物と同じく「登録されていない」
    expect(login('someone@example.com').result.memberId).toBeFalsy()
    // ログインできる枠のアドレスは、実在しない example.com だけ
    for (const email of Object.values(DEMO_ACCOUNTS)) expect(email).toMatch(/@example\.com$/)
  })

  it('偽の ID トークンでも、nonce が違えば断る(本物と同じ確かめを通している)', () => {
    const { post } = startDemo()
    const idToken = base64UrlOf('{}') + '.' + base64UrlOf(JSON.stringify({ email: DEMO_ACCOUNTS.top, nonce: DEMO_ORG_ID + '.wrong' })) + '.demo'
    const res = post({ action: 'exchangeIdToken', idToken, nonceSecret: 'x'.repeat(20), remember: true })
    expect(res.ok).toBe(false)
  })

  it('一般のメンバーは、代表だけの操作ができない(権限の絞り込みも本物のまま)', () => {
    const { post, login } = startDemo()
    const top = login(DEMO_ACCOUNTS.top).result.session.token
    expect(post({ action: 'getUsageStatus', sessionToken: top }).ok).toBe(true)
    const base = login(DEMO_ACCOUNTS.base).result.session.token
    expect(post({ action: 'getUsageStatus', sessionToken: base }).ok).toBe(false)
  })

  it('画像をアップロードして読み出せ、保存した状態から作り直しても続きから使える', () => {
    const { org, post, login } = startDemo()
    const token = login(DEMO_ACCOUNTS.top).result.session.token
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const up = post({ action: 'uploadAvatar', sessionToken: token, requestId: 'up-1', memberId: 'demo-m-01', dataUrl: png, filename: 'a.png' })
    expect(up.ok).toBe(true)
    const id = /\/d\/([A-Za-z0-9_-]+)/.exec(up.result.url)![1]
    expect(post({ action: 'getFiles', sessionToken: token, fileIds: [id] }).result[0]).toMatchObject({ ok: true, mimeType: 'image/png' })

    const saved = JSON.parse(JSON.stringify(org.state()))
    const again = createDemoOrg(loadFactory(), { ...OPTS, state: saved })
    const got = again.post({ clientVersion: CLIENT_VERSION, action: 'getFiles', sessionToken: token, fileIds: [id] }) as Res
    expect(got.result[0]).toMatchObject({ ok: true, mimeType: 'image/png' })
    // 保存する状態は、sessionStorage に入る大きさ
    expect(JSON.stringify(saved).length).toBeLessThan(1_000_000)
  })

  it('外には通信しない(UrlFetchApp は tokeninfo の偽物以外、使えない応答を返すだけ)', () => {
    const env = createGoogleEnv({ gasUrl: DEMO_GAS_URL, clientId: DEMO_CLIENT_ID, state: { name: 'x', sheets: {}, props: {}, cache: [] } })
    const fetchApp = env.env.UrlFetchApp as { fetch: (u: string) => { getResponseCode: () => number } }
    expect(fetchApp.fetch('https://script.google.com/macros/s/REAL/exec').getResponseCode()).toBe(503)
    // GAS に渡す名前は、偽のサービスにすべてある
    for (const name of DEMO_GAS_GLOBALS) expect(env.env).toHaveProperty(name)
  })

  it('SHA-256・HMAC は node と同じ結果', () => {
    for (const text of ['', 'abc', 'あいう'.repeat(50), 'x'.repeat(1000)]) {
      const bytes = new TextEncoder().encode(text)
      expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(createHash('sha256').update(text).digest('hex'))
      const key = new TextEncoder().encode('k'.repeat(text.length % 100 + 1))
      expect(Buffer.from(hmacSha256(key, bytes)).toString('hex')).toBe(createHmac('sha256', Buffer.from(key)).update(text).digest('hex'))
    }
  })
})

describe('デモのビルドの設定', () => {
  it('本番のビルドでは、デモの部品は無い(next.config.mjs がデモの時だけ差し替える)', () => {
    expect(demo).toBeNull()
    const config = read('next.config.mjs')
    expect(config).toContain("'@/lib/demo/entry': './lib/demo/entry.demo.tsx'")
    expect(existsSync(join(ROOT, 'lib/demo/entry.demo.tsx'))).toBe(true)
    expect(config).toMatch(/isDemo\s*\?/)
  })

  it('目印・設定の値が、スクリプトと画面でそろっている', () => {
    expect(read('lib/demo/runtime.ts')).toContain(`DEMO_RUNTIME_MARKER = '${check.DEMO_RUNTIME_MARKER}'`)
    expect(read('lib/demo/entry.demo.tsx')).toMatch(/data-demo=\{DEMO_RUNTIME_MARKER\}/)
    expect(BUILD_REGISTRY_URL).toBe(DEMO_REGISTRY_URL)
  })

  it('デモの CSP は、同じサイトにしか接続できず、Google のスクリプト・iframe も許さない', () => {
    const policy = buildPolicy({ demo: true })
    expect(policy).toMatch(/connect-src 'self';/)
    expect(policy).not.toContain('accounts.google.com')
    expect(policy).toContain("frame-src 'none'")
    // 本番は今まで通り
    expect(buildPolicy()).toContain('https://script.google.com')
  })

  it('デモのビルドには、本番の接続先・Secrets を渡さない', () => {
    const script = read('scripts/build-demo.mjs')
    for (const name of ['NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', 'NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_FEEDBACK_FORM_URL', 'NEXT_PUBLIC_GAS_URL']) {
      expect(script).toMatch(new RegExp(`${name}: ''`))
    }
    expect(script).toContain('NEXT_PUBLIC_REGISTRY_URL: DEMO_REGISTRY_URL')
    // デプロイでは、デモのビルドに Secrets を渡さない
    const deploy = read('.github/workflows/deploy.yml')
    const step = deploy.slice(deploy.indexOf('- name: Build demo'), deploy.indexOf('- name: Build static site'))
    expect(step).not.toContain('secrets.')
  })

  it('デモの見本データは gas/sample のもの(実在の人の名前が入った lib/ohsumi/seed.ts は使わない)', () => {
    for (const f of ['lib/demo/runtime.ts', 'lib/demo/engine.ts', 'lib/demo/entry.demo.tsx', 'lib/demo/google-env.ts']) {
      expect(read(f)).not.toMatch(/ohsumi\/seed/)
    }
  })
})
