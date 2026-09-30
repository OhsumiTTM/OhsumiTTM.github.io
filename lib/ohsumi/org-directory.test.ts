// 接続先の団体(lib/ohsumi/org-directory.ts。R1-d)を確かめる:
// 招待リンク・この端末の団体の一覧・既定の団体から使う団体を決めること、レジストリへの問い合わせ、
// 古い接続先の裏での確かめ直し、団体の切り替え、GAS への送り先が団体ごとに分かれること
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

const ORG_A = 'org_AAAAAAAAAAAAAAAAAAAA'
const ORG_B = 'org_BBBBBBBBBBBBBBBBBBBB'
const DEFAULT_URL = 'https://script.google.com/macros/s/DEFAULT/exec'
const URL_A = 'https://script.google.com/macros/s/AKfyA/exec'
const URL_A2 = 'https://script.google.com/macros/s/AKfyA2/exec'
const URL_B = 'https://script.google.com/macros/s/AKfyB/exec'
const REGISTRY = 'https://script.google.com/macros/s/REGISTRY/exec'
const HOUR = 3600_000

let local: MemoryStorage
let session: MemoryStorage
let location: { href: string; search: string }
const replaceState = vi.fn()
const events: CustomEvent[] = []

function setUrl(search: string) {
  location.search = search
  location.href = 'https://site.example/' + search
}

beforeEach(() => {
  vi.resetModules()
  local = new MemoryStorage()
  session = new MemoryStorage()
  location = { href: 'https://site.example/', search: '' }
  replaceState.mockReset()
  events.length = 0
  vi.stubGlobal('window', {
    localStorage: local,
    sessionStorage: session,
    location,
    history: { state: null, replaceState },
    dispatchEvent: (e: CustomEvent) => { events.push(e); return true },
  })
  vi.stubGlobal('CustomEvent', class<T> { type: string; detail: T; constructor(type: string, init: { detail: T }) { this.type = type; this.detail = init.detail } })
  vi.stubEnv('NEXT_PUBLIC_GAS_URL', DEFAULT_URL)
  vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', REGISTRY)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const load = () => import('./org-directory')
const saved = (orgId: string, gasUrl: string, extra: Record<string, unknown> = {}) =>
  ({ orgId, gasUrl, source: 'registry' as const, checkedAt: Date.now(), maxAgeSec: 86400, ...extra })

// レジストリの偽物: 団体ID → 返事(文字列を返すと、その文字列をそのまま返す)
function registry(d: Awaited<ReturnType<typeof load>>, answers: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = []
  d.setOrgDirectoryFetchForTest(async (url, init) => {
    expect(url).toBe(REGISTRY)
    const body = JSON.parse(String(init.body))
    calls.push(body)
    const a = answers[body.orgId]
    return { text: async () => (typeof a === 'string' ? a : JSON.stringify(a ?? { ok: false, notFound: true })) }
  })
  return calls
}
const found = (orgId: string, gasUrl: string) => ({ ok: true, result: { orgId, gasUrl, status: 'active', channel: 'standard', checkedAt: new Date().toISOString(), maxAgeSec: 86400 } })

describe('招待リンク(?org=)', () => {
  it('団体ID の形のものだけを受け付ける', async () => {
    const d = await load()
    expect(d.readInviteOrgId('?org=' + ORG_A)).toBe(ORG_A)
    expect(d.readInviteOrgId('?x=1')).toBeNull()
    for (const bad of ['?org=', '?org=org_short', '?org=' + ORG_A + '%2F', '?org=abc']) expect(d.readInviteOrgId(bad), bad).toBe('invalid')
  })

  it('開いた後は、アドレスバーから ?org= を消す(ほかのパラメーターは残す)', async () => {
    setUrl('?org=' + ORG_A + '&lang=en')
    const d = await load()
    d.stripInviteParam()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?lang=en')
  })

  it('招待リンクの形', async () => {
    const d = await load()
    expect(d.inviteLink('https://site.example', '', ORG_A)).toBe('https://site.example/?org=' + ORG_A)
  })
})

describe('使う団体を決める(decideStartOrg)', () => {
  const now = Date.now()
  it('招待リンクの団体が一覧にあれば、問い合わせずに使う(古ければ裏で確かめ直す)', async () => {
    const d = await load()
    const fresh = saved(ORG_A, URL_A)
    const old = saved(ORG_A, URL_A, { checkedAt: now - 25 * HOUR })
    expect(d.decideStartOrg({ invite: ORG_A, saved: [fresh], currentId: null, defaultGasUrl: DEFAULT_URL, now })).toEqual({ kind: 'use', org: fresh, refresh: false })
    expect(d.decideStartOrg({ invite: ORG_A, saved: [old], currentId: null, defaultGasUrl: DEFAULT_URL, now })).toEqual({ kind: 'use', org: old, refresh: true })
  })

  it('招待リンクの団体が一覧に無ければ、レジストリの答えを待つ。形が違えば使わない', async () => {
    const d = await load()
    expect(d.decideStartOrg({ invite: ORG_B, saved: [saved(ORG_A, URL_A)], currentId: ORG_A, defaultGasUrl: DEFAULT_URL, now })).toEqual({ kind: 'resolve', orgId: ORG_B })
    expect(d.decideStartOrg({ invite: 'invalid', saved: [], currentId: null, defaultGasUrl: DEFAULT_URL, now }).kind).toBe('invalidInvite')
  })

  it('招待リンクが無ければ、今の団体 → 既定の団体 → 一覧の先頭の順', async () => {
    const d = await load()
    const a = saved(ORG_A, URL_A)
    const def = saved(ORG_B, DEFAULT_URL, { source: 'default' })
    expect(d.decideStartOrg({ invite: null, saved: [def, a], currentId: ORG_A, defaultGasUrl: DEFAULT_URL, now })).toMatchObject({ kind: 'use', org: a })
    expect(d.decideStartOrg({ invite: null, saved: [a, def], currentId: null, defaultGasUrl: DEFAULT_URL, now })).toMatchObject({ kind: 'use', org: def, refresh: false })
    expect(d.decideStartOrg({ invite: null, saved: [a], currentId: null, defaultGasUrl: DEFAULT_URL, now })).toEqual({ kind: 'default' })
    expect(d.decideStartOrg({ invite: null, saved: [a], currentId: null, defaultGasUrl: '', now })).toMatchObject({ kind: 'use', org: a })
    expect(d.decideStartOrg({ invite: null, saved: [], currentId: null, defaultGasUrl: '', now })).toEqual({ kind: 'none' })
  })

  it('既定の団体は、レジストリに確かめ直さない', async () => {
    const d = await load()
    expect(d.isStale(saved(ORG_B, DEFAULT_URL, { source: 'default', checkedAt: 0 }), now)).toBe(false)
  })
})

describe('ページを開いた時(startOrg)', () => {
  it('招待リンクの団体が一覧にあれば、その団体の GAS に送るようにし、今の団体にする。何度呼んでも同じ答え', async () => {
    local.setItem('ohsumi-orgs', JSON.stringify([saved(ORG_A, URL_A), saved(ORG_B, URL_B)]))
    setUrl('?org=' + ORG_B)
    const d = await load()
    expect(d.getActiveGasUrl()).toBe(DEFAULT_URL)
    const first = d.startOrg()
    expect(first).toMatchObject({ kind: 'use', org: { orgId: ORG_B } })
    expect(d.getActiveOrg()).toEqual({ orgId: ORG_B, gasUrl: URL_B })
    expect(local.getItem('ohsumi-current-org')).toBe(ORG_B)
    expect(replaceState).toHaveBeenCalled()
    setUrl('?org=' + ORG_A)
    expect(d.startOrg()).toBe(first)
  })

  it('R1-d より前の端末: 既定の団体の団体ID を一覧に移し、そのままログインしたままにする', async () => {
    local.setItem('ohsumi-login-config', JSON.stringify({ orgId: ORG_A }))
    local.setItem('ohsumi-session-' + ORG_A, JSON.stringify({ token: 't', exp: Math.floor(Date.now() / 1000) + 100 }))
    const s = await import('./session')
    expect(s.hasSavedSession()).toBe(true)
    const d = await load()
    expect(d.loadSavedOrgs()).toMatchObject([{ orgId: ORG_A, gasUrl: DEFAULT_URL, source: 'default' }])
    expect(d.getActiveOrg()).toEqual({ orgId: ORG_A, gasUrl: DEFAULT_URL })
    expect(local.getItem('ohsumi-login-config')).toBeNull()
  })

  it('一覧の壊れた項目(形の違う団体ID・接続先)は使わない', async () => {
    local.setItem('ohsumi-orgs', JSON.stringify([
      saved('org_x', URL_A),
      saved(ORG_A, 'https://script.google.com/macros/u/1/s/X/exec'),
      saved(ORG_B, URL_B),
      'junk',
    ]))
    const d = await load()
    expect(d.loadSavedOrgs().map((o) => o.orgId)).toEqual([ORG_B])
  })
})

describe('レジストリへの問い合わせ(resolveOrg)', () => {
  it('答えの団体ID・接続先の形を確かめて使う', async () => {
    const d = await load()
    registry(d, {
      [ORG_A]: found(ORG_A, URL_A),
      [ORG_B]: found(ORG_A, URL_B), // 別の団体の答え
      org_CCCCCCCCCCCCCCCCCCCC: found('org_CCCCCCCCCCCCCCCCCCCC', 'https://script.google.com/macros/s/X/dev'),
    })
    expect(await d.resolveOrg(ORG_A)).toMatchObject({ kind: 'found', gasUrl: URL_A, maxAgeSec: 86400 })
    expect(await d.resolveOrg(ORG_B)).toEqual({ kind: 'unavailable' })
    expect(await d.resolveOrg('org_CCCCCCCCCCCCCCCCCCCC')).toEqual({ kind: 'unavailable' })
  })

  it('見つからない・停止中は、それぞれの答え。JSON が返らなければ1回だけ送り直し、だめなら「確認できない」', async () => {
    const d = await load()
    const calls = registry(d, {
      [ORG_A]: { ok: true, result: { orgId: ORG_A, gasUrl: '', status: 'suspended' } },
      [ORG_B]: '<html>error</html>',
    })
    expect(await d.resolveOrg(ORG_A)).toEqual({ kind: 'suspended' })
    expect(await d.resolveOrg('org_CCCCCCCCCCCCCCCCCCCC')).toEqual({ kind: 'notFound' })
    expect(await d.resolveOrg(ORG_B)).toEqual({ kind: 'unavailable' })
    expect(calls.filter((c) => c.orgId === ORG_B)).toHaveLength(2)
    expect(calls.every((c) => c.action === 'resolveOrg')).toBe(true)
  })

  it('初めての団体は、その GAS の団体ID が同じ時だけ使う', async () => {
    const d = await load()
    registry(d, { [ORG_A]: found(ORG_A, URL_A) })
    expect(await d.resolveAndActivate(ORG_A, async () => ORG_B)).toEqual({ status: 'mismatch' })
    expect(d.loadSavedOrgs()).toEqual([])
    expect(d.getActiveGasUrl()).toBe(DEFAULT_URL)
    expect(await d.resolveAndActivate(ORG_A, async () => null)).toEqual({ status: 'unavailable' })
    const asked: string[] = []
    const ok = await d.resolveAndActivate(ORG_A, async (url) => { asked.push(url); return ORG_A })
    expect(asked).toEqual([URL_A])
    expect(ok).toMatchObject({ status: 'ok', org: { orgId: ORG_A, gasUrl: URL_A, source: 'registry' } })
    expect(d.getActiveOrg()).toEqual({ orgId: ORG_A, gasUrl: URL_A })
    expect(local.getItem('ohsumi-current-org')).toBe(ORG_A)
  })
})

describe('古い接続先の確かめ直し(refreshInBackground)', () => {
  const old = () => saved(ORG_A, URL_A, { checkedAt: Date.now() - 25 * HOUR, name: '団体A' })

  it('同じなら、確かめた時刻だけ新しくする(ログインはそのまま)', async () => {
    const d = await load()
    registry(d, { [ORG_A]: found(ORG_A, URL_A) })
    await d.refreshInBackground(old())
    expect(d.loadSavedOrgs()[0]).toMatchObject({ orgId: ORG_A, gasUrl: URL_A, name: '団体A' })
    expect(d.loadSavedOrgs()[0].checkedAt).toBeGreaterThan(Date.now() - 60_000)
    expect(events).toHaveLength(0)
  })

  it('接続先が変わったら新しい接続先を保存し、ログインし直してもらう(知らせを送る)', async () => {
    const d = await load()
    d.upsertSavedOrg(old())
    registry(d, { [ORG_A]: found(ORG_A, URL_A2) })
    await d.refreshInBackground(old())
    expect(d.loadSavedOrgs()[0].gasUrl).toBe(URL_A2)
    expect(events.map((e) => [e.type, e.detail])).toEqual([['ohsumi:org-changed', { orgId: ORG_A, notice: 'orgMoved' }]])
  })

  it('停止中・見つからない時は一覧から外し、知らせる', async () => {
    const d = await load()
    d.upsertSavedOrg(old())
    registry(d, { [ORG_A]: { ok: true, result: { orgId: ORG_A, gasUrl: '', status: 'suspended' } } })
    await d.refreshInBackground(old())
    expect(d.loadSavedOrgs()).toEqual([])
    expect(events[0].detail).toEqual({ orgId: ORG_A, notice: 'orgSuspended' })
  })

  it('レジストリが止まっている時は、保存した接続先を使い続ける', async () => {
    const d = await load()
    d.upsertSavedOrg(old())
    registry(d, { [ORG_A]: '<html>' })
    await d.refreshInBackground(old())
    expect(d.loadSavedOrgs()[0].gasUrl).toBe(URL_A)
    expect(events).toHaveLength(0)
  })

  it('ページを開いた時に古ければ、裏で確かめ直す(待たずに保存した接続先を使う)', async () => {
    local.setItem('ohsumi-orgs', JSON.stringify([old()]))
    local.setItem('ohsumi-current-org', ORG_A)
    const d = await load()
    const calls = registry(d, { [ORG_A]: found(ORG_A, URL_A) })
    expect(d.startOrg()).toMatchObject({ kind: 'use', refresh: true })
    expect(d.getActiveGasUrl()).toBe(URL_A)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
  })
})

describe('団体の切り替え', () => {
  it('今の団体を変え、団体ごとの保存を消して読み込み直す。ほかの団体のログイン・表示言語は残す', async () => {
    const d = await load()
    for (const k of d.ORG_SCOPED_STORAGE_KEYS) local.setItem(k, 'x')
    local.setItem('ohsumi-session-' + ORG_A, 'sa')
    local.setItem('ohsumi-session-' + ORG_B, 'sb')
    local.setItem('ohsumi-locale', 'en')
    const reload = vi.fn()
    d.switchToOrg(ORG_B, reload)
    expect(reload).toHaveBeenCalled()
    expect(local.getItem('ohsumi-current-org')).toBe(ORG_B)
    for (const k of d.ORG_SCOPED_STORAGE_KEYS) expect(local.getItem(k), k).toBeNull()
    expect(local.getItem('ohsumi-session-' + ORG_A)).toBe('sa')
    expect(local.getItem('ohsumi-session-' + ORG_B)).toBe('sb')
    expect(local.getItem('ohsumi-locale')).toBe('en')
  })

  it('団体ごとの保存の一覧は、store.tsx の団体名・ロゴ・テーマ色・データの保存のキーを含む', async () => {
    const d = await load()
    const store = readFileSync(join(__dirname, 'store.tsx'), 'utf8')
    for (const name of ['STORAGE_KEY', 'ORG_NAME_STORAGE_KEY', 'ORG_LOGO_URL_STORAGE_KEY', 'THEME_COLOR_STORAGE_KEY', 'DISMISSED_NOTIFICATIONS_STORAGE_KEY']) {
      const key = store.match(new RegExp(`const ${name} = '([^']+)'`))?.[1]
      expect(key, name).toBeTruthy()
      expect(d.ORG_SCOPED_STORAGE_KEYS, name).toContain(key)
    }
  })

  it('ログインの後に、団体名を一覧に覚える', async () => {
    const d = await load()
    d.upsertSavedOrg(saved(ORG_A, URL_A))
    d.rememberOrgName(ORG_A, 'FSIF')
    expect(d.loadSavedOrgs()[0].name).toBe('FSIF')
    // 接続先を保存し直しても、名前は残る
    d.upsertSavedOrg(saved(ORG_A, URL_A2))
    expect(d.loadSavedOrgs()[0]).toMatchObject({ gasUrl: URL_A2, name: 'FSIF' })
  })
})

describe('GAS への送り先', () => {
  it('ログイン前の問い合わせ・ログインの後の通信は、このページで使う団体の GAS に送る', async () => {
    local.setItem('ohsumi-orgs', JSON.stringify([saved(ORG_A, URL_A)]))
    local.setItem('ohsumi-current-org', ORG_A)
    const transport = await import('./gas-transport')
    const sent: string[] = []
    transport.setGasTransportDepsForTest({
      fetch: async (url: string) => { sent.push(url); return { status: 200, text: async () => JSON.stringify({ ok: true, result: { orgId: ORG_A } }) } as Response },
      sleep: async () => {},
    })
    const d = await load()
    d.startOrg()
    const remote = await import('./remote')
    expect(remote.isRemoteConfigured).toBe(true)
    expect(await remote.fetchLoginConfig()).toEqual({ orgId: ORG_A })
    // 招待リンクの団体を確かめる時は、指定した GAS に送る
    expect(await remote.fetchLoginConfig(URL_B)).toEqual({ orgId: ORG_A })
    expect(sent).toEqual([URL_A, URL_B])
    transport.setGasTransportDepsForTest(null)
  })
})
