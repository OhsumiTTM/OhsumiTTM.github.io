// 担当の候補の区別(即戦力・成長・支援・メンター。lib/ohsumi/assign-candidates.ts)
import { describe, expect, it } from 'vitest'
import type { Member, Task } from './types'
import { classifyCandidates, parseAssignCandidateRules, DEFAULT_ASSIGN_CANDIDATE_RULES } from './assign-candidates'

const member = (id: string, extra: Partial<Member> = {}) =>
  ({ id, name: id, role: 'base', skills: [], will: [], judgment: [], facts: [], ...extra }) as unknown as Member
const lv = (skill: string, level: number) => ({ skill, level }) as NonNullable<Member['skillLevels']>[number]
// 実績の無い人は、未完了の担当タスクの想定時間が6時間を超えると「余力なし」
const busyTask = (memberId: string) =>
  ({ id: 'busy-' + memberId, name: 'busy', skills: [], assigneeIds: [memberId], status: 'progress', estimatedHours: 10, deadline: null }) as unknown as Task

const kinds = (task: Parameters<typeof classifyCandidates>[0], members: Member[], tasks: Task[] = [], level = 3) =>
  classifyCandidates(task, members, tasks, { mentor_min_level: level as 3 }).map((c) => [c.member.id, c.kind])

describe('候補の種類', () => {
  const task = { skills: ['デザイン', '広報'] }

  it('要るスキルを全部持つ人は即戦力、一部は支援、身につけたい人は成長', () => {
    const ready = member('ready', { skills: ['デザイン', '広報'] })
    const support = member('support', { skills: ['広報'] })
    const growth = member('growth', { desiredSkills: ['デザイン'] })
    const none = member('none', { skills: ['経理'] })
    expect(kinds(task, [none, support, growth, ready])).toEqual([['ready', 'ready'], ['growth', 'growth'], ['support', 'support']])
  })

  it('要るレベルに足りない時は即戦力にしない(身につけたいなら成長、そうでなければ支援)', () => {
    const t = { skills: ['デザイン'], requiredSkillLevels: { デザイン: 3 as const } }
    const enough = member('enough', { skills: ['デザイン'], skillLevels: [lv('デザイン', 3)] })
    const low = member('low', { skills: ['デザイン'], skillLevels: [lv('デザイン', 2)], desiredSkills: ['デザイン'] })
    const unknown = member('unknown', { skills: ['デザイン'] })
    expect(kinds(t, [unknown, low, enough], [], 5)).toEqual([['enough', 'ready'], ['low', 'growth'], ['unknown', 'support']])
  })

  it('余力なしの人は即戦力・成長・支援に出さない。決めたレベル以上ならメンターとして出す', () => {
    const busyExpert = member('busyExpert', { skills: ['デザイン', '広報'], skillLevels: [lv('デザイン', 4)] })
    const busyNovice = member('busyNovice', { skills: ['デザイン', '広報'], skillLevels: [lv('デザイン', 2)] })
    const tasks = [busyTask('busyExpert'), busyTask('busyNovice')]
    expect(kinds(task, [busyExpert, busyNovice], tasks)).toEqual([['busyExpert', 'mentor']])
    // レベルの下限は団体ごと(ここでは2)
    expect(kinds(task, [busyExpert, busyNovice], tasks, 2)).toEqual([['busyExpert', 'mentor'], ['busyNovice', 'mentor']])
  })

  it('メンターが成長の候補の人のメンターなら、その人を付ける', () => {
    const mentor = member('mentor', { skills: ['デザイン'], skillLevels: [lv('デザイン', 5)] })
    const mentee = member('mentee', { desiredSkills: ['デザイン'], mentorId: 'mentor' })
    const res = classifyCandidates(task, [mentor, mentee], [busyTask('mentor')])
    expect(res.map((c) => [c.member.id, c.kind, c.menteeIds])).toEqual([['mentee', 'growth', []], ['mentor', 'mentor', ['mentee']]])
    expect(res[0].growthSkills).toEqual(['デザイン'])
    expect(res[1].mentorSkills).toEqual(['デザイン'])
  })

  it('休止中・退会した人と、もう担当の人は出さない。要るスキルが無いタスクは候補なし', () => {
    const paused = member('paused', { skills: ['デザイン', '広報'], inactive: true })
    const left = member('left', { skills: ['デザイン', '広報'], withdrawnAt: '2026-09-01T00:00:00Z' })
    const assigned = member('assigned', { skills: ['デザイン', '広報'] })
    expect(kinds({ ...task, assigneeIds: ['assigned'] }, [paused, left, assigned])).toEqual([])
    expect(kinds({ skills: [] }, [member('x', { skills: ['デザイン'] })])).toEqual([])
  })
})

describe('団体の設定(assign_candidate_rules)', () => {
  it('1〜5 の整数だけ読む。それ以外・空は既定(3)', () => {
    expect(parseAssignCandidateRules('{"mentor_min_level":4}')).toEqual({ mentor_min_level: 4 })
    for (const raw of ['', null, '{"mentor_min_level":0}', '{"mentor_min_level":2.5}', 'not json', '{"mentor_min_level":"4"}']) {
      expect(parseAssignCandidateRules(raw)).toEqual(DEFAULT_ASSIGN_CANDIDATE_RULES)
    }
  })
})
