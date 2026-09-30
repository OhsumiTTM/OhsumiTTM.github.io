// ■ エディタから実行する関数(関数の一覧から選んで ▶ 実行)
//   setupRegistry           最初の設定・コードを貼り替えた後に実行する(シート・保護・鍵・毎日のバックアップのトリガーを
//                           用意する。今のコードに無い関数を指すトリガーを消す)
//   rotateAdminSessionKey   管理画面のセッションの鍵を作り直す(ログイン中の管理者は全員ログアウトになる)
//   testSuspendNow          (テスト環境だけ)TEST_ORG_ID の団体を、今すぐ停止する(種類は TEST_SUSPEND_KIND)
//   testScheduleSuspension  (テスト環境だけ)TEST_SUSPEND_DAYS 日後に停止の予定を入れ、その時期の予告をすぐ送る
//   testLiftSuspension      (テスト環境だけ)TEST_ORG_ID の団体の停止の予定・停止を解除する
//                           test から始まる関数は、REGISTRY_TEST_MODE が true の時、REGISTRY_TEST_ORG_IDS の団体にだけ効く
// ■ ほかから呼ばれる関数(名前を変えない)
//   doGet・doPost           ウェブアプリの入口
//   dailyRegistryBackup     毎日のバックアップ(トリガーから呼ばれる)
// ■ そのほかの関数は、中で使うだけ。名前の最後に _ を付けて、エディタの「実行」の一覧に出ないようにしている
//   (_ を付けずに足すと lib/ohsumi/gas-functions.test.ts で止まる)
//
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
// R1-c で足したもの:
//   - 団体の登録(registerOrg。団体の GAS が登録コードを使って団体を登録し、共有鍵を受け取る)。
//     通信が途中で失われて送り直された時は、同じ結果(同じ共有鍵)を返す(二重に登録しない)
//   - 再登録コード(kind: reissue。共有鍵が漏れた時の作り直し・接続先の変更。管理画面で発行する)
//   - 登録の失敗(登録コードの総当たり)の回数の上限
// R1-d で足したもの:
//   - 接続先の解決(resolveOrg。認証なし)。団体ID が完全に一致した時だけ、その団体の GAS の URL と状態を返す。
//     答えは団体ごとに10分覚え(CacheService)、登録・再登録の時に消す
// 提供停止は、R1-e 以降で足す(データの形は用意してある)。
//
// 設定と手順は registry/README.md を参照。

// シートの用意・保護・健康確認の鍵・バックアップのトリガーを作る。何度実行しても同じ結果になる
function setupRegistry() {
  // 今のコードに無い関数を指すトリガー(以前の版の名前のまま残ったもの)を消す
  removeOrphanTriggers_()
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
    props.setProperty('HEALTH_KEY', generateSecret_())
    console.log('死活の確認の鍵(HEALTH_KEY)を作りました。監視の GAS のスクリプトプロパティ HEALTH_KEY に、この値を入れてください: ' + props.getProperty('HEALTH_KEY'))
  } else {
    console.log('死活の確認の鍵(HEALTH_KEY)は作成済みです(スクリプトプロパティで確認できます)')
  }
  backupFolder_()
  ensureAdminSessionKey_(props)
  if (!adminEmails_(props.getProperties() || {}).length) {
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

// ============================================================================
// エディタから実行する関数
// ============================================================================

// エディタから実行する: 管理画面のセッションの鍵を作り直す(ログイン中の管理者は全員ログアウトになる)
function rotateAdminSessionKey() {
  var props = PropertiesService.getScriptProperties()
  props.setProperty('ADMIN_SESSION_KEY', generateSecret_())
  props.setProperty('ADMIN_SESSION_KID', generateSecret_().slice(0, 8))
  appendAudit_({ actor: 'editor', action: 'rotateAdminSessionKey' })
  console.log('管理画面のセッションの鍵を作り直しました。ログイン中の管理者は、次の操作でログインし直しになります')
}

// (テスト環境だけ)停止の動きを、14日待たずに確かめる。スクリプトプロパティ REGISTRY_TEST_MODE が true の時だけ動く
// (管理画面からはできない)。レジストリは本番の団体と共通なので、対象にできるのはスクリプトプロパティ
// REGISTRY_TEST_ORG_IDS(テスト環境の団体ID をカンマ区切り)に書いた団体だけ。それ以外の団体は、何も変えずに止まる。
// 対象はスクリプトプロパティ TEST_ORG_ID の団体、種類は TEST_SUSPEND_KIND(suspend・restrict。無ければ restrict)。
// 手順は registry/README.md の「1.9.1」

// 今すぐ停止する(予定の日時を今にする。予告は送らない)
function testSuspendNow() {
  testSetSuspension_('now', Date.now())
}

// TEST_SUSPEND_DAYS 日後(例: 13.9・6.9・0.9)に停止の予定を入れ、その時期の予告(14日前・7日前・1日前)を担当者にすぐ送る。
// 14日より前の日時も入れられる(管理画面は14日より後だけ)
function testScheduleSuspension() {
  testSetSuspension_('schedule', Date.now())
}

// 停止の予定・停止を解除する
function testLiftSuspension() {
  testSetSuspension_('lift', Date.now())
}

// ============================================================================
// ウェブアプリの入口・トリガーから呼ばれる関数
// ============================================================================

// レジストリには POST しか送らない。GET で届いた時は、POST が転送の途中で GET に変わり、本文が失われた
// 可能性が高い(URL が /exec ではない・/u/1/ を含むなど)。送った側が原因を記録して送り直せるよう、
// JSON で返す(何も処理していない)
function doGet() {
  return registryJson_({
    ok: false,
    getReceived: true,
    error: 'レジストリに GET で届きました(POST の本文が転送の途中で失われた可能性があります)。何も処理していません。',
  })
}

function doPost(e) {
  try {
    var text = e && e.postData ? String(e.postData.contents || '') : ''
    if (text.length > MAX_BODY_CHARS) return registryJson_({ ok: false, error: 'リクエストが大きすぎます。' })
    if (rateLimitExceeded_('all', RATE_LIMITS.all)) return registryJson_({ ok: false, error: '混み合っています。少し待ってください。', retryLater: true })
    var body
    try { body = JSON.parse(text) } catch (parseErr) { return registryJson_({ ok: false, error: 'リクエストの形が正しくありません。' }) }
    if (!body || typeof body !== 'object') return registryJson_({ ok: false, error: 'リクエストの形が正しくありません。' })
    var handler = REGISTRY_ACTIONS[String(body.action)]
    if (!handler) return registryJson_({ ok: false, error: '知らない操作です。' })
    var limit = RATE_LIMITS[String(body.action)]
    if (limit && rateLimitExceeded_(String(body.action), limit)) return registryJson_({ ok: false, error: '混み合っています。少し待ってください。', retryLater: true })
    return registryJson_(handler(body))
  } catch (err) {
    // 利用者に見せてよいエラー(registryError_ で作ったもの)は、そのメッセージを返す。
    // それ以外は中身を返さない(実行ログにだけ残す)
    if (err && err.registryUser) {
      var out = { ok: false, error: err.message }
      if (err.authError) out.authError = true
      if (err.reauth) out.reauthRequired = true
      return registryJson_(out)
    }
    Logger.log('doPost failed: ' + (err && err.stack ? err.stack : err))
    return registryJson_({ ok: false, error: '処理中に問題が発生しました。' })
  }
}

// 時間主導のトリガー(毎日)から呼ぶ。記録の無い直接の編集を数え、停止の予告を送ってから、スプレッドシートをコピーする。
// コピーは Secrets を含むので、編集者・閲覧者を外し、リンクの共有も「制限付き」にする。
// 30日より古いコピーはゴミ箱へ移す
function dailyRegistryBackup() {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    var props = PropertiesService.getScriptProperties()
    var unrecorded = findUnrecordedOrgEdits_()
    props.setProperty('LAST_UNRECORDED_EDITS', String(unrecorded.length))
    if (unrecorded.length) console.warn('記録の無い変更がある団体: ' + unrecorded.join(', '))

    // 停止の予告(14日前・7日前・1日前)を、団体の担当者にメールで送る(失敗してもバックアップは続ける)
    try { sendSuspensionNotices_(Date.now()) } catch (noticeErr) { console.error('停止の予告を送れませんでした: ' + noticeErr) }

    var folder = backupFolder_()
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    var copy = DriveApp.getFileById(ss.getId()).makeCopy('Ohsumi レジストリ バックアップ ' + stamp, folder)
    makePrivate_(copy)
    var removed = trashOldBackups_(folder, Date.now())
    props.setProperty('LAST_BACKUP_AT', new Date().toISOString())
    console.log('バックアップを作りました: ' + copy.getName() + '(古いコピーを ' + removed + ' 件ゴミ箱へ移しました)')
    return { name: copy.getName(), removed: removed, unrecorded: unrecorded }
  } finally {
    lock.releaseLock()
  }
}

// ============================================================================
// 中で使うだけの関数(名前の最後に _)
// ============================================================================

// 今のコードに無い関数を指すトリガーを消す。以前の版で作ったトリガーが、消した・名前を変えた関数を
// 指したまま残っていると、トリガーが動くたびにエラーになる(setupRegistry の最初に呼ぶ)。消した関数名を返す
function removeOrphanTriggers_() {
  var removed = []
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var name = t.getHandlerFunction()
    if (typeof globalThis[name] !== 'function') {
      ScriptApp.deleteTrigger(t)
      removed.push(name)
    }
  })
  if (removed.length) console.log('🧹 今のコードに無い関数を指すトリガーを消しました: ' + removed.join(', '))
  return removed
}

var REGISTRY_VERSION = 'r1e-2'

// シートと列(1行目の見出し)。列は見出しの名前で探す
//   Orgs の列(R1-c〜R1-e で使う列も、今のうちに用意する):
//     org_id・gas_url(接続先)・status(active / suspended)・channel・display_name・created_at(登録日)
//     suspend_at(停止の予定日時)・suspend_reason・last_check_at(団体の GAS が最後に確認に来た時刻)・gas_version
//     contract_status(active 契約中 / ending 終了予定 / ended 終了)・contract_until(契約の終了日)・contract_note
//     suspend_scheduled_by(停止の予定を入れた管理者)・suspend_notices_json(停止の予告を送った記録)・updated_at
//     suspend_kind(停止の種類)・plan(プラン: cosmo_base / ohsumi / paid。空は未設定)
var REGISTRY_SHEETS = {
  Orgs: ['org_id', 'gas_url', 'status', 'channel', 'display_name', 'created_at', 'suspend_at', 'suspend_reason', 'last_check_at', 'gas_version',
    'contract_status', 'contract_until', 'contract_note', 'suspend_scheduled_by', 'suspend_notices_json', 'updated_at', 'suspend_kind', 'plan'],
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
var RATE_LIMITS = { all: 600, health: 60, adminLogin: 30, registerOrg: 10, resolveOrg: 120, checkIn: 300 }

// ---- 入口 ----

// 利用者に見せてよいエラー。authError はセッションが無効(管理画面はログイン画面に戻る)
function registryError_(message, flags) {
  var e = new Error(message)
  e.registryUser = true
  if (flags && flags.authError) e.authError = true
  if (flags && flags.reauth) e.reauth = true
  return e
}

// 操作の一覧。R1-c 以降で足す
var REGISTRY_ACTIONS = {
  health: function (body) { return healthResponse_(body.key) },
  adminLogin: function (body) { return adminLogin_(body, Date.now()) },
  adminOverview: function (body) { return adminOverview_(body, Date.now()) },
  issueRegistrationCode: function (body) { return issueRegistrationCode_(body, Date.now()) },
  revokeRegistrationCode: function (body) { return revokeRegistrationCode_(body, Date.now()) },
  registerOrg: function (body) { return registerOrg_(body, Date.now()) },
  resolveOrg: function (body) { return resolveOrg_(body, Date.now()) },
  checkIn: function (body) { return checkIn_(body, Date.now()) },
  scheduleSuspension: function (body) { return scheduleSuspension_(body, Date.now()) },
  clearSuspension: function (body) { return clearSuspension_(body, Date.now()) },
  setOrgPlan: function (body) { return setOrgPlan_(body, Date.now()) },
}

function registryJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

// ---- 死活の確認 ----

// 鍵(HEALTH_KEY)が無ければ、動いていることだけを返す。監視の GAS は鍵を付けて詳細を受け取る。
// 鍵を付けて来たのに合わない時は keyValid: false を付ける(監視が「鍵が違う」と分かるように。
// 鍵を付けない問い合わせには付けない)。団体の情報は返さない
function healthResponse_(key) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var res = { ok: true, version: REGISTRY_VERSION, time: new Date().toISOString() }
  var given = String(key || '')
  if (!given) return res
  if (!props.HEALTH_KEY || !safeEquals_(given, props.HEALTH_KEY)) {
    res.keyValid = false
    return res
  }
  res.keyValid = true
  res.lastBackupAt = props.LAST_BACKUP_AT || null
  res.unrecordedEdits = Number(props.LAST_UNRECORDED_EDITS || 0)
  res.rejectedLastHour = rejectedCount_(Date.now())
  return res
}

// ---- 回数の上限 ----

function minuteBucket_(now) { return Math.floor(now / 60000) }
function hourBucket_(now) { return Math.floor(now / 3600000) }

// 1分あたりの回数を数え、上限を超えたら true。断った回数は1時間ごとに数える(監視が見る)
function rateLimitExceeded_(bucket, limit, now) {
  now = now || Date.now()
  var cache = CacheService.getScriptCache()
  var key = 'rl:' + bucket + ':' + minuteBucket_(now)
  var count = Number(cache.get(key) || 0) + 1
  cache.put(key, String(count), 120)
  if (count <= limit) return false
  var rk = 'rj:' + hourBucket_(now)
  cache.put(rk, String(Number(cache.get(rk) || 0) + 1), 7200)
  return true
}

function rejectedCount_(now) {
  return Number(CacheService.getScriptCache().get('rj:' + hourBucket_(now)) || 0)
}

// ---- 値の扱い ----

// 長さが同じなら、どこで違っても同じ時間で比べる
function safeEquals_(a, b) {
  a = String(a)
  b = String(b)
  var diff = a.length ^ b.length
  for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

// スプレッドシートに書く文字列が、数式として扱われないようにする
function safeCell_(value) {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') return value
  return /^[=+\-@]/.test(value) ? "'" + value : value
}

function generateSecret_() {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now())).replace(/=+$/, '')
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2) }).join('')
}

// ---- シート ----

function registrySheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) throw new Error('シート「' + name + '」がありません。setupRegistry() を実行してください。')
  return sheet
}

// 見出しをキーにした行の一覧({ row: シートの行番号, values: { 見出し: 値 } })
function readRows_(name) {
  var sheet = registrySheet_(name)
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
function appendRowByHeaders_(name, values) {
  var sheet = registrySheet_(name)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String)
  sheet.appendRow(headers.map(function (h) { return safeCell_(values[h] === undefined ? '' : values[h]) }))
}

// ---- 操作の記録 ----

// AuditLog に1行足す(追記だけ。書き換えない)。before / after はオブジェクトなら JSON にする
function appendAudit_(entry) {
  var json = function (v) { return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v) }
  appendRowByHeaders_('AuditLog', {
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

// 停止の種類(suspend_kind。R1-e)とプラン(plan)は、入っている時だけ指紋に入れる(前に覚えた指紋と同じになるように)
function orgFingerprint_(values) {
  var parts = ORG_FINGERPRINT_COLUMNS.map(function (c) { return String(values[c] === undefined ? '' : values[c]) })
  if (String(values.suspend_kind || '')) parts.push(String(values.suspend_kind))
  if (String(values.plan || '')) parts.push('plan:' + String(values.plan))
  return sha256Hex_(JSON.stringify(parts))
}

// 記録を伴う変更の後に呼ぶ(R1-b 以降の操作で使う)
function rememberOrgFingerprint_(orgId, values) {
  PropertiesService.getScriptProperties().setProperty(ORG_FINGERPRINT_PREFIX + orgId, orgFingerprint_(values))
}

// 覚えている指紋と違う行・覚えていない行・消えた行の団体ID
function findUnrecordedOrgEdits_() {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var seen = {}
  var found = []
  readRows_('Orgs').forEach(function (r) {
    var id = String(r.values.org_id || '')
    if (!id) return
    seen[id] = true
    if (props[ORG_FINGERPRINT_PREFIX + id] !== orgFingerprint_(r.values)) found.push(id)
  })
  Object.keys(props).forEach(function (k) {
    if (k.indexOf(ORG_FINGERPRINT_PREFIX) === 0 && !seen[k.slice(ORG_FINGERPRINT_PREFIX.length)]) found.push(k.slice(ORG_FINGERPRINT_PREFIX.length))
  })
  return found
}

// ---- 毎日のバックアップ ----

function makePrivate_(file) {
  file.getEditors().forEach(function (u) { try { file.removeEditor(u) } catch (e) { /* 自分自身など */ } })
  file.getViewers().forEach(function (u) { try { file.removeViewer(u) } catch (e) { /* 自分自身など */ } })
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE) } catch (e) { /* 変えられない場合 */ }
}

function backupFolder_() {
  var props = PropertiesService.getScriptProperties()
  var id = props.getProperty('BACKUP_FOLDER_ID')
  if (id) {
    try { return DriveApp.getFolderById(id) } catch (e) { /* 消された: 作り直す */ }
  }
  var folder = DriveApp.createFolder(BACKUP_FOLDER_NAME)
  makePrivate_(folder)
  props.setProperty('BACKUP_FOLDER_ID', folder.getId())
  return folder
}

function trashOldBackups_(folder, now) {
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

function nowSecOf_(nowMs) { return Math.floor(nowMs / 1000) }

function b64url_(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '')
}

function b64urlDecodeToString_(text) {
  var s = String(text)
  while (s.length % 4) s += '='
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8')
}

function sha256B64url_(text) {
  return b64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8))
}

// 許可リスト(小文字にそろえる)
function adminEmails_(props) {
  return String(props.ADMIN_EMAILS || '').split(',').map(function (s) { return s.trim().toLowerCase() }).filter(Boolean)
}

function isAdminEmail_(props, email) {
  return adminEmails_(props).indexOf(String(email || '').trim().toLowerCase()) >= 0
}

// Google の ID トークンを確かめ、{ email, iat } を返す
function verifyAdminIdToken_(idToken, nonceSecret, props, nowMs) {
  if (!props.OAUTH_CLIENT_ID) throw registryError_('レジストリの設定(OAUTH_CLIENT_ID)が未設定です。README の手順で設定してください。')
  if (!/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(String(idToken || '')) || String(idToken).length > 4096) {
    throw registryError_('ログインの情報の形式が正しくありません。もう一度ログインしてください。')
  }
  if (!nonceSecret || String(nonceSecret).length < 16 || String(nonceSecret).length > 256) {
    throw registryError_('ログインの情報の形式が正しくありません。もう一度ログインしてください。')
  }
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true })
  if (resp.getResponseCode() !== 200) throw registryError_('Google のログイン情報を確認できませんでした。もう一度ログインしてください。')
  var info = JSON.parse(resp.getContentText())
  if (info.aud !== props.OAUTH_CLIENT_ID) throw registryError_('ログイン情報の発行元が、この管理画面と一致しません。')
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') throw registryError_('ログイン情報の発行元が正しくありません。')
  if (!(Number(info.exp) > nowSecOf_(nowMs))) throw registryError_('Google のログイン情報の有効期限が切れています。もう一度ログインしてください。')
  if (!info.email || (info.email_verified !== true && info.email_verified !== 'true')) {
    throw registryError_('メールアドレスが確認されていない Google アカウントは使えません。')
  }
  var expected = ADMIN_NONCE_PREFIX + sha256B64url_(nonceSecret)
  if (!info.nonce || !safeEquals_(info.nonce, expected)) throw registryError_('ログイン情報がこの画面のものではありません。もう一度ログインしてください。')
  var cache = CacheService.getScriptCache()
  var nonceKey = 'adminNonce:' + sha256B64url_(info.nonce)
  if (cache.get(nonceKey)) throw registryError_('このログイン情報は既に使われています。もう一度ログインしてください。')
  cache.put(nonceKey, '1', 3600)
  return { email: String(info.email).toLowerCase(), iat: Number(info.iat) || nowSecOf_(nowMs) }
}

function signAdminPayload_(payloadB64, key) {
  return b64url_(Utilities.computeHmacSha256Signature(ADMIN_TOKEN_VERSION + '.' + payloadB64, key))
}

function issueAdminSession_(email, authSec, props, nowMs) {
  if (!props.ADMIN_SESSION_KEY || !props.ADMIN_SESSION_KID) throw registryError_('レジストリの設定が完了していません。setupRegistry() を実行してください。')
  var now = nowSecOf_(nowMs)
  var payload = { sub: email, kid: props.ADMIN_SESSION_KID, iat: now, exp: now + ADMIN_SESSION_TTL_SEC, auth: authSec, sid: generateSecret_().slice(0, 12) }
  var payloadB64 = b64url_(JSON.stringify(payload))
  return { token: ADMIN_TOKEN_VERSION + '.' + payloadB64 + '.' + signAdminPayload_(payloadB64, props.ADMIN_SESSION_KEY), exp: payload.exp, email: email, authAt: authSec }
}

// セッショントークンを確かめ、payload を返す。無効なら authError の例外
function verifyAdminSession_(token, props, nowMs) {
  var parts = String(token || '').split('.')
  var invalid = function (msg) { return registryError_(msg || 'ログインの有効期限が切れました。もう一度ログインしてください。', { authError: true }) }
  if (parts.length !== 3 || parts[0] !== ADMIN_TOKEN_VERSION || !props.ADMIN_SESSION_KEY) throw invalid()
  if (!safeEquals_(signAdminPayload_(parts[1], props.ADMIN_SESSION_KEY), parts[2])) throw invalid()
  var payload
  try { payload = JSON.parse(b64urlDecodeToString_(parts[1])) } catch (e) { throw invalid() }
  if (!payload || payload.kid !== props.ADMIN_SESSION_KID) throw invalid()
  if (!(Number(payload.exp) > nowSecOf_(nowMs))) throw invalid()
  if (!isAdminEmail_(props, payload.sub)) throw invalid('このアカウントは管理者として登録されていません。')
  return payload
}

function adminLogin_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var google = verifyAdminIdToken_(body.idToken, body.nonceSecret, props, nowMs)
  if (!isAdminEmail_(props, google.email)) {
    appendAudit_({ actor: google.email, action: 'adminLoginDenied', reason: '許可リスト(ADMIN_EMAILS)に無いアカウント' })
    throw registryError_('このアカウントは管理者として登録されていません。', { authError: true })
  }
  var session = issueAdminSession_(google.email, nowSecOf_(nowMs), props, nowMs)
  appendAudit_({ actor: google.email, action: 'adminLogin' })
  return { ok: true, result: { session: session } }
}

// ---- 管理画面の一覧 ----

function isoOf_(v) {
  if (v instanceof Date) return v.toISOString()
  return v === null || v === undefined ? '' : String(v)
}

function timeOf_(v) {
  if (v instanceof Date) return v.getTime()
  var t = Date.parse(String(v || ''))
  return isNaN(t) ? NaN : t
}

var STALE_CHECK_DAYS = 7

// 団体の表示用の状態(Google のサービスを使わない純粋な関数)。
//   state: suspended(提供停止中。status が suspended か、提供停止の予定日時を過ぎた)/ restricted(機能停止中。読み取り専用)/
//          scheduled(停止の予定あり。種類は contractState_ の kind)/ active(有効)
//   checkState: never(まだ一度も確認に来ていない)/ stale(最後の確認から7日を超えた)/ ok
function orgDisplayState_(values, nowMs) {
  var c = contractState_(values, nowMs)
  var state = c.phase === 'inEffect' ? (c.kind === 'restrict' ? 'restricted' : 'suspended') : c.phase === 'scheduled' ? 'scheduled' : 'active'
  var lastCheck = timeOf_(values.last_check_at)
  var checkState = !(lastCheck > 0) ? 'never' : nowMs - lastCheck > STALE_CHECK_DAYS * 24 * 3600 * 1000 ? 'stale' : 'ok'
  return { state: state, checkState: checkState }
}

function orgSummary_(values, nowMs) {
  var ds = orgDisplayState_(values, nowMs)
  return {
    orgId: String(values.org_id || ''),
    displayName: String(values.display_name || ''),
    status: String(values.status || ''),
    state: ds.state,
    checkState: ds.checkState,
    contractStatus: String(values.contract_status || ''),
    contractUntil: isoOf_(values.contract_until),
    contractNote: String(values.contract_note || ''),
    lastCheckAt: isoOf_(values.last_check_at),
    createdAt: isoOf_(values.created_at),
    suspendAt: isoOf_(values.suspend_at),
    suspendReason: String(values.suspend_reason || ''),
    suspendKind: contractState_(values, nowMs).kind,
    plan: PLANS.indexOf(String(values.plan || '')) >= 0 ? String(values.plan) : '',
    suspendScheduledBy: String(values.suspend_scheduled_by || ''),
    noticesSent: suspensionNoticesSent_(values).map(function (n) { return n.days }),
    channel: String(values.channel || ''),
    gasUrl: String(values.gas_url || ''),
    gasVersion: String(values.gas_version || ''),
  }
}

// 登録コードの状態(純粋な関数): revoked / used / expired / unused
function registrationCodeState_(values, nowMs) {
  if (String(values.revoked_at || '')) return 'revoked'
  if (String(values.used_at || '')) return 'used'
  var exp = timeOf_(values.expires_at)
  if (!(exp > nowMs)) return 'expired'
  return 'unused'
}

function codeSummary_(values, nowMs) {
  return {
    codeId: String(values.code_id || ''),
    kind: String(values.kind || 'new'),
    targetOrgId: String(values.target_org_id || ''),
    orgName: String(values.org_name || ''),
    contactName: String(values.contact_name || ''),
    contactEmail: String(values.contact_email || ''),
    note: String(values.note || ''),
    state: registrationCodeState_(values, nowMs),
    expiresAt: isoOf_(values.expires_at),
    issuedBy: String(values.issued_by || ''),
    issuedAt: isoOf_(values.issued_at),
    usedAt: isoOf_(values.used_at),
    usedOrgId: String(values.used_org_id || ''),
    revokedAt: isoOf_(values.revoked_at),
    revokedBy: String(values.revoked_by || ''),
  }
}

var AUDIT_SHOW_MAX = 200

// 管理画面の一覧を1回で返す(団体・登録コード・最近の操作の記録)。通信の回数を減らすため
function adminOverview_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession_(body.session, props, nowMs)
  var orgs = readRows_('Orgs').filter(function (r) { return String(r.values.org_id || '') }).map(function (r) { return orgSummary_(r.values, nowMs) })
  var codes = readRows_('RegistrationCodes').filter(function (r) { return String(r.values.code_hash || '') }).map(function (r) { return codeSummary_(r.values, nowMs) })
  codes.sort(function (a, b) { return String(b.issuedAt).localeCompare(String(a.issuedAt)) })
  var audit = readRows_('AuditLog').slice(-AUDIT_SHOW_MAX).reverse().map(function (r) {
    return { at: isoOf_(r.values.at), actor: String(r.values.actor || ''), action: String(r.values.action || ''), target: String(r.values.target || ''),
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
function randomBytes_(count) {
  var out = []
  while (out.length < count) {
    var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now()), String(out.length)].join(':')
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8).forEach(function (b) { out.push(b & 0xff) })
  }
  return out.slice(0, count)
}

function generateRegistrationCode_() {
  var n = REGISTRATION_CODE_ALPHABET.length
  var limit = Math.floor(256 / n) * n // 偏りが出ないよう、これ以上のバイトは捨てる
  var code = ''
  while (code.length < REGISTRATION_CODE_LENGTH) {
    randomBytes_(32).forEach(function (b) {
      if (code.length < REGISTRATION_CODE_LENGTH && b < limit) code += REGISTRATION_CODE_ALPHABET.charAt(b % n)
    })
  }
  return code
}

// 入力のゆれ(小文字・区切り・空白)をそろえる
function normalizeRegistrationCode_(input) {
  return String(input || '').toUpperCase().replace(/[\s\-_]/g, '')
}

function formatRegistrationCode_(code) {
  return code.match(/.{1,4}/g).join('-')
}

// 保存する形は 'sha256:' + 16進数(数字だけの値がスプレッドシートで数として扱われないように、前に文字を付ける)
function registrationCodeHash_(input) {
  return 'sha256:' + sha256Hex_(normalizeRegistrationCode_(input))
}

function cleanText_(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
}

function withRegistryLock_(fn) {
  var lock = LockService.getScriptLock()
  lock.waitLock(10000)
  try {
    return fn()
  } finally {
    lock.releaseLock()
  }
}

function issueRegistrationCode_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession_(body.session, props, nowMs)
  if (!(nowSecOf_(nowMs) - Number(session.auth) <= ADMIN_REAUTH_SEC)) {
    throw registryError_('登録コードを発行する前に、もう一度 Google でログインしてください(5分以内のログインが必要です)。', { reauth: true })
  }
  var kind = String(body.kind || 'new') === 'reissue' ? 'reissue' : 'new'
  var targetOrgId = kind === 'reissue' ? cleanText_(body.targetOrgId, 80) : ''
  var orgName = cleanText_(body.orgName, 100)
  if (kind === 'reissue') {
    // 再登録コード: 登録済みの団体向け(共有鍵の作り直し・接続先の変更)。団体名は Orgs から
    var target = findOrgRow_(targetOrgId)
    if (!target) throw registryError_('再登録する団体が見つかりません。')
    orgName = cleanText_(target.values.display_name, 100) || targetOrgId
  }
  if (!orgName) throw registryError_('どの団体向けかが分かるよう、団体名(契約先の名前)を入れてください。')
  var contactName = cleanText_(body.contactName, 100)
  var contactEmail = cleanText_(body.contactEmail, 200)
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) throw registryError_('担当者のメールアドレスの形が正しくありません。')
  var note = cleanText_(body.note, 500)
  return withRegistryLock_(function () {
    var code = generateRegistrationCode_()
    var codeId = 'rc_' + generateSecret_().slice(0, 10)
    var issuedAt = new Date(nowMs).toISOString()
    var expiresAt = new Date(nowMs + REGISTRATION_CODE_TTL_DAYS * 24 * 3600 * 1000).toISOString()
    appendRowByHeaders_('RegistrationCodes', {
      code_id: codeId,
      code_hash: registrationCodeHash_(code),
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
    appendAudit_({ actor: session.sub, action: 'issueRegistrationCode', target: codeId, after: { kind: kind, targetOrgId: targetOrgId, orgName: orgName, contactName: contactName, contactEmail: contactEmail, note: note, expiresAt: expiresAt } })
    return { ok: true, result: { code: formatRegistrationCode_(code), codeId: codeId, expiresAt: expiresAt, orgName: orgName, kind: kind, targetOrgId: targetOrgId } }
  })
}

function findCodeRowById_(codeId) {
  var rows = readRows_('RegistrationCodes')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.code_id) === String(codeId)) return rows[i]
  return null
}

// 見出しの名前で、1行のいくつかの列を書き換える
function setRowFields_(name, rowNumber, fields) {
  var sheet = registrySheet_(name)
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String)
  Object.keys(fields).forEach(function (k) {
    var c = headers.indexOf(k)
    if (c < 0) throw new Error('列「' + k + '」がありません。setupRegistry() を実行してください。')
    sheet.getRange(rowNumber, c + 1, 1, 1).setValues([[safeCell_(fields[k])]])
  })
}

function revokeRegistrationCode_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession_(body.session, props, nowMs)
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var row = findCodeRowById_(body.codeId)
    if (!row) throw registryError_('その登録コードは見つかりません。')
    var state = registrationCodeState_(row.values, nowMs)
    if (state !== 'unused') throw registryError_('未使用のコードだけ取り消せます(このコードは' + ({ used: '使用済み', expired: '期限切れ', revoked: '取り消し済み' })[state] + 'です)。')
    var revokedAt = new Date(nowMs).toISOString()
    setRowFields_('RegistrationCodes', row.row, { revoked_at: revokedAt, revoked_by: session.sub })
    appendAudit_({ actor: session.sub, action: 'revokeRegistrationCode', target: String(body.codeId), before: { state: 'unused' }, after: { state: 'revoked' }, reason: reason })
    return { ok: true, result: { codeId: String(body.codeId), revokedAt: revokedAt } }
  })
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

function findOrgRow_(orgId) {
  if (!orgId) return null
  var rows = readRows_('Orgs')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.org_id) === String(orgId)) return rows[i]
  return null
}

function findSecretRow_(orgId) {
  var rows = readRows_('Secrets')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.org_id) === String(orgId)) return rows[i]
  return null
}

function registerFailKey_(nowMs) { return 'regfail:' + hourBucket_(nowMs) }

function registerFailuresExceeded_(nowMs) {
  return Number(CacheService.getScriptCache().get(registerFailKey_(nowMs)) || 0) >= REGISTER_FAIL_LIMIT
}

function countRegisterFailure_(nowMs) {
  var cache = CacheService.getScriptCache()
  var key = registerFailKey_(nowMs)
  cache.put(key, String(Number(cache.get(key) || 0) + 1), 7200)
}

// 断った登録を、監視の「断ったリクエスト」にも数える
function countRejected_(nowMs) {
  var cache = CacheService.getScriptCache()
  var rk = 'rj:' + hourBucket_(nowMs)
  cache.put(rk, String(Number(cache.get(rk) || 0) + 1), 7200)
}

function newRegistryKey_() {
  return generateSecret_() + generateSecret_()
}

function registerOrg_(body, nowMs) {
  if (registerFailuresExceeded_(nowMs)) {
    countRejected_(nowMs)
    throw registryError_('登録の失敗が続いたため、しばらく登録を受け付けていません。1時間ほど待ってから、登録コードを確かめてもう一度お試しください。')
  }
  var orgId = String(body.orgId || '')
  var gasUrl = String(body.gasUrl || '')
  var registerNonce = String(body.registerNonce || '')
  var gasVersion = cleanText_(body.gasVersion, 40)
  if (!ORG_ID_PATTERN.test(orgId)) throw registryError_('団体ID の形が正しくありません。団体の GAS で setupOhsumi を実行してから、もう一度お試しください。')
  if (!GAS_EXEC_URL_PATTERN.test(gasUrl)) throw registryError_('団体の GAS のウェブアプリの URL の形が正しくありません(…/macros/s/…/exec)。')
  if (!REGISTER_NONCE_PATTERN.test(registerNonce)) throw registryError_('リクエストの形が正しくありません。団体の GAS を最新の版にしてから、もう一度お試しください。')
  if (!normalizeRegistrationCode_(body.code)) throw registryError_(REGISTRATION_CODE_INVALID)
  var codeHash = registrationCodeHash_(body.code)
  var nonceHash = 'sha256:' + sha256Hex_(registerNonce)
  return withRegistryLock_(function () {
    // 送り直し: この団体の最後の登録と registerNonce・コードが同じで、24時間以内なら、同じ結果を返す。
    // 合わない時は下の通常の登録に進み、使用済みのコードとして(ほかの失敗と同じエラーで)断る
    var secret = findSecretRow_(orgId)
    if (secret && safeEquals_(String(secret.values.register_nonce_hash || ''), nonceHash)) {
      var usedRow = null
      readRows_('RegistrationCodes').forEach(function (r) {
        if (safeEquals_(String(r.values.code_hash || ''), codeHash) && String(r.values.used_org_id || '') === orgId) usedRow = r
      })
      var registeredAtMs = timeOf_(secret.values.updated_at)
      if (usedRow && registeredAtMs > 0 && nowMs - registeredAtMs <= REGISTER_REPLAY_HOURS * 3600 * 1000) {
        var org = findOrgRow_(orgId)
        return { ok: true, replayed: true, result: registerResult_(orgId, secret.values, org ? org.values : {}, String(usedRow.values.kind || 'new')) }
      }
    }

    // 登録コードを探す(使えない理由は区別しない)
    var codeRow = null
    var rows = readRows_('RegistrationCodes')
    for (var i = 0; i < rows.length; i++) {
      if (safeEquals_(String(rows[i].values.code_hash || ''), codeHash)) { codeRow = rows[i]; break }
    }
    var kind = codeRow ? (String(codeRow.values.kind || 'new') === 'reissue' ? 'reissue' : 'new') : ''
    var existing = findOrgRow_(orgId)
    var usable = codeRow && registrationCodeState_(codeRow.values, nowMs) === 'unused' &&
      (kind === 'new' ? !existing : !!existing && String(codeRow.values.target_org_id || '') === orgId)
    if (!usable) {
      countRegisterFailure_(nowMs)
      // 新しい団体の登録コードで、登録済みの団体を登録し直そうとした時だけは、分かるように知らせる(コードは使わない)
      if (codeRow && kind === 'new' && existing && registrationCodeState_(codeRow.values, nowMs) === 'unused') {
        throw registryError_('この団体は登録済みです。共有鍵の作り直し・接続先の変更には、FSIF が発行する再登録コードを使ってください。')
      }
      throw registryError_(REGISTRATION_CODE_INVALID)
    }

    var at = new Date(nowMs).toISOString()
    setRowFields_('RegistrationCodes', codeRow.row, { used_at: at, used_org_id: orgId })
    var key = newRegistryKey_()
    var orgValues
    if (kind === 'new') {
      orgValues = {
        org_id: orgId, gas_url: gasUrl, status: 'active', channel: 'standard',
        display_name: String(codeRow.values.org_name || ''), created_at: at, gas_version: gasVersion, updated_at: at,
      }
      appendRowByHeaders_('Orgs', orgValues)
      if (String(codeRow.values.contact_name || '') || String(codeRow.values.contact_email || '')) {
        appendRowByHeaders_('Contacts', { org_id: orgId, name: String(codeRow.values.contact_name || ''), email: String(codeRow.values.contact_email || '') })
      }
    } else {
      setRowFields_('Orgs', existing.row, { gas_url: gasUrl, gas_version: gasVersion, updated_at: at })
      orgValues = {}
      Object.keys(existing.values).forEach(function (k) { orgValues[k] = existing.values[k] })
      orgValues.gas_url = gasUrl
      orgValues.gas_version = gasVersion
    }
    var keyGen = secret ? Number(secret.values.key_gen || 0) + 1 : 1
    var secretValues = { org_id: orgId, registry_key: key, key_gen: keyGen, updated_at: at, register_nonce_hash: nonceHash }
    if (secret) setRowFields_('Secrets', secret.row, secretValues)
    else appendRowByHeaders_('Secrets', secretValues)
    rememberOrgFingerprint_(orgId, orgValues)
    // 接続先の解決で覚えた答えを消す(新しい接続先をすぐに返す)
    forgetResolvedOrg_(orgId)
    // 記録には共有鍵もコードも残さない
    appendAudit_({
      actor: 'org:' + orgId,
      action: kind === 'new' ? 'registerOrg' : 'reregisterOrg',
      target: orgId,
      before: kind === 'reissue' ? { gasUrl: String(existing.values.gas_url || ''), keyGen: keyGen - 1 } : undefined,
      after: { codeId: String(codeRow.values.code_id || ''), displayName: String(orgValues.display_name || ''), gasUrl: gasUrl, gasVersion: gasVersion, keyGen: keyGen },
    })
    return { ok: true, result: registerResult_(orgId, secretValues, orgValues, kind) }
  })
}

function registerResult_(orgId, secretValues, orgValues, kind) {
  return {
    orgId: orgId,
    registryKey: String(secretValues.registry_key || ''),
    keyGen: Number(secretValues.key_gen || 0),
    displayName: String(orgValues.display_name || ''),
    registeredAt: isoOf_(secretValues.updated_at),
    kind: kind,
  }
}

// ---- 接続先の解決(resolveOrg) ----
//
// Ohsumi の画面が、団体ID から団体の GAS の URL を調べる(認証なし。1回の通信)。
//   要求: { action: 'resolveOrg', orgId }
//   返事: { ok: true, result: { orgId, gasUrl, status: 'active' | 'suspended', channel, checkedAt, maxAgeSec } }
//         無い団体ID(形が違う ID も同じ): { ok: false, notFound: true, error }
// - 団体ID が完全に一致した時だけ答える。一覧・検索は作らない。団体名・担当者・属性・利用状況は返さない
// - 停止中(status が suspended か、停止の予定日時を過ぎた)の団体は、status: 'suspended' だけを返す(gasUrl は返さない)
// - 答えは団体ごとに RESOLVE_CACHE_SEC 秒覚え、シートを読まない。登録・再登録(接続先の変更)の時は消す
// - 画面は答えを端末に保存し、maxAgeSec を過ぎるまでは問い合わせない(過ぎたら、ログインと並べて裏で問い合わせる)
var RESOLVE_CACHE_SEC = 600
var RESOLVE_MAX_AGE_SEC = 24 * 3600
var RESOLVE_NOT_FOUND = '団体が見つかりません。招待リンクが正しいか、団体の担当者に確かめてください。'

function resolvedOrgCacheKey_(orgId) { return 'ro:' + orgId }

function forgetResolvedOrg_(orgId) {
  try { CacheService.getScriptCache().remove(resolvedOrgCacheKey_(orgId)) } catch (e) { /* 覚えていなければ何もしない */ }
}

function resolveOrg_(body, nowMs) {
  var orgId = String(body.orgId || '')
  if (!ORG_ID_PATTERN.test(orgId)) return { ok: false, notFound: true, error: RESOLVE_NOT_FOUND }
  var cache = CacheService.getScriptCache()
  var key = resolvedOrgCacheKey_(orgId)
  var cached = cache.get(key)
  if (cached) {
    var hit = JSON.parse(cached)
    return hit.notFound ? { ok: false, notFound: true, error: RESOLVE_NOT_FOUND } : { ok: true, result: hit }
  }
  var row = findOrgRow_(orgId)
  var answer
  if (!row || !GAS_EXEC_URL_PATTERN.test(String(row.values.gas_url || ''))) {
    // 無い団体も短く覚える(同じ ID の問い合わせが続いても、シートを読まない)
    answer = { notFound: true }
  } else {
    // 提供停止中は接続先を返さない。機能停止中(読み取り専用)は、接続先を返して restricted を付ける
    var shown = orgDisplayState_(row.values, nowMs).state
    var suspended = shown === 'suspended'
    answer = {
      orgId: orgId,
      gasUrl: suspended ? '' : String(row.values.gas_url),
      status: suspended ? 'suspended' : shown === 'restricted' ? 'restricted' : 'active',
      channel: String(row.values.channel || 'standard'),
      checkedAt: new Date(nowMs).toISOString(),
      maxAgeSec: RESOLVE_MAX_AGE_SEC,
    }
  }
  cache.put(key, JSON.stringify(answer), answer.notFound ? 60 : RESOLVE_CACHE_SEC)
  return answer.notFound ? { ok: false, notFound: true, error: RESOLVE_NOT_FOUND } : { ok: true, result: answer }
}

// ---- 提供停止・機能停止(R1-e) ----
//
// 停止には2種類ある(suspend_kind)。どちらも管理画面で予定を入れ、予告(14日前・7日前・1日前)は同じ。
//   suspend(提供停止): 契約の終了・規約違反など。団体の画面は「利用を停止しています」になり、ログインもできない。
//                      団体の GAS は書き込み・通知・定期の処理を止める(データは団体のスプレッドシートにそのまま残る)
//   restrict(機能停止): アンケートの未回答など。全員が読み取り専用になる(閲覧と書き出しはできる)。
//                      画面の上部にアンケートへの回答のお願いを出す。通知・定期の処理は止めない。
//                      管理画面で解除すると、団体の GAS が次に確かめた時(使っている間は1分以内)に元に戻る
// 停止の予定は、今から SUSPEND_MIN_NOTICE_DAYS 日より後にだけ入れられる(予告を漏らさないため)。
// 予定の取り消し・停止の解除は、いつでもできる。どの操作も操作の記録に残す。
// 団体の GAS は、1時間ごと(停止の予定・停止中は使われるたび、1分に1回まで)に checkIn で状態を確かめる。
// レジストリに確かめられない時、団体の GAS は最後に確かめた状態のまま使い続ける(最後に届いた停止の予定日時は守る)
var SUSPEND_KINDS = ['suspend', 'restrict']
var SUSPEND_MIN_NOTICE_DAYS = 14
// プラン(利用契約書の案 第3条)。有償(paid)は、アンケートに回答が無くても機能停止にしない(サポートの停止のみ)
var PLANS = ['cosmo_base', 'ohsumi', 'paid']
var PLAN_LABELS = { cosmo_base: 'Cosmo Base プラン', ohsumi: 'Ohsumi プラン', paid: '有償プラン' }
var PAID_RESTRICT_ERROR = '有償プランの団体には、機能停止を入れられません(アンケートに回答が無い時は、サポートの停止のみです)。'
var SUSPEND_NOTICE_DAYS = [14, 7, 1]
var CHECKIN_MAX_SKEW_SEC = 300
var CHECKIN_WRITE_INTERVAL_MS = 10 * 60 * 1000
var CHECKIN_INVALID = '確認できませんでした(団体ID・共有鍵・時刻を確かめてください)。'

// 契約の状態(Google のサービスを使わない純粋な関数)。
//   phase: none(停止の予定なし)/ scheduled(予定あり。まだ前)/ inEffect(停止中)。kind: suspend / restrict
function contractState_(values, nowMs) {
  var kind = String(values.suspend_kind || '') === 'restrict' ? 'restrict' : 'suspend'
  var suspendAt = timeOf_(values.suspend_at)
  var reason = String(values.suspend_reason || '')
  if (String(values.status) === 'suspended') return { phase: 'inEffect', kind: 'suspend', suspendAt: isoOf_(values.suspend_at), reason: reason }
  if (!(suspendAt > 0)) return { phase: 'none', kind: kind, suspendAt: '', reason: '' }
  return { phase: suspendAt <= nowMs ? 'inEffect' : 'scheduled', kind: kind, suspendAt: new Date(suspendAt).toISOString(), reason: reason }
}

function suspensionNoticesSent_(values) {
  try {
    var list = JSON.parse(String(values.suspend_notices_json || '[]'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// 予告を送る日数(純粋な関数): 停止の予定まで days 日以内になった予告のうち、まだ送っていないいちばん近いもの。無ければ null
function dueSuspensionNotice_(values, nowMs) {
  var c = contractState_(values, nowMs)
  if (c.phase !== 'scheduled') return null
  var left = (timeOf_(c.suspendAt) - nowMs) / (24 * 3600 * 1000)
  var sent = suspensionNoticesSent_(values).map(function (n) { return Number(n.days) })
  var due = SUSPEND_NOTICE_DAYS.filter(function (d) { return left <= d })
  if (!due.length) return null
  var nearest = Math.min.apply(null, due)
  return sent.indexOf(nearest) >= 0 ? null : nearest
}

// 停止の予告の文面(団体の GAS のメール・画面と同じ言い方)
function suspensionNoticeText_(orgName, c, days) {
  var when = c.suspendAt ? Utilities.formatDate(new Date(c.suspendAt), 'Asia/Tokyo', 'yyyy年M月d日 H:mm') : ''
  var what = c.kind === 'restrict'
    ? 'Ohsumi が読み取り専用になります(閲覧と書き出しはできますが、作成・編集はできなくなります)。アンケートへの回答をお願いします。回答が確認でき次第、再開します。'
    : 'Ohsumi の提供を停止します。停止の後は、Ohsumi にログインできなくなります(団体のデータは、団体のスプレッドシートにそのまま残ります)。'
  return {
    subject: '[Ohsumi] ' + orgName + ': ' + when + ' から' + (c.kind === 'restrict' ? '読み取り専用になります' : '提供を停止します') + '(あと' + days + '日)',
    body: orgName + ' ご担当者さま\n\n' + when + ' から、' + what + '\n\n理由: ' + (c.reason || '—') + '\n\nご不明な点は FSIF にお問い合わせください。',
  }
}

// 担当者(Contacts)のメールアドレス(団体ID → 一覧)
function contactEmails_() {
  var contacts = {}
  readRows_('Contacts').forEach(function (r) {
    var id = String(r.values.org_id || '')
    var email = String(r.values.email || '').trim()
    if (id && /^[^@\s]+@[^@\s]+$/.test(email)) (contacts[id] = contacts[id] || []).push(email)
  })
  return contacts
}

// 毎日の処理(dailyRegistryBackup)から呼ぶ: 予告の時期になった団体の担当者(Contacts)にメールを送り、送ったことを記録する
function sendSuspensionNotices_(nowMs) {
  var contacts = contactEmails_()
  var sent = []
  readRows_('Orgs').forEach(function (row) {
    var orgId = String(row.values.org_id || '')
    var days = dueSuspensionNotice_(row.values, nowMs)
    if (!orgId || days === null) return
    var c = contractState_(row.values, nowMs)
    var text = suspensionNoticeText_(String(row.values.display_name || orgId), c, days)
    var to = contacts[orgId] || []
    if (to.length) MailApp.sendEmail({ to: to.join(','), subject: text.subject, body: text.body })
    var list = suspensionNoticesSent_(row.values).concat([{ days: days, at: new Date(nowMs).toISOString(), to: to.length }])
    setRowFields_('Orgs', row.row, { suspend_notices_json: JSON.stringify(list) })
    appendAudit_({ actor: 'registry', action: 'sendSuspensionNotice', target: orgId, after: { days: days, kind: c.kind, suspendAt: c.suspendAt, recipients: to.length } })
    sent.push(orgId)
  })
  if (sent.length) console.log('停止の予告を送りました: ' + sent.join(', '))
  return sent
}

// テスト環境の停止の操作(testSuspendNow・testScheduleSuspension・testLiftSuspension)。mode: now / schedule / lift
function testSetSuspension_(mode, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  if (String(props.REGISTRY_TEST_MODE || '') !== 'true') {
    throw new Error('テスト環境のレジストリだけで使えます(スクリプトプロパティ REGISTRY_TEST_MODE を true にしたレジストリ)。本番では、管理画面で停止の予定を入れてください。')
  }
  var orgId = String(props.TEST_ORG_ID || '').trim()
  var testOrgIds = String(props.REGISTRY_TEST_ORG_IDS || '').split(',').map(function (x) { return x.trim() }).filter(Boolean)
  if (!orgId || testOrgIds.indexOf(orgId) < 0) {
    throw new Error('TEST_ORG_ID の団体(' + (orgId || '未設定') + ')は、テスト環境の団体の一覧(スクリプトプロパティ REGISTRY_TEST_ORG_IDS)にありません。' +
      '本番の団体は止められません。何も変えていません。')
  }
  var kind = String(props.TEST_SUSPEND_KIND || 'restrict').trim()
  if (SUSPEND_KINDS.indexOf(kind) < 0) throw new Error('TEST_SUSPEND_KIND は suspend(提供停止)か restrict(機能停止)にしてください。')
  if (mode !== 'lift' && kind === 'restrict') {
    var testRow = findOrgRow_(orgId)
    if (testRow && String(testRow.values.plan || '') === 'paid') throw new Error(PAID_RESTRICT_ERROR)
  }
  var days = Number(props.TEST_SUSPEND_DAYS)
  if (mode === 'schedule' && !(days > 0)) throw new Error('TEST_SUSPEND_DAYS に、停止までの日数(例: 13.9・6.9・0.9)を入れてください。')
  var result = withRegistryLock_(function () {
    var row = findOrgRow_(orgId)
    if (!row) throw new Error('TEST_ORG_ID の団体(' + orgId + ')が Orgs にありません。')
    var before = contractState_(row.values, nowMs)
    var fields = mode === 'lift'
      ? { status: 'active', suspend_at: '', suspend_kind: '', suspend_reason: '', suspend_scheduled_by: '', suspend_notices_json: '' }
      : {
          suspend_at: new Date(mode === 'now' ? nowMs : nowMs + days * 24 * 3600 * 1000).toISOString(), suspend_kind: kind,
          suspend_reason: '(テスト)' + (kind === 'restrict' ? '機能停止' : '提供停止') + 'の確かめ', suspend_scheduled_by: 'editor(test)',
          suspend_notices_json: '[]',
        }
    fields.updated_at = new Date(nowMs).toISOString()
    setRowFields_('Orgs', row.row, fields)
    var after = merged_(row.values, fields)
    rememberOrgFingerprint_(orgId, after)
    forgetResolvedOrg_(orgId)
    appendAudit_({ actor: 'editor(test)', action: mode === 'lift' ? 'testLiftSuspension' : mode === 'now' ? 'testSuspendNow' : 'testScheduleSuspension', target: orgId,
      before: before.phase === 'none' ? undefined : { kind: before.kind, suspendAt: before.suspendAt, phase: before.phase },
      after: mode === 'lift' ? { phase: 'none' } : { kind: kind, suspendAt: fields.suspend_at } })
    return contractState_(after, nowMs)
  })
  // 予定を入れた時は、その時期の予告をすぐ送る(毎日の処理を待たない)
  var noticed = mode === 'schedule' ? sendSuspensionNotices_(nowMs).indexOf(orgId) >= 0 : false
  console.log('(テスト)' + orgId + ': ' + ({ none: '停止の予定なし', scheduled: '停止の予定あり', inEffect: '停止中' })[result.phase] +
    (result.phase === 'none' ? '' : '(' + (result.kind === 'restrict' ? '② 機能停止' : '① 提供停止') + '・' + result.suspendAt + ')') +
    (mode === 'schedule' ? (noticed ? '。担当者に予告を送りました' : '。予告の時期ではないため、予告は送っていません') : '') +
    '。団体の GAS には、団体のエディタで checkContractStatus を実行すると、すぐ伝わります。')
  return result
}

function requireAdminReauth_(session, nowMs, what) {
  if (!(nowSecOf_(nowMs) - Number(session.auth) <= ADMIN_REAUTH_SEC)) {
    throw registryError_(what + 'の前に、もう一度 Google でログインしてください(5分以内のログインが必要です)。', { reauth: true })
  }
}

// 管理画面: 停止の予定を入れる(入れ直す)。{ session, orgId, kind: suspend | restrict, suspendAt(ISO), reason }
function scheduleSuspension_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession_(body.session, props, nowMs)
  requireAdminReauth_(session, nowMs, '停止の予定を入れる')
  var kind = String(body.kind || '')
  if (SUSPEND_KINDS.indexOf(kind) < 0) throw registryError_('停止の種類(提供停止・機能停止)を選んでください。')
  // 当日の停止(緊急): 提供停止だけ。画面の確認を経たこと(confirm)が要る。予定の日時は今
  var immediate = body.immediate === true
  if (immediate && kind !== 'suspend') throw registryError_('当日に停止できるのは、提供停止だけです。機能停止は、今から' + SUSPEND_MIN_NOTICE_DAYS + '日より後に入れてください。')
  if (immediate && body.confirm !== true) throw registryError_('当日の停止は、確認の画面で「今すぐ提供停止にする」を押してください。')
  var at = immediate ? nowMs : timeOf_(body.suspendAt)
  if (!(at > 0)) throw registryError_('停止の日時を入れてください。')
  // 1分の余裕を見る(画面で「ちょうど14日後」を選んだ時に断らないため)
  if (!immediate && at < nowMs + SUSPEND_MIN_NOTICE_DAYS * 24 * 3600 * 1000 - 60 * 1000) {
    throw registryError_('停止の日時は、今から' + SUSPEND_MIN_NOTICE_DAYS + '日より後にしてください(予告を14日前・7日前・1日前に送るため)。' +
      (kind === 'suspend' ? '緊急の時は、「当日に提供停止にする」を選んでください。' : ''))
  }
  var reason = cleanText_(body.reason, 500)
  if (!reason) throw registryError_('停止の理由を入れてください(団体への予告に書きます)。')
  return withRegistryLock_(function () {
    var row = findOrgRow_(String(body.orgId || ''))
    if (!row) throw registryError_('その団体は見つかりません。')
    if (kind === 'restrict' && String(row.values.plan || '') === 'paid') throw registryError_(PAID_RESTRICT_ERROR)
    if (contractState_(row.values, nowMs).phase === 'inEffect') throw registryError_('この団体は停止中です。先に停止を解除してください。')
    var orgId = String(row.values.org_id)
    var before = contractState_(row.values, nowMs)
    var fields = {
      suspend_at: new Date(at).toISOString(), suspend_kind: kind, suspend_reason: reason, suspend_scheduled_by: session.sub,
      suspend_notices_json: '[]', updated_at: new Date(nowMs).toISOString(),
    }
    setRowFields_('Orgs', row.row, fields)
    var after = merged_(row.values, fields)
    rememberOrgFingerprint_(orgId, after)
    forgetResolvedOrg_(orgId)
    if (immediate) {
      // 当日の停止は、担当者にその場で知らせる(予告は送れないため)
      var to = contactEmails_()[orgId] || []
      var name = String(row.values.display_name || orgId)
      if (to.length) {
        MailApp.sendEmail({
          to: to.join(','),
          subject: '[Ohsumi] ' + name + ': Ohsumi の提供を停止しました',
          body: name + ' ご担当者さま\n\n緊急のため、本日、Ohsumi の提供を停止しました。Ohsumi にはログインできなくなります' +
            '(団体のデータは、団体のスプレッドシートにそのまま残ります)。\n\n理由: ' + reason + '\n\nご不明な点は FSIF にお問い合わせください。',
        })
      }
      var notices = [{ days: 0, at: new Date(nowMs).toISOString(), to: to.length }]
      setRowFields_('Orgs', row.row, { suspend_notices_json: JSON.stringify(notices) })
      after = merged_(after, { suspend_notices_json: JSON.stringify(notices) })
    }
    appendAudit_({ actor: session.sub, action: immediate ? 'suspendNow' : 'scheduleSuspension', target: orgId,
      before: before.phase === 'none' ? undefined : { kind: before.kind, suspendAt: before.suspendAt },
      after: { kind: kind, suspendAt: fields.suspend_at }, reason: reason })
    return { ok: true, result: orgSummary_(after, nowMs) }
  })
}

// 管理画面: 団体のプランを記録する。{ session, orgId, plan: cosmo_base | ohsumi | paid, reason }
// 有償にする時は、機能停止の予定・機能停止が入っていないこと(有償の団体は機能停止にしない)
function setOrgPlan_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession_(body.session, props, nowMs)
  var plan = String(body.plan || '')
  if (PLANS.indexOf(plan) < 0) throw registryError_('プラン(Cosmo Base・Ohsumi・有償)を選んでください。')
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var row = findOrgRow_(String(body.orgId || ''))
    if (!row) throw registryError_('その団体は見つかりません。')
    var c = contractState_(row.values, nowMs)
    if (plan === 'paid' && c.phase !== 'none' && c.kind === 'restrict') {
      throw registryError_('この団体には機能停止の予定(または機能停止)が入っています。有償プランにする前に、取り消す・解除してください。')
    }
    var orgId = String(row.values.org_id)
    var beforePlan = String(row.values.plan || '')
    if (beforePlan === plan) return { ok: true, result: orgSummary_(row.values, nowMs) }
    var fields = { plan: plan, updated_at: new Date(nowMs).toISOString() }
    setRowFields_('Orgs', row.row, fields)
    var after = merged_(row.values, fields)
    rememberOrgFingerprint_(orgId, after)
    appendAudit_({ actor: session.sub, action: 'setOrgPlan', target: orgId, before: { plan: beforePlan }, after: { plan: plan }, reason: reason })
    return { ok: true, result: orgSummary_(after, nowMs) }
  })
}

// 管理画面: 停止の予定を取り消す・停止を解除する(元に戻す)。{ session, orgId, reason }
function clearSuspension_(body, nowMs) {
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var session = verifyAdminSession_(body.session, props, nowMs)
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var row = findOrgRow_(String(body.orgId || ''))
    if (!row) throw registryError_('その団体は見つかりません。')
    var before = contractState_(row.values, nowMs)
    if (before.phase === 'none') throw registryError_('この団体には、停止の予定も停止もありません。')
    var orgId = String(row.values.org_id)
    var fields = {
      status: 'active', suspend_at: '', suspend_kind: '', suspend_reason: '', suspend_scheduled_by: '', suspend_notices_json: '',
      updated_at: new Date(nowMs).toISOString(),
    }
    setRowFields_('Orgs', row.row, fields)
    var after = merged_(row.values, fields)
    rememberOrgFingerprint_(orgId, after)
    forgetResolvedOrg_(orgId)
    appendAudit_({ actor: session.sub, action: before.phase === 'inEffect' ? 'liftSuspension' : 'cancelSuspension', target: orgId,
      before: { kind: before.kind, suspendAt: before.suspendAt, phase: before.phase }, after: { phase: 'none' }, reason: reason })
    return { ok: true, result: orgSummary_(after, nowMs) }
  })
}

function merged_(values, fields) {
  var out = {}
  Object.keys(values).forEach(function (k) { out[k] = values[k] })
  Object.keys(fields).forEach(function (k) { out[k] = fields[k] })
  return out
}

// 団体の GAS が契約の状態を確かめる(1時間ごと・停止の予定や停止中は使われるたびに1分に1回まで)。
//   要求: { action: 'checkIn', orgId, ts(Unix 秒), gasVersion, sig }
//          sig = base64url(HMAC-SHA256(共有鍵, 'checkIn.' + orgId + '.' + ts))。時刻は前後5分まで
//   返事: { ok: true, result: { phase: none | scheduled | inEffect, kind, suspendAt, reason, checkedAt, siteOrigins } }
//   siteOrigins: サイトの origin の一覧(スクリプトプロパティ SITE_ORIGINS。団体の GAS が、本人あての招待リンクのメールに使う)
// 最後に確認に来た時刻・GAS の版を Orgs に書く(10分に1回まで)
function checkIn_(body, nowMs) {
  var orgId = String(body.orgId || '')
  var ts = Number(body.ts)
  var sig = String(body.sig || '')
  if (!ORG_ID_PATTERN.test(orgId) || !(ts > 0) || !sig || Math.abs(nowSecOf_(nowMs) - ts) > CHECKIN_MAX_SKEW_SEC) {
    countRejected_(nowMs)
    throw registryError_(CHECKIN_INVALID, { authError: true })
  }
  var secret = findSecretRow_(orgId)
  var row = findOrgRow_(orgId)
  var key = secret ? String(secret.values.registry_key || '') : ''
  var expected = key ? b64url_(Utilities.computeHmacSha256Signature('checkIn.' + orgId + '.' + ts, key)) : ''
  if (!row || !expected || !safeEquals_(expected, sig)) {
    countRejected_(nowMs)
    throw registryError_(CHECKIN_INVALID, { authError: true })
  }
  var lastCheck = timeOf_(row.values.last_check_at)
  var gasVersion = cleanText_(body.gasVersion, 40)
  if (!(lastCheck > 0) || nowMs - lastCheck >= CHECKIN_WRITE_INTERVAL_MS || gasVersion !== String(row.values.gas_version || '')) {
    setRowFields_('Orgs', row.row, { last_check_at: new Date(nowMs).toISOString(), gas_version: gasVersion })
  }
  var c = contractState_(row.values, nowMs)
  return { ok: true, result: { phase: c.phase, kind: c.kind, suspendAt: c.suspendAt, reason: c.reason, checkedAt: new Date(nowMs).toISOString(), siteOrigins: siteOrigins_() } }
}

// サイトの origin の一覧。スクリプトプロパティ SITE_ORIGINS に、カンマ・空白・改行で区切って書く
// (例: 独自ドメインへ切り替える間は、今のサイトと新しいドメインの2つ)。最初のものを正式なサイトとして扱う。
// 「https://ホスト名[:ポート]」の形だけを使い、パス・クエリ・ユーザー名の付いたものは捨てる。
// サイトの URL はコードに書かない(lib/ohsumi/site-url.test.ts)
var SITE_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
var SITE_ORIGINS_MAX = 5

function parseSiteOrigins_(raw) {
  var out = []
  String(raw || '').split(/[\s,]+/).forEach(function (v) {
    var o = v.trim().toLowerCase().replace(/\/+$/, '')
    if (o && SITE_ORIGIN_PATTERN.test(o) && out.indexOf(o) < 0 && out.length < SITE_ORIGINS_MAX) out.push(o)
  })
  return out
}

function siteOrigins_() {
  return parseSiteOrigins_(PropertiesService.getScriptProperties().getProperty('SITE_ORIGINS'))
}

// ---- 管理画面のセッションの鍵 ----

// 管理画面用のセッションの鍵が無ければ作る(setupRegistry から呼ぶ)。本体(団体の GAS)の鍵とは別
function ensureAdminSessionKey_(props) {
  if (!props.getProperty('ADMIN_SESSION_KEY')) {
    props.setProperty('ADMIN_SESSION_KEY', generateSecret_())
    props.setProperty('ADMIN_SESSION_KID', generateSecret_().slice(0, 8))
    console.log('管理画面のセッションの鍵を作りました')
  }
}
