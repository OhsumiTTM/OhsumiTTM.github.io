// 団体の GAS の URL の形(lib/ohsumi/gas-url.ts)と、ビルドの前の確認(scripts/check-registry-url.mjs)
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registryUrlLevel } from '../../scripts/check-registry-url.mjs'
import { CANONICAL_GAS_URL } from './gas-url'

const ROOT = join(__dirname, '..', '..')
const run = (env: Record<string, string>) =>
  spawnSync('node', [join(ROOT, 'scripts', 'check-registry-url.mjs')], { env: { ...process.env, NEXT_PUBLIC_GAS_URL: '', NEXT_PUBLIC_REGISTRY_URL: '', ...env }, encoding: 'utf8' })

describe('団体の GAS の URL の形', () => {
  it('デプロイの /exec の URL だけを使う(/u/数字/・/dev・Workspace の形・? 付きは使わない)', () => {
    expect(CANONICAL_GAS_URL.test('https://script.google.com/macros/s/AKfycbx-abc_123/exec')).toBe(true)
    for (const url of [
      '',
      'https://script.google.com/macros/u/1/s/AKfycbx-abc_123/exec',
      'https://script.google.com/a/macros/example.ac.jp/s/AKfycbx/exec',
      'https://script.google.com/macros/s/AKfycbx-abc_123/dev',
      'https://script.google.com/macros/s/AKfycbx-abc_123/exec?x=1',
      'http://script.google.com/macros/s/AKfycbx/exec',
    ]) expect(CANONICAL_GAS_URL.test(url), url).toBe(false)
  })
})

describe('ビルドの前の確認', () => {
  it('ビルドの最初に確かめる', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.build).toMatch(/^node scripts\/check-registry-url\.mjs && /)
  })

  it('レジストリの URL は /macros/s/…/exec の形だけを受け付け、違えばビルドを止める(未設定はよい)。値そのものは表示しない', () => {
    expect(registryUrlLevel('https://script.google.com/macros/s/AKfycbx-abc_123/exec')).toBe('ok')
    expect(registryUrlLevel('')).toBe('ok')
    expect(registryUrlLevel(undefined)).toBe('ok')
    expect(registryUrlLevel('https://script.google.com/macros/u/1/s/AKfycbx-abc_123/exec')).toBe('error')
    expect(registryUrlLevel('https://script.google.com/macros/s/AKfycbx-abc_123/dev')).toBe('error')
    expect(registryUrlLevel('https://script.google.com/a/macros/example.org/s/AKfycbx/exec')).toBe('error')
    const bad = run({ NEXT_PUBLIC_REGISTRY_URL: 'https://script.google.com/macros/s/SECRET_ID_123/dev' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/NEXT_PUBLIC_REGISTRY_URL/)
    expect(bad.stderr + bad.stdout).not.toContain('SECRET_ID_123')
    expect(run({ NEXT_PUBLIC_REGISTRY_URL: 'https://script.google.com/macros/s/AKfycbx/exec' }).status).toBe(0)
  })

  it('使わなくなった NEXT_PUBLIC_GAS_URL(CSV_GAS)が残っていたら、ビルドを止める(値は表示しない)', () => {
    const r = run({ NEXT_PUBLIC_GAS_URL: 'https://script.google.com/macros/s/SECRET_ID_456/exec' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/使わなくなりました/)
    expect(r.stderr + r.stdout).not.toContain('SECRET_ID_456')
  })
})
