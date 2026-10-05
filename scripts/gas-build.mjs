// 団体の GAS をまとめる: pnpm gas:build
//
// リポジトリでは、団体の GAS を機能ごとのファイル(gas/src/*.gs)に分けて持つ。団体に配るのは、それをつなげた
// 1つの gas/Code.gs(ファイル名の順につなげるだけ。GAS は全部のファイルを1つの場所で動かすので、順番は元の1つの
// ファイルと同じにしておく。トップレベルの var は上から順に決まるため)。
//   node scripts/gas-build.mjs            gas/src から gas/Code.gs を作る
//   node scripts/gas-build.mjs --check    gas/Code.gs が gas/src とそろっているか確かめる(そろっていなければ失敗)
//   node scripts/gas-build.mjs --publish out
//                                         まとめた Code.gs を、サイトの /gas/Code.gs(out/gas/Code.gs)に置く。
//                                         代表の管理画面の「コードをコピー」が、同じサイトから読む
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const GAS_SRC_DIR = 'gas/src'
export const GAS_CODE_PATH = 'gas/Code.gs'
export const PUBLISHED_GAS_PATH = 'gas/Code.gs'

/** gas/src のファイル(名前の順) */
export function gasSourceFiles(root = ROOT) {
  return readdirSync(join(root, GAS_SRC_DIR)).filter((f) => f.endsWith('.gs')).sort()
}

/** gas/src をつなげた中身 */
export function buildGasCode(root = ROOT) {
  return gasSourceFiles(root).map((f) => readFileSync(join(root, GAS_SRC_DIR, f), 'utf8')).join('')
}

function main(args) {
  const code = buildGasCode()
  const target = join(ROOT, GAS_CODE_PATH)
  if (args[0] === '--check') {
    if (readFileSync(target, 'utf8') !== code) {
      console.error('gas/Code.gs が gas/src とそろっていません。pnpm gas:build を実行してください(gas/Code.gs を直接直さず、gas/src を直します)。')
      process.exit(1)
    }
    console.log('gas/Code.gs は gas/src とそろっています')
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
  console.log(`gas/src の ${gasSourceFiles().length} 個のファイルから gas/Code.gs を作りました`)
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main(process.argv.slice(2))
