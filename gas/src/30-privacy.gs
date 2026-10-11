// ---- 個人情報の削除(退会したメンバー・採用しなかった候補者) -----------------------------------
//
// 退会(removeMember)は、押した時点ではメンバーを非表示にして保留する: ログインできなくし(inactive)、
// 未完了のタスクは未アサインに戻す(完了・確認待ちのタスクの担当は残す)。個人情報は、保存期間
// (Settings の personal_data_retention_days。既定 30 日、代表が 7〜365 日で変えられる)を過ぎたら、毎日の処理で消す。
// 期限の前なら、代表は「退会を取り消す」「すぐ消す」「延長」ができる。
//   - 退会したメンバー: メールアドレス(MemberEmails の行)・プロフィール・Will・スキル・自己申告の実績・1on1 の記録・
//     ログインの記録を消す。Members の行は ID と役職だけを残し、名前を「退会したメンバー」にする
//     (タスクの担当・コメント・変更の記録の書いた人は、ID のまま残り、画面には「退会したメンバー」と出る)
//   - 採用しなかった候補者(Candidates の status が rejected): 行ごと消す
// 消す PERSONAL_DATA_NOTICE_DAYS 日前から、代表の管理画面に「○人分を○日に消します」と出す(getPersonalDataStatus)。
// バックアップから戻した直後にも、期限を過ぎた分を消し直す。消したことは操作の記録(AuditLog)に残す。
// 消した人の ID は、スクリプトプロパティ(PURGED_PERSONAL_DATA_<番号>。戻しても変わらない)にも残し、
// バックアップから戻した後に、戻ってきた個人情報(メンバーの行・MemberEmails の行・候補者の行)をもう一度消す
// (reapplyPersonalDataPurges_。この印を残す前に消した人は、操作の記録 AuditLog から読む。AuditLog は戻さない)
var PERSONAL_DATA_RETENTION_KEY = 'personal_data_retention_days'
var PERSONAL_DATA_RETENTION = { min: 7, max: 365, defaultDays: 30 }
var PERSONAL_DATA_NOTICE_DAYS = 7
var WITHDRAWN_MEMBER_NAME = '退会したメンバー'
var WITHDRAWN_MEMBER_MESSAGE = 'このアカウントは退会しています。もう一度使う時は、代表に依頼してください。'
// 消した後も Members に残す列(これ以外は空にする)
var MEMBER_COLUMNS_KEPT_AFTER_PURGE = ['id', 'name', 'role', 'inactive', 'withdrawn_at', 'purge_at', 'personal_data_purged_at']
// 退会の時に担当を残すタスクの状態(それ以外は未アサインに戻す)
var WITHDRAW_KEEP_ASSIGNEE_STATUSES = ['done', 'review']
// 消した人の ID の一覧(スクリプトプロパティ)。1つの値は 9KB までなので、PURGED_IDS_CHUNK 文字ずつに分ける
var PURGED_IDS_PREFIX = 'PURGED_PERSONAL_DATA_'
var PURGED_IDS_CHUNK = 8000

function personalDataRetentionDays_() {
  var n = Math.floor(Number(getSettingValue_(PERSONAL_DATA_RETENTION_KEY)))
  if (!(n >= PERSONAL_DATA_RETENTION.min && n <= PERSONAL_DATA_RETENTION.max)) return PERSONAL_DATA_RETENTION.defaultDays
  return n
}

function timeOfCell_(v) {
  if (v instanceof Date) return v.getTime()
  var t = Date.parse(String(v || ''))
  return isFinite(t) ? t : NaN
}

// 消す日時(ミリ秒)。延長した時は purge_at、それ以外は 退会・不採用の日時 + 保存期間
function purgeDeadlineOf_(row, kind, days) {
  var explicit = timeOfCell_(row.purge_at)
  if (explicit > 0) return explicit
  var since = kind === 'member' ? timeOfCell_(row.withdrawn_at) : (timeOfCell_(row.rejected_at) > 0 ? timeOfCell_(row.rejected_at) : timeOfCell_(row.updated_at))
  return since > 0 ? since + days * 24 * 3600 * 1000 : NaN
}

function sheetRowsAsObjects_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
  if (!sheet) return []
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  return values.slice(1).map(function (r) {
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    return o
  }).filter(function (o) { return String(o.id || '') })
}

// 消す前の人の一覧: { kind: member | candidate, id, name, since, purgeAt }
function pendingPersonalData_(days) {
  var out = []
  sheetRowsAsObjects_(SHEET_MEMBERS).forEach(function (m) {
    if (!String(m.withdrawn_at || '') || String(m.personal_data_purged_at || '')) return
    var at = purgeDeadlineOf_(m, 'member', days)
    out.push({ kind: 'member', id: String(m.id), name: String(m.display_name || m.name || ''), since: new Date(timeOfCell_(m.withdrawn_at)).toISOString(),
      purgeAt: at > 0 ? new Date(at).toISOString() : '', extended: timeOfCell_(m.purge_at) > 0 })
  })
  sheetRowsAsObjects_(SHEET_CANDIDATES).forEach(function (c) {
    if (String(c.status || '') !== 'rejected') return
    var at = purgeDeadlineOf_(c, 'candidate', days)
    var since = timeOfCell_(c.rejected_at) > 0 ? timeOfCell_(c.rejected_at) : timeOfCell_(c.updated_at)
    out.push({ kind: 'candidate', id: String(c.id), name: String(c.name || ''), since: since > 0 ? new Date(since).toISOString() : '',
      purgeAt: at > 0 ? new Date(at).toISOString() : '', extended: timeOfCell_(c.purge_at) > 0 })
  })
  out.sort(function (a, b) { return String(a.purgeAt).localeCompare(String(b.purgeAt)) })
  return out
}

// 管理画面(代表): 保存期間・消す前の人・7日以内に消す人数(日ごと)
function personalDataStatus_(nowMs) {
  var days = personalDataRetentionDays_()
  var pending = pendingPersonalData_(days)
  var tz = Session.getScriptTimeZone()
  var byDate = {}
  pending.forEach(function (p) {
    var at = Date.parse(p.purgeAt)
    if (!(at > 0) || at - nowMs > tunable_('personalDataNoticeDays', PERSONAL_DATA_NOTICE_DAYS) * 24 * 3600 * 1000) return
    var d = Utilities.formatDate(new Date(Math.max(at, nowMs)), tz, 'yyyy-MM-dd')
    byDate[d] = (byDate[d] || 0) + 1
  })
  return {
    retentionDays: days, min: PERSONAL_DATA_RETENTION.min, max: PERSONAL_DATA_RETENTION.max, noticeDays: tunable_('personalDataNoticeDays', PERSONAL_DATA_NOTICE_DAYS),
    pending: pending,
    orphanEmails: orphanEmailRows_(),
    upcoming: Object.keys(byDate).sort().map(function (d) { return { date: d, count: byDate[d] } }),
  }
}

function setPersonalDataRetention_(days, actorId) {
  var n = Math.floor(Number(days))
  if (!(n >= PERSONAL_DATA_RETENTION.min && n <= PERSONAL_DATA_RETENTION.max)) {
    throw userError_('保存期間は ' + PERSONAL_DATA_RETENTION.min + '〜' + PERSONAL_DATA_RETENTION.max + ' 日の間で決めてください。')
  }
  var before = personalDataRetentionDays_()
  updateSetting_(PERSONAL_DATA_RETENTION_KEY, String(n))
  appendOrgAudit_(actorId, 'setPersonalDataRetention', '', { before: before, after: n })
  return { retentionDays: n }
}

// 消した人の ID: { member: {ID: true}, candidate: {ID: true} }。スクリプトプロパティと、操作の記録(AuditLog)の両方から読む
function purgedPersonalIds_() {
  var out = { member: {}, candidate: {} }
  var add = function (key) {
    var i = String(key).indexOf(':')
    var kind = String(key).slice(0, i)
    if (i > 0 && out[kind] && String(key).slice(i + 1)) out[kind][String(key).slice(i + 1)] = true
  }
  readPurgedIdKeys_().forEach(add)
  auditLogEntries_().forEach(function (e) {
    if (e.action === 'purgePersonalDataNow') { add(e.target); return }
    if (e.action !== 'purgePersonalData') return
    var d = null
    try { d = JSON.parse(e.detail || '{}') } catch (err) { d = null }
    if (!d) return
    ;(Array.isArray(d.members) ? d.members : []).forEach(function (id) { add('member:' + id) })
    ;(Array.isArray(d.candidates) ? d.candidates : []).forEach(function (id) { add('candidate:' + id) })
  })
  return out
}

// 操作の記録(AuditLog)の行: { action, target, detail }
function auditLogEntries_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AuditLog')
  if (!sheet || sheet.getLastRow() < 2) return []
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var a = headers.indexOf('action'), t = headers.indexOf('target'), d = headers.indexOf('detail_json')
  if (a < 0) return []
  return values.slice(1).map(function (r) {
    return { action: String(r[a] || ''), target: t >= 0 ? String(r[t] || '') : '', detail: d >= 0 ? String(r[d] || '') : '' }
  })
}

// スクリプトプロパティに残した「種類:ID」の一覧
function readPurgedIdKeys_() {
  var props = PropertiesService.getScriptProperties().getProperties()
  var out = []
  for (var i = 0; props[PURGED_IDS_PREFIX + i] !== undefined && props[PURGED_IDS_PREFIX + i] !== null; i++) {
    var list = null
    try { list = JSON.parse(props[PURGED_IDS_PREFIX + i]) } catch (e) { list = null }
    if (Array.isArray(list)) list.forEach(function (k) { out.push(String(k)) })
  }
  return out
}

// 消した人を、スクリプトプロパティの一覧に足す(kind: member | candidate)
function rememberPurgedId_(kind, id) {
  var key = kind + ':' + String(id)
  var keys = readPurgedIdKeys_()
  if (keys.indexOf(key) >= 0) return
  keys.push(key)
  var chunks = []
  var cur = []
  var size = 2
  keys.forEach(function (k) {
    var len = JSON.stringify(k).length + 1
    if (cur.length && size + len > PURGED_IDS_CHUNK) { chunks.push(cur); cur = []; size = 2 }
    cur.push(k)
    size += len
  })
  if (cur.length) chunks.push(cur)
  var props = PropertiesService.getScriptProperties()
  var values = {}
  chunks.forEach(function (c, i) { values[PURGED_IDS_PREFIX + i] = JSON.stringify(c) })
  props.setProperties(values)
}

// 消した人(退会したメンバー・採用しなかった候補者)の個人情報が、バックアップから戻したことで戻ってきていたら、もう一度消す。
// メンバー: 名前・個人情報の列が残っている(消した印が無い・ログインできる)なら消し直し、MemberEmails の行は必ず消す。
// 候補者: 行ごと消す。ロックを取った中で呼ぶ。消し直した ID を返す
function reapplyPersonalDataPurges_(nowMs, actorId) {
  var ids = purgedPersonalIds_()
  var done = { members: [], candidates: [], emailRows: 0 }
  if (!Object.keys(ids.member).length && !Object.keys(ids.candidate).length) return done
  var nowIso = new Date(nowMs).toISOString()
  sheetRowsAsObjects_(SHEET_MEMBERS).forEach(function (m) {
    var id = String(m.id)
    if (!ids.member[id]) return
    var left = Object.keys(m).some(function (h) {
      return h && MEMBER_COLUMNS_KEPT_AFTER_PURGE.indexOf(h) < 0 && String(m[h] === null || m[h] === undefined ? '' : m[h]) !== ''
    })
    if (!left && String(m.personal_data_purged_at || '') && boolCellValue_(m.inactive) && String(m.name) === WITHDRAWN_MEMBER_NAME) return
    purgeMember_(id, nowMs)
    // 退会の前のバックアップから戻した時は、退会した日時も無いので、消した日時を入れる
    if (!String(m.withdrawn_at || '')) updateRowFields_(SHEET_MEMBERS, id, { withdrawn_at: nowIso })
    done.members.push(id)
  })
  done.emailRows = deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return !!ids.member[String(o.id)] })
  deleteRowsWhere_(SHEET_CANDIDATES, function (o) {
    if (!ids.candidate[String(o.id)]) return false
    done.candidates.push(String(o.id))
    return true
  })
  if (done.emailRows) bumpMemberEmailsVersion_()
  if (done.members.length || done.candidates.length || done.emailRows) {
    appendOrgAudit_(actorId || 'system', 'reapplyPersonalDataPurge', '', done)
    bumpDataVersion()
  }
  return done
}

// 採用しなかった候補者の個人情報を消す(行ごと)
function purgeCandidate_(candidateId) {
  rememberPurgedId_('candidate', candidateId)
  deleteRowsWhere_(SHEET_CANDIDATES, function (o) { return String(o.id) === String(candidateId) })
}

// 退会したメンバーの個人情報を消す
function purgeMember_(memberId, nowMs) {
  // 先に印を残す(途中で止まっても、バックアップから戻した後に消し直せるように)
  rememberPurgedId_('member', memberId)
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var fields = {}
  headers.forEach(function (h) {
    if (!h || MEMBER_COLUMNS_KEPT_AFTER_PURGE.indexOf(h) >= 0) return
    fields[h] = ''
  })
  fields.name = WITHDRAWN_MEMBER_NAME
  fields.inactive = 'TRUE'
  fields.purge_at = ''
  fields.personal_data_purged_at = new Date(nowMs).toISOString()
  // メールアドレスは、カレンダー・まとめ・キューの片付けに使ってから消す
  var emails = String(getAllMemberEmails_()[String(memberId)] || '')
  // カレンダーの予定のゲストからメールアドレスを外し、プロフィール画像のファイルを消す(できなくても、ほかの削除は済ませる)。
  // 時間のかかる処理を先に済ませ、消した印(personal_data_purged_at)は最後に書く。途中で止まった時は
  // 印が無いので、次の日にもう一度消す(どの処理も、2回行っても同じ結果になる)
  removeCalendarGuest_(emails, nowMs)
  trashAvatarFiles_(memberId)
  deletePersonalStore_(memberId)
  forgetPersonalProps_(memberId, emails)
  deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return String(o.id) === String(memberId) })
  bumpMemberEmailsVersion_()
  updateRowFields_(SHEET_MEMBERS, memberId, fields)
}

// 個人情報を消す時に、カレンダーの予定([Ohsumi] で始まる予定。前後 PURGE_CALENDAR_DAYS 日)のゲストから、そのメールアドレスを外す
var PURGE_CALENDAR_DAYS = 400
var PURGE_CALENDAR_MAX_EVENTS = 3000
function removeCalendarGuest_(emails, nowMs) {
  var list = splitEmails_([emails]).map(function (e) { return e.toLowerCase() })
  if (!list.length) return 0
  var removed = 0
  try {
    var cal = CalendarApp.getDefaultCalendar()
    var span = PURGE_CALENDAR_DAYS * 24 * 3600 * 1000
    var events = cal.getEvents(new Date(nowMs - span), new Date(nowMs + span), { search: '[Ohsumi]' }) || []
    events.slice(0, PURGE_CALENDAR_MAX_EVENTS).forEach(function (ev) {
      if (String(ev.getTitle()).indexOf('[Ohsumi]') !== 0) return
      list.forEach(function (email) {
        if (ev.getGuestByEmail(email)) {
          ev.removeGuest(email)
          removed++
        }
      })
    })
  } catch (e) {
    console.warn('カレンダーの予定のゲストを外せませんでした: ' + maskEmailsIn_(String(e)))
  }
  return removed
}

// 個人情報を消す時に、プロフィール画像のファイル(アップロード用のフォルダの avatar_<メンバーID>_…)をゴミ箱に移す
// (ゴミ箱のファイルは、Google ドライブが30日後に消す)
function trashAvatarFiles_(memberId) {
  var trashed = 0
  try {
    var folderId = PropertiesService.getScriptProperties().getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
    if (!folderId) return 0
    var prefix = 'avatar_' + memberId + '_'
    var files = DriveApp.getFolderById(folderId).getFiles()
    while (files.hasNext()) {
      var f = files.next()
      if (String(f.getName()).indexOf(prefix) === 0) {
        f.setTrashed(true)
        trashed++
      }
    }
  } catch (e) {
    console.warn('プロフィール画像のファイルを消せませんでした: ' + maskEmailsIn_(String(e)))
  }
  return trashed
}

// メンバーに結び付いたスクリプトプロパティ(通知のキュー・毎日のまとめ・書き込み待ちの最終ログイン)を消す
function forgetPersonalProps_(memberId, emails) {
  var props = PropertiesService.getScriptProperties()
  var keys = Object.keys(props.getProperties())
  var drop = {}
  drop['notif_queue_' + memberId] = true
  splitEmails_([emails]).forEach(function (e) { drop[digestKey_(e)] = true })
  keys.forEach(function (k) {
    if (drop[k] || k.indexOf(LAST_LOGIN_PENDING_PREFIX + memberId + '_') === 0) props.deleteProperty(k)
  })
}

// 条件に合う行を消す(下の行から)。消した数を返す
function deleteRowsWhere_(sheetName, test) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
  if (!sheet) return 0
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var removed = 0
  for (var i = values.length - 1; i >= 1; i--) {
    var o = {}
    headers.forEach(function (h, c) { o[h] = values[i][c] })
    if (test(o)) {
      sheet.deleteRow(i + 1)
      removed++
    }
  }
  if (removed) forgetSheetGrid_(sheetName)
  return removed
}

// 毎日の処理で個人情報を消すのに使ってよい時間(消し始めてから)。1人ずつ、カレンダーの予定(前後 400 日)と
// アップロード用のフォルダを調べるため、人数が多いと GAS の1回の実行の上限(6分)に届くことがある。
// 時間を過ぎたら、残りの人は次の日に回す
var PURGE_TIME_BUDGET_MS = 150 * 1000

// 期限を過ぎた個人情報を消す(毎日の処理・バックアップから戻した直後)。ロックを取った中で呼ぶ。
// deadlineMs(省略可)を過ぎたら、まだ消していない人は次の回に回す(done.deferred に人数)。
// 1人分の途中では止めない(消した印は、その人の分をすべて済ませてから書く。purgeMember_)
function purgeExpiredPersonalData_(nowMs, actorId, deadlineMs) {
  var days = personalDataRetentionDays_()
  var done = { members: [], candidates: [] }
  var deferred = 0
  pendingPersonalData_(days).forEach(function (p) {
    var at = Date.parse(p.purgeAt)
    if (!(at > 0) || at > nowMs) return
    if (deadlineMs && Date.now() >= deadlineMs) {
      deferred++
      return
    }
    if (p.kind === 'member') {
      purgeMember_(p.id, nowMs)
      done.members.push(p.id)
    } else {
      purgeCandidate_(p.id)
      done.candidates.push(p.id)
    }
  })
  if (deferred) {
    done.deferred = deferred
    console.warn('個人情報を消す時間の上限に達したため、' + deferred + '件を次の日に回しました')
  }
  // 対応するメンバーがいないメールアドレスの行は、ここでは消さない(代表が一覧を確かめて消す。orphanEmailRows_)
  if (done.members.length || done.candidates.length) {
    appendOrgAudit_(actorId || 'system', 'purgePersonalData', '', done)
    bumpDataVersion()
  }
  return done
}

// 対応するメンバーがいないメールアドレスの行(MemberEmails の ID が、Members に無い・個人情報を消したメンバーのもの)。
// 以前の退会(行を消していた)で残った行のほか、メンバーID の対応がずれている時にも出る。
// 今いるメンバーのメールアドレスを消してログインできなくするおそれがあるので、自動では消さない
// (代表の管理画面に件数と一覧を出し、代表が確かめて「消す」を押した時だけ消す。deleteOrphanEmails_)。
// Members が読めない(空)時は、何も出さない
function orphanEmailRows_() {
  var members = sheetRowsAsObjects_(SHEET_MEMBERS)
  if (!members.length) return []
  var active = {}
  members.forEach(function (m) { if (!String(m.personal_data_purged_at || '')) active[String(m.id)] = true })
  var out = []
  sheetRowsAsObjects_(SHEET_MEMBER_EMAILS).forEach(function (o) {
    if (!active[String(o.id)]) out.push({ id: String(o.id), email: String(o.email || '') })
  })
  return out
}

// 代表: 一覧で確かめた行だけを消す(画面が送った ID のうち、今も対応するメンバーがいないものだけ)
function deleteOrphanEmails_(ids, actorId) {
  var wanted = {}
  ;(Array.isArray(ids) ? ids : []).forEach(function (id) { if (id !== null && id !== undefined && String(id)) wanted[String(id)] = true })
  if (!Object.keys(wanted).length) throw userError_('消す行を選んでください。')
  var orphan = {}
  orphanEmailRows_().forEach(function (o) { orphan[o.id] = true })
  var targets = Object.keys(wanted).filter(function (id) { return orphan[id] })
  var removed = targets.length ? deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return targets.indexOf(String(o.id)) >= 0 }) : 0
  if (removed) {
    bumpMemberEmailsVersion_()
    appendOrgAudit_(actorId, 'deleteOrphanEmails', '', { ids: targets, rows: removed })
  }
  return { deleted: removed, skipped: Object.keys(wanted).length - targets.length }
}

// 毎日の処理から(ロックを取る)。消し始めてから PURGE_TIME_BUDGET_MS を過ぎたら、残りは次の日に回す
function purgeExpiredPersonalDataLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return purgeExpiredPersonalData_(nowMs, 'system', Date.now() + PURGE_TIME_BUDGET_MS)
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

function pendingEntryOf_(kind, id) {
  var found = null
  pendingPersonalData_(personalDataRetentionDays_()).forEach(function (p) { if (p.kind === kind && p.id === String(id)) found = p })
  if (!found) throw userError_('消す前の人の一覧に見つかりません。画面を読み直してください。')
  return found
}

// 代表: 特定の人だけ、すぐ消す
function purgePersonalDataNow_(kind, id, actorId, nowMs) {
  var p = pendingEntryOf_(kind, id)
  if (kind === 'member') purgeMember_(p.id, nowMs)
  else purgeCandidate_(p.id)
  appendOrgAudit_(actorId, 'purgePersonalDataNow', kind + ':' + p.id, {})
  return { purged: { kind: kind, id: p.id } }
}

// 代表: 消す日を、保存期間の分だけ延ばす(今から PERSONAL_DATA_RETENTION.max 日まで)
function extendPersonalData_(kind, id, actorId, nowMs) {
  var p = pendingEntryOf_(kind, id)
  var days = personalDataRetentionDays_()
  var base = Math.max(Date.parse(p.purgeAt) || nowMs, nowMs)
  var next = Math.min(base + days * 24 * 3600 * 1000, nowMs + PERSONAL_DATA_RETENTION.max * 24 * 3600 * 1000)
  var iso = new Date(next).toISOString()
  if (kind === 'member') updateRowFields_(SHEET_MEMBERS, p.id, { purge_at: iso })
  else { ensureCandidatesSheet_(); updateRowFields_(SHEET_CANDIDATES, p.id, { purge_at: iso }) }
  appendOrgAudit_(actorId, 'extendPersonalData', kind + ':' + p.id, { before: p.purgeAt, after: iso })
  return { purgeAt: iso }
}

// 代表: 退会を取り消す(個人情報を消す前だけ)。未アサインに戻したタスクは、戻らない。
// 退会の時に未アサインに戻したタスク(今もあるもの)の一覧を返す(画面が「○件あります」と出す。担当は代表が付け直す)
function cancelWithdrawal_(memberId, actorId) {
  var p = pendingEntryOf_('member', memberId)
  var row = findRow_(SHEET_MEMBERS, p.id) || {}
  var ids = String(row.withdrawal_unassigned_task_ids || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var tasks = []
  if (ids.length) {
    sheetRowsAsObjects_(SHEET_TASKS).forEach(function (t) {
      if (ids.indexOf(String(t.id)) < 0) return
      var assignees = String(t.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
      tasks.push({ id: String(t.id), title: String(t.title || ''), status: normalizeCode_('status', t.status), assigneeIds: assignees })
    })
  }
  updateRowFields_(SHEET_MEMBERS, p.id, { withdrawn_at: '', purge_at: '', inactive: '', withdrawal_unassigned_task_ids: '' })
  bumpMemberEmailsVersion_()
  appendOrgAudit_(actorId, 'cancelWithdrawal', p.id, { unassignedTasks: tasks.length })
  return { restored: p.id, unassignedTasks: tasks }
}

