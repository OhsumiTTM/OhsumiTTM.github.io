// 申請フォームの団体ロゴのアップロード(lib/site/logo-upload.ts): 名前・大きさ・種類の確かめと、Supabase Storage への送り方
import { describe, expect, it } from 'vitest'
import { LOGO_MAX_BYTES, checkLogoFile, logoExtension, logoObjectName, logoPublicUrl, uploadLogo } from './logo-upload'

const BASE = 'https://abcdefgh.supabase.co'
const config = { url: BASE, anonKey: 'anon-key-for-test' }
const fileOf = (name: string, size: number, type = '') => {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('ロゴの名前', () => {
  it('ohsumi-<時刻>-<乱数8文字>.<拡張子>。団体名や元のファイル名は使わない', () => {
    expect(logoObjectName('png', 1760000000000, '1234abcd-ef01-4567-89ab-cdef01234567')).toBe('ohsumi-1760000000000-1234abcd.png')
    const name = logoObjectName('svg')
    expect(name).toMatch(/^ohsumi-\d+-[0-9a-f]{8}\.svg$/)
  })
  it('公開 URL は public/logos/public/<名前>', () => {
    expect(logoPublicUrl(BASE, 'ohsumi-1-a.png')).toBe(`${BASE}/storage/v1/object/public/logos/public/ohsumi-1-a.png`)
  })
})

describe('送る前の確かめ', () => {
  it('拡張子は png・jpg・jpeg・svg・webp・ai だけ(大文字も可)', () => {
    for (const n of ['a.png', 'a.JPG', 'a.jpeg', 'a.svg', 'a.webp', 'logo.ai']) expect(logoExtension(n), n).not.toBeNull()
    for (const n of ['a.gif', 'a.pdf', 'a.png.exe', 'a', 'a.html', 'a.svgz']) expect(logoExtension(n), n).toBeNull()
    expect(checkLogoFile({ name: 'a.gif', size: 10 })).toMatch(/PNG・JPG・SVG・WebP・AI/)
  })
  it('10MB まで。空のファイルも断る', () => {
    expect(checkLogoFile({ name: 'a.png', size: LOGO_MAX_BYTES })).toBeNull()
    expect(checkLogoFile({ name: 'a.png', size: LOGO_MAX_BYTES + 1 })).toMatch(/10MB/)
    expect(checkLogoFile({ name: 'a.png', size: 0 })).toMatch(/空/)
  })
})

describe('uploadLogo', () => {
  it('logos/public/<名前> に anon key で POST し(上書きしない)、公開 URL を返す', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const res = await uploadLogo(fileOf('団体の正式名称ロゴ.PNG', 2048, 'image/png'), {
      config, now: 1760000000000, uuid: 'deadbeef-0000-0000-0000-000000000000',
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) }) as typeof fetch,
    })
    expect(res).toEqual({ ok: true, url: `${BASE}/storage/v1/object/public/logos/public/ohsumi-1760000000000-deadbeef.png` })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/storage/v1/object/logos/public/ohsumi-1760000000000-deadbeef.png`)
    expect(calls[0].url).not.toContain('団体')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toEqual({ apikey: 'anon-key-for-test', Authorization: 'Bearer anon-key-for-test', 'Content-Type': 'image/png', 'x-upsert': 'false' })
  })

  it('種類が分からない .ai は application/postscript で送る', async () => {
    let type = ''
    await uploadLogo(fileOf('logo.ai', 100), { config, fetch: (async (_u: string, init: RequestInit) => { type = (init.headers as Record<string, string>)['Content-Type']; return new Response('{}') }) as typeof fetch })
    expect(type).toBe('application/postscript')
  })

  it('確かめで断ったファイル・設定が無い時は送らない。失敗は日本語の文で返す', async () => {
    let sent = 0
    const f = (async () => { sent++; return new Response('{}', { status: 200 }) }) as typeof fetch
    expect(await uploadLogo(fileOf('a.png', LOGO_MAX_BYTES + 1), { config, fetch: f })).toMatchObject({ ok: false, error: expect.stringMatching(/10MB/) })
    expect(await uploadLogo(fileOf('a.gif', 10), { config, fetch: f })).toMatchObject({ ok: false })
    expect(await uploadLogo(fileOf('a.png', 10), { config: { url: '', anonKey: '' }, fetch: f })).toMatchObject({ ok: false, error: expect.stringMatching(/受け付けられません/) })
    expect(sent).toBe(0)
    const status = (code: number) => (async () => new Response('{}', { status: code })) as typeof fetch
    expect(await uploadLogo(fileOf('a.png', 10), { config, fetch: status(403) })).toMatchObject({ ok: false, error: expect.stringMatching(/送れませんでした\(403\)/) })
    expect(await uploadLogo(fileOf('a.png', 10), { config, fetch: status(413) })).toMatchObject({ ok: false, error: expect.stringMatching(/大きすぎます/) })
    const offline = (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch
    expect(await uploadLogo(fileOf('a.png', 10), { config, fetch: offline })).toMatchObject({ ok: false, error: expect.stringMatching(/通信/) })
  })

  it('キーの値をコードに書かず、service_role のキーを読まない(使うのは anon key の環境変数だけ)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..', '..')
    for (const p of ['lib/site/logo-upload.ts', 'components/site/apply-form-client.tsx', 'components/site/google-form.tsx', '.github/workflows/deploy.yml']) {
      const text = readFileSync(join(root, p), 'utf8')
      // JWT の形のキーの値
      expect(text, p).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/)
      // service_role のキーを読む環境変数・Secrets
      expect(text, p).not.toMatch(/(process\.env\.|secrets\.)[A-Z_]*SERVICE/i)
      expect(text.match(/(?:process\.env\.|secrets\.)[A-Z_]*SUPABASE[A-Z_]*/g) ?? [], p).toSatisfy((names: string[]) =>
        names.every((n) => /SUPABASE_(URL|ANON_KEY)$/.test(n)))
    }
  })
})
