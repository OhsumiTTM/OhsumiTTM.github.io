// 診断情報(PR Q): 団体の代表が管理画面で確かめてから、レジストリへ送って受付番号をもらう。
// 個人情報(名前・メールアドレス・メンバーID・タスクの内容・エラーの文)を含まないこと
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness } from './gas-guard-harness'
import { org, registry } from './gas-org-harness'

const MEMBERS = [['id', 'name', 'role'], ['m1', '代表 太郎', 'top'], ['m2', '一般 花子', 'base']]
const EMAILS = { 'top@example.com': 'm1', 'base@example.com': 'm2' }

function pair() {
  const reg = registry()
  const o = org(reg, { members: MEMBERS.map((r) => r.slice()), emails: EMAILS })
  o.register(reg.issue().code)
  const g = o.gas as unknown as Record<string, (...a: unknown[]) => unknown>
  return { reg, o, g }
}

type Preview = { diagId: string; diagnostics: Record<string, unknown>; history: unknown[] }

describe('診断情報(団体の GAS)', () => {
  it('版・設定・上限・エラーの件数を出し、個人の情報は入れない', () => {
    const p = pair()
    // メールアドレスを含むエラーの文が、毎日の処理の記録にあっても入れない
    p.o.props.JOB_STATE = JSON.stringify({ dailyAt: '2026-09-30T00:00:00.000Z', dailyError: 'failed for top@example.com', dailyFailedAt: '2026-09-30T01:00:00.000Z' })
    const preview = p.g.diagnosticsPreview_(Date.now()) as Preview
    expect(preview.diagId).toMatch(/^dg_[A-Za-z0-9]{8,}$/)
    const d = preview.diagnostics
    expect(d).toMatchObject({ version: CODE_GS.match(/^var OHSUMI_GAS_VERSION = '([^']+)'$/m)![1], registry: { registered: true } })
    expect(Object.keys(d).sort()).toEqual(['backup', 'errors', 'gasUpdate', 'generatedAt', 'jobs', 'limits', 'registry', 'settings', 'sharing', 'timeZone', 'version'])
    const text = JSON.stringify(d)
    for (const secret of ['top@example.com', 'base@example.com', '代表 太郎', '一般 花子', 'm1', p.o.props.REGISTRY_SHARED_KEY, p.o.props.ORG_ID]) expect(text).not.toContain(secret)
  })

  it('見せたものを送って受付番号をもらい、履歴に残す。同じものの送り直しは同じ受付番号', () => {
    const p = pair()
    const preview = p.g.diagnosticsPreview_(Date.now()) as Preview
    const sent = p.g.sendDiagnostics_(preview.diagId, Date.now()) as { receiptNo: string; history: { receiptNo: string }[] }
    expect(sent.receiptNo).toMatch(/^D\d{6}-[A-Z0-9]{4}$/)
    expect(sent.history.map((h) => h.receiptNo)).toEqual([sent.receiptNo])
    const again = p.g.sendDiagnostics_(preview.diagId, Date.now()) as { receiptNo: string; history: unknown[] }
    expect(again.receiptNo).toBe(sent.receiptNo)
    expect(again.history).toHaveLength(1)
    // レジストリの管理画面で、受付番号から中身を見られる
    const report = p.reg.post({ action: 'getDiagnosticsReport', session: p.reg.session, receiptNo: sent.receiptNo.toLowerCase() })
    expect(report.ok, JSON.stringify(report)).toBe(true)
    expect(report.result.diagnostics).toEqual(preview.diagnostics)
    expect(p.reg.post({ action: 'adminOverview', session: p.reg.session }).result.diagnostics[0]).toMatchObject({ receiptNo: sent.receiptNo, orgName: '新しい団体' })
  })

  it('表示していない・10分を過ぎたものは送らない。レジストリに登録していない団体は送れない', () => {
    const p = pair()
    expect(() => p.g.sendDiagnostics_('dg_unknown12345', Date.now())).toThrow('もう一度表示')
    expect(() => p.g.sendDiagnostics_('bad', Date.now())).toThrow('もう一度表示')
    const reg = registry()
    const o = org(reg)
    const g = o.gas as unknown as Record<string, (...a: unknown[]) => unknown>
    const preview = g.diagnosticsPreview_(Date.now()) as Preview
    expect((preview.diagnostics.registry as { registered: boolean }).registered).toBe(false)
    expect(() => g.sendDiagnostics_(preview.diagId, Date.now())).toThrow('レジストリに登録していない')
  })

  it('代表だけが使える。機能停止中も使える(読み取りの一覧)', () => {
    const h = guardHarness()
    // 団体が作ったシート(名前に個人の情報が入りうる)
    h.addSheet('山田さんの連絡先メモ', [['a'], ['1'], ['2']])
    const top = h.post({ action: 'getDiagnostics', sessionToken: 'm-top' })
    expect(top.ok).toBe(true)
    // 上限の状況(メールの残り・長い記録・セルの数・スクリプトプロパティの大きさ・シートの行数)
    expect(top.result.diagnostics.limits).toMatchObject({ mail: expect.any(Object), longRecords: expect.any(Object), spreadsheetCells: { limit: 10000000 }, scriptProperties: { limit: 512000 } })
    // Ohsumi が作るシートは名前と行数、それ以外は「その他」の枚数と行数の合計だけ(名前は送らない)
    const names = Object.keys(top.result.diagnostics.limits.rows)
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(['Members', 'Projects', 'Tasks', 'Settings', 'MemberEmails', 'Expenses', 'FormSubmissions', 'DailyReports', 'Candidates', 'AuditLog', 'UsageDaily', 'ErrorLog']).toContain(n)
    expect(top.result.diagnostics.limits.otherSheets.sheets).toBeGreaterThanOrEqual(1)
    expect(top.result.diagnostics.limits.otherSheets.rows).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(top.result.diagnostics)).not.toContain('山田')
    expect(h.post({ action: 'getDiagnostics', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
    expect(h.post({ action: 'sendDiagnostics', sessionToken: 'm-lead', diagId: 'dg_x', requestId: 'diag-1' })).toMatchObject({ ok: false, forbidden: true })
    for (const list of ['READ_ONLY_ACTIONS', 'LOCK_EXEMPT_ACTIONS']) {
      expect(CODE_GS.match(new RegExp('var ' + list + ' = \\[[^\\]]*\\]'))![0]).toContain("'sendDiagnostics'")
    }
  })
})
