// レジストリの管理画面の「KPI」タブの計算(純粋な関数。画面の部品は components/registry/kpi-tab.tsx)。
//
// レジストリが返す2つの形(registry/Code.gs の getKpiSummary_・getKpiOrgs_)から、指標の値・推移・表・CSV を作る。
// - 指標は KPI_METRICS の一覧(名前・説明・分子・分母・単位)で決める。足す時は一覧に1行足す
// - まとめ方: sum(合計。率は「合計どうしの割り算」)/ mean(団体ごとの値の平均)/ median(団体ごとの値の中央値)
// - その週に送ってこなかった団体は数えない(率は送ってきた団体だけで計算する)。推移には送ってきた団体の数も出す
// - 集計値の版1の団体には、版2の項目が無い。版2の項目を使う指標は、版2の団体だけで計算する(0 として数えない。無ければ null =「—」)
// - 全体のデータ(週ごとの合計)では、合計しか出せない。平均・中央値は、団体別のデータから出す

import type { Plan } from './admin-api'

export const KPI_WEEK_CHOICES = [4, 12, 26, 52, 0] as const
export type KpiWeeks = (typeof KPI_WEEK_CHOICES)[number]
export const KPI_WEEK_LABELS: Record<KpiWeeks, string> = { 4: '4週', 12: '12週', 26: '26週', 52: '52週', 0: '全期間' }

export interface KpiFilters {
  weeks: KpiWeeks
  // '' = 全部 / 'none' = 未設定
  plan: '' | 'none' | Plan
  field: string
  size: string
  affiliation: string
  includeInternal: boolean
}

export const DEFAULT_KPI_FILTERS: KpiFilters = { weeks: 26, plan: '', field: '', size: '', affiliation: '', includeInternal: true }

export interface KpiGroup {
  count: number[]
  sums: (number | null)[][]
  has: number[][]
  pos: number[][]
  dsum: (number | null)[][]
  dhas: number[][]
}

export interface KpiStats { n: number; mean: number | null; median: number | null }

export interface KpiSummary {
  generatedAt: string
  filters: KpiFilters
  options: { field: string[]; size: string[]; affiliation: string[] }
  metricKeys: string[]
  sumKeys: string[]
  v2Keys: string[]
  weeks: string[]
  groups: { all: KpiGroup; v2: KpiGroup }
  orgs: {
    total: number
    // 状態は重ならない3つ(利用中 + 機能停止中 + 提供停止中 = total)。利用中は有効・停止予定
    active: number
    restricted: KpiStopCounts
    suspended: KpiStopCounts
    byPlan: Partial<Record<Plan | '', number>>
    byContract: Record<string, number>
    newByWeek: number[]
    endedByWeek: number[]
    newByMonth: Record<string, number>
    endedByMonth: Record<string, number>
    byAttr: Record<'field' | 'size' | 'affiliation' | 'started_year', Record<string, number>>
  }
  ops: {
    versions: Record<string, number>
    updateRequired: number
    outdated: number
    noCheck: number
    dailyStale: number
    mailReached: number
    mailLow: number
    featuresDisabled: number
    tunablesChanged: number
    diagnostics: number
    diagnosticsInPeriod: number
  }
  fsif: {
    surveys: { sent: number; answered: number; open: number; overdue: number; cancelled: number; restricted: number; daysToAnswer: KpiStats }
    codes: { issued: number; used: number; unused: number; expired: number; revoked: number; daysToUse: KpiStats }
    announcements: { published: number }
  }
  cohort: { maxOffset: number; rows: { week: string; size: number; reported: number[]; active: number[] }[] }
  dist: { members: number[]; activeRate7d: number[]; overdueRate: number[]; ageDays: number[] }
}

export interface KpiStopCounts { total: number; survey: number; contract: number; manual: number }

// KPI の状態(重ならない3つ)と、停止の理由
export type KpiState = 'active' | 'restricted' | 'suspended'
export const KPI_STATE_LABELS: Record<KpiState, string> = { active: '利用中', restricted: '機能停止中', suspended: '提供停止中' }
export const KPI_STOP_REASON_LABELS: Record<'survey' | 'contract' | 'manual', string> = { survey: 'アンケート未回答', contract: '契約終了', manual: '手動' }

/** 団体の状態の表示(停止は理由つき。停止予定は利用中に入れ、そのことも出す) */
export function kpiStateLabel(o: Pick<KpiOrg, 'kpiState' | 'state' | 'suspendCategory'>): string {
  if (o.kpiState === 'active') return o.state === 'scheduled' ? '利用中(停止予定)' : '利用中'
  return `${KPI_STATE_LABELS[o.kpiState]}(${o.suspendCategory ? KPI_STOP_REASON_LABELS[o.suspendCategory] : '手動'})`
}

export interface KpiOrg {
  orgId: string
  name: string
  plan: Plan | ''
  state: 'active' | 'scheduled' | 'restricted' | 'suspended'
  // 重ならない3つの状態(有効・停止予定は active)
  kpiState: KpiState
  suspendCategory: '' | 'manual' | 'survey' | 'contract'
  contractStatus: string
  createdAt: string
  attrs: { field: string; size: string; affiliation: string; started_year: string }
  gasVersion: string
  versionState: 'latest' | 'outdated' | 'updateRequired'
  gasJudgement: string
  release: string
  noCheck: boolean
  dailyStale: boolean
  mailLevel: 'reached' | 'low' | 'ok' | 'unknown'
  disabledFeatures: number
  tunables: number
  lastReportWeek: string
}

export interface KpiOrgData {
  generatedAt: string
  filters: KpiFilters
  options: { field: string[]; size: string[]; affiliation: string[] }
  metricKeys: string[]
  v2Keys: string[]
  weeks: string[]
  orgs: KpiOrg[]
  // values[団体][週] = METRIC_KEYS の順の数字の配列(項目が無ければ null)。送ってこなかった週は null
  values: ((number | null)[] | null)[][]
  // 期間の1つ前の週の値(差を出すため)
  prev: ((number | null)[] | null)[]
}

// ---- 指標の一覧 ----

// 分子: 項目そのまま / 2つの項目の差 / 前の週との差(前の週も送ってきた団体だけ)/ その項目が1以上の団体(機能の使われ方)
export type KpiTerm = { key: string } | { minus: [string, string] } | { delta: string } | { positive: string }
export type KpiUnit = 'count' | 'percent' | 'number' | 'days'
export type KpiCategory = 'people' | 'depth' | 'tasks' | 'growth' | 'requests' | 'quality' | 'features'

export interface KpiMetric {
  id: string
  label: string
  description: string
  category: KpiCategory
  num: KpiTerm
  // 分母の項目(無ければ分子だけ)。positive の指標は、その項目を送ってきた団体の数で割る
  den?: string
  unit: KpiUnit
  // 前の週との差の指標: この指標の値の、前の週との差
  changeOf?: string
}

export const KPI_CATEGORY_LABELS: Record<KpiCategory, string> = {
  people: '人', depth: '使い方の深さ', tasks: 'タスク', growth: '育成', requests: '申請', quality: '品質', features: '機能の使われ方',
}

const k = (key: string): KpiTerm => ({ key })

export const KPI_METRICS: KpiMetric[] = [
  // 人
  { id: 'members', label: 'メンバー数', description: 'members', category: 'people', num: k('members'), unit: 'count' },
  { id: 'members_delta', label: 'メンバー数の増減', description: 'members の前の週との差(前の週も送ってきた団体だけ)', category: 'people', num: { delta: 'members' }, unit: 'count' },
  { id: 'active_7d', label: '7日のアクティブ', description: 'active_7d', category: 'people', num: k('active_7d'), unit: 'count' },
  { id: 'active_30d', label: '30日のアクティブ', description: 'active_30d', category: 'people', num: k('active_30d'), unit: 'count' },
  { id: 'active_rate_7d', label: 'アクティブ率(7日)', description: 'active_7d ÷ members', category: 'people', num: k('active_7d'), den: 'members', unit: 'percent' },
  { id: 'active_rate_30d', label: 'アクティブ率(30日)', description: 'active_30d ÷ members', category: 'people', num: k('active_30d'), den: 'members', unit: 'percent' },
  { id: 'logged_in_rate', label: '一度でもログインした人の割合', description: 'members_logged_in ÷ members(版2)', category: 'people', num: k('members_logged_in'), den: 'members', unit: 'percent' },
  { id: 'stickiness', label: '定着率', description: 'active_7d ÷ active_30d', category: 'people', num: k('active_7d'), den: 'active_30d', unit: 'percent' },
  // 使い方の深さ
  { id: 'logins_per_member', label: '1人あたりのログイン', description: 'logins_7d ÷ members', category: 'depth', num: k('logins_7d'), den: 'members', unit: 'number' },
  { id: 'writes_per_active', label: 'アクティブ1人あたりの書き込み', description: 'writes_7d ÷ active_7d', category: 'depth', num: k('writes_7d'), den: 'active_7d', unit: 'number' },
  { id: 'opens_per_login', label: 'ログインあたりの画面の読み込み', description: 'opens_7d ÷ logins_7d', category: 'depth', num: k('opens_7d'), den: 'logins_7d', unit: 'number' },
  { id: 'comments_per_active', label: 'アクティブ1人あたりのコメント', description: 'comments_7d ÷ active_7d(版2)', category: 'depth', num: k('comments_7d'), den: 'active_7d', unit: 'number' },
  // タスク
  { id: 'tasks', label: 'タスク', description: 'tasks', category: 'tasks', num: k('tasks'), unit: 'count' },
  { id: 'tasks_open', label: '未完了のタスク', description: 'tasks_open', category: 'tasks', num: k('tasks_open'), unit: 'count' },
  { id: 'completion_rate', label: '完了率', description: 'tasks_done ÷ tasks', category: 'tasks', num: k('tasks_done'), den: 'tasks', unit: 'percent' },
  { id: 'overdue_rate', label: '期限切れの率', description: 'tasks_overdue ÷ tasks_open', category: 'tasks', num: k('tasks_overdue'), den: 'tasks_open', unit: 'percent' },
  { id: 'overdue_days', label: '期限切れの平均日数', description: '(tasks_overdue_days_avg × tasks_overdue)の合計 ÷ tasks_overdue(版2)', category: 'tasks', num: k('tasks_overdue_days_sum'), den: 'tasks_overdue', unit: 'days' },
  { id: 'tasks_created_7d', label: '週の作成', description: 'tasks_created_7d', category: 'tasks', num: k('tasks_created_7d'), unit: 'count' },
  { id: 'tasks_completed_7d', label: '週の完了', description: 'tasks_completed_7d', category: 'tasks', num: k('tasks_completed_7d'), unit: 'count' },
  { id: 'backlog_change', label: '残りの増減(作成 − 完了)', description: 'tasks_created_7d − tasks_completed_7d', category: 'tasks', num: { minus: ['tasks_created_7d', 'tasks_completed_7d'] }, unit: 'count' },
  { id: 'throughput', label: '処理の率', description: 'tasks_completed_7d ÷ tasks_created_7d', category: 'tasks', num: k('tasks_completed_7d'), den: 'tasks_created_7d', unit: 'percent' },
  { id: 'open_per_member', label: '1人あたりの未完了', description: 'tasks_open ÷ members', category: 'tasks', num: k('tasks_open'), den: 'members', unit: 'number' },
  { id: 'tasks_per_project', label: 'プロジェクトあたりのタスク', description: 'tasks ÷ projects', category: 'tasks', num: k('tasks'), den: 'projects', unit: 'number' },
  // 育成
  { id: 'skill_points_per_member', label: '1人あたりのスキルのポイント', description: 'skill_points_total ÷ members(版2)', category: 'growth', num: k('skill_points_total'), den: 'members', unit: 'number' },
  { id: 'skill_points_per_member_change', label: '1人あたりのスキルのポイントの増え方', description: '1人あたりのスキルのポイントの、前の週との差', category: 'growth', num: k('skill_points_total'), den: 'members', unit: 'number', changeOf: 'skill_points_per_member' },
  { id: 'one_on_ones_per_member', label: 'メンバーあたりの1on1(30日)', description: 'one_on_ones_30d ÷ members(版2)', category: 'growth', num: k('one_on_ones_30d'), den: 'members', unit: 'number' },
  { id: 'daily_reports_per_active', label: 'アクティブあたりの日報', description: 'daily_reports_7d ÷ active_7d(版2)', category: 'growth', num: k('daily_reports_7d'), den: 'active_7d', unit: 'number' },
  // 申請
  { id: 'expenses_7d', label: '経費の申請', description: 'expenses_7d(版2)', category: 'requests', num: k('expenses_7d'), unit: 'count' },
  { id: 'form_submissions_7d', label: 'フォームの回答', description: 'form_submissions_7d(版2)', category: 'requests', num: k('form_submissions_7d'), unit: 'count' },
  { id: 'applications_rejected_30d', label: '差し戻し(30日)', description: 'applications_rejected_30d(版2)', category: 'requests', num: k('applications_rejected_30d'), unit: 'count' },
  // 品質
  { id: 'errors_7d', label: 'エラー', description: 'errors_7d', category: 'quality', num: k('errors_7d'), unit: 'count' },
  { id: 'errors_per_write', label: '書き込みあたりのエラー', description: 'errors_7d ÷ writes_7d', category: 'quality', num: k('errors_7d'), den: 'writes_7d', unit: 'percent' },
  // 機能の使われ方(その週に1件以上使った団体の割合)
  { id: 'use_comments', label: 'コメントを使った団体', description: 'comments_7d が1以上の団体 ÷ 送ってきた団体(版2)', category: 'features', num: { positive: 'comments_7d' }, unit: 'percent' },
  { id: 'use_reviews', label: '確認を使った団体', description: 'reviews_approved_7d が1以上の団体 ÷ 送ってきた団体(版2)', category: 'features', num: { positive: 'reviews_approved_7d' }, unit: 'percent' },
  { id: 'use_daily_reports', label: '日報を使った団体', description: 'daily_reports_7d が1以上の団体 ÷ 送ってきた団体(版2)', category: 'features', num: { positive: 'daily_reports_7d' }, unit: 'percent' },
  { id: 'use_one_on_ones', label: '1on1 を使った団体(30日)', description: 'one_on_ones_30d が1以上の団体 ÷ 送ってきた団体(版2)', category: 'features', num: { positive: 'one_on_ones_30d' }, unit: 'percent' },
  { id: 'use_expenses', label: '経費を使った団体', description: 'expenses_7d が1以上の団体 ÷ 送ってきた団体(版2)', category: 'features', num: { positive: 'expenses_7d' }, unit: 'percent' },
  { id: 'use_forms', label: 'フォームを使った団体', description: 'form_submissions_7d が1以上の団体 ÷ 送ってきた団体(版2)', category: 'features', num: { positive: 'form_submissions_7d' }, unit: 'percent' },
]

export const KPI_METRIC_BY_ID: Record<string, KpiMetric> = Object.fromEntries(KPI_METRICS.map((m) => [m.id, m]))

export type KpiAgg = 'sum' | 'mean' | 'median'
export const KPI_AGG_LABELS: Record<KpiAgg, string> = { sum: '合計(率は合計どうしの割り算)', mean: '団体ごとの平均', median: '団体ごとの中央値' }

// 版2で足した項目(registry/Code.gs の KPI_V2_KEYS と同じ。組み合わせの元の値の tasks_overdue_days_sum も版2の項目から作る)
export const KPI_V2_KEYS = ['members_logged_in', 'comments_7d', 'reviews_approved_7d', 'tasks_overdue_days_avg', 'skill_points_total', 'daily_reports_7d',
  'one_on_ones_30d', 'expenses_7d', 'form_submissions_7d', 'applications_rejected_30d', 'tasks_overdue_days_sum']

/** 指標が使う項目 */
export function metricKeys(m: KpiMetric): string[] {
  const t = m.num
  const keys = 'key' in t ? [t.key] : 'minus' in t ? [...t.minus] : 'delta' in t ? [t.delta] : [t.positive]
  return m.den ? [...keys, m.den] : keys
}

/** 版2の項目を使う指標か(版2の団体だけで計算する) */
export function usesV2(m: KpiMetric): boolean {
  return metricKeys(m).some((key) => KPI_V2_KEYS.includes(key))
}

// ---- 全体のデータ(週ごとの合計)から ----

/** 週 w の値(合計。率は合計どうしの割り算)。出せない時は null */
export function summaryValue(s: KpiSummary, m: KpiMetric, w: number): number | null {
  if (m.changeOf) {
    const base = KPI_METRIC_BY_ID[m.changeOf]
    if (!base || w < 1) return null
    const now = summaryValue(s, base, w)
    const before = summaryValue(s, base, w - 1)
    return now === null || before === null ? null : now - before
  }
  const g = usesV2(m) ? s.groups.v2 : s.groups.all
  if (!g.count[w]) return null
  const idx = (key: string) => s.sumKeys.indexOf(key)
  const sum = (key: string) => (idx(key) < 0 ? null : g.sums[w][idx(key)])
  const t = m.num
  if ('positive' in t) {
    const i = idx(t.positive)
    const has = i < 0 ? 0 : g.has[w][i]
    return has ? g.pos[w][i] / has : null
  }
  let num: number | null
  if ('key' in t) num = sum(t.key)
  else if ('minus' in t) {
    const a = sum(t.minus[0])
    const b = sum(t.minus[1])
    num = a === null || b === null ? null : a - b
  } else {
    const i = idx(t.delta)
    num = i < 0 ? null : g.dsum[w][i]
  }
  if (num === null) return null
  if (!m.den) return num
  const den = sum(m.den)
  return den ? num / den : null
}

/** その週に送ってきた団体の数(指標が版2の項目を使う時は、版2の団体の数) */
export function summaryReporting(s: KpiSummary, m: KpiMetric | null, w: number): number {
  return (m && usesV2(m) ? s.groups.v2 : s.groups.all).count[w] ?? 0
}

/** 週ごとの推移(全体のデータ) */
export function summarySeries(s: KpiSummary, m: KpiMetric): (number | null)[] {
  return s.weeks.map((_, w) => summaryValue(s, m, w))
}

// ---- 団体別のデータから ----

/** 団体の1週の値を、項目名から引ける形にする(組み合わせの元の値も足す) */
export function orgWeekRecord(keys: string[], row: (number | null)[] | null): Record<string, number> | null {
  if (!row) return null
  const out: Record<string, number> = {}
  keys.forEach((key, i) => { if (typeof row[i] === 'number') out[key] = row[i] as number })
  if (typeof out.tasks_overdue_days_avg === 'number' && typeof out.tasks_overdue === 'number') out.tasks_overdue_days_sum = out.tasks_overdue_days_avg * out.tasks_overdue
  return out
}

/** 1つの団体の1週の、分子・分母(出せない時は null) */
export function orgParts(m: KpiMetric, cur: Record<string, number> | null, prev: Record<string, number> | null): { num: number; den: number } | null {
  if (!cur) return null
  const t = m.num
  let num: number | undefined
  if ('key' in t) num = cur[t.key]
  else if ('minus' in t) num = cur[t.minus[0]] === undefined || cur[t.minus[1]] === undefined ? undefined : cur[t.minus[0]] - cur[t.minus[1]]
  else if ('delta' in t) num = prev && prev[t.delta] !== undefined && cur[t.delta] !== undefined ? cur[t.delta] - prev[t.delta] : undefined
  else num = cur[t.positive] === undefined ? undefined : cur[t.positive] > 0 ? 1 : 0
  if (num === undefined) return null
  if ('positive' in t) return { num, den: 1 }
  if (!m.den) return { num, den: 1 }
  const den = cur[m.den]
  if (den === undefined || den === 0) return null
  return { num, den }
}

/** 1つの団体の、週ごとの値の推移 */
export function orgSeries(data: KpiOrgData, orgIndex: number, m: KpiMetric): (number | null)[] {
  const recs = data.values[orgIndex].map((row) => orgWeekRecord(data.metricKeys, row))
  const prevRec = orgWeekRecord(data.metricKeys, data.prev[orgIndex] ?? null)
  const single = (w: number, metric: KpiMetric): number | null => {
    const p = orgParts(metric, recs[w], w > 0 ? recs[w - 1] : prevRec)
    if (!p) return null
    return metric.den || 'positive' in metric.num ? p.num / p.den : p.num
  }
  return data.weeks.map((_, w) => {
    if (m.changeOf) {
      const base = KPI_METRIC_BY_ID[m.changeOf]
      if (!base) return null
      const now = single(w, base)
      const before = w > 0 ? single(w - 1, base) : null
      return now === null || before === null ? null : now - before
    }
    return single(w, m)
  })
}

export function median(list: number[]): number | null {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function mean(list: number[]): number | null {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null
}

/** 団体をまとめた週 w の値。orgIndexes は数える団体(絞り込んだ後) */
export function aggregateOrgs(data: KpiOrgData, orgIndexes: number[], m: KpiMetric, w: number, agg: KpiAgg): { value: number | null; n: number } {
  if (m.changeOf) {
    const base = KPI_METRIC_BY_ID[m.changeOf]
    if (!base || w < 1) return { value: null, n: 0 }
    if (agg !== 'sum') {
      const vals = orgIndexes.map((o) => orgSeries(data, o, m)[w]).filter((v): v is number => v !== null)
      return { value: agg === 'mean' ? mean(vals) : median(vals), n: vals.length }
    }
    const now = aggregateOrgs(data, orgIndexes, base, w, agg)
    const before = aggregateOrgs(data, orgIndexes, base, w - 1, agg)
    return { value: now.value === null || before.value === null ? null : now.value - before.value, n: now.n }
  }
  const parts: { num: number; den: number }[] = []
  for (const o of orgIndexes) {
    const cur = orgWeekRecord(data.metricKeys, data.values[o][w])
    const prev = orgWeekRecord(data.metricKeys, w > 0 ? data.values[o][w - 1] : data.prev[o] ?? null)
    const p = orgParts(m, cur, prev)
    if (p) parts.push(p)
  }
  if (!parts.length) return { value: null, n: 0 }
  const ratio = !!m.den || 'positive' in m.num
  if (agg === 'sum') {
    const num = parts.reduce((a, p) => a + p.num, 0)
    const den = parts.reduce((a, p) => a + p.den, 0)
    return { value: ratio ? (den ? num / den : null) : num, n: parts.length }
  }
  const vals = parts.map((p) => (ratio ? p.num / p.den : p.num))
  return { value: agg === 'mean' ? mean(vals) : median(vals), n: parts.length }
}

/** その週に送ってきた団体の数(団体別のデータ) */
export function orgReporting(data: KpiOrgData, orgIndexes: number[], w: number): number {
  return orgIndexes.filter((o) => data.values[o][w] !== null).length
}

/** 絞り込み(プラン)に合う団体の番号 */
export function orgIndexesOf(data: KpiOrgData, pred: (o: KpiOrg) => boolean = () => true): number[] {
  return data.orgs.map((o, i) => (pred(o) ? i : -1)).filter((i) => i >= 0)
}

/** 団体別のデータで、全体の推移(平均・中央値を選んだ時) */
export function aggregateSeries(data: KpiOrgData, orgIndexes: number[], m: KpiMetric, agg: KpiAgg): (number | null)[] {
  return data.weeks.map((_, w) => aggregateOrgs(data, orgIndexes, m, w, agg).value)
}

// ---- 注意の印(団体別の表) ----
// しきい値(registry/README.md の「1.19」に書く)
export const KPI_FLAG_NO_DATA_WEEKS = 2
export const KPI_FLAG_ACTIVE_DROP = 0.2
export const KPI_FLAG_OVERDUE_RATE = 0.3

export type KpiFlag = 'noData' | 'activeDrop' | 'overdueHigh' | 'versionOld' | 'dailyStale' | 'mailReached'
export const KPI_FLAG_LABELS: Record<KpiFlag, string> = {
  noData: `集計値が${KPI_FLAG_NO_DATA_WEEKS}週以上届いていない`,
  activeDrop: `アクティブ率(7日)が${KPI_FLAG_ACTIVE_DROP * 100}ポイント以上下がった`,
  overdueHigh: `期限切れの率が${KPI_FLAG_OVERDUE_RATE * 100}%以上`,
  versionOld: '版が古い(配る版より古い)',
  dailyStale: '毎日の処理が止まっている',
  mailReached: 'メールの上限に達した',
}

function weeksBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / (7 * 24 * 3600 * 1000))
}

/** 団体の注意の印 */
export function orgFlags(data: KpiOrgData, orgIndex: number): KpiFlag[] {
  const o = data.orgs[orgIndex]
  const out: KpiFlag[] = []
  const current = data.weeks[data.weeks.length - 1]
  if (current && (!o.lastReportWeek || weeksBetween(o.lastReportWeek, current) >= KPI_FLAG_NO_DATA_WEEKS)) out.push('noData')
  const rate = orgSeries(data, orgIndex, KPI_METRIC_BY_ID.active_rate_7d).filter((v): v is number => v !== null)
  if (rate.length >= 2 && rate[rate.length - 2] - rate[rate.length - 1] >= KPI_FLAG_ACTIVE_DROP) out.push('activeDrop')
  const overdue = orgSeries(data, orgIndex, KPI_METRIC_BY_ID.overdue_rate).filter((v): v is number => v !== null)
  if (overdue.length && overdue[overdue.length - 1] >= KPI_FLAG_OVERDUE_RATE) out.push('overdueHigh')
  if (o.versionState !== 'latest') out.push('versionOld')
  if (o.dailyStale) out.push('dailyStale')
  if (o.mailLevel === 'reached') out.push('mailReached')
  return out
}

/** その指標の、一番新しい値(送ってきた週のうち) */
export function lastValue(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null) return series[i]
  return null
}

/** 一番新しい値と、その前の値の差(カードの「前の週との差」) */
export function lastChange(series: (number | null)[]): { value: number | null; change: number | null } {
  const v = series[series.length - 1] ?? null
  const before = series.length >= 2 ? series[series.length - 2] : null
  return { value: v, change: v === null || before === null ? null : v - before }
}

// ---- 表示 ----

export function formatValue(v: number | null | undefined, unit: KpiUnit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (unit === 'percent') return `${(v * 100).toFixed(1)}%`
  if (unit === 'number') return v.toFixed(2)
  if (unit === 'days') return `${v.toFixed(1)}日`
  return Math.round(v).toLocaleString('ja-JP')
}

export function formatChange(v: number | null, unit: KpiUnit): string {
  if (v === null || !Number.isFinite(v)) return '—'
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±'
  const abs = Math.abs(v)
  if (unit === 'percent') return `${sign}${(abs * 100).toFixed(1)}ポイント`
  return sign + formatValue(abs, unit)
}

/** 週の表示(MM/DD) */
export function weekLabel(week: string): string {
  return week.slice(5).replace('-', '/')
}

/** 分布の区切り(値の一覧を、区切りごとの数にする)。edges は区切りの下限(昇順) */
export function histogram(values: number[], edges: number[]): { from: number; to: number | null; count: number }[] {
  return edges.map((from, i) => {
    const to = i + 1 < edges.length ? edges[i + 1] : null
    return { from, to, count: values.filter((v) => v >= from && (to === null || v < to)).length }
  })
}

// ---- CSV ----

/** CSV の文字列(Excel で文字化けしないよう先頭に BOM を付ける) */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    // 数式として読まれないように(=・+・-・@ で始まる文字は ' を付ける。数は付けない)
    const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? "'" + s : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** 推移の CSV(週・送ってきた団体の数・系列ごとの値) */
export function seriesCsv(weeks: string[], series: { name: string; values: (number | null)[] }[], reporting?: number[]): string {
  const head = ['週', ...(reporting ? ['送ってきた団体の数'] : []), ...series.map((s) => s.name)]
  return toCsv([head, ...weeks.map((w, i) => [w, ...(reporting ? [reporting[i]] : []), ...series.map((s) => s.values[i])])])
}
