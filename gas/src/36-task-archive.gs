
// ---- 古いタスクを移す(TasksArchive) -------------------------------------------
//
// 完了してから決めた日数(レジストリから配る taskArchiveDays。既定は365日)がたったタスクを、毎日の処理で
// TasksArchive シートに移す(Tasks から行を消し、同じ列 + archived_at で TasksArchive に足す)。
//   ・ふだんの読み込み(初期データ・スナップショット)には入れない(Tasks だけを読む)
//   ・検索(searchArchivedTasks。見てよいタスクだけ)・スキルの条件の「完了したタスクの数」・バックアップから戻す、に使う
//   ・戻す(unarchiveTasks。代表・全権管理者)で Tasks に戻す
// 移さないもの: ゴミ箱のタスク・完了の日が分からないタスク・まだ Tasks にあるタスクから前提タスク・確認タスクとして
// 参照されているタスク(画面で前提タスクが見えなくならないように)。1回に TASK_ARCHIVE_MAX_PER_RUN 件まで。
// 先に TasksArchive に足してから Tasks の行を消す(途中で止まっても、次の回に同じ ID を足し直さずに消すだけにする)
var SHEET_TASKS_ARCHIVE = 'TasksArchive'
var TASK_ARCHIVE_MAX_PER_RUN = 500
var ARCHIVE_SEARCH_MAX = 200
var UNARCHIVE_MAX = 100

function tasksArchiveSheet_(create) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS_ARCHIVE)
  if (!sheet && create) sheet = getOrCreateSheet_(SHEET_TASKS_ARCHIVE, TASKS_ARCHIVE_HEADERS)
  if (sheet && create) ensureSheetHeaders_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_TASKS_ARCHIVE, TASKS_ARCHIVE_HEADERS)
  return sheet
}

function archivedTaskRows_() {
  return sheetRowsAsObjects_(SHEET_TASKS_ARCHIVE)
}

// 移したタスクの ID の最大値(新しいタスクに同じ ID を使わないように。nextIntId_ が Tasks の時だけ数える)。
// 読むだけ(シートを作らない)
function archivedMaxIdFor_(sheet) {
  if (!sheet || !sheet.getName || sheet.getName() !== SHEET_TASKS) return 0
  var archive = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS_ARCHIVE)
  if (!archive || archive.getLastRow() < 2) return 0
  var headers = headerRow_(archive)
  var idCol = headers.indexOf('id')
  if (idCol < 0) return 0
  var max = 0
  archive.getRange(2, idCol + 1, archive.getLastRow() - 1, 1).getValues().forEach(function (r) {
    var n = parseInt(r[0], 10)
    if (!isNaN(n) && n > max) max = n
  })
  return max
}

// 移した完了のタスクのうち、その人が担当したもののスキル(1タスクにつき、スキルごとに1つ)
function archivedDoneTaskSkills_(memberId) {
  var out = []
  archivedTaskRows_().forEach(function (t) {
    if (normalizeCode_('status', t.status) !== 'done') return
    if (splitCsvList_(t.assignee_id).indexOf(String(memberId)) < 0) return
    splitCsvList_(t.skills).forEach(function (s) { out.push(s) })
  })
  return out
}

function archivedTaskCountOfProject_(projectId) {
  return archivedTaskRows_().filter(function (t) { return String(t.project_id || '') === String(projectId) }).length
}

function taskDoneAtMs_(t) {
  var at = cellTimeMs_(t.completed_date)
  if (!isFinite(at)) at = cellTimeMs_(t.last_activity)
  return at
}

// 移すタスク(Tasks の行のオブジェクトの一覧から選ぶ)
function tasksToArchive_(rows, nowMs, days) {
  var limit = nowMs - days * 24 * 3600 * 1000
  var referenced = {}
  var candidates = rows.filter(function (t) {
    return normalizeCode_('status', t.status) === 'done' && !isTrashedTask_(t) && isFinite(taskDoneAtMs_(t)) && taskDoneAtMs_(t) <= limit
  })
  var moving = {}
  candidates.forEach(function (t) { moving[String(t.id)] = true })
  rows.forEach(function (t) {
    if (moving[String(t.id)]) return
    splitCsvList_(t.depends_on_ids).forEach(function (id) { referenced[id] = true })
    if (String(t.related_review_task_id || '')) referenced[String(t.related_review_task_id)] = true
  })
  return candidates.filter(function (t) { return !referenced[String(t.id)] }).slice(0, TASK_ARCHIVE_MAX_PER_RUN)
}

// 行を Tasks から TasksArchive へ移す(ロックを取った中で呼ぶ)。移した ID を返す
function moveTasksToArchive_(tasks, nowMs) {
  if (!tasks.length) return []
  var archive = tasksArchiveSheet_(true)
  var aHeaders = headerRow_(archive)
  var already = {}
  archivedTaskRows_().forEach(function (t) { already[String(t.id)] = true })
  var at = new Date(nowMs).toISOString()
  tasks.forEach(function (t) {
    if (already[String(t.id)]) return
    var row = aHeaders.map(function (h) { return h === 'archived_at' ? at : (t[h] === undefined ? '' : t[h]) })
    var rowNumber = archive.getLastRow() + 1
    protectRowFromFormulaInjection_(archive, aHeaders, rowNumber, SHEET_TASKS)
    archive.getRange(rowNumber, 1, 1, aHeaders.length).setValues([row])
  })
  deleteRowsById_(getSheet_(SHEET_TASKS), tasks.map(function (t) { return String(t.id) }))
  forgetSheetGrid_(SHEET_TASKS)
  return tasks.map(function (t) { return String(t.id) })
}

// シートから、ID が一覧にある行を消す(下から消す)
function deleteRowsById_(sheet, ids) {
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0 || sheet.getLastRow() < 2) return 0
  var want = {}
  ids.forEach(function (id) { want[String(id)] = true })
  var values = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues()
  var rows = []
  values.forEach(function (r, i) { if (want[String(r[0])]) rows.push(i + 2) })
  rows.sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  return rows.length
}

// 毎日の処理から呼ぶ
function archiveOldTasksLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    var moved = moveTasksToArchive_(tasksToArchive_(sheetRowsAsObjects_(SHEET_TASKS), nowMs, tunable_('taskArchiveDays')), nowMs)
    if (moved.length) bumpSnapshotVersion_()
    return moved
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

// 移したタスクを探す(名前の一部・担当者)。見てよいタスクだけを、新しく移した順に ARCHIVE_SEARCH_MAX 件まで返す。
// 列は READ_POLICY の Tasks と同じ(規則の無い列は返さない)に、移した日時(archivedAt)を足す
function searchArchivedTasks_(acting, query, memberId) {
  var q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  var who = typeof memberId === 'string' ? memberId.trim() : ''
  if (q.length > 200) throw userError_('探す文字は200文字までにしてください。')
  var sheet = tasksArchiveSheet_(false)
  if (!sheet || sheet.getLastRow() < 2) return { headers: [], rows: [], archivedAt: {}, total: 0 }
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var col = function (h) { return headers.indexOf(h) }
  var matched = values.slice(1).filter(function (r) {
    if (!String(r[col('id')] || '')) return false
    if (q && String(r[col('title')] || '').toLowerCase().indexOf(q) < 0) return false
    if (who && splitCsvList_(r[col('assignee_id')]).indexOf(who) < 0) return false
    return true
  })
  var viewer = makeViewer_({ id: acting.id, role: acting.role }, getRoles_())
  var filtered = filterTableForViewer_('Tasks', { headers: headers, rows: matched }, viewer)
  var archivedAt = {}
  var visibleIds = {}
  var idOut = filtered.headers.indexOf('id')
  filtered.rows.forEach(function (r) { visibleIds[String(r[idOut])] = true })
  matched.forEach(function (r) {
    var id = String(r[col('id')])
    if (visibleIds[id]) archivedAt[id] = col('archived_at') >= 0 ? String(r[col('archived_at')] || '') : ''
  })
  var rows = filtered.rows.slice().sort(function (a, b) {
    var x = archivedAt[String(a[idOut])], y = archivedAt[String(b[idOut])]
    return x < y ? 1 : x > y ? -1 : 0
  })
  return { headers: filtered.headers, rows: rows.slice(0, ARCHIVE_SEARCH_MAX), archivedAt: archivedAt, total: rows.length }
}

// 移したタスクを Tasks に戻す(代表・全権管理者。ロックを取った書き込みの中で呼ぶ)
function unarchiveTasks_(taskIds) {
  var ids = []
  ;(Array.isArray(taskIds) ? taskIds : []).forEach(function (id) {
    var s = String(id || '')
    if (s && ids.indexOf(s) < 0) ids.push(s)
  })
  if (!ids.length) throw userError_('戻すタスクを選んでください。')
  if (ids.length > UNARCHIVE_MAX) throw userError_('一度に戻せるタスクは ' + UNARCHIVE_MAX + ' 件までです。')
  var byId = {}
  archivedTaskRows_().forEach(function (t) { byId[String(t.id)] = t })
  var missing = ids.filter(function (id) { return !byId[id] })
  if (missing.length) throw userError_('移したタスクに見つかりません: ' + missing.slice(0, 5).join(', '))
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var live = {}
  sheetRowsAsObjects_(SHEET_TASKS).forEach(function (t) { live[String(t.id)] = true })
  ids.forEach(function (id) {
    if (live[id]) return
    var t = byId[id]
    var row = headers.map(function (h) { return t[h] === undefined ? '' : t[h] })
    var rowNumber = sheet.getLastRow() + 1
    protectRowFromFormulaInjection_(sheet, headers, rowNumber, SHEET_TASKS)
    sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row])
  })
  deleteRowsById_(tasksArchiveSheet_(false), ids)
  forgetSheetGrid_(SHEET_TASKS)
  return { restored: ids }
}
