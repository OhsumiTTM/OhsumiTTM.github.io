// 定期タスクを作る日(recurringDueDates_): 月末の扱いと、毎朝の処理が動かなかった日の取りこぼし
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const pad = (n: number) => String(n).padStart(2, '0')
const ctx = vm.createContext({
  console,
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  Utilities: { formatDate: (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` },
})
vm.runInContext(CODE_GS, ctx)
const due = (ctx as unknown as { recurringDueDates_: (r: object, last: string, today: string) => string[] }).recurringDueDates_

describe('定期タスクを作る日', () => {
  it('毎月31日の規則は、31日の無い月はその月の最終日に作る', () => {
    expect(due({ frequency: 'monthly', dayOfMonth: 31 }, '2026-10-31', '2026-11-30')).toEqual(['2026-11-30'])
    expect(due({ frequency: 'monthly', dayOfMonth: 30 }, '2027-01-30', '2027-02-28')).toEqual(['2027-02-28'])
    expect(due({ frequency: 'monthly', dayOfMonth: 15 }, '2026-10-15', '2026-11-14')).toEqual([])
  })
  it('毎朝の処理が動かなかった日の分も作る(最大31日)', () => {
    expect(due({ frequency: 'weekly', dayOfWeek: 1 }, '2026-10-04', '2026-10-20')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19'])
    expect(due({ frequency: 'monthly', dayOfMonth: 1 }, '2026-01-01', '2026-10-20').length).toBeLessThanOrEqual(1)
  })
  it('初めての規則は、今日が規則に合う時だけ今日の分', () => {
    expect(due({ frequency: 'weekly', dayOfWeek: 1 }, '', '2026-10-05')).toEqual(['2026-10-05'])
    expect(due({ frequency: 'weekly', dayOfWeek: 1 }, '', '2026-10-06')).toEqual([])
  })
})
