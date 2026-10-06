
// ---- 残りの値の確かめ(形と大きさ) ---------------------------------------------
//
// 画面が送る値のうち、まだ確かめていなかったものを、保存する前に確かめる(おかしな値は保存せずに断る)。
// 画面が今送る値はすべて通す(画面の選択肢・入力の上限と同じか、それより広くしてある)。
//   ・本人の設定: 通知の設定・タイムゾーン・表示言語・アイコンの色と文字・学歴・カスタム列
//   ・プロジェクトの健康状態(手動の上書き・自動判定の記録)
//   ・採用の候補者の項目
//   ・updateSetting の値: フォームの定義と承認の段・検定・定期タスクの規則・項目ごとの閲覧範囲・団体の保存の権限・
//     スキルのレベルの決め方・稼働の目安の決め方
var NOTIFY_KINDS = ['new_task', 'review', 'mention', 'rejected', 'deadline']
var NOTIFY_FREQUENCIES = ['immediate', '3h', '6h', '1d', 'none']
var TIMEZONE_RE = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+\-]+){1,2})$/
var LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/
var AVATAR_COLOR_RE = /^#[0-9a-fA-F]{6}$/
var CUSTOM_FIELDS_MAX_KEYS = 100
var CUSTOM_FIELD_VALUE_MAX = 2000
var CANDIDATE_STATUSES = ['candidate', 'hired', 'rejected']
var CANDIDATE_TEXT_MAX = 50000

function isPlainObject_(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function checkText_(v, max, label, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw userError_(label + 'を入れてください。')
    return ''
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw userError_(label + 'の形が正しくありません。')
  var s = String(v)
  if (s.length > max) throw userError_(label + 'は' + max + '文字以内にしてください。')
  if (required && !s.trim()) throw userError_(label + 'を入れてください。')
  return s
}

function checkNotifySettings_(settings) {
  if (!isPlainObject_(settings)) throw userError_('通知の設定の形が正しくありません。')
  Object.keys(settings).forEach(function (k) {
    if (NOTIFY_KINDS.indexOf(k) < 0) throw userError_('通知の種類が正しくありません。')
    if (NOTIFY_FREQUENCIES.indexOf(settings[k]) < 0) throw userError_('通知の頻度が正しくありません。')
  })
  return settings
}

function checkTimezone_(tz) {
  if (tz === undefined || tz === null || tz === '') return ''
  if (typeof tz !== 'string' || tz.length > 64 || !TIMEZONE_RE.test(tz)) throw userError_('タイムゾーンの形が正しくありません。')
  return tz
}

function checkLocale_(locale) {
  if (locale === undefined || locale === null || locale === '') return ''
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) throw userError_('表示言語の形が正しくありません。')
  return locale
}

function checkAvatar_(color, initials) {
  if (color !== undefined && color !== null && color !== '' && (typeof color !== 'string' || !AVATAR_COLOR_RE.test(color))) {
    throw userError_('アイコンの色の形が正しくありません。')
  }
  checkText_(initials, 4, 'アイコンの文字')
}

function checkEducationInfo_(body) {
  checkText_(body.university, 200, '大学名')
  checkText_(body.faculty, 200, '学部')
  checkText_(body.departmentName, 200, '学科')
  checkText_(body.gradeYear, 50, '学年')
}

function checkCustomFields_(fields) {
  if (fields === undefined || fields === null) return {}
  if (!isPlainObject_(fields)) throw userError_('カスタム列の値の形が正しくありません。')
  var keys = Object.keys(fields)
  if (keys.length > CUSTOM_FIELDS_MAX_KEYS) throw userError_('カスタム列は ' + CUSTOM_FIELDS_MAX_KEYS + ' 個までです。')
  keys.forEach(function (k) {
    if (!k || k.length > 100) throw userError_('カスタム列のキーが正しくありません。')
    var v = fields[k]
    if (v === null || v === undefined) return
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw userError_('カスタム列の値の形が正しくありません。')
    if (String(v).length > CUSTOM_FIELD_VALUE_MAX) throw userError_('カスタム列の値は ' + CUSTOM_FIELD_VALUE_MAX + ' 文字以内にしてください。')
  })
  return fields
}

// 健康状態: good / watch / attention。allowEmpty の時は空(手動の上書きを外す)も通す
function checkProjectHealth_(health, allowEmpty) {
  if ((health === '' || health === null || health === undefined) && allowEmpty) return ''
  if (PROJECT_HEALTH_LEVELS.indexOf(health) < 0) throw userError_('健康状態は good・watch・attention のどれかにしてください。')
  return health
}

function checkCandidateFields_(c, isNew) {
  if (!isPlainObject_(c)) throw userError_('候補者の項目の形が正しくありません。')
  if (isNew || c.name !== undefined) checkText_(c.name, 200, '候補者の名前', true)
  if (c.email !== undefined && c.email !== '' && c.email !== null) {
    if (typeof c.email !== 'string' || c.email.length > 254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(c.email.trim())) throw userError_('候補者のメールアドレスの形が正しくありません。')
  }
  if (c.phone !== undefined && c.phone !== '' && c.phone !== null) {
    if (typeof c.phone !== 'string' || c.phone.length > 50 || /[\r\n]/.test(c.phone)) throw userError_('候補者の電話番号は1行・50文字以内にしてください。')
  }
  checkText_(c.resumeText, CANDIDATE_TEXT_MAX, '経歴')
  checkText_(c.interviewNotes, CANDIDATE_TEXT_MAX, '面接のメモ')
  if (c.status !== undefined && CANDIDATE_STATUSES.indexOf(c.status) < 0) throw userError_('候補者の状態が正しくありません。')
}

// ---- updateSetting の値 ----

function parseSettingJson_(value, label) {
  if (typeof value !== 'string') throw userError_(label + 'の形が正しくありません。')
  try { return JSON.parse(value) } catch (e) { throw userError_(label + 'を読めませんでした。') }
}

function checkList_(v, max, label) {
  if (!Array.isArray(v)) throw userError_(label + 'の形が正しくありません。')
  if (v.length > max) throw userError_(label + 'は ' + max + ' 件までです。')
  return v
}

function checkApprovalSteps_(steps, label) {
  checkList_(steps, 20, label)
  steps.forEach(function (s) {
    if (!isPlainObject_(s)) throw userError_(label + 'の形が正しくありません。')
    checkText_(s.id, 100, label + 'の ID', true)
    if (s.type !== 'member' && s.type !== 'role') throw userError_(label + 'の種類は member か role にしてください。')
    if (s.type === 'member') checkText_(s.memberId, 100, label + 'のメンバー', true)
    if (s.type === 'role') checkText_(s.role, 100, label + 'の役職', true)
    checkText_(s.department, 200, label + 'の部署')
    if (s.requiredCount !== undefined && s.requiredCount !== null && s.requiredCount !== 'all' && s.requiredCount !== 'any') {
      if (typeof s.requiredCount !== 'number' || Math.floor(s.requiredCount) !== s.requiredCount || s.requiredCount < 1 || s.requiredCount > 100) {
        throw userError_(label + 'の必要な人数が正しくありません。')
      }
    }
  })
}

function checkCustomFormDefs_(value) {
  var defs = checkList_(parseSettingJson_(value, 'フォームの定義'), 100, 'フォームの定義')
  defs.forEach(function (d) {
    if (!isPlainObject_(d)) throw userError_('フォームの定義の形が正しくありません。')
    checkText_(d.id, 100, 'フォームの ID', true)
    checkText_(d.title, 200, 'フォームの名前')
    checkText_(d.description, 5000, 'フォームの説明')
    checkList_(d.fields || [], 100, 'フォームの項目').forEach(function (f) {
      if (!isPlainObject_(f)) throw userError_('フォームの項目の形が正しくありません。')
      checkText_(f.id, 100, '項目の ID', true)
      checkText_(f.label, 500, '項目の名前')
      if (['text', 'number', 'select', 'date'].indexOf(f.type) < 0) throw userError_('項目の種類が正しくありません。')
      if (f.options !== undefined) checkList_(f.options, 100, '項目の選択肢').forEach(function (o) { checkText_(o, 200, '選択肢') })
      if (f.required !== undefined && typeof f.required !== 'boolean') throw userError_('項目の「必須」の形が正しくありません。')
      checkText_(f.description, 2000, '項目の説明')
    })
    checkApprovalSteps_(d.approvalSteps || [], 'フォームの承認の段')
  })
}

function checkQuizDefinitions_(value) {
  var quizzes = checkList_(parseSettingJson_(value, '検定の定義'), 200, '検定の定義')
  quizzes.forEach(function (q) {
    if (!isPlainObject_(q)) throw userError_('検定の定義の形が正しくありません。')
    checkText_(q.id, 100, '検定の ID', true)
    checkText_(q.title, 200, '検定の名前')
    checkText_(q.targetSkill, 100, '検定のスキル')
    if (q.targetLevel !== undefined && [1, 2, 3, 4, 5].indexOf(q.targetLevel) < 0) throw userError_('検定の目標のレベルは 1〜5 にしてください。')
    if (q.passRate !== undefined && (typeof q.passRate !== 'number' || !(q.passRate >= 0 && q.passRate <= 100))) throw userError_('検定の合格ラインは 0〜100 にしてください。')
    checkList_(q.questions || [], 200, '検定の設問').forEach(function (question) {
      if (!isPlainObject_(question)) throw userError_('検定の設問の形が正しくありません。')
      checkText_(question.id, 100, '設問の ID')
      checkText_(question.text, 5000, '設問の文')
      var choices = checkList_(question.choices || [], 20, '設問の選択肢')
      choices.forEach(function (c) { checkText_(c, 1000, '選択肢') })
      if (question.correctIndex !== undefined) {
        var ci = question.correctIndex
        if (typeof ci !== 'number' || Math.floor(ci) !== ci || ci < 0 || ci >= Math.max(choices.length, 1)) throw userError_('設問の正解の番号が正しくありません。')
      }
    })
  })
}

function checkRecurringRules_(value) {
  var rules = checkList_(parseSettingJson_(value, '定期タスクの規則'), 200, '定期タスクの規則')
  rules.forEach(function (r) {
    if (!isPlainObject_(r)) throw userError_('定期タスクの規則の形が正しくありません。')
    checkText_(r.id, 100, '規則の ID', true)
    checkText_(r.name, 200, '定期タスクの名前')
    checkText_(r.projectId, 100, '定期タスクのプロジェクト')
    ;['department', 'category', 'difficulty', 'priority', 'triggerOnStatus'].forEach(function (k) { checkText_(r[k], 100, '定期タスクの項目') })
    if (r.skills !== undefined) checkList_(r.skills, 50, '定期タスクのスキル').forEach(function (s) { checkText_(s, 100, 'スキル') })
    if (r.frequency !== undefined && ['weekly', 'monthly'].indexOf(r.frequency) < 0) throw userError_('定期タスクの頻度は weekly か monthly にしてください。')
    var intIn = function (v, lo, hi, label) {
      if (v === undefined || v === null || v === '') return
      if (typeof v !== 'number' || Math.floor(v) !== v || v < lo || v > hi) throw userError_(label + 'が正しくありません。')
    }
    intIn(r.dayOfWeek, 0, 6, '曜日')
    intIn(r.dayOfMonth, 1, 31, '日にち')
    intIn(r.dueInDays, 0, 3650, '期限までの日数')
    if (r.active !== undefined && typeof r.active !== 'boolean') throw userError_('定期タスクの「有効」の形が正しくありません。')
    if (r.lastGeneratedDate !== undefined && r.lastGeneratedDate !== '') checkDate_(r.lastGeneratedDate, '最後に作った日')
    if (r.skipDates !== undefined) checkList_(r.skipDates, 366, '作らない日').forEach(function (d) { checkDate_(d, '作らない日') })
  })
}

// スキルのレベルの決め方: 形が正しいか(壊れた部分を捨てる parseSkillLevelRules_ より厳しく、知らない条件は断る)
function checkSkillLevelRules_(value) {
  var obj = parseSettingJson_(value, 'スキルのレベルの決め方')
  if (!isPlainObject_(obj)) throw userError_('スキルのレベルの決め方の形が正しくありません。')
  var rule = function (r) {
    if (!isPlainObject_(r)) throw userError_('スキルのレベルの決め方の形が正しくありません。')
    if (r.points !== undefined && !validLevelPoints_(r.points)) throw userError_('レベルの点数は、増えていく5つの整数にしてください。')
    if (r.conditions !== undefined) {
      if (!isPlainObject_(r.conditions)) throw userError_('レベルの条件の形が正しくありません。')
      Object.keys(r.conditions).forEach(function (l) {
        if (['1', '2', '3', '4', '5'].indexOf(l) < 0) throw userError_('レベルは 1〜5 にしてください。')
        checkList_(r.conditions[l], 10, 'レベルの条件').forEach(function (c) {
          if (!validLevelCondition_(c)) throw userError_('レベルの条件が正しくありません。')
        })
      })
    }
  }
  if (obj['default'] !== undefined) rule(obj['default'])
  if (obj.skills !== undefined) {
    if (!isPlainObject_(obj.skills)) throw userError_('スキルごとの決め方の形が正しくありません。')
    var names = Object.keys(obj.skills)
    if (names.length > 500) throw userError_('スキルごとの決め方は 500 件までです。')
    names.forEach(function (n) { rule(obj.skills[n]) })
  }
}

// 稼働の目安の決め方(lib/ohsumi/workload-rules.ts の WORKLOAD_RULE_RANGES と同じ範囲)。
// 書いていない項目は既定のまま。知らない項目・範囲の外・full_ratio が available_ratio 以下は断る
var WORKLOAD_RULE_RANGES = {
  available_ratio: { min: 0.05, max: 5, label: '「余力あり」の上限' },
  full_ratio: { min: 0.1, max: 10, label: '「余力なし」の下限' },
  window_days: { min: 14, max: 365, integer: true, label: '普段のペースを数える期間' },
  fallback_hours: { min: 0.5, max: 40, label: '想定時間が空のタスクの時間' },
  no_history_normal_max_hours: { min: 0, max: 200, label: '完了したタスクが無い人の「普通」の上限' },
  low_workload_task_threshold: { min: 0, max: 10, integer: true, label: '低稼働を知らせるタスクの件数' },
}
var WORKLOAD_RULE_DEFAULTS = { available_ratio: 0.6, full_ratio: 1.2 }

function checkWorkloadRules_(value) {
  var obj = parseSettingJson_(value, '稼働の目安の決め方')
  if (!isPlainObject_(obj)) throw userError_('稼働の目安の決め方の形が正しくありません。')
  Object.keys(obj).forEach(function (k) {
    if (k === 'count_hold_and_review') {
      if (typeof obj[k] !== 'boolean') throw userError_('「保留・確認待ちを含める」の形が正しくありません。')
      return
    }
    var r = WORKLOAD_RULE_RANGES[k]
    if (!r) throw userError_('稼働の目安の決め方に、知らない項目があります。')
    var v = obj[k]
    if (typeof v !== 'number' || !isFinite(v) || (r.integer && Math.floor(v) !== v) || v < r.min || v > r.max) {
      throw userError_(r.label + 'は ' + r.min + '〜' + r.max + (r.integer ? ' の整数' : '') + ' にしてください。')
    }
  })
  var available = obj.available_ratio !== undefined ? obj.available_ratio : WORKLOAD_RULE_DEFAULTS.available_ratio
  var full = obj.full_ratio !== undefined ? obj.full_ratio : WORKLOAD_RULE_DEFAULTS.full_ratio
  if (!(full > available)) throw userError_('「余力なし」の下限は、「余力あり」の上限より大きくしてください。')
}

// updateSetting の値を、キーごとに確かめる(空の値は「設定を消す」なので通す)
var SETTING_VALUE_CHECKS = {
  custom_form_defs: checkCustomFormDefs_,
  quiz_definitions: checkQuizDefinitions_,
  recurring_rules: checkRecurringRules_,
  skill_level_rules: checkSkillLevelRules_,
  workload_rules: checkWorkloadRules_,
  member_field_visibility: checkMemberFieldVisibility_,
  org_storage_access: checkOrgStorageAccess_,
}

function checkSettingValue_(key, value) {
  var check = SETTING_VALUE_CHECKS[key]
  if (!check || value === '' || value === null || value === undefined) return
  check(value)
}
