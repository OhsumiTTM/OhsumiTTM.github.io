// 団体の GAS(gas/Code.gs)の FSIF からのお知らせ(PR P): 読めるのは代表・管理者だけ。読み取りの操作(機能停止中も使える)
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness } from './gas-guard-harness'

describe('getAnnouncements', () => {
  it('代表・管理者は読める。一般は断る', () => {
    const h = guardHarness()
    expect(h.post({ action: 'getAnnouncements', sessionToken: 'm-top' })).toMatchObject({ ok: true, result: { registered: false, announcements: [] } })
    expect(h.post({ action: 'getAnnouncements', sessionToken: 'm-lead' }).ok).toBe(true)
    expect(h.post({ action: 'getAnnouncements', sessionToken: 'm-base' })).toMatchObject({ ok: false, forbidden: true })
  })

  it('読み取りの一覧とロックを取らない一覧に入っている', () => {
    expect(CODE_GS.match(/var READ_ONLY_ACTIONS = \[[^\]]*\]/)![0]).toContain("'getAnnouncements'")
    expect(CODE_GS.match(/var LOCK_EXEMPT_ACTIONS = \[[^\]]*\]/)![0]).toContain("'getAnnouncements'")
  })
})
