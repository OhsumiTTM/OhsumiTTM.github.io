// gas/Code.gs: 書き込みの認証・まとめて送られた書き込み(batch)・書き込みの内訳を確かめる。
//   - 普通の書き込みは、スナップショット(読み取りと同じキャッシュ)で判定する。権限そのものを変える操作は
//     シートから読む。ロックを取った後に版が変わっていたら、シートから判定し直す
//   - batch は、中の操作ごとに1本ずつ送った時と同じ権限の確認をし、ロック・版の更新は1回だけ
//   - 書き込みの内訳(処理・シートの読み書き・メール・書き込みの確定・版の更新)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

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

  const userError = (m: string) => (c.userError as (m: string) => Error)(m)
  c.authenticateRequest = (body: { sessionToken?: string }) => {
    if (!body.sessionToken) throw userError('ログインしていません。再ログインしてください。')
    return { memberId: body.sessionToken, renewed: null }
  }
  // スナップショットの作り直し(Sheets API)= シート全体を読む
  c.readSheetTables = () => { calls.push('sheet:snapshot'); return JSON.parse(JSON.stringify(sheet)) }
  c.readRoleSettings = () => { calls.push('sheet:Settings'); return { roles: ROLES } }
  c.getActingMemberById = (id: string) => {
    calls.push('sheet:Members')
    const row = sheet.Members.rows.find((r) => r[0] === id)
    if (!row) throw userError('メンバー登録が見つかりません。')
    return { id, role: row[2], project_ids: [], permission_overrides: [] }
  }
  c.findRowUnmeasured = (name: string, id: string) => {
    calls.push('sheet:' + name)
    const t = sheet[name]
    const row = t?.rows.find((r) => r[0] === id)
    return row ? Object.fromEntries(t.headers.map((h, i) => [h, row[i]])) : null
  }
  c.updateRowFieldsUnmeasured = (name: string, id: string, fields: Record<string, unknown>) => {
    writes.push({ sheet: name, id, fields })
    return { id, updated: Object.keys(fields) }
  }
  c.notifyScheduleChange = () => {}
  c.updateRole = (memberId: string, role: string) => {
    writes.push({ sheet: 'Members', id: memberId, fields: { role } })
    return { ok: true }
  }
  c.assertTopRemains = () => {}
  c.requireKnownRole = () => {}
  const gas = ctx as unknown as { doPost: (e: object) => { text: string } } & Record<string, unknown>
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
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
    const aStart = CODE_GS.indexOf('function authorizeAction(')
    const auth = CODE_GS.slice(aStart, CODE_GS.indexOf('\nfunction ', aStart + 10))
    const daihyoOnly = auth.slice(auth.indexOf('var daihyoOnly = ['), auth.indexOf('if (daihyoOnly.indexOf(action)'))
    const fullAdmin = auth.slice(auth.indexOf("if (action === 'updateSetting'"), auth.indexOf('if (isActingFullAdmin(acting)) return'))
    const actions = [...daihyoOnly.matchAll(/^\s*'(\w+)'/gm), ...fullAdmin.matchAll(/action === '(\w+)'/g)].map((m) => m[1])
    expect(actions.length).toBeGreaterThan(25)
    // 読み取り(getWebhookStatus など)は、#31 からスナップショットで判定する
    expect(actions.filter((a) => !sheetAuth.has(a) && !snapshotAuth.has(a))).toEqual([])
    for (const a of ['updateRole', 'removeMember', 'updatePermissionOverrides', 'updateMemberProjects', 'updateRoles', 'updateSetting']) expect(sheetAuth.has(a), a).toBe(true)
  })
})

describe('まとめて送られた書き込み(batch)', () => {
  const history = [{ id: 'h1', at: '2026-10-01', byId: 'm-lead', field: 'deadline', from: '', to: '2026-10-10' }]

  it('日程の変更と変更の記録を1回で受け取り、順番に実行する。ロック・版の更新は1回だけ', () => {
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
    expect(t.writes.map((w) => Object.keys(w.fields)[0])).toEqual(['history_json', 'start_date'])
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
        { action: 'updateHistory', taskId: 't1', history: 'not-an-array' },
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
    t.c.updateRowFieldsUnmeasured = () => { t.advance(300); return {} }
    // 日程の変更の通知: タスクを読み(100)、宛先を調べ(50)、メールを2通(200ずつ)
    t.c.notifyScheduleChange = () => {
      ;(t.c.findRow as (s: string, id: string) => unknown)('Tasks', 't1')
      ;(t.c.notifyAdmins as (s: string, b: string) => void)('件名', '本文')
    }
    t.c.findRowUnmeasured = () => { t.advance(100); return {} }
    t.c.notifyAdminsUnmeasured = () => {
      t.advance(50)
      ;(t.c.sendMail as (o: object) => void)({})
      ;(t.c.sendMail as (o: object) => void)({})
    }
    t.c.sendMailUnmeasured = () => { t.advance(200) }
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
