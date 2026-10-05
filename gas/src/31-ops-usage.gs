// ---- 毎日・毎時の処理の見張り ------------------------------------------------------------
//
// dailyMaintenance(毎朝)・sendBatchNotifications(毎時)が最後まで動いた時刻を JOB_STATE に記録する。
// レジストリへの確認(checkIn)で伝え、毎日の処理が DAILY_JOB_STALE_HOURS 時間以上成功していなければ、
// 代表の管理画面・レジストリの管理画面・監視の毎朝のまとめに出す(トリガーが消えた・権限が切れた・毎回失敗している時など)。
// setupOhsumi を実行した時刻から数え始める(installedAt)。どちらも無い団体(この版より前から使っていて、
// setupOhsumi をまだ実行していない団体)は、判定しない
var JOB_STATE_KEY = 'JOB_STATE'
var DAILY_JOB_STALE_HOURS = 26
var HOURLY_JOB_STALE_HOURS = 3

function readJobState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(JOB_STATE_KEY) || '{}') || {} } catch (e) { return {} }
}

function writeJobState_(s) {
  try { PropertiesService.getScriptProperties().setProperty(JOB_STATE_KEY, JSON.stringify(s)) } catch (e) { console.error('処理の記録を書けませんでした: ' + e) }
}

function recordJobRun_(kind, ok, err) {
  if (!ok) appendErrorLog_('job', kind === 'daily' ? 'dailyMaintenance' : 'sendBatchNotifications', errorKind_(err))
  var s = readJobState_()
  var now = new Date().toISOString()
  if (ok) {
    s[kind + 'At'] = now
  } else {
    s[kind + 'FailedAt'] = now
    s[kind + 'Error'] = maskEmailsIn_(String((err && err.message) || err || '')).slice(0, 300)
  }
  writeJobState_(s)
}

function recordJobsInstalled_(nowMs) {
  var s = readJobState_()
  s.installedAt = new Date(nowMs).toISOString()
  writeJobState_(s)
}

// 画面・レジストリに伝える形。stale: 最後に成功した時刻(無ければ setupOhsumi の時刻)から、決めた時間を過ぎた
function jobStatus_(nowMs) {
  var s = readJobState_()
  var staleOf = function (at, hours) {
    var base = Math.max(Date.parse(at || '') || 0, Date.parse(s.installedAt || '') || 0)
    return base > 0 ? nowMs - base > hours * 3600 * 1000 : false
  }
  return {
    dailyAt: String(s.dailyAt || ''), hourlyAt: String(s.hourlyAt || ''), installedAt: String(s.installedAt || ''),
    dailyFailedAt: String(s.dailyFailedAt || ''), dailyError: String(s.dailyError || ''),
    hourlyFailedAt: String(s.hourlyFailedAt || ''), hourlyError: String(s.hourlyError || ''),
    dailyStale: staleOf(s.dailyAt, tunable_('dailyJobStaleHours', DAILY_JOB_STALE_HOURS)),
    hourlyStale: staleOf(s.hourlyAt, tunable_('hourlyJobStaleHours', HOURLY_JOB_STALE_HOURS)),
    staleHours: tunable_('dailyJobStaleHours', DAILY_JOB_STALE_HOURS),
  }
}

// ---- スプレッドシート・フォルダの共有の確認 ------------------------------------------------
//
// setupOhsumi と毎日の処理で、団体のスプレッドシート・アップロード用のフォルダ・バックアップ用のフォルダの共有を確かめる。
// 許すのは、GAS のアカウント(持ち主)と、代表への「閲覧者」の共有だけ。次の時は SHARING_STATE に残し、代表の管理画面に
// 警告と直し方を出す(getOpsStatus):
//   link: リンクを知っている人・組織の全員などに共有している / editor: GAS のアカウント以外が編集者になっている
//   viewer: 代表以外の人に共有している(閲覧者・コメント可) / unknown: 確かめられなかった
var SHARING_STATE_KEY = 'SHARING_STATE'

function sharingTargets_() {
  var props = PropertiesService.getScriptProperties()
  var out = [{ key: 'spreadsheet', open: function () { return DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()) } }]
  var uploads = props.getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (uploads) out.push({ key: 'uploads', open: function () { return DriveApp.getFolderById(uploads) } })
  var backups = props.getProperty(BACKUP_FOLDER_PROPERTY_KEY)
  if (backups) out.push({ key: 'backups', open: function () { return DriveApp.getFolderById(backups) } })
  return out
}

function userEmailOf_(u) {
  try { return String((u && u.getEmail && u.getEmail()) || '').trim().toLowerCase() } catch (e) { return '' }
}

// 代表のメールアドレス(小文字。1人が複数持つ時はすべて)
function topEmailSet_() {
  var emails = getAllMemberEmails_()
  var set = {}
  topMemberIds_().forEach(function (id) {
    splitEmails_([emails[id] || '']).forEach(function (e) { set[e.toLowerCase()] = true })
  })
  return set
}

function checkSharing_(nowMs) {
  var me = ''
  try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase() } catch (e) { me = '' }
  var tops = topEmailSet_()
  var problems = []
  sharingTargets_().forEach(function (t) {
    try {
      var f = t.open()
      var access = String(f.getSharingAccess())
      if (access && access !== 'PRIVATE') problems.push({ target: t.key, kind: 'link', detail: access })
      f.getEditors().forEach(function (u) {
        var email = userEmailOf_(u)
        if (email && email !== me) problems.push({ target: t.key, kind: 'editor', detail: email })
      })
      f.getViewers().forEach(function (u) {
        var email = userEmailOf_(u)
        if (email && email !== me && !tops[email]) problems.push({ target: t.key, kind: 'viewer', detail: email })
      })
    } catch (e) {
      problems.push({ target: t.key, kind: 'unknown', detail: String((e && e.message) || e).slice(0, 200) })
    }
  })
  var state = { checkedAt: new Date(nowMs).toISOString(), problems: problems }
  try { PropertiesService.getScriptProperties().setProperty(SHARING_STATE_KEY, JSON.stringify(state)) } catch (e) { console.error('共有の確認の結果を書けませんでした: ' + e) }
  return state
}

function readSharingState_() {
  var s = null
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty(SHARING_STATE_KEY) || 'null') } catch (e) { s = null }
  return s && Array.isArray(s.problems) ? s : { checkedAt: '', problems: [] }
}

function sharingProblemText_(p) {
  var target = { spreadsheet: '団体のスプレッドシート', uploads: 'アップロード用のフォルダ', backups: 'バックアップ用のフォルダ' }[p.target] || p.target
  if (p.kind === 'link') return target + ': リンクを知っている人などに共有しています(' + p.detail + ')'
  if (p.kind === 'editor') return target + ': ' + p.detail + ' が編集者です'
  if (p.kind === 'viewer') return target + ': ' + p.detail + ' に共有しています'
  return target + ': 共有を確かめられませんでした(' + p.detail + ')'
}

// ---- 毎日・毎時の処理の中身(dailyMaintenance・sendBatchNotifications が、記録を付けて呼ぶ) ----

function sendBatchNotificationsUnrecorded_() {
  // 毎時のトリガーのついでに、書き込み待ちの最終ログイン日時をシートに書く
  try { flushPendingLastLogins_() } catch (e) { console.error('flushPendingLastLogins failed: ' + e) }
  // 提供停止中は、通知を送らない(機能停止中は送る)
  if (contractSuspendedNow_()) return
  // バックアップから戻している間は、通知のキューを書き換えない
  if (restoreInProgress_()) return
  var props = PropertiesService.getScriptProperties()
  var allProps = props.getProperties()
  var now = new Date()
  Object.keys(allProps).forEach(function(key) {
    if (!key.startsWith('notif_queue_')) return
    var memberId = key.replace('notif_queue_', '')
    var queue = JSON.parse(allProps[key] || '[]')
    if (queue.length === 0) return

    var emails = memberEmailsByIds_([memberId])
    if (emails.length === 0) {
      props.deleteProperty(key)
      return
    }
    // このキューは1メンバー分なので、locale判定も1回で済む
    var locales = localesByEmails_(emails)
    var loc = locales[emails[0]] || 'ja'

    // Filter by whether enough time has passed for each item based on member frequency
    var toSend = []
    var toKeep = []
    queue.forEach(function(item) {
      var freq = getNotifyFrequency_(memberId, item.kind)
      if (freq === 'none') return
      // 以前の版でキューに入った、急ぎでない種類・「1日ごと」のものは、毎日のまとめに移す
      if (!URGENT_NOTIFY_KINDS[item.kind] || freq === '1d') {
        var t = item.templates[loc] || item.templates.ja
        splitEmails_(emails).forEach(function (e) { addToDigest_(e, loc, t.subject, t.body) })
        return
      }
      if (freq === 'immediate') { toSend.push(item); return }
      var hours = freq === '3h' ? 3 : freq === '6h' ? 6 : 24
      var itemTime = new Date(item.ts)
      var elapsed = (now - itemTime) / 3600000
      if (elapsed >= hours) { toSend.push(item) } else { toKeep.push(item) }
    })

    if (toSend.length > 0) {
      var combined = toSend
        .map(function(i) {
          var tpl = i.templates[loc] || i.templates.ja
          return '【' + tpl.subject + '】\n' + tpl.body
        })
        .join('\n\n---\n\n')
      var subject = loc === 'en'
        ? 'Ohsumi Notification Summary (' + toSend.length + ')'
        : 'Ohsumi 通知まとめ (' + toSend.length + '件)'
      sendMail_({ to: emails.join(','), subject: subject, body: combined })
    }
    if (toKeep.length > 0) {
      props.setProperty(key, JSON.stringify(toKeep))
    } else {
      props.deleteProperty(key)
    }
  })
}

function dailyMaintenanceUnrecorded_() {
  // 提供停止中は、定期の処理を止める(機能停止中は続ける)
  if (contractSuspendedNow_()) return
  // バックアップから戻している間は、書き込む処理を止める
  if (restoreInProgress_()) return
  // 最初にバックアップを作る(この後の処理が失敗しても、今日のコピーは残る)
  dailyBackup_(Date.now())
  // 保存期間を過ぎた個人情報(退会したメンバー・採用しなかった候補者)を消す
  try { purgeExpiredPersonalDataLocked_(Date.now()) } catch (err) { console.error('個人情報を消せませんでした: ' + maskEmailsIn_(String(err))) }
  // ゴミ箱に入れてから30日たったタスクを消す
  try { purgeExpiredTrashLocked_(Date.now()) } catch (err) { console.error('ゴミ箱のタスクを消せませんでした: ' + String(err)) }
  // 完了してから日数がたったタスクを TasksArchive に移す
  try { archiveOldTasksLocked_(Date.now()) } catch (err) { console.error('古いタスクを移せませんでした: ' + String(err)) }
  try {
    generateRecurringTasksLocked_()
  } catch (err) {
    // best-effort — still run the overdue sweep below
  }
  notifyOverdueTasksToDiscord_()
  notifyOverdueTasksToAssignees_()
  // 活動のないメンバーの判定より前に、書き込み待ちの最終ログイン日時を書く
  try { flushPendingLastLogins_() } catch (err) { }
  try { notifyInactiveMembers_() } catch (err) { }
  // 毎日のまとめ(1人1日1通)。上の処理で入れたものも、ここで送る
  try { flushDailyDigests_() } catch (err) { console.error('毎日のまとめを送れませんでした: ' + maskEmailsIn_(String(err))) }
  // スプレッドシート・フォルダの共有を確かめる(問題があれば代表の管理画面に出す)
  try { checkSharing_(Date.now()) } catch (err) { console.error('共有を確かめられませんでした: ' + maskEmailsIn_(String(err))) }
  // 定期タスクの生成などでシートが変わるため、読み取りキャッシュを無効にする
  bumpDataVersion()
}

// ---- 利用の集計とエラーの記録 ----
//
// 利用の集計(UsageDaily シート: date, kind, count): ログイン(login)・画面の読み込み(open)・書き込みの操作(操作の名前)の、
// 日ごとの回数だけを残す。誰の操作かは残さない。団体の外には送らない。
//   - リクエストごとに、キャッシュの1時間ごとの箱(usage:yyyy-MM-dd-HH)に足し、毎時の処理で前の時間の箱をシートに移す
//   - 同時に来た読み込みは数え漏れることがある(おおよその回数)
// エラーの記録(ErrorLog シート: at, source, action, kind): GAS と画面のエラーを、日時・操作の名前・エラーの種類だけ、
// 直近 ERROR_LOG_KEEP 件まで残す。リクエストの中身・エラーの文・個人情報は残さない。
var USAGE_SHEET = 'UsageDaily'
var USAGE_HEADERS = ['date', 'kind', 'count']
var USAGE_KEEP_DAYS = 400
var ERROR_LOG_SHEET = 'ErrorLog'
var ERROR_LOG_HEADERS = ['at', 'source', 'action', 'kind']
var ERROR_LOG_KEEP = 500
var USAGE_NOT_COUNTED = ['ping', 'getLoginConfig', 'reportClientError', 'getUsageStatus']

function usageBucketKey_(ms) {
  return 'usage:' + Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd-HH')
}

// このリクエストで数える種類(ログイン・読み込み・成功した書き込みの操作)。送り直しの応答は数えない
function usageKindsOf_(body, out) {
  if (!body || !out || out.replayed || !out.ok) return []
  var a = String(body.action || '')
  if (USAGE_NOT_COUNTED.indexOf(a) >= 0) return []
  if (a === 'exchangeIdToken') return out.result && out.result.memberId ? ['login'] : []
  if (a === 'getInitialData') return ['open']
  if (a === 'batch') {
    var results = (out.result && out.result.results) || []
    return (body.ops || []).filter(function (op, i) { return op && results[i] && results[i].ok }).map(function (op) { return String(op.action) })
  }
  if (READ_ONLY_ACTIONS.indexOf(a) >= 0 || LOCK_EXEMPT_ACTIONS.indexOf(a) >= 0) return []
  return [a]
}

function noteRequestUsage_(body, out) {
  try {
    var kinds = usageKindsOf_(body, out)
    if (!kinds.length) return
    var cache = CacheService.getScriptCache()
    var key = usageBucketKey_(Date.now())
    var counts = {}
    try { counts = JSON.parse(cache.get(key) || '{}') || {} } catch (e) { counts = {} }
    kinds.forEach(function (k) { counts[k] = (Number(counts[k]) || 0) + 1 })
    cache.put(key, JSON.stringify(counts), 21600)
  } catch (e) {
    // 数えられなくても応答は返す
  }
}

// 前の時間(今の時間より前、6時間以内)の箱を読む。{ 'yyyy-MM-dd': { kind: n } }
function pendingUsage_(nowMs, includeCurrent) {
  var keys = []
  for (var h = includeCurrent ? 0 : 1; h <= 6; h++) keys.push(usageBucketKey_(nowMs - h * 3600 * 1000))
  var got = CacheService.getScriptCache().getAll(keys) || {}
  var byDate = {}
  Object.keys(got).forEach(function (key) {
    var date = key.slice('usage:'.length, 'usage:'.length + 10)
    var counts = {}
    try { counts = JSON.parse(got[key] || '{}') || {} } catch (e) { counts = {} }
    var d = byDate[date] || (byDate[date] = {})
    Object.keys(counts).forEach(function (k) { d[k] = (d[k] || 0) + (Number(counts[k]) || 0) })
  })
  return { keys: Object.keys(got), byDate: byDate }
}

function readUsageSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USAGE_SHEET)
  var map = {}
  if (!sheet || sheet.getLastRow() < 2) return map
  var values = sheet.getDataRange().getValues()
  var headers = values[0].map(String)
  var dc = headers.indexOf('date'), kc = headers.indexOf('kind'), cc = headers.indexOf('count')
  for (var i = 1; i < values.length; i++) {
    var date = values[i][dc] instanceof Date ? Utilities.formatDate(values[i][dc], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(values[i][dc])
    var d = map[date] || (map[date] = {})
    d[String(values[i][kc])] = (d[String(values[i][kc])] || 0) + (Number(values[i][cc]) || 0)
  }
  return map
}

// 前の時間の箱をシートに移す(毎時の処理)。シートは日付の新しい順に書き直し、USAGE_KEEP_DAYS より古い日は消す
function flushUsage_(nowMs) {
  var pending = pendingUsage_(nowMs, false)
  if (!pending.keys.length) return 0
  var map = readUsageSheet_()
  Object.keys(pending.byDate).forEach(function (date) {
    var d = map[date] || (map[date] = {})
    Object.keys(pending.byDate[date]).forEach(function (k) { d[k] = (d[k] || 0) + pending.byDate[date][k] })
  })
  var oldest = Utilities.formatDate(new Date(nowMs - USAGE_KEEP_DAYS * 24 * 3600 * 1000), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var rows = []
  Object.keys(map).sort().reverse().forEach(function (date) {
    if (date < oldest) return
    Object.keys(map[date]).sort().forEach(function (k) { rows.push([date, k, map[date][k]]) })
  })
  var sheet = getOrCreateSheet_(USAGE_SHEET, USAGE_HEADERS)
  sheet.clearContents()
  sheet.getRange(1, 1, 1, USAGE_HEADERS.length).setValues([USAGE_HEADERS])
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@')
    sheet.getRange(2, 1, rows.length, USAGE_HEADERS.length).setValues(rows)
  }
  CacheService.getScriptCache().removeAll(pending.keys)
  return rows.length
}

// エラーの種類(文は残さない)。業務上の断り(userError_)は、競合・長すぎるなどの目印のあるものだけ
function errorKind_(err) {
  if (!err) return 'unknown'
  if (err.conflict) return 'conflict'
  if (err.cellTooLong) return 'cellTooLong'
  var quota = quotaKind_(err)
  if (quota) return 'quota:' + quota
  if (isPermissionError_(err)) return 'permission'
  if (err.isUserError) return ''
  return 'unexpected:' + String(err.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)
}

function logGasError_(err, action) {
  var kind = errorKind_(err)
  if (kind) appendErrorLog_('gas', action, kind)
}

function appendErrorLog_(source, action, kind) {
  try {
    var safeAction = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(String(action || '')) ? String(action) : ''
    var safeKind = String(kind || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || 'unknown'
    var sheet = getOrCreateSheet_(ERROR_LOG_SHEET, ERROR_LOG_HEADERS)
    var values = { at: new Date().toISOString(), source: String(source), action: safeAction, kind: safeKind }
    var headers = headerRow_(sheet)
    sheet.appendRow(headers.map(function (h) { return values[h] === undefined ? '' : values[h] }))
    var extra = sheet.getLastRow() - 1 - ERROR_LOG_KEEP
    // 多くなったら、古い行をまとめて消す(毎回は消さない)
    if (extra >= 100) sheet.deleteRows(2, extra)
  } catch (e) {
    // 記録できなくても、元の処理は続ける
  }
}

// 画面のエラーの記録。種類と操作の名前だけを受け取る(文・中身は受け取らない)。1人1時間 RATE_LIMITS.clientError 件まで
function reportClientError_(body, actorId) {
  var kind = String((body && body.kind) || '')
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(kind)) throw userError_('エラーの種類の形式が不正です。')
  if (!takeRateLimit_('clientError', actorId, 1)) return false
  appendErrorLog_('client', body.errorAction, kind)
  return true
}

// 代表の管理画面に出す、利用の集計(直近14日の毎日と、30日の操作の上位)とエラーの件数
function usageStatus_(nowMs) {
  var map = readUsageSheet_()
  var pending = pendingUsage_(nowMs, true).byDate
  Object.keys(pending).forEach(function (date) {
    var d = map[date] || (map[date] = {})
    Object.keys(pending[date]).forEach(function (k) { d[k] = (d[k] || 0) + pending[date][k] })
  })
  var tz = Session.getScriptTimeZone()
  var dayOf = function (back) { return Utilities.formatDate(new Date(nowMs - back * 24 * 3600 * 1000), tz, 'yyyy-MM-dd') }
  var days = []
  for (var i = 13; i >= 0; i--) {
    var date = dayOf(i)
    var d = map[date] || {}
    var writes = 0
    Object.keys(d).forEach(function (k) { if (k !== 'login' && k !== 'open') writes += d[k] })
    days.push({ date: date, login: d.login || 0, open: d.open || 0, writes: writes })
  }
  var since30 = dayOf(29)
  var actions = {}
  Object.keys(map).forEach(function (date) {
    if (date < since30) return
    Object.keys(map[date]).forEach(function (k) { if (k !== 'login' && k !== 'open') actions[k] = (actions[k] || 0) + map[date][k] })
  })
  var topActions = Object.keys(actions).map(function (k) { return { action: k, count: actions[k] } })
    .sort(function (a, b) { return b.count - a.count }).slice(0, 10)
  // エラー
  var recent = []
  var byKind = {}
  var last7 = 0
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ERROR_LOG_SHEET)
  if (sheet && sheet.getLastRow() >= 2) {
    var values = sheet.getDataRange().getValues()
    var h = values[0].map(String)
    var since7 = nowMs - 7 * 24 * 3600 * 1000
    for (var r = values.length - 1; r >= 1; r--) {
      var at = values[r][h.indexOf('at')]
      var atIso = at instanceof Date ? at.toISOString() : String(at)
      var row = { at: atIso, source: String(values[r][h.indexOf('source')]), action: String(values[r][h.indexOf('action')]), kind: String(values[r][h.indexOf('kind')]) }
      if (recent.length < 20) recent.push(row)
      if (Date.parse(atIso) >= since7) {
        last7++
        byKind[row.kind] = (byKind[row.kind] || 0) + 1
      }
    }
  }
  return {
    days: days,
    topActions: topActions,
    errors: {
      last7Days: last7,
      byKind: Object.keys(byKind).map(function (k) { return { kind: k, count: byKind[k] } }).sort(function (a, b) { return b.count - a.count }),
      recent: recent,
    },
  }
}

// ---- 実行ログにメールアドレスを出さない ----
// 文の中のメールアドレスを、先頭の1文字とドメインだけ残して伏せる(a***@example.com)。実行ログ・エラーの記録に使う
function maskEmailsIn_(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, '$1***@$2')
}

// ---- Google の許可(マニフェストの oauthScopes) ----
// gas/appsscript.json の oauthScopes に書いた許可だけを使う(コードが使うサービスから自動で決めない)。
// 許可が足りない時は、その操作だけを止め、直し方を返す(通知・カレンダー・共有の確かめなど、操作の一部だけのものは、
// これまでどおり、その部分だけを飛ばして操作は済ませる)
var PERMISSION_MESSAGE = 'この機能に必要な Google の許可がありません。GAS を動かしているアカウントで Apps Script エディタを開き、setupOhsumi を実行して許可してください。'

function isPermissionError_(err) {
  var msg = String((err && err.message) || err || '')
  return /You do not have permission to call|Required permissions:|Authorization is required|権限がありません.*(必要な権限|許可)/i.test(msg)
}

