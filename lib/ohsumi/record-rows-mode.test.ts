// データの持ち方の欄に出す操作(lib/ohsumi/record-rows-mode.ts): 「戻す」は移してから30日以内か failed の時だけ
import { describe, expect, it } from 'vitest'
import { recordRowsMode } from './record-rows-mode'

const NOW = Date.parse('2026-10-08T00:00:00.000Z')
const DAY = 86400000
const at = (days: number) => new Date(NOW - days * DAY).toISOString()

describe('recordRowsMode', () => {
  it('移してから30日以内だけ「戻す」。それより後は状態の1行だけ', () => {
    expect(recordRowsMode({ state: 'done', since: at(0), backup: 'Ohsumi バックアップ(移行の前)' }, NOW)).toBe('revert')
    expect(recordRowsMode({ state: 'done', since: at(30), backup: 'Ohsumi バックアップ(移行の前)' }, NOW)).toBe('revert')
    expect(recordRowsMode({ state: 'done', since: at(31), backup: 'Ohsumi バックアップ(移行の前)' }, NOW)).toBe('statusOnly')
  })

  it('最初から行に持つ新しい団体(移行のバックアップが無い)は、状態の1行だけ', () => {
    expect(recordRowsMode({ state: 'done', since: at(0), backup: '' }, NOW)).toBe('statusOnly')
    expect(recordRowsMode({ state: 'done', since: '', backup: 'x' }, NOW)).toBe('statusOnly')
  })

  it('failed・戻している途中は「戻す」。セルのままは「移す」、途中で止まった時は「続きから移す」', () => {
    expect(recordRowsMode({ state: 'failed', since: at(100), backup: '' }, NOW)).toBe('revert')
    expect(recordRowsMode({ state: 'reverting', since: at(100), backup: '' }, NOW)).toBe('revert')
    expect(recordRowsMode({ state: 'none', since: '', backup: '' }, NOW)).toBe('migrate')
    expect(recordRowsMode({ state: 'migrating', since: at(0), backup: 'x' }, NOW)).toBe('resume')
  })
})
