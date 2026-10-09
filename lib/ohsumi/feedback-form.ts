// 「Ohsumi 改善要望・不具合報告フォーム」(Google フォーム)に送る内容と、スクリーンショットの保存。
//
// Google フォームの選択肢の質問は、送る文字が選択肢と1文字も違わないと回答に入らない(必須の質問なら、回答そのものが
// 記録されない。no-cors で送るので、画面からは失敗が分からない)。選択肢を変えた時は、ここの FORM_* を合わせて直す。
// 番号・選択肢は、フォームの公開ページのソースの FB_PUBLIC_LOAD_DATA_ で確かめられる。
//
// スクリーンショットは、Supabase Storage の logos バケットの Ohsumi/ に置き、公開 URL をフォームの「スクリーンショット」
// (記述式)に送る。名前は feedback-<時刻>-<乱数>.<拡張子>(元のファイル名・団体名は使わない)。
// CSP の connect-src は、ロゴと同じ {origin}/storage/v1/object/logos/ で足りる(scripts/csp.mjs)。

export const FEEDBACK_ENTRY = {
  orgName: 'entry.1307138965',
  yourName: 'entry.25271577',
  contactType: 'entry.619897353',
  features: 'entry.897435869',
  detail: 'entry.2125058687',
  steps: 'entry.1872882494',
  severity: 'entry.1612805599',
  screenshots: 'entry.62897695',
  wantReply: 'entry.2009922288',
  email: 'entry.956889890',
} as const

// 画面の選択肢(キー) → Google フォームの選択肢の文字
export const FORM_CONTACT_TYPE: Record<string, string> = {
  '不具合の報告': '不具合の報告（正しく動かない）',
  '機能の改善要望': '機能の改善要望（今ある機能を使いやすくしたい）',
  '新機能の提案': '新機能の提案',
  '使い方が分からない': '使い方が分からない',
}
export const FORM_SEVERITY: Record<string, string> = {
  '今困っていて業務が止まっている': '今困っていて、業務が止まっている',
  'できれば近いうちに直してほしい': 'できれば近いうちに直してほしい',
  '急ぎではないが伝えておきたい': '急ぎではないが伝えておきたい',
}
export const FORM_REPLY: Record<string, string> = {
  '返信してほしい': '返信してほしい（Q2のお名前と、以下に連絡先を記入してください）',
  '返信は不要': '返信は不要',
}
const OTHER = '__other_option__'

export interface FeedbackValues {
  orgName: string
  yourName: string
  contactType: string
  otherDetail: string
  features: string[]
  detail: string
  steps: string
  severity: string
  wantReply: string
  email: string
  screenshotUrls: string[]
}

/** Google フォームの受付先(formResponse)に送る内容 */
export function buildFeedbackBody(v: FeedbackValues): URLSearchParams {
  const body = new URLSearchParams()
  const put = (key: string, value: string) => { if (value.trim()) body.append(key, value.trim()) }
  put(FEEDBACK_ENTRY.orgName, v.orgName)
  put(FEEDBACK_ENTRY.yourName, v.yourName)
  if (v.contactType === 'その他') {
    // 「その他」は、フォームの「その他」の選択肢として送る(自由記入が無ければ「その他」)
    body.append(FEEDBACK_ENTRY.contactType, OTHER)
    body.append(FEEDBACK_ENTRY.contactType + '.other_option_response', v.otherDetail.trim() || 'その他')
  } else if (FORM_CONTACT_TYPE[v.contactType]) {
    body.append(FEEDBACK_ENTRY.contactType, FORM_CONTACT_TYPE[v.contactType])
  }
  // 「対象の機能・画面」はフォームでは記述式なので、選んだものを1つの文にまとめる
  put(FEEDBACK_ENTRY.features, v.features.join('、'))
  put(FEEDBACK_ENTRY.detail, v.detail)
  put(FEEDBACK_ENTRY.steps, v.steps)
  if (FORM_SEVERITY[v.severity]) body.append(FEEDBACK_ENTRY.severity, FORM_SEVERITY[v.severity])
  put(FEEDBACK_ENTRY.screenshots, v.screenshotUrls.join('\n'))
  if (FORM_REPLY[v.wantReply]) body.append(FEEDBACK_ENTRY.wantReply, FORM_REPLY[v.wantReply])
  put(FEEDBACK_ENTRY.email, v.email)
  return body
}

// ---- スクリーンショット ----

export const SCREENSHOT_MAX_FILES = 3
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024
export const SCREENSHOT_ACCEPT = 'image/png,image/jpeg,image/webp'
const SCREENSHOT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const BUCKET = 'logos'
const FOLDER = 'Ohsumi'

export interface ScreenshotUploadConfig {
  url: string
  anonKey: string
}

const BUILD_CONFIG: ScreenshotUploadConfig = {
  url: (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, ''),
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
}

export const SCREENSHOT_UPLOAD_ENABLED = !!(BUILD_CONFIG.url && BUILD_CONFIG.anonKey)

export function screenshotExtension(fileName: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())
  const ext = m ? m[1].toLowerCase() : ''
  return SCREENSHOT_TYPES[ext] ? ext : null
}

/** 選んだ時の確かめ。問題があれば日本語の文、無ければ null */
export function checkScreenshotFile(file: { name: string; size: number }): string | null {
  if (!screenshotExtension(file.name)) return '画像は PNG・JPG・WebP を選んでください。'
  if (file.size <= 0) return '画像のファイルが空です。'
  if (file.size > SCREENSHOT_MAX_BYTES) return '画像は1枚 5MB までにしてください。'
  return null
}

export function screenshotObjectName(ext: string, now: number = Date.now(), uuid: string = crypto.randomUUID()): string {
  return `feedback-${now}-${uuid.replace(/-/g, '').slice(0, 16)}.${ext}`
}

export const screenshotUploadUrl = (baseUrl: string, name: string) => `${baseUrl}/storage/v1/object/${BUCKET}/${FOLDER}/${name}`
export const screenshotPublicUrl = (baseUrl: string, name: string) => `${baseUrl}/storage/v1/object/public/${BUCKET}/${FOLDER}/${name}`

export type ScreenshotUploadResult = { ok: true; url: string } | { ok: false; error: string }

/** 画像を上げて、公開 URL を返す。失敗した時は日本語の文を返す(投げない) */
export async function uploadScreenshot(
  file: File,
  deps: { config?: ScreenshotUploadConfig; fetch?: typeof fetch; now?: number; uuid?: string } = {},
): Promise<ScreenshotUploadResult> {
  const config = deps.config ?? BUILD_CONFIG
  if (!config.url || !config.anonKey) return { ok: false, error: 'いま画像を受け付けられません。画像を外して送ってください。' }
  const problem = checkScreenshotFile(file)
  if (problem) return { ok: false, error: problem }
  const ext = screenshotExtension(file.name)!
  const name = screenshotObjectName(ext, deps.now, deps.uuid)
  let res: Response
  try {
    res = await (deps.fetch ?? fetch)(screenshotUploadUrl(config.url, name), {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        'Content-Type': SCREENSHOT_TYPES[ext],
        'x-upsert': 'false',
      },
      body: file,
    })
  } catch {
    return { ok: false, error: '画像を送れませんでした。通信の状態を確かめて、もう一度お試しください。' }
  }
  if (res.ok) return { ok: true, url: screenshotPublicUrl(config.url, name) }
  if (res.status === 413) return { ok: false, error: '画像が大きすぎます。1枚 5MB までにしてください。' }
  return { ok: false, error: `画像を送れませんでした(${res.status})。しばらくしてから、もう一度お試しください。` }
}
