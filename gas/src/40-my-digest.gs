// ---- 兼部の統合表示のための、本人に関係する分だけの読み取り(getMyDigest) -------------------------
//
// 画面は、端末に保存している団体ごとのログインで、各団体の GAS にこの操作を送り、答えを画面の中でだけまとめる
// (サーバーを足さない。docs/design-multi-org-view.md)。返すのは本人の分だけ:
//   tasks     本人が担当で完了していない(assignee)・確認待ちで本人が確認する人(reviewTarget)・
//             日程調整・フォームに招待されていて答えていない(invitee。日程調整は候補も)タスク
//             (件名・状態・日付・優先度・重要度・プロジェクト名だけ。説明・コメント・ほかの人の名前は返さない)
//   counts    担当・確認待ち・期限切れ・回答待ちの数
//   団体の名前・テーマの色(統合表示で団体を見分ける)・本人の名前・機能停止の状態
// ほかの人のタスク・メンバーの一覧・団体の設定・人材の情報は返さない。見えるかは canViewTaskRow_ を通す。
// 担当のタスクは、期限が to より後のものを返さない(期限の無いもの・期限切れは返す)。期間は62日まで。
// 結果は データの版・本人・期間 ごとに5分キャッシュする。knownVersion が今の版と同じなら unchanged だけを返す。
// 1人1時間 RATE_LIMITS.digest 回まで(超えたら、キャッシュがあればそれを返す)
var DIGEST_MAX_TASKS = 200
var DIGEST_MAX_DAYS = 62
var DIGEST_CACHE_TTL = 300
var DIGEST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function digestRange_(body, todayStr) {
  var from = String((body && body.from) || todayStr)
  var to = String((body && body.to) || '')
  if (!DIGEST_DATE_PATTERN.test(from)) throw userError_('期間の形が正しくありません。')
  if (!to) to = Utilities.formatDate(new Date(Date.parse(from + 'T00:00:00Z') + 27 * 86400000), 'UTC', 'yyyy-MM-dd')
  if (!DIGEST_DATE_PATTERN.test(to)) throw userError_('期間の形が正しくありません。')
  var days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000
  if (!(days >= 0) || days > DIGEST_MAX_DAYS) throw userError_('期間は ' + DIGEST_MAX_DAYS + ' 日までにしてください。')
  return { from: from, to: to }
}

function myDigest_(memberId, body) {
  var snapshot = loadSnapshot_()
  var version = snapshot.version
  if (body && body.knownVersion && String(body.knownVersion) === version) return { version: version, unchanged: true }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var range = digestRange_(body, today)
  var cache = CacheService.getScriptCache()
  var key = 'digest:' + version + ':' + memberId + ':' + range.from + ':' + range.to
  var cached = null
  try { var raw = cache.get(key); if (raw) cached = JSON.parse(raw) } catch (e) { cached = null }
  if (!takeRateLimit_('digest', memberId, 1)) {
    if (cached) return cached
    throw userError_('まとめて表示する読み込みが多すぎます。しばらくしてから、もう一度お試しください。')
  }
  if (cached) return cached
  var out = buildMyDigest_(snapshot.data, memberId, range, today)
  out.version = version
  try { cache.put(key, JSON.stringify(out), DIGEST_CACHE_TTL) } catch (e) { /* 大きすぎる時は毎回作る */ }
  return out
}

function buildMyDigest_(data, memberId, range, today) {
  var memberRow = findMemberInSnapshot_(data, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません。')
  var viewer = makeViewer_(memberRow, rolesFromSnapshot_(data))
  var me = String(memberId)
  var table = data[SHEET_TASKS] || { headers: [], rows: [] }
  var projects = {}
  var pt = data[SHEET_PROJECTS] || { headers: [], rows: [] }
  var pId = pt.headers.indexOf('id'), pName = pt.headers.indexOf('name')
  ;(pt.rows || []).forEach(function (r) { projects[String(r[pId])] = String(r[pName] || '') })
  var tasks = []
  var counts = { assigned: 0, reviewWaiting: 0, overdue: 0, unanswered: 0 }
  ;(table.rows || []).forEach(function (r) {
    var t = {}
    table.headers.forEach(function (h, i) { t[h] = r[i] })
    if (!String(t.id || '') || String(t.deleted_at || '') !== '') return
    if (!canViewTaskRow_(viewer, t)) return
    var status = normalizeCode_('status', t.status)
    if (status === 'done') return
    var due = String(t.due_date || '').slice(0, 10)
    var role = null
    var invite = digestInviteOf_(t, me)
    if (invite) role = 'invitee'
    else if (status === 'review' && digestIsReviewTarget_(t, me)) role = 'reviewTarget'
    else if (splitCsvList_(t.assignee_id).indexOf(me) >= 0) {
      if (due && due > range.to) return
      role = 'assignee'
    }
    if (!role) return
    var overdue = !!due && due < today
    if (role === 'assignee') counts.assigned++
    if (role === 'reviewTarget') counts.reviewWaiting++
    if (role === 'invitee') counts.unanswered++
    if (overdue && role !== 'invitee') counts.overdue++
    var item = {
      id: String(t.id), title: String(t.title || ''), status: status, role: role, overdue: overdue,
      dueDate: due, dueTime: String(t.due_time || ''), startDate: String(t.start_date || '').slice(0, 10),
      priority: normalizeCode_('priority', t.priority), importance: normalizeCode_('importance', t.importance),
      projectName: projects[String(t.project_id || '')] || '',
    }
    if (invite && invite.candidates) item.candidates = invite.candidates
    if (invite) item.inviteKind = invite.kind
    tasks.push(item)
  })
  tasks.sort(function (a, b) {
    var x = a.dueDate || '9999-99-99', y = b.dueDate || '9999-99-99'
    return x < y ? -1 : x > y ? 1 : 0
  })
  var settingOf = function (k) {
    var s = data[SHEET_SETTINGS] || { headers: [], rows: [] }
    var kc = s.headers.indexOf('key'), vc = s.headers.indexOf('value')
    for (var i = 0; i < (s.rows || []).length; i++) if (String(s.rows[i][kc]) === k) return String(s.rows[i][vc] || '')
    return ''
  }
  var contract = currentContract_(Date.now())
  return {
    orgName: settingOf('org_name'),
    themeColor: /^#[0-9a-fA-F]{6}$/.test(settingOf('theme_color')) ? settingOf('theme_color') : '',
    memberId: me,
    memberName: String(memberRow.display_name || memberRow.name || ''),
    contract: { phase: String(contract.phase || ''), kind: String(contract.kind || '') },
    tasks: tasks.slice(0, DIGEST_MAX_TASKS),
    truncated: tasks.length > DIGEST_MAX_TASKS,
    counts: counts,
  }
}

// 確認待ちのタスクで、本人が確認する人か(確認者 → 担当者の報告先 → 全権管理者。担当者本人は除く)
function digestIsReviewTarget_(task, me) {
  if (splitCsvList_(task.assignee_id).indexOf(me) >= 0) return false
  try { return reviewTargets_(task).ids.indexOf(me) >= 0 } catch (e) { return false }
}

// 日程調整・フォームに招待されていて、まだ答えていないか。日程調整は候補(ID・表示・日付・時刻)も返す
function digestInviteOf_(task, me) {
  var parse = function (v) { try { var o = JSON.parse(String(v || '')); return o && typeof o === 'object' ? o : null } catch (e) { return null } }
  var schedule = parse(task.schedule_json)
  if (schedule && Array.isArray(schedule.invitedIds) && schedule.invitedIds.map(String).indexOf(me) >= 0) {
    var answered = schedule.responses && schedule.responses[me] && Object.keys(schedule.responses[me]).length > 0
    if (!answered) {
      return { kind: 'schedule', candidates: (Array.isArray(schedule.candidates) ? schedule.candidates : []).slice(0, 20).map(function (c) {
        return { id: String(c.id || ''), label: String(c.label || '').slice(0, 100), date: String(c.date || ''), startTime: String(c.startTime || ''), endTime: String(c.endTime || '') }
      }) }
    }
  }
  var form = parse(task.form_json)
  if (form && Array.isArray(form.invitedIds) && form.invitedIds.map(String).indexOf(me) >= 0) {
    var done = form.responses && form.responses[me]
    if (!done) return { kind: 'form', candidates: null }
  }
  return null
}
