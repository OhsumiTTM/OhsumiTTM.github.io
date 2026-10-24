// プランに配っている団体の GAS の版ごとの画面(版の画面)を作り、out/_v/<版>/ に置く(デプロイで実行する)。
//
// 版の画面は、その版を配っていた間の main の画面:
//   - 一番新しい版の画面は main と同じなので作らない(/ の画面を使う)
//   - それより古い版は、「次の版を gas/releases/ に足したコミット」の1つ前のコミット(main の第1の親)の画面
//     (次の版を足すまでの main の直しは、その版の画面に入る)
//   - そのコミットに lib/ohsumi/site-version.ts が無い(この仕組みより前の版)は作らない。その版のプランも main の画面を使う
// 作った版は out/_v/index.json に書く。画面は、レジストリの答え(resolveOrg の siteVersion)が index.json にある時だけ移る
// (lib/ohsumi/site-version.ts)。1つの版を作れなかった時は、その版を飛ばして続ける(その版のプランは main の画面になる)。
//
// 使い方: node scripts/build-site-versions.mjs [出力先(既定: out)]
//   ビルドの設定(Secrets など)は、本番のビルドと同じ環境変数を渡す。git の履歴が要る(actions/checkout の fetch-depth: 0)。
//   main の上で動かす(デプロイ)。ほかのブランチでは、main を取り込んだマージのコミットを「次の版を足したコミット」と数えてしまう
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
export const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/
// 版の画面に置くもの(Ohsumi の画面と、その部品)
export const KEEP = new Set(['index.html', 'index.txt', '_next'])
const SUPPORT_FILE = 'lib/ohsumi/site-version.ts'

export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * git log --first-parent --diff-merges=first-parent --reverse --diff-filter=A --format=@%H %P --name-only -- gas/releases の出力を読む。
 * 返す値: 古い順の [{ commit, parent, versions(そのコミットで足した版) }]
 */
export function parseReleaseLog(text) {
  const events = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) {
      const [commit, parent] = line.slice(1).trim().split(/\s+/)
      cur = { commit, parent: parent || '', versions: [] }
      events.push(cur)
      continue
    }
    const m = /^gas\/releases\/([^/]+)\/Code\.gs$/.exec(line.trim())
    if (cur && m && VERSION_PATTERN.test(m[1])) cur.versions.push(m[1])
  }
  return events.filter((e) => e.versions.length)
}

/**
 * 版ごとの画面のコミットを決める(純粋な関数)。
 * releases: 今サイトに置いている版 / events: parseReleaseLog の結果
 * 返す値: [{ version, commit }](一番新しい版は入れない。コミットが決まらない版は commit: '')
 */
export function screenCommits(releases, events) {
  const sorted = [...releases].filter((v) => VERSION_PATTERN.test(v)).sort((a, b) => compareVersions(b, a))
  const out = []
  for (const version of sorted.slice(1)) {
    const addedAt = events.findIndex((e) => e.versions.includes(version))
    // その版を足した後で、それより新しい版を最初に足したコミット(外した版も、足した記録は残る)
    const next = addedAt < 0 ? null : events.slice(addedAt + 1).find((e) => e.versions.some((v) => compareVersions(v, version) > 0))
    out.push({ version, commit: next && next.parent ? next.parent : '' })
  }
  return out
}

export function releasesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((v) => VERSION_PATTERN.test(v) && existsSync(join(dir, v, 'Code.gs'))) : []
}

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function hasFile(commit, path) {
  try { git(['cat-file', '-e', `${commit}:${path}`]); return true } catch { return false }
}

/** dir のコードで、version の画面を作り、dest に置く(dir の out/ を使う) */
export function buildScreen(dir, version, dest, env = process.env) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, env: { ...env, NEXT_PUBLIC_SITE_VERSION: version }, stdio: 'inherit' })
  run('pnpm', ['build'])
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const name of readdirSync(join(dir, 'out'))) {
    if (KEEP.has(name) || name.startsWith('__next')) cpSync(join(dir, 'out', name), join(dest, name), { recursive: true })
  }
}

function main() {
  const out = join(ROOT, process.argv[2] || 'out')
  if (!existsSync(join(out, 'index.html'))) throw new Error(`${out} に本番のビルドがありません。先に pnpm build を実行してください`)
  const releases = releasesIn(join(ROOT, 'gas', 'releases'))
  const log = git(['log', '--first-parent', '--diff-merges=first-parent', '--reverse', '--diff-filter=A', '--format=@%H %P', '--name-only', 'HEAD', '--', 'gas/releases'])
  const plan = screenCommits(releases, parseReleaseLog(log))
  const built = []
  const work = mkdtempSync(join(tmpdir(), 'ohsumi-site-versions-'))
  try {
    for (const { version, commit } of plan) {
      if (!commit) { console.warn(`::warning::版 ${version} の画面のコミットが決まりません(git の履歴が浅い?)。main の画面を使います`); continue }
      if (!hasFile(commit, SUPPORT_FILE)) { console.log(`版 ${version}: この仕組みより前のコミット(${commit.slice(0, 7)})なので作りません。main の画面を使います`); continue }
      const dir = join(work, version)
      console.log(`版 ${version} の画面を ${commit.slice(0, 7)} から作ります`)
      try {
        git(['worktree', 'add', '--detach', dir, commit])
        execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: dir, stdio: 'inherit' })
        buildScreen(dir, version, join(out, '_v', version))
        built.push(version)
      } catch (e) {
        console.warn(`::warning::版 ${version} の画面を作れませんでした(${e && e.message}). main の画面を使います`)
        rmSync(join(out, '_v', version), { recursive: true, force: true })
      } finally {
        try { git(['worktree', 'remove', '--force', dir]) } catch { /* 下で消す */ }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  mkdirSync(join(out, '_v'), { recursive: true })
  writeFileSync(join(out, '_v', 'index.json'), JSON.stringify({ versions: built }) + '\n')
  console.log(`版の画面: ${built.length ? built.join('・') : 'なし'}(out/_v/index.json)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
