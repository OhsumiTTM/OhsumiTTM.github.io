// scripts/csp.mjs(ビルド後の HTML に CSP の meta タグを入れる)を確かめる。
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as csp from '../../scripts/csp.mjs'

const page = (body: string) =>
  `<!DOCTYPE html><html><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width"/>` +
  `<script src="/_next/static/chunks/a.js" async=""></script></head><body>${body}</body></html>`

const hashOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64')
const policyOf = (html: string) => html.match(/content="([^"]*)"/)![1].replace(/&quot;/g, '"')

describe('CSP の meta タグ', () => {
  it('インラインのスクリプトごとにハッシュを入れ、文字コードの指定の直後(スクリプトより前)に置く', () => {
    const a = 'self.__next_f.push([1,"日本語の文字列"])'
    const b = '(self.__next_f=self.__next_f||[]).push([0])'
    const html = csp.injectCsp(page(`<script>${a}</script><script>${b}</script><script type="application/json">{"x":1}</script>`))
    const policy = policyOf(html)
    expect(policy).toContain(`'sha256-${hashOf(a)}'`)
    expect(policy).toContain(`'sha256-${hashOf(b)}'`)
    // 実行されない JSON は対象外
    expect(policy).not.toContain(hashOf('{"x":1}'))
    expect(policy).not.toContain("'unsafe-inline' https://accounts.google.com/gsi/client")
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
    expect(html.indexOf('<meta charSet="utf-8"/>')).toBeLessThan(html.indexOf('Content-Security-Policy'))
    expect(csp.verifyCsp(html)).toEqual([])
  })

  it('もう一度入れても meta タグは1つだけ(置き換える)', () => {
    const once = csp.injectCsp(page('<script>x()</script>'))
    const twice = csp.injectCsp(once)
    expect(twice.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(csp.verifyCsp(twice)).toEqual([])
  })

  it('ハッシュが入っていないインラインのスクリプトがあれば、問題として返す', () => {
    const html = csp.injectCsp(page('<script>x()</script>'))
    // meta タグを入れた後に、別のインラインのスクリプトが増えた場合
    const tampered = html.replace('</body>', '<script>y()</script></body>')
    expect(csp.verifyCsp(tampered).join('\n')).toMatch(/ハッシュが CSP に入っていないインラインのスクリプト: y\(\)/)
  })

  it('中身を取り出せないインラインのスクリプト(閉じタグが無いなど)があれば、問題として返す', () => {
    const html = csp.injectCsp(page('<script>x()</script>'))
    const broken = html.replace('</body>', '<script>z()</body>')
    expect(csp.verifyCsp(broken).join('\n')).toMatch(/インラインのスクリプトの数が合いません/)
  })

  it('インラインのイベントハンドラーや javascript: の URL があれば、問題として返す', () => {
    const html = csp.injectCsp(page('<button onclick="go()">x</button><a href="javascript:alert(1)">y</a>'))
    const problems = csp.verifyCsp(html).join('\n')
    expect(problems).toMatch(/インラインのイベントハンドラー/)
    expect(problems).toMatch(/javascript: の URL/)
    // スクリプトの中の文字列は対象外
    expect(csp.verifyCsp(csp.injectCsp(page('<script>var s="<a onclick=x>"</script>')))).toEqual([])
  })

  it('カレンダーの接続先は、予定の表示を有効にした場合だけ入れる', () => {
    expect(csp.buildPolicy({ calendarRead: false })).not.toContain('https://www.googleapis.com/calendar/v3/')
    expect(csp.buildPolicy({ calendarRead: true })).toContain('https://www.googleapis.com/calendar/v3/')
  })

  it('ロゴの送り先は NEXT_PUBLIC_SUPABASE_URL がある時だけ、logos バケットの場所を1つだけ入れる', () => {
    const connect = (o: object) => csp.buildPolicy(o).split('; ').find((d: string) => d.startsWith('connect-src '))!
    const without = connect({})
    expect(without).not.toContain('supabase')
    const withUrl = connect({ supabaseUrl: 'https://abcdefgh.supabase.co' })
    expect(withUrl).toBe(without + ' https://abcdefgh.supabase.co/storage/v1/object/logos/')
    expect(connect({ supabaseUrl: 'https://abcdefgh.supabase.co/' })).toBe(withUrl)
    // origin 全体や *.supabase.co は入れない
    expect(withUrl).not.toMatch(/https:\/\/abcdefgh\.supabase\.co(\s|$)/)
    expect(csp.buildPolicy({ supabaseUrl: 'https://abcdefgh.supabase.co' })).not.toContain('*.supabase.co')
    // ほかの指定は変えない
    const rest = (p: string) => p.split('; ').filter((d: string) => !d.startsWith('connect-src ')).join('; ')
    expect(rest(csp.buildPolicy({ supabaseUrl: 'https://abcdefgh.supabase.co' }))).toBe(rest(csp.buildPolicy({})))
  })

  it('NEXT_PUBLIC_SUPABASE_URL の値が変な時はビルドを失敗させる(https・<プロジェクト>.supabase.co だけ)', () => {
    for (const bad of ['http://abcdefgh.supabase.co', 'https://evil.example.com', 'https://abcdefgh.supabase.co.evil.com', 'https://a.b.supabase.co',
      'https://abcdefgh.supabase.co:8443', 'https://abcdefgh.supabase.co/storage', 'https://abcdefgh.supabase.co?x=1', 'not a url', 'https://user:pw@abcdefgh.supabase.co']) {
      expect(() => csp.buildPolicy({ supabaseUrl: bad }), bad).toThrow()
    }
    expect(csp.logoUploadConnectSources('')).toEqual([])
    expect(csp.logoUploadConnectSources(undefined)).toEqual([])
  })

  it('必要な接続先を許可し、unsafe-inline のスクリプトや unsafe-eval は許可しない', () => {
    const policy = csp.buildPolicy({ scriptHashes: ['abc'] })
    const directive = (name: string) => policy.split('; ').find((d: string) => d.startsWith(name + ' ')) ?? ''
    expect(directive('script-src')).toBe("script-src 'self' https://accounts.google.com/gsi/client 'sha256-abc'")
    for (const host of ['https://script.google.com', 'https://script.googleusercontent.com', 'https://accounts.google.com/gsi/', 'https://sheets.googleapis.com', 'https://docs.google.com/forms/']) {
      expect(directive('connect-src')).toContain(host)
    }
    expect(directive('frame-src')).toBe('frame-src https://accounts.google.com/gsi/')
    expect(directive('img-src')).toBe("img-src 'self' data: blob: https:")
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(policy).not.toContain('unsafe-eval')
    // 以前のログイン方式(アクセストークン)だけが使っていた接続先は許可しない
    expect(policy).not.toContain('https://www.googleapis.com/oauth2/')
  })

  it('出力フォルダの HTML すべてに入れ、<head> の無いファイル(サイト確認用)は変えない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-'))
    mkdirSync(join(dir, 'about'))
    writeFileSync(join(dir, 'index.html'), page('<script>a()</script>'))
    writeFileSync(join(dir, 'about', 'index.html'), page('<script>b()</script>'))
    writeFileSync(join(dir, 'google123.html'), 'google-site-verification: google123.html')
    const result = csp.applyCspToDirectory(dir)
    expect(result).toEqual({ count: 2, failures: [] })
    expect(readFileSync(join(dir, 'about', 'index.html'), 'utf8')).toContain(`'sha256-${hashOf('b()')}'`)
    expect(readFileSync(join(dir, 'google123.html'), 'utf8')).toBe('google-site-verification: google123.html')

    writeFileSync(join(dir, 'bad.html'), page('<div onmouseover="x()"></div>'))
    expect(csp.applyCspToDirectory(dir).failures.join('\n')).toMatch(/bad\.html[\s\S]*インラインのイベントハンドラー/)
  })
})
