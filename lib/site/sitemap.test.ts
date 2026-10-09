import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SITEMAP_PATHS } from './sitemap-paths'

const ROOT = join(__dirname, '..', '..')

describe('サイトマップ', () => {
  it('載せる URL は、どれも末尾が / で、紹介サイト・規約のページが実際にある', () => {
    for (const path of SITEMAP_PATHS) {
      expect(path.endsWith('/'), path).toBe(true)
      const seg = path.replace(/^\/|\/$/g, '')
      const candidates = seg ? [join(ROOT, 'app', seg, 'page.tsx'), join(ROOT, 'app', '(site)', seg, 'page.tsx')] : [join(ROOT, 'app', 'page.tsx')]
      expect(candidates.some((f) => existsSync(f)), path).toBe(true)
    }
  })

  it('Ohsumi の画面(?org=)とレジストリの管理画面は載せない', () => {
    expect(SITEMAP_PATHS.some((p) => p.includes('registry-admin') || p.includes('?'))).toBe(false)
  })
})
