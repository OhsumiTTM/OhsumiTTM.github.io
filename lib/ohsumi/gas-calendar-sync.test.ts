// カレンダーの予定(syncCalendarForTask_): 予定にタスクの ID を記録し、そのタスクの予定だけを作り直さずに書き換える。
//   - 招待(sendInvites)は作った時の1回だけ。期限・担当者・名前を変えても、同じ予定を書き換える
//   - 期限を変えても前の日の予定が残らない。同じ名前の別のタスクの予定は消さない
//   - 完了・削除・担当を外した時に予定を消す。ゲストどうしは互いのメールアドレスを見られない
import { describe, expect, it } from 'vitest'
import { guardHarness, noop } from './gas-guard-harness'

type Ev = {
  id: string; title: string; allDay: boolean; start: Date; end: Date; guests: string[]; tags: Record<string, string>
  deleted: boolean; canSee: boolean; sendInvites: boolean; description: string
}

function setup() {
  const h = guardHarness({ realCalendar: true })
  // 予定の ID を書く列を足す(setupOhsumi の後のシート)
  const rows = h.sheets.Tasks.rows
  rows[0].push('calendar_event_id', 'due_time')
  for (const r of rows.slice(1)) r.push('', '')
  const col = (name: string) => rows[0].indexOf(name)
  const set = (taskId: string, name: string, value: string) => { rows.find((r) => r[0] === taskId)![col(name)] = value }
  const get = (taskId: string, name: string) => String(rows.find((r) => r[0] === taskId)![col(name)])

  const events: Ev[] = []
  let n = 0
  const wrap = (e: Ev) => noop({
    getId: () => e.id,
    getTitle: () => e.title,
    setTitle: (t: string) => { e.title = t },
    isAllDayEvent: () => e.allDay,
    getStartTime: () => e.start,
    getEndTime: () => e.end,
    getAllDayStartDate: () => e.start,
    setTime: (s: Date, en: Date) => { e.allDay = false; e.start = s; e.end = en },
    setAllDayDate: (d: Date) => { e.allDay = true; e.start = d; e.end = new Date(d.getTime() + 86400000) },
    getDescription: () => e.description,
    setDescription: (d: string) => { e.description = d },
    getGuestList: () => e.guests.map((g) => ({ getEmail: () => g })),
    addGuest: (g: string) => { e.guests.push(g) },
    removeGuest: (g: string) => { e.guests = e.guests.filter((x) => x !== g) },
    guestsCanSeeGuests: () => e.canSee,
    setGuestsCanSeeGuests: (v: boolean) => { e.canSee = v },
    getTag: (k: string) => e.tags[k] ?? null,
    setTag: (k: string, v: string) => { e.tags[k] = v },
    deleteEvent: () => { e.deleted = true },
  })
  const make = (title: string, start: Date, end: Date, allDay: boolean, o: { guests?: string; sendInvites?: boolean; description?: string } = {}) => {
    const e: Ev = { id: 'ev' + ++n, title, allDay, start, end, guests: o.guests ? o.guests.split(',') : [], tags: {}, deleted: false,
      canSee: true, sendInvites: !!o.sendInvites, description: o.description ?? '' }
    events.push(e)
    return wrap(e)
  }
  h.c.CalendarApp = noop({
    getDefaultCalendar: () => noop({
      createEvent: (t: string, s: Date, e: Date, o: object) => make(t, s, e, false, o),
      createAllDayEvent: (t: string, d: Date, o: object) => make(t, d, new Date(d.getTime() + 86400000), true, o),
      getEventById: (id: string) => { const e = events.find((x) => x.id === id && !x.deleted); return e ? wrap(e) : null },
      getEvents: (s: Date, en: Date) => events.filter((e) => !e.deleted && e.start < en && e.end > s).map(wrap),
    }),
  })
  const live = () => events.filter((e) => !e.deleted)
  const day = (d: string) => new Date(d + 'T00:00:00').getTime()
  return { h, events, live, set, get, day, make }
}

const top = (h: ReturnType<typeof guardHarness>, body: Record<string, unknown>) => {
  const res = h.post({ sessionToken: 'm-top', ...body })
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return res
}

describe('カレンダーの予定をタスクの ID で扱う', () => {
  it('期限を入れると予定を1つ作り(招待はこの1回)、ID を記録する。ゲストどうしは互いを見られない', () => {
    const t = setup()
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    expect(t.live()).toHaveLength(1)
    const ev = t.live()[0]
    expect(ev).toMatchObject({ title: '[Ohsumi] タスク1', allDay: true, guests: ['base@example.com'], sendInvites: true, canSee: false, tags: { ohsumiTaskId: 't1' } })
    expect(t.get('t1', 'calendar_event_id')).toBe(ev.id)
  })

  it('期限・担当者を変えても作り直さず、同じ予定を動かす(前の日の予定は残らない。招待を送り直さない)', () => {
    const t = setup()
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-25' })
    top(t.h, { action: 'assignTask', taskId: 't1', assigneeIds: ['m-base', 'm-other'] })
    expect(t.events).toHaveLength(1)
    expect(t.live()[0].start.getTime()).toBe(t.day('2026-10-25'))
    expect(t.live()[0].guests).toEqual(['base@example.com', 'other@example.com'])
    top(t.h, { action: 'assignTask', taskId: 't1', assigneeIds: ['m-other'] })
    expect(t.events).toHaveLength(1)
    expect(t.live()[0].guests).toEqual(['other@example.com'])
  })

  it('完了にすると予定を消し、完了から戻すと作り直す。担当を外す・期限を消す・タスクを消すと予定を消す', () => {
    const t = setup()
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    top(t.h, { action: 'updateTaskStatus', taskId: 't1', status: 'done' })
    expect(t.live()).toHaveLength(0)
    expect(t.get('t1', 'calendar_event_id')).toBe('')
    top(t.h, { action: 'updateTaskStatus', taskId: 't1', status: 'progress' })
    expect(t.live()).toHaveLength(1)
    top(t.h, { action: 'assignTask', taskId: 't1', assigneeIds: [] })
    expect(t.live()).toHaveLength(0)
    top(t.h, { action: 'assignTask', taskId: 't1', assigneeIds: ['m-base'] })
    expect(t.live()).toHaveLength(1)
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '' })
    expect(t.live()).toHaveLength(0)
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-21' })
    expect(t.live()).toHaveLength(1)
    ;(t.h.c.removeTask_ as (id: string) => void)('t1')
    expect(t.live()).toHaveLength(0)
  })

  it('同じ名前の別のタスクの予定は消さない', () => {
    const t = setup()
    // 同じ名前・同じ日の、別のタスクの予定
    const other = t.make('[Ohsumi] タスク1', new Date('2026-10-20T00:00:00'), new Date('2026-10-21T00:00:00'), true)
    other.setTag('ohsumiTaskId', 't-other')
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    top(t.h, { action: 'updateTaskStatus', taskId: 't1', status: 'done' })
    expect(t.live().map((e) => e.tags.ohsumiTaskId)).toEqual(['t-other'])
  })

  it('ID の無い以前の予定(同じ日・同じ名前で1つだけ)は、そのタスクの予定として引き継ぎ、期限を変えると動かす', () => {
    const t = setup()
    t.set('t1', 'due_date', '2026-10-20')
    t.make('[Ohsumi] タスク1', new Date('2026-10-20T00:00:00'), new Date('2026-10-21T00:00:00'), true, { guests: 'base@example.com' })
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-22' })
    expect(t.events).toHaveLength(1)
    expect(t.live()[0]).toMatchObject({ tags: { ohsumiTaskId: 't1' }, canSee: false })
    expect(t.live()[0].start.getTime()).toBe(t.day('2026-10-22'))
  })

  it('時刻があれば1時間の予定にし、時刻を消すと終日に戻す', () => {
    const t = setup()
    t.set('t1', 'due_time', '15:00')
    top(t.h, { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    expect(t.live()[0]).toMatchObject({ allDay: false })
    expect(t.live()[0].start.getTime()).toBe(new Date('2026-10-20T15:00:00').getTime())
    t.set('t1', 'due_time', '')
    ;(t.h.c.forgetSheetGrid_ as () => void)()
    ;(t.h.c.syncCalendarForTask_ as (id: string) => void)('t1')
    expect(t.events).toHaveLength(1)
    expect(t.live()[0].allDay).toBe(true)
  })
})
