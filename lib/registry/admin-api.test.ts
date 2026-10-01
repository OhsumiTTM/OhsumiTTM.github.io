// レジストリの管理画面の送り方(lib/registry/admin-api.ts)と、画面の設定(検索エンジンに載せない・本体からリンクしない)
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = join(__dirname, '..', '..')

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

let storage: MemoryStorage
beforeEach(() => {
  vi.resetModules()
  storage = new MemoryStorage()
  vi.stubGlobal('window', { sessionStorage: storage })
  vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', 'https://script.google.com/macros/s/REGISTRY/exec')
  vi.stubEnv('NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID', 'registry-client.apps.googleusercontent.com')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function load(replies: (string | Error)[]) {
  const api = await import('./admin-api')
  const bodies: Record<string, unknown>[] = []
  api.setRegistryFetchForTest(async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    const r = replies.shift()
    if (r instanceof Error) throw r
    return { status: 200, text: async () => r ?? '' }
  })
  return { api, bodies }
}

const session = { token: 'ra1.x.y', exp: Math.floor(Date.now() / 1000) + 600, email: 'a@example.com', authAt: Math.floor(Date.now() / 1000) }

describe('ログイン', () => {
  it('nonce は registry-admin. + base64url(SHA-256(乱数))(レジストリの GAS が確かめる形)', async () => {
    const { api } = await load([])
    const { nonce, secret } = await api.createAdminNonce()
    expect(secret.length).toBeGreaterThanOrEqual(40)
    expect(nonce).toBe('registry-admin.' + createHash('sha256').update(secret).digest('base64url'))
  })

  it('ログインに成功したら、セッションをこのタブ(sessionStorage)だけに保存する。期限が切れたものは読まない', async () => {
    const { api, bodies } = await load([JSON.stringify({ ok: true, result: { session } })])
    await api.adminLogin('id.token.x', 'secret')
    expect(bodies[0]).toEqual({ action: 'adminLogin', idToken: 'id.token.x', nonceSecret: 'secret' })
    expect(api.loadAdminSession()).toEqual(session)
    expect(api.loadAdminSession(session.exp)).toBeNull()
    expect(storage.data.size).toBe(0)
  })

  it('許可されていない・期限切れは authError、ログインし直しが必要な時は reauthRequired', async () => {
    const { api } = await load([
      JSON.stringify({ ok: false, error: 'このアカウントは管理者として登録されていません。', authError: true }),
      JSON.stringify({ ok: false, error: 'もう一度 Google でログインしてください', reauthRequired: true }),
    ])
    await expect(api.adminLogin('t', 's')).rejects.toMatchObject({ authError: true, message: expect.stringMatching(/管理者として登録されていません/) })
    await expect(api.issueRegistrationCode(session, { orgName: 'A', contactName: '', contactEmail: '', note: '' })).rejects.toMatchObject({ reauthRequired: true })
  })

  it('5分を過ぎたログインでは、発行の前にログインし直す', async () => {
    const { api } = await load([])
    expect(api.needsReauth(session, session.authAt + 300)).toBe(false)
    expect(api.needsReauth(session, session.authAt + 301)).toBe(true)
  })
})

describe('送り直し', () => {
  it('一覧(読み取り)は、JSON が返らない・GET に送り返された時に2回まで送り直す', async () => {
    const { api, bodies } = await load(['<html>error</html>', JSON.stringify({ ok: false, getReceived: true }), JSON.stringify({ ok: true, result: { orgs: [] } })])
    expect(await api.adminOverview(session)).toEqual({ orgs: [] })
    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toEqual({ action: 'adminOverview', session: 'ra1.x.y' })
  })

  it('登録コードの発行(書き込み)は送り直さない(二重に発行しないため)', async () => {
    const { api, bodies } = await load([new Error('network'), JSON.stringify({ ok: true, result: { code: 'X' } })])
    await expect(api.issueRegistrationCode(session, { orgName: 'A', contactName: '', contactEmail: '', note: '' })).rejects.toThrow(/応答を受け取れませんでした/)
    expect(bodies).toHaveLength(1)
  })

  it('発行の途中でログインし直す時の入力は、このタブに一度だけ残す', async () => {
    const { api } = await load([])
    api.saveIssueDraft({ orgName: 'A', contactName: 'B', contactEmail: '', note: 'C' })
    expect(api.takeIssueDraft()).toEqual({ orgName: 'A', contactName: 'B', contactEmail: '', note: 'C' })
    expect(api.takeIssueDraft()).toBeNull()
  })
})

describe('停止の予定(R1-e)', () => {
  it('停止の予定を入れる・取り消す(書き込みなので送り直さない)', async () => {
    const { api, bodies } = await load([
      JSON.stringify({ ok: true, result: { orgId: 'org_A', state: 'scheduled' } }),
      new Error('network'),
      JSON.stringify({ ok: true, result: {} }),
    ])
    const input = { orgId: 'org_A', kind: 'restrict' as const, suspendAt: '2026-11-01T00:00:00.000Z', reason: 'アンケートの未回答' }
    expect(await api.scheduleSuspension(session, input)).toMatchObject({ state: 'scheduled' })
    expect(bodies[0]).toEqual({ action: 'scheduleSuspension', session: session.token, ...input })
    await expect(api.clearSuspension(session, 'org_A', '回答を確認')).rejects.toThrow(/応答を受け取れませんでした/)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual({ action: 'clearSuspension', session: session.token, orgId: 'org_A', reason: '回答を確認' })
  })

  it('提供停止を当日に(確認の画面を経た時だけ。confirm を付ける)・プランの記録。どちらも送り直さない', async () => {
    const { api, bodies } = await load([
      JSON.stringify({ ok: true, result: { orgId: 'org_A', state: 'suspended' } }),
      new Error('network'),
      JSON.stringify({ ok: true, result: {} }),
    ])
    expect(await api.suspendNow(session, 'org_A', '規約違反')).toMatchObject({ state: 'suspended' })
    expect(bodies[0]).toEqual({ action: 'scheduleSuspension', session: session.token, orgId: 'org_A', kind: 'suspend', immediate: true, confirm: true, reason: '規約違反' })
    await expect(api.setOrgPlan(session, 'org_A', 'paid', '契約')).rejects.toThrow(/応答を受け取れませんでした/)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual({ action: 'setOrgPlan', session: session.token, orgId: 'org_A', plan: 'paid', reason: '契約' })
  })

  it('入れられるいちばん早い日時は、今から14日後(datetime-local の形)', async () => {
    const { api } = await load([])
    const now = new Date(2026, 9, 1, 9, 30).getTime()
    expect(api.earliestSuspendLocal(now)).toBe('2026-10-15T09:31')
  })

  it('停止の予定の入力の途中でログインし直す時の入力は、このタブに一度だけ残す', async () => {
    const { api } = await load([])
    const input = { orgId: 'org_A', kind: 'suspend' as const, suspendAt: '2026-11-01T09:00', reason: '契約の終了' }
    api.saveSuspensionDraft(input)
    expect(api.takeSuspensionDraft()).toEqual(input)
    expect(api.takeSuspensionDraft()).toBeNull()
  })
})

describe('管理画面の置き方', () => {
  it('検索エンジンに載せない(noindex・nofollow)', () => {
    const page = readFileSync(join(ROOT, 'app', 'registry-admin', 'page.tsx'), 'utf8')
    expect(page).toMatch(/robots: \{ index: false, follow: false/)
  })

  it('Ohsumi 本体の画面(app・components/ohsumi・content)から、管理画面へのリンクが無い', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(tsx?|md)$/.test(f)) files.push(p)
      }
    }
    for (const d of ['app', join('components', 'ohsumi'), 'content']) walk(join(ROOT, d))
    const linking = files.filter((f) => !f.includes('registry-admin') && readFileSync(f, 'utf8').includes('registry-admin'))
    expect(linking).toEqual([])
  })
})

describe('mailLevelCounts', () => {
  it('メールの上限に達した団体・残りが少ない団体を数える(伝えられていない団体は数えない)', async () => {
    const { mailLevelCounts } = await import('./admin-api')
    const m = (level: 'reached' | 'low' | 'ok' | 'unknown') => ({ mail: { remaining: null, skipped: 0, date: '', limitDate: '', level } })
    expect(mailLevelCounts([m('reached'), m('low'), m('low'), m('ok'), m('unknown'), {}])).toEqual({ reached: 1, low: 2 })
  })
})
