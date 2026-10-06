// ---- コメントのメンション ----------------------------------------------------------
//
// updateComments で新しく足されたコメント(保存した後の内容)から、「@名前」で書かれたメンバーに通知する。
// 宛先と本文は GAS が決める(画面から宛先・本文は受け取らない)。
//   - 宛先: 本文の「@表示名」「@名前」に当たるメンバー(書いた本人・休止中の人を除く)。
//     幹部限定のタスクは、幹部限定のタスクを見られる役職の人だけ
//   - 本文: 保存したコメントの文(新しいコメントの投稿者は、validateCommentsUpdate_ が本人にそろえている)
//   - 1人1時間に RATE_LIMITS.mention.limit 人まで。超えたら通知しない(コメントは保存する)
var MENTION_NOTIFY_MAX_CHARS = 1000

// タスクに今あるコメントの ID(保存する前に読む。新しいコメントを見分けるため)
function taskCommentIds_(taskId) {
  var ids = {}
  var task = findRow_(SHEET_TASKS, taskId)
  var list = []
  try { list = JSON.parse((task && task.comments_json) || '[]') } catch (e) { list = [] }
  if (Array.isArray(list)) list.forEach(function (c) { if (c && c.id) ids[String(c.id)] = true })
  return ids
}

// タスクに今ある進捗の記録の ID
function taskProgressIds_(taskId) {
  var ids = {}
  var task = findRow_(SHEET_TASKS, taskId)
  var list = []
  try { list = JSON.parse((task && task.progress_history_json) || '[]') } catch (e) { list = [] }
  if (Array.isArray(list)) list.forEach(function (h) { if (h && h.id) ids[String(h.id)] = true })
  return ids
}

// 新しく足された項目(今ある ID に無いもの)の書いた人(byId)を、操作した本人にする
function stampNewEntries_(entries, idsBefore, actorId) {
  if (!Array.isArray(entries)) return
  entries.forEach(function (e) {
    if (e && e.id && !idsBefore[String(e.id)]) e.byId = String(actorId)
  })
}

// 本文の「@名前」に当たるメンバーの ID(画面の parseMentions と同じ決め方)
function mentionedMemberIds_(text, members) {
  var out = []
  members.forEach(function (m) {
    var names = [m.display_name, m.name].filter(function (n) { return !!n })
    if (names.some(function (n) { return text.indexOf('@' + n) >= 0 }) && out.indexOf(m.id) < 0) out.push(m.id)
  })
  return out
}

// スナップショットの Members(id・名前・役職・休止)
function snapshotMembers_() {
  var table = loadSnapshot_().data.Members
  if (!table || !table.headers) return []
  var h = table.headers
  return table.rows.map(function (r) {
    var o = {}
    h.forEach(function (k, i) { o[k] = r[i] })
    o.id = String(o.id)
    return o
  })
}

function notifyNewMentions_(taskId, commentIdsBefore, comments, actorId) {
  try {
    var fresh = (Array.isArray(comments) ? comments : []).filter(function (c) {
      return c && c.id && !commentIdsBefore[String(c.id)] && String(c.byId) === String(actorId) && c.text
    })
    if (fresh.length === 0) return
    var task = findRow_(SHEET_TASKS, taskId)
    if (!task) return
    var leadersOnly = normalizeCode_('visibility', task.visibility) === 'leaders'
    var roles = getRoles_()
    var members = snapshotMembers_().filter(function (m) {
      if (m.id === String(actorId) || isInactiveValue_(m.inactive)) return false
      return !leadersOnly || isTopRoleRef_(roles, m.role) || isAdminRoleRef_(roles, m.role)
    })
    fresh.forEach(function (c) {
      var text = String(c.text).slice(0, MENTION_NOTIFY_MAX_CHARS)
      var ids = mentionedMemberIds_(text, members)
      if (ids.length === 0) return
      if (!takeRateLimit_('mention', actorId, ids.length)) {
        _notifyLimited = true
        console.warn('メンションの通知の上限(1人1時間に' + rateLimitOf_('mention') + '人)を超えたため、通知しませんでした')
        return
      }
      var templates = {
        ja: {
          subject: '[Ohsumi] コメントでメンションされました',
          body: 'タスク「' + task.title + '」のコメントであなたがメンションされました。\n\n' + text + '\n\nOhsumiで確認してください。',
        },
        en: {
          subject: '[Ohsumi] You were mentioned in a comment',
          body: 'You were mentioned in a comment on task "' + task.title + '".\n\n' + text + '\n\nPlease check Ohsumi for details.',
        },
      }
      ids.forEach(function (mid) { queueNotification_(mid, 'mention', templates) })
    })
  } catch (err) {
    console.error('メンションの通知に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// ---- コメントへの返信 ----------------------------------------------------------------
//
// updateComments で新しく足されたコメントのうち、
//   ① 返信(replyToId のあるもの): 元のコメントを書いた人と、元のコメントでメンションされていた人に知らせる
//   ② 返信でないコメント: 操作した人をメンションしていたコメントの書き手に、「○○さんがコメントしました」と知らせる
//      (メンションの後、そのタスクに操作した人が書いた初めてのコメントの時だけ。返信を使わなかった返事を救う)
// 返信した本人・このコメントでメンションした人(メンションの通知が届く)・休止中の人・タスクを見られない人には送らない。
// メールは「メンション」と同じく急ぎ(種類 reply。頻度は本人の「メンション」の設定)
function notifyNewReplies_(taskId, commentIdsBefore, comments, actorId) {
  try {
    var list = (Array.isArray(comments) ? comments : []).filter(function (c) { return c && c.id })
    var fresh = list.filter(function (c) { return !commentIdsBefore[String(c.id)] && String(c.byId) === String(actorId) && c.text })
    if (fresh.length === 0) return
    var task = findRow_(SHEET_TASKS, taskId)
    if (!task) return
    var leadersOnly = normalizeCode_('visibility', task.visibility) === 'leaders'
    var roles = getRoles_()
    var members = snapshotMembers_().filter(function (m) {
      if (isInactiveValue_(m.inactive)) return false
      return !leadersOnly || isTopRoleRef_(roles, m.role) || isAdminRoleRef_(roles, m.role)
    })
    var memberIds = {}
    members.forEach(function (m) { memberIds[m.id] = true })
    var actor = members.filter(function (m) { return m.id === String(actorId) })[0] || findRow_(SHEET_MEMBERS, actorId) || {}
    var actorName = actor.display_name || actor.name || ''
    var byId = {}
    list.forEach(function (c) { byId[String(c.id)] = c })
    // 時刻の順(同じ時刻は並びの順)
    var ordered = list.map(function (c, i) { return { c: c, i: i } }).sort(function (a, b) {
      var x = String(a.c.at || ''), y = String(b.c.at || '')
      return x < y ? -1 : x > y ? 1 : a.i - b.i
    }).map(function (x) { return x.c })
    var recipients = {} // memberId -> 'reply' | 'follow'
    fresh.forEach(function (c) {
      var mentionedNow = mentionedMemberIds_(String(c.text).slice(0, MENTION_NOTIFY_MAX_CHARS), members)
      var add = function (mid, why) {
        mid = String(mid || '')
        if (!mid || mid === String(actorId) || !memberIds[mid] || mentionedNow.indexOf(mid) >= 0 || recipients[mid]) return
        recipients[mid] = why
      }
      var parent = c.replyToId ? byId[String(c.replyToId)] : null
      if (parent) {
        add(parent.byId, 'reply')
        mentionedMemberIds_(String(parent.text || '').slice(0, MENTION_NOTIFY_MAX_CHARS), members).forEach(function (mid) { add(mid, 'reply') })
        return
      }
      // 操作した人をメンションしていたコメント(このコメントより前)の書き手。その後に操作した人がまだ書いていなければ知らせる
      var idx = ordered.indexOf(c)
      ordered.slice(0, idx).forEach(function (m, k) {
        if (String(m.byId) === String(actorId)) return
        if (mentionedMemberIds_(String(m.text || '').slice(0, MENTION_NOTIFY_MAX_CHARS), members).indexOf(String(actorId)) < 0) return
        var answeredBefore = ordered.slice(k + 1, idx).some(function (x) { return String(x.byId) === String(actorId) })
        if (!answeredBefore) add(m.byId, 'follow')
      })
    })
    var ids = Object.keys(recipients)
    if (ids.length === 0) return
    if (!takeRateLimit_('mention', actorId, ids.length)) {
      _notifyLimited = true
      console.warn('返信の通知の上限(1人1時間に' + rateLimitOf_('mention') + '人)を超えたため、通知しませんでした')
      return
    }
    var text = String(fresh[fresh.length - 1].text).slice(0, MENTION_NOTIFY_MAX_CHARS)
    ids.forEach(function (mid) {
      var follow = recipients[mid] === 'follow'
      queueNotification_(mid, 'reply', {
        ja: {
          subject: follow ? '[Ohsumi] ' + actorName + 'さんがコメントしました' : '[Ohsumi] ' + actorName + 'さんが返信しました',
          body: follow
            ? 'タスク「' + task.title + '」に' + actorName + 'さんがコメントしました(あなたのメンションへの返事かもしれません)。\n\n' + text + '\n\nOhsumiで確認してください。'
            : 'タスク「' + task.title + '」のコメントに' + actorName + 'さんが返信しました。\n\n' + text + '\n\nOhsumiで確認してください。',
        },
        en: {
          subject: follow ? '[Ohsumi] ' + actorName + ' commented' : '[Ohsumi] ' + actorName + ' replied',
          body: follow
            ? actorName + ' commented on task "' + task.title + '" (this may be a reply to your mention).\n\n' + text + '\n\nPlease check Ohsumi for details.'
            : actorName + ' replied to a comment on task "' + task.title + '".\n\n' + text + '\n\nPlease check Ohsumi for details.',
        },
      })
    })
  } catch (err) {
    console.error('返信の通知に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// 研修の記録(メンバーの training_history_json)から、ID の記録を探す
function trainingRecordOf_(memberId, trainingId) {
  var member = findRow_(SHEET_MEMBERS, memberId)
  if (!member || !trainingId) return null
  var list = []
  try { list = JSON.parse(member.training_history_json || '[]') } catch (e) { list = [] }
  if (!Array.isArray(list)) return null
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === String(trainingId)) return { member: member, record: list[i] }
  }
  return null
}

// 研修の申請を、報告先(無ければ代表)に知らせる。研修の名前は保存した記録から読み、申請中(pending)の時だけ送る。
// 送ったら true
function notifyTrainingRequest_(memberId, trainingId, actorId) {
  try {
    var found = trainingRecordOf_(memberId, trainingId)
    if (!found || found.record.status !== 'pending') return false
    if (!takeRateLimit_('resultNotify', actorId, 1)) { _notifyLimited = true; return false }
    var name = found.member.display_name || found.member.name || '不明'
    var trainingName = String(found.record.name || '')
    notifyAdmins_(
      {
        ja: {
          subject: '[Ohsumi] 研修申請の承認をお願いします',
          body: name + 'さんから研修「' + trainingName + '」の申請がありました。\n\nOhsumiの人材育成タブから承認/却下してください。',
        },
        en: {
          subject: '[Ohsumi] Training request awaiting approval',
          body: name + ' has requested training "' + trainingName + '".\n\nPlease approve or reject it from the Ohsumi Training tab.',
        },
      },
      reportsToEmails_([memberId]),
      { urgent: true },
    )
    notifyChat_('📚 ' + name + 'さんから研修の申請がありました。Ohsumiで確認してください。')
    return true
  } catch (err) {
    console.error('notifyTrainingRequestの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
    return false
  }
}

// タスクの却下(承認しない)。タスクを消し、シートのタスクの作成者に、シートのタスクの名前で知らせる。
// 宛先・タスクの名前は GAS が決める。理由だけは承認する人が書いたもの(NOTIFY_QUOTED_FIELDS)
var REJECT_REASON_MAX_CHARS = 500
// 通知の本文に、画面から受け取った文をそのまま入れる操作と、その項目(ほかの操作は、保存したデータだけで本文を作る。
// lib/ohsumi/gas-notify-guard.test.ts で確かめる)
var NOTIFY_QUOTED_FIELDS = {
  rejectTask: ['reason'],  // 却下の理由(代表・管理者が書く。500字まで。宛先はシートのタスクの作成者)
}

function rejectTask_(taskId, reason) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('タスクが見つかりません。')
  var creatorId = String(task.creator_id || '')
  var title = String(task.title || '')
  var result = removeTask_(taskId)
  var why = String(reason || '').slice(0, REJECT_REASON_MAX_CHARS)
  try {
    var emails = creatorId ? memberEmailsByIds_([creatorId]) : []
    if (emails.length > 0) {
      deliverNotification_(emails, {
        ja: {
          subject: '[Ohsumi] タスクが承認されませんでした',
          body: '登録した「' + title + '」は承認されませんでした。\n\n' + (why ? '理由: ' + why + '\n\n' : '') + 'Ohsumiで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Your task was not approved',
          body: 'The task "' + title + '" you submitted was not approved.\n\n' + (why ? 'Reason: ' + why + '\n\n' : '') + 'Please check Ohsumi for details.',
        },
      })
    }
  } catch (err) {
    console.error('タスクの却下の通知に失敗しました: ' + maskEmailsIn_(String(err)))
  }
  return result
}

// 研修の申請の結果を、申請した本人に知らせる。結果(承認・却下)と名前は保存した記録から読む。送ったら true
function notifyTrainingDecision_(memberId, trainingId, actorId) {
  try {
    var found = trainingRecordOf_(memberId, trainingId)
    if (!found || (found.record.status !== 'approved' && found.record.status !== 'rejected')) return false
    var emails = memberEmailsByIds_([memberId])
    if (emails.length === 0) return false
    if (!takeRateLimit_('resultNotify', actorId, 1)) { _notifyLimited = true; return false }
    var approved = found.record.status === 'approved'
    var trainingName = String(found.record.name || '')
    deliverNotification_(emails, {
      ja: {
        subject: '[Ohsumi] 研修申請が' + (approved ? '承認' : '却下') + 'されました',
        body: '研修「' + trainingName + '」の申請が' + (approved ? '承認' : '却下') + 'されました。\n\nOhsumiで確認してください。',
      },
      en: {
        subject: '[Ohsumi] Your training request was ' + (approved ? 'approved' : 'rejected'),
        body: 'Your request for training "' + trainingName + '" was ' + (approved ? 'approved' : 'rejected') + '.\n\nPlease check Ohsumi for details.',
      },
    })
    return true
  } catch (err) {
    console.error('notifyTrainingDecisionの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
    return false
  }
}

// 日程調整ツール — 招待された全員が全候補への回答を終えたタイミングで
// store.tsx から呼ばれ、作成者へ集計結果をメールする。
// 結果の通知は、保存した回答が揃った時に1回だけ送る(同じ回答で2回目は送らない。6時間覚える)
var RESULT_NOTIFIED_TTL_SEC = 6 * 3600

function resultNotifiedKey_(kind, taskId, responses) {
  return 'resultNotified:' + kind + ':' + sha256Base64Url_(String(taskId) + '|' + JSON.stringify(responses || {}))
}

// 送ってよければ true(回答が揃っていて、まだ送っていなくて、回数の上限の中)。送る時の記録もする
function claimResultNotification_(kind, taskId, responses, actorId) {
  var cache = CacheService.getScriptCache()
  var key = resultNotifiedKey_(kind, taskId, responses)
  if (cache.get(key)) return false
  if (actorId && !takeRateLimit_('resultNotify', actorId, 1)) { _notifyLimited = true; return false }
  cache.put(key, '1', RESULT_NOTIFIED_TTL_SEC)
  return true
}

function scheduleComplete_(schedule) {
  if (!schedule || !Array.isArray(schedule.invitedIds) || schedule.invitedIds.length === 0 || !Array.isArray(schedule.candidates)) return false
  return schedule.invitedIds.every(function (mid) {
    var r = schedule.responses && schedule.responses[mid]
    return !!r && schedule.candidates.every(function (c) { return !!r[c.id] })
  })
}

function formComplete_(form) {
  if (!form || !Array.isArray(form.invitedIds) || form.invitedIds.length === 0) return false
  return form.invitedIds.every(function (mid) { return !!(form.responses && form.responses[mid]) })
}

// 日程調整の回答が揃ったら、作成者に知らせる。宛先・本文はシートのタスクから決め、揃っていなければ送らない。送ったら true
function notifyScheduleResult_(taskId, actorId) {
  try {
    // (スナップショットは書き込みの前の内容なので使わない。表に無ければシートを読む)
    var grid = _sheetGrids[SHEET_TASKS]
    var task = grid && grid.rowOf[String(taskId)] ? requestRow_(SHEET_TASKS, taskId) : findRow_(SHEET_TASKS, taskId)
    if (!task || !task.creator_id) return false
    var schedule = null
    try {
      schedule = task.schedule_json ? JSON.parse(task.schedule_json) : null
    } catch (e) {
      schedule = null
    }
    if (!scheduleComplete_(schedule)) return false
    var emails = memberEmailsByIds_([task.creator_id])
    if (emails.length === 0) {
      console.warn('notifyScheduleResult: creator_id ' + task.creator_id + ' のメール登録がないため送信しませんでした')
      return false
    }
    if (!claimResultNotification_('schedule', taskId, schedule.responses, actorId)) return false

    var bodyJa = 'タスク「' + task.title + '」の日程調整で全員の回答が揃いました。\n\n'
    var bodyEn = 'All responses are in for the schedule coordination on task "' + task.title + '".\n\n'
    if (schedule && schedule.candidates) {
      var sheet = getSheet_(SHEET_MEMBERS)
      var headers = headerRow_(sheet)
      var idCol = headers.indexOf('id')
      var nameCol = headers.indexOf('display_name')
      var altNameCol = headers.indexOf('name')
      var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
      var nameById = {}
      rows.forEach(function (r) {
        var id = String(r[idCol])
        nameById[id] = (nameCol !== -1 && r[nameCol]) || (altNameCol !== -1 && r[altNameCol]) || id
      })
      schedule.candidates.forEach(function (c) {
        bodyJa += '【' + c.label + '】\n'
        bodyEn += '[' + c.label + ']\n'
        ;(schedule.invitedIds || []).forEach(function (mid) {
          var resp = schedule.responses && schedule.responses[mid] && schedule.responses[mid][c.id]
          // 回答は移行前の記号(○△×)・コードのどちらでもよい。表示名は NOTIFY_LABELS
          bodyJa += '  ' + (nameById[mid] || mid) + ': ' + (resp ? notifyLabel_('scheduleAnswer', 'ja', resp) : '未回答') + '\n'
          bodyEn += '  ' + (nameById[mid] || mid) + ': ' + (resp ? notifyLabel_('scheduleAnswer', 'en', resp) : 'No response') + '\n'
        })
      })
    }
    bodyJa += '\nOhsumiで確認してください。'
    bodyEn += '\nPlease check Ohsumi for details.'

    deliverNotification_(emails, {
      ja: { subject: '[Ohsumi] 日程調整の回答が揃いました', body: bodyJa },
      en: { subject: '[Ohsumi] Schedule coordination responses are complete', body: bodyEn },
    })
    console.log('notifyScheduleResult: 送信先 ' + maskEmailsIn_(emails.join(',')))
    notifyChat_('🗓️ ' + chatTaskLabel_(task) + 'の日程調整で全員の回答が揃いました。')
    return true
  } catch (err) {
    console.error('notifyScheduleResultの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
    return false
  }
}

// 汎用フォームツール — 招待された全員が回答を終えたタイミングでstore.tsxから
// 呼ばれ、作成者へ回答結果をメールする。
function notifyFormResult_(taskId, actorId) {
  try {
    // (スナップショットは書き込みの前の内容なので使わない。表に無ければシートを読む)
    var grid = _sheetGrids[SHEET_TASKS]
    var task = grid && grid.rowOf[String(taskId)] ? requestRow_(SHEET_TASKS, taskId) : findRow_(SHEET_TASKS, taskId)
    if (!task || !task.creator_id) return false
    var form = null
    try {
      form = task.form_json ? JSON.parse(task.form_json) : null
    } catch (e) {
      form = null
    }
    if (!formComplete_(form)) return false
    var emails = memberEmailsByIds_([task.creator_id])
    if (emails.length === 0) {
      console.warn('notifyFormResult: creator_id ' + task.creator_id + ' のメール登録がないため送信しませんでした')
      return false
    }
    if (!claimResultNotification_('form', taskId, form.responses, actorId)) return false

    var bodyJa = 'タスク「' + task.title + '」のフォームで全員の回答が揃いました。\n\n'
    var bodyEn = 'All responses are in for the form on task "' + task.title + '".\n\n'
    if (form && form.fields) {
      var sheet = getSheet_(SHEET_MEMBERS)
      var headers = headerRow_(sheet)
      var idCol = headers.indexOf('id')
      var nameCol = headers.indexOf('display_name')
      var altNameCol = headers.indexOf('name')
      var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
      var nameById = {}
      rows.forEach(function (r) {
        var id = String(r[idCol])
        nameById[id] = (nameCol !== -1 && r[nameCol]) || (altNameCol !== -1 && r[altNameCol]) || id
      })
      ;(form.invitedIds || []).forEach(function (mid) {
        bodyJa += '【' + (nameById[mid] || mid) + '】\n'
        bodyEn += '[' + (nameById[mid] || mid) + ']\n'
        var resp = (form.responses && form.responses[mid]) || {}
        form.fields.forEach(function (f) {
          var v = resp[f.id]
          var textJa = Array.isArray(v) ? v.join('、') : v || '（未回答）'
          var textEn = Array.isArray(v) ? v.join(', ') : v || '(No response)'
          bodyJa += '  ' + f.label + ': ' + textJa + '\n'
          bodyEn += '  ' + f.label + ': ' + textEn + '\n'
        })
        bodyJa += '\n'
        bodyEn += '\n'
      })
    }
    bodyJa += '\nOhsumiで確認してください。'
    bodyEn += '\nPlease check Ohsumi for details.'

    deliverNotification_(emails, {
      ja: { subject: '[Ohsumi] フォームの回答が揃いました', body: bodyJa },
      en: { subject: '[Ohsumi] Form responses are complete', body: bodyEn },
    })
    console.log('notifyFormResult: 送信先 ' + maskEmailsIn_(emails.join(',')))
    notifyChat_('📝 ' + chatTaskLabel_(task) + 'のフォームで全員の回答が揃いました。')
    return true
  } catch (err) {
    console.error('notifyFormResultの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
    return false
  }
}

// Emails admins (routed via reportsToEmails_ when the task's assignees have
// a designated 報告先) when a task's start date / deadline changes from
// the detail drawer.
function notifyScheduleChange_(taskId) {
  try {
    // (スナップショットは書き込みの前の内容なので使わない。表に無ければシートを読む)
    var grid = _sheetGrids[SHEET_TASKS]
    var task = grid && grid.rowOf[String(taskId)] ? requestRow_(SHEET_TASKS, taskId) : findRow_(SHEET_TASKS, taskId)
    if (!task) return
    var assigneeIds = String(task.assignee_id || '')
      .split(',')
      .map(function (s) {
        return s.trim()
      })
      .filter(Boolean)
    notifyAdmins_(
      {
        ja: {
          subject: '[Ohsumi] タスクの日程が変更されました',
          body: '「' + task.title + '」の日程が変更されました。\n開始日: ' +
            (task.start_date || '未設定') +
            '\n期限: ' +
            (task.due_date || '未設定') +
            '\n\nOhsumiで確認してください。',
        },
        en: {
          subject: '[Ohsumi] Task schedule changed',
          body: 'The schedule for "' + task.title + '" has changed.\nStart date: ' +
            (task.start_date || 'Not set') +
            '\nDue date: ' +
            (task.due_date || 'Not set') +
            '\n\nPlease check Ohsumi for details.',
        },
      },
      reportsToEmails_(assigneeIds),
    )
  } catch (err) {
    console.error('notifyScheduleChangeの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// タスクの予定(この GAS を実行するアカウントの既定のカレンダー)。担当者をゲストにする。
// 予定にはタスクの ID を記録し(タグ ohsumiTaskId と、タスクの calendar_event_id の列)、そのタスクの予定だけを扱う。
//   - 予定があれば作り直さずに書き換える(日時・名前・ゲスト)。招待のメールは、予定を作った時の1回だけ送る
//     (あとから足した担当者には、カレンダーに予定が入るだけで、メールは届かない)
//   - 期限を変えた時は同じ予定を動かすので、前の日の予定は残らない
//   - 同じ名前の別のタスクの予定は消さない(ID で探す。ID の無い以前の予定は、同じ日・同じ名前で ID の無いものが
//     1つだけの時に限り、そのタスクの予定として引き継ぐ)
//   - 完了・削除(ゴミ箱を含む)・担当者や期限が無くなった時は、予定を消す
//   - ゲストどうしは、互いのメールアドレスを見られない(setGuestsCanSeeGuests(false))
// 失敗しても呼び出し元には投げない(カレンダーの上限・権限で、タスクの保存を止めない)
var CALENDAR_TASK_TAG = 'ohsumiTaskId'
// 予定に関わる列。これらを書き換えた時に予定を合わせる(updateRowFields_)
var CALENDAR_TASK_FIELDS = ['title', 'due_date', 'due_time', 'assignee_id', 'deleted_at']

function syncCalendarForTask_(taskId, hints) {
  return measureAction_('calendarMs', function () { return syncCalendarForTaskUnmeasured_(taskId, hints || {}) })
}

// タスクの行を書き換える時、予定を合わせる必要があるか(書き換える前の行 before と比べる)。合わせるなら、前の期限・名前を返す
function calendarSyncHints_(fields, before) {
  var keys = Object.keys(fields || {})
  var touches = keys.some(function (k) { return CALENDAR_TASK_FIELDS.indexOf(k) >= 0 })
  if (!touches && keys.indexOf('status') >= 0) {
    // 状態は、完了にした時・完了から戻した時だけ(ほかの状態の変化では予定は変わらない)
    touches = normalizeCode_('status', fields.status) === 'done' || normalizeCode_('status', before && before.status) === 'done'
  }
  if (!touches) return null
  return { oldDueDate: before ? calendarDateStr_(before.due_date) : '', oldTitle: before ? String(before.title || '') : '' }
}

function calendarDateStr_(v) {
  if (!v) return ''
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  return String(v).slice(0, 10)
}

function syncCalendarForTaskUnmeasured_(taskId, hints) {
  try {
    if (featureDisabled_('calendarSync')) return
    // 書き込みの後なら、このリクエストで覚えている表から読む(シートを読み直さない)
    // (スナップショットは書き込みの前の内容なので使わない。表に無ければシートを読む)
    var grid = _sheetGrids[SHEET_TASKS]
    var task = grid && grid.rowOf[String(taskId)] ? requestRow_(SHEET_TASKS, taskId) : findRow_(SHEET_TASKS, taskId)
    if (!task) return
    var dueDate = calendarDateStr_(task.due_date)
    var assigneeIds = String(task.assignee_id || '')
      .split(',')
      .map(function (s) {
        return s.trim()
      })
      .filter(Boolean)
    var emailMap = assigneeIds.length ? getAllMemberEmails_() : {}
    var guests = assigneeIds.map(function (aid) { return emailMap[String(aid)] }).filter(Boolean)
    var wanted = !hints.remove && !!dueDate && guests.length > 0 && !task.deleted_at &&
      normalizeCode_('status', task.status) !== 'done'

    var cal = CalendarApp.getDefaultCalendar()
    var title = CALENDAR_PREFIX_OHSUMI + task.title
    var ev = findTaskCalendarEvent_(cal, taskId, task, [dueDate, hints.oldDueDate], [title, hints.oldTitle ? CALENDAR_PREFIX_OHSUMI + hints.oldTitle : ''])
    var hasColumn = Object.prototype.hasOwnProperty.call(task, 'calendar_event_id')

    if (!wanted) {
      if (ev) ev.deleteEvent()
      if (hasColumn && task.calendar_event_id && !hints.remove) updateRowFields_(SHEET_TASKS, taskId, { calendar_event_id: '' })
      return
    }

    var testEnv = isTestEnvironment_()
    // 予定からサイトを開けるようにする(レジストリに確かめていない団体では付けない)
    var eventLink = ''
    try { eventLink = canonicalInviteLink_() } catch (linkErr) { eventLink = '' }
    var description = eventLink ? 'Ohsumi を開く / Open Ohsumi: ' + eventLink : ''
    if (testEnv) {
      console.log('[テスト環境] カレンダーの招待を送りませんでした。予定: ' + task.title + ' / 本来のゲスト: ' + maskEmailsIn_(guests.join(',')))
    }
    var day = new Date(dueDate + 'T00:00:00')
    var start = task.due_time ? new Date(dueDate + 'T' + String(task.due_time).slice(0, 5) + ':00') : null
    var end = start ? new Date(start.getTime() + 60 * 60 * 1000) : null

    if (ev) {
      if (ev.getTitle() !== title) ev.setTitle(title)
      if (start) {
        if (ev.isAllDayEvent() || ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime()) ev.setTime(start, end)
      } else if (!ev.isAllDayEvent() || ev.getAllDayStartDate().getTime() !== day.getTime()) {
        ev.setAllDayDate(day)
      }
      if (description && ev.getDescription() !== description) ev.setDescription(description)
      // テスト環境ではゲストを付けない(本来の宛先に予定を入れない)
      if (!testEnv) {
        var want = guests.map(function (g) { return String(g).toLowerCase() })
        var have = (ev.getGuestList() || []).map(function (g) { return String(g.getEmail()).toLowerCase() })
        want.forEach(function (g) { if (have.indexOf(g) < 0) ev.addGuest(g) })
        have.forEach(function (g) { if (want.indexOf(g) < 0) ev.removeGuest(g) })
      }
      if (ev.guestsCanSeeGuests()) ev.setGuestsCanSeeGuests(false)
      if (ev.getTag(CALENDAR_TASK_TAG) !== String(taskId)) ev.setTag(CALENDAR_TASK_TAG, String(taskId))
    } else {
      // テスト環境では招待(メール)を本来の宛先に送らない。予定は作るが、ゲストは付けない
      var eventOptions = testEnv ? {} : { guests: guests.join(','), sendInvites: true }
      if (description) eventOptions.description = description
      ev = start ? cal.createEvent(title, start, end, eventOptions) : cal.createAllDayEvent(title, day, eventOptions)
      if (!ev || typeof ev.setTag !== 'function') return
      ev.setTag(CALENDAR_TASK_TAG, String(taskId))
      ev.setGuestsCanSeeGuests(false)
    }
    var eventId = String(ev.getId())
    if (hasColumn && String(task.calendar_event_id || '') !== eventId) updateRowFields_(SHEET_TASKS, taskId, { calendar_event_id: eventId })
  } catch (err) {
    // best-effort — Calendar quota/permissions issues shouldn't break assignment
    console.warn('カレンダーの予定を合わせられませんでした: ' + maskEmailsIn_(String(err)))
  }
}

// そのタスクの予定を探す。記録した予定の ID → 期限の日(今と前)の予定のうちタグが同じもの →
// ID の無い以前の予定(同じ日・同じ名前で ID の無いものが1つだけの時)。同じタスクの予定が2つ以上あれば、1つを残して消す
function findTaskCalendarEvent_(cal, taskId, task, dates, titles) {
  var id = String(taskId)
  var recorded = String(task.calendar_event_id || '')
  if (recorded) {
    var byId = null
    try { byId = cal.getEventById(recorded) } catch (e) { byId = null }
    if (byId) {
      var tag = byId.getTag(CALENDAR_TASK_TAG)
      if (!tag || tag === id) return byId
    }
  }
  var found = null
  var seen = {}
  dates.forEach(function (d) {
    if (!d || seen[d]) return
    seen[d] = true
    var events = cal.getEvents(new Date(d + 'T00:00:00'), new Date(d + 'T23:59:59'), { search: CALENDAR_PREFIX_OHSUMI.trim() }) || []
    var legacy = []
    events.forEach(function (ev) {
      var tag = ev.getTag(CALENDAR_TASK_TAG)
      if (tag === id) {
        if (found) ev.deleteEvent()
        else found = ev
      } else if (!tag && titles.indexOf(String(ev.getTitle())) >= 0) {
        legacy.push(ev)
      }
    })
    if (!found && legacy.length === 1) found = legacy[0]
  })
  return found
}

