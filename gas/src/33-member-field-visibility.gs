
// ---- 人材データの項目ごとの閲覧範囲 ---------------------------------------------
//
// Settings の member_field_visibility に {列名: 範囲} の JSON を入れると、その列の閲覧範囲を変える
// (READ_POLICY の Members の規則を、閲覧者ごとに上書きする)。設定の無い列は、今までどおり READ_POLICY の規則。
// 設定できるのは代表・全権管理者だけ(updateSetting の権限)。範囲は次の4つ:
//   all         ログインしている全員
//   supervisor  本人・代表・その人を見る立場の人(報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者)
//   admin       本人と、一般以外の役職
//   self        本人だけ
// 評価・1on1・育成計画・キャリアの希望・アンケートの回答は、「見る立場の人」より広くできない
// (MEMBER_FIELD_NARROW_ONLY。広い範囲が保存されていても、今までどおりの範囲で返す)。
// 管理用の列(id・名前・役職・通知の設定・権限の上書き など)は、この設定では変えない。
var MEMBER_FIELD_VISIBILITY_KEY = 'member_field_visibility'
var MEMBER_FIELD_VISIBILITY_RULES = { all: 'all', supervisor: 'selfOrSupervisor', admin: 'selfOrAdminRole', self: 'self' }
var MEMBER_FIELD_VISIBILITY_COLUMNS = [
  'will_tags', 'judgment_tags', 'joined_at', 'department_path', 'unavailable_dates', 'absent_dates',
  'available_hours_json', 'skill_levels_json', 'timezone', 'mentor_id', 'has_management_experience',
  'desired_areas', 'desired_skills', 'career_history_json', 'qualifications_json', 'quiz_passes_json',
  'evaluation_history_json', 'transfer_history_json', 'competencies_json', 'training_history_json',
  'development_plan_json', 'one_on_ones_json', 'career_aspiration', 'desired_future_role', 'career_plan',
  'university', 'faculty', 'department_name', 'grade_year', 'custom_fields_json', 'skill_points_json',
  'survey_responses_json', 'last_login', 'skill_approvals_json',
]
var MEMBER_FIELD_NARROW_ONLY = [
  'evaluation_history_json', 'one_on_ones_json', 'development_plan_json',
  'career_aspiration', 'desired_future_role', 'career_plan', 'survey_responses_json',
]

// 保存された設定(JSON の文字列)を、列ごとの規則にする。読めない値・決まった範囲でない値・
// 狭めることしかできない列を広げる値は使わない(今までどおりの規則になる)
function memberColumnRulesFromValue_(value) {
  var out = {}
  var parsed
  try { parsed = typeof value === 'string' ? (value ? JSON.parse(value) : null) : value } catch (e) { return out }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  Object.keys(parsed).forEach(function (col) {
    if (MEMBER_FIELD_VISIBILITY_COLUMNS.indexOf(col) < 0) return
    var level = parsed[col]
    if (!Object.prototype.hasOwnProperty.call(MEMBER_FIELD_VISIBILITY_RULES, level)) return
    if (MEMBER_FIELD_NARROW_ONLY.indexOf(col) >= 0 && level !== 'supervisor' && level !== 'self') return
    out[col] = MEMBER_FIELD_VISIBILITY_RULES[level]
  })
  return out
}

function memberColumnRulesFromSnapshot_(data) {
  var settings = data.Settings || { headers: [], rows: [] }
  var keyCol = (settings.headers || []).indexOf('key')
  var valueCol = (settings.headers || []).indexOf('value')
  if (keyCol < 0 || valueCol < 0) return {}
  for (var i = 0; i < (settings.rows || []).length; i++) {
    if (String(settings.rows[i][keyCol]) === MEMBER_FIELD_VISIBILITY_KEY) return memberColumnRulesFromValue_(settings.rows[i][valueCol])
  }
  return {}
}

// updateSetting で保存する前に確かめる(おかしな値は保存しない)
function checkMemberFieldVisibility_(value) {
  if (value === '' || value === null || value === undefined) return
  var parsed
  try { parsed = JSON.parse(String(value)) } catch (e) { throw userError_('項目ごとの閲覧範囲の設定を読めませんでした。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw userError_('項目ごとの閲覧範囲の設定の形が正しくありません。')
  Object.keys(parsed).forEach(function (col) {
    if (MEMBER_FIELD_VISIBILITY_COLUMNS.indexOf(col) < 0) throw userError_('閲覧範囲を設定できない項目です: ' + String(col).slice(0, 60))
    var level = parsed[col]
    if (!Object.prototype.hasOwnProperty.call(MEMBER_FIELD_VISIBILITY_RULES, level)) throw userError_('閲覧範囲は 全員・見る立場の人・管理者・本人 のどれかにしてください。')
    if (MEMBER_FIELD_NARROW_ONLY.indexOf(col) >= 0 && level !== 'supervisor' && level !== 'self') {
      throw userError_('評価・1on1・育成計画・キャリアの希望・アンケートの回答は、見る立場の人より広くできません。')
    }
  })
}
