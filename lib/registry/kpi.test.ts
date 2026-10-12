// レジストリの管理画面の KPI の計算(lib/registry/kpi.ts)
import { describe, expect, it } from 'vitest'
import {
  KPI_METRICS, KPI_METRIC_BY_ID as M, aggregateOrgs, aggregateSeries, formatChange, formatValue, histogram, lastChange, median, metricKeys,
  orgFlags, orgIndexesOf, orgReporting, orgSeries, seriesCsv, summaryReporting, summarySeries, summaryValue, toCsv, usesV2,
  type KpiGroup, type KpiOrg, type KpiOrgData, type KpiSummary,
} from './kpi'

const KEYS = ['members', 'active_7d', 'active_30d', 'logins_7d', 'opens_7d', 'writes_7d', 'tasks', 'tasks_open', 'tasks_done',
  'tasks_overdue', 'tasks_created_7d', 'tasks_completed_7d', 'projects', 'errors_7d',
  'members_logged_in', 'comments_7d', 'reviews_approved_7d', 'tasks_overdue_days_avg', 'skill_points_total', 'daily_reports_7d',
  'one_on_ones_30d', 'expenses_7d', 'form_submissions_7d', 'applications_rejected_30d']
const SUM_KEYS = [...KEYS, 'tasks_overdue_days_sum']
const WEEKS = ['2026-09-28', '2026-10-05', '2026-10-12']

type Rec = Record<string, number>
const row = (r: Rec | null) => (r ? KEYS.map((key) => (key in r ? r[key] : null)) : null)

// 団体ごとの週の値から、レジストリと同じ決まりで週ごとの合計(全体のデータ)を作る
function summaryOf(orgValues: (Rec | null)[][]): KpiSummary {
  const group = (pick: (r: Rec) => boolean): KpiGroup => {
    const g: KpiGroup = { count: [], sums: [], has: [], pos: [], dsum: [], dhas: [] }
    WEEKS.forEach((_, w) => {
      const sums = SUM_KEYS.map(() => 0)
      const has = SUM_KEYS.map(() => 0)
      const pos = SUM_KEYS.map(() => 0)
      const dsum = SUM_KEYS.map(() => 0)
      const dhas = SUM_KEYS.map(() => 0)
      let count = 0
      for (const org of orgValues) {
        const raw = org[w]
        if (!raw || !pick(raw)) continue
        const r: Rec = { ...raw }
        if ('tasks_overdue_days_avg' in r && 'tasks_overdue' in r) r.tasks_overdue_days_sum = r.tasks_overdue_days_avg * r.tasks_overdue
        const prev = w > 0 ? org[w - 1] : null
        count++
        SUM_KEYS.forEach((key, i) => {
          if (!(key in r)) return
          sums[i] += r[key]; has[i]++
          if (r[key] > 0) pos[i]++
          if (prev && key in prev) { dsum[i] += r[key] - prev[key]; dhas[i]++ }
        })
      }
      g.count.push(count)
      g.sums.push(sums.map((v, i) => (has[i] ? v : null)))
      g.has.push(has); g.pos.push(pos)
      g.dsum.push(dsum.map((v, i) => (dhas[i] ? v : null)))
      g.dhas.push(dhas)
    })
    return g
  }
  return {
    generatedAt: '', filters: { weeks: 4, plan: '', field: '', size: '', affiliation: '', includeInternal: true }, options: { field: [], size: [], affiliation: [] },
    metricKeys: KEYS, sumKeys: SUM_KEYS, v2Keys: KEYS.slice(14), weeks: WEEKS,
    groups: { all: group(() => true), v2: group((r) => 'members_logged_in' in r) },
  } as unknown as KpiSummary
}

const org = (orgId: string, extra: Partial<KpiOrg> = {}): KpiOrg => ({
  orgId, name: orgId, plan: 'ohsumi', state: 'active', suspendCategory: '', contractStatus: 'active', createdAt: '',
  attrs: { field: '', size: '', affiliation: '', started_year: '' }, gasVersion: '2026.10.12-2', versionState: 'latest', gasJudgement: 'latest',
  release: '2026.10.12-2', noCheck: false, dailyStale: false, mailLevel: 'ok', disabledFeatures: 0, tunables: 0, lastReportWeek: WEEKS[2], ...extra,
})

function orgData(orgs: KpiOrg[], values: (Rec | null)[][], prev: (Rec | null)[] = orgs.map(() => null)): KpiOrgData {
  return {
    generatedAt: '', filters: { weeks: 4, plan: '', field: '', size: '', affiliation: '', includeInternal: true }, options: { field: [], size: [], affiliation: [] },
    metricKeys: KEYS, v2Keys: KEYS.slice(14), weeks: WEEKS, orgs, values: values.map((weeks) => weeks.map(row)), prev: prev.map(row),
  }
}

// 団体A(版2): 毎週送る / 団体B(版1): 2週目だけ送らない / 団体C(版2): 最後の週だけ
const A = [{ members: 10, active_7d: 5, active_30d: 8, members_logged_in: 9, comments_7d: 4, tasks: 20, tasks_done: 10, tasks_open: 10, tasks_overdue: 2, tasks_overdue_days_avg: 3 },
  { members: 12, active_7d: 6, active_30d: 9, members_logged_in: 10, comments_7d: 0, tasks: 22, tasks_done: 12, tasks_open: 10, tasks_overdue: 4, tasks_overdue_days_avg: 5 },
  { members: 12, active_7d: 3, active_30d: 9, members_logged_in: 11, comments_7d: 6, tasks: 24, tasks_done: 14, tasks_open: 10, tasks_overdue: 5, tasks_overdue_days_avg: 6 }]
const B = [{ members: 4, active_7d: 4, active_30d: 4, tasks: 10, tasks_done: 0, tasks_open: 10, tasks_overdue: 1 }, null,
  { members: 6, active_7d: 3, active_30d: 5, tasks: 10, tasks_done: 5, tasks_open: 5, tasks_overdue: 0 }]
const C = [null, null, { members: 2, active_7d: 2, active_30d: 2, members_logged_in: 1, comments_7d: 0, tasks: 0, tasks_done: 0, tasks_open: 0, tasks_overdue: 0, tasks_overdue_days_avg: 0 }]

describe('指標の一覧', () => {
  it('どの指標も名前・説明・単位を持ち、ID が重ならない。版2の項目を使う指標が分かる', () => {
    expect(new Set(KPI_METRICS.map((m) => m.id)).size).toBe(KPI_METRICS.length)
    for (const m of KPI_METRICS) {
      expect(m.label && m.description && m.unit).toBeTruthy()
      for (const key of metricKeys(m)) expect([...SUM_KEYS]).toContain(key)
      if (m.changeOf) expect(M[m.changeOf]).toBeTruthy()
    }
    expect(usesV2(M.active_rate_7d)).toBe(false)
    expect(usesV2(M.logged_in_rate)).toBe(true)
    expect(usesV2(M.overdue_days)).toBe(true)
  })
})

describe('全体のデータ(週ごとの合計)', () => {
  const s = summaryOf([A, B, C])

  it('合計・率は合計どうしの割り算。送ってきた団体の数', () => {
    expect(summaryValue(s, M.members, 2)).toBe(20)
    expect(summaryValue(s, M.active_rate_7d, 2)).toBeCloseTo(8 / 20)
    expect(summaryReporting(s, null, 1)).toBe(1)
    expect(summaryReporting(s, null, 2)).toBe(3)
    // 送ってこなかった団体があっても、率は送ってきた団体だけで計算する
    expect(summaryValue(s, M.active_rate_7d, 1)).toBeCloseTo(6 / 12)
  })

  it('版2の項目を使う指標は、版2の団体だけで計算する(版1の団体を 0 として数えない)', () => {
    // 一度でもログインした人の割合: (11 + 1) ÷ (12 + 2)。版1の B のメンバー(6人)を分母に入れない
    expect(summaryValue(s, M.logged_in_rate, 2)).toBeCloseTo(12 / 14)
    expect(summaryReporting(s, M.logged_in_rate, 2)).toBe(2)
    // 期限切れの平均日数は、団体の平均を期限切れの数で重み付け
    expect(summaryValue(s, M.overdue_days, 2)).toBeCloseTo((6 * 5 + 0) / 5)
    // 版2の団体が1つも無い週は「—」
    const v1only = summaryOf([B])
    expect(summaryValue(v1only, M.logged_in_rate, 0)).toBeNull()
  })

  it('前の週との差は、前の週も送ってきた団体だけ。機能の使われ方は、1以上の団体の割合', () => {
    expect(summaryValue(s, M.members_delta, 1)).toBe(2)
    expect(summaryValue(s, M.members_delta, 2)).toBe(0)
    expect(summaryValue(s, M.use_comments, 2)).toBeCloseTo(1 / 2)
    expect(summaryValue(s, M.use_comments, 1)).toBe(0)
    expect(summaryValue(s, M.skill_points_per_member_change, 0)).toBeNull()
    expect(summarySeries(s, M.members)).toEqual([14, 12, 20])
  })
})

describe('団体別のデータ', () => {
  const d = orgData([org('A'), org('B', { plan: 'cosmo_base' }), org('C', { plan: 'internal' })], [A, B, C], [{ members: 9 }, null, null])
  const all = orgIndexesOf(d)

  it('合計は全体のデータと同じ。平均・中央値は団体ごとの値から', () => {
    const s = summaryOf([A, B, C])
    for (const m of [M.members, M.active_rate_7d, M.logged_in_rate, M.overdue_days, M.completion_rate, M.use_comments]) {
      expect(aggregateOrgs(d, all, m, 2, 'sum').value).toBeCloseTo(summaryValue(s, m, 2)!)
    }
    // アクティブ率: A 3/12・B 3/6・C 2/2
    expect(aggregateOrgs(d, all, M.active_rate_7d, 2, 'mean').value).toBeCloseTo((0.25 + 0.5 + 1) / 3)
    expect(aggregateOrgs(d, all, M.active_rate_7d, 2, 'median').value).toBeCloseTo(0.5)
    expect(aggregateOrgs(d, all, M.members, 2, 'median')).toEqual({ value: 6, n: 3 })
    expect(orgReporting(d, all, 1)).toBe(1)
  })

  it('FSIF の団体を含める・外す(団体の番号の選び方)', () => {
    const noInternal = orgIndexesOf(d, (o) => o.plan !== 'internal')
    expect(aggregateOrgs(d, noInternal, M.members, 2, 'sum').value).toBe(18)
    expect(aggregateOrgs(d, all, M.members, 2, 'sum').value).toBe(20)
  })

  it('1つの団体の推移。送ってこなかった週・版1の項目は null。前の週の差は期間の前の週も使う', () => {
    expect(orgSeries(d, 1, M.members)).toEqual([4, null, 6])
    expect(orgSeries(d, 1, M.logged_in_rate)).toEqual([null, null, null])
    expect(orgSeries(d, 0, M.members_delta)).toEqual([1, 2, 0])
    expect(aggregateSeries(d, all, M.members, 'sum')).toEqual([14, 12, 20])
  })

  it('注意の印', () => {
    const flagged = orgData([
      org('X', { lastReportWeek: WEEKS[0], versionState: 'updateRequired', dailyStale: true, mailLevel: 'reached' }),
      org('Y'),
      org('Z', { lastReportWeek: '' }),
    ], [[{ members: 10, active_7d: 8, tasks_open: 10, tasks_overdue: 1 }, null, null],
      [{ members: 10, active_7d: 8, tasks_open: 10, tasks_overdue: 1 }, { members: 10, active_7d: 7 }, { members: 10, active_7d: 5, tasks_open: 10, tasks_overdue: 3 }],
      [null, null, null]])
    expect(orgFlags(flagged, 0)).toEqual(['noData', 'versionOld', 'dailyStale', 'mailReached'])
    expect(orgFlags(flagged, 1)).toEqual(['overdueHigh'])
    expect(orgFlags(flagged, 2)).toEqual(['noData'])
    // アクティブ率が 20 ポイント以上下がった
    const drop = orgData([org('Y')], [[{ members: 10, active_7d: 8 }, null, { members: 10, active_7d: 5 }]])
    expect(orgFlags(drop, 0)).toEqual(['activeDrop'])
  })
})

describe('表示・CSV', () => {
  it('値の形・差の形・中央値・分布・前の週との差', () => {
    expect(formatValue(null, 'count')).toBe('—')
    expect(formatValue(0.1234, 'percent')).toBe('12.3%')
    expect(formatValue(1234.4, 'count')).toBe('1,234')
    expect(formatValue(2.345, 'number')).toBe('2.35')
    expect(formatChange(0.05, 'percent')).toBe('+5.0ポイント')
    expect(formatChange(-3, 'count')).toBe('−3')
    expect(median([3, 1, 2, 10])).toBe(2.5)
    expect(histogram([0, 5, 10, 25], [0, 10, 20])).toEqual([{ from: 0, to: 10, count: 2 }, { from: 10, to: 20, count: 1 }, { from: 20, to: null, count: 1 }])
    expect(lastChange([1, null, 3])).toEqual({ value: 3, change: null })
    expect(lastChange([1, 2, 5])).toEqual({ value: 5, change: 3 })
  })

  it('CSV は BOM 付き。区切り・引用符を守り、数式として読まれる文字を無害にする', () => {
    const csv = toCsv([['団体', '値'], ['=HYPERLINK("x")', 1], ['a,b', null], ['-5', -5]])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('"\'=HYPERLINK(""x"")",1')
    expect(csv).toContain('"a,b",\r\n')
    expect(csv).toContain("'-5,-5")
    expect(seriesCsv(['2026-10-05'], [{ name: 'メンバー数', values: [3] }], [2])).toBe('﻿週,送ってきた団体の数,メンバー数\r\n2026-10-05,2,3\r\n')
  })
})
