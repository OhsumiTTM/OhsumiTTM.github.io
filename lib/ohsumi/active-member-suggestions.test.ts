// 担当のおすすめ・仕事の振り直しの提案に、休止中・退会したメンバーが出ないことを確かめる
import { describe, expect, it } from 'vitest'
import type { Member, Task } from './types'
import { isActiveMember, rankCandidates, suggestWorkloadRebalance } from './utils'

const member = (id: string, extra: Partial<Member> = {}) => ({ id, name: id, skills: ['設計'], role: 'base', ...extra }) as unknown as Member
const task = (id: string, assigneeIds: string[], status = 'progress') =>
  ({ id, name: id, skills: ['設計'], assigneeIds, status, deadline: null }) as unknown as Task

describe('提案の候補', () => {
  const active = member('active')
  const paused = member('paused', { inactive: true } as Partial<Member>)
  const withdrawn = member('withdrawn', { withdrawnAt: '2026-09-01T00:00:00Z' } as Partial<Member>)

  it('isActiveMember は休止中・退会したメンバーを除く', () => {
    expect([active, paused, withdrawn].filter(isActiveMember).map((m) => m.id)).toEqual(['active'])
  })

  it('担当のおすすめに休止中・退会したメンバーを出さない', () => {
    const ids = rankCandidates({ skills: ['設計'] }, [active, paused, withdrawn]).map((r) => r.member.id)
    expect(ids).toEqual(['active'])
  })

  it('仕事の振り直しの提案で、休止中・退会したメンバーへ振らない', () => {
    const busy = member('busy')
    const tasks = Array.from({ length: 8 }, (_, i) => task('t' + i, ['busy']))
    const to = suggestWorkloadRebalance([busy, active, paused, withdrawn], tasks).map((s) => s.to.id)
    expect(to.length).toBeGreaterThan(0)
    expect(to.every((id) => id === 'active')).toBe(true)
  })
})
