// 退会者の削除の漏れ(PR L): カレンダーの予定のゲスト・プロフィール画像のファイル。実行ログのメールアドレスを伏せる
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, noop } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)

function fakeCalendar(h: H, events: { title: string; guests: string[] }[]) {
  h.c.CalendarApp = noop({
    getDefaultCalendar: () => noop({
      getEvents: () => events.map((e) => noop({
        getTitle: () => e.title,
        getGuestByEmail: (email: string) => (e.guests.includes(email) ? {} : null),
        removeGuest: (email: string) => { e.guests = e.guests.filter((g) => g !== email) },
      })),
    }),
  })
}
function fakeUploads(h: H, names: string[]) {
  const trashed: string[] = []
  h.props.UPLOAD_FOLDER_ID = 'up'
  h.c.DriveApp = noop({
    getFolderById: () => noop({
      getFiles: () => {
        let i = 0
        return { hasNext: () => i < names.length, next: () => { const name = names[i++]; return noop({ getName: () => name, setTrashed: () => { trashed.push(name) } }) } }
      },
    }),
  })
  return trashed
}

describe('退会者の個人情報を消す時', () => {
  it('カレンダーの [Ohsumi] の予定のゲストから、そのメールアドレスを外す(ほかのゲスト・ほかの予定はそのまま)', () => {
    const h = guardHarness()
    const events = [
      { title: '[Ohsumi] タスク1', guests: ['victim@example.com', 'base@example.com'] },
      { title: '個人の予定', guests: ['victim@example.com'] },
    ]
    fakeCalendar(h, events)
    expect(call(h, 'removeCalendarGuest_', 'victim@example.com', Date.now())).toBe(1)
    expect(events[0].guests).toEqual(['base@example.com'])
    expect(events[1].guests).toEqual(['victim@example.com'])
  })

  it('プロフィール画像のファイル(avatar_<ID>_)だけをゴミ箱に移す', () => {
    const h = guardHarness()
    const trashed = fakeUploads(h, ['avatar_m-victim_1', 'avatar_m-victim-2_1', 'receipt_1', 'avatar_m-victim_2'])
    expect(call(h, 'trashAvatarFiles_', 'm-victim')).toBe(2)
    expect(trashed).toEqual(['avatar_m-victim_1', 'avatar_m-victim_2'])
  })

  it('個人情報の削除(purgeMember_)で、両方を行う', () => {
    const h = guardHarness()
    const events = [{ title: '[Ohsumi] タスク1', guests: ['victim@example.com'] }]
    fakeCalendar(h, events)
    const trashed = fakeUploads(h, ['avatar_m-victim_1'])
    call(h, 'purgeMember_', 'm-victim', Date.now())
    expect(events[0].guests).toEqual([])
    expect(trashed).toEqual(['avatar_m-victim_1'])
  })

  it('カレンダー・ドライブが使えなくても、ほかの削除は済ませる', () => {
    const h = guardHarness()
    h.c.CalendarApp = noop({ getDefaultCalendar: () => { throw new Error('権限がありません') } })
    h.c.DriveApp = noop({ getFolderById: () => { throw new Error('権限がありません') } })
    h.props.UPLOAD_FOLDER_ID = 'up'
    expect(() => call(h, 'purgeMember_', 'm-victim', Date.now())).not.toThrow()
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-victim')).toBe(false)
  })
})

describe('実行ログにメールアドレスを出さない', () => {
  it('先頭の1文字とドメインだけを残して伏せる', () => {
    const h = guardHarness()
    expect(call(h, 'maskEmailsIn_', 'to: taro.yamada@example.co.jp, b@x.org')).toBe('to: t***@example.co.jp, b***@x.org')
  })

  it('通知の宛先・テスト環境の本来の宛先を、伏せて記録する', () => {
    const h = guardHarness()
    const logs: string[] = []
    h.c.console = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }
    h.c.isTestEnvironment_ = () => true
    call(h, 'notifyAdmins_', '件名', '本文', ['secret.person@example.com'], { urgent: true })
    expect(logs.join('\n')).toContain('s***@example.com')
    expect(logs.join('\n')).not.toContain('secret.person@example.com')
  })

  it('console に生のエラー(err)を出す所は、すべて伏せる', () => {
    const raw = CODE_GS.split('\n').filter((l) => /console\.(log|warn|error)\(.*\+ err\)/.test(l) && !l.includes('maskEmailsIn_'))
    expect(raw).toEqual([])
  })
})
