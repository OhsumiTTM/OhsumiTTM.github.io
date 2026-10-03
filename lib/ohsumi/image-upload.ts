// 画像のアップロードの前に、種類と大きさを確かめる(団体の Google ドライブの容量と通信の失敗を防ぐ)。
// GAS の側の確かめ(v1.1)が入るまでの、画面の側の確かめ
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024 // そのまま送る画像(ロゴ・アンケートの画像)
export const MAX_RESIZED_SOURCE_BYTES = 10 * 1024 * 1024 // 縮めてから送る画像(プロフィール画像)の元の大きさ

export type ImageCheck = 'ok' | 'type' | 'size'

export function checkImageFile(file: { type: string; size: number }, maxBytes = MAX_IMAGE_BYTES): ImageCheck {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return 'type'
  if (file.size > maxBytes) return 'size'
  return 'ok'
}
