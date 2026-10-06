import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SITE_GAS_CODE_PATH, checkGasCode, copySiteGasCode, gasCodeVersion, newestGasVersion } from './gas-code-copy'
import { ORG_TEMPLATE_COPY_URL } from './org-template'

const CODE = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')
const VERSION = gasCodeVersion(CODE)!
const res = (body: string, ok = true) => Promise.resolve({ ok, text: () => Promise.resolve(body) } as Response)

describe('コードをコピー', () => {
  it('まとめた Code.gs の版を読める', () => {
    expect(VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/)
  })

  it('最新の版と同じ時だけ、同じサイトの /gas/Code.gs をクリップボードに入れる', async () => {
    const copied: string[] = []
    const urls: string[] = []
    const fetchFn = ((url: string) => { urls.push(url); return res(CODE) }) as unknown as typeof fetch
    expect(await copySiteGasCode(VERSION, { fetch: fetchFn, writeText: async (t) => { copied.push(t) } })).toEqual({ ok: true, version: VERSION })
    expect(urls).toEqual([SITE_GAS_CODE_PATH])
    expect(copied).toEqual([CODE])
  })

  it('版が違う・GAS のコードではない・読めない時はコピーしない', async () => {
    const copied: string[] = []
    const writeText = async (t: string) => { copied.push(t) }
    expect(await copySiteGasCode('2099.01.01-1', { fetch: (() => res(CODE)) as unknown as typeof fetch, writeText })).toEqual({ ok: false, reason: 'mismatch', version: VERSION })
    expect(await copySiteGasCode(VERSION, { fetch: (() => res('<html>not found</html>')) as unknown as typeof fetch, writeText })).toMatchObject({ ok: false, reason: 'notGas' })
    expect(await copySiteGasCode(VERSION, { fetch: (() => res('', false)) as unknown as typeof fetch, writeText })).toMatchObject({ ok: false, reason: 'fetch' })
    expect(await copySiteGasCode(VERSION, { fetch: (() => Promise.reject(new Error('net'))) as unknown as typeof fetch, writeText })).toMatchObject({ ok: false, reason: 'fetch' })
    expect(copied).toEqual([])
    expect(checkGasCode("var OHSUMI_GAS_VERSION = '1'\nfunction doPost(e) {}", '1')).toEqual({ ok: true, version: '1' })
  })
})

describe('レジストリの管理画面の「新しい団体に渡すもの」', () => {
  it('版の一覧のうち一番新しい版を使う(日付・番号の順。日付の形でない版は数えない)', () => {
    expect(newestGasVersion(['2026.10.05-4', '2026.10.06-1', '2026.10.06-12', '2026.09.30-9', 'r1e-2'])).toBe('2026.10.06-12')
    expect(newestGasVersion(['r1e-2'])).toBeNull()
    expect(newestGasVersion([])).toBeNull()
  })
  it('テンプレートのコピーの URL は1か所の定数で、Google スプレッドシートの「コピーを作成」の形', () => {
    expect(ORG_TEMPLATE_COPY_URL).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/copy$/)
    const admin = readFileSync(join(__dirname, '..', '..', 'components', 'registry', 'registry-admin.tsx'), 'utf8')
    expect(admin).not.toContain('12CmKprd')
    expect(admin).toMatch(/rel="noopener noreferrer"/)
  })
})
