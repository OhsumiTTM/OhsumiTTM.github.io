// 本人だけの保存(getMyStorage・setMyStorage): 本人の分だけを読み書きし、ほかの人には返さない。
// キー・大きさ・数の上限を守り、大きな値は行に分けて持つ。初期データには入れない。個人情報の削除で消す
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

const set = (h: ReturnType<typeof guardHarness>, who: string, key: string, value: unknown) =>
  h.post({ action: 'setMyStorage', sessionToken: who, key, value })
const get = (h: ReturnType<typeof guardHarness>, who: string, keys?: string[]) =>
  h.post({ action: 'getMyStorage', sessionToken: who, ...(keys ? { keys } : {}) })

describe('本人だけの保存', () => {
  it('本人の分だけを読み書きする(画面が送るメンバーID は使わない)', () => {
    const h = guardHarness()
    expect(set(h, 'm-base', 'notification-history', '{"v":1}').ok).toBe(true)
    expect(set(h, 'm-lead', 'notification-history', '{"v":2}').ok).toBe(true)
    expect(get(h, 'm-base').result.values).toEqual({ 'notification-history': '{"v":1}' })
    expect(get(h, 'm-lead', ['notification-history', 'none']).result.values).toEqual({ 'notification-history': '{"v":2}' })
    // ほかの人のメンバーID を送っても、自分の分になる
    h.post({ action: 'setMyStorage', sessionToken: 'm-base', memberId: 'm-lead', key: 'notification-history', value: 'x' })
    expect(get(h, 'm-lead').result.values['notification-history']).toBe('{"v":2}')
    expect(get(h, 'm-top').result.values).toEqual({})
    // 初期データには入れない
    const init = h.post({ action: 'getInitialData', sessionToken: 'm-top' })
    expect(JSON.stringify(init)).not.toContain('"v":1')
  })

  it('大きな値は行に分け、書き直すと余った行を消す。空にするとキーを消す', () => {
    const h = guardHarness()
    const big = 'a'.repeat(40000) + 'b'.repeat(40000) + 'c'.repeat(10)
    expect(set(h, 'm-base', 'k', big).ok).toBe(true)
    expect(h.sheets.PersonalStore.rows.length).toBe(1 + 3)
    expect(get(h, 'm-base').result.values.k).toBe(big)
    expect(set(h, 'm-base', 'k', 'small').ok).toBe(true)
    expect(h.sheets.PersonalStore.rows.length).toBe(1 + 1)
    expect(get(h, 'm-base').result.values.k).toBe('small')
    expect(set(h, 'm-base', 'k', null).ok).toBe(true)
    expect(get(h, 'm-base').result.values).toEqual({})
    expect(h.sheets.PersonalStore.rows.length).toBe(1)
  })

  it('キーの形・値の型・大きさ・キーの数の上限を守る', () => {
    const h = guardHarness()
    for (const key of ['', 'UPPER', '../x', 'a'.repeat(65), 'with space']) expect(set(h, 'm-base', key, 'v').ok, key).toBe(false)
    expect(set(h, 'm-base', 'k', { a: 1 }).ok).toBe(false)
    expect(set(h, 'm-base', 'k', 'x'.repeat(150001)).ok).toBe(false)
    expect(set(h, 'm-base', 'one', 'x'.repeat(100000)).ok).toBe(true)
    expect(set(h, 'm-base', 'two', 'x'.repeat(50001)).ok).toBe(false)
    for (let i = 1; i < 20; i++) expect(set(h, 'm-lead', 'k' + i, 'v').ok).toBe(true)
    expect(set(h, 'm-lead', 'k20', 'v').ok).toBe(true)
    expect(set(h, 'm-lead', 'k21', 'v').ok).toBe(false)
    // 数式として書かない
    expect(set(h, 'm-top', 'f', '=IMPORTXML("x")').ok).toBe(true)
    expect(get(h, 'm-top').result.values.f).toBe('=IMPORTXML("x")')
  })

  it('個人情報の削除で、その人の保存を消す', () => {
    const h = guardHarness()
    set(h, 'm-base', 'k', 'mine')
    set(h, 'm-lead', 'k', 'lead')
    ;(h.c.deletePersonalStore_ as (id: string) => number)('m-base')
    expect(get(h, 'm-base').result.values).toEqual({})
    expect(get(h, 'm-lead').result.values).toEqual({ k: 'lead' })
  })
})
