// 通知・カレンダー・Discord・メールの言語の不具合の再現と、直したことの確かめ(GAS)
//   1. まとめて送る設定の人の通知のキュー(notif_queue_<ID>)が、スクリプトプロパティの上限(9KB)を超えて、
//      メンション・返信の通知が落ちる(同じコメントのほかの宛先も飛ばされる)
//   2. 承認待ちのタスクでも、カレンダーの招待をすぐ送る
//   3. 期限超過の Discord の投稿が2000文字を超え、投稿ごと消える
//   4. 退会でタスクの担当から外しても、カレンダーの予定・行の版が変わらない
//   5. 1回の createTasks で作った3件目からのタスクの予定の ID が保存されない
//   6. アドレスを2つ持つメンバーに、違う言語のメールが届く・予定のゲストを付けられない
//   ほか: 期限超過の催促メールに確認待ち・承認待ちのタスクが入る / 日報の日付が Date のまま返る
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { guardHarness, noop } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
type Fn = (...a: unknown[]) => unknown
const fn = (h: H, name: string) => h.c[name] as Fn

const PROP_MAX_BYTES = 9 * 1024
// スクリプトプロパティの1つの値の上限(9KB)を、本物と同じく超えたら投げるようにする
function limitProps(h: H, failKey?: string) {
  const orig = (h.c.PropertiesService as { getScriptProperties: () => Record<string, Fn> }).getScriptProperties
  h.c.PropertiesService = {
    getScriptProperties: () => {
      const p = orig()
      return {
        ...p,
        setProperty: (k: string, v: string) => {
          if (k === failKey) throw new Error('Exception: このキーには書けません')
          if (Buffer.byteLength(String(v), 'utf8') > PROP_MAX_BYTES) throw new Error('Exception: Argument too large: value')
          return p.setProperty(k, v)
        },
      }
    },
  }
}
const setMember = (h: H, id: string, col: string, value: string) => {
  const rows = h.sheets.Members.rows
  rows.find((r) => r[0] === id)![rows[0].indexOf(col)] = value
}
const comment = (h: H, token: string, comments: unknown[]) => h.post({ action: 'updateComments', sessionToken: token, taskId: 't1', comments })
const OLD = { id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }
const longText = (who: string) => '@' + who + ' ' + 'あ'.repeat(990)

describe('1. 通知のキューの大きさ', () => {
  it('まとめて送る設定の人に長いメンションが2件来ても、2件目を落とさず、同じコメントのほかの宛先にも届く', () => {
    const h = guardHarness()
    limitProps(h)
    setMember(h, 'm-lead', 'notify_settings', JSON.stringify({ mention: '3h' }))
    setMember(h, 'm-other', 'notify_settings', JSON.stringify({ mention: '3h' }))
    const c1 = { id: 'c-1', byId: 'm-base', text: longText('班長'), at: '2026-10-01T00:00:00Z' }
    expect(comment(h, 'm-base', [OLD, c1]).ok).toBe(true)
    // 2件目: 班長(キューに1件ある)と他人の両方をメンションする
    const c2 = { id: 'c-2', byId: 'm-base', text: '@班長 @他人 ' + 'い'.repeat(990), at: '2026-10-01T01:00:00Z' }
    const res = comment(h, 'm-base', [OLD, c1, c2])
    expect(res.ok, res.error).toBe(true)
    const lead = JSON.parse(h.props['notif_queue_m-lead'])
    const other = JSON.parse(h.props['notif_queue_m-other'])
    expect(lead).toHaveLength(2)
    expect(other).toHaveLength(1)
    // 受け取る人の言語の文だけを入れる
    expect(Object.keys(lead[0].templates)).toEqual(['ja'])
  })

  it('キューは 8KB までに抑え、入りきらない分は件数を数えて、まとめのメールに「ほか N 件」と書く', () => {
    const h = guardHarness()
    limitProps(h)
    setMember(h, 'm-lead', 'notify_settings', JSON.stringify({ mention: '3h' }))
    const tpl = { ja: { subject: '件名', body: 'う'.repeat(1000) }, en: { subject: 'S', body: 'x'.repeat(1000) } }
    for (let i = 0; i < 30; i++) fn(h, 'queueNotification_')('m-lead', 'mention', tpl)
    const raw = h.props['notif_queue_m-lead']
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(8000)
    const queue = JSON.parse(raw) as { more?: number; ts: string }[]
    const more = queue.reduce((n, q) => n + (q.more || 0), 0)
    expect(queue.length + more).toBe(30)
    // 時間がたったものを、まとめて送る
    queue.forEach((q) => { q.ts = '2026-01-01T00:00:00.000Z' })
    h.props['notif_queue_m-lead'] = JSON.stringify(queue)
    fn(h, 'sendBatchNotificationsUnrecorded_')()
    const mail = h.sent.find((s) => s.kind === 'mail' && s.to === 'lead@example.com')!
    expect(mail.text).toContain('ほか ' + more + ' 件')
    expect(mail.text).toContain('(30件)')
    expect(h.props['notif_queue_m-lead']).toBeUndefined()
  })

  it('1人のキューに書けなくても、同じコメントのほかの宛先には届け、画面に notifyLimited を返す', () => {
    const h = guardHarness()
    limitProps(h, 'notif_queue_m-lead')
    setMember(h, 'm-lead', 'notify_settings', JSON.stringify({ mention: '3h' }))
    setMember(h, 'm-other', 'notify_settings', JSON.stringify({ mention: '3h' }))
    const res = comment(h, 'm-base', [OLD, { id: 'c-1', byId: 'm-base', text: '@班長 @他人 見てください', at: '2026-10-01T00:00:00Z' }])
    expect(res.ok, res.error).toBe(true)
    expect(res.notifyLimited).toBe(true)
    expect(JSON.parse(h.props['notif_queue_m-other'])).toHaveLength(1)
  })
})

// ---- カレンダー(gas-calendar-sync.test.ts と同じ偽のカレンダー) ----
type Ev = { id: string; title: string; allDay: boolean; start: Date; end: Date; guests: string[]; tags: Record<string, string>; deleted: boolean; sendInvites: boolean }
function calendarSetup() {
  const h = guardHarness({ realCalendar: true })
  const rows = h.sheets.Tasks.rows
  rows[0].push('calendar_event_id', 'due_time', 'row_version', 'row_updated_by')
  for (const r of rows.slice(1)) r.push('', '', 'r0', '')
  const col = (name: string) => rows[0].indexOf(name)
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
    getDescription: () => '',
    getGuestList: () => e.guests.map((g) => ({ getEmail: () => g })),
    // 本物の addGuest は1つのアドレスだけを受け付ける
    addGuest: (g: string) => { if (g.includes(',')) throw new Error('Invalid argument: guest'); e.guests.push(g) },
    removeGuest: (g: string) => { e.guests = e.guests.filter((x) => x !== g) },
    guestsCanSeeGuests: () => false,
    getTag: (k: string) => e.tags[k] ?? null,
    setTag: (k: string, v: string) => { e.tags[k] = v },
    deleteEvent: () => { e.deleted = true },
  })
  const make = (title: string, start: Date, end: Date, allDay: boolean, o: { guests?: string; sendInvites?: boolean } = {}) => {
    const e: Ev = { id: 'ev' + ++n, title, allDay, start, end, guests: o.guests ? o.guests.split(',') : [], tags: {}, deleted: false, sendInvites: !!o.sendInvites }
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
  return { h, events, live, get }
}
const ok = (h: H, token: string, body: Record<string, unknown>) => {
  const res = h.post({ sessionToken: token, ...body })
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return res
}
const newTask = (title: string, assigneeIds: string[], extra: Record<string, unknown> = {}) => ({
  tempId: 'tmp-' + title, title, projectId: 'p1', department: '', category: '', skills: [], difficulty: 'normal', priority: 'medium',
  deadline: '2026-10-20', assigneeIds, ...extra,
})

describe('2. 承認待ちのタスクのカレンダー', () => {
  it('一般のメンバーが作った承認待ちのタスクは、招待を送らない。承認した時に予定を作る', () => {
    const t = calendarSetup()
    const res = ok(t.h, 'm-base', { action: 'createTasks', tasks: [newTask('承認待ち', ['m-base'])] })
    const id = res.result[0].id
    expect(t.events).toHaveLength(0)
    ok(t.h, 'm-top', { action: 'approveTask', taskId: id })
    expect(t.live()).toHaveLength(1)
    expect(t.live()[0]).toMatchObject({ guests: ['base@example.com'], sendInvites: true, tags: { ohsumiTaskId: id } })
    expect(t.get(id, 'calendar_event_id')).toBe(t.live()[0].id)
  })

  it('承認しなかった(却下した)タスクは、何も送らない', () => {
    const t = calendarSetup()
    const res = ok(t.h, 'm-base', { action: 'createTasks', tasks: [newTask('却下される', ['m-base'])] })
    ok(t.h, 'm-top', { action: 'rejectTask', taskId: res.result[0].id, reason: '重複' })
    expect(t.events).toHaveLength(0)
  })
})

describe('5. 1回の createTasks で作ったタスクの予定の ID', () => {
  it('3件以上作っても、すべてのタスクに予定の ID を保存する', () => {
    const t = calendarSetup()
    const res = ok(t.h, 'm-top', { action: 'createTasks', tasks: ['A', 'B', 'C', 'D'].map((x) => newTask(x, ['m-base'], { pendingApproval: false })) })
    expect(t.live()).toHaveLength(4)
    for (const r of res.result as { id: string }[]) {
      const ev = t.live().find((e) => e.tags.ohsumiTaskId === r.id)!
      expect(t.get(r.id, 'calendar_event_id')).toBe(ev.id)
    }
  })
})

describe('4. 退会とカレンダー・行の版', () => {
  it('退会したメンバーを担当から外すと、予定のゲストを外し(担当が居なくなれば消し)、行の版を新しくする', () => {
    const t = calendarSetup()
    ok(t.h, 'm-top', { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    expect(t.live()).toHaveLength(1)
    const before = t.get('t1', 'row_version')
    ok(t.h, 'm-top', { action: 'removeMember', memberId: 'm-base' })
    expect(t.get('t1', 'assignee_id')).toBe('')
    expect(t.live()).toHaveLength(0)
    expect(t.get('t1', 'row_version')).not.toBe(before)
  })

  it('ほかの担当者が残る時は、予定を残してゲストだけ外す', () => {
    const t = calendarSetup()
    ok(t.h, 'm-top', { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    ok(t.h, 'm-top', { action: 'assignTask', taskId: 't1', assigneeIds: ['m-base', 'm-other'] })
    ok(t.h, 'm-top', { action: 'removeMember', memberId: 'm-base' })
    expect(t.get('t1', 'assignee_id')).toBe('m-other')
    expect(t.live()).toHaveLength(1)
    expect(t.live()[0].guests).toEqual(['other@example.com'])
  })
})

describe('6. アドレスを2つ持つメンバー', () => {
  const twoAddresses = (h: H, id: string, emails: string) => {
    h.sheets.MemberEmails.rows.find((r) => r[0] === id)![1] = emails
  }
  it('英語のメンバーへのメンションのメールは、英語で送る', () => {
    const h = guardHarness()
    twoAddresses(h, 'm-other', 'other@example.com, other2@example.com')
    setMember(h, 'm-other', 'locale', 'en')
    expect(comment(h, 'm-base', [OLD, { id: 'c-1', byId: 'm-base', text: '@他人 見てください', at: '2026-10-01T00:00:00Z' }]).ok).toBe(true)
    const mails = h.sent.filter((s) => s.kind === 'mail' && s.to.includes('other@example.com'))
    expect(mails).toHaveLength(1)
    expect(mails[0].text).toContain('You were mentioned')
  })

  it('まとめて送る設定の英語のメンバーにも、英語の文で貯める', () => {
    const h = guardHarness()
    twoAddresses(h, 'm-other', 'other@example.com,other2@example.com')
    setMember(h, 'm-other', 'locale', 'en')
    setMember(h, 'm-other', 'notify_settings', JSON.stringify({ mention: '3h' }))
    expect(comment(h, 'm-base', [OLD, { id: 'c-1', byId: 'm-base', text: '@他人 見てください', at: '2026-10-01T00:00:00Z' }]).ok).toBe(true)
    const queue = JSON.parse(h.props['notif_queue_m-other'])
    expect(Object.keys(queue[0].templates)).toEqual(['en'])
  })

  it('予定を書き換える時も、ゲストは1つずつのアドレスにする', () => {
    const t = calendarSetup()
    twoAddresses(t.h, 'm-base', 'base@example.com,base2@example.com')
    ok(t.h, 'm-top', { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-20' })
    // 今ある予定に担当者を足す(2つのアドレスの人は、そのまま残す)
    ok(t.h, 'm-top', { action: 'assignTask', taskId: 't1', assigneeIds: ['m-base', 'm-other'] })
    expect(t.live()).toHaveLength(1)
    expect(t.live()[0].guests.sort()).toEqual(['base2@example.com', 'base@example.com', 'other@example.com'])
  })
})

describe('3. 期限超過の Discord の投稿', () => {
  it('期限超過のタスクが多くても、1900文字までにして「ほか N 件」と書く', () => {
    const h = guardHarness()
    const rows = h.sheets.Tasks.rows
    const head = rows[0]
    for (let i = 0; i < 120; i++) {
      const r = head.map(() => '' as string)
      r[head.indexOf('id')] = 'o' + i
      r[head.indexOf('title')] = '期限を過ぎたとても長い名前のタスク その' + i
      r[head.indexOf('status')] = 'todo'
      r[head.indexOf('visibility')] = 'all'
      r[head.indexOf('due_date')] = '2026-09-01'
      rows.push(r)
    }
    fn(h, 'notifyOverdueTasksToDiscord_')()
    const chats = h.sent.filter((s) => s.kind === 'chat')
    expect(chats).toHaveLength(1)
    expect(chats[0].text.length).toBeLessThanOrEqual(1900)
    expect(chats[0].text).toContain('期限超過タスクが120件あります')
    expect(chats[0].text).toMatch(/ほか \d+ 件/)
  })
})

describe('期限超過の催促メール', () => {
  it('確認待ち(提出済み)・承認待ちのタスクは催促しない', () => {
    const h = guardHarness()
    const rows = h.sheets.Tasks.rows
    const head = rows[0]
    const add = (id: string, status: string, approval: string) => {
      const r = head.map(() => '' as string)
      r[head.indexOf('id')] = id
      r[head.indexOf('title')] = 'タスク' + id
      r[head.indexOf('status')] = status
      r[head.indexOf('approval_status')] = approval
      r[head.indexOf('assignee_id')] = 'm-other'
      r[head.indexOf('due_date')] = '2026-09-01'
      rows.push(r)
    }
    add('o-review', 'review', 'approved')
    add('o-pending', 'todo', 'pending')
    add('o-todo', 'todo', 'approved')
    fn(h, 'notifyOverdueTasksToAssignees_')()
    const text = h.allSent().filter((s) => s.to === 'other@example.com').map((s) => s.text).join('\n')
    expect(text).toContain('タスクo-todo')
    expect(text).not.toContain('タスクo-review')
    expect(text).not.toContain('タスクo-pending')
  })
})

describe('日報の一覧', () => {
  it('シートが日付(Date)で返した日報の日付も、yyyy-MM-dd の文字列で返す', () => {
    const h = guardHarness()
    const sheet = fn(h, 'ensureDailyReportsSheet_')() as unknown
    expect(sheet).toBeTruthy()
    const rows = h.sheets.DailyReports.rows
    const d = vm.runInContext('new Date(2026, 9, 1)', h.c as vm.Context)
    rows.push(['dr1', 'm-base', 'daily', d, 'やった', 'やる', '', '2026-10-01T09:00:00Z'])
    const list = fn(h, 'fetchDailyReports_')() as { date: unknown }[]
    expect(list[0].date).toBe('2026-10-01')
  })
})
