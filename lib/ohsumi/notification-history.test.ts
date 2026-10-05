import { describe, expect, it } from 'vitest'
import {
  EMPTY_HISTORY, markAllNotificationsRead, markNotificationRead, mergeNotifications, migrateDismissed,
  notificationState, parseNotificationHistory, unreadNotifications,
} from './notification-history'
import type { NotificationItem } from './types'

const n = (id: string, title = id): NotificationItem => ({ id, kind: 'review', title, detail: '詳細', taskId: 't-' + id })
const T0 = new Date('2026-10-01T00:00:00Z')
const later = (days: number) => new Date(T0.getTime() + days * 86400000)

describe('通知の履歴', () => {
  it('初めて出た時に記録し、消えたら対応済み、また出たら未読に戻す', () => {
    let h = mergeNotifications(EMPTY_HISTORY, [n('a'), n('b')], T0)
    expect(h.items.map((i) => [i.id, i.at, notificationState(i)])).toEqual([['a', T0.toISOString(), 'unread'], ['b', T0.toISOString(), 'unread']])
    expect(h.items[0]).toMatchObject({ kind: 'review', title: 'a', detail: '詳細', taskId: 't-a' })
    h = markNotificationRead(h, 'a', later(1))
    expect(unreadNotifications(h, [n('a'), n('b')]).map((x) => x.id)).toEqual(['b'])
    h = mergeNotifications(h, [n('b')], later(2))
    expect(notificationState(h.items.find((i) => i.id === 'a')!)).toBe('resolved')
    h = mergeNotifications(h, [n('a'), n('b')], later(3))
    const a = h.items.find((i) => i.id === 'a')!
    expect([notificationState(a), a.at]).toEqual(['unread', later(3).toISOString()])
  })

  it('変わらなければ同じものを返す(保存し直さない)。文面が変われば新しくする', () => {
    const h = mergeNotifications(EMPTY_HISTORY, [n('a')], T0)
    expect(mergeNotifications(h, [n('a')], later(1))).toBe(h)
    expect(mergeNotifications(h, [n('a', '新しい文面')], later(1)).items[0].title).toBe('新しい文面')
  })

  it('すべて既読にする(対応済みは変えない)', () => {
    let h = mergeNotifications(EMPTY_HISTORY, [n('a'), n('b')], T0)
    h = mergeNotifications(h, [n('a')], later(1))
    h = markAllNotificationsRead(h, later(2))
    expect(h.items.map((i) => notificationState(i)).sort()).toEqual(['read', 'resolved'])
    expect(markAllNotificationsRead(h, later(3))).toBe(h)
  })

  it('90日を過ぎたもの・200件を超えたものは消す', () => {
    let h = mergeNotifications(EMPTY_HISTORY, [n('old')], T0)
    h = mergeNotifications(h, [n('old'), n('new')], later(89))
    h = mergeNotifications(h, [n('old'), n('new')], later(91))
    expect(h.items.map((i) => i.id)).toEqual(['new'])
    const many = Array.from({ length: 250 }, (_, i) => n('x' + i))
    expect(mergeNotifications(EMPTY_HISTORY, many, T0).items).toHaveLength(200)
  })

  it('これまでの「消す」を既読にする', () => {
    const h = migrateDismissed(EMPTY_HISTORY, ['a', 'gone'], [n('a'), n('b')], T0)
    expect(h.items.map((i) => [i.id, notificationState(i)])).toEqual([['a', 'read'], ['b', 'unread']])
  })

  it('壊れた保存は捨てる', () => {
    expect(parseNotificationHistory('not json').items).toEqual([])
    expect(parseNotificationHistory({ items: [null, { id: 1 }, { id: 'a', at: 'x', title: 't'.repeat(500), kind: 'mention' }] }).items)
      .toEqual([{ id: 'a', at: 'x', kind: 'mention', title: 't'.repeat(200), detail: '', taskId: '' }])
  })
})
