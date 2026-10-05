
// ---- スキルのレベルの承認(評価をスキルの証拠にする) -----------------------------
//
// approveSkillLevel { memberId, skill, level(1〜5), reason }: 「スキル○○を Lv.○ と認める」を、理由の文と一緒に記録する。
// 記録できるのは、代表と、その人を見る立場の人(報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者。
// 評価・1on1 を読める人と同じ supervisedMemberIds_)。自分自身には記録できない(代表も)。
// 記録は Members の skill_approvals_json に {id, skill, level, reason, byId, at} で残す(誰が・いつ・何を)。
// skill_level_rules の条件 {type:'approval'} は、このスキルをそのレベル以上と認めた記録があれば満たす。
// 記録した後に、レベルを決め直す(点数と、ほかの条件も要る。保存されたレベルは下げない)
var SKILL_APPROVAL_REASON_MAX = 500
var SKILL_APPROVAL_MAX = 200

function canApproveSkillOf_(acting, memberId) {
  if (String(acting.id) === String(memberId)) return false
  if (isTopRoleRef_(getRoles_(), acting.role)) return true
  var data = { Members: snapshotTableOrSheet_(SHEET_MEMBERS), Projects: snapshotTableOrSheet_(SHEET_PROJECTS) }
  return !!supervisedMemberIds_(data, String(acting.id))[String(memberId)]
}

function approveSkillLevel_(acting, memberId, skill, level, reason) {
  memberId = String(memberId || '')
  skill = typeof skill === 'string' ? skill.trim() : ''
  reason = typeof reason === 'string' ? reason.trim() : ''
  if (!memberId) throw userError_('メンバーを指定してください。')
  if (memberId === String(acting.id)) throw userError_('自分自身のスキルのレベルは認められません。見る立場の人に依頼してください。')
  if (!skill || skill.length > 100) throw userError_('スキルの名前を100文字以内で入れてください。')
  if (typeof level !== 'number' || [1, 2, 3, 4, 5].indexOf(level) < 0) throw userError_('レベルは 1〜5 で指定してください。')
  if (!reason) throw userError_('認める理由を書いてください。')
  if (reason.length > SKILL_APPROVAL_REASON_MAX) throw userError_('理由は' + SKILL_APPROVAL_REASON_MAX + '文字以内にしてください。')
  if (!canApproveSkillOf_(acting, memberId)) throw userError_('スキルのレベルを認められるのは、代表と、その人を見る立場の人(上長・メンター・プロジェクトの責任者)だけです。')
  checkActiveMember_(memberId, '認める相手')
  // 列が無い古いシートには足す(初期設定を実行し直さなくても記録できるように)
  ensureSheetHeaders_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_MEMBERS, ['skill_approvals_json'])
  forgetSheetGrid_(SHEET_MEMBERS)
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません。')
  var record = { id: 'sa-' + Utilities.getUuid().slice(0, 8), skill: skill, level: level, reason: reason, byId: String(acting.id), at: new Date().toISOString() }
  var approvals = parseJsonListSafe_(memberRow.skill_approvals_json).concat([record]).slice(-SKILL_APPROVAL_MAX)
  var points = {}
  try { points = JSON.parse(memberRow.skill_points_json || '{}') || {} } catch (e) { points = {} }
  var evidence = skillEvidenceOf_(memberRow, memberId)
  evidence.approvals = approvals
  var newLevels = computeAutoLevels_(parseJsonListSafe_(memberRow.skill_levels_json), points, getSkillLevelRules_(), evidence)
  updateMemberFields_(memberId, { skill_approvals_json: JSON.stringify(approvals), skill_levels_json: JSON.stringify(newLevels) })
  return { approval: record, newLevels: newLevels }
}
