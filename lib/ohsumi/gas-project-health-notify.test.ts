// gas/Code.gs のプロジェクトの健康状態の通知(reportProjectHealth)と、テスト環境の
// メール送信(sendMail)を、メモリ上の簡易なスプレッドシートで確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { selectProjectHealthReports } from './project-health-report'
import type { Project, ProjectHealthLevel } from './types'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

class FakeSheet {
  constructor(public rows: string[][]) {}
  getLastRow() {
    return this.rows.length
  }
  getLastColumn() {
    return this.rows[0]?.length ?? 0
  }
  getDataRange() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn())
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    return {
      getValues: () =>
        Array.from({ length: numRows }, (_, r) =>
          Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? ''),
        ),
      setValue: (v: string) => {
        this.rows[row - 1][col - 1] = v
      },
      setValues: (vs: string[][]) => {
        vs.forEach((line, r) => line.forEach((v, c) => { this.rows[row - 1 + r][col - 1 + c] = v }))
      },
    }
  }
}

type Mail = { to: string; subject: string; body: string; cc?: string }

// projects: [id, name, health_override, last_notified_health]
function setup(projects: string[][], props: Record<string, string> = {}) {
  const sheets: Record<string, FakeSheet> = {
    Projects: new FakeSheet([['id', 'name', 'health_override', 'last_notified_health'], ...projects]),
    Members: new FakeSheet([
      ['id', 'name', 'role', 'notify_new_task', 'locale'],
      ['1', '代表', '代表', '', 'ja'],
      ['2', '一般', '一般', '', 'ja'],
    ]),
    MemberEmails: new FakeSheet([['id', 'email'], ['1', 'boss@example.com'], ['2', 'member@example.com']]),
    Settings: new FakeSheet([['key', 'value']]),
  }
  const allProps: Record<string, string> = {
    DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    ...props,
  }
  const mails: Mail[] = []
  const chats: { url: string; payload: string }[] = []
  const logs: string[] = []
  const events: { title: string; options: Record<string, unknown> }[] = []
  const context = vm.createContext({
    console: { log: (m: string) => logs.push(m), warn: () => undefined, error: (m: string) => logs.push(m) },
    Logger: { log: () => undefined },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => allProps[k] ?? null,
        setProperty: (k: string, v: string) => {
          allProps[k] = v
        },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => sheets[n] ?? null }),
    },
    MailApp: { sendEmail: (m: Mail) => mails.push(m) },
    UrlFetchApp: {
      fetch: (url: string, opts: { payload: string }) => {
        chats.push({ url, payload: opts.payload })
        return { getResponseCode: () => 204 }
      },
    },
    CalendarApp: {
      getDefaultCalendar: () => ({
        getEvents: () => [],
        createEvent: (title: string, _s: Date, _e: Date, options: Record<string, unknown>) => events.push({ title, options }),
        createAllDayEvent: (title: string, _d: Date, options: Record<string, unknown>) => events.push({ title, options }),
      }),
    },
  })
  vm.runInContext(CODE_GS, context)
  // Webhook の URL の保存先(プロパティ名)に依存しないよう差し替える
  context.getDiscordWebhookUrl_ = () => allProps.DISCORD_WEBHOOK_URL
  context.getSlackWebhookUrl_ = () => allProps.SLACK_WEBHOOK_URL
  const gas = context as unknown as {
    reportProjectHealth_: (items: unknown) => { recorded: string[]; notified: string[] }
    notifyProjectHealth_: (id: string, health: string) => unknown
    sendMail_: (m: Mail) => void
    syncCalendarForTask_: (id: string) => void
    buildPerformanceTestData_: (seed?: number) => Record<string, Record<string, string>[]>
  }
  const record = (id: string) => sheets.Projects.rows.find((r) => r[0] === id)?.[3]
  return { gas, sheets, mails, chats, logs, events, record, context }
}

describe('reportProjectHealth', () => {
  it('健康状態が一度も記録されていないプロジェクトは、記録だけして通知しない', () => {
    const projects = Array.from({ length: 20 }, (_, i) => [`perf-p-${i}`, `ダミー${i}`, '', ''])
    const { gas, mails, chats, record } = setup(projects)
    const res = gas.reportProjectHealth_(projects.map(([id]) => ({ projectId: id, health: 'attention' })))
    expect(res.recorded).toHaveLength(20)
    expect(res.notified).toHaveLength(0)
    expect(record('perf-p-0')).toBe('attention')
    expect(mails).toHaveLength(0)
    expect(chats).toHaveLength(0)
    // 2回目(記録済み・状態は変わらない)も通知しない
    gas.reportProjectHealth_(projects.map(([id]) => ({ projectId: id, health: 'attention' })))
    expect(mails).toHaveLength(0)
  })

  it('複数のプロジェクトが同時に悪化した場合、メール・Discord・Slack とも1通にまとめる', () => {
    const { gas, mails, chats, record } = setup([
      ['p1', '初回', '', ''],
      ['p2', '良好から悪化', '', 'good'],
      ['p3', '要注意から悪化', '', 'watch'],
      ['p4', '回復', '', 'attention'],
      ['p5', '手動上書き中', 'good', 'good'],
      ['p6', '良好から要注意', '', 'good'],
      ['p7', '悪化したまま', '', 'attention'],
    ])
    const res = gas.reportProjectHealth_([
      { projectId: 'p1', health: 'attention' },
      { projectId: 'p2', health: 'attention' },
      { projectId: 'p3', health: 'attention' },
      { projectId: 'p4', health: 'good' },
      { projectId: 'p5', health: 'attention' },
      { projectId: 'p6', health: 'watch' },
      { projectId: 'p7', health: 'attention' },
    ])
    expect(res.notified).toEqual(['p2', 'p3'])
    expect(res.recorded).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(record('p4')).toBe('good')
    expect(record('p5')).toBe('good')
    expect(record('p6')).toBe('good')

    expect(mails).toHaveLength(1)
    expect(mails[0].to).toBe('boss@example.com')
    expect(mails[0].subject).toBe('[Ohsumi] 2件のプロジェクトの健康状態が変わりました')
    expect(mails[0].body).toContain('・「良好から悪化」: 要対応')
    expect(mails[0].body).toContain('・「要注意から悪化」: 要対応')
    expect(mails[0].body).not.toContain('初回')

    expect(chats.map((c) => c.url)).toEqual(['https://discord.example/webhook', 'https://hooks.slack.com/services/x'])
    for (const c of chats) {
      const text = JSON.parse(c.payload).content ?? JSON.parse(c.payload).text
      expect(text).toContain('2件のプロジェクトの健康状態が変わりました')
      expect(text).toContain('「良好から悪化」: 要対応')
    }
  })

  it('1件だけの場合は、今までと同じ件名で送る', () => {
    const { gas, mails, chats } = setup([['p1', 'A', '', 'good']])
    gas.reportProjectHealth_([{ projectId: 'p1', health: 'attention' }])
    expect(mails.map((m) => m.subject)).toEqual(['[Ohsumi] プロジェクト「A」の健康状態: 要対応'])
    expect(chats).toHaveLength(2)
  })

  it('チャットに並べるのは20件までで、残りは件数だけ書く', () => {
    const projects = Array.from({ length: 25 }, (_, i) => [`p${i}`, `P${i}`, '', 'good'])
    const { gas, chats, mails } = setup(projects)
    gas.reportProjectHealth_(projects.map(([id]) => ({ projectId: id, health: 'attention' })))
    expect(mails).toHaveLength(1)
    const text = JSON.parse(chats[0].payload).content as string
    expect(text).toContain('ほか 5 件')
    expect(text.length).toBeLessThan(2000)
  })

  it('不正な値は無視し、一覧でないものや多すぎる件数は受け付けない', () => {
    const { gas, record } = setup([['p1', 'A', '', 'good']])
    gas.reportProjectHealth_([{ projectId: 'p1', health: 'broken' }, { projectId: 'zzz', health: 'attention' }, null])
    expect(record('p1')).toBe('good')
    expect(() => gas.reportProjectHealth_('x')).toThrow()
    expect(() => gas.reportProjectHealth_(Array.from({ length: 501 }, () => ({})))).toThrow()
  })

  it('複数の管理者がほぼ同時に送っても(ロックで順番に処理される)、同じ変化は1回だけ通知する', () => {
    const { gas, mails, chats } = setup([['p1', 'A', '', 'good'], ['p2', 'B', '', 'watch']])
    const items = [
      { projectId: 'p1', health: 'attention' },
      { projectId: 'p2', health: 'attention' },
    ]
    expect(gas.reportProjectHealth_(items).notified).toEqual(['p1', 'p2'])
    // 2人目の画面は古いデータ(good / watch)をもとに同じ内容を送ってくる
    expect(gas.reportProjectHealth_(items)).toEqual({ recorded: [], notified: [] })
    expect(mails).toHaveLength(1)
    expect(chats).toHaveLength(2)
  })

  it('以前のフロントからの notifyProjectHealth も、記録が既に同じ状態なら通知しない', () => {
    const { gas, mails } = setup([['p1', 'A', '', 'good']])
    gas.reportProjectHealth_([{ projectId: 'p1', health: 'attention' }])
    gas.notifyProjectHealth_('p1', 'attention')
    expect(mails).toHaveLength(1)
  })

  it('ロックを放す前に、シートへの書き込みを確定させる', () => {
    // doPost は最後に finishWrite_ を呼び、finishWrite_ はロックを放す前に確定させる
    const doPost = CODE_GS.slice(CODE_GS.indexOf('function doPost('), CODE_GS.indexOf('\n}\n', CODE_GS.indexOf('function doPost(')))
    expect(doPost.slice(doPost.indexOf('} finally {'))).toContain('finishWrite_(state)')
    const finish = CODE_GS.slice(CODE_GS.indexOf('function finishWrite_('))
    expect(finish.slice(0, finish.indexOf('releaseLock()'))).toContain('SpreadsheetApp.flush()')
    expect(CODE_GS.match(/var LOCK_EXEMPT_ACTIONS = \[[^\]]*\]/)![0]).not.toMatch(/reportProjectHealth_|notifyProjectHealth_/)
  })

  it('以前のフロントからの notifyProjectHealth も、初回の計算では通知しない', () => {
    const { gas, mails, record } = setup([['p1', 'A', '', ''], ['p2', 'B', '', 'good']])
    gas.notifyProjectHealth_('p1', 'attention')
    expect(record('p1')).toBe('attention')
    expect(mails).toHaveLength(0)
    gas.notifyProjectHealth_('p2', 'attention')
    expect(mails).toHaveLength(1)
  })
})

describe('テスト環境のメール送信', () => {
  const mail = { to: 'a@example.com,b@example.com', cc: 'c@example.com', subject: '件名', body: '本文' }

  it('テスト環境でなければ、本来の宛先に送る', () => {
    const { gas, mails } = setup([])
    gas.sendMail_({ ...mail })
    expect(mails).toEqual([mail])
  })

  it('TEST_NOTIFICATION_EMAIL の1つのアドレスにだけ送り、本来の宛先は本文に書く', () => {
    const { gas, mails } = setup([], { TEST_ENVIRONMENT: 'true', TEST_NOTIFICATION_EMAIL: ' tester@example.com ' })
    gas.sendMail_({ ...mail })
    expect(mails).toHaveLength(1)
    expect(mails[0].to).toBe('tester@example.com')
    expect(mails[0].cc).toBeUndefined()
    expect(mails[0].subject).toBe('[テスト] 件名')
    expect(mails[0].body).toMatch(/^\(テスト環境のため.*本来の宛先: a@example.com,b@example.com,c@example.com\)\n\n本文$/)
  })

  it('TEST_NOTIFICATION_EMAIL が未設定なら送信せず、ログに残す', () => {
    const { gas, mails, logs } = setup([], { TEST_ENVIRONMENT: 'true' })
    gas.sendMail_({ ...mail })
    expect(mails).toHaveLength(0)
    expect(logs.some((l) => /メールを送信しませんでした.*件名: 件名/.test(l))).toBe(true)
  })

  it('健康状態の通知もテスト用のアドレスにだけ届く', () => {
    const { gas, mails } = setup([['p1', 'A', '', 'good']], {
      TEST_ENVIRONMENT: 'true',
      TEST_NOTIFICATION_EMAIL: 'tester@example.com',
    })
    gas.reportProjectHealth_([{ projectId: 'p1', health: 'attention' }])
    expect(mails.map((m) => m.to)).toEqual(['tester@example.com'])
  })

  it('Code.gs でメールを送るのは sendMail_ の中だけ', () => {
    const calls = CODE_GS.split('\n').filter((l) => /MailApp\.sendEmail\(|GmailApp\./.test(l))
    expect(calls).toHaveLength(2)
    const body = CODE_GS.slice(CODE_GS.indexOf('function sendMail_('), CODE_GS.indexOf('// 呼び出し方は2通り'))
    calls.forEach((l) => expect(body).toContain(l))
  })

  it('テスト環境ではカレンダーの招待を送らない', () => {
    const { context, events } = setup([], { TEST_ENVIRONMENT: 'true' })
    context.findRow_ = () => ({ title: 'T', due_date: '2026-10-01', due_time: '', assignee_id: '1' })
    ;(context as unknown as { syncCalendarForTask_: (id: string) => void }).syncCalendarForTask_('t1')
    expect(events).toEqual([{ title: '[Ohsumi] T', options: {} }])

    const prod = setup([])
    prod.context.findRow_ = () => ({ title: 'T', due_date: '2026-10-01', due_time: '', assignee_id: '1' })
    ;(prod.context as unknown as { syncCalendarForTask_: (id: string) => void }).syncCalendarForTask_('t1')
    expect(prod.events[0].options).toEqual({ guests: 'boss@example.com', sendInvites: true })
  })
})

describe('性能計測用のダミーデータ', () => {
  it('メールアドレスを作らない', () => {
    const { gas } = setup([])
    const data = gas.buildPerformanceTestData_()
    expect(Object.keys(data)).toEqual(['Members', 'Projects', 'Tasks'])
    expect(JSON.stringify(data)).not.toContain('@')
    expect(data.Members.every((m) => !('email' in m))).toBe(true)
  })
})

describe('selectProjectHealthReports(フロント側の選び方)', () => {
  const project = (id: string, last?: ProjectHealthLevel, override?: ProjectHealthLevel) =>
    ({ id, lastNotifiedHealth: last, healthOverride: override }) as unknown as Project
  const health: Record<string, ProjectHealthLevel> = { a: 'attention', b: 'attention', c: 'good', d: 'watch', e: 'attention', f: 'attention' }

  it('記録が無いもの・attention への悪化・attention からの回復だけを選ぶ', () => {
    const reports = selectProjectHealthReports(
      [project('a'), project('b', 'good'), project('c', 'attention'), project('d', 'good'), project('e', 'attention'), project('f', undefined, 'good')],
      (p) => health[p.id],
    )
    expect(reports).toEqual([
      { projectId: 'a', health: 'attention' },
      { projectId: 'b', health: 'attention' },
      { projectId: 'c', health: 'good' },
    ])
  })
})
