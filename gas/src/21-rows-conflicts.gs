// ---- shared row helpers -----------------------------------------------------

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) throw userError_('Sheet not found: ' + name)
  return sheet
}

// Like getSheet_, but creates the tab (with the given header row) instead
// of throwing when it doesn't exist yet — used for the optional Settings
// tab so admins don't have to pre-create it before the first sync.
function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(name)
  if (sheet) return sheet
  sheet = ss.insertSheet(name)
  sheet.appendRow(headers)
  return sheet
}

function headerRow_(sheet) {
  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (h) {
      return String(h).trim()
    })
}

function nextIntId_(sheet, headers) {
  var idCol = headers.indexOf('id') + 1
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return 1
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues()
  var max = 0
  ids.forEach(function (r) {
    var n = parseInt(r[0], 10)
    if (!isNaN(n) && n > max) max = n
  })
  return max + 1
}

// Reads a whole row (by its "id" column) into a {headerName: value} object.
function findRow_(sheetName, rowId) {
  return measureAction_('sheetReadMs', function () { return findRowUnmeasured_(sheetName, rowId) })
}

function findRowUnmeasured_(sheetName, rowId) {
  var sheet = getSheet_(sheetName)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (idCol === -1) throw userError_('シートの構成が不正です。管理者にお問い合わせください。')

  var lastRow = sheet.getLastRow()
  var values = sheet.getRange(2, 1, Math.max(lastRow - 1, 0), headers.length).getValues()
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(rowId)) {
      var obj = {}
      headers.forEach(function (h, c) {
        obj[h] = values[i][c]
      })
      return obj
    }
  }
  return null
}

// Finds the row whose "id" column equals rowId, and writes `fields`
// (a {headerName: value} map) into the matching columns of that row.
// F5: 成果物リンク・経費の領収書URLがhttp/https以外(javascript:等)で
// ないことを保存時に検証する。フロント側の入力時チェック・表示時チェックと
// 同じ基準をサーバー側でも掛ける(フロントを経由しない直接のAPI呼び出しに
// 対する防御)。
function isSafeHttpUrl_(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

// F4: 自由入力(ユーザーが自由なテキストを入力できる)列の一覧。数式インジェ
// クション対策として、書き込み前にこれらの列のセルを書式なしテキスト(@)に
// してから値を設定する(セルに値を書き込んだ「後」にsetNumberFormatしても、
// 既に数式として解釈された内容は元に戻らないため、必ず値を書く前に呼ぶこと)。
// _json列・数値列・ID列・日付列・固定選択肢(enum)列はここに含めない
// (JSON文字列は必ず"["か"{"で始まるためSheets側で数式と誤解釈されない)。
// シート名は文字列リテラルで直接指定する — SHEET_EXPENSES等の定数は
// このオブジェクトより後ろで定義されており、スクリプト読み込み時点では
// まだ代入されていないため使えない。
var FORMULA_INJECTION_PROTECTED_COLUMNS = {
  Tasks: ['title', 'description', 'category', 'skills', 'progress_note', 'blocker_note'],
  Projects: ['name', 'description', 'goal'],
  Members: [
    'name', 'display_name', 'career_aspiration', 'desired_future_role', 'career_plan',
    'university', 'faculty', 'department_name', 'will_tags', 'judgment_tags',
    'department_path', 'desired_areas', 'desired_skills',
  ],
  Expenses: ['receipt_url', 'justification', 'purpose', 'rejection_reason'],
  Candidates: ['name', 'phone', 'resume_text', 'interview_notes'],
  DailyReports: ['done_text', 'todo_text', 'issues_text'],
  // value列にはorg_name等の自由入力に加えrole_levels/permission_overrides_json
  // 等のJSON値も入るが、書式なしテキスト化はJSON文字列の読み書きに影響しない
  // (JSON.parseは文字列の内容だけを見るため)ので列全体を対象にする。
  Settings: ['value'],
}

// 指定した行のうち、そのシートで保護対象の列だけを書式なしテキスト(@)にする。
// appendRowで新しい行を追加する「前」に、追加先になる行番号(sheet.getLastRow()+1)
// に対して呼ぶ想定。
function protectRowFromFormulaInjection_(sheet, headers, rowNumber, sheetName) {
  var cols = FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName]
  if (!cols) return
  cols.forEach(function (colName) {
    var idx = headers.indexOf(colName)
    if (idx >= 0) sheet.getRange(rowNumber, idx + 1).setNumberFormat('@')
  })
}

function updateRowFields_(sheetName, rowId, fields) {
  // タスクの期限・担当者・名前・完了などを変えた時は、カレンダーの予定を合わせる(syncCalendarForTask_)
  var calendarHints = null
  if (sheetName === SHEET_TASKS) {
    var beforeRow = null
    try {
      // 書き込みで読む表(このリクエストで覚えている表)から、書き換える前の値を取る
      var at = sheetGridRow_(SHEET_TASKS, rowId)
      var vals = at.row > 0 ? at.grid.values[at.row - 1] : null
      if (vals) beforeRow = { status: vals[at.grid.headers.indexOf('status')], due_date: vals[at.grid.headers.indexOf('due_date')], title: vals[at.grid.headers.indexOf('title')] }
    } catch (e) { beforeRow = null }
    calendarHints = calendarSyncHints_(fields, beforeRow)
  }
  var result = measureAction_('sheetWriteMs', function () { return updateRowFieldsUnmeasured_(sheetName, rowId, fields) })
  if (calendarHints) syncCalendarForTask_(rowId, calendarHints)
  return result
}

// 1回の実行(リクエスト)の中で読んだシートの形(見出しと、ID → 行番号)を覚えて、同じシートへの
// 2回目からの書き込み・行の読み込みで使い回す(batch で同じタスクに2つの操作を書く時など)。
// 読む時はシート全体を1回の呼び出し(getDataRange)で読む(これまでは見出し・最終行・ID の列を別々に読んでいた)。
// この実行の中で書いた値は values にも入れる(requestRow_ が書いた後の行を返せるように)。
// 行を削除した時は forgetSheetGrid_ で忘れる(行番号がずれるため)。行の追加では既存の行番号は変わらないので、
// 見つからない ID があった時だけ読み直す
var _sheetGrids = {}

function forgetSheetGrid_(sheetName) {
  if (sheetName) delete _sheetGrids[sheetName]
  else _sheetGrids = {}
}

function loadSheetGrid_(sheetName) {
  var sheet = getSheet_(sheetName)
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rowOf = {}
  if (idCol >= 0) {
    for (var i = 1; i < values.length; i++) {
      var id = String(values[i][idCol])
      if (id !== '' && !(id in rowOf)) rowOf[id] = i + 1
    }
  }
  var grid = { sheet: sheet, headers: headers, idCol: idCol, rowOf: rowOf, values: values }
  _sheetGrids[sheetName] = grid
  return grid
}

// 行番号(見つからなければ、一度だけ読み直して探す)
function sheetGridRow_(sheetName, rowId) {
  var grid = _sheetGrids[sheetName] || loadSheetGrid_(sheetName)
  var r = grid.rowOf[String(rowId)]
  if (!r && grid.loadedFresh !== true) {
    grid = loadSheetGrid_(sheetName)
    grid.loadedFresh = true
    r = grid.rowOf[String(rowId)]
  }
  return { grid: grid, row: r || -1 }
}

function updateRowFieldsUnmeasured_(sheetName, rowId, fields) {
  var found = sheetGridRow_(sheetName, rowId)
  var grid = found.grid
  var headers = grid.headers
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (grid.idCol < 0) throw userError_('シートの構成が不正です。管理者にお問い合わせください。')
  var targetRow = found.row
  if (targetRow === -1) throw userError_(sheetName + ' row not found for id ' + rowId)

  var missingKeys = []
  var cols = []
  // F4(性能・レビュー指摘対応4): ここでは書式を設定しない。保護対象列は
  // 行の新規作成時に必ずprotectRowFromFormulaInjection_()で書式なしテキスト
  // (@)にしてからappendRowしているため、既存行のセルは既にその書式に
  // なっている前提が成り立つ(そうでない過去データはauditFormulaInjectionRisks(true)
  // で一度だけ修正する — gas/README.md参照)。毎回setNumberFormatし直すと
  // 書き込みの多いTasks等で余計なAPI呼び出しが倍になるため省略する。
  Object.keys(fields).forEach(function (key) {
    var col = headers.indexOf(key) + 1
    if (col === 0) {
      missingKeys.push(key)
      return // このシートにまだ無い列 — 個別にはスキップするが、下でまとめて報告する
    }
    cols.push({ col: col, value: fields[key] })
  })
  // 更新しようとした列が1つも見つからなかった場合、無音で「成功」を返すと
  // フロント側は保存できたと誤認する（実際は何も書き込まれていない）。
  // 新しい列をCode.gs側に追加しただけでは既存のシートには反映されない
  // （setupOhsumi()の再実行が必要）ため、このケースは実運用で起こりうる。
  if (cols.length === 0 && missingKeys.length > 0) {
    throw userError_(
      sheetName + 'シートに列が見つかりません: ' + missingKeys.join(', ') +
      '。Apps Scriptエディタで setupOhsumi() を実行してヘッダー列を追加してください。',
    )
  }
  // 1つのセルの上限(5万文字)を超える値は、何も書かずに断る。8割を超えた値は、書いた後に知らせる
  var before = grid.values[targetRow - 1] || []
  cols.forEach(function (c) { assertCellLength_(sheetName, headers[c.col - 1], c.value, before[c.col - 1]) })
  // 書き込みの競合チェック: 内容を変える書き込みは、画面が開いた時の版と今の版を比べ、ほかの人が先に変えていたら断る。
  // 通ったら版を新しくする(row_version の列が無い古いシートでは、何もしない)
  var bump = rowVersionBump_(sheetName, rowId, headers, before, Object.keys(fields))
  if (bump) bump.forEach(function (c) { cols.push(c) })
  // 隣り合う列は1回の setValues にまとめる。離れた列は、間のセル(数式など)を書き換えないよう別に書く
  // (セルへの書き込みは、Apps Script が書き込みの確定の時にまとめて送る)
  cols.forEach(function (c) { noteLongCell_(sheetName, rowId, recordName_(headers, before), headers[c.col - 1], c.value, before[c.col - 1]) })
  contiguousColumnRuns_(cols).forEach(function (run) {
    grid.sheet.getRange(targetRow, run[0].col, 1, run.length).setValues([run.map(function (c) { return c.value })])
  })
  var rowValues = grid.values[targetRow - 1]
  if (rowValues) cols.forEach(function (c) { rowValues[c.col - 1] = c.value })

  return { id: rowId, updated: Object.keys(fields) }
}

// ---- 書き込みの競合チェック(行の版) ----
//
// Members・Projects・Tasks の行は、内容を変えるたびに row_version(行の版)を新しくし、変えた人を row_updated_by に残す。
// 画面は保存の時に、開いた時点の版(baseVersions: { 'Tasks:t1': 'r…' })を送る。今の版と違い、しかも最後に変えたのが
// 自分でない時は、ほかの人が先に変えたので、上書きせずに断る(conflict)。自分が続けて保存した時(版は自分が変えた)は通す。
// 記録の一覧(コメント・1on1 など)は、項目ごとの差分(listOps)で受け取って項目ごとに確かめるので、行の版は使わない。
// 最後のログイン日時などの記録の列も、版を変えない(ROW_VERSION_IGNORED_FIELDS)
var ROW_VERSION_SHEETS = ['Members', 'Projects', 'Tasks']
var ROW_VERSION_IGNORED_FIELDS = [
  'row_version', 'row_updated_by',
  // 記録・通知のための列
  'last_login', 'last_inactive_notified', 'last_notified_health', 'last_activity', 'calendar_event_id',
  // 項目ごとの差分で確かめる記録の一覧と、GAS が足し算でまとめる列
  'comments_json', 'progress_history_json', 'history_json', 'deliverables_json',
  'career_history_json', 'qualifications_json', 'evaluation_history_json', 'transfer_history_json',
  'skill_levels_json', 'competencies_json', 'training_history_json', 'development_plan_json', 'one_on_ones_json',
  'survey_responses_json', 'skill_points_json', 'awarded_points_json', 'quiz_passes_json',
]
// このリクエスト(batch では操作ごと)で画面が送った、開いた時点の版
var _expectedRowVersions = null

var CONFLICT_MESSAGE = 'ほかの人が先にこの内容を変えたため、保存しませんでした。最新の内容を読み込み直します。書いた文章は消えていないので、コピーしてもう一度入れてください。'

function conflictError_(sheetName, rowId) {
  var e = userError_(CONFLICT_MESSAGE)
  e.conflict = { sheet: String(sheetName), id: String(rowId) }
  return e
}

function setExpectedRowVersions_(body) {
  var v = body && body.baseVersions
  _expectedRowVersions = v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function newRowVersion_() {
  return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
}

// 内容を変える書き込みなら、版を確かめて、新しい版の列(cols に足すもの)を返す。版の列が無い・記録の列だけの時は null
function rowVersionBump_(sheetName, rowId, headers, before, keys) {
  if (ROW_VERSION_SHEETS.indexOf(sheetName) < 0) return null
  var vCol = headers.indexOf('row_version')
  var byCol = headers.indexOf('row_updated_by')
  if (vCol < 0 || byCol < 0) return null
  if (!keys.some(function (k) { return ROW_VERSION_IGNORED_FIELDS.indexOf(k) < 0 })) return null
  var actor = _requestActorId ? String(_requestActorId) : 'system'
  var key = sheetName + ':' + rowId
  if (_expectedRowVersions && Object.prototype.hasOwnProperty.call(_expectedRowVersions, key)) {
    var expected = String(_expectedRowVersions[key] || '')
    var current = String(before[vCol] === undefined || before[vCol] === null ? '' : before[vCol])
    var lastBy = String(before[byCol] === undefined || before[byCol] === null ? '' : before[byCol])
    if (current !== expected && lastBy !== actor) throw conflictError_(sheetName, rowId)
  }
  return [{ col: vCol + 1, value: newRowVersion_() }, { col: byCol + 1, value: actor }]
}

// ---- 記録の一覧の差分(listOps) ----
//
// コメント・進み具合の記録・変更の記録・成果物と、メンバーの経歴・資格・評価・異動・スキル・コンピテンシー・研修・育成の計画・
// 1on1 の記録は、1つのセルに一覧(JSON)で持つ。画面は一覧を丸ごと送らず、項目ごとの差分を送る:
//   { op: 'add', entry }                 足す(同じキーが既にあれば、同じ内容なら何もしない・違えば競合)
//   { op: 'update', key, before, entry } 変える(今の内容が before と違う・消えていれば競合)
//   { op: 'remove', key, before }        消す(既に消えていれば何もしない。今の内容が before と違えば競合)
// GAS は、ロックを取った後に今のセルの一覧へ差分を当てて書く。差分に無い項目(ほかの人が後から足した記録など)は、
// 管理者の操作でも消えない。一覧を丸ごと送る古い画面からの保存は、読み込み直してもらう(LEGACY_LIST_MESSAGE)
var LIST_ACTIONS = {
  updateComments: { sheet: 'Tasks', idParam: 'taskId', column: 'comments_json', param: 'comments', key: 'id' },
  updateProgress: { sheet: 'Tasks', idParam: 'taskId', column: 'progress_history_json', param: 'progressHistory', key: 'id' },
  updateHistory: { sheet: 'Tasks', idParam: 'taskId', column: 'history_json', param: 'history', key: 'id', addAt: 'start', cap: 50, addOnly: true },
  updateDeliverables: { sheet: 'Tasks', idParam: 'taskId', column: 'deliverables_json', param: 'deliverables', key: 'id' },
  updateCareerHistory: { sheet: 'Members', idParam: 'memberId', column: 'career_history_json', param: 'entries', key: 'id' },
  updateQualifications: { sheet: 'Members', idParam: 'memberId', column: 'qualifications_json', param: 'entries', key: 'id' },
  updateEvaluationHistory: { sheet: 'Members', idParam: 'memberId', column: 'evaluation_history_json', param: 'entries', key: 'id' },
  updateTransferHistory: { sheet: 'Members', idParam: 'memberId', column: 'transfer_history_json', param: 'entries', key: 'id' },
  updateSkillLevels: { sheet: 'Members', idParam: 'memberId', column: 'skill_levels_json', param: 'levels', key: 'skill' },
  updateCompetencies: { sheet: 'Members', idParam: 'memberId', column: 'competencies_json', param: 'competencies', key: 'name' },
  updateTrainingHistory: { sheet: 'Members', idParam: 'memberId', column: 'training_history_json', param: 'entries', key: 'id' },
  updateDevelopmentPlan: { sheet: 'Members', idParam: 'memberId', column: 'development_plan_json', param: 'entries', key: 'id' },
  updateOneOnOnes: { sheet: 'Members', idParam: 'memberId', column: 'one_on_ones_json', param: 'entries', key: 'id' },
}
var LIST_OPS_MAX = 200
var LEGACY_LIST_MESSAGE = 'Ohsumi が更新されました。書いた文章をコピーしてから、ページを読み込み直してください。'

// ロックを取った後に、今のシートの一覧で権限を確かめ直す(他人の記録を変え・消していないか。新しい記録の書いた人は本人)
function revalidateListWrite_(body, acting) {
  var cfg = LIST_ACTIONS[body.action]
  if (cfg.sheet !== 'Tasks') return
  var row = lockedRow_(SHEET_TASKS, String(body.taskId || ''))
  if (!row) throw userError_('対象のタスクが見つかりません。')
  if (body.action === 'updateComments') validateCommentsUpdate_(row, body.comments, acting)
  if (body.action === 'updateProgress') validateProgressHistoryUpdate_(row, body.progressHistory, acting)
  if (body.action === 'updateHistory') validateHistoryUpdate_(row, body.history, acting)
}

// 一覧を丸ごと送る古い画面からの保存か(差分 listOps が無く、一覧そのものがある)
function legacyListWrite_(body) {
  var cfg = body && LIST_ACTIONS[body.action]
  return !!cfg && body.listOps === undefined && body[cfg.param] !== undefined
}

// 比べるための形(キーの順番をそろえ、undefined を除く)
function canonicalJson_(v) {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson_).join(',') + ']'
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined })
      .map(function (k) { return JSON.stringify(k) + ':' + canonicalJson_(v[k]) }).join(',') + '}'
  }
  return JSON.stringify(v)
}

function parseListCell_(raw) {
  var list = []
  try { list = JSON.parse(raw || '[]') } catch (e) { list = [] }
  return Array.isArray(list) ? list : []
}

// 今の一覧(current)に差分(ops)を当てた一覧を返す。strict の時は、競合があれば conflict で断る
// (ロックを取る前の権限の判定では、スナップショットの一覧に当てるので、競合は見ない)
function applyListOps_(cfg, current, ops, strict, sheetName, rowId, normalize) {
  if (!Array.isArray(ops) || ops.length > LIST_OPS_MAX) throw userError_('記録の変更の形式が不正です。')
  var keyOf = function (e) { return e && typeof e === 'object' ? String(e[cfg.key] === undefined || e[cfg.key] === null ? '' : e[cfg.key]) : '' }
  var norm = normalize || function (e) { return e }
  var list = current.slice()
  var indexOf = function (key) {
    for (var i = 0; i < list.length; i++) if (keyOf(list[i]) === key) return i
    return -1
  }
  var same = function (a, b) { return canonicalJson_(norm(a)) === canonicalJson_(norm(b)) }
  var conflict = function () { if (strict) throw conflictError_(sheetName, rowId) }
  var added = []
  ops.forEach(function (op) {
    if (!op || typeof op !== 'object') throw userError_('記録の変更の形式が不正です。')
    if (op.op === 'add') {
      var key = keyOf(op.entry)
      if (!key) throw userError_('記録の変更の形式が不正です。')
      var at = indexOf(key)
      if (at >= 0) {
        if (!same(list[at], op.entry)) conflict()
        return
      }
      if (cfg.addAt === 'start') added.push(op.entry)
      else list.push(op.entry)
      return
    }
    if (cfg.addOnly) throw userError_('この記録は、足すことだけができます。')
    var k = String(op.key === undefined || op.key === null ? '' : op.key)
    if (!k) throw userError_('記録の変更の形式が不正です。')
    var i = indexOf(k)
    if (op.op === 'update') {
      if (!op.entry || keyOf(op.entry) !== k) throw userError_('記録の変更の形式が不正です。')
      if (i < 0) { conflict(); return }
      if (!same(list[i], op.before)) { conflict(); if (!strict) return }
      list[i] = op.entry
      return
    }
    if (op.op === 'remove') {
      if (i < 0) return
      if (!same(list[i], op.before)) { conflict(); if (!strict) return }
      list.splice(i, 1)
      return
    }
    throw userError_('記録の変更の形式が不正です。')
  })
  if (added.length) list = added.concat(list)
  if (cfg.cap && list.length > cfg.cap) list = list.slice(0, cfg.cap)
  return list
}

// 差分(listOps)を、今の一覧に当てた一覧(body の一覧の項目: comments・entries など)にする。
// locked: ロックを取った後(今のシートの値に当て、競合を確かめる)。そうでなければ権限の判定に使うスナップショットに当てる
function expandListOps_(body, locked) {
  var cfg = body && LIST_ACTIONS[body.action]
  if (!cfg || body.listOps === undefined) return
  var rowId = String(body[cfg.idParam] || '')
  var row = locked ? lockedRow_(cfg.sheet, rowId) : authFindRow_(cfg.sheet, rowId)
  if (!row) throw userError_('対象が見つかりません。')
  var normalize = cfg.column === 'history_json' ? normalizeHistoryEntry_ : null
  body[cfg.param] = applyListOps_(cfg, parseListCell_(row[cfg.column]), body.listOps, locked, cfg.sheet, rowId, normalize)
}

// ロックを取った後の、今のシートの行(この実行で書いた値を含む)
// (シートを1回で読んで覚え、続く書き込み(updateRowFields_)でも使い回す)
function lockedRow_(sheetName, rowId) {
  var found = measureAction_('sheetReadMs', function () { return sheetGridRow_(sheetName, rowId) })
  if (found.row === -1 || !found.grid.values[found.row - 1]) return null
  var obj = {}
  found.grid.headers.forEach(function (h, c) { obj[h] = found.grid.values[found.row - 1][c] })
  return obj
}

// ---- 1つのセルの長さ ----
//
// スプレッドシートの1つのセルには 5万文字までしか入らない。コメント・1on1 の記録・経歴・評価・アンケートの回答などは、
// 記録を JSON にして1つのセルに入れているため、使い続けると増え続ける。
//   - 上限を超える値は、何も書かずに断る(cellTooLong。画面は書いた文章を、機能停止の時と同じ知らせでコピーできる形で残す)
//   - 8割(4万文字)を超えた値は、書いた後に、書いた人(応答の longRecords)と代表(初めて超えた時に、まとめのメール)に知らせる
//   - どの記録がいくつ上限に近いかは、代表の管理画面で見られる(getLongRecords)
var CELL_MAX_CHARS = 50000
var CELL_WARN_CHARS = 40000
// このリクエストで書いた、8割を超えた記録 [{ sheet, id, name, field, length, crossed }]
var _longCells = []

function cellTooLongError_(sheetName, field, value, before) {
  var length = value.length
  var e = userError_('この記録は長くなりすぎたため、保存できませんでした(' + length + '文字。1つの記録は' + CELL_MAX_CHARS +
    '文字まで)。書いた文章は消えていないので、コピーして残してください。古い記録の整理は代表に相談してください。')
  e.cellTooLong = { sheet: String(sheetName), field: String(field), length: length, max: CELL_MAX_CHARS, texts: newCellTexts_(value, before) }
  return e
}

// 断った値のうち、前の値に無かった文章(書いた人が今回書いたもの)。画面はこれをコピーできるように出す
// (記録の一覧を丸ごと送る保存なので、前からの記録は除く)。前の値が分からない時は null(画面が送った内容から取り出す)
function newCellTexts_(value, before) {
  if (before === undefined || before === null) return null
  var leaves = function (v, out) {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(function (x) { leaves(x, out) })
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { leaves(v[k], out) })
    return out
  }
  var parse = function (text) { try { return JSON.parse(text) } catch (e) { return text } }
  var old = {}
  leaves(parse(String(before)), []).forEach(function (t) { old[t] = true })
  var seen = {}
  return leaves(parse(value), []).filter(function (t) {
    if (old[t] || seen[t] || !String(t).trim()) return false
    seen[t] = true
    return true
  }).slice(0, 20)
}

function assertCellLength_(sheetName, field, value, before) {
  if (typeof value === 'string' && value.length > CELL_MAX_CHARS) throw cellTooLongError_(sheetName, field, value, before)
}

function assertRowCellLengths_(sheetName, headers, row) {
  row.forEach(function (v, i) { assertCellLength_(sheetName, headers[i], v, '') })
}

// 記録の名前(タスクの題名・メンバーの名前・設定のキー)。知らせと一覧に出す
function recordName_(headers, rowValues) {
  var keys = ['title', 'name', 'key']
  for (var i = 0; i < keys.length; i++) {
    var col = headers.indexOf(keys[i])
    if (col >= 0 && rowValues[col] !== undefined && rowValues[col] !== '') return String(rowValues[col]).slice(0, 100)
  }
  return ''
}

// 8割を超えた値を書く時に覚える(crossed: 書く前は8割以下だった = 初めて超えた)
function noteLongCell_(sheetName, id, name, field, value, before) {
  if (typeof value !== 'string' || value.length <= CELL_WARN_CHARS) return
  _longCells.push({
    sheet: String(sheetName), id: String(id), name: name || '', field: String(field), length: value.length,
    crossed: String(before === undefined || before === null ? '' : before).length <= CELL_WARN_CHARS,
  })
}

// 初めて8割を超えた記録を、代表にまとめのメールで知らせる(書き込みの確定の後に、doPost から呼ぶ)
function notifyTopsOfLongRecords_(cells) {
  var crossed = cells.filter(function (c) { return c.crossed })
  if (!crossed.length) return
  try {
    var to = Object.keys(topEmailSet_())
    if (!to.length) return
    var lines = crossed.map(function (c) {
      return '・' + (c.name || c.id) + ' の ' + cellFieldLabel_(c.field) + '(' + c.length + '文字 / 上限 ' + CELL_MAX_CHARS + '文字)'
    })
    deliverNotification_(to, { ja: {
      subject: 'この記録は長くなっています',
      body: '次の記録が、1つの記録に入る長さの上限(' + CELL_MAX_CHARS + '文字)の8割を超えました。\n' + lines.join('\n') +
        '\n\n上限を超えると、それ以上は保存できなくなります。団体の設定の画面の「長くなっている記録」で一覧を確かめ、古い記録の整理を検討してください。',
    } }, false)
  } catch (e) {
    console.warn('長くなっている記録の知らせを送れませんでした: ' + ((e && e.message) || e))
  }
}

var CELL_FIELD_LABELS = {
  comments_json: 'コメント', history_json: '変更の記録', progress_history_json: '進み具合の記録',
  one_on_ones_json: '1on1 の記録', career_history_json: '経歴', evaluation_history_json: '評価',
  survey_responses_json: 'アンケートの回答', training_history_json: '研修の記録', development_plan_json: '育成の計画',
  transfer_history_json: '異動の記録', qualifications_json: '資格', description: '説明', value: '設定の値',
}

function cellFieldLabel_(field) {
  return CELL_FIELD_LABELS[field] || field
}

// 8割を超えているセルを、表(Members・Projects・Tasks・Settings)から探す。記録の種類(シートと列)ごとにまとめ、長い順に並べる
function longRecordsNow_() {
  var data = {}
  SNAPSHOT_SHEETS.forEach(function (name) { data[name] = snapshotTableOrSheet_(name) })
  return longRecords_(data)
}

function longRecords_(data) {
  var groups = {}
  var maxLength = 0
  SNAPSHOT_SHEETS.forEach(function (name) {
    var table = data[name]
    if (!table || !table.headers) return
    var idCol = table.headers.indexOf(name === SHEET_SETTINGS ? 'key' : 'id')
    ;(table.rows || []).forEach(function (row) {
      row.forEach(function (v, col) {
        var length = typeof v === 'string' ? v.length : String(v === null || v === undefined ? '' : v).length
        if (length > maxLength) maxLength = length
        if (length <= CELL_WARN_CHARS) return
        var field = table.headers[col]
        var key = name + ':' + field
        if (!groups[key]) groups[key] = { sheet: name, field: field, label: cellFieldLabel_(field), items: [] }
        groups[key].items.push({ id: idCol >= 0 ? String(row[idCol]) : '', name: recordName_(table.headers, row), length: length })
      })
    })
  })
  var list = Object.keys(groups).map(function (k) {
    var g = groups[k]
    g.items.sort(function (a, b) { return b.length - a.length })
    g.count = g.items.length
    return g
  })
  list.sort(function (a, b) { return b.items[0].length - a.items[0].length })
  return { warnAt: CELL_WARN_CHARS, max: CELL_MAX_CHARS, maxLength: maxLength, groups: list }
}

// 列の番号の並び(書く値つき)を、隣り合う列ごとのまとまりにする(Google のサービスを使わない)
function contiguousColumnRuns_(cols) {
  var sorted = cols.slice().sort(function (a, b) { return a.col - b.col })
  var runs = []
  sorted.forEach(function (c) {
    var last = runs.length ? runs[runs.length - 1] : null
    if (last && last[last.length - 1].col === c.col) {
      last[last.length - 1] = c // 同じ列を2回書く時は後の値
    } else if (last && last[last.length - 1].col + 1 === c.col) {
      last.push(c)
    } else {
      runs.push([c])
    }
  })
  return runs
}

// 通知などで、書いた後の行を読む(判定には使わない)。この実行でそのシートを読んだ・書いた時は、
// 覚えている行(書いた値を含む)を返す。そうでなければ、権限の判定に使ったスナップショットの行
// (同じ版。値は表示の文字列)、それも無ければシートから読む(findRow_)
function requestRow_(sheetName, rowId) {
  var grid = _sheetGrids[sheetName]
  if (grid && grid.idCol >= 0) {
    var r = grid.rowOf[String(rowId)]
    if (r) {
      var obj = {}
      grid.headers.forEach(function (h, c) { obj[h] = grid.values[r - 1][c] })
      return obj
    }
  }
  if (_authSnapshotVersion !== null && _requestSnapshot && _requestSnapshot.version === _authSnapshotVersion && !grid) {
    return authFindRow_(sheetName, rowId)
  }
  return findRow_(sheetName, rowId)
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
}

// ---- 書き込みの送り直し(requestId) --------------------------------------------
//
// フロントは、JSON の応答を受け取れなかった時(結果の転送先 script.googleusercontent.com の
// echo が 404 になった時など)に、少し待ってから同じリクエストを送り直す。GAS の処理は
// 済んでいることがあるため、書き込みにはリクエストごとの ID(requestId)を付けてもらい、
// 同じメンバー・同じ ID の結果を10分覚えておく。送り直された時は処理をやり直さず、
// 前回の結果(replayed: true)を返す。処理中に届いた時は retryLater を返し、もう少し待ってもらう。
var REQUEST_REPLAY_TTL_SEC = 600
var REQUEST_IN_FLIGHT_TTL_SEC = 120
// CacheService の1件の上限(100KB)より小さくする
var REQUEST_REPLAY_MAX_CHARS = 90000

// ログイン(exchangeIdToken)の送り直しの記録の鍵。requestId・IDトークン・画面だけが知る乱数(nonceSecret)をまとめたハッシュにする。
// 同じ3つを送れるのは、ログインを始めたその画面だけなので、IDトークンだけを手に入れた人は、前回の結果(セッション)を受け取れない。
// IDトークンの1回限り(verifyGoogleIdToken_ の nonce の記録)は、そのまま守る(記録を返す時は、確かめ直さない)
function loginReplayKey_(body) {
  var id = body && body.requestId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  if (!body.idToken || !body.nonceSecret) return null
  return 'rqlogin:' + sha256Base64Url_(id + '|' + body.idToken + '|' + body.nonceSecret)
}

// ログインの結果を覚える。初期データは大きく覚えられないので、メンバーID・セッションなどだけを覚え、
// 送り直しの時は画面が初期データを読み直す(reloadInitialData)。失敗も覚える(やり直さない)
function rememberLogin_(key, out) {
  var stored
  if (out.ok) {
    var r = out.result || {}
    stored = r.memberId
      ? { ok: true, replayed: true, result: { memberId: r.memberId, email: r.email, session: r.session, lastLoginRecorded: r.lastLoginRecorded, reloadInitialData: true } }
      : { ok: true, replayed: true, result: { memberId: null, email: r.email } }
  } else {
    stored = { ok: false, replayed: true, error: out.error, authError: true }
  }
  try { CacheService.getScriptCache().put(key, JSON.stringify(stored), REQUEST_REPLAY_TTL_SEC) } catch (e) { /* 覚えられなくても応答は返す */ }
}

function requestReplayKey_(memberId, body) {
  var id = body && body.requestId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  return 'rq:' + memberId + ':' + id
}

function readRequestReplay_(key) {
  try {
    var raw = CacheService.getScriptCache().get(key)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

function markRequestInFlight_(key) {
  try { CacheService.getScriptCache().put(key, JSON.stringify({ inFlight: true }), REQUEST_IN_FLIGHT_TTL_SEC) } catch (e) { /* 覚えられなくても処理は続ける */ }
}

// 送り直された時に返す応答(新しいセッショントークンは入れない。次のリクエストで改めて受け取る)
function requestReplayValue_(obj) {
  var stored = { ok: obj.ok, replayed: true }
  if (obj.ok) stored.result = obj.result
  else stored.error = obj.error
  if (obj.cellTooLong) stored.cellTooLong = obj.cellTooLong
  if (obj.conflict) stored.conflict = obj.conflict
  var text = JSON.stringify(stored)
  if (text.length <= REQUEST_REPLAY_MAX_CHARS) return text
  // 結果が大きすぎて覚えられない: 処理は済んでいることだけを伝える(やり直さない)
  // (1つのセルの上限で断った時は、文章を除いて覚える。画面は送った内容から文章を取り出す)
  var small = {
    ok: false,
    replayed: true,
    error: obj.ok
      ? 'この操作は完了しています。「情報更新」で最新の状態を読み込んでください。'
      : obj.error,
  }
  if (!obj.ok && obj.cellTooLong) {
    small.cellTooLong = { sheet: obj.cellTooLong.sheet, field: obj.cellTooLong.field, length: obj.cellTooLong.length, max: obj.cellTooLong.max, texts: null }
  }
  return JSON.stringify(small)
}

