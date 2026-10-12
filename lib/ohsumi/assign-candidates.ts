// 担当の候補の区別(即戦力・成長・支援・メンター)。管理画面の「担当を決める」と、INPUT の担当者のおすすめに使う。
// 生成AIは使わず、メンバーが持っているスキル・スキルのレベル・身につけたいスキル・メンターの設定・稼働の目安だけで決める。
//
//   即戦力(ready)    要るスキルを全部持っている。タスクに要るレベルがあるスキルは、そのレベル以上
//   成長(growth)     要るスキルのどれかを「身につけたいスキル」にしていて、そのスキルをまだ持っていないか、レベルが足りない
//   支援(support)    要るスキルの一部を持っている(全部ではない)
//   メンター(mentor) 要るスキルのどれかを、団体で決めたレベル(assign_candidate_rules の mentor_min_level。既定 3)以上で持っている
//
// 1人が複数に当てはまる時は、上の順で1つにする。休止中・退会したメンバーと、もう担当の人は出さない。
// 稼働の目安が「余力なし」の人は、即戦力・成長・支援には出さない(偏りを防ぐ)。メンターは手伝い役なので出す。
// それぞれの中は、一致するスキルの数の多い順(同じなら元の並び)
import type { Member, SkillLevelValue, Task } from './types'
import { DEFAULT_WORKLOAD_RULES, type WorkloadRules } from './workload-rules'
import { isActiveMember, memberWorkloadCapacity } from './utils'

export type CandidateKind = 'ready' | 'growth' | 'support' | 'mentor'
export const CANDIDATE_KINDS: CandidateKind[] = ['ready', 'growth', 'support', 'mentor']

/** 団体の設定(Settings の assign_candidate_rules) */
export interface AssignCandidateRules {
  mentor_min_level: SkillLevelValue
}
export const DEFAULT_ASSIGN_CANDIDATE_RULES: AssignCandidateRules = { mentor_min_level: 3 }

/** Settings の値を読む。形が違う・空なら既定 */
export function parseAssignCandidateRules(raw: string | undefined | null): AssignCandidateRules {
  if (!raw) return DEFAULT_ASSIGN_CANDIDATE_RULES
  try {
    const v = JSON.parse(raw) as { mentor_min_level?: unknown }
    const n = v?.mentor_min_level
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5) return { mentor_min_level: n as SkillLevelValue }
  } catch {
    // 既定にする
  }
  return DEFAULT_ASSIGN_CANDIDATE_RULES
}

export interface AssignCandidate {
  member: Member
  kind: CandidateKind
  /** 要るスキルのうち、持っているもの */
  matches: string[]
  /** 成長: 身につけたいスキルのうち、このタスクで伸ばせるもの */
  growthSkills: string[]
  /** メンター: 決めたレベル以上で持っている要るスキル */
  mentorSkills: string[]
  /** メンター: この人がメンターになっている、成長の候補の人 */
  menteeIds: string[]
}

type CandidateTask = Pick<Task, 'skills'> & { assigneeIds?: string[]; requiredSkillLevels?: Task['requiredSkillLevels'] }

const levelOf = (m: Member, skill: string): number | undefined => m.skillLevels?.find((s) => s.skill === skill)?.level
const holds = (m: Member, skill: string) => m.skills.includes(skill) || levelOf(m, skill) != null

// 要るレベルがあるスキルは、そのレベル以上で持っていれば満たす(レベルが分からない時は満たさない)
function meets(m: Member, skill: string, task: CandidateTask): boolean {
  if (!holds(m, skill)) return false
  const required = task.requiredSkillLevels?.[skill]
  if (required == null) return true
  const level = levelOf(m, skill)
  return level != null && level >= required
}

export function classifyCandidates(
  task: CandidateTask,
  members: Member[],
  allTasks?: Task[],
  rules: AssignCandidateRules = DEFAULT_ASSIGN_CANDIDATE_RULES,
  workloadRules: WorkloadRules = DEFAULT_WORKLOAD_RULES,
  now: Date = new Date(),
): AssignCandidate[] {
  const skills = task.skills
  if (skills.length === 0) return []
  const out: AssignCandidate[] = []
  for (const m of members) {
    if (!isActiveMember(m) || task.assigneeIds?.includes(m.id)) continue
    const full = !!allTasks && memberWorkloadCapacity(m.id, allTasks, now, workloadRules) === 'full'
    const matches = skills.filter((s) => holds(m, s))
    const growthSkills = skills.filter((s) => (m.desiredSkills ?? []).includes(s) && !meets(m, s, task))
    const mentorSkills = skills.filter((s) => (levelOf(m, s) ?? 0) >= rules.mentor_min_level)
    let kind: CandidateKind | null = null
    if (!full && skills.every((s) => meets(m, s, task))) kind = 'ready'
    else if (!full && growthSkills.length > 0) kind = 'growth'
    else if (!full && matches.length > 0) kind = 'support'
    else if (mentorSkills.length > 0) kind = 'mentor'
    if (kind) out.push({ member: m, kind, matches, growthSkills, mentorSkills, menteeIds: [] })
  }
  // メンター: 成長の候補の人のメンター(メンバーの mentorId)なら、その人を付ける
  const growthMembers = out.filter((c) => c.kind === 'growth').map((c) => c.member)
  for (const c of out) {
    if (c.kind !== 'mentor') continue
    c.menteeIds = growthMembers.filter((g) => g.mentorId === c.member.id).map((g) => g.id)
  }
  const order = (c: AssignCandidate) => CANDIDATE_KINDS.indexOf(c.kind)
  const weight = (c: AssignCandidate) => (c.kind === 'growth' ? c.growthSkills.length : c.kind === 'mentor' ? c.mentorSkills.length : c.matches.length)
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => order(a.c) - order(b.c) || weight(b.c) - weight(a.c) || (b.c.kind === 'mentor' ? b.c.menteeIds.length - a.c.menteeIds.length : 0) || a.i - b.i)
    .map(({ c }) => c)
}
