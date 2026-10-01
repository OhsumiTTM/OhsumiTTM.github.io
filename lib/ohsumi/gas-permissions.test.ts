// Google の許可(PR M): gas/appsscript.json の oauthScopes に、コードが使うサービスの許可がそろっているか。
// 許可が足りない時は、その機能だけが止まり、ほかは動くか
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, noop } from './gas-guard-harness'

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'gas', 'appsscript.json'), 'utf8')) as { oauthScopes: string[] }
const G = 'https://www.googleapis.com/auth/'

// サービス → 要る許可。コードが新しいサービスを使い始めたら、ここと appsscript.json の両方に足す
const SERVICE_SCOPES: [RegExp, string][] = [
  [/\bSpreadsheetApp\.|ScriptApp\.getOAuthToken\(/, 'spreadsheets'],
  [/\bDriveApp\./, 'drive'],
  [/\bCalendarApp\./, 'calendar'],
  [/\bMailApp\./, 'script.send_mail'],
  [/\bUrlFetchApp\./, 'script.external_request'],
  [/\bScriptApp\.(newTrigger|getProjectTriggers|deleteTrigger)\(/, 'script.scriptapp'],
  [/\bSpreadsheetApp\.getUi\(/, 'script.container.ui'],
  [/\bSession\.getEffectiveUser\(\)\.getEmail\(/, 'userinfo.email'],
]
// 使わない(許可の画面の警告を増やさない)。使い始める時は、ここから外して SERVICE_SCOPES に足す
const NOT_USED = [/\bGmailApp\./, /\bFormApp\./, /\bDocumentApp\./, /\bSlidesApp\./, /\bContactsApp\./, /\bPeople\./, /\bDrive\.(Files|Permissions)\./]
const deny = (name: string) => () => { throw new Error('Exception: You do not have permission to call ' + name + '. Required permissions: ' + G + 'x') }

describe('マニフェストの oauthScopes', () => {
  it('コードが使うサービスの許可が、すべて書いてある', () => {
    for (const [re, scope] of SERVICE_SCOPES) {
      if (re.test(CODE_GS)) expect(manifest.oauthScopes, scope).toContain(G + scope)
    }
  })

  it('使わない許可は書かない(書いてある許可は、どれもコードが使っている)', () => {
    const used = new Set(SERVICE_SCOPES.filter(([re]) => re.test(CODE_GS)).map(([, s]) => G + s))
    expect(manifest.oauthScopes.filter((s) => !used.has(s))).toEqual([])
  })

  it('許可の画面の警告を増やすサービスを、黙って使い始めていない', () => {
    for (const re of NOT_USED) expect(re.test(CODE_GS), String(re)).toBe(false)
  })
})

describe('許可が足りない時', () => {
  it('その操作だけを止め、直し方を返す(エラーの記録には permission と残す)', () => {
    const h = guardHarness()
    h.c.updateRowFieldsUnmeasured_ = deny('SpreadsheetApp.getRange')
    const res = h.post({ action: 'updatePriority', sessionToken: 'm-lead', taskId: 't1', priority: 'high', requestId: 'perm-1' })
    expect(res).toMatchObject({ ok: false })
    expect(res.error).toContain('setupOhsumi を実行して許可して')
    expect(h.sheets.ErrorLog.rows[1].slice(1)).toEqual(['gas', 'updatePriority', 'permission'])
  })

  it('メールの許可が無くても、コメントは保存する(通知だけ送らない)', () => {
    const h = guardHarness()
    h.c.MailApp = { sendEmail: deny('MailApp.sendEmail'), getRemainingDailyQuota: deny('MailApp.getRemainingDailyQuota') }
    const res = h.post({ action: 'updateComments', sessionToken: 'm-lead', taskId: 't1', requestId: 'perm-2',
      listOps: [{ op: 'add', entry: { id: 'c-n', byId: 'm-lead', text: '@一般 見てください', at: '2026-10-01' } }] })
    expect(res.ok, res.error).toBe(true)
    expect(h.tasksJson()).toContain('見てください')
  })

  it('カレンダーの許可が無くても、担当を変える', () => {
    const h = guardHarness({ realCalendar: true })
    h.c.CalendarApp = { getDefaultCalendar: deny('CalendarApp.getDefaultCalendar') }
    const res = h.post({ action: 'assignTask', sessionToken: 'm-top', taskId: 't1', assigneeIds: ['m-other'], requestId: 'perm-3' })
    expect(res.ok, res.error).toBe(true)
    expect(h.tasksJson()).toContain('m-other')
  })

  it('ドライブの許可が無くても、毎日の処理はほかの手順を続け、共有の確かめは「確かめられない」として代表に出す', () => {
    const h = guardHarness()
    h.c.DriveApp = new Proxy({}, { get: (_t, k) => (k === 'Access' || k === 'Permission' ? {} : deny('DriveApp.' + String(k))) })
    h.c.Session = { getScriptTimeZone: () => 'Asia/Tokyo', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) }
    expect(() => (h.c.dailyMaintenanceUnrecorded_ as () => void)()).not.toThrow()
    const ops = h.post({ action: 'getOpsStatus', sessionToken: 'm-top' })
    expect(ops.ok).toBe(true)
    expect(ops.result.sharing.problems[0]).toMatchObject({ kind: 'unknown' })
  })

  it('外への通信の許可が無くても、停止の状態の確かめは失敗を記録して、団体の画面は使い続けられる', () => {
    const h = guardHarness()
    h.c.UrlFetchApp = noop({ fetch: deny('UrlFetchApp.fetch') })
    expect(() => (h.c.checkContractStatus as () => void)()).not.toThrow()
    expect(h.post({ action: 'getInitialData', sessionToken: 'm-base' }).ok).toBe(true)
  })
})
