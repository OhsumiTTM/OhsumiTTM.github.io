// Discord/Slack の通知のタスクのリンク(v1.2): 1つのタスクについての通知(確認待ち・日程調整・フォームの回答がそろった)には、
// そのタスクのリンクを、Discord は [文字](URL)、Slack は <URL|文字> で埋め込む。幹部限定・承認待ちのタスクにも付ける
// (名前は出さない。開くにはログインと権限が要る)。ほかの通知は今までどおり「Ohsumi を開く」のリンク
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

const ORG = 'org_GUARDGUARDGUARDGU01'
const LINK = 'https://site.example.com/?org=' + ORG
const CHECKED = JSON.stringify({ phase: 'none', kind: 'suspend', suspendAt: '', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['https://site.example.com'] })
const LABEL = 'このタスクを開く / Open this task'

const setup = () => {
  const h = guardHarness({ props: { CONTRACT_STATE: CHECKED } })
  const slack: string[] = []
  h.c.sendSlackMessage_ = (content: string) => { slack.push(String(content)) }
  const discord = () => h.sent.filter((s) => s.kind === 'chat').map((s) => s.text)
  return { h, slack, discord }
}

describe('Discord/Slack の通知のタスクのリンク', () => {
  it('確認待ちの通知には、そのタスクのリンクを、それぞれの書き方で埋め込む', () => {
    const { h, slack, discord } = setup()
    ;(h.c.notifyReview_ as (id: string) => void)('t1')
    expect(discord().at(-1)).toBe('🔔 「タスク1」が確認待ちになりました。\n\n[' + LABEL + '](' + LINK + '&task=t1)')
    expect(slack.at(-1)).toBe('🔔 「タスク1」が確認待ちになりました。\n\n<' + LINK + '&task=t1|' + LABEL + '>')
    expect(slack.at(-1)).not.toContain('Ohsumi を開く')
  })

  it('幹部限定のタスクも、名前は出さずにリンクを付ける', () => {
    const { h, slack, discord } = setup()
    ;(h.c.notifyReview_ as (id: string) => void)('t-exec')
    expect(discord().at(-1)).toContain('幹部限定のタスク')
    expect(discord().at(-1)).not.toContain('「幹部限定タスク」')
    expect(discord().at(-1)).toContain('(' + LINK + '&task=t-exec)')
    expect(slack.at(-1)).toContain('<' + LINK + '&task=t-exec|' + LABEL + '>')
  })

  it('タスクについての通知でない時・リンクが分からない時は、今までどおり「Ohsumi を開く」の URL', () => {
    const { h, slack, discord } = setup()
    const notify = h.c.notifyChat_ as (content: string, taskId?: string) => void
    notify('⚠️ 確認してください')
    expect(discord().at(-1)).toBe('⚠️ 確認してください\n\nOhsumi を開く / Open Ohsumi: ' + LINK)
    expect(slack.at(-1)).toBe('⚠️ 確認してください\n\nOhsumi を開く / Open Ohsumi: ' + LINK)
    notify('📝 形の違う ID', 'a/b')
    expect(discord().at(-1)).toBe('📝 形の違う ID\n\nOhsumi を開く / Open Ohsumi: ' + LINK)
  })

  it('日程調整・フォームの回答がそろった通知も、タスクの ID を渡す', () => {
    const code = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
    expect(code).toContain("notifyChat_('🗓️ ' + chatTaskLabel_(task) + 'の日程調整で全員の回答が揃いました。', String(taskId))")
    expect(code).toContain("notifyChat_('📝 ' + chatTaskLabel_(task) + 'のフォームで全員の回答が揃いました。', String(taskId))")
  })
})
