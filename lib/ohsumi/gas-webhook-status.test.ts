// gas/Code.gs の Discord / Slack 連携状態(getWebhookStatus)を、Apps Script を
// 使わずに Node の vm で読み込んでテストする。Webhook URL が外に出ないこと、
// テスト送信の結果・日時がスクリプトプロパティに保存されることを確かめる。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE_GS = readFileSync(join(__dirname, '..', '..', 'gas', 'Code.gs'), 'utf8')

const DISCORD_URL = 'https://discord.com/api/webhooks/123/secret-token'
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/secret-token'

function loadGas(props: Record<string, string>, responseCode = 204) {
  const store = { ...props }
  const fetched: string[] = []
  const context = vm.createContext({
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => (k in store ? store[k] : null),
        setProperty: (k: string, v: string) => {
          store[k] = v
        },
        deleteProperty: (k: string) => {
          delete store[k]
        },
      }),
    },
    UrlFetchApp: {
      fetch: (url: string) => {
        fetched.push(url)
        return { getResponseCode: () => responseCode }
      },
    },
  })
  vm.runInContext(CODE_GS, context)
  return { gas: context as unknown as Record<string, (...args: unknown[]) => unknown>, store, fetched }
}

describe('getWebhookStatus', () => {
  it('設定済みかどうかだけを返し、Webhook URL は返さない', () => {
    const { gas } = loadGas({ discord_webhook_url: DISCORD_URL })
    const status = gas.getWebhookStatus()
    expect(status).toEqual({
      discord: { configured: true, lastTest: null },
      slack: { configured: false, lastTest: null },
    })
    expect(JSON.stringify(status)).not.toContain('secret-token')
  })

  it('テスト送信の結果と日時をスクリプトプロパティに保存し、状態として返す', () => {
    const { gas, store } = loadGas({ discord_webhook_url: DISCORD_URL, slack_webhook_url: SLACK_URL })
    gas.testDiscordWebhook()
    const status = gas.getWebhookStatus() as { discord: { lastTest: { ok: boolean; at: string } } }
    expect(status.discord.lastTest.ok).toBe(true)
    expect(Number.isNaN(Date.parse(status.discord.lastTest.at))).toBe(false)
    expect(store.discord_webhook_last_test).toBeDefined()
    expect(JSON.stringify(gas.getWebhookStatus())).not.toContain('secret-token')
  })

  it('テスト送信に失敗した場合も結果を保存する', () => {
    const { gas } = loadGas({ slack_webhook_url: SLACK_URL }, 404)
    expect(() => gas.testSlackWebhook()).toThrow()
    const status = gas.getWebhookStatus() as { slack: { lastTest: { ok: boolean; error: string } } }
    expect(status.slack.lastTest).toMatchObject({ ok: false, error: 'HTTP 404' })
  })
})

describe('テスト環境の Discord・Slack', () => {
  const hooks = { discord_webhook_url: DISCORD_URL, slack_webhook_url: SLACK_URL }

  it('テスト環境では投稿せず、ログだけにする(接続テストもしない)', () => {
    const { gas, fetched } = loadGas({ ...hooks, TEST_ENVIRONMENT: 'true' })
    gas.notifyChat('期限切れのタスクがあります')
    expect(fetched).toEqual([])
    expect(() => gas.testDiscordWebhook()).toThrow(/TEST_ALLOW_CHAT/)
    expect(fetched).toEqual([])
  })

  it('TEST_ALLOW_CHAT が true なら、テスト環境でも投稿する', () => {
    const { gas, fetched } = loadGas({ ...hooks, TEST_ENVIRONMENT: 'true', TEST_ALLOW_CHAT: 'true' })
    gas.notifyChat('x')
    expect(fetched).toEqual([DISCORD_URL, SLACK_URL])
  })

  it('本番(テスト環境ではない)は、これまでどおり投稿する', () => {
    const { gas, fetched } = loadGas(hooks)
    gas.notifyChat('x')
    expect(fetched).toEqual([DISCORD_URL, SLACK_URL])
  })
})
