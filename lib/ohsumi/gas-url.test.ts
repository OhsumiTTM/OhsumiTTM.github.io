// 団体の GAS の URL の形(lib/ohsumi/gas-url.ts)と、ビルドの前の確認(scripts/check-gas-url.mjs)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gasUrlLevel } from '../../scripts/check-gas-url.mjs'
import { checkGasUrl } from './gas-url'

const ROOT = join(__dirname, '..', '..')
const CASES: [string, 'ok' | 'warn' | 'error'][] = [
  ['https://script.google.com/macros/s/AKfycbx-abc_123/exec', 'ok'],
  ['', 'ok'],
  ['https://script.google.com/macros/u/1/s/AKfycbx-abc_123/exec', 'error'],
  ['https://script.google.com/a/macros/example.ac.jp/s/AKfycbx/exec', 'warn'],
  ['https://script.google.com/a/macros/example.ac.jp/u/0/s/AKfycbx/exec', 'error'],
  ['https://script.google.com/macros/s/AKfycbx-abc_123/dev', 'error'],
  ['https://script.google.com/macros/s/AKfycbx-abc_123/exec?x=1', 'error'],
  ['http://script.google.com/macros/s/AKfycbx/exec', 'error'],
  ['https://script.googleusercontent.com/macros/echo?user_content_key=x', 'error'],
]

describe('GAS の URL の形', () => {
  it('デプロイの /exec の URL だけを通し、/u/数字/・/dev・形の違うものは止める。画面とビルドで同じ判定', () => {
    for (const [url, level] of CASES) {
      expect(checkGasUrl(url).level, url).toBe(level)
      expect(gasUrlLevel(url), url).toBe(level)
    }
    expect(checkGasUrl('https://script.google.com/macros/u/1/s/x/exec').message).toMatch(/\/u\/数字\//)
  })

  it('ビルドの最初に確かめ、形が違えばビルドを止める。値そのものは表示しない', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.build).toMatch(/^node scripts\/check-gas-url\.mjs && /)
    const bad = 'https://script.google.com/macros/u/1/s/SECRET_ID_123/exec'
    const r = spawnSync('node', ['scripts/check-gas-url.mjs'], { cwd: ROOT, env: { ...process.env, NEXT_PUBLIC_GAS_URL: bad }, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/形が正しくありません/)
    expect(r.stderr + r.stdout).not.toContain('SECRET_ID_123')
    const good = spawnSync('node', ['scripts/check-gas-url.mjs'], { cwd: ROOT, env: { ...process.env, NEXT_PUBLIC_GAS_URL: CASES[0][0] }, encoding: 'utf8' })
    expect(good.status).toBe(0)
  })
})
