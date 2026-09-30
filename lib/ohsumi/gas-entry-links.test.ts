// サイトに入る経路(PR B): 通知メール・Discord/Slack・カレンダーの予定に、正式なサイトの <サイト>/?org=<団体ID> を付けること、
// メンバーの追加・候補者を正式なメンバーにする時の招待メール、登録されていないアカウントの時に返す団体名、
// レジストリに登録した時の完全な招待リンク
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

const ORG = 'org_GUARDGUARDGUARDGU01'
const LINK = 'https://site.example.com/?org=' + ORG
// レジストリに確かめた団体(サイトの origin の一覧を受け取っている)
const CHECKED = JSON.stringify({ phase: 'none', kind: 'suspend', suspendAt: '', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['https://site.example.com', 'https://old.example.com'] })

const mention = (h: ReturnType<typeof guardHarness>) => h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1',
  comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-1', byId: 'm-base', text: '@班長 見てください' }] })

describe('通知からサイトを開けるようにする', () => {
  it('通知メールと Discord/Slack に、正式なサイト(一覧の最初)の招待リンクを付ける', () => {
    const h = guardHarness({ props: { CONTRACT_STATE: CHECKED } })
    expect(mention(h).ok).toBe(true)
    const mail = h.sent.find((s) => s.kind === 'mail')!
    expect(mail.text).toContain('Ohsumi を開く / Open Ohsumi: ' + LINK)
    expect(mail.text).not.toContain('old.example.com')
    // 研修の申請(報告先へのメールと Discord)
    h.post({ action: 'notifyTrainingRequest', sessionToken: 'm-base', memberId: 'm-base', trainingId: 'tr-pending' })
    expect(h.sent.find((s) => s.kind === 'chat')!.text).toContain(LINK)
  })

  it('レジストリに確かめていない団体では、リンクを付けない(通知はそのまま送る)', () => {
    const h = guardHarness()
    expect(mention(h).ok).toBe(true)
    const mail = h.sent.find((s) => s.kind === 'mail')!
    expect(mail.text).toContain('@班長 見てください')
    expect(mail.text).not.toContain('?org=')
  })

  it('カレンダーの予定の説明に、招待リンクを付ける', () => {
    const h = guardHarness({ props: { CONTRACT_STATE: CHECKED }, realCalendar: true })
    h.sheets.Tasks.rows[1][h.sheets.Tasks.rows[0].indexOf('due_date')] = '2026-10-20'
    ;(h.c.syncCalendarForTask_ as (id: string) => void)('t1')
    expect(h.events).toHaveLength(1)
    expect(h.events[0].options.description).toBe('Ohsumi を開く / Open Ohsumi: ' + LINK)
  })
})

describe('新しいメンバーへの招待メール', () => {
  it('メンバーの追加で「招待メールを送る」を選ぶと、登録したアドレスに団体名と招待リンクを送る', () => {
    const h = guardHarness({ props: { CONTRACT_STATE: CHECKED } })
    const res = h.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email: 'new@example.com', role: 'base', sendInvite: true })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.invite).toEqual({ sent: true })
    const mail = h.sent.find((s) => s.to === 'new@example.com')!
    expect(mail.text).toContain('テスト団体 の Ohsumi に招待されました')
    expect(mail.text).toContain(LINK)
    // リンクは1回だけ(足すリンクと重ならない)
    expect(mail.text.split(LINK)).toHaveLength(2)
  })

  it('選ばない時・レジストリに確かめていない団体では送らない(追加はする)', () => {
    const h = guardHarness({ props: { CONTRACT_STATE: CHECKED } })
    expect(h.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email: 'new@example.com', role: 'base' }).result.invite).toBeUndefined()
    const u = guardHarness()
    const res = u.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email: 'new@example.com', role: 'base', sendInvite: true })
    expect(res.ok).toBe(true)
    expect(res.result.invite).toEqual({ sent: false, reason: 'notChecked' })
    expect([...h.sent, ...u.sent].filter((s) => s.to === 'new@example.com')).toEqual([])
  })

  it('候補者を正式なメンバーにする時も、選べば招待メールを送る', () => {
    const h = guardHarness({ props: { CONTRACT_STATE: CHECKED } })
    const headers = (h.c.CANDIDATES_HEADERS as string[])
    h.addSheet('Candidates', [headers, headers.map((k) => ({ id: 'cand1', name: '候補者', email: 'cand@example.com' } as Record<string, string>)[k] ?? '')])
    const res = h.post({ action: 'convertCandidateToMember', sessionToken: 'm-top', candidateId: 'cand1', sendInvite: true })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.invite).toEqual({ sent: true })
    expect(h.sent.find((s) => s.to === 'cand@example.com')!.text).toContain(LINK)
  })
})

describe('登録されていないアカウント', () => {
  it('Google でログインした後に、団体名を返す(画面に「どの団体に入ろうとしたか」を出すため)', () => {
    const h = guardHarness()
    h.c.verifyGoogleIdToken_ = () => ({ email: 'stranger@example.com' })
    expect(h.post({ action: 'exchangeIdToken', idToken: 'x', nonceSecret: 'y' }).result).toEqual({ memberId: null, email: 'stranger@example.com', orgName: 'テスト団体' })
  })
})

describe('レジストリに登録した時のメッセージ', () => {
  it('レジストリに確かめてサイトの URL が分かれば、完全な招待リンクを出す。分からなければ作り方を出す', () => {
    const h = guardHarness()
    h.c.refreshContractState_ = () => { h.props.CONTRACT_STATE = CHECKED; return JSON.parse(CHECKED) }
    expect((h.c.setupInviteLinkText_ as (id: string) => string)(ORG)).toContain('招待リンク: ' + LINK)
    const u = guardHarness()
    u.c.refreshContractState_ = () => null
    expect((u.c.setupInviteLinkText_ as (id: string) => string)(ORG)).toContain('Ohsumi のサイトの URL の後ろに /?org=' + ORG)
  })
})
