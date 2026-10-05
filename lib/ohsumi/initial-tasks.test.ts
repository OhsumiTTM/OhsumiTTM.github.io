// 初期タスク: メンバーを作った時に GAS で1回だけ作る(ログインの時には作らない)
//   最初の代表(初期設定コード): 団体を使い始めるための8つ / 新しいメンバー: 3つ(initial_tasks_json があればそれ)
//   「はじめに」のプロジェクトに入れる(無ければ作り、2回目からは同じものを使う)
import { describe, expect, it } from 'vitest'
import { createWorld, type Org } from './e2e/world'

type Row = Record<string, string>
const rowsOf = (org: Org, sheet: string): Row[] => {
  const rows = org.sheets[sheet]?.rows ?? []
  const head = (rows[0] ?? []).map(String)
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '')])))
}
const tasksOf = (org: Org, memberId: string) => rowsOf(org, 'Tasks').filter((t) => t.assignee_id.split(',').includes(memberId))
const memberByName = (org: Org, name: string) => rowsOf(org, 'Members').find((m) => m.name === name)!

describe('初期タスク', () => {
  it('最初の代表には8つ、追加したメンバーには3つを「はじめに」のプロジェクトに作る。ログインし直しても増えない', () => {
    const w = createWorld()
    const A = w.launchOrg('団体A', 'contact@a.example')
    const top = w.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode }).result
    const leaderTasks = tasksOf(A.org, top.memberId)
    expect(leaderTasks.map((t) => t.title)).toEqual(['団体の情報を設定する', '役職と部門を決める', 'メンバーを追加して招待する', '最初のプロジェクトを作る',
      '最初のタスクを作って担当を決める', '通知の受け取り方を決める', '安全の設定を確かめる', '引き継ぎの準備をする'])
    const projects = rowsOf(A.org, 'Projects').filter((p) => p.name === 'はじめに')
    expect(projects).toHaveLength(1)
    expect(leaderTasks.every((t) => t.project_id === projects[0].id && t.creator_id === top.memberId)).toBe(true)
    expect(leaderTasks.every((t) => /approved|承認済み/.test(t.approval_status))).toBe(true)
    expect(leaderTasks[0].description).toContain('団体名・ロゴ・テーマの色')

    expect(w.call(A.org, top.session.token, 'addMember', { name: '一般さん', email: 'base@a.example', affiliation: '', role: 'base', sendInvite: false }).ok).toBe(true)
    const base = memberByName(A.org, '一般さん')
    expect(tasksOf(A.org, base.id).map((t) => t.title)).toEqual(['Ohsumiの使い方を確認する', 'プロフィールを設定する', 'チームメンバーのタスクを確認する'])
    expect(rowsOf(A.org, 'Projects').filter((p) => p.name === 'はじめに')).toHaveLength(1)

    // ログインでは作らない(すでにいるメンバー)
    const before = rowsOf(A.org, 'Tasks').length
    w.googleLogin(A.org, 'base@a.example')
    w.googleLogin(A.org, 'top@a.example')
    expect(rowsOf(A.org, 'Tasks')).toHaveLength(before)
  })

  it('initial_tasks_json があれば、新しいメンバーにはその内容で作る。候補者をメンバーにした時も作る', () => {
    const w = createWorld()
    const A = w.launchOrg('団体A', 'contact@a.example')
    const top = w.googleLogin(A.org, 'top@a.example', { setupCode: A.setupCode }).result
    const tok = top.session.token
    expect(w.call(A.org, tok, 'updateSetting', { key: 'initial_tasks_json', value: JSON.stringify([{ name: '団体の決まりを読む', description: '共有ドライブの「決まり」を読みます' }, { name: '' }]) }).ok).toBe(true)
    w.call(A.org, tok, 'addMember', { name: '新人さん', email: 'new@a.example', affiliation: '', role: 'base', sendInvite: false })
    expect(tasksOf(A.org, memberByName(A.org, '新人さん').id).map((t) => t.title)).toEqual(['団体の決まりを読む'])

    const cand = w.call(A.org, tok, 'addCandidate', { candidate: { name: '候補さん', email: 'cand@a.example', status: 'interview' } })
    expect(cand.ok, JSON.stringify(cand)).toBe(true)
    const conv = w.call(A.org, tok, 'convertCandidateToMember', { candidateId: cand.result.id, role: 'base' })
    expect(conv.ok, JSON.stringify(conv)).toBe(true)
    expect(tasksOf(A.org, conv.result.memberId).map((t) => t.title)).toEqual(['団体の決まりを読む'])
  })
})
