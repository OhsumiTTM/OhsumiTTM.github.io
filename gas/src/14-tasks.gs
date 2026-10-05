// ---- Tasks ----------------------------------------------------------------

// New rows are built by walking the sheet's actual header row (see
// gas/README.md for the full column list), so this works regardless of
// column order and leaves any column not listed below blank.
// タスクを作る。opts.allowImport: 幹部の取り込み(t.import === true)の項目を受け付ける(createTasks の操作で、幹部の時だけ)。
// 取り込みでは、状態・確認者・必要な承認数・想定/実績の時間・成果物・前提タスク(同じ取り込みの中のタスク)・公募かどうか・
// 保留の理由も入れられる。取り込んだタスクは承認待ちにしない。完了として取り込んだタスクには、スキルの点数を付けない
// (awarded_points_json の __noAward。awardSkillPoints_ が断る)。値を確かめてから書く(1つでもおかしければ、何も作らない)
var IMPORT_MAX_HOURS = 10000
var IMPORT_MAX_DELIVERABLES = 50
function createTasks_(tasks, actingMemberId, opts) {
  opts = opts || {}
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var nextId = nextIntId_(sheet, headers)
  var today = todayStr_()
  var created = []
  tasks = (tasks || []).filter(Boolean)
  // 同じ取り込みの中の前提タスク(仮の ID → 作る ID)
  var idOfTemp = {}
  tasks.forEach(function (t, i) { if (t.tempId) idOfTemp[String(t.tempId)] = String(nextId + i) })
  var activeMembers = null

  var rows = tasks.map(function (t, i) {
    var id = String(nextId + i)
    var imp = null
    if (t.import === true) {
      if (!opts.allowImport) throw userError_('タスクの取り込み(状態・確認者などを入れて作る)は、幹部だけができます。')
      if (!activeMembers) activeMembers = importActiveMemberIds_()
      imp = importTaskValues_(t, id, idOfTemp, activeMembers, today)
    }
    var row = headers.map(function (h) {
      if (imp && Object.prototype.hasOwnProperty.call(imp, h)) return imp[h]
      switch (h) {
        case 'id':
          return id
        case 'project_id':
          return t.projectId
        case 'title':
          return t.title
        case 'description':
          return t.description || ''
        case 'status':
          return sheetCode_('status', 'todo')
        case 'assign_type':
          return 'open_bid'
        case 'assignee_id':
          return (t.assigneeIds || []).join(',')
        case 'creator_id':
          // F1: クライアントが送ってきた t.creatorId は使わない(なりすまし防止)。
          // 必ず認証済みの本人ID(actingMemberId)を記録する。
          return actingMemberId || ''
        case 'created_at':
          return today
        case 'start_date':
          return t.startDate || ''
        case 'due_date':
          return t.deadline || ''
        case 'due_time':
          return t.dueTime || ''
        case 'visibility':
          return sheetCode_('visibility', t.visibility)
        case 'department':
          return sheetValue_('department', t.department)
        case 'category':
          return t.category || ''
        case 'skills':
          return (t.skills || []).join(',')
        case 'difficulty':
          return t.difficulty ? sheetCode_('difficulty', t.difficulty) : ''
        case 'priority':
          return t.priority ? sheetCode_('priority', t.priority) : ''
        case 'last_activity':
          return today
        case 'original_input_id':
          return t.originalInputId || ''
        case 'approval_status':
          return sheetCode_('approval', t.pendingApproval === false ? 'approved' : 'pending')
        case 'estimated_hours':
          return t.estimatedHours || ''
        case 'importance':
          return t.importance ? sheetCode_('importance', t.importance) : ''
        case 'related_review_task_id':
          return t.relatedReviewTaskId || ''
        // 日程調整・フォームのクイック追加の中身(prepareCreateTasks_ で確かめたもの)
        case 'schedule_json':
          return t.quickKind === 'schedule' ? JSON.stringify(mapScheduleCodes_(t.schedule, sheetCode_)) : ''
        case 'form_json':
          return t.quickKind === 'form' ? JSON.stringify(t.form) : ''
        default:
          return ''
      }
    })
    // F4: 値を書き込む前に対象列を書式なしテキスト(@)にする
    assertRowCellLengths_('Tasks', headers, row)
    return { t: t, id: id, row: row, imported: !!imp }
  })

  rows.forEach(function (r) {
    var row = r.row
    protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, 'Tasks')
    sheet.appendRow(row)
    created.push({ tempId: r.t.tempId, id: r.id })
    if (r.t.assigneeIds && r.t.assigneeIds.length > 0) syncCalendarForTask_(r.id)
  })

  // template tasks (pendingApproval === false) don't need an approval-queue email
  var needsApproval = rows.filter(function (r) {
    return !r.imported && r.t.pendingApproval !== false
  }).map(function (r) { return r.t })
  if (needsApproval.length > 0) notifyNewTasks_(needsApproval)
  return created
}

// createTasks の前に、画面から届いた値を確かめる。
//   - 日付・時刻・予定の工数の形。担当者は在籍しているメンバーだけ
//   - 承認なし(pendingApproval: false)は、管理者の役職の時だけ受け付ける。一般のメンバーは承認待ちにする。
//     ただし次の3つは、一般のメンバーでも承認なしで作れる(GAS で形を確かめる):
//       ① 確認タスク: 元のタスクがあり、操作した人がその担当者で、担当がその確認者だけ
//       ② 日程調整・③ フォームのクイック追加(quickKind): 担当者なし・日程調整/フォームの中身(候補・項目が1つ以上、回答なし)
function prepareCreateTasks_(tasks, acting) {
  if (!Array.isArray(tasks)) throw userError_('タスクの一覧の形式が不正です。')
  var isAdmin = isAdminRoleRef_(getRoles_(), acting.role)
  tasks.forEach(function (t) {
    if (!t || typeof t !== 'object') throw userError_('タスクの形式が不正です。')
    t.startDate = checkDate_(t.startDate, '開始日')
    t.deadline = checkDate_(t.deadline, '期限')
    t.dueTime = checkTime_(t.dueTime, '期限の時刻')
    t.estimatedHours = checkHours_(t.estimatedHours, '予定の工数')
    t.assigneeIds = checkActiveMembers_(t.assigneeIds || [], '担当者')
    if (t.quickKind !== undefined && t.quickKind !== 'schedule' && t.quickKind !== 'form') throw userError_('クイック追加の種類が不正です。')
    if (t.quickKind) checkQuickTaskContent_(t)
    if (t.pendingApproval === false && !isAdmin && !approvalExemptTask_(t, acting)) t.pendingApproval = true
  })
}

function checkQuickTaskContent_(t) {
  if ((t.assigneeIds || []).length) throw userError_('日程調整・フォームのクイック追加には、担当者を付けられません。')
  var c = t.quickKind === 'schedule' ? t.schedule : t.form
  var items = c && (t.quickKind === 'schedule' ? c.candidates : c.fields)
  if (!c || typeof c !== 'object' || !Array.isArray(items) || !items.length) {
    throw userError_(t.quickKind === 'schedule' ? '日程調整の候補を1つ以上入れてください。' : 'フォームの項目を1つ以上入れてください。')
  }
  c.invitedIds = checkActiveMembers_(c.invitedIds || [], '招待するメンバー')
  c.responses = {}
}

function approvalExemptTask_(t, acting) {
  if (t.quickKind) return true
  if (!t.relatedReviewTaskId || !(t.assigneeIds || []).length) return false
  var orig = null
  try { orig = lockedRow_(SHEET_TASKS, String(t.relatedReviewTaskId)) } catch (e) { orig = null }
  if (!orig) return false
  if (splitCsvList_(orig.assignee_id).indexOf(String(acting.id)) < 0) return false
  var reviewers = splitCsvList_(orig.reviewer_ids || orig.reviewer_id)
  return t.assigneeIds.every(function (id) { return reviewers.indexOf(id) >= 0 })
}

// 取り込みで確認者・担当者にできる人(在籍しているメンバー)
function importActiveMemberIds_() {
  var out = {}
  snapshotMembers_().forEach(function (m) {
    if (String(m.withdrawn_at || '') === '') out[String(m.id)] = true
  })
  return out
}

