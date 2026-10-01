// 個人情報の削除(PR G): 退会したメンバー・採用しなかった候補者の個人情報を、保存期間(既定30日。代表が7〜365日で
// 変えられる)の後に毎日の処理で消す。7日前の知らせ・すぐ消す・延長・退会の取り消し・バックアップから戻した直後の消し直し
import { describe, expect, it } from 'vitest'
import { CODE_GS, guardHarness, type Cell } from './gas-guard-harness'
import { withDrive } from './gas-drive-fake'

type H = ReturnType<typeof guardHarness>
const DAY = 24 * 3600 * 1000
const call = (h: H, name: string, ...args: unknown[]) => (h.c[name] as (...a: unknown[]) => unknown)(...args)
const rowOf = (h: H, sheet: string, id: string) => {
  const rows = h.sheets[sheet].rows
  const r = rows.find((x) => x[0] === id)
  return r ? Object.fromEntries(rows[0].map((k, i) => [String(k), r[i] ?? ''])) as Record<string, Cell> : null
}
const CANDIDATE_HEADERS = ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at', 'rejected_at', 'purge_at']

// 個人情報を入れたメンバー(m-base)・完了したタスク・候補者
function setup(code?: string) {
  const h = guardHarness({ code })
  const m = h.sheets.Members.rows
  const head = m[0] as string[]
  for (const col of ['will_tags', 'skill_levels_json', 'career_history_json', 'one_on_ones_json', 'last_login', 'university', 'avatar_url']) head.push(col)
  for (const r of m.slice(1)) {
    while (r.length < head.length) r.push('')
  }
  const base = m.find((r) => r[0] === 'm-base')!
  const set = (col: string, v: Cell) => { base[head.indexOf(col)] = v }
  set('will_tags', 'デザイン')
  set('skill_levels_json', '[{"skill":"デザイン","level":3}]')
  set('career_history_json', '[{"id":"c1","affiliation":"自分で書いた実績"}]')
  set('one_on_ones_json', '[{"id":"o1","notes":"1on1 の記録"}]')
  set('last_login', '2026-09-30T00:00:00.000Z')
  set('university', '大学名')
  set('avatar_url', 'https://lh3.googleusercontent.com/d/x')
  const tasks = h.sheets.Tasks.rows
  const th = tasks[0] as string[]
  const done = th.map((k) => ({ id: 't-done', title: '終わったタスク', assignee_id: 'm-base,m-other', status: 'done', project_id: 'p1', visibility: 'all' } as Record<string, string>)[k] ?? '')
  const review = th.map((k) => ({ id: 't-review', title: '確認待ちのタスク', assignee_id: 'm-base', status: 'review', project_id: 'p1', visibility: 'all' } as Record<string, string>)[k] ?? '')
  tasks.push(done, review)
  h.addSheet('Candidates', [CANDIDATE_HEADERS,
    CANDIDATE_HEADERS.map((k) => ({ id: 'cand-no', name: '不採用の人', email: 'no@example.com', status: 'candidate', updated_at: '2026-09-01T00:00:00.000Z' } as Record<string, string>)[k] ?? ''),
    CANDIDATE_HEADERS.map((k) => ({ id: 'cand-yes', name: '選考中の人', email: 'yes@example.com', status: 'candidate', updated_at: '2026-09-01T00:00:00.000Z' } as Record<string, string>)[k] ?? ''),
  ])
  h.props['notif_queue_m-base'] = '[]'
  h.props.DATA_VERSION = 'v-setup'
  return h
}
const withdraw = (h: H) => h.post({ action: 'removeMember', sessionToken: 'm-top', memberId: 'm-base' })

describe('退会: 非表示にして保留する', () => {
  it('ログインできなくし、未完了のタスクの担当から外す。完了・確認待ちのタスクの担当と、個人情報は残す', () => {
    const h = setup()
    const res = withdraw(h)
    expect(res.ok, res.error).toBe(true)
    const m = rowOf(h, 'Members', 'm-base')!
    expect(m.inactive).toBe('TRUE')
    expect(String(m.withdrawn_at)).toMatch(/^\d{4}-/)
    expect(m.will_tags).toBe('デザイン')
    expect(rowOf(h, 'Tasks', 't1')!.assignee_id).toBe('')
    expect(rowOf(h, 'Tasks', 't-done')!.assignee_id).toBe('m-base,m-other')
    expect(rowOf(h, 'Tasks', 't-review')!.assignee_id).toBe('m-base')
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(true)
    // ログインできない(退会と分かる文)
    const login = h.post({ action: 'getInitialData', sessionToken: 'm-base' })
    expect(login.ok).toBe(false)
    expect(login.error).toContain('退会しています')
    // 休止の解除では戻せない
    expect(h.post({ action: 'updateMemberInactive', sessionToken: 'm-top', memberId: 'm-base', inactive: false }).error).toContain('退会を取り消して')
    expect(h.sheets.AuditLog.rows.at(-1)!.slice(1, 4)).toEqual(['m-top', 'removeMember', 'm-base'])
  })
})

describe('保存期間の後に消す', () => {
  it('既定の30日を過ぎたら、毎日の処理でメールアドレス・プロフィール・Will・スキル・実績・1on1・ログインの記録を消す', () => {
    const h = setup()
    withdraw(h)
    const at = Date.parse(String(rowOf(h, 'Members', 'm-base')!.withdrawn_at))
    // 29日目は消さない
    call(h, 'purgeExpiredPersonalData_', at + 29 * DAY, 'system')
    expect(rowOf(h, 'Members', 'm-base')!.will_tags).toBe('デザイン')
    call(h, 'purgeExpiredPersonalData_', at + 30 * DAY + 1000, 'system')
    const m = rowOf(h, 'Members', 'm-base')!
    expect(m.name).toBe('退会したメンバー')
    for (const col of ['will_tags', 'skill_levels_json', 'career_history_json', 'one_on_ones_json', 'last_login', 'university', 'avatar_url', 'project_ids', 'locale']) {
      expect(m[col], col).toBe('')
    }
    expect(m).toMatchObject({ id: 'm-base', role: 'base', inactive: 'TRUE', personal_data_purged_at: expect.stringMatching(/^\d{4}-/) })
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(false)
    expect(h.props['notif_queue_m-base']).toBeUndefined()
    // タスクの担当の記録は、ID のまま残る(画面には「退会したメンバー」と出る)
    expect(rowOf(h, 'Tasks', 't-done')!.assignee_id).toBe('m-base,m-other')
    expect(h.sheets.AuditLog.rows.at(-1)!.slice(1, 3)).toEqual(['system', 'purgePersonalData'])
  })

  it('採用しなかった候補者は、行ごと消す(選考中・採用した人は消さない)。不採用から戻したら、消す予定も消す', () => {
    const h = setup()
    expect(h.post({ action: 'updateCandidate', sessionToken: 'm-top', candidateId: 'cand-no', fields: { status: 'rejected' } }).ok).toBe(true)
    const rejectedAt = Date.parse(String(rowOf(h, 'Candidates', 'cand-no')!.rejected_at))
    expect(rejectedAt).toBeGreaterThan(0)
    call(h, 'purgeExpiredPersonalData_', rejectedAt + 31 * DAY, 'system')
    expect(rowOf(h, 'Candidates', 'cand-no')).toBeNull()
    expect(rowOf(h, 'Candidates', 'cand-yes')).not.toBeNull()
    // 戻した時
    h.post({ action: 'updateCandidate', sessionToken: 'm-top', candidateId: 'cand-yes', fields: { status: 'rejected' } })
    h.post({ action: 'updateCandidate', sessionToken: 'm-top', candidateId: 'cand-yes', fields: { status: 'candidate' } })
    expect(rowOf(h, 'Candidates', 'cand-yes')!.rejected_at).toBe('')
    call(h, 'purgeExpiredPersonalData_', Date.now() + 400 * DAY, 'system')
    expect(rowOf(h, 'Candidates', 'cand-yes')).not.toBeNull()
  })

  it('対応するメンバーがいないメールアドレスの行は、自動では消さずに件数と一覧を出す。代表が「消す」を押した行だけ消す', () => {
    const h = setup()
    h.sheets.MemberEmails.rows.push(['m-gone', 'gone@example.com'], ['m-shifted', 'shifted@example.com'])
    call(h, 'purgeExpiredPersonalData_', Date.now() + 400 * DAY, 'system')
    expect(h.sheets.MemberEmails.rows.filter((r) => String(r[0]).startsWith('m-gone') || r[0] === 'm-shifted')).toHaveLength(2)
    const st = h.post({ action: 'getPersonalDataStatus', sessionToken: 'm-top' }).result
    expect(st.orphanEmails).toEqual([{ id: 'm-gone', email: 'gone@example.com' }, { id: 'm-shifted', email: 'shifted@example.com' }])
    // 代表だけ。確かめた行(m-gone)だけを消す。今いるメンバーの行は、画面が送っても消さない
    expect(h.post({ action: 'deleteOrphanEmails', sessionToken: 'm-lead', ids: ['m-gone'] })).toMatchObject({ ok: false, forbidden: true })
    const res = h.post({ action: 'deleteOrphanEmails', sessionToken: 'm-top', ids: ['m-gone', 'm-base'] })
    expect(res.ok, res.error).toBe(true)
    expect(res.result).toEqual({ deleted: 1, skipped: 1 })
    const ids = h.sheets.MemberEmails.rows.map((r) => r[0])
    expect(ids).not.toContain('m-gone')
    expect(ids).toEqual(expect.arrayContaining(['m-shifted', 'm-base']))
    expect(h.sheets.AuditLog.rows.at(-1)!.slice(1, 3)).toEqual(['m-top', 'deleteOrphanEmails'])
  })

  it('Members が読めない(空)時は、対応するメンバーがいない行として出さない', () => {
    const h = setup()
    h.sheets.Members.rows = h.sheets.Members.rows.slice(0, 1)
    expect(call(h, 'orphanEmailRows_')).toEqual([])
  })
})

describe('代表の管理画面', () => {
  it('保存期間は7〜365日で変えられる(代表だけ)。消す7日前から「○人分を○日に消します」の数を返す', () => {
    const h = setup()
    expect(h.post({ action: 'setPersonalDataRetention', sessionToken: 'm-top', days: 6 }).error).toContain('7〜365')
    expect(h.post({ action: 'setPersonalDataRetention', sessionToken: 'm-top', days: 366 }).error).toContain('7〜365')
    expect(h.post({ action: 'setPersonalDataRetention', sessionToken: 'm-lead', days: 10 })).toMatchObject({ ok: false, forbidden: true })
    expect(h.post({ action: 'getPersonalDataStatus', sessionToken: 'm-lead' })).toMatchObject({ ok: false, forbidden: true })
    expect(h.post({ action: 'setPersonalDataRetention', sessionToken: 'm-top', days: 10 }).ok).toBe(true)
    withdraw(h)
    const st = h.post({ action: 'getPersonalDataStatus', sessionToken: 'm-top' }).result
    expect(st.retentionDays).toBe(10)
    expect(st.pending).toEqual([expect.objectContaining({ kind: 'member', id: 'm-base', name: '一般' })])
    expect(Date.parse(st.pending[0].purgeAt) - Date.parse(st.pending[0].since)).toBe(10 * DAY)
    // 10日後に消す → 7日前の知らせはまだ出ない
    expect(st.upcoming).toEqual([])
    const soon = call(h, 'personalDataStatus_', Date.parse(st.pending[0].purgeAt) - 6 * DAY) as { upcoming: unknown[] }
    expect(JSON.parse(JSON.stringify(soon.upcoming))).toEqual([{ date: '2026-10-01', count: 1 }])
  })

  it('特定の人だけ、すぐ消す・延長する・退会を取り消す', () => {
    const h = setup()
    withdraw(h)
    const ext = h.post({ action: 'extendPersonalData', sessionToken: 'm-top', kind: 'member', id: 'm-base' })
    expect(ext.ok, ext.error).toBe(true)
    const pending = h.post({ action: 'getPersonalDataStatus', sessionToken: 'm-top' }).result.pending[0]
    expect(Date.parse(pending.purgeAt) - Date.parse(pending.since)).toBe(60 * DAY)
    expect(pending.extended).toBe(true)
    // 取り消すと、元に戻る(ログインできる)。退会の時に未アサインに戻したタスクの一覧を返す(完了・確認待ちは入らない)
    const cancel = h.post({ action: 'cancelWithdrawal', sessionToken: 'm-top', memberId: 'm-base' })
    expect(cancel.ok, cancel.error).toBe(true)
    expect(cancel.result.unassignedTasks).toEqual([{ id: 't1', title: 'タスク1', status: 'todo', assigneeIds: [] }])
    expect(rowOf(h, 'Members', 'm-base')).toMatchObject({ inactive: '', withdrawn_at: '', purge_at: '', withdrawal_unassigned_task_ids: '' })
    // もう一度退会して、すぐ消す
    withdraw(h)
    expect(h.post({ action: 'purgePersonalDataNow', sessionToken: 'm-top', kind: 'member', id: 'm-base' }).ok).toBe(true)
    expect(rowOf(h, 'Members', 'm-base')!.name).toBe('退会したメンバー')
    expect(h.post({ action: 'cancelWithdrawal', sessionToken: 'm-top', memberId: 'm-base' }).error).toContain('見つかりません')
    const audit = h.sheets.AuditLog.rows.slice(1).map((r) => r[2])
    expect(audit).toEqual(expect.arrayContaining(['extendPersonalData', 'cancelWithdrawal', 'purgePersonalDataNow']))
  })
})

describe('テスト環境で、期限を待たずに確かめる(testPersonalDataPurge)', () => {
  it('TEST_ENVIRONMENT の時だけ、TEST_DAYS_AHEAD 日だけ日付を進めて、個人情報の削除を実行する', () => {
    const h = setup()
    withdraw(h)
    expect(() => call(h, 'testPersonalDataPurge')).toThrow(/テスト環境ではない/)
    h.c.isTestEnvironment_ = () => true
    h.props.TEST_DAYS_AHEAD = '29'
    const early = call(h, 'testPersonalDataPurge') as { done: { members: string[] }; before: { upcoming: unknown[] } }
    expect(early.done.members).toEqual([])
    expect(early.before.upcoming).toHaveLength(1)
    expect(rowOf(h, 'Members', 'm-base')!.will_tags).toBe('デザイン')
    h.props.TEST_DAYS_AHEAD = '31'
    expect((call(h, 'testPersonalDataPurge') as { done: { members: string[] } }).done.members).toEqual(['m-base'])
    expect(rowOf(h, 'Members', 'm-base')!.name).toBe('退会したメンバー')
    h.props.TEST_DAYS_AHEAD = '401'
    expect(() => call(h, 'testPersonalDataPurge')).toThrow(/0〜400/)
  })
})

describe('バックアップから戻した直後', () => {
  it('戻した中に保存期間を過ぎた個人情報があれば、すぐに消し直す(全体を戻す・一部のタスクを戻す)', () => {
    const h = setup()
    const d = withDrive(h)
    withdraw(h)
    // 退会から40日たったことにして、バックアップを作る(まだ消していない状態のコピー)
    const old = new Date(Date.now() - 40 * DAY).toISOString()
    h.sheets.Members.rows.find((r) => r[0] === 'm-base')![h.sheets.Members.rows[0].indexOf('withdrawn_at')] = old
    call(h, 'dailyBackup_', Date.now())
    const backupId = d.live()[0].id
    call(h, 'purgeExpiredPersonalData_', Date.now(), 'system')
    expect(rowOf(h, 'Members', 'm-base')!.name).toBe('退会したメンバー')
    const res = h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId })
    expect(res.ok, res.error).toBe(true)
    expect(rowOf(h, 'Members', 'm-base')!.name).toBe('退会したメンバー')
    expect(rowOf(h, 'Members', 'm-base')!.will_tags).toBe('')
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(false)
  })
})

describe('守る処理を外すと失敗する', () => {
  const mutated = (from: string, to: string) => {
    const code = CODE_GS.replace(from, to)
    expect(code, from).not.toBe(CODE_GS)
    return code
  }

  it('期限の確かめを外すと、保存期間の前に消してしまう', () => {
    const h = setup(mutated('if (!(at > 0) || at > nowMs) return\n    if (p.kind', 'if (!(at > 0)) return\n    if (p.kind'))
    withdraw(h)
    call(h, 'purgeExpiredPersonalData_', Date.now(), 'system')
    expect(rowOf(h, 'Members', 'm-base')!.name).toBe('退会したメンバー')
  })

  it('対応するメンバーがいない行の確かめを外すと、今いるメンバーのメールアドレスを消してしまう', () => {
    const h = setup(mutated('var targets = Object.keys(wanted).filter(function (id) { return orphan[id] })', 'var targets = Object.keys(wanted)'))
    h.post({ action: 'deleteOrphanEmails', sessionToken: 'm-top', ids: ['m-base'] })
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(false)
  })

  it('メールアドレスの行を消す処理を外すと、メールアドレスが残る', () => {
    const h = setup(mutated("  deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return String(o.id) === String(memberId) })\n", ''))
    withdraw(h)
    // 以前の退会の分を消す処理は残っているので、名前を消した後に行を足し直して確かめる
    call(h, 'purgePersonalDataNow_', 'member', 'm-base', 'm-top', Date.now())
    expect(h.sheets.MemberEmails.rows.some((r) => r[0] === 'm-base')).toBe(true)
  })

  it('戻した直後の消し直しを外すと、消した個人情報が戻ってしまう', () => {
    const h = setup(mutated("    // 戻した中に、保存期間を過ぎた個人情報があれば、すぐに消し直す\n    purgeExpiredPersonalData_(nowMs, actorId)\n", ''))
    const d = withDrive(h)
    withdraw(h)
    h.sheets.Members.rows.find((r) => r[0] === 'm-base')![h.sheets.Members.rows[0].indexOf('withdrawn_at')] = new Date(Date.now() - 40 * DAY).toISOString()
    call(h, 'dailyBackup_', Date.now())
    call(h, 'purgeExpiredPersonalData_', Date.now(), 'system')
    h.post({ action: 'restoreBackup', sessionToken: 'm-top', backupId: d.live()[0].id })
    expect(rowOf(h, 'Members', 'm-base')!.will_tags).toBe('デザイン')
  })

  it('完了したタスクの担当を残す処理を外すと、担当の記録が消える', () => {
    const h = setup(mutated('      if (WITHDRAW_KEEP_ASSIGNEE_STATUSES.indexOf(status) >= 0) continue\n', ''))
    withdraw(h)
    expect(rowOf(h, 'Tasks', 't-done')!.assignee_id).toBe('m-other')
  })
})
