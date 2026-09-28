import { describe, expect, it } from 'vitest'
import { RECEIPT_MAX_BYTES, validateReceiptFile } from './receipt'

describe('validateReceiptFile', () => {
  it('画像とPDFは5MBまで受け付ける', () => {
    expect(validateReceiptFile({ name: 'a.jpg', type: 'image/jpeg', size: RECEIPT_MAX_BYTES })).toBeNull()
    expect(validateReceiptFile({ name: 'a.png', type: 'image/png', size: 10 })).toBeNull()
    expect(validateReceiptFile({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeNull()
    expect(validateReceiptFile({ name: 'a.heic', type: 'image/heic', size: 10 })).toBeNull()
  })

  it('種類が空の HEIC は拡張子で判定する', () => {
    expect(validateReceiptFile({ name: 'IMG_0001.HEIC', type: '', size: 10 })).toBeNull()
  })

  it('5MBを超えるファイルは受け付けない', () => {
    expect(validateReceiptFile({ name: 'a.jpg', type: 'image/jpeg', size: RECEIPT_MAX_BYTES + 1 })).toBe('tooLarge')
  })

  it('画像・PDF以外は受け付けない', () => {
    expect(validateReceiptFile({ name: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 })).toBe('unsupportedType')
    expect(validateReceiptFile({ name: 'a.exe', type: '', size: 10 })).toBe('unsupportedType')
    expect(validateReceiptFile({ name: 'a.pdf', type: 'application/zip', size: 10 })).toBe('unsupportedType')
  })
})
