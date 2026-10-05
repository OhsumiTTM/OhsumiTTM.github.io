// ============================================================================
// 中で使うだけの関数(名前の最後に _)
// ============================================================================

// 今のコードに無い関数を指すトリガーを消す。以前の版で作ったトリガーが、消した・名前を変えた関数を
// 指したまま残っていると、トリガーが動くたびにエラーになる(setupOhsumi の最初に呼ぶ)。消した関数名を返す
function removeOrphanTriggers_() {
  var removed = []
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var name = t.getHandlerFunction()
    if (typeof globalThis[name] !== 'function') {
      ScriptApp.deleteTrigger(t)
      removed.push(name)
    }
  })
  if (removed.length) console.log('🧹 今のコードに無い関数を指すトリガーを消しました: ' + removed.join(', '))
  return removed
}

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
  'quiz_passes_json',         // 検定の合格の記録 [{"quizId","skill","level","at"}](スキルのレベルの条件に使う)
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
  // 退会と個人情報の削除(「個人情報の削除」)
  'withdrawn_at',            // 退会した日時(ISO)。空なら在籍
  'purge_at',                // 個人情報を消す日時を延ばした時の日時(ISO)。空なら 退会の日時 + 保存期間
  'personal_data_purged_at', // 個人情報を消した日時(ISO)
  'withdrawal_unassigned_task_ids', // 退会の時に未アサインに戻したタスクの ID(カンマ区切り。退会を取り消した時に一覧を出す)
  // 書き込みの競合チェック(「行の版」)
  'row_version',             // 行の版(内容を変えるたびに新しくなる。画面が開いた時の版と違えば、上書きせずに断る)
  'row_updated_by',          // 行の内容を最後に変えた人(メンバーID。毎日の処理などは system)
]
var PROJECTS_HEADERS = [
  'id', 'name', 'description', 'type', 'owner_id', 'member_ids', 'archived', 'parent_id',
  'goal', // 目標（概要=descriptionとは別枠）
  'health_override',       // item 26: 幹部による健康状態の手動上書き
  'last_notified_health',  // item 26: 直近に通知した実効健康状態（重複通知防止）
  'start_date', // PRJ-003: プロジェクトの開始日（任意, YYYY-MM-DD）
  'end_date',   // PRJ-003: プロジェクトの終了予定日（任意, YYYY-MM-DD）
  'row_version', 'row_updated_by', // 書き込みの競合チェック(「行の版」)
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
  'calendar_event_id', // カレンダーの予定の ID(syncCalendarForTask_ が書く。画面には返さない)
  'deleted_at',        // ゴミ箱に入れた日時(ISO)。空なら使っているタスク。30日後に毎日の処理が行を消す
  'deleted_by',        // ゴミ箱に入れた人(メンバーID)
  'row_version', 'row_updated_by', // 書き込みの競合チェック(「行の版」)
]
var SETTINGS_HEADERS = ['key', 'value']
var EXPENSES_HEADERS = ['id', 'applicant_id', 'amount', 'category_id', 'receipt_url', 'justification', 'purpose', 'custom_field_answers_json', 'approval_steps_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var FORM_SUBMISSIONS_HEADERS = ['id', 'form_id', 'submitter_id', 'answers_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var DAILY_REPORTS_HEADERS = ['id', 'member_id', 'type', 'report_date', 'done_text', 'todo_text', 'issues_text', 'created_at']
var CANDIDATES_HEADERS = ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at',
  // 採用しなかった日時と、消す日時を延ばした時の日時(「個人情報の削除」)
  'rejected_at', 'purge_at']

// 本人だけが読み書きできる保存(getMyStorage・setMyStorage)。画面が決めたキーごとに、値を40000文字ずつの行に分けて持つ
var PERSONAL_STORE_HEADERS = ['id', 'key', 'part', 'value', 'updated_at'] // id はメンバーID(1人に何行もある)
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
  PersonalStore: PERSONAL_STORE_HEADERS,
}

var SETTINGS_KEY_RECURRING_RULES = 'recurring_rules'
// NOT a Settings-sheet key (that sheet is published as a public CSV) — this
// is the PropertiesService key the Discord webhook URL is stored under
// instead. See getDiscordWebhookUrl_()/updateDiscordWebhookUrl() below.
var DISCORD_WEBHOOK_PROPERTY_KEY = 'discord_webhook_url'

// ---- 選択肢の値の内部コード ------------------------------------------------------
//
// タスクのステータス・難易度・優先度などは、画面の言語によらない内部コードで
// 扱う。以前の団体のシート・手で直したシート・古いバックアップには日本語の値が入って
// いることがある。読む時はどちらの形式でもコードにそろえ(normalizeCode_)、書く時は
// スクリプトプロパティ VALUE_FORMAT が codes になるまで日本語で書く(sheetCode_)。
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
function normalizeCode_(kind, value) {
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
function isCodesFormat_() {
  return requestProps_().VALUE_FORMAT === 'codes'
}

// コードを、シートに書く形式にする(移行前は日本語。一覧に無い値はそのまま)
function sheetCode_(kind, value) {
  var code = normalizeCode_(kind, value)
  if (isCodesFormat_()) return code
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

function notifyLabel_(kind, locale, value) {
  var code = normalizeCode_(kind, value)
  var labels = NOTIFY_LABELS[kind][locale] || NOTIFY_LABELS[kind].ja
  return Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : code
}

// 以前のスキルのレベルアップの閾値(skill_level_thresholds)で、既定値を表すキー(移行前は「デフォルト」)。
// レベルの計算には使わなくなった(skill_level_rules)が、保存されている値の移行のために残す
var DEFAULT_THRESHOLD_KEY = '_default'
var LEGACY_DEFAULT_THRESHOLD_KEY = 'デフォルト'

// フロントの版。移行の後は、これより古い(または版の無い)リクエストを拒否する。
// 移行前のコードを読めない古いタブが、ステータスなどを誤って表示・保存するのを防ぐ
// (lib/ohsumi/codes.ts の CLIENT_VERSION と合わせる)
var MIN_CLIENT_VERSION = 1

function checkClientVersion_(body) {
  if (!isCodesFormat_()) return null
  var v = Number(body && body.clientVersion) || 0
  if (v >= MIN_CLIENT_VERSION) return null
  return 'Ohsumi が更新されました。ページを再読み込みしてください。'
}

// 変更の記録(history_json)のうち、値がコードになる項目
var HISTORY_CODE_FIELDS = {
  status: 'status', priority: 'priority', difficulty: 'difficulty',
  visibility: 'visibility', importance: 'importance', department: 'department',
}

function mapHistoryCodes_(entry, convert) {
  var kind = entry && HISTORY_CODE_FIELDS[entry.field]
  if (!kind) return entry
  var out = {}
  Object.keys(entry).forEach(function (k) { out[k] = entry[k] })
  out.from = convert(kind, entry.from)
  out.to = convert(kind, entry.to)
  return out
}

function normalizeHistoryEntry_(entry) { return mapHistoryCodes_(entry, normalizeValue_) }
function sheetHistoryEntry_(entry) { return mapHistoryCodes_(entry, sheetValue_) }

function mapScheduleCodes_(schedule, convert) {
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

function mapOverrideCodes_(overrides, convert) {
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
function mapTaskItemCodes_(item, convert) {
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
function sheetSettingValue_(key, value) {
  if (CODE_SETTING_KEYS.indexOf(key) < 0 || typeof value !== 'string' || !value) return value
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return value }
  var convert = sheetValue_
  var out = parsed
  if (key === 'project_templates' && parsed && typeof parsed === 'object') {
    out = {}
    Object.keys(parsed).forEach(function (name) {
      out[name] = Array.isArray(parsed[name]) ? parsed[name].map(function (it) { return mapTaskItemCodes_(it, convert) }) : parsed[name]
    })
  } else if (key === 'task_set_templates' && Array.isArray(parsed)) {
    out = parsed.map(function (tpl) {
      if (!tpl || !Array.isArray(tpl.items)) return tpl
      var copy = {}
      Object.keys(tpl).forEach(function (k) { copy[k] = tpl[k] })
      copy.items = tpl.items.map(function (it) { return mapTaskItemCodes_(it, convert) })
      return copy
    })
  } else if (key === 'recurring_rules' && Array.isArray(parsed)) {
    out = parsed.map(function (rule) { return mapTaskItemCodes_(rule, convert) })
  } else if (key === 'skill_level_thresholds' && parsed && typeof parsed === 'object') {
    var fromKey = isCodesFormat_() ? LEGACY_DEFAULT_THRESHOLD_KEY : DEFAULT_THRESHOLD_KEY
    var toKey = isCodesFormat_() ? DEFAULT_THRESHOLD_KEY : LEGACY_DEFAULT_THRESHOLD_KEY
    out = {}
    Object.keys(parsed).forEach(function (k) {
      if (k === fromKey) { if (!(toKey in parsed)) out[toKey] = parsed[k] } else out[k] = parsed[k]
    })
  }
  return JSON.stringify(out)
}

