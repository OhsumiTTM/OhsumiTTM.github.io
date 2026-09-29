// Ohsumi レジストリ(FSIF が1つだけ運用する、団体の一覧と状態を管理する仕組み)
//
// レジストリ専用の Google アカウントのスプレッドシートに置く Apps Script。
// 団体単位の情報(団体ID・接続先・契約状態・チャンネル・担当者の連絡先・属性・利用状況の集計)だけを持ち、
// 団体のデータ(メンバー・タスクなど)やメンバーのメールアドレスは持たない。
// レジストリから団体の GAS へ指示を送る入口は作らない(団体の GAS が問い合わせに来る)。
//
// 第1段階の R1-a(この版)で作るもの:
//   - シートの用意(setupRegistry)
//   - 死活の確認(health。監視の GAS が15分ごとに問い合わせる)
//   - 毎日のバックアップ(直近30日分。誰とも共有しない)
//   - リクエストの回数の上限・大きさの上限
//   - 操作の記録(AuditLog)と、記録の無い直接の編集の検出
// 登録コード・管理画面・団体の登録・接続先の解決・提供停止は、R1-b 以降で足す。
//
// 設定と手順は registry/README.md を参照。

var REGISTRY_VERSION = 'r1a-1'

// シートと列(1行目の見出し)。列は見出しの名前で探す
var REGISTRY_SHEETS = {
  Orgs: ['org_id', 'gas_url', 'status', 'channel', 'display_name', 'created_at', 'suspend_at', 'suspend_reason', 'last_check_at', 'gas_version'],
  Contacts: ['org_id', 'name', 'email', 'phone'],
  Attributes: ['org_id', 'field', 'size', 'affiliation', 'started_year'],
  Usage: ['org_id', 'date', 'metrics_json'],
  RegistrationCodes: ['code_hash', 'kind', 'target_org_id', 'org_name', 'contact_name', 'contact_email', 'expires_at', 'issued_by', 'issued_at', 'used_at', 'used_org_id', 'revoked_at'],
  Secrets: ['org_id', 'registry_key', 'key_gen', 'updated_at'],
  AuditLog: ['at', 'actor', 'action', 'target', 'before', 'after', 'reason'],
  Admins: ['email', 'role', 'added_at', 'note'],
}
// 秘密を含む・書き換えてはいけないシート(保護をかける)
var REGISTRY_PROTECTED_SHEETS = ['Secrets', 'AuditLog']

var BACKUP_KEEP_DAYS = 30
var BACKUP_FOLDER_NAME = 'Ohsumi レジストリのバックアップ'
// リクエストの本文の上限(文字数)
var MAX_BODY_CHARS = 50000
// 1分あたりの上限(レジストリ全体)。Apps Script では送り元を区別できないため、全体で数える
var RATE_LIMITS = { all: 600, health: 60 }

// ---- 入口 ----

// レジストリには POST しか送らない。GET で届いた時は、POST が転送の途中で GET に変わり、本文が失われた
// 可能性が高い(URL が /exec ではない・/u/1/ を含むなど)。送った側が原因を記録して送り直せるよう、
// JSON で返す(何も処理していない)
function doGet() {
  return registryJson({
    ok: false,
    getReceived: true,
    error: 'レジストリに GET で届きました(POST の本文が転送の途中で失われた可能性があります)。何も処理していません。',
  })
}

function doPost(e) {
  try {
    var text = e && e.postData ? String(e.postData.contents || '') : ''
    if (text.length > MAX_BODY_CHARS) return registryJson({ ok: false, error: 'リクエストが大きすぎます。' })
    if (rateLimitExceeded('all', RATE_LIMITS.all)) return registryJson({ ok: false, error: '混み合っています。少し待ってください。', retryLater: true })
    var body
    try { body = JSON.parse(text) } catch (parseErr) { return registryJson({ ok: false, error: 'リクエストの形が正しくありません。' }) }
    if (!body || typeof body !== 'object') return registryJson({ ok: false, error: 'リクエストの形が正しくありません。' })
    var handler = REGISTRY_ACTIONS[String(body.action)]
    if (!handler) return registryJson({ ok: false, error: '知らない操作です。' })
    var limit = RATE_LIMITS[String(body.action)]
    if (limit && rateLimitExceeded(String(body.action), limit)) return registryJson({ ok: false, error: '混み合っています。少し待ってください。', retryLater: true })
    return registryJson(handler(body))
  } catch (err) {
    Logger.log('doPost failed: ' + (err && err.stack ? err.stack : err))
    return registryJson({ ok: false, error: '処理中に問題が発生しました。' })
  }
}

// 操作の一覧。R1-b 以降で足す
var REGISTRY_ACTIONS = {
  health: function (body) { return healthResponse(body.key) },
}

function registryJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

// ---- 死活の確認 ----

// 鍵(HEALTH_KEY)が無ければ、動いていることだけを返す。監視の GAS は鍵を付けて詳細を受け取る。
// 団体の情報は返さない
function healthResponse(key) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var res = { ok: true, version: REGISTRY_VERSION, time: new Date().toISOString() }
  if (!props.HEALTH_KEY || !safeEquals(String(key || ''), props.HEALTH_KEY)) return res
  res.lastBackupAt = props.LAST_BACKUP_AT || null
  res.unrecordedEdits = Number(props.LAST_UNRECORDED_EDITS || 0)
  res.rejectedLastHour = rejectedCount(Date.now())
  return res
}

// ---- 回数の上限 ----

function minuteBucket(now) { return Math.floor(now / 60000) }
function hourBucket(now) { return Math.floor(now / 3600000) }

// 1分あたりの回数を数え、上限を超えたら true。断った回数は1時間ごとに数える(監視が見る)
function rateLimitExceeded(bucket, limit, now) {
  now = now || Date.now()
  var cache = CacheService.getScriptCache()
  var key = 'rl:' + bucket + ':' + minuteBucket(now)
  var count = Number(cache.get(key) || 0) + 1
  cache.put(key, String(count), 120)
  if (count <= limit) return false
  var rk = 'rj:' + hourBucket(now)
  cache.put(rk, String(Number(cache.get(rk) || 0) + 1), 7200)
  return true
}

function rejectedCount(now) {
  return Number(CacheService.getScriptCache().get('rj:' + hourBucket(now)) || 0)
}

// ---- 値の扱い ----

// 長さが同じなら、どこで違っても同じ時間で比べる
function safeEquals(a, b) {
  a = String(a)
  b = String(b)
  var diff = a.length ^ b.length
  for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

// スプレッドシートに書く文字列が、数式として扱われないようにする
function safeCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return value
  return /^[=+\-@]/.test(value) ? "'" + value : value
}

function generateSecret() {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now())).replace(/=+$/, '')
}

function sha256Hex(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2) }).join('')
}

// ---- シート ----

function registrySheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) throw new Error('シート「' + name + '」がありません。setupRegistry() を実行してください。')
  return sheet
}

// 見出しをキーにした行の一覧({ row: シートの行番号, values: { 見出し: 値 } })
function readRows(name) {
  var sheet = registrySheet(name)
  var last = sheet.getLastRow()
  var width = sheet.getLastColumn()
  if (last < 2 || width < 1) return []
  var data = sheet.getRange(1, 1, last, width).getValues()
  var headers = data[0].map(String)
  return data.slice(1).map(function (r, i) {
    var values = {}
    headers.forEach(function (h, c) { values[h] = r[c] })
    return { row: i + 2, values: values }
  })
}

// 見出しの順に並べた1行を足す
function appendRowByHeaders(name, values) {
  var sheet = registrySheet(name)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String)
  sheet.appendRow(headers.map(function (h) { return safeCell(values[h] === undefined ? '' : values[h]) }))
}

// ---- 操作の記録 ----

// AuditLog に1行足す(追記だけ。書き換えない)。before / after はオブジェクトなら JSON にする
function appendAudit(entry) {
  var json = function (v) { return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v) }
  appendRowByHeaders('AuditLog', {
    at: new Date().toISOString(),
    actor: entry.actor || '',
    action: entry.action || '',
    target: entry.target || '',
    before: json(entry.before),
    after: json(entry.after),
    reason: entry.reason || '',
  })
}

// Orgs の1行の指紋。管理画面などの記録を伴う変更の後に覚えておき、
// 記録の無い変更(スプレッドシートの直接の編集)を見つけるのに使う
var ORG_FINGERPRINT_PREFIX = 'ORG_FP_'
var ORG_FINGERPRINT_COLUMNS = ['gas_url', 'status', 'channel', 'suspend_at']

function orgFingerprint(values) {
  return sha256Hex(JSON.stringify(ORG_FINGERPRINT_COLUMNS.map(function (c) { return String(values[c] === undefined ? '' : values[c]) })))
}

// 記録を伴う変更の後に呼ぶ(R1-b 以降の操作で使う)
function rememberOrgFingerprint(orgId, values) {
  PropertiesService.getScriptProperties().setProperty(ORG_FINGERPRINT_PREFIX + orgId, orgFingerprint(values))
}

// 覚えている指紋と違う行・覚えていない行・消えた行の団体ID
function findUnrecordedOrgEdits() {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var seen = {}
  var found = []
  readRows('Orgs').forEach(function (r) {
    var id = String(r.values.org_id || '')
    if (!id) return
    seen[id] = true
    if (props[ORG_FINGERPRINT_PREFIX + id] !== orgFingerprint(r.values)) found.push(id)
  })
  Object.keys(props).forEach(function (k) {
    if (k.indexOf(ORG_FINGERPRINT_PREFIX) === 0 && !seen[k.slice(ORG_FINGERPRINT_PREFIX.length)]) found.push(k.slice(ORG_FINGERPRINT_PREFIX.length))
  })
  return found
}

// ---- 毎日のバックアップ ----

// 時間主導のトリガー(毎日)から呼ぶ。記録の無い直接の編集を数えてから、スプレッドシートをコピーする。
// コピーは Secrets を含むので、編集者・閲覧者を外し、リンクの共有も「制限付き」にする。
// 30日より古いコピーはゴミ箱へ移す
function dailyRegistryBackup() {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    var props = PropertiesService.getScriptProperties()
    var unrecorded = findUnrecordedOrgEdits()
    props.setProperty('LAST_UNRECORDED_EDITS', String(unrecorded.length))
    if (unrecorded.length) console.warn('記録の無い変更がある団体: ' + unrecorded.join(', '))

    var folder = backupFolder()
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    var copy = DriveApp.getFileById(ss.getId()).makeCopy('Ohsumi レジストリ バックアップ ' + stamp, folder)
    makePrivate(copy)
    var removed = trashOldBackups(folder, Date.now())
    props.setProperty('LAST_BACKUP_AT', new Date().toISOString())
    console.log('バックアップを作りました: ' + copy.getName() + '(古いコピーを ' + removed + ' 件ゴミ箱へ移しました)')
    return { name: copy.getName(), removed: removed, unrecorded: unrecorded }
  } finally {
    lock.releaseLock()
  }
}

function makePrivate(file) {
  file.getEditors().forEach(function (u) { try { file.removeEditor(u) } catch (e) { /* 自分自身など */ } })
  file.getViewers().forEach(function (u) { try { file.removeViewer(u) } catch (e) { /* 自分自身など */ } })
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE) } catch (e) { /* 変えられない場合 */ }
}

function backupFolder() {
  var props = PropertiesService.getScriptProperties()
  var id = props.getProperty('BACKUP_FOLDER_ID')
  if (id) {
    try { return DriveApp.getFolderById(id) } catch (e) { /* 消された: 作り直す */ }
  }
  var folder = DriveApp.createFolder(BACKUP_FOLDER_NAME)
  makePrivate(folder)
  props.setProperty('BACKUP_FOLDER_ID', folder.getId())
  return folder
}

function trashOldBackups(folder, now) {
  var limit = now - BACKUP_KEEP_DAYS * 24 * 3600 * 1000
  var removed = 0
  var files = folder.getFiles()
  while (files.hasNext()) {
    var f = files.next()
    if (f.getDateCreated().getTime() < limit) {
      f.setTrashed(true)
      removed++
    }
  }
  return removed
}

// ---- 最初の設定(エディタから実行する) ----

// シートの用意・保護・健康確認の鍵・バックアップのトリガーを作る。何度実行しても同じ結果になる
function setupRegistry() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  Object.keys(REGISTRY_SHEETS).forEach(function (name) {
    var headers = REGISTRY_SHEETS[name]
    var sheet = ss.getSheetByName(name)
    if (!sheet) {
      sheet = ss.insertSheet(name)
      sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      sheet.setFrozenRows(1)
      console.log('シートを作りました: ' + name)
      return
    }
    // 足りない列を右に足す(既にある列は変えない)
    var width = Math.max(sheet.getLastColumn(), 1)
    var current = sheet.getRange(1, 1, 1, width).getValues()[0].map(String)
    var missing = headers.filter(function (h) { return current.indexOf(h) < 0 })
    if (missing.length) {
      var start = current.filter(function (h) { return h }).length + 1
      sheet.getRange(1, start, 1, missing.length).setValues([missing])
      console.log(name + ' に列を足しました: ' + missing.join(', '))
    }
  })
  REGISTRY_PROTECTED_SHEETS.forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return
    var p = sheet.protect().setDescription('Ohsumi レジストリ: ' + name + ' は GAS だけが書き込む')
    p.getEditors().forEach(function (u) { try { p.removeEditor(u) } catch (e) { /* 自分自身 */ } })
  })

  var props = PropertiesService.getScriptProperties()
  if (!props.getProperty('HEALTH_KEY')) {
    props.setProperty('HEALTH_KEY', generateSecret())
    console.log('死活の確認の鍵(HEALTH_KEY)を作りました。監視の GAS のスクリプトプロパティ HEALTH_KEY に、この値を入れてください: ' + props.getProperty('HEALTH_KEY'))
  } else {
    console.log('死活の確認の鍵(HEALTH_KEY)は作成済みです(スクリプトプロパティで確認できます)')
  }
  backupFolder()

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRegistryBackup') ScriptApp.deleteTrigger(t)
  })
  ScriptApp.newTrigger('dailyRegistryBackup').timeBased().everyDays(1).atHour(3).create()
  console.log('毎日のバックアップ(午前3時台)のトリガーを作りました')
  console.log('次に、ウェブアプリとしてデプロイしてください(次のユーザーとして実行: 自分、アクセスできるユーザー: 全員)')
}
