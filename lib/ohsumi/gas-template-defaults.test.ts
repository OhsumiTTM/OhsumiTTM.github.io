// テンプレートから作る団体: レジストリの URL・ログインのクライアント ID は、コードの既定値をスクリプトプロパティが上書きする。
// setupOhsumi は、プロパティが無ければ既定値を保存する。ウェブアプリの URL は、/dev しか分からない時、ブラウザで開いた時に覚えた URL を使う
import { describe, expect, it } from 'vitest'
import { guardHarness, noop } from './gas-guard-harness'

const REG = 'https://script.google.com/macros/s/REGISTRY/exec'
const CLIENT = 'template-client.apps.googleusercontent.com'
type Fn = (...a: unknown[]) => unknown

describe('テンプレートの既定値', () => {
  it('コードに入れた既定値は、形が正しい(レジストリの /exec・OAuth クライアント ID)', () => {
    const c = guardHarness().c as Record<string, unknown>
    expect(c.DEFAULT_REGISTRY_URL).toMatch(/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/)
    expect(c.DEFAULT_GOOGLE_OAUTH_CLIENT_ID).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/)
  })

  it('プロパティがあればプロパティ、無ければコードの既定値を使う', () => {
    const h = guardHarness()
    const c = h.c as Record<string, unknown>
    c.DEFAULT_REGISTRY_URL = ''
    c.DEFAULT_GOOGLE_OAUTH_CLIENT_ID = ''
    expect((c.registryUrlOf_ as Fn)({})).toBe('')
    c.DEFAULT_REGISTRY_URL = REG
    c.DEFAULT_GOOGLE_OAUTH_CLIENT_ID = CLIENT
    expect((c.registryUrlOf_ as Fn)({})).toBe(REG)
    expect((c.registryUrlOf_ as Fn)({ REGISTRY_URL: 'https://script.google.com/macros/s/OTHER/exec' })).toBe('https://script.google.com/macros/s/OTHER/exec')
    expect((c.googleOAuthClientIdOf_ as Fn)({})).toBe(CLIENT)
    expect((c.googleOAuthClientIdOf_ as Fn)({ GOOGLE_OAUTH_CLIENT_ID: 'own.apps.googleusercontent.com' })).toBe('own.apps.googleusercontent.com')
  })

  it('setupOhsumi の前に、無いプロパティにだけ既定値を保存する(形の正しい値だけ)', () => {
    const h = guardHarness()
    const c = h.c as Record<string, unknown>
    const props = { getProperty: (k: string) => h.props[k] ?? null, setProperty: (k: string, v: string) => { h.props[k] = v } }
    c.DEFAULT_REGISTRY_URL = ''
    c.DEFAULT_GOOGLE_OAUTH_CLIENT_ID = ''
    expect((c.saveCodeDefaultsToProps_ as Fn)(props)).toEqual([])
    c.DEFAULT_REGISTRY_URL = REG
    c.DEFAULT_GOOGLE_OAUTH_CLIENT_ID = CLIENT
    h.props.GOOGLE_OAUTH_CLIENT_ID = 'own.apps.googleusercontent.com'
    expect((c.saveCodeDefaultsToProps_ as Fn)(props)).toEqual(['REGISTRY_URL'])
    expect([h.props.REGISTRY_URL, h.props.GOOGLE_OAUTH_CLIENT_ID]).toEqual([REG, 'own.apps.googleusercontent.com'])
    c.DEFAULT_REGISTRY_URL = 'https://example.com/not-a-registry'
    delete h.props.REGISTRY_URL
    expect((c.saveCodeDefaultsToProps_ as Fn)(props)).toEqual([])
  })

  it('ウェブアプリの URL: /dev しか分からない時は、ブラウザで開いた時(doGet)に覚えた /exec の URL を使う', () => {
    const h = guardHarness()
    const c = h.c as Record<string, unknown>
    let live = 'https://script.google.com/macros/s/DEPLOY/dev'
    c.ScriptApp = noop({ getService: () => ({ getUrl: () => live }) })
    expect((c.ownWebAppUrl_ as Fn)({})).toBe(live)
    // ウェブアプリとして開かれた時は /exec が分かる
    live = 'https://script.google.com/macros/s/DEPLOY/exec'
    ;(c.doGet as Fn)({ parameter: {} })
    expect(h.props.DETECTED_WEBAPP_URL).toBe(live)
    live = 'https://script.google.com/macros/s/DEPLOY/dev'
    expect((c.ownWebAppUrl_ as Fn)({ DETECTED_WEBAPP_URL: h.props.DETECTED_WEBAPP_URL })).toBe('https://script.google.com/macros/s/DEPLOY/exec')
    // プロパティ OHSUMI_WEBAPP_URL がいちばん先
    expect((c.ownWebAppUrl_ as Fn)({ OHSUMI_WEBAPP_URL: 'https://script.google.com/macros/s/SET/exec', DETECTED_WEBAPP_URL: 'x' })).toBe('https://script.google.com/macros/s/SET/exec')
  })
})
