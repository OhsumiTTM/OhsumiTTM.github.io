// 項目ごとの公開範囲(v1.2。gas/src/33-member-field-visibility.gs): 見せる相手(上長・部署長・メンター・プロジェクトの責任者・
// 幹部・全員)の組み合わせ。本人はいつも見られ、代表は「本人だけ」以外を見られる。独自の項目はキーごと、日報・週報も選べる
// (日報を見る権限の人は、いつもすべて)。以前の範囲(文字列)は同じ意味の組み合わせとして読む
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const COLS = ['university', 'career_plan', 'one_on_ones_json', 'custom_fields_json', 'department_path', 'mentor_id']
const setup = (visibility?: unknown, opts: { tree?: unknown; mentor?: string; owner?: string } = {}) => {
  const h = guardHarness()
  const rows = h.sheets.Members.rows
  for (const c of COLS) { rows[0].push(c); rows.slice(1).forEach((r) => r.push('')) }
  const at = (c: string) => rows[0].indexOf(c)
  const base = rows.find((r) => r[0] === 'm-base')!
  base[at('university')] = '大学A'
  base[at('career_plan')] = '企画に進む'
  base[at('one_on_ones_json')] = '[{"id":"o1"}]'
  base[at('custom_fields_json')] = JSON.stringify({ hobby: '釣り', shoe: '27' })
  base[at('department_path')] = '本部 > 開発, 広報'
  if (opts.mentor) base[at('mentor_id')] = opts.mentor
  if (opts.owner) {
    const p = h.sheets.Projects.rows
    p[0].push('owner_id')
    p[1].push(opts.owner)
  }
  if (opts.tree !== undefined) h.sheets.Settings.rows.push(['department_tree_config', JSON.stringify(opts.tree)])
  if (visibility !== undefined) h.sheets.Settings.rows.push(['member_field_visibility', JSON.stringify(visibility)])
  return h
}
// 閲覧者 who から見た m-base の行
const seen = (h: H, who: string) => {
  const res = h.post({ action: 'getInitialData', sessionToken: who })
  expect(res.ok, JSON.stringify(res)).toBe(true)
  const t = res.result.sheets.Members as { headers: string[]; rows: string[][] }
  const row = t.rows.find((r) => r[t.headers.indexOf('id')] === 'm-base')!
  return Object.fromEntries(COLS.slice(0, 4).map((c) => [c, row[t.headers.indexOf(c)]]))
}
const sees = (h: H, who: string, col = 'university') => seen(h, who)[col] !== ''

describe('見せる相手の組み合わせ', () => {
  it('上長: 報告先をたどった上の人。本人はいつも、代表も見られる。ほかの人は見られない', () => {
    const h = setup({ university: ['boss'] })
    expect(['m-base', 'm-lead', 'm-top', 'm-other'].map((w) => sees(h, w))).toEqual([true, true, true, false])
  })

  it('本人だけ(空の配列): 代表も見られない', () => {
    const h = setup({ university: [] })
    expect(['m-base', 'm-lead', 'm-top'].map((w) => sees(h, w))).toEqual([true, false, false])
  })

  it('部署長: 長の部署とその下の部署に所属する人(区切りの前後の空白は無視)。長でない部署は見られない', () => {
    const tree = [{ path: '本部', headIds: ['m-other'] }, { path: '本部>営業', headIds: ['m-victim'] }]
    const h = setup({ university: ['deptHead'] }, { tree })
    expect(sees(h, 'm-other')).toBe(true)
    expect(sees(h, 'm-victim')).toBe(false)
    // 上長でも、部署長だけの項目は見られない
    expect(sees(h, 'm-lead')).toBe(false)
  })

  it('メンター・プロジェクトの責任者', () => {
    expect(sees(setup({ university: ['mentor'] }, { mentor: 'm-other' }), 'm-other')).toBe(true)
    expect(sees(setup({ university: ['mentor'] }), 'm-other')).toBe(false)
    expect(sees(setup({ university: ['projectOwner'] }, { owner: 'm-victim' }), 'm-victim')).toBe(true)
    expect(sees(setup({ university: ['projectOwner'] }), 'm-victim')).toBe(false)
  })

  it('幹部: 一般以外の役職。全員: ログインしている全員', () => {
    const leaders = setup({ university: ['leaders'] })
    expect(['m-lead', 'm-other'].map((w) => sees(leaders, w))).toEqual([true, false])
    expect(sees(setup({ university: ['all'] }), 'm-other')).toBe(true)
  })

  it('組み合わせ: どれか1つに当たれば見られる', () => {
    const h = setup({ university: ['boss', 'mentor'] }, { mentor: 'm-other' })
    expect(['m-lead', 'm-other', 'm-victim'].map((w) => sees(h, w))).toEqual([true, true, false])
  })

  it('以前の範囲(文字列)は同じ意味: 見る立場の人 = 上長・メンター・プロジェクトの責任者(と代表)', () => {
    const h = setup({ university: 'supervisor' }, { mentor: 'm-other' })
    expect(['m-lead', 'm-other', 'm-top', 'm-victim'].map((w) => sees(h, w))).toEqual([true, true, true, false])
    expect(sees(setup({ university: 'admin' }), 'm-lead')).toBe(true)
    expect(sees(setup({ university: 'self' }), 'm-top')).toBe(false)
  })

  it('狭めるだけの項目(1on1・キャリアの計画など)に、幹部・全員は使わない(保存されていても今までどおり)', () => {
    const h = setup({ one_on_ones_json: ['leaders'], career_plan: ['all'] })
    // 今までどおり: 見る立場の人(上長の班長)は見られ、ほかの人は見られない
    expect(sees(h, 'm-other', 'one_on_ones_json')).toBe(false)
    expect(sees(h, 'm-other', 'career_plan')).toBe(false)
    expect(sees(h, 'm-lead', 'career_plan')).toBe(true)
    // 部署長だけに狭めることはできる
    const narrow = setup({ career_plan: ['deptHead'] }, { tree: [{ path: '広報', headIds: ['m-victim'] }] })
    expect(['m-lead', 'm-victim'].map((w) => sees(narrow, w, 'career_plan'))).toEqual([false, true])
  })
})

describe('独自の項目(キーごと)', () => {
  const custom = (h: H, who: string) => {
    const v = seen(h, who).custom_fields_json
    return v ? JSON.parse(v) : null
  }
  it('設定の無いキーは今までどおり(本人と幹部)。範囲を広げたキーだけは、ほかの人にも返す', () => {
    const h = setup({ 'custom:hobby': ['all'] })
    expect(custom(h, 'm-other')).toEqual({ hobby: '釣り' })
    expect(custom(h, 'm-lead')).toEqual({ hobby: '釣り', shoe: '27' })
    expect(custom(h, 'm-base')).toEqual({ hobby: '釣り', shoe: '27' })
  })
  it('キーを本人だけにすると、幹部にも返さない。見られるキーが無ければ空', () => {
    const h = setup({ 'custom:shoe': [], 'custom:hobby': [] })
    expect(custom(h, 'm-lead')).toBeNull()
    expect(custom(h, 'm-base')).toEqual({ hobby: '釣り', shoe: '27' })
  })
})

describe('日報・週報', () => {
  const withReports = (visibility?: unknown, tree?: unknown) => {
    const h = setup(visibility, { tree })
    h.post({ action: 'submitDailyReport', sessionToken: 'm-base', report: { type: 'daily', date: '2026-10-20', done: 'base の日報' } })
    h.post({ action: 'submitDailyReport', sessionToken: 'm-other', report: { type: 'daily', date: '2026-10-20', done: 'other の日報' } })
    return h
  }
  const reportsOf = (h: H, who: string) => {
    const res = h.post({ action: 'fetchDailyReports', sessionToken: who })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    return (res.result as { memberId: string }[]).map((r) => r.memberId).sort()
  }
  it('設定が無い時: 一般のメンバーは自分の分だけ。日報を見る権限の人(管理者)はすべて', () => {
    const h = withReports()
    expect(reportsOf(h, 'm-base')).toEqual(['m-base'])
    expect(reportsOf(h, 'm-victim')).toEqual([])
    expect(reportsOf(h, 'm-lead')).toEqual(['m-base', 'm-other'])
  })
  it('見せる相手を足せる(部署長)。本人だけにしても、日報を見る権限の人には見せる', () => {
    const h = withReports({ daily_reports: ['deptHead'] }, [{ path: '本部', headIds: ['m-victim'] }])
    expect(reportsOf(h, 'm-victim')).toEqual(['m-base'])
    const selfOnly = withReports({ daily_reports: [] })
    expect(reportsOf(selfOnly, 'm-lead')).toEqual(['m-base', 'm-other'])
    expect(reportsOf(selfOnly, 'm-top')).toEqual(['m-base', 'm-other'])
  })
})

describe('設定の確かめ', () => {
  const save = (h: H, key: string, value: unknown) => h.post({ action: 'updateSetting', sessionToken: 'm-top', key, value: JSON.stringify(value) })
  it('決まりに合わない値は保存しない', () => {
    const h = setup()
    for (const bad of [{ university: ['boss', 'everyone'] }, { career_plan: ['all'] }, { one_on_ones_json: ['leaders'] }, { name: ['all'] },
      { 'custom:': ['all'] }, { university: 'x' }, { university: { boss: true } }]) {
      expect(save(h, 'member_field_visibility', bad).ok, JSON.stringify(bad)).toBe(false)
    }
    for (const good of [{ university: ['boss', 'deptHead'] }, { 'custom:hobby': ['all'], daily_reports: ['boss'] }, { career_plan: [] }, { university: 'supervisor' }]) {
      expect(save(h, 'member_field_visibility', good).ok, JSON.stringify(good)).toBe(true)
    }
  })
  it('部署のツリー: 部署長はメンバーの ID の一覧(20人まで)', () => {
    const h = setup()
    expect(save(h, 'department_tree_config', [{ path: '本部', headIds: ['m-lead'] }]).ok).toBe(true)
    for (const bad of [[{ path: '本部', headIds: 'm-lead' }], [{ path: '', headIds: [] }], [{ path: '本部', headIds: Array(21).fill('m') }], { path: '本部' }]) {
      expect(save(h, 'department_tree_config', bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
  it('初期データに、対応している印を付ける', () => {
    expect(setup().post({ action: 'getInitialData', sessionToken: 'm-base' }).result.fieldAudiences).toBe(1)
  })
})
