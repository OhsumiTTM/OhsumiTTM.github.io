// 団体の GAS は gas/src/*.gs をつなげて gas/Code.gs にする(scripts/gas-build.mjs)。
// テスト・版の確認(gas:version)は、つなげた gas/Code.gs を読むので、gas/src とそろっていることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGasCode, gasSourceFiles } from '../../scripts/gas-build.mjs'

const ROOT = join(__dirname, '..', '..')

describe('団体の GAS のまとめ方', () => {
  it('gas/Code.gs は、gas/src をファイル名の順につなげたものと同じ(直接直していない)', () => {
    expect(readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')).toBe(buildGasCode(ROOT))
  })

  it('gas/src は機能ごとのファイルに分かれていて、版の行はどれか1つのファイルにだけある', () => {
    const files: string[] = gasSourceFiles(ROOT)
    expect(files.length).toBeGreaterThan(10)
    const withVersion = files.filter((f) => /^var OHSUMI_GAS_VERSION = '/m.test(readFileSync(join(ROOT, 'gas', 'src', f), 'utf8')))
    expect(withVersion).toHaveLength(1)
  })

  it('ビルドの時に、まとめた Code.gs をサイトの /gas/Code.gs に置く', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.build).toContain('gas-build.mjs --check')
    expect(pkg.scripts.build).toContain('gas-build.mjs --publish out')
  })
})
