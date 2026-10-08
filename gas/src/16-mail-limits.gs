// ---- メール送信(テスト環境では本来の宛先に送らない) ---------------------------
//
// スクリプトプロパティ TEST_ENVIRONMENT が true の場合は、本来の宛先には送らず、
// スクリプトプロパティ TEST_NOTIFICATION_EMAIL の1つのアドレスにだけ送る
// (件名に [テスト] を付け、本文の先頭に本来の宛先を書く)。未設定の場合は
// 送信せず、実行ログに記録するだけにする。メールの送信は必ずこの関数を通す。

function isTestEnvironment_() {
  return PropertiesService.getScriptProperties().getProperty('TEST_ENVIRONMENT') === 'true'
}

// ---- 通知・翻訳の回数の上限(1人あたり) -----------------------------------------
//
// 画面からのリクエストで送る通知(メール・Discord/Slack・通知のキュー)は、操作したメンバーごとに
// 1時間に RATE_LIMITS.notify.limit 件まで。超えた分は送らず、応答に notifyLimited: true を付ける
// (操作そのものは成功させる)。どの操作から送る通知も、ここを通るので数えられる(新しく足した操作も)。
// 時間主導トリガー(毎日の処理など)から送る通知は、操作したメンバーがいないので数えない。
// 送った時刻は CacheService に覚える(ロックを取っていない読み取りの操作では、同時のリクエストで
// 数件多く通ることがある)。
var RATE_LIMITS = {
  // メール・Discord/Slack・通知のキュー(1件ずつ数える)
  notify: { limit: 60, windowSec: 3600, tunable: 'notifyPerHour' },
  // コメントのメンションで通知する宛先の数
  mention: { limit: 30, windowSec: 3600, tunable: 'mentionPerHour' },
  // 日程調整・フォームの結果、研修の申請・承認の通知(1回ずつ数える)
  resultNotify: { limit: 10, windowSec: 3600, tunable: 'resultNotifyPerHour' },
  // 翻訳する文の数(Google の翻訳の1日の回数は、団体全体で分け合うため)
  translate: { limit: 500, windowSec: 3600, tunable: 'translatePerHour' },
  // 画面のエラーの記録(1人1時間)
  clientError: { limit: 30, windowSec: 3600, tunable: 'clientErrorPerHour' },
  // 兼部の統合表示の読み込み(getMyDigest。1人1時間)
  digest: { limit: 120, windowSec: 3600 },
}
// 今の上限(レジストリから届いた値。届いていなければ RATE_LIMITS の limit)
function rateLimitOf_(kind) {
  var spec = RATE_LIMITS[kind]
  return spec.tunable ? tunable_(spec.tunable, spec.limit) : spec.limit
}
var _requestActorId = null
var _notifyLimited = false

function rateLimitKey_(kind, memberId) {
  return 'rl:' + kind + ':' + sha256Base64Url_(String(memberId))
}

// この時間の窓の中で使った回数(送った時刻の一覧)
function rateLimitTimes_(kind, memberId, nowMs) {
  var spec = RATE_LIMITS[kind]
  var times = []
  try { times = JSON.parse(CacheService.getScriptCache().get(rateLimitKey_(kind, memberId)) || '[]') } catch (e) { times = [] }
  if (!Array.isArray(times)) times = []
  return times.filter(function (t) { return typeof t === 'number' && t > nowMs - spec.windowSec * 1000 && t <= nowMs })
}

/** count 回ぶん使えるなら記録して true。上限を超えるなら記録せずに false */
function takeRateLimit_(kind, memberId, count, nowMs) {
  var spec = RATE_LIMITS[kind]
  nowMs = nowMs || Date.now()
  count = Math.max(1, Math.floor(count || 1))
  var times = rateLimitTimes_(kind, memberId, nowMs)
  if (times.length + count > rateLimitOf_(kind)) return false
  for (var i = 0; i < count; i++) times.push(nowMs)
  try { CacheService.getScriptCache().put(rateLimitKey_(kind, memberId), JSON.stringify(times), spec.windowSec) } catch (e) { /* 覚えられなくても続ける */ }
  return true
}

// 画面からのリクエストで送る通知を1件数える。上限を超えたら送らない(false)
function allowRequestNotification_(what) {
  if (!_requestActorId) return true
  if (takeRateLimit_('notify', _requestActorId, 1)) return true
  _notifyLimited = true
  console.warn('通知の上限(1人1時間に' + rateLimitOf_('notify') + '件)を超えたため、送りませんでした: ' + what)
  return false
}

// メールを送る。送れたら true。送らなかった時(通知の回数の上限・メールの1日の上限)は false
function sendMail_(options) {
  return sendMailChecked_(options) === 'sent'
}

// メールを送り、結果を返す: 'sent'(送った) / 'limited'(1人あたりの通知の上限で送らなかった) / 'quota'(メールの1日の上限で送らなかった)
function sendMailChecked_(options) {
  if (!allowRequestNotification_('メール ' + options.subject)) return 'limited'
  var count = mailRecipientCount_(options)
  if (count > 0) {
    var remaining = mailRemainingQuota_()
    if (remaining !== null && remaining < count) {
      recordMailQuotaSkip_(count, options.subject)
      return 'quota'
    }
  }
  countAction_('mailCount')
  // どの通知からも、サイトを開けるようにする(正式なサイトの <サイト>/?org=<団体ID>)
  var mail = {}
  Object.keys(options).forEach(function (k) { mail[k] = options[k] })
  mail.body = withSiteLink_(options.body)
  try {
    measureAction_('mailMs', function () { return sendMailUnmeasured_(mail) })
  } catch (e) {
    // 残りの数を確かめた後に、ほかの送信で上限に達した時など
    if (quotaKind_(e) !== 'email') throw e
    recordMailQuotaSkip_(Math.max(1, count), options.subject)
    return 'quota'
  }
  return 'sent'
}

// ---- メールの1日の上限 --------------------------------------------------------------
//
// 団体の GAS は「自分として実行」なので、メールは GAS を動かすアカウントの1日の上限(宛先の数。
// Google アカウントは 100、Google Workspace は 1,500)を、団体の全員で分け合う。
// 送る前に残りの数(MailApp.getRemainingDailyQuota)を確かめ、足りなければ送らずに記録する
// (スクリプトプロパティ MAIL_QUOTA_STATE)。記録は、代表の管理画面(getMailQuotaStatus)と、
// レジストリへの確認(checkIn)で伝える。送れなかった通知は、宛先ごとの毎日のまとめに回す(sendLocalizedEmail_)
var MAIL_QUOTA_STATE_KEY = 'MAIL_QUOTA_STATE'

function mailQuotaToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
}

// 残りの数(分からない時は null。送る前の確かめを省き、送る時の失敗で判断する)
function mailRemainingQuota_() {
  try {
    var n = MailApp.getRemainingDailyQuota()
    return typeof n === 'number' && isFinite(n) ? n : null
  } catch (e) {
    return null
  }
}

// このメールで使う上限の数(宛先の数)。テスト環境では、TEST_NOTIFICATION_EMAIL の1件だけ(無ければ送らないので 0)
function mailRecipientCount_(options) {
  if (isTestEnvironment_()) {
    return String(PropertiesService.getScriptProperties().getProperty('TEST_NOTIFICATION_EMAIL') || '').trim() ? 1 : 0
  }
  var n = 0
  ;[options.to, options.cc, options.bcc].forEach(function (v) {
    String(v || '').split(',').forEach(function (e) { if (e.trim()) n++ })
  })
  return n
}

// 今日の記録: { date, skipped(送れなかった数), reachedAt(今日、上限に達した時刻), lastReachedDate(最後に上限に達した日) }
function readMailQuotaState_() {
  var s = null
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty(MAIL_QUOTA_STATE_KEY) || 'null') } catch (e) { s = null }
  var today = mailQuotaToday_()
  if (!s || typeof s !== 'object') return { date: today, skipped: 0, reachedAt: '', lastReachedDate: '' }
  var last = String(s.lastReachedDate || '')
  if (s.date !== today) return { date: today, skipped: 0, reachedAt: '', lastReachedDate: last }
  return { date: today, skipped: Number(s.skipped) || 0, reachedAt: String(s.reachedAt || ''), lastReachedDate: last }
}

function recordMailQuotaSkip_(count, subject) {
  var s = readMailQuotaState_()
  s.skipped += Math.max(1, count || 1)
  if (!s.reachedAt) s.reachedAt = new Date().toISOString()
  s.lastReachedDate = s.date
  try {
    PropertiesService.getScriptProperties().setProperty(MAIL_QUOTA_STATE_KEY, JSON.stringify(s))
  } catch (e) {
    console.error('メールの上限の記録を書けませんでした: ' + e)
  }
  console.warn('メールの1日の上限に達したため、送りませんでした(今日 ' + s.skipped + ' 件): ' + subject)
}

// 画面(代表の管理画面)とレジストリに伝える形
function mailQuotaStatus_() {
  var s = readMailQuotaState_()
  return { remaining: mailRemainingQuota_(), date: s.date, skipped: s.skipped, reachedAt: s.reachedAt, lastReachedDate: s.lastReachedDate }
}

// ---- Google の利用の上限に達した時のエラー ----------------------------------------------
//
// GAS の1日の上限に達すると、Google は「Service invoked too many times for one day: email.」などの例外を投げる。
// どの上限かを見分け(email / urlfetch / properties / other)、画面には決まった文を返す(上限でなければ null)
function quotaKind_(err) {
  var msg = String((err && err.message) || err || '')
  var m = msg.match(/too many times for one day:\s*([a-z]+)/i)
  if (m) {
    var k = m[1].toLowerCase()
    return k === 'email' || k === 'urlfetch' || k === 'properties' ? k : 'other'
  }
  if (/Bandwidth quota exceeded/i.test(msg)) return 'urlfetch'
  if (/property storage quota/i.test(msg)) return 'properties'
  if (/Service invoked too many times/i.test(msg)) return 'other'
  return null
}

// login: ログイン(セッションの確かめ・Google でのログイン)の途中で上限に達した時
function quotaMessage_(kind, login) {
  var what = {
    email: 'この団体の、今日のメールの上限に達しました。',
    urlfetch: 'この団体の GAS が、今日の外部への通信(Google のログインの確認・Discord/Slack への通知など)の上限に達しました。',
    properties: 'この団体の GAS が、今日の設定の読み書き(スクリプトプロパティ)の上限に達しました。',
    other: 'この団体の GAS が、今日の Google の利用の上限に達しました。',
  }[kind] || ''
  return (login ? 'ログインを確かめられませんでした。' : '') + what +
    'あなたのアカウントの問題ではありません。上限は1日ごとに戻ります。続く時は、代表に知らせてください。'
}

// ログインの確かめで失敗した時の応答。上限に達した時は、ログインの失敗と分かる文を返し、
// authError を付けない(画面がログインし直しを求めても、上限が戻るまで同じ失敗になるため)
function authFailure_(err) {
  var kind = quotaKind_(err)
  if (kind) return { ok: false, error: quotaMessage_(kind, true), quotaExceeded: kind }
  return { ok: false, error: toErrorMessage_(err), authError: true }
}

function sendMailUnmeasured_(options) {
  if (!isTestEnvironment_()) {
    MailApp.sendEmail(options)
    return
  }
  var original = [options.to, options.cc, options.bcc].filter(Boolean).join(',')
  var redirect = String(PropertiesService.getScriptProperties().getProperty('TEST_NOTIFICATION_EMAIL') || '').trim()
  if (!redirect) {
    console.log(
      '[テスト環境] メールを送信しませんでした(TEST_NOTIFICATION_EMAIL が未設定)。件名: ' + options.subject +
        ' / 本来の宛先: ' + maskEmailsIn_(original),
    )
    return
  }
  var notice = '(テスト環境のため、本来の宛先ではなくこのアドレスに送信しています。本来の宛先: ' + original + ')\n\n'
  var redirected = {}
  Object.keys(options).forEach(function (key) {
    if (key !== 'to' && key !== 'cc' && key !== 'bcc') redirected[key] = options[key]
  })
  redirected.to = redirect
  redirected.subject = '[テスト] ' + options.subject
  redirected.body = notice + (options.body || '')
  if (options.htmlBody) redirected.htmlBody = '<p>' + notice.trim() + '</p>' + options.htmlBody
  MailApp.sendEmail(redirected)
  console.log('[テスト環境] メールを ' + maskEmailsIn_(redirect) + ' に送信しました。件名: ' + options.subject + ' / 本来の宛先: ' + maskEmailsIn_(original))
}

// 呼び出し方は2通り:
//   - 新パターン(多言語対応): notifyAdmins_({ ja: {subject, body}, en: {subject, body} }, preferredEmails, opts)
//   - 旧パターン(後方互換、常に日本語): notifyAdmins_(subject, body, preferredEmails, opts)
// 第1引数がオブジェクトかどうかで判別する。
// 宛先(同じ内容を、団体の通知先と管理者に重ねて送らない):
//   1. preferredEmails(報告先など、その人あての通知)があれば、その人たちだけ
//   2. 無ければ、団体の通知先(org_notification_emails)があればそこにすぐ送り、通知を受け取る設定にした管理者
//      (notify_new_task)は毎日のまとめに入れる(団体の通知先と同じアドレスなら1回だけ)
//   3. それも無ければ、通知を受け取る設定の管理者(いなければ管理者の役職の人)
// opts.urgent が無いものは、毎日のまとめに入れる。急ぎのものでも、Discord/Slack をつないだ団体では、
// 管理者あて(2・3)のメールはまとめに回す(すぐの知らせは Discord/Slack に届くため)
function notifyAdmins_(subject, body, preferredEmails, opts) {
  return measureAction_('notifyMs', function () { return notifyAdminsUnmeasured_(subject, body, preferredEmails, opts) })
}

function chatConnected_() {
  return !isChatSuppressed_() && !!(getDiscordWebhookUrl_() || getSlackWebhookUrl_())
}

function notifyAdminsUnmeasured_(subject, body, preferredEmails, opts) {
  try {
    var templates
    if (subject && typeof subject === 'object') {
      templates = subject
      opts = preferredEmails
      preferredEmails = body
    } else {
      templates = { ja: { subject: subject, body: body } }
    }
    var urgent = !!(opts && opts.urgent)

    if (preferredEmails && preferredEmails.length > 0) {
      var to = uniqueEmails_(preferredEmails)
      deliverNotification_(to, templates, urgent)
      console.log('notifyAdmins: preferredEmailsに' + (urgent ? '送信' : 'まとめに追加') + 'しました ' + maskEmailsIn_(to.join(',')))
      return
    }
    // Discord/Slack をつないだ団体では、管理者あてのメールはまとめに回す(evenIfChat: Webhook の変更の知らせなど、
    // Discord/Slack そのものが書き換えられたかもしれない時は、すぐ送る)
    if (urgent && !(opts && opts.evenIfChat) && chatConnected_()) urgent = false
    var orgEmails = orgNotificationEmails_()
    var members = measureAction_('recipientsMs', function () { return snapshotTableOrSheet_(SHEET_MEMBERS) })
    var headers = members.headers
    var rows = members.rows
    var idCol = headers.indexOf('id')
    var notifyCol = headers.indexOf('notify_new_task')
    var roleCol = headers.indexOf('role')
    var emailMap = getAllMemberEmails_()
    if (Object.keys(emailMap).length === 0 && orgEmails.length === 0) {
      console.warn('notifyAdmins: MemberEmailsにメール登録がなく、団体メールも未設定のため送信しませんでした')
      return
    }

    var opted = []
    var reps = []
    if (idCol !== -1) {
      rows.forEach(function (r) {
        var email = emailMap[String(r[idCol])]
        if (!email) return
        var notify = notifyCol !== -1 && /^(true|1|yes)$/i.test(String(r[notifyCol] || ''))
        if (notify) opted.push(email)
        // any admin-level role (i.e. not blank and not "一般") counts as a
        // fallback recipient — role names are freely renamed/added/removed
        // from Admin > Tags, so this can't hardcode a specific role string
        else if (roleCol !== -1 && isAdminRoleRef_(getRoles_(), r[roleCol])) reps.push(email)
      })
    }
    // 団体の通知先がある時: すぐ送るのは団体の通知先だけ。自分で通知を受け取る設定にした管理者(notify_new_task)には、
    // 毎日のまとめに入れる(団体の通知先と同じアドレスなら、団体の通知先への1回だけ)
    if (orgEmails.length > 0) {
      var org = splitEmails_(orgEmails)
      var orgSet = {}
      org.forEach(function (e) { orgSet[e.toLowerCase()] = true })
      deliverNotification_(org, templates, urgent)
      var optedOthers = splitEmails_(opted).filter(function (e) { return !orgSet[e.toLowerCase()] })
      if (optedOthers.length) deliverNotification_(optedOthers, templates, false)
      console.log('notifyAdmins: 団体の通知先に' + (urgent ? '送信' : 'まとめに追加') + 'しました' +
        (optedOthers.length ? '(通知を受け取る設定の管理者 ' + optedOthers.length + '人は、まとめに追加)' : ''))
      return
    }
    var recipients = uniqueEmails_(opted.length > 0 ? opted : reps)
    if (recipients.length === 0) {
      console.warn(
        'notifyAdmins: 宛先を解決できませんでした（notify_new_task=TRUEのメンバーがおらず、「一般」以外のroleを持つメンバーにメール登録もなく、団体メールも未設定）— 送信しませんでした',
      )
      return
    }

    deliverNotification_(recipients, templates, urgent)
    console.log('notifyAdmins: ' + (urgent ? '送信先 ' : 'まとめの宛先 ') + maskEmailsIn_(recipients.join(',')))
  } catch (err) {
    // a mail error shouldn't roll back the caller's action, but log it so
    // it's visible in Executions instead of failing completely silently
    console.error('notifyAdminsの送信に失敗しました: ' + maskEmailsIn_(String(err) + (err && err.stack ? '\n' + err.stack : '')))
  }
}

// Resolves the "admin of admins" recipients for a set of assignee member
// ids: each assignee's reports_to_id (if set) mapped to that member's
// email. Returns [] when nobody involved has a reports_to_id set, so
// callers fall back to notifyAdmins_' default opted-in/代表 logic.
function reportsToEmails_(assigneeIds) {
  return measureAction_('recipientsMs', function () {
    try {
      var members = snapshotTableOrSheet_(SHEET_MEMBERS)
      var idCol = members.headers.indexOf('id')
      var reportsToCol = members.headers.indexOf('reports_to_id')
      if (idCol === -1 || reportsToCol === -1) return []
      var emailMap = getAllMemberEmails_()

      var byId = {}
      members.rows.forEach(function (r) {
        byId[String(r[idCol])] = { reportsTo: String(r[reportsToCol] || '').trim() }
      })

      var emails = []
      ;(assigneeIds || []).forEach(function (aid) {
        var m = byId[String(aid)]
        var managerId = m && m.reportsTo
        var managerEmail = managerId && emailMap[managerId]
        if (managerEmail && emails.indexOf(managerEmail) === -1) {
          emails.push(managerEmail)
        }
      })
      return emails
    } catch (err) {
      console.error('reportsToEmailsの処理に失敗しました: ' + maskEmailsIn_(String(err)))
      return []
    }
  })
}

// Resolves member ids to their email addresses (skips members with no
// email on file). Used by the notifications (queueNotification_ など).
function memberEmailsByIds_(memberIds) {
  try {
    var emailMap = getAllMemberEmails_()
    var emails = []
    ;(memberIds || []).forEach(function (id) {
      var email = emailMap[String(id)]
      if (email) emails.push(email)
    })
    return emails
  } catch (err) {
    console.error('memberEmailsByIdsの処理に失敗しました: ' + maskEmailsIn_(String(err)))
    return []
  }
}

// メールアドレス一覧を受け取り、Membersシートを1回スキャンして
// { email: locale } のマップを返す（'en'以外は全て'ja'扱い）。
// 多言語メール送信（sendLocalizedEmail_）で、宛先ごとに言語を
// 出し分けるために使う。
function localesByEmails_(emails) {
  return measureAction_('recipientsMs', function () { return localesByEmailsUnmeasured_(emails) })
}

function localesByEmailsUnmeasured_(emails) {
  var result = {}
  if (!emails || emails.length === 0) return result
  var wanted = {}
  emails.forEach(function (e) { wanted[e.toLowerCase()] = true })
  try {
    // まずメールアドレス表で「wantedなメールを持つのはどのmemberIdか」を引く
    // (1人が複数メールをカンマ区切りで登録している場合にも対応)
    var emailMap = loadMemberEmailMap_()
    var idToMatchedEmails = {}
    Object.keys(emailMap).forEach(function (mid) {
      String(emailMap[mid] || '').split(',').map(function (e) { return e.trim() }).filter(Boolean).forEach(function (e) {
        if (wanted[e.toLowerCase()]) {
          if (!idToMatchedEmails[mid]) idToMatchedEmails[mid] = []
          idToMatchedEmails[mid].push(e)
        }
      })
    })
    if (Object.keys(idToMatchedEmails).length === 0) return result

    // 次にメンバー(スナップショット)でそのmemberIdのlocaleを引く
    var members = snapshotTableOrSheet_(SHEET_MEMBERS)
    var idCol = members.headers.indexOf('id')
    var localeCol = members.headers.indexOf('locale')
    if (idCol === -1) return result
    members.rows.forEach(function (r) {
      var mid = String(r[idCol])
      var matched = idToMatchedEmails[mid]
      if (!matched) return
      var locale = (localeCol !== -1 && String(r[localeCol]) === 'en') ? 'en' : 'ja'
      matched.forEach(function (e) { result[e] = locale })
    })
  } catch (err) {
    console.error('localesByEmailsの処理に失敗しました: ' + maskEmailsIn_(String(err)))
  }
  return result
}

// 宛先をlocaleごとにグループ化し、localeごとに言語を出し分けたメールを
// 送信する。templates は { ja: {subject, body}, en: {subject, body} } の形。
// localeが判明しない宛先は'ja'扱い（既存の全メール日本語固定という
// 挙動からの後方互換のため）。
function sendLocalizedEmail_(emails, templates) {
  if (!emails || emails.length === 0) return
  var locales = localesByEmails_(emails)
  var groups = { ja: [], en: [] }
  emails.forEach(function (e) {
    var loc = locales[e] || 'ja'
    groups[templates[loc] ? loc : 'ja'].push(e)
  })
  Object.keys(groups).forEach(function (loc) {
    var list = groups[loc]
    if (list.length === 0) return
    var tpl = templates[loc] || templates.ja
    // メールの1日の上限で送れなかった時は、宛先ごとの毎日のまとめに回す(翌朝のまとめで送る)
    if (sendMailChecked_({ to: list.join(','), subject: tpl.subject, body: tpl.body }) === 'quota') {
      list.forEach(function (e) { addToDigest_(e, loc, tpl.subject, tpl.body) })
    }
  })
}

