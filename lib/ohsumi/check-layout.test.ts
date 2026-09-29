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

  it('代表で、管理画面のすべてのセクションを開く(ラベルは管理画面のメニューと同じ)', () => {
    const steps = layout.ADMIN_STEPS as { do: string; text?: string; from?: string }[]
    expect(steps[0].do).toBe('admin')
    const nav = readFileSync(join(ROOT, 'components', 'ohsumi', 'admin', 'admin-screen.tsx'), 'utf8')
    // メニューの項目(buildNav と採用)の数だけ開く(ダッシュボードは最初の手順)
    const navKeys = [...nav.matchAll(/\{ key: '(\w+)', label:/g)].map((m) => m[1])
    expect(navKeys.length).toBeGreaterThan(10)
    const texts = steps.filter((s) => s.do === 'click').map((s) => s.text!)
    expect(texts.length + 1).toBe(navKeys.length + (navKeys.includes('recruiting') ? 0 : 1))
    for (const text of texts) {
      // ラベルは buildNav に直接書いた英語か、ja.ts の admin.nav.* の値
      const inNav = nav.includes(`label: '${text}'`)
      const inJa = Object.entries(ja).some(([k, v]) => k.startsWith('admin.nav.') && v === text)
      expect(inNav || inJa, text).toBe(true)
    }
    // 管理画面のメニューのボタンだけを押す(同じ名前のほかのボタンを押さないように)
    expect(steps.filter((s) => s.do === 'click').every((s) => s.from === 'aside nav button')).toBe(true)
  })

  it('管理画面は、サンプルのデータの代表(最上位の役職)で開く', () => {
    const view = layout.viewerData(layout.ADMIN_MEMBER) as Record<string, { headers: string[]; rows: string[][] }>
    const members = view.Members
    const me = members.rows.find((r) => r[members.headers.indexOf('id')] === layout.ADMIN_MEMBER)!
    expect(me[members.headers.indexOf('role')]).toBe('代表')
    // 代表は幹部限定のタスクも受け取る
    expect(view.Tasks.rows.some((r) => r[view.Tasks.headers.indexOf('visibility')] === '幹部')).toBe(true)
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
