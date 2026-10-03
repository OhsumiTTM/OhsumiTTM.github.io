// setupOhsumi が、団体の GAS に必要なトリガーをすべて作ることを確かめる。
// 以前は毎日の処理(dailyMaintenance)のトリガーが setupDailyTrigger でしか作られず、
// テンプレートから立ち上げた団体でバックアップなどが一度も動かなかった
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

function functionBody(name: string): string {
  const start = CODE_GS.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  const next = CODE_GS.indexOf('\nfunction ', start + 1)
  return CODE_GS.slice(start, next < 0 ? undefined : next)
}

describe('setupOhsumi のトリガー', () => {
  const required = (CODE_GS.match(/var REQUIRED_TRIGGERS = \[([^\]]*)\]/)?.[1] ?? '').match(/'(\w+)'/g)?.map((s) => s.slice(1, -1)) ?? []

  it('必要なトリガーの一覧に、毎日・毎時の処理と編集・変更の検知が入っている', () => {
    expect(required).toEqual(expect.arrayContaining(['dailyMaintenance', 'sendBatchNotifications', 'checkContractStatus', 'onSpreadsheetChange', 'onSpreadsheetEdit']))
  })

  it('一覧のトリガーは、すべて setupOhsumi の中で作られる', () => {
    const body = functionBody('setupOhsumi')
    for (const name of required) expect(body, name).toContain(`ScriptApp.newTrigger('${name}')`)
  })

  it('setupOhsumi は最後に、足りないトリガーを確かめる', () => {
    expect(functionBody('setupOhsumi')).toContain('REQUIRED_TRIGGERS.filter')
  })
})
