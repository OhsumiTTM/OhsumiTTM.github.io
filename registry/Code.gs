// Ohsumi レジストリ(FSIF が1つだけ運用する、団体の一覧と状態を管理する仕組み)
//
// レジストリ専用の Google アカウントのスプレッドシートに置く Apps Script。
// 団体単位の情報(団体ID・接続先・契約状態・チャンネル・担当者の連絡先・属性・利用状況の集計)だけを持ち、
// 団体のデータ(メンバー・タスクなど)やメンバーのメールアドレスは持たない。
// レジストリから団体の GAS へ指示を送る入口は作らない(団体の GAS が問い合わせに来る)。
//
// 第1段階の R1-a で作ったもの:
//   - シートの用意(setupRegistry)
//   - 死活の確認(health。監視の GAS が15分ごとに問い合わせる)
//   - 毎日のバックアップ(直近30日分。誰とも共有しない)
//   - リクエストの回数の上限・大きさの上限
//   - 操作の記録(AuditLog)と、記録の無い直接の編集の検出
// R1-b(この版)で足したもの:
//   - 管理者のログイン(Google の ID トークン → 管理画面用のセッショントークン。署名の鍵は Ohsumi 本体とは別)
//     管理者はスクリプトプロパティ ADMIN_EMAILS の許可リストで決める
//   - 管理画面の一覧(団体・登録コード・操作の記録)
//   - 登録コードの発行・取り消し(コードは発行した画面で1回だけ表示し、SHA-256 だけを保存する)
//   - 登録コードを使う処理(consumeRegistrationCode。R1-c の登録から呼ぶ)
// R1-c で足したもの:
//   - 団体の登録(registerOrg。団体の GAS が登録コードを使って団体を登録し、共有鍵を受け取る)。
//     通信が途中で失われて送り直された時は、同じ結果(同じ共有鍵)を返す(二重に登録しない)
//   - 再登録コード(kind: reissue。共有鍵が漏れた時の作り直し・接続先の変更。管理画面で発行する)
//   - 登録の失敗(登録コードの総当たり)の回数の上限
// 接続先の解決・提供停止は、R1-d 以降で足す(データの形は用意してある)。
//
// 設定と手順は registry/README.md を参照。

var REGISTRY_VERSION = 'r1c-1'

// シートと列(1行目の見出し)。列は見出しの名前で探す
//   Orgs の列(R1-c〜R1-e で使う列も、今のうちに用意する):
//     org_id・gas_url(接続先)・status(active / suspended)・channel・display_name・created_at(登録日)
//     suspend_at(停止の予定日時)・suspend_reason・last_check_at(団体の GAS が最後に確認に来た時刻)・gas_version
//     contract_status(active 契約中 / ending 終了予定 / ended 終了)・contract_until(契約の終了日)・contract_note
//     suspend_scheduled_by(停止の予定を入れた管理者)・suspend_notices_json(停止の予告を送った記録)・updated_at
var REGISTRY_SHEETS = {
  Orgs: ['org_id', 'gas_url', 'status', 'channel', 'display_name', 'created_at', 'suspend_at', 'suspend_reason', 'last_check_at', 'gas_version',
    'contract_status', 'contract_until', 'contract_note', 'suspend_scheduled_by', 'suspend_notices_json', 'updated_at'],
  Contacts: ['org_id', 'name', 'email', 'phone'],
  Attributes: ['org_id', 'field', 'size', 'affiliation', 'started_year'],
  Usage: ['org_id', 'date', 'metrics_json'],
  RegistrationCodes: ['code_hash', 'kind', 'target_org_id', 'org_name', 'contact_name', 'contact_email', 'expires_at', 'issued_by', 'issued_at', 'used_at', 'used_org_id', 'revoked_at',
    'code_id', 'revoked_by', 'note'],
  // registry_key は共有鍵そのもの(団体の GAS との確認に使うため、元の値を持つ。保護したシート・誰とも共有しない)。
  // register_nonce_hash は、最後の登録の送り直しを見分けるための値(団体の GAS が作ってスクリプトプロパティに
  // 保存した乱数 registerNonce)の SHA-256
  Secrets: ['org_id', 'registry_key', 'key_gen', 'updated_at', 'register_nonce_hash'],
  AuditLog: ['at', 'actor', 'action', 'target', 'before', 'after', 'reason'],
}
// 管理者は、スクリプトプロパティ ADMIN_EMAILS(カンマ区切り)の許可リストで決める。
// R1-a で作った Admins シートは使わない(残っていても読まない)
// 秘密を含む・書き換えてはいけないシート(保護をかける)
var REGISTRY_PROTECTED_SHEETS = ['Secrets', 'AuditLog']

var BACKUP_KEEP_DAYS = 30
var BACKUP_FOLDER_NAME = 'Ohsumi レジストリのバックアップ'
// リクエストの本文の上限(文字数)
var MAX_BODY_CHARS = 50000
// 1分あたりの上限(レジストリ全体)。Apps Script では送り元を区別できないため、全体で数える
var RATE_LIMITS = { all: 600, health: 60, adminLogin: 30, registerOrg: 10 }

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
    // 利用者に見せてよいエラー(registryError で作ったもの)は、そのメッセージを返す。
    // それ以外は中身を返さない(実行ログにだけ残す)
    if (err && err.registryUser) {
      var out = { ok: false, error: err.message }
      if (err.authError) out.authError = true
      if (err.reauth) out.reauthRequired = true
      return registryJson(out)
    }
    Logger.log('doPost failed: ' + (err && err.stack ? err.stack : err))
    return registryJson({ ok: false, error: '処理中に問題が発生しました。' })
  }
}

// 利用者に見せてよいエラー。authError はセッションが無効(管理画面はログイン画面に戻る)
function registryError(message, flags) {
  var e = new Error(message)
  e.registryUser = true
  if (flags && flags.authError) e.authError = true
  if (flags && flags.reauth) e.reauth = true
  return e
}

// 操作の一覧。R1-c 以降で足す
var REGISTRY_ACTIONS = {
  health: function (body) { return healthResponse(body.key) },
  adminLogin: function (body) { return adminLogin(body, Date.now()) },
  adminOverview: function (body) { return adminOverview(body, Date.now()) },
  issueRegistrationCode: function (body) { return issueRegistrationCode(body, Date.now()) },
  revokeRegistrationCode: function (body) { return revokeRegistrationCode(body, Date.now()) },
  registerOrg: function (body) { return registerOrg(body, Date.now()) },
}

function registryJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

// ---- 死活の確認 ----

// 鍵(HEALTH_KEY)が無ければ、動いていることだけを返す。監視の GAS は鍵を付けて詳細を受け取る。
// 鍵を付けて来たのに合わない時は keyValid: false を付ける(監視が「鍵が違う」と分かるように。
// 鍵を付けない問い合わせには付けない)。団体の情報は返さない
function healthResponse(key) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var res = { ok: true, version: REGISTRY_VERSION, time: new Date().toISOString() }
  var given = String(key || '')
  if (!given) return res
  if (!props.HEALTH_KEY || !safeEquals(given, props.HEALTH_KEY)) {
    res.keyValid = false
    return res
  }
  res.keyValid = true
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

// ---- 管理者のログイン ----
//
// Ohsumi 本体と同じ方式: 管理画面が Google の ID トークンと乱数を送り、レジストリが tokeninfo で確かめて、
// 管理画面用のセッショントークンを返す。署名の鍵(ADMIN_SESSION_KEY)はレジストリだけが持ち、本体の鍵とは別。
//   - ID トークンの aud は、レジストリ用の OAuth クライアント(スクリプトプロパティ OAUTH_CLIENT_ID)
//   - nonce は 'registry-admin.' + base64url(SHA-256(乱数))。同じ nonce は1回だけ使える
//   - メールアドレスが ADMIN_EMAILS に無い人は入れない(断ったことも記録する)
//   - セッションは30分で切れ、延長しない。許可リストから外した人は、次の操作から断る
//   - 登録コードの発行は、5分以内に Google でログインしたセッションだけ(古ければログインし直してもらう)

var ADMIN_SESSION_TTL_SEC = 30 * 60
var ADMIN_REAUTH_SEC = 5 * 60
var ADMIN_NONCE_PREFIX = 'registry-admin.'
var ADMIN_TOKEN_VERSION = 'ra1'

function nowSecOf(nowMs) { return Math.floor(nowMs / 1000) }

function b64url(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '')
}

function b64urlDecodeToString(text) {
  var s = String(text)
  while (s.length % 4) s += '='
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8')
}

function sha256B64url(text) {
  return b64url(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8))
}

// 許可リスト(小文字にそろえる)
function adminEmails(props) {
  return String(props.ADMIN_EMAILS || '').split(',').map(function (s) { return s.trim().toLowerCase() }).filter(Boolean)
}

function isAdminEmail(props, email) {
  return adminEmails(props).indexOf(String(email || '').trim().toLowerCase()) >= 0
}

// Google の ID トークンを確かめ、{ email, iat } を返す
function verifyAdminIdToken(idToken, nonceSecret, props, nowMs) {
  if (!props.OAUTH_CLIENT_ID) throw registryError('レジストリの設定(OAUTH_CLIENT_ID)が未設定です。README の手順で設定してください。')
  if (!/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(String(idToken || '')) || String(idToken).length > 4096) {
    throw registryError('ログインの情報の形式が正しくありません。もう一度ログインしてください。')
  }
  if (!nonceSecret || String(nonceSecret).length < 16 || String(nonceSecret).length > 256) {
    throw registryError('ログインの情報の形式が正しくありません。もう一度ログインしてください。')
  }
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true })
  if (resp.getResponseCode() !== 200) throw registryError('Google のログイン情報を確認できませんでした。もう一度ログインしてください。')
  var info = JSON.parse(resp.getContentText())
  if (info.aud !== props.OAUTH_CLIENT_ID) throw registryError('ログイン情報の発行元が、この管理画面と一致しません。')
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') throw registryError('ログイン情報の発行元が正しくありません。')
  if (!(Number(info.exp) > nowSecOf(nowMs))) throw registryError('Google のログイン情報の有効期限が切れています。もう一度ログインしてください。')
  if (!info.email || (info.email_verified !== true && info.email_verified !== 'true')) {
    throw registryError('メールアドレスが確認されていない Google アカウントは使えません。')
  }
  var expected = ADMIN_NONCE_PREFIX + sha256B64url(nonceSecret)
  if (!info.nonce || !safeEquals(info.nonce, expected)) throw registryError('ログイン情報がこの画面のものではありません。もう一度ログインしてください。')
  var cache = CacheService.getScriptCache()
  var nonceKey = 'adminNonce:' + sha256B64url(info.nonce)
  if (cache.get(nonceKey)) throw registryError('このログイン情報は既に使われています。もう一度ログインしてください。')
  cache.put(nonceKey, '1', 3600)
  return { email: String(info.email).toLowerCase(), iat: Number(info.iat) || nowSecOf(nowMs) }
}

function signAdminPayload(payloadB64, key) {
  return b64url(Utilities.computeHmacSha256Signature(ADMIN_TOKEN_VERSION + '.' + payloadB64, key))
}

function issueAdminSession(email, authSec, props, nowMs) {
  if (!props.ADMIN_SESSION_KEY || !props.ADMIN_SESSION_KID) throw registryError('レジストリの設定が完了していません。setupRegistry() を実行してください。')
  var now = nowSecOf(nowMs)
  var payload = { sub: email, kid: props.ADMIN_SESSION_KID, iat: now, exp: now + ADMIN_SESSION_TTL_SEC, auth: authSec, sid: generateSecret().slice(0, 12) }
  var payloadB64 = b64url(JSON.stringify(payload))
  return { token: ADMIN_TOKEN_VERSION + '.' + payloadB64 + '.' + signAdminPayload(payloadB64, props.ADMIN_SESSION_KEY), exp: payload.exp, email: email, authAt: authSec }
}

// セッショントークンを確かめ、payload を返す。無効なら authError の例外
function verifyAdminSession(token, props, nowMs) {
  var parts = String(token || '').split('.')
  var invalid = function (msg) { return registryError(msg || 'ログインの有効期限が切れました。もう一度ログインしてください。', { authError: true }) }
  if (parts.length !== 3 || parts[0] !== ADMIN_TOKEN_VERSION || !props.ADMIN_SESSION_KEY) throw invalid()
  if (!safeEquals(signAdminPayload(parts[1], props.ADMIN_SESSION_KEY), parts[2])) throw invalid()
  var payload
  try { payload = JSON.parse(b64urlDecodeToString(parts[1])) } catch (e) { throw invalid() }
  if (!payload || payload.kid !== props.ADMIN_SESSION_KID) throw invalid()
  if (!(Number(payload.exp) > nowSecOf(nowMs))) throw invalid()
  if (!isAdminEmail(props, payload.sub)) throw invalid('このアカウントは管理者として登録されていません。')
  return payload
}

function adminLogin(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var google = verifyAdminIdToken(body.idToken, body.nonceSecret, props, nowMs)
  if (!isAdminEmail(props, google.email)) {
    appendAudit({ actor: google.email, action: 'adminLoginDenied', reason: '許可リスト(ADMIN_EMAILS)に無いアカウント' })
    throw registryError('このアカウントは管理者として登録されていません。', { authError: true })
  }
  var session = issueAdminSession(google.email, nowSecOf(nowMs), props, nowMs)
  appendAudit({ actor: google.email, action: 'adminLogin' })
  return { ok: true, result: { session: session } }
}

// ---- 管理画面の一覧 ----

function isoOf(v) {
  if (v instanceof Date) return v.toISOString()
  return v === null || v === undefined ? '' : String(v)
}

function timeOf(v) {
  if (v instanceof Date) return v.getTime()
  var t = Date.parse(String(v || ''))
  return isNaN(t) ? NaN : t
}

var STALE_CHECK_DAYS = 7

// 団体の表示用の状態(Google のサービスを使わない純粋な関数)。
//   state: suspended(停止中。status が suspended か、停止の予定日時を過ぎた)/ scheduled(停止の予定あり)/ active(有効)
//   checkState: never(まだ一度も確認に来ていない)/ stale(最後の確認から7日を超えた)/ ok
function orgDisplayState(values, nowMs) {
  var suspendAt = timeOf(values.suspend_at)
  var state = 'active'
  if (String(values.status) === 'suspended' || (suspendAt > 0 && suspendAt <= nowMs)) state = 'suspended'
  else if (suspendAt > nowMs) state = 'scheduled'
  var lastCheck = timeOf(values.last_check_at)
  var checkState = !(lastCheck > 0) ? 'never' : nowMs - lastCheck > STALE_CHECK_DAYS * 24 * 3600 * 1000 ? 'stale' : 'ok'
  return { state: state, checkState: checkState }
}

function orgSummary(values, nowMs) {
  var ds = orgDisplayState(values, nowMs)
  return {
    orgId: String(values.org_id || ''),
    displayName: String(values.display_name || ''),
    status: String(values.status || ''),
    state: ds.state,
    checkState: ds.checkState,
    contractStatus: String(values.contract_status || ''),
    contractUntil: isoOf(values.contract_until),
    contractNote: String(values.contract_note || ''),
    lastCheckAt: isoOf(values.last_check_at),
    createdAt: isoOf(values.created_at),
    suspendAt: isoOf(values.suspend_at),
    suspendReason: String(values.suspend_reason || ''),
    channel: String(values.channel || ''),
    gasUrl: String(values.gas_url || ''),
    gasVersion: String(values.gas_version || ''),
  }
}

// 登録コードの状態(純粋な関数): revoked / used / expired / unused
function registrationCodeState(values, nowMs) {
  if (String(values.revoked_at || '')) return 'revoked'
  if (String(values.used_at || '')) return 'used'
  var exp = timeOf(values.expires_at)
  if (!(exp > nowMs)) return 'expired'
  return 'unused'
}

function codeSummary(values, nowMs) {
  return {
    codeId: String(values.code_id || ''),
    kind: String(values.kind || 'new'),
    targetOrgId: String(values.target_org_id || ''),
    orgName: String(values.org_name || ''),
    contactName: String(values.contact_name || ''),
    contactEmail: String(values.contact_email || ''),
    note: String(values.note || ''),
    state: registrationCodeState(values, nowMs),
    expiresAt: isoOf(values.expires_at),
    issuedBy: String(values.issued_by || ''),
    issuedAt: isoOf(values.issued_at),
    usedAt: isoOf(values.used_at),
    usedOrgId: String(values.used_org_id || ''),
    revokedAt: isoOf(values.revoked_at),
    revokedBy: String(values.revoked_by || ''),
  }
}

var AUDIT_SHOW_MAX = 200

// 管理画面の一覧を1回で返す(団体・登録コード・最近の操作の記録)。通信の回数を減らすため
function adminOverview(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession(body.session, props, nowMs)
  var orgs = readRows('Orgs').filter(function (r) { return String(r.values.org_id || '') }).map(function (r) { return orgSummary(r.values, nowMs) })
  var codes = readRows('RegistrationCodes').filter(function (r) { return String(r.values.code_hash || '') }).map(function (r) { return codeSummary(r.values, nowMs) })
  codes.sort(function (a, b) { return String(b.issuedAt).localeCompare(String(a.issuedAt)) })
  var audit = readRows('AuditLog').slice(-AUDIT_SHOW_MAX).reverse().map(function (r) {
    return { at: isoOf(r.values.at), actor: String(r.values.actor || ''), action: String(r.values.action || ''), target: String(r.values.target || ''),
      before: String(r.values.before || ''), after: String(r.values.after || ''), reason: String(r.values.reason || '') }
  })
  return {
    ok: true,
    result: {
      me: { email: session.sub, authAt: session.auth, exp: session.exp },
      orgs: orgs,
      codes: codes,
      audit: audit,
      codeTtlDays: REGISTRATION_CODE_TTL_DAYS,
    },
  }
}

// ---- 登録コード ----
//
// 16文字(読み間違えない31種類の文字。約79ビット)。4文字ずつ区切って表示する。
// レジストリには SHA-256(区切りを除いて大文字にしたもの)だけを保存し、元のコードは残さない。
// 有効期限は14日。使用済み・期限切れ・取り消し済みは使えない(どの理由でも同じエラーを返す)

var REGISTRATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
var REGISTRATION_CODE_LENGTH = 16
var REGISTRATION_CODE_TTL_DAYS = 14
var REGISTRATION_CODE_INVALID = '登録コードが正しくないか、使えなくなっています(使用済み・期限切れ・取り消し済み)。FSIF にお問い合わせください。'

// 推測できない乱数のバイト列(UUID と時刻を SHA-256 でまとめたもの。足りなければ繰り返す)
function randomBytes(count) {
  var out = []
  while (out.length < count) {
    var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now()), String(out.length)].join(':')
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8).forEach(function (b) { out.push(b & 0xff) })
  }
  return out.slice(0, count)
}

function generateRegistrationCode() {
  var n = REGISTRATION_CODE_ALPHABET.length
  var limit = Math.floor(256 / n) * n // 偏りが出ないよう、これ以上のバイトは捨てる
  var code = ''
  while (code.length < REGISTRATION_CODE_LENGTH) {
    randomBytes(32).forEach(function (b) {
      if (code.length < REGISTRATION_CODE_LENGTH && b < limit) code += REGISTRATION_CODE_ALPHABET.charAt(b % n)
    })
  }
  return code
}

// 入力のゆれ(小文字・区切り・空白)をそろえる
function normalizeRegistrationCode(input) {
  return String(input || '').toUpperCase().replace(/[\s\-_]/g, '')
}

function formatRegistrationCode(code) {
  return code.match(/.{1,4}/g).join('-')
}

// 保存する形は 'sha256:' + 16進数(数字だけの値がスプレッドシートで数として扱われないように、前に文字を付ける)
function registrationCodeHash(input) {
  return 'sha256:' + sha256Hex(normalizeRegistrationCode(input))
}

function cleanText(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
}

function withRegistryLock(fn) {
  var lock = LockService.getScriptLock()
  lock.waitLock(10000)
  try {
    return fn()
  } finally {
    lock.releaseLock()
  }
}

function issueRegistrationCode(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession(body.session, props, nowMs)
  if (!(nowSecOf(nowMs) - Number(session.auth) <= ADMIN_REAUTH_SEC)) {
    throw registryError('登録コードを発行する前に、もう一度 Google でログインしてください(5分以内のログインが必要です)。', { reauth: true })
  }
  var kind = String(body.kind || 'new') === 'reissue' ? 'reissue' : 'new'
  var targetOrgId = kind === 'reissue' ? cleanText(body.targetOrgId, 80) : ''
  var orgName = cleanText(body.orgName, 100)
  if (kind === 'reissue') {
    // 再登録コード: 登録済みの団体向け(共有鍵の作り直し・接続先の変更)。団体名は Orgs から
    var target = findOrgRow(targetOrgId)
    if (!target) throw registryError('再登録する団体が見つかりません。')
    orgName = cleanText(target.values.display_name, 100) || targetOrgId
  }
  if (!orgName) throw registryError('どの団体向けかが分かるよう、団体名(契約先の名前)を入れてください。')
  var contactName = cleanText(body.contactName, 100)
  var contactEmail = cleanText(body.contactEmail, 200)
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) throw registryError('担当者のメールアドレスの形が正しくありません。')
  var note = cleanText(body.note, 500)
  return withRegistryLock(function () {
    var code = generateRegistrationCode()
    var codeId = 'rc_' + generateSecret().slice(0, 10)
    var issuedAt = new Date(nowMs).toISOString()
    var expiresAt = new Date(nowMs + REGISTRATION_CODE_TTL_DAYS * 24 * 3600 * 1000).toISOString()
    appendRowByHeaders('RegistrationCodes', {
      code_id: codeId,
      code_hash: registrationCodeHash(code),
      kind: kind,
      target_org_id: targetOrgId,
      org_name: orgName,
      contact_name: contactName,
      contact_email: contactEmail,
      note: note,
      expires_at: expiresAt,
      issued_by: session.sub,
      issued_at: issuedAt,
    })
    // 記録にはコードもハッシュも残さない
    appendAudit({ actor: session.sub, action: 'issueRegistrationCode', target: codeId, after: { kind: kind, targetOrgId: targetOrgId, orgName: orgName, contactName: contactName, contactEmail: contactEmail, note: note, expiresAt: expiresAt } })
    return { ok: true, result: { code: formatRegistrationCode(code), codeId: codeId, expiresAt: expiresAt, orgName: orgName, kind: kind, targetOrgId: targetOrgId } }
  })
}

function findCodeRowById(codeId) {
  var rows = readRows('RegistrationCodes')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.code_id) === String(codeId)) return rows[i]
  return null
}

// 見出しの名前で、1行のいくつかの列を書き換える
function setRowFields(name, rowNumber, fields) {
  var sheet = registrySheet(name)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String)
  Object.keys(fields).forEach(function (k) {
    var c = headers.indexOf(k)
    if (c < 0) throw new Error('列「' + k + '」がありません。setupRegistry() を実行してください。')
    sheet.getRange(rowNumber, c + 1, 1, 1).setValues([[safeCell(fields[k])]])
  })
}

function revokeRegistrationCode(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession(body.session, props, nowMs)
  var reason = cleanText(body.reason, 500)
  return withRegistryLock(function () {
    var row = findCodeRowById(body.codeId)
    if (!row) throw registryError('その登録コードは見つかりません。')
    var state = registrationCodeState(row.values, nowMs)
    if (state !== 'unused') throw registryError('未使用のコードだけ取り消せます(このコードは' + ({ used: '使用済み', expired: '期限切れ', revoked: '取り消し済み' })[state] + 'です)。')
    var revokedAt = new Date(nowMs).toISOString()
    setRowFields('RegistrationCodes', row.row, { revoked_at: revokedAt, revoked_by: session.sub })
    appendAudit({ actor: session.sub, action: 'revokeRegistrationCode', target: String(body.codeId), before: { state: 'unused' }, after: { state: 'revoked' }, reason: reason })
    return { ok: true, result: { codeId: String(body.codeId), revokedAt: revokedAt } }
  })
}

// 登録コードを使う(R1-c の団体の登録から、ロックを取った中で呼ぶ)。
// 使えれば使用済みにして、その行の値を返す。使えない理由(無い・使用済み・期限切れ・取り消し済み)は区別せず、同じエラーにする
function consumeRegistrationCode(input, orgId, nowMs) {
  var hash = registrationCodeHash(input)
  var rows = readRows('RegistrationCodes')
  for (var i = 0; i < rows.length; i++) {
    if (!safeEquals(String(rows[i].values.code_hash || ''), hash)) continue
    if (registrationCodeState(rows[i].values, nowMs) !== 'unused') break
    setRowFields('RegistrationCodes', rows[i].row, { used_at: new Date(nowMs).toISOString(), used_org_id: String(orgId) })
    return rows[i].values
  }
  throw registryError(REGISTRATION_CODE_INVALID)
}

// ---- 団体の登録(registerOrg) ----
//
// 団体の GAS が、スプレッドシートの「Ohsumi」メニューの「レジストリに登録」から呼ぶ(1回の通信)。
//   要求: { action: 'registerOrg', code, orgId, gasUrl, gasVersion, registerNonce }
//   返事: { ok: true, result: { orgId, registryKey, keyGen, displayName, registeredAt, kind } }
// - 登録コード(kind: new)は新しい団体だけ、再登録コード(kind: reissue)は発行した時に選んだ団体だけに使える
// - 共有鍵(registryKey)はレジストリが作り、Secrets(保護したシート)に保存する。操作の記録・一覧には出さない
// - **送り直し:** registerNonce は、団体の GAS が登録の前に作り、スクリプトプロパティ(REGISTRY_PENDING)にだけ
//   保存する乱数(32バイト・base64url の43文字)。通信が途中で失われると、団体の GAS は同じ registerNonce・同じコードで
//   送り直す。レジストリは registerNonce の SHA-256 だけを Secrets に保存し、次の**すべて**が合う時だけ、同じ結果
//   (同じ共有鍵)を返す(登録し直さない):
//     団体ID が同じ / registerNonce がその団体の最後の登録と同じ / 登録コードがその団体の登録に使われたもの /
//     その登録から REGISTER_REPLAY_HOURS 時間以内
//   使用済みの登録コードを手に入れただけ(registerNonce を知らない)では、共有鍵は返さない。ほかの失敗と同じ
//   エラー(REGISTRATION_CODE_INVALID)で断り、総当たりの失敗として数える
// - **総当たりの対策:** 登録は1分に10回まで(レジストリ全体)。コードが違う・使えない登録が1時間に
//   REGISTER_FAIL_LIMIT 回を超えたら、その1時間は登録を受け付けない(監視の「断ったリクエスト」にも数える)。
//   コードは16文字(約79ビット)で、使えない理由(無い・使用済み・期限切れ・取り消し済み)は区別せず同じエラーを返す
var REGISTER_REPLAY_HOURS = 24
var REGISTER_FAIL_LIMIT = 30
var ORG_ID_PATTERN = /^org_[A-Za-z0-9_-]{16,64}$/
var GAS_EXEC_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/
var REGISTER_NONCE_PATTERN = /^[A-Za-z0-9_-]{43,64}$/

function findOrgRow(orgId) {
  if (!orgId) return null
  var rows = readRows('Orgs')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.org_id) === String(orgId)) return rows[i]
  return null
}

function findSecretRow(orgId) {
  var rows = readRows('Secrets')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.org_id) === String(orgId)) return rows[i]
  return null
}

function registerFailKey(nowMs) { return 'regfail:' + hourBucket(nowMs) }

function registerFailuresExceeded(nowMs) {
  return Number(CacheService.getScriptCache().get(registerFailKey(nowMs)) || 0) >= REGISTER_FAIL_LIMIT
}

function countRegisterFailure(nowMs) {
  var cache = CacheService.getScriptCache()
  var key = registerFailKey(nowMs)
  cache.put(key, String(Number(cache.get(key) || 0) + 1), 7200)
}

// 断った登録を、監視の「断ったリクエスト」にも数える
function countRejected(nowMs) {
  var cache = CacheService.getScriptCache()
  var rk = 'rj:' + hourBucket(nowMs)
  cache.put(rk, String(Number(cache.get(rk) || 0) + 1), 7200)
}

function newRegistryKey() {
  return generateSecret() + generateSecret()
}

function registerOrg(body, nowMs) {
  if (registerFailuresExceeded(nowMs)) {
    countRejected(nowMs)
    throw registryError('登録の失敗が続いたため、しばらく登録を受け付けていません。1時間ほど待ってから、登録コードを確かめてもう一度お試しください。')
  }
  var orgId = String(body.orgId || '')
  var gasUrl = String(body.gasUrl || '')
  var registerNonce = String(body.registerNonce || '')
  var gasVersion = cleanText(body.gasVersion, 40)
  if (!ORG_ID_PATTERN.test(orgId)) throw registryError('団体ID の形が正しくありません。団体の GAS で setupOhsumi を実行してから、もう一度お試しください。')
  if (!GAS_EXEC_URL_PATTERN.test(gasUrl)) throw registryError('団体の GAS のウェブアプリの URL の形が正しくありません(…/macros/s/…/exec)。')
  if (!REGISTER_NONCE_PATTERN.test(registerNonce)) throw registryError('リクエストの形が正しくありません。団体の GAS を最新の版にしてから、もう一度お試しください。')
  if (!normalizeRegistrationCode(body.code)) throw registryError(REGISTRATION_CODE_INVALID)
  var codeHash = registrationCodeHash(body.code)
  var nonceHash = 'sha256:' + sha256Hex(registerNonce)
  return withRegistryLock(function () {
    // 送り直し: この団体の最後の登録と registerNonce・コードが同じで、24時間以内なら、同じ結果を返す。
    // 合わない時は下の通常の登録に進み、使用済みのコードとして(ほかの失敗と同じエラーで)断る
    var secret = findSecretRow(orgId)
    if (secret && safeEquals(String(secret.values.register_nonce_hash || ''), nonceHash)) {
      var usedRow = null
      readRows('RegistrationCodes').forEach(function (r) {
        if (safeEquals(String(r.values.code_hash || ''), codeHash) && String(r.values.used_org_id || '') === orgId) usedRow = r
      })
      var registeredAtMs = timeOf(secret.values.updated_at)
      if (usedRow && registeredAtMs > 0 && nowMs - registeredAtMs <= REGISTER_REPLAY_HOURS * 3600 * 1000) {
        var org = findOrgRow(orgId)
        return { ok: true, replayed: true, result: registerResult(orgId, secret.values, org ? org.values : {}, String(usedRow.values.kind || 'new')) }
      }
    }

    // 登録コードを探す(使えない理由は区別しない)
    var codeRow = null
    var rows = readRows('RegistrationCodes')
    for (var i = 0; i < rows.length; i++) {
      if (safeEquals(String(rows[i].values.code_hash || ''), codeHash)) { codeRow = rows[i]; break }
    }
    var kind = codeRow ? (String(codeRow.values.kind || 'new') === 'reissue' ? 'reissue' : 'new') : ''
    var existing = findOrgRow(orgId)
    var usable = codeRow && registrationCodeState(codeRow.values, nowMs) === 'unused' &&
      (kind === 'new' ? !existing : !!existing && String(codeRow.values.target_org_id || '') === orgId)
    if (!usable) {
      countRegisterFailure(nowMs)
      // 新しい団体の登録コードで、登録済みの団体を登録し直そうとした時だけは、分かるように知らせる(コードは使わない)
      if (codeRow && kind === 'new' && existing && registrationCodeState(codeRow.values, nowMs) === 'unused') {
        throw registryError('この団体は登録済みです。共有鍵の作り直し・接続先の変更には、FSIF が発行する再登録コードを使ってください。')
      }
      throw registryError(REGISTRATION_CODE_INVALID)
    }

    var at = new Date(nowMs).toISOString()
    setRowFields('RegistrationCodes', codeRow.row, { used_at: at, used_org_id: orgId })
    var key = newRegistryKey()
    var orgValues
    if (kind === 'new') {
      orgValues = {
        org_id: orgId, gas_url: gasUrl, status: 'active', channel: 'standard',
        display_name: String(codeRow.values.org_name || ''), created_at: at, gas_version: gasVersion, updated_at: at,
      }
      appendRowByHeaders('Orgs', orgValues)
      if (String(codeRow.values.contact_name || '') || String(codeRow.values.contact_email || '')) {
        appendRowByHeaders('Contacts', { org_id: orgId, name: String(codeRow.values.contact_name || ''), email: String(codeRow.values.contact_email || '') })
      }
    } else {
      setRowFields('Orgs', existing.row, { gas_url: gasUrl, gas_version: gasVersion, updated_at: at })
      orgValues = {}
      Object.keys(existing.values).forEach(function (k) { orgValues[k] = existing.values[k] })
      orgValues.gas_url = gasUrl
      orgValues.gas_version = gasVersion
    }
    var keyGen = secret ? Number(secret.values.key_gen || 0) + 1 : 1
    var secretValues = { org_id: orgId, registry_key: key, key_gen: keyGen, updated_at: at, register_nonce_hash: nonceHash }
    if (secret) setRowFields('Secrets', secret.row, secretValues)
    else appendRowByHeaders('Secrets', secretValues)
    rememberOrgFingerprint(orgId, orgValues)
    // 記録には共有鍵もコードも残さない
    appendAudit({
      actor: 'org:' + orgId,
      action: kind === 'new' ? 'registerOrg' : 'reregisterOrg',
      target: orgId,
      before: kind === 'reissue' ? { gasUrl: String(existing.values.gas_url || ''), keyGen: keyGen - 1 } : undefined,
      after: { codeId: String(codeRow.values.code_id || ''), displayName: String(orgValues.display_name || ''), gasUrl: gasUrl, gasVersion: gasVersion, keyGen: keyGen },
    })
    return { ok: true, result: registerResult(orgId, secretValues, orgValues, kind) }
  })
}

function registerResult(orgId, secretValues, orgValues, kind) {
  return {
    orgId: orgId,
    registryKey: String(secretValues.registry_key || ''),
    keyGen: Number(secretValues.key_gen || 0),
    displayName: String(orgValues.display_name || ''),
    registeredAt: isoOf(secretValues.updated_at),
    kind: kind,
  }
}

// ---- 管理画面のセッションの鍵 ----

// 管理画面用のセッションの鍵が無ければ作る(setupRegistry から呼ぶ)。本体(団体の GAS)の鍵とは別
function ensureAdminSessionKey(props) {
  if (!props.getProperty('ADMIN_SESSION_KEY')) {
    props.setProperty('ADMIN_SESSION_KEY', generateSecret())
    props.setProperty('ADMIN_SESSION_KID', generateSecret().slice(0, 8))
    console.log('管理画面のセッションの鍵を作りました')
  }
}

// エディタから実行する: 管理画面のセッションの鍵を作り直す(ログイン中の管理者は全員ログアウトになる)
function rotateAdminSessionKey() {
  var props = PropertiesService.getScriptProperties()
  props.setProperty('ADMIN_SESSION_KEY', generateSecret())
  props.setProperty('ADMIN_SESSION_KID', generateSecret().slice(0, 8))
  appendAudit({ actor: 'editor', action: 'rotateAdminSessionKey' })
  console.log('管理画面のセッションの鍵を作り直しました。ログイン中の管理者は、次の操作でログインし直しになります')
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
  ensureAdminSessionKey(props)
  if (!adminEmails(props.getProperties() || {}).length) {
    console.log('管理者の許可リスト(スクリプトプロパティ ADMIN_EMAILS)が未設定です。管理者の Google アカウントのメールアドレスをカンマ区切りで入れてください')
  }
  if (!props.getProperty('OAUTH_CLIENT_ID')) {
    console.log('管理画面のログインに使う OAuth クライアントID(スクリプトプロパティ OAUTH_CLIENT_ID)が未設定です。README の手順で設定してください')
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRegistryBackup') ScriptApp.deleteTrigger(t)
  })
  ScriptApp.newTrigger('dailyRegistryBackup').timeBased().everyDays(1).atHour(3).create()
  console.log('毎日のバックアップ(午前3時台)のトリガーを作りました')
  console.log('次に、ウェブアプリとしてデプロイしてください(次のユーザーとして実行: 自分、アクセスできるユーザー: 全員)')
}
