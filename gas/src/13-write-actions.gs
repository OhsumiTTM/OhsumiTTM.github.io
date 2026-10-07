// 1つの書き込みの操作を実行する(権限の確認・ロック・送り直しの確認は済んでいること)
function runWriteAction_(body, actingMember) {
  var result
  // レジストリから止めている機能の操作は断る(まとめて送られた時も、1つずつ)
  assertFeatureEnabled_(body.action)
  // 書き込みの競合チェック: 画面が開いた時点の版。記録の一覧の差分は、今のシートの一覧に当て直し、権限も確かめ直す
  setExpectedRowVersions_(body)
  if (body.listOps !== undefined && LIST_ACTIONS[body.action]) {
    expandListOps_(body, true)
    revalidateListWrite_(body, actingMember)
  }
  switch (body.action) {
    case 'createTasks':
      // F1: creator_id はクライアントの値ではなく認証済みの本人IDを使う
      prepareCreateTasks_(body.tasks, actingMember)
      result = createTasks_(body.tasks, actingMember.id, { allowImport: isAdminRoleRef_(getRoles_(), actingMember.role) })
      break
    case 'updateTaskStatus':
      // body.status は入口でコードにそろえている(normalizeRequestCodes_)
      ;(function () {
        var nextStatus = body.status
        // 担当者(確認する人でない人)が「完了」を選んだ時は、確認待ちにする(doneStatusFor_。10-authorize.gs)
        if (nextStatus === 'done') {
          var statusTask = findRow_(SHEET_TASKS, String(body.taskId || ''))
          if (statusTask && doneStatusFor_(statusTask, actingMember) === 'review') nextStatus = 'review'
        }
        result = updateTaskFields_(body.taskId, {
          status: sheetCode_('status', nextStatus),
          last_activity: todayStr_(),
          completed_date: nextStatus === 'done' ? todayStr_() : '',
        })
        if (nextStatus !== body.status && result && typeof result === 'object') result.status = nextStatus
        // 確認待ちは、確認する人(reviewTargets_)に知らせる
        if (nextStatus === 'review') notifyReview_(body.taskId)
      })()
      break
    case 'assignTask':
      result = updateTaskFields_(body.taskId, {
        assignee_id: checkActiveMembers_(body.assigneeIds, '担当者').join(','),
      })
      break
    case 'applyToOpenBid':
      // TSK-027: 公募タスクへの応募(承認制)。担当者(assignee_id)には
      // 触れず、応募者リストのみ更新する
      result = updateTaskFields_(body.taskId, {
        open_bid_applicant_ids: (body.applicantIds || []).join(','),
      })
      break
    case 'updatePriority':
      result = updateTaskFields_(body.taskId, { priority: sheetCode_('priority', body.priority) })
      break
    case 'updateDifficulty':
      result = updateTaskFields_(body.taskId, { difficulty: sheetCode_('difficulty', body.difficulty) })
      break
    case 'updateTaskDetails':
      result = updateTaskFields_(body.taskId, {
        title: body.name,
        description: body.description || '',
        project_id: body.projectId,
        department: sheetValue_('department', body.department),
        category: body.category,
        skills: (body.skills || []).join(','),
        difficulty: sheetCode_('difficulty', body.difficulty),
        priority: sheetCode_('priority', body.priority),
        visibility: sheetCode_('visibility', body.visibility),
        importance: sheetCode_('importance', body.importance),
        required_skill_levels_json: JSON.stringify(body.requiredSkillLevels || {}),
      })
      break
    case 'updateProgress':
      // TSK-010: progressPercent単独更新(スライダー操作)にも相乗りさせる。
      // body.text/body.progressHistoryが無い場合はその列に触れない
      // (updateTaskFields_/updateRowFields_は渡されたキーのみ部分更新する)
      var progressFields = { last_activity: todayStr_() }
      // 新しい進捗の記録の書いた人は、どの役職でも操作した本人にそろえる
      if (Array.isArray(body.progressHistory)) stampNewEntries_(body.progressHistory, taskProgressIds_(body.taskId), actingMember.id)
      if (body.text !== undefined) progressFields.progress_note = body.text
      if (body.progressHistory !== undefined) progressFields.progress_history_json = JSON.stringify(body.progressHistory)
      if (body.progressPercent !== undefined) progressFields.progress_percent = checkPercent_(body.progressPercent)
      result = updateTaskFields_(body.taskId, progressFields)
      break
    case 'translateText':
      result = translateTexts_(body.texts, body.targetLang, actingMember.id)
      break
    case 'updateWill':
      result = updateMemberFields_(body.memberId, { will_tags: (body.will || []).join(',') })
      try {
        var willMember = findRow_(SHEET_MEMBERS, body.memberId)
        var willName = willMember ? (willMember.display_name || willMember.name || '不明') : '不明'
        var willTags = (body.will || []).join('、') || '（なし）'
        var willSubject = '[Ohsumi] やりたいことが更新されました'
        var willBody = willName + 'さんのやりたいことが更新されました。\n\n' +
          '【登録されたやりたいこと】\n' + willTags + '\n\n' +
          'Ohsumiで、そのメンバーの個人ページを確認してください。'
        notifyAdmins_(willSubject, willBody)
        // チャンネルには Will の中身を流さない(団体の外の人が入っていることもあるため)
        notifyChat_('💡 ' + willName + 'さんがやりたいことを更新しました。Ohsumiで確認してください。')
      } catch (err) {
        console.error('updateWillの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
      }
      break
    case 'updateTimezone':
      result = updateMemberFields_(body.memberId, { timezone: checkTimezone_(body.timezone) })
      break
    case 'updateLocale':
      result = updateMemberFields_(body.memberId, { locale: checkLocale_(body.locale) })
      break
    case 'updateJudgment':
      result = updateMemberFields_(body.memberId, {
        judgment_tags: (body.judgment || []).join(','),
      })
      break
    case 'approveTask':
      result = updateTaskFields_(body.taskId, { approval_status: sheetCode_('approval', 'approved') })
      break
    case 'rejectTask':
      // タスクを消し、シートのタスクの作成者・名前で作成者に知らせる(理由は承認する人が書いたもの)
      result = rejectTask_(body.taskId, body.reason)
      break
    case 'removeTask':
      // 完了・確認待ちのタスクは、団体の経験の記録として残すので消さない
      ;(function () {
        var t = findRow_(SHEET_TASKS, String(body.taskId || ''))
        if (t && ['done', 'review'].indexOf(normalizeCode_('status', t.status)) >= 0) {
          throw userError_('完了・確認待ちのタスクは、団体の経験の記録として残すため削除できません。')
        }
      })()
      result = trashTask_(String(body.taskId || ''), actingMember.id)
      break
    case 'restoreTask':
      result = restoreTrashedTask_(String(body.taskId || ''))
      break
    case 'purgeTask':
      result = purgeTrashedTask_(String(body.taskId || ''))
      break
    case 'createProject':
      result = createProject_(body.name, body.description, body.type)
      break
    case 'removeProject':
      // タスク(完了したものも含む)や子プロジェクトがあるプロジェクトは消さない。終わったものはアーカイブにしてもらう
      assertProjectRemovable_(String(body.projectId || ''))
      result = removeProject_(body.projectId)
      break
    case 'removeMember':
      assertTopRemains_({ members: (function () { var m = {}; m[String(body.memberId)] = { removed: true }; return m })() })
      result = removeMember_(body.memberId, actingMember.id, Date.now())
      break
    case 'updateNotify':
      result = updateMemberFields_(body.memberId, {
        notify_new_task: body.notify ? 'TRUE' : 'FALSE',
      })
      break
    case 'updateNotifySettings':
      result = updateMemberFields_(body.memberId, {
        notify_settings: JSON.stringify(checkNotifySettings_(body.settings)),
      })
      break
    case 'updateRole':
      requireKnownRole_(body.role)
      assertTopRemains_({ members: (function () { var m = {}; m[String(body.memberId)] = { role: body.role }; return m })() })
      result = updateMemberFields_(body.memberId, { role: sheetRoleRef_(body.role) })
      break
    case 'updateRoles':
      result = updateRoles_(actingMember, body.roles)
      break
    case 'deleteRole':
      result = deleteRole_(actingMember, body.roleId, body.moveToRoleId)
      break
    case 'updateDepartments':
      result = updateDepartments_(body.departments)
      break
    case 'deleteDepartment':
      result = deleteDepartment_(body.departmentId)
      break
    case 'moveDepartmentTasks':
      result = moveDepartmentTasks_(body.fromDepartmentId, body.toDepartmentId || '')
      break
    case 'updatePermissionOverrides':
      result = updateMemberFields_(body.memberId, {
        permission_overrides_json: JSON.stringify(mapOverrideCodes_(body.overrides || [], sheetValue_)),
      })
      break
    case 'updateReportsTo':
      result = updateMemberFields_(body.memberId, { reports_to_id: checkReportsTo_(String(body.memberId || ''), body.reportsToId) })
      break
    case 'updateMentor':
      ;(function () {
        var mentor = checkActiveMember_(body.mentorId, 'メンター')
        if (mentor && mentor === String(body.memberId)) throw userError_('メンターに、自分自身は選べません。')
        result = updateMemberFields_(body.memberId, { mentor_id: mentor })
      })()
      break
    case 'updateDisplayName':
      result = updateMemberFields_(body.memberId, { display_name: body.displayName || '' })
      break
    case 'updateJoinedAt':
      result = updateMemberFields_(body.memberId, { joined_at: checkDate_(body.joinedAt, '所属を始めた日') })
      break
    case 'updateUnavailableDates':
      result = updateMemberFields_(body.memberId, {
        unavailable_dates: checkDateList_(body.dates, '稼働できない日').join(','),
      })
      break
    case 'updateAvailableHours':
      result = updateMemberFields_(body.memberId, {
        available_hours_json: body.hours ? JSON.stringify(body.hours) : '',
      })
      break
    case 'updateSchedule':
      result = updateTaskFields_(body.taskId, {
        start_date: checkDate_(body.startDate, '開始日'),
        due_date: checkDate_(body.deadline, '期限'),
      })
      notifyScheduleChange_(body.taskId)
      break
    case 'updateDependsOn':
      result = updateTaskFields_(body.taskId, {
        depends_on_ids: checkDependsOn_(String(body.taskId || ''), body.dependsOnIds || []).join(','),
      })
      break
    case 'updateVisibility':
      result = updateTaskFields_(body.taskId, {
        visibility: sheetCode_('visibility', body.visibility),
      })
      break
    case 'updateReviewer':
      result = updateTaskFields_(body.taskId, { reviewer_id: checkActiveMember_(body.reviewerId, '確認者') })
      break
    case 'updateReviewers':
      ;(function () {
        var reviewers = checkActiveMembers_(body.reviewerIds || [], '確認者')
        var required = checkRequiredApprovals_(body.requiredApprovals, reviewers.length)
        result = updateTaskFields_(body.taskId, {
          reviewer_ids: reviewers.join(','),
          reviewer_id: reviewers[0] || '',
          required_approvals: required === '' ? '' : String(required),
        })
      })()
      break
    case 'approveTaskReview':
      result = approveTaskReview_(body.taskId, actingMember.id, body.comment)
      break
    case 'setBlocker':
      result = updateTaskFields_(body.taskId, {
        blocker_note: body.note || '',
        blocker_since: body.note ? checkDate_(body.since, '困りごとの日') || todayStr_() : '',
      })
      break
    case 'setHoldReason':
      result = updateTaskFields_(body.taskId, {
        hold_reason_note: body.note || '',
        hold_reason_since: body.note ? checkDate_(body.since, '保留にした日') || todayStr_() : '',
      })
      break
    case 'updateDeliverables':
      // F5: javascript:等の危険なURLを保存させない
      ;(body.deliverables || []).forEach(function (d) {
        if (d && d.url && !isSafeHttpUrl_(d.url)) {
          throw userError_('成果物のURLは http または https で始まるURLのみ登録できます。')
        }
      })
      result = updateTaskFields_(body.taskId, {
        deliverables_json: JSON.stringify(body.deliverables || []),
      })
      break
    case 'updateHistory':
      // 新しい記録の、記録した人・日時は GAS が決める(既存の記録を変えていないことは authorizeAction_ で確かめた)
      stampNewHistoryEntries_(body.taskId, body.history, actingMember.id)
      result = updateTaskFields_(body.taskId, {
        history_json: JSON.stringify((body.history || []).map(sheetHistoryEntry_)),
      })
      break
    case 'updateComments':
      var commentsBefore = taskCommentIds_(body.taskId)
      // 新しいコメントの投稿者は、どの役職でも操作した本人にそろえる(代表も、ほかの人の名前では書けない)
      stampNewEntries_(body.comments, commentsBefore, actingMember.id)
      result = updateTaskFields_(body.taskId, {
        comments_json: JSON.stringify(body.comments || []),
      })
      // 新しいコメントのメンションに通知する(宛先・本文は、保存したコメントから GAS が決める)
      notifyNewMentions_(body.taskId, commentsBefore, body.comments || [], actingMember.id)
      // 返信と、メンションした相手のコメントを知らせる(元のコメントを書いた人・メンションされていた人・メンションした人)
      notifyNewReplies_(body.taskId, commentsBefore, body.comments || [], actingMember.id)
      break
    case 'updateEstimatedHours':
      result = updateTaskFields_(body.taskId, {
        estimated_hours: checkHours_(body.hours, '予定の工数'),
      })
      break
    case 'updateActualHours':
      result = updateTaskFields_(body.taskId, {
        actual_hours: checkHours_(body.hours, '実績の工数'),
      })
      break
    case 'updateRetrospective':
      result = updateTaskFields_(body.taskId, {
        retrospective_json: body.retrospective ? JSON.stringify(body.retrospective) : '',
      })
      break
    case 'updateTaskSchedule':
      ;(function () {
        // 回答は本人の分だけ変える(ほかの人の回答は今の保存のまま)。候補・招待は作成者などだけが変えられる
        var merged = mergeAnswers_(String(body.taskId || ''), 'schedule', body.schedule, actingMember)
        result = updateTaskFields_(body.taskId, {
          schedule_json: merged ? JSON.stringify(mapScheduleCodes_(merged, sheetCode_)) : '',
        })
      })()
      break
    case 'notifyScheduleResult':
      // 保存した回答が揃っている時だけ、1回だけ送る
      result = { sent: notifyScheduleResult_(body.taskId, actingMember.id) }
      break
    case 'updateTaskForm':
      ;(function () {
        var merged = mergeAnswers_(String(body.taskId || ''), 'form', body.form, actingMember)
        result = updateTaskFields_(body.taskId, { form_json: merged ? JSON.stringify(merged) : '' })
      })()
      break
    case 'notifyFormResult':
      result = { sent: notifyFormResult_(body.taskId, actingMember.id) }
      break
    case 'updateProjectMembers':
      result = updateProjectFields_(body.projectId, {
        member_ids: checkActiveMembers_(body.memberIds || [], 'プロジェクトのメンバー').join(','),
      })
      break
    case 'updateProjectOwner':
      result = updateProjectFields_(body.projectId, { owner_id: checkActiveMember_(body.ownerId, 'プロジェクトの責任者') })
      break
    case 'updateProjectParent':
      result = updateProjectFields_(body.projectId, { parent_id: checkProjectParent_(String(body.projectId || ''), body.parentId) })
      break
    case 'updateProjectDetails':
      result = updateProjectFields_(body.projectId, {
        name: body.name || '',
        description: body.description || '',
        type: body.type || '',
        goal: body.goal || '',
        start_date: checkDate_(body.startDate, '開始日'),
        end_date: checkDate_(body.endDate, '終了予定日'),
      })
      break
    case 'updateProjectArchived':
      result = updateProjectFields_(body.projectId, {
        archived: body.archived ? 'TRUE' : 'FALSE',
      })
      break
    case 'updateProjectHealth':
      result = updateProjectHealthOverride_(body.projectId, checkProjectHealth_(body.healthOverride, true))
      break
    case 'notifyProjectHealth':
      result = notifyProjectHealth_(body.projectId, checkProjectHealth_(body.health, false))
      break
    case 'reportProjectHealth':
      // 自動判定の結果を複数プロジェクト分まとめて受け取り、記録の更新と
      // 通知(1通にまとめる)をサーバー側で判断する
      result = reportProjectHealth_(body.items)
      break
    case 'updateProjectHealthRecord':
      // item 26(追補): 通知なしでlast_notified_health列だけを更新する
      // （attentionから回復した際、次回の再悪化を確実に再通知するため）
      result = updateProjectFields_(body.projectId, { last_notified_health: checkProjectHealth_(body.health, true) })
      break
    case 'updateAvatar':
      // choosing a color+initials avatar supersedes any uploaded picture
      checkAvatar_(body.avatarColor, body.initials)
      result = updateMemberFields_(body.memberId, {
        avatar_color: body.avatarColor || '',
        avatar_initials: body.initials || '',
        avatar_url: '',
      })
      break
    case 'uploadAvatar':
      result = uploadAvatar_(body.memberId, body.dataUrl, body.filename)
      break
    case 'addMember':
      if (body.role) requireKnownRole_(body.role)
      result = addMember_(body.name, body.email, body.affiliation, body.role)
      // 招待メールを送る(選んだ時だけ。宛先は登録したアドレス、リンクは GAS が作る)
      if (body.sendInvite) result.invite = sendMemberInvite_(result.id)
      break
    case 'addCandidate':
      checkCandidateFields_(body.candidate || {}, true)
      result = addCandidate_(body.candidate || {})
      break
    case 'updateCandidate':
      checkCandidateFields_(body.fields || {}, false)
      result = updateCandidate_(body.candidateId, body.fields || {})
      break
    case 'removeCandidate':
      result = removeCandidate_(body.candidateId)
      break
    case 'convertCandidateToMember':
      if (body.role) requireKnownRole_(body.role)
      result = convertCandidateToMember_(body.candidateId, body.role)
      if (body.sendInvite && result && result.memberId) result.invite = sendMemberInvite_(result.memberId)
      break
    case 'updateEducationInfo':
      checkEducationInfo_(body)
      result = updateMemberFields_(body.memberId, {
        university: body.university || '',
        faculty: body.faculty || '',
        department_name: body.departmentName || '',
        grade_year: body.gradeYear || '',
      })
      break
    case 'updateCustomFields':
      // フロント側（store.tsx）で既存値とマージ済みの完全なオブジェクトを送ってくる
      result = updateMemberFields_(body.memberId, {
        custom_fields_json: JSON.stringify(checkCustomFields_(body.customFields)),
      })
      break
    case 'updateEmail':
      setMemberEmail_(body.memberId, checkEmailList_(body.email))
      result = { updated: true }
      break
    case 'revokeMySessions':
      // 全端末でログアウト(自分): 世代番号を上げ、発行済みのセッションをすべて無効にする
      bumpSessionGeneration_(actingMember.id)
      result = { revoked: true }
      break
    case 'revokeMemberSessions':
      // 全端末でログアウト(管理者が他のメンバーに対して)
      if (!findRow_(SHEET_MEMBERS, String(body.memberId || ''))) throw userError_('メンバーが見つかりません。')
      bumpSessionGeneration_(String(body.memberId))
      result = { revoked: true }
      break
    case 'getInviteMailStatus':
      result = inviteMailStatus_(actingMember.id, Date.now())
      break
    case 'sendInviteLinkToMe':
      result = sendInviteLinkToMe_(actingMember.id, body, Date.now())
      break
    case 'getMyStorage':
      result = getMyStorage_(actingMember.id, body.keys)
      break
    case 'setMyStorage':
      result = setMyStorage_(actingMember.id, body.key, body.value)
      break
    case 'approveSkillLevel':
      result = approveSkillLevel_(actingMember, body.memberId, body.skill, body.level, body.reason)
      break
    case 'getOrgStorage':
      result = getOrgStorage_(actingMember, body.keys)
      break
    case 'setOrgStorage':
      result = setOrgStorage_(actingMember, body.key, body.value)
      break
    case 'searchArchivedTasks':
      result = searchArchivedTasks_(actingMember, body.query, body.memberId)
      break
    case 'unarchiveTasks':
      result = unarchiveTasks_(body.taskIds)
      break
    case 'getMyEmails':
      // 自分自身のメールのみ返す(actingMember.idはトークン検証済みなので、
      // クライアントが送るmemberIdを信用する必要が無い — 他人のメールを
      // 覗く抜け道にならない)
      result = { email: getMemberEmailValue_(actingMember.id) }
      break
    case 'updateSetting':
      // 役職の設定は updateRoles・deleteRole で変える(最上位の役職の確認があるため)。
      // 移行前の古いタブが今までの設定を書く場合だけ、以前と同じく受け付ける
      if (body.key === 'roles' || (hasRolesSetting_() && ROLE_SETTING_KEYS.indexOf(body.key) >= 0)) {
        throw userError_('役職の設定は、管理画面の役職の編集から変更してください。')
      }
      if (body.key === 'departments') throw userError_('領域の設定は、ADMIN の「タスクの設定」の「領域」から変更してください。')
      checkSettingValue_(body.key, body.value)
      result = updateSetting_(body.key, sheetSettingValue_(body.key, body.value))
      if (ROLE_SETTING_KEYS.indexOf(body.key) >= 0) invalidateRoles_()
      break
    case 'uploadOrgLogo':
      result = uploadOrgLogo_(body.dataUrl, body.filename)
      break
    case 'updateDiscordWebhookUrl':
      result = updateDiscordWebhookUrl_(body.url)
      break
    case 'updateSlackWebhookUrl':
      result = updateSlackWebhookUrl_(body.url)
      break
    case 'testDiscordWebhook':
      result = testDiscordWebhook_()
      break
    case 'getWebhookStatus':
      result = getWebhookStatus_()
      break
    case 'getMailQuotaStatus':
      result = mailQuotaStatus_()
      break
    case 'getBackupStatus':
      result = backupStatus_()
      break
    case 'listBackups':
      result = { status: backupStatus_(), backups: listBackups_(), keep: BACKUP_KEEP }
      break
    case 'createBackupNow':
      result = createBackupNow_(actingMember.id, Date.now())
      break
    case 'previewRestore':
      result = previewRestore_(body.backupId)
      break
    case 'searchBackupTasks':
      result = searchBackupTasks_(body.backupId, body.query)
      break
    case 'restoreBackup':
      result = restoreBackup_(body.backupId, actingMember.id, Date.now())
      break
    case 'restoreTasks':
      result = restoreTasks_(body.backupId, body.taskIds, actingMember.id, Date.now())
      break
    case 'getPersonalDataStatus':
      result = personalDataStatus_(Date.now())
      break
    case 'setPersonalDataRetention':
      result = setPersonalDataRetention_(body.days, actingMember.id)
      break
    case 'purgePersonalDataNow':
      result = purgePersonalDataNow_(String(body.kind) === 'candidate' ? 'candidate' : 'member', body.id, actingMember.id, Date.now())
      break
    case 'extendPersonalData':
      result = extendPersonalData_(String(body.kind) === 'candidate' ? 'candidate' : 'member', body.id, actingMember.id, Date.now())
      break
    case 'cancelWithdrawal':
      result = cancelWithdrawal_(body.memberId, actingMember.id)
      break
    case 'deleteOrphanEmails':
      result = deleteOrphanEmails_(body.ids, actingMember.id)
      break
    case 'getMetricsStatus':
      result = metricsStatus_(Date.now())
      break
    case 'setMetricsSharing':
      result = setMetricsSharing_(body.enabled === true, actingMember.id, Date.now())
      break
    case 'getUsageStatus':
      result = usageStatus_(Date.now())
      break
    case 'reportClientError':
      result = { recorded: reportClientError_(body, actingMember.id) }
      break
    case 'getOpsStatus':
      result = { jobs: jobStatus_(Date.now()), sharing: readSharingState_(), longRecords: longRecordsNow_(), surveys: surveysStatus_(), disabledFeatures: disabledFeaturesForClient_() }
      break
    case 'recheckSharing':
      result = { jobs: jobStatus_(Date.now()), sharing: checkSharing_(Date.now()), surveys: surveysStatus_() }
      break
    case 'getGasUpdateStatus':
      result = gasUpdateStatus_()
      break
    case 'getAnnouncements':
      result = announcementsStatus_(Date.now())
      break
    case 'getDiagnostics':
      result = diagnosticsPreview_(Date.now())
      break
    case 'sendDiagnostics':
      result = sendDiagnostics_(body.diagId, Date.now())
      break
    case 'testSlackWebhook':
      result = testSlackWebhook_()
      break
    case 'updateMemberProjects':
      result = updateMemberFields_(body.memberId, {
        project_ids: (body.projectIds || []).join(','),
      })
      break
    case 'updateMemberInactive':
      if (body.inactive) assertTopRemains_({ members: (function () { var m = {}; m[String(body.memberId)] = { inactive: true }; return m })() })
      if (!body.inactive && String((findRow_(SHEET_MEMBERS, body.memberId) || {}).withdrawn_at || '')) {
        throw userError_('退会したメンバーは、休止の解除では戻せません。団体設定の「個人情報の削除」で、退会を取り消してください。')
      }
      result = updateMemberFields_(body.memberId, { inactive: body.inactive ? 'TRUE' : '' })
      // 休止中のメンバーもログイン・操作はできる(担当の候補・おすすめ・招待などからは外れる)。
      // ログインを止めるのは退会の時だけ
      break
    case 'updateMemberDepartmentPath':
      result = updateMemberFields_(body.memberId, { department_path: body.departmentPath || '' })
      break
    // ---- タレントマネジメント ----
    case 'updateSearchProfile':
      // 経験年数はjoinedAtからの自動計算に統一したため、years_of_experience
      // 列への書き込みは廃止(列自体は既存データ保持のためシートに残す)
      result = updateMemberFields_(body.memberId, {
        has_management_experience: body.hasManagementExperience ? 'TRUE' : 'FALSE',
        desired_areas: (body.desiredAreas || []).join(','),
        desired_skills: (body.desiredSkills || []).join(','), // DEV-002
      })
      break
    case 'updateCareerHistory':
      result = updateMemberFields_(body.memberId, {
        career_history_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateQualifications':
      result = updateMemberFields_(body.memberId, {
        qualifications_json: JSON.stringify(checkQualifications_(String(body.memberId || ''), body.entries || [], actingMember)),
      })
      break
    case 'updateEvaluationHistory':
      result = updateMemberFields_(body.memberId, {
        evaluation_history_json: JSON.stringify(stampEvaluators_(String(body.memberId || ''), body.entries || [], actingMember)),
      })
      break
    case 'updateTransferHistory':
      ;(body.entries || []).forEach(function (e) { if (e) checkDate_(e.date, '異動の日') })
      result = updateMemberFields_(body.memberId, {
        transfer_history_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateSkillLevels':
      result = updateMemberFields_(body.memberId, {
        skill_levels_json: JSON.stringify(checkSkillLevels_(String(body.memberId || ''), body.levels || [], actingMember)),
      })
      break
    case 'updateCompetencies':
      result = updateMemberFields_(body.memberId, {
        competencies_json: JSON.stringify(body.competencies || []),
      })
      break
    case 'updateCareerGoals':
      result = updateMemberFields_(body.memberId, {
        career_aspiration: body.careerAspiration || '',
        desired_future_role: body.desiredFutureRole || '',
        career_plan: body.careerPlan || '',
      })
      break
    case 'updateTrainingHistory':
      result = updateMemberFields_(body.memberId, {
        training_history_json: JSON.stringify(checkTrainingHistory_(String(body.memberId || ''), body.entries || [], actingMember)),
      })
      break
    case 'notifyTrainingRequest':
      // 研修の名前・状態は、保存した研修の記録(trainingId)から読む(画面が送る名前は使わない)
      result = { sent: notifyTrainingRequest_(body.memberId, body.trainingId, actingMember.id) }
      break
    case 'notifyTrainingDecision':
      result = { sent: notifyTrainingDecision_(body.memberId, body.trainingId, actingMember.id) }
      break
    case 'updateDevelopmentPlan':
      ;(body.entries || []).forEach(function (e) { if (e) checkDate_(e.targetDate, '目標の日') })
      result = updateMemberFields_(body.memberId, {
        development_plan_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateOneOnOnes':
      result = updateMemberFields_(body.memberId, {
        one_on_ones_json: JSON.stringify(stampOneOnOnes_(String(body.memberId || ''), body.entries || [], actingMember)),
      })
      break
    case 'awardSkillPoints':
      result = awardSkillPoints_(body.taskId, body.memberId, body.points || {}, actingMember)
      break
    case 'importPortableRecord':
      result = importPortableRecord_(body.memberId, body.skillPoints || {}, body.qualifications || [], actingMember)
      break
    case 'submitQuizResult':
      result = submitQuizResult_(body.quizId, body.memberId, body.answers || [], actingMember)
      break
    case 'submitExpenseApplication':
      result = saveExpenseApplication_(body.application, actingMember)
      break
    case 'approveExpenseStep':
      // actingMember.id を使うことでクライアントの自己申告値(body.actorId)による偽装を防ぐ
      result = processExpenseStep_(body.applicationId, body.stepId, actingMember.id, 'approved', body.comment)
      break
    case 'rejectExpense':
      result = setExpenseStatus_(body.applicationId, 'rejected', body.reason)
      break
    case 'withdrawExpense':
      result = setExpenseStatus_(body.applicationId, 'withdrawn', null, actingMember.id)
      break
    case 'returnExpense':
      result = setExpenseStatus_(body.applicationId, 'returned', body.reason)
      break
    case 'resubmitExpense':
      // actingMember.id を使うことでクライアントの自己申告値による偽装を防ぐ
      result = resubmitExpense_(body.applicationId, body.fields, actingMember.id)
      break
    case 'uploadExpenseReceipt':
      result = uploadExpenseReceipt_(body.dataUrl, body.filename)
      break
    case 'uploadSurveyImage':
      result = uploadSurveyImage_(body.dataUrl, body.filename)
      break
    case 'submitCustomForm':
      result = saveCustomFormSubmission_(body.submission, actingMember)
      break
    case 'approveFormStep':
      // actingMember.id を使うことでクライアントの自己申告値(body.actorId)による偽装を防ぐ
      result = processFormStep_(body.submissionId, body.stepId, actingMember.id, 'approved', body.comment)
      break
    case 'rejectFormSubmission':
      result = setFormSubmissionStatus_(body.submissionId, 'rejected', body.reason)
      break
    case 'submitDailyReport':
      result = saveDailyReport_(body.report, actingMember)
      break
    case 'getBackgroundData':
      result = getBackgroundData_(actingMember, body)
      break
    case 'getExpenses':
      result = getExpenses_(actingMember)
      break
    case 'getCandidates':
      result = getCandidates_(actingMember)
      break
    case 'getFormSubmissions':
      result = getFormSubmissions_(actingMember)
      break
    case 'getFiles':
      result = getFiles_(actingMember, body.fileIds)
      break
    case 'fetchDailyReports':
      result = fetchDailyReports_()
      break
    case 'bulkUpdateSkills':
      result = bulkUpdateSkillLevels_(body.updates || [])
      break
    case 'updateAbsentDates':
      result = updateMemberFields_(body.memberId, { absent_dates: checkDateList_(body.dates, '不在の日').join(',') })
      break
    case 'updateLastLogin':
      result = updateMemberFields_(body.memberId, { last_login: new Date().toISOString() })
      break
    case 'submitSurveyResponse':
      // actingMember.id を使うことでクライアントの自己申告値(body.memberId)による偽装を防ぐ
      result = saveSurveyResponse_(actingMember.id, body.answers || {})
      break
    case 'checkAndGenerateRecurringTasks':
      // item 2/TSK-051: クライアント側(誰かがOhsumiを開いた時)とサーバー側
      // 日次トリガー(dailyMaintenance)の両方からこの同じロック付き関数を
      // 呼ぶことで、定期タスクの二重生成を防ぐ
      result = generateRecurringTasksLocked_()
      break
    case 'triggerOverdueReminders':
      // NTF-005: 日次トリガー任せだった期限超過リマインドを、管理者が
      // 任意タイミングで手動発火できるようにする
      notifyOverdueTasksToAssignees_()
      result = { ok: true }
      break
    default:
      throw userError_('Unknown action: ' + body.action)
  }
  return result
}

