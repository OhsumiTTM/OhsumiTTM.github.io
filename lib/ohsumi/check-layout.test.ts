// スマホの幅の表示の確認(scripts/check-layout.mjs)の設定を固定する。
// 実際の確認は CI の「Layout check (375px)」で、ビルドしたサイトを Chrome で開いて行う。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as layout from '../../scripts/check-layout.mjs'
import { ja } from './i18n/ja'

const ROOT = join(__dirname, '..', '..')

describe('スマホの幅の表示の確認', () => {
  it('幅は 375px で、CI で毎回実行する', () => {
    expect(layout.WIDTH).toBe(375)
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['check:layout']).toBe('node scripts/check-layout.mjs')
    expect(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')).toMatch(/run: pnpm check:layout/)
  })

  it('主な画面(ログイン・OUTPUT の各表示・タスク詳細・個人ページ)を開く', () => {
    const steps = layout.STEPS as { name: string; do: string; text?: string; dependencyCards?: boolean }[]
    const kinds = new Set(steps.map((s) => s.do))
    for (const k of ['login', 'home', 'openTask', 'profile']) expect(kinds.has(k), k).toBe(true)
    const texts = steps.map((s) => s.text)
    for (const view of ['ワークフロー', 'リスト', 'カレンダー', '難易度', '依存関係', 'ガント', '公募']) expect(texts).toContain(view)
    expect(steps.some((s) => s.dependencyCards)).toBe(true)
  })

  it('画面を開くためのラベルは、日本語の表示(ja.ts)にある', () => {
    const values = new Set(Object.values(ja))
    const steps = layout.STEPS as { do: string; text?: string; view?: string }[]
    for (const s of steps) {
      if (s.do === 'click' && s.text) expect(values.has(s.text), s.text).toBe(true)
      if (s.do === 'openTask' && s.view) expect(values.has(s.view), s.view).toBe(true)
    }
    expect(values.has('プロフィール')).toBe(true)
  })

  it('一般のメンバーが受け取るサンプルのデータで確かめる(長い名前などの極端な例を含む)', () => {
    const view = layout.viewerData() as Record<string, { headers: string[]; rows: string[][] }>
    const tasks = view.Tasks
    const title = tasks.headers.indexOf('title')
    expect(tasks.rows.length).toBeGreaterThan(100)
    expect(tasks.rows.some((r) => r[title].length > 60)).toBe(true)
    // 幹部限定のタスクは含まれない(GAS の読み取りの絞り込みを通している)
    expect(tasks.rows.some((r) => r[tasks.headers.indexOf('visibility')] === '幹部')).toBe(false)
  })
})
