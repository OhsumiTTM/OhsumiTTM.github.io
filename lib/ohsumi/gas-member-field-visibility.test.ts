// 人材データの項目ごとの閲覧範囲(Settings の member_field_visibility): 全員・見る立場の人・管理者・本人。
// 設定が無ければ、今までどおりの範囲で返す。評価・1on1・育成計画・キャリアの希望・アンケートの回答は、見る立場の人より
// 広くできない(広い値が保存されていても、今までどおり)。変えられるのは代表・全権管理者だけ
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const COLS = ['university', 'career_aspiration', 'skill_points_json', 'will_tags', 'one_on_ones_json']
const setup = (visibility?: string) => {
  const h = guardHarness()
  const rows = h.sheets.Members.rows
  for (const c of COLS) { rows[0].push(c); rows.slice(1).forEach((r) => r.push('')) }
  const base = rows.find((r) => r[0] === 'm-base')!
  const at = (c: string) => rows[0].indexOf(c)
  base[at('university')] = '大学A'
  base[at('career_aspiration')] = '将来は企画'
  base[at('skill_points_json')] = '{"企画":10}'
  base[at('will_tags')] = '企画'
  base[at('one_on_ones_json')] = '[{"id":"o1"}]'
  if (visibility !== undefined) h.sheets.Settings.rows.push(['member_field_visibility', visibility])
  return h
}
// 閲覧者 who から見た m-base の行
const seen = (h: H, who: string) => {
  const res = h.post({ action: 'getInitialData', sessionToken: who })
  const t = res.result.sheets.Members as { headers: string[]; rows: string[][] }
  const row = t.rows.find((r) => r[t.headers.indexOf('id')] === 'm-base')!
  return Object.fromEntries(COLS.map((c) => [c, row[t.headers.indexOf(c)]]))
}
const restrictLead = (h: H) => {
  const roles = JSON.parse(String(h.sheets.Settings.rows[1][1])) as { id: string; restricted?: boolean }[]
  roles.find((r) => r.id === 'r-lead')!.restricted = true
  h.sheets.Settings.rows[1][1] = JSON.stringify(roles)
}

describe('人材データの項目ごとの閲覧範囲', () => {
  it('設定が無ければ、今までどおり(画面が無い今の動き)', () => {
    const h = setup()
    expect(seen(h, 'm-other')).toEqual({ university: '', career_aspiration: '', skill_points_json: '', will_tags: '企画', one_on_ones_json: '' })
    // 班長は m-base の報告先(見る立場)
    expect(seen(h, 'm-lead')).toEqual({ university: '大学A', career_aspiration: '将来は企画', skill_points_json: '{"企画":10}', will_tags: '企画', one_on_ones_json: '[{"id":"o1"}]' })
    expect(seen(h, 'm-base').career_aspiration).toBe('将来は企画')
  })

  it('全員・本人・管理者・見る立場の人に変えられる', () => {
    const h = setup(JSON.stringify({ university: 'all', skill_points_json: 'self', will_tags: 'supervisor', career_aspiration: 'self' }))
    const other = seen(h, 'm-other')
    expect(other.university).toBe('大学A')
    expect(other.will_tags).toBe('')
    const lead = seen(h, 'm-lead')
    expect([lead.skill_points_json, lead.career_aspiration, lead.will_tags]).toEqual(['', '', '企画'])
    // 代表も、本人だけの項目は見られない
    expect(seen(h, 'm-top').skill_points_json).toBe('')
    expect(seen(h, 'm-base')).toMatchObject({ skill_points_json: '{"企画":10}', career_aspiration: '将来は企画' })
  })

  it('評価・1on1・キャリアの希望などは、広い値が保存されていても今までどおり。壊れた設定も今までどおり', () => {
    const h = setup(JSON.stringify({ career_aspiration: 'all', one_on_ones_json: 'admin', university: 'nobody' }))
    expect(seen(h, 'm-other')).toMatchObject({ career_aspiration: '', one_on_ones_json: '', university: '' })
    expect(seen(h, 'm-lead').university).toBe('大学A')
    const broken = setup('{not json')
    expect(seen(broken, 'm-other').university).toBe('')
  })

  it('設定できるのは代表・全権管理者だけで、決まりに合わない値は保存しない', () => {
    const h = setup()
    restrictLead(h)
    const value = JSON.stringify({ university: 'all' })
    for (const who of ['m-base', 'm-lead']) {
      const res = h.post({ action: 'updateSetting', sessionToken: who, key: 'member_field_visibility', value })
      expect(res.ok, who).toBe(false)
    }
    for (const bad of [{ career_aspiration: 'all' }, { evaluation_history_json: 'admin' }, { university: 'everyone' }, { name: 'self' }, { permission_overrides_json: 'all' }, ['university']]) {
      const res = h.post({ action: 'updateSetting', sessionToken: 'm-top', key: 'member_field_visibility', value: JSON.stringify(bad) })
      expect(res.ok, JSON.stringify(bad)).toBe(false)
    }
    expect(h.post({ action: 'updateSetting', sessionToken: 'm-top', key: 'member_field_visibility', value }).ok).toBe(true)
    expect(seen(h, 'm-other').university).toBe('大学A')
    // 設定の値そのものは全員が読める(どの範囲かは秘密ではない)
    const res = h.post({ action: 'getInitialData', sessionToken: 'm-other' })
    expect((res.result.sheets.Settings.rows as string[][]).find((r) => r[0] === 'member_field_visibility')?.[1]).toBe(value)
  })
})
