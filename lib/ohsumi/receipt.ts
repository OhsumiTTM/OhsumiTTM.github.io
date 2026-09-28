// 領収書ファイルの確認(5MBまで、画像(JPEG・PNG・HEICなど)とPDFのみ)。
// gas/Code.gs の validateReceiptFile と同じ基準 — サーバー側でも同じ確認をする。
// ブラウザによっては HEIC の種類(type)が空になるため、拡張子でも判定する。
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024

const RECEIPT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]
const RECEIPT_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'pdf']

// <input type="file" accept> に渡す値
export const RECEIPT_ACCEPT = [...RECEIPT_MIME_TYPES, ...RECEIPT_EXTENSIONS.map((e) => `.${e}`)].join(',')

export type ReceiptFileError = 'tooLarge' | 'unsupportedType'

export function validateReceiptFile(file: { name: string; type: string; size: number }): ReceiptFileError | null {
  if (file.size > RECEIPT_MAX_BYTES) return 'tooLarge'
  const type = (file.type || '').toLowerCase()
  if (RECEIPT_MIME_TYPES.includes(type)) return null
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if ((!type || type === 'application/octet-stream') && RECEIPT_EXTENSIONS.includes(ext)) return null
  return 'unsupportedType'
}
