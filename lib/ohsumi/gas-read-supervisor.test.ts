// 評価・1on1・育成計画・キャリアの希望・アンケートの回答は、本人・代表と、その人を見る立場の人
// (報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者)にだけ返すことを確かめる。
// 既定の「班長」「事業責任者」は全権管理者なので、役職だけでは見られないことも確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const context = vm.createContext({ console })
vm.runInContext(CODE_GS, context)
const gas = context as unknown as { buildViewerData_: (data: unknown, id: string) => { Members: Table } }

type Table = { headers: string[]; rows: string[][] }
const table = (headers: string[], objs: Record<string, string>[]): Table => ({ headers, rows: objs.map((o) => headers.map((h) => o[h] ?? '')) })

const SENSITIVE = ['evaluation_history_json', 'one_on_ones_json', 'development_plan_json', 'career_aspiration', 'desired_future_role', 'career_plan', 'survey_responses_json']
const H = ['id', 'name', 'role', 'reports_to_id', 'mentor_id', 'will_tags', ...SENSITIVE]
const secret = (id: string) => Object.fromEntries(SENSITIVE.map((c) => [c, `${c}:${id}`]))
const members = table(H, [
  { id: 'boss', name: '代表', role: '代表' },
  { id: 'exec', name: '事業責任者', role: '事業責任者' },
  { id: 'lead', name: '班長', role: '班長', reports_to_id: 'exec' },
  { id: 'lead2', name: '班長2', role: '班長' },
  { id: 'a', name: 'A', role: '一般', reports_to_id: 'lead', will_tags: '設計', ...secret('a') },
  { id: 'b', name: 'B', role: '一般', mentor_id: 'lead2', ...secret('b') },
  { id: 'c', name: 'C', role: '一般', ...secret('c') },
  { id: 'd', name: 'D', role: '一般', ...secret('d') },
])
const projects = table(['id', 'name', 'owner_id', 'member_ids', 'parent_id'], [
  { id: 'p1', name: '親', owner_id: 'lead2', member_ids: 'c' },
  { id: 'p2', name: '子', owner_id: 'x', member_ids: 'd', parent_id: 'p1' },
])
const snapshot = { Members: members, Projects: projects, Tasks: table(['id'], []), Settings: table(['key', 'value'], []) }

function seen(viewer: string, target: string): Record<string, string> {
  const t = gas.buildViewerData_(JSON.parse(JSON.stringify(snapshot)), viewer).Members
  const row = t.rows.find((r) => r[t.headers.indexOf('id')] === target)!
  return Object.fromEntries(t.headers.map((h, i) => [h, row[i]]))
}
const visible = (viewer: string, target: string) => SENSITIVE.every((c) => seen(viewer, target)[c] === `${c}:${target}`)
const hidden = (viewer: string, target: string) => SENSITIVE.every((c) => !seen(viewer, target)[c])

describe('評価・1on1 などを見られる人', () => {
  it('本人と代表は見られる', () => {
    expect(visible('a', 'a')).toBe(true)
    expect(visible('boss', 'a')).toBe(true)
    expect(visible('boss', 'd')).toBe(true)
  })
  it('報告先をたどった上の人は見られる(直属の班長と、その上の事業責任者)', () => {
    expect(visible('lead', 'a')).toBe(true)
    expect(visible('exec', 'a')).toBe(true)
  })
  it('メンターは見られる', () => {
    expect(visible('lead2', 'b')).toBe(true)
  })
  it('プロジェクトの責任者は、そのプロジェクトと子プロジェクトのメンバーを見られる', () => {
    expect(visible('lead2', 'c')).toBe(true)
    expect(visible('lead2', 'd')).toBe(true)
  })
  it('全権管理者の役職でも、見る立場に無いメンバーは見られない', () => {
    expect(hidden('lead', 'b')).toBe(true)
    expect(hidden('lead', 'c')).toBe(true)
    expect(hidden('exec', 'b')).toBe(true)
    expect(hidden('lead2', 'a')).toBe(true)
  })
  it('一般のメンバーは、ほかの人の分を見られない。Will は全員に見える', () => {
    expect(hidden('b', 'a')).toBe(true)
    expect(seen('b', 'a').will_tags).toBe('設計')
  })
})
