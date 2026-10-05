// ---- タスクを書き換える操作の決まり ---------------------------------------------
// タスクを書き換える操作は、次のどれかでなければならない(lib/ohsumi/gas-notify-guard.test.ts で、全部の操作を
// 一般のメンバーとして実際に送って確かめる。新しく足した操作も自動で確かめる):
//   1. TASK_OWNER_SCOPED_ACTIONS: そのタスクの担当者・確認者・作成者・全権管理者だけ
//   2. TASK_ANY_MEMBER_ACTIONS: ログインしていれば誰でもよい理由がある(理由を書く)
//   3. 役職で限る操作(代表・管理者だけ。authorizeAction_ の一覧): 一般のメンバーは断られる
// F1/F10: 以前は anyLoggedIn 扱いで、無関係な第三者が他人のタスクの履歴・成果物・工数・振り返り・
// 日程調整・フォーム・進捗・保留理由を書き換えられてしまっていた
var TASK_OWNER_SCOPED_ACTIONS = [
  'updateDeliverables', 'updateHistory',
  'updateEstimatedHours', 'updateActualHours', 'updateRetrospective',
  'updateProgress',   // 進捗のメモ・進捗率・進捗の記録(他人の記録は変えられない: validateProgressHistoryUpdate_)
  'setHoldReason',    // 保留の理由
]
var TASK_ANY_MEMBER_ACTIONS = {
  createTasks: '新しいタスクの登録。一般のメンバーが作るタスクは承認待ち(確認タスク・日程調整/フォームのクイック追加は除く。prepareCreateTasks_)。既存のタスクは書き換えない',
  updateTaskStatus: '担当者だけが状態を変えられ、完了にできるのは確認者だけ(authorizeAction_ で確かめる)。担当者の決まっていないタスクは、誰でも着手できる',
  approveTaskReview: '確認者だけが承認できる(authorizeAction_ で確かめる)',
  updateComments: 'タスクを見られる人は誰でもコメントできる。他人のコメントは変え・消せない(validateCommentsUpdate_)',
  applyToOpenBid: '公募への応募・取り下げ。自分の分しか変えられない(authorizeAction_ で確かめる)',
  checkAndGenerateRecurringTasks: '定期タスクを、保存した規則どおりに作るだけ(内容は画面から受け取らない)',
  updateTaskSchedule: '日程調整に招待された人は、自分の回答だけを変えられる。候補・招待を変えられるのは担当者・確認者・作成者・全権管理者だけ(authorizeAction_・mergeAnswers_)',
  updateTaskForm: 'フォームに招待された人は、自分の回答だけを変えられる。項目・招待を変えられるのは担当者・確認者・作成者・全権管理者だけ(authorizeAction_・mergeAnswers_)',
}

// updateProgress の進捗の記録(progressHistory)。コメントと同じく、新しい記録の書いた人は本人にそろえ、
// 他人の記録は変え・消せない(全権管理者は制限なし)
function validateProgressHistoryUpdate_(task, entries, acting) {
  if (!Array.isArray(entries)) throw userError_('進捗の記録の形式が不正です。')
  var old = []
  try { old = JSON.parse(task.progress_history_json || '[]') } catch (e) { old = [] }
  if (!Array.isArray(old)) old = []
  var oldById = {}
  old.forEach(function (h) { if (h && h.id) oldById[h.id] = h })
  var newIds = {}
  var isAdmin = isActingFullAdmin_(acting)
  entries.forEach(function (h) {
    if (!h || !h.id) throw userError_('進捗の記録の形式が不正です。')
    newIds[h.id] = true
    var before = oldById[h.id]
    if (before) {
      if (!isAdmin && before.byId !== acting.id && JSON.stringify(before) !== JSON.stringify(h)) {
        throw userError_('他のメンバーが書いた進捗の記録は変更できません。')
      }
    } else {
      h.byId = acting.id
    }
  })
  if (!isAdmin) {
    old.forEach(function (h) {
      if (h && h.id && !newIds[h.id] && h.byId !== acting.id) throw userError_('他のメンバーが書いた進捗の記録は削除できません。')
    })
  }
}

// タスクの担当者・確認者・作成者・全権管理者か
function isTaskOwner_(task, acting) {
  if (isActingFullAdmin_(acting)) return true
  var id = String(acting.id)
  return splitCsvList_(task.assignee_id).indexOf(id) >= 0 ||
    splitCsvList_(task.reviewer_ids || task.reviewer_id).indexOf(id) >= 0 ||
    String(task.creator_id || '').trim() === id
}

function parseAnswerCell_(task, kind) {
  var raw = String(task[kind === 'schedule' ? 'schedule_json' : 'form_json'] || '')
  var obj = null
  try { obj = raw ? JSON.parse(raw) : null } catch (e) { obj = null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  return kind === 'schedule' ? mapScheduleCodes_(obj, normalizeCode_) : obj
}

function answerInvitedIds_(task, kind) {
  var obj = parseAnswerCell_(task, kind)
  return obj && Array.isArray(obj.invitedIds) ? obj.invitedIds.map(String) : []
}

// 日程調整・フォームの書き込みを、今の保存に当てる。回答は本人の分だけ変え、ほかの人の回答は今の保存のまま。
// 候補・項目・招待(回答以外)は、担当者・確認者・作成者・全権管理者だけが変えられる(ほかの人の分は今の保存のまま)。
// 消す(null)のも同じ人たちだけ
function mergeAnswers_(taskId, kind, next, acting) {
  var task = lockedRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('対象のタスクが見つかりません。')
  var owner = isTaskOwner_(task, acting)
  var prev = parseAnswerCell_(task, kind)
  if (!next) {
    if (!owner) throw userError_('日程調整・フォームを消せるのは、担当者・確認者・作成者・管理者だけです。')
    return null
  }
  if (typeof next !== 'object' || Array.isArray(next)) throw userError_('日程調整・フォームの形式が不正です。')
  var base = owner ? next : (prev || {})
  var out = {}
  Object.keys(base).forEach(function (k) { if (k !== 'responses') out[k] = base[k] })
  var responses = {}
  var prevResponses = (prev && prev.responses && typeof prev.responses === 'object') ? prev.responses : {}
  Object.keys(prevResponses).forEach(function (m) { responses[m] = prevResponses[m] })
  var me = String(acting.id)
  var mine = next.responses && typeof next.responses === 'object' ? next.responses[me] : undefined
  if (mine === undefined || mine === null) delete responses[me]
  else responses[me] = mine
  out.responses = responses
  return out
}

// 新しい変更の記録の、記録した人・日時を GAS が決める(画面から届いた値は使わない)
function stampNewHistoryEntries_(taskId, entries, actorId) {
  if (!Array.isArray(entries)) return
  var task = lockedRow_(SHEET_TASKS, String(taskId || ''))
  var old = []
  try { old = JSON.parse((task && task.history_json) || '[]') } catch (e) { old = [] }
  var oldIds = {}
  ;(Array.isArray(old) ? old : []).forEach(function (h) { if (h && h.id) oldIds[h.id] = true })
  var now = new Date().toISOString()
  entries.forEach(function (h) {
    if (h && h.id && !oldIds[h.id]) {
      h.byId = String(actorId)
      h.at = now
    }
  })
}

// 本人が自分の実績を変える時の制限(代表は除く。代表の上には確認する人がいないため)
function selfRestricted_(acting, memberId) {
  return String(acting.id) === String(memberId) && !isTopRoleRef_(getRoles_(), acting.role)
}

function memberJsonList_(memberId, column) {
  var row = lockedRow_(SHEET_MEMBERS, memberId)
  if (!row) throw userError_('メンバーが見つかりません。')
  var list = []
  try { list = JSON.parse(row[column] || '[]') } catch (e) { list = [] }
  return Array.isArray(list) ? list : []
}

// スキルのレベル: 1〜5 の整数。本人は、保存したレベルを上げられない(新しいスキルは Lv.1 だけ。下げる・消すのはよい)
function checkSkillLevels_(memberId, levels, acting) {
  if (!Array.isArray(levels)) throw userError_('スキルのレベルの形式が不正です。')
  levels.forEach(function (l) {
    if (!l || typeof l.skill !== 'string' || !l.skill.trim()) throw userError_('スキルのレベルの形式が不正です。')
    if ([1, 2, 3, 4, 5].indexOf(l.level) < 0) throw userError_('スキルのレベルは1〜5で入れてください。')
  })
  if (!selfRestricted_(acting, memberId)) return levels
  var stored = {}
  memberJsonList_(memberId, 'skill_levels_json').forEach(function (l) { if (l && l.skill) stored[l.skill] = Number(l.level) || 0 })
  levels.forEach(function (l) {
    var max = Object.prototype.hasOwnProperty.call(stored, l.skill) ? stored[l.skill] : 1
    if (l.level > max) throw userError_('自分のスキルのレベルは上げられません(新しいスキルは Lv.1 で登録されます)。管理者に依頼してください。')
  })
  return levels
}

// 資格: 取った日の形。本人は「外部」の印を変えられない(新しい資格は印なし)
function checkQualifications_(memberId, entries, acting) {
  if (!Array.isArray(entries)) throw userError_('資格の形式が不正です。')
  entries.forEach(function (q) {
    if (!q || typeof q !== 'object') throw userError_('資格の形式が不正です。')
    checkDate_(q.acquiredDate, '資格を取った日')
  })
  if (!selfRestricted_(acting, memberId)) return entries
  var stored = {}
  memberJsonList_(memberId, 'qualifications_json').forEach(function (q) { if (q && q.id) stored[q.id] = !!q.external })
  entries.forEach(function (q) {
    var before = q.id && Object.prototype.hasOwnProperty.call(stored, q.id) ? stored[q.id] : false
    if (!!q.external !== before) throw userError_('資格の「外部」の印は、本人は変えられません。管理者に確認を依頼してください。')
  })
  return entries
}

// 研修: 日付の形。本人は承認の状態を変えられない(新しい研修は「申請中」だけ。状態の無い以前の記録は承認済み扱い)
function checkTrainingHistory_(memberId, entries, acting) {
  if (!Array.isArray(entries)) throw userError_('研修の記録の形式が不正です。')
  entries.forEach(function (t) {
    if (!t || typeof t !== 'object') throw userError_('研修の記録の形式が不正です。')
    checkDate_(t.date, '研修の日')
  })
  if (!selfRestricted_(acting, memberId)) return entries
  var statusOf = function (t) { return t.status || 'approved' }
  var stored = {}
  memberJsonList_(memberId, 'training_history_json').forEach(function (t) { if (t && t.id) stored[t.id] = statusOf(t) })
  entries.forEach(function (t) {
    var known = t.id && Object.prototype.hasOwnProperty.call(stored, t.id)
    if (known ? statusOf(t) !== stored[t.id] : t.status !== 'pending') {
      throw userError_('研修の承認の状態は、本人は変えられません(新しい研修は申請中で登録し、管理者の承認を待ってください)。')
    }
  })
  return entries
}

// 評価: 評価した人は操作した本人(既存の記録の評価した人は変えさせない)。日付の形
function stampEvaluators_(memberId, entries, acting) {
  if (!Array.isArray(entries)) throw userError_('評価の記録の形式が不正です。')
  var stored = {}
  memberJsonList_(memberId, 'evaluation_history_json').forEach(function (e) { if (e && e.id) stored[e.id] = e })
  entries.forEach(function (e) {
    if (!e || typeof e !== 'object') throw userError_('評価の記録の形式が不正です。')
    checkDate_(e.date, '評価の日')
    e.evaluatorId = stored[e.id] ? String(stored[e.id].evaluatorId || '') : String(acting.id)
  })
  return entries
}

// 1on1: 相手(行った人)は操作した本人(本人が自分の記録に書く時は、在籍しているほかのメンバー)。既存の記録の相手は変えさせない。日付の形
function stampOneOnOnes_(memberId, entries, acting) {
  if (!Array.isArray(entries)) throw userError_('1on1 の記録の形式が不正です。')
  var stored = {}
  memberJsonList_(memberId, 'one_on_ones_json').forEach(function (e) { if (e && e.id) stored[e.id] = e })
  entries.forEach(function (e) {
    if (!e || typeof e !== 'object') throw userError_('1on1 の記録の形式が不正です。')
    checkDate_(e.date, '1on1 の日')
    if (stored[e.id]) {
      e.withId = String(stored[e.id].withId || '')
    } else if (String(acting.id) !== String(memberId)) {
      e.withId = String(acting.id)
    } else {
      e.withId = checkActiveMember_(e.withId, '1on1 の相手')
      if (!e.withId || e.withId === String(memberId)) throw userError_('1on1 の相手を選んでください。')
    }
  })
  return entries
}

// lib/ohsumi/store.tsx の appendHistory と同じ値。history_json は
// [新しい変更, ...既存].slice(0, HISTORY_CAP) という形で常に先頭に追記される
// ため、この値がずれるとキャップ落ちの正当な範囲が誤判定される。
var HISTORY_CAP = 50

// F1/F10: updateComments はコメント配列を丸ごと置き換える仕様のため、
// GAS側で「新しく追加されるコメントのbyIdは本人か」「既存コメントの
// 編集・削除は投稿者本人か全権管理者のみか」を検証する。
// コメントは(historyと違って)件数上限による自動切り捨てが無いため、
// 新規/既存の判定だけで足りる。
function validateCommentsUpdate_(task, newComments, acting) {
  if (!Array.isArray(newComments)) throw userError_('コメントの形式が不正です。')

  var oldComments = []
  try { oldComments = JSON.parse(task.comments_json || '[]') } catch (e) {}
  if (!Array.isArray(oldComments)) oldComments = []

  var oldById = {}
  oldComments.forEach(function (c) { if (c && c.id) oldById[c.id] = c })
  var newIds = {}
  var isAdmin = isActingFullAdmin_(acting)

  newComments.forEach(function (c) {
    if (!c || !c.id) throw userError_('コメントの形式が不正です。')
    newIds[c.id] = true
    var old = oldById[c.id]
    if (old) {
      if (!isAdmin) {
        var changed = JSON.stringify(old) !== JSON.stringify(c)
        if (changed && old.byId !== acting.id) {
          throw userError_('他のメンバーが投稿したコメントは編集できません。')
        }
      }
    } else {
      // 仕様変更(レビュー指摘対応1): 新規コメントの投稿者(byId)はクライアント
      // の値を信用せず、認証済みの本人IDで常に上書きする(なりすまし防止。
      // 管理者も例外なし)。
      c.byId = acting.id
    }
  })

  if (!isAdmin) {
    oldComments.forEach(function (c) {
      if (c && c.id && !newIds[c.id] && c.byId !== acting.id) {
        throw userError_('他のメンバーが投稿したコメントは削除できません。')
      }
    })
  }
}

// F1/F10: updateHistory も同様に配列を丸ごと置き換える仕様。history は
// HISTORY_CAP件を超えると自動的に末尾(=最も古いもの)が切り捨てられる正当な
// 動作があるため、「非管理者による更新は次の形と完全一致する場合のみ許可」
// という厳密な形で検証する:
//   新しい配列 == [今回追加されたエントリ(byIdは本人)] + 既存配列の先頭から
//                 (HISTORY_CAP - 追加件数) 件をそのまま
// 既存エントリの内容・順序が1件でも変わっている、または上限に達していない
// のに古いエントリが消えている場合は拒否する。全権管理者は制限なし。
function validateHistoryUpdate_(task, newHistory, acting) {
  if (!Array.isArray(newHistory)) throw userError_('履歴の形式が不正です。')
  // 全権管理者も、既存の記録は書き換え・削除できない(新しい記録の記録した人・日時は GAS が書く: stampNewHistoryEntries_)
  var isAdmin = isActingFullAdmin_(acting)

  var oldHistory = []
  try { oldHistory = JSON.parse(task.history_json || '[]') } catch (e) {}
  if (!Array.isArray(oldHistory)) oldHistory = []
  // シートの記録は移行前の日本語のことがある。送られてきた記録(入口でコードに
  // そろえている)と同じくコードにそろえてから比べる
  oldHistory = oldHistory.map(normalizeHistoryEntry_)

  var oldIds = {}
  oldHistory.forEach(function (h) { if (h && h.id) oldIds[h.id] = true })

  // 配列の先頭から、「既存配列に無いid(=新規追加分)」が連続する個数を数える。
  // 新規追加分は必ず先頭にまとまって入る仕様(appendHistory参照)なので、
  // 先頭以外に紛れ込んでいる場合は後段の完全一致チェックで拒否される。
  var addedCount = 0
  while (
    addedCount < newHistory.length &&
    newHistory[addedCount] &&
    newHistory[addedCount].id &&
    !oldIds[newHistory[addedCount].id]
  ) {
    addedCount++
  }

  var addedEntries = newHistory.slice(0, addedCount)
  var remainingEntries = newHistory.slice(addedCount)

  addedEntries.forEach(function (h) {
    if (!isAdmin && h.byId !== acting.id) {
      throw userError_('新しい履歴の記録者は本人である必要があります。')
    }
  })

  var expectedKeepCount = Math.max(HISTORY_CAP - addedCount, 0)
  var expected = oldHistory.slice(0, expectedKeepCount)
  if (
    remainingEntries.length !== expected.length ||
    JSON.stringify(remainingEntries) !== JSON.stringify(expected)
  ) {
    throw userError_('他のメンバーが記録した履歴を変更・削除することはできません。')
  }
}

// F7: LockServiceで保護しない(=書き込みを伴わない)アクション。
// translateText/getMyEmails/fetchDailyReportsは読み取りのみ。
// checkAndGenerateRecurringTasksはgenerateRecurringTasksLocked_()内で
// 既に自前のスクリプトロックを取得するため、ここでも取得すると同一実行内で
// 同じロックを二重に待つことになり無駄(かつ不必要に複雑)なので対象外にする。
// F14: 業務上のエラー(利用者にそのままメッセージを見せてよいもの)は必ず
// この関数で作って投げる。SpreadsheetApp等のApps Scriptサービスが投げる
// 例外やコード内の想定外のバグ(TypeError等)にはこの目印(isUserError)が
// 付かないため、doPost側でtoErrorMessage_()を使って「目印の有無」だけで
// 安全に振り分けられる(err.nameのように実行環境依存の値に頼らない)。
function userError_(message) {
  var e = new Error(message)
  e.isUserError = true
  return e
}

// doPost内の各catchで例外をクライアント向けメッセージに変換する共通処理。
// userError_()由来(業務エラー)ならそのメッセージをそのまま返す。目印が
// 無い例外は「予期しない例外」とみなし、スタックトレース等の内部情報は
// Loggerにのみ記録し(リクエスト本文やトークンは記録しない)、フロントには
// 定型メッセージだけを返す。
function toErrorMessage_(err) {
  if (err && err.isUserError) return String(err.message || err)
  // Google の許可が足りない(マニフェストの oauthScopes に無い・持ち主がまだ許可していない)時は、その機能だけ止まる。直し方を返す
  if (isPermissionError_(err)) {
    Logger.log('doPost permission error: ' + maskEmailsIn_(String((err && err.message) || err)).slice(0, 300))
    return PERMISSION_MESSAGE
  }
  var quota = quotaKind_(err)
  if (quota) {
    Logger.log('doPost quota exceeded [' + quota + ']')
    return quotaMessage_(quota, false)
  }
  Logger.log('doPost unexpected error [' + (err && err.name) + ']: ' + maskEmailsIn_(String((err && err.stack) || (err && err.message) || err)))
  return '処理中に問題が発生しました。しばらくしてから再度お試しください。'
}

// testDiscordWebhook/testSlackWebhookはスプレッドシートを書き換えず外部
// Webhookへの疎通確認(UrlFetchApp、数百ms〜数秒かかりうる)のみなので、
// ロック保持時間を最小限にするため対象外にする(レビュー指摘対応4)。
var LOCK_EXEMPT_ACTIONS = [
  'translateText', 'getMyEmails', 'getMyStorage', 'getOrgStorage', 'searchArchivedTasks', 'getBackgroundData', 'fetchDailyReports', 'checkAndGenerateRecurringTasks',
  'testDiscordWebhook', 'testSlackWebhook', 'getExpenses', 'getFiles', 'getWebhookStatus',
  'getCandidates', 'getFormSubmissions',
  // スクリプトプロパティ(世代番号)だけを書き換える。データの版は変えない
  'revokeMySessions', 'revokeMemberSessions',
  // 本人あての招待リンクのメール(シートを書き換えない。送った回数は CacheService に数える)
  'getInviteMailStatus', 'sendInviteLinkToMe',
  // メールの1日の上限の状態・この GAS の版の更新(スクリプトプロパティを読むだけ)
  'getMailQuotaStatus', 'getGasUpdateStatus',
  // バックアップの状態・一覧・戻す前の確かめ(バックアップを読むだけ)
  'getBackupStatus', 'listBackups', 'previewRestore', 'searchBackupTasks',
  // 今すぐバックアップを作る(シートは書き換えない。Drive にコピーを作り、スクリプトプロパティに記録するだけ)
  'createBackupNow',
  // 個人情報の削除の予定(シートを読むだけ)
  'getPersonalDataStatus',
  // 毎日・毎時の処理と共有の状態(スクリプトプロパティを読むだけ)・共有の確かめ直し(Drive を読み、スクリプトプロパティだけを書く)
  'getOpsStatus', 'recheckSharing',
  // 利用の集計とエラーの件数(読むだけ)・画面のエラーの記録(エラーの記録のシートに1行足すだけ)
  'getUsageStatus', 'reportClientError',
  // FSIF に送る集計値の状態・プレビュー(シートとスクリプトプロパティを読むだけ)
  'getMetricsStatus',
  // FSIF からのお知らせ(レジストリから取る。読み取りだけ)
  'getAnnouncements',
  // 診断情報の表示・送信(団体のシートは書き換えない。機能停止中も FSIF に問い合わせられるように)
  'getDiagnostics', 'sendDiagnostics',
]

// リクエストの中の選択肢の値を、日本語・コードのどちらでもコードにそろえる。
// status などの名前は、ほかのアクション(候補者・研修など)では別の意味なので、
// アクションごとに対象を決める
function normalizeRequestCodes_(body) {
  if (!body) return
  switch (body.action) {
    case 'updateTaskStatus':
      body.status = normalizeCode_('status', body.status)
      break
    case 'updatePriority':
      body.priority = normalizeCode_('priority', body.priority)
      break
    case 'updateDifficulty':
      body.difficulty = normalizeCode_('difficulty', body.difficulty)
      break
    case 'updateVisibility':
      body.visibility = normalizeCode_('visibility', body.visibility)
      break
    case 'updateTaskDetails':
      body.department = normalizeValue_('department', body.department)
      body.difficulty = normalizeCode_('difficulty', body.difficulty)
      body.priority = normalizeCode_('priority', body.priority)
      body.visibility = normalizeCode_('visibility', body.visibility)
      body.importance = normalizeCode_('importance', body.importance)
      break
    case 'createTasks':
      ;(body.tasks || []).forEach(function (t) {
        if (!t) return
        t.department = normalizeValue_('department', t.department)
        if (t.difficulty) t.difficulty = normalizeCode_('difficulty', t.difficulty)
        if (t.priority) t.priority = normalizeCode_('priority', t.priority)
        t.visibility = normalizeCode_('visibility', t.visibility)
        if (t.importance) t.importance = normalizeCode_('importance', t.importance)
      })
      break
    case 'updateHistory':
      if (Array.isArray(body.history)) body.history = body.history.map(normalizeHistoryEntry_)
      if (Array.isArray(body.listOps)) body.listOps.forEach(function (op) { if (op && op.entry) op.entry = normalizeHistoryEntry_(op.entry) })
      break
    case 'updateTaskSchedule':
      if (body.schedule) body.schedule = mapScheduleCodes_(body.schedule, normalizeCode_)
      break
    case 'updatePermissionOverrides':
      if (Array.isArray(body.overrides)) body.overrides = mapOverrideCodes_(body.overrides, normalizeValue_)
      break
  }
}

function handlePost_(e, state) {
  var result
  // 書き込みの requestId(同じ ID の結果を覚えておき、送り直された時は前回の結果を返す)
  var replayKey = null
  try {
    startRequestTiming_()
    var body = JSON.parse(e.postData.contents)
    if (state) state.body = body
    // ping: 何もせずにすぐ返す(認証・スクリプトプロパティ・シートを読まない)。
    // 画面の往復時間と GAS の中の時間(timing.totalMs)を比べて、遅さが Google 側・回線側か切り分ける
    if (body.action === 'ping') return ({ ok: true, result: { pong: true } })
    // スクリプトプロパティはこのリクエストの中で1回だけまとめて読む(requestProps_)
    var propsStart = Date.now()
    resetRequestProps_()

    // getLoginConfig: ログイン前に団体ID(IDトークンの nonce に含める)を返す。認証不要
    if (body.action === 'getLoginConfig') {
      var orgId = requestProps_().ORG_ID
      if (!orgId) {
        return ({ ok: false, error: 'ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。' })
      }
      // 提供停止中は、ログイン画面に「利用を停止しています」を出す
      var loginContract = currentContract_(Date.now())
      if (loginContract.phase === 'inEffect' && loginContract.kind === 'suspend') {
        return ({ ok: true, result: { orgId: orgId, suspended: true } })
      }
      return ({ ok: true, result: { orgId: orgId } })
    }

    // 移行の後は、コードを読めない古いタブからのリクエストを断る(再読み込みを促す)
    var versionError = checkClientVersion_(body)
    noteTiming_('propsMs', Date.now() - propsStart)
    if (versionError) return ({ ok: false, error: versionError, reloadRequired: true })

    // 提供停止中はすべて断り、機能停止中は読み取りとログインだけを受け付ける(R1-e)
    var contract = timed_('contractMs', function () { return currentContract_(Date.now(), !readOnlyAllows_(body)) })
    state.contract = contract
    var contractError = contractRejection_(contract, body)
    if (contractError) return contractError

    // バックアップから戻している間は、書き込みを受け付けない(読み取りは受け付ける)
    if (!readOnlyAllows_(body) && restoreInProgress_()) return ({ ok: false, restoring: true, error: RESTORE_MESSAGE })

    // まとめて送られた書き込み(batch)は、中の操作がすべて受け付けられるものかを先に確かめる
    if (body.action === 'batch') {
      var batchError = validateBatch_(body)
      if (batchError) return ({ ok: false, error: batchError })
    }

    // 選択肢の値は、以降の処理ではすべてコードで扱う(古いタブは日本語で送ってくる)
    normalizeRequestCodes_(body)
    if (body.action === 'batch') body.ops.forEach(normalizeRequestCodes_)

    // exchangeIdToken: Google の IDトークンを確かめ、セッショントークンと初期データを返す。
    // 結果の受け渡し(echo)で失われて送り直された時は、処理をやり直さずに前回の結果(同じセッション)を返す(loginReplayKey_)
    if (body.action === 'exchangeIdToken') {
      var loginKey = loginReplayKey_(body)
      if (loginKey) {
        var priorLogin = readRequestReplay_(loginKey)
        if (priorLogin) {
          if (priorLogin.inFlight) return ({ ok: false, error: 'ログインを処理しています。少し待ってください。', retryLater: true })
          return priorLogin
        }
        markRequestInFlight_(loginKey)
      }
      var loginOut
      try {
        loginOut = { ok: true, result: exchangeIdToken_(body) }
      } catch (exchangeErr) {
        loginOut = authFailure_(exchangeErr)
      }
      if (loginKey) rememberLogin_(loginKey, loginOut)
      return loginOut
    }

    // getInitialData: ログインと初期データの取得をまとめて行う読み取り専用
    // アクション(メンバー特定前に呼ばれる)。
    // 閲覧者が見てよい行・列だけに絞って返す(READ_POLICY 参照)。
    if (body.action === 'getInitialData') {
      var initAuth
      try {
        initAuth = timed_('authMs', function () { return authenticateRequest_(body) })
        if (memberIsWithdrawn_(initAuth.memberId)) throw userError_(WITHDRAWN_MEMBER_MESSAGE)
      } catch (initAuthErr) {
        return authFailure_(initAuthErr)
      }
      try {
        return ({
          ok: true,
          result: attachBackgroundData_(getInitialDataForMember_(initAuth.memberId, body.knownVersion), initAuth.memberId, body),
          session: initAuth.renewed || undefined,
        })
      } catch (initErr) {
        return ({ ok: false, error: toErrorMessage_(initErr) })
      }
    }

    // ---- Token verification & authorization --------------------------------
    // Every request must carry a sessionToken (issued by exchangeIdToken and
    // signed with this organisation's key — see authenticateRequest_). The
    // member is resolved from the token, then we check whether they have
    // permission for this action.
    //
    // Auth errors are returned with authError:true so the frontend can
    // distinguish them from business logic errors (session expired → login).
    // authError はセッションが無効・期限切れ・メンバーが見つからない時だけ(画面はログイン画面に戻す)。
    // 権限が足りない時は forbidden を返す(セッションは有効なので、ログイン画面には戻さない)
    //
    // 操作するメンバー・役職は、権限そのものを変える操作(SHEET_AUTH_ACTIONS)を除き、スナップショット
    // (読み取りと同じキャッシュ)から引く。ロックを取った後に版をもう一度確かめ、判定の後に版が
    // 変わっていたら(ほかの書き込みで権限が変わったかもしれない)、シートから判定し直す
    var actingMember
    var renewedSession = null
    var auth
    var batchDenied = null
    var authStart = beginTiming_()
    try {
      auth = authenticateRequest_(body)
      renewedSession = auth.renewed
      actingMember = getActingMember_(auth.memberId, requestAuthAction_(body))
      // 退会したメンバーは操作できない(休止中のメンバーは、ログインも操作もできる。担当の候補などからは外れる)
      if (actingMember.withdrawn) throw userError_(WITHDRAWN_MEMBER_MESSAGE)
    } catch (authErr) {
      endTiming_('authMs', authStart)
      return authFailure_(authErr)
    }
    // 通知・翻訳の回数の上限は、操作したメンバーごとに数える
    _requestActorId = actingMember.id
    // 記録の一覧を丸ごと送る古い画面からの保存は断り、読み込み直してもらう(ほかの人が後から足した記録を消さないため)。
    // 差分(listOps)は、権限の判定のために、スナップショットの一覧に当てた一覧にしておく(ロックを取った後に当て直す)
    var listOpsList = body.action === 'batch' ? body.ops : [body]
    if (listOpsList.some(legacyListWrite_)) {
      endTiming_('authMs', authStart)
      return ({ ok: false, error: LEGACY_LIST_MESSAGE, reloadRequired: true, session: renewedSession || undefined })
    }
    // (形の正しくない差分は、一覧を空(null)にしておく。権限の判定か、ロックを取った後の当て直しで断る)
    listOpsList.forEach(function (op) {
      try { expandListOps_(op, false) } catch (listErr) { if (op && LIST_ACTIONS[op.action]) op[LIST_ACTIONS[op.action].param] = null }
    })
    if (body.action === 'batch') {
      batchDenied = authorizeBatch_(actingMember, body.ops)
    } else {
      try {
        authorizeAction_(actingMember, body.action, body)
      } catch (forbiddenErr) {
        endTiming_('authMs', authStart)
        return ({ ok: false, error: toErrorMessage_(forbiddenErr), forbidden: true, session: renewedSession || undefined })
      }
    }
    endTiming_('authMs', authStart)
    // ------------------------------------------------------------------------

    // F7: 書き込みを伴うアクションはLockService.getScriptLock()で排他制御する。
    // 同時書き込みによる行の取り違え・カウンタの競合等を防ぐ。取得できな
    // かった場合はエラーを返す(doPost の finishWrite_ で確実に releaseLock する)。
    if (body.action === 'batch' || LOCK_EXEMPT_ACTIONS.indexOf(body.action) < 0) {
      var lock = LockService.getScriptLock()
      var lockStart = Date.now()
      try {
        lock.waitLock(10000)
        noteTiming_('lockMs', Date.now() - lockStart)
      } catch (lockErr) {
        noteTiming_('lockMs', Date.now() - lockStart)
        appendErrorLog_('gas', body.action, 'lockBusy')
        // まだ何も処理していないので、フロントは少し待ってから送り直してよい
        return ({ ok: false, error: '混み合っています。少し待って再度お試しください。', retryLater: true })
      }
      state.lock = lock
      state.actions = body.action === 'batch' ? body.ops.map(function (op) { return op.action }) : [body.action]

      // スナップショットで判定した後に版が変わっていたら、シートから判定し直す
      if (authSnapshotChanged_()) {
        var recheckStart = beginTiming_()
        noteTiming_('authRecheck', 'sheet')
        try {
          actingMember = getActingMemberFromSheet_(auth.memberId)
        } catch (recheckAuthErr) {
          endTiming_('authRecheckMs', recheckStart)
          return authFailure_(recheckAuthErr)
        }
        if (body.action === 'batch') {
          batchDenied = authorizeBatch_(actingMember, body.ops)
        } else {
          try {
            authorizeAction_(actingMember, body.action, body)
          } catch (recheckForbiddenErr) {
            endTiming_('authRecheckMs', recheckStart)
            return ({ ok: false, error: toErrorMessage_(recheckForbiddenErr), forbidden: true, session: renewedSession || undefined })
          }
        }
        endTiming_('authRecheckMs', recheckStart)
      }
    }

    // 送り直された書き込み(同じ requestId)は、処理をやり直さずに前回の結果を返す。
    // ロックを取った後に確かめるので、同じ ID の2本目は1本目の結果を受け取る
    var replayStart = beginTiming_()
    replayKey = requestReplayKey_(actingMember.id, body)
    if (replayKey) {
      var prior = readRequestReplay_(replayKey)
      if (prior) {
        replayKey = null
        endTiming_('replayMs', replayStart)
        if (prior.inFlight) return ({ ok: false, error: '同じ操作を処理しています。少し待ってください。', retryLater: true })
        return prior
      }
      markRequestInFlight_(replayKey)
    }
    endTiming_('replayMs', replayStart)

    var actionStart = beginActionTiming_()
    try {
      result = body.action === 'batch'
        ? { results: runBatch_(body.ops, actingMember, batchDenied) }
        : runWriteAction_(body, actingMember)
    } finally {
      endActionTiming_(actionStart)
    }
    return remember_(replayKey, { ok: true, result: result, session: renewedSession || undefined })
  } catch (err) {
    // F14: userError_()で作られた業務上のエラー(目印つき)はそのメッセージを
    // フロントに返す。目印の無い例外(SpreadsheetApp等のApps Scriptサービス
    // が投げるものや、コード内の想定外のバグ)は詳細をLoggerに記録し、
    // フロントには定型メッセージだけを返す(スタックトレース等の内部情報や
    // リクエストの中身・トークンは返さない/ログにも出さない)。
    return remember_(replayKey, errorResponse_(err, body && body.action))
  }
}

// 失敗の応答。1つのセルの上限を超えて断った時は、画面が書いた文章を残せるよう cellTooLong を付ける
function errorResponse_(err, action) {
  logGasError_(err, action)
  var out = { ok: false, error: toErrorMessage_(err) }
  if (err && err.cellTooLong) out.cellTooLong = err.cellTooLong
  if (err && err.conflict) out.conflict = err.conflict
  if (err && err.featureDisabled) out.featureDisabled = err.featureDisabled
  return out
}

// 書き込みアクション(ロックを取ったもの)の後は、読み取りキャッシュを無効にするため、
// 書いたかもしれない表の版を新しくする(失敗した書き込みでも無害)。応答を作る前に行い、
// かかった時間を内訳(flushMs・versionBumpMs)に入れる
function finishWrite_(state) {
  if (!state || !state.lock) return
  try {
    // ロックを放す前に、シートへの書き込みを確定させる(確定前にロックを放すと、
    // 次にロックを取った実行が更新前の値を読むことがある)
    timed_('flushMs', function () {
      try { SpreadsheetApp.flush() } catch (flushErr) { /* 書き込みは実行の終了時にも確定する */ }
    })
    timed_('versionBumpMs', function () { bumpVersionsAfterWrite_(state.actions) })
  } finally {
    state.lock.releaseLock()
  }
}

// 送り直された時のために結果を覚えてから、応答(オブジェクト)を返す
function remember_(key, obj) {
  if (key) {
    var t = Date.now()
    try { CacheService.getScriptCache().put(key, requestReplayValue_(obj), REQUEST_REPLAY_TTL_SEC) } catch (e) { /* 覚えられなくても応答は返す */ }
    addTiming_('replayMs', Date.now() - t)
  }
  return obj
}

