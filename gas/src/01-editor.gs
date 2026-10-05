// ============================================================================
// エディタから実行する関数(よく使う順)
// ============================================================================

// すべての表の版を新しくする(どの表が変わったか分からない時: 設定・毎日の処理・移行・手動の編集の一部など)
function bumpDataVersion() {
  bumpSnapshotVersion_()
  VERSIONED_TABLES.forEach(bumpTableVersion_)
}

// エディタから実行する: メールアドレス表のキャッシュを無効にする
// (トリガーが動かなかった場合など、ログインできないときの確認用)
function resetMemberEmailsCache() {
  bumpMemberEmailsVersion_()
  console.log('メールアドレス表のキャッシュを無効にしました(版: ' + getMemberEmailsVersion_() + ')')
}

// 秘密鍵を作り直す。発行済みのセッショントークンがすべて無効になり、全員が再ログインになる
function rotateSessionKey() {
  var props = PropertiesService.getScriptProperties()
  props.setProperty('SESSION_SIGNING_KEY', generateSecret_())
  props.setProperty('SESSION_KEY_ID', generateSecret_().slice(0, 8))
  resetRequestProps_()
  console.log('セッションの秘密鍵を作り直しました。全員のログインが無効になりました(次回の操作で再ログインになります)。')
}

// 今より前に発行されたセッショントークンをすべて無効にする(将来はレジストリからの指示で同じことを行う)
function revokeSessionsIssuedBefore() {
  setSessionNotBefore_(nowSec_())
}

// スクリプトプロパティ REVOKE_BEFORE_INPUT に書いた日時(ISO 形式 または 秒)より前に
// 発行されたセッショントークンを無効にする。エディタは引数を渡せないため、プロパティ経由で受け取る
function revokeSessionsIssuedBeforeInput() {
  var raw = String(PropertiesService.getScriptProperties().getProperty('REVOKE_BEFORE_INPUT') || '').trim()
  var sec = /^\d+$/.test(raw) ? Number(raw) : Math.floor(new Date(raw).getTime() / 1000)
  if (!raw || !(sec > 0)) throw new Error('REVOKE_BEFORE_INPUT に日時(例: 2026-10-01T09:00:00+09:00)を設定してから実行してください。')
  setSessionNotBefore_(sec)
}

// One-time setup: open this file in the Apps Script editor, select
// "setupDailyTrigger" in the function dropdown next to ▶ Run, and run it
// once. It installs a daily time-based trigger that drives
// generateRecurringTasksLocked_() and the overdue-task Discord sweep below.
// Safe to re-run — it clears any existing trigger for dailyMaintenance first
// so re-running it never creates duplicates that fire the same day twice.
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyMaintenance') ScriptApp.deleteTrigger(t)
  })
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(6).create()
}

// 段階③(手動実行): アップロード用フォルダと旧フォルダ内の「リンクを知っている
// 全員が閲覧可」のファイルを非公開にする。領収書を先に処理する。以後の新規
// アップロードも非公開になる(UPLOADS_PRIVATE)。extraFolderId を渡すと、
// そのフォルダも対象にする。実行時間の上限に近づいたら途中で止まり、ログに
// 再実行を促すメッセージを出す(何度実行しても問題ない)。
function makeUploadsPrivate(extraFolderId) {
  var props = PropertiesService.getScriptProperties()
  props.setProperty(UPLOADS_PRIVATE_PROPERTY_KEY, 'true')
  var folderIds = allowedUploadFolderIds_()
  if (extraFolderId && folderIds.indexOf(String(extraFolderId)) < 0) folderIds.push(String(extraFolderId))
  var deadline = Date.now() + 5 * 60 * 1000
  var changed = { receipt: 0, other: 0 }
  var finished = true
  // 1周目は領収書だけ、2周目はそれ以外
  ;['receipt', 'other'].forEach(function (pass) {
    if (!finished) return
    folderIds.forEach(function (folderId) {
      if (!finished) return
      var folder
      try { folder = DriveApp.getFolderById(folderId) } catch (e) {
        console.error('❌ フォルダを開けません: ' + folderId)
        return
      }
      var files = folder.getFiles()
      while (files.hasNext()) {
        if (Date.now() > deadline) { finished = false; return }
        var file = files.next()
        var isReceipt = uploadKindFromName_(file.getName()) === 'receipt'
        if ((pass === 'receipt') !== isReceipt) continue
        var access = file.getSharingAccess()
        if (access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE) {
          file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
          changed[pass]++
        }
      }
    })
  })
  var msg = '🔒 非公開にしたファイル: 領収書 ' + changed.receipt + ' 件、その他 ' + changed.other + ' 件'
  msg += finished ? '\n✅ すべて完了しました' : '\n⏳ 実行時間の上限に近づいたため途中で止めました。もう一度 makeUploadsPrivate() を実行してください'
  console.log(msg)
  return msg
}

// 確認用(手動実行): フォルダごと・種類ごとに、公開/非公開のファイル数を出力する
function auditUploadSharing(extraFolderId) {
  var folderIds = allowedUploadFolderIds_()
  if (extraFolderId && folderIds.indexOf(String(extraFolderId)) < 0) folderIds.push(String(extraFolderId))
  var lines = ['📋 アップロードファイルの共有設定 (新規アップロードの非公開化: ' +
    (PropertiesService.getScriptProperties().getProperty(UPLOADS_PRIVATE_PROPERTY_KEY) === 'true' ? '有効' : '無効') + ')']
  folderIds.forEach(function (folderId) {
    var counts = {}
    try {
      var files = DriveApp.getFolderById(folderId).getFiles()
      while (files.hasNext()) {
        var file = files.next()
        var kind = uploadKindFromName_(file.getName()) || 'unknown'
        var access = file.getSharingAccess()
        var isPublic = access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE
        counts[kind] = counts[kind] || { public: 0, private: 0 }
        counts[kind][isPublic ? 'public' : 'private']++
      }
    } catch (e) {
      lines.push('  ' + folderId + ': 開けません (' + e + ')')
      return
    }
    lines.push('  フォルダ ' + folderId + ':')
    Object.keys(counts).forEach(function (kind) {
      lines.push('    ' + kind + ': 公開 ' + counts[kind].public + ' / 非公開 ' + counts[kind].private)
    })
  })
  console.log(lines.join('\n'))
  return lines.join('\n')
}

// F4(レビュー再確認対応): auditFormulaInjectionRisks()とは別に、既存の
// 全行の保護対象列を書式なしテキスト(@)にするだけの関数。値は一切
// 変更しない(数式として評価されてしまっている値の復元は行わない —
// それはauditFormulaInjectionRisks(true)の役目)。
//
// updateRowFields_()は性能上の理由から書き込みのたびに書式を設定し直さ
// なくなったため(行の新規作成時にのみ設定する)、導入前から入っている
// 既存行のうち「現時点では危険な値になっていない行」は書式なしテキスト
// になっていない。この関数はそうした行も含めて対象列を丸ごと書式なし
// テキストにする(値の中身を一切見ないので、確認・レビューなしで何度
// でも安全に実行できる)。setupOhsumi()実行時にも自動的に呼ばれる。
function protectAllExistingRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var summary = []
  Object.keys(FORMULA_INJECTION_PROTECTED_COLUMNS).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName)
    if (!sheet) return
    var headers = headerRow_(sheet)
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName].forEach(function (colName) {
      var colIdx = headers.indexOf(colName)
      if (colIdx < 0) return
      sheet.getRange(2, colIdx + 1, lastRow - 1, 1).setNumberFormat('@')
      summary.push(sheetName + '.' + colName + '(' + (lastRow - 1) + '行)')
    })
  })
  console.log(
    '🔒 protectAllExistingRows: 値は変更せず、既存の全行を書式なしテキストにしました: ' +
    (summary.length > 0 ? summary.join(', ') : '対象シートがまだ存在しません'),
  )
}

// F4: 既存データの点検用。Apps Scriptエディタから手動で実行する。
//   auditFormulaInjectionRisks()      … 一覧表示のみ、何も変更しない(既定)
//   auditFormulaInjectionRisks(true)  … 見つかったセルを修正する(下記参照)
// 対象はFORMULA_INJECTION_PROTECTED_COLUMNSに挙げた全シート・全列。
// 「先頭が=+-@の値」に加え、既にSheets側で数式として評価されてしまって
// いるセル(getFormulas()が空でない)も対象にする。
//
// fix=trueの具体的な動作(値を変更しうる点でprotectAllExistingRows()とは
// 性質が異なる):
//   - まだ数式として評価されていない(表示上の文字列がそのまま=+-@で
//     始まっているだけの)セル: 書式を書式なしテキスト(@)にするのみ。
//     セルの表示内容(文字列そのもの)は変更しない。
//   - 既にSheets側で数式として評価されてしまっているセル: 書式なし
//     テキスト(@)にした上で、元の数式の文字列(例: "=1+1")をそのまま
//     リテラルな文字列として書き戻す。これによりセルの表示内容は
//     計算結果(例: "2")から元の入力文字列(例: "=1+1")に変わる
//     (=数式は実行されなくなるが、表示上の値は変化する)。
// 注意: 過去に実際に数式が評価されてしまっていた場合、その時点で
// IMPORTXML等による外部通信が発生していた可能性はこの関数では取り消せない
// (今後の再評価を防ぐことだけができる)。
function auditFormulaInjectionRisks(fix) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var found = []

  Object.keys(FORMULA_INJECTION_PROTECTED_COLUMNS).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName)
    if (!sheet) return
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return

    FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName].forEach(function (colName) {
      var colIdx = headers.indexOf(colName)
      if (colIdx < 0) return
      var range = sheet.getRange(2, colIdx + 1, lastRow - 1, 1)
      var values = range.getValues()
      var formulas = range.getFormulas()

      for (var i = 0; i < values.length; i++) {
        var display = String(values[i][0])
        var formula = formulas[i][0]
        var isRisky = /^[=+\-@]/.test(display) || !!formula
        if (!isRisky) continue

        var rowNumber = i + 2
        var idValue = idCol >= 0 ? sheet.getRange(rowNumber, idCol + 1).getValue() : ''
        found.push({
          sheet: sheetName,
          row: rowNumber,
          id: idValue,
          column: colName,
          value: formula || display,
          wasEvaluatedAsFormula: !!formula,
        })

        if (fix) {
          var literal = formula || display
          sheet.getRange(rowNumber, colIdx + 1).setNumberFormat('@').setValue(literal)
        }
      }
    })
  })

  if (fix) {
    console.log('🔧 auditFormulaInjectionRisks: ' + found.length + '件を書式なしテキストに修正しました。')
  } else {
    console.log('🔍 auditFormulaInjectionRisks: ' + found.length + '件の疑わしいセルが見つかりました(変更なし)。修正するには auditFormulaInjectionRisks(true) を実行してください。')
  }
  found.forEach(function (f) {
    console.log(
      '  - ' + f.sheet + ' 行' + f.row + ' (id=' + f.id + ') 列"' + f.column + '"' +
      (f.wasEvaluatedAsFormula ? ' [既に数式として評価済み]' : '') + ': ' + f.value,
    )
  })
  return found
}

// Shared recipient logic: notify_new_task=TRUE members, or every 代表 if
// nobody opted in. Best-effort — a mail failure is swallowed. When
// `preferredEmails` is given (item 9's "admin of admins" hierarchy — e.g. a
// task's assignee's reports_to_id) those are used instead, still falling
// back to the default set if none resolve to anything.
// デバッグ専用 — Apps Scriptエディタ上部の関数選択ドロップダウンで
// "debugNotifyTest" を選び、実行ボタンを押すと、Executions画面やCloudログを
// 開かなくても、エディタ下部の実行ログにその場で結果が表示される。
// Membersシートの列名/メールアドレス設定・MailAppの残り送信数を確認した上で、
// notifyAdmins_() を実際に一度呼び出してテストメールを送る。
function debugNotifyTest() {
  console.log('MailAppの残り送信可能数: ' + MailApp.getRemainingDailyQuota())
  console.log('org_notification_emails: ' + maskEmailsIn_(JSON.stringify(orgNotificationEmails_())))

  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  console.log('Membersシートのヘッダー: ' + headers.join(', '))

  var idCol = headers.indexOf('id')
  var notifyCol = headers.indexOf('notify_new_task')
  var roleCol = headers.indexOf('role')
  var emailMap = getAllMemberEmails_()
  console.log(
    'MemberEmails件数=' + Object.keys(emailMap).length +
    ', notify_new_task列index=' + notifyCol + ', role列index=' + roleCol,
  )

  if (Object.keys(emailMap).length === 0) {
    console.warn('MemberEmailsシートにメールが1件も登録されていません。個人ページの「アカウント設定」でメンバー各自が登録する必要があります。')
  } else if (idCol !== -1) {
    var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), headers.length).getValues()
    rows.forEach(function (r, i) {
      var mid = String(r[idCol])
      console.log(
        (i + 2) + '行目' +
          ': id=' + mid +
          ', email=' +
          JSON.stringify(maskEmailsIn_(emailMap[mid] || '')) +
          (notifyCol !== -1 ? ', notify_new_task=' + JSON.stringify(r[notifyCol]) : '') +
          (roleCol !== -1 ? ', role=' + JSON.stringify(r[roleCol]) : ''),
      )
    })
  }

  console.log('--- ここから notifyAdmins() を実行します（実際にメールが送信されます）---')
  notifyAdmins_('[Ohsumi] テスト通知', 'これは debugNotifyTest() からのテストメールです。届いていれば設定は正常です。', null, { urgent: true })
  console.log('debugNotifyTest: 完了 — 上記の宛先の受信トレイ（迷惑メールフォルダも）を確認してください')
}

// サンプルのデータを作る(テスト環境専用)。既にサンプルがあれば、消してから作り直す
function seedSampleData() {
  assertTestEnvironment_()
  var props = PropertiesService.getScriptProperties()
  var accounts = parseSampleTestAccounts_(props.getProperty('TEST_ACCOUNTS'))
  var emailSheet = getMemberEmailsSheet_()
  var emailRows = emailSheet.getLastRow() > 1 ? emailSheet.getRange(2, 1, emailSheet.getLastRow() - 1, 2).getValues() : []
  assertSampleAccountsUnregistered_(accounts, emailRows)

  if (getDiscordWebhookUrl_() || getSlackWebhookUrl_()) {
    console.warn('⚠ Discord・Slack の Webhook が設定されています。テスト環境では投稿せずログだけにします' +
      '(スクリプトプロパティ TEST_ALLOW_CHAT を true にすると、実際に投稿します)。')
  }

  return withSampleLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheetHeaders_(ss, name, SHEET_HEADERS[name]) })
    var removed = deleteSampleDataUnlocked_()

    var files = createSampleFiles_()
    var data = buildSampleData_(todayStr_(), files)
    var counts = {}
    // 選択肢の値は、今のシートの形式(移行の前は日本語、後はコード)で書く
    data.sheets[SHEET_TASKS] = (data.sheets[SHEET_TASKS] || []).map(sheetSampleTaskRow_)
    Object.keys(data.sheets).forEach(function (name) { counts[name] = appendSampleRows_(name, data.sheets[name]) })

    // テスト用のアカウントだけメールアドレスを登録する(他のサンプルのメンバーには登録しない)
    Object.keys(accounts).forEach(function (slot) {
      appendRowByHeaders_(emailSheet, SHEET_MEMBER_EMAILS, { id: SAMPLE_ACCOUNT_SLOTS[slot], email: accounts[slot] })
    })

    // 役職の設定(roles)を使っている団体では、サンプルの役職を roles に足す
    var sampleSettings = hasRolesSetting_() ? sampleSettingsWithRoles_(data.settings) : data.settings
    var merged = mergeSampleSettings_(readSettingsValues_(sampleSettingKeys_(sampleSettings)), sampleSettings)
    Object.keys(merged.values).forEach(function (k) { updateSetting_(k, sheetSettingValue_(k, merged.values[k])) })
    props.setProperty(SAMPLE_SETTINGS_STATE_KEY, JSON.stringify(merged.state))

    bumpDataVersion()
    bumpMemberEmailsVersion_()
    var assigned = Object.keys(accounts).map(function (slot) { return slot + ' → ' + SAMPLE_ACCOUNT_SLOTS[slot] + '(' + accounts[slot] + ')' })
    var msg = '🧪 サンプルのデータを作成しました(基準日: ' + todayStr_() + ')。' +
      Object.keys(counts).map(function (k) { return k + ' ' + counts[k] + ' 行' }).join('、') +
      '、ダミー画像 ' + Object.keys(files).length + ' 件。' +
      (assigned.length ? ' テスト用のアカウント: ' + assigned.join('、') : ' TEST_ACCOUNTS が未設定のため、ログインできるサンプルのメンバーはいません。') +
      (removed.Tasks || removed.Members ? '(前回のサンプルは削除してから作り直しました)' : '')
    console.log(msg)
    return msg
  })
}

// サンプルのデータを消し、Settings を元に戻す(テスト環境専用)
function deleteSampleData() {
  assertTestEnvironment_()
  return withSampleLock_(function () {
    var counts = deleteSampleDataUnlocked_()
    bumpDataVersion()
    bumpMemberEmailsVersion_()
    var msg = '🧹 サンプルのデータを削除しました: ' + Object.keys(counts).map(function (k) { return k + ' ' + counts[k] }).join('、') +
      '。Settings はサンプルの分を取り除き、団体名・ロゴ・テーマの色は元の値に戻しました。'
    console.log(msg)
    return msg
  })
}

// (テスト環境だけ)個人情報の削除を、期限を待たずに確かめる。スクリプトプロパティ TEST_DAYS_AHEAD(0〜400 の日数。
// 無ければ 0)だけ日付を進めた日時で、毎日の処理の「個人情報の削除」を実行する。実行ログに、進めた日時の
// 消す前の人・7日前の知らせ(○人分を○日に消します)・消した人・対応するメンバーがいないメールアドレスの行の数を出す
// (メールアドレスの行は、ここでも消さない)。手順は gas/README.md の「4.14」
function testPersonalDataPurge() {
  assertTestEnvironment_()
  var raw = PropertiesService.getScriptProperties().getProperty('TEST_DAYS_AHEAD')
  var days = raw === null || raw === '' ? 0 : Number(raw)
  if (!(days >= 0 && days <= 400)) throw userError_('TEST_DAYS_AHEAD は 0〜400 の日数にしてください。')
  var at = Date.now() + days * 24 * 3600 * 1000
  var before = personalDataStatus_(at)
  var done = purgeExpiredPersonalDataLocked_(at)
  var msg = '🧪 ' + days + ' 日後(' + new Date(at).toISOString() + ')として、個人情報の削除を実行しました。\n' +
    '・消す前の人(実行の前): ' + before.pending.map(function (p) { return p.kind + ':' + p.id + '(' + p.purgeAt + ' に消す)' }).join('、') + '\n' +
    '・7日前の知らせ: ' + (before.upcoming.map(function (u) { return u.count + '人分を ' + u.date + ' に消します' }).join('、') || 'なし') + '\n' +
    '・消したメンバー: ' + (done.members.join('、') || 'なし') + ' / 消した候補者: ' + (done.candidates.join('、') || 'なし') + '\n' +
    '・対応するメンバーがいないメールアドレスの行: ' + before.orphanEmails.length + ' 件(自動では消しません)'
  console.log(msg)
  return { at: new Date(at).toISOString(), before: before, done: done }
}

