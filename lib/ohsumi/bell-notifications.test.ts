import { describe, expect, it } from 'vitest'
import { BELL_KINDS, bellEnabled, filterByBellSettings, parseBellSettings } from './bell-kinds'
import { commentNotifications, inviteNotifications, threadComments } from './comment-notifications'
import { mergeNotifications, markNotificationRead, parseNotificationHistory, unreadNotifications, EMPTY_HISTORY } from './notification-history'
import { parseNotifySettings } from './remote'
import type { NotificationItem, Task, TaskComment } from './types'

const NOW = new Date('2026-10-06T12:00:00Z')
const text = {
  mention: (n: string) => `mention ${n}`,
  reply: (who: string, n: string) => `reply ${who} ${n}`,
  mentionFollow: (who: string, n: string) => `follow ${who} ${n}`,
  mentionFollowDetail: (s: string) => `maybe ${s}`,
}
const nameOf = (id: string) => id.toUpperCase()
const c = (id: string, byId: string, at: string, extra: Partial<TaskComment> = {}): TaskComment => ({ id, byId, at, text: `${id} text`, ...extra })
const task = (comments: TaskComment[], extra: Partial<Task> = {}) => ({ id: 't1', name: 'タスク', comments, status: 'progress', ...extra }) as unknown as Task

describe('ベルの通知の種類のオン・オフ', () => {
  it('既定はすべてオン。保存した値は知らない種類・真偽値でない値を捨てて読む', () => {
    for (const k of BELL_KINDS) expect(bellEnabled(undefined, k)).toBe(true)
    expect(parseBellSettings({ mention: false, magic: false, review: 'no', invite: true })).toEqual({ mention: false, invite: true })
    expect(parseBellSettings('x')).toEqual({})
  })

  it('オフにした種類だけ外し、種類の無い通知(団体からのお知らせ)は出す', () => {
    const items = [{ bell: 'staleProgress' }, { bell: 'mention' }, {}] as Pick<NotificationItem, 'bell'>[]
    expect(filterByBellSettings(items, { staleProgress: false })).toEqual([{ bell: 'mention' }, {}])
  })

  it('メールの頻度とベルのオン・オフは、同じ本人の設定に別のキーで入る', () => {
    expect(parseNotifySettings(JSON.stringify({ mention: '3h', review: 'bogus', bell: { mention: false, x: true } }))).toEqual({ mention: '3h', bell: { mention: false } })
    expect(parseNotifySettings(JSON.stringify({ deadline: 'none' }))).toEqual({ deadline: 'none' })
  })
})

describe('まとめた通知: 件数が増えたら未読に戻す', () => {
  const summary = (count: number): NotificationItem => ({ id: 'stale-summary-progress', kind: 'stale', bell: 'staleProgress', count, title: `${count}件`, detail: 'd', taskId: '', adminList: 'stale' })
  it('既読の後、件数が増えると未読、減っても既読のまま', () => {
    let h = mergeNotifications(EMPTY_HISTORY, [summary(3)], NOW)
    h = markNotificationRead(h, 'stale-summary-progress', NOW)
    expect(unreadNotifications(h, [summary(3)])).toEqual([])
    const fewer = mergeNotifications(h, [summary(2)], NOW)
    expect(unreadNotifications(fewer, [summary(2)])).toEqual([])
    const more = mergeNotifications(fewer, [summary(5)], NOW)
    expect(unreadNotifications(more, [summary(5)]).map((n) => n.id)).toEqual(['stale-summary-progress'])
    // 保存して読み直しても、件数・開く先・種類が残る
    const rec = parseNotificationHistory(JSON.stringify(more)).items[0]
    expect(rec).toMatchObject({ count: 5, adminList: 'stale', bell: 'staleProgress' })
  })
})

describe('コメントの通知(メンション・返信・メンションした相手のコメント)', () => {
  it('自分のコメントへの返信と、自分がメンションされたコメントへの返信を知らせる(返信した本人を除く)', () => {
    const t = task([
      c('a', 'me', '2026-10-01T00:00:00Z'),
      c('b', 'x', '2026-10-01T01:00:00Z', { replyToId: 'a' }),
      c('m', 'y', '2026-10-02T00:00:00Z', { mentionedIds: ['me'] }),
      c('r', 'z', '2026-10-02T01:00:00Z', { replyToId: 'm' }),
      c('self', 'me', '2026-10-02T02:00:00Z', { replyToId: 'm' }),
    ])
    const ids = commentNotifications([t], 'me', nameOf, text, NOW).map((n) => `${n.id}:${n.kind}:${n.bell}`)
    expect(ids).toEqual(['reply-b:reply:mention', 'mention-m:mention:mention', 'reply-r:reply:mention'])
  })

  it('メンションした相手が、その後そのタスクに初めて書いたコメントを知らせる(2件目以降・メンション前は知らせない)', () => {
    const t = task([
      c('before', 'b', '2026-10-01T00:00:00Z'),
      c('ask', 'me', '2026-10-01T01:00:00Z', { mentionedIds: ['b'] }),
      c('ans1', 'b', '2026-10-01T02:00:00Z'),
      c('ans2', 'b', '2026-10-01T03:00:00Z'),
    ])
    const n = commentNotifications([t], 'me', nameOf, text, NOW)
    expect(n.map((x) => x.id)).toEqual(['mention-follow-ans1'])
    expect(n[0]).toMatchObject({ title: 'follow B タスク', commentId: 'ans1', taskId: 't1', bell: 'mention' })
  })

  it('返信を使った返事は返信として1件だけ(メンションした相手のコメントと重ねない)', () => {
    const t = task([
      c('ask', 'me', '2026-10-01T01:00:00Z', { mentionedIds: ['b'] }),
      c('ans', 'b', '2026-10-01T02:00:00Z', { replyToId: 'ask' }),
    ])
    expect(commentNotifications([t], 'me', nameOf, text, NOW).map((x) => x.id)).toEqual(['reply-ans'])
  })

  it('60日より前のコメントからは作らない', () => {
    const t = task([c('old', 'x', '2026-07-01T00:00:00Z', { mentionedIds: ['me'] })])
    expect(commentNotifications([t], 'me', nameOf, text, NOW)).toEqual([])
  })

  it('返信の並び: 元のコメントの下に時刻の順。返信への返信も、いちばん上の下に並ぶ。元が無い返信はふつうのコメント', () => {
    const list = [
      c('a', 'x', '2026-10-01T00:00:00Z'),
      c('a2', 'y', '2026-10-01T03:00:00Z', { replyToId: 'a' }),
      c('a1', 'y', '2026-10-01T02:00:00Z', { replyToId: 'a' }),
      c('a1x', 'z', '2026-10-01T04:00:00Z', { replyToId: 'a1' }),
      c('orphan', 'z', '2026-10-01T05:00:00Z', { replyToId: 'gone' }),
      c('loop', 'z', '2026-10-01T06:00:00Z', { replyToId: 'loop' }),
    ]
    expect(threadComments(list).map((x) => [x.comment.id, x.replies.map((r) => r.id)])).toEqual([
      ['a', ['a1', 'a2', 'a1x']],
      ['orphan', []],
      ['loop', []],
    ])
  })
})

describe('日程調整・フォームの招待', () => {
  it('招待されていて、まだ答えていない未完了のタスクだけ', () => {
    const tt = (id: string, extra: Partial<Task>) => ({ id, name: id, status: 'progress', ...extra }) as unknown as Task
    const tasks = [
      tt('s1', { schedule: { candidates: [], invitedIds: ['me'], responses: {} } }),
      tt('s2', { schedule: { candidates: [], invitedIds: ['me'], responses: { me: { c1: 'ok' } } } as never }),
      tt('f1', { form: { fields: [], invitedIds: ['me', 'x'], responses: { x: { a: '1' } } } }),
      tt('f2', { status: 'done', form: { fields: [], invitedIds: ['me'], responses: {} } }),
      tt('f3', { form: { fields: [], invitedIds: ['x'], responses: {} } }),
    ]
    const n = inviteNotifications(tasks, 'me', { schedule: (n) => `s ${n}`, form: (n) => `f ${n}`, detail: 'd' })
    expect(n.map((x) => `${x.id}:${x.bell}`)).toEqual(['invite-schedule-s1:invite', 'invite-form-f1:invite'])
  })
})
