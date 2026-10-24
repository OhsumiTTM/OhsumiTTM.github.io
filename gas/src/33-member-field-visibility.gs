// ---- 人材データの項目ごとの公開範囲 ---------------------------------------------
//
// Settings の member_field_visibility に {項目: 範囲} の JSON を入れると、その項目を誰に返すかを変える
// (READ_POLICY の Members の規則を、閲覧者ごとに上書きする)。設定の無い項目は、今までどおり READ_POLICY の規則。
// 設定できるのは団体のルール(org.rules)の人(updateSetting の権限)。
//
// 項目:
//   Members の列(MEMBER_FIELD_VISIBILITY_COLUMNS)
//   custom:<キー>   団体が足した独自の項目(custom_fields_json の中の1つのキー。設定の無いキーは custom_fields_json の範囲)
//   daily_reports   日報・週報(fetchDailyReports_。日報を見る権限の人〈一般以外の役職・権限の例外〉は、いつもすべて見られる)
//
// 範囲(v1.2〜): 見せる相手の配列。本人はいつも見られる。空の配列は「本人だけ」
//   boss          上長: 報告先(reports_to_id)をたどった上の人
//   deptHead      部署長: その人の所属の部署(とその上の部署)の長(department_tree_config の headIds)
//   mentor        その人のメンター
//   projectOwner  その人が入るプロジェクト(と子プロジェクト)の責任者
//   leaders       幹部: 一般以外の役職
//   all           ログインしている全員
// 代表(最上位の役職)は「本人だけ」以外の項目をいつも見られる。
// 以前の範囲(文字列)は、同じ意味の組み合わせとして読む:
//   all → [all] / supervisor → [boss, mentor, projectOwner] / admin → [leaders] / self → [](本人だけ)
// 評価・1on1・育成計画・キャリアの希望・アンケートの回答は、狭めるだけ(MEMBER_FIELD_NARROW_ONLY。幹部・全員は選べない。
// 保存されていても使わず、今までどおりの範囲で返す)。管理用の列(id・名前・役職・通知の設定・権限の上書き など)は対象にしない。
var MEMBER_FIELD_VISIBILITY_KEY = 'member_field_visibility'
var FIELD_AUDIENCES = ['boss', 'deptHead', 'mentor', 'projectOwner', 'leaders', 'all']
var LEGACY_FIELD_AUDIENCES = { all: ['all'], supervisor: ['boss', 'mentor', 'projectOwner'], admin: ['leaders'], self: [] }
var NARROW_ONLY_FORBIDDEN_AUDIENCES = ['leaders', 'all']
var CUSTOM_FIELD_AUDIENCE_PREFIX = 'custom:'
var DAILY_REPORTS_AUDIENCE_KEY = 'daily_reports'
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

// 設定できる項目か
function isFieldAudienceKey_(key) {
  key = String(key || '')
  if (MEMBER_FIELD_VISIBILITY_COLUMNS.indexOf(key) >= 0 || key === DAILY_REPORTS_AUDIENCE_KEY) return true
  if (key.indexOf(CUSTOM_FIELD_AUDIENCE_PREFIX) !== 0) return false
  var custom = key.slice(CUSTOM_FIELD_AUDIENCE_PREFIX.length)
  return custom.length > 0 && custom.length <= 100
}

// 1つの項目の範囲を、規則({ audiences: {相手: true}, selfOnly })にする。使えない値は null(今までどおりの範囲)
function fieldAudienceRule_(key, level) {
  var list = typeof level === 'string' ? LEGACY_FIELD_AUDIENCES[level] : level
  if (!Array.isArray(list)) return null
  var audiences = {}
  for (var i = 0; i < list.length; i++) {
    var a = String(list[i])
    if (FIELD_AUDIENCES.indexOf(a) < 0) return null
    if (MEMBER_FIELD_NARROW_ONLY.indexOf(key) >= 0 && NARROW_ONLY_FORBIDDEN_AUDIENCES.indexOf(a) >= 0) return null
    audiences[a] = true
  }
  return { audiences: audiences, selfOnly: list.length === 0 }
}

// 保存された設定(JSON の文字列)を、項目ごとの規則にする。読めない値・決まった範囲でない値・
// 狭めることしかできない項目を広げる値は使わない(今までどおりの規則になる)
function memberColumnRulesFromValue_(value) {
  var out = {}
  var parsed
  try { parsed = typeof value === 'string' ? (value ? JSON.parse(value) : null) : value } catch (e) { return out }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  Object.keys(parsed).forEach(function (key) {
    if (!isFieldAudienceKey_(key)) return
    var rule = fieldAudienceRule_(key, parsed[key])
    if (rule) out[key] = rule
  })
  return out
}

function memberColumnRulesFromSnapshot_(data) {
  var value = settingValueOfSnapshot_(data, MEMBER_FIELD_VISIBILITY_KEY)
  return value === null ? {} : memberColumnRulesFromValue_(value)
}

function settingValueOfSnapshot_(data, key) {
  var settings = data.Settings || { headers: [], rows: [] }
  var keyCol = (settings.headers || []).indexOf('key')
  var valueCol = (settings.headers || []).indexOf('value')
  if (keyCol < 0 || valueCol < 0) return null
  for (var i = 0; i < (settings.rows || []).length; i++) {
    if (String(settings.rows[i][keyCol]) === key) return settings.rows[i][valueCol]
  }
  return null
}

// 規則で、閲覧者がその人(ownerId)の項目を見られるか
function fieldAudienceAllows_(rule, viewer, ownerId) {
  if (ownerId && ownerId === viewer.id) return true
  if (rule.selfOnly) return false
  if (viewer.isTop) return true
  var a = rule.audiences
  var rel = viewer.relations || {}
  if (a.all) return true
  if (a.leaders && viewer.isAdminRole) return true
  if (a.boss && rel.boss && rel.boss[ownerId]) return true
  if (a.deptHead && rel.deptHead && rel.deptHead[ownerId]) return true
  if (a.mentor && rel.mentor && rel.mentor[ownerId]) return true
  if (a.projectOwner && rel.projectOwner && rel.projectOwner[ownerId]) return true
  return false
}

// 部署のパス("A>B>C")を、前後の空白を除いた区切りの配列にする
function departmentPathParts_(path) {
  return String(path || '').split('>').map(function (s) { return s.trim() }).filter(Boolean)
}

// 部署長: 閲覧者が長の部署(とその下の部署)に所属するメンバーの ID
function deptHeadMemberIds_(data, viewerId) {
  var out = {}
  if (!viewerId) return out
  var raw = settingValueOfSnapshot_(data, 'department_tree_config')
  var nodes
  try { nodes = raw ? JSON.parse(String(raw)) : [] } catch (e) { nodes = [] }
  if (!Array.isArray(nodes)) return out
  var headed = []
  nodes.forEach(function (n) {
    if (!n || !Array.isArray(n.headIds) || n.headIds.map(String).indexOf(viewerId) < 0) return
    var parts = departmentPathParts_(n.path)
    if (parts.length) headed.push(parts)
  })
  if (!headed.length) return out
  var members = data.Members || { headers: [], rows: [] }
  var idCol = (members.headers || []).indexOf('id')
  var pathCol = (members.headers || []).indexOf('department_path')
  if (idCol < 0 || pathCol < 0) return out
  ;(members.rows || []).forEach(function (r) {
    var id = String(r[idCol] || '')
    if (!id) return
    String(r[pathCol] || '').split(',').forEach(function (p) {
      var parts = departmentPathParts_(p)
      var under = headed.some(function (h) {
        if (parts.length < h.length) return false
        for (var i = 0; i < h.length; i++) if (parts[i] !== h[i]) return false
        return true
      })
      if (under) out[id] = true
    })
  })
  return out
}

// 閲覧者とメンバーの関係(上長・部署長・メンター・プロジェクトの責任者)
function viewerRelations_(data, viewerId) {
  var out = { boss: {}, deptHead: deptHeadMemberIds_(data, viewerId), mentor: {}, projectOwner: {} }
  if (!viewerId) return out
  var members = data.Members || { headers: [], rows: [] }
  var mh = members.headers || []
  var idCol = mh.indexOf('id'), repCol = mh.indexOf('reports_to_id'), mentorCol = mh.indexOf('mentor_id')
  var reportsTo = {}
  ;(members.rows || []).forEach(function (r) {
    var id = String(r[idCol] || '')
    if (!id) return
    reportsTo[id] = repCol >= 0 ? String(r[repCol] || '') : ''
    if (mentorCol >= 0 && String(r[mentorCol] || '') === viewerId) out.mentor[id] = true
  })
  Object.keys(reportsTo).forEach(function (id) {
    var cur = reportsTo[id]
    for (var hop = 0; cur && hop < 20; hop++) {
      if (cur === viewerId) { out.boss[id] = true; break }
      cur = reportsTo[cur]
    }
  })
  out.projectOwner = projectOwnerMemberIds_(data, viewerId)
  return out
}

// 閲覧者が責任者(owner_id)のプロジェクト(その子プロジェクトも含む)に入っているメンバーの ID
function projectOwnerMemberIds_(data, viewerId) {
  var out = {}
  var projects = data.Projects || { headers: [], rows: [] }
  var ph = projects.headers || []
  var pid = ph.indexOf('id'), owner = ph.indexOf('owner_id'), mem = ph.indexOf('member_ids'), parent = ph.indexOf('parent_id')
  if (pid < 0 || owner < 0 || mem < 0) return out
  var byId = {}, children = {}
  ;(projects.rows || []).forEach(function (r) {
    var id = String(r[pid] || '')
    if (!id) return
    byId[id] = r
    var p = parent >= 0 ? String(r[parent] || '') : ''
    if (p) (children[p] = children[p] || []).push(id)
  })
  var stack = Object.keys(byId).filter(function (id) { return String(byId[id][owner] || '') === viewerId })
  var seen = {}
  while (stack.length) {
    var cur = stack.pop()
    if (seen[cur]) continue
    seen[cur] = true
    splitCsvList_(byId[cur][mem]).forEach(function (m) { out[m] = true })
    ;(children[cur] || []).forEach(function (c) { stack.push(c) })
  }
  return out
}

// 独自の項目(custom_fields_json)を、キーごとの範囲で絞る。設定の無いキーは、列の範囲(columnAllowed)に従う。
// 見られるキーが無ければ ''
function filterCustomFieldsForViewer_(value, rules, viewer, ownerId, columnAllowed) {
  var obj
  try { obj = typeof value === 'string' ? (value ? JSON.parse(value) : null) : value } catch (e) { obj = null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return columnAllowed ? value : ''
  var out = {}
  var any = false
  Object.keys(obj).forEach(function (k) {
    var rule = rules[CUSTOM_FIELD_AUDIENCE_PREFIX + k]
    var ok = rule ? fieldAudienceAllows_(rule, viewer, ownerId) : columnAllowed
    if (ok) { out[k] = obj[k]; any = true }
  })
  return any ? JSON.stringify(out) : ''
}

// updateSetting で保存する前に確かめる(おかしな値は保存しない)
function checkMemberFieldVisibility_(value) {
  if (value === '' || value === null || value === undefined) return
  var parsed
  try { parsed = JSON.parse(String(value)) } catch (e) { throw userError_('項目ごとの公開範囲の設定を読めませんでした。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw userError_('項目ごとの公開範囲の設定の形が正しくありません。')
  var keys = Object.keys(parsed)
  if (keys.length > 300) throw userError_('項目ごとの公開範囲の設定が多すぎます。')
  keys.forEach(function (key) {
    if (!isFieldAudienceKey_(key)) throw userError_('公開範囲を設定できない項目です: ' + String(key).slice(0, 60))
    var level = parsed[key]
    var list = typeof level === 'string' ? LEGACY_FIELD_AUDIENCES[level] : level
    if (!Array.isArray(list) || list.length > FIELD_AUDIENCES.length) throw userError_('公開範囲は、見せる相手(上長・部署長・メンター・プロジェクトの責任者・幹部・全員)の一覧にしてください。')
    list.forEach(function (a) {
      if (FIELD_AUDIENCES.indexOf(String(a)) < 0) throw userError_('公開範囲に、知らない相手があります: ' + String(a).slice(0, 30))
      if (MEMBER_FIELD_NARROW_ONLY.indexOf(key) >= 0 && NARROW_ONLY_FORBIDDEN_AUDIENCES.indexOf(String(a)) >= 0) {
        throw userError_('評価・1on1・育成計画・キャリアの希望・アンケートの回答は、幹部・全員に見せられません。')
      }
    })
  })
}

// 部署のツリーの設定(department_tree_config)を確かめる。部署長(headIds)はメンバーの ID の一覧
function checkDepartmentTreeConfig_(value) {
  var parsed
  try { parsed = JSON.parse(String(value)) } catch (e) { throw userError_('部署のツリーの設定を読めませんでした。') }
  if (!Array.isArray(parsed)) throw userError_('部署のツリーの設定の形が正しくありません。')
  if (parsed.length > 500) throw userError_('部署は 500 個までです。')
  parsed.forEach(function (n) {
    if (!isPlainObject_(n) || typeof n.path !== 'string' || !n.path.trim() || n.path.length > 300) throw userError_('部署のパスが正しくありません。')
    if (n.label !== undefined && (typeof n.label !== 'string' || n.label.length > 100)) throw userError_('部署の表示名は 100 文字以内にしてください。')
    if (n.headIds !== undefined) {
      if (!Array.isArray(n.headIds) || n.headIds.length > 20) throw userError_('部署長は1つの部署に 20 人までです。')
      n.headIds.forEach(function (id) {
        if (typeof id !== 'string' || !id || id.length > 64) throw userError_('部署長の指定が正しくありません。')
      })
    }
  })
}
