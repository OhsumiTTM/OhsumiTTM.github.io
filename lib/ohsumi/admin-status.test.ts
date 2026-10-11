// 管理画面の上部の知らせの状態をまとめて読む(lib/ohsumi/admin-status.ts・gas/Code.gs の adminStatus_)
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_STATUS_TTL_MS, adminStatusPart, forgetAdminStatus, type AdminStatus } from './admin-status'
import { guardHarness } from './gas-guard-harness'

describe('adminStatusPart(画面)', () => {
  beforeEach(() => forgetAdminStatus())

  it('同じ時に頼まれた知らせは1回の通信にまとめ、しばらくは読み直さない', async () => {
    const fetchAll = vi.fn(async (): Promise<AdminStatus> => ({ backup: { lastSuccessAt: 'x', failed: false, failedAt: '', error: '' } as never, ops: { jobs: {} } as never }))
    const [a, b] = await Promise.all([adminStatusPart('backup', { fetchAll, now: 1000 }), adminStatusPart('ops', { fetchAll, now: 1000 })])
    expect(a).toMatchObject({ lastSuccessAt: 'x' })
    expect(b).toMatchObject({ jobs: {} })
    await adminStatusPart('backup', { fetchAll, now: 1000 + ADMIN_STATUS_TTL_MS - 1 })
    expect(fetchAll).toHaveBeenCalledTimes(1)
    await adminStatusPart('backup', { fetchAll, now: 1000 + ADMIN_STATUS_TTL_MS + 1 })
    expect(fetchAll).toHaveBeenCalledTimes(2)
  })

  it('見られない部分(GAS が入れなかった部分)は失敗にする', async () => {
    const fetchAll = async (): Promise<AdminStatus> => ({ announcements: { registered: false, announcements: [], fetchedAt: '', stale: false } })
    await expect(adminStatusPart('backup', { fetchAll, now: 1 })).rejects.toThrow()
  })

  it('古い GAS(getAdminStatus が無い)では、それぞれの操作で読む', async () => {
    const fetchAll = async (): Promise<AdminStatus> => { throw new Error('Unknown action: getAdminStatus') }
    const single = vi.fn(async () => ({ remaining: 3 }) as never)
    expect(await adminStatusPart('mailQuota', { fetchAll, single, now: 1 })).toEqual({ remaining: 3 })
    expect(single).toHaveBeenCalledTimes(1)
  })

  it('通信に失敗した時は覚えず、次は読み直す', async () => {
    let n = 0
    const fetchAll = async (): Promise<AdminStatus> => { n++; if (n === 1) throw new Error('通信エラー'); return { backup: {} as never } }
    await expect(adminStatusPart('backup', { fetchAll, now: 1 })).rejects.toThrow('通信エラー')
    await expect(adminStatusPart('backup', { fetchAll, now: 2 })).resolves.toEqual({})
  })
})

describe('getAdminStatus(団体の GAS)', () => {
  it('代表には全部、一般のメンバーには見られる部分だけを返す', () => {
    const h = guardHarness()
    const top = h.post({ action: 'getAdminStatus', sessionToken: 'm-top' })
    expect(top.ok).toBe(true)
    for (const key of ['gasUpdate', 'mailQuota', 'ops', 'backup', 'personalData']) expect(top.result).toHaveProperty(key)
    const base = h.post({ action: 'getAdminStatus', sessionToken: 'm-base' })
    expect(base.ok).toBe(true)
    for (const key of ['ops', 'backup', 'personalData', 'announcements']) expect(base.result).not.toHaveProperty(key)
  })
})
