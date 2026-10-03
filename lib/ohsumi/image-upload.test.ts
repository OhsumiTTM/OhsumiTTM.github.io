import { describe, expect, it } from 'vitest'
import { checkImageFile, MAX_IMAGE_BYTES, MAX_RESIZED_SOURCE_BYTES } from './image-upload'

describe('画像のアップロードの確かめ', () => {
  it('jpeg・png・gif・webp だけを受け付ける', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) expect(checkImageFile({ type, size: 100 })).toBe('ok')
    for (const type of ['image/svg+xml', 'text/html', 'application/pdf', '']) expect(checkImageFile({ type, size: 100 }), type).toBe('type')
  })
  it('大きすぎる画像は断る', () => {
    expect(checkImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES })).toBe('ok')
    expect(checkImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toBe('size')
    expect(checkImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }, MAX_RESIZED_SOURCE_BYTES)).toBe('ok')
  })
})
