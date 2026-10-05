// ---- ほかの端末で開く: 本人あての招待リンクのメール ----------------------------------
//
// 招待リンク(<サイトの origin>/?org=<団体ID>)を、ログインしている本人の登録済みのメールアドレス(MemberEmails。
// 複数あればすべて)にだけ送る。宛先は画面から受け取らない。リンクには団体ID だけを入れる(セッション・メールアドレスは入れない)。
// サイトの origin は、レジストリの checkIn が配る一覧(CONTRACT_STATE.siteOrigins)の中から選ぶ。画面が今開いている
// origin が一覧にあればそれを、無ければ一覧の最初(正式なサイト)を使う(画面が送った値を、そのままリンクにはしない)。
// レジストリに一度も確かめられていない団体・一覧が空の団体では送れない。
// 送れるのは1人1時間に INVITE_MAIL_LIMIT 回まで(CacheService に送った時刻を覚える)。
// 機能停止中(読み取り専用)も使える(READ_ONLY_ACTIONS。データを書き換えないため)。テスト環境の宛先の決まりは sendMail_ に従う
var INVITE_MAIL_LIMIT = 3
var INVITE_MAIL_WINDOW_SEC = 3600
var SITE_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
var SITE_ORIGINS_MAX = 5
var INVITE_MAIL_UNAVAILABLE = 'この団体では、まだメールで送れません(接続先の確認が済んでいません)。QR コードか共有をお使いください。'

// レジストリが配った origin の一覧を、形を確かめて取り出す(配列・文字列のどちらでも)
function parseSiteOrigins_(raw) {
  var list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/)
  var out = []
  list.forEach(function (v) {
    var o = String(v || '').trim().toLowerCase().replace(/\/+$/, '')
    if (o && SITE_ORIGIN_PATTERN.test(o) && out.indexOf(o) < 0 && out.length < SITE_ORIGINS_MAX) out.push(o)
  })
  return out
}

// レジストリに確かめた時に受け取った origin の一覧(一度も確かめていなければ空)
function inviteSiteOrigins_() {
  var state = readContractState_()
  if (!state || !state.checkedAt) return []
  return parseSiteOrigins_(state.siteOrigins)
}

// 正式なサイトの招待リンク(<SITE_ORIGINS の最初>/?org=<団体ID>)。レジストリに確かめていない団体は ''
function canonicalInviteLink_() {
  var origins = inviteSiteOrigins_()
  var orgId = String(requestProps_().ORG_ID || '')
  return origins.length && orgId ? origins[0] + '/?org=' + encodeURIComponent(orgId) : ''
}

// 登録を終えた時に出す招待リンク。レジストリに確かめて、サイトの URL(SITE_ORIGINS)が分かれば完全なリンクを出す
function setupInviteLinkText_(orgId) {
  var link = ''
  try {
    resetRequestProps_()
    refreshContractState_()
    resetRequestProps_()
    link = canonicalInviteLink_()
  } catch (e) {
    link = ''
  }
  if (link) return '団体ID: ' + orgId + '\n招待リンク: ' + link + '\n(メンバーには、初めての端末でこのリンクから開くよう伝えてください。代表は、ログインした後に管理画面の「Members」でも確かめられます)'
  return '団体ID: ' + orgId + '\n招待リンク: Ohsumi のサイトの URL の後ろに /?org=' + orgId +
    ' を付けたもの(レジストリからサイトの URL を受け取れませんでした。代表は、ログインした後に管理画面の「Members」でも確かめられます)'
}

// 通知の本文の最後に、サイトを開くリンクを足す(リンクが分からない・もう入っている時はそのまま)
function withSiteLink_(text) {
  var link = ''
  try { link = canonicalInviteLink_() } catch (e) { link = '' }
  var body = String(text || '')
  if (!link || body.indexOf(link) >= 0) return body
  return body + '\n\nOhsumi を開く / Open Ohsumi: ' + link
}

// 新しいメンバーへの招待メール(メンバーの追加・候補者を正式なメンバーにする時に、選んだ時だけ)。
// 宛先は、そのメンバーの登録済みのアドレス。リンクは SITE_ORIGINS と団体ID から GAS が作る
function sendMemberInvite_(memberId) {
  var link = canonicalInviteLink_()
  if (!link) return { sent: false, reason: 'notChecked' }
  var emails = registeredEmailsOf_(memberId)
  if (emails.length === 0) return { sent: false, reason: 'noEmail' }
  var orgName = getSettingValue_('org_name') || 'Ohsumi'
  var mailed = sendMailChecked_({
    to: emails.join(','),
    subject: '[Ohsumi] ' + orgName + ' の Ohsumi に招待されました',
    body: orgName + ' の Ohsumi(タスク・メンバーの管理)に招待されました。\n\n' +
      '次のリンクを開き、このメールアドレスの Google アカウントでログインしてください。\n\n' + link +
      '\n\nスマホでは、開いた後に「ホーム画面に追加」をすると、次からすぐに開けます。' +
      '\n\n---\nYou have been invited to ' + orgName + ' on Ohsumi. Open the link above and sign in with the Google account for this email address.',
  })
  // メールの1日の上限・通知の回数の上限で送れなかった時は、画面に伝える(メンバーの追加はそのまま)
  if (mailed === 'quota') return { sent: false, reason: 'mailQuota' }
  if (mailed === 'limited') return { sent: false, reason: 'limited' }
  return { sent: true }
}

function inviteMailKey_(memberId) {
  return 'invmail:' + sha256Base64Url_(String(memberId))
}

// この1時間に送った時刻(ミリ秒)
function inviteMailSentTimes_(memberId, nowMs) {
  var times = []
  try { times = JSON.parse(CacheService.getScriptCache().get(inviteMailKey_(memberId)) || '[]') } catch (e) { times = [] }
  if (!Array.isArray(times)) times = []
  return times.filter(function (t) { return typeof t === 'number' && t > nowMs - INVITE_MAIL_WINDOW_SEC * 1000 && t <= nowMs })
}

function registeredEmailsOf_(memberId) {
  return String(getMemberEmailValueCached_(memberId) || '').split(/[\s,;]+/).map(function (e) { return e.trim() })
    .filter(function (e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) })
}

/** 本人あてのメールを送れるか({ available, reason?, remaining, retryAt? }) */
function inviteMailStatus_(memberId, nowMs) {
  var remaining = Math.max(0, tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT) - inviteMailSentTimes_(memberId, nowMs).length)
  if (inviteSiteOrigins_().length === 0) return { available: false, reason: 'notChecked', remaining: remaining }
  if (registeredEmailsOf_(memberId).length === 0) return { available: false, reason: 'noEmail', remaining: remaining }
  if (remaining === 0) {
    var times = inviteMailSentTimes_(memberId, nowMs)
    return { available: false, reason: 'limit', remaining: 0, retryAt: new Date(Math.min.apply(null, times) + INVITE_MAIL_WINDOW_SEC * 1000).toISOString() }
  }
  return { available: true, remaining: remaining }
}

// 本人あての招待リンクのメールの文面(団体ID 以外は入れない)
function inviteMailText_(orgName, link, locale) {
  var name = orgName || 'Ohsumi'
  if (locale === 'en') {
    return {
      subject: '[Ohsumi] ' + name + ': link to open on another device',
      body: 'Open this link on the device you want to use, then sign in with Google.\n\n' + link +
        '\n\nOn a smartphone, add it to your home screen after opening it so you can open it right away next time.' +
        '\n\nThis email was sent because you asked for it in Ohsumi. If you did not, you can ignore it.',
    }
  }
  return {
    subject: '[Ohsumi] ' + name + ': ほかの端末で開くためのリンク',
    body: '使いたい端末で次のリンクを開き、Googleでログインしてください。\n\n' + link +
      '\n\nスマホでは、開いた後に「ホーム画面に追加」をすると、次からすぐに開けます。' +
      '\n\nこのメールは、Ohsumi の「ほかの端末で開く」から、ご本人が送ったものです。心当たりが無ければ、このメールは無視してください。',
  }
}

/** 本人の登録済みのアドレスにだけ、招待リンクを送る。body.siteOrigin(画面が開いている origin)は一覧にある時だけ使う */
function sendInviteLinkToMe_(memberId, body, nowMs) {
  var origins = inviteSiteOrigins_()
  if (origins.length === 0) throw userError_(INVITE_MAIL_UNAVAILABLE)
  var emails = registeredEmailsOf_(memberId)
  if (emails.length === 0) throw userError_('メールアドレスが登録されていません。管理者に登録を頼んでください。')
  var requested = String((body && body.siteOrigin) || '').trim().toLowerCase().replace(/\/+$/, '')
  var origin = origins.indexOf(requested) >= 0 ? requested : origins[0]
  var orgId = String(requestProps_().ORG_ID || '')
  if (!orgId) throw userError_(INVITE_MAIL_UNAVAILABLE)
  var link = origin + '/?org=' + encodeURIComponent(orgId)
  // 回数の確認と記録は、ほかの送信と重ならないようにロックの中で行う(送信はロックの外)
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(10000)
  } catch (lockErr) {
    throw userError_('混み合っています。少し待って再度お試しください。')
  }
  var times
  try {
    times = inviteMailSentTimes_(memberId, nowMs)
    if (times.length >= tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT)) {
      throw userError_('メールで送れるのは1時間に' + tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT) + '回までです。しばらくしてから、もう一度お試しください。')
    }
    times.push(nowMs)
    CacheService.getScriptCache().put(inviteMailKey_(memberId), JSON.stringify(times), INVITE_MAIL_WINDOW_SEC)
  } finally {
    lock.releaseLock()
  }
  var text = inviteMailText_(getSettingValue_('org_name'), link, body && body.locale === 'en' ? 'en' : 'ja')
  var mailed = sendMailChecked_({ to: emails.join(','), subject: text.subject, body: text.body })
  if (mailed === 'quota') throw userError_(quotaMessage_('email', false) + 'QR コードかリンクのコピーを使ってください。')
  if (mailed === 'limited') throw userError_('通知の回数の上限に達しました。しばらくしてから、もう一度お試しください。')
  return { sent: true, count: emails.length, remaining: Math.max(0, tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT) - times.length) }
}

// 停止の予告のメールの文面
function contractNoticeText_(orgName, c, days) {
  var when = Utilities.formatDate(new Date(c.suspendAt), Session.getScriptTimeZone(), 'yyyy年M月d日 H:mm')
  var what = c.kind === 'restrict'
    ? 'Ohsumi が読み取り専用になります(閲覧と書き出しはできますが、作成・編集はできなくなります)。' + CONTRACT_RESTRICTED_MESSAGE
    : 'Ohsumi の提供を停止します。停止の後は、メンバー全員が Ohsumi にログインできなくなり、通知も止まります(団体のデータは、団体のスプレッドシートにそのまま残ります)。'
  var name = orgName || 'Ohsumi'
  return {
    subject: '[Ohsumi] ' + name + ': ' + when + ' から' + (c.kind === 'restrict' ? '読み取り専用になります' : '提供を停止します') + '(あと' + days + '日)',
    body: name + ' 代表の方へ\n\n' + when + ' から、' + what + '\n\n理由: ' + (c.reason || '—') + '\n\nご不明な点は FSIF にお問い合わせください。',
  }
}

// 停止の予定があれば、予告の時期(14日前・7日前・1日前)になったものを代表に送る。送った日数を返す(送らなければ null)。
// 同じ予定(日時と種類)に同じ予告は1回だけ。予定が変わったら、数え直す
function sendContractNotices_(state, nowMs) {
  var c = effectiveContract_(state, nowMs)
  if (c.phase !== 'scheduled') return null
  var left = (Date.parse(c.suspendAt) - nowMs) / (24 * 3600 * 1000)
  var due = CONTRACT_NOTICE_DAYS.filter(function (d) { return left <= d })
  if (!due.length) return null
  var days = Math.min.apply(null, due)
  var props = PropertiesService.getScriptProperties()
  var planKey = c.suspendAt + '|' + c.kind
  var sent = {}
  try { sent = JSON.parse(props.getProperty('CONTRACT_NOTICES_SENT') || '{}') || {} } catch (e) { sent = {} }
  if (sent.plan !== planKey) sent = { plan: planKey, days: [] }
  if (sent.days.indexOf(days) >= 0) return null
  var emails = getAllMemberEmails_()
  var to = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  if (to.length) {
    var text = contractNoticeText_(getSettingValue_('org_name'), { kind: c.kind, suspendAt: c.suspendAt, reason: state && state.reason }, days)
    // メールの1日の上限で送れなかった時は、送ったことにしない(次の確認で送り直す)
    if (!sendMail_({ to: to.join(','), subject: text.subject, body: text.body })) return null
  } else {
    console.warn('停止の予告を送る代表のメールアドレスがありません(あと' + days + '日)')
  }
  sent.days.push(days)
  props.setProperty('CONTRACT_NOTICES_SENT', JSON.stringify(sent))
  return days
}

function exchangeIdToken_(body) {
  var google = timed_('verifyMs', function () { return verifyGoogleIdToken_(body.idToken, body.nonceSecret) })
  var memberId = timed_('emailLookupMs', function () { return findMemberIdByEmailCached_(google.email) })
  // 最初の代表: 未登録のアカウントが初期設定コードを付けて来た時は、代表として団体に入れる(同じ1回の通信で)
  if (!memberId && body.setupCode) {
    memberId = timed_('setupMs', function () { return claimInitialSetup_(google.email, body.setupCode, Date.now()) })
  }
  // 未登録のアカウント: ログイン画面に表示するため、本人のメールアドレスと団体名だけ返す
  // (団体名は、Google でログインした後にだけ返す。どの団体に入ろうとしたかを画面に出すため)
  if (!memberId) return { memberId: null, email: google.email, orgName: String(getSettingValue_('org_name') || '') }
  // 退会したメンバーはログインできない(休止中のメンバーはログインできる)
  if (memberIsWithdrawn_(memberId)) throw userError_(WITHDRAWN_MEMBER_MESSAGE)
  var data = getInitialDataForMember_(memberId, null)
  if (!data.memberId) return { memberId: null, email: google.email }
  data.session = timed_('sessionMs', function () { return issueSessionToken_(memberId, body.remember !== false, nowSec_()) })
  // 最終ログイン日時も、ここで記録する(画面が別に updateLastLogin を送らなくてよいように)
  data.lastLoginRecorded = timed_('lastLoginMs', function () { return recordLastLogin_(memberId) })
  return attachBackgroundData_(data, memberId, body)
}

// ログインの時の最終ログイン日時。ログインの応答を待たせないよう、シートには書かない:
//   - 前回の記録から1時間以内なら何もしない(最終ログイン日時は、おおよそ正しければ十分)
//   - それ以外は、スクリプトプロパティの「書き込み待ち」に入れるだけ(ロックもシートも使わない)。
//     書き込み待ちは、ログイン1回ごとに別のプロパティ(LAST_LOGIN_PENDING_<メンバーID>_<時刻>)にする。
//     全員分を1つのプロパティにまとめないので、同時にログインしても互いに消し合わない
//   - 書き込み待ちは、毎時のトリガー(sendBatchNotifications)と毎日のトリガー(dailyMaintenance)が
//     まとめてシートに書く(flushPendingLastLogins_)。画面の最終ログイン日時は、最大1時間ほど遅れて反映される
// 返り値 true は「画面は updateLastLogin を送らなくてよい」。記録できなかった時だけ false
var LAST_LOGIN_THROTTLE_SEC = 3600
var LAST_LOGIN_PENDING_PREFIX = 'LAST_LOGIN_PENDING_'
// 書き込み待ちの上限。トリガーが止まっていても、これ以上は増やさない(あふれた分は捨てる。
// 最終ログイン日時は、おおよそ正しければ十分)
var LAST_LOGIN_PENDING_MAX = 200

function recordLastLogin_(memberId, nowMs) {
  memberId = String(memberId)
  var now = nowMs || Date.now()
  try {
    var cache = CacheService.getScriptCache()
    var cacheKey = 'lastLogin:' + memberId
    if (cache.get(cacheKey)) {
      noteTiming_('lastLogin', 'recent')
      return true
    }
    // 書き込み待ち(このリクエストの最初に読んだスクリプトプロパティ)のうち、このメンバーの分と全体の件数。
    // CacheService の印は途中で消えることがあるので、書き込み待ちそのものも見る
    var all = requestProps_()
    var ownKeys = []
    var newestOwn = NaN
    var total = 0
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(LAST_LOGIN_PENDING_PREFIX) !== 0) return
      total++
      if (memberIdFromPendingKey_(k) !== memberId) return
      ownKeys.push(k)
      var at = Date.parse(String(all[k]))
      if (!(newestOwn >= at)) newestOwn = at
    })
    // スナップショット(シートの値)か書き込み待ちの日時が1時間以内なら書かない
    var fromSnapshot = _requestSnapshot ? lastLoginInTable_(_requestSnapshot.data.Members, memberId) : NaN
    var latest = Math.max(fromSnapshot > 0 ? fromSnapshot : 0, newestOwn > 0 ? newestOwn : 0)
    if (latest > 0 && now - latest < LAST_LOGIN_THROTTLE_SEC * 1000) {
      cache.put(cacheKey, '1', LAST_LOGIN_THROTTLE_SEC)
      noteTiming_('lastLogin', 'recent')
      return true
    }
    // 上限に達していて、このメンバーの分がまだ無ければ入れない(捨てる)
    if (!ownKeys.length && total >= LAST_LOGIN_PENDING_MAX) {
      cache.put(cacheKey, '1', LAST_LOGIN_THROTTLE_SEC)
      noteTiming_('lastLogin', 'dropped')
      return true
    }
    var props = PropertiesService.getScriptProperties()
    props.setProperty(lastLoginPendingKey_(memberId, now), new Date(now).toISOString())
    // このメンバーの古い書き込み待ちは、新しい1件に置き換える(トリガーが止まっていても、1人につき増え続けない)。
    // 消すのは、このリクエストの最初に見えていた自分の分だけ(ほかのメンバーの分・この後に入った分は消さない)
    ownKeys.forEach(function (k) { props.deleteProperty(k) })
    cache.put(cacheKey, '1', LAST_LOGIN_THROTTLE_SEC)
    noteTiming_('lastLogin', 'queued')
    return true
  } catch (e) {
    // 記録できなくてもログインは続ける(画面が updateLastLogin を送る)
    Logger.log('recordLastLogin failed: ' + e)
    return false
  }
}

// 書き込み待ちのプロパティの名前。メンバーIDの後ろに時刻(と乱数)を付け、ログイン1回ごとに別のキーにする
function lastLoginPendingKey_(memberId, nowMs) {
  return LAST_LOGIN_PENDING_PREFIX + String(memberId) + '_' + nowMs + '_' + Math.floor(Math.random() * 1e6)
}

// 書き込み待ちのキーからメンバーIDを取り出す(後ろの _<時刻>_<乱数> を除く)
function memberIdFromPendingKey_(key) {
  var rest = key.slice(LAST_LOGIN_PENDING_PREFIX.length)
  var m = rest.match(/^(.*)_\d+_\d+$/)
  return m ? m[1] : rest
}

// Members の表(見出しと行)から、そのメンバーの last_login(ミリ秒)。無ければ NaN
function lastLoginInTable_(table, memberId) {
  if (!table || !table.headers) return NaN
  var idCol = table.headers.indexOf('id')
  var col = table.headers.indexOf('last_login')
  if (idCol < 0 || col < 0) return NaN
  for (var i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i][idCol]) === memberId) {
      var v = table.rows[i][col]
      return v instanceof Date ? v.getTime() : Date.parse(String(v || ''))
    }
  }
  return NaN
}

// 書き込み待ちの最終ログイン日時を、まとめて Members の last_login に書く(トリガーから呼ぶ)。
// 列を1回読み、1回で書く。消すのは、このとき読んだキーだけ(読んだ後にログインした分は別のキーなので残る)。
// 毎時と毎日のトリガーが重なっても二重に処理しないよう、ロックを取ってから読む
function flushPendingLastLogins_() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(30000)) return 0
  var written = 0
  try {
    var props = PropertiesService.getScriptProperties()
    var all = props.getProperties() || {}
    var keys = Object.keys(all).filter(function (k) { return k.indexOf(LAST_LOGIN_PENDING_PREFIX) === 0 })
    if (!keys.length) return 0
    // メンバーごとに、いちばん新しい日時
    var pending = {}
    keys.forEach(function (k) {
      var id = memberIdFromPendingKey_(k)
      if (!pending[id] || String(all[k]) > pending[id]) pending[id] = String(all[k])
    })
    var sheet = getSheet_(SHEET_MEMBERS)
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var col = headers.indexOf('last_login')
    var lastRow = sheet.getLastRow()
    if (idCol < 0 || col < 0 || lastRow < 2) return 0
    var idValues = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues()
    var range = sheet.getRange(2, col + 1, lastRow - 1, 1)
    var values = range.getValues()
    idValues.forEach(function (r, i) {
      var id = String(r[0])
      if (pending[id]) {
        values[i][0] = pending[id]
        written++
      }
    })
    if (written) {
      range.setValues(values)
      SpreadsheetApp.flush()
    }
    // 書いたキー(このとき読んだキー)だけを消す。行の無いメンバーの分も消す
    keys.forEach(function (k) { props.deleteProperty(k) })
  } finally {
    lock.releaseLock()
  }
  return written
}

// リクエストの認証(セッショントークン)。返り値 { memberId, renewed(新しいセッショントークン or null) }
function authenticateRequest_(body) {
  if (!body.sessionToken) throw userError_('ログインしていません。再ログインしてください。')
  var payload = verifySessionToken_(body.sessionToken)
  return { memberId: String(payload.sub), renewed: renewSessionIfNeeded_(payload) }
}

// メンバーの世代番号を1増やし、そのメンバーに発行済みのセッショントークンをすべて無効にする
function bumpSessionGeneration_(memberId) {
  if (!memberId) return
  try {
    setRequestProp_(SESSION_GEN_PREFIX + memberId, String(sessionGeneration_(memberId) + 1))
  } catch (e) {
    Logger.log('bumpSessionGeneration failed: ' + e)
  }
}

// ---- ログインの無効化(revokeSessionsIssuedBefore などから使う) ----

function setSessionNotBefore_(sec) {
  var props = PropertiesService.getScriptProperties()
  var current = Number(props.getProperty('SESSION_NOT_BEFORE') || 0)
  // 後から古い日時を指定しても、既に無効にした範囲は戻さない
  var next = Math.max(current, Math.floor(sec))
  props.setProperty('SESSION_NOT_BEFORE', String(next))
  resetRequestProps_()
  console.log('この日時より前に発行されたログインを無効にしました: ' + new Date(next * 1000).toISOString())
}

// ---- 権限の例外(permission_overrides) ------------------------------------------
//
// 例外は「対象の種類(task / project / department / recruiting)」と「対象ID」
// 「アクセス水準(view < edit < approve)」の組。例外で許可するのは、下の表で
// その種類の例外を受け付けると決めた操作だけにする。表に無い操作(代表専用の
// 操作 — 役職の変更、メンバーの追加・削除など — や、設定・メンバー情報の
// 変更、経費・フォームの承認など)は、どの例外でも許可しない。
//   task      タスクを対象にする操作。タスクの例外に加え、そのタスクが属する
//             プロジェクト・部署の例外も使える(プロジェクト・部署はリクエストの
//             値ではなく、シート上のタスクの値で判定する)
//   project   プロジェクトを対象にする操作。body.projectId のプロジェクトの例外
//   recruiting 採用(候補者)の操作。採用の例外だけ
var OVERRIDE_SCOPE_BY_ACTION = {
  approveTask: 'task', assignTask: 'task', updateTaskDetails: 'task', updateVisibility: 'task',
  updateReviewer: 'task', updateReviewers: 'task', removeTask: 'task', updatePriority: 'task',
  updateDifficulty: 'task', updateSchedule: 'task', updateDependsOn: 'task', setBlocker: 'task',
  rejectTask: 'task',
  updateProjectDetails: 'project', updateProjectOwner: 'project', updateProjectParent: 'project',
  updateProjectArchived: 'project', updateProjectMembers: 'project', notifyProjectHealth: 'project',
  updateProjectHealthRecord: 'project', updateProjectHealth: 'project',
  addCandidate: 'recruiting', updateCandidate: 'recruiting', removeCandidate: 'recruiting',
  convertCandidateToMember: 'recruiting',
}

var OVERRIDE_ACCESS_LEVELS = { view: 0, edit: 1, approve: 2 }

// 例外の一覧が、対象(targets)に対して必要な水準を満たすか(Google のサービスを
// 使わない純粋な関数)。targets は { task, project, department, recruiting } の
// うち、その操作で見てよいものだけを持つ。
function overridesGrant_(overrides, targets, requiredLevel) {
  for (var i = 0; i < overrides.length; i++) {
    var ov = overrides[i] || {}
    var granted = OVERRIDE_ACCESS_LEVELS[ov.access]
    if (typeof granted !== 'number' || granted < requiredLevel) continue
    var targetId = String(ov.targetId || '')
    if (ov.targetType === 'task' && targets.task && targetId === targets.task) return true
    if (ov.targetType === 'project' && targets.project && targetId === targets.project) return true
    // 部門は、以前の部門名・部門IDのどちらでも同じ部門として比べる
    if (ov.targetType === 'department' && targets.department !== undefined &&
        normalizeValue_('department', targetId) === normalizeValue_('department', targets.department)) return true
    // recruiting: targetIdでの絞り込みは行わない（'all'固定運用のため、targetType一致とaccess水準のみで判定）
    if (ov.targetType === 'recruiting' && targets.recruiting) return true
  }
  return false
}

/**
 * Returns true if acting member has a permission_overrides entry that
 * applies to this action (see OVERRIDE_SCOPE_BY_ACTION). Used as OR
 * fallback when the role-based check denies.
 */
function checkPermissionOverride_(acting, action, body) {
  var overrides = acting.permission_overrides
  if (!overrides || overrides.length === 0) return false
  var scope = OVERRIDE_SCOPE_BY_ACTION[action]
  if (!scope) return false
  body = body || {}

  var targets = {}
  if (scope === 'task') {
    var taskId = String(body.taskId || '')
    if (!taskId) return false
    targets.task = taskId
    var taskRow = null
    try { taskRow = authFindRow_(SHEET_TASKS, taskId) } catch (e) { taskRow = null }
    if (taskRow) {
      targets.project = String(taskRow.project_id || '')
      targets.department = String(taskRow.department || '')
    }
  } else if (scope === 'project') {
    targets.project = String(body.projectId || '')
    if (!targets.project) return false
  } else if (scope === 'recruiting') {
    // 候補者を一般以外の役職でメンバー登録するのは役職の付与にあたるため、
    // 代表専用(採用の例外では許可しない)
    if (action === 'convertCandidateToMember' && roleTier_(getRoles_(), body.role) !== 'base') return false
    targets.recruiting = true
  }

  var required = action === 'approveTask' ? OVERRIDE_ACCESS_LEVELS.approve : OVERRIDE_ACCESS_LEVELS.edit
  return overridesGrant_(overrides, targets, required)
}

/**
 * Reads quiz_definitions from the Settings sheet.
 * Returns [] when the key is absent or unparseable.
 */
function getQuizDefinitions_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
    if (!sheet) return []
    var data = sheet.getDataRange().getValues()
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === 'quiz_definitions') {
        var defs = JSON.parse(data[i][1] || '[]')
        return Array.isArray(defs) ? defs : []
      }
    }
  } catch (_) {}
  return []
}

