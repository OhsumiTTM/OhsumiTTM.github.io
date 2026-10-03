// 「今日の日付」を世界標準時(new Date().toISOString().slice(0, 10))で求めていないことを確かめる。
// 世界標準時だと、日本時間の0時〜9時に前の日になる(完了日・最後に動きがあった日・カレンダーの「今日」がずれる)。
// 今日の日付は utils.ts の todayStr()(その人の時間帯)を使う
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('今日の日付', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('画面のコードは new Date().toISOString().slice(0, 10) で今日の日付を求めない', () => {
    const root = join(__dirname, '..', '..')
    const files = [...walk(join(root, 'lib')), ...walk(join(root, 'components')), ...walk(join(root, 'app'))]
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes('new Date().toISOString().slice(0, 10)'))
    expect(hits).toEqual([])
  })

  it('todayStr は日本時間の日付を返す(世界標準時の前の日にならない)', async () => {
    vi.useFakeTimers()
    // 日本時間 2026-10-03 02:00 = 世界標準時 2026-10-02 17:00
    vi.setSystemTime(new Date('2026-10-02T17:00:00Z'))
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } })
    const { todayStr } = await import('./utils')
    expect(todayStr()).toBe('2026-10-03')
  })
})
