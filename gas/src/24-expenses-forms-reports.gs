// ---- Phase 5: 経費申請 -------------------------------------------------------

var SHEET_EXPENSES = 'Expenses'
var SHEET_FORM_SUBMISSIONS = 'FormSubmissions'

// EXP-005: custom_field_answers_json列を既存シートにも反映させるため、
// Members/Projects/Tasks/Settingsと同じ ensureSheetHeaders_ パターンに統一
// （旧実装は新規作成時にしかヘッダーを設定していなかった）。
function ensureExpensesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders_(ss, SHEET_EXPENSES, EXPENSES_HEADERS)
  return ss.getSheetByName(SHEET_EXPENSES)
}

function ensureFormSubmissionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders_(ss, SHEET_FORM_SUBMISSIONS, FORM_SUBMISSIONS_HEADERS)
  return ss.getSheetByName(SHEET_FORM_SUBMISSIONS)
}

// item 22/30: アンケート回答をMembersシートのsurvey_responses_json列に
// 配列として追記する。新規シートを増やさず、既存の公開CSV(Members)だけで
// 完結させるため。読み込み→配列に追加→書き戻し、という一般的な
// read-modify-writeパターンで、custom_fields_json等の既存列と同じ設計。
function saveSurveyResponse_(memberId, answers) {
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません: ' + memberId)
  var existing = []
  try { existing = JSON.parse(memberRow.survey_responses_json || '[]') } catch (_) {}
  var responseId = Utilities.getUuid()
  existing.push({
    id: responseId,
    submittedAt: new Date().toISOString(),
    answers: answers || {},
  })
  updateMemberFields_(memberId, { survey_responses_json: JSON.stringify(existing) })
  return { id: responseId }
}

// 経費の金額: 0 以上の数
function checkExpenseAmount_(v) {
  var n = Number(v)
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !isFinite(n) || n < 0) throw userError_('金額は0以上の数で入れてください。')
  return n
}

// 経費のカテゴリ(団体の設定 expense_categories)。承認の段は、ここから GAS が決める(画面から送られた段は使わない)
function expenseCategoryOf_(categoryId) {
  var list = []
  try { list = JSON.parse(getSettingValue_('expense_categories') || '[]') } catch (e) { list = [] }
  var found = (Array.isArray(list) ? list : []).filter(function (c) { return c && String(c.id) === String(categoryId || '') })[0]
  if (!found) throw userError_('経費のカテゴリが見つかりません。団体の設定のカテゴリから選んでください。')
  return found
}

// 経費の申請: 申請者はログインしている本人、ID・作った日時は GAS が決める。承認の段はカテゴリの設定から決める
function saveExpenseApplication_(application, acting) {
  application = application || {}
  // F5: javascript:等の危険なURLを保存させない
  if (application.receiptUrl && !isSafeHttpUrl_(application.receiptUrl)) {
    throw userError_('領収書URLは http または https で始まるURLのみ登録できます。')
  }
  var amount = checkExpenseAmount_(application.amount)
  var category = expenseCategoryOf_(application.categoryId)
  var steps = Array.isArray(category.approvalSteps) ? category.approvalSteps : []
  var id = 'exp-' + Utilities.getUuid()
  var sheet = ensureExpensesSheet_()
  appendRowByHeaders_(sheet, SHEET_EXPENSES, {
    id: id,
    applicant_id: String(acting.id),
    amount: amount,
    category_id: String(category.id),
    receipt_url: application.receiptUrl || '',
    justification: application.justification || '',
    purpose: application.purpose || '',
    custom_field_answers_json: JSON.stringify(application.customFieldAnswers || {}),
    approval_steps_json: JSON.stringify(steps),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    created_at: new Date().toISOString(),
    rejection_reason: '',
  })
  application = { id: id, amount: amount }
  // 1次承認者への通知
  if (steps.length > 0) {
    var firstStep = steps[0]
    var emails = []
    if (firstStep.type === 'member' && firstStep.memberId) {
      emails = memberEmailsByIds_([firstStep.memberId])
    }
    sendLocalizedEmail_(emails, {
      ja: { subject: 'Ohsumi: 経費申請が届きました', body: '経費申請が届きました。Ohsumiから確認・承認してください。\n\n金額: ¥' + application.amount },
      en: { subject: 'Ohsumi: New expense application received', body: 'A new expense application has been submitted. Please review and approve it in Ohsumi.\n\nAmount: ¥' + application.amount },
    })
  }
  return { id: application.id }
}

// EXP-008: 差し戻された申請を、IDを変えずに更新して再提出する（新規作成ではない）。
function resubmitExpense_(applicationId, fields, actorId) {
  var sheet = ensureExpensesSheet_()
  var found = findExpenseRow_(sheet, applicationId)
  if (!found) throw userError_('経費申請が見つかりません: ' + applicationId)

  var headers = found.headers
  var applicantId = String(found.data[headers.indexOf('applicant_id')])
  if (actorId && actorId !== applicantId) {
    throw userError_('この経費申請を再提出する権限がありません。')
  }

  fields = fields || {}
  // F5: javascript:等の危険なURLを保存させない
  if (fields.receiptUrl && !isSafeHttpUrl_(fields.receiptUrl)) {
    throw userError_('領収書URLは http または https で始まるURLのみ登録できます。')
  }
  // 承認の段は、画面から送られた段を使わず、カテゴリの設定から GAS が決める
  var categoryId = fields.categoryId || found.data[headers.indexOf('category_id')]
  var category = expenseCategoryOf_(categoryId)
  var approvalSteps = Array.isArray(category.approvalSteps) ? category.approvalSteps : []
  var amount = checkExpenseAmount_(fields.amount != null ? fields.amount : found.data[headers.indexOf('amount')])

  var updates = {
    amount: amount,
    category_id: String(category.id),
    receipt_url: fields.receiptUrl || '',
    justification: fields.justification || '',
    purpose: fields.purpose || '',
    custom_field_answers_json: JSON.stringify(fields.customFieldAnswers || {}),
    approval_steps_json: JSON.stringify(approvalSteps),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    rejection_reason: '',
  }
  updateRowFields_(SHEET_EXPENSES, applicationId, updates)

  // 1次承認者への通知（新規申請時と同じ）
  if (approvalSteps.length > 0) {
    var firstStep = approvalSteps[0]
    var emails = []
    if (firstStep.type === 'member' && firstStep.memberId) {
      emails = memberEmailsByIds_([firstStep.memberId])
    }
    sendLocalizedEmail_(emails, {
      ja: { subject: 'Ohsumi: 経費申請が再提出されました', body: '差し戻された経費申請が修正のうえ再提出されました。Ohsumiから確認・承認してください。\n\n金額: ¥' + amount },
      en: { subject: 'Ohsumi: Expense application resubmitted', body: 'A returned expense application has been revised and resubmitted. Please review and approve it in Ohsumi.\n\nAmount: ¥' + amount },
    })
  }
  return { ok: true }
}

function findExpenseRow_(sheet, applicationId) {
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0) return null
  var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol]) === applicationId) {
      return { row: i + 2, data: rows[i], headers: headers }
    }
  }
  return null
}

function processExpenseStep_(applicationId, stepId, actorId, action, comment) {
  var sheet = ensureExpensesSheet_()
  var found = findExpenseRow_(sheet, applicationId)
  if (!found) throw userError_('経費申請が見つかりません: ' + applicationId)

  var headers = found.headers
  var data = found.data
  var approvalsCol = headers.indexOf('approvals_json')
  var stepIndexCol = headers.indexOf('current_step_index')
  var statusCol = headers.indexOf('status')
  var stepsCol = headers.indexOf('approval_steps_json')

  var approvals = JSON.parse(String(data[approvalsCol] || '[]'))
  var steps = JSON.parse(String(data[stepsCol] || '[]'))
  var currentIdx = Number(data[stepIndexCol]) || 0

  // 3-1: stepId 順序チェック — 現在のステップと一致しない場合は拒否
  var currentStep = steps[currentIdx]
  if (!currentStep || currentStep.id !== stepId) {
    throw userError_('指定されたステップは現在の承認ステップではありません。')
  }

  approvals.push({ stepId: stepId, memberId: actorId, at: new Date().toISOString(), action: action, comment: comment || '' })

  var step = steps[currentIdx]
  var stepApprovals = approvals.filter(function(a) { return a.stepId === (step ? step.id : '') && a.action === 'approved' })
  var needed = (step && step.requiredCount === 'all') ? Infinity : (step && typeof step.requiredCount === 'number' ? step.requiredCount : 1)
  var nextIdx = stepApprovals.length >= needed ? currentIdx + 1 : currentIdx
  var newStatus = nextIdx >= steps.length ? 'approved' : 'pending'

  sheet.getRange(found.row, approvalsCol + 1).setValue(JSON.stringify(approvals))
  sheet.getRange(found.row, stepIndexCol + 1).setValue(nextIdx)
  sheet.getRange(found.row, statusCol + 1).setValue(newStatus)

  // 次ステップ承認者への通知
  if (nextIdx > currentIdx && nextIdx < steps.length) {
    var nextStep = steps[nextIdx]
    var notifyIds = []
    if (nextStep && nextStep.type === 'member' && nextStep.memberId) {
      notifyIds = [nextStep.memberId]
    } else if (nextStep && nextStep.type === 'role' && nextStep.role) {
      try {
        var mSheet = getSheet_(SHEET_MEMBERS)
        var mHeaders = headerRow_(mSheet)
        var mRoleCol = mHeaders.indexOf('role')
        var mIdCol = mHeaders.indexOf('id')
        if (mRoleCol >= 0 && mIdCol >= 0 && mSheet.getLastRow() > 1) {
          var mRows = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, mHeaders.length).getValues()
          mRows.forEach(function(r) {
            if (sameRole_(getRoles_(), r[mRoleCol], nextStep.role)) notifyIds.push(String(r[mIdCol]))
          })
        }
      } catch(e) {}
    }
    if (notifyIds.length > 0) {
      var nextEmails = memberEmailsByIds_(notifyIds)
      sendLocalizedEmail_(nextEmails, {
        ja: { subject: 'Ohsumi: 経費承認の依頼', body: '経費申請の承認依頼が届きました。Ohsumiにログインして確認してください。' },
        en: { subject: 'Ohsumi: Expense approval requested', body: 'An expense application is waiting for your approval. Please log in to Ohsumi to review it.' },
      })
      notifyChat_('💴 経費申請の承認依頼が届きました（ステップ ' + (nextIdx + 1) + '）。Ohsumiにログインして確認してください。')
    }
  }

  // 申請者への完了通知
  if (newStatus === 'approved') {
    var applicantId = String(data[headers.indexOf('applicant_id')])
    var emails = memberEmailsByIds_([applicantId])
    deliverNotification_(emails, {
      ja: { subject: 'Ohsumi: 経費申請が承認されました', body: '経費申請が承認されました。' },
      en: { subject: 'Ohsumi: Expense application approved', body: 'Your expense application has been approved.' },
    })
  }
  return { ok: true }
}

function setExpenseStatus_(applicationId, status, reason, actorId) {
  var sheet = ensureExpensesSheet_()
  var found = findExpenseRow_(sheet, applicationId)
  if (!found) throw userError_('経費申請が見つかりません: ' + applicationId)

  var headers = found.headers
  var statusCol = headers.indexOf('status')
  var reasonCol = headers.indexOf('rejection_reason')
  var applicantId = String(found.data[headers.indexOf('applicant_id')])

  // 取り下げは申請者本人のみ
  if (status === 'withdrawn' && actorId && actorId !== applicantId) {
    throw userError_('この経費申請を取り下げる権限がありません。')
  }

  sheet.getRange(found.row, statusCol + 1).setValue(status)
  if (reason && reasonCol >= 0) {
    sheet.getRange(found.row, reasonCol + 1).setValue(reason)
  }

  // 取り下げ通知: 現在の承認ステップの担当者に「対応不要」を通知（best-effort）
  if (status === 'withdrawn') {
    try {
      var stepsColW = headers.indexOf('approval_steps_json')
      var stepIdxColW = headers.indexOf('current_step_index')
      if (stepsColW >= 0 && stepIdxColW >= 0) {
        var stepsW = JSON.parse(String(found.data[stepsColW] || '[]'))
        var stepIdxW = Number(found.data[stepIdxColW]) || 0
        var currentStepW = stepsW[stepIdxW]
        var withdrawNotifyIds = []
        if (currentStepW) {
          if (currentStepW.type === 'member' && currentStepW.memberId) {
            withdrawNotifyIds = [currentStepW.memberId]
          } else if (currentStepW.type === 'role' && currentStepW.role) {
            var wSheet = getSheet_(SHEET_MEMBERS)
            var wHeaders = headerRow_(wSheet)
            var wRoleCol = wHeaders.indexOf('role')
            var wIdCol = wHeaders.indexOf('id')
            if (wRoleCol >= 0 && wIdCol >= 0 && wSheet.getLastRow() > 1) {
              var wRows = wSheet.getRange(2, 1, wSheet.getLastRow() - 1, wHeaders.length).getValues()
              wRows.forEach(function(r) {
                if (sameRole_(getRoles_(), r[wRoleCol], currentStepW.role)) withdrawNotifyIds.push(String(r[wIdCol]))
              })
            }
          }
        }
        if (withdrawNotifyIds.length > 0) {
          var wEmails = memberEmailsByIds_(withdrawNotifyIds)
          deliverNotification_(wEmails, {
            ja: { subject: 'Ohsumi: 経費申請が取り下げられました', body: '経費申請が取り下げられました。この申請への対応は不要です。' },
            en: { subject: 'Ohsumi: Expense application withdrawn', body: 'The expense application has been withdrawn. No action is needed on your part.' },
          })
          notifyChat_('💴 経費申請が取り下げられました。この申請への対応は不要です。')
        }
      }
    } catch(eW) { /* best-effort */ }
  }

  // 却下通知
  if (status === 'rejected') {
    var emails = memberEmailsByIds_([applicantId])
    deliverNotification_(emails, {
      ja: { subject: 'Ohsumi: 経費申請が却下されました', body: '経費申請が却下されました。\n理由: ' + (reason || '—') },
      en: { subject: 'Ohsumi: Expense application rejected', body: 'Your expense application has been rejected.\nReason: ' + (reason || '—') },
    })
  }

  // EXP-008: 差し戻し通知（却下とは別。修正して再提出できる旨を伝える）
  if (status === 'returned') {
    var rEmails = memberEmailsByIds_([applicantId])
    deliverNotification_(rEmails, {
      ja: { subject: 'Ohsumi: 経費申請が差し戻されました', body: '経費申請が差し戻されました。内容を修正のうえ、再提出してください。\n理由: ' + (reason || '—') },
      en: { subject: 'Ohsumi: Expense application returned for revision', body: 'Your expense application has been returned for revision. Please update it and resubmit.\nReason: ' + (reason || '—') },
    })
  }
  return { ok: true }
}

// ---- Phase 5: カスタムフォーム申請 -------------------------------------------

// FRM-005: 1次承認者への通知。経費申請のsaveExpenseApplication_と同じ
// パターンだが、フォーム定義(approvalSteps)はSettingsの
// custom_form_defsから引く必要がある点が経費申請と異なる
// (経費申請はapplication自体にステップのスナップショットを持つ)。
// 申請フォームの提出: 提出者はログインしている本人、ID・作った日時は GAS が決める。フォームは団体の設定にあるものだけ
function saveCustomFormSubmission_(submission, acting) {
  submission = submission || {}
  var customFormDefs = []
  try {
    var raw = getSettingValue_('custom_form_defs')
    if (raw) customFormDefs = JSON.parse(raw)
  } catch (e) {}
  if (!Array.isArray(customFormDefs)) customFormDefs = []
  var formDef = customFormDefs.filter(function (f) { return f && String(f.id) === String(submission.formId || '') })[0]
  if (!formDef) throw userError_('申請フォームが見つかりません。')
  var id = 'fs-' + Utilities.getUuid()
  var sheet = ensureFormSubmissionsSheet_()
  appendRowByHeaders_(sheet, SHEET_FORM_SUBMISSIONS, {
    id: id,
    form_id: String(formDef.id),
    submitter_id: String(acting.id),
    answers_json: JSON.stringify(submission.answers || {}),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    created_at: new Date().toISOString(),
    rejection_reason: '',
  })
  submission = { id: id, formId: String(formDef.id), submitterId: String(acting.id) }
  var steps = formDef ? (formDef.approvalSteps || []) : []
  if (steps.length > 0) {
    var firstStep = steps[0]
    var emails = []
    if (firstStep.type === 'member' && firstStep.memberId) {
      emails = memberEmailsByIds_([firstStep.memberId])
    } else if (firstStep.type === 'role' && firstStep.role) {
      try {
        var mSheet = getSheet_(SHEET_MEMBERS)
        var mHeaders = headerRow_(mSheet)
        var mRoleCol = mHeaders.indexOf('role')
        var mIdCol = mHeaders.indexOf('id')
        if (mRoleCol >= 0 && mIdCol >= 0 && mSheet.getLastRow() > 1) {
          var mRows = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, mHeaders.length).getValues()
          var roleIds = []
          mRows.forEach(function (r) {
            if (sameRole_(getRoles_(), r[mRoleCol], firstStep.role)) roleIds.push(String(r[mIdCol]))
          })
          emails = memberEmailsByIds_(roleIds)
        }
      } catch (e2) {}
    }
    var formTitle = formDef ? formDef.title : ''
    sendLocalizedEmail_(emails, {
      ja: { subject: 'Ohsumi: 申請フォームが届きました', body: '申請フォームが届きました。Ohsumiから確認・承認してください。\n\nフォーム: ' + formTitle },
      en: { subject: 'Ohsumi: New form submission received', body: 'A new form submission has been received. Please review and approve it in Ohsumi.\n\nForm: ' + formTitle },
    })
  }
  return { id: submission.id }
}

function findFormSubmissionRow_(sheet, submissionId) {
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0) return null
  var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol]) === submissionId) {
      return { row: i + 2, data: rows[i], headers: headers }
    }
  }
  return null
}

function processFormStep_(submissionId, stepId, actorId, action, comment) {
  var sheet = ensureFormSubmissionsSheet_()
  var found = findFormSubmissionRow_(sheet, submissionId)
  if (!found) throw userError_('フォーム申請が見つかりません: ' + submissionId)

  var headers = found.headers
  var data = found.data
  var approvalsCol = headers.indexOf('approvals_json')
  var stepIndexCol = headers.indexOf('current_step_index')
  var statusCol = headers.indexOf('status')

  var approvals = JSON.parse(String(data[approvalsCol] || '[]'))
  var currentIdx = Number(data[stepIndexCol]) || 0

  // フォーム定義からステップ一覧を取得（Settingsから読む）
  var formId = String(data[headers.indexOf('form_id')])
  var customFormDefs = []
  try {
    var raw = getSettingValue_('custom_form_defs')
    if (raw) customFormDefs = JSON.parse(raw)
  } catch(e) {}
  var formDef = customFormDefs.filter(function(f) { return f.id === formId })[0]
  var allSteps = formDef ? (formDef.approvalSteps || []) : []
  var totalSteps = allSteps.length
  var step = allSteps[currentIdx]

  // 3-1: stepId 順序チェック — 現在のステップと一致しない場合は拒否
  if (!step || step.id !== stepId) {
    throw userError_('指定されたステップは現在の承認ステップではありません。')
  }

  approvals.push({ stepId: stepId, memberId: actorId, at: new Date().toISOString(), action: action, comment: comment || '' })
  var stepApprovals = approvals.filter(function(a) { return a.stepId === stepId && a.action === 'approved' })

  var needed = (step && step.requiredCount === 'all') ? Infinity : (step && typeof step.requiredCount === 'number' ? step.requiredCount : 1)
  var nextIdx = stepApprovals.length >= needed ? currentIdx + 1 : currentIdx
  var newStatus = nextIdx >= totalSteps ? 'approved' : 'pending'

  sheet.getRange(found.row, approvalsCol + 1).setValue(JSON.stringify(approvals))
  sheet.getRange(found.row, stepIndexCol + 1).setValue(nextIdx)
  sheet.getRange(found.row, statusCol + 1).setValue(newStatus)

  // 次ステップ承認者への通知
  if (nextIdx > currentIdx && nextIdx < totalSteps) {
    var nextFmStep = allSteps[nextIdx]
    var fmNotifyIds = []
    if (nextFmStep && nextFmStep.type === 'member' && nextFmStep.memberId) {
      fmNotifyIds = [nextFmStep.memberId]
    } else if (nextFmStep && nextFmStep.type === 'role' && nextFmStep.role) {
      try {
        var fmMSheet = getSheet_(SHEET_MEMBERS)
        var fmMHeaders = headerRow_(fmMSheet)
        var fmMRoleCol = fmMHeaders.indexOf('role')
        var fmMIdCol = fmMHeaders.indexOf('id')
        if (fmMRoleCol >= 0 && fmMIdCol >= 0 && fmMSheet.getLastRow() > 1) {
          var fmMRows = fmMSheet.getRange(2, 1, fmMSheet.getLastRow() - 1, fmMHeaders.length).getValues()
          fmMRows.forEach(function(r) {
            if (sameRole_(getRoles_(), r[fmMRoleCol], nextFmStep.role)) fmNotifyIds.push(String(r[fmMIdCol]))
          })
        }
      } catch(e2) {}
    }
    if (fmNotifyIds.length > 0) {
      var fmNextEmails = memberEmailsByIds_(fmNotifyIds)
      if (fmNextEmails.length > 0) {
        sendMail_({ to: fmNextEmails.join(','), subject: 'Ohsumi: 申請フォーム承認の依頼', body: '申請フォームの承認依頼が届きました。Ohsumiにログインして確認してください。' })
      }
      notifyChat_('📋 申請フォームの承認依頼が届きました（ステップ ' + (nextIdx + 1) + '）。Ohsumiにログインして確認してください。')
    }
  }

  return { ok: true }
}

function setFormSubmissionStatus_(submissionId, status, reason) {
  var sheet = ensureFormSubmissionsSheet_()
  var found = findFormSubmissionRow_(sheet, submissionId)
  if (!found) throw userError_('フォーム申請が見つかりません: ' + submissionId)

  var headers = found.headers
  var statusCol = headers.indexOf('status')
  var reasonCol = headers.indexOf('rejection_reason')
  var submitterIdCol = headers.indexOf('submitter_id')

  sheet.getRange(found.row, statusCol + 1).setValue(status)
  if (reason && reasonCol >= 0) sheet.getRange(found.row, reasonCol + 1).setValue(reason)

  // 却下時: 申請者にメール通知（best-effort）
  if (status === 'rejected' && submitterIdCol >= 0) {
    try {
      var submitterId = String(found.data[submitterIdCol] || '')
      if (submitterId) {
        var emails = memberEmailsByIds_([submitterId])
        if (emails.length > 0) {
          deliverNotification_(emails, { ja: {
            subject: '[Ohsumi] 申請フォームが却下されました',
            body:
              '申請フォームの申請が却下されました。\n\n' +
              (reason ? '理由: ' + reason + '\n\n' : '') +
              'Ohsumiで確認してください。',
          } })
        }
        notifyChat_('📋 申請フォームが却下されました。理由はOhsumiで確認してください。')
      }
    } catch (eR) {
      console.error('setFormSubmissionStatus: 却下通知送信失敗: ' + eR)
    }
  }

  return { ok: true }
}

// ---- 日報・週報 (REP-004/REP-005) -------------------------------------------
// daily-report-screen.tsxはこれまでlocalStorageのみに保存しており、他の
// メンバー・管理者と共有されなかった。Expenses/FormSubmissionsと同じ
// ensureSheetHeaders_パターンで専用シートを新設し、保存(submitDailyReport)
// と読み取り(fetchDailyReports)を分ける — 経費申請のように「書き込みは
// GASにあるが読み取りはローカルstateのみ」という状態を繰り返さないよう、
// 管理者の閲覧画面が明示的にfetchDailyReportsを呼ぶ設計にする。

var SHEET_DAILY_REPORTS = 'DailyReports'

function ensureDailyReportsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders_(ss, SHEET_DAILY_REPORTS, DAILY_REPORTS_HEADERS)
  return ss.getSheetByName(SHEET_DAILY_REPORTS)
}

// REP-004: 日報・週報の保存(追記のみ)。
// 日報・週報: メンバーはログインしている本人、ID・作った日時は GAS が決める。種類と日付の形を確かめる
function saveDailyReport_(report, acting) {
  report = report || {}
  if (report.type !== 'daily' && report.type !== 'weekly') throw userError_('日報・週報の種類が不正です。')
  var date = checkDate_(report.date, '日報・週報の日付')
  if (!date) throw userError_('日報・週報の日付を入れてください。')
  var id = 'dr-' + Utilities.getUuid()
  var sheet = ensureDailyReportsSheet_()
  appendRowByHeaders_(sheet, SHEET_DAILY_REPORTS, {
    id: id,
    member_id: String(acting.id),
    type: report.type,
    report_date: date,
    done_text: report.done || '',
    todo_text: report.todo || '',
    issues_text: report.issues || '',
    created_at: new Date().toISOString(),
  })
  return { id: id }
}

// REP-005: 管理者が日報・週報の閲覧画面を開いたときに呼ぶ読み取り専用action。
function fetchDailyReports_() {
  var sheet = ensureDailyReportsSheet_()
  var headers = headerRow_(sheet)
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return []

  var idCol = headers.indexOf('id')
  var memberCol = headers.indexOf('member_id')
  var typeCol = headers.indexOf('type')
  var dateCol = headers.indexOf('report_date')
  var doneCol = headers.indexOf('done_text')
  var todoCol = headers.indexOf('todo_text')
  var issuesCol = headers.indexOf('issues_text')
  var createdCol = headers.indexOf('created_at')

  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  return rows.map(function (r) {
    return {
      id: String(r[idCol]),
      memberId: String(r[memberCol]),
      type: r[typeCol],
      date: r[dateCol],
      done: r[doneCol],
      todo: r[todoCol],
      issues: r[issuesCol],
      createdAt: r[createdCol],
    }
  })
}

// ---- 採用支援（入会前の履歴書・面談メモ） -----------------------------------
// 権限はauthorizeAction_側でdaihyoOnly + permission_overrides(targetType:'recruiting')
// の個別指定制。読み書きともにExpenses/FormSubmissionsと同じくシート直書き
// パターン（CSV配信は行わない。フロント側はローカルstateで管理する）。

var SHEET_CANDIDATES = 'Candidates'

function ensureCandidatesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders_(ss, SHEET_CANDIDATES, CANDIDATES_HEADERS)
  return ss.getSheetByName(SHEET_CANDIDATES)
}

function addCandidate_(candidate) {
  var sheet = ensureCandidatesSheet_()
  var headers = headerRow_(sheet)
  var id = String(nextIntId_(sheet, headers))
  var now = new Date().toISOString()
  appendRowByHeaders_(sheet, SHEET_CANDIDATES, {
    id: id,
    name: candidate.name || '',
    email: candidate.email || '',
    phone: candidate.phone || '',
    resume_text: candidate.resumeText || '',
    interview_notes: candidate.interviewNotes || '',
    status: candidate.status || 'candidate',
    created_at: now,
    updated_at: now,
  })
  return { id: id }
}

function updateCandidate_(candidateId, fields) {
  ensureCandidatesSheet_()
  var mapped = {}
  if (fields.name !== undefined) mapped.name = fields.name
  if (fields.email !== undefined) mapped.email = fields.email
  if (fields.phone !== undefined) mapped.phone = fields.phone
  if (fields.resumeText !== undefined) mapped.resume_text = fields.resumeText
  if (fields.interviewNotes !== undefined) mapped.interview_notes = fields.interviewNotes
  if (fields.status !== undefined) mapped.status = fields.status
  mapped.updated_at = new Date().toISOString()
  // 採用しなかった日時(個人情報を消す日の基準)。不採用から変えたら、消す予定も消す
  if (fields.status !== undefined) {
    var current = findRow_(SHEET_CANDIDATES, candidateId)
    var wasRejected = !!current && String(current.status || '') === 'rejected'
    if (fields.status === 'rejected' && !wasRejected) mapped.rejected_at = mapped.updated_at
    if (fields.status !== 'rejected') { mapped.rejected_at = ''; mapped.purge_at = '' }
  }
  return updateRowFields_(SHEET_CANDIDATES, candidateId, mapped)
}

function removeCandidate_(candidateId) {
  var sheet = ensureCandidatesSheet_()
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id') + 1
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (idCol === 0) throw userError_('シートの構成が不正です。管理者にお問い合わせください。')
  var lastRow = sheet.getLastRow()
  var ids = sheet.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues()
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(candidateId)) {
      sheet.deleteRow(i + 2)
      forgetSheetGrid_()
      break
    }
  }
  return { ok: true }
}

// 候補者を正式なMemberレコードへ変換する（addMemberを呼ぶだけ）。
// Candidatesシートの行は自動削除しない — 手動でremoveCandidateするまで残す。
function convertCandidateToMember_(candidateId, role) {
  var candidate = findRow_(SHEET_CANDIDATES, candidateId)
  if (!candidate) throw userError_('候補者が見つかりません: ' + candidateId)
  var created = addMember_(String(candidate.name || ''), String(candidate.email || ''), '', role || baseRoleRef_())
  updateRowFields_(SHEET_CANDIDATES, candidateId, { status: 'hired', updated_at: new Date().toISOString() })
  return { memberId: created.id }
}

// ---- Phase 6: スキル一括更新 ----

function bulkUpdateSkillLevels_(updates) {
  // updates: [{ memberId, skill, level }]
  if (!updates || updates.length === 0) return { ok: true, updated: 0 }

  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_MEMBERS)
  if (!sheet) throw userError_('Membersシートが見つかりません')

  var data = sheet.getDataRange().getValues()
  var headers = data[0].map(function(h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var skillLevelsCol = headers.indexOf('skill_levels_json')
  if (idCol < 0 || skillLevelsCol < 0) throw userError_('Membersシートの列が不足しています')

  // group updates by memberId
  var byMember = {}
  for (var i = 0; i < updates.length; i++) {
    var u = updates[i]
    if (!byMember[u.memberId]) byMember[u.memberId] = []
    byMember[u.memberId].push(u)
  }

  var count = 0
  for (var row = 1; row < data.length; row++) {
    var memberId = String(data[row][idCol] || '')
    if (!memberId || !byMember[memberId]) continue

    var existing = []
    try {
      existing = JSON.parse(String(data[row][skillLevelsCol] || '[]')) || []
    } catch (e) { existing = [] }

    var memberUpdates = byMember[memberId]
    for (var j = 0; j < memberUpdates.length; j++) {
      var upd = memberUpdates[j]
      var found = false
      for (var k = 0; k < existing.length; k++) {
        if (existing[k].skill === upd.skill) {
          existing[k].level = upd.level
          found = true
          break
        }
      }
      if (!found) existing.push({ skill: upd.skill, level: upd.level })
    }

    sheet.getRange(row + 1, skillLevelsCol + 1).setValue(JSON.stringify(existing))
    count++
  }

  return { ok: true, updated: count }
}

