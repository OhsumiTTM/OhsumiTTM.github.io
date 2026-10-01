// 画面のエラーの記録(error-report.ts): 種類と操作の名前だけを、1回の読み込みで5件まで送る
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
})
afterEach(() => vi.unstubAllGlobals())

describe('画面のエラーの記録', () => {
  it('種類は英数字と記号だけにし、エラーの文は送らない', async () => {
    const r = await import('./error-report')
    expect(r.errorKindOf(new TypeError('a@b.c の中身'))).toBe('TypeError')
    expect(r.errorKindOf({ name: '名前 a@b.c' })).toBe('ab.c')
    expect(r.errorKindOf('文字列')).toBe('Error')
  })

  it('ログインしている時だけ、1回の読み込みで5件まで送る', async () => {
    const session = await import('./session')
    const r = await import('./error-report')
    const report = vi.fn(async () => ({}))
    r.reportClientError(report, new TypeError('x'))
    expect(report).not.toHaveBeenCalled()
    vi.spyOn(session, 'getSessionToken').mockReturnValue('token')
    for (let i = 0; i < 8; i++) r.reportClientError(report, new RangeError('x'), 'render')
    expect(report).toHaveBeenCalledTimes(5)
    expect(report).toHaveBeenCalledWith('client:RangeError', 'render')
  })
})
