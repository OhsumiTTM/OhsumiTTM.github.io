// lib/ohsumi/files.ts: ログインの応答に入っていた画像を取得済みにし、getFiles を送らないこと
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTestOrg } from './test-org'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('primeFiles', () => {
  it('受け取った画像は、getFiles を送らずに表示用の URL になる', async () => {
    await useTestOrg('https://script.google.com/macros/s/TEST/exec')
    vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: vi.fn(() => 'blob:prime'), revokeObjectURL: vi.fn() }))
    const remote = await import('./remote')
    const getFiles = vi.spyOn(remote.remoteApi, 'getFiles')
    const files = await import('./files')
    files.primeFiles([
      { id: 'IMG_xxxxxxxxxx', ok: true, mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
      { id: 'BAD_xxxxxxxxxx', ok: false },
    ])
    expect(remote.isRemoteConfigured).toBe(true)
    const win = { location: { href: '' }, close: vi.fn() }
    vi.stubGlobal('window', { open: vi.fn(() => win), location: { href: '' } })
    expect(await files.openStoredFile('https://lh3.googleusercontent.com/d/IMG_xxxxxxxxxx=w1')).toBe(true)
    expect(win.location.href).toBe('blob:prime')
    expect(getFiles).not.toHaveBeenCalled()
  })
})
