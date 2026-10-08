// ---- 画像アップロード用フォルダ ------------------------------------------------
//
// プロフィール画像・団体ロゴ・経費の領収書・アンケート設問の画像の保存先。
// フォルダIDはスクリプトプロパティにだけ持ち、リクエストで渡されたフォルダIDは
// 使わない（任意のフォルダへの書き込みを防ぐため）。

var UPLOAD_FOLDER_PROPERTY_KEY = 'UPLOAD_FOLDER_ID'
// 移行前のファイルがあるフォルダ(カンマ区切りで複数可)。getFiles はこれらの
// フォルダ内のファイルも返す(将来、FSIFの本番を移行するときに旧フォルダの
// 画像を表示するため)。スクリプトプロパティに手動で設定する。
var LEGACY_UPLOAD_FOLDERS_PROPERTY_KEY = 'LEGACY_UPLOAD_FOLDER_IDS'
// 'true' のとき、新しくアップロードしたファイルを非公開のままにする。
// makeUploadsPrivate() の実行時に 'true' になる(段階③)。それまでは、公開CSV
// 時代のフロントでも表示できるよう「リンクを知っている全員が閲覧可」にする。
var UPLOADS_PRIVATE_PROPERTY_KEY = 'UPLOADS_PRIVATE'
var UPLOAD_FOLDER_NAME = 'Ohsumi uploads'

// スクリプトプロパティにフォルダIDがなければ、スクリプトを実行している
// アカウントのDriveにフォルダを作成してIDを保存する。既にあれば何もしない。
function ensureUploadFolder_() {
  var props = PropertiesService.getScriptProperties()
  var existingId = props.getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (existingId) {
    console.log('✅ アップロード用フォルダ既存: ' + existingId)
    return existingId
  }
  var folder = DriveApp.createFolder(UPLOAD_FOLDER_NAME)
  props.setProperty(UPLOAD_FOLDER_PROPERTY_KEY, folder.getId())
  console.log('✅ アップロード用フォルダ作成: ' + folder.getName() + ' (' + folder.getId() + ')')
  return folder.getId()
}

function applyUploadSharing_(file) {
  if (PropertiesService.getScriptProperties().getProperty(UPLOADS_PRIVATE_PROPERTY_KEY) === 'true') return
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
}

// 領収書の種類とサイズの確認(フロントの expense-application-modal.tsx と同じ基準)。
// ブラウザによっては HEIC の種類が空で届くため、拡張子でも判定する。
var RECEIPT_MAX_BYTES = 5 * 1024 * 1024
var RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
var RECEIPT_EXTENSION_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
}
function validateReceiptFile_(mimeType, filename, byteLength) {
  if (byteLength > RECEIPT_MAX_BYTES) throw userError_('領収書のファイルサイズは5MBまでです。')
  var mime = String(mimeType || '').toLowerCase()
  if (RECEIPT_MIME_TYPES.indexOf(mime) >= 0) return mime
  var ext = String(filename || '').toLowerCase().split('.').pop()
  var byExt = RECEIPT_EXTENSION_MIME[ext]
  if (byExt && (!mime || mime === 'application/octet-stream')) return byExt
  throw userError_('領収書は画像(JPEG・PNG・HEICなど)またはPDFのみアップロードできます。')
}

function getUploadFolder_() {
  var folderId = PropertiesService.getScriptProperties().getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (!folderId) throw userError_('Drive folder is not configured. Run setupOhsumi() in the Apps Script editor.')
  return DriveApp.getFolderById(folderId)
}

// シートが存在しなければ作成し、不足しているヘッダー列を末尾に追加する。
// 既存のデータ行や既存の列は一切変更しない。
function ensureSheetHeaders_(ss, sheetName, requiredHeaders) {
  var sheet = ss.getSheetByName(sheetName)
  if (!sheet) {
    sheet = ss.insertSheet(sheetName)
    sheet.appendRow(requiredHeaders)
    console.log('📄 シート作成: ' + sheetName + ' (' + requiredHeaders.length + ' 列)')
    return
  }

  var lastCol = sheet.getLastColumn()
  var existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim() })
    : []

  var missing = requiredHeaders.filter(function (h) { return existing.indexOf(h) === -1 })
  if (missing.length === 0) {
    console.log('✅ ' + sheetName + ': ヘッダー問題なし (' + existing.length + ' 列)')
    return
  }

  // 不足列を1行目の末尾に追加（既存データ行は空欄のままで問題ない）
  var startCol = lastCol + 1
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing])
  console.log('➕ ' + sheetName + ': ' + missing.length + ' 列追加 — ' + missing.join(', '))
}

// 行を末尾に追加する。値は {列名: 値} で渡し、シートの実際の列の順番に合わせて並べる
// (列の順番を前提にした配列で追加すると、列が足された古いシートでずれるため)。
// 一覧(SHEET_HEADERS)に無い列名は、書き込み先が無いのでエラーにする。
function appendRowByHeaders_(sheet, sheetName, obj) {
  var headers = headerRow_(sheet)
  var unknown = Object.keys(obj).filter(function (k) { return headers.indexOf(k) === -1 })
  if (unknown.length) {
    throw userError_(sheetName + 'シートに列が見つかりません: ' + unknown.join(', ') +
      '。Apps Scriptエディタで setupOhsumi() を実行してヘッダー列を追加してください。')
  }
  // 記録を行に持っている時は、一覧の列は記録のシートに書く(39-record-rows.gs)
  var recordFields = null
  if (recordListsOf_(sheetName).length && recordRowsOn_() && obj.id !== undefined && obj.id !== '') {
    recordFields = {}
    Object.keys(obj).forEach(function (k) { if (isRecordColumn_(sheetName, k)) recordFields[k] = obj[k] })
  }
  var row = headers.map(function (h) { return obj[h] !== undefined && !(recordFields && h in recordFields) ? obj[h] : '' })
  assertRowCellLengths_(sheetName, headers, row)
  protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, sheetName)
  sheet.appendRow(row)
  if (recordFields && Object.keys(recordFields).length) splitRecordFields_(sheetName, String(obj.id), recordFields)
}

// A member is completing a certain number of same-category tasks and
// auto-certifying isn't something this file does — that check runs
// client-side (lib/ohsumi/store.tsx) since it only needs data already in
// hand. This file only handles writes coming from the browser.

// doGet が何から呼ばれたかを実行ログに残す。値は個人情報を含み得るので、パラメータの名前と
// 値の長さだけを残す(値そのものは残さない)
function logGetRequest_(e) {
  try {
    var params = (e && e.parameter) || {}
    var summary = Object.keys(params).map(function (k) { return k + '(' + String(params[k]).length + '文字)' })
    console.log('doGet に届きました: ' + JSON.stringify({
      parameters: summary,
      queryStringLength: e && e.queryString ? String(e.queryString).length : 0,
      pathInfo: e && e.pathInfo ? String(e.pathInfo).slice(0, 100) : '',
      contentLength: e && e.contentLength != null ? e.contentLength : -1,
      postDataType: e && e.postData ? String(e.postData.type || '') : '',
    }))
  } catch (err) {
    // 記録できなくても応答は返す
  }
}

