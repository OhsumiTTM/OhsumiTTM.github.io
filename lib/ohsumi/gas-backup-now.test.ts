// 代表が管理画面から「今すぐバックアップを作る」(createBackupNow)
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import { withDrive } from './gas-drive-fake'

describe('今すぐバックアップを作る', () => {
  it('代表は作れる。作ったものが一覧に出て、状態も成功になる', () => {
    const h = guardHarness()
    const d = withDrive(h)
    const r = h.post({ action: 'createBackupNow', sessionToken: 'm-top' })
    expect(r.ok).toBe(true)
    expect(d.copies).toEqual(['ss'])
    expect(r.result.backup.name).toMatch(/^Ohsumi バックアップ /)
    expect(r.result.status).toMatchObject({ failed: false })
    expect(r.result.backups.length).toBeGreaterThanOrEqual(1)
  })

  it('代表以外は作れない', () => {
    const h = guardHarness()
    withDrive(h)
    for (const who of ['m-lead', 'm-base']) {
      expect(h.post({ action: 'createBackupNow', sessionToken: who }), who).toMatchObject({ ok: false })
    }
  })

  it('前に手で作ってから10分は断る(作りすぎ防止)', () => {
    const h = guardHarness()
    const d = withDrive(h)
    expect(h.post({ action: 'createBackupNow', sessionToken: 'm-top' }).ok).toBe(true)
    const again = h.post({ action: 'createBackupNow', sessionToken: 'm-top' })
    expect(again.ok).toBe(false)
    expect(String(again.error)).toContain('10分')
    expect(d.copies).toHaveLength(1)
  })

  it('作れなかった時は失敗を記録して知らせる', () => {
    const h = guardHarness()
    withDrive(h, { failCopy: true })
    const r = h.post({ action: 'createBackupNow', sessionToken: 'm-top' })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('バックアップを作れませんでした')
  })
})
