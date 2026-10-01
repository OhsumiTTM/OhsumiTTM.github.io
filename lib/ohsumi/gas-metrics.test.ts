// 定量データ(PR N): 団体の GAS が、個人を特定しない集計値を週1回レジストリに送る
//   - プランで送るかを決める(Ohsumiプランは必須・Cosmo Baseプランは初期値で送る・有償プランと未設定は初期値で送らない)
//   - 送る曜日と時刻は団体ID から決める。失敗したら時間を置いて送り直す
//   - 代表は管理画面で、次に送る内容(プレビュー)と送信の履歴を見る。メンバーにも送っていることが分かる(Settings)
import { createHmac } from 'node:crypto'
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
    expect(res.result).toMatchObject({ plan: 'ohsumi', mandatory: true, enabled: true, definitionsVersion: 1 })
    expect(res.result.preview).toMatchObject({ version: 1, members: 5, tasks: 3, projects: 1 })
    expect(Object.values(res.result.preview).every((v) => typeof v === 'number')).toBe(true)
    expect(JSON.stringify(res.result.preview)).not.toMatch(/@|代表|タスク1/)
    expect(res.result.nextAt).toMatch(/^\d{4}-/)
    expect(h.post({ action: 'getMetricsStatus', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
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
