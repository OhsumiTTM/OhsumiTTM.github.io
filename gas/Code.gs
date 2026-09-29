/**
 * Ohsumi — Apps Script Web App (write API for the spreadsheet "database").
 *
 * Setup: open the FSIF database spreadsheet -> Extensions > Apps Script,
 * paste this whole file in as Code.gs, then Deploy > New deployment ->
 * type "Web app", execute as "Me", who has access "Anyone". Copy the
 * resulting /exec URL into the CSV_GAS GitHub secret.
 *
 * Reads (Members/Projects/Tasks) go directly to each sheet's published-CSV
 * URL from the frontend; this script only handles writes, dispatched by an
 * `action` field in the POST body. See gas/README.md for the full sheet
 * schema this expects.
 */

var SHEET_MEMBERS = 'Members'
var SHEET_PROJECTS = 'Projects'
var SHEET_TASKS = 'Tasks'
// メンバーのメールアドレス専用の非公開シート。Members/Projects/Tasksと違い、
// 「ウェブに公開」は絶対にしないこと — このシートだけ公開してしまうと、
// Membersシートからemail列を分離した意味が無くなる。email列をMembersシートから
// 分離し、認証済みのGASアクション(exchangeIdToken/getMyEmails/updateEmail)経由
// でのみ読み書きすることで、公開CSV経由での全員分メアド漏洩を防ぐ。
var SHEET_MEMBER_EMAILS = 'MemberEmails'
var MEMBER_EMAILS_HEADERS = ['id', 'email']
// optional 4th tab — key/value rows syncing the skill/category/role-level
// option pools and project templates; see gas/README.md. Missing sheet is
// fine, updateSetting() creates it on first write.
var SHEET_SETTINGS = 'Settings'

// ---- シートの列の一覧 ----------------------------------------------------------
// 各シートの列は、ここだけで定義する。setupOhsumi() と各シートの作成処理
// (ensure*Sheet)は、この一覧で不足している列を末尾に追加する。GAS が書き込む列・
// 画面が読む列・読み取りの権限表(READ_POLICY)の列がこの一覧とずれていないことは、
// lib/ohsumi/gas-sheet-headers.test.ts で確かめる(列を増やしたら、ここにも追加する)。
var MEMBERS_HEADERS = [
  // email列はここにはもう無い(MemberEmailsという非公開シートに分離した —
  // このシートは公開CSVとして配信されるため)。
  'id', 'name', 'role', 'notify_new_task', 'display_name',
  'avatar_url', 'avatar_color', 'avatar_initials',
  'will_tags', 'judgment_tags',
  'reports_to_id', 'mentor_id', 'joined_at', 'unavailable_dates', 'project_ids',
  'years_of_experience', 'has_management_experience', 'desired_areas', 'desired_skills',
  'career_history_json', 'qualifications_json', 'evaluation_history_json',
  'transfer_history_json', 'skill_levels_json', 'competencies_json',
  'career_aspiration', 'desired_future_role', 'career_plan',
  'training_history_json', 'development_plan_json', 'one_on_ones_json',
  'notify_settings',
  // 組織階層・権限・スキルポイント（新規列）
  'department_path',          // 例: "事業本部A>事業部1>グループX"
  'permission_overrides_json',// 例: [{"targetType":"task","targetId":"12","access":"view"}]
  'skill_points_json',        // 例: {"デザイン":120,"プログラミング":340}
  'inactive',                 // "TRUE" = 休止中メンバー（一覧から非表示）
  'absent_dates',            // 不在日リスト（カンマ区切り YYYY-MM-DD）
  'last_login',              // 最終ログイン日時（ISO datetime）
  'last_inactive_notified',  // 未アクセス通知を最後に送った日（YYYY-MM-DD）
  'timezone',                // 本人のタイムゾーン（IANA名、例: "Asia/Tokyo"）
  'locale',                  // 本人の表示言語（例: "ja", "en"）
  'university',              // 大学名
  'faculty',                 // 学部
  'department_name',         // 学科（department_pathと紛らわしいので department_name とする）
  'grade_year',              // 学年
  'custom_fields_json',      // 団体ごとのカスタム列（人材DB）の値 {"key":"value"}
  'survey_responses_json',   // item 22/30: このメンバー自身の全アンケート回答履歴 [{"id","submittedAt","answers"}]
  'available_hours_json',    // CAL-009: 日々の稼働可能時間帯（参考情報） {"start":"10:00","end":"18:00"}
]
var PROJECTS_HEADERS = [
  'id', 'name', 'description', 'type', 'owner_id', 'member_ids', 'archived', 'parent_id',
  'goal', // 目標（概要=descriptionとは別枠）
  'health_override',       // item 26: 幹部による健康状態の手動上書き
  'last_notified_health',  // item 26: 直近に通知した実効健康状態（重複通知防止）
  'start_date', // PRJ-003: プロジェクトの開始日（任意, YYYY-MM-DD）
  'end_date',   // PRJ-003: プロジェクトの終了予定日（任意, YYYY-MM-DD）
]
var TASKS_HEADERS = [
  'id', 'project_id', 'title', 'description', 'status', 'assign_type',
  'assignee_id', 'creator_id', 'created_at', 'start_date', 'due_date', 'due_time',
  'visibility', 'department', 'category', 'skills', 'difficulty', 'priority',
  'last_activity', 'original_input_id', 'approval_status', 'estimated_hours',
  'importance', 'reviewer_id', 'reviewer_ids', 'depends_on_ids',
  'progress_note', 'progress_percent', 'progress_history_json',
  'deliverables_json', 'history_json', 'comments_json',
  'retrospective_json', 'schedule_json', 'form_json',
  'blocker_note', 'blocker_since', 'completed_date', 'actual_hours',
  'awarded_points_json', // 完了時付与スキルポイント {"デザイン":30}
  'required_approvals',  // 承認に必要な確認者数 (数値 or "all")
  'required_skill_levels_json', // 必要スキルレベル(item 10/11) {"デザイン":3}
  'review_approvals_json', // 複数確認者の承認記録 [{"memberId","at","comment"}]
  'open_bid_applicant_ids', // TSK-027: 公募タスクへの応募者IDリスト(カンマ区切り)
  'related_review_task_id', // APR-007: このタスクが確認タスクである場合、確認対象の元タスクのid
  'hold_reason_note',  // 保留の理由(ステータスを保留にしたときのメモ)
  'hold_reason_since', // 保留にした日(YYYY-MM-DD)
]
var SETTINGS_HEADERS = ['key', 'value']
var EXPENSES_HEADERS = ['id', 'applicant_id', 'amount', 'category_id', 'receipt_url', 'justification', 'purpose', 'custom_field_answers_json', 'approval_steps_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var FORM_SUBMISSIONS_HEADERS = ['id', 'form_id', 'submitter_id', 'answers_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var DAILY_REPORTS_HEADERS = ['id', 'member_id', 'type', 'report_date', 'done_text', 'todo_text', 'issues_text', 'created_at']
var CANDIDATES_HEADERS = ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at']

var SHEET_HEADERS = {
  Members: MEMBERS_HEADERS,
  Projects: PROJECTS_HEADERS,
  Tasks: TASKS_HEADERS,
  Settings: SETTINGS_HEADERS,
  MemberEmails: MEMBER_EMAILS_HEADERS,
  Expenses: EXPENSES_HEADERS,
  FormSubmissions: FORM_SUBMISSIONS_HEADERS,
  DailyReports: DAILY_REPORTS_HEADERS,
  Candidates: CANDIDATES_HEADERS,
}

var SETTINGS_KEY_RECURRING_RULES = 'recurring_rules'
// スキルごとのレベルアップ閾値 JSON: { "デフォルト": 100, "デザイン": 150, ... }
var SETTINGS_KEY_SKILL_LEVEL_THRESHOLDS = 'skill_level_thresholds'
// 部署ツリー設定 JSON: 部署一覧を静的に管理したい場合に使う（省略時は
// Members.department_path の実データから動的導出）
var SETTINGS_KEY_DEPARTMENT_TREE_CONFIG = 'department_tree_config'
// NOT a Settings-sheet key (that sheet is published as a public CSV) — this
// is the PropertiesService key the Discord webhook URL is stored under
// instead. See getDiscordWebhookUrl()/updateDiscordWebhookUrl() below.
var DISCORD_WEBHOOK_PROPERTY_KEY = 'discord_webhook_url'

// ---- 選択肢の値の内部コード ------------------------------------------------------
//
// タスクのステータス・難易度・優先度などは、画面の言語によらない内部コードで
// 扱う。シートには、移行(migrateToInternalCodes)までは今の日本語の値が入って
// いる。読む時はどちらの形式でもコードにそろえ(normalizeCode)、書く時は
// スクリプトプロパティ VALUE_FORMAT が codes になるまで日本語で書く(sheetCode)。
// こうすると、古いタブや古い GAS が残っていても、シートの値は1つの形式のまま。
//
// VALUE_CODES は lib/ohsumi/codes.ts と同じ内容(一致することを
// lib/ohsumi/codes.test.ts で確かめる)。
var VALUE_CODES = {
  status: {
    codes: ['todo', 'hold', 'progress', 'support', 'review', 'fix', 'done'],
    sheetLabels: { todo: '未着手', hold: '保留', progress: '進行中', support: 'サポート必要', review: '確認待ち', fix: '修正中', done: '完了' },
    aliases: {},
    fallback: 'progress',
  },
  difficulty: {
    codes: ['anyone', 'beginner', 'some_exp', 'experienced', 'advanced'],
    sheetLabels: { anyone: '誰でも可', beginner: '新人歓迎', some_exp: '少し経験必要', experienced: '経験者向け', advanced: '上級者向け' },
    aliases: {},
    fallback: 'beginner',
  },
  priority: {
    codes: ['high', 'medium', 'low'],
    sheetLabels: { high: '高', medium: '中', low: '低' },
    aliases: {},
    fallback: 'medium',
  },
  importance: {
    codes: ['normal', 'important', 'external'],
    sheetLabels: { normal: '一般', important: '重要', external: '対外公開' },
    aliases: { '': 'normal' },
    fallback: 'normal',
  },
  visibility: {
    codes: ['all', 'leaders'],
    sheetLabels: { all: '全員', leaders: '幹部' },
    aliases: { '': 'all' },
    fallback: 'all',
  },
  approval: {
    codes: ['pending', 'approved'],
    sheetLabels: { pending: '承認待ち', approved: '承認済み' },
    aliases: { '': 'approved' },
    fallback: 'approved',
  },
  department: {
    codes: ['ops', 'pr', 'dev', 'design', 'relations', 'event', 'research', ''],
    sheetLabels: { ops: '運営', pr: '広報', dev: '開発', design: 'デザイン', relations: '渉外', event: 'イベント', research: 'リサーチ', '': '未分類' },
    aliases: {},
    fallback: null,
  },
  scheduleAnswer: {
    codes: ['yes', 'maybe', 'no'],
    sheetLabels: { yes: '○', maybe: '△', no: '×' },
    aliases: { '〇': 'yes', '✕': 'no' },
    fallback: null,
  },
}

// どの形式の値(コード・移行前の日本語・別名)でも、コードにそろえる
function normalizeCode(kind, value) {
  var table = VALUE_CODES[kind]
  var v = value === null || value === undefined ? '' : String(value).trim()
  if (table.codes.indexOf(v) >= 0) return v
  for (var i = 0; i < table.codes.length; i++) {
    if (table.sheetLabels[table.codes[i]] === v) return table.codes[i]
  }
  if (Object.prototype.hasOwnProperty.call(table.aliases, v)) return table.aliases[v]
  return table.fallback === null ? v : table.fallback
}

// シートがコードの形式になっているか(移行の関数が VALUE_FORMAT=codes にする)
function isCodesFormat() {
  return requestProps().VALUE_FORMAT === 'codes'
}

// コードを、シートに書く形式にする(移行前は日本語。一覧に無い値はそのまま)
function sheetCode(kind, value) {
  var code = normalizeCode(kind, value)
  if (isCodesFormat()) return code
  var labels = VALUE_CODES[kind].sheetLabels
  return Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : code
}

// 通知の文面に出す表示名。lib/ohsumi/i18n の ja.ts・en.ts と同じ
// (一致することを lib/ohsumi/codes.test.ts で確かめる)
var NOTIFY_LABELS = {
  scheduleAnswer: {
    ja: { yes: '○', maybe: '△', no: '×' },
    en: { yes: '○', maybe: '△', no: '×' },
  },
}

function notifyLabel(kind, locale, value) {
  var code = normalizeCode(kind, value)
  var labels = NOTIFY_LABELS[kind][locale] || NOTIFY_LABELS[kind].ja
  return Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : code
}

// スキルのレベルアップの閾値で、既定値を表すキー(移行前は「デフォルト」)
var DEFAULT_THRESHOLD_KEY = '_default'
var LEGACY_DEFAULT_THRESHOLD_KEY = 'デフォルト'

function defaultSkillThreshold(thresholds) {
  thresholds = thresholds || {}
  return thresholds[DEFAULT_THRESHOLD_KEY] || thresholds[LEGACY_DEFAULT_THRESHOLD_KEY] || 100
}

// フロントの版。移行の後は、これより古い(または版の無い)リクエストを拒否する。
// 移行前のコードを読めない古いタブが、ステータスなどを誤って表示・保存するのを防ぐ
// (lib/ohsumi/codes.ts の CLIENT_VERSION と合わせる)
var MIN_CLIENT_VERSION = 1

function checkClientVersion(body) {
  if (!isCodesFormat()) return null
  var v = Number(body && body.clientVersion) || 0
  if (v >= MIN_CLIENT_VERSION) return null
  return 'Ohsumi が更新されました。ページを再読み込みしてください。'
}

// 変更の記録(history_json)のうち、値がコードになる項目
var HISTORY_CODE_FIELDS = {
  status: 'status', priority: 'priority', difficulty: 'difficulty',
  visibility: 'visibility', importance: 'importance', department: 'department',
}

function mapHistoryCodes(entry, convert) {
  var kind = entry && HISTORY_CODE_FIELDS[entry.field]
  if (!kind) return entry
  var out = {}
  Object.keys(entry).forEach(function (k) { out[k] = entry[k] })
  out.from = convert(kind, entry.from)
  out.to = convert(kind, entry.to)
  return out
}

function normalizeHistoryEntry(entry) { return mapHistoryCodes(entry, normalizeValue) }
function sheetHistoryEntry(entry) { return mapHistoryCodes(entry, sheetValue) }

function mapScheduleCodes(schedule, convert) {
  if (!schedule || typeof schedule !== 'object' || !schedule.responses) return schedule
  var out = {}
  Object.keys(schedule).forEach(function (k) { out[k] = schedule[k] })
  var responses = {}
  Object.keys(schedule.responses).forEach(function (memberId) {
    var answers = schedule.responses[memberId] || {}
    var converted = {}
    Object.keys(answers).forEach(function (candidateId) {
      converted[candidateId] = convert('scheduleAnswer', answers[candidateId])
    })
    responses[memberId] = converted
  })
  out.responses = responses
  return out
}

function mapOverrideCodes(overrides, convert) {
  if (!Array.isArray(overrides)) return overrides
  return overrides.map(function (ov) {
    if (!ov || ov.targetType !== 'department') return ov
    var out = {}
    Object.keys(ov).forEach(function (k) { out[k] = ov[k] })
    out.targetId = convert('department', ov.targetId)
    return out
  })
}

// テンプレート・定期タスクの中の department・difficulty・priority(・triggerOnStatus)
function mapTaskItemCodes(item, convert) {
  if (!item || typeof item !== 'object') return item
  var out = {}
  Object.keys(item).forEach(function (k) { out[k] = item[k] })
  if ('department' in item) out.department = convert('department', item.department)
  if ('difficulty' in item) out.difficulty = convert('difficulty', item.difficulty || 'beginner')
  if ('priority' in item) out.priority = convert('priority', item.priority || 'medium')
  if (item.triggerOnStatus) out.triggerOnStatus = convert('status', item.triggerOnStatus)
  return out
}

// Settings のうち、中に選択肢の値を持つ JSON を、シートに書く形式にする
// (updateSetting で使う。移行前は日本語、移行後はコード)
function sheetSettingValue(key, value) {
  if (CODE_SETTING_KEYS.indexOf(key) < 0 || typeof value !== 'string' || !value) return value
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return value }
  var convert = sheetValue
  var out = parsed
  if (key === 'project_templates' && parsed && typeof parsed === 'object') {
    out = {}
    Object.keys(parsed).forEach(function (name) {
      out[name] = Array.isArray(parsed[name]) ? parsed[name].map(function (it) { return mapTaskItemCodes(it, convert) }) : parsed[name]
    })
  } else if (key === 'task_set_templates' && Array.isArray(parsed)) {
    out = parsed.map(function (tpl) {
      if (!tpl || !Array.isArray(tpl.items)) return tpl
      var copy = {}
      Object.keys(tpl).forEach(function (k) { copy[k] = tpl[k] })
      copy.items = tpl.items.map(function (it) { return mapTaskItemCodes(it, convert) })
      return copy
    })
  } else if (key === 'recurring_rules' && Array.isArray(parsed)) {
    out = parsed.map(function (rule) { return mapTaskItemCodes(rule, convert) })
  } else if (key === 'skill_level_thresholds' && parsed && typeof parsed === 'object') {
    var fromKey = isCodesFormat() ? LEGACY_DEFAULT_THRESHOLD_KEY : DEFAULT_THRESHOLD_KEY
    var toKey = isCodesFormat() ? DEFAULT_THRESHOLD_KEY : LEGACY_DEFAULT_THRESHOLD_KEY
    out = {}
    Object.keys(parsed).forEach(function (k) {
      if (k === fromKey) { if (!(toKey in parsed)) out[toKey] = parsed[k] } else out[k] = parsed[k]
    })
  }
  return JSON.stringify(out)
}

// ---- 役職 ------------------------------------------------------------------------
//
// 役職は Settings の roles(JSON)に、上下関係の順(一般 → … → 最上位)で持つ。
//   { id, name, tier: 'top' | 'admin' | 'base', restricted?, sections?, requiredSkills? }
// 移行(VALUE_FORMAT=codes)の前は roles が無く、今までの設定(role_levels・
// restricted_roles・role_permissions・job_requirements)から組み立てる(ID は役職名)。
// 役職は ID でも名前でも引ける(findRole)ので、移行の途中でも判定は変わらない。
// lib/ohsumi/roles.ts と同じ内容(一致することを lib/ohsumi/roles.test.ts で確かめる)。

var TOP_ROLE_ID = 'top'
var BASE_ROLE_ID = 'base'
var DEFAULT_TOP_ROLE_NAME = '代表'
var DEFAULT_BASE_ROLE_NAME = '一般'
var DEFAULT_ROLE_LEVELS = ['班長', '事業責任者', '代表']
// 制限付きの管理者が、セクションを指定していない時に見られる管理画面(types.ts と同じ)
var DEFAULT_NON_TOP_SECTIONS = ['dashboard', 'approvals', 'assignments', 'projects', 'memberdb']
// Settings のうち役職の設定
var ROLE_SETTING_KEYS = ['roles', 'role_levels', 'restricted_roles', 'role_permissions', 'job_requirements']

function defaultRoles() {
  return [
    { id: BASE_ROLE_ID, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: 'r_manager', name: '事業責任者', tier: 'admin', restricted: false },
    { id: TOP_ROLE_ID, name: DEFAULT_TOP_ROLE_NAME, tier: 'top' },
  ]
}

function roleParseObject(value) {
  try {
    var parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (e) {
    return {}
  }
}

function roleStringArray(v) {
  return Array.isArray(v) ? v.map(String) : undefined
}

function rolesFromLegacy(settings) {
  var levels = splitCsvList(settings.role_levels)
  var names = (levels.length ? levels : DEFAULT_ROLE_LEVELS).filter(function (n) { return n !== DEFAULT_BASE_ROLE_NAME })
  if (names.indexOf(DEFAULT_TOP_ROLE_NAME) < 0) names.push(DEFAULT_TOP_ROLE_NAME)
  var restricted = splitCsvList(settings.restricted_roles)
  // restricted_roles にだけある役職も、今までどおり制限付きの管理者として扱う
  restricted.forEach(function (n) {
    if (names.indexOf(n) < 0 && n !== DEFAULT_BASE_ROLE_NAME && n !== DEFAULT_TOP_ROLE_NAME) names.splice(names.indexOf(DEFAULT_TOP_ROLE_NAME), 0, n)
  })
  var permissions = roleParseObject(settings.role_permissions)
  var requirements = roleParseObject(settings.job_requirements)
  var roles = [{ id: DEFAULT_BASE_ROLE_NAME, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' }]
  var baseSkills = roleStringArray(requirements[DEFAULT_BASE_ROLE_NAME])
  if (baseSkills) roles[0].requiredSkills = baseSkills
  var seen = {}
  names.forEach(function (name) {
    if (seen[name]) return
    seen[name] = true
    var role = { id: name, name: name, tier: name === DEFAULT_TOP_ROLE_NAME ? 'top' : 'admin' }
    if (role.tier === 'admin') role.restricted = restricted.indexOf(name) >= 0
    var sections = roleStringArray(permissions[name])
    if (sections) role.sections = sections
    var skills = roleStringArray(requirements[name])
    if (skills) role.requiredSkills = skills
    roles.push(role)
  })
  return roles
}

function parseRolesSetting(value) {
  if (!value) return null
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var roles = []
  for (var i = 0; i < parsed.length; i++) {
    var o = parsed[i]
    if (!o || typeof o !== 'object') return null
    var tier = o.tier
    if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name) return null
    if (tier !== 'top' && tier !== 'admin' && tier !== 'base') return null
    var role = { id: o.id, name: o.name, tier: tier }
    if (tier === 'admin') role.restricted = o.restricted === true
    var sections = roleStringArray(o.sections)
    if (sections) role.sections = sections
    var skills = roleStringArray(o.requiredSkills)
    if (skills) role.requiredSkills = skills
    roles.push(role)
  }
  return validateRoles(roles).length === 0 ? roles : null
}

function rolesFromSettings(settings) {
  return parseRolesSetting(settings.roles) || rolesFromLegacy(settings)
}

function validateRoles(roles) {
  var errors = []
  var ids = {}
  var names = {}
  roles.forEach(function (r) {
    if (ids[r.id]) errors.push('役職のIDが重複しています: ' + r.id)
    if (names[r.name]) errors.push('役職の名前が重複しています: ' + r.name)
    ids[r.id] = true
    names[r.name] = true
  })
  if (roles.filter(function (r) { return r.tier === 'base' }).length !== 1) errors.push('一般の役職はちょうど1つ必要です')
  if (roles.filter(function (r) { return r.tier === 'top' }).length < 1) errors.push('最上位の役職が1つ以上必要です')
  return errors
}

function findRole(roles, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v) return undefined
  for (var i = 0; i < roles.length; i++) if (roles[i].id === v) return roles[i]
  for (var j = 0; j < roles.length; j++) if (roles[j].name === v) return roles[j]
  return undefined
}

function roleTier(roles, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v) return 'base'
  var role = findRole(roles, v)
  return role ? role.tier : 'admin'
}

function isTopRoleRef(roles, ref) { return roleTier(roles, ref) === 'top' }
function isAdminRoleRef(roles, ref) { return roleTier(roles, ref) !== 'base' }

function isFullAdminRoleRef(roles, ref) {
  var tier = roleTier(roles, ref)
  if (tier === 'top') return true
  if (tier === 'base') return false
  var role = findRole(roles, ref)
  return !(role && role.restricted)
}

function sameRole(roles, a, b) {
  var x = String(a === null || a === undefined ? '' : a).trim()
  var y = String(b === null || b === undefined ? '' : b).trim()
  if (!x || !y) return false
  if (x === y) return true
  var rx = findRole(roles, x)
  var ry = findRole(roles, y)
  return !!rx && !!ry && rx.id === ry.id
}

function restrictedSections(roles, ref) {
  var role = findRole(roles, ref)
  return (role && role.sections) || DEFAULT_NON_TOP_SECTIONS
}

function rolesToLegacySettings(roles) {
  var nonBase = roles.filter(function (r) { return r.tier !== 'base' })
  var permissions = {}
  var requirements = {}
  roles.forEach(function (r) {
    if (r.sections) permissions[r.name] = r.sections
    if (r.requiredSkills) requirements[r.name] = r.requiredSkills
  })
  return {
    role_levels: nonBase.map(function (r) { return r.name }).join(','),
    restricted_roles: nonBase.filter(function (r) { return r.tier === 'admin' && r.restricted }).map(function (r) { return r.name }).join(','),
    role_permissions: JSON.stringify(permissions),
    job_requirements: JSON.stringify(requirements),
  }
}

// Settings の key → value(役職の設定だけ)。1回の読み込みで全部取る
function readRoleSettings() {
  var out = {}
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
  if (!sheet || sheet.getLastRow() < 2) return out
  var headers = headerRow(sheet)
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  if (keyCol === -1 || valueCol === -1) return out
  sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
    var key = String(r[keyCol])
    if (ROLE_SETTING_KEYS.indexOf(key) >= 0) out[key] = String(r[valueCol] || '')
  })
  return out
}

// このリクエストでの役職の一覧(1回だけ読む。役職の設定を変えたら invalidateRoles)
var _requestRoles = null
function getRoles() {
  if (!_requestRoles) {
    var settings = readRoleSettings()
    var parsed = parseRolesSetting(settings.roles)
    _requestRoles = { roles: parsed || rolesFromLegacy(settings), fromSetting: !!parsed }
  }
  return _requestRoles.roles
}
function invalidateRoles() { _requestRoles = null }

// Settings の roles を使っているか(移行の後・新しく導入した団体)。使っていなければ、
// 今までの設定から組み立てた役職(ID は役職名)
function hasRolesSetting() {
  getRoles()
  return _requestRoles.fromSetting
}

// メンバーの role 列に書く値。役職の ID(roles が無い間は、ID は役職名そのもの)
function sheetRoleRef(ref) {
  var role = findRole(getRoles(), ref)
  return role ? role.id : String(ref || '').trim()
}

// roles が無い団体の役職(ID は役職名)に、移行後と同じ ID を付ける。
// 一般 → base、代表 → top、ほかは新しい ID(メンバーの role 列の役職名は、名前で引けるのでそのままでよい)
function rolesWithCodeIds(roles) {
  return roles.map(function (r) {
    var copy = {}
    Object.keys(r).forEach(function (k) { copy[k] = r[k] })
    if (r.tier === 'base') copy.id = BASE_ROLE_ID
    else if (r.name === DEFAULT_TOP_ROLE_NAME) copy.id = TOP_ROLE_ID
    else copy.id = newRoleId()
    return copy
  })
}

function newRoleId() {
  return 'r_' + Math.random().toString(36).slice(2, 8)
}

// ---- 部門 ----------------------------------------------------------------------
//
// Settings の departments(JSON)に [{ id, name, archived? }]。未設定なら既定の7部門。未分類は空。
// タスクなどの部門の値は、移行(VALUE_FORMAT=codes)の前は部門名、後は部門 ID。ID でも名前でも引ける。
// lib/ohsumi/departments.ts と同じ内容(一致することを lib/ohsumi/departments.test.ts で確かめる)。

var UNCATEGORIZED_NAME = '未分類'

function defaultDepartments() {
  return VALUE_CODES.department.codes.filter(function (c) { return c !== '' }).map(function (id) {
    return { id: id, name: VALUE_CODES.department.sheetLabels[id] }
  })
}

function validateDepartments(list) {
  var errors = []
  var ids = {}
  var names = {}
  list.forEach(function (d) {
    if (!d.id || !d.name) errors.push('部門の ID と名前は空にできません')
    if (d.name === UNCATEGORIZED_NAME) errors.push('「未分類」は部門の名前に使えません')
    if (ids[d.id]) errors.push('部門の ID が重複しています: ' + d.id)
    if (names[d.name]) errors.push('部門の名前が重複しています: ' + d.name)
    ids[d.id] = true
    names[d.name] = true
  })
  return errors
}

function parseDepartmentsSetting(value) {
  if (!value) return null
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var list = []
  for (var i = 0; i < parsed.length; i++) {
    var o = parsed[i]
    if (!o || typeof o !== 'object') return null
    if (typeof o.id !== 'string' || typeof o.name !== 'string') return null
    var dept = { id: o.id, name: o.name }
    if (o.archived === true) dept.archived = true
    list.push(dept)
  }
  return validateDepartments(list).length === 0 ? list : null
}

function departmentsFromSettings(settings) {
  return parseDepartmentsSetting(settings.departments) || defaultDepartments()
}

function findDepartment(list, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v || v === UNCATEGORIZED_NAME) return undefined
  var i
  for (i = 0; i < list.length; i++) if (list[i].id === v) return list[i]
  for (i = 0; i < list.length; i++) if (list[i].name === v) return list[i]
  var labels = VALUE_CODES.department.sheetLabels
  var ids = Object.keys(labels)
  for (i = 0; i < ids.length; i++) {
    if (ids[i] && labels[ids[i]] === v) {
      for (var j = 0; j < list.length; j++) if (list[j].id === ids[i]) return list[j]
      return undefined
    }
  }
  return undefined
}

function normalizeDepartment(list, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v || v === UNCATEGORIZED_NAME) return ''
  var dept = findDepartment(list, v)
  return dept ? dept.id : v
}

function sheetDepartmentRef(list, ref, codes) {
  var id = normalizeDepartment(list, ref)
  if (!id) return codes ? '' : UNCATEGORIZED_NAME
  var dept = findDepartment(list, id)
  if (!dept) return id
  return codes ? dept.id : dept.name
}

function departmentNameOf(list, ref) {
  var id = normalizeDepartment(list, ref)
  if (!id) return UNCATEGORIZED_NAME
  var dept = findDepartment(list, id)
  return dept ? dept.name : id
}

// このリクエストでの部門の一覧(1回だけ読む。シートが無い時は既定)
var _requestDepartments = null
function getDepartments() {
  if (!_requestDepartments) {
    var raw = ''
    var fromSetting = false
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
      if (sheet && sheet.getLastRow() > 1) {
        var headers = headerRow(sheet)
        var keyCol = headers.indexOf('key')
        var valueCol = headers.indexOf('value')
        sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
          if (String(r[keyCol]) === 'departments') raw = String(r[valueCol] || '')
        })
      }
    } catch (e) {
      // シートを読めない(テストなど)時は既定の部門
    }
    var parsed = parseDepartmentsSetting(raw)
    fromSetting = !!parsed
    _requestDepartments = { list: parsed || defaultDepartments(), fromSetting: fromSetting }
  }
  return _requestDepartments.list
}
function invalidateDepartments() { _requestDepartments = null }

// 選択肢の値を読む時・書く時の変換(部門だけは部門の一覧を使う)
function normalizeValue(kind, value) {
  return kind === 'department' ? normalizeDepartment(getDepartments(), value) : normalizeCode(kind, value)
}
function sheetValue(kind, value) {
  return kind === 'department' ? sheetDepartmentRef(getDepartments(), value, isCodesFormat()) : sheetCode(kind, value)
}

function newDepartmentId() {
  return 'd_' + Math.random().toString(36).slice(2, 8)
}

// ---- 部門の編集(updateDepartments・deleteDepartment・moveDepartmentTasks) ---------

function writeDepartments(list) {
  updateSetting('departments', JSON.stringify(list))
  invalidateDepartments()
}

// 部門の一覧を保存する(追加・名前・並び順・アーカイブの解除)。削除は deleteDepartment
function updateDepartments(newList) {
  if (!Array.isArray(newList)) throw userError('部門の一覧の形式が正しくありません。')
  var parsed = parseDepartmentsSetting(JSON.stringify(newList))
  if (!parsed) throw userError('部門の一覧が正しくありません: ' + validateDepartments(newList.filter(Boolean)).join(' / '))
  var current = getDepartments()
  var byId = {}
  current.forEach(function (d) { byId[d.id] = d })
  var newIds = {}
  parsed.forEach(function (d) { newIds[d.id] = true })
  current.forEach(function (d) {
    if (!newIds[d.id]) throw userError('部門「' + d.name + '」を消すには、部門の削除を使ってください。')
  })
  if (!isCodesFormat()) {
    parsed.forEach(function (d) {
      // 移行前はタスクの部門を部門名で持つため、名前を変えると引けなくなる
      if (byId[d.id] && byId[d.id].name !== d.name) throw userError('部門の名前の変更は、内部コードへの移行の後にできるようになります。')
    })
  }
  writeDepartments(parsed)
  return { departments: parsed }
}

// 部門が使われている数(タスク・テンプレート・定期タスク・権限の例外)
function departmentUsage(deptId) {
  var list = getDepartments()
  var usage = { tasks: 0, settings: 0, overrides: 0 }
  var tasks = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS)
  if (tasks && tasks.getLastRow() > 1) {
    var h = headerRow(tasks)
    var col = h.indexOf('department')
    if (col >= 0) {
      tasks.getRange(2, col + 1, tasks.getLastRow() - 1, 1).getValues().forEach(function (r) {
        if (normalizeDepartment(list, r[0]) === deptId) usage.tasks++
      })
    }
  }
  ;['project_templates', 'task_set_templates', 'recurring_rules'].forEach(function (key) {
    var raw = getSettingValue(key)
    if (!raw) return
    var found = 0
    JSON.stringify(parseJsonOr(raw, null), function (k, v) {
      if (k === 'department' && normalizeDepartment(list, v) === deptId) found++
      return v
    })
    usage.settings += found
  })
  var members = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MEMBERS)
  if (members && members.getLastRow() > 1) {
    var mh = headerRow(members)
    var ocol = mh.indexOf('permission_overrides_json')
    if (ocol >= 0) {
      members.getRange(2, ocol + 1, members.getLastRow() - 1, 1).getValues().forEach(function (r) {
        parseJsonOr(r[0], []).forEach(function (ov) {
          if (ov && ov.targetType === 'department' && normalizeDepartment(list, ov.targetId) === deptId) usage.overrides++
        })
      })
    }
  }
  return usage
}

// 部門を削除する。使われていればアーカイブ(archived)にし、どこでも使われていなければ一覧から消す
function deleteDepartment(deptId) {
  var list = getDepartments()
  var dept = findDepartment(list, deptId)
  if (!dept) throw userError('部門が見つかりません: ' + deptId)
  var usage = departmentUsage(dept.id)
  var used = usage.tasks + usage.settings + usage.overrides > 0
  var next = used
    ? list.map(function (d) { return d.id === dept.id ? { id: d.id, name: d.name, archived: true } : d })
    : list.filter(function (d) { return d.id !== dept.id })
  writeDepartments(next)
  return { departments: next, archived: used, usage: usage }
}

// ある部門のタスクを、別の部門(空は未分類)へ移す。返り値は移したタスクの数
function moveDepartmentTasks(fromId, toId) {
  var list = getDepartments()
  var from = findDepartment(list, fromId)
  if (!from) throw userError('部門が見つかりません: ' + fromId)
  if (toId && !findDepartment(list, toId)) throw userError('移す先の部門が見つかりません: ' + toId)
  var sheet = getSheet(SHEET_TASKS)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var col = headers.indexOf('department')
  if (col < 0 || sheet.getLastRow() < 2) return { moved: 0 }
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var value = sheetDepartmentRef(list, toId || '', isCodesFormat())
  var moved = 0
  rows.forEach(function (r) {
    if (normalizeDepartment(list, r[col]) !== from.id) return
    updateTaskFields(String(r[idCol]), { department: value })
    moved++
  })
  return { moved: moved }
}

// ---- 役職の編集(updateRoles・deleteRole)と、最上位の締め出しの防止 ----------------

function baseRoleRef() {
  var roles = getRoles()
  for (var i = 0; i < roles.length; i++) if (roles[i].tier === 'base') return roles[i].id
  return DEFAULT_BASE_ROLE_NAME
}

// 一覧に無い役職は受け付けない(役職の付け間違いで管理者扱いにならないように)
function requireKnownRole(ref) {
  var role = findRole(getRoles(), ref)
  if (!role) throw userError('役職が見つかりません: ' + ref)
  return role
}

// 変更の後に、最上位の役職を持つ有効な(休止中でない)メンバーが1人以上残るか確かめる。
// change: { roles?: 変更後の役職の一覧, members?: { メンバーID: { role?, inactive?, removed? } } }
function assertTopRemains(change) {
  var roles = change.roles || getRoles()
  var overrides = change.members || {}
  var sheet = getSheet(SHEET_MEMBERS)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var inactiveCol = headers.indexOf('inactive')
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
  var count = 0
  rows.forEach(function (r) {
    var o = overrides[String(r[idCol])] || {}
    if (o.removed) return
    var inactive = o.inactive !== undefined ? o.inactive : String(inactiveCol >= 0 ? r[inactiveCol] : '').trim().toUpperCase() === 'TRUE'
    if (inactive) return
    var role = o.role !== undefined ? o.role : r[roleCol]
    if (isTopRoleRef(roles, role)) count++
  })
  if (count === 0) {
    throw userError('最上位の役職を持つ有効なメンバーが0人になるため、この操作はできません。先に別のメンバーを最上位の役職にしてください。')
  }
}

// 役職の一覧を保存する(並び順・種類・制限・セクション・必要スキル・名前)。
// 役職の削除は deleteRole で行う(使っているメンバーを移す必要があるため)。
// 全権管理者が行える。最上位の役職にかかわる変更は、最上位の役職を持つ人だけ
function updateRoles(acting, newRoles) {
  if (!Array.isArray(newRoles)) throw userError('役職の一覧の形式が正しくありません。')
  var parsed = parseRolesSetting(JSON.stringify(newRoles))
  if (!parsed) throw userError('役職の一覧が正しくありません: ' + validateRoles(newRoles.filter(Boolean)).join(' / '))
  var current = getRoles()
  var byId = {}
  current.forEach(function (r) { byId[r.id] = r })
  var newIds = {}
  parsed.forEach(function (r) { newIds[r.id] = true })
  current.forEach(function (r) {
    if (!newIds[r.id]) throw userError('役職「' + r.name + '」を消すには、役職の削除を使ってください。')
  })
  var topOf = function (list) { return list.filter(function (r) { return r.tier === 'top' }).map(function (r) { return r.id }).sort().join(',') }
  if (topOf(current) !== topOf(parsed) && !isTopRoleRef(current, acting.role)) {
    throw userError('最上位の役職にかかわる変更は、最上位の役職を持つメンバーだけが行えます。')
  }
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.tier === 'base' && r.tier !== 'base') throw userError('一般の役職の種類は変えられません。')
    if (before && before.tier !== 'base' && r.tier === 'base') throw userError('一般の役職は1つだけです。')
    if (!hasRolesSetting()) {
      // 移行の前は役職名が ID を兼ねるため、名前の変更と、代表以外の最上位の役職は作れない
      if (r.name !== r.id) throw userError('役職の名前の変更は、内部コードへの移行の後にできるようになります。')
      if (r.tier === 'top' && r.name !== DEFAULT_TOP_ROLE_NAME) throw userError('代表以外の最上位の役職は、内部コードへの移行の後に作れるようになります。')
    }
  })
  assertTopRemains({ roles: parsed })
  // 名前を変えた役職を、古い名前のまま持っているメンバー(移行の漏れなど)は、役職の ID にそろえる
  // (名前を変えると、古い名前ではもう引けないため)
  var renamed = {}
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.name !== r.name) renamed[before.name] = r.id
  })
  if (Object.keys(renamed).length) {
    var sheet = getSheet(SHEET_MEMBERS)
    var headers = headerRow(sheet)
    var idCol = headers.indexOf('id')
    var roleCol = headers.indexOf('role')
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
    rows.forEach(function (r) {
      var name = String(r[roleCol] || '').trim()
      if (Object.prototype.hasOwnProperty.call(renamed, name)) updateMemberFields(String(r[idCol]), { role: renamed[name] })
    })
  }
  writeRoles(parsed)
  return { roles: parsed }
}

// 役職を削除する。使っているメンバー(休止中を含む)は moveToRoleId の役職に移す。
// 最上位(top)・一般の役職は削除できない。メンバーを移す場合は最上位の役職を持つ人だけ
function deleteRole(acting, roleId, moveToRoleId) {
  var roles = getRoles()
  var target = requireKnownRole(roleId)
  if (target.tier === 'base' || target.id === TOP_ROLE_ID || (!hasRolesSetting() && target.name === DEFAULT_TOP_ROLE_NAME)) {
    throw userError('この役職は削除できません: ' + target.name)
  }
  var sheet = getSheet(SHEET_MEMBERS)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
  var holders = rows.filter(function (r) { return sameRole(roles, r[roleCol], target.id) }).map(function (r) { return String(r[idCol]) })
  var moveTo = null
  if (holders.length > 0) {
    if (!isTopRoleRef(roles, acting.role)) throw userError('メンバーのいる役職を削除する(メンバーを別の役職に移す)のは、最上位の役職を持つメンバーだけが行えます。')
    moveTo = requireKnownRole(moveToRoleId)
    if (moveTo.id === target.id) throw userError('移す先の役職が、削除する役職と同じです。')
  }
  var remaining = roles.filter(function (r) { return r.id !== target.id })
  var memberChanges = {}
  holders.forEach(function (id) { memberChanges[id] = { role: moveTo.id } })
  assertTopRemains({ roles: remaining, members: memberChanges })
  holders.forEach(function (id) {
    updateMemberFields(id, { role: moveTo.id })
  })
  writeRoles(remaining)
  return { roles: remaining, moved: holders.length }
}

// 役職の一覧を、今の保存先に書く(roles が無い間は今までの設定、ある時は roles)
function writeRoles(roles) {
  if (hasRolesSetting()) {
    updateSetting('roles', JSON.stringify(roles))
  } else {
    var legacy = rolesToLegacySettings(roles)
    Object.keys(legacy).forEach(function (key) { updateSetting(key, legacy[key]) })
  }
  invalidateRoles()
}

// ---- 初期セットアップ --------------------------------------------------------
//
// GASエディタ上部の関数ドロップダウンで "setupOhsumi" を選び、▶ 実行 を押す。
// これ一回で:
//   1. 全サービスの権限ダイアログをまとめて通す (Drive / Mail / Calendar / 等)
//   2. Members / Projects / Tasks / Settings の各シートに不足しているヘッダー列を
//      自動追加する（既存データは一切変更しない）
//   3. 画像アップロード用のDriveフォルダがなければ作成し、IDをスクリプト
//      プロパティに保存する（既にあれば何もしない）
//   4. 実行結果をエディタ下部のログに出力する
//
// デプロイ後に一度だけ実行すればOK。再実行しても重複は起きない。

// コードで書く団体(VALUE_FORMAT=codes)で役職の設定(roles)がまだ無ければ作る。
// 今までの役職の設定があればそれを元に、無ければ既定の役職で作る
function setupRolesSetting() {
  if (!isCodesFormat()) return 'legacy'
  invalidateRoles()
  if (hasRolesSetting()) return 'already'
  var legacy = readRoleSettings()
  var hasLegacy = ['role_levels', 'restricted_roles', 'role_permissions', 'job_requirements'].some(function (k) { return !!legacy[k] })
  var roles = hasLegacy ? rolesWithCodeIds(getRoles()) : defaultRoles()
  updateSetting('roles', JSON.stringify(roles))
  invalidateRoles()
  console.log('🆕 役職の設定(roles)を作成しました: ' + roles.map(function (r) { return r.name }).join('・'))
  return 'created'
}

// Settings のうち、中に選択肢の値を持つキー(sheetSettingValue で形式を変えるもの)
var CODE_SETTING_KEYS = ['project_templates', 'task_set_templates', 'recurring_rules', 'skill_level_thresholds']

// 選択肢の値を持ちうるデータがあるシートの名前の一覧。Settings は、setupOhsumi が
// 作る初期キー(団体名など)を除き、CODE_SETTING_KEYS に値がある場合だけ数える
function sheetsWithData(ss) {
  var found = []
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet || sheet.getLastRow() < 2) return
    if (name !== SHEET_SETTINGS) { found.push(name); return }
    var headers = headerRow(sheet)
    var keyCol = headers.indexOf('key')
    var valueCol = headers.indexOf('value')
    if (keyCol === -1 || valueCol === -1) return
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    var hasCodeSetting = rows.some(function (r) {
      return CODE_SETTING_KEYS.indexOf(String(r[keyCol])) >= 0 && String(r[valueCol] || '').trim() !== ''
    })
    if (hasCodeSetting) found.push(name)
  })
  return found
}

// 新しく導入する団体(データ行が1行も無い)では VALUE_FORMAT を codes にして、
// 最初からコードで書く。データが既にある場合は変えない(日本語のまま書き、
// 移行の関数で移行する)。既に codes の場合もそのまま。
// 返り値: 'already'(既に codes)/ 'set'(codes にした)/ 'hasData'(変えなかった)
function setupValueFormat(ss) {
  var props = PropertiesService.getScriptProperties()
  if (props.getProperty('VALUE_FORMAT') === 'codes') {
    console.log('✅ 選択肢の値の形式: コード(VALUE_FORMAT=codes)')
    return 'already'
  }
  var withData = sheetsWithData(ss)
  if (withData.length === 0) {
    setRequestProp('VALUE_FORMAT', 'codes')
    console.log('🆕 データが無いため、選択肢の値を最初からコードで書き込みます(VALUE_FORMAT=codes に設定しました)')
    return 'set'
  }
  console.log(
    'ℹ️ 選択肢の値の形式: 日本語のまま書き込みます(既にデータがあるシート: ' + withData.join('・') + ')。' +
      'VALUE_FORMAT は変えていません。内部コードへの移行は、移行の関数 migrateToInternalCodes() で行ってください(gas/README.md の「内部コードへの移行」)。' +
      'VALUE_FORMAT を手で設定しないでください',
  )
  return 'hasData'
}

function setupOhsumi() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  console.log('📋 スプレッドシート: ' + ss.getName())

  // --- 権限の事前取得 ---
  try { DriveApp.getRootFolder(); console.log('✅ DriveApp') }
  catch (e) { console.error('❌ DriveApp: ' + e) }

  try { console.log('✅ MailApp (残り送信数: ' + MailApp.getRemainingDailyQuota() + ')') }
  catch (e) { console.error('❌ MailApp: ' + e) }

  try { console.log('✅ CalendarApp: ' + CalendarApp.getDefaultCalendar().getName()) }
  catch (e) { console.error('❌ CalendarApp: ' + e) }

  try {
    UrlFetchApp.fetch('https://www.google.com', { method: 'get', muteHttpExceptions: true })
    console.log('✅ UrlFetchApp')
  } catch (e) { console.error('❌ UrlFetchApp: ' + e) }

  try { console.log('✅ ScriptApp (トリガー数: ' + ScriptApp.getProjectTriggers().length + ')') }
  catch (e) { console.error('❌ ScriptApp: ' + e) }

  try { PropertiesService.getScriptProperties().getProperties(); console.log('✅ PropertiesService') }
  catch (e) { console.error('❌ PropertiesService: ' + e) }

  // --- ヘッダー行の確認・追加 ---

  // すべてのシート(SHEET_HEADERS)を作成し、不足している列を追加する。
  // MemberEmailsは新規作成した場合デフォルトで非公開(「ウェブに公開」未設定)
  // なので、ここで作成するだけでMembersのemail列を分離した効果が出る。
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    ensureSheetHeaders(ss, name, SHEET_HEADERS[name])
  })
  bumpMemberEmailsVersion()

  // --- 選択肢の値の形式(新しく導入する団体は最初からコードで書く)---
  setupValueFormat(ss)
  setupRolesSetting()

  // --- ログイン(セッション)の団体ID・秘密鍵(無ければ作る。既にあれば変えない)---
  var createdSecrets = ensureSessionSecrets()
  console.log(createdSecrets.length
    ? '🔑 ログイン用の設定を作成しました: ' + createdSecrets.join(', ')
    : '✅ ログイン用の設定(ORG_ID・秘密鍵)は作成済みです')

  // --- Settings の初期キーを確保（上書きはしない）---
  var DEFAULT_SETTINGS = [
    ['org_name', ''],
    ['org_logo_url', ''],
  ]
  var settingsSheet = ss.getSheetByName(SHEET_SETTINGS)
  var settingsData = settingsSheet.getLastRow() > 1
    ? settingsSheet.getRange(2, 1, settingsSheet.getLastRow() - 1, 1).getValues().map(function(r){ return String(r[0]) })
    : []
  DEFAULT_SETTINGS.forEach(function(pair) {
    if (settingsData.indexOf(pair[0]) === -1) {
      appendRowByHeaders(settingsSheet, SHEET_SETTINGS, { key: pair[0], value: pair[1] })
      console.log('➕ Settings 初期キー追加: ' + pair[0])
    }
  })

  // --- バッチ通知トリガーの設定 ---
  try {
    var triggers = ScriptApp.getProjectTriggers()
    var hasBatch = triggers.some(function(t) { return t.getHandlerFunction() === 'sendBatchNotifications' })
    if (!hasBatch) {
      ScriptApp.newTrigger('sendBatchNotifications')
        .timeBased()
        .everyHours(1)
        .create()
      console.log('✅ sendBatchNotifications トリガー作成')
    } else {
      console.log('✅ sendBatchNotifications トリガー既存')
    }
  } catch (e) { console.error('❌ トリガー設定: ' + e) }

  // F4(レビュー再確認対応): シートを作り直したり列を追加したりした際、
  // 点検関数(protectAllExistingRows/auditFormulaInjectionRisks)の手動
  // 実行を忘れても既存行が保護されるよう、setupOhsumi()の実行時にも
  // 既存の全行の保護対象列を書式なしテキストにしておく(値は変更しない)。
  protectAllExistingRows()

  // --- スプレッドシートの手動編集で読み取りキャッシュを無効にするトリガー ---
  try {
    var changeTriggers = ScriptApp.getProjectTriggers()
    var hasChange = changeTriggers.some(function(t) { return t.getHandlerFunction() === 'onSpreadsheetChange' })
    if (!hasChange) {
      ScriptApp.newTrigger('onSpreadsheetChange').forSpreadsheet(ss).onChange().create()
      console.log('✅ onSpreadsheetChange トリガー作成')
    } else {
      console.log('✅ onSpreadsheetChange トリガー既存')
    }
  } catch (e) { console.error('❌ 変更検知トリガー設定: ' + e) }
  bumpDataVersion()

  // --- 画像アップロード用フォルダ ---
  try { ensureUploadFolder() }
  catch (e) { console.error('❌ アップロード用フォルダ: ' + e) }

  console.log('🚀 setupOhsumi 完了')
}

// ---- 画像アップロード用フォルダ ------------------------------------------------
//
// プロフィール画像・団体ロゴ・経費の領収書・アンケート設問の画像の保存先。
// フォルダIDはスクリプトプロパティにだけ持ち、リクエストで渡されたフォルダIDは
// 使わない（任意のフォルダへの書き込みを防ぐため）。

var UPLOAD_FOLDER_PROPERTY_KEY = 'UPLOAD_FOLDER_ID'
// 移行前のファイルがあるフォルダ(カンマ区切りで複数可)。getFiles はこれらの
// フォルダ内のファイルも返す(将来、FSIFの本番を移行するときに旧フォルダの
// 画像を表示するため)。スクリプトプロパティに手動で設定する。
var LEGACY_UPLOAD_FOLDERS_PROPERTY_KEY = 'LEGACY_UPLOAD_FOLDER_IDS'
// 'true' のとき、新しくアップロードしたファイルを非公開のままにする。
// makeUploadsPrivate() の実行時に 'true' になる(段階③)。それまでは、公開CSV
// 時代のフロントでも表示できるよう「リンクを知っている全員が閲覧可」にする。
var UPLOADS_PRIVATE_PROPERTY_KEY = 'UPLOADS_PRIVATE'
var UPLOAD_FOLDER_NAME = 'Ohsumi uploads'

// スクリプトプロパティにフォルダIDがなければ、スクリプトを実行している
// アカウントのDriveにフォルダを作成してIDを保存する。既にあれば何もしない。
function ensureUploadFolder() {
  var props = PropertiesService.getScriptProperties()
  var existingId = props.getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (existingId) {
    console.log('✅ アップロード用フォルダ既存: ' + existingId)
    return existingId
  }
  var folder = DriveApp.createFolder(UPLOAD_FOLDER_NAME)
  props.setProperty(UPLOAD_FOLDER_PROPERTY_KEY, folder.getId())
  console.log('✅ アップロード用フォルダ作成: ' + folder.getName() + ' (' + folder.getId() + ')')
  return folder.getId()
}

function applyUploadSharing(file) {
  if (PropertiesService.getScriptProperties().getProperty(UPLOADS_PRIVATE_PROPERTY_KEY) === 'true') return
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
}

// 領収書の種類とサイズの確認(フロントの expense-application-modal.tsx と同じ基準)。
// ブラウザによっては HEIC の種類が空で届くため、拡張子でも判定する。
var RECEIPT_MAX_BYTES = 5 * 1024 * 1024
var RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
var RECEIPT_EXTENSION_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
}
function validateReceiptFile(mimeType, filename, byteLength) {
  if (byteLength > RECEIPT_MAX_BYTES) throw userError('領収書のファイルサイズは5MBまでです。')
  var mime = String(mimeType || '').toLowerCase()
  if (RECEIPT_MIME_TYPES.indexOf(mime) >= 0) return mime
  var ext = String(filename || '').toLowerCase().split('.').pop()
  var byExt = RECEIPT_EXTENSION_MIME[ext]
  if (byExt && (!mime || mime === 'application/octet-stream')) return byExt
  throw userError('領収書は画像(JPEG・PNG・HEICなど)またはPDFのみアップロードできます。')
}

function getUploadFolder() {
  var folderId = PropertiesService.getScriptProperties().getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (!folderId) throw userError('Drive folder is not configured. Run setupOhsumi() in the Apps Script editor.')
  return DriveApp.getFolderById(folderId)
}

// シートが存在しなければ作成し、不足しているヘッダー列を末尾に追加する。
// 既存のデータ行や既存の列は一切変更しない。
function ensureSheetHeaders(ss, sheetName, requiredHeaders) {
  var sheet = ss.getSheetByName(sheetName)
  if (!sheet) {
    sheet = ss.insertSheet(sheetName)
    sheet.appendRow(requiredHeaders)
    console.log('📄 シート作成: ' + sheetName + ' (' + requiredHeaders.length + ' 列)')
    return
  }

  var lastCol = sheet.getLastColumn()
  var existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim() })
    : []

  var missing = requiredHeaders.filter(function (h) { return existing.indexOf(h) === -1 })
  if (missing.length === 0) {
    console.log('✅ ' + sheetName + ': ヘッダー問題なし (' + existing.length + ' 列)')
    return
  }

  // 不足列を1行目の末尾に追加（既存データ行は空欄のままで問題ない）
  var startCol = lastCol + 1
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing])
  console.log('➕ ' + sheetName + ': ' + missing.length + ' 列追加 — ' + missing.join(', '))
}

// 行を末尾に追加する。値は {列名: 値} で渡し、シートの実際の列の順番に合わせて並べる
// (列の順番を前提にした配列で追加すると、列が足された古いシートでずれるため)。
// 一覧(SHEET_HEADERS)に無い列名は、書き込み先が無いのでエラーにする。
function appendRowByHeaders(sheet, sheetName, obj) {
  var headers = headerRow(sheet)
  var unknown = Object.keys(obj).filter(function (k) { return headers.indexOf(k) === -1 })
  if (unknown.length) {
    throw userError(sheetName + 'シートに列が見つかりません: ' + unknown.join(', ') +
      '。Apps Scriptエディタで setupOhsumi() を実行してヘッダー列を追加してください。')
  }
  protectRowFromFormulaInjection(sheet, headers, sheet.getLastRow() + 1, sheetName)
  sheet.appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : '' }))
}

// A member is completing a certain number of same-category tasks and
// auto-certifying isn't something this file does — that check runs
// client-side (lib/ohsumi/store.tsx) since it only needs data already in
// hand. This file only handles writes coming from the browser.

function doGet(e) {
  return ContentService.createTextOutput('Ohsumi GAS endpoint is up.').setMimeType(
    ContentService.MimeType.TEXT,
  )
}

// ---- Authentication & Authorization ----------------------------------------

// メンバーIDから、操作するメンバーの { id, role, project_ids, permission_overrides } を返す
// (セッショントークンのメンバーID)
function getActingMemberById(memberId) {
  memberId = String(memberId)
  var sheet = getSheet(SHEET_MEMBERS)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var projectIdsCol = headers.indexOf('project_ids')
  var overridesCol = headers.indexOf('permission_overrides_json')
  if (idCol < 0) throw userError('Membersシートの構造が不正です。')
  var data = sheet.getDataRange().getValues()
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === memberId) {
      var overrides = []
      if (overridesCol >= 0) {
        try { overrides = JSON.parse(data[i][overridesCol] || '[]') } catch (_) {}
      }
      return {
        id: String(data[i][idCol]),
        role: String(data[i][roleCol] || ''),
        project_ids: String(data[i][projectIdsCol] || '').split(',').map(function (s) { return s.trim() }).filter(Boolean),
        permission_overrides: Array.isArray(overrides) ? overrides : [],
      }
    }
  }
  // MemberEmails側には行があるがMembers側に対応する行が無い(データ不整合) —
  // 通常起こらないはずだが、安全側に倒して「見つからない」として扱う
  throw userError('メンバー登録が見つかりません。管理者にお問い合わせください。')
}

// ---- ログイン(IDトークン)とセッショントークン ----------------------------------
//
// ログインの流れ:
//   1. フロントが getLoginConfig で団体ID(ORG_ID)を取得する(認証不要)
//   2. フロントは乱数 r を作り、nonce = ORG_ID + "." + base64url(SHA-256(r)) で
//      Google Identity Services(google.accounts.id)の IDトークンを受け取る
//   3. exchangeIdToken で IDトークンと r を送る。ここで tokeninfo により署名・
//      有効期限を確認し、aud(クライアントID)・iss・email_verified・nonce を確かめる
//      (nonce は1回だけ使える)。登録済みのメンバーなら、この団体の秘密鍵で署名した
//      セッショントークンを発行する
//   4. 以降のリクエストはセッショントークンだけで認証する(Google への問い合わせなし)
//
// セッショントークン: "v1.<payload(base64url JSON)>.<HMAC-SHA256(base64url)>"
//   payload = { org, sub(メンバーID), gen(世代番号), kid(鍵ID), sid, iat, exp, auth(ログイン時刻), rem }
//   別の団体のトークン(org・鍵が違う)、改ざん、有効期限切れ、SESSION_NOT_BEFORE より前に
//   発行されたもの、世代番号が古いもの(全端末でログアウト済み)は受け付けない。
//
// スクリプトプロパティ(1回のリクエストで getProperties() を1回だけ読む — requestProps 参照):
//   ORG_ID / SESSION_SIGNING_KEY / SESSION_KEY_ID  setupOhsumi() が作成する
//   SESSION_NOT_BEFORE   これより前(秒)に発行されたセッションを無効にする
//   SESSION_GEN_<メンバーID>  メンバーごとの世代番号(全端末でログアウトで1増える)

var SESSION_TOKEN_VERSION = 'v1'
// チェックあり(この端末に保存): 1回14日、Googleでのログインから最長30日
var SESSION_TTL_REMEMBER_SEC = 14 * 24 * 3600
var SESSION_MAX_REMEMBER_SEC = 30 * 24 * 3600
// チェックなし: 12時間(延長しない)
var SESSION_TTL_TEMP_SEC = 12 * 3600
// 使用済みの nonce を覚えておく時間(IDトークンの有効期間と同じ1時間)
var ID_TOKEN_NONCE_TTL_SEC = 3600
var SESSION_GEN_PREFIX = 'SESSION_GEN_'

// 1回のリクエスト(実行)の間は、スクリプトプロパティを getProperties() で1回だけ読み、
// その結果を使う(読み取り回数の上限対策)。この実行の中で書き込んだ値は setRequestProp で
// 反映する。doPost の最初に resetRequestProps() で読み直す。
var _requestProps = null

function resetRequestProps() {
  _requestProps = null
  _requestRoles = null
  _requestDepartments = null
}

function requestProps() {
  if (!_requestProps) _requestProps = PropertiesService.getScriptProperties().getProperties() || {}
  return _requestProps
}

function setRequestProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value)
  if (_requestProps) _requestProps[key] = value
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function base64UrlEncode(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '')
}

function base64UrlDecodeToString(text) {
  var s = String(text)
  while (s.length % 4) s += '='
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8')
}

function sha256Base64Url(text) {
  return base64UrlEncode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8))
}

// 推測できない値を作る(Utilities.getUuid を複数と時刻を SHA-256 でまとめる)
function generateSecret() {
  var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now())].join(':')
  return base64UrlEncode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8))
}

// 長さの違いも含めて、比較にかかる時間が内容で変わらないように比べる
function constantTimeEquals(a, b) {
  a = String(a)
  b = String(b)
  var diff = a.length ^ b.length
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0)
  }
  return diff === 0
}

// ORG_ID・秘密鍵・鍵IDが無ければ作る(setupOhsumi から呼ぶ)。既にあれば変えない
function ensureSessionSecrets() {
  var props = PropertiesService.getScriptProperties()
  var created = []
  if (!props.getProperty('ORG_ID')) {
    props.setProperty('ORG_ID', 'org_' + generateSecret().slice(0, 20))
    created.push('ORG_ID')
  }
  if (!props.getProperty('SESSION_SIGNING_KEY') || !props.getProperty('SESSION_KEY_ID')) {
    props.setProperty('SESSION_SIGNING_KEY', generateSecret())
    props.setProperty('SESSION_KEY_ID', generateSecret().slice(0, 8))
    created.push('SESSION_SIGNING_KEY', 'SESSION_KEY_ID')
  }
  resetRequestProps()
  return created
}

function signSessionPayload(payloadB64, key) {
  return base64UrlEncode(Utilities.computeHmacSha256Signature(SESSION_TOKEN_VERSION + '.' + payloadB64, key))
}

function sessionGeneration(memberId) {
  return Number(requestProps()[SESSION_GEN_PREFIX + memberId] || 0)
}

// セッショントークンを発行する。auth は Google でログインした時刻(秒)
function issueSessionToken(memberId, remember, auth) {
  var props = requestProps()
  var key = props.SESSION_SIGNING_KEY
  var kid = props.SESSION_KEY_ID
  var org = props.ORG_ID
  if (!key || !kid || !org) {
    throw userError('ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。')
  }
  var now = nowSec()
  var exp = remember
    ? Math.min(now + SESSION_TTL_REMEMBER_SEC, auth + SESSION_MAX_REMEMBER_SEC)
    : Math.min(now + SESSION_TTL_TEMP_SEC, auth + SESSION_TTL_TEMP_SEC)
  var payload = {
    org: org,
    sub: String(memberId),
    gen: sessionGeneration(memberId),
    kid: kid,
    sid: generateSecret().slice(0, 16),
    iat: now,
    exp: exp,
    auth: auth,
    rem: !!remember,
  }
  var payloadB64 = base64UrlEncode(JSON.stringify(payload))
  return { token: SESSION_TOKEN_VERSION + '.' + payloadB64 + '.' + signSessionPayload(payloadB64, key), exp: exp, remember: !!remember }
}

// セッショントークンを確かめ、payload を返す。受け付けない場合は理由つきで例外を投げる
function verifySessionToken(token) {
  var props = requestProps()
  var parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_VERSION || !parts[1] || !parts[2]) {
    throw userError('ログイン情報の形式が不正です。再ログインしてください。')
  }
  if (!props.SESSION_SIGNING_KEY || !props.ORG_ID) {
    throw userError('ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。')
  }
  if (!constantTimeEquals(signSessionPayload(parts[1], props.SESSION_SIGNING_KEY), parts[2])) {
    throw userError('ログイン情報が無効です。再ログインしてください。')
  }
  var payload
  try {
    payload = JSON.parse(base64UrlDecodeToString(parts[1]))
  } catch (e) {
    throw userError('ログイン情報の形式が不正です。再ログインしてください。')
  }
  if (!payload || payload.org !== props.ORG_ID) throw userError('この団体のログイン情報ではありません。再ログインしてください。')
  if (payload.kid !== props.SESSION_KEY_ID) throw userError('ログイン情報が無効になりました。再ログインしてください。')
  var now = nowSec()
  if (!(Number(payload.exp) > now)) throw userError('ログインの有効期限が切れました。再ログインしてください。')
  var notBefore = Number(props.SESSION_NOT_BEFORE || 0)
  if (Number(payload.iat) < notBefore) throw userError('ログイン情報が無効になりました。再ログインしてください。')
  if (!payload.sub) throw userError('ログイン情報の形式が不正です。再ログインしてください。')
  if (Number(payload.gen) !== sessionGeneration(payload.sub)) {
    throw userError('この端末のログインは無効になりました(全端末でログアウト済み)。再ログインしてください。')
  }
  return payload
}

// 残りが半分を切ったら新しいトークンを発行する(上限はGoogleでのログインから30日。
// チェックなしのセッションは延長しない)
function renewSessionIfNeeded(payload) {
  if (!payload.rem) return null
  var now = nowSec()
  var remaining = Number(payload.exp) - now
  if (remaining > SESSION_TTL_REMEMBER_SEC / 2) return null
  var renewed = issueSessionToken(payload.sub, true, Number(payload.auth))
  // 上限に近づいて期限がほとんど延びない場合は発行しない
  if (renewed.exp - Number(payload.exp) < 3600) return null
  return renewed
}

// Google の IDトークンを tokeninfo で確かめ、nonce がこの団体・この端末のものかを確かめる。
// 成功したら { email, iat } を返す
function verifyGoogleIdToken(idToken, nonceSecret) {
  var props = requestProps()
  var clientId = props.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) throw userError('サーバー側の設定(GOOGLE_OAUTH_CLIENT_ID)が未設定です。管理者にお問い合わせください。')
  if (!props.ORG_ID) throw userError('ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。')
  if (!/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(String(idToken || '')) || String(idToken).length > 4096) {
    throw userError('ログインの情報の形式が不正です。もう一度ログインしてください。')
  }
  if (!nonceSecret || String(nonceSecret).length < 16 || String(nonceSecret).length > 256) {
    throw userError('ログインの情報の形式が不正です。もう一度ログインしてください。')
  }
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), {
    muteHttpExceptions: true,
  })
  if (resp.getResponseCode() !== 200) {
    throw userError('Googleのログイン情報を確認できませんでした(有効期限切れなど)。もう一度ログインしてください。')
  }
  var info = JSON.parse(resp.getContentText())
  if (info.aud !== clientId) throw userError('ログイン情報の発行元がこのアプリと一致しません。')
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    throw userError('ログイン情報の発行元が不正です。')
  }
  if (!(Number(info.exp) > nowSec())) throw userError('Googleのログイン情報の有効期限が切れています。もう一度ログインしてください。')
  if (!info.email) throw userError('ログイン情報からメールアドレスを取得できませんでした。')
  if (info.email_verified !== true && info.email_verified !== 'true') {
    throw userError('メールアドレスが確認されていないGoogleアカウントのため利用できません。')
  }
  var expectedNonce = props.ORG_ID + '.' + sha256Base64Url(nonceSecret)
  if (!info.nonce || !constantTimeEquals(info.nonce, expectedNonce)) {
    throw userError('ログイン情報がこの団体・この画面のものではありません。もう一度ログインしてください。')
  }
  // 同じIDトークン(nonce)は1回だけ使える
  var cache = CacheService.getScriptCache()
  var nonceKey = 'idnonce:' + sha256Base64Url(info.nonce)
  if (cache.get(nonceKey)) throw userError('このログイン情報は既に使われています。もう一度ログインしてください。')
  cache.put(nonceKey, '1', ID_TOKEN_NONCE_TTL_SEC)
  return { email: String(info.email), iat: Number(info.iat) || nowSec() }
}

// exchangeIdToken: IDトークンをセッショントークンに交換し、初期データもまとめて返す
function exchangeIdToken(body) {
  var google = verifyGoogleIdToken(body.idToken, body.nonceSecret)
  var memberId = findMemberIdByEmailCached(google.email)
  // 未登録のアカウント: ログイン画面に表示するため、本人のメールアドレスだけ返す
  if (!memberId) return { memberId: null, email: google.email }
  var data = getInitialDataForMember(memberId, null)
  if (!data.memberId) return { memberId: null, email: google.email }
  data.session = issueSessionToken(memberId, body.remember !== false, nowSec())
  return data
}

// リクエストの認証(セッショントークン)。返り値 { memberId, renewed(新しいセッショントークン or null) }
function authenticateRequest(body) {
  if (!body.sessionToken) throw userError('ログインしていません。再ログインしてください。')
  var payload = verifySessionToken(body.sessionToken)
  return { memberId: String(payload.sub), renewed: renewSessionIfNeeded(payload) }
}

// メンバーの世代番号を1増やし、そのメンバーに発行済みのセッショントークンをすべて無効にする
function bumpSessionGeneration(memberId) {
  if (!memberId) return
  try {
    setRequestProp(SESSION_GEN_PREFIX + memberId, String(sessionGeneration(memberId) + 1))
  } catch (e) {
    Logger.log('bumpSessionGeneration failed: ' + e)
  }
}

// ---- エディタから実行する関数 ----

// 秘密鍵を作り直す。発行済みのセッショントークンがすべて無効になり、全員が再ログインになる
function rotateSessionKey() {
  var props = PropertiesService.getScriptProperties()
  props.setProperty('SESSION_SIGNING_KEY', generateSecret())
  props.setProperty('SESSION_KEY_ID', generateSecret().slice(0, 8))
  resetRequestProps()
  console.log('セッションの秘密鍵を作り直しました。全員のログインが無効になりました(次回の操作で再ログインになります)。')
}

// 今より前に発行されたセッショントークンをすべて無効にする(将来はレジストリからの指示で同じことを行う)
function revokeSessionsIssuedBefore() {
  setSessionNotBefore(nowSec())
}

// スクリプトプロパティ REVOKE_BEFORE_INPUT に書いた日時(ISO 形式 または 秒)より前に
// 発行されたセッショントークンを無効にする。エディタは引数を渡せないため、プロパティ経由で受け取る
function revokeSessionsIssuedBeforeInput() {
  var raw = String(PropertiesService.getScriptProperties().getProperty('REVOKE_BEFORE_INPUT') || '').trim()
  var sec = /^\d+$/.test(raw) ? Number(raw) : Math.floor(new Date(raw).getTime() / 1000)
  if (!raw || !(sec > 0)) throw new Error('REVOKE_BEFORE_INPUT に日時(例: 2026-10-01T09:00:00+09:00)を設定してから実行してください。')
  setSessionNotBefore(sec)
}

function setSessionNotBefore(sec) {
  var props = PropertiesService.getScriptProperties()
  var current = Number(props.getProperty('SESSION_NOT_BEFORE') || 0)
  // 後から古い日時を指定しても、既に無効にした範囲は戻さない
  var next = Math.max(current, Math.floor(sec))
  props.setProperty('SESSION_NOT_BEFORE', String(next))
  resetRequestProps()
  console.log('この日時より前に発行されたログインを無効にしました: ' + new Date(next * 1000).toISOString())
}

// ---- 権限の例外(permission_overrides) ------------------------------------------
//
// 例外は「対象の種類(task / project / department / recruiting)」と「対象ID」
// 「アクセス水準(view < edit < approve)」の組。例外で許可するのは、下の表で
// その種類の例外を受け付けると決めた操作だけにする。表に無い操作(代表専用の
// 操作 — 役職の変更、メンバーの追加・削除など — や、設定・メンバー情報の
// 変更、経費・フォームの承認など)は、どの例外でも許可しない。
//   task      タスクを対象にする操作。タスクの例外に加え、そのタスクが属する
//             プロジェクト・部署の例外も使える(プロジェクト・部署はリクエストの
//             値ではなく、シート上のタスクの値で判定する)
//   project   プロジェクトを対象にする操作。body.projectId のプロジェクトの例外
//   recruiting 採用(候補者)の操作。採用の例外だけ
var OVERRIDE_SCOPE_BY_ACTION = {
  approveTask: 'task', assignTask: 'task', updateTaskDetails: 'task', updateVisibility: 'task',
  updateReviewer: 'task', updateReviewers: 'task', removeTask: 'task', updatePriority: 'task',
  updateDifficulty: 'task', updateSchedule: 'task', updateDependsOn: 'task', setBlocker: 'task',
  notifyTaskRejected: 'task',
  updateProjectDetails: 'project', updateProjectOwner: 'project', updateProjectParent: 'project',
  updateProjectArchived: 'project', updateProjectMembers: 'project', notifyProjectHealth: 'project',
  updateProjectHealthRecord: 'project', updateProjectHealth: 'project',
  addCandidate: 'recruiting', updateCandidate: 'recruiting', removeCandidate: 'recruiting',
  convertCandidateToMember: 'recruiting',
}

var OVERRIDE_ACCESS_LEVELS = { view: 0, edit: 1, approve: 2 }

// 例外の一覧が、対象(targets)に対して必要な水準を満たすか(Google のサービスを
// 使わない純粋な関数)。targets は { task, project, department, recruiting } の
// うち、その操作で見てよいものだけを持つ。
function overridesGrant(overrides, targets, requiredLevel) {
  for (var i = 0; i < overrides.length; i++) {
    var ov = overrides[i] || {}
    var granted = OVERRIDE_ACCESS_LEVELS[ov.access]
    if (typeof granted !== 'number' || granted < requiredLevel) continue
    var targetId = String(ov.targetId || '')
    if (ov.targetType === 'task' && targets.task && targetId === targets.task) return true
    if (ov.targetType === 'project' && targets.project && targetId === targets.project) return true
    // 部門は、以前の部門名・部門IDのどちらでも同じ部門として比べる
    if (ov.targetType === 'department' && targets.department !== undefined &&
        normalizeValue('department', targetId) === normalizeValue('department', targets.department)) return true
    // recruiting: targetIdでの絞り込みは行わない（'all'固定運用のため、targetType一致とaccess水準のみで判定）
    if (ov.targetType === 'recruiting' && targets.recruiting) return true
  }
  return false
}

/**
 * Returns true if acting member has a permission_overrides entry that
 * applies to this action (see OVERRIDE_SCOPE_BY_ACTION). Used as OR
 * fallback when the role-based check denies.
 */
function checkPermissionOverride(acting, action, body) {
  var overrides = acting.permission_overrides
  if (!overrides || overrides.length === 0) return false
  var scope = OVERRIDE_SCOPE_BY_ACTION[action]
  if (!scope) return false
  body = body || {}

  var targets = {}
  if (scope === 'task') {
    var taskId = String(body.taskId || '')
    if (!taskId) return false
    targets.task = taskId
    var taskRow = null
    try { taskRow = findRow(SHEET_TASKS, taskId) } catch (e) { taskRow = null }
    if (taskRow) {
      targets.project = String(taskRow.project_id || '')
      targets.department = String(taskRow.department || '')
    }
  } else if (scope === 'project') {
    targets.project = String(body.projectId || '')
    if (!targets.project) return false
  } else if (scope === 'recruiting') {
    // 候補者を一般以外の役職でメンバー登録するのは役職の付与にあたるため、
    // 代表専用(採用の例外では許可しない)
    if (action === 'convertCandidateToMember' && roleTier(getRoles(), body.role) !== 'base') return false
    targets.recruiting = true
  }

  var required = action === 'approveTask' ? OVERRIDE_ACCESS_LEVELS.approve : OVERRIDE_ACCESS_LEVELS.edit
  return overridesGrant(overrides, targets, required)
}

/**
 * Reads skill_level_thresholds from the Settings sheet.
 * Returns {} when the key is absent or unparseable.
 */
function getSkillLevelThresholds() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
    if (!sheet) return {}
    var data = sheet.getDataRange().getValues()
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === 'skill_level_thresholds') {
        return JSON.parse(data[i][1] || '{}')
      }
    }
  } catch (_) {}
  return {}
}

/**
 * Reads quiz_definitions from the Settings sheet.
 * Returns [] when the key is absent or unparseable.
 */
function getQuizDefinitions() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
    if (!sheet) return []
    var data = sheet.getDataRange().getValues()
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === 'quiz_definitions') {
        var defs = JSON.parse(data[i][1] || '[]')
        return Array.isArray(defs) ? defs : []
      }
    }
  } catch (_) {}
  return []
}

/**
 * Computes leveled-up skill_levels_json given current levels, cumulative
 * points, and threshold config. Returns the updated levels array.
 *
 * Logic: for each skill with points, check if total >= threshold * level.
 * The threshold is "points needed per level"; e.g. threshold=100 means
 * Lv1→Lv2 at 100pts, Lv2→Lv3 at 200pts, ..., max Lv5.
 */
function computeAutoLevels(currentLevels, cumulativePoints, thresholds) {
  var DEFAULT_THRESHOLD = defaultSkillThreshold(thresholds)
  var levels = {}
  for (var i = 0; i < currentLevels.length; i++) {
    levels[currentLevels[i].skill] = currentLevels[i].level
  }
  var skills = Object.keys(cumulativePoints)
  for (var j = 0; j < skills.length; j++) {
    var skill = skills[j]
    var pts = cumulativePoints[skill] || 0
    var thr = thresholds[skill] || DEFAULT_THRESHOLD
    var earnedLevel = Math.min(5, Math.floor(pts / thr) + 1)
    var current = levels[skill] || 1
    if (earnedLevel > current) levels[skill] = earnedLevel
  }
  var result = []
  var allSkills = Object.keys(levels)
  for (var k = 0; k < allSkills.length; k++) {
    result.push({ skill: allSkills[k], level: levels[allSkills[k]] })
  }
  return result
}

/**
 * 他団体で積んだ実績(共通スキルのポイント・資格)の持ち込み。本人が自分の
 * ページからエクスポートしたファイルを、新しい団体で自分のページから
 * インポートする想定(lib/ohsumi/portable-record.ts)。awardSkillPointsと同じ
 * 「累計加算→レベル自動繰り上げ」ロジックだが、タスクには紐付けない。
 * 資格は名前+取得日が一致するものは重複とみなしスキップして追記する。
 */
function importPortableRecord(memberId, skillPoints, qualifications) {
  var memberRow = findRow(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError('メンバーが見つかりません: ' + memberId)

  var currentPoints = {}
  try { currentPoints = JSON.parse(memberRow.skill_points_json || '{}') } catch (_) {}
  var currentLevels = []
  try { currentLevels = JSON.parse(memberRow.skill_levels_json || '[]') } catch (_) {}
  var currentQualifications = []
  try { currentQualifications = JSON.parse(memberRow.qualifications_json || '[]') } catch (_) {}

  var skillKeys = Object.keys(skillPoints || {})
  for (var i = 0; i < skillKeys.length; i++) {
    var s = skillKeys[i]
    currentPoints[s] = (currentPoints[s] || 0) + (Number(skillPoints[s]) || 0)
  }

  var thresholds = getSkillLevelThresholds()
  var newLevels = computeAutoLevels(currentLevels, currentPoints, thresholds)

  var existingKeys = {}
  for (var j = 0; j < currentQualifications.length; j++) {
    var eq = currentQualifications[j]
    existingKeys[(eq.name || '') + '|' + (eq.acquiredDate || '')] = true
  }
  var incoming = qualifications || []
  for (var k = 0; k < incoming.length; k++) {
    var q = incoming[k]
    var key = (q.name || '') + '|' + (q.acquiredDate || '')
    if (existingKeys[key]) continue
    existingKeys[key] = true
    currentQualifications.push({
      id: 'q-' + Utilities.getUuid().slice(0, 8),
      name: q.name || '',
      acquiredDate: q.acquiredDate || undefined,
      issuer: q.issuer || undefined,
    })
  }

  updateMemberFields(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
    qualifications_json: JSON.stringify(currentQualifications),
  })
  return { ok: true, newPoints: currentPoints, newLevels: newLevels, qualifications: currentQualifications }
}

/**
 * Awards skill points to a member on task completion.
 * Updates skill_points_json and auto-levels skill_levels_json.
 * Also saves awarded_points_json on the task for future avg calculations.
 */
function awardSkillPoints(taskId, memberId, points) {
  var memberRow = findRow(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError('メンバーが見つかりません: ' + memberId)

  var currentPoints = {}
  try { currentPoints = JSON.parse(memberRow.skill_points_json || '{}') } catch (_) {}
  var currentLevels = []
  try { currentLevels = JSON.parse(memberRow.skill_levels_json || '[]') } catch (_) {}

  // Accumulate points
  var skillKeys = Object.keys(points)
  for (var i = 0; i < skillKeys.length; i++) {
    var s = skillKeys[i]
    currentPoints[s] = (currentPoints[s] || 0) + (points[s] || 0)
  }

  // Compute auto-level-up
  var thresholds = getSkillLevelThresholds()
  var newLevels = computeAutoLevels(currentLevels, currentPoints, thresholds)

  // Persist
  updateMemberFields(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
  })
  if (taskId) {
    updateTaskFields(taskId, { awarded_points_json: JSON.stringify(points) })
  }
  return { ok: true, newPoints: currentPoints, newLevels: newLevels }
}

/**
 * Processes a quiz submission. Reads the quiz definition from Settings,
 * scores the answers, and if pass rate is met, auto-levels the skill.
 */
function submitQuizResult(quizId, memberId, answers, acting) {
  if (memberId !== acting.id && !isAdminRoleRef(getRoles(), acting.role)) {
    throw userError('他のメンバーの代わりに検定を受けることはできません。')
  }
  var defs = getQuizDefinitions()
  var quiz = null
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].id === quizId) { quiz = defs[i]; break }
  }
  if (!quiz) throw userError('検定が見つかりません: ' + quizId)

  var questions = quiz.questions || []
  if (questions.length === 0) throw userError('検定に設問がありません。')

  var correct = 0
  for (var j = 0; j < questions.length; j++) {
    if (answers[j] === questions[j].correctIndex) correct++
  }
  var score = Math.round((correct / questions.length) * 100)
  var passed = score >= quiz.passRate

  var newLevel = null
  if (passed) {
    var memberRow = findRow(SHEET_MEMBERS, memberId)
    var currentLevels = []
    try { currentLevels = JSON.parse((memberRow && memberRow.skill_levels_json) || '[]') } catch (_) {}
    var targetSkill = quiz.targetSkill
    var targetLevel = quiz.targetLevel || 1
    var existing = currentLevels.find(function(sl) { return sl.skill === targetSkill })
    if (!existing || existing.level < targetLevel) {
      var nextLevels = currentLevels.filter(function(sl) { return sl.skill !== targetSkill })
      nextLevels.push({ skill: targetSkill, level: targetLevel })
      // SKL-009: skill_points_jsonもレベルと整合させる。computeAutoLevelsと
      // 同じ閾値計算(pts/threshold切り捨て+1=レベル)から逆算すると、
      // レベルLに達する最低ポイントはthreshold*(L-1)
      var thresholds = getSkillLevelThresholds()
      var defaultThreshold = defaultSkillThreshold(thresholds)
      var threshold = thresholds[targetSkill] || defaultThreshold
      var currentPoints = {}
      try { currentPoints = JSON.parse((memberRow && memberRow.skill_points_json) || '{}') } catch (_) {}
      var minPointsForLevel = threshold * (targetLevel - 1)
      if ((currentPoints[targetSkill] || 0) < minPointsForLevel) {
        currentPoints[targetSkill] = minPointsForLevel
      }
      updateMemberFields(memberId, {
        skill_levels_json: JSON.stringify(nextLevels),
        skill_points_json: JSON.stringify(currentPoints),
      })
      newLevel = targetLevel
    }
  }
  return { ok: true, passed: passed, score: score, newLevel: newLevel }
}

/**
 * Enforces per-action role-based access control.
 * Throws with a human-readable Japanese error on denial.
 *
 * Tiers (most to least restrictive):
 *   代表のみ        — organization leader only
 *   代表 or 班長    — any admin role (isLeader)
 *   selfOrAdmin     — acting on body.memberId === self, or any admin
 *   本人のみ        — acting on body.memberId === self only
 *   誰でも          — any logged-in member (with extra checks where noted)
 */
// lib/ohsumi/permissions.ts の isFullAdminRole と同じ基準:
// role が空または '一般' なら false、Settings の restricted_roles に含まれていれば false、それ以外は true。
// 代表は authorizeAction の先頭で早期 return するため、実質的には「restrictedRoles に含まれない班長」を判定する。
function isActingFullAdmin(acting) {
  return isFullAdminRoleRef(getRoles(), acting.role)
}

function authorizeAction(acting, action, body) {
  var role = acting.role
  // isLeader: true for any role that is not '一般' (i.e. any admin-level role).
  // We cannot enumerate all possible role names (they are user-configurable in Admin → Tags),
  // so we match '代表' specially and treat everything else non-一般 as 班長-equivalent.
  // 役職の種類で判定する(名前・ID のどちらでも。役職の名前を変えても同じ)
  var isDaihyo = isTopRoleRef(getRoles(), role)
  var isLeader = !isDaihyo && isAdminRoleRef(getRoles(), role)

  // 代表 can do anything
  if (isDaihyo) return

  // --- 代表のみ ---
  var daihyoOnly = [
    'updateRole',              // ロール変更は代表のみ
    'removeMember',            // メンバー削除は代表のみ
    'removeProject',           // プロジェクト削除は代表のみ
    // updateDiscordWebhookUrl/updateSlackWebhookUrl/updateSetting は
    // isActingFullAdmin基準の分岐（下記）に移動した
    'uploadOrgLogo',           // 団体ロゴアップロードは代表のみ
    'addMember',               // メンバー追加は代表のみ
    'updateEmail',             // 他人のメールアドレス変更は代表のみ
    'updateJoinedAt',          // 所属開始日の編集は代表のみ（人事記録）
    'updateReportsTo',         // 報告先の設定は代表のみ（組織図操作）
    'updateMentor',            // メンター設定は代表のみ（HR操作）
    'notifyTrainingDecision',       // 研修承認通知は代表のみ（承認権限）
    'updatePermissionOverrides',    // 権限例外の編集は代表のみ（人事機密）
    'updateMemberProjects',         // プロジェクト割り当ては代表のみ（自己昇権の抜け穴防止）
    // 採用関連は「代表のみ、ただし permission_overrides(targetType: 'recruiting')の
    // 例外を持つメンバーのみ許可」という個別指定制にしたいため、あえてdaihyoOrLeader
    // ではなくdaihyoOnlyに置く（班長など他の管理者ロールにもデフォルトでは開放しない）
    'addCandidate',                 // 候補者登録
    'updateCandidate',              // 候補者情報の編集
    'removeCandidate',              // 候補者削除
    'convertCandidateToMember',     // 候補者→正式メンバーへの登録
  ]
  // 代表は関数冒頭の if (isDaihyo) return でここに到達しないため、
  // このブロックに到達した時点で非代表が確定している。
  // isActingFullAdmin は使わない（restricted_roles 依存で穴が開くため）。
  if (daihyoOnly.indexOf(action) >= 0) {
    if (checkPermissionOverride(acting, action, body)) return
    throw userError('この操作は代表のみ実行できます。')
  }

  // --- updateSetting / Webhook URL設定: 団体ごとに isActingFullAdmin (=
  // restricted_roles に含まれないロール) であれば許可。「事業責任者を代表と
  // 同格にするか」は団体ごとのrestricted_roles設定で選べるようにするため、
  // daihyoOnly固定ではなくこちらを使う。
  if (action === 'updateSetting' || action === 'updateRoles' || action === 'deleteRole' ||
      action === 'updateDepartments' || action === 'deleteDepartment' || action === 'moveDepartmentTasks' || action === 'updateDiscordWebhookUrl' || action === 'updateSlackWebhookUrl' || action === 'testDiscordWebhook' || action === 'testSlackWebhook' || action === 'getWebhookStatus' || action === 'updateProjectHealth' || action === 'revokeMemberSessions') {
    if (isActingFullAdmin(acting)) return
    if (checkPermissionOverride(acting, action, body)) return
    throw userError('この操作は代表または全権管理者のみ実行できます。')
  }

  // --- 代表 or 班長 (任意の管理者ロール) ---
  var daihyoOrLeader = [
    'approveTask',          // タスク承認
    'updateJudgment',       // 評価タグの編集（管理者権限）
    'assignTask',           // タスクのアサイン
    'updateTaskDetails',    // タスク詳細編集
    'updateVisibility',     // タスク公開範囲の変更
    'updateReviewer',       // レビュアー設定
    'updateReviewers',      // レビュアー設定（複数）
    'removeTask',           // タスク削除
    'createProject',        // プロジェクト作成
    'updateProjectDetails', // プロジェクト詳細編集
    'updateProjectOwner',   // オーナー変更
    'updateProjectParent',  // 親プロジェクト変更
    'updateProjectArchived',// アーカイブ操作
    'updateProjectMembers', // プロジェクトメンバー管理
    // updateMemberProjects は daihyoOnly に移動（下記参照）
    'updatePriority',       // 優先度（管理者が設定するケースが主）
    'updateDifficulty',     // 難易度（管理者が設定するケースが主）
    'updateSchedule',       // 日程設定
    'updateDependsOn',      // 依存関係設定
    'setBlocker',           // ブロッカー設定（班長が管理）
    'notifyTaskRejected',   // タスク却下通知（管理者が送信）
    'notifyProjectHealth',  // item 26: プロジェクト健康状態の自動判定変化通知
    'updateProjectHealthRecord', // item 26(追補): attention回復時の記録更新（通知なし）
    'reportProjectHealth',  // 健康状態の自動判定の結果(複数プロジェクト)の記録と、まとめた通知
    'updateSearchProfile',  // 人材検索プロフィール（HR管理者が設定）
    'awardSkillPoints',     // スキルポイント付与（管理者操作）
    'approveExpenseStep',   // 経費承認（管理者操作）
    'rejectExpense',        // 経費却下（管理者操作）
    'returnExpense',        // EXP-008: 経費差し戻し（管理者操作）
    'approveFormStep',      // フォーム承認（管理者操作）
    'rejectFormSubmission', // フォーム却下（管理者操作）
    'bulkUpdateSkills',          // スキル一括更新（管理者操作）
    'updateMemberInactive',      // 活動休止/再開（管理者操作）
    'updateMemberDepartmentPath',// 組織パス設定（管理者操作）
    'updateEvaluationHistory',   // 評価履歴（班長は担当メンバーのみ）
    'updateTransferHistory',     // 異動履歴（班長は担当メンバーのみ）
    'updateOneOnOnes',           // 1on1記録（班長は担当メンバーのみ）
    'updateCompetencies',        // コンピテンシー評価（班長は担当メンバーのみ）
    'triggerOverdueReminders',   // NTF-005: 期限超過リマインドの手動発火
    'uploadSurveyImage',         // FRM-007: アンケート設問の画像は管理者操作
    'fetchDailyReports',         // REP-005: 日報・週報の閲覧は管理者操作
  ]
  if (daihyoOrLeader.indexOf(action) >= 0) {
    // 一般ロールでも、未アサインのタスクに自分だけを追加する「自己アサイン」
    // （taskDrawerの「このタスクを担当する」／公募タブの「応募する」）に限り許可する。
    // 既存の担当者変更・他人の追加・複数人同時追加は引き続き代表/管理者限定のまま。
    if (action === 'assignTask' && !isLeader) {
      var atTask = null
      try { atTask = findRow(SHEET_TASKS, String(body.taskId || '')) } catch (e) {}
      var atCurrentAssignees = atTask
        ? String(atTask.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
        : []
      var atRequested = (body.assigneeIds || []).map(String)
      var isSelfClaim =
        atCurrentAssignees.length === 0 &&
        atRequested.length === 1 &&
        atRequested[0] === acting.id
      if (isSelfClaim) return
    }
    if (!isLeader) {
      // ロールで弾かれた場合でも permission_overrides_json に該当する例外があれば許可（OR条件）
      if (checkPermissionOverride(acting, action, body)) return
      throw userError('この操作は代表または管理者（班長以上）のみ実行できます。')
    }
    // 承認ステップの担当者チェック（代表は上で return 済みなので班長のみ到達）
    if (action === 'approveExpenseStep' || action === 'approveFormStep') {
      var approverCheckPassed = false
      try {
        if (action === 'approveExpenseStep') {
          var expSheet = ensureExpensesSheet()
          var expFound = findExpenseRow(expSheet, String(body.applicationId || ''))
          if (expFound) {
            var expSteps = JSON.parse(String(expFound.data[expFound.headers.indexOf('approval_steps_json')] || '[]'))
            var expIdx = Number(expFound.data[expFound.headers.indexOf('current_step_index')]) || 0
            var expStep = expSteps[expIdx]
            if (expStep) {
              if (expStep.type === 'member' && expStep.memberId === acting.id) approverCheckPassed = true
              if (expStep.type === 'role' && sameRole(getRoles(), expStep.role, acting.role)) approverCheckPassed = true
            }
          }
        } else {
          var fmSheet = ensureFormSubmissionsSheet()
          var fmFound = findFormSubmissionRow(fmSheet, String(body.submissionId || ''))
          if (fmFound) {
            var fmIdx = Number(fmFound.data[fmFound.headers.indexOf('current_step_index')]) || 0
            var fmId = String(fmFound.data[fmFound.headers.indexOf('form_id')] || '')
            var fmDefs = []
            try { var fmRaw = getSettingValue('custom_form_defs'); if (fmRaw) fmDefs = JSON.parse(fmRaw) } catch(e2) {}
            var fmDef = fmDefs.filter(function(f) { return f.id === fmId })[0]
            var fmStepObj = fmDef ? (fmDef.approvalSteps || [])[fmIdx] : null
            if (fmStepObj) {
              if (fmStepObj.type === 'member' && fmStepObj.memberId === acting.id) approverCheckPassed = true
              if (fmStepObj.type === 'role' && sameRole(getRoles(), fmStepObj.role, acting.role)) approverCheckPassed = true
            }
          }
        }
      } catch(e) {}
      if (!approverCheckPassed) {
        if (checkPermissionOverride(acting, action, body)) return
        throw userError('この承認ステップの担当者ではありません。')
      }
    }

    // approveTask: importance に応じた承認者チェック（lib/ohsumi/permissions.ts の canApproveTask と同じロジック）
    if (action === 'approveTask') {
      var taskForApprove = null
      try { taskForApprove = findRow(SHEET_TASKS, String(body.taskId || '')) } catch(e) {}
      if (taskForApprove) {
        var taskImportance = normalizeCode('importance', taskForApprove.importance)
        if (taskImportance === 'important' || taskImportance === 'external') {
          // escalated: 全権管理者（isFullAdmin）のみ承認可能
          if (!isActingFullAdmin(acting)) {
            if (checkPermissionOverride(acting, action, body)) return
            throw userError('重要度が「重要」または「対外公開」のタスクは、全権管理者のみ承認できます。')
          }
        } else {
          // non-escalated: タスク登録者の上長（creator の reports_to_id）のみ承認可能
          if (!isActingFullAdmin(acting)) {
            var creatorId = String(taskForApprove.creator_id || '').trim()
            var approverId = ''
            if (creatorId) {
              try {
                var creatorRow = findRow(SHEET_MEMBERS, creatorId)
                approverId = String(creatorRow.reports_to_id || '').trim()
              } catch(e) {}
            }
            if (approverId && acting.id !== approverId) {
              if (checkPermissionOverride(acting, action, body)) return
              throw userError('このタスクの承認者として指定されていないため、承認できません。')
            }
          }
        }
      }
    }

    // 班長（代表以外の管理者）はプロジェクトスコープに制限する。
    // acting.project_ids に対象プロジェクトが含まれなければ permission_overrides でのみ許可。
    var actingProjectIds = acting.project_ids ? String(acting.project_ids).split(',').map(function(s) { return s.trim() }).filter(Boolean) : []
    if (actingProjectIds.length > 0) {
      // 対象プロジェクトIDを特定する
      var targetProjectId = null
      if (body.projectId) {
        // プロジェクト操作（createProject/updateProjectDetails/updateProjectMembers 等）
        targetProjectId = String(body.projectId)
      } else if (body.taskId) {
        // タスク操作: タスクの project_id を引く
        try {
          var taskObj = findRow(SHEET_TASKS, String(body.taskId))
          if (taskObj) targetProjectId = String(taskObj.project_id || '')
        } catch(e) {}
      }
      // project_id が特定できた場合のみスコープチェック（特定できない操作は通過させる）
      if (targetProjectId && actingProjectIds.indexOf(targetProjectId) < 0) {
        if (checkPermissionOverride(acting, action, body)) return
        throw userError('この操作は担当プロジェクトの範囲内でのみ実行できます。')
      }

      // updateSearchProfile は本人であればスコープ制限なしで許可
      if (action === 'updateSearchProfile' && body.memberId && acting.id === String(body.memberId)) return

      // メンバーを対象とするアクションのスコープチェック:
      // acting.project_ids に含まれるプロジェクトの member_ids を Projects シートから取得し、
      // 対象メンバーがそのいずれかに含まれるかで判定する（一般メンバーの project_ids は空欄設計のため）。
      var memberScopeActions = ['updateJudgment', 'updateSearchProfile', 'updateMemberInactive', 'updateMemberDepartmentPath', 'bulkUpdateSkills', 'updateEvaluationHistory', 'updateTransferHistory', 'updateOneOnOnes', 'updateCompetencies']
      if (memberScopeActions.indexOf(action) >= 0) {
        // acting.project_ids 配下の Projects を1回読んで所属メンバーIDのセットを作る
        var scopedMemberIdSet = {}
        try {
          var projectsSheet = getSheet(SHEET_PROJECTS)
          var pHeaders = headerRow(projectsSheet)
          var pIdCol = pHeaders.indexOf('id')
          var pMemberIdsCol = pHeaders.indexOf('member_ids')
          if (pIdCol >= 0 && pMemberIdsCol >= 0 && projectsSheet.getLastRow() > 1) {
            var pRows = projectsSheet.getRange(2, 1, projectsSheet.getLastRow() - 1, pHeaders.length).getValues()
            pRows.forEach(function(row) {
              var pid = String(row[pIdCol] || '').trim()
              if (actingProjectIds.indexOf(pid) >= 0) {
                var mids = String(row[pMemberIdsCol] || '').split(',').map(function(s) { return s.trim() }).filter(Boolean)
                mids.forEach(function(mid) { scopedMemberIdSet[mid] = true })
              }
            })
          }
        } catch(e) { /* Projects シート読み込み失敗時は scopedMemberIdSet が空のまま → 全件拒否（安全側） */ }

        // チェック対象の memberId 一覧を取得
        var memberIdsToCheck = []
        if (action === 'bulkUpdateSkills') {
          var bUpdates = body.updates || []
          bUpdates.forEach(function(u) { if (u && u.memberId) memberIdsToCheck.push(String(u.memberId)) })
        } else if (body.memberId) {
          memberIdsToCheck.push(String(body.memberId))
        }

        for (var mi = 0; mi < memberIdsToCheck.length; mi++) {
          if (!scopedMemberIdSet[memberIdsToCheck[mi]]) {
            if (checkPermissionOverride(acting, action, body)) return
            throw userError('この操作は担当プロジェクトのメンバーにのみ実行できます。')
          }
        }
      }
    }
    return
  }

  // --- 本人 or 管理者 (selfOrAdmin) ---
  // これらのアクションは本人が自分の情報を編集するか、管理者が代理編集する。
  var selfOrAdmin = [
    'updateSkillLevels',    // 本人・管理者双方が編集可（タスク完了時に自動登録も）
    'updateCareerGoals',    // 本人・管理者双方が編集可
    'updateDevelopmentPlan',// 本人・管理者双方が編集可
    'updateCareerHistory',  // 本人が主体だが管理者も修正可（安全側: 本人or管理者）
    'updateQualifications', // 本人が主体だが管理者も修正可（安全側: 本人or管理者）
    'importPortableRecord', // 他団体からの実績持ち込みは本人が主体（管理者も代理可）
    'updateTrainingHistory',// 本人が申請、管理者が更新（ステータス変更）
    'notifyTrainingRequest',// 本人が申請するが念のため本人or管理者に制限
    'updateEducationInfo',  // 大学名・学部・学科・学年は本人・管理者双方が編集可
    'updateCustomFields',   // 人材DBのカスタム列は本人・管理者双方が編集可
  ]
  if (selfOrAdmin.indexOf(action) >= 0) {
    var targetId = String(body.memberId || '')
    if (targetId !== acting.id && !isLeader) {
      throw userError('この操作は本人または管理者のみ実行できます。')
    }
    return
  }

  // --- 本人のみ (selfOnly) ---
  var selfOnly = [
    'updateWill',            // 得意分野・希望タグは本人のみ
    'updateNotify',          // 通知設定は本人のみ
    'updateNotifySettings',  // 通知設定詳細は本人のみ
    'updateAvatar',          // アイコン変更は本人のみ
    'uploadAvatar',          // 画像アップロードは本人のみ
    'updateDisplayName',     // 表示名変更は本人のみ
    'updateUnavailableDates',// 稼働不可日は本人のみ
    'updateAbsentDates',    // 不在日は本人のみ
    'updateAvailableHours', // CAL-009: 稼働可能時間帯は本人のみ
    'updateTimezone',       // タイムゾーン設定は本人のみ
    'updateLocale',         // 表示言語設定は本人のみ
  ]
  if (selfOnly.indexOf(action) >= 0) {
    var selfTargetId = String(body.memberId || '')
    if (selfTargetId !== acting.id) {
      throw userError('この操作は本人のみ実行できます。')
    }
    return
  }

  // --- ログイン済みなら誰でも ---
  var anyLoggedIn = [
    'createTasks',
    'updateTaskStatus',      // 担当者チェックあり（下記）
    'updateProgress',
    'updateComments',
    'notifyMention',
    'updateEstimatedHours',
    'updateActualHours',
    'updateRetrospective',
    'updateTaskSchedule',
    'notifyScheduleResult',
    'updateTaskForm',
    'notifyFormResult',
    'updateHistory',
    'updateDeliverables',
    'setHoldReason',           // 保留理由の設定は担当者(または管理者)が本人操作
    'submitQuizResult',        // 検定の受験はログイン済み誰でも
    'submitExpenseApplication',// 経費申請はログイン済み誰でも
    'withdrawExpense',         // 取り下げは本人（下層でチェック）
    'resubmitExpense',         // EXP-008: 再提出は本人（下層でチェック）
    'uploadExpenseReceipt',    // EXP-003: 領収書アップロードはログイン済み誰でも
    'submitCustomForm',        // フォーム申請はログイン済み誰でも
    'submitDailyReport',       // REP-004: 日報・週報の保存はログイン済み誰でも
    'updateLastLogin',         // ログイン日時更新は誰でも（本人のみ実質的）
    'translateText',           // 自由入力テキストの自動翻訳は読み取り専用、誰でも
    'submitSurveyResponse',    // アンケート回答の送信はログイン済み誰でも（本人のみ実質的）
    'approveTaskReview',       // 複数確認者の承認（本人が確認者かどうかは下記でチェック）
    'checkAndGenerateRecurringTasks', // item 2/TSK-051: 生成はルール定義に従うだけなので誰でも呼べる
    'applyToOpenBid',          // TSK-027: 担当者未定タスクへの自己応募。既存の自己アサインと同等の緩さでよい
    'getMyEmails',             // 自分自身のメールを読むだけ(常にacting.id基準、bodyのmemberIdは見ない)なので誰でも呼べる
    'getExpenses',             // 経費申請の読み取り。閲覧できる申請だけを返す(canViewExpense で絞り込む)
    'getCandidates',           // 採用の候補者の読み取り。採用の権限が無い人には何も返さない(canViewRecruiting)
    'getFormSubmissions',      // フォームの回答の読み取り。閲覧できる回答だけを返す(canViewFormSubmission で絞り込む)
    'getFiles',                // アップロードしたファイルの取得。種類ごとの権限を getFiles 内で確認する
    'revokeMySessions',        // 全端末でログアウト(常に acting.id が対象、body の memberId は見ない)
  ]
  if (anyLoggedIn.indexOf(action) >= 0) {
    // updateTaskStatus: 全権管理者は制限なし。「完了」は確認者のみ可。それ以外は担当者のみ可。
    if (action === 'updateTaskStatus') {
      if (!isActingFullAdmin(acting)) {
        var taskId = String(body.taskId || '')
        var task = findRow(SHEET_TASKS, taskId)
        if (body.status === 'done') {
          // 「完了」への変更は確認者（reviewer_id / reviewer_ids）のみ許可
          var reviewerAllowed = false
          if (task) {
            var reviewerIdsRaw = String(task.reviewer_ids || task.reviewer_id || '').trim()
            var reviewerIdList = reviewerIdsRaw.split(',').map(function(s) { return s.trim() }).filter(Boolean)
            if (reviewerIdList.indexOf(acting.id) >= 0) reviewerAllowed = true
          }
          if (!reviewerAllowed) {
            throw userError('担当者は「完了」に変更できません。確認者または管理者に依頼してください。')
          }
        } else {
          // 「完了」以外のステータス変更は担当者のみ許可
          if (task) {
            var assigneeIds = String(task.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
            if (assigneeIds.length > 0 && assigneeIds.indexOf(acting.id) < 0) {
              throw userError('このタスクの担当者のみステータスを変更できます。')
            }
          }
        }
      }
    }
    if (action === 'approveTaskReview') {
      if (!isActingFullAdmin(acting)) {
        var taskForApproval = findRow(SHEET_TASKS, String(body.taskId || ''))
        var approvalReviewerIds = taskForApproval
          ? String(taskForApproval.reviewer_ids || taskForApproval.reviewer_id || '').split(',').map(function(s){return s.trim()}).filter(Boolean)
          : []
        if (approvalReviewerIds.indexOf(acting.id) < 0) {
          throw userError('このタスクの確認者ではないため承認できません。')
        }
      }
    }

    // 仕様変更(レビュー指摘対応1): updateComments は「タスクを閲覧できる人
    // なら誰でもコメント追加可」に緩和する(担当者・確認者・作成者に限らな
    // い)。閲覧可否はフロント(lib/ohsumi/types.ts の canSeeExecTasks /
    // store.tsx の visibleTasks)と同じ基準 = 幹部限定タスク
    // (visibility が幹部)は role が '一般' のメンバーには見えない、
    // それ以外は誰でも見える、をそのままGAS側で再現する。既存コメントの
    // 編集・削除は投稿者本人・全権管理者のみ(validateCommentsUpdate)のまま。
    if (action === 'updateComments') {
      var ucTask = findRow(SHEET_TASKS, String(body.taskId || ''))
      if (!ucTask) throw userError('対象のタスクが見つかりません。')
      if (normalizeCode('visibility', ucTask.visibility) === 'leaders' && !isAdminRoleRef(getRoles(), acting.role)) {
        throw userError('この操作は幹部限定タスクを閲覧できるメンバーのみ実行できます。')
      }
      validateCommentsUpdate(ucTask, body.comments, acting)
      return
    }

    // F1/F10: これらはタスクに紐づく更新だが anyLoggedIn 扱いだったため、
    // 無関係な第三者が他人のタスクの履歴・成果物・工数・振り返り・
    // 日程調整・フォームを書き換えられてしまっていた。担当者・確認者・
    // 作成者・全権管理者のみに制限する。
    var taskOwnerScopedActions = [
      'updateDeliverables', 'updateHistory',
      'updateEstimatedHours', 'updateActualHours', 'updateRetrospective',
      'updateTaskSchedule', 'updateTaskForm',
    ]
    if (taskOwnerScopedActions.indexOf(action) >= 0) {
      var tosTask = findRow(SHEET_TASKS, String(body.taskId || ''))
      if (!tosTask) throw userError('対象のタスクが見つかりません。')

      if (!isActingFullAdmin(acting)) {
        var tosAssigneeIds = String(tosTask.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
        var tosReviewerIds = String(tosTask.reviewer_ids || tosTask.reviewer_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
        var tosCreatorId = String(tosTask.creator_id || '').trim()
        var tosAllowed =
          tosAssigneeIds.indexOf(acting.id) >= 0 ||
          tosReviewerIds.indexOf(acting.id) >= 0 ||
          (tosCreatorId && tosCreatorId === acting.id)
        if (!tosAllowed) {
          throw userError('この操作はタスクの担当者・確認者・作成者・管理者のみ実行できます。')
        }
      }

      // updateHistory はクライアントが配列を丸ごと置き換える仕様のため、
      // 他人が記録した既存データを書き換え/削除できないか追加でチェックする
      // (所有者チェックを通っていても対象)。
      if (action === 'updateHistory') validateHistoryUpdate(tosTask, body.history, acting)
    }

    return
  }

  // Unknown action — 安全側に倒して管理者限定（新しいactionが追加された際の保護）
  if (!isLeader) {
    // コメント: 未分類のactionは代表/班長のみに制限（新機能追加時の安全装置）
    throw userError('この操作は代表または管理者のみ実行できます。(未分類のaction: ' + action + ')')
  }
}

// lib/ohsumi/store.tsx の appendHistory と同じ値。history_json は
// [新しい変更, ...既存].slice(0, HISTORY_CAP) という形で常に先頭に追記される
// ため、この値がずれるとキャップ落ちの正当な範囲が誤判定される。
var HISTORY_CAP = 50

// F1/F10: updateComments はコメント配列を丸ごと置き換える仕様のため、
// GAS側で「新しく追加されるコメントのbyIdは本人か」「既存コメントの
// 編集・削除は投稿者本人か全権管理者のみか」を検証する。
// コメントは(historyと違って)件数上限による自動切り捨てが無いため、
// 新規/既存の判定だけで足りる。
function validateCommentsUpdate(task, newComments, acting) {
  if (!Array.isArray(newComments)) throw userError('コメントの形式が不正です。')

  var oldComments = []
  try { oldComments = JSON.parse(task.comments_json || '[]') } catch (e) {}
  if (!Array.isArray(oldComments)) oldComments = []

  var oldById = {}
  oldComments.forEach(function (c) { if (c && c.id) oldById[c.id] = c })
  var newIds = {}
  var isAdmin = isActingFullAdmin(acting)

  newComments.forEach(function (c) {
    if (!c || !c.id) throw userError('コメントの形式が不正です。')
    newIds[c.id] = true
    var old = oldById[c.id]
    if (old) {
      if (!isAdmin) {
        var changed = JSON.stringify(old) !== JSON.stringify(c)
        if (changed && old.byId !== acting.id) {
          throw userError('他のメンバーが投稿したコメントは編集できません。')
        }
      }
    } else {
      // 仕様変更(レビュー指摘対応1): 新規コメントの投稿者(byId)はクライアント
      // の値を信用せず、認証済みの本人IDで常に上書きする(なりすまし防止。
      // 管理者も例外なし)。
      c.byId = acting.id
    }
  })

  if (!isAdmin) {
    oldComments.forEach(function (c) {
      if (c && c.id && !newIds[c.id] && c.byId !== acting.id) {
        throw userError('他のメンバーが投稿したコメントは削除できません。')
      }
    })
  }
}

// F1/F10: updateHistory も同様に配列を丸ごと置き換える仕様。history は
// HISTORY_CAP件を超えると自動的に末尾(=最も古いもの)が切り捨てられる正当な
// 動作があるため、「非管理者による更新は次の形と完全一致する場合のみ許可」
// という厳密な形で検証する:
//   新しい配列 == [今回追加されたエントリ(byIdは本人)] + 既存配列の先頭から
//                 (HISTORY_CAP - 追加件数) 件をそのまま
// 既存エントリの内容・順序が1件でも変わっている、または上限に達していない
// のに古いエントリが消えている場合は拒否する。全権管理者は制限なし。
function validateHistoryUpdate(task, newHistory, acting) {
  if (!Array.isArray(newHistory)) throw userError('履歴の形式が不正です。')
  if (isActingFullAdmin(acting)) return

  var oldHistory = []
  try { oldHistory = JSON.parse(task.history_json || '[]') } catch (e) {}
  if (!Array.isArray(oldHistory)) oldHistory = []
  // シートの記録は移行前の日本語のことがある。送られてきた記録(入口でコードに
  // そろえている)と同じくコードにそろえてから比べる
  oldHistory = oldHistory.map(normalizeHistoryEntry)

  var oldIds = {}
  oldHistory.forEach(function (h) { if (h && h.id) oldIds[h.id] = true })

  // 配列の先頭から、「既存配列に無いid(=新規追加分)」が連続する個数を数える。
  // 新規追加分は必ず先頭にまとまって入る仕様(appendHistory参照)なので、
  // 先頭以外に紛れ込んでいる場合は後段の完全一致チェックで拒否される。
  var addedCount = 0
  while (
    addedCount < newHistory.length &&
    newHistory[addedCount] &&
    newHistory[addedCount].id &&
    !oldIds[newHistory[addedCount].id]
  ) {
    addedCount++
  }

  var addedEntries = newHistory.slice(0, addedCount)
  var remainingEntries = newHistory.slice(addedCount)

  addedEntries.forEach(function (h) {
    if (h.byId !== acting.id) {
      throw userError('新しい履歴の記録者は本人である必要があります。')
    }
  })

  var expectedKeepCount = Math.max(HISTORY_CAP - addedCount, 0)
  var expected = oldHistory.slice(0, expectedKeepCount)
  if (
    remainingEntries.length !== expected.length ||
    JSON.stringify(remainingEntries) !== JSON.stringify(expected)
  ) {
    throw userError('他のメンバーが記録した履歴を変更・削除することはできません。')
  }
}

// F7: LockServiceで保護しない(=書き込みを伴わない)アクション。
// translateText/getMyEmails/fetchDailyReportsは読み取りのみ。
// checkAndGenerateRecurringTasksはgenerateRecurringTasksLocked()内で
// 既に自前のスクリプトロックを取得するため、ここでも取得すると同一実行内で
// 同じロックを二重に待つことになり無駄(かつ不必要に複雑)なので対象外にする。
// F14: 業務上のエラー(利用者にそのままメッセージを見せてよいもの)は必ず
// この関数で作って投げる。SpreadsheetApp等のApps Scriptサービスが投げる
// 例外やコード内の想定外のバグ(TypeError等)にはこの目印(isUserError)が
// 付かないため、doPost側でtoErrorMessage()を使って「目印の有無」だけで
// 安全に振り分けられる(err.nameのように実行環境依存の値に頼らない)。
function userError(message) {
  var e = new Error(message)
  e.isUserError = true
  return e
}

// doPost内の各catchで例外をクライアント向けメッセージに変換する共通処理。
// userError()由来(業務エラー)ならそのメッセージをそのまま返す。目印が
// 無い例外は「予期しない例外」とみなし、スタックトレース等の内部情報は
// Loggerにのみ記録し(リクエスト本文やトークンは記録しない)、フロントには
// 定型メッセージだけを返す。
function toErrorMessage(err) {
  if (err && err.isUserError) return String(err.message || err)
  Logger.log('doPost unexpected error [' + (err && err.name) + ']: ' + ((err && err.stack) || (err && err.message) || err))
  return '処理中に問題が発生しました。しばらくしてから再度お試しください。'
}

// testDiscordWebhook/testSlackWebhookはスプレッドシートを書き換えず外部
// Webhookへの疎通確認(UrlFetchApp、数百ms〜数秒かかりうる)のみなので、
// ロック保持時間を最小限にするため対象外にする(レビュー指摘対応4)。
var LOCK_EXEMPT_ACTIONS = [
  'translateText', 'getMyEmails', 'fetchDailyReports', 'checkAndGenerateRecurringTasks',
  'testDiscordWebhook', 'testSlackWebhook', 'getExpenses', 'getFiles', 'getWebhookStatus',
  'getCandidates', 'getFormSubmissions',
  // スクリプトプロパティ(世代番号)だけを書き換える。データの版は変えない
  'revokeMySessions', 'revokeMemberSessions',
]

// リクエストの中の選択肢の値を、日本語・コードのどちらでもコードにそろえる。
// status などの名前は、ほかのアクション(候補者・研修など)では別の意味なので、
// アクションごとに対象を決める
function normalizeRequestCodes(body) {
  if (!body) return
  switch (body.action) {
    case 'updateTaskStatus':
      body.status = normalizeCode('status', body.status)
      break
    case 'updatePriority':
      body.priority = normalizeCode('priority', body.priority)
      break
    case 'updateDifficulty':
      body.difficulty = normalizeCode('difficulty', body.difficulty)
      break
    case 'updateVisibility':
      body.visibility = normalizeCode('visibility', body.visibility)
      break
    case 'updateTaskDetails':
      body.department = normalizeValue('department', body.department)
      body.difficulty = normalizeCode('difficulty', body.difficulty)
      body.priority = normalizeCode('priority', body.priority)
      body.visibility = normalizeCode('visibility', body.visibility)
      body.importance = normalizeCode('importance', body.importance)
      break
    case 'createTasks':
      ;(body.tasks || []).forEach(function (t) {
        if (!t) return
        t.department = normalizeValue('department', t.department)
        if (t.difficulty) t.difficulty = normalizeCode('difficulty', t.difficulty)
        if (t.priority) t.priority = normalizeCode('priority', t.priority)
        t.visibility = normalizeCode('visibility', t.visibility)
        if (t.importance) t.importance = normalizeCode('importance', t.importance)
      })
      break
    case 'updateHistory':
      if (Array.isArray(body.history)) body.history = body.history.map(normalizeHistoryEntry)
      break
    case 'updateTaskSchedule':
      if (body.schedule) body.schedule = mapScheduleCodes(body.schedule, normalizeCode)
      break
    case 'updatePermissionOverrides':
      if (Array.isArray(body.overrides)) body.overrides = mapOverrideCodes(body.overrides, normalizeValue)
      break
  }
}

function doPost(e) {
  var result
  var lock = null
  // 書き込みの requestId(同じ ID の結果を覚えておき、送り直された時は前回の結果を返す)
  var replayKey = null
  try {
    var body = JSON.parse(e.postData.contents)
    // スクリプトプロパティはこのリクエストの中で1回だけまとめて読む(requestProps)
    resetRequestProps()

    // getLoginConfig: ログイン前に団体ID(IDトークンの nonce に含める)を返す。認証不要
    if (body.action === 'getLoginConfig') {
      var orgId = requestProps().ORG_ID
      if (!orgId) {
        return jsonOutput({ ok: false, error: 'ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。' })
      }
      return jsonOutput({ ok: true, result: { orgId: orgId } })
    }

    // 移行の後は、コードを読めない古いタブからのリクエストを断る(再読み込みを促す)
    var versionError = checkClientVersion(body)
    if (versionError) return jsonOutput({ ok: false, error: versionError, reloadRequired: true })

    // 選択肢の値は、以降の処理ではすべてコードで扱う(古いタブは日本語で送ってくる)
    normalizeRequestCodes(body)

    // exchangeIdToken: Google の IDトークンを確かめ、セッショントークンと初期データを返す
    if (body.action === 'exchangeIdToken') {
      try {
        return jsonOutput({ ok: true, result: exchangeIdToken(body) })
      } catch (exchangeErr) {
        return jsonOutput({ ok: false, error: toErrorMessage(exchangeErr), authError: true })
      }
    }

    // getInitialData: ログインと初期データの取得をまとめて行う読み取り専用
    // アクション(メンバー特定前に呼ばれる)。
    // 閲覧者が見てよい行・列だけに絞って返す(READ_POLICY 参照)。
    if (body.action === 'getInitialData') {
      var initAuth
      try {
        initAuth = authenticateRequest(body)
      } catch (initAuthErr) {
        return jsonOutput({ ok: false, error: toErrorMessage(initAuthErr), authError: true })
      }
      try {
        return jsonOutput({
          ok: true,
          result: getInitialDataForMember(initAuth.memberId, body.knownVersion),
          session: initAuth.renewed || undefined,
        })
      } catch (initErr) {
        return jsonOutput({ ok: false, error: toErrorMessage(initErr) })
      }
    }

    // ---- Token verification & authorization --------------------------------
    // Every request must carry a sessionToken (issued by exchangeIdToken and
    // signed with this organisation's key — see authenticateRequest). The
    // member is resolved from the token, then we check whether they have
    // permission for this action.
    //
    // Auth errors are returned with authError:true so the frontend can
    // distinguish them from business logic errors (session expired → login).
    var actingMember
    var renewedSession = null
    try {
      var auth = authenticateRequest(body)
      renewedSession = auth.renewed
      actingMember = getActingMemberById(auth.memberId)
      authorizeAction(actingMember, body.action, body)
    } catch (authErr) {
      return jsonOutput({ ok: false, error: toErrorMessage(authErr), authError: true })
    }
    // ------------------------------------------------------------------------

    // F7: 書き込みを伴うアクションはLockService.getScriptLock()で排他制御する。
    // 同時書き込みによる行の取り違え・カウンタの競合等を防ぐ。取得できな
    // かった場合はエラーを返す(finallyで確実にreleaseLockする)。
    if (LOCK_EXEMPT_ACTIONS.indexOf(body.action) < 0) {
      lock = LockService.getScriptLock()
      try {
        lock.waitLock(10000)
      } catch (lockErr) {
        lock = null
        // まだ何も処理していないので、フロントは少し待ってから送り直してよい
        return jsonOutput({ ok: false, error: '混み合っています。少し待って再度お試しください。', retryLater: true })
      }
    }

    // 送り直された書き込み(同じ requestId)は、処理をやり直さずに前回の結果を返す。
    // ロックを取った後に確かめるので、同じ ID の2本目は1本目の結果を受け取る
    replayKey = requestReplayKey(actingMember.id, body)
    if (replayKey) {
      var prior = readRequestReplay(replayKey)
      if (prior) {
        replayKey = null
        if (prior.inFlight) return jsonOutput({ ok: false, error: '同じ操作を処理しています。少し待ってください。', retryLater: true })
        return jsonOutput(prior)
      }
      markRequestInFlight(replayKey)
    }

    switch (body.action) {
      case 'createTasks':
        // F1: creator_id はクライアントの値ではなく認証済みの本人IDを使う
        result = createTasks(body.tasks, actingMember.id)
        break
      case 'updateTaskStatus':
        // body.status は入口でコードにそろえている(normalizeRequestCodes)
        result = updateTaskFields(body.taskId, {
          status: sheetCode('status', body.status),
          last_activity: todayStr(),
          completed_date: body.status === 'done' ? todayStr() : '',
        })
        // the assignee's "I'm done" signal — email the admins so they know
        // to go confirm it (they already see it in their 確認待ち panel)
        if (body.status === 'review') notifyReview(body.taskId)
        break
      case 'assignTask':
        result = updateTaskFields(body.taskId, {
          assignee_id: (body.assigneeIds || []).join(','),
        })
        syncCalendarForTask(body.taskId)
        break
      case 'applyToOpenBid':
        // TSK-027: 公募タスクへの応募(承認制)。担当者(assignee_id)には
        // 触れず、応募者リストのみ更新する
        result = updateTaskFields(body.taskId, {
          open_bid_applicant_ids: (body.applicantIds || []).join(','),
        })
        break
      case 'updatePriority':
        result = updateTaskFields(body.taskId, { priority: sheetCode('priority', body.priority) })
        break
      case 'updateDifficulty':
        result = updateTaskFields(body.taskId, { difficulty: sheetCode('difficulty', body.difficulty) })
        break
      case 'updateTaskDetails':
        result = updateTaskFields(body.taskId, {
          title: body.name,
          description: body.description || '',
          project_id: body.projectId,
          department: sheetValue('department', body.department),
          category: body.category,
          skills: (body.skills || []).join(','),
          difficulty: sheetCode('difficulty', body.difficulty),
          priority: sheetCode('priority', body.priority),
          visibility: sheetCode('visibility', body.visibility),
          importance: sheetCode('importance', body.importance),
          required_skill_levels_json: JSON.stringify(body.requiredSkillLevels || {}),
        })
        break
      case 'updateProgress':
        // TSK-010: progressPercent単独更新(スライダー操作)にも相乗りさせる。
        // body.text/body.progressHistoryが無い場合はその列に触れない
        // (updateTaskFields/updateRowFieldsは渡されたキーのみ部分更新する)
        var progressFields = { last_activity: todayStr() }
        if (body.text !== undefined) progressFields.progress_note = body.text
        if (body.progressHistory !== undefined) progressFields.progress_history_json = JSON.stringify(body.progressHistory)
        if (body.progressPercent !== undefined) progressFields.progress_percent = body.progressPercent
        result = updateTaskFields(body.taskId, progressFields)
        break
      case 'translateText':
        result = translateTexts(body.texts, body.targetLang)
        break
      case 'updateWill':
        result = updateMemberFields(body.memberId, { will_tags: (body.will || []).join(',') })
        try {
          var willMember = findRow(SHEET_MEMBERS, body.memberId)
          var willName = willMember ? (willMember.display_name || willMember.name || '不明') : '不明'
          var willTags = (body.will || []).join('、') || '（タグなし）'
          var willSubject = '[Ohsumi] Will タグが更新されました'
          var willBody = willName + 'さんのWillタグが更新されました。\n\n' +
            '【設定されたWillタグ】\n' + willTags + '\n\n' +
            'Ohsumiの人材画面で確認してください。'
          notifyAdmins(willSubject, willBody)
          notifyChat('💡 ' + willName + 'さんのWillタグが更新されました：' + willTags)
        } catch (err) {
          console.error('updateWillの通知送信に失敗しました: ' + err)
        }
        break
      case 'updateTimezone':
        result = updateMemberFields(body.memberId, { timezone: body.timezone || '' })
        break
      case 'updateLocale':
        result = updateMemberFields(body.memberId, { locale: body.locale || '' })
        break
      case 'updateJudgment':
        result = updateMemberFields(body.memberId, {
          judgment_tags: (body.judgment || []).join(','),
        })
        break
      case 'approveTask':
        result = updateTaskFields(body.taskId, { approval_status: sheetCode('approval', 'approved') })
        break
      case 'notifyTaskRejected':
        // body.taskId は authorizeAction() のスコープチェックで使用済み
        notifyTaskRejected(body.creatorId, body.taskName, body.reason)
        result = { ok: true }
        break
      case 'removeTask':
        result = removeTask(body.taskId)
        break
      case 'createProject':
        result = createProject(body.name, body.description, body.type)
        break
      case 'removeProject':
        result = removeProject(body.projectId)
        break
      case 'removeMember':
        assertTopRemains({ members: (function () { var m = {}; m[String(body.memberId)] = { removed: true }; return m })() })
        result = removeMember(body.memberId)
        break
      case 'updateNotify':
        result = updateMemberFields(body.memberId, {
          notify_new_task: body.notify ? 'TRUE' : 'FALSE',
        })
        break
      case 'updateNotifySettings':
        result = updateMemberFields(body.memberId, {
          notify_settings: JSON.stringify(body.settings),
        })
        break
      case 'updateRole':
        requireKnownRole(body.role)
        assertTopRemains({ members: (function () { var m = {}; m[String(body.memberId)] = { role: body.role }; return m })() })
        result = updateMemberFields(body.memberId, { role: sheetRoleRef(body.role) })
        break
      case 'updateRoles':
        result = updateRoles(actingMember, body.roles)
        break
      case 'deleteRole':
        result = deleteRole(actingMember, body.roleId, body.moveToRoleId)
        break
      case 'updateDepartments':
        result = updateDepartments(body.departments)
        break
      case 'deleteDepartment':
        result = deleteDepartment(body.departmentId)
        break
      case 'moveDepartmentTasks':
        result = moveDepartmentTasks(body.fromDepartmentId, body.toDepartmentId || '')
        break
      case 'updatePermissionOverrides':
        result = updateMemberFields(body.memberId, {
          permission_overrides_json: JSON.stringify(mapOverrideCodes(body.overrides || [], sheetValue)),
        })
        break
      case 'updateReportsTo':
        result = updateMemberFields(body.memberId, { reports_to_id: body.reportsToId || '' })
        break
      case 'updateMentor':
        result = updateMemberFields(body.memberId, { mentor_id: body.mentorId || '' })
        break
      case 'updateDisplayName':
        result = updateMemberFields(body.memberId, { display_name: body.displayName || '' })
        break
      case 'updateJoinedAt':
        result = updateMemberFields(body.memberId, { joined_at: body.joinedAt || '' })
        break
      case 'updateUnavailableDates':
        result = updateMemberFields(body.memberId, {
          unavailable_dates: (body.dates || []).join(','),
        })
        break
      case 'updateAvailableHours':
        result = updateMemberFields(body.memberId, {
          available_hours_json: body.hours ? JSON.stringify(body.hours) : '',
        })
        break
      case 'updateSchedule':
        result = updateTaskFields(body.taskId, {
          start_date: body.startDate || '',
          due_date: body.deadline || '',
        })
        notifyScheduleChange(body.taskId)
        break
      case 'updateDependsOn':
        result = updateTaskFields(body.taskId, {
          depends_on_ids: (body.dependsOnIds || []).join(','),
        })
        break
      case 'updateVisibility':
        result = updateTaskFields(body.taskId, {
          visibility: sheetCode('visibility', body.visibility),
        })
        break
      case 'updateReviewer':
        result = updateTaskFields(body.taskId, { reviewer_id: body.reviewerId || '' })
        break
      case 'updateReviewers':
        result = updateTaskFields(body.taskId, {
          reviewer_ids: (body.reviewerIds || []).join(','),
          reviewer_id: (body.reviewerIds && body.reviewerIds[0]) || '',
          required_approvals: body.requiredApprovals != null ? String(body.requiredApprovals) : '',
        })
        break
      case 'approveTaskReview':
        result = approveTaskReview(body.taskId, actingMember.id, body.comment)
        break
      case 'setBlocker':
        result = updateTaskFields(body.taskId, {
          blocker_note: body.note || '',
          blocker_since: body.note ? body.since || todayStr() : '',
        })
        break
      case 'setHoldReason':
        result = updateTaskFields(body.taskId, {
          hold_reason_note: body.note || '',
          hold_reason_since: body.note ? body.since || todayStr() : '',
        })
        break
      case 'updateDeliverables':
        // F5: javascript:等の危険なURLを保存させない
        ;(body.deliverables || []).forEach(function (d) {
          if (d && d.url && !isSafeHttpUrl(d.url)) {
            throw userError('成果物のURLは http または https で始まるURLのみ登録できます。')
          }
        })
        result = updateTaskFields(body.taskId, {
          deliverables_json: JSON.stringify(body.deliverables || []),
        })
        break
      case 'updateHistory':
        result = updateTaskFields(body.taskId, {
          history_json: JSON.stringify((body.history || []).map(sheetHistoryEntry)),
        })
        break
      case 'updateComments':
        result = updateTaskFields(body.taskId, {
          comments_json: JSON.stringify(body.comments || []),
        })
        break
      case 'notifyMention':
        notifyMention(body.taskId, body.commentText, body.memberIds || [])
        result = { ok: true }
        break
      case 'updateEstimatedHours':
        result = updateTaskFields(body.taskId, {
          estimated_hours: body.hours === null || body.hours === undefined ? '' : body.hours,
        })
        break
      case 'updateActualHours':
        result = updateTaskFields(body.taskId, {
          actual_hours: body.hours === null || body.hours === undefined ? '' : body.hours,
        })
        break
      case 'updateRetrospective':
        result = updateTaskFields(body.taskId, {
          retrospective_json: body.retrospective ? JSON.stringify(body.retrospective) : '',
        })
        break
      case 'updateTaskSchedule':
        result = updateTaskFields(body.taskId, {
          schedule_json: body.schedule ? JSON.stringify(mapScheduleCodes(body.schedule, sheetCode)) : '',
        })
        break
      case 'notifyScheduleResult':
        notifyScheduleResult(body.taskId)
        result = { ok: true }
        break
      case 'updateTaskForm':
        result = updateTaskFields(body.taskId, {
          form_json: body.form ? JSON.stringify(body.form) : '',
        })
        break
      case 'notifyFormResult':
        notifyFormResult(body.taskId)
        result = { ok: true }
        break
      case 'updateProjectMembers':
        result = updateProjectFields(body.projectId, {
          member_ids: (body.memberIds || []).join(','),
        })
        break
      case 'updateProjectOwner':
        result = updateProjectFields(body.projectId, { owner_id: body.ownerId || '' })
        break
      case 'updateProjectParent':
        result = updateProjectFields(body.projectId, { parent_id: body.parentId || '' })
        break
      case 'updateProjectDetails':
        result = updateProjectFields(body.projectId, {
          name: body.name || '',
          description: body.description || '',
          type: body.type || '',
          goal: body.goal || '',
          start_date: body.startDate || '',
          end_date: body.endDate || '',
        })
        break
      case 'updateProjectArchived':
        result = updateProjectFields(body.projectId, {
          archived: body.archived ? 'TRUE' : 'FALSE',
        })
        break
      case 'updateProjectHealth':
        result = updateProjectHealthOverride(body.projectId, body.healthOverride)
        break
      case 'notifyProjectHealth':
        result = notifyProjectHealth(body.projectId, body.health)
        break
      case 'reportProjectHealth':
        // 自動判定の結果を複数プロジェクト分まとめて受け取り、記録の更新と
        // 通知(1通にまとめる)をサーバー側で判断する
        result = reportProjectHealth(body.items)
        break
      case 'updateProjectHealthRecord':
        // item 26(追補): 通知なしでlast_notified_health列だけを更新する
        // （attentionから回復した際、次回の再悪化を確実に再通知するため）
        result = updateProjectFields(body.projectId, { last_notified_health: body.health })
        break
      case 'updateAvatar':
        // choosing a color+initials avatar supersedes any uploaded picture
        result = updateMemberFields(body.memberId, {
          avatar_color: body.avatarColor || '',
          avatar_initials: body.initials || '',
          avatar_url: '',
        })
        break
      case 'uploadAvatar':
        result = uploadAvatar(body.memberId, body.dataUrl, body.filename)
        break
      case 'addMember':
        if (body.role) requireKnownRole(body.role)
        result = addMember(body.name, body.email, body.affiliation, body.role)
        break
      case 'addCandidate':
        result = addCandidate(body.candidate || {})
        break
      case 'updateCandidate':
        result = updateCandidate(body.candidateId, body.fields || {})
        break
      case 'removeCandidate':
        result = removeCandidate(body.candidateId)
        break
      case 'convertCandidateToMember':
        if (body.role) requireKnownRole(body.role)
        result = convertCandidateToMember(body.candidateId, body.role)
        break
      case 'updateEducationInfo':
        result = updateMemberFields(body.memberId, {
          university: body.university || '',
          faculty: body.faculty || '',
          department_name: body.departmentName || '',
          grade_year: body.gradeYear || '',
        })
        break
      case 'updateCustomFields':
        // フロント側（store.tsx）で既存値とマージ済みの完全なオブジェクトを送ってくる
        result = updateMemberFields(body.memberId, {
          custom_fields_json: JSON.stringify(body.customFields || {}),
        })
        break
      case 'updateEmail':
        setMemberEmail(body.memberId, body.email || '')
        result = { updated: true }
        break
      case 'revokeMySessions':
        // 全端末でログアウト(自分): 世代番号を上げ、発行済みのセッションをすべて無効にする
        bumpSessionGeneration(actingMember.id)
        result = { revoked: true }
        break
      case 'revokeMemberSessions':
        // 全端末でログアウト(管理者が他のメンバーに対して)
        if (!findRow(SHEET_MEMBERS, String(body.memberId || ''))) throw userError('メンバーが見つかりません。')
        bumpSessionGeneration(String(body.memberId))
        result = { revoked: true }
        break
      case 'getMyEmails':
        // 自分自身のメールのみ返す(actingMember.idはトークン検証済みなので、
        // クライアントが送るmemberIdを信用する必要が無い — 他人のメールを
        // 覗く抜け道にならない)
        result = { email: getMemberEmailValue(actingMember.id) }
        break
      case 'updateSetting':
        // 役職の設定は updateRoles・deleteRole で変える(最上位の役職の確認があるため)。
        // 移行前の古いタブが今までの設定を書く場合だけ、以前と同じく受け付ける
        if (body.key === 'roles' || (hasRolesSetting() && ROLE_SETTING_KEYS.indexOf(body.key) >= 0)) {
          throw userError('役職の設定は、管理画面の役職の編集から変更してください。')
        }
        if (body.key === 'departments') throw userError('部門の設定は、管理画面の部門の編集から変更してください。')
        result = updateSetting(body.key, sheetSettingValue(body.key, body.value))
        if (ROLE_SETTING_KEYS.indexOf(body.key) >= 0) invalidateRoles()
        break
      case 'uploadOrgLogo':
        result = uploadOrgLogo(body.dataUrl, body.filename)
        break
      case 'updateDiscordWebhookUrl':
        result = updateDiscordWebhookUrl(body.url)
        break
      case 'updateSlackWebhookUrl':
        result = updateSlackWebhookUrl(body.url)
        break
      case 'testDiscordWebhook':
        result = testDiscordWebhook()
        break
      case 'getWebhookStatus':
        result = getWebhookStatus()
        break
      case 'testSlackWebhook':
        result = testSlackWebhook()
        break
      case 'updateMemberProjects':
        result = updateMemberFields(body.memberId, {
          project_ids: (body.projectIds || []).join(','),
        })
        break
      case 'updateMemberInactive':
        if (body.inactive) assertTopRemains({ members: (function () { var m = {}; m[String(body.memberId)] = { inactive: true }; return m })() })
        result = updateMemberFields(body.memberId, { inactive: body.inactive ? 'TRUE' : '' })
        break
      case 'updateMemberDepartmentPath':
        result = updateMemberFields(body.memberId, { department_path: body.departmentPath || '' })
        break
      // ---- タレントマネジメント ----
      case 'updateSearchProfile':
        // 経験年数はjoinedAtからの自動計算に統一したため、years_of_experience
        // 列への書き込みは廃止(列自体は既存データ保持のためシートに残す)
        result = updateMemberFields(body.memberId, {
          has_management_experience: body.hasManagementExperience ? 'TRUE' : 'FALSE',
          desired_areas: (body.desiredAreas || []).join(','),
          desired_skills: (body.desiredSkills || []).join(','), // DEV-002
        })
        break
      case 'updateCareerHistory':
        result = updateMemberFields(body.memberId, {
          career_history_json: JSON.stringify(body.entries || []),
        })
        break
      case 'updateQualifications':
        result = updateMemberFields(body.memberId, {
          qualifications_json: JSON.stringify(body.entries || []),
        })
        break
      case 'updateEvaluationHistory':
        result = updateMemberFields(body.memberId, {
          evaluation_history_json: JSON.stringify(body.entries || []),
        })
        break
      case 'updateTransferHistory':
        result = updateMemberFields(body.memberId, {
          transfer_history_json: JSON.stringify(body.entries || []),
        })
        break
      case 'updateSkillLevels':
        result = updateMemberFields(body.memberId, {
          skill_levels_json: JSON.stringify(body.levels || []),
        })
        break
      case 'updateCompetencies':
        result = updateMemberFields(body.memberId, {
          competencies_json: JSON.stringify(body.competencies || []),
        })
        break
      case 'updateCareerGoals':
        result = updateMemberFields(body.memberId, {
          career_aspiration: body.careerAspiration || '',
          desired_future_role: body.desiredFutureRole || '',
          career_plan: body.careerPlan || '',
        })
        break
      case 'updateTrainingHistory':
        result = updateMemberFields(body.memberId, {
          training_history_json: JSON.stringify(body.entries || []),
        })
        break
      case 'notifyTrainingRequest':
        notifyTrainingRequest(body.memberId, body.trainingName)
        result = { ok: true }
        break
      case 'notifyTrainingDecision':
        notifyTrainingDecision(body.memberId, body.trainingName, body.approved)
        result = { ok: true }
        break
      case 'updateDevelopmentPlan':
        result = updateMemberFields(body.memberId, {
          development_plan_json: JSON.stringify(body.entries || []),
        })
        break
      case 'updateOneOnOnes':
        result = updateMemberFields(body.memberId, {
          one_on_ones_json: JSON.stringify(body.entries || []),
        })
        break
      case 'awardSkillPoints':
        result = awardSkillPoints(body.taskId, body.memberId, body.points || {})
        break
      case 'importPortableRecord':
        result = importPortableRecord(body.memberId, body.skillPoints || {}, body.qualifications || [])
        break
      case 'submitQuizResult':
        result = submitQuizResult(body.quizId, body.memberId, body.answers || [], actingMember)
        break
      case 'submitExpenseApplication':
        result = saveExpenseApplication(body.application, actingMember)
        break
      case 'approveExpenseStep':
        // actingMember.id を使うことでクライアントの自己申告値(body.actorId)による偽装を防ぐ
        result = processExpenseStep(body.applicationId, body.stepId, actingMember.id, 'approved', body.comment)
        break
      case 'rejectExpense':
        result = setExpenseStatus(body.applicationId, 'rejected', body.reason)
        break
      case 'withdrawExpense':
        result = setExpenseStatus(body.applicationId, 'withdrawn', null, actingMember.id)
        break
      case 'returnExpense':
        result = setExpenseStatus(body.applicationId, 'returned', body.reason)
        break
      case 'resubmitExpense':
        // actingMember.id を使うことでクライアントの自己申告値による偽装を防ぐ
        result = resubmitExpense(body.applicationId, body.fields, actingMember.id)
        break
      case 'uploadExpenseReceipt':
        result = uploadExpenseReceipt(body.dataUrl, body.filename)
        break
      case 'uploadSurveyImage':
        result = uploadSurveyImage(body.dataUrl, body.filename)
        break
      case 'submitCustomForm':
        result = saveCustomFormSubmission(body.submission, actingMember)
        break
      case 'approveFormStep':
        // actingMember.id を使うことでクライアントの自己申告値(body.actorId)による偽装を防ぐ
        result = processFormStep(body.submissionId, body.stepId, actingMember.id, 'approved', body.comment)
        break
      case 'rejectFormSubmission':
        result = setFormSubmissionStatus(body.submissionId, 'rejected', body.reason)
        break
      case 'submitDailyReport':
        result = saveDailyReport(body.report, actingMember)
        break
      case 'getExpenses':
        result = getExpenses(actingMember)
        break
      case 'getCandidates':
        result = getCandidates(actingMember)
        break
      case 'getFormSubmissions':
        result = getFormSubmissions(actingMember)
        break
      case 'getFiles':
        result = getFiles(actingMember, body.fileIds)
        break
      case 'fetchDailyReports':
        result = fetchDailyReports()
        break
      case 'bulkUpdateSkills':
        result = bulkUpdateSkillLevels(body.updates || [])
        break
      case 'updateAbsentDates':
        result = updateMemberFields(body.memberId, { absent_dates: (body.dates || []).join(',') })
        break
      case 'updateLastLogin':
        result = updateMemberFields(body.memberId, { last_login: new Date().toISOString() })
        break
      case 'submitSurveyResponse':
        // actingMember.id を使うことでクライアントの自己申告値(body.memberId)による偽装を防ぐ
        result = saveSurveyResponse(actingMember.id, body.answers || {})
        break
      case 'checkAndGenerateRecurringTasks':
        // item 2/TSK-051: クライアント側(誰かがOhsumiを開いた時)とサーバー側
        // 日次トリガー(dailyMaintenance)の両方からこの同じロック付き関数を
        // 呼ぶことで、定期タスクの二重生成を防ぐ
        result = generateRecurringTasksLocked()
        break
      case 'triggerOverdueReminders':
        // NTF-005: 日次トリガー任せだった期限超過リマインドを、管理者が
        // 任意タイミングで手動発火できるようにする
        notifyOverdueTasksToAssignees()
        result = { ok: true }
        break
      default:
        throw userError('Unknown action: ' + body.action)
    }
    return respondAndRemember(replayKey, { ok: true, result: result, session: renewedSession || undefined })
  } catch (err) {
    // F14: userError()で作られた業務上のエラー(目印つき)はそのメッセージを
    // フロントに返す。目印の無い例外(SpreadsheetApp等のApps Scriptサービス
    // が投げるものや、コード内の想定外のバグ)は詳細をLoggerに記録し、
    // フロントには定型メッセージだけを返す(スタックトレース等の内部情報や
    // リクエストの中身・トークンは返さない/ログにも出さない)。
    return respondAndRemember(replayKey, { ok: false, error: toErrorMessage(err) })
  } finally {
    // 書き込みアクション(ロックを取ったもの)の後は、読み取りキャッシュを
    // 無効にするためデータの版を新しくする(失敗した書き込みでも無害)
    if (lock) {
      // ロックを放す前に、シートへの書き込みを確定させる(確定前にロックを放すと、
      // 次にロックを取った実行が更新前の値を読むことがある)
      try { SpreadsheetApp.flush() } catch (flushErr) { /* 書き込みは実行の終了時にも確定する */ }
      bumpDataVersion()
      lock.releaseLock()
    }
  }
}

// ---- Tasks ----------------------------------------------------------------

// New rows are built by walking the sheet's actual header row (see
// gas/README.md for the full column list), so this works regardless of
// column order and leaves any column not listed below blank.
function createTasks(tasks, actingMemberId) {
  var sheet = getSheet(SHEET_TASKS)
  var headers = headerRow(sheet)
  var nextId = nextIntId(sheet, headers)
  var today = todayStr()
  var created = []

  tasks.forEach(function (t) {
    var id = String(nextId++)
    var row = headers.map(function (h) {
      switch (h) {
        case 'id':
          return id
        case 'project_id':
          return t.projectId
        case 'title':
          return t.title
        case 'description':
          return t.description || ''
        case 'status':
          return sheetCode('status', 'todo')
        case 'assign_type':
          return 'open_bid'
        case 'assignee_id':
          return (t.assigneeIds || []).join(',')
        case 'creator_id':
          // F1: クライアントが送ってきた t.creatorId は使わない(なりすまし防止)。
          // 必ず認証済みの本人ID(actingMemberId)を記録する。
          return actingMemberId || ''
        case 'created_at':
          return today
        case 'start_date':
          return t.startDate || ''
        case 'due_date':
          return t.deadline || ''
        case 'due_time':
          return t.dueTime || ''
        case 'visibility':
          return sheetCode('visibility', t.visibility)
        case 'department':
          return sheetValue('department', t.department)
        case 'category':
          return t.category || ''
        case 'skills':
          return (t.skills || []).join(',')
        case 'difficulty':
          return t.difficulty ? sheetCode('difficulty', t.difficulty) : ''
        case 'priority':
          return t.priority ? sheetCode('priority', t.priority) : ''
        case 'last_activity':
          return today
        case 'original_input_id':
          return t.originalInputId || ''
        case 'approval_status':
          return sheetCode('approval', t.pendingApproval === false ? 'approved' : 'pending')
        case 'estimated_hours':
          return t.estimatedHours || ''
        case 'importance':
          return t.importance ? sheetCode('importance', t.importance) : ''
        case 'related_review_task_id':
          return t.relatedReviewTaskId || ''
        default:
          return ''
      }
    })
    // F4: 値を書き込む前に対象列を書式なしテキスト(@)にする
    protectRowFromFormulaInjection(sheet, headers, sheet.getLastRow() + 1, 'Tasks')
    sheet.appendRow(row)
    created.push({ tempId: t.tempId, id: id })
    if (t.assigneeIds && t.assigneeIds.length > 0) syncCalendarForTask(id)
  })

  // template tasks (pendingApproval === false) don't need an approval-queue email
  var needsApproval = tasks.filter(function (t) {
    return t.pendingApproval !== false
  })
  if (needsApproval.length > 0) notifyNewTasks(needsApproval)
  return created
}

function updateTaskFields(taskId, fields) {
  return updateRowFields(SHEET_TASKS, taskId, fields)
}

// 確認者ごとの承認を記録し、requiredApprovals(必要承認数、'all'なら
// 確認者全員)に達したら自動的にstatus: '完了'にする。既に承認済みの
// actorIdが再度呼んでも重複追加しない（冪等）。
// TSK-062+TSK-067統合: commentはレビューフィードバック兼次回への申し送り
// メモとして任意で残せる。既に承認済みの場合は(冪等のため)commentを
// 上書きしない。
function approveTaskReview(taskId, actorId, comment) {
  var task = findRow(SHEET_TASKS, taskId)
  if (!task) throw userError('タスクが見つかりません: ' + taskId)
  var approvals = []
  try { approvals = JSON.parse(task.review_approvals_json || '[]') } catch (_) {}
  var already = approvals.some(function (a) { return a.memberId === actorId })
  if (!already) {
    approvals.push({ memberId: actorId, at: new Date().toISOString(), comment: comment || undefined })
  }
  var reviewerIds = String(task.reviewer_ids || task.reviewer_id || '')
    .split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var needed = task.required_approvals === 'all'
    ? reviewerIds.length
    : (Number(task.required_approvals) || 1)
  var fields = { review_approvals_json: JSON.stringify(approvals), last_activity: todayStr() }
  if (approvals.length >= needed) {
    fields.status = sheetCode('status', 'done')
    fields.completed_date = todayStr()
  }
  var result = updateRowFields(SHEET_TASKS, taskId, fields)
  if (approvals.length >= needed) {
    completeRelatedReviewTasks(taskId)
  }
  return result
}

// APR-007: 元タスクの承認が完了した際、対応する確認タスク（related_review_task_id
// が元タスクのidと一致するタスク）も自動的に完了にする
function completeRelatedReviewTasks(originalTaskId) {
  var sheet = getSheet(SHEET_TASKS)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var relCol = headers.indexOf('related_review_task_id')
  var statusCol = headers.indexOf('status')
  if (relCol < 0 || sheet.getLastRow() <= 1) return
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][relCol] || '') === String(originalTaskId) && normalizeCode('status', rows[i][statusCol]) !== 'done') {
      updateRowFields(SHEET_TASKS, String(rows[i][idCol]), {
        status: sheetCode('status', 'done'),
        completed_date: todayStr(),
        last_activity: todayStr(),
      })
    }
  }
}

function updateProjectFields(projectId, fields) {
  return updateRowFields(SHEET_PROJECTS, projectId, fields)
}

// item 26: 幹部による健康状態の手動上書き。healthOverrideが空/nullなら
// 上書き解除（自動判定に戻す）— この場合はlast_notified_healthは据え置き、
// 通知も送らない。値が指定された場合は、その値が実効的な健康状態になる
// ため、last_notified_healthも更新し、必ず通知を送る（「変更した」という
// 行為自体を都度知らせるため、結果がgoodでも送る）。
function updateProjectHealthOverride(projectId, healthOverride) {
  var value = healthOverride || ''
  var fields = { health_override: value }
  if (value) fields.last_notified_health = value
  var result = updateProjectFields(projectId, fields)
  if (value) {
    notifyProjectHealthChanged(projectId, value, 'に手動で変更されました')
  }
  return result
}

// item 26: 自動判定が変化した（前回通知時と異なる状態になった）際の通知。
// 以前のフロント(1件ずつ送る)との互換のために残している。新しいフロントは
// reportProjectHealth でまとめて送る。健康状態が一度も記録されていない
// プロジェクトは、初回の計算なので記録だけして通知しない。記録が既に同じ状態
// (別の管理者の画面が先に記録・通知した場合など)なら通知しない。比較と記録は
// doPost のロックの中で行うため、同時に呼ばれても二重には通知しない。
function notifyProjectHealth(projectId, health) {
  var project = findRow(SHEET_PROJECTS, projectId)
  var last = project ? String(project.last_notified_health || '').trim() : ''
  var result = updateProjectFields(projectId, { last_notified_health: health })
  if (project && last && last !== health) notifyProjectHealthChanged(projectId, health, 'に変化しました（自動判定）')
  return result
}

var PROJECT_HEALTH_LEVELS = ['good', 'watch', 'attention']
// 1回の reportProjectHealth で受け付けるプロジェクトの数の上限
var REPORT_PROJECT_HEALTH_MAX_ITEMS = 500

// 自動判定の結果(items: [{ projectId, health }])を受け取り、シート上の記録
// (last_notified_health)と比べて、記録の更新と通知を決める。フロントの判定は
// 古いデータに基づく場合があるため、ここでシートの値を読み直して判断する。
//   - 手動上書き(health_override)中のプロジェクト: 何もしない
//   - 記録が空(一度も記録されていない): 初回の計算なので、記録だけして通知しない
//   - attention 以外 → attention: 記録して通知する
//   - attention → attention 以外: 記録だけする(次に悪化した時に再び通知するため)
//   - それ以外: 何もしない
// 通知が必要なプロジェクトが複数あっても、メール・Discord・Slack とも1通にまとめる。
// 記録との比較と記録の更新は、doPost のロック(LockService)の中で行われる
// (このアクションはロックの対象)。複数の管理者がほぼ同時に開いても、後の
// 呼び出しは先の呼び出しが更新した記録と比べるため、同じ変化を二重に通知しない。
function reportProjectHealth(items) {
  if (!Array.isArray(items)) throw userError('健康状態の一覧が不正です。')
  if (items.length > REPORT_PROJECT_HEALTH_MAX_ITEMS) throw userError('一度に送れるプロジェクトの数を超えています。')
  var wanted = {}
  items.forEach(function (item) {
    var id = String((item && item.projectId) || '')
    var health = String((item && item.health) || '')
    if (id && PROJECT_HEALTH_LEVELS.indexOf(health) !== -1) wanted[id] = health
  })

  var sheet = getSheet(SHEET_PROJECTS)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var nameCol = headers.indexOf('name')
  var overrideCol = headers.indexOf('health_override')
  var recordCol = headers.indexOf('last_notified_health')
  if (idCol === -1 || recordCol === -1) {
    throw userError('プロジェクトのシートに last_notified_health 列がありません。setupOhsumi() を実行してください。')
  }
  var lastRow = sheet.getLastRow()
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : []

  var recorded = []
  var notified = []
  rows.forEach(function (r, i) {
    var id = String(r[idCol])
    var health = wanted[id]
    if (!health) return
    if (overrideCol !== -1 && String(r[overrideCol] || '').trim()) return
    var last = String(r[recordCol] || '').trim()
    var notify = false
    if (!last) {
      notify = false
    } else if (health === 'attention' && last !== 'attention') {
      notify = true
    } else if (health !== 'attention' && last === 'attention') {
      notify = false
    } else {
      return
    }
    sheet.getRange(i + 2, recordCol + 1).setValue(health)
    recorded.push(id)
    if (notify) notified.push({ id: id, name: nameCol !== -1 ? String(r[nameCol] || '') : id, health: health })
  })

  if (notified.length > 0) {
    notifyProjectHealthChangedBatch(notified, 'に変化しました（自動判定）')
  }
  return { recorded: recorded, notified: notified.map(function (p) { return p.id }) }
}

function notifyProjectHealthChanged(projectId, health, note) {
  try {
    var project = findRow(SHEET_PROJECTS, projectId)
    if (!project) return
    notifyProjectHealthChangedBatch([{ id: projectId, name: project.name, health: health }], note)
  } catch (err) {
    console.error('notifyProjectHealthChangedの通知送信に失敗しました: ' + err)
  }
}

// チャットの1通に並べるプロジェクトの数の上限(Discord は1通2,000文字まで)
var PROJECT_HEALTH_CHAT_MAX_LINES = 20

// 健康状態が変わったプロジェクト(1件以上)を、メール1通・Discord/Slack 各1通で知らせる。
// projects: [{ id, name, health }]
function notifyProjectHealthChangedBatch(projects, note) {
  try {
    if (!projects || projects.length === 0) return
    var labelsJa = { good: '良好', watch: '要注意', attention: '要対応' }
    var labelsEn = { good: 'Good', watch: 'Needs attention', attention: 'Needs action' }
    var noteEn = note === 'に手動で変更されました'
      ? ' (changed manually)'
      : note === 'に変化しました（自動判定）'
        ? ' (changed automatically)'
        : ''
    var templates
    if (projects.length === 1) {
      var p = projects[0]
      var ja = labelsJa[p.health] || p.health
      var en = labelsEn[p.health] || p.health
      templates = {
        ja: {
          subject: '[Ohsumi] プロジェクト「' + p.name + '」の健康状態: ' + ja,
          body: 'プロジェクト「' + p.name + '」の健康状態が「' + ja + '」' +
            (note || '') + '\n\nOhsumiのダッシュボードで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Project "' + p.name + '" health: ' + en,
          body: 'The health of project "' + p.name + '" is now "' + en + '"' +
            noteEn + '.\n\nCheck the Ohsumi dashboard for details.',
        },
      }
    } else {
      templates = {
        ja: {
          subject: '[Ohsumi] ' + projects.length + '件のプロジェクトの健康状態が変わりました',
          body: '次のプロジェクトの健康状態が変わりました' + (note === 'に変化しました（自動判定）' ? '（自動判定）' : '') + '。\n\n' +
            projects.map(function (x) { return '・「' + x.name + '」: ' + (labelsJa[x.health] || x.health) }).join('\n') +
            '\n\nOhsumiのダッシュボードで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Health changed for ' + projects.length + ' projects',
          body: 'The health of the following projects has changed' + noteEn + '.\n\n' +
            projects.map(function (x) { return '- "' + x.name + '": ' + (labelsEn[x.health] || x.health) }).join('\n') +
            '\n\nCheck the Ohsumi dashboard for details.',
        },
      }
    }
    notifyAdmins(templates)

    if (projects.length === 1) {
      notifyChat('❤️‍🩹 「' + projects[0].name + '」の健康状態: ' + (labelsJa[projects[0].health] || projects[0].health))
    } else {
      var shown = projects.slice(0, PROJECT_HEALTH_CHAT_MAX_LINES)
      var lines = shown.map(function (x) { return '・「' + x.name + '」: ' + (labelsJa[x.health] || x.health) })
      if (projects.length > shown.length) lines.push('ほか ' + (projects.length - shown.length) + ' 件')
      notifyChat('❤️‍🩹 ' + projects.length + '件のプロジェクトの健康状態が変わりました\n' + lines.join('\n'))
    }
  } catch (err) {
    console.error('notifyProjectHealthChangedBatchの通知送信に失敗しました: ' + err)
  }
}

// Emails whoever is flagged notify_new_task=TRUE on Members, falling back
// to every 代表 if nobody opted in (a notification must always go out
// somewhere). Best-effort: a mail failure never fails task creation.
function notifyNewTasks(tasks) {
  var titlesJa = tasks.map(function (t) {
    return '・' + t.title
  })
  var titlesEn = tasks.map(function (t) {
    return '- ' + t.title
  })
  notifyAdmins({
    ja: {
      subject: '[Ohsumi] 新しいタスクが承認待ちです（' + tasks.length + '件）',
      body: '以下のタスクが登録され、承認待ちです。\n\n' +
        titlesJa.join('\n') +
        '\n\nOhsumiの管理画面 > 承認 から確認してください。',
    },
    en: {
      subject: '[Ohsumi] New tasks awaiting approval (' + tasks.length + ')',
      body: 'The following tasks were submitted and are awaiting approval.\n\n' +
        titlesEn.join('\n') +
        '\n\nCheck Ohsumi Admin > Approvals for details.',
    },
  })
}

// Emails the task's designated reviewer(s) (reviewer_ids/reviewer_id) when an
// assignee marks a task 確認待ち (their "I'm done, please confirm" signal).
// Falls back to reportsToEmails(assigneeIds) when no reviewer is set, same as
// before this fix.
function notifyReview(taskId) {
  try {
    var task = findRow(SHEET_TASKS, taskId)
    if (!task) return
    var reviewerIds = String(task.reviewer_ids || task.reviewer_id || '')
      .split(',')
      .map(function (s) { return s.trim() })
      .filter(Boolean)
    var preferredEmails
    if (reviewerIds.length > 0) {
      preferredEmails = memberEmailsByIds(reviewerIds)
    } else {
      var assigneeIds = String(task.assignee_id || '')
        .split(',')
        .map(function (s) { return s.trim() })
        .filter(Boolean)
      preferredEmails = reportsToEmails(assigneeIds)
    }
    notifyAdmins(
      {
        ja: {
          subject: '[Ohsumi] タスクの確認をお願いします',
          body: '「' + task.title + '」が確認待ちになりました。\n\nOhsumiで確認し、問題なければ「完了」にしてください。',
        },
        en: {
          subject: '[Ohsumi] Task ready for your review',
          body: '"' + task.title + '" is now awaiting review.\n\nPlease check it in Ohsumi and mark it "Done" if everything looks good.',
        },
      },
      preferredEmails,
    )
    notifyChat('🔔 「' + task.title + '」が確認待ちになりました。')
  } catch (err) {
    console.error('notifyReviewの通知送信に失敗しました: ' + err)
  }
}

// Shared recipient logic: notify_new_task=TRUE members, or every 代表 if
// nobody opted in. Best-effort — a mail failure is swallowed. When
// `preferredEmails` is given (item 9's "admin of admins" hierarchy — e.g. a
// task's assignee's reports_to_id) those are used instead, still falling
// back to the default set if none resolve to anything.
// デバッグ専用 — Apps Scriptエディタ上部の関数選択ドロップダウンで
// "debugNotifyTest" を選び、実行ボタンを押すと、Executions画面やCloudログを
// 開かなくても、エディタ下部の実行ログにその場で結果が表示される。
// Membersシートの列名/メールアドレス設定・MailAppの残り送信数を確認した上で、
// notifyAdmins() を実際に一度呼び出してテストメールを送る。
function debugNotifyTest() {
  console.log('MailAppの残り送信可能数: ' + MailApp.getRemainingDailyQuota())
  console.log('org_notification_emails: ' + JSON.stringify(orgNotificationEmails()))

  var sheet = getSheet(SHEET_MEMBERS)
  var headers = headerRow(sheet)
  console.log('Membersシートのヘッダー: ' + headers.join(', '))

  var idCol = headers.indexOf('id')
  var notifyCol = headers.indexOf('notify_new_task')
  var roleCol = headers.indexOf('role')
  var emailMap = getAllMemberEmails()
  console.log(
    'MemberEmails件数=' + Object.keys(emailMap).length +
    ', notify_new_task列index=' + notifyCol + ', role列index=' + roleCol,
  )

  if (Object.keys(emailMap).length === 0) {
    console.warn('MemberEmailsシートにメールが1件も登録されていません。個人ページの「アカウント設定」でメンバー各自が登録する必要があります。')
  } else if (idCol !== -1) {
    var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
    rows.forEach(function (r, i) {
      var mid = String(r[idCol])
      console.log(
        (i + 2) + '行目' +
          ': id=' + mid +
          ', email=' +
          JSON.stringify(emailMap[mid] || '') +
          (notifyCol !== -1 ? ', notify_new_task=' + JSON.stringify(r[notifyCol]) : '') +
          (roleCol !== -1 ? ', role=' + JSON.stringify(r[roleCol]) : ''),
      )
    })
  }

  console.log('--- ここから notifyAdmins() を実行します（実際にメールが送信されます）---')
  notifyAdmins('[Ohsumi] テスト通知', 'これは debugNotifyTest() からのテストメールです。届いていれば設定は正常です。')
  console.log('debugNotifyTest: 完了 — 上記の宛先の受信トレイ（迷惑メールフォルダも）を確認してください')
}

// 団体メール（Admin > Tagsで幹部/事業責任者が登録） — 個々のメンバーの
// notify_new_task設定に関わらず、常に全ての管理者向け通知(notifyAdmins)の
// 宛先に含める共有の配信先アドレス。Settingsシートの org_notification_emails
// キーにカンマ区切りで保存される（公開情報のため機密扱いではない）。
function orgNotificationEmails() {
  var raw = getSettingValue('org_notification_emails')
  if (!raw) return []
  return raw
    .split(',')
    .map(function (s) {
      return s.trim()
    })
    .filter(Boolean)
}

function uniqueEmails(list) {
  var seen = {}
  var out = []
  list.forEach(function (email) {
    var key = email.toLowerCase()
    if (email && !seen[key]) {
      seen[key] = true
      out.push(email)
    }
  })
  return out
}

// Returns the notify frequency for a given member + kind.
// Falls back to 'immediate' for kinds not configured yet.
function getNotifyFrequency(memberId, kind) {
  var row = findRow('Members', memberId)
  if (!row) return 'immediate'
  var raw = row.notify_settings
  if (!raw) return 'immediate'
  try {
    var settings = JSON.parse(raw)
    return settings[kind] || 'immediate'
  } catch (e) {
    return 'immediate'
  }
}

// Queues a notification for batch delivery. kind is one of:
// 'new_task' | 'review' | 'mention' | 'rejected' | 'deadline'
// templates: { ja: {subject, body}, en: {subject, body} } — 送信時に受信者の
// localeに応じて出し分ける(sendLocalizedEmail/sendBatchNotifications参照)。
function queueNotification(memberId, kind, templates) {
  var freq = getNotifyFrequency(memberId, kind)
  if (freq === 'none') return
  if (freq === 'immediate') {
    var emails = memberEmailsByIds([memberId])
    if (emails.length > 0) {
      sendLocalizedEmail(emails, templates)
    }
    return
  }
  var key = 'notif_queue_' + memberId
  var props = PropertiesService.getScriptProperties()
  var existing = props.getProperty(key)
  var queue = existing ? JSON.parse(existing) : []
  queue.push({ kind: kind, templates: templates, ts: new Date().toISOString() })
  props.setProperty(key, JSON.stringify(queue))
}

// Time-triggered: send all queued batch notifications.
// Set up a time-based trigger calling this function every hour.
function sendBatchNotifications() {
  var props = PropertiesService.getScriptProperties()
  var allProps = props.getProperties()
  var now = new Date()
  Object.keys(allProps).forEach(function(key) {
    if (!key.startsWith('notif_queue_')) return
    var memberId = key.replace('notif_queue_', '')
    var queue = JSON.parse(allProps[key] || '[]')
    if (queue.length === 0) return

    var emails = memberEmailsByIds([memberId])
    if (emails.length === 0) {
      props.deleteProperty(key)
      return
    }
    // このキューは1メンバー分なので、locale判定も1回で済む
    var locales = localesByEmails(emails)
    var loc = locales[emails[0]] || 'ja'

    // Filter by whether enough time has passed for each item based on member frequency
    var toSend = []
    var toKeep = []
    queue.forEach(function(item) {
      var freq = getNotifyFrequency(memberId, item.kind)
      if (freq === 'none') return
      if (freq === 'immediate') { toSend.push(item); return }
      var hours = freq === '3h' ? 3 : freq === '6h' ? 6 : 24
      var itemTime = new Date(item.ts)
      var elapsed = (now - itemTime) / 3600000
      if (elapsed >= hours) { toSend.push(item) } else { toKeep.push(item) }
    })

    if (toSend.length > 0) {
      var combined = toSend
        .map(function(i) {
          var tpl = i.templates[loc] || i.templates.ja
          return '【' + tpl.subject + '】\n' + tpl.body
        })
        .join('\n\n---\n\n')
      var subject = loc === 'en'
        ? 'Ohsumi Notification Summary (' + toSend.length + ')'
        : 'Ohsumi 通知まとめ (' + toSend.length + '件)'
      sendMail({ to: emails.join(','), subject: subject, body: combined })
    }
    if (toKeep.length > 0) {
      props.setProperty(key, JSON.stringify(toKeep))
    } else {
      props.deleteProperty(key)
    }
  })
}

// ---- メール送信(テスト環境では本来の宛先に送らない) ---------------------------
//
// スクリプトプロパティ TEST_ENVIRONMENT が true の場合は、本来の宛先には送らず、
// スクリプトプロパティ TEST_NOTIFICATION_EMAIL の1つのアドレスにだけ送る
// (件名に [テスト] を付け、本文の先頭に本来の宛先を書く)。未設定の場合は
// 送信せず、実行ログに記録するだけにする。メールの送信は必ずこの関数を通す。

function isTestEnvironment() {
  return PropertiesService.getScriptProperties().getProperty('TEST_ENVIRONMENT') === 'true'
}

function sendMail(options) {
  if (!isTestEnvironment()) {
    MailApp.sendEmail(options)
    return
  }
  var original = [options.to, options.cc, options.bcc].filter(Boolean).join(',')
  var redirect = String(PropertiesService.getScriptProperties().getProperty('TEST_NOTIFICATION_EMAIL') || '').trim()
  if (!redirect) {
    console.log(
      '[テスト環境] メールを送信しませんでした(TEST_NOTIFICATION_EMAIL が未設定)。件名: ' + options.subject +
        ' / 本来の宛先: ' + original,
    )
    return
  }
  var notice = '(テスト環境のため、本来の宛先ではなくこのアドレスに送信しています。本来の宛先: ' + original + ')\n\n'
  var redirected = {}
  Object.keys(options).forEach(function (key) {
    if (key !== 'to' && key !== 'cc' && key !== 'bcc') redirected[key] = options[key]
  })
  redirected.to = redirect
  redirected.subject = '[テスト] ' + options.subject
  redirected.body = notice + (options.body || '')
  if (options.htmlBody) redirected.htmlBody = '<p>' + notice.trim() + '</p>' + options.htmlBody
  MailApp.sendEmail(redirected)
  console.log('[テスト環境] メールを ' + redirect + ' に送信しました。件名: ' + options.subject + ' / 本来の宛先: ' + original)
}

// 呼び出し方は2通り:
//   - 新パターン(多言語対応): notifyAdmins({ ja: {subject, body}, en: {subject, body} }, preferredEmails)
//   - 旧パターン(後方互換、常に日本語): notifyAdmins(subject, body, preferredEmails)
// 第1引数がオブジェクトかどうかで判別する。宛先解決ロジック(opted/reps/
// orgEmailsのフォールバック)自体はどちらのパターンでも共通。
function notifyAdmins(subject, body, preferredEmails) {
  try {
    var templates
    if (subject && typeof subject === 'object') {
      templates = subject
      preferredEmails = body
    } else {
      templates = { ja: { subject: subject, body: body } }
    }
    var orgEmails = orgNotificationEmails()

    if (preferredEmails && preferredEmails.length > 0) {
      var to = uniqueEmails(preferredEmails.concat(orgEmails))
      sendLocalizedEmail(to, templates)
      console.log('notifyAdmins: preferredEmails+orgに送信しました ' + to.join(','))
      return
    }
    var sheet = getSheet(SHEET_MEMBERS)
    var headers = headerRow(sheet)
    var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
    var idCol = headers.indexOf('id')
    var notifyCol = headers.indexOf('notify_new_task')
    var roleCol = headers.indexOf('role')
    var emailMap = getAllMemberEmails()
    if (Object.keys(emailMap).length === 0 && orgEmails.length === 0) {
      console.warn('notifyAdmins: MemberEmailsにメール登録がなく、団体メールも未設定のため送信しませんでした')
      return
    }

    var opted = []
    var reps = []
    if (idCol !== -1) {
      rows.forEach(function (r) {
        var email = emailMap[String(r[idCol])]
        if (!email) return
        var notify = notifyCol !== -1 && /^(true|1|yes)$/i.test(String(r[notifyCol] || ''))
        if (notify) opted.push(email)
        // any admin-level role (i.e. not blank and not "一般") counts as a
        // fallback recipient — role names are freely renamed/added/removed
        // from Admin > Tags, so this can't hardcode a specific role string
        else if (roleCol !== -1 && isAdminRoleRef(getRoles(), r[roleCol])) reps.push(email)
      })
    }
    var recipients = uniqueEmails((opted.length > 0 ? opted : reps).concat(orgEmails))
    if (recipients.length === 0) {
      console.warn(
        'notifyAdmins: 宛先を解決できませんでした（notify_new_task=TRUEのメンバーがおらず、「一般」以外のroleを持つメンバーにメール登録もなく、団体メールも未設定）— 送信しませんでした',
      )
      return
    }

    sendLocalizedEmail(recipients, templates)
    console.log('notifyAdmins: 送信先 ' + recipients.join(','))
  } catch (err) {
    // a mail error shouldn't roll back the caller's action, but log it so
    // it's visible in Executions instead of failing completely silently
    console.error('notifyAdminsの送信に失敗しました: ' + err + (err && err.stack ? '\n' + err.stack : ''))
  }
}

// Resolves the "admin of admins" recipients for a set of assignee member
// ids: each assignee's reports_to_id (if set) mapped to that member's
// email. Returns [] when nobody involved has a reports_to_id set, so
// callers fall back to notifyAdmins' default opted-in/代表 logic.
function reportsToEmails(assigneeIds) {
  try {
    var sheet = getSheet(SHEET_MEMBERS)
    var headers = headerRow(sheet)
    var idCol = headers.indexOf('id')
    var reportsToCol = headers.indexOf('reports_to_id')
    if (idCol === -1 || reportsToCol === -1) return []
    var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
    var emailMap = getAllMemberEmails()

    var byId = {}
    rows.forEach(function (r) {
      byId[String(r[idCol])] = { reportsTo: String(r[reportsToCol] || '').trim() }
    })

    var emails = []
    ;(assigneeIds || []).forEach(function (aid) {
      var m = byId[String(aid)]
      var managerId = m && m.reportsTo
      var managerEmail = managerId && emailMap[managerId]
      if (managerEmail && emails.indexOf(managerEmail) === -1) {
        emails.push(managerEmail)
      }
    })
    return emails
  } catch (err) {
    console.error('reportsToEmailsの処理に失敗しました: ' + err)
    return []
  }
}

// Resolves member ids to their email addresses (skips members with no
// email on file). Used by notifyMention.
function memberEmailsByIds(memberIds) {
  try {
    var emailMap = getAllMemberEmails()
    var emails = []
    ;(memberIds || []).forEach(function (id) {
      var email = emailMap[String(id)]
      if (email) emails.push(email)
    })
    return emails
  } catch (err) {
    console.error('memberEmailsByIdsの処理に失敗しました: ' + err)
    return []
  }
}

// メールアドレス一覧を受け取り、Membersシートを1回スキャンして
// { email: locale } のマップを返す（'en'以外は全て'ja'扱い）。
// 多言語メール送信（sendLocalizedEmail）で、宛先ごとに言語を
// 出し分けるために使う。
function localesByEmails(emails) {
  var result = {}
  if (!emails || emails.length === 0) return result
  var wanted = {}
  emails.forEach(function (e) { wanted[e.toLowerCase()] = true })
  try {
    // まずMemberEmails側で「wantedなメールを持つのはどのmemberIdか」を引く
    // (1人が複数メールをカンマ区切りで登録している場合にも対応)
    var emailSheet = getMemberEmailsSheet()
    var eHeaders = headerRow(emailSheet)
    var eIdCol = eHeaders.indexOf('id')
    var eEmailCol = eHeaders.indexOf('email')
    var eLastRow = emailSheet.getLastRow()
    if (eLastRow < 2) return result
    var eValues = emailSheet.getRange(2, 1, eLastRow - 1, eHeaders.length).getValues()

    var idToMatchedEmails = {}
    eValues.forEach(function (r) {
      var mid = String(r[eIdCol])
      String(r[eEmailCol] || '').split(',').map(function (e) { return e.trim() }).filter(Boolean).forEach(function (e) {
        if (wanted[e.toLowerCase()]) {
          if (!idToMatchedEmails[mid]) idToMatchedEmails[mid] = []
          idToMatchedEmails[mid].push(e)
        }
      })
    })
    if (Object.keys(idToMatchedEmails).length === 0) return result

    // 次にMembers側でそのmemberIdのlocaleを引く
    var sheet = getSheet(SHEET_MEMBERS)
    var headers = headerRow(sheet)
    var idCol = headers.indexOf('id')
    var localeCol = headers.indexOf('locale')
    if (idCol === -1) return result
    var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
    rows.forEach(function (r) {
      var mid = String(r[idCol])
      var matched = idToMatchedEmails[mid]
      if (!matched) return
      var locale = (localeCol !== -1 && r[localeCol] === 'en') ? 'en' : 'ja'
      matched.forEach(function (e) { result[e] = locale })
    })
  } catch (err) {
    console.error('localesByEmailsの処理に失敗しました: ' + err)
  }
  return result
}

// 宛先をlocaleごとにグループ化し、localeごとに言語を出し分けたメールを
// 送信する。templates は { ja: {subject, body}, en: {subject, body} } の形。
// localeが判明しない宛先は'ja'扱い（既存の全メール日本語固定という
// 挙動からの後方互換のため）。
function sendLocalizedEmail(emails, templates) {
  if (!emails || emails.length === 0) return
  var locales = localesByEmails(emails)
  var groups = { ja: [], en: [] }
  emails.forEach(function (e) {
    var loc = locales[e] || 'ja'
    groups[templates[loc] ? loc : 'ja'].push(e)
  })
  Object.keys(groups).forEach(function (loc) {
    var list = groups[loc]
    if (list.length === 0) return
    var tpl = templates[loc] || templates.ja
    sendMail({ to: list.join(','), subject: tpl.subject, body: tpl.body })
  })
}

// Emails members who were @mentioned in a task comment. commentText is
// passed straight from the client (not re-read from the sheet) since the
// comment was just appended in the same request.
// Respects each member's 'mention' frequency setting via queueNotification.
function notifyMention(taskId, commentText, memberIds) {
  try {
    var task = findRow(SHEET_TASKS, taskId)
    if (!task) return
    if (!memberIds || memberIds.length === 0) return
    var templates = {
      ja: {
        subject: '[Ohsumi] コメントでメンションされました',
        body: 'タスク「' + task.title + '」のコメントであなたがメンションされました。\n\n' +
          (commentText || '') +
          '\n\nOhsumiで確認してください。',
      },
      en: {
        subject: '[Ohsumi] You were mentioned in a comment',
        body: 'You were mentioned in a comment on task "' + task.title + '".\n\n' +
          (commentText || '') +
          '\n\nPlease check Ohsumi for details.',
      },
    }
    memberIds.forEach(function(mid) {
      queueNotification(mid, 'mention', templates)
    })
    console.log('notifyMention: 通知キューに登録したmemberIds ' + memberIds.join(','))
  } catch (err) {
    console.error('notifyMentionの処理に失敗しました: ' + err)
  }
}

// 研修申請の承認フロー — a member requesting a training emails their
// reports_to_id manager (falling back to notifyAdmins' default 代表 set),
// mirroring notifyReview's routing.
function notifyTrainingRequest(memberId, trainingName) {
  try {
    var member = findRow(SHEET_MEMBERS, memberId)
    if (!member) return
    var name = member.display_name || member.name || '不明'
    notifyAdmins(
      {
        ja: {
          subject: '[Ohsumi] 研修申請の承認をお願いします',
          body: name + 'さんから研修「' + (trainingName || '') + '」の申請がありました。\n\nOhsumiの人材育成タブから承認/却下してください。',
        },
        en: {
          subject: '[Ohsumi] Training request awaiting approval',
          body: name + ' has requested training "' + (trainingName || '') + '".\n\nPlease approve or reject it from the Ohsumi Training tab.',
        },
      },
      reportsToEmails([memberId]),
    )
    notifyChat('📚 ' + name + 'さんから研修「' + (trainingName || '') + '」の申請がありました。')
  } catch (err) {
    console.error('notifyTrainingRequestの通知送信に失敗しました: ' + err)
  }
}

// 承認しない（却下） — 却下されたタスクは removeTask で削除されるため、
// タスク名は削除前にクライアント側から渡してもらう（削除後だと
// findRowで引けなくなるため）。best-effort。
function notifyTaskRejected(creatorId, taskName, reason) {
  try {
    if (!creatorId) return
    var emails = memberEmailsByIds([creatorId])
    if (emails.length === 0) {
      console.warn('notifyTaskRejected: creatorId ' + creatorId + ' のメール登録がないため送信しませんでした')
      return
    }
    sendLocalizedEmail(emails, {
      ja: {
        subject: '[Ohsumi] タスクが承認されませんでした',
        body:
          '登録した「' + (taskName || '') + '」は承認されませんでした。\n\n' +
          (reason ? '理由: ' + reason + '\n\n' : '') +
          'Ohsumiで確認してください。',
      },
      en: {
        subject: '[Ohsumi] Your task was not approved',
        body:
          'The task "' + (taskName || '') + '" you submitted was not approved.\n\n' +
          (reason ? 'Reason: ' + reason + '\n\n' : '') +
          'Please check Ohsumi for details.',
      },
    })
    console.log('notifyTaskRejected: 送信先 ' + emails.join(','))
  } catch (err) {
    console.error('notifyTaskRejectedの通知送信に失敗しました: ' + err)
  }
}

// Notifies the requester once their training request is approved/rejected.
function notifyTrainingDecision(memberId, trainingName, approved) {
  try {
    var emails = memberEmailsByIds([memberId])
    if (emails.length === 0) {
      console.warn('notifyTrainingDecision: memberId ' + memberId + ' のメール登録がないため送信しませんでした')
      return
    }
    sendLocalizedEmail(emails, {
      ja: {
        subject: '[Ohsumi] 研修申請が' + (approved ? '承認' : '却下') + 'されました',
        body:
          '研修「' + (trainingName || '') + '」の申請が' + (approved ? '承認' : '却下') + 'されました。\n\nOhsumiで確認してください。',
      },
      en: {
        subject: '[Ohsumi] Your training request was ' + (approved ? 'approved' : 'rejected'),
        body:
          'Your request for training "' + (trainingName || '') + '" was ' + (approved ? 'approved' : 'rejected') + '.\n\nPlease check Ohsumi for details.',
      },
    })
    console.log('notifyTrainingDecision: 送信先 ' + emails.join(','))
  } catch (err) {
    console.error('notifyTrainingDecisionの通知送信に失敗しました: ' + err)
  }
}

// 日程調整ツール — 招待された全員が全候補への回答を終えたタイミングで
// store.tsx から呼ばれ、作成者へ集計結果をメールする。
function notifyScheduleResult(taskId) {
  try {
    var task = findRow(SHEET_TASKS, taskId)
    if (!task || !task.creator_id) return
    var emails = memberEmailsByIds([task.creator_id])
    if (emails.length === 0) {
      console.warn('notifyScheduleResult: creator_id ' + task.creator_id + ' のメール登録がないため送信しませんでした')
      return
    }

    var schedule = null
    try {
      schedule = task.schedule_json ? JSON.parse(task.schedule_json) : null
    } catch (e) {
      schedule = null
    }

    var bodyJa = 'タスク「' + task.title + '」の日程調整で全員の回答が揃いました。\n\n'
    var bodyEn = 'All responses are in for the schedule coordination on task "' + task.title + '".\n\n'
    if (schedule && schedule.candidates) {
      var sheet = getSheet(SHEET_MEMBERS)
      var headers = headerRow(sheet)
      var idCol = headers.indexOf('id')
      var nameCol = headers.indexOf('display_name')
      var altNameCol = headers.indexOf('name')
      var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
      var nameById = {}
      rows.forEach(function (r) {
        var id = String(r[idCol])
        nameById[id] = (nameCol !== -1 && r[nameCol]) || (altNameCol !== -1 && r[altNameCol]) || id
      })
      schedule.candidates.forEach(function (c) {
        bodyJa += '【' + c.label + '】\n'
        bodyEn += '[' + c.label + ']\n'
        ;(schedule.invitedIds || []).forEach(function (mid) {
          var resp = schedule.responses && schedule.responses[mid] && schedule.responses[mid][c.id]
          // 回答は移行前の記号(○△×)・コードのどちらでもよい。表示名は NOTIFY_LABELS
          bodyJa += '  ' + (nameById[mid] || mid) + ': ' + (resp ? notifyLabel('scheduleAnswer', 'ja', resp) : '未回答') + '\n'
          bodyEn += '  ' + (nameById[mid] || mid) + ': ' + (resp ? notifyLabel('scheduleAnswer', 'en', resp) : 'No response') + '\n'
        })
      })
    }
    bodyJa += '\nOhsumiで確認してください。'
    bodyEn += '\nPlease check Ohsumi for details.'

    sendLocalizedEmail(emails, {
      ja: { subject: '[Ohsumi] 日程調整の回答が揃いました', body: bodyJa },
      en: { subject: '[Ohsumi] Schedule coordination responses are complete', body: bodyEn },
    })
    console.log('notifyScheduleResult: 送信先 ' + emails.join(','))
    notifyChat('🗓️ 「' + task.title + '」の日程調整で全員の回答が揃いました。')
  } catch (err) {
    console.error('notifyScheduleResultの通知送信に失敗しました: ' + err)
  }
}

// 汎用フォームツール — 招待された全員が回答を終えたタイミングでstore.tsxから
// 呼ばれ、作成者へ回答結果をメールする。
function notifyFormResult(taskId) {
  try {
    var task = findRow(SHEET_TASKS, taskId)
    if (!task || !task.creator_id) return
    var emails = memberEmailsByIds([task.creator_id])
    if (emails.length === 0) {
      console.warn('notifyFormResult: creator_id ' + task.creator_id + ' のメール登録がないため送信しませんでした')
      return
    }

    var form = null
    try {
      form = task.form_json ? JSON.parse(task.form_json) : null
    } catch (e) {
      form = null
    }

    var bodyJa = 'タスク「' + task.title + '」のフォームで全員の回答が揃いました。\n\n'
    var bodyEn = 'All responses are in for the form on task "' + task.title + '".\n\n'
    if (form && form.fields) {
      var sheet = getSheet(SHEET_MEMBERS)
      var headers = headerRow(sheet)
      var idCol = headers.indexOf('id')
      var nameCol = headers.indexOf('display_name')
      var altNameCol = headers.indexOf('name')
      var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
      var nameById = {}
      rows.forEach(function (r) {
        var id = String(r[idCol])
        nameById[id] = (nameCol !== -1 && r[nameCol]) || (altNameCol !== -1 && r[altNameCol]) || id
      })
      ;(form.invitedIds || []).forEach(function (mid) {
        bodyJa += '【' + (nameById[mid] || mid) + '】\n'
        bodyEn += '[' + (nameById[mid] || mid) + ']\n'
        var resp = (form.responses && form.responses[mid]) || {}
        form.fields.forEach(function (f) {
          var v = resp[f.id]
          var textJa = Array.isArray(v) ? v.join('、') : v || '（未回答）'
          var textEn = Array.isArray(v) ? v.join(', ') : v || '(No response)'
          bodyJa += '  ' + f.label + ': ' + textJa + '\n'
          bodyEn += '  ' + f.label + ': ' + textEn + '\n'
        })
        bodyJa += '\n'
        bodyEn += '\n'
      })
    }
    bodyJa += '\nOhsumiで確認してください。'
    bodyEn += '\nPlease check Ohsumi for details.'

    sendLocalizedEmail(emails, {
      ja: { subject: '[Ohsumi] フォームの回答が揃いました', body: bodyJa },
      en: { subject: '[Ohsumi] Form responses are complete', body: bodyEn },
    })
    console.log('notifyFormResult: 送信先 ' + emails.join(','))
    notifyChat('📝 「' + task.title + '」のフォームで全員の回答が揃いました。')
  } catch (err) {
    console.error('notifyFormResultの通知送信に失敗しました: ' + err)
  }
}

// Emails admins (routed via reportsToEmails when the task's assignees have
// a designated 報告先) when a task's start date / deadline changes from
// the detail drawer.
function notifyScheduleChange(taskId) {
  try {
    var task = findRow(SHEET_TASKS, taskId)
    if (!task) return
    var assigneeIds = String(task.assignee_id || '')
      .split(',')
      .map(function (s) {
        return s.trim()
      })
      .filter(Boolean)
    notifyAdmins(
      {
        ja: {
          subject: '[Ohsumi] タスクの日程が変更されました',
          body: '「' + task.title + '」の日程が変更されました。\n開始日: ' +
            (task.start_date || '未設定') +
            '\n期限: ' +
            (task.due_date || '未設定') +
            '\n\nOhsumiで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Task schedule changed',
          body: 'The schedule for "' + task.title + '" has changed.\nStart date: ' +
            (task.start_date || 'Not set') +
            '\nDue date: ' +
            (task.due_date || 'Not set') +
            '\n\nPlease check Ohsumi for details.',
        },
      },
      reportsToEmails(assigneeIds),
    )
  } catch (err) {
    console.error('notifyScheduleChangeの通知送信に失敗しました: ' + err)
  }
}

// Creates/updates a Google Calendar event (on this script's default
// calendar) for a task's assignees, inviting them by email if known.
// Best-effort — never throws back to the caller.
function syncCalendarForTask(taskId) {
  try {
    var task = findRow(SHEET_TASKS, taskId)
    if (!task || !task.due_date) return

    var assigneeIds = String(task.assignee_id || '')
      .split(',')
      .map(function (s) {
        return s.trim()
      })
      .filter(Boolean)
    if (assigneeIds.length === 0) return

    var emailMap = getAllMemberEmails()
    var guests = assigneeIds.map(function (aid) { return emailMap[String(aid)] }).filter(Boolean)
    if (guests.length === 0) return

    // テスト環境では招待(メール)を本来の宛先に送らない。予定は作るが、ゲストは付けない
    var eventOptions = isTestEnvironment()
      ? {}
      : { guests: guests.join(','), sendInvites: true }
    if (isTestEnvironment()) {
      console.log('[テスト環境] カレンダーの招待を送りませんでした。予定: ' + task.title + ' / 本来のゲスト: ' + guests.join(','))
    }

    var cal = CalendarApp.getDefaultCalendar()
    var title = '[Ohsumi] ' + task.title
    var existing = cal.getEvents(
      new Date(task.due_date + 'T00:00:00'),
      new Date(task.due_date + 'T23:59:59'),
      { search: title },
    )
    existing.forEach(function (ev) {
      ev.deleteEvent()
    })

    if (task.due_time) {
      var start = new Date(task.due_date + 'T' + task.due_time + ':00')
      var end = new Date(start.getTime() + 60 * 60 * 1000)
      cal.createEvent(title, start, end, eventOptions)
    } else {
      cal.createAllDayEvent(title, new Date(task.due_date + 'T00:00:00'), eventOptions)
    }
  } catch (err) {
    // best-effort — Calendar quota/permissions issues shouldn't break assignment
  }
}

// ---- Projects ---------------------------------------------------------------

function createProject(name, description, type, parentId) {
  var sheet = getSheet(SHEET_PROJECTS)
  var headers = headerRow(sheet)
  var id = String(nextIntId(sheet, headers))
  var row = headers.map(function (h) {
    if (h === 'id') return id
    if (h === 'name') return name
    if (h === 'description') return description || ''
    if (h === 'type') return type || ''
    if (h === 'parent_id') return parentId || ''
    return ''
  })
  protectRowFromFormulaInjection(sheet, headers, sheet.getLastRow() + 1, 'Projects')
  sheet.appendRow(row)
  return { id: id }
}

// Deletes a project and cascades: a task can't exist without a project
// (see lib/ohsumi/types.ts's Task.projectId, which is required), so its
// tasks are removed too, not just unassigned like removeMember does for
// members. Any admin scoped to this project (see project_ids) has it
// dropped from their scope so they don't end up referencing a dead id.
function removeProject(projectId) {
  var projects = getSheet(SHEET_PROJECTS)
  var projectHeaders = headerRow(projects)
  var idCol = projectHeaders.indexOf('id') + 1
  var lastRow = projects.getLastRow()
  var ids = idCol > 0 ? projects.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(projectId)) {
      projects.deleteRow(i + 2)
      break
    }
  }

  var tasks = getSheet(SHEET_TASKS)
  var taskHeaders = headerRow(tasks)
  var projectCol = taskHeaders.indexOf('project_id') + 1
  if (projectCol > 0) {
    var taskLastRow = tasks.getLastRow()
    var projectIds =
      taskLastRow > 1 ? tasks.getRange(2, projectCol, taskLastRow - 1, 1).getValues() : []
    // walk bottom-to-top so deleting a row doesn't shift the indices of
    // rows still to be checked
    for (var j = projectIds.length - 1; j >= 0; j--) {
      if (String(projectIds[j][0]) === String(projectId)) {
        tasks.deleteRow(j + 2)
      }
    }
  }

  var members = getSheet(SHEET_MEMBERS)
  var memberHeaders = headerRow(members)
  var projIdsCol = memberHeaders.indexOf('project_ids') + 1
  if (projIdsCol > 0) {
    var memberLastRow = members.getLastRow()
    var memberProjectIds =
      memberLastRow > 1 ? members.getRange(2, projIdsCol, memberLastRow - 1, 1).getValues() : []
    for (var k = 0; k < memberProjectIds.length; k++) {
      var list = String(memberProjectIds[k][0] || '')
        .split(',')
        .map(function (s) {
          return s.trim()
        })
        .filter(Boolean)
      if (list.indexOf(String(projectId)) !== -1) {
        var next = list.filter(function (id) {
          return id !== String(projectId)
        })
        members.getRange(k + 2, projIdsCol).setValue(next.join(','))
      }
    }
  }

  return { removed: projectId }
}

// Deletes a task outright — distinct from the automatic archive that
// happens client-side 14 days after completion (see visibleTasks/
// archivedTasks in lib/ohsumi/store.tsx), which just hides it, not this,
// which removes the row. Any other task that listed this one in
// depends_on_ids has that reference scrubbed so 依存関係 doesn't point at
// a dead id.
function removeTask(taskId) {
  var tasks = getSheet(SHEET_TASKS)
  var taskHeaders = headerRow(tasks)
  var idCol = taskHeaders.indexOf('id') + 1
  var lastRow = tasks.getLastRow()
  var ids = idCol > 0 ? tasks.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(taskId)) {
      tasks.deleteRow(i + 2)
      break
    }
  }

  var dependsCol = taskHeaders.indexOf('depends_on_ids') + 1
  if (dependsCol > 0) {
    var afterLastRow = tasks.getLastRow()
    var dependsValues =
      afterLastRow > 1 ? tasks.getRange(2, dependsCol, afterLastRow - 1, 1).getValues() : []
    for (var j = 0; j < dependsValues.length; j++) {
      var list = String(dependsValues[j][0] || '')
        .split(',')
        .map(function (s) {
          return s.trim()
        })
        .filter(Boolean)
      if (list.indexOf(String(taskId)) !== -1) {
        var next = list.filter(function (id) {
          return id !== String(taskId)
        })
        tasks.getRange(j + 2, dependsCol).setValue(next.join(','))
      }
    }
  }

  return { removed: taskId }
}

// ---- Members ----------------------------------------------------------------

function updateMemberFields(memberId, fields) {
  return updateRowFields(SHEET_MEMBERS, memberId, fields)
}

// Adds a brand-new member row — used by Admin → Members "メンバーを登録",
// including registering someone directly as an admin (role != 一般).
function addMember(name, email, affiliation, role) {
  var sheet = getSheet(SHEET_MEMBERS)
  var headers = headerRow(sheet)
  var id = String(nextIntId(sheet, headers))
  var row = headers.map(function (h) {
    switch (h) {
      case 'id':
        return id
      case 'name':
        return name
      case 'role':
        return sheetRoleRef(role || baseRoleRef())
      case 'notify_new_task':
        return 'FALSE'
      default:
        return ''
    }
  })
  protectRowFromFormulaInjection(sheet, headers, sheet.getLastRow() + 1, 'Members')
  sheet.appendRow(row)
  // affiliation isn't its own column — it's derived from project_ids (or,
  // for admin roles with none, defaulted client-side), so nothing to store
  // for it here; kept as a param for parity with the client-side call.
  if (email) setMemberEmail(id, email)
  return { id: id }
}

// ---- MemberEmails (非公開シート) ---------------------------------------------
//
// メールアドレスはMembersシート(公開CSV)には置かず、こちらの非公開シートに
// id(=Members.idと同じ値)をキーとして1人1行で保持する。読み書きは必ず
// このセクションの関数経由で行い、Membersシート側に書き戻さないこと。

function getMemberEmailsSheet() {
  return getOrCreateSheet(SHEET_MEMBER_EMAILS, MEMBER_EMAILS_HEADERS)
}

// メンバー1人分のメール(カンマ区切りで複数可、Members.email時代と同じ仕様)を読む。
// 行が無ければ空文字を返す(例外を投げない — 未登録は「メールなし」として扱う)。
function getMemberEmailValue(memberId) {
  var sheet = getMemberEmailsSheet()
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var emailCol = headers.indexOf('email')
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return ''
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(memberId)) return String(values[i][emailCol] || '')
  }
  return ''
}

// メンバー1人分のメールを書く(行が無ければ追加、あれば上書き)。
// ログイン用の対応表のキャッシュ(findMemberIdByEmailCached)を無効にする。
function setMemberEmail(memberId, email) {
  var before = ''
  try { before = getMemberEmailValue(memberId) } catch (e) { before = '' }
  try {
    writeMemberEmail(memberId, email)
    // 登録していたアドレスが外された場合は、そのメンバーのログイン(全端末)を無効にする
    var normalize = function (v) {
      return String(v || '').split(',').map(function (x) { return x.trim().toLowerCase() }).filter(Boolean)
    }
    var after = normalize(email)
    if (normalize(before).some(function (addr) { return after.indexOf(addr) === -1 })) bumpSessionGeneration(memberId)
  } finally {
    bumpMemberEmailsVersion()
  }
}

function writeMemberEmail(memberId, email) {
  var sheet = getMemberEmailsSheet()
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var emailCol = headers.indexOf('email')
  var lastRow = sheet.getLastRow()
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : []
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(memberId)) {
      sheet.getRange(i + 2, emailCol + 1).setValue(email || '')
      return
    }
  }
  appendRowByHeaders(sheet, SHEET_MEMBER_EMAILS, { id: memberId, email: email || '' })
}

// MemberEmailsシート全体を1回読み、{ memberId: email } のマップを返す。
// メール解決が必要な箇所(通知・カレンダー招待・言語判定など)はここから
// 引く — Membersシートはもうemail列を持たない。
function getAllMemberEmails() {
  var sheet = getMemberEmailsSheet()
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var emailCol = headers.indexOf('email')
  var lastRow = sheet.getLastRow()
  var map = {}
  if (lastRow < 2) return map
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  values.forEach(function (r) {
    var email = String(r[emailCol] || '').trim()
    if (email) map[String(r[idCol])] = email
  })
  return map
}

// Saves a profile picture (sent as a data: URL, already resized client-side)
// into the upload folder (see getUploadFolder), makes it link-viewable so it can be
// hotlinked from an <img> tag, replaces any previous upload for this
// member, and records the resulting URL on their Members row.
function uploadAvatar(memberId, dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError('Expected a base64 data URL')
  var mimeType = match[1]
  var base64Data = match[2]

  var folder = getUploadFolder()
  var namePrefix = 'avatar_' + memberId + '_'

  // remove any previous upload for this member so the folder doesn't
  // accumulate orphaned files every time someone changes their picture
  var existing = folder.getFiles()
  while (existing.hasNext()) {
    var f = existing.next()
    if (f.getName().indexOf(namePrefix) === 0) f.setTrashed(true)
  }

  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing(file)

  // googleusercontent.com hotlinks more reliably in <img> tags than
  // Drive's own "uc?export=view" (which can trigger a virus-scan
  // interstitial) or "thumbnail?id=" (rate-limited more aggressively) URLs
  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w256-h256-c'
  console.log('uploadAvatar: memberId=' + memberId + ' url=' + url)
  var writeResult = updateMemberFields(memberId, { avatar_url: url })
  console.log('uploadAvatar: updateMemberFieldsの結果=' + JSON.stringify(writeResult))
  return { url: url }
}

// 団体ロゴをDriveにアップロードし、Settingsシートのorg_logo_urlを更新する。
// uploadAvatarと異なりMembersシートは変更しない。
function uploadOrgLogo(dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError('Expected a base64 data URL')
  var mimeType = match[1]
  var base64Data = match[2]

  var folder = getUploadFolder()
  var namePrefix = 'org_logo_'

  var existing = folder.getFiles()
  while (existing.hasNext()) {
    var f = existing.next()
    if (f.getName().indexOf(namePrefix) === 0) f.setTrashed(true)
  }

  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing(file)

  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w256-h256-c'
  console.log('uploadOrgLogo: url=' + url)
  updateSetting('org_logo_url', url)
  return { url: url }
}

// EXP-003: 経費申請の領収書をDriveにアップロードする。
// アバター/ロゴと異なり1人につき何枚もアップロードされうるため、
// 既存ファイルの削除は行わない。領収書は画像だけでなくPDFのこともあるので
// サムネイルURLではなく汎用のDrive表示URLを返す。
function uploadExpenseReceipt(dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]*);base64,(.*)$/)
  if (!match) throw userError('Expected a base64 data URL')
  var bytes = Utilities.base64Decode(match[2])
  // 領収書は5MBまで、画像(JPEG・PNG・HEICなど)とPDFのみ(フロントでも同じ確認をする)
  var mimeType = validateReceiptFile(match[1], filename, bytes.length)

  var folder = getUploadFolder()
  var namePrefix = 'expense_receipt_'

  var blob = Utilities.newBlob(bytes, mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing(file)

  var url = file.getUrl()
  console.log('uploadExpenseReceipt: url=' + url)
  return { url: url }
}

// FRM-007: アンケート設問の画像をDriveにアップロードする。
// uploadExpenseReceiptと同じパターン(複数枚アップロードされうるため
// 既存ファイルの削除はしない)。ただしこちらは画像専用なので、
// アバターと同じgoogleusercontent.comホットリンク形式のURLを返す。
function uploadSurveyImage(dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError('Expected a base64 data URL')
  var mimeType = match[1]
  var base64Data = match[2]

  var folder = getUploadFolder()
  var namePrefix = 'survey_image_'

  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing(file)

  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w512-h512-c'
  console.log('uploadSurveyImage: url=' + url)
  return { url: url }
}

// Deletes the member's row and clears assignee_id (or removes just their
// id from a multi-assignee list) on every task assigned to them.
function removeMember(memberId) {
  var members = getSheet(SHEET_MEMBERS)
  var memberHeaders = headerRow(members)
  var idCol = memberHeaders.indexOf('id') + 1
  var lastRow = members.getLastRow()
  var ids = idCol > 0 ? members.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(memberId)) {
      members.deleteRow(i + 2)
      break
    }
  }

  var tasks = getSheet(SHEET_TASKS)
  var taskHeaders = headerRow(tasks)
  var assigneeCol = taskHeaders.indexOf('assignee_id') + 1
  if (assigneeCol > 0) {
    var taskLastRow = tasks.getLastRow()
    var assignees = tasks.getRange(2, assigneeCol, Math.max(taskLastRow - 1, 0), 1).getValues()
    for (var j = 0; j < assignees.length; j++) {
      var remaining = String(assignees[j][0] || '')
        .split(',')
        .map(function (s) {
          return s.trim()
        })
        .filter(function (id) {
          return id && id !== String(memberId)
        })
      if (remaining.length !== String(assignees[j][0] || '').split(',').filter(Boolean).length) {
        tasks.getRange(j + 2, assigneeCol).setValue(remaining.join(','))
      }
    }
  }

  // メール行は残るが、ログイン用の対応表のキャッシュは念のため無効にする
  bumpMemberEmailsVersion()
  // 削除したメンバーのログイン(全端末)を無効にする
  bumpSessionGeneration(memberId)
  return { removed: memberId }
}

// ---- Settings (optional key/value sync sheet) ------------------------------

// Upserts one row of the Settings sheet by key. Used for the skill/category/
// role-level option pools and project templates (see gas/README.md) —
// each holds its whole current value (comma list or JSON) in a single cell.
function updateSetting(key, value) {
  var sheet = getOrCreateSheet(SHEET_SETTINGS, ['key', 'value'])
  var headers = headerRow(sheet)
  var keyCol = headers.indexOf('key') + 1
  var valueCol = headers.indexOf('value') + 1
  if (keyCol === 0 || valueCol === 0) throw userError('Settings sheet needs "key" and "value" columns')

  var lastRow = sheet.getLastRow()
  var keys = lastRow > 1 ? sheet.getRange(2, keyCol, lastRow - 1, 1).getValues() : []
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) {
      // F4(レビュー指摘対応2): Settingsは書き込み頻度が低く性能上の懸念が
      // ない上、setupOhsumi()が初期キーを書式設定なしでappendRowするため、
      // Tasks等と違い「行作成時に必ず保護済み」という前提が成り立たない。
      // よって更新のたびに設定する。
      protectRowFromFormulaInjection(sheet, headers, i + 2, 'Settings')
      sheet.getRange(i + 2, valueCol).setValue(value)
      return { key: key }
    }
  }
  var row = headers.map(function (h) {
    if (h === 'key') return key
    if (h === 'value') return value
    return ''
  })
  protectRowFromFormulaInjection(sheet, headers, sheet.getLastRow() + 1, 'Settings')
  sheet.appendRow(row)
  return { key: key }
}

// ---- shared row helpers -----------------------------------------------------

function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) throw userError('Sheet not found: ' + name)
  return sheet
}

// Like getSheet, but creates the tab (with the given header row) instead
// of throwing when it doesn't exist yet — used for the optional Settings
// tab so admins don't have to pre-create it before the first sync.
function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(name)
  if (sheet) return sheet
  sheet = ss.insertSheet(name)
  sheet.appendRow(headers)
  return sheet
}

function headerRow(sheet) {
  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (h) {
      return String(h).trim()
    })
}

function nextIntId(sheet, headers) {
  var idCol = headers.indexOf('id') + 1
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return 1
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues()
  var max = 0
  ids.forEach(function (r) {
    var n = parseInt(r[0], 10)
    if (!isNaN(n) && n > max) max = n
  })
  return max + 1
}

// Reads a whole row (by its "id" column) into a {headerName: value} object.
function findRow(sheetName, rowId) {
  var sheet = getSheet(sheetName)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (idCol === -1) throw userError('シートの構成が不正です。管理者にお問い合わせください。')

  var lastRow = sheet.getLastRow()
  var values = sheet.getRange(2, 1, Math.max(lastRow - 1, 0), headers.length).getValues()
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(rowId)) {
      var obj = {}
      headers.forEach(function (h, c) {
        obj[h] = values[i][c]
      })
      return obj
    }
  }
  return null
}

// Finds the row whose "id" column equals rowId, and writes `fields`
// (a {headerName: value} map) into the matching columns of that row.
// F5: 成果物リンク・経費の領収書URLがhttp/https以外(javascript:等)で
// ないことを保存時に検証する。フロント側の入力時チェック・表示時チェックと
// 同じ基準をサーバー側でも掛ける(フロントを経由しない直接のAPI呼び出しに
// 対する防御)。
function isSafeHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

// F4: 自由入力(ユーザーが自由なテキストを入力できる)列の一覧。数式インジェ
// クション対策として、書き込み前にこれらの列のセルを書式なしテキスト(@)に
// してから値を設定する(セルに値を書き込んだ「後」にsetNumberFormatしても、
// 既に数式として解釈された内容は元に戻らないため、必ず値を書く前に呼ぶこと)。
// _json列・数値列・ID列・日付列・固定選択肢(enum)列はここに含めない
// (JSON文字列は必ず"["か"{"で始まるためSheets側で数式と誤解釈されない)。
// シート名は文字列リテラルで直接指定する — SHEET_EXPENSES等の定数は
// このオブジェクトより後ろで定義されており、スクリプト読み込み時点では
// まだ代入されていないため使えない。
var FORMULA_INJECTION_PROTECTED_COLUMNS = {
  Tasks: ['title', 'description', 'category', 'skills', 'progress_note', 'blocker_note'],
  Projects: ['name', 'description', 'goal'],
  Members: [
    'name', 'display_name', 'career_aspiration', 'desired_future_role', 'career_plan',
    'university', 'faculty', 'department_name', 'will_tags', 'judgment_tags',
    'department_path', 'desired_areas', 'desired_skills',
  ],
  Expenses: ['receipt_url', 'justification', 'purpose', 'rejection_reason'],
  Candidates: ['name', 'phone', 'resume_text', 'interview_notes'],
  DailyReports: ['done_text', 'todo_text', 'issues_text'],
  // value列にはorg_name等の自由入力に加えrole_levels/permission_overrides_json
  // 等のJSON値も入るが、書式なしテキスト化はJSON文字列の読み書きに影響しない
  // (JSON.parseは文字列の内容だけを見るため)ので列全体を対象にする。
  Settings: ['value'],
}

// 指定した行のうち、そのシートで保護対象の列だけを書式なしテキスト(@)にする。
// appendRowで新しい行を追加する「前」に、追加先になる行番号(sheet.getLastRow()+1)
// に対して呼ぶ想定。
function protectRowFromFormulaInjection(sheet, headers, rowNumber, sheetName) {
  var cols = FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName]
  if (!cols) return
  cols.forEach(function (colName) {
    var idx = headers.indexOf(colName)
    if (idx >= 0) sheet.getRange(rowNumber, idx + 1).setNumberFormat('@')
  })
}

// F4(レビュー再確認対応): auditFormulaInjectionRisks()とは別に、既存の
// 全行の保護対象列を書式なしテキスト(@)にするだけの関数。値は一切
// 変更しない(数式として評価されてしまっている値の復元は行わない —
// それはauditFormulaInjectionRisks(true)の役目)。
//
// updateRowFields()は性能上の理由から書き込みのたびに書式を設定し直さ
// なくなったため(行の新規作成時にのみ設定する)、導入前から入っている
// 既存行のうち「現時点では危険な値になっていない行」は書式なしテキスト
// になっていない。この関数はそうした行も含めて対象列を丸ごと書式なし
// テキストにする(値の中身を一切見ないので、確認・レビューなしで何度
// でも安全に実行できる)。setupOhsumi()実行時にも自動的に呼ばれる。
function protectAllExistingRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var summary = []
  Object.keys(FORMULA_INJECTION_PROTECTED_COLUMNS).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName)
    if (!sheet) return
    var headers = headerRow(sheet)
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName].forEach(function (colName) {
      var colIdx = headers.indexOf(colName)
      if (colIdx < 0) return
      sheet.getRange(2, colIdx + 1, lastRow - 1, 1).setNumberFormat('@')
      summary.push(sheetName + '.' + colName + '(' + (lastRow - 1) + '行)')
    })
  })
  console.log(
    '🔒 protectAllExistingRows: 値は変更せず、既存の全行を書式なしテキストにしました: ' +
    (summary.length > 0 ? summary.join(', ') : '対象シートがまだ存在しません'),
  )
}

// F4: 既存データの点検用。Apps Scriptエディタから手動で実行する。
//   auditFormulaInjectionRisks()      … 一覧表示のみ、何も変更しない(既定)
//   auditFormulaInjectionRisks(true)  … 見つかったセルを修正する(下記参照)
// 対象はFORMULA_INJECTION_PROTECTED_COLUMNSに挙げた全シート・全列。
// 「先頭が=+-@の値」に加え、既にSheets側で数式として評価されてしまって
// いるセル(getFormulas()が空でない)も対象にする。
//
// fix=trueの具体的な動作(値を変更しうる点でprotectAllExistingRows()とは
// 性質が異なる):
//   - まだ数式として評価されていない(表示上の文字列がそのまま=+-@で
//     始まっているだけの)セル: 書式を書式なしテキスト(@)にするのみ。
//     セルの表示内容(文字列そのもの)は変更しない。
//   - 既にSheets側で数式として評価されてしまっているセル: 書式なし
//     テキスト(@)にした上で、元の数式の文字列(例: "=1+1")をそのまま
//     リテラルな文字列として書き戻す。これによりセルの表示内容は
//     計算結果(例: "2")から元の入力文字列(例: "=1+1")に変わる
//     (=数式は実行されなくなるが、表示上の値は変化する)。
// 注意: 過去に実際に数式が評価されてしまっていた場合、その時点で
// IMPORTXML等による外部通信が発生していた可能性はこの関数では取り消せない
// (今後の再評価を防ぐことだけができる)。
function auditFormulaInjectionRisks(fix) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var found = []

  Object.keys(FORMULA_INJECTION_PROTECTED_COLUMNS).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName)
    if (!sheet) return
    var headers = headerRow(sheet)
    var idCol = headers.indexOf('id')
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return

    FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName].forEach(function (colName) {
      var colIdx = headers.indexOf(colName)
      if (colIdx < 0) return
      var range = sheet.getRange(2, colIdx + 1, lastRow - 1, 1)
      var values = range.getValues()
      var formulas = range.getFormulas()

      for (var i = 0; i < values.length; i++) {
        var display = String(values[i][0])
        var formula = formulas[i][0]
        var isRisky = /^[=+\-@]/.test(display) || !!formula
        if (!isRisky) continue

        var rowNumber = i + 2
        var idValue = idCol >= 0 ? sheet.getRange(rowNumber, idCol + 1).getValue() : ''
        found.push({
          sheet: sheetName,
          row: rowNumber,
          id: idValue,
          column: colName,
          value: formula || display,
          wasEvaluatedAsFormula: !!formula,
        })

        if (fix) {
          var literal = formula || display
          sheet.getRange(rowNumber, colIdx + 1).setNumberFormat('@').setValue(literal)
        }
      }
    })
  })

  if (fix) {
    console.log('🔧 auditFormulaInjectionRisks: ' + found.length + '件を書式なしテキストに修正しました。')
  } else {
    console.log('🔍 auditFormulaInjectionRisks: ' + found.length + '件の疑わしいセルが見つかりました(変更なし)。修正するには auditFormulaInjectionRisks(true) を実行してください。')
  }
  found.forEach(function (f) {
    console.log(
      '  - ' + f.sheet + ' 行' + f.row + ' (id=' + f.id + ') 列"' + f.column + '"' +
      (f.wasEvaluatedAsFormula ? ' [既に数式として評価済み]' : '') + ': ' + f.value,
    )
  })
  return found
}

function updateRowFields(sheetName, rowId, fields) {
  var sheet = getSheet(sheetName)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id') + 1
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (idCol === 0) throw userError('シートの構成が不正です。管理者にお問い合わせください。')

  var lastRow = sheet.getLastRow()
  var ids = sheet.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues()
  var targetRow = -1
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(rowId)) {
      targetRow = i + 2
      break
    }
  }
  if (targetRow === -1) throw userError(sheetName + ' row not found for id ' + rowId)

  var missingKeys = []
  var matchedCount = 0
  // F4(性能・レビュー指摘対応4): ここでは書式を設定しない。保護対象列は
  // 行の新規作成時に必ずprotectRowFromFormulaInjection()で書式なしテキスト
  // (@)にしてからappendRowしているため、既存行のセルは既にその書式に
  // なっている前提が成り立つ(そうでない過去データはauditFormulaInjectionRisks(true)
  // で一度だけ修正する — gas/README.md参照)。毎回setNumberFormatし直すと
  // 書き込みの多いTasks等で余計なAPI呼び出しが倍になるため省略する。
  Object.keys(fields).forEach(function (key) {
    var col = headers.indexOf(key) + 1
    if (col === 0) {
      missingKeys.push(key)
      return // このシートにまだ無い列 — 個別にはスキップするが、下でまとめて報告する
    }
    sheet.getRange(targetRow, col).setValue(fields[key])
    matchedCount++
  })
  // 更新しようとした列が1つも見つからなかった場合、無音で「成功」を返すと
  // フロント側は保存できたと誤認する（実際は何も書き込まれていない）。
  // 新しい列をCode.gs側に追加しただけでは既存のシートには反映されない
  // （setupOhsumi()の再実行が必要）ため、このケースは実運用で起こりうる。
  if (matchedCount === 0 && missingKeys.length > 0) {
    throw userError(
      sheetName + 'シートに列が見つかりません: ' + missingKeys.join(', ') +
      '。Apps Scriptエディタで setupOhsumi() を実行してヘッダー列を追加してください。',
    )
  }

  return { id: rowId, updated: Object.keys(fields) }
}

function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
}

// ---- 書き込みの送り直し(requestId) --------------------------------------------
//
// フロントは、JSON の応答を受け取れなかった時(結果の転送先 script.googleusercontent.com の
// echo が 404 になった時など)に、少し待ってから同じリクエストを送り直す。GAS の処理は
// 済んでいることがあるため、書き込みにはリクエストごとの ID(requestId)を付けてもらい、
// 同じメンバー・同じ ID の結果を10分覚えておく。送り直された時は処理をやり直さず、
// 前回の結果(replayed: true)を返す。処理中に届いた時は retryLater を返し、もう少し待ってもらう。
var REQUEST_REPLAY_TTL_SEC = 600
var REQUEST_IN_FLIGHT_TTL_SEC = 120
// CacheService の1件の上限(100KB)より小さくする
var REQUEST_REPLAY_MAX_CHARS = 90000

function requestReplayKey(memberId, body) {
  var id = body && body.requestId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  return 'rq:' + memberId + ':' + id
}

function readRequestReplay(key) {
  try {
    var raw = CacheService.getScriptCache().get(key)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

function markRequestInFlight(key) {
  try { CacheService.getScriptCache().put(key, JSON.stringify({ inFlight: true }), REQUEST_IN_FLIGHT_TTL_SEC) } catch (e) { /* 覚えられなくても処理は続ける */ }
}

// 送り直された時に返す応答(新しいセッショントークンは入れない。次のリクエストで改めて受け取る)
function requestReplayValue(obj) {
  var stored = { ok: obj.ok, replayed: true }
  if (obj.ok) stored.result = obj.result
  else stored.error = obj.error
  var text = JSON.stringify(stored)
  if (text.length <= REQUEST_REPLAY_MAX_CHARS) return text
  // 結果が大きすぎて覚えられない: 処理は済んでいることだけを伝える(やり直さない)
  return JSON.stringify({
    ok: false,
    replayed: true,
    error: obj.ok
      ? 'この操作は完了しています。「情報更新」で最新の状態を読み込んでください。'
      : obj.error,
  })
}

function respondAndRemember(key, obj) {
  if (key) {
    try { CacheService.getScriptCache().put(key, requestReplayValue(obj), REQUEST_REPLAY_TTL_SEC) } catch (e) { /* 覚えられなくても応答は返す */ }
  }
  return jsonOutput(obj)
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  )
}

// Reads a single value from the optional Settings sheet (see gas/README.md
// §4.6) by key. Returns '' when the sheet or the key doesn't exist yet
// (nothing configured) — every caller below treats that as "feature off".
function getSettingValue(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_SETTINGS)
  if (!sheet) return ''
  var headers = headerRow(sheet)
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  if (keyCol === -1 || valueCol === -1) return ''
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return ''
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) === key) return String(rows[i][valueCol] || '')
  }
  return ''
}

// ---- 定期タスクの自動生成（サーバー側・日次トリガー + クライアント手動チェック）--
//
// item 2/TSK-051の修正: RecurringTaskRule (Admin > Projects の定期タスク) の
// 生成要否判定・実際の生成をこのLockService付き関数に一本化する。以前は
// サーバー側の日次トリガー(dailyMaintenance)と、クライアント側
// (lib/ohsumi/store.tsx、誰かがOhsumiを開いた時に走る)の両方が、それぞれ
// 独立に「今日まだ生成していないか」を判定・生成していた。公開CSVの
// キャッシュ反映には数分のラグがある(gas/README.mdの既知の制約)ため、
// クライアント側がlastGeneratedDateを更新した直後にサーバー側トリガーが
// 古い値を読んでしまい、同じルールから同日中に2件生成される競合が
// 起きていた。加えてクライアント側の期限計算はtoISOString()（UTC基準）
// を使っており、曜日/日付の判定（ブラウザのローカルタイムゾーン基準）
// とズレて期限が1日早くなることがあった。両方の経路をここへ統一し、
// LockServiceで排他制御することでどちらも解消する。
function generateRecurringTasksLocked() {
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(10000) // 最大10秒待つ。取れなければ諦める(次の呼び出しに任せる)
  } catch (e) {
    console.warn('generateRecurringTasksLocked: ロック取得に失敗、スキップ: ' + e)
    return { generated: [] }
  }
  try {
    var genResult = generateRecurringTasksInternal()
    // 定期タスクを生成した場合は読み取りキャッシュを無効にする
    if (genResult && genResult.generated && genResult.generated.length > 0) bumpDataVersion()
    return genResult
  } finally {
    lock.releaseLock()
  }
}

// 実際の生成ロジック(generateRecurringTasksLocked()がロックを取得した状態で
// のみ呼ぶこと)。getSettingValue/updateSettingはSettingsシートを直接
// 読み書きするため(getSettingValue参照)、クライアントが読む公開CSVの
// キャッシュ遅延の影響を受けない。戻り値のgeneratedにcreateTasks()の
// 戻り値({tempId, id}[])をそのまま含めるので、呼び出し元(クライアント)は
// 生成されたタスクのidを個別に組み立てる必要がなく、そのままrefreshAll()
// 等で全体を再取得すればよい。
function generateRecurringTasksInternal() {
  var raw = getSettingValue(SETTINGS_KEY_RECURRING_RULES)
  if (!raw) return { generated: [] }
  var rules
  try {
    rules = JSON.parse(raw)
  } catch (err) {
    return { generated: [] } // malformed value — don't let a bad cell break the trigger
  }
  if (!rules || rules.length === 0) return { generated: [] }

  var now = new Date()
  var today = todayStr()
  var dow = now.getDay()
  var dom = now.getDate()
  var changed = false
  var generated = []

  rules.forEach(function (rule) {
    if (!rule.active || rule.lastGeneratedDate === today) return
    var due = rule.frequency === 'weekly' ? rule.dayOfWeek === dow : rule.dayOfMonth === dom
    if (!due) return

    // isolate each rule — one bad rule (e.g. a stale projectId, a transient
    // Sheets error) must not abort the whole daily trigger and skip both
    // the remaining rules' lastGeneratedDate writes and the overdue-task
    // Discord sweep that runs after this function in dailyMaintenance()
    try {
      var deadline = null
      if (rule.dueInDays != null) {
        var d = new Date(now.getTime() + rule.dueInDays * 86400000)
        deadline = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      }
      // same payload shape/columns the client sends for a recurring-generated
      // task (see store.tsx) — reuses createTasks() so both paths stay in sync
      var created = createTasks([
        {
          tempId: 'recurring-' + rule.id,
          title: rule.name,
          projectId: rule.projectId,
          department: rule.department,
          category: rule.category,
          skills: rule.skills,
          difficulty: rule.difficulty,
          priority: rule.priority,
          deadline: deadline,
          pendingApproval: false,
        },
      ])
      generated = generated.concat(created)
      rule.lastGeneratedDate = today
      changed = true
    } catch (err) {
      // best-effort — skip this rule today, try again on the next run
    }
  })

  if (changed) updateSetting(SETTINGS_KEY_RECURRING_RULES, JSON.stringify(rules))
  return { generated: generated }
}

// One-time setup: open this file in the Apps Script editor, select
// "setupDailyTrigger" in the function dropdown next to ▶ Run, and run it
// once. It installs a daily time-based trigger that drives
// generateRecurringTasksLocked() and the overdue-task Discord sweep below.
// Safe to re-run — it clears any existing trigger for dailyMaintenance first
// so re-running it never creates duplicates that fire the same day twice.
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyMaintenance') ScriptApp.deleteTrigger(t)
  })
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(6).create()
}

// The function the trigger installed by setupDailyTrigger() actually calls.
// Each step is isolated so a failure in one (e.g. generateRecurringTasksLocked
// throwing on a malformed rule) can't also skip the other.
function dailyMaintenance() {
  try {
    generateRecurringTasksLocked()
  } catch (err) {
    // best-effort — still run the overdue sweep below
  }
  notifyOverdueTasksToDiscord()
  notifyOverdueTasksToAssignees()
  try { notifyInactiveMembers() } catch (err) { }
  // 定期タスクの生成などでシートが変わるため、読み取りキャッシュを無効にする
  bumpDataVersion()
}

// 一定期間アクセスのないメンバーを管理者に通知する日次スイープ。
// 同日に既に通知済みのメンバーはスキップ（last_inactive_notified 列で管理）。
function notifyInactiveMembers() {
  var INACTIVE_DAYS = 25
  var thresholdRaw = getSettingValue('inactive_notify_days')
  var threshold = thresholdRaw ? (parseInt(thresholdRaw, 10) || INACTIVE_DAYS) : INACTIVE_DAYS

  var sheet = getSheet(SHEET_MEMBERS)
  if (!sheet || sheet.getLastRow() <= 1) return
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  var nameCol = headers.indexOf('name')
  var inactiveCol = headers.indexOf('inactive')
  var lastLoginCol = headers.indexOf('last_login')
  var lastNotifiedCol = headers.indexOf('last_inactive_notified')
  if (idCol < 0 || lastLoginCol < 0) return

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var now = new Date().getTime()
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var staleMembers = []

  rows.forEach(function(row, i) {
    var inactive = String(row[inactiveCol] || '').trim().toUpperCase()
    if (inactive === 'TRUE') return
    var lastLogin = String(row[lastLoginCol] || '').trim()
    if (!lastLogin) return
    var lastLoginMs = new Date(lastLogin).getTime()
    if (isNaN(lastLoginMs)) return
    var days = Math.floor((now - lastLoginMs) / 86400000)
    if (days < threshold) return
    // 当日既に通知済みならスキップ
    var lastNotified = lastNotifiedCol >= 0 ? String(row[lastNotifiedCol] || '').trim() : ''
    if (lastNotified === todayStr) return
    staleMembers.push({ rowIdx: i + 2, name: String(row[nameCol] || ''), lastLogin: lastLogin, days: days })
  })

  if (staleMembers.length === 0) return

  // 通知済み日付を記録
  if (lastNotifiedCol >= 0) {
    staleMembers.forEach(function(m) {
      sheet.getRange(m.rowIdx, lastNotifiedCol + 1).setValue(todayStr)
    })
  }

  var linesJa = staleMembers.map(function(m) {
    return '・' + m.name + '（最終ログイン: ' + m.lastLogin.slice(0, 10) + '、' + m.days + '日経過）'
  })
  var linesEn = staleMembers.map(function(m) {
    return '- ' + m.name + ' (last login: ' + m.lastLogin.slice(0, 10) + ', ' + m.days + ' days ago)'
  })
  notifyAdmins({
    ja: {
      subject: 'Ohsumi: ' + staleMembers.length + '名のメンバーが' + threshold + '日以上未ログインです',
      body: '以下のメンバーが ' + threshold + ' 日以上 Ohsumi にログインしていません:\n\n' + linesJa.join('\n') + '\n\nOhsumi管理画面から状況を確認してください。',
    },
    en: {
      subject: 'Ohsumi: ' + staleMembers.length + ' member(s) inactive for ' + threshold + '+ days',
      body: 'The following members have not logged in to Ohsumi for ' + threshold + '+ days:\n\n' + linesEn.join('\n') + '\n\nPlease check the Ohsumi admin screen for details.',
    },
  })
  notifyChat('⚠️ ' + staleMembers.length + '名のメンバーが' + threshold + '日以上未ログインです。Ohsumiで確認してください。')
}

// 期限超過タスクを担当者本人に個別メール通知する日次スイープ。
// notifyOverdueTasksToDiscord() と同じ期限超過タスクを洗い出し、
// assignee_id（カンマ区切り複数可）を分解して担当者ごとに1通まとめる。
// 通知頻度は各担当者の notify_settings['deadline'] で制御。
// メールアドレス未登録の担当者はスキップし処理継続（best-effort）。
function notifyOverdueTasksToAssignees() {
  try {
    var sheet = getSheet(SHEET_TASKS)
    var headers = headerRow(sheet)
    var titleCol = headers.indexOf('title')
    var dueCol = headers.indexOf('due_date')
    var statusCol = headers.indexOf('status')
    var assigneeCol = headers.indexOf('assignee_id')
    if (titleCol === -1 || dueCol === -1 || statusCol === -1 || assigneeCol === -1) return
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    var today = todayStr()

    // 期限超過タスクを担当者IDごとに集約
    var byAssignee = {}
    rows.forEach(function (r) {
      var due = cellDateStr(r[dueCol])
      var status = String(r[statusCol] || '')
      if (!due || due >= today || normalizeCode('status', status) === 'done') return
      var title = String(r[titleCol] || '')
      var assigneeIds = String(r[assigneeCol] || '')
        .split(',')
        .map(function (s) { return s.trim() })
        .filter(Boolean)
      assigneeIds.forEach(function (aid) {
        if (!byAssignee[aid]) byAssignee[aid] = []
        byAssignee[aid].push({ title: title, due: due })
      })
    })

    var assigneeIds = Object.keys(byAssignee)
    if (assigneeIds.length === 0) return

    assigneeIds.forEach(function (aid) {
      try {
        var tasks = byAssignee[aid]
        var linesJa = tasks.map(function (t) {
          return '・' + t.title + '（期限: ' + t.due + '）'
        })
        var linesEn = tasks.map(function (t) {
          return '- ' + t.title + ' (due: ' + t.due + ')'
        })
        queueNotification(aid, 'deadline', {
          ja: {
            subject: '[Ohsumi] 期限超過タスクのお知らせ（' + tasks.length + '件）',
            body: '担当しているタスクのうち、期限を超過しているものが' + tasks.length + '件あります。\n\n' +
              linesJa.join('\n') +
              '\n\nOhsumiにログインして対応状況を更新してください。',
          },
          en: {
            subject: '[Ohsumi] Overdue task notice (' + tasks.length + ')',
            body: 'You have ' + tasks.length + ' overdue task(s) assigned to you.\n\n' +
              linesEn.join('\n') +
              '\n\nPlease log in to Ohsumi and update their status.',
          },
        })
      } catch (err) {
        // メンバー1人の通知失敗は他のメンバーの処理に影響させない
        console.error('notifyOverdueTasksToAssignees: memberId=' + aid + ' の通知に失敗しました: ' + err)
      }
    })
  } catch (err) {
    console.error('notifyOverdueTasksToAssigneesの処理に失敗しました: ' + err)
  }
}

// ---- Discord Webhook 連携 ---------------------------------------------------
//
// Set the webhook URL from Admin > Tags in the app (gas/README.md §4.7) to
// enable. Deliberately stored in Apps Script's private PropertiesService,
// NOT the Settings sheet — that sheet is published as a public CSV like
// Members/Projects/Tasks, and a webhook URL is a bearer-token-like secret
// (anyone holding it can post to the channel), so it must never round-trip
// through anything publicly readable. There is no doPost action or CSV
// that reads this value back out — write-only by design. Every call below
// is best-effort: a missing/invalid webhook or a Discord-side failure
// never breaks the task action that triggered it.

function getDiscordWebhookUrl() {
  return PropertiesService.getScriptProperties().getProperty(DISCORD_WEBHOOK_PROPERTY_KEY) || ''
}

// Changing this is otherwise invisible (write-only, see the block comment
// above) — email the usual admin recipients so a change is at least
// noticed/auditable, the same way every other admin-only action in this
// file is observable through its effect on the sheet.
function updateDiscordWebhookUrl(url) {
  // F12: 本物のDiscord Webhook URL以外(内部ネットワークのURL等、SSRFの
  // 踏み台になり得るもの)を保存させない。空文字(削除)は許可する。
  if (url && url.indexOf('https://discord.com/api/webhooks/') !== 0 && url.indexOf('https://discordapp.com/api/webhooks/') !== 0) {
    throw userError('Discord Webhook URLは https://discord.com/api/webhooks/ または https://discordapp.com/api/webhooks/ で始まるURLのみ登録できます。')
  }
  PropertiesService.getScriptProperties().setProperty(DISCORD_WEBHOOK_PROPERTY_KEY, url || '')
  // URLが変わったら前回のテスト送信の結果は無効になる
  clearWebhookTestResult('discord')
  notifyAdmins(
    '[Ohsumi] Discord Webhook URLが変更されました',
    (url ? 'Discord Webhook URLが更新されました。' : 'Discord Webhook URLが削除されました。') +
      '\n\n心当たりがない場合はAdmin → Tagsから確認してください。',
  )
  return { updated: true }
}

var SLACK_WEBHOOK_PROPERTY_KEY = 'slack_webhook_url'

function getSlackWebhookUrl() {
  return PropertiesService.getScriptProperties().getProperty(SLACK_WEBHOOK_PROPERTY_KEY) || ''
}

function updateSlackWebhookUrl(url) {
  // F12: 本物のSlack Webhook URL以外を保存させない。空文字(削除)は許可する。
  if (url && url.indexOf('https://hooks.slack.com/services/') !== 0) {
    throw userError('Slack Webhook URLは https://hooks.slack.com/services/ で始まるURLのみ登録できます。')
  }
  PropertiesService.getScriptProperties().setProperty(SLACK_WEBHOOK_PROPERTY_KEY, url || '')
  clearWebhookTestResult('slack')
  notifyAdmins(
    '[Ohsumi] Slack Webhook URLが変更されました',
    (url ? 'Slack Webhook URLが更新されました。' : 'Slack Webhook URLが削除されました。') +
      '\n\n心当たりがない場合はAdmin → Tagsから確認してください。',
  )
  return { updated: true }
}

// Task titles are free text any member can set (INPUT screen, or the admin
// edit form) — posted verbatim as Discord message content, `allowed_mentions`
// must suppress mention parsing so a title like "@everyone" can't mass-ping
// the configured channel.
// テスト環境(TEST_ENVIRONMENT=true)では、Discord・Slack には投稿せずログだけにする
// (サンプルのデータの期限切れのタスクなどが、毎日投稿されないようにするため)。
// Webhook の動作を確かめたい時だけ、スクリプトプロパティ TEST_ALLOW_CHAT を true にする
function isChatSuppressed() {
  if (!isTestEnvironment()) return false
  return PropertiesService.getScriptProperties().getProperty('TEST_ALLOW_CHAT') !== 'true'
}

function logSuppressedChat(kind, content) {
  console.log('[テスト環境] ' + kind + ' に投稿しませんでした(TEST_ALLOW_CHAT が true ではない): ' +
    String(content).slice(0, 200))
}

function sendDiscordMessage(content) {
  try {
    var url = getDiscordWebhookUrl()
    if (!url) return
    if (isChatSuppressed()) { logSuppressedChat('Discord', content); return }
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }),
      muteHttpExceptions: true,
    })
  } catch (err) {
    // swallow — Discord delivery is best-effort
  }
}

function sendSlackMessage(content) {
  try {
    var url = getSlackWebhookUrl()
    if (!url) return
    if (isChatSuppressed()) { logSuppressedChat('Slack', content); return }
    // @here / @channel / @everyone をゼロ幅スペースで無効化（意図しないメンション防止）
    var safe = String(content).replace(/@(here|channel|everyone)/g, '​$1')
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: safe }),
      muteHttpExceptions: true,
    })
  } catch (err) {
    // swallow — Slack delivery is best-effort
  }
}

function notifyChat(content) {
  sendDiscordMessage(content)
  sendSlackMessage(content)
}

// ---- Webhook接続テスト ------------------------------------------------------
//
// send*Message()はタスク通知に相乗りするbest-effort実装で、例外もHTTPの
// 失敗レスポンスも握りつぶす(muteHttpExceptions:true + try/catchで無視)ため、
// 「本当につながっているか」の確認には使えない。こちらは実際にテスト
// メッセージを送信し、HTTPレスポンスコードを見て成否を判定・例外化する
// (呼び出し元のAdmin → Tags画面で保存直後に呼ばれ、結果がそのままトースト
// 表示される)。

function testDiscordWebhook() {
  var url = getDiscordWebhookUrl()
  if (!url) throw userError('Discord Webhook URLが保存されていません。先にURLを入力して保存してください。')
  var resp = fetchWebhookForTest('discord', url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      content: '✅ Ohsumiとの連携テストです。このメッセージが届いていればDiscordへの通知設定は正常です。',
      allowed_mentions: { parse: [] },
    }),
    muteHttpExceptions: true,
  })
  var code = resp.getResponseCode()
  // Discordの正常応答は204 No Content
  if (code < 200 || code >= 300) {
    recordWebhookTestResult('discord', false, 'HTTP ' + code)
    throw userError('Discordへの送信に失敗しました(HTTP ' + code + ')。Webhook URLが正しいか確認してください。')
  }
  recordWebhookTestResult('discord', true, '')
  return { tested: true }
}

function testSlackWebhook() {
  var url = getSlackWebhookUrl()
  if (!url) throw userError('Slack Webhook URLが保存されていません。先にURLを入力して保存してください。')
  var resp = fetchWebhookForTest('slack', url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      text: '✅ Ohsumiとの連携テストです。このメッセージが届いていればSlackへの通知設定は正常です。',
    }),
    muteHttpExceptions: true,
  })
  var code = resp.getResponseCode()
  // Slack Incoming Webhookの正常応答は200(本文 "ok")
  if (code < 200 || code >= 300) {
    recordWebhookTestResult('slack', false, 'HTTP ' + code)
    throw userError('Slackへの送信に失敗しました(HTTP ' + code + ')。Webhook URLが正しいか確認してください。')
  }
  recordWebhookTestResult('slack', true, '')
  return { tested: true }
}

// タスク名・説明など自由入力テキストの自動翻訳（多言語対応、item: i18n）。
// Google組み込みの LanguageApp.translate() を使うため追加のAPIキー・課金
// 設定は不要。1件ずつ呼ぶとレイテンシが積み上がるため、フロント側
// (lib/ohsumi/translate.ts) が複数テキストをまとめて渡し、ここでバッチ処理
// する。1件の翻訳失敗が他の件に波及しないよう、テキストごとに個別に
// try/catchし、失敗時はその要素だけ原文を返す。
// 無料枠のクォータ超過時もLanguageAppは例外を投げるため、同様に原文
// フォールバックになる。
function translateTexts(texts, targetLang) {
  var list = Array.isArray(texts) ? texts : []
  var lang = targetLang || 'en'
  return list.map(function (text) {
    var s = String(text || '')
    if (!s.trim()) return s
    try {
      return LanguageApp.translate(s, '', lang)
    } catch (err) {
      console.error('translateTexts: "' + s + '" の翻訳に失敗しました: ' + err)
      return s
    }
  })
}

// A cell written as a plain 'yyyy-MM-dd' string can come back from
// getValues() as a Date object instead (Sheets auto-converts date-like
// strings in an unformatted column) — normalize either shape to
// 'yyyy-MM-dd' so string comparisons against todayStr() stay correct.
function cellDateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  return String(v || '')
}

// Daily sweep (see dailyMaintenance/setupDailyTrigger above) — posts one
// message listing every task whose due_date has passed and isn't 完了.
function notifyOverdueTasksToDiscord() {
  try {
    var sheet = getSheet(SHEET_TASKS)
    var headers = headerRow(sheet)
    var titleCol = headers.indexOf('title')
    var dueCol = headers.indexOf('due_date')
    var statusCol = headers.indexOf('status')
    if (titleCol === -1 || dueCol === -1 || statusCol === -1) return
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    var today = todayStr()
    var overdue = rows
      .map(function (r) {
        return { title: r[titleCol], due: cellDateStr(r[dueCol]), status: String(r[statusCol] || '') }
      })
      .filter(function (t) {
        return t.due && t.due < today && normalizeCode('status', t.status) !== 'done'
      })
    if (overdue.length === 0) return
    var lines = overdue.map(function (t) {
      return '・' + t.title + '（期限: ' + t.due + '）'
    })
    notifyChat('⚠️ 期限超過タスクが' + overdue.length + '件あります。\n' + lines.join('\n'))
  } catch (err) {
    // best-effort
  }
}

// Membersシートの avatar_url 書き込みが正常に動くかテストする。
// GASエディタで "debugAvatarWrite" を選び ▶ 実行 → ログで結果を確認。
// 引数の memberId は実際のメンバーIDに変えてから実行すること。
function debugAvatarWrite() {
  var TEST_MEMBER_ID = '1' // ← 実際のメンバーIDに変更してください

  var sheet = getSheet(SHEET_MEMBERS)
  var headers = headerRow(sheet)
  console.log('📋 Membersヘッダー: ' + headers.join(' | '))

  var avatarCol = headers.indexOf('avatar_url')
  console.log('avatar_url 列インデックス: ' + avatarCol + (avatarCol === -1 ? ' ❌ 列が見つかりません' : ' ✅'))

  var idCol = headers.indexOf('id')
  var lastRow = sheet.getLastRow()
  var ids = idCol >= 0 ? sheet.getRange(2, idCol + 1, Math.max(lastRow - 1, 0), 1).getValues() : []
  var found = false
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(TEST_MEMBER_ID)) { found = true; break }
  }
  console.log('メンバーID ' + TEST_MEMBER_ID + ' の行: ' + (found ? '✅ 見つかりました' : '❌ 見つかりません'))

  if (avatarCol !== -1 && found) {
    var testUrl = 'https://example.com/test-avatar.png'
    updateMemberFields(TEST_MEMBER_ID, { avatar_url: testUrl })
    console.log('✅ テスト書き込み完了: avatar_url = ' + testUrl)
    console.log('スプレッドシートで avatar_url 列を確認してください。')
  }
}

// ---- Phase 5: 経費申請 -------------------------------------------------------

var SHEET_EXPENSES = 'Expenses'
var SHEET_FORM_SUBMISSIONS = 'FormSubmissions'

// EXP-005: custom_field_answers_json列を既存シートにも反映させるため、
// Members/Projects/Tasks/Settingsと同じ ensureSheetHeaders パターンに統一
// （旧実装は新規作成時にしかヘッダーを設定していなかった）。
function ensureExpensesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders(ss, SHEET_EXPENSES, EXPENSES_HEADERS)
  return ss.getSheetByName(SHEET_EXPENSES)
}

function ensureFormSubmissionsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders(ss, SHEET_FORM_SUBMISSIONS, FORM_SUBMISSIONS_HEADERS)
  return ss.getSheetByName(SHEET_FORM_SUBMISSIONS)
}

// item 22/30: アンケート回答をMembersシートのsurvey_responses_json列に
// 配列として追記する。新規シートを増やさず、既存の公開CSV(Members)だけで
// 完結させるため。読み込み→配列に追加→書き戻し、という一般的な
// read-modify-writeパターンで、custom_fields_json等の既存列と同じ設計。
function saveSurveyResponse(memberId, answers) {
  var memberRow = findRow(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError('メンバーが見つかりません: ' + memberId)
  var existing = []
  try { existing = JSON.parse(memberRow.survey_responses_json || '[]') } catch (_) {}
  var responseId = Utilities.getUuid()
  existing.push({
    id: responseId,
    submittedAt: new Date().toISOString(),
    answers: answers || {},
  })
  updateMemberFields(memberId, { survey_responses_json: JSON.stringify(existing) })
  return { id: responseId }
}

function saveExpenseApplication(application, acting) {
  // F5: javascript:等の危険なURLを保存させない
  if (application.receiptUrl && !isSafeHttpUrl(application.receiptUrl)) {
    throw userError('領収書URLは http または https で始まるURLのみ登録できます。')
  }
  var sheet = ensureExpensesSheet()
  appendRowByHeaders(sheet, SHEET_EXPENSES, {
    id: application.id,
    applicant_id: application.applicantId,
    amount: application.amount,
    category_id: application.categoryId,
    receipt_url: application.receiptUrl || '',
    justification: application.justification || '',
    purpose: application.purpose || '',
    custom_field_answers_json: JSON.stringify(application.customFieldAnswers || {}),
    approval_steps_json: JSON.stringify(application.approvalSteps || []),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    created_at: application.createdAt || new Date().toISOString(),
    rejection_reason: '',
  })
  // 1次承認者への通知
  var steps = application.approvalSteps || []
  if (steps.length > 0) {
    var firstStep = steps[0]
    var emails = []
    if (firstStep.type === 'member' && firstStep.memberId) {
      emails = memberEmailsByIds([firstStep.memberId])
    }
    sendLocalizedEmail(emails, {
      ja: { subject: 'Ohsumi: 経費申請が届きました', body: '経費申請が届きました。Ohsumiから確認・承認してください。\n\n金額: ¥' + application.amount },
      en: { subject: 'Ohsumi: New expense application received', body: 'A new expense application has been submitted. Please review and approve it in Ohsumi.\n\nAmount: ¥' + application.amount },
    })
  }
  return { id: application.id }
}

// EXP-008: 差し戻された申請を、IDを変えずに更新して再提出する（新規作成ではない）。
function resubmitExpense(applicationId, fields, actorId) {
  var sheet = ensureExpensesSheet()
  var found = findExpenseRow(sheet, applicationId)
  if (!found) throw userError('経費申請が見つかりません: ' + applicationId)

  var headers = found.headers
  var applicantId = String(found.data[headers.indexOf('applicant_id')])
  if (actorId && actorId !== applicantId) {
    throw userError('この経費申請を再提出する権限がありません。')
  }

  fields = fields || {}
  // F5: javascript:等の危険なURLを保存させない
  if (fields.receiptUrl && !isSafeHttpUrl(fields.receiptUrl)) {
    throw userError('領収書URLは http または https で始まるURLのみ登録できます。')
  }
  var approvalSteps = fields.approvalSteps || JSON.parse(String(found.data[headers.indexOf('approval_steps_json')] || '[]'))
  var amount = fields.amount != null ? fields.amount : found.data[headers.indexOf('amount')]

  var updates = {
    amount: amount,
    category_id: fields.categoryId || found.data[headers.indexOf('category_id')],
    receipt_url: fields.receiptUrl || '',
    justification: fields.justification || '',
    purpose: fields.purpose || '',
    custom_field_answers_json: JSON.stringify(fields.customFieldAnswers || {}),
    approval_steps_json: JSON.stringify(approvalSteps),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    rejection_reason: '',
  }
  updateRowFields(SHEET_EXPENSES, applicationId, updates)

  // 1次承認者への通知（新規申請時と同じ）
  if (approvalSteps.length > 0) {
    var firstStep = approvalSteps[0]
    var emails = []
    if (firstStep.type === 'member' && firstStep.memberId) {
      emails = memberEmailsByIds([firstStep.memberId])
    }
    sendLocalizedEmail(emails, {
      ja: { subject: 'Ohsumi: 経費申請が再提出されました', body: '差し戻された経費申請が修正のうえ再提出されました。Ohsumiから確認・承認してください。\n\n金額: ¥' + amount },
      en: { subject: 'Ohsumi: Expense application resubmitted', body: 'A returned expense application has been revised and resubmitted. Please review and approve it in Ohsumi.\n\nAmount: ¥' + amount },
    })
  }
  return { ok: true }
}

function findExpenseRow(sheet, applicationId) {
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0) return null
  var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol]) === applicationId) {
      return { row: i + 2, data: rows[i], headers: headers }
    }
  }
  return null
}

function processExpenseStep(applicationId, stepId, actorId, action, comment) {
  var sheet = ensureExpensesSheet()
  var found = findExpenseRow(sheet, applicationId)
  if (!found) throw userError('経費申請が見つかりません: ' + applicationId)

  var headers = found.headers
  var data = found.data
  var approvalsCol = headers.indexOf('approvals_json')
  var stepIndexCol = headers.indexOf('current_step_index')
  var statusCol = headers.indexOf('status')
  var stepsCol = headers.indexOf('approval_steps_json')

  var approvals = JSON.parse(String(data[approvalsCol] || '[]'))
  var steps = JSON.parse(String(data[stepsCol] || '[]'))
  var currentIdx = Number(data[stepIndexCol]) || 0

  // 3-1: stepId 順序チェック — 現在のステップと一致しない場合は拒否
  var currentStep = steps[currentIdx]
  if (!currentStep || currentStep.id !== stepId) {
    throw userError('指定されたステップは現在の承認ステップではありません。')
  }

  approvals.push({ stepId: stepId, memberId: actorId, at: new Date().toISOString(), action: action, comment: comment || '' })

  var step = steps[currentIdx]
  var stepApprovals = approvals.filter(function(a) { return a.stepId === (step ? step.id : '') && a.action === 'approved' })
  var needed = (step && step.requiredCount === 'all') ? Infinity : (step && typeof step.requiredCount === 'number' ? step.requiredCount : 1)
  var nextIdx = stepApprovals.length >= needed ? currentIdx + 1 : currentIdx
  var newStatus = nextIdx >= steps.length ? 'approved' : 'pending'

  sheet.getRange(found.row, approvalsCol + 1).setValue(JSON.stringify(approvals))
  sheet.getRange(found.row, stepIndexCol + 1).setValue(nextIdx)
  sheet.getRange(found.row, statusCol + 1).setValue(newStatus)

  // 次ステップ承認者への通知
  if (nextIdx > currentIdx && nextIdx < steps.length) {
    var nextStep = steps[nextIdx]
    var notifyIds = []
    if (nextStep && nextStep.type === 'member' && nextStep.memberId) {
      notifyIds = [nextStep.memberId]
    } else if (nextStep && nextStep.type === 'role' && nextStep.role) {
      try {
        var mSheet = getSheet(SHEET_MEMBERS)
        var mHeaders = headerRow(mSheet)
        var mRoleCol = mHeaders.indexOf('role')
        var mIdCol = mHeaders.indexOf('id')
        if (mRoleCol >= 0 && mIdCol >= 0 && mSheet.getLastRow() > 1) {
          var mRows = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, mHeaders.length).getValues()
          mRows.forEach(function(r) {
            if (sameRole(getRoles(), r[mRoleCol], nextStep.role)) notifyIds.push(String(r[mIdCol]))
          })
        }
      } catch(e) {}
    }
    if (notifyIds.length > 0) {
      var nextEmails = memberEmailsByIds(notifyIds)
      sendLocalizedEmail(nextEmails, {
        ja: { subject: 'Ohsumi: 経費承認の依頼', body: '経費申請の承認依頼が届きました。Ohsumiにログインして確認してください。' },
        en: { subject: 'Ohsumi: Expense approval requested', body: 'An expense application is waiting for your approval. Please log in to Ohsumi to review it.' },
      })
      notifyChat('💴 経費申請の承認依頼が届きました（ステップ ' + (nextIdx + 1) + '）。Ohsumiにログインして確認してください。')
    }
  }

  // 申請者への完了通知
  if (newStatus === 'approved') {
    var applicantId = String(data[headers.indexOf('applicant_id')])
    var emails = memberEmailsByIds([applicantId])
    sendLocalizedEmail(emails, {
      ja: { subject: 'Ohsumi: 経費申請が承認されました', body: '経費申請が承認されました。' },
      en: { subject: 'Ohsumi: Expense application approved', body: 'Your expense application has been approved.' },
    })
  }
  return { ok: true }
}

function setExpenseStatus(applicationId, status, reason, actorId) {
  var sheet = ensureExpensesSheet()
  var found = findExpenseRow(sheet, applicationId)
  if (!found) throw userError('経費申請が見つかりません: ' + applicationId)

  var headers = found.headers
  var statusCol = headers.indexOf('status')
  var reasonCol = headers.indexOf('rejection_reason')
  var applicantId = String(found.data[headers.indexOf('applicant_id')])

  // 取り下げは申請者本人のみ
  if (status === 'withdrawn' && actorId && actorId !== applicantId) {
    throw userError('この経費申請を取り下げる権限がありません。')
  }

  sheet.getRange(found.row, statusCol + 1).setValue(status)
  if (reason && reasonCol >= 0) {
    sheet.getRange(found.row, reasonCol + 1).setValue(reason)
  }

  // 取り下げ通知: 現在の承認ステップの担当者に「対応不要」を通知（best-effort）
  if (status === 'withdrawn') {
    try {
      var stepsColW = headers.indexOf('approval_steps_json')
      var stepIdxColW = headers.indexOf('current_step_index')
      if (stepsColW >= 0 && stepIdxColW >= 0) {
        var stepsW = JSON.parse(String(found.data[stepsColW] || '[]'))
        var stepIdxW = Number(found.data[stepIdxColW]) || 0
        var currentStepW = stepsW[stepIdxW]
        var withdrawNotifyIds = []
        if (currentStepW) {
          if (currentStepW.type === 'member' && currentStepW.memberId) {
            withdrawNotifyIds = [currentStepW.memberId]
          } else if (currentStepW.type === 'role' && currentStepW.role) {
            var wSheet = getSheet(SHEET_MEMBERS)
            var wHeaders = headerRow(wSheet)
            var wRoleCol = wHeaders.indexOf('role')
            var wIdCol = wHeaders.indexOf('id')
            if (wRoleCol >= 0 && wIdCol >= 0 && wSheet.getLastRow() > 1) {
              var wRows = wSheet.getRange(2, 1, wSheet.getLastRow() - 1, wHeaders.length).getValues()
              wRows.forEach(function(r) {
                if (sameRole(getRoles(), r[wRoleCol], currentStepW.role)) withdrawNotifyIds.push(String(r[wIdCol]))
              })
            }
          }
        }
        if (withdrawNotifyIds.length > 0) {
          var wEmails = memberEmailsByIds(withdrawNotifyIds)
          sendLocalizedEmail(wEmails, {
            ja: { subject: 'Ohsumi: 経費申請が取り下げられました', body: '経費申請が取り下げられました。この申請への対応は不要です。' },
            en: { subject: 'Ohsumi: Expense application withdrawn', body: 'The expense application has been withdrawn. No action is needed on your part.' },
          })
          notifyChat('💴 経費申請が取り下げられました。この申請への対応は不要です。')
        }
      }
    } catch(eW) { /* best-effort */ }
  }

  // 却下通知
  if (status === 'rejected') {
    var emails = memberEmailsByIds([applicantId])
    sendLocalizedEmail(emails, {
      ja: { subject: 'Ohsumi: 経費申請が却下されました', body: '経費申請が却下されました。\n理由: ' + (reason || '—') },
      en: { subject: 'Ohsumi: Expense application rejected', body: 'Your expense application has been rejected.\nReason: ' + (reason || '—') },
    })
  }

  // EXP-008: 差し戻し通知（却下とは別。修正して再提出できる旨を伝える）
  if (status === 'returned') {
    var rEmails = memberEmailsByIds([applicantId])
    sendLocalizedEmail(rEmails, {
      ja: { subject: 'Ohsumi: 経費申請が差し戻されました', body: '経費申請が差し戻されました。内容を修正のうえ、再提出してください。\n理由: ' + (reason || '—') },
      en: { subject: 'Ohsumi: Expense application returned for revision', body: 'Your expense application has been returned for revision. Please update it and resubmit.\nReason: ' + (reason || '—') },
    })
  }
  return { ok: true }
}

// ---- Phase 5: カスタムフォーム申請 -------------------------------------------

// FRM-005: 1次承認者への通知。経費申請のsaveExpenseApplicationと同じ
// パターンだが、フォーム定義(approvalSteps)はSettingsの
// custom_form_defsから引く必要がある点が経費申請と異なる
// (経費申請はapplication自体にステップのスナップショットを持つ)。
function saveCustomFormSubmission(submission, acting) {
  var sheet = ensureFormSubmissionsSheet()
  appendRowByHeaders(sheet, SHEET_FORM_SUBMISSIONS, {
    id: submission.id,
    form_id: submission.formId,
    submitter_id: submission.submitterId,
    answers_json: JSON.stringify(submission.answers || {}),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    created_at: submission.createdAt || new Date().toISOString(),
    rejection_reason: '',
  })

  var customFormDefs = []
  try {
    var raw = getSettingValue('custom_form_defs')
    if (raw) customFormDefs = JSON.parse(raw)
  } catch (e) {}
  var formDef = customFormDefs.filter(function (f) { return f.id === submission.formId })[0]
  var steps = formDef ? (formDef.approvalSteps || []) : []
  if (steps.length > 0) {
    var firstStep = steps[0]
    var emails = []
    if (firstStep.type === 'member' && firstStep.memberId) {
      emails = memberEmailsByIds([firstStep.memberId])
    } else if (firstStep.type === 'role' && firstStep.role) {
      try {
        var mSheet = getSheet(SHEET_MEMBERS)
        var mHeaders = headerRow(mSheet)
        var mRoleCol = mHeaders.indexOf('role')
        var mIdCol = mHeaders.indexOf('id')
        if (mRoleCol >= 0 && mIdCol >= 0 && mSheet.getLastRow() > 1) {
          var mRows = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, mHeaders.length).getValues()
          var roleIds = []
          mRows.forEach(function (r) {
            if (sameRole(getRoles(), r[mRoleCol], firstStep.role)) roleIds.push(String(r[mIdCol]))
          })
          emails = memberEmailsByIds(roleIds)
        }
      } catch (e2) {}
    }
    var formTitle = formDef ? formDef.title : ''
    sendLocalizedEmail(emails, {
      ja: { subject: 'Ohsumi: 申請フォームが届きました', body: '申請フォームが届きました。Ohsumiから確認・承認してください。\n\nフォーム: ' + formTitle },
      en: { subject: 'Ohsumi: New form submission received', body: 'A new form submission has been received. Please review and approve it in Ohsumi.\n\nForm: ' + formTitle },
    })
  }
  return { id: submission.id }
}

function findFormSubmissionRow(sheet, submissionId) {
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0) return null
  var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol]) === submissionId) {
      return { row: i + 2, data: rows[i], headers: headers }
    }
  }
  return null
}

function processFormStep(submissionId, stepId, actorId, action, comment) {
  var sheet = ensureFormSubmissionsSheet()
  var found = findFormSubmissionRow(sheet, submissionId)
  if (!found) throw userError('フォーム申請が見つかりません: ' + submissionId)

  var headers = found.headers
  var data = found.data
  var approvalsCol = headers.indexOf('approvals_json')
  var stepIndexCol = headers.indexOf('current_step_index')
  var statusCol = headers.indexOf('status')

  var approvals = JSON.parse(String(data[approvalsCol] || '[]'))
  var currentIdx = Number(data[stepIndexCol]) || 0

  // フォーム定義からステップ一覧を取得（Settingsから読む）
  var formId = String(data[headers.indexOf('form_id')])
  var customFormDefs = []
  try {
    var raw = getSettingValue('custom_form_defs')
    if (raw) customFormDefs = JSON.parse(raw)
  } catch(e) {}
  var formDef = customFormDefs.filter(function(f) { return f.id === formId })[0]
  var allSteps = formDef ? (formDef.approvalSteps || []) : []
  var totalSteps = allSteps.length
  var step = allSteps[currentIdx]

  // 3-1: stepId 順序チェック — 現在のステップと一致しない場合は拒否
  if (!step || step.id !== stepId) {
    throw userError('指定されたステップは現在の承認ステップではありません。')
  }

  approvals.push({ stepId: stepId, memberId: actorId, at: new Date().toISOString(), action: action, comment: comment || '' })
  var stepApprovals = approvals.filter(function(a) { return a.stepId === stepId && a.action === 'approved' })

  var needed = (step && step.requiredCount === 'all') ? Infinity : (step && typeof step.requiredCount === 'number' ? step.requiredCount : 1)
  var nextIdx = stepApprovals.length >= needed ? currentIdx + 1 : currentIdx
  var newStatus = nextIdx >= totalSteps ? 'approved' : 'pending'

  sheet.getRange(found.row, approvalsCol + 1).setValue(JSON.stringify(approvals))
  sheet.getRange(found.row, stepIndexCol + 1).setValue(nextIdx)
  sheet.getRange(found.row, statusCol + 1).setValue(newStatus)

  // 次ステップ承認者への通知
  if (nextIdx > currentIdx && nextIdx < totalSteps) {
    var nextFmStep = allSteps[nextIdx]
    var fmNotifyIds = []
    if (nextFmStep && nextFmStep.type === 'member' && nextFmStep.memberId) {
      fmNotifyIds = [nextFmStep.memberId]
    } else if (nextFmStep && nextFmStep.type === 'role' && nextFmStep.role) {
      try {
        var fmMSheet = getSheet(SHEET_MEMBERS)
        var fmMHeaders = headerRow(fmMSheet)
        var fmMRoleCol = fmMHeaders.indexOf('role')
        var fmMIdCol = fmMHeaders.indexOf('id')
        if (fmMRoleCol >= 0 && fmMIdCol >= 0 && fmMSheet.getLastRow() > 1) {
          var fmMRows = fmMSheet.getRange(2, 1, fmMSheet.getLastRow() - 1, fmMHeaders.length).getValues()
          fmMRows.forEach(function(r) {
            if (sameRole(getRoles(), r[fmMRoleCol], nextFmStep.role)) fmNotifyIds.push(String(r[fmMIdCol]))
          })
        }
      } catch(e2) {}
    }
    if (fmNotifyIds.length > 0) {
      var fmNextEmails = memberEmailsByIds(fmNotifyIds)
      if (fmNextEmails.length > 0) {
        sendMail({ to: fmNextEmails.join(','), subject: 'Ohsumi: 申請フォーム承認の依頼', body: '申請フォームの承認依頼が届きました。Ohsumiにログインして確認してください。' })
      }
      notifyChat('📋 申請フォームの承認依頼が届きました（ステップ ' + (nextIdx + 1) + '）。Ohsumiにログインして確認してください。')
    }
  }

  return { ok: true }
}

function setFormSubmissionStatus(submissionId, status, reason) {
  var sheet = ensureFormSubmissionsSheet()
  var found = findFormSubmissionRow(sheet, submissionId)
  if (!found) throw userError('フォーム申請が見つかりません: ' + submissionId)

  var headers = found.headers
  var statusCol = headers.indexOf('status')
  var reasonCol = headers.indexOf('rejection_reason')
  var submitterIdCol = headers.indexOf('submitter_id')

  sheet.getRange(found.row, statusCol + 1).setValue(status)
  if (reason && reasonCol >= 0) sheet.getRange(found.row, reasonCol + 1).setValue(reason)

  // 却下時: 申請者にメール通知（best-effort）
  if (status === 'rejected' && submitterIdCol >= 0) {
    try {
      var submitterId = String(found.data[submitterIdCol] || '')
      if (submitterId) {
        var emails = memberEmailsByIds([submitterId])
        if (emails.length > 0) {
          sendMail({
            to: emails.join(','),
            subject: '[Ohsumi] 申請フォームが却下されました',
            body:
              '申請フォームの申請が却下されました。\n\n' +
              (reason ? '理由: ' + reason + '\n\n' : '') +
              'Ohsumiで確認してください。',
          })
        }
        notifyChat('📋 申請フォームが却下されました。' + (reason ? '（理由: ' + reason + '）' : ''))
      }
    } catch (eR) {
      console.error('setFormSubmissionStatus: 却下通知送信失敗: ' + eR)
    }
  }

  return { ok: true }
}

// ---- 日報・週報 (REP-004/REP-005) -------------------------------------------
// daily-report-screen.tsxはこれまでlocalStorageのみに保存しており、他の
// メンバー・管理者と共有されなかった。Expenses/FormSubmissionsと同じ
// ensureSheetHeadersパターンで専用シートを新設し、保存(submitDailyReport)
// と読み取り(fetchDailyReports)を分ける — 経費申請のように「書き込みは
// GASにあるが読み取りはローカルstateのみ」という状態を繰り返さないよう、
// 管理者の閲覧画面が明示的にfetchDailyReportsを呼ぶ設計にする。

var SHEET_DAILY_REPORTS = 'DailyReports'

function ensureDailyReportsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders(ss, SHEET_DAILY_REPORTS, DAILY_REPORTS_HEADERS)
  return ss.getSheetByName(SHEET_DAILY_REPORTS)
}

// REP-004: 日報・週報の保存(追記のみ)。
function saveDailyReport(report, acting) {
  var sheet = ensureDailyReportsSheet()
  appendRowByHeaders(sheet, SHEET_DAILY_REPORTS, {
    id: report.id,
    member_id: report.memberId,
    type: report.type,
    report_date: report.date,
    done_text: report.done || '',
    todo_text: report.todo || '',
    issues_text: report.issues || '',
    created_at: report.createdAt || new Date().toISOString(),
  })
  return { id: report.id }
}

// REP-005: 管理者が日報・週報の閲覧画面を開いたときに呼ぶ読み取り専用action。
function fetchDailyReports() {
  var sheet = ensureDailyReportsSheet()
  var headers = headerRow(sheet)
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return []

  var idCol = headers.indexOf('id')
  var memberCol = headers.indexOf('member_id')
  var typeCol = headers.indexOf('type')
  var dateCol = headers.indexOf('report_date')
  var doneCol = headers.indexOf('done_text')
  var todoCol = headers.indexOf('todo_text')
  var issuesCol = headers.indexOf('issues_text')
  var createdCol = headers.indexOf('created_at')

  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  return rows.map(function (r) {
    return {
      id: String(r[idCol]),
      memberId: String(r[memberCol]),
      type: r[typeCol],
      date: r[dateCol],
      done: r[doneCol],
      todo: r[todoCol],
      issues: r[issuesCol],
      createdAt: r[createdCol],
    }
  })
}

// ---- 採用支援（入会前の履歴書・面談メモ） -----------------------------------
// 権限はauthorizeAction側でdaihyoOnly + permission_overrides(targetType:'recruiting')
// の個別指定制。読み書きともにExpenses/FormSubmissionsと同じくシート直書き
// パターン（CSV配信は行わない。フロント側はローカルstateで管理する）。

var SHEET_CANDIDATES = 'Candidates'

function ensureCandidatesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders(ss, SHEET_CANDIDATES, CANDIDATES_HEADERS)
  return ss.getSheetByName(SHEET_CANDIDATES)
}

function addCandidate(candidate) {
  var sheet = ensureCandidatesSheet()
  var headers = headerRow(sheet)
  var id = String(nextIntId(sheet, headers))
  var now = new Date().toISOString()
  appendRowByHeaders(sheet, SHEET_CANDIDATES, {
    id: id,
    name: candidate.name || '',
    email: candidate.email || '',
    phone: candidate.phone || '',
    resume_text: candidate.resumeText || '',
    interview_notes: candidate.interviewNotes || '',
    status: candidate.status || 'candidate',
    created_at: now,
    updated_at: now,
  })
  return { id: id }
}

function updateCandidate(candidateId, fields) {
  ensureCandidatesSheet()
  var mapped = {}
  if (fields.name !== undefined) mapped.name = fields.name
  if (fields.email !== undefined) mapped.email = fields.email
  if (fields.phone !== undefined) mapped.phone = fields.phone
  if (fields.resumeText !== undefined) mapped.resume_text = fields.resumeText
  if (fields.interviewNotes !== undefined) mapped.interview_notes = fields.interviewNotes
  if (fields.status !== undefined) mapped.status = fields.status
  mapped.updated_at = new Date().toISOString()
  return updateRowFields(SHEET_CANDIDATES, candidateId, mapped)
}

function removeCandidate(candidateId) {
  var sheet = ensureCandidatesSheet()
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id') + 1
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (idCol === 0) throw userError('シートの構成が不正です。管理者にお問い合わせください。')
  var lastRow = sheet.getLastRow()
  var ids = sheet.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues()
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(candidateId)) {
      sheet.deleteRow(i + 2)
      break
    }
  }
  return { ok: true }
}

// 候補者を正式なMemberレコードへ変換する（addMemberを呼ぶだけ）。
// Candidatesシートの行は自動削除しない — 手動でremoveCandidateするまで残す。
function convertCandidateToMember(candidateId, role) {
  var candidate = findRow(SHEET_CANDIDATES, candidateId)
  if (!candidate) throw userError('候補者が見つかりません: ' + candidateId)
  var created = addMember(String(candidate.name || ''), String(candidate.email || ''), '', role || baseRoleRef())
  updateRowFields(SHEET_CANDIDATES, candidateId, { status: 'hired', updated_at: new Date().toISOString() })
  return { memberId: created.id }
}

// ---- Phase 6: スキル一括更新 ----

function bulkUpdateSkillLevels(updates) {
  // updates: [{ memberId, skill, level }]
  if (!updates || updates.length === 0) return { ok: true, updated: 0 }

  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_MEMBERS)
  if (!sheet) throw userError('Membersシートが見つかりません')

  var data = sheet.getDataRange().getValues()
  var headers = data[0].map(function(h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var skillLevelsCol = headers.indexOf('skill_levels_json')
  if (idCol < 0 || skillLevelsCol < 0) throw userError('Membersシートの列が不足しています')

  // group updates by memberId
  var byMember = {}
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i]
    if (!byMember[u.memberId]) byMember[u.memberId] = []
    byMember[u.memberId].push(u)
  }

  var count = 0
  for (var row = 1; row < data.length; row++) {
    var memberId = String(data[row][idCol] || '')
    if (!memberId || !byMember[memberId]) continue

    var existing = []
    try {
      existing = JSON.parse(String(data[row][skillLevelsCol] || '[]')) || []
    } catch (e) { existing = [] }

    var memberUpdates = byMember[memberId]
    for (var j = 0; j < memberUpdates.length; j++) {
      var upd = memberUpdates[j]
      var found = false
      for (var k = 0; k < existing.length; k++) {
        if (existing[k].skill === upd.skill) {
          existing[k].level = upd.level
          found = true
          break
        }
      }
      if (!found) existing.push({ skill: upd.skill, level: upd.level })
    }

    sheet.getRange(row + 1, skillLevelsCol + 1).setValue(JSON.stringify(existing))
    count++
  }

  return { ok: true, updated: count }
}

// ---- 読み取り(公開CSVの代替) ------------------------------------------------
//
// Members / Projects / Tasks / Settings の読み取りは、以前は「ウェブに公開」した
// CSVから直接行っていた(URLを知っていればログインなしで全データを読めた)。
// 現在は getInitialData アクションでまとめて返す。流れ:
//   1. トークンを検証してログイン中のメンバーを特定する
//   2. 4シート分の「スナップショット」をキャッシュから取り出す(なければ読む)
//   3. READ_POLICY に従い、閲覧者が見てよい行・列・キーだけに絞って返す
//
// キャッシュは「データの版(DATA_VERSION)」ごとに持つ。書き込みのたびに版を
// 新しくするので、古い版のキャッシュは参照されなくなり期限切れで消える。
// 版を新しくする箇所: doPost の書き込みアクション(finally)、dailyMaintenance、
// generateRecurringTasksLocked、スプレッドシートの手動編集(onSpreadsheetChange)。

var DATA_VERSION_PROPERTY_KEY = 'DATA_VERSION'
var SNAPSHOT_SHEETS = ['Members', 'Projects', 'Tasks', 'Settings']
// CacheService は1キー100KBまで。base64文字列を90,000文字ずつに分割する
var SNAPSHOT_CHUNK_SIZE = 90000
// 分割数の上限(約5.4MB)。これを超える場合はキャッシュせず毎回シートから読む
var SNAPSHOT_MAX_CHUNKS = 60
// CacheService の有効期限の上限(6時間)
var SNAPSHOT_CACHE_TTL = 21600

function getDataVersion() {
  return PropertiesService.getScriptProperties().getProperty(DATA_VERSION_PROPERTY_KEY) || '0'
}

function bumpDataVersion() {
  try {
    PropertiesService.getScriptProperties().setProperty(
      DATA_VERSION_PROPERTY_KEY,
      String(Date.now()) + '-' + Math.floor(Math.random() * 1e6),
    )
  } catch (e) {
    // 版の更新に失敗しても、キャッシュの有効期限(6時間)で最終的に反映される
    Logger.log('bumpDataVersion failed: ' + e)
  }
}

// スプレッドシートを手で編集したときにキャッシュを無効にする(setupOhsumi で
// インストール型トリガーとして登録する)。スクリプトからの書き込みでは発火しない。
// どのシートが編集されたかは分からないため、メールアドレス表の版も新しくする。
function onSpreadsheetChange(e) {
  bumpDataVersion()
  bumpMemberEmailsVersion()
}

// ログイン用のメール→メンバーIDの対応表(findMemberIdByEmailCached)は、
// データの版とは別の版でキャッシュする。タスクの更新などメールに関係のない
// 書き込みのたびに MemberEmails シートを読み直さないようにするため。
// 版を新しくするのは次の場合だけ:
//   - setMemberEmail(addMember / convertCandidateToMember / updateEmail から呼ばれる)
//   - removeMember(メール行は消さないが、念のため)
//   - setupOhsumi(MemberEmails シートの作成・見出しの追加)
//   - onSpreadsheetChange(スプレッドシートの手動編集)
//   - resetMemberEmailsCache(エディタから手動で実行する)
var MEMBER_EMAILS_VERSION_PROPERTY_KEY = 'MEMBER_EMAILS_VERSION'

function getMemberEmailsVersion() {
  return PropertiesService.getScriptProperties().getProperty(MEMBER_EMAILS_VERSION_PROPERTY_KEY) || '0'
}

function bumpMemberEmailsVersion() {
  try {
    PropertiesService.getScriptProperties().setProperty(
      MEMBER_EMAILS_VERSION_PROPERTY_KEY,
      String(Date.now()) + '-' + Math.floor(Math.random() * 1e6),
    )
  } catch (e) {
    // 版の更新に失敗しても、キャッシュの有効期限(6時間)で最終的に反映される
    Logger.log('bumpMemberEmailsVersion failed: ' + e)
  }
}

// エディタから実行する: メールアドレス表のキャッシュを無効にする
// (トリガーが動かなかった場合など、ログインできないときの確認用)
function resetMemberEmailsCache() {
  bumpMemberEmailsVersion()
  console.log('メールアドレス表のキャッシュを無効にしました(版: ' + getMemberEmailsVersion() + ')')
}

// シートを {headers, rows} で読む。値は公開CSVと同じく「表示されている文字列」
// (getDisplayValues と同じ見え方)にそろえる。空行は除く。シートが無ければ空で返す。
//
// 読み込みは Sheets API の values.batchGet を UrlFetchApp で1回だけ呼んで行う
// (スクリプトのトークンを使う。Apps Script の「サービス」に Google Sheets API が
// 追加されている必要がある — appsscript.json を参照)。失敗した場合(403・429・
// 5xx・通信エラーなど)は、SpreadsheetApp の getSheets() + getDisplayValues() で
// 読み直す。どちらで読んだかと失敗の理由は実行ログに残す。
function readSheetTables(names) {
  var start = Date.now()
  var viaApi
  try {
    viaApi = readSheetTablesViaApi(names)
  } catch (e) {
    viaApi = { error: '通信エラー: ' + ((e && e.message) || e) }
  }
  if (viaApi.tables) {
    console.log('readSheetTables: Sheets API(batchGet)で読み込み ' + (Date.now() - start) + 'ms')
    return viaApi.tables
  }
  var t = Date.now()
  var tables = readSheetTablesViaSpreadsheetApp(names)
  console.warn(
    'readSheetTables: Sheets API で読み込めなかったため、SpreadsheetApp(getDisplayValues)で読み込み ' +
      (Date.now() - t) + 'ms。理由: ' + viaApi.error,
  )
  return tables
}

function readSheetTable(name) {
  return readSheetTables([name])[name]
}

var EMPTY_SHEET_TABLE_JSON = '{"headers":[],"rows":[]}'

// 2次元配列(1行目が見出し)を {headers, rows} にする。空行は除く。
function sheetTableFromValues(values) {
  if (!values || values.length === 0) return JSON.parse(EMPTY_SHEET_TABLE_JSON)
  // getDataRange は空のシートでも A1 の1セルを返す
  if (values.length === 1 && values[0].every(function (v) { return v === '' })) {
    return JSON.parse(EMPTY_SHEET_TABLE_JSON)
  }
  var headers = values[0].map(function (h) { return String(h).trim() })
  var rows = []
  for (var i = 1; i < values.length; i++) {
    var row = values[i]
    var hasValue = false
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '') { hasValue = true; break }
    }
    if (hasValue) rows.push(row)
  }
  return { headers: headers, rows: rows }
}

function sheetsApiRangeName(name) {
  return "'" + String(name).replace(/'/g, "''") + "'"
}

function sheetsApiBatchGetUrl(spreadsheetId, names) {
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values:batchGet?' +
    names.map(function (name) { return 'ranges=' + encodeURIComponent(sheetsApiRangeName(name)) }).join('&') +
    '&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS'
}

// API は行末の空セルと、表の末尾の空行を省いて返す。getDisplayValues と同じ
// 長方形(最も長い行の幅)にそろえ、値はすべて文字列にする。
function padSheetsApiValues(values) {
  var width = 0
  ;(values || []).forEach(function (r) { if (r.length > width) width = r.length })
  return (values || []).map(function (r) {
    var row = r.map(function (v) { return v === null || v === undefined ? '' : String(v) })
    while (row.length < width) row.push('')
    return row
  })
}

// 応答の range("'Tasks'!A1:AT501" など)のシート名部分
function sheetNameOfApiRange(range) {
  var sheetPart = String(range || '').replace(/![^!]*$/, '')
  if (/^'.*'$/.test(sheetPart)) sheetPart = sheetPart.slice(1, -1).replace(/''/g, "'")
  return sheetPart
}

// 成功したら { tables }、失敗したら { error }(例外は投げない。通信の例外だけは
// 呼び出し側で受ける)
function readSheetTablesViaApi(names) {
  var id = SpreadsheetApp.getActiveSpreadsheet().getId()
  var response = UrlFetchApp.fetch(sheetsApiBatchGetUrl(id, names), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  })
  var code = response.getResponseCode()
  var text = response.getContentText()
  if (code !== 200) return { error: describeSheetsApiError(code, text) }
  var body
  try {
    body = JSON.parse(text)
  } catch (e) {
    return { error: '応答を JSON として読めませんでした' }
  }
  var valueRanges = (body && body.valueRanges) || []
  if (valueRanges.length !== names.length) {
    return { error: '応答の範囲の数が違います(' + valueRanges.length + ' / ' + names.length + ')' }
  }
  var tables = {}
  for (var i = 0; i < names.length; i++) {
    if (sheetNameOfApiRange(valueRanges[i].range) !== names[i]) {
      return { error: '応答の範囲が違います(' + valueRanges[i].range + ' / ' + names[i] + ')' }
    }
    tables[names[i]] = sheetTableFromValues(padSheetsApiValues(valueRanges[i].values))
  }
  return { tables: tables }
}

// 予備の読み方(計測の (b)): getSheets() を1回呼び、getDataRange().getDisplayValues()
function readSheetTablesViaSpreadsheetApp(names) {
  var byName = {}
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sheet) {
    byName[sheet.getName()] = sheet
  })
  var tables = {}
  names.forEach(function (name) {
    var sheet = byName[name]
    tables[name] = sheet
      ? sheetTableFromValues(sheet.getDataRange().getDisplayValues())
      : JSON.parse(EMPTY_SHEET_TABLE_JSON)
  })
  return tables
}

function snapshotCacheKey(version, suffix) {
  return 'snap:' + version + ':' + suffix
}

function readSnapshotCache(version) {
  try {
    var cache = CacheService.getScriptCache()
    var meta = cache.get(snapshotCacheKey(version, 'meta'))
    if (!meta) return null
    var count = Number(meta)
    if (!(count > 0)) return null
    var keys = []
    for (var i = 0; i < count; i++) keys.push(snapshotCacheKey(version, i))
    var parts = cache.getAll(keys)
    var encoded = ''
    for (var j = 0; j < count; j++) {
      var part = parts[keys[j]]
      if (part == null) return null
      encoded += part
    }
    var gz = Utilities.newBlob(Utilities.base64Decode(encoded), 'application/x-gzip')
    return JSON.parse(Utilities.ungzip(gz).getDataAsString('UTF-8'))
  } catch (e) {
    return null
  }
}

function writeSnapshotCache(version, data) {
  try {
    var gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(data), 'application/json'))
    var encoded = Utilities.base64Encode(gz.getBytes())
    var count = Math.ceil(encoded.length / SNAPSHOT_CHUNK_SIZE)
    if (count > SNAPSHOT_MAX_CHUNKS) return false
    var entries = {}
    for (var i = 0; i < count; i++) {
      entries[snapshotCacheKey(version, i)] = encoded.substr(i * SNAPSHOT_CHUNK_SIZE, SNAPSHOT_CHUNK_SIZE)
    }
    var cache = CacheService.getScriptCache()
    cache.putAll(entries, SNAPSHOT_CACHE_TTL)
    // 目録は最後に書く(途中で失敗したら目録が無く、次回は読み直しになる)
    cache.put(snapshotCacheKey(version, 'meta'), String(count), SNAPSHOT_CACHE_TTL)
    return true
  } catch (e) {
    return false
  }
}

// 4シート分のスナップショットを返す。版は必ずシートより先に読む(書き込みと
// 同時に読んでも、古い版のキーに新しいデータが入るだけで逆は起きない)。
function loadSnapshot() {
  var version = getDataVersion()
  var cached = readSnapshotCache(version)
  if (cached) return { version: version, data: cached, cacheHit: true }
  var data = readSheetTables(SNAPSHOT_SHEETS)
  writeSnapshotCache(version, data)
  return { version: version, data: data, cacheHit: false }
}

// ---- 読み取りの権限表(閲覧範囲の判定はここに集約する) -----------------------
//
// 列ごと・キーごとに規則名を書く。規則のない列・キーは誰にも返さない。
// 将来、団体ごとに人材データの閲覧範囲を設定できるようにする場合は、
// Settings の設定をこの表に重ねる形で拡張する。
//   all             ログイン済みの全員
//   self            本人のみ(Members の行の id が閲覧者)
//   selfOrAdminRole 本人と、一般以外の役職
//   selfOrFullAdmin 本人と全権管理者
//   adminRole       一般以外の役職
//   fullAdmin       全権管理者のみ
//   none            誰にも返さない
var READ_POLICY = {
  Members: {
    rows: 'all',
    columns: {
      id: 'all',
      name: 'all',
      display_name: 'all',
      role: 'all',
      avatar_url: 'all',
      avatar_color: 'all',
      avatar_initials: 'all',
      project_ids: 'all',
      will_tags: 'all',
      judgment_tags: 'all',
      reports_to_id: 'all',
      joined_at: 'all',
      department_path: 'all',
      unavailable_dates: 'all',
      absent_dates: 'all',
      available_hours_json: 'all',
      skill_levels_json: 'all',
      timezone: 'all',
      inactive: 'all',
      mentor_id: 'selfOrAdminRole',
      has_management_experience: 'selfOrAdminRole',
      desired_areas: 'selfOrAdminRole',
      desired_skills: 'selfOrAdminRole',
      career_history_json: 'selfOrAdminRole',
      qualifications_json: 'selfOrAdminRole',
      evaluation_history_json: 'selfOrAdminRole',
      transfer_history_json: 'selfOrAdminRole',
      competencies_json: 'selfOrAdminRole',
      training_history_json: 'selfOrAdminRole',
      development_plan_json: 'selfOrAdminRole',
      one_on_ones_json: 'selfOrAdminRole',
      career_aspiration: 'selfOrAdminRole',
      desired_future_role: 'selfOrAdminRole',
      career_plan: 'selfOrAdminRole',
      university: 'selfOrAdminRole',
      faculty: 'selfOrAdminRole',
      department_name: 'selfOrAdminRole',
      grade_year: 'selfOrAdminRole',
      custom_fields_json: 'selfOrAdminRole',
      skill_points_json: 'selfOrAdminRole',
      survey_responses_json: 'selfOrAdminRole',
      last_login: 'selfOrAdminRole',
      notify_new_task: 'self',
      notify_settings: 'self',
      locale: 'self',
      permission_overrides_json: 'selfOrFullAdmin',
      last_inactive_notified: 'none',
      years_of_experience: 'none',
    },
  },
  Projects: {
    rows: 'all',
    columns: {
      id: 'all', name: 'all', description: 'all', type: 'all', owner_id: 'all',
      member_ids: 'all', archived: 'all', parent_id: 'all', goal: 'all',
      health_override: 'all', last_notified_health: 'all', start_date: 'all', end_date: 'all',
    },
  },
  Tasks: {
    // 行の規則は canViewTaskRow を参照。行が見える人には全列を返す
    rows: 'task',
    columns: {
      id: 'all', project_id: 'all', title: 'all', description: 'all', status: 'all',
      assign_type: 'all', assignee_id: 'all', creator_id: 'all', created_at: 'all',
      start_date: 'all', due_date: 'all', due_time: 'all', visibility: 'all',
      department: 'all', category: 'all', skills: 'all', difficulty: 'all', priority: 'all',
      last_activity: 'all', original_input_id: 'all', approval_status: 'all',
      estimated_hours: 'all', importance: 'all', reviewer_id: 'all', reviewer_ids: 'all',
      depends_on_ids: 'all', progress_note: 'all', progress_percent: 'all',
      progress_history_json: 'all', deliverables_json: 'all', history_json: 'all',
      comments_json: 'all', retrospective_json: 'all', schedule_json: 'all', form_json: 'all',
      blocker_note: 'all', blocker_since: 'all', hold_reason_note: 'all', hold_reason_since: 'all',
      completed_date: 'all', actual_hours: 'all', awarded_points_json: 'all',
      required_approvals: 'all', required_skill_levels_json: 'all', review_approvals_json: 'all',
      open_bid_applicant_ids: 'all', related_review_task_id: 'all',
    },
  },
  Settings: {
    // キーごとの規則。関数になっているキーは、閲覧者に合わせて値を加工して返す
    keys: {
      skill_options: 'all',
      category_options: 'all',
      roles: 'all',
      departments: 'all',
      role_levels: 'all',
      project_templates: 'all',
      role_permissions: 'all',
      task_set_templates: 'all',
      recurring_rules: 'all',
      job_requirements: 'all',
      skill_field_options: 'all',
      skill_field_skills: 'all',
      skill_field_threshold: 'all',
      org_notification_emails: 'fullAdmin',
      survey_invited_ids: filterSurveyInvitedIds,
      project_order: 'all',
      restricted_roles: 'all',
      skill_level_thresholds: 'all',
      quiz_definitions: filterQuizDefinitions,
      radar_axes: 'all',
      custom_member_columns_json: 'all',
      expense_categories: 'all',
      custom_form_defs: 'all',
      org_name: 'all',
      org_logo_url: 'all',
      theme_color: 'all',
      one_on_one_questions: 'all',
      initial_tasks_json: 'all',
      department_tree_config: 'all',
      learning_contents: 'all',
      learning_courses: 'all',
      training_programs: 'all',
      survey_questions: 'all',
    },
  },
}

function splitCsvList(value) {
  return String(value || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
}

// 閲覧者の情報(判定に使う値だけ)。roles は役職の一覧(rolesFromSettings)。
// 全権管理者の判定は lib/ohsumi/roles.ts の isFullAdminRoleRef と同じ基準
// (最上位は常に全権管理者 — authorizeAction と同じ)。
function makeViewer(memberRow, roles) {
  var role = String(memberRow.role || '').trim()
  return {
    id: String(memberRow.id || ''),
    role: role,
    isAdminRole: isAdminRoleRef(roles, role),
    isFullAdmin: isFullAdminRoleRef(roles, role),
  }
}

function checkReadRule(rule, viewer, ownerId) {
  switch (rule) {
    case 'all': return true
    case 'self': return !!ownerId && ownerId === viewer.id
    case 'selfOrAdminRole': return (!!ownerId && ownerId === viewer.id) || viewer.isAdminRole
    case 'selfOrFullAdmin': return (!!ownerId && ownerId === viewer.id) || viewer.isFullAdmin
    case 'adminRole': return viewer.isAdminRole
    case 'fullAdmin': return viewer.isFullAdmin
    default: return false
  }
}

// タスクの行の規則(画面の visibleTasks / pendingTasks の表示範囲を再現する)
//   幹部限定: 一般以外の役職のみ
//   承認待ち: 一般以外の役職と、作成者・担当者
function canViewTaskRow(viewer, task) {
  // 値は移行前の日本語・コードのどちらでもよい
  if (normalizeCode('visibility', task.visibility) === 'leaders' && !viewer.isAdminRole) return false
  if (normalizeCode('approval', task.approval_status) === 'pending' && !viewer.isAdminRole) {
    if (String(task.creator_id || '') === viewer.id) return true
    return splitCsvList(task.assignee_id).indexOf(viewer.id) >= 0
  }
  return true
}

// アンケートの回答対象者一覧: 一般以外の役職には一覧をそのまま返す。一般には
// 「自分が対象かどうか」だけが分かる値にする(対象なら自分のID、対象外なら
// どのメンバーIDとも一致しない値)。空(=全員が対象)はそのまま返す。
var SURVEY_NOT_INVITED_MARKER = '__not_invited__'
function filterSurveyInvitedIds(value, viewer) {
  if (viewer.isAdminRole) return value
  var ids = splitCsvList(value)
  if (ids.length === 0) return value
  return ids.indexOf(viewer.id) >= 0 ? viewer.id : SURVEY_NOT_INVITED_MARKER
}

// 検定: 正解番号(correctIndex)は検定を編集できる全権管理者だけに返す
// (採点は submitQuizResult でサーバー側が行う)
function filterQuizDefinitions(value, viewer) {
  if (viewer.isFullAdmin || !value) return value
  try {
    var quizzes = JSON.parse(value)
    if (!Array.isArray(quizzes)) return ''
    quizzes.forEach(function (q) {
      ;(q && Array.isArray(q.questions) ? q.questions : []).forEach(function (question) {
        if (question) delete question.correctIndex
      })
    })
    return JSON.stringify(quizzes)
  } catch (e) {
    return ''
  }
}

function tableRowToObject(headers, row) {
  var obj = {}
  for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c]
  return obj
}

// 1シート分を閲覧者に合わせて絞り込む(Members / Projects / Tasks)
function filterTableForViewer(sheetName, table, viewer) {
  var policy = READ_POLICY[sheetName]
  var headers = table.headers || []
  var rows = table.rows || []
  // 規則のある列だけを残す(列の並びは元のまま。none の列も落とす)
  var keepCols = []
  headers.forEach(function (h, c) {
    if (h && policy.columns[h] && policy.columns[h] !== 'none') keepCols.push(c)
  })
  var idCol = headers.indexOf('id')
  var outRows = []
  rows.forEach(function (row) {
    var obj = null
    if (policy.rows === 'task') {
      obj = tableRowToObject(headers, row)
      if (!canViewTaskRow(viewer, obj)) return
    }
    // Members の「本人」判定は行の id で行う
    var ownerId = sheetName === 'Members' && idCol >= 0 ? String(row[idCol]) : ''
    outRows.push(keepCols.map(function (c) {
      return checkReadRule(policy.columns[headers[c]], viewer, ownerId) ? row[c] : ''
    }))
  })
  return { headers: keepCols.map(function (c) { return headers[c] }), rows: outRows }
}

function filterSettingsForViewer(table, viewer) {
  var headers = table.headers || []
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  var out = { headers: ['key', 'value'], rows: [] }
  if (keyCol < 0 || valueCol < 0) return out
  var keys = READ_POLICY.Settings.keys
  ;(table.rows || []).forEach(function (row) {
    var key = String(row[keyCol] || '')
    var rule = keys[key]
    if (!rule) return
    var value = row[valueCol]
    if (typeof rule === 'function') {
      out.rows.push([key, rule(value, viewer)])
    } else if (checkReadRule(rule, viewer, '')) {
      out.rows.push([key, value])
    }
  })
  return out
}

// スナップショットの Settings から役職の一覧を作る
function rolesFromSnapshot(data) {
  var settings = data.Settings || { headers: [], rows: [] }
  var keyCol = settings.headers.indexOf('key')
  var valueCol = settings.headers.indexOf('value')
  var map = {}
  if (keyCol >= 0 && valueCol >= 0) {
    settings.rows.forEach(function (r) {
      var key = String(r[keyCol])
      if (ROLE_SETTING_KEYS.indexOf(key) >= 0) map[key] = String(r[valueCol] || '')
    })
  }
  return rolesFromSettings(map)
}

function findMemberInSnapshot(data, memberId) {
  var members = data.Members || { headers: [], rows: [] }
  var idCol = members.headers.indexOf('id')
  if (idCol < 0) return null
  for (var i = 0; i < members.rows.length; i++) {
    if (String(members.rows[i][idCol]) === String(memberId)) return tableRowToObject(members.headers, members.rows[i])
  }
  return null
}

// スナップショット全体を閲覧者に合わせて絞り込む(getInitialData の本体。
// Google のサービスを使わない純粋な関数なのでテストから直接呼べる)
function buildViewerData(data, memberId) {
  var memberRow = findMemberInSnapshot(data, memberId)
  if (!memberRow) return null
  var viewer = makeViewer(memberRow, rolesFromSnapshot(data))
  var empty = { headers: [], rows: [] }
  return {
    Members: filterTableForViewer('Members', data.Members || empty, viewer),
    Projects: filterTableForViewer('Projects', data.Projects || empty, viewer),
    Tasks: filterTableForViewer('Tasks', data.Tasks || empty, viewer),
    Settings: filterSettingsForViewer(data.Settings || empty, viewer),
  }
}

// ログイン用のメール→メンバーIDの対応表(非公開の MemberEmails シート)。
// メールアドレス表専用の版ごとにキャッシュする(getMemberEmailsVersion を参照)。
function findMemberIdByEmailCached(email) {
  var normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null
  var cache = CacheService.getScriptCache()
  // 版は MemberEmails を読む前に取得する(読んでいる間に書き込まれても、
  // 古い内容は古い版のキーに入るだけになる)
  var key = 'memberEmails:' + getMemberEmailsVersion()
  var map = null
  try {
    var raw = cache.get(key)
    if (raw) map = JSON.parse(raw)
  } catch (e) { map = null }
  if (!map) {
    map = {}
    var sheet = getMemberEmailsSheet()
    var headers = headerRow(sheet)
    var idCol = headers.indexOf('id')
    var emailCol = headers.indexOf('email')
    var lastRow = sheet.getLastRow()
    if (lastRow >= 2 && idCol >= 0 && emailCol >= 0) {
      sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function (row) {
        String(row[emailCol] || '').split(',').forEach(function (e) {
          var addr = e.trim().toLowerCase()
          if (addr && !map[addr]) map[addr] = String(row[idCol])
        })
      })
    }
    try { cache.put(key, JSON.stringify(map), SNAPSHOT_CACHE_TTL) } catch (e) { /* 大きすぎる場合は毎回読む */ }
  }
  return map[normalized] || null
}

// ログインと初期データの取得を1回で行う。
// knownVersion が現在の版と同じなら中身を返さず unchanged だけ返す。
function getInitialDataForMember(memberId, knownVersion) {
  var version = getDataVersion()
  if (knownVersion && String(knownVersion) === version) {
    return { memberId: memberId, version: version, unchanged: true }
  }
  var snapshot = loadSnapshot()
  var sheets = buildViewerData(snapshot.data, memberId)
  if (!sheets) return { memberId: null }
  return { memberId: memberId, version: snapshot.version, sheets: sheets }
}

// 段階①の計測用: Apps Script エディタで実行し、実行ログの結果を確認する。
// キャッシュなし(シートから読む)とキャッシュあり、それぞれの所要時間と
// データ量を出力する。実行するとデータの版が新しくなる(全員のキャッシュが
// 一度無効になる)が、データそのものは変更しない。
function measureReadPerformance() {
  function ms(start) { return Date.now() - start }
  bumpDataVersion()
  var version = getDataVersion()

  var t = Date.now()
  var data = readSheetTables(SNAPSHOT_SHEETS)
  var readSheetsMs = ms(t)

  var json = JSON.stringify(data)
  t = Date.now()
  var cached = writeSnapshotCache(version, data)
  var writeCacheMs = ms(t)

  t = Date.now()
  var fromCache = readSnapshotCache(version)
  var readCacheMs = ms(t)

  var members = data.Members || { headers: [], rows: [] }
  var idCol = members.headers.indexOf('id')
  var sampleId = idCol >= 0 && members.rows.length > 0 ? String(members.rows[0][idCol]) : ''
  t = Date.now()
  var filtered = sampleId ? buildViewerData(data, sampleId) : null
  var filterMs = ms(t)

  t = Date.now()
  var emails = getMemberEmailsSheet()
  emails.getDataRange().getValues()
  var readEmailsMs = ms(t)

  var lines = [
    '📊 読み取り性能の計測結果',
    '  行数: Members=' + members.rows.length +
      ' Projects=' + ((data.Projects || {}).rows || []).length +
      ' Tasks=' + ((data.Tasks || {}).rows || []).length +
      ' Settings=' + ((data.Settings || {}).rows || []).length,
    '  データ量(JSON): ' + Math.round(json.length / 1024) + ' KB',
    '  キャッシュなし: シート読み込み ' + readSheetsMs + ' ms',
    '  キャッシュ書き込み: ' + writeCacheMs + ' ms (' + (cached ? '成功' : '上限超過のためキャッシュしない') + ')',
    '  キャッシュあり: キャッシュ読み込み ' + readCacheMs + ' ms (' + (fromCache ? '取得成功' : '取得失敗') + ')',
    '  閲覧者ごとの絞り込み: ' + filterMs + ' ms',
    '  MemberEmails 読み込み(キャッシュなし時のみ): ' + readEmailsMs + ' ms',
    '  絞り込み後のデータ量(先頭メンバー視点): ' + (filtered ? Math.round(JSON.stringify(filtered).length / 1024) + ' KB' : '-'),
    '  ※ 上記に加え、Webアプリ呼び出しの往復とトークン検証(5分キャッシュ)の時間がかかります',
  ]
  console.log(lines.join('\n'))
  return lines.join('\n')
}

// ---- 読み込み方式ごとの計測 ----------------------------------------------------
//
// シートの読み込み方を (a)〜(d) の4通りで計測する。Apps Script エディタでは
// 引数を渡せないため、方式ごとに関数を分けている。1回の実行では1つの方式だけを
// 測る(同じ実行の中で続けて読むと、2回目以降が速く見えるため)。
//   measureReadA: (a) 以前の方式(シートごとにスプレッドシートを開き、
//                 getLastRow / getLastColumn を2回ずつ呼ぶ)
//   measureReadB: (b) getSheets() を1回だけ呼び、getDataRange().getDisplayValues()
//                 (Sheets API で読めなかった場合の予備の読み方)
//   measureReadC: (c) (b) と同じ取得で getValues() を使い、表示用の文字列に自前で変換
//   measureReadD: (d) Sheets API の values.batchGet を UrlFetchApp で1回だけ呼ぶ
//                 (スクリプトのトークンを使う。表示されている文字列 FORMATTED_VALUE)。
//                 現在の読み込み(readSheetTables)はこの方式
// 各方式とも、同じ方式を3回以上(できれば時間を空けて)実行し、実行ログの
// 「直近3回の中央値」を比べる。showReadMeasurements() で4方式の記録を一覧できる。
//
// 計測用の関数は、シートを読むだけで書き込まない。データの版やキャッシュにも
// 触れない(本来の読み込み処理の速さや内容に影響しない)。失敗しても例外を
// 投げず、実行ログにエラーを出して終わる。記録はスクリプトプロパティ
// READ_MEASURE_HISTORY_a〜d に残る(clearReadMeasurements() で消せる)。

var READ_MEASURE_LABELS = {
  a: '(a) 以前の方式(シートごとに開く + getDisplayValues)',
  b: '(b) getSheets() 1回 + getDataRange().getDisplayValues()',
  c: '(c) getSheets() 1回 + getDataRange().getValues() + 自前の文字列変換',
  d: '(d) Sheets API values.batchGet(UrlFetchApp + スクリプトのトークン)',
}
var READ_MEASURE_HISTORY_PREFIX = 'READ_MEASURE_HISTORY_'
var READ_MEASURE_HISTORY_SIZE = 5

function measureReadA() { return runReadMeasurement('a') }
function measureReadB() { return runReadMeasurement('b') }
function measureReadC() { return runReadMeasurement('c') }
function measureReadD() { return runReadMeasurement('d') }

function runReadMeasurement(variant) {
  var lines = ['📊 読み込み方式の計測 ' + READ_MEASURE_LABELS[variant]]
  var result
  try {
    result = READ_MEASURE_RUNNERS[variant]()
  } catch (e) {
    result = { error: String(e), common: {}, sheets: {}, data: null }
  }
  try {
    lines = lines.concat(formatReadMeasurement(result))
  } catch (e) {
    lines.push('  結果の整形に失敗しました: ' + e)
  }
  // 結果が getDisplayValues(予備の読み方 (b))と同じ見え方かを確かめる
  // (計測の後に行うため、所要時間には含まれない)
  if (!result.error && result.data) {
    try {
      lines.push('  結果の一致(getDisplayValues と比べて): ' + compareWithDisplayValues(result.data))
    } catch (e) {
      lines.push('  結果の一致: 確認できませんでした(' + e + ')')
    }
  }
  try {
    lines.push('  ' + recordReadMeasurement(variant, result))
  } catch (e) {
    lines.push('  記録の保存に失敗しました: ' + e)
  }
  var text = lines.join('\n')
  console.log(text)
  return text
}

function readMeasureNow() { return Date.now() }

function readMeasureSize(values) {
  var cells = 0
  for (var i = 0; i < values.length; i++) cells += values[i].length
  return {
    rowCount: values.length,
    colCount: values.length > 0 ? values[0].length : 0,
    cells: cells,
    chars: JSON.stringify(values).length,
  }
}

// シートごとに計測する。1枚で失敗しても残りのシートは測る。
function measureEachSheet(result, fn) {
  var failed = false
  SNAPSHOT_SHEETS.forEach(function (name) {
    var entry = { phases: [] }
    result.sheets[name] = entry
    function phase(label, f) {
      var t = readMeasureNow()
      var value = f()
      entry.phases.push([label, readMeasureNow() - t])
      return value
    }
    try {
      var values = fn(name, phase, entry)
      if (values == null) {
        entry.missing = true
        result.data[name] = { headers: [], rows: [] }
        return
      }
      var size = readMeasureSize(values)
      entry.size = size
      result.data[name] = phase('空行の除去', function () { return sheetTableFromValues(values) })
    } catch (e) {
      entry.error = String(e)
      failed = true
    }
  })
  if (failed) {
    result.data = null
    result.error = result.error || '一部のシートの読み込みに失敗しました'
  }
}

function measureCommon(result, label, f) {
  var t = readMeasureNow()
  var value = f()
  result.common.push([label, readMeasureNow() - t])
  return value
}

var READ_MEASURE_RUNNERS = {
  // (a) readSheetTable と同じ呼び出しの順序・回数
  a: function () {
    var result = { common: [], sheets: {}, data: {} }
    var start = readMeasureNow()
    measureEachSheet(result, function (name, phase) {
      var ss = phase('スプレッドシートを開く', function () { return SpreadsheetApp.getActiveSpreadsheet() })
      var sheet = phase('シートの取得', function () { return ss.getSheetByName(name) })
      if (!sheet) return null
      var size = phase('最終行・最終列(4回)', function () {
        var empty = sheet.getLastRow() < 1 || sheet.getLastColumn() < 1
        return empty ? null : [sheet.getLastRow(), sheet.getLastColumn()]
      })
      if (!size) return []
      var range = phase('getRange', function () { return sheet.getRange(1, 1, size[0], size[1]) })
      return phase('getDisplayValues', function () { return range.getDisplayValues() })
    })
    result.totalMs = readMeasureNow() - start
    return result
  },
  b: function () {
    return measureWithGetSheets(false)
  },
  c: function () {
    return measureWithGetSheets(true)
  },
  d: function () {
    var result = { common: [], sheets: {}, data: {} }
    var start = readMeasureNow()
    var id = measureCommon(result, 'スプレッドシートのID', function () {
      return SpreadsheetApp.getActiveSpreadsheet().getId()
    })
    var token = measureCommon(result, 'トークンの取得', function () { return ScriptApp.getOAuthToken() })
    var url = sheetsApiBatchGetUrl(id, SNAPSHOT_SHEETS)
    var response = measureCommon(result, 'batchGet(HTTP)', function () {
      return UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      })
    })
    var code = response.getResponseCode()
    var text = response.getContentText()
    result.httpCode = code
    result.responseChars = text.length
    if (code !== 200) {
      result.error = describeSheetsApiError(code, text)
      result.data = null
      result.totalMs = readMeasureNow() - start
      return result
    }
    var body = measureCommon(result, 'JSON の解析', function () { return JSON.parse(text) })
    var valueRanges = body.valueRanges || []
    var index = 0
    measureEachSheet(result, function (name, phase) {
      var values = (valueRanges[index++] || {}).values || []
      // API は行末・表の末尾の空セルを省くため、getDisplayValues と同じ長方形にそろえる
      return phase('行の長さをそろえる', function () { return padSheetsApiValues(values) })
    })
    result.totalMs = readMeasureNow() - start
    return result
  },
}

function measureWithGetSheets(ownFormat) {
  var result = { common: [], sheets: {}, data: {} }
  var start = readMeasureNow()
  var ss = measureCommon(result, 'スプレッドシートを開く', function () { return SpreadsheetApp.getActiveSpreadsheet() })
  var byName = measureCommon(result, 'シート一覧(getSheets + getName)', function () {
    var map = {}
    var sheets = ss.getSheets()
    result.sheetCount = sheets.length
    sheets.forEach(function (sheet) { map[sheet.getName()] = sheet })
    return map
  })
  var tz = ownFormat
    ? measureCommon(result, 'タイムゾーン', function () { return ss.getSpreadsheetTimeZone() })
    : null
  measureEachSheet(result, function (name, phase) {
    var sheet = byName[name]
    if (!sheet) return null
    var range = phase('getDataRange', function () { return sheet.getDataRange() })
    if (!ownFormat) return phase('getDisplayValues', function () { return range.getDisplayValues() })
    var raw = phase('getValues', function () { return range.getValues() })
    return phase('文字列への変換', function () {
      return raw.map(function (row) {
        return row.map(function (v) { return readMeasureFormatValue(v, tz) })
      })
    })
  })
  result.totalMs = readMeasureNow() - start
  return result
}

// (c) の自前の変換。セルの表示形式は見ないため、日付などは表示と一致しない
// ことがある(一致しない件数は「結果の一致」に出る)。
function readMeasureFormatValue(v, tz) {
  if (v === '' || v === null || v === undefined) return ''
  if (v === true) return 'TRUE'
  if (v === false) return 'FALSE'
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var hasTime = v.getHours() !== 0 || v.getMinutes() !== 0 || v.getSeconds() !== 0
    return Utilities.formatDate(v, tz, hasTime ? 'yyyy/MM/dd H:mm:ss' : 'yyyy/MM/dd')
  }
  return String(v)
}

// Sheets API のエラー応答から、原因の分かる部分(status / reason / message)を取り出す
function describeSheetsApiError(code, text) {
  var detail = ''
  try {
    var err = JSON.parse(text).error || {}
    var reasons = (err.details || []).map(function (d) { return d.reason }).filter(Boolean)
    detail = [err.status, reasons.join(','), err.message].filter(Boolean).join(' / ')
  } catch (e) {
    detail = String(text).slice(0, 300)
  }
  var hint = ''
  if (/SERVICE_DISABLED|has not been used|is disabled/.test(detail)) {
    hint = ' → Sheets API が無効です。エディタ左の「サービス」+ から Google Sheets API を追加すると有効になります'
  } else if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient/i.test(detail)) {
    hint = ' → トークンにスプレッドシートの権限が含まれていません'
  }
  return 'Sheets API がエラーを返しました: HTTP ' + code + ' ' + detail + hint
}

function compareWithDisplayValues(data) {
  var mismatched = 0
  var examples = []
  var reference = readSheetTablesViaSpreadsheetApp(SNAPSHOT_SHEETS)
  SNAPSHOT_SHEETS.forEach(function (name) {
    var expected = reference[name]
    var actual = data[name] || { headers: [], rows: [] }
    var rows = [expected.headers].concat(expected.rows)
    var actualRows = [actual.headers].concat(actual.rows)
    var height = Math.max(rows.length, actualRows.length)
    for (var r = 0; r < height; r++) {
      var e = rows[r] || []
      var a = actualRows[r] || []
      var width = Math.max(e.length, a.length)
      for (var c = 0; c < width; c++) {
        var ev = e[c] === undefined ? '' : String(e[c])
        var av = a[c] === undefined ? '' : String(a[c])
        if (ev === av) continue
        mismatched++
        if (examples.length < 5) {
          examples.push(name + ' ' + (r + 1) + '行目 ' + (expected.headers[c] || (c + 1) + '列目') +
            ': ' + JSON.stringify(ev.slice(0, 20)) + ' → ' + JSON.stringify(av.slice(0, 20)))
        }
      }
    }
  })
  if (mismatched === 0) return '一致'
  return '不一致 ' + mismatched + ' セル(例: ' + examples.join(' / ') + ')'
}

function formatReadMeasurement(result) {
  var lines = []
  var kb = function (chars) { return Math.round(chars / 1024) + 'KB' }
  if (result.common && result.common.length > 0) {
    lines.push('  共通: ' + result.common.map(function (p) { return p[0] + ' ' + p[1] + 'ms' }).join(' / ') +
      (result.sheetCount != null ? '(シート数 ' + result.sheetCount + ')' : ''))
  }
  var totalCells = 0
  var totalChars = 0
  SNAPSHOT_SHEETS.forEach(function (name) {
    var s = result.sheets[name]
    if (!s) return
    var head = '  ' + name + ': '
    if (s.size) {
      totalCells += s.size.cells
      totalChars += s.size.chars
      head += s.size.rowCount + '行×' + s.size.colCount + '列=' + s.size.cells + 'セル ' + kb(s.size.chars) + ' | '
    }
    var phases = s.phases.map(function (p) { return p[0] + ' ' + p[1] + 'ms' }).join(' / ')
    var sum = s.phases.reduce(function (acc, p) { return acc + p[1] }, 0)
    lines.push(head + phases + '(計 ' + sum + 'ms)' + (s.missing ? ' ※シートがありません' : '') +
      (s.error ? ' ❌ ' + s.error : ''))
  })
  if (result.responseChars != null) {
    lines.push('  応答: HTTP ' + result.httpCode + ' ' + kb(result.responseChars))
  }
  if (totalCells > 0) lines.push('  合計: ' + totalCells + 'セル ' + kb(totalChars))
  if (result.error) lines.push('  ❌ ' + result.error)
  if (result.totalMs != null) lines.push('  所要時間(合計): ' + result.totalMs + ' ms')
  return lines
}

function readMeasureMedian(values) {
  var sorted = values.slice().sort(function (x, y) { return x - y })
  var mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function readMeasureHistory(variant) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(READ_MEASURE_HISTORY_PREFIX + variant)
    var list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function describeReadHistory(list) {
  if (list.length === 0) return '記録なし'
  var ms = list.map(function (h) { return h.ms })
  var text = '直近の記録(新しい順): ' + ms.join(', ') + ' ms'
  if (ms.length >= 3) text += ' → 直近3回の中央値 ' + readMeasureMedian(ms.slice(0, 3)) + ' ms'
  else text += '(あと ' + (3 - ms.length) + ' 回実行すると中央値を出します)'
  return text
}

// 成功した計測だけを記録する
function recordReadMeasurement(variant, result) {
  var list = readMeasureHistory(variant)
  if (!result.error && result.totalMs != null) {
    list.unshift({ at: new Date().toISOString(), ms: result.totalMs })
    list = list.slice(0, READ_MEASURE_HISTORY_SIZE)
    PropertiesService.getScriptProperties().setProperty(READ_MEASURE_HISTORY_PREFIX + variant, JSON.stringify(list))
  }
  return describeReadHistory(list)
}

function showReadMeasurements() {
  var lines = ['📊 読み込み方式の計測の記録']
  Object.keys(READ_MEASURE_LABELS).forEach(function (variant) {
    lines.push('  ' + READ_MEASURE_LABELS[variant] + ': ' + describeReadHistory(readMeasureHistory(variant)))
  })
  var text = lines.join('\n')
  console.log(text)
  return text
}

function clearReadMeasurements() {
  var props = PropertiesService.getScriptProperties()
  Object.keys(READ_MEASURE_LABELS).forEach(function (variant) {
    props.deleteProperty(READ_MEASURE_HISTORY_PREFIX + variant)
  })
  console.log('読み込み方式の計測の記録を消しました')
}

// ---- 経費申請の読み取り --------------------------------------------------------
//
// 経費申請は以前は読み戻しておらず、申請した画面にしか表示されなかった。
// getExpenses で、閲覧者が見てよい申請だけを返す。
//   申請者本人 / 承認ステップに該当する人(指定メンバー、または同じ役職 —
//   approveExpenseStep の担当者チェックと同じ基準) / 全権管理者 /
//   管理画面の「経費」セクションを許可された役職(役職の sections)


function makeExpenseViewer(acting) {
  var roles = getRoles()
  var role = String(acting.role || '').trim()
  var found = findRole(roles, role)
  var sections = found && found.sections
  return {
    id: String(acting.id || ''),
    role: role,
    roles: roles,
    isFullAdmin: isFullAdminRoleRef(roles, role),
    canOpenExpensesSection: Array.isArray(sections) && sections.indexOf('expenses') >= 0,
  }
}

// 1件の経費申請を閲覧できるか(Google のサービスを使わない純粋な関数)
function canViewExpense(viewer, app) {
  if (viewer.isFullAdmin || viewer.canOpenExpensesSection) return true
  if (String(app.applicantId) === viewer.id) return true
  var steps = Array.isArray(app.approvalSteps) ? app.approvalSteps : []
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i] || {}
    if (step.type === 'member' && String(step.memberId || '') === viewer.id) return true
    if (step.type === 'role' && sameRole(viewer.roles || [], step.role, viewer.role)) return true
  }
  return false
}

function parseJsonOr(raw, fallback) {
  if (raw === '' || raw == null) return fallback
  try { return JSON.parse(String(raw)) } catch (e) { return fallback }
}

function expenseRowToApplication(headers, row) {
  var get = function (name) {
    var c = headers.indexOf(name)
    return c >= 0 ? row[c] : ''
  }
  var createdAt = get('created_at')
  return {
    id: String(get('id')),
    applicantId: String(get('applicant_id')),
    amount: Number(get('amount')) || 0,
    categoryId: String(get('category_id')),
    receiptUrl: String(get('receipt_url') || '') || undefined,
    justification: String(get('justification') || '') || undefined,
    purpose: String(get('purpose') || '') || undefined,
    customFieldAnswers: parseJsonOr(get('custom_field_answers_json'), {}),
    approvalSteps: parseJsonOr(get('approval_steps_json'), []),
    approvals: parseJsonOr(get('approvals_json'), []),
    currentStepIndex: Number(get('current_step_index')) || 0,
    status: String(get('status') || 'pending'),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || ''),
    rejectionReason: String(get('rejection_reason') || '') || undefined,
  }
}

function getExpenses(acting) {
  var viewer = makeExpenseViewer(acting)
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EXPENSES)
  if (!sheet || sheet.getLastRow() < 2) return []
  var headers = headerRow(sheet)
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var apps = []
  rows.forEach(function (row) {
    var app = expenseRowToApplication(headers, row)
    if (!app.id) return
    if (canViewExpense(viewer, app)) apps.push(app)
  })
  // 新しい申請を先に(フロントの一覧と同じ並び)
  apps.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
  return apps
}

// ---- 採用の候補者(Candidates)の読み取り ------------------------------------------
//
// 候補者は電話番号・メールアドレス・履歴書などの個人情報を含むため、採用の権限を持つ人
// (管理画面の「採用」を開ける人 — admin-screen.tsx の canAccessRecruiting と同じ基準)にだけ返す:
//   代表 / 全権管理者 / 権限の例外(permission_overrides)で recruiting の edit・approve を持つ人
// 返す列は、下の規則がある列だけ(READ_POLICY と同じく、規則の無い列は返さない。
// 列を足した時は、ここに規則を足さない限り画面には届かない)。
//   recruiting  採用の権限を持つ人
var CANDIDATES_READ_POLICY = {
  columns: {
    id: 'recruiting',
    name: 'recruiting',
    email: 'recruiting',
    phone: 'recruiting',
    resume_text: 'recruiting',
    interview_notes: 'recruiting',
    status: 'recruiting',
    created_at: 'recruiting',
    updated_at: 'recruiting',
  },
}

// 採用の権限を持つか(Google のサービスを使わない。roles は役職の一覧)
function canViewRecruiting(acting, roles) {
  if (isFullAdminRoleRef(roles, acting.role)) return true
  var overrides = Array.isArray(acting.permission_overrides) ? acting.permission_overrides : []
  return overrides.some(function (ov) {
    return ov && ov.targetType === 'recruiting' && (ov.access === 'edit' || ov.access === 'approve')
  })
}

function candidateRowToObject(headers, row) {
  var get = function (name) {
    if (CANDIDATES_READ_POLICY.columns[name] !== 'recruiting') return ''
    var c = headers.indexOf(name)
    var v = c >= 0 ? row[c] : ''
    return v instanceof Date ? v.toISOString() : String(v == null ? '' : v)
  }
  return {
    id: get('id'),
    name: get('name'),
    email: get('email') || undefined,
    phone: get('phone') || undefined,
    resumeText: get('resume_text') || undefined,
    interviewNotes: get('interview_notes') || undefined,
    status: get('status') || 'candidate',
    createdAt: get('created_at'),
    updatedAt: get('updated_at'),
  }
}

function getCandidates(acting) {
  if (!canViewRecruiting(acting, getRoles())) return []
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CANDIDATES)
  if (!sheet || sheet.getLastRow() < 2) return []
  var headers = headerRow(sheet)
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var out = []
  rows.forEach(function (row) {
    var c = candidateRowToObject(headers, row)
    if (c.id) out.push(c)
  })
  out.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
  return out
}

// ---- フォームの回答(FormSubmissions)の読み取り ----------------------------------
//
// 閲覧できるのは: 申請者本人 / そのフォームの承認ステップの担当者(指定メンバー、または同じ役職 —
// approveCustomFormStep の担当者チェックと同じ基準) / 全権管理者 /
// 管理画面の「フォーム」セクションを許可された役職(役職の sections)

function makeFormViewer(acting) {
  var roles = getRoles()
  var role = String(acting.role || '').trim()
  var found = findRole(roles, role)
  var sections = found && found.sections
  return {
    id: String(acting.id || ''),
    role: role,
    roles: roles,
    isFullAdmin: isFullAdminRoleRef(roles, role),
    canOpenFormsSection: Array.isArray(sections) && sections.indexOf('forms') >= 0,
  }
}

// 1件の回答を閲覧できるか(Google のサービスを使わない純粋な関数)。
// steps はその回答のフォームの承認ステップ(Settings の custom_form_defs)
function canViewFormSubmission(viewer, sub, steps) {
  if (viewer.isFullAdmin || viewer.canOpenFormsSection) return true
  if (String(sub.submitterId) === viewer.id) return true
  steps = Array.isArray(steps) ? steps : []
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i] || {}
    if (step.type === 'member' && String(step.memberId || '') === viewer.id) return true
    if (step.type === 'role' && sameRole(viewer.roles || [], step.role, viewer.role)) return true
  }
  return false
}

function formSubmissionRowToObject(headers, row) {
  var get = function (name) {
    var c = headers.indexOf(name)
    return c >= 0 ? row[c] : ''
  }
  var createdAt = get('created_at')
  return {
    id: String(get('id')),
    formId: String(get('form_id')),
    submitterId: String(get('submitter_id')),
    answers: parseJsonOr(get('answers_json'), {}),
    approvals: parseJsonOr(get('approvals_json'), []),
    currentStepIndex: Number(get('current_step_index')) || 0,
    status: String(get('status') || 'pending'),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || ''),
    rejectionReason: String(get('rejection_reason') || '') || undefined,
  }
}

function getFormSubmissions(acting) {
  var viewer = makeFormViewer(acting)
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FORM_SUBMISSIONS)
  if (!sheet || sheet.getLastRow() < 2) return []
  var stepsByForm = {}
  parseJsonOr(getSettingValue('custom_form_defs'), []).forEach(function (f) {
    if (f && f.id) stepsByForm[String(f.id)] = f.approvalSteps || []
  })
  var headers = headerRow(sheet)
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var out = []
  rows.forEach(function (row) {
    var sub = formSubmissionRowToObject(headers, row)
    if (!sub.id) return
    if (canViewFormSubmission(viewer, sub, stepsByForm[sub.formId])) out.push(sub)
  })
  out.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
  return out
}

// ---- アップロードしたファイルの配信(非公開化) ----------------------------------
//
// アップロードしたファイルは非公開にし、getFiles で権限を確認してから返す。
// 返すのはアップロード用フォルダ(UPLOAD_FOLDER_ID)と旧フォルダ
// (LEGACY_UPLOAD_FOLDER_IDS)の中のファイルだけ — それ以外のIDを受け付けると、
// GAS を実行しているアカウントの Drive にある任意のファイルを読まれてしまう。
// 種類はファイル名の先頭で判断する(アップロード時に付けている名前)。
//   avatar_ / org_logo_ / survey_image_  ログイン済みの全員
//   expense_receipt_                     その領収書を持つ経費申請を閲覧できる人(canViewExpense)

var GET_FILES_MAX_IDS = 30
var GET_FILES_MAX_BYTES = 8 * 1024 * 1024
var FILE_CACHE_MAX_CHARS = 95000

function allowedUploadFolderIds() {
  var props = PropertiesService.getScriptProperties()
  var ids = []
  var current = props.getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (current) ids.push(current)
  splitCsvList(props.getProperty(LEGACY_UPLOAD_FOLDERS_PROPERTY_KEY)).forEach(function (id) {
    if (ids.indexOf(id) < 0) ids.push(id)
  })
  return ids
}

// ファイル名から種類を判定する(Google のサービスを使わない純粋な関数)
function uploadKindFromName(name) {
  var n = String(name || '')
  if (n.indexOf('expense_receipt_') === 0) return 'receipt'
  if (n.indexOf('avatar_') === 0) return 'avatar'
  if (n.indexOf('org_logo_') === 0) return 'orgLogo'
  if (n.indexOf('survey_image_') === 0) return 'surveyImage'
  return ''
}

// 種類ごとの閲覧可否。receiptApps は、その領収書のファイルIDを receipt_url に
// 含む経費申請の一覧(receipt の判定にだけ使う)
function canViewUploadedFile(kind, expenseViewer, receiptApps) {
  if (kind === 'avatar' || kind === 'orgLogo' || kind === 'surveyImage') return true
  if (kind === 'receipt') {
    for (var i = 0; i < receiptApps.length; i++) {
      if (canViewExpense(expenseViewer, receiptApps[i])) return true
    }
  }
  return false
}

function isInAllowedFolder(file, allowedIds) {
  var parents = file.getParents()
  while (parents.hasNext()) {
    if (allowedIds.indexOf(parents.next().getId()) >= 0) return true
  }
  return false
}

function getFiles(acting, fileIds) {
  var ids = (Array.isArray(fileIds) ? fileIds : []).map(String)
  if (ids.length > GET_FILES_MAX_IDS) throw userError('一度に取得できるファイルは' + GET_FILES_MAX_IDS + '件までです。')
  var allowed = allowedUploadFolderIds()
  var cache = CacheService.getScriptCache()
  var expenseViewer = null
  var expenses = null
  var totalBytes = 0
  return ids.map(function (id) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return { id: id, ok: false, error: 'invalid' }
    var file
    try { file = DriveApp.getFileById(id) } catch (e) { return { id: id, ok: false, error: 'notFound' } }
    if (!isInAllowedFolder(file, allowed)) return { id: id, ok: false, error: 'notFound' }
    var kind = uploadKindFromName(file.getName())
    var receiptApps = []
    if (kind === 'receipt') {
      if (!expenseViewer) expenseViewer = makeExpenseViewer(acting)
      if (!expenses) expenses = readAllExpenses()
      receiptApps = expenses.filter(function (app) { return String(app.receiptUrl || '').indexOf(id) >= 0 })
    }
    if (!canViewUploadedFile(kind, expenseViewer, receiptApps)) {
      return { id: id, ok: false, error: 'forbidden' }
    }
    // 小さい画像(アバター・ロゴなど)はキャッシュする。権限の確認は毎回行う。
    // 領収書はキャッシュしない
    var cacheKey = 'file:' + id
    if (kind !== 'receipt') {
      var hit = null
      try { hit = cache.get(cacheKey) } catch (e) { hit = null }
      if (hit) {
        var sep = hit.indexOf('|')
        return { id: id, ok: true, mimeType: hit.slice(0, sep), data: hit.slice(sep + 1) }
      }
    }
    var size = file.getSize()
    if (totalBytes + size > GET_FILES_MAX_BYTES) return { id: id, ok: false, error: 'batchTooLarge' }
    totalBytes += size
    var blob = file.getBlob()
    var mimeType = blob.getContentType() || 'application/octet-stream'
    var data = Utilities.base64Encode(blob.getBytes())
    if (kind !== 'receipt' && data.length + mimeType.length < FILE_CACHE_MAX_CHARS) {
      try { cache.put(cacheKey, mimeType + '|' + data, SNAPSHOT_CACHE_TTL) } catch (e) { /* キャッシュできなくても返す */ }
    }
    return { id: id, ok: true, mimeType: mimeType, data: data }
  })
}

function readAllExpenses() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EXPENSES)
  if (!sheet || sheet.getLastRow() < 2) return []
  var headers = headerRow(sheet)
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().map(function (row) {
    return expenseRowToApplication(headers, row)
  })
}

// 段階③(手動実行): アップロード用フォルダと旧フォルダ内の「リンクを知っている
// 全員が閲覧可」のファイルを非公開にする。領収書を先に処理する。以後の新規
// アップロードも非公開になる(UPLOADS_PRIVATE)。extraFolderId を渡すと、
// そのフォルダも対象にする。実行時間の上限に近づいたら途中で止まり、ログに
// 再実行を促すメッセージを出す(何度実行しても問題ない)。
function makeUploadsPrivate(extraFolderId) {
  var props = PropertiesService.getScriptProperties()
  props.setProperty(UPLOADS_PRIVATE_PROPERTY_KEY, 'true')
  var folderIds = allowedUploadFolderIds()
  if (extraFolderId && folderIds.indexOf(String(extraFolderId)) < 0) folderIds.push(String(extraFolderId))
  var deadline = Date.now() + 5 * 60 * 1000
  var changed = { receipt: 0, other: 0 }
  var finished = true
  // 1周目は領収書だけ、2周目はそれ以外
  ;['receipt', 'other'].forEach(function (pass) {
    if (!finished) return
    folderIds.forEach(function (folderId) {
      if (!finished) return
      var folder
      try { folder = DriveApp.getFolderById(folderId) } catch (e) {
        console.error('❌ フォルダを開けません: ' + folderId)
        return
      }
      var files = folder.getFiles()
      while (files.hasNext()) {
        if (Date.now() > deadline) { finished = false; return }
        var file = files.next()
        var isReceipt = uploadKindFromName(file.getName()) === 'receipt'
        if ((pass === 'receipt') !== isReceipt) continue
        var access = file.getSharingAccess()
        if (access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE) {
          file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
          changed[pass]++
        }
      }
    })
  })
  var msg = '🔒 非公開にしたファイル: 領収書 ' + changed.receipt + ' 件、その他 ' + changed.other + ' 件'
  msg += finished ? '\n✅ すべて完了しました' : '\n⏳ 実行時間の上限に近づいたため途中で止めました。もう一度 makeUploadsPrivate() を実行してください'
  console.log(msg)
  return msg
}

// 確認用(手動実行): フォルダごと・種類ごとに、公開/非公開のファイル数を出力する
function auditUploadSharing(extraFolderId) {
  var folderIds = allowedUploadFolderIds()
  if (extraFolderId && folderIds.indexOf(String(extraFolderId)) < 0) folderIds.push(String(extraFolderId))
  var lines = ['📋 アップロードファイルの共有設定 (新規アップロードの非公開化: ' +
    (PropertiesService.getScriptProperties().getProperty(UPLOADS_PRIVATE_PROPERTY_KEY) === 'true' ? '有効' : '無効') + ')']
  folderIds.forEach(function (folderId) {
    var counts = {}
    try {
      var files = DriveApp.getFolderById(folderId).getFiles()
      while (files.hasNext()) {
        var file = files.next()
        var kind = uploadKindFromName(file.getName()) || 'unknown'
        var access = file.getSharingAccess()
        var isPublic = access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE
        counts[kind] = counts[kind] || { public: 0, private: 0 }
        counts[kind][isPublic ? 'public' : 'private']++
      }
    } catch (e) {
      lines.push('  ' + folderId + ': 開けません (' + e + ')')
      return
    }
    lines.push('  フォルダ ' + folderId + ':')
    Object.keys(counts).forEach(function (kind) {
      lines.push('    ' + kind + ': 公開 ' + counts[kind].public + ' / 非公開 ' + counts[kind].private)
    })
  })
  console.log(lines.join('\n'))
  return lines.join('\n')
}

// ---- Discord / Slack の連携状態 ----------------------------------------------
//
// Webhook URL は秘密情報なので、スクリプトプロパティから外には出さない。
// 画面には「設定済みかどうか」と、最後のテスト送信の結果・日時だけを返す
// (getWebhookStatus。全権管理者と、Webhook を設定できる人だけが呼べる —
// authorizeAction で updateDiscordWebhookUrl と同じ基準)。
// テスト送信の結果・日時はスクリプトプロパティに保存する。

var WEBHOOK_TEST_RESULT_PROPERTY_KEYS = {
  discord: 'discord_webhook_last_test',
  slack: 'slack_webhook_last_test',
}

function recordWebhookTestResult(kind, ok, error) {
  PropertiesService.getScriptProperties().setProperty(
    WEBHOOK_TEST_RESULT_PROPERTY_KEYS[kind],
    JSON.stringify({ ok: !!ok, at: new Date().toISOString(), error: error || '' }),
  )
}

function clearWebhookTestResult(kind) {
  PropertiesService.getScriptProperties().deleteProperty(WEBHOOK_TEST_RESULT_PROPERTY_KEYS[kind])
}

function readWebhookTestResult(kind) {
  var raw = PropertiesService.getScriptProperties().getProperty(WEBHOOK_TEST_RESULT_PROPERTY_KEYS[kind])
  if (!raw) return null
  try {
    var parsed = JSON.parse(raw)
    return { ok: !!parsed.ok, at: String(parsed.at || ''), error: String(parsed.error || '') }
  } catch (e) {
    return null
  }
}

// テスト送信。通信自体に失敗した場合(例外)も結果として保存してから投げ直す
function fetchWebhookForTest(kind, url, options) {
  if (isChatSuppressed()) {
    throw userError('テスト環境では Discord・Slack に投稿しません。接続を確かめる場合は、スクリプトプロパティ TEST_ALLOW_CHAT を true にしてください。')
  }
  try {
    return UrlFetchApp.fetch(url, options)
  } catch (e) {
    recordWebhookTestResult(kind, false, '送信できませんでした')
    throw userError((kind === 'discord' ? 'Discord' : 'Slack') + 'への送信に失敗しました。Webhook URLが正しいか確認してください。')
  }
}

function getWebhookStatus() {
  return {
    discord: { configured: !!getDiscordWebhookUrl(), lastTest: readWebhookTestResult('discord') },
    slack: { configured: !!getSlackWebhookUrl(), lastTest: readWebhookTestResult('slack') },
  }
}

// ---- 性能計測用のダミーデータ(テスト環境専用) ----------------------------------
//
// 本番と同じくらいの規模(メンバー50人・プロジェクト20件・タスク500件)の
// ダミーデータを作り、measureReadPerformance() で規模を再現した計測ができる
// ようにする。本番で誤って実行されないよう、スクリプトプロパティ
// TEST_ENVIRONMENT が 'true' のときだけ動く。ダミーデータの id はすべて
// 'perf-' で始まり、deletePerformanceTestData() でまとめて削除できる。
//
// 使い方(Apps Script エディタで実行):
//   1. スクリプトプロパティ TEST_ENVIRONMENT を true にする
//   2. seedPerformanceTestData() を実行する
//   3. measureReadPerformance() を実行して結果を確認する
//   4. deletePerformanceTestData() を実行してダミーデータを消す

var PERF_TEST_ID_PREFIX = 'perf-'
var PERF_TEST_COUNTS = { members: 50, projects: 20, tasks: 500 }

function assertTestEnvironment() {
  if (!isTestEnvironment()) {
    throw userError('テスト環境ではないため実行できません。スクリプトプロパティ TEST_ENVIRONMENT を true にしてから実行してください。')
  }
}

// 同じ結果を再現できるよう、乱数は種を固定した簡易な生成器を使う
function makePerfRandom(seed) {
  var state = seed >>> 0
  var next = function () {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  return {
    next: next,
    int: function (min, max) { return min + Math.floor(next() * (max - min + 1)) },
    pick: function (list) { return list[Math.floor(next() * list.length)] },
    chance: function (p) { return next() < p },
    sample: function (list, n) {
      var copy = list.slice()
      var out = []
      while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0])
      return out
    },
  }
}

function perfDate(daysFromBase) {
  var d = new Date(Date.UTC(2026, 0, 1) + daysFromBase * 86400000)
  return d.toISOString().slice(0, 10)
}

function perfText(rng, minLen, maxLen) {
  var words = ['資料を確認しました', '来週までに対応します', '先方に連絡済みです', '修正版をアップしました',
    'レビューをお願いします', '日程を調整中です', '予算の見直しが必要です', '進捗を共有します',
    '担当を追加しました', '参考資料を添付します', '確認事項があります', '次回の定例で相談します']
  var len = rng.int(minLen, maxLen)
  var s = ''
  while (s.length < len) s += rng.pick(words) + '。'
  return s
}

// メンバー・プロジェクト・タスクの行を作る(Google のサービスを使わない純粋な関数)。
// 返り値は { Members: [...], Projects: [...], Tasks: [...] } で、各要素は
// {列名: 値} のオブジェクト。割合は実際の団体に近づけている:
//   役職: 代表1人・事業責任者2人・班長7人・一般40人
//   タスク: 幹部限定 約10%、承認待ち 約5%、コメント付き 約35%、履歴付き 約60%
function buildPerformanceTestData(seed) {
  var rng = makePerfRandom(seed || 20260928)
  var P = PERF_TEST_ID_PREFIX
  var pad = function (n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s }
  var departments = ['運営', '広報', '開発', 'デザイン', '渉外', 'イベント', 'リサーチ']
  var skills = ['企画', '広報', 'デザイン', 'リサーチ', 'イベント運営', 'メール', '実装', '要件定義', '校閲']
  var statuses = ['未着手', '進行中', '進行中', '進行中', '確認待ち', '修正中', '保留', 'サポート必要', '完了', '完了', '完了']
  var difficulties = ['誰でも可', '新人歓迎', '少し経験必要', '経験者向け', '上級者向け']
  var colors = ['#6366f1', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6']

  var projects = []
  for (var p = 1; p <= PERF_TEST_COUNTS.projects; p++) {
    projects.push({ id: P + 'p-' + pad(p, 2), name: 'ダミープロジェクト' + p })
  }

  var members = []
  for (var m = 1; m <= PERF_TEST_COUNTS.members; m++) {
    var role = m === 1 ? '代表' : m <= 3 ? '事業責任者' : m <= 10 ? '班長' : '一般'
    var id = P + 'm-' + pad(m, 2)
    var myProjects = role === '班長' ? rng.sample(projects, 2).map(function (x) { return x.id }) : []
    var hasHr = role !== '一般' || rng.chance(0.4)
    members.push({
      id: id,
      name: 'ダミー' + pad(m, 2),
      display_name: 'ダミー' + pad(m, 2),
      role: role,
      avatar_color: rng.pick(colors),
      avatar_initials: 'D' + (m % 10),
      will_tags: rng.sample(skills, 2).join(','),
      judgment_tags: rng.sample(skills, 2).join(','),
      reports_to_id: m > 10 ? P + 'm-' + pad(rng.int(4, 10), 2) : m > 1 ? P + 'm-01' : '',
      joined_at: perfDate(-rng.int(30, 900)),
      project_ids: myProjects.join(','),
      department_path: '事業本部>' + rng.pick(departments),
      skill_levels_json: JSON.stringify(rng.sample(skills, 3).map(function (s) { return { skill: s, level: rng.int(1, 5) } })),
      skill_points_json: JSON.stringify({ '企画': rng.int(0, 400), 'デザイン': rng.int(0, 400) }),
      career_history_json: hasHr ? JSON.stringify([{ id: 'c1', startDate: perfDate(-600), title: '担当', note: perfText(rng, 20, 60) }]) : '',
      evaluation_history_json: hasHr ? JSON.stringify([{ id: 'e1', date: perfDate(-90), rating: rng.int(1, 5), comment: perfText(rng, 40, 120) }]) : '',
      one_on_ones_json: hasHr ? JSON.stringify([{ id: 'o1', date: perfDate(-30), notes: perfText(rng, 60, 200) }]) : '',
      survey_responses_json: rng.chance(0.6) ? JSON.stringify([{ id: 's1', submittedAt: perfDate(-10), answers: { q1: rng.int(1, 5), q2: rng.int(1, 5) } }]) : '',
      last_login: perfDate(-rng.int(0, 40)) + 'T09:00:00.000Z',
      timezone: 'Asia/Tokyo',
      locale: 'ja',
    })
  }
  projects.forEach(function (proj) {
    var mids = rng.sample(members, rng.int(5, 10)).map(function (x) { return x.id })
    proj.description = perfText(rng, 40, 120)
    proj.goal = perfText(rng, 20, 60)
    proj.owner_id = P + 'm-' + pad(rng.int(1, 10), 2)
    proj.member_ids = mids.join(',')
    proj.archived = 'FALSE'
    proj.start_date = perfDate(-rng.int(30, 300))
  })

  var tasks = []
  for (var t = 1; t <= PERF_TEST_COUNTS.tasks; t++) {
    var assignees = rng.sample(members, rng.int(0, 2)).map(function (x) { return x.id })
    var creator = rng.pick(members).id
    var comments = []
    if (rng.chance(0.35)) {
      for (var c = 0, nc = rng.int(1, 6); c < nc; c++) {
        comments.push({ id: 'cm' + c, byId: rng.pick(members).id, at: perfDate(rng.int(0, 250)) + 'T10:00:00.000Z', text: perfText(rng, 30, 200) })
      }
    }
    var history = []
    if (rng.chance(0.6)) {
      for (var h = 0, nh = rng.int(2, 8); h < nh; h++) {
        history.push({ at: perfDate(rng.int(0, 250)) + 'T10:00:00.000Z', byId: rng.pick(members).id, type: 'status', from: rng.pick(statuses), to: rng.pick(statuses) })
      }
    }
    tasks.push({
      id: P + 't-' + pad(t, 4),
      project_id: rng.pick(projects).id,
      title: 'ダミータスク' + t,
      description: perfText(rng, 40, 300),
      status: rng.pick(statuses),
      assign_type: assignees.length ? 'direct' : 'open_bid',
      assignee_id: assignees.join(','),
      creator_id: creator,
      created_at: perfDate(rng.int(0, 250)),
      start_date: perfDate(rng.int(0, 250)),
      due_date: perfDate(rng.int(0, 300)),
      visibility: rng.chance(0.1) ? '幹部' : 'all',
      department: rng.pick(departments),
      category: rng.pick(['企画', '制作', '連絡', '会計', '調査']),
      skills: rng.sample(skills, rng.int(1, 3)).join(','),
      difficulty: rng.pick(difficulties),
      priority: rng.pick(['高', '中', '中', '低']),
      approval_status: rng.chance(0.05) ? '承認待ち' : '',
      importance: rng.chance(0.1) ? '重要' : '一般',
      progress_note: rng.chance(0.3) ? perfText(rng, 20, 100) : '',
      progress_percent: String(rng.int(0, 100)),
      comments_json: comments.length ? JSON.stringify(comments) : '',
      history_json: history.length ? JSON.stringify(history) : '',
    })
  }
  return { Members: members, Projects: projects, Tasks: tasks }
}

// 行オブジェクトをシートの見出しに合わせて末尾に一括で書き込む
// (見出しに無い列は捨てる。日付の自動変換を避けるため書式なしテキストにする)
function appendPerfRows(sheetName, objects) {
  if (objects.length === 0) return 0
  var sheet = getSheet(sheetName)
  var headers = headerRow(sheet)
  var values = objects.map(function (obj) {
    return headers.map(function (h) { return obj[h] != null ? String(obj[h]) : '' })
  })
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length)
  range.setNumberFormat('@')
  range.setValues(values)
  return values.length
}

function countPerfRows(sheetName) {
  var sheet = getSheet(sheetName)
  var headers = headerRow(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0 || sheet.getLastRow() < 2) return 0
  return sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues().filter(function (r) {
    return String(r[0]).indexOf(PERF_TEST_ID_PREFIX) === 0
  }).length
}

// ダミーデータを作る(テスト環境専用)。既にダミーデータがある場合は、先に
// deletePerformanceTestData() で消すよう促して止まる(重複を防ぐため)
function seedPerformanceTestData() {
  assertTestEnvironment()
  var existing = countPerfRows(SHEET_MEMBERS) + countPerfRows(SHEET_PROJECTS) + countPerfRows(SHEET_TASKS)
  if (existing > 0) {
    throw userError('ダミーデータが既に ' + existing + ' 行あります。deletePerformanceTestData() で削除してから実行してください。')
  }
  var data = buildPerformanceTestData()
  var counts = {
    members: appendPerfRows(SHEET_MEMBERS, data.Members),
    projects: appendPerfRows(SHEET_PROJECTS, data.Projects),
    tasks: appendPerfRows(SHEET_TASKS, data.Tasks),
  }
  bumpDataVersion()
  var msg = '🧪 ダミーデータを作成しました: メンバー ' + counts.members + ' 人、プロジェクト ' + counts.projects +
    ' 件、タスク ' + counts.tasks + ' 件。続けて measureReadPerformance() を実行してください。'
  console.log(msg)
  return msg
}

// ダミーデータ(id が 'perf-' で始まる行)を Members / Projects / Tasks から
// まとめて削除する(テスト環境専用)。それ以外の行には触れない
function deletePerformanceTestData() {
  assertTestEnvironment()
  var deleted = {}
  ;[SHEET_TASKS, SHEET_PROJECTS, SHEET_MEMBERS].forEach(function (name) {
    var sheet = getSheet(name)
    var headers = headerRow(sheet)
    var idCol = headers.indexOf('id')
    deleted[name] = 0
    if (idCol < 0 || sheet.getLastRow() < 2) return
    var ids = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues()
    // 下の行から、連続したダミー行をまとめて削除する(行番号がずれないように)
    var i = ids.length - 1
    while (i >= 0) {
      if (String(ids[i][0]).indexOf(PERF_TEST_ID_PREFIX) !== 0) { i--; continue }
      var end = i
      while (i >= 0 && String(ids[i][0]).indexOf(PERF_TEST_ID_PREFIX) === 0) i--
      var count = end - i
      sheet.deleteRows(i + 3, count)
      deleted[name] += count
    }
  })
  bumpDataVersion()
  var msg = '🧹 ダミーデータを削除しました: メンバー ' + deleted[SHEET_MEMBERS] + ' 行、プロジェクト ' +
    deleted[SHEET_PROJECTS] + ' 行、タスク ' + deleted[SHEET_TASKS] + ' 行'
  console.log(msg)
  return msg
}

// ---- 画面確認用のサンプルのデータ(テスト環境専用) --------------------------------
//
// すべての機能が実際に使われている状態を再現し、画面が実際のデータでどう表示されるかを
// 確かめるためのデータ。性能計測用(seedPerformanceTestData)とは別のもので、規模は
// メンバー約20人・プロジェクト約8件・タスク約150件。
//   - TEST_ENVIRONMENT が true の時だけ動く
//   - 何度実行しても重複しない(既存のサンプルを消してから作り直す)
//   - 日付はすべて実行した日を基準にする(いつ実行しても、期限切れ・今週締切・来月開始・
//     完了から日が経ってアーカイブされたもの などが再現される)
//   - id はすべて 'sample-' で始まり、deleteSampleData() でまとめて消せる
//   - Settings は既存の設定を上書きせずに追加し、deleteSampleData() で元に戻す
//
// 使い方(Apps Script エディタで実行):
//   1. スクリプトプロパティ TEST_ENVIRONMENT を true にする
//   2. (任意)スクリプトプロパティ TEST_ACCOUNTS に、テスト用の Google アカウントを枠ごとに書く
//        例: top=a@gmail.com, admin=b@gmail.com, restricted=c@gmail.com, base=d@gmail.com, base_en=e@gmail.com
//   3. seedSampleData() を実行する
//   4. 確認が終わったら deleteSampleData() を実行する

var SAMPLE_ID_PREFIX = 'sample-'

// ダミー画像(小さな PNG。アップロード用フォルダに非公開で保存する)
var SAMPLE_IMAGES = {
  avatar1: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUXo1sX8reO6NiaLzA+4NBXBWzNC2/Rj6NAAAAAAAAAAAAAAArkd3jQHQU6UBeldRgHoqB1B/hQD6GgALgP4FAAAAAKsDeMiYhZhGZ9kHZtjIZtiJ+VYBAAAAAAAAGObWWWhkURpAdiUAZF0oQD4FAeSZO0D+OQIUFYDU23cZlgEoIwAAAACoDzgBVUlksz1wI6MAAAAASUVORK5CYII=',
  avatar2: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUbqxRIu1mOfemCg6P+DeUABnxQzt2PahTwMAAAAAAAAAAAAA4Hp01xgAPVUaoHcVBaincgD1VwigrwGwAOhfAAAAALA6gIeMWYhpdJZ9YIaNbIadmG8VAAAAAAAAgGFunYVGFqUBZFcCQNaFAuRTEECeuQPknyNAUQFIvX2XYRmAMgIAAACA+oATz4ZJzMMhujMAAAAASUVORK5CYII=',
  avatar3: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUTYWa0O2+9wbE0XnB9wbCuCsmKFtxz70aQAAAAAAAAAAAAAAXI/uGgOgp0oD9K6iAPVUDqD+CgH0NQAWAP0LAAAAAFYH8JAxCzGNzrIPzLCRzbAT860CAAAAAAAAMMyts9DIojSA7EoAyLpQgHwKAsgzd4D8cwQoKgCpt+8yLANQRgAAAABQH3AC6Dey8NVVlbYAAAAASUVORK5CYII=',
  avatar4: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUVa2bK1W89wbE0XnB9wbCuCsmKEd+zb0aQAAAAAAAAAAAAAAXI/uGgOgp0oD9K6iAPVUDqD+CgH0NQAWAP0LAAAAAFYH8JAxCzGNzrIPzLCRzbAT860CAAAAAAAAMMyts9DIojSA7EoAyLpQgHwKAsgzd4D8cwQoKgCpt+8yLANQRgAAAABQH3ACJUedwPg9QmMAAAAASUVORK5CYII=',
  logo: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACK0lEQVR42u3d0W3DMBCDYe4aoPtngnaEIoisI3l/wefUpy+OL7Es6fXzJoMRQwAAAAQAAAgAABAAACAAAEAAAIAAAAABAAACAAAEAAAIAAAQAAAgAABAAADg//x+/gfAwKAv95Dn0O/BkP/Qd2PowtCbvGwbwLUB6pbQE4My1VltAXAYghqGkwAjBaQzqKbgUAaV1RnHoMryghi+BXB+c0UwNANEHHM/gPmRa8PoO5ewC8CwinUAbrV8dQ2I/hXMxGAvgElF2wHGTwUAhkvb8j3A1kBxH5plBgAMn+WpAE//0HatTMW1blOTAQAYmLFyoVIFNQwjk7eerjQGYHAC3aPFKqJjG5/E+FyxAAzXK/8+wWcmrx3AHQNPgFOvDMBwvfJv1NweJjj7+vJv1Ayf5jj4L+TfqAEw2SR4Ahw0kH+nbPI94KF6Zd4kABBsEHEHTebXqPFfQyMBxg2CbiPL/CNy8I5YPMD9vihxLoUuH9yGiRReAMwmsgBYNa3xo+oUdL2qPAkU9GYBgFOhBaDvVMgD4KGzeYAmhmCA1+4nkNXRTfM9YDVDFcArcM2fNoAshi+PU3Fnd9kCXQq9ytmuUtcJcLBgt4NRQccdvWpp6gYONUv3xu+gkb6Edc8WJqFLubftIRO3mUHzJj4R+0hs2UXJdguPpdtY+Uz1ZR+x4QAAAAAEAAAIAAAQAAAgAABAAACAAAAAAQAAAgAABAAACAAAEAAAIAAAQA7mD0B1Q6FafX4vAAAAAElFTkSuQmCC',
  receipt: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAEECAIAAADiZ+yyAAACc0lEQVR42u3cwQ2EMAwAwVRCJdRJrTzyoAP4xEmMx5oKotXJQta13m8YrnkChIWwEBYIC2EhLBAWwkJYICx+HdZpZo2wjLCEJSxhCUtYRljCEpawhOU7Fr5jeQWEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWDA5rMvkGWGZZA0JS0N2LCzvICyEhbBAWAgLYYGwEBbCAmEhLIQFwsI9lsl2pyUsDQlLQ3Ys7FheAWEhLIQFwkJYCAuEhbAQFggLYSEsEBYuSE21Oy1haUhYGrJjYcfyCggLYSEsEBbCQlggLISFsEBYCAthgbBwj2Wq3WkJS0PC0pAdCzuWV0BYCAthgbAQFsICYSEshAXCQlgIC4SFeyxT7U5LWBoSlobsWNixvALCQlgIC4SFsBAWCAthISwQFsJCWCAs3GOZandawtKQsEye7u1YWN4RFsLyCggLYSEsEBbCQlggLISFsEBYCAthucdy6ycss3H3wjIhv512LCzvCAtheQWEhbAQFggLYSEsEBbCQlggLISFsNxjmTF3WsIyIbd+wtKQHQvLO8LyCggLYSEsEBbCQlggLISFsEBYCAthgXsss/GdlrA05BfL5PlvZjsWwkJYCMsrICyEhbBAWAgLYYGwEBbCAmEhLITlHsudlrDMxrd+wtKQHQvLO8LyCggLYSEsEBbCQlggLISFsPhw1BthCUtYwhIWwnKPZd5GWGZNQ8IyIQ3ZsfAdC2GBsBAWwgJhISyEBcJCWAgLhIWwEBasDMs5lP/1E5aGhGVSNWTHQlgIC4SFsMjsAVooUljkMTzyAAAAAElFTkSuQmCC',
  survey: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABbUlEQVR42u3cuxHCQAwFQPdKTkxAREwKZdAGndDGowd88sl436iDHY/vI91yen5K63qvrcettl6X2nqfa2sBDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAjwGcXwN4B8BZF8CtgTMigJsCZ1wAtwPO6ABuBJyaAG4BnMoAngyc+gCeBpytAngCcLYN4E2BMyOANwLOvAAuB87sAC4ETo8ALgFOpwAeDJx+ATwMOF0D+J91hxgfHTh7COB/1l1pfFzg7C2AfcGA/YOtoq2i7YPtg51kOclyFu0s2m0SYPfBgHV0ANaTpatSV6W+aH3RJhtMNphNAmy6ELD5YMAm/AF7o8MrO2t1AXsnC7CX7gADBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgx4d8BfqAF1isqXnKAAAAAASUVORK5CYII=',
}


// テスト用のアカウントを割り当てる枠(TEST_ACCOUNTS の名前)と、その枠のサンプルのメンバー
var SAMPLE_ACCOUNT_SLOTS = {
  top: 'sample-m-01',        // 最上位(代表)
  admin: 'sample-m-02',      // 全権管理者(事業責任者)
  restricted: 'sample-m-03', // 制限付きの管理者(サンプル班長)
  base: 'sample-m-05',       // 一般
  base_en: 'sample-m-06',    // 一般・英語表示
}

// サンプルで使う役職名(内部コード化で役職がIDになったら、ここも合わせて変える)
var SAMPLE_ROLES = { top: '代表', admin: '事業責任者', restricted: 'サンプル班長', base: '一般' }

// フロント(lib/ohsumi/store.tsx)の既定の選択肢。Settings の値が空の団体では画面がこの
// 既定値を使うため、サンプルの値を足す時はこの既定値に足す(テストで一致を確かめる)
var SAMPLE_LIST_DEFAULTS = {
  skill_options: ['デザイン', 'Canva', 'PowerPoint', 'ライティング', 'リサーチ', 'SNS', '広報', 'コミュニケーション',
    'イベント運営', 'メール', 'UI/UX', '実装', '企画', '要件定義', 'プロダクト設計', '校閲', 'Claude', 'V0'],
  category_options: ['未分類', 'デザイン', '渉外', 'イベント', '広報', 'ライティング', '企画', 'リサーチ', '開発', '物品調達'],
  skill_field_options: ['デザイン', '営業', 'AI活用'],
  role_levels: ['班長', '事業責任者', '代表'],
  restricted_roles: [],
}

// ---- 日付(実行した日を基準にする。Google のサービスを使わない) ----

function sampleDay(today, offset) {
  var p = String(today).split('-')
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + offset * 86400000)
  return d.toISOString().slice(0, 10)
}

// その日の日本時間の時刻(ISO 形式)
function sampleAt(today, offset, hhmm) {
  var t = String(hhmm || '10:00').split(':')
  var utcHour = (Number(t[0]) + 24 - 9) % 24
  var day = Number(t[0]) < 9 ? sampleDay(today, offset - 1) : sampleDay(today, offset)
  var hh = utcHour < 10 ? '0' + utcHour : String(utcHour)
  return day + 'T' + hh + ':' + t[1] + ':00.000Z'
}

function samplePad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s }

function sampleJson(v) { return v == null ? '' : JSON.stringify(v) }

// ---- メンバー ----

// 役割の違うメンバー(人格)。files はアップロードしたダミー画像の URL(キー → URL)
function buildSampleMembers(today, files) {
  var R = SAMPLE_ROLES
  var d = function (n) { return sampleDay(today, n) }
  var people = [
    // 01 代表: 経歴・スキル・評価がすべて豊富
    { n: 1, name: '高橋 誠', role: R.top, avatar: 'avatar1', joined: -1400, will: '企画,コミュニケーション,広報', judgment: '企画,要件定義,リサーチ',
      rich: true, management: true, dept: 'サンプル本部>運営', locale: 'ja' },
    // 02 全権管理者
    { n: 2, name: '伊藤 さくら', role: R.admin, avatar: 'avatar2', joined: -1000, will: 'デザイン,UI/UX,Canva', judgment: 'デザイン,Canva,PowerPoint',
      rich: true, management: true, dept: 'サンプル本部>デザイン', reportsTo: 1, locale: 'ja' },
    // 03 制限付きの管理者(担当プロジェクトだけを管理する)
    { n: 3, name: '渡辺 大輔', role: R.restricted, avatar: 'avatar3', joined: -700, will: 'イベント運営,企画', judgment: 'イベント運営,メール',
      rich: true, dept: 'サンプル本部>イベント', reportsTo: 2, projects: [2, 3], locale: 'ja' },
    // 04 制限付きの管理者(もう1人)
    { n: 4, name: '中村 優子', role: R.restricted, joined: -500, will: 'ライティング,広報,SNS', judgment: 'ライティング,校閲',
      dept: 'サンプル本部>広報', reportsTo: 2, projects: [4], locale: 'ja' },
    // 05 一般(テスト用アカウントの一般の枠): ほどほどにデータがある
    { n: 5, name: '小林 陽太', role: R.base, avatar: 'avatar4', joined: -300, will: 'デザイン,SNS,Canva', judgment: 'Canva',
      dept: 'サンプル本部>デザイン', reportsTo: 3, mentor: 2, locale: 'ja', medium: true },
    // 06 一般・英語表示
    { n: 6, name: 'Emily Carter', display: 'Emily', role: R.base, joined: -200, will: 'リサーチ,ライティング,コミュニケーション', judgment: 'リサーチ,ライティング',
      dept: 'サンプル本部>リサーチ', reportsTo: 3, locale: 'en', timezone: 'America/Los_Angeles', medium: true },
    // 07 ほぼ空(新しく入ったばかりで、何も入力していない)
    { n: 7, name: '加藤 蓮', role: R.base, joined: -3, empty: true },
    // 08 休止中
    { n: 8, name: '吉田 美咲', role: R.base, joined: -900, will: 'イベント運営', judgment: 'イベント運営,コミュニケーション', inactive: true,
      dept: 'サンプル本部>イベント', lastLogin: -60 },
    // 09 とても長い名前(表示の崩れの確認)
    { n: 9, name: '長谷川 アレクサンドラ 由紀子 ヴィクトリア シャーロット', display: '長谷川アレクサンドラ由紀子ヴィクトリアシャーロット(広報・デザイン・イベント担当)',
      role: R.base, joined: -150, will: 'デザイン,広報,イベント運営,SNS,Canva,PowerPoint,ライティング', judgment: 'デザイン,広報,SNS',
      dept: 'サンプル本部>広報>SNS チーム>とても長い部署名のグループ', reportsTo: 4 },
    // 10 所属3日目(Will だけ入力済み)
    { n: 10, name: '山本 健', role: R.base, joined: -2, will: '実装,Claude', judgment: '' },
  ]
  var others = [
    ['佐々木 翔', '実装,要件定義', '実装,プロダクト設計,Claude', 'サンプル本部>開発'],
    ['山口 真央', 'リサーチ,企画', 'リサーチ', 'サンプル本部>リサーチ'],
    ['松本 拓海', 'イベント運営,メール', 'イベント運営', 'サンプル本部>イベント'],
    ['井上 楓', '広報,SNS,ライティング', 'SNS,広報', 'サンプル本部>広報'],
    ['木村 悠斗', 'デザイン,UI/UX', 'UI/UX,デザイン', 'サンプル本部>デザイン'],
    ['林 結衣', '企画,コミュニケーション', 'コミュニケーション', 'サンプル本部>運営'],
    ['清水 颯', '実装,V0,Claude', 'V0,実装', 'サンプル本部>開発'],
    ['森 美月', 'ライティング,校閲', '校閲,ライティング', 'サンプル本部>広報'],
    ['池田 陸', 'PowerPoint,企画', 'PowerPoint', 'サンプル本部>運営'],
    ['橋本 七海', 'リサーチ,データ分析', 'リサーチ,データ分析', 'サンプル本部>リサーチ'],
  ]
  others.forEach(function (o, i) {
    people.push({ n: 11 + i, name: o[0], role: R.base, joined: -60 - i * 45, will: o[1], judgment: o[2], dept: o[3], reportsTo: i % 2 ? 3 : 4 })
  })

  var id = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad(n, 2) }
  var colors = ['#6366f1', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6', '#dc2626', '#16a34a']
  return people.map(function (p) {
    var skills = (p.will + ',' + p.judgment).split(',').filter(Boolean)
    var uniq = skills.filter(function (s, i) { return skills.indexOf(s) === i })
    var row = {
      id: id(p.n),
      name: p.name,
      display_name: p.display || '',
      role: p.role,
      notify_new_task: p.n <= 4 ? 'TRUE' : 'FALSE',
      avatar_url: p.avatar && files[p.avatar] ? files[p.avatar] : '',
      avatar_color: colors[p.n % colors.length],
      avatar_initials: '',
      will_tags: p.empty ? '' : p.will,
      judgment_tags: p.empty ? '' : p.judgment,
      reports_to_id: p.reportsTo ? id(p.reportsTo) : '',
      mentor_id: p.mentor ? id(p.mentor) : '',
      joined_at: d(p.joined),
      project_ids: (p.projects || []).map(function (x) { return SAMPLE_ID_PREFIX + 'p-' + samplePad(x, 2) }).join(','),
      department_path: p.dept || '',
      inactive: p.inactive ? 'TRUE' : '',
      last_login: p.empty ? '' : sampleAt(today, p.lastLogin != null ? p.lastLogin : -(p.n % 5), '09:30'),
      locale: p.locale || '',
      timezone: p.timezone || (p.empty ? '' : 'Asia/Tokyo'),
    }
    if (p.empty) return row
    // Fact(実績)とレベルの表示のため、スキルのレベル・ポイントは全員に少しずつ入れる
    row.skill_levels_json = sampleJson(uniq.slice(0, 5).map(function (s, i) {
      return { skill: s, level: Math.max(1, Math.min(5, (p.rich ? 4 : 2) + (i % 2) - (i > 2 ? 1 : 0))), acquiredAt: d(p.joined + 30) }
    }))
    var points = {}
    uniq.forEach(function (s, i) { points[s] = (p.rich ? 320 : p.medium ? 140 : 60) - i * 20 })
    row.skill_points_json = sampleJson(points)
    row.desired_areas = p.n % 3 === 0 ? '' : 'マネジメント,新規事業'
    row.desired_skills = p.n % 2 ? 'データ分析,UI/UX' : 'Claude'
    row.unavailable_dates = p.n % 4 === 0 ? [d(3), d(4), d(10)].join(',') : ''
    row.absent_dates = p.n % 5 === 0 ? [d(1), d(8)].join(',') : ''
    row.available_hours_json = p.n % 3 === 0 ? sampleJson({ start: '10:00', end: '18:00' }) : ''
    row.has_management_experience = p.management ? 'TRUE' : ''
    row.university = p.locale === 'en' ? 'University of Washington' : p.n % 2 ? 'サンプル大学' : ''
    row.faculty = p.n % 2 ? '経済学部' : ''
    row.department_name = p.n % 2 ? '経営学科' : ''
    row.grade_year = p.n % 2 ? String(1 + (p.n % 4)) : ''
    row.custom_fields_json = sampleJson({ sample_slack: '@' + ('member' + p.n), sample_shirt: p.n % 2 ? 'M' : 'L' })
    row.notify_settings = p.n === 5 ? sampleJson({ new_task: 'immediate', review: '1d', mention: 'immediate', deadline: 'none' }) : ''
    if (p.rich || p.medium) {
      row.career_history_json = sampleJson([
        { id: 'ch1', startDate: d(p.joined), affiliation: 'サンプル団体', role: p.role, description: '団体の運営全体を担当' },
        { id: 'ch2', startDate: d(p.joined - 700), endDate: d(p.joined - 1), affiliation: '前職の株式会社サンプル', role: 'マーケティング担当', description: 'Web 広告の運用と分析' },
      ])
      row.qualifications_json = sampleJson([
        { id: 'q1', name: 'ITパスポート', acquiredDate: d(-400), issuer: 'IPA', relatedSkills: ['実装'], external: true },
        { id: 'q2', name: '社内デザイン検定 2級', acquiredDate: d(-100), relatedSkills: ['デザイン'] },
      ])
      row.evaluation_history_json = sampleJson([
        { id: 'e1', date: d(-180), evaluatorId: id(1), rating: 'B', comment: '着実に成果を出している' },
        { id: 'e2', date: d(-30), evaluatorId: id(2), rating: 'A', comment: '周囲を巻き込んで大型イベントを成功させた。次期はリーダーを任せたい。' },
      ])
      row.transfer_history_json = sampleJson([{ id: 't1', date: d(-200), fromAffiliation: '広報', toAffiliation: p.dept || '運営', reason: '本人の希望' }])
      row.competencies_json = sampleJson([{ name: 'リーダーシップ', level: p.rich ? 4 : 2 }, { name: '問題解決', level: 3 }])
      row.career_aspiration = p.locale === 'en' ? 'I want to lead a research team and publish our findings.' : '将来は団体の運営を任される立場になりたい'
      row.desired_future_role = p.locale === 'en' ? 'Research Lead' : '事業責任者'
      row.career_plan = p.locale === 'en' ? 'Year 1: learn the basics. Year 2: run small projects. Year 3: lead the research team.' : '1年目: 基礎を学ぶ / 2年目: 小さなプロジェクトを回す / 3年目: 班をまとめる'
      row.training_history_json = sampleJson([
        { id: 'tr1', name: 'リーダー研修', date: d(-90), provider: 'サンプル研修会社', status: 'approved', attendanceStatus: 'attended' },
        { id: 'tr2', name: 'デザイン思考ワークショップ', date: d(20), status: 'pending' },
        { id: 'tr3', name: '会計の基礎', date: d(-10), status: 'rejected' },
      ])
      row.development_plan_json = sampleJson([
        { id: 'dp1', goal: 'イベントを1人で企画・運営できるようになる', targetDate: d(90), status: 'in_progress' },
        { id: 'dp2', goal: 'デザイン検定2級に合格する', targetDate: d(-5), status: 'done' },
        { id: 'dp3', goal: '後輩のメンターを務める', targetDate: d(180), status: 'not_started' },
      ])
      row.one_on_ones_json = sampleJson([
        { id: 'o1', date: d(-35), withId: id(p.reportsTo || 2), notes: '最近の困りごと: 作業の優先順位が分からない → 週初めに一緒に整理する' },
        { id: 'o2', date: d(-7), withId: id(p.reportsTo || 2), notes: '先月の目標はおおむね達成。次はイベントの企画に挑戦したい。' },
      ])
      row.survey_responses_json = sampleJson([
        { id: 'sr1', submittedAt: sampleAt(today, -20, '20:00'), answers: { 'sample-sq-1': 4, 'sample-sq-2': 3, 'sample-sq-3': '連絡の手段が多くて迷うことがある' } },
      ])
      row.permission_overrides_json = p.n === 5 ? sampleJson([{ targetType: 'project', targetId: SAMPLE_ID_PREFIX + 'p-02', access: 'view' }]) : ''
    }
    return row
  })
}

// ---- プロジェクト ----

function buildSampleProjects(today) {
  var d = function (n) { return sampleDay(today, n) }
  var P = function (n) { return SAMPLE_ID_PREFIX + 'p-' + samplePad(n, 2) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad(n, 2) }
  return [
    { id: P(1), name: '団体運営', description: '日々の運営業務(会計・連絡・定例)', type: '運営', owner_id: M(1), member_ids: [M(1), M(2), M(16), M(19)].join(','),
      goal: '運営の仕組みを整え、1人に負担が偏らないようにする', start_date: d(-400), archived: 'FALSE' },
    { id: P(2), name: '秋のイベント 2026', description: '学外向けの大型イベント。来場者300人を目標に準備する。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(5), M(8), M(13), M(9)].join(','), goal: '来場者300人・満足度4以上', start_date: d(-45), end_date: d(40), archived: 'FALSE' },
    // 親子関係(秋のイベントの子プロジェクト)
    { id: P(3), name: '秋のイベント 2026 / 広報チーム', description: 'SNS とポスターでの告知', type: 'イベント', parent_id: P(2), owner_id: M(3),
      member_ids: [M(3), M(9), M(14)].join(','), start_date: d(-30), end_date: d(35), archived: 'FALSE' },
    { id: P(4), name: 'Webサイトのリニューアル', description: '団体の Web サイトを作り直す。期限が迫っているが、作業が遅れている。', type: '開発', owner_id: M(4),
      member_ids: [M(4), M(11), M(15), M(17)].join(','), goal: '来月末に公開する', start_date: d(-90), end_date: d(-3), archived: 'FALSE',
      health_override: '' },
    { id: P(5), name: '新歓 2027', description: '来月から始まる新入生の勧誘の準備', type: 'イベント', owner_id: M(2), member_ids: [M(2), M(12), M(20)].join(','),
      start_date: d(35), end_date: d(120), archived: 'FALSE' },
    { id: P(6), name: 'Community Research', description: 'Interview members of partner organizations and summarize what they need from us. The report will be shared at the general meeting.',
      type: 'Research', owner_id: M(6), member_ids: [M(6), M(12), M(20)].join(','), goal: 'Publish the research report by the end of next month',
      start_date: d(-20), end_date: d(45), archived: 'FALSE', health_override: 'watch' },
    { id: P(7), name: '春のイベント 2026(終了)', description: '終了したイベント。記録のために残している。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(8), M(13)].join(','), start_date: d(-200), end_date: d(-120), archived: 'TRUE' },
    { id: P(8), name: 'とても長い名前のプロジェクト:地域の子ども向けプログラミング教室と保護者向け説明会の合同開催(2026年度・第3期)',
      description: 'プロジェクト名や説明が長い場合の表示を確かめるためのプロジェクト。' + new Array(15).join('説明の文章がとても長く続く場合でも、画面が崩れないことを確かめます。'),
      type: '教育', owner_id: M(9), member_ids: [M(9), M(11), M(17)].join(','), start_date: d(-10), end_date: d(80), archived: 'FALSE' },
  ]
}

// ---- タスク ----

// 変更の記録(今の形式: ステータスは日本語の表示名)
function sampleHistory(today, byId, entries) {
  return entries.map(function (e, i) {
    return { id: 'h' + (i + 1), at: sampleAt(today, e[0], '11:00'), byId: byId, field: e[1], from: e[2], to: e[3] }
  })
}

function buildSampleTasks(today) {
  var d = function (n) { return sampleDay(today, n) }
  var at = function (n, t) { return sampleAt(today, n, t) }
  var P = function (n) { return SAMPLE_ID_PREFIX + 'p-' + samplePad(n, 2) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad(n, 2) }
  var tasks = []
  var seq = 0
  var add = function (t) {
    seq++
    var row = {
      id: SAMPLE_ID_PREFIX + 't-' + samplePad(seq, 3),
      project_id: P(1), title: '', description: '', status: '未着手', assign_type: 'open_bid', assignee_id: '',
      creator_id: M(1), created_at: d(-10), start_date: '', due_date: '', due_time: '', visibility: '全員', department: '運営',
      category: '企画', skills: '', difficulty: '新人歓迎', priority: '中', last_activity: d(-1), original_input_id: '',
      approval_status: '承認済み', estimated_hours: '', importance: '一般',
    }
    Object.keys(t).forEach(function (k) { row[k] = t[k] })
    tasks.push(row)
    return row.id
  }

  // -- 期限・状態の典型例(実行した日を基準にする) --
  add({ title: '会計報告書の提出', project_id: P(1), status: '進行中', assignee_id: M(16), due_date: d(-5), priority: '高', skills: '企画',
    description: '期限を過ぎているタスク。', history_json: sampleJson(sampleHistory(today, M(1), [[-12, 'status', '未着手', '進行中']])) })
  add({ title: 'ポスターのデザイン案を3つ作る', project_id: P(3), department: 'デザイン', category: 'デザイン', status: '進行中', assignee_id: M(5), start_date: d(-4),
    due_date: d(2), priority: '高', skills: 'デザイン,Canva', difficulty: '少し経験必要', progress_percent: '60', progress_note: '2案できた。3案目を作成中。',
    progress_history_json: sampleJson([{ id: 'pg1', text: '1案目を共有しました', at: at(-3), byId: M(5) }, { id: 'pg2', text: '2案目を共有しました', at: at(-1), byId: M(5) }]) })
  add({ title: '当日の受付マニュアルを作る', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', assignee_id: M(13), due_date: d(0),
    due_time: '18:00', skills: 'イベント運営,ライティング', description: '今日が締切(時刻つき)。' })
  add({ title: '新歓チラシの原稿', project_id: P(5), department: '広報', category: 'ライティング', status: '未着手', assignee_id: M(14), start_date: d(35),
    due_date: d(50), skills: 'ライティング,広報', description: '来月から始まるタスク。' })
  var doneRecent = add({ title: '会場の予約', project_id: P(2), department: 'イベント', category: 'イベント', status: '完了', assignee_id: M(3), due_date: d(-6),
    completed_date: d(-3), skills: 'イベント運営,メール', estimated_hours: '3', actual_hours: '4.5', awarded_points_json: sampleJson({ 'イベント運営': 30 }),
    retrospective_json: sampleJson({ good: '早めに候補を3つ押さえられた', bad: '見積もりの比較に時間がかかった', improve: '次回は比較表のひな形を使う' }),
    deliverables_json: sampleJson([{ id: 'dl1', label: '予約確認メール', url: 'https://example.com/booking' }, { id: 'dl2', label: '会場の図面', url: 'https://example.com/floor' }]) })
  add({ title: '春のイベントのアンケート集計', project_id: P(7), department: 'リサーチ', category: 'リサーチ', status: '完了', assignee_id: M(12), due_date: d(-130),
    completed_date: d(-125), skills: 'リサーチ,データ分析', description: '完了から日が経ち、アーカイブに入るタスク。', awarded_points_json: sampleJson({ 'リサーチ': 40 }),
    retrospective_json: sampleJson({ good: '回収率が高かった', bad: '自由記述の集計に手間取った', improve: '選択式の設問を増やす' }) })
  add({ title: '過去の議事録の整理', project_id: P(1), status: '完了', assignee_id: M(19), due_date: d(-25), completed_date: d(-20), skills: '企画', description: '完了から14日を過ぎたタスク(アーカイブ)。' })

  // -- 公募 --
  add({ title: '当日のカメラマン(公募)', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', due_date: d(30), skills: 'デザイン',
    difficulty: '誰でも可', open_bid_applicant_ids: [M(5), M(15)].join(','), description: '応募者が2人いる公募のタスク。' })
  add({ title: 'SNS 投稿の文章チェック(公募)', project_id: P(3), department: '広報', category: '広報', status: '未着手', due_date: d(12), skills: '校閲,SNS', difficulty: '新人歓迎' })

  // -- 承認待ち(一般のメンバーが登録したもの。重要度ごと) --
  add({ title: '備品の購入(承認待ち)', project_id: P(2), creator_id: M(5), approval_status: '承認待ち', assignee_id: M(5), due_date: d(9), category: '物品調達' })
  add({ title: 'スポンサーへの依頼文(重要・承認待ち)', project_id: P(2), creator_id: M(13), approval_status: '承認待ち', importance: '重要', department: '渉外',
    category: '渉外', due_date: d(7), skills: 'ライティング,コミュニケーション' })
  add({ title: 'プレスリリースの公開(対外公開・承認待ち)', project_id: P(3), creator_id: M(14), approval_status: '承認待ち', importance: '対外公開', department: '広報',
    category: '広報', due_date: d(14), skills: '広報,ライティング' })

  // -- 幹部限定 --
  add({ title: '来年度の予算案(幹部限定)', project_id: P(1), visibility: '幹部', status: '進行中', assignee_id: [M(1), M(2)].join(','), due_date: d(20), priority: '高',
    description: '幹部だけが見られるタスク。一般のメンバーには表示されない。' })

  // -- 確認(複数の確認者・確認タスク) --
  var reviewed = add({ title: 'Web サイトのトップページ', project_id: P(4), department: '開発', category: '開発', status: '確認待ち', assignee_id: M(15), due_date: d(1),
    skills: 'UI/UX,実装', reviewer_ids: [M(2), M(4)].join(','), reviewer_id: M(2), required_approvals: 'all',
    review_approvals_json: sampleJson([{ memberId: M(4), at: at(-1), comment: 'レイアウトは問題なし。画像の差し替えだけお願いします。' }]),
    history_json: sampleJson(sampleHistory(today, M(15), [[-8, 'status', '未着手', '進行中'], [-1, 'status', '進行中', '確認待ち']])) })
  add({ title: '「Web サイトのトップページ」の確認', project_id: P(4), department: '開発', category: '開発', status: '未着手', assignee_id: M(2), due_date: d(2),
    related_review_task_id: reviewed, creator_id: M(15) })
  add({ title: 'お知らせページの文章', project_id: P(4), department: '広報', category: 'ライティング', status: '修正中', assignee_id: M(18), due_date: d(4), reviewer_id: M(4),
    reviewer_ids: M(4), required_approvals: '1', skills: 'ライティング,校閲',
    history_json: sampleJson(sampleHistory(today, M(4), [[-6, 'status', '進行中', '確認待ち'], [-2, 'status', '確認待ち', '修正中']])) })

  // -- 依存関係 --
  var dep1 = add({ title: 'サイトの構成を決める', project_id: P(4), department: '開発', category: '開発', status: '完了', assignee_id: M(11), due_date: d(-20), completed_date: d(-18),
    skills: '要件定義,プロダクト設計', awarded_points_json: sampleJson({ '要件定義': 25 }) })
  var dep2 = add({ title: 'デザインのカンプ', project_id: P(4), department: 'デザイン', category: 'デザイン', status: '進行中', assignee_id: M(15), due_date: d(-2),
    skills: 'デザイン,UI/UX', depends_on_ids: dep1, blocker_note: '素材の写真がまだ届いていない', blocker_since: d(-4), priority: '高' })
  add({ title: 'サイトの実装', project_id: P(4), department: '開発', category: '開発', status: '未着手', assignee_id: [M(11), M(17)].join(','), due_date: d(10),
    skills: '実装,V0', depends_on_ids: [dep1, dep2].join(','), difficulty: '経験者向け', required_skill_levels_json: sampleJson({ '実装': 4, 'UI/UX': 3 }) })

  // -- サポート必要・保留 --
  add({ title: '協賛企業のリストアップ', project_id: P(2), department: '渉外', category: '渉外', status: 'サポート必要', assignee_id: M(10), due_date: d(6),
    blocker_note: '何から手を付ければよいか分からない', blocker_since: d(-2), difficulty: '新人歓迎' })
  add({ title: 'ノベルティの発注', project_id: P(2), department: 'イベント', category: '物品調達', status: '保留', assignee_id: M(8), due_date: d(25),
    hold_reason_note: '予算が確定するまで保留', hold_reason_since: d(-7) })

  // -- 日程調整・フォーム --
  add({ title: '打ち上げの日程調整', project_id: P(2), department: 'イベント', category: 'イベント', status: '進行中', assignee_id: M(3), due_date: d(5),
    schedule_json: sampleJson({
      candidates: [
        { id: 'c1', label: d(12) + ' 18:00-20:00', date: d(12), startTime: '18:00', endTime: '20:00' },
        { id: 'c2', label: d(13) + ' 19:00-21:00', date: d(13), startTime: '19:00', endTime: '21:00' },
        { id: 'c3', label: '週末のどこか(自由記述の候補)' },
      ],
      invitedIds: [M(3), M(5), M(13), M(9)],
      responses: { 'sample-m-03': { c1: '○', c2: '△', c3: '×' }, 'sample-m-05': { c1: '○', c2: '○', c3: '△' } },
    }) })
  add({ title: 'Tシャツのサイズ調査', project_id: P(2), department: 'イベント', category: 'イベント', status: '進行中', assignee_id: M(13), due_date: d(8),
    form_json: sampleJson({
      fields: [
        { id: 'f1', label: 'サイズ', type: 'select', options: ['S', 'M', 'L', 'XL'], required: true },
        { id: 'f2', label: '色の希望', type: 'checkbox', options: ['白', '黒', '紺'] },
        { id: 'f3', label: '備考', type: 'textarea' },
      ],
      invitedIds: [M(5), M(9), M(13), M(14)],
      responses: { 'sample-m-05': { f1: 'M', f2: ['白', '紺'], f3: '' }, 'sample-m-14': { f1: 'L', f2: ['黒'], f3: '当日は遅れて参加します' } },
    }) })

  // -- 表示の崩れの確認(極端な例) --
  add({ title: 'とても長いタスク名の例:来場者アンケートの設問の見直しと、回答しやすい順番への並べ替え、および前回の自由記述の回答をもとにした選択肢の追加(第2版)',
    project_id: P(8), department: 'リサーチ', category: 'リサーチ', status: '進行中', assignee_id: M(9), due_date: d(15), skills: 'リサーチ,企画,ライティング,データ分析',
    description: new Array(40).join('説明がとても長い場合の表示を確かめるための文章です。改行が無く続く場合と、\n改行を含む場合の両方を確かめます。') })
  var comments = []
  for (var c = 0; c < 150; c++) {
    var by = M(1 + (c % 9))
    var mention = c % 10 === 0 ? ' @渡辺 大輔 確認をお願いします' : ''
    comments.push({ id: 'cm' + c, byId: by, at: at(-20 + Math.floor(c / 8), (9 + (c % 10)) + ':' + samplePad((c * 7) % 60, 2)),
      text: 'コメント ' + (c + 1) + ' 件目。進み具合の共有です。' + mention, mentionedIds: mention ? [M(3)] : undefined })
  }
  add({ title: 'コメントがとても多いタスク(150件)', project_id: P(2), status: '進行中', assignee_id: M(3), due_date: d(18), comments_json: sampleJson(comments) })
  add({ title: '担当者が多いタスク(12人)', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', due_date: d(30),
    assignee_id: [2, 3, 5, 9, 11, 12, 13, 14, 15, 16, 17, 18].map(M).join(','), skills: 'イベント運営' })

  // -- 英語表示の人が担当するタスク(英語の文章) --
  add({ title: 'Interview five partner organizations', project_id: P(6), department: 'リサーチ', category: 'リサーチ', status: '進行中', assignee_id: M(6), due_date: d(9),
    skills: 'リサーチ,コミュニケーション', description: 'Schedule 30-minute interviews, record the key points, and share a short summary in the comments after each interview.',
    comments_json: sampleJson([{ id: 'en1', byId: M(12), at: at(-2), text: 'I can join the interview on Thursday if you need a note-taker.' },
      { id: 'en2', byId: M(6), at: at(-1), text: 'Thanks! That would be really helpful.' }]) })
  add({ title: 'Draft the research report (very long English title to check how the layout wraps across several lines)', project_id: P(6), department: 'リサーチ',
    category: 'ライティング', status: '未着手', assignee_id: M(6), start_date: d(10), due_date: d(40), skills: 'ライティング,リサーチ', difficulty: '経験者向け',
    description: 'Summarize the interviews into a report with three sections: background, findings, and recommendations. Keep it under ten pages.' })
  add({ title: 'Translate the survey into Japanese', project_id: P(6), department: 'リサーチ', category: 'ライティング', status: '完了', assignee_id: M(6), due_date: d(-8),
    completed_date: d(-6), skills: 'ライティング', awarded_points_json: sampleJson({ 'ライティング': 20 }),
    retrospective_json: sampleJson({ good: 'Finished two days early', bad: 'Some terms were hard to translate', improve: 'Keep a glossary for next time' }) })

  // -- 定期タスクから作られたように見えるタスク(定期タスクのルールは停止中) --
  for (var w = 3; w >= 0; w--) {
    add({ title: '週次定例の議事録', project_id: P(1), category: '企画', skills: 'ライティング', creator_id: '', assignee_id: M(19),
      created_at: d(-7 * w), due_date: d(-7 * w + 2), status: w === 0 ? '未着手' : '完了', completed_date: w === 0 ? '' : d(-7 * w + 1), difficulty: '誰でも可' })
  }

  // -- 普通のタスク(推薦・集計・一覧の件数のため。スキルは担当者の Will・Judgment と合わせる) --
  var rng = makePerfRandom(20261001)
  // テスト用のアカウントの枠のメンバー(1・2・3・5)にも、自分のタスクの画面で確かめられるよう割り当てる
  var regularMembers = [5, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 1, 2, 3, 5]
  var skillOf = { 1: '企画,リサーチ', 2: 'デザイン,UI/UX', 3: 'イベント運営,メール', 5: 'デザイン,Canva', 9: '広報,SNS', 11: '実装,要件定義', 12: 'リサーチ,データ分析', 13: 'イベント運営,メール', 14: 'SNS,広報',
    15: 'UI/UX,デザイン', 16: '企画,コミュニケーション', 17: '実装,V0', 18: 'ライティング,校閲', 19: 'PowerPoint,企画', 20: 'リサーチ,データ分析' }
  var deptOf = { 'デザイン': 'デザイン', '広報': '広報', 'SNS': '広報', '実装': '開発', 'UI/UX': 'デザイン', 'リサーチ': 'リサーチ', 'イベント運営': 'イベント',
    '企画': '運営', 'ライティング': '広報', 'PowerPoint': '運営', '校閲': '広報' }
  var verbs = ['資料の作成', '進め方の相談', '候補の洗い出し', '見積もりの確認', '下書きの作成', '関係者への連絡', '結果のまとめ', 'チェックリストの更新']
  var statuses = ['未着手', '未着手', '進行中', '進行中', '進行中', '確認待ち', '完了', '完了', '完了', '保留']
  var activeProjects = [1, 2, 3, 4, 5, 8]
  for (var i = 0; i < 115; i++) {
    var mNo = regularMembers[i % regularMembers.length]
    var skills = skillOf[mNo]
    var status = rng.pick(statuses)
    var project = activeProjects[i % activeProjects.length]
    var done = status === '完了'
    // 終わっていないタスクの期限は、多くを先の日付にする(期限切れは1割ほど)
    var due = done ? rng.int(-60, -2) : rng.chance(0.12) ? rng.int(-15, -1) : rng.int(1, 45)
    var startOffset = due - rng.int(3, 25)
    var completed = done ? Math.min(-1, due - rng.int(0, 5)) : null
    add({
      title: skills.split(',')[0] + 'の' + verbs[i % verbs.length] + '(' + (i + 1) + ')',
      project_id: P(project), department: deptOf[skills.split(',')[0]] || '運営', category: rng.pick(['企画', 'デザイン', '広報', 'リサーチ', 'イベント', '開発']),
      status: status, assignee_id: rng.chance(0.15) ? '' : M(mNo), creator_id: M(rng.pick([1, 2, 3, 4])), created_at: d(startOffset - 3),
      start_date: d(startOffset), due_date: d(due), completed_date: done ? d(completed) : '', skills: skills,
      difficulty: rng.pick(['誰でも可', '新人歓迎', '少し経験必要', '経験者向け', '上級者向け']), priority: rng.pick(['高', '中', '中', '低']),
      estimated_hours: String(rng.int(1, 8)), actual_hours: done ? String(rng.int(1, 10)) : '',
      awarded_points_json: done ? sampleJson(JSON.parse('{"' + skills.split(',')[0] + '":' + (10 + rng.int(0, 30)) + '}')) : '',
      progress_percent: done ? '100' : String(rng.int(0, 90)),
      hold_reason_note: status === '保留' ? '他のタスクの結果待ち' : '', hold_reason_since: status === '保留' ? d(-rng.int(1, 10)) : '',
      last_activity: d(done ? completed : -rng.int(0, 20)),
      history_json: rng.chance(0.4) ? sampleJson(sampleHistory(today, M(mNo), [[startOffset, 'status', '未着手', '進行中']])) : '',
    })
  }
  return tasks
}

// ---- 経費・フォーム・日報・採用 ----

function buildSampleOtherSheets(today, files) {
  var d = function (n) { return sampleDay(today, n) }
  var at = function (n, t) { return sampleAt(today, n, t) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad(n, 2) }
  var S = SAMPLE_ID_PREFIX
  var steps = [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }]
  var expense = function (n, o) {
    return {
      id: S + 'exp-' + samplePad(n, 2), applicant_id: o.by, amount: String(o.amount), category_id: o.cat || S + 'expcat-transport',
      receipt_url: o.receipt || '', justification: o.justification || '', purpose: o.purpose, custom_field_answers_json: sampleJson(o.custom || {}),
      approval_steps_json: sampleJson(steps), approvals_json: sampleJson(o.approvals || []), current_step_index: String(o.step || 0),
      status: o.status, created_at: at(o.day, '12:00'), rejection_reason: o.reason || '',
    }
  }
  var approved = function (stepId, by, day) { return { stepId: stepId, memberId: by, at: at(day, '15:00'), action: 'approved' } }
  var Expenses = [
    expense(1, { by: M(5), amount: 1280, purpose: 'ポスター印刷用の紙', status: 'pending', day: -1, receipt: files.receipt_png, custom: { destination: '文具店' } }),
    expense(2, { by: M(6), amount: 3400, purpose: 'Transportation to the partner interview', status: 'pending', step: 1, day: -4, receipt: files.receipt_pdf,
      approvals: [approved('s1', M(3), -3)], custom: { destination: 'Shibuya' } }),
    expense(3, { by: M(13), amount: 15800, purpose: '会場の下見の交通費', status: 'approved', step: 2, day: -20, receipt: files.receipt_png,
      approvals: [approved('s1', M(3), -19), approved('s2', M(1), -18)] }),
    expense(4, { by: M(9), amount: 52000, cat: S + 'expcat-goods', purpose: 'カメラの購入', justification: 'イベントの撮影に使うため', status: 'rejected', day: -15,
      approvals: [{ stepId: 's1', memberId: M(3), at: at(-14, '10:00'), action: 'rejected', comment: 'レンタルで足りるため' }], reason: 'レンタルで足りるため' }),
    expense(5, { by: M(14), amount: 2200, purpose: '打ち合わせの飲み物代', status: 'returned', day: -6, reason: '領収書の画像を添付してください' }),
    expense(6, { by: M(5), amount: 800, purpose: '(取り下げ)重複して申請したもの', status: 'withdrawn', day: -9 }),
    expense(7, { by: M(9), amount: 1234567, cat: S + 'expcat-goods', status: 'pending', day: -2, receipt: files.receipt_png,
      purpose: '金額と説明がとても長い場合の表示の確認:' + new Array(8).join('音響機材・照明機材・ステージの設営一式のレンタルと運搬費用。'), justification: new Array(6).join('大型イベントのため、例年より規模が大きい。') }),
  ]
  var formSteps = [{ id: 'fs1', type: 'role', role: SAMPLE_ROLES.admin }]
  var submission = function (n, o) {
    return {
      id: S + 'fsub-' + samplePad(n, 2), form_id: S + 'form-equipment', submitter_id: o.by, answers_json: sampleJson(o.answers),
      approvals_json: sampleJson(o.approvals || []), current_step_index: String(o.step || 0), status: o.status, created_at: at(o.day, '13:00'),
      rejection_reason: o.reason || '',
    }
  }
  var FormSubmissions = [
    submission(1, { by: M(5), answers: { item: 'プロジェクター', from: d(10), qty: 1 }, status: 'pending', day: -1 }),
    submission(2, { by: M(13), answers: { item: '延長コード', from: d(-5), qty: 3 }, status: 'approved', step: 1, day: -8,
      approvals: [{ stepId: 'fs1', memberId: M(2), at: at(-7, '10:00'), action: 'approved' }] }),
    submission(3, { by: M(6), answers: { item: 'Camera tripod', from: d(3), qty: 2 }, status: 'rejected', day: -3,
      approvals: [{ stepId: 'fs1', memberId: M(2), at: at(-2, '10:00'), action: 'rejected', comment: '同じ日に別の予約があるため' }], reason: '同じ日に別の予約があるため' }),
  ]
  var DailyReports = []
  var reporters = [[5, 'ja'], [6, 'en'], [11, 'ja'], [13, 'ja']]
  reporters.forEach(function (r) {
    for (var day = -9; day <= 0; day++) {
      if ((day + r[0]) % 3 === 0) continue
      var en = r[1] === 'en'
      DailyReports.push({
        id: S + 'dr-' + samplePad(r[0], 2) + '-' + samplePad(-day, 2), member_id: M(r[0]), type: 'daily', report_date: d(day),
        done_text: en ? 'Finished the interview notes for two organizations.' : '担当のタスクを進めました。資料を半分まで作成。',
        todo_text: en ? 'Start drafting the summary.' : '明日は資料の残りを仕上げる。',
        issues_text: day % 4 === 0 ? (en ? 'Waiting for a reply from one partner.' : '先方からの返事待ちで止まっている作業がある。') : '',
        created_at: at(day, '21:00'),
      })
    }
    DailyReports.push({ id: S + 'dr-' + samplePad(r[0], 2) + '-w', member_id: M(r[0]), type: 'weekly', report_date: d(-7),
      done_text: r[1] === 'en' ? 'Completed three interviews this week.' : '今週はタスクを3件完了しました。', todo_text: r[1] === 'en' ? 'Two more interviews next week.' : '来週はイベントの準備に集中する。',
      issues_text: '', created_at: at(-7, '20:00') })
  })
  var Candidates = [
    { id: S + 'c-01', name: '候補 一郎', email: '', phone: '', resume_text: '大学2年。イベント運営に興味がある。', interview_notes: '明るく話しやすい。', status: 'candidate', created_at: at(-5), updated_at: at(-2) },
    { id: S + 'c-02', name: '候補 花子', resume_text: 'デザインの経験あり(ポートフォリオあり)。', interview_notes: '次回は実技の課題を出す。', status: 'candidate', created_at: at(-12), updated_at: at(-4) },
    { id: S + 'c-03', name: '候補 次郎', resume_text: '', interview_notes: '日程が合わず辞退。', status: 'rejected', created_at: at(-40), updated_at: at(-30) },
    { id: S + 'c-04', name: '候補 三郎', resume_text: '大学1年。', interview_notes: '入会が決まった。', status: 'hired', created_at: at(-60), updated_at: at(-50) },
    { id: S + 'c-05', name: 'とても長い名前の候補者 ジョナサン・アレクサンダー・ウィリアムズ 三世', resume_text: new Array(20).join('自己紹介の文章がとても長い場合。'),
      interview_notes: new Array(10).join('面接のメモがとても長い場合。'), status: 'candidate', created_at: at(-3), updated_at: at(-1) },
  ]
  return { Expenses: Expenses, FormSubmissions: FormSubmissions, DailyReports: DailyReports, Candidates: Candidates }
}

// ---- Settings に足すもの ----
//   lists  カンマ区切りの一覧に足す値(既にある値は足さない)
//   items  id を持つ配列に足す要素(id は 'sample-' で始める)
//   values 文字列の配列に足す値
//   maps   キーで引く設定に足すキー(既にあるキーは変えない)
//   scalars 値が1つの設定(元の値を退避してから書き、削除の時に戻す)
function buildSampleSettings(today, files) {
  var d = function (n) { return sampleDay(today, n) }
  var S = SAMPLE_ID_PREFIX
  var M = function (n) { return S + 'm-' + samplePad(n, 2) }
  var tpl = function (id, name, dept, cat, skills, diff, prio, dependsOn) {
    return { id: id, name: name, department: dept, category: cat, skills: skills, difficulty: diff, priority: prio, dependsOn: dependsOn || [] }
  }
  return {
    lists: {
      skill_options: ['データ分析'],
      category_options: ['定例'],
      skill_field_options: ['分析'],
      role_levels: [SAMPLE_ROLES.admin, SAMPLE_ROLES.restricted],
      restricted_roles: [SAMPLE_ROLES.restricted],
    },
    items: {
      task_set_templates: [{ id: S + 'tst-event', name: 'イベント開催(サンプル)', description: 'イベントを開く時の定番のタスク一式',
        items: [tpl('a', '会場の予約', 'イベント', 'イベント', ['イベント運営'], '新人歓迎', '高'), tpl('b', '告知ポスター', 'デザイン', 'デザイン', ['デザイン', 'Canva'], '少し経験必要', '中', ['a']),
          tpl('c', '当日の運営マニュアル', 'イベント', 'イベント', ['ライティング'], '新人歓迎', '中', ['a'])] }],
      recurring_rules: [
        { id: S + 'rr-weekly', name: '週次定例の議事録', projectId: S + 'p-01', department: '運営', category: '企画', skills: ['ライティング'], difficulty: '誰でも可',
          priority: '中', frequency: 'weekly', dayOfWeek: 1, dueInDays: 2, active: false, lastGeneratedDate: d(0), skipDates: [d(14)] },
        { id: S + 'rr-monthly', name: '月次の会計チェック', projectId: S + 'p-01', department: '運営', category: '企画', skills: ['企画'], difficulty: '少し経験必要',
          priority: '高', frequency: 'monthly', dayOfMonth: 25, dueInDays: 5, active: false },
      ],
      quiz_definitions: [{ id: S + 'quiz-design', title: 'デザインの基礎(サンプル)', targetSkill: 'デザイン', targetLevel: 3, passRate: 70, questions: [
        { id: 'q1', text: '余白を広く取る主な目的は?', choices: ['読みやすくするため', '印刷代を節約するため', '文字を小さくするため'], correctIndex: 0 },
        { id: 'q2', text: '1つのポスターで使う書体の数は?', choices: ['できるだけ多く', '2〜3種類まで', '10種類以上'], correctIndex: 1 },
      ] }],
      learning_contents: [
        { id: S + 'lc-1', title: 'Canva の使い方(動画)', url: 'https://www.example.com/canva', contentType: 'video', relatedSkill: 'Canva', relatedQuizId: S + 'quiz-design', createdAt: d(-30) },
        { id: S + 'lc-2', title: 'イベント運営マニュアル', description: '会場の予約から撤収までの手順', url: 'https://www.example.com/manual', contentType: 'manual', relatedSkill: 'イベント運営', createdAt: d(-20) },
        { id: S + 'lc-3', title: 'How to run a user interview', url: 'https://www.example.com/interview', contentType: 'link', relatedSkill: 'リサーチ', createdAt: d(-10) },
      ],
      learning_courses: [{ id: S + 'course-new', title: '新入生向けコース(サンプル)', description: '入ったばかりの人が最初に見る資料', contentIds: [S + 'lc-2', S + 'lc-1'], relatedQuizId: S + 'quiz-design' }],
      training_programs: [
        { id: S + 'tp-leader', name: 'リーダー研修', description: '班をまとめる人向け', targetSegments: ['管理職候補'] },
        { id: S + 'tp-basic', name: '新人研修', targetSegments: ['新人'] },
      ],
      survey_questions: [
        { id: S + 'sq-1', text: '今の活動に満足していますか?', type: 'scale', scaleMinLabel: '不満', scaleMaxLabel: '満足', imageUrl: files.survey_image || undefined },
        { id: S + 'sq-2', text: '自分の成長を感じますか?', type: 'scale', scaleMinLabel: '感じない', scaleMaxLabel: '感じる' },
        { id: S + 'sq-3', text: '困っていることがあれば教えてください', type: 'text' },
      ],
      custom_form_defs: [{ id: S + 'form-equipment', title: '備品の貸し出し申請(サンプル)', description: '団体の備品を借りる時に使います',
        fields: [{ id: 'item', label: '借りるもの', type: 'text', required: true }, { id: 'from', label: '借りる日', type: 'date', required: true },
          { id: 'qty', label: '数', type: 'number', required: true }], approvalSteps: [{ id: 'fs1', type: 'role', role: SAMPLE_ROLES.admin }] }],
      expense_categories: [
        { id: S + 'expcat-transport', label: '交通費(サンプル)', approvalSteps: [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }],
          customFields: [{ key: 'destination', label: '行き先', type: 'text' }] },
        { id: S + 'expcat-goods', label: '物品購入(サンプル)', approvalSteps: [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }] },
      ],
      custom_member_columns_json: [{ key: 'sample_slack', label: 'Slack の名前(サンプル)', type: 'text' }, { key: 'sample_shirt', label: 'Tシャツのサイズ(サンプル)', type: 'text' }],
    },
    // id を持たない配列: 足した値だけを消す
    values: {
      one_on_one_questions: ['(サンプル)最近うれしかったことは?', '(サンプル)手伝ってほしいことは?'],
      radar_axes: [{ skill: 'データ分析', label: 'データ分析(サンプル)' }],
      department_tree_config: [{ path: 'サンプル本部' }, { path: 'サンプル本部>イベント' }, { path: 'サンプル本部>広報>SNS チーム' }],
    },
    maps: {
      project_templates: { 'サンプル: イベント': [tpl('a', '会場の予約', 'イベント', 'イベント', ['イベント運営'], '新人歓迎', '高'), tpl('b', '振り返り会', 'イベント', 'イベント', ['企画'], '誰でも可', '低', ['a'])] },
      role_permissions: (function () { var o = {}; o[SAMPLE_ROLES.restricted] = ['dashboard', 'assignments', 'approvals', 'projects', 'dailyReports']; return o })(),
      job_requirements: (function () { var o = {}; o[SAMPLE_ROLES.restricted] = ['イベント運営', 'コミュニケーション']; return o })(),
      skill_field_skills: { '分析': ['データ分析', 'リサーチ'] },
      skill_level_thresholds: { 'データ分析': 150 },
    },
    scalars: {
      org_name: 'サンプル団体',
      org_logo_url: files.org_logo || '',
      theme_color: '#6366f1',
    },
  }
}

// アップロード用フォルダに作るダミー画像(ファイル名の先頭は、画面が種類を見分けるのに使う)
function sampleFileSpecs() {
  return [
    { key: 'avatar1', name: 'avatar_sample-m-01_', png: 'avatar1', url: 'image' },
    { key: 'avatar2', name: 'avatar_sample-m-02_', png: 'avatar2', url: 'image' },
    { key: 'avatar3', name: 'avatar_sample-m-03_', png: 'avatar3', url: 'image' },
    { key: 'avatar4', name: 'avatar_sample-m-05_', png: 'avatar4', url: 'image' },
    { key: 'org_logo', name: 'org_logo_sample_', png: 'logo', url: 'image' },
    { key: 'survey_image', name: 'survey_image_sample_', png: 'survey', url: 'image512' },
    { key: 'receipt_png', name: 'expense_receipt_sample_png_', png: 'receipt', url: 'file' },
    { key: 'receipt_pdf', name: 'expense_receipt_sample_pdf_', pdf: true, url: 'file' },
  ]
}

// サンプルのデータ一式を作る(Google のサービスを使わない純粋な関数)。
// today は 'YYYY-MM-DD'(スクリプトのタイムゾーンの今日)、files はダミー画像の URL
function buildSampleData(today, files) {
  files = files || {}
  var other = buildSampleOtherSheets(today, files)
  return {
    sheets: {
      Members: buildSampleMembers(today, files),
      Projects: buildSampleProjects(today),
      Tasks: buildSampleTasks(today),
      Expenses: other.Expenses,
      FormSubmissions: other.FormSubmissions,
      DailyReports: other.DailyReports,
      Candidates: other.Candidates,
    },
    settings: buildSampleSettings(today, files),
  }
}

// ---- テスト用のアカウント(TEST_ACCOUNTS) ----

// 'top=a@gmail.com, admin=b@gmail.com' を { top: 'a@gmail.com', ... } にする。
// 知らない枠の名前・メールアドレスの形でないもの・同じアドレスの重複はエラー
function parseSampleTestAccounts(raw) {
  var out = {}
  var seen = {}
  String(raw || '').split(/[,\n]/).map(function (s) { return s.trim() }).filter(Boolean).forEach(function (pair) {
    var i = pair.indexOf('=')
    var slot = (i < 0 ? pair : pair.slice(0, i)).trim()
    var email = (i < 0 ? '' : pair.slice(i + 1)).trim().toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(SAMPLE_ACCOUNT_SLOTS, slot)) {
      throw userError('TEST_ACCOUNTS に知らない枠の名前があります: ' + slot + '(使える枠: ' + Object.keys(SAMPLE_ACCOUNT_SLOTS).join(', ') + ')')
    }
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) throw userError('TEST_ACCOUNTS の ' + slot + ' のメールアドレスが正しくありません: ' + email)
    if (out[slot]) throw userError('TEST_ACCOUNTS で同じ枠が2回指定されています: ' + slot)
    if (seen[email]) throw userError('TEST_ACCOUNTS で同じメールアドレスが2つの枠に指定されています: ' + email)
    seen[email] = true
    out[slot] = email
  })
  return out
}

// サンプル以外のメンバーに登録されているアドレスが無いか確かめる(rows は MemberEmails の [id, email])
function assertSampleAccountsUnregistered(accounts, rows) {
  var wanted = {}
  Object.keys(accounts).forEach(function (slot) { wanted[accounts[slot]] = slot })
  rows.forEach(function (r) {
    var id = String(r[0] || '')
    if (id.indexOf(SAMPLE_ID_PREFIX) === 0) return
    String(r[1] || '').split(',').map(function (e) { return e.trim().toLowerCase() }).forEach(function (e) {
      if (wanted[e]) {
        throw userError('TEST_ACCOUNTS の ' + wanted[e] + ' のアドレス(' + e + ')は、サンプル以外のメンバー(id: ' + id +
          ')に登録されています。そのままではそのメンバーとしてログインしてしまうため、別のアカウントを指定してください。')
      }
    })
  })
}

// ---- Settings の追加と、元に戻す処理(Google のサービスを使わない純粋な関数) ----

function sampleParseJson(raw, fallback) {
  if (!raw) return fallback
  try { var v = JSON.parse(raw); return v == null ? fallback : v } catch (e) { return fallback }
}

// current: { キー: 今の値(文字列) } → { values: { キー: 書き込む値 }, state: 元に戻すための記録 }
// 役職の設定(roles)を使う団体向けに、サンプルの役職(サンプル班長)を今までの設定
// (role_levels など)ではなく roles の1件として足す形に変える
function sampleSettingsWithRoles(settings) {
  var out = JSON.parse(JSON.stringify(settings))
  var name = SAMPLE_ROLES.restricted
  var role = { id: SAMPLE_ID_PREFIX + 'role-restricted', name: name, tier: 'admin', restricted: true }
  if (out.maps.role_permissions && out.maps.role_permissions[name]) role.sections = out.maps.role_permissions[name]
  if (out.maps.job_requirements && out.maps.job_requirements[name]) role.requiredSkills = out.maps.job_requirements[name]
  delete out.lists.role_levels
  delete out.lists.restricted_roles
  delete out.maps.role_permissions
  delete out.maps.job_requirements
  out.items.roles = [role]
  return out
}

function mergeSampleSettings(current, additions) {
  var values = {}
  var state = { lists: {}, items: {}, values: {}, maps: {}, scalars: {} }
  Object.keys(additions.lists).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = splitCsvList(raw)
    var wasEmpty = base.length === 0
    if (wasEmpty && SAMPLE_LIST_DEFAULTS[key]) base = SAMPLE_LIST_DEFAULTS[key].slice()
    var added = additions.lists[key].filter(function (v) { return base.indexOf(v) === -1 })
    if (added.length === 0) return
    values[key] = base.concat(added).join(',')
    state.lists[key] = { wasEmpty: wasEmpty, added: added }
  })
  Object.keys(additions.items).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson(raw, []).filter(function (x) { return !(x && String(x.id || '').indexOf(SAMPLE_ID_PREFIX) === 0) })
    values[key] = JSON.stringify(base.concat(additions.items[key]))
    state.items[key] = { wasEmpty: !raw, ids: additions.items[key].map(function (x) { return x.id }) }
  })
  Object.keys(additions.values).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson(raw, [])
    var have = base.map(function (x) { return JSON.stringify(x) })
    var added = additions.values[key].filter(function (x) { return have.indexOf(JSON.stringify(x)) === -1 })
    if (added.length === 0) return
    values[key] = JSON.stringify(base.concat(added))
    state.values[key] = { wasEmpty: !raw, added: added.map(function (x) { return JSON.stringify(x) }) }
  })
  Object.keys(additions.maps).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson(raw, {})
    var addedKeys = Object.keys(additions.maps[key]).filter(function (k) { return !Object.prototype.hasOwnProperty.call(base, k) })
    if (addedKeys.length === 0) return
    addedKeys.forEach(function (k) { base[k] = additions.maps[key][k] })
    values[key] = JSON.stringify(base)
    state.maps[key] = { wasEmpty: !raw, keys: addedKeys }
  })
  Object.keys(additions.scalars).forEach(function (key) {
    state.scalars[key] = { value: String(current[key] || '') }
    values[key] = String(additions.scalars[key])
  })
  return { values: values, state: state }
}

// mergeSampleSettings の記録をもとに、サンプルの分だけを取り除いた値を返す。
// サンプルを入れた後に画面から足した設定は残す
function restoreSampleSettings(current, state) {
  var values = {}
  Object.keys(state.lists || {}).forEach(function (key) {
    var s = state.lists[key]
    var rest = splitCsvList(current[key]).filter(function (v) { return s.added.indexOf(v) === -1 })
    var defaults = SAMPLE_LIST_DEFAULTS[key]
    var same = defaults && rest.length === defaults.length && rest.every(function (v, i) { return v === defaults[i] })
    values[key] = s.wasEmpty && (same || rest.length === 0) ? '' : rest.join(',')
  })
  Object.keys(state.items || {}).forEach(function (key) {
    var s = state.items[key]
    var rest = sampleParseJson(current[key], []).filter(function (x) { return !(x && s.ids.indexOf(x.id) !== -1) })
    values[key] = s.wasEmpty && rest.length === 0 ? '' : JSON.stringify(rest)
  })
  Object.keys(state.values || {}).forEach(function (key) {
    var s = state.values[key]
    var remaining = s.added.slice()
    var rest = sampleParseJson(current[key], []).filter(function (x) {
      var i = remaining.indexOf(JSON.stringify(x))
      if (i === -1) return true
      remaining.splice(i, 1)
      return false
    })
    values[key] = s.wasEmpty && rest.length === 0 ? '' : JSON.stringify(rest)
  })
  Object.keys(state.maps || {}).forEach(function (key) {
    var s = state.maps[key]
    var obj = sampleParseJson(current[key], {})
    s.keys.forEach(function (k) { delete obj[k] })
    values[key] = s.wasEmpty && Object.keys(obj).length === 0 ? '' : JSON.stringify(obj)
  })
  Object.keys(state.scalars || {}).forEach(function (key) { values[key] = state.scalars[key].value })
  return values
}

// ---- シートへの書き込み・削除 ----

var SAMPLE_SETTINGS_STATE_KEY = 'SAMPLE_SETTINGS_STATE'
var SAMPLE_FILE_IDS_KEY = 'SAMPLE_FILE_IDS'
// サンプルのメンバーが作った行(テスト用のアカウントで操作して増えた行)を見分ける列
var SAMPLE_OWNER_COLUMNS = { Tasks: 'creator_id', Expenses: 'applicant_id', FormSubmissions: 'submitter_id', DailyReports: 'member_id' }

function isSampleId(v) { return String(v || '').indexOf(SAMPLE_ID_PREFIX) === 0 }

// 行を見出しに合わせて末尾に一括で書き込む(書式なしテキストにして、日付の自動変換を避ける)
// サンプルのタスクの行の選択肢の値を、今のシートの形式にする
function sheetSampleTaskRow(o) {
  var out = {}
  Object.keys(o).forEach(function (k) { out[k] = o[k] })
  ;['status', 'difficulty', 'priority', 'importance', 'visibility', 'department'].forEach(function (k) {
    if (o[k] !== undefined && o[k] !== '') out[k] = sheetValue(k, o[k])
  })
  if (o.approval_status) out.approval_status = sheetCode('approval', o.approval_status)
  if (o.history_json) {
    try { out.history_json = JSON.stringify(JSON.parse(o.history_json).map(sheetHistoryEntry)) } catch (e) {}
  }
  if (o.schedule_json) {
    try { out.schedule_json = JSON.stringify(mapScheduleCodes(JSON.parse(o.schedule_json), sheetCode)) } catch (e) {}
  }
  return out
}

function appendSampleRows(sheetName, objects) {
  if (objects.length === 0) return 0
  var sheet = getSheet(sheetName)
  var headers = headerRow(sheet)
  var unknown = {}
  objects.forEach(function (o) { Object.keys(o).forEach(function (k) { if (headers.indexOf(k) === -1) unknown[k] = true }) })
  if (Object.keys(unknown).length) {
    throw userError(sheetName + 'シートに列が見つかりません: ' + Object.keys(unknown).join(', ') + '。setupOhsumi() を実行してください。')
  }
  var values = objects.map(function (o) { return headers.map(function (h) { return o[h] != null ? String(o[h]) : '' }) })
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length)
  range.setNumberFormat('@')
  range.setValues(values)
  return values.length
}

// 条件に合う行を下から削除する(連続した行はまとめて削除する)
function deleteSampleRows(sheetName, match) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(sheetName)
  if (!sheet || sheet.getLastRow() < 2) return 0
  var headers = headerRow(sheet)
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var hit = rows.map(function (r) {
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    return match(o)
  })
  var deleted = 0
  var i = hit.length - 1
  while (i >= 0) {
    if (!hit[i]) { i--; continue }
    var end = i
    while (i >= 0 && hit[i]) i--
    sheet.deleteRows(i + 3, end - i)
    deleted += end - i
  }
  return deleted
}

function createSampleFiles() {
  var folder = getUploadFolder()
  var stamp = Date.now()
  var ids = []
  var urls = {}
  sampleFileSpecs().forEach(function (spec) {
    var blob = spec.pdf
      ? Utilities.newBlob('<html><body style="font-family:sans-serif"><h2>領収書(サンプル)</h2><p>交通費 3,400円</p><p>サンプル交通株式会社</p></body></html>', 'text/html', 'receipt.html').getAs('application/pdf')
      : Utilities.newBlob(Utilities.base64Decode(SAMPLE_IMAGES[spec.png]), 'image/png', spec.key + '.png')
    var file = folder.createFile(blob)
    file.setName(spec.name + stamp)
    // 元のスプレッドシートと同じく、誰とも共有しない
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
    ids.push(file.getId())
    urls[spec.key] = spec.url === 'file' ? file.getUrl()
      : 'https://lh3.googleusercontent.com/d/' + file.getId() + (spec.url === 'image512' ? '=w512-h512-c' : '=w256-h256-c')
  })
  PropertiesService.getScriptProperties().setProperty(SAMPLE_FILE_IDS_KEY, JSON.stringify(ids))
  return urls
}

function trashSampleFiles() {
  var props = PropertiesService.getScriptProperties()
  var ids = sampleParseJson(props.getProperty(SAMPLE_FILE_IDS_KEY), [])
  var count = 0
  ids.forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); count++ } catch (e) { /* 既に削除済み */ }
  })
  // 記録に無いもの(途中で失敗した場合など)も、名前で探して消す
  try {
    var prefixes = sampleFileSpecs().map(function (s) { return s.name })
    var files = getUploadFolder().getFiles()
    while (files.hasNext()) {
      var f = files.next()
      var name = f.getName()
      if (prefixes.some(function (p) { return name.indexOf(p) === 0 }) && ids.indexOf(f.getId()) === -1) { f.setTrashed(true); count++ }
    }
  } catch (e) { /* アップロード用フォルダが無い */ }
  props.deleteProperty(SAMPLE_FILE_IDS_KEY)
  return count
}

function readSettingsValues(keys) {
  var out = {}
  keys.forEach(function (k) { out[k] = getSettingValue(k) || '' })
  return out
}

function sampleSettingKeys(settings) {
  var keys = []
  ;['lists', 'items', 'values', 'maps', 'scalars'].forEach(function (g) { keys = keys.concat(Object.keys(settings[g] || {})) })
  return keys
}

// サンプルを消す(ロックを取った中で呼ぶ)。返り値は削除した件数
function deleteSampleDataUnlocked() {
  var props = PropertiesService.getScriptProperties()
  var counts = {}
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    if (name === 'Settings') return
    var owner = SAMPLE_OWNER_COLUMNS[name]
    counts[name] = deleteSampleRows(name, function (o) { return isSampleId(o.id) || (owner && isSampleId(o[owner])) })
  })
  // Settings: サンプルの分だけを取り除き、値が1つの設定は元の値に戻す
  var state = sampleParseJson(props.getProperty(SAMPLE_SETTINGS_STATE_KEY), null)
  if (state) {
    var keys = sampleSettingKeys(state)
    var restored = restoreSampleSettings(readSettingsValues(keys), state)
    Object.keys(restored).forEach(function (k) { updateSetting(k, restored[k]) })
    props.deleteProperty(SAMPLE_SETTINGS_STATE_KEY)
  }
  // 画面で並べ替えた時などに残る、サンプルの id の参照を外す
  ;['project_order', 'survey_invited_ids'].forEach(function (k) {
    var list = splitCsvList(getSettingValue(k))
    var rest = list.filter(function (v) { return !isSampleId(v) })
    if (rest.length !== list.length) updateSetting(k, rest.join(','))
  })
  // サンプルのメンバーの通知の待ち行列・ログインの世代番号
  var all = props.getProperties()
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('notif_queue_' + SAMPLE_ID_PREFIX) === 0 || k.indexOf(SESSION_GEN_PREFIX + SAMPLE_ID_PREFIX) === 0) props.deleteProperty(k)
  })
  counts.files = trashSampleFiles()
  resetRequestProps()
  return counts
}

function withSampleLock(fn) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return fn()
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

// サンプルのデータを作る(テスト環境専用)。既にサンプルがあれば、消してから作り直す
function seedSampleData() {
  assertTestEnvironment()
  var props = PropertiesService.getScriptProperties()
  var accounts = parseSampleTestAccounts(props.getProperty('TEST_ACCOUNTS'))
  var emailSheet = getMemberEmailsSheet()
  var emailRows = emailSheet.getLastRow() > 1 ? emailSheet.getRange(2, 1, emailSheet.getLastRow() - 1, 2).getValues() : []
  assertSampleAccountsUnregistered(accounts, emailRows)

  if (getDiscordWebhookUrl() || getSlackWebhookUrl()) {
    console.warn('⚠ Discord・Slack の Webhook が設定されています。テスト環境では投稿せずログだけにします' +
      '(スクリプトプロパティ TEST_ALLOW_CHAT を true にすると、実際に投稿します)。')
  }

  return withSampleLock(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheetHeaders(ss, name, SHEET_HEADERS[name]) })
    var removed = deleteSampleDataUnlocked()

    var files = createSampleFiles()
    var data = buildSampleData(todayStr(), files)
    var counts = {}
    // 選択肢の値は、今のシートの形式(移行の前は日本語、後はコード)で書く
    data.sheets[SHEET_TASKS] = (data.sheets[SHEET_TASKS] || []).map(sheetSampleTaskRow)
    Object.keys(data.sheets).forEach(function (name) { counts[name] = appendSampleRows(name, data.sheets[name]) })

    // テスト用のアカウントだけメールアドレスを登録する(他のサンプルのメンバーには登録しない)
    Object.keys(accounts).forEach(function (slot) {
      appendRowByHeaders(emailSheet, SHEET_MEMBER_EMAILS, { id: SAMPLE_ACCOUNT_SLOTS[slot], email: accounts[slot] })
    })

    // 役職の設定(roles)を使っている団体では、サンプルの役職を roles に足す
    var sampleSettings = hasRolesSetting() ? sampleSettingsWithRoles(data.settings) : data.settings
    var merged = mergeSampleSettings(readSettingsValues(sampleSettingKeys(sampleSettings)), sampleSettings)
    Object.keys(merged.values).forEach(function (k) { updateSetting(k, sheetSettingValue(k, merged.values[k])) })
    props.setProperty(SAMPLE_SETTINGS_STATE_KEY, JSON.stringify(merged.state))

    bumpDataVersion()
    bumpMemberEmailsVersion()
    var assigned = Object.keys(accounts).map(function (slot) { return slot + ' → ' + SAMPLE_ACCOUNT_SLOTS[slot] + '(' + accounts[slot] + ')' })
    var msg = '🧪 サンプルのデータを作成しました(基準日: ' + todayStr() + ')。' +
      Object.keys(counts).map(function (k) { return k + ' ' + counts[k] + ' 行' }).join('、') +
      '、ダミー画像 ' + Object.keys(files).length + ' 件。' +
      (assigned.length ? ' テスト用のアカウント: ' + assigned.join('、') : ' TEST_ACCOUNTS が未設定のため、ログインできるサンプルのメンバーはいません。') +
      (removed.Tasks || removed.Members ? '(前回のサンプルは削除してから作り直しました)' : '')
    console.log(msg)
    return msg
  })
}

// サンプルのデータを消し、Settings を元に戻す(テスト環境専用)
function deleteSampleData() {
  assertTestEnvironment()
  return withSampleLock(function () {
    var counts = deleteSampleDataUnlocked()
    bumpDataVersion()
    bumpMemberEmailsVersion()
    var msg = '🧹 サンプルのデータを削除しました: ' + Object.keys(counts).map(function (k) { return k + ' ' + counts[k] }).join('、') +
      '。Settings はサンプルの分を取り除き、団体名・ロゴ・テーマの色は元の値に戻しました。'
    console.log(msg)
    return msg
  })
}

// ---- 内部コードへの移行(migrateToInternalCodes) ---------------------------------------
//
// Apps Script エディタから手動で実行する。スクリプトプロパティ MIGRATION_MODE で動きを切り替える。
//   dryRun(既定): 何も書き込まず、変換される件数と例・当てはまらない値・作られる役職を実行ログに出す
//   apply: スプレッドシートのバックアップのコピー(誰とも共有しない)を作ってから書き換え、
//          VALUE_FORMAT=codes にする。終わったら MIGRATION_MODE を dryRun に戻す
// 何度実行しても結果は同じ(2回目は何も変わらない)。列は見出しの名前で探すので、列や設定が無くても動く。
// 最上位の役職は「代表」。名前を変えている団体は、スクリプトプロパティ MIGRATION_TOP_ROLE_NAME で指定する。
// 変換の表は VALUE_CODES・役職・部門の一覧。当てはまらない値は変えずに残し、報告する。

var MIGRATION_TASK_CODE_COLUMNS = {
  status: 'status', difficulty: 'difficulty', priority: 'priority',
  importance: 'importance', visibility: 'visibility', approval_status: 'approval',
}

// 表(VALUE_CODES)にある値ならコードを、無ければ null を返す(空は呼ぶ側で扱う)
function knownCode(kind, value) {
  var v = String(value === null || value === undefined ? '' : value).trim()
  var table = VALUE_CODES[kind]
  if (table.codes.indexOf(v) >= 0) return v
  for (var i = 0; i < table.codes.length; i++) if (table.sheetLabels[table.codes[i]] === v) return table.codes[i]
  if (Object.prototype.hasOwnProperty.call(table.aliases, v)) return table.aliases[v]
  return null
}

// 移行後の役職の一覧を作る(roles が既にあればそれを使う)
function migrationRoles(settings, memberRoleRefs, topRoleName, report) {
  var existing = parseRolesSetting(settings.roles)
  if (existing) return { roles: existing, created: false }
  var roles = rolesFromLegacy(settings)
  // メンバーにあって役職の一覧に無い役職名は、管理者の役職として作る(今までも管理者として扱っていた)
  memberRoleRefs.forEach(function (ref) {
    var v = String(ref || '').trim()
    if (!v || findRole(roles, v)) return
    roles.push({ id: v, name: v, tier: 'admin', restricted: false })
    report.createdRoles.push(v)
  })
  var topName = String(topRoleName || '').trim() || DEFAULT_TOP_ROLE_NAME
  var top = null
  roles.forEach(function (r) { if (r.name === topName) top = r })
  if (!top) {
    report.errors.push('最上位の役職「' + topName + '」が見つかりません。MIGRATION_TOP_ROLE_NAME に、最上位にする役職の名前を指定してください。')
    return { roles: roles, created: true }
  }
  if (topName !== DEFAULT_TOP_ROLE_NAME) {
    top.tier = 'top'
    delete top.restricted
    // 自動で足した「代表」を、使っている人がいなければ外す
    var used = memberRoleRefs.some(function (ref) { return String(ref || '').trim() === DEFAULT_TOP_ROLE_NAME })
    var listed = splitCsvList(settings.role_levels).indexOf(DEFAULT_TOP_ROLE_NAME) >= 0
    if (!used && !listed) roles = roles.filter(function (r) { return r.name !== DEFAULT_TOP_ROLE_NAME })
  }
  roles = orderMigrationRoles(roles, report)
  // ID を付ける: 一般 → base、最上位(指定した役職)→ top、ほかは新しい ID
  roles = roles.map(function (r) {
    var copy = {}
    Object.keys(r).forEach(function (k) { copy[k] = r[k] })
    if (r.tier === 'base') copy.id = BASE_ROLE_ID
    else if (r === top) copy.id = TOP_ROLE_ID
    else copy.id = newRoleId()
    return copy
  })
  return { roles: roles, created: true }
}

// 役職を上下関係の順(一般 → 管理者の役職 → 最上位の役職)に並べる。管理者の役職の中では今の順を保つので、
// 役職の一覧に無かった役職(最後に足したもの)は既存の管理者の役職の後ろ、つまり最上位の役職のすぐ下に入る。
// 最上位の役職より後ろに並んでいた管理者の役職(role_levels で代表の後ろに書いたものなど)も、最上位の役職の下へ移す。
// 入れた位置・移した位置は report.rolePlacements に出す
function orderMigrationRoles(roles, report) {
  var byTier = function (tier) { return roles.filter(function (r) { return r.tier === tier }) }
  var tops = byTier('top')
  var ordered = byTier('base').concat(byTier('admin'), tops)
  var created = report.createdRoles || []
  var firstTop = tops.length ? roles.indexOf(tops[0]) : -1
  ordered.forEach(function (r, i) {
    if (r.tier !== 'admin') return
    var isCreated = created.indexOf(r.name) >= 0
    var wasAboveTop = firstTop >= 0 && roles.indexOf(r) > firstTop
    if (!isCreated && !wasAboveTop) return
    report.rolePlacements.push({
      name: r.name,
      reason: isCreated ? 'created' : 'moved',
      below: i > 0 ? ordered[i - 1].name : '',
      above: i < ordered.length - 1 ? ordered[i + 1].name : '',
    })
  })
  return ordered
}

// 移行の計画を作る(Google のサービスを使わない純粋な関数)。
// snapshot: { Tasks, Members, Settings, Expenses } の { headers, rows }。opts: { topRoleName }
// 返り値: { cells: { シート名: [[行, 列, 新しい値], ...] }, settings: { キー: 値 }, report }
function planMigration(snapshot, opts) {
  opts = opts || {}
  var report = { counts: {}, examples: {}, unknown: {}, createdRoles: [], rolePlacements: [], roles: [], roleMembers: {}, errors: [] }
  var cells = {}
  var settingsOut = {}
  var table = function (name) { return snapshot[name] || { headers: [], rows: [] } }
  var note = function (key, from, to) {
    report.counts[key] = (report.counts[key] || 0) + 1
    report.examples[key] = report.examples[key] || []
    if (report.examples[key].length < 5) report.examples[key].push(String(from) + ' → ' + String(to))
  }
  var unknown = function (key, value) {
    report.unknown[key] = report.unknown[key] || {}
    var v = String(value)
    report.unknown[key][v] = (report.unknown[key][v] || 0) + 1
  }
  var setCell = function (sheet, r, c, value) {
    cells[sheet] = cells[sheet] || []
    cells[sheet].push([r, c, value])
  }

  // Settings(key → value)
  var st = table('Settings')
  var keyCol = st.headers.indexOf('key')
  var valueCol = st.headers.indexOf('value')
  var settings = {}
  if (keyCol >= 0 && valueCol >= 0) st.rows.forEach(function (r) { settings[String(r[keyCol])] = String(r[valueCol] === null || r[valueCol] === undefined ? '' : r[valueCol]) })
  var departments = departmentsFromSettings(settings)

  // 部門の値: 表にあれば ID、無ければ null
  var knownDept = function (value) {
    var v = String(value === null || value === undefined ? '' : value).trim()
    if (v === UNCATEGORIZED_NAME) return ''
    var d = findDepartment(departments, v)
    return d ? d.id : null
  }
  var convertValue = function (key, kind, value) {
    var v = String(value === null || value === undefined ? '' : value).trim()
    if (!v) return { value: value, changed: false }
    var code = kind === 'department' ? knownDept(v) : knownCode(kind, v)
    if (code === null) { unknown(key, v); return { value: value, changed: false } }
    return { value: code, changed: code !== v }
  }

  // 役職
  var mt = table('Members')
  var mRole = mt.headers.indexOf('role')
  var mInactive = mt.headers.indexOf('inactive')
  var memberRoleRefs = mRole >= 0 ? mt.rows.map(function (r) { return r[mRole] }) : []
  var built = migrationRoles(settings, memberRoleRefs, opts.topRoleName, report)
  var roles = built.roles
  if (built.created) settingsOut.roles = JSON.stringify(roles)
  report.roles = roles.map(function (r) { return { id: r.id, name: r.name, tier: r.tier, restricted: r.tier === 'admin' && r.restricted === true } })
  var roleRefToId = function (key, ref) {
    var v = String(ref === null || ref === undefined ? '' : ref).trim()
    if (!v) return null
    var role = findRole(roles, v)
    if (!role) { unknown(key, v); return null }
    return role.id === v ? null : role.id
  }

  // Tasks
  var tt = table('Tasks')
  Object.keys(MIGRATION_TASK_CODE_COLUMNS).forEach(function (col) {
    var c = tt.headers.indexOf(col)
    if (c < 0) return
    tt.rows.forEach(function (row, i) {
      var res = convertValue('Tasks.' + col, MIGRATION_TASK_CODE_COLUMNS[col], row[c])
      if (res.changed) { note('Tasks.' + col, row[c], res.value); setCell('Tasks', i, c, res.value) }
    })
  })
  var dc = tt.headers.indexOf('department')
  if (dc >= 0) {
    tt.rows.forEach(function (row, i) {
      var v = String(row[dc] === null || row[dc] === undefined ? '' : row[dc]).trim()
      if (!v) return
      var id = knownDept(v)
      if (id === null) { unknown('Tasks.department', v); return }
      if (id !== v) { note('Tasks.department', v, id === '' ? '(空)' : id); setCell('Tasks', i, dc, id) }
    })
  }
  var hc = tt.headers.indexOf('history_json')
  if (hc >= 0) {
    tt.rows.forEach(function (row, i) {
      var list = parseJsonOr(row[hc], null)
      if (!Array.isArray(list)) return
      var changed = false
      var next = list.map(function (h) {
        var kind = h && HISTORY_CODE_FIELDS[h.field]
        if (!kind) return h
        var copy = {}
        Object.keys(h).forEach(function (k) { copy[k] = h[k] })
        ;['from', 'to'].forEach(function (side) {
          var res = convertValue('Tasks.history_json(' + h.field + ')', kind, h[side])
          if (res.changed) { copy[side] = res.value; changed = true }
        })
        return copy
      })
      if (changed) { note('Tasks.history_json', '(変更の記録)', '(コード)'); setCell('Tasks', i, hc, JSON.stringify(next)) }
    })
  }
  var sc = tt.headers.indexOf('schedule_json')
  if (sc >= 0) {
    tt.rows.forEach(function (row, i) {
      var schedule = parseJsonOr(row[sc], null)
      if (!schedule || !schedule.responses) return
      var changed = false
      Object.keys(schedule.responses).forEach(function (mid) {
        var answers = schedule.responses[mid] || {}
        Object.keys(answers).forEach(function (cid) {
          var res = convertValue('Tasks.schedule_json', 'scheduleAnswer', answers[cid])
          if (res.changed) { answers[cid] = res.value; changed = true }
        })
      })
      if (changed) { note('Tasks.schedule_json', '(日程調整の回答)', '(コード)'); setCell('Tasks', i, sc, JSON.stringify(schedule)) }
    })
  }

  // Members
  if (mRole >= 0) {
    mt.rows.forEach(function (row, i) {
      var id = roleRefToId('Members.role', row[mRole])
      if (id) { note('Members.role', row[mRole], id); setCell('Members', i, mRole, id) }
    })
  }
  var oc = mt.headers.indexOf('permission_overrides_json')
  if (oc >= 0) {
    mt.rows.forEach(function (row, i) {
      var list = parseJsonOr(row[oc], null)
      if (!Array.isArray(list)) return
      var changed = false
      list.forEach(function (ov) {
        if (!ov || ov.targetType !== 'department') return
        var res = convertValue('Members.permission_overrides_json(部門)', 'department', ov.targetId)
        if (res.changed) { ov.targetId = res.value; changed = true }
      })
      if (changed) { note('Members.permission_overrides_json', '(部門の権限の例外)', '(部門 ID)'); setCell('Members', i, oc, JSON.stringify(list)) }
    })
  }
  // 最上位の役職を持つ有効なメンバーが1人以上いること
  if (mRole >= 0) {
    var tops = 0
    mt.rows.forEach(function (row) {
      var inactive = mInactive >= 0 && String(row[mInactive] || '').trim().toUpperCase() === 'TRUE'
      var role = findRole(roles, row[mRole])
      var roleId = role ? role.id : String(row[mRole] || '').trim()
      report.roleMembers[roleId || BASE_ROLE_ID] = (report.roleMembers[roleId || BASE_ROLE_ID] || 0) + 1
      if (!inactive && isTopRoleRef(roles, row[mRole])) tops++
    })
    if (tops === 0 && mt.rows.length > 0) report.errors.push('最上位の役職を持つ有効なメンバーがいません。MIGRATION_TOP_ROLE_NAME を確かめてください。')
  }

  // 承認ステップの役職(経費申請の各行・経費のカテゴリ・フォームの定義)
  var convertSteps = function (key, steps) {
    if (!Array.isArray(steps)) return false
    var changed = false
    steps.forEach(function (step) {
      if (!step || step.type !== 'role') return
      var id = roleRefToId(key, step.role)
      if (id) { step.role = id; changed = true }
    })
    return changed
  }
  var et = table('Expenses')
  var ec = et.headers.indexOf('approval_steps_json')
  if (ec >= 0) {
    et.rows.forEach(function (row, i) {
      var steps = parseJsonOr(row[ec], null)
      if (convertSteps('Expenses.approval_steps_json(承認ステップの役職)', steps)) {
        note('Expenses.approval_steps_json', '(承認ステップの役職)', '(役職 ID)')
        setCell('Expenses', i, ec, JSON.stringify(steps))
      }
    })
  }
  ;['custom_form_defs', 'expense_categories'].forEach(function (key) {
    var defs = parseJsonOr(settings[key], null)
    if (!Array.isArray(defs)) return
    var changed = false
    defs.forEach(function (d) { if (d && convertSteps('Settings.' + key + '(承認ステップの役職)', d.approvalSteps)) changed = true })
    if (changed) { note('Settings.' + key, '(承認ステップの役職)', '(役職 ID)'); settingsOut[key] = JSON.stringify(defs) }
  })

  // Settings のテンプレート・定期タスク(部門・難易度・優先度・きっかけのステータス)
  var convertItem = function (key, item) {
    if (!item || typeof item !== 'object') return false
    var changed = false
    ;[['department', 'department'], ['difficulty', 'difficulty'], ['priority', 'priority'], ['triggerOnStatus', 'status']].forEach(function (p) {
      if (!(p[0] in item)) return
      var res = convertValue(key + '(' + p[0] + ')', p[1], item[p[0]])
      if (res.changed) { item[p[0]] = res.value; changed = true }
    })
    return changed
  }
  var pt = parseJsonOr(settings.project_templates, null)
  if (pt && typeof pt === 'object' && !Array.isArray(pt)) {
    var ptChanged = false
    Object.keys(pt).forEach(function (name) { (Array.isArray(pt[name]) ? pt[name] : []).forEach(function (it) { if (convertItem('Settings.project_templates', it)) ptChanged = true }) })
    if (ptChanged) { note('Settings.project_templates', '(テンプレート)', '(コード)'); settingsOut.project_templates = JSON.stringify(pt) }
  }
  var tst = parseJsonOr(settings.task_set_templates, null)
  if (Array.isArray(tst)) {
    var tstChanged = false
    tst.forEach(function (tpl) { (tpl && Array.isArray(tpl.items) ? tpl.items : []).forEach(function (it) { if (convertItem('Settings.task_set_templates', it)) tstChanged = true }) })
    if (tstChanged) { note('Settings.task_set_templates', '(業務テンプレート)', '(コード)'); settingsOut.task_set_templates = JSON.stringify(tst) }
  }
  var rr = parseJsonOr(settings.recurring_rules, null)
  if (Array.isArray(rr)) {
    var rrChanged = false
    rr.forEach(function (rule) { if (convertItem('Settings.recurring_rules', rule)) rrChanged = true })
    if (rrChanged) { note('Settings.recurring_rules', '(定期タスク)', '(コード)'); settingsOut.recurring_rules = JSON.stringify(rr) }
  }
  var th = parseJsonOr(settings.skill_level_thresholds, null)
  if (th && typeof th === 'object' && Object.prototype.hasOwnProperty.call(th, LEGACY_DEFAULT_THRESHOLD_KEY)) {
    var nextTh = {}
    Object.keys(th).forEach(function (k) {
      if (k === LEGACY_DEFAULT_THRESHOLD_KEY) { if (!(DEFAULT_THRESHOLD_KEY in th)) nextTh[DEFAULT_THRESHOLD_KEY] = th[k] } else nextTh[k] = th[k]
    })
    note('Settings.skill_level_thresholds', LEGACY_DEFAULT_THRESHOLD_KEY, DEFAULT_THRESHOLD_KEY)
    settingsOut.skill_level_thresholds = JSON.stringify(nextTh)
  }

  return { cells: cells, settings: settingsOut, report: report }
}

// 計画の報告を実行ログの行にする
function formatMigrationReport(plan, mode) {
  var r = plan.report
  var lines = ['==== 内部コードへの移行(' + mode + ') ====']
  var keys = Object.keys(r.counts)
  lines.push(keys.length ? '■ 変換される値(シート.列: 件数 / 例)' : '■ 変換される値はありません(移行済み、またはデータがありません)')
  keys.sort().forEach(function (k) { lines.push('  ' + k + ': ' + r.counts[k] + '件 / ' + r.examples[k].join('、')) })
  var uk = Object.keys(r.unknown)
  lines.push(uk.length ? '■ 当てはまらない値(変換せずに残します。必要なら手で直してから、もう一度 dryRun してください)' : '■ 当てはまらない値はありません')
  uk.sort().forEach(function (k) {
    lines.push('  ' + k + ': ' + Object.keys(r.unknown[k]).map(function (v) { return '「' + v + '」' + r.unknown[k][v] + '件' }).join('、'))
  })
  lines.push('■ 移行後の役職(下の役職から順。種類・人数)')
  r.roles.forEach(function (role) {
    var kind = role.tier === 'admin' ? (role.restricted ? '、制限付きの管理者' : '、全権の管理者') : ''
    lines.push('  ' + role.name + '(' + role.tier + kind + '、ID: ' + role.id + ')' + (r.roleMembers[role.id] || 0) + '人')
  })
  if (r.createdRoles.length) lines.push('■ 役職の一覧に無かったため、管理者の役職として作る役職: ' + r.createdRoles.join('、'))
  if (r.rolePlacements.length) {
    lines.push('■ 役職を入れる位置(管理者の役職は、一般より上・最上位の役職より下に並べます)')
    r.rolePlacements.forEach(function (p) {
      var why = p.reason === 'created' ? '役職の一覧に無かった役職' : '最上位の役職より後ろに並んでいた役職'
      lines.push('  ' + p.name + ': 「' + p.below + '」の上、「' + p.above + '」の下(' + why + ')')
    })
  }
  var sk = Object.keys(plan.settings)
  if (sk.length) lines.push('■ 書き換える Settings のキー: ' + sk.join('、'))
  if (r.errors.length) {
    lines.push('■ エラー(このままでは apply できません)')
    r.errors.forEach(function (e) { lines.push('  ' + e) })
  }
  return lines
}

// 移行に使うシートを読む
function readMigrationSnapshot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var out = {}
  ;[SHEET_TASKS, SHEET_MEMBERS, SHEET_SETTINGS, SHEET_EXPENSES].forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet || sheet.getLastRow() < 1) { out[name] = { headers: [], rows: [] }; return }
    var headers = headerRow(sheet)
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
    out[name] = { headers: headers, rows: rows }
  })
  return out
}

// スプレッドシートのバックアップのコピーを作り、誰とも共有しない状態にする。
// コピーには Apps Script のプロジェクトも複製されるが、そのコピーの GAS はデプロイしない
function createPrivateBackupCopy() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  var copy = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + '(内部コードへの移行前のバックアップ ' + stamp + ')', DriveApp.getRootFolder())
  copy.getEditors().forEach(function (u) { try { copy.removeEditor(u) } catch (e) { /* 自分自身など */ } })
  copy.getViewers().forEach(function (u) { try { copy.removeViewer(u) } catch (e) { /* 自分自身など */ } })
  try { copy.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE) } catch (e) { /* 組織の設定で変えられない場合 */ }
  return copy
}

// 計画どおりにシートと設定を書き換える
function applyMigrationPlan(plan) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  Object.keys(plan.cells).forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet) return
    var headers = headerRow(sheet)
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    var touchedCols = {}
    plan.cells[name].forEach(function (cell) { data[cell[0]][cell[1]] = cell[2]; touchedCols[cell[1]] = true })
    // 変えた列だけを書き戻す
    Object.keys(touchedCols).forEach(function (c) {
      var col = Number(c)
      var range = sheet.getRange(2, col + 1, data.length, 1)
      range.setNumberFormat('@')
      range.setValues(data.map(function (row) { return [row[col]] }))
    })
  })
  Object.keys(plan.settings).forEach(function (key) { updateSetting(key, plan.settings[key]) })
}

function migrateToInternalCodes() {
  var props = PropertiesService.getScriptProperties()
  var mode = props.getProperty('MIGRATION_MODE') === 'apply' ? 'apply' : 'dryRun'
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(30000)) throw new Error('ほかの処理が実行中です。少し待ってからもう一度実行してください。')
  try {
    resetRequestProps()
    var plan = planMigration(readMigrationSnapshot(), { topRoleName: props.getProperty('MIGRATION_TOP_ROLE_NAME') })
    formatMigrationReport(plan, mode).forEach(function (line) { console.log(line) })
    if (mode !== 'apply') {
      console.log('dryRun のため、何も書き込んでいません。内容を確かめてから、スクリプトプロパティ MIGRATION_MODE を apply にして、もう一度実行してください。')
      return plan.report
    }
    if (plan.report.errors.length) throw new Error('エラーがあるため移行しませんでした。上のエラーを直してから、もう一度実行してください。')

    var copy = createPrivateBackupCopy()
    console.log('💾 バックアップのコピーを作りました(誰とも共有していません): ' + copy.getName() + ' ' + copy.getUrl())
    console.log('⚠️ このコピーには Apps Script(GAS)も一緒に複製されていますが、コピーの GAS はデプロイしないでください(同じ団体のデータの窓口が2つになります)。')
    console.log('   移行の後、しばらく(目安: 1か月)問題がなければ、このコピーは削除して構いません。')

    applyMigrationPlan(plan)
    updateSetting('migrated_at', new Date().toISOString())
    props.setProperty('VALUE_FORMAT', 'codes')
    props.setProperty('MIGRATION_MODE', 'dryRun')
    resetRequestProps()
    try { SpreadsheetApp.flush() } catch (e) { /* 実行の終了時にも確定する */ }
    bumpDataVersion()
    console.log('✅ 移行しました。VALUE_FORMAT=codes にし、MIGRATION_MODE を dryRun に戻しました。')
    console.log('   開いているタブは、再読み込みするまで GAS に断られます(「ページを再読み込みしてください」と表示されます)。')
    return plan.report
  } finally {
    lock.releaseLock()
  }
}
