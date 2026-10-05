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
// バックアップから戻した直後にも、期限を過ぎた分を消し直す。消したことは操作の記録(AuditLog)に残す
var PERSONAL_DATA_RETENTION_KEY = 'personal_data_retention_days'
var PERSONAL_DATA_RETENTION = { min: 7, max: 365, defaultDays: 30 }
var PERSONAL_DATA_NOTICE_DAYS = 7
var WITHDRAWN_MEMBER_NAME = '退会したメンバー'
var WITHDRAWN_MEMBER_MESSAGE = 'このアカウントは退会しています。もう一度使う時は、代表に依頼してください。'
// 消した後も Members に残す列(これ以外は空にする)
var MEMBER_COLUMNS_KEPT_AFTER_PURGE = ['id', 'name', 'role', 'inactive', 'withdrawn_at', 'purge_at', 'personal_data_purged_at']
// 退会の時に担当を残すタスクの状態(それ以外は未アサインに戻す)
var WITHDRAW_KEEP_ASSIGNEE_STATUSES = ['done', 'review']

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

// 退会したメンバーの個人情報を消す
function purgeMember_(memberId, nowMs) {
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
  // メールアドレスは、まとめ・キューの片付けに使ってから消す
  var emails = String(getAllMemberEmails_()[String(memberId)] || '')
  updateRowFields_(SHEET_MEMBERS, memberId, fields)
  deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return String(o.id) === String(memberId) })
  deletePersonalStore_(memberId)
  forgetPersonalProps_(memberId, emails)
  bumpMemberEmailsVersion_()
  // カレンダーの予定のゲストからメールアドレスを外し、プロフィール画像のファイルを消す(できなくても、ほかの削除は済ませる)
  removeCalendarGuest_(emails, nowMs)
  trashAvatarFiles_(memberId)
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

// 期限を過ぎた個人情報を消す(毎日の処理・バックアップから戻した直後)。ロックを取った中で呼ぶ
function purgeExpiredPersonalData_(nowMs, actorId) {
  var days = personalDataRetentionDays_()
  var done = { members: [], candidates: [] }
  pendingPersonalData_(days).forEach(function (p) {
    var at = Date.parse(p.purgeAt)
    if (!(at > 0) || at > nowMs) return
    if (p.kind === 'member') {
      purgeMember_(p.id, nowMs)
      done.members.push(p.id)
    } else {
      deleteRowsWhere_(SHEET_CANDIDATES, function (o) { return String(o.id) === p.id })
      done.candidates.push(p.id)
    }
  })
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

// 毎日の処理から(ロックを取る)
function purgeExpiredPersonalDataLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return purgeExpiredPersonalData_(nowMs, 'system')
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
  else deleteRowsWhere_(SHEET_CANDIDATES, function (o) { return String(o.id) === p.id })
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

