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
  forgetRegistryProps_()
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
  forgetRegistryProps_()
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
  // スクリプトプロパティ・版の一覧は、リクエストごとに CacheService から読み直す(同じ実行の中では1回だけ)
  _registryProps = null
  _gasVersions = null
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
    forgetRegistryProps_()
    if (unrecorded.length) console.warn('記録の無い変更がある団体: ' + unrecorded.join(', '))

    // その日に送るメールをいったんすべて MailQueue に入れ、最後に送る順(停止の予告 → リマインド → アンケートの送付)に送る。
    // 1日の上限で送れなかったものは、翌日以降に送る(失敗してもバックアップは続ける)
    _mailBatch = true
    try {
      // 停止の予告(14日前・7日前・1日前)
      try { sendSuspensionNotices_(Date.now()) } catch (noticeErr) { console.error('停止の予告を送れませんでした: ' + noticeErr) }
      // アンケート: 送付日になったものと、リマインド(7・10・14・15・21・26・27日目)
      try { sendSurveyMails_(Date.now()) } catch (surveyErr) { console.error('アンケートのメールを送れませんでした: ' + surveyErr) }
    } finally {
      _mailBatch = false
    }
    try { flushMailQueue_(Date.now()) } catch (mailErr) { console.error('メールを送れませんでした: ' + mailErr) }

    var folder = backupFolder_()
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    var copy = DriveApp.getFileById(ss.getId()).makeCopy('Ohsumi レジストリ バックアップ ' + stamp, folder)
    makePrivate_(copy)
    var removed = trashOldBackups_(folder, Date.now())
    props.setProperty('LAST_BACKUP_AT', new Date().toISOString())
    forgetRegistryProps_()
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

// レジストリの GAS の版(日付の形。変えたら pnpm gas:version で上げる。lib/ohsumi/gas-version.test.ts)
var REGISTRY_VERSION = '2026.10.05-1'

// シートと列(1行目の見出し)。列は見出しの名前で探す
//   Orgs の列(R1-c〜R1-e で使う列も、今のうちに用意する):
//     org_id・gas_url(接続先)・status(active / suspended)・channel・display_name・created_at(登録日)
//     suspend_at(停止の予定日時)・suspend_reason・last_check_at(団体の GAS が最後に確認に来た時刻)・gas_version
//     contract_status(active 契約中 / ending 終了予定 / ended 終了)・contract_until(契約の終了日)・contract_note
//     suspend_scheduled_by(停止の予定を入れた管理者)・suspend_notices_json(停止の予告を送った記録)・updated_at
//     suspend_kind(停止の種類)・plan(プラン: cosmo_base / ohsumi / paid。空は未設定)
var REGISTRY_SHEETS = {
  Orgs: ['org_id', 'gas_url', 'status', 'channel', 'display_name', 'created_at', 'suspend_at', 'suspend_reason', 'last_check_at', 'gas_version',
    'contract_status', 'contract_until', 'contract_note', 'suspend_scheduled_by', 'suspend_notices_json', 'updated_at', 'suspend_kind', 'plan',
    // メールの1日の上限(checkIn で団体の GAS が伝える): 残りの数・その日に送れなかった数・その日・最後に上限に達した日
    'mail_remaining', 'mail_skipped', 'mail_date', 'mail_limit_date',
    // 毎日・毎時の処理が最後に成功した時刻(checkIn で団体の GAS が伝える)
    'daily_job_at', 'hourly_job_at',
    // アンケートの未回答で入れた機能停止の、アンケートのID(回答済みにした時に、この停止を止める)
    'suspend_survey_id',
    // デモの団体(TRUE)。定量データの集計・KPI の数・アンケートの送付・停止の予定から外す(PR S)
    'demo',
    // この団体だけ止めている機能の ID(カンマ区切り。機能のスイッチ。PR W)
    'disabled_features',
    // この団体だけの上限・しきい値(JSON。全団体の値より優先。PR X)
    'tunables_json'],
  Contacts: ['org_id', 'name', 'email', 'phone'],
  Attributes: ['org_id', 'field', 'size', 'affiliation', 'started_year'],
  // 団体の GAS が週1回送る、個人を特定しない集計値(reportMetrics)。date は期間(その週の月曜日)。同じ団体・同じ期間は1行
  Usage: ['org_id', 'date', 'metrics_json', 'metrics_version', 'received_at',
    // 受け取った時にデモの団体だったか(TRUE。後で印を外しても、その時の集計値はデモのまま集計から外す)
    'demo'],
  RegistrationCodes: ['code_hash', 'kind', 'target_org_id', 'org_name', 'contact_name', 'contact_email', 'expires_at', 'issued_by', 'issued_at', 'used_at', 'used_org_id', 'revoked_at',
    'code_id', 'revoked_by', 'note'],
  // registry_key は共有鍵そのもの(団体の GAS との確認に使うため、元の値を持つ。保護したシート・誰とも共有しない)。
  // register_nonce_hash は、最後の登録の送り直しを見分けるための値(団体の GAS が作ってスクリプトプロパティに
  // 保存した乱数 registerNonce)の SHA-256
  Secrets: ['org_id', 'registry_key', 'key_gen', 'updated_at', 'register_nonce_hash'],
  // アンケート(管理画面から送る)。send_date は送付日(日本時間の YYYY-MM-DD)、status は open / answered / cancelled、
  // reminders_json は送ったメール(送付日から何日目か)の記録
  Surveys: ['survey_id', 'org_id', 'title', 'form_url', 'send_date', 'status', 'reminders_json', 'answered_at', 'answered_by', 'created_by', 'created_at', 'note'],
  // お知らせ(管理画面から出す)。importance は normal / important / urgent、target_kind は all / plan / orgs
  Announcements: ['announcement_id', 'title', 'body', 'importance', 'target_kind', 'target_plan', 'target_org_ids', 'published_at', 'expires_at', 'created_by',
    'withdrawn_at', 'withdrawn_by'],
  // 団体の代表が送った診断情報(個人情報を含まない)。receipt_no は受付番号、diag_id は送り直しを見分けるための ID
  Diagnostics: ['receipt_no', 'org_id', 'diag_id', 'received_at', 'gas_version', 'diagnostics_json'],
  // 上限で送れず、翌日以降に回したメール(PR R)。priority は送る順(0 停止の予告・1 リマインド・2 アンケートの送付・3 そのほか)
  MailQueue: ['mail_id', 'queued_at', 'priority', 'kind', 'org_id', 'to', 'subject', 'body', 'sent_at', 'attempts', 'last_error'],
  AuditLog: ['at', 'actor', 'action', 'target', 'before', 'after', 'reason'],
  // 団体の GAS の版の印(管理画面で付ける。コードの KNOWN_GAS_VERSIONS より優先する)。
  // security: 安全の修正を含む(TRUE/FALSE) / required: これより古ければ更新が要る(TRUE/FALSE)
  GasVersions: ['version', 'security', 'required', 'note', 'updated_at', 'updated_by'],
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
var RATE_LIMITS = { all: 600, health: 60, adminLogin: 30, registerOrg: 10, resolveOrg: 120, checkIn: 300, requestGasUpdate: 10, reportMetrics: 120, fetchAnnouncements: 300, receiveDiagnostics: 30 }

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
  health: function (body) { return healthResponse_(body.key, body) },
  adminLogin: function (body) { return adminLogin_(body, Date.now()) },
  adminOverview: function (body) { return adminOverview_(body, Date.now()) },
  issueRegistrationCode: function (body) { return issueRegistrationCode_(body, Date.now()) },
  revokeRegistrationCode: function (body) { return revokeRegistrationCode_(body, Date.now()) },
  registerOrg: function (body) { return registerOrg_(body, Date.now()) },
  resolveOrg: function (body) { return resolveOrg_(body, Date.now()) },
  checkIn: function (body) { return checkIn_(body, Date.now()) },
  reportMetrics: function (body) { return reportMetrics_(body, Date.now()) },
  scheduleSuspension: function (body) { return scheduleSuspension_(body, Date.now()) },
  clearSuspension: function (body) { return clearSuspension_(body, Date.now()) },
  setOrgPlan: function (body) { return setOrgPlan_(body, Date.now()) },
  setOrgDemo: function (body) { return setOrgDemo_(body, Date.now()) },
  setFeatureSwitches: function (body) { return setFeatureSwitches_(body, Date.now()) },
  setTunables: function (body) { return setTunables_(body, Date.now()) },
  setGasVersionMarks: function (body) { return setGasVersionMarks_(body, Date.now()) },
  requestGasUpdate: function (body) { return requestGasUpdate_(body, Date.now()) },
  sendSurvey: function (body) { return sendSurvey_(body, Date.now()) },
  markSurveyAnswered: function (body) { return closeSurvey_(body, Date.now(), 'answered') },
  cancelSurvey: function (body) { return closeSurvey_(body, Date.now(), 'cancelled') },
  scheduleSurveyRestriction: function (body) { return scheduleSurveyRestriction_(body, Date.now()) },
  fetchAnnouncements: function (body) { return fetchAnnouncements_(body, Date.now()) },
  receiveDiagnostics: function (body) { return receiveDiagnostics_(body, Date.now()) },
  getDiagnosticsReport: function (body) { return getDiagnosticsReport_(body, Date.now()) },
  publishAnnouncement: function (body) { return publishAnnouncement_(body, Date.now()) },
  withdrawAnnouncement: function (body) { return withdrawAnnouncement_(body, Date.now()) },
}

function registryJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

// ---- 死活の確認 ----

// 鍵(HEALTH_KEY)が無ければ、動いていることだけを返す。監視の GAS は鍵を付けて詳細を受け取る。
// 鍵を付けて来たのに合わない時は keyValid: false を付ける(監視が「鍵が違う」と分かるように。
// 鍵を付けない問い合わせには付けない)。団体の情報は返さない
function healthResponse_(key, body) {
  var props = registryProps_()
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
  // 監視の GAS の毎日のまとめ(summary: true の時だけ。Orgs を読むので、15分ごとの確認では読まない)
  if (body && body.summary === true) {
    res.gasVersions = gasVersionCounts_(Date.now())
    // 上限で送れず、翌日以降に回したレジストリのメール
    try { res.mailQueue = mailQueueStatus_() } catch (e) { res.mailQueue = null }
  }
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

// ---- スクリプトプロパティ(数分キャッシュに置く) ----
//
// 通信のたびに getProperties() を読むと、スクリプトプロパティの1日の上限(読み書き 50,000 回)に近づくので、
// まとめて CacheService(この GAS だけが読める)に PROPS_CACHE_SEC 秒置く。GAS が書き換えた時は、すぐに捨てる。
// エディタでスクリプトプロパティを手で変えた時(ADMIN_EMAILS など)は、反映まで最大 PROPS_CACHE_SEC 秒かかる
var PROPS_CACHE_KEY = 'registry:props'
var PROPS_CACHE_SEC = 300
var _registryProps = null

function registryProps_() {
  if (_registryProps) return _registryProps
  var cache = CacheService.getScriptCache()
  var raw = null
  try { raw = cache.get(PROPS_CACHE_KEY) } catch (e) { raw = null }
  if (raw) {
    try { _registryProps = JSON.parse(raw) || {} } catch (e) { _registryProps = null }
    if (_registryProps) return _registryProps
  }
  var props = PropertiesService.getScriptProperties().getProperties() || {}
  var text = JSON.stringify(props)
  // CacheService の1件の上限(100KB)より十分小さい時だけ置く
  if (text.length < 90000) {
    try { cache.put(PROPS_CACHE_KEY, text, PROPS_CACHE_SEC) } catch (e) { /* 置けなくても続ける */ }
  }
  _registryProps = props
  return props
}

// GAS がスクリプトプロパティを書き換えた後に呼ぶ
function forgetRegistryProps_() {
  _registryProps = null
  try { CacheService.getScriptCache().remove(PROPS_CACHE_KEY) } catch (e) { /* 次の期限で消える */ }
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
  forgetRegistryProps_()
}

// 覚えている指紋と違う行・覚えていない行・消えた行の団体ID
function findUnrecordedOrgEdits_() {
  var props = registryProps_()
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
  forgetRegistryProps_()
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
  var props = registryProps_()
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
    mail: orgMailSummary_(values),
    gasStatus: gasVersionStatus_(values, gasVersionList_(), nowMs),
    jobs: orgJobSummary_(values, nowMs),
    demo: isDemoOrg_(values),
    // この団体だけ止めている機能(全団体の分は含めない)
    disabledFeatures: parseFeatureList_(values.disabled_features),
    // この団体だけの上限・しきい値(全団体の値は含めない)
    tunables: parseTunableValues_(values.tunables_json),
  }
}

// メールの1日の上限(checkIn で伝えられたもの)。remaining: 最後の確認の時の残りの数(分からなければ null)、
// skipped: その日(date)に上限で送れなかった数、limitDate: 最後に上限に達した日、
// level: reached(最後に伝えられた日に上限に達した) / low(残りが MAIL_LOW_REMAINING 以下) / ok / unknown
var MAIL_LOW_REMAINING = 20
function orgMailSummary_(values) {
  var raw = values.mail_remaining
  var remaining = raw === '' || raw === undefined || raw === null || !isFinite(Number(raw)) ? null : Number(raw)
  var skipped = Number(values.mail_skipped) || 0
  var date = String(values.mail_date || '')
  var limitDate = String(values.mail_limit_date || '')
  var level = (skipped > 0 || (limitDate && limitDate === date)) ? 'reached'
    : remaining === null ? 'unknown'
      : remaining <= MAIL_LOW_REMAINING ? 'low' : 'ok'
  return { remaining: remaining, skipped: skipped, date: date, limitDate: limitDate, level: level }
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
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var orgs = readRows_('Orgs').filter(function (r) { return String(r.values.org_id || '') }).map(function (r) { return orgSummary_(r.values, nowMs) })
  var codes = readRows_('RegistrationCodes').filter(function (r) { return String(r.values.code_hash || '') }).map(function (r) { return codeSummary_(r.values, nowMs) })
  codes.sort(function (a, b) { return String(b.issuedAt).localeCompare(String(a.issuedAt)) })
  var audit = readRows_('AuditLog').slice(-AUDIT_SHOW_MAX).reverse().map(function (r) {
    return { at: isoOf_(r.values.at), actor: String(r.values.actor || ''), action: String(r.values.action || ''), target: String(r.values.target || ''),
      before: String(r.values.before || ''), after: String(r.values.after || ''), reason: String(r.values.reason || '') }
  })
  var so = surveyOverview_(nowMs)
  return {
    ok: true,
    result: {
      me: { email: session.sub, authAt: session.auth, exp: session.exp },
      orgs: orgs,
      codes: codes,
      audit: audit,
      codeTtlDays: REGISTRATION_CODE_TTL_DAYS,
      gasVersions: gasVersionList_(),
      surveys: so.surveys,
      surveyLimits: so.surveyLimits,
      survey12mCounts: so.survey12mCounts,
      announcements: announcementList_(nowMs),
      diagnostics: diagnosticsList_(),
      mailQueue: mailQueueStatus_(),
      kpis: orgKpis_(nowMs),
      // 機能のスイッチ: 止められる機能の一覧と、全団体で止めている機能
      features: { catalog: featureCatalog_(), globalDisabled: globalDisabledFeatures_() },
      // 上限・しきい値: 項目の一覧(既定・範囲)と、全団体の値
      tunables: { catalog: tunableCatalog_(), global: globalTunables_() },
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
  var props = registryProps_()
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
  var props = registryProps_()
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
var PLAN_LABELS = { cosmo_base: 'Cosmo Baseプラン', ohsumi: 'Ohsumiプラン', paid: '有償プラン' }
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
    var m = registryMail_({ to: to, subject: text.subject, body: text.body }, 'notice', orgId, nowMs)
    var list = suspensionNoticesSent_(row.values).concat([{ days: days, at: new Date(nowMs).toISOString(), to: to.length, queued: m.queued }])
    setRowFields_('Orgs', row.row, { suspend_notices_json: JSON.stringify(list) })
    appendAudit_({ actor: 'registry', action: 'sendSuspensionNotice', target: orgId, after: { days: days, kind: c.kind, suspendAt: c.suspendAt, recipients: to.length } })
    sent.push(orgId)
  })
  if (sent.length) console.log('停止の予告を送りました: ' + sent.join(', '))
  return sent
}

// テスト環境の停止の操作(testSuspendNow・testScheduleSuspension・testLiftSuspension)。mode: now / schedule / lift
function testSetSuspension_(mode, nowMs) {
  var props = registryProps_()
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
    var fields = unlinkSurvey_(row.values, mode === 'lift'
      ? { status: 'active', suspend_at: '', suspend_kind: '', suspend_reason: '', suspend_scheduled_by: '', suspend_notices_json: '' }
      : {
          suspend_at: new Date(mode === 'now' ? nowMs : nowMs + days * 24 * 3600 * 1000).toISOString(), suspend_kind: kind,
          suspend_reason: '(テスト)' + (kind === 'restrict' ? '機能停止' : '提供停止') + 'の確かめ', suspend_scheduled_by: 'editor(test)',
          suspend_notices_json: '[]',
        })
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
  var props = registryProps_()
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
    if (isDemoOrg_(row.values)) throw registryError_(DEMO_SUSPEND_ERROR)
    if (kind === 'restrict' && String(row.values.plan || '') === 'paid') throw registryError_(PAID_RESTRICT_ERROR)
    if (contractState_(row.values, nowMs).phase === 'inEffect') throw registryError_('この団体は停止中です。先に停止を解除してください。')
    var orgId = String(row.values.org_id)
    var before = contractState_(row.values, nowMs)
    var fields = {
      suspend_at: new Date(at).toISOString(), suspend_kind: kind, suspend_reason: reason, suspend_scheduled_by: session.sub,
      suspend_notices_json: '[]', updated_at: new Date(nowMs).toISOString(),
    }
    unlinkSurvey_(row.values, fields)
    setRowFields_('Orgs', row.row, fields)
    var after = merged_(row.values, fields)
    rememberOrgFingerprint_(orgId, after)
    forgetResolvedOrg_(orgId)
    if (immediate) {
      // 当日の停止は、担当者にその場で知らせる(予告は送れないため)
      var to = contactEmails_()[orgId] || []
      var name = String(row.values.display_name || orgId)
      registryMail_({
        to: to,
        subject: '[Ohsumi] ' + name + ': Ohsumi の提供を停止しました',
        body: name + ' ご担当者さま\n\n緊急のため、本日、Ohsumi の提供を停止しました。Ohsumi にはログインできなくなります' +
          '(団体のデータは、団体のスプレッドシートにそのまま残ります)。\n\n理由: ' + reason + '\n\nご不明な点は FSIF にお問い合わせください。',
      }, 'notice', orgId, nowMs)
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
  var props = registryProps_()
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
  var props = registryProps_()
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
    unlinkSurvey_(row.values, fields)
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
//   要求: { action: 'checkIn', orgId, ts(Unix 秒), gasVersion, mail, jobs, sig }
//          jobs: { dailyAt, hourlyAt }(毎日・毎時の処理が最後に成功した時刻)
//          mail: { remaining(メールの残りの数。分からなければ null), skipped(その日に上限で送れなかった数), date, lastReachedDate }
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
  var mail = checkInMailFields_(body.mail, row.values)
  var jobs = checkInJobFields_(body.jobs, row.values)
  // 送れなかった数が変わった時(上限に達した時)・毎日の処理が新しく成功した時は、10分を待たずに書く
  var mailChanged = mail && String(mail.mail_skipped) !== String(row.values.mail_skipped === undefined ? '' : row.values.mail_skipped)
  var jobsChanged = jobs && jobs.daily_job_at !== isoOf_(row.values.daily_job_at)
  if (!(lastCheck > 0) || nowMs - lastCheck >= CHECKIN_WRITE_INTERVAL_MS || gasVersion !== String(row.values.gas_version || '') || mailChanged || jobsChanged) {
    var fields = { last_check_at: new Date(nowMs).toISOString(), gas_version: gasVersion }
    if (mail) Object.keys(mail).forEach(function (k) { fields[k] = mail[k] })
    if (jobs) Object.keys(jobs).forEach(function (k) { fields[k] = jobs[k] })
    setRowFields_('Orgs', row.row, fields)
  }
  var c = contractState_(row.values, nowMs)
  // GAS の版: 更新が要るか(今届いた版で判定する)
  var vs = gasVersionStatus_(merged_(row.values, { gas_version: gasVersion, last_check_at: new Date(nowMs).toISOString() }), gasVersionList_(), nowMs)
  var gasUpdate = { required: vs.versionState === 'updateRequired', outdated: vs.versionState !== 'latest', latest: vs.latest, minimum: vs.minimum, security: vs.security }
  // プラン(団体の GAS が、集計値を送るかの決まりに使う。空は未設定)
  var plan = PLANS.indexOf(String(row.values.plan || '')) >= 0 ? String(row.values.plan) : ''
  return { ok: true, result: { phase: c.phase, kind: c.kind, suspendAt: c.suspendAt, reason: c.reason, checkedAt: new Date(nowMs).toISOString(), siteOrigins: siteOrigins_(), gasUpdate: gasUpdate, plan: plan,
    // 回答待ちのアンケート(代表の管理画面に出す)
    surveys: openSurveysFor_(orgId, row.values, nowMs),
    // 掲載中の緊急のお知らせの ID(団体の GAS が、自分の団体の代表に1回だけメールで送る。本文は fetchAnnouncements で取る)
    urgentAnnouncementIds: announcementsFor_(orgId, plan, nowMs).filter(function (a) { return a.importance === 'urgent' }).map(function (a) { return a.announcementId }),
    // 止めている機能(機能のスイッチ。全団体の分と、この団体の分)
    disabledFeatures: disabledFeaturesFor_(row.values),
    // 上限・しきい値(全団体の値に、この団体の値を重ねたもの。団体の GAS は範囲に収めて使う)
    tunables: tunablesFor_(row.values) } }
}

// ---- 定量データ(団体の GAS が週1回送る集計値) ----
//   要求: { action: 'reportMetrics', orgId, ts, period('YYYY-MM-DD'。その週の月曜日), metrics: { version, ...数 }, sig }
//          sig = base64url(HMAC-SHA256(共有鍵, 'metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(metrics)))
//   返事: { ok: true, result: { period, stored: 'new' | 'updated' } }
// 同じ団体・同じ期間は1行として扱う(送り直しは上書きする)。数は 0 以上の整数だけを受け付け、知らない項目は捨てる
var METRIC_KEYS = ['members', 'active_7d', 'active_30d', 'logins_7d', 'opens_7d', 'writes_7d', 'tasks', 'tasks_open', 'tasks_done',
  'tasks_overdue', 'tasks_created_7d', 'tasks_completed_7d', 'projects', 'errors_7d',
  // 版 2(団体の GAS の METRICS_VERSION = 2)
  'members_logged_in', 'comments_7d', 'reviews_approved_7d', 'tasks_overdue_days_avg', 'skill_points_total', 'daily_reports_7d',
  'one_on_ones_30d', 'expenses_7d', 'form_submissions_7d', 'applications_rejected_30d']
var METRICS_INVALID = '集計値を受け付けられませんでした。'

// 期間の列の値(シートが日付に変えた時も YYYY-MM-DD にそろえる)
function usageDateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  return String(v === undefined || v === null ? '' : v).slice(0, 10)
}

function reportMetrics_(body, nowMs) {
  var orgId = String(body.orgId || '')
  var ts = Number(body.ts)
  var period = String(body.period || '')
  var metrics = body.metrics
  if (!ORG_ID_PATTERN.test(orgId) || !(ts > 0) || Math.abs(nowSecOf_(nowMs) - ts) > CHECKIN_MAX_SKEW_SEC ||
    !/^\d{4}-\d{2}-\d{2}$/.test(period) || !metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    countRejected_(nowMs)
    throw registryError_(METRICS_INVALID, { authError: true })
  }
  var secret = findSecretRow_(orgId)
  var row = findOrgRow_(orgId)
  var key = secret ? String(secret.values.registry_key || '') : ''
  var expected = key ? b64url_(Utilities.computeHmacSha256Signature('metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(metrics), key)) : ''
  if (!row || !expected || !safeEquals_(expected, String(body.sig || ''))) {
    countRejected_(nowMs)
    throw registryError_(METRICS_INVALID, { authError: true })
  }
  var clean = {}
  METRIC_KEYS.forEach(function (k) {
    var n = Number(metrics[k])
    if (isFinite(n) && n >= 0 && n < 1e9) clean[k] = Math.floor(n)
  })
  var version = Math.floor(Number(metrics.version)) || 0
  var values = { org_id: orgId, date: period, metrics_json: JSON.stringify(clean), metrics_version: version, received_at: new Date(nowMs).toISOString() }
  // 列が無い古いシート(setupRegistry を実行し直していない)では書かない
  if (registrySheetHasColumn_('Usage', 'demo')) values.demo = isDemoOrg_(row.values) ? 'TRUE' : ''
  var lock = LockService.getScriptLock()
  lock.waitLock(10000)
  try {
    var existing = null
    readRows_('Usage').forEach(function (r) {
      if (String(r.values.org_id) === orgId && usageDateKey_(r.values.date) === period) existing = r
    })
    if (existing) setRowFields_('Usage', existing.row, values)
    else appendRowByHeaders_('Usage', values)
    return { ok: true, result: { period: period, stored: existing ? 'updated' : 'new' } }
  } finally {
    lock.releaseLock()
  }
}

// ---- アンケート(R2: PR O) ----
//
// 管理画面から、Google フォームの URL と送付日を、対象の団体(全団体・プラン別・団体を選ぶ)に送る。
//   - 送付日の当日に、担当者(Contacts)へメールで送る(送付日が今日なら、その場で送る)。団体の GAS には checkIn で伝え、代表の管理画面に出す
//   - 回答期限は送付日から14日目。リマインドは 7・10・14日目、期限の後は 15・21・26・27日目に、毎日の処理(dailyRegistryBackup)から送る
//     (処理が止まっていた時は、まだ送っていないいちばん新しいものだけを送る)
//   - プランごとの上限(直近12か月。送付日で数え、どの12か月の間でも超えないようにする。取り消したものは数えない): SURVEY_YEAR_LIMITS。
//     プランが未設定の団体には送らない
//   - 回答の確認は、当面 FSIF が管理画面で「回答済み」を押す。押すと、リマインドとこのアンケートで入れた機能停止(予定・停止中とも)を止める
//   - 期限を過ぎても回答が無い団体(有償プランを除く)は、管理画面の一覧から「28日目に機能停止を入れる」を1回の操作で入れられる(自動では入れない)。
//     28日目(送付日から28日後の0時・日本時間)を過ぎている時は、翌日の0時にする。入れた時に担当者へ知らせ、停止の予告(14・7・1日前)は送らない
//     (リマインドで知らせるため)
// 日付は日本時間の 'YYYY-MM-DD'(Utilities.formatDate を使わない。日本時間に夏時間は無い)
var SURVEY_YEAR_LIMITS = { ohsumi: 24, cosmo_base: 12, paid: 4 }
var SURVEY_DUE_DAYS = 14
var SURVEY_REMINDER_DAYS = [0, 7, 10, 14, 15, 21, 26, 27]
var SURVEY_RESTRICT_DAY = 28
var SURVEY_SEND_AHEAD_DAYS = 90
var SURVEY_STATUSES = ['open', 'answered', 'cancelled']
var SURVEY_FORM_URL_PATTERN = /^https:\/\/(docs\.google\.com\/forms\/[A-Za-z0-9_\-\/.?=&%]+|forms\.gle\/[A-Za-z0-9_-]+)$/
var SURVEY_SHOW_MAX = 300
// フォームの URL の長さ(団体の GAS は、回答待ちのアンケートをスクリプトプロパティに覚える。1つの値は9KBまで)
var SURVEY_FORM_URL_MAX = 300
var JST_OFFSET_MS = 9 * 3600 * 1000
var DAY_MS = 24 * 3600 * 1000

function jstDateKey_(ms) { return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10) }
// 'YYYY-MM-DD'(日本時間)の0時の時刻
function jstMidnightMs_(key) { return Date.parse(key + 'T00:00:00Z') - JST_OFFSET_MS }
function addDaysKey_(key, days) { return jstDateKey_(jstMidnightMs_(key) + days * DAY_MS) }
function daysBetweenKeys_(from, to) { return Math.round((jstMidnightMs_(to) - jstMidnightMs_(from)) / DAY_MS) }
function jaDate_(key) { var p = String(key).split('-'); return Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日' }

// 送付日の列の値(シートが日付に変えた時も、日本時間の 'YYYY-MM-DD' にそろえる)
function surveyDateKey_(v) {
  if (v instanceof Date) return jstDateKey_(v.getTime())
  var s = String(v === undefined || v === null ? '' : v).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function surveyRemindersSent_(values) {
  try {
    var list = JSON.parse(String(values.reminders_json || '[]'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// アンケートの状態(Google のサービスを使わない純粋な関数)。
//   state: scheduled(送付日の前)/ open(回答待ち・期限内)/ overdue(期限を過ぎて回答が無い)/ answered / cancelled
//   day: 送付日から何日目か(送付日が0)
function surveyState_(values, nowMs) {
  var status = SURVEY_STATUSES.indexOf(String(values.status || '')) >= 0 ? String(values.status) : 'open'
  var sendDate = surveyDateKey_(values.send_date)
  var day = sendDate ? daysBetweenKeys_(sendDate, jstDateKey_(nowMs)) : 0
  var state = status !== 'open' ? status : day < 0 ? 'scheduled' : day > SURVEY_DUE_DAYS ? 'overdue' : 'open'
  return { state: state, day: day, sendDate: sendDate, dueDate: sendDate ? addDaysKey_(sendDate, SURVEY_DUE_DAYS) : '' }
}

// 送るメール(純粋な関数): まだ送っていない、いちばん新しい送る日。無ければ null
function dueSurveyReminder_(values, nowMs) {
  var s = surveyState_(values, nowMs)
  if (s.state !== 'open' && s.state !== 'overdue') return null
  var due = SURVEY_REMINDER_DAYS.filter(function (d) { return d <= s.day })
  if (!due.length) return null
  var latest = Math.max.apply(null, due)
  var sent = surveyRemindersSent_(values).map(function (r) { return Number(r.day) })
  return sent.indexOf(latest) >= 0 ? null : latest
}

// 28日目に入れる機能停止の時刻(過ぎていれば翌日の0時)
function surveyRestrictAt_(sendDate, nowMs) {
  var at = jstMidnightMs_(addDaysKey_(sendDate, SURVEY_RESTRICT_DAY))
  return at > nowMs ? at : jstMidnightMs_(addDaysKey_(jstDateKey_(nowMs), 1))
}

function surveyText_(orgName, values, day, restrictAt) {
  var s = surveyState_(values, Date.now())
  var title = String(values.title || 'アンケート')
  var due = jaDate_(s.dueDate)
  var head = orgName + ' ご担当者さま\n\n'
  var link = '\n\nアンケート: ' + title + '\n回答はこちら: ' + String(values.form_url || '') + '\n回答期限: ' + due + '\n\n' +
    'Ohsumi の代表の方の管理画面にも表示しています。ご回答の後、FSIF が確認します。ご不明な点は FSIF にお問い合わせください。'
  var restrict = restrictAt ? '\n\n回答が確認できない時は、' + Utilities.formatDate(new Date(restrictAt), 'Asia/Tokyo', 'yyyy年M月d日 H:mm') +
    ' から Ohsumi が読み取り専用になります(閲覧と書き出しはできますが、作成・編集はできなくなります)。回答が確認でき次第、再開します。' : ''
  if (day === 0) {
    return { subject: '[Ohsumi] ' + orgName + ': アンケートへのご回答のお願い(回答期限 ' + due + ')',
      body: head + 'Ohsumi の改善のため、アンケートへのご回答をお願いします。' + link }
  }
  if (day <= SURVEY_DUE_DAYS) {
    return { subject: '[Ohsumi] ' + orgName + ': アンケートへのご回答のお願い' + (day === SURVEY_DUE_DAYS ? '(本日が回答期限です)' : '(回答期限 ' + due + ')'),
      body: head + (day === SURVEY_DUE_DAYS ? '本日が、アンケートの回答期限です。' : 'アンケートへのご回答が、まだ確認できていません。') + 'ご回答をお願いします。' + restrict + link }
  }
  return { subject: '[Ohsumi] ' + orgName + ': アンケートの回答期限(' + due + ')を過ぎています',
    body: head + 'アンケートの回答期限(' + due + ')を過ぎましたが、ご回答がまだ確認できていません。お早めにご回答をお願いします。' + restrict + link }
}

// 停止の予定を入れ直す・取り消す時に、アンケートとのつながりも消す(列が無い古いシートでは何もしない)
function unlinkSurvey_(values, fields) {
  if ('suspend_survey_id' in values) fields.suspend_survey_id = ''
  return fields
}

function findSurveyRow_(surveyId) {
  var rows = readRows_('Surveys')
  for (var i = 0; i < rows.length; i++) if (String(rows[i].values.survey_id) === String(surveyId)) return rows[i]
  return null
}

// 'YYYY-MM-DD' の months か月後(月末は、その月の最後の日にそろえる)
function addMonthsKey_(key, months) {
  var p = key.split('-').map(Number)
  var y = p[0] + Math.floor((p[1] - 1 + months) / 12)
  var m = ((p[1] - 1 + months) % 12 + 12) % 12
  var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  var pad = function (n) { return (n < 10 ? '0' : '') + n }
  return y + '-' + pad(m + 1) + '-' + pad(Math.min(p[2], last))
}

// 団体のアンケートの送付日の一覧(取り消したものは数えない)
function surveySendDates_(rows, orgId) {
  return rows.filter(function (r) { return String(r.values.org_id) === orgId && String(r.values.status) !== 'cancelled' })
    .map(function (r) { return surveyDateKey_(r.values.send_date) }).filter(Boolean)
}

// 直近12か月の数: 送付日が (day の12か月前, day] のもの
function surveyCount12m_(dates, day) {
  var from = addMonthsKey_(day, -12)
  return dates.filter(function (d) { return d > from && d <= day }).length
}

// 送付日 day のアンケートを足した時の、day を含むどの12か月の間でも一番多い数(純粋な関数)。
// 先の送付日の予定もあるため、day を終わりにした12か月だけでなく、day を含む12か月の間をすべて見る
function surveyPeak12m_(dates, day) {
  var all = dates.concat([day])
  var from = addMonthsKey_(day, -12)
  var starts = all.filter(function (d) { return d > from && d <= day })
  var peak = 0
  starts.forEach(function (start) {
    var end = addMonthsKey_(start, 12)
    var n = all.filter(function (d) { return d >= start && d < end }).length
    if (n > peak) peak = n
  })
  return peak
}

// このアンケートで入れた機能停止の時刻(入っていなければ 0)
function surveyRestrictionOf_(orgValues, surveyId, nowMs) {
  if (String(orgValues.suspend_survey_id || '') !== String(surveyId)) return 0
  var c = contractState_(orgValues, nowMs)
  return c.phase !== 'none' && c.kind === 'restrict' ? timeOf_(c.suspendAt) : 0
}

function surveySummary_(values, orgValues, nowMs) {
  var s = surveyState_(values, nowMs)
  var restrictAt = orgValues ? surveyRestrictionOf_(orgValues, values.survey_id, nowMs) : 0
  var plan = orgValues && PLANS.indexOf(String(orgValues.plan || '')) >= 0 ? String(orgValues.plan) : ''
  return {
    surveyId: String(values.survey_id || ''),
    orgId: String(values.org_id || ''),
    orgName: orgValues ? String(orgValues.display_name || '') : '',
    plan: plan,
    title: String(values.title || ''),
    formUrl: String(values.form_url || ''),
    sendDate: s.sendDate,
    dueDate: s.dueDate,
    state: s.state,
    day: s.day,
    remindersSent: surveyRemindersSent_(values).map(function (r) { return Number(r.day) }),
    answeredAt: isoOf_(values.answered_at),
    answeredBy: String(values.answered_by || ''),
    createdBy: String(values.created_by || ''),
    createdAt: isoOf_(values.created_at),
    restrictAt: restrictAt ? new Date(restrictAt).toISOString() : '',
    // 「28日目に機能停止を入れる」を出すか: 期限を過ぎて回答が無い・有償プランでない・ほかの停止の予定が無い
    canRestrict: s.state === 'overdue' && plan !== 'paid' && !!orgValues && !isDemoOrg_(orgValues) && contractState_(orgValues, nowMs).phase === 'none',
    demo: !!orgValues && isDemoOrg_(orgValues),
  }
}

function orgValuesById_() {
  var out = {}
  readRows_('Orgs').forEach(function (r) { if (String(r.values.org_id || '')) out[String(r.values.org_id)] = r.values })
  return out
}

// 管理画面の一覧: アンケート(新しい順)と、プランごとの上限・団体ごとの直近12か月の数
function surveyOverview_(nowMs) {
  var orgs = orgValuesById_()
  var rows = readRows_('Surveys').filter(function (r) { return String(r.values.survey_id || '') })
  var today = jstDateKey_(nowMs)
  var counts = {}
  // 直近12か月の数(送付の予定を含む)
  Object.keys(orgs).forEach(function (id) {
    var dates = surveySendDates_(rows, id)
    counts[id] = surveyCount12m_(dates, today) + dates.filter(function (d) { return d > today }).length
  })
  var list = rows.map(function (r) { return surveySummary_(r.values, orgs[String(r.values.org_id)] || null, nowMs) })
  list.sort(function (a, b) { return b.sendDate.localeCompare(a.sendDate) || b.createdAt.localeCompare(a.createdAt) })
  return { surveys: list.slice(0, SURVEY_SHOW_MAX), surveyLimits: SURVEY_YEAR_LIMITS, survey12mCounts: counts }
}

// アンケートのメールを担当者に送り(上限の時は MailQueue に入れ)、送ったことを記録する(例外の時は記録しない。次の毎日の処理で送り直す)。宛先の数を返す
function sendSurveyMail_(row, orgValues, day, contacts, nowMs) {
  var orgId = String(row.values.org_id)
  var to = contacts[orgId] || []
  var restrictAt = surveyRestrictionOf_(orgValues, row.values.survey_id, nowMs)
  var text = surveyText_(String(orgValues.display_name || orgId), row.values, day, restrictAt)
  var m = registryMail_({ to: to, subject: text.subject, body: text.body }, day === 0 ? 'send' : 'reminder', orgId, nowMs)
  var list = surveyRemindersSent_(row.values).concat([{ day: day, at: new Date(nowMs).toISOString(), to: to.length, queued: m.queued }])
  setRowFields_('Surveys', row.row, { reminders_json: JSON.stringify(list) })
  row.values.reminders_json = JSON.stringify(list)
  return to.length
}

// 毎日の処理から: 送付日になったアンケートと、リマインドを送る
function sendSurveyMails_(nowMs) {
  var orgs = orgValuesById_()
  var contacts = contactEmails_()
  var sent = []
  readRows_('Surveys').forEach(function (row) {
    var orgValues = orgs[String(row.values.org_id || '')]
    var day = dueSurveyReminder_(row.values, nowMs)
    if (!orgValues || day === null) return
    try {
      var to = sendSurveyMail_(row, orgValues, day, contacts, nowMs)
      appendAudit_({ actor: 'registry', action: day === 0 ? 'sendSurveyMail' : 'sendSurveyReminder', target: String(row.values.org_id), after: { surveyId: String(row.values.survey_id), day: day, recipients: to } })
      sent.push(String(row.values.survey_id))
    } catch (e) {
      console.error('アンケートのメールを送れませんでした(' + row.values.survey_id + '): ' + e)
    }
  })
  if (sent.length) console.log('アンケートのメールを送りました: ' + sent.join(', '))
  return sent
}

// checkIn で団体の GAS に伝える: 回答待ち(送付日を過ぎ、回答済み・取り消しでない)のアンケート
function openSurveysFor_(orgId, orgValues, nowMs) {
  return readRows_('Surveys').filter(function (r) { return String(r.values.org_id) === orgId }).map(function (r) {
    return surveySummary_(r.values, orgValues, nowMs)
  }).filter(function (s) { return s.state === 'open' || s.state === 'overdue' }).map(function (s) {
    return { surveyId: s.surveyId, title: s.title, formUrl: s.formUrl, sendDate: s.sendDate, dueDate: s.dueDate, overdue: s.state === 'overdue', restrictAt: s.restrictAt }
  })
}

// 管理画面: アンケートを送る。{ session, title, formUrl, sendDate('YYYY-MM-DD'), target: { kind: all | plan | orgs, plan, orgIds }, reason }
//   返事: { sent: [{ orgId, surveyId, mailed }], skipped: [{ orgId, reason }] }
//   上限に達した・プランが未設定・提供停止中・同じフォームを回答待ちの団体は、送らずに skipped で返す(ほかの団体には送る)
function sendSurvey_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var title = cleanText_(body.title, 100)
  var formUrl = cleanText_(body.formUrl, 1000)
  var sendDate = String(body.sendDate || '')
  var today = jstDateKey_(nowMs)
  if (!title) throw registryError_('アンケートの名前を入れてください。')
  if (formUrl.length > SURVEY_FORM_URL_MAX) throw registryError_('フォームの URL は' + SURVEY_FORM_URL_MAX + '文字までにしてください(短い URL https://forms.gle/… が使えます)。')
  if (!SURVEY_FORM_URL_PATTERN.test(formUrl)) throw registryError_('Google フォームの URL(https://docs.google.com/forms/… か https://forms.gle/…)を入れてください。')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sendDate) || isNaN(jstMidnightMs_(sendDate)) || addDaysKey_(sendDate, 0) !== sendDate) throw registryError_('送付日を入れてください。')
  if (sendDate < today) throw registryError_('送付日は、今日より後の日にしてください(過ぎた日にすると、リマインドの日がずれます)。')
  if (daysBetweenKeys_(today, sendDate) > SURVEY_SEND_AHEAD_DAYS) throw registryError_('送付日は、' + SURVEY_SEND_AHEAD_DAYS + '日以内にしてください。')
  var target = body.target && typeof body.target === 'object' ? body.target : {}
  var kind = String(target.kind || '')
  if (['all', 'plan', 'orgs'].indexOf(kind) < 0) throw registryError_('送る団体(全団体・プラン・団体を選ぶ)を選んでください。')
  if (kind === 'plan' && PLANS.indexOf(String(target.plan || '')) < 0) throw registryError_('送るプランを選んでください。')
  var orgIds = kind === 'orgs' && Array.isArray(target.orgIds) ? target.orgIds.map(String) : []
  if (kind === 'orgs' && !orgIds.length) throw registryError_('送る団体を選んでください。')
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var orgRows = readRows_('Orgs').filter(function (r) { return String(r.values.org_id || '') })
    var targets = orgRows.filter(function (r) {
      if (kind === 'plan') return String(r.values.plan || '') === String(target.plan)
      if (kind === 'orgs') return orgIds.indexOf(String(r.values.org_id)) >= 0
      return true
    })
    if (kind === 'orgs' && targets.length !== orgIds.length) throw registryError_('選んだ団体のうち、見つからないものがあります。一覧を読み直してください。')
    if (!targets.length) throw registryError_('送る団体がありません。')
    var surveys = readRows_('Surveys')
    var contacts = contactEmails_()
    var sent = []
    var skipped = []
    targets.forEach(function (r) {
      var orgId = String(r.values.org_id)
      var plan = String(r.values.plan || '')
      var skip = ''
      if (isDemoOrg_(r.values)) skip = 'デモの団体です(アンケートは送りません)。'
      else if (PLANS.indexOf(plan) < 0) skip = 'プランが未設定です(先にプランを記録してください)。'
      else if (orgDisplayState_(r.values, nowMs).state === 'suspended') skip = '提供停止中です。'
      else if (surveyPeak12m_(surveySendDates_(surveys, orgId), sendDate) > SURVEY_YEAR_LIMITS[plan]) skip = PLAN_LABELS[plan] + 'の上限(直近12か月で' + SURVEY_YEAR_LIMITS[plan] + '件)を超えます。'
      else if (surveys.some(function (s) { return String(s.values.org_id) === orgId && String(s.values.form_url) === formUrl && ['answered', 'cancelled'].indexOf(String(s.values.status)) < 0 })) {
        skip = '同じフォームのアンケートを、回答待ちで送っています。'
      }
      if (skip) { skipped.push({ orgId: orgId, reason: skip }); return }
      var surveyId = 'sv_' + generateSecret_().replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
      var values = { survey_id: surveyId, org_id: orgId, title: title, form_url: formUrl, send_date: sendDate, status: 'open', reminders_json: '[]',
        created_by: session.sub, created_at: new Date(nowMs).toISOString(), note: reason }
      appendRowByHeaders_('Surveys', values)
      var mailed = 0
      if (sendDate === today) {
        // 送付日が今日なら、その場で送る(送れなかった時は、毎日の処理で送り直す)
        try {
          mailed = sendSurveyMail_({ row: readRows_('Surveys').length + 1, values: values }, r.values, 0, contacts, nowMs)
        } catch (e) {
          console.error('アンケートのメールを送れませんでした(' + surveyId + '): ' + e)
        }
      }
      surveys.push({ row: 0, values: values })
      sent.push({ orgId: orgId, surveyId: surveyId, mailed: mailed })
    })
    appendAudit_({ actor: session.sub, action: 'sendSurvey', target: kind === 'plan' ? 'plan:' + target.plan : kind === 'all' ? 'all' : orgIds.join(','),
      after: { title: title, formUrl: formUrl, sendDate: sendDate, sent: sent.map(function (s) { return s.orgId }), skipped: skipped }, reason: reason })
    return { ok: true, result: { sent: sent, skipped: skipped } }
  })
}

// このアンケートで入れた機能停止を止める(回答済み・取り消しの時)。止めたら true
function clearSurveyRestriction_(surveyId, nowMs) {
  var org = null
  readRows_('Orgs').forEach(function (r) { if (String(r.values.suspend_survey_id || '') === String(surveyId)) org = r })
  if (!org || !surveyRestrictionOf_(org.values, surveyId, nowMs)) return false
  var fields = { status: 'active', suspend_at: '', suspend_kind: '', suspend_reason: '', suspend_scheduled_by: '', suspend_notices_json: '', suspend_survey_id: '',
    updated_at: new Date(nowMs).toISOString() }
  setRowFields_('Orgs', org.row, fields)
  var orgId = String(org.values.org_id)
  rememberOrgFingerprint_(orgId, merged_(org.values, fields))
  forgetResolvedOrg_(orgId)
  return true
}

// 管理画面: 回答済みにする・取り消す。{ session, surveyId, reason }
function closeSurvey_(body, nowMs, status) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var row = findSurveyRow_(String(body.surveyId || ''))
    if (!row) throw registryError_('そのアンケートは見つかりません。')
    var before = String(row.values.status || 'open')
    if (before === 'answered') throw registryError_('このアンケートは、回答済みです。')
    if (before === 'cancelled') throw registryError_('このアンケートは、取り消し済みです。')
    var fields = { status: status }
    if (status === 'answered') { fields.answered_at = new Date(nowMs).toISOString(); fields.answered_by = session.sub }
    setRowFields_('Surveys', row.row, fields)
    var lifted = clearSurveyRestriction_(row.values.survey_id, nowMs)
    var orgId = String(row.values.org_id)
    appendAudit_({ actor: session.sub, action: status === 'answered' ? 'markSurveyAnswered' : 'cancelSurvey', target: orgId,
      before: { surveyId: String(row.values.survey_id), status: before }, after: { status: status, restrictionCleared: lifted }, reason: reason })
    var orgRow = findOrgRow_(orgId)
    return { ok: true, result: surveySummary_(merged_(row.values, fields), orgRow ? orgRow.values : null, nowMs) }
  })
}

// 管理画面: 期限を過ぎて回答が無いアンケートの団体に、28日目の機能停止を入れる。{ session, surveyIds: [...], reason }
//   返事: { scheduled: [{ surveyId, orgId, restrictAt }], skipped: [{ surveyId, reason }] }
function scheduleSurveyRestriction_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  requireAdminReauth_(session, nowMs, '機能停止を入れる')
  var ids = Array.isArray(body.surveyIds) ? body.surveyIds.map(String).slice(0, 200) : []
  if (!ids.length) throw registryError_('アンケートを選んでください。')
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var contacts = contactEmails_()
    var scheduled = []
    var skipped = []
    ids.forEach(function (surveyId) {
      var row = findSurveyRow_(surveyId)
      var org = row ? findOrgRow_(String(row.values.org_id)) : null
      var s = row ? surveyState_(row.values, nowMs) : null
      var skip = !row || !org ? 'アンケートか団体が見つかりません。'
        : s.state !== 'overdue' ? '回答期限を過ぎて回答が無いアンケートではありません。'
          : isDemoOrg_(org.values) ? DEMO_SUSPEND_ERROR
          : String(org.values.plan || '') === 'paid' ? PAID_RESTRICT_ERROR
            : contractState_(org.values, nowMs).phase !== 'none' ? 'この団体には、ほかの停止の予定(または停止)が入っています。' : ''
      if (skip) { skipped.push({ surveyId: surveyId, reason: skip }); return }
      var orgId = String(org.values.org_id)
      var at = surveyRestrictAt_(s.sendDate, nowMs)
      var title = String(row.values.title || 'アンケート')
      // 停止の予告(14・7・1日前)は送らない(リマインドで知らせる)。印として、送ったことにしておく
      var covered = SUSPEND_NOTICE_DAYS.map(function (d) { return { days: d, at: new Date(nowMs).toISOString(), to: 0, via: 'survey' } })
      var fields = { suspend_at: new Date(at).toISOString(), suspend_kind: 'restrict', suspend_reason: 'アンケート「' + title + '」への回答が確認できないため',
        suspend_scheduled_by: session.sub, suspend_notices_json: JSON.stringify(covered), suspend_survey_id: String(row.values.survey_id), updated_at: new Date(nowMs).toISOString() }
      setRowFields_('Orgs', org.row, fields)
      var after = merged_(org.values, fields)
      rememberOrgFingerprint_(orgId, after)
      forgetResolvedOrg_(orgId)
      // 入れたことを、担当者にその場で知らせる(期限の後のリマインドと同じ文面に、停止の日時を入れる)
      var mailed = 0
      try {
        var to = contacts[orgId] || []
        var text = surveyText_(String(org.values.display_name || orgId), row.values, Math.max(s.day, SURVEY_DUE_DAYS + 1), at)
        registryMail_({ to: to, subject: text.subject, body: text.body }, 'notice', orgId, nowMs)
        mailed = to.length
      } catch (e) {
        console.error('機能停止の知らせを送れませんでした(' + orgId + '): ' + e)
      }
      appendAudit_({ actor: session.sub, action: 'scheduleSurveyRestriction', target: orgId,
        after: { surveyId: String(row.values.survey_id), kind: 'restrict', suspendAt: fields.suspend_at, recipients: mailed }, reason: reason })
      scheduled.push({ surveyId: String(row.values.survey_id), orgId: orgId, restrictAt: fields.suspend_at })
    })
    return { ok: true, result: { scheduled: scheduled, skipped: skipped } }
  })
}

// ---- お知らせ(R2: PR P) ----
//
// 管理画面から、全団体・プラン別・団体を選んでお知らせを出す。重要度は normal(通常)/ important(重要)/ urgent(緊急)。
// 団体の GAS は、代表・管理者が管理画面を開いた時に、共有鍵の署名で取りに来る(fetchAnnouncements。団体の GAS が10分覚える)。
// 本文が長くなるため、checkIn には入れない(団体の GAS のスクリプトプロパティは、1つの値が9KBまで)。
// 緊急のお知らせは、checkIn で ID だけを伝え、団体の GAS が自分の団体の代表にメールで1回だけ送る
// (レジストリから全団体に送ると、レジストリのメールの1日の上限に届くため)。
// 取り下げたもの・掲載の終わり(expires_at)を過ぎたものは伝えない。プラン別は、出した後にプランを変えた団体にも、今のプランで決める
var ANNOUNCEMENT_IMPORTANCE = ['normal', 'important', 'urgent']
var ANNOUNCEMENT_TITLE_MAX = 100
var ANNOUNCEMENT_BODY_MAX = 1000
// 掲載の期間(省いた時は30日。長くても1年)
var ANNOUNCEMENT_DEFAULT_DAYS = 30
var ANNOUNCEMENT_MAX_DAYS = 365
// checkIn で1団体に伝える数(新しい順)
var ANNOUNCEMENT_CHECKIN_MAX = 20
var ANNOUNCEMENT_SHOW_MAX = 200

function announcementOrgIds_(values) {
  return String(values.target_org_ids || '').split(',').map(function (x) { return x.trim() }).filter(Boolean)
}

// お知らせの状態(純粋な関数): active(掲載中)/ expired(掲載の終わりを過ぎた)/ withdrawn(取り下げ)
function announcementState_(values, nowMs) {
  if (String(values.withdrawn_at || '')) return 'withdrawn'
  var exp = timeOf_(values.expires_at)
  return exp > 0 && exp <= nowMs ? 'expired' : 'active'
}

// この団体が対象か(純粋な関数)
function announcementTargets_(values, orgId, plan) {
  var kind = String(values.target_kind || '')
  if (kind === 'all') return true
  if (kind === 'plan') return !!plan && String(values.target_plan || '') === plan
  if (kind === 'orgs') return announcementOrgIds_(values).indexOf(orgId) >= 0
  return false
}

function announcementSummary_(values, nowMs) {
  return {
    announcementId: String(values.announcement_id || ''),
    title: String(values.title || ''),
    body: String(values.body || ''),
    importance: ANNOUNCEMENT_IMPORTANCE.indexOf(String(values.importance)) >= 0 ? String(values.importance) : 'normal',
    targetKind: String(values.target_kind || ''),
    targetPlan: String(values.target_plan || ''),
    targetOrgIds: announcementOrgIds_(values),
    publishedAt: isoOf_(values.published_at),
    expiresAt: isoOf_(values.expires_at),
    createdBy: String(values.created_by || ''),
    state: announcementState_(values, nowMs),
    withdrawnAt: isoOf_(values.withdrawn_at),
    withdrawnBy: String(values.withdrawn_by || ''),
  }
}

function announcementList_(nowMs) {
  var list = readRows_('Announcements').filter(function (r) { return String(r.values.announcement_id || '') }).map(function (r) { return announcementSummary_(r.values, nowMs) })
  list.sort(function (a, b) { return b.publishedAt.localeCompare(a.publishedAt) })
  return list.slice(0, ANNOUNCEMENT_SHOW_MAX)
}

// 団体の GAS に返す: 掲載中で、この団体が対象のお知らせ(新しい順)
function announcementsFor_(orgId, plan, nowMs) {
  return readRows_('Announcements').filter(function (r) {
    return String(r.values.announcement_id || '') && announcementState_(r.values, nowMs) === 'active' && announcementTargets_(r.values, orgId, plan)
  }).map(function (r) {
    var s = announcementSummary_(r.values, nowMs)
    return { announcementId: s.announcementId, title: s.title, body: s.body, importance: s.importance, publishedAt: s.publishedAt, expiresAt: s.expiresAt }
  }).sort(function (a, b) { return b.publishedAt.localeCompare(a.publishedAt) }).slice(0, ANNOUNCEMENT_CHECKIN_MAX)
}

// 団体の GAS が取りに来る。{ action: 'fetchAnnouncements', orgId, ts, sig }
//   sig = base64url(HMAC-SHA256(共有鍵, 'announcements.' + orgId + '.' + ts))。時刻は前後5分まで
//   返事: { ok: true, result: { announcements: [{ announcementId, title, body, importance, publishedAt, expiresAt }] } }
function fetchAnnouncements_(body, nowMs) {
  var orgId = String(body.orgId || '')
  var ts = Number(body.ts)
  if (!ORG_ID_PATTERN.test(orgId) || !(ts > 0) || Math.abs(nowSecOf_(nowMs) - ts) > CHECKIN_MAX_SKEW_SEC) {
    countRejected_(nowMs)
    throw registryError_(CHECKIN_INVALID, { authError: true })
  }
  var secret = findSecretRow_(orgId)
  var row = findOrgRow_(orgId)
  var key = secret ? String(secret.values.registry_key || '') : ''
  var expected = key ? b64url_(Utilities.computeHmacSha256Signature('announcements.' + orgId + '.' + ts, key)) : ''
  if (!row || !expected || !safeEquals_(expected, String(body.sig || ''))) {
    countRejected_(nowMs)
    throw registryError_(CHECKIN_INVALID, { authError: true })
  }
  var plan = PLANS.indexOf(String(row.values.plan || '')) >= 0 ? String(row.values.plan) : ''
  return { ok: true, result: { announcements: announcementsFor_(orgId, plan, nowMs) } }
}

// 管理画面: お知らせを出す。{ session, title, body, importance, target: { kind: all | plan | orgs, plan, orgIds }, expiresAt(ISO。省くと30日後) }
function publishAnnouncement_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var title = cleanText_(body.title, ANNOUNCEMENT_TITLE_MAX)
  // 本文は改行を残す(ほかの制御文字だけを除く)
  var text = String(body.body === null || body.body === undefined ? '' : body.body).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim()
  if (!title) throw registryError_('お知らせの題を入れてください。')
  if (!text) throw registryError_('お知らせの本文を入れてください。')
  if (text.length > ANNOUNCEMENT_BODY_MAX) throw registryError_('本文は' + ANNOUNCEMENT_BODY_MAX + '文字までにしてください。')
  var importance = String(body.importance || 'normal')
  if (ANNOUNCEMENT_IMPORTANCE.indexOf(importance) < 0) throw registryError_('重要度(通常・重要・緊急)を選んでください。')
  var target = body.target && typeof body.target === 'object' ? body.target : {}
  var kind = String(target.kind || '')
  if (['all', 'plan', 'orgs'].indexOf(kind) < 0) throw registryError_('出す団体(全団体・プラン・団体を選ぶ)を選んでください。')
  if (kind === 'plan' && PLANS.indexOf(String(target.plan || '')) < 0) throw registryError_('出すプランを選んでください。')
  var orgIds = kind === 'orgs' && Array.isArray(target.orgIds) ? target.orgIds.map(String) : []
  if (kind === 'orgs') {
    if (!orgIds.length) throw registryError_('出す団体を選んでください。')
    var known = orgValuesById_()
    if (orgIds.some(function (id) { return !known[id] })) throw registryError_('選んだ団体のうち、見つからないものがあります。一覧を読み直してください。')
  }
  var exp = body.expiresAt ? timeOf_(body.expiresAt) : nowMs + ANNOUNCEMENT_DEFAULT_DAYS * DAY_MS
  if (!(exp > nowMs)) throw registryError_('掲載の終わりは、今より後にしてください。')
  if (exp > nowMs + ANNOUNCEMENT_MAX_DAYS * DAY_MS) throw registryError_('掲載の終わりは、' + ANNOUNCEMENT_MAX_DAYS + '日以内にしてください。')
  return withRegistryLock_(function () {
    var values = {
      announcement_id: 'an_' + generateSecret_().replace(/[^A-Za-z0-9]/g, '').slice(0, 12),
      title: title, body: text, importance: importance,
      target_kind: kind, target_plan: kind === 'plan' ? String(target.plan) : '', target_org_ids: orgIds.join(','),
      published_at: new Date(nowMs).toISOString(), expires_at: new Date(exp).toISOString(), created_by: session.sub,
    }
    appendRowByHeaders_('Announcements', values)
    appendAudit_({ actor: session.sub, action: 'publishAnnouncement', target: kind === 'plan' ? 'plan:' + target.plan : kind === 'all' ? 'all' : orgIds.join(','),
      after: { announcementId: values.announcement_id, title: title, importance: importance, expiresAt: values.expires_at } })
    return { ok: true, result: announcementSummary_(values, nowMs) }
  })
}

// 管理画面: お知らせを取り下げる(団体の管理画面から、次の確認で消える)。{ session, announcementId, reason }
function withdrawAnnouncement_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var row = null
    readRows_('Announcements').forEach(function (r) { if (String(r.values.announcement_id) === String(body.announcementId || '')) row = r })
    if (!row) throw registryError_('そのお知らせは見つかりません。')
    if (String(row.values.withdrawn_at || '')) throw registryError_('このお知らせは、取り下げ済みです。')
    var fields = { withdrawn_at: new Date(nowMs).toISOString(), withdrawn_by: session.sub }
    setRowFields_('Announcements', row.row, fields)
    appendAudit_({ actor: session.sub, action: 'withdrawAnnouncement', target: String(row.values.announcement_id), before: { title: String(row.values.title || '') }, reason: reason })
    return { ok: true, result: announcementSummary_(merged_(row.values, fields), nowMs) }
  })
}

// ---- 診断情報(R2: PR Q) ----
//
// 団体の代表が管理画面で確かめてから送る、個人情報を含まない診断情報を受け、受付番号を返す。
//   要求: { action: 'receiveDiagnostics', orgId, ts, diagId, diagnostics(JSON の文字列), sig }
//          sig = base64url(HMAC-SHA256(共有鍵, 'diagnostics.' + orgId + '.' + ts + '.' + diagId + '.' + diagnostics))。時刻は前後5分まで
//   返事: { ok: true, result: { receiptNo, receivedAt, duplicate } }
//   受付番号は「D + 受け付けた日(日本時間の YYMMDD)+ - + 4文字」(電話でも伝えやすい文字だけ)。
//   同じ団体・同じ診断ID の送り直しは、同じ受付番号を返す。1団体1日に DIAGNOSTICS_DAILY_MAX 件まで。
//   念のため、文の中のメールアドレスは「(メールアドレス)」に置き換えて残す
var DIAGNOSTICS_MAX_CHARS = 30000
var DIAGNOSTICS_DAILY_MAX = 20
var DIAGNOSTICS_SHOW_MAX = 100
var DIAGNOSTICS_INVALID = '診断情報を受け付けられませんでした。'

function diagnosticsSummary_(values, orgs) {
  var orgId = String(values.org_id || '')
  return {
    receiptNo: String(values.receipt_no || ''),
    orgId: orgId,
    orgName: orgs && orgs[orgId] ? String(orgs[orgId].display_name || '') : '',
    receivedAt: isoOf_(values.received_at),
    gasVersion: String(values.gas_version || ''),
  }
}

function diagnosticsList_() {
  var orgs = orgValuesById_()
  return readRows_('Diagnostics').filter(function (r) { return String(r.values.receipt_no || '') }).slice(-DIAGNOSTICS_SHOW_MAX).reverse()
    .map(function (r) { return diagnosticsSummary_(r.values, orgs) })
}

function newReceiptNo_(nowMs, existing) {
  var day = jstDateKey_(nowMs).replace(/-/g, '').slice(2)
  for (var i = 0; i < 20; i++) {
    var bytes = randomBytes_(4)
    var tail = ''
    for (var j = 0; j < 4; j++) tail += REGISTRATION_CODE_ALPHABET.charAt((bytes[j] & 0xff) % REGISTRATION_CODE_ALPHABET.length)
    var no = 'D' + day + '-' + tail
    if (!existing[no]) return no
  }
  throw new Error('受付番号を作れませんでした')
}

function receiveDiagnostics_(body, nowMs) {
  var orgId = String(body.orgId || '')
  var ts = Number(body.ts)
  var diagId = String(body.diagId || '')
  var text = typeof body.diagnostics === 'string' ? body.diagnostics : ''
  if (!ORG_ID_PATTERN.test(orgId) || !(ts > 0) || Math.abs(nowSecOf_(nowMs) - ts) > CHECKIN_MAX_SKEW_SEC || !/^dg_[A-Za-z0-9]{8,40}$/.test(diagId) || !text) {
    countRejected_(nowMs)
    throw registryError_(DIAGNOSTICS_INVALID, { authError: true })
  }
  var secret = findSecretRow_(orgId)
  var row = findOrgRow_(orgId)
  var key = secret ? String(secret.values.registry_key || '') : ''
  var expected = key ? b64url_(Utilities.computeHmacSha256Signature('diagnostics.' + orgId + '.' + ts + '.' + diagId + '.' + text, key)) : ''
  if (!row || !expected || !safeEquals_(expected, String(body.sig || ''))) {
    countRejected_(nowMs)
    throw registryError_(DIAGNOSTICS_INVALID, { authError: true })
  }
  if (text.length > DIAGNOSTICS_MAX_CHARS) throw registryError_('診断情報が大きすぎます。')
  var parsed
  try { parsed = JSON.parse(text) } catch (e) { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw registryError_(DIAGNOSTICS_INVALID)
  var clean = JSON.stringify(parsed).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, '(メールアドレス)')
  return withRegistryLock_(function () {
    var rows = readRows_('Diagnostics')
    var existing = {}
    var today = jstDateKey_(nowMs)
    var todayCount = 0
    var same = null
    rows.forEach(function (r) {
      existing[String(r.values.receipt_no)] = true
      if (String(r.values.org_id) !== orgId) return
      if (String(r.values.diag_id) === diagId) same = r
      if (jstDateKey_(timeOf_(r.values.received_at) || 0) === today) todayCount++
    })
    if (same) return { ok: true, result: { receiptNo: String(same.values.receipt_no), receivedAt: isoOf_(same.values.received_at), duplicate: true } }
    if (todayCount >= DIAGNOSTICS_DAILY_MAX) throw registryError_('今日は、これ以上の診断情報を受け付けられません(1日' + DIAGNOSTICS_DAILY_MAX + '件まで)。明日、もう一度送ってください。')
    var receiptNo = newReceiptNo_(nowMs, existing)
    var receivedAt = new Date(nowMs).toISOString()
    appendRowByHeaders_('Diagnostics', { receipt_no: receiptNo, org_id: orgId, diag_id: diagId, received_at: receivedAt,
      gas_version: cleanText_(parsed.version, 40), diagnostics_json: clean })
    appendAudit_({ actor: 'org:' + orgId, action: 'receiveDiagnostics', target: orgId, after: { receiptNo: receiptNo } })
    return { ok: true, result: { receiptNo: receiptNo, receivedAt: receivedAt, duplicate: false } }
  })
}

// 管理画面: 受付番号で、診断情報の中身を見る。{ session, receiptNo }
function getDiagnosticsReport_(body, nowMs) {
  var props = registryProps_()
  verifyAdminSession_(body.session, props, nowMs)
  var no = String(body.receiptNo || '').trim().toUpperCase()
  if (!/^D\d{6}-[A-Z0-9]{4}$/.test(no)) throw registryError_('受付番号(D から始まる、例: D261001-AB2C)を入れてください。')
  var hit = null
  readRows_('Diagnostics').forEach(function (r) { if (String(r.values.receipt_no) === no) hit = r })
  if (!hit) throw registryError_('その受付番号の診断情報は見つかりません。')
  var report
  try { report = JSON.parse(String(hit.values.diagnostics_json || '{}')) } catch (e) { report = {} }
  var summary = diagnosticsSummary_(hit.values, orgValuesById_())
  summary.diagnostics = report
  return { ok: true, result: summary }
}

// ---- レジストリのメールの1日の上限(PR R) ----
//
// レジストリを動かすアカウントが個人の Gmail なら、1日に送れる宛先は100件まで(Workspace は1,500件)。
// アンケートの送付・リマインド・停止の予告などが同じ日に重なっても、上限を超えて失われないように:
//   - 送る前に残りの数(MailApp.getRemainingDailyQuota)を確かめ、足りない分は MailQueue シートに残して、翌日以降に送る
//   - 毎日の処理では、その日に送るメールをいったんすべて MailQueue に入れ、送る順(優先度)に送る:
//     停止の予告(0)→ リマインド(1)→ アンケートの送付(2)→ そのほか(3)。同じ優先度は古いものから
//   - 管理画面の操作で送るメール(当日の送付・機能停止の知らせ・当日の提供停止・更新のお願い)は、残りがあればその場で送る
//   - 送れていないメールの件数を、管理画面(adminOverview の mailQueue)と、監視の毎朝のまとめ(health の summary)に出す
var MAIL_PRIORITY = { notice: 0, reminder: 1, send: 2, other: 3 }
// 送ったメールの行を残す日数(古いものは毎日の処理で消す)
var MAIL_QUEUE_KEEP_DAYS = 30
// 毎日の処理の間は、その場で送らずに MailQueue に入れる(最後に優先度の順に送る)
var _mailBatch = false

function mailRemaining_() {
  try { return Number(MailApp.getRemainingDailyQuota()) } catch (e) { return 0 }
}

// メールを送る。残りが足りない時(毎日の処理の間はいつも)は MailQueue に入れる。{ sent: bool, queued: bool, recipients }
//   mail: { to: [...], subject, body }, kind: notice | reminder | send | other
function registryMail_(mail, kind, orgId, nowMs) {
  var to = (mail.to || []).filter(Boolean)
  if (!to.length) return { sent: false, queued: false, recipients: 0 }
  if (!_mailBatch && mailRemaining_() >= to.length) {
    MailApp.sendEmail({ to: to.join(','), subject: mail.subject, body: mail.body })
    return { sent: true, queued: false, recipients: to.length }
  }
  appendRowByHeaders_('MailQueue', {
    mail_id: 'ml_' + generateSecret_().replace(/[^A-Za-z0-9]/g, '').slice(0, 12),
    queued_at: new Date(nowMs || Date.now()).toISOString(),
    priority: MAIL_PRIORITY.hasOwnProperty(kind) ? MAIL_PRIORITY[kind] : MAIL_PRIORITY.other,
    kind: kind, org_id: orgId || '', to: to.join(','), subject: mail.subject, body: mail.body, attempts: 0,
  })
  return { sent: false, queued: true, recipients: to.length }
}

// MailQueue のまだ送っていないものを、優先度の順に、残りの数の分だけ送る。送った数と残った数を返す
function flushMailQueue_(nowMs) {
  var rows = readRows_('MailQueue').filter(function (r) { return String(r.values.mail_id || '') && !String(r.values.sent_at || '') })
  rows.sort(function (a, b) {
    return (Number(a.values.priority) - Number(b.values.priority)) || String(isoOf_(a.values.queued_at)).localeCompare(String(isoOf_(b.values.queued_at)))
  })
  var remaining = mailRemaining_()
  var sent = 0
  var left = 0
  rows.forEach(function (r) {
    var to = String(r.values.to || '').split(',').filter(Boolean)
    // 送る順を守るため、前のものが送れなかった後は、少ない宛先のものでも送らない
    if (left > 0 || to.length > remaining) { left++; return }
    try {
      MailApp.sendEmail({ to: to.join(','), subject: String(r.values.subject || ''), body: String(r.values.body || '') })
      remaining -= to.length
      sent++
      setRowFields_('MailQueue', r.row, { sent_at: new Date(nowMs).toISOString(), attempts: Number(r.values.attempts || 0) + 1 })
    } catch (e) {
      left++
      setRowFields_('MailQueue', r.row, { attempts: Number(r.values.attempts || 0) + 1, last_error: String((e && e.message) || e).slice(0, 200) })
    }
  })
  trimMailQueue_(nowMs)
  if (sent || left) console.log('レジストリのメール: ' + sent + ' 通を送りました' + (left ? '(上限のため ' + left + ' 通を翌日以降に回しました)' : ''))
  return { sent: sent, left: left }
}

// 送ってから MAIL_QUEUE_KEEP_DAYS 日を過ぎた行を消す(下から消す)
function trimMailQueue_(nowMs) {
  var sheet = registrySheet_('MailQueue')
  var rows = readRows_('MailQueue')
  for (var i = rows.length - 1; i >= 0; i--) {
    var at = timeOf_(rows[i].values.sent_at)
    if (at > 0 && nowMs - at > MAIL_QUEUE_KEEP_DAYS * DAY_MS) sheet.deleteRow(rows[i].row)
  }
}

// 送れていないメールの状態(管理画面・監視の毎朝のまとめ)
function mailQueueStatus_() {
  var pending = readRows_('MailQueue').filter(function (r) { return String(r.values.mail_id || '') && !String(r.values.sent_at || '') })
  var byKind = {}
  var recipients = 0
  var oldest = ''
  pending.forEach(function (r) {
    var k = String(r.values.kind || 'other')
    byKind[k] = (byKind[k] || 0) + 1
    recipients += String(r.values.to || '').split(',').filter(Boolean).length
    var at = isoOf_(r.values.queued_at)
    if (!oldest || at < oldest) oldest = at
  })
  return { pending: pending.length, recipients: recipients, byKind: byKind, oldestAt: oldest, remainingToday: mailRemaining_() }
}

// ---- デモの団体(PR S) ----
//
// 立ち上げのテスト・説明会で使う団体に「デモ」の印(Orgs の demo 列)を付ける。デモの団体は:
//   - 定量データの集計・KPI の数(プラン別の契約数・利用中の団体の数)から外す(受け取った集計値には、その時の印を Usage に残す)
//   - アンケートの送付の対象から外す(団体を選んで送っても送らない)
//   - 停止の予定(提供停止・機能停止・当日の提供停止・アンケートの28日目の機能停止)を入れられない(誤操作で止めないため)。解除・取り消しはできる
//     テスト環境の関数(testSuspendNow など。REGISTRY_TEST_MODE の時だけ)は、停止の確かめのため、デモの団体でも動く
// 本番・テスト環境のどちらのレジストリでも、管理画面の「デモの印を付ける」で付け外しする(操作の記録に残す)
var DEMO_SUSPEND_ERROR = 'デモの団体には、停止の予定を入れられません(誤操作で止めないため)。止める必要がある時は、先にデモの印を外してください。'

function isDemoOrg_(values) {
  return boolCell_(values && values.demo)
}

function registrySheetHasColumn_(name, col) {
  var sheet = registrySheet_(name)
  return sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String).indexOf(col) >= 0
}

// 管理画面: デモの印を付ける・外す。{ session, orgId, demo: true | false, reason }
// 停止の予定(停止中)がある団体には、先に取り消す・解除してから付ける
function setOrgDemo_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var demo = body.demo === true
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    if (!registrySheetHasColumn_('Orgs', 'demo')) throw registryError_('Orgs に demo の列がありません。レジストリのエディタで setupRegistry を実行してください。')
    var row = findOrgRow_(String(body.orgId || ''))
    if (!row) throw registryError_('その団体は見つかりません。')
    var orgId = String(row.values.org_id)
    var before = isDemoOrg_(row.values)
    if (before === demo) return { ok: true, result: orgSummary_(row.values, nowMs) }
    if (demo && contractState_(row.values, nowMs).phase !== 'none') {
      throw registryError_('この団体には停止の予定(または停止)が入っています。デモの印を付ける前に、取り消す・解除してください。')
    }
    var fields = { demo: demo ? 'TRUE' : '', updated_at: new Date(nowMs).toISOString() }
    setRowFields_('Orgs', row.row, fields)
    var after = merged_(row.values, fields)
    appendAudit_({ actor: session.sub, action: 'setOrgDemo', target: orgId, before: { demo: before }, after: { demo: demo }, reason: reason })
    return { ok: true, result: orgSummary_(after, nowMs) }
  })
}

// ---- 機能のスイッチ(団体の GAS の機能を止める。PR W) ----
//
// 不具合が見つかった時に、団体の GAS を更新し直す前に、その機能だけを止める。checkIn の返事の disabledFeatures で伝え、
// 団体の GAS は書き込みの前の確かめ直し(10分に1回まで)と1時間ごとの確認で受け取る(止めてから効くまで最大10分ほど)。
//   全団体: スクリプトプロパティ DISABLED_FEATURES(カンマ区切り)  団体ごと: Orgs の disabled_features 列(カンマ区切り)
// 団体に伝えるのは、この2つを合わせたもの。ログインと読み取りは、団体の GAS の側で止められないようにしている。
// ID は団体の GAS(gas/Code.gs)の FEATURE_SWITCHES と同じにする(テストで確かめる)。知らない ID は捨てる。
// 変えるのは管理画面から(5分以内の Google でのログインが必要。操作の記録に残す)
var FEATURE_IDS = {
  uploads: 'ファイルのアップロード',
  expenses: '経費の申請・承認',
  forms: 'フォーム・アンケートの回答と承認',
  schedule: '日程調整',
  dailyReports: '日報の提出',
  recruiting: '採用の候補者',
  skills: 'スキル・ポイント・クイズ',
  projectHealth: 'プロジェクトの健康状態',
  training: '研修の申請',
  memberSurvey: 'メンバーのアンケートの回答',
  restore: 'バックアップから戻す',
  personalData: '個人情報の削除の操作',
  webhookSettings: 'Discord・Slack の設定と接続テスト',
  chatNotify: 'Discord・Slack への通知',
  calendarSync: 'Google カレンダーへの登録',
  recurringTasks: '定期タスクの作成',
  metricsSend: 'FSIF への集計値の送信',
}

// カンマ区切り・配列を、知っている ID だけの一覧にする(FEATURE_IDS の順)
function parseFeatureList_(v) {
  var raw = Array.isArray(v) ? v.map(String) : String(v || '').split(',')
  var set = {}
  raw.forEach(function (x) { set[String(x).trim()] = true })
  return Object.keys(FEATURE_IDS).filter(function (id) { return set[id] })
}

function globalDisabledFeatures_() {
  return parseFeatureList_(registryProps_().DISABLED_FEATURES)
}

// 団体に伝える一覧(全団体の分と、その団体の分を合わせたもの)
function disabledFeaturesFor_(values) {
  return parseFeatureList_(globalDisabledFeatures_().concat(parseFeatureList_(values && values.disabled_features)))
}

function featureCatalog_() {
  return Object.keys(FEATURE_IDS).map(function (id) { return { id: id, label: FEATURE_IDS[id] } })
}

// 管理画面: 止める機能を変える。{ session, scope: 'global' | 'org', orgId(scope が org の時), features: [ID...], reason }
function setFeatureSwitches_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  requireAdminReauth_(session, nowMs, '機能を止める・再開する')
  var features = parseFeatureList_(Array.isArray(body.features) ? body.features : [])
  var reason = cleanText_(body.reason, 500)
  if (!reason) throw registryError_('理由を書いてください(操作の記録に残し、あとで再開する時の目安にします)。')
  return withRegistryLock_(function () {
    if (body.scope === 'global') {
      var before = globalDisabledFeatures_()
      PropertiesService.getScriptProperties().setProperty('DISABLED_FEATURES', features.join(','))
      forgetRegistryProps_()
      appendAudit_({ actor: session.sub, action: 'setFeatureSwitches', target: '(全団体)', before: { disabled: before }, after: { disabled: features }, reason: reason })
      return { ok: true, result: { scope: 'global', disabled: features } }
    }
    if (!registrySheetHasColumn_('Orgs', 'disabled_features')) throw registryError_('Orgs に disabled_features の列がありません。レジストリのエディタで setupRegistry を実行してください。')
    var row = findOrgRow_(String(body.orgId || ''))
    if (!row) throw registryError_('その団体は見つかりません。')
    var orgId = String(row.values.org_id)
    var beforeOrg = parseFeatureList_(row.values.disabled_features)
    var fields = { disabled_features: features.join(','), updated_at: new Date(nowMs).toISOString() }
    setRowFields_('Orgs', row.row, fields)
    appendAudit_({ actor: session.sub, action: 'setFeatureSwitches', target: orgId, before: { disabled: beforeOrg }, after: { disabled: features }, reason: reason })
    return { ok: true, result: orgSummary_(merged_(row.values, fields), nowMs) }
  })
}

// ---- 上限・しきい値(団体の GAS に配る。PR X) ----
//
// 回数の上限・しきい値を、団体の GAS を更新し直さずに変える。checkIn の返事の tunables で伝える。
//   全団体: スクリプトプロパティ TUNABLES(JSON)  団体ごと: Orgs の tunables_json 列(JSON。全団体の値より優先)
// 範囲(min〜max)は、団体の GAS の TUNABLES と同じにする(テストで確かめる)。団体の GAS も、届いた値を範囲に収めて使う。
// 管理画面で範囲の外の値を入れた時は、保存せずに断る(どの値になるか分かりにくくしないため)
var TUNABLE_RANGES = {
  notifyPerHour: { def: 60, min: 10, max: 300, label: '通知(1人1時間)' },
  mentionPerHour: { def: 30, min: 5, max: 100, label: 'メンションの通知の宛先(1人1時間)' },
  resultNotifyPerHour: { def: 10, min: 3, max: 50, label: '結果の通知(1人1時間)' },
  translatePerHour: { def: 500, min: 50, max: 2000, label: '翻訳する文(1人1時間)' },
  clientErrorPerHour: { def: 30, min: 5, max: 100, label: '画面のエラーの記録(1人1時間)' },
  inviteMailPerHour: { def: 3, min: 1, max: 10, label: '本人あての招待リンクのメール(1人1時間)' },
  digestMailReserve: { def: 10, min: 5, max: 50, label: 'まとめて送る分に回すメールの残り' },
  dailyJobStaleHours: { def: 26, min: 25, max: 72, label: '毎日の処理が止まったとみなす時間' },
  hourlyJobStaleHours: { def: 3, min: 2, max: 24, label: '毎時の処理が止まったとみなす時間' },
  personalDataNoticeDays: { def: 7, min: 3, max: 30, label: '個人情報を消す前に知らせる日数' },
  metricsRetryMaxHours: { def: 24, min: 6, max: 72, label: '集計値の送り直しの間隔の上限(時間)' },
  contractRecheckIdleSec: { def: 600, min: 120, max: 1800, label: '書き込みの前にレジストリへ確かめ直す間隔(秒)' },
  announcementsCacheSec: { def: 600, min: 60, max: 3600, label: 'お知らせを覚えておく時間(秒)' },
}

// 保存してある JSON を、知っているキー・範囲の中の整数だけにする(壊れた値は捨てる)
function parseTunableValues_(raw) {
  var obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}') } catch (e) { obj = {} }
  }
  var out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  Object.keys(TUNABLE_RANGES).forEach(function (k) {
    var v = obj[k]
    var r = TUNABLE_RANGES[k]
    if (typeof v === 'number' && isFinite(v) && Math.round(v) === v && v >= r.min && v <= r.max) out[k] = v
  })
  return out
}

function globalTunables_() {
  return parseTunableValues_(registryProps_().TUNABLES)
}

// 団体に伝える値(全団体の値に、団体ごとの値を重ねたもの)
function tunablesFor_(values) {
  var out = globalTunables_()
  var own = parseTunableValues_(values && values.tunables_json)
  Object.keys(own).forEach(function (k) { out[k] = own[k] })
  return out
}

function tunableCatalog_() {
  return Object.keys(TUNABLE_RANGES).map(function (k) {
    var r = TUNABLE_RANGES[k]
    return { key: k, label: r.label, def: r.def, min: r.min, max: r.max }
  })
}

// 管理画面から届いた値を確かめる。{ キー: 数 }(空・null のキーは既定に戻す)。知らないキー・範囲の外は断る
function checkTunableInput_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw registryError_('値の形が正しくありません。')
  var out = {}
  Object.keys(input).forEach(function (k) {
    var r = TUNABLE_RANGES[k]
    if (!r) throw registryError_('知らない項目です: ' + String(k).slice(0, 40))
    var v = input[k]
    if (v === null || v === '' || v === undefined) return
    v = Number(v)
    if (!isFinite(v) || Math.round(v) !== v || v < r.min || v > r.max) throw registryError_(r.label + 'は、' + r.min + '〜' + r.max + 'の整数で入れてください。')
    out[k] = v
  })
  return out
}

// 管理画面: 上限・しきい値を変える。{ session, scope: 'global' | 'org', orgId, values: { キー: 数 }, reason }
// values は、その範囲(全団体・団体)の値をまるごと置き換える(入れなかったキーは既定・全団体の値に戻る)
function setTunables_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  requireAdminReauth_(session, nowMs, '上限・しきい値を変える')
  var values = checkTunableInput_(body.values)
  var reason = cleanText_(body.reason, 500)
  if (!reason) throw registryError_('理由を書いてください(操作の記録に残します)。')
  return withRegistryLock_(function () {
    if (body.scope === 'global') {
      var before = globalTunables_()
      PropertiesService.getScriptProperties().setProperty('TUNABLES', JSON.stringify(values))
      forgetRegistryProps_()
      appendAudit_({ actor: session.sub, action: 'setTunables', target: '(全団体)', before: before, after: values, reason: reason })
      return { ok: true, result: { scope: 'global', values: values } }
    }
    if (!registrySheetHasColumn_('Orgs', 'tunables_json')) throw registryError_('Orgs に tunables_json の列がありません。レジストリのエディタで setupRegistry を実行してください。')
    var row = findOrgRow_(String(body.orgId || ''))
    if (!row) throw registryError_('その団体は見つかりません。')
    var orgId = String(row.values.org_id)
    var beforeOrg = parseTunableValues_(row.values.tunables_json)
    var fields = { tunables_json: Object.keys(values).length ? JSON.stringify(values) : '', updated_at: new Date(nowMs).toISOString() }
    setRowFields_('Orgs', row.row, fields)
    appendAudit_({ actor: session.sub, action: 'setTunables', target: orgId, before: beforeOrg, after: values, reason: reason })
    return { ok: true, result: orgSummary_(merged_(row.values, fields), nowMs) }
  })
}
// 管理画面の KPI(デモの団体を除く): 利用中の団体の数・プラン別の数・直近の週の集計値の合計
function orgKpis_(nowMs) {
  var orgs = readRows_('Orgs').filter(function (r) { return String(r.values.org_id || '') })
  var real = orgs.filter(function (r) { return !isDemoOrg_(r.values) })
  var demoIds = {}
  orgs.forEach(function (r) { if (isDemoOrg_(r.values)) demoIds[String(r.values.org_id)] = true })
  var byPlan = { cosmo_base: 0, ohsumi: 0, paid: 0, '': 0 }
  var active = 0
  real.forEach(function (r) {
    if (orgDisplayState_(r.values, nowMs).state === 'suspended') return
    active++
    var plan = PLANS.indexOf(String(r.values.plan || '')) >= 0 ? String(r.values.plan) : ''
    byPlan[plan]++
  })
  // 定量データ: 団体ごとに一番新しい期間の集計値を足す(デモの団体・デモの時に受け取った集計値は入れない)
  var latest = {}
  readRows_('Usage').forEach(function (r) {
    var id = String(r.values.org_id || '')
    if (!id || demoIds[id] || boolCell_(r.values.demo)) return
    var d = usageDateKey_(r.values.date)
    if (!latest[id] || d > latest[id].date) latest[id] = { date: d, json: String(r.values.metrics_json || '{}') }
  })
  var totals = {}
  var reporting = 0
  var period = ''
  Object.keys(latest).forEach(function (id) {
    var m
    try { m = JSON.parse(latest[id].json) } catch (e) { m = null }
    if (!m) return
    reporting++
    if (latest[id].date > period) period = latest[id].date
    // 平均(_avg)は団体をまたいで足しても意味が無いので、合計に入れない
    METRIC_KEYS.forEach(function (k) { if (typeof m[k] === 'number' && !/_avg$/.test(k)) totals[k] = (totals[k] || 0) + m[k] })
  })
  return { activeOrgs: active, byPlan: byPlan, demoOrgs: Object.keys(demoIds).length, metrics: { reportingOrgs: reporting, latestPeriod: period, totals: totals } }
}

// ---- 団体の GAS の版 ----
//
// 版は日付の形「YYYY.MM.DD-N」(gas/Code.gs の OHSUMI_GAS_VERSION。pnpm gas:version で上げる)。
// 出した版は KNOWN_GAS_VERSIONS に足す(足し忘れると lib/ohsumi/gas-version.test.ts が失敗する)。
// 印(security: 安全の修正 / required: これより古ければ更新が要る)は、管理画面で付け直せる(GasVersions シート。記録を残す)。
// 判定(団体ごと):
//   updateRequired: 印の付いた版(security か required)のうち一番新しいものより古い
//   outdated: 一覧の一番新しい版より古い / latest: それ以外(一覧より新しい版も含む)
//   noCheck: 最後の確認から GAS_CHECK_STALE_HOURS 時間を超えた(または一度も無い。判定の列ではこちらを優先して出す)
// 日付の形でない版(r1e-2 など、PR E より前)は、どの日付の版よりも古いとみなす
var KNOWN_GAS_VERSIONS = [
  { version: '2026.10.05-1', security: false, required: true, note: '公開前の版: 削除の制限・メンバーのメールの必須・定期タスクの月末と取りこぼし・退会の後始末・初期タスクを GAS で作る・カレンダーの予定をタスクの ID で扱う・幹部の取り込み・本人だけの保存と通知の履歴・タスクのゴミ箱・テンプレートの既定値と「初期設定」メニュー・要求分野の初期値。更新したら setupOhsumi を実行する(列とシートを足す)' },
  { version: '2026.10.04-1', security: true, required: false, note: 'Discord・Slack に幹部限定・承認待ちのタスク名や Will の中身を流さない。スキルの点数の付与を GAS で確かめる(完了・担当者・必要スキル・1人1回・上限・自分には付けない)' },
  { version: '2026.10.03-4', security: false, required: false, note: '休止中のメンバーもログイン・操作できる(担当の候補などからは外れる)。ログインを止めるのは退会の時だけ' },
  { version: '2026.10.03-3', security: false, required: false, note: '代表が管理画面から「今すぐバックアップを作る」(前に手で作ってから10分は作れない)' },
  { version: '2026.10.03-2', security: false, required: false, note: 'setupOhsumi で毎日の処理のトリガー(dailyMaintenance)も作る(無いとバックアップなどが動かない)。評価・1on1 などを本人・代表・上長・メンター・プロジェクトの責任者だけに見せる' },
  { version: '2026.10.02-4', security: false, required: false, note: 'スキルのレベルの決め方(点数の一覧・資格・検定・完了したタスクの条件)を団体ごとに設定する(PR Z)' },
  { version: '2026.10.02-3', security: false, required: false, note: '定量データの指標を足す(定義の版 2。コメント・日報・1on1・申請など)(PR Y)' },
  { version: '2026.10.02-2', security: false, required: false, note: '回数の上限・しきい値をレジストリから配り、安全な範囲に収めて使う(PR X)' },
  { version: '2026.10.02-1', security: false, required: false, note: 'レジストリから機能を止めるスイッチ(止めた機能の書き込みを断る。ログイン・読み取りは止めない)(PR W)' },
  { version: '2026.10.01-13', security: false, required: false, note: '代表の管理画面から診断情報を FSIF に送り、受付番号を出す(PR Q)' },
  { version: '2026.10.01-12', security: false, required: false, note: 'FSIF からのお知らせを代表・管理者の管理画面に出す(PR P)' },
  { version: '2026.10.01-11', security: false, required: false, note: 'FSIF からのアンケートを代表の管理画面に出す(PR O)' },
  { version: '2026.10.01-10', security: false, required: false, note: '個人を特定しない集計値を週1回レジストリに送る(PR N)' },
  { version: '2026.10.01-9', security: false, required: false, note: 'マニフェストに使う許可(oauthScopes)を書き、許可が足りない時の知らせ(PR M)' },
  { version: '2026.10.01-8', security: false, required: false, note: '退会者の削除でカレンダーのゲスト・プロフィール画像も消す、実行ログのメールアドレスを伏せる(PR L)' },
  { version: '2026.10.01-7', security: false, required: false, note: '利用の集計とエラーの記録(PR K)' },
  { version: '2026.10.01-6', security: false, required: false, note: '書き込みの競合チェック(行の版と、記録の一覧の差分。PR J)' },
  { version: '2026.10.01-5', security: false, required: false, note: '1つのセルの記録の長さの上限の確認と、読み取り性能の計測の判定(PR I)' },
  { version: '2026.10.01-4', security: false, required: false, note: '毎日・毎時の処理の見張りと、共有の確認(PR H)' },
  { version: '2026.10.01-3', security: false, required: false, note: '退会したメンバー・採用しなかった候補者の個人情報の削除(PR G)' },
  { version: '2026.10.01-2', security: false, required: false, note: '毎日のバックアップと、バックアップから戻す(PR F)' },
  { version: '2026.10.01-1', security: true, required: true,
    note: '通知・タスクの書き換えを GAS が守る修正(PR A)を含む最初の版。メールの上限(PR D)・版の確認(PR E)も含む' },
]
var GAS_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/
var GAS_CHECK_STALE_HOURS = 24
var GAS_VERSIONS_CACHE_KEY = 'registry:gasVersions'
var _gasVersions = null

function gasVersionKey_(v) {
  var m = String(v || '').match(/^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null
}

// a が b より古ければ負、同じなら 0、新しければ正(日付の形でないものは、どれよりも古い)
function compareGasVersions_(a, b) {
  var ka = gasVersionKey_(a)
  var kb = gasVersionKey_(b)
  if (!ka || !kb) return (ka ? 1 : 0) - (kb ? 1 : 0)
  for (var i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
  return 0
}

function boolCell_(v) { return v === true || /^(true|1|yes)$/i.test(String(v || '')) }

// 版の一覧(新しい順)。コードの一覧に、管理画面で付けた印(GasVersions)を重ねる。数分キャッシュに置く
function gasVersionList_() {
  if (_gasVersions) return _gasVersions
  var cache = CacheService.getScriptCache()
  try {
    var raw = cache.get(GAS_VERSIONS_CACHE_KEY)
    if (raw) { _gasVersions = JSON.parse(raw); return _gasVersions }
  } catch (e) { /* 読み直す */ }
  var byVersion = {}
  KNOWN_GAS_VERSIONS.forEach(function (v) {
    byVersion[v.version] = { version: v.version, security: !!v.security, required: !!v.required, note: String(v.note || ''), updatedAt: '', updatedBy: '' }
  })
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('GasVersions')
  if (sheet) {
    readRows_('GasVersions').forEach(function (r) {
      var version = String(r.values.version || '').trim()
      if (!GAS_VERSION_PATTERN.test(version)) return
      byVersion[version] = {
        version: version, security: boolCell_(r.values.security), required: boolCell_(r.values.required),
        note: String(r.values.note || ''), updatedAt: isoOf_(r.values.updated_at), updatedBy: String(r.values.updated_by || ''),
      }
    })
  }
  var list = Object.keys(byVersion).map(function (k) { return byVersion[k] })
  list.sort(function (a, b) { return compareGasVersions_(b.version, a.version) })
  try { cache.put(GAS_VERSIONS_CACHE_KEY, JSON.stringify(list), PROPS_CACHE_SEC) } catch (e) { /* 置けなくても続ける */ }
  _gasVersions = list
  return list
}

function forgetGasVersions_() {
  _gasVersions = null
  try { CacheService.getScriptCache().remove(GAS_VERSIONS_CACHE_KEY) } catch (e) { /* 次の期限で消える */ }
}

// 団体の GAS の版の判定(純粋な関数)
function gasVersionStatus_(values, versions, nowMs) {
  var current = String(values.gas_version || '')
  var latest = versions.length ? versions[0].version : ''
  var minimum = ''
  var security = false
  versions.forEach(function (v) {
    if ((v.security || v.required) && !minimum) minimum = v.version
    if (v.security && compareGasVersions_(current, v.version) < 0) security = true
  })
  var versionState = minimum && compareGasVersions_(current, minimum) < 0 ? 'updateRequired'
    : latest && compareGasVersions_(current, latest) < 0 ? 'outdated' : 'latest'
  var lastCheck = timeOf_(values.last_check_at)
  var noCheck = !(lastCheck > 0) || nowMs - lastCheck > GAS_CHECK_STALE_HOURS * 3600 * 1000
  return {
    current: current, latest: latest, minimum: minimum, security: security, versionState: versionState,
    noCheck: noCheck, judgement: noCheck ? 'noCheck' : versionState,
  }
}

// 監視の毎日のまとめ: 更新が要る団体・24時間以上確認が無い団体の数(利用停止の団体は数えない)
function gasVersionCounts_(nowMs) {
  var versions = gasVersionList_()
  var out = { latest: versions.length ? versions[0].version : '', updateRequired: 0, noCheck: 0, dailyJobStale: 0, orgs: 0 }
  readRows_('Orgs').forEach(function (r) {
    if (!String(r.values.org_id || '') || String(r.values.status || '') !== 'active') return
    var st = gasVersionStatus_(r.values, versions, nowMs)
    // 利用中の団体の数(KPI)には、デモの団体を入れない(版・確認・毎日の処理の数は、動かしている団体として数える)
    if (isDemoOrg_(r.values)) out.demo = (out.demo || 0) + 1
    else out.orgs++
    if (st.versionState === 'updateRequired') out.updateRequired++
    if (st.noCheck) out.noCheck++
    if (orgJobSummary_(r.values, nowMs).dailyStale) out.dailyJobStale++
  })
  return out
}

// 管理画面: 版の印を付け直す。{ session, version, security, required, note, reason }
function setGasVersionMarks_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var version = String(body.version || '').trim()
  if (!GAS_VERSION_PATTERN.test(version)) throw registryError_('版は「YYYY.MM.DD-N」の形で入れてください。')
  var marks = { security: body.security === true, required: body.required === true, note: cleanText_(body.note, 500) }
  var reason = cleanText_(body.reason, 500)
  return withRegistryLock_(function () {
    var before = null
    gasVersionList_().forEach(function (v) { if (v.version === version) before = { security: v.security, required: v.required, note: v.note } })
    var fields = { version: version, security: marks.security, required: marks.required, note: marks.note, updated_at: new Date(nowMs).toISOString(), updated_by: session.sub }
    var found = null
    readRows_('GasVersions').forEach(function (r) { if (String(r.values.version || '').trim() === version) found = r })
    if (found) setRowFields_('GasVersions', found.row, fields)
    else appendRowByHeaders_('GasVersions', fields)
    forgetGasVersions_()
    appendAudit_({ actor: session.sub, action: 'setGasVersionMarks', target: version, before: before, after: marks, reason: reason })
    return { ok: true, result: { versions: gasVersionList_() } }
  })
}

// 管理画面: 団体の担当者(Contacts)に、GAS の更新をお願いするメールを送る。{ session, orgId, reason }
// 同じ団体には、GAS_UPDATE_REQUEST_INTERVAL_HOURS 時間に1回まで
var GAS_UPDATE_REQUEST_INTERVAL_HOURS = 24
function requestGasUpdate_(body, nowMs) {
  var props = registryProps_()
  var session = verifyAdminSession_(body.session, props, nowMs)
  var reason = cleanText_(body.reason, 500)
  var row = findOrgRow_(String(body.orgId || ''))
  if (!row) throw registryError_('その団体は見つかりません。')
  var orgId = String(row.values.org_id)
  var to = contactEmails_()[orgId] || []
  if (!to.length) throw registryError_('この団体の担当者のメールアドレスがありません。')
  var cache = CacheService.getScriptCache()
  var key = 'gasreq:' + orgId
  if (cache.get(key)) throw registryError_('この団体には、' + GAS_UPDATE_REQUEST_INTERVAL_HOURS + '時間以内に更新のお願いを送っています。')
  var st = gasVersionStatus_(row.values, gasVersionList_(), nowMs)
  var text = gasUpdateRequestText_(String(row.values.display_name || orgId), st)
  var m = registryMail_({ to: to, subject: text.subject, body: text.body }, 'other', orgId, nowMs)
  cache.put(key, '1', GAS_UPDATE_REQUEST_INTERVAL_HOURS * 3600)
  appendAudit_({ actor: session.sub, action: 'requestGasUpdate', target: orgId,
    after: { current: st.current, latest: st.latest, minimum: st.minimum, security: st.security, sentTo: to.length }, reason: reason })
  return { ok: true, result: { sentTo: to.length, queued: m.queued } }
}

function gasUpdateRequestText_(name, st) {
  return {
    subject: '[Ohsumi] ' + name + ': 団体の GAS の更新のお願い',
    body: name + ' ご担当者さま\n\n' +
      'Ohsumi の団体の GAS(団体のスプレッドシートの Apps Script)を、新しい版に更新してください。\n\n' +
      '今の版: ' + (st.current || '不明') + '\n' +
      '最新の版: ' + (st.latest || '—') + '\n' +
      (st.minimum && st.versionState === 'updateRequired' ? 'この版より古い GAS は、更新が要ります: ' + st.minimum + '\n' : '') +
      (st.security ? '新しい版には、安全の修正が含まれます。お早めに更新してください。\n' : '') +
      '\n更新の手順:\n' +
      '1. Ohsumi のリポジトリの gas/Code.gs の内容を、Apps Script エディタに貼り替えて保存する\n' +
      '2. 「デプロイ」→「デプロイを管理」→ ウェブアプリの編集(鉛筆)→「バージョン: 新規」で更新する(URL は変わりません)\n' +
      '3. エディタで setupOhsumi を実行する\n\n' +
      '詳しくは gas/README.md の「2. Apps Script のデプロイ」をご覧ください。ご不明な点は FSIF にお問い合わせください。',
  }
}

// checkIn で伝えられた、毎日・毎時の処理が最後に成功した時刻を、Orgs の列の値にする(列が無い・伝えられていない時は null)
function checkInJobFields_(jobs, values) {
  if (!jobs || typeof jobs !== 'object' || !('daily_job_at' in values)) return null
  var iso = function (v) {
    var t = Date.parse(String(v || ''))
    return isFinite(t) && t > 0 ? new Date(t).toISOString() : ''
  }
  return { daily_job_at: iso(jobs.dailyAt), hourly_job_at: iso(jobs.hourlyAt) }
}

// 毎日の処理が止まっているか: 最後に伝えられた成功の時刻から DAILY_JOB_STALE_HOURS 時間を過ぎた
// (伝えられていない団体は判定しない。確認そのものが来ていない団体は、checkState・判定の「24時間以上確認が無い」で分かる)
var DAILY_JOB_STALE_HOURS = 26
function orgJobSummary_(values, nowMs) {
  var dailyAt = isoOf_(values.daily_job_at)
  var hourlyAt = isoOf_(values.hourly_job_at)
  var t = timeOf_(dailyAt)
  return { dailyAt: dailyAt, hourlyAt: hourlyAt, reported: !!dailyAt || !!hourlyAt,
    dailyStale: t > 0 && nowMs - t > DAILY_JOB_STALE_HOURS * 3600 * 1000 }
}

// checkIn で伝えられたメールの上限の状態を、Orgs の列の値にする。
// 列が無い(setupRegistry を実行し直していない)・伝えられていない時は null(書かない)
function checkInMailFields_(mail, values) {
  if (!mail || typeof mail !== 'object' || !('mail_remaining' in values)) return null
  var date = /^\d{4}-\d{2}-\d{2}$/
  var remaining = Number(mail.remaining)
  return {
    mail_remaining: mail.remaining === null || mail.remaining === undefined || !isFinite(remaining) ? '' : Math.max(0, Math.floor(remaining)),
    mail_skipped: Math.max(0, Math.floor(Number(mail.skipped) || 0)),
    mail_date: date.test(String(mail.date || '')) ? String(mail.date) : '',
    mail_limit_date: date.test(String(mail.lastReachedDate || '')) ? String(mail.lastReachedDate) : '',
  }
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
  return parseSiteOrigins_(registryProps_().SITE_ORIGINS)
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
