// ---- 処理時間の内訳 ----------------------------------------------------------
//
// doPost の応答に、GAS の中での処理時間の内訳(timing)を付ける。画面はこれをコンソールに出し、
// 往復にかかった時間のうち、どこまでが GAS の処理かを分けて見られるようにする。
//   totalMs   doPost の開始から応答を作るまで
//   authMs    セッションの確認・メンバーの特定・権限の確認
//   lockMs    ロックの待ち(書き込みだけ。読み取りはロックを取らない)
//   cache     初期データ: unchanged(版が同じ)/ hit(キャッシュ)/ miss(シートから読んだ)
//   readMs    シートの読み込み(キャッシュが無い時)
//   read      読み込みの方式: api(Sheets API の batchGet)/ spreadsheetApp(予備の方式)
//   readError Sheets API で読めなかった理由(予備の方式に切り替えた時)
//   filterMs  閲覧者ごとの絞り込み
//   verifyMs  IDトークンの確認(exchangeIdToken)
var _requestTiming = null

// 計っている区間の深さ。区間の中で記録した時間(例: 認証の中のキャッシュの読み込み)は
// 外側の区間に含まれるので、otherMs の計算では数えない
var _timingDepth = 0
var _timingNested = {}

function startRequestTiming_() {
  _requestTiming = { start: Date.now() }
  _requestActorId = null
  _notifyLimited = false
  _longCells = []
  _requestSnapshot = null
  _requestRows = {}
  _timingDepth = 0
  _timingNested = {}
  _actionTiming = null
  _authSnapshotVersion = null
  _prefetchedSheets = {}
  _requestEmailMap = null
  _sheetGrids = {}
  resetRecordRowsMemo_()
}

function noteTiming_(key, value) {
  if (!_requestTiming) return
  _requestTiming[key] = value
  if (_timingDepth > 0) _timingNested[key] = true
}

// 区間を手で計る時(開始と終わりが別の場所にある時)に使う
function beginTiming_() {
  _timingDepth++
  return Date.now()
}

// 同じ項目の時間を足していく(ファイルごとの処理など、何回も計る時)。区間の中なら外側と重ねて数えない
function addTiming_(key, ms) {
  if (!_requestTiming) return
  _requestTiming[key] = (_requestTiming[key] || 0) + ms
  if (_timingDepth > 0) _timingNested[key] = true
}

function endTiming_(key, started) {
  _timingDepth = Math.max(0, _timingDepth - 1)
  noteTiming_(key, Date.now() - started)
}

// 処理にかかった時間を記録しながら fn を実行する
function timed_(key, fn) {
  var t = beginTiming_()
  try {
    return fn()
  } finally {
    endTiming_(key, t)
  }
}

// ---- 書き込みの処理(runWriteAction_)の内訳 ----
// 処理の間だけ、シートの読み込み・書き込み・通知などの時間を種類ごとに足していく。入れ子になった時
// (通知の中でシートを読むなど)は、内側の時間を外側から引く(同じ時間を2回数えない)。
//   actionMs       処理の全体
//   sheetReadMs    行を探す読み込み(findRow_)
//   sheetWriteMs   行への書き込み(updateRowFields_。書く行を探す読み込みを含む。確定は flushMs)
//   notifyMs       管理者への通知の準備(宛先を調べる時間を除く)
//   recipientsMs   通知の宛先・言語を調べる(メンバー・メールアドレス・団体の通知先。スナップショットとキャッシュから)
//   mailMs         メールの送信(mailCount 件)
//   chatMs         Discord・Slack への送信
//   calendarMs     Google カレンダーの予定の更新
//   actionOtherMs  処理のうち、上のどれにも入らない時間
var _actionTiming = null

function beginActionTiming_() {
  _actionTiming = { stack: [], sums: {}, counts: {} }
  return beginTiming_()
}

function endActionTiming_(started) {
  var at = _actionTiming || { sums: {}, counts: {} }
  _actionTiming = null
  endTiming_('actionMs', started)
  if (!_requestTiming) return
  var inner = 0
  Object.keys(at.sums).forEach(function (k) {
    _requestTiming[k] = at.sums[k]
    _timingNested[k] = true
    inner += at.sums[k]
  })
  Object.keys(at.counts).forEach(function (k) { _requestTiming[k] = at.counts[k] })
  _requestTiming.actionOtherMs = Math.max(0, (_requestTiming.actionMs || 0) - inner)
  _timingNested.actionOtherMs = true
}

function measureAction_(key, fn) {
  var at = _actionTiming
  if (!at) return fn()
  var start = Date.now()
  at.stack.push(0)
  try {
    return fn()
  } finally {
    var elapsed = Date.now() - start
    var children = at.stack.pop()
    at.sums[key] = (at.sums[key] || 0) + Math.max(0, elapsed - children)
    if (at.stack.length) at.stack[at.stack.length - 1] += elapsed
  }
}

function countAction_(key) {
  if (_actionTiming) _actionTiming.counts[key] = (_actionTiming.counts[key] || 0) + 1
}

function jsonOutput_(obj) {
  if (_requestTiming) {
    var timing = { totalMs: Date.now() - _requestTiming.start }
    var known = 0
    Object.keys(_requestTiming).forEach(function (k) {
      if (k === 'start') return
      timing[k] = _requestTiming[k]
      if (/Ms$/.test(k) && typeof _requestTiming[k] === 'number' && !_timingNested[k]) known += _requestTiming[k]
    })
    // 内訳に無い時間(本文の解析・ここで計っていない処理)。区間の中の内訳は外側と重ねて数えない
    timing.otherMs = Math.max(0, timing.totalMs - known)
    obj.timing = timing
  }
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  )
}

// Reads a single value from the optional Settings sheet (see gas/README.md
// §4.6) by key. Returns '' when the sheet or the key doesn't exist yet
// (nothing configured) — every caller below treats that as "feature off".
// 画面が初期データの後に裏で読み込むもの(経費・フォームの回答・採用の候補者・自分のメールアドレス)を
// 1回で返す。往復の回数を減らし、結果の受け渡しで失敗する機会を減らすため。
// それぞれ、個別の操作(getExpenses など)と同じ権限の確認・絞り込みを通す。1つが失敗しても
// ほかは返す(失敗したものは errors に理由を入れる)
// 権限が無い部分は、失敗ではなく空(empty)を返す(一般のメンバーに候補者が無いのは正常)
var BACKGROUND_DATA_PARTS = [
  { key: 'expenses', action: 'getExpenses', empty: function () { return [] }, load: function (acting) { return getExpenses_(acting) } },
  { key: 'formSubmissions', action: 'getFormSubmissions', empty: function () { return [] }, load: function (acting) { return getFormSubmissions_(acting) } },
  { key: 'candidates', action: 'getCandidates', empty: function () { return [] }, load: function (acting) { return getCandidates_(acting) } },
  { key: 'myEmail', action: 'getMyEmails', empty: function () { return '' }, load: function (acting) { return getMemberEmailValueCached_(acting.id) } },
]

// withBackground: getInitialData・exchangeIdToken の応答に、裏での読み込み(getBackgroundData と同じもの)も
// 入れる。画面の通信を1回減らす(ログイン・再読み込みとも1回で全部そろう)。
// 失敗しても初期データは返す(background の代わりに backgroundError。画面は getBackgroundData を送り直す)
function attachBackgroundData_(data, memberId, body) {
  if (!body || !body.withBackground || !data || !data.memberId) return data
  var t = beginTiming_()
  try {
    var acting = getActingMember_(memberId, 'getBackgroundData')
    authorizeAction_(acting, 'getBackgroundData', body)
    data.background = getBackgroundData_(acting, body)
  } catch (err) {
    data.backgroundError = toErrorMessage_(err)
  }
  endTiming_('backgroundMs', t)
  return data
}

function getBackgroundData_(acting, body) {
  var out = { errors: {} }
  // ログインの直後に表示する画像(団体ロゴ・プロフィール画像)のうち、キャッシュにあるもの。
  // Drive は開かない(キャッシュに無いものは、画面が getFiles で別に取る)。
  // 画面が withFiles: false を送った時は入れない(応答の大きさと往復の時間を比べるため)
  if (!body || body.withFiles !== false) {
    var ft = beginTiming_()
    try {
      var fileIds = initialImageFileIds_(loadSnapshot_().data, acting.id)
      out.files = fileIds.length ? getFiles_(acting, fileIds, { cachedOnly: true, maxBytes: INITIAL_FILES_MAX_CHARS }) : []
    } catch (err) {
      out.files = []
    }
    endTiming_('filesMs', ft)
    var chars = 0
    out.files.forEach(function (f) { chars += f.data ? f.data.length : 0 })
    noteTiming_('filesKB', Math.round(chars / 1024))
    noteTiming_('filesCount', out.files.length)
  }
  // キャッシュに無い表(経費・フォームの回答・候補者・メール)を、まとめて1回で読んでおく
  prefetchBackgroundSheets_(acting, body)
  BACKGROUND_DATA_PARTS.forEach(function (part) {
    // 区間として計る(中のシートの読み込みの時間は、この中に含まれる)
    var t = beginTiming_()
    var allowed = true
    try {
      authorizeAction_(acting, part.action, body)
    } catch (denied) {
      allowed = false
    }
    try {
      out[part.key] = allowed ? part.load(acting) : part.empty()
    } catch (err) {
      out.errors[part.key] = toErrorMessage_(err)
    }
    endTiming_(part.key + 'Ms', t)
  })
  return out
}

function getSettingValue_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_SETTINGS)
  if (!sheet) return ''
  var headers = headerRow_(sheet)
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  if (keyCol === -1 || valueCol === -1) return ''
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return ''
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) === key) return String(rows[i][valueCol] || '')
  }
  return ''
}

