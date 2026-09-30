// gas/Code.gs: doGet が JSON(GET で届いたこと)を返すこと、doPost の応答に GAS の中の
// 処理時間の内訳(timing)が付くことを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

function setup(opts: { apiFails?: boolean } = {}) {
  const cache = new Map<string, string>()
  const props: Record<string, string> = { DATA_VERSION: 'v1' }
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: string) => { props[k] = v } }) },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this } }) },
    CacheService: { getScriptCache: () => ({
      get: (k: string) => cache.get(k) ?? null,
      getAll: (keys: string[]) => Object.fromEntries(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])),
      put: (k: string, v: string) => { cache.set(k, v) },
      putAll: (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) cache.set(k, v) },
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { flush() {} },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
    Utilities: { formatDate: () => '2026-10-01' },
  })
  vm.runInContext(CODE_GS, ctx)
  const c = ctx as unknown as Record<string, unknown>
  c.authenticateRequest_ = () => ({ memberId: 'm1', renewed: null })
  c.getActingMemberById_ = (id: string) => ({ id })
  c.authorizeAction_ = () => {}
  c.bumpDataVersion = () => {}
  c.updateTaskFields_ = () => ({ ok: true })
  c.buildViewerData_ = () => ({ Members: { headers: [], rows: [] } })
  const tables = { Members: { headers: ['id'], rows: [['m1']] } }
  c.readSheetTablesViaApi_ = () => (opts.apiFails ? { error: 'HTTP 403: Sheets API has not been used' } : { tables })
  c.readSheetTablesViaSpreadsheetApp_ = () => tables
  // キャッシュは JSON のまま持つ(gzip は Apps Script だけのため)
  c.readSnapshotCache_ = (v: string) => (cache.has('snap:' + v) ? JSON.parse(cache.get('snap:' + v)!) : null)
  c.writeSnapshotCache_ = (v: string, d: unknown) => { cache.set('snap:' + v, JSON.stringify(d)); return true }
  const gas = ctx as unknown as { doPost: (e: object) => { text: string }; doGet: (e?: object) => { text: string } }
  const post = (body: object) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).text)
  return { gas, post }
}

describe('GET で届いた時(doGet)', () => {
  it('HTML ではなく、GET で届いたことが分かる JSON を返す(何も処理していない)', () => {
    const res = JSON.parse(setup().gas.doGet({ parameter: {} }).text)
    expect(res).toMatchObject({ ok: false, getReceived: true })
    expect(res.error).toMatch(/GET で届きました/)
  })
})

describe('処理時間の内訳(timing)', () => {
  it('初期データ: キャッシュが無い時はシートの読み込み(方式)と絞り込み、次はキャッシュ、版が同じなら unchanged', () => {
    const t = setup()
    const first = t.post({ action: 'getInitialData', sessionToken: 's' })
    expect(first.ok).toBe(true)
    expect(first.timing).toMatchObject({ cache: 'miss', read: 'api' })
    for (const k of ['totalMs', 'authMs', 'readMs', 'filterMs', 'cacheReadMs', 'cacheWriteMs']) expect(typeof first.timing[k], k).toBe('number')
    expect(first.timing.lockMs).toBeUndefined() // 読み取りはロックを取らない
    const second = t.post({ action: 'getInitialData', sessionToken: 's' })
    expect(second.timing).toMatchObject({ cache: 'hit' })
    expect(second.timing.readMs).toBeUndefined()
    const same = t.post({ action: 'getInitialData', sessionToken: 's', knownVersion: 'v1' })
    expect(same.timing).toMatchObject({ cache: 'unchanged' })
  })

  it('Sheets API で読めず予備の方式に切り替えた時は、その理由を返す', () => {
    const res = setup({ apiFails: true }).post({ action: 'getInitialData', sessionToken: 's' })
    expect(res.timing).toMatchObject({ cache: 'miss', read: 'spreadsheetApp', readError: 'HTTP 403: Sheets API has not been used' })
  })

  it('書き込みはロックの待ちを返す', () => {
    const res = setup().post({ action: 'updateTaskStatus', sessionToken: 's', taskId: 't1', status: 'doing' })
    expect(res.ok).toBe(true)
    expect(typeof res.timing.lockMs).toBe('number')
    expect(typeof res.timing.authMs).toBe('number')
  })
})
