// Wires the app to the real "database": Google Sheets tabs (Members /
// Projects / Tasks / Settings) read and written through a Google Apps
// Script Web App. Reads go through the authenticated getInitialData action,
// which returns only what the signed-in member may see (see gas/Code.gs's
// READ_POLICY). See gas/README.md for the sheet schema and deployment steps.
// All of this is optional — when NEXT_PUBLIC_REGISTRY_URL isn't set (e.g. local
// dev), the app falls back to the local seed data exactly as before.
import { normalizeCapabilities, type Capability } from './capabilities'
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
import { parseSkillLevelRules, type SkillLevelRules } from './skill-levels'
import { type TaskVisibility } from './types'
import { defaultDepartments, normalizeDepartment, parseDepartmentsSetting, type DepartmentDef } from './departments'
import { DEFAULT_BASE_ROLE_NAME, ROLE_SETTING_KEYS, isAdminRoleRef, parseRolesSetting, rolesFromLegacy, type RoleDef } from './roles'
import { CLIENT_VERSION, normalizeCode } from './codes'
import {
  normalizeHistoryEntry,
  normalizePermissionOverride,
  normalizeProjectTemplates,
  normalizeRecurringRules,
  normalizeSchedule,
  normalizeTaskSetTemplates,
  normalizeThresholdKeys,
} from './code-normalize'
import { activateSession, applyRenewedSession, clearSession, getSessionToken, type StoredSession } from './session'
import { GasTransportError, READ_ACTIONS, pingGas, sendToGas, type GasResponse } from './gas-transport'
import { ORG_CHANGED_EVENT, REGISTRY_URL, getActiveGasUrl, getActiveOrg } from './org-directory'
import { noteContractResponse } from './contract'
import { extractUnsavedTexts } from './read-only'
import { baseVersionsFor, listOpsFor, rememberServerRows } from './sync-state'
import { LIST_ACTIONS } from './list-diff'

// セッションが無効になった(期限切れ・全端末でログアウトなど)ときに window に送るイベント。
// store.tsx がログイン画面に戻す
/** 新しいメンバーへの招待メールの結果(gas/Code.gs の sendMemberInvite_)。notChecked: レジストリに確かめていない団体 */
export interface MemberInviteResult {
  sent: boolean
  // mailQuota: メールの1日の上限 / limited: 1人あたりの通知の回数の上限
  reason?: 'notChecked' | 'noEmail' | 'mailQuota' | 'limited'
}

/** 個人情報を消す前の人(gas/Code.gs の pendingPersonalData_)。kind: member(退会したメンバー) / candidate(採用しなかった候補者) */
export interface PendingPersonalData {
  kind: 'member' | 'candidate'
  id: string
  name: string
  since: string
  purgeAt: string
  extended: boolean
}

/** 個人情報の削除の状態(代表だけ)。upcoming: 7日以内に消す人数(日ごと) */
export interface PersonalDataStatus {
  retentionDays: number
  min: number
  max: number
  noticeDays: number
  pending: PendingPersonalData[]
  upcoming: { date: string; count: number }[]
  // 対応するメンバーがいないメールアドレスの行(自動では消さない。代表が確かめて消す)
  orphanEmails?: { id: string; email: string }[]
}

/** 退会を取り消した時の、退会の時に未アサインに戻したタスク */
export interface UnassignedTask {
  id: string
  title: string
  status: string
  assigneeIds: string[]
}

/** 毎日・毎時の処理の状態(gas/Code.gs の jobStatus_)。dailyStale: 毎日の処理が26時間以上成功していない */
export interface JobStatus {
  dailyAt: string
  hourlyAt: string
  installedAt: string
  dailyFailedAt: string
  dailyError: string
  hourlyFailedAt: string
  hourlyError: string
  dailyStale: boolean
  hourlyStale: boolean
  staleHours: number
}

/** 共有の問題(gas/Code.gs の checkSharing_)。target: spreadsheet / uploads / backups */
export interface SharingProblem {
  target: 'spreadsheet' | 'uploads' | 'backups'
  kind: 'link' | 'editor' | 'viewer' | 'unknown'
  detail: string
}

/** 1つのセルの上限の8割を超えている記録(gas/Code.gs の longRecords_)。記録の種類(シートと列)ごと */
export interface LongRecordGroup {
  sheet: string
  field: string
  label: string
  count: number
  items: { id: string; name: string; length: number }[]
}

export interface LongRecords {
  warnAt: number
  max: number
  maxLength: number
  groups: LongRecordGroup[]
}

/** 利用の集計とエラーの件数(gas/Code.gs の usageStatus_。代表だけ) */
export interface UsageStatus {
  days: { date: string; login: number; open: number; writes: number }[]
  topActions: { action: string; count: number }[]
  errors: {
    last7Days: number
    byKind: { kind: string; count: number }[]
    recent: { at: string; source: string; action: string; kind: string }[]
  }
}

/** FSIF に送る集計値(gas/Code.gs の metricsStatus_。代表だけ) */
export interface MetricsStatus {
  plan: '' | 'cosmo_base' | 'ohsumi' | 'paid'
  mandatory: boolean
  defaultOn: boolean
  enabled: boolean
  slot: { dow: number; hour: number }
  nextAt: string
  definitionsVersion: number
  preview: Record<string, number>
  history: { period: string; at: string; ok: boolean; error: string; attempt: number }[]
}

/** FSIF からの回答待ちのアンケート(レジストリの checkIn が伝えたもの)。restrictAt: 未回答で入る機能停止の日時(無ければ空) */
export interface PendingSurvey {
  surveyId: string
  title: string
  formUrl: string
  sendDate: string
  dueDate: string
  overdue: boolean
  restrictAt: string
}

/** FSIF からのお知らせ(gas/Code.gs の announcementsStatus_)。importance: normal 通常 / important 重要 / urgent 緊急 */
export type AnnouncementImportance = 'normal' | 'important' | 'urgent'
export interface Announcement {
  announcementId: string
  title: string
  body: string
  importance: AnnouncementImportance
  publishedAt: string
  expiresAt: string
}
export interface AnnouncementsStatus {
  // レジストリに登録しているか(していない団体には、お知らせは届かない)
  registered: boolean
  announcements: Announcement[]
  fetchedAt: string
  // レジストリに届かず、最後に取れたものを出している
  stale: boolean
}

/** 診断情報(gas/Code.gs の diagnosticsPreview_)。diagnostics は個人情報を含まない(版・設定の状態・上限・エラーの件数など) */
export interface DiagnosticsHistoryEntry {
  receiptNo: string
  at: string
}
export interface DiagnosticsPreview {
  diagId: string
  diagnostics: Record<string, unknown>
  history: DiagnosticsHistoryEntry[]
}
export interface DiagnosticsSent {
  receiptNo: string
  at: string
  history: DiagnosticsHistoryEntry[]
}

export interface OpsStatus {
  jobs: JobStatus
  sharing: { checkedAt: string; problems: SharingProblem[] }
  // 古い GAS は返さない
  longRecords?: LongRecords
  surveys?: PendingSurvey[]
  // レジストリから止めている機能(機能のスイッチ。gas/Code.gs の FEATURE_SWITCHES)
  disabledFeatures?: { id: string; label: string }[]
}

/** バックアップの状態(gas/Code.gs の backupStatus_)。failed: 最後に作ろうとした時に作れなかった */
export interface BackupStatus {
  lastSuccessAt: string
  failed: boolean
  failedAt: string
  error: string
}

/** バックアップ1つ。kind: daily(毎日) / beforeRestore(戻す前に自動で作ったもの) */
export interface BackupEntry {
  id: string
  name: string
  at: string
  kind: 'daily' | 'beforeRestore'
}

/** 全体を戻す前に見せる、シートごとの件数(null はそのシートが無い) */
export interface RestorePreview {
  backup: BackupEntry
  sheets: { name: string; current: number | null; backup: number | null }[]
}

/** バックアップの中のタスク。state: changed(今と違う) / same / missing(今は消えている。「復元」) */
export interface BackupTaskMatch {
  id: string
  title: string
  currentTitle: string
  state: 'changed' | 'same' | 'missing'
  diffs: { field: string; current: string; backup: string }[]
}

/** この団体の GAS の版の更新(gas/Code.gs の gasUpdateStatus_)。known: レジストリに今の版を判定してもらった */
export interface GasUpdateStatus {
  current: string
  known: boolean
  required: boolean
  outdated: boolean
  latest: string
  minimum: string
  security: boolean
  checkedAt: string
}

/** メールの1日の上限の状態(gas/Code.gs の mailQuotaStatus_)。skipped: 今日、上限で送れなかった数 */
export interface MailQuotaStatus {
  remaining: number | null
  date: string
  skipped: number
  reachedAt: string
  lastReachedDate: string
}

/** 本人あての招待リンクのメールを送れるか(gas/Code.gs の inviteMailStatus_) */
export interface InviteMailStatus {
  available: boolean
  // notChecked: レジストリに一度も確かめていない団体 / noEmail: 登録済みのアドレスが無い / limit: 1時間の上限
  reason?: 'notChecked' | 'noEmail' | 'limit'
  remaining: number
  retryAt?: string
}

export const SESSION_ENDED_EVENT = 'ohsumi:session-ended'
// 通知の回数の上限を超えて、GAS が一部の通知を送らなかった時に window に送るイベント(ohsumi-app.tsx が知らせる)
export const NOTIFY_LIMITED_EVENT = 'ohsumi:notify-limited'

// 1つのセルの上限の8割を超えた記録を書いた時に window に送るイベント(ohsumi-app.tsx が書いた人に知らせる)
export const LONG_RECORDS_EVENT = 'ohsumi:long-records'

/** ほかの人が先に同じ内容を変えたため、GAS が上書きせずに断った(書き込みの競合チェック)。texts: 書いた文章 */
export class ConflictError extends Error {
  constructor(message: string, readonly texts: string[] = []) {
    super(message)
    this.name = 'ConflictError'
  }
}

/** 1つのセルの上限(5万文字)を超えるため、GAS が保存を断った。texts: 書いた文章(画面はコピーできるように出す) */
export class CellTooLongError extends Error {
  constructor(message: string, readonly texts: string[] = []) {
    super(message)
    this.name = 'CellTooLongError'
  }
}

/** 画面が古い(移行の後の GAS が、以前の画面からの書き込みを断った)。送ろうとした文章を残して、読み込み直してもらう */
export class ReloadRequiredError extends Error {
  constructor(message: string, readonly texts: string[] = []) {
    super(message)
    this.name = 'ReloadRequiredError'
  }
}

// 権限が足りないと断られた時に window に送るイベント(役職が変わったかもしれないので、store.tsx がデータを読み直す)
export const FORBIDDEN_EVENT = 'ohsumi:forbidden'

/** 機能停止中(読み取り専用)のため、GAS が書き込みを断った(R1-e。lib/ohsumi/contract.ts) */
// texts: 送ろうとした文章(画面は読み込み直さずに、コピーできるように出す)
export class ContractRestrictedError extends Error {
  constructor(message: string, readonly texts: string[] = []) {
    super(message)
    this.name = 'ContractRestrictedError'
  }
}

// 送り先の団体の GAS は、ページを開いた時に決まる(org-directory.ts。招待リンク・この端末の団体の一覧)。
// 団体の GAS の URL は、レジストリ(NEXT_PUBLIC_REGISTRY_URL)が答えたものだけを使う(ビルド時の既定の団体は無い)
export const isRemoteConfigured = !!REGISTRY_URL

// 切り分け用: ブラウザのコンソールで ohsumiPing() を実行すると、何もしない ping を3回送り、
// 往復の時間と GAS の中の時間を並べて出す(gas-transport.ts の pingGas)
export function pingGasServer(count = 3) {
  const url = getActiveGasUrl()
  if (!url) throw new Error('GAS Web App URL is not configured')
  return pingGas(url, count)
}
if (typeof window !== 'undefined' && isRemoteConfigured) {
  ;(window as unknown as { ohsumiPing?: (count?: number) => Promise<unknown> }).ohsumiPing = (count?: number) => pingGasServer(count)
  ;(window as unknown as { ohsumiInitialImages?: (on?: boolean) => string }).ohsumiInitialImages = setInitialImages
}

// ログイン・再読み込みの応答に画像を入れるか(比べるための切り替え。この端末のブラウザだけに保存する)。
// コンソールで ohsumiInitialImages(false) で入れない、ohsumiInitialImages(true) で入れる(既定)
const INITIAL_IMAGES_KEY = 'ohsumi-initial-images'

function initialImagesEnabled(): boolean {
  try {
    return typeof window === 'undefined' || window.localStorage?.getItem(INITIAL_IMAGES_KEY) !== 'off'
  } catch {
    return true
  }
}

function setInitialImages(on = true): string {
  try {
    if (on) window.localStorage.removeItem(INITIAL_IMAGES_KEY)
    else window.localStorage.setItem(INITIAL_IMAGES_KEY, 'off')
  } catch {
    /* 保存できなければ何もしない */
  }
  return on
    ? 'ログインの応答に画像を入れます(次のログイン・再読み込みから)'
    : 'ログインの応答に画像を入れません(次のログイン・再読み込みから)。元に戻すには ohsumiInitialImages(true)'
}

/** 初期データ・ログインに付ける、裏での読み込みの指定 */
function backgroundOptions(): Record<string, unknown> {
  return initialImagesEnabled() ? { withBackground: true } : { withBackground: true, withFiles: false }
}

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

export const AVATAR_PALETTE = ['#2948e8', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6', '#e11d48', '#0891b2']

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

// role 列は役職の ID(移行前は役職名)。空は一般の役職
function roleFromSheet(role: string, roles: RoleDef[]): Role {
  if (role && role.trim()) return role.trim()
  return roles.find((r) => r.tier === 'base')?.id ?? DEFAULT_BASE_ROLE_NAME
}

function mapMemberRow(
  r: Record<string, string>,
  projectsById: Map<string, Project>,
  roles: RoleDef[],
  departments: DepartmentDef[],
): Member {
  const projectIds = splitTags(r.project_ids)
  const will = splitTags(r.will_tags)
  const judgment = splitTags(r.judgment_tags)
  const role = roleFromSheet(r.role, roles)
  const affiliation =
    projectIds.length > 0
      ? projectIds.map((pid) => projectsById.get(pid)?.name ?? pid).join(' / ')
      : isAdminRoleRef(roles, role)
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
    // MemberEmailsシートへ移した(exchangeIdToken/getMyEmails/updateEmail経由で
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
    quizPasses: parseJsonArray<NonNullable<Member['quizPasses']>[number]>(r.quiz_passes_json),
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
    permissionOverrides: parseJsonArray<PermissionOverride>(r.permission_overrides_json)?.map((ov) => normalizePermissionOverride(ov, departments)),
    skillPoints: parseJsonObject<SkillPoints>(r.skill_points_json),
    inactive: r.inactive === 'TRUE' ? true : undefined,
    withdrawnAt: r.withdrawn_at || undefined,
    personalDataPurgedAt: r.personal_data_purged_at || undefined,
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

// シートの値は、移行の前は日本語、移行の後はコード。どちらでもコードにそろえる
// (読めない値は、以前と同じ既定値になる。ステータスは進行中など)

function mapTaskRow(r: Record<string, string>, departments: DepartmentDef[]): Task {
  return {
    id: r.id,
    name: r.title,
    description: r.description ?? '',
    projectId: r.project_id,
    department: normalizeDepartment(departments, r.department),
    assigneeIds: splitTags(r.assignee_id),
    assignType: r.assign_type || 'open_bid',
    openBidApplicantIds: splitTags(r.open_bid_applicant_ids), // TSK-027
    startDate: r.start_date || null,
    deadline: r.due_date || null,
    dueTime: r.due_time || null,
    category: r.category || '',
    skills: splitTags(r.skills),
    difficulty: normalizeCode('difficulty', r.difficulty || 'beginner'),
    priority: normalizeCode('priority', r.priority || 'medium'),
    status: normalizeCode('status', r.status),
    completedDate: r.completed_date || null,
    lastActivity: r.last_activity || r.created_at || undefined,
    originalInputId: r.original_input_id || undefined,
    createdById: r.creator_id || undefined,
    createdAt: r.created_at || undefined,
    progress: r.progress_note || undefined,
    progressPercent: r.progress_percent !== '' && r.progress_percent != null ? Number(r.progress_percent) : undefined,
    progressHistory: parseJsonArray<ProgressEntry>(r.progress_history_json) ?? [],
    pendingApproval: normalizeCode('approval', r.approval_status) === 'pending',
    dependsOnIds: splitTags(r.depends_on_ids),
    visibility: normalizeCode('visibility', r.visibility),
    reviewerId: r.reviewer_id || undefined,
    reviewerIds: r.reviewer_ids ? splitTags(r.reviewer_ids) : (r.reviewer_id ? [r.reviewer_id] : undefined),
    blocker: r.blocker_note ? { note: r.blocker_note, since: r.blocker_since || '' } : undefined,
    holdReason: r.hold_reason_note ? { note: r.hold_reason_note, since: r.hold_reason_since || '' } : undefined,
    deliverables: parseJsonArray<TaskDeliverable>(r.deliverables_json),
    history: parseJsonArray<TaskHistoryEntry>(r.history_json)?.map((h) => normalizeHistoryEntry(h, departments)),
    comments: parseJsonArray<TaskComment>(r.comments_json),
    estimatedHours: r.estimated_hours ? Number(r.estimated_hours) : undefined,
    actualHours: r.actual_hours ? Number(r.actual_hours) : undefined,
    retrospective: parseJsonObject<TaskRetrospective>(r.retrospective_json),
    importance: r.importance ? normalizeCode('importance', r.importance) : undefined,
    schedule: normalizeSchedule(parseJsonObject<TaskSchedule>(r.schedule_json)),
    form: parseJsonObject<TaskForm>(r.form_json),
    // __ で始まる項目(点数を付けた人の一覧など、GAS の記録)は、スキルの点数ではないので除く
    awardedPoints: skillPointsOnly(parseJsonObject<Record<string, unknown>>(r.awarded_points_json)),
    requiredApprovals: r.required_approvals
      ? r.required_approvals === 'all' ? 'all' : Number(r.required_approvals)
      : undefined,
    reviewApprovals: parseJsonArray<{ memberId: string; at: string }>(r.review_approvals_json),
    requiredSkillLevels: parseJsonObject<Partial<Record<string, SkillLevelValue>>>(r.required_skill_levels_json),
    relatedReviewTaskId: r.related_review_task_id || undefined,
    deletedAt: r.deleted_at || undefined,
    deletedById: r.deleted_by || undefined,
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
function skillPointsOnly(obj: Record<string, unknown> | undefined): SkillPoints | undefined {
  if (!obj) return undefined
  const out: SkillPoints = {}
  for (const [k, v] of Object.entries(obj)) if (!k.startsWith('__') && typeof v === 'number') out[k] = v
  return out
}

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
  // 役職の一覧(Settings から。省略時は今までの設定の既定)
  roles: RoleDef[] = rolesFromLegacy({}),
  // 部門の一覧(Settings から。省略時は既定の部門)
  departments: DepartmentDef[] = defaultDepartments(),
): RemoteData {
  const projects = projectRows.map(mapProjectRow)
  const projectsById = new Map(projects.map((p) => [p.id, p]))
  const members = memberRows.map((r) => mapMemberRow(r, projectsById, roles, departments))
  const tasks = taskRows.map((r) => mapTaskRow(r, departments))
  return { members, projects, tasks }
}

export interface RemoteSettings {
  skillOptions: string[]
  categoryOptions: string[]
  // 役職の一覧(Settings の roles。無ければ今までの設定 role_levels などから組み立てる)
  roles: RoleDef[]
  // Settings の roles を使っているか(移行の後・新しく導入した団体)。使っていない間は
  // 役職の ID が役職名そのもので、名前の変更と代表以外の最上位の役職は作れない
  rolesFromSetting: boolean
  // 部門の一覧(Settings の departments。無ければ既定の7部門)。アーカイブした部門も含む
  departments: DepartmentDef[]
  projectTemplates: Record<string, ProjectTemplateTask[]>
  taskSetTemplates: TaskSetTemplate[]
  recurringRules: RecurringTaskRule[]
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
  // スキルポイントのレベルアップ閾値 — { "デフォルト": 100, "デザイン": 150 }
  skillLevelThresholds: SkillLevelThresholds
  // スキルのレベルの決め方(Settings の skill_level_rules。lib/ohsumi/skill-levels.ts)
  skillLevelRules: SkillLevelRules
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
  // 個人を特定しない集計値を FSIF に送っているか — Settings キー "metrics_sharing_notice"(on / off。GAS が書く)
  metricsSharingNotice: boolean
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
  const roleSettings = Object.fromEntries(ROLE_SETTING_KEYS.map((k) => [k, byKey.get(k)]))
  const departmentsSetting = parseDepartmentsSetting(byKey.get('departments'))
  const departments = departmentsSetting ?? defaultDepartments()
  const rolesSetting = parseRolesSetting(roleSettings.roles)
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
    roles: rolesSetting ?? rolesFromLegacy(roleSettings),
    rolesFromSetting: !!rolesSetting,
    departments,
    projectTemplates: normalizeProjectTemplates(projectTemplates, departments),
    taskSetTemplates: normalizeTaskSetTemplates(taskSetTemplates, departments),
    recurringRules: normalizeRecurringRules(recurringRules, departments),
    skillFieldOptions: splitTags(byKey.get('skill_field_options')),
    skillFieldSkills,
    skillFieldThreshold: Number.isFinite(skillFieldThreshold) ? skillFieldThreshold : null,
    orgNotificationEmails: splitTags(byKey.get('org_notification_emails')),
    surveyInvitedIds: splitTags(byKey.get('survey_invited_ids')),
    orgName: byKey.get('org_name') ?? '',
    metricsSharingNotice: byKey.get('metrics_sharing_notice') === 'on',
    orgLogoUrl: byKey.get('org_logo_url') ?? '',
    themeColor: byKey.get('theme_color') ?? '',
    projectOrder: splitTags(byKey.get('project_order')),
    skillLevelThresholds: (() => {
      try { const r = byKey.get('skill_level_thresholds'); return r ? normalizeThresholdKeys(JSON.parse(r)) : {} } catch { return {} }
    })(),
    skillLevelRules: parseSkillLevelRules(byKey.get('skill_level_rules') ?? ''),
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
  // 同じ応答に入れた裏での読み込み(withBackground)。GAS が古い時は無い
  background?: BackgroundData
  // 裏での読み込みだけ失敗した(画面が getBackgroundData を送り直す)
  backgroundError?: string
  // ログインした人のできる操作(GAS が役職と人ごとの例外から計算する)。unchanged の時は無い
  capabilities?: Capability[]
  // 団体のスプレッドシートと Apps Script の編集画面(最上位の役職の人にだけ届く。古い GAS では無い)
  adminLinks?: OrgAdminLinks
}

export interface OrgAdminLinks {
  spreadsheetUrl: string
  scriptEditUrl: string
}

// GAS が渡した URL のうち、スプレッドシート・Apps Script の編集画面の形のものだけを使う
export function parseOrgAdminLinks(v: unknown): OrgAdminLinks | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const sheet = String(o.spreadsheetUrl ?? '')
  const script = String(o.scriptEditUrl ?? '')
  if (!/^https:\/\/docs\.google\.com\/spreadsheets\/[^\s"'<>]+$/.test(sheet)) return undefined
  if (!/^https:\/\/script\.google\.com\/d\/[\w-]+\/edit$/.test(script)) return undefined
  return { spreadsheetUrl: sheet, scriptEditUrl: script }
}

interface InitialDataResponse {
  memberId: string | null
  version?: string
  unchanged?: boolean
  capabilities?: string[]
  adminLinks?: unknown
  sheets?: Record<'Members' | 'Projects' | 'Tasks' | 'Settings', SheetTable>
  background?: BackgroundData
  backgroundError?: string
}

// Signs in (resolves the member) and loads Members/Projects/Tasks/Settings
// in one GAS call. Pass the version from the previous load to skip the
// payload when nothing changed.
// 裏での読み込み(経費・フォームの回答・候補者・自分のメール)も同じ応答で受け取る(withBackground)。
// 通信の回数そのものを減らす(1回ごとに、結果の受け渡しで止まる機会がある)
// 所要時間と GAS の中の内訳は、gas-transport.ts がコンソールに出す
export async function fetchInitialData(knownVersion?: string): Promise<InitialData> {
  const res = await postToGas<InitialDataResponse>('getInitialData', knownVersion ? { knownVersion, ...backgroundOptions() } : backgroundOptions())
  return toInitialData(res)
}

function toInitialData(res: InitialDataResponse): InitialData {
  const extra = {
    background: res.background,
    backgroundError: res.backgroundError,
    ...(Array.isArray(res.capabilities) ? { capabilities: normalizeCapabilities(res.capabilities) } : {}),
    ...(parseOrgAdminLinks(res.adminLinks) ? { adminLinks: parseOrgAdminLinks(res.adminLinks) } : {}),
  }
  if (!res.memberId || res.unchanged || !res.sheets) {
    return { memberId: res.memberId, version: res.version, unchanged: res.unchanged, ...extra }
  }
  const { Members, Projects, Tasks, Settings } = res.sheets
  const settings = parseSettings(tableToRecords(Settings))
  // 書き込みの競合チェックのために、行の版と記録の一覧を覚える(sync-state.ts)
  rememberServerRows({ Members: tableToRecords(Members), Projects: tableToRecords(Projects), Tasks: tableToRecords(Tasks) })
  return {
    ...extra,
    memberId: res.memberId,
    version: res.version,
    data: mapRemoteData(tableToRecords(Members), tableToRecords(Projects), tableToRecords(Tasks), settings.roles, settings.departments),
    settings,
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
  visibility?: TaskVisibility
  estimatedHours?: number
  importance?: TaskImportance
  relatedReviewTaskId?: string
  // 日程調整・フォームのクイック追加(一般のメンバーでも承認なしで作れる。GAS が中身を確かめて、作る時に保存する)
  quickKind?: 'schedule' | 'form'
  schedule?: import('./types').TaskSchedule
  form?: import('./types').TaskForm
  // 幹部の取り込み(GAS は幹部の時だけ受け付ける)。承認待ちにせず、次の項目も入れられる
  import?: boolean
  status?: TaskStatus
  completedDate?: string
  reviewerIds?: string[]
  requiredApprovals?: number | 'all'
  actualHours?: number
  deliverables?: { label: string; url: string }[]
  // 前提タスク: 同じ取り込みの中のタスクの tempId
  dependsOnTempIds?: string[]
  // false: 公募にしない(担当を決めて割り当てる)
  openBid?: boolean
  // 保留の理由(status が hold の時だけ)
  holdReason?: string
}

// 認証なしで GAS を呼ぶ(getLoginConfig・exchangeIdToken)
async function callGas<T>(body: Record<string, unknown> & { action: string }): Promise<GasResponse<T>> {
  return sendToGasAt<T>(getActiveGasUrl(), body)
}

// 指定した団体の GAS に、認証なしで送る(招待リンクの団体の団体ID を、使う前に確かめる時)
async function sendToGasAt<T>(url: string, body: Record<string, unknown> & { action: string }): Promise<GasResponse<T>> {
  if (!url) throw new Error('GAS Web App URL is not configured')
  const json = await sendToGas<T>(url, { ...body, clientVersion: CLIENT_VERSION })
  // 招待リンクの確認(ほかの団体の GAS)の応答は、今の団体の状態にしない
  if (url === getActiveGasUrl()) noteContractResponse(json)
  return json
}

/** ログイン前に団体ID(IDトークンの nonce に含める)を取得する。GAS が古い場合などは null。gasUrl を省くと今の団体の GAS */
export async function fetchLoginConfig(gasUrl?: string): Promise<{ orgId: string; suspended?: boolean } | null> {
  try {
    const body = { action: 'getLoginConfig' }
    type Config = { orgId: string; suspended?: boolean }
    const json = gasUrl ? await sendToGasAt<Config>(gasUrl, body) : await callGas<Config>(body)
    if (!json.ok || !json.result?.orgId) return null
    // 提供停止中(R1-e): ログイン画面に「利用を停止しています」を出す
    return json.result.suspended === true ? { orgId: json.result.orgId, suspended: true } : { orgId: json.result.orgId }
  } catch {
    return null
  }
}

export interface BackgroundData {
  expenses?: import('./types').ExpenseApplication[]
  formSubmissions?: import('./types').CustomFormSubmission[]
  candidates?: import('./types').Candidate[]
  myEmail?: string
  // ログインの直後に表示する画像(団体ロゴ・プロフィール画像)のうち、GAS のキャッシュにあったもの
  files?: FetchedFile[]
  errors?: Record<string, string>
}

export interface ExchangeResult extends InitialData {
  // 登録されていないアカウントの場合、本人のメールアドレスと団体名(ログイン画面の表示用)
  email?: string
  orgName?: string
  session?: StoredSession
  // GAS が最終ログイン日時を記録した(画面は updateLastLogin を送らなくてよい)
  lastLoginRecorded?: boolean
}

/**
 * Google の IDトークンをセッショントークンに交換し、初期データもまとめて受け取る。
 * setupCode(初期設定コード)を付けると、未登録のアカウントを最初の代表として団体に入れる(同じ1回の通信で)
 */
export async function exchangeIdToken(idToken: string, nonceSecret: string, remember: boolean, setupCode?: string): Promise<ExchangeResult> {
  let json: GasResponse<InitialDataResponse & { email?: string; session?: StoredSession }>
  try {
    json = await callGas<InitialDataResponse & { email?: string; session?: StoredSession }>({
      action: 'exchangeIdToken',
      idToken,
      nonceSecret,
      remember,
      ...(setupCode ? { setupCode } : {}),
      ...backgroundOptions(),
    })
  } catch (err) {
    // 同じ requestId で送り直しても応答を受け取れなかった。ログイン画面は新しい試行でボタンを出し直すので、
    // もう一度押せば入れる
    if (err instanceof GasTransportError) {
      throw new Error(`ログインの応答を受け取れませんでした(原因: ${err.reason})。もう一度「Google でログイン」を押してください。`)
    }
    throw err
  }
  if (!json.ok || !json.result) throw new Error(json.error || 'ログインに失敗しました')
  const res = json.result as InitialDataResponse & { email?: string; orgName?: string; session?: StoredSession; reloadInitialData?: boolean; lastLoginRecorded?: boolean }
  if (!res.memberId) return res.orgName ? { memberId: null, email: res.email, orgName: res.orgName } : { memberId: null, email: res.email }
  // 送り直しで受け取った前回の結果(gas/Code.gs の rememberLogin_)には、初期データが入っていない。
  // 受け取ったセッションで、初期データを読み直す
  if (res.reloadInitialData && res.session) {
    const orgId = getActiveOrg().orgId
    if (orgId) activateSession(orgId, { ...res.session, remember })
    const data = await fetchInitialData()
    return { ...data, session: res.session, lastLoginRecorded: res.lastLoginRecorded === true }
  }
  return { ...toInitialData(res), session: res.session, lastLoginRecorded: res.lastLoginRecorded === true }
}

async function postToGas<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
  const gasUrl = getActiveGasUrl()
  if (!gasUrl) throw new Error('GAS Web App URL is not configured')

  // セッショントークン(exchangeIdToken で発行されたもの)で認証する
  const sessionToken = getSessionToken()

  // 1本ずつ順番に送り、JSON が返らなければ送り直す(書き込みは requestId で二重に処理されない。
  // gas-transport.ts)。何度送っても JSON が返らない場合は GasTransportError を投げる
  // 書き込みには、開いた時点の行の版を付ける(ほかの人が先に変えていたら、GAS が断る)
  const baseVersions = READ_ACTIONS.has(action) ? undefined : baseVersionsFor(payload)
  const json = await sendToGas<T>(gasUrl, { action, sessionToken, clientVersion: CLIENT_VERSION, ...payload, ...(baseVersions ? { baseVersions } : {}) })

  if (json.session) applyRenewedSession(json.session)
  noteContractResponse(json)
  if (json.notifyLimited && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(NOTIFY_LIMITED_EVENT))
  if (json.longRecords?.length && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LONG_RECORDS_EVENT, { detail: json.longRecords }))

  // 提供停止中(R1-e): GAS はすべての操作を断る。ログインを終え、「利用を停止しています」を出すログイン画面に戻す
  if (!json.ok && json.orgSuspended) {
    if (typeof window !== 'undefined') {
      // 送ろうとした文章は、読み込み直した画面でコピーできるように渡す
      window.dispatchEvent(new CustomEvent(ORG_CHANGED_EVENT, { detail: { orgId: getActiveOrg().orgId, notice: 'orgSuspended', texts: extractUnsavedTexts(payload) } }))
    }
    throw new Error(json.error || 'この団体は、Ohsumi の利用を停止しています。')
  }
  // 機能停止中(読み取り専用): 作成・編集は断られる
  if (!json.ok && json.restricted) throw new ContractRestrictedError(json.error || '読み取り専用です', extractUnsavedTexts(payload))

  // セッションが無効(期限切れ・全端末でログアウト・鍵の変更など): 保存したトークンを消し、
  // ログイン画面に戻す
  // (セッションの期限がこの端末で切れている場合も、トークンを送らずに同じ扱いにする)
  if (!json.ok && json.authError) {
    clearSession()
    // 送ろうとした文章は、読み込み直した画面でコピーできるように渡す(書きかけの INPUT も消さない)
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { error: json.error, texts: extractUnsavedTexts(payload) } }))
    throw new Error(json.error || 'ログインの有効期限が切れました。再ログインしてください。')
  }

  // 画面が古い: 書きかけを残したまま、読み込み直すよう案内する
  if (!json.ok && json.reloadRequired) throw new ReloadRequiredError(json.error || '画面が古くなりました。読み込み直してください。', extractUnsavedTexts(payload))
  // ほかの人が先に変えていた: 書いた文章を残し、最新の内容に読み直す(store.tsx)
  if (!json.ok && json.conflict) throw new ConflictError(json.error || 'ほかの人が先にこの内容を変えたため、保存しませんでした。', extractUnsavedTexts(payload))
  // 1つのセルの上限を超える: 書いた文章を残す(GAS が今回書いた文章を返さなかった時は、送った内容から取り出す)
  if (!json.ok && json.cellTooLong) {
    const texts = json.cellTooLong.texts ? extractUnsavedTexts(json.cellTooLong.texts) : extractUnsavedTexts(payload)
    throw new CellTooLongError(json.error || 'この記録は長くなりすぎたため、保存できませんでした。', texts)
  }
  // 権限が足りない: 役職が変わったかもしれないので、画面のデータを読み直す(store.tsx)
  if (!json.ok && json.forbidden && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FORBIDDEN_EVENT))

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

// 記録の一覧(コメント・1on1 など)の保存: 丸ごとではなく、画面が知っている一覧との差分(listOps)で送る。
// ほかの人が後から足した記録は、差分に入らないので消えない(gas/Code.gs の「記録の一覧の差分」)
async function postListOps<T = unknown>(action: string, id: string, next: readonly unknown[], extra: Record<string, unknown> = {}): Promise<T> {
  const def = LIST_ACTIONS[action]
  const { listOps, restore } = listOpsFor(action, id, next)
  try {
    return await postToGas<T>(action, { [def.idParam]: id, ...extra, listOps })
  } catch (err) {
    restore()
    throw err
  }
}

export const remoteApi = {
  createTasks: (tasks: CreateTaskPayload[]) =>
    postToGas<{ tempId: string; id: string }[]>('createTasks', { tasks }),
  updateTaskStatus: (taskId: string, status: TaskStatus) =>
    postToGas('updateTaskStatus', { taskId, status }),
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
      visibility: TaskVisibility
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
    postListOps('updateProgress', taskId, progressHistory, { text }),
  // TSK-010: 既存のupdateProgressアクションに相乗りし、progressPercentのみを
  // 送る(text/progressHistoryは省略— GAS側は渡された列だけを部分更新する)
  updateProgressPercent: (taskId: string, percent: number) =>
    postToGas('updateProgress', { taskId, progressPercent: percent }),
  updateWill: (memberId: string, will: string[]) => postToGas('updateWill', { memberId, will }),
  updateJudgment: (memberId: string, judgment: string[]) =>
    postToGas('updateJudgment', { memberId, judgment }),
  approveTask: (taskId: string) => postToGas('approveTask', { taskId }),
  // ゴミ箱に入れる(GAS は行を消さずに deleted_at を書く)。元に戻す・完全に消すのは代表・全権管理者だけ
  removeTask: (taskId: string) => postToGas('removeTask', { taskId }),
  restoreTask: (taskId: string) => postToGas('restoreTask', { taskId }),
  purgeTask: (taskId: string) => postToGas('purgeTask', { taskId }),
  // 却下: タスクを消し、GAS がシートのタスクの作成者・名前で知らせる
  rejectTask: (taskId: string, reason: string | undefined) => postToGas('rejectTask', { taskId, reason }),
  createProject: (name: string, description: string, type?: string, parentId?: string) =>
    postToGas<{ id: string }>('createProject', { name, description, type, parentId }),
  removeProject: (projectId: string) => postToGas('removeProject', { projectId }),
  removeMember: (memberId: string) => postToGas('removeMember', { memberId }),
  updateNotify: (memberId: string, notify: boolean) =>
    postToGas('updateNotify', { memberId, notify }),
  updateNotifySettings: (memberId: string, settings: Partial<Record<NotifyKind, NotifyFrequency>>) =>
    postToGas('updateNotifySettings', { memberId, settings }),
  updateRole: (memberId: string, role: Role) => postToGas('updateRole', { memberId, role }),
  // 役職の一覧を保存する(並び順・種類・制限・セクション・必要スキル・名前)
  updateRoles: (roles: RoleDef[]) => postToGas<{ roles: RoleDef[] }>('updateRoles', { roles }),
  // 役職を削除する。使っているメンバーは moveToRoleId の役職に移す
  deleteRole: (roleId: string, moveToRoleId?: string) =>
    postToGas<{ roles: RoleDef[]; moved: number }>('deleteRole', { roleId, moveToRoleId }),
  // 部門の一覧を保存する(追加・名前・並び順・アーカイブの解除)
  updateDepartments: (departments: DepartmentDef[]) =>
    postToGas<{ departments: DepartmentDef[] }>('updateDepartments', { departments }),
  // 部門を削除する。使われていればアーカイブになる
  deleteDepartment: (departmentId: string) =>
    postToGas<{ departments: DepartmentDef[]; archived: boolean }>('deleteDepartment', { departmentId }),
  // ある部門のタスクを別の部門(空は未分類)へ移す
  moveDepartmentTasks: (fromDepartmentId: string, toDepartmentId: string) =>
    postToGas<{ moved: number }>('moveDepartmentTasks', { fromDepartmentId, toDepartmentId }),
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
  updateVisibility: (taskId: string, visibility: TaskVisibility) =>
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
  // sendInvite: 登録したアドレスに招待メールを送る(リンクは GAS が SITE_ORIGINS と団体ID から作る)
  addMember: (name: string, email: string, affiliation: string, role: Role, sendInvite = false) =>
    postToGas<{ id: string; invite?: MemberInviteResult }>('addMember', { name, email, affiliation, role, sendInvite }),
  updateEmail: (memberId: string, email: string) => postToGas('updateEmail', { memberId, email }),
  // 裏での読み込み(経費・フォームの回答・採用の候補者・自分のメールアドレス)を1回で受け取る。
  // それぞれ個別の操作と同じ絞り込みを通る。失敗したものは errors に理由が入る(gas/Code.gs の getBackgroundData)
  getBackgroundData: () => postToGas<BackgroundData>('getBackgroundData', {}),
  // 閲覧できる経費申請だけが返る(gas/Code.gs の canViewExpense)
  getExpenses: () => postToGas<import('./types').ExpenseApplication[]>('getExpenses', {}),
  // 採用の候補者(個人情報)。採用の権限が無い人には空の一覧が返る(gas/Code.gs の getCandidates)
  getCandidates: () => postToGas<import('./types').Candidate[]>('getCandidates', {}),
  // フォームの回答。閲覧できる回答だけが返る(gas/Code.gs の canViewFormSubmission)
  getFormSubmissions: () => postToGas<import('./types').CustomFormSubmission[]>('getFormSubmissions', {}),
  // アップロードしたファイル(非公開)を権限を確認したうえで取得する
  getFiles: (fileIds: string[]) => postToGas<FetchedFile[]>('getFiles', { fileIds }),
  // 自分自身の登録メール(カンマ区切り)を取得する。actingMember基準で
  // サーバー側が自分の分のみ返すため、他人のメールを取得する手段にはならない
  getMyEmails: () => postToGas<{ email: string }>('getMyEmails', {}),
  // 本人だけの保存(gas/Code.gs の getMyStorage・setMyStorage)。値は文字列(null で消す)
  getMyStorage: (keys?: string[]) => postToGas<{ values: Record<string, string> }>('getMyStorage', keys ? { keys } : {}),
  setMyStorage: (key: string, value: string | null) => postToGas<{ key: string; size: number }>('setMyStorage', { key, value }),
  // 全端末でログアウト(自分)。発行済みのセッションがすべて無効になる
  revokeMySessions: () => postToGas<{ revoked: boolean }>('revokeMySessions', {}),
  // ほかの端末で開く: 本人の登録済みのアドレスにだけ招待リンクを送る(宛先は送らない。GAS が決める)
  getInviteMailStatus: () => postToGas<InviteMailStatus>('getInviteMailStatus', {}),
  sendInviteLinkToMe: (siteOrigin: string, locale: string) =>
    postToGas<{ sent: boolean; count: number; remaining: number }>('sendInviteLinkToMe', { siteOrigin, locale }),
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
  // メールの1日の上限の状態(代表・全権管理者だけ)
  getMailQuotaStatus: () => postToGas<MailQuotaStatus>('getMailQuotaStatus', {}),
  // 毎日・毎時の処理と共有の状態(代表だけ)・共有を確かめ直す
  getOpsStatus: () => postToGas<OpsStatus>('getOpsStatus', {}),
  recheckSharing: () => postToGas<OpsStatus>('recheckSharing', {}),
  // 利用の集計とエラーの件数(代表だけ)・画面のエラーの記録(種類と操作の名前だけ。文は送らない)
  getUsageStatus: () => postToGas<UsageStatus>('getUsageStatus', {}),
  // FSIF に送る集計値(代表だけ)
  getMetricsStatus: () => postToGas<MetricsStatus>('getMetricsStatus', {}),
  getAnnouncements: () => postToGas<AnnouncementsStatus>('getAnnouncements', {}),
  getDiagnostics: () => postToGas<DiagnosticsPreview>('getDiagnostics', {}),
  sendDiagnostics: (diagId: string) => postToGas<DiagnosticsSent>('sendDiagnostics', { diagId }),
  setMetricsSharing: (enabled: boolean) => postToGas<MetricsStatus>('setMetricsSharing', { enabled }),
  reportClientError: (kind: string, errorAction?: string) => postToGas<{ recorded: boolean }>('reportClientError', { kind, errorAction: errorAction ?? '' }),
  // 個人情報の削除(代表だけ。gas/Code.gs の「個人情報の削除」)
  getPersonalDataStatus: () => postToGas<PersonalDataStatus>('getPersonalDataStatus', {}),
  setPersonalDataRetention: (days: number) => postToGas<{ retentionDays: number }>('setPersonalDataRetention', { days }),
  purgePersonalDataNow: (kind: PendingPersonalData['kind'], id: string) => postToGas('purgePersonalDataNow', { kind, id }),
  extendPersonalData: (kind: PendingPersonalData['kind'], id: string) => postToGas<{ purgeAt: string }>('extendPersonalData', { kind, id }),
  cancelWithdrawal: (memberId: string) => postToGas<{ restored: string; unassignedTasks?: UnassignedTask[] }>('cancelWithdrawal', { memberId }),
  deleteOrphanEmails: (ids: string[]) => postToGas<{ deleted: number; skipped: number }>('deleteOrphanEmails', { ids }),
  // バックアップ(代表だけ。gas/Code.gs の「バックアップ」)
  getBackupStatus: () => postToGas<BackupStatus>('getBackupStatus', {}),
  listBackups: () => postToGas<{ status: BackupStatus; backups: BackupEntry[]; keep: { daily: number; weekly: number; monthly: number } }>('listBackups', {}),
  // 今すぐバックアップを作る(代表だけ。前に手で作ってから10分は断られる)
  createBackupNow: () => postToGas<{ backup: BackupEntry; status: BackupStatus; backups: BackupEntry[] }>('createBackupNow', {}),
  previewRestore: (backupId: string) => postToGas<RestorePreview>('previewRestore', { backupId }),
  restoreBackup: (backupId: string) => postToGas<{ restored: string[]; beforeRestore: BackupEntry }>('restoreBackup', { backupId }),
  searchBackupTasks: (backupId: string, query: string) => postToGas<{ backup: BackupEntry; tasks: BackupTaskMatch[] }>('searchBackupTasks', { backupId, query }),
  restoreTasks: (backupId: string, taskIds: string[]) =>
    postToGas<{ restored: { id: string; title: string; state: 'restored' | 'recreated' }[] }>('restoreTasks', { backupId, taskIds }),
  // この団体の GAS の版の更新が要るか(代表・全権管理者だけ)
  getGasUpdateStatus: () => postToGas<GasUpdateStatus>('getGasUpdateStatus', {}),
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
  // 採用支援（Candidates）— 書き込み。読み取りは getCandidates(採用の権限を持つ人だけ)
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
  convertCandidateToMember: (candidateId: string, role?: string, sendInvite = false) =>
    postToGas<{ memberId: string; invite?: MemberInviteResult }>('convertCandidateToMember', { candidateId, role, sendInvite }),
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
    postListOps('updateDeliverables', taskId, deliverables),
  updateHistory: (taskId: string, history: TaskHistoryEntry[]) =>
    postListOps('updateHistory', taskId, history),
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
    postListOps('updateComments', taskId, comments),
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
    postListOps('updateCareerHistory', memberId, entries),
  updateQualifications: (memberId: string, entries: Qualification[]) =>
    postListOps('updateQualifications', memberId, entries),
  updateEvaluationHistory: (memberId: string, entries: EvaluationRecord[]) =>
    postListOps('updateEvaluationHistory', memberId, entries),
  updateTransferHistory: (memberId: string, entries: TransferRecord[]) =>
    postListOps('updateTransferHistory', memberId, entries),
  updateSkillLevels: (memberId: string, levels: SkillLevel[]) =>
    postListOps('updateSkillLevels', memberId, levels),
  updateCompetencies: (memberId: string, competencies: Competency[]) =>
    postListOps('updateCompetencies', memberId, competencies),
  updateCareerGoals: (
    memberId: string,
    goals: { careerAspiration: string; desiredFutureRole: string; careerPlan: string },
  ) => postToGas('updateCareerGoals', { memberId, ...goals }),
  updateTrainingHistory: (memberId: string, entries: TrainingRecord[]) =>
    postListOps('updateTrainingHistory', memberId, entries),
  // 研修の名前・状態は、GAS が保存した記録(trainingId)から読む
  notifyTrainingRequest: (memberId: string, trainingId: string) =>
    postToGas('notifyTrainingRequest', { memberId, trainingId }),
  notifyTrainingDecision: (memberId: string, trainingId: string) =>
    postToGas('notifyTrainingDecision', { memberId, trainingId }),
  updateDevelopmentPlan: (memberId: string, entries: DevelopmentPlanEntry[]) =>
    postListOps('updateDevelopmentPlan', memberId, entries),
  updateOneOnOnes: (memberId: string, entries: OneOnOneRecord[]) =>
    postListOps('updateOneOnOnes', memberId, entries),
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
  // 申請者・ID・作った日時・承認の段は GAS が決める(返ってきた id に差し替える)
  submitExpenseApplication: (application: import('./types').ExpenseApplication) =>
    postToGas<{ id: string }>('submitExpenseApplication', { application }),
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
    },
    // 承認の段は送らない(GAS がカテゴリの設定から決める)
  ) => postToGas('resubmitExpense', { applicationId, fields }),
  // ---- カスタムフォーム ----
  // 提出者・ID・作った日時は GAS が決める(返ってきた id に差し替える)
  submitCustomForm: (submission: import('./types').CustomFormSubmission) =>
    postToGas<{ id: string }>('submitCustomForm', { submission }),
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
