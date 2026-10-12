// 団体の GAS の版を、サイトに置く・サイトから外す: pnpm gas:release add / pnpm gas:release remove <版>
//
// サイトの /gas/<版>/Code.gs は、リポジトリの gas/releases/<版>/Code.gs から置く(scripts/gas-build.mjs --publish)。
// レジストリの管理画面の「プランごとに配る版」で選べるのは、サイトに置いた版(registry/Code.gs の KNOWN_GAS_VERSIONS で
// released: true の版)だけ。このスクリプトは、フォルダと released の印を一緒に付け外しし、pnpm gas:version で
// レジストリの版を上げる(テスト lib/ohsumi/gas-release.test.ts が、2つがそろっていることを確かめる)。
//   node scripts/gas-release.mjs add             今の gas/Code.gs を gas/releases/<その版>/Code.gs に置き、その版に released: true を付ける
//                                                (先に pnpm gas:version で版を上げ、KNOWN_GAS_VERSIONS にその版を足しておく)
//   node scripts/gas-release.mjs remove <版>     gas/releases/<版>/ を消し、その版の released を外す(一番新しい版は外せない)。
//                                                外してよい版は、レジストリの管理画面の「サイトから外してよい版」に出る
//                                                (どのプランの配る版でもなく、一番新しい版でもない版)
// 入れ替えの順(registry/README.md の「1.10」):
//   足す時: サイト(マージ・公開)→ レジストリ(先にレジストリを貼ると、まだサイトに無い版を配る版に選べてしまう)
//   消す時: レジストリ → サイト(先にレジストリを貼り、外した版を選べなくする)
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GAS_CODE_PATH, GAS_RELEASES_DIR, buildGasCode } from './gas-build.mjs'

const ROOT = join(import.meta.dirname, '..')
export const REGISTRY_PATH = 'registry/Code.gs'
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/

/** コードの版(var OHSUMI_GAS_VERSION = '…' の行)。見つからなければ null */
export function codeVersion(text) {
  const m = /^var OHSUMI_GAS_VERSION = '([^']*)'$/m.exec(text)
  return m ? m[1] : null
}

/** gas/releases にある版(フォルダの名前。新しい順) */
export function releaseFolders(root = ROOT) {
  const dir = join(root, GAS_RELEASES_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => VERSION_PATTERN.test(f)).sort().reverse()
}

/** KNOWN_GAS_VERSIONS の各版と、released の印({ version, released }。書いてある順) */
export function knownVersions(registryText) {
  const start = registryText.indexOf('var KNOWN_GAS_VERSIONS = [')
  const end = registryText.indexOf('\n]\n', start)
  if (start < 0 || end < 0) throw new Error(`${REGISTRY_PATH} に KNOWN_GAS_VERSIONS がありません`)
  return [...registryText.slice(start, end).matchAll(/^\s*\{ version: '([^']+)',([^\n]*)$/gm)]
    .map((m) => ({ version: m[1], released: /\breleased: true\b/.test(m[2]) }))
}

/** KNOWN_GAS_VERSIONS のその版の行の released の印を付ける・外す(行が無ければ投げる) */
export function setReleasedFlag(registryText, version, released) {
  const start = registryText.indexOf('var KNOWN_GAS_VERSIONS = [')
  const end = registryText.indexOf('\n]\n', start)
  const head = registryText.slice(0, start)
  const list = registryText.slice(start, end)
  const lineRe = new RegExp(`^(\\s*\\{ version: '${version.replace(/\./g, '\\.')}', security: (?:true|false), required: (?:true|false),)( released: true,)?`, 'm')
  if (!lineRe.test(list)) throw new Error(`${REGISTRY_PATH} の KNOWN_GAS_VERSIONS に版 ${version} がありません。先に足してください`)
  return head + list.replace(lineRe, (_, a) => (released ? `${a} released: true,` : a)) + registryText.slice(end)
}

/** 今の gas/Code.gs をその版のフォルダに置き、released を付ける。置いた版を返す */
export function addRelease(root = ROOT) {
  const code = readFileSync(join(root, GAS_CODE_PATH), 'utf8')
  if (code !== buildGasCode(root)) throw new Error('gas/Code.gs が gas/src とそろっていません。pnpm gas:build(版を上げるなら pnpm gas:version)を実行してください')
  const version = codeVersion(code)
  if (!version || !VERSION_PATTERN.test(version)) throw new Error('gas/Code.gs の版(OHSUMI_GAS_VERSION)が日付の形ではありません')
  const registryFile = join(root, REGISTRY_PATH)
  const registry = setReleasedFlag(readFileSync(registryFile, 'utf8'), version, true)
  const dir = join(root, GAS_RELEASES_DIR, version)
  const target = join(dir, 'Code.gs')
  if (existsSync(target) && readFileSync(target, 'utf8') !== code) {
    throw new Error(`${GAS_RELEASES_DIR}/${version}/Code.gs は、今の gas/Code.gs と違います。出した版の中身は変えません(中身を変えたなら、pnpm gas:version で版を上げてください)`)
  }
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(root, GAS_CODE_PATH), target)
  writeFileSync(registryFile, registry)
  return version
}

/** その版のフォルダを消し、released を外す。一番新しい版・今の gas/Code.gs の版は外せない */
export function removeRelease(version, root = ROOT) {
  if (!VERSION_PATTERN.test(String(version || ''))) throw new Error('外す版を「YYYY.MM.DD-N」の形で指定してください(pnpm gas:release remove 2026.10.12-2)')
  const folders = releaseFolders(root)
  if (!folders.includes(version)) throw new Error(`${GAS_RELEASES_DIR}/${version} がありません(サイトに置いていない版です)`)
  if (folders[0] === version) throw new Error(`版 ${version} は、サイトに置いた一番新しい版なので外せません`)
  if (codeVersion(readFileSync(join(root, GAS_CODE_PATH), 'utf8')) === version) throw new Error(`版 ${version} は、今の gas/Code.gs の版なので外せません`)
  const registryFile = join(root, REGISTRY_PATH)
  const registry = setReleasedFlag(readFileSync(registryFile, 'utf8'), version, false)
  rmSync(join(root, GAS_RELEASES_DIR, version), { recursive: true, force: true })
  writeFileSync(registryFile, registry)
  return version
}

function main(args) {
  const [cmd, version] = args
  let done
  if (cmd === 'add') done = `版 ${addRelease()} を ${GAS_RELEASES_DIR}/ に置き、released: true を付けました`
  else if (cmd === 'remove') done = `版 ${removeRelease(version)} を ${GAS_RELEASES_DIR}/ から消し、released を外しました`
  else {
    console.error('使い方: pnpm gas:release add / pnpm gas:release remove <版>')
    process.exit(1)
  }
  console.log(done)
  // レジストリ(KNOWN_GAS_VERSIONS)を変えたので、版を上げる
  const r = spawnSync('node', [join(ROOT, 'scripts', 'gas-version.mjs')], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
  console.log(cmd === 'add'
    ? '入れ替えの順: サイト(この変更をマージして公開)→ レジストリ(registry/Code.gs を貼り直す)。その後、管理画面の「プランごとに配る版」で配る版を選べます'
    : '入れ替えの順: レジストリ(registry/Code.gs を貼り直す)→ サイト(この変更をマージして公開)')
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
