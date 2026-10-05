// 団体の保存(getOrgStorage・setOrgStorage): 本人だけの保存と同じしくみで、団体に1つの値をキーごとに持つ。
// 読める役職・書ける役職はキーごとに Settings の org_storage_access で決める。設定の無いキーは代表・全権管理者だけ。
// キー・大きさ・数の上限を守る。初期データには入れない
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const set = (h: H, who: string, key: string, value: unknown) => h.post({ action: 'setOrgStorage', sessionToken: who, key, value })
const get = (h: H, who: string, keys?: string[]) => h.post({ action: 'getOrgStorage', sessionToken: who, ...(keys ? { keys } : {}) })
const access = (h: H, value: unknown) => h.post({ action: 'updateSetting', sessionToken: 'm-top', key: 'org_storage_access', value: JSON.stringify(value) })
const restrictLead = (h: H) => {
  const roles = JSON.parse(String(h.sheets.Settings.rows[1][1])) as { id: string; restricted?: boolean }[]
  roles.find((r) => r.id === 'r-lead')!.restricted = true
  h.sheets.Settings.rows[1][1] = JSON.stringify(roles)
}

describe('団体の保存', () => {
  it('設定の無いキーは、代表・全権管理者だけが読み書きできる', () => {
    const h = guardHarness()
    restrictLead(h)
    expect(set(h, 'm-top', 'plan', '{"v":1}').ok).toBe(true)
    for (const who of ['m-base', 'm-lead']) {
      expect(set(h, who, 'plan', 'x').ok, who).toBe(false)
      expect(set(h, who, 'other', 'x').ok, who).toBe(false)
      expect(get(h, who).result.values, who).toEqual({})
    }
    expect(get(h, 'm-top').result.values).toEqual({ plan: '{"v":1}' })
    // 初期データには入れない
    expect(JSON.stringify(h.post({ action: 'getInitialData', sessionToken: 'm-top' }))).not.toContain('"v":1')
  })

  it('キーごとに、読む・書く役職を決められる(全員・管理者・役職の一覧)', () => {
    const h = guardHarness()
    restrictLead(h)
    expect(access(h, { board: { read: 'all', write: 'adminRole' }, leads: { read: ['r-lead'], write: ['班長'] }, secret: { read: 'top' } }).ok).toBe(true)
    expect(set(h, 'm-base', 'board', 'x').ok).toBe(false)
    expect(set(h, 'm-lead', 'board', 'お知らせ').ok).toBe(true)
    expect(get(h, 'm-base').result.values).toEqual({ board: 'お知らせ' })
    expect(set(h, 'm-lead', 'leads', '班長の分').ok).toBe(true)
    expect(get(h, 'm-base', ['leads']).result.values).toEqual({})
    expect(get(h, 'm-lead', ['leads']).result.values).toEqual({ leads: '班長の分' })
    expect(set(h, 'm-top', 'secret', '代表だけ').ok).toBe(true)
    expect(get(h, 'm-lead').result.values.secret).toBeUndefined()
    expect(set(h, 'm-lead', 'secret', 'x').ok).toBe(false)
    // 権限の設定そのものは、代表・全権管理者にだけ返す
    const settings = (who: string) => (h.post({ action: 'getInitialData', sessionToken: who }).result.sheets.Settings.rows as string[][]).map((r) => r[0])
    expect(settings('m-base')).not.toContain('org_storage_access')
    expect(settings('m-top')).toContain('org_storage_access')
  })

  it('権限の設定は代表・全権管理者だけが変えられ、決まりに合わない値は保存しない', () => {
    const h = guardHarness()
    restrictLead(h)
    for (const who of ['m-base', 'm-lead']) {
      expect(h.post({ action: 'updateSetting', sessionToken: who, key: 'org_storage_access', value: '{"board":{"read":"all"}}' }).ok, who).toBe(false)
    }
    for (const bad of [{ 'Bad Key': { read: 'all' } }, { board: 'all' }, { board: { read: 'everyone' } }, { board: { read: [] } }, { board: { delete: 'all' } }, ['board']]) {
      expect(access(h, bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('キーの形・値の型・大きさ・数の上限を守り、大きな値は行に分ける', () => {
    const h = guardHarness()
    for (const key of ['', 'UPPER', '../x', 'a'.repeat(65)]) expect(set(h, 'm-top', key, 'v').ok, key).toBe(false)
    expect(set(h, 'm-top', 'k', { a: 1 }).ok).toBe(false)
    expect(set(h, 'm-top', 'k', 'x'.repeat(100001)).ok).toBe(false)
    const big = 'a'.repeat(40000) + 'b'.repeat(40000) + 'c'
    expect(set(h, 'm-top', 'big', big).ok).toBe(true)
    expect(h.sheets.OrgStore.rows.length).toBe(1 + 3)
    expect(get(h, 'm-top', ['big']).result.values.big).toBe(big)
    expect(set(h, 'm-top', 'big', null).ok).toBe(true)
    expect(h.sheets.OrgStore.rows.length).toBe(1)
    for (let i = 0; i < 10; i++) expect(set(h, 'm-top', 'f' + i, 'x'.repeat(100000)).ok, 'f' + i).toBe(true)
    expect(set(h, 'm-top', 'over', 'x').ok).toBe(false) // 合わせて 1,000,000 文字まで
    const many = guardHarness()
    for (let i = 0; i < 200; i++) set(many, 'm-top', 'k' + i, 'v')
    expect(set(many, 'm-top', 'k200', 'v').ok).toBe(false) // 200 個まで
    // 数式として書かない
    expect(set(h, 'm-top', 'f0', '=IMPORTXML("x")').ok).toBe(true)
    expect(get(h, 'm-top', ['f0']).result.values.f0).toBe('=IMPORTXML("x")')
  })
})
