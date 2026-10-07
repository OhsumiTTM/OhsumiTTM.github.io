// 団体の GAS をまとめる: pnpm gas:build
//
// リポジトリでは、団体の GAS を機能ごとのファイル(gas/src/*.gs)に分けて持つ。団体に配るのは、それをつなげた
// 1つの gas/Code.gs(ファイル名の順につなげるだけ。GAS は全部のファイルを1つの場所で動かすので、順番は元の1つの
// ファイルと同じにしておく。トップレベルの var は上から順に決まるため)。
// サンプル・見本のデータを作るコードは gas/sample/*.gs に分けて持ち、gas/SampleData.gs にまとめる(サンプル・デモの団体だけが
// Code.gs に加えて足す。団体に配る Code.gs とサイトの /gas/ には入れない)。SampleData.gs の SAMPLE_DATA_FOR_GAS_VERSION は、
// まとめる時に今の Code.gs の版(OHSUMI_GAS_VERSION)に書き換える(組の版。違う Code.gs では実行の最初に止まる)。
//   node scripts/gas-build.mjs            gas/src から gas/Code.gs、gas/sample から gas/SampleData.gs を作る
//   node scripts/gas-build.mjs --check    gas/Code.gs・gas/SampleData.gs が元のファイルとそろっているか確かめる(そろっていなければ失敗)
//   node scripts/gas-build.mjs --publish out
//                                         まとめた Code.gs を、サイトの /gas/Code.gs(out/gas/Code.gs)に置く(SampleData.gs は置かない)。
//                                         代表の管理画面の「コードをコピー」が、同じサイトから読む
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const GAS_SRC_DIR = 'gas/src'
export const GAS_CODE_PATH = 'gas/Code.gs'
export const PUBLISHED_GAS_PATH = 'gas/Code.gs'
export const GAS_SAMPLE_DIR = 'gas/sample'
export const GAS_SAMPLE_PATH = 'gas/SampleData.gs'

/** gas/src のファイル(名前の順) */
export function gasSourceFiles(root = ROOT) {
  return readdirSync(join(root, GAS_SRC_DIR)).filter((f) => f.endsWith('.gs')).sort()
}

/** gas/src をつなげた中身 */
export function buildGasCode(root = ROOT) {
  return gasSourceFiles(root).map((f) => readFileSync(join(root, GAS_SRC_DIR, f), 'utf8')).join('')
}

/** gas/sample のファイル(名前の順) */
export function gasSampleFiles(root = ROOT) {
  return readdirSync(join(root, GAS_SAMPLE_DIR)).filter((f) => f.endsWith('.gs')).sort()
}

/** gas/sample をつなげた中身(組になる Code.gs の版を書き込む) */
export function buildSampleCode(root = ROOT) {
  const codeVersion = (buildGasCode(root).match(/^var OHSUMI_GAS_VERSION = '([^']*)'$/m) || [])[1] || ''
  return gasSampleFiles(root).map((f) => readFileSync(join(root, GAS_SAMPLE_DIR, f), 'utf8')).join('')
    .replace(/^var SAMPLE_DATA_FOR_GAS_VERSION = '[^']*'$/m, `var SAMPLE_DATA_FOR_GAS_VERSION = '${codeVersion}'`)
}

function main(args) {
  const code = buildGasCode()
  const target = join(ROOT, GAS_CODE_PATH)
  const sample = buildSampleCode()
  const sampleTarget = join(ROOT, GAS_SAMPLE_PATH)
  if (args[0] === '--check') {
    if (readFileSync(target, 'utf8') !== code) {
      console.error('gas/Code.gs が gas/src とそろっていません。pnpm gas:build を実行してください(gas/Code.gs を直接直さず、gas/src を直します)。')
      process.exit(1)
    }
    if (readFileSync(sampleTarget, 'utf8') !== sample) {
      console.error('gas/SampleData.gs が gas/sample とそろっていません。pnpm gas:build を実行してください(gas/SampleData.gs を直接直さず、gas/sample を直します)。')
      process.exit(1)
    }
    console.log('gas/Code.gs は gas/src と、gas/SampleData.gs は gas/sample とそろっています')
    return
  }
  if (args[0] === '--publish') {
    const out = join(ROOT, args[1] || 'out', PUBLISHED_GAS_PATH)
    if (readFileSync(target, 'utf8') !== code) throw new Error('gas/Code.gs が gas/src とそろっていません。pnpm gas:build を実行してください。')
    mkdirSync(join(out, '..'), { recursive: true })
    writeFileSync(out, code)
    console.log(`団体の GAS を ${args[1] || 'out'}/${PUBLISHED_GAS_PATH} に置きました`)
    return
  }
  writeFileSync(target, code)
  writeFileSync(sampleTarget, sample)
  console.log(`gas/src の ${gasSourceFiles().length} 個のファイルから gas/Code.gs を、gas/sample の ${gasSampleFiles().length} 個のファイルから gas/SampleData.gs を作りました`)
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main(process.argv.slice(2))
