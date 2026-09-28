// ログイン情報(セッショントークン)の保存場所と、GAS との通信での扱いを確かめる。
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

let local: MemoryStorage
let session: MemoryStorage
const disableAutoSelect = vi.fn()
const nowSec = () => Math.floor(Date.now() / 1000)

beforeEach(() => {
  vi.resetModules()
  local = new MemoryStorage()
  session = new MemoryStorage()
  disableAutoSelect.mockReset()
  vi.stubGlobal('window', {
    localStorage: local,
    sessionStorage: session,
    google: { accounts: { id: { disableAutoSelect } } },
    dispatchEvent: vi.fn(),
  })
  vi.stubEnv('NEXT_PUBLIC_GAS_URL', 'https://script.example/exec')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('セッショントークンの保存場所', () => {
  it('チェックありは localStorage、チェックなしは sessionStorage に保存し、団体ごとに分ける', async () => {
    const s = await import('./session')
    s.saveSession('org_a', { token: 'A', exp: nowSec() + 100, remember: true })
    s.saveSession('org_b', { token: 'B', exp: nowSec() + 100, remember: false })
    expect(local.getItem('ohsumi-session-org_a')).toContain('"token":"A"')
    expect(session.getItem('ohsumi-session-org_b')).toContain('"token":"B"')
    expect(local.getItem('ohsumi-session-org_b')).toBeNull()
    expect(s.loadSession('org_a')).toMatchObject({ token: 'A', remember: true })
    expect(s.loadSession('org_b')).toMatchObject({ token: 'B', remember: false })
    // 最後に保存した団体のセッションを通信に使う
    expect(s.getSessionToken()).toBe('B')
  })

  it('チェックを切り替えて保存し直すと、もう一方の保存場所からは消す', async () => {
    const s = await import('./session')
    s.saveSession('org_a', { token: 'A', exp: nowSec() + 100, remember: true })
    s.saveSession('org_a', { token: 'A2', exp: nowSec() + 100, remember: false })
    expect(local.getItem('ohsumi-session-org_a')).toBeNull()
    expect(s.loadSession('org_a')).toMatchObject({ token: 'A2', remember: false })
  })

  it('期限切れのセッションは読み込まずに消す', async () => {
    const s = await import('./session')
    local.setItem('ohsumi-session-org_a', JSON.stringify({ token: 'old', exp: nowSec() - 1 }))
    expect(s.loadSession('org_a')).toBeNull()
    expect(local.getItem('ohsumi-session-org_a')).toBeNull()
  })

  it('ログアウトで保存したトークンを消し、Google の自動ログインを止める', async () => {
    const s = await import('./session')
    s.saveSession('org_a', { token: 'A', exp: nowSec() + 100, remember: true })
    s.clearSession()
    expect(local.getItem('ohsumi-session-org_a')).toBeNull()
    expect(s.getSessionToken()).toBeNull()
    expect(disableAutoSelect).toHaveBeenCalled()
  })

  it('再読み込み後に使えるセッションがあるか(団体の設定とセッションの両方が必要)', async () => {
    const s = await import('./session')
    expect(s.hasSavedSession()).toBe(false)
    s.saveLoginConfig({ orgId: 'org_a' })
    expect(s.hasSavedSession()).toBe(false)
    s.saveSession('org_a', { token: 'A', exp: nowSec() + 100, remember: true })
    expect(s.hasSavedSession()).toBe(true)
  })

  it('「この端末にログイン情報を保存する」の初期値はチェックあり', async () => {
    const s = await import('./session')
    expect(s.loadRememberPreference()).toBe(true)
    s.saveRememberPreference(false)
    expect(s.loadRememberPreference()).toBe(false)
  })

  it('nonce は団体ID + 乱数のハッシュ(GAS と同じ計算)で、毎回変わる', async () => {
    const s = await import('./session')
    const a = await s.createLoginNonce('org_a')
    const b = await s.createLoginNonce('org_a')
    const hash = createHash('sha256').update(a.secret).digest('base64url')
    expect(a.nonce).toBe(`org_a.${hash}`)
    expect(a.secret).not.toBe(b.secret)
  })
})

describe('GAS との通信', () => {
  function mockGas(responses: Record<string, unknown>[]) {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body))
        return { text: async () => JSON.stringify(responses.shift()) }
      }),
    )
    return bodies
  }

  it('セッションがあればセッショントークンを送り、延長されたトークンに差し替える', async () => {
    const s = await import('./session')
    const remote = await import('./remote')
    s.saveSession('org_a', { token: 'old', exp: nowSec() + 100, remember: true })
    const bodies = mockGas([
      { ok: true, result: { email: 'a@example.com' }, session: { token: 'new', exp: nowSec() + 1000 } },
      { ok: true, result: { email: 'a@example.com' } },
    ])
    await remote.remoteApi.getMyEmails()
    expect(bodies[0]).toMatchObject({ action: 'getMyEmails', sessionToken: 'old' })
    expect(bodies[0]).not.toHaveProperty('authToken')
    expect(s.loadSession('org_a')).toMatchObject({ token: 'new', remember: true })
    await remote.remoteApi.getMyEmails()
    expect(bodies[1]).toMatchObject({ sessionToken: 'new' })
  })

  it('セッションが無効(authError)なら、保存したトークンを消してログイン画面に戻す合図を送る', async () => {
    const s = await import('./session')
    const remote = await import('./remote')
    s.saveSession('org_a', { token: 'revoked', exp: nowSec() + 100, remember: true })
    mockGas([{ ok: false, authError: true, error: 'この端末のログインは無効になりました' }])
    await expect(remote.remoteApi.getMyEmails()).rejects.toThrow(/無効/)
    expect(local.getItem('ohsumi-session-org_a')).toBeNull()
    const dispatch = (window as unknown as { dispatchEvent: ReturnType<typeof vi.fn> }).dispatchEvent
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: remote.SESSION_ENDED_EVENT }))
  })

  it('IDトークンを交換し、未登録のアカウントでは本人のメールだけを受け取る', async () => {
    const remote = await import('./remote')
    const bodies = mockGas([
      { ok: true, result: { memberId: null, email: 'stranger@example.com' } },
      { ok: true, result: { memberId: 'm1', version: 'v1', unchanged: true, session: { token: 't', exp: 1, remember: false } } },
    ])
    expect(await remote.exchangeIdToken('id.token.x', 'secret', true)).toEqual({ memberId: null, email: 'stranger@example.com' })
    expect(bodies[0]).toEqual({ action: 'exchangeIdToken', idToken: 'id.token.x', nonceSecret: 'secret', remember: true })
    expect(await remote.exchangeIdToken('id.token.y', 'secret', false)).toMatchObject({ memberId: 'm1', session: { token: 't' } })
  })

  it('団体の設定を取得できない(GAS が新しい方式に未対応)場合は null を返す', async () => {
    const remote = await import('./remote')
    mockGas([{ ok: false, error: 'Unknown action' }])
    expect(await remote.fetchLoginConfig()).toBeNull()
    mockGas([{ ok: true, result: { orgId: 'org_a' } }])
    expect(await remote.fetchLoginConfig()).toEqual({ orgId: 'org_a' })
  })
})

describe('Googleでログインの準備(google.accounts.id.initialize)', () => {
  type Config = { nonce: string; callback: (r: { credential?: string }) => void }
  let id: {
    initialize: ReturnType<typeof vi.fn>
    renderButton: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    disableAutoSelect: typeof disableAutoSelect
  }
  const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const idToken = (nonce: string) => `${b64url({ alg: 'RS256' })}.${b64url({ nonce, email: 'a@example.com' })}.sig`
  const lastConfig = () => id.initialize.mock.calls.at(-1)![0] as Config
  const button = { innerHTML: '' } as unknown as HTMLElement

  beforeEach(() => {
    id = { initialize: vi.fn(), renderButton: vi.fn(), prompt: vi.fn(), disableAutoSelect }
    ;(window as unknown as { google: unknown }).google = { accounts: { id, oauth2: {} } }
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', 'client.apps.googleusercontent.com')
  })

  const prepare = async (s: typeof import('./session'), onCredential = vi.fn(), onNonceMismatch = vi.fn()) => {
    await s.prepareGoogleSignIn({ orgId: 'org_a', button, shouldAutoPrompt: () => true, onCredential, onNonceMismatch })
    return { onCredential, onNonceMismatch }
  }

  it('何度呼んでも(同時に呼んでも)initialize は1回だけで、ボタンの表示だけやり直す', async () => {
    const s = await import('./session')
    await Promise.all([prepare(s), prepare(s)])
    await prepare(s)
    expect(id.initialize).toHaveBeenCalledTimes(1)
    expect(id.renderButton).toHaveBeenCalledTimes(3)
    // 自動ログイン・One Tap は準備した時の1回だけ
    expect(id.prompt).toHaveBeenCalledTimes(1)
  })

  it('IDトークンの nonce に対応する乱数を渡し、同じ乱数は2回渡さない', async () => {
    const s = await import('./session')
    const { onCredential, onNonceMismatch } = await prepare(s)
    const { nonce, callback } = lastConfig()
    callback({ credential: idToken(nonce) })
    expect(onCredential).toHaveBeenCalledTimes(1)
    const secret = onCredential.mock.calls[0][1] as string
    expect(nonce).toBe(`org_a.${createHash('sha256').update(secret).digest('base64url')}`)
    // 同じ試行の2回目は渡さない(ログイン中の処理を止めないよう、失敗の扱いにもしない)
    callback({ credential: idToken(nonce) })
    expect(onCredential).toHaveBeenCalledTimes(1)
    expect(onNonceMismatch).not.toHaveBeenCalled()
  })

  it('nonce が今の試行と違う IDトークンには、乱数を渡さない', async () => {
    const s = await import('./session')
    const { onCredential, onNonceMismatch } = await prepare(s)
    lastConfig().callback({ credential: idToken('org_a.old-attempt') })
    lastConfig().callback({ credential: 'not-a-jwt' })
    expect(onCredential).not.toHaveBeenCalled()
    expect(onNonceMismatch).toHaveBeenCalledTimes(2)
  })

  it('IDトークンを受け取った後にログイン画面が作り直されても、準備し直さない', async () => {
    const s = await import('./session')
    await prepare(s)
    lastConfig().callback({ credential: idToken(lastConfig().nonce) })
    await prepare(s)
    expect(id.initialize).toHaveBeenCalledTimes(1)
    expect(id.renderButton).toHaveBeenCalledTimes(1)
  })

  it('失敗した後(resetGoogleSignIn)とログアウトの後は、新しい nonce で準備し直す', async () => {
    const s = await import('./session')
    await prepare(s)
    const first = lastConfig().nonce
    s.resetGoogleSignIn()
    await prepare(s)
    const second = lastConfig().nonce
    s.clearSession()
    await prepare(s)
    const third = lastConfig().nonce
    expect(id.initialize).toHaveBeenCalledTimes(3)
    expect(new Set([first, second, third]).size).toBe(3)
  })
})
