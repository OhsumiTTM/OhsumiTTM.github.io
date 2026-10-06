// ---- 読み取りの権限表(閲覧範囲の判定はここに集約する) -----------------------
//
// 列ごと・キーごとに規則名を書く。規則のない列・キーは誰にも返さない。
// 将来、団体ごとに人材データの閲覧範囲を設定できるようにする場合は、
// Settings の設定をこの表に重ねる形で拡張する。
//   all             ログイン済みの全員
//   self            本人のみ(Members の行の id が閲覧者)
//   selfOrAdminRole 本人と、一般以外の役職
//   selfOrFullAdmin 本人と全権管理者
//   adminRole       一般以外の役職
//   fullAdmin       全権管理者のみ
//   none            誰にも返さない
var READ_POLICY = {
  Members: {
    rows: 'all',
    columns: {
      id: 'all',
      name: 'all',
      display_name: 'all',
      role: 'all',
      avatar_url: 'all',
      avatar_color: 'all',
      avatar_initials: 'all',
      project_ids: 'all',
      will_tags: 'all',
      judgment_tags: 'all',
      reports_to_id: 'all',
      joined_at: 'all',
      department_path: 'all',
      unavailable_dates: 'all',
      absent_dates: 'all',
      available_hours_json: 'all',
      skill_levels_json: 'all',
      timezone: 'all',
      inactive: 'all',
      withdrawn_at: 'all',
      personal_data_purged_at: 'all',
      purge_at: 'selfOrAdminRole',
      withdrawal_unassigned_task_ids: 'selfOrAdminRole',
      // 書き込みの競合チェック: 版は画面が保存の時に送る。最後に変えた人は画面に渡さない
      row_version: 'all', row_updated_by: 'none',
      mentor_id: 'selfOrAdminRole',
      has_management_experience: 'selfOrAdminRole',
      desired_areas: 'selfOrAdminRole',
      desired_skills: 'selfOrAdminRole',
      career_history_json: 'selfOrAdminRole',
      qualifications_json: 'selfOrAdminRole',
      quiz_passes_json: 'selfOrAdminRole',
      // スキルのレベルの承認(誰が・いつ・何を認めたか)。見る立場の人と本人
      skill_approvals_json: 'selfOrSupervisor',
      evaluation_history_json: 'selfOrSupervisor',
      transfer_history_json: 'selfOrAdminRole',
      competencies_json: 'selfOrAdminRole',
      training_history_json: 'selfOrAdminRole',
      development_plan_json: 'selfOrSupervisor',
      one_on_ones_json: 'selfOrSupervisor',
      career_aspiration: 'selfOrSupervisor',
      desired_future_role: 'selfOrSupervisor',
      career_plan: 'selfOrSupervisor',
      university: 'selfOrAdminRole',
      faculty: 'selfOrAdminRole',
      department_name: 'selfOrAdminRole',
      grade_year: 'selfOrAdminRole',
      custom_fields_json: 'selfOrAdminRole',
      skill_points_json: 'selfOrAdminRole',
      survey_responses_json: 'selfOrSupervisor',
      last_login: 'selfOrAdminRole',
      notify_new_task: 'self',
      notify_settings: 'self',
      locale: 'self',
      permission_overrides_json: 'selfOrFullAdmin',
      last_inactive_notified: 'none',
      years_of_experience: 'none',
    },
  },
  Projects: {
    rows: 'all',
    columns: {
      id: 'all', name: 'all', description: 'all', type: 'all', owner_id: 'all',
      member_ids: 'all', archived: 'all', parent_id: 'all', goal: 'all',
      health_override: 'all', last_notified_health: 'all', start_date: 'all', end_date: 'all',
      row_version: 'all', row_updated_by: 'none',
    },
  },
  Tasks: {
    // 行の規則は canViewTaskRow_ を参照。行が見える人には全列を返す
    rows: 'task',
    columns: {
      id: 'all', project_id: 'all', title: 'all', description: 'all', status: 'all',
      assign_type: 'all', assignee_id: 'all', creator_id: 'all', created_at: 'all',
      start_date: 'all', due_date: 'all', due_time: 'all', visibility: 'all',
      department: 'all', category: 'all', skills: 'all', difficulty: 'all', priority: 'all',
      last_activity: 'all', original_input_id: 'all', approval_status: 'all',
      estimated_hours: 'all', importance: 'all', reviewer_id: 'all', reviewer_ids: 'all',
      depends_on_ids: 'all', progress_note: 'all', progress_percent: 'all',
      progress_history_json: 'all', deliverables_json: 'all', history_json: 'all',
      comments_json: 'all', retrospective_json: 'all', schedule_json: 'all', form_json: 'all',
      blocker_note: 'all', blocker_since: 'all', hold_reason_note: 'all', hold_reason_since: 'all',
      completed_date: 'all', actual_hours: 'all', awarded_points_json: 'all',
      required_approvals: 'all', required_skill_levels_json: 'all', review_approvals_json: 'all',
      open_bid_applicant_ids: 'all', related_review_task_id: 'all', calendar_event_id: 'none',
      deleted_at: 'all', deleted_by: 'all',
      row_version: 'all', row_updated_by: 'none',
    },
  },
  Settings: {
    // キーごとの規則。関数になっているキーは、閲覧者に合わせて値を加工して返す
    keys: {
      skill_options: 'all',
      category_options: 'all',
      roles: 'all',
      departments: 'all',
      role_levels: 'all',
      project_templates: 'all',
      role_permissions: 'all',
      task_set_templates: 'all',
      recurring_rules: 'all',
      job_requirements: 'all',
      skill_field_options: 'all',
      skill_field_skills: 'all',
      skill_field_threshold: 'all',
      org_notification_emails: 'fullAdmin',
      survey_invited_ids: filterSurveyInvitedIds_,
      project_order: 'all',
      restricted_roles: 'all',
      skill_level_thresholds: 'all',
      skill_level_rules: 'all',
      // 稼働の目安の決め方(37-value-checks.gs の checkWorkloadRules_ で確かめてから保存する)
      workload_rules: 'all',
      quiz_definitions: filterQuizDefinitions_,
      radar_axes: 'all',
      custom_member_columns_json: 'all',
      expense_categories: 'all',
      custom_form_defs: 'all',
      org_name: 'all',
      org_logo_url: 'all',
      theme_color: 'all',
      one_on_one_questions: 'all',
      initial_tasks_json: 'all',
      department_tree_config: 'all',
      learning_contents: 'all',
      learning_courses: 'all',
      training_programs: 'all',
      survey_questions: 'all',
      // 集計値を FSIF に送っているか(on / off。メンバーにも画面の下に出す)
      metrics_sharing_notice: 'all',
      // 人材データの項目ごとの閲覧範囲(33-member-field-visibility.gs)。どの範囲かは、全員に見せてよい
      member_field_visibility: 'all',
      // 団体の保存の、キーごとの読み書きの役職(35-org-store.gs)
      org_storage_access: 'fullAdmin',
    },
  },
}

function splitCsvList_(value) {
  return String(value || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
}

// 閲覧者の情報(判定に使う値だけ)。roles は役職の一覧(rolesFromSettings_)。
// 全権管理者の判定は lib/ohsumi/roles.ts の isFullAdminRoleRef_ と同じ基準
// (最上位は常に全権管理者 — authorizeAction_ と同じ)。
function makeViewer_(memberRow, roles) {
  var role = String(memberRow.role || '').trim()
  return {
    id: String(memberRow.id || ''),
    role: role,
    isAdminRole: isAdminRoleRef_(roles, role),
    isFullAdmin: isFullAdminRoleRef_(roles, role),
    isTop: roleTier_(roles, role) === 'top',
    // 評価・1on1 などを見られる相手(buildViewerData_ が報告先・メンター・プロジェクトの責任者から作る)
    supervisedIds: {},
    // Members の列ごとの規則の上書き(Settings の member_field_visibility から buildViewerData_ が入れる)
    memberColumnRules: {},
  }
}

function checkReadRule_(rule, viewer, ownerId) {
  switch (rule) {
    case 'all': return true
    case 'self': return !!ownerId && ownerId === viewer.id
    case 'selfOrAdminRole': return (!!ownerId && ownerId === viewer.id) || viewer.isAdminRole
    case 'selfOrFullAdmin': return (!!ownerId && ownerId === viewer.id) || viewer.isFullAdmin
    case 'adminRole': return viewer.isAdminRole
    case 'fullAdmin': return viewer.isFullAdmin
    // 本人・代表・その人を見る立場の人(報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者)
    case 'selfOrSupervisor': return (!!ownerId && ownerId === viewer.id) || !!viewer.isTop || !!(viewer.supervisedIds && viewer.supervisedIds[ownerId])
    default: return false
  }
}

// タスクの行の規則(画面の visibleTasks / pendingTasks の表示範囲を再現する)
//   幹部限定: 一般以外の役職のみ
//   承認待ち: 一般以外の役職と、作成者・担当者
function canViewTaskRow_(viewer, task) {
  // ゴミ箱のタスクは、元に戻す・完全に消すことのできる代表・全権管理者だけに返す
  if (String(task.deleted_at || '') !== '' && !viewer.isFullAdmin) return false
  // 値は移行前の日本語・コードのどちらでもよい
  // 幹部限定のタスクも、担当者・確認者・作成者には見せる(自分の担当のタスクが見えなくならないように)
  if (normalizeCode_('visibility', task.visibility) === 'leaders' && !viewer.isAdminRole) {
    var involved = splitCsvList_(task.assignee_id).concat(splitCsvList_(task.reviewer_ids), splitCsvList_(task.reviewer_id), [String(task.creator_id || '')])
    if (involved.indexOf(viewer.id) < 0) return false
  }
  if (normalizeCode_('approval', task.approval_status) === 'pending' && !viewer.isAdminRole) {
    if (String(task.creator_id || '') === viewer.id) return true
    return splitCsvList_(task.assignee_id).indexOf(viewer.id) >= 0
  }
  return true
}

// アンケートの回答対象者一覧: 一般以外の役職には一覧をそのまま返す。一般には
// 「自分が対象かどうか」だけが分かる値にする(対象なら自分のID、対象外なら
// どのメンバーIDとも一致しない値)。空(=全員が対象)はそのまま返す。
var SURVEY_NOT_INVITED_MARKER = '__not_invited__'
function filterSurveyInvitedIds_(value, viewer) {
  if (viewer.isAdminRole) return value
  var ids = splitCsvList_(value)
  if (ids.length === 0) return value
  return ids.indexOf(viewer.id) >= 0 ? viewer.id : SURVEY_NOT_INVITED_MARKER
}

// 検定: 正解番号(correctIndex)は検定を編集できる全権管理者だけに返す
// (採点は submitQuizResult でサーバー側が行う)
function filterQuizDefinitions_(value, viewer) {
  if (viewer.isFullAdmin || !value) return value
  try {
    var quizzes = JSON.parse(value)
    if (!Array.isArray(quizzes)) return ''
    quizzes.forEach(function (q) {
      ;(q && Array.isArray(q.questions) ? q.questions : []).forEach(function (question) {
        if (question) delete question.correctIndex
      })
    })
    return JSON.stringify(quizzes)
  } catch (e) {
    return ''
  }
}

function tableRowToObject_(headers, row) {
  var obj = {}
  for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c]
  return obj
}

// 1シート分を閲覧者に合わせて絞り込む(Members / Projects / Tasks)
function filterTableForViewer_(sheetName, table, viewer) {
  var policy = READ_POLICY[sheetName]
  var headers = table.headers || []
  var rows = table.rows || []
  // 規則のある列だけを残す(列の並びは元のまま。none の列も落とす)
  var keepCols = []
  headers.forEach(function (h, c) {
    if (h && policy.columns[h] && policy.columns[h] !== 'none') keepCols.push(c)
  })
  var idCol = headers.indexOf('id')
  var outRows = []
  rows.forEach(function (row) {
    var obj = null
    if (policy.rows === 'task') {
      obj = tableRowToObject_(headers, row)
      if (!canViewTaskRow_(viewer, obj)) return
    }
    // Members の「本人」判定は行の id で行う
    var ownerId = sheetName === 'Members' && idCol >= 0 ? String(row[idCol]) : ''
    var overrides = sheetName === 'Members' ? (viewer.memberColumnRules || {}) : {}
    outRows.push(keepCols.map(function (c) {
      var rule = overrides[headers[c]] || policy.columns[headers[c]]
      return checkReadRule_(rule, viewer, ownerId) ? row[c] : ''
    }))
  })
  return { headers: keepCols.map(function (c) { return headers[c] }), rows: outRows }
}

function filterSettingsForViewer_(table, viewer) {
  var headers = table.headers || []
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  var out = { headers: ['key', 'value'], rows: [] }
  if (keyCol < 0 || valueCol < 0) return out
  var keys = READ_POLICY.Settings.keys
  ;(table.rows || []).forEach(function (row) {
    var key = String(row[keyCol] || '')
    var rule = keys[key]
    if (!rule) return
    var value = row[valueCol]
    if (typeof rule === 'function') {
      out.rows.push([key, rule(value, viewer)])
    } else if (checkReadRule_(rule, viewer, '')) {
      out.rows.push([key, value])
    }
  })
  return out
}

// スナップショットの Settings から役職の一覧を作る
function rolesFromSnapshot_(data) {
  var settings = data.Settings || { headers: [], rows: [] }
  var keyCol = settings.headers.indexOf('key')
  var valueCol = settings.headers.indexOf('value')
  var map = {}
  if (keyCol >= 0 && valueCol >= 0) {
    settings.rows.forEach(function (r) {
      var key = String(r[keyCol])
      if (ROLE_SETTING_KEYS.indexOf(key) >= 0) map[key] = String(r[valueCol] || '')
    })
  }
  return rolesFromSettings_(map)
}

function findMemberInSnapshot_(data, memberId) {
  var members = data.Members || { headers: [], rows: [] }
  var idCol = members.headers.indexOf('id')
  if (idCol < 0) return null
  for (var i = 0; i < members.rows.length; i++) {
    if (String(members.rows[i][idCol]) === String(memberId)) return tableRowToObject_(members.headers, members.rows[i])
  }
  return null
}

// 閲覧者が「見る立場」にあるメンバーの ID(評価・1on1 などの読み取りに使う)。
//   ・報告先(reports_to_id)をたどって、閲覧者が上にいるメンバー
//   ・メンター(mentor_id)が閲覧者のメンバー
//   ・閲覧者が責任者(owner_id)のプロジェクト(その子プロジェクトも含む)に入っているメンバー
function supervisedMemberIds_(data, viewerId) {
  var out = {}
  if (!viewerId) return out
  var members = data.Members || { headers: [], rows: [] }
  var mh = members.headers || []
  var idCol = mh.indexOf('id'), repCol = mh.indexOf('reports_to_id'), mentorCol = mh.indexOf('mentor_id')
  var reportsTo = {}
  ;(members.rows || []).forEach(function (r) {
    var id = String(r[idCol] || '')
    if (!id) return
    reportsTo[id] = repCol >= 0 ? String(r[repCol] || '') : ''
    if (mentorCol >= 0 && String(r[mentorCol] || '') === viewerId) out[id] = true
  })
  Object.keys(reportsTo).forEach(function (id) {
    var cur = reportsTo[id]
    for (var hop = 0; cur && hop < 20; hop++) {
      if (cur === viewerId) { out[id] = true; break }
      cur = reportsTo[cur]
    }
  })
  var projects = data.Projects || { headers: [], rows: [] }
  var ph = projects.headers || []
  var pid = ph.indexOf('id'), owner = ph.indexOf('owner_id'), mem = ph.indexOf('member_ids'), parent = ph.indexOf('parent_id')
  if (pid >= 0 && owner >= 0 && mem >= 0) {
    var byId = {}, children = {}
    ;(projects.rows || []).forEach(function (r) {
      var id = String(r[pid] || '')
      if (!id) return
      byId[id] = r
      var p = parent >= 0 ? String(r[parent] || '') : ''
      if (p) (children[p] = children[p] || []).push(id)
    })
    var stack = Object.keys(byId).filter(function (id) { return String(byId[id][owner] || '') === viewerId })
    var seen = {}
    while (stack.length) {
      var cur = stack.pop()
      if (seen[cur]) continue
      seen[cur] = true
      splitCsvList_(byId[cur][mem]).forEach(function (m) { out[m] = true })
      ;(children[cur] || []).forEach(function (c) { stack.push(c) })
    }
  }
  delete out[viewerId]
  return out
}

// スナップショット全体を閲覧者に合わせて絞り込む(getInitialData の本体。
// Google のサービスを使わない純粋な関数なのでテストから直接呼べる)
function buildViewerData_(data, memberId) {
  var memberRow = findMemberInSnapshot_(data, memberId)
  if (!memberRow) return null
  var viewer = makeViewer_(memberRow, rolesFromSnapshot_(data))
  viewer.supervisedIds = supervisedMemberIds_(data, viewer.id)
  viewer.memberColumnRules = memberColumnRulesFromSnapshot_(data)
  var empty = { headers: [], rows: [] }
  return {
    Members: filterTableForViewer_('Members', data.Members || empty, viewer),
    Projects: filterTableForViewer_('Projects', data.Projects || empty, viewer),
    Tasks: filterTableForViewer_('Tasks', data.Tasks || empty, viewer),
    Settings: filterSettingsForViewer_(data.Settings || empty, viewer),
  }
}

// ログイン用のメール→メンバーIDの対応表(非公開の MemberEmails シート)。
// メールアドレス表専用の版ごとにキャッシュする(getMemberEmailsVersion_ を参照)。
function findMemberIdByEmailCached_(email) {
  var normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null
  var cache = CacheService.getScriptCache()
  // 版は MemberEmails を読む前に取得する(読んでいる間に書き込まれても、
  // 古い内容は古い版のキーに入るだけになる)
  var key = 'memberEmails:' + getMemberEmailsVersion_()
  var map = null
  try {
    var raw = cache.get(key)
    if (raw) map = JSON.parse(raw)
  } catch (e) { map = null }
  if (!map) {
    map = {}
    var sheet = getMemberEmailsSheet_()
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var emailCol = headers.indexOf('email')
    var lastRow = sheet.getLastRow()
    if (lastRow >= 2 && idCol >= 0 && emailCol >= 0) {
      sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function (row) {
        String(row[emailCol] || '').split(',').forEach(function (e) {
          var addr = e.trim().toLowerCase()
          if (addr && !map[addr]) map[addr] = String(row[idCol])
        })
      })
    }
    try { cache.put(key, JSON.stringify(map), SNAPSHOT_CACHE_TTL) } catch (e) { /* 大きすぎる場合は毎回読む */ }
  }
  return map[normalized] || null
}

// ログインと初期データの取得を1回で行う。
// knownVersion が現在の版と同じなら中身を返さず unchanged だけ返す。
function getInitialDataForMember_(memberId, knownVersion) {
  var version = timed_('versionMs', function () { return getDataVersion_() })
  if (knownVersion && String(knownVersion) === version) {
    noteTiming_('cache', 'unchanged')
    return { memberId: memberId, version: version, unchanged: true }
  }
  var snapshot = loadSnapshot_()
  var sheets = timed_('filterMs', function () { return buildViewerData_(snapshot.data, memberId) })
  if (!sheets) return { memberId: null }
  // ログインした人のできる操作(役職の分と人ごとの例外の分。画面はこれだけを見て操作の部品を出す)
  var capabilities = memberCapabilitiesFromSnapshot_(snapshot.data, memberId)
  var out = { memberId: memberId, version: snapshot.version, sheets: sheets, capabilities: capabilities }
  // 最上位の役職の人にだけ、団体のスプレッドシートと Apps Script の編集画面の URL を渡す(GAS の更新・確かめ用)
  var member = findMemberInSnapshot_(snapshot.data, memberId)
  if (member && isTopRoleRef_(rolesFromSnapshot_(snapshot.data), member.role)) {
    var links = orgAdminLinks_()
    if (links) out.adminLinks = links
  }
  return out
}

// Sheets API のエラー応答から、原因の分かる部分(status / reason / message)を取り出す
function describeSheetsApiError_(code, text) {
  var detail = ''
  try {
    var err = JSON.parse(text).error || {}
    var reasons = (err.details || []).map(function (d) { return d.reason }).filter(Boolean)
    detail = [err.status, reasons.join(','), err.message].filter(Boolean).join(' / ')
  } catch (e) {
    detail = String(text).slice(0, 300)
  }
  var hint = ''
  if (/SERVICE_DISABLED|has not been used|is disabled/.test(detail)) {
    hint = ' → Sheets API が無効です。エディタ左の「サービス」+ から Google Sheets API を追加すると有効になります'
  } else if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient/i.test(detail)) {
    hint = ' → トークンにスプレッドシートの権限が含まれていません'
  }
  return 'Sheets API がエラーを返しました: HTTP ' + code + ' ' + detail + hint
}


// 団体のスプレッドシートと Apps Script の編集画面の URL(最上位の役職の人の画面に出す)。取れなければ null
function orgAdminLinks_() {
  try {
    var spreadsheetUrl = String(SpreadsheetApp.getActive().getUrl() || '')
    var scriptId = String(ScriptApp.getScriptId() || '')
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(spreadsheetUrl) || !/^[\w-]+$/.test(scriptId)) return null
    return { spreadsheetUrl: spreadsheetUrl, scriptEditUrl: 'https://script.google.com/d/' + scriptId + '/edit' }
  } catch (e) {
    return null
  }
}
