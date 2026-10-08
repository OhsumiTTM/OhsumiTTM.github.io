// コメント・進み具合・変更の記録・1on1・評価を、1件1行のシート(TaskRecords・MemberRecords)に持つ
// (gas/src/39-record-rows.gs)。サンプルのデータで「移す → 照合 → 戻す」を通しで確かめ、移した後の読み書きを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, type Cell } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const SAMPLE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'SampleData.gs'), 'utf8')
const LISTS = { Tasks: ['comments_json', 'progress_history_json', 'history_json'], Members: ['one_on_ones_json', 'evaluation_history_json'] } as const

// 移行の前のバックアップは、偽の Drive では作れないので、作ったことだけを覚える
function harness(code = CODE_GS) {
  const h = guardHarness({ code })
  const backups: string[] = []
  h.c.createBackup_ = (kind: string) => { backups.push(kind); return { id: 'b-' + kind, name: 'バックアップ ' + kind, at: '2026-10-08T00:00:00Z', kind } }
  // Members に 1on1・評価の列を足す
  const m = h.sheets.Members.rows
  m[0].push('one_on_ones_json', 'evaluation_history_json')
  m.slice(1).forEach((r) => r.push('', ''))
  return { ...h, backups }
}

const head = (h: H, sheet: string) => h.sheets[sheet].rows[0].map(String)
const cell = (h: H, sheet: string, id: string, col: string) => {
  const hd = head(h, sheet)
  return String(h.sheets[sheet].rows.find((r) => String(r[0]) === id)?.[hd.indexOf(col)] ?? '')
}
const setCell = (h: H, sheet: string, id: string, col: string, v: Cell) => {
  const hd = head(h, sheet)
  const row = h.sheets[sheet].rows.find((r) => String(r[hd.indexOf('id')]) === id)!
  row[hd.indexOf(col)] = v
}
const recordRows = (h: H, sheet: 'TaskRecords' | 'MemberRecords') => (h.sheets[sheet]?.rows ?? []).slice(1).filter((r) => String(r[0]))
const state = (h: H) => {
  const row = h.sheets.Settings.rows.find((r) => r[0] === 'record_rows_state')
  return row ? JSON.parse(String(row[1])).state : 'none'
}
// 画面に返る一覧(初期データの行の列)
const viewList = (h: H, sheet: 'Tasks' | 'Members', id: string, col: string, as = 'm-top') => {
  const res = h.post({ action: 'getInitialData', sessionToken: as })
  const t = res.result.sheets[sheet] as { headers: string[]; rows: string[][] }
  const row = t.rows.find((r) => r[t.headers.indexOf('id')] === id)
  return JSON.parse(row?.[t.headers.indexOf(col)] || '[]')
}
const migrate = (h: H, as = 'm-top') => h.post({ action: 'migrateRecordsToRows', sessionToken: as })
const revert = (h: H, as = 'm-top') => h.post({ action: 'revertRecordRows', sessionToken: as })

// 今のセルに入っている記録の数
const cellEntries = (h: H) => (['Tasks', 'Members'] as const).reduce((n, sheet) => {
  const hd = head(h, sheet)
  return n + h.sheets[sheet].rows.slice(1).reduce((m, r) => m + LISTS[sheet].reduce((k, col) => {
    const v = String(r[hd.indexOf(col)] ?? '')
    return k + (v ? (JSON.parse(v) as unknown[]).length : 0)
  }, 0), 0)
}, 0)

// サンプルのデータ(buildSampleData_)の記録の一覧を、偽のシートのセルに入れる
function withSampleRecords(h: H) {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Utilities: { formatDate: () => '2026-10-08', getUuid: () => 'u' } })
  vm.runInContext(CODE_GS + '\n' + SAMPLE_GS, ctx)
  const data = (ctx as unknown as { buildSampleData_: (d: string, f: object) => { sheets: Record<string, Record<string, string>[]> } }).buildSampleData_('2026-10-08', {})
  const expected: Record<string, unknown[]> = {}
  for (const sheet of ['Tasks', 'Members'] as const) {
    const hd = head(h, sheet)
    for (const o of data.sheets[sheet]) {
      const row: Cell[] = hd.map((c) => (c === 'id' ? o.id : c === 'title' || c === 'name' ? o.title ?? o.name ?? '' : ''))
      for (const col of LISTS[sheet]) {
        const v = o[col] || ''
        row[hd.indexOf(col)] = v
        if (v && v !== '[]') expected[`${sheet}:${o.id}:${col}`] = JSON.parse(v)
      }
      h.sheets[sheet].rows.push(row)
    }
  }
  return expected
}

describe('記録を1件1行のシートに移す(サンプルのデータで、移す → 照合 → 戻す)', () => {
  it('試す: 書かずに件数を返す。代表のほかは使えない', () => {
    const h = harness()
    withSampleRecords(h)
    const dry = h.post({ action: 'migrateRecordsToRows', sessionToken: 'm-top', dryRun: true })
    expect(dry.ok, dry.error).toBe(true)
    expect(dry.result.dryRun).toBe(true)
    expect(dry.result.counts.comment).toBeGreaterThan(100)
    expect(dry.result.ok).toBe(true)
    expect(state(h)).toBe('none')
    expect(recordRows(h, 'TaskRecords')).toHaveLength(0)
    for (const who of ['m-lead', 'm-base']) {
      expect(migrate(h, who), who).toMatchObject({ ok: false })
      expect(revert(h, who), who).toMatchObject({ ok: false })
      expect(h.post({ action: 'getRecordRowsStatus', sessionToken: who }), who).toMatchObject({ ok: false })
    }
  })

  it('移す: バックアップを取ってから行に写し、照合して切り替える。画面に返る一覧は前と同じ。戻すとセルに同じ一覧が戻る', () => {
    const h = harness()
    const expected = withSampleRecords(h)
    const total = cellEntries(h)
    const before = Object.fromEntries(Object.keys(expected).map((k) => { const [s, id, col] = k.split(':'); return [k, viewList(h, s as 'Tasks', id, col)] }))
    const res = migrate(h)
    expect(res.ok, res.error).toBe(true)
    expect(res.result).toMatchObject({ state: 'done', done: true })
    expect(h.backups).toEqual(['beforeMigration'])
    expect(state(h)).toBe('done')
    expect(total).toBeGreaterThan(Object.values(expected).reduce((n, l) => n + l.length, 0))
    expect(recordRows(h, 'TaskRecords').length + recordRows(h, 'MemberRecords').length).toBe(total)
    // セルの一覧は空になり、画面には行から組み立てた同じ一覧が返る
    for (const k of Object.keys(expected)) {
      const [s, id, col] = k.split(':')
      expect(cell(h, s, id, col), k).toBe('')
      expect(viewList(h, s as 'Tasks', id, col), k).toEqual(before[k])
    }
    expect(h.post({ action: 'getInitialData', sessionToken: 'm-top' }).result.recordRows).toBe('done')
    // 戻す
    const back = revert(h)
    expect(back.ok, back.error).toBe(true)
    expect(back.result).toMatchObject({ state: 'none', done: true })
    expect(h.backups).toEqual(['beforeMigration', 'beforeRevert'])
    expect(state(h)).toBe('none')
    expect(recordRows(h, 'TaskRecords')).toHaveLength(0)
    for (const k of Object.keys(expected)) {
      const [s, id, col] = k.split(':')
      expect(JSON.parse(cell(h, s, id, col)), k).toEqual(expected[k])
    }
  })

  it('途中で止まっても、続きから移す(重ならない)', () => {
    const h = harness()
    withSampleRecords(h)
    const total = cellEntries(h)
    h.c.MIGRATE_BATCH = 10
    const real = h.c.syncRecordListsBulk_ as (...a: unknown[]) => number
    let calls = 0
    h.c.syncRecordListsBulk_ = (...a: unknown[]) => {
      calls++
      if (calls === 4) throw new Error('実行の時間切れ(のつもり)')
      return real(...a)
    }
    const first = migrate(h)
    expect(first.ok).toBe(false)
    expect(state(h)).toBe('migrating')
    // 移している間は、記録の一覧への書き込みを断る
    const busy = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'add', entry: { id: 'c-busy', text: '移している間', byId: 'm-base', at: '2026-10-08' } }] })
    expect(busy).toMatchObject({ ok: false })
    expect(String(busy.error)).toContain('データの持ち方を移しています')
    h.c.syncRecordListsBulk_ = real
    const again = migrate(h)
    expect(again.ok, again.error).toBe(true)
    expect(again.result.state).toBe('done')
    // バックアップは最初の1回だけ
    expect(h.backups).toEqual(['beforeMigration'])
    const keys = recordRows(h, 'TaskRecords').map((r) => String(r[0]))
    expect(new Set(keys).size).toBe(keys.length)
    expect(recordRows(h, 'TaskRecords').length + recordRows(h, 'MemberRecords').length).toBe(total)
  })

  it('途中で止まって30分たった後に書き込まれたコメントも、続きから移すと照合で行に入る(写し終えたタスクにも)', () => {
    const h = harness()
    withSampleRecords(h)
    h.c.MIGRATE_BATCH = 10
    const real = h.c.syncRecordListsBulk_ as (...a: unknown[]) => number
    let calls = 0
    h.c.syncRecordListsBulk_ = (...a: unknown[]) => {
      calls++
      if (calls === 4) throw new Error('実行の時間切れ(のつもり)')
      return real(...a)
    }
    expect(migrate(h).ok).toBe(false)
    expect(state(h)).toBe('migrating')
    h.c.syncRecordListsBulk_ = real
    // t1 は止まる前に写し終えている
    const copied = recordRows(h, 'TaskRecords').filter((r) => String(r[1]) === 't1' && String(r[2]) === 'comment').length
    expect(copied).toBeGreaterThan(0)
    // 止まってから30分を過ぎた: 書き込みを受け付ける(セルが正のまま)
    const settings = h.sheets.Settings.rows.find((r) => r[0] === 'record_rows_state')!
    const st = JSON.parse(String(settings[1]))
    st.touchedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString()
    settings[1] = JSON.stringify(st)
    h.props.DATA_VERSION = 'stale-' + Date.now()
    const late = { id: 'c-late', text: '止まった後のコメント', byId: 'm-base', at: '2026-10-08T01:00:00Z' }
    const added = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'add', entry: late }] })
    expect(added.ok, added.error).toBe(true)
    expect(cell(h, 'Tasks', 't1', 'comments_json')).toContain('c-late')
    const before = viewList(h, 'Tasks', 't1', 'comments_json')
    // 続きから移す: 写し終えた t1 は、照合で違いが見つかり、写し直して行に入る
    const again = migrate(h)
    expect(again.ok, again.error).toBe(true)
    expect(again.result.state).toBe('done')
    expect(cell(h, 'Tasks', 't1', 'comments_json')).toBe('')
    const rows = recordRows(h, 'TaskRecords').filter((r) => String(r[1]) === 't1' && String(r[2]) === 'comment')
    expect(rows.map((r) => JSON.parse(String(r[7])).id)).toContain('c-late')
    expect(viewList(h, 'Tasks', 't1', 'comments_json')).toEqual(before)
    expect(h.backups).toEqual(['beforeMigration'])
  })

  it('照合が合わない時は failed にして、セルが正のまま(何も消さない)', () => {
    const h = harness()
    withSampleRecords(h)
    const real = h.c.syncRecordListsBulk_ as (target: string, items: { list: unknown[] }[]) => number
    // 写す時に、いつも1件落とす(写し直しても直らない)
    h.c.syncRecordListsBulk_ = (target: string, items: { list: unknown[] }[]) => real(target, items.map((it) => ({ ...it, list: it.list.slice(1) })))
    const res = migrate(h)
    expect(res.ok, res.error).toBe(true)
    expect(res.result.state).toBe('failed')
    expect(state(h)).toBe('failed')
    expect(cell(h, 'Tasks', 't1', 'comments_json')).toContain('c-old')
    expect(viewList(h, 'Tasks', 't1', 'comments_json').map((c: { id: string }) => c.id)).toEqual(['c-old'])
    // やめる(戻す): 記録のシートを空にして none に戻す
    h.c.syncRecordListsBulk_ = real
    expect(revert(h).result.state).toBe('none')
    expect(recordRows(h, 'TaskRecords')).toHaveLength(0)
  })

  it('読めない一覧があれば、移す前に止める', () => {
    const h = harness()
    setCell(h, 'Tasks', 't1', 'comments_json', '{壊れた')
    const dry = h.post({ action: 'migrateRecordsToRows', sessionToken: 'm-top', dryRun: true })
    expect(dry.result.ok).toBe(false)
    expect(dry.result.problems.unreadable).toEqual(['Tasks:t1:comments_json'])
    expect(migrate(h)).toMatchObject({ ok: false })
    expect(state(h)).toBe('none')
    expect(h.backups).toEqual([])
  })
})

describe('移した後の読み書き', () => {
  const migrated = () => {
    const h = harness()
    setCell(h, 'Members', 'm-base', 'one_on_ones_json', JSON.stringify([{ id: 'o1', date: '2026-09-01', withId: 'm-victim', notes: '前回の1on1' }]))
    setCell(h, 'Members', 'm-victim', 'one_on_ones_json', JSON.stringify([{ id: 'o2', date: '2026-09-02', withId: 'm-base', notes: '退会する人の1on1' }]))
    expect(migrate(h).result.state).toBe('done')
    return h
  }

  it('コメントの追加・変更・削除は行に書き、画面に返る一覧に出る。セルは空のまま', () => {
    const h = migrated()
    const add = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'add', entry: { id: 'c-new', text: '新しいコメント', byId: 'm-base', at: '2026-10-08T00:00:00Z' } }] })
    expect(add.ok, add.error).toBe(true)
    expect(viewList(h, 'Tasks', 't1', 'comments_json').map((c: { id: string }) => c.id)).toEqual(['c-old', 'c-new'])
    expect(cell(h, 'Tasks', 't1', 'comments_json')).toBe('')
    const body = { id: 'c-new', text: '新しいコメント', byId: 'm-base', at: '2026-10-08T00:00:00Z' }
    const upd = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'update', key: 'c-new', before: body, entry: { ...body, text: '直した' } }] })
    expect(upd.ok, upd.error).toBe(true)
    expect(viewList(h, 'Tasks', 't1', 'comments_json')[1].text).toBe('直した')
    // 中身が変わった後の古い内容での変更は、競合で断る
    expect(h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'update', key: 'c-new', before: body, entry: { ...body, text: '古い' } }] })).toMatchObject({ ok: false })
    const del = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'remove', key: 'c-new', before: { ...body, text: '直した' } }] })
    expect(del.ok, del.error).toBe(true)
    expect(viewList(h, 'Tasks', 't1', 'comments_json').map((c: { id: string }) => c.id)).toEqual(['c-old'])
    // ほかの人のコメントは、今までどおり消せない
    expect(h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'remove', key: 'c-old', before: { id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' } }] })).toMatchObject({ ok: false })
  })

  it('変更の記録は500件まで残す(セルに持つ間は50件)', () => {
    const h = migrated()
    for (let i = 0; i < 60; i++) {
      const r = h.post({ action: 'updateHistory', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'add', entry: { id: `h${i}`, at: '2026-10-08T00:00:00Z', byId: 'm-base', field: 'title', from: String(i), to: String(i + 1) } }] })
      expect(r.ok, r.error).toBe(true)
    }
    const list = viewList(h, 'Tasks', 't1', 'history_json')
    expect(list).toHaveLength(60)
    expect(list[0].id).toBe('h59')
    expect(h.c.historyCap_ as () => number).toBeDefined()
    expect((h.c.HISTORY_CAP_ROWS as number)).toBe(500)
  })

  it('1on1 は本人と上長にだけ返る。退会した人の個人情報を消すと、その人の記録の行は消え、ほかの人の 1on1 は残る(相手は「退会したメンバー」)', () => {
    const h = migrated()
    expect(viewList(h, 'Members', 'm-base', 'one_on_ones_json', 'm-base')).toHaveLength(1)
    expect(viewList(h, 'Members', 'm-base', 'one_on_ones_json', 'm-other')).toEqual([])
    ;(h.c.purgeMember_ as (id: string, now: number) => void)('m-victim', Date.parse('2026-10-08'))
    const memberRows = recordRows(h, 'MemberRecords').map((r) => String(r[1]))
    expect(memberRows).not.toContain('m-victim')
    expect(memberRows).toContain('m-base')
    expect(cell(h, 'Members', 'm-victim', 'name')).toBe('退会したメンバー')
    expect(viewList(h, 'Members', 'm-base', 'one_on_ones_json', 'm-base')[0].withId).toBe('m-victim')
  })

  it('タスクを完全に消すと、その記録の行も消える', () => {
    const h = migrated()
    expect(recordRows(h, 'TaskRecords').some((r) => r[1] === 't1')).toBe(true)
    ;(h.c.removeTask_ as (id: string) => void)('t1')
    expect(recordRows(h, 'TaskRecords').some((r) => r[1] === 't1')).toBe(false)
  })

  it('長くなっている記録の一覧に、行に移した一覧は数えない', () => {
    const h = migrated()
    const long = 'あ'.repeat(30000)
    for (let i = 0; i < 2; i++) {
      const r = h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', listOps: [{ op: 'add', entry: { id: `long${i}`, text: long, byId: 'm-base', at: '2026-10-08' } }] })
      expect(r.ok, r.error).toBe(true)
    }
    // 1つのセルなら上限を超える長さでも、1件ずつなら保存できる
    expect(viewList(h, 'Tasks', 't1', 'comments_json')).toHaveLength(3)
    const lr = h.post({ action: 'getLongRecords', sessionToken: 'm-top' })
    expect(JSON.stringify(lr.result ?? {})).not.toContain('comments_json')
  })
})

describe('新しい団体', () => {
  it('一覧の列に何も入っていなければ、最初から行に持つ。入っていれば、そのまま(セル)', () => {
    const empty = harness()
    LISTS.Tasks.forEach((col) => setCell(empty, 'Tasks', 't1', col, ''))
    const s = (empty.c.startRecordRowsIfEmpty_ as () => { state: string })()
    expect(s.state).toBe('done')
    expect(state(empty)).toBe('done')
    const used = harness()
    expect((used.c.startRecordRowsIfEmpty_ as () => { state: string })().state).toBe('none')
  })
})

describe('見本・サンプルのデータ(SampleData.gs)', () => {
  it('記録を行に持つ団体では、コメント・変更の記録を記録のシートに書き、消す時は記録の行も消す', () => {
    const h = harness(CODE_GS + '\n' + SAMPLE_GS)
    LISTS.Tasks.forEach((col) => setCell(h, 'Tasks', 't1', col, ''))
    expect((h.c.startRecordRowsIfEmpty_ as () => { state: string })().state).toBe('done')
    const comments = [{ id: 'sc1', byId: 'demo-m1', text: '見本のコメント', at: '2026-10-01' }, { id: 'sc2', byId: 'demo-m2', text: '返信', at: '2026-10-02', replyToId: 'sc1' }]
    const n = (h.c.appendSampleRows_ as (s: string, o: object[]) => number)('Tasks', [{ id: 'demo-t1', title: '見本のタスク', comments_json: JSON.stringify(comments), history_json: '[]' }])
    expect(n).toBe(1)
    expect(cell(h, 'Tasks', 'demo-t1', 'comments_json')).toBe('')
    expect(viewList(h, 'Tasks', 'demo-t1', 'comments_json')).toEqual(comments)
    ;(h.c.resetRecordRowsMemo_ as () => void)()
    const removed = (h.c.deleteSampleRows_ as (s: string, m: (o: Record<string, string>) => boolean) => number)('TaskRecords', (o) => String(o.task_id).startsWith('demo-'))
    expect(removed).toBe(2)
    expect(recordRows(h, 'TaskRecords').some((r) => String(r[1]).startsWith('demo-'))).toBe(false)
  })
})

describe('移したタスク(TasksArchive)と戻す', () => {
  it('移行の後に移したタスクの記録は、戻すと TasksArchive のセルに戻る。移行の前に移したタスクのセルは、そのまま', () => {
    const h = harness()
    const head = h.sheets.Tasks.rows[0].map(String)
    h.addSheet('TasksArchive', [[...head, 'archived_at'],
      head.map((c) => (c === 'id' ? 't-old' : c === 'title' ? '前に移したタスク' : c === 'comments_json' ? JSON.stringify([{ id: 'ca', byId: 'm-lead', text: '移行の前', at: '2026-01-01' }]) : '')).concat(['2026-02-01'])])
    expect(migrate(h).result.state).toBe('done')
    // t1 を移したことにする(行は TasksArchive へ。記録は TaskRecords に残る)
    const t1 = h.sheets.Tasks.rows.splice(1, 1)[0]
    h.sheets.TasksArchive.rows.push([...t1, '2026-10-08'])
    h.props.DATA_VERSION = 'v-archived'
    expect(revert(h).result.state).toBe('none')
    const arch = h.sheets.TasksArchive.rows
    const col = arch[0].map(String).indexOf('comments_json')
    expect(JSON.parse(String(arch.find((r) => r[0] === 't1')![col]))[0].id).toBe('c-old')
    expect(JSON.parse(String(arch.find((r) => r[0] === 't-old')![col]))[0].id).toBe('ca')
  })
})
