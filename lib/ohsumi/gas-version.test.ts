// GAS の版(PR E): 版は日付の形「YYYY.MM.DD-N」。団体の GAS・レジストリ・監視の GAS のどれかを変えたのに
// 版を上げていなければ、このテストが失敗する(pnpm gas:version で上げる)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GAS_VERSION_FILES, LOCK_PATH, VERSION_PATTERN, contentHash, nextVersion, readVersion } from '../../scripts/gas-version.mjs'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const LOCK = JSON.parse(read(LOCK_PATH)) as Record<string, { version: string; sha256: string }>

/** 版の上げ忘れ・覚えた版との食い違い(無ければ空) */
function versionProblems(path: string, name: string, text: string, lock = LOCK): string[] {
  const version = readVersion(text, name)
  const known = lock[path]
  if (version === null) return [`${path} に「var ${name} = '…'」の行がありません`]
  const out: string[] = []
  if (!VERSION_PATTERN.test(version)) out.push(`${path} の版「${version}」が日付の形(YYYY.MM.DD-N)ではありません`)
  if (!known) return [...out, `${LOCK_PATH} に ${path} がありません。pnpm gas:version を実行してください`]
  if (known.sha256 !== contentHash(text, name)) {
    out.push(version === known.version
      ? `${path} を変えたのに、版(${version})を上げていません。pnpm gas:version を実行してください`
      : `${path} の版を変えましたが、${LOCK_PATH} を書いていません。pnpm gas:version を実行してください`)
  } else if (version !== known.version) {
    out.push(`${path} の版(${version})が ${LOCK_PATH}(${known.version})と違います。pnpm gas:version を実行してください`)
  }
  return out
}

describe('GAS の版', () => {
  it.each(GAS_VERSION_FILES)('$path を変えたら、版を上げている', ({ path, name }) => {
    expect(versionProblems(path, name, read(path))).toEqual([])
  })

  it('中身を変えて版を上げないと失敗する。版の行だけの違い・改行の違いは中身の変更に数えない', () => {
    const { path, name } = GAS_VERSION_FILES[0]
    const text = read(path)
    expect(versionProblems(path, name, text + '\n// 足した行\n')[0]).toMatch(/を変えたのに、版.*を上げていません/)
    const bumped = text.replace(new RegExp(`^var ${name} = '[^']*'$`, 'm'), `var ${name} = '2099.01.01-1'`)
    expect(contentHash(bumped, name)).toBe(contentHash(text, name))
    expect(contentHash(text.replace(/\n/g, '\r\n'), name)).toBe(contentHash(text, name))
    // 版だけ上げて覚え直していない
    expect(versionProblems(path, name, bumped)[0]).toMatch(/と違います/)
  })

  it('次の版は日本の日付。同じ日の2回目は番号を上げる', () => {
    const at = new Date('2026-10-01T16:00:00Z') // 日本では 10月2日
    expect(nextVersion('2026.10.01-3', at)).toBe('2026.10.02-1')
    expect(nextVersion('2026.10.02-1', at)).toBe('2026.10.02-2')
    expect(nextVersion('r1e-2', at)).toBe('2026.10.02-1')
  })

  it('団体の GAS の版は、レジストリの版の一覧(KNOWN_GAS_VERSIONS)に入っている', () => {
    const version = readVersion(read('gas/Code.gs'), 'OHSUMI_GAS_VERSION')
    const registry = read('registry/Code.gs')
    const list = registry.slice(registry.indexOf('var KNOWN_GAS_VERSIONS = ['), registry.indexOf('\n]\n', registry.indexOf('var KNOWN_GAS_VERSIONS = [')))
    expect(list).toContain(`version: '${version}'`)
  })

  it('最初の「安全の修正」の版は、PR A(通知・タスクの書き換えを GAS が守る)を含む版', () => {
    const registry = read('registry/Code.gs')
    const first = registry.match(/var KNOWN_GAS_VERSIONS = \[\s*\{ version: '([^']+)', security: true, required: true/)
    expect(first?.[1]).toMatch(VERSION_PATTERN)
    // PR A の守り(通知の回数の上限・タスクの書き換えの確かめ)は、この版の団体の GAS に入っている
    const code = read('gas/Code.gs')
    expect(code).toContain('function allowRequestNotification_(')
    expect(code).toContain('var RATE_LIMITS = {')
  })
})
