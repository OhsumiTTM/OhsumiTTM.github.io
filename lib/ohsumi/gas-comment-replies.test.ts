// コメントへの返信と、メンションした相手のコメントの通知(GAS)。コメントの値の確かめ・ベルの通知の設定の確かめ
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const OLD = { id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }
// タスク t1 に、前からあるコメントを入れておく(ほかの人が書いたもの)
const seed = (h: H, comments: unknown[]) => {
  const head = h.sheets.Tasks.rows[0]
  h.sheets.Tasks.rows[1][head.indexOf('comments_json')] = JSON.stringify(comments)
  return h
}
const comment = (h: H, token: string, comments: unknown[]) => h.post({ action: 'updateComments', sessionToken: token, taskId: 't1', comments })
const mailsTo = (h: H) => h.sent.filter((s) => s.kind === 'mail').map((s) => s.to)
const mailText = (h: H, to: string) => h.sent.filter((s) => s.kind === 'mail' && s.to === to).map((s) => s.text).join('\n')

describe('返信の通知', () => {
  it('返信すると、元のコメントを書いた人にメールで知らせる(返信した本人には送らない)', () => {
    const h = guardHarness()
    const res = comment(h, 'm-base', [OLD, { id: 'c-r', byId: 'm-base', text: '対応しました', at: '2026-10-01T00:00:00Z', replyToId: 'c-old' }])
    expect(res.ok, res.error).toBe(true)
    expect(mailsTo(h)).toEqual(['lead@example.com'])
    expect(mailText(h, 'lead@example.com')).toContain('一般さんが返信しました')
    expect(mailText(h, 'lead@example.com')).toContain('対応しました')
    // 返信の元は保存される
    expect(h.sheets.Tasks.rows[1].join()).toContain('"replyToId":"c-old"')
  })

  it('元のコメントでメンションされていた人にも知らせる', () => {
    const ask = { id: 'c-ask', byId: 'm-lead', text: '@他人 @一般 見てください', at: '2026-09-02T00:00:00Z' }
    const h = seed(guardHarness(), [OLD, ask])
    const res = comment(h, 'm-base', [OLD, ask, { id: 'c-r', byId: 'm-base', text: '見ました', at: '2026-10-01T00:00:00Z', replyToId: 'c-ask' }])
    expect(res.ok, res.error).toBe(true)
    expect(mailsTo(h).sort()).toEqual(['lead@example.com', 'other@example.com'])
  })

  it('返信でメンションした人には、メンションの通知だけ(2通にしない)', () => {
    const h = guardHarness()
    const res = comment(h, 'm-base', [OLD, { id: 'c-r', byId: 'm-base', text: '@班長 対応しました', at: '2026-10-01T00:00:00Z', replyToId: 'c-old' }])
    expect(res.ok, res.error).toBe(true)
    expect(mailsTo(h)).toEqual(['lead@example.com'])
    expect(mailText(h, 'lead@example.com')).toContain('メンションされました')
  })

  it('メールの頻度は、本人の「メンション」の設定に従う(なしなら送らない)', () => {
    const h = guardHarness()
    const head = h.sheets.Members.rows[0]
    h.sheets.Members.rows.find((r) => r[0] === 'm-lead')![head.indexOf('notify_settings')] = JSON.stringify({ mention: 'none' })
    expect(comment(h, 'm-base', [OLD, { id: 'c-r', byId: 'm-base', text: '対応しました', at: '2026-10-01T00:00:00Z', replyToId: 'c-old' }]).ok).toBe(true)
    expect(mailsTo(h)).toEqual([])
  })
})

describe('メンションした相手のコメント(返信を使わなかった返事)', () => {
  const ask = { id: 'c-ask', byId: 'm-lead', text: '@一般 見てください', at: '2026-09-02T00:00:00Z' }
  it('メンションされた人が、その後そのタスクに初めて書いたコメントを、メンションした人に知らせる', () => {
    const h = seed(guardHarness(), [OLD, ask])
    const first = { id: 'c-1', byId: 'm-base', text: '見ておきます', at: '2026-10-01T00:00:00Z' }
    expect(comment(h, 'm-base', [OLD, ask, first]).ok).toBe(true)
    expect(mailsTo(h)).toEqual(['lead@example.com'])
    expect(mailText(h, 'lead@example.com')).toContain('一般さんがコメントしました(あなたのメンションへの返事かもしれません)')
    // 2件目からは知らせない
    const again = seed(guardHarness(), [OLD, ask, first])
    expect(comment(again, 'm-base', [OLD, ask, first, { id: 'c-2', byId: 'm-base', text: '終わりました', at: '2026-10-02T00:00:00Z' }]).ok).toBe(true)
    expect(mailsTo(again)).toEqual([])
  })
})

describe('コメントの値の確かめ', () => {
  it('おかしな新しいコメントは断り、保存しない', () => {
    const bad = [
      { id: 'c-x', byId: 'm-base', text: '返信', replyToId: 'gone' },
      { id: 'c-x', byId: 'm-base', text: '自分への返信', replyToId: 'c-x' },
      { id: 'c-x', byId: 'm-base', text: '   ' },
      { id: 'c-x', byId: 'm-base', text: 42 },
      { id: 'c-x', byId: 'm-base', text: 'a', mentionedIds: 'm-lead' },
      { id: 'c-x', byId: 'm-base', text: 'a', mentionedIds: [1] },
    ]
    for (const c of bad) {
      const h = guardHarness()
      const before = h.sheets.Tasks.rows[1].join()
      expect(comment(h, 'm-base', [OLD, c]).ok, JSON.stringify(c)).toBe(false)
      expect(h.sheets.Tasks.rows[1].join()).toBe(before)
    }
  })

  it('返信の元が今あるコメントでも、同じ保存で足したコメントでもよい。古いコメント(返信なし)はそのまま', () => {
    const h = guardHarness()
    expect(comment(h, 'm-base', [OLD, { id: 'c-a', byId: 'm-base', text: 'A' }, { id: 'c-b', byId: 'm-base', text: 'B', replyToId: 'c-a' }]).ok).toBe(true)
  })
})

describe('ベルの通知の設定(本人の notify_settings.bell)', () => {
  const put = (h: H, settings: unknown) => h.post({ action: 'updateNotifySettings', sessionToken: 'm-base', memberId: 'm-base', settings })
  it('知っている種類の true / false を、メールの頻度と一緒に保存する', () => {
    const h = guardHarness()
    const res = put(h, { mention: 'immediate', bell: { staleProgress: false, mention: true, invite: false } })
    expect(res.ok, res.error).toBe(true)
    const head = h.sheets.Members.rows[0]
    const saved = JSON.parse(String(h.sheets.Members.rows.find((r) => r[0] === 'm-base')![head.indexOf('notify_settings')]))
    expect(saved).toEqual({ mention: 'immediate', bell: { staleProgress: false, mention: true, invite: false } })
  })

  it('知らない種類・真偽値でない値・形の違うものは断る', () => {
    for (const bell of [{ magic: false }, { mention: 'off' }, [false], 'x']) {
      expect(put(guardHarness(), { bell }).ok, JSON.stringify(bell)).toBe(false)
    }
  })
})
