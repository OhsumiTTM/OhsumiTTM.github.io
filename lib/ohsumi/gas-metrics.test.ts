// 定量データ(PR N): 団体の GAS が、個人を特定しない集計値を週1回レジストリに送る
//   - プランで送るかを決める(Ohsumiプランは必須・Cosmo Baseプランは初期値で送る・有償プランと未設定は初期値で送らない)
//   - 送る曜日と時刻は団体ID から決める。失敗したら時間を置いて送り直す
//   - 代表は管理画面で、次に送る内容(プレビュー)と送信の履歴を見る。メンバーにも送っていることが分かる(Settings)
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const KEY = 'shared-key-for-test'
const URL = 'https://script.google.com/macros/s/REGISTRY/exec'
const HOUR = 3600 * 1000

// 日付の書式を UTC で本当に作る(u: 曜日 1=月〜7=日、H: 時、m: 分)
function realDates(h: H) {
  const pad = (x: number) => String(x).padStart(2, '0')
  ;(h.c.Utilities as Record<string, unknown>).formatDate = (d: Date, _tz: string, fmt: string) => {
    if (fmt === 'u') return String(d.getUTCDay() === 0 ? 7 : d.getUTCDay())
    if (fmt === 'H') return String(d.getUTCHours())
    if (fmt === 'm') return String(d.getUTCMinutes())
    const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    return fmt === 'yyyy-MM-dd-HH' ? `${s}-${pad(d.getUTCHours())}` : s
  }
  return h
}
function org(plan: string, extra: Record<string, string> = {}) {
  const h = realDates(guardHarness({ props: { REGISTRY_URL: URL, REGISTRY_SHARED_KEY: KEY, CONTRACT_STATE: JSON.stringify({ phase: 'none', plan }), ...extra } }))
  return h
}
// 送り先の偽物。ok を順に返し、届いた本文を覚える
function registry(answers: boolean[]) {
  const sent: Record<string, unknown>[] = []
  const fetch = (_u: string, o: { payload: string }) => {
    sent.push(JSON.parse(o.payload))
    const ok = answers.length ? answers.shift()! : true
    return { getContentText: () => JSON.stringify(ok ? { ok: true, result: { stored: 'new' } } : { ok: false, error: '混み合っています' }) }
  }
  return { sent, fetch }
}

describe('送るかの決まり(プラン)', () => {
  it('Ohsumiプランは必須、Cosmo Baseプランは初期値で送る、有償プラン・未設定は初期値で送らない', () => {
    expect(plain(call(org('ohsumi'), 'metricsSharing_'))).toMatchObject({ mandatory: true, enabled: true })
    expect(plain(call(org('cosmo_base'), 'metricsSharing_'))).toMatchObject({ mandatory: false, enabled: true })
    expect(plain(call(org('paid'), 'metricsSharing_'))).toMatchObject({ mandatory: false, enabled: false })
    expect(plain(call(org(''), 'metricsSharing_'))).toMatchObject({ enabled: false })
  })

  it('代表は選べる(Ohsumiプランでは止められない)。メンバーにも分かるよう Settings に書く', () => {
    const paid = org('paid')
    expect(paid.post({ action: 'setMetricsSharing', sessionToken: 'm-top', enabled: true, requestId: 'metrics-on-1' }).result.enabled).toBe(true)
    expect(JSON.stringify(paid.sheets.Settings.rows)).toContain('"metrics_sharing_notice","on"')
    expect(paid.post({ action: 'setMetricsSharing', sessionToken: 'm-lead', enabled: false, requestId: 'metrics-off-1' })).toMatchObject({ ok: false, forbidden: true })
    const ohsumi = org('ohsumi')
    expect(ohsumi.post({ action: 'setMetricsSharing', sessionToken: 'm-top', enabled: false, requestId: 'metrics-off-2' }).error).toContain('必須')
  })
})

describe('週1回の送信', () => {
  it('団体ごとの曜日・時刻を過ぎたら送り、同じ週は2回送らない。署名はレジストリと同じ決まり', () => {
    const h = org('ohsumi')
    const slot = plain(call(h, 'metricsSlot_', 'org_GUARDGUARDGUARDGU01')) as { dow: number; hour: number }
    const week = plain(call(h, 'metricsWeek_', Date.now(), slot)) as { period: string; slotAt: number }
    const r = registry([true])
    expect(call(h, 'maybeSendMetrics_', week.slotAt - HOUR, { fetch: r.fetch })).toBe('notYet')
    expect(call(h, 'maybeSendMetrics_', week.slotAt + 60000, { fetch: r.fetch })).toBe('sent')
    expect(call(h, 'maybeSendMetrics_', week.slotAt + 2 * HOUR, { fetch: r.fetch })).toBe('alreadySent')
    expect(r.sent).toHaveLength(1)
    const body = r.sent[0] as { orgId: string; ts: number; period: string; metrics: Record<string, number>; sig: string }
    expect(body.period).toBe(week.period)
    const sig = createHmac('sha256', KEY).update('metrics.' + body.orgId + '.' + body.ts + '.' + body.period + '.' + JSON.stringify(body.metrics)).digest('base64url')
    expect(body.sig).toBe(sig)
  })

  it('送る曜日・時刻は団体ごとに違う', () => {
    const h = org('ohsumi')
    const slots = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(plain(call(h, 'metricsSlot_', 'org_' + i)))))
    expect(slots.size).toBeGreaterThan(15)
  })

  it('失敗したら時間を置いて送り直す(1時間・2時間…)。履歴に残す', () => {
    const h = org('cosmo_base')
    const week = plain(call(h, 'metricsWeek_', Date.now(), plain(call(h, 'metricsSlot_', 'org_GUARDGUARDGUARDGU01')))) as { slotAt: number }
    const r = registry([false, false, true])
    const t0 = week.slotAt + 60000
    expect(call(h, 'maybeSendMetrics_', t0, { fetch: r.fetch })).toBe('failed')
    expect(call(h, 'maybeSendMetrics_', t0 + 30 * 60000, { fetch: r.fetch })).toBe('waitingRetry')
    expect(call(h, 'maybeSendMetrics_', t0 + HOUR, { fetch: r.fetch })).toBe('failed')
    expect(call(h, 'maybeSendMetrics_', t0 + 2 * HOUR, { fetch: r.fetch })).toBe('waitingRetry')
    expect(call(h, 'maybeSendMetrics_', t0 + 3 * HOUR, { fetch: r.fetch })).toBe('sent')
    const st = plain(call(h, 'readMetricsState_')) as { history: { ok: boolean; attempt: number }[] }
    expect(st.history.map((x) => [x.ok, x.attempt])).toEqual([[true, 3], [false, 2], [false, 1]])
  })

  it('送らない設定の時は送らない', () => {
    const h = org('paid')
    const r = registry([true])
    expect(call(h, 'maybeSendMetrics_', Date.now() + 8 * 24 * HOUR, { fetch: r.fetch })).toBe('disabled')
    expect(r.sent).toHaveLength(0)
  })
})

describe('代表の管理画面', () => {
  it('次に送る内容(個人を特定しない数だけ)・次に送る時刻・履歴を見られる。代表だけ', () => {
    const h = org('ohsumi')
    const res = h.post({ action: 'getMetricsStatus', sessionToken: 'm-top' })
    expect(res.ok, res.error).toBe(true)
    expect(res.result).toMatchObject({ plan: 'ohsumi', mandatory: true, enabled: true, definitionsVersion: 2 })
    expect(res.result.preview).toMatchObject({ version: 2, members: 5, tasks: 3, projects: 1 })
    expect(Object.values(res.result.preview).every((v) => typeof v === 'number')).toBe(true)
    expect(JSON.stringify(res.result.preview)).not.toMatch(/@|代表|タスク1/)
    expect(res.result.nextAt).toMatch(/^\d{4}-/)
    expect(h.post({ action: 'getMetricsStatus', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
  })
})

describe('版 2 の指標(PR Y)', () => {
  it('コメント・確認の承認・期限超過の日数・ポイント・日報・1on1・申請・差し戻し・ログイン済みの人数を、個人を特定しない数で数える', () => {
    const h = org('ohsumi')
    const now = Date.now()
    const ago = (days: number) => new Date(now - days * 86400000).toISOString()
    const day = (days: number) => ago(days).slice(0, 10)
    const set = (sheet: string, rowIndex: number, fields: Record<string, unknown>) => {
      const rows = h.sheets[sheet].rows
      for (const [k, v] of Object.entries(fields)) {
        let col = (rows[0] as string[]).indexOf(k)
        if (col < 0) { (rows[0] as string[]).push(k); col = rows[0].length - 1 }
        while (rows[rowIndex].length <= col) rows[rowIndex].push('')
        rows[rowIndex][col] = v as never
      }
    }
    // タスク: コメント(直近2件・古い1件)・確認の承認(直近1件)・期限を10日と4日過ぎた未完了のタスク
    set('Tasks', 1, { comments_json: JSON.stringify([{ id: 'c1', at: ago(1) }, { id: 'c2', at: ago(2) }, { id: 'c3', at: ago(20) }]), review_approvals_json: JSON.stringify([{ memberId: 'm1', at: ago(1) }]), status: 'todo', due_date: day(10) })
    set('Tasks', 2, { status: 'todo', due_date: day(4) })
    // メンバー: ポイント(120 + 30)・1on1(両方の記録に入った同じ ID は1回)
    set('Members', 1, { skill_points_json: JSON.stringify({ デザイン: 120 }), one_on_ones_json: JSON.stringify([{ id: 'o1', date: day(3) }, { id: 'o0', date: day(90) }]), last_login: ago(1) })
    set('Members', 2, { skill_points_json: JSON.stringify({ 企画: 30, 壊れた値: 'x' }), one_on_ones_json: JSON.stringify([{ id: 'o1', date: day(3) }]) })
    h.addSheet('DailyReports', [['id', 'member_id', 'type', 'report_date', 'done_text', 'todo_text', 'issues_text', 'created_at'], ['d1', 'm1', 'daily', day(1), '', '', '', ago(1)], ['d2', 'm1', 'daily', day(9), '', '', '', ago(9)]])
    h.addSheet('Expenses', [['id', 'status', 'created_at'], ['e1', 'pending', ago(1)], ['e2', 'rejected', ago(10)], ['e3', 'rejected', ago(40)]])
    h.addSheet('FormSubmissions', [['id', 'status', 'created_at'], ['f1', 'rejected', ago(2)]])
    h.cache.clear()
    const m = plain(call(h, 'metricsSnapshot_', now)) as Record<string, number>
    expect(m).toMatchObject({
      version: 2, comments_7d: 2, reviews_approved_7d: 1, tasks_overdue_days_avg: 7, skill_points_total: 150, daily_reports_7d: 1,
      one_on_ones_30d: 1, expenses_7d: 1, form_submissions_7d: 1, applications_rejected_30d: 2,
    })
    expect(m.members_logged_in).toBeGreaterThanOrEqual(1)
    expect(m.members_logged_in).toBeLessThanOrEqual(m.members)
    expect(Object.values(m).every((v) => Number.isInteger(v) && v >= 0)).toBe(true)
  })

  it('送る指標は、すべてレジストリが受け付ける(知らない項目として捨てられない)。画面の表示名もある', () => {
    const reg = readFileSync(join(__dirname, '..', '..', 'registry', 'Code.gs'), 'utf8')
    const keys = [...(/var METRIC_KEYS = \[([\s\S]*?)\]/.exec(reg)![1].matchAll(/'(\w+)'/g))].map((x) => x[1])
    const ja = readFileSync(join(__dirname, 'i18n', 'ja.ts'), 'utf8')
    const m = plain(call(org('ohsumi'), 'metricsSnapshot_', Date.now())) as Record<string, number>
    for (const k of Object.keys(m).filter((k) => k !== 'version')) {
      expect(keys, k).toContain(k)
      expect(ja, k).toContain(`'metrics.key.${k}'`)
    }
    expect(keys.length).toBe(Object.keys(m).length - 1)
  })
})

describe('守る処理を外すと失敗する', () => {
  it('Ohsumiプランの必須を外すと、代表が送信を止められてしまう', () => {
    const code = CODE_GS.replace("if (sharing.mandatory && !enabled) throw userError_('Ohsumiプランでは、集計値の送信は必須のため止められません。')", '')
    expect(code).not.toBe(CODE_GS)
    const h = realDates(guardHarness({ code, props: { CONTRACT_STATE: JSON.stringify({ plan: 'ohsumi' }) } }))
    expect(h.post({ action: 'setMetricsSharing', sessionToken: 'm-top', enabled: false, requestId: 'metrics-off-3' }).ok).toBe(true)
  })
})
