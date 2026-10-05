// ---- まとめて送られた書き込み(batch) -------------------------------------------
//
// 画面の1回の操作から続けて送られる書き込み(例: 日程の変更と変更の記録)を、1回の通信で受け取る。
//   { action: 'batch', ops: [{ action, ... }, ...], requestId, sessionToken, clientVersion }
// 中の操作は、1本ずつ送った時と同じ権限の確認をし、順番に実行する。1つが断られても・失敗しても、
// ほかの操作はそのまま実行する(1本ずつ送った時と同じ)。ロック・送り直しの記録は、まとめて1回。
// 結果は { results: [{ ok, result } | { ok: false, error, forbidden? }, ...] }(ops と同じ順番)
var BATCH_MAX_OPS = 20
// まとめて送れない操作(ログイン・読み取り・ロックを取らない操作)
var BATCH_EXCLUDED_ACTIONS = ['batch', 'ping', 'getLoginConfig', 'exchangeIdToken', 'getInitialData', 'getInviteMailStatus', 'sendInviteLinkToMe']

function validateBatch_(body) {
  var ops = body && body.ops
  if (!Array.isArray(ops) || ops.length === 0) return 'まとめて送る操作がありません。'
  if (ops.length > BATCH_MAX_OPS) return 'まとめて送れる操作は' + BATCH_MAX_OPS + '件までです。'
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i]
    if (!op || typeof op !== 'object' || typeof op.action !== 'string') return 'まとめて送る操作の形式が不正です。'
    if (BATCH_EXCLUDED_ACTIONS.indexOf(op.action) >= 0 || LOCK_EXEMPT_ACTIONS.indexOf(op.action) >= 0) {
      return 'この操作はまとめて送れません: ' + op.action
    }
  }
  return null
}

// 操作ごとの権限の確認。断られた操作は理由、許可された操作は null
function authorizeBatch_(acting, ops) {
  return ops.map(function (op) {
    try {
      authorizeAction_(acting, op.action, op)
      return null
    } catch (err) {
      return toErrorMessage_(err)
    }
  })
}

// ---- 片方だけ成功すると困る組み合わせ ----
//
// 同じ batch の中で、ある操作(記録・通知など)が別の操作(変更そのもの)を前提にしている時は、
// 前提の操作を先に実行し、前提がすべて成功した時だけ実行する(断られた・失敗した時は実行せず、
// skipped: true で返す)。画面は記録・確認タスクなどを変更より先に送ることがあるので、順番もここで入れ替える。
//   updateHistory(変更の記録)       ← 記録した項目を変える操作(同じタスク)
//   notifyScheduleResult・notifyFormResult(回答がそろった通知) ← 回答の保存と完了への変更(同じタスク)
//   updateProjectMembers(担当者をプロジェクトに加える) ← 担当者の変更(そのプロジェクトのタスク)
//   updateSkillLevels・updateJudgment(完了で付くスキル・認定) ← 完了への変更(そのメンバーが担当のタスク)
//   createTasks(確認タスクの作成)      ← 確認待ちへの変更(確認タスクの元のタスク)
// 前提の操作が同じ batch に無い時は、これまでどおり実行する(1本ずつ送った時と同じ)

// 変更の記録の項目 → その項目を変える操作
var HISTORY_FIELD_ACTIONS = {
  status: ['updateTaskStatus'],
  assignee: ['assignTask'],
  deadline: ['updateSchedule'],
  startDate: ['updateSchedule'],
  reviewer: ['updateReviewer', 'updateReviewers'],
  priority: ['updatePriority', 'updateTaskDetails'],
  difficulty: ['updateDifficulty', 'updateTaskDetails'],
  visibility: ['updateVisibility', 'updateTaskDetails'],
  title: ['updateTaskDetails'],
  description: ['updateTaskDetails'],
  project: ['updateTaskDetails'],
  department: ['updateTaskDetails'],
  category: ['updateTaskDetails'],
  skills: ['updateTaskDetails'],
  importance: ['updateTaskDetails'],
}
// 記録の項目が分からない時は、タスクの項目を変える操作すべてを前提にする
var HISTORY_ANY_FIELD_ACTIONS = (function () {
  var all = []
  Object.keys(HISTORY_FIELD_ACTIONS).forEach(function (f) {
    HISTORY_FIELD_ACTIONS[f].forEach(function (a) { if (all.indexOf(a) < 0) all.push(a) })
  })
  return all
})()

function sameId_(a, b) {
  return a != null && b != null && String(a) !== '' && String(a) === String(b)
}

// 変更の記録のうち、今回足された項目(シートの記録に無い ID の項目)。分からなければ null
function addedHistoryFields_(op) {
  if (!Array.isArray(op.history)) return null
  var task = null
  try { task = authFindRow_(SHEET_TASKS, String(op.taskId || '')) } catch (e) { task = null }
  if (!task) return null
  var old = []
  try { old = JSON.parse(task.history_json || '[]') } catch (e) { old = [] }
  var oldIds = {}
  ;(Array.isArray(old) ? old : []).forEach(function (h) { if (h && h.id) oldIds[h.id] = true })
  var fields = []
  op.history.forEach(function (h) {
    if (h && h.id && !oldIds[h.id] && fields.indexOf(h.field) < 0) fields.push(h.field)
  })
  return fields
}

function batchTaskRow_(taskId) {
  try { return authFindRow_(SHEET_TASKS, String(taskId || '')) } catch (e) { return null }
}

// op(ops[i])が前提にする操作の番号
function batchPrerequisites_(ops, i) {
  var op = ops[i]
  var out = []
  var memo = {}
  var fieldsOnce = function () {
    if (!('fields' in memo)) memo.fields = addedHistoryFields_(op)
    return memo.fields
  }
  ops.forEach(function (other, j) {
    if (j === i || !other) return
    var a = other.action
    var needs = false
    switch (op.action) {
      case 'updateHistory':
        if (sameId_(other.taskId, op.taskId) && HISTORY_ANY_FIELD_ACTIONS.indexOf(a) >= 0) {
          var fields = fieldsOnce()
          needs = fields === null
            ? true
            : fields.some(function (f) { return (HISTORY_FIELD_ACTIONS[f] || HISTORY_ANY_FIELD_ACTIONS).indexOf(a) >= 0 })
        }
        break
      case 'notifyScheduleResult':
        needs = sameId_(other.taskId, op.taskId) && (a === 'updateTaskStatus' || a === 'updateTaskSchedule')
        break
      case 'notifyFormResult':
        needs = sameId_(other.taskId, op.taskId) && (a === 'updateTaskStatus' || a === 'updateTaskForm')
        break
      case 'updateProjectMembers':
        if (a === 'assignTask') {
          var assigned = batchTaskRow_(other.taskId)
          needs = !!assigned && sameId_(assigned.project_id, op.projectId)
        }
        break
      case 'updateSkillLevels':
      case 'updateJudgment':
        if (a === 'updateTaskStatus' && other.status === 'done') {
          var doneTask = batchTaskRow_(other.taskId)
          var assignees = doneTask ? String(doneTask.assignee_id || '').split(',').map(function (s) { return s.trim() }) : []
          needs = assignees.indexOf(String(op.memberId)) >= 0
        }
        break
      case 'createTasks':
        needs = a === 'updateTaskStatus' && other.status === 'review' &&
          (op.tasks || []).some(function (t) { return t && sameId_(t.relatedReviewTaskId, other.taskId) })
        break
    }
    if (needs) out.push(j)
  })
  return out
}

var BATCH_SKIPPED_ERROR = '一緒に送った変更が保存されなかったため、この操作は行いませんでした。'

function runBatch_(ops, acting, denied) {
  noteTiming_('batchOps', ops.length)
  var results = ops.map(function () { return null })
  var prereqs = ops.map(function (op, i) { return batchPrerequisites_(ops, i) })
  var remaining = ops.length
  // 前提の操作が済んだものから、元の順番で実行する(前提が済んでいない操作は後に回す)
  while (remaining > 0) {
    var progressed = false
    for (var i = 0; i < ops.length; i++) {
      if (results[i]) continue
      var waiting = prereqs[i].some(function (j) { return !results[j] })
      if (waiting) continue
      progressed = true
      remaining--
      if (denied && denied[i]) {
        results[i] = { ok: false, error: denied[i], forbidden: true }
        continue
      }
      if (prereqs[i].some(function (j) { return !results[j].ok })) {
        results[i] = { ok: false, error: BATCH_SKIPPED_ERROR, skipped: true }
        continue
      }
      try {
        results[i] = { ok: true, result: runWriteAction_(ops[i], acting) }
      } catch (err) {
        results[i] = errorResponse_(err, ops[i].action)
      }
      break
    }
    if (!progressed) {
      // 前提が互いを待っている(起きないはず)。安全側に、残りは実行しない
      for (var k = 0; k < ops.length; k++) {
        if (!results[k]) results[k] = { ok: false, error: BATCH_SKIPPED_ERROR, skipped: true }
      }
      remaining = 0
    }
  }
  return results
}

