// ---- 読み取り(公開CSVの代替) ------------------------------------------------
//
// Members / Projects / Tasks / Settings の読み取りは、以前は「ウェブに公開」した
// CSVから直接行っていた(URLを知っていればログインなしで全データを読めた)。
// 現在は getInitialData アクションでまとめて返す。流れ:
//   1. トークンを検証してログイン中のメンバーを特定する
//   2. 4シート分の「スナップショット」をキャッシュから取り出す(なければ読む)
//   3. READ_POLICY に従い、閲覧者が見てよい行・列・キーだけに絞って返す
//
// キャッシュは「データの版(DATA_VERSION)」ごとに持つ。書き込みのたびに版を
// 新しくするので、古い版のキャッシュは参照されなくなり期限切れで消える。
// 版を新しくする箇所: doPost の書き込みアクション(finally)、dailyMaintenance、
// generateRecurringTasksLocked_、スプレッドシートの手動編集(onSpreadsheetChange)。

var DATA_VERSION_PROPERTY_KEY = 'DATA_VERSION'
var SNAPSHOT_SHEETS = ['Members', 'Projects', 'Tasks', 'Settings']
// CacheService は1キー100KBまで。base64文字列を90,000文字ずつに分割する
var SNAPSHOT_CHUNK_SIZE = 90000
// 分割数の上限(約5.4MB)。これを超える場合はキャッシュせず毎回シートから読む
var SNAPSHOT_MAX_CHUNKS = 60
// CacheService の有効期限の上限(6時間)
var SNAPSHOT_CACHE_TTL = 21600

function getDataVersion_() {
  return PropertiesService.getScriptProperties().getProperty(DATA_VERSION_PROPERTY_KEY) || '0'
}

// 版は表(または読み込みの単位)ごとに分ける。関係の無い書き込みで、ほかの表のキャッシュを捨てないため。
//   snapshot         Members・Projects・Tasks・Settings(DATA_VERSION。初期データと読み取りの認証)
//   expenses         Expenses(TABLE_VERSION_expenses)
//   formSubmissions  FormSubmissions(TABLE_VERSION_formSubmissions)
//   candidates       Candidates(TABLE_VERSION_candidates)
// メールアドレス表(MemberEmails)は、これまでどおり MEMBER_EMAILS_VERSION で別に持つ。
var TABLE_VERSION_PREFIX = 'TABLE_VERSION_'
var VERSIONED_TABLES = ['expenses', 'formSubmissions', 'candidates']

function newVersionValue_() {
  return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6)
}

function getTableVersion_(table) {
  return PropertiesService.getScriptProperties().getProperty(TABLE_VERSION_PREFIX + table) || '0'
}

function bumpTableVersion_(table) {
  try {
    PropertiesService.getScriptProperties().setProperty(TABLE_VERSION_PREFIX + table, newVersionValue_())
  } catch (e) {
    Logger.log('bumpTableVersion failed: ' + e)
  }
}

// スナップショット(Members・Projects・Tasks・Settings)の版だけを新しくする
function bumpSnapshotVersion_() {
  try {
    PropertiesService.getScriptProperties().setProperty(DATA_VERSION_PROPERTY_KEY, newVersionValue_())
  } catch (e) {
    // 版の更新に失敗しても、キャッシュの有効期限(最長5分)で反映される
    Logger.log('bumpSnapshotVersion failed: ' + e)
  }
}

// アプリからの書き込み(ロックを取った操作)の後に、その操作が書くかもしれない表の版だけを新しくする。
// 一覧は scripts/gas-write-tables.mjs で Code.gs を調べた結果を含むこと(lib/ohsumi/gas-table-versions.test.ts で確かめる)。
// 一覧に無い操作はスナップショットの版を新しくする(これまでどおり)
var TABLE_WRITE_ACTIONS = {
  expenses: ['submitExpenseApplication', 'approveExpenseStep', 'rejectExpense', 'withdrawExpense', 'returnExpense', 'resubmitExpense'],
  formSubmissions: ['submitCustomForm', 'approveFormStep', 'rejectFormSubmission'],
  candidates: ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember',
    // バックアップから戻した直後・個人情報の削除で、採用しなかった候補者を消す・延ばす
    'restoreBackup', 'restoreTasks', 'purgePersonalDataNow', 'extendPersonalData', 'cancelWithdrawal'],
}
// Members・Projects・Tasks・Settings に書かない操作(スナップショットの版を変えない)
var SNAPSHOT_UNTOUCHED_ACTIONS = ['addCandidate', 'removeCandidate', 'updateEmail', 'rejectFormSubmission', 'submitDailyReport', 'setMyStorage', 'setOrgStorage']

// actions は操作の名前、または名前の配列(まとめて送られた書き込み)。表ごとに1回だけ新しくする
function bumpVersionsAfterWrite_(actions) {
  var list = (Array.isArray(actions) ? actions : [actions]).map(function (a) { return String(a || '') })
  if (list.length === 0) list = ['']
  VERSIONED_TABLES.forEach(function (t) {
    if (list.some(function (a) { return TABLE_WRITE_ACTIONS[t].indexOf(a) >= 0 })) bumpTableVersion_(t)
  })
  if (list.some(function (a) { return SNAPSHOT_UNTOUCHED_ACTIONS.indexOf(a) < 0 })) bumpSnapshotVersion_()
}

// シートの名前 → 版を新しくする処理(スプレッドシートの直接の編集で使う)
var SHEET_VERSION_BUMPS = {
  Members: bumpSnapshotVersion_,
  Projects: bumpSnapshotVersion_,
  Tasks: bumpSnapshotVersion_,
  Settings: bumpSnapshotVersion_,
  // 記録の行(39-record-rows.gs)は、スナップショットの Tasks・Members に組み立てて返す
  TaskRecords: bumpSnapshotVersion_,
  MemberRecords: bumpSnapshotVersion_,
  Expenses: function () { bumpTableVersion_('expenses') },
  FormSubmissions: function () { bumpTableVersion_('formSubmissions') },
  Candidates: function () { bumpTableVersion_('candidates') },
  MemberEmails: function () { bumpMemberEmailsVersion_() },
}

// ログイン用のメール→メンバーIDの対応表(findMemberIdByEmailCached_)は、
// データの版とは別の版でキャッシュする。タスクの更新などメールに関係のない
// 書き込みのたびに MemberEmails シートを読み直さないようにするため。
// 版を新しくするのは次の場合だけ:
//   - setMemberEmail_(addMember / convertCandidateToMember / updateEmail から呼ばれる)
//   - removeMember(メール行は消さないが、念のため)
//   - setupOhsumi(MemberEmails シートの作成・見出しの追加)
//   - onSpreadsheetChange(スプレッドシートの手動編集)
//   - resetMemberEmailsCache(エディタから手動で実行する)
var MEMBER_EMAILS_VERSION_PROPERTY_KEY = 'MEMBER_EMAILS_VERSION'

function getMemberEmailsVersion_() {
  return PropertiesService.getScriptProperties().getProperty(MEMBER_EMAILS_VERSION_PROPERTY_KEY) || '0'
}

function bumpMemberEmailsVersion_() {
  try {
    PropertiesService.getScriptProperties().setProperty(
      MEMBER_EMAILS_VERSION_PROPERTY_KEY,
      String(Date.now()) + '-' + Math.floor(Math.random() * 1e6),
    )
  } catch (e) {
    // 版の更新に失敗しても、キャッシュの有効期限(6時間)で最終的に反映される
    Logger.log('bumpMemberEmailsVersion failed: ' + e)
  }
}

// シートを {headers, rows} で読む。値は公開CSVと同じく「表示されている文字列」
// (getDisplayValues と同じ見え方)にそろえる。空行は除く。シートが無ければ空で返す。
//
// 読み込みは Sheets API の values.batchGet を UrlFetchApp で1回だけ呼んで行う
// (スクリプトのトークンを使う。Apps Script の「サービス」に Google Sheets API が
// 追加されている必要がある — appsscript.json を参照)。失敗した場合(403・429・
// 5xx・通信エラーなど)は、SpreadsheetApp の getSheets() + getDisplayValues() で
// 読み直す。どちらで読んだかと失敗の理由は実行ログに残す。
function readSheetTables_(names) {
  var start = Date.now()
  var viaApi
  try {
    viaApi = readSheetTablesViaApi_(names)
  } catch (e) {
    viaApi = { error: '通信エラー: ' + ((e && e.message) || e) }
  }
  if (viaApi.tables) {
    console.log('readSheetTables: Sheets API(batchGet)で読み込み ' + (Date.now() - start) + 'ms')
    noteTiming_('read', 'api')
    noteTiming_('readMs', Date.now() - start)
    return viaApi.tables
  }
  var t = Date.now()
  var tables = readSheetTablesViaSpreadsheetApp_(names)
  noteTiming_('read', 'spreadsheetApp')
  noteTiming_('readMs', Date.now() - start)
  noteTiming_('readError', String(viaApi.error).slice(0, 200))
  console.warn(
    'readSheetTables: Sheets API で読み込めなかったため、SpreadsheetApp(getDisplayValues)で読み込み ' +
      (Date.now() - t) + 'ms。理由: ' + viaApi.error,
  )
  return tables
}

var EMPTY_SHEET_TABLE_JSON = '{"headers":[],"rows":[]}'

// 2次元配列(1行目が見出し)を {headers, rows} にする。空行は除く。
function sheetTableFromValues_(values) {
  if (!values || values.length === 0) return JSON.parse(EMPTY_SHEET_TABLE_JSON)
  // getDataRange は空のシートでも A1 の1セルを返す
  if (values.length === 1 && values[0].every(function (v) { return v === '' })) {
    return JSON.parse(EMPTY_SHEET_TABLE_JSON)
  }
  var headers = values[0].map(function (h) { return String(h).trim() })
  var rows = []
  for (var i = 1; i < values.length; i++) {
    var row = values[i]
    var hasValue = false
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '') { hasValue = true; break }
    }
    if (hasValue) rows.push(row)
  }
  return { headers: headers, rows: rows }
}

function sheetsApiRangeName_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'"
}

function sheetsApiBatchGetUrl_(spreadsheetId, names) {
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values:batchGet?' +
    names.map(function (name) { return 'ranges=' + encodeURIComponent(sheetsApiRangeName_(name)) }).join('&') +
    '&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS'
}

// API は行末の空セルと、表の末尾の空行を省いて返す。getDisplayValues と同じ
// 長方形(最も長い行の幅)にそろえ、値はすべて文字列にする。
function padSheetsApiValues_(values) {
  var width = 0
  ;(values || []).forEach(function (r) { if (r.length > width) width = r.length })
  return (values || []).map(function (r) {
    var row = r.map(function (v) { return v === null || v === undefined ? '' : String(v) })
    while (row.length < width) row.push('')
    return row
  })
}

// 応答の range("'Tasks'!A1:AT501" など)のシート名部分
function sheetNameOfApiRange_(range) {
  var sheetPart = String(range || '').replace(/![^!]*$/, '')
  if (/^'.*'$/.test(sheetPart)) sheetPart = sheetPart.slice(1, -1).replace(/''/g, "'")
  return sheetPart
}

// 成功したら { tables }、失敗したら { error }(例外は投げない。通信の例外だけは
// 呼び出し側で受ける)
function readSheetTablesViaApi_(names) {
  var id = SpreadsheetApp.getActiveSpreadsheet().getId()
  var response = UrlFetchApp.fetch(sheetsApiBatchGetUrl_(id, names), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  })
  var code = response.getResponseCode()
  var text = response.getContentText()
  if (code !== 200) return { error: describeSheetsApiError_(code, text) }
  var body
  try {
    body = JSON.parse(text)
  } catch (e) {
    return { error: '応答を JSON として読めませんでした' }
  }
  var valueRanges = (body && body.valueRanges) || []
  if (valueRanges.length !== names.length) {
    return { error: '応答の範囲の数が違います(' + valueRanges.length + ' / ' + names.length + ')' }
  }
  var tables = {}
  for (var i = 0; i < names.length; i++) {
    if (sheetNameOfApiRange_(valueRanges[i].range) !== names[i]) {
      return { error: '応答の範囲が違います(' + valueRanges[i].range + ' / ' + names[i] + ')' }
    }
    tables[names[i]] = sheetTableFromValues_(padSheetsApiValues_(valueRanges[i].values))
  }
  return { tables: tables }
}

// 予備の読み方(計測の (b)): getSheets() を1回呼び、getDataRange().getDisplayValues()
function readSheetTablesViaSpreadsheetApp_(names) {
  var byName = {}
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sheet) {
    byName[sheet.getName()] = sheet
  })
  var tables = {}
  names.forEach(function (name) {
    var sheet = byName[name]
    tables[name] = sheet
      ? sheetTableFromValues_(sheet.getDataRange().getDisplayValues())
      : JSON.parse(EMPTY_SHEET_TABLE_JSON)
  })
  return tables
}

function chunkedCacheKey_(prefix, version, suffix) {
  return prefix + ':' + version + ':' + suffix
}

// スナップショットを使う最長の時間(ミリ秒)。スプレッドシートの直接の編集は onSpreadsheetChange で
// すぐ版が変わるが、トリガーが無い・失敗した時でも、この時間を過ぎたらシートから読み直す
var SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000

// 目録は「分割数:作った時刻(ミリ秒)」。作った時刻が無い(前の形式)・古すぎる時は使わない
function snapshotMetaUsable_(meta, now) {
  var parts = String(meta || '').split(':')
  var count = Number(parts[0])
  var savedAt = Number(parts[1])
  if (!(count > 0) || !(savedAt > 0)) return 0
  var age = now - savedAt
  if (age < 0 || age > SNAPSHOT_MAX_AGE_MS) return 0
  return count
}

function readSnapshotCache_(version) {
  return readChunkedCache_('snap', version)
}

// 版ごとのキャッシュ(gzip して base64 にし、90,000文字ずつに分けて CacheService に入れる)を読む。
// 無い・作ってから5分を過ぎた・壊れている時は null
function readChunkedCache_(prefix, version) {
  try {
    var cache = CacheService.getScriptCache()
    var meta = cache.get(chunkedCacheKey_(prefix, version, 'meta'))
    if (!meta) return null
    var count = snapshotMetaUsable_(meta, Date.now())
    if (!count) return null
    var keys = []
    for (var i = 0; i < count; i++) keys.push(chunkedCacheKey_(prefix, version, i))
    var parts = cache.getAll(keys)
    var encoded = ''
    for (var j = 0; j < count; j++) {
      var part = parts[keys[j]]
      if (part == null) return null
      encoded += part
    }
    var gz = Utilities.newBlob(Utilities.base64Decode(encoded), 'application/x-gzip')
    return JSON.parse(Utilities.ungzip(gz).getDataAsString('UTF-8'))
  } catch (e) {
    return null
  }
}

function writeSnapshotCache_(version, data) {
  return writeChunkedCache_('snap', version, data)
}

function writeChunkedCache_(prefix, version, data) {
  try {
    var gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(data), 'application/json'))
    var encoded = Utilities.base64Encode(gz.getBytes())
    var count = Math.ceil(encoded.length / SNAPSHOT_CHUNK_SIZE)
    if (count > SNAPSHOT_MAX_CHUNKS) return false
    var entries = {}
    for (var i = 0; i < count; i++) {
      entries[chunkedCacheKey_(prefix, version, i)] = encoded.substr(i * SNAPSHOT_CHUNK_SIZE, SNAPSHOT_CHUNK_SIZE)
    }
    var cache = CacheService.getScriptCache()
    cache.putAll(entries, SNAPSHOT_CACHE_TTL)
    // 目録は最後に書く(途中で失敗したら目録が無く、次回は読み直しになる)
    cache.put(chunkedCacheKey_(prefix, version, 'meta'), count + ':' + Date.now(), SNAPSHOT_CACHE_TTL)
    return true
  } catch (e) {
    return false
  }
}

// 4シート分のスナップショットを返す。版は必ずシートより先に読む(書き込みと
// 同時に読んでも、古い版のキーに新しいデータが入るだけで逆は起きない)。
// 1つのリクエストの中では、同じ版のスナップショットを使い回す(初期データと裏での読み込みを
// 1回で返す時に、キャッシュを2回読まない)
var _requestSnapshot = null

function loadSnapshot_() {
  var version = getDataVersion_()
  if (_requestSnapshot && _requestSnapshot.version === version) return _requestSnapshot
  var cached = timed_('cacheReadMs', function () { return readSnapshotCache_(version) })
  if (cached) {
    noteTiming_('cache', 'hit')
    _requestSnapshot = { version: version, data: cached, cacheHit: true }
    return _requestSnapshot
  }
  noteTiming_('cache', 'miss')
  // 記録を行に持っている時は、Tasks・Members の一覧の列に、行から組み立てた一覧を入れる(39-record-rows.gs)
  var data = fillRecordColumnsOfSnapshot_(readSheetTables_(SNAPSHOT_SHEETS))
  timed_('cacheWriteMs', function () { writeSnapshotCache_(version, data) })
  _requestSnapshot = { version: version, data: data, cacheHit: false }
  return _requestSnapshot
}

// シート1枚分の行(読み取り用に変換したもの。閲覧できるかの絞り込みの前)を、データの版ごとにキャッシュする。
// 経費・フォームの回答・採用の候補者で使う。書き込み・スプレッドシートの直接の編集で版が変わり、
// 作ってから5分を過ぎたものも使わない(スナップショットと同じ)。
// 閲覧できるかの絞り込みは、キャッシュから読んだ後に毎回行う。
// timing に <prefix>Cache: hit / miss を記録する
var _requestRows = {}

function loadVersionedRows_(prefix, loader) {
  var version = getTableVersion_(prefix)
  var memoKey = prefix + ':' + version
  if (_requestRows[memoKey]) return _requestRows[memoKey]
  var rows = readChunkedCache_(prefix, version)
  if (Array.isArray(rows)) {
    noteTiming_(prefix + 'Cache', 'hit')
  } else {
    noteTiming_(prefix + 'Cache', 'miss')
    rows = loader()
    writeChunkedCache_(prefix, version, rows)
  }
  _requestRows[memoKey] = rows
  return rows
}

// スナップショットの Settings から1つの値を読む(無ければシートから)
function settingValueFromSnapshot_(key) {
  try {
    var table = loadSnapshot_().data.Settings
    var keyCol = table.headers.indexOf('key')
    var valueCol = table.headers.indexOf('value')
    if (keyCol >= 0 && valueCol >= 0) {
      for (var i = 0; i < table.rows.length; i++) {
        if (String(table.rows[i][keyCol]) === key) return String(table.rows[i][valueCol] || '')
      }
      return ''
    }
  } catch (e) {
    // 読めなければシートから
  }
  return getSettingValue_(key)
}

