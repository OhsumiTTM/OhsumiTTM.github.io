// gas/Code.gs の doPost が、書き込みの requestId を覚えておき、送り直された時は処理を
// やり直さずに前回の結果を返すこと(二重に書き込まない)を確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

function setup(opts: { lockBusy?: boolean } = {}) {
  const cache = new Map<string, string>()
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}), getProperty: () => null }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => { cache.set(k, v) } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (opts.lockBusy) throw new Error('timeout') }, releaseLock() {} }) },
    SpreadsheetApp: { flush() {} },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026-10-01' },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  // 認証は sessionToken をそのままメンバーID として扱う
  c.authenticateRequest_ = (body: { sessionToken: string }) => ({ memberId: body.sessionToken, renewed: { token: 'renewed', exp: 1 } })
  c.getActingMemberById_ = (id: string) => ({ id })
  c.authorizeAction_ = () => {}
  c.bumpDataVersion = () => {}
  c.notifyReview_ = () => {}
  const writes: string[] = []
  c.updateTaskFields_ = (taskId: string) => { writes.push(taskId); return { ok: true, n: writes.length } }
  const post = (body: Record<string, unknown>) => {
    const out = (ctx as unknown as { doPost: (e: object) => { text: string } }).doPost({ postData: { contents: JSON.stringify(body) } })
    // 処理時間の内訳(timing)は別のテストで確かめる
    const { timing, ...rest } = JSON.parse(out.text)
    expect(typeof timing.totalMs).toBe('number')
    return rest
  }
  return { post, writes, cache, ctx: c }
}

const write = (extra: Record<string, unknown> = {}) => ({ action: 'updateTaskStatus', sessionToken: 'm1', taskId: 't1', status: 'doing', ...extra })

describe('書き込みの送り直し(requestId)', () => {
  it('同じ requestId で送り直されたら、処理をやり直さずに前回の結果を返す', () => {
    const t = setup()
    const first = t.post(write({ requestId: 'req-00000001' }))
    expect(first).toMatchObject({ ok: true, result: { ok: true, n: 1 } })
    expect(first.session).toEqual({ token: 'renewed', exp: 1 })
    const again = t.post(write({ requestId: 'req-00000001' }))
    expect(again).toEqual({ ok: true, replayed: true, result: { ok: true, n: 1 } })
    expect(t.writes).toEqual(['t1'])
  })

  it('前回がエラーだった時も、同じエラーを返す(やり直さない)', () => {
    const t = setup()
    t.ctx.updateTaskFields_ = () => { throw (t.ctx.userError_ as (m: string) => Error)('タスクが見つかりません') }
    const first = t.post(write({ requestId: 'req-00000002' }))
    expect(first).toMatchObject({ ok: false, error: 'タスクが見つかりません' })
    let called = 0
    t.ctx.updateTaskFields_ = () => { called++; return {} }
    expect(t.post(write({ requestId: 'req-00000002' }))).toEqual({ ok: false, replayed: true, error: 'タスクが見つかりません' })
    expect(called).toBe(0)
  })

  it('ID が違えば別の操作として処理する。ID が無い(以前のフロント)・形が不正なら覚えない', () => {
    const t = setup()
    t.post(write({ requestId: 'req-00000003' }))
    t.post(write({ requestId: 'req-00000004' }))
    t.post(write())
    t.post(write())
    t.post(write({ requestId: 'bad id!' }))
    t.post(write({ requestId: 'bad id!' }))
    expect(t.writes).toHaveLength(6)
  })

  it('同じ ID でも、別のメンバーの記録は返さない', () => {
    const t = setup()
    t.post(write({ requestId: 'req-00000005' }))
    const other = t.post(write({ requestId: 'req-00000005', sessionToken: 'm2' }))
    expect(other.replayed).toBeUndefined()
    expect(t.writes).toHaveLength(2)
  })

  it('まだ処理中の同じ ID には、少し待つよう返す(retryLater)', () => {
    const t = setup()
    t.cache.set('rq:m1:req-00000006', JSON.stringify({ inFlight: true }))
    expect(t.post(write({ requestId: 'req-00000006' }))).toMatchObject({ ok: false, retryLater: true })
    expect(t.writes).toHaveLength(0)
  })

  it('ロックを取れなかった時は、まだ何も処理していないので retryLater を付けて返す', () => {
    const t = setup({ lockBusy: true })
    expect(t.post(write({ requestId: 'req-00000007' }))).toMatchObject({ ok: false, retryLater: true })
    expect(t.writes).toHaveLength(0)
    // 覚えていない(次に送り直された時は処理する)。停止の状態を確かめ直した印(contract:)は別
    expect([...t.cache.keys()].filter((k) => !k.startsWith('contract:'))).toEqual([])
  })

  it('結果が大きすぎて覚えられない時は、完了したことだけを返す(やり直さない)', () => {
    const t = setup()
    t.ctx.updateTaskFields_ = () => ({ big: 'x'.repeat(100000) })
    t.post(write({ requestId: 'req-00000008' }))
    const again = t.post(write({ requestId: 'req-00000008' }))
    expect(again).toMatchObject({ ok: false, replayed: true })
    expect(again.error).toMatch(/完了しています/)
  })

  it('覚えておく時間は10分、処理中の印は2分', () => {
    const t = setup()
    expect(t.ctx.REQUEST_REPLAY_TTL_SEC).toBe(600)
    expect(t.ctx.REQUEST_IN_FLIGHT_TTL_SEC).toBe(120)
  })
})
