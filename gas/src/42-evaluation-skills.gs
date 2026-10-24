// ---- 評価をスキルの根拠にする(v1.2) -----------------------------------------------------
//
// 評価(Members の evaluation_history_json。行に移した後は MemberRecords)の1件に、スキルの見立て
// skillAssessments: [{ skill, level(1〜5), points(0〜上限の整数), note?, at }] を付けられる。
//   ・点数: 付けた点数を、その人のスキルの点数(skill_points_json)に足す。評価を消すと、その分を引く(0 より下にしない)
//   ・根拠: 見立ては、レベルの条件「承認」(skill_level_rules の {type:'approval'})に数える(スキルをそのレベル以上と見た記録)
//   ・レベル: 点数と条件から決め直す。保存されたレベルは下げない(評価を消しても下げない)
// 付けられるのは、代表と、その人を見る立場の人(上長・部署長・メンター・プロジェクトの責任者)だけ。自分自身には付けられない。
// 上限は団体の設定 evaluation_skill_rules({ maxPoints, cooldownDays })で変えられる:
//   maxPoints    1回の評価で、1つのスキルに付けられる点数の上限(既定 100。0〜1000)
//   cooldownDays 同じ人が、同じ相手の同じスキルに付けられるのは、この日数に1回(既定 30。0 で制限なし。0〜365)
// 見立ては、付けた後は変えられない(変える時は、評価を消して付け直す)。at は画面が付けた日時で、
// 新しく付ける時は GAS の今の時刻と1日以内のずれだけ受け付ける(日数の制限は、保存された at と今の時刻で数える)
var EVALUATION_SKILL_DEFAULTS = { maxPoints: 100, cooldownDays: 30 }
var EVALUATION_SKILLS_MAX = 20
var EVALUATION_SKILL_NOTE_MAX = 500
var EVALUATION_SKILL_AT_SKEW_MS = 24 * 60 * 60 * 1000

// 設定の値を、使える形にする(壊れた値・範囲の外は既定)
function parseEvaluationSkillRules_(raw) {
  var obj = raw
  if (typeof raw === 'string') {
    try { obj = raw ? JSON.parse(raw) : {} } catch (e) { obj = {} }
  }
  var out = { maxPoints: EVALUATION_SKILL_DEFAULTS.maxPoints, cooldownDays: EVALUATION_SKILL_DEFAULTS.cooldownDays }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  var mp = obj.maxPoints, cd = obj.cooldownDays
  if (typeof mp === 'number' && Math.floor(mp) === mp && mp >= 0 && mp <= 1000) out.maxPoints = mp
  if (typeof cd === 'number' && Math.floor(cd) === cd && cd >= 0 && cd <= 365) out.cooldownDays = cd
  return out
}

function getEvaluationSkillRules_() {
  return parseEvaluationSkillRules_(getSettingValue_('evaluation_skill_rules'))
}

// updateSetting の値の確かめ(37-value-checks.gs の SETTING_VALUE_CHECKS)
function checkEvaluationSkillRules_(value) {
  var obj = parseSettingJson_(value, '評価のスキルの上限')
  if (!isPlainObject_(obj)) throw userError_('評価のスキルの上限の形が正しくありません。')
  Object.keys(obj).forEach(function (k) {
    var v = obj[k]
    if (k === 'maxPoints') {
      if (typeof v !== 'number' || Math.floor(v) !== v || v < 0 || v > 1000) throw userError_('1回に付けられる点数の上限は 0〜1000 の整数にしてください。')
    } else if (k === 'cooldownDays') {
      if (typeof v !== 'number' || Math.floor(v) !== v || v < 0 || v > 365) throw userError_('同じスキルに付け直せるまでの日数は 0〜365 の整数にしてください。')
    } else {
      throw userError_('評価のスキルの上限に、知らない項目があります。')
    }
  })
}

// その人のスキルを見立て・認められるか(代表と、上長・部署長・メンター・プロジェクトの責任者。自分自身は不可)
function canAssessSkillOf_(acting, memberId) {
  if (String(acting.id) === String(memberId)) return false
  if (isTopRoleRef_(getRoles_(), acting.role)) return true
  var data = {
    Members: snapshotTableOrSheet_(SHEET_MEMBERS),
    Projects: snapshotTableOrSheet_(SHEET_PROJECTS),
    Settings: snapshotTableOrSheet_(SHEET_SETTINGS),
  }
  var rel = viewerRelations_(data, String(acting.id))
  var id = String(memberId)
  return !!(rel.boss[id] || rel.deptHead[id] || rel.mentor[id] || rel.projectOwner[id])
}

function assessmentsOf_(entry) {
  return entry && Array.isArray(entry.skillAssessments) ? entry.skillAssessments : []
}

// 評価の一覧に付いた見立てを、レベルの条件「承認」の形({ skill, level })にする
function evaluationApprovals_(entries) {
  var out = []
  ;(entries || []).forEach(function (e) {
    assessmentsOf_(e).forEach(function (a) {
      if (a && typeof a.skill === 'string' && typeof a.level === 'number') out.push({ skill: a.skill, level: a.level, byId: String(e.evaluatorId || ''), at: a.at })
    })
  })
  return out
}

// 新しい評価に付いた見立てを確かめる(形・点数の上限・付けられる人・日数の制限)
function checkNewAssessments_(memberId, entry, acting, stored, rules, now) {
  var list = entry.skillAssessments
  if (list === undefined || list === null) return
  if (!Array.isArray(list) || list.length > EVALUATION_SKILLS_MAX) throw userError_('スキルの見立ての形が正しくありません(1件の評価に' + EVALUATION_SKILLS_MAX + 'スキルまで)。')
  if (!list.length) { delete entry.skillAssessments; return }
  if (!canAssessSkillOf_(acting, memberId)) throw userError_('評価にスキルを付けられるのは、代表と、その人を見る立場の人(上長・部署長・メンター・プロジェクトの責任者)だけです。')
  var seen = {}
  list.forEach(function (a) {
    if (!isPlainObject_(a)) throw userError_('スキルの見立ての形が正しくありません。')
    Object.keys(a).forEach(function (k) {
      if (['skill', 'level', 'points', 'note', 'at'].indexOf(k) < 0) throw userError_('スキルの見立てに、知らない項目があります。')
    })
    var skill = typeof a.skill === 'string' ? a.skill.trim() : ''
    if (!skill || skill.length > 100 || skill !== a.skill) throw userError_('スキルの名前を100文字以内で入れてください。')
    if (seen[skill]) throw userError_('同じスキルが2回入っています: ' + skill)
    seen[skill] = true
    if ([1, 2, 3, 4, 5].indexOf(a.level) < 0) throw userError_('スキルのレベルは 1〜5 で入れてください。')
    if (typeof a.points !== 'number' || Math.floor(a.points) !== a.points || a.points < 0) throw userError_('スキルの点数は0以上の整数で入れてください。')
    if (a.points > rules.maxPoints) throw userError_('1回の評価で付けられる点数は、スキルごとに' + rules.maxPoints + '点までです。')
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > EVALUATION_SKILL_NOTE_MAX)) throw userError_('見立ての理由は' + EVALUATION_SKILL_NOTE_MAX + '文字以内にしてください。')
    var at = typeof a.at === 'string' ? Date.parse(a.at) : NaN
    if (!isFinite(at) || Math.abs(at - now) > EVALUATION_SKILL_AT_SKEW_MS) throw userError_('スキルの見立ての日時が正しくありません。端末の時計を確かめて、もう一度保存してください。')
    if (rules.cooldownDays > 0) {
      var since = now - rules.cooldownDays * 24 * 60 * 60 * 1000
      var recent = stored.some(function (e) {
        if (String(e.evaluatorId || '') !== String(acting.id)) return false
        return assessmentsOf_(e).some(function (s) { return s && s.skill === skill && Date.parse(s.at) > since })
      })
      if (recent) throw userError_('「' + skill + '」には、' + rules.cooldownDays + '日以内にスキルを付けています。同じ相手の同じスキルに付けられるのは、' + rules.cooldownDays + '日に1回です。')
    }
  })
}

/**
 * updateEvaluationHistory の一覧(差分を当てた後)を確かめ、見立ての点数をスキルの点数に足し引きする。
 * 返すのは、評価の列と一緒に書く列(点数・レベル。変わらなければ空)
 */
function applyEvaluationSkills_(memberId, entries, acting) {
  var stored = memberJsonList_(memberId, 'evaluation_history_json')
  var storedById = {}
  stored.forEach(function (e) { if (e && e.id) storedById[e.id] = e })
  var rules = getEvaluationSkillRules_()
  var now = Date.now()
  var delta = {}
  var add = function (skill, n) { delta[skill] = (delta[skill] || 0) + n }
  var keptIds = {}
  entries.forEach(function (e) {
    var before = storedById[e.id]
    if (before) {
      keptIds[e.id] = true
      // 付けた見立ては変えられない(消す・足す・書き換えるのは、評価を消して付け直す)
      if (canonicalJson_(assessmentsOf_(before)) !== canonicalJson_(assessmentsOf_(e))) throw userError_('評価に付けたスキルは変えられません。変える時は、評価を消して付け直してください。')
      return
    }
    checkNewAssessments_(memberId, e, acting, stored, rules, now)
    assessmentsOf_(e).forEach(function (a) { add(a.skill, a.points) })
  })
  stored.forEach(function (e) {
    if (!e || !e.id || keptIds[e.id]) return
    assessmentsOf_(e).forEach(function (a) { if (a && typeof a.points === 'number') add(a.skill, -a.points) })
  })
  var hadAssessments = entries.some(function (e) { return assessmentsOf_(e).length }) || stored.some(function (e) { return assessmentsOf_(e).length })
  if (!hadAssessments) return {}
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません。')
  var points = {}
  try { points = JSON.parse(memberRow.skill_points_json || '{}') || {} } catch (e) { points = {} }
  Object.keys(delta).forEach(function (skill) {
    if (!delta[skill]) return
    points[skill] = Math.max(0, (Number(points[skill]) || 0) + delta[skill])
  })
  var evidence = skillEvidenceOf_(memberRow, memberId)
  evidence.approvals = parseJsonListSafe_(memberRow.skill_approvals_json).concat(evaluationApprovals_(entries))
  var newLevels = computeAutoLevels_(parseJsonListSafe_(memberRow.skill_levels_json), points, getSkillLevelRules_(), evidence)
  return { skill_points_json: JSON.stringify(points), skill_levels_json: JSON.stringify(newLevels) }
}
