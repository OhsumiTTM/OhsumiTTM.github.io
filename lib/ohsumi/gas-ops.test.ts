// 運用の見張り(PR H): 毎日・毎時の処理が最後に成功した時刻の記録と、26時間以上成功していない時の知らせ、
// スプレッドシート・フォルダの共有の確認(GAS のアカウントと、代表への「閲覧者」の共有だけを許す)
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, noop } from './gas-guard-harness'

type H = ReturnType<typeof guardHarness>
const HOUR = 3600 * 1000
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const ME = 'gas.owner@example.com'

type Share = { access?: string; editors?: string[]; viewers?: string[]; fail?: boolean }
// 偽の Drive: スプレッドシート(ss)・アップロード用(up)・バックアップ用(bk)のフォルダの共有
function withSharing(h: H, shares: { spreadsheet?: Share; uploads?: Share; backups?: Share }) {
  const handle = (s: Share = {}) => {
    if (s.fail) throw new Error('Access denied')
    const user = (e: string) => ({ getEmail: () => e })
    return noop({
      getSharingAccess: () => s.access ?? 'PRIVATE',
      getEditors: () => (s.editors ?? []).map(user),
      getViewers: () => (s.viewers ?? []).map(user),
    })
  }
  h.c.DriveApp = noop({
    getFileById: (id: string) => { if (id !== 'ss') throw new Error('no file'); return handle(shares.spreadsheet) },
    getFolderById: (id: string) => handle(id === 'up' ? shares.uploads : shares.backups),
  })
  h.c.Session = { getScriptTimeZone: () => 'Asia/Tokyo', getEffectiveUser: () => ({ getEmail: () => ME }) }
  h.props.UPLOAD_FOLDER_ID = 'up'
  h.props.BACKUP_FOLDER_ID = 'bk'
}

describe('毎日・毎時の処理の記録', () => {
  it('最後まで動いた時刻を記録する。失敗した時は時刻とエラーを記録して、エラーを投げ直す', () => {
    const h = guardHarness()
    h.c.dailyMaintenanceUnrecorded_ = () => {}
    call(h, 'dailyMaintenance')
    h.c.sendBatchNotificationsUnrecorded_ = () => {}
    call(h, 'sendBatchNotifications')
    const st = plain(call(h, 'jobStatus_', Date.now())) as Record<string, unknown>
    expect(st).toMatchObject({ dailyAt: expect.stringMatching(/^\d{4}-/), hourlyAt: expect.stringMatching(/^\d{4}-/), dailyStale: false })
    h.c.dailyMaintenanceUnrecorded_ = () => { throw new Error('トリガーの権限がありません') }
    expect(() => call(h, 'dailyMaintenance')).toThrow('トリガーの権限がありません')
    expect(plain(call(h, 'jobStatus_', Date.now()))).toMatchObject({ dailyError: 'トリガーの権限がありません', dailyFailedAt: expect.stringMatching(/^\d{4}-/) })
  })

  it('毎日の処理が26時間以上成功していなければ、止まったと見なす(setupOhsumi の時刻から数える。どちらも無ければ判定しない)', () => {
    const h = guardHarness()
    const now = Date.now()
    expect(plain(call(h, 'jobStatus_', now))).toMatchObject({ dailyStale: false })
    call(h, 'recordJobsInstalled_', now - 27 * HOUR)
    expect(plain(call(h, 'jobStatus_', now))).toMatchObject({ dailyStale: true, staleHours: 26 })
    h.props.JOB_STATE = JSON.stringify({ installedAt: new Date(now - 100 * HOUR).toISOString(), dailyAt: new Date(now - 25 * HOUR).toISOString() })
    expect(plain(call(h, 'jobStatus_', now))).toMatchObject({ dailyStale: false })
    expect(plain(call(h, 'jobStatus_', now + 2 * HOUR))).toMatchObject({ dailyStale: true })
  })

  it('代表だけが、管理画面で読める(読み取りの操作)', () => {
    const h = guardHarness()
    call(h, 'recordJobsInstalled_', Date.now() - 30 * HOUR)
    expect(h.post({ action: 'getOpsStatus', sessionToken: 'm-top' }).result.jobs.dailyStale).toBe(true)
    expect(h.post({ action: 'getOpsStatus', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
    expect(CODE_GS.match(/var READ_ONLY_ACTIONS = \[[^\]]*\]/)![0]).toContain("'getOpsStatus'")
  })

  it('毎日の処理(中身)で、共有を確かめる', () => {
    const body = CODE_GS.slice(CODE_GS.indexOf('function dailyMaintenanceUnrecorded_('), CODE_GS.indexOf('\n}\n', CODE_GS.indexOf('function dailyMaintenanceUnrecorded_(')))
    expect(body).toContain('checkSharing_(Date.now())')
    const setup = CODE_GS.slice(CODE_GS.indexOf('function setupOhsumi('), CODE_GS.indexOf('\n}\n', CODE_GS.indexOf('function setupOhsumi(')))
    expect(setup).toContain('checkSharing_(Date.now())')
    expect(setup).toContain('recordJobsInstalled_(Date.now())')
  })
})

describe('共有の確認', () => {
  it('GAS のアカウントと、代表への「閲覧者」の共有だけなら、問題なし', () => {
    const h = guardHarness()
    withSharing(h, { spreadsheet: { editors: [ME], viewers: ['TOP@example.com'] }, uploads: {}, backups: {} })
    expect(plain(call(h, 'checkSharing_', Date.now()))).toMatchObject({ problems: [] })
  })

  it('リンクでの共有・GAS のアカウント以外の編集者(代表も)・代表以外への共有を見つけ、代表の管理画面に出す', () => {
    const h = guardHarness()
    withSharing(h, {
      spreadsheet: { access: 'ANYONE_WITH_LINK', editors: [ME, 'top@example.com', 'leader@example.com'], viewers: ['top@example.com'] },
      uploads: { viewers: ['base@example.com'] },
      backups: { fail: true },
    })
    const res = h.post({ action: 'recheckSharing', sessionToken: 'm-top' })
    expect(res.ok, res.error).toBe(true)
    expect(res.result.sharing.problems).toEqual([
      { target: 'spreadsheet', kind: 'link', detail: 'ANYONE_WITH_LINK' },
      { target: 'spreadsheet', kind: 'editor', detail: 'top@example.com' },
      { target: 'spreadsheet', kind: 'editor', detail: 'leader@example.com' },
      { target: 'uploads', kind: 'viewer', detail: 'base@example.com' },
      { target: 'backups', kind: 'unknown', detail: 'Access denied' },
    ])
    // 覚えておき、次に管理画面を開いた時にも出す
    expect(h.post({ action: 'getOpsStatus', sessionToken: 'm-top' }).result.sharing.problems).toHaveLength(5)
    expect(h.post({ action: 'recheckSharing', sessionToken: 'm-base' })).toMatchObject({ ok: false, forbidden: true })
    // 直したら消える
    withSharing(h, { spreadsheet: {}, uploads: {}, backups: {} })
    expect(h.post({ action: 'recheckSharing', sessionToken: 'm-top' }).result.sharing.problems).toEqual([])
  })
})

describe('守る処理を外すと失敗する', () => {
  const mutated = (from: string, to: string) => {
    const code = CODE_GS.replace(from, to)
    expect(code, from).not.toBe(CODE_GS)
    return code
  }

  it('代表以外への共有の確かめを外すと、メンバーへの共有を見落とす', () => {
    const h = guardHarness({ code: mutated('if (email && email !== me && !tops[email]) problems.push', 'if (false) problems.push') })
    withSharing(h, { spreadsheet: { viewers: ['base@example.com'] }, uploads: {}, backups: {} })
    expect(plain(call(h, 'checkSharing_', Date.now()))).toMatchObject({ problems: [] })
  })

  it('編集者の確かめを外すと、GAS のアカウント以外の編集者を見落とす', () => {
    const h = guardHarness({ code: mutated("if (email && email !== me) problems.push({ target: t.key, kind: 'editor', detail: email })", '') })
    withSharing(h, { spreadsheet: { editors: ['leader@example.com'] }, uploads: {}, backups: {} })
    expect(plain(call(h, 'checkSharing_', Date.now()))).toMatchObject({ problems: [] })
  })

  it('毎日の処理の記録を外すと、止まっていなくても止まったと見なしてしまう', () => {
    const h = guardHarness({ code: mutated("  // 最後まで動いた時刻(止めている時も、トリガーが動いたことは記録する)。レジストリへの確認で伝える\n  recordJobRun_('daily', true)\n", '') })
    call(h, 'recordJobsInstalled_', Date.now() - 30 * HOUR)
    h.c.dailyMaintenanceUnrecorded_ = () => {}
    call(h, 'dailyMaintenance')
    expect(plain(call(h, 'jobStatus_', Date.now()))).toMatchObject({ dailyStale: true })
  })
})
