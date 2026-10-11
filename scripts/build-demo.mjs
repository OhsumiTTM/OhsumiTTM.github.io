// 営業用のデモ(<サイト>/demo/)をビルドする。出力は out-demo/(デプロイで out/demo/ に入れる)。
//
// デモは、本番と同じ画面を NEXT_PUBLIC_OHSUMI_DEMO=1 でビルドしたもの:
//   - 置き場所は /demo(next.config.mjs の basePath)。lib/demo/entry.ts を lib/demo/entry.demo.tsx に差し替える
//   - 団体の GAS は、ブラウザの中で偽のスプレッドシートの上で動かす(demo-gas.js。scripts/demo-gas.mjs が作る)
//   - レジストリ・Google のログイン・Supabase・フィードバックのフォームなど、外の接続先は入れない(Secrets を渡さない)。
//     CSP の connect-src も 'self' だけにする
//   - Ohsumi の画面(index.html)だけを残す(紹介サイト・申請フォーム・レジストリの管理画面などは消す)
//
// 使い方: node scripts/build-demo.mjs(pnpm build:demo)
// out/ に本番のビルドがあれば、ビルドの間だけ別の場所に移して、終わったら戻す。.next/(ビルドのキャッシュ)は最後に消す。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEMO_REGISTRY_URL } from './demo-config.mjs'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'out')
const OUT_DEMO = join(ROOT, 'out-demo')
const OUT_ASIDE = join(ROOT, 'out.main-during-demo-build')

// 残すもの(Ohsumi の画面と、その部品・アイコン)
const KEEP = new Set(['index.html', 'index.txt', '404.html', '404', '_next', '_not-found', 'favicon.ico', 'icon.svg', 'apple-icon.png', 'demo-gas.js'])

const env = {
  ...process.env,
  NEXT_PUBLIC_OHSUMI_DEMO: '1',
  NEXT_PUBLIC_REGISTRY_URL: DEMO_REGISTRY_URL,
  // 外の接続先・本番の設定は渡さない。Google のログイン(個人のシート・カレンダーも)は使わない
  NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: '',
  NEXT_PUBLIC_GAS_URL: '',
  NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID: '',
  NEXT_PUBLIC_SUPABASE_URL: '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
  NEXT_PUBLIC_FEEDBACK_FORM_URL: '',
  NEXT_PUBLIC_GOOGLE_CALENDAR_READ: '',
}
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' })

if (existsSync(OUT_ASIDE)) throw new Error(`${OUT_ASIDE} が残っています。前のビルドが途中で止まった時のものです。中身を確かめて out/ に戻すか消してください。`)
rmSync(OUT_DEMO, { recursive: true, force: true })
const moved = existsSync(OUT)
if (moved) renameSync(OUT, OUT_ASIDE)
try {
  run('node', ['scripts/gas-build.mjs', '--check'])
  run('pnpm', ['exec', 'next', 'build'])
  renameSync(OUT, OUT_DEMO)
} finally {
  rmSync(OUT, { recursive: true, force: true })
  if (moved) renameSync(OUT_ASIDE, OUT)
  // デモの設定のビルドのキャッシュを、本番のビルドに使わせない
  rmSync(join(ROOT, '.next'), { recursive: true, force: true })
}

for (const name of readdirSync(OUT_DEMO)) {
  if (!KEEP.has(name) && !name.startsWith('__next')) rmSync(join(OUT_DEMO, name), { recursive: true, force: true })
}
run('node', ['scripts/demo-gas.mjs', join(OUT_DEMO, 'demo-gas.js')])
run('node', ['scripts/csp.mjs', OUT_DEMO])
run('node', ['scripts/check-no-demo-login.mjs', OUT_DEMO, '--demo'])
console.log('デモのビルド: out-demo/(デプロイで out/demo/ に入れる)')
