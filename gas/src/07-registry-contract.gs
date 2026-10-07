// exchangeIdToken: IDトークンをセッショントークンに交換し、初期データもまとめて返す
// ---- レジストリへの登録と、最初の代表(R1-c) -------------------------------------------
//
// 団体のスプレッドシートの「Ohsumi」メニューから行う(エディタの実行ログに、コード・鍵を残さないため)。
//   - 「レジストリに登録する…」: FSIF から受け取った登録コード(または再登録コード)を入力欄に入れる
//     (スクリプトプロパティにもログにも残さない)。レジストリに1回の通信で登録し、共有鍵を受け取って
//     スクリプトプロパティ REGISTRY_SHARED_KEY に保存する(値は表示しない)。
//     代表がまだいなければ、初期設定コードを作り、その場のダイアログにだけ1回表示する
//   - 「初期設定コードを作り直す」: 代表がまだいない時だけ。前のコードは使えなくなる
// 送り直し: 登録の前に乱数 registerNonce(32バイト)を作り、スクリプトプロパティ REGISTRY_PENDING に保存してから送る。
// 通信が途中で失われた時は、同じ registerNonce で最大3回送る。別の時にメニューからやり直した時も、同じ登録コードなら
// 同じ registerNonce を使う(REGISTRY_PENDING には registerNonce とコードの SHA-256 だけを覚え、登録できたら消す)。
// レジストリは、registerNonce が合う時だけ(登録から24時間まで)同じ結果を返す。使用済みの登録コードだけでは、
// 共有鍵を受け取れない
//
// この GAS の URL(レジストリに伝える接続先): スクリプトプロパティ OHSUMI_WEBAPP_URL(無ければ ScriptApp の URL)。
// https://script.google.com/macros/s/…/exec の形だけを使い、/dev・/u/1/・/a/macros/<ドメイン>/・? や # の付いたものは
// 送る前に断る(checkOwnWebAppUrl_)。メニューでは、送る前に登録する URL を表示する
//
// 初期設定コード: 16文字(読み間違えない31種類の文字)。有効期限72時間・1回限り。スクリプトプロパティには
// SHA-256 だけを保存する。最初の代表は、ログイン画面の「初期設定コード」の欄に入れて Google でログインする
// (exchangeIdToken に setupCode を付ける。1回の通信)。間違いが INITIAL_SETUP_FAIL_LIMIT 回続いたら、
// そのコードは使えなくなる(メニューで作り直す)
var REGISTRY_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/
var REGISTER_NONCE_PATTERN = /^[A-Za-z0-9_-]{43,64}$/
var REGISTRY_FETCH_ATTEMPTS = 3
var INITIAL_SETUP_TTL_HOURS = 72
var INITIAL_SETUP_FAIL_LIMIT = 10
var SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
var SETUP_CODE_LENGTH = 16
// レジストリに伝える、この GAS の版(Orgs の gas_version)。日付の形「YYYY.MM.DD-N」。
// このファイルを変えたら pnpm gas:version で上げる(上げ忘れると lib/ohsumi/gas-version.test.ts が失敗する)。
// 出した版は、レジストリの KNOWN_GAS_VERSIONS にも足す
var OHSUMI_GAS_VERSION = '2026.10.07-6'

function sha256HexOf_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2) }).join('')
}

// 入力のゆれ(小文字・区切り・空白)をそろえる
function normalizeOneTimeCode_(input) {
  return String(input || '').toUpperCase().replace(/[\s\-_]/g, '')
}

function oneTimeCodeHash_(input) {
  return 'sha256:' + sha256HexOf_(normalizeOneTimeCode_(input))
}

// 推測できない16文字(偏りが出ないよう、アルファベットの数の倍数を超えるバイトは捨てる)
function generateOneTimeCode_() {
  var n = SETUP_CODE_ALPHABET.length
  var limit = Math.floor(256 / n) * n
  var code = ''
  var round = 0
  while (code.length < SETUP_CODE_LENGTH) {
    var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now()), String(round++)].join(':')
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8).forEach(function (b) {
      var v = b & 0xff
      if (code.length < SETUP_CODE_LENGTH && v < limit) code += SETUP_CODE_ALPHABET.charAt(v % n)
    })
  }
  return code
}

function formatOneTimeCode_(code) {
  return code.match(/.{1,4}/g).join('-')
}

function topRoleRef_() {
  var roles = getRoles_()
  for (var i = 0; i < roles.length; i++) if (roles[i].tier === 'top') return roles[i].id
  return DEFAULT_TOP_ROLE_NAME
}

// 代表(最上位の役職)のメンバーの ID(シートから読む)
function topMemberIds_() {
  var sheet = getSheet_(SHEET_MEMBERS)
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var roleCol = headers.indexOf('role')
  var idCol = headers.indexOf('id')
  if (roleCol < 0 || idCol < 0) return []
  var roles = getRoles_()
  var ids = []
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) && isTopRoleRef_(roles, values[i][roleCol])) ids.push(String(values[i][idCol]))
  }
  return ids
}

// 代表(最上位の役職)のメンバーがいるか
function hasTopMember_() {
  return topMemberIds_().length > 0
}

// 初期設定コードを作る(前のコードは使えなくなる)。元のコードを返す(保存するのは SHA-256 だけ)
function createInitialSetupCode_(nowMs) {
  var code = generateOneTimeCode_()
  var props = PropertiesService.getScriptProperties()
  props.setProperty('INITIAL_SETUP_HASH', oneTimeCodeHash_(code))
  props.setProperty('INITIAL_SETUP_EXPIRES', String(nowMs + INITIAL_SETUP_TTL_HOURS * 3600 * 1000))
  props.deleteProperty('INITIAL_SETUP_FAILS')
  resetRequestProps_()
  return { code: formatOneTimeCode_(code), expiresAt: new Date(nowMs + INITIAL_SETUP_TTL_HOURS * 3600 * 1000).toISOString() }
}

function clearInitialSetupCode_(props) {
  props.deleteProperty('INITIAL_SETUP_HASH')
  props.deleteProperty('INITIAL_SETUP_EXPIRES')
  props.deleteProperty('INITIAL_SETUP_FAILS')
  resetRequestProps_()
}

var INITIAL_SETUP_INVALID = '初期設定コードが正しくないか、使えなくなっています(期限切れ・使用済み)。団体の担当者に、スプレッドシートの「Ohsumi」メニューで作り直してもらってください。'

// 最初の代表を団体に入れる(exchangeIdToken から。Google の IDトークンは確認済み)。メンバーID を返す
function claimInitialSetup_(email, code, nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(10000)
  try {
    var props = PropertiesService.getScriptProperties()
    var hash = props.getProperty('INITIAL_SETUP_HASH') || ''
    var expires = Number(props.getProperty('INITIAL_SETUP_EXPIRES') || 0)
    if (!hash) throw userError_(INITIAL_SETUP_INVALID)
    if (!constantTimeEquals_(hash, oneTimeCodeHash_(code))) {
      var fails = Number(props.getProperty('INITIAL_SETUP_FAILS') || 0) + 1
      if (fails >= INITIAL_SETUP_FAIL_LIMIT) {
        clearInitialSetupCode_(props)
        throw userError_('初期設定コードの間違いが続いたため、このコードは使えなくなりました。団体の担当者に、スプレッドシートの「Ohsumi」メニューで作り直してもらってください。')
      }
      props.setProperty('INITIAL_SETUP_FAILS', String(fails))
      throw userError_(INITIAL_SETUP_INVALID)
    }
    if (!(expires > nowMs)) {
      clearInitialSetupCode_(props)
      throw userError_(INITIAL_SETUP_INVALID)
    }
    // 1回限り: 使う前に消す(代表が既にいる時も使えなくする)
    clearInitialSetupCode_(props)
    if (hasTopMember_()) throw userError_('この団体には既に代表がいます。代表に、メンバーとして追加してもらってください。')
    var added = addMember_(String(email).split('@')[0], email, '', topRoleRef_(), { firstLeader: true })
    // メンバーが増えたので、読み取りのキャッシュ(スナップショット)を作り直させる
    bumpSnapshotVersion_()
    console.log('初期設定コードで、最初の代表を登録しました(メンバーID: ' + added.id + ')')
    return added.id
  } finally {
    lock.releaseLock()
  }
}

// ---- テンプレートから作る団体の既定値 ----
// スプレッドシートを「コピーを作成」しても、スクリプトプロパティはコピーされない。そこで、FSIF の共通の値
// (レジストリの URL・ログインの OAuth クライアント ID)をコードの既定値として持ち、スクリプトプロパティがあればそちらを使う。
// 値はどちらもサイトの画面に入っている公開の値なので、ここに書く(gas/README.md の「2.2.」)。
// setupOhsumi は、プロパティが無ければ既定値をプロパティに保存する(後でコードを貼り替えて既定値が空になっても動くように)
var DEFAULT_REGISTRY_URL = 'https://script.google.com/macros/s/AKfycbx2P-V2NINgmX3oxI-4cgBrCe5vYqjfUzFj9X26TiEZJGBJjOhPYF4kOiaTP8tS3Hm2/exec'
var DEFAULT_GOOGLE_OAUTH_CLIENT_ID = '367437999259-qpqdq6nakl8vmsg9fdociscv1i3m0rk9.apps.googleusercontent.com'

function registryUrlOf_(all) {
  return String((all || {}).REGISTRY_URL || DEFAULT_REGISTRY_URL || '').trim()
}
function registryUrl_() {
  return registryUrlOf_({ REGISTRY_URL: PropertiesService.getScriptProperties().getProperty('REGISTRY_URL') })
}
function googleOAuthClientIdOf_(all) {
  return String((all || {}).GOOGLE_OAUTH_CLIENT_ID || DEFAULT_GOOGLE_OAUTH_CLIENT_ID || '').trim()
}

// プロパティが無い時に、コードの既定値をプロパティに保存する(setupOhsumi から)
function saveCodeDefaultsToProps_(props) {
  var saved = []
  if (!props.getProperty('REGISTRY_URL') && REGISTRY_URL_PATTERN.test(DEFAULT_REGISTRY_URL)) {
    props.setProperty('REGISTRY_URL', DEFAULT_REGISTRY_URL)
    saved.push('REGISTRY_URL')
  }
  if (!props.getProperty('GOOGLE_OAUTH_CLIENT_ID') && /\.apps\.googleusercontent\.com$/.test(DEFAULT_GOOGLE_OAUTH_CLIENT_ID)) {
    props.setProperty('GOOGLE_OAUTH_CLIENT_ID', DEFAULT_GOOGLE_OAUTH_CLIENT_ID)
    saved.push('GOOGLE_OAUTH_CLIENT_ID')
  }
  return saved
}

// この GAS のウェブアプリの URL(レジストリに伝える接続先)。
//   1. スクリプトプロパティ OHSUMI_WEBAPP_URL
//   2. ScriptApp.getService().getUrl() が …/exec の形なら、それ
//   3. ウェブアプリの URL をブラウザで開いた時に覚えた URL(DETECTED_WEBAPP_URL。doGet が覚える)
// メニュー・エディタから実行すると、getService().getUrl() は /dev(エディタで試すための URL)を返すことがある
function ownWebAppUrl_(all) {
  all = all || {}
  var url = String(all.OHSUMI_WEBAPP_URL || '').trim()
  if (url) return url
  var live = ''
  try { live = String(ScriptApp.getService().getUrl() || '') } catch (e) { live = '' }
  if (REGISTRY_URL_PATTERN.test(live)) return live
  var seen = String(all.DETECTED_WEBAPP_URL || '').trim()
  if (REGISTRY_URL_PATTERN.test(seen)) return seen
  return live
}

// ウェブアプリとして開かれた時(doGet)に、その URL を覚える(…/exec の形の時だけ)
function rememberWebAppUrl_() {
  try {
    var url = String(ScriptApp.getService().getUrl() || '')
    if (!REGISTRY_URL_PATTERN.test(url)) return
    if (requestProps_().DETECTED_WEBAPP_URL === url) return
    setRequestProp_('DETECTED_WEBAPP_URL', url)
  } catch (e) { /* 覚えられなくても、GET の応答は返す */ }
}

// レジストリに伝えてよい URL か。問題があれば、直し方の文を返す(無ければ '')
function checkOwnWebAppUrl_(url) {
  var how = 'デプロイの画面(デプロイ → デプロイを管理)に出るウェブアプリの URL(https://script.google.com/macros/s/…/exec)を' +
    'ブラウザで一度開いてから、もう一度試してください(開くと、この GAS がその URL を覚えます)。' +
    'うまくいかない時は、その URL をスクリプトプロパティ OHSUMI_WEBAPP_URL に入れてください。'
  url = String(url || '')
  if (!url) return 'この GAS のウェブアプリの URL が分かりません。先にウェブアプリとしてデプロイし、' + how
  if (REGISTRY_URL_PATTERN.test(url)) return ''
  var what = 'この GAS の URL(' + url + ')は、レジストリに登録できない形です'
  if (/\/dev(?:[?#].*)?$/.test(url)) what += '(/dev はエディタで試すための URL で、編集者しか使えません)'
  else if (/\/u\/\d+\//.test(url)) what += '(/u/1/ などは、複数の Google アカウントでログインしたブラウザのアドレスバーの形です)'
  else if (/\/a\/macros\//.test(url)) what += '(/a/macros/<ドメイン>/ は、Google Workspace のドメインの中だけの形です)'
  else if (/[?#]/.test(url)) what += '(? や # の後ろは付けません)'
  return what + '。' + how
}

// レジストリに登録する(メニューから。テストでは fetch を差し替える)。
// 返り値: { displayName, keyGen, kind, setupCode?, setupExpiresAt? }(共有鍵は返さない)
function registerWithRegistry_(code, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var now = deps.now || Date.now
  if (!normalizeOneTimeCode_(code)) throw userError_('登録コードを入れてください。')
  ensureSessionSecrets_()
  var props = PropertiesService.getScriptProperties()
  var all = props.getProperties() || {}
  var registryUrl = registryUrlOf_(all)
  if (!REGISTRY_URL_PATTERN.test(registryUrl)) {
    throw userError_('スクリプトプロパティ REGISTRY_URL に、FSIF から伝えられたレジストリの URL(https://script.google.com/macros/s/…/exec)を入れてください。')
  }
  var gasUrl = ownWebAppUrl_(all)
  var urlProblem = checkOwnWebAppUrl_(gasUrl)
  if (urlProblem) throw userError_(urlProblem)
  // 同じ登録コードでやり直す時は、同じ registerNonce を使う(レジストリが送り直しと分かるように)。
  // 送る前に保存する(応答が失われても、次に同じ値で送れるように)
  var codeHash = oneTimeCodeHash_(code)
  var pending = {}
  try { pending = JSON.parse(all.REGISTRY_PENDING || '{}') || {} } catch (e) { pending = {} }
  if (pending.codeHash !== codeHash || !REGISTER_NONCE_PATTERN.test(String(pending.registerNonce || ''))) {
    pending = { registerNonce: generateSecret_(), codeHash: codeHash }
    props.setProperty('REGISTRY_PENDING', JSON.stringify(pending))
  }
  var payload = JSON.stringify({
    action: 'registerOrg',
    code: normalizeOneTimeCode_(code),
    orgId: props.getProperty('ORG_ID'),
    gasUrl: gasUrl,
    gasVersion: OHSUMI_GAS_VERSION,
    registerNonce: pending.registerNonce,
  })
  var res = null
  var lastProblem = ''
  for (var attempt = 1; attempt <= REGISTRY_FETCH_ATTEMPTS && !res; attempt++) {
    try {
      var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
      var json = JSON.parse(r.getContentText())
      if (json && json.retryLater) { lastProblem = String(json.error || '混み合っています'); continue }
      if (json && json.getReceived) { lastProblem = 'レジストリに GET で届きました'; continue }
      res = json
    } catch (e) {
      lastProblem = '通信エラー・JSON ではない応答'
    }
  }
  if (!res) throw userError_('レジストリから応答を受け取れませんでした(' + lastProblem + ')。少し待ってから、同じ登録コードでもう一度お試しください(二重には登録されません)。')
  if (!res.ok || !res.result || !res.result.registryKey) {
    throw userError_(String(res.error || 'レジストリに登録できませんでした。'))
  }
  var out = res.result
  props.setProperty('REGISTRY_SHARED_KEY', String(out.registryKey))
  props.setProperty('REGISTRY_KEY_GEN', String(out.keyGen || ''))
  props.setProperty('REGISTRY_REGISTERED_AT', String(out.registeredAt || ''))
  props.deleteProperty('REGISTRY_PENDING')
  resetRequestProps_()
  // ログには共有鍵もコードも出さない
  console.log('レジストリに' + (out.kind === 'reissue' ? '再登録' : '登録') + 'しました(団体名: ' + out.displayName + '・鍵の世代: ' + out.keyGen + (res.replayed ? '・送り直しに対する前回の結果' : '') + ')')
  var result = { displayName: String(out.displayName || ''), keyGen: out.keyGen, kind: out.kind }
  if (!hasTopMember_()) {
    var setup = createInitialSetupCode_(now())
    result.setupCode = setup.code
    result.setupExpiresAt = setup.expiresAt
  }
  return result
}

function formatJaDateTime_(iso) {
  return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm')
}

function setupCodeMessage_(setupCode, expiresAt) {
  return '最初の代表の「初期設定コード」(この画面でだけ表示します。控えて、最初の代表に伝えてください):\n\n' +
    setupCode + '\n\n有効期限: ' + formatJaDateTime_(expiresAt) + '(72時間・1回限り)\n' +
    '最初の代表は、Ohsumi のログイン画面の「初期設定コード」の欄にこのコードを入れてから、Google でログインします。'
}

// ---- 提供停止・機能停止(R1-e) ---------------------------------------------------------
//
// 停止には2種類ある。どちらも FSIF がレジストリの管理画面で予定を入れる(14日より後)。
//   suspend(提供停止): この GAS は、ログインの設定(getLoginConfig)以外のすべての操作を断り(orgSuspended)、
//                      通知(sendBatchNotifications)・毎朝の処理(dailyMaintenance)も止める。データは消さない
//   restrict(機能停止): 読み取り(閲覧・書き出し)とログインだけを受け付け、作成・編集は断る(restricted)。
//                      通知・毎朝の処理は止めない。画面の上部に、アンケートへの回答のお願いを出す
// 状態は、1時間ごとのトリガー(checkContractStatus)でレジストリの checkIn に確かめ、スクリプトプロパティ
// CONTRACT_STATE に覚える。リクエストの時にも確かめ直す(currentContract_):
//   - 停止中(予定の日時を過ぎた時も)は、解除がすぐ効くように、どの操作でも1分に1回まで
//   - 停止の予定がある時は、書き込み(読み取りの一覧に無い操作)の前に1分に1回まで
//   - 停止の予定が無い時も、書き込みの前に10分に1回まで(レジストリで停止した後、書き込みを受け付け続けないように)
// レジストリに確かめられない時は、最後に確かめた状態のまま使い続ける(最後に届いた停止の予定の日時は守る)。
// 機能停止中は、READ_ONLY_ACTIONS(読み取り・ログイン)に無い操作をすべて断る。batch は、中の操作に関わらず断る。
// 画面の停止の表示は、この GAS が応答に付けた contract だけで決まる(画面は自分で停止を判断しない)。
// checkIn は、共有鍵(REGISTRY_SHARED_KEY)で 'checkIn.<団体ID>.<時刻(秒)>' に付けた HMAC-SHA256 の署名で確かめる。
// 停止の予定があれば、14日前・7日前・1日前に代表へメールで知らせる(送った予告は CONTRACT_NOTICES_SENT に覚える)。
// 応答には、画面が表示に使う contract({ phase, kind, suspendAt })を付ける
var CONTRACT_NOTICE_DAYS = [14, 7, 1]
var CONTRACT_RECHECK_SEC = 60
var CONTRACT_RECHECK_IDLE_SEC = 600
var CONTRACT_SUSPENDED_MESSAGE = 'この団体は、Ohsumi の利用を停止しています。'
var CONTRACT_RESTRICTED_MESSAGE = 'アンケートへの回答をお願いします。回答が確認でき次第、再開します。'
// 機能停止中にも受け付ける操作(読み取りの一覧)。ここに無い操作は、すべて断る(新しく足した操作も、ここに足さない限り断る)。
// 読み取り・ログイン(初期設定コードで代表を入れる時を除く)・ログインの記録・自分や管理者によるログインの無効化だけを入れる
var READ_ONLY_ACTIONS = [
  'exchangeIdToken', 'getInitialData', 'getBackgroundData', 'getMyEmails', 'getMyStorage', 'getExpenses', 'getFiles',
  // 団体の保存を読む・移した古いタスクを探す(読み取りだけ)
  'getOrgStorage', 'searchArchivedTasks',
  'getWebhookStatus', 'getCandidates', 'getFormSubmissions', 'fetchDailyReports', 'translateText',
  'revokeMySessions', 'revokeMemberSessions', 'updateLastLogin',
  // ほかの端末で開く: 本人あての招待リンクのメール(データを書き換えない)
  'getInviteMailStatus', 'sendInviteLinkToMe',
  // メールの1日の上限の状態・この GAS の版の更新(代表の管理画面に出す)
  'getMailQuotaStatus', 'getGasUpdateStatus',
  // バックアップの状態・一覧・戻す前の確かめ(戻すのは書き込みなので、機能停止中は断る)
  'getBackupStatus', 'listBackups', 'previewRestore', 'searchBackupTasks',
  // 今すぐバックアップを作る(シートは書き換えない。Drive にコピーを作り、スクリプトプロパティに記録するだけ)
  'createBackupNow',
  // 個人情報の削除の予定(消す・延ばすのは書き込み)
  'getPersonalDataStatus',
  // 毎日・毎時の処理と共有の状態・長くなっている記録(読み取りだけ)
  'getOpsStatus',
  // 利用の集計とエラーの件数(代表の管理画面に出す。読み取りだけ)
  'getUsageStatus',
  // FSIF に送る集計値の状態・プレビュー・送信の履歴(読み取りだけ)
  'getMetricsStatus',
  // FSIF からのお知らせ(レジストリから取る。読み取りだけ)
  'getAnnouncements',
  // 診断情報の表示・送信(団体のシートは書き換えない。機能停止中も FSIF に問い合わせられるように)
  'getDiagnostics', 'sendDiagnostics',
]

// 機能停止中にも受け付ける操作か(初期設定コードで代表を入れるログインは、メンバーを足すので断る)
function readOnlyAllows_(body) {
  if (READ_ONLY_ACTIONS.indexOf(body.action) < 0) return false
  if (body.action === 'exchangeIdToken' && body.setupCode) return false
  return true
}

// ---- 機能のスイッチ(レジストリから団体の機能を止める) ----------------------------
//
// 不具合が見つかった時に、この GAS を更新し直す前に、その機能だけを止められるようにする。
// レジストリの checkIn が disabledFeatures(止める機能の ID の一覧。全団体の分と、その団体の分を合わせたもの)を返し、
// CONTRACT_STATE に覚える。書き込みの前の確かめ直し(10分に1回まで)で伝わるので、止めてから効くまで最大10分ほど。
// 知らない ID は無視する(レジストリの一覧の方が新しい時)。止めた操作は featureDisabled を付けて断る。
// ログイン・読み取り(READ_ONLY_ACTIONS)と、ログインの前の操作は、ここに入れない(止められない。テストで確かめる)。
// ID は、レジストリの FEATURE_IDS と同じにする(テストで確かめる)
//   actions: 止める操作
//   inside: 操作ではなく、処理の中で止めるもの(毎日の処理・通知の途中。画面には失敗を返さない)
var FEATURE_SWITCHES = {
  uploads: { label: 'ファイルのアップロード', actions: ['uploadAvatar', 'uploadOrgLogo', 'uploadExpenseReceipt', 'uploadSurveyImage'] },
  expenses: { label: '経費の申請・承認', actions: ['submitExpenseApplication', 'approveExpenseStep', 'rejectExpense', 'withdrawExpense', 'returnExpense', 'resubmitExpense', 'uploadExpenseReceipt'] },
  forms: { label: 'フォーム・アンケートの回答と承認', actions: ['updateTaskForm', 'notifyFormResult', 'submitCustomForm', 'approveFormStep', 'rejectFormSubmission'] },
  schedule: { label: '日程調整', actions: ['updateTaskSchedule', 'notifyScheduleResult'] },
  dailyReports: { label: '日報の提出', actions: ['submitDailyReport'] },
  recruiting: { label: '採用の候補者', actions: ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember'] },
  skills: { label: 'スキル・ポイント・クイズ', actions: ['awardSkillPoints', 'importPortableRecord', 'submitQuizResult', 'bulkUpdateSkills', 'updateSkillLevels', 'approveSkillLevel'] },
  projectHealth: { label: 'プロジェクトの健康状態', actions: ['updateProjectHealth', 'notifyProjectHealth', 'reportProjectHealth', 'updateProjectHealthRecord'] },
  training: { label: '研修の申請', actions: ['updateTrainingHistory', 'notifyTrainingRequest', 'notifyTrainingDecision'] },
  memberSurvey: { label: 'メンバーのアンケートの回答', actions: ['submitSurveyResponse'] },
  restore: { label: 'バックアップから戻す', actions: ['restoreBackup', 'restoreTasks'] },
  personalData: { label: '個人情報の削除の操作', actions: ['setPersonalDataRetention', 'purgePersonalDataNow', 'extendPersonalData', 'cancelWithdrawal', 'deleteOrphanEmails'] },
  webhookSettings: { label: 'Discord・Slack の設定と接続テスト', actions: ['updateDiscordWebhookUrl', 'updateSlackWebhookUrl', 'testDiscordWebhook', 'testSlackWebhook'] },
  chatNotify: { label: 'Discord・Slack への通知', inside: true },
  calendarSync: { label: 'Google カレンダーへの登録', inside: true },
  recurringTasks: { label: '定期タスクの作成', inside: true },
  metricsSend: { label: 'FSIF への集計値の送信', inside: true },
}
var FEATURE_DISABLED_MESSAGE = 'この機能は、不具合の確認のため FSIF が一時的に止めています。再開までお待ちください(閲覧はできます)。'

// レジストリから届いた一覧を、知っている ID だけにする
function parseDisabledFeatures_(list) {
  if (!Array.isArray(list)) return []
  var out = []
  list.forEach(function (x) {
    var id = String(x)
    if (Object.prototype.hasOwnProperty.call(FEATURE_SWITCHES, id) && out.indexOf(id) < 0) out.push(id)
  })
  return out
}

// 今止めている機能の ID(CONTRACT_STATE。このリクエストの中では、1回読んだスクリプトプロパティを使う)
function disabledFeatures_() {
  var state = null
  try { state = JSON.parse(requestProps_().CONTRACT_STATE || 'null') } catch (e) { state = null }
  return parseDisabledFeatures_(state && state.disabledFeatures)
}

function featureDisabled_(id) {
  return disabledFeatures_().indexOf(id) >= 0
}

// その操作を止めている機能(無ければ '')
function disabledFeatureOfAction_(action) {
  var ids = disabledFeatures_()
  for (var i = 0; i < ids.length; i++) {
    var f = FEATURE_SWITCHES[ids[i]]
    if (f.actions && f.actions.indexOf(action) >= 0) return ids[i]
  }
  return ''
}

// 止めている操作なら、featureDisabled を付けたエラーを投げる
function assertFeatureEnabled_(action) {
  var id = disabledFeatureOfAction_(action)
  if (!id) return
  var e = userError_(FEATURE_SWITCHES[id].label + ': ' + FEATURE_DISABLED_MESSAGE)
  e.featureDisabled = id
  throw e
}

// 代表の管理画面に出す一覧
function disabledFeaturesForClient_() {
  return disabledFeatures_().map(function (id) { return { id: id, label: FEATURE_SWITCHES[id].label } })
}

// ---- 上限・しきい値(レジストリから配る。PR X) --------------------------------------
//
// 回数の上限・しきい値を、この GAS を更新し直さずに変えられるようにする。レジストリの checkIn が tunables
// ({ キー: 数 })を返し、CONTRACT_STATE に覚える。値は、ここに書いた安全な範囲(min〜max)に必ず収める
// (レジストリが範囲の外の値を送っても、範囲の端の値を使う)。届いていないキー・数でない値は、既定の値(def)を使う。
// キーと範囲は、レジストリの TUNABLE_RANGES と同じにする(テストで確かめる)
var TUNABLES = {
  // 1人1時間の回数の上限(RATE_LIMITS)
  notifyPerHour: { def: 60, min: 10, max: 300, label: '通知(1人1時間)' },
  mentionPerHour: { def: 30, min: 5, max: 100, label: 'メンションの通知の宛先(1人1時間)' },
  resultNotifyPerHour: { def: 10, min: 3, max: 50, label: '結果の通知(1人1時間)' },
  translatePerHour: { def: 500, min: 50, max: 2000, label: '翻訳する文(1人1時間)' },
  clientErrorPerHour: { def: 30, min: 5, max: 100, label: '画面のエラーの記録(1人1時間)' },
  inviteMailPerHour: { def: 3, min: 1, max: 10, label: '本人あての招待リンクのメール(1人1時間)' },
  // メールの1日の残りがこの数以下になったら、急ぎでない通知をまとめて送る分に回す
  digestMailReserve: { def: 10, min: 5, max: 50, label: 'まとめて送る分に回すメールの残り' },
  // 毎日・毎時の処理が止まったとみなす時間
  dailyJobStaleHours: { def: 26, min: 25, max: 72, label: '毎日の処理が止まったとみなす時間' },
  hourlyJobStaleHours: { def: 3, min: 2, max: 24, label: '毎時の処理が止まったとみなす時間' },
  // 個人情報を消す何日前から、代表の管理画面に出すか
  personalDataNoticeDays: { def: 7, min: 3, max: 30, label: '個人情報を消す前に知らせる日数' },
  // 集計値を送れなかった時の、送り直しの間隔の上限(時間)
  metricsRetryMaxHours: { def: 24, min: 6, max: 72, label: '集計値の送り直しの間隔の上限(時間)' },
  // 停止の予定が無い時に、書き込みの前にレジストリへ確かめ直す間隔(秒)。止めてから効くまでの時間にもなる
  contractRecheckIdleSec: { def: 600, min: 120, max: 1800, label: '書き込みの前にレジストリへ確かめ直す間隔(秒)' },
  // FSIF からのお知らせを覚えておく時間(秒)
  announcementsCacheSec: { def: 600, min: 60, max: 3600, label: 'お知らせを覚えておく時間(秒)' },
  // 完了してからこの日数がたったタスクを、毎日の処理で TasksArchive に移す
  taskArchiveDays: { def: 365, min: 90, max: 3650, label: '完了したタスクを移すまでの日数' },
}
var _tunablesFrom = null
var _tunablesValue = null

// 届いた値を、安全な範囲の整数にする(届いていない・数でない値は null)
function clampTunable_(key, v) {
  var t = TUNABLES[key]
  if (!t || typeof v !== 'number' || !isFinite(v)) return null
  return Math.min(t.max, Math.max(t.min, Math.round(v)))
}

// レジストリから届いた値(範囲に収めたもの。届いていないキーは入れない)
function parseTunables_(given) {
  var out = {}
  if (!given || typeof given !== 'object' || Array.isArray(given)) return out
  Object.keys(TUNABLES).forEach(function (key) {
    var v = clampTunable_(key, given[key])
    if (v !== null) out[key] = v
  })
  return out
}

function receivedTunables_() {
  var raw = requestProps_().CONTRACT_STATE || ''
  if (_tunablesValue && _tunablesFrom === raw) return _tunablesValue
  var state = null
  try { state = JSON.parse(raw || 'null') } catch (e) { state = null }
  _tunablesValue = parseTunables_(state && state.tunables)
  _tunablesFrom = raw
  return _tunablesValue
}

// 今使う値。fallback を渡すと、届いていない時は def の代わりに使う(RATE_LIMITS の値など)
function tunable_(key, fallback) {
  var got = receivedTunables_()
  if (Object.prototype.hasOwnProperty.call(got, key)) return got[key]
  return fallback !== undefined ? fallback : TUNABLES[key].def
}

// 診断情報に入れる、既定と違う値の一覧
function tunablesForClient_() {
  var got = receivedTunables_()
  return Object.keys(got).filter(function (k) { return got[k] !== TUNABLES[k].def }).map(function (k) {
    return { key: k, label: TUNABLES[k].label, value: got[k], def: TUNABLES[k].def }
  })
}

function readContractState_() {
  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty('CONTRACT_STATE') || 'null')
    return state && typeof state === 'object' ? state : null
  } catch (e) {
    return null
  }
}

// 今の状態(Google のサービスを使わない純粋な関数)。予定の日時を過ぎていれば、確かめ直す前でも停止中とする
function effectiveContract_(state, nowMs) {
  if (!state) return { phase: 'none', kind: '', suspendAt: '' }
  var kind = state.kind === 'restrict' ? 'restrict' : 'suspend'
  var at = Date.parse(String(state.suspendAt || ''))
  var suspendAt = at > 0 ? new Date(at).toISOString() : ''
  if (state.phase === 'inEffect') return { phase: 'inEffect', kind: kind, suspendAt: suspendAt }
  if (state.phase === 'scheduled' && at > 0) return { phase: at <= nowMs ? 'inEffect' : 'scheduled', kind: kind, suspendAt: suspendAt }
  return { phase: 'none', kind: '', suspendAt: '' }
}

// ---- この GAS の版の更新 ----------------------------------------------------------
//
// レジストリは checkIn の返事で、この GAS の版の判定を返す(gasUpdate: { required, outdated, latest, minimum, security })。
// CONTRACT_STATE に覚え、代表・全権管理者の管理画面に出す(getGasUpdateStatus)。更新が要る時は、代表にメールで知らせる
// (1時間ごとの checkContractStatus から。最新の版ごとに1回だけ。GAS_UPDATE_NOTIFIED に覚える)
var GAS_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/

function parseGasUpdate_(v) {
  if (!v || typeof v !== 'object') return null
  var version = function (x) { return GAS_VERSION_PATTERN.test(String(x || '')) ? String(x) : '' }
  // judgedVersion: 判定した時のこの GAS の版(貼り替えた後は、次の確認まで古い判定を出さない)
  return { required: v.required === true, outdated: v.outdated === true, latest: version(v.latest), minimum: version(v.minimum), security: v.security === true,
    judgedVersion: OHSUMI_GAS_VERSION }
}

// ---- FSIF からのアンケート ----------------------------------------------------------
//
// レジストリは checkIn の返事で、回答待ちのアンケートを返す(surveys: [{ surveyId, title, formUrl, sendDate, dueDate, overdue, restrictAt }])。
// CONTRACT_STATE に覚え、代表の管理画面に出す(getOpsStatus)。回答の確認は FSIF が行い、回答済みになると次の確認で消える
var SURVEY_FORM_URL_PATTERN = /^https:\/\/(docs\.google\.com\/forms\/[A-Za-z0-9_\-\/.?=&%]+|forms\.gle\/[A-Za-z0-9_-]+)$/

var SURVEYS_KEEP_MAX = 5

function parseSurveys_(list) {
  if (!Array.isArray(list)) return []
  var day = /^\d{4}-\d{2}-\d{2}$/
  // CONTRACT_STATE(スクリプトプロパティ。1つの値は9KBまで)に入るよう、5件・URL 300文字までにする
  return list.filter(function (v) {
    var url = String((v && v.formUrl) || '')
    return v && typeof v === 'object' && url.length <= 300 && SURVEY_FORM_URL_PATTERN.test(url) && day.test(String(v.dueDate || ''))
  }).slice(0, SURVEYS_KEEP_MAX).map(function (v) {
    var restrictAt = String(v.restrictAt || '')
    return {
      surveyId: String(v.surveyId || '').slice(0, 40),
      title: String(v.title || '').slice(0, 100),
      formUrl: String(v.formUrl),
      sendDate: day.test(String(v.sendDate || '')) ? String(v.sendDate) : '',
      dueDate: String(v.dueDate),
      overdue: v.overdue === true,
      restrictAt: isNaN(Date.parse(restrictAt)) ? '' : new Date(restrictAt).toISOString(),
    }
  })
}

function surveysStatus_() {
  var state = readContractState_()
  return (state && Array.isArray(state.surveys)) ? state.surveys : []
}

// ---- FSIF からのお知らせ(PR P) ----------------------------------------------------------
//
// 代表・管理者が管理画面を開いた時(getAnnouncements)に、レジストリへ共有鍵の署名で取りに行く(fetchAnnouncements)。
// 取れたものは10分覚え(CacheService)、レジストリに届かない時は、最後に取れたもの(6時間まで)を出す。
// 重要度は normal(通常)/ important(重要)/ urgent(緊急)。既読は画面(端末ごと)で覚える
var ANNOUNCEMENTS_CACHE_SEC = 600
var ANNOUNCEMENTS_LAST_SEC = 6 * 3600
var ANNOUNCEMENT_IMPORTANCE = ['normal', 'important', 'urgent']

function parseAnnouncements_(list) {
  if (!Array.isArray(list)) return []
  return list.filter(function (v) {
    return v && typeof v === 'object' && String(v.announcementId || '') && String(v.title || '')
  }).slice(0, 20).map(function (v) {
    var iso = function (x) { var t = Date.parse(String(x || '')); return isNaN(t) ? '' : new Date(t).toISOString() }
    return {
      announcementId: String(v.announcementId).slice(0, 40),
      title: String(v.title).slice(0, 100),
      body: String(v.body || '').slice(0, 1000),
      importance: ANNOUNCEMENT_IMPORTANCE.indexOf(String(v.importance)) >= 0 ? String(v.importance) : 'normal',
      publishedAt: iso(v.publishedAt),
      expiresAt: iso(v.expiresAt),
    }
  })
}

// 返事: { registered: レジストリに登録しているか, announcements, fetchedAt, stale: レジストリに届かず、最後に取れたものを出しているか }
function announcementsStatus_(nowMs, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = registryUrl_()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) return { registered: false, announcements: [], fetchedAt: '', stale: false }
  var cache = CacheService.getScriptCache()
  var cached = null
  try { cached = JSON.parse(cache.get('announcements:v1') || 'null') } catch (e) { cached = null }
  if (cached && Array.isArray(cached.announcements)) return { registered: true, announcements: cached.announcements, fetchedAt: String(cached.fetchedAt || ''), stale: false }
  try {
    var ts = Math.floor(nowMs / 1000)
    var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('announcements.' + orgId + '.' + ts, key))
    var payload = JSON.stringify({ action: 'fetchAnnouncements', orgId: orgId, ts: ts, sig: sig })
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
    var res = JSON.parse(r.getContentText())
    if (!res || !res.ok || !res.result) throw new Error(String((res && res.error) || '応答の形が違います'))
    var fresh = { announcements: parseAnnouncements_(res.result.announcements), fetchedAt: new Date(nowMs).toISOString() }
    var text = JSON.stringify(fresh)
    try {
      cache.put('announcements:v1', text, tunable_('announcementsCacheSec', ANNOUNCEMENTS_CACHE_SEC))
      cache.put('announcements:last', text, ANNOUNCEMENTS_LAST_SEC)
    } catch (e) { /* 覚えられなくても、今回は出せる */ }
    return { registered: true, announcements: fresh.announcements, fetchedAt: fresh.fetchedAt, stale: false }
  } catch (e) {
    console.warn('FSIF からのお知らせを取れませんでした: ' + maskEmailsIn_(String((e && e.message) || e)))
    var last = null
    try { last = JSON.parse(cache.get('announcements:last') || 'null') } catch (e2) { last = null }
    if (last && Array.isArray(last.announcements)) return { registered: true, announcements: last.announcements, fetchedAt: String(last.fetchedAt || ''), stale: true }
    return { registered: true, announcements: [], fetchedAt: '', stale: true }
  }
}

// 緊急のお知らせを、代表にメールで1回だけ送る(1時間ごとの checkContractStatus から)。
// checkIn で受け取った ID のうち、まだ送っていないものの本文をレジストリから取り(fetchAnnouncements)、1件ずつ送る。
// 送った ID はスクリプトプロパティ URGENT_ANNOUNCEMENTS_MAILED に残す(直近50件)。メールの上限で送れなかった時は、次の確認で送り直す。
// 送った ID を返す
var URGENT_MAILED_KEEP = 50

function sendUrgentAnnouncementMails_(state, deps) {
  var ids = (state && Array.isArray(state.urgentAnnouncementIds)) ? state.urgentAnnouncementIds : []
  if (!ids.length) return []
  var props = PropertiesService.getScriptProperties()
  var mailed = []
  try { mailed = JSON.parse(props.getProperty('URGENT_ANNOUNCEMENTS_MAILED') || '[]') } catch (e) { mailed = [] }
  if (!Array.isArray(mailed)) mailed = []
  var pending = ids.filter(function (id) { return mailed.indexOf(id) < 0 })
  if (!pending.length) return []
  // 覚えている一覧(10分)に無い新しいものがあれば、取り直す
  var cache = CacheService.getScriptCache()
  var list = announcementsStatus_(Date.now(), deps).announcements
  if (pending.some(function (id) { return !list.some(function (a) { return a.announcementId === id }) })) {
    try { cache.remove('announcements:v1') } catch (e) { /* 取り直せなくても、あるものは送る */ }
    list = announcementsStatus_(Date.now(), deps).announcements
  }
  var emails = getAllMemberEmails_()
  var to = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  if (!to.length) {
    console.warn('緊急のお知らせを知らせる代表のメールアドレスがありません')
    return []
  }
  var orgName = getSettingValue_('org_name') || 'Ohsumi'
  var sent = []
  pending.forEach(function (id) {
    var a = list.filter(function (x) { return x.announcementId === id && x.importance === 'urgent' })[0]
    if (!a) return
    var ok = sendMail_({
      to: to.join(','),
      subject: '[Ohsumi] ' + orgName + ': FSIF からの緊急のお知らせ「' + a.title + '」',
      body: orgName + ' 代表の方へ\n\nFSIF から緊急のお知らせがあります。\n\n' + a.title + '\n\n' + a.body +
        '\n\n(Ohsumi の管理画面の上部にも出しています。このメールは、お知らせごとに1回だけ送ります)',
    })
    if (ok) { mailed.push(id); sent.push(id) }
  })
  if (sent.length) props.setProperty('URGENT_ANNOUNCEMENTS_MAILED', JSON.stringify(mailed.slice(-URGENT_MAILED_KEEP)))
  return sent
}

// ---- レジストリに頼まれて送るメール(アンケートの送付・リマインド・28日目の機能停止の知らせ・停止の予告) ----
//
// 団体あてのメールは、レジストリの代わりに、この団体の Gmail で送る(レジストリのメールの1日の上限に数えないため)。
// checkIn の返事の mailTasks を、担当者(レジストリの Contacts)と代表に送り、送った key をスクリプトプロパティ
// REGISTRY_MAIL_TASKS_SENT に残す(直近の分)。次の checkIn で mailDone として伝え、レジストリが記録する(二重に送らない)。
// メールの1日の上限で送れなかった時は送ったことにせず、次の1時間ごとの確認で送り直す。
// 1時間ごとの checkContractStatus で、ほかのメール(更新の知らせ・緊急のお知らせ)より先に送る。まとめのメール
// (digestMailReserve の分を残して止まる)とは違い、残りを最後まで使える
var REGISTRY_MAIL_SENT_KEEP = 100
var REGISTRY_MAIL_DONE_REPORT = 30
var REGISTRY_MAIL_KEY_PATTERN = /^(sv|sn|sr)\.[A-Za-z0-9_]{1,40}\.\d{1,14}$/

function parseRegistryMailTasks_(list) {
  if (!Array.isArray(list)) return null
  return list.slice(0, 10).map(function (t) {
    if (!t || typeof t !== 'object') return null
    var key = String(t.key || '')
    if (!REGISTRY_MAIL_KEY_PATTERN.test(key)) return null
    var to = (Array.isArray(t.to) ? t.to : []).map(function (e) { return String(e).trim() })
      .filter(function (e) { return /^[^@\s,]+@[^@\s,]+$/.test(e) }).slice(0, 10)
    return { key: key, to: to, subject: String(t.subject || '').slice(0, 300), body: String(t.body || '').slice(0, 5000) }
  }).filter(function (t) { return t && t.subject && t.body })
}

function registryMailTasksSent_() {
  var list = []
  try { list = JSON.parse(PropertiesService.getScriptProperties().getProperty('REGISTRY_MAIL_TASKS_SENT') || '[]') } catch (e) { list = [] }
  return Array.isArray(list) ? list.map(String).filter(function (k) { return REGISTRY_MAIL_KEY_PATTERN.test(k) }) : []
}

// 送った key の一覧を返す
function sendRegistryMailTasks_(state) {
  var tasks = state && Array.isArray(state.mailTasks) ? state.mailTasks : []
  if (!tasks.length) return []
  var sent = registryMailTasksSent_()
  var pending = tasks.filter(function (t) { return sent.indexOf(t.key) < 0 })
  if (!pending.length) return []
  var emails = getAllMemberEmails_()
  var tops = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  var done = []
  for (var i = 0; i < pending.length; i++) {
    var t = pending[i]
    var to = []
    t.to.concat(tops).forEach(function (e) { if (to.map(function (x) { return x.toLowerCase() }).indexOf(e.toLowerCase()) < 0) to.push(e) })
    if (!to.length) {
      console.warn('レジストリからのメールを送る宛先(担当者・代表)がありません: ' + t.subject)
      continue
    }
    // 送れなかった時(メールの1日の上限など)は、残りも次の確認に回す(送る順を守る)
    if (!sendMail_({ to: to.join(','), subject: t.subject, body: t.body })) break
    sent.push(t.key)
    done.push(t.key)
  }
  if (done.length) PropertiesService.getScriptProperties().setProperty('REGISTRY_MAIL_TASKS_SENT', JSON.stringify(sent.slice(-REGISTRY_MAIL_SENT_KEEP)))
  return done
}

function gasUpdateStatus_() {
  var state = readContractState_()
  var u = (state && state.gasUpdate) || null
  if (u && u.judgedVersion !== OHSUMI_GAS_VERSION) u = null
  return {
    current: OHSUMI_GAS_VERSION,
    known: !!u,
    required: !!(u && u.required),
    outdated: !!(u && u.outdated),
    latest: (u && u.latest) || '',
    minimum: (u && u.minimum) || '',
    security: !!(u && u.security),
    checkedAt: (state && state.checkedAt) || '',
  }
}

function gasUpdateNoticeText_(orgName, st) {
  var name = orgName || 'Ohsumi'
  return {
    subject: '[Ohsumi] ' + name + ': 団体の GAS の更新が要ります(最新の版 ' + st.latest + ')',
    body: name + ' 代表の方へ\n\n' +
      'この団体の Ohsumi の GAS(スプレッドシートの Apps Script)は、更新が要ります。\n\n' +
      '今の版: ' + st.current + '\n最新の版: ' + st.latest + '\n' +
      (st.minimum ? 'この版より古い GAS は、更新が要ります: ' + st.minimum + '\n' : '') +
      (st.security ? '新しい版には、安全の修正が含まれます。お早めに更新してください。\n' : '') +
      '\n更新の手順:\n' +
      '1. Ohsumi にログインし、管理画面の上部の知らせの「コードをコピー」を押す\n' +
      '2. スプレッドシートの「拡張機能」→「Apps Script」で、Code.gs の中身をすべて消して貼り付け、保存する\n' +
      '3. スプレッドシートのメニュー「Ohsumi」→「初期設定」を選ぶ\n' +
      '4. 「デプロイ」→「デプロイを管理」→ ウェブアプリの編集(鉛筆)→「バージョン: 新バージョン」で更新する(URL は変わりません)\n\n' +
      'このメールは、新しい版ごとに1回だけ送ります。',
  }
}

// 更新が要る時に、代表にメールで知らせる(最新の版ごとに1回)。送ったら最新の版を返す(送らなければ null)
function sendGasUpdateNotice_() {
  var st = gasUpdateStatus_()
  if (!st.required || !st.latest) return null
  var props = PropertiesService.getScriptProperties()
  if (props.getProperty('GAS_UPDATE_NOTIFIED') === st.latest) return null
  var emails = getAllMemberEmails_()
  var to = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  if (!to.length) {
    console.warn('GAS の更新が要ることを知らせる代表のメールアドレスがありません')
    return null
  }
  var text = gasUpdateNoticeText_(getSettingValue_('org_name'), st)
  // メールの上限で送れなかった時は、送ったことにしない(次の確認で送り直す)
  if (!sendMail_({ to: to.join(','), subject: text.subject, body: text.body })) return null
  props.setProperty('GAS_UPDATE_NOTIFIED', st.latest)
  return st.latest
}

// トリガーから: 覚えている状態で、提供停止中か(レジストリには問い合わせない)
function contractSuspendedNow_() {
  var c = effectiveContract_(readContractState_(), Date.now())
  return c.phase === 'inEffect' && c.kind === 'suspend'
}

// レジストリの checkIn で状態を確かめ、CONTRACT_STATE に覚えて返す。確かめられない時は null(覚えた状態は変えない)。
// レジストリに登録していない団体(REGISTRY_URL・共有鍵が無い)も null
function refreshContractState_(deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = registryUrl_()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) return null
  var ts = nowSec_()
  var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('checkIn.' + orgId + '.' + ts, key))
  // メールの1日の上限の状態も伝える(レジストリの管理画面で、上限に近い団体が分かるように)
  var mail = null
  try {
    var q = mailQuotaStatus_()
    mail = { remaining: q.remaining, skipped: q.skipped, date: q.date, lastReachedDate: q.lastReachedDate }
  } catch (e) { mail = null }
  // 毎日・毎時の処理が最後に成功した時刻も伝える(止まった団体が、レジストリと監視で分かるように)
  var jobs = null
  try {
    var j = jobStatus_(Date.now())
    jobs = { dailyAt: j.dailyAt, hourlyAt: j.hourlyAt }
  } catch (e) { jobs = null }
  // レジストリから頼まれて送ったメール(sendRegistryMailTasks_)の key。レジストリが記録し、二重に送らない
  var mailDone = registryMailTasksSent_().slice(-REGISTRY_MAIL_DONE_REPORT)
  var payload = JSON.stringify({ action: 'checkIn', orgId: orgId, ts: ts, sig: sig, gasVersion: OHSUMI_GAS_VERSION, mail: mail, jobs: jobs, mailDone: mailDone })
  var res
  try {
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
    res = JSON.parse(r.getContentText())
  } catch (e) {
    console.warn('レジストリに停止の状態を確かめられませんでした(通信エラー・JSON ではない応答)。最後に確かめた状態のまま使います。')
    return null
  }
  if (!res || !res.ok || !res.result) {
    console.warn('レジストリに停止の状態を確かめられませんでした(' + String((res && res.error) || '応答の形が違います') + ')。最後に確かめた状態のまま使います。')
    return null
  }
  var out = res.result
  var state = {
    phase: ['none', 'scheduled', 'inEffect'].indexOf(out.phase) >= 0 ? out.phase : 'none',
    kind: out.kind === 'restrict' ? 'restrict' : 'suspend',
    suspendAt: String(out.suspendAt || ''),
    reason: String(out.reason || ''),
    checkedAt: String(out.checkedAt || new Date().toISOString()),
    // サイトの origin の一覧(本人あての招待リンクのメールに使う。レジストリのスクリプトプロパティ SITE_ORIGINS)
    siteOrigins: parseSiteOrigins_(out.siteOrigins),
    // この GAS の版の更新が要るか(レジストリの版の一覧で判定したもの)
    gasUpdate: parseGasUpdate_(out.gasUpdate),
    // プラン(集計値を送るかの決まりに使う。古いレジストリは返さない)
    plan: ['cosmo_base', 'ohsumi', 'paid'].indexOf(String(out.plan || '')) >= 0 ? String(out.plan) : '',
    // FSIF からの回答待ちのアンケート(代表の管理画面に出す。古いレジストリは返さない)
    surveys: parseSurveys_(out.surveys),
    // 掲載中の緊急のお知らせの ID(代表にメールで1回だけ送る)
    urgentAnnouncementIds: (Array.isArray(out.urgentAnnouncementIds) ? out.urgentAnnouncementIds : [])
      .map(function (x) { return String(x).slice(0, 40) }).filter(function (x) { return /^an_[A-Za-z0-9]+$/.test(x) }).slice(0, 20),
    // レジストリから止めている機能(機能のスイッチ。古いレジストリは返さない)
    disabledFeatures: parseDisabledFeatures_(out.disabledFeatures),
    // 上限・しきい値(安全な範囲に収めたもの。古いレジストリは返さない)
    tunables: parseTunables_(out.tunables),
    // レジストリに頼まれて送るメール(アンケート・停止の予告など)。古いレジストリは返さない(null)
    mailTasks: parseRegistryMailTasks_(out.mailTasks),
  }
  setRequestProp_('CONTRACT_STATE', JSON.stringify(state))
  return state
}

// リクエストの時の状態。レジストリに確かめ直すのは(上の説明):
//   停止中 → どの操作でも1分に1回まで / 予定あり → 書き込みの前に1分に1回まで / 予定なし → 書き込みの前に10分に1回まで
// writing: 読み取りの一覧に無い操作か(省くと読み取り)
function currentContract_(nowMs, writing) {
  var state = null
  try { state = JSON.parse(requestProps_().CONTRACT_STATE || 'null') } catch (e) { state = null }
  var c = effectiveContract_(state, nowMs)
  if (c.phase !== 'inEffect' && !writing) return c
  var cache = CacheService.getScriptCache()
  if (cache.get('contract:recheck')) return c
  cache.put('contract:recheck', '1', c.phase === 'none' ? tunable_('contractRecheckIdleSec', CONTRACT_RECHECK_IDLE_SEC) : CONTRACT_RECHECK_SEC)
  var fresh = refreshContractState_()
  return fresh ? effectiveContract_(fresh, nowMs) : c
}

// 停止中に断る時の応答(受け付ける時は null)
function contractRejection_(c, body) {
  if (c.phase !== 'inEffect') return null
  if (c.kind === 'suspend') return { ok: false, orgSuspended: true, error: CONTRACT_SUSPENDED_MESSAGE }
  if (readOnlyAllows_(body)) return null
  return { ok: false, restricted: true, error: 'Ohsumi は読み取り専用になっています(作成・編集はできません)。' + CONTRACT_RESTRICTED_MESSAGE }
}

// 画面に渡す状態(停止の理由は渡さない。代表へのメールにだけ書く)
function contractForClient_(c) {
  return { phase: c.phase, kind: c.kind, suspendAt: c.suspendAt }
}

