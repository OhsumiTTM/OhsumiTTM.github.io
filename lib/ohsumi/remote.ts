// Wires the app to the real "database": Google Sheets tabs (Members /
// Projects / Tasks / Settings) read and written through a Google Apps
// Script Web App. Reads go through the authenticated getInitialData action,
// which returns only what the signed-in member may see (see gas/Code.gs's
// READ_POLICY). See gas/README.md for the sheet schema and deployment steps.
// All of this is optional — when NEXT_PUBLIC_GAS_URL isn't set (e.g. local
// dev), the app falls back to the local seed data exactly as before.
import type {
  AdminSection,
  CareerHistoryEntry,
  Competency,
  Department,
  DepartmentTreeNode,
  DevelopmentPlanEntry,
  Difficulty,
  EvaluationRecord,
  Member,
  OneOnOneRecord,
  LearningContent,
  LearningCourse,
  ParsedTask,
  Priority,
  Project,
  ProjectTemplateTask,
  ProgressEntry,
  Qualification,
  QuizDefinition,
  RadarAxis,
  RecurringTaskRule,
  Role,
  SkillLevel,
  SkillLevelThresholds,
  SkillLevelValue,
  Task,
  TaskComment,
  TaskDeliverable,
  TaskForm,
  TaskHistoryEntry,
  TaskImportance,
  TaskRetrospective,
  TaskSchedule,
  TaskSetTemplate,
  TaskStatus,
  TrainingProgram,
  TrainingRecord,
  TransferRecord,
  NotifyFrequency,
  NotifyKind,
  PermissionOverride,
  SkillPoints,
  SurveyQuestion,
} from './types'
import { STATUS_LABEL, isAdminRole } from './types'
import { getGasAuthToken, refreshGasAuthToken } from './google-sheet-sync'
import { applyRenewedSession, clearSession, getSessionToken, type StoredSession } from './session'

// セッションが無効になった(期限切れ・全端末でログアウトなど)ときに window に送るイベント。
// store.tsx がログイン画面に戻す
export const SESSION_ENDED_EVENT = 'ohsumi:session-ended'

// NEXT_PUBLIC_ vars are inlined at build time by Next.js. They must be
// referenced by their literal full name (not a dynamic key) to be inlined.
const GAS_URL = process.env.NEXT_PUBLIC_GAS_URL

export const isRemoteConfigured = !!GAS_URL

// image uploads go to a Drive folder that GAS manages itself (created by
// setupOhsumi() and kept in a script property), so they only need GAS.
export const isDriveConfigured = isRemoteConfigured
// Settings are part of getInitialData, so they're synced whenever GAS is
export const isSettingsConfigured = isRemoteConfigured

// ---- GAS read response → header-keyed records ---------------------------

export interface SheetTable {
  headers: string[]
  rows: string[][]
}

// Same shape (and whitespace trimming) the old published-CSV reader produced,
// so the row mappers below are unchanged
export function tableToRecords(table: SheetTable | undefined): Record<string, string>[] {
  if (!table || !table.headers) return []
  const headers = table.headers.map((h) => String(h).trim())
  return (table.rows ?? []).map((r) => {
    const rec: Record<string, string> = {}
    headers.forEach((h, i) => {
      rec[h] = String(r[i] ?? '').trim()
    })
    return rec
  })
}

function splitTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---- domain mapping -----------------------------------------------------
// Sheet columns follow the alpha design doc's Members/Projects/Tasks
// schema. A handful of extra columns beyond the doc (department, category,
// skills, difficulty, priority, completed_date, last_activity,
// progress_note, original_input_id) carry the richer fields this UI grew
// during the mock phase — see gas/README.md for the full column list.

export const AVATAR_PALETTE = ['#6366f1', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6', '#e11d48', '#0891b2']

export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

export function initialsForName(name: string): string {
  const cleaned = name.replace(/^（例）/, '').trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

// Admins can define custom permission levels above the fixed 一般 baseline
// (see store.tsx's roleLevels), so any non-blank sheet value is trusted
// as-is — only a blank cell falls back to the baseline.
function roleFromSheet(role: string): Role {
  return role && role.trim() ? role.trim() : '一般'
}

function mapMemberRow(r: Record<string, string>, projectsById: Map<string, Project>): Member {
  const projectIds = splitTags(r.project_ids)
  const will = splitTags(r.will_tags)
  const judgment = splitTags(r.judgment_tags)
  const role = roleFromSheet(r.role)
  const affiliation =
    projectIds.length > 0
      ? projectIds.map((pid) => projectsById.get(pid)?.name ?? pid).join(' / ')
      : isAdminRole(role)
        ? '運営'
        : ''
  return {
    id: r.id,
    name: r.name,
    affiliation,
    role,
    avatarColor: r.avatar_color || colorForId(r.id),
    initials: r.avatar_initials || initialsForName(r.name),
    avatarUrl: r.avatar_url || undefined,
    projectIds: projectIds.length > 0 ? projectIds : undefined,
    // Fact (past-performance) matching is explicitly out of scope for the
    // alpha (cold start, no history yet) — always empty.
    facts: [],
    will,
    judgment,
    // Talent matching (design doc §7) scores on will+judgment tags; skills
    // is derived from the same two so the existing matching UI keeps working.
    skills: [...will, ...judgment],
    // email はここでは読まない — Membersシートから分離し、非公開の
    // MemberEmailsシートへ移した(resolveLogin/getMyEmails/updateEmail経由で
    // のみ扱う。getInitialData もemail列は返さない)
    notify: /^(true|1|yes)$/i.test((r.notify_new_task || '').trim()),
    notifySettings: parseJsonObject<Partial<Record<NotifyKind, NotifyFrequency>>>(r.notify_settings),
    displayName: r.display_name || undefined,
    unavailableDates: splitTags(r.unavailable_dates),
    reportsToId: r.reports_to_id || undefined,
    mentorId: r.mentor_id || undefined,
    joinedAt: r.joined_at || undefined,
    // ---- タレントマネジメント (人材DB／スキル管理／人材検索／育成・キャリア) ----
    // 経験年数はjoinedAtからの自動計算に統一したためここでは読み込まない
    // (utils.tsのcomputeYearsOfExperienceを参照)
    hasManagementExperience: /^(true|1|yes)$/i.test((r.has_management_experience || '').trim()),
    desiredAreas: splitTags(r.desired_areas),
    desiredSkills: splitTags(r.desired_skills), // DEV-002
    careerHistory: parseJsonArray<CareerHistoryEntry>(r.career_history_json),
    qualifications: parseJsonArray<Qualification>(r.qualifications_json),
    evaluationHistory: parseJsonArray<EvaluationRecord>(r.evaluation_history_json),
    transferHistory: parseJsonArray<TransferRecord>(r.transfer_history_json),
    skillLevels: parseJsonArray<SkillLevel>(r.skill_levels_json),
    competencies: parseJsonArray<Competency>(r.competencies_json),
    careerAspiration: r.career_aspiration || undefined,
    desiredFutureRole: r.desired_future_role || undefined,
    careerPlan: r.career_plan || undefined,
    trainingHistory: parseJsonArray<TrainingRecord>(r.training_history_json),
    developmentPlan: parseJsonArray<DevelopmentPlanEntry>(r.development_plan_json),
    oneOnOnes: parseJsonArray<OneOnOneRecord>(r.one_on_ones_json),
    // ---- 組織階層・権限・スキルポイント ----------------------------------------
    departmentPaths: splitTags(r.department_path),
    permissionOverrides: parseJsonArray<PermissionOverride>(r.permission_overrides_json),
    skillPoints: parseJsonObject<SkillPoints>(r.skill_points_json),
    inactive: r.inactive === 'TRUE' ? true : undefined,
    absentDates: splitTags(r.absent_dates),
    availableHours: parseJsonObject<{ start: string; end: string }>(r.available_hours_json),
    lastLogin: r.last_login || undefined,
    timezone: r.timezone || undefined,
    locale: r.locale || undefined,
    university: r.university || undefined,
    faculty: r.faculty || undefined,
    departmentName: r.department_name || undefined,
    gradeYear: r.grade_year || undefined,
    customFields: parseJsonObject<Record<string, string>>(r.custom_fields_json),
    surveyResponses:
      parseJsonArray<{ id: string; submittedAt: string; answers: Record<string, number | string> }>(
        r.survey_responses_json,
      ) ?? [],
  }
}

function mapProjectRow(r: Record<string, string>): Project {
  const memberIds = splitTags(r.member_ids)
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    type: r.type || undefined,
    memberIds: memberIds.length > 0 ? memberIds : undefined,
    ownerId: r.owner_id || undefined,
    parentId: r.parent_id || undefined,
    archived: r.archived === 'TRUE',
    goal: r.goal || undefined,
    healthOverride: (r.health_override || undefined) as Project['healthOverride'],
    lastNotifiedHealth: (r.last_notified_health || undefined) as Project['lastNotifiedHealth'],
    startDate: r.start_date || undefined,
    endDate: r.end_date || undefined,
  }
}

const STATUS_FROM_LABEL: Record<string, TaskStatus> = Object.fromEntries(
  (Object.entries(STATUS_LABEL) as [TaskStatus, string][]).map(([k, v]) => [v, k]),
)

function statusFromSheet(status: string): TaskStatus {
  // any unrecognized value (blank cell, typo) falls back to 進行中
  return STATUS_FROM_LABEL[status] ?? 'progress'
}

function mapTaskRow(r: Record<string, string>): Task {
  return {
    id: r.id,
    name: r.title,
    description: r.description ?? '',
    projectId: r.project_id,
    department: (r.department || '未分類') as Department,
    assigneeIds: splitTags(r.assignee_id),
    assignType: r.assign_type || 'open_bid',
    openBidApplicantIds: splitTags(r.open_bid_applicant_ids), // TSK-027
    startDate: r.start_date || null,
    deadline: r.due_date || null,
    dueTime: r.due_time || null,
    category: r.category || '',
    skills: splitTags(r.skills),
    difficulty: (r.difficulty || '新人歓迎') as Difficulty,
    priority: (r.priority || '中') as Priority,
    status: statusFromSheet(r.status),
    completedDate: r.completed_date || null,
    lastActivity: r.last_activity || r.created_at || undefined,
    originalInputId: r.original_input_id || undefined,
    createdById: r.creator_id || undefined,
    createdAt: r.created_at || undefined,
    progress: r.progress_note || undefined,
    progressPercent: r.progress_percent !== '' && r.progress_percent != null ? Number(r.progress_percent) : undefined,
    progressHistory: parseJsonArray<ProgressEntry>(r.progress_history_json) ?? [],
    pendingApproval: r.approval_status === '承認待ち',
    dependsOnIds: splitTags(r.depends_on_ids),
    visibility: r.visibility === '幹部' ? '幹部' : 'all',
    reviewerId: r.reviewer_id || undefined,
    reviewerIds: r.reviewer_ids ? splitTags(r.reviewer_ids) : (r.reviewer_id ? [r.reviewer_id] : undefined),
    blocker: r.blocker_note ? { note: r.blocker_note, since: r.blocker_since || '' } : undefined,
    holdReason: r.hold_reason_note ? { note: r.hold_reason_note, since: r.hold_reason_since || '' } : undefined,
    deliverables: parseJsonArray<TaskDeliverable>(r.deliverables_json),
    history: parseJsonArray<TaskHistoryEntry>(r.history_json),
    comments: parseJsonArray<TaskComment>(r.comments_json),
    estimatedHours: r.estimated_hours ? Number(r.estimated_hours) : undefined,
    actualHours: r.actual_hours ? Number(r.actual_hours) : undefined,
    retrospective: parseJsonObject<TaskRetrospective>(r.retrospective_json),
    importance: (r.importance || undefined) as Task['importance'],
    schedule: parseJsonObject<TaskSchedule>(r.schedule_json),
    form: parseJsonObject<TaskForm>(r.form_json),
    awardedPoints: parseJsonObject<SkillPoints>(r.awarded_points_json),
    requiredApprovals: r.required_approvals
      ? r.required_approvals === 'all' ? 'all' : Number(r.required_approvals)
      : undefined,
    reviewApprovals: parseJsonArray<{ memberId: string; at: string }>(r.review_approvals_json),
    requiredSkillLevels: parseJsonObject<Partial<Record<string, SkillLevelValue>>>(r.required_skill_levels_json),
    relatedReviewTaskId: r.related_review_task_id || undefined,
  }
}

// Parses an optional JSON-array cell (deliverables_json/history_json) —
// missing/malformed content just comes back empty rather than throwing.
function parseJsonArray<T>(raw: string | undefined): T[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : undefined
  } catch {
    return undefined
  }
}

// Same as parseJsonArray but for a single JSON object cell (retrospective_json)
function parseJsonObject<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : undefined
  } catch {
    return undefined
  }
}

export interface RemoteData {
  members: Member[]
  projects: Project[]
  tasks: Task[]
}

export function mapRemoteData(
  memberRows: Record<string, string>[],
  projectRows: Record<string, string>[],
  taskRows: Record<string, string>[],
): RemoteData {
  const projects = projectRows.map(mapProjectRow)
  const projectsById = new Map(projects.map((p) => [p.id, p]))
  const members = memberRows.map((r) => mapMemberRow(r, projectsById))
  const tasks = taskRows.map(mapTaskRow)
  return { members, projects, tasks }
}

export interface RemoteSettings {
  skillOptions: string[]
  categoryOptions: string[]
  roleLevels: string[]
  projectTemplates: Record<string, ProjectTemplateTask[]>
  rolePermissions: Record<string, AdminSection[]>
  taskSetTemplates: TaskSetTemplate[]
  recurringRules: RecurringTaskRule[]
  // item 17: ポジション要件 — jobType (role level string) -> required skills
  jobRequirements: Record<string, string[]>
  // 要求分野: field name pool + field -> constituent skills + acquisition threshold
  skillFieldOptions: string[]
  skillFieldSkills: Record<string, string[]>
  skillFieldThreshold: number | null
  // 団体メール — 個々のメンバーの通知設定に関わらず常に通知先へ含める
  // 共有配信先アドレス（幹部/事業責任者=full adminがAdmin > Tagsで追加）
  orgNotificationEmails: string[]
  // アンケート回答対象者の限定（メンバーID配列）— 空なら全員回答可
  surveyInvitedIds: string[]
  // プロジェクトの表示順（プロジェクトIDの配列）— Admin > Projectsのドラッグ
  // 並び替えで設定。載っていないIDは末尾に元の順序のまま追加される
  projectOrder: string[]
  // 制限付きロール — Tags画面で「制限あり」に設定されたロール名のリスト。
  // リストにないロールは全管理者権限を持つ
  restrictedRoles: string[]
  // スキルポイントのレベルアップ閾値 — { "デフォルト": 100, "デザイン": 150 }
  skillLevelThresholds: SkillLevelThresholds
  // 検定定義リスト — Settings キー "quiz_definitions"
  quizDefinitions: QuizDefinition[]
  // レーダーチャート軸定義 — Settings キー "radar_axes"
  radarAxes: RadarAxis[]
  // 人材DBのカスタム列定義 — Settings キー "custom_member_columns_json"
  customMemberColumns: import('./types').CustomMemberColumn[]
  // 経費カテゴリ — Settings キー "expense_categories"
  expenseCategories: import('./types').ExpenseCategory[]
  // カスタムフォーム定義 — Settings キー "custom_form_defs"
  customFormDefs: import('./types').CustomFormDef[]
  // 団体名・ロゴ — Settings キー "org_name" / "org_logo_url"
  orgName: string
  orgLogoUrl: string
  // プライマリカラー（16進カラーコード）— Settings キー "theme_color"
  themeColor: string
  // 1on1ワークシート質問項目 — Settings キー "one_on_one_questions"
  oneOnOneQuestions: string[]
  // 初ログイン時付与タスク — Settings キー "initial_tasks_json"
  initialTasks: { name: string; description: string }[]
  // ORG-002: 部署ツリー構成 — Settings キー "department_tree_config"。
  // 省略時はMembers.departmentPathsの実データから動的導出される
  departmentTreeConfig: DepartmentTreeNode[]
  // LRN-001: 学習コンテンツ一覧 — Settings キー "learning_contents"
  learningContents: LearningContent[]
  // LRN-002: 学習コース一覧 — Settings キー "learning_courses"
  learningCourses: LearningCourse[]
  // LRN-006: 研修プログラム一覧 — Settings キー "training_programs"
  trainingPrograms: TrainingProgram[]
  // FRM-006: アンケート設問リスト — Settings キー "survey_questions"。
  // 空配列なら survey-screen.tsx はこれまで通りの固定6問にフォールバックする
  surveyQuestions: SurveyQuestion[]
}

// Parses the "Settings" sheet (key,value rows) — see gas/README.md. Any
// missing/unparseable key just comes back empty, so callers merge with
// their own defaults.
export function parseSettings(rows: Record<string, string>[]): RemoteSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value ?? '']))
  let projectTemplates: Record<string, ProjectTemplateTask[]> = {}
  try {
    const raw = byKey.get('project_templates')
    if (raw) projectTemplates = JSON.parse(raw)
  } catch {
    // malformed JSON in the sheet — fall back to empty rather than throwing
  }
  let rolePermissions: Record<string, AdminSection[]> = {}
  try {
    const raw = byKey.get('role_permissions')
    if (raw) rolePermissions = JSON.parse(raw)
  } catch {
    // malformed JSON in the sheet — fall back to empty rather than throwing
  }
  let taskSetTemplates: TaskSetTemplate[] = []
  try {
    const raw = byKey.get('task_set_templates')
    if (raw) taskSetTemplates = JSON.parse(raw)
  } catch {
    // malformed JSON in the sheet — fall back to empty rather than throwing
  }
  let recurringRules: RecurringTaskRule[] = []
  try {
    const raw = byKey.get('recurring_rules')
    if (raw) recurringRules = JSON.parse(raw)
  } catch {
    // malformed JSON in the sheet — fall back to empty rather than throwing
  }
  let jobRequirements: Record<string, string[]> = {}
  try {
    const raw = byKey.get('job_requirements')
    if (raw) jobRequirements = JSON.parse(raw)
  } catch {
    // malformed JSON in the sheet — fall back to empty rather than throwing
  }
  let skillFieldSkills: Record<string, string[]> = {}
  try {
    const raw = byKey.get('skill_field_skills')
    if (raw) skillFieldSkills = JSON.parse(raw)
  } catch {
    // malformed JSON in the sheet — fall back to empty rather than throwing
  }
  const thresholdRaw = byKey.get('skill_field_threshold')
  const skillFieldThreshold = thresholdRaw ? Number(thresholdRaw) : null
  return {
    skillOptions: splitTags(byKey.get('skill_options')),
    categoryOptions: splitTags(byKey.get('category_options')),
    roleLevels: splitTags(byKey.get('role_levels')),
    projectTemplates,
    rolePermissions,
    taskSetTemplates,
    recurringRules,
    jobRequirements,
    skillFieldOptions: splitTags(byKey.get('skill_field_options')),
    skillFieldSkills,
    skillFieldThreshold: Number.isFinite(skillFieldThreshold) ? skillFieldThreshold : null,
    orgNotificationEmails: splitTags(byKey.get('org_notification_emails')),
    surveyInvitedIds: splitTags(byKey.get('survey_invited_ids')),
    orgName: byKey.get('org_name') ?? '',
    orgLogoUrl: byKey.get('org_logo_url') ?? '',
    themeColor: byKey.get('theme_color') ?? '',
    projectOrder: splitTags(byKey.get('project_order')),
    restrictedRoles: splitTags(byKey.get('restricted_roles')),
    skillLevelThresholds: (() => {
      try { const r = byKey.get('skill_level_thresholds'); return r ? JSON.parse(r) : {} } catch { return {} }
    })(),
    quizDefinitions: (() => {
      try { const r = byKey.get('quiz_definitions'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    radarAxes: (() => {
      try { const r = byKey.get('radar_axes'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    customMemberColumns: (() => {
      try { const r = byKey.get('custom_member_columns_json'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    expenseCategories: (() => {
      try { const r = byKey.get('expense_categories'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    customFormDefs: (() => {
      try { const r = byKey.get('custom_form_defs'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    oneOnOneQuestions: (() => {
      try { const r = byKey.get('one_on_one_questions'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    initialTasks: (() => {
      try { const r = byKey.get('initial_tasks_json'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    departmentTreeConfig: (() => {
      try { const r = byKey.get('department_tree_config'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    learningContents: (() => {
      try { const r = byKey.get('learning_contents'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    learningCourses: (() => {
      try { const r = byKey.get('learning_courses'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    trainingPrograms: (() => {
      try { const r = byKey.get('training_programs'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
    surveyQuestions: (() => {
      try { const r = byKey.get('survey_questions'); return r ? JSON.parse(r) : [] } catch { return [] }
    })(),
  }
}

// ---- initial read (Google Apps Script Web App) ---------------------------

export interface InitialData {
  // null = the signed-in Google account isn't registered as a member
  memberId: string | null
  version?: string
  // true = nothing changed since knownVersion (data/settings are omitted)
  unchanged?: boolean
  data?: RemoteData
  settings?: RemoteSettings
}

interface InitialDataResponse {
  memberId: string | null
  version?: string
  unchanged?: boolean
  sheets?: Record<'Members' | 'Projects' | 'Tasks' | 'Settings', SheetTable>
}

// Signs in (resolves the member) and loads Members/Projects/Tasks/Settings
// in one GAS call. Pass the version from the previous load to skip the
// payload when nothing changed.
export async function fetchInitialData(knownVersion?: string): Promise<InitialData> {
  const started = typeof performance !== 'undefined' ? performance.now() : 0
  const res = await postToGas<InitialDataResponse>('getInitialData', knownVersion ? { knownVersion } : {})
  if (started) {
    // eslint-disable-next-line no-console
    console.info(`[ohsumi] getInitialData ${Math.round(performance.now() - started)}ms${res.unchanged ? ' (unchanged)' : ''}`)
  }
  return toInitialData(res)
}

function toInitialData(res: InitialDataResponse): InitialData {
  if (!res.memberId || res.unchanged || !res.sheets) {
    return { memberId: res.memberId, version: res.version, unchanged: res.unchanged }
  }
  const { Members, Projects, Tasks, Settings } = res.sheets
  return {
    memberId: res.memberId,
    version: res.version,
    data: mapRemoteData(tableToRecords(Members), tableToRecords(Projects), tableToRecords(Tasks)),
    settings: parseSettings(tableToRecords(Settings)),
  }
}

export interface FetchedFile {
  id: string
  ok: boolean
  mimeType?: string
  data?: string // base64
  error?: string
}

// ---- writes (Google Apps Script Web App) ---------------------------------

export interface CreateTaskPayload {
  tempId: string
  title: string
  description?: string
  projectId: string
  department: string
  category: string
  skills: string[]
  difficulty: Difficulty
  priority: Priority
  startDate?: string | null
  deadline: string | null
  dueTime?: string | null
  assigneeIds?: string[]
  creatorId?: string
  originalInputId?: string
  pendingApproval?: boolean
  visibility?: 'all' | '幹部'
  estimatedHours?: number
  importance?: string
  relatedReviewTaskId?: string
}

type GasResponse<T> = {
  ok: boolean
  result?: T
  error?: string
  authError?: boolean
  // 残りが半分を切ったセッションは、GAS が新しいトークンを返す(差し替える)
  session?: { token: string; exp: number }
}

// 認証なしで GAS を呼ぶ(getLoginConfig・exchangeIdToken)
async function callGas<T>(body: Record<string, unknown>): Promise<GasResponse<T>> {
  if (!GAS_URL) throw new Error('GAS Web App URL is not configured')
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as GasResponse<T>
  } catch {
    throw new Error('GASスクリプトからJSONが返りませんでした。GASのデプロイ設定を確認してください。')
  }
}

/** ログイン前に団体ID(IDトークンの nonce に含める)を取得する。GAS が古い場合などは null */
export async function fetchLoginConfig(): Promise<{ orgId: string } | null> {
  try {
    const json = await callGas<{ orgId: string }>({ action: 'getLoginConfig' })
    return json.ok && json.result?.orgId ? { orgId: json.result.orgId } : null
  } catch {
    return null
  }
}

export interface ExchangeResult extends InitialData {
  // 登録されていないアカウントの場合、本人のメールアドレス(ログイン画面の表示用)
  email?: string
  session?: StoredSession
}

/** Google の IDトークンをセッショントークンに交換し、初期データもまとめて受け取る */
export async function exchangeIdToken(idToken: string, nonceSecret: string, remember: boolean): Promise<ExchangeResult> {
  const json = await callGas<InitialDataResponse & { email?: string; session?: StoredSession }>({
    action: 'exchangeIdToken',
    idToken,
    nonceSecret,
    remember,
  })
  if (!json.ok || !json.result) throw new Error(json.error || 'ログインに失敗しました')
  const res = json.result
  if (!res.memberId) return { memberId: null, email: res.email }
  return { ...toInitialData(res), session: res.session }
}

async function postToGas<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
  if (!GAS_URL) throw new Error('GAS Web App URL is not configured')

  // 新しい方式(セッショントークン)があればそれを使い、無ければ移行期間中の
  // 以前の方式(Google のアクセストークン)を使う
  const sessionToken = getSessionToken()

  const doFetch = async (authToken: string | null) => {
    const auth = sessionToken ? { sessionToken } : { authToken }
    const res = await fetch(GAS_URL!, {
      method: 'POST',
      // text/plain avoids a CORS preflight (Apps Script doesn't handle
      // OPTIONS); the body is still JSON, parsed server-side with JSON.parse.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...auth, ...payload }),
    })
    // GAS always returns JSON from doPost. A non-JSON response (HTML) means
    // the request was redirected to a login page (auth config issue) or the
    // script itself failed to load (syntax error, undeployed version, etc.).
    const text = await res.text()
    try {
      return JSON.parse(text) as GasResponse<T>
    } catch {
      throw new Error(
        'GASスクリプトからJSONが返りませんでした。' +
        'GASのデプロイ設定（「全員」アクセス）またはスクリプトのコピーを確認してください。',
      )
    }
  }

  const legacyToken = sessionToken ? null : getGasAuthToken()
  let json = await doFetch(legacyToken)

  if (json.session) applyRenewedSession(json.session)

  // セッションが無効(期限切れ・全端末でログアウト・鍵の変更など): 保存したトークンを消し、
  // ログイン画面に戻す
  // (セッションの期限がこの端末で切れている場合も、トークンを送らずに同じ扱いにする)
  if (!legacyToken && !json.ok && json.authError) {
    clearSession()
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: json.error }))
    throw new Error(json.error || 'ログインの有効期限が切れました。再ログインしてください。')
  }

  // 以前の方式: Auth error (expired token): silently refresh and retry once.
  // GIS prompt:'' avoids showing a popup if the user's Google session is active.
  if (!json.ok && json.authError) {
    try {
      const newToken = await refreshGasAuthToken()
      json = await doFetch(newToken)
    } catch {
      // Silent refresh failed (Google session also expired) — surface original error
      throw new Error(json.error || `GAS action "${action}" failed`)
    }
  }

  if (!json.ok) throw new Error(json.error || `GAS action "${action}" failed`)
  return json.result as T
}

export interface WebhookTestResult {
  ok: boolean
  at: string // ISO datetime
  error: string
}

export interface WebhookConnectionStatus {
  configured: boolean
  lastTest: WebhookTestResult | null
}

export interface WebhookStatus {
  discord: WebhookConnectionStatus
  slack: WebhookConnectionStatus
}

export const remoteApi = {
  createTasks: (tasks: CreateTaskPayload[]) =>
    postToGas<{ tempId: string; id: string }[]>('createTasks', { tasks }),
  updateTaskStatus: (taskId: string, status: TaskStatus) =>
    postToGas('updateTaskStatus', { taskId, status: STATUS_LABEL[status] }),
  assignTask: (taskId: string, assigneeIds: string[]) =>
    postToGas('assignTask', { taskId, assigneeIds }),
  // TSK-027: 公募タスクへの応募(承認制)。applicantIdsは常に更新後の全体を
  // 送る(updateProjectMembers等と同じ「全体を送る」方式)
  applyToOpenBid: (taskId: string, applicantIds: string[]) =>
    postToGas('applyToOpenBid', { taskId, applicantIds }),
  updatePriority: (taskId: string, priority: Priority) =>
    postToGas('updatePriority', { taskId, priority }),
  updateDifficulty: (taskId: string, difficulty: Difficulty) =>
    postToGas('updateDifficulty', { taskId, difficulty }),
  updateTaskDetails: (
    taskId: string,
    details: {
      name: string
      description: string
      projectId: string
      department: Department
      category: string
      skills: string[]
      difficulty: Difficulty
      priority: Priority
      visibility: 'all' | '幹部'
      importance: TaskImportance
      requiredSkillLevels?: Partial<Record<string, SkillLevelValue>>
    },
  ) =>
    postToGas('updateTaskDetails', {
      taskId,
      name: details.name,
      description: details.description,
      projectId: details.projectId,
      department: details.department,
      category: details.category,
      skills: details.skills,
      difficulty: details.difficulty,
      priority: details.priority,
      visibility: details.visibility,
      importance: details.importance,
      requiredSkillLevels: details.requiredSkillLevels,
    }),
  updateProgress: (taskId: string, text: string, progressHistory: ProgressEntry[]) =>
    postToGas('updateProgress', { taskId, text, progressHistory }),
  // TSK-010: 既存のupdateProgressアクションに相乗りし、progressPercentのみを
  // 送る(text/progressHistoryは省略— GAS側は渡された列だけを部分更新する)
  updateProgressPercent: (taskId: string, percent: number) =>
    postToGas('updateProgress', { taskId, progressPercent: percent }),
  updateWill: (memberId: string, will: string[]) => postToGas('updateWill', { memberId, will }),
  updateJudgment: (memberId: string, judgment: string[]) =>
    postToGas('updateJudgment', { memberId, judgment }),
  approveTask: (taskId: string) => postToGas('approveTask', { taskId }),
  removeTask: (taskId: string) => postToGas('removeTask', { taskId }),
  notifyTaskRejected: (taskId: string, creatorId: string | undefined, taskName: string, reason: string | undefined) =>
    postToGas('notifyTaskRejected', { taskId, creatorId, taskName, reason }),
  createProject: (name: string, description: string, type?: string, parentId?: string) =>
    postToGas<{ id: string }>('createProject', { name, description, type, parentId }),
  removeProject: (projectId: string) => postToGas('removeProject', { projectId }),
  removeMember: (memberId: string) => postToGas('removeMember', { memberId }),
  updateNotify: (memberId: string, notify: boolean) =>
    postToGas('updateNotify', { memberId, notify }),
  updateNotifySettings: (memberId: string, settings: Partial<Record<NotifyKind, NotifyFrequency>>) =>
    postToGas('updateNotifySettings', { memberId, settings }),
  updateRole: (memberId: string, role: Role) => postToGas('updateRole', { memberId, role }),
  updateReportsTo: (memberId: string, reportsToId: string | null) =>
    postToGas('updateReportsTo', { memberId, reportsToId }),
  updateMentor: (memberId: string, mentorId: string | null) =>
    postToGas('updateMentor', { memberId, mentorId }),
  updateDisplayName: (memberId: string, displayName: string) =>
    postToGas('updateDisplayName', { memberId, displayName }),
  updateJoinedAt: (memberId: string, joinedAt: string | null) =>
    postToGas('updateJoinedAt', { memberId, joinedAt }),
  updateUnavailableDates: (memberId: string, dates: string[]) =>
    postToGas('updateUnavailableDates', { memberId, dates }),
  updateAvailableHours: (memberId: string, hours: { start: string; end: string } | null) =>
    postToGas('updateAvailableHours', { memberId, hours }),
  updateTimezone: (memberId: string, timezone: string) =>
    postToGas('updateTimezone', { memberId, timezone }),
  updateLocale: (memberId: string, locale: string) =>
    postToGas('updateLocale', { memberId, locale }),
  translateTexts: (texts: string[], targetLang: string) =>
    postToGas<string[]>('translateText', { texts, targetLang }),
  updateSchedule: (taskId: string, startDate: string | null, deadline: string | null) =>
    postToGas('updateSchedule', { taskId, startDate, deadline }),
  updateDependsOn: (taskId: string, dependsOnIds: string[]) =>
    postToGas('updateDependsOn', { taskId, dependsOnIds }),
  updateVisibility: (taskId: string, visibility: 'all' | '幹部') =>
    postToGas('updateVisibility', { taskId, visibility }),
  updateAvatar: (memberId: string, avatarColor: string, initials: string) =>
    postToGas('updateAvatar', { memberId, avatarColor, initials }),
  uploadAvatarImage: (memberId: string, dataUrl: string, filename: string) =>
    postToGas<{ url: string }>('uploadAvatar', {
      memberId,
      dataUrl,
      filename,
    }),
  uploadOrgLogo: (dataUrl: string, filename: string) =>
    postToGas<{ url: string }>('uploadOrgLogo', {
      dataUrl,
      filename,
    }),
  uploadExpenseReceipt: (dataUrl: string, filename: string) =>
    postToGas<{ url: string }>('uploadExpenseReceipt', {
      dataUrl,
      filename,
    }),
  uploadSurveyImage: (dataUrl: string, filename: string) =>
    postToGas<{ url: string }>('uploadSurveyImage', {
      dataUrl,
      filename,
    }),
  addMember: (name: string, email: string, affiliation: string, role: Role) =>
    postToGas<{ id: string }>('addMember', { name, email, affiliation, role }),
  updateEmail: (memberId: string, email: string) => postToGas('updateEmail', { memberId, email }),
  // ログイン時にGoogleでログインしたメールアドレス(送信済みauthToken)から
  // 該当メンバーIdを解決する。メール自体はやり取りせず、サーバー側の
  // 非公開MemberEmailsシートと突き合わせた結果(memberId、無ければnull)のみ返す
  resolveLogin: () => postToGas<{ memberId: string | null }>('resolveLogin', {}),
  // 閲覧できる経費申請だけが返る(gas/Code.gs の canViewExpense)
  getExpenses: () => postToGas<import('./types').ExpenseApplication[]>('getExpenses', {}),
  // アップロードしたファイル(非公開)を権限を確認したうえで取得する
  getFiles: (fileIds: string[]) => postToGas<FetchedFile[]>('getFiles', { fileIds }),
  // 自分自身の登録メール(カンマ区切り)を取得する。actingMember基準で
  // サーバー側が自分の分のみ返すため、他人のメールを取得する手段にはならない
  getMyEmails: () => postToGas<{ email: string }>('getMyEmails', {}),
  // 全端末でログアウト(自分)。発行済みのセッションがすべて無効になる
  revokeMySessions: () => postToGas<{ revoked: boolean }>('revokeMySessions', {}),
  // 全端末でログアウト(代表・全権管理者が他のメンバーに対して)
  revokeMemberSessions: (memberId: string) => postToGas<{ revoked: boolean }>('revokeMemberSessions', { memberId }),
  updateSetting: (key: string, value: string) => postToGas('updateSetting', { key, value }),
  // Discord Webhook 連携 — deliberately NOT part of updateSetting/Settings
  // シート同期: every signed-in member receives the Settings sheet, so a
  // webhook URL (a bearer-token-like secret) would leak to all of them. This writes to Apps Script's private
  // PropertiesService instead (see gas/README.md §4.7), which has no
  // public read path — write-only from the client's perspective.
  updateDiscordWebhookUrl: (url: string) => postToGas('updateDiscordWebhookUrl', { url }),
  updateSlackWebhookUrl: (url: string) => postToGas('updateSlackWebhookUrl', { url }),
  // 連携状態(設定済みかどうかと最後のテスト送信の結果・日時)。URLそのものは返らない
  getWebhookStatus: () => postToGas<WebhookStatus>('getWebhookStatus', {}),
  // 保存済みのWebhook URLへ実際にテストメッセージを送信し、HTTPレスポンス
  // コードで成否を判定する(send*Messageと違いここでは失敗を握りつぶさない —
  // 失敗時はGAS側がエラーを投げ、postToGas経由でここもrejectする)
  testDiscordWebhook: () => postToGas('testDiscordWebhook', {}),
  testSlackWebhook: () => postToGas('testSlackWebhook', {}),
  updateMemberInactive: (memberId: string, inactive: boolean) =>
    postToGas('updateMemberInactive', { memberId, inactive }),
  // GAS側のアクション名・パラメータ名(departmentPath)は単一文字列のままだが、
  // 複数部署をカンマ区切りの1文字列にjoinして渡す(splitTagsで復元される)
  updateMemberDepartmentPaths: (memberId: string, departmentPaths: string[]) =>
    postToGas('updateMemberDepartmentPath', { memberId, departmentPath: departmentPaths.join(', ') }),
  updateMemberProjects: (memberId: string, projectIds: string[]) =>
    postToGas('updateMemberProjects', { memberId, projectIds }),
  updateEducationInfo: (
    memberId: string,
    info: { university?: string; faculty?: string; departmentName?: string; gradeYear?: string },
  ) =>
    postToGas('updateEducationInfo', {
      memberId,
      university: info.university,
      faculty: info.faculty,
      departmentName: info.departmentName,
      gradeYear: info.gradeYear,
    }),
  // 採用支援（Candidates）— Expenses/FormSubmissionsと同じくシート直書きの
  // 書き込み専用API。読み取りは行わずフロント側のローカルstateで管理する。
  addCandidate: (candidate: {
    name: string
    email?: string
    phone?: string
    resumeText?: string
    interviewNotes?: string
    status?: string
  }) => postToGas('addCandidate', { candidate }),
  updateCandidate: (
    candidateId: string,
    fields: {
      name?: string
      email?: string
      phone?: string
      resumeText?: string
      interviewNotes?: string
      status?: string
    },
  ) => postToGas('updateCandidate', { candidateId, fields }),
  removeCandidate: (candidateId: string) => postToGas('removeCandidate', { candidateId }),
  convertCandidateToMember: (candidateId: string, role?: string) =>
    postToGas('convertCandidateToMember', { candidateId, role }),
  updateReviewer: (taskId: string, reviewerId: string | null) =>
    postToGas('updateReviewer', { taskId, reviewerId }),
  updateReviewers: (taskId: string, reviewerIds: string[], requiredApprovals?: number | 'all') =>
    postToGas('updateReviewers', { taskId, reviewerIds, requiredApprovals }),
  approveTaskReview: (taskId: string, comment?: string) => postToGas('approveTaskReview', { taskId, comment }),
  setBlocker: (taskId: string, note: string | null, since: string | null) =>
    postToGas('setBlocker', { taskId, note, since }),
  setHoldReason: (taskId: string, note: string | null, since: string | null) =>
    postToGas('setHoldReason', { taskId, note, since }),
  updateDeliverables: (taskId: string, deliverables: TaskDeliverable[]) =>
    postToGas('updateDeliverables', { taskId, deliverables }),
  updateHistory: (taskId: string, history: TaskHistoryEntry[]) =>
    postToGas('updateHistory', { taskId, history }),
  updateProjectMembers: (projectId: string, memberIds: string[]) =>
    postToGas('updateProjectMembers', { projectId, memberIds }),
  updateProjectOwner: (projectId: string, ownerId: string | null) =>
    postToGas('updateProjectOwner', { projectId, ownerId }),
  updateProjectParent: (projectId: string, parentId: string | null) =>
    postToGas('updateProjectParent', { projectId, parentId }),
  updateProjectDetails: (
    projectId: string,
    fields: { name: string; description: string; type?: string; goal?: string; startDate?: string | null; endDate?: string | null },
  ) => postToGas('updateProjectDetails', { projectId, ...fields }),
  updateProjectArchived: (projectId: string, archived: boolean) =>
    postToGas('updateProjectArchived', { projectId, archived }),
  updateProjectHealth: (projectId: string, healthOverride: import('./types').ProjectHealthLevel | null) =>
    postToGas('updateProjectHealth', { projectId, healthOverride }),
  notifyProjectHealth: (projectId: string, health: import('./types').ProjectHealthLevel) =>
    postToGas('notifyProjectHealth', { projectId, health }),
  // item 26(追補): attentionから回復した際、通知は送らずlast_notified_health
  // 列だけを最新化する（updateProjectHealth=上書き+必ず通知、
  // notifyProjectHealth=自動悪化検知+必ず通知、とは役割が異なる）
  updateProjectHealthRecord: (projectId: string, health: import('./types').ProjectHealthLevel) =>
    postToGas('updateProjectHealthRecord', { projectId, health }),
  // 自動判定の結果を複数プロジェクト分まとめて送る。記録の更新と通知の要否は
  // GAS 側がシート上の記録と比べて決め、通知は1通にまとめて送る
  reportProjectHealth: (items: { projectId: string; health: import('./types').ProjectHealthLevel }[]) =>
    postToGas('reportProjectHealth', { items }),
  updateComments: (taskId: string, comments: TaskComment[]) =>
    postToGas('updateComments', { taskId, comments }),
  notifyMention: (taskId: string, commentText: string, memberIds: string[]) =>
    postToGas('notifyMention', { taskId, commentText, memberIds }),
  updateEstimatedHours: (taskId: string, hours: number | null) =>
    postToGas('updateEstimatedHours', { taskId, hours }),
  updateActualHours: (taskId: string, hours: number | null) =>
    postToGas('updateActualHours', { taskId, hours }),
  updateRetrospective: (taskId: string, retrospective: TaskRetrospective | null) =>
    postToGas('updateRetrospective', { taskId, retrospective }),
  updateTaskSchedule: (taskId: string, schedule: TaskSchedule | null) =>
    postToGas('updateTaskSchedule', { taskId, schedule }),
  notifyScheduleResult: (taskId: string) => postToGas('notifyScheduleResult', { taskId }),
  updateTaskForm: (taskId: string, form: TaskForm | null) =>
    postToGas('updateTaskForm', { taskId, form }),
  notifyFormResult: (taskId: string) => postToGas('notifyFormResult', { taskId }),
  // ---- タレントマネジメント ----
  updateSearchProfile: (
    memberId: string,
    profile: {
      hasManagementExperience: boolean
      desiredAreas: string[]
      desiredSkills: string[]
    },
  ) => postToGas('updateSearchProfile', { memberId, ...profile }),
  updateCareerHistory: (memberId: string, entries: CareerHistoryEntry[]) =>
    postToGas('updateCareerHistory', { memberId, entries }),
  updateQualifications: (memberId: string, entries: Qualification[]) =>
    postToGas('updateQualifications', { memberId, entries }),
  updateEvaluationHistory: (memberId: string, entries: EvaluationRecord[]) =>
    postToGas('updateEvaluationHistory', { memberId, entries }),
  updateTransferHistory: (memberId: string, entries: TransferRecord[]) =>
    postToGas('updateTransferHistory', { memberId, entries }),
  updateSkillLevels: (memberId: string, levels: SkillLevel[]) =>
    postToGas('updateSkillLevels', { memberId, levels }),
  updateCompetencies: (memberId: string, competencies: Competency[]) =>
    postToGas('updateCompetencies', { memberId, competencies }),
  updateCareerGoals: (
    memberId: string,
    goals: { careerAspiration: string; desiredFutureRole: string; careerPlan: string },
  ) => postToGas('updateCareerGoals', { memberId, ...goals }),
  updateTrainingHistory: (memberId: string, entries: TrainingRecord[]) =>
    postToGas('updateTrainingHistory', { memberId, entries }),
  notifyTrainingRequest: (memberId: string, trainingName: string) =>
    postToGas('notifyTrainingRequest', { memberId, trainingName }),
  notifyTrainingDecision: (memberId: string, trainingName: string, approved: boolean) =>
    postToGas('notifyTrainingDecision', { memberId, trainingName, approved }),
  updateDevelopmentPlan: (memberId: string, entries: DevelopmentPlanEntry[]) =>
    postToGas('updateDevelopmentPlan', { memberId, entries }),
  updateOneOnOnes: (memberId: string, entries: OneOnOneRecord[]) =>
    postToGas('updateOneOnOnes', { memberId, entries }),
  updatePermissionOverrides: (memberId: string, overrides: PermissionOverride[]) =>
    postToGas('updatePermissionOverrides', { memberId, overrides }),
  // ---- スキルポイント付与 ----
  awardSkillPoints: (taskId: string, memberId: string, points: SkillPoints) =>
    postToGas<{ newLevels: SkillLevel[]; newPoints: SkillPoints }>('awardSkillPoints', { taskId, memberId, points }),
  // ---- 他団体からの実績持ち込み (lib/ohsumi/portable-record.ts) ----
  importPortableRecord: (memberId: string, skillPoints: SkillPoints, qualifications: Qualification[]) =>
    postToGas<{ newLevels: SkillLevel[]; newPoints: SkillPoints; qualifications: Qualification[] }>(
      'importPortableRecord',
      { memberId, skillPoints, qualifications },
    ),
  // ---- 検定 ----
  updateQuizDefinitions: (quizzes: QuizDefinition[]) =>
    postToGas('updateSetting', { key: 'quiz_definitions', value: JSON.stringify(quizzes) }),
  // ---- 学習コンテンツ (LRN-001) ----
  updateLearningContents: (contents: LearningContent[]) =>
    postToGas('updateSetting', { key: 'learning_contents', value: JSON.stringify(contents) }),
  // ---- 学習コース (LRN-002) ----
  updateLearningCourses: (courses: LearningCourse[]) =>
    postToGas('updateSetting', { key: 'learning_courses', value: JSON.stringify(courses) }),
  // ---- 研修プログラム (LRN-006) ----
  updateTrainingPrograms: (programs: TrainingProgram[]) =>
    postToGas('updateSetting', { key: 'training_programs', value: JSON.stringify(programs) }),
  // ---- アンケート設問 (FRM-006) ----
  updateSurveyQuestions: (questions: SurveyQuestion[]) =>
    postToGas('updateSetting', { key: 'survey_questions', value: JSON.stringify(questions) }),
  submitQuizResult: (quizId: string, memberId: string, answers: number[]) =>
    postToGas<{ passed: boolean; score: number; newLevel?: number }>('submitQuizResult', { quizId, memberId, answers }),
  // ---- レーダーチャート軸 ----
  updateRadarAxes: (axes: RadarAxis[]) =>
    postToGas('updateSetting', { key: 'radar_axes', value: JSON.stringify(axes) }),
  // ---- 人材DBカスタム列 ----
  updateCustomMemberColumns: (columns: import('./types').CustomMemberColumn[]) =>
    postToGas('updateSetting', { key: 'custom_member_columns_json', value: JSON.stringify(columns) }),
  updateCustomFields: (memberId: string, customFields: Record<string, string>) =>
    postToGas('updateCustomFields', { memberId, customFields }),
  // ---- 経費申請 ----
  submitExpenseApplication: (application: import('./types').ExpenseApplication) =>
    postToGas('submitExpenseApplication', { application }),
  approveExpenseStep: (applicationId: string, stepId: string, actorId: string, comment?: string) =>
    postToGas('approveExpenseStep', { applicationId, stepId, actorId, comment }),
  rejectExpense: (applicationId: string, reason: string) =>
    postToGas('rejectExpense', { applicationId, reason }),
  withdrawExpense: (applicationId: string) =>
    postToGas('withdrawExpense', { applicationId }),
  returnExpense: (applicationId: string, reason: string) =>
    postToGas('returnExpense', { applicationId, reason }),
  resubmitExpense: (
    applicationId: string,
    fields: {
      amount: number
      categoryId: string
      receiptUrl?: string
      justification?: string
      purpose?: string
      customFieldAnswers?: Record<string, string>
      approvalSteps: import('./types').ApprovalStep[]
    },
  ) => postToGas('resubmitExpense', { applicationId, fields }),
  // ---- カスタムフォーム ----
  submitCustomForm: (submission: import('./types').CustomFormSubmission) =>
    postToGas('submitCustomForm', { submission }),
  approveFormStep: (submissionId: string, stepId: string, actorId: string, comment?: string) =>
    postToGas('approveFormStep', { submissionId, stepId, actorId, comment }),
  rejectFormSubmission: (submissionId: string, reason: string) =>
    postToGas('rejectFormSubmission', { submissionId, reason }),
  // ---- 日報・週報 (REP-004/REP-005) ----
  submitDailyReport: (report: import('./types').DailyReportEntry) =>
    postToGas('submitDailyReport', { report }),
  fetchDailyReports: () =>
    postToGas<import('./types').DailyReportEntry[]>('fetchDailyReports', {}),
  bulkUpdateSkills: (updates: { memberId: string; skill: string; level: number }[]) =>
    postToGas('bulkUpdateSkills', { updates }),
  updateAbsentDates: (memberId: string, dates: string[]) =>
    postToGas('updateAbsentDates', { memberId, dates }),
  updateLastLogin: (memberId: string) =>
    postToGas('updateLastLogin', { memberId }),
  // ---- アンケート ----
  // GAS側でid(Utilities.getUuid())を採番するので、送信するのはanswersのみ。
  // クライアント側で仮生成したidと一致させる必要はない（submitExpenseApplication
  // と同様、クライアント生成idをそのままローカルstateで使い続ける）。
  submitSurveyResponse: (answers: Record<string, number | string>) =>
    postToGas('submitSurveyResponse', { answers }),
  // item 2/TSK-051: 定期タスクの生成要否判定・実際の生成はGAS側の
  // LockService付き関数(generateRecurringTasksLocked)に一本化されている。
  // クライアントはこれを呼ぶだけで、日付判定・期限計算・二重生成防止は
  // すべてサーバー側で行われる。
  checkAndGenerateRecurringTasks: () =>
    postToGas<{ generated: { tempId: string; id: string }[] }>(
      'checkAndGenerateRecurringTasks',
      {},
    ),
  // NTF-005: 日次トリガー任せだった期限超過リマインドの手動発火
  triggerOverdueReminders: () => postToGas('triggerOverdueReminders', {}),
}

// re-exported for the parser fallback in input-screen.tsx, which needs to
// turn ParsedTask rows into CreateTaskPayload rows.
export function toCreatePayload(tempId: string, p: ParsedTask, creatorId?: string, originalInputId?: string): CreateTaskPayload {
  return {
    tempId,
    title: p.name,
    projectId: p.projectId,
    department: p.department,
    category: p.category,
    skills: p.skills,
    difficulty: p.difficulty,
    priority: p.priority,
    startDate: p.startDate,
    deadline: p.deadline,
    dueTime: p.dueTime,
    assigneeIds: p.assigneeIds,
    creatorId,
    originalInputId,
    pendingApproval: true,
    visibility: p.visibility ?? 'all',
    estimatedHours: p.estimatedHours,
    importance: p.importance,
  }
}
