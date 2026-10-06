// できる操作(capability)を入れる前の authorizeAction_(2026-10-06 の gas/src/10-authorize.gs のまま)。
// 既定の役職で操作の可否が前と1つも変わらないことを lib/ohsumi/gas-capabilities.test.ts で比べるために残す。
// 直さないこと。
function authorizeActionBefore_(acting, action, body) {
  if (REMOVED_ACTIONS.indexOf(action) >= 0) throw userError_(REMOVED_ACTION_MESSAGE)
  // ゴミ箱のタスクは、元に戻す・完全に消す以外の操作を受け付けない(代表も)
  if (body && body.taskId && TRASH_ACTIONS.indexOf(action) < 0) {
    var trashed = null
    try { trashed = authFindRow_(SHEET_TASKS, String(body.taskId)) } catch (e) { trashed = null }
    if (trashed && String(trashed.deleted_at || '') !== '') throw userError_(TRASHED_TASK_MESSAGE)
  }
  var role = acting.role
  // isLeader: true for any role that is not '一般' (i.e. any admin-level role).
  // We cannot enumerate all possible role names (they are user-configurable in Admin → Tags),
  // so we match '代表' specially and treat everything else non-一般 as 班長-equivalent.
  // 役職の種類で判定する(名前・ID のどちらでも。役職の名前を変えても同じ)
  var isDaihyo = isTopRoleRef_(getRoles_(), role)
  var isLeader = !isDaihyo && isAdminRoleRef_(getRoles_(), role)

  // 代表 can do anything
  if (isDaihyo) return

  // バックアップ(一覧・戻す)は代表だけ(権限の個別の上書きでも渡さない)
  var backupActions = ['getBackupStatus', 'listBackups', 'previewRestore', 'searchBackupTasks', 'restoreBackup', 'restoreTasks', 'createBackupNow']
  if (backupActions.indexOf(action) >= 0) throw userError_('バックアップは代表だけが使えます。')
  // 個人情報の削除(保存期間・すぐ消す・延長・退会の取り消し)も代表だけ
  // 毎日・毎時の処理と共有の状態(代表の管理画面に出す)・共有の確かめ直しも代表だけ
  var opsActions = ['getOpsStatus', 'recheckSharing', 'getUsageStatus', 'getMetricsStatus', 'setMetricsSharing', 'getDiagnostics', 'sendDiagnostics']
  if (opsActions.indexOf(action) >= 0) throw userError_('この操作は代表だけが使えます。')
  // FSIF からのお知らせは、代表・管理者(一般以外の役職)が読める
  if (action === 'getAnnouncements') {
    if (isLeader) return
    throw userError_('FSIF からのお知らせは、代表・管理者だけが見られます。')
  }
  var privacyActions = ['getPersonalDataStatus', 'setPersonalDataRetention', 'purgePersonalDataNow', 'extendPersonalData', 'cancelWithdrawal', 'deleteOrphanEmails']
  if (privacyActions.indexOf(action) >= 0) throw userError_('個人情報の削除は代表だけが使えます。')

  // --- 代表のみ ---
  var daihyoOnly = [
    'updateRole',              // ロール変更は代表のみ
    'removeMember',            // メンバー削除は代表のみ
    'removeProject',           // プロジェクト削除は代表のみ
    // updateDiscordWebhookUrl/updateSlackWebhookUrl/updateSetting は
    // isActingFullAdmin_基準の分岐（下記）に移動した
    'uploadOrgLogo',           // 団体ロゴアップロードは代表のみ
    'addMember',               // メンバー追加は代表のみ
    'updateEmail',             // 他人のメールアドレス変更は代表のみ
    'updateJoinedAt',          // 所属開始日の編集は代表のみ（人事記録）
    'updateReportsTo',         // 報告先の設定は代表のみ（組織図操作）
    'updateMentor',            // メンター設定は代表のみ（HR操作）
    'notifyTrainingDecision',       // 研修承認通知は代表のみ（承認権限）
    'updatePermissionOverrides',    // 権限例外の編集は代表のみ（人事機密）
    'updateMemberProjects',         // プロジェクト割り当ては代表のみ（自己昇権の抜け穴防止）
    // 採用関連は「代表のみ、ただし permission_overrides(targetType: 'recruiting')の
    // 例外を持つメンバーのみ許可」という個別指定制にしたいため、あえてdaihyoOrLeader
    // ではなくdaihyoOnlyに置く（班長など他の管理者ロールにもデフォルトでは開放しない）
    'addCandidate',                 // 候補者登録
    'updateCandidate',              // 候補者情報の編集
    'removeCandidate',              // 候補者削除
    'convertCandidateToMember',     // 候補者→正式メンバーへの登録
  ]
  // 代表は関数冒頭の if (isDaihyo) return でここに到達しないため、
  // このブロックに到達した時点で非代表が確定している。
  // isActingFullAdmin_ は使わない（restricted_roles 依存で穴が開くため）。
  if (daihyoOnly.indexOf(action) >= 0) {
    if (checkPermissionOverride_(acting, action, body)) return
    throw userError_('この操作は代表のみ実行できます。')
  }

  // --- updateSetting / Webhook URL設定: 団体ごとに isActingFullAdmin_ (=
  // restricted_roles に含まれないロール) であれば許可。「事業責任者を代表と
  // 同格にするか」は団体ごとのrestricted_roles設定で選べるようにするため、
  // daihyoOnly固定ではなくこちらを使う。
  if (action === 'updateSetting' || action === 'updateRoles' || action === 'deleteRole' ||
      action === 'updateDepartments' || action === 'deleteDepartment' || action === 'moveDepartmentTasks' || action === 'restoreTask' || action === 'purgeTask' || action === 'unarchiveTasks' || action === 'updateDiscordWebhookUrl' || action === 'updateSlackWebhookUrl' || action === 'testDiscordWebhook' || action === 'testSlackWebhook' || action === 'getWebhookStatus' || action === 'getMailQuotaStatus' || action === 'getGasUpdateStatus' || action === 'updateProjectHealth' || action === 'revokeMemberSessions') {
    if (isActingFullAdmin_(acting)) return
    if (checkPermissionOverride_(acting, action, body)) return
    throw userError_('この操作は代表または全権管理者のみ実行できます。')
  }

  // --- 代表 or 班長 (任意の管理者ロール) ---
  var daihyoOrLeader = [
    'approveTask',          // タスク承認
    'updateJudgment',       // 評価タグの編集（管理者権限）
    'assignTask',           // タスクのアサイン
    'updateTaskDetails',    // タスク詳細編集
    'updateVisibility',     // タスク公開範囲の変更
    'updateReviewer',       // レビュアー設定
    'updateReviewers',      // レビュアー設定（複数）
    'removeTask',           // タスク削除
    'createProject',        // プロジェクト作成
    'updateProjectDetails', // プロジェクト詳細編集
    'updateProjectOwner',   // オーナー変更
    'updateProjectParent',  // 親プロジェクト変更
    'updateProjectArchived',// アーカイブ操作
    'updateProjectMembers', // プロジェクトメンバー管理
    // updateMemberProjects は daihyoOnly に移動（下記参照）
    'updatePriority',       // 優先度（管理者が設定するケースが主）
    'updateDifficulty',     // 難易度（管理者が設定するケースが主）
    'updateSchedule',       // 日程設定
    'updateDependsOn',      // 依存関係設定
    'setBlocker',           // ブロッカー設定（班長が管理）
    'rejectTask',           // タスクの却下(タスクを消し、作成者に知らせる)
    'notifyProjectHealth',  // item 26: プロジェクト健康状態の自動判定変化通知
    'updateProjectHealthRecord', // item 26(追補): attention回復時の記録更新（通知なし）
    'reportProjectHealth',  // 健康状態の自動判定の結果(複数プロジェクト)の記録と、まとめた通知
    'updateSearchProfile',  // 人材検索プロフィール（HR管理者が設定）
    'awardSkillPoints',     // スキルポイント付与（管理者操作）
    'approveExpenseStep',   // 経費承認（管理者操作）
    'rejectExpense',        // 経費却下（管理者操作）
    'returnExpense',        // EXP-008: 経費差し戻し（管理者操作）
    'approveFormStep',      // フォーム承認（管理者操作）
    'rejectFormSubmission', // フォーム却下（管理者操作）
    'bulkUpdateSkills',          // スキル一括更新（管理者操作）
    'updateMemberInactive',      // 活動休止/再開（管理者操作）
    'updateMemberDepartmentPath',// 組織パス設定（管理者操作）
    'updateEvaluationHistory',   // 評価履歴（班長は担当メンバーのみ）
    'updateTransferHistory',     // 異動履歴（班長は担当メンバーのみ）
    'updateOneOnOnes',           // 1on1記録（班長は担当メンバーのみ）
    'updateCompetencies',        // コンピテンシー評価（班長は担当メンバーのみ）
    'triggerOverdueReminders',   // NTF-005: 期限超過リマインドの手動発火
    'uploadSurveyImage',         // FRM-007: アンケート設問の画像は管理者操作
    'fetchDailyReports',         // REP-005: 日報・週報の閲覧は管理者操作
  ]
  if (daihyoOrLeader.indexOf(action) >= 0) {
    // 一般ロールでも、未アサインのタスクに自分だけを追加する「自己アサイン」
    // （taskDrawerの「このタスクを担当する」／公募タブの「応募する」）に限り許可する。
    // 既存の担当者変更・他人の追加・複数人同時追加は引き続き代表/管理者限定のまま。
    if (action === 'assignTask' && !isLeader) {
      var atTask = null
      try { atTask = authFindRow_(SHEET_TASKS, String(body.taskId || '')) } catch (e) {}
      var atCurrentAssignees = atTask
        ? String(atTask.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
        : []
      var atRequested = (body.assigneeIds || []).map(String)
      var isSelfClaim =
        atCurrentAssignees.length === 0 &&
        atRequested.length === 1 &&
        atRequested[0] === acting.id
      if (isSelfClaim) return
    }
    if (!isLeader) {
      // ロールで弾かれた場合でも permission_overrides_json に該当する例外があれば許可（OR条件）
      if (checkPermissionOverride_(acting, action, body)) return
      throw userError_('この操作は代表または管理者（班長以上）のみ実行できます。')
    }
    // 承認ステップの担当者チェック（代表は上で return 済みなので班長のみ到達）
    if (action === 'approveExpenseStep' || action === 'approveFormStep') {
      var approverCheckPassed = false
      try {
        if (action === 'approveExpenseStep') {
          var expSheet = ensureExpensesSheet_()
          var expFound = findExpenseRow_(expSheet, String(body.applicationId || ''))
          if (expFound) {
            var expSteps = JSON.parse(String(expFound.data[expFound.headers.indexOf('approval_steps_json')] || '[]'))
            var expIdx = Number(expFound.data[expFound.headers.indexOf('current_step_index')]) || 0
            var expStep = expSteps[expIdx]
            if (expStep) {
              if (expStep.type === 'member' && expStep.memberId === acting.id) approverCheckPassed = true
              if (expStep.type === 'role' && sameRole_(getRoles_(), expStep.role, acting.role)) approverCheckPassed = true
            }
          }
        } else {
          var fmSheet = ensureFormSubmissionsSheet_()
          var fmFound = findFormSubmissionRow_(fmSheet, String(body.submissionId || ''))
          if (fmFound) {
            var fmIdx = Number(fmFound.data[fmFound.headers.indexOf('current_step_index')]) || 0
            var fmId = String(fmFound.data[fmFound.headers.indexOf('form_id')] || '')
            var fmDefs = []
            try { var fmRaw = getSettingValue_('custom_form_defs'); if (fmRaw) fmDefs = JSON.parse(fmRaw) } catch(e2) {}
            var fmDef = fmDefs.filter(function(f) { return f.id === fmId })[0]
            var fmStepObj = fmDef ? (fmDef.approvalSteps || [])[fmIdx] : null
            if (fmStepObj) {
              if (fmStepObj.type === 'member' && fmStepObj.memberId === acting.id) approverCheckPassed = true
              if (fmStepObj.type === 'role' && sameRole_(getRoles_(), fmStepObj.role, acting.role)) approverCheckPassed = true
            }
          }
        }
      } catch(e) {}
      if (!approverCheckPassed) {
        if (checkPermissionOverride_(acting, action, body)) return
        throw userError_('この承認ステップの担当者ではありません。')
      }
    }

    // approveTask: importance に応じた承認者チェック（lib/ohsumi/permissions.ts の canApproveTask と同じロジック）
    if (action === 'approveTask') {
      var taskForApprove = null
      try { taskForApprove = authFindRow_(SHEET_TASKS, String(body.taskId || '')) } catch(e) {}
      if (taskForApprove) {
        var taskImportance = normalizeCode_('importance', taskForApprove.importance)
        if (taskImportance === 'important' || taskImportance === 'external') {
          // escalated: 全権管理者（isFullAdmin）のみ承認可能
          if (!isActingFullAdmin_(acting)) {
            if (checkPermissionOverride_(acting, action, body)) return
            throw userError_('重要度が「重要」または「対外公開」のタスクは、全権管理者のみ承認できます。')
          }
        } else {
          // non-escalated: タスク登録者の上長（creator の reports_to_id）のみ承認可能
          if (!isActingFullAdmin_(acting)) {
            var creatorId = String(taskForApprove.creator_id || '').trim()
            var approverId = ''
            if (creatorId) {
              try {
                var creatorRow = authFindRow_(SHEET_MEMBERS, creatorId)
                approverId = String(creatorRow.reports_to_id || '').trim()
              } catch(e) {}
            }
            if (approverId && acting.id !== approverId) {
              if (checkPermissionOverride_(acting, action, body)) return
              throw userError_('このタスクの承認者として指定されていないため、承認できません。')
            }
          }
        }
      }
    }

    // 班長（代表以外の管理者）はプロジェクトスコープに制限する。
    // acting.project_ids に対象プロジェクトが含まれなければ permission_overrides でのみ許可。
    var actingProjectIds = acting.project_ids ? String(acting.project_ids).split(',').map(function(s) { return s.trim() }).filter(Boolean) : []
    if (actingProjectIds.length > 0) {
      // 対象プロジェクトIDを特定する
      var targetProjectId = null
      if (body.projectId) {
        // プロジェクト操作（createProject/updateProjectDetails/updateProjectMembers 等）
        targetProjectId = String(body.projectId)
      } else if (body.taskId) {
        // タスク操作: タスクの project_id を引く
        try {
          var taskObj = authFindRow_(SHEET_TASKS, String(body.taskId))
          if (taskObj) targetProjectId = String(taskObj.project_id || '')
        } catch(e) {}
      }
      // project_id が特定できた場合のみスコープチェック（特定できない操作は通過させる）
      if (targetProjectId && actingProjectIds.indexOf(targetProjectId) < 0) {
        if (checkPermissionOverride_(acting, action, body)) return
        throw userError_('この操作は担当プロジェクトの範囲内でのみ実行できます。')
      }

      // updateSearchProfile は本人であればスコープ制限なしで許可
      if (action === 'updateSearchProfile' && body.memberId && acting.id === String(body.memberId)) return

      // メンバーを対象とするアクションのスコープチェック:
      // acting.project_ids に含まれるプロジェクトの member_ids を Projects シートから取得し、
      // 対象メンバーがそのいずれかに含まれるかで判定する（一般メンバーの project_ids は空欄設計のため）。
      var memberScopeActions = ['updateJudgment', 'updateSearchProfile', 'updateMemberInactive', 'updateMemberDepartmentPath', 'bulkUpdateSkills', 'updateEvaluationHistory', 'updateTransferHistory', 'updateOneOnOnes', 'updateCompetencies']
      if (memberScopeActions.indexOf(action) >= 0) {
        // acting.project_ids 配下の Projects を1回読んで所属メンバーIDのセットを作る
        var scopedMemberIdSet = {}
        try {
          var projectsSheet = getSheet_(SHEET_PROJECTS)
          var pHeaders = headerRow_(projectsSheet)
          var pIdCol = pHeaders.indexOf('id')
          var pMemberIdsCol = pHeaders.indexOf('member_ids')
          if (pIdCol >= 0 && pMemberIdsCol >= 0 && projectsSheet.getLastRow() > 1) {
            var pRows = projectsSheet.getRange(2, 1, projectsSheet.getLastRow() - 1, pHeaders.length).getValues()
            pRows.forEach(function(row) {
              var pid = String(row[pIdCol] || '').trim()
              if (actingProjectIds.indexOf(pid) >= 0) {
                var mids = String(row[pMemberIdsCol] || '').split(',').map(function(s) { return s.trim() }).filter(Boolean)
                mids.forEach(function(mid) { scopedMemberIdSet[mid] = true })
              }
            })
          }
        } catch(e) { /* Projects シート読み込み失敗時は scopedMemberIdSet が空のまま → 全件拒否（安全側） */ }

        // チェック対象の memberId 一覧を取得
        var memberIdsToCheck = []
        if (action === 'bulkUpdateSkills') {
          var bUpdates = body.updates || []
          bUpdates.forEach(function(u) { if (u && u.memberId) memberIdsToCheck.push(String(u.memberId)) })
        } else if (body.memberId) {
          memberIdsToCheck.push(String(body.memberId))
        }

        for (var mi = 0; mi < memberIdsToCheck.length; mi++) {
          if (!scopedMemberIdSet[memberIdsToCheck[mi]]) {
            if (checkPermissionOverride_(acting, action, body)) return
            throw userError_('この操作は担当プロジェクトのメンバーにのみ実行できます。')
          }
        }
      }
    }
    return
  }

  // --- 本人 or 管理者 (selfOrAdmin) ---
  // これらのアクションは本人が自分の情報を編集するか、管理者が代理編集する。
  var selfOrAdmin = [
    'updateSkillLevels',    // 本人・管理者双方が編集可（タスク完了時に自動登録も）
    'updateCareerGoals',    // 本人・管理者双方が編集可
    'updateDevelopmentPlan',// 本人・管理者双方が編集可
    'updateCareerHistory',  // 本人が主体だが管理者も修正可（安全側: 本人or管理者）
    'updateQualifications', // 本人が主体だが管理者も修正可（安全側: 本人or管理者）
    'importPortableRecord', // 他団体からの実績持ち込みは本人が主体（管理者も代理可）
    'updateTrainingHistory',// 本人が申請、管理者が更新（ステータス変更）
    'notifyTrainingRequest',// 本人が申請するが念のため本人or管理者に制限
    'updateEducationInfo',  // 大学名・学部・学科・学年は本人・管理者双方が編集可
    'updateCustomFields',   // 人材DBのカスタム列は本人・管理者双方が編集可
  ]
  if (selfOrAdmin.indexOf(action) >= 0) {
    var targetId = String(body.memberId || '')
    if (targetId !== acting.id && !isLeader) {
      throw userError_('この操作は本人または管理者のみ実行できます。')
    }
    return
  }

  // --- 本人のみ (selfOnly) ---
  var selfOnly = [
    'updateWill',            // 得意分野・希望タグは本人のみ
    'updateNotify',          // 通知設定は本人のみ
    'updateNotifySettings',  // 通知設定詳細は本人のみ
    'updateAvatar',          // アイコン変更は本人のみ
    'uploadAvatar',          // 画像アップロードは本人のみ
    'updateDisplayName',     // 表示名変更は本人のみ
    'updateUnavailableDates',// 稼働不可日は本人のみ
    'updateAbsentDates',    // 不在日は本人のみ
    'updateAvailableHours', // CAL-009: 稼働可能時間帯は本人のみ
    'updateTimezone',       // タイムゾーン設定は本人のみ
    'updateLocale',         // 表示言語設定は本人のみ
  ]
  if (selfOnly.indexOf(action) >= 0) {
    var selfTargetId = String(body.memberId || '')
    if (selfTargetId !== acting.id) {
      throw userError_('この操作は本人のみ実行できます。')
    }
    return
  }

  // --- ログイン済みなら誰でも ---
  var anyLoggedIn = [
    'createTasks',
    'updateTaskStatus',      // 担当者チェックあり（下記）
    'updateProgress',
    'updateComments',
    'updateEstimatedHours',
    'updateActualHours',
    'updateRetrospective',
    'updateTaskSchedule',
    'notifyScheduleResult',
    'updateTaskForm',
    'notifyFormResult',
    'updateHistory',
    'updateDeliverables',
    'setHoldReason',           // 保留理由の設定は担当者(または管理者)が本人操作
    'submitQuizResult',        // 検定の受験はログイン済み誰でも
    'submitExpenseApplication',// 経費申請はログイン済み誰でも
    'withdrawExpense',         // 取り下げは本人（下層でチェック）
    'resubmitExpense',         // EXP-008: 再提出は本人（下層でチェック）
    'uploadExpenseReceipt',    // EXP-003: 領収書アップロードはログイン済み誰でも
    'submitCustomForm',        // フォーム申請はログイン済み誰でも
    'submitDailyReport',       // REP-004: 日報・週報の保存はログイン済み誰でも
    'updateLastLogin',         // ログイン日時更新は誰でも（本人のみ実質的）
    'translateText',           // 自由入力テキストの自動翻訳は読み取り専用、誰でも
    'submitSurveyResponse',    // アンケート回答の送信はログイン済み誰でも（本人のみ実質的）
    'approveTaskReview',       // 複数確認者の承認（本人が確認者かどうかは下記でチェック）
    'checkAndGenerateRecurringTasks', // item 2/TSK-051: 生成はルール定義に従うだけなので誰でも呼べる
    'applyToOpenBid',          // TSK-027: 担当者未定タスクへの自己応募。既存の自己アサインと同等の緩さでよい
    'getMyStorage',            // 本人だけの保存を読む・書く(常に acting.id の分だけ)
    'setMyStorage',
    'getMyEmails',             // 自分自身のメールを読むだけ(常にacting.id基準、bodyのmemberIdは見ない)なので誰でも呼べる
    'getExpenses',             // 経費申請の読み取り。閲覧できる申請だけを返す(canViewExpense で絞り込む)
    'getCandidates',           // 採用の候補者の読み取り。採用の権限が無い人には何も返さない(canViewRecruiting)
    'getFormSubmissions',      // フォームの回答の読み取り。閲覧できる回答だけを返す(canViewFormSubmission で絞り込む)
    'getFiles',                // アップロードしたファイルの取得。種類ごとの権限を getFiles 内で確認する
    'getBackgroundData',       // 裏での読み込み(経費・フォームの回答・候補者・自分のメール)。中身はそれぞれ上の読み取りと同じ確認を通す
    'revokeMySessions',        // 全端末でログアウト(常に acting.id が対象、body の memberId は見ない)
    'getInviteMailStatus',     // ほかの端末で開く: 本人あてのメールを送れるか(常に acting.id が対象)
    'sendInviteLinkToMe',      // ほかの端末で開く: 本人の登録済みのアドレスにだけ招待リンクを送る(宛先は受け取らない)
    'reportClientError',       // 画面のエラーの記録(日時・操作の名前・エラーの種類だけ。1人1時間の上限あり)
    'approveSkillLevel',       // スキルのレベルの承認。代表と、その人を見る立場の人だけ・自分には不可(approveSkillLevel_ で確かめる)
    'getOrgStorage',           // 団体の保存。キーごとに決めた役職だけが読める(getOrgStorage_ で確かめる)
    'setOrgStorage',           // 団体の保存。キーごとに決めた役職だけが書ける(setOrgStorage_ で確かめる)
    'searchArchivedTasks',     // 移したタスクの検索。見てよいタスクだけを返す(canViewTaskRow_ で絞り込む)
  ]
  if (anyLoggedIn.indexOf(action) >= 0) {
    // updateTaskStatus: 全権管理者は制限なし。「完了」は確認者のみ可。それ以外は担当者のみ可。
    if (action === 'updateTaskStatus') {
      if (!isActingFullAdmin_(acting)) {
        var taskId = String(body.taskId || '')
        var task = authFindRow_(SHEET_TASKS, taskId)
        if (body.status === 'done') {
          // 「完了」への変更は確認者（reviewer_id / reviewer_ids）のみ許可
          var reviewerAllowed = false
          if (task) {
            var reviewerIdsRaw = String(task.reviewer_ids || task.reviewer_id || '').trim()
            var reviewerIdList = reviewerIdsRaw.split(',').map(function(s) { return s.trim() }).filter(Boolean)
            if (reviewerIdList.indexOf(acting.id) >= 0) reviewerAllowed = true
          }
          if (!reviewerAllowed) {
            throw userError_('担当者は「完了」に変更できません。確認者または管理者に依頼してください。')
          }
        } else {
          // 「完了」以外のステータス変更は担当者のみ許可
          if (task) {
            var assigneeIds = String(task.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
            if (assigneeIds.length > 0 && assigneeIds.indexOf(acting.id) < 0) {
              throw userError_('このタスクの担当者のみステータスを変更できます。')
            }
          }
        }
      }
    }
    if (action === 'approveTaskReview') {
      if (!isActingFullAdmin_(acting)) {
        var taskForApproval = authFindRow_(SHEET_TASKS, String(body.taskId || ''))
        var approvalReviewerIds = taskForApproval
          ? String(taskForApproval.reviewer_ids || taskForApproval.reviewer_id || '').split(',').map(function(s){return s.trim()}).filter(Boolean)
          : []
        if (approvalReviewerIds.indexOf(acting.id) < 0) {
          throw userError_('このタスクの確認者ではないため承認できません。')
        }
      }
    }

    // 仕様変更(レビュー指摘対応1): updateComments は「タスクを閲覧できる人
    // なら誰でもコメント追加可」に緩和する(担当者・確認者・作成者に限らな
    // い)。閲覧可否はフロント(lib/ohsumi/types.ts の canSeeExecTasks /
    // store.tsx の visibleTasks)と同じ基準 = 幹部限定タスク
    // (visibility が幹部)は role が '一般' のメンバーには見えない、
    // それ以外は誰でも見える、をそのままGAS側で再現する。既存コメントの
    // 編集・削除は投稿者本人・全権管理者のみ(validateCommentsUpdate_)のまま。
    if (action === 'updateComments') {
      var ucTask = authFindRow_(SHEET_TASKS, String(body.taskId || ''))
      if (!ucTask) throw userError_('対象のタスクが見つかりません。')
      if (normalizeCode_('visibility', ucTask.visibility) === 'leaders' && !isAdminRoleRef_(getRoles_(), acting.role)) {
        throw userError_('この操作は幹部限定タスクを閲覧できるメンバーのみ実行できます。')
      }
      validateCommentsUpdate_(ucTask, body.comments, acting)
      return
    }

    // 公募への応募: 変えてよいのは、応募者の一覧に自分を足す・自分を外すことだけ(全権管理者は制限なし)
    if (action === 'applyToOpenBid') {
      var bidTask = authFindRow_(SHEET_TASKS, String(body.taskId || ''))
      if (!bidTask) throw userError_('対象のタスクが見つかりません。')
      if (!isActingFullAdmin_(acting)) {
        if (normalizeCode_('visibility', bidTask.visibility) === 'leaders' && !isAdminRoleRef_(getRoles_(), acting.role)) {
          throw userError_('この操作は幹部限定タスクを閲覧できるメンバーのみ実行できます。')
        }
        var splitIds = function (v) { return String(v || '').split(',').map(function (s) { return s.trim() }).filter(Boolean) }
        var beforeIds = splitIds(bidTask.open_bid_applicant_ids)
        var afterIds = (Array.isArray(body.applicantIds) ? body.applicantIds : []).map(String)
        var changed = beforeIds.filter(function (x) { return afterIds.indexOf(x) < 0 })
          .concat(afterIds.filter(function (x) { return beforeIds.indexOf(x) < 0 }))
        if (changed.some(function (x) { return x !== acting.id })) {
          throw userError_('公募の応募者は、自分の応募・取り下げだけを変えられます。')
        }
      }
      return
    }

    // 日程調整・フォーム: 担当者・確認者・作成者・全権管理者と、招待された人(自分の回答だけ。mergeAnswers_)
    if (action === 'updateTaskSchedule' || action === 'updateTaskForm') {
      var ansTask = authFindRow_(SHEET_TASKS, String(body.taskId || ''))
      if (!ansTask) throw userError_('対象のタスクが見つかりません。')
      var ansKind = action === 'updateTaskSchedule' ? 'schedule' : 'form'
      if (!isTaskOwner_(ansTask, acting) && answerInvitedIds_(ansTask, ansKind).indexOf(String(acting.id)) < 0) {
        throw userError_('この日程調整・フォームに招待されていないため、回答できません。')
      }
      return
    }

    // タスクに紐づく更新のうち、担当者・確認者・作成者・全権管理者のみに限るもの(TASK_OWNER_SCOPED_ACTIONS)
    if (TASK_OWNER_SCOPED_ACTIONS.indexOf(action) >= 0) {
      var tosTask = authFindRow_(SHEET_TASKS, String(body.taskId || ''))
      if (!tosTask) throw userError_('対象のタスクが見つかりません。')

      if (!isActingFullAdmin_(acting)) {
        var tosAssigneeIds = String(tosTask.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
        var tosReviewerIds = String(tosTask.reviewer_ids || tosTask.reviewer_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
        var tosCreatorId = String(tosTask.creator_id || '').trim()
        var tosAllowed =
          tosAssigneeIds.indexOf(acting.id) >= 0 ||
          tosReviewerIds.indexOf(acting.id) >= 0 ||
          (tosCreatorId && tosCreatorId === acting.id)
        if (!tosAllowed) {
          throw userError_('この操作はタスクの担当者・確認者・作成者・管理者のみ実行できます。')
        }
      }

      // updateHistory はクライアントが配列を丸ごと置き換える仕様のため、
      // 他人が記録した既存データを書き換え/削除できないか追加でチェックする
      // (所有者チェックを通っていても対象)。
      if (action === 'updateHistory') validateHistoryUpdate_(tosTask, body.history, acting)
      // 進捗の記録も配列を丸ごと置き換えるので、他人の記録を変え・消していないか確かめる
      if (action === 'updateProgress' && body.progressHistory !== undefined) validateProgressHistoryUpdate_(tosTask, body.progressHistory, acting)
    }

    return
  }

  // Unknown action — 安全側に倒して管理者限定（新しいactionが追加された際の保護）
  if (!isLeader) {
    // コメント: 未分類のactionは代表/班長のみに制限（新機能追加時の安全装置）
    throw userError_('この操作は代表または管理者のみ実行できます。(未分類のaction: ' + action + ')')
  }
}

