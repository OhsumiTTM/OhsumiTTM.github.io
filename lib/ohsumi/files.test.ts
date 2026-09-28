import { describe, expect, it } from 'vitest'
import { extractDriveFileId } from './files'

describe('extractDriveFileId', () => {
  it('シートに保存されている形式のURLからファイルIDを取り出す', () => {
    expect(extractDriveFileId('https://lh3.googleusercontent.com/d/1AbC_dEf-2345678=w256-h256-c')).toBe('1AbC_dEf-2345678')
    expect(extractDriveFileId('https://drive.google.com/file/d/1AbC_dEf-2345678/view?usp=drivesdk')).toBe('1AbC_dEf-2345678')
    expect(extractDriveFileId('https://drive.google.com/open?id=1AbC_dEf-2345678')).toBe('1AbC_dEf-2345678')
    expect(extractDriveFileId('https://drive.google.com/uc?export=view&id=1AbC_dEf-2345678')).toBe('1AbC_dEf-2345678')
  })

  it('Drive 以外のURLや data: URL は対象外', () => {
    expect(extractDriveFileId('https://example.com/logo.png')).toBeNull()
    expect(extractDriveFileId('data:image/png;base64,AAAA')).toBeNull()
    expect(extractDriveFileId('https://evil.example/https://drive.google.com/file/d/1AbC_dEf-2345678')).toBeNull()
    expect(extractDriveFileId(undefined)).toBeNull()
  })
})
