'use client'

// レジストリの管理画面の「KPI」タブ。全体・プラン別・団体別の3つに分ける。
// - 開いた時は「全体」を選び、全体の分(getKpiSummary。週ごとの合計)だけを読む
// - 「プラン別」「団体別」は、選んだ時に初めて読む(getKpiOrgs)。一度読んだら、切り替えても読み直さない(絞り込みを変えた時・「読み直す」の時だけ)
// - 全体で「平均・中央値」を選んだ時は、団体ごとの値が要るので、団体別のデータを読む
// 計算は lib/registry/kpi.ts(純粋な関数)、グラフは ./kpi-charts.tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  RegistryError,
  getKpiOrgs,
  getKpiSummary,
  type AdminSession,
  type Plan,
} from '@/lib/registry/admin-api'
import {
  DEFAULT_KPI_FILTERS,
  KPI_AGG_LABELS,
  KPI_CATEGORY_LABELS,
  KPI_FLAG_LABELS,
  KPI_METRICS,
  KPI_METRIC_BY_ID,
  KPI_WEEK_CHOICES,
  KPI_WEEK_LABELS,
  aggregateOrgs,
  aggregateSeries,
  formatChange,
  formatValue,
  histogram,
  lastChange,
  lastValue,
  orgFlags,
  orgIndexesOf,
  orgReporting,
  orgSeries,
  seriesCsv,
  summaryReporting,
  summarySeries,
  toCsv,
  weekLabel,
  type KpiAgg,
  type KpiCategory,
  type KpiFilters,
  type KpiMetric,
  type KpiOrgData,
  type KpiSummary,
  type KpiWeeks,
  type KpiStopCounts,
  KPI_STOP_REASON_LABELS,
  kpiStateLabel,
} from '@/lib/registry/kpi'
import { BarChart, CohortGrid, HBarList, LineChart, Sparkline } from './kpi-charts'

const PLAN_NAMES: Record<Plan | '', string> = { cosmo_base: 'Cosmo Baseプラン', ohsumi: 'Ohsumiプラン', paid: '有償プラン', internal: 'FSIF', '': '未設定' }
const PLAN_ORDER: (Plan | '')[] = ['ohsumi', 'cosmo_base', 'paid', 'internal', '']
const ATTR_NAMES = { field: '分野', size: '規模', affiliation: '所属', started_year: '設立年' } as const
type AttrKey = keyof typeof ATTR_NAMES
const SUBTABS = [
  { id: 'overall', label: '全体' },
  { id: 'plans', label: 'プラン別' },
  { id: 'orgs', label: '団体別' },
] as const
type SubTab = (typeof SUBTABS)[number]['id']
const CARD_METRICS = ['members', 'active_rate_7d', 'active_rate_30d', 'completion_rate', 'overdue_rate', 'logins_per_member']
const DEFAULT_COLUMNS = ['members', 'active_rate_7d', 'completion_rate', 'overdue_rate']
const inputClass = 'min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs'

/** CSV を保存する(Blob。外には送らない) */
function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function CsvButton({ name, make, label = 'CSV' }: { name: string; make: () => string; label?: string }) {
  return <Button type="button" size="sm" variant="ghost" onClick={() => downloadCsv(name, make())} data-kpi-csv>{label}</Button>
}

function Section({ title, children, right, data }: { title: string; children: React.ReactNode; right?: React.ReactNode; data?: string }) {
  return (
    <section className="min-w-0 rounded-lg border border-border p-3" data-kpi-section={data}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-sm font-medium break-words">{title}</h3>
        {right && <div className="flex flex-wrap items-center gap-1">{right}</div>}
      </div>
      {children}
    </section>
  )
}

function MetricSelect({ value, onChange, label = '指標' }: { value: string; onChange: (id: string) => void; label?: string }) {
  const cats = Object.keys(KPI_CATEGORY_LABELS) as KpiCategory[]
  return (
    <label className="inline-flex min-w-0 items-center gap-1 text-xs">
      <span className="shrink-0">{label}</span>
      <select className={inputClass + ' max-w-[14rem]'} value={value} onChange={(e) => onChange(e.target.value)} data-kpi-metric-select>
        {cats.map((c) => (
          <optgroup key={c} label={KPI_CATEGORY_LABELS[c]}>
            {KPI_METRICS.filter((m) => m.category === c).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

function AggSelect({ value, onChange }: { value: KpiAgg; onChange: (a: KpiAgg) => void }) {
  return (
    <label className="inline-flex min-w-0 items-center gap-1 text-xs">
      <span className="shrink-0">まとめ方</span>
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value as KpiAgg)} data-kpi-agg>
        {(Object.keys(KPI_AGG_LABELS) as KpiAgg[]).map((a) => <option key={a} value={a}>{KPI_AGG_LABELS[a]}</option>)}
      </select>
    </label>
  )
}

function Filters({ filters, options, onChange }: { filters: KpiFilters; options: KpiSummary['options'] | null; onChange: (f: KpiFilters) => void }) {
  const set = <K extends keyof KpiFilters>(k: K, v: KpiFilters[K]) => onChange({ ...filters, [k]: v })
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-2" data-kpi-filters>
      <label className="inline-flex items-center gap-1 text-xs">
        期間
        <select className={inputClass} value={filters.weeks} onChange={(e) => set('weeks', Number(e.target.value) as KpiWeeks)} data-kpi-weeks>
          {KPI_WEEK_CHOICES.map((w) => <option key={w} value={w}>{KPI_WEEK_LABELS[w]}</option>)}
        </select>
      </label>
      <label className="inline-flex items-center gap-1 text-xs">
        プラン
        <select className={inputClass} value={filters.plan} onChange={(e) => set('plan', e.target.value as KpiFilters['plan'])}>
          <option value="">すべて</option>
          {PLAN_ORDER.filter((p) => p).map((p) => <option key={p} value={p}>{PLAN_NAMES[p]}</option>)}
          <option value="none">未設定</option>
        </select>
      </label>
      {(['field', 'size', 'affiliation'] as const).map((k) => (
        <label key={k} className="inline-flex min-w-0 items-center gap-1 text-xs">
          {ATTR_NAMES[k]}
          <select className={inputClass + ' max-w-[10rem]'} value={filters[k]} onChange={(e) => set(k, e.target.value)}>
            <option value="">すべて</option>
            {(options?.[k] ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
            {filters[k] && !(options?.[k] ?? []).includes(filters[k]) && <option value={filters[k]}>{filters[k]}</option>}
          </select>
        </label>
      ))}
      <label className="inline-flex items-center gap-1 text-xs">
        <input type="checkbox" checked={filters.includeInternal} onChange={(e) => set('includeInternal', e.target.checked)} data-kpi-internal />
        FSIF の団体を含める
      </label>
      <span className="text-xs text-muted-foreground">デモの団体と、デモの時に受け取った集計値は、いつも外します。</span>
    </div>
  )
}

type Loaded<T> = { key: string; data: T } | null

export function KpiTab({ session, onAuthError }: { session: AdminSession; onAuthError: (message?: string) => void }) {
  const [filters, setFilters] = useState<KpiFilters>(DEFAULT_KPI_FILTERS)
  const [tab, setTab] = useState<SubTab>('overall')
  const [summary, setSummary] = useState<Loaded<KpiSummary>>(null)
  const [orgData, setOrgData] = useState<Loaded<KpiOrgData>>(null)
  const [busy, setBusy] = useState<{ summary: boolean; orgs: boolean }>({ summary: false, orgs: false })
  const [error, setError] = useState<string | null>(null)
  // 読めなかった時の絞り込み(同じ絞り込みでは自動で読み直さない。「読み直す」で読む)
  const [failed, setFailed] = useState<{ summary?: string; orgs?: string }>({})
  const [agg, setAgg] = useState<KpiAgg>('sum')
  const key = JSON.stringify(filters)

  const fail = useCallback((e: unknown) => {
    if (e instanceof RegistryError && e.authError) onAuthError(e.message)
    else setError(e instanceof Error ? e.message : String(e))
  }, [onAuthError])

  const loadSummary = useCallback(async (f: KpiFilters, k: string) => {
    setBusy((b) => ({ ...b, summary: true }))
    setError(null)
    try {
      setSummary({ key: k, data: await getKpiSummary(session, f) })
    } catch (e) {
      setFailed((x) => ({ ...x, summary: k }))
      fail(e)
    } finally {
      setBusy((b) => ({ ...b, summary: false }))
    }
  }, [session, fail])

  const loadOrgs = useCallback(async (f: KpiFilters, k: string) => {
    setBusy((b) => ({ ...b, orgs: true }))
    setError(null)
    try {
      setOrgData({ key: k, data: await getKpiOrgs(session, f) })
    } catch (e) {
      setFailed((x) => ({ ...x, orgs: k }))
      fail(e)
    } finally {
      setBusy((b) => ({ ...b, orgs: false }))
    }
  }, [session, fail])

  // 選んでいるタブに要るものだけを読む(読んだ時の絞り込みと同じなら、読み直さない)
  const needSummary = tab === 'overall'
  const needOrgs = tab !== 'overall' || agg !== 'sum'
  useEffect(() => {
    if (needSummary && summary?.key !== key && !busy.summary && failed.summary !== key) void loadSummary(filters, key)
    if (needOrgs && orgData?.key !== key && !busy.orgs && failed.orgs !== key) void loadOrgs(filters, key)
  }, [needSummary, needOrgs, key, filters, summary, orgData, busy, failed, loadSummary, loadOrgs])

  const reload = () => {
    setFailed({})
    // 今のタブの分を読み直し、ほかのタブの分は次に選んだ時に読む
    if (needSummary) void loadSummary(filters, key)
    else setSummary(null)
    if (needOrgs) void loadOrgs(filters, key)
    else setOrgData(null)
  }

  const options = summary?.data.options ?? orgData?.data.options ?? null
  const s = summary?.key === key ? summary.data : null
  const d = orgData?.key === key ? orgData.data : null
  const loading = (needSummary && !s) || (needOrgs && !d)

  return (
    <div className="min-w-0 space-y-3" data-kpi-tab>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5" role="tablist" aria-label="KPI の見方">
          {SUBTABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-kpi-subtab={t.id} onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1 text-xs ${tab === t.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={reload} disabled={busy.summary || busy.orgs} data-kpi-reload>
          {busy.summary || busy.orgs ? '読み込み中…' : '読み直す'}
        </Button>
        {(s ?? d) && <span className="text-xs text-muted-foreground">読んだ時刻: {new Date((s ?? d)!.generatedAt).toLocaleString('ja-JP')}</span>}
      </div>
      <Filters filters={filters} options={options} onChange={setFilters} />
      {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground" data-kpi-loading>読み込み中…</p>
      ) : tab === 'overall' && s ? (
        <Overall s={s} d={d} agg={agg} setAgg={setAgg} />
      ) : tab === 'plans' && d ? (
        <ByPlan d={d} agg={agg} setAgg={setAgg} />
      ) : tab === 'orgs' && d ? (
        <ByOrg d={d} />
      ) : null}
    </div>
  )
}

// ---- 全体 ----

function Overall({ s, d, agg, setAgg }: { s: KpiSummary; d: KpiOrgData | null; agg: KpiAgg; setAgg: (a: KpiAgg) => void }) {
  const [metricId, setMetricId] = useState('active_rate_7d')
  const [cohortKind, setCohortKind] = useState<'reported' | 'active'>('reported')
  const metric = KPI_METRIC_BY_ID[metricId]
  const allIdx = useMemo(() => (d ? orgIndexesOf(d) : []), [d])
  // 平均・中央値は団体別のデータから(読み終わるまでは合計で出す)
  const useOrgs = agg !== 'sum' && !!d
  const seriesOf = (m: KpiMetric) => (useOrgs ? aggregateSeries(d!, allIdx, m, agg) : summarySeries(s, m))
  const trend = seriesOf(metric)
  const reporting = s.weeks.map((_, w) => summaryReporting(s, metric, w))
  const o = s.orgs
  const months = Array.from(new Set([...Object.keys(o.newByMonth), ...Object.keys(o.endedByMonth)])).sort()
  return (
    <div className="space-y-3" data-kpi-overall>
      <div className="flex flex-wrap items-center gap-2">
        <AggSelect value={agg} onChange={setAgg} />
        {agg !== 'sum' && !d && <span className="text-xs text-muted-foreground">団体ごとの値を読んでいます…</span>}
      </div>

      <Section title="団体" data="orgs">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-kpi-cards>
          <Card label="登録の累計" value={formatValue(o.total, 'count')} />
          <Card label="利用中" value={formatValue(o.active, 'count')} sub="有効・停止予定(まだ使える)の団体" />
          <Card label="機能停止中" value={formatValue(o.restricted.total, 'count')} sub={stopBreakdown(o.restricted)} />
          <Card label="提供停止中" value={formatValue(o.suspended.total, 'count')} sub={stopBreakdown(o.suspended)} />
        </dl>
        <p className="mt-1 text-xs text-muted-foreground">利用中・機能停止中・提供停止中は重なりません(3つの合計が登録の累計です)。</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Card label="契約" value={`契約中 ${o.byContract.active ?? 0}`} sub={`終了予定 ${o.byContract.ending ?? 0}・終了 ${o.byContract.ended ?? 0}・未設定 ${o.byContract[''] ?? 0}`} />
        </dl>
        <p className="mt-2 text-xs break-words text-muted-foreground">プラン別: {PLAN_ORDER.map((p) => `${PLAN_NAMES[p]} ${o.byPlan[p] ?? 0}`).join('・')}</p>
      </Section>

      <Section title="主な数字(一番新しい週・前の週との差)" data="cards">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CARD_METRICS.map((id) => {
            const m = KPI_METRIC_BY_ID[id]
            const { value, change } = lastChange(seriesOf(m))
            return <Card key={id} label={m.label} value={formatValue(value, m.unit)} sub={`前の週との差 ${formatChange(change, m.unit)}`} />
          })}
          <Card label="その週に送ってきた団体" value={formatValue(s.groups.all.count[s.groups.all.count.length - 1], 'count')}
            sub={`前の週 ${formatValue(s.groups.all.count[s.groups.all.count.length - 2] ?? null, 'count')}`} />
        </dl>
      </Section>

      <Section title={`推移: ${metric.label}`} data="trend"
        right={<>
          <MetricSelect value={metricId} onChange={setMetricId} />
          <CsvButton name={`kpi-trend-${metric.id}.csv`} make={() => seriesCsv(s.weeks, [{ name: metric.label, values: trend }], reporting)} />
        </>}>
        <p className="mb-1 text-xs break-words text-muted-foreground">{metric.description}。{KPI_AGG_LABELS[useOrgs ? agg : 'sum']}。</p>
        <LineChart weeks={s.weeks} series={[{ name: metric.label, values: trend }]} unit={metric.unit} label={`${metric.label}の推移`} />
        <p className="mt-2 text-xs text-muted-foreground">その週に送ってきた団体の数(率は、送ってきた団体だけで計算します)</p>
        <BarChart labels={s.weeks.map(weekLabel)} values={reporting} label="その週に送ってきた団体の数" titles={s.weeks} height={90} />
      </Section>

      <Section title="登録した週ごとの続き具合" data="cohort"
        right={<>
          <select className={inputClass} value={cohortKind} onChange={(e) => setCohortKind(e.target.value as 'reported' | 'active')} aria-label="数えるもの">
            <option value="reported">集計値が届いている団体</option>
            <option value="active">アクティブがいる団体</option>
          </select>
          <CsvButton name={`kpi-cohort-${cohortKind}.csv`} make={() => toCsv([
            ['登録した週', '団体', ...Array.from({ length: s.cohort.maxOffset + 1 }, (_, i) => `${i}週目`)],
            ...s.cohort.rows.map((r) => [r.week, r.size, ...r[cohortKind]]),
          ])} />
        </>}>
        <p className="mb-1 text-xs text-muted-foreground">登録後 N 週目に{cohortKind === 'reported' ? '集計値が届いている' : '7日のアクティブが1人以上いる'}団体の割合(期間の中に登録した団体)。</p>
        <CohortGrid rows={s.cohort.rows.map((r) => ({ week: r.week, size: r.size, counts: r[cohortKind] }))} maxOffset={s.cohort.maxOffset} label="登録した週ごとの続き具合" />
      </Section>

      <Section title="分布(団体ごとの、期間の中で一番新しい週の値)" data="dist">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Dist title="メンバー数" values={s.dist.members} edges={[0, 5, 10, 20, 30, 50, 100]} unit="count" />
          <Dist title="アクティブ率(7日)" values={s.dist.activeRate7d} edges={[0, 0.2, 0.4, 0.6, 0.8]} unit="percent" />
          <Dist title="期限切れの率" values={s.dist.overdueRate} edges={[0, 0.1, 0.2, 0.3, 0.5]} unit="percent" />
          <Dist title="登録からの日数" values={s.dist.ageDays} edges={[0, 30, 90, 180, 365, 730]} unit="count" suffix="日" />
        </div>
      </Section>

      <Section title="新規の登録・契約の終了" data="flow"
        right={<CsvButton name="kpi-orgs-flow.csv" make={() => toCsv([['週', '新規の登録', '契約の終了'], ...s.weeks.map((w, i) => [w, o.newByWeek[i], o.endedByWeek[i]])])} />}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">週ごとの新規の登録</p>
            <BarChart labels={s.weeks.map(weekLabel)} values={o.newByWeek} label="週ごとの新規の登録" titles={s.weeks} height={100} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">週ごとの契約の終了</p>
            <BarChart labels={s.weeks.map(weekLabel)} values={o.endedByWeek} label="週ごとの契約の終了" titles={s.weeks} height={100} />
          </div>
        </div>
        {months.length > 0 && (
          <div className="mt-2 max-w-full overflow-x-auto">
            <table className="text-xs" data-kpi-months>
              <thead><tr><th className="pr-3 text-left font-normal text-muted-foreground">月</th><th className="pr-3 font-normal text-muted-foreground">新規</th><th className="font-normal text-muted-foreground">契約の終了</th></tr></thead>
              <tbody>{months.map((mo) => <tr key={mo}><td className="pr-3">{mo}</td><td className="pr-3 text-right tabular-nums">{o.newByMonth[mo] ?? 0}</td><td className="text-right tabular-nums">{o.endedByMonth[mo] ?? 0}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="属性別の団体の数" data="attrs">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {(Object.keys(ATTR_NAMES) as AttrKey[]).map((kk) => (
            <div key={kk} className="min-w-0">
              <p className="mb-1 text-xs font-medium">{ATTR_NAMES[kk]}</p>
              <HBarList items={Object.entries(o.byAttr[kk] ?? {}).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))} label={`${ATTR_NAMES[kk]}別の団体の数`} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="運用" data="ops">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Card label="GAS の更新が要る" value={formatValue(s.ops.updateRequired, 'count')} sub={`古い(任意) ${s.ops.outdated}`} />
          <Card label="24時間以上確認が無い" value={formatValue(s.ops.noCheck, 'count')} />
          <Card label="毎日の処理が止まっている" value={formatValue(s.ops.dailyStale, 'count')} />
          <Card label="メールの上限" value={`達した ${s.ops.mailReached}`} sub={`残りが少ない ${s.ops.mailLow}`} />
          <Card label="機能を止めている団体" value={formatValue(s.ops.featuresDisabled, 'count')} />
          <Card label="上限を変えている団体" value={formatValue(s.ops.tunablesChanged, 'count')} />
          <Card label="診断情報" value={formatValue(s.ops.diagnosticsInPeriod, 'count')} sub={`期間の中・累計 ${s.ops.diagnostics}`} />
        </dl>
        <p className="mt-3 mb-1 text-xs font-medium">GAS の版の分布</p>
        <HBarList items={Object.entries(s.ops.versions).sort((a, b) => b[0].localeCompare(a[0])).map(([label, value]) => ({ label, value }))} label="GAS の版の分布" />
      </Section>

      <Section title="FSIF の運営(期間の中・団体の絞り込みは使いません)" data="fsif">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Card label="アンケートを送った数" value={formatValue(s.fsif.surveys.sent, 'count')}
            sub={`回答 ${s.fsif.surveys.answered}・回答待ち ${s.fsif.surveys.open}・期限切れ ${s.fsif.surveys.overdue}・取り消し ${s.fsif.surveys.cancelled}`} />
          <Card label="アンケートの回答率" value={formatValue(s.fsif.surveys.sent - s.fsif.surveys.cancelled > 0 ? s.fsif.surveys.answered / (s.fsif.surveys.sent - s.fsif.surveys.cancelled) : null, 'percent')}
            sub={`回答までの日数 中央値 ${formatValue(s.fsif.surveys.daysToAnswer.median, 'days')}`} />
          <Card label="未回答で機能停止を入れた数" value={formatValue(s.fsif.surveys.restricted, 'count')} />
          <Card label="登録コードを発行した数" value={formatValue(s.fsif.codes.issued, 'count')}
            sub={`使用 ${s.fsif.codes.used}・未使用 ${s.fsif.codes.unused}・期限切れ ${s.fsif.codes.expired}・取り消し ${s.fsif.codes.revoked}`} />
          <Card label="登録コードが使われた率" value={formatValue(s.fsif.codes.issued ? s.fsif.codes.used / s.fsif.codes.issued : null, 'percent')}
            sub={`使われるまでの日数 中央値 ${formatValue(s.fsif.codes.daysToUse.median, 'days')}`} />
          <Card label="お知らせを出した数" value={formatValue(s.fsif.announcements.published, 'count')} />
        </dl>
      </Section>

      <Section title="すべての指標(一番新しい週)" data="all-metrics"
        right={<CsvButton name="kpi-all-metrics.csv" make={() => toCsv([['週', '送ってきた団体の数', ...KPI_METRICS.map((m) => m.label)],
          ...s.weeks.map((w, i) => [w, s.groups.all.count[i], ...KPI_METRICS.map((m) => seriesOf(m)[i])])])} label="すべての指標の CSV" />}>
        <MetricTable rows={KPI_METRICS.map((m) => ({ m, series: seriesOf(m) }))} />
      </Section>
    </div>
  )
}

function stopBreakdown(c: KpiStopCounts): string {
  return (['survey', 'contract', 'manual'] as const).map((r) => `${KPI_STOP_REASON_LABELS[r]} ${c[r]}`).join('・')
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/50 px-2 py-1.5" data-kpi-card>
      <dt className="text-xs break-words text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold tabular-nums break-words">{value}</dd>
      {sub && <dd className="text-[11px] break-words text-muted-foreground">{sub}</dd>}
    </div>
  )
}

function Dist({ title, values, edges, unit, suffix = '' }: { title: string; values: number[]; edges: number[]; unit: 'count' | 'percent'; suffix?: string }) {
  const buckets = histogram(values, edges)
  const name = (b: { from: number; to: number | null }) => unit === 'percent'
    ? `${Math.round(b.from * 100)}%${b.to === null ? '〜' : `〜${Math.round(b.to * 100)}%`}`
    : `${b.from}${b.to === null ? `${suffix}〜` : `〜${b.to - 1}${suffix}`}`
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}(団体 {values.length})</p>
        <CsvButton name={`kpi-dist-${title}.csv`} make={() => toCsv([['区切り', '団体の数'], ...buckets.map((b) => [name(b), b.count])])} />
      </div>
      <BarChart labels={buckets.map((b) => name(b).replace(/〜.*/, '〜'))} values={buckets.map((b) => b.count)} titles={buckets.map(name)} label={`${title}の分布`} height={100} />
    </div>
  )
}

function MetricTable({ rows }: { rows: { m: KpiMetric; series: (number | null)[] }[] }) {
  return (
    <div className="max-w-full overflow-x-auto" data-kpi-table-scroll>
      <table className="w-full min-w-[28rem] text-xs" data-kpi-metric-table>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2 font-normal">指標</th>
            <th className="py-1 pr-2 text-right font-normal">一番新しい週</th>
            <th className="py-1 pr-2 text-right font-normal">前の週との差</th>
            <th className="py-1 font-normal">推移</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, series }) => {
            const { value, change } = lastChange(series)
            return (
              <tr key={m.id} className="border-t border-border">
                <td className="py-1 pr-2"><span className="block">{m.label}</span><span className="block text-[11px] text-muted-foreground">{m.description}</span></td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatValue(value, m.unit)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatChange(change, m.unit)}</td>
                <td className="py-1"><Sparkline values={series} label={`${m.label}の推移`} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---- プラン別 ----

function ByPlan({ d, agg, setAgg }: { d: KpiOrgData; agg: KpiAgg; setAgg: (a: KpiAgg) => void }) {
  const [metricId, setMetricId] = useState('active_rate_7d')
  const [attr, setAttr] = useState<AttrKey>('field')
  const metric = KPI_METRIC_BY_ID[metricId]
  const plans = PLAN_ORDER.filter((p) => d.orgs.some((o) => o.plan === p))
  const idxOf = (p: Plan | '') => orgIndexesOf(d, (o) => o.plan === p)
  const series = plans.map((p) => ({ name: PLAN_NAMES[p], values: aggregateSeries(d, idxOf(p), metric, agg) }))
  const lastW = d.weeks.length - 1
  const attrValues = Array.from(new Set(d.orgs.map((o) => o.attrs[attr] || ''))).sort()
  const cell = (p: Plan | '', v: string) => {
    const idx = orgIndexesOf(d, (o) => o.plan === p && (o.attrs[attr] || '') === v)
    return { n: idx.length, value: idx.length ? aggregateOrgs(d, idx, metric, lastW, agg).value : null }
  }
  return (
    <div className="space-y-3" data-kpi-plans>
      <div className="flex flex-wrap items-center gap-2">
        <MetricSelect value={metricId} onChange={setMetricId} />
        <AggSelect value={agg} onChange={setAgg} />
      </div>
      <Section title={`プランごとの推移: ${metric.label}`} data="plan-trend"
        right={<CsvButton name={`kpi-plans-${metric.id}.csv`} make={() => seriesCsv(d.weeks, series)} />}>
        <p className="mb-1 text-xs break-words text-muted-foreground">{metric.description}。{KPI_AGG_LABELS[agg]}。</p>
        {plans.length ? <LineChart weeks={d.weeks} series={series} unit={metric.unit} label={`プランごとの${metric.label}の推移`} /> : <p className="text-xs text-muted-foreground">団体がありません。</p>}
        <div className="mt-2 max-w-full overflow-x-auto" data-kpi-table-scroll>
          <table className="w-full min-w-[24rem] text-xs">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2 font-normal">プラン</th><th className="py-1 pr-2 text-right font-normal whitespace-nowrap">団体</th><th className="py-1 pr-2 text-right font-normal">最新の週に送ってきた団体</th><th className="py-1 pr-2 text-right font-normal">一番新しい値</th><th className="py-1 text-right font-normal">前の週との差</th></tr></thead>
            <tbody>
              {plans.map((p, i) => {
                const idx = idxOf(p)
                const { change } = lastChange(series[i].values)
                return (
                  <tr key={p || 'none'} className="border-t border-border">
                    <td className="py-1 pr-2">{PLAN_NAMES[p]}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{idx.length}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{orgReporting(d, idx, lastW)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatValue(lastValue(series[i].values), metric.unit)}</td>
                    <td className="py-1 text-right tabular-nums">{formatChange(change, metric.unit)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title={`プラン × ${ATTR_NAMES[attr]}(${metric.label}・一番新しい週)`} data="plan-attr"
        right={<>
          <select className={inputClass} value={attr} onChange={(e) => setAttr(e.target.value as AttrKey)} aria-label="属性">
            {(Object.keys(ATTR_NAMES) as AttrKey[]).map((kk) => <option key={kk} value={kk}>{ATTR_NAMES[kk]}</option>)}
          </select>
          <CsvButton name={`kpi-plan-${attr}-${metric.id}.csv`} make={() => toCsv([['プラン', ...attrValues.map((v) => v || '(未設定)')],
            ...plans.map((p) => [PLAN_NAMES[p], ...attrValues.map((v) => { const c = cell(p, v); return c.n ? c.value : null })])])} />
        </>}>
        <div className="max-w-full overflow-x-auto" data-kpi-table-scroll>
          <table className="text-xs" data-kpi-plan-attr>
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-3 font-normal">プラン</th>{attrValues.map((v) => <th key={v} className="py-1 pr-3 font-normal whitespace-nowrap">{v || '(未設定)'}</th>)}</tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p || 'none'} className="border-t border-border">
                  <td className="py-1 pr-3 whitespace-nowrap">{PLAN_NAMES[p]}</td>
                  {attrValues.map((v) => {
                    const c = cell(p, v)
                    return <td key={v} className="py-1 pr-3 tabular-nums whitespace-nowrap">{c.n ? `${formatValue(c.value, metric.unit)}(${c.n})` : ''}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">かっこの中は団体の数です。</p>
      </Section>
    </div>
  )
}

// ---- 団体別 ----

type SortKey = 'name' | 'plan' | 'state' | 'flags' | string
const STATE_ORDER = ['active', 'restricted', 'suspended']

function ByOrg({ d }: { d: KpiOrgData }) {
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS)
  const [choosing, setChoosing] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'flags', desc: true })
  const [trendId, setTrendId] = useState('active_rate_7d')
  const [openOrg, setOpenOrg] = useState<number | null>(null)
  const rows = useMemo(() => d.orgs.map((o, i) => ({
    i, o, flags: orgFlags(d, i),
    last: Object.fromEntries(KPI_METRICS.map((m) => [m.id, lastValue(orgSeries(d, i, m))])) as Record<string, number | null>,
  })), [d])
  const sorted = [...rows].sort((a, b) => {
    const dir = sort.desc ? -1 : 1
    if (sort.key === 'name') return dir * a.o.name.localeCompare(b.o.name, 'ja')
    if (sort.key === 'plan') return dir * PLAN_ORDER.indexOf(a.o.plan).toString().localeCompare(PLAN_ORDER.indexOf(b.o.plan).toString())
    if (sort.key === 'state') return dir * (STATE_ORDER.indexOf(a.o.kpiState) - STATE_ORDER.indexOf(b.o.kpiState)) || a.o.name.localeCompare(b.o.name, 'ja')
    if (sort.key === 'flags') return dir * (a.flags.length - b.flags.length) || a.o.name.localeCompare(b.o.name, 'ja')
    const va = a.last[sort.key]
    const vb = b.last[sort.key]
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    return dir * (va - vb)
  })
  const header = (key: SortKey, label: string, right = false) => (
    <th className={`py-1 pr-2 font-normal ${right ? 'text-right' : 'text-left'}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="whitespace-nowrap underline-offset-2 hover:underline" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : true })}>
        {label}{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  )
  const trend = KPI_METRIC_BY_ID[trendId]
  return (
    <div className="space-y-3" data-kpi-orgs>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setChoosing(!choosing)} aria-expanded={choosing} data-kpi-columns-button>出す列を選ぶ…</Button>
        <MetricSelect value={trendId} onChange={setTrendId} label="小さな推移" />
        <CsvButton name="kpi-orgs.csv" make={() => toCsv([
          ['団体', '団体ID', 'プラン', '状態', '注意の印', ...columns.map((c) => KPI_METRIC_BY_ID[c].label)],
          ...sorted.map((r) => [r.o.name, r.o.orgId, PLAN_NAMES[r.o.plan], kpiStateLabel(r.o), r.flags.map((f) => KPI_FLAG_LABELS[f]).join('・'), ...columns.map((c) => r.last[c])]),
        ])} label="表の CSV" />
      </div>
      {choosing && (
        <fieldset className="grid gap-1 rounded-lg border border-border p-2 text-xs sm:grid-cols-2" data-kpi-columns>
          <legend className="px-1">出す列</legend>
          {KPI_METRICS.map((m) => (
            <label key={m.id} className="flex min-w-0 items-start gap-1.5">
              <input type="checkbox" className="mt-0.5" checked={columns.includes(m.id)}
                onChange={(e) => setColumns((cs) => (e.target.checked ? [...cs, m.id] : cs.filter((c) => c !== m.id)))} />
              <span className="min-w-0 break-words">{m.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="max-w-full overflow-x-auto rounded-lg border border-border" data-kpi-table-scroll>
        <table className="w-full min-w-[32rem] text-xs" data-kpi-org-table>
          <thead>
            <tr className="text-muted-foreground">
              {header('name', '団体')}
              {header('plan', 'プラン')}
              {header('state', '状態')}
              {header('flags', '注意')}
              {columns.map((c) => <th key={c} className="py-1 pr-2 text-right font-normal">
                <button type="button" className="whitespace-nowrap underline-offset-2 hover:underline" onClick={() => setSort({ key: c, desc: sort.key === c ? !sort.desc : true })}>
                  {KPI_METRIC_BY_ID[c].label}{sort.key === c ? (sort.desc ? ' ▼' : ' ▲') : ''}
                </button>
              </th>)}
              <th className="py-1 pr-2 text-left font-normal">{trend.label}の推移</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.o.orgId} className="border-t border-border align-top" data-kpi-org-row={r.o.orgId}>
                <td className="min-w-[9rem] py-1 pr-2">
                  <button type="button" className="text-left break-words text-primary underline-offset-2 hover:underline" onClick={() => setOpenOrg(openOrg === r.i ? null : r.i)} aria-expanded={openOrg === r.i}>
                    {r.o.name || r.o.orgId}
                  </button>
                </td>
                <td className="py-1 pr-2 whitespace-nowrap">{PLAN_NAMES[r.o.plan]}</td>
                <td className="py-1 pr-2 whitespace-nowrap" data-kpi-org-state>{kpiStateLabel(r.o)}</td>
                <td className="py-1 pr-2">
                  {r.flags.length ? (
                    <ul className="space-y-0.5" data-kpi-flags>
                      {r.flags.map((f) => <li key={f} className="flex items-start gap-1 text-[11px] text-warning"><span aria-hidden>⚠</span><span className="min-w-[8rem] break-words">{KPI_FLAG_LABELS[f]}</span></li>)}
                    </ul>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                {columns.map((c) => <td key={c} className="py-1 pr-2 text-right tabular-nums whitespace-nowrap">{formatValue(r.last[c], KPI_METRIC_BY_ID[c].unit)}</td>)}
                <td className="py-1 pr-2"><Sparkline values={orgSeries(d, r.i, trend)} label={`${r.o.name}の${trend.label}の推移`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openOrg !== null && <OrgDetail d={d} index={openOrg} onClose={() => setOpenOrg(null)} />}
    </div>
  )
}

function OrgDetail({ d, index, onClose }: { d: KpiOrgData; index: number; onClose: () => void }) {
  const o = d.orgs[index]
  const [metricId, setMetricId] = useState('members')
  const metric = KPI_METRIC_BY_ID[metricId]
  const all = KPI_METRICS.map((m) => ({ m, series: orgSeries(d, index, m) }))
  return (
    <Section title={`団体の推移: ${o.name || o.orgId}`} data="org-detail"
      right={<>
        <CsvButton name={`kpi-org-${o.orgId}.csv`} make={() => seriesCsv(d.weeks, all.map((a) => ({ name: a.m.label, values: a.series })))} label="この団体の CSV" />
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>閉じる</Button>
      </>}>
      <p className="mb-2 text-xs break-words text-muted-foreground">
        {PLAN_NAMES[o.plan]}・{kpiStateLabel(o)}・GAS {o.gasVersion || '不明'}(配る版 {o.release || '—'})・最後に集計値が届いた週 {o.lastReportWeek || 'なし'}
        {o.attrs.field && `・${o.attrs.field}`}{o.attrs.size && `・${o.attrs.size}`}{o.attrs.affiliation && `・${o.attrs.affiliation}`}
      </p>
      <div className="mb-2"><MetricSelect value={metricId} onChange={setMetricId} /></div>
      <LineChart weeks={d.weeks} series={[{ name: metric.label, values: orgSeries(d, index, metric) }]} unit={metric.unit} label={`${o.name}の${metric.label}の推移`} />
      <div className="mt-3"><MetricTable rows={all} /></div>
    </Section>
  )
}
