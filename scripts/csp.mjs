// ビルド後(next build の out/)の各 HTML に、Content-Security-Policy の meta タグを入れる。
//
// GitHub Pages はレスポンスヘッダーを設定できないため、<meta http-equiv> で指定する。
// (meta では frame-ancestors と report-only が使えない。iframe への埋め込み対策は
//  components/ohsumi/frame-guard.tsx が引き続き担う)
//
// Next.js の静的出力はページごとにインラインのスクリプト(self.__next_f.push(...))を含むため、
// ページごとにその SHA-256 ハッシュを script-src に並べる('unsafe-inline' は使わない)。
// 次の場合はビルドを失敗させる:
//   - ハッシュが CSP に入っていないインラインのスクリプトがある
//   - インラインのイベントハンドラー(onclick="…" など)や javascript: の URL がある
//     (ハッシュでは許可できないため)
//
// 使い方: node scripts/csp.mjs [出力フォルダ(既定: out)]
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 接続先の一覧。用途ごとに分けて書く
export const CONNECT_SOURCES = {
  // 団体の Apps Script(Web App の URL は script.google.com。応答は googleusercontent へ転送される)
  gas: ['https://script.google.com', 'https://script.googleusercontent.com'],
  // Googleでログイン(Google Identity Services)
  googleSignIn: ['https://accounts.google.com/gsi/'],
  // 個人スプレッドシートの作成・同期(drive.file)
  personalSheet: ['https://sheets.googleapis.com'],
  // フィードバック(Google フォームへの送信)
  feedback: ['https://docs.google.com/forms/'],
}

// Googleカレンダーの予定の表示・空き時間の確認(NEXT_PUBLIC_GOOGLE_CALENDAR_READ=true の時だけ)
export const CALENDAR_READ_CONNECT_SOURCES = ['https://www.googleapis.com/calendar/v3/']

/**
 * 申請フォーム(/apply)の団体ロゴの送り先(NEXT_PUBLIC_SUPABASE_URL がある時だけ。lib/site/logo-upload.ts)。
 * Supabase の Storage の logos バケットの場所だけを許す(origin 全体や *.supabase.co は許さない)。
 * URL が https で、ホストが <プロジェクト>.supabase.co の形でなければ、ビルドを失敗させる(投げる)
 * @param {string | undefined} supabaseUrl
 * @returns {string[]}
 */
export function logoUploadConnectSources(supabaseUrl) {
  const raw = (supabaseUrl ?? '').trim()
  if (!raw) return []
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL が URL の形ではありません')
  }
  if (url.protocol !== 'https:') throw new Error('NEXT_PUBLIC_SUPABASE_URL は https にしてください')
  if (!/^[a-z0-9][a-z0-9-]*\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL のホストは <プロジェクト>.supabase.co の形にしてください')
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL は https://<プロジェクト>.supabase.co だけにしてください(パスは付けない)')
  }
  return [`${url.origin}/storage/v1/object/logos/`]
}

/**
 * @param {{ scriptHashes?: string[], calendarRead?: boolean, supabaseUrl?: string }} [options]
 * @returns {string}
 */
export function buildPolicy({ scriptHashes = [], calendarRead = false, supabaseUrl = '' } = {}) {
  const connect = [
    "'self'",
    ...Object.values(CONNECT_SOURCES).flat(),
    ...(calendarRead ? CALENDAR_READ_CONNECT_SOURCES : []),
    ...logoUploadConnectSources(supabaseUrl),
  ]
  const directives = [
    ["default-src", "'self'"],
    ['script-src', "'self'", 'https://accounts.google.com/gsi/client', ...scriptHashes.map((h) => `'sha256-${h}'`)],
    // React の style 属性と、Google のボタンのスタイル
    ['style-src', "'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
    ['connect-src', ...connect],
    // Google のログインボタン・One Tap は iframe で表示される
    ['frame-src', 'https://accounts.google.com/gsi/'],
    // アップロードしたファイルは blob: で表示する。手入力の外部の画像 URL(https:)も表示できるようにする
    ['img-src', "'self'", 'data:', 'blob:', 'https:'],
    ['font-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['upgrade-insecure-requests'],
  ]
  return directives.map((d) => d.join(' ')).join('; ')
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const EXECUTABLE_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module'])

function scriptType(attrs) {
  const m = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)
  return m ? m[1].toLowerCase() : ''
}

export function sha256Base64(text) {
  return createHash('sha256').update(text, 'utf8').digest('base64')
}

/** HTML の中の、実行されるインラインのスクリプトの中身 */
export function inlineScripts(html) {
  const scripts = []
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1]
    if (/\bsrc\s*=/i.test(attrs)) continue
    if (!EXECUTABLE_TYPES.has(scriptType(attrs))) continue
    scripts.push(m[2])
  }
  return scripts
}

/** ハッシュでは許可できない書き方(インラインのイベントハンドラー、javascript: の URL) */
export function forbiddenPatterns(html) {
  const problems = []
  // スクリプトの中身は対象外にする(文字列として含まれることがあるため)
  const markup = html.replace(SCRIPT_RE, '<script></script>')
  for (const m of markup.matchAll(/<[a-zA-Z][^>]*\son[a-z]+\s*=/g)) problems.push(`インラインのイベントハンドラー: ${m[0].slice(0, 80)}`)
  for (const m of markup.matchAll(/\s(?:href|src|action)\s*=\s*["']?\s*javascript:/gi)) problems.push(`javascript: の URL: ${m[0].slice(0, 80)}`)
  return problems
}

const META_RE = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/g

/** CSP の meta タグを入れた HTML を返す(既に入っていれば置き換える) */
export function injectCsp(html, options = {}) {
  const hashes = [...new Set(inlineScripts(html).map(sha256Base64))]
  const policy = buildPolicy({ ...options, scriptHashes: hashes })
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}"/>`
  const stripped = html.replace(META_RE, '')
  // 文字コードの指定の直後(どのスクリプトよりも前)に入れる
  const charset = stripped.match(/<meta charSet="utf-8"\s*\/?>/i)
  if (charset) return stripped.replace(charset[0], charset[0] + meta)
  const head = stripped.match(/<head[^>]*>/i)
  if (!head) throw new Error('<head> が見つかりません')
  return stripped.replace(head[0], head[0] + meta)
}

/** CSP を確かめる。問題の一覧を返す(空なら問題なし) */
export function verifyCsp(html) {
  const problems = [...forbiddenPatterns(html)]
  const metas = [...html.matchAll(META_RE)]
  if (metas.length !== 1) return [...problems, `CSP の meta タグが ${metas.length} 個あります(1個のはず)`]
  const metaIndex = metas[0].index
  const firstScript = html.search(/<script\b/i)
  if (firstScript !== -1 && firstScript < metaIndex) problems.push('CSP の meta タグより前にスクリプトがあります')
  const policy = metas[0][1].replace(/&quot;/g, '"')
  const scripts = inlineScripts(html)
  // 中身の取り出しとは別に、開始タグの数でも数える(取り出しから漏れたスクリプトを見つけるため)
  const openTags = [...html.matchAll(/<script\b([^>]*)>/gi)].filter(
    (m) => !/\bsrc\s*=/i.test(m[1]) && EXECUTABLE_TYPES.has(scriptType(m[1])),
  ).length
  if (openTags !== scripts.length) problems.push(`インラインのスクリプトの数が合いません(開始タグ ${openTags} 個、取り出せたもの ${scripts.length} 個)`)
  for (const script of scripts) {
    const hash = sha256Base64(script)
    if (!policy.includes(`'sha256-${hash}'`)) problems.push(`ハッシュが CSP に入っていないインラインのスクリプト: ${script.slice(0, 60)}…`)
  }
  return problems
}

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return htmlFiles(p)
    return name.endsWith('.html') ? [p] : []
  })
}

export function applyCspToDirectory(outDir, options = {}) {
  const failures = []
  let count = 0
  for (const file of htmlFiles(outDir)) {
    const html = readFileSync(file, 'utf8')
    // Google のサイト確認用のファイルなど、<head> の無いファイルは対象外
    if (!/<head[\s>]/i.test(html)) continue
    const next = injectCsp(html, options)
    const problems = verifyCsp(next)
    if (problems.length) failures.push(`${file}\n  - ${problems.join('\n  - ')}`)
    writeFileSync(file, next)
    count++
  }
  return { count, failures }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = process.argv[2] ?? 'out'
  const calendarRead = process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_READ === 'true'
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  try {
    logoUploadConnectSources(supabaseUrl)
  } catch (e) {
    console.error(`CSP を作れません: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  const { count, failures } = applyCspToDirectory(outDir, { calendarRead, supabaseUrl })
  if (failures.length) {
    console.error(`CSP の確認に失敗しました(${failures.length} ファイル):\n${failures.join('\n')}`)
    process.exit(1)
  }
  console.log(`CSP を ${count} ファイルに入れました(カレンダーの接続先: ${calendarRead ? 'あり' : 'なし'}・ロゴの送り先: ${supabaseUrl ? 'あり' : 'なし'})`)
}
