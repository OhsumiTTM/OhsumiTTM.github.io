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

  it('暗い表示でも主な画面(ログイン・INPUT・OUTPUT の各表示・タスク詳細・管理画面・団体設定)を開き、ラベルは ja.ts にある', () => {
    const values = new Set(Object.values(ja))
    const dark = [...layout.DARK_STEPS, ...layout.DARK_ADMIN_STEPS] as { do: string; text?: string; view?: string }[]
    const kinds = new Set(dark.map((s) => s.do))
    for (const k of ['login', 'home', 'openTask', 'admin', 'orgSettings', 'themeColor']) expect(kinds.has(k), k).toBe(true)
    const texts = dark.map((s) => s.text)
    for (const view of ['ワークフロー', 'リスト', 'カレンダー', '難易度', '依存関係', 'ガント', '公募', 'INPUT']) expect(texts).toContain(view)
    for (const s of dark) {
      if (s.do === 'click' && s.text && s.text !== 'INPUT') expect(values.has(s.text) || /^[A-Za-z ]+$/.test(s.text), s.text).toBe(true)
      if (s.do === 'openTask' && s.view) expect(values.has(s.view), s.view).toBe(true)
    }
    for (const label of ['団体設定', 'ダークモードに切替']) expect(values.has(label), label).toBe(true)
    expect((layout.ORG_SWITCH_STEPS as { do: string }[]).map((s) => s.do)).toEqual(['orgSwitcher', 'orgSwitcherSingle'])
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

describe('提供停止・機能停止の知らせ(375px)', () => {
  it('機能停止中の知らせと、停止の予告を開く(確かめる文は ja.ts の知らせにある)', () => {
    const steps = (layout.STEPS as { do: string; contract?: { phase: string; kind: string }; expect?: string }[]).filter((s) => s.do === 'contract')
    expect(steps.map((s) => `${s.contract!.phase}/${s.contract!.kind}`)).toEqual(['inEffect/restrict', 'scheduled/suspend'])
    expect(ja['app.contractRestricted']).toContain(steps[0].expect!)
    expect(ja['app.contractScheduledSuspend']).toContain(steps[1].expect!)
  })
})

describe('機能停止中(読み取り専用)の閲覧・書き出し', () => {
  it('期間・プロジェクト・表示・並び替え・表示項目・リスト・タスク詳細・管理画面を確かめる(ラベルは画面の表示と同じ)', () => {
    const steps = layout.READ_ONLY_STEPS as { do: string; labels?: string[] }[]
    expect(steps.map((s) => s.do)).toEqual(['readOnlyWorkspace', 'readOnlyList', 'readOnlyTask', 'readOnlyAdmin',
      'readOnlyAddTask', 'readOnlyComment', 'readOnlyExpense', 'readOnlyApprove', 'otherDevice'])
    expect(layout.READ_ONLY_CONTRACT).toMatchObject({ phase: 'inEffect', kind: 'restrict' })
    const values = new Set(Object.values(ja))
    const nav = readFileSync(join(ROOT, 'components', 'ohsumi', 'admin', 'admin-screen.tsx'), 'utf8')
    // 画面の上のメニュー(INPUT・OUTPUT・ADMIN)は header.tsx に直接書いてある
    const header = readFileSync(join(ROOT, 'components', 'ohsumi', 'header.tsx'), 'utf8')
    for (const label of steps.flatMap((s) => s.labels ?? [])) {
      expect(values.has(label) || nav.includes(`label: '${label}'`) || new RegExp(`>\\s*${label}\\s*<`).test(header), label).toBe(true)
    }
  })
})

describe('機能停止中の書き込みの見張り', () => {
  it('check:layout が書き込みとして数えない操作は、GAS の読み取りの一覧(READ_ONLY_ACTIONS)と ping・getLoginConfig だけ', () => {
    const code = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')
    const gasReads = (/var READ_ONLY_ACTIONS = \[([\s\S]*?)\]/.exec(code)![1].match(/'(\w+)'/g) ?? []).map((x) => x.slice(1, -1))
    expect([...(layout.LAYOUT_READ_ACTIONS as string[])].sort()).toEqual([...gasReads, 'ping', 'getLoginConfig'].sort())
  })
})

describe('レジストリの管理画面(375px)', () => {
  it('ログイン・団体・登録コード・発行した後・操作の記録を開く(タブのラベルは管理画面の TABS と同じ)', () => {
    const steps = layout.REGISTRY_STEPS as { do: string; text?: string }[]
    const kinds = new Set(steps.map((s) => s.do))
    for (const k of ['registryLogin', 'registry', 'registrySuspend', 'registryIssue']) expect(kinds.has(k), k).toBe(true)
    const src = readFileSync(join(ROOT, 'components', 'registry', 'registry-admin.tsx'), 'utf8')
    for (const s of steps.filter((s) => s.do === 'click')) expect(src).toContain(`label: '${s.text}'`)
    expect(src).toContain('発行する')
  })

  it('偽の応答は、団体の状態・登録コードの状態をすべて含む', () => {
    const r = layout.registryResponse({ action: 'adminOverview' }) as { orgs: { state: string }[]; codes: { state: string }[] }
    expect(new Set(r.orgs.map((o) => o.state))).toEqual(new Set(['active', 'scheduled', 'restricted', 'suspended']))
    expect(new Set(r.codes.map((c) => c.state))).toEqual(new Set(['unused', 'used', 'expired', 'revoked']))
  })
})

describe('ほかの端末で開く', () => {
  it('スマホの幅とパソコンの幅の両方、共有の有無、メールを送れない団体、機能停止中を確かめる(ラベル・文は ja.ts と同じ)', () => {
    type Step = { do: string; width?: number; share?: boolean; mail?: string; readOnly?: boolean }
    const steps = [...(layout.STEPS as Step[]), ...(layout.READ_ONLY_STEPS as Step[])].filter((s) => s.do === 'otherDevice')
    expect(steps.some((s) => !s.width)).toBe(true)
    expect(steps.some((s) => (s.width ?? 0) >= 1024)).toBe(true)
    expect(steps.some((s) => s.share)).toBe(true)
    expect(steps.some((s) => s.mail === 'notChecked')).toBe(true)
    expect(steps.some((s) => s.readOnly)).toBe(true)
    const values = Object.values(ja)
    for (const label of layout.OTHER_DEVICE_LABELS as string[]) expect(values, label).toContain(label)
    for (const text of layout.OTHER_DEVICE_TEXTS as string[]) expect(values.some((v) => v.includes(text)), text).toBe(true)
  })
})
