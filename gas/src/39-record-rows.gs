// ---- 記録を1件1行のシートに持つ(TaskRecords・MemberRecords) ----------------------------------
//
// タスクのコメント・進み具合の記録・変更の記録と、メンバーの 1on1 の記録・評価は、以前は1つのセルに一覧(JSON)で
// 持っていた(1つのセルは5万文字まで)。移行(migrateRecordsToRows。下)の後は、1件1行で次のシートに持つ:
//   TaskRecords   key, task_id, kind(comment / progress / history), entry_id, seq(一覧の中の順番), at, by_id, body_json, updated_at
//   MemberRecords key, member_id, kind(one_on_one / evaluation), entry_id, seq, at, with_id, body_json, updated_at
// body_json は一覧の1項目をそのまま JSON にしたもの(1件は5万文字まで)。key は <親のID>:<kind>:<entry_id>。
//
// どちらに持っているかは、Settings のキー record_rows_state(JSON の state: none / migrating / done)で決める
// (バックアップから戻した時に、データと一緒に戻るように、シートの中に置く)。READ_POLICY に書かないので画面には返さない。
//   none / migrating  これまでどおりセルに持つ(migrating は、移している間。記録の一覧への書き込みを止める)
//   done              行に持つ。Tasks・Members の一覧の列は空にし、読む時に行から今と同じ一覧(JSON)を組み立てる
// 組み立てる場所(読み取りの入口): スナップショット(loadSnapshot_)・書き込みの表(loadSheetGrid_)・findRow_・
// snapshotTableOrSheet_ の予備の読み方。書く場所: updateRowFields_・appendRowByHeaders_ が、一覧の列を行に書き分ける。
// 画面は、初期データの recordRows(状態)で見分ける(古い GAS には無い)
var SHEET_TASK_RECORDS = 'TaskRecords'
var SHEET_MEMBER_RECORDS = 'MemberRecords'
var TASK_RECORDS_HEADERS = ['key', 'task_id', 'kind', 'entry_id', 'seq', 'at', 'by_id', 'body_json', 'updated_at']
var MEMBER_RECORDS_HEADERS = ['key', 'member_id', 'kind', 'entry_id', 'seq', 'at', 'with_id', 'body_json', 'updated_at']
var RECORD_ROWS_STATE_KEY = 'record_rows_state'
// 行に移す一覧(シートと列 → 移す先と kind)
var RECORD_LISTS = [
  { sheet: 'Tasks', column: 'comments_json', kind: 'comment', target: 'TaskRecords', parentCol: 'task_id' },
  { sheet: 'Tasks', column: 'progress_history_json', kind: 'progress', target: 'TaskRecords', parentCol: 'task_id' },
  { sheet: 'Tasks', column: 'history_json', kind: 'history', target: 'TaskRecords', parentCol: 'task_id' },
  { sheet: 'Members', column: 'one_on_ones_json', kind: 'one_on_one', target: 'MemberRecords', parentCol: 'member_id' },
  { sheet: 'Members', column: 'evaluation_history_json', kind: 'evaluation', target: 'MemberRecords', parentCol: 'member_id' },
]
// 変更の記録の上限(セルに持つ間は、5万文字に入るよう50件。行に持った後は500件)
var HISTORY_CAP_CELLS = 50
var HISTORY_CAP_ROWS = 500
var RECORD_ROWS_BUSY_MESSAGE = 'データの持ち方を移しています。数分たってから、もう一度お試しください。書いた文章は消えていないので、コピーして残してください。'
// 移している印が残ったまま(途中で止まった時)でも、これを過ぎたら記録の書き込みを受け付ける(セルが正のまま)
var RECORD_ROWS_STALE_MS = 30 * 60 * 1000

var _recordRowsStateMemo = null
var _recordGrids = {}

function resetRecordRowsMemo_() {
  _recordRowsStateMemo = null
  _recordGrids = {}
}

function parseRecordRowsState_(raw) {
  var s = null
  try { s = JSON.parse(String(raw || '')) } catch (e) { s = null }
  if (!s || typeof s !== 'object') return { state: 'none' }
  if (['none', 'migrating', 'done', 'reverting', 'failed'].indexOf(s.state) < 0) s.state = 'none'
  return s
}

// 今の状態。このリクエストで読んだスナップショットがあれば、その Settings から読む(書き込みのたびにシートを読まない)。
// 読めない時は none(セルに持つ)
function recordRowsState_() {
  if (_recordRowsStateMemo) return _recordRowsStateMemo
  var s
  try {
    s = _requestSnapshot && _requestSnapshot.data ? recordRowsStateOfSnapshot_(_requestSnapshot.data) : parseRecordRowsState_(getSettingValue_(RECORD_ROWS_STATE_KEY))
  } catch (e) {
    s = { state: 'none' }
  }
  _recordRowsStateMemo = s
  return s
}

function setRecordRowsState_(fields) {
  var s = Object.assign({}, fields)
  updateSetting_(RECORD_ROWS_STATE_KEY, JSON.stringify(s))
  _recordRowsStateMemo = s
  return s
}

// 行が正か(done と、戻している間 reverting)。none・migrating・failed はセルが正
function recordRowsOn_() {
  var s = recordRowsState_().state
  return s === 'done' || s === 'reverting'
}

// 移している間か(止まってから RECORD_ROWS_STALE_MS を過ぎたものは数えない)
function recordRowsBusy_(nowMs) {
  var s = recordRowsState_()
  if (s.state !== 'migrating' && s.state !== 'reverting') return false
  var at = Date.parse(String(s.touchedAt || s.since || ''))
  return !(isFinite(at) && (nowMs || Date.now()) - at > RECORD_ROWS_STALE_MS)
}

function historyCap_() {
  return recordRowsOn_() ? HISTORY_CAP_ROWS : HISTORY_CAP_CELLS
}

function recordListsOf_(sheetName) {
  return RECORD_LISTS.filter(function (c) { return c.sheet === sheetName })
}

function recordListOf_(sheetName, column) {
  for (var i = 0; i < RECORD_LISTS.length; i++) {
    if (RECORD_LISTS[i].sheet === sheetName && RECORD_LISTS[i].column === column) return RECORD_LISTS[i]
  }
  return null
}

function isRecordColumn_(sheetName, column) {
  return !!recordListOf_(sheetName, column)
}

function recordHeadersOf_(target) {
  return target === SHEET_TASK_RECORDS ? TASK_RECORDS_HEADERS : MEMBER_RECORDS_HEADERS
}

// 記録のシートを作る(無ければ)。値は文字のまま持つ(日付・数に変えられないように、書式なしテキストにする)
function ensureRecordSheet_(target) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(target)
  var headers = recordHeadersOf_(target)
  if (!sheet) {
    sheet = ss.insertSheet(target)
    sheet.appendRow(headers)
  } else {
    ensureSheetHeaders_(ss, target, headers)
  }
  try { sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), recordHeadersOf_(target).length).setNumberFormat('@') } catch (e) { /* 形式を変えられない時 */ }
  return sheet
}

// ---- 読む ----

// 記録のシートを読み、親ごと・kind ごとにまとめる(このリクエストの中で覚える)。values は getValues の形
function recordIndexFromValues_(values) {
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var col = {}
  headers.forEach(function (h, i) { col[h] = i })
  var parentCol = col.task_id !== undefined ? col.task_id : col.member_id
  var byParent = {}
  for (var r = 1; r < values.length; r++) {
    var v = values[r]
    var key = String(v[col.key] === undefined ? '' : v[col.key])
    if (!key) continue
    var parent = String(v[parentCol])
    var kind = String(v[col.kind])
    var list = (byParent[parent] = byParent[parent] || {})
    ;(list[kind] = list[kind] || []).push({
      row: r + 1, key: key, entryId: String(v[col.entry_id]), seq: Number(v[col.seq]) || 0, body: String(v[col.body_json] || ''),
    })
  }
  Object.keys(byParent).forEach(function (p) {
    Object.keys(byParent[p]).forEach(function (k) { byParent[p][k].sort(function (a, b) { return a.seq - b.seq }) })
  })
  return { headers: headers, col: col, byParent: byParent }
}

function loadRecordIndex_(target) {
  if (_recordGrids[target]) return _recordGrids[target]
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(target)
  var values = sheet ? sheet.getDataRange().getValues() : [recordHeadersOf_(target)]
  if (!values.length || !values[0].length || String(values[0][0]) === '') values = [recordHeadersOf_(target)]
  var index = recordIndexFromValues_(values)
  index.sheet = sheet
  _recordGrids[target] = index
  return index
}

function forgetRecordIndex_(target) {
  if (target) delete _recordGrids[target]
  else _recordGrids = {}
}

function parseRecordBody_(body) {
  try { return JSON.parse(body) } catch (e) { return null }
}

// 親の1つの一覧(順番どおり)
function recordListFromIndex_(index, parentId, kind) {
  var items = ((index.byParent[String(parentId)] || {})[kind]) || []
  var out = []
  items.forEach(function (it) {
    var v = parseRecordBody_(it.body)
    if (v !== null) out.push(v)
  })
  return out
}

// 行の値(見出しの順の配列)の一覧の列に、行から組み立てた一覧(JSON)を入れる
function fillRecordColumns_(sheetName, headers, rowValues, indexOf) {
  var lists = recordListsOf_(sheetName)
  if (!lists.length) return
  var idCol = headers.indexOf('id')
  if (idCol < 0) return
  var id = String(rowValues[idCol])
  if (!id) return
  lists.forEach(function (cfg) {
    var c = headers.indexOf(cfg.column)
    if (c < 0) return
    rowValues[c] = JSON.stringify(recordListFromIndex_(indexOf(cfg.target), id, cfg.kind))
  })
}

// 表(headers・rows)の全部の行に組み立てる(行に持っている時だけ)
function fillRecordColumnsOfTable_(sheetName, table, indexOf) {
  if (!table || !table.headers || !recordListsOf_(sheetName).length) return
  ;(table.rows || []).forEach(function (row) { fillRecordColumns_(sheetName, table.headers, row, indexOf) })
}

// スナップショットの Settings から読んだ状態
function recordRowsStateOfSnapshot_(data) {
  var settings = data && data[SHEET_SETTINGS]
  var raw = ''
  if (settings && settings.headers) {
    var k = settings.headers.indexOf('key'), v = settings.headers.indexOf('value')
    ;(settings.rows || []).forEach(function (r) { if (String(r[k]) === RECORD_ROWS_STATE_KEY) raw = r[v] })
  }
  return parseRecordRowsState_(raw)
}

// スナップショット(Members・Projects・Tasks・Settings)に組み立てる。状態はスナップショットの Settings から読む
function fillRecordColumnsOfSnapshot_(data) {
  if (recordRowsStateOfSnapshot_(data).state !== 'done') return data
  var tables = readSheetTables_([SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS])
  var indexes = {}
  var indexOf = function (target) {
    if (!indexes[target]) {
      var t = tables[target] || { headers: [], rows: [] }
      indexes[target] = recordIndexFromValues_([t.headers && t.headers.length ? t.headers : recordHeadersOf_(target)].concat(t.rows || []))
    }
    return indexes[target]
  }
  fillRecordColumnsOfTable_(SHEET_TASKS, data[SHEET_TASKS], indexOf)
  fillRecordColumnsOfTable_(SHEET_MEMBERS, data[SHEET_MEMBERS], indexOf)
  return data
}

// 書き込みの表・1行の読み取り(getValues の形)に組み立てる
function fillRecordColumnsOfValues_(sheetName, values) {
  if (!recordListsOf_(sheetName).length || !recordRowsOn_()) return
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  for (var i = 1; i < values.length; i++) fillRecordColumns_(sheetName, headers, values[i], loadRecordIndex_)
}

function fillRecordColumnsOfRow_(sheetName, headers, rowValues) {
  if (!recordListsOf_(sheetName).length || !recordRowsOn_()) return
  fillRecordColumns_(sheetName, headers, rowValues, loadRecordIndex_)
}

// ---- 書く ----

// 1件の記録の行(見出しの順の配列)
function recordRowValues_(cfg, parentId, entry, seq, entryId, nowIso) {
  var body = JSON.stringify(entry)
  if (body.length > CELL_MAX_CHARS) throw cellTooLongError_(cfg.target, cfg.column, body, null)
  var o = {
    key: String(parentId) + ':' + cfg.kind + ':' + entryId,
    task_id: String(parentId), member_id: String(parentId), kind: cfg.kind, entry_id: entryId, seq: String(seq),
    at: String((entry && (entry.at || entry.date)) || ''),
    by_id: String((entry && (entry.byId || entry.by)) || ''),
    with_id: String((entry && (entry.withId || entry.evaluatorId || entry.byId)) || ''),
    body_json: body, updated_at: nowIso,
  }
  return recordHeadersOf_(cfg.target).map(function (h) { return o[h] === undefined ? '' : o[h] })
}

function recordEntryId_(entry, seq) {
  var id = entry && typeof entry === 'object' && entry.id !== undefined && entry.id !== null ? String(entry.id) : ''
  return id || 'noid-' + seq
}

// 親の1つの一覧を、list(配列)と同じ中身・順番にする(足す・変える・消す)。何も変わらなければ書かない
function writeRecordList_(cfg, parentId, list) {
  return syncRecordListsBulk_(cfg.target, [{ cfg: cfg, parentId: parentId, list: list }]) > 0
}

// 記録のシート1枚について、いくつもの(親・kind)の一覧をまとめて、渡した一覧と同じにする。変えた行の数を返す。
// items: [{ cfg, parentId, list }]。シートは1回だけ読み、足す行はまとめて1回で書く
function syncRecordListsBulk_(target, items) {
  var sheet = ensureRecordSheet_(target)
  forgetRecordIndex_(target)
  var index = loadRecordIndex_(target)
  var nowIso = new Date().toISOString()
  var width = recordHeadersOf_(target).length
  var updates = []
  var appends = []
  var removes = []
  items.forEach(function (item) {
    var cfg = item.cfg
    var list = Array.isArray(item.list) ? item.list : []
    var current = ((index.byParent[String(item.parentId)] || {})[cfg.kind]) || []
    var byKey = {}
    current.forEach(function (it) { byKey[it.key] = it })
    var keep = {}
    list.forEach(function (entry, seq) {
      var row = recordRowValues_(cfg, item.parentId, entry, seq, recordEntryId_(entry, seq), nowIso)
      var key = row[0]
      if (keep[key]) return // 同じ ID が2つある時は、最初の1つだけ
      keep[key] = true
      var old = byKey[key]
      if (!old) { appends.push(row); return }
      if (old.body === row[index.col.body_json] && old.seq === seq) return
      updates.push({ row: old.row, values: row })
    })
    current.forEach(function (it) { if (!keep[it.key]) removes.push(it.row) })
  })
  if (!updates.length && !appends.length && !removes.length) return 0
  updates.forEach(function (u) { sheet.getRange(u.row, 1, 1, width).setValues([u.values]) })
  removes.sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  if (appends.length) {
    var start = sheet.getLastRow() + 1
    var need = start + appends.length - 1 - sheet.getMaxRows()
    if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need)
    var range = sheet.getRange(start, 1, appends.length, width)
    try { range.setNumberFormat('@') } catch (e) { /* 形式を変えられない時 */ }
    range.setValues(appends)
  }
  forgetRecordIndex_(target)
  return updates.length + appends.length + removes.length
}

// 書き込み(列の名前 → 値)のうち、一覧の列を行に書き、残りの列だけを返す。行に持っていない時はそのまま返す
function splitRecordFields_(sheetName, rowId, fields) {
  if (!recordListsOf_(sheetName).length || !recordRowsOn_()) return fields
  var rest = {}
  Object.keys(fields).forEach(function (k) {
    var cfg = recordListOf_(sheetName, k)
    if (!cfg) { rest[k] = fields[k]; return }
    var list = []
    var v = fields[k]
    if (Array.isArray(v)) list = v
    else if (v !== '' && v !== null && v !== undefined) {
      try { list = JSON.parse(String(v)) } catch (e) { throw userError_('記録の形式が不正です。') }
      if (!Array.isArray(list)) throw userError_('記録の形式が不正です。')
    }
    writeRecordList_(cfg, rowId, list)
  })
  return rest
}

// 書き込みの表(このリクエストで覚えている Tasks・Members)の一覧の列を、書いた値にする(続けて読む処理のため)
function noteRecordFieldsInGrid_(sheetName, rowId, recordFields) {
  var grid = _sheetGrids[sheetName]
  if (!grid) return
  var r = grid.rowOf[String(rowId)]
  if (!r || !grid.values[r - 1]) return
  Object.keys(recordFields).forEach(function (k) {
    var c = grid.headers.indexOf(k)
    if (c < 0) return
    var v = recordFields[k]
    grid.values[r - 1][c] = Array.isArray(v) ? JSON.stringify(v) : String(v === null || v === undefined || v === '' ? '[]' : v)
  })
}

// 記録の一覧への書き込みを、移している間は断る
function assertRecordWritable_(sheetName, fields) {
  if (!recordListsOf_(sheetName).length) return
  var touches = Object.keys(fields).some(function (k) { return isRecordColumn_(sheetName, k) })
  if (touches && recordRowsBusy_(Date.now())) throw userError_(RECORD_ROWS_BUSY_MESSAGE)
}

// 親(タスク・メンバー)の行を消した時に、その記録の行も消す
function deleteRecordsOfParents_(sheetName, ids) {
  if (!ids || !ids.length || !recordRowsOn_()) return
  var targets = {}
  recordListsOf_(sheetName).forEach(function (c) { targets[c.target] = true })
  var wanted = {}
  ids.forEach(function (id) { wanted[String(id)] = true })
  Object.keys(targets).forEach(function (target) {
    var index = loadRecordIndex_(target)
    if (!index.sheet) return
    var rows = []
    Object.keys(index.byParent).forEach(function (p) {
      if (!wanted[p]) return
      Object.keys(index.byParent[p]).forEach(function (k) { index.byParent[p][k].forEach(function (it) { rows.push(it.row) }) })
    })
    rows.sort(function (a, b) { return b - a }).forEach(function (r) { index.sheet.deleteRow(r) })
    forgetRecordIndex_(target)
  })
}

// 新しい団体(setupOhsumi)は、最初から行に持つ。一覧の列にまだ何も入っていなければ、印を done にする
function startRecordRowsIfEmpty_() {
  var s = recordRowsState_()
  if (s.state !== 'none' || s.decided) return s
  ensureRecordSheet_(SHEET_TASK_RECORDS)
  ensureRecordSheet_(SHEET_MEMBER_RECORDS)
  if (countCellRecords_().entries > 0) return s
  return setRecordRowsState_({ state: 'done', since: new Date().toISOString(), by: 'setup', version: 1 })
}

// セルに入っている記録の数(移行の試しと、新しい団体の見分けに使う)
function countCellRecords_() {
  var out = { entries: 0, parents: 0, unreadable: [], duplicates: [], tooLong: [], perList: {} }
  ;['Tasks', 'Members'].forEach(function (sheetName) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
    if (!sheet || sheet.getLastRow() < 2) return
    var values = sheet.getDataRange().getValues()
    var headers = (values[0] || []).map(function (h) { return String(h).trim() })
    var idCol = headers.indexOf('id')
    recordListsOf_(sheetName).forEach(function (cfg) {
      var c = headers.indexOf(cfg.column)
      var n = 0
      if (c < 0) { out.perList[cfg.kind] = 0; return }
      for (var i = 1; i < values.length; i++) {
        var raw = String(values[i][c] || '')
        if (!raw || raw === '[]') continue
        var list = null
        try { list = JSON.parse(raw) } catch (e) { list = null }
        var id = String(values[i][idCol])
        if (!Array.isArray(list)) { out.unreadable.push(sheetName + ':' + id + ':' + cfg.column); continue }
        out.parents++
        var seen = {}
        list.forEach(function (entry, seq) {
          var eid = recordEntryId_(entry, seq)
          if (seen[eid]) out.duplicates.push(sheetName + ':' + id + ':' + cfg.kind + ':' + eid)
          seen[eid] = true
          if (JSON.stringify(entry).length > CELL_MAX_CHARS) out.tooLong.push(sheetName + ':' + id + ':' + cfg.kind + ':' + eid)
        })
        n += list.length
      }
      out.perList[cfg.kind] = n
      out.entries += n
    })
  })
  return out
}

// ---- バックアップから戻す時 ----

// ほかのスプレッドシート(バックアップ)の Tasks・Members の値に、そのスプレッドシートの記録のシートから一覧を組み立てる
function fillRecordColumnsFromSpreadsheet_(spreadsheet, sheetName, values) {
  if (!recordListsOf_(sheetName).length) return values
  var settings = spreadsheet.getSheetByName(SHEET_SETTINGS)
  var raw = ''
  if (settings && settings.getLastRow() > 1) {
    settings.getDataRange().getValues().forEach(function (r) { if (String(r[0]) === RECORD_ROWS_STATE_KEY) raw = r[1] })
  }
  if (parseRecordRowsState_(raw).state !== 'done') return values
  var indexes = {}
  var indexOf = function (target) {
    if (!indexes[target]) {
      var s = spreadsheet.getSheetByName(target)
      var v = s ? s.getDataRange().getValues() : [recordHeadersOf_(target)]
      indexes[target] = recordIndexFromValues_(v.length && v[0].length ? v : [recordHeadersOf_(target)])
    }
    return indexes[target]
  }
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  for (var i = 1; i < values.length; i++) fillRecordColumns_(sheetName, headers, values[i], indexOf)
  return values
}

// 全体を戻した後: バックアップに無かった記録のシート(移行の前のバックアップ)は空にする
function afterFullRestoreRecordRows_(restoredNames) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ;[SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS].forEach(function (name) {
    if (restoredNames.indexOf(name) >= 0) return
    var sheet = ss.getSheetByName(name)
    if (!sheet) return
    sheet.clearContents()
    sheet.getRange(1, 1, 1, recordHeadersOf_(name).length).setValues([recordHeadersOf_(name)])
  })
  resetRecordRowsMemo_()
}

// ---- 移す・照合する・戻す(代表だけ。ADMIN の「データの持ち方」から1回ずつ呼ぶ) -------------------------
//
// migrateRecordsToRows_(試す / 進める):
//   試す(dryRun)   書かずに、一覧ごとの件数・読めない一覧・同じ ID の重なり・1件が長すぎる記録を返す
//   1回目           問題があれば止める。実行の前に自動でバックアップを取り(「(移行の前)」)、印を migrating にする
//                   (移している間は、記録の一覧への書き込みを断る。30分止まったままなら受け付ける)
//   移す(copy)      Tasks → Members の順に、親の行を MIGRATE_BATCH 件ずつ記録のシートに写す。進んだ位置(cursor)を
//                   印に残すので、途中で止まっても続きから。写すのは「セルと同じにする」なので、何度やっても重ならない
//   照合(verify)    すべての親について、セルの一覧と行から組み立てた一覧を比べる(件数と中身)。違う親は写し直して
//                   もう一度比べ、それでも違えば failed にして止める(セルが正のまま。何も変わらない)
//   切り替え        印を done にしてから、セルの一覧の列を空にする。版を上げ、操作の記録(AuditLog)に残す
// revertRecordRows_(試す / 戻す):
//   行から今の形の一覧を組み立て、5万文字を超える親があれば止める。実行の前に自動でバックアップを取り
//   (「(移行を戻す前)」)、セルに書き、照合してから印を none にし、記録のシートを空にする
var MIGRATE_BATCH = 100
var MIGRATE_TIME_BUDGET_MS = 4 * 60 * 1000

function recordCellTables_(names) {
  var out = {}
  ;(names || ['Tasks', 'Members']).forEach(function (sheetName) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
    var values = sheet ? sheet.getDataRange().getValues() : [[]]
    out[sheetName] = { sheet: sheet, values: values, headers: (values[0] || []).map(function (h) { return String(h).trim() }) }
  })
  return out
}

function cellListOf_(table, rowValues, cfg) {
  var c = table.headers.indexOf(cfg.column)
  if (c < 0) return []
  var raw = String(rowValues[c] || '')
  if (!raw) return []
  var v = null
  try { v = JSON.parse(raw) } catch (e) { v = null }
  return Array.isArray(v) ? v : []
}

// 今の状態と件数(ADMIN の「データの持ち方」)
function recordRowsStatus_() {
  resetRecordRowsMemo_()
  var s = recordRowsState_()
  var out = { state: s.state, since: s.since || '', phase: s.phase || '', cursor: s.cursor || null, backup: s.backupName || '', counts: s.counts || null, message: s.message || '' }
  if (s.state === 'done') {
    var rows = {}
    ;[SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS].forEach(function (target) {
      var index = loadRecordIndex_(target)
      Object.keys(index.byParent).forEach(function (p) {
        Object.keys(index.byParent[p]).forEach(function (k) { rows[k] = (rows[k] || 0) + index.byParent[p][k].length })
      })
    })
    out.rows = rows
  } else {
    var c = countCellRecords_()
    out.cells = c.perList
    out.problems = { unreadable: c.unreadable.slice(0, 20), duplicates: c.duplicates.slice(0, 20), tooLong: c.tooLong.slice(0, 20) }
  }
  return out
}

function touchRecordRowsState_(fields) {
  var s = Object.assign({}, recordRowsState_(), fields, { touchedAt: new Date().toISOString() })
  return setRecordRowsState_(s)
}

function migrateRecordsToRows_(actorId, opts, nowMs) {
  opts = opts || {}
  nowMs = nowMs || Date.now()
  var started = Date.now()
  resetRecordRowsMemo_()
  var s = recordRowsState_()
  if (s.state === 'done') return { state: 'done', done: true }
  if (s.state === 'reverting') throw userError_('戻している途中です。先に「戻す」を最後まで進めてください。')
  if (opts.dryRun) {
    var c = countCellRecords_()
    return { dryRun: true, state: s.state, counts: c.perList, entries: c.entries, parents: c.parents,
      problems: { unreadable: c.unreadable.slice(0, 50), duplicates: c.duplicates.slice(0, 50), tooLong: c.tooLong.slice(0, 50) },
      ok: !c.unreadable.length && !c.tooLong.length }
  }
  if (s.state !== 'migrating') {
    // 1回目: 確かめて、バックアップを取ってから始める
    var check = countCellRecords_()
    if (check.unreadable.length || check.tooLong.length) {
      throw userError_('移せない記録があります(読めない一覧 ' + check.unreadable.length + ' 件・長すぎる記録 ' + check.tooLong.length +
        ' 件)。「試す」で場所を確かめてください: ' + check.unreadable.concat(check.tooLong).slice(0, 5).join('、'))
    }
    var backup = createBackup_('beforeMigration', nowMs)
    ensureRecordSheet_(SHEET_TASK_RECORDS)
    ensureRecordSheet_(SHEET_MEMBER_RECORDS)
    s = setRecordRowsState_({ state: 'migrating', since: new Date(nowMs).toISOString(), touchedAt: new Date(nowMs).toISOString(), by: String(actorId),
      backupId: backup.id, backupName: backup.name, phase: 'copy', cursor: { sheet: 'Tasks', index: 0 }, counts: check.perList, version: 1 })
    appendOrgAudit_(actorId, 'migrateRecordsToRows', 'start', { backup: backup.name, counts: check.perList })
  }
  var tables = recordCellTables_()
  // 移す(続きから)
  while (s.phase === 'copy') {
    var cur = s.cursor || { sheet: 'Tasks', index: 0 }
    var table = tables[cur.sheet]
    var rows = table.values.slice(1)
    var idCol = table.headers.indexOf('id')
    var end = Math.min(rows.length, cur.index + MIGRATE_BATCH)
    var byTarget = {}
    for (var i = cur.index; i < end; i++) {
      var id = String(rows[i][idCol] || '')
      if (!id) continue
      recordListsOf_(cur.sheet).forEach(function (cfg) {
        ;(byTarget[cfg.target] = byTarget[cfg.target] || []).push({ cfg: cfg, parentId: id, list: cellListOf_(table, rows[i], cfg) })
      })
    }
    Object.keys(byTarget).forEach(function (target) { syncRecordListsBulk_(target, byTarget[target]) })
    var next = end >= rows.length
      ? (cur.sheet === 'Tasks' ? { phase: 'copy', cursor: { sheet: 'Members', index: 0 } } : { phase: 'verify', cursor: null })
      : { phase: 'copy', cursor: { sheet: cur.sheet, index: end } }
    s = touchRecordRowsState_(next)
    if (s.phase === 'copy' && Date.now() - started > MIGRATE_TIME_BUDGET_MS) {
      return { state: 'migrating', phase: 'copy', cursor: s.cursor, done: false }
    }
  }
  // 照合する(違う親は1回だけ写し直す)
  var result = verifyRecordRows_(tables)
  if (result.mismatches.length) {
    var byT = {}
    result.mismatches.forEach(function (m) {
      ;(byT[m.cfg.target] = byT[m.cfg.target] || []).push({ cfg: m.cfg, parentId: m.parentId, list: m.cellList })
    })
    Object.keys(byT).forEach(function (target) { syncRecordListsBulk_(target, byT[target]) })
    result = verifyRecordRows_(tables)
  }
  if (result.mismatches.length) {
    var where = result.mismatches.slice(0, 10).map(function (m) { return m.cfg.sheet + ':' + m.parentId + ':' + m.cfg.kind })
    setRecordRowsState_(Object.assign({}, s, { state: 'failed', phase: 'verify', message: '照合が合いませんでした: ' + where.join('、') }))
    appendOrgAudit_(actorId, 'migrateRecordsToRows', 'failed', { mismatches: where })
    return { state: 'failed', done: false, mismatches: where }
  }
  // 切り替える: 先に印を done にしてから、セルの一覧の列を空にする(途中で止まっても、行が正になっている)
  s = setRecordRowsState_({ state: 'done', since: new Date().toISOString(), by: String(actorId), backupId: s.backupId, backupName: s.backupName,
    counts: result.counts, version: 1 })
  clearRecordCells_(tables)
  forgetSheetGrid_()
  bumpDataVersion()
  appendOrgAudit_(actorId, 'migrateRecordsToRows', 'done', { counts: result.counts, backup: s.backupName })
  return { state: 'done', done: true, counts: result.counts, backup: s.backupName }
}

// セルの一覧と、行から組み立てた一覧を比べる(件数と中身)。tables はセルの値(recordCellTables_)
function verifyRecordRows_(tables) {
  forgetRecordIndex_()
  var mismatches = []
  var counts = {}
  ;['Tasks', 'Members'].forEach(function (sheetName) {
    var table = tables[sheetName]
    var idCol = table.headers.indexOf('id')
    var seen = {}
    table.values.slice(1).forEach(function (row) {
      var id = String(row[idCol] || '')
      if (!id) return
      seen[id] = true
      recordListsOf_(sheetName).forEach(function (cfg) {
        var cellList = cellListOf_(table, row, cfg)
        var rowList = recordListFromIndex_(loadRecordIndex_(cfg.target), id, cfg.kind)
        counts[cfg.kind] = (counts[cfg.kind] || 0) + rowList.length
        if (cellList.length !== rowList.length || canonicalJson_(cellList) !== canonicalJson_(rowList)) {
          mismatches.push({ cfg: cfg, parentId: id, cellList: cellList })
        }
      })
    })
    // 親の行が無い記録(消したタスクの残りなど)も、違いとして消す
    recordListsOf_(sheetName).forEach(function (cfg) {
      var index = loadRecordIndex_(cfg.target)
      Object.keys(index.byParent).forEach(function (p) {
        if (seen[p] || !(index.byParent[p][cfg.kind] || []).length) return
        if (sheetName === 'Tasks' && isArchivedTaskId_(p)) return
        mismatches.push({ cfg: cfg, parentId: p, cellList: [] })
      })
    })
  })
  return { mismatches: mismatches, counts: counts }
}

// TasksArchive に移したタスクか(その記録は、TaskRecords に残してよい)
function isArchivedTaskId_(id) {
  if (!_archivedTaskIds) {
    _archivedTaskIds = {}
    try { archivedTaskRows_().forEach(function (t) { _archivedTaskIds[String(t.id)] = true }) } catch (e) { /* シートが無い */ }
  }
  return !!_archivedTaskIds[String(id)]
}
var _archivedTaskIds = null

function clearRecordCells_(tables) {
  ;['Tasks', 'Members'].forEach(function (sheetName) {
    var table = tables[sheetName]
    if (!table.sheet || table.values.length < 2) return
    recordListsOf_(sheetName).forEach(function (cfg) {
      var c = table.headers.indexOf(cfg.column)
      if (c < 0) return
      var blank = table.values.slice(1).map(function () { return [''] })
      table.sheet.getRange(2, c + 1, blank.length, 1).setValues(blank)
    })
  })
}

function revertRecordRows_(actorId, opts, nowMs) {
  opts = opts || {}
  nowMs = nowMs || Date.now()
  resetRecordRowsMemo_()
  var s = recordRowsState_()
  if (s.state === 'none') return { state: 'none', done: true }
  if (s.state === 'migrating' || s.state === 'failed') {
    // 移している途中・照合が合わなかった時: セルが正のままなので、記録のシートを空にして none に戻す
    if (opts.dryRun) return { dryRun: true, state: s.state, ok: true, tooLong: [] }
    clearRecordSheets_()
    setRecordRowsState_({ state: 'none', since: new Date(nowMs).toISOString(), by: String(actorId), decided: true })
    appendOrgAudit_(actorId, 'revertRecordRows', 'cancel', { from: s.state })
    bumpDataVersion()
    return { state: 'none', done: true }
  }
  // TasksArchive(移したタスク): 移行の後に移したタスクの記録は行にしか無いので、それもセルに戻す
  // (移行の前に移したタスクは、セルに一覧が残っていて行が無いので、そのままにする)
  var sheets = ['Tasks', 'Members', SHEET_TASKS_ARCHIVE]
  var tables = recordCellTables_(sheets)
  var listSheetOf = function (name) { return name === SHEET_TASKS_ARCHIVE ? 'Tasks' : name }
  forgetRecordIndex_()
  // 行から、今の形の一覧を組み立てる
  var built = []
  var tooLong = []
  sheets.forEach(function (sheetName) {
    var table = tables[sheetName]
    if (!table.sheet) return
    var idCol = table.headers.indexOf('id')
    table.values.slice(1).forEach(function (row, i) {
      var id = String(row[idCol] || '')
      if (!id) return
      recordListsOf_(listSheetOf(sheetName)).forEach(function (cfg) {
        var c = table.headers.indexOf(cfg.column)
        if (c < 0) return
        var list = recordListFromIndex_(loadRecordIndex_(cfg.target), id, cfg.kind)
        if (sheetName === SHEET_TASKS_ARCHIVE && !list.length) list = cellListOf_(table, row, cfg)
        var json = list.length ? JSON.stringify(list) : ''
        if (json.length > CELL_MAX_CHARS) tooLong.push(sheetName + ':' + id + ':' + cfg.kind + '(' + json.length + '文字)')
        built.push({ sheetName: sheetName, row: i + 2, col: c + 1, json: json, list: list })
      })
    })
  })
  if (opts.dryRun) return { dryRun: true, state: s.state, ok: !tooLong.length, tooLong: tooLong.slice(0, 50), parents: built.filter(function (b) { return b.list.length }).length }
  if (tooLong.length) throw userError_('セルに入らない(5万文字を超える)記録があるため、戻せません: ' + tooLong.slice(0, 5).join('、'))
  var backup = createBackup_('beforeRevert', nowMs)
  setRecordRowsState_(Object.assign({}, s, { state: 'reverting', touchedAt: new Date(nowMs).toISOString(), revertBackupName: backup.name }))
  // 列ごとに1回で書く
  sheets.forEach(function (sheetName) {
    var table = tables[sheetName]
    if (!table.sheet || table.values.length < 2) return
    recordListsOf_(listSheetOf(sheetName)).forEach(function (cfg) {
      var c = table.headers.indexOf(cfg.column)
      if (c < 0) return
      var col = table.values.slice(1).map(function () { return [''] })
      built.forEach(function (b) { if (b.sheetName === sheetName && b.col === c + 1) col[b.row - 2] = [b.json] })
      var range = table.sheet.getRange(2, c + 1, col.length, 1)
      try { range.setNumberFormat('@') } catch (e) { /* 形式を変えられない時 */ }
      range.setValues(col)
    })
  })
  // 照合: 書いたセルを読み直し、行から組み立てた一覧と同じか
  var after = recordCellTables_(sheets)
  var bad = built.filter(function (b) {
    var table = after[b.sheetName]
    var raw = String(table.values[b.row - 1][b.col - 1] || '')
    var got = raw ? JSON.parse(raw) : []
    return canonicalJson_(got) !== canonicalJson_(b.list)
  })
  if (bad.length) {
    setRecordRowsState_(Object.assign({}, s, { state: 'done' }))
    throw userError_('戻した記録の照合が合わなかったため、行に持ったままにしました(' + bad.length + ' 件)。')
  }
  setRecordRowsState_({ state: 'none', since: new Date().toISOString(), by: String(actorId), decided: true, revertBackupName: backup.name })
  clearRecordSheets_()
  forgetSheetGrid_()
  bumpDataVersion()
  appendOrgAudit_(actorId, 'revertRecordRows', 'done', { backup: backup.name })
  return { state: 'none', done: true, backup: backup.name }
}

function clearRecordSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ;[SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS].forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet) return
    sheet.clearContents()
    sheet.getRange(1, 1, 1, recordHeadersOf_(name).length).setValues([recordHeadersOf_(name)])
  })
  forgetRecordIndex_()
}
