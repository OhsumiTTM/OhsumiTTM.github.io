// レジストリの監視(registry/monitor/Monitor.gs): 2回続けて応答がない時・復旧した時・バックアップが
// 古い時などに、1回だけメールと Discord に知らせることを確かめる
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const CODE = readFileSync(join(__dirname, '..', '..', 'registry', 'monitor', 'Monitor.gs'), 'utf8')

type Health = Record<string, unknown> | 'down'

function setup() {
  const props: Record<string, string> = {
    REGISTRY_URL: 'https://script.google.com/macros/s/REG/exec',
    HEALTH_KEY: 'k',
    ALERT_EMAILS: 'a@example.com, b@example.com',
    DISCORD_WEBHOOK_URL: 'https://discord.example/webhook',
  }
  const mails: { to: string; subject: string; body: string }[] = []
  const discord: string[] = []
  const sentKeys: unknown[] = []
  let health: Health = 'down'
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => ({ ...props }),
      setProperty: (k: string, v: string) => { props[k] = v },
    }) },
    MailApp: { sendEmail: (to: string, subject: string, body: string) => mails.push({ to, subject, body }) },
    UrlFetchApp: {
      fetch: (url: string, opts: { payload: string }) => {
        if (url === props.DISCORD_WEBHOOK_URL) {
          discord.push(JSON.parse(opts.payload).content)
          return { getResponseCode: () => 204, getContentText: () => '' }
        }
        sentKeys.push(JSON.parse(opts.payload).key)
        if (health === 'down') throw new Error('Address unavailable')
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(health) }
      },
    },
  })
  vm.runInContext(CODE, ctx)
  const gas = ctx as unknown as Record<string, (...a: unknown[]) => unknown>
  return { gas, props, mails, discord, sentKeys, setHealth: (h: Health) => { health = h } }
}

const NOW = Date.parse('2026-10-01T09:00:00Z')
const good = (extra: Record<string, unknown> = {}) => ({ ok: true, version: 'r1a-1', lastBackupAt: '2026-10-01T03:00:00Z', unrecordedEdits: 0, rejectedLastHour: 0, ...extra })
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

describe('応答の判定(evaluateHealth)', () => {
  it('応答なし・版の無い応答は「届かない」', () => {
    const t = setup()
    expect(plain(t.gas.evaluateHealth(null, NOW))).toMatchObject({ reachable: false })
    expect(plain(t.gas.evaluateHealth({ ok: true }, NOW))).toMatchObject({ reachable: false })
  })

  it('バックアップが26時間を超えた・まだ無い、記録の無い変更、断ったリクエストの急増を問題として挙げる', () => {
    const t = setup()
    expect(plain(t.gas.evaluateHealth(good(), NOW)).problems).toEqual({})
    const bad = plain(t.gas.evaluateHealth(good({ lastBackupAt: '2026-09-30T06:00:00Z', unrecordedEdits: 2, rejectedLastHour: 1001 }), NOW)).problems
    expect(Object.keys(bad).sort()).toEqual(['backup', 'rejected', 'unrecorded'])
    expect(bad.backup).toContain('27 時間')
    expect(plain(t.gas.evaluateHealth(good({ lastBackupAt: null }), NOW)).problems.backup).toMatch(/一度も/)
  })
})

describe('知らせる時(nextMonitorState)', () => {
  const down = { reachable: false, reason: '通信エラー', problems: {} }
  const up = { reachable: true, problems: {} }

  it('1回の失敗では知らせず、2回続けて失敗した時に1回だけ知らせる。復旧したら止まっていた時間を知らせる', () => {
    const t = setup()
    const step = (state: unknown, r: unknown, at: number) => plain(t.gas.nextMonitorState(state, r, at))
    let s = step(null, down, NOW)
    expect(s.messages).toEqual([])
    s = step(s.state, up, NOW + 15 * 60000)
    expect(s.messages).toEqual([])
    s = step(s.state, down, NOW + 30 * 60000)
    s = step(s.state, down, NOW + 45 * 60000)
    expect(s.messages).toEqual(['🔴 レジストリが応答しません(2回続けて失敗。原因: 通信エラー)'])
    s = step(s.state, down, NOW + 60 * 60000)
    expect(s.messages).toEqual([])
    s = step(s.state, up, NOW + 120 * 60000)
    expect(s.messages).toEqual(['🟢 レジストリが復旧しました(止まっていた時間: 1時間30分)'])
  })

  it('問題は起きた時に1回、解消した時に1回だけ知らせる', () => {
    const t = setup()
    const step = (state: unknown, r: unknown) => plain(t.gas.nextMonitorState(state, r, NOW))
    const withBackup = { reachable: true, problems: { backup: '最後のバックアップから 30 時間たっています' } }
    let s = step(null, withBackup)
    expect(s.messages).toEqual(['🟠 最後のバックアップから 30 時間たっています'])
    s = step(s.state, withBackup)
    expect(s.messages).toEqual([])
    s = step(s.state, up)
    expect(s.messages).toEqual(['✅ 解消しました: 最後のバックアップから 30 時間たっています'])
  })
})

describe('実行(checkRegistry)', () => {
  it('2回続けて応答がない時にメールと Discord に知らせ、状態をスクリプトプロパティに残す', () => {
    const t = setup()
    t.gas.checkRegistry()
    expect(t.mails).toHaveLength(0)
    t.gas.checkRegistry()
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0].to).toBe('a@example.com,b@example.com')
    expect(t.mails[0].subject).toBe('[Ohsumi レジストリ] 🔴 レジストリが応答しません(2回続けて失敗。原因: 通信エラー(Address unavailable))')
    expect(t.discord).toHaveLength(1)
    expect(JSON.parse(t.props.MONITOR_STATE)).toMatchObject({ failures: 2, down: true })
    // 鍵を付けて問い合わせる
    expect(t.sentKeys).toEqual(['k', 'k'])
    t.setHealth(good({ lastBackupAt: new Date().toISOString() }))
    t.gas.checkRegistry()
    expect(t.mails.at(-1)!.subject).toMatch(/復旧しました/)
  })

  it('毎朝の「動いています」は Discord にだけ送る', () => {
    const t = setup()
    t.gas.monitorHeartbeat()
    expect(t.discord).toEqual(['[Ohsumi レジストリ] 監視は動いています(レジストリ: 正常)'])
    expect(t.mails).toHaveLength(0)
  })

  it('Webhook の URL と鍵はコードに書かない', () => {
    expect(CODE).not.toMatch(/discord(app)?\.com\/api\/webhooks/)
    expect(CODE).toMatch(/props\.DISCORD_WEBHOOK_URL/)
  })
})
