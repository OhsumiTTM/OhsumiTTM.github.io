// フロントが要求する OAuth スコープを確かめる。本番では非機密のスコープ
// (drive.file)のアクセストークンだけを要求し、spreadsheets・calendar・profile を
// 要求する経路が残っていないこと。ログインは IDトークン(session.ts)で、アクセストークンは使わない。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROOT = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const FRONT_FILES = ['app', 'components', 'lib'].flatMap((d) => sourceFiles(join(ROOT, d)))

type TokenConfig = { scope: string }

async function loadWithGis(env: Record<string, string>) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', 'client-id')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  const requested: string[] = []
  vi.stubGlobal('window', {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (config: TokenConfig & { callback: (r: { access_token: string }) => void }) => ({
            requestAccessToken: () => {
              requested.push(config.scope)
              config.callback({ access_token: 'token' })
            },
          }),
        },
      },
    },
  })
  const mod = await import('./google-sheet-sync')
  return { mod, requested }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('OAuth スコープ', () => {
  it('機密のスコープの文字列は google-sheet-sync.ts にしか書かれていない', () => {
    const offenders = FRONT_FILES.filter((f) => !f.endsWith('google-sheet-sync.ts')).filter((f) =>
      /googleapis\.com\/auth\/|['"`]openid|['"`]profile['"`]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
    const src = readFileSync(join(ROOT, 'lib', 'ohsumi', 'google-sheet-sync.ts'), 'utf8')
    expect(src).not.toContain('auth/spreadsheets')
    expect(src).not.toMatch(/['"`][^'"`]*\bprofile\b[^'"`]*['"`]/)
  })

  it('アクセストークンは個人シート用の drive.file だけを要求する(ログイン用のアクセストークンは無い)', async () => {
    const { mod, requested } = await loadWithGis({})
    expect(mod).not.toHaveProperty('requestGoogleLoginToken')
    expect(mod).not.toHaveProperty('fetchGoogleUserInfo')
    await mod.requestDriveFileToken()
    await mod.requestDriveFileToken(true)
    expect(requested).toEqual([
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.file',
    ])
  })

  it('カレンダーの予定の表示が無効(既定)なら、calendar スコープを要求しない', async () => {
    const { mod, requested } = await loadWithGis({})
    await expect(mod.requestCalendarToken()).rejects.toThrow(/現在ご利用いただけません/)
    await expect(mod.requestCalendarToken(true)).rejects.toThrow()
    expect(requested).toEqual([])
  })

  it('設定で有効にした場合だけ calendar スコープを要求する', async () => {
    const { mod, requested } = await loadWithGis({ NEXT_PUBLIC_GOOGLE_CALENDAR_READ: 'true' })
    await mod.requestCalendarToken()
    expect(requested).toEqual(['https://www.googleapis.com/auth/calendar'])
  })
})

describe('個人スプレッドシート', () => {
  function memoryStorage() {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      data,
    }
  }

  it('以前の方式で保存したシートIDを見分け、新しいシートを保存すると消す', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const { mod } = await loadWithGis({})
    storage.setItem('ohsumi-personal-sheet-id-m1', 'old-sheet-id')
    expect(mod.hasLegacyPersonalSheet('m1')).toBe(true)
    expect(mod.loadPersonalSheet('m1')).toBeNull()
    mod.savePersonalSheet('m1', { id: 'new-id', title: 'Ohsumi' })
    expect(mod.loadPersonalSheet('m1')).toEqual({ id: 'new-id', title: 'Ohsumi' })
    expect(mod.hasLegacyPersonalSheet('m1')).toBe(false)
    mod.savePersonalSheet('m1', null)
    expect(mod.loadPersonalSheet('m1')).toBeNull()
  })

  it('アプリがスプレッドシートを作成し、同期先にアクセスできない場合は専用のエラーにする', async () => {
    const { mod } = await loadWithGis({})
    const calls: { url: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body })
      if (url.endsWith('/v4/spreadsheets')) {
        return { ok: true, json: async () => ({ spreadsheetId: 'created-id', properties: { title: 'T' } }) }
      }
      return { ok: false, status: 403, json: async () => ({ error: { message: 'no access' } }) }
    }))
    expect(await mod.createPersonalSpreadsheet('token', 'T')).toEqual({ id: 'created-id', title: 'T' })
    expect(JSON.parse(calls[0].body!)).toMatchObject({ properties: { title: 'T' } })
    await expect(mod.syncTasksToSheet('legacy-id', 'token', [])).rejects.toBeInstanceOf(mod.PersonalSheetUnavailableError)
  })
})
