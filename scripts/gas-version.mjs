// GAS(団体の GAS・レジストリ・監視)の版を上げる: pnpm gas:version
//
// 版は日付の形「YYYY.MM.DD-N」(日本の日付。同じ日に2回目なら -2)。各ファイルの中身(版の行を除く)の
// SHA-256 と版を gas/versions.json に覚えておき、中身が変わったファイルだけ版を上げる。
// テスト(lib/ohsumi/gas-version.test.ts)は、中身が変わったのに版を上げていなければ失敗する
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GAS_SAMPLE_DIR, GAS_SRC_DIR, buildGasCode, buildSampleCode, gasSampleFiles, gasSourceFiles } from './gas-build.mjs'

const ROOT = join(import.meta.dirname, '..')
export const GAS_VERSION_FILES = [
  // 団体の GAS は gas/src から作る(scripts/gas-build.mjs)。版の行は gas/src のどれかのファイルにあり、そこを書き換えて作り直す
  { path: 'gas/Code.gs', name: 'OHSUMI_GAS_VERSION', src: GAS_SRC_DIR },
  // サンプル・見本のデータ(gas/sample から作る)。組になる Code.gs の版も中に書くので、Code.gs の版が上がると、こちらも上がる
  { path: 'gas/SampleData.gs', name: 'OHSUMI_SAMPLE_DATA_VERSION', src: GAS_SAMPLE_DIR },
  { path: 'registry/Code.gs', name: 'REGISTRY_VERSION' },
  { path: 'registry/monitor/Monitor.gs', name: 'MONITOR_VERSION' },
]
export const LOCK_PATH = 'gas/versions.json'
export const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/

const lineOf = (name) => new RegExp(`^var ${name} = '([^']*)'$`, 'm')

/** ファイルの版(見つからなければ null) */
export function readVersion(text, name) {
  const m = text.match(lineOf(name))
  return m ? m[1] : null
}

/** 版の行を除いた中身の SHA-256(改行は LF にそろえる) */
export function contentHash(text, name) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').replace(lineOf(name), `var ${name} = ''`)).digest('hex')
}

/** 今日(日本の日付)の次の版。前の版が今日なら番号を1つ上げる */
export function nextVersion(previous, now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replace(/-/g, '.')
  const m = String(previous || '').match(/^(\d{4}\.\d{2}\.\d{2})-(\d+)$/)
  return `${day}-${m && m[1] === day ? Number(m[2]) + 1 : 1}`
}

const BUILDERS = {
  [GAS_SRC_DIR]: { files: gasSourceFiles, build: buildGasCode },
  [GAS_SAMPLE_DIR]: { files: gasSampleFiles, build: buildSampleCode },
}

// 版の行がある、元のファイル(gas/src・gas/sample)
function versionSourceFile(dir, name) {
  const file = BUILDERS[dir].files().map((f) => join(ROOT, dir, f)).find((f) => readVersion(readFileSync(f, 'utf8'), name) !== null)
  if (!file) throw new Error(`${dir} に「var ${name} = '…'」の行がありません`)
  return file
}

function main() {
  const lockFile = join(ROOT, LOCK_PATH)
  let lock = {}
  try { lock = JSON.parse(readFileSync(lockFile, 'utf8')) } catch { lock = {} }
  let changed = 0
  for (const f of GAS_VERSION_FILES) {
    const file = join(ROOT, f.path)
    // gas/src から作るファイルは、先に作り直す(gas/src を直したのに作り直していない時も、正しい中身で比べる)
    if (f.src) writeFileSync(file, BUILDERS[f.src].build())
    let text = readFileSync(file, 'utf8')
    const current = readVersion(text, f.name)
    if (current === null) throw new Error(`${f.path} に「var ${f.name} = '…'」の行がありません`)
    const hash = contentHash(text, f.name)
    const known = lock[f.path]
    if (known && known.sha256 === hash && known.version === current) continue
    // 中身が変わった(または版を手で書き換えた)。版が前と同じ・日付の形でなければ、今日の版にする
    let version = current
    const bump = !VERSION_PATTERN.test(current) || (known && known.version === current)
    if (bump) {
      version = nextVersion(known?.version ?? current)
      text = text.replace(lineOf(f.name), `var ${f.name} = '${version}'`)
      if (f.src) {
        const srcFile = versionSourceFile(f.src, f.name)
        writeFileSync(srcFile, readFileSync(srcFile, 'utf8').replace(lineOf(f.name), `var ${f.name} = '${version}'`))
        text = BUILDERS[f.src].build()
      }
      writeFileSync(file, text)
    }
    lock[f.path] = { version, sha256: hash }
    changed++
    console.log(bump ? `${f.path}: ${current} → ${version}` : `${f.path}: ${version} を記録しました(版はそのまま)`)
  }
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n')
  console.log(changed ? `${changed} 件を ${LOCK_PATH} に書きました` : 'どのファイルも変わっていません')
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main()
