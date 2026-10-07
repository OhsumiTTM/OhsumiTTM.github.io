// 担当者が「完了」を選んだ時に、確認待ちに入ること(GAS 側で変える)と、確認待ちが届く人(確認者 → 報告先 → 全権管理者)
import { describe, expect, it } from 'vitest'
import { guardHarness } from './gas-guard-harness'
import { doneTransition, reviewTargets } from './permissions'
import { rolesFromLegacy } from './roles'

type H = ReturnType<typeof guardHarness>
const set = (h: H, sheet: string, id: string, fields: Record<string, string>) => {
  const [head, ...rows] = h.sheets[sheet].rows
  const row = rows.find((r) => r[0] === id)!
  for (const [k, v] of Object.entries(fields)) row[head.indexOf(k)] = v
  return h
}
const status = (h: H, id = 't1') => {
  const head = h.sheets.Tasks.rows[0]
  return String(h.sheets.Tasks.rows.find((r) => r[0] === id)![head.indexOf('status')])
}
const done = (h: H, token: string, taskId = 't1') => h.post({ action: 'updateTaskStatus', sessionToken: token, taskId, status: 'done' })
const mailsTo = (h: H) => h.allSent().filter((s) => s.kind === 'mail' && s.text.includes('確認をお願いします')).map((s) => s.to).sort()

describe('担当者が「完了」を選ぶと、確認待ちになる', () => {
  it('確認者がいる: 確認待ちにして、確認者に知らせる。確認者はそのまま完了にできる', () => {
    const h = set(guardHarness(), 'Tasks', 't1', { reviewer_ids: 'm-other' })
    const res = done(h, 'm-base')
    expect(res.ok, res.error).toBe(true)
    expect(res.result.status).toBe('review')
    expect(status(h)).toMatch(/review|確認待ち/)
    expect(mailsTo(h)).toEqual(['other@example.com'])
    expect(done(h, 'm-other').ok).toBe(true)
    expect(status(h)).toMatch(/done|完了/)
  })

  it('確認者がいない: 担当者の報告先に届き、報告先が完了にできる', () => {
    const h = guardHarness()
    expect(done(h, 'm-base').result.status).toBe('review')
    expect(mailsTo(h)).toEqual(['lead@example.com'])
    expect(done(h, 'm-lead').ok).toBe(true)
    expect(status(h)).toMatch(/done|完了/)
  })

  it('確認者も報告先もいない: 全権管理者(代表を含む)に届く。ほかの一般のメンバーは完了にできない', () => {
    const h = set(guardHarness(), 'Members', 'm-base', { reports_to_id: '' })
    expect(done(h, 'm-base').result.status).toBe('review')
    // この団体では、代表と班長(制限のない管理者)が全権管理者
    expect(mailsTo(h)).toEqual(['top@example.com,lead@example.com'])
    expect(done(h, 'm-other')).toMatchObject({ ok: false })
    expect(done(h, 'm-top').ok).toBe(true)
  })

  it('退会した報告先は飛ばして、全権管理者に届く', () => {
    const h = guardHarness()
    const head = h.sheets.Members.rows[0]
    if (!head.includes('withdrawn_at')) h.sheets.Members.rows.forEach((r, i) => r.push(i === 0 ? 'withdrawn_at' : ''))
    set(h, 'Members', 'm-lead', { withdrawn_at: '2026-10-01T00:00:00Z' })
    expect(done(h, 'm-base').result.status).toBe('review')
    // 退会した班長は、全権管理者の宛先にも入らない
    expect(mailsTo(h)).toEqual(['top@example.com'])
  })

  it('担当者でも確認する人でもない人は、完了を選べない(今までどおり)', () => {
    const h = guardHarness()
    expect(done(h, 'm-other')).toMatchObject({ ok: false })
    expect(status(h)).toBe('todo')
  })
})

describe('画面の決まり(permissions.ts)は GAS と同じ', () => {
  const roles = rolesFromLegacy({})
  const members = [
    { id: 'top', role: '代表' as const },
    { id: 'lead', role: '班長' as const },
    { id: 'base', role: '一般' as const, reportsToId: 'lead' },
    { id: 'solo', role: '一般' as const },
  ]
  it('確認者 → 報告先 → 全権管理者', () => {
    expect(reviewTargets({ assigneeIds: ['base'], reviewerIds: ['x'] }, members, roles)).toEqual({ kind: 'reviewers', ids: ['x'] })
    expect(reviewTargets({ assigneeIds: ['base'] }, members, roles)).toEqual({ kind: 'reportsTo', ids: ['lead'] })
    expect(reviewTargets({ assigneeIds: ['solo'] }, members, roles).kind).toBe('fullAdmins')
    expect(reviewTargets({ assigneeIds: ['solo'] }, members, roles).ids).toContain('top')
  })
  it('担当者は確認待ち、確認する人と全権管理者は完了、ほかの人は選べない', () => {
    expect(doneTransition({ assigneeIds: ['base'] }, 'base', false, members, roles)).toBe('review')
    expect(doneTransition({ assigneeIds: ['base'] }, 'lead', false, members, roles)).toBe('done')
    expect(doneTransition({ assigneeIds: ['base'] }, 'top', true, members, roles)).toBe('done')
    expect(doneTransition({ assigneeIds: ['base'] }, 'solo', false, members, roles)).toBeNull()
  })
})
