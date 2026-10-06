// gas/Code.gs: 書き込みの認証・まとめて送られた書き込み(batch)・書き込みの内訳を確かめる。
//   - 普通の書き込みは、スナップショット(読み取りと同じキャッシュ)で判定する。権限そのものを変える操作は
//     シートから読む。ロックを取った後に版が変わっていたら、シートから判定し直す
//   - batch は、中の操作ごとに1本ずつ送った時と同じ権限の確認をし、ロック・版の更新は1回だけ
//   - 書き込みの内訳(処理・シートの読み書き・メール・書き込みの確定・版の更新)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { parseListCell, withListOps, type ListActionDef } from './list-diff'
import { sendToGas, setGasTransportDepsForTest } from './gas-transport'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

type Table = { headers: string[]; rows: string[][] }

const ROLES = JSON.stringify([
  { id: 'base', name: '一般', tier: 'base' },
  { id: 'r-lead', name: '班長', tier: 'admin' },
  { id: 'top', name: '代表', tier: 'top' },
])

function setup() {
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1' }
  const propWrites: string[] = []
  const sheet: Record<string, Table> = {
    Members: {
      headers: ['id', 'name', 'role', 'project_ids', 'permission_overrides_json', 'reports_to_id'],
      rows: [
        ['m-top', '代表', 'top', '', '[]', ''],
        ['m-lead', '班長', 'r-lead', '', '[]', ''],
        ['m-base', '一般', 'base', '', '[]', ''],
      ],
    },
    Settings: { headers: ['key', 'value'], rows: [['roles', ROLES]] },
    Tasks: {
      headers: ['id', 'title', 'assignee_id', 'creator_id', 'project_id', 'history_json'],
      rows: [['t1', 'タスク', 'm-base', 'm-lead', 'p1', '[]']],
    },
  }
  const calls: string[] = []
  const writes: { sheet: string; id: string; fields: Record<string, unknown> }[] = []
  let locks = 0
  const hooks: { onLock?: () => void } = {}
  const blob = (d: Buffer | string) => {
    const bytes = Buffer.isBuffer(d) ? d : Buffer.from(String(d))
    return { getBytes: () => bytes, getDataAsString: () => bytes.toString('utf8') }
  }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      getProperty: (k: string) => props[k] ?? null,
      setProperty: (k: string, v: string) => { props[k] = v; propWrites.push(k) },
    }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({
      get: (k: string) => cache.get(k) ?? null,
      getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      put: (k: string, v: string) => { cache.set(k, v) },
      putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, v) },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() { locks++; hooks.onLock?.() }, tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { flush() { calls.push('flush') } },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: {
      formatDate: () => '2026-10-01',
      newBlob: (d: Buffer | string) => blob(d),
      gzip: (b: unknown) => b,
      ungzip: (b: unknown) => b,
      base64Encode: (bytes: Buffer) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s: string) => Buffer.from(s, 'base64'),
    },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  const DateInCtx = vm.runInContext('Date', ctx) as { now: () => number }
  let now = Date.parse('2026-10-01T00:00:00Z')
  DateInCtx.now = () => now
  const advance = (ms: number) => { now += ms }

  const userError = (m: string) => (c.userError_ as (m: string) => Error)(m)
  c.authenticateRequest_ = (body: { sessionToken?: string }) => {
    if (!body.sessionToken) throw userError('ログインしていません。再ログインしてください。')
    return { memberId: body.sessionToken, renewed: null }
  }
  // スナップショットの作り直し(Sheets API)= シート全体を読む
  c.readSheetTables_ = () => { calls.push('sheet:snapshot'); return JSON.parse(JSON.stringify(sheet)) }
  c.readRoleSettings_ = () => { calls.push('sheet:Settings'); return { roles: ROLES } }
  c.getActingMemberById_ = (id: string) => {
    calls.push('sheet:Members')
    const row = sheet.Members.rows.find((r) => r[0] === id)
    if (!row) throw userError('メンバー登録が見つかりません。')
    return { id, role: row[2], project_ids: [], permission_overrides: [] }
  }
  // ロックを取った後の行(記録の一覧の差分を当てる)も、書き込みと同じくシートの読み込みに数えない(書き込みが同じ読み込みを使い回す)
  c.lockedRow_ = (name: string, id: string) => {
    const tb = sheet[name]
    const row = tb?.rows.find((r) => r[0] === id)
    return row ? Object.fromEntries(tb.headers.map((h, i) => [h, row[i]])) : null
  }
  c.findRowUnmeasured_ = (name: string, id: string) => {
    calls.push('sheet:' + name)
    const t = sheet[name]
    const row = t?.rows.find((r) => r[0] === id)
    return row ? Object.fromEntries(t.headers.map((h, i) => [h, row[i]])) : null
  }
  c.updateRowFieldsUnmeasured_ = (name: string, id: string, fields: Record<string, unknown>) => {
    writes.push({ sheet: name, id, fields })
    return { id, updated: Object.keys(fields) }
  }
  c.notifyScheduleChange_ = () => {}
  // カレンダーの予定は gas-calendar-sync.test.ts で確かめる
  c.syncCalendarForTask_ = () => {}
  c.updateRole = (memberId: string, role: string) => {
    writes.push({ sheet: 'Members', id: memberId, fields: { role } })
    return { ok: true }
  }
  c.assertTopRemains_ = () => {}
  c.requireKnownRole_ = () => {}
  const gas = ctx as unknown as { doPost: (e: object) => { text: string } } & Record<string, unknown>
  // 記録の一覧は、今の画面と同じく、今のシートの一覧との差分(listOps)にして送る
  const baseOf = (def: ListActionDef, id: string) => {
    const t = sheet[def.sheet]
    const row = t?.rows.find((r) => r[t.headers.indexOf('id')] === id)
    return parseListCell(row?.[t?.headers.indexOf(def.column) ?? -1])
  }
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(withListOps(body as Record<string, unknown>, baseOf)) } }).text)
  // スナップショットのキャッシュを作っておく(読み取り・ログインの後の状態)
  const warm = () => { post({ action: 'getBackgroundData', sessionToken: 'm-base' }); calls.length = 0 }
  const setRole = (id: string, role: string) => { sheet.Members.rows.find((r) => r[0] === id)![2] = role }
  return { c, gas, post, props, propWrites, sheet, calls, writes, hooks, advance, warm, setRole, locks: () => locks }
}

const sheetReads = (calls: string[]) => calls.filter((c) => c.startsWith('sheet:'))

describe('書き込みの認証', () => {
  it('普通の書き込みは、スナップショットでメンバー・役職・タスクを判定する(シートを読まない)', () => {
    const t = setup()
    t.warm()
    // 担当者だけができる操作(タスクの担当者の確認もスナップショットの Tasks で行う)
    const res = t.post({ action: 'updateHistory', sessionToken: 'm-base', taskId: 't1', history: [{ id: 'h1', at: '2026-10-01', byId: 'm-base', field: 'deadline', from: '', to: '2026-10-10' }] })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.timing.authFrom).toBe('snapshot')
    expect(sheetReads(t.calls)).toEqual([])
    expect(t.writes).toHaveLength(1)
  })

  it('スナップショットのキャッシュが無い時は、作り直して判定する(次の読み取りでも使える)', () => {
    const t = setup()
    const res = t.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: 30 })
    expect(res.ok).toBe(true)
    expect(res.timing.authFrom).toBe('snapshot')
    expect(sheetReads(t.calls)).toEqual(['sheet:snapshot'])
  })

  it('権限そのものを変える操作は、これまでどおりシートから読んで判定する', () => {
    const t = setup()
    t.warm()
    const res = t.post({ action: 'updateRole', sessionToken: 'm-top', memberId: 'm-base', role: 'r-lead' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.timing.authFrom).toBe('sheet')
    expect(t.calls).toContain('sheet:Members')
  })

  it('権限を変える操作の後は版が変わり、次の書き込みは新しい役職で判定する', () => {
    const t = setup()
    t.warm()
    expect(t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' }).ok).toBe(true)
    // 代表が班長を一般に下げる(アプリからの変更。版が変わる)
    t.setRole('m-lead', 'base')
    expect(t.post({ action: 'updateRole', sessionToken: 'm-top', memberId: 'm-lead', role: 'base' }).ok).toBe(true)
    const res = t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-11' })
    expect(res.ok).toBe(false)
    expect(res.forbidden).toBe(true)
  })

  it('判定の後・ロックを取るまでに版が変わったら(ほかの書き込みで役職が下がった)、シートから判定し直して断る', () => {
    const t = setup()
    t.warm()
    t.hooks.onLock = () => {
      // ロックを待っている間に、ほかの実行が役職を下げて版を変えた
      t.setRole('m-lead', 'base')
      t.props.DATA_VERSION = 'v-other-write'
    }
    const res = t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' })
    expect(res.ok).toBe(false)
    expect(res.forbidden).toBe(true)
    expect(res.timing.authRecheck).toBe('sheet')
    expect(t.calls).toContain('sheet:Members')
    // 書き込みはしていない
    expect(t.writes).toEqual([])
  })

  it('判定し直しても許可されれば、そのまま書き込む。版が変わらなければ判定し直さない', () => {
    const t = setup()
    t.warm()
    t.hooks.onLock = () => { t.props.DATA_VERSION = 'v-other-write' }
    const res = t.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.timing.authRecheck).toBe('sheet')
    expect(t.writes).toHaveLength(1)

    const u = setup()
    u.warm()
    const res2 = u.post({ action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' })
    expect(res2.timing.authRecheck).toBeUndefined()
    expect(sheetReads(u.calls)).toEqual([])
  })

  it('判定し直した時にメンバーが削除されていたら、ログインし直しにする', () => {
    const t = setup()
    t.warm()
    t.hooks.onLock = () => {
      t.sheet.Members.rows = t.sheet.Members.rows.filter((r) => r[0] !== 'm-base')
      t.props.DATA_VERSION = 'v-removed'
    }
    const res = t.post({ action: 'updateProgress', sessionToken: 'm-base', taskId: 't1', progressPercent: 30 })
    expect(res.authError).toBe(true)
    expect(t.writes).toEqual([])
  })

  it('代表だけ・全権管理者だけの操作は、すべてシートから判定する一覧(SHEET_AUTH_ACTIONS)に入っている', () => {
    const t = setup()
    const sheetAuth = new Set(t.gas.SHEET_AUTH_ACTIONS as string[])
    const snapshotAuth = new Set(t.gas.SNAPSHOT_AUTH_ACTIONS as string[])
    // できる操作(capability)のまとまりの操作と、最上位だけの操作(今までの代表だけ・全権管理者だけ)
    const capabilityActions = t.gas.CAPABILITY_ACTIONS as Record<string, string[]>
    const actions = [...Object.values(capabilityActions).flat(), ...(t.gas.TOP_ONLY_ACTIONS as string[])]
    expect(actions.length).toBeGreaterThan(25)
    // 読み取り(getWebhookStatus など)は、#31 からスナップショットで判定する
    expect(actions.filter((a) => !sheetAuth.has(a) && !snapshotAuth.has(a))).toEqual([])
    for (const a of ['updateRole', 'removeMember', 'updatePermissionOverrides', 'updateMemberProjects', 'updateRoles', 'updateSetting']) expect(sheetAuth.has(a), a).toBe(true)
  })
})

describe('まとめて送られた書き込み(batch)', () => {
  const history = [{ id: 'h1', at: '2026-10-01', byId: 'm-lead', field: 'deadline', from: '', to: '2026-10-10' }]

  it('日程の変更と変更の記録を1回で受け取り、両方を実行する', () => {
    const t = setup()
    t.warm()
    t.propWrites.length = 0
    const res = t.post({
      action: 'batch',
      sessionToken: 'm-lead',
      requestId: 'batch-0001',
      ops: [
        { action: 'updateHistory', taskId: 't1', history, requestId: 'op-0001' },
        { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10', requestId: 'op-0002' },
      ],
    })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.result.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true])
    // 記録は、変更そのもの(日程)の後に書く
    expect(t.writes.map((w) => Object.keys(w.fields)[0])).toEqual(['start_date', 'history_json'])
  })

  it('ロックは batch 全体で1回、データの版は1回だけ新しくする', () => {
    const t = setup()
    t.warm()
    const before = t.locks()
    t.propWrites.length = 0
    t.post({
      action: 'batch',
      sessionToken: 'm-lead',
      ops: [
        { action: 'updateHistory', taskId: 't1', history },
        { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
        { action: 'updateProgress', taskId: 't1', progressPercent: 10 },
      ],
    })
    expect(t.locks() - before).toBe(1)
    expect(t.propWrites.filter((k) => k === 'DATA_VERSION')).toHaveLength(1)
  })

  it('操作ごとに1本ずつ送った時と同じ権限の確認をする。断られた操作があっても、ほかは実行する', () => {
    const t = setup()
    t.warm()
    const res = t.post({
      action: 'batch',
      sessionToken: 'm-base',
      ops: [
        { action: 'updateProgress', taskId: 't1', progressPercent: 30 },
        // 日程の変更は管理者だけ
        { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.result.results[0].ok).toBe(true)
    expect(res.result.results[1]).toMatchObject({ ok: false, forbidden: true })
    expect(t.writes.map((w) => Object.keys(w.fields))).toEqual([['last_activity', 'progress_percent']])
  })

  it('1つの操作が失敗しても、ほかの操作は実行する', () => {
    const t = setup()
    t.warm()
    const res = t.post({
      action: 'batch',
      sessionToken: 'm-lead',
      ops: [
        { action: 'updateHistory', taskId: 't1', listOps: 'not-an-array' },
        { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
      ],
    })
    expect(res.result.results[0].ok).toBe(false)
    expect(res.result.results[1].ok).toBe(true)
  })

  it('権限そのものを変える操作が入っていれば、シートから判定する', () => {
    const t = setup()
    t.warm()
    const res = t.post({
      action: 'batch',
      sessionToken: 'm-top',
      ops: [
        { action: 'updateProgress', taskId: 't1', progressPercent: 30 },
        { action: 'updateRole', memberId: 'm-base', role: 'r-lead' },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.timing.authFrom).toBe('sheet')
  })

  it('送り直された batch(同じ requestId)は、処理をやり直さずに前回の結果を返す', () => {
    const t = setup()
    t.warm()
    const body = { action: 'batch', sessionToken: 'm-lead', requestId: 'batch-retry-1', ops: [{ action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' }] }
    const first = t.post(body)
    const second = t.post(body)
    expect(first.ok).toBe(true)
    expect(second.replayed).toBe(true)
    expect(second.result).toEqual(first.result)
    expect(t.writes).toHaveLength(1)
  })

  it('まとめて送れない操作(ログイン・読み取り・ロックを取らない操作・batch の入れ子)や、21件以上は断る', () => {
    const t = setup()
    for (const action of ['getInitialData', 'exchangeIdToken', 'batch', 'getExpenses', 'revokeMySessions']) {
      const res = t.post({ action: 'batch', sessionToken: 'm-top', ops: [{ action }] })
      expect(res.ok, action).toBe(false)
      expect(res.error, action).toContain(action)
    }
    const many = Array.from({ length: 21 }, () => ({ action: 'updateProgress', taskId: 't1', progressPercent: 1 }))
    expect(t.post({ action: 'batch', sessionToken: 'm-top', ops: many }).ok).toBe(false)
    expect(t.post({ action: 'batch', sessionToken: 'm-top', ops: [] }).ok).toBe(false)
    expect(t.writes).toEqual([])
  })

  it('セッションが無効なら、batch 全体をログインし直しにする', () => {
    const t = setup()
    const res = t.post({ action: 'batch', ops: [{ action: 'updateProgress', taskId: 't1', progressPercent: 1 }] })
    expect(res.authError).toBe(true)
  })
})

describe('書き込みの内訳', () => {
  it('処理(シートの読み書き・通知の準備・メール)と、書き込みの確定・版の更新・送り直しの記録を分けて出す', () => {
    const t = setup()
    t.warm()
    t.c.updateRowFieldsUnmeasured_ = () => { t.advance(300); return {} }
    // 日程の変更の通知: タスクを読み(100)、宛先を調べ(50)、メールを2通(200ずつ)
    t.c.notifyScheduleChange_ = () => {
      ;(t.c.findRow_ as (s: string, id: string) => unknown)('Tasks', 't1')
      ;(t.c.notifyAdmins_ as (s: string, b: string) => void)('件名', '本文')
    }
    t.c.findRowUnmeasured_ = () => { t.advance(100); return {} }
    t.c.notifyAdminsUnmeasured_ = () => {
      t.advance(50)
      ;(t.c.sendMail_ as (o: object) => void)({})
      ;(t.c.sendMail_ as (o: object) => void)({})
    }
    t.c.sendMailUnmeasured_ = () => { t.advance(200) }
    const flush = (t.c.SpreadsheetApp as { flush: () => void })
    flush.flush = () => { t.advance(700) }
    const res = t.post({ action: 'updateSchedule', sessionToken: 'm-lead', requestId: 'req-timing-1', taskId: 't1', startDate: '', deadline: '2026-10-10' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.timing).toMatchObject({
      actionMs: 850,
      sheetWriteMs: 300,
      sheetReadMs: 100,
      notifyMs: 50,
      mailMs: 400,
      mailCount: 2,
      actionOtherMs: 0,
      flushMs: 700,
    })
    expect(typeof res.timing.versionBumpMs).toBe('number')
    expect(typeof res.timing.replayMs).toBe('number')
    // 内訳の合計と、内訳に無い時間(otherMs)で合計になる(処理の中の内訳を2回数えない)
    expect(res.timing.totalMs).toBe(1550)
    expect(res.timing.otherMs).toBe(0)
  })
})

describe('片方だけ成功すると困る組み合わせ(batch)', () => {
  const h = (id: string, field: string, byId = 'm-lead') => ({ id, at: '2026-10-01', byId, field, from: '', to: 'x' })
  // 期限(due_date)の書き込みだけ失敗させる
  const failSchedule = (t: ReturnType<typeof setup>) => {
    t.c.updateRowFieldsUnmeasured_ = (name: string, id: string, fields: Record<string, unknown>) => {
      if ('due_date' in fields) throw new Error('シートに書けませんでした')
      t.writes.push({ sheet: name, id, fields })
      return {}
    }
  }
  const written = (t: ReturnType<typeof setup>) => t.writes.map((w) => Object.keys(w.fields)[0])

  it('変更の記録は、変更そのものの後に実行する(画面は記録を先に送る)', () => {
    const t = setup()
    t.warm()
    const res = t.post({ action: 'batch', sessionToken: 'm-lead', ops: [
      { action: 'updateHistory', taskId: 't1', history: [h('h1', 'deadline'), h('h2', 'startDate')] },
      { action: 'updateSchedule', taskId: 't1', startDate: '2026-10-01', deadline: '2026-10-10' },
    ] })
    expect(res.result.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true])
    expect(written(t)).toEqual(['start_date', 'history_json'])
  })

  it('変更そのものが断られたら、その記録も書かない', () => {
    const t = setup()
    t.warm()
    // 一般のメンバーは日程を変えられない(記録だけなら担当者として書ける)
    const res = t.post({ action: 'batch', sessionToken: 'm-base', ops: [
      { action: 'updateHistory', taskId: 't1', history: [h('h1', 'deadline', 'm-base')] },
      { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
    ] })
    expect(res.result.results[1]).toMatchObject({ ok: false, forbidden: true })
    expect(res.result.results[0]).toMatchObject({ ok: false, skipped: true })
    expect(t.writes).toEqual([])
  })

  it('変更そのものが失敗したら、その記録も書かない', () => {
    const t = setup()
    t.warm()
    failSchedule(t)
    const res = t.post({ action: 'batch', sessionToken: 'm-lead', ops: [
      { action: 'updateHistory', taskId: 't1', history: [h('h1', 'deadline')] },
      { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
    ] })
    expect(res.result.results[1].ok).toBe(false)
    expect(res.result.results[0]).toMatchObject({ ok: false, skipped: true })
    expect(written(t)).toEqual([])
  })

  it('記録は、記録した項目を変える操作だけを前提にする(別の項目の変更が失敗しても書く)', () => {
    const t = setup()
    t.warm()
    failSchedule(t)
    const res = t.post({ action: 'batch', sessionToken: 'm-lead', ops: [
      { action: 'updateHistory', taskId: 't1', history: [h('h1', 'priority')] },
      { action: 'updatePriority', taskId: 't1', priority: 'high' },
      { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
    ] })
    expect(res.result.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false])
    expect(written(t)).toEqual(['priority', 'history_json'])
  })

  it('同じ batch に変更が無い記録・別のタスクの記録は、これまでどおり書く', () => {
    const t = setup()
    t.warm()
    failSchedule(t)
    const res = t.post({ action: 'batch', sessionToken: 'm-lead', ops: [
      { action: 'updateHistory', taskId: 't1', history: [h('h1', 'deadline')] },
      { action: 'updateSchedule', taskId: 't-other', startDate: '', deadline: '2026-10-10' },
    ] })
    expect(res.result.results[0].ok).toBe(true)
    expect(written(t)).toEqual(['history_json'])
  })

  it('コメントの保存が失敗したら、メンションの通知を送らない(通知は updateComments の中で、保存した後に送る)', () => {
    const t = setup()
    t.warm()
    const sent: string[] = []
    t.c.queueNotification_ = (id: string) => { sent.push(id) }
    t.c.updateRowFieldsUnmeasured_ = () => { throw new Error('シートに書けませんでした') }
    const res = t.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1', comments: [{ id: 'c1', byId: 'm-base', text: '@班長 見てください' }] })
    expect(res.ok).toBe(false)
    expect(sent).toEqual([])
  })

  it('確認待ちへの変更が失敗したら、確認タスクを作らない(画面は確認タスクを先に送る)', () => {
    const t = setup()
    t.warm()
    const created: unknown[] = []
    t.c.createTasks_ = (tasks: unknown[]) => { created.push(...tasks); return [] }
    t.c.notifyReview_ = () => {}
    t.c.updateRowFieldsUnmeasured_ = () => { throw new Error('シートに書けませんでした') }
    const res = t.post({ action: 'batch', sessionToken: 'm-base', ops: [
      { action: 'createTasks', tasks: [{ tempId: 'tmp', title: '確認: タスク', relatedReviewTaskId: 't1', assigneeIds: ['m-lead'] }] },
      { action: 'updateTaskStatus', taskId: 't1', status: 'review' },
    ] })
    expect(res.result.results[1].ok).toBe(false)
    expect(res.result.results[0]).toMatchObject({ ok: false, skipped: true })
    expect(created).toEqual([])
  })

  it('担当者の変更が失敗したら、その担当者をプロジェクトに加えない', () => {
    const t = setup()
    t.warm()
    t.c.syncCalendarForTask_ = () => {}
    t.c.updateRowFieldsUnmeasured_ = (name: string, id: string, fields: Record<string, unknown>) => {
      if ('assignee_id' in fields) throw new Error('シートに書けませんでした')
      t.writes.push({ sheet: name, id, fields })
      return {}
    }
    const res = t.post({ action: 'batch', sessionToken: 'm-lead', ops: [
      { action: 'assignTask', taskId: 't1', assigneeIds: ['m-lead'] },
      { action: 'updateProjectMembers', projectId: 'p1', memberIds: ['m-base', 'm-lead'] },
    ] })
    expect(res.result.results[1]).toMatchObject({ ok: false, skipped: true })
    expect(t.writes).toEqual([])
  })

  it('完了への変更が失敗したら、完了で付くスキルを書かない', () => {
    const t = setup()
    t.warm()
    t.c.updateRowFieldsUnmeasured_ = (name: string, id: string, fields: Record<string, unknown>) => {
      if ('status' in fields) throw new Error('シートに書けませんでした')
      t.writes.push({ sheet: name, id, fields })
      return {}
    }
    const res = t.post({ action: 'batch', sessionToken: 'm-base', ops: [
      { action: 'updateSkillLevels', memberId: 'm-base', levels: [{ skill: 'a', level: 2 }] },
      { action: 'updateTaskStatus', taskId: 't1', status: 'done' },
    ] })
    expect(res.result.results[0]).toMatchObject({ ok: false, skipped: true })
    expect(t.writes).toEqual([])
  })

  it('送り直した batch でも、前回と同じ結果(記録を書かなかったことを含む)を返す', () => {
    const t = setup()
    t.warm()
    failSchedule(t)
    const body = { action: 'batch', sessionToken: 'm-lead', requestId: 'batch-skip-1', ops: [
      { action: 'updateHistory', taskId: 't1', history: [h('h1', 'deadline')] },
      { action: 'updateSchedule', taskId: 't1', startDate: '', deadline: '2026-10-10' },
    ] }
    const first = t.post(body)
    t.c.updateRowFieldsUnmeasured_ = (name: string, id: string, fields: Record<string, unknown>) => { t.writes.push({ sheet: name, id, fields }); return {} }
    const second = t.post(body)
    expect(second.replayed).toBe(true)
    expect(second.result).toEqual(first.result)
    expect(t.writes).toEqual([])
  })
})

describe('まとめた書き込みの重複防止(requestId。PR #28)', () => {
  afterEach(() => setGasTransportDepsForTest(null))

  // 画面の送り方(gas-transport.ts)と GAS(doPost)をつなぐ。responses の順に、GAS の応答を届けるか・失うかを決める
  const connect = (t: ReturnType<typeof setup>, deliver: boolean[]) => {
    const sent: Record<string, unknown>[] = []
    let n = 0
    setGasTransportDepsForTest({
      fetch: async (_url, init) => {
        const body = String(init.body)
        sent.push(JSON.parse(body))
        const out = t.gas.doPost({ postData: { contents: body } }).text
        const ok = deliver[n++] ?? true
        // 処理は済んだが、結果の受け渡し(echo)が 404 になった
        return ok ? { status: 200, text: async () => out } : { status: 404, text: async () => '<html>Sorry, unable to open the file at this time.</html>' }
      },
      resourceTimings: () => [],
      sleep: async () => {},
      log: { info() {}, warn() {}, error() {} },
      newId: (() => { let i = 0; return () => `req-${String(++i).padStart(4, '0')}` })(),
    })
    return sent
  }
  const URL = 'https://script.google.com/macros/s/TEST/exec'

  it('まとめた1本の応答を受け取れず送り直しても、中の操作は1回だけ実行する(2回目は前回の結果を受け取る)', async () => {
    const t = setup()
    t.warm()
    const sent = connect(t, [false, true])
    const history = [{ id: 'h1', at: '2026-10-01', byId: 'm-lead', field: 'deadline', from: '', to: '2026-10-10' }]
    const [a, b] = await Promise.all([
      sendToGas(URL, { action: 'updateHistory', sessionToken: 'm-lead', taskId: 't1', listOps: history.map((entry) => ({ op: 'add', entry })) }),
      sendToGas(URL, { action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' }),
    ])
    // 同じ batch(同じ requestId)を2回送った
    expect(sent).toHaveLength(2)
    expect(sent[0].action).toBe('batch')
    expect(sent[1]).toEqual(sent[0])
    // 書き込みは1回ずつだけ
    expect(t.writes.map((w) => Object.keys(w.fields)[0])).toEqual(['start_date', 'history_json'])
    expect(a).toMatchObject({ ok: true, replayed: true })
    expect(b).toMatchObject({ ok: true, replayed: true })
  })

  it('2回とも応答を失っても、3回目まで同じ batch を送り、書き込みは1回だけ', async () => {
    const t = setup()
    t.warm()
    const sent = connect(t, [false, false, true])
    await Promise.all([
      sendToGas(URL, { action: 'updateProgress', sessionToken: 'm-lead', taskId: 't1', progressPercent: 40 }),
      sendToGas(URL, { action: 'updateSchedule', sessionToken: 'm-lead', taskId: 't1', startDate: '', deadline: '2026-10-10' }),
    ])
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map((b) => b.requestId)).size).toBe(1)
    expect(t.writes).toHaveLength(2)
  })

  it('別の操作から送った batch には、別の requestId を付ける(前の結果を受け取らない)', async () => {
    const t = setup()
    t.warm()
    const sent = connect(t, [true, true])
    const op = (p: number) => sendToGas(URL, { action: 'updateProgress', sessionToken: 'm-lead', taskId: 't1', progressPercent: p })
    await Promise.all([op(10), op(20)])
    await Promise.all([op(30), op(40)])
    expect(sent.map((b) => b.action)).toEqual(['batch', 'batch'])
    expect(sent[0].requestId).not.toBe(sent[1].requestId)
    expect(t.writes).toHaveLength(4)
  })
})
