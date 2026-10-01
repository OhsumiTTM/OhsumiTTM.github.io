// メールの1日の上限(PR D): 団体の GAS は、GAS を動かすアカウントのメールの上限を全員で分け合う。
//   - 送る前に残りの数を確かめ、足りない時は送らずに記録する(代表の管理画面に出す)
//   - Google の上限で失敗した時は、ログインの失敗と分かる文にする(ログイン画面に戻さない)
//   - 急ぎのものだけすぐ送り、それ以外は1人1日1通のまとめにする。団体の通知先と管理者に重ねて送らない
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const mention = (h: H) => h.post({ action: 'updateComments', sessionToken: 'm-base', taskId: 't1',
  comments: [{ id: 'c-old', byId: 'm-lead', text: '前からのコメント', at: '2026-09-01' }, { id: 'c-1', byId: 'm-base', text: '@班長 見てください' }] })
const setQuota = (h: H, remaining: number | (() => number)) => {
  h.c.MailApp = {
    sendEmail: (m: { to: string; subject: string; body: string }) => { h.sent.push({ kind: 'mail', to: String(m.to), text: m.subject + '\n' + m.body }) },
    getRemainingDailyQuota: typeof remaining === 'function' ? remaining : () => remaining,
  }
}
const quotaState = (h: H) => JSON.parse(h.props.MAIL_QUOTA_STATE ?? 'null')
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const ADMIN_MAIL = { ja: { subject: '[Ohsumi] 管理者へ', body: '管理者への知らせ' } }

describe('送る前に、メールの残りの数を確かめる', () => {
  it('残りが足りない時は送らずに記録し、送れなかった通知は宛先のまとめに回す', () => {
    const h = guardHarness()
    setQuota(h, 0)
    const res = mention(h)
    expect(res.ok, res.error).toBe(true)
    expect(h.sent.filter((s) => s.kind === 'mail')).toEqual([])
    expect(quotaState(h)).toMatchObject({ date: '2026-10-01', skipped: 1, lastReachedDate: '2026-10-01', reachedAt: expect.stringMatching(/^\d{4}-/) })
    expect(h.digested().map((d) => d.to)).toEqual(['lead@example.com'])
    expect(h.digested()[0].text).toContain('@班長 見てください')
  })

  it('宛先の数で数える(残り1で2人あての時は送らない)。足りれば送る', () => {
    const h = guardHarness()
    setQuota(h, 1)
    expect(call(h, 'sendMail_', { to: 'a@example.com,b@example.com', subject: 's', body: 'b' })).toBe(false)
    expect(quotaState(h).skipped).toBe(2)
    expect(call(h, 'sendMail_', { to: 'a@example.com', subject: 's', body: 'b' })).toBe(true)
    expect(h.sent.map((s) => s.to)).toEqual(['a@example.com'])
  })

  it('送る時に Google の上限の例外が出ても、操作は失敗させずに記録する', () => {
    const h = guardHarness()
    h.c.MailApp = { getRemainingDailyQuota: () => 50, sendEmail: () => { throw new Error('Service invoked too many times for one day: email.') } }
    expect(mention(h).ok).toBe(true)
    expect(quotaState(h).skipped).toBe(1)
    expect(h.digested().map((d) => d.to)).toEqual(['lead@example.com'])
  })

  it('日が変われば数え直す(最後に上限に達した日は残す)', () => {
    const h = guardHarness({ props: { MAIL_QUOTA_STATE: JSON.stringify({ date: '2026-09-30', skipped: 9, reachedAt: '2026-09-30T05:00:00.000Z', lastReachedDate: '2026-09-30' }) } })
    expect(call(h, 'mailQuotaStatus_')).toEqual({ remaining: 100, date: '2026-10-01', skipped: 0, reachedAt: '', lastReachedDate: '2026-09-30' })
  })

  it('テスト環境では、TEST_NOTIFICATION_EMAIL の1件として数える', () => {
    const h = guardHarness({ props: { TEST_NOTIFICATION_EMAIL: 'tester@example.com' } })
    h.c.isTestEnvironment_ = () => true
    expect(call(h, 'mailRecipientCount_', { to: 'a@example.com,b@example.com', cc: 'c@example.com' })).toBe(1)
    delete h.props.TEST_NOTIFICATION_EMAIL
    expect(call(h, 'mailRecipientCount_', { to: 'a@example.com' })).toBe(0)
  })

  it('代表・全権管理者は、今日の状態を読める(一般のメンバーは読めない)', () => {
    const h = guardHarness()
    setQuota(h, 0)
    mention(h)
    expect(h.post({ action: 'getMailQuotaStatus', sessionToken: 'm-top' }).result).toMatchObject({ remaining: 0, skipped: 1, date: '2026-10-01' })
    expect(h.post({ action: 'getMailQuotaStatus', sessionToken: 'm-base' })).toMatchObject({ ok: false, forbidden: true })
  })

  it('招待メールは、上限で送れなかったことを画面に返す(メンバーの追加はする)', () => {
    const checked = JSON.stringify({ phase: 'none', kind: 'suspend', suspendAt: '', checkedAt: '2026-10-01T00:00:00.000Z', siteOrigins: ['https://site.example.com'] })
    const h = guardHarness({ props: { CONTRACT_STATE: checked } })
    setQuota(h, 0)
    const res = h.post({ action: 'addMember', sessionToken: 'm-top', name: '新人', email: 'new@example.com', role: 'base', sendInvite: true })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.invite).toEqual({ sent: false, reason: 'mailQuota' })
    // 自分のメールに送る: 上限の時は、QR コード・リンクのコピーを使うよう伝える
    const me = h.post({ action: 'sendInviteLinkToMe', sessionToken: 'm-base', origin: 'https://site.example.com' })
    expect(me.ok).toBe(false)
    expect(me.error).toContain('今日のメールの上限に達しました')
  })

  it('停止の予告は、上限で送れなかった時は送ったことにしない(次の確認で送り直す)', () => {
    const at = Date.now() + 13.5 * 24 * 3600 * 1000
    const h = guardHarness()
    setQuota(h, 0)
    const state = { phase: 'scheduled', kind: 'suspend', suspendAt: new Date(at).toISOString(), reason: '' }
    expect(call(h, 'sendContractNotices_', state, Date.now())).toBeNull()
    expect(h.props.CONTRACT_NOTICES_SENT).toBeUndefined()
    setQuota(h, 100)
    expect(call(h, 'sendContractNotices_', state, Date.now())).toBe(14)
    expect(h.sent.map((s) => s.to)).toEqual(['top@example.com'])
  })
})

describe('Google の利用の上限に達した時のエラー', () => {
  const quota = (kind: string) => new Error('Exception: Service invoked too many times for one day: ' + kind + '.')

  it('ログインの確かめ(外部への通信・プロパティ)が上限で失敗した時は、ログインの失敗と分かる文にし、ログイン画面に戻さない', () => {
    for (const kind of ['urlfetch', 'properties']) {
      const h = guardHarness()
      h.c.authenticateRequest_ = () => { throw quota(kind) }
      for (const action of ['getInitialData', 'updateLocale']) {
        const res = h.post({ action, sessionToken: 'm-base', locale: 'ja' })
        expect(res, `${kind} ${action}`).toMatchObject({ ok: false, quotaExceeded: kind })
        expect(res.authError, `${kind} ${action}`).toBeUndefined()
        expect(res.error).toContain('ログインを確かめられませんでした。')
        expect(res.error).toContain('あなたのアカウントの問題ではありません')
      }
    }
  })

  it('Google でのログイン(tokeninfo)が上限で失敗した時も同じ', () => {
    const h = guardHarness()
    h.c.UrlFetchApp = { fetch: () => { throw quota('urlfetch') } }
    const res = h.post({ action: 'exchangeIdToken', idToken: 'a.b.c', nonceSecret: 'n'.repeat(20) })
    expect(res).toMatchObject({ ok: false, quotaExceeded: 'urlfetch' })
    expect(res.authError).toBeUndefined()
    expect(res.error).toContain('ログインを確かめられませんでした。この団体の GAS が、今日の外部への通信')
  })

  it('ログイン以外の操作では、どの上限かが分かる文を返す。上限でないエラー・ログインの失敗はこれまでどおり', () => {
    expect(call(guardHarness(), 'toErrorMessage_', quota('properties'))).toContain('今日の設定の読み書き(スクリプトプロパティ)の上限')
    expect(call(guardHarness(), 'toErrorMessage_', new Error('Bandwidth quota exceeded'))).toContain('外部への通信')
    expect(call(guardHarness(), 'toErrorMessage_', new Error('TypeError: x'))).toBe('処理中に問題が発生しました。しばらくしてから再度お試しください。')
    const h = guardHarness()
    h.c.authenticateRequest_ = () => { throw (h.c.userError_ as (m: string) => Error)('ログインの有効期限が切れました。') }
    expect(h.post({ action: 'getInitialData', sessionToken: 'm-base' })).toMatchObject({ ok: false, authError: true })
  })
})

describe('急ぎの通知と、毎日のまとめ', () => {
  it('メンションはすぐ送る。期限の知らせ・却下・結果の知らせは、まとめに入れる', () => {
    const h = guardHarness()
    mention(h)
    expect(h.sent.filter((s) => s.kind === 'mail').map((s) => s.to)).toEqual(['lead@example.com'])
    call(h, 'queueNotification_', 'm-base', 'deadline', { ja: { subject: '期限です', body: 'タスク1 の期限です' } })
    call(h, 'queueNotification_', 'm-base', 'rejected', { ja: { subject: '却下', body: '却下されました' } })
    expect(h.sent.filter((s) => s.kind === 'mail')).toHaveLength(1)
    expect(h.digested().map((d) => [d.to, d.text.split('\n')[0]])).toEqual([['base@example.com', '期限です'], ['base@example.com', '却下']])
  })

  it('「1日ごと」の設定のメンションも、まとめに入れる(1人1日1通)', () => {
    const h = guardHarness()
    const members = h.sheets.Members.rows
    members[members.findIndex((r) => r[0] === 'm-lead')][members[0].indexOf('notify_settings')] = JSON.stringify({ mention: '1d' })
    h.c.getNotifyFrequency_ = (id: string, kind: string) => (id === 'm-lead' && kind === 'mention' ? '1d' : 'immediate')
    mention(h)
    expect(h.sent.filter((s) => s.kind === 'mail')).toEqual([])
    expect(h.digested().map((d) => d.to)).toEqual(['lead@example.com'])
  })

  it('毎日のまとめは、1人1通にまとめて送り、送ったものを消す。言語は受け取る人に合わせる', () => {
    const h = guardHarness()
    call(h, 'addToDigest_', 'base@example.com', 'ja', '一つ目', '本文1')
    call(h, 'addToDigest_', 'base@example.com', 'ja', '二つ目', '本文2')
    call(h, 'addToDigest_', 'lead@example.com', 'en', 'First', 'Body')
    call(h, 'flushDailyDigests_')
    const mails = h.sent.filter((s) => s.kind === 'mail')
    expect(mails.map((m) => m.to).sort()).toEqual(['base@example.com', 'lead@example.com'])
    expect(mails.find((m) => m.to === 'base@example.com')!.text).toMatch(/^Ohsumi 今日のまとめ \(2件\)\n[\s\S]*【一つ目】\n本文1[\s\S]*【二つ目】\n本文2/)
    expect(mails.find((m) => m.to === 'lead@example.com')!.text).toMatch(/^Ohsumi daily summary \(1\)/)
    expect(h.digested()).toEqual([])
  })

  it('まとめは大きくなりすぎないよう、長い本文を切り、入りきらない分は件数だけ書く', () => {
    const h = guardHarness()
    for (let i = 0; i < 40; i++) call(h, 'addToDigest_', 'base@example.com', 'ja', '知らせ' + i, 'あ'.repeat(500))
    const raw = Object.entries(h.props).find(([k]) => k.startsWith('notif_digest_'))![1]
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(2000)
    call(h, 'flushDailyDigests_')
    const text = h.sent[0].text
    expect(text).toMatch(/^Ohsumi 今日のまとめ \(40件\)/)
    expect(text).toMatch(/ほか \d+ 件あります。Ohsumi の画面で確かめてください。/)
  })

  it('メールの残りが少ない時・上限で送れない時は、まとめを明日に回す(消さない)', () => {
    const h = guardHarness()
    call(h, 'addToDigest_', 'base@example.com', 'ja', '一つ目', '本文1')
    setQuota(h, 5)
    call(h, 'flushDailyDigests_')
    expect(h.sent).toEqual([])
    expect(h.digested()).toHaveLength(1)
    h.c.MailApp = { getRemainingDailyQuota: () => 50, sendEmail: () => { throw new Error('Service invoked too many times for one day: email.') } }
    call(h, 'flushDailyDigests_')
    expect(h.digested()).toHaveLength(1)
    setQuota(h, 50)
    call(h, 'flushDailyDigests_')
    expect(h.sent.map((s) => s.to)).toEqual(['base@example.com'])
    expect(h.digested()).toEqual([])
  })

  it('毎日の処理(dailyMaintenance)の最後に、まとめを送る', () => {
    const daily = CODE_GS.slice(CODE_GS.indexOf('function dailyMaintenance('), CODE_GS.indexOf('\n}\n', CODE_GS.indexOf('function dailyMaintenance(')))
    expect(daily).toContain('flushDailyDigests_()')
    expect(daily.indexOf('notifyInactiveMembers_()')).toBeLessThan(daily.indexOf('flushDailyDigests_()'))
  })

  it('以前の版でキューに入った、急ぎでない種類のものは、毎時の処理でまとめに移す', () => {
    const h = guardHarness({ props: { 'notif_queue_m-base': JSON.stringify([{ kind: 'deadline', templates: { ja: { subject: '期限', body: '古い' } }, ts: '2026-09-30T00:00:00.000Z' }]) } })
    h.c.getNotifyFrequency_ = () => '3h'
    call(h, 'sendBatchNotifications')
    expect(h.sent.filter((s) => s.kind === 'mail')).toEqual([])
    expect(h.digested().map((d) => d.to)).toEqual(['base@example.com'])
    expect(h.props['notif_queue_m-base']).toBeUndefined()
  })
})

describe('管理者への通知の宛先', () => {
  it('団体の通知先があれば、そこだけに送る(管理者に重ねて送らない)', () => {
    const h = guardHarness()
    call(h, 'notifyAdmins_', ADMIN_MAIL, null, { urgent: true })
    expect(h.sent.map((s) => s.to)).toEqual(['org@example.com'])
  })

  it('団体の通知先が無ければ、管理者に送る', () => {
    const h = guardHarness()
    h.sheets.Settings.rows = h.sheets.Settings.rows.filter((r) => r[0] !== 'org_notification_emails')
    h.props.DATA_VERSION = 'v2'
    call(h, 'notifyAdmins_', ADMIN_MAIL, null, { urgent: true })
    expect(h.sent.map((s) => s.to)).toEqual(['top@example.com,lead@example.com'])
  })

  it('その人あての通知(報告先など)は、その人だけに送る(団体の通知先には重ねない)', () => {
    const h = guardHarness()
    call(h, 'notifyAdmins_', ADMIN_MAIL, ['lead@example.com'], { urgent: true })
    expect(h.sent.map((s) => s.to)).toEqual(['lead@example.com'])
  })

  it('急ぎでないものは、まとめに入れる', () => {
    const h = guardHarness()
    call(h, 'notifyAdmins_', '[Ohsumi] 旧の呼び方', '本文')
    expect(h.sent).toEqual([])
    expect(h.digested().map((d) => d.to)).toEqual(['org@example.com'])
  })

  it('Discord/Slack をつないだ団体では、管理者あてのメールは急ぎでもまとめに回す(その人あてのものはすぐ送る)', () => {
    const h = guardHarness({ props: { discord_webhook_url: 'https://discord.com/api/webhooks/1/x' } })
    call(h, 'notifyAdmins_', ADMIN_MAIL, null, { urgent: true })
    expect(h.sent).toEqual([])
    expect(h.digested().map((d) => d.to)).toEqual(['org@example.com'])
    call(h, 'notifyAdmins_', ADMIN_MAIL, ['lead@example.com'], { urgent: true })
    expect(h.sent.map((s) => s.to)).toEqual(['lead@example.com'])
  })

  it('承認の依頼・確認の依頼・研修の申請は、急ぎとして送る', () => {
    const urgentCallers = ['notifyNewTasks_', 'notifyReview_', 'notifyTrainingRequest_']
    for (const name of urgentCallers) {
      const start = CODE_GS.indexOf('function ' + name + '(')
      const body = CODE_GS.slice(start, CODE_GS.indexOf('\n}\n', start))
      expect(body, name).toMatch(/notifyAdmins_\([\s\S]*\{ urgent: true \}/)
    }
  })
})

// ---- 守る処理を外すと、上のテストが失敗すること --------------------------------------------
describe('守る処理を外すと失敗する', () => {
  it('送る前の残りの数の確かめを外すと、上限を超えて送ってしまう', () => {
    const code = CODE_GS.replace('if (remaining !== null && remaining < count) {', 'if (false) {')
    expect(code).not.toBe(CODE_GS)
    const h = guardHarness({ code })
    setQuota(h, 0)
    mention(h)
    expect(h.sent.filter((s) => s.kind === 'mail')).toHaveLength(1)
  })

  it('上限のエラーの見分けを外すと、ログイン画面に戻してしまう', () => {
    const code = CODE_GS.replace('var kind = quotaKind_(err)\n  if (kind) return', 'var kind = null\n  if (kind) return')
    expect(code).not.toBe(CODE_GS)
    const h = guardHarness({ code })
    h.c.authenticateRequest_ = () => { throw new Error('Service invoked too many times for one day: urlfetch.') }
    expect(h.post({ action: 'getInitialData', sessionToken: 'm-base' }).authError).toBe(true)
  })
})
