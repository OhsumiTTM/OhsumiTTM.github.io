// 版ごとのコード(gas/releases/<版>/Code.gs → サイトの /gas/<版>/Code.gs)と、レジストリの KNOWN_GAS_VERSIONS の released の印が
// そろっていること。pnpm gas:release add / remove の動き(scripts/gas-release.mjs)
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addRelease, codeVersion, knownVersions, releaseFolders, removeRelease, setReleasedFlag } from '../../scripts/gas-release.mjs'
import { publishedGasFiles } from '../../scripts/gas-build.mjs'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('リポジトリの版ごとのコード', () => {
  const folders: string[] = releaseFolders(ROOT)
  const known = knownVersions(read('registry/Code.gs')) as { version: string; released: boolean }[]

  it('gas/releases の版は、すべて KNOWN_GAS_VERSIONS にあり、released: true の版とそろっている', () => {
    expect(folders.length).toBeGreaterThan(0)
    for (const v of folders) expect(known.map((k) => k.version)).toContain(v)
    expect(known.filter((k) => k.released).map((k) => k.version).sort()).toEqual([...folders].sort())
  })

  it('各フォルダの Code.gs の版は、フォルダの名前と同じ(団体の GAS のコード)', () => {
    for (const v of folders) {
      const text = read(`gas/releases/${v}/Code.gs`)
      expect(codeVersion(text)).toBe(v)
      expect(text).toMatch(/function doPost\(/)
    }
  })

  it('今の gas/Code.gs の版をサイトに置いているなら、中身は今の gas/Code.gs と同じ(出した版の中身を変えていない)', () => {
    const current = codeVersion(read('gas/Code.gs'))!
    if (folders.includes(current)) expect(read(`gas/releases/${current}/Code.gs`)).toBe(read('gas/Code.gs'))
  })

  it('配る版の始まりは 2026.10.12-2(それより古い版はさかのぼって置かない)', () => {
    expect(folders.at(-1)).toBe('2026.10.12-2')
  })

  it('ビルドの時に、版ごとの Code.gs・一番新しい Code.gs・一番新しい SampleData.gs をサイトに置く', () => {
    const files = publishedGasFiles(ROOT) as { path: string; text: string }[]
    expect(files.map((f) => f.path)).toEqual(['gas/Code.gs', 'gas/SampleData.gs', ...[...folders].sort().map((v) => `gas/${v}/Code.gs`)])
    expect(files[0].text).toBe(read('gas/Code.gs'))
    expect(files[1].text).toBe(read('gas/SampleData.gs'))
  })
})

// 小さな試しのリポジトリ(gas/src・gas/Code.gs・registry/Code.gs)を作って、add / remove を確かめる
const temps: string[] = []
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }) })

function repo(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'gas-release-'))
  temps.push(root)
  mkdirSync(join(root, 'gas', 'src'), { recursive: true })
  mkdirSync(join(root, 'registry'), { recursive: true })
  const setVersion = (v: string) => {
    const code = `var OHSUMI_GAS_VERSION = '${v}'\nfunction doPost(e) {}\n`
    writeFileSync(join(root, 'gas', 'src', '01-entry.gs'), code)
    writeFileSync(join(root, 'gas', 'Code.gs'), code)
  }
  setVersion(version)
  writeFileSync(join(root, 'registry', 'Code.gs'), [
    "var REGISTRY_VERSION = '2026.10.12-1'",
    'var KNOWN_GAS_VERSIONS = [',
    "  { version: '2026.12.02-1', security: false, required: false, note: '新しい版' },",
    "  { version: '2026.12.01-1', security: true, required: true, note: '前の版' },",
    "  { version: '2026.11.01-1', security: false, required: false, note: '古い版' },",
    ']',
    '',
  ].join('\n'))
  const registry = () => readFileSync(join(root, 'registry', 'Code.gs'), 'utf8')
  return { root, setVersion, registry }
}

describe('pnpm gas:release', () => {
  it('add: 今の gas/Code.gs をその版のフォルダに置き、その版に released: true を付ける(何度実行しても同じ)', () => {
    const r = repo('2026.12.01-1')
    expect(addRelease(r.root)).toBe('2026.12.01-1')
    expect(readFileSync(join(r.root, 'gas', 'releases', '2026.12.01-1', 'Code.gs'), 'utf8')).toBe(readFileSync(join(r.root, 'gas', 'Code.gs'), 'utf8'))
    expect(r.registry()).toContain("{ version: '2026.12.01-1', security: true, required: true, released: true, note: '前の版' }")
    addRelease(r.root)
    expect(r.registry().match(/released: true/g)).toHaveLength(1)
    expect(knownVersions(r.registry())).toEqual([
      { version: '2026.12.02-1', released: false }, { version: '2026.12.01-1', released: true }, { version: '2026.11.01-1', released: false },
    ])
  })

  it('add: KNOWN_GAS_VERSIONS に無い版・gas/src とそろっていない・出した版の中身を変えた時は止まる', () => {
    const r = repo('2026.12.03-1')
    expect(() => addRelease(r.root)).toThrow(/KNOWN_GAS_VERSIONS に版 2026\.12\.03-1 がありません/)
    expect(existsSync(join(r.root, 'gas', 'releases'))).toBe(false)
    r.setVersion('2026.12.01-1')
    addRelease(r.root)
    writeFileSync(join(r.root, 'gas', 'src', '01-entry.gs'), "var OHSUMI_GAS_VERSION = '2026.12.01-1'\nfunction doPost(e) { return 1 }\n")
    expect(() => addRelease(r.root)).toThrow(/gas\/src とそろっていません/)
    writeFileSync(join(r.root, 'gas', 'Code.gs'), "var OHSUMI_GAS_VERSION = '2026.12.01-1'\nfunction doPost(e) { return 1 }\n")
    expect(() => addRelease(r.root)).toThrow(/出した版の中身は変えません/)
  })

  it('remove: フォルダを消し、released を外す。一番新しい版・今の gas/Code.gs の版・置いていない版は外せない', () => {
    const r = repo('2026.11.01-1')
    addRelease(r.root)
    r.setVersion('2026.12.01-1')
    addRelease(r.root)
    r.setVersion('2026.12.02-1')
    expect(() => removeRelease('2026.12.01-1', r.root)).toThrow(/一番新しい版なので外せません/)
    addRelease(r.root)
    expect(releaseFolders(r.root)).toEqual(['2026.12.02-1', '2026.12.01-1', '2026.11.01-1'])
    expect(() => removeRelease('2026.12.02-1', r.root)).toThrow(/外せません/)
    expect(() => removeRelease('2026.10.01-1', r.root)).toThrow(/サイトに置いていない版/)
    expect(() => removeRelease('latest', r.root)).toThrow(/YYYY\.MM\.DD-N/)
    expect(removeRelease('2026.12.01-1', r.root)).toBe('2026.12.01-1')
    expect(releaseFolders(r.root)).toEqual(['2026.12.02-1', '2026.11.01-1'])
    expect(knownVersions(r.registry()).filter((k: { released: boolean }) => k.released).map((k: { version: string }) => k.version)).toEqual(['2026.12.02-1', '2026.11.01-1'])
    // 一覧の行(版の説明)は残す(版の判定に使うため)
    expect(r.registry()).toContain("{ version: '2026.12.01-1', security: true, required: true, note: '前の版' }")
  })

  it('setReleasedFlag は、その版の行だけを変える', () => {
    const r = repo('2026.12.01-1')
    const text = setReleasedFlag(r.registry(), '2026.11.01-1', true)
    expect(text).toContain("{ version: '2026.11.01-1', security: false, required: false, released: true, note: '古い版' }")
    expect(text).toContain("{ version: '2026.12.01-1', security: true, required: true, note: '前の版' }")
    expect(setReleasedFlag(text, '2026.11.01-1', false)).toBe(r.registry())
  })
})
