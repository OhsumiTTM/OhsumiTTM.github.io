// ---- 定量データ(個人を特定しない集計値)を週1回 FSIF に送る ----
//
// 送るかはプランで決まる(レジストリの checkIn が伝える CONTRACT_STATE.plan):
//   ohsumi(Ohsumiプラン): 必須(いつも送る) / cosmo_base(Cosmo Baseプラン): 代表が選ぶ(初期値は送る) /
//   paid(有償プラン): 代表が選ぶ(初期値は送らない) / 未設定: 代表が選ぶ(初期値は送らない)
// 代表の選択はスクリプトプロパティ METRICS_CHOICE(on / off)。送っているかは Settings の metrics_sharing_notice に書き、
// メンバーにも画面の下に出す。各指標の定義は gas/README.md の「4.18」(定義の版 METRICS_VERSION)
// 送る曜日・時刻は団体ID から決めて、団体ごとにずらす。期間はその週(月曜日から)。失敗したら1・2・4・8時間…(最長24時間)を
// 置いて送り直す。レジストリは同じ団体・同じ期間を1件として扱う(送り直しは上書き)
// 版 2(PR X の後): 将来使いそうな指標を、今のうちから数えて送る(過去の分は後から作れないため)
var METRICS_VERSION = 2
var METRICS_HISTORY_KEEP = 12
var METRICS_RETRY_MAX_HOURS = 24

function metricsPlan_() {
  var state = null
  try { state = JSON.parse(PropertiesService.getScriptProperties().getProperty('CONTRACT_STATE') || 'null') } catch (e) { state = null }
  return state && state.plan ? String(state.plan) : ''
}

// { plan, mandatory, defaultOn, choice, enabled }
function metricsSharing_() {
  var plan = metricsPlan_()
  var choice = String(PropertiesService.getScriptProperties().getProperty('METRICS_CHOICE') || '')
  var mandatory = plan === 'ohsumi'
  var defaultOn = plan === 'ohsumi' || plan === 'cosmo_base'
  var enabled = mandatory ? true : choice === 'on' ? true : choice === 'off' ? false : defaultOn
  return { plan: plan, mandatory: mandatory, defaultOn: defaultOn, choice: choice, enabled: enabled }
}

// 団体ごとの送る曜日(0=日曜日)と時刻(1〜22時)
function metricsSlot_(orgId) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'metrics-slot:' + String(orgId || ''), Utilities.Charset.UTF_8)
  var h = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff)
  return { dow: h % 7, hour: 1 + (Math.floor(h / 7) % 22) }
}

// その時刻を含む週の月曜日(YYYY-MM-DD。スクリプトのタイムゾーン)と、その週の送る時刻(ミリ秒)
function metricsWeek_(nowMs, slot) {
  var tz = Session.getScriptTimeZone()
  var dow = Number(Utilities.formatDate(new Date(nowMs), tz, 'u')) % 7 // 1=月曜日 … 7=日曜日 → 0=日曜日
  var daysFromMonday = (dow + 6) % 7
  var monday = Utilities.formatDate(new Date(nowMs - daysFromMonday * 86400000), tz, 'yyyy-MM-dd')
  var hourNow = Number(Utilities.formatDate(new Date(nowMs), tz, 'H'))
  var minuteNow = Number(Utilities.formatDate(new Date(nowMs), tz, 'm'))
  var startOfToday = nowMs - (hourNow * 60 + minuteNow) * 60000 - (nowMs % 60000)
  var slotDays = (slot.dow + 6) % 7 // 月曜日から何日目
  var slotAt = startOfToday + (slotDays - daysFromMonday) * 86400000 + slot.hour * 3600000
  return { period: monday, slotAt: slotAt }
}

function readMetricsState_() {
  var s = null
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty('METRICS_STATE') || 'null') } catch (e) { s = null }
  s = s && typeof s === 'object' ? s : {}
  if (!Array.isArray(s.history)) s.history = []
  if (!s.sent || typeof s.sent !== 'object') s.sent = {}
  return s
}

function writeMetricsState_(s) {
  s.history = s.history.slice(0, METRICS_HISTORY_KEEP)
  var periods = Object.keys(s.sent).sort().reverse().slice(0, METRICS_HISTORY_KEEP)
  var sent = {}
  periods.forEach(function (p) { sent[p] = s.sent[p] })
  s.sent = sent
  PropertiesService.getScriptProperties().setProperty('METRICS_STATE', JSON.stringify(s))
}

function cellTimeMs_(v) {
  if (v instanceof Date) return v.getTime()
  var t = Date.parse(String(v || ''))
  return isFinite(t) ? t : NaN
}

// 送る集計値(定義は gas/README.md の「4.18」)。個人を特定しない数だけ
function metricsSnapshot_(nowMs) {
  var day = 86400000
  var within = function (v, days) { var t = cellTimeMs_(v); return isFinite(t) && t <= nowMs && nowMs - t < days * day }
  var table = function (name) {
    var t = snapshotTableOrSheet_(name)
    return (t.rows || []).map(function (r) { var o = {}; t.headers.forEach(function (h, i) { o[h] = r[i] }); return o })
  }
  var members = table(SHEET_MEMBERS).filter(function (m) {
    return String(m.id || '') && !boolCellValue_(m.inactive) && !String(m.withdrawn_at || '') && !String(m.personal_data_purged_at || '')
  })
  var tasks = table(SHEET_TASKS).filter(function (t) { return String(t.id || '') && !isTrashedTask_(t) })
  var projects = table(SHEET_PROJECTS).filter(function (p) { return String(p.id || '') && !boolCellValue_(p.archived) })
  var today = Utilities.formatDate(new Date(nowMs), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var isDone = function (t) { return normalizeCode_('status', t.status) === 'done' }
  // ログイン・読み込み・書き込みの回数(利用の集計。直近7日)
  var usage = usageStatus_(nowMs)
  var last7 = usage.days.slice(-7)
  var sum = function (k) { return last7.reduce(function (n, d) { return n + d[k] }, 0) }
  var parseList = function (v) { try { var a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch (e) { return [] } }
  var parseObj = function (v) { try { var o = JSON.parse(String(v || '{}')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch (e) { return {} } }
  // 期限を過ぎた日数(完了していないタスク。今日より前の期限だけ)
  var overdueDays = tasks.filter(function (t) { var d = String(t.due_date || '').slice(0, 10); return !isDone(t) && d && d < today }).map(function (t) {
    return Math.max(1, Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(String(t.due_date).slice(0, 10) + 'T00:00:00Z')) / day))
  }).filter(function (n) { return isFinite(n) })
  // 1on1 は両方のメンバーの記録に入ることがあるので、記録の ID で1回だけ数える
  var oneOnOnes = {}
  members.forEach(function (m) {
    parseList(m.one_on_ones_json).forEach(function (r) { if (r && r.id && within(String(r.date || '').slice(0, 10) + 'T00:00:00', 30)) oneOnOnes[String(r.id)] = true })
  })
  var applications = table(SHEET_EXPENSES).concat(table(SHEET_FORM_SUBMISSIONS)).filter(function (a) { return String(a.id || '') })
  return {
    version: METRICS_VERSION,
    members: members.length,
    active_7d: members.filter(function (m) { return within(m.last_login, 7) }).length,
    active_30d: members.filter(function (m) { return within(m.last_login, 30) }).length,
    logins_7d: sum('login'),
    opens_7d: sum('open'),
    writes_7d: sum('writes'),
    tasks: tasks.length,
    tasks_open: tasks.filter(function (t) { return !isDone(t) }).length,
    tasks_done: tasks.filter(isDone).length,
    tasks_overdue: tasks.filter(function (t) { var d = String(t.due_date || '').slice(0, 10); return !isDone(t) && d && d < today }).length,
    tasks_created_7d: tasks.filter(function (t) { return within(t.created_at, 7) }).length,
    tasks_completed_7d: tasks.filter(function (t) { return isDone(t) && within(String(t.completed_date || '').slice(0, 10) + 'T00:00:00', 7) }).length,
    projects: projects.length,
    errors_7d: usage.errors.last7Days,
    // ---- 版 2 ----
    // 一度でもログインした人数(立ち上げの進み具合)
    members_logged_in: members.filter(function (m) { return isFinite(cellTimeMs_(m.last_login)) }).length,
    comments_7d: tasks.reduce(function (n, t) { return n + parseList(t.comments_json).filter(function (c) { return c && within(c.at, 7) }).length }, 0),
    reviews_approved_7d: tasks.reduce(function (n, t) { return n + parseList(t.review_approvals_json).filter(function (a) { return a && within(a.at, 7) }).length }, 0),
    tasks_overdue_days_avg: overdueDays.length ? Math.round(overdueDays.reduce(function (n, d) { return n + d }, 0) / overdueDays.length) : 0,
    skill_points_total: Math.floor(members.reduce(function (n, m) {
      var pts = parseObj(m.skill_points_json)
      return n + Object.keys(pts).reduce(function (k, key) { var v = Number(pts[key]); return k + (isFinite(v) && v > 0 ? v : 0) }, 0)
    }, 0)),
    daily_reports_7d: table(SHEET_DAILY_REPORTS).filter(function (r) { return String(r.id || '') && within(r.created_at, 7) }).length,
    one_on_ones_30d: Object.keys(oneOnOnes).length,
    expenses_7d: table(SHEET_EXPENSES).filter(function (r) { return String(r.id || '') && within(r.created_at, 7) }).length,
    form_submissions_7d: table(SHEET_FORM_SUBMISSIONS).filter(function (r) { return String(r.id || '') && within(r.created_at, 7) }).length,
    // 直近30日に出された経費・フォームの申請のうち、差し戻した(rejected)もの(差し戻した日時は残らないため、出した日で数える)
    applications_rejected_30d: applications.filter(function (a) { return String(a.status) === 'rejected' && within(a.created_at, 30) }).length,
  }
}

function boolCellValue_(v) {
  return v === true || /^(true|1|yes)$/i.test(String(v === undefined || v === null ? '' : v).trim())
}

// 毎時の処理から呼ぶ。送る時刻を過ぎ、その週の分をまだ送っていなければ送る(失敗したら時間を置いて送り直す)
function maybeSendMetrics_(nowMs, deps) {
  var props = PropertiesService.getScriptProperties()
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!orgId) return 'noOrg'
  var sharing = metricsSharing_()
  syncMetricsNotice_(sharing.enabled)
  if (!sharing.enabled) return 'disabled'
  if (featureDisabled_('metricsSend')) return 'featureDisabled'
  var week = metricsWeek_(nowMs, metricsSlot_(orgId))
  var state = readMetricsState_()
  if (state.sent[week.period]) return 'alreadySent'
  if (nowMs < week.slotAt) return 'notYet'
  if (state.retry && state.retry.period === week.period && nowMs < Number(state.retry.nextAt)) return 'waitingRetry'
  return sendMetricsNow_(nowMs, week.period, state, deps)
}

function sendMetricsNow_(nowMs, period, state, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = registryUrl_()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  var attempts = state.retry && state.retry.period === period ? Number(state.retry.attempts) + 1 : 1
  var error = ''
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) {
    error = 'レジストリに登録していません'
  } else {
    try {
      var metrics = metricsSnapshot_(nowMs)
      var ts = Math.floor(nowMs / 1000)
      var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(metrics), key))
      var payload = JSON.stringify({ action: 'reportMetrics', orgId: orgId, ts: ts, period: period, metrics: metrics, sig: sig })
      var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
      var res = JSON.parse(r.getContentText())
      if (!res || !res.ok) error = String((res && res.error) || '応答の形が違います').slice(0, 200)
    } catch (e) {
      error = maskEmailsIn_(String((e && e.message) || e)).slice(0, 200)
    }
  }
  var at = new Date(nowMs).toISOString()
  state.history.unshift({ period: period, at: at, ok: !error, error: error, attempt: attempts })
  if (!error) {
    state.sent[period] = at
    delete state.retry
  } else {
    var waitHours = Math.min(tunable_('metricsRetryMaxHours', METRICS_RETRY_MAX_HOURS), Math.pow(2, attempts - 1))
    state.retry = { period: period, attempts: attempts, nextAt: nowMs + waitHours * 3600000 }
    appendErrorLog_('job', 'reportMetrics', 'metricsFailed')
  }
  writeMetricsState_(state)
  return error ? 'failed' : 'sent'
}

// 送っているかを Settings に書く(メンバーの画面の下の表示。変わった時だけ書く)
function syncMetricsNotice_(enabled) {
  var want = enabled ? 'on' : 'off'
  try {
    if (String(getSettingValue_('metrics_sharing_notice') || '') === want) return
    updateSetting_('metrics_sharing_notice', want)
    bumpDataVersion()
  } catch (e) {
    console.warn('集計値の表示を書けませんでした: ' + maskEmailsIn_(String(e)))
  }
}

// 代表の管理画面: プラン・送るか・次に送る時刻・次に送る内容(プレビュー)・送信の履歴
function metricsStatus_(nowMs) {
  var orgId = String(PropertiesService.getScriptProperties().getProperty('ORG_ID') || '')
  var sharing = metricsSharing_()
  var slot = metricsSlot_(orgId)
  var week = metricsWeek_(nowMs, slot)
  var state = readMetricsState_()
  var nextAt = week.slotAt
  if (state.sent[week.period] || nowMs >= week.slotAt) nextAt = week.slotAt + 7 * 86400000
  if (!state.sent[week.period] && state.retry && state.retry.period === week.period) nextAt = Number(state.retry.nextAt)
  else if (!state.sent[week.period] && nowMs >= week.slotAt) nextAt = nowMs
  return {
    plan: sharing.plan,
    mandatory: sharing.mandatory,
    defaultOn: sharing.defaultOn,
    enabled: sharing.enabled,
    slot: slot,
    nextAt: sharing.enabled ? new Date(nextAt).toISOString() : '',
    definitionsVersion: METRICS_VERSION,
    preview: metricsSnapshot_(nowMs),
    history: state.history,
  }
}

function setMetricsSharing_(enabled, actorId, nowMs) {
  var sharing = metricsSharing_()
  if (sharing.mandatory && !enabled) throw userError_('Ohsumiプランでは、集計値の送信は必須のため止められません。')
  PropertiesService.getScriptProperties().setProperty('METRICS_CHOICE', enabled ? 'on' : 'off')
  syncMetricsNotice_(enabled)
  appendOrgAudit_(actorId, 'setMetricsSharing', '', { before: sharing.enabled, after: enabled })
  return metricsStatus_(nowMs)
}

// ---- 診断情報(PR Q) ----------------------------------------------------------------------
//
// 代表の管理画面で、個人情報を含まない診断情報(版・設定の状態・上限の状況・直近のエラーの件数など)を見せ(getDiagnostics)、
// 確認の後にレジストリへ送って受付番号をもらう(sendDiagnostics)。
//   - 名前・メールアドレス・メンバーID・タスクの内容・エラーの文は入れない(数・あり/なし・日時・操作の名前だけ)。
//     念のため、文の中のメールアドレスは「(メールアドレス)」に置き換える
//   - 見せたものと同じものを送る(見せた時に診断ID を付けて10分覚える。過ぎたら、表示し直してもらう)
//   - 送り直しは、同じ診断ID なら同じ受付番号になる(レジストリが1件として扱う)
//   - 送った記録(受付番号・日時)は、スクリプトプロパティ DIAGNOSTICS_HISTORY に直近10件を残す
var DIAGNOSTICS_CACHE_SEC = 600
var DIAGNOSTICS_HISTORY_MAX = 10
var DIAGNOSTICS_MAX_CHARS = 30000
// スプレッドシートのセルの数の上限(Google の決まり)・スクリプトプロパティの上限(合計の目安)
var SPREADSHEET_CELL_LIMIT = 10000000
var SCRIPT_PROPERTIES_LIMIT_BYTES = 500 * 1024

function hideEmails_(text) {
  return String(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, '(メールアドレス)')
}

// 1つの項目で失敗しても、ほかの項目は出す(失敗した項目には、エラーの種類だけを入れる)
function diagnosticsPart_(fn) {
  try {
    return fn()
  } catch (e) {
    return { unavailable: isPermissionError_(e) ? 'permission' : (quotaKind_(e) ? 'quota' : 'error') }
  }
}

// Ohsumi が作るシートの名前(診断情報で、名前と行数を出すもの)
function ohsumiSheetNames_() {
  return Object.keys(SHEET_HEADERS).concat(['AuditLog', USAGE_SHEET, ERROR_LOG_SHEET])
}

function diagnosticsSnapshot_(nowMs) {
  var props = PropertiesService.getScriptProperties()
  var contract = readContractState_() || {}
  var snap = {
    version: OHSUMI_GAS_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    timeZone: diagnosticsPart_(function () { return Session.getScriptTimeZone() }),
    registry: diagnosticsPart_(function () {
      return {
        registered: REGISTRY_URL_PATTERN.test(registryUrl_()) && !!props.getProperty('REGISTRY_SHARED_KEY') && !!props.getProperty('ORG_ID'),
        plan: String(contract.plan || ''),
        contractPhase: String(contract.phase || ''),
        contractKind: String(contract.kind || ''),
        checkedAt: String(contract.checkedAt || ''),
        siteOrigins: Array.isArray(contract.siteOrigins) ? contract.siteOrigins.length : 0,
        openSurveys: Array.isArray(contract.surveys) ? contract.surveys.length : 0,
        // レジストリから止めている機能・既定と違う上限としきい値(PR W・X)
        disabledFeatures: disabledFeatures_(),
        tunables: tunablesForClient_().map(function (t) { return t.key + '=' + t.value }),
      }
    }),
    gasUpdate: diagnosticsPart_(function () { var u = gasUpdateStatus_(); return { known: u.known, required: u.required, outdated: u.outdated, latest: u.latest } }),
    settings: diagnosticsPart_(function () {
      var w = getWebhookStatus_()
      var emails = String(getSettingValue_('org_notification_emails') || '').split(/[,\s]+/).filter(Boolean)
      var sharing = metricsSharing_()
      return {
        discordWebhook: !!w.discord.configured,
        slackWebhook: !!w.slack.configured,
        orgNotificationEmails: emails.length,
        metricsSharing: !!sharing.enabled,
        triggers: diagnosticsPart_(function () { return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction() }).sort() }),
      }
    }),
    limits: diagnosticsPart_(function () {
      var q = mailQuotaStatus_()
      var long = longRecordsNow_()
      var propsText = JSON.stringify(props.getProperties() || {})
      var ss = SpreadsheetApp.getActiveSpreadsheet()
      var cells = 0
      var rows = {}
      // Ohsumi が作るシートは名前と行数。それ以外(団体が作ったシート)は名前を入れず、「その他」の枚数と行数の合計にまとめる
      var other = { sheets: 0, rows: 0 }
      var ohsumiSheets = ohsumiSheetNames_()
      ss.getSheets().forEach(function (sh) {
        cells += (Number(sh.getMaxRows()) || 0) * (Number(sh.getMaxColumns()) || 0)
        var n = Math.max(0, (Number(sh.getLastRow()) || 0) - 1)
        var name = String(sh.getName())
        if (ohsumiSheets.indexOf(name) >= 0) rows[name] = n
        else { other.sheets++; other.rows += n }
      })
      return {
        mail: { remaining: q.remaining, skippedToday: q.skipped, lastReachedDate: q.lastReachedDate },
        longRecords: { count: long.groups.reduce(function (n, g) { return n + g.count }, 0), maxLength: long.maxLength, warnAt: long.warnAt, max: long.max },
        spreadsheetCells: { used: cells, limit: SPREADSHEET_CELL_LIMIT },
        scriptProperties: { bytes: propsText.length, limit: SCRIPT_PROPERTIES_LIMIT_BYTES, keys: Object.keys(props.getProperties() || {}).length },
        rows: rows,
        otherSheets: other,
      }
    }),
    jobs: diagnosticsPart_(function () {
      var j = jobStatus_(nowMs)
      return { dailyAt: j.dailyAt, hourlyAt: j.hourlyAt, dailyStale: j.dailyStale, hourlyStale: j.hourlyStale, dailyFailedAt: j.dailyFailedAt, hourlyFailedAt: j.hourlyFailedAt }
    }),
    sharing: diagnosticsPart_(function () {
      var s = readSharingState_()
      // 誰と共有しているか(detail)は入れない。対象と種類だけ
      return { checkedAt: s.checkedAt, problems: s.problems.map(function (p) { return p.target + ':' + p.kind }) }
    }),
    backup: diagnosticsPart_(function () { var b = backupStatus_(); return { lastSuccessAt: b.lastSuccessAt, failed: b.failed, failedAt: b.failedAt } }),
    errors: diagnosticsPart_(function () {
      var u = usageStatus_(nowMs)
      var byAction = {}
      u.errors.recent.forEach(function (r) { if (Date.parse(r.at) >= nowMs - 7 * 24 * 3600 * 1000) byAction[r.action] = (byAction[r.action] || 0) + 1 })
      return { last7Days: u.errors.last7Days, byKind: u.errors.byKind, recentByAction: byAction }
    }),
  }
  return JSON.parse(hideEmails_(JSON.stringify(snap)))
}

function readDiagnosticsHistory_() {
  try {
    var list = JSON.parse(PropertiesService.getScriptProperties().getProperty('DIAGNOSTICS_HISTORY') || '[]')
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// 代表の管理画面: 送る内容を見せる。返事: { diagId, diagnostics, history }
function diagnosticsPreview_(nowMs) {
  var diag = diagnosticsSnapshot_(nowMs)
  var diagId = 'dg_' + Utilities.getUuid().replace(/[^A-Za-z0-9]/g, '').slice(0, 20)
  try { CacheService.getScriptCache().put('diag:' + diagId, JSON.stringify(diag), DIAGNOSTICS_CACHE_SEC) } catch (e) { /* 送る時に、表示し直してもらう */ }
  return { diagId: diagId, diagnostics: diag, history: readDiagnosticsHistory_() }
}

// 代表の管理画面: 見せたものを送り、受付番号を返す。{ diagId }
function sendDiagnostics_(diagId, nowMs, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = registryUrl_()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) throw userError_('この団体は、レジストリに登録していないため、診断情報を送れません。表示した内容を FSIF にお伝えください。')
  if (!/^dg_[A-Za-z0-9]{8,40}$/.test(String(diagId || ''))) throw userError_('送る内容を、もう一度表示してください。')
  var text = CacheService.getScriptCache().get('diag:' + diagId)
  if (!text) throw userError_('表示してから10分を過ぎました。送る内容を、もう一度表示してください。')
  if (text.length > DIAGNOSTICS_MAX_CHARS) throw userError_('診断情報が大きすぎて送れません。FSIF にお問い合わせください。')
  var ts = Math.floor(nowMs / 1000)
  var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('diagnostics.' + orgId + '.' + ts + '.' + diagId + '.' + text, key))
  var res
  try {
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', muteHttpExceptions: true, followRedirects: true,
      payload: JSON.stringify({ action: 'receiveDiagnostics', orgId: orgId, ts: ts, diagId: diagId, diagnostics: text, sig: sig }) })
    res = JSON.parse(r.getContentText())
  } catch (e) {
    throw userError_('FSIF(レジストリ)に送れませんでした。少し待ってから、もう一度送ってください。')
  }
  if (!res || !res.ok || !res.result || !/^D\d{6}-[A-Z0-9]{4}$/.test(String(res.result.receiptNo || ''))) {
    throw userError_('FSIF(レジストリ)が受け付けませんでした(' + String((res && res.error) || '応答の形が違います').slice(0, 100) + ')。')
  }
  var entry = { receiptNo: String(res.result.receiptNo), at: new Date(nowMs).toISOString(), diagId: diagId }
  var history = readDiagnosticsHistory_().filter(function (h) { return h.diagId !== diagId })
  history.unshift(entry)
  props.setProperty('DIAGNOSTICS_HISTORY', JSON.stringify(history.slice(0, DIAGNOSTICS_HISTORY_MAX)))
  return { receiptNo: entry.receiptNo, at: entry.at, history: history.slice(0, DIAGNOSTICS_HISTORY_MAX) }
}
