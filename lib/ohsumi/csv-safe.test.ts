// CSV インジェクション対策(csv-safe.ts)と、書き出しがそれを通ることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { csvField, neutralizeFormula } from './csv-safe'

describe('数式の対策', () => {
  it('= + - @ タブ 改行 で始まる文字には先頭に \' を付ける', () => {
    for (const v of ['=HYPERLINK("http://x")', '+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx', '\nx']) {
      expect(neutralizeFormula(v), v).toBe("'" + v)
    }
  })
  it('普通の文字・数・「-」だけの値はそのまま', () => {
    for (const v of ['会員名簿の更新', '-', '-5', '+3.2', '50%', '2026-10-03', '']) expect(neutralizeFormula(v), v).toBe(v)
    expect(neutralizeFormula(-5)).toBe('-5')
    expect(neutralizeFormula(null)).toBe('')
  })
  it('CSV の欄は、数式の対策をしてから必要なら " で囲む', () => {
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField('=A1,B1')).toBe(`"'=A1,B1"`)
    expect(csvField('a"b')).toBe('"a""b"')
  })
  it('タスク・メンバーの CSV と個人のスプレッドシートの同期は、共通の関数を通る', () => {
    const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
    expect(read('lib/ohsumi/export-excel.ts')).toContain('csvField(')
    expect(read('components/ohsumi/admin/admin-member-db.tsx')).toContain('csvField(')
    expect(read('lib/ohsumi/google-sheet-sync.ts')).toContain('neutralizeFormula')
  })
})
