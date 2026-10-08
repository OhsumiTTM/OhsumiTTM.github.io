// 申請フォーム(/apply)の団体ロゴを、Supabase Storage の logos バケットに上げる。
//
// - Supabase のライブラリは使わず、Storage の REST API に fetch で送る(anon key だけを使う。service_role は使わない)
// - 送り先: POST {NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/logos/public/<名前>(x-upsert: false。上書きしない)
// - 公開 URL: {NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/public/<名前>
// - 名前は ohsumi-<時刻>-<乱数8文字>.<拡張子>。団体名や元のファイル名は使わない
// - 送る前に、大きさ(10MB まで)と拡張子(png・jpg・jpeg・svg・webp・ai)を確かめる
// - 環境変数(URL・anon key)が無いビルドでは、ロゴを受け付けない(LOGO_UPLOAD_ENABLED が false)
// CSP の connect-src には、{origin}/storage/v1/object/logos/ だけを足す(scripts/csp.mjs)

export const LOGO_MAX_BYTES = 10 * 1024 * 1024
export const LOGO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'ai'] as const
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp,.ai'

// ファイルの種類が分からない時(.ai は空のことが多い)に使う Content-Type
const TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ai: 'application/postscript',
}

export interface LogoUploadConfig {
  url: string
  anonKey: string
}

// ビルド時に埋め込まれる(NEXT_PUBLIC_ の値は、書いたとおりの形でないと埋め込まれない)
const BUILD_CONFIG: LogoUploadConfig = {
  url: (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, ''),
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
}

export const LOGO_UPLOAD_ENABLED = !!(BUILD_CONFIG.url && BUILD_CONFIG.anonKey)

/** ファイル名の拡張子(小文字)。受け付けない拡張子なら null */
export function logoExtension(fileName: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())
  const ext = m ? m[1].toLowerCase() : ''
  return (LOGO_EXTENSIONS as readonly string[]).includes(ext) ? ext : null
}

/** 送る前の確かめ。問題があれば日本語の文、無ければ null */
export function checkLogoFile(file: { name: string; size: number }): string | null {
  if (!logoExtension(file.name)) return 'ロゴは PNG・JPG・SVG・WebP・AI のファイルを選んでください。'
  if (file.size <= 0) return 'ロゴのファイルが空です。別のファイルを選んでください。'
  if (file.size > LOGO_MAX_BYTES) return 'ロゴのファイルは 10MB までにしてください。'
  return null
}

/** Storage に置く名前(団体名や元のファイル名は使わない) */
export function logoObjectName(ext: string, now: number = Date.now(), uuid: string = crypto.randomUUID()): string {
  return `ohsumi-${now}-${uuid.slice(0, 8)}.${ext}`
}

export function logoUploadUrl(baseUrl: string, name: string): string {
  return `${baseUrl}/storage/v1/object/logos/public/${name}`
}

export function logoPublicUrl(baseUrl: string, name: string): string {
  return `${baseUrl}/storage/v1/object/public/logos/public/${name}`
}

export type LogoUploadResult = { ok: true; url: string } | { ok: false; error: string }

/** ロゴを上げて、公開 URL を返す。失敗した時は日本語の文を返す(投げない) */
export async function uploadLogo(
  file: File,
  deps: { config?: LogoUploadConfig; fetch?: typeof fetch; now?: number; uuid?: string } = {},
): Promise<LogoUploadResult> {
  const config = deps.config ?? BUILD_CONFIG
  if (!config.url || !config.anonKey) return { ok: false, error: 'いまロゴを受け付けられません。その他・連絡事項に書いてください。' }
  const problem = checkLogoFile(file)
  if (problem) return { ok: false, error: problem }
  const ext = logoExtension(file.name)!
  const name = logoObjectName(ext, deps.now, deps.uuid)
  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(logoUploadUrl(config.url, name), {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        'Content-Type': file.type || TYPE_BY_EXTENSION[ext],
        'x-upsert': 'false',
      },
      body: file,
    })
  } catch {
    return { ok: false, error: 'ロゴを送れませんでした。通信の状態を確かめて、もう一度お試しください。' }
  }
  if (res.ok) return { ok: true, url: logoPublicUrl(config.url, name) }
  if (res.status === 413) return { ok: false, error: 'ロゴのファイルが大きすぎます。10MB までにしてください。' }
  if (res.status === 415 || res.status === 400) return { ok: false, error: 'このファイルの種類は受け付けられません。PNG・JPG・SVG・WebP・AI を選んでください。' }
  return { ok: false, error: `ロゴを送れませんでした(${res.status})。しばらくしてから、もう一度お試しください。` }
}
