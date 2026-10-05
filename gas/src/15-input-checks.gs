// ---- 画面から届いた値の確かめ(日付・数・メンバー・タスク・プロジェクト・輪) ----
// どれも、おかしな値は保存せずに断る(userError_)。空の値は「消す」として受け付ける(呼ぶ側で必須を確かめる)
var DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}$/
var TIME_VALUE_RE = /^([01]\d|2[0-3]):[0-5]\d$/
var HOURS_MAX = 10000

function isRealDate_(s) {
  if (!DATE_VALUE_RE.test(s)) return false
  var d = new Date(s + 'T00:00:00Z')
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// YYYY-MM-DD(空はそのまま空)
function checkDate_(v, label) {
  if (v === undefined || v === null || v === '') return ''
  var s = String(v)
  if (!isRealDate_(s)) throw userError_(label + 'は YYYY-MM-DD の形(例: 2026-10-05)で入れてください。')
  return s
}

function checkDateList_(list, label) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw userError_(label + 'の形式が不正です。')
  return list.map(function (d) {
    if (d === '' || d === null || d === undefined) throw userError_(label + 'に空の日付があります。')
    return checkDate_(d, label)
  })
}

// HH:MM(空はそのまま空)
function checkTime_(v, label) {
  if (v === undefined || v === null || v === '') return ''
  var s = String(v)
  if (!TIME_VALUE_RE.test(s)) throw userError_(label + 'は HH:MM の形(例: 09:30)で入れてください。')
  return s
}

// 0〜100 の数
function checkPercent_(v) {
  var n = Number(v)
  if (v === '' || v === null || typeof v === 'boolean' || !isFinite(n) || n < 0 || n > 100) throw userError_('進み具合は0〜100の数で入れてください。')
  return n
}

// 0 以上の時間(空はそのまま空)
function checkHours_(v, label) {
  if (v === undefined || v === null || v === '') return ''
  var n = Number(v)
  if (typeof v === 'boolean' || !isFinite(n) || n < 0 || n > HOURS_MAX) throw userError_(label + 'は0〜' + HOURS_MAX + 'の数で入れてください。')
  return n
}

// 必要な承認の数: 1 以上で確認者の数以下、または all(空はそのまま空)
function checkRequiredApprovals_(v, reviewerCount) {
  if (v === undefined || v === null || v === '') return ''
  if (v === 'all') return 'all'
  var n = Number(v)
  if (Math.floor(n) !== n || n < 1 || n > reviewerCount) {
    throw userError_('必要な承認の数は、1〜確認者の数(' + reviewerCount + ')、または all で入れてください。')
  }
  return n
}

// 在籍しているメンバー(退会していない)の ID の一覧
function activeMemberIdSet_() {
  var out = {}
  snapshotMembers_().forEach(function (m) {
    if (String(m.withdrawn_at || '') === '') out[String(m.id)] = true
  })
  return out
}

// メンバーの ID の一覧を確かめる(在籍しているメンバーだけ。重ねて入っていれば1つにする)
function checkActiveMembers_(list, label) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw userError_(label + 'の形式が不正です。')
  var active = activeMemberIdSet_()
  var ids = list.map(function (x) { return String(x === null || x === undefined ? '' : x).trim() }).filter(Boolean)
  ids.forEach(function (id) {
    if (!active[id]) throw userError_(label + 'に、登録されていない(または退会した)メンバーがいます。')
  })
  return ids.filter(function (id, i) { return ids.indexOf(id) === i })
}

// メンバーを1人(空はそのまま空)
function checkActiveMember_(id, label) {
  var s = String(id === null || id === undefined ? '' : id).trim()
  if (!s) return ''
  return checkActiveMembers_([s], label)[0]
}

function snapshotRowsOf_(sheetName) {
  var t = snapshotTableOrSheet_(sheetName) || { headers: [], rows: [] }
  return (t.rows || []).map(function (r) {
    var o = {}
    ;(t.headers || []).forEach(function (h, i) { o[h] = r[i] })
    return o
  })
}

// 前提タスク: あるタスクだけ・自分自身でない・輪にならない
function checkDependsOn_(taskId, list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw userError_('前提タスクの形式が不正です。')
  var deps = list.map(function (x) { return String(x).trim() }).filter(Boolean)
  deps = deps.filter(function (d, i) { return deps.indexOf(d) === i })
  var graph = {}
  snapshotRowsOf_(SHEET_TASKS).forEach(function (t) { graph[String(t.id)] = splitCsvList_(t.depends_on_ids) })
  deps.forEach(function (d) {
    if (d === String(taskId)) throw userError_('前提タスクに、そのタスク自身は選べません。')
    if (!graph[d]) throw userError_('前提タスクに、見つからないタスクがあります。')
  })
  graph[String(taskId)] = deps
  // taskId からたどって taskId に戻れば輪
  var seen = {}
  var stack = deps.slice()
  while (stack.length) {
    var cur = stack.pop()
    if (cur === String(taskId)) throw userError_('前提タスクが輪になります(AがBの前提で、BがAの前提、など)。')
    if (seen[cur]) continue
    seen[cur] = true
    ;(graph[cur] || []).forEach(function (n) { stack.push(n) })
  }
  return deps
}

// 1つの親をたどる関係(親プロジェクト・報告先)が、自分自身・輪にならないか
function checkNoParentLoop_(id, parentId, parentOf, label) {
  var start = String(parentId || '')
  if (!start) return
  if (start === String(id)) throw userError_(label + 'に、自分自身は選べません。')
  var seen = {}
  var cur = start
  while (cur) {
    if (cur === String(id)) throw userError_(label + 'が輪になります(AがBの' + label + 'で、BがAの' + label + '、など)。')
    if (seen[cur]) break
    seen[cur] = true
    cur = String(parentOf[cur] || '')
  }
}

function checkProjectParent_(projectId, parentId) {
  var p = String(parentId || '').trim()
  if (!p) return ''
  var parentOf = {}
  snapshotRowsOf_(SHEET_PROJECTS).forEach(function (r) { parentOf[String(r.id)] = String(r.parent_id || '') })
  if (!Object.prototype.hasOwnProperty.call(parentOf, p)) throw userError_('親プロジェクトが見つかりません。')
  checkNoParentLoop_(projectId, p, parentOf, '親プロジェクト')
  return p
}

function checkReportsTo_(memberId, reportsToId) {
  var r = checkActiveMember_(reportsToId, '報告先')
  if (!r) return ''
  var parentOf = {}
  snapshotMembers_().forEach(function (m) { parentOf[String(m.id)] = String(m.reports_to_id || '') })
  checkNoParentLoop_(memberId, r, parentOf, '報告先')
  return r
}

// メールアドレス(カンマで区切って複数も可)。空にはさせない
function checkEmailList_(v) {
  var list = String(v === null || v === undefined ? '' : v).split(',').map(function (s) { return s.trim() }).filter(Boolean)
  if (!list.length) throw userError_('メールアドレスを入れてください(空にはできません)。')
  list.forEach(function (e) {
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e)) throw userError_('メールアドレスの形が正しくありません: ' + e)
  })
  return list.join(',')
}

function importHours_(v, label, title) {
  if (v === undefined || v === null || v === '') return ''
  var n = Number(v)
  if (!isFinite(n) || n < 0 || n > IMPORT_MAX_HOURS) throw userError_('「' + title + '」の' + label + 'は、0〜' + IMPORT_MAX_HOURS + 'の数で入れてください。')
  return n
}

// 取り込みの項目を確かめて、列の値にする
function importTaskValues_(t, id, idOfTemp, activeMembers, today) {
  var title = String(t.title || '')
  var out = { approval_status: sheetCode_('approval', 'approved') }

  // 状態(コード・日本語の表示名のどちらでもよい)
  var status = 'todo'
  if (t.status !== undefined && t.status !== null && String(t.status).trim() !== '') {
    var raw = String(t.status).trim()
    var table = VALUE_CODES.status
    var known = table.codes.indexOf(raw) >= 0 || table.codes.some(function (c) { return table.sheetLabels[c] === raw })
    if (!known) throw userError_('「' + title + '」の状態「' + raw + '」は使えません。')
    status = normalizeCode_('status', raw)
  }
  out.status = sheetCode_('status', status)
  if (status === 'done') {
    out.completed_date = /^\d{4}-\d{2}-\d{2}$/.test(String(t.completedDate || '')) ? String(t.completedDate) : today
    out.awarded_points_json = JSON.stringify({ __noAward: true, __imported: true })
  }

  // 担当者・確認者は、在籍しているメンバーだけ
  var checkMembers = function (list, label) {
    var ids = (Array.isArray(list) ? list : []).map(function (x) { return String(x).trim() }).filter(Boolean)
    ids.forEach(function (m) {
      if (!activeMembers[m]) throw userError_('「' + title + '」の' + label + 'に、登録されていない(または退会した)メンバーがいます。')
    })
    return ids.filter(function (m, i) { return ids.indexOf(m) === i })
  }
  checkMembers(t.assigneeIds, '担当者')
  var reviewers = checkMembers(t.reviewerIds, '確認者')
  if (reviewers.length) {
    out.reviewer_ids = reviewers.join(',')
    out.reviewer_id = reviewers[0]
  }
  if (t.requiredApprovals !== undefined && t.requiredApprovals !== null && t.requiredApprovals !== '') {
    var ra = t.requiredApprovals
    if (ra !== 'all') {
      ra = Number(ra)
      if (!reviewers.length || Math.floor(ra) !== ra || ra < 1 || ra > reviewers.length) {
        throw userError_('「' + title + '」の必要な承認の数は、1〜確認者の人数(または all)で入れてください。')
      }
    }
    out.required_approvals = String(ra)
  }

  out.estimated_hours = importHours_(t.estimatedHours, '想定の時間', title)
  out.actual_hours = importHours_(t.actualHours, '実績の時間', title)

  // 成果物(http/https のリンクだけ)
  if (t.deliverables !== undefined && t.deliverables !== null) {
    if (!Array.isArray(t.deliverables) || t.deliverables.length > IMPORT_MAX_DELIVERABLES) {
      throw userError_('「' + title + '」の成果物は、' + IMPORT_MAX_DELIVERABLES + '件までの一覧で入れてください。')
    }
    out.deliverables_json = JSON.stringify(t.deliverables.map(function (d, i) {
      var url = String((d && d.url) || '').trim()
      if (!isSafeHttpUrl_(url)) throw userError_('成果物のURLは http または https で始まるURLのみ登録できます。')
      return { id: 'd-' + id + '-' + (i + 1), label: String((d && d.label) || url).slice(0, 200), url: url }
    }))
  }

  // 前提タスク: 同じ取り込みの中のタスク(仮の ID)
  if (t.dependsOnTempIds !== undefined && t.dependsOnTempIds !== null) {
    var deps = (Array.isArray(t.dependsOnTempIds) ? t.dependsOnTempIds : []).map(function (x) {
      var real = idOfTemp[String(x)]
      if (!real) throw userError_('「' + title + '」の前提タスクは、同じ取り込みの中のタスクだけを選べます。')
      if (real === id) throw userError_('「' + title + '」の前提タスクに、そのタスク自身は選べません。')
      return real
    })
    out.depends_on_ids = deps.filter(function (d, i) { return deps.indexOf(d) === i }).join(',')
  }

  // 公募にしない(担当を決めて割り当てる)
  if (t.openBid === false) out.assign_type = 'manager_assign'

  // 保留の理由(状態が保留の時だけ)
  var hold = String(t.holdReason || '').trim()
  if (hold) {
    if (status !== 'hold') throw userError_('「' + title + '」の保留の理由は、状態が保留の時だけ入れられます。')
    out.hold_reason_note = hold.slice(0, 1000)
    out.hold_reason_since = today
  }
  return out
}

function updateTaskFields_(taskId, fields) {
  return updateRowFields_(SHEET_TASKS, taskId, fields)
}

// 確認者ごとの承認を記録し、requiredApprovals(必要承認数、'all'なら
// 確認者全員)に達したら自動的にstatus: '完了'にする。既に承認済みの
// actorIdが再度呼んでも重複追加しない（冪等）。
// TSK-062+TSK-067統合: commentはレビューフィードバック兼次回への申し送り
// メモとして任意で残せる。既に承認済みの場合は(冪等のため)commentを
// 上書きしない。
function approveTaskReview_(taskId, actorId, comment) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('タスクが見つかりません: ' + taskId)
  var approvals = []
  try { approvals = JSON.parse(task.review_approvals_json || '[]') } catch (_) {}
  var already = approvals.some(function (a) { return a.memberId === actorId })
  if (!already) {
    approvals.push({ memberId: actorId, at: new Date().toISOString(), comment: comment || undefined })
  }
  var reviewerIds = String(task.reviewer_ids || task.reviewer_id || '')
    .split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var needed = task.required_approvals === 'all'
    ? reviewerIds.length
    : (Number(task.required_approvals) || 1)
  var fields = { review_approvals_json: JSON.stringify(approvals), last_activity: todayStr_() }
  if (approvals.length >= needed) {
    fields.status = sheetCode_('status', 'done')
    fields.completed_date = todayStr_()
  }
  var result = updateRowFields_(SHEET_TASKS, taskId, fields)
  if (approvals.length >= needed) {
    completeRelatedReviewTasks_(taskId)
  }
  return result
}

// APR-007: 元タスクの承認が完了した際、対応する確認タスク（related_review_task_id
// が元タスクのidと一致するタスク）も自動的に完了にする
function completeRelatedReviewTasks_(originalTaskId) {
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var relCol = headers.indexOf('related_review_task_id')
  var statusCol = headers.indexOf('status')
  if (relCol < 0 || sheet.getLastRow() <= 1) return
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][relCol] || '') === String(originalTaskId) && normalizeCode_('status', rows[i][statusCol]) !== 'done') {
      updateRowFields_(SHEET_TASKS, String(rows[i][idCol]), {
        status: sheetCode_('status', 'done'),
        completed_date: todayStr_(),
        last_activity: todayStr_(),
      })
    }
  }
}

function updateProjectFields_(projectId, fields) {
  return updateRowFields_(SHEET_PROJECTS, projectId, fields)
}

// item 26: 幹部による健康状態の手動上書き。healthOverrideが空/nullなら
// 上書き解除（自動判定に戻す）— この場合はlast_notified_healthは据え置き、
// 通知も送らない。値が指定された場合は、その値が実効的な健康状態になる
// ため、last_notified_healthも更新し、必ず通知を送る（「変更した」という
// 行為自体を都度知らせるため、結果がgoodでも送る）。
function updateProjectHealthOverride_(projectId, healthOverride) {
  var value = healthOverride || ''
  var fields = { health_override: value }
  if (value) fields.last_notified_health = value
  var result = updateProjectFields_(projectId, fields)
  if (value) {
    notifyProjectHealthChanged_(projectId, value, 'に手動で変更されました')
  }
  return result
}

// item 26: 自動判定が変化した（前回通知時と異なる状態になった）際の通知。
// 以前のフロント(1件ずつ送る)との互換のために残している。新しいフロントは
// reportProjectHealth でまとめて送る。健康状態が一度も記録されていない
// プロジェクトは、初回の計算なので記録だけして通知しない。記録が既に同じ状態
// (別の管理者の画面が先に記録・通知した場合など)なら通知しない。比較と記録は
// doPost のロックの中で行うため、同時に呼ばれても二重には通知しない。
function notifyProjectHealth_(projectId, health) {
  var project = findRow_(SHEET_PROJECTS, projectId)
  var last = project ? String(project.last_notified_health || '').trim() : ''
  var result = updateProjectFields_(projectId, { last_notified_health: health })
  if (project && last && last !== health) notifyProjectHealthChanged_(projectId, health, 'に変化しました（自動判定）')
  return result
}

var PROJECT_HEALTH_LEVELS = ['good', 'watch', 'attention']
// 1回の reportProjectHealth で受け付けるプロジェクトの数の上限
var REPORT_PROJECT_HEALTH_MAX_ITEMS = 500

// 自動判定の結果(items: [{ projectId, health }])を受け取り、シート上の記録
// (last_notified_health)と比べて、記録の更新と通知を決める。フロントの判定は
// 古いデータに基づく場合があるため、ここでシートの値を読み直して判断する。
//   - 手動上書き(health_override)中のプロジェクト: 何もしない
//   - 記録が空(一度も記録されていない): 初回の計算なので、記録だけして通知しない
//   - attention 以外 → attention: 記録して通知する
//   - attention → attention 以外: 記録だけする(次に悪化した時に再び通知するため)
//   - それ以外: 何もしない
// 通知が必要なプロジェクトが複数あっても、メール・Discord・Slack とも1通にまとめる。
// 記録との比較と記録の更新は、doPost のロック(LockService)の中で行われる
// (このアクションはロックの対象)。複数の管理者がほぼ同時に開いても、後の
// 呼び出しは先の呼び出しが更新した記録と比べるため、同じ変化を二重に通知しない。
function reportProjectHealth_(items) {
  if (!Array.isArray(items)) throw userError_('健康状態の一覧が不正です。')
  if (items.length > REPORT_PROJECT_HEALTH_MAX_ITEMS) throw userError_('一度に送れるプロジェクトの数を超えています。')
  var wanted = {}
  items.forEach(function (item) {
    var id = String((item && item.projectId) || '')
    var health = String((item && item.health) || '')
    if (id && PROJECT_HEALTH_LEVELS.indexOf(health) !== -1) wanted[id] = health
  })

  var sheet = getSheet_(SHEET_PROJECTS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var nameCol = headers.indexOf('name')
  var overrideCol = headers.indexOf('health_override')
  var recordCol = headers.indexOf('last_notified_health')
  if (idCol === -1 || recordCol === -1) {
    throw userError_('プロジェクトのシートに last_notified_health 列がありません。setupOhsumi() を実行してください。')
  }
  var lastRow = sheet.getLastRow()
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : []

  var recorded = []
  var notified = []
  rows.forEach(function (r, i) {
    var id = String(r[idCol])
    var health = wanted[id]
    if (!health) return
    if (overrideCol !== -1 && String(r[overrideCol] || '').trim()) return
    var last = String(r[recordCol] || '').trim()
    var notify = false
    if (!last) {
      notify = false
    } else if (health === 'attention' && last !== 'attention') {
      notify = true
    } else if (health !== 'attention' && last === 'attention') {
      notify = false
    } else {
      return
    }
    sheet.getRange(i + 2, recordCol + 1).setValue(health)
    recorded.push(id)
    if (notify) notified.push({ id: id, name: nameCol !== -1 ? String(r[nameCol] || '') : id, health: health })
  })

  if (notified.length > 0) {
    notifyProjectHealthChangedBatch_(notified, 'に変化しました（自動判定）')
  }
  return { recorded: recorded, notified: notified.map(function (p) { return p.id }) }
}

function notifyProjectHealthChanged_(projectId, health, note) {
  try {
    var project = findRow_(SHEET_PROJECTS, projectId)
    if (!project) return
    notifyProjectHealthChangedBatch_([{ id: projectId, name: project.name, health: health }], note)
  } catch (err) {
    console.error('notifyProjectHealthChangedの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// チャットの1通に並べるプロジェクトの数の上限(Discord は1通2,000文字まで)
var PROJECT_HEALTH_CHAT_MAX_LINES = 20

// 健康状態が変わったプロジェクト(1件以上)を、メール1通・Discord/Slack 各1通で知らせる。
// projects: [{ id, name, health }]
function notifyProjectHealthChangedBatch_(projects, note) {
  try {
    if (!projects || projects.length === 0) return
    var labelsJa = { good: '良好', watch: '要注意', attention: '要対応' }
    var labelsEn = { good: 'Good', watch: 'Needs attention', attention: 'Needs action' }
    var noteEn = note === 'に手動で変更されました'
      ? ' (changed manually)'
      : note === 'に変化しました（自動判定）'
        ? ' (changed automatically)'
        : ''
    var templates
    if (projects.length === 1) {
      var p = projects[0]
      var ja = labelsJa[p.health] || p.health
      var en = labelsEn[p.health] || p.health
      templates = {
        ja: {
          subject: '[Ohsumi] プロジェクト「' + p.name + '」の健康状態: ' + ja,
          body: 'プロジェクト「' + p.name + '」の健康状態が「' + ja + '」' +
            (note || '') + '\n\nOhsumiのダッシュボードで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Project "' + p.name + '" health: ' + en,
          body: 'The health of project "' + p.name + '" is now "' + en + '"' +
            noteEn + '.\n\nCheck the Ohsumi dashboard for details.',
        },
      }
    } else {
      templates = {
        ja: {
          subject: '[Ohsumi] ' + projects.length + '件のプロジェクトの健康状態が変わりました',
          body: '次のプロジェクトの健康状態が変わりました' + (note === 'に変化しました（自動判定）' ? '（自動判定）' : '') + '。\n\n' +
            projects.map(function (x) { return '・「' + x.name + '」: ' + (labelsJa[x.health] || x.health) }).join('\n') +
            '\n\nOhsumiのダッシュボードで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Health changed for ' + projects.length + ' projects',
          body: 'The health of the following projects has changed' + noteEn + '.\n\n' +
            projects.map(function (x) { return '- "' + x.name + '": ' + (labelsEn[x.health] || x.health) }).join('\n') +
            '\n\nCheck the Ohsumi dashboard for details.',
        },
      }
    }
    notifyAdmins_(templates)

    if (projects.length === 1) {
      notifyChat_('❤️‍🩹 「' + projects[0].name + '」の健康状態: ' + (labelsJa[projects[0].health] || projects[0].health))
    } else {
      var shown = projects.slice(0, PROJECT_HEALTH_CHAT_MAX_LINES)
      var lines = shown.map(function (x) { return '・「' + x.name + '」: ' + (labelsJa[x.health] || x.health) })
      if (projects.length > shown.length) lines.push('ほか ' + (projects.length - shown.length) + ' 件')
      notifyChat_('❤️‍🩹 ' + projects.length + '件のプロジェクトの健康状態が変わりました\n' + lines.join('\n'))
    }
  } catch (err) {
    console.error('notifyProjectHealthChangedBatchの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// Emails whoever is flagged notify_new_task=TRUE on Members, falling back
// to every 代表 if nobody opted in (a notification must always go out
// somewhere). Best-effort: a mail failure never fails task creation.
function notifyNewTasks_(tasks) {
  var titlesJa = tasks.map(function (t) {
    return '・' + t.title
  })
  var titlesEn = tasks.map(function (t) {
    return '- ' + t.title
  })
  notifyAdmins_({
    ja: {
      subject: '[Ohsumi] 新しいタスクが承認待ちです（' + tasks.length + '件）',
      body: '以下のタスクが登録され、承認待ちです。\n\n' +
        titlesJa.join('\n') +
        '\n\nOhsumiの管理画面 > 承認 から確認してください。',
    },
    en: {
      subject: '[Ohsumi] New tasks awaiting approval (' + tasks.length + ')',
      body: 'The following tasks were submitted and are awaiting approval.\n\n' +
        titlesEn.join('\n') +
        '\n\nCheck Ohsumi Admin > Approvals for details.',
    },
  }, null, { urgent: true })
}

// Emails the task's designated reviewer(s) (reviewer_ids/reviewer_id) when an
// assignee marks a task 確認待ち (their "I'm done, please confirm" signal).
// Falls back to reportsToEmails_(assigneeIds) when no reviewer is set, same as
// before this fix.
function notifyReview_(taskId) {
  try {
    // (スナップショットは書き込みの前の内容なので使わない。表に無ければシートを読む)
    var grid = _sheetGrids[SHEET_TASKS]
    var task = grid && grid.rowOf[String(taskId)] ? requestRow_(SHEET_TASKS, taskId) : findRow_(SHEET_TASKS, taskId)
    if (!task) return
    var reviewerIds = String(task.reviewer_ids || task.reviewer_id || '')
      .split(',')
      .map(function (s) { return s.trim() })
      .filter(Boolean)
    var preferredEmails
    if (reviewerIds.length > 0) {
      preferredEmails = memberEmailsByIds_(reviewerIds)
    } else {
      var assigneeIds = String(task.assignee_id || '')
        .split(',')
        .map(function (s) { return s.trim() })
        .filter(Boolean)
      preferredEmails = reportsToEmails_(assigneeIds)
    }
    notifyAdmins_(
      {
        ja: {
          subject: '[Ohsumi] タスクの確認をお願いします',
          body: '「' + task.title + '」が確認待ちになりました。\n\nOhsumiで確認し、問題なければ「完了」にしてください。',
        },
        en: {
          subject: '[Ohsumi] Task ready for your review',
          body: '"' + task.title + '" is now awaiting review.\n\nPlease check it in Ohsumi and mark it "Done" if everything looks good.',
        },
      },
      preferredEmails,
      { urgent: true },
    )
    notifyChat_('🔔 ' + chatTaskLabel_(task) + 'が確認待ちになりました。')
  } catch (err) {
    console.error('notifyReviewの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// 団体メール（Admin > Tagsで幹部/事業責任者が登録） — 個々のメンバーの
// notify_new_task設定に関わらず、常に全ての管理者向け通知(notifyAdmins_)の
// 宛先に含める共有の配信先アドレス。Settingsシートの org_notification_emails
// キーにカンマ区切りで保存される（公開情報のため機密扱いではない）。
function orgNotificationEmails_() {
  var raw = measureAction_('recipientsMs', function () { return settingValueFromSnapshot_('org_notification_emails') })
  if (!raw) return []
  return raw
    .split(',')
    .map(function (s) {
      return s.trim()
    })
    .filter(Boolean)
}

function uniqueEmails_(list) {
  var seen = {}
  var out = []
  list.forEach(function (email) {
    var key = email.toLowerCase()
    if (email && !seen[key]) {
      seen[key] = true
      out.push(email)
    }
  })
  return out
}

// Returns the notify frequency for a given member + kind.
// Falls back to 'immediate' for kinds not configured yet.
function getNotifyFrequency_(memberId, kind) {
  var row = measureAction_('recipientsMs', function () { return snapshotRowOrSheet_(SHEET_MEMBERS, memberId) })
  if (!row) return 'immediate'
  var raw = row.notify_settings
  if (!raw) return 'immediate'
  try {
    var settings = JSON.parse(raw)
    return settings[kind] || 'immediate'
  } catch (e) {
    return 'immediate'
  }
}

// Queues a notification for batch delivery. kind is one of:
// 'new_task' | 'review' | 'mention' | 'rejected' | 'deadline'
// templates: { ja: {subject, body}, en: {subject, body} } — 送信時に受信者の
// localeに応じて出し分ける(sendLocalizedEmail_/sendBatchNotifications参照)。
function queueNotification_(memberId, kind, templates) {
  var freq = getNotifyFrequency_(memberId, kind)
  if (freq === 'none') return
  // 急ぎでない種類と「1日ごと」の設定は、毎日のまとめに入れる(1人1日1通)
  if (!URGENT_NOTIFY_KINDS[kind] || freq === '1d') {
    deliverNotification_(memberEmailsByIds_([memberId]), templates, false)
    return
  }
  if (freq !== 'immediate' && !allowRequestNotification_('通知のキュー ' + kind)) return
  if (freq === 'immediate') {
    var emails = memberEmailsByIds_([memberId])
    if (emails.length > 0) {
      sendLocalizedEmail_(emails, templates)
    }
    return
  }
  var key = 'notif_queue_' + memberId
  var props = PropertiesService.getScriptProperties()
  var existing = props.getProperty(key)
  var queue = existing ? JSON.parse(existing) : []
  queue.push({ kind: kind, templates: templates, ts: new Date().toISOString() })
  props.setProperty(key, JSON.stringify(queue))
}

