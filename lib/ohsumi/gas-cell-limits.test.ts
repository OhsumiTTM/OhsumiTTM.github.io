// 1つのセルの長さ(PR I): スプレッドシートの1つのセルには 5万文字までしか入らない。
//   - 上限を超える保存は断り(cellTooLong)、シートは書き換えない
//   - 8割(4万文字)を超えた保存は、書いた人(longRecords)と代表(初めて超えた時に、まとめのメール)に知らせる
//   - 代表の管理画面(getOpsStatus)で、どの記録がいくつ上限に近いかを見られる
//   - measureReadPerformance の判定(移行の前に、完了したタスクを最初の読み込みから外すことが要るか)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const OLD = { id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }
// コメントのセル(JSON)が、だいたい chars 文字になる保存
const comments = (chars: number) => [OLD, { id: 'c-long', byId: 'm-base', text: 'あ'.repeat(chars), at: '2026-10-01' }]
const save = (h: H, chars: number, token = 'm-base') =>
  h.post({ action: 'updateComments', sessionToken: token, taskId: 't1', comments: comments(chars), requestId: 'r' + Math.random() })
const longDigests = (h: H) => h.digested().filter((d) => d.text.includes('この記録は長くなっています'))

describe('上限(5万文字)を超える保存', () => {
  it('断って、シートは書き換えない。画面が書いた文章を残せるよう cellTooLong を返す', () => {
    const h = guardHarness()
    const before = h.tasksJson()
    const res = save(h, 50_001)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('保存できませんでした')
    expect(res.cellTooLong).toMatchObject({ sheet: 'Tasks', field: 'comments_json', max: 50_000 })
    expect(res.cellTooLong.length).toBeGreaterThan(50_000)
    expect(h.tasksJson()).toBe(before)
    // 今回書いた文章だけを返す(前からのコメントは除く)
    expect(res.cellTooLong.texts).toContain('あ'.repeat(50_001))
    expect(res.cellTooLong.texts).not.toContain('前からのコメント')
  })

  it('送り直しで前回の結果を返す時も、cellTooLong を付ける', () => {
    const h = guardHarness()
    const body = { action: 'updateComments', sessionToken: 'm-base', taskId: 't1', comments: comments(50_001), requestId: 'same-request-1' }
    expect(h.post(body).cellTooLong).toBeTruthy()
    expect(h.post(body)).toMatchObject({ ok: false, replayed: true, cellTooLong: { field: 'comments_json' } })
    // 文章が大きく覚えきれない時は、文章を除いて覚える(画面は送った内容から取り出す)
    const big = { ...body, comments: comments(95_000), requestId: 'same-request-2' }
    expect(h.post(big).cellTooLong.texts).toHaveLength(4)
    expect(h.post(big)).toMatchObject({ ok: false, replayed: true, cellTooLong: { field: 'comments_json', texts: null } })
  })

  it('まとめて送った時(batch)も、その操作の結果に cellTooLong を付ける', () => {
    const h = guardHarness()
    const res = h.post({ action: 'batch', sessionToken: 'm-base', requestId: 'b1', ops: [{ action: 'updateComments', taskId: 't1', comments: comments(50_001) }] })
    expect(res.ok).toBe(true)
    expect(res.result.results[0]).toMatchObject({ ok: false, cellTooLong: { field: 'comments_json' } })
  })

  it('設定(Settings)・新しい行の追加でも断る', () => {
    const h = guardHarness()
    let err: { cellTooLong?: unknown } | null = null
    try { call(h, 'updateSetting_', 'project_templates', 'x'.repeat(50_001)) } catch (e) { err = e as { cellTooLong?: unknown } }
    expect(err?.cellTooLong).toMatchObject({ sheet: 'Settings', field: 'value' })
    expect(() => call(h, 'appendRowByHeaders_', call(h, 'getSheet_', 'Projects'), 'Projects', { id: 'p9', name: 'x'.repeat(50_001) })).toThrow('保存できませんでした')
    expect(h.sheets.Projects.rows).toHaveLength(2)
  })

  it('上限ちょうどまでは保存できる', () => {
    const h = guardHarness()
    const res = save(h, 49_800)
    expect(res.ok, res.error).toBe(true)
    expect(JSON.stringify(h.sheets.Tasks.rows).length).toBeGreaterThan(49_800)
  })
})

describe('8割(4万文字)を超えた保存', () => {
  it('保存して、書いた人に longRecords で知らせる。初めて超えた時だけ、代表にまとめのメールで知らせる', () => {
    const h = guardHarness()
    const small = save(h, 1_000)
    expect(small.ok).toBe(true)
    expect(small.longRecords).toBeUndefined()

    const res = save(h, 41_000)
    expect(res.ok, res.error).toBe(true)
    expect(res.longRecords).toEqual([expect.objectContaining({ sheet: 'Tasks', id: 't1', name: 'タスク1', field: 'comments_json', max: 50_000 })])
    expect(res.longRecords[0].length).toBeGreaterThan(41_000)
    expect(longDigests(h)).toEqual([expect.objectContaining({ to: 'top@example.com' })])
    expect(longDigests(h)[0].text).toContain('タスク1 の コメント')

    // もう超えている記録を書き足した時は、書いた人には知らせるが、代表には何度も送らない
    const again = save(h, 42_000)
    expect(again.longRecords).toHaveLength(1)
    expect(longDigests(h)).toHaveLength(1)
  })
})

describe('代表の管理画面の「長くなっている記録」', () => {
  it('記録の種類ごとに、件数と記録を長い順に返す。代表だけが見られる', () => {
    const h = guardHarness()
    expect(save(h, 45_000).ok).toBe(true)
    const res = h.post({ action: 'getOpsStatus', sessionToken: 'm-top' })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.longRecords).toMatchObject({
      warnAt: 40_000, max: 50_000,
      groups: [{ sheet: 'Tasks', field: 'comments_json', label: 'コメント', count: 1, items: [{ id: 't1', name: 'タスク1' }] }],
    })
    expect(res.result.longRecords.maxLength).toBeGreaterThan(45_000)
    expect(h.post({ action: 'getOpsStatus', sessionToken: 'm-base' })).toMatchObject({ ok: false, forbidden: true })
  })

  it('長い記録が無ければ、空', () => {
    const h = guardHarness()
    expect(h.post({ action: 'getOpsStatus', sessionToken: 'm-top' }).result.longRecords.groups).toEqual([])
  })
})

describe('読み取り性能の計測の判定', () => {
  const metrics = (h: H, tasks: number, done: number, sizes: Partial<Record<string, unknown>> = {}) => {
    const headers = ['id', 'title', 'status', 'comments_json']
    const rows = Array.from({ length: tasks }, (_, i) => [String(i), 't' + i, i < done ? '完了' : 'todo', i === 0 ? 'x'.repeat(41_000) : '[]'])
    const data = { Tasks: { headers, rows }, Members: { headers: ['id'], rows: [] }, Projects: { headers: ['id'], rows: [] }, Settings: { headers: ['key', 'value'], rows: [] } }
    return plain(call(h, 'readPerformanceMetrics_', data, { jsonChars: 1_000_000, gzipChars: 250_000, viewerChars: 500_000, readSheetsMs: 3000, cached: true, ...sizes })) as Record<string, unknown>
  }

  it('タスクの件数・完了の割合・圧縮の割合・キャッシュの分割・1つのセルの最大の長さを出す', () => {
    const h = guardHarness()
    const m = metrics(h, 10, 6)
    expect(m).toMatchObject({ tasks: 10, doneTasks: 6, gzipPercent: 25, chunks: 3, chunkPercent: 5 })
    expect(m.cells).toMatchObject({ maxLength: 41_000, maxPercent: 82 })
    expect((m.cells as { top: unknown[] }).top[0]).toEqual({ sheet: 'Tasks', field: 'comments_json', maxLength: 41_000, over: 1 })
  })

  it('すべての目安を下回れば「移行の前には要りません」。どれかを超えれば理由を出す', () => {
    const h = guardHarness()
    const verdict = (m: Record<string, unknown>) => (call(h, 'readPerformanceVerdict_', m) as string[]).join('\n')
    expect(verdict(metrics(h, 10, 6))).toContain('移行の前には要りません')
    expect(verdict(metrics(h, 10, 6))).toContain('上限の8割(40000 文字)を超えた記録があります')
    expect(verdict(metrics(h, 2000, 1500))).toContain('移行の前に作る必要があります: タスクが 2000 件')
    expect(verdict(metrics(h, 10, 6, { gzipChars: 45 * 90_000 }))).toContain('キャッシュの分割が 45 / 60 個')
    expect(verdict(metrics(h, 10, 6, { cached: false }))).toContain('キャッシュの分割')
    expect(verdict(metrics(h, 10, 6, { readSheetsMs: 9000 }))).toContain('キャッシュなしのシート読み込みが 9000 ms')
    expect(verdict(metrics(h, 10, 6, { viewerChars: 4 * 1024 * 1024 }))).toContain('閲覧者ごとの読み込みが 4096 KB')
  })
})

describe('守る処理を外すと失敗する', () => {
  const mutated = (from: string, to: string) => {
    const code = CODE_GS.replace(from, to)
    expect(code, from).not.toBe(CODE_GS)
    return code
  }

  it('行の更新の確かめを外すと、上限を超える値を書こうとする', () => {
    const h = guardHarness({ code: mutated('  cols.forEach(function (c) { assertCellLength_(sheetName, headers[c.col - 1], c.value, before[c.col - 1]) })\n', '') })
    const res = save(h, 50_001)
    expect(res.ok).toBe(true)
    expect(res.cellTooLong).toBeUndefined()
  })

  it('失敗の応答に cellTooLong を付けないと、画面は書いた文章を残せない', () => {
    const h = guardHarness({ code: mutated('  if (err && err.cellTooLong) out.cellTooLong = err.cellTooLong\n', '') })
    expect(save(h, 50_001)).toMatchObject({ ok: false })
    expect(save(h, 50_001).cellTooLong).toBeUndefined()
  })

  it('初めて超えたかを見ないと、書き足すたびに代表に知らせる', () => {
    const h = guardHarness({ code: mutated('crossed: String(before === undefined || before === null ? \'\' : before).length <= CELL_WARN_CHARS', 'crossed: true') })
    save(h, 41_000)
    save(h, 42_000)
    expect(longDigests(h)).toHaveLength(2)
  })
})
