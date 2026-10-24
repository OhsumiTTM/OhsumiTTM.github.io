// 版の画面(lib/ohsumi/site-version.ts と、org-directory.ts の applySiteVersion): プランに配っている版の画面を使う
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanSiteVersion, decideSite, hopUrl, parseManifest, takeHop } from './site-version'

const V1 = '2026.12.01-1'
const V2 = '2026.12.02-1'
const ORG = 'org_AAAAAAAAAAAAAAAAAAAA'
const GAS = 'https://script.google.com/macros/s/AKfyA/exec'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
  removeItem(k: string) { this.data.delete(k) }
}

let local: MemoryStorage
let session: MemoryStorage
beforeEach(() => {
  vi.resetModules()
  local = new MemoryStorage()
  session = new MemoryStorage()
  vi.stubGlobal('window', { localStorage: local, sessionStorage: session, location: { href: 'https://site.example/?org=' + ORG + '&task=12', search: '?org=' + ORG + '&task=12', hash: '' }, history: { state: null, replaceState: () => {} } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('どの画面を使うか', () => {
  it('答えと今の画面が同じなら、そのまま', () => {
    expect(decideSite('', '', null)).toEqual({ kind: 'stay', screen: '' })
    expect(decideSite(V1, V1, null)).toEqual({ kind: 'stay', screen: V1 })
  })
  it('版の画面が置いてあれば移る。置いていなければ main のまま(この仕組みより前の版など)', () => {
    expect(decideSite(V1, '', [V1, V2])).toEqual({ kind: 'version', version: V1 })
    expect(decideSite(V1, '', [V2])).toEqual({ kind: 'stay', screen: '' })
    expect(decideSite(V1, V2, [V1])).toEqual({ kind: 'version', version: V1 })
  })
  it('版の画面にいて、main を使う団体・置いていない版になった時は main に戻る', () => {
    expect(decideSite('', V1, null)).toEqual({ kind: 'main' })
    expect(decideSite(V2, V1, [V1])).toEqual({ kind: 'main' })
  })
  it('置いた版の一覧が読めない時は移らない', () => {
    expect(decideSite(V1, '', null)).toEqual({ kind: 'stay', screen: '' })
    expect(decideSite(V2, V1, null)).toEqual({ kind: 'stay', screen: V1 })
  })
  it('移る先の URL は ?org= と &task= をそのまま付ける', () => {
    expect(hopUrl({ kind: 'version', version: V1 }, '?org=' + ORG + '&task=12', '#x')).toBe('/_v/' + V1 + '/?org=' + ORG + '&task=12#x')
    expect(hopUrl({ kind: 'main' }, '?org=' + ORG, '')).toBe('/?org=' + ORG)
    expect(hopUrl({ kind: 'stay', screen: '' }, '?org=' + ORG, '')).toBeNull()
  })
  it('形の違う値は使わない', () => {
    for (const bad of ['', 'latest', '../x', '2026.12.01', 1, null]) expect(cleanSiteVersion(bad), String(bad)).toBe('')
    expect(cleanSiteVersion(V1)).toBe(V1)
    expect(parseManifest({ versions: [V1, '../evil', 3] })).toEqual([V1])
    expect(parseManifest('x')).toBeNull()
  })
  it('移るのは、このタブで1分に3回まで', () => {
    const now = 1_000_000
    expect([takeHop(now), takeHop(now + 1), takeHop(now + 2), takeHop(now + 3)]).toEqual([true, true, true, false])
    expect(takeHop(now + 61_000)).toBe(true)
  })
})

describe('団体を使う時に、その団体の画面に移る(applySiteVersion)', () => {
  const start = async (extra: Record<string, unknown>) => {
    vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', 'https://script.google.com/macros/s/REGISTRY/exec')
    const d = await import('./org-directory')
    const org = { orgId: ORG, gasUrl: GAS, source: 'registry' as const, checkedAt: Date.now(), maxAgeSec: 86400, ...extra }
    d.activateOrg(org)
    return { d, org }
  }
  const screenOf = () => (JSON.parse(local.getItem('ohsumi-orgs')!) as { screen?: string }[])[0].screen

  it('置いてある版なら移り、移る先を覚える(次からは最初のスクリプトがすぐ移る)', async () => {
    const { d, org } = await start({ siteVersion: V1 })
    const go = vi.fn()
    expect(await d.applySiteVersion(org, { current: '', manifest: async () => [V1], go })).toBe('hop')
    expect(go).toHaveBeenCalledWith('/_v/' + V1 + '/?org=' + ORG + '&task=12')
    expect(screenOf()).toBe(V1)
  })
  it('置いていない版なら main のまま使い、移る先を消す', async () => {
    const { d, org } = await start({ siteVersion: V1, screen: V1 })
    const go = vi.fn()
    expect(await d.applySiteVersion(org, { current: '', manifest: async () => [], go })).toBe('stay')
    expect(go).not.toHaveBeenCalled()
    expect(screenOf()).toBe('')
  })
  it('版の画面にいて、main を使う団体になったら main に戻る', async () => {
    const { d, org } = await start({ siteVersion: '' })
    const go = vi.fn()
    expect(await d.applySiteVersion(org, { current: V1, manifest: async () => [V1], go })).toBe('hop')
    expect(go).toHaveBeenCalledWith('/?org=' + ORG + '&task=12')
  })
  it('今使っている団体でなければ何もしない。移る回数の上限を超えたら移らない', async () => {
    const { d, org } = await start({ siteVersion: V1 })
    const go = vi.fn()
    expect(await d.applySiteVersion({ ...org, orgId: 'org_BBBBBBBBBBBBBBBBBBBB' }, { current: '', manifest: async () => [V1], go })).toBe('stay')
    session.setItem('ohsumi-site-hops', JSON.stringify({ n: 3, at: Date.now() }))
    expect(await d.applySiteVersion(org, { current: '', manifest: async () => [V1], go })).toBe('blocked')
    expect(go).not.toHaveBeenCalled()
  })
  it('レジストリの答えの siteVersion を覚える(以前のレジストリは返さないので main)', async () => {
    vi.stubEnv('NEXT_PUBLIC_REGISTRY_URL', 'https://script.google.com/macros/s/REGISTRY/exec')
    const d = await import('./org-directory')
    const answers: Record<string, unknown> = {
      [ORG]: { ok: true, result: { orgId: ORG, gasUrl: GAS, status: 'active', siteVersion: V1, checkedAt: new Date().toISOString(), maxAgeSec: 86400 } },
    }
    d.setOrgDirectoryFetchForTest(async (_u, init) => ({ text: async () => JSON.stringify(answers[JSON.parse(String(init.body)).orgId]) }))
    const a = await d.resolveOrg(ORG)
    expect(a).toMatchObject({ kind: 'found', siteVersion: V1 })
    ;(answers[ORG] as { result: Record<string, unknown> }).result.siteVersion = '../evil'
    expect(await d.resolveOrg(ORG)).toMatchObject({ kind: 'found', siteVersion: '' })
  })
})
