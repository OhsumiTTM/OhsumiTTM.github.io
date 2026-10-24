// 項目ごとの公開範囲(v1.2。Settings の member_field_visibility。gas/src/33-member-field-visibility.gs と同じ決まり)。
//
// 項目ごとに、見せる相手(上長・部署長・メンター・プロジェクトの責任者・幹部・全員)の組み合わせを決める。
// 本人はいつも見られる。空の組み合わせは「本人だけ」。代表(最上位の役職)は「本人だけ」以外を見られる。
// 判定は団体の GAS が読み取りの時に行う(範囲の外の人には値を送らない)。この画面の計算は、設定の画面の
// 「この人から見ると」と、自分のページの「見られる人」の表示のためだけに使う。
// 以前の範囲(文字列)は、同じ意味の組み合わせとして読む:
//   all → [all] / supervisor → [boss, mentor, projectOwner] / admin → [leaders] / self → []
import type { DepartmentTreeNode, Member, Project } from './types'

export const FIELD_AUDIENCES = ['boss', 'deptHead', 'mentor', 'projectOwner', 'leaders', 'all'] as const
export type FieldAudience = (typeof FIELD_AUDIENCES)[number]
export const LEGACY_FIELD_AUDIENCES: Record<string, FieldAudience[]> = {
  all: ['all'], supervisor: ['boss', 'mentor', 'projectOwner'], admin: ['leaders'], self: [],
}
// 狭めるだけの項目(幹部・全員は選べない)
export const NARROW_ONLY_FIELDS = ['evaluation_history_json', 'one_on_ones_json', 'development_plan_json',
  'career_aspiration', 'desired_future_role', 'career_plan', 'survey_responses_json']
export const NARROW_ONLY_FORBIDDEN: FieldAudience[] = ['leaders', 'all']
export const CUSTOM_FIELD_PREFIX = 'custom:'
export const DAILY_REPORTS_FIELD = 'daily_reports'

export const AUDIENCE_LABELS: Record<FieldAudience, { ja: string; en: string }> = {
  boss: { ja: '上長', en: 'Managers' },
  deptHead: { ja: '部署長', en: 'Department heads' },
  mentor: { ja: 'メンター', en: 'Mentor' },
  projectOwner: { ja: 'プロジェクトの責任者', en: 'Project owners' },
  leaders: { ja: '幹部', en: 'Leaders' },
  all: { ja: '全員', en: 'Everyone' },
}

// 設定できる項目と、今までの範囲(gas/src/26-read-policy.gs の READ_POLICY.Members。一致を field-audiences.test.ts で確かめる)。
// group: 設定の画面のまとまり
export interface FieldDef { key: string; ja: string; en: string; group: 'basic' | 'career' | 'skills' | 'growth' | 'school' | 'other'; default: FieldAudience[] }
const ALL: FieldAudience[] = ['all']
const LEADERS: FieldAudience[] = ['leaders']
const SUPERVISORS: FieldAudience[] = ['boss', 'mentor', 'projectOwner']
export const MEMBER_FIELDS: FieldDef[] = [
  { key: 'will_tags', ja: 'やりたいこと', en: 'Interests', group: 'basic', default: ALL },
  { key: 'judgment_tags', ja: '判断の傾向', en: 'Judgment tags', group: 'basic', default: ALL },
  { key: 'joined_at', ja: '所属開始日', en: 'Joined date', group: 'basic', default: ALL },
  { key: 'department_path', ja: '所属の部署', en: 'Departments', group: 'basic', default: ALL },
  { key: 'unavailable_dates', ja: '参加できない日', en: 'Unavailable dates', group: 'basic', default: ALL },
  { key: 'absent_dates', ja: '休みの日', en: 'Absent dates', group: 'basic', default: ALL },
  { key: 'available_hours_json', ja: '稼働できる時間', en: 'Available hours', group: 'basic', default: ALL },
  { key: 'timezone', ja: 'タイムゾーン', en: 'Time zone', group: 'basic', default: ALL },
  { key: 'last_login', ja: '最終ログイン', en: 'Last login', group: 'basic', default: LEADERS },
  { key: 'mentor_id', ja: 'メンター', en: 'Mentor', group: 'career', default: LEADERS },
  { key: 'has_management_experience', ja: 'マネジメントの経験', en: 'Management experience', group: 'career', default: LEADERS },
  { key: 'desired_areas', ja: '希望の分野', en: 'Desired areas', group: 'career', default: LEADERS },
  { key: 'desired_skills', ja: '伸ばしたいスキル', en: 'Desired skills', group: 'career', default: LEADERS },
  { key: 'career_history_json', ja: '経歴', en: 'Career history', group: 'career', default: LEADERS },
  { key: 'transfer_history_json', ja: '異動の記録', en: 'Transfers', group: 'career', default: LEADERS },
  { key: 'career_aspiration', ja: 'キャリアの希望', en: 'Career aspiration', group: 'career', default: SUPERVISORS },
  { key: 'desired_future_role', ja: '将来なりたい役割', en: 'Desired future role', group: 'career', default: SUPERVISORS },
  { key: 'career_plan', ja: 'キャリアの計画', en: 'Career plan', group: 'career', default: SUPERVISORS },
  { key: 'skill_levels_json', ja: 'スキルのレベル', en: 'Skill levels', group: 'skills', default: ALL },
  { key: 'skill_points_json', ja: 'スキルのポイント', en: 'Skill points', group: 'skills', default: LEADERS },
  { key: 'skill_approvals_json', ja: 'スキルの承認', en: 'Skill approvals', group: 'skills', default: SUPERVISORS },
  { key: 'qualifications_json', ja: '資格', en: 'Qualifications', group: 'skills', default: LEADERS },
  { key: 'quiz_passes_json', ja: '検定の合格', en: 'Quiz passes', group: 'skills', default: LEADERS },
  { key: 'competencies_json', ja: 'コンピテンシー', en: 'Competencies', group: 'skills', default: LEADERS },
  { key: 'evaluation_history_json', ja: '評価', en: 'Evaluations', group: 'growth', default: SUPERVISORS },
  { key: 'one_on_ones_json', ja: '1on1 の記録', en: '1-on-1 notes', group: 'growth', default: SUPERVISORS },
  { key: 'development_plan_json', ja: '育成計画', en: 'Development plan', group: 'growth', default: SUPERVISORS },
  { key: 'training_history_json', ja: '研修の記録', en: 'Training history', group: 'growth', default: LEADERS },
  { key: 'survey_responses_json', ja: 'アンケートの回答', en: 'Survey responses', group: 'growth', default: SUPERVISORS },
  { key: 'university', ja: '大学', en: 'University', group: 'school', default: LEADERS },
  { key: 'faculty', ja: '学部', en: 'Faculty', group: 'school', default: LEADERS },
  { key: 'department_name', ja: '学科', en: 'Department (school)', group: 'school', default: LEADERS },
  { key: 'grade_year', ja: '学年', en: 'Year', group: 'school', default: LEADERS },
  { key: 'custom_fields_json', ja: '独自の項目(まとめて)', en: 'Custom fields (all)', group: 'other', default: LEADERS },
]
export const DAILY_REPORTS_DEF: FieldDef = { key: DAILY_REPORTS_FIELD, ja: '日報・週報', en: 'Daily / weekly reports', group: 'other', default: [] }

export const FIELD_GROUPS: { key: FieldDef['group']; ja: string; en: string }[] = [
  { key: 'basic', ja: '基本', en: 'Basics' },
  { key: 'career', ja: 'キャリア', en: 'Career' },
  { key: 'skills', ja: 'スキル', en: 'Skills' },
  { key: 'growth', ja: '育成・評価', en: 'Growth & evaluation' },
  { key: 'school', ja: '学校', en: 'School' },
  { key: 'other', ja: '独自の項目・日報', en: 'Custom fields & reports' },
]

export type FieldAudienceSetting = Record<string, FieldAudience[]>

export function isNarrowOnly(key: string): boolean {
  return NARROW_ONLY_FIELDS.includes(key)
}

/** その項目で選べる相手 */
export function allowedAudiences(key: string): FieldAudience[] {
  return isNarrowOnly(key) ? FIELD_AUDIENCES.filter((a) => !NARROW_ONLY_FORBIDDEN.includes(a)) : [...FIELD_AUDIENCES]
}

function isFieldKey(key: string): boolean {
  if (MEMBER_FIELDS.some((f) => f.key === key) || key === DAILY_REPORTS_FIELD) return true
  const custom = key.startsWith(CUSTOM_FIELD_PREFIX) ? key.slice(CUSTOM_FIELD_PREFIX.length) : ''
  return custom.length > 0 && custom.length <= 100
}

/** 保存された設定を読む(使えない値は入れない = 今までどおりの範囲。GAS の memberColumnRulesFromValue_ と同じ) */
export function parseFieldAudiences(raw: string | undefined | null): FieldAudienceSetting {
  let parsed: unknown
  try { parsed = raw ? JSON.parse(raw) : null } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: FieldAudienceSetting = {}
  for (const [key, level] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isFieldKey(key)) continue
    const list = typeof level === 'string' ? LEGACY_FIELD_AUDIENCES[level] : level
    if (!Array.isArray(list)) continue
    if (!list.every((a) => (FIELD_AUDIENCES as readonly string[]).includes(String(a)))) continue
    if (isNarrowOnly(key) && list.some((a) => NARROW_ONLY_FORBIDDEN.includes(a))) continue
    out[key] = FIELD_AUDIENCES.filter((a) => list.includes(a))
  }
  return out
}

/** 保存する値(空の設定は '' = 設定を消す)。相手は決まった順にそろえる */
export function serializeFieldAudiences(setting: FieldAudienceSetting): string {
  const keys = Object.keys(setting).filter(isFieldKey).sort()
  if (!keys.length) return ''
  const out: Record<string, FieldAudience[]> = {}
  for (const k of keys) out[k] = FIELD_AUDIENCES.filter((a) => setting[k].includes(a) && allowedAudiences(k).includes(a))
  return JSON.stringify(out)
}

/** その項目の今の範囲(設定が無ければ既定)。独自の項目のキーは、設定が無ければ「独自の項目(まとめて)」の範囲 */
export function audiencesOf(key: string, setting: FieldAudienceSetting): FieldAudience[] {
  if (setting[key]) return setting[key]
  if (key.startsWith(CUSTOM_FIELD_PREFIX)) return audiencesOf('custom_fields_json', setting)
  if (key === DAILY_REPORTS_FIELD) return DAILY_REPORTS_DEF.default
  return MEMBER_FIELDS.find((f) => f.key === key)?.default ?? []
}

export function sameAudiences(a: FieldAudience[], b: FieldAudience[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

// ---- 関係(誰がその人の上長・部署長・メンター・プロジェクトの責任者か) --------------------------

function pathParts(path: string): string[] {
  return path.split('>').map((s) => s.trim()).filter(Boolean)
}

function isUnder(parts: string[], head: string[]): boolean {
  return parts.length >= head.length && head.every((p, i) => parts[i] === p)
}

export interface AudienceContext {
  members: Pick<Member, 'id' | 'role' | 'reportsToId' | 'mentorId' | 'departmentPaths'>[]
  projects: Pick<Project, 'id' | 'ownerId' | 'memberIds' | 'parentId'>[]
  departmentTree: DepartmentTreeNode[]
  isAdminRole: (role: string) => boolean
  isTopRole: (role: string) => boolean
}

/** 見る人(viewerId)が、その人(ownerId)の項目を見られるか(GAS の fieldAudienceAllows_ と同じ) */
export function audienceAllows(audiences: FieldAudience[], viewerId: string, ownerId: string, ctx: AudienceContext): boolean {
  if (viewerId === ownerId) return true
  if (!audiences.length) return false
  const viewer = ctx.members.find((m) => m.id === viewerId)
  if (!viewer) return false
  if (ctx.isTopRole(viewer.role)) return true
  if (audiences.includes('all')) return true
  if (audiences.includes('leaders') && ctx.isAdminRole(viewer.role)) return true
  const owner = ctx.members.find((m) => m.id === ownerId)
  if (!owner) return false
  if (audiences.includes('boss')) {
    let cur = owner.reportsToId ?? null
    for (let hop = 0; cur && hop < 20; hop++) {
      if (cur === viewerId) return true
      cur = ctx.members.find((m) => m.id === cur)?.reportsToId ?? null
    }
  }
  if (audiences.includes('mentor') && owner.mentorId === viewerId) return true
  if (audiences.includes('deptHead')) {
    const heads = ctx.departmentTree.filter((n) => (n.headIds ?? []).includes(viewerId)).map((n) => pathParts(n.path))
    if (heads.some((h) => h.length && (owner.departmentPaths ?? []).some((p) => isUnder(pathParts(p), h)))) return true
  }
  if (audiences.includes('projectOwner')) {
    const owned = ctx.projects.filter((p) => p.ownerId === viewerId).map((p) => p.id)
    const seen = new Set<string>()
    const stack = [...owned]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const p = ctx.projects.find((x) => x.id === id)
      if (p?.memberIds?.includes(ownerId)) return true
      ctx.projects.filter((x) => x.parentId === id).forEach((c) => stack.push(c.id))
    }
  }
  return false
}

/** 範囲の短い説明(「本人だけ」「上長・部署長」など。代表は本人だけ以外いつも見られる) */
export function describeAudiences(audiences: FieldAudience[], locale: 'ja' | 'en' = 'ja'): string {
  if (!audiences.length) return locale === 'en' ? 'Only the person' : '本人だけ'
  if (audiences.includes('all')) return AUDIENCE_LABELS.all[locale]
  return audiences.map((a) => AUDIENCE_LABELS[a][locale]).join(locale === 'en' ? ', ' : '・')
}
