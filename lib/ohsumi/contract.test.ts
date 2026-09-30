// 提供停止・機能停止(R1-e)の画面側: GAS の応答の contract の読み方・画面の上部の知らせ・
// 停止中・読み取り専用で断られた時の扱い(lib/ohsumi/contract.ts・remote.ts)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_CONTRACT, contractBanner, contractFromResponse, getContract, noteContractResponse, parseContract, resetContractForTest, subscribeContract } from './contract'

const DAY = 24 * 3600 * 1000
const NOW = Date.parse('2026-10-01T00:00:00Z')

describe('応答の contract', () => {
  it('停止の予定・停止中の時だけ読む。形が違うものは読まない', () => {
    expect(parseContract({ phase: 'scheduled', kind: 'restrict', suspendAt: '2026-10-10T00:00:00Z' })).toEqual({ phase: 'scheduled', kind: 'restrict', suspendAt: '2026-10-10T00:00:00.000Z' })
    expect(parseContract({ phase: 'inEffect', kind: 'x' })).toEqual({ phase: 'inEffect', kind: 'suspend', suspendAt: '' })
    for (const bad of [null, 'x', {}, { phase: 'none' }, { phase: 'other' }]) expect(parseContract(bad)).toBeNull()
  })

  it('contract の無い成功の応答は「予定なし」、無い失敗の応答は分からない(前の状態のまま)', () => {
    expect(contractFromResponse({ ok: true })).toEqual(NO_CONTRACT)
    expect(contractFromResponse({ ok: false })).toBeNull()
    expect(contractFromResponse({ ok: false, contract: { phase: 'inEffect', kind: 'restrict' } })).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    expect(contractFromResponse(null)).toBeNull()
  })
})

describe('画面の上部の知らせ', () => {
  const at = (days: number) => new Date(NOW + days * DAY).toISOString()

  it('機能停止中はアンケートへの回答のお願い。提供停止中は出さない(ログイン画面に戻す)', () => {
    expect(contractBanner({ phase: 'inEffect', kind: 'restrict', suspendAt: at(-1) }, NOW)).toEqual({ type: 'restricted' })
    expect(contractBanner({ phase: 'inEffect', kind: 'suspend', suspendAt: at(-1) }, NOW)).toBeNull()
    expect(contractBanner(NO_CONTRACT, NOW)).toBeNull()
  })

  it('停止の予定は14日前から、残りの日数と一緒に出す(どちらの種類も)', () => {
    expect(contractBanner({ phase: 'scheduled', kind: 'restrict', suspendAt: at(15) }, NOW)).toBeNull()
    expect(contractBanner({ phase: 'scheduled', kind: 'restrict', suspendAt: at(14) }, NOW)).toEqual({ type: 'scheduled', kind: 'restrict', suspendAt: at(14), daysLeft: 14 })
    expect(contractBanner({ phase: 'scheduled', kind: 'suspend', suspendAt: at(6.2) }, NOW)).toMatchObject({ kind: 'suspend', daysLeft: 7 })
    expect(contractBanner({ phase: 'scheduled', kind: 'suspend', suspendAt: at(0.1) }, NOW)).toMatchObject({ daysLeft: 1 })
    // 予定の日時を過ぎた(次の応答で停止中になる)
    expect(contractBanner({ phase: 'scheduled', kind: 'restrict', suspendAt: at(-0.1) }, NOW)).toEqual({ type: 'restricted' })
  })
})

describe('今の状態', () => {
  beforeEach(() => resetContractForTest())

  it('変わった時だけ知らせる。失敗の応答では変えない', () => {
    const seen: string[] = []
    subscribeContract(() => seen.push(getContract().phase))
    noteContractResponse({ ok: true, contract: { phase: 'scheduled', kind: 'restrict', suspendAt: '2026-10-10T00:00:00Z' } })
    noteContractResponse({ ok: true, contract: { phase: 'scheduled', kind: 'restrict', suspendAt: '2026-10-10T00:00:00Z' } })
    noteContractResponse({ ok: false })
    expect(getContract().phase).toBe('scheduled')
    noteContractResponse({ ok: true })
    expect(seen).toEqual(['scheduled', 'none'])
  })
})

describe('GAS に断られた時(remote.ts)', () => {
  type Remote = typeof import('./remote')
  type Contract = typeof import('./contract')
  let remote: Remote
  let contract: Contract
  let events: { type: string; detail: unknown }[]

  function mockGas(reply: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => JSON.stringify(reply) })))
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_GAS_URL', 'https://script.google.com/macros/s/ORG/exec')
    events = []
    vi.stubGlobal('window', { dispatchEvent: (e: CustomEvent) => { events.push({ type: e.type, detail: e.detail }); return true } })
    remote = await import('./remote')
    contract = await import('./contract')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('機能停止中に書き込みを断られたら ContractRestrictedError。状態は「機能停止中」になる', async () => {
    mockGas({ ok: false, restricted: true, error: '読み取り専用です。アンケートへの回答をお願いします。', contract: { phase: 'inEffect', kind: 'restrict', suspendAt: '2026-10-01T00:00:00Z' } })
    const err = await remote.remoteApi.updateTaskStatus('t1', 'done').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(remote.ContractRestrictedError)
    expect((err as Error).message).toContain('アンケート')
    // 送ろうとした文章は残す(画面がコピーできるように出す)
    const err2 = await remote.remoteApi.updateProgress('t1', '今日は資料を半分まで作りました', []).catch((e: unknown) => e)
    expect((err2 as InstanceType<typeof remote.ContractRestrictedError>).texts).toEqual(['今日は資料を半分まで作りました'])
    expect(contract.getContract()).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    expect(events).toEqual([])
  })

  it('提供停止中に断られたら、ログイン画面に戻して「利用を停止しています」を出す', async () => {
    mockGas({ ok: false, orgSuspended: true, error: 'この団体は、Ohsumi の利用を停止しています。', contract: { phase: 'inEffect', kind: 'suspend' } })
    await expect(remote.fetchInitialData()).rejects.toThrow(/利用を停止しています/)
    expect(events).toEqual([{ type: 'ohsumi:org-changed', detail: { orgId: null, notice: 'orgSuspended' } }])
  })

  it('ログインの設定で停止中と分かる', async () => {
    mockGas({ ok: true, result: { orgId: 'org_AAAAAAAAAAAAAAAAAAAA', suspended: true } })
    expect(await remote.fetchLoginConfig()).toEqual({ orgId: 'org_AAAAAAAAAAAAAAAAAAAA', suspended: true })
    mockGas({ ok: true, result: { orgId: 'org_AAAAAAAAAAAAAAAAAAAA' } })
    expect(await remote.fetchLoginConfig()).toEqual({ orgId: 'org_AAAAAAAAAAAAAAAAAAAA' })
  })
})
