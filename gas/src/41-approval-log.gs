
// ---- 承認の記録(ApprovalLog) ----------------------------------------------------
//
// タスクの登録の承認・却下を、1件ずつ ApprovalLog シートに残す(管理画面の「承認の履歴」に出す)。
//   ・承認(approveTask)・却下(rejectTask)の時に、操作した人(ログインの情報から決める)・日時・タスクの名前・
//     プロジェクト・登録した人・却下の理由を足す。却下するとタスクは消えるので、名前とプロジェクトはここに残す
//   ・読む(getApprovalLog): 代表・管理者(一般以外の役職)。全権でない管理者は、担当プロジェクトの分だけ(承認待ちの一覧と同じ)
//   ・保存期間は APPROVAL_LOG_KEEP_DAYS 日。毎日の処理で古い行を消す(却下の理由は自由な文なので、ずっとは残さない)
//   ・バックアップから戻しても、この記録は戻さない(RESTORE_EXCLUDED_SHEETS。操作の記録 AuditLog と同じ)
//   ・記録に失敗しても、承認・却下そのものは止めない(エラーの記録に残す)
// 経費・申請フォームの承認の記録と、タスクの確認(確認者の承認・差し戻し)は、それぞれの記録にあるので、ここには残さない
var SHEET_APPROVAL_LOG = 'ApprovalLog'
// 列は 03-sheets-codes.gs の APPROVAL_LOG_HEADERS(SHEET_HEADERS より前に決める)
var APPROVAL_LOG_KEEP_DAYS = 365
var APPROVAL_LOG_READ_MAX = 1000

// 承認・却下の時に呼ぶ(task は消す前・承認する前のシートの行)
function appendApprovalLog_(action, task, actorId, reason) {
  try {
    if (!task) return
    var sheet = getOrCreateSheet_(SHEET_APPROVAL_LOG, APPROVAL_LOG_HEADERS)
    var headers = headerRow_(sheet)
    var values = {
      id: 'al-' + Utilities.getUuid().slice(0, 13),
      at: new Date().toISOString(),
      kind: 'task_registration',
      action: action === 'rejected' ? 'rejected' : 'approved',
      target_id: String(task.id || ''),
      title: String(task.title || '').slice(0, 300),
      project_id: String(task.project_id || ''),
      creator_id: String(task.creator_id || ''),
      by_id: String(actorId || ''),
      reason: String(reason || '').slice(0, REJECT_REASON_MAX_CHARS),
    }
    var row = headers.map(function (h) { return values[h] === undefined ? '' : values[h] })
    var rowNumber = sheet.getLastRow() + 1
    protectRowFromFormulaInjection_(sheet, headers, rowNumber, SHEET_APPROVAL_LOG)
    sheet.appendRow(row)
  } catch (err) {
    console.error('承認の記録を残せませんでした: ' + maskEmailsIn_(String(err)))
  }
}

// 承認待ちのタスクを承認した時だけ残す(承認済みのタスクにもう一度 approveTask が来ても残さない)
function approveTaskLogged_(taskId, actorId) {
  var before = findRow_(SHEET_TASKS, String(taskId || ''))
  var wasPending = !!before && normalizeCode_('approval', before.approval_status) === 'pending'
  var result = updateTaskFields_(taskId, { approval_status: sheetCode_('approval', 'approved') })
  if (wasPending) appendApprovalLog_('approved', before, actorId, '')
  return result
}

// 承認の記録を読む(新しい順。保存期間の中だけ)
function getApprovalLog_(acting) {
  var cutoff = Date.now() - APPROVAL_LOG_KEEP_DAYS * 24 * 3600 * 1000
  // 承認待ちの一覧(画面の adminPendingTasks)と同じ範囲: 全権管理者はすべて、それ以外の管理者は担当プロジェクトの分だけ
  var scoped = !isActingFullAdmin_(acting)
  var projectIds = String(acting.project_ids || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var rows = sheetRowsAsObjects_(SHEET_APPROVAL_LOG)
  var out = []
  for (var i = rows.length - 1; i >= 0 && out.length < APPROVAL_LOG_READ_MAX; i--) {
    var r = rows[i]
    var at = timeOfCell_(r.at)
    if (!(at >= cutoff)) continue
    if (scoped && projectIds.indexOf(String(r.project_id || '')) < 0) continue
    out.push({
      id: String(r.id),
      at: new Date(at).toISOString(),
      kind: String(r.kind || 'task_registration'),
      action: String(r.action) === 'rejected' ? 'rejected' : 'approved',
      targetId: String(r.target_id || ''),
      title: String(r.title || ''),
      projectId: String(r.project_id || ''),
      creatorId: String(r.creator_id || ''),
      byId: String(r.by_id || ''),
      reason: String(r.reason || ''),
    })
  }
  return { entries: out, keepDays: APPROVAL_LOG_KEEP_DAYS }
}

// 保存期間を過ぎた行を消す(毎日の処理)。消した行の数を返す
function purgeOldApprovalLogLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return purgeOldApprovalLog_(nowMs)
  } finally {
    lock.releaseLock()
  }
}

function purgeOldApprovalLog_(nowMs) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_APPROVAL_LOG)
  if (!sheet || sheet.getLastRow() < 2) return 0
  var headers = headerRow_(sheet)
  var atCol = headers.indexOf('at')
  if (atCol < 0) return 0
  var cutoff = (nowMs || Date.now()) - APPROVAL_LOG_KEEP_DAYS * 24 * 3600 * 1000
  var values = sheet.getRange(2, atCol + 1, sheet.getLastRow() - 1, 1).getValues()
  // 行は古い順に足していくので、先頭から続く古い行をまとめて消す
  var count = 0
  while (count < values.length) {
    var at = timeOfCell_(values[count][0])
    if (!(at > 0) || at >= cutoff) break
    count++
  }
  if (count > 0) sheet.deleteRows(2, count)
  return count
}
