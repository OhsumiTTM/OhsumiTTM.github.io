// 利用の集計とエラーの記録(PR K)
//   - ログイン・画面の読み込み・書き込みの操作の、日ごとの回数だけを団体のシート(UsageDaily)に残す。誰の操作かは残さない
//   - GAS と画面のエラーを、日時・操作の名前・エラーの種類だけ、直近 500 件まで ErrorLog に残す(中身・文・個人情報は残さない)
//   - 代表の管理画面で、利用の集計とエラーの件数を見られる
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
let n = 0
const rid = () => 'req-usage-' + ++n
// 日付の書式は、テストの時計(UTC)で本当に作る
function realDates(h: H) {
  const pad = (x: number) => String(x).padStart(2, '0')
  ;(h.c.Utilities as Record<string, unknown>).formatDate = (d: Date, _tz: string, fmt: string) => {
    const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    return fmt === 'yyyy-MM-dd-HH' ? `${s}-${pad(d.getUTCHours())}` : s
  }
  return h
}
const today = () => new Date().toISOString().slice(0, 10)

describe('利用の集計', () => {
  it('成功した書き込みの操作と読み込みを数える。読み取り・送り直し・失敗は数えない。誰の操作かは残さない', () => {
    const h = realDates(guardHarness())
    h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', requestId: 'same-request-1' })
    h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', requestId: 'same-request-1' })
    h.post({ action: 'getInitialData', sessionToken: 'm-base' })
    h.post({ action: 'getOpsStatus', sessionToken: 'm-top' })
    h.post({ action: 'removeMember', sessionToken: 'm-base', memberId: 'm-other', requestId: rid() })
    const st = h.post({ action: 'getUsageStatus', sessionToken: 'm-top' }).result
    expect(st.days.at(-1)).toEqual({ date: today(), login: 0, open: 1, writes: 1 })
    expect(st.topActions).toEqual([{ action: 'updatePriority', count: 1 }])
    expect(JSON.stringify([...h.cache.values()])).not.toContain('m-lead')
  })

  it('毎時の処理で、前の時間の回数をシートに移す(今の時間の分は残す)。シートには日付・種類・回数だけ', () => {
    const h = realDates(guardHarness())
    const hourAgo = Date.now() - 3600 * 1000
    h.cache.set(call(h, 'usageBucketKey_', hourAgo) as string, JSON.stringify({ login: 2, updateComments: 3 }))
    h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', requestId: rid() })
    call(h, 'flushUsage_', Date.now())
    const rows = h.sheets.UsageDaily.rows
    expect(rows[0]).toEqual(['date', 'kind', 'count'])
    const day = new Date(hourAgo).toISOString().slice(0, 10)
    expect(rows.slice(1)).toEqual(expect.arrayContaining([[day, 'login', 2], [day, 'updateComments', 3]]))
    expect(rows.slice(1).some((r) => r[1] === 'updatePriority')).toBe(false)
    // 2回目は前の分を足さない(箱は消した)
    call(h, 'flushUsage_', Date.now())
    expect(h.sheets.UsageDaily.rows.slice(1).filter((r) => r[1] === 'login')).toEqual([[day, 'login', 2]])
    // 管理画面は、シートとまだ移していない今の時間の分を合わせて出す
    const st = h.post({ action: 'getUsageStatus', sessionToken: 'm-top' }).result
    expect(st.topActions).toEqual(expect.arrayContaining([{ action: 'updateComments', count: 3 }, { action: 'updatePriority', count: 1 }]))
  })

  it('代表だけが見られる', () => {
    const h = guardHarness()
    expect(h.post({ action: 'getUsageStatus', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
    expect(CODE_GS.match(/var READ_ONLY_ACTIONS = \[[^\]]*\]/)![0]).toContain("'getUsageStatus'")
  })
})

describe('エラーの記録', () => {
  it('GAS の予期しないエラー・競合・メールの上限を、日時・操作・種類だけ残す(エラーの文は残さない)', () => {
    const h = guardHarness()
    h.c.updateRowFieldsUnmeasured_ = () => { throw new TypeError('秘密の中身 m-base@example.com') }
    const res = h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', requestId: rid() })
    expect(res.ok).toBe(false)
    const rows = h.sheets.ErrorLog.rows
    expect(rows[0]).toEqual(['at', 'source', 'action', 'kind'])
    expect(rows[1].slice(1)).toEqual(['gas', 'updatePriority', 'unexpected:TypeError'])
    expect(JSON.stringify(rows)).not.toContain('秘密')
  })

  it('業務上の断り(権限・入力の誤り)は残さない', () => {
    const h = guardHarness()
    h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 'nope', listOps: [], requestId: rid() })
    expect(h.sheets.ErrorLog).toBeUndefined()
  })

  it('画面のエラーは、種類と操作の名前だけを受け取り、1人1時間の上限まで残す', () => {
    const h = guardHarness()
    expect(h.post({ action: 'reportClientError', sessionToken: 'm-base', kind: 'TypeError', errorAction: 'render' }).result).toEqual({ recorded: true })
    expect(h.post({ action: 'reportClientError', sessionToken: 'm-base', kind: 'メールアドレス a@b.c' }).ok).toBe(false)
    expect(h.sheets.ErrorLog.rows[1].slice(1)).toEqual(['client', 'render', 'TypeError'])
    for (let i = 0; i < 35; i++) h.post({ action: 'reportClientError', sessionToken: 'm-base', kind: 'TypeError' })
    expect(h.sheets.ErrorLog.rows.length - 1).toBe(30)
  })

  it('直近 500 件を超えたら、古い行をまとめて消す', () => {
    const h = guardHarness()
    for (let i = 0; i < 600; i++) call(h, 'appendErrorLog_', 'gas', 'x', 'k' + i)
    const rows = h.sheets.ErrorLog.rows
    expect(rows.length - 1).toBe(500)
    expect(rows.at(-1)![3]).toBe('k599')
  })

  it('管理画面に、直近7日の件数・種類ごとの件数・直近の記録を出す', () => {
    const h = guardHarness()
    call(h, 'appendErrorLog_', 'client', 'render', 'TypeError')
    call(h, 'appendErrorLog_', 'gas', 'updateComments', 'conflict')
    call(h, 'appendErrorLog_', 'gas', 'updateTaskStatus', 'conflict')
    const e = h.post({ action: 'getUsageStatus', sessionToken: 'm-top' }).result.errors
    expect(e.last7Days).toBe(3)
    expect(e.byKind).toEqual([{ kind: 'conflict', count: 2 }, { kind: 'TypeError', count: 1 }])
    expect(e.recent[0]).toMatchObject({ source: 'gas', action: 'updateTaskStatus', kind: 'conflict' })
  })
})

describe('守る処理を外すと失敗する', () => {
  it('種類の確かめを外すと、画面から送られた文(個人情報を含みうる)を残してしまう', () => {
    const code = CODE_GS.replace("if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(kind)) throw userError_('エラーの種類の形式が不正です。')", '')
      .replace("var safeKind = String(kind || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || 'unknown'", 'var safeKind = String(kind)')
    expect(code).not.toBe(CODE_GS)
    const h = guardHarness({ code })
    h.post({ action: 'reportClientError', sessionToken: 'm-base', kind: 'メールアドレス a@b.c' })
    expect(JSON.stringify(h.sheets.ErrorLog.rows)).toContain('a@b.c')
  })
})
