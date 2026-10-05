// ---- スキルのレベルの決め方(PR Z) ----------------------------------------------
//
// 画面(lib/ohsumi/skill-levels.ts)と同じ決まり(lib/ohsumi/skill-levels.test.ts が、同じ入力で同じ結果になることを確かめる)。
// レベル L になるのは、累計の点数がそのレベルの点数以上で、そのレベルの条件をすべて満たした時(満たすうちで、いちばん高いレベル)。
//   点数: スキルごとの一覧 → 団体の既定の一覧 → 組み込みの [50, 150, 350, 550, 750]
//   条件: レベルごとに、スキルごと → 団体の既定 → 組み込み(Lv.4: 関連する資格1件以上・Lv.5: 外部評価の資格3件以上)
//   条件の種類: qualification(資格 min 件以上。external で外部評価だけ)・quiz(このスキル・このレベル以上の検定に合格)・
//               tasksDone(このスキルを含む、担当して完了したタスクが min 件以上)・
//               approval(見る立場の人・代表が、このスキルをこのレベル以上と認めている。approveSkillLevel)
// 設定は Settings の skill_level_rules(代表・全権管理者が設定の画面で変える)。以前の skill_level_thresholds は使わない。
// 保存されたレベルは下げない(上がる時だけ書き換える)
var BUILTIN_LEVEL_POINTS = [50, 150, 350, 550, 750]
var BUILTIN_LEVEL_CONDITIONS = {
  '4': [{ type: 'qualification', min: 1 }],
  '5': [{ type: 'qualification', min: 3, external: true }],
}

function validLevelPoints_(v) {
  if (!Array.isArray(v) || v.length !== 5) return false
  for (var i = 0; i < 5; i++) {
    var n = v[i]
    if (typeof n !== 'number' || Math.floor(n) !== n || n < 0 || n > 1000000) return false
    if (i > 0 && n <= v[i - 1]) return false
  }
  return true
}

function validLevelCondition_(c) {
  if (!c || typeof c !== 'object') return false
  if (c.type === 'quiz' || c.type === 'approval') return true
  if (c.type === 'qualification' || c.type === 'tasksDone') return typeof c.min === 'number' && Math.floor(c.min) === c.min && c.min >= 1 && c.min <= 1000
  return false
}

// 設定の JSON を、使える形だけにする(壊れた部分は捨てる)
function parseSkillLevelRules_(raw) {
  var obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}') } catch (e) { obj = {} }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  var rule = function (r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null
    var out = {}
    if (validLevelPoints_(r.points)) out.points = r.points.slice()
    if (r.conditions && typeof r.conditions === 'object' && !Array.isArray(r.conditions)) {
      var conds = {}
      var any = false
      ;['1', '2', '3', '4', '5'].forEach(function (l) {
        var list = r.conditions[l]
        if (Array.isArray(list)) {
          conds[l] = list.filter(validLevelCondition_).map(function (c) { return JSON.parse(JSON.stringify(c)) })
          any = true
        }
      })
      if (any) out.conditions = conds
    }
    return out.points || out.conditions ? out : null
  }
  var result = {}
  var d = rule(obj['default'])
  if (d) result['default'] = d
  if (obj.skills && typeof obj.skills === 'object' && !Array.isArray(obj.skills)) {
    var skills = {}
    var anySkill = false
    Object.keys(obj.skills).forEach(function (name) {
      var parsed = rule(obj.skills[name])
      var key = String(name).trim().slice(0, 100)
      if (parsed && key) { skills[key] = parsed; anySkill = true }
    })
    if (anySkill) result.skills = skills
  }
  return result
}

function getSkillLevelRules_() {
  return parseSkillLevelRules_(getSettingValue_('skill_level_rules'))
}

function levelPointsFor_(rules, skill) {
  var s = rules.skills && rules.skills[skill]
  if (s && s.points) return s.points
  if (rules['default'] && rules['default'].points) return rules['default'].points
  return BUILTIN_LEVEL_POINTS.slice()
}

function levelConditionsFor_(rules, skill, level) {
  var key = String(level)
  var s = rules.skills && rules.skills[skill]
  if (s && s.conditions && s.conditions[key]) return s.conditions[key]
  var d = rules['default']
  if (d && d.conditions && d.conditions[key]) return d.conditions[key]
  return BUILTIN_LEVEL_CONDITIONS[key] || []
}

function levelConditionMet_(c, skill, level, ev) {
  if (c.type === 'qualification') {
    var related = (ev.qualifications || []).filter(function (q) {
      return q && Array.isArray(q.relatedSkills) && q.relatedSkills.indexOf(skill) >= 0 && (!c.external || q.external)
    })
    return related.length >= c.min
  }
  if (c.type === 'quiz') return (ev.quizPasses || []).some(function (p) { return p && p.skill === skill && Number(p.level) >= level })
  if (c.type === 'approval') return (ev.approvals || []).some(function (a) { return a && a.skill === skill && Number(a.level) >= level })
  return ((ev.doneTaskCounts || {})[skill] || 0) >= c.min
}

// 点数と記録から決まるレベル(どのレベルにも届かなければ 0)
function skillLevelOf_(points, skill, ev, rules) {
  rules = rules || {}
  var table = levelPointsFor_(rules, skill)
  for (var level = 5; level >= 1; level--) {
    if (points < table[level - 1]) continue
    var ok = levelConditionsFor_(rules, skill, level).every(function (c) { return levelConditionMet_(c, skill, level, ev) })
    if (ok) return level
  }
  return 0
}

function parseJsonListSafe_(v) {
  try { var a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch (e) { return [] }
}

// 条件を確かめるための、その人の記録(資格・検定の合格・担当して完了したタスクの数・スキルのレベルの承認)。
// 完了したタスクの数には、TasksArchive に移した古いタスクも数える
function skillEvidenceOf_(memberRow, memberId) {
  var counts = {}
  try {
    var t = snapshotTableOrSheet_(SHEET_TASKS)
    var col = function (name) { return t.headers.indexOf(name) }
    var aCol = col('assignee_id'), sCol = col('status'), kCol = col('skills'), delCol = col('deleted_at')
    ;(t.rows || []).forEach(function (r) {
      if (normalizeCode_('status', r[sCol]) !== 'done') return
      if (delCol >= 0 && String(r[delCol] || '') !== '') return
      var assignees = String(r[aCol] || '').split(',').map(function (x) { return x.trim() })
      if (assignees.indexOf(String(memberId)) < 0) return
      String(r[kCol] || '').split(',').map(function (x) { return x.trim() }).filter(Boolean).forEach(function (s) { counts[s] = (counts[s] || 0) + 1 })
    })
    archivedDoneTaskSkills_(memberId).forEach(function (s) { counts[s] = (counts[s] || 0) + 1 })
  } catch (e) { counts = {} }
  return {
    qualifications: parseJsonListSafe_(memberRow && memberRow.qualifications_json),
    quizPasses: parseJsonListSafe_(memberRow && memberRow.quiz_passes_json),
    doneTaskCounts: counts,
    approvals: parseJsonListSafe_(memberRow && memberRow.skill_approvals_json),
  }
}

/**
 * 累計の点数と記録から、レベルを上げた一覧を返す(下げない。acquiredAt などほかの項目は残す)。
 * 点数のあるスキルだけを計算し直す
 */
function computeAutoLevels_(currentLevels, cumulativePoints, rules, evidence) {
  var out = (currentLevels || []).map(function (l) { return JSON.parse(JSON.stringify(l)) })
  Object.keys(cumulativePoints || {}).forEach(function (skill) {
    var earned = skillLevelOf_(Number(cumulativePoints[skill]) || 0, skill, evidence || {}, rules || {})
    if (!earned) return
    var idx = -1
    for (var i = 0; i < out.length; i++) if (out[i] && out[i].skill === skill) { idx = i; break }
    if (idx < 0) out.push({ skill: skill, level: earned, acquiredAt: new Date().toISOString() })
    else if (earned > (Number(out[idx].level) || 0)) out[idx].level = earned
  })
  return out
}

/**
 * 他団体で積んだ実績(共通スキルのポイント・資格)の持ち込み。本人が自分の
 * ページからエクスポートしたファイルを、新しい団体で自分のページから
 * インポートする想定(lib/ohsumi/portable-record.ts)。awardSkillPointsと同じ
 * 「累計加算→レベル自動繰り上げ」ロジックだが、タスクには紐付けない。
 * 資格は名前+取得日が一致するものは重複とみなしスキップして追記する。
 */
// 他の団体の実績の持ち込み。点数は0以上の整数だけ(負の点数は断る)。
// 本人が自分の分を持ち込む時は、点数を足さない(資格だけ「外部」の印なしで足す)。点数は管理者が持ち込む
function importPortableRecord_(memberId, skillPoints, qualifications, acting) {
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません: ' + memberId)
  if (!skillPoints || typeof skillPoints !== 'object' || Array.isArray(skillPoints)) throw userError_('点数の形式が不正です。')
  Object.keys(skillPoints).forEach(function (k) {
    var v = Number(skillPoints[k])
    if (typeof skillPoints[k] === 'boolean' || !isFinite(v) || v < 0 || Math.floor(v) !== v) throw userError_('持ち込む点数は0以上の整数で入れてください。')
  })
  var pointsSkipped = false
  if (acting && selfRestricted_(acting, memberId) && Object.keys(skillPoints).length) {
    skillPoints = {}
    pointsSkipped = true
  }

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

  // 持ち込んだ資格も、レベルの条件に数える
  var evidence = skillEvidenceOf_(memberRow, memberId)
  evidence.qualifications = currentQualifications
  var newLevels = computeAutoLevels_(currentLevels, currentPoints, getSkillLevelRules_(), evidence)

  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
    qualifications_json: JSON.stringify(currentQualifications),
  })
  return { ok: true, newPoints: currentPoints, newLevels: newLevels, qualifications: currentQualifications, pointsSkipped: pointsSkipped }
}

/**
 * Awards skill points to a member on task completion.
 * Updates skill_points_json and auto-levels skill_levels_json.
 * Also saves awarded_points_json on the task for future avg calculations.
 */
// 完了したタスクのスキルの点数を付ける。画面から送られた値を、GAS でも確かめる:
//   ・タスクが完了している ・受け取る人がそのタスクの担当者 ・点数を付けるスキルがタスクの必要スキル
//   ・1つのタスクにつき1人1回だけ(付けた人の一覧は awarded_points_json の __awardedTo に記録する)
//   ・1回にスキルごと AWARD_MAX_POINTS_PER_SKILL 点まで(0以上の整数) ・自分自身には付けられない
var AWARD_MAX_POINTS_PER_SKILL = 100
function awardSkillPoints_(taskId, memberId, points, acting) {
  taskId = String(taskId || '')
  memberId = String(memberId || '')
  if (!taskId) throw userError_('タスクを指定してください。')
  if (acting && memberId === String(acting.id)) throw userError_('自分自身にはスキルの点数を付けられません。ほかの管理者に依頼してください。')
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('タスクが見つかりません。')
  if (normalizeCode_('status', task.status) !== 'done') throw userError_('完了したタスクにだけ、スキルの点数を付けられます。')
  if (String(task.awarded_points_json || '').indexOf('"__noAward":true') >= 0) throw userError_('完了として取り込んだタスクには、スキルの点数を付けられません。')
  var assignees = splitCsvList_(task.assignee_id)
  if (assignees.indexOf(memberId) < 0) throw userError_('このタスクの担当者にだけ、スキルの点数を付けられます。')
  var taskSkills = String(task.skills || '').split(',').map(function (x) { return x.trim() }).filter(Boolean)
  var clean = {}
  Object.keys(points || {}).forEach(function (skill) {
    var v = Number(points[skill])
    if (taskSkills.indexOf(skill) < 0) throw userError_('「' + skill + '」はこのタスクの必要スキルではありません。')
    if (!(v >= 0) || Math.floor(v) !== v) throw userError_('点数は0以上の整数で入れてください。')
    if (v > AWARD_MAX_POINTS_PER_SKILL) throw userError_('1回に付けられる点数は、スキルごとに' + AWARD_MAX_POINTS_PER_SKILL + '点までです。')
    clean[skill] = v
  })
  if (!Object.keys(clean).length) throw userError_('点数を付けるスキルがありません。')
  var awarded = {}
  try { awarded = JSON.parse(task.awarded_points_json || '{}') || {} } catch (_) { awarded = {} }
  var awardedTo = Array.isArray(awarded.__awardedTo) ? awarded.__awardedTo.map(String) : []
  if (awardedTo.indexOf(memberId) >= 0) throw userError_('このメンバーには、このタスクの点数をもう付けています。')
  points = clean
  var added = addSkillPoints_(memberId, points)

  // タスクには、付けた点数(画面の「似たタスクの平均」に使う)と、付けた人の一覧を残す
  var record = {}
  Object.keys(points).forEach(function (k) { record[k] = points[k] })
  record.__awardedTo = awardedTo.concat([memberId])
  record.__awardedBy = acting ? String(acting.id) : ''
  record.__awardedAt = new Date().toISOString()
  updateTaskFields_(taskId, { awarded_points_json: JSON.stringify(record) })
  return { ok: true, newPoints: added.newPoints, newLevels: added.newLevels }
}

// メンバーのスキルの点数を足し、レベルを決め直して保存する(確かめは呼ぶ側で行う)
function addSkillPoints_(memberId, points) {
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません: ' + memberId)

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

  // レベルを上げる(skill_level_rules と、資格・検定・完了したタスクの条件で決める)
  var newLevels = computeAutoLevels_(currentLevels, currentPoints, getSkillLevelRules_(), skillEvidenceOf_(memberRow, memberId))

  // Persist
  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
  })
  return { newPoints: currentPoints, newLevels: newLevels }
}

/**
 * Processes a quiz submission. Reads the quiz definition from Settings,
 * scores the answers, and if pass rate is met, auto-levels the skill.
 */
function submitQuizResult_(quizId, memberId, answers, acting) {
  if (memberId !== acting.id && !isAdminRoleRef_(getRoles_(), acting.role)) {
    throw userError_('他のメンバーの代わりに検定を受けることはできません。')
  }
  var defs = getQuizDefinitions_()
  var quiz = null
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].id === quizId) { quiz = defs[i]; break }
  }
  if (!quiz) throw userError_('検定が見つかりません: ' + quizId)

  var questions = quiz.questions || []
  if (questions.length === 0) throw userError_('検定に設問がありません。')

  var correct = 0
  for (var j = 0; j < questions.length; j++) {
    if (answers[j] === questions[j].correctIndex) correct++
  }
  var score = Math.round((correct / questions.length) * 100)
  var passed = score >= quiz.passRate

  var newLevel = null
  if (passed) {
    var memberRow = findRow_(SHEET_MEMBERS, memberId)
    var currentLevels = parseJsonListSafe_(memberRow && memberRow.skill_levels_json)
    var targetSkill = quiz.targetSkill
    var targetLevel = Number(quiz.targetLevel) || 1
    // 合格を記録する(レベルの条件「検定の合格」に使う。同じ検定は最新の1件だけ残す)
    var passes = parseJsonListSafe_(memberRow && memberRow.quiz_passes_json).filter(function (p) { return p && p.quizId !== quiz.id })
    passes.push({ quizId: quiz.id, skill: targetSkill, level: targetLevel, at: new Date().toISOString() })
    var fields = { quiz_passes_json: JSON.stringify(passes.slice(-100)) }
    var existing = currentLevels.find(function(sl) { return sl.skill === targetSkill })
    if (!existing || existing.level < targetLevel) {
      // 検定の合格で、目標のレベルにする(acquiredAt などは残す)
      var nextLevels = currentLevels.map(function (sl) { return sl.skill === targetSkill ? Object.assign({}, sl, { level: targetLevel }) : sl })
      if (!existing) nextLevels.push({ skill: targetSkill, level: targetLevel, acquiredAt: new Date().toISOString() })
      // SKL-009: 累計の点数もレベルにそろえる(そのレベルに必要な点数まで底上げする。画面と同じ)
      var currentPoints = {}
      try { currentPoints = JSON.parse((memberRow && memberRow.skill_points_json) || '{}') } catch (_) {}
      var minPointsForLevel = levelPointsFor_(getSkillLevelRules_(), targetSkill)[targetLevel - 1]
      if ((currentPoints[targetSkill] || 0) < minPointsForLevel) {
        currentPoints[targetSkill] = minPointsForLevel
      }
      fields.skill_levels_json = JSON.stringify(nextLevels)
      fields.skill_points_json = JSON.stringify(currentPoints)
      newLevel = targetLevel
    }
    updateMemberFields_(memberId, fields)
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
// 代表は authorizeAction_ の先頭で早期 return するため、実質的には「restrictedRoles に含まれない班長」を判定する。
function isActingFullAdmin_(acting) {
  return isFullAdminRoleRef_(getRoles_(), acting.role)
}

// 廃止した操作(画面が宛先・本文を送って通知させていたもの)。宛先と本文は GAS が保存したデータから決める:
//   notifyMention → updateComments の中で、保存したコメントのメンションから通知する
//   notifyTaskRejected → rejectTask(タスクを消し、シートのタスクの作成者・名前で通知する)
var REMOVED_ACTIONS = ['notifyMention', 'notifyTaskRejected']
var REMOVED_ACTION_MESSAGE = 'この操作は使えなくなりました。ページを読み込み直してください。'

