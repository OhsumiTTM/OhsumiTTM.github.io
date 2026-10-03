// Discord・Slack(notifyChat_)に、画面で見える範囲より広い情報を流さないことを確かめる。
// チャンネルにはメンバー全員(や団体の外の人)が入っている前提:
//   ・幹部限定・承認待ちのタスクは名前を出さない
//   ・Will の中身・研修の名前・却下の理由など、個人の情報や理由の文を出さない
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const ctx = vm.createContext({ console })
vm.runInContext(CODE_GS, ctx)
const gas = ctx as unknown as { chatTaskLabel_: (t: Record<string, string>) => string }

describe('チャンネルに出すタスクの名前', () => {
  it('普通のタスクは名前を出す', () => {
    expect(gas.chatTaskLabel_({ title: '会員名簿の更新', visibility: '', approval_status: 'approved' })).toBe('「会員名簿の更新」')
  })
  it('幹部限定・承認待ちのタスクは名前を出さない(日本語の値でも同じ)', () => {
    expect(gas.chatTaskLabel_({ title: '役員の人事', visibility: 'leaders' })).toBe('幹部限定のタスク')
    expect(gas.chatTaskLabel_({ title: '役員の人事', visibility: '幹部' })).not.toContain('役員の人事')
    expect(gas.chatTaskLabel_({ title: '新しい企画', approval_status: 'pending' })).toBe('承認待ちのタスク')
  })
})

describe('notifyChat_ に流す文', () => {
  const calls = [...CODE_GS.matchAll(/notifyChat_\(([^\n]*)\)\s*$/gm)].map((m) => m[1]).filter((a) => !a.startsWith('content'))
  it('呼び出しが見つかる', () => expect(calls.length).toBeGreaterThan(5))
  it('タスクの名前は chatTaskLabel_ を通す(task.title をそのまま流さない)', () => {
    for (const c of calls) expect(c, c).not.toMatch(/\.title\b/)
  })
  it('Will の中身・研修の名前・却下の理由を流さない', () => {
    for (const c of calls) expect(c, c).not.toMatch(/willTags|trainingName|reason/)
  })
})
