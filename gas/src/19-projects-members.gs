// ---- Projects ---------------------------------------------------------------

function createProject_(name, description, type, parentId) {
  var sheet = getSheet_(SHEET_PROJECTS)
  var headers = headerRow_(sheet)
  var id = String(nextIntId_(sheet, headers))
  var row = headers.map(function (h) {
    if (h === 'id') return id
    if (h === 'name') return name
    if (h === 'description') return description || ''
    if (h === 'type') return type || ''
    if (h === 'parent_id') return parentId || ''
    return ''
  })
  assertRowCellLengths_('Projects', headers, row)
  protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, 'Projects')
  sheet.appendRow(row)
  return { id: id }
}

// Deletes a project and cascades: a task can't exist without a project
// (see lib/ohsumi/types.ts's Task.projectId, which is required), so its
// tasks are removed too, not just unassigned like removeMember does for
// members. Any admin scoped to this project (see project_ids) has it
// dropped from their scope so they don't end up referencing a dead id.
function assertProjectRemovable_(projectId) {
  var count = function (sheetName, col) {
    var t = snapshotTableOrSheet_(sheetName) || { headers: [], rows: [] }
    var c = (t.headers || []).indexOf(col)
    if (c < 0) return 0
    return (t.rows || []).filter(function (r) { return String(r[c] || '') === projectId }).length
  }
  var tasks = count(SHEET_TASKS, 'project_id') + archivedTaskCountOfProject_(projectId), children = count(SHEET_PROJECTS, 'parent_id')
  if (tasks > 0 || children > 0) {
    throw userError_('このプロジェクトには、タスクが ' + tasks + ' 件(ゴミ箱・移した古いタスクを含む)・子プロジェクトが ' + children + ' 件あるため削除できません。終わったプロジェクトは「アーカイブ」にしてください。')
  }
}

function removeProject_(projectId) {
  var projects = getSheet_(SHEET_PROJECTS)
  var projectHeaders = headerRow_(projects)
  var idCol = projectHeaders.indexOf('id') + 1
  var lastRow = projects.getLastRow()
  var ids = idCol > 0 ? projects.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(projectId)) {
      projects.deleteRow(i + 2)
      forgetSheetGrid_()
      break
    }
  }

  var tasks = getSheet_(SHEET_TASKS)
  var taskHeaders = headerRow_(tasks)
  var projectCol = taskHeaders.indexOf('project_id') + 1
  if (projectCol > 0) {
    var taskLastRow = tasks.getLastRow()
    var projectIds =
      taskLastRow > 1 ? tasks.getRange(2, projectCol, taskLastRow - 1, 1).getValues() : []
    // walk bottom-to-top so deleting a row doesn't shift the indices of
    // rows still to be checked
    var taskIdCol = taskHeaders.indexOf('id') + 1
    var taskIds = taskIdCol > 0 && taskLastRow > 1 ? tasks.getRange(2, taskIdCol, taskLastRow - 1, 1).getValues() : []
    var removedTaskIds = []
    for (var j = projectIds.length - 1; j >= 0; j--) {
      if (String(projectIds[j][0]) === String(projectId)) {
        if (taskIds[j]) removedTaskIds.push(String(taskIds[j][0]))
        tasks.deleteRow(j + 2)
        forgetSheetGrid_()
      }
    }
    // 記録を1件1行で持っている時は、消したタスクの記録の行も消す(39-record-rows.gs)
    deleteRecordsOfParents_(SHEET_TASKS, removedTaskIds)
  }

  var members = getSheet_(SHEET_MEMBERS)
  var memberHeaders = headerRow_(members)
  var projIdsCol = memberHeaders.indexOf('project_ids') + 1
  if (projIdsCol > 0) {
    var memberLastRow = members.getLastRow()
    var memberProjectIds =
      memberLastRow > 1 ? members.getRange(2, projIdsCol, memberLastRow - 1, 1).getValues() : []
    for (var k = 0; k < memberProjectIds.length; k++) {
      var list = String(memberProjectIds[k][0] || '')
        .split(',')
        .map(function (s) {
          return s.trim()
        })
        .filter(Boolean)
      if (list.indexOf(String(projectId)) !== -1) {
        var next = list.filter(function (id) {
          return id !== String(projectId)
        })
        members.getRange(k + 2, projIdsCol).setValue(next.join(','))
      }
    }
  }

  return { removed: projectId }
}

// Deletes a task outright — distinct from the automatic archive that
// happens client-side 14 days after completion (see visibleTasks/
// archivedTasks in lib/ohsumi/store.tsx), which just hides it, not this,
// which removes the row. Any other task that listed this one in
// depends_on_ids has that reference scrubbed so 依存関係 doesn't point at
// a dead id.
// ---- タスクのゴミ箱 ----
//
// 削除(removeTask)は、行を消さずに deleted_at・deleted_by を書いてゴミ箱に入れる(画面・検索・集計・通知・カレンダーから外す)。
// ゴミ箱のタスクは、代表・全権管理者だけに返し、元に戻す(restoreTask)・すぐに完全に消す(purgeTask)ことができる。
// 毎日の処理が、入れてから TRASH_RETENTION_DAYS 日たったタスクを完全に消す。前提タスクの一覧からは、完全に消す時に外す。
// deleted_at の列が無い古いシート(setupOhsumi を実行していない)では、これまでどおりすぐに消す
var TRASH_RETENTION_DAYS = 30
var TRASH_ACTIONS = ['restoreTask', 'purgeTask']
var TRASHED_TASK_MESSAGE = 'このタスクはゴミ箱にあります。元に戻してから変えてください。'

function trashTask_(taskId, actorId) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('タスクが見つかりません。')
  if (!Object.prototype.hasOwnProperty.call(task, 'deleted_at')) return removeTask_(taskId)
  if (String(task.deleted_at || '') !== '') throw userError_(TRASHED_TASK_MESSAGE)
  updateRowFields_(SHEET_TASKS, taskId, { deleted_at: new Date().toISOString(), deleted_by: String(actorId || '') })
  return { trashed: taskId }
}

function restoreTrashedTask_(taskId) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task || String(task.deleted_at || '') === '') throw userError_('ゴミ箱にこのタスクはありません。')
  updateRowFields_(SHEET_TASKS, taskId, { deleted_at: '', deleted_by: '' })
  return { restored: taskId }
}

function purgeTrashedTask_(taskId) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task || String(task.deleted_at || '') === '') throw userError_('ゴミ箱にこのタスクはありません。')
  return removeTask_(taskId)
}

// 毎日の処理: ゴミ箱に入れてから TRASH_RETENTION_DAYS 日たったタスクを完全に消す
function purgeExpiredTrashLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    var limit = nowMs - TRASH_RETENTION_DAYS * 24 * 3600 * 1000
    var ids = sheetRowsAsObjects_(SHEET_TASKS).filter(function (t) {
      var at = cellTimeMs_(t.deleted_at)
      return String(t.deleted_at || '') !== '' && isFinite(at) && at <= limit
    }).map(function (t) { return String(t.id) })
    ids.forEach(function (id) { removeTask_(id) })
    if (ids.length) bumpSnapshotVersion_()
    return ids
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

function isTrashedTask_(t) {
  return !!t && String(t.deleted_at || '') !== ''
}

function removeTask_(taskId) {
  // カレンダーの予定を消してから、行を消す
  syncCalendarForTask_(taskId, { remove: true })
  var tasks = getSheet_(SHEET_TASKS)
  var taskHeaders = headerRow_(tasks)
  var idCol = taskHeaders.indexOf('id') + 1
  var lastRow = tasks.getLastRow()
  var ids = idCol > 0 ? tasks.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(taskId)) {
      tasks.deleteRow(i + 2)
      forgetSheetGrid_()
      // 記録を1件1行で持っている時は、そのタスクの記録の行も消す(39-record-rows.gs)
      deleteRecordsOfParents_(SHEET_TASKS, [String(taskId)])
      break
    }
  }

  var dependsCol = taskHeaders.indexOf('depends_on_ids') + 1
  if (dependsCol > 0) {
    var afterLastRow = tasks.getLastRow()
    var dependsValues =
      afterLastRow > 1 ? tasks.getRange(2, dependsCol, afterLastRow - 1, 1).getValues() : []
    for (var j = 0; j < dependsValues.length; j++) {
      var list = String(dependsValues[j][0] || '')
        .split(',')
        .map(function (s) {
          return s.trim()
        })
        .filter(Boolean)
      if (list.indexOf(String(taskId)) !== -1) {
        var next = list.filter(function (id) {
          return id !== String(taskId)
        })
        tasks.getRange(j + 2, dependsCol).setValue(next.join(','))
      }
    }
  }

  return { removed: taskId }
}

// ---- Members ----------------------------------------------------------------

function updateMemberFields_(memberId, fields) {
  return updateRowFields_(SHEET_MEMBERS, memberId, fields)
}

// Adds a brand-new member row — used by Admin → Members "メンバーを登録",
// including registering someone directly as an admin (role != 一般).
function addMember_(name, email, affiliation, role, opts) {
  // メンバーにはメールアドレスが要る(メールアドレスで本人を照合してログインさせるため)
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(email || '').trim())) {
    throw userError_('メールアドレスが無い・形が正しくないため、メンバーを追加できません(メールアドレスが無いとログインできません)。')
  }
  email = String(email).trim()
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var id = String(nextIntId_(sheet, headers))
  var row = headers.map(function (h) {
    switch (h) {
      case 'id':
        return id
      case 'name':
        return name
      case 'role':
        return sheetRoleRef_(role || baseRoleRef_())
      case 'notify_new_task':
        return 'FALSE'
      default:
        return ''
    }
  })
  assertRowCellLengths_('Members', headers, row)
  protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, 'Members')
  sheet.appendRow(row)
  // affiliation isn't its own column — it's derived from project_ids (or,
  // for admin roles with none, defaulted client-side), so nothing to store
  // for it here; kept as a param for parity with the client-side call.
  if (email) setMemberEmail_(id, email)
  // 初期タスク(メンバーを作った時に1回だけ。失敗してもメンバーの追加は止めない)
  try { createInitialTasksForMember_(id, !!(opts && opts.firstLeader)) } catch (e) { console.error('初期タスクを作れませんでした: ' + maskEmailsIn_(String(e))) }
  return { id: id }
}

// ---- 初期タスク(メンバーを作った時に GAS で作る) ----
//
// メンバーを作った時(メンバーの追加・候補者のメンバー化・初期設定コードで最初の代表が入った時)に1回だけ作る。
// ログインの時には作らない(以前は画面だけで作っていたため、保存されず端末ごとに何度も付いた)。すでにいるメンバーには作らない。
//   新しいメンバー: Settings の initial_tasks_json([{ name, description }])があればそれ、無ければ INITIAL_MEMBER_TASKS
//   最初の代表: INITIAL_LEADER_TASKS(団体を使い始めるためにやること)
// タスクは「はじめに」のプロジェクトに入れる(無ければ作る)。承認待ちにせず、担当は本人
var INITIAL_TASKS_PROJECT_NAME = 'はじめに'
var INITIAL_TASKS_MAX = 20
var INITIAL_MEMBER_TASKS = [
  { name: 'Ohsumiの使い方を確認する', description: 'INPUT の画面で「今日やること」を入れて、承認を受けてみましょう。' },
  { name: 'プロフィールを設定する', description: '右上のアカウントのメニュー →「プロフィール」で、やりたいことと、スキルを登録しましょう。' },
  { name: 'チームメンバーのタスクを確認する', description: 'OUTPUT →「一覧」で、団体のタスク全体を見てみましょう。' },
]
var INITIAL_LEADER_TASKS = [
  { name: '団体の情報を設定する', description: 'ADMIN →「団体設定」で、団体名・ロゴ・テーマの色を入れます。' },
  { name: '役職と部署を決める', description: 'ADMIN →「部署と役職」で、団体に合わせて役職と部署を決めます。最初にある役職は「代表」と、設定例の「班長」です。班長の名前を変えたり、役職を足したり消したりしてかまいません。タスクの領域は「タスクの設定」で決めます。' },
  { name: 'メンバーを追加して招待する', description: 'ADMIN →「メンバー」の「メンバーを登録」で、名前とメールアドレスを入れ、「招待メールを送る」を選びます。' },
  { name: '最初のプロジェクトを作る', description: 'ADMIN →「プロジェクト」で、プロジェクトを1つ作ります(このタスクの「はじめに」とは別に作ります)。' },
  { name: '最初のタスクを作って担当を決める', description: 'INPUT の画面でタスクを入れ、担当者と期限を決めます。' },
  { name: '通知の受け取り方を決める', description: 'ADMIN →「団体設定」で Discord・Slack の通知先を、各自の「個人設定」(右上のメニュー)の通知でメールのまとめを決めます。' },
  { name: '安全の設定を確かめる', description: 'スプレッドシートを誰とも共有していないか、管理画面の上部の知らせ・団体の設定の「バックアップ」、団体のアカウントの2段階認証を確かめます。' },
  { name: '引き継ぎの準備をする', description: '団体の Google アカウントを誰が持ち、代替わりの時に誰に渡すかを決めて、メモに残します。' },
]

function initialTaskDefs_(firstLeader) {
  if (firstLeader) return INITIAL_LEADER_TASKS
  var custom = null
  try { custom = JSON.parse(String(getSettingValue_('initial_tasks_json') || '') || 'null') } catch (e) { custom = null }
  if (Array.isArray(custom)) {
    var list = custom.filter(function (t) { return t && String(t.name || '').trim() }).slice(0, INITIAL_TASKS_MAX).map(function (t) {
      return { name: String(t.name).trim().slice(0, 200), description: String(t.description || '').slice(0, 2000) }
    })
    if (list.length) return list
  }
  return INITIAL_MEMBER_TASKS
}

// 「はじめに」のプロジェクトの ID(無ければ作る)
function initialTasksProjectId_() {
  var table = snapshotTableOrSheet_(SHEET_PROJECTS) || { headers: [], rows: [] }
  var idCol = table.headers.indexOf('id'), nameCol = table.headers.indexOf('name')
  for (var i = 0; i < (table.rows || []).length; i++) {
    if (String(table.rows[i][nameCol] || '').trim() === INITIAL_TASKS_PROJECT_NAME) return String(table.rows[i][idCol])
  }
  // スナップショットが古い時のため、シートでも探す
  var sheet = getSheet_(SHEET_PROJECTS)
  var values = sheet.getDataRange().getValues()
  var h = (values[0] || []).map(function (x) { return String(x).trim() })
  for (var j = 1; j < values.length; j++) {
    if (String(values[j][h.indexOf('name')] || '').trim() === INITIAL_TASKS_PROJECT_NAME) return String(values[j][h.indexOf('id')])
  }
  return createProject_(INITIAL_TASKS_PROJECT_NAME, '新しいメンバー・代表が最初にやることのタスクを入れるプロジェクトです。', '').id
}

function createInitialTasksForMember_(memberId, firstLeader) {
  var defs = initialTaskDefs_(firstLeader)
  if (!defs.length) return []
  var projectId = initialTasksProjectId_()
  return createTasks_(defs.map(function (t, i) {
    return { tempId: 'init-' + i, projectId: projectId, title: t.name, description: t.description, assigneeIds: [String(memberId)],
      visibility: firstLeader ? 'leaders' : 'all', pendingApproval: false, difficulty: 'beginner', priority: 'medium' }
  }), String(memberId))
}

// ---- MemberEmails (非公開シート) ---------------------------------------------
//
// メールアドレスはMembersシート(公開CSV)には置かず、こちらの非公開シートに
// id(=Members.idと同じ値)をキーとして1人1行で保持する。読み書きは必ず
// このセクションの関数経由で行い、Membersシート側に書き戻さないこと。

// ---- 本人だけの保存(getMyStorage・setMyStorage) ----
//
// 画面が決めたキー(英小文字・数字・. _ -、64文字まで)ごとに、文字列の値を保存する。
// 読み書きできるのは本人の分だけ(メンバーID は認証済みの acting.id。画面が送るメンバーID は使わない)。
// 1人あたり PERSONAL_STORE_MAX_KEYS 個のキー・合わせて PERSONAL_STORE_MAX_CHARS 文字まで。
// 値は1つのセルの上限を超えないよう、PERSONAL_STORE_CHUNK 文字ずつの行に分ける。
// 初期データ・スナップショットには入れない(ほかの人には返さない)。個人情報の削除で消す
var SHEET_PERSONAL_STORE = 'PersonalStore'
var PERSONAL_STORE_CHUNK = 40000
var PERSONAL_STORE_MAX_CHARS = 150000
var PERSONAL_STORE_MAX_KEYS = 20
var PERSONAL_STORE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function personalStoreSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_PERSONAL_STORE)
  if (!sheet && create) sheet = getOrCreateSheet_(SHEET_PERSONAL_STORE, PERSONAL_STORE_HEADERS)
  return sheet
}

// 本人の行(行番号・キー・何番目か・値)。メンバーID の列だけを読んで探し、本人の行だけを読む
function personalStoreRows_(sheet, memberId) {
  var last = sheet ? sheet.getLastRow() : 0
  if (last < 2) return []
  var headers = headerRow_(sheet)
  var col = function (h) { return headers.indexOf(h) }
  var ids = sheet.getRange(2, col('id') + 1, last - 1, 1).getValues()
  var out = []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== String(memberId)) continue
    var r = sheet.getRange(i + 2, 1, 1, headers.length).getValues()[0]
    out.push({ row: i + 2, key: String(r[col('key')]), part: Number(r[col('part')]) || 0, value: String(r[col('value')] == null ? '' : r[col('value')]) })
  }
  return out
}

function personalStoreValues_(rows) {
  var byKey = {}
  rows.forEach(function (r) { (byKey[r.key] = byKey[r.key] || []).push(r) })
  var out = {}
  Object.keys(byKey).forEach(function (k) {
    out[k] = byKey[k].sort(function (a, b) { return a.part - b.part }).map(function (r) { return r.value }).join('')
  })
  return out
}

function getMyStorage_(memberId, keys) {
  var values = personalStoreValues_(personalStoreRows_(personalStoreSheet_(false), memberId))
  if (Array.isArray(keys)) {
    var picked = {}
    keys.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(values, String(k))) picked[String(k)] = values[String(k)] })
    values = picked
  }
  return { values: values }
}

// value: 文字列(画面が JSON にして送る)。null・空の文字列はキーを消す
function setMyStorage_(memberId, key, value) {
  key = String(key || '')
  if (!PERSONAL_STORE_KEY_RE.test(key)) throw userError_('保存のキーが正しくありません。')
  if (value !== null && value !== undefined && typeof value !== 'string') throw userError_('保存する値は文字列にしてください。')
  var text = value == null ? '' : value
  var sheet = personalStoreSheet_(true)
  var rows = personalStoreRows_(sheet, memberId)
  var current = personalStoreValues_(rows)
  var others = Object.keys(current).filter(function (k) { return k !== key })
  if (text) {
    if (others.length + 1 > PERSONAL_STORE_MAX_KEYS) throw userError_('保存できるキーは1人' + PERSONAL_STORE_MAX_KEYS + '個までです。')
    var total = text.length + others.reduce(function (n, k) { return n + current[k].length }, 0)
    if (total > PERSONAL_STORE_MAX_CHARS) throw userError_('保存できる大きさ(1人' + PERSONAL_STORE_MAX_CHARS + '文字)を超えています。')
  }
  var chunks = []
  for (var i = 0; i < text.length; i += PERSONAL_STORE_CHUNK) chunks.push(text.slice(i, i + PERSONAL_STORE_CHUNK))
  var mine = rows.filter(function (r) { return r.key === key }).sort(function (a, b) { return a.part - b.part })
  var headers = headerRow_(sheet)
  var now = new Date().toISOString()
  var rowOf = function (part, chunk) {
    var o = { id: String(memberId), key: key, part: part, value: chunk, updated_at: now }
    return headers.map(function (h) { return Object.prototype.hasOwnProperty.call(o, h) ? o[h] : '' })
  }
  chunks.forEach(function (chunk, part) {
    var target = mine[part] ? mine[part].row : sheet.getLastRow() + 1
    // 数式として扱われないよう、書式なしテキストにしてから書く
    sheet.getRange(target, 1, 1, headers.length).setNumberFormat('@')
    sheet.getRange(target, 1, 1, headers.length).setValues([rowOf(part, chunk)])
  })
  // 余った行は下から消す(行番号がずれないように)
  mine.slice(chunks.length).map(function (r) { return r.row }).sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  return { key: key, size: text.length }
}

// 個人情報の削除: 本人だけの保存を消す
function deletePersonalStore_(memberId) {
  var sheet = personalStoreSheet_(false)
  if (!sheet) return 0
  var rows = personalStoreRows_(sheet, memberId).map(function (r) { return r.row }).sort(function (a, b) { return b - a })
  rows.forEach(function (r) { sheet.deleteRow(r) })
  return rows.length
}

function getMemberEmailsSheet_() {
  return getOrCreateSheet_(SHEET_MEMBER_EMAILS, MEMBER_EMAILS_HEADERS)
}

// メンバー1人分のメール(カンマ区切りで複数可、Members.email時代と同じ仕様)を読む。
// 行が無ければ空文字を返す(例外を投げない — 未登録は「メールなし」として扱う)。
function getMemberEmailValue_(memberId) {
  var sheet = getMemberEmailsSheet_()
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var emailCol = headers.indexOf('email')
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return ''
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(memberId)) return String(values[i][emailCol] || '')
  }
  return ''
}

