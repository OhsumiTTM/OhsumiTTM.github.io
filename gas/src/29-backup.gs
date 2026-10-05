// ---- バックアップ(毎日のコピーと、戻す) -------------------------------------------------
//
// 毎日の処理(dailyMaintenance)で、団体のスプレッドシートのコピーを「バックアップ」フォルダに作る
// (BACKUP_FOLDER_ID。GAS のアカウントだけが持つ。編集者・閲覧者を外し、リンクの共有も「制限付き」にする)。
// コピーするのはスプレッドシートだけ(アップロードしたファイルはコピーしない)。
// 残す数は、毎日の分 BACKUP_KEEP.daily・毎週の分 BACKUP_KEEP.weekly・毎月の分 BACKUP_KEEP.monthly(最長で約3か月)。
// 超えた古いものはゴミ箱に移す。作るのに失敗した時は BACKUP_STATE に残し、代表の管理画面に出す(getBackupStatus)。
// 戻す(代表だけ):
//   - 全体を戻す(restoreBackup): データのシートをすべてバックアップの内容に置き換える(操作の記録 AuditLog は残す)。
//     戻す前に今の状態を自動でバックアップし、戻している間は書き込みを止め(RESTORE_IN_PROGRESS)、終わったらデータの版を上げる。
//     戻す前に、シートごとの件数の差を見せる(previewRestore)
//   - 一部のタスクだけ戻す(restoreTasks): 選んだタスクの行と、そのタスクのコメント・変更の記録・進捗の記録だけを戻す。
//     バックアップの後に付いたコメントなどは残し、戻したことを変更の記録とタスクの履歴に残す
// どちらも操作の記録(AuditLog シート)に残す
var BACKUP_FOLDER_PROPERTY_KEY = 'BACKUP_FOLDER_ID'
var BACKUP_STATE_KEY = 'BACKUP_STATE'
var BACKUP_NAME_PREFIX = 'Ohsumi バックアップ '
var BACKUP_BEFORE_RESTORE_SUFFIX = '(戻す前)'
var BACKUP_KEEP = { daily: 7, weekly: 4, monthly: 3 }
var RESTORE_STATE_KEY = 'RESTORE_IN_PROGRESS'
// 戻している印が残ったまま(実行の途中で止まった時など)でも、これを過ぎたら書き込みを受け付ける
var RESTORE_STALE_MS = 30 * 60 * 1000
var RESTORE_MESSAGE = 'バックアップから戻しています。終わるまで(数分)待ってから、もう一度お試しください。'
// 戻さないシート(操作の記録は、戻した記録を含めて残す)
var RESTORE_EXCLUDED_SHEETS = ['AuditLog']
// 一部のタスクを戻す時に、行を置き換えずに合わせるもの(バックアップの後に付いたものも残す)
var RESTORE_MERGED_TASK_LISTS = ['comments_json', 'history_json', 'progress_history_json']
var RESTORE_TASKS_MAX = 50
var BACKUP_SEARCH_MAX = 30

// ファイル・フォルダを、GAS のアカウントだけが持つようにする
function makeDrivePrivate_(file) {
  try { file.getEditors().forEach(function (u) { try { file.removeEditor(u) } catch (e) { /* 自分自身など */ } }) } catch (e) { /* 一覧を読めない時 */ }
  try { file.getViewers().forEach(function (u) { try { file.removeViewer(u) } catch (e) { /* 自分自身など */ } }) } catch (e) { /* 一覧を読めない時 */ }
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE) } catch (e) { /* 変えられない場合 */ }
}

function backupFolder_() {
  var props = PropertiesService.getScriptProperties()
  var id = props.getProperty(BACKUP_FOLDER_PROPERTY_KEY)
  if (id) {
    try { return DriveApp.getFolderById(id) } catch (e) { /* 消された: 作り直す */ }
  }
  var folder = DriveApp.createFolder('Ohsumi バックアップ(' + (getSettingValue_('org_name') || 'Ohsumi') + ')')
  makeDrivePrivate_(folder)
  props.setProperty(BACKUP_FOLDER_PROPERTY_KEY, folder.getId())
  return folder
}

// バックアップを1つ作る。kind: daily(毎日) / beforeRestore(戻す前)
function createBackup_(kind, nowMs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var name = BACKUP_NAME_PREFIX + Utilities.formatDate(new Date(nowMs), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') +
    (kind === 'beforeRestore' ? BACKUP_BEFORE_RESTORE_SUFFIX : '')
  // スプレッドシートだけをコピーする(アップロードしたファイルはコピーしない)
  var copy = DriveApp.getFileById(ss.getId()).makeCopy(name, backupFolder_())
  makeDrivePrivate_(copy)
  return { id: copy.getId(), name: name, at: new Date(nowMs).toISOString(), kind: kind }
}

function readBackupState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(BACKUP_STATE_KEY) || '{}') || {} } catch (e) { return {} }
}

function writeBackupState_(fields) {
  var s = readBackupState_()
  Object.keys(fields).forEach(function (k) { s[k] = fields[k] })
  PropertiesService.getScriptProperties().setProperty(BACKUP_STATE_KEY, JSON.stringify(s))
  return s
}

// 毎日の処理から: バックアップを作り、残す数を超えた古いものをゴミ箱に移す。失敗しても毎日の処理は続ける
function dailyBackup_(nowMs) {
  nowMs = nowMs || Date.now()
  try {
    var made = createBackup_('daily', nowMs)
    writeBackupState_({ lastSuccessAt: made.at, lastName: made.name, lastFailureAt: '', lastError: '' })
  } catch (e) {
    var message = String((e && e.message) || e).slice(0, 300)
    writeBackupState_({ lastFailureAt: new Date(nowMs).toISOString(), lastError: message })
    console.error('バックアップを作れませんでした: ' + message)
    return null
  }
  try { pruneBackups_(nowMs) } catch (e) { console.error('古いバックアップを片付けられませんでした: ' + e) }
  return made
}

// 代表が管理画面から「今すぐバックアップを作る」。作りすぎないよう、前に手で作ってから10分は断る。
// 作った後は、毎日の分と同じく残す数を超えた古いものを片付ける
var BACKUP_MANUAL_INTERVAL_MS = 10 * 60 * 1000
function createBackupNow_(actorId, nowMs) {
  nowMs = nowMs || Date.now()
  if (restoreInProgress_()) throw userError_('バックアップから戻している間は、バックアップを作れません。')
  var state = readBackupState_()
  var last = Date.parse(state.lastManualAt || '')
  if (last && nowMs - last < BACKUP_MANUAL_INTERVAL_MS) {
    throw userError_('少し前にバックアップを作ったばかりです。10分ほど待ってから、もう一度お試しください。')
  }
  var made
  try {
    made = createBackup_('manual', nowMs)
  } catch (e) {
    var message = String((e && e.message) || e).slice(0, 300)
    writeBackupState_({ lastFailureAt: new Date(nowMs).toISOString(), lastError: message })
    throw userError_('バックアップを作れませんでした: ' + message)
  }
  writeBackupState_({ lastSuccessAt: made.at, lastName: made.name, lastManualAt: made.at, lastFailureAt: '', lastError: '' })
  try { pruneBackups_(nowMs) } catch (e) { console.error('古いバックアップを片付けられませんでした: ' + e) }
  try { appendOrgAudit_(actorId, 'createBackupNow', made.name, { backupId: made.id }) } catch (e) { console.error('操作の記録: ' + e) }
  return { backup: made, status: backupStatus_(), backups: listBackups_() }
}

// 画面に出す状態: 最後に作れた日時と、最後に作れなかった日時(作れた後にまた作れた時は出さない)
function backupStatus_() {
  var s = readBackupState_()
  var failed = !!s.lastFailureAt && !(Date.parse(s.lastSuccessAt || '') > Date.parse(s.lastFailureAt))
  return { lastSuccessAt: String(s.lastSuccessAt || ''), failed: failed, failedAt: failed ? String(s.lastFailureAt) : '', error: failed ? String(s.lastError || '') : '' }
}

// バックアップの一覧(新しい順)。フォルダの中の、名前が BACKUP_NAME_PREFIX で始まるスプレッドシートだけ
function listBackups_() {
  var out = []
  var files = backupFolder_().getFiles()
  while (files.hasNext()) {
    var f = files.next()
    var name = String(f.getName())
    if (name.indexOf(BACKUP_NAME_PREFIX) !== 0) continue
    out.push({ id: String(f.getId()), name: name, at: new Date(f.getDateCreated()).toISOString(),
      kind: name.slice(-BACKUP_BEFORE_RESTORE_SUFFIX.length) === BACKUP_BEFORE_RESTORE_SUFFIX ? 'beforeRestore' : 'daily' })
  }
  out.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at) })
  return out
}

// 日付の区切り(日・週・月)。週は月曜日から
function backupPeriodKeys_(ms, tz) {
  var parts = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd-u').split('-')
  var dow = Number(parts[3]) || 1
  var monday = Utilities.formatDate(new Date(ms - (dow - 1) * 24 * 3600 * 1000), tz, 'yyyy-MM-dd')
  return { day: parts.slice(0, 3).join('-'), week: monday, month: parts[0] + '-' + parts[1] }
}

// 残すバックアップの ID(純粋な関数)。entries は新しい順に並べたもの { id, at }。
// 毎日の分: 新しい順に BACKUP_KEEP.daily 個 / 毎週の分: 週ごとに一番新しいものを、新しい週から BACKUP_KEEP.weekly 週 /
// 毎月の分: 月ごとに一番新しいものを、新しい月から BACKUP_KEEP.monthly か月
function backupsToKeep_(entries, keysOf) {
  var keep = {}
  entries.slice(0, BACKUP_KEEP.daily).forEach(function (e) { keep[e.id] = true })
  var pick = function (kind, count) {
    var seen = {}
    var n = 0
    entries.forEach(function (e) {
      var k = keysOf(e)[kind]
      if (seen[k] || n >= count) return
      seen[k] = true
      n++
      keep[e.id] = true
    })
  }
  pick('week', BACKUP_KEEP.weekly)
  pick('month', BACKUP_KEEP.monthly)
  return keep
}

// 残す数を超えた古いバックアップを、ゴミ箱に移す。移した数を返す
function pruneBackups_(nowMs) {
  var tz = Session.getScriptTimeZone()
  var entries = listBackups_().map(function (b) { return { id: b.id, at: Date.parse(b.at) } })
  var keep = backupsToKeep_(entries, function (e) { return backupPeriodKeys_(e.at, tz) })
  var removed = 0
  entries.forEach(function (e) {
    if (keep[e.id]) return
    DriveApp.getFileById(e.id).setTrashed(true)
    removed++
  })
  return removed
}

// 画面から受け取ったバックアップの ID が、バックアップのフォルダの中のものか(ほかのファイルは開かない)
function backupById_(backupId) {
  var id = String(backupId || '')
  var found = null
  listBackups_().forEach(function (b) { if (b.id === id) found = b })
  if (!found) throw userError_('そのバックアップは見つかりません。一覧を読み直してください。')
  return found
}

// ---- 戻している間 ----

function restoreInProgress_() {
  var raw = PropertiesService.getScriptProperties().getProperty(RESTORE_STATE_KEY)
  if (!raw) return null
  var s = null
  try { s = JSON.parse(raw) } catch (e) { s = null }
  if (!s || !(Date.now() - Date.parse(s.startedAt || '') < RESTORE_STALE_MS)) return null
  return s
}

// ---- 操作の記録(団体のスプレッドシートの AuditLog シート) ----
var AUDIT_LOG_HEADERS = ['at', 'actor_id', 'action', 'target', 'detail_json']

function appendOrgAudit_(actorId, action, target, detail) {
  var sheet = getOrCreateSheet_('AuditLog', AUDIT_LOG_HEADERS)
  var values = { at: new Date().toISOString(), actor_id: String(actorId || ''), action: String(action), target: String(target || ''), detail_json: JSON.stringify(detail || {}) }
  var headers = headerRow_(sheet)
  var row = headers.map(function (h) { return values[h] === undefined ? '' : values[h] })
  sheet.appendRow(row)
}

// ---- 全体を戻す ----

// シートを { 名前: 値の2次元配列 } で読む
function sheetValuesOf_(spreadsheet) {
  var out = {}
  spreadsheet.getSheets().forEach(function (s) {
    var name = String(s.getName())
    if (RESTORE_EXCLUDED_SHEETS.indexOf(name) >= 0) return
    out[name] = s.getDataRange().getValues()
  })
  return out
}

function dataRowCount_(values) {
  return Math.max(0, (values || []).filter(function (r) { return r.some(function (v) { return v !== '' && v !== null }) }).length - 1)
}

// 戻す前に見せる、シートごとの件数(今・バックアップ)
function previewRestore_(backupId) {
  var b = backupById_(backupId)
  var current = sheetValuesOf_(SpreadsheetApp.getActiveSpreadsheet())
  var backup = sheetValuesOf_(SpreadsheetApp.openById(b.id))
  var names = Object.keys(backup)
  Object.keys(current).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n) })
  return {
    backup: b,
    sheets: names.map(function (n) {
      return { name: n, current: n in current ? dataRowCount_(current[n]) : null, backup: n in backup ? dataRowCount_(backup[n]) : null }
    }),
  }
}

// 全体を戻す(代表だけ。ロックを取った書き込みの中で呼ぶ)
function restoreBackup_(backupId, actorId, nowMs) {
  nowMs = nowMs || Date.now()
  var b = backupById_(backupId)
  var props = PropertiesService.getScriptProperties()
  props.setProperty(RESTORE_STATE_KEY, JSON.stringify({ by: actorId, startedAt: new Date(nowMs).toISOString(), backupId: b.id }))
  try {
    var before = createBackup_('beforeRestore', nowMs)
    var src = SpreadsheetApp.openById(b.id)
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    var restored = []
    src.getSheets().forEach(function (s) {
      var name = String(s.getName())
      if (RESTORE_EXCLUDED_SHEETS.indexOf(name) >= 0) return
      var range = s.getDataRange()
      var values = range.getValues()
      var formats = range.getNumberFormats()
      var dst = ss.getSheetByName(name) || ss.insertSheet(name)
      dst.clearContents()
      if (values.length && values[0].length) {
        var target = dst.getRange(1, 1, values.length, values[0].length)
        // 書式(文字として扱う列など)を先に戻し、値が数式として扱われないようにする
        target.setNumberFormats(formats)
        target.setValues(values)
      }
      restored.push(name)
    })
    SpreadsheetApp.flush()
    forgetSheetGrid_()
    bumpDataVersion()
    bumpMemberEmailsVersion_()
    appendOrgAudit_(actorId, 'restoreBackup', b.name, { backupId: b.id, beforeRestore: before.name, sheets: restored })
    // 戻した中に、保存期間を過ぎた個人情報があれば、すぐに消し直す
    purgeExpiredPersonalData_(nowMs, actorId)
    try { pruneBackups_(nowMs) } catch (e) { console.error('古いバックアップを片付けられませんでした: ' + e) }
    return { restored: restored, beforeRestore: before }
  } finally {
    props.deleteProperty(RESTORE_STATE_KEY)
  }
}

// ---- 一部のタスクだけ戻す ----

function taskTableOf_(values) {
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rows = {}
  values.slice(1).forEach(function (r) {
    var id = idCol >= 0 ? String(r[idCol]) : ''
    if (!id) return
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    rows[id] = o
  })
  return { headers: headers, rows: rows }
}

function parseJsonList_(v) {
  try {
    var list = JSON.parse(String(v || '[]'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function listCellText_(v) { return String(v === null || v === undefined ? '' : v).slice(0, 200) }

// バックアップのタスクを名前で探し、今の内容との違いを返す。今は消えているタスクは state: 'missing'(画面は「復元」と出す)
function searchBackupTasks_(backupId, query) {
  var b = backupById_(backupId)
  var q = String(query || '').trim().toLowerCase()
  if (!q) throw userError_('タスクの名前を入れてください。')
  var backup = taskTableOf_(SpreadsheetApp.openById(b.id).getSheetByName(SHEET_TASKS).getDataRange().getValues())
  var current = taskTableOf_(getSheet_(SHEET_TASKS).getDataRange().getValues())
  // TasksArchive に移したタスクは、移した内容と比べる(archived: true。戻すと Tasks に戻る)
  var archivedIds = {}
  archivedTaskRows_().forEach(function (t) {
    var id = String(t.id)
    if (current.rows[id]) return
    current.rows[id] = t
    archivedIds[id] = true
  })
  var out = []
  Object.keys(backup.rows).forEach(function (id) {
    var bt = backup.rows[id]
    if (out.length >= BACKUP_SEARCH_MAX || String(bt.title || '').toLowerCase().indexOf(q) < 0) return
    var ct = current.rows[id]
    var diffs = []
    if (ct) {
      backup.headers.forEach(function (h) {
        if (!h || h === 'id' || h === 'last_activity') return
        var bv = String(bt[h] === undefined ? '' : bt[h])
        var cv = String(ct[h] === undefined ? '' : ct[h])
        if (bv === cv) return
        if (RESTORE_MERGED_TASK_LISTS.indexOf(h) >= 0) {
          diffs.push({ field: h, current: parseJsonList_(cv).length + '件', backup: parseJsonList_(bv).length + '件' })
        } else {
          diffs.push({ field: h, current: listCellText_(cv), backup: listCellText_(bv) })
        }
      })
    }
    var item = { id: id, title: String(bt.title || ''), currentTitle: ct ? String(ct.title || '') : '', state: !ct ? 'missing' : diffs.length ? 'changed' : 'same', diffs: diffs }
    if (archivedIds[id]) item.archived = true
    out.push(item)
  })
  return { backup: b, tasks: out }
}

// 記録の一覧を合わせる: バックアップの内容に、バックアップの後に付いたもの(ID が無いものは中身で比べる)を足す
function mergeTaskList_(backupList, currentList, newestFirst) {
  var keyOf = function (e) { return e && e.id ? 'id:' + e.id : 'v:' + JSON.stringify(e) }
  var seen = {}
  backupList.forEach(function (e) { seen[keyOf(e)] = true })
  var added = currentList.filter(function (e) { return !seen[keyOf(e)] })
  return newestFirst ? added.concat(backupList) : backupList.concat(added)
}

// 選んだタスクを戻す(代表だけ。ロックを取った書き込みの中で呼ぶ)
function restoreTasks_(backupId, taskIds, actorId, nowMs) {
  nowMs = nowMs || Date.now()
  var b = backupById_(backupId)
  var ids = []
  ;(Array.isArray(taskIds) ? taskIds : []).forEach(function (id) { if (id && ids.indexOf(String(id)) < 0) ids.push(String(id)) })
  if (!ids.length) throw userError_('戻すタスクを選んでください。')
  if (ids.length > RESTORE_TASKS_MAX) throw userError_('一度に戻せるタスクは ' + RESTORE_TASKS_MAX + ' 件までです。')
  var srcSheet = SpreadsheetApp.openById(b.id).getSheetByName(SHEET_TASKS)
  var srcValues = srcSheet.getDataRange().getValues()
  var backup = taskTableOf_(srcValues)
  var sheet = getSheet_(SHEET_TASKS)
  var liveValues = sheet.getDataRange().getValues()
  var headers = (liveValues[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rowOf = {}
  for (var i = 1; i < liveValues.length; i++) rowOf[String(liveValues[i][idCol])] = i
  var label = Utilities.formatDate(new Date(b.at), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  // TasksArchive に移したタスクは、移した内容を今の内容として合わせ、Tasks に戻す(TasksArchive からは消す)
  var archived = {}
  archivedTaskRows_().forEach(function (t) { if (rowOf[String(t.id)] === undefined) archived[String(t.id)] = t })
  var unarchived = []
  var done = []
  ids.forEach(function (id) {
    var bt = backup.rows[id]
    if (!bt) return
    var cur = rowOf[id] !== undefined ? liveValues[rowOf[id]] : null
    if (!cur && archived[id]) {
      cur = headers.map(function (h) { return archived[id][h] === undefined ? '' : archived[id][h] })
      unarchived.push(id)
    }
    var isLive = rowOf[id] !== undefined
    var row = headers.map(function (h, c) {
      if (RESTORE_MERGED_TASK_LISTS.indexOf(h) < 0) return bt[h] === undefined ? (cur ? cur[c] : '') : bt[h]
      var merged = mergeTaskList_(parseJsonList_(bt[h]), parseJsonList_(cur ? cur[c] : '[]'), h === 'history_json')
      if (h === 'history_json') {
        merged.unshift({ id: 'h-restore-' + Utilities.getUuid(), at: new Date(nowMs).toISOString(), byId: String(actorId), field: 'restored', from: label, to: '' })
        merged = merged.slice(0, HISTORY_CAP)
      }
      return JSON.stringify(merged)
    })
    var rowNumber = isLive ? rowOf[id] + 1 : sheet.getLastRow() + 1
    var target = sheet.getRange(rowNumber, 1, 1, headers.length)
    // 文字として扱う列は、値を書く前に書式を文字にする(数式として扱われないように)
    protectRowFromFormulaInjection_(sheet, headers, rowNumber, SHEET_TASKS)
    target.setValues([row])
    if (!isLive) rowOf[id] = rowNumber - 1
    done.push({ id: id, title: String(bt.title || ''), state: isLive ? 'restored' : archived[id] ? 'unarchived' : 'recreated' })
  })
  if (unarchived.length) deleteRowsById_(tasksArchiveSheet_(false), unarchived)
  // データの版は、書き込みの後の bumpVersionsAfterWrite_ が上げる
  forgetSheetGrid_(SHEET_TASKS)
  appendOrgAudit_(actorId, 'restoreTasks', b.name, { backupId: b.id, tasks: done })
  // 戻した中に、保存期間を過ぎた個人情報があれば、すぐに消し直す
  purgeExpiredPersonalData_(nowMs, actorId)
  return { restored: done }
}

