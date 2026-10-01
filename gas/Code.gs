// Ohsumi — 団体の Apps Script(スプレッドシートの「データベース」の読み書き・ログイン・通知)
//
// 団体のスプレッドシートの「拡張機能」→「Apps Script」に、このファイルをそのまま貼り付け、ウェブアプリとして
// デプロイする(次のユーザーとして実行: 自分、アクセスできるユーザー: 全員)。手順は gas/README.md を参照。
// 画面(Ohsumi のサイト)は、読み取りも書き込みもこの GAS に POST で送る(doPost の action で分ける)。
//
// ■ エディタから実行する関数(関数の一覧から選んで ▶ 実行。上から、よく使う順)
//   setupOhsumi                     最初の設定・コードを貼り替えた後に実行する(シートの列・トリガー・ログインの鍵・
//                                   アップロード先を用意する。今のコードに無い関数を指すトリガーを消す)
//   bumpDataVersion                 スクリプト・Sheets API・アドオンでシートを書き換えた後に、読み取りのキャッシュを作り直させる
//   resetMemberEmailsCache          MemberEmails を直接書き換えた後に、メールアドレスのキャッシュを消す
//   rotateSessionKey                ログインの秘密鍵を作り直す(全員が再ログインになる)
//   revokeSessionsIssuedBefore      今より前に発行したログイン(セッション)をすべて無効にする
//   revokeSessionsIssuedBeforeInput スクリプトプロパティ REVOKE_BEFORE_INPUT の日時より前のログインを無効にする
//   setupDailyTrigger               毎朝の定期処理(dailyMaintenance)のトリガーを作り直す
//   migrateToInternalCodes          選択肢の値・役職・部門を内部コードに移す(MIGRATION_MODE で dryRun → apply)
//   migrationReport                 (Orbit からの移行)移行の前と後の数を実行ログに出し、前回と違う数を並べる(読み取りだけ)
//   renameOrbitCalendarEvents       (Orbit からの移行)カレンダーの「[Orbit] 」の予定を「[Ohsumi] 」に変える(CALENDAR_RENAME_MODE で dryRun → apply)
//   listChangesFromOrbit            (Orbit からの移行)元の Orbit と比べて、Ohsumi で変わった行を一覧にする(戻す時。読み取りだけ)
//   makeUploadsPrivate              アップロードしたファイル(画像・領収書)を非公開にする
//   auditUploadSharing              アップロードしたファイルの公開・非公開の件数を実行ログに出す
//   protectAllExistingRows          既存の行の、数式として読まれうる列を書式なしテキストにする(値は変えない)
//   auditFormulaInjectionRisks      数式として解釈されうるセルを点検する
//   debugNotifyTest                 通知メールの宛先の登録状況を実行ログに出し、テストメールを送る
//   seedSampleData                  (テスト環境だけ)画面確認用のサンプルのデータを入れる
//   deleteSampleData                (テスト環境だけ)サンプルのデータを消す
//   testPersonalDataPurge           (テスト環境だけ)TEST_DAYS_AHEAD 日だけ日付を進めて、個人情報の削除を実行する
//   measureReadPerformance          読み取りの所要時間とデータ量を計測する
//   seedPerformanceTestData         (テスト環境だけ)計測用のダミーデータを入れる
//   deletePerformanceTestData       (テスト環境だけ)計測用のダミーデータを消す
//   measureReadA・measureReadB・measureReadC・measureReadD
//                                   読み込み方式ごとに計測する(gas/README.md の「12.」)
//   showReadMeasurements            計測の記録を一覧する
//   clearReadMeasurements           計測の記録を消す
//
// ■ ほかから呼ばれる関数(名前を変えない)
//   doGet・doPost                   ウェブアプリの入口
//   onOpen                          スプレッドシートを開いた時に「Ohsumi」メニューを出す
//   registerWithRegistryFromMenu・regenerateInitialSetupCodeFromMenu  「Ohsumi」メニューから呼ばれる
//   sendBatchNotifications・dailyMaintenance・onSpreadsheetChange・onSpreadsheetEdit・checkContractStatus  トリガーから呼ばれる
//
// ■ そのほかの関数は、中で使うだけ。名前の最後に _ を付けて、エディタの「実行」の一覧に出ないようにしている
//   (_ を付けずに足すと lib/ohsumi/gas-functions.test.ts で止まる)

// 最初の設定。GASエディタ上部の関数ドロップダウンで "setupOhsumi" を選び、▶ 実行 を押す。
// これ一回で:
//   1. 今のコードに無い関数を指すトリガー(以前の版の名前のまま残ったもの)を消す
//   2. 全サービスの権限ダイアログをまとめて通す (Drive / Mail / Calendar / 等)
//   3. 各シートに不足しているヘッダー列を自動追加する（既存データは一切変更しない）
//   4. ログインの団体ID・秘密鍵、トリガー、画像アップロード用のDriveフォルダがなければ作る
//      （既にあれば何もしない）
//   5. 実行結果をエディタ下部のログに出力する
// コードを貼り替えた後にも実行する。再実行しても重複は起きない。
function setupOhsumi() {
  // 今のコードに無い関数を指すトリガー(以前の版の名前のまま残ったもの)を消す
  removeOrphanTriggers_()
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  console.log('📋 スプレッドシート: ' + ss.getName())

  // --- 権限の事前取得 ---
  try { DriveApp.getRootFolder(); console.log('✅ DriveApp') }
  catch (e) { console.error('❌ DriveApp: ' + e) }

  try { console.log('✅ MailApp (残り送信数: ' + MailApp.getRemainingDailyQuota() + ')') }
  catch (e) { console.error('❌ MailApp: ' + maskEmailsIn_(String(e))) }

  try { console.log('✅ CalendarApp: ' + CalendarApp.getDefaultCalendar().getName()) }
  catch (e) { console.error('❌ CalendarApp: ' + e) }

  try {
    UrlFetchApp.fetch('https://www.google.com', { method: 'get', muteHttpExceptions: true })
    console.log('✅ UrlFetchApp')
  } catch (e) { console.error('❌ UrlFetchApp: ' + e) }

  try { console.log('✅ ScriptApp (トリガー数: ' + ScriptApp.getProjectTriggers().length + ')') }
  catch (e) { console.error('❌ ScriptApp: ' + e) }

  try { PropertiesService.getScriptProperties().getProperties(); console.log('✅ PropertiesService') }
  catch (e) { console.error('❌ PropertiesService: ' + e) }

  // --- ヘッダー行の確認・追加 ---

  // すべてのシート(SHEET_HEADERS)を作成し、不足している列を追加する。
  // MemberEmailsは新規作成した場合デフォルトで非公開(「ウェブに公開」未設定)
  // なので、ここで作成するだけでMembersのemail列を分離した効果が出る。
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    ensureSheetHeaders_(ss, name, SHEET_HEADERS[name])
  })
  bumpMemberEmailsVersion_()

  // --- 選択肢の値の形式(新しく導入する団体は最初からコードで書く)---
  setupValueFormat_(ss)
  setupRolesSetting_()

  // --- ログイン(セッション)の団体ID・秘密鍵(無ければ作る。既にあれば変えない)---
  var createdSecrets = ensureSessionSecrets_()
  console.log(createdSecrets.length
    ? '🔑 ログイン用の設定を作成しました: ' + createdSecrets.join(', ')
    : '✅ ログイン用の設定(ORG_ID・秘密鍵)は作成済みです')

  // --- Settings の初期キーを確保（上書きはしない）---
  var DEFAULT_SETTINGS = [
    ['org_name', ''],
    ['org_logo_url', ''],
  ]
  var settingsSheet = ss.getSheetByName(SHEET_SETTINGS)
  var settingsData = settingsSheet.getLastRow() > 1
    ? settingsSheet.getRange(2, 1, settingsSheet.getLastRow() - 1, 1).getValues().map(function(r){ return String(r[0]) })
    : []
  DEFAULT_SETTINGS.forEach(function(pair) {
    if (settingsData.indexOf(pair[0]) === -1) {
      appendRowByHeaders_(settingsSheet, SHEET_SETTINGS, { key: pair[0], value: pair[1] })
      console.log('➕ Settings 初期キー追加: ' + pair[0])
    }
  })

  // --- バッチ通知トリガーの設定 ---
  try {
    var triggers = ScriptApp.getProjectTriggers()
    var hasBatch = triggers.some(function(t) { return t.getHandlerFunction() === 'sendBatchNotifications' })
    if (!hasBatch) {
      ScriptApp.newTrigger('sendBatchNotifications')
        .timeBased()
        .everyHours(1)
        .create()
      console.log('✅ sendBatchNotifications トリガー作成')
    } else {
      console.log('✅ sendBatchNotifications トリガー既存')
    }
    // 提供停止・機能停止の状態をレジストリに確かめる(R1-e。1時間ごと)
    var hasContract = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'checkContractStatus' })
    if (!hasContract) {
      ScriptApp.newTrigger('checkContractStatus').timeBased().everyHours(1).create()
      console.log('✅ checkContractStatus トリガー作成')
    } else {
      console.log('✅ checkContractStatus トリガー既存')
    }
  } catch (e) { console.error('❌ トリガー設定: ' + e) }

  // F4(レビュー再確認対応): シートを作り直したり列を追加したりした際、
  // 点検関数(protectAllExistingRows/auditFormulaInjectionRisks)の手動
  // 実行を忘れても既存行が保護されるよう、setupOhsumi()の実行時にも
  // 既存の全行の保護対象列を書式なしテキストにしておく(値は変更しない)。
  protectAllExistingRows()

  // --- スプレッドシートの手動編集で読み取りキャッシュを無効にするトリガー ---
  try {
    var changeTriggers = ScriptApp.getProjectTriggers()
    var hasChange = changeTriggers.some(function(t) { return t.getHandlerFunction() === 'onSpreadsheetChange' })
    if (!hasChange) {
      ScriptApp.newTrigger('onSpreadsheetChange').forSpreadsheet(ss).onChange().create()
      console.log('✅ onSpreadsheetChange トリガー作成')
    } else {
      console.log('✅ onSpreadsheetChange トリガー既存')
    }
    // セルの編集は、編集したシートの版だけを新しくする(どの表が変わったか分かるため)
    var hasEdit = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'onSpreadsheetEdit' })
    if (!hasEdit) {
      ScriptApp.newTrigger('onSpreadsheetEdit').forSpreadsheet(ss).onEdit().create()
      console.log('✅ onSpreadsheetEdit トリガー作成')
    } else {
      console.log('✅ onSpreadsheetEdit トリガー既存')
    }
    PropertiesService.getScriptProperties().setProperty('EDIT_TRIGGER_INSTALLED', 'true')
  } catch (e) { console.error('❌ 変更検知トリガー設定: ' + e) }
  bumpDataVersion()

  // --- 画像アップロード用フォルダ ---
  try { ensureUploadFolder_() }
  catch (e) { console.error('❌ アップロード用フォルダ: ' + e) }

  // --- 毎日・毎時の処理の見張り: ここから数え始める(まだ一度も動いていなくても、26時間は止まったと見なさない) ---
  try { recordJobsInstalled_(Date.now()) } catch (e) { console.error('❌ 処理の見張り: ' + e) }

  // --- スプレッドシート・フォルダの共有の確認 ---
  try {
    var sharing = checkSharing_(Date.now())
    if (sharing.problems.length) {
      console.warn('⚠️ 共有を直してください: ' + sharing.problems.map(sharingProblemText_).join(' / '))
    } else {
      console.log('✅ 共有: GAS のアカウントだけが編集でき、ほかの人には共有していません(代表の閲覧は許可)')
    }
  } catch (e) { console.error('❌ 共有の確認: ' + e) }

  console.log('🚀 setupOhsumi 完了')
}

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

function migrateToInternalCodes() {
  var props = PropertiesService.getScriptProperties()
  var mode = props.getProperty('MIGRATION_MODE') === 'apply' ? 'apply' : 'dryRun'
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(30000)) throw new Error('ほかの処理が実行中です。少し待ってからもう一度実行してください。')
  try {
    resetRequestProps_()
    var plan = planMigration_(readMigrationSnapshot_(), { topRoleName: props.getProperty('MIGRATION_TOP_ROLE_NAME') })
    formatMigrationReport_(plan, mode).forEach(function (line) { console.log(line) })
    if (mode !== 'apply') {
      console.log('dryRun のため、何も書き込んでいません。内容を確かめてから、スクリプトプロパティ MIGRATION_MODE を apply にして、もう一度実行してください。')
      return plan.report
    }
    if (plan.report.errors.length) throw new Error('エラーがあるため移行しませんでした。上のエラーを直してから、もう一度実行してください。')

    var copy = createPrivateBackupCopy_()
    console.log('💾 バックアップのコピーを作りました(誰とも共有していません): ' + copy.getName() + ' ' + copy.getUrl())
    console.log('⚠️ このコピーには Apps Script(GAS)も一緒に複製されていますが、コピーの GAS はデプロイしないでください(同じ団体のデータの窓口が2つになります)。')
    console.log('   移行の後、しばらく(目安: 1か月)問題がなければ、このコピーは削除して構いません。')

    applyMigrationPlan_(plan)
    updateSetting_('migrated_at', new Date().toISOString())
    props.setProperty('VALUE_FORMAT', 'codes')
    props.setProperty('MIGRATION_MODE', 'dryRun')
    resetRequestProps_()
    try { SpreadsheetApp.flush() } catch (e) { /* 実行の終了時にも確定する */ }
    bumpDataVersion()
    console.log('✅ 移行しました。VALUE_FORMAT=codes にし、MIGRATION_MODE を dryRun に戻しました。')
    console.log('   開いているタブは、再読み込みするまで GAS に断られます(「ページを再読み込みしてください」と表示されます)。')
    return plan.report
  } finally {
    lock.releaseLock()
  }
}

// Orbit からの移行(N1): 移行の前と後で数を比べるための点検(読み取りだけ。何も書き換えない)。
// 行数・ステータスや部門や役職ごとの件数・見つからない参照・ファイルの URL を数えて実行ログに出す。
// 値は日本語でも内部コードでも同じ数になるように、コードにそろえて数える(移行の前と後で比べられる)。
// 結果はスクリプトプロパティ MIGRATION_REPORT_LAST に覚え、次に実行した時に、前回と違う数だけを出す。
// 手順は docs/orbit-migration-plan.md の 8.
function migrationReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var tables = readReportTables_(ss)
  var allowed = allowedUploadFolderIds_()
  var deadline = Date.now() + 4 * 60 * 1000
  var fileOk = function (url) {
    if (Date.now() > deadline) return null
    var id = driveFileIdFromUrl_(url)
    if (!id) return false
    try { return isInAllowedFolder_(DriveApp.getFileById(id), allowed) } catch (e) { return false }
  }
  var report = buildMigrationReport_(tables, { roles: getRoles_(), departments: getDepartments_(), fileOk: fileOk })
  var props = PropertiesService.getScriptProperties()
  var previous = null
  try { previous = JSON.parse(props.getProperty(MIGRATION_REPORT_PROPERTY) || 'null') } catch (e) { previous = null }
  formatMigrationCounts_(report, previous).forEach(function (line) { console.log(line) })
  var saved = JSON.stringify({ at: new Date().toISOString(), spreadsheet: ss.getName(), counts: report.counts })
  if (saved.length < 9000) props.setProperty(MIGRATION_REPORT_PROPERTY, saved)
  else console.log('⚠️ 結果が大きいため、前回の結果として覚えませんでした(実行ログを保存して比べてください)')
  return report
}

// Orbit からの移行(N2): カレンダーの予定の名前を「[Orbit] タスク名」から「[Ohsumi] タスク名」に変える。
// Ohsumi は「[Ohsumi] タスク名」の予定を探して入れ替えるので、名前を変えないと Orbit が作った予定が残り、二重になる。
// 対象は、この GAS を実行するアカウントのカレンダーの、今日から2年先までの予定。
//   スクリプトプロパティ CALENDAR_RENAME_MODE: 無い(または dryRun)なら件数と例を出すだけ。apply で名前を変え、dryRun に戻す
//   スクリプトプロパティ CALENDAR_RENAME_DIRECTION: toOrbit にすると逆向き(戻す時。docs/orbit-migration-plan.md の 7.1)
function renameOrbitCalendarEvents() {
  var props = PropertiesService.getScriptProperties()
  var apply = props.getProperty('CALENDAR_RENAME_MODE') === 'apply'
  var toOrbit = props.getProperty('CALENDAR_RENAME_DIRECTION') === 'toOrbit'
  var from = toOrbit ? CALENDAR_PREFIX_OHSUMI : CALENDAR_PREFIX_ORBIT
  var to = toOrbit ? CALENDAR_PREFIX_ORBIT : CALENDAR_PREFIX_OHSUMI
  var start = new Date()
  start.setHours(0, 0, 0, 0)
  var end = new Date(start.getTime() + CALENDAR_RENAME_DAYS * 24 * 3600 * 1000)
  var events = CalendarApp.getDefaultCalendar().getEvents(start, end, { search: from.trim() })
  var targets = events.filter(function (ev) { return String(ev.getTitle()).indexOf(from) === 0 })
  console.log('「' + from.trim() + '」で始まる予定(今日から' + CALENDAR_RENAME_DAYS + '日): ' + targets.length + '件' + (apply ? '' : '(dryRun のため、名前は変えていません)'))
  targets.slice(0, 20).forEach(function (ev) {
    console.log('  ' + Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'yyyy-MM-dd') + ' ' + ev.getTitle() + ' → ' + to + String(ev.getTitle()).slice(from.length))
  })
  if (targets.length > 20) console.log('  …ほか ' + (targets.length - 20) + '件')
  if (!apply) {
    console.log('名前を変えるには、スクリプトプロパティ CALENDAR_RENAME_MODE を apply にして、もう一度実行してください。')
    return { count: targets.length, renamed: 0 }
  }
  targets.forEach(function (ev) { ev.setTitle(to + String(ev.getTitle()).slice(from.length)) })
  props.setProperty('CALENDAR_RENAME_MODE', 'dryRun')
  console.log('✅ ' + targets.length + '件の名前を変えました。CALENDAR_RENAME_MODE を dryRun に戻しました。')
  return { count: targets.length, renamed: targets.length }
}

// Orbit からの移行(N3): 戻す時のために、切り替えの後に Ohsumi で作られた・変わった・消えた行を一覧にする(読み取りだけ)。
// 元の Orbit のスプレッドシート(スクリプトプロパティ ORBIT_SPREADSHEET_ID)を読み、移行と同じ変換をしてから、今のシートと比べる。
// 値は日本語(Orbit に入れ直す形)で出す。メールアドレスは実行ログに出さない(変わったことだけを出す)。
// 手順は docs/orbit-migration-plan.md の 7.1
function listChangesFromOrbit() {
  var props = PropertiesService.getScriptProperties()
  var orbitId = String(props.getProperty('ORBIT_SPREADSHEET_ID') || '').trim()
  if (!orbitId) throw new Error('スクリプトプロパティ ORBIT_SPREADSHEET_ID に、元の Orbit のスプレッドシートの ID(URL の /d/ と /edit の間)を入れてから実行してください。')
  var orbit = readReportTables_(SpreadsheetApp.openById(orbitId))
  var current = readReportTables_(SpreadsheetApp.getActiveSpreadsheet())
  var roles = getRoles_()
  var converted = convertOrbitTables_(orbit, roles, props.getProperty('MIGRATION_TOP_ROLE_NAME'))
  var diff = diffMigrationTables_(converted, current)
  formatMigrationDiff_(diff, { roles: roles, departments: getDepartments_() }).forEach(function (line) { console.log(line) })
  return diff
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

// 段階①の計測用: Apps Script エディタで実行し、実行ログの結果を確認する。
// キャッシュなし(シートから読む)とキャッシュあり、それぞれの所要時間と
// データ量を出力する。実行するとデータの版が新しくなる(全員のキャッシュが
// 一度無効になる)が、データそのものは変更しない。
// Orbit の移行の予行演習(docs/orbit-migration-plan.md の 5)でも、移行したコピーで実行し、
// タスクの件数・読み込みの大きさ・圧縮の割合・時間・1つのセルの記録の長さの最大値と、
// 「完了から一定期間が過ぎたタスクを最初の読み込みから外す」が移行の前に要るかの判定を記録する
function measureReadPerformance() {
  function ms(start) { return Date.now() - start }
  bumpDataVersion()
  var version = getDataVersion_()

  var t = Date.now()
  var data = readSheetTables_(SNAPSHOT_SHEETS)
  var readSheetsMs = ms(t)

  var json = JSON.stringify(data)
  t = Date.now()
  var gzipChars = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes()).length
  var gzipMs = ms(t)
  t = Date.now()
  var cached = writeSnapshotCache_(version, data)
  var writeCacheMs = ms(t)

  t = Date.now()
  var fromCache = readSnapshotCache_(version)
  var readCacheMs = ms(t)

  var members = data.Members || { headers: [], rows: [] }
  var idCol = members.headers.indexOf('id')
  var sampleId = idCol >= 0 && members.rows.length > 0 ? String(members.rows[0][idCol]) : ''
  t = Date.now()
  var filtered = sampleId ? buildViewerData_(data, sampleId) : null
  var filterMs = ms(t)

  t = Date.now()
  var emails = getMemberEmailsSheet_()
  emails.getDataRange().getValues()
  var readEmailsMs = ms(t)

  var m = readPerformanceMetrics_(data, {
    jsonChars: json.length,
    gzipChars: gzipChars,
    viewerChars: filtered ? JSON.stringify(filtered).length : 0,
    readSheetsMs: readSheetsMs,
    cached: cached,
  })
  var lines = [
    '📊 読み取り性能の計測結果',
    '  行数: Members=' + members.rows.length +
      ' Projects=' + ((data.Projects || {}).rows || []).length +
      ' Tasks=' + m.tasks +
      ' Settings=' + ((data.Settings || {}).rows || []).length,
    '  タスク: ' + m.tasks + ' 件(うち完了 ' + m.doneTasks + ' 件。完了のタスクの行は全体の ' + m.doneSharePercent + '%)',
    '  データ量(JSON): ' + kb_(m.jsonChars) + ' KB',
    '  圧縮後(gzip・base64): ' + kb_(m.gzipChars) + ' KB(圧縮の割合 ' + m.gzipPercent + '%。圧縮に ' + gzipMs + ' ms)',
    '  キャッシュの分割: ' + m.chunks + ' / ' + SNAPSHOT_MAX_CHUNKS + ' 個(' + m.chunkPercent + '%)',
    '  キャッシュなし: シート読み込み ' + readSheetsMs + ' ms',
    '  キャッシュ書き込み: ' + writeCacheMs + ' ms (' + (cached ? '成功' : '上限超過のためキャッシュしない') + ')',
    '  キャッシュあり: キャッシュ読み込み ' + readCacheMs + ' ms (' + (fromCache ? '取得成功' : '取得失敗') + ')',
    '  閲覧者ごとの絞り込み: ' + filterMs + ' ms',
    '  MemberEmails 読み込み(キャッシュなし時のみ): ' + readEmailsMs + ' ms',
    '  絞り込み後のデータ量(先頭メンバー視点): ' + (filtered ? kb_(m.viewerChars) + ' KB' : '-'),
    '  1つのセルの記録の長さ: 最大 ' + m.cells.maxLength + ' 文字(上限 ' + CELL_MAX_CHARS + ' 文字の ' + m.cells.maxPercent + '%)',
  ]
  m.cells.top.forEach(function (c) {
    lines.push('    ' + c.sheet + '.' + c.field + '(' + cellFieldLabel_(c.field) + '): 最大 ' + c.maxLength + ' 文字' +
      (c.over ? '、8割を超えた記録 ' + c.over + ' 件' : ''))
  })
  lines.push('  ※ 上記に加え、Webアプリ呼び出しの往復とトークン検証(5分キャッシュ)の時間がかかります')
  lines.push('')
  lines = lines.concat(readPerformanceVerdict_(m))
  console.log(lines.join('\n'))
  return lines.join('\n')
}

// ダミーデータを作る(テスト環境専用)。既にダミーデータがある場合は、先に
// deletePerformanceTestData() で消すよう促して止まる(重複を防ぐため)
function seedPerformanceTestData() {
  assertTestEnvironment_()
  var existing = countPerfRows_(SHEET_MEMBERS) + countPerfRows_(SHEET_PROJECTS) + countPerfRows_(SHEET_TASKS)
  if (existing > 0) {
    throw userError_('ダミーデータが既に ' + existing + ' 行あります。deletePerformanceTestData() で削除してから実行してください。')
  }
  var data = buildPerformanceTestData_()
  var counts = {
    members: appendPerfRows_(SHEET_MEMBERS, data.Members),
    projects: appendPerfRows_(SHEET_PROJECTS, data.Projects),
    tasks: appendPerfRows_(SHEET_TASKS, data.Tasks),
  }
  bumpDataVersion()
  var msg = '🧪 ダミーデータを作成しました: メンバー ' + counts.members + ' 人、プロジェクト ' + counts.projects +
    ' 件、タスク ' + counts.tasks + ' 件。続けて measureReadPerformance() を実行してください。'
  console.log(msg)
  return msg
}

// ダミーデータ(id が 'perf-' で始まる行)を Members / Projects / Tasks から
// まとめて削除する(テスト環境専用)。それ以外の行には触れない
function deletePerformanceTestData() {
  assertTestEnvironment_()
  var deleted = {}
  ;[SHEET_TASKS, SHEET_PROJECTS, SHEET_MEMBERS].forEach(function (name) {
    var sheet = getSheet_(name)
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    deleted[name] = 0
    if (idCol < 0 || sheet.getLastRow() < 2) return
    var ids = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues()
    // 下の行から、連続したダミー行をまとめて削除する(行番号がずれないように)
    var i = ids.length - 1
    while (i >= 0) {
      if (String(ids[i][0]).indexOf(PERF_TEST_ID_PREFIX) !== 0) { i--; continue }
      var end = i
      while (i >= 0 && String(ids[i][0]).indexOf(PERF_TEST_ID_PREFIX) === 0) i--
      var count = end - i
      sheet.deleteRows(i + 3, count)
      forgetSheetGrid_()
      deleted[name] += count
    }
  })
  bumpDataVersion()
  var msg = '🧹 ダミーデータを削除しました: メンバー ' + deleted[SHEET_MEMBERS] + ' 行、プロジェクト ' +
    deleted[SHEET_PROJECTS] + ' 行、タスク ' + deleted[SHEET_TASKS] + ' 行'
  console.log(msg)
  return msg
}

function measureReadA() { return runReadMeasurement_('a') }

function measureReadB() { return runReadMeasurement_('b') }

function measureReadC() { return runReadMeasurement_('c') }

function measureReadD() { return runReadMeasurement_('d') }

function showReadMeasurements() {
  var lines = ['📊 読み込み方式の計測の記録']
  Object.keys(READ_MEASURE_LABELS).forEach(function (variant) {
    lines.push('  ' + READ_MEASURE_LABELS[variant] + ': ' + describeReadHistory_(readMeasureHistory_(variant)))
  })
  var text = lines.join('\n')
  console.log(text)
  return text
}

function clearReadMeasurements() {
  var props = PropertiesService.getScriptProperties()
  Object.keys(READ_MEASURE_LABELS).forEach(function (variant) {
    props.deleteProperty(READ_MEASURE_HISTORY_PREFIX + variant)
  })
  console.log('読み込み方式の計測の記録を消しました')
}

// ============================================================================
// ウェブアプリの入口・メニュー・トリガーから呼ばれる関数
// ============================================================================

// 画面は GAS に POST しか送らない。GET で届くのは、POST の結果の受け渡し(echo)が返事を渡さずに
// exec への GET に送り返した時か、URL が /exec ではない・/u/1/ を含むなどで POST が GET に変わった時。
// どちらも本文は失われている。画面がすぐ送り直せるよう、シートもプロパティも読まずに JSON で返す
// (bounced: true。何も処理していないので送り直してよい。書き込みは requestId で二重に処理されない)
function doGet(e) {
  startRequestTiming_()
  logGetRequest_(e)
  return jsonOutput_({
    ok: false,
    getReceived: true,
    bounced: true,
    error: 'GAS に GET で届きました(結果の受け渡しの途中で送り返された、または POST の本文が転送の途中で失われた)。何も処理していません。',
  })
}

function doPost(e) {
  var state = { lock: null, actions: [] }
  var out
  try {
    out = handlePost_(e, state)
  } finally {
    finishWrite_(state)
  }
  // 画面が停止の予定・機能停止を表示できるように、停止の予定・停止中の時だけ状態を付ける
  // (付いていない成功の応答は、停止の予定が無いことを表す)
  if (state.contract && state.contract.phase !== 'none' && out) out.contract = contractForClient_(state.contract)
  // 通知の回数の上限を超えて、送らなかった通知があった(操作そのものは済んでいる)
  if (_notifyLimited && out) out.notifyLimited = true
  // 利用の集計(日ごとの回数だけ。誰の操作かは残さない)
  noteRequestUsage_(state.body, out)
  // 1つのセルの上限の8割を超えた記録を書いた(書いた人に知らせる。初めて超えた記録は代表にも知らせる)
  if (_longCells.length && out) {
    out.longRecords = _longCells.map(function (c) { return { sheet: c.sheet, id: c.id, name: c.name, field: c.field, length: c.length, max: CELL_MAX_CHARS } })
    notifyTopsOfLongRecords_(_longCells)
  }
  return jsonOutput_(out)
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Ohsumi')
      .addItem('レジストリに登録する…', 'registerWithRegistryFromMenu')
      .addItem('初期設定コードを作り直す', 'regenerateInitialSetupCodeFromMenu')
      .addToUi()
  } catch (e) {
    // スプレッドシートを開いた時以外(エディタからの実行など)は何もしない
  }
}

function registerWithRegistryFromMenu() {
  var ui = SpreadsheetApp.getUi()
  // 送る前に、登録する接続先(この GAS の URL)を確かめる
  var gasUrl = ownWebAppUrl_(PropertiesService.getScriptProperties().getProperties())
  var urlProblem = checkOwnWebAppUrl_(gasUrl)
  if (urlProblem) {
    ui.alert('登録できませんでした', urlProblem, ui.ButtonSet.OK)
    return
  }
  var input = ui.prompt('レジストリに登録',
    'この GAS の URL を、団体の接続先として登録します:\n' + gasUrl + '\n\n' +
    'FSIF から受け取った登録コード(または再登録コード)を入れてください。', ui.ButtonSet.OK_CANCEL)
  if (input.getSelectedButton() !== ui.Button.OK) return
  var out
  try {
    out = registerWithRegistry_(input.getResponseText())
  } catch (e) {
    ui.alert('登録できませんでした', toErrorMessage_(e), ui.ButtonSet.OK)
    return
  }
  var msg = '団体「' + out.displayName + '」をレジストリに' + (out.kind === 'reissue' ? '再登録' : '登録') + 'しました。'
  // 招待リンク(R1-d): メンバーは、初めての端末でこのリンクから開く。サイトの URL は、レジストリに確かめて受け取る(SITE_ORIGINS)
  var orgId = PropertiesService.getScriptProperties().getProperty('ORG_ID')
  msg += '\n\n' + setupInviteLinkText_(orgId)
  if (out.setupCode) msg += '\n\n' + setupCodeMessage_(out.setupCode, out.setupExpiresAt)
  ui.alert('登録しました', msg, ui.ButtonSet.OK)
}

function regenerateInitialSetupCodeFromMenu() {
  var ui = SpreadsheetApp.getUi()
  if (!PropertiesService.getScriptProperties().getProperty('REGISTRY_SHARED_KEY')) {
    ui.alert('初期設定コード', '先に「レジストリに登録する…」で、団体を登録してください。', ui.ButtonSet.OK)
    return
  }
  if (hasTopMember_()) {
    ui.alert('初期設定コード', 'この団体には既に代表がいます。メンバーは、代表が Ohsumi の画面から追加してください。', ui.ButtonSet.OK)
    return
  }
  var setup = createInitialSetupCode_(Date.now())
  ui.alert('初期設定コードを作り直しました', '前のコードは使えなくなりました。\n\n' + setupCodeMessage_(setup.code, setup.expiresAt), ui.ButtonSet.OK)
}

// Time-triggered: send all queued batch notifications.
// Set up a time-based trigger calling this function every hour.
function sendBatchNotifications() {
  try {
    // 利用の集計(キャッシュの1時間ごとの回数)を、シートに移す
    try { flushUsage_(Date.now()) } catch (usageErr) { console.warn('利用の集計を移せませんでした: ' + ((usageErr && usageErr.message) || usageErr)) }
    // 週1回、個人を特定しない集計値を FSIF(レジストリ)に送る(団体ごとにずらした曜日・時刻。失敗したら時間を置いて送り直す)
    try { maybeSendMetrics_(Date.now()) } catch (metricsErr) { console.warn('集計値を送れませんでした: ' + maskEmailsIn_(String(metricsErr))) }
    sendBatchNotificationsUnrecorded_()
  } catch (e) {
    recordJobRun_('hourly', false, e)
    throw e
  }
  recordJobRun_('hourly', true)
}


// The function the trigger installed by setupDailyTrigger() actually calls.
// Each step is isolated so a failure in one (e.g. generateRecurringTasksLocked_
// throwing on a malformed rule) can't also skip the other.
function dailyMaintenance() {
  try {
    dailyMaintenanceUnrecorded_()
  } catch (e) {
    recordJobRun_('daily', false, e)
    throw e
  }
  // 最後まで動いた時刻(止めている時も、トリガーが動いたことは記録する)。レジストリへの確認で伝える
  recordJobRun_('daily', true)
}


// スプレッドシートを手で変えたときにキャッシュを無効にする(setupOhsumi でインストール型トリガーとして登録する)。
// スクリプトからの書き込みでは発火しない。変更検知(onChange)には、どのシートが変わったかが入らないため、
// セルの編集は onSpreadsheetEdit(編集したシートが分かる)に任せ、それ以外(行の追加・削除・シートの追加など)は
// すべての版を新しくする。onSpreadsheetEdit のトリガーが無い団体(setupOhsumi を実行し直していない)では、
// 編集もすべての版を新しくする
function onSpreadsheetChange(e) {
  var editHandled = PropertiesService.getScriptProperties().getProperty('EDIT_TRIGGER_INSTALLED') === 'true'
  if (e && e.changeType === 'EDIT' && editHandled) return
  bumpDataVersion()
  bumpMemberEmailsVersion_()
}

// セルの編集(インストール型の onEdit)。編集したシートの版だけを新しくする。知らないシートなら、すべて新しくする
function onSpreadsheetEdit(e) {
  var name = ''
  try { name = e && e.range ? String(e.range.getSheet().getName()) : '' } catch (err) { name = '' }
  var bump = SHEET_VERSION_BUMPS[name]
  if (bump) {
    bump()
    return
  }
  bumpDataVersion()
  bumpMemberEmailsVersion_()
}

// 1時間ごと(setupOhsumi でトリガーを作る): 提供停止・機能停止の状態をレジストリに確かめ、
// 停止の予定があれば、14日前・7日前・1日前に代表へメールで知らせる
function checkContractStatus() {
  var state = refreshContractState_() || readContractState_()
  try {
    sendContractNotices_(state, Date.now())
  } catch (e) {
    console.error('停止の予告のメールを送れませんでした: ' + e)
  }
  // 提供停止中は知らせない(機能停止中は知らせる)
  if (contractSuspendedNow_()) return
  try {
    sendGasUpdateNotice_()
  } catch (e) {
    console.error('GAS の更新のお知らせを送れませんでした: ' + e)
  }
  try {
    sendUrgentAnnouncementMails_(state)
  } catch (e) {
    console.error('FSIF からの緊急のお知らせを、代表にメールで送れませんでした: ' + maskEmailsIn_(String(e)))
  }
}

// ============================================================================
// 中で使うだけの関数(名前の最後に _)
// ============================================================================

// 今のコードに無い関数を指すトリガーを消す。以前の版で作ったトリガーが、消した・名前を変えた関数を
// 指したまま残っていると、トリガーが動くたびにエラーになる(setupOhsumi の最初に呼ぶ)。消した関数名を返す
function removeOrphanTriggers_() {
  var removed = []
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var name = t.getHandlerFunction()
    if (typeof globalThis[name] !== 'function') {
      ScriptApp.deleteTrigger(t)
      removed.push(name)
    }
  })
  if (removed.length) console.log('🧹 今のコードに無い関数を指すトリガーを消しました: ' + removed.join(', '))
  return removed
}

var SHEET_MEMBERS = 'Members'
var SHEET_PROJECTS = 'Projects'
var SHEET_TASKS = 'Tasks'
// メンバーのメールアドレス専用の非公開シート。Members/Projects/Tasksと違い、
// 「ウェブに公開」は絶対にしないこと — このシートだけ公開してしまうと、
// Membersシートからemail列を分離した意味が無くなる。email列をMembersシートから
// 分離し、認証済みのGASアクション(exchangeIdToken/getMyEmails/updateEmail)経由
// でのみ読み書きすることで、公開CSV経由での全員分メアド漏洩を防ぐ。
var SHEET_MEMBER_EMAILS = 'MemberEmails'
var MEMBER_EMAILS_HEADERS = ['id', 'email']
// optional 4th tab — key/value rows syncing the skill/category/role-level
// option pools and project templates; see gas/README.md. Missing sheet is
// fine, updateSetting() creates it on first write.
var SHEET_SETTINGS = 'Settings'

// ---- シートの列の一覧 ----------------------------------------------------------
// 各シートの列は、ここだけで定義する。setupOhsumi() と各シートの作成処理
// (ensure*Sheet)は、この一覧で不足している列を末尾に追加する。GAS が書き込む列・
// 画面が読む列・読み取りの権限表(READ_POLICY)の列がこの一覧とずれていないことは、
// lib/ohsumi/gas-sheet-headers.test.ts で確かめる(列を増やしたら、ここにも追加する)。
var MEMBERS_HEADERS = [
  // email列はここにはもう無い(MemberEmailsという非公開シートに分離した —
  // このシートは公開CSVとして配信されるため)。
  'id', 'name', 'role', 'notify_new_task', 'display_name',
  'avatar_url', 'avatar_color', 'avatar_initials',
  'will_tags', 'judgment_tags',
  'reports_to_id', 'mentor_id', 'joined_at', 'unavailable_dates', 'project_ids',
  'years_of_experience', 'has_management_experience', 'desired_areas', 'desired_skills',
  'career_history_json', 'qualifications_json', 'evaluation_history_json',
  'transfer_history_json', 'skill_levels_json', 'competencies_json',
  'career_aspiration', 'desired_future_role', 'career_plan',
  'training_history_json', 'development_plan_json', 'one_on_ones_json',
  'notify_settings',
  // 組織階層・権限・スキルポイント（新規列）
  'department_path',          // 例: "事業本部A>事業部1>グループX"
  'permission_overrides_json',// 例: [{"targetType":"task","targetId":"12","access":"view"}]
  'skill_points_json',        // 例: {"デザイン":120,"プログラミング":340}
  'inactive',                 // "TRUE" = 休止中メンバー（一覧から非表示）
  'absent_dates',            // 不在日リスト（カンマ区切り YYYY-MM-DD）
  'last_login',              // 最終ログイン日時（ISO datetime）
  'last_inactive_notified',  // 未アクセス通知を最後に送った日（YYYY-MM-DD）
  'timezone',                // 本人のタイムゾーン（IANA名、例: "Asia/Tokyo"）
  'locale',                  // 本人の表示言語（例: "ja", "en"）
  'university',              // 大学名
  'faculty',                 // 学部
  'department_name',         // 学科（department_pathと紛らわしいので department_name とする）
  'grade_year',              // 学年
  'custom_fields_json',      // 団体ごとのカスタム列（人材DB）の値 {"key":"value"}
  'survey_responses_json',   // item 22/30: このメンバー自身の全アンケート回答履歴 [{"id","submittedAt","answers"}]
  'available_hours_json',    // CAL-009: 日々の稼働可能時間帯（参考情報） {"start":"10:00","end":"18:00"}
  // 退会と個人情報の削除(「個人情報の削除」)
  'withdrawn_at',            // 退会した日時(ISO)。空なら在籍
  'purge_at',                // 個人情報を消す日時を延ばした時の日時(ISO)。空なら 退会の日時 + 保存期間
  'personal_data_purged_at', // 個人情報を消した日時(ISO)
  'withdrawal_unassigned_task_ids', // 退会の時に未アサインに戻したタスクの ID(カンマ区切り。退会を取り消した時に一覧を出す)
  // 書き込みの競合チェック(「行の版」)
  'row_version',             // 行の版(内容を変えるたびに新しくなる。画面が開いた時の版と違えば、上書きせずに断る)
  'row_updated_by',          // 行の内容を最後に変えた人(メンバーID。毎日の処理などは system)
]
var PROJECTS_HEADERS = [
  'id', 'name', 'description', 'type', 'owner_id', 'member_ids', 'archived', 'parent_id',
  'goal', // 目標（概要=descriptionとは別枠）
  'health_override',       // item 26: 幹部による健康状態の手動上書き
  'last_notified_health',  // item 26: 直近に通知した実効健康状態（重複通知防止）
  'start_date', // PRJ-003: プロジェクトの開始日（任意, YYYY-MM-DD）
  'end_date',   // PRJ-003: プロジェクトの終了予定日（任意, YYYY-MM-DD）
  'row_version', 'row_updated_by', // 書き込みの競合チェック(「行の版」)
]
var TASKS_HEADERS = [
  'id', 'project_id', 'title', 'description', 'status', 'assign_type',
  'assignee_id', 'creator_id', 'created_at', 'start_date', 'due_date', 'due_time',
  'visibility', 'department', 'category', 'skills', 'difficulty', 'priority',
  'last_activity', 'original_input_id', 'approval_status', 'estimated_hours',
  'importance', 'reviewer_id', 'reviewer_ids', 'depends_on_ids',
  'progress_note', 'progress_percent', 'progress_history_json',
  'deliverables_json', 'history_json', 'comments_json',
  'retrospective_json', 'schedule_json', 'form_json',
  'blocker_note', 'blocker_since', 'completed_date', 'actual_hours',
  'awarded_points_json', // 完了時付与スキルポイント {"デザイン":30}
  'required_approvals',  // 承認に必要な確認者数 (数値 or "all")
  'required_skill_levels_json', // 必要スキルレベル(item 10/11) {"デザイン":3}
  'review_approvals_json', // 複数確認者の承認記録 [{"memberId","at","comment"}]
  'open_bid_applicant_ids', // TSK-027: 公募タスクへの応募者IDリスト(カンマ区切り)
  'related_review_task_id', // APR-007: このタスクが確認タスクである場合、確認対象の元タスクのid
  'hold_reason_note',  // 保留の理由(ステータスを保留にしたときのメモ)
  'hold_reason_since', // 保留にした日(YYYY-MM-DD)
  'row_version', 'row_updated_by', // 書き込みの競合チェック(「行の版」)
]
var SETTINGS_HEADERS = ['key', 'value']
var EXPENSES_HEADERS = ['id', 'applicant_id', 'amount', 'category_id', 'receipt_url', 'justification', 'purpose', 'custom_field_answers_json', 'approval_steps_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var FORM_SUBMISSIONS_HEADERS = ['id', 'form_id', 'submitter_id', 'answers_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var DAILY_REPORTS_HEADERS = ['id', 'member_id', 'type', 'report_date', 'done_text', 'todo_text', 'issues_text', 'created_at']
var CANDIDATES_HEADERS = ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at',
  // 採用しなかった日時と、消す日時を延ばした時の日時(「個人情報の削除」)
  'rejected_at', 'purge_at']

var SHEET_HEADERS = {
  Members: MEMBERS_HEADERS,
  Projects: PROJECTS_HEADERS,
  Tasks: TASKS_HEADERS,
  Settings: SETTINGS_HEADERS,
  MemberEmails: MEMBER_EMAILS_HEADERS,
  Expenses: EXPENSES_HEADERS,
  FormSubmissions: FORM_SUBMISSIONS_HEADERS,
  DailyReports: DAILY_REPORTS_HEADERS,
  Candidates: CANDIDATES_HEADERS,
}

var SETTINGS_KEY_RECURRING_RULES = 'recurring_rules'
// スキルごとのレベルアップ閾値 JSON: { "デフォルト": 100, "デザイン": 150, ... }
var SETTINGS_KEY_SKILL_LEVEL_THRESHOLDS = 'skill_level_thresholds'
// 部署ツリー設定 JSON: 部署一覧を静的に管理したい場合に使う（省略時は
// Members.department_path の実データから動的導出）
var SETTINGS_KEY_DEPARTMENT_TREE_CONFIG = 'department_tree_config'
// NOT a Settings-sheet key (that sheet is published as a public CSV) — this
// is the PropertiesService key the Discord webhook URL is stored under
// instead. See getDiscordWebhookUrl_()/updateDiscordWebhookUrl() below.
var DISCORD_WEBHOOK_PROPERTY_KEY = 'discord_webhook_url'

// ---- 選択肢の値の内部コード ------------------------------------------------------
//
// タスクのステータス・難易度・優先度などは、画面の言語によらない内部コードで
// 扱う。シートには、移行(migrateToInternalCodes)までは今の日本語の値が入って
// いる。読む時はどちらの形式でもコードにそろえ(normalizeCode_)、書く時は
// スクリプトプロパティ VALUE_FORMAT が codes になるまで日本語で書く(sheetCode_)。
// こうすると、古いタブや古い GAS が残っていても、シートの値は1つの形式のまま。
//
// VALUE_CODES は lib/ohsumi/codes.ts と同じ内容(一致することを
// lib/ohsumi/codes.test.ts で確かめる)。
var VALUE_CODES = {
  status: {
    codes: ['todo', 'hold', 'progress', 'support', 'review', 'fix', 'done'],
    sheetLabels: { todo: '未着手', hold: '保留', progress: '進行中', support: 'サポート必要', review: '確認待ち', fix: '修正中', done: '完了' },
    aliases: {},
    fallback: 'progress',
  },
  difficulty: {
    codes: ['anyone', 'beginner', 'some_exp', 'experienced', 'advanced'],
    sheetLabels: { anyone: '誰でも可', beginner: '新人歓迎', some_exp: '少し経験必要', experienced: '経験者向け', advanced: '上級者向け' },
    aliases: {},
    fallback: 'beginner',
  },
  priority: {
    codes: ['high', 'medium', 'low'],
    sheetLabels: { high: '高', medium: '中', low: '低' },
    aliases: {},
    fallback: 'medium',
  },
  importance: {
    codes: ['normal', 'important', 'external'],
    sheetLabels: { normal: '一般', important: '重要', external: '対外公開' },
    aliases: { '': 'normal' },
    fallback: 'normal',
  },
  visibility: {
    codes: ['all', 'leaders'],
    sheetLabels: { all: '全員', leaders: '幹部' },
    aliases: { '': 'all' },
    fallback: 'all',
  },
  approval: {
    codes: ['pending', 'approved'],
    sheetLabels: { pending: '承認待ち', approved: '承認済み' },
    aliases: { '': 'approved' },
    fallback: 'approved',
  },
  department: {
    codes: ['ops', 'pr', 'dev', 'design', 'relations', 'event', 'research', ''],
    sheetLabels: { ops: '運営', pr: '広報', dev: '開発', design: 'デザイン', relations: '渉外', event: 'イベント', research: 'リサーチ', '': '未分類' },
    aliases: {},
    fallback: null,
  },
  scheduleAnswer: {
    codes: ['yes', 'maybe', 'no'],
    sheetLabels: { yes: '○', maybe: '△', no: '×' },
    aliases: { '〇': 'yes', '✕': 'no' },
    fallback: null,
  },
}

// どの形式の値(コード・移行前の日本語・別名)でも、コードにそろえる
function normalizeCode_(kind, value) {
  var table = VALUE_CODES[kind]
  var v = value === null || value === undefined ? '' : String(value).trim()
  if (table.codes.indexOf(v) >= 0) return v
  for (var i = 0; i < table.codes.length; i++) {
    if (table.sheetLabels[table.codes[i]] === v) return table.codes[i]
  }
  if (Object.prototype.hasOwnProperty.call(table.aliases, v)) return table.aliases[v]
  return table.fallback === null ? v : table.fallback
}

// シートがコードの形式になっているか(移行の関数が VALUE_FORMAT=codes にする)
function isCodesFormat_() {
  return requestProps_().VALUE_FORMAT === 'codes'
}

// コードを、シートに書く形式にする(移行前は日本語。一覧に無い値はそのまま)
function sheetCode_(kind, value) {
  var code = normalizeCode_(kind, value)
  if (isCodesFormat_()) return code
  var labels = VALUE_CODES[kind].sheetLabels
  return Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : code
}

// 通知の文面に出す表示名。lib/ohsumi/i18n の ja.ts・en.ts と同じ
// (一致することを lib/ohsumi/codes.test.ts で確かめる)
var NOTIFY_LABELS = {
  scheduleAnswer: {
    ja: { yes: '○', maybe: '△', no: '×' },
    en: { yes: '○', maybe: '△', no: '×' },
  },
}

function notifyLabel_(kind, locale, value) {
  var code = normalizeCode_(kind, value)
  var labels = NOTIFY_LABELS[kind][locale] || NOTIFY_LABELS[kind].ja
  return Object.prototype.hasOwnProperty.call(labels, code) ? labels[code] : code
}

// スキルのレベルアップの閾値で、既定値を表すキー(移行前は「デフォルト」)
var DEFAULT_THRESHOLD_KEY = '_default'
var LEGACY_DEFAULT_THRESHOLD_KEY = 'デフォルト'

function defaultSkillThreshold_(thresholds) {
  thresholds = thresholds || {}
  return thresholds[DEFAULT_THRESHOLD_KEY] || thresholds[LEGACY_DEFAULT_THRESHOLD_KEY] || 100
}

// フロントの版。移行の後は、これより古い(または版の無い)リクエストを拒否する。
// 移行前のコードを読めない古いタブが、ステータスなどを誤って表示・保存するのを防ぐ
// (lib/ohsumi/codes.ts の CLIENT_VERSION と合わせる)
var MIN_CLIENT_VERSION = 1

function checkClientVersion_(body) {
  if (!isCodesFormat_()) return null
  var v = Number(body && body.clientVersion) || 0
  if (v >= MIN_CLIENT_VERSION) return null
  return 'Ohsumi が更新されました。ページを再読み込みしてください。'
}

// 変更の記録(history_json)のうち、値がコードになる項目
var HISTORY_CODE_FIELDS = {
  status: 'status', priority: 'priority', difficulty: 'difficulty',
  visibility: 'visibility', importance: 'importance', department: 'department',
}

function mapHistoryCodes_(entry, convert) {
  var kind = entry && HISTORY_CODE_FIELDS[entry.field]
  if (!kind) return entry
  var out = {}
  Object.keys(entry).forEach(function (k) { out[k] = entry[k] })
  out.from = convert(kind, entry.from)
  out.to = convert(kind, entry.to)
  return out
}

function normalizeHistoryEntry_(entry) { return mapHistoryCodes_(entry, normalizeValue_) }
function sheetHistoryEntry_(entry) { return mapHistoryCodes_(entry, sheetValue_) }

function mapScheduleCodes_(schedule, convert) {
  if (!schedule || typeof schedule !== 'object' || !schedule.responses) return schedule
  var out = {}
  Object.keys(schedule).forEach(function (k) { out[k] = schedule[k] })
  var responses = {}
  Object.keys(schedule.responses).forEach(function (memberId) {
    var answers = schedule.responses[memberId] || {}
    var converted = {}
    Object.keys(answers).forEach(function (candidateId) {
      converted[candidateId] = convert('scheduleAnswer', answers[candidateId])
    })
    responses[memberId] = converted
  })
  out.responses = responses
  return out
}

function mapOverrideCodes_(overrides, convert) {
  if (!Array.isArray(overrides)) return overrides
  return overrides.map(function (ov) {
    if (!ov || ov.targetType !== 'department') return ov
    var out = {}
    Object.keys(ov).forEach(function (k) { out[k] = ov[k] })
    out.targetId = convert('department', ov.targetId)
    return out
  })
}

// テンプレート・定期タスクの中の department・difficulty・priority(・triggerOnStatus)
function mapTaskItemCodes_(item, convert) {
  if (!item || typeof item !== 'object') return item
  var out = {}
  Object.keys(item).forEach(function (k) { out[k] = item[k] })
  if ('department' in item) out.department = convert('department', item.department)
  if ('difficulty' in item) out.difficulty = convert('difficulty', item.difficulty || 'beginner')
  if ('priority' in item) out.priority = convert('priority', item.priority || 'medium')
  if (item.triggerOnStatus) out.triggerOnStatus = convert('status', item.triggerOnStatus)
  return out
}

// Settings のうち、中に選択肢の値を持つ JSON を、シートに書く形式にする
// (updateSetting で使う。移行前は日本語、移行後はコード)
function sheetSettingValue_(key, value) {
  if (CODE_SETTING_KEYS.indexOf(key) < 0 || typeof value !== 'string' || !value) return value
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return value }
  var convert = sheetValue_
  var out = parsed
  if (key === 'project_templates' && parsed && typeof parsed === 'object') {
    out = {}
    Object.keys(parsed).forEach(function (name) {
      out[name] = Array.isArray(parsed[name]) ? parsed[name].map(function (it) { return mapTaskItemCodes_(it, convert) }) : parsed[name]
    })
  } else if (key === 'task_set_templates' && Array.isArray(parsed)) {
    out = parsed.map(function (tpl) {
      if (!tpl || !Array.isArray(tpl.items)) return tpl
      var copy = {}
      Object.keys(tpl).forEach(function (k) { copy[k] = tpl[k] })
      copy.items = tpl.items.map(function (it) { return mapTaskItemCodes_(it, convert) })
      return copy
    })
  } else if (key === 'recurring_rules' && Array.isArray(parsed)) {
    out = parsed.map(function (rule) { return mapTaskItemCodes_(rule, convert) })
  } else if (key === 'skill_level_thresholds' && parsed && typeof parsed === 'object') {
    var fromKey = isCodesFormat_() ? LEGACY_DEFAULT_THRESHOLD_KEY : DEFAULT_THRESHOLD_KEY
    var toKey = isCodesFormat_() ? DEFAULT_THRESHOLD_KEY : LEGACY_DEFAULT_THRESHOLD_KEY
    out = {}
    Object.keys(parsed).forEach(function (k) {
      if (k === fromKey) { if (!(toKey in parsed)) out[toKey] = parsed[k] } else out[k] = parsed[k]
    })
  }
  return JSON.stringify(out)
}

// ---- 役職 ------------------------------------------------------------------------
//
// 役職は Settings の roles(JSON)に、上下関係の順(一般 → … → 最上位)で持つ。
//   { id, name, tier: 'top' | 'admin' | 'base', restricted?, sections?, requiredSkills? }
// 移行(VALUE_FORMAT=codes)の前は roles が無く、今までの設定(role_levels・
// restricted_roles・role_permissions・job_requirements)から組み立てる(ID は役職名)。
// 役職は ID でも名前でも引ける(findRole_)ので、移行の途中でも判定は変わらない。
// lib/ohsumi/roles.ts と同じ内容(一致することを lib/ohsumi/roles.test.ts で確かめる)。

var TOP_ROLE_ID = 'top'
var BASE_ROLE_ID = 'base'
var DEFAULT_TOP_ROLE_NAME = '代表'
var DEFAULT_BASE_ROLE_NAME = '一般'
var DEFAULT_ROLE_LEVELS = ['班長', '事業責任者', '代表']
// 制限付きの管理者が、セクションを指定していない時に見られる管理画面(types.ts と同じ)
var DEFAULT_NON_TOP_SECTIONS = ['dashboard', 'approvals', 'assignments', 'projects', 'memberdb']
// Settings のうち役職の設定
var ROLE_SETTING_KEYS = ['roles', 'role_levels', 'restricted_roles', 'role_permissions', 'job_requirements']

function defaultRoles_() {
  return [
    { id: BASE_ROLE_ID, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: 'r_manager', name: '事業責任者', tier: 'admin', restricted: false },
    { id: TOP_ROLE_ID, name: DEFAULT_TOP_ROLE_NAME, tier: 'top' },
  ]
}

function roleParseObject_(value) {
  try {
    var parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (e) {
    return {}
  }
}

function roleStringArray_(v) {
  return Array.isArray(v) ? v.map(String) : undefined
}

function rolesFromLegacy_(settings) {
  var levels = splitCsvList_(settings.role_levels)
  var names = (levels.length ? levels : DEFAULT_ROLE_LEVELS).filter(function (n) { return n !== DEFAULT_BASE_ROLE_NAME })
  if (names.indexOf(DEFAULT_TOP_ROLE_NAME) < 0) names.push(DEFAULT_TOP_ROLE_NAME)
  var restricted = splitCsvList_(settings.restricted_roles)
  // restricted_roles にだけある役職も、今までどおり制限付きの管理者として扱う
  restricted.forEach(function (n) {
    if (names.indexOf(n) < 0 && n !== DEFAULT_BASE_ROLE_NAME && n !== DEFAULT_TOP_ROLE_NAME) names.splice(names.indexOf(DEFAULT_TOP_ROLE_NAME), 0, n)
  })
  var permissions = roleParseObject_(settings.role_permissions)
  var requirements = roleParseObject_(settings.job_requirements)
  var roles = [{ id: DEFAULT_BASE_ROLE_NAME, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' }]
  var baseSkills = roleStringArray_(requirements[DEFAULT_BASE_ROLE_NAME])
  if (baseSkills) roles[0].requiredSkills = baseSkills
  var seen = {}
  names.forEach(function (name) {
    if (seen[name]) return
    seen[name] = true
    var role = { id: name, name: name, tier: name === DEFAULT_TOP_ROLE_NAME ? 'top' : 'admin' }
    if (role.tier === 'admin') role.restricted = restricted.indexOf(name) >= 0
    var sections = roleStringArray_(permissions[name])
    if (sections) role.sections = sections
    var skills = roleStringArray_(requirements[name])
    if (skills) role.requiredSkills = skills
    roles.push(role)
  })
  return roles
}

function parseRolesSetting_(value) {
  if (!value) return null
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var roles = []
  for (var i = 0; i < parsed.length; i++) {
    var o = parsed[i]
    if (!o || typeof o !== 'object') return null
    var tier = o.tier
    if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name) return null
    if (tier !== 'top' && tier !== 'admin' && tier !== 'base') return null
    var role = { id: o.id, name: o.name, tier: tier }
    if (tier === 'admin') role.restricted = o.restricted === true
    var sections = roleStringArray_(o.sections)
    if (sections) role.sections = sections
    var skills = roleStringArray_(o.requiredSkills)
    if (skills) role.requiredSkills = skills
    roles.push(role)
  }
  return validateRoles_(roles).length === 0 ? roles : null
}

function rolesFromSettings_(settings) {
  return parseRolesSetting_(settings.roles) || rolesFromLegacy_(settings)
}

function validateRoles_(roles) {
  var errors = []
  var ids = {}
  var names = {}
  roles.forEach(function (r) {
    if (ids[r.id]) errors.push('役職のIDが重複しています: ' + r.id)
    if (names[r.name]) errors.push('役職の名前が重複しています: ' + r.name)
    ids[r.id] = true
    names[r.name] = true
  })
  if (roles.filter(function (r) { return r.tier === 'base' }).length !== 1) errors.push('一般の役職はちょうど1つ必要です')
  if (roles.filter(function (r) { return r.tier === 'top' }).length < 1) errors.push('最上位の役職が1つ以上必要です')
  return errors
}

function findRole_(roles, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v) return undefined
  for (var i = 0; i < roles.length; i++) if (roles[i].id === v) return roles[i]
  for (var j = 0; j < roles.length; j++) if (roles[j].name === v) return roles[j]
  return undefined
}

function roleTier_(roles, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v) return 'base'
  var role = findRole_(roles, v)
  return role ? role.tier : 'admin'
}

function isTopRoleRef_(roles, ref) { return roleTier_(roles, ref) === 'top' }
function isAdminRoleRef_(roles, ref) { return roleTier_(roles, ref) !== 'base' }

function isFullAdminRoleRef_(roles, ref) {
  var tier = roleTier_(roles, ref)
  if (tier === 'top') return true
  if (tier === 'base') return false
  var role = findRole_(roles, ref)
  return !(role && role.restricted)
}

function sameRole_(roles, a, b) {
  var x = String(a === null || a === undefined ? '' : a).trim()
  var y = String(b === null || b === undefined ? '' : b).trim()
  if (!x || !y) return false
  if (x === y) return true
  var rx = findRole_(roles, x)
  var ry = findRole_(roles, y)
  return !!rx && !!ry && rx.id === ry.id
}

function rolesToLegacySettings_(roles) {
  var nonBase = roles.filter(function (r) { return r.tier !== 'base' })
  var permissions = {}
  var requirements = {}
  roles.forEach(function (r) {
    if (r.sections) permissions[r.name] = r.sections
    if (r.requiredSkills) requirements[r.name] = r.requiredSkills
  })
  return {
    role_levels: nonBase.map(function (r) { return r.name }).join(','),
    restricted_roles: nonBase.filter(function (r) { return r.tier === 'admin' && r.restricted }).map(function (r) { return r.name }).join(','),
    role_permissions: JSON.stringify(permissions),
    job_requirements: JSON.stringify(requirements),
  }
}

// Settings の key → value(役職の設定だけ)。1回の読み込みで全部取る
function readRoleSettings_() {
  var out = {}
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
  if (!sheet || sheet.getLastRow() < 2) return out
  var headers = headerRow_(sheet)
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  if (keyCol === -1 || valueCol === -1) return out
  sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
    var key = String(r[keyCol])
    if (ROLE_SETTING_KEYS.indexOf(key) >= 0) out[key] = String(r[valueCol] || '')
  })
  return out
}

// このリクエストでの役職の一覧(1回だけ読む。役職の設定を変えたら invalidateRoles_)
var _requestRoles = null
function requestRolesFrom_(settings) {
  var parsed = parseRolesSetting_(settings.roles)
  return { roles: parsed || rolesFromLegacy_(settings), fromSetting: !!parsed }
}
function getRoles_() {
  if (!_requestRoles) _requestRoles = requestRolesFrom_(readRoleSettings_())
  return _requestRoles.roles
}
function invalidateRoles_() { _requestRoles = null }

// Settings の roles を使っているか(移行の後・新しく導入した団体)。使っていなければ、
// 今までの設定から組み立てた役職(ID は役職名)
function hasRolesSetting_() {
  getRoles_()
  return _requestRoles.fromSetting
}

// メンバーの role 列に書く値。役職の ID(roles が無い間は、ID は役職名そのもの)
function sheetRoleRef_(ref) {
  var role = findRole_(getRoles_(), ref)
  return role ? role.id : String(ref || '').trim()
}

// roles が無い団体の役職(ID は役職名)に、移行後と同じ ID を付ける。
// 一般 → base、代表 → top、ほかは新しい ID(メンバーの role 列の役職名は、名前で引けるのでそのままでよい)
function rolesWithCodeIds_(roles) {
  return roles.map(function (r) {
    var copy = {}
    Object.keys(r).forEach(function (k) { copy[k] = r[k] })
    if (r.tier === 'base') copy.id = BASE_ROLE_ID
    else if (r.name === DEFAULT_TOP_ROLE_NAME) copy.id = TOP_ROLE_ID
    else copy.id = newRoleId_()
    return copy
  })
}

function newRoleId_() {
  return 'r_' + Math.random().toString(36).slice(2, 8)
}

// ---- 部門 ----------------------------------------------------------------------
//
// Settings の departments(JSON)に [{ id, name, archived? }]。未設定なら既定の7部門。未分類は空。
// タスクなどの部門の値は、移行(VALUE_FORMAT=codes)の前は部門名、後は部門 ID。ID でも名前でも引ける。
// lib/ohsumi/departments.ts と同じ内容(一致することを lib/ohsumi/departments.test.ts で確かめる)。

var UNCATEGORIZED_NAME = '未分類'

function defaultDepartments_() {
  return VALUE_CODES.department.codes.filter(function (c) { return c !== '' }).map(function (id) {
    return { id: id, name: VALUE_CODES.department.sheetLabels[id] }
  })
}

function validateDepartments_(list) {
  var errors = []
  var ids = {}
  var names = {}
  list.forEach(function (d) {
    if (!d.id || !d.name) errors.push('部門の ID と名前は空にできません')
    if (d.name === UNCATEGORIZED_NAME) errors.push('「未分類」は部門の名前に使えません')
    if (ids[d.id]) errors.push('部門の ID が重複しています: ' + d.id)
    if (names[d.name]) errors.push('部門の名前が重複しています: ' + d.name)
    ids[d.id] = true
    names[d.name] = true
  })
  return errors
}

function parseDepartmentsSetting_(value) {
  if (!value) return null
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var list = []
  for (var i = 0; i < parsed.length; i++) {
    var o = parsed[i]
    if (!o || typeof o !== 'object') return null
    if (typeof o.id !== 'string' || typeof o.name !== 'string') return null
    var dept = { id: o.id, name: o.name }
    if (o.archived === true) dept.archived = true
    list.push(dept)
  }
  return validateDepartments_(list).length === 0 ? list : null
}

function departmentsFromSettings_(settings) {
  return parseDepartmentsSetting_(settings.departments) || defaultDepartments_()
}

function findDepartment_(list, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v || v === UNCATEGORIZED_NAME) return undefined
  var i
  for (i = 0; i < list.length; i++) if (list[i].id === v) return list[i]
  for (i = 0; i < list.length; i++) if (list[i].name === v) return list[i]
  var labels = VALUE_CODES.department.sheetLabels
  var ids = Object.keys(labels)
  for (i = 0; i < ids.length; i++) {
    if (ids[i] && labels[ids[i]] === v) {
      for (var j = 0; j < list.length; j++) if (list[j].id === ids[i]) return list[j]
      return undefined
    }
  }
  return undefined
}

function normalizeDepartment_(list, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v || v === UNCATEGORIZED_NAME) return ''
  var dept = findDepartment_(list, v)
  return dept ? dept.id : v
}

function sheetDepartmentRef_(list, ref, codes) {
  var id = normalizeDepartment_(list, ref)
  if (!id) return codes ? '' : UNCATEGORIZED_NAME
  var dept = findDepartment_(list, id)
  if (!dept) return id
  return codes ? dept.id : dept.name
}

// このリクエストでの部門の一覧(1回だけ読む。シートが無い時は既定)
var _requestDepartments = null
function getDepartments_() {
  if (!_requestDepartments) {
    var raw = ''
    var fromSetting = false
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
      if (sheet && sheet.getLastRow() > 1) {
        var headers = headerRow_(sheet)
        var keyCol = headers.indexOf('key')
        var valueCol = headers.indexOf('value')
        sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
          if (String(r[keyCol]) === 'departments') raw = String(r[valueCol] || '')
        })
      }
    } catch (e) {
      // シートを読めない(テストなど)時は既定の部門
    }
    var parsed = parseDepartmentsSetting_(raw)
    fromSetting = !!parsed
    _requestDepartments = { list: parsed || defaultDepartments_(), fromSetting: fromSetting }
  }
  return _requestDepartments.list
}
function invalidateDepartments_() { _requestDepartments = null }

// 選択肢の値を読む時・書く時の変換(部門だけは部門の一覧を使う)
function normalizeValue_(kind, value) {
  return kind === 'department' ? normalizeDepartment_(getDepartments_(), value) : normalizeCode_(kind, value)
}
function sheetValue_(kind, value) {
  return kind === 'department' ? sheetDepartmentRef_(getDepartments_(), value, isCodesFormat_()) : sheetCode_(kind, value)
}

// ---- 部門の編集(updateDepartments・deleteDepartment・moveDepartmentTasks) ---------

function writeDepartments_(list) {
  updateSetting_('departments', JSON.stringify(list))
  invalidateDepartments_()
}

// 部門の一覧を保存する(追加・名前・並び順・アーカイブの解除)。削除は deleteDepartment
function updateDepartments_(newList) {
  if (!Array.isArray(newList)) throw userError_('部門の一覧の形式が正しくありません。')
  var parsed = parseDepartmentsSetting_(JSON.stringify(newList))
  if (!parsed) throw userError_('部門の一覧が正しくありません: ' + validateDepartments_(newList.filter(Boolean)).join(' / '))
  var current = getDepartments_()
  var byId = {}
  current.forEach(function (d) { byId[d.id] = d })
  var newIds = {}
  parsed.forEach(function (d) { newIds[d.id] = true })
  current.forEach(function (d) {
    if (!newIds[d.id]) throw userError_('部門「' + d.name + '」を消すには、部門の削除を使ってください。')
  })
  if (!isCodesFormat_()) {
    parsed.forEach(function (d) {
      // 移行前はタスクの部門を部門名で持つため、名前を変えると引けなくなる
      if (byId[d.id] && byId[d.id].name !== d.name) throw userError_('部門の名前の変更は、内部コードへの移行の後にできるようになります。')
    })
  }
  writeDepartments_(parsed)
  return { departments: parsed }
}

// 部門が使われている数(タスク・テンプレート・定期タスク・権限の例外)
function departmentUsage_(deptId) {
  var list = getDepartments_()
  var usage = { tasks: 0, settings: 0, overrides: 0 }
  var tasks = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS)
  if (tasks && tasks.getLastRow() > 1) {
    var h = headerRow_(tasks)
    var col = h.indexOf('department')
    if (col >= 0) {
      tasks.getRange(2, col + 1, tasks.getLastRow() - 1, 1).getValues().forEach(function (r) {
        if (normalizeDepartment_(list, r[0]) === deptId) usage.tasks++
      })
    }
  }
  ;['project_templates', 'task_set_templates', 'recurring_rules'].forEach(function (key) {
    var raw = getSettingValue_(key)
    if (!raw) return
    var found = 0
    JSON.stringify(parseJsonOr_(raw, null), function (k, v) {
      if (k === 'department' && normalizeDepartment_(list, v) === deptId) found++
      return v
    })
    usage.settings += found
  })
  var members = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MEMBERS)
  if (members && members.getLastRow() > 1) {
    var mh = headerRow_(members)
    var ocol = mh.indexOf('permission_overrides_json')
    if (ocol >= 0) {
      members.getRange(2, ocol + 1, members.getLastRow() - 1, 1).getValues().forEach(function (r) {
        parseJsonOr_(r[0], []).forEach(function (ov) {
          if (ov && ov.targetType === 'department' && normalizeDepartment_(list, ov.targetId) === deptId) usage.overrides++
        })
      })
    }
  }
  return usage
}

// 部門を削除する。使われていればアーカイブ(archived)にし、どこでも使われていなければ一覧から消す
function deleteDepartment_(deptId) {
  var list = getDepartments_()
  var dept = findDepartment_(list, deptId)
  if (!dept) throw userError_('部門が見つかりません: ' + deptId)
  var usage = departmentUsage_(dept.id)
  var used = usage.tasks + usage.settings + usage.overrides > 0
  var next = used
    ? list.map(function (d) { return d.id === dept.id ? { id: d.id, name: d.name, archived: true } : d })
    : list.filter(function (d) { return d.id !== dept.id })
  writeDepartments_(next)
  return { departments: next, archived: used, usage: usage }
}

// ある部門のタスクを、別の部門(空は未分類)へ移す。返り値は移したタスクの数
function moveDepartmentTasks_(fromId, toId) {
  var list = getDepartments_()
  var from = findDepartment_(list, fromId)
  if (!from) throw userError_('部門が見つかりません: ' + fromId)
  if (toId && !findDepartment_(list, toId)) throw userError_('移す先の部門が見つかりません: ' + toId)
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var col = headers.indexOf('department')
  if (col < 0 || sheet.getLastRow() < 2) return { moved: 0 }
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var value = sheetDepartmentRef_(list, toId || '', isCodesFormat_())
  var moved = 0
  rows.forEach(function (r) {
    if (normalizeDepartment_(list, r[col]) !== from.id) return
    updateTaskFields_(String(r[idCol]), { department: value })
    moved++
  })
  return { moved: moved }
}

// ---- 役職の編集(updateRoles・deleteRole)と、最上位の締め出しの防止 ----------------

function baseRoleRef_() {
  var roles = getRoles_()
  for (var i = 0; i < roles.length; i++) if (roles[i].tier === 'base') return roles[i].id
  return DEFAULT_BASE_ROLE_NAME
}

// 一覧に無い役職は受け付けない(役職の付け間違いで管理者扱いにならないように)
function requireKnownRole_(ref) {
  var role = findRole_(getRoles_(), ref)
  if (!role) throw userError_('役職が見つかりません: ' + ref)
  return role
}

// 変更の後に、最上位の役職を持つ有効な(休止中でない)メンバーが1人以上残るか確かめる。
// change: { roles?: 変更後の役職の一覧, members?: { メンバーID: { role?, inactive?, removed? } } }
function assertTopRemains_(change) {
  var roles = change.roles || getRoles_()
  var overrides = change.members || {}
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var inactiveCol = headers.indexOf('inactive')
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
  var count = 0
  rows.forEach(function (r) {
    var o = overrides[String(r[idCol])] || {}
    if (o.removed) return
    var inactive = o.inactive !== undefined ? o.inactive : String(inactiveCol >= 0 ? r[inactiveCol] : '').trim().toUpperCase() === 'TRUE'
    if (inactive) return
    var role = o.role !== undefined ? o.role : r[roleCol]
    if (isTopRoleRef_(roles, role)) count++
  })
  if (count === 0) {
    throw userError_('最上位の役職を持つ有効なメンバーが0人になるため、この操作はできません。先に別のメンバーを最上位の役職にしてください。')
  }
}

// 役職の一覧を保存する(並び順・種類・制限・セクション・必要スキル・名前)。
// 役職の削除は deleteRole で行う(使っているメンバーを移す必要があるため)。
// 全権管理者が行える。最上位の役職にかかわる変更は、最上位の役職を持つ人だけ
function updateRoles_(acting, newRoles) {
  if (!Array.isArray(newRoles)) throw userError_('役職の一覧の形式が正しくありません。')
  var parsed = parseRolesSetting_(JSON.stringify(newRoles))
  if (!parsed) throw userError_('役職の一覧が正しくありません: ' + validateRoles_(newRoles.filter(Boolean)).join(' / '))
  var current = getRoles_()
  var byId = {}
  current.forEach(function (r) { byId[r.id] = r })
  var newIds = {}
  parsed.forEach(function (r) { newIds[r.id] = true })
  current.forEach(function (r) {
    if (!newIds[r.id]) throw userError_('役職「' + r.name + '」を消すには、役職の削除を使ってください。')
  })
  var topOf = function (list) { return list.filter(function (r) { return r.tier === 'top' }).map(function (r) { return r.id }).sort().join(',') }
  if (topOf(current) !== topOf(parsed) && !isTopRoleRef_(current, acting.role)) {
    throw userError_('最上位の役職にかかわる変更は、最上位の役職を持つメンバーだけが行えます。')
  }
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.tier === 'base' && r.tier !== 'base') throw userError_('一般の役職の種類は変えられません。')
    if (before && before.tier !== 'base' && r.tier === 'base') throw userError_('一般の役職は1つだけです。')
    if (!hasRolesSetting_()) {
      // 移行の前は役職名が ID を兼ねるため、名前の変更と、代表以外の最上位の役職は作れない
      if (r.name !== r.id) throw userError_('役職の名前の変更は、内部コードへの移行の後にできるようになります。')
      if (r.tier === 'top' && r.name !== DEFAULT_TOP_ROLE_NAME) throw userError_('代表以外の最上位の役職は、内部コードへの移行の後に作れるようになります。')
    }
  })
  assertTopRemains_({ roles: parsed })
  // 名前を変えた役職を、古い名前のまま持っているメンバー(移行の漏れなど)は、役職の ID にそろえる
  // (名前を変えると、古い名前ではもう引けないため)
  var renamed = {}
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.name !== r.name) renamed[before.name] = r.id
  })
  if (Object.keys(renamed).length) {
    var sheet = getSheet_(SHEET_MEMBERS)
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var roleCol = headers.indexOf('role')
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
    rows.forEach(function (r) {
      var name = String(r[roleCol] || '').trim()
      if (Object.prototype.hasOwnProperty.call(renamed, name)) updateMemberFields_(String(r[idCol]), { role: renamed[name] })
    })
  }
  writeRoles_(parsed)
  return { roles: parsed }
}

// 役職を削除する。使っているメンバー(休止中を含む)は moveToRoleId の役職に移す。
// 最上位(top)・一般の役職は削除できない。メンバーを移す場合は最上位の役職を持つ人だけ
function deleteRole_(acting, roleId, moveToRoleId) {
  var roles = getRoles_()
  var target = requireKnownRole_(roleId)
  if (target.tier === 'base' || target.id === TOP_ROLE_ID || (!hasRolesSetting_() && target.name === DEFAULT_TOP_ROLE_NAME)) {
    throw userError_('この役職は削除できません: ' + target.name)
  }
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
  var holders = rows.filter(function (r) { return sameRole_(roles, r[roleCol], target.id) }).map(function (r) { return String(r[idCol]) })
  var moveTo = null
  if (holders.length > 0) {
    if (!isTopRoleRef_(roles, acting.role)) throw userError_('メンバーのいる役職を削除する(メンバーを別の役職に移す)のは、最上位の役職を持つメンバーだけが行えます。')
    moveTo = requireKnownRole_(moveToRoleId)
    if (moveTo.id === target.id) throw userError_('移す先の役職が、削除する役職と同じです。')
  }
  var remaining = roles.filter(function (r) { return r.id !== target.id })
  var memberChanges = {}
  holders.forEach(function (id) { memberChanges[id] = { role: moveTo.id } })
  assertTopRemains_({ roles: remaining, members: memberChanges })
  holders.forEach(function (id) {
    updateMemberFields_(id, { role: moveTo.id })
  })
  writeRoles_(remaining)
  return { roles: remaining, moved: holders.length }
}

// 役職の一覧を、今の保存先に書く(roles が無い間は今までの設定、ある時は roles)
function writeRoles_(roles) {
  if (hasRolesSetting_()) {
    updateSetting_('roles', JSON.stringify(roles))
  } else {
    var legacy = rolesToLegacySettings_(roles)
    Object.keys(legacy).forEach(function (key) { updateSetting_(key, legacy[key]) })
  }
  invalidateRoles_()
}

// コードで書く団体(VALUE_FORMAT=codes)で役職の設定(roles)がまだ無ければ作る。
// 今までの役職の設定があればそれを元に、無ければ既定の役職で作る
function setupRolesSetting_() {
  if (!isCodesFormat_()) return 'legacy'
  invalidateRoles_()
  if (hasRolesSetting_()) return 'already'
  var legacy = readRoleSettings_()
  var hasLegacy = ['role_levels', 'restricted_roles', 'role_permissions', 'job_requirements'].some(function (k) { return !!legacy[k] })
  var roles = hasLegacy ? rolesWithCodeIds_(getRoles_()) : defaultRoles_()
  updateSetting_('roles', JSON.stringify(roles))
  invalidateRoles_()
  console.log('🆕 役職の設定(roles)を作成しました: ' + roles.map(function (r) { return r.name }).join('・'))
  return 'created'
}

// Settings のうち、中に選択肢の値を持つキー(sheetSettingValue_ で形式を変えるもの)
var CODE_SETTING_KEYS = ['project_templates', 'task_set_templates', 'recurring_rules', 'skill_level_thresholds']

// 選択肢の値を持ちうるデータがあるシートの名前の一覧。Settings は、setupOhsumi が
// 作る初期キー(団体名など)を除き、CODE_SETTING_KEYS に値がある場合だけ数える
function sheetsWithData_(ss) {
  var found = []
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet || sheet.getLastRow() < 2) return
    if (name !== SHEET_SETTINGS) { found.push(name); return }
    var headers = headerRow_(sheet)
    var keyCol = headers.indexOf('key')
    var valueCol = headers.indexOf('value')
    if (keyCol === -1 || valueCol === -1) return
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    var hasCodeSetting = rows.some(function (r) {
      return CODE_SETTING_KEYS.indexOf(String(r[keyCol])) >= 0 && String(r[valueCol] || '').trim() !== ''
    })
    if (hasCodeSetting) found.push(name)
  })
  return found
}

// 新しく導入する団体(データ行が1行も無い)では VALUE_FORMAT を codes にして、
// 最初からコードで書く。データが既にある場合は変えない(日本語のまま書き、
// 移行の関数で移行する)。既に codes の場合もそのまま。
// 返り値: 'already'(既に codes)/ 'set'(codes にした)/ 'hasData'(変えなかった)
function setupValueFormat_(ss) {
  var props = PropertiesService.getScriptProperties()
  if (props.getProperty('VALUE_FORMAT') === 'codes') {
    console.log('✅ 選択肢の値の形式: コード(VALUE_FORMAT=codes)')
    return 'already'
  }
  var withData = sheetsWithData_(ss)
  if (withData.length === 0) {
    setRequestProp_('VALUE_FORMAT', 'codes')
    console.log('🆕 データが無いため、選択肢の値を最初からコードで書き込みます(VALUE_FORMAT=codes に設定しました)')
    return 'set'
  }
  console.log(
    'ℹ️ 選択肢の値の形式: 日本語のまま書き込みます(既にデータがあるシート: ' + withData.join('・') + ')。' +
      'VALUE_FORMAT は変えていません。内部コードへの移行は、移行の関数 migrateToInternalCodes() で行ってください(gas/README.md の「内部コードへの移行」)。' +
      'VALUE_FORMAT を手で設定しないでください',
  )
  return 'hasData'
}

// ---- 画像アップロード用フォルダ ------------------------------------------------
//
// プロフィール画像・団体ロゴ・経費の領収書・アンケート設問の画像の保存先。
// フォルダIDはスクリプトプロパティにだけ持ち、リクエストで渡されたフォルダIDは
// 使わない（任意のフォルダへの書き込みを防ぐため）。

var UPLOAD_FOLDER_PROPERTY_KEY = 'UPLOAD_FOLDER_ID'
// 移行前のファイルがあるフォルダ(カンマ区切りで複数可)。getFiles はこれらの
// フォルダ内のファイルも返す(将来、FSIFの本番を移行するときに旧フォルダの
// 画像を表示するため)。スクリプトプロパティに手動で設定する。
var LEGACY_UPLOAD_FOLDERS_PROPERTY_KEY = 'LEGACY_UPLOAD_FOLDER_IDS'
// 'true' のとき、新しくアップロードしたファイルを非公開のままにする。
// makeUploadsPrivate() の実行時に 'true' になる(段階③)。それまでは、公開CSV
// 時代のフロントでも表示できるよう「リンクを知っている全員が閲覧可」にする。
var UPLOADS_PRIVATE_PROPERTY_KEY = 'UPLOADS_PRIVATE'
var UPLOAD_FOLDER_NAME = 'Ohsumi uploads'

// スクリプトプロパティにフォルダIDがなければ、スクリプトを実行している
// アカウントのDriveにフォルダを作成してIDを保存する。既にあれば何もしない。
function ensureUploadFolder_() {
  var props = PropertiesService.getScriptProperties()
  var existingId = props.getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (existingId) {
    console.log('✅ アップロード用フォルダ既存: ' + existingId)
    return existingId
  }
  var folder = DriveApp.createFolder(UPLOAD_FOLDER_NAME)
  props.setProperty(UPLOAD_FOLDER_PROPERTY_KEY, folder.getId())
  console.log('✅ アップロード用フォルダ作成: ' + folder.getName() + ' (' + folder.getId() + ')')
  return folder.getId()
}

function applyUploadSharing_(file) {
  if (PropertiesService.getScriptProperties().getProperty(UPLOADS_PRIVATE_PROPERTY_KEY) === 'true') return
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
}

// 領収書の種類とサイズの確認(フロントの expense-application-modal.tsx と同じ基準)。
// ブラウザによっては HEIC の種類が空で届くため、拡張子でも判定する。
var RECEIPT_MAX_BYTES = 5 * 1024 * 1024
var RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
var RECEIPT_EXTENSION_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
}
function validateReceiptFile_(mimeType, filename, byteLength) {
  if (byteLength > RECEIPT_MAX_BYTES) throw userError_('領収書のファイルサイズは5MBまでです。')
  var mime = String(mimeType || '').toLowerCase()
  if (RECEIPT_MIME_TYPES.indexOf(mime) >= 0) return mime
  var ext = String(filename || '').toLowerCase().split('.').pop()
  var byExt = RECEIPT_EXTENSION_MIME[ext]
  if (byExt && (!mime || mime === 'application/octet-stream')) return byExt
  throw userError_('領収書は画像(JPEG・PNG・HEICなど)またはPDFのみアップロードできます。')
}

function getUploadFolder_() {
  var folderId = PropertiesService.getScriptProperties().getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (!folderId) throw userError_('Drive folder is not configured. Run setupOhsumi() in the Apps Script editor.')
  return DriveApp.getFolderById(folderId)
}

// シートが存在しなければ作成し、不足しているヘッダー列を末尾に追加する。
// 既存のデータ行や既存の列は一切変更しない。
function ensureSheetHeaders_(ss, sheetName, requiredHeaders) {
  var sheet = ss.getSheetByName(sheetName)
  if (!sheet) {
    sheet = ss.insertSheet(sheetName)
    sheet.appendRow(requiredHeaders)
    console.log('📄 シート作成: ' + sheetName + ' (' + requiredHeaders.length + ' 列)')
    return
  }

  var lastCol = sheet.getLastColumn()
  var existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim() })
    : []

  var missing = requiredHeaders.filter(function (h) { return existing.indexOf(h) === -1 })
  if (missing.length === 0) {
    console.log('✅ ' + sheetName + ': ヘッダー問題なし (' + existing.length + ' 列)')
    return
  }

  // 不足列を1行目の末尾に追加（既存データ行は空欄のままで問題ない）
  var startCol = lastCol + 1
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing])
  console.log('➕ ' + sheetName + ': ' + missing.length + ' 列追加 — ' + missing.join(', '))
}

// 行を末尾に追加する。値は {列名: 値} で渡し、シートの実際の列の順番に合わせて並べる
// (列の順番を前提にした配列で追加すると、列が足された古いシートでずれるため)。
// 一覧(SHEET_HEADERS)に無い列名は、書き込み先が無いのでエラーにする。
function appendRowByHeaders_(sheet, sheetName, obj) {
  var headers = headerRow_(sheet)
  var unknown = Object.keys(obj).filter(function (k) { return headers.indexOf(k) === -1 })
  if (unknown.length) {
    throw userError_(sheetName + 'シートに列が見つかりません: ' + unknown.join(', ') +
      '。Apps Scriptエディタで setupOhsumi() を実行してヘッダー列を追加してください。')
  }
  var row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : '' })
  assertRowCellLengths_(sheetName, headers, row)
  protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, sheetName)
  sheet.appendRow(row)
}

// A member is completing a certain number of same-category tasks and
// auto-certifying isn't something this file does — that check runs
// client-side (lib/ohsumi/store.tsx) since it only needs data already in
// hand. This file only handles writes coming from the browser.

// doGet が何から呼ばれたかを実行ログに残す。値は個人情報を含み得るので、パラメータの名前と
// 値の長さだけを残す(値そのものは残さない)
function logGetRequest_(e) {
  try {
    var params = (e && e.parameter) || {}
    var summary = Object.keys(params).map(function (k) { return k + '(' + String(params[k]).length + '文字)' })
    console.log('doGet に届きました: ' + JSON.stringify({
      parameters: summary,
      queryStringLength: e && e.queryString ? String(e.queryString).length : 0,
      pathInfo: e && e.pathInfo ? String(e.pathInfo).slice(0, 100) : '',
      contentLength: e && e.contentLength != null ? e.contentLength : -1,
      postDataType: e && e.postData ? String(e.postData.type || '') : '',
    }))
  } catch (err) {
    // 記録できなくても応答は返す
  }
}

// ---- Authentication & Authorization ----------------------------------------

// メンバーIDから、操作するメンバーの { id, role, project_ids, permission_overrides } を返す
// (セッショントークンのメンバーID)
function getActingMemberById_(memberId) {
  memberId = String(memberId)
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var projectIdsCol = headers.indexOf('project_ids')
  var overridesCol = headers.indexOf('permission_overrides_json')
  var inactiveCol = headers.indexOf('inactive')
  if (idCol < 0) throw userError_('Membersシートの構造が不正です。')
  var data = sheet.getDataRange().getValues()
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === memberId) {
      var overrides = []
      if (overridesCol >= 0) {
        try { overrides = JSON.parse(data[i][overridesCol] || '[]') } catch (_) {}
      }
      return {
        id: String(data[i][idCol]),
        role: String(data[i][roleCol] || ''),
        project_ids: String(data[i][projectIdsCol] || '').split(',').map(function (s) { return s.trim() }).filter(Boolean),
        permission_overrides: Array.isArray(overrides) ? overrides : [],
        inactive: inactiveCol >= 0 && isInactiveValue_(data[i][inactiveCol]),
      }
    }
  }
  // MemberEmails側には行があるがMembers側に対応する行が無い(データ不整合) —
  // 通常起こらないはずだが、安全側に倒して「見つからない」として扱う
  throw userError_('メンバー登録が見つかりません。管理者にお問い合わせください。')
}

// 読み取りだけの操作は、getInitialData と同じ読み取りキャッシュ(スナップショット)から、
// 操作するメンバーと役職の設定を引く(Members・Settings をシートから読み直さない)。
// スナップショットはデータの版ごとに持ち、書き込み・手動の編集のたびに版が変わるので、
// 画面に見えているデータと同じ時点の権限で判定する。書き込みは、これまでどおりシートから読む
var SNAPSHOT_AUTH_ACTIONS = [
  'getBackgroundData', 'getExpenses', 'getFormSubmissions', 'getCandidates', 'getFiles',
  'getMyEmails', 'getWebhookStatus', 'fetchDailyReports', 'getInviteMailStatus', 'sendInviteLinkToMe',
  'getMailQuotaStatus', 'getGasUpdateStatus',
]

// スナップショットの Members からメンバーを探す。見つからなければ null(呼び出し元がシートを読む)
function actingMemberFromTable_(table, memberId) {
  if (!table || !table.headers) return null
  var h = table.headers
  var idCol = h.indexOf('id')
  if (idCol < 0) return null
  var roleCol = h.indexOf('role')
  var projectIdsCol = h.indexOf('project_ids')
  var overridesCol = h.indexOf('permission_overrides_json')
  var inactiveCol = h.indexOf('inactive')
  for (var i = 0; i < table.rows.length; i++) {
    var row = table.rows[i]
    if (String(row[idCol]) !== String(memberId)) continue
    var overrides = []
    if (overridesCol >= 0) {
      try { overrides = JSON.parse(row[overridesCol] || '[]') } catch (_) {}
    }
    return {
      id: String(row[idCol]),
      role: roleCol >= 0 ? String(row[roleCol] || '') : '',
      project_ids: projectIdsCol >= 0 ? String(row[projectIdsCol] || '').split(',').map(function (s) { return s.trim() }).filter(Boolean) : [],
      permission_overrides: Array.isArray(overrides) ? overrides : [],
      inactive: inactiveCol >= 0 && isInactiveValue_(row[inactiveCol]),
    }
  }
  return null
}

// スナップショットの Settings から、役職の設定だけを取り出す
function roleSettingsFromTable_(table) {
  var out = {}
  if (!table || !table.headers) return out
  var keyCol = table.headers.indexOf('key')
  var valueCol = table.headers.indexOf('value')
  if (keyCol < 0 || valueCol < 0) return out
  table.rows.forEach(function (r) {
    var key = String(r[keyCol])
    if (ROLE_SETTING_KEYS.indexOf(key) >= 0) out[key] = String(r[valueCol] || '')
  })
  return out
}

// 権限そのものを変える操作。これらは、操作するメンバー・役職・判定に使う行をシートから読んで判定する
// (代表だけ・全権管理者だけの操作と、メンバーの状態・担当を変える操作)。
// それ以外の書き込みは、スナップショットから判定する(getActingMember_)。
// 代表だけ・全権管理者だけの操作を authorizeAction_ に足した時は、ここにも足すこと
// (lib/ohsumi/gas-write-auth.test.ts で確かめる)
var SHEET_AUTH_ACTIONS = [
  // 代表だけ
  'updateRole', 'removeMember', 'removeProject', 'uploadOrgLogo', 'addMember', 'updateEmail', 'updateJoinedAt',
  'updateReportsTo', 'updateMentor', 'notifyTrainingDecision', 'updatePermissionOverrides', 'updateMemberProjects',
  'addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember',
  // 代表・全権管理者だけ(役職・部門・設定・通知先・ログインの取り消し)
  'updateSetting', 'updateRoles', 'deleteRole', 'updateDepartments', 'deleteDepartment', 'moveDepartmentTasks',
  'updateDiscordWebhookUrl', 'updateSlackWebhookUrl', 'testDiscordWebhook', 'testSlackWebhook', 'updateProjectHealth',
  'revokeMemberSessions',
  // メンバーの状態・部門・プロジェクトの担当(班長の担当範囲の判定に使う)
  'updateMemberInactive', 'updateMemberDepartmentPath', 'updateProjectMembers',
]

// 権限の判定に使ったスナップショットの版(シートから判定した時は null)
var _authSnapshotVersion = null

// 操作するメンバーを引く。権限そのものを変える操作(SHEET_AUTH_ACTIONS)はシートから、
// それ以外(読み取り・普通の書き込み)はスナップショットから(役職の設定もそこから)。
// スナップショットに見つからない・読めない時はシートから
// ---- 休止中のメンバー --------------------------------------------------------
// 休止中(Members の inactive が TRUE)のメンバーは、ログインできず、発行済みのセッションも使えない。
// 休止にした時は、そのメンバーのセッションを無効にする(updateMemberInactive)。シートを直接書き換えて
// 休止にした時も、次のリクエストで断る(操作するメンバーを引く時に確かめる)。休止を解除すれば、またログインできる
var INACTIVE_MEMBER_MESSAGE = 'このアカウントは休止中のため、ログインできません。代表に休止の解除を依頼してください。'

function isInactiveValue_(v) {
  return v === true || String(v || '').trim().toUpperCase() === 'TRUE'
}

// 休止中か(スナップショットの Members で確かめる。読めなければシート)
function memberIsInactive_(memberId) {
  var row = snapshotRowOrSheet_(SHEET_MEMBERS, memberId)
  return !!row && isInactiveValue_(row.inactive)
}

function getActingMember_(memberId, action) {
  _authSnapshotVersion = null
  if (SNAPSHOT_AUTH_ACTIONS.indexOf(action) >= 0 || SHEET_AUTH_ACTIONS.indexOf(action) < 0) {
    try {
      var snap = loadSnapshot_()
      var member = actingMemberFromTable_(snap.data.Members, memberId)
      if (member) {
        _requestRoles = requestRolesFrom_(roleSettingsFromTable_(snap.data.Settings))
        _authSnapshotVersion = snap.version
        noteTiming_('authFrom', 'snapshot')
        return member
      }
    } catch (e) {
      // 読めなければシートから
    }
  }
  return getActingMemberFromSheet_(memberId)
}

function getActingMemberFromSheet_(memberId) {
  _authSnapshotVersion = null
  _requestRoles = null
  noteTiming_('authFrom', 'sheet')
  return getActingMemberById_(memberId)
}

// 権限の判定に使う操作の名前。まとめて送られた書き込みは、権限そのものを変える操作が1つでも
// あればその操作(シートから判定する)、無ければ最初の操作
function requestAuthAction_(body) {
  if (!body || body.action !== 'batch') return body && body.action
  var ops = body.ops || []
  for (var i = 0; i < ops.length; i++) {
    if (SHEET_AUTH_ACTIONS.indexOf(ops[i].action) >= 0) return ops[i].action
  }
  return ops.length ? ops[0].action : 'batch'
}

// スナップショットで判定した後に、スナップショットの版が変わったか(ロックを取った後に確かめる)。
// 変わっていたら、判定の間にほかの書き込みで権限が変わったかもしれないので、シートから判定し直す
function authSnapshotChanged_() {
  if (_authSnapshotVersion === null) return false
  return getDataVersion_() !== _authSnapshotVersion
}

// 権限の判定で使う行(タスクの担当者・プロジェクト、登録者の上長など)。スナップショットで判定している時は
// 同じ版のスナップショットから、そうでなければシートから読む(findRow_ と同じ形。値は表示の文字列)
function authFindRow_(sheetName, rowId) {
  if (_authSnapshotVersion !== null && _requestSnapshot && _requestSnapshot.version === _authSnapshotVersion) {
    var table = _requestSnapshot.data[sheetName]
    var idCol = table && table.headers ? table.headers.indexOf('id') : -1
    if (idCol >= 0) {
      for (var i = 0; i < table.rows.length; i++) {
        if (String(table.rows[i][idCol]) !== String(rowId)) continue
        var obj = {}
        table.headers.forEach(function (h, c) { obj[h] = table.rows[i][c] })
        return obj
      }
      return null
    }
  }
  return findRow_(sheetName, rowId)
}

// ---- ログイン(IDトークン)とセッショントークン ----------------------------------
//
// ログインの流れ:
//   1. フロントが getLoginConfig で団体ID(ORG_ID)を取得する(認証不要)
//   2. フロントは乱数 r を作り、nonce = ORG_ID + "." + base64url(SHA-256(r)) で
//      Google Identity Services(google.accounts.id)の IDトークンを受け取る
//   3. exchangeIdToken で IDトークンと r を送る。ここで tokeninfo により署名・
//      有効期限を確認し、aud(クライアントID)・iss・email_verified・nonce を確かめる
//      (nonce は1回だけ使える)。登録済みのメンバーなら、この団体の秘密鍵で署名した
//      セッショントークンを発行する
//   4. 以降のリクエストはセッショントークンだけで認証する(Google への問い合わせなし)
//
// セッショントークン: "v1.<payload(base64url JSON)>.<HMAC-SHA256(base64url)>"
//   payload = { org, sub(メンバーID), gen(世代番号), kid(鍵ID), sid, iat, exp, auth(ログイン時刻), rem }
//   別の団体のトークン(org・鍵が違う)、改ざん、有効期限切れ、SESSION_NOT_BEFORE より前に
//   発行されたもの、世代番号が古いもの(全端末でログアウト済み)は受け付けない。
//
// スクリプトプロパティ(1回のリクエストで getProperties() を1回だけ読む — requestProps_ 参照):
//   ORG_ID / SESSION_SIGNING_KEY / SESSION_KEY_ID  setupOhsumi() が作成する
//   SESSION_NOT_BEFORE   これより前(秒)に発行されたセッションを無効にする
//   SESSION_GEN_<メンバーID>  メンバーごとの世代番号(全端末でログアウトで1増える)

var SESSION_TOKEN_VERSION = 'v1'
// チェックあり(この端末に保存): 1回14日、Googleでのログインから最長30日
var SESSION_TTL_REMEMBER_SEC = 14 * 24 * 3600
var SESSION_MAX_REMEMBER_SEC = 30 * 24 * 3600
// チェックなし: 12時間(延長しない)
var SESSION_TTL_TEMP_SEC = 12 * 3600
// 使用済みの nonce を覚えておく時間(IDトークンの有効期間と同じ1時間)
var ID_TOKEN_NONCE_TTL_SEC = 3600
var SESSION_GEN_PREFIX = 'SESSION_GEN_'

// 1回のリクエスト(実行)の間は、スクリプトプロパティを getProperties() で1回だけ読み、
// その結果を使う(読み取り回数の上限対策)。この実行の中で書き込んだ値は setRequestProp_ で
// 反映する。doPost の最初に resetRequestProps_() で読み直す。
var _requestProps = null

function resetRequestProps_() {
  _requestProps = null
  _requestRoles = null
  _requestDepartments = null
}

function requestProps_() {
  if (!_requestProps) _requestProps = PropertiesService.getScriptProperties().getProperties() || {}
  return _requestProps
}

function setRequestProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value)
  if (_requestProps) _requestProps[key] = value
}

function nowSec_() {
  return Math.floor(Date.now() / 1000)
}

function base64UrlEncode_(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '')
}

function base64UrlDecodeToString_(text) {
  var s = String(text)
  while (s.length % 4) s += '='
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8')
}

function sha256Base64Url_(text) {
  return base64UrlEncode_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8))
}

// 推測できない値を作る(Utilities.getUuid を複数と時刻を SHA-256 でまとめる)
function generateSecret_() {
  var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now())].join(':')
  return base64UrlEncode_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8))
}

// 長さの違いも含めて、比較にかかる時間が内容で変わらないように比べる
function constantTimeEquals_(a, b) {
  a = String(a)
  b = String(b)
  var diff = a.length ^ b.length
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0)
  }
  return diff === 0
}

// ORG_ID・秘密鍵・鍵IDが無ければ作る(setupOhsumi から呼ぶ)。既にあれば変えない
function ensureSessionSecrets_() {
  var props = PropertiesService.getScriptProperties()
  var created = []
  if (!props.getProperty('ORG_ID')) {
    props.setProperty('ORG_ID', 'org_' + generateSecret_().slice(0, 20))
    created.push('ORG_ID')
  }
  if (!props.getProperty('SESSION_SIGNING_KEY') || !props.getProperty('SESSION_KEY_ID')) {
    props.setProperty('SESSION_SIGNING_KEY', generateSecret_())
    props.setProperty('SESSION_KEY_ID', generateSecret_().slice(0, 8))
    created.push('SESSION_SIGNING_KEY', 'SESSION_KEY_ID')
  }
  resetRequestProps_()
  return created
}

function signSessionPayload_(payloadB64, key) {
  return base64UrlEncode_(Utilities.computeHmacSha256Signature(SESSION_TOKEN_VERSION + '.' + payloadB64, key))
}

function sessionGeneration_(memberId) {
  return Number(requestProps_()[SESSION_GEN_PREFIX + memberId] || 0)
}

// セッショントークンを発行する。auth は Google でログインした時刻(秒)
function issueSessionToken_(memberId, remember, auth) {
  var props = requestProps_()
  var key = props.SESSION_SIGNING_KEY
  var kid = props.SESSION_KEY_ID
  var org = props.ORG_ID
  if (!key || !kid || !org) {
    throw userError_('ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。')
  }
  var now = nowSec_()
  var exp = remember
    ? Math.min(now + SESSION_TTL_REMEMBER_SEC, auth + SESSION_MAX_REMEMBER_SEC)
    : Math.min(now + SESSION_TTL_TEMP_SEC, auth + SESSION_TTL_TEMP_SEC)
  var payload = {
    org: org,
    sub: String(memberId),
    gen: sessionGeneration_(memberId),
    kid: kid,
    sid: generateSecret_().slice(0, 16),
    iat: now,
    exp: exp,
    auth: auth,
    rem: !!remember,
  }
  var payloadB64 = base64UrlEncode_(JSON.stringify(payload))
  return { token: SESSION_TOKEN_VERSION + '.' + payloadB64 + '.' + signSessionPayload_(payloadB64, key), exp: exp, remember: !!remember }
}

// セッショントークンを確かめ、payload を返す。受け付けない場合は理由つきで例外を投げる
function verifySessionToken_(token) {
  var props = requestProps_()
  var parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_VERSION || !parts[1] || !parts[2]) {
    throw userError_('ログイン情報の形式が不正です。再ログインしてください。')
  }
  if (!props.SESSION_SIGNING_KEY || !props.ORG_ID) {
    throw userError_('ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。')
  }
  if (!constantTimeEquals_(signSessionPayload_(parts[1], props.SESSION_SIGNING_KEY), parts[2])) {
    throw userError_('ログイン情報が無効です。再ログインしてください。')
  }
  var payload
  try {
    payload = JSON.parse(base64UrlDecodeToString_(parts[1]))
  } catch (e) {
    throw userError_('ログイン情報の形式が不正です。再ログインしてください。')
  }
  if (!payload || payload.org !== props.ORG_ID) throw userError_('この団体のログイン情報ではありません。再ログインしてください。')
  if (payload.kid !== props.SESSION_KEY_ID) throw userError_('ログイン情報が無効になりました。再ログインしてください。')
  var now = nowSec_()
  if (!(Number(payload.exp) > now)) throw userError_('ログインの有効期限が切れました。再ログインしてください。')
  var notBefore = Number(props.SESSION_NOT_BEFORE || 0)
  if (Number(payload.iat) < notBefore) throw userError_('ログイン情報が無効になりました。再ログインしてください。')
  if (!payload.sub) throw userError_('ログイン情報の形式が不正です。再ログインしてください。')
  if (Number(payload.gen) !== sessionGeneration_(payload.sub)) {
    throw userError_('この端末のログインは無効になりました(全端末でログアウト済み)。再ログインしてください。')
  }
  return payload
}

// 残りが半分を切ったら新しいトークンを発行する(上限はGoogleでのログインから30日。
// チェックなしのセッションは延長しない)
function renewSessionIfNeeded_(payload) {
  if (!payload.rem) return null
  var now = nowSec_()
  var remaining = Number(payload.exp) - now
  if (remaining > SESSION_TTL_REMEMBER_SEC / 2) return null
  var renewed = issueSessionToken_(payload.sub, true, Number(payload.auth))
  // 上限に近づいて期限がほとんど延びない場合は発行しない
  if (renewed.exp - Number(payload.exp) < 3600) return null
  return renewed
}

// Google の IDトークンを tokeninfo で確かめ、nonce がこの団体・この端末のものかを確かめる。
// 成功したら { email, iat } を返す
function verifyGoogleIdToken_(idToken, nonceSecret) {
  var props = requestProps_()
  var clientId = props.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId) throw userError_('サーバー側の設定(GOOGLE_OAUTH_CLIENT_ID)が未設定です。管理者にお問い合わせください。')
  if (!props.ORG_ID) throw userError_('ログインの設定が完了していません。管理者に setupOhsumi の実行を依頼してください。')
  if (!/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(String(idToken || '')) || String(idToken).length > 4096) {
    throw userError_('ログインの情報の形式が不正です。もう一度ログインしてください。')
  }
  if (!nonceSecret || String(nonceSecret).length < 16 || String(nonceSecret).length > 256) {
    throw userError_('ログインの情報の形式が不正です。もう一度ログインしてください。')
  }
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), {
    muteHttpExceptions: true,
  })
  if (resp.getResponseCode() !== 200) {
    throw userError_('Googleのログイン情報を確認できませんでした(有効期限切れなど)。もう一度ログインしてください。')
  }
  var info = JSON.parse(resp.getContentText())
  if (info.aud !== clientId) throw userError_('ログイン情報の発行元がこのアプリと一致しません。')
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    throw userError_('ログイン情報の発行元が不正です。')
  }
  if (!(Number(info.exp) > nowSec_())) throw userError_('Googleのログイン情報の有効期限が切れています。もう一度ログインしてください。')
  if (!info.email) throw userError_('ログイン情報からメールアドレスを取得できませんでした。')
  if (info.email_verified !== true && info.email_verified !== 'true') {
    throw userError_('メールアドレスが確認されていないGoogleアカウントのため利用できません。')
  }
  var expectedNonce = props.ORG_ID + '.' + sha256Base64Url_(nonceSecret)
  if (!info.nonce || !constantTimeEquals_(info.nonce, expectedNonce)) {
    throw userError_('ログイン情報がこの団体・この画面のものではありません。もう一度ログインしてください。')
  }
  // 同じIDトークン(nonce)は1回だけ使える
  var cache = CacheService.getScriptCache()
  var nonceKey = 'idnonce:' + sha256Base64Url_(info.nonce)
  if (cache.get(nonceKey)) throw userError_('このログイン情報は既に使われています。もう一度ログインしてください。')
  cache.put(nonceKey, '1', ID_TOKEN_NONCE_TTL_SEC)
  return { email: String(info.email), iat: Number(info.iat) || nowSec_() }
}

// exchangeIdToken: IDトークンをセッショントークンに交換し、初期データもまとめて返す
// ---- レジストリへの登録と、最初の代表(R1-c) -------------------------------------------
//
// 団体のスプレッドシートの「Ohsumi」メニューから行う(エディタの実行ログに、コード・鍵を残さないため)。
//   - 「レジストリに登録する…」: FSIF から受け取った登録コード(または再登録コード)を入力欄に入れる
//     (スクリプトプロパティにもログにも残さない)。レジストリに1回の通信で登録し、共有鍵を受け取って
//     スクリプトプロパティ REGISTRY_SHARED_KEY に保存する(値は表示しない)。
//     代表がまだいなければ、初期設定コードを作り、その場のダイアログにだけ1回表示する
//   - 「初期設定コードを作り直す」: 代表がまだいない時だけ。前のコードは使えなくなる
// 送り直し: 登録の前に乱数 registerNonce(32バイト)を作り、スクリプトプロパティ REGISTRY_PENDING に保存してから送る。
// 通信が途中で失われた時は、同じ registerNonce で最大3回送る。別の時にメニューからやり直した時も、同じ登録コードなら
// 同じ registerNonce を使う(REGISTRY_PENDING には registerNonce とコードの SHA-256 だけを覚え、登録できたら消す)。
// レジストリは、registerNonce が合う時だけ(登録から24時間まで)同じ結果を返す。使用済みの登録コードだけでは、
// 共有鍵を受け取れない
//
// この GAS の URL(レジストリに伝える接続先): スクリプトプロパティ OHSUMI_WEBAPP_URL(無ければ ScriptApp の URL)。
// https://script.google.com/macros/s/…/exec の形だけを使い、/dev・/u/1/・/a/macros/<ドメイン>/・? や # の付いたものは
// 送る前に断る(checkOwnWebAppUrl_)。メニューでは、送る前に登録する URL を表示する
//
// 初期設定コード: 16文字(読み間違えない31種類の文字)。有効期限72時間・1回限り。スクリプトプロパティには
// SHA-256 だけを保存する。最初の代表は、ログイン画面の「初期設定コード」の欄に入れて Google でログインする
// (exchangeIdToken に setupCode を付ける。1回の通信)。間違いが INITIAL_SETUP_FAIL_LIMIT 回続いたら、
// そのコードは使えなくなる(メニューで作り直す)
var REGISTRY_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/
var REGISTER_NONCE_PATTERN = /^[A-Za-z0-9_-]{43,64}$/
var REGISTRY_FETCH_ATTEMPTS = 3
var INITIAL_SETUP_TTL_HOURS = 72
var INITIAL_SETUP_FAIL_LIMIT = 10
var SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
var SETUP_CODE_LENGTH = 16
// レジストリに伝える、この GAS の版(Orgs の gas_version)。日付の形「YYYY.MM.DD-N」。
// このファイルを変えたら pnpm gas:version で上げる(上げ忘れると lib/ohsumi/gas-version.test.ts が失敗する)。
// 出した版は、レジストリの KNOWN_GAS_VERSIONS にも足す
var OHSUMI_GAS_VERSION = '2026.10.02-2'

function sha256HexOf_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2) }).join('')
}

// 入力のゆれ(小文字・区切り・空白)をそろえる
function normalizeOneTimeCode_(input) {
  return String(input || '').toUpperCase().replace(/[\s\-_]/g, '')
}

function oneTimeCodeHash_(input) {
  return 'sha256:' + sha256HexOf_(normalizeOneTimeCode_(input))
}

// 推測できない16文字(偏りが出ないよう、アルファベットの数の倍数を超えるバイトは捨てる)
function generateOneTimeCode_() {
  var n = SETUP_CODE_ALPHABET.length
  var limit = Math.floor(256 / n) * n
  var code = ''
  var round = 0
  while (code.length < SETUP_CODE_LENGTH) {
    var seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), String(Date.now()), String(round++)].join(':')
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8).forEach(function (b) {
      var v = b & 0xff
      if (code.length < SETUP_CODE_LENGTH && v < limit) code += SETUP_CODE_ALPHABET.charAt(v % n)
    })
  }
  return code
}

function formatOneTimeCode_(code) {
  return code.match(/.{1,4}/g).join('-')
}

function topRoleRef_() {
  var roles = getRoles_()
  for (var i = 0; i < roles.length; i++) if (roles[i].tier === 'top') return roles[i].id
  return DEFAULT_TOP_ROLE_NAME
}

// 代表(最上位の役職)のメンバーの ID(シートから読む)
function topMemberIds_() {
  var sheet = getSheet_(SHEET_MEMBERS)
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var roleCol = headers.indexOf('role')
  var idCol = headers.indexOf('id')
  if (roleCol < 0 || idCol < 0) return []
  var roles = getRoles_()
  var ids = []
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) && isTopRoleRef_(roles, values[i][roleCol])) ids.push(String(values[i][idCol]))
  }
  return ids
}

// 代表(最上位の役職)のメンバーがいるか
function hasTopMember_() {
  return topMemberIds_().length > 0
}

// 初期設定コードを作る(前のコードは使えなくなる)。元のコードを返す(保存するのは SHA-256 だけ)
function createInitialSetupCode_(nowMs) {
  var code = generateOneTimeCode_()
  var props = PropertiesService.getScriptProperties()
  props.setProperty('INITIAL_SETUP_HASH', oneTimeCodeHash_(code))
  props.setProperty('INITIAL_SETUP_EXPIRES', String(nowMs + INITIAL_SETUP_TTL_HOURS * 3600 * 1000))
  props.deleteProperty('INITIAL_SETUP_FAILS')
  resetRequestProps_()
  return { code: formatOneTimeCode_(code), expiresAt: new Date(nowMs + INITIAL_SETUP_TTL_HOURS * 3600 * 1000).toISOString() }
}

function clearInitialSetupCode_(props) {
  props.deleteProperty('INITIAL_SETUP_HASH')
  props.deleteProperty('INITIAL_SETUP_EXPIRES')
  props.deleteProperty('INITIAL_SETUP_FAILS')
  resetRequestProps_()
}

var INITIAL_SETUP_INVALID = '初期設定コードが正しくないか、使えなくなっています(期限切れ・使用済み)。団体の担当者に、スプレッドシートの「Ohsumi」メニューで作り直してもらってください。'

// 最初の代表を団体に入れる(exchangeIdToken から。Google の IDトークンは確認済み)。メンバーID を返す
function claimInitialSetup_(email, code, nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(10000)
  try {
    var props = PropertiesService.getScriptProperties()
    var hash = props.getProperty('INITIAL_SETUP_HASH') || ''
    var expires = Number(props.getProperty('INITIAL_SETUP_EXPIRES') || 0)
    if (!hash) throw userError_(INITIAL_SETUP_INVALID)
    if (!constantTimeEquals_(hash, oneTimeCodeHash_(code))) {
      var fails = Number(props.getProperty('INITIAL_SETUP_FAILS') || 0) + 1
      if (fails >= INITIAL_SETUP_FAIL_LIMIT) {
        clearInitialSetupCode_(props)
        throw userError_('初期設定コードの間違いが続いたため、このコードは使えなくなりました。団体の担当者に、スプレッドシートの「Ohsumi」メニューで作り直してもらってください。')
      }
      props.setProperty('INITIAL_SETUP_FAILS', String(fails))
      throw userError_(INITIAL_SETUP_INVALID)
    }
    if (!(expires > nowMs)) {
      clearInitialSetupCode_(props)
      throw userError_(INITIAL_SETUP_INVALID)
    }
    // 1回限り: 使う前に消す(代表が既にいる時も使えなくする)
    clearInitialSetupCode_(props)
    if (hasTopMember_()) throw userError_('この団体には既に代表がいます。代表に、メンバーとして追加してもらってください。')
    var added = addMember_(String(email).split('@')[0], email, '', topRoleRef_())
    // メンバーが増えたので、読み取りのキャッシュ(スナップショット)を作り直させる
    bumpSnapshotVersion_()
    console.log('初期設定コードで、最初の代表を登録しました(メンバーID: ' + added.id + ')')
    return added.id
  } finally {
    lock.releaseLock()
  }
}

// この GAS のウェブアプリの URL(レジストリに伝える接続先)
function ownWebAppUrl_(all) {
  var url = String((all || {}).OHSUMI_WEBAPP_URL || '').trim()
  if (url) return url
  try { return String(ScriptApp.getService().getUrl() || '') } catch (e) { return '' }
}

// レジストリに伝えてよい URL か。問題があれば、直し方の文を返す(無ければ '')
function checkOwnWebAppUrl_(url) {
  var how = 'デプロイの画面(デプロイ → デプロイを管理)に出るウェブアプリの URL(https://script.google.com/macros/s/…/exec)を、' +
    'そのままスクリプトプロパティ OHSUMI_WEBAPP_URL に入れてください。'
  url = String(url || '')
  if (!url) return 'この GAS のウェブアプリの URL が分かりません。先にウェブアプリとしてデプロイし、' + how
  if (REGISTRY_URL_PATTERN.test(url)) return ''
  var what = 'この GAS の URL(' + url + ')は、レジストリに登録できない形です'
  if (/\/dev(?:[?#].*)?$/.test(url)) what += '(/dev はエディタで試すための URL で、編集者しか使えません)'
  else if (/\/u\/\d+\//.test(url)) what += '(/u/1/ などは、複数の Google アカウントでログインしたブラウザのアドレスバーの形です)'
  else if (/\/a\/macros\//.test(url)) what += '(/a/macros/<ドメイン>/ は、Google Workspace のドメインの中だけの形です)'
  else if (/[?#]/.test(url)) what += '(? や # の後ろは付けません)'
  return what + '。' + how
}

// レジストリに登録する(メニューから。テストでは fetch を差し替える)。
// 返り値: { displayName, keyGen, kind, setupCode?, setupExpiresAt? }(共有鍵は返さない)
function registerWithRegistry_(code, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var now = deps.now || Date.now
  if (!normalizeOneTimeCode_(code)) throw userError_('登録コードを入れてください。')
  ensureSessionSecrets_()
  var props = PropertiesService.getScriptProperties()
  var all = props.getProperties() || {}
  var registryUrl = String(all.REGISTRY_URL || '').trim()
  if (!REGISTRY_URL_PATTERN.test(registryUrl)) {
    throw userError_('スクリプトプロパティ REGISTRY_URL に、FSIF から伝えられたレジストリの URL(https://script.google.com/macros/s/…/exec)を入れてください。')
  }
  var gasUrl = ownWebAppUrl_(all)
  var urlProblem = checkOwnWebAppUrl_(gasUrl)
  if (urlProblem) throw userError_(urlProblem)
  // 同じ登録コードでやり直す時は、同じ registerNonce を使う(レジストリが送り直しと分かるように)。
  // 送る前に保存する(応答が失われても、次に同じ値で送れるように)
  var codeHash = oneTimeCodeHash_(code)
  var pending = {}
  try { pending = JSON.parse(all.REGISTRY_PENDING || '{}') || {} } catch (e) { pending = {} }
  if (pending.codeHash !== codeHash || !REGISTER_NONCE_PATTERN.test(String(pending.registerNonce || ''))) {
    pending = { registerNonce: generateSecret_(), codeHash: codeHash }
    props.setProperty('REGISTRY_PENDING', JSON.stringify(pending))
  }
  var payload = JSON.stringify({
    action: 'registerOrg',
    code: normalizeOneTimeCode_(code),
    orgId: props.getProperty('ORG_ID'),
    gasUrl: gasUrl,
    gasVersion: OHSUMI_GAS_VERSION,
    registerNonce: pending.registerNonce,
  })
  var res = null
  var lastProblem = ''
  for (var attempt = 1; attempt <= REGISTRY_FETCH_ATTEMPTS && !res; attempt++) {
    try {
      var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
      var json = JSON.parse(r.getContentText())
      if (json && json.retryLater) { lastProblem = String(json.error || '混み合っています'); continue }
      if (json && json.getReceived) { lastProblem = 'レジストリに GET で届きました'; continue }
      res = json
    } catch (e) {
      lastProblem = '通信エラー・JSON ではない応答'
    }
  }
  if (!res) throw userError_('レジストリから応答を受け取れませんでした(' + lastProblem + ')。少し待ってから、同じ登録コードでもう一度お試しください(二重には登録されません)。')
  if (!res.ok || !res.result || !res.result.registryKey) {
    throw userError_(String(res.error || 'レジストリに登録できませんでした。'))
  }
  var out = res.result
  props.setProperty('REGISTRY_SHARED_KEY', String(out.registryKey))
  props.setProperty('REGISTRY_KEY_GEN', String(out.keyGen || ''))
  props.setProperty('REGISTRY_REGISTERED_AT', String(out.registeredAt || ''))
  props.deleteProperty('REGISTRY_PENDING')
  resetRequestProps_()
  // ログには共有鍵もコードも出さない
  console.log('レジストリに' + (out.kind === 'reissue' ? '再登録' : '登録') + 'しました(団体名: ' + out.displayName + '・鍵の世代: ' + out.keyGen + (res.replayed ? '・送り直しに対する前回の結果' : '') + ')')
  var result = { displayName: String(out.displayName || ''), keyGen: out.keyGen, kind: out.kind }
  if (!hasTopMember_()) {
    var setup = createInitialSetupCode_(now())
    result.setupCode = setup.code
    result.setupExpiresAt = setup.expiresAt
  }
  return result
}

function formatJaDateTime_(iso) {
  return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm')
}

function setupCodeMessage_(setupCode, expiresAt) {
  return '最初の代表の「初期設定コード」(この画面でだけ表示します。控えて、最初の代表に伝えてください):\n\n' +
    setupCode + '\n\n有効期限: ' + formatJaDateTime_(expiresAt) + '(72時間・1回限り)\n' +
    '最初の代表は、Ohsumi のログイン画面の「初期設定コード」の欄にこのコードを入れてから、Google でログインします。'
}

// ---- 提供停止・機能停止(R1-e) ---------------------------------------------------------
//
// 停止には2種類ある。どちらも FSIF がレジストリの管理画面で予定を入れる(14日より後)。
//   suspend(提供停止): この GAS は、ログインの設定(getLoginConfig)以外のすべての操作を断り(orgSuspended)、
//                      通知(sendBatchNotifications)・毎朝の処理(dailyMaintenance)も止める。データは消さない
//   restrict(機能停止): 読み取り(閲覧・書き出し)とログインだけを受け付け、作成・編集は断る(restricted)。
//                      通知・毎朝の処理は止めない。画面の上部に、アンケートへの回答のお願いを出す
// 状態は、1時間ごとのトリガー(checkContractStatus)でレジストリの checkIn に確かめ、スクリプトプロパティ
// CONTRACT_STATE に覚える。リクエストの時にも確かめ直す(currentContract_):
//   - 停止中(予定の日時を過ぎた時も)は、解除がすぐ効くように、どの操作でも1分に1回まで
//   - 停止の予定がある時は、書き込み(読み取りの一覧に無い操作)の前に1分に1回まで
//   - 停止の予定が無い時も、書き込みの前に10分に1回まで(レジストリで停止した後、書き込みを受け付け続けないように)
// レジストリに確かめられない時は、最後に確かめた状態のまま使い続ける(最後に届いた停止の予定の日時は守る)。
// 機能停止中は、READ_ONLY_ACTIONS(読み取り・ログイン)に無い操作をすべて断る。batch は、中の操作に関わらず断る。
// 画面の停止の表示は、この GAS が応答に付けた contract だけで決まる(画面は自分で停止を判断しない)。
// checkIn は、共有鍵(REGISTRY_SHARED_KEY)で 'checkIn.<団体ID>.<時刻(秒)>' に付けた HMAC-SHA256 の署名で確かめる。
// 停止の予定があれば、14日前・7日前・1日前に代表へメールで知らせる(送った予告は CONTRACT_NOTICES_SENT に覚える)。
// 応答には、画面が表示に使う contract({ phase, kind, suspendAt })を付ける
var CONTRACT_NOTICE_DAYS = [14, 7, 1]
var CONTRACT_RECHECK_SEC = 60
var CONTRACT_RECHECK_IDLE_SEC = 600
var CONTRACT_SUSPENDED_MESSAGE = 'この団体は、Ohsumi の利用を停止しています。'
var CONTRACT_RESTRICTED_MESSAGE = 'アンケートへの回答をお願いします。回答が確認でき次第、再開します。'
// 機能停止中にも受け付ける操作(読み取りの一覧)。ここに無い操作は、すべて断る(新しく足した操作も、ここに足さない限り断る)。
// 読み取り・ログイン(初期設定コードで代表を入れる時を除く)・ログインの記録・自分や管理者によるログインの無効化だけを入れる
var READ_ONLY_ACTIONS = [
  'exchangeIdToken', 'getInitialData', 'getBackgroundData', 'getMyEmails', 'getExpenses', 'getFiles',
  'getWebhookStatus', 'getCandidates', 'getFormSubmissions', 'fetchDailyReports', 'translateText',
  'revokeMySessions', 'revokeMemberSessions', 'updateLastLogin',
  // ほかの端末で開く: 本人あての招待リンクのメール(データを書き換えない)
  'getInviteMailStatus', 'sendInviteLinkToMe',
  // メールの1日の上限の状態・この GAS の版の更新(代表の管理画面に出す)
  'getMailQuotaStatus', 'getGasUpdateStatus',
  // バックアップの状態・一覧・戻す前の確かめ(戻すのは書き込みなので、機能停止中は断る)
  'getBackupStatus', 'listBackups', 'previewRestore', 'searchBackupTasks',
  // 個人情報の削除の予定(消す・延ばすのは書き込み)
  'getPersonalDataStatus',
  // 毎日・毎時の処理と共有の状態・長くなっている記録(読み取りだけ)
  'getOpsStatus',
  // 利用の集計とエラーの件数(代表の管理画面に出す。読み取りだけ)
  'getUsageStatus',
  // FSIF に送る集計値の状態・プレビュー・送信の履歴(読み取りだけ)
  'getMetricsStatus',
  // FSIF からのお知らせ(レジストリから取る。読み取りだけ)
  'getAnnouncements',
  // 診断情報の表示・送信(団体のシートは書き換えない。機能停止中も FSIF に問い合わせられるように)
  'getDiagnostics', 'sendDiagnostics',
]

// 機能停止中にも受け付ける操作か(初期設定コードで代表を入れるログインは、メンバーを足すので断る)
function readOnlyAllows_(body) {
  if (READ_ONLY_ACTIONS.indexOf(body.action) < 0) return false
  if (body.action === 'exchangeIdToken' && body.setupCode) return false
  return true
}

// ---- 機能のスイッチ(レジストリから団体の機能を止める) ----------------------------
//
// 不具合が見つかった時に、この GAS を更新し直す前に、その機能だけを止められるようにする。
// レジストリの checkIn が disabledFeatures(止める機能の ID の一覧。全団体の分と、その団体の分を合わせたもの)を返し、
// CONTRACT_STATE に覚える。書き込みの前の確かめ直し(10分に1回まで)で伝わるので、止めてから効くまで最大10分ほど。
// 知らない ID は無視する(レジストリの一覧の方が新しい時)。止めた操作は featureDisabled を付けて断る。
// ログイン・読み取り(READ_ONLY_ACTIONS)と、ログインの前の操作は、ここに入れない(止められない。テストで確かめる)。
// ID は、レジストリの FEATURE_IDS と同じにする(テストで確かめる)
//   actions: 止める操作
//   inside: 操作ではなく、処理の中で止めるもの(毎日の処理・通知の途中。画面には失敗を返さない)
var FEATURE_SWITCHES = {
  uploads: { label: 'ファイルのアップロード', actions: ['uploadAvatar', 'uploadOrgLogo', 'uploadExpenseReceipt', 'uploadSurveyImage'] },
  expenses: { label: '経費の申請・承認', actions: ['submitExpenseApplication', 'approveExpenseStep', 'rejectExpense', 'withdrawExpense', 'returnExpense', 'resubmitExpense', 'uploadExpenseReceipt'] },
  forms: { label: 'フォーム・アンケートの回答と承認', actions: ['updateTaskForm', 'notifyFormResult', 'submitCustomForm', 'approveFormStep', 'rejectFormSubmission'] },
  schedule: { label: '日程調整', actions: ['updateTaskSchedule', 'notifyScheduleResult'] },
  dailyReports: { label: '日報の提出', actions: ['submitDailyReport'] },
  recruiting: { label: '採用の候補者', actions: ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember'] },
  skills: { label: 'スキル・ポイント・クイズ', actions: ['awardSkillPoints', 'importPortableRecord', 'submitQuizResult', 'bulkUpdateSkills', 'updateSkillLevels'] },
  projectHealth: { label: 'プロジェクトの健康状態', actions: ['updateProjectHealth', 'notifyProjectHealth', 'reportProjectHealth', 'updateProjectHealthRecord'] },
  training: { label: '研修の申請', actions: ['updateTrainingHistory', 'notifyTrainingRequest', 'notifyTrainingDecision'] },
  memberSurvey: { label: 'メンバーのアンケートの回答', actions: ['submitSurveyResponse'] },
  restore: { label: 'バックアップから戻す', actions: ['restoreBackup', 'restoreTasks'] },
  personalData: { label: '個人情報の削除の操作', actions: ['setPersonalDataRetention', 'purgePersonalDataNow', 'extendPersonalData', 'cancelWithdrawal', 'deleteOrphanEmails'] },
  webhookSettings: { label: 'Discord・Slack の設定と接続テスト', actions: ['updateDiscordWebhookUrl', 'updateSlackWebhookUrl', 'testDiscordWebhook', 'testSlackWebhook'] },
  chatNotify: { label: 'Discord・Slack への通知', inside: true },
  calendarSync: { label: 'Google カレンダーへの登録', inside: true },
  recurringTasks: { label: '定期タスクの作成', inside: true },
  metricsSend: { label: 'FSIF への集計値の送信', inside: true },
}
var FEATURE_DISABLED_MESSAGE = 'この機能は、不具合の確認のため FSIF が一時的に止めています。再開までお待ちください(閲覧はできます)。'

// レジストリから届いた一覧を、知っている ID だけにする
function parseDisabledFeatures_(list) {
  if (!Array.isArray(list)) return []
  var out = []
  list.forEach(function (x) {
    var id = String(x)
    if (Object.prototype.hasOwnProperty.call(FEATURE_SWITCHES, id) && out.indexOf(id) < 0) out.push(id)
  })
  return out
}

// 今止めている機能の ID(CONTRACT_STATE。このリクエストの中では、1回読んだスクリプトプロパティを使う)
function disabledFeatures_() {
  var state = null
  try { state = JSON.parse(requestProps_().CONTRACT_STATE || 'null') } catch (e) { state = null }
  return parseDisabledFeatures_(state && state.disabledFeatures)
}

function featureDisabled_(id) {
  return disabledFeatures_().indexOf(id) >= 0
}

// その操作を止めている機能(無ければ '')
function disabledFeatureOfAction_(action) {
  var ids = disabledFeatures_()
  for (var i = 0; i < ids.length; i++) {
    var f = FEATURE_SWITCHES[ids[i]]
    if (f.actions && f.actions.indexOf(action) >= 0) return ids[i]
  }
  return ''
}

// 止めている操作なら、featureDisabled を付けたエラーを投げる
function assertFeatureEnabled_(action) {
  var id = disabledFeatureOfAction_(action)
  if (!id) return
  var e = userError_(FEATURE_SWITCHES[id].label + ': ' + FEATURE_DISABLED_MESSAGE)
  e.featureDisabled = id
  throw e
}

// 代表の管理画面に出す一覧
function disabledFeaturesForClient_() {
  return disabledFeatures_().map(function (id) { return { id: id, label: FEATURE_SWITCHES[id].label } })
}

// ---- 上限・しきい値(レジストリから配る。PR X) --------------------------------------
//
// 回数の上限・しきい値を、この GAS を更新し直さずに変えられるようにする。レジストリの checkIn が tunables
// ({ キー: 数 })を返し、CONTRACT_STATE に覚える。値は、ここに書いた安全な範囲(min〜max)に必ず収める
// (レジストリが範囲の外の値を送っても、範囲の端の値を使う)。届いていないキー・数でない値は、既定の値(def)を使う。
// キーと範囲は、レジストリの TUNABLE_RANGES と同じにする(テストで確かめる)
var TUNABLES = {
  // 1人1時間の回数の上限(RATE_LIMITS)
  notifyPerHour: { def: 60, min: 10, max: 300, label: '通知(1人1時間)' },
  mentionPerHour: { def: 30, min: 5, max: 100, label: 'メンションの通知の宛先(1人1時間)' },
  resultNotifyPerHour: { def: 10, min: 3, max: 50, label: '結果の通知(1人1時間)' },
  translatePerHour: { def: 500, min: 50, max: 2000, label: '翻訳する文(1人1時間)' },
  clientErrorPerHour: { def: 30, min: 5, max: 100, label: '画面のエラーの記録(1人1時間)' },
  inviteMailPerHour: { def: 3, min: 1, max: 10, label: '本人あての招待リンクのメール(1人1時間)' },
  // メールの1日の残りがこの数以下になったら、急ぎでない通知をまとめて送る分に回す
  digestMailReserve: { def: 10, min: 5, max: 50, label: 'まとめて送る分に回すメールの残り' },
  // 毎日・毎時の処理が止まったとみなす時間
  dailyJobStaleHours: { def: 26, min: 25, max: 72, label: '毎日の処理が止まったとみなす時間' },
  hourlyJobStaleHours: { def: 3, min: 2, max: 24, label: '毎時の処理が止まったとみなす時間' },
  // 個人情報を消す何日前から、代表の管理画面に出すか
  personalDataNoticeDays: { def: 7, min: 3, max: 30, label: '個人情報を消す前に知らせる日数' },
  // 集計値を送れなかった時の、送り直しの間隔の上限(時間)
  metricsRetryMaxHours: { def: 24, min: 6, max: 72, label: '集計値の送り直しの間隔の上限(時間)' },
  // 停止の予定が無い時に、書き込みの前にレジストリへ確かめ直す間隔(秒)。止めてから効くまでの時間にもなる
  contractRecheckIdleSec: { def: 600, min: 120, max: 1800, label: '書き込みの前にレジストリへ確かめ直す間隔(秒)' },
  // FSIF からのお知らせを覚えておく時間(秒)
  announcementsCacheSec: { def: 600, min: 60, max: 3600, label: 'お知らせを覚えておく時間(秒)' },
}
var _tunablesFrom = null
var _tunablesValue = null

// 届いた値を、安全な範囲の整数にする(届いていない・数でない値は null)
function clampTunable_(key, v) {
  var t = TUNABLES[key]
  if (!t || typeof v !== 'number' || !isFinite(v)) return null
  return Math.min(t.max, Math.max(t.min, Math.round(v)))
}

// レジストリから届いた値(範囲に収めたもの。届いていないキーは入れない)
function parseTunables_(given) {
  var out = {}
  if (!given || typeof given !== 'object' || Array.isArray(given)) return out
  Object.keys(TUNABLES).forEach(function (key) {
    var v = clampTunable_(key, given[key])
    if (v !== null) out[key] = v
  })
  return out
}

function receivedTunables_() {
  var raw = requestProps_().CONTRACT_STATE || ''
  if (_tunablesValue && _tunablesFrom === raw) return _tunablesValue
  var state = null
  try { state = JSON.parse(raw || 'null') } catch (e) { state = null }
  _tunablesValue = parseTunables_(state && state.tunables)
  _tunablesFrom = raw
  return _tunablesValue
}

// 今使う値。fallback を渡すと、届いていない時は def の代わりに使う(RATE_LIMITS の値など)
function tunable_(key, fallback) {
  var got = receivedTunables_()
  if (Object.prototype.hasOwnProperty.call(got, key)) return got[key]
  return fallback !== undefined ? fallback : TUNABLES[key].def
}

// 診断情報に入れる、既定と違う値の一覧
function tunablesForClient_() {
  var got = receivedTunables_()
  return Object.keys(got).filter(function (k) { return got[k] !== TUNABLES[k].def }).map(function (k) {
    return { key: k, label: TUNABLES[k].label, value: got[k], def: TUNABLES[k].def }
  })
}

function readContractState_() {
  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty('CONTRACT_STATE') || 'null')
    return state && typeof state === 'object' ? state : null
  } catch (e) {
    return null
  }
}

// 今の状態(Google のサービスを使わない純粋な関数)。予定の日時を過ぎていれば、確かめ直す前でも停止中とする
function effectiveContract_(state, nowMs) {
  if (!state) return { phase: 'none', kind: '', suspendAt: '' }
  var kind = state.kind === 'restrict' ? 'restrict' : 'suspend'
  var at = Date.parse(String(state.suspendAt || ''))
  var suspendAt = at > 0 ? new Date(at).toISOString() : ''
  if (state.phase === 'inEffect') return { phase: 'inEffect', kind: kind, suspendAt: suspendAt }
  if (state.phase === 'scheduled' && at > 0) return { phase: at <= nowMs ? 'inEffect' : 'scheduled', kind: kind, suspendAt: suspendAt }
  return { phase: 'none', kind: '', suspendAt: '' }
}

// ---- この GAS の版の更新 ----------------------------------------------------------
//
// レジストリは checkIn の返事で、この GAS の版の判定を返す(gasUpdate: { required, outdated, latest, minimum, security })。
// CONTRACT_STATE に覚え、代表・全権管理者の管理画面に出す(getGasUpdateStatus)。更新が要る時は、代表にメールで知らせる
// (1時間ごとの checkContractStatus から。最新の版ごとに1回だけ。GAS_UPDATE_NOTIFIED に覚える)
var GAS_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/

function parseGasUpdate_(v) {
  if (!v || typeof v !== 'object') return null
  var version = function (x) { return GAS_VERSION_PATTERN.test(String(x || '')) ? String(x) : '' }
  // judgedVersion: 判定した時のこの GAS の版(貼り替えた後は、次の確認まで古い判定を出さない)
  return { required: v.required === true, outdated: v.outdated === true, latest: version(v.latest), minimum: version(v.minimum), security: v.security === true,
    judgedVersion: OHSUMI_GAS_VERSION }
}

// ---- FSIF からのアンケート ----------------------------------------------------------
//
// レジストリは checkIn の返事で、回答待ちのアンケートを返す(surveys: [{ surveyId, title, formUrl, sendDate, dueDate, overdue, restrictAt }])。
// CONTRACT_STATE に覚え、代表の管理画面に出す(getOpsStatus)。回答の確認は FSIF が行い、回答済みになると次の確認で消える
var SURVEY_FORM_URL_PATTERN = /^https:\/\/(docs\.google\.com\/forms\/[A-Za-z0-9_\-\/.?=&%]+|forms\.gle\/[A-Za-z0-9_-]+)$/

var SURVEYS_KEEP_MAX = 5

function parseSurveys_(list) {
  if (!Array.isArray(list)) return []
  var day = /^\d{4}-\d{2}-\d{2}$/
  // CONTRACT_STATE(スクリプトプロパティ。1つの値は9KBまで)に入るよう、5件・URL 300文字までにする
  return list.filter(function (v) {
    var url = String((v && v.formUrl) || '')
    return v && typeof v === 'object' && url.length <= 300 && SURVEY_FORM_URL_PATTERN.test(url) && day.test(String(v.dueDate || ''))
  }).slice(0, SURVEYS_KEEP_MAX).map(function (v) {
    var restrictAt = String(v.restrictAt || '')
    return {
      surveyId: String(v.surveyId || '').slice(0, 40),
      title: String(v.title || '').slice(0, 100),
      formUrl: String(v.formUrl),
      sendDate: day.test(String(v.sendDate || '')) ? String(v.sendDate) : '',
      dueDate: String(v.dueDate),
      overdue: v.overdue === true,
      restrictAt: isNaN(Date.parse(restrictAt)) ? '' : new Date(restrictAt).toISOString(),
    }
  })
}

function surveysStatus_() {
  var state = readContractState_()
  return (state && Array.isArray(state.surveys)) ? state.surveys : []
}

// ---- FSIF からのお知らせ(PR P) ----------------------------------------------------------
//
// 代表・管理者が管理画面を開いた時(getAnnouncements)に、レジストリへ共有鍵の署名で取りに行く(fetchAnnouncements)。
// 取れたものは10分覚え(CacheService)、レジストリに届かない時は、最後に取れたもの(6時間まで)を出す。
// 重要度は normal(通常)/ important(重要)/ urgent(緊急)。既読は画面(端末ごと)で覚える
var ANNOUNCEMENTS_CACHE_SEC = 600
var ANNOUNCEMENTS_LAST_SEC = 6 * 3600
var ANNOUNCEMENT_IMPORTANCE = ['normal', 'important', 'urgent']

function parseAnnouncements_(list) {
  if (!Array.isArray(list)) return []
  return list.filter(function (v) {
    return v && typeof v === 'object' && String(v.announcementId || '') && String(v.title || '')
  }).slice(0, 20).map(function (v) {
    var iso = function (x) { var t = Date.parse(String(x || '')); return isNaN(t) ? '' : new Date(t).toISOString() }
    return {
      announcementId: String(v.announcementId).slice(0, 40),
      title: String(v.title).slice(0, 100),
      body: String(v.body || '').slice(0, 1000),
      importance: ANNOUNCEMENT_IMPORTANCE.indexOf(String(v.importance)) >= 0 ? String(v.importance) : 'normal',
      publishedAt: iso(v.publishedAt),
      expiresAt: iso(v.expiresAt),
    }
  })
}

// 返事: { registered: レジストリに登録しているか, announcements, fetchedAt, stale: レジストリに届かず、最後に取れたものを出しているか }
function announcementsStatus_(nowMs, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = String(props.getProperty('REGISTRY_URL') || '').trim()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) return { registered: false, announcements: [], fetchedAt: '', stale: false }
  var cache = CacheService.getScriptCache()
  var cached = null
  try { cached = JSON.parse(cache.get('announcements:v1') || 'null') } catch (e) { cached = null }
  if (cached && Array.isArray(cached.announcements)) return { registered: true, announcements: cached.announcements, fetchedAt: String(cached.fetchedAt || ''), stale: false }
  try {
    var ts = Math.floor(nowMs / 1000)
    var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('announcements.' + orgId + '.' + ts, key))
    var payload = JSON.stringify({ action: 'fetchAnnouncements', orgId: orgId, ts: ts, sig: sig })
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
    var res = JSON.parse(r.getContentText())
    if (!res || !res.ok || !res.result) throw new Error(String((res && res.error) || '応答の形が違います'))
    var fresh = { announcements: parseAnnouncements_(res.result.announcements), fetchedAt: new Date(nowMs).toISOString() }
    var text = JSON.stringify(fresh)
    try {
      cache.put('announcements:v1', text, tunable_('announcementsCacheSec', ANNOUNCEMENTS_CACHE_SEC))
      cache.put('announcements:last', text, ANNOUNCEMENTS_LAST_SEC)
    } catch (e) { /* 覚えられなくても、今回は出せる */ }
    return { registered: true, announcements: fresh.announcements, fetchedAt: fresh.fetchedAt, stale: false }
  } catch (e) {
    console.warn('FSIF からのお知らせを取れませんでした: ' + maskEmailsIn_(String((e && e.message) || e)))
    var last = null
    try { last = JSON.parse(cache.get('announcements:last') || 'null') } catch (e2) { last = null }
    if (last && Array.isArray(last.announcements)) return { registered: true, announcements: last.announcements, fetchedAt: String(last.fetchedAt || ''), stale: true }
    return { registered: true, announcements: [], fetchedAt: '', stale: true }
  }
}

// 緊急のお知らせを、代表にメールで1回だけ送る(1時間ごとの checkContractStatus から)。
// checkIn で受け取った ID のうち、まだ送っていないものの本文をレジストリから取り(fetchAnnouncements)、1件ずつ送る。
// 送った ID はスクリプトプロパティ URGENT_ANNOUNCEMENTS_MAILED に残す(直近50件)。メールの上限で送れなかった時は、次の確認で送り直す。
// 送った ID を返す
var URGENT_MAILED_KEEP = 50

function sendUrgentAnnouncementMails_(state, deps) {
  var ids = (state && Array.isArray(state.urgentAnnouncementIds)) ? state.urgentAnnouncementIds : []
  if (!ids.length) return []
  var props = PropertiesService.getScriptProperties()
  var mailed = []
  try { mailed = JSON.parse(props.getProperty('URGENT_ANNOUNCEMENTS_MAILED') || '[]') } catch (e) { mailed = [] }
  if (!Array.isArray(mailed)) mailed = []
  var pending = ids.filter(function (id) { return mailed.indexOf(id) < 0 })
  if (!pending.length) return []
  // 覚えている一覧(10分)に無い新しいものがあれば、取り直す
  var cache = CacheService.getScriptCache()
  var list = announcementsStatus_(Date.now(), deps).announcements
  if (pending.some(function (id) { return !list.some(function (a) { return a.announcementId === id }) })) {
    try { cache.remove('announcements:v1') } catch (e) { /* 取り直せなくても、あるものは送る */ }
    list = announcementsStatus_(Date.now(), deps).announcements
  }
  var emails = getAllMemberEmails_()
  var to = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  if (!to.length) {
    console.warn('緊急のお知らせを知らせる代表のメールアドレスがありません')
    return []
  }
  var orgName = getSettingValue_('org_name') || 'Ohsumi'
  var sent = []
  pending.forEach(function (id) {
    var a = list.filter(function (x) { return x.announcementId === id && x.importance === 'urgent' })[0]
    if (!a) return
    var ok = sendMail_({
      to: to.join(','),
      subject: '[Ohsumi] ' + orgName + ': FSIF からの緊急のお知らせ「' + a.title + '」',
      body: orgName + ' 代表の方へ\n\nFSIF から緊急のお知らせがあります。\n\n' + a.title + '\n\n' + a.body +
        '\n\n(Ohsumi の管理画面の上部にも出しています。このメールは、お知らせごとに1回だけ送ります)',
    })
    if (ok) { mailed.push(id); sent.push(id) }
  })
  if (sent.length) props.setProperty('URGENT_ANNOUNCEMENTS_MAILED', JSON.stringify(mailed.slice(-URGENT_MAILED_KEEP)))
  return sent
}

function gasUpdateStatus_() {
  var state = readContractState_()
  var u = (state && state.gasUpdate) || null
  if (u && u.judgedVersion !== OHSUMI_GAS_VERSION) u = null
  return {
    current: OHSUMI_GAS_VERSION,
    known: !!u,
    required: !!(u && u.required),
    outdated: !!(u && u.outdated),
    latest: (u && u.latest) || '',
    minimum: (u && u.minimum) || '',
    security: !!(u && u.security),
    checkedAt: (state && state.checkedAt) || '',
  }
}

function gasUpdateNoticeText_(orgName, st) {
  var name = orgName || 'Ohsumi'
  return {
    subject: '[Ohsumi] ' + name + ': 団体の GAS の更新が要ります(最新の版 ' + st.latest + ')',
    body: name + ' 代表の方へ\n\n' +
      'この団体の Ohsumi の GAS(スプレッドシートの Apps Script)は、更新が要ります。\n\n' +
      '今の版: ' + st.current + '\n最新の版: ' + st.latest + '\n' +
      (st.minimum ? 'この版より古い GAS は、更新が要ります: ' + st.minimum + '\n' : '') +
      (st.security ? '新しい版には、安全の修正が含まれます。お早めに更新してください。\n' : '') +
      '\n更新の手順:\n' +
      '1. Ohsumi のリポジトリの gas/Code.gs の内容を、Apps Script エディタに貼り替えて保存する\n' +
      '2. 「デプロイ」→「デプロイを管理」→ ウェブアプリの編集(鉛筆)→「バージョン: 新規」で更新する(URL は変わりません)\n' +
      '3. エディタで setupOhsumi を実行する\n\n' +
      '詳しくは gas/README.md の「2. Apps Script のデプロイ」をご覧ください。このメールは、新しい版ごとに1回だけ送ります。',
  }
}

// 更新が要る時に、代表にメールで知らせる(最新の版ごとに1回)。送ったら最新の版を返す(送らなければ null)
function sendGasUpdateNotice_() {
  var st = gasUpdateStatus_()
  if (!st.required || !st.latest) return null
  var props = PropertiesService.getScriptProperties()
  if (props.getProperty('GAS_UPDATE_NOTIFIED') === st.latest) return null
  var emails = getAllMemberEmails_()
  var to = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  if (!to.length) {
    console.warn('GAS の更新が要ることを知らせる代表のメールアドレスがありません')
    return null
  }
  var text = gasUpdateNoticeText_(getSettingValue_('org_name'), st)
  // メールの上限で送れなかった時は、送ったことにしない(次の確認で送り直す)
  if (!sendMail_({ to: to.join(','), subject: text.subject, body: text.body })) return null
  props.setProperty('GAS_UPDATE_NOTIFIED', st.latest)
  return st.latest
}

// トリガーから: 覚えている状態で、提供停止中か(レジストリには問い合わせない)
function contractSuspendedNow_() {
  var c = effectiveContract_(readContractState_(), Date.now())
  return c.phase === 'inEffect' && c.kind === 'suspend'
}

// レジストリの checkIn で状態を確かめ、CONTRACT_STATE に覚えて返す。確かめられない時は null(覚えた状態は変えない)。
// レジストリに登録していない団体(REGISTRY_URL・共有鍵が無い)も null
function refreshContractState_(deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = String(props.getProperty('REGISTRY_URL') || '').trim()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) return null
  var ts = nowSec_()
  var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('checkIn.' + orgId + '.' + ts, key))
  // メールの1日の上限の状態も伝える(レジストリの管理画面で、上限に近い団体が分かるように)
  var mail = null
  try {
    var q = mailQuotaStatus_()
    mail = { remaining: q.remaining, skipped: q.skipped, date: q.date, lastReachedDate: q.lastReachedDate }
  } catch (e) { mail = null }
  // 毎日・毎時の処理が最後に成功した時刻も伝える(止まった団体が、レジストリと監視で分かるように)
  var jobs = null
  try {
    var j = jobStatus_(Date.now())
    jobs = { dailyAt: j.dailyAt, hourlyAt: j.hourlyAt }
  } catch (e) { jobs = null }
  var payload = JSON.stringify({ action: 'checkIn', orgId: orgId, ts: ts, sig: sig, gasVersion: OHSUMI_GAS_VERSION, mail: mail, jobs: jobs })
  var res
  try {
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
    res = JSON.parse(r.getContentText())
  } catch (e) {
    console.warn('レジストリに停止の状態を確かめられませんでした(通信エラー・JSON ではない応答)。最後に確かめた状態のまま使います。')
    return null
  }
  if (!res || !res.ok || !res.result) {
    console.warn('レジストリに停止の状態を確かめられませんでした(' + String((res && res.error) || '応答の形が違います') + ')。最後に確かめた状態のまま使います。')
    return null
  }
  var out = res.result
  var state = {
    phase: ['none', 'scheduled', 'inEffect'].indexOf(out.phase) >= 0 ? out.phase : 'none',
    kind: out.kind === 'restrict' ? 'restrict' : 'suspend',
    suspendAt: String(out.suspendAt || ''),
    reason: String(out.reason || ''),
    checkedAt: String(out.checkedAt || new Date().toISOString()),
    // サイトの origin の一覧(本人あての招待リンクのメールに使う。レジストリのスクリプトプロパティ SITE_ORIGINS)
    siteOrigins: parseSiteOrigins_(out.siteOrigins),
    // この GAS の版の更新が要るか(レジストリの版の一覧で判定したもの)
    gasUpdate: parseGasUpdate_(out.gasUpdate),
    // プラン(集計値を送るかの決まりに使う。古いレジストリは返さない)
    plan: ['cosmo_base', 'ohsumi', 'paid'].indexOf(String(out.plan || '')) >= 0 ? String(out.plan) : '',
    // FSIF からの回答待ちのアンケート(代表の管理画面に出す。古いレジストリは返さない)
    surveys: parseSurveys_(out.surveys),
    // 掲載中の緊急のお知らせの ID(代表にメールで1回だけ送る)
    urgentAnnouncementIds: (Array.isArray(out.urgentAnnouncementIds) ? out.urgentAnnouncementIds : [])
      .map(function (x) { return String(x).slice(0, 40) }).filter(function (x) { return /^an_[A-Za-z0-9]+$/.test(x) }).slice(0, 20),
    // レジストリから止めている機能(機能のスイッチ。古いレジストリは返さない)
    disabledFeatures: parseDisabledFeatures_(out.disabledFeatures),
    // 上限・しきい値(安全な範囲に収めたもの。古いレジストリは返さない)
    tunables: parseTunables_(out.tunables),
  }
  setRequestProp_('CONTRACT_STATE', JSON.stringify(state))
  return state
}

// リクエストの時の状態。レジストリに確かめ直すのは(上の説明):
//   停止中 → どの操作でも1分に1回まで / 予定あり → 書き込みの前に1分に1回まで / 予定なし → 書き込みの前に10分に1回まで
// writing: 読み取りの一覧に無い操作か(省くと読み取り)
function currentContract_(nowMs, writing) {
  var state = null
  try { state = JSON.parse(requestProps_().CONTRACT_STATE || 'null') } catch (e) { state = null }
  var c = effectiveContract_(state, nowMs)
  if (c.phase !== 'inEffect' && !writing) return c
  var cache = CacheService.getScriptCache()
  if (cache.get('contract:recheck')) return c
  cache.put('contract:recheck', '1', c.phase === 'none' ? tunable_('contractRecheckIdleSec', CONTRACT_RECHECK_IDLE_SEC) : CONTRACT_RECHECK_SEC)
  var fresh = refreshContractState_()
  return fresh ? effectiveContract_(fresh, nowMs) : c
}

// 停止中に断る時の応答(受け付ける時は null)
function contractRejection_(c, body) {
  if (c.phase !== 'inEffect') return null
  if (c.kind === 'suspend') return { ok: false, orgSuspended: true, error: CONTRACT_SUSPENDED_MESSAGE }
  if (readOnlyAllows_(body)) return null
  return { ok: false, restricted: true, error: 'Ohsumi は読み取り専用になっています(作成・編集はできません)。' + CONTRACT_RESTRICTED_MESSAGE }
}

// 画面に渡す状態(停止の理由は渡さない。代表へのメールにだけ書く)
function contractForClient_(c) {
  return { phase: c.phase, kind: c.kind, suspendAt: c.suspendAt }
}

// ---- ほかの端末で開く: 本人あての招待リンクのメール ----------------------------------
//
// 招待リンク(<サイトの origin>/?org=<団体ID>)を、ログインしている本人の登録済みのメールアドレス(MemberEmails。
// 複数あればすべて)にだけ送る。宛先は画面から受け取らない。リンクには団体ID だけを入れる(セッション・メールアドレスは入れない)。
// サイトの origin は、レジストリの checkIn が配る一覧(CONTRACT_STATE.siteOrigins)の中から選ぶ。画面が今開いている
// origin が一覧にあればそれを、無ければ一覧の最初(正式なサイト)を使う(画面が送った値を、そのままリンクにはしない)。
// レジストリに一度も確かめられていない団体・一覧が空の団体では送れない。
// 送れるのは1人1時間に INVITE_MAIL_LIMIT 回まで(CacheService に送った時刻を覚える)。
// 機能停止中(読み取り専用)も使える(READ_ONLY_ACTIONS。データを書き換えないため)。テスト環境の宛先の決まりは sendMail_ に従う
var INVITE_MAIL_LIMIT = 3
var INVITE_MAIL_WINDOW_SEC = 3600
var SITE_ORIGIN_PATTERN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
var SITE_ORIGINS_MAX = 5
var INVITE_MAIL_UNAVAILABLE = 'この団体では、まだメールで送れません(接続先の確認が済んでいません)。QR コードか共有をお使いください。'

// レジストリが配った origin の一覧を、形を確かめて取り出す(配列・文字列のどちらでも)
function parseSiteOrigins_(raw) {
  var list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/)
  var out = []
  list.forEach(function (v) {
    var o = String(v || '').trim().toLowerCase().replace(/\/+$/, '')
    if (o && SITE_ORIGIN_PATTERN.test(o) && out.indexOf(o) < 0 && out.length < SITE_ORIGINS_MAX) out.push(o)
  })
  return out
}

// レジストリに確かめた時に受け取った origin の一覧(一度も確かめていなければ空)
function inviteSiteOrigins_() {
  var state = readContractState_()
  if (!state || !state.checkedAt) return []
  return parseSiteOrigins_(state.siteOrigins)
}

// 正式なサイトの招待リンク(<SITE_ORIGINS の最初>/?org=<団体ID>)。レジストリに確かめていない団体は ''
function canonicalInviteLink_() {
  var origins = inviteSiteOrigins_()
  var orgId = String(requestProps_().ORG_ID || '')
  return origins.length && orgId ? origins[0] + '/?org=' + encodeURIComponent(orgId) : ''
}

// 登録を終えた時に出す招待リンク。レジストリに確かめて、サイトの URL(SITE_ORIGINS)が分かれば完全なリンクを出す
function setupInviteLinkText_(orgId) {
  var link = ''
  try {
    resetRequestProps_()
    refreshContractState_()
    resetRequestProps_()
    link = canonicalInviteLink_()
  } catch (e) {
    link = ''
  }
  if (link) return '団体ID: ' + orgId + '\n招待リンク: ' + link + '\n(メンバーには、初めての端末でこのリンクから開くよう伝えてください。代表は、ログインした後に管理画面の「Members」でも確かめられます)'
  return '団体ID: ' + orgId + '\n招待リンク: Ohsumi のサイトの URL の後ろに /?org=' + orgId +
    ' を付けたもの(レジストリからサイトの URL を受け取れませんでした。代表は、ログインした後に管理画面の「Members」でも確かめられます)'
}

// 通知の本文の最後に、サイトを開くリンクを足す(リンクが分からない・もう入っている時はそのまま)
function withSiteLink_(text) {
  var link = ''
  try { link = canonicalInviteLink_() } catch (e) { link = '' }
  var body = String(text || '')
  if (!link || body.indexOf(link) >= 0) return body
  return body + '\n\nOhsumi を開く / Open Ohsumi: ' + link
}

// 新しいメンバーへの招待メール(メンバーの追加・候補者を正式なメンバーにする時に、選んだ時だけ)。
// 宛先は、そのメンバーの登録済みのアドレス。リンクは SITE_ORIGINS と団体ID から GAS が作る
function sendMemberInvite_(memberId) {
  var link = canonicalInviteLink_()
  if (!link) return { sent: false, reason: 'notChecked' }
  var emails = registeredEmailsOf_(memberId)
  if (emails.length === 0) return { sent: false, reason: 'noEmail' }
  var orgName = getSettingValue_('org_name') || 'Ohsumi'
  var mailed = sendMailChecked_({
    to: emails.join(','),
    subject: '[Ohsumi] ' + orgName + ' の Ohsumi に招待されました',
    body: orgName + ' の Ohsumi(タスク・メンバーの管理)に招待されました。\n\n' +
      '次のリンクを開き、このメールアドレスの Google アカウントでログインしてください。\n\n' + link +
      '\n\nスマホでは、開いた後に「ホーム画面に追加」をすると、次からすぐに開けます。' +
      '\n\n---\nYou have been invited to ' + orgName + ' on Ohsumi. Open the link above and sign in with the Google account for this email address.',
  })
  // メールの1日の上限・通知の回数の上限で送れなかった時は、画面に伝える(メンバーの追加はそのまま)
  if (mailed === 'quota') return { sent: false, reason: 'mailQuota' }
  if (mailed === 'limited') return { sent: false, reason: 'limited' }
  return { sent: true }
}

function inviteMailKey_(memberId) {
  return 'invmail:' + sha256Base64Url_(String(memberId))
}

// この1時間に送った時刻(ミリ秒)
function inviteMailSentTimes_(memberId, nowMs) {
  var times = []
  try { times = JSON.parse(CacheService.getScriptCache().get(inviteMailKey_(memberId)) || '[]') } catch (e) { times = [] }
  if (!Array.isArray(times)) times = []
  return times.filter(function (t) { return typeof t === 'number' && t > nowMs - INVITE_MAIL_WINDOW_SEC * 1000 && t <= nowMs })
}

function registeredEmailsOf_(memberId) {
  return String(getMemberEmailValueCached_(memberId) || '').split(/[\s,;]+/).map(function (e) { return e.trim() })
    .filter(function (e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) })
}

/** 本人あてのメールを送れるか({ available, reason?, remaining, retryAt? }) */
function inviteMailStatus_(memberId, nowMs) {
  var remaining = Math.max(0, tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT) - inviteMailSentTimes_(memberId, nowMs).length)
  if (inviteSiteOrigins_().length === 0) return { available: false, reason: 'notChecked', remaining: remaining }
  if (registeredEmailsOf_(memberId).length === 0) return { available: false, reason: 'noEmail', remaining: remaining }
  if (remaining === 0) {
    var times = inviteMailSentTimes_(memberId, nowMs)
    return { available: false, reason: 'limit', remaining: 0, retryAt: new Date(Math.min.apply(null, times) + INVITE_MAIL_WINDOW_SEC * 1000).toISOString() }
  }
  return { available: true, remaining: remaining }
}

// 本人あての招待リンクのメールの文面(団体ID 以外は入れない)
function inviteMailText_(orgName, link, locale) {
  var name = orgName || 'Ohsumi'
  if (locale === 'en') {
    return {
      subject: '[Ohsumi] ' + name + ': link to open on another device',
      body: 'Open this link on the device you want to use, then sign in with Google.\n\n' + link +
        '\n\nOn a smartphone, add it to your home screen after opening it so you can open it right away next time.' +
        '\n\nThis email was sent because you asked for it in Ohsumi. If you did not, you can ignore it.',
    }
  }
  return {
    subject: '[Ohsumi] ' + name + ': ほかの端末で開くためのリンク',
    body: '使いたい端末で次のリンクを開き、Googleでログインしてください。\n\n' + link +
      '\n\nスマホでは、開いた後に「ホーム画面に追加」をすると、次からすぐに開けます。' +
      '\n\nこのメールは、Ohsumi の「ほかの端末で開く」から、ご本人が送ったものです。心当たりが無ければ、このメールは無視してください。',
  }
}

/** 本人の登録済みのアドレスにだけ、招待リンクを送る。body.siteOrigin(画面が開いている origin)は一覧にある時だけ使う */
function sendInviteLinkToMe_(memberId, body, nowMs) {
  var origins = inviteSiteOrigins_()
  if (origins.length === 0) throw userError_(INVITE_MAIL_UNAVAILABLE)
  var emails = registeredEmailsOf_(memberId)
  if (emails.length === 0) throw userError_('メールアドレスが登録されていません。管理者に登録を頼んでください。')
  var requested = String((body && body.siteOrigin) || '').trim().toLowerCase().replace(/\/+$/, '')
  var origin = origins.indexOf(requested) >= 0 ? requested : origins[0]
  var orgId = String(requestProps_().ORG_ID || '')
  if (!orgId) throw userError_(INVITE_MAIL_UNAVAILABLE)
  var link = origin + '/?org=' + encodeURIComponent(orgId)
  // 回数の確認と記録は、ほかの送信と重ならないようにロックの中で行う(送信はロックの外)
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(10000)
  } catch (lockErr) {
    throw userError_('混み合っています。少し待って再度お試しください。')
  }
  var times
  try {
    times = inviteMailSentTimes_(memberId, nowMs)
    if (times.length >= tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT)) {
      throw userError_('メールで送れるのは1時間に' + tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT) + '回までです。しばらくしてから、もう一度お試しください。')
    }
    times.push(nowMs)
    CacheService.getScriptCache().put(inviteMailKey_(memberId), JSON.stringify(times), INVITE_MAIL_WINDOW_SEC)
  } finally {
    lock.releaseLock()
  }
  var text = inviteMailText_(getSettingValue_('org_name'), link, body && body.locale === 'en' ? 'en' : 'ja')
  var mailed = sendMailChecked_({ to: emails.join(','), subject: text.subject, body: text.body })
  if (mailed === 'quota') throw userError_(quotaMessage_('email', false) + 'QR コードかリンクのコピーを使ってください。')
  if (mailed === 'limited') throw userError_('通知の回数の上限に達しました。しばらくしてから、もう一度お試しください。')
  return { sent: true, count: emails.length, remaining: Math.max(0, tunable_('inviteMailPerHour', INVITE_MAIL_LIMIT) - times.length) }
}

// 停止の予告のメールの文面
function contractNoticeText_(orgName, c, days) {
  var when = Utilities.formatDate(new Date(c.suspendAt), Session.getScriptTimeZone(), 'yyyy年M月d日 H:mm')
  var what = c.kind === 'restrict'
    ? 'Ohsumi が読み取り専用になります(閲覧と書き出しはできますが、作成・編集はできなくなります)。' + CONTRACT_RESTRICTED_MESSAGE
    : 'Ohsumi の提供を停止します。停止の後は、メンバー全員が Ohsumi にログインできなくなり、通知も止まります(団体のデータは、団体のスプレッドシートにそのまま残ります)。'
  var name = orgName || 'Ohsumi'
  return {
    subject: '[Ohsumi] ' + name + ': ' + when + ' から' + (c.kind === 'restrict' ? '読み取り専用になります' : '提供を停止します') + '(あと' + days + '日)',
    body: name + ' 代表の方へ\n\n' + when + ' から、' + what + '\n\n理由: ' + (c.reason || '—') + '\n\nご不明な点は FSIF にお問い合わせください。',
  }
}

// 停止の予定があれば、予告の時期(14日前・7日前・1日前)になったものを代表に送る。送った日数を返す(送らなければ null)。
// 同じ予定(日時と種類)に同じ予告は1回だけ。予定が変わったら、数え直す
function sendContractNotices_(state, nowMs) {
  var c = effectiveContract_(state, nowMs)
  if (c.phase !== 'scheduled') return null
  var left = (Date.parse(c.suspendAt) - nowMs) / (24 * 3600 * 1000)
  var due = CONTRACT_NOTICE_DAYS.filter(function (d) { return left <= d })
  if (!due.length) return null
  var days = Math.min.apply(null, due)
  var props = PropertiesService.getScriptProperties()
  var planKey = c.suspendAt + '|' + c.kind
  var sent = {}
  try { sent = JSON.parse(props.getProperty('CONTRACT_NOTICES_SENT') || '{}') || {} } catch (e) { sent = {} }
  if (sent.plan !== planKey) sent = { plan: planKey, days: [] }
  if (sent.days.indexOf(days) >= 0) return null
  var emails = getAllMemberEmails_()
  var to = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  if (to.length) {
    var text = contractNoticeText_(getSettingValue_('org_name'), { kind: c.kind, suspendAt: c.suspendAt, reason: state && state.reason }, days)
    // メールの1日の上限で送れなかった時は、送ったことにしない(次の確認で送り直す)
    if (!sendMail_({ to: to.join(','), subject: text.subject, body: text.body })) return null
  } else {
    console.warn('停止の予告を送る代表のメールアドレスがありません(あと' + days + '日)')
  }
  sent.days.push(days)
  props.setProperty('CONTRACT_NOTICES_SENT', JSON.stringify(sent))
  return days
}

function exchangeIdToken_(body) {
  var google = timed_('verifyMs', function () { return verifyGoogleIdToken_(body.idToken, body.nonceSecret) })
  var memberId = timed_('emailLookupMs', function () { return findMemberIdByEmailCached_(google.email) })
  // 最初の代表: 未登録のアカウントが初期設定コードを付けて来た時は、代表として団体に入れる(同じ1回の通信で)
  if (!memberId && body.setupCode) {
    memberId = timed_('setupMs', function () { return claimInitialSetup_(google.email, body.setupCode, Date.now()) })
  }
  // 未登録のアカウント: ログイン画面に表示するため、本人のメールアドレスと団体名だけ返す
  // (団体名は、Google でログインした後にだけ返す。どの団体に入ろうとしたかを画面に出すため)
  if (!memberId) return { memberId: null, email: google.email, orgName: String(getSettingValue_('org_name') || '') }
  // 休止中のメンバーはログインできない(休止を解除すれば、またログインできる)
  if (memberIsInactive_(memberId)) throw userError_(inactiveMessageOf_(memberId))
  var data = getInitialDataForMember_(memberId, null)
  if (!data.memberId) return { memberId: null, email: google.email }
  data.session = timed_('sessionMs', function () { return issueSessionToken_(memberId, body.remember !== false, nowSec_()) })
  // 最終ログイン日時も、ここで記録する(画面が別に updateLastLogin を送らなくてよいように)
  data.lastLoginRecorded = timed_('lastLoginMs', function () { return recordLastLogin_(memberId) })
  return attachBackgroundData_(data, memberId, body)
}

// ログインの時の最終ログイン日時。ログインの応答を待たせないよう、シートには書かない:
//   - 前回の記録から1時間以内なら何もしない(最終ログイン日時は、おおよそ正しければ十分)
//   - それ以外は、スクリプトプロパティの「書き込み待ち」に入れるだけ(ロックもシートも使わない)。
//     書き込み待ちは、ログイン1回ごとに別のプロパティ(LAST_LOGIN_PENDING_<メンバーID>_<時刻>)にする。
//     全員分を1つのプロパティにまとめないので、同時にログインしても互いに消し合わない
//   - 書き込み待ちは、毎時のトリガー(sendBatchNotifications)と毎日のトリガー(dailyMaintenance)が
//     まとめてシートに書く(flushPendingLastLogins_)。画面の最終ログイン日時は、最大1時間ほど遅れて反映される
// 返り値 true は「画面は updateLastLogin を送らなくてよい」。記録できなかった時だけ false
var LAST_LOGIN_THROTTLE_SEC = 3600
var LAST_LOGIN_PENDING_PREFIX = 'LAST_LOGIN_PENDING_'
// 書き込み待ちの上限。トリガーが止まっていても、これ以上は増やさない(あふれた分は捨てる。
// 最終ログイン日時は、おおよそ正しければ十分)
var LAST_LOGIN_PENDING_MAX = 200

function recordLastLogin_(memberId, nowMs) {
  memberId = String(memberId)
  var now = nowMs || Date.now()
  try {
    var cache = CacheService.getScriptCache()
    var cacheKey = 'lastLogin:' + memberId
    if (cache.get(cacheKey)) {
      noteTiming_('lastLogin', 'recent')
      return true
    }
    // 書き込み待ち(このリクエストの最初に読んだスクリプトプロパティ)のうち、このメンバーの分と全体の件数。
    // CacheService の印は途中で消えることがあるので、書き込み待ちそのものも見る
    var all = requestProps_()
    var ownKeys = []
    var newestOwn = NaN
    var total = 0
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(LAST_LOGIN_PENDING_PREFIX) !== 0) return
      total++
      if (memberIdFromPendingKey_(k) !== memberId) return
      ownKeys.push(k)
      var at = Date.parse(String(all[k]))
      if (!(newestOwn >= at)) newestOwn = at
    })
    // スナップショット(シートの値)か書き込み待ちの日時が1時間以内なら書かない
    var fromSnapshot = _requestSnapshot ? lastLoginInTable_(_requestSnapshot.data.Members, memberId) : NaN
    var latest = Math.max(fromSnapshot > 0 ? fromSnapshot : 0, newestOwn > 0 ? newestOwn : 0)
    if (latest > 0 && now - latest < LAST_LOGIN_THROTTLE_SEC * 1000) {
      cache.put(cacheKey, '1', LAST_LOGIN_THROTTLE_SEC)
      noteTiming_('lastLogin', 'recent')
      return true
    }
    // 上限に達していて、このメンバーの分がまだ無ければ入れない(捨てる)
    if (!ownKeys.length && total >= LAST_LOGIN_PENDING_MAX) {
      cache.put(cacheKey, '1', LAST_LOGIN_THROTTLE_SEC)
      noteTiming_('lastLogin', 'dropped')
      return true
    }
    var props = PropertiesService.getScriptProperties()
    props.setProperty(lastLoginPendingKey_(memberId, now), new Date(now).toISOString())
    // このメンバーの古い書き込み待ちは、新しい1件に置き換える(トリガーが止まっていても、1人につき増え続けない)。
    // 消すのは、このリクエストの最初に見えていた自分の分だけ(ほかのメンバーの分・この後に入った分は消さない)
    ownKeys.forEach(function (k) { props.deleteProperty(k) })
    cache.put(cacheKey, '1', LAST_LOGIN_THROTTLE_SEC)
    noteTiming_('lastLogin', 'queued')
    return true
  } catch (e) {
    // 記録できなくてもログインは続ける(画面が updateLastLogin を送る)
    Logger.log('recordLastLogin failed: ' + e)
    return false
  }
}

// 書き込み待ちのプロパティの名前。メンバーIDの後ろに時刻(と乱数)を付け、ログイン1回ごとに別のキーにする
function lastLoginPendingKey_(memberId, nowMs) {
  return LAST_LOGIN_PENDING_PREFIX + String(memberId) + '_' + nowMs + '_' + Math.floor(Math.random() * 1e6)
}

// 書き込み待ちのキーからメンバーIDを取り出す(後ろの _<時刻>_<乱数> を除く)
function memberIdFromPendingKey_(key) {
  var rest = key.slice(LAST_LOGIN_PENDING_PREFIX.length)
  var m = rest.match(/^(.*)_\d+_\d+$/)
  return m ? m[1] : rest
}

// Members の表(見出しと行)から、そのメンバーの last_login(ミリ秒)。無ければ NaN
function lastLoginInTable_(table, memberId) {
  if (!table || !table.headers) return NaN
  var idCol = table.headers.indexOf('id')
  var col = table.headers.indexOf('last_login')
  if (idCol < 0 || col < 0) return NaN
  for (var i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i][idCol]) === memberId) {
      var v = table.rows[i][col]
      return v instanceof Date ? v.getTime() : Date.parse(String(v || ''))
    }
  }
  return NaN
}

// 書き込み待ちの最終ログイン日時を、まとめて Members の last_login に書く(トリガーから呼ぶ)。
// 列を1回読み、1回で書く。消すのは、このとき読んだキーだけ(読んだ後にログインした分は別のキーなので残る)。
// 毎時と毎日のトリガーが重なっても二重に処理しないよう、ロックを取ってから読む
function flushPendingLastLogins_() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(30000)) return 0
  var written = 0
  try {
    var props = PropertiesService.getScriptProperties()
    var all = props.getProperties() || {}
    var keys = Object.keys(all).filter(function (k) { return k.indexOf(LAST_LOGIN_PENDING_PREFIX) === 0 })
    if (!keys.length) return 0
    // メンバーごとに、いちばん新しい日時
    var pending = {}
    keys.forEach(function (k) {
      var id = memberIdFromPendingKey_(k)
      if (!pending[id] || String(all[k]) > pending[id]) pending[id] = String(all[k])
    })
    var sheet = getSheet_(SHEET_MEMBERS)
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var col = headers.indexOf('last_login')
    var lastRow = sheet.getLastRow()
    if (idCol < 0 || col < 0 || lastRow < 2) return 0
    var idValues = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues()
    var range = sheet.getRange(2, col + 1, lastRow - 1, 1)
    var values = range.getValues()
    idValues.forEach(function (r, i) {
      var id = String(r[0])
      if (pending[id]) {
        values[i][0] = pending[id]
        written++
      }
    })
    if (written) {
      range.setValues(values)
      SpreadsheetApp.flush()
    }
    // 書いたキー(このとき読んだキー)だけを消す。行の無いメンバーの分も消す
    keys.forEach(function (k) { props.deleteProperty(k) })
  } finally {
    lock.releaseLock()
  }
  return written
}

// リクエストの認証(セッショントークン)。返り値 { memberId, renewed(新しいセッショントークン or null) }
function authenticateRequest_(body) {
  if (!body.sessionToken) throw userError_('ログインしていません。再ログインしてください。')
  var payload = verifySessionToken_(body.sessionToken)
  return { memberId: String(payload.sub), renewed: renewSessionIfNeeded_(payload) }
}

// メンバーの世代番号を1増やし、そのメンバーに発行済みのセッショントークンをすべて無効にする
function bumpSessionGeneration_(memberId) {
  if (!memberId) return
  try {
    setRequestProp_(SESSION_GEN_PREFIX + memberId, String(sessionGeneration_(memberId) + 1))
  } catch (e) {
    Logger.log('bumpSessionGeneration failed: ' + e)
  }
}

// ---- ログインの無効化(revokeSessionsIssuedBefore などから使う) ----

function setSessionNotBefore_(sec) {
  var props = PropertiesService.getScriptProperties()
  var current = Number(props.getProperty('SESSION_NOT_BEFORE') || 0)
  // 後から古い日時を指定しても、既に無効にした範囲は戻さない
  var next = Math.max(current, Math.floor(sec))
  props.setProperty('SESSION_NOT_BEFORE', String(next))
  resetRequestProps_()
  console.log('この日時より前に発行されたログインを無効にしました: ' + new Date(next * 1000).toISOString())
}

// ---- 権限の例外(permission_overrides) ------------------------------------------
//
// 例外は「対象の種類(task / project / department / recruiting)」と「対象ID」
// 「アクセス水準(view < edit < approve)」の組。例外で許可するのは、下の表で
// その種類の例外を受け付けると決めた操作だけにする。表に無い操作(代表専用の
// 操作 — 役職の変更、メンバーの追加・削除など — や、設定・メンバー情報の
// 変更、経費・フォームの承認など)は、どの例外でも許可しない。
//   task      タスクを対象にする操作。タスクの例外に加え、そのタスクが属する
//             プロジェクト・部署の例外も使える(プロジェクト・部署はリクエストの
//             値ではなく、シート上のタスクの値で判定する)
//   project   プロジェクトを対象にする操作。body.projectId のプロジェクトの例外
//   recruiting 採用(候補者)の操作。採用の例外だけ
var OVERRIDE_SCOPE_BY_ACTION = {
  approveTask: 'task', assignTask: 'task', updateTaskDetails: 'task', updateVisibility: 'task',
  updateReviewer: 'task', updateReviewers: 'task', removeTask: 'task', updatePriority: 'task',
  updateDifficulty: 'task', updateSchedule: 'task', updateDependsOn: 'task', setBlocker: 'task',
  rejectTask: 'task',
  updateProjectDetails: 'project', updateProjectOwner: 'project', updateProjectParent: 'project',
  updateProjectArchived: 'project', updateProjectMembers: 'project', notifyProjectHealth: 'project',
  updateProjectHealthRecord: 'project', updateProjectHealth: 'project',
  addCandidate: 'recruiting', updateCandidate: 'recruiting', removeCandidate: 'recruiting',
  convertCandidateToMember: 'recruiting',
}

var OVERRIDE_ACCESS_LEVELS = { view: 0, edit: 1, approve: 2 }

// 例外の一覧が、対象(targets)に対して必要な水準を満たすか(Google のサービスを
// 使わない純粋な関数)。targets は { task, project, department, recruiting } の
// うち、その操作で見てよいものだけを持つ。
function overridesGrant_(overrides, targets, requiredLevel) {
  for (var i = 0; i < overrides.length; i++) {
    var ov = overrides[i] || {}
    var granted = OVERRIDE_ACCESS_LEVELS[ov.access]
    if (typeof granted !== 'number' || granted < requiredLevel) continue
    var targetId = String(ov.targetId || '')
    if (ov.targetType === 'task' && targets.task && targetId === targets.task) return true
    if (ov.targetType === 'project' && targets.project && targetId === targets.project) return true
    // 部門は、以前の部門名・部門IDのどちらでも同じ部門として比べる
    if (ov.targetType === 'department' && targets.department !== undefined &&
        normalizeValue_('department', targetId) === normalizeValue_('department', targets.department)) return true
    // recruiting: targetIdでの絞り込みは行わない（'all'固定運用のため、targetType一致とaccess水準のみで判定）
    if (ov.targetType === 'recruiting' && targets.recruiting) return true
  }
  return false
}

/**
 * Returns true if acting member has a permission_overrides entry that
 * applies to this action (see OVERRIDE_SCOPE_BY_ACTION). Used as OR
 * fallback when the role-based check denies.
 */
function checkPermissionOverride_(acting, action, body) {
  var overrides = acting.permission_overrides
  if (!overrides || overrides.length === 0) return false
  var scope = OVERRIDE_SCOPE_BY_ACTION[action]
  if (!scope) return false
  body = body || {}

  var targets = {}
  if (scope === 'task') {
    var taskId = String(body.taskId || '')
    if (!taskId) return false
    targets.task = taskId
    var taskRow = null
    try { taskRow = authFindRow_(SHEET_TASKS, taskId) } catch (e) { taskRow = null }
    if (taskRow) {
      targets.project = String(taskRow.project_id || '')
      targets.department = String(taskRow.department || '')
    }
  } else if (scope === 'project') {
    targets.project = String(body.projectId || '')
    if (!targets.project) return false
  } else if (scope === 'recruiting') {
    // 候補者を一般以外の役職でメンバー登録するのは役職の付与にあたるため、
    // 代表専用(採用の例外では許可しない)
    if (action === 'convertCandidateToMember' && roleTier_(getRoles_(), body.role) !== 'base') return false
    targets.recruiting = true
  }

  var required = action === 'approveTask' ? OVERRIDE_ACCESS_LEVELS.approve : OVERRIDE_ACCESS_LEVELS.edit
  return overridesGrant_(overrides, targets, required)
}

/**
 * Reads skill_level_thresholds from the Settings sheet.
 * Returns {} when the key is absent or unparseable.
 */
function getSkillLevelThresholds_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
    if (!sheet) return {}
    var data = sheet.getDataRange().getValues()
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === 'skill_level_thresholds') {
        return JSON.parse(data[i][1] || '{}')
      }
    }
  } catch (_) {}
  return {}
}

/**
 * Reads quiz_definitions from the Settings sheet.
 * Returns [] when the key is absent or unparseable.
 */
function getQuizDefinitions_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
    if (!sheet) return []
    var data = sheet.getDataRange().getValues()
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === 'quiz_definitions') {
        var defs = JSON.parse(data[i][1] || '[]')
        return Array.isArray(defs) ? defs : []
      }
    }
  } catch (_) {}
  return []
}

/**
 * Computes leveled-up skill_levels_json given current levels, cumulative
 * points, and threshold config. Returns the updated levels array.
 *
 * Logic: for each skill with points, check if total >= threshold * level.
 * The threshold is "points needed per level"; e.g. threshold=100 means
 * Lv1→Lv2 at 100pts, Lv2→Lv3 at 200pts, ..., max Lv5.
 */
function computeAutoLevels_(currentLevels, cumulativePoints, thresholds) {
  var DEFAULT_THRESHOLD = defaultSkillThreshold_(thresholds)
  var levels = {}
  for (var i = 0; i < currentLevels.length; i++) {
    levels[currentLevels[i].skill] = currentLevels[i].level
  }
  var skills = Object.keys(cumulativePoints)
  for (var j = 0; j < skills.length; j++) {
    var skill = skills[j]
    var pts = cumulativePoints[skill] || 0
    var thr = thresholds[skill] || DEFAULT_THRESHOLD
    var earnedLevel = Math.min(5, Math.floor(pts / thr) + 1)
    var current = levels[skill] || 1
    if (earnedLevel > current) levels[skill] = earnedLevel
  }
  var result = []
  var allSkills = Object.keys(levels)
  for (var k = 0; k < allSkills.length; k++) {
    result.push({ skill: allSkills[k], level: levels[allSkills[k]] })
  }
  return result
}

/**
 * 他団体で積んだ実績(共通スキルのポイント・資格)の持ち込み。本人が自分の
 * ページからエクスポートしたファイルを、新しい団体で自分のページから
 * インポートする想定(lib/ohsumi/portable-record.ts)。awardSkillPointsと同じ
 * 「累計加算→レベル自動繰り上げ」ロジックだが、タスクには紐付けない。
 * 資格は名前+取得日が一致するものは重複とみなしスキップして追記する。
 */
function importPortableRecord_(memberId, skillPoints, qualifications) {
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません: ' + memberId)

  var currentPoints = {}
  try { currentPoints = JSON.parse(memberRow.skill_points_json || '{}') } catch (_) {}
  var currentLevels = []
  try { currentLevels = JSON.parse(memberRow.skill_levels_json || '[]') } catch (_) {}
  var currentQualifications = []
  try { currentQualifications = JSON.parse(memberRow.qualifications_json || '[]') } catch (_) {}

  var skillKeys = Object.keys(skillPoints || {})
  for (var i = 0; i < skillKeys.length; i++) {
    var s = skillKeys[i]
    currentPoints[s] = (currentPoints[s] || 0) + (Number(skillPoints[s]) || 0)
  }

  var thresholds = getSkillLevelThresholds_()
  var newLevels = computeAutoLevels_(currentLevels, currentPoints, thresholds)

  var existingKeys = {}
  for (var j = 0; j < currentQualifications.length; j++) {
    var eq = currentQualifications[j]
    existingKeys[(eq.name || '') + '|' + (eq.acquiredDate || '')] = true
  }
  var incoming = qualifications || []
  for (var k = 0; k < incoming.length; k++) {
    var q = incoming[k]
    var key = (q.name || '') + '|' + (q.acquiredDate || '')
    if (existingKeys[key]) continue
    existingKeys[key] = true
    currentQualifications.push({
      id: 'q-' + Utilities.getUuid().slice(0, 8),
      name: q.name || '',
      acquiredDate: q.acquiredDate || undefined,
      issuer: q.issuer || undefined,
    })
  }

  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
    qualifications_json: JSON.stringify(currentQualifications),
  })
  return { ok: true, newPoints: currentPoints, newLevels: newLevels, qualifications: currentQualifications }
}

/**
 * Awards skill points to a member on task completion.
 * Updates skill_points_json and auto-levels skill_levels_json.
 * Also saves awarded_points_json on the task for future avg calculations.
 */
function awardSkillPoints_(taskId, memberId, points) {
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません: ' + memberId)

  var currentPoints = {}
  try { currentPoints = JSON.parse(memberRow.skill_points_json || '{}') } catch (_) {}
  var currentLevels = []
  try { currentLevels = JSON.parse(memberRow.skill_levels_json || '[]') } catch (_) {}

  // Accumulate points
  var skillKeys = Object.keys(points)
  for (var i = 0; i < skillKeys.length; i++) {
    var s = skillKeys[i]
    currentPoints[s] = (currentPoints[s] || 0) + (points[s] || 0)
  }

  // Compute auto-level-up
  var thresholds = getSkillLevelThresholds_()
  var newLevels = computeAutoLevels_(currentLevels, currentPoints, thresholds)

  // Persist
  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
  })
  if (taskId) {
    updateTaskFields_(taskId, { awarded_points_json: JSON.stringify(points) })
  }
  return { ok: true, newPoints: currentPoints, newLevels: newLevels }
}

/**
 * Processes a quiz submission. Reads the quiz definition from Settings,
 * scores the answers, and if pass rate is met, auto-levels the skill.
 */
function submitQuizResult_(quizId, memberId, answers, acting) {
  if (memberId !== acting.id && !isAdminRoleRef_(getRoles_(), acting.role)) {
    throw userError_('他のメンバーの代わりに検定を受けることはできません。')
  }
  var defs = getQuizDefinitions_()
  var quiz = null
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].id === quizId) { quiz = defs[i]; break }
  }
  if (!quiz) throw userError_('検定が見つかりません: ' + quizId)

  var questions = quiz.questions || []
  if (questions.length === 0) throw userError_('検定に設問がありません。')

  var correct = 0
  for (var j = 0; j < questions.length; j++) {
    if (answers[j] === questions[j].correctIndex) correct++
  }
  var score = Math.round((correct / questions.length) * 100)
  var passed = score >= quiz.passRate

  var newLevel = null
  if (passed) {
    var memberRow = findRow_(SHEET_MEMBERS, memberId)
    var currentLevels = []
    try { currentLevels = JSON.parse((memberRow && memberRow.skill_levels_json) || '[]') } catch (_) {}
    var targetSkill = quiz.targetSkill
    var targetLevel = quiz.targetLevel || 1
    var existing = currentLevels.find(function(sl) { return sl.skill === targetSkill })
    if (!existing || existing.level < targetLevel) {
      var nextLevels = currentLevels.filter(function(sl) { return sl.skill !== targetSkill })
      nextLevels.push({ skill: targetSkill, level: targetLevel })
      // SKL-009: skill_points_jsonもレベルと整合させる。computeAutoLevels_と
      // 同じ閾値計算(pts/threshold切り捨て+1=レベル)から逆算すると、
      // レベルLに達する最低ポイントはthreshold*(L-1)
      var thresholds = getSkillLevelThresholds_()
      var defaultThreshold = defaultSkillThreshold_(thresholds)
      var threshold = thresholds[targetSkill] || defaultThreshold
      var currentPoints = {}
      try { currentPoints = JSON.parse((memberRow && memberRow.skill_points_json) || '{}') } catch (_) {}
      var minPointsForLevel = threshold * (targetLevel - 1)
      if ((currentPoints[targetSkill] || 0) < minPointsForLevel) {
        currentPoints[targetSkill] = minPointsForLevel
      }
      updateMemberFields_(memberId, {
        skill_levels_json: JSON.stringify(nextLevels),
        skill_points_json: JSON.stringify(currentPoints),
      })
      newLevel = targetLevel
    }
  }
  return { ok: true, passed: passed, score: score, newLevel: newLevel }
}

/**
 * Enforces per-action role-based access control.
 * Throws with a human-readable Japanese error on denial.
 *
 * Tiers (most to least restrictive):
 *   代表のみ        — organization leader only
 *   代表 or 班長    — any admin role (isLeader)
 *   selfOrAdmin     — acting on body.memberId === self, or any admin
 *   本人のみ        — acting on body.memberId === self only
 *   誰でも          — any logged-in member (with extra checks where noted)
 */
// lib/ohsumi/permissions.ts の isFullAdminRole と同じ基準:
// role が空または '一般' なら false、Settings の restricted_roles に含まれていれば false、それ以外は true。
// 代表は authorizeAction_ の先頭で早期 return するため、実質的には「restrictedRoles に含まれない班長」を判定する。
function isActingFullAdmin_(acting) {
  return isFullAdminRoleRef_(getRoles_(), acting.role)
}

// 廃止した操作(画面が宛先・本文を送って通知させていたもの)。宛先と本文は GAS が保存したデータから決める:
//   notifyMention → updateComments の中で、保存したコメントのメンションから通知する
//   notifyTaskRejected → rejectTask(タスクを消し、シートのタスクの作成者・名前で通知する)
var REMOVED_ACTIONS = ['notifyMention', 'notifyTaskRejected']
var REMOVED_ACTION_MESSAGE = 'この操作は使えなくなりました。ページを読み込み直してください。'

function authorizeAction_(acting, action, body) {
  if (REMOVED_ACTIONS.indexOf(action) >= 0) throw userError_(REMOVED_ACTION_MESSAGE)
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
  var backupActions = ['getBackupStatus', 'listBackups', 'previewRestore', 'searchBackupTasks', 'restoreBackup', 'restoreTasks']
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
      action === 'updateDepartments' || action === 'deleteDepartment' || action === 'moveDepartmentTasks' || action === 'updateDiscordWebhookUrl' || action === 'updateSlackWebhookUrl' || action === 'testDiscordWebhook' || action === 'testSlackWebhook' || action === 'getWebhookStatus' || action === 'getMailQuotaStatus' || action === 'getGasUpdateStatus' || action === 'updateProjectHealth' || action === 'revokeMemberSessions') {
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
  'updateTaskSchedule', 'updateTaskForm',
  'updateProgress',   // 進捗のメモ・進捗率・進捗の記録(他人の記録は変えられない: validateProgressHistoryUpdate_)
  'setHoldReason',    // 保留の理由
]
var TASK_ANY_MEMBER_ACTIONS = {
  createTasks: '新しいタスクの登録。承認待ちとして作られ、既存のタスクは書き換えない',
  updateTaskStatus: '担当者だけが状態を変えられ、完了にできるのは確認者だけ(authorizeAction_ で確かめる)。担当者の決まっていないタスクは、誰でも着手できる',
  approveTaskReview: '確認者だけが承認できる(authorizeAction_ で確かめる)',
  updateComments: 'タスクを見られる人は誰でもコメントできる。他人のコメントは変え・消せない(validateCommentsUpdate_)',
  applyToOpenBid: '公募への応募・取り下げ。自分の分しか変えられない(authorizeAction_ で確かめる)',
  checkAndGenerateRecurringTasks: '定期タスクを、保存した規則どおりに作るだけ(内容は画面から受け取らない)',
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
  if (isActingFullAdmin_(acting)) return

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
    if (h.byId !== acting.id) {
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
  'translateText', 'getMyEmails', 'getBackgroundData', 'fetchDailyReports', 'checkAndGenerateRecurringTasks',
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
        if (memberIsInactive_(initAuth.memberId)) throw userError_(inactiveMessageOf_(initAuth.memberId))
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
      if (actingMember.inactive) throw userError_(inactiveMessageOf_(actingMember.id))
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
      result = createTasks_(body.tasks, actingMember.id)
      break
    case 'updateTaskStatus':
      // body.status は入口でコードにそろえている(normalizeRequestCodes_)
      result = updateTaskFields_(body.taskId, {
        status: sheetCode_('status', body.status),
        last_activity: todayStr_(),
        completed_date: body.status === 'done' ? todayStr_() : '',
      })
      // the assignee's "I'm done" signal — email the admins so they know
      // to go confirm it (they already see it in their 確認待ち panel)
      if (body.status === 'review') notifyReview_(body.taskId)
      break
    case 'assignTask':
      result = updateTaskFields_(body.taskId, {
        assignee_id: (body.assigneeIds || []).join(','),
      })
      syncCalendarForTask_(body.taskId)
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
      if (body.progressPercent !== undefined) progressFields.progress_percent = body.progressPercent
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
        var willTags = (body.will || []).join('、') || '（タグなし）'
        var willSubject = '[Ohsumi] Will タグが更新されました'
        var willBody = willName + 'さんのWillタグが更新されました。\n\n' +
          '【設定されたWillタグ】\n' + willTags + '\n\n' +
          'Ohsumiの人材画面で確認してください。'
        notifyAdmins_(willSubject, willBody)
        notifyChat_('💡 ' + willName + 'さんのWillタグが更新されました：' + willTags)
      } catch (err) {
        console.error('updateWillの通知送信に失敗しました: ' + maskEmailsIn_(String(err)))
      }
      break
    case 'updateTimezone':
      result = updateMemberFields_(body.memberId, { timezone: body.timezone || '' })
      break
    case 'updateLocale':
      result = updateMemberFields_(body.memberId, { locale: body.locale || '' })
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
      result = removeTask_(body.taskId)
      break
    case 'createProject':
      result = createProject_(body.name, body.description, body.type)
      break
    case 'removeProject':
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
        notify_settings: JSON.stringify(body.settings),
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
      result = updateMemberFields_(body.memberId, { reports_to_id: body.reportsToId || '' })
      break
    case 'updateMentor':
      result = updateMemberFields_(body.memberId, { mentor_id: body.mentorId || '' })
      break
    case 'updateDisplayName':
      result = updateMemberFields_(body.memberId, { display_name: body.displayName || '' })
      break
    case 'updateJoinedAt':
      result = updateMemberFields_(body.memberId, { joined_at: body.joinedAt || '' })
      break
    case 'updateUnavailableDates':
      result = updateMemberFields_(body.memberId, {
        unavailable_dates: (body.dates || []).join(','),
      })
      break
    case 'updateAvailableHours':
      result = updateMemberFields_(body.memberId, {
        available_hours_json: body.hours ? JSON.stringify(body.hours) : '',
      })
      break
    case 'updateSchedule':
      result = updateTaskFields_(body.taskId, {
        start_date: body.startDate || '',
        due_date: body.deadline || '',
      })
      notifyScheduleChange_(body.taskId)
      break
    case 'updateDependsOn':
      result = updateTaskFields_(body.taskId, {
        depends_on_ids: (body.dependsOnIds || []).join(','),
      })
      break
    case 'updateVisibility':
      result = updateTaskFields_(body.taskId, {
        visibility: sheetCode_('visibility', body.visibility),
      })
      break
    case 'updateReviewer':
      result = updateTaskFields_(body.taskId, { reviewer_id: body.reviewerId || '' })
      break
    case 'updateReviewers':
      result = updateTaskFields_(body.taskId, {
        reviewer_ids: (body.reviewerIds || []).join(','),
        reviewer_id: (body.reviewerIds && body.reviewerIds[0]) || '',
        required_approvals: body.requiredApprovals != null ? String(body.requiredApprovals) : '',
      })
      break
    case 'approveTaskReview':
      result = approveTaskReview_(body.taskId, actingMember.id, body.comment)
      break
    case 'setBlocker':
      result = updateTaskFields_(body.taskId, {
        blocker_note: body.note || '',
        blocker_since: body.note ? body.since || todayStr_() : '',
      })
      break
    case 'setHoldReason':
      result = updateTaskFields_(body.taskId, {
        hold_reason_note: body.note || '',
        hold_reason_since: body.note ? body.since || todayStr_() : '',
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
      break
    case 'updateEstimatedHours':
      result = updateTaskFields_(body.taskId, {
        estimated_hours: body.hours === null || body.hours === undefined ? '' : body.hours,
      })
      break
    case 'updateActualHours':
      result = updateTaskFields_(body.taskId, {
        actual_hours: body.hours === null || body.hours === undefined ? '' : body.hours,
      })
      break
    case 'updateRetrospective':
      result = updateTaskFields_(body.taskId, {
        retrospective_json: body.retrospective ? JSON.stringify(body.retrospective) : '',
      })
      break
    case 'updateTaskSchedule':
      result = updateTaskFields_(body.taskId, {
        schedule_json: body.schedule ? JSON.stringify(mapScheduleCodes_(body.schedule, sheetCode_)) : '',
      })
      break
    case 'notifyScheduleResult':
      // 保存した回答が揃っている時だけ、1回だけ送る
      result = { sent: notifyScheduleResult_(body.taskId, actingMember.id) }
      break
    case 'updateTaskForm':
      result = updateTaskFields_(body.taskId, {
        form_json: body.form ? JSON.stringify(body.form) : '',
      })
      break
    case 'notifyFormResult':
      result = { sent: notifyFormResult_(body.taskId, actingMember.id) }
      break
    case 'updateProjectMembers':
      result = updateProjectFields_(body.projectId, {
        member_ids: (body.memberIds || []).join(','),
      })
      break
    case 'updateProjectOwner':
      result = updateProjectFields_(body.projectId, { owner_id: body.ownerId || '' })
      break
    case 'updateProjectParent':
      result = updateProjectFields_(body.projectId, { parent_id: body.parentId || '' })
      break
    case 'updateProjectDetails':
      result = updateProjectFields_(body.projectId, {
        name: body.name || '',
        description: body.description || '',
        type: body.type || '',
        goal: body.goal || '',
        start_date: body.startDate || '',
        end_date: body.endDate || '',
      })
      break
    case 'updateProjectArchived':
      result = updateProjectFields_(body.projectId, {
        archived: body.archived ? 'TRUE' : 'FALSE',
      })
      break
    case 'updateProjectHealth':
      result = updateProjectHealthOverride_(body.projectId, body.healthOverride)
      break
    case 'notifyProjectHealth':
      result = notifyProjectHealth_(body.projectId, body.health)
      break
    case 'reportProjectHealth':
      // 自動判定の結果を複数プロジェクト分まとめて受け取り、記録の更新と
      // 通知(1通にまとめる)をサーバー側で判断する
      result = reportProjectHealth_(body.items)
      break
    case 'updateProjectHealthRecord':
      // item 26(追補): 通知なしでlast_notified_health列だけを更新する
      // （attentionから回復した際、次回の再悪化を確実に再通知するため）
      result = updateProjectFields_(body.projectId, { last_notified_health: body.health })
      break
    case 'updateAvatar':
      // choosing a color+initials avatar supersedes any uploaded picture
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
      result = addCandidate_(body.candidate || {})
      break
    case 'updateCandidate':
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
        custom_fields_json: JSON.stringify(body.customFields || {}),
      })
      break
    case 'updateEmail':
      setMemberEmail_(body.memberId, body.email || '')
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
      if (body.key === 'departments') throw userError_('部門の設定は、管理画面の部門の編集から変更してください。')
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
      // 休止にしたら、そのメンバーのログイン(全端末)を無効にする
      if (body.inactive) bumpSessionGeneration_(String(body.memberId))
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
        qualifications_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateEvaluationHistory':
      result = updateMemberFields_(body.memberId, {
        evaluation_history_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateTransferHistory':
      result = updateMemberFields_(body.memberId, {
        transfer_history_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateSkillLevels':
      result = updateMemberFields_(body.memberId, {
        skill_levels_json: JSON.stringify(body.levels || []),
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
        training_history_json: JSON.stringify(body.entries || []),
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
      result = updateMemberFields_(body.memberId, {
        development_plan_json: JSON.stringify(body.entries || []),
      })
      break
    case 'updateOneOnOnes':
      result = updateMemberFields_(body.memberId, {
        one_on_ones_json: JSON.stringify(body.entries || []),
      })
      break
    case 'awardSkillPoints':
      result = awardSkillPoints_(body.taskId, body.memberId, body.points || {})
      break
    case 'importPortableRecord':
      result = importPortableRecord_(body.memberId, body.skillPoints || {}, body.qualifications || [])
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
      result = updateMemberFields_(body.memberId, { absent_dates: (body.dates || []).join(',') })
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

// ---- Tasks ----------------------------------------------------------------

// New rows are built by walking the sheet's actual header row (see
// gas/README.md for the full column list), so this works regardless of
// column order and leaves any column not listed below blank.
function createTasks_(tasks, actingMemberId) {
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var nextId = nextIntId_(sheet, headers)
  var today = todayStr_()
  var created = []

  tasks.forEach(function (t) {
    var id = String(nextId++)
    var row = headers.map(function (h) {
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
        default:
          return ''
      }
    })
    // F4: 値を書き込む前に対象列を書式なしテキスト(@)にする
    assertRowCellLengths_('Tasks', headers, row)
    protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, 'Tasks')
    sheet.appendRow(row)
    created.push({ tempId: t.tempId, id: id })
    if (t.assigneeIds && t.assigneeIds.length > 0) syncCalendarForTask_(id)
  })

  // template tasks (pendingApproval === false) don't need an approval-queue email
  var needsApproval = tasks.filter(function (t) {
    return t.pendingApproval !== false
  })
  if (needsApproval.length > 0) notifyNewTasks_(needsApproval)
  return created
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
    var task = requestRow_(SHEET_TASKS, taskId)
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
    notifyChat_('🔔 「' + task.title + '」が確認待ちになりました。')
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

// ---- メール送信(テスト環境では本来の宛先に送らない) ---------------------------
//
// スクリプトプロパティ TEST_ENVIRONMENT が true の場合は、本来の宛先には送らず、
// スクリプトプロパティ TEST_NOTIFICATION_EMAIL の1つのアドレスにだけ送る
// (件名に [テスト] を付け、本文の先頭に本来の宛先を書く)。未設定の場合は
// 送信せず、実行ログに記録するだけにする。メールの送信は必ずこの関数を通す。

function isTestEnvironment_() {
  return PropertiesService.getScriptProperties().getProperty('TEST_ENVIRONMENT') === 'true'
}

// ---- 通知・翻訳の回数の上限(1人あたり) -----------------------------------------
//
// 画面からのリクエストで送る通知(メール・Discord/Slack・通知のキュー)は、操作したメンバーごとに
// 1時間に RATE_LIMITS.notify.limit 件まで。超えた分は送らず、応答に notifyLimited: true を付ける
// (操作そのものは成功させる)。どの操作から送る通知も、ここを通るので数えられる(新しく足した操作も)。
// 時間主導トリガー(毎日の処理など)から送る通知は、操作したメンバーがいないので数えない。
// 送った時刻は CacheService に覚える(ロックを取っていない読み取りの操作では、同時のリクエストで
// 数件多く通ることがある)。
var RATE_LIMITS = {
  // メール・Discord/Slack・通知のキュー(1件ずつ数える)
  notify: { limit: 60, windowSec: 3600, tunable: 'notifyPerHour' },
  // コメントのメンションで通知する宛先の数
  mention: { limit: 30, windowSec: 3600, tunable: 'mentionPerHour' },
  // 日程調整・フォームの結果、研修の申請・承認の通知(1回ずつ数える)
  resultNotify: { limit: 10, windowSec: 3600, tunable: 'resultNotifyPerHour' },
  // 翻訳する文の数(Google の翻訳の1日の回数は、団体全体で分け合うため)
  translate: { limit: 500, windowSec: 3600, tunable: 'translatePerHour' },
  // 画面のエラーの記録(1人1時間)
  clientError: { limit: 30, windowSec: 3600, tunable: 'clientErrorPerHour' },
}
// 今の上限(レジストリから届いた値。届いていなければ RATE_LIMITS の limit)
function rateLimitOf_(kind) {
  var spec = RATE_LIMITS[kind]
  return spec.tunable ? tunable_(spec.tunable, spec.limit) : spec.limit
}
var _requestActorId = null
var _notifyLimited = false

function rateLimitKey_(kind, memberId) {
  return 'rl:' + kind + ':' + sha256Base64Url_(String(memberId))
}

// この時間の窓の中で使った回数(送った時刻の一覧)
function rateLimitTimes_(kind, memberId, nowMs) {
  var spec = RATE_LIMITS[kind]
  var times = []
  try { times = JSON.parse(CacheService.getScriptCache().get(rateLimitKey_(kind, memberId)) || '[]') } catch (e) { times = [] }
  if (!Array.isArray(times)) times = []
  return times.filter(function (t) { return typeof t === 'number' && t > nowMs - spec.windowSec * 1000 && t <= nowMs })
}

/** count 回ぶん使えるなら記録して true。上限を超えるなら記録せずに false */
function takeRateLimit_(kind, memberId, count, nowMs) {
  var spec = RATE_LIMITS[kind]
  nowMs = nowMs || Date.now()
  count = Math.max(1, Math.floor(count || 1))
  var times = rateLimitTimes_(kind, memberId, nowMs)
  if (times.length + count > rateLimitOf_(kind)) return false
  for (var i = 0; i < count; i++) times.push(nowMs)
  try { CacheService.getScriptCache().put(rateLimitKey_(kind, memberId), JSON.stringify(times), spec.windowSec) } catch (e) { /* 覚えられなくても続ける */ }
  return true
}

// 画面からのリクエストで送る通知を1件数える。上限を超えたら送らない(false)
function allowRequestNotification_(what) {
  if (!_requestActorId) return true
  if (takeRateLimit_('notify', _requestActorId, 1)) return true
  _notifyLimited = true
  console.warn('通知の上限(1人1時間に' + rateLimitOf_('notify') + '件)を超えたため、送りませんでした: ' + what)
  return false
}

// メールを送る。送れたら true。送らなかった時(通知の回数の上限・メールの1日の上限)は false
function sendMail_(options) {
  return sendMailChecked_(options) === 'sent'
}

// メールを送り、結果を返す: 'sent'(送った) / 'limited'(1人あたりの通知の上限で送らなかった) / 'quota'(メールの1日の上限で送らなかった)
function sendMailChecked_(options) {
  if (!allowRequestNotification_('メール ' + options.subject)) return 'limited'
  var count = mailRecipientCount_(options)
  if (count > 0) {
    var remaining = mailRemainingQuota_()
    if (remaining !== null && remaining < count) {
      recordMailQuotaSkip_(count, options.subject)
      return 'quota'
    }
  }
  countAction_('mailCount')
  // どの通知からも、サイトを開けるようにする(正式なサイトの <サイト>/?org=<団体ID>)
  var mail = {}
  Object.keys(options).forEach(function (k) { mail[k] = options[k] })
  mail.body = withSiteLink_(options.body)
  try {
    measureAction_('mailMs', function () { return sendMailUnmeasured_(mail) })
  } catch (e) {
    // 残りの数を確かめた後に、ほかの送信で上限に達した時など
    if (quotaKind_(e) !== 'email') throw e
    recordMailQuotaSkip_(Math.max(1, count), options.subject)
    return 'quota'
  }
  return 'sent'
}

// ---- メールの1日の上限 --------------------------------------------------------------
//
// 団体の GAS は「自分として実行」なので、メールは GAS を動かすアカウントの1日の上限(宛先の数。
// Google アカウントは 100、Google Workspace は 1,500)を、団体の全員で分け合う。
// 送る前に残りの数(MailApp.getRemainingDailyQuota)を確かめ、足りなければ送らずに記録する
// (スクリプトプロパティ MAIL_QUOTA_STATE)。記録は、代表の管理画面(getMailQuotaStatus)と、
// レジストリへの確認(checkIn)で伝える。送れなかった通知は、宛先ごとの毎日のまとめに回す(sendLocalizedEmail_)
var MAIL_QUOTA_STATE_KEY = 'MAIL_QUOTA_STATE'

function mailQuotaToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
}

// 残りの数(分からない時は null。送る前の確かめを省き、送る時の失敗で判断する)
function mailRemainingQuota_() {
  try {
    var n = MailApp.getRemainingDailyQuota()
    return typeof n === 'number' && isFinite(n) ? n : null
  } catch (e) {
    return null
  }
}

// このメールで使う上限の数(宛先の数)。テスト環境では、TEST_NOTIFICATION_EMAIL の1件だけ(無ければ送らないので 0)
function mailRecipientCount_(options) {
  if (isTestEnvironment_()) {
    return String(PropertiesService.getScriptProperties().getProperty('TEST_NOTIFICATION_EMAIL') || '').trim() ? 1 : 0
  }
  var n = 0
  ;[options.to, options.cc, options.bcc].forEach(function (v) {
    String(v || '').split(',').forEach(function (e) { if (e.trim()) n++ })
  })
  return n
}

// 今日の記録: { date, skipped(送れなかった数), reachedAt(今日、上限に達した時刻), lastReachedDate(最後に上限に達した日) }
function readMailQuotaState_() {
  var s = null
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty(MAIL_QUOTA_STATE_KEY) || 'null') } catch (e) { s = null }
  var today = mailQuotaToday_()
  if (!s || typeof s !== 'object') return { date: today, skipped: 0, reachedAt: '', lastReachedDate: '' }
  var last = String(s.lastReachedDate || '')
  if (s.date !== today) return { date: today, skipped: 0, reachedAt: '', lastReachedDate: last }
  return { date: today, skipped: Number(s.skipped) || 0, reachedAt: String(s.reachedAt || ''), lastReachedDate: last }
}

function recordMailQuotaSkip_(count, subject) {
  var s = readMailQuotaState_()
  s.skipped += Math.max(1, count || 1)
  if (!s.reachedAt) s.reachedAt = new Date().toISOString()
  s.lastReachedDate = s.date
  try {
    PropertiesService.getScriptProperties().setProperty(MAIL_QUOTA_STATE_KEY, JSON.stringify(s))
  } catch (e) {
    console.error('メールの上限の記録を書けませんでした: ' + e)
  }
  console.warn('メールの1日の上限に達したため、送りませんでした(今日 ' + s.skipped + ' 件): ' + subject)
}

// 画面(代表の管理画面)とレジストリに伝える形
function mailQuotaStatus_() {
  var s = readMailQuotaState_()
  return { remaining: mailRemainingQuota_(), date: s.date, skipped: s.skipped, reachedAt: s.reachedAt, lastReachedDate: s.lastReachedDate }
}

// ---- Google の利用の上限に達した時のエラー ----------------------------------------------
//
// GAS の1日の上限に達すると、Google は「Service invoked too many times for one day: email.」などの例外を投げる。
// どの上限かを見分け(email / urlfetch / properties / other)、画面には決まった文を返す(上限でなければ null)
function quotaKind_(err) {
  var msg = String((err && err.message) || err || '')
  var m = msg.match(/too many times for one day:\s*([a-z]+)/i)
  if (m) {
    var k = m[1].toLowerCase()
    return k === 'email' || k === 'urlfetch' || k === 'properties' ? k : 'other'
  }
  if (/Bandwidth quota exceeded/i.test(msg)) return 'urlfetch'
  if (/property storage quota/i.test(msg)) return 'properties'
  if (/Service invoked too many times/i.test(msg)) return 'other'
  return null
}

// login: ログイン(セッションの確かめ・Google でのログイン)の途中で上限に達した時
function quotaMessage_(kind, login) {
  var what = {
    email: 'この団体の、今日のメールの上限に達しました。',
    urlfetch: 'この団体の GAS が、今日の外部への通信(Google のログインの確認・Discord/Slack への通知など)の上限に達しました。',
    properties: 'この団体の GAS が、今日の設定の読み書き(スクリプトプロパティ)の上限に達しました。',
    other: 'この団体の GAS が、今日の Google の利用の上限に達しました。',
  }[kind] || ''
  return (login ? 'ログインを確かめられませんでした。' : '') + what +
    'あなたのアカウントの問題ではありません。上限は1日ごとに戻ります。続く時は、代表に知らせてください。'
}

// ログインの確かめで失敗した時の応答。上限に達した時は、ログインの失敗と分かる文を返し、
// authError を付けない(画面がログインし直しを求めても、上限が戻るまで同じ失敗になるため)
function authFailure_(err) {
  var kind = quotaKind_(err)
  if (kind) return { ok: false, error: quotaMessage_(kind, true), quotaExceeded: kind }
  return { ok: false, error: toErrorMessage_(err), authError: true }
}

function sendMailUnmeasured_(options) {
  if (!isTestEnvironment_()) {
    MailApp.sendEmail(options)
    return
  }
  var original = [options.to, options.cc, options.bcc].filter(Boolean).join(',')
  var redirect = String(PropertiesService.getScriptProperties().getProperty('TEST_NOTIFICATION_EMAIL') || '').trim()
  if (!redirect) {
    console.log(
      '[テスト環境] メールを送信しませんでした(TEST_NOTIFICATION_EMAIL が未設定)。件名: ' + options.subject +
        ' / 本来の宛先: ' + maskEmailsIn_(original),
    )
    return
  }
  var notice = '(テスト環境のため、本来の宛先ではなくこのアドレスに送信しています。本来の宛先: ' + original + ')\n\n'
  var redirected = {}
  Object.keys(options).forEach(function (key) {
    if (key !== 'to' && key !== 'cc' && key !== 'bcc') redirected[key] = options[key]
  })
  redirected.to = redirect
  redirected.subject = '[テスト] ' + options.subject
  redirected.body = notice + (options.body || '')
  if (options.htmlBody) redirected.htmlBody = '<p>' + notice.trim() + '</p>' + options.htmlBody
  MailApp.sendEmail(redirected)
  console.log('[テスト環境] メールを ' + maskEmailsIn_(redirect) + ' に送信しました。件名: ' + options.subject + ' / 本来の宛先: ' + maskEmailsIn_(original))
}

// 呼び出し方は2通り:
//   - 新パターン(多言語対応): notifyAdmins_({ ja: {subject, body}, en: {subject, body} }, preferredEmails, opts)
//   - 旧パターン(後方互換、常に日本語): notifyAdmins_(subject, body, preferredEmails, opts)
// 第1引数がオブジェクトかどうかで判別する。
// 宛先(同じ内容を、団体の通知先と管理者に重ねて送らない):
//   1. preferredEmails(報告先など、その人あての通知)があれば、その人たちだけ
//   2. 無ければ、団体の通知先(org_notification_emails)があればそこにすぐ送り、通知を受け取る設定にした管理者
//      (notify_new_task)は毎日のまとめに入れる(団体の通知先と同じアドレスなら1回だけ)
//   3. それも無ければ、通知を受け取る設定の管理者(いなければ管理者の役職の人)
// opts.urgent が無いものは、毎日のまとめに入れる。急ぎのものでも、Discord/Slack をつないだ団体では、
// 管理者あて(2・3)のメールはまとめに回す(すぐの知らせは Discord/Slack に届くため)
function notifyAdmins_(subject, body, preferredEmails, opts) {
  return measureAction_('notifyMs', function () { return notifyAdminsUnmeasured_(subject, body, preferredEmails, opts) })
}

function chatConnected_() {
  return !isChatSuppressed_() && !!(getDiscordWebhookUrl_() || getSlackWebhookUrl_())
}

function notifyAdminsUnmeasured_(subject, body, preferredEmails, opts) {
  try {
    var templates
    if (subject && typeof subject === 'object') {
      templates = subject
      opts = preferredEmails
      preferredEmails = body
    } else {
      templates = { ja: { subject: subject, body: body } }
    }
    var urgent = !!(opts && opts.urgent)

    if (preferredEmails && preferredEmails.length > 0) {
      var to = uniqueEmails_(preferredEmails)
      deliverNotification_(to, templates, urgent)
      console.log('notifyAdmins: preferredEmailsに' + (urgent ? '送信' : 'まとめに追加') + 'しました ' + maskEmailsIn_(to.join(',')))
      return
    }
    // Discord/Slack をつないだ団体では、管理者あてのメールはまとめに回す(evenIfChat: Webhook の変更の知らせなど、
    // Discord/Slack そのものが書き換えられたかもしれない時は、すぐ送る)
    if (urgent && !(opts && opts.evenIfChat) && chatConnected_()) urgent = false
    var orgEmails = orgNotificationEmails_()
    var members = measureAction_('recipientsMs', function () { return snapshotTableOrSheet_(SHEET_MEMBERS) })
    var headers = members.headers
    var rows = members.rows
    var idCol = headers.indexOf('id')
    var notifyCol = headers.indexOf('notify_new_task')
    var roleCol = headers.indexOf('role')
    var emailMap = getAllMemberEmails_()
    if (Object.keys(emailMap).length === 0 && orgEmails.length === 0) {
      console.warn('notifyAdmins: MemberEmailsにメール登録がなく、団体メールも未設定のため送信しませんでした')
      return
    }

    var opted = []
    var reps = []
    if (idCol !== -1) {
      rows.forEach(function (r) {
        var email = emailMap[String(r[idCol])]
        if (!email) return
        var notify = notifyCol !== -1 && /^(true|1|yes)$/i.test(String(r[notifyCol] || ''))
        if (notify) opted.push(email)
        // any admin-level role (i.e. not blank and not "一般") counts as a
        // fallback recipient — role names are freely renamed/added/removed
        // from Admin > Tags, so this can't hardcode a specific role string
        else if (roleCol !== -1 && isAdminRoleRef_(getRoles_(), r[roleCol])) reps.push(email)
      })
    }
    // 団体の通知先がある時: すぐ送るのは団体の通知先だけ。自分で通知を受け取る設定にした管理者(notify_new_task)には、
    // 毎日のまとめに入れる(団体の通知先と同じアドレスなら、団体の通知先への1回だけ)
    if (orgEmails.length > 0) {
      var org = splitEmails_(orgEmails)
      var orgSet = {}
      org.forEach(function (e) { orgSet[e.toLowerCase()] = true })
      deliverNotification_(org, templates, urgent)
      var optedOthers = splitEmails_(opted).filter(function (e) { return !orgSet[e.toLowerCase()] })
      if (optedOthers.length) deliverNotification_(optedOthers, templates, false)
      console.log('notifyAdmins: 団体の通知先に' + (urgent ? '送信' : 'まとめに追加') + 'しました' +
        (optedOthers.length ? '(通知を受け取る設定の管理者 ' + optedOthers.length + '人は、まとめに追加)' : ''))
      return
    }
    var recipients = uniqueEmails_(opted.length > 0 ? opted : reps)
    if (recipients.length === 0) {
      console.warn(
        'notifyAdmins: 宛先を解決できませんでした（notify_new_task=TRUEのメンバーがおらず、「一般」以外のroleを持つメンバーにメール登録もなく、団体メールも未設定）— 送信しませんでした',
      )
      return
    }

    deliverNotification_(recipients, templates, urgent)
    console.log('notifyAdmins: ' + (urgent ? '送信先 ' : 'まとめの宛先 ') + maskEmailsIn_(recipients.join(',')))
  } catch (err) {
    // a mail error shouldn't roll back the caller's action, but log it so
    // it's visible in Executions instead of failing completely silently
    console.error('notifyAdminsの送信に失敗しました: ' + maskEmailsIn_(String(err) + (err && err.stack ? '\n' + err.stack : '')))
  }
}

// Resolves the "admin of admins" recipients for a set of assignee member
// ids: each assignee's reports_to_id (if set) mapped to that member's
// email. Returns [] when nobody involved has a reports_to_id set, so
// callers fall back to notifyAdmins_' default opted-in/代表 logic.
function reportsToEmails_(assigneeIds) {
  return measureAction_('recipientsMs', function () {
    try {
      var members = snapshotTableOrSheet_(SHEET_MEMBERS)
      var idCol = members.headers.indexOf('id')
      var reportsToCol = members.headers.indexOf('reports_to_id')
      if (idCol === -1 || reportsToCol === -1) return []
      var emailMap = getAllMemberEmails_()

      var byId = {}
      members.rows.forEach(function (r) {
        byId[String(r[idCol])] = { reportsTo: String(r[reportsToCol] || '').trim() }
      })

      var emails = []
      ;(assigneeIds || []).forEach(function (aid) {
        var m = byId[String(aid)]
        var managerId = m && m.reportsTo
        var managerEmail = managerId && emailMap[managerId]
        if (managerEmail && emails.indexOf(managerEmail) === -1) {
          emails.push(managerEmail)
        }
      })
      return emails
    } catch (err) {
      console.error('reportsToEmailsの処理に失敗しました: ' + maskEmailsIn_(String(err)))
      return []
    }
  })
}

// Resolves member ids to their email addresses (skips members with no
// email on file). Used by the notifications (queueNotification_ など).
function memberEmailsByIds_(memberIds) {
  try {
    var emailMap = getAllMemberEmails_()
    var emails = []
    ;(memberIds || []).forEach(function (id) {
      var email = emailMap[String(id)]
      if (email) emails.push(email)
    })
    return emails
  } catch (err) {
    console.error('memberEmailsByIdsの処理に失敗しました: ' + maskEmailsIn_(String(err)))
    return []
  }
}

// メールアドレス一覧を受け取り、Membersシートを1回スキャンして
// { email: locale } のマップを返す（'en'以外は全て'ja'扱い）。
// 多言語メール送信（sendLocalizedEmail_）で、宛先ごとに言語を
// 出し分けるために使う。
function localesByEmails_(emails) {
  return measureAction_('recipientsMs', function () { return localesByEmailsUnmeasured_(emails) })
}

function localesByEmailsUnmeasured_(emails) {
  var result = {}
  if (!emails || emails.length === 0) return result
  var wanted = {}
  emails.forEach(function (e) { wanted[e.toLowerCase()] = true })
  try {
    // まずメールアドレス表で「wantedなメールを持つのはどのmemberIdか」を引く
    // (1人が複数メールをカンマ区切りで登録している場合にも対応)
    var emailMap = loadMemberEmailMap_()
    var idToMatchedEmails = {}
    Object.keys(emailMap).forEach(function (mid) {
      String(emailMap[mid] || '').split(',').map(function (e) { return e.trim() }).filter(Boolean).forEach(function (e) {
        if (wanted[e.toLowerCase()]) {
          if (!idToMatchedEmails[mid]) idToMatchedEmails[mid] = []
          idToMatchedEmails[mid].push(e)
        }
      })
    })
    if (Object.keys(idToMatchedEmails).length === 0) return result

    // 次にメンバー(スナップショット)でそのmemberIdのlocaleを引く
    var members = snapshotTableOrSheet_(SHEET_MEMBERS)
    var idCol = members.headers.indexOf('id')
    var localeCol = members.headers.indexOf('locale')
    if (idCol === -1) return result
    members.rows.forEach(function (r) {
      var mid = String(r[idCol])
      var matched = idToMatchedEmails[mid]
      if (!matched) return
      var locale = (localeCol !== -1 && String(r[localeCol]) === 'en') ? 'en' : 'ja'
      matched.forEach(function (e) { result[e] = locale })
    })
  } catch (err) {
    console.error('localesByEmailsの処理に失敗しました: ' + maskEmailsIn_(String(err)))
  }
  return result
}

// 宛先をlocaleごとにグループ化し、localeごとに言語を出し分けたメールを
// 送信する。templates は { ja: {subject, body}, en: {subject, body} } の形。
// localeが判明しない宛先は'ja'扱い（既存の全メール日本語固定という
// 挙動からの後方互換のため）。
function sendLocalizedEmail_(emails, templates) {
  if (!emails || emails.length === 0) return
  var locales = localesByEmails_(emails)
  var groups = { ja: [], en: [] }
  emails.forEach(function (e) {
    var loc = locales[e] || 'ja'
    groups[templates[loc] ? loc : 'ja'].push(e)
  })
  Object.keys(groups).forEach(function (loc) {
    var list = groups[loc]
    if (list.length === 0) return
    var tpl = templates[loc] || templates.ja
    // メールの1日の上限で送れなかった時は、宛先ごとの毎日のまとめに回す(翌朝のまとめで送る)
    if (sendMailChecked_({ to: list.join(','), subject: tpl.subject, body: tpl.body }) === 'quota') {
      list.forEach(function (e) { addToDigest_(e, loc, tpl.subject, tpl.body) })
    }
  })
}

// ---- 急ぎの通知と、毎日のまとめ ---------------------------------------------------------
//
// メールの1日の上限(団体の全員で分け合う)を使い切らないよう、メールですぐ送るのは急ぎのものだけにする:
//   承認の依頼・確認の依頼・自分へのメンション・停止の予告・招待メール・自分のメールに送る
// それ以外は、宛先ごとの毎日のまとめ(1人1日1通。dailyMaintenance の最後に送る)に入れる。
// 画面の中のお知らせは、これまでどおりすべて出す(メールとは別。ここでは変えない)。
// まとめは、宛先ごとのスクリプトプロパティ notif_digest_<アドレスのハッシュ> に、受け取る人の言語の文で入れる
// (1人あたり DIGEST_MAX_BYTES まで。入りきらない分は件数だけ数え、画面で確かめるよう書く)
var DIGEST_PREFIX = 'notif_digest_'
var DIGEST_MAX_BYTES = 2000
var DIGEST_BODY_CHARS = 160
// まとめを送る時に、急ぎのメールのために残しておく数(今日の残りがこれ以下なら、まとめは明日に回す)
var DIGEST_MAIL_RESERVE = 10
// 急ぎの通知の種類(queueNotification_。それ以外は、メンバーの設定に関わらずまとめに入れる)
var URGENT_NOTIFY_KINDS = { mention: true, review: true, new_task: true }

function digestKey_(email) {
  return DIGEST_PREFIX + sha256Base64Url_(String(email).trim().toLowerCase())
}

function utf8Bytes_(text) {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/gi, 'x').length
}

function readDigest_(raw) {
  var d = null
  try { d = JSON.parse(raw || 'null') } catch (e) { d = null }
  if (!d || typeof d !== 'object' || !Array.isArray(d.items)) return null
  return d
}

// 1件をまとめに入れる(文は、受け取る人の言語のもの)
function addToDigest_(email, loc, subject, body) {
  email = String(email || '').trim()
  if (!email) return
  var props = PropertiesService.getScriptProperties()
  var key = digestKey_(email)
  var d = readDigest_(props.getProperty(key)) || { email: email, loc: loc || 'ja', items: [], more: 0 }
  if (loc) d.loc = loc
  var text = String(body || '')
  if (text.length > DIGEST_BODY_CHARS) text = text.slice(0, DIGEST_BODY_CHARS) + '…'
  d.items.push({ s: String(subject || '').slice(0, 200), b: text, ts: new Date().toISOString() })
  while (d.items.length > 1 && utf8Bytes_(JSON.stringify(d)) > DIGEST_MAX_BYTES) {
    d.items.pop()
    d.more = (Number(d.more) || 0) + 1
  }
  props.setProperty(key, JSON.stringify(d))
}

// 宛先(1人が複数のアドレスをカンマ区切りで持つこともある)を、1つずつのアドレスにする
function splitEmails_(emails) {
  var out = []
  ;(emails || []).forEach(function (v) {
    String(v || '').split(',').forEach(function (e) { if (e.trim()) out.push(e.trim()) })
  })
  return uniqueEmails_(out)
}

// 通知を送る。urgent なら今すぐメールで、そうでなければ宛先ごとの毎日のまとめに入れる
function deliverNotification_(emails, templates, urgent) {
  var list = splitEmails_(emails)
  if (!list.length) return
  if (urgent) {
    sendLocalizedEmail_(list, templates)
    return
  }
  if (!allowRequestNotification_('まとめ ' + ((templates.ja && templates.ja.subject) || ''))) return
  var locales = localesByEmails_(list)
  list.forEach(function (e) {
    var loc = templates[locales[e]] ? locales[e] : 'ja'
    var tpl = templates[loc] || templates.ja
    addToDigest_(e, loc, tpl.subject, tpl.body)
  })
}

// 毎日のまとめを送る(dailyMaintenance の最後)。1人1通。メールの上限で送れなかった分は、明日に回す
function flushDailyDigests_() {
  var props = PropertiesService.getScriptProperties()
  var all = props.getProperties()
  var keys = Object.keys(all).filter(function (k) { return k.indexOf(DIGEST_PREFIX) === 0 })
  var stopped = false
  keys.forEach(function (key) {
    if (stopped) return
    var d = readDigest_(all[key])
    if (!d || !d.email || !d.items.length) { props.deleteProperty(key); return }
    var remaining = mailRemainingQuota_()
    if (remaining !== null && remaining <= tunable_('digestMailReserve', DIGEST_MAIL_RESERVE)) {
      stopped = true
      console.warn('メールの残りが少ないため、毎日のまとめの残り(' + (keys.length) + '人分まで)を明日に回しました')
      return
    }
    var text = digestMailText_(d)
    if (sendMailChecked_({ to: d.email, subject: text.subject, body: text.body }) === 'quota') { stopped = true; return }
    // 送っている間に足された分は残す
    var now = readDigest_(props.getProperty(key))
    var rest = now ? now.items.slice(d.items.length) : []
    if (rest.length) {
      now.items = rest
      now.more = Math.max(0, (Number(now.more) || 0) - (Number(d.more) || 0))
      props.setProperty(key, JSON.stringify(now))
    } else {
      props.deleteProperty(key)
    }
  })
}

function digestMailText_(d) {
  var en = d.loc === 'en'
  var more = Number(d.more) || 0
  var n = d.items.length + more
  var body = (en
    ? 'Here is your Ohsumi summary. Urgent notices (approval requests, mentions, etc.) are sent separately as they happen.\n\n'
    : 'Ohsumi のお知らせのまとめです。急ぎのもの(承認の依頼・メンションなど)は、その都度お送りしています。\n\n') +
    d.items.map(function (i) { return '【' + i.s + '】\n' + i.b }).join('\n\n---\n\n')
  if (more) {
    body += '\n\n' + (en
      ? '...and ' + more + ' more. Please check them on the Ohsumi screen.'
      : 'ほか ' + more + ' 件あります。Ohsumi の画面で確かめてください。')
  }
  return { subject: en ? 'Ohsumi daily summary (' + n + ')' : 'Ohsumi 今日のまとめ (' + n + '件)', body: body }
}

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
    notifyChat_('📚 ' + name + 'さんから研修「' + trainingName + '」の申請がありました。')
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
    var task = requestRow_(SHEET_TASKS, taskId)
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
    notifyChat_('🗓️ 「' + task.title + '」の日程調整で全員の回答が揃いました。')
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
    var task = requestRow_(SHEET_TASKS, taskId)
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
    notifyChat_('📝 「' + task.title + '」のフォームで全員の回答が揃いました。')
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
    var task = requestRow_(SHEET_TASKS, taskId)
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

// Creates/updates a Google Calendar event (on this script's default
// calendar) for a task's assignees, inviting them by email if known.
// Best-effort — never throws back to the caller.
function syncCalendarForTask_(taskId) {
  return measureAction_('calendarMs', function () { return syncCalendarForTaskUnmeasured_(taskId) })
}

function syncCalendarForTaskUnmeasured_(taskId) {
  try {
    if (featureDisabled_('calendarSync')) return
    var task = findRow_(SHEET_TASKS, taskId)
    if (!task || !task.due_date) return

    var assigneeIds = String(task.assignee_id || '')
      .split(',')
      .map(function (s) {
        return s.trim()
      })
      .filter(Boolean)
    if (assigneeIds.length === 0) return

    var emailMap = getAllMemberEmails_()
    var guests = assigneeIds.map(function (aid) { return emailMap[String(aid)] }).filter(Boolean)
    if (guests.length === 0) return

    // テスト環境では招待(メール)を本来の宛先に送らない。予定は作るが、ゲストは付けない
    var eventOptions = isTestEnvironment_()
      ? {}
      : { guests: guests.join(','), sendInvites: true }
    // 予定からサイトを開けるようにする(レジストリに確かめていない団体では付けない)
    var eventLink = ''
    try { eventLink = canonicalInviteLink_() } catch (linkErr) { eventLink = '' }
    if (eventLink) eventOptions.description = 'Ohsumi を開く / Open Ohsumi: ' + eventLink
    if (isTestEnvironment_()) {
      console.log('[テスト環境] カレンダーの招待を送りませんでした。予定: ' + task.title + ' / 本来のゲスト: ' + maskEmailsIn_(guests.join(',')))
    }

    var cal = CalendarApp.getDefaultCalendar()
    var title = '[Ohsumi] ' + task.title
    var existing = cal.getEvents(
      new Date(task.due_date + 'T00:00:00'),
      new Date(task.due_date + 'T23:59:59'),
      { search: title },
    )
    existing.forEach(function (ev) {
      ev.deleteEvent()
    })

    if (task.due_time) {
      var start = new Date(task.due_date + 'T' + task.due_time + ':00')
      var end = new Date(start.getTime() + 60 * 60 * 1000)
      cal.createEvent(title, start, end, eventOptions)
    } else {
      cal.createAllDayEvent(title, new Date(task.due_date + 'T00:00:00'), eventOptions)
    }
  } catch (err) {
    // best-effort — Calendar quota/permissions issues shouldn't break assignment
  }
}

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
    for (var j = projectIds.length - 1; j >= 0; j--) {
      if (String(projectIds[j][0]) === String(projectId)) {
        tasks.deleteRow(j + 2)
        forgetSheetGrid_()
      }
    }
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
function removeTask_(taskId) {
  var tasks = getSheet_(SHEET_TASKS)
  var taskHeaders = headerRow_(tasks)
  var idCol = taskHeaders.indexOf('id') + 1
  var lastRow = tasks.getLastRow()
  var ids = idCol > 0 ? tasks.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(taskId)) {
      tasks.deleteRow(i + 2)
      forgetSheetGrid_()
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
function addMember_(name, email, affiliation, role) {
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
  return { id: id }
}

// ---- MemberEmails (非公開シート) ---------------------------------------------
//
// メールアドレスはMembersシート(公開CSV)には置かず、こちらの非公開シートに
// id(=Members.idと同じ値)をキーとして1人1行で保持する。読み書きは必ず
// このセクションの関数経由で行い、Membersシート側に書き戻さないこと。

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

// getMemberEmailValue_ と同じ値を、メールアドレス表の版ごとのキャッシュ(メンバーID → メール)から返す。
// 版はメールの登録・変更・メンバーの削除・直接の編集で変わる(findMemberIdByEmailCached_ と同じ)
// ---- 通知の宛先を調べる時の、メンバー・メールアドレス・設定 ----
// メンバー・設定は、スナップショット(読み取り・認証と同じキャッシュ。版で作り直される)から、
// メールアドレスは、メールアドレス表の版ごとのキャッシュ(ID → メール)から引く(シートを読み直さない)。
// 読めない時はシートから読む。通知の宛先・言語だけに使う(権限の判定には使わない)

function snapshotTableOrSheet_(name) {
  try {
    var table = loadSnapshot_().data[name]
    if (table && table.headers) return table
  } catch (e) {
    // 読めなければシートから
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) return { headers: [], rows: [] }
  var values = sheet.getDataRange().getValues()
  return { headers: (values[0] || []).map(function (h) { return String(h).trim() }), rows: values.slice(1) }
}

function snapshotRowOrSheet_(name, rowId) {
  var table = snapshotTableOrSheet_(name)
  var idCol = table.headers.indexOf('id')
  if (idCol < 0) return null
  for (var i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i][idCol]) !== String(rowId)) continue
    var obj = {}
    table.headers.forEach(function (h, c) { obj[h] = table.rows[i][c] })
    return obj
  }
  return null
}

// メンバーID → メール(登録のまま。カンマ区切りで複数のことがある)。空のメンバーも入る
function loadMemberEmailMap_() {
  var key = memberEmailMapKey_()
  if (_requestEmailMap && _requestEmailMap.key === key) return _requestEmailMap.map
  var cache = null
  var map = null
  try {
    cache = CacheService.getScriptCache()
    var raw = cache.get(key)
    if (raw) map = JSON.parse(raw)
  } catch (e) { map = null }
  if (map) {
    noteTiming_('myEmailCache', 'hit')
  } else {
    noteTiming_('myEmailCache', 'miss')
    map = {}
    var table = readWholeSheet_(SHEET_MEMBER_EMAILS, 'myEmail')
    var idCol = table ? table.headers.indexOf('id') : -1
    var emailCol = table ? table.headers.indexOf('email') : -1
    if (table && idCol >= 0 && emailCol >= 0) {
      table.rows.forEach(function (row) {
        var id = String(row[idCol])
        if (!(id in map)) map[id] = String(row[emailCol] || '')
      })
    }
    try { cache.put(key, JSON.stringify(map), SNAPSHOT_CACHE_TTL) } catch (e) { /* 大きすぎる場合は毎回読む */ }
  }
  _requestEmailMap = { key: key, map: map }
  return map
}

function getMemberEmailValueCached_(memberId) {
  return loadMemberEmailMap_()[String(memberId)] || ''
}

// メンバー1人分のメールを書く(行が無ければ追加、あれば上書き)。
// ログイン用の対応表のキャッシュ(findMemberIdByEmailCached_)を無効にする。
function setMemberEmail_(memberId, email) {
  var before = ''
  try { before = getMemberEmailValue_(memberId) } catch (e) { before = '' }
  try {
    writeMemberEmail_(memberId, email)
    // 登録していたアドレスが外された場合は、そのメンバーのログイン(全端末)を無効にする
    var normalize = function (v) {
      return String(v || '').split(',').map(function (x) { return x.trim().toLowerCase() }).filter(Boolean)
    }
    var after = normalize(email)
    if (normalize(before).some(function (addr) { return after.indexOf(addr) === -1 })) bumpSessionGeneration_(memberId)
  } finally {
    bumpMemberEmailsVersion_()
  }
}

function writeMemberEmail_(memberId, email) {
  var sheet = getMemberEmailsSheet_()
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var emailCol = headers.indexOf('email')
  var lastRow = sheet.getLastRow()
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : []
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(memberId)) {
      sheet.getRange(i + 2, emailCol + 1).setValue(email || '')
      return
    }
  }
  appendRowByHeaders_(sheet, SHEET_MEMBER_EMAILS, { id: memberId, email: email || '' })
}

// MemberEmailsシート全体を1回読み、{ memberId: email } のマップを返す。
// メール解決が必要な箇所(通知・カレンダー招待・言語判定など)はここから
// 引く — Membersシートはもうemail列を持たない。
function getAllMemberEmails_() {
  return measureAction_('recipientsMs', function () {
    var map = {}
    var all = loadMemberEmailMap_()
    Object.keys(all).forEach(function (id) {
      var email = String(all[id] || '').trim()
      if (email) map[id] = email
    })
    return map
  })
}

// Saves a profile picture (sent as a data: URL, already resized client-side)
// into the upload folder (see getUploadFolder_), makes it link-viewable so it can be
// hotlinked from an <img> tag, replaces any previous upload for this
// member, and records the resulting URL on their Members row.
function uploadAvatar_(memberId, dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError_('Expected a base64 data URL')
  var mimeType = match[1]
  var base64Data = match[2]

  var folder = getUploadFolder_()
  var namePrefix = 'avatar_' + memberId + '_'

  // remove any previous upload for this member so the folder doesn't
  // accumulate orphaned files every time someone changes their picture
  var existing = folder.getFiles()
  while (existing.hasNext()) {
    var f = existing.next()
    if (f.getName().indexOf(namePrefix) === 0) f.setTrashed(true)
  }

  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing_(file)

  // googleusercontent.com hotlinks more reliably in <img> tags than
  // Drive's own "uc?export=view" (which can trigger a virus-scan
  // interstitial) or "thumbnail?id=" (rate-limited more aggressively) URLs
  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w256-h256-c'
  console.log('uploadAvatar: memberId=' + memberId + ' url=' + url)
  var writeResult = updateMemberFields_(memberId, { avatar_url: url })
  console.log('uploadAvatar: updateMemberFieldsの結果=' + JSON.stringify(writeResult))
  return { url: url }
}

// 団体ロゴをDriveにアップロードし、Settingsシートのorg_logo_urlを更新する。
// uploadAvatarと異なりMembersシートは変更しない。
function uploadOrgLogo_(dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError_('Expected a base64 data URL')
  var mimeType = match[1]
  var base64Data = match[2]

  var folder = getUploadFolder_()
  var namePrefix = 'org_logo_'

  var existing = folder.getFiles()
  while (existing.hasNext()) {
    var f = existing.next()
    if (f.getName().indexOf(namePrefix) === 0) f.setTrashed(true)
  }

  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing_(file)

  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w256-h256-c'
  console.log('uploadOrgLogo: url=' + url)
  updateSetting_('org_logo_url', url)
  return { url: url }
}

// EXP-003: 経費申請の領収書をDriveにアップロードする。
// アバター/ロゴと異なり1人につき何枚もアップロードされうるため、
// 既存ファイルの削除は行わない。領収書は画像だけでなくPDFのこともあるので
// サムネイルURLではなく汎用のDrive表示URLを返す。
function uploadExpenseReceipt_(dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]*);base64,(.*)$/)
  if (!match) throw userError_('Expected a base64 data URL')
  var bytes = Utilities.base64Decode(match[2])
  // 領収書は5MBまで、画像(JPEG・PNG・HEICなど)とPDFのみ(フロントでも同じ確認をする)
  var mimeType = validateReceiptFile_(match[1], filename, bytes.length)

  var folder = getUploadFolder_()
  var namePrefix = 'expense_receipt_'

  var blob = Utilities.newBlob(bytes, mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing_(file)

  var url = file.getUrl()
  console.log('uploadExpenseReceipt: url=' + url)
  return { url: url }
}

// FRM-007: アンケート設問の画像をDriveにアップロードする。
// uploadExpenseReceiptと同じパターン(複数枚アップロードされうるため
// 既存ファイルの削除はしない)。ただしこちらは画像専用なので、
// アバターと同じgoogleusercontent.comホットリンク形式のURLを返す。
function uploadSurveyImage_(dataUrl, filename) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError_('Expected a base64 data URL')
  var mimeType = match[1]
  var base64Data = match[2]

  var folder = getUploadFolder_()
  var namePrefix = 'survey_image_'

  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename)
  var file = folder.createFile(blob)
  file.setName(namePrefix + Date.now())
  applyUploadSharing_(file)

  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w512-h512-c'
  console.log('uploadSurveyImage: url=' + url)
  return { url: url }
}

// Members に列が無ければ、見出しの末尾に足す(setupOhsumi を実行し直していない団体でも、退会を記録できるように)
function ensureMemberColumns_(names) {
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var col = headers.length
  names.forEach(function (n) {
    if (headers.indexOf(n) >= 0) return
    col++
    sheet.getRange(1, col).setValue(n)
    headers.push(n)
  })
  forgetSheetGrid_(SHEET_MEMBERS)
}

// 退会: メンバーを非表示にして保留する(個人情報は保存期間の後に消す。「個人情報の削除」)。
// ログインできなくし(inactive)、未完了のタスクの担当からは外す(完了・確認待ちのタスクの担当は、記録として残す)
function removeMember_(memberId, actorId, nowMs) {
  nowMs = nowMs || Date.now()
  ensureMemberColumns_(['withdrawn_at', 'purge_at', 'personal_data_purged_at', 'withdrawal_unassigned_task_ids'])
  var member = findRow_(SHEET_MEMBERS, memberId)
  if (!member) throw userError_('メンバーが見つかりません。')
  if (String(member.withdrawn_at || '')) return { removed: String(memberId), withdrawnAt: String(member.withdrawn_at) }

  var tasks = getSheet_(SHEET_TASKS)
  var taskHeaders = headerRow_(tasks)
  var assigneeCol = taskHeaders.indexOf('assignee_id') + 1
  var statusCol = taskHeaders.indexOf('status') + 1
  var taskIdCol = taskHeaders.indexOf('id') + 1
  var unassigned = []
  if (assigneeCol > 0) {
    var taskLastRow = tasks.getLastRow()
    var assignees = tasks.getRange(2, assigneeCol, Math.max(taskLastRow - 1, 0), 1).getValues()
    var statuses = statusCol > 0 ? tasks.getRange(2, statusCol, Math.max(taskLastRow - 1, 0), 1).getValues() : []
    var taskIds = taskIdCol > 0 ? tasks.getRange(2, taskIdCol, Math.max(taskLastRow - 1, 0), 1).getValues() : []
    for (var j = 0; j < assignees.length; j++) {
      var status = statusCol > 0 ? normalizeCode_('status', statuses[j][0]) : ''
      if (WITHDRAW_KEEP_ASSIGNEE_STATUSES.indexOf(status) >= 0) continue
      var remaining = String(assignees[j][0] || '')
        .split(',')
        .map(function (s) {
          return s.trim()
        })
        .filter(function (id) {
          return id && id !== String(memberId)
        })
      if (remaining.length !== String(assignees[j][0] || '').split(',').filter(Boolean).length) {
        tasks.getRange(j + 2, assigneeCol).setValue(remaining.join(','))
        if (taskIds[j]) unassigned.push(String(taskIds[j][0]))
      }
    }
  }
  var withdrawnAt = new Date(nowMs).toISOString()
  // 未アサインに戻したタスク(退会を取り消した時に、代表に一覧を出す)
  updateMemberFields_(memberId, { inactive: 'TRUE', withdrawn_at: withdrawnAt, purge_at: '', withdrawal_unassigned_task_ids: unassigned.join(',') })
  // ログイン用の対応表のキャッシュを無効にし、退会したメンバーのログイン(全端末)を無効にする
  bumpMemberEmailsVersion_()
  bumpSessionGeneration_(memberId)
  var purgeAt = new Date(nowMs + personalDataRetentionDays_() * 24 * 3600 * 1000).toISOString()
  appendOrgAudit_(actorId, 'removeMember', String(memberId), { withdrawnAt: withdrawnAt, purgeAt: purgeAt })
  return { removed: String(memberId), withdrawnAt: withdrawnAt, purgeAt: purgeAt }
}

// ---- Settings (optional key/value sync sheet) ------------------------------

// Upserts one row of the Settings sheet by key. Used for the skill/category/
// role-level option pools and project templates (see gas/README.md) —
// each holds its whole current value (comma list or JSON) in a single cell.
function updateSetting_(key, value) {
  var sheet = getOrCreateSheet_(SHEET_SETTINGS, ['key', 'value'])
  var headers = headerRow_(sheet)
  var keyCol = headers.indexOf('key') + 1
  var valueCol = headers.indexOf('value') + 1
  if (keyCol === 0 || valueCol === 0) throw userError_('Settings sheet needs "key" and "value" columns')

  var lastRow = sheet.getLastRow()
  var keys = lastRow > 1 ? sheet.getRange(2, keyCol, lastRow - 1, 1).getValues() : []
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) {
      // F4(レビュー指摘対応2): Settingsは書き込み頻度が低く性能上の懸念が
      // ない上、setupOhsumi()が初期キーを書式設定なしでappendRowするため、
      // Tasks等と違い「行作成時に必ず保護済み」という前提が成り立たない。
      // よって更新のたびに設定する。
      if (typeof value === 'string' && value.length > CELL_MAX_CHARS) {
        assertCellLength_(SHEET_SETTINGS, 'value', value, sheet.getRange(i + 2, valueCol).getValue())
      }
      // 前の値は、8割を超える時だけ読む(初めて超えたかを確かめるため)
      if (typeof value === 'string' && value.length > CELL_WARN_CHARS) {
        noteLongCell_(SHEET_SETTINGS, String(key), String(key), 'value', value, sheet.getRange(i + 2, valueCol).getValue())
      }
      protectRowFromFormulaInjection_(sheet, headers, i + 2, 'Settings')
      sheet.getRange(i + 2, valueCol).setValue(value)
      return { key: key }
    }
  }
  var row = headers.map(function (h) {
    if (h === 'key') return key
    if (h === 'value') return value
    return ''
  })
  assertRowCellLengths_(SHEET_SETTINGS, headers, row)
  protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, 'Settings')
  sheet.appendRow(row)
  return { key: key }
}

// ---- shared row helpers -----------------------------------------------------

function getSheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) throw userError_('Sheet not found: ' + name)
  return sheet
}

// Like getSheet_, but creates the tab (with the given header row) instead
// of throwing when it doesn't exist yet — used for the optional Settings
// tab so admins don't have to pre-create it before the first sync.
function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(name)
  if (sheet) return sheet
  sheet = ss.insertSheet(name)
  sheet.appendRow(headers)
  return sheet
}

function headerRow_(sheet) {
  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (h) {
      return String(h).trim()
    })
}

function nextIntId_(sheet, headers) {
  var idCol = headers.indexOf('id') + 1
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return 1
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues()
  var max = 0
  ids.forEach(function (r) {
    var n = parseInt(r[0], 10)
    if (!isNaN(n) && n > max) max = n
  })
  return max + 1
}

// Reads a whole row (by its "id" column) into a {headerName: value} object.
function findRow_(sheetName, rowId) {
  return measureAction_('sheetReadMs', function () { return findRowUnmeasured_(sheetName, rowId) })
}

function findRowUnmeasured_(sheetName, rowId) {
  var sheet = getSheet_(sheetName)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (idCol === -1) throw userError_('シートの構成が不正です。管理者にお問い合わせください。')

  var lastRow = sheet.getLastRow()
  var values = sheet.getRange(2, 1, Math.max(lastRow - 1, 0), headers.length).getValues()
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idCol]) === String(rowId)) {
      var obj = {}
      headers.forEach(function (h, c) {
        obj[h] = values[i][c]
      })
      return obj
    }
  }
  return null
}

// Finds the row whose "id" column equals rowId, and writes `fields`
// (a {headerName: value} map) into the matching columns of that row.
// F5: 成果物リンク・経費の領収書URLがhttp/https以外(javascript:等)で
// ないことを保存時に検証する。フロント側の入力時チェック・表示時チェックと
// 同じ基準をサーバー側でも掛ける(フロントを経由しない直接のAPI呼び出しに
// 対する防御)。
function isSafeHttpUrl_(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

// F4: 自由入力(ユーザーが自由なテキストを入力できる)列の一覧。数式インジェ
// クション対策として、書き込み前にこれらの列のセルを書式なしテキスト(@)に
// してから値を設定する(セルに値を書き込んだ「後」にsetNumberFormatしても、
// 既に数式として解釈された内容は元に戻らないため、必ず値を書く前に呼ぶこと)。
// _json列・数値列・ID列・日付列・固定選択肢(enum)列はここに含めない
// (JSON文字列は必ず"["か"{"で始まるためSheets側で数式と誤解釈されない)。
// シート名は文字列リテラルで直接指定する — SHEET_EXPENSES等の定数は
// このオブジェクトより後ろで定義されており、スクリプト読み込み時点では
// まだ代入されていないため使えない。
var FORMULA_INJECTION_PROTECTED_COLUMNS = {
  Tasks: ['title', 'description', 'category', 'skills', 'progress_note', 'blocker_note'],
  Projects: ['name', 'description', 'goal'],
  Members: [
    'name', 'display_name', 'career_aspiration', 'desired_future_role', 'career_plan',
    'university', 'faculty', 'department_name', 'will_tags', 'judgment_tags',
    'department_path', 'desired_areas', 'desired_skills',
  ],
  Expenses: ['receipt_url', 'justification', 'purpose', 'rejection_reason'],
  Candidates: ['name', 'phone', 'resume_text', 'interview_notes'],
  DailyReports: ['done_text', 'todo_text', 'issues_text'],
  // value列にはorg_name等の自由入力に加えrole_levels/permission_overrides_json
  // 等のJSON値も入るが、書式なしテキスト化はJSON文字列の読み書きに影響しない
  // (JSON.parseは文字列の内容だけを見るため)ので列全体を対象にする。
  Settings: ['value'],
}

// 指定した行のうち、そのシートで保護対象の列だけを書式なしテキスト(@)にする。
// appendRowで新しい行を追加する「前」に、追加先になる行番号(sheet.getLastRow()+1)
// に対して呼ぶ想定。
function protectRowFromFormulaInjection_(sheet, headers, rowNumber, sheetName) {
  var cols = FORMULA_INJECTION_PROTECTED_COLUMNS[sheetName]
  if (!cols) return
  cols.forEach(function (colName) {
    var idx = headers.indexOf(colName)
    if (idx >= 0) sheet.getRange(rowNumber, idx + 1).setNumberFormat('@')
  })
}

function updateRowFields_(sheetName, rowId, fields) {
  return measureAction_('sheetWriteMs', function () { return updateRowFieldsUnmeasured_(sheetName, rowId, fields) })
}

// 1回の実行(リクエスト)の中で読んだシートの形(見出しと、ID → 行番号)を覚えて、同じシートへの
// 2回目からの書き込み・行の読み込みで使い回す(batch で同じタスクに2つの操作を書く時など)。
// 読む時はシート全体を1回の呼び出し(getDataRange)で読む(これまでは見出し・最終行・ID の列を別々に読んでいた)。
// この実行の中で書いた値は values にも入れる(requestRow_ が書いた後の行を返せるように)。
// 行を削除した時は forgetSheetGrid_ で忘れる(行番号がずれるため)。行の追加では既存の行番号は変わらないので、
// 見つからない ID があった時だけ読み直す
var _sheetGrids = {}

function forgetSheetGrid_(sheetName) {
  if (sheetName) delete _sheetGrids[sheetName]
  else _sheetGrids = {}
}

function loadSheetGrid_(sheetName) {
  var sheet = getSheet_(sheetName)
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rowOf = {}
  if (idCol >= 0) {
    for (var i = 1; i < values.length; i++) {
      var id = String(values[i][idCol])
      if (id !== '' && !(id in rowOf)) rowOf[id] = i + 1
    }
  }
  var grid = { sheet: sheet, headers: headers, idCol: idCol, rowOf: rowOf, values: values }
  _sheetGrids[sheetName] = grid
  return grid
}

// 行番号(見つからなければ、一度だけ読み直して探す)
function sheetGridRow_(sheetName, rowId) {
  var grid = _sheetGrids[sheetName] || loadSheetGrid_(sheetName)
  var r = grid.rowOf[String(rowId)]
  if (!r && grid.loadedFresh !== true) {
    grid = loadSheetGrid_(sheetName)
    grid.loadedFresh = true
    r = grid.rowOf[String(rowId)]
  }
  return { grid: grid, row: r || -1 }
}

function updateRowFieldsUnmeasured_(sheetName, rowId, fields) {
  var found = sheetGridRow_(sheetName, rowId)
  var grid = found.grid
  var headers = grid.headers
  // F14: シート名などの内部情報はエラーメッセージに含めない
  if (grid.idCol < 0) throw userError_('シートの構成が不正です。管理者にお問い合わせください。')
  var targetRow = found.row
  if (targetRow === -1) throw userError_(sheetName + ' row not found for id ' + rowId)

  var missingKeys = []
  var cols = []
  // F4(性能・レビュー指摘対応4): ここでは書式を設定しない。保護対象列は
  // 行の新規作成時に必ずprotectRowFromFormulaInjection_()で書式なしテキスト
  // (@)にしてからappendRowしているため、既存行のセルは既にその書式に
  // なっている前提が成り立つ(そうでない過去データはauditFormulaInjectionRisks(true)
  // で一度だけ修正する — gas/README.md参照)。毎回setNumberFormatし直すと
  // 書き込みの多いTasks等で余計なAPI呼び出しが倍になるため省略する。
  Object.keys(fields).forEach(function (key) {
    var col = headers.indexOf(key) + 1
    if (col === 0) {
      missingKeys.push(key)
      return // このシートにまだ無い列 — 個別にはスキップするが、下でまとめて報告する
    }
    cols.push({ col: col, value: fields[key] })
  })
  // 更新しようとした列が1つも見つからなかった場合、無音で「成功」を返すと
  // フロント側は保存できたと誤認する（実際は何も書き込まれていない）。
  // 新しい列をCode.gs側に追加しただけでは既存のシートには反映されない
  // （setupOhsumi()の再実行が必要）ため、このケースは実運用で起こりうる。
  if (cols.length === 0 && missingKeys.length > 0) {
    throw userError_(
      sheetName + 'シートに列が見つかりません: ' + missingKeys.join(', ') +
      '。Apps Scriptエディタで setupOhsumi() を実行してヘッダー列を追加してください。',
    )
  }
  // 1つのセルの上限(5万文字)を超える値は、何も書かずに断る。8割を超えた値は、書いた後に知らせる
  var before = grid.values[targetRow - 1] || []
  cols.forEach(function (c) { assertCellLength_(sheetName, headers[c.col - 1], c.value, before[c.col - 1]) })
  // 書き込みの競合チェック: 内容を変える書き込みは、画面が開いた時の版と今の版を比べ、ほかの人が先に変えていたら断る。
  // 通ったら版を新しくする(row_version の列が無い古いシートでは、何もしない)
  var bump = rowVersionBump_(sheetName, rowId, headers, before, Object.keys(fields))
  if (bump) bump.forEach(function (c) { cols.push(c) })
  // 隣り合う列は1回の setValues にまとめる。離れた列は、間のセル(数式など)を書き換えないよう別に書く
  // (セルへの書き込みは、Apps Script が書き込みの確定の時にまとめて送る)
  cols.forEach(function (c) { noteLongCell_(sheetName, rowId, recordName_(headers, before), headers[c.col - 1], c.value, before[c.col - 1]) })
  contiguousColumnRuns_(cols).forEach(function (run) {
    grid.sheet.getRange(targetRow, run[0].col, 1, run.length).setValues([run.map(function (c) { return c.value })])
  })
  var rowValues = grid.values[targetRow - 1]
  if (rowValues) cols.forEach(function (c) { rowValues[c.col - 1] = c.value })

  return { id: rowId, updated: Object.keys(fields) }
}

// ---- 書き込みの競合チェック(行の版) ----
//
// Members・Projects・Tasks の行は、内容を変えるたびに row_version(行の版)を新しくし、変えた人を row_updated_by に残す。
// 画面は保存の時に、開いた時点の版(baseVersions: { 'Tasks:t1': 'r…' })を送る。今の版と違い、しかも最後に変えたのが
// 自分でない時は、ほかの人が先に変えたので、上書きせずに断る(conflict)。自分が続けて保存した時(版は自分が変えた)は通す。
// 記録の一覧(コメント・1on1 など)は、項目ごとの差分(listOps)で受け取って項目ごとに確かめるので、行の版は使わない。
// 最後のログイン日時などの記録の列も、版を変えない(ROW_VERSION_IGNORED_FIELDS)
var ROW_VERSION_SHEETS = ['Members', 'Projects', 'Tasks']
var ROW_VERSION_IGNORED_FIELDS = [
  'row_version', 'row_updated_by',
  // 記録・通知のための列
  'last_login', 'last_inactive_notified', 'last_notified_health', 'last_activity',
  // 項目ごとの差分で確かめる記録の一覧と、GAS が足し算でまとめる列
  'comments_json', 'progress_history_json', 'history_json', 'deliverables_json',
  'career_history_json', 'qualifications_json', 'evaluation_history_json', 'transfer_history_json',
  'skill_levels_json', 'competencies_json', 'training_history_json', 'development_plan_json', 'one_on_ones_json',
  'survey_responses_json', 'skill_points_json', 'awarded_points_json',
]
// このリクエスト(batch では操作ごと)で画面が送った、開いた時点の版
var _expectedRowVersions = null

var CONFLICT_MESSAGE = 'ほかの人が先にこの内容を変えたため、保存しませんでした。最新の内容を読み込み直します。書いた文章は消えていないので、コピーしてもう一度入れてください。'

function conflictError_(sheetName, rowId) {
  var e = userError_(CONFLICT_MESSAGE)
  e.conflict = { sheet: String(sheetName), id: String(rowId) }
  return e
}

function setExpectedRowVersions_(body) {
  var v = body && body.baseVersions
  _expectedRowVersions = v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

function newRowVersion_() {
  return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36)
}

// 内容を変える書き込みなら、版を確かめて、新しい版の列(cols に足すもの)を返す。版の列が無い・記録の列だけの時は null
function rowVersionBump_(sheetName, rowId, headers, before, keys) {
  if (ROW_VERSION_SHEETS.indexOf(sheetName) < 0) return null
  var vCol = headers.indexOf('row_version')
  var byCol = headers.indexOf('row_updated_by')
  if (vCol < 0 || byCol < 0) return null
  if (!keys.some(function (k) { return ROW_VERSION_IGNORED_FIELDS.indexOf(k) < 0 })) return null
  var actor = _requestActorId ? String(_requestActorId) : 'system'
  var key = sheetName + ':' + rowId
  if (_expectedRowVersions && Object.prototype.hasOwnProperty.call(_expectedRowVersions, key)) {
    var expected = String(_expectedRowVersions[key] || '')
    var current = String(before[vCol] === undefined || before[vCol] === null ? '' : before[vCol])
    var lastBy = String(before[byCol] === undefined || before[byCol] === null ? '' : before[byCol])
    if (current !== expected && lastBy !== actor) throw conflictError_(sheetName, rowId)
  }
  return [{ col: vCol + 1, value: newRowVersion_() }, { col: byCol + 1, value: actor }]
}

// ---- 記録の一覧の差分(listOps) ----
//
// コメント・進み具合の記録・変更の記録・成果物と、メンバーの経歴・資格・評価・異動・スキル・コンピテンシー・研修・育成の計画・
// 1on1 の記録は、1つのセルに一覧(JSON)で持つ。画面は一覧を丸ごと送らず、項目ごとの差分を送る:
//   { op: 'add', entry }                 足す(同じキーが既にあれば、同じ内容なら何もしない・違えば競合)
//   { op: 'update', key, before, entry } 変える(今の内容が before と違う・消えていれば競合)
//   { op: 'remove', key, before }        消す(既に消えていれば何もしない。今の内容が before と違えば競合)
// GAS は、ロックを取った後に今のセルの一覧へ差分を当てて書く。差分に無い項目(ほかの人が後から足した記録など)は、
// 管理者の操作でも消えない。一覧を丸ごと送る古い画面からの保存は、読み込み直してもらう(LEGACY_LIST_MESSAGE)
var LIST_ACTIONS = {
  updateComments: { sheet: 'Tasks', idParam: 'taskId', column: 'comments_json', param: 'comments', key: 'id' },
  updateProgress: { sheet: 'Tasks', idParam: 'taskId', column: 'progress_history_json', param: 'progressHistory', key: 'id' },
  updateHistory: { sheet: 'Tasks', idParam: 'taskId', column: 'history_json', param: 'history', key: 'id', addAt: 'start', cap: 50, addOnly: true },
  updateDeliverables: { sheet: 'Tasks', idParam: 'taskId', column: 'deliverables_json', param: 'deliverables', key: 'id' },
  updateCareerHistory: { sheet: 'Members', idParam: 'memberId', column: 'career_history_json', param: 'entries', key: 'id' },
  updateQualifications: { sheet: 'Members', idParam: 'memberId', column: 'qualifications_json', param: 'entries', key: 'id' },
  updateEvaluationHistory: { sheet: 'Members', idParam: 'memberId', column: 'evaluation_history_json', param: 'entries', key: 'id' },
  updateTransferHistory: { sheet: 'Members', idParam: 'memberId', column: 'transfer_history_json', param: 'entries', key: 'id' },
  updateSkillLevels: { sheet: 'Members', idParam: 'memberId', column: 'skill_levels_json', param: 'levels', key: 'skill' },
  updateCompetencies: { sheet: 'Members', idParam: 'memberId', column: 'competencies_json', param: 'competencies', key: 'name' },
  updateTrainingHistory: { sheet: 'Members', idParam: 'memberId', column: 'training_history_json', param: 'entries', key: 'id' },
  updateDevelopmentPlan: { sheet: 'Members', idParam: 'memberId', column: 'development_plan_json', param: 'entries', key: 'id' },
  updateOneOnOnes: { sheet: 'Members', idParam: 'memberId', column: 'one_on_ones_json', param: 'entries', key: 'id' },
}
var LIST_OPS_MAX = 200
var LEGACY_LIST_MESSAGE = 'Ohsumi が更新されました。書いた文章をコピーしてから、ページを読み込み直してください。'

// ロックを取った後に、今のシートの一覧で権限を確かめ直す(他人の記録を変え・消していないか。新しい記録の書いた人は本人)
function revalidateListWrite_(body, acting) {
  var cfg = LIST_ACTIONS[body.action]
  if (cfg.sheet !== 'Tasks') return
  var row = lockedRow_(SHEET_TASKS, String(body.taskId || ''))
  if (!row) throw userError_('対象のタスクが見つかりません。')
  if (body.action === 'updateComments') validateCommentsUpdate_(row, body.comments, acting)
  if (body.action === 'updateProgress') validateProgressHistoryUpdate_(row, body.progressHistory, acting)
  if (body.action === 'updateHistory') validateHistoryUpdate_(row, body.history, acting)
}

// 一覧を丸ごと送る古い画面からの保存か(差分 listOps が無く、一覧そのものがある)
function legacyListWrite_(body) {
  var cfg = body && LIST_ACTIONS[body.action]
  return !!cfg && body.listOps === undefined && body[cfg.param] !== undefined
}

// 比べるための形(キーの順番をそろえ、undefined を除く)
function canonicalJson_(v) {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson_).join(',') + ']'
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined })
      .map(function (k) { return JSON.stringify(k) + ':' + canonicalJson_(v[k]) }).join(',') + '}'
  }
  return JSON.stringify(v)
}

function parseListCell_(raw) {
  var list = []
  try { list = JSON.parse(raw || '[]') } catch (e) { list = [] }
  return Array.isArray(list) ? list : []
}

// 今の一覧(current)に差分(ops)を当てた一覧を返す。strict の時は、競合があれば conflict で断る
// (ロックを取る前の権限の判定では、スナップショットの一覧に当てるので、競合は見ない)
function applyListOps_(cfg, current, ops, strict, sheetName, rowId, normalize) {
  if (!Array.isArray(ops) || ops.length > LIST_OPS_MAX) throw userError_('記録の変更の形式が不正です。')
  var keyOf = function (e) { return e && typeof e === 'object' ? String(e[cfg.key] === undefined || e[cfg.key] === null ? '' : e[cfg.key]) : '' }
  var norm = normalize || function (e) { return e }
  var list = current.slice()
  var indexOf = function (key) {
    for (var i = 0; i < list.length; i++) if (keyOf(list[i]) === key) return i
    return -1
  }
  var same = function (a, b) { return canonicalJson_(norm(a)) === canonicalJson_(norm(b)) }
  var conflict = function () { if (strict) throw conflictError_(sheetName, rowId) }
  var added = []
  ops.forEach(function (op) {
    if (!op || typeof op !== 'object') throw userError_('記録の変更の形式が不正です。')
    if (op.op === 'add') {
      var key = keyOf(op.entry)
      if (!key) throw userError_('記録の変更の形式が不正です。')
      var at = indexOf(key)
      if (at >= 0) {
        if (!same(list[at], op.entry)) conflict()
        return
      }
      if (cfg.addAt === 'start') added.push(op.entry)
      else list.push(op.entry)
      return
    }
    if (cfg.addOnly) throw userError_('この記録は、足すことだけができます。')
    var k = String(op.key === undefined || op.key === null ? '' : op.key)
    if (!k) throw userError_('記録の変更の形式が不正です。')
    var i = indexOf(k)
    if (op.op === 'update') {
      if (!op.entry || keyOf(op.entry) !== k) throw userError_('記録の変更の形式が不正です。')
      if (i < 0) { conflict(); return }
      if (!same(list[i], op.before)) { conflict(); if (!strict) return }
      list[i] = op.entry
      return
    }
    if (op.op === 'remove') {
      if (i < 0) return
      if (!same(list[i], op.before)) { conflict(); if (!strict) return }
      list.splice(i, 1)
      return
    }
    throw userError_('記録の変更の形式が不正です。')
  })
  if (added.length) list = added.concat(list)
  if (cfg.cap && list.length > cfg.cap) list = list.slice(0, cfg.cap)
  return list
}

// 差分(listOps)を、今の一覧に当てた一覧(body の一覧の項目: comments・entries など)にする。
// locked: ロックを取った後(今のシートの値に当て、競合を確かめる)。そうでなければ権限の判定に使うスナップショットに当てる
function expandListOps_(body, locked) {
  var cfg = body && LIST_ACTIONS[body.action]
  if (!cfg || body.listOps === undefined) return
  var rowId = String(body[cfg.idParam] || '')
  var row = locked ? lockedRow_(cfg.sheet, rowId) : authFindRow_(cfg.sheet, rowId)
  if (!row) throw userError_('対象が見つかりません。')
  var normalize = cfg.column === 'history_json' ? normalizeHistoryEntry_ : null
  body[cfg.param] = applyListOps_(cfg, parseListCell_(row[cfg.column]), body.listOps, locked, cfg.sheet, rowId, normalize)
}

// ロックを取った後の、今のシートの行(この実行で書いた値を含む)
// (シートを1回で読んで覚え、続く書き込み(updateRowFields_)でも使い回す)
function lockedRow_(sheetName, rowId) {
  var found = measureAction_('sheetReadMs', function () { return sheetGridRow_(sheetName, rowId) })
  if (found.row === -1 || !found.grid.values[found.row - 1]) return null
  var obj = {}
  found.grid.headers.forEach(function (h, c) { obj[h] = found.grid.values[found.row - 1][c] })
  return obj
}

// ---- 1つのセルの長さ ----
//
// スプレッドシートの1つのセルには 5万文字までしか入らない。コメント・1on1 の記録・経歴・評価・アンケートの回答などは、
// 記録を JSON にして1つのセルに入れているため、使い続けると増え続ける。
//   - 上限を超える値は、何も書かずに断る(cellTooLong。画面は書いた文章を、機能停止の時と同じ知らせでコピーできる形で残す)
//   - 8割(4万文字)を超えた値は、書いた後に、書いた人(応答の longRecords)と代表(初めて超えた時に、まとめのメール)に知らせる
//   - どの記録がいくつ上限に近いかは、代表の管理画面で見られる(getLongRecords)
var CELL_MAX_CHARS = 50000
var CELL_WARN_CHARS = 40000
// このリクエストで書いた、8割を超えた記録 [{ sheet, id, name, field, length, crossed }]
var _longCells = []

function cellTooLongError_(sheetName, field, value, before) {
  var length = value.length
  var e = userError_('この記録は長くなりすぎたため、保存できませんでした(' + length + '文字。1つの記録は' + CELL_MAX_CHARS +
    '文字まで)。書いた文章は消えていないので、コピーして残してください。古い記録の整理は代表に相談してください。')
  e.cellTooLong = { sheet: String(sheetName), field: String(field), length: length, max: CELL_MAX_CHARS, texts: newCellTexts_(value, before) }
  return e
}

// 断った値のうち、前の値に無かった文章(書いた人が今回書いたもの)。画面はこれをコピーできるように出す
// (記録の一覧を丸ごと送る保存なので、前からの記録は除く)。前の値が分からない時は null(画面が送った内容から取り出す)
function newCellTexts_(value, before) {
  if (before === undefined || before === null) return null
  var leaves = function (v, out) {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(function (x) { leaves(x, out) })
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { leaves(v[k], out) })
    return out
  }
  var parse = function (text) { try { return JSON.parse(text) } catch (e) { return text } }
  var old = {}
  leaves(parse(String(before)), []).forEach(function (t) { old[t] = true })
  var seen = {}
  return leaves(parse(value), []).filter(function (t) {
    if (old[t] || seen[t] || !String(t).trim()) return false
    seen[t] = true
    return true
  }).slice(0, 20)
}

function assertCellLength_(sheetName, field, value, before) {
  if (typeof value === 'string' && value.length > CELL_MAX_CHARS) throw cellTooLongError_(sheetName, field, value, before)
}

function assertRowCellLengths_(sheetName, headers, row) {
  row.forEach(function (v, i) { assertCellLength_(sheetName, headers[i], v, '') })
}

// 記録の名前(タスクの題名・メンバーの名前・設定のキー)。知らせと一覧に出す
function recordName_(headers, rowValues) {
  var keys = ['title', 'name', 'key']
  for (var i = 0; i < keys.length; i++) {
    var col = headers.indexOf(keys[i])
    if (col >= 0 && rowValues[col] !== undefined && rowValues[col] !== '') return String(rowValues[col]).slice(0, 100)
  }
  return ''
}

// 8割を超えた値を書く時に覚える(crossed: 書く前は8割以下だった = 初めて超えた)
function noteLongCell_(sheetName, id, name, field, value, before) {
  if (typeof value !== 'string' || value.length <= CELL_WARN_CHARS) return
  _longCells.push({
    sheet: String(sheetName), id: String(id), name: name || '', field: String(field), length: value.length,
    crossed: String(before === undefined || before === null ? '' : before).length <= CELL_WARN_CHARS,
  })
}

// 初めて8割を超えた記録を、代表にまとめのメールで知らせる(書き込みの確定の後に、doPost から呼ぶ)
function notifyTopsOfLongRecords_(cells) {
  var crossed = cells.filter(function (c) { return c.crossed })
  if (!crossed.length) return
  try {
    var to = Object.keys(topEmailSet_())
    if (!to.length) return
    var lines = crossed.map(function (c) {
      return '・' + (c.name || c.id) + ' の ' + cellFieldLabel_(c.field) + '(' + c.length + '文字 / 上限 ' + CELL_MAX_CHARS + '文字)'
    })
    deliverNotification_(to, { ja: {
      subject: 'この記録は長くなっています',
      body: '次の記録が、1つの記録に入る長さの上限(' + CELL_MAX_CHARS + '文字)の8割を超えました。\n' + lines.join('\n') +
        '\n\n上限を超えると、それ以上は保存できなくなります。団体の設定の画面の「長くなっている記録」で一覧を確かめ、古い記録の整理を検討してください。',
    } }, false)
  } catch (e) {
    console.warn('長くなっている記録の知らせを送れませんでした: ' + ((e && e.message) || e))
  }
}

var CELL_FIELD_LABELS = {
  comments_json: 'コメント', history_json: '変更の記録', progress_history_json: '進み具合の記録',
  one_on_ones_json: '1on1 の記録', career_history_json: '経歴', evaluation_history_json: '評価',
  survey_responses_json: 'アンケートの回答', training_history_json: '研修の記録', development_plan_json: '育成の計画',
  transfer_history_json: '異動の記録', qualifications_json: '資格', description: '説明', value: '設定の値',
}

function cellFieldLabel_(field) {
  return CELL_FIELD_LABELS[field] || field
}

// 8割を超えているセルを、表(Members・Projects・Tasks・Settings)から探す。記録の種類(シートと列)ごとにまとめ、長い順に並べる
function longRecordsNow_() {
  var data = {}
  SNAPSHOT_SHEETS.forEach(function (name) { data[name] = snapshotTableOrSheet_(name) })
  return longRecords_(data)
}

function longRecords_(data) {
  var groups = {}
  var maxLength = 0
  SNAPSHOT_SHEETS.forEach(function (name) {
    var table = data[name]
    if (!table || !table.headers) return
    var idCol = table.headers.indexOf(name === SHEET_SETTINGS ? 'key' : 'id')
    ;(table.rows || []).forEach(function (row) {
      row.forEach(function (v, col) {
        var length = typeof v === 'string' ? v.length : String(v === null || v === undefined ? '' : v).length
        if (length > maxLength) maxLength = length
        if (length <= CELL_WARN_CHARS) return
        var field = table.headers[col]
        var key = name + ':' + field
        if (!groups[key]) groups[key] = { sheet: name, field: field, label: cellFieldLabel_(field), items: [] }
        groups[key].items.push({ id: idCol >= 0 ? String(row[idCol]) : '', name: recordName_(table.headers, row), length: length })
      })
    })
  })
  var list = Object.keys(groups).map(function (k) {
    var g = groups[k]
    g.items.sort(function (a, b) { return b.length - a.length })
    g.count = g.items.length
    return g
  })
  list.sort(function (a, b) { return b.items[0].length - a.items[0].length })
  return { warnAt: CELL_WARN_CHARS, max: CELL_MAX_CHARS, maxLength: maxLength, groups: list }
}

// 列の番号の並び(書く値つき)を、隣り合う列ごとのまとまりにする(Google のサービスを使わない)
function contiguousColumnRuns_(cols) {
  var sorted = cols.slice().sort(function (a, b) { return a.col - b.col })
  var runs = []
  sorted.forEach(function (c) {
    var last = runs.length ? runs[runs.length - 1] : null
    if (last && last[last.length - 1].col === c.col) {
      last[last.length - 1] = c // 同じ列を2回書く時は後の値
    } else if (last && last[last.length - 1].col + 1 === c.col) {
      last.push(c)
    } else {
      runs.push([c])
    }
  })
  return runs
}

// 通知などで、書いた後の行を読む(判定には使わない)。この実行でそのシートを読んだ・書いた時は、
// 覚えている行(書いた値を含む)を返す。そうでなければ、権限の判定に使ったスナップショットの行
// (同じ版。値は表示の文字列)、それも無ければシートから読む(findRow_)
function requestRow_(sheetName, rowId) {
  var grid = _sheetGrids[sheetName]
  if (grid && grid.idCol >= 0) {
    var r = grid.rowOf[String(rowId)]
    if (r) {
      var obj = {}
      grid.headers.forEach(function (h, c) { obj[h] = grid.values[r - 1][c] })
      return obj
    }
  }
  if (_authSnapshotVersion !== null && _requestSnapshot && _requestSnapshot.version === _authSnapshotVersion && !grid) {
    return authFindRow_(sheetName, rowId)
  }
  return findRow_(sheetName, rowId)
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
}

// ---- 書き込みの送り直し(requestId) --------------------------------------------
//
// フロントは、JSON の応答を受け取れなかった時(結果の転送先 script.googleusercontent.com の
// echo が 404 になった時など)に、少し待ってから同じリクエストを送り直す。GAS の処理は
// 済んでいることがあるため、書き込みにはリクエストごとの ID(requestId)を付けてもらい、
// 同じメンバー・同じ ID の結果を10分覚えておく。送り直された時は処理をやり直さず、
// 前回の結果(replayed: true)を返す。処理中に届いた時は retryLater を返し、もう少し待ってもらう。
var REQUEST_REPLAY_TTL_SEC = 600
var REQUEST_IN_FLIGHT_TTL_SEC = 120
// CacheService の1件の上限(100KB)より小さくする
var REQUEST_REPLAY_MAX_CHARS = 90000

// ログイン(exchangeIdToken)の送り直しの記録の鍵。requestId・IDトークン・画面だけが知る乱数(nonceSecret)をまとめたハッシュにする。
// 同じ3つを送れるのは、ログインを始めたその画面だけなので、IDトークンだけを手に入れた人は、前回の結果(セッション)を受け取れない。
// IDトークンの1回限り(verifyGoogleIdToken_ の nonce の記録)は、そのまま守る(記録を返す時は、確かめ直さない)
function loginReplayKey_(body) {
  var id = body && body.requestId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  if (!body.idToken || !body.nonceSecret) return null
  return 'rqlogin:' + sha256Base64Url_(id + '|' + body.idToken + '|' + body.nonceSecret)
}

// ログインの結果を覚える。初期データは大きく覚えられないので、メンバーID・セッションなどだけを覚え、
// 送り直しの時は画面が初期データを読み直す(reloadInitialData)。失敗も覚える(やり直さない)
function rememberLogin_(key, out) {
  var stored
  if (out.ok) {
    var r = out.result || {}
    stored = r.memberId
      ? { ok: true, replayed: true, result: { memberId: r.memberId, email: r.email, session: r.session, lastLoginRecorded: r.lastLoginRecorded, reloadInitialData: true } }
      : { ok: true, replayed: true, result: { memberId: null, email: r.email } }
  } else {
    stored = { ok: false, replayed: true, error: out.error, authError: true }
  }
  try { CacheService.getScriptCache().put(key, JSON.stringify(stored), REQUEST_REPLAY_TTL_SEC) } catch (e) { /* 覚えられなくても応答は返す */ }
}

function requestReplayKey_(memberId, body) {
  var id = body && body.requestId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
  return 'rq:' + memberId + ':' + id
}

function readRequestReplay_(key) {
  try {
    var raw = CacheService.getScriptCache().get(key)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

function markRequestInFlight_(key) {
  try { CacheService.getScriptCache().put(key, JSON.stringify({ inFlight: true }), REQUEST_IN_FLIGHT_TTL_SEC) } catch (e) { /* 覚えられなくても処理は続ける */ }
}

// 送り直された時に返す応答(新しいセッショントークンは入れない。次のリクエストで改めて受け取る)
function requestReplayValue_(obj) {
  var stored = { ok: obj.ok, replayed: true }
  if (obj.ok) stored.result = obj.result
  else stored.error = obj.error
  if (obj.cellTooLong) stored.cellTooLong = obj.cellTooLong
  if (obj.conflict) stored.conflict = obj.conflict
  var text = JSON.stringify(stored)
  if (text.length <= REQUEST_REPLAY_MAX_CHARS) return text
  // 結果が大きすぎて覚えられない: 処理は済んでいることだけを伝える(やり直さない)
  // (1つのセルの上限で断った時は、文章を除いて覚える。画面は送った内容から文章を取り出す)
  var small = {
    ok: false,
    replayed: true,
    error: obj.ok
      ? 'この操作は完了しています。「情報更新」で最新の状態を読み込んでください。'
      : obj.error,
  }
  if (!obj.ok && obj.cellTooLong) {
    small.cellTooLong = { sheet: obj.cellTooLong.sheet, field: obj.cellTooLong.field, length: obj.cellTooLong.length, max: obj.cellTooLong.max, texts: null }
  }
  return JSON.stringify(small)
}

// ---- 処理時間の内訳 ----------------------------------------------------------
//
// doPost の応答に、GAS の中での処理時間の内訳(timing)を付ける。画面はこれをコンソールに出し、
// 往復にかかった時間のうち、どこまでが GAS の処理かを分けて見られるようにする。
//   totalMs   doPost の開始から応答を作るまで
//   authMs    セッションの確認・メンバーの特定・権限の確認
//   lockMs    ロックの待ち(書き込みだけ。読み取りはロックを取らない)
//   cache     初期データ: unchanged(版が同じ)/ hit(キャッシュ)/ miss(シートから読んだ)
//   readMs    シートの読み込み(キャッシュが無い時)
//   read      読み込みの方式: api(Sheets API の batchGet)/ spreadsheetApp(予備の方式)
//   readError Sheets API で読めなかった理由(予備の方式に切り替えた時)
//   filterMs  閲覧者ごとの絞り込み
//   verifyMs  IDトークンの確認(exchangeIdToken)
var _requestTiming = null

// 計っている区間の深さ。区間の中で記録した時間(例: 認証の中のキャッシュの読み込み)は
// 外側の区間に含まれるので、otherMs の計算では数えない
var _timingDepth = 0
var _timingNested = {}

function startRequestTiming_() {
  _requestTiming = { start: Date.now() }
  _requestActorId = null
  _notifyLimited = false
  _longCells = []
  _requestSnapshot = null
  _requestRows = {}
  _timingDepth = 0
  _timingNested = {}
  _actionTiming = null
  _authSnapshotVersion = null
  _prefetchedSheets = {}
  _requestEmailMap = null
  _sheetGrids = {}
}

function noteTiming_(key, value) {
  if (!_requestTiming) return
  _requestTiming[key] = value
  if (_timingDepth > 0) _timingNested[key] = true
}

// 区間を手で計る時(開始と終わりが別の場所にある時)に使う
function beginTiming_() {
  _timingDepth++
  return Date.now()
}

// 同じ項目の時間を足していく(ファイルごとの処理など、何回も計る時)。区間の中なら外側と重ねて数えない
function addTiming_(key, ms) {
  if (!_requestTiming) return
  _requestTiming[key] = (_requestTiming[key] || 0) + ms
  if (_timingDepth > 0) _timingNested[key] = true
}

function endTiming_(key, started) {
  _timingDepth = Math.max(0, _timingDepth - 1)
  noteTiming_(key, Date.now() - started)
}

// 処理にかかった時間を記録しながら fn を実行する
function timed_(key, fn) {
  var t = beginTiming_()
  try {
    return fn()
  } finally {
    endTiming_(key, t)
  }
}

// ---- 書き込みの処理(runWriteAction_)の内訳 ----
// 処理の間だけ、シートの読み込み・書き込み・通知などの時間を種類ごとに足していく。入れ子になった時
// (通知の中でシートを読むなど)は、内側の時間を外側から引く(同じ時間を2回数えない)。
//   actionMs       処理の全体
//   sheetReadMs    行を探す読み込み(findRow_)
//   sheetWriteMs   行への書き込み(updateRowFields_。書く行を探す読み込みを含む。確定は flushMs)
//   notifyMs       管理者への通知の準備(宛先を調べる時間を除く)
//   recipientsMs   通知の宛先・言語を調べる(メンバー・メールアドレス・団体の通知先。スナップショットとキャッシュから)
//   mailMs         メールの送信(mailCount 件)
//   chatMs         Discord・Slack への送信
//   calendarMs     Google カレンダーの予定の更新
//   actionOtherMs  処理のうち、上のどれにも入らない時間
var _actionTiming = null

function beginActionTiming_() {
  _actionTiming = { stack: [], sums: {}, counts: {} }
  return beginTiming_()
}

function endActionTiming_(started) {
  var at = _actionTiming || { sums: {}, counts: {} }
  _actionTiming = null
  endTiming_('actionMs', started)
  if (!_requestTiming) return
  var inner = 0
  Object.keys(at.sums).forEach(function (k) {
    _requestTiming[k] = at.sums[k]
    _timingNested[k] = true
    inner += at.sums[k]
  })
  Object.keys(at.counts).forEach(function (k) { _requestTiming[k] = at.counts[k] })
  _requestTiming.actionOtherMs = Math.max(0, (_requestTiming.actionMs || 0) - inner)
  _timingNested.actionOtherMs = true
}

function measureAction_(key, fn) {
  var at = _actionTiming
  if (!at) return fn()
  var start = Date.now()
  at.stack.push(0)
  try {
    return fn()
  } finally {
    var elapsed = Date.now() - start
    var children = at.stack.pop()
    at.sums[key] = (at.sums[key] || 0) + Math.max(0, elapsed - children)
    if (at.stack.length) at.stack[at.stack.length - 1] += elapsed
  }
}

function countAction_(key) {
  if (_actionTiming) _actionTiming.counts[key] = (_actionTiming.counts[key] || 0) + 1
}

function jsonOutput_(obj) {
  if (_requestTiming) {
    var timing = { totalMs: Date.now() - _requestTiming.start }
    var known = 0
    Object.keys(_requestTiming).forEach(function (k) {
      if (k === 'start') return
      timing[k] = _requestTiming[k]
      if (/Ms$/.test(k) && typeof _requestTiming[k] === 'number' && !_timingNested[k]) known += _requestTiming[k]
    })
    // 内訳に無い時間(本文の解析・ここで計っていない処理)。区間の中の内訳は外側と重ねて数えない
    timing.otherMs = Math.max(0, timing.totalMs - known)
    obj.timing = timing
  }
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  )
}

// Reads a single value from the optional Settings sheet (see gas/README.md
// §4.6) by key. Returns '' when the sheet or the key doesn't exist yet
// (nothing configured) — every caller below treats that as "feature off".
// 画面が初期データの後に裏で読み込むもの(経費・フォームの回答・採用の候補者・自分のメールアドレス)を
// 1回で返す。往復の回数を減らし、結果の受け渡しで失敗する機会を減らすため。
// それぞれ、個別の操作(getExpenses など)と同じ権限の確認・絞り込みを通す。1つが失敗しても
// ほかは返す(失敗したものは errors に理由を入れる)
// 権限が無い部分は、失敗ではなく空(empty)を返す(一般のメンバーに候補者が無いのは正常)
var BACKGROUND_DATA_PARTS = [
  { key: 'expenses', action: 'getExpenses', empty: function () { return [] }, load: function (acting) { return getExpenses_(acting) } },
  { key: 'formSubmissions', action: 'getFormSubmissions', empty: function () { return [] }, load: function (acting) { return getFormSubmissions_(acting) } },
  { key: 'candidates', action: 'getCandidates', empty: function () { return [] }, load: function (acting) { return getCandidates_(acting) } },
  { key: 'myEmail', action: 'getMyEmails', empty: function () { return '' }, load: function (acting) { return getMemberEmailValueCached_(acting.id) } },
]

// withBackground: getInitialData・exchangeIdToken の応答に、裏での読み込み(getBackgroundData と同じもの)も
// 入れる。画面の通信を1回減らす(ログイン・再読み込みとも1回で全部そろう)。
// 失敗しても初期データは返す(background の代わりに backgroundError。画面は getBackgroundData を送り直す)
function attachBackgroundData_(data, memberId, body) {
  if (!body || !body.withBackground || !data || !data.memberId) return data
  var t = beginTiming_()
  try {
    var acting = getActingMember_(memberId, 'getBackgroundData')
    authorizeAction_(acting, 'getBackgroundData', body)
    data.background = getBackgroundData_(acting, body)
  } catch (err) {
    data.backgroundError = toErrorMessage_(err)
  }
  endTiming_('backgroundMs', t)
  return data
}

function getBackgroundData_(acting, body) {
  var out = { errors: {} }
  // ログインの直後に表示する画像(団体ロゴ・プロフィール画像)のうち、キャッシュにあるもの。
  // Drive は開かない(キャッシュに無いものは、画面が getFiles で別に取る)。
  // 画面が withFiles: false を送った時は入れない(応答の大きさと往復の時間を比べるため)
  if (!body || body.withFiles !== false) {
    var ft = beginTiming_()
    try {
      var fileIds = initialImageFileIds_(loadSnapshot_().data, acting.id)
      out.files = fileIds.length ? getFiles_(acting, fileIds, { cachedOnly: true, maxBytes: INITIAL_FILES_MAX_CHARS }) : []
    } catch (err) {
      out.files = []
    }
    endTiming_('filesMs', ft)
    var chars = 0
    out.files.forEach(function (f) { chars += f.data ? f.data.length : 0 })
    noteTiming_('filesKB', Math.round(chars / 1024))
    noteTiming_('filesCount', out.files.length)
  }
  // キャッシュに無い表(経費・フォームの回答・候補者・メール)を、まとめて1回で読んでおく
  prefetchBackgroundSheets_(acting, body)
  BACKGROUND_DATA_PARTS.forEach(function (part) {
    // 区間として計る(中のシートの読み込みの時間は、この中に含まれる)
    var t = beginTiming_()
    var allowed = true
    try {
      authorizeAction_(acting, part.action, body)
    } catch (denied) {
      allowed = false
    }
    try {
      out[part.key] = allowed ? part.load(acting) : part.empty()
    } catch (err) {
      out.errors[part.key] = toErrorMessage_(err)
    }
    endTiming_(part.key + 'Ms', t)
  })
  return out
}

function getSettingValue_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_SETTINGS)
  if (!sheet) return ''
  var headers = headerRow_(sheet)
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  if (keyCol === -1 || valueCol === -1) return ''
  var lastRow = sheet.getLastRow()
  if (lastRow < 2) return ''
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyCol]) === key) return String(rows[i][valueCol] || '')
  }
  return ''
}

// ---- 定期タスクの自動生成（サーバー側・日次トリガー + クライアント手動チェック）--
//
// item 2/TSK-051の修正: RecurringTaskRule (Admin > Projects の定期タスク) の
// 生成要否判定・実際の生成をこのLockService付き関数に一本化する。以前は
// サーバー側の日次トリガー(dailyMaintenance)と、クライアント側
// (lib/ohsumi/store.tsx、誰かがOhsumiを開いた時に走る)の両方が、それぞれ
// 独立に「今日まだ生成していないか」を判定・生成していた。公開CSVの
// キャッシュ反映には数分のラグがある(gas/README.mdの既知の制約)ため、
// クライアント側がlastGeneratedDateを更新した直後にサーバー側トリガーが
// 古い値を読んでしまい、同じルールから同日中に2件生成される競合が
// 起きていた。加えてクライアント側の期限計算はtoISOString()（UTC基準）
// を使っており、曜日/日付の判定（ブラウザのローカルタイムゾーン基準）
// とズレて期限が1日早くなることがあった。両方の経路をここへ統一し、
// LockServiceで排他制御することでどちらも解消する。
function generateRecurringTasksLocked_() {
  // レジストリから止めている時は作らない(画面には失敗を返さない)
  if (featureDisabled_('recurringTasks')) return { generated: [] }
  var lock = LockService.getScriptLock()
  try {
    lock.waitLock(10000) // 最大10秒待つ。取れなければ諦める(次の呼び出しに任せる)
  } catch (e) {
    console.warn('generateRecurringTasksLocked: ロック取得に失敗、スキップ: ' + e)
    return { generated: [] }
  }
  try {
    var genResult = generateRecurringTasksInternal_()
    // 定期タスクを生成した場合は読み取りキャッシュを無効にする
    if (genResult && genResult.generated && genResult.generated.length > 0) bumpSnapshotVersion_()
    return genResult
  } finally {
    lock.releaseLock()
  }
}

// 実際の生成ロジック(generateRecurringTasksLocked_()がロックを取得した状態で
// のみ呼ぶこと)。getSettingValue_/updateSettingはSettingsシートを直接
// 読み書きするため(getSettingValue_参照)、クライアントが読む公開CSVの
// キャッシュ遅延の影響を受けない。戻り値のgeneratedにcreateTasks()の
// 戻り値({tempId, id}[])をそのまま含めるので、呼び出し元(クライアント)は
// 生成されたタスクのidを個別に組み立てる必要がなく、そのままrefreshAll()
// 等で全体を再取得すればよい。
function generateRecurringTasksInternal_() {
  var raw = getSettingValue_(SETTINGS_KEY_RECURRING_RULES)
  if (!raw) return { generated: [] }
  var rules
  try {
    rules = JSON.parse(raw)
  } catch (err) {
    return { generated: [] } // malformed value — don't let a bad cell break the trigger
  }
  if (!rules || rules.length === 0) return { generated: [] }

  var now = new Date()
  var today = todayStr_()
  var dow = now.getDay()
  var dom = now.getDate()
  var changed = false
  var generated = []

  rules.forEach(function (rule) {
    if (!rule.active || rule.lastGeneratedDate === today) return
    var due = rule.frequency === 'weekly' ? rule.dayOfWeek === dow : rule.dayOfMonth === dom
    if (!due) return

    // isolate each rule — one bad rule (e.g. a stale projectId, a transient
    // Sheets error) must not abort the whole daily trigger and skip both
    // the remaining rules' lastGeneratedDate writes and the overdue-task
    // Discord sweep that runs after this function in dailyMaintenance()
    try {
      var deadline = null
      if (rule.dueInDays != null) {
        var d = new Date(now.getTime() + rule.dueInDays * 86400000)
        deadline = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      }
      // same payload shape/columns the client sends for a recurring-generated
      // task (see store.tsx) — reuses createTasks() so both paths stay in sync
      var created = createTasks_([
        {
          tempId: 'recurring-' + rule.id,
          title: rule.name,
          projectId: rule.projectId,
          department: rule.department,
          category: rule.category,
          skills: rule.skills,
          difficulty: rule.difficulty,
          priority: rule.priority,
          deadline: deadline,
          pendingApproval: false,
        },
      ])
      generated = generated.concat(created)
      rule.lastGeneratedDate = today
      changed = true
    } catch (err) {
      // best-effort — skip this rule today, try again on the next run
    }
  })

  if (changed) updateSetting_(SETTINGS_KEY_RECURRING_RULES, JSON.stringify(rules))
  return { generated: generated }
}

// 一定期間アクセスのないメンバーを管理者に通知する日次スイープ。
// 同日に既に通知済みのメンバーはスキップ（last_inactive_notified 列で管理）。
function notifyInactiveMembers_() {
  var INACTIVE_DAYS = 25
  var thresholdRaw = getSettingValue_('inactive_notify_days')
  var threshold = thresholdRaw ? (parseInt(thresholdRaw, 10) || INACTIVE_DAYS) : INACTIVE_DAYS

  var sheet = getSheet_(SHEET_MEMBERS)
  if (!sheet || sheet.getLastRow() <= 1) return
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var nameCol = headers.indexOf('name')
  var inactiveCol = headers.indexOf('inactive')
  var lastLoginCol = headers.indexOf('last_login')
  var lastNotifiedCol = headers.indexOf('last_inactive_notified')
  if (idCol < 0 || lastLoginCol < 0) return

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var now = new Date().getTime()
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var staleMembers = []

  rows.forEach(function(row, i) {
    var inactive = String(row[inactiveCol] || '').trim().toUpperCase()
    if (inactive === 'TRUE') return
    var lastLogin = String(row[lastLoginCol] || '').trim()
    if (!lastLogin) return
    var lastLoginMs = new Date(lastLogin).getTime()
    if (isNaN(lastLoginMs)) return
    var days = Math.floor((now - lastLoginMs) / 86400000)
    if (days < threshold) return
    // 当日既に通知済みならスキップ
    var lastNotified = lastNotifiedCol >= 0 ? String(row[lastNotifiedCol] || '').trim() : ''
    if (lastNotified === todayStr) return
    staleMembers.push({ rowIdx: i + 2, name: String(row[nameCol] || ''), lastLogin: lastLogin, days: days })
  })

  if (staleMembers.length === 0) return

  // 通知済み日付を記録
  if (lastNotifiedCol >= 0) {
    staleMembers.forEach(function(m) {
      sheet.getRange(m.rowIdx, lastNotifiedCol + 1).setValue(todayStr)
    })
  }

  var linesJa = staleMembers.map(function(m) {
    return '・' + m.name + '（最終ログイン: ' + m.lastLogin.slice(0, 10) + '、' + m.days + '日経過）'
  })
  var linesEn = staleMembers.map(function(m) {
    return '- ' + m.name + ' (last login: ' + m.lastLogin.slice(0, 10) + ', ' + m.days + ' days ago)'
  })
  notifyAdmins_({
    ja: {
      subject: 'Ohsumi: ' + staleMembers.length + '名のメンバーが' + threshold + '日以上未ログインです',
      body: '以下のメンバーが ' + threshold + ' 日以上 Ohsumi にログインしていません:\n\n' + linesJa.join('\n') + '\n\nOhsumi管理画面から状況を確認してください。',
    },
    en: {
      subject: 'Ohsumi: ' + staleMembers.length + ' member(s) inactive for ' + threshold + '+ days',
      body: 'The following members have not logged in to Ohsumi for ' + threshold + '+ days:\n\n' + linesEn.join('\n') + '\n\nPlease check the Ohsumi admin screen for details.',
    },
  })
  notifyChat_('⚠️ ' + staleMembers.length + '名のメンバーが' + threshold + '日以上未ログインです。Ohsumiで確認してください。')
}

// 期限超過タスクを担当者本人に個別メール通知する日次スイープ。
// notifyOverdueTasksToDiscord_() と同じ期限超過タスクを洗い出し、
// assignee_id（カンマ区切り複数可）を分解して担当者ごとに1通まとめる。
// 通知頻度は各担当者の notify_settings['deadline'] で制御。
// メールアドレス未登録の担当者はスキップし処理継続（best-effort）。
function notifyOverdueTasksToAssignees_() {
  try {
    var sheet = getSheet_(SHEET_TASKS)
    var headers = headerRow_(sheet)
    var titleCol = headers.indexOf('title')
    var dueCol = headers.indexOf('due_date')
    var statusCol = headers.indexOf('status')
    var assigneeCol = headers.indexOf('assignee_id')
    if (titleCol === -1 || dueCol === -1 || statusCol === -1 || assigneeCol === -1) return
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    var today = todayStr_()

    // 期限超過タスクを担当者IDごとに集約
    var byAssignee = {}
    rows.forEach(function (r) {
      var due = cellDateStr_(r[dueCol])
      var status = String(r[statusCol] || '')
      if (!due || due >= today || normalizeCode_('status', status) === 'done') return
      var title = String(r[titleCol] || '')
      var assigneeIds = String(r[assigneeCol] || '')
        .split(',')
        .map(function (s) { return s.trim() })
        .filter(Boolean)
      assigneeIds.forEach(function (aid) {
        if (!byAssignee[aid]) byAssignee[aid] = []
        byAssignee[aid].push({ title: title, due: due })
      })
    })

    var assigneeIds = Object.keys(byAssignee)
    if (assigneeIds.length === 0) return

    assigneeIds.forEach(function (aid) {
      try {
        var tasks = byAssignee[aid]
        var linesJa = tasks.map(function (t) {
          return '・' + t.title + '（期限: ' + t.due + '）'
        })
        var linesEn = tasks.map(function (t) {
          return '- ' + t.title + ' (due: ' + t.due + ')'
        })
        queueNotification_(aid, 'deadline', {
          ja: {
            subject: '[Ohsumi] 期限超過タスクのお知らせ（' + tasks.length + '件）',
            body: '担当しているタスクのうち、期限を超過しているものが' + tasks.length + '件あります。\n\n' +
              linesJa.join('\n') +
              '\n\nOhsumiにログインして対応状況を更新してください。',
          },
          en: {
            subject: '[Ohsumi] Overdue task notice (' + tasks.length + ')',
            body: 'You have ' + tasks.length + ' overdue task(s) assigned to you.\n\n' +
              linesEn.join('\n') +
              '\n\nPlease log in to Ohsumi and update their status.',
          },
        })
      } catch (err) {
        // メンバー1人の通知失敗は他のメンバーの処理に影響させない
        console.error('notifyOverdueTasksToAssignees: memberId=' + aid + ' の通知に失敗しました: ' + maskEmailsIn_(String(err)))
      }
    })
  } catch (err) {
    console.error('notifyOverdueTasksToAssigneesの処理に失敗しました: ' + maskEmailsIn_(String(err)))
  }
}

// ---- Discord Webhook 連携 ---------------------------------------------------
//
// Set the webhook URL from Admin > Tags in the app (gas/README.md §4.7) to
// enable. Deliberately stored in Apps Script's private PropertiesService,
// NOT the Settings sheet — that sheet is published as a public CSV like
// Members/Projects/Tasks, and a webhook URL is a bearer-token-like secret
// (anyone holding it can post to the channel), so it must never round-trip
// through anything publicly readable. There is no doPost action or CSV
// that reads this value back out — write-only by design. Every call below
// is best-effort: a missing/invalid webhook or a Discord-side failure
// never breaks the task action that triggered it.

function getDiscordWebhookUrl_() {
  return PropertiesService.getScriptProperties().getProperty(DISCORD_WEBHOOK_PROPERTY_KEY) || ''
}

// Changing this is otherwise invisible (write-only, see the block comment
// above) — email the usual admin recipients so a change is at least
// noticed/auditable, the same way every other admin-only action in this
// file is observable through its effect on the sheet.
function updateDiscordWebhookUrl_(url) {
  // F12: 本物のDiscord Webhook URL以外(内部ネットワークのURL等、SSRFの
  // 踏み台になり得るもの)を保存させない。空文字(削除)は許可する。
  if (url && url.indexOf('https://discord.com/api/webhooks/') !== 0 && url.indexOf('https://discordapp.com/api/webhooks/') !== 0) {
    throw userError_('Discord Webhook URLは https://discord.com/api/webhooks/ または https://discordapp.com/api/webhooks/ で始まるURLのみ登録できます。')
  }
  PropertiesService.getScriptProperties().setProperty(DISCORD_WEBHOOK_PROPERTY_KEY, url || '')
  // URLが変わったら前回のテスト送信の結果は無効になる
  clearWebhookTestResult_('discord')
  notifyAdmins_(
    '[Ohsumi] Discord Webhook URLが変更されました',
    (url ? 'Discord Webhook URLが更新されました。' : 'Discord Webhook URLが削除されました。') +
      '\n\n心当たりがない場合はAdmin → Tagsから確認してください。',
    null,
    // 送り先を書き換えられた時の合図なので、急ぎとしてメールですぐ送る
    { urgent: true, evenIfChat: true },
  )
  return { updated: true }
}

var SLACK_WEBHOOK_PROPERTY_KEY = 'slack_webhook_url'

function getSlackWebhookUrl_() {
  return PropertiesService.getScriptProperties().getProperty(SLACK_WEBHOOK_PROPERTY_KEY) || ''
}

function updateSlackWebhookUrl_(url) {
  // F12: 本物のSlack Webhook URL以外を保存させない。空文字(削除)は許可する。
  if (url && url.indexOf('https://hooks.slack.com/services/') !== 0) {
    throw userError_('Slack Webhook URLは https://hooks.slack.com/services/ で始まるURLのみ登録できます。')
  }
  PropertiesService.getScriptProperties().setProperty(SLACK_WEBHOOK_PROPERTY_KEY, url || '')
  clearWebhookTestResult_('slack')
  notifyAdmins_(
    '[Ohsumi] Slack Webhook URLが変更されました',
    (url ? 'Slack Webhook URLが更新されました。' : 'Slack Webhook URLが削除されました。') +
      '\n\n心当たりがない場合はAdmin → Tagsから確認してください。',
    null,
    // 送り先を書き換えられた時の合図なので、急ぎとしてメールですぐ送る
    { urgent: true, evenIfChat: true },
  )
  return { updated: true }
}

// Task titles are free text any member can set (INPUT screen, or the admin
// edit form) — posted verbatim as Discord message content, `allowed_mentions`
// must suppress mention parsing so a title like "@everyone" can't mass-ping
// the configured channel.
// テスト環境(TEST_ENVIRONMENT=true)では、Discord・Slack には投稿せずログだけにする
// (サンプルのデータの期限切れのタスクなどが、毎日投稿されないようにするため)。
// Webhook の動作を確かめたい時だけ、スクリプトプロパティ TEST_ALLOW_CHAT を true にする
function isChatSuppressed_() {
  if (!isTestEnvironment_()) return false
  return PropertiesService.getScriptProperties().getProperty('TEST_ALLOW_CHAT') !== 'true'
}

function logSuppressedChat_(kind, content) {
  console.log('[テスト環境] ' + kind + ' に投稿しませんでした(TEST_ALLOW_CHAT が true ではない): ' +
    String(content).slice(0, 200))
}

function sendDiscordMessage_(content) {
  try {
    if (featureDisabled_('chatNotify')) return
    var url = getDiscordWebhookUrl_()
    if (!url) return
    if (isChatSuppressed_()) { logSuppressedChat_('Discord', content); return }
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }),
      muteHttpExceptions: true,
    })
  } catch (err) {
    // swallow — Discord delivery is best-effort
  }
}

function sendSlackMessage_(content) {
  try {
    if (featureDisabled_('chatNotify')) return
    var url = getSlackWebhookUrl_()
    if (!url) return
    if (isChatSuppressed_()) { logSuppressedChat_('Slack', content); return }
    // @here / @channel / @everyone をゼロ幅スペースで無効化（意図しないメンション防止）
    var safe = String(content).replace(/@(here|channel|everyone)/g, '​$1')
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: safe }),
      muteHttpExceptions: true,
    })
  } catch (err) {
    // swallow — Slack delivery is best-effort
  }
}

function notifyChat_(content) {
  return measureAction_('chatMs', function () { return notifyChatUnmeasured_(content) })
}

function notifyChatUnmeasured_(content) {
  if (!allowRequestNotification_('Discord/Slack')) return
  content = withSiteLink_(content)
  sendDiscordMessage_(content)
  sendSlackMessage_(content)
}

// ---- Webhook接続テスト ------------------------------------------------------
//
// send*Message()はタスク通知に相乗りするbest-effort実装で、例外もHTTPの
// 失敗レスポンスも握りつぶす(muteHttpExceptions:true + try/catchで無視)ため、
// 「本当につながっているか」の確認には使えない。こちらは実際にテスト
// メッセージを送信し、HTTPレスポンスコードを見て成否を判定・例外化する
// (呼び出し元のAdmin → Tags画面で保存直後に呼ばれ、結果がそのままトースト
// 表示される)。

function testDiscordWebhook_() {
  var url = getDiscordWebhookUrl_()
  if (!url) throw userError_('Discord Webhook URLが保存されていません。先にURLを入力して保存してください。')
  var resp = fetchWebhookForTest_('discord', url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      content: '✅ Ohsumiとの連携テストです。このメッセージが届いていればDiscordへの通知設定は正常です。',
      allowed_mentions: { parse: [] },
    }),
    muteHttpExceptions: true,
  })
  var code = resp.getResponseCode()
  // Discordの正常応答は204 No Content
  if (code < 200 || code >= 300) {
    recordWebhookTestResult_('discord', false, 'HTTP ' + code)
    throw userError_('Discordへの送信に失敗しました(HTTP ' + code + ')。Webhook URLが正しいか確認してください。')
  }
  recordWebhookTestResult_('discord', true, '')
  return { tested: true }
}

function testSlackWebhook_() {
  var url = getSlackWebhookUrl_()
  if (!url) throw userError_('Slack Webhook URLが保存されていません。先にURLを入力して保存してください。')
  var resp = fetchWebhookForTest_('slack', url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      text: '✅ Ohsumiとの連携テストです。このメッセージが届いていればSlackへの通知設定は正常です。',
    }),
    muteHttpExceptions: true,
  })
  var code = resp.getResponseCode()
  // Slack Incoming Webhookの正常応答は200(本文 "ok")
  if (code < 200 || code >= 300) {
    recordWebhookTestResult_('slack', false, 'HTTP ' + code)
    throw userError_('Slackへの送信に失敗しました(HTTP ' + code + ')。Webhook URLが正しいか確認してください。')
  }
  recordWebhookTestResult_('slack', true, '')
  return { tested: true }
}

// タスク名・説明など自由入力テキストの自動翻訳（多言語対応、item: i18n）。
// Google組み込みの LanguageApp.translate() を使うため追加のAPIキー・課金
// 設定は不要。1件ずつ呼ぶとレイテンシが積み上がるため、フロント側
// (lib/ohsumi/translate.ts) が複数テキストをまとめて渡し、ここでバッチ処理
// する。1件の翻訳失敗が他の件に波及しないよう、テキストごとに個別に
// try/catchし、失敗時はその要素だけ原文を返す。
// 無料枠のクォータ超過時もLanguageAppは例外を投げるため、同様に原文
// フォールバックになる。
function translateTexts_(texts, targetLang, actorId) {
  var list = Array.isArray(texts) ? texts : []
  var lang = targetLang || 'en'
  // 翻訳する文の数は、1人1時間に RATE_LIMITS.translate.limit 件まで(団体全体の翻訳の回数を守るため)
  var count = list.filter(function (t) { return String(t || '').trim() }).length
  if (actorId && count > 0 && !takeRateLimit_('translate', actorId, count)) {
    throw userError_('翻訳は1時間に' + rateLimitOf_('translate') + '件までです。しばらくしてから、もう一度お試しください。')
  }
  return list.map(function (text) {
    var s = String(text || '')
    if (!s.trim()) return s
    try {
      return LanguageApp.translate(s, '', lang)
    } catch (err) {
      console.error('translateTexts: ' + String(s).length + '文字の文の翻訳に失敗しました: ' + maskEmailsIn_(String(err)))
      return s
    }
  })
}

// A cell written as a plain 'yyyy-MM-dd' string can come back from
// getValues() as a Date object instead (Sheets auto-converts date-like
// strings in an unformatted column) — normalize either shape to
// 'yyyy-MM-dd' so string comparisons against todayStr_() stay correct.
function cellDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  return String(v || '')
}

// Daily sweep (see dailyMaintenance/setupDailyTrigger above) — posts one
// message listing every task whose due_date has passed and isn't 完了.
function notifyOverdueTasksToDiscord_() {
  try {
    var sheet = getSheet_(SHEET_TASKS)
    var headers = headerRow_(sheet)
    var titleCol = headers.indexOf('title')
    var dueCol = headers.indexOf('due_date')
    var statusCol = headers.indexOf('status')
    if (titleCol === -1 || dueCol === -1 || statusCol === -1) return
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    var today = todayStr_()
    var overdue = rows
      .map(function (r) {
        return { title: r[titleCol], due: cellDateStr_(r[dueCol]), status: String(r[statusCol] || '') }
      })
      .filter(function (t) {
        return t.due && t.due < today && normalizeCode_('status', t.status) !== 'done'
      })
    if (overdue.length === 0) return
    var lines = overdue.map(function (t) {
      return '・' + t.title + '（期限: ' + t.due + '）'
    })
    notifyChat_('⚠️ 期限超過タスクが' + overdue.length + '件あります。\n' + lines.join('\n'))
  } catch (err) {
    // best-effort
  }
}

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

function saveExpenseApplication_(application, acting) {
  // F5: javascript:等の危険なURLを保存させない
  if (application.receiptUrl && !isSafeHttpUrl_(application.receiptUrl)) {
    throw userError_('領収書URLは http または https で始まるURLのみ登録できます。')
  }
  var sheet = ensureExpensesSheet_()
  appendRowByHeaders_(sheet, SHEET_EXPENSES, {
    id: application.id,
    applicant_id: application.applicantId,
    amount: application.amount,
    category_id: application.categoryId,
    receipt_url: application.receiptUrl || '',
    justification: application.justification || '',
    purpose: application.purpose || '',
    custom_field_answers_json: JSON.stringify(application.customFieldAnswers || {}),
    approval_steps_json: JSON.stringify(application.approvalSteps || []),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    created_at: application.createdAt || new Date().toISOString(),
    rejection_reason: '',
  })
  // 1次承認者への通知
  var steps = application.approvalSteps || []
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
  var approvalSteps = fields.approvalSteps || JSON.parse(String(found.data[headers.indexOf('approval_steps_json')] || '[]'))
  var amount = fields.amount != null ? fields.amount : found.data[headers.indexOf('amount')]

  var updates = {
    amount: amount,
    category_id: fields.categoryId || found.data[headers.indexOf('category_id')],
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
function saveCustomFormSubmission_(submission, acting) {
  var sheet = ensureFormSubmissionsSheet_()
  appendRowByHeaders_(sheet, SHEET_FORM_SUBMISSIONS, {
    id: submission.id,
    form_id: submission.formId,
    submitter_id: submission.submitterId,
    answers_json: JSON.stringify(submission.answers || {}),
    approvals_json: '[]',
    current_step_index: 0,
    status: 'pending',
    created_at: submission.createdAt || new Date().toISOString(),
    rejection_reason: '',
  })

  var customFormDefs = []
  try {
    var raw = getSettingValue_('custom_form_defs')
    if (raw) customFormDefs = JSON.parse(raw)
  } catch (e) {}
  var formDef = customFormDefs.filter(function (f) { return f.id === submission.formId })[0]
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
        notifyChat_('📋 申請フォームが却下されました。' + (reason ? '（理由: ' + reason + '）' : ''))
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
function saveDailyReport_(report, acting) {
  var sheet = ensureDailyReportsSheet_()
  appendRowByHeaders_(sheet, SHEET_DAILY_REPORTS, {
    id: report.id,
    member_id: report.memberId,
    type: report.type,
    report_date: report.date,
    done_text: report.done || '',
    todo_text: report.todo || '',
    issues_text: report.issues || '',
    created_at: report.createdAt || new Date().toISOString(),
  })
  return { id: report.id }
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

// ---- 読み取り(公開CSVの代替) ------------------------------------------------
//
// Members / Projects / Tasks / Settings の読み取りは、以前は「ウェブに公開」した
// CSVから直接行っていた(URLを知っていればログインなしで全データを読めた)。
// 現在は getInitialData アクションでまとめて返す。流れ:
//   1. トークンを検証してログイン中のメンバーを特定する
//   2. 4シート分の「スナップショット」をキャッシュから取り出す(なければ読む)
//   3. READ_POLICY に従い、閲覧者が見てよい行・列・キーだけに絞って返す
//
// キャッシュは「データの版(DATA_VERSION)」ごとに持つ。書き込みのたびに版を
// 新しくするので、古い版のキャッシュは参照されなくなり期限切れで消える。
// 版を新しくする箇所: doPost の書き込みアクション(finally)、dailyMaintenance、
// generateRecurringTasksLocked_、スプレッドシートの手動編集(onSpreadsheetChange)。

var DATA_VERSION_PROPERTY_KEY = 'DATA_VERSION'
var SNAPSHOT_SHEETS = ['Members', 'Projects', 'Tasks', 'Settings']
// CacheService は1キー100KBまで。base64文字列を90,000文字ずつに分割する
var SNAPSHOT_CHUNK_SIZE = 90000
// 分割数の上限(約5.4MB)。これを超える場合はキャッシュせず毎回シートから読む
var SNAPSHOT_MAX_CHUNKS = 60
// CacheService の有効期限の上限(6時間)
var SNAPSHOT_CACHE_TTL = 21600

function getDataVersion_() {
  return PropertiesService.getScriptProperties().getProperty(DATA_VERSION_PROPERTY_KEY) || '0'
}

// 版は表(または読み込みの単位)ごとに分ける。関係の無い書き込みで、ほかの表のキャッシュを捨てないため。
//   snapshot         Members・Projects・Tasks・Settings(DATA_VERSION。初期データと読み取りの認証)
//   expenses         Expenses(TABLE_VERSION_expenses)
//   formSubmissions  FormSubmissions(TABLE_VERSION_formSubmissions)
//   candidates       Candidates(TABLE_VERSION_candidates)
// メールアドレス表(MemberEmails)は、これまでどおり MEMBER_EMAILS_VERSION で別に持つ。
var TABLE_VERSION_PREFIX = 'TABLE_VERSION_'
var VERSIONED_TABLES = ['expenses', 'formSubmissions', 'candidates']

function newVersionValue_() {
  return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6)
}

function getTableVersion_(table) {
  return PropertiesService.getScriptProperties().getProperty(TABLE_VERSION_PREFIX + table) || '0'
}

function bumpTableVersion_(table) {
  try {
    PropertiesService.getScriptProperties().setProperty(TABLE_VERSION_PREFIX + table, newVersionValue_())
  } catch (e) {
    Logger.log('bumpTableVersion failed: ' + e)
  }
}

// スナップショット(Members・Projects・Tasks・Settings)の版だけを新しくする
function bumpSnapshotVersion_() {
  try {
    PropertiesService.getScriptProperties().setProperty(DATA_VERSION_PROPERTY_KEY, newVersionValue_())
  } catch (e) {
    // 版の更新に失敗しても、キャッシュの有効期限(最長5分)で反映される
    Logger.log('bumpSnapshotVersion failed: ' + e)
  }
}

// アプリからの書き込み(ロックを取った操作)の後に、その操作が書くかもしれない表の版だけを新しくする。
// 一覧は scripts/gas-write-tables.mjs で Code.gs を調べた結果を含むこと(lib/ohsumi/gas-table-versions.test.ts で確かめる)。
// 一覧に無い操作はスナップショットの版を新しくする(これまでどおり)
var TABLE_WRITE_ACTIONS = {
  expenses: ['submitExpenseApplication', 'approveExpenseStep', 'rejectExpense', 'withdrawExpense', 'returnExpense', 'resubmitExpense'],
  formSubmissions: ['submitCustomForm', 'approveFormStep', 'rejectFormSubmission'],
  candidates: ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember',
    // バックアップから戻した直後・個人情報の削除で、採用しなかった候補者を消す・延ばす
    'restoreBackup', 'restoreTasks', 'purgePersonalDataNow', 'extendPersonalData', 'cancelWithdrawal'],
}
// Members・Projects・Tasks・Settings に書かない操作(スナップショットの版を変えない)
var SNAPSHOT_UNTOUCHED_ACTIONS = ['addCandidate', 'removeCandidate', 'updateEmail', 'rejectFormSubmission', 'submitDailyReport']

// actions は操作の名前、または名前の配列(まとめて送られた書き込み)。表ごとに1回だけ新しくする
function bumpVersionsAfterWrite_(actions) {
  var list = (Array.isArray(actions) ? actions : [actions]).map(function (a) { return String(a || '') })
  if (list.length === 0) list = ['']
  VERSIONED_TABLES.forEach(function (t) {
    if (list.some(function (a) { return TABLE_WRITE_ACTIONS[t].indexOf(a) >= 0 })) bumpTableVersion_(t)
  })
  if (list.some(function (a) { return SNAPSHOT_UNTOUCHED_ACTIONS.indexOf(a) < 0 })) bumpSnapshotVersion_()
}

// シートの名前 → 版を新しくする処理(スプレッドシートの直接の編集で使う)
var SHEET_VERSION_BUMPS = {
  Members: bumpSnapshotVersion_,
  Projects: bumpSnapshotVersion_,
  Tasks: bumpSnapshotVersion_,
  Settings: bumpSnapshotVersion_,
  Expenses: function () { bumpTableVersion_('expenses') },
  FormSubmissions: function () { bumpTableVersion_('formSubmissions') },
  Candidates: function () { bumpTableVersion_('candidates') },
  MemberEmails: function () { bumpMemberEmailsVersion_() },
}

// ログイン用のメール→メンバーIDの対応表(findMemberIdByEmailCached_)は、
// データの版とは別の版でキャッシュする。タスクの更新などメールに関係のない
// 書き込みのたびに MemberEmails シートを読み直さないようにするため。
// 版を新しくするのは次の場合だけ:
//   - setMemberEmail_(addMember / convertCandidateToMember / updateEmail から呼ばれる)
//   - removeMember(メール行は消さないが、念のため)
//   - setupOhsumi(MemberEmails シートの作成・見出しの追加)
//   - onSpreadsheetChange(スプレッドシートの手動編集)
//   - resetMemberEmailsCache(エディタから手動で実行する)
var MEMBER_EMAILS_VERSION_PROPERTY_KEY = 'MEMBER_EMAILS_VERSION'

function getMemberEmailsVersion_() {
  return PropertiesService.getScriptProperties().getProperty(MEMBER_EMAILS_VERSION_PROPERTY_KEY) || '0'
}

function bumpMemberEmailsVersion_() {
  try {
    PropertiesService.getScriptProperties().setProperty(
      MEMBER_EMAILS_VERSION_PROPERTY_KEY,
      String(Date.now()) + '-' + Math.floor(Math.random() * 1e6),
    )
  } catch (e) {
    // 版の更新に失敗しても、キャッシュの有効期限(6時間)で最終的に反映される
    Logger.log('bumpMemberEmailsVersion failed: ' + e)
  }
}

// シートを {headers, rows} で読む。値は公開CSVと同じく「表示されている文字列」
// (getDisplayValues と同じ見え方)にそろえる。空行は除く。シートが無ければ空で返す。
//
// 読み込みは Sheets API の values.batchGet を UrlFetchApp で1回だけ呼んで行う
// (スクリプトのトークンを使う。Apps Script の「サービス」に Google Sheets API が
// 追加されている必要がある — appsscript.json を参照)。失敗した場合(403・429・
// 5xx・通信エラーなど)は、SpreadsheetApp の getSheets() + getDisplayValues() で
// 読み直す。どちらで読んだかと失敗の理由は実行ログに残す。
function readSheetTables_(names) {
  var start = Date.now()
  var viaApi
  try {
    viaApi = readSheetTablesViaApi_(names)
  } catch (e) {
    viaApi = { error: '通信エラー: ' + ((e && e.message) || e) }
  }
  if (viaApi.tables) {
    console.log('readSheetTables: Sheets API(batchGet)で読み込み ' + (Date.now() - start) + 'ms')
    noteTiming_('read', 'api')
    noteTiming_('readMs', Date.now() - start)
    return viaApi.tables
  }
  var t = Date.now()
  var tables = readSheetTablesViaSpreadsheetApp_(names)
  noteTiming_('read', 'spreadsheetApp')
  noteTiming_('readMs', Date.now() - start)
  noteTiming_('readError', String(viaApi.error).slice(0, 200))
  console.warn(
    'readSheetTables: Sheets API で読み込めなかったため、SpreadsheetApp(getDisplayValues)で読み込み ' +
      (Date.now() - t) + 'ms。理由: ' + viaApi.error,
  )
  return tables
}

var EMPTY_SHEET_TABLE_JSON = '{"headers":[],"rows":[]}'

// 2次元配列(1行目が見出し)を {headers, rows} にする。空行は除く。
function sheetTableFromValues_(values) {
  if (!values || values.length === 0) return JSON.parse(EMPTY_SHEET_TABLE_JSON)
  // getDataRange は空のシートでも A1 の1セルを返す
  if (values.length === 1 && values[0].every(function (v) { return v === '' })) {
    return JSON.parse(EMPTY_SHEET_TABLE_JSON)
  }
  var headers = values[0].map(function (h) { return String(h).trim() })
  var rows = []
  for (var i = 1; i < values.length; i++) {
    var row = values[i]
    var hasValue = false
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '') { hasValue = true; break }
    }
    if (hasValue) rows.push(row)
  }
  return { headers: headers, rows: rows }
}

function sheetsApiRangeName_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'"
}

function sheetsApiBatchGetUrl_(spreadsheetId, names) {
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '/values:batchGet?' +
    names.map(function (name) { return 'ranges=' + encodeURIComponent(sheetsApiRangeName_(name)) }).join('&') +
    '&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS'
}

// API は行末の空セルと、表の末尾の空行を省いて返す。getDisplayValues と同じ
// 長方形(最も長い行の幅)にそろえ、値はすべて文字列にする。
function padSheetsApiValues_(values) {
  var width = 0
  ;(values || []).forEach(function (r) { if (r.length > width) width = r.length })
  return (values || []).map(function (r) {
    var row = r.map(function (v) { return v === null || v === undefined ? '' : String(v) })
    while (row.length < width) row.push('')
    return row
  })
}

// 応答の range("'Tasks'!A1:AT501" など)のシート名部分
function sheetNameOfApiRange_(range) {
  var sheetPart = String(range || '').replace(/![^!]*$/, '')
  if (/^'.*'$/.test(sheetPart)) sheetPart = sheetPart.slice(1, -1).replace(/''/g, "'")
  return sheetPart
}

// 成功したら { tables }、失敗したら { error }(例外は投げない。通信の例外だけは
// 呼び出し側で受ける)
function readSheetTablesViaApi_(names) {
  var id = SpreadsheetApp.getActiveSpreadsheet().getId()
  var response = UrlFetchApp.fetch(sheetsApiBatchGetUrl_(id, names), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  })
  var code = response.getResponseCode()
  var text = response.getContentText()
  if (code !== 200) return { error: describeSheetsApiError_(code, text) }
  var body
  try {
    body = JSON.parse(text)
  } catch (e) {
    return { error: '応答を JSON として読めませんでした' }
  }
  var valueRanges = (body && body.valueRanges) || []
  if (valueRanges.length !== names.length) {
    return { error: '応答の範囲の数が違います(' + valueRanges.length + ' / ' + names.length + ')' }
  }
  var tables = {}
  for (var i = 0; i < names.length; i++) {
    if (sheetNameOfApiRange_(valueRanges[i].range) !== names[i]) {
      return { error: '応答の範囲が違います(' + valueRanges[i].range + ' / ' + names[i] + ')' }
    }
    tables[names[i]] = sheetTableFromValues_(padSheetsApiValues_(valueRanges[i].values))
  }
  return { tables: tables }
}

// 予備の読み方(計測の (b)): getSheets() を1回呼び、getDataRange().getDisplayValues()
function readSheetTablesViaSpreadsheetApp_(names) {
  var byName = {}
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sheet) {
    byName[sheet.getName()] = sheet
  })
  var tables = {}
  names.forEach(function (name) {
    var sheet = byName[name]
    tables[name] = sheet
      ? sheetTableFromValues_(sheet.getDataRange().getDisplayValues())
      : JSON.parse(EMPTY_SHEET_TABLE_JSON)
  })
  return tables
}

function chunkedCacheKey_(prefix, version, suffix) {
  return prefix + ':' + version + ':' + suffix
}

// スナップショットを使う最長の時間(ミリ秒)。スプレッドシートの直接の編集は onSpreadsheetChange で
// すぐ版が変わるが、トリガーが無い・失敗した時でも、この時間を過ぎたらシートから読み直す
var SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000

// 目録は「分割数:作った時刻(ミリ秒)」。作った時刻が無い(前の形式)・古すぎる時は使わない
function snapshotMetaUsable_(meta, now) {
  var parts = String(meta || '').split(':')
  var count = Number(parts[0])
  var savedAt = Number(parts[1])
  if (!(count > 0) || !(savedAt > 0)) return 0
  var age = now - savedAt
  if (age < 0 || age > SNAPSHOT_MAX_AGE_MS) return 0
  return count
}

function readSnapshotCache_(version) {
  return readChunkedCache_('snap', version)
}

// 版ごとのキャッシュ(gzip して base64 にし、90,000文字ずつに分けて CacheService に入れる)を読む。
// 無い・作ってから5分を過ぎた・壊れている時は null
function readChunkedCache_(prefix, version) {
  try {
    var cache = CacheService.getScriptCache()
    var meta = cache.get(chunkedCacheKey_(prefix, version, 'meta'))
    if (!meta) return null
    var count = snapshotMetaUsable_(meta, Date.now())
    if (!count) return null
    var keys = []
    for (var i = 0; i < count; i++) keys.push(chunkedCacheKey_(prefix, version, i))
    var parts = cache.getAll(keys)
    var encoded = ''
    for (var j = 0; j < count; j++) {
      var part = parts[keys[j]]
      if (part == null) return null
      encoded += part
    }
    var gz = Utilities.newBlob(Utilities.base64Decode(encoded), 'application/x-gzip')
    return JSON.parse(Utilities.ungzip(gz).getDataAsString('UTF-8'))
  } catch (e) {
    return null
  }
}

function writeSnapshotCache_(version, data) {
  return writeChunkedCache_('snap', version, data)
}

function writeChunkedCache_(prefix, version, data) {
  try {
    var gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(data), 'application/json'))
    var encoded = Utilities.base64Encode(gz.getBytes())
    var count = Math.ceil(encoded.length / SNAPSHOT_CHUNK_SIZE)
    if (count > SNAPSHOT_MAX_CHUNKS) return false
    var entries = {}
    for (var i = 0; i < count; i++) {
      entries[chunkedCacheKey_(prefix, version, i)] = encoded.substr(i * SNAPSHOT_CHUNK_SIZE, SNAPSHOT_CHUNK_SIZE)
    }
    var cache = CacheService.getScriptCache()
    cache.putAll(entries, SNAPSHOT_CACHE_TTL)
    // 目録は最後に書く(途中で失敗したら目録が無く、次回は読み直しになる)
    cache.put(chunkedCacheKey_(prefix, version, 'meta'), count + ':' + Date.now(), SNAPSHOT_CACHE_TTL)
    return true
  } catch (e) {
    return false
  }
}

// 4シート分のスナップショットを返す。版は必ずシートより先に読む(書き込みと
// 同時に読んでも、古い版のキーに新しいデータが入るだけで逆は起きない)。
// 1つのリクエストの中では、同じ版のスナップショットを使い回す(初期データと裏での読み込みを
// 1回で返す時に、キャッシュを2回読まない)
var _requestSnapshot = null

function loadSnapshot_() {
  var version = getDataVersion_()
  if (_requestSnapshot && _requestSnapshot.version === version) return _requestSnapshot
  var cached = timed_('cacheReadMs', function () { return readSnapshotCache_(version) })
  if (cached) {
    noteTiming_('cache', 'hit')
    _requestSnapshot = { version: version, data: cached, cacheHit: true }
    return _requestSnapshot
  }
  noteTiming_('cache', 'miss')
  var data = readSheetTables_(SNAPSHOT_SHEETS)
  timed_('cacheWriteMs', function () { writeSnapshotCache_(version, data) })
  _requestSnapshot = { version: version, data: data, cacheHit: false }
  return _requestSnapshot
}

// シート1枚分の行(読み取り用に変換したもの。閲覧できるかの絞り込みの前)を、データの版ごとにキャッシュする。
// 経費・フォームの回答・採用の候補者で使う。書き込み・スプレッドシートの直接の編集で版が変わり、
// 作ってから5分を過ぎたものも使わない(スナップショットと同じ)。
// 閲覧できるかの絞り込みは、キャッシュから読んだ後に毎回行う。
// timing に <prefix>Cache: hit / miss を記録する
var _requestRows = {}

function loadVersionedRows_(prefix, loader) {
  var version = getTableVersion_(prefix)
  var memoKey = prefix + ':' + version
  if (_requestRows[memoKey]) return _requestRows[memoKey]
  var rows = readChunkedCache_(prefix, version)
  if (Array.isArray(rows)) {
    noteTiming_(prefix + 'Cache', 'hit')
  } else {
    noteTiming_(prefix + 'Cache', 'miss')
    rows = loader()
    writeChunkedCache_(prefix, version, rows)
  }
  _requestRows[memoKey] = rows
  return rows
}

// スナップショットの Settings から1つの値を読む(無ければシートから)
function settingValueFromSnapshot_(key) {
  try {
    var table = loadSnapshot_().data.Settings
    var keyCol = table.headers.indexOf('key')
    var valueCol = table.headers.indexOf('value')
    if (keyCol >= 0 && valueCol >= 0) {
      for (var i = 0; i < table.rows.length; i++) {
        if (String(table.rows[i][keyCol]) === key) return String(table.rows[i][valueCol] || '')
      }
      return ''
    }
  } catch (e) {
    // 読めなければシートから
  }
  return getSettingValue_(key)
}

// ---- 読み取りの権限表(閲覧範囲の判定はここに集約する) -----------------------
//
// 列ごと・キーごとに規則名を書く。規則のない列・キーは誰にも返さない。
// 将来、団体ごとに人材データの閲覧範囲を設定できるようにする場合は、
// Settings の設定をこの表に重ねる形で拡張する。
//   all             ログイン済みの全員
//   self            本人のみ(Members の行の id が閲覧者)
//   selfOrAdminRole 本人と、一般以外の役職
//   selfOrFullAdmin 本人と全権管理者
//   adminRole       一般以外の役職
//   fullAdmin       全権管理者のみ
//   none            誰にも返さない
var READ_POLICY = {
  Members: {
    rows: 'all',
    columns: {
      id: 'all',
      name: 'all',
      display_name: 'all',
      role: 'all',
      avatar_url: 'all',
      avatar_color: 'all',
      avatar_initials: 'all',
      project_ids: 'all',
      will_tags: 'all',
      judgment_tags: 'all',
      reports_to_id: 'all',
      joined_at: 'all',
      department_path: 'all',
      unavailable_dates: 'all',
      absent_dates: 'all',
      available_hours_json: 'all',
      skill_levels_json: 'all',
      timezone: 'all',
      inactive: 'all',
      withdrawn_at: 'all',
      personal_data_purged_at: 'all',
      purge_at: 'selfOrAdminRole',
      withdrawal_unassigned_task_ids: 'selfOrAdminRole',
      // 書き込みの競合チェック: 版は画面が保存の時に送る。最後に変えた人は画面に渡さない
      row_version: 'all', row_updated_by: 'none',
      mentor_id: 'selfOrAdminRole',
      has_management_experience: 'selfOrAdminRole',
      desired_areas: 'selfOrAdminRole',
      desired_skills: 'selfOrAdminRole',
      career_history_json: 'selfOrAdminRole',
      qualifications_json: 'selfOrAdminRole',
      evaluation_history_json: 'selfOrAdminRole',
      transfer_history_json: 'selfOrAdminRole',
      competencies_json: 'selfOrAdminRole',
      training_history_json: 'selfOrAdminRole',
      development_plan_json: 'selfOrAdminRole',
      one_on_ones_json: 'selfOrAdminRole',
      career_aspiration: 'selfOrAdminRole',
      desired_future_role: 'selfOrAdminRole',
      career_plan: 'selfOrAdminRole',
      university: 'selfOrAdminRole',
      faculty: 'selfOrAdminRole',
      department_name: 'selfOrAdminRole',
      grade_year: 'selfOrAdminRole',
      custom_fields_json: 'selfOrAdminRole',
      skill_points_json: 'selfOrAdminRole',
      survey_responses_json: 'selfOrAdminRole',
      last_login: 'selfOrAdminRole',
      notify_new_task: 'self',
      notify_settings: 'self',
      locale: 'self',
      permission_overrides_json: 'selfOrFullAdmin',
      last_inactive_notified: 'none',
      years_of_experience: 'none',
    },
  },
  Projects: {
    rows: 'all',
    columns: {
      id: 'all', name: 'all', description: 'all', type: 'all', owner_id: 'all',
      member_ids: 'all', archived: 'all', parent_id: 'all', goal: 'all',
      health_override: 'all', last_notified_health: 'all', start_date: 'all', end_date: 'all',
      row_version: 'all', row_updated_by: 'none',
    },
  },
  Tasks: {
    // 行の規則は canViewTaskRow_ を参照。行が見える人には全列を返す
    rows: 'task',
    columns: {
      id: 'all', project_id: 'all', title: 'all', description: 'all', status: 'all',
      assign_type: 'all', assignee_id: 'all', creator_id: 'all', created_at: 'all',
      start_date: 'all', due_date: 'all', due_time: 'all', visibility: 'all',
      department: 'all', category: 'all', skills: 'all', difficulty: 'all', priority: 'all',
      last_activity: 'all', original_input_id: 'all', approval_status: 'all',
      estimated_hours: 'all', importance: 'all', reviewer_id: 'all', reviewer_ids: 'all',
      depends_on_ids: 'all', progress_note: 'all', progress_percent: 'all',
      progress_history_json: 'all', deliverables_json: 'all', history_json: 'all',
      comments_json: 'all', retrospective_json: 'all', schedule_json: 'all', form_json: 'all',
      blocker_note: 'all', blocker_since: 'all', hold_reason_note: 'all', hold_reason_since: 'all',
      completed_date: 'all', actual_hours: 'all', awarded_points_json: 'all',
      required_approvals: 'all', required_skill_levels_json: 'all', review_approvals_json: 'all',
      open_bid_applicant_ids: 'all', related_review_task_id: 'all',
      row_version: 'all', row_updated_by: 'none',
    },
  },
  Settings: {
    // キーごとの規則。関数になっているキーは、閲覧者に合わせて値を加工して返す
    keys: {
      skill_options: 'all',
      category_options: 'all',
      roles: 'all',
      departments: 'all',
      role_levels: 'all',
      project_templates: 'all',
      role_permissions: 'all',
      task_set_templates: 'all',
      recurring_rules: 'all',
      job_requirements: 'all',
      skill_field_options: 'all',
      skill_field_skills: 'all',
      skill_field_threshold: 'all',
      org_notification_emails: 'fullAdmin',
      survey_invited_ids: filterSurveyInvitedIds_,
      project_order: 'all',
      restricted_roles: 'all',
      skill_level_thresholds: 'all',
      quiz_definitions: filterQuizDefinitions_,
      radar_axes: 'all',
      custom_member_columns_json: 'all',
      expense_categories: 'all',
      custom_form_defs: 'all',
      org_name: 'all',
      org_logo_url: 'all',
      theme_color: 'all',
      one_on_one_questions: 'all',
      initial_tasks_json: 'all',
      department_tree_config: 'all',
      learning_contents: 'all',
      learning_courses: 'all',
      training_programs: 'all',
      survey_questions: 'all',
      // 集計値を FSIF に送っているか(on / off。メンバーにも画面の下に出す)
      metrics_sharing_notice: 'all',
    },
  },
}

function splitCsvList_(value) {
  return String(value || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
}

// 閲覧者の情報(判定に使う値だけ)。roles は役職の一覧(rolesFromSettings_)。
// 全権管理者の判定は lib/ohsumi/roles.ts の isFullAdminRoleRef_ と同じ基準
// (最上位は常に全権管理者 — authorizeAction_ と同じ)。
function makeViewer_(memberRow, roles) {
  var role = String(memberRow.role || '').trim()
  return {
    id: String(memberRow.id || ''),
    role: role,
    isAdminRole: isAdminRoleRef_(roles, role),
    isFullAdmin: isFullAdminRoleRef_(roles, role),
  }
}

function checkReadRule_(rule, viewer, ownerId) {
  switch (rule) {
    case 'all': return true
    case 'self': return !!ownerId && ownerId === viewer.id
    case 'selfOrAdminRole': return (!!ownerId && ownerId === viewer.id) || viewer.isAdminRole
    case 'selfOrFullAdmin': return (!!ownerId && ownerId === viewer.id) || viewer.isFullAdmin
    case 'adminRole': return viewer.isAdminRole
    case 'fullAdmin': return viewer.isFullAdmin
    default: return false
  }
}

// タスクの行の規則(画面の visibleTasks / pendingTasks の表示範囲を再現する)
//   幹部限定: 一般以外の役職のみ
//   承認待ち: 一般以外の役職と、作成者・担当者
function canViewTaskRow_(viewer, task) {
  // 値は移行前の日本語・コードのどちらでもよい
  if (normalizeCode_('visibility', task.visibility) === 'leaders' && !viewer.isAdminRole) return false
  if (normalizeCode_('approval', task.approval_status) === 'pending' && !viewer.isAdminRole) {
    if (String(task.creator_id || '') === viewer.id) return true
    return splitCsvList_(task.assignee_id).indexOf(viewer.id) >= 0
  }
  return true
}

// アンケートの回答対象者一覧: 一般以外の役職には一覧をそのまま返す。一般には
// 「自分が対象かどうか」だけが分かる値にする(対象なら自分のID、対象外なら
// どのメンバーIDとも一致しない値)。空(=全員が対象)はそのまま返す。
var SURVEY_NOT_INVITED_MARKER = '__not_invited__'
function filterSurveyInvitedIds_(value, viewer) {
  if (viewer.isAdminRole) return value
  var ids = splitCsvList_(value)
  if (ids.length === 0) return value
  return ids.indexOf(viewer.id) >= 0 ? viewer.id : SURVEY_NOT_INVITED_MARKER
}

// 検定: 正解番号(correctIndex)は検定を編集できる全権管理者だけに返す
// (採点は submitQuizResult でサーバー側が行う)
function filterQuizDefinitions_(value, viewer) {
  if (viewer.isFullAdmin || !value) return value
  try {
    var quizzes = JSON.parse(value)
    if (!Array.isArray(quizzes)) return ''
    quizzes.forEach(function (q) {
      ;(q && Array.isArray(q.questions) ? q.questions : []).forEach(function (question) {
        if (question) delete question.correctIndex
      })
    })
    return JSON.stringify(quizzes)
  } catch (e) {
    return ''
  }
}

function tableRowToObject_(headers, row) {
  var obj = {}
  for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c]
  return obj
}

// 1シート分を閲覧者に合わせて絞り込む(Members / Projects / Tasks)
function filterTableForViewer_(sheetName, table, viewer) {
  var policy = READ_POLICY[sheetName]
  var headers = table.headers || []
  var rows = table.rows || []
  // 規則のある列だけを残す(列の並びは元のまま。none の列も落とす)
  var keepCols = []
  headers.forEach(function (h, c) {
    if (h && policy.columns[h] && policy.columns[h] !== 'none') keepCols.push(c)
  })
  var idCol = headers.indexOf('id')
  var outRows = []
  rows.forEach(function (row) {
    var obj = null
    if (policy.rows === 'task') {
      obj = tableRowToObject_(headers, row)
      if (!canViewTaskRow_(viewer, obj)) return
    }
    // Members の「本人」判定は行の id で行う
    var ownerId = sheetName === 'Members' && idCol >= 0 ? String(row[idCol]) : ''
    outRows.push(keepCols.map(function (c) {
      return checkReadRule_(policy.columns[headers[c]], viewer, ownerId) ? row[c] : ''
    }))
  })
  return { headers: keepCols.map(function (c) { return headers[c] }), rows: outRows }
}

function filterSettingsForViewer_(table, viewer) {
  var headers = table.headers || []
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  var out = { headers: ['key', 'value'], rows: [] }
  if (keyCol < 0 || valueCol < 0) return out
  var keys = READ_POLICY.Settings.keys
  ;(table.rows || []).forEach(function (row) {
    var key = String(row[keyCol] || '')
    var rule = keys[key]
    if (!rule) return
    var value = row[valueCol]
    if (typeof rule === 'function') {
      out.rows.push([key, rule(value, viewer)])
    } else if (checkReadRule_(rule, viewer, '')) {
      out.rows.push([key, value])
    }
  })
  return out
}

// スナップショットの Settings から役職の一覧を作る
function rolesFromSnapshot_(data) {
  var settings = data.Settings || { headers: [], rows: [] }
  var keyCol = settings.headers.indexOf('key')
  var valueCol = settings.headers.indexOf('value')
  var map = {}
  if (keyCol >= 0 && valueCol >= 0) {
    settings.rows.forEach(function (r) {
      var key = String(r[keyCol])
      if (ROLE_SETTING_KEYS.indexOf(key) >= 0) map[key] = String(r[valueCol] || '')
    })
  }
  return rolesFromSettings_(map)
}

function findMemberInSnapshot_(data, memberId) {
  var members = data.Members || { headers: [], rows: [] }
  var idCol = members.headers.indexOf('id')
  if (idCol < 0) return null
  for (var i = 0; i < members.rows.length; i++) {
    if (String(members.rows[i][idCol]) === String(memberId)) return tableRowToObject_(members.headers, members.rows[i])
  }
  return null
}

// スナップショット全体を閲覧者に合わせて絞り込む(getInitialData の本体。
// Google のサービスを使わない純粋な関数なのでテストから直接呼べる)
function buildViewerData_(data, memberId) {
  var memberRow = findMemberInSnapshot_(data, memberId)
  if (!memberRow) return null
  var viewer = makeViewer_(memberRow, rolesFromSnapshot_(data))
  var empty = { headers: [], rows: [] }
  return {
    Members: filterTableForViewer_('Members', data.Members || empty, viewer),
    Projects: filterTableForViewer_('Projects', data.Projects || empty, viewer),
    Tasks: filterTableForViewer_('Tasks', data.Tasks || empty, viewer),
    Settings: filterSettingsForViewer_(data.Settings || empty, viewer),
  }
}

// ログイン用のメール→メンバーIDの対応表(非公開の MemberEmails シート)。
// メールアドレス表専用の版ごとにキャッシュする(getMemberEmailsVersion_ を参照)。
function findMemberIdByEmailCached_(email) {
  var normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null
  var cache = CacheService.getScriptCache()
  // 版は MemberEmails を読む前に取得する(読んでいる間に書き込まれても、
  // 古い内容は古い版のキーに入るだけになる)
  var key = 'memberEmails:' + getMemberEmailsVersion_()
  var map = null
  try {
    var raw = cache.get(key)
    if (raw) map = JSON.parse(raw)
  } catch (e) { map = null }
  if (!map) {
    map = {}
    var sheet = getMemberEmailsSheet_()
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var emailCol = headers.indexOf('email')
    var lastRow = sheet.getLastRow()
    if (lastRow >= 2 && idCol >= 0 && emailCol >= 0) {
      sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().forEach(function (row) {
        String(row[emailCol] || '').split(',').forEach(function (e) {
          var addr = e.trim().toLowerCase()
          if (addr && !map[addr]) map[addr] = String(row[idCol])
        })
      })
    }
    try { cache.put(key, JSON.stringify(map), SNAPSHOT_CACHE_TTL) } catch (e) { /* 大きすぎる場合は毎回読む */ }
  }
  return map[normalized] || null
}

// ログインと初期データの取得を1回で行う。
// knownVersion が現在の版と同じなら中身を返さず unchanged だけ返す。
function getInitialDataForMember_(memberId, knownVersion) {
  var version = timed_('versionMs', function () { return getDataVersion_() })
  if (knownVersion && String(knownVersion) === version) {
    noteTiming_('cache', 'unchanged')
    return { memberId: memberId, version: version, unchanged: true }
  }
  var snapshot = loadSnapshot_()
  var sheets = timed_('filterMs', function () { return buildViewerData_(snapshot.data, memberId) })
  if (!sheets) return { memberId: null }
  return { memberId: memberId, version: snapshot.version, sheets: sheets }
}

// ---- 読み込み方式ごとの計測 ----------------------------------------------------
//
// シートの読み込み方を (a)〜(d) の4通りで計測する。Apps Script エディタでは
// 引数を渡せないため、方式ごとに関数を分けている。1回の実行では1つの方式だけを
// 測る(同じ実行の中で続けて読むと、2回目以降が速く見えるため)。
//   measureReadA: (a) 以前の方式(シートごとにスプレッドシートを開き、
//                 getLastRow / getLastColumn を2回ずつ呼ぶ)
//   measureReadB: (b) getSheets() を1回だけ呼び、getDataRange().getDisplayValues()
//                 (Sheets API で読めなかった場合の予備の読み方)
//   measureReadC: (c) (b) と同じ取得で getValues() を使い、表示用の文字列に自前で変換
//   measureReadD: (d) Sheets API の values.batchGet を UrlFetchApp で1回だけ呼ぶ
//                 (スクリプトのトークンを使う。表示されている文字列 FORMATTED_VALUE)。
//                 現在の読み込み(readSheetTables_)はこの方式
// 各方式とも、同じ方式を3回以上(できれば時間を空けて)実行し、実行ログの
// 「直近3回の中央値」を比べる。showReadMeasurements() で4方式の記録を一覧できる。
//
// 計測用の関数は、シートを読むだけで書き込まない。データの版やキャッシュにも
// 触れない(本来の読み込み処理の速さや内容に影響しない)。失敗しても例外を
// 投げず、実行ログにエラーを出して終わる。記録はスクリプトプロパティ
// READ_MEASURE_HISTORY_a〜d に残る(clearReadMeasurements() で消せる)。

var READ_MEASURE_LABELS = {
  a: '(a) 以前の方式(シートごとに開く + getDisplayValues)',
  b: '(b) getSheets() 1回 + getDataRange().getDisplayValues()',
  c: '(c) getSheets() 1回 + getDataRange().getValues() + 自前の文字列変換',
  d: '(d) Sheets API values.batchGet(UrlFetchApp + スクリプトのトークン)',
}
var READ_MEASURE_HISTORY_PREFIX = 'READ_MEASURE_HISTORY_'
var READ_MEASURE_HISTORY_SIZE = 5

function runReadMeasurement_(variant) {
  var lines = ['📊 読み込み方式の計測 ' + READ_MEASURE_LABELS[variant]]
  var result
  try {
    result = READ_MEASURE_RUNNERS[variant]()
  } catch (e) {
    result = { error: String(e), common: {}, sheets: {}, data: null }
  }
  try {
    lines = lines.concat(formatReadMeasurement_(result))
  } catch (e) {
    lines.push('  結果の整形に失敗しました: ' + e)
  }
  // 結果が getDisplayValues(予備の読み方 (b))と同じ見え方かを確かめる
  // (計測の後に行うため、所要時間には含まれない)
  if (!result.error && result.data) {
    try {
      lines.push('  結果の一致(getDisplayValues と比べて): ' + compareWithDisplayValues_(result.data))
    } catch (e) {
      lines.push('  結果の一致: 確認できませんでした(' + e + ')')
    }
  }
  try {
    lines.push('  ' + recordReadMeasurement_(variant, result))
  } catch (e) {
    lines.push('  記録の保存に失敗しました: ' + e)
  }
  var text = lines.join('\n')
  console.log(text)
  return text
}

function readMeasureNow_() { return Date.now() }

function readMeasureSize_(values) {
  var cells = 0
  for (var i = 0; i < values.length; i++) cells += values[i].length
  return {
    rowCount: values.length,
    colCount: values.length > 0 ? values[0].length : 0,
    cells: cells,
    chars: JSON.stringify(values).length,
  }
}

// シートごとに計測する。1枚で失敗しても残りのシートは測る。
function measureEachSheet_(result, fn) {
  var failed = false
  SNAPSHOT_SHEETS.forEach(function (name) {
    var entry = { phases: [] }
    result.sheets[name] = entry
    function phase(label, f) {
      var t = readMeasureNow_()
      var value = f()
      entry.phases.push([label, readMeasureNow_() - t])
      return value
    }
    try {
      var values = fn(name, phase, entry)
      if (values == null) {
        entry.missing = true
        result.data[name] = { headers: [], rows: [] }
        return
      }
      var size = readMeasureSize_(values)
      entry.size = size
      result.data[name] = phase('空行の除去', function () { return sheetTableFromValues_(values) })
    } catch (e) {
      entry.error = String(e)
      failed = true
    }
  })
  if (failed) {
    result.data = null
    result.error = result.error || '一部のシートの読み込みに失敗しました'
  }
}

function measureCommon_(result, label, f) {
  var t = readMeasureNow_()
  var value = f()
  result.common.push([label, readMeasureNow_() - t])
  return value
}

var READ_MEASURE_RUNNERS = {
  // (a) readSheetTable と同じ呼び出しの順序・回数
  a: function () {
    var result = { common: [], sheets: {}, data: {} }
    var start = readMeasureNow_()
    measureEachSheet_(result, function (name, phase) {
      var ss = phase('スプレッドシートを開く', function () { return SpreadsheetApp.getActiveSpreadsheet() })
      var sheet = phase('シートの取得', function () { return ss.getSheetByName(name) })
      if (!sheet) return null
      var size = phase('最終行・最終列(4回)', function () {
        var empty = sheet.getLastRow() < 1 || sheet.getLastColumn() < 1
        return empty ? null : [sheet.getLastRow(), sheet.getLastColumn()]
      })
      if (!size) return []
      var range = phase('getRange', function () { return sheet.getRange(1, 1, size[0], size[1]) })
      return phase('getDisplayValues', function () { return range.getDisplayValues() })
    })
    result.totalMs = readMeasureNow_() - start
    return result
  },
  b: function () {
    return measureWithGetSheets_(false)
  },
  c: function () {
    return measureWithGetSheets_(true)
  },
  d: function () {
    var result = { common: [], sheets: {}, data: {} }
    var start = readMeasureNow_()
    var id = measureCommon_(result, 'スプレッドシートのID', function () {
      return SpreadsheetApp.getActiveSpreadsheet().getId()
    })
    var token = measureCommon_(result, 'トークンの取得', function () { return ScriptApp.getOAuthToken() })
    var url = sheetsApiBatchGetUrl_(id, SNAPSHOT_SHEETS)
    var response = measureCommon_(result, 'batchGet(HTTP)', function () {
      return UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      })
    })
    var code = response.getResponseCode()
    var text = response.getContentText()
    result.httpCode = code
    result.responseChars = text.length
    if (code !== 200) {
      result.error = describeSheetsApiError_(code, text)
      result.data = null
      result.totalMs = readMeasureNow_() - start
      return result
    }
    var body = measureCommon_(result, 'JSON の解析', function () { return JSON.parse(text) })
    var valueRanges = body.valueRanges || []
    var index = 0
    measureEachSheet_(result, function (name, phase) {
      var values = (valueRanges[index++] || {}).values || []
      // API は行末・表の末尾の空セルを省くため、getDisplayValues と同じ長方形にそろえる
      return phase('行の長さをそろえる', function () { return padSheetsApiValues_(values) })
    })
    result.totalMs = readMeasureNow_() - start
    return result
  },
}

function measureWithGetSheets_(ownFormat) {
  var result = { common: [], sheets: {}, data: {} }
  var start = readMeasureNow_()
  var ss = measureCommon_(result, 'スプレッドシートを開く', function () { return SpreadsheetApp.getActiveSpreadsheet() })
  var byName = measureCommon_(result, 'シート一覧(getSheets + getName)', function () {
    var map = {}
    var sheets = ss.getSheets()
    result.sheetCount = sheets.length
    sheets.forEach(function (sheet) { map[sheet.getName()] = sheet })
    return map
  })
  var tz = ownFormat
    ? measureCommon_(result, 'タイムゾーン', function () { return ss.getSpreadsheetTimeZone() })
    : null
  measureEachSheet_(result, function (name, phase) {
    var sheet = byName[name]
    if (!sheet) return null
    var range = phase('getDataRange', function () { return sheet.getDataRange() })
    if (!ownFormat) return phase('getDisplayValues', function () { return range.getDisplayValues() })
    var raw = phase('getValues', function () { return range.getValues() })
    return phase('文字列への変換', function () {
      return raw.map(function (row) {
        return row.map(function (v) { return readMeasureFormatValue_(v, tz) })
      })
    })
  })
  result.totalMs = readMeasureNow_() - start
  return result
}

// (c) の自前の変換。セルの表示形式は見ないため、日付などは表示と一致しない
// ことがある(一致しない件数は「結果の一致」に出る)。
function readMeasureFormatValue_(v, tz) {
  if (v === '' || v === null || v === undefined) return ''
  if (v === true) return 'TRUE'
  if (v === false) return 'FALSE'
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var hasTime = v.getHours() !== 0 || v.getMinutes() !== 0 || v.getSeconds() !== 0
    return Utilities.formatDate(v, tz, hasTime ? 'yyyy/MM/dd H:mm:ss' : 'yyyy/MM/dd')
  }
  return String(v)
}

// Sheets API のエラー応答から、原因の分かる部分(status / reason / message)を取り出す
function describeSheetsApiError_(code, text) {
  var detail = ''
  try {
    var err = JSON.parse(text).error || {}
    var reasons = (err.details || []).map(function (d) { return d.reason }).filter(Boolean)
    detail = [err.status, reasons.join(','), err.message].filter(Boolean).join(' / ')
  } catch (e) {
    detail = String(text).slice(0, 300)
  }
  var hint = ''
  if (/SERVICE_DISABLED|has not been used|is disabled/.test(detail)) {
    hint = ' → Sheets API が無効です。エディタ左の「サービス」+ から Google Sheets API を追加すると有効になります'
  } else if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient/i.test(detail)) {
    hint = ' → トークンにスプレッドシートの権限が含まれていません'
  }
  return 'Sheets API がエラーを返しました: HTTP ' + code + ' ' + detail + hint
}

function compareWithDisplayValues_(data) {
  var mismatched = 0
  var examples = []
  var reference = readSheetTablesViaSpreadsheetApp_(SNAPSHOT_SHEETS)
  SNAPSHOT_SHEETS.forEach(function (name) {
    var expected = reference[name]
    var actual = data[name] || { headers: [], rows: [] }
    var rows = [expected.headers].concat(expected.rows)
    var actualRows = [actual.headers].concat(actual.rows)
    var height = Math.max(rows.length, actualRows.length)
    for (var r = 0; r < height; r++) {
      var e = rows[r] || []
      var a = actualRows[r] || []
      var width = Math.max(e.length, a.length)
      for (var c = 0; c < width; c++) {
        var ev = e[c] === undefined ? '' : String(e[c])
        var av = a[c] === undefined ? '' : String(a[c])
        if (ev === av) continue
        mismatched++
        if (examples.length < 5) {
          examples.push(name + ' ' + (r + 1) + '行目 ' + (expected.headers[c] || (c + 1) + '列目') +
            ': ' + JSON.stringify(ev.slice(0, 20)) + ' → ' + JSON.stringify(av.slice(0, 20)))
        }
      }
    }
  })
  if (mismatched === 0) return '一致'
  return '不一致 ' + mismatched + ' セル(例: ' + examples.join(' / ') + ')'
}

function formatReadMeasurement_(result) {
  var lines = []
  var kb = function (chars) { return Math.round(chars / 1024) + 'KB' }
  if (result.common && result.common.length > 0) {
    lines.push('  共通: ' + result.common.map(function (p) { return p[0] + ' ' + p[1] + 'ms' }).join(' / ') +
      (result.sheetCount != null ? '(シート数 ' + result.sheetCount + ')' : ''))
  }
  var totalCells = 0
  var totalChars = 0
  SNAPSHOT_SHEETS.forEach(function (name) {
    var s = result.sheets[name]
    if (!s) return
    var head = '  ' + name + ': '
    if (s.size) {
      totalCells += s.size.cells
      totalChars += s.size.chars
      head += s.size.rowCount + '行×' + s.size.colCount + '列=' + s.size.cells + 'セル ' + kb(s.size.chars) + ' | '
    }
    var phases = s.phases.map(function (p) { return p[0] + ' ' + p[1] + 'ms' }).join(' / ')
    var sum = s.phases.reduce(function (acc, p) { return acc + p[1] }, 0)
    lines.push(head + phases + '(計 ' + sum + 'ms)' + (s.missing ? ' ※シートがありません' : '') +
      (s.error ? ' ❌ ' + s.error : ''))
  })
  if (result.responseChars != null) {
    lines.push('  応答: HTTP ' + result.httpCode + ' ' + kb(result.responseChars))
  }
  if (totalCells > 0) lines.push('  合計: ' + totalCells + 'セル ' + kb(totalChars))
  if (result.error) lines.push('  ❌ ' + result.error)
  if (result.totalMs != null) lines.push('  所要時間(合計): ' + result.totalMs + ' ms')
  return lines
}

function readMeasureMedian_(values) {
  var sorted = values.slice().sort(function (x, y) { return x - y })
  var mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function readMeasureHistory_(variant) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(READ_MEASURE_HISTORY_PREFIX + variant)
    var list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function describeReadHistory_(list) {
  if (list.length === 0) return '記録なし'
  var ms = list.map(function (h) { return h.ms })
  var text = '直近の記録(新しい順): ' + ms.join(', ') + ' ms'
  if (ms.length >= 3) text += ' → 直近3回の中央値 ' + readMeasureMedian_(ms.slice(0, 3)) + ' ms'
  else text += '(あと ' + (3 - ms.length) + ' 回実行すると中央値を出します)'
  return text
}

// 成功した計測だけを記録する
function recordReadMeasurement_(variant, result) {
  var list = readMeasureHistory_(variant)
  if (!result.error && result.totalMs != null) {
    list.unshift({ at: new Date().toISOString(), ms: result.totalMs })
    list = list.slice(0, READ_MEASURE_HISTORY_SIZE)
    PropertiesService.getScriptProperties().setProperty(READ_MEASURE_HISTORY_PREFIX + variant, JSON.stringify(list))
  }
  return describeReadHistory_(list)
}

// ---- 経費申請の読み取り --------------------------------------------------------
//
// 経費申請は以前は読み戻しておらず、申請した画面にしか表示されなかった。
// getExpenses で、閲覧者が見てよい申請だけを返す。
//   申請者本人 / 承認ステップに該当する人(指定メンバー、または同じ役職 —
//   approveExpenseStep の担当者チェックと同じ基準) / 全権管理者 /
//   管理画面の「経費」セクションを許可された役職(役職の sections)

function makeExpenseViewer_(acting) {
  var roles = getRoles_()
  var role = String(acting.role || '').trim()
  var found = findRole_(roles, role)
  var sections = found && found.sections
  return {
    id: String(acting.id || ''),
    role: role,
    roles: roles,
    isFullAdmin: isFullAdminRoleRef_(roles, role),
    canOpenExpensesSection: Array.isArray(sections) && sections.indexOf('expenses') >= 0,
  }
}

// 1件の経費申請を閲覧できるか(Google のサービスを使わない純粋な関数)
function canViewExpense_(viewer, app) {
  if (viewer.isFullAdmin || viewer.canOpenExpensesSection) return true
  if (String(app.applicantId) === viewer.id) return true
  var steps = Array.isArray(app.approvalSteps) ? app.approvalSteps : []
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i] || {}
    if (step.type === 'member' && String(step.memberId || '') === viewer.id) return true
    if (step.type === 'role' && sameRole_(viewer.roles || [], step.role, viewer.role)) return true
  }
  return false
}

function parseJsonOr_(raw, fallback) {
  if (raw === '' || raw == null) return fallback
  try { return JSON.parse(String(raw)) } catch (e) { return fallback }
}

function expenseRowToApplication_(headers, row) {
  var get = function (name) {
    var c = headers.indexOf(name)
    return c >= 0 ? row[c] : ''
  }
  var createdAt = get('created_at')
  return {
    id: String(get('id')),
    applicantId: String(get('applicant_id')),
    amount: Number(get('amount')) || 0,
    categoryId: String(get('category_id')),
    receiptUrl: String(get('receipt_url') || '') || undefined,
    justification: String(get('justification') || '') || undefined,
    purpose: String(get('purpose') || '') || undefined,
    customFieldAnswers: parseJsonOr_(get('custom_field_answers_json'), {}),
    approvalSteps: parseJsonOr_(get('approval_steps_json'), []),
    approvals: parseJsonOr_(get('approvals_json'), []),
    currentStepIndex: Number(get('current_step_index')) || 0,
    status: String(get('status') || 'pending'),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || ''),
    rejectionReason: String(get('rejection_reason') || '') || undefined,
  }
}

function getExpenses_(acting) {
  var viewer = makeExpenseViewer_(acting)
  var apps = []
  loadVersionedRows_('expenses', readAllExpenses_).forEach(function (app) {
    if (!app.id) return
    if (canViewExpense_(viewer, app)) apps.push(app)
  })
  // 新しい申請を先に(フロントの一覧と同じ並び)
  apps.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
  return apps
}

// ---- 採用の候補者(Candidates)の読み取り ------------------------------------------
//
// 候補者は電話番号・メールアドレス・履歴書などの個人情報を含むため、採用の権限を持つ人
// (管理画面の「採用」を開ける人 — admin-screen.tsx の canAccessRecruiting と同じ基準)にだけ返す:
//   代表 / 全権管理者 / 権限の例外(permission_overrides)で recruiting の edit・approve を持つ人
// 返す列は、下の規則がある列だけ(READ_POLICY と同じく、規則の無い列は返さない。
// 列を足した時は、ここに規則を足さない限り画面には届かない)。
//   recruiting  採用の権限を持つ人
var CANDIDATES_READ_POLICY = {
  columns: {
    id: 'recruiting',
    name: 'recruiting',
    email: 'recruiting',
    phone: 'recruiting',
    resume_text: 'recruiting',
    interview_notes: 'recruiting',
    status: 'recruiting',
    created_at: 'recruiting',
    updated_at: 'recruiting',
    rejected_at: 'recruiting',
    purge_at: 'recruiting',
  },
}

// 採用の権限を持つか(Google のサービスを使わない。roles は役職の一覧)
function canViewRecruiting_(acting, roles) {
  if (isFullAdminRoleRef_(roles, acting.role)) return true
  var overrides = Array.isArray(acting.permission_overrides) ? acting.permission_overrides : []
  return overrides.some(function (ov) {
    return ov && ov.targetType === 'recruiting' && (ov.access === 'edit' || ov.access === 'approve')
  })
}

function candidateRowToObject_(headers, row) {
  var get = function (name) {
    if (CANDIDATES_READ_POLICY.columns[name] !== 'recruiting') return ''
    var c = headers.indexOf(name)
    var v = c >= 0 ? row[c] : ''
    return v instanceof Date ? v.toISOString() : String(v == null ? '' : v)
  }
  return {
    id: get('id'),
    name: get('name'),
    email: get('email') || undefined,
    phone: get('phone') || undefined,
    resumeText: get('resume_text') || undefined,
    interviewNotes: get('interview_notes') || undefined,
    status: get('status') || 'candidate',
    createdAt: get('created_at'),
    updatedAt: get('updated_at'),
  }
}

function getCandidates_(acting) {
  if (!canViewRecruiting_(acting, getRoles_())) return []
  var out = loadVersionedRows_('candidates', readAllCandidates_).filter(function (c) { return c.id })
  out.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
  return out
}

function readAllCandidates_() {
  var table = readWholeSheet_(SHEET_CANDIDATES, 'candidates')
  if (!table) return []
  return table.rows.map(function (row) { return candidateRowToObject_(table.headers, row) })
}

// ---- フォームの回答(FormSubmissions)の読み取り ----------------------------------
//
// 閲覧できるのは: 申請者本人 / そのフォームの承認ステップの担当者(指定メンバー、または同じ役職 —
// approveCustomFormStep の担当者チェックと同じ基準) / 全権管理者 /
// 管理画面の「フォーム」セクションを許可された役職(役職の sections)

function makeFormViewer_(acting) {
  var roles = getRoles_()
  var role = String(acting.role || '').trim()
  var found = findRole_(roles, role)
  var sections = found && found.sections
  return {
    id: String(acting.id || ''),
    role: role,
    roles: roles,
    isFullAdmin: isFullAdminRoleRef_(roles, role),
    canOpenFormsSection: Array.isArray(sections) && sections.indexOf('forms') >= 0,
  }
}

// 1件の回答を閲覧できるか(Google のサービスを使わない純粋な関数)。
// steps はその回答のフォームの承認ステップ(Settings の custom_form_defs)
function canViewFormSubmission_(viewer, sub, steps) {
  if (viewer.isFullAdmin || viewer.canOpenFormsSection) return true
  if (String(sub.submitterId) === viewer.id) return true
  steps = Array.isArray(steps) ? steps : []
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i] || {}
    if (step.type === 'member' && String(step.memberId || '') === viewer.id) return true
    if (step.type === 'role' && sameRole_(viewer.roles || [], step.role, viewer.role)) return true
  }
  return false
}

function formSubmissionRowToObject_(headers, row) {
  var get = function (name) {
    var c = headers.indexOf(name)
    return c >= 0 ? row[c] : ''
  }
  var createdAt = get('created_at')
  return {
    id: String(get('id')),
    formId: String(get('form_id')),
    submitterId: String(get('submitter_id')),
    answers: parseJsonOr_(get('answers_json'), {}),
    approvals: parseJsonOr_(get('approvals_json'), []),
    currentStepIndex: Number(get('current_step_index')) || 0,
    status: String(get('status') || 'pending'),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || ''),
    rejectionReason: String(get('rejection_reason') || '') || undefined,
  }
}

function getFormSubmissions_(acting) {
  var viewer = makeFormViewer_(acting)
  var subs = loadVersionedRows_('formSubmissions', readAllFormSubmissions_)
  if (!subs.length) return []
  var stepsByForm = {}
  // フォームの定義は、スナップショットの Settings から読む(Settings シートを読み直さない)
  parseJsonOr_(settingValueFromSnapshot_('custom_form_defs'), []).forEach(function (f) {
    if (f && f.id) stepsByForm[String(f.id)] = f.approvalSteps || []
  })
  var out = []
  subs.forEach(function (sub) {
    if (!sub.id) return
    if (canViewFormSubmission_(viewer, sub, stepsByForm[sub.formId])) out.push(sub)
  })
  out.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)) })
  return out
}

// ---- アップロードしたファイルの配信(非公開化) ----------------------------------
//
// アップロードしたファイルは非公開にし、getFiles で権限を確認してから返す。
// 返すのはアップロード用フォルダ(UPLOAD_FOLDER_ID)と旧フォルダ
// (LEGACY_UPLOAD_FOLDER_IDS)の中のファイルだけ — それ以外のIDを受け付けると、
// GAS を実行しているアカウントの Drive にある任意のファイルを読まれてしまう。
// 種類はファイル名の先頭で判断する(アップロード時に付けている名前)。
//   avatar_ / org_logo_ / survey_image_  ログイン済みの全員
//   expense_receipt_                     その領収書を持つ経費申請を閲覧できる人(canViewExpense_)

var GET_FILES_MAX_IDS = 30
var GET_FILES_MAX_BYTES = 8 * 1024 * 1024
var FILE_CACHE_MAX_CHARS = 95000

// フォルダの設定は、リクエストの最初にまとめて読んだスクリプトプロパティ(requestProps_)から読む
function allowedUploadFolderIds_() {
  var props = requestProps_()
  var ids = []
  var current = props[UPLOAD_FOLDER_PROPERTY_KEY]
  if (current) ids.push(current)
  splitCsvList_(props[LEGACY_UPLOAD_FOLDERS_PROPERTY_KEY]).forEach(function (id) {
    if (ids.indexOf(id) < 0) ids.push(id)
  })
  return ids
}

// ファイル名から種類を判定する(Google のサービスを使わない純粋な関数)
function uploadKindFromName_(name) {
  var n = String(name || '')
  if (n.indexOf('expense_receipt_') === 0) return 'receipt'
  if (n.indexOf('avatar_') === 0) return 'avatar'
  if (n.indexOf('org_logo_') === 0) return 'orgLogo'
  if (n.indexOf('survey_image_') === 0) return 'surveyImage'
  return ''
}

// 種類ごとの閲覧可否。receiptApps は、その領収書のファイルIDを receipt_url に
// 含む経費申請の一覧(receipt の判定にだけ使う)
function canViewUploadedFile_(kind, expenseViewer, receiptApps) {
  if (kind === 'avatar' || kind === 'orgLogo' || kind === 'surveyImage') return true
  if (kind === 'receipt') {
    for (var i = 0; i < receiptApps.length; i++) {
      if (canViewExpense_(expenseViewer, receiptApps[i])) return true
    }
  }
  return false
}

function isInAllowedFolder_(file, allowedIds) {
  var parents = file.getParents()
  while (parents.hasNext()) {
    if (allowedIds.indexOf(parents.next().getId()) >= 0) return true
  }
  return false
}

// ファイルの種類(アップロード用フォルダの中のファイルだけ)を覚えておく時間。ファイルIDは変わらないので、
// 2回目からは Drive に問い合わせずに種類が分かる(フォルダの外のファイルは覚えない)
var FILE_META_TTL = 21600

// 1件のファイルの種類を返す。アップロード用フォルダの外・見つからない時は null。
// file は Drive から開いた時だけ入る(キャッシュから分かった時は null)。
// cachedOnly の時は Drive を開かない(キャッシュに無ければ undefined)
// prefetched: getFiles が最初に getAll でまとめて読んだキャッシュ(キー → 値)
function uploadedFileMeta_(id, allowed, cache, cachedOnly, prefetched) {
  var metaKey = 'filemeta:' + id
  var cached = prefetched ? prefetched[metaKey] || null : null
  if (cached) return { kind: cached, file: null }
  if (cachedOnly) return undefined
  var t = Date.now()
  try {
    var file = DriveApp.getFileById(id)
    if (!isInAllowedFolder_(file, allowed)) return null
    var kind = uploadKindFromName_(file.getName())
    try { cache.put(metaKey, kind || 'other', FILE_META_TTL) } catch (e) { /* 覚えられなくても続ける */ }
    return { kind: kind, file: file }
  } catch (e) {
    return null
  } finally {
    addTiming_('driveMs', Date.now() - t)
  }
}

// options.cachedOnly: キャッシュにある画像だけ返す(Drive を開かない。ログインの応答に入れる時)
function getFiles_(acting, fileIds, options) {
  options = options || {}
  var ids = (Array.isArray(fileIds) ? fileIds : []).map(String)
  if (ids.length > GET_FILES_MAX_IDS) throw userError_('一度に取得できるファイルは' + GET_FILES_MAX_IDS + '件までです。')
  var t = Date.now()
  var allowed = allowedUploadFolderIds_()
  addTiming_('folderPropsMs', Date.now() - t)
  var cache = CacheService.getScriptCache()
  // ファイルの種類と画像のキャッシュを、1回の getAll でまとめて読む(1件ずつ読むと、1回ごとに待ち時間がかかる)
  var prefetched = {}
  var ct = Date.now()
  try {
    var keys = []
    ids.forEach(function (id) { keys.push('filemeta:' + id, 'file:' + id) })
    if (keys.length) prefetched = cache.getAll(keys) || {}
  } catch (e) { prefetched = {} }
  addTiming_('fileCacheMs', Date.now() - ct)
  var expenseViewer = null
  var expenses = null
  var totalBytes = 0
  var maxBytes = options.maxBytes || GET_FILES_MAX_BYTES
  var out = []
  ids.forEach(function (id) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) { out.push({ id: id, ok: false, error: 'invalid' }); return }
    var meta = uploadedFileMeta_(id, allowed, cache, options.cachedOnly, prefetched)
    if (meta === undefined) return
    if (!meta) { out.push({ id: id, ok: false, error: 'notFound' }); return }
    var kind = meta.kind === 'other' ? '' : meta.kind
    var receiptApps = []
    if (kind === 'receipt') {
      if (options.cachedOnly) return
      var pt = Date.now()
      if (!expenseViewer) expenseViewer = makeExpenseViewer_(acting)
      if (!expenses) expenses = loadVersionedRows_('expenses', readAllExpenses_)
      receiptApps = expenses.filter(function (app) { return String(app.receiptUrl || '').indexOf(id) >= 0 })
      addTiming_('permissionMs', Date.now() - pt)
    }
    if (!canViewUploadedFile_(kind, expenseViewer, receiptApps)) {
      out.push({ id: id, ok: false, error: 'forbidden' })
      return
    }
    // 小さい画像(アバター・ロゴなど)はキャッシュする。権限の確認は毎回行う。
    // 領収書はキャッシュしない
    var cacheKey = 'file:' + id
    if (kind !== 'receipt') {
      var hit = prefetched[cacheKey] || null
      if (hit) {
        var sep = hit.indexOf('|')
        var cachedData = hit.slice(sep + 1)
        if (totalBytes + cachedData.length > maxBytes) { out.push({ id: id, ok: false, error: 'batchTooLarge' }); return }
        totalBytes += cachedData.length
        addTiming_('fileCacheHits', 1)
        out.push({ id: id, ok: true, mimeType: hit.slice(0, sep), data: cachedData })
        return
      }
    }
    if (options.cachedOnly) return
    var bt = Date.now()
    var file = meta.file || DriveApp.getFileById(id)
    var size = file.getSize()
    if (totalBytes + size > maxBytes) {
      addTiming_('blobMs', Date.now() - bt)
      out.push({ id: id, ok: false, error: 'batchTooLarge' })
      return
    }
    totalBytes += size
    var blob = file.getBlob()
    var mimeType = blob.getContentType() || 'application/octet-stream'
    var data = Utilities.base64Encode(blob.getBytes())
    addTiming_('blobMs', Date.now() - bt)
    if (kind !== 'receipt' && data.length + mimeType.length < FILE_CACHE_MAX_CHARS) {
      try { cache.put(cacheKey, mimeType + '|' + data, SNAPSHOT_CACHE_TTL) } catch (e) { /* キャッシュできなくても返す */ }
    }
    out.push({ id: id, ok: true, mimeType: mimeType, data: data })
  })
  return out
}

// ログインの直後に画面が表示する画像(団体ロゴ・メンバーのプロフィール画像)のファイルID。
// シートの URL から取り出す(lib/ohsumi/files.ts の extractDriveFileId と同じ形)
var DRIVE_FILE_ID_PATTERNS = [
  /^https:\/\/lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]{10,})/,
  /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/,
  /^https:\/\/drive\.google\.com\/(?:open|uc|thumbnail)\?(?:.*&)?id=([A-Za-z0-9_-]{10,})/,
]

function driveFileIdFromUrl_(url) {
  var u = String(url || '')
  for (var i = 0; i < DRIVE_FILE_ID_PATTERNS.length; i++) {
    var m = u.match(DRIVE_FILE_ID_PATTERNS[i])
    if (m) return m[1]
  }
  return null
}

// 団体ロゴ → 本人 → ほかのメンバーの順(上限 GET_FILES_MAX_IDS 件)
function initialImageFileIds_(snapshotData, memberId) {
  var ids = []
  var add = function (url) {
    var id = driveFileIdFromUrl_(url)
    if (id && ids.indexOf(id) < 0 && ids.length < GET_FILES_MAX_IDS) ids.push(id)
  }
  var settings = (snapshotData && snapshotData.Settings) || { headers: [], rows: [] }
  var keyCol = settings.headers.indexOf('key')
  var valueCol = settings.headers.indexOf('value')
  if (keyCol >= 0 && valueCol >= 0) {
    settings.rows.forEach(function (r) { if (String(r[keyCol]) === 'org_logo_url') add(r[valueCol]) })
  }
  var members = (snapshotData && snapshotData.Members) || { headers: [], rows: [] }
  var idCol = members.headers.indexOf('id')
  var avatarCol = members.headers.indexOf('avatar_url')
  if (idCol >= 0 && avatarCol >= 0) {
    members.rows.forEach(function (r) { if (String(r[idCol]) === String(memberId)) add(r[avatarCol]) })
    members.rows.forEach(function (r) { add(r[avatarCol]) })
  }
  return ids
}

// ログインの応答に入れる画像の合計の上限(base64 の文字数)
var INITIAL_FILES_MAX_CHARS = 1500000

// シート1枚を1回の呼び出しで読む(getDataRange)。これまでは最終行・見出し・本文を別々に読んでいて、
// 呼び出しごとに待ち時間がかかっていた。timing に <prefix>SheetMs(読み込みの時間)・<prefix>Rows・<prefix>Cols を記録する。
// 返り値は { headers, rows }(見出しは前後の空白を除く)。シートが無ければ null
function readWholeSheet_(name, prefix) {
  var pre = takePrefetchedSheet_(name)
  if (pre) {
    // prefetchBackgroundSheets_ で、ほかの表とまとめて読んだもの(時間は batchReadMs に入っている)
    noteTiming_(prefix + 'Rows', Math.max(pre.length - 1, 0))
    noteTiming_(prefix + 'Cols', pre.length ? pre[0].length : 0)
    if (!pre.length) return { headers: [], rows: [] }
    return { headers: pre[0].map(function (h) { return String(h).trim() }), rows: pre.slice(1) }
  }
  var t = Date.now()
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet) return null
  var values = sheet.getDataRange().getValues()
  noteTiming_(prefix + 'SheetMs', Date.now() - t)
  noteTiming_(prefix + 'Rows', Math.max(values.length - 1, 0))
  noteTiming_(prefix + 'Cols', values.length ? values[0].length : 0)
  if (!values.length) return { headers: [], rows: [] }
  return { headers: values[0].map(function (h) { return String(h).trim() }), rows: values.slice(1) }
}

function readAllFormSubmissions_() {
  var table = readWholeSheet_(SHEET_FORM_SUBMISSIONS, 'formSubmissions')
  if (!table) return []
  return table.rows.map(function (row) { return formSubmissionRowToObject_(table.headers, row) })
}

function readAllExpenses_() {
  var table = readWholeSheet_(SHEET_EXPENSES, 'expenses')
  if (!table) return []
  return table.rows.map(function (row) { return expenseRowToApplication_(table.headers, row) })
}

// ---- 裏での読み込みで、キャッシュに無い表をまとめて読む(Sheets API) --------------------------
//
// 経費・フォームの回答・候補者・メールアドレス表のうち、キャッシュに無いものが2つ以上ある時は、
// Sheets API を1回だけ呼んで読む(SpreadsheetApp で1枚ずつ読むと、呼び出しのたびに待ち時間がかかる)。
// values.batchGet は日付を数(シリアル値)で返し、日付と数を区別できないため、セルの値と表示形式の種類を
// 一緒に返す spreadsheets.get(includeGridData)を使う。値は SpreadsheetApp の getValues と同じ形
// (日付・時刻の表示形式のセルは Date、数は number、文字は string、空は '')にそろえる。
// 失敗した時は、これまでどおり1枚ずつ SpreadsheetApp で読む(readWholeSheet_)。
// timing: batchReadMs(読み込み)・batchReadSheets(枚数)・batchRead(api / spreadsheetApp)・batchReadError
var _prefetchedSheets = {}
var _requestEmailMap = null

function takePrefetchedSheet_(name) {
  var values = _prefetchedSheets[name]
  if (!values) return null
  delete _prefetchedSheets[name]
  return values
}

function prefetchBackgroundSheets_(acting, body) {
  var wanted = []
  try {
    var parts = [
      { prefix: 'expenses', action: 'getExpenses', sheet: SHEET_EXPENSES },
      { prefix: 'formSubmissions', action: 'getFormSubmissions', sheet: SHEET_FORM_SUBMISSIONS },
      { prefix: 'candidates', action: 'getCandidates', sheet: SHEET_CANDIDATES, recruiting: true },
    ]
    parts.forEach(function (p) {
      if (!isActionAllowed_(acting, p.action, body)) return
      // 候補者は採用の権限を持つ人にだけ読む(getCandidates と同じ基準)
      if (p.recruiting && !canViewRecruiting_(acting, getRoles_())) return
      if (versionedRowsCached_(p.prefix)) return
      wanted.push(p.sheet)
    })
    if (isActionAllowed_(acting, 'getMyEmails', body) && !memberEmailMapCached_()) wanted.push(SHEET_MEMBER_EMAILS)
  } catch (e) {
    return
  }
  if (wanted.length < 2) return
  var t = Date.now()
  var res
  try {
    res = readSheetValuesViaApi_(wanted)
  } catch (e) {
    res = { error: '通信エラー: ' + ((e && e.message) || e) }
  }
  noteTiming_('batchReadMs', Date.now() - t)
  noteTiming_('batchReadSheets', wanted.length)
  if (res.values) {
    noteTiming_('batchRead', 'api')
    Object.keys(res.values).forEach(function (name) { _prefetchedSheets[name] = res.values[name] })
  } else {
    noteTiming_('batchRead', 'spreadsheetApp')
    noteTiming_('batchReadError', String(res.error).slice(0, 200))
    console.warn('prefetchBackgroundSheets: Sheets API で読めなかったため、1枚ずつ読みます。理由: ' + res.error)
  }
}

function isActionAllowed_(acting, action, body) {
  try {
    authorizeAction_(acting, action, body)
    return true
  } catch (e) {
    return false
  }
}

// 版ごとのキャッシュがあるか。あれば、このリクエストの中で使い回す(loadVersionedRows_ が同じものを使う)
function versionedRowsCached_(prefix) {
  var version = getTableVersion_(prefix)
  var memoKey = prefix + ':' + version
  if (_requestRows[memoKey]) return true
  var rows = readChunkedCache_(prefix, version)
  if (!Array.isArray(rows)) return false
  _requestRows[memoKey] = rows
  noteTiming_(prefix + 'Cache', 'hit')
  return true
}

function memberEmailMapKey_() {
  return 'memberEmailById:' + getMemberEmailsVersion_()
}

function memberEmailMapCached_() {
  var key = memberEmailMapKey_()
  try {
    var raw = CacheService.getScriptCache().get(key)
    if (!raw) return false
    _requestEmailMap = { key: key, map: JSON.parse(raw) }
    noteTiming_('myEmailCache', 'hit')
    return true
  } catch (e) {
    return false
  }
}

function sheetsApiGridUrl_(spreadsheetId, names) {
  var fields = 'properties.timeZone,sheets(properties.title,data(rowData.values(effectiveValue,effectiveFormat.numberFormat.type)))'
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + '?includeGridData=true&' +
    names.map(function (name) { return 'ranges=' + encodeURIComponent(sheetsApiRangeName_(name)) }).join('&') +
    '&fields=' + encodeURIComponent(fields)
}

// 成功したら { values: { シート名: 2次元配列(getValues と同じ形) } }、失敗したら { error }
function readSheetValuesViaApi_(names) {
  var id = SpreadsheetApp.getActiveSpreadsheet().getId()
  var response = UrlFetchApp.fetch(sheetsApiGridUrl_(id, names), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  })
  var code = response.getResponseCode()
  var text = response.getContentText()
  if (code !== 200) return { error: describeSheetsApiError_(code, text) }
  var body
  try {
    body = JSON.parse(text)
  } catch (e) {
    return { error: '応答を JSON として読めませんでした' }
  }
  return sheetValuesFromGridResponse_(body, names)
}

// spreadsheets.get の応答を、シートごとの getValues と同じ形の2次元配列にする(Google のサービスを使わない
// 部分。日付の変換だけ Utilities.formatDate を使う)
function sheetValuesFromGridResponse_(body, names) {
  var timeZone = (body && body.properties && body.properties.timeZone) || Session.getScriptTimeZone()
  var byTitle = {}
  ;((body && body.sheets) || []).forEach(function (sheet) {
    var title = sheet && sheet.properties ? String(sheet.properties.title) : ''
    byTitle[title] = (sheet.data && sheet.data[0]) || {}
  })
  var values = {}
  for (var i = 0; i < names.length; i++) {
    if (!byTitle.hasOwnProperty(names[i])) return { error: '応答にシートがありません(' + names[i] + ')' }
    values[names[i]] = gridDataToValues_(byTitle[names[i]], timeZone)
  }
  return { values: values }
}

// getDataRange().getValues() と同じ長方形(値のある最後の行・列まで)にする。空のシートは [['']]
function gridDataToValues_(grid, timeZone) {
  var rowData = (grid && grid.rowData) || []
  var height = 0
  var width = 0
  var raw = rowData.map(function (r, i) {
    return ((r && r.values) || []).map(function (cell, c) {
      var v = cellValueFromApi_(cell, timeZone)
      if (v !== '') {
        if (c + 1 > width) width = c + 1
        if (i + 1 > height) height = i + 1
      }
      return v
    })
  })
  if (height === 0) return [['']]
  var out = []
  for (var i = 0; i < height; i++) {
    var row = raw[i].slice(0, width)
    while (row.length < width) row.push('')
    out.push(row)
  }
  return out
}

// エラーのセルは、getValues と同じくエラーの表示(#N/A など)にする
var SHEETS_API_ERROR_TEXT = {
  ERROR: '#ERROR!', NULL_VALUE: '#NULL!', DIVIDE_BY_ZERO: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!',
  NAME: '#NAME?', NUM: '#NUM!', N_A: '#N/A', LOADING: 'Loading...',
}
var SHEETS_API_DATE_TYPES = ['DATE', 'TIME', 'DATE_TIME']

function cellValueFromApi_(cell, timeZone) {
  var ev = cell && cell.effectiveValue
  if (!ev) return ''
  if (typeof ev.numberValue === 'number') {
    var fmt = cell.effectiveFormat && cell.effectiveFormat.numberFormat
    if (fmt && SHEETS_API_DATE_TYPES.indexOf(fmt.type) >= 0) return sheetSerialToDate_(ev.numberValue, timeZone)
    return ev.numberValue
  }
  if (typeof ev.stringValue === 'string') return ev.stringValue
  if (typeof ev.boolValue === 'boolean') return ev.boolValue
  if (ev.errorValue) return SHEETS_API_ERROR_TEXT[ev.errorValue.type] || '#ERROR!'
  return ''
}

// スプレッドシートのシリアル値(1899-12-30 からの日数。スプレッドシートのタイムゾーンでの日時)を Date にする
// (SpreadsheetApp の getValues が返す Date と同じ時刻)
function sheetSerialToDate_(serial, timeZone) {
  var wallMs = Math.round((serial - 25569) * 86400000)
  var offset = timeZoneOffsetMs_(new Date(wallMs), timeZone)
  var d = new Date(wallMs - offset)
  var offset2 = timeZoneOffsetMs_(d, timeZone)
  return offset2 === offset ? d : new Date(wallMs - offset2)
}

function timeZoneOffsetMs_(date, timeZone) {
  var wall = Utilities.formatDate(date, timeZone, "yyyy-MM-dd'T'HH:mm:ss.SSS")
  return Date.parse(wall + 'Z') - date.getTime()
}

// ---- Discord / Slack の連携状態 ----------------------------------------------
//
// Webhook URL は秘密情報なので、スクリプトプロパティから外には出さない。
// 画面には「設定済みかどうか」と、最後のテスト送信の結果・日時だけを返す
// (getWebhookStatus。全権管理者と、Webhook を設定できる人だけが呼べる —
// authorizeAction_ で updateDiscordWebhookUrl と同じ基準)。
// テスト送信の結果・日時はスクリプトプロパティに保存する。

var WEBHOOK_TEST_RESULT_PROPERTY_KEYS = {
  discord: 'discord_webhook_last_test',
  slack: 'slack_webhook_last_test',
}

function recordWebhookTestResult_(kind, ok, error) {
  PropertiesService.getScriptProperties().setProperty(
    WEBHOOK_TEST_RESULT_PROPERTY_KEYS[kind],
    JSON.stringify({ ok: !!ok, at: new Date().toISOString(), error: error || '' }),
  )
}

function clearWebhookTestResult_(kind) {
  PropertiesService.getScriptProperties().deleteProperty(WEBHOOK_TEST_RESULT_PROPERTY_KEYS[kind])
}

function readWebhookTestResult_(kind) {
  var raw = PropertiesService.getScriptProperties().getProperty(WEBHOOK_TEST_RESULT_PROPERTY_KEYS[kind])
  if (!raw) return null
  try {
    var parsed = JSON.parse(raw)
    return { ok: !!parsed.ok, at: String(parsed.at || ''), error: String(parsed.error || '') }
  } catch (e) {
    return null
  }
}

// テスト送信。通信自体に失敗した場合(例外)も結果として保存してから投げ直す
function fetchWebhookForTest_(kind, url, options) {
  if (isChatSuppressed_()) {
    throw userError_('テスト環境では Discord・Slack に投稿しません。接続を確かめる場合は、スクリプトプロパティ TEST_ALLOW_CHAT を true にしてください。')
  }
  try {
    return UrlFetchApp.fetch(url, options)
  } catch (e) {
    recordWebhookTestResult_(kind, false, '送信できませんでした')
    throw userError_((kind === 'discord' ? 'Discord' : 'Slack') + 'への送信に失敗しました。Webhook URLが正しいか確認してください。')
  }
}

function getWebhookStatus_() {
  return {
    discord: { configured: !!getDiscordWebhookUrl_(), lastTest: readWebhookTestResult_('discord') },
    slack: { configured: !!getSlackWebhookUrl_(), lastTest: readWebhookTestResult_('slack') },
  }
}

// ---- 性能計測用のダミーデータ(テスト環境専用) ----------------------------------
//
// 本番と同じくらいの規模(メンバー50人・プロジェクト20件・タスク500件)の
// ダミーデータを作り、measureReadPerformance() で規模を再現した計測ができる
// ようにする。本番で誤って実行されないよう、スクリプトプロパティ
// TEST_ENVIRONMENT が 'true' のときだけ動く。ダミーデータの id はすべて
// 'perf-' で始まり、deletePerformanceTestData() でまとめて削除できる。
//
// 使い方(Apps Script エディタで実行):
//   1. スクリプトプロパティ TEST_ENVIRONMENT を true にする
//   2. seedPerformanceTestData() を実行する
//   3. measureReadPerformance() を実行して結果を確認する
//   4. deletePerformanceTestData() を実行してダミーデータを消す

var PERF_TEST_ID_PREFIX = 'perf-'
var PERF_TEST_COUNTS = { members: 50, projects: 20, tasks: 500 }

function assertTestEnvironment_() {
  if (!isTestEnvironment_()) {
    throw userError_('テスト環境ではないため実行できません。スクリプトプロパティ TEST_ENVIRONMENT を true にしてから実行してください。')
  }
}

// 同じ結果を再現できるよう、乱数は種を固定した簡易な生成器を使う
function makePerfRandom_(seed) {
  var state = seed >>> 0
  var next = function () {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  return {
    next: next,
    int: function (min, max) { return min + Math.floor(next() * (max - min + 1)) },
    pick: function (list) { return list[Math.floor(next() * list.length)] },
    chance: function (p) { return next() < p },
    sample: function (list, n) {
      var copy = list.slice()
      var out = []
      while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0])
      return out
    },
  }
}

function perfDate_(daysFromBase) {
  var d = new Date(Date.UTC(2026, 0, 1) + daysFromBase * 86400000)
  return d.toISOString().slice(0, 10)
}

function perfText_(rng, minLen, maxLen) {
  var words = ['資料を確認しました', '来週までに対応します', '先方に連絡済みです', '修正版をアップしました',
    'レビューをお願いします', '日程を調整中です', '予算の見直しが必要です', '進捗を共有します',
    '担当を追加しました', '参考資料を添付します', '確認事項があります', '次回の定例で相談します']
  var len = rng.int(minLen, maxLen)
  var s = ''
  while (s.length < len) s += rng.pick(words) + '。'
  return s
}

// メンバー・プロジェクト・タスクの行を作る(Google のサービスを使わない純粋な関数)。
// 返り値は { Members: [...], Projects: [...], Tasks: [...] } で、各要素は
// {列名: 値} のオブジェクト。割合は実際の団体に近づけている:
//   役職: 代表1人・事業責任者2人・班長7人・一般40人
//   タスク: 幹部限定 約10%、承認待ち 約5%、コメント付き 約35%、履歴付き 約60%
function buildPerformanceTestData_(seed) {
  var rng = makePerfRandom_(seed || 20260928)
  var P = PERF_TEST_ID_PREFIX
  var pad = function (n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s }
  var departments = ['運営', '広報', '開発', 'デザイン', '渉外', 'イベント', 'リサーチ']
  var skills = ['企画', '広報', 'デザイン', 'リサーチ', 'イベント運営', 'メール', '実装', '要件定義', '校閲']
  var statuses = ['未着手', '進行中', '進行中', '進行中', '確認待ち', '修正中', '保留', 'サポート必要', '完了', '完了', '完了']
  var difficulties = ['誰でも可', '新人歓迎', '少し経験必要', '経験者向け', '上級者向け']
  var colors = ['#6366f1', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6']

  var projects = []
  for (var p = 1; p <= PERF_TEST_COUNTS.projects; p++) {
    projects.push({ id: P + 'p-' + pad(p, 2), name: 'ダミープロジェクト' + p })
  }

  var members = []
  for (var m = 1; m <= PERF_TEST_COUNTS.members; m++) {
    var role = m === 1 ? '代表' : m <= 3 ? '事業責任者' : m <= 10 ? '班長' : '一般'
    var id = P + 'm-' + pad(m, 2)
    var myProjects = role === '班長' ? rng.sample(projects, 2).map(function (x) { return x.id }) : []
    var hasHr = role !== '一般' || rng.chance(0.4)
    members.push({
      id: id,
      name: 'ダミー' + pad(m, 2),
      display_name: 'ダミー' + pad(m, 2),
      role: role,
      avatar_color: rng.pick(colors),
      avatar_initials: 'D' + (m % 10),
      will_tags: rng.sample(skills, 2).join(','),
      judgment_tags: rng.sample(skills, 2).join(','),
      reports_to_id: m > 10 ? P + 'm-' + pad(rng.int(4, 10), 2) : m > 1 ? P + 'm-01' : '',
      joined_at: perfDate_(-rng.int(30, 900)),
      project_ids: myProjects.join(','),
      department_path: '事業本部>' + rng.pick(departments),
      skill_levels_json: JSON.stringify(rng.sample(skills, 3).map(function (s) { return { skill: s, level: rng.int(1, 5) } })),
      skill_points_json: JSON.stringify({ '企画': rng.int(0, 400), 'デザイン': rng.int(0, 400) }),
      career_history_json: hasHr ? JSON.stringify([{ id: 'c1', startDate: perfDate_(-600), title: '担当', note: perfText_(rng, 20, 60) }]) : '',
      evaluation_history_json: hasHr ? JSON.stringify([{ id: 'e1', date: perfDate_(-90), rating: rng.int(1, 5), comment: perfText_(rng, 40, 120) }]) : '',
      one_on_ones_json: hasHr ? JSON.stringify([{ id: 'o1', date: perfDate_(-30), notes: perfText_(rng, 60, 200) }]) : '',
      survey_responses_json: rng.chance(0.6) ? JSON.stringify([{ id: 's1', submittedAt: perfDate_(-10), answers: { q1: rng.int(1, 5), q2: rng.int(1, 5) } }]) : '',
      last_login: perfDate_(-rng.int(0, 40)) + 'T09:00:00.000Z',
      timezone: 'Asia/Tokyo',
      locale: 'ja',
    })
  }
  projects.forEach(function (proj) {
    var mids = rng.sample(members, rng.int(5, 10)).map(function (x) { return x.id })
    proj.description = perfText_(rng, 40, 120)
    proj.goal = perfText_(rng, 20, 60)
    proj.owner_id = P + 'm-' + pad(rng.int(1, 10), 2)
    proj.member_ids = mids.join(',')
    proj.archived = 'FALSE'
    proj.start_date = perfDate_(-rng.int(30, 300))
  })

  var tasks = []
  for (var t = 1; t <= PERF_TEST_COUNTS.tasks; t++) {
    var assignees = rng.sample(members, rng.int(0, 2)).map(function (x) { return x.id })
    var creator = rng.pick(members).id
    var comments = []
    if (rng.chance(0.35)) {
      for (var c = 0, nc = rng.int(1, 6); c < nc; c++) {
        comments.push({ id: 'cm' + c, byId: rng.pick(members).id, at: perfDate_(rng.int(0, 250)) + 'T10:00:00.000Z', text: perfText_(rng, 30, 200) })
      }
    }
    var history = []
    if (rng.chance(0.6)) {
      for (var h = 0, nh = rng.int(2, 8); h < nh; h++) {
        history.push({ at: perfDate_(rng.int(0, 250)) + 'T10:00:00.000Z', byId: rng.pick(members).id, type: 'status', from: rng.pick(statuses), to: rng.pick(statuses) })
      }
    }
    tasks.push({
      id: P + 't-' + pad(t, 4),
      project_id: rng.pick(projects).id,
      title: 'ダミータスク' + t,
      description: perfText_(rng, 40, 300),
      status: rng.pick(statuses),
      assign_type: assignees.length ? 'direct' : 'open_bid',
      assignee_id: assignees.join(','),
      creator_id: creator,
      created_at: perfDate_(rng.int(0, 250)),
      start_date: perfDate_(rng.int(0, 250)),
      due_date: perfDate_(rng.int(0, 300)),
      visibility: rng.chance(0.1) ? '幹部' : 'all',
      department: rng.pick(departments),
      category: rng.pick(['企画', '制作', '連絡', '会計', '調査']),
      skills: rng.sample(skills, rng.int(1, 3)).join(','),
      difficulty: rng.pick(difficulties),
      priority: rng.pick(['高', '中', '中', '低']),
      approval_status: rng.chance(0.05) ? '承認待ち' : '',
      importance: rng.chance(0.1) ? '重要' : '一般',
      progress_note: rng.chance(0.3) ? perfText_(rng, 20, 100) : '',
      progress_percent: String(rng.int(0, 100)),
      comments_json: comments.length ? JSON.stringify(comments) : '',
      history_json: history.length ? JSON.stringify(history) : '',
    })
  }
  return { Members: members, Projects: projects, Tasks: tasks }
}

// 行オブジェクトをシートの見出しに合わせて末尾に一括で書き込む
// (見出しに無い列は捨てる。日付の自動変換を避けるため書式なしテキストにする)
function appendPerfRows_(sheetName, objects) {
  if (objects.length === 0) return 0
  var sheet = getSheet_(sheetName)
  var headers = headerRow_(sheet)
  var values = objects.map(function (obj) {
    return headers.map(function (h) { return obj[h] != null ? String(obj[h]) : '' })
  })
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length)
  range.setNumberFormat('@')
  range.setValues(values)
  return values.length
}

function countPerfRows_(sheetName) {
  var sheet = getSheet_(sheetName)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0 || sheet.getLastRow() < 2) return 0
  return sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues().filter(function (r) {
    return String(r[0]).indexOf(PERF_TEST_ID_PREFIX) === 0
  }).length
}

// ---- 画面確認用のサンプルのデータ(テスト環境専用) --------------------------------
//
// すべての機能が実際に使われている状態を再現し、画面が実際のデータでどう表示されるかを
// 確かめるためのデータ。性能計測用(seedPerformanceTestData)とは別のもので、規模は
// メンバー約20人・プロジェクト約8件・タスク約150件。
//   - TEST_ENVIRONMENT が true の時だけ動く
//   - 何度実行しても重複しない(既存のサンプルを消してから作り直す)
//   - 日付はすべて実行した日を基準にする(いつ実行しても、期限切れ・今週締切・来月開始・
//     完了から日が経ってアーカイブされたもの などが再現される)
//   - id はすべて 'sample-' で始まり、deleteSampleData() でまとめて消せる
//   - Settings は既存の設定を上書きせずに追加し、deleteSampleData() で元に戻す
//
// 使い方(Apps Script エディタで実行):
//   1. スクリプトプロパティ TEST_ENVIRONMENT を true にする
//   2. (任意)スクリプトプロパティ TEST_ACCOUNTS に、テスト用の Google アカウントを枠ごとに書く
//        例: top=a@gmail.com, admin=b@gmail.com, restricted=c@gmail.com, base=d@gmail.com, base_en=e@gmail.com
//   3. seedSampleData() を実行する
//   4. 確認が終わったら deleteSampleData() を実行する

var SAMPLE_ID_PREFIX = 'sample-'

// ダミー画像(小さな PNG。アップロード用フォルダに非公開で保存する)
var SAMPLE_IMAGES = {
  avatar1: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUXo1sX8reO6NiaLzA+4NBXBWzNC2/Rj6NAAAAAAAAAAAAAAArkd3jQHQU6UBeldRgHoqB1B/hQD6GgALgP4FAAAAAKsDeMiYhZhGZ9kHZtjIZtiJ+VYBAAAAAAAAGObWWWhkURpAdiUAZF0oQD4FAeSZO0D+OQIUFYDU23cZlgEoIwAAAACoDzgBVUlksz1wI6MAAAAASUVORK5CYII=',
  avatar2: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUbqxRIu1mOfemCg6P+DeUABnxQzt2PahTwMAAAAAAAAAAAAA4Hp01xgAPVUaoHcVBaincgD1VwigrwGwAOhfAAAAALA6gIeMWYhpdJZ9YIaNbIadmG8VAAAAAAAAgGFunYVGFqUBZFcCQNaFAuRTEECeuQPknyNAUQFIvX2XYRmAMgIAAACA+oATz4ZJzMMhujMAAAAASUVORK5CYII=',
  avatar3: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUTYWa0O2+9wbE0XnB9wbCuCsmKFtxz70aQAAAAAAAAAAAAAAXI/uGgOgp0oD9K6iAPVUDqD+CgH0NQAWAP0LAAAAAFYH8JAxCzGNzrIPzLCRzbAT860CAAAAAAAAMMyts9DIojSA7EoAyLpQgHwKAsgzd4D8cwQoKgCpt+8yLANQRgAAAABQH3AC6Dey8NVVlbYAAAAASUVORK5CYII=',
  avatar4: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUVa2bK1W89wbE0XnB9wbCuCsmKEd+zb0aQAAAAAAAAAAAAAAXI/uGgOgp0oD9K6iAPVUDqD+CgH0NQAWAP0LAAAAAFYH8JAxCzGNzrIPzLCRzbAT860CAAAAAAAAMMyts9DIojSA7EoAyLpQgHwKAsgzd4D8cwQoKgCpt+8yLANQRgAAAABQH3ACJUedwPg9QmMAAAAASUVORK5CYII=',
  logo: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACK0lEQVR42u3d0W3DMBCDYe4aoPtngnaEIoisI3l/wefUpy+OL7Es6fXzJoMRQwAAAAQAAAgAABAAACAAAEAAAIAAAAABAAACAAAEAAAIAAAQAAAgAABAAADg//x+/gfAwKAv95Dn0O/BkP/Qd2PowtCbvGwbwLUB6pbQE4My1VltAXAYghqGkwAjBaQzqKbgUAaV1RnHoMryghi+BXB+c0UwNANEHHM/gPmRa8PoO5ewC8CwinUAbrV8dQ2I/hXMxGAvgElF2wHGTwUAhkvb8j3A1kBxH5plBgAMn+WpAE//0HatTMW1blOTAQAYmLFyoVIFNQwjk7eerjQGYHAC3aPFKqJjG5/E+FyxAAzXK/8+wWcmrx3AHQNPgFOvDMBwvfJv1NweJjj7+vJv1Ayf5jj4L+TfqAEw2SR4Ahw0kH+nbPI94KF6Zd4kABBsEHEHTebXqPFfQyMBxg2CbiPL/CNy8I5YPMD9vihxLoUuH9yGiRReAMwmsgBYNa3xo+oUdL2qPAkU9GYBgFOhBaDvVMgD4KGzeYAmhmCA1+4nkNXRTfM9YDVDFcArcM2fNoAshi+PU3Fnd9kCXQq9ytmuUtcJcLBgt4NRQccdvWpp6gYONUv3xu+gkb6Edc8WJqFLubftIRO3mUHzJj4R+0hs2UXJdguPpdtY+Uz1ZR+x4QAAAAAEAAAIAAAQAAAgAABAAACAAAAAAQAAAgAABAAACAAAEAAAIAAAQA7mD0B1Q6FafX4vAAAAAElFTkSuQmCC',
  receipt: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAEECAIAAADiZ+yyAAACc0lEQVR42u3cwQ2EMAwAwVRCJdRJrTzyoAP4xEmMx5oKotXJQta13m8YrnkChIWwEBYIC2EhLBAWwkJYICx+HdZpZo2wjLCEJSxhCUtYRljCEpawhOU7Fr5jeQWEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWDA5rMvkGWGZZA0JS0N2LCzvICyEhbBAWAgLYYGwEBbCAmEhLIQFwsI9lsl2pyUsDQlLQ3Ys7FheAWEhLIQFwkJYCAuEhbAQFggLYSEsEBYuSE21Oy1haUhYGrJjYcfyCggLYSEsEBbCQlggLISFsEBYCAthgbBwj2Wq3WkJS0PC0pAdCzuWV0BYCAthgbAQFsICYSEshAXCQlgIC4SFeyxT7U5LWBoSlobsWNixvALCQlgIC4SFsBAWCAthISwQFsJCWCAs3GOZandawtKQsEye7u1YWN4RFsLyCggLYSEsEBbCQlggLISFsEBYCAthucdy6ycss3H3wjIhv512LCzvCAtheQWEhbAQFggLYSEsEBbCQlggLISFsNxjmTF3WsIyIbd+wtKQHQvLO8LyCggLYSEsEBbCQlggLISFsEBYCAthgXsss/GdlrA05BfL5PlvZjsWwkJYCMsrICyEhbBAWAgLYYGwEBbCAmEhLITlHsudlrDMxrd+wtKQHQvLO8LyCggLYSEsEBbCQlggLISFsPhw1BthCUtYwhIWwnKPZd5GWGZNQ8IyIQ3ZsfAdC2GBsBAWwgJhISyEBcJCWAgLhIWwEBasDMs5lP/1E5aGhGVSNWTHQlgIC4SFsMjsAVooUljkMTzyAAAAAElFTkSuQmCC',
  survey: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABbUlEQVR42u3cuxHCQAwFQPdKTkxAREwKZdAGndDGowd88sl436iDHY/vI91yen5K63qvrcettl6X2nqfa2sBDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAjwGcXwN4B8BZF8CtgTMigJsCZ1wAtwPO6ABuBJyaAG4BnMoAngyc+gCeBpytAngCcLYN4E2BMyOANwLOvAAuB87sAC4ETo8ALgFOpwAeDJx+ATwMOF0D+J91hxgfHTh7COB/1l1pfFzg7C2AfcGA/YOtoq2i7YPtg51kOclyFu0s2m0SYPfBgHV0ANaTpatSV6W+aH3RJhtMNphNAmy6ELD5YMAm/AF7o8MrO2t1AXsnC7CX7gADBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgx4d8BfqAF1isqXnKAAAAAASUVORK5CYII=',
}

// テスト用のアカウントを割り当てる枠(TEST_ACCOUNTS の名前)と、その枠のサンプルのメンバー
var SAMPLE_ACCOUNT_SLOTS = {
  top: 'sample-m-01',        // 最上位(代表)
  admin: 'sample-m-02',      // 全権管理者(事業責任者)
  restricted: 'sample-m-03', // 制限付きの管理者(サンプル班長)
  base: 'sample-m-05',       // 一般
  base_en: 'sample-m-06',    // 一般・英語表示
}

// サンプルで使う役職名(内部コード化で役職がIDになったら、ここも合わせて変える)
var SAMPLE_ROLES = { top: '代表', admin: '事業責任者', restricted: 'サンプル班長', base: '一般' }

// フロント(lib/ohsumi/store.tsx)の既定の選択肢。Settings の値が空の団体では画面がこの
// 既定値を使うため、サンプルの値を足す時はこの既定値に足す(テストで一致を確かめる)
var SAMPLE_LIST_DEFAULTS = {
  skill_options: ['デザイン', 'Canva', 'PowerPoint', 'ライティング', 'リサーチ', 'SNS', '広報', 'コミュニケーション',
    'イベント運営', 'メール', 'UI/UX', '実装', '企画', '要件定義', 'プロダクト設計', '校閲', 'Claude', 'V0'],
  category_options: ['未分類', 'デザイン', '渉外', 'イベント', '広報', 'ライティング', '企画', 'リサーチ', '開発', '物品調達'],
  skill_field_options: ['デザイン', '営業', 'AI活用'],
  role_levels: ['班長', '事業責任者', '代表'],
  restricted_roles: [],
}

// ---- 日付(実行した日を基準にする。Google のサービスを使わない) ----

function sampleDay_(today, offset) {
  var p = String(today).split('-')
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + offset * 86400000)
  return d.toISOString().slice(0, 10)
}

// その日の日本時間の時刻(ISO 形式)
function sampleAt_(today, offset, hhmm) {
  var t = String(hhmm || '10:00').split(':')
  var utcHour = (Number(t[0]) + 24 - 9) % 24
  var day = Number(t[0]) < 9 ? sampleDay_(today, offset - 1) : sampleDay_(today, offset)
  var hh = utcHour < 10 ? '0' + utcHour : String(utcHour)
  return day + 'T' + hh + ':' + t[1] + ':00.000Z'
}

function samplePad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s }

function sampleJson_(v) { return v == null ? '' : JSON.stringify(v) }

// ---- メンバー ----

// 役割の違うメンバー(人格)。files はアップロードしたダミー画像の URL(キー → URL)
function buildSampleMembers_(today, files) {
  var R = SAMPLE_ROLES
  var d = function (n) { return sampleDay_(today, n) }
  var people = [
    // 01 代表: 経歴・スキル・評価がすべて豊富
    { n: 1, name: '高橋 誠', role: R.top, avatar: 'avatar1', joined: -1400, will: '企画,コミュニケーション,広報', judgment: '企画,要件定義,リサーチ',
      rich: true, management: true, dept: 'サンプル本部>運営', locale: 'ja' },
    // 02 全権管理者
    { n: 2, name: '伊藤 さくら', role: R.admin, avatar: 'avatar2', joined: -1000, will: 'デザイン,UI/UX,Canva', judgment: 'デザイン,Canva,PowerPoint',
      rich: true, management: true, dept: 'サンプル本部>デザイン', reportsTo: 1, locale: 'ja' },
    // 03 制限付きの管理者(担当プロジェクトだけを管理する)
    { n: 3, name: '渡辺 大輔', role: R.restricted, avatar: 'avatar3', joined: -700, will: 'イベント運営,企画', judgment: 'イベント運営,メール',
      rich: true, dept: 'サンプル本部>イベント', reportsTo: 2, projects: [2, 3], locale: 'ja' },
    // 04 制限付きの管理者(もう1人)
    { n: 4, name: '中村 優子', role: R.restricted, joined: -500, will: 'ライティング,広報,SNS', judgment: 'ライティング,校閲',
      dept: 'サンプル本部>広報', reportsTo: 2, projects: [4], locale: 'ja' },
    // 05 一般(テスト用アカウントの一般の枠): ほどほどにデータがある
    { n: 5, name: '小林 陽太', role: R.base, avatar: 'avatar4', joined: -300, will: 'デザイン,SNS,Canva', judgment: 'Canva',
      dept: 'サンプル本部>デザイン', reportsTo: 3, mentor: 2, locale: 'ja', medium: true },
    // 06 一般・英語表示
    { n: 6, name: 'Emily Carter', display: 'Emily', role: R.base, joined: -200, will: 'リサーチ,ライティング,コミュニケーション', judgment: 'リサーチ,ライティング',
      dept: 'サンプル本部>リサーチ', reportsTo: 3, locale: 'en', timezone: 'America/Los_Angeles', medium: true },
    // 07 ほぼ空(新しく入ったばかりで、何も入力していない)
    { n: 7, name: '加藤 蓮', role: R.base, joined: -3, empty: true },
    // 08 休止中
    { n: 8, name: '吉田 美咲', role: R.base, joined: -900, will: 'イベント運営', judgment: 'イベント運営,コミュニケーション', inactive: true,
      dept: 'サンプル本部>イベント', lastLogin: -60 },
    // 09 とても長い名前(表示の崩れの確認)
    { n: 9, name: '長谷川 アレクサンドラ 由紀子 ヴィクトリア シャーロット', display: '長谷川アレクサンドラ由紀子ヴィクトリアシャーロット(広報・デザイン・イベント担当)',
      role: R.base, joined: -150, will: 'デザイン,広報,イベント運営,SNS,Canva,PowerPoint,ライティング', judgment: 'デザイン,広報,SNS',
      dept: 'サンプル本部>広報>SNS チーム>とても長い部署名のグループ', reportsTo: 4 },
    // 10 所属3日目(Will だけ入力済み)
    { n: 10, name: '山本 健', role: R.base, joined: -2, will: '実装,Claude', judgment: '' },
  ]
  var others = [
    ['佐々木 翔', '実装,要件定義', '実装,プロダクト設計,Claude', 'サンプル本部>開発'],
    ['山口 真央', 'リサーチ,企画', 'リサーチ', 'サンプル本部>リサーチ'],
    ['松本 拓海', 'イベント運営,メール', 'イベント運営', 'サンプル本部>イベント'],
    ['井上 楓', '広報,SNS,ライティング', 'SNS,広報', 'サンプル本部>広報'],
    ['木村 悠斗', 'デザイン,UI/UX', 'UI/UX,デザイン', 'サンプル本部>デザイン'],
    ['林 結衣', '企画,コミュニケーション', 'コミュニケーション', 'サンプル本部>運営'],
    ['清水 颯', '実装,V0,Claude', 'V0,実装', 'サンプル本部>開発'],
    ['森 美月', 'ライティング,校閲', '校閲,ライティング', 'サンプル本部>広報'],
    ['池田 陸', 'PowerPoint,企画', 'PowerPoint', 'サンプル本部>運営'],
    ['橋本 七海', 'リサーチ,データ分析', 'リサーチ,データ分析', 'サンプル本部>リサーチ'],
  ]
  others.forEach(function (o, i) {
    people.push({ n: 11 + i, name: o[0], role: R.base, joined: -60 - i * 45, will: o[1], judgment: o[2], dept: o[3], reportsTo: i % 2 ? 3 : 4 })
  })

  var id = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  var colors = ['#6366f1', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6', '#dc2626', '#16a34a']
  return people.map(function (p) {
    var skills = (p.will + ',' + p.judgment).split(',').filter(Boolean)
    var uniq = skills.filter(function (s, i) { return skills.indexOf(s) === i })
    var row = {
      id: id(p.n),
      name: p.name,
      display_name: p.display || '',
      role: p.role,
      notify_new_task: p.n <= 4 ? 'TRUE' : 'FALSE',
      avatar_url: p.avatar && files[p.avatar] ? files[p.avatar] : '',
      avatar_color: colors[p.n % colors.length],
      avatar_initials: '',
      will_tags: p.empty ? '' : p.will,
      judgment_tags: p.empty ? '' : p.judgment,
      reports_to_id: p.reportsTo ? id(p.reportsTo) : '',
      mentor_id: p.mentor ? id(p.mentor) : '',
      joined_at: d(p.joined),
      project_ids: (p.projects || []).map(function (x) { return SAMPLE_ID_PREFIX + 'p-' + samplePad_(x, 2) }).join(','),
      department_path: p.dept || '',
      inactive: p.inactive ? 'TRUE' : '',
      last_login: p.empty ? '' : sampleAt_(today, p.lastLogin != null ? p.lastLogin : -(p.n % 5), '09:30'),
      locale: p.locale || '',
      timezone: p.timezone || (p.empty ? '' : 'Asia/Tokyo'),
    }
    if (p.empty) return row
    // Fact(実績)とレベルの表示のため、スキルのレベル・ポイントは全員に少しずつ入れる
    row.skill_levels_json = sampleJson_(uniq.slice(0, 5).map(function (s, i) {
      return { skill: s, level: Math.max(1, Math.min(5, (p.rich ? 4 : 2) + (i % 2) - (i > 2 ? 1 : 0))), acquiredAt: d(p.joined + 30) }
    }))
    var points = {}
    uniq.forEach(function (s, i) { points[s] = (p.rich ? 320 : p.medium ? 140 : 60) - i * 20 })
    row.skill_points_json = sampleJson_(points)
    row.desired_areas = p.n % 3 === 0 ? '' : 'マネジメント,新規事業'
    row.desired_skills = p.n % 2 ? 'データ分析,UI/UX' : 'Claude'
    row.unavailable_dates = p.n % 4 === 0 ? [d(3), d(4), d(10)].join(',') : ''
    row.absent_dates = p.n % 5 === 0 ? [d(1), d(8)].join(',') : ''
    row.available_hours_json = p.n % 3 === 0 ? sampleJson_({ start: '10:00', end: '18:00' }) : ''
    row.has_management_experience = p.management ? 'TRUE' : ''
    row.university = p.locale === 'en' ? 'University of Washington' : p.n % 2 ? 'サンプル大学' : ''
    row.faculty = p.n % 2 ? '経済学部' : ''
    row.department_name = p.n % 2 ? '経営学科' : ''
    row.grade_year = p.n % 2 ? String(1 + (p.n % 4)) : ''
    row.custom_fields_json = sampleJson_({ sample_slack: '@' + ('member' + p.n), sample_shirt: p.n % 2 ? 'M' : 'L' })
    row.notify_settings = p.n === 5 ? sampleJson_({ new_task: 'immediate', review: '1d', mention: 'immediate', deadline: 'none' }) : ''
    if (p.rich || p.medium) {
      row.career_history_json = sampleJson_([
        { id: 'ch1', startDate: d(p.joined), affiliation: 'サンプル団体', role: p.role, description: '団体の運営全体を担当' },
        { id: 'ch2', startDate: d(p.joined - 700), endDate: d(p.joined - 1), affiliation: '前職の株式会社サンプル', role: 'マーケティング担当', description: 'Web 広告の運用と分析' },
      ])
      row.qualifications_json = sampleJson_([
        { id: 'q1', name: 'ITパスポート', acquiredDate: d(-400), issuer: 'IPA', relatedSkills: ['実装'], external: true },
        { id: 'q2', name: '社内デザイン検定 2級', acquiredDate: d(-100), relatedSkills: ['デザイン'] },
      ])
      row.evaluation_history_json = sampleJson_([
        { id: 'e1', date: d(-180), evaluatorId: id(1), rating: 'B', comment: '着実に成果を出している' },
        { id: 'e2', date: d(-30), evaluatorId: id(2), rating: 'A', comment: '周囲を巻き込んで大型イベントを成功させた。次期はリーダーを任せたい。' },
      ])
      row.transfer_history_json = sampleJson_([{ id: 't1', date: d(-200), fromAffiliation: '広報', toAffiliation: p.dept || '運営', reason: '本人の希望' }])
      row.competencies_json = sampleJson_([{ name: 'リーダーシップ', level: p.rich ? 4 : 2 }, { name: '問題解決', level: 3 }])
      row.career_aspiration = p.locale === 'en' ? 'I want to lead a research team and publish our findings.' : '将来は団体の運営を任される立場になりたい'
      row.desired_future_role = p.locale === 'en' ? 'Research Lead' : '事業責任者'
      row.career_plan = p.locale === 'en' ? 'Year 1: learn the basics. Year 2: run small projects. Year 3: lead the research team.' : '1年目: 基礎を学ぶ / 2年目: 小さなプロジェクトを回す / 3年目: 班をまとめる'
      row.training_history_json = sampleJson_([
        { id: 'tr1', name: 'リーダー研修', date: d(-90), provider: 'サンプル研修会社', status: 'approved', attendanceStatus: 'attended' },
        { id: 'tr2', name: 'デザイン思考ワークショップ', date: d(20), status: 'pending' },
        { id: 'tr3', name: '会計の基礎', date: d(-10), status: 'rejected' },
      ])
      row.development_plan_json = sampleJson_([
        { id: 'dp1', goal: 'イベントを1人で企画・運営できるようになる', targetDate: d(90), status: 'in_progress' },
        { id: 'dp2', goal: 'デザイン検定2級に合格する', targetDate: d(-5), status: 'done' },
        { id: 'dp3', goal: '後輩のメンターを務める', targetDate: d(180), status: 'not_started' },
      ])
      row.one_on_ones_json = sampleJson_([
        { id: 'o1', date: d(-35), withId: id(p.reportsTo || 2), notes: '最近の困りごと: 作業の優先順位が分からない → 週初めに一緒に整理する' },
        { id: 'o2', date: d(-7), withId: id(p.reportsTo || 2), notes: '先月の目標はおおむね達成。次はイベントの企画に挑戦したい。' },
      ])
      row.survey_responses_json = sampleJson_([
        { id: 'sr1', submittedAt: sampleAt_(today, -20, '20:00'), answers: { 'sample-sq-1': 4, 'sample-sq-2': 3, 'sample-sq-3': '連絡の手段が多くて迷うことがある' } },
      ])
      row.permission_overrides_json = p.n === 5 ? sampleJson_([{ targetType: 'project', targetId: SAMPLE_ID_PREFIX + 'p-02', access: 'view' }]) : ''
    }
    return row
  })
}

// ---- プロジェクト ----

function buildSampleProjects_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var P = function (n) { return SAMPLE_ID_PREFIX + 'p-' + samplePad_(n, 2) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  return [
    { id: P(1), name: '団体運営', description: '日々の運営業務(会計・連絡・定例)', type: '運営', owner_id: M(1), member_ids: [M(1), M(2), M(16), M(19)].join(','),
      goal: '運営の仕組みを整え、1人に負担が偏らないようにする', start_date: d(-400), archived: 'FALSE' },
    { id: P(2), name: '秋のイベント 2026', description: '学外向けの大型イベント。来場者300人を目標に準備する。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(5), M(8), M(13), M(9)].join(','), goal: '来場者300人・満足度4以上', start_date: d(-45), end_date: d(40), archived: 'FALSE' },
    // 親子関係(秋のイベントの子プロジェクト)
    { id: P(3), name: '秋のイベント 2026 / 広報チーム', description: 'SNS とポスターでの告知', type: 'イベント', parent_id: P(2), owner_id: M(3),
      member_ids: [M(3), M(9), M(14)].join(','), start_date: d(-30), end_date: d(35), archived: 'FALSE' },
    { id: P(4), name: 'Webサイトのリニューアル', description: '団体の Web サイトを作り直す。期限が迫っているが、作業が遅れている。', type: '開発', owner_id: M(4),
      member_ids: [M(4), M(11), M(15), M(17)].join(','), goal: '来月末に公開する', start_date: d(-90), end_date: d(-3), archived: 'FALSE',
      health_override: '' },
    { id: P(5), name: '新歓 2027', description: '来月から始まる新入生の勧誘の準備', type: 'イベント', owner_id: M(2), member_ids: [M(2), M(12), M(20)].join(','),
      start_date: d(35), end_date: d(120), archived: 'FALSE' },
    { id: P(6), name: 'Community Research', description: 'Interview members of partner organizations and summarize what they need from us. The report will be shared at the general meeting.',
      type: 'Research', owner_id: M(6), member_ids: [M(6), M(12), M(20)].join(','), goal: 'Publish the research report by the end of next month',
      start_date: d(-20), end_date: d(45), archived: 'FALSE', health_override: 'watch' },
    { id: P(7), name: '春のイベント 2026(終了)', description: '終了したイベント。記録のために残している。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(8), M(13)].join(','), start_date: d(-200), end_date: d(-120), archived: 'TRUE' },
    { id: P(8), name: 'とても長い名前のプロジェクト:地域の子ども向けプログラミング教室と保護者向け説明会の合同開催(2026年度・第3期)',
      description: 'プロジェクト名や説明が長い場合の表示を確かめるためのプロジェクト。' + new Array(15).join('説明の文章がとても長く続く場合でも、画面が崩れないことを確かめます。'),
      type: '教育', owner_id: M(9), member_ids: [M(9), M(11), M(17)].join(','), start_date: d(-10), end_date: d(80), archived: 'FALSE' },
  ]
}

// ---- タスク ----

// 変更の記録(今の形式: ステータスは日本語の表示名)
function sampleHistory_(today, byId, entries) {
  return entries.map(function (e, i) {
    return { id: 'h' + (i + 1), at: sampleAt_(today, e[0], '11:00'), byId: byId, field: e[1], from: e[2], to: e[3] }
  })
}

function buildSampleTasks_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var at = function (n, t) { return sampleAt_(today, n, t) }
  var P = function (n) { return SAMPLE_ID_PREFIX + 'p-' + samplePad_(n, 2) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  var tasks = []
  var seq = 0
  var add = function (t) {
    seq++
    var row = {
      id: SAMPLE_ID_PREFIX + 't-' + samplePad_(seq, 3),
      project_id: P(1), title: '', description: '', status: '未着手', assign_type: 'open_bid', assignee_id: '',
      creator_id: M(1), created_at: d(-10), start_date: '', due_date: '', due_time: '', visibility: '全員', department: '運営',
      category: '企画', skills: '', difficulty: '新人歓迎', priority: '中', last_activity: d(-1), original_input_id: '',
      approval_status: '承認済み', estimated_hours: '', importance: '一般',
    }
    Object.keys(t).forEach(function (k) { row[k] = t[k] })
    tasks.push(row)
    return row.id
  }

  // -- 期限・状態の典型例(実行した日を基準にする) --
  add({ title: '会計報告書の提出', project_id: P(1), status: '進行中', assignee_id: M(16), due_date: d(-5), priority: '高', skills: '企画',
    description: '期限を過ぎているタスク。', history_json: sampleJson_(sampleHistory_(today, M(1), [[-12, 'status', '未着手', '進行中']])) })
  add({ title: 'ポスターのデザイン案を3つ作る', project_id: P(3), department: 'デザイン', category: 'デザイン', status: '進行中', assignee_id: M(5), start_date: d(-4),
    due_date: d(2), priority: '高', skills: 'デザイン,Canva', difficulty: '少し経験必要', progress_percent: '60', progress_note: '2案できた。3案目を作成中。',
    progress_history_json: sampleJson_([{ id: 'pg1', text: '1案目を共有しました', at: at(-3), byId: M(5) }, { id: 'pg2', text: '2案目を共有しました', at: at(-1), byId: M(5) }]) })
  add({ title: '当日の受付マニュアルを作る', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', assignee_id: M(13), due_date: d(0),
    due_time: '18:00', skills: 'イベント運営,ライティング', description: '今日が締切(時刻つき)。' })
  add({ title: '新歓チラシの原稿', project_id: P(5), department: '広報', category: 'ライティング', status: '未着手', assignee_id: M(14), start_date: d(35),
    due_date: d(50), skills: 'ライティング,広報', description: '来月から始まるタスク。' })
  var doneRecent = add({ title: '会場の予約', project_id: P(2), department: 'イベント', category: 'イベント', status: '完了', assignee_id: M(3), due_date: d(-6),
    completed_date: d(-3), skills: 'イベント運営,メール', estimated_hours: '3', actual_hours: '4.5', awarded_points_json: sampleJson_({ 'イベント運営': 30 }),
    retrospective_json: sampleJson_({ good: '早めに候補を3つ押さえられた', bad: '見積もりの比較に時間がかかった', improve: '次回は比較表のひな形を使う' }),
    deliverables_json: sampleJson_([{ id: 'dl1', label: '予約確認メール', url: 'https://example.com/booking' }, { id: 'dl2', label: '会場の図面', url: 'https://example.com/floor' }]) })
  add({ title: '春のイベントのアンケート集計', project_id: P(7), department: 'リサーチ', category: 'リサーチ', status: '完了', assignee_id: M(12), due_date: d(-130),
    completed_date: d(-125), skills: 'リサーチ,データ分析', description: '完了から日が経ち、アーカイブに入るタスク。', awarded_points_json: sampleJson_({ 'リサーチ': 40 }),
    retrospective_json: sampleJson_({ good: '回収率が高かった', bad: '自由記述の集計に手間取った', improve: '選択式の設問を増やす' }) })
  add({ title: '過去の議事録の整理', project_id: P(1), status: '完了', assignee_id: M(19), due_date: d(-25), completed_date: d(-20), skills: '企画', description: '完了から14日を過ぎたタスク(アーカイブ)。' })

  // -- 公募 --
  add({ title: '当日のカメラマン(公募)', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', due_date: d(30), skills: 'デザイン',
    difficulty: '誰でも可', open_bid_applicant_ids: [M(5), M(15)].join(','), description: '応募者が2人いる公募のタスク。' })
  add({ title: 'SNS 投稿の文章チェック(公募)', project_id: P(3), department: '広報', category: '広報', status: '未着手', due_date: d(12), skills: '校閲,SNS', difficulty: '新人歓迎' })

  // -- 承認待ち(一般のメンバーが登録したもの。重要度ごと) --
  add({ title: '備品の購入(承認待ち)', project_id: P(2), creator_id: M(5), approval_status: '承認待ち', assignee_id: M(5), due_date: d(9), category: '物品調達' })
  add({ title: 'スポンサーへの依頼文(重要・承認待ち)', project_id: P(2), creator_id: M(13), approval_status: '承認待ち', importance: '重要', department: '渉外',
    category: '渉外', due_date: d(7), skills: 'ライティング,コミュニケーション' })
  add({ title: 'プレスリリースの公開(対外公開・承認待ち)', project_id: P(3), creator_id: M(14), approval_status: '承認待ち', importance: '対外公開', department: '広報',
    category: '広報', due_date: d(14), skills: '広報,ライティング' })

  // -- 幹部限定 --
  add({ title: '来年度の予算案(幹部限定)', project_id: P(1), visibility: '幹部', status: '進行中', assignee_id: [M(1), M(2)].join(','), due_date: d(20), priority: '高',
    description: '幹部だけが見られるタスク。一般のメンバーには表示されない。' })

  // -- 確認(複数の確認者・確認タスク) --
  var reviewed = add({ title: 'Web サイトのトップページ', project_id: P(4), department: '開発', category: '開発', status: '確認待ち', assignee_id: M(15), due_date: d(1),
    skills: 'UI/UX,実装', reviewer_ids: [M(2), M(4)].join(','), reviewer_id: M(2), required_approvals: 'all',
    review_approvals_json: sampleJson_([{ memberId: M(4), at: at(-1), comment: 'レイアウトは問題なし。画像の差し替えだけお願いします。' }]),
    history_json: sampleJson_(sampleHistory_(today, M(15), [[-8, 'status', '未着手', '進行中'], [-1, 'status', '進行中', '確認待ち']])) })
  add({ title: '「Web サイトのトップページ」の確認', project_id: P(4), department: '開発', category: '開発', status: '未着手', assignee_id: M(2), due_date: d(2),
    related_review_task_id: reviewed, creator_id: M(15) })
  add({ title: 'お知らせページの文章', project_id: P(4), department: '広報', category: 'ライティング', status: '修正中', assignee_id: M(18), due_date: d(4), reviewer_id: M(4),
    reviewer_ids: M(4), required_approvals: '1', skills: 'ライティング,校閲',
    history_json: sampleJson_(sampleHistory_(today, M(4), [[-6, 'status', '進行中', '確認待ち'], [-2, 'status', '確認待ち', '修正中']])) })

  // -- 依存関係 --
  var dep1 = add({ title: 'サイトの構成を決める', project_id: P(4), department: '開発', category: '開発', status: '完了', assignee_id: M(11), due_date: d(-20), completed_date: d(-18),
    skills: '要件定義,プロダクト設計', awarded_points_json: sampleJson_({ '要件定義': 25 }) })
  var dep2 = add({ title: 'デザインのカンプ', project_id: P(4), department: 'デザイン', category: 'デザイン', status: '進行中', assignee_id: M(15), due_date: d(-2),
    skills: 'デザイン,UI/UX', depends_on_ids: dep1, blocker_note: '素材の写真がまだ届いていない', blocker_since: d(-4), priority: '高' })
  add({ title: 'サイトの実装', project_id: P(4), department: '開発', category: '開発', status: '未着手', assignee_id: [M(11), M(17)].join(','), due_date: d(10),
    skills: '実装,V0', depends_on_ids: [dep1, dep2].join(','), difficulty: '経験者向け', required_skill_levels_json: sampleJson_({ '実装': 4, 'UI/UX': 3 }) })

  // -- サポート必要・保留 --
  add({ title: '協賛企業のリストアップ', project_id: P(2), department: '渉外', category: '渉外', status: 'サポート必要', assignee_id: M(10), due_date: d(6),
    blocker_note: '何から手を付ければよいか分からない', blocker_since: d(-2), difficulty: '新人歓迎' })
  add({ title: 'ノベルティの発注', project_id: P(2), department: 'イベント', category: '物品調達', status: '保留', assignee_id: M(8), due_date: d(25),
    hold_reason_note: '予算が確定するまで保留', hold_reason_since: d(-7) })

  // -- 日程調整・フォーム --
  add({ title: '打ち上げの日程調整', project_id: P(2), department: 'イベント', category: 'イベント', status: '進行中', assignee_id: M(3), due_date: d(5),
    schedule_json: sampleJson_({
      candidates: [
        { id: 'c1', label: d(12) + ' 18:00-20:00', date: d(12), startTime: '18:00', endTime: '20:00' },
        { id: 'c2', label: d(13) + ' 19:00-21:00', date: d(13), startTime: '19:00', endTime: '21:00' },
        { id: 'c3', label: '週末のどこか(自由記述の候補)' },
      ],
      invitedIds: [M(3), M(5), M(13), M(9)],
      responses: { 'sample-m-03': { c1: '○', c2: '△', c3: '×' }, 'sample-m-05': { c1: '○', c2: '○', c3: '△' } },
    }) })
  add({ title: 'Tシャツのサイズ調査', project_id: P(2), department: 'イベント', category: 'イベント', status: '進行中', assignee_id: M(13), due_date: d(8),
    form_json: sampleJson_({
      fields: [
        { id: 'f1', label: 'サイズ', type: 'select', options: ['S', 'M', 'L', 'XL'], required: true },
        { id: 'f2', label: '色の希望', type: 'checkbox', options: ['白', '黒', '紺'] },
        { id: 'f3', label: '備考', type: 'textarea' },
      ],
      invitedIds: [M(5), M(9), M(13), M(14)],
      responses: { 'sample-m-05': { f1: 'M', f2: ['白', '紺'], f3: '' }, 'sample-m-14': { f1: 'L', f2: ['黒'], f3: '当日は遅れて参加します' } },
    }) })

  // -- 表示の崩れの確認(極端な例) --
  add({ title: 'とても長いタスク名の例:来場者アンケートの設問の見直しと、回答しやすい順番への並べ替え、および前回の自由記述の回答をもとにした選択肢の追加(第2版)',
    project_id: P(8), department: 'リサーチ', category: 'リサーチ', status: '進行中', assignee_id: M(9), due_date: d(15), skills: 'リサーチ,企画,ライティング,データ分析',
    description: new Array(40).join('説明がとても長い場合の表示を確かめるための文章です。改行が無く続く場合と、\n改行を含む場合の両方を確かめます。') })
  var comments = []
  for (var c = 0; c < 150; c++) {
    var by = M(1 + (c % 9))
    var mention = c % 10 === 0 ? ' @渡辺 大輔 確認をお願いします' : ''
    comments.push({ id: 'cm' + c, byId: by, at: at(-20 + Math.floor(c / 8), (9 + (c % 10)) + ':' + samplePad_((c * 7) % 60, 2)),
      text: 'コメント ' + (c + 1) + ' 件目。進み具合の共有です。' + mention, mentionedIds: mention ? [M(3)] : undefined })
  }
  add({ title: 'コメントがとても多いタスク(150件)', project_id: P(2), status: '進行中', assignee_id: M(3), due_date: d(18), comments_json: sampleJson_(comments) })
  add({ title: '担当者が多いタスク(12人)', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', due_date: d(30),
    assignee_id: [2, 3, 5, 9, 11, 12, 13, 14, 15, 16, 17, 18].map(M).join(','), skills: 'イベント運営' })

  // -- 英語表示の人が担当するタスク(英語の文章) --
  add({ title: 'Interview five partner organizations', project_id: P(6), department: 'リサーチ', category: 'リサーチ', status: '進行中', assignee_id: M(6), due_date: d(9),
    skills: 'リサーチ,コミュニケーション', description: 'Schedule 30-minute interviews, record the key points, and share a short summary in the comments after each interview.',
    comments_json: sampleJson_([{ id: 'en1', byId: M(12), at: at(-2), text: 'I can join the interview on Thursday if you need a note-taker.' },
      { id: 'en2', byId: M(6), at: at(-1), text: 'Thanks! That would be really helpful.' }]) })
  add({ title: 'Draft the research report (very long English title to check how the layout wraps across several lines)', project_id: P(6), department: 'リサーチ',
    category: 'ライティング', status: '未着手', assignee_id: M(6), start_date: d(10), due_date: d(40), skills: 'ライティング,リサーチ', difficulty: '経験者向け',
    description: 'Summarize the interviews into a report with three sections: background, findings, and recommendations. Keep it under ten pages.' })
  add({ title: 'Translate the survey into Japanese', project_id: P(6), department: 'リサーチ', category: 'ライティング', status: '完了', assignee_id: M(6), due_date: d(-8),
    completed_date: d(-6), skills: 'ライティング', awarded_points_json: sampleJson_({ 'ライティング': 20 }),
    retrospective_json: sampleJson_({ good: 'Finished two days early', bad: 'Some terms were hard to translate', improve: 'Keep a glossary for next time' }) })

  // -- 定期タスクから作られたように見えるタスク(定期タスクのルールは停止中) --
  for (var w = 3; w >= 0; w--) {
    add({ title: '週次定例の議事録', project_id: P(1), category: '企画', skills: 'ライティング', creator_id: '', assignee_id: M(19),
      created_at: d(-7 * w), due_date: d(-7 * w + 2), status: w === 0 ? '未着手' : '完了', completed_date: w === 0 ? '' : d(-7 * w + 1), difficulty: '誰でも可' })
  }

  // -- 普通のタスク(推薦・集計・一覧の件数のため。スキルは担当者の Will・Judgment と合わせる) --
  var rng = makePerfRandom_(20261001)
  // テスト用のアカウントの枠のメンバー(1・2・3・5)にも、自分のタスクの画面で確かめられるよう割り当てる
  var regularMembers = [5, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 1, 2, 3, 5]
  var skillOf = { 1: '企画,リサーチ', 2: 'デザイン,UI/UX', 3: 'イベント運営,メール', 5: 'デザイン,Canva', 9: '広報,SNS', 11: '実装,要件定義', 12: 'リサーチ,データ分析', 13: 'イベント運営,メール', 14: 'SNS,広報',
    15: 'UI/UX,デザイン', 16: '企画,コミュニケーション', 17: '実装,V0', 18: 'ライティング,校閲', 19: 'PowerPoint,企画', 20: 'リサーチ,データ分析' }
  var deptOf = { 'デザイン': 'デザイン', '広報': '広報', 'SNS': '広報', '実装': '開発', 'UI/UX': 'デザイン', 'リサーチ': 'リサーチ', 'イベント運営': 'イベント',
    '企画': '運営', 'ライティング': '広報', 'PowerPoint': '運営', '校閲': '広報' }
  var verbs = ['資料の作成', '進め方の相談', '候補の洗い出し', '見積もりの確認', '下書きの作成', '関係者への連絡', '結果のまとめ', 'チェックリストの更新']
  var statuses = ['未着手', '未着手', '進行中', '進行中', '進行中', '確認待ち', '完了', '完了', '完了', '保留']
  var activeProjects = [1, 2, 3, 4, 5, 8]
  for (var i = 0; i < 115; i++) {
    var mNo = regularMembers[i % regularMembers.length]
    var skills = skillOf[mNo]
    var status = rng.pick(statuses)
    var project = activeProjects[i % activeProjects.length]
    var done = status === '完了'
    // 終わっていないタスクの期限は、多くを先の日付にする(期限切れは1割ほど)
    var due = done ? rng.int(-60, -2) : rng.chance(0.12) ? rng.int(-15, -1) : rng.int(1, 45)
    var startOffset = due - rng.int(3, 25)
    var completed = done ? Math.min(-1, due - rng.int(0, 5)) : null
    add({
      title: skills.split(',')[0] + 'の' + verbs[i % verbs.length] + '(' + (i + 1) + ')',
      project_id: P(project), department: deptOf[skills.split(',')[0]] || '運営', category: rng.pick(['企画', 'デザイン', '広報', 'リサーチ', 'イベント', '開発']),
      status: status, assignee_id: rng.chance(0.15) ? '' : M(mNo), creator_id: M(rng.pick([1, 2, 3, 4])), created_at: d(startOffset - 3),
      start_date: d(startOffset), due_date: d(due), completed_date: done ? d(completed) : '', skills: skills,
      difficulty: rng.pick(['誰でも可', '新人歓迎', '少し経験必要', '経験者向け', '上級者向け']), priority: rng.pick(['高', '中', '中', '低']),
      estimated_hours: String(rng.int(1, 8)), actual_hours: done ? String(rng.int(1, 10)) : '',
      awarded_points_json: done ? sampleJson_(JSON.parse('{"' + skills.split(',')[0] + '":' + (10 + rng.int(0, 30)) + '}')) : '',
      progress_percent: done ? '100' : String(rng.int(0, 90)),
      hold_reason_note: status === '保留' ? '他のタスクの結果待ち' : '', hold_reason_since: status === '保留' ? d(-rng.int(1, 10)) : '',
      last_activity: d(done ? completed : -rng.int(0, 20)),
      history_json: rng.chance(0.4) ? sampleJson_(sampleHistory_(today, M(mNo), [[startOffset, 'status', '未着手', '進行中']])) : '',
    })
  }
  return tasks
}

// ---- 経費・フォーム・日報・採用 ----

function buildSampleOtherSheets_(today, files) {
  var d = function (n) { return sampleDay_(today, n) }
  var at = function (n, t) { return sampleAt_(today, n, t) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  var S = SAMPLE_ID_PREFIX
  var steps = [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }]
  var expense = function (n, o) {
    return {
      id: S + 'exp-' + samplePad_(n, 2), applicant_id: o.by, amount: String(o.amount), category_id: o.cat || S + 'expcat-transport',
      receipt_url: o.receipt || '', justification: o.justification || '', purpose: o.purpose, custom_field_answers_json: sampleJson_(o.custom || {}),
      approval_steps_json: sampleJson_(steps), approvals_json: sampleJson_(o.approvals || []), current_step_index: String(o.step || 0),
      status: o.status, created_at: at(o.day, '12:00'), rejection_reason: o.reason || '',
    }
  }
  var approved = function (stepId, by, day) { return { stepId: stepId, memberId: by, at: at(day, '15:00'), action: 'approved' } }
  var Expenses = [
    expense(1, { by: M(5), amount: 1280, purpose: 'ポスター印刷用の紙', status: 'pending', day: -1, receipt: files.receipt_png, custom: { destination: '文具店' } }),
    expense(2, { by: M(6), amount: 3400, purpose: 'Transportation to the partner interview', status: 'pending', step: 1, day: -4, receipt: files.receipt_pdf,
      approvals: [approved('s1', M(3), -3)], custom: { destination: 'Shibuya' } }),
    expense(3, { by: M(13), amount: 15800, purpose: '会場の下見の交通費', status: 'approved', step: 2, day: -20, receipt: files.receipt_png,
      approvals: [approved('s1', M(3), -19), approved('s2', M(1), -18)] }),
    expense(4, { by: M(9), amount: 52000, cat: S + 'expcat-goods', purpose: 'カメラの購入', justification: 'イベントの撮影に使うため', status: 'rejected', day: -15,
      approvals: [{ stepId: 's1', memberId: M(3), at: at(-14, '10:00'), action: 'rejected', comment: 'レンタルで足りるため' }], reason: 'レンタルで足りるため' }),
    expense(5, { by: M(14), amount: 2200, purpose: '打ち合わせの飲み物代', status: 'returned', day: -6, reason: '領収書の画像を添付してください' }),
    expense(6, { by: M(5), amount: 800, purpose: '(取り下げ)重複して申請したもの', status: 'withdrawn', day: -9 }),
    expense(7, { by: M(9), amount: 1234567, cat: S + 'expcat-goods', status: 'pending', day: -2, receipt: files.receipt_png,
      purpose: '金額と説明がとても長い場合の表示の確認:' + new Array(8).join('音響機材・照明機材・ステージの設営一式のレンタルと運搬費用。'), justification: new Array(6).join('大型イベントのため、例年より規模が大きい。') }),
  ]
  var formSteps = [{ id: 'fs1', type: 'role', role: SAMPLE_ROLES.admin }]
  var submission = function (n, o) {
    return {
      id: S + 'fsub-' + samplePad_(n, 2), form_id: S + 'form-equipment', submitter_id: o.by, answers_json: sampleJson_(o.answers),
      approvals_json: sampleJson_(o.approvals || []), current_step_index: String(o.step || 0), status: o.status, created_at: at(o.day, '13:00'),
      rejection_reason: o.reason || '',
    }
  }
  var FormSubmissions = [
    submission(1, { by: M(5), answers: { item: 'プロジェクター', from: d(10), qty: 1 }, status: 'pending', day: -1 }),
    submission(2, { by: M(13), answers: { item: '延長コード', from: d(-5), qty: 3 }, status: 'approved', step: 1, day: -8,
      approvals: [{ stepId: 'fs1', memberId: M(2), at: at(-7, '10:00'), action: 'approved' }] }),
    submission(3, { by: M(6), answers: { item: 'Camera tripod', from: d(3), qty: 2 }, status: 'rejected', day: -3,
      approvals: [{ stepId: 'fs1', memberId: M(2), at: at(-2, '10:00'), action: 'rejected', comment: '同じ日に別の予約があるため' }], reason: '同じ日に別の予約があるため' }),
  ]
  var DailyReports = []
  var reporters = [[5, 'ja'], [6, 'en'], [11, 'ja'], [13, 'ja']]
  reporters.forEach(function (r) {
    for (var day = -9; day <= 0; day++) {
      if ((day + r[0]) % 3 === 0) continue
      var en = r[1] === 'en'
      DailyReports.push({
        id: S + 'dr-' + samplePad_(r[0], 2) + '-' + samplePad_(-day, 2), member_id: M(r[0]), type: 'daily', report_date: d(day),
        done_text: en ? 'Finished the interview notes for two organizations.' : '担当のタスクを進めました。資料を半分まで作成。',
        todo_text: en ? 'Start drafting the summary.' : '明日は資料の残りを仕上げる。',
        issues_text: day % 4 === 0 ? (en ? 'Waiting for a reply from one partner.' : '先方からの返事待ちで止まっている作業がある。') : '',
        created_at: at(day, '21:00'),
      })
    }
    DailyReports.push({ id: S + 'dr-' + samplePad_(r[0], 2) + '-w', member_id: M(r[0]), type: 'weekly', report_date: d(-7),
      done_text: r[1] === 'en' ? 'Completed three interviews this week.' : '今週はタスクを3件完了しました。', todo_text: r[1] === 'en' ? 'Two more interviews next week.' : '来週はイベントの準備に集中する。',
      issues_text: '', created_at: at(-7, '20:00') })
  })
  var Candidates = [
    { id: S + 'c-01', name: '候補 一郎', email: '', phone: '', resume_text: '大学2年。イベント運営に興味がある。', interview_notes: '明るく話しやすい。', status: 'candidate', created_at: at(-5), updated_at: at(-2) },
    { id: S + 'c-02', name: '候補 花子', resume_text: 'デザインの経験あり(ポートフォリオあり)。', interview_notes: '次回は実技の課題を出す。', status: 'candidate', created_at: at(-12), updated_at: at(-4) },
    { id: S + 'c-03', name: '候補 次郎', resume_text: '', interview_notes: '日程が合わず辞退。', status: 'rejected', created_at: at(-40), updated_at: at(-30) },
    { id: S + 'c-04', name: '候補 三郎', resume_text: '大学1年。', interview_notes: '入会が決まった。', status: 'hired', created_at: at(-60), updated_at: at(-50) },
    { id: S + 'c-05', name: 'とても長い名前の候補者 ジョナサン・アレクサンダー・ウィリアムズ 三世', resume_text: new Array(20).join('自己紹介の文章がとても長い場合。'),
      interview_notes: new Array(10).join('面接のメモがとても長い場合。'), status: 'candidate', created_at: at(-3), updated_at: at(-1) },
  ]
  return { Expenses: Expenses, FormSubmissions: FormSubmissions, DailyReports: DailyReports, Candidates: Candidates }
}

// ---- Settings に足すもの ----
//   lists  カンマ区切りの一覧に足す値(既にある値は足さない)
//   items  id を持つ配列に足す要素(id は 'sample-' で始める)
//   values 文字列の配列に足す値
//   maps   キーで引く設定に足すキー(既にあるキーは変えない)
//   scalars 値が1つの設定(元の値を退避してから書き、削除の時に戻す)
function buildSampleSettings_(today, files) {
  var d = function (n) { return sampleDay_(today, n) }
  var S = SAMPLE_ID_PREFIX
  var M = function (n) { return S + 'm-' + samplePad_(n, 2) }
  var tpl = function (id, name, dept, cat, skills, diff, prio, dependsOn) {
    return { id: id, name: name, department: dept, category: cat, skills: skills, difficulty: diff, priority: prio, dependsOn: dependsOn || [] }
  }
  return {
    lists: {
      skill_options: ['データ分析'],
      category_options: ['定例'],
      skill_field_options: ['分析'],
      role_levels: [SAMPLE_ROLES.admin, SAMPLE_ROLES.restricted],
      restricted_roles: [SAMPLE_ROLES.restricted],
    },
    items: {
      task_set_templates: [{ id: S + 'tst-event', name: 'イベント開催(サンプル)', description: 'イベントを開く時の定番のタスク一式',
        items: [tpl('a', '会場の予約', 'イベント', 'イベント', ['イベント運営'], '新人歓迎', '高'), tpl('b', '告知ポスター', 'デザイン', 'デザイン', ['デザイン', 'Canva'], '少し経験必要', '中', ['a']),
          tpl('c', '当日の運営マニュアル', 'イベント', 'イベント', ['ライティング'], '新人歓迎', '中', ['a'])] }],
      recurring_rules: [
        { id: S + 'rr-weekly', name: '週次定例の議事録', projectId: S + 'p-01', department: '運営', category: '企画', skills: ['ライティング'], difficulty: '誰でも可',
          priority: '中', frequency: 'weekly', dayOfWeek: 1, dueInDays: 2, active: false, lastGeneratedDate: d(0), skipDates: [d(14)] },
        { id: S + 'rr-monthly', name: '月次の会計チェック', projectId: S + 'p-01', department: '運営', category: '企画', skills: ['企画'], difficulty: '少し経験必要',
          priority: '高', frequency: 'monthly', dayOfMonth: 25, dueInDays: 5, active: false },
      ],
      quiz_definitions: [{ id: S + 'quiz-design', title: 'デザインの基礎(サンプル)', targetSkill: 'デザイン', targetLevel: 3, passRate: 70, questions: [
        { id: 'q1', text: '余白を広く取る主な目的は?', choices: ['読みやすくするため', '印刷代を節約するため', '文字を小さくするため'], correctIndex: 0 },
        { id: 'q2', text: '1つのポスターで使う書体の数は?', choices: ['できるだけ多く', '2〜3種類まで', '10種類以上'], correctIndex: 1 },
      ] }],
      learning_contents: [
        { id: S + 'lc-1', title: 'Canva の使い方(動画)', url: 'https://www.example.com/canva', contentType: 'video', relatedSkill: 'Canva', relatedQuizId: S + 'quiz-design', createdAt: d(-30) },
        { id: S + 'lc-2', title: 'イベント運営マニュアル', description: '会場の予約から撤収までの手順', url: 'https://www.example.com/manual', contentType: 'manual', relatedSkill: 'イベント運営', createdAt: d(-20) },
        { id: S + 'lc-3', title: 'How to run a user interview', url: 'https://www.example.com/interview', contentType: 'link', relatedSkill: 'リサーチ', createdAt: d(-10) },
      ],
      learning_courses: [{ id: S + 'course-new', title: '新入生向けコース(サンプル)', description: '入ったばかりの人が最初に見る資料', contentIds: [S + 'lc-2', S + 'lc-1'], relatedQuizId: S + 'quiz-design' }],
      training_programs: [
        { id: S + 'tp-leader', name: 'リーダー研修', description: '班をまとめる人向け', targetSegments: ['管理職候補'] },
        { id: S + 'tp-basic', name: '新人研修', targetSegments: ['新人'] },
      ],
      survey_questions: [
        { id: S + 'sq-1', text: '今の活動に満足していますか?', type: 'scale', scaleMinLabel: '不満', scaleMaxLabel: '満足', imageUrl: files.survey_image || undefined },
        { id: S + 'sq-2', text: '自分の成長を感じますか?', type: 'scale', scaleMinLabel: '感じない', scaleMaxLabel: '感じる' },
        { id: S + 'sq-3', text: '困っていることがあれば教えてください', type: 'text' },
      ],
      custom_form_defs: [{ id: S + 'form-equipment', title: '備品の貸し出し申請(サンプル)', description: '団体の備品を借りる時に使います',
        fields: [{ id: 'item', label: '借りるもの', type: 'text', required: true }, { id: 'from', label: '借りる日', type: 'date', required: true },
          { id: 'qty', label: '数', type: 'number', required: true }], approvalSteps: [{ id: 'fs1', type: 'role', role: SAMPLE_ROLES.admin }] }],
      expense_categories: [
        { id: S + 'expcat-transport', label: '交通費(サンプル)', approvalSteps: [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }],
          customFields: [{ key: 'destination', label: '行き先', type: 'text' }] },
        { id: S + 'expcat-goods', label: '物品購入(サンプル)', approvalSteps: [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }] },
      ],
      custom_member_columns_json: [{ key: 'sample_slack', label: 'Slack の名前(サンプル)', type: 'text' }, { key: 'sample_shirt', label: 'Tシャツのサイズ(サンプル)', type: 'text' }],
    },
    // id を持たない配列: 足した値だけを消す
    values: {
      one_on_one_questions: ['(サンプル)最近うれしかったことは?', '(サンプル)手伝ってほしいことは?'],
      radar_axes: [{ skill: 'データ分析', label: 'データ分析(サンプル)' }],
      department_tree_config: [{ path: 'サンプル本部' }, { path: 'サンプル本部>イベント' }, { path: 'サンプル本部>広報>SNS チーム' }],
    },
    maps: {
      project_templates: { 'サンプル: イベント': [tpl('a', '会場の予約', 'イベント', 'イベント', ['イベント運営'], '新人歓迎', '高'), tpl('b', '振り返り会', 'イベント', 'イベント', ['企画'], '誰でも可', '低', ['a'])] },
      role_permissions: (function () { var o = {}; o[SAMPLE_ROLES.restricted] = ['dashboard', 'assignments', 'approvals', 'projects', 'dailyReports']; return o })(),
      job_requirements: (function () { var o = {}; o[SAMPLE_ROLES.restricted] = ['イベント運営', 'コミュニケーション']; return o })(),
      skill_field_skills: { '分析': ['データ分析', 'リサーチ'] },
      skill_level_thresholds: { 'データ分析': 150 },
    },
    scalars: {
      org_name: 'サンプル団体',
      org_logo_url: files.org_logo || '',
      theme_color: '#6366f1',
    },
  }
}

// アップロード用フォルダに作るダミー画像(ファイル名の先頭は、画面が種類を見分けるのに使う)
function sampleFileSpecs_() {
  return [
    { key: 'avatar1', name: 'avatar_sample-m-01_', png: 'avatar1', url: 'image' },
    { key: 'avatar2', name: 'avatar_sample-m-02_', png: 'avatar2', url: 'image' },
    { key: 'avatar3', name: 'avatar_sample-m-03_', png: 'avatar3', url: 'image' },
    { key: 'avatar4', name: 'avatar_sample-m-05_', png: 'avatar4', url: 'image' },
    { key: 'org_logo', name: 'org_logo_sample_', png: 'logo', url: 'image' },
    { key: 'survey_image', name: 'survey_image_sample_', png: 'survey', url: 'image512' },
    { key: 'receipt_png', name: 'expense_receipt_sample_png_', png: 'receipt', url: 'file' },
    { key: 'receipt_pdf', name: 'expense_receipt_sample_pdf_', pdf: true, url: 'file' },
  ]
}

// サンプルのデータ一式を作る(Google のサービスを使わない純粋な関数)。
// today は 'YYYY-MM-DD'(スクリプトのタイムゾーンの今日)、files はダミー画像の URL
function buildSampleData_(today, files) {
  files = files || {}
  var other = buildSampleOtherSheets_(today, files)
  return {
    sheets: {
      Members: buildSampleMembers_(today, files),
      Projects: buildSampleProjects_(today),
      Tasks: buildSampleTasks_(today),
      Expenses: other.Expenses,
      FormSubmissions: other.FormSubmissions,
      DailyReports: other.DailyReports,
      Candidates: other.Candidates,
    },
    settings: buildSampleSettings_(today, files),
  }
}

// ---- テスト用のアカウント(TEST_ACCOUNTS) ----

// 'top=a@gmail.com, admin=b@gmail.com' を { top: 'a@gmail.com', ... } にする。
// 知らない枠の名前・メールアドレスの形でないもの・同じアドレスの重複はエラー
function parseSampleTestAccounts_(raw) {
  var out = {}
  var seen = {}
  String(raw || '').split(/[,\n]/).map(function (s) { return s.trim() }).filter(Boolean).forEach(function (pair) {
    var i = pair.indexOf('=')
    var slot = (i < 0 ? pair : pair.slice(0, i)).trim()
    var email = (i < 0 ? '' : pair.slice(i + 1)).trim().toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(SAMPLE_ACCOUNT_SLOTS, slot)) {
      throw userError_('TEST_ACCOUNTS に知らない枠の名前があります: ' + slot + '(使える枠: ' + Object.keys(SAMPLE_ACCOUNT_SLOTS).join(', ') + ')')
    }
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) throw userError_('TEST_ACCOUNTS の ' + slot + ' のメールアドレスが正しくありません: ' + email)
    if (out[slot]) throw userError_('TEST_ACCOUNTS で同じ枠が2回指定されています: ' + slot)
    if (seen[email]) throw userError_('TEST_ACCOUNTS で同じメールアドレスが2つの枠に指定されています: ' + email)
    seen[email] = true
    out[slot] = email
  })
  return out
}

// サンプル以外のメンバーに登録されているアドレスが無いか確かめる(rows は MemberEmails の [id, email])
function assertSampleAccountsUnregistered_(accounts, rows) {
  var wanted = {}
  Object.keys(accounts).forEach(function (slot) { wanted[accounts[slot]] = slot })
  rows.forEach(function (r) {
    var id = String(r[0] || '')
    if (id.indexOf(SAMPLE_ID_PREFIX) === 0) return
    String(r[1] || '').split(',').map(function (e) { return e.trim().toLowerCase() }).forEach(function (e) {
      if (wanted[e]) {
        throw userError_('TEST_ACCOUNTS の ' + wanted[e] + ' のアドレス(' + e + ')は、サンプル以外のメンバー(id: ' + id +
          ')に登録されています。そのままではそのメンバーとしてログインしてしまうため、別のアカウントを指定してください。')
      }
    })
  })
}

// ---- Settings の追加と、元に戻す処理(Google のサービスを使わない純粋な関数) ----

function sampleParseJson_(raw, fallback) {
  if (!raw) return fallback
  try { var v = JSON.parse(raw); return v == null ? fallback : v } catch (e) { return fallback }
}

// current: { キー: 今の値(文字列) } → { values: { キー: 書き込む値 }, state: 元に戻すための記録 }
// 役職の設定(roles)を使う団体向けに、サンプルの役職(サンプル班長)を今までの設定
// (role_levels など)ではなく roles の1件として足す形に変える
function sampleSettingsWithRoles_(settings) {
  var out = JSON.parse(JSON.stringify(settings))
  var name = SAMPLE_ROLES.restricted
  var role = { id: SAMPLE_ID_PREFIX + 'role-restricted', name: name, tier: 'admin', restricted: true }
  if (out.maps.role_permissions && out.maps.role_permissions[name]) role.sections = out.maps.role_permissions[name]
  if (out.maps.job_requirements && out.maps.job_requirements[name]) role.requiredSkills = out.maps.job_requirements[name]
  delete out.lists.role_levels
  delete out.lists.restricted_roles
  delete out.maps.role_permissions
  delete out.maps.job_requirements
  out.items.roles = [role]
  return out
}

function mergeSampleSettings_(current, additions) {
  var values = {}
  var state = { lists: {}, items: {}, values: {}, maps: {}, scalars: {} }
  Object.keys(additions.lists).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = splitCsvList_(raw)
    var wasEmpty = base.length === 0
    if (wasEmpty && SAMPLE_LIST_DEFAULTS[key]) base = SAMPLE_LIST_DEFAULTS[key].slice()
    var added = additions.lists[key].filter(function (v) { return base.indexOf(v) === -1 })
    if (added.length === 0) return
    values[key] = base.concat(added).join(',')
    state.lists[key] = { wasEmpty: wasEmpty, added: added }
  })
  Object.keys(additions.items).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson_(raw, []).filter(function (x) { return !(x && String(x.id || '').indexOf(SAMPLE_ID_PREFIX) === 0) })
    values[key] = JSON.stringify(base.concat(additions.items[key]))
    state.items[key] = { wasEmpty: !raw, ids: additions.items[key].map(function (x) { return x.id }) }
  })
  Object.keys(additions.values).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson_(raw, [])
    var have = base.map(function (x) { return JSON.stringify(x) })
    var added = additions.values[key].filter(function (x) { return have.indexOf(JSON.stringify(x)) === -1 })
    if (added.length === 0) return
    values[key] = JSON.stringify(base.concat(added))
    state.values[key] = { wasEmpty: !raw, added: added.map(function (x) { return JSON.stringify(x) }) }
  })
  Object.keys(additions.maps).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson_(raw, {})
    var addedKeys = Object.keys(additions.maps[key]).filter(function (k) { return !Object.prototype.hasOwnProperty.call(base, k) })
    if (addedKeys.length === 0) return
    addedKeys.forEach(function (k) { base[k] = additions.maps[key][k] })
    values[key] = JSON.stringify(base)
    state.maps[key] = { wasEmpty: !raw, keys: addedKeys }
  })
  Object.keys(additions.scalars).forEach(function (key) {
    state.scalars[key] = { value: String(current[key] || '') }
    values[key] = String(additions.scalars[key])
  })
  return { values: values, state: state }
}

// mergeSampleSettings_ の記録をもとに、サンプルの分だけを取り除いた値を返す。
// サンプルを入れた後に画面から足した設定は残す
function restoreSampleSettings_(current, state) {
  var values = {}
  Object.keys(state.lists || {}).forEach(function (key) {
    var s = state.lists[key]
    var rest = splitCsvList_(current[key]).filter(function (v) { return s.added.indexOf(v) === -1 })
    var defaults = SAMPLE_LIST_DEFAULTS[key]
    var same = defaults && rest.length === defaults.length && rest.every(function (v, i) { return v === defaults[i] })
    values[key] = s.wasEmpty && (same || rest.length === 0) ? '' : rest.join(',')
  })
  Object.keys(state.items || {}).forEach(function (key) {
    var s = state.items[key]
    var rest = sampleParseJson_(current[key], []).filter(function (x) { return !(x && s.ids.indexOf(x.id) !== -1) })
    values[key] = s.wasEmpty && rest.length === 0 ? '' : JSON.stringify(rest)
  })
  Object.keys(state.values || {}).forEach(function (key) {
    var s = state.values[key]
    var remaining = s.added.slice()
    var rest = sampleParseJson_(current[key], []).filter(function (x) {
      var i = remaining.indexOf(JSON.stringify(x))
      if (i === -1) return true
      remaining.splice(i, 1)
      return false
    })
    values[key] = s.wasEmpty && rest.length === 0 ? '' : JSON.stringify(rest)
  })
  Object.keys(state.maps || {}).forEach(function (key) {
    var s = state.maps[key]
    var obj = sampleParseJson_(current[key], {})
    s.keys.forEach(function (k) { delete obj[k] })
    values[key] = s.wasEmpty && Object.keys(obj).length === 0 ? '' : JSON.stringify(obj)
  })
  Object.keys(state.scalars || {}).forEach(function (key) { values[key] = state.scalars[key].value })
  return values
}

// ---- シートへの書き込み・削除 ----

var SAMPLE_SETTINGS_STATE_KEY = 'SAMPLE_SETTINGS_STATE'
var SAMPLE_FILE_IDS_KEY = 'SAMPLE_FILE_IDS'
// サンプルのメンバーが作った行(テスト用のアカウントで操作して増えた行)を見分ける列
var SAMPLE_OWNER_COLUMNS = { Tasks: 'creator_id', Expenses: 'applicant_id', FormSubmissions: 'submitter_id', DailyReports: 'member_id' }

function isSampleId_(v) { return String(v || '').indexOf(SAMPLE_ID_PREFIX) === 0 }

// 行を見出しに合わせて末尾に一括で書き込む(書式なしテキストにして、日付の自動変換を避ける)
// サンプルのタスクの行の選択肢の値を、今のシートの形式にする
function sheetSampleTaskRow_(o) {
  var out = {}
  Object.keys(o).forEach(function (k) { out[k] = o[k] })
  ;['status', 'difficulty', 'priority', 'importance', 'visibility', 'department'].forEach(function (k) {
    if (o[k] !== undefined && o[k] !== '') out[k] = sheetValue_(k, o[k])
  })
  if (o.approval_status) out.approval_status = sheetCode_('approval', o.approval_status)
  if (o.history_json) {
    try { out.history_json = JSON.stringify(JSON.parse(o.history_json).map(sheetHistoryEntry_)) } catch (e) {}
  }
  if (o.schedule_json) {
    try { out.schedule_json = JSON.stringify(mapScheduleCodes_(JSON.parse(o.schedule_json), sheetCode_)) } catch (e) {}
  }
  return out
}

function appendSampleRows_(sheetName, objects) {
  if (objects.length === 0) return 0
  var sheet = getSheet_(sheetName)
  var headers = headerRow_(sheet)
  var unknown = {}
  objects.forEach(function (o) { Object.keys(o).forEach(function (k) { if (headers.indexOf(k) === -1) unknown[k] = true }) })
  if (Object.keys(unknown).length) {
    throw userError_(sheetName + 'シートに列が見つかりません: ' + Object.keys(unknown).join(', ') + '。setupOhsumi() を実行してください。')
  }
  var values = objects.map(function (o) { return headers.map(function (h) { return o[h] != null ? String(o[h]) : '' }) })
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length)
  range.setNumberFormat('@')
  range.setValues(values)
  return values.length
}

// 条件に合う行を下から削除する(連続した行はまとめて削除する)
function deleteSampleRows_(sheetName, match) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(sheetName)
  if (!sheet || sheet.getLastRow() < 2) return 0
  var headers = headerRow_(sheet)
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var hit = rows.map(function (r) {
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    return match(o)
  })
  var deleted = 0
  var i = hit.length - 1
  while (i >= 0) {
    if (!hit[i]) { i--; continue }
    var end = i
    while (i >= 0 && hit[i]) i--
    sheet.deleteRows(i + 3, end - i)
    forgetSheetGrid_()
    deleted += end - i
  }
  return deleted
}

function createSampleFiles_() {
  var folder = getUploadFolder_()
  var stamp = Date.now()
  var ids = []
  var urls = {}
  sampleFileSpecs_().forEach(function (spec) {
    var blob = spec.pdf
      ? Utilities.newBlob('<html><body style="font-family:sans-serif"><h2>領収書(サンプル)</h2><p>交通費 3,400円</p><p>サンプル交通株式会社</p></body></html>', 'text/html', 'receipt.html').getAs('application/pdf')
      : Utilities.newBlob(Utilities.base64Decode(SAMPLE_IMAGES[spec.png]), 'image/png', spec.key + '.png')
    var file = folder.createFile(blob)
    file.setName(spec.name + stamp)
    // 元のスプレッドシートと同じく、誰とも共有しない
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
    ids.push(file.getId())
    urls[spec.key] = spec.url === 'file' ? file.getUrl()
      : 'https://lh3.googleusercontent.com/d/' + file.getId() + (spec.url === 'image512' ? '=w512-h512-c' : '=w256-h256-c')
  })
  PropertiesService.getScriptProperties().setProperty(SAMPLE_FILE_IDS_KEY, JSON.stringify(ids))
  return urls
}

function trashSampleFiles_() {
  var props = PropertiesService.getScriptProperties()
  var ids = sampleParseJson_(props.getProperty(SAMPLE_FILE_IDS_KEY), [])
  var count = 0
  ids.forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); count++ } catch (e) { /* 既に削除済み */ }
  })
  // 記録に無いもの(途中で失敗した場合など)も、名前で探して消す
  try {
    var prefixes = sampleFileSpecs_().map(function (s) { return s.name })
    var files = getUploadFolder_().getFiles()
    while (files.hasNext()) {
      var f = files.next()
      var name = f.getName()
      if (prefixes.some(function (p) { return name.indexOf(p) === 0 }) && ids.indexOf(f.getId()) === -1) { f.setTrashed(true); count++ }
    }
  } catch (e) { /* アップロード用フォルダが無い */ }
  props.deleteProperty(SAMPLE_FILE_IDS_KEY)
  return count
}

function readSettingsValues_(keys) {
  var out = {}
  keys.forEach(function (k) { out[k] = getSettingValue_(k) || '' })
  return out
}

function sampleSettingKeys_(settings) {
  var keys = []
  ;['lists', 'items', 'values', 'maps', 'scalars'].forEach(function (g) { keys = keys.concat(Object.keys(settings[g] || {})) })
  return keys
}

// サンプルを消す(ロックを取った中で呼ぶ)。返り値は削除した件数
function deleteSampleDataUnlocked_() {
  var props = PropertiesService.getScriptProperties()
  var counts = {}
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    if (name === 'Settings') return
    var owner = SAMPLE_OWNER_COLUMNS[name]
    counts[name] = deleteSampleRows_(name, function (o) { return isSampleId_(o.id) || (owner && isSampleId_(o[owner])) })
  })
  // Settings: サンプルの分だけを取り除き、値が1つの設定は元の値に戻す
  var state = sampleParseJson_(props.getProperty(SAMPLE_SETTINGS_STATE_KEY), null)
  if (state) {
    var keys = sampleSettingKeys_(state)
    var restored = restoreSampleSettings_(readSettingsValues_(keys), state)
    Object.keys(restored).forEach(function (k) { updateSetting_(k, restored[k]) })
    props.deleteProperty(SAMPLE_SETTINGS_STATE_KEY)
  }
  // 画面で並べ替えた時などに残る、サンプルの id の参照を外す
  ;['project_order', 'survey_invited_ids'].forEach(function (k) {
    var list = splitCsvList_(getSettingValue_(k))
    var rest = list.filter(function (v) { return !isSampleId_(v) })
    if (rest.length !== list.length) updateSetting_(k, rest.join(','))
  })
  // サンプルのメンバーの通知の待ち行列・ログインの世代番号
  var all = props.getProperties()
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('notif_queue_' + SAMPLE_ID_PREFIX) === 0 || k.indexOf(SESSION_GEN_PREFIX + SAMPLE_ID_PREFIX) === 0) props.deleteProperty(k)
  })
  counts.files = trashSampleFiles_()
  resetRequestProps_()
  return counts
}

function withSampleLock_(fn) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return fn()
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

// ---- 内部コードへの移行(migrateToInternalCodes) ---------------------------------------
//
// Apps Script エディタから手動で実行する。スクリプトプロパティ MIGRATION_MODE で動きを切り替える。
//   dryRun(既定): 何も書き込まず、変換される件数と例・当てはまらない値・作られる役職を実行ログに出す
//   apply: スプレッドシートのバックアップのコピー(誰とも共有しない)を作ってから書き換え、
//          VALUE_FORMAT=codes にする。終わったら MIGRATION_MODE を dryRun に戻す
// 何度実行しても結果は同じ(2回目は何も変わらない)。列は見出しの名前で探すので、列や設定が無くても動く。
// 最上位の役職は「代表」。名前を変えている団体は、スクリプトプロパティ MIGRATION_TOP_ROLE_NAME で指定する。
// 変換の表は VALUE_CODES・役職・部門の一覧。当てはまらない値は変えずに残し、報告する。

var MIGRATION_TASK_CODE_COLUMNS = {
  status: 'status', difficulty: 'difficulty', priority: 'priority',
  importance: 'importance', visibility: 'visibility', approval_status: 'approval',
}

// 表(VALUE_CODES)にある値ならコードを、無ければ null を返す(空は呼ぶ側で扱う)
function knownCode_(kind, value) {
  var v = String(value === null || value === undefined ? '' : value).trim()
  var table = VALUE_CODES[kind]
  if (table.codes.indexOf(v) >= 0) return v
  for (var i = 0; i < table.codes.length; i++) if (table.sheetLabels[table.codes[i]] === v) return table.codes[i]
  if (Object.prototype.hasOwnProperty.call(table.aliases, v)) return table.aliases[v]
  return null
}

// 移行後の役職の一覧を作る(roles が既にあればそれを使う)
function migrationRoles_(settings, memberRoleRefs, topRoleName, report, roleIdsByName) {
  var existing = parseRolesSetting_(settings.roles)
  if (existing) return { roles: existing, created: false }
  var roles = rolesFromLegacy_(settings)
  // メンバーにあって役職の一覧に無い役職名は、管理者の役職として作る(今までも管理者として扱っていた)
  memberRoleRefs.forEach(function (ref) {
    var v = String(ref || '').trim()
    if (!v || findRole_(roles, v)) return
    roles.push({ id: v, name: v, tier: 'admin', restricted: false })
    report.createdRoles.push(v)
  })
  var topName = String(topRoleName || '').trim() || DEFAULT_TOP_ROLE_NAME
  var top = null
  roles.forEach(function (r) { if (r.name === topName) top = r })
  if (!top) {
    report.errors.push('最上位の役職「' + topName + '」が見つかりません。MIGRATION_TOP_ROLE_NAME に、最上位にする役職の名前を指定してください。')
    return { roles: roles, created: true }
  }
  if (topName !== DEFAULT_TOP_ROLE_NAME) {
    top.tier = 'top'
    delete top.restricted
    // 自動で足した「代表」を、使っている人がいなければ外す
    var used = memberRoleRefs.some(function (ref) { return String(ref || '').trim() === DEFAULT_TOP_ROLE_NAME })
    var listed = splitCsvList_(settings.role_levels).indexOf(DEFAULT_TOP_ROLE_NAME) >= 0
    if (!used && !listed) roles = roles.filter(function (r) { return r.name !== DEFAULT_TOP_ROLE_NAME })
  }
  roles = orderMigrationRoles_(roles, report)
  // ID を付ける: 一般 → base、最上位(指定した役職)→ top、ほかは新しい ID
  roles = roles.map(function (r) {
    var copy = {}
    Object.keys(r).forEach(function (k) { copy[k] = r[k] })
    if (r.tier === 'base') copy.id = BASE_ROLE_ID
    else if (r === top) copy.id = TOP_ROLE_ID
    // roleIdsByName: 移行した後の役職の ID(Orbit との差分を出す時に、同じ ID で変換し直すため)
    else copy.id = (roleIdsByName && roleIdsByName[r.name]) || newRoleId_()
    return copy
  })
  return { roles: roles, created: true }
}

// 役職を上下関係の順(一般 → 管理者の役職 → 最上位の役職)に並べる。管理者の役職の中では今の順を保つので、
// 役職の一覧に無かった役職(最後に足したもの)は既存の管理者の役職の後ろ、つまり最上位の役職のすぐ下に入る。
// 最上位の役職より後ろに並んでいた管理者の役職(role_levels で代表の後ろに書いたものなど)も、最上位の役職の下へ移す。
// 入れた位置・移した位置は report.rolePlacements に出す
function orderMigrationRoles_(roles, report) {
  var byTier = function (tier) { return roles.filter(function (r) { return r.tier === tier }) }
  var tops = byTier('top')
  var ordered = byTier('base').concat(byTier('admin'), tops)
  var created = report.createdRoles || []
  var firstTop = tops.length ? roles.indexOf(tops[0]) : -1
  ordered.forEach(function (r, i) {
    if (r.tier !== 'admin') return
    var isCreated = created.indexOf(r.name) >= 0
    var wasAboveTop = firstTop >= 0 && roles.indexOf(r) > firstTop
    if (!isCreated && !wasAboveTop) return
    report.rolePlacements.push({
      name: r.name,
      reason: isCreated ? 'created' : 'moved',
      below: i > 0 ? ordered[i - 1].name : '',
      above: i < ordered.length - 1 ? ordered[i + 1].name : '',
    })
  })
  return ordered
}

// 移行の計画を作る(Google のサービスを使わない純粋な関数)。
// snapshot: { Tasks, Members, Settings, Expenses } の { headers, rows }。opts: { topRoleName, roleIdsByName }
// 返り値: { cells: { シート名: [[行, 列, 新しい値], ...] }, settings: { キー: 値 }, report }
function planMigration_(snapshot, opts) {
  opts = opts || {}
  var report = { counts: {}, examples: {}, unknown: {}, createdRoles: [], rolePlacements: [], roles: [], roleMembers: {}, errors: [] }
  var cells = {}
  var settingsOut = {}
  var table = function (name) { return snapshot[name] || { headers: [], rows: [] } }
  var note = function (key, from, to) {
    report.counts[key] = (report.counts[key] || 0) + 1
    report.examples[key] = report.examples[key] || []
    if (report.examples[key].length < 5) report.examples[key].push(String(from) + ' → ' + String(to))
  }
  var unknown = function (key, value) {
    report.unknown[key] = report.unknown[key] || {}
    var v = String(value)
    report.unknown[key][v] = (report.unknown[key][v] || 0) + 1
  }
  var setCell = function (sheet, r, c, value) {
    cells[sheet] = cells[sheet] || []
    cells[sheet].push([r, c, value])
  }

  // Settings(key → value)
  var st = table('Settings')
  var keyCol = st.headers.indexOf('key')
  var valueCol = st.headers.indexOf('value')
  var settings = {}
  if (keyCol >= 0 && valueCol >= 0) st.rows.forEach(function (r) { settings[String(r[keyCol])] = String(r[valueCol] === null || r[valueCol] === undefined ? '' : r[valueCol]) })
  var departments = departmentsFromSettings_(settings)

  // 部門の値: 表にあれば ID、無ければ null
  var knownDept = function (value) {
    var v = String(value === null || value === undefined ? '' : value).trim()
    if (v === UNCATEGORIZED_NAME) return ''
    var d = findDepartment_(departments, v)
    return d ? d.id : null
  }
  var convertValue = function (key, kind, value) {
    var v = String(value === null || value === undefined ? '' : value).trim()
    if (!v) return { value: value, changed: false }
    var code = kind === 'department' ? knownDept(v) : knownCode_(kind, v)
    if (code === null) { unknown(key, v); return { value: value, changed: false } }
    return { value: code, changed: code !== v }
  }

  // 役職
  var mt = table('Members')
  var mRole = mt.headers.indexOf('role')
  var mInactive = mt.headers.indexOf('inactive')
  var memberRoleRefs = mRole >= 0 ? mt.rows.map(function (r) { return r[mRole] }) : []
  var built = migrationRoles_(settings, memberRoleRefs, opts.topRoleName, report, opts.roleIdsByName)
  var roles = built.roles
  if (built.created) settingsOut.roles = JSON.stringify(roles)
  report.roles = roles.map(function (r) { return { id: r.id, name: r.name, tier: r.tier, restricted: r.tier === 'admin' && r.restricted === true } })
  var roleRefToId = function (key, ref) {
    var v = String(ref === null || ref === undefined ? '' : ref).trim()
    if (!v) return null
    var role = findRole_(roles, v)
    if (!role) { unknown(key, v); return null }
    return role.id === v ? null : role.id
  }

  // Tasks
  var tt = table('Tasks')
  Object.keys(MIGRATION_TASK_CODE_COLUMNS).forEach(function (col) {
    var c = tt.headers.indexOf(col)
    if (c < 0) return
    tt.rows.forEach(function (row, i) {
      var res = convertValue('Tasks.' + col, MIGRATION_TASK_CODE_COLUMNS[col], row[c])
      if (res.changed) { note('Tasks.' + col, row[c], res.value); setCell('Tasks', i, c, res.value) }
    })
  })
  var dc = tt.headers.indexOf('department')
  if (dc >= 0) {
    tt.rows.forEach(function (row, i) {
      var v = String(row[dc] === null || row[dc] === undefined ? '' : row[dc]).trim()
      if (!v) return
      var id = knownDept(v)
      if (id === null) { unknown('Tasks.department', v); return }
      if (id !== v) { note('Tasks.department', v, id === '' ? '(空)' : id); setCell('Tasks', i, dc, id) }
    })
  }
  var hc = tt.headers.indexOf('history_json')
  if (hc >= 0) {
    tt.rows.forEach(function (row, i) {
      var list = parseJsonOr_(row[hc], null)
      if (!Array.isArray(list)) return
      var changed = false
      var next = list.map(function (h) {
        var kind = h && HISTORY_CODE_FIELDS[h.field]
        if (!kind) return h
        var copy = {}
        Object.keys(h).forEach(function (k) { copy[k] = h[k] })
        ;['from', 'to'].forEach(function (side) {
          var res = convertValue('Tasks.history_json(' + h.field + ')', kind, h[side])
          if (res.changed) { copy[side] = res.value; changed = true }
        })
        return copy
      })
      if (changed) { note('Tasks.history_json', '(変更の記録)', '(コード)'); setCell('Tasks', i, hc, JSON.stringify(next)) }
    })
  }
  var sc = tt.headers.indexOf('schedule_json')
  if (sc >= 0) {
    tt.rows.forEach(function (row, i) {
      var schedule = parseJsonOr_(row[sc], null)
      if (!schedule || !schedule.responses) return
      var changed = false
      Object.keys(schedule.responses).forEach(function (mid) {
        var answers = schedule.responses[mid] || {}
        Object.keys(answers).forEach(function (cid) {
          var res = convertValue('Tasks.schedule_json', 'scheduleAnswer', answers[cid])
          if (res.changed) { answers[cid] = res.value; changed = true }
        })
      })
      if (changed) { note('Tasks.schedule_json', '(日程調整の回答)', '(コード)'); setCell('Tasks', i, sc, JSON.stringify(schedule)) }
    })
  }

  // Members
  if (mRole >= 0) {
    mt.rows.forEach(function (row, i) {
      var id = roleRefToId('Members.role', row[mRole])
      if (id) { note('Members.role', row[mRole], id); setCell('Members', i, mRole, id) }
    })
  }
  var oc = mt.headers.indexOf('permission_overrides_json')
  if (oc >= 0) {
    mt.rows.forEach(function (row, i) {
      var list = parseJsonOr_(row[oc], null)
      if (!Array.isArray(list)) return
      var changed = false
      list.forEach(function (ov) {
        if (!ov || ov.targetType !== 'department') return
        var res = convertValue('Members.permission_overrides_json(部門)', 'department', ov.targetId)
        if (res.changed) { ov.targetId = res.value; changed = true }
      })
      if (changed) { note('Members.permission_overrides_json', '(部門の権限の例外)', '(部門 ID)'); setCell('Members', i, oc, JSON.stringify(list)) }
    })
  }
  // 最上位の役職を持つ有効なメンバーが1人以上いること
  if (mRole >= 0) {
    var tops = 0
    mt.rows.forEach(function (row) {
      var inactive = mInactive >= 0 && String(row[mInactive] || '').trim().toUpperCase() === 'TRUE'
      var role = findRole_(roles, row[mRole])
      var roleId = role ? role.id : String(row[mRole] || '').trim()
      report.roleMembers[roleId || BASE_ROLE_ID] = (report.roleMembers[roleId || BASE_ROLE_ID] || 0) + 1
      if (!inactive && isTopRoleRef_(roles, row[mRole])) tops++
    })
    if (tops === 0 && mt.rows.length > 0) report.errors.push('最上位の役職を持つ有効なメンバーがいません。MIGRATION_TOP_ROLE_NAME を確かめてください。')
  }

  // 承認ステップの役職(経費申請の各行・経費のカテゴリ・フォームの定義)
  var convertSteps = function (key, steps) {
    if (!Array.isArray(steps)) return false
    var changed = false
    steps.forEach(function (step) {
      if (!step || step.type !== 'role') return
      var id = roleRefToId(key, step.role)
      if (id) { step.role = id; changed = true }
    })
    return changed
  }
  var et = table('Expenses')
  var ec = et.headers.indexOf('approval_steps_json')
  if (ec >= 0) {
    et.rows.forEach(function (row, i) {
      var steps = parseJsonOr_(row[ec], null)
      if (convertSteps('Expenses.approval_steps_json(承認ステップの役職)', steps)) {
        note('Expenses.approval_steps_json', '(承認ステップの役職)', '(役職 ID)')
        setCell('Expenses', i, ec, JSON.stringify(steps))
      }
    })
  }
  ;['custom_form_defs', 'expense_categories'].forEach(function (key) {
    var defs = parseJsonOr_(settings[key], null)
    if (!Array.isArray(defs)) return
    var changed = false
    defs.forEach(function (d) { if (d && convertSteps('Settings.' + key + '(承認ステップの役職)', d.approvalSteps)) changed = true })
    if (changed) { note('Settings.' + key, '(承認ステップの役職)', '(役職 ID)'); settingsOut[key] = JSON.stringify(defs) }
  })

  // Settings のテンプレート・定期タスク(部門・難易度・優先度・きっかけのステータス)
  var convertItem = function (key, item) {
    if (!item || typeof item !== 'object') return false
    var changed = false
    ;[['department', 'department'], ['difficulty', 'difficulty'], ['priority', 'priority'], ['triggerOnStatus', 'status']].forEach(function (p) {
      if (!(p[0] in item)) return
      var res = convertValue(key + '(' + p[0] + ')', p[1], item[p[0]])
      if (res.changed) { item[p[0]] = res.value; changed = true }
    })
    return changed
  }
  var pt = parseJsonOr_(settings.project_templates, null)
  if (pt && typeof pt === 'object' && !Array.isArray(pt)) {
    var ptChanged = false
    Object.keys(pt).forEach(function (name) { (Array.isArray(pt[name]) ? pt[name] : []).forEach(function (it) { if (convertItem('Settings.project_templates', it)) ptChanged = true }) })
    if (ptChanged) { note('Settings.project_templates', '(テンプレート)', '(コード)'); settingsOut.project_templates = JSON.stringify(pt) }
  }
  var tst = parseJsonOr_(settings.task_set_templates, null)
  if (Array.isArray(tst)) {
    var tstChanged = false
    tst.forEach(function (tpl) { (tpl && Array.isArray(tpl.items) ? tpl.items : []).forEach(function (it) { if (convertItem('Settings.task_set_templates', it)) tstChanged = true }) })
    if (tstChanged) { note('Settings.task_set_templates', '(業務テンプレート)', '(コード)'); settingsOut.task_set_templates = JSON.stringify(tst) }
  }
  var rr = parseJsonOr_(settings.recurring_rules, null)
  if (Array.isArray(rr)) {
    var rrChanged = false
    rr.forEach(function (rule) { if (convertItem('Settings.recurring_rules', rule)) rrChanged = true })
    if (rrChanged) { note('Settings.recurring_rules', '(定期タスク)', '(コード)'); settingsOut.recurring_rules = JSON.stringify(rr) }
  }
  var th = parseJsonOr_(settings.skill_level_thresholds, null)
  if (th && typeof th === 'object' && Object.prototype.hasOwnProperty.call(th, LEGACY_DEFAULT_THRESHOLD_KEY)) {
    var nextTh = {}
    Object.keys(th).forEach(function (k) {
      if (k === LEGACY_DEFAULT_THRESHOLD_KEY) { if (!(DEFAULT_THRESHOLD_KEY in th)) nextTh[DEFAULT_THRESHOLD_KEY] = th[k] } else nextTh[k] = th[k]
    })
    note('Settings.skill_level_thresholds', LEGACY_DEFAULT_THRESHOLD_KEY, DEFAULT_THRESHOLD_KEY)
    settingsOut.skill_level_thresholds = JSON.stringify(nextTh)
  }

  return { cells: cells, settings: settingsOut, report: report }
}

// 計画の報告を実行ログの行にする
function formatMigrationReport_(plan, mode) {
  var r = plan.report
  var lines = ['==== 内部コードへの移行(' + mode + ') ====']
  var keys = Object.keys(r.counts)
  lines.push(keys.length ? '■ 変換される値(シート.列: 件数 / 例)' : '■ 変換される値はありません(移行済み、またはデータがありません)')
  keys.sort().forEach(function (k) { lines.push('  ' + k + ': ' + r.counts[k] + '件 / ' + r.examples[k].join('、')) })
  var uk = Object.keys(r.unknown)
  lines.push(uk.length ? '■ 当てはまらない値(変換せずに残します。必要なら手で直してから、もう一度 dryRun してください)' : '■ 当てはまらない値はありません')
  uk.sort().forEach(function (k) {
    lines.push('  ' + k + ': ' + Object.keys(r.unknown[k]).map(function (v) { return '「' + v + '」' + r.unknown[k][v] + '件' }).join('、'))
  })
  lines.push('■ 移行後の役職(下の役職から順。種類・人数)')
  r.roles.forEach(function (role) {
    var kind = role.tier === 'admin' ? (role.restricted ? '、制限付きの管理者' : '、全権の管理者') : ''
    lines.push('  ' + role.name + '(' + role.tier + kind + '、ID: ' + role.id + ')' + (r.roleMembers[role.id] || 0) + '人')
  })
  if (r.createdRoles.length) lines.push('■ 役職の一覧に無かったため、管理者の役職として作る役職: ' + r.createdRoles.join('、'))
  if (r.rolePlacements.length) {
    lines.push('■ 役職を入れる位置(管理者の役職は、一般より上・最上位の役職より下に並べます)')
    r.rolePlacements.forEach(function (p) {
      var why = p.reason === 'created' ? '役職の一覧に無かった役職' : '最上位の役職より後ろに並んでいた役職'
      lines.push('  ' + p.name + ': 「' + p.below + '」の上、「' + p.above + '」の下(' + why + ')')
    })
  }
  var sk = Object.keys(plan.settings)
  if (sk.length) lines.push('■ 書き換える Settings のキー: ' + sk.join('、'))
  if (r.errors.length) {
    lines.push('■ エラー(このままでは apply できません)')
    r.errors.forEach(function (e) { lines.push('  ' + e) })
  }
  return lines
}

// 移行に使うシートを読む
function readMigrationSnapshot_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var out = {}
  ;[SHEET_TASKS, SHEET_MEMBERS, SHEET_SETTINGS, SHEET_EXPENSES].forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet || sheet.getLastRow() < 1) { out[name] = { headers: [], rows: [] }; return }
    var headers = headerRow_(sheet)
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
    out[name] = { headers: headers, rows: rows }
  })
  return out
}

// スプレッドシートのバックアップのコピーを作り、誰とも共有しない状態にする。
// コピーには Apps Script のプロジェクトも複製されるが、そのコピーの GAS はデプロイしない
function createPrivateBackupCopy_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  var copy = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + '(内部コードへの移行前のバックアップ ' + stamp + ')', DriveApp.getRootFolder())
  copy.getEditors().forEach(function (u) { try { copy.removeEditor(u) } catch (e) { /* 自分自身など */ } })
  copy.getViewers().forEach(function (u) { try { copy.removeViewer(u) } catch (e) { /* 自分自身など */ } })
  try { copy.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE) } catch (e) { /* 組織の設定で変えられない場合 */ }
  return copy
}

// 計画どおりにシートと設定を書き換える
function applyMigrationPlan_(plan) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  Object.keys(plan.cells).forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet) return
    var headers = headerRow_(sheet)
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    var touchedCols = {}
    plan.cells[name].forEach(function (cell) { data[cell[0]][cell[1]] = cell[2]; touchedCols[cell[1]] = true })
    // 変えた列だけを書き戻す
    Object.keys(touchedCols).forEach(function (c) {
      var col = Number(c)
      var range = sheet.getRange(2, col + 1, data.length, 1)
      range.setNumberFormat('@')
      range.setValues(data.map(function (row) { return [row[col]] }))
    })
  })
  Object.keys(plan.settings).forEach(function (key) { updateSetting_(key, plan.settings[key]) })
}

// ---- Orbit からの移行の点検(N1〜N3。エディタから実行する migrationReport・renameOrbitCalendarEvents・listChangesFromOrbit の中身) ----

var MIGRATION_REPORT_PROPERTY = 'MIGRATION_REPORT_LAST'
var MIGRATION_REPORT_SHEETS = ['Members', 'MemberEmails', 'Projects', 'Tasks', 'Settings', 'Expenses', 'FormSubmissions', 'DailyReports', 'Candidates']
var CALENDAR_PREFIX_ORBIT = '[Orbit] '
var CALENDAR_PREFIX_OHSUMI = '[Ohsumi] '
var CALENDAR_RENAME_DAYS = 730
// 参照している ID(カンマ区切りを含む)と、その ID を探すシート
var MIGRATION_REFERENCE_COLUMNS = [
  ['Tasks', 'assignee_id', 'Members'], ['Tasks', 'creator_id', 'Members'], ['Tasks', 'reviewer_id', 'Members'],
  ['Tasks', 'reviewer_ids', 'Members'], ['Tasks', 'depends_on_ids', 'Tasks'], ['Tasks', 'related_review_task_id', 'Tasks'],
  ['Tasks', 'project_id', 'Projects'], ['Projects', 'owner_id', 'Members'], ['Projects', 'member_ids', 'Members'],
  ['Projects', 'parent_id', 'Projects'], ['Members', 'reports_to_id', 'Members'], ['Members', 'mentor_id', 'Members'],
  ['Expenses', 'applicant_id', 'Members'],
]
// 差分に出さない列(ログイン・通知で自動で変わる列)
var MIGRATION_DIFF_IGNORED = { Members: ['last_login', 'last_inactive_notified'], Projects: ['last_notified_health'], Settings: ['migrated_at'] }

// 点検・差分に使うシートを読む(無いシートは空)
function readReportTables_(ss) {
  var out = {}
  MIGRATION_REPORT_SHEETS.forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) { out[name] = { headers: [], rows: [] }; return }
    var width = sheet.getLastColumn()
    var headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim() })
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues() : []
    out[name] = { headers: headers, rows: rows }
  })
  return out
}

function tableColumn_(table, name) {
  var c = table.headers.indexOf(name)
  return function (row) { return c >= 0 ? row[c] : '' }
}

function splitIds_(value) {
  return String(value === null || value === undefined ? '' : value).split(',').map(function (s) { return s.trim() }).filter(Boolean)
}

// N1 の数(Google のサービスを使わない純粋な関数)。ctx: { roles, departments, fileOk(url) → true/false/null(時間切れ) }
function buildMigrationReport_(tables, ctx) {
  var counts = {}
  var add = function (key, n) { counts[key] = (counts[key] || 0) + (n === undefined ? 1 : n) }
  var t = function (name) { return tables[name] || { headers: [], rows: [] } }
  var withId = function (name) {
    var id = tableColumn_(t(name), 'id')
    return t(name).rows.filter(function (r) { return String(id(r)).trim() !== '' })
  }
  var ids = {}
  ;['Members', 'Projects', 'Tasks'].forEach(function (name) {
    var id = tableColumn_(t(name), 'id')
    ids[name] = {}
    withId(name).forEach(function (r) { ids[name][String(id(r)).trim()] = true })
  })

  // メンバー
  var members = withId('Members')
  var mCol = function (name) { return tableColumn_(t('Members'), name) }
  var isInactive = function (r) { var v = mCol('inactive')(r); return v === true || String(v).toUpperCase() === 'TRUE' }
  add('Members.行', members.length)
  add('Members.有効', 0)
  add('Members.休止中', 0)
  var emailOf = {}
  var eId = tableColumn_(t('MemberEmails'), 'id')
  var eMail = tableColumn_(t('MemberEmails'), 'email')
  var emails = t('MemberEmails').rows.filter(function (r) { return String(eId(r)).trim() !== '' })
  add('MemberEmails.行', emails.length)
  emails.forEach(function (r) { if (String(eMail(r)).trim()) emailOf[String(eId(r)).trim()] = true })
  add('Members.メールアドレスが無い', 0)
  add('Members.権限の例外がある人', 0)
  add('Members.権限の例外の件数', 0)
  add('Members.最上位の役職の有効なメンバー', 0)
  members.forEach(function (r) {
    var id = String(mCol('id')(r)).trim()
    add(isInactive(r) ? 'Members.休止中' : 'Members.有効')
    if (!emailOf[id]) add('Members.メールアドレスが無い')
    var roleRef = String(mCol('role')(r)).trim()
    var role = findRole_(ctx.roles, roleRef)
    add('Members.役職.' + (role ? role.name : roleRef || '(空)'))
    if (role && role.tier === 'top' && !isInactive(r)) add('Members.最上位の役職の有効なメンバー')
    var overrides = []
    try { overrides = JSON.parse(String(mCol('permission_overrides_json')(r) || '[]')) || [] } catch (e) { overrides = [] }
    if (Array.isArray(overrides) && overrides.length) { add('Members.権限の例外がある人'); add('Members.権限の例外の件数', overrides.length) }
  })

  // プロジェクト
  var projects = withId('Projects')
  var pArchived = tableColumn_(t('Projects'), 'archived')
  add('Projects.行', projects.length)
  add('Projects.アーカイブ済み', projects.filter(function (r) { var v = pArchived(r); return v === true || String(v).toUpperCase() === 'TRUE' }).length)

  // タスク(コードにそろえて数える)
  var tasks = withId('Tasks')
  add('Tasks.行', tasks.length)
  ;[['status', 'status'], ['priority', 'priority'], ['visibility', 'visibility']].forEach(function (pair) {
    var col = tableColumn_(t('Tasks'), pair[0])
    tasks.forEach(function (r) { add('Tasks.' + pair[0] + '.' + normalizeCode_(pair[1], col(r))) })
  })
  var dCol = tableColumn_(t('Tasks'), 'department')
  tasks.forEach(function (r) { add('Tasks.department.' + (normalizeDepartment_(ctx.departments, dCol(r)) || '(未分類)')) })

  // 経費・フォームの回答・日報・候補者
  ;['Expenses', 'FormSubmissions', 'Candidates'].forEach(function (name) {
    var rows = withId(name)
    var status = tableColumn_(t(name), 'status')
    add(name + '.行', rows.length)
    rows.forEach(function (r) { add(name + '.status.' + (String(status(r)).trim() || '(空)')) })
  })
  add('DailyReports.行', withId('DailyReports').length)

  // 見つからない参照(行の数)
  MIGRATION_REFERENCE_COLUMNS.forEach(function (ref) {
    if (t(ref[0]).headers.indexOf(ref[1]) < 0) return
    var col = tableColumn_(t(ref[0]), ref[1])
    var n = withId(ref[0]).filter(function (r) { return splitIds_(col(r)).some(function (id) { return !ids[ref[2]][id] }) }).length
    add('見つからない参照.' + ref[0] + '.' + ref[1], n)
  })

  // ファイルの URL(開けるか: この GAS のアップロード先・以前のフォルダにあるか)
  var urls = []
  members.forEach(function (r) { var u = String(mCol('avatar_url')(r)).trim(); if (u) urls.push(['プロフィール画像', u]) })
  var receipt = tableColumn_(t('Expenses'), 'receipt_url')
  withId('Expenses').forEach(function (r) { var u = String(receipt(r)).trim(); if (u) urls.push(['領収書', u]) })
  var sKey = tableColumn_(t('Settings'), 'key')
  var sValue = tableColumn_(t('Settings'), 'value')
  t('Settings').rows.forEach(function (r) { if (String(sKey(r)) === 'org_logo_url' && String(sValue(r)).trim()) urls.push(['団体ロゴ', String(sValue(r)).trim()]) })
  add('ファイル.開けない', 0)
  add('ファイル.確かめていない', 0)
  urls.forEach(function (u) {
    add('ファイル.' + u[0])
    var ok = ctx.fileOk ? ctx.fileOk(u[1]) : null
    if (ok === null) add('ファイル.確かめていない')
    else if (!ok) add('ファイル.開けない')
  })

  // Settings のキー
  var keys = t('Settings').rows.map(function (r) { return String(sKey(r)).trim() }).filter(Boolean).sort()
  add('Settings.キー', keys.length)
  return { counts: counts, settingsKeys: keys }
}

// N1 の実行ログの行。previous(前回の結果)があれば、違う数だけを最後に並べる
function formatMigrationCounts_(report, previous) {
  var lines = ['■ 移行の点検(数)']
  Object.keys(report.counts).sort().forEach(function (k) { lines.push('  ' + k + ': ' + report.counts[k]) })
  lines.push('■ Settings のキー: ' + report.settingsKeys.join('、'))
  if (!previous || !previous.counts) {
    lines.push('■ 前回の結果はありません(この結果を覚えました。次に実行した時に、違う数を出します)')
    return lines
  }
  var keys = {}
  Object.keys(report.counts).concat(Object.keys(previous.counts)).forEach(function (k) { keys[k] = true })
  var diffs = Object.keys(keys).sort().filter(function (k) { return (report.counts[k] || 0) !== (previous.counts[k] || 0) })
  lines.push(diffs.length
    ? '■ 前回(' + previous.at + (previous.spreadsheet ? '・' + previous.spreadsheet : '') + ')と違う数: ' + diffs.length + '件'
    : '■ 前回(' + previous.at + (previous.spreadsheet ? '・' + previous.spreadsheet : '') + ')と同じです')
  diffs.forEach(function (k) { lines.push('  ' + k + ': ' + (previous.counts[k] || 0) + ' → ' + (report.counts[k] || 0)) })
  return lines
}

// N3: Orbit のシートを、移行(migrateToInternalCodes)と同じ変換で、移行した後の形にする。
// 役職の ID は、今の役職の一覧と同じ ID にする(新しい ID を作らない)
function convertOrbitTables_(orbit, currentRoles, topRoleName) {
  var roleIdsByName = {}
  ;(currentRoles || []).forEach(function (r) { roleIdsByName[r.name] = r.id })
  var copy = {}
  Object.keys(orbit).forEach(function (name) {
    copy[name] = { headers: orbit[name].headers.slice(), rows: orbit[name].rows.map(function (r) { return r.slice() }) }
  })
  var plan = planMigration_(copy, { topRoleName: topRoleName, roleIdsByName: roleIdsByName })
  Object.keys(plan.cells).forEach(function (name) {
    plan.cells[name].forEach(function (cell) { copy[name].rows[cell[0]][cell[1]] = cell[2] })
  })
  var st = copy.Settings
  if (st && st.headers.indexOf('key') >= 0) {
    var k = st.headers.indexOf('key')
    var v = st.headers.indexOf('value')
    Object.keys(plan.settings).forEach(function (key) {
      var row = null
      st.rows.forEach(function (r) { if (String(r[k]) === key) row = r })
      if (!row) { row = st.headers.map(function () { return '' }); row[k] = key; st.rows.push(row) }
      row[v] = plan.settings[key]
    })
  }
  return copy
}

function cellText_(v) {
  if (v instanceof Date) return v.toISOString()
  return v === null || v === undefined ? '' : String(v)
}

// N3 の差分(Google のサービスを使わない純粋な関数)。行は id(Settings は key)で対応させる。
// 返り値: { シート名: { added: [行の値], deleted: [行の値], changed: [{ id, row, columns: [{ name, before, after }] }] } }
function diffMigrationTables_(before, after) {
  var out = {}
  MIGRATION_REPORT_SHEETS.forEach(function (name) {
    var b = before[name] || { headers: [], rows: [] }
    var a = after[name] || { headers: [], rows: [] }
    var keyName = name === 'Settings' ? 'key' : 'id'
    var ignored = MIGRATION_DIFF_IGNORED[name] || []
    var toMap = function (table) {
      var c = table.headers.indexOf(keyName)
      var map = {}
      if (c < 0) return map
      table.rows.forEach(function (r) {
        var id = cellText_(r[c]).trim()
        if (!id) return
        var obj = {}
        table.headers.forEach(function (h, i) { if (h) obj[h] = cellText_(r[i]) })
        map[id] = obj
      })
      return map
    }
    var bm = toMap(b)
    var am = toMap(a)
    var result = { added: [], deleted: [], changed: [] }
    Object.keys(am).forEach(function (id) {
      if (name === 'Settings' && ignored.indexOf(id) >= 0) return
      if (!bm[id]) { result.added.push(am[id]); return }
      var cols = []
      Object.keys(am[id]).forEach(function (h) {
        if (ignored.indexOf(h) >= 0) return
        var was = Object.prototype.hasOwnProperty.call(bm[id], h) ? bm[id][h] : ''
        if (was !== am[id][h]) cols.push({ name: h, before: was, after: am[id][h] })
      })
      if (cols.length) result.changed.push({ id: id, row: am[id], columns: cols })
    })
    Object.keys(bm).forEach(function (id) {
      if (name === 'Settings' && ignored.indexOf(id) >= 0) return
      if (!am[id]) result.deleted.push(bm[id])
    })
    out[name] = result
  })
  return out
}

// N3 の実行ログの行(値は日本語で。メールアドレスは出さない)
function formatMigrationDiff_(diff, ctx) {
  var lines = ['■ 元の Orbit と比べて、切り替えの後に Ohsumi で変わった行(値は Orbit に入れ直す形の日本語)']
  var total = 0
  var label = function (sheet, col, value) {
    if (sheet === 'MemberEmails' && col === 'email') return value ? '(メールアドレス。実行ログには出しません)' : ''
    var v = String(value)
    if (sheet === 'Tasks' && MIGRATION_TASK_CODE_COLUMNS[col]) {
      var labels = VALUE_CODES[MIGRATION_TASK_CODE_COLUMNS[col]].sheetLabels
      if (Object.prototype.hasOwnProperty.call(labels, v)) v = labels[v]
    } else if (sheet === 'Tasks' && col === 'department') {
      var d = findDepartment_(ctx.departments, v)
      v = d ? d.name : v || UNCATEGORIZED_NAME
    } else if (sheet === 'Members' && col === 'role') {
      var r = findRole_(ctx.roles, v)
      if (r) v = r.name
    }
    return v.length > 120 ? v.slice(0, 120) + '…' : v
  }
  var nameOf = function (sheet, row) {
    var title = row.title || row.name || row.key || ''
    return (row.id ? 'id ' + row.id : '') + (title ? '「' + String(title).slice(0, 40) + '」' : '')
  }
  Object.keys(diff).forEach(function (sheet) {
    var d = diff[sheet]
    var n = d.added.length + d.changed.length + d.deleted.length
    if (!n) return
    total += n
    lines.push('■ ' + sheet + ': 追加 ' + d.added.length + '件・変更 ' + d.changed.length + '件・削除 ' + d.deleted.length + '件')
    d.added.forEach(function (row) {
      var shown = Object.keys(row).filter(function (h) { return row[h] !== '' && h !== 'id' }).slice(0, 8)
        .map(function (h) { return h + '=' + label(sheet, h, row[h]) })
      lines.push('  追加 ' + nameOf(sheet, row) + (shown.length ? ': ' + shown.join('、') : ''))
    })
    d.changed.forEach(function (c) {
      lines.push('  変更 ' + nameOf(sheet, c.row) + ': ' + c.columns.map(function (col) {
        return col.name + ' 「' + label(sheet, col.name, col.before) + '」→「' + label(sheet, col.name, col.after) + '」'
      }).join('、'))
    })
    d.deleted.forEach(function (row) { lines.push('  削除 ' + nameOf(sheet, row)) })
  })
  if (!total) lines.push('  変わった行はありません')
  return lines
}

// ---- バックアップ(毎日のコピーと、戻す) -------------------------------------------------
//
// 毎日の処理(dailyMaintenance)で、団体のスプレッドシートのコピーを「バックアップ」フォルダに作る
// (BACKUP_FOLDER_ID。GAS のアカウントだけが持つ。編集者・閲覧者を外し、リンクの共有も「制限付き」にする)。
// コピーするのはスプレッドシートだけ(アップロードしたファイルはコピーしない)。
// 残す数は、毎日の分 BACKUP_KEEP.daily・毎週の分 BACKUP_KEEP.weekly・毎月の分 BACKUP_KEEP.monthly(最長で約3か月)。
// 超えた古いものはゴミ箱に移す。作るのに失敗した時は BACKUP_STATE に残し、代表の管理画面に出す(getBackupStatus)。
// 戻す(代表だけ):
//   - 全体を戻す(restoreBackup): データのシートをすべてバックアップの内容に置き換える(操作の記録 AuditLog は残す)。
//     戻す前に今の状態を自動でバックアップし、戻している間は書き込みを止め(RESTORE_IN_PROGRESS)、終わったらデータの版を上げる。
//     戻す前に、シートごとの件数の差を見せる(previewRestore)
//   - 一部のタスクだけ戻す(restoreTasks): 選んだタスクの行と、そのタスクのコメント・変更の記録・進捗の記録だけを戻す。
//     バックアップの後に付いたコメントなどは残し、戻したことを変更の記録とタスクの履歴に残す
// どちらも操作の記録(AuditLog シート)に残す
var BACKUP_FOLDER_PROPERTY_KEY = 'BACKUP_FOLDER_ID'
var BACKUP_STATE_KEY = 'BACKUP_STATE'
var BACKUP_NAME_PREFIX = 'Ohsumi バックアップ '
var BACKUP_BEFORE_RESTORE_SUFFIX = '(戻す前)'
var BACKUP_KEEP = { daily: 7, weekly: 4, monthly: 3 }
var RESTORE_STATE_KEY = 'RESTORE_IN_PROGRESS'
// 戻している印が残ったまま(実行の途中で止まった時など)でも、これを過ぎたら書き込みを受け付ける
var RESTORE_STALE_MS = 30 * 60 * 1000
var RESTORE_MESSAGE = 'バックアップから戻しています。終わるまで(数分)待ってから、もう一度お試しください。'
// 戻さないシート(操作の記録は、戻した記録を含めて残す)
var RESTORE_EXCLUDED_SHEETS = ['AuditLog']
// 一部のタスクを戻す時に、行を置き換えずに合わせるもの(バックアップの後に付いたものも残す)
var RESTORE_MERGED_TASK_LISTS = ['comments_json', 'history_json', 'progress_history_json']
var RESTORE_TASKS_MAX = 50
var BACKUP_SEARCH_MAX = 30

// ファイル・フォルダを、GAS のアカウントだけが持つようにする
function makeDrivePrivate_(file) {
  try { file.getEditors().forEach(function (u) { try { file.removeEditor(u) } catch (e) { /* 自分自身など */ } }) } catch (e) { /* 一覧を読めない時 */ }
  try { file.getViewers().forEach(function (u) { try { file.removeViewer(u) } catch (e) { /* 自分自身など */ } }) } catch (e) { /* 一覧を読めない時 */ }
  try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE) } catch (e) { /* 変えられない場合 */ }
}

function backupFolder_() {
  var props = PropertiesService.getScriptProperties()
  var id = props.getProperty(BACKUP_FOLDER_PROPERTY_KEY)
  if (id) {
    try { return DriveApp.getFolderById(id) } catch (e) { /* 消された: 作り直す */ }
  }
  var folder = DriveApp.createFolder('Ohsumi バックアップ(' + (getSettingValue_('org_name') || 'Ohsumi') + ')')
  makeDrivePrivate_(folder)
  props.setProperty(BACKUP_FOLDER_PROPERTY_KEY, folder.getId())
  return folder
}

// バックアップを1つ作る。kind: daily(毎日) / beforeRestore(戻す前)
function createBackup_(kind, nowMs) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var name = BACKUP_NAME_PREFIX + Utilities.formatDate(new Date(nowMs), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') +
    (kind === 'beforeRestore' ? BACKUP_BEFORE_RESTORE_SUFFIX : '')
  // スプレッドシートだけをコピーする(アップロードしたファイルはコピーしない)
  var copy = DriveApp.getFileById(ss.getId()).makeCopy(name, backupFolder_())
  makeDrivePrivate_(copy)
  return { id: copy.getId(), name: name, at: new Date(nowMs).toISOString(), kind: kind }
}

function readBackupState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(BACKUP_STATE_KEY) || '{}') || {} } catch (e) { return {} }
}

function writeBackupState_(fields) {
  var s = readBackupState_()
  Object.keys(fields).forEach(function (k) { s[k] = fields[k] })
  PropertiesService.getScriptProperties().setProperty(BACKUP_STATE_KEY, JSON.stringify(s))
  return s
}

// 毎日の処理から: バックアップを作り、残す数を超えた古いものをゴミ箱に移す。失敗しても毎日の処理は続ける
function dailyBackup_(nowMs) {
  nowMs = nowMs || Date.now()
  try {
    var made = createBackup_('daily', nowMs)
    writeBackupState_({ lastSuccessAt: made.at, lastName: made.name, lastFailureAt: '', lastError: '' })
  } catch (e) {
    var message = String((e && e.message) || e).slice(0, 300)
    writeBackupState_({ lastFailureAt: new Date(nowMs).toISOString(), lastError: message })
    console.error('バックアップを作れませんでした: ' + message)
    return null
  }
  try { pruneBackups_(nowMs) } catch (e) { console.error('古いバックアップを片付けられませんでした: ' + e) }
  return made
}

// 画面に出す状態: 最後に作れた日時と、最後に作れなかった日時(作れた後にまた作れた時は出さない)
function backupStatus_() {
  var s = readBackupState_()
  var failed = !!s.lastFailureAt && !(Date.parse(s.lastSuccessAt || '') > Date.parse(s.lastFailureAt))
  return { lastSuccessAt: String(s.lastSuccessAt || ''), failed: failed, failedAt: failed ? String(s.lastFailureAt) : '', error: failed ? String(s.lastError || '') : '' }
}

// バックアップの一覧(新しい順)。フォルダの中の、名前が BACKUP_NAME_PREFIX で始まるスプレッドシートだけ
function listBackups_() {
  var out = []
  var files = backupFolder_().getFiles()
  while (files.hasNext()) {
    var f = files.next()
    var name = String(f.getName())
    if (name.indexOf(BACKUP_NAME_PREFIX) !== 0) continue
    out.push({ id: String(f.getId()), name: name, at: new Date(f.getDateCreated()).toISOString(),
      kind: name.slice(-BACKUP_BEFORE_RESTORE_SUFFIX.length) === BACKUP_BEFORE_RESTORE_SUFFIX ? 'beforeRestore' : 'daily' })
  }
  out.sort(function (a, b) { return Date.parse(b.at) - Date.parse(a.at) })
  return out
}

// 日付の区切り(日・週・月)。週は月曜日から
function backupPeriodKeys_(ms, tz) {
  var parts = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd-u').split('-')
  var dow = Number(parts[3]) || 1
  var monday = Utilities.formatDate(new Date(ms - (dow - 1) * 24 * 3600 * 1000), tz, 'yyyy-MM-dd')
  return { day: parts.slice(0, 3).join('-'), week: monday, month: parts[0] + '-' + parts[1] }
}

// 残すバックアップの ID(純粋な関数)。entries は新しい順に並べたもの { id, at }。
// 毎日の分: 新しい順に BACKUP_KEEP.daily 個 / 毎週の分: 週ごとに一番新しいものを、新しい週から BACKUP_KEEP.weekly 週 /
// 毎月の分: 月ごとに一番新しいものを、新しい月から BACKUP_KEEP.monthly か月
function backupsToKeep_(entries, keysOf) {
  var keep = {}
  entries.slice(0, BACKUP_KEEP.daily).forEach(function (e) { keep[e.id] = true })
  var pick = function (kind, count) {
    var seen = {}
    var n = 0
    entries.forEach(function (e) {
      var k = keysOf(e)[kind]
      if (seen[k] || n >= count) return
      seen[k] = true
      n++
      keep[e.id] = true
    })
  }
  pick('week', BACKUP_KEEP.weekly)
  pick('month', BACKUP_KEEP.monthly)
  return keep
}

// 残す数を超えた古いバックアップを、ゴミ箱に移す。移した数を返す
function pruneBackups_(nowMs) {
  var tz = Session.getScriptTimeZone()
  var entries = listBackups_().map(function (b) { return { id: b.id, at: Date.parse(b.at) } })
  var keep = backupsToKeep_(entries, function (e) { return backupPeriodKeys_(e.at, tz) })
  var removed = 0
  entries.forEach(function (e) {
    if (keep[e.id]) return
    DriveApp.getFileById(e.id).setTrashed(true)
    removed++
  })
  return removed
}

// 画面から受け取ったバックアップの ID が、バックアップのフォルダの中のものか(ほかのファイルは開かない)
function backupById_(backupId) {
  var id = String(backupId || '')
  var found = null
  listBackups_().forEach(function (b) { if (b.id === id) found = b })
  if (!found) throw userError_('そのバックアップは見つかりません。一覧を読み直してください。')
  return found
}

// ---- 戻している間 ----

function restoreInProgress_() {
  var raw = PropertiesService.getScriptProperties().getProperty(RESTORE_STATE_KEY)
  if (!raw) return null
  var s = null
  try { s = JSON.parse(raw) } catch (e) { s = null }
  if (!s || !(Date.now() - Date.parse(s.startedAt || '') < RESTORE_STALE_MS)) return null
  return s
}

// ---- 操作の記録(団体のスプレッドシートの AuditLog シート) ----
var AUDIT_LOG_HEADERS = ['at', 'actor_id', 'action', 'target', 'detail_json']

function appendOrgAudit_(actorId, action, target, detail) {
  var sheet = getOrCreateSheet_('AuditLog', AUDIT_LOG_HEADERS)
  var values = { at: new Date().toISOString(), actor_id: String(actorId || ''), action: String(action), target: String(target || ''), detail_json: JSON.stringify(detail || {}) }
  var headers = headerRow_(sheet)
  var row = headers.map(function (h) { return values[h] === undefined ? '' : values[h] })
  sheet.appendRow(row)
}

// ---- 全体を戻す ----

// シートを { 名前: 値の2次元配列 } で読む
function sheetValuesOf_(spreadsheet) {
  var out = {}
  spreadsheet.getSheets().forEach(function (s) {
    var name = String(s.getName())
    if (RESTORE_EXCLUDED_SHEETS.indexOf(name) >= 0) return
    out[name] = s.getDataRange().getValues()
  })
  return out
}

function dataRowCount_(values) {
  return Math.max(0, (values || []).filter(function (r) { return r.some(function (v) { return v !== '' && v !== null }) }).length - 1)
}

// 戻す前に見せる、シートごとの件数(今・バックアップ)
function previewRestore_(backupId) {
  var b = backupById_(backupId)
  var current = sheetValuesOf_(SpreadsheetApp.getActiveSpreadsheet())
  var backup = sheetValuesOf_(SpreadsheetApp.openById(b.id))
  var names = Object.keys(backup)
  Object.keys(current).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n) })
  return {
    backup: b,
    sheets: names.map(function (n) {
      return { name: n, current: n in current ? dataRowCount_(current[n]) : null, backup: n in backup ? dataRowCount_(backup[n]) : null }
    }),
  }
}

// 全体を戻す(代表だけ。ロックを取った書き込みの中で呼ぶ)
function restoreBackup_(backupId, actorId, nowMs) {
  nowMs = nowMs || Date.now()
  var b = backupById_(backupId)
  var props = PropertiesService.getScriptProperties()
  props.setProperty(RESTORE_STATE_KEY, JSON.stringify({ by: actorId, startedAt: new Date(nowMs).toISOString(), backupId: b.id }))
  try {
    var before = createBackup_('beforeRestore', nowMs)
    var src = SpreadsheetApp.openById(b.id)
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    var restored = []
    src.getSheets().forEach(function (s) {
      var name = String(s.getName())
      if (RESTORE_EXCLUDED_SHEETS.indexOf(name) >= 0) return
      var range = s.getDataRange()
      var values = range.getValues()
      var formats = range.getNumberFormats()
      var dst = ss.getSheetByName(name) || ss.insertSheet(name)
      dst.clearContents()
      if (values.length && values[0].length) {
        var target = dst.getRange(1, 1, values.length, values[0].length)
        // 書式(文字として扱う列など)を先に戻し、値が数式として扱われないようにする
        target.setNumberFormats(formats)
        target.setValues(values)
      }
      restored.push(name)
    })
    SpreadsheetApp.flush()
    forgetSheetGrid_()
    bumpDataVersion()
    bumpMemberEmailsVersion_()
    appendOrgAudit_(actorId, 'restoreBackup', b.name, { backupId: b.id, beforeRestore: before.name, sheets: restored })
    // 戻した中に、保存期間を過ぎた個人情報があれば、すぐに消し直す
    purgeExpiredPersonalData_(nowMs, actorId)
    try { pruneBackups_(nowMs) } catch (e) { console.error('古いバックアップを片付けられませんでした: ' + e) }
    return { restored: restored, beforeRestore: before }
  } finally {
    props.deleteProperty(RESTORE_STATE_KEY)
  }
}

// ---- 一部のタスクだけ戻す ----

function taskTableOf_(values) {
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rows = {}
  values.slice(1).forEach(function (r) {
    var id = idCol >= 0 ? String(r[idCol]) : ''
    if (!id) return
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    rows[id] = o
  })
  return { headers: headers, rows: rows }
}

function parseJsonList_(v) {
  try {
    var list = JSON.parse(String(v || '[]'))
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function listCellText_(v) { return String(v === null || v === undefined ? '' : v).slice(0, 200) }

// バックアップのタスクを名前で探し、今の内容との違いを返す。今は消えているタスクは state: 'missing'(画面は「復元」と出す)
function searchBackupTasks_(backupId, query) {
  var b = backupById_(backupId)
  var q = String(query || '').trim().toLowerCase()
  if (!q) throw userError_('タスクの名前を入れてください。')
  var backup = taskTableOf_(SpreadsheetApp.openById(b.id).getSheetByName(SHEET_TASKS).getDataRange().getValues())
  var current = taskTableOf_(getSheet_(SHEET_TASKS).getDataRange().getValues())
  var out = []
  Object.keys(backup.rows).forEach(function (id) {
    var bt = backup.rows[id]
    if (out.length >= BACKUP_SEARCH_MAX || String(bt.title || '').toLowerCase().indexOf(q) < 0) return
    var ct = current.rows[id]
    var diffs = []
    if (ct) {
      backup.headers.forEach(function (h) {
        if (!h || h === 'id' || h === 'last_activity') return
        var bv = String(bt[h] === undefined ? '' : bt[h])
        var cv = String(ct[h] === undefined ? '' : ct[h])
        if (bv === cv) return
        if (RESTORE_MERGED_TASK_LISTS.indexOf(h) >= 0) {
          diffs.push({ field: h, current: parseJsonList_(cv).length + '件', backup: parseJsonList_(bv).length + '件' })
        } else {
          diffs.push({ field: h, current: listCellText_(cv), backup: listCellText_(bv) })
        }
      })
    }
    out.push({ id: id, title: String(bt.title || ''), currentTitle: ct ? String(ct.title || '') : '', state: !ct ? 'missing' : diffs.length ? 'changed' : 'same', diffs: diffs })
  })
  return { backup: b, tasks: out }
}

// 記録の一覧を合わせる: バックアップの内容に、バックアップの後に付いたもの(ID が無いものは中身で比べる)を足す
function mergeTaskList_(backupList, currentList, newestFirst) {
  var keyOf = function (e) { return e && e.id ? 'id:' + e.id : 'v:' + JSON.stringify(e) }
  var seen = {}
  backupList.forEach(function (e) { seen[keyOf(e)] = true })
  var added = currentList.filter(function (e) { return !seen[keyOf(e)] })
  return newestFirst ? added.concat(backupList) : backupList.concat(added)
}

// 選んだタスクを戻す(代表だけ。ロックを取った書き込みの中で呼ぶ)
function restoreTasks_(backupId, taskIds, actorId, nowMs) {
  nowMs = nowMs || Date.now()
  var b = backupById_(backupId)
  var ids = []
  ;(Array.isArray(taskIds) ? taskIds : []).forEach(function (id) { if (id && ids.indexOf(String(id)) < 0) ids.push(String(id)) })
  if (!ids.length) throw userError_('戻すタスクを選んでください。')
  if (ids.length > RESTORE_TASKS_MAX) throw userError_('一度に戻せるタスクは ' + RESTORE_TASKS_MAX + ' 件までです。')
  var srcSheet = SpreadsheetApp.openById(b.id).getSheetByName(SHEET_TASKS)
  var srcValues = srcSheet.getDataRange().getValues()
  var backup = taskTableOf_(srcValues)
  var sheet = getSheet_(SHEET_TASKS)
  var liveValues = sheet.getDataRange().getValues()
  var headers = (liveValues[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rowOf = {}
  for (var i = 1; i < liveValues.length; i++) rowOf[String(liveValues[i][idCol])] = i
  var label = Utilities.formatDate(new Date(b.at), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  var done = []
  ids.forEach(function (id) {
    var bt = backup.rows[id]
    if (!bt) return
    var cur = rowOf[id] !== undefined ? liveValues[rowOf[id]] : null
    var row = headers.map(function (h, c) {
      if (RESTORE_MERGED_TASK_LISTS.indexOf(h) < 0) return bt[h] === undefined ? (cur ? cur[c] : '') : bt[h]
      var merged = mergeTaskList_(parseJsonList_(bt[h]), parseJsonList_(cur ? cur[c] : '[]'), h === 'history_json')
      if (h === 'history_json') {
        merged.unshift({ id: 'h-restore-' + Utilities.getUuid(), at: new Date(nowMs).toISOString(), byId: String(actorId), field: 'restored', from: label, to: '' })
        merged = merged.slice(0, HISTORY_CAP)
      }
      return JSON.stringify(merged)
    })
    var rowNumber = cur ? rowOf[id] + 1 : sheet.getLastRow() + 1
    var target = sheet.getRange(rowNumber, 1, 1, headers.length)
    // 文字として扱う列は、値を書く前に書式を文字にする(数式として扱われないように)
    protectRowFromFormulaInjection_(sheet, headers, rowNumber, SHEET_TASKS)
    target.setValues([row])
    if (!cur) rowOf[id] = rowNumber - 1
    done.push({ id: id, title: String(bt.title || ''), state: cur ? 'restored' : 'recreated' })
  })
  // データの版は、書き込みの後の bumpVersionsAfterWrite_ が上げる
  forgetSheetGrid_(SHEET_TASKS)
  appendOrgAudit_(actorId, 'restoreTasks', b.name, { backupId: b.id, tasks: done })
  // 戻した中に、保存期間を過ぎた個人情報があれば、すぐに消し直す
  purgeExpiredPersonalData_(nowMs, actorId)
  return { restored: done }
}

// ---- 個人情報の削除(退会したメンバー・採用しなかった候補者) -----------------------------------
//
// 退会(removeMember)は、押した時点ではメンバーを非表示にして保留する: ログインできなくし(inactive)、
// 未完了のタスクは未アサインに戻す(完了・確認待ちのタスクの担当は残す)。個人情報は、保存期間
// (Settings の personal_data_retention_days。既定 30 日、代表が 7〜365 日で変えられる)を過ぎたら、毎日の処理で消す。
// 期限の前なら、代表は「退会を取り消す」「すぐ消す」「延長」ができる。
//   - 退会したメンバー: メールアドレス(MemberEmails の行)・プロフィール・Will・スキル・自己申告の実績・1on1 の記録・
//     ログインの記録を消す。Members の行は ID と役職だけを残し、名前を「退会したメンバー」にする
//     (タスクの担当・コメント・変更の記録の書いた人は、ID のまま残り、画面には「退会したメンバー」と出る)
//   - 採用しなかった候補者(Candidates の status が rejected): 行ごと消す
// 消す PERSONAL_DATA_NOTICE_DAYS 日前から、代表の管理画面に「○人分を○日に消します」と出す(getPersonalDataStatus)。
// バックアップから戻した直後にも、期限を過ぎた分を消し直す。消したことは操作の記録(AuditLog)に残す
var PERSONAL_DATA_RETENTION_KEY = 'personal_data_retention_days'
var PERSONAL_DATA_RETENTION = { min: 7, max: 365, defaultDays: 30 }
var PERSONAL_DATA_NOTICE_DAYS = 7
var WITHDRAWN_MEMBER_NAME = '退会したメンバー'
var WITHDRAWN_MEMBER_MESSAGE = 'このアカウントは退会しています。もう一度使う時は、代表に依頼してください。'
// 消した後も Members に残す列(これ以外は空にする)
var MEMBER_COLUMNS_KEPT_AFTER_PURGE = ['id', 'name', 'role', 'inactive', 'withdrawn_at', 'purge_at', 'personal_data_purged_at']
// 退会の時に担当を残すタスクの状態(それ以外は未アサインに戻す)
var WITHDRAW_KEEP_ASSIGNEE_STATUSES = ['done', 'review']

function personalDataRetentionDays_() {
  var n = Math.floor(Number(getSettingValue_(PERSONAL_DATA_RETENTION_KEY)))
  if (!(n >= PERSONAL_DATA_RETENTION.min && n <= PERSONAL_DATA_RETENTION.max)) return PERSONAL_DATA_RETENTION.defaultDays
  return n
}

// ログインできない理由(退会・休止)
function inactiveMessageOf_(memberId) {
  var row = null
  try { row = snapshotRowOrSheet_(SHEET_MEMBERS, memberId) } catch (e) { row = null }
  return row && String(row.withdrawn_at || '') ? WITHDRAWN_MEMBER_MESSAGE : INACTIVE_MEMBER_MESSAGE
}

function timeOfCell_(v) {
  if (v instanceof Date) return v.getTime()
  var t = Date.parse(String(v || ''))
  return isFinite(t) ? t : NaN
}

// 消す日時(ミリ秒)。延長した時は purge_at、それ以外は 退会・不採用の日時 + 保存期間
function purgeDeadlineOf_(row, kind, days) {
  var explicit = timeOfCell_(row.purge_at)
  if (explicit > 0) return explicit
  var since = kind === 'member' ? timeOfCell_(row.withdrawn_at) : (timeOfCell_(row.rejected_at) > 0 ? timeOfCell_(row.rejected_at) : timeOfCell_(row.updated_at))
  return since > 0 ? since + days * 24 * 3600 * 1000 : NaN
}

function sheetRowsAsObjects_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
  if (!sheet) return []
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  return values.slice(1).map(function (r) {
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    return o
  }).filter(function (o) { return String(o.id || '') })
}

// 消す前の人の一覧: { kind: member | candidate, id, name, since, purgeAt }
function pendingPersonalData_(days) {
  var out = []
  sheetRowsAsObjects_(SHEET_MEMBERS).forEach(function (m) {
    if (!String(m.withdrawn_at || '') || String(m.personal_data_purged_at || '')) return
    var at = purgeDeadlineOf_(m, 'member', days)
    out.push({ kind: 'member', id: String(m.id), name: String(m.display_name || m.name || ''), since: new Date(timeOfCell_(m.withdrawn_at)).toISOString(),
      purgeAt: at > 0 ? new Date(at).toISOString() : '', extended: timeOfCell_(m.purge_at) > 0 })
  })
  sheetRowsAsObjects_(SHEET_CANDIDATES).forEach(function (c) {
    if (String(c.status || '') !== 'rejected') return
    var at = purgeDeadlineOf_(c, 'candidate', days)
    var since = timeOfCell_(c.rejected_at) > 0 ? timeOfCell_(c.rejected_at) : timeOfCell_(c.updated_at)
    out.push({ kind: 'candidate', id: String(c.id), name: String(c.name || ''), since: since > 0 ? new Date(since).toISOString() : '',
      purgeAt: at > 0 ? new Date(at).toISOString() : '', extended: timeOfCell_(c.purge_at) > 0 })
  })
  out.sort(function (a, b) { return String(a.purgeAt).localeCompare(String(b.purgeAt)) })
  return out
}

// 管理画面(代表): 保存期間・消す前の人・7日以内に消す人数(日ごと)
function personalDataStatus_(nowMs) {
  var days = personalDataRetentionDays_()
  var pending = pendingPersonalData_(days)
  var tz = Session.getScriptTimeZone()
  var byDate = {}
  pending.forEach(function (p) {
    var at = Date.parse(p.purgeAt)
    if (!(at > 0) || at - nowMs > tunable_('personalDataNoticeDays', PERSONAL_DATA_NOTICE_DAYS) * 24 * 3600 * 1000) return
    var d = Utilities.formatDate(new Date(Math.max(at, nowMs)), tz, 'yyyy-MM-dd')
    byDate[d] = (byDate[d] || 0) + 1
  })
  return {
    retentionDays: days, min: PERSONAL_DATA_RETENTION.min, max: PERSONAL_DATA_RETENTION.max, noticeDays: tunable_('personalDataNoticeDays', PERSONAL_DATA_NOTICE_DAYS),
    pending: pending,
    orphanEmails: orphanEmailRows_(),
    upcoming: Object.keys(byDate).sort().map(function (d) { return { date: d, count: byDate[d] } }),
  }
}

function setPersonalDataRetention_(days, actorId) {
  var n = Math.floor(Number(days))
  if (!(n >= PERSONAL_DATA_RETENTION.min && n <= PERSONAL_DATA_RETENTION.max)) {
    throw userError_('保存期間は ' + PERSONAL_DATA_RETENTION.min + '〜' + PERSONAL_DATA_RETENTION.max + ' 日の間で決めてください。')
  }
  var before = personalDataRetentionDays_()
  updateSetting_(PERSONAL_DATA_RETENTION_KEY, String(n))
  appendOrgAudit_(actorId, 'setPersonalDataRetention', '', { before: before, after: n })
  return { retentionDays: n }
}

// 退会したメンバーの個人情報を消す
function purgeMember_(memberId, nowMs) {
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var fields = {}
  headers.forEach(function (h) {
    if (!h || MEMBER_COLUMNS_KEPT_AFTER_PURGE.indexOf(h) >= 0) return
    fields[h] = ''
  })
  fields.name = WITHDRAWN_MEMBER_NAME
  fields.inactive = 'TRUE'
  fields.purge_at = ''
  fields.personal_data_purged_at = new Date(nowMs).toISOString()
  // メールアドレスは、まとめ・キューの片付けに使ってから消す
  var emails = String(getAllMemberEmails_()[String(memberId)] || '')
  updateRowFields_(SHEET_MEMBERS, memberId, fields)
  deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return String(o.id) === String(memberId) })
  forgetPersonalProps_(memberId, emails)
  bumpMemberEmailsVersion_()
  // カレンダーの予定のゲストからメールアドレスを外し、プロフィール画像のファイルを消す(できなくても、ほかの削除は済ませる)
  removeCalendarGuest_(emails, nowMs)
  trashAvatarFiles_(memberId)
}

// 個人情報を消す時に、カレンダーの予定([Ohsumi] で始まる予定。前後 PURGE_CALENDAR_DAYS 日)のゲストから、そのメールアドレスを外す
var PURGE_CALENDAR_DAYS = 400
var PURGE_CALENDAR_MAX_EVENTS = 3000
function removeCalendarGuest_(emails, nowMs) {
  var list = splitEmails_([emails]).map(function (e) { return e.toLowerCase() })
  if (!list.length) return 0
  var removed = 0
  try {
    var cal = CalendarApp.getDefaultCalendar()
    var span = PURGE_CALENDAR_DAYS * 24 * 3600 * 1000
    var events = cal.getEvents(new Date(nowMs - span), new Date(nowMs + span), { search: '[Ohsumi]' }) || []
    events.slice(0, PURGE_CALENDAR_MAX_EVENTS).forEach(function (ev) {
      if (String(ev.getTitle()).indexOf('[Ohsumi]') !== 0) return
      list.forEach(function (email) {
        if (ev.getGuestByEmail(email)) {
          ev.removeGuest(email)
          removed++
        }
      })
    })
  } catch (e) {
    console.warn('カレンダーの予定のゲストを外せませんでした: ' + maskEmailsIn_(String(e)))
  }
  return removed
}

// 個人情報を消す時に、プロフィール画像のファイル(アップロード用のフォルダの avatar_<メンバーID>_…)をゴミ箱に移す
// (ゴミ箱のファイルは、Google ドライブが30日後に消す)
function trashAvatarFiles_(memberId) {
  var trashed = 0
  try {
    var folderId = PropertiesService.getScriptProperties().getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
    if (!folderId) return 0
    var prefix = 'avatar_' + memberId + '_'
    var files = DriveApp.getFolderById(folderId).getFiles()
    while (files.hasNext()) {
      var f = files.next()
      if (String(f.getName()).indexOf(prefix) === 0) {
        f.setTrashed(true)
        trashed++
      }
    }
  } catch (e) {
    console.warn('プロフィール画像のファイルを消せませんでした: ' + maskEmailsIn_(String(e)))
  }
  return trashed
}

// メンバーに結び付いたスクリプトプロパティ(通知のキュー・毎日のまとめ・書き込み待ちの最終ログイン)を消す
function forgetPersonalProps_(memberId, emails) {
  var props = PropertiesService.getScriptProperties()
  var keys = Object.keys(props.getProperties())
  var drop = {}
  drop['notif_queue_' + memberId] = true
  splitEmails_([emails]).forEach(function (e) { drop[digestKey_(e)] = true })
  keys.forEach(function (k) {
    if (drop[k] || k.indexOf(LAST_LOGIN_PENDING_PREFIX + memberId + '_') === 0) props.deleteProperty(k)
  })
}

// 条件に合う行を消す(下の行から)。消した数を返す
function deleteRowsWhere_(sheetName, test) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
  if (!sheet) return 0
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var removed = 0
  for (var i = values.length - 1; i >= 1; i--) {
    var o = {}
    headers.forEach(function (h, c) { o[h] = values[i][c] })
    if (test(o)) {
      sheet.deleteRow(i + 1)
      removed++
    }
  }
  if (removed) forgetSheetGrid_(sheetName)
  return removed
}

// 期限を過ぎた個人情報を消す(毎日の処理・バックアップから戻した直後)。ロックを取った中で呼ぶ
function purgeExpiredPersonalData_(nowMs, actorId) {
  var days = personalDataRetentionDays_()
  var done = { members: [], candidates: [] }
  pendingPersonalData_(days).forEach(function (p) {
    var at = Date.parse(p.purgeAt)
    if (!(at > 0) || at > nowMs) return
    if (p.kind === 'member') {
      purgeMember_(p.id, nowMs)
      done.members.push(p.id)
    } else {
      deleteRowsWhere_(SHEET_CANDIDATES, function (o) { return String(o.id) === p.id })
      done.candidates.push(p.id)
    }
  })
  // 対応するメンバーがいないメールアドレスの行は、ここでは消さない(代表が一覧を確かめて消す。orphanEmailRows_)
  if (done.members.length || done.candidates.length) {
    appendOrgAudit_(actorId || 'system', 'purgePersonalData', '', done)
    bumpDataVersion()
  }
  return done
}

// 対応するメンバーがいないメールアドレスの行(MemberEmails の ID が、Members に無い・個人情報を消したメンバーのもの)。
// 以前の退会(行を消していた)で残った行のほか、Orbit からの移行の直後にメンバーID の対応がずれている時にも出る。
// 今いるメンバーのメールアドレスを消してログインできなくするおそれがあるので、自動では消さない
// (代表の管理画面に件数と一覧を出し、代表が確かめて「消す」を押した時だけ消す。deleteOrphanEmails_)。
// Members が読めない(空)時は、何も出さない
function orphanEmailRows_() {
  var members = sheetRowsAsObjects_(SHEET_MEMBERS)
  if (!members.length) return []
  var active = {}
  members.forEach(function (m) { if (!String(m.personal_data_purged_at || '')) active[String(m.id)] = true })
  var out = []
  sheetRowsAsObjects_(SHEET_MEMBER_EMAILS).forEach(function (o) {
    if (!active[String(o.id)]) out.push({ id: String(o.id), email: String(o.email || '') })
  })
  return out
}

// 代表: 一覧で確かめた行だけを消す(画面が送った ID のうち、今も対応するメンバーがいないものだけ)
function deleteOrphanEmails_(ids, actorId) {
  var wanted = {}
  ;(Array.isArray(ids) ? ids : []).forEach(function (id) { if (id !== null && id !== undefined && String(id)) wanted[String(id)] = true })
  if (!Object.keys(wanted).length) throw userError_('消す行を選んでください。')
  var orphan = {}
  orphanEmailRows_().forEach(function (o) { orphan[o.id] = true })
  var targets = Object.keys(wanted).filter(function (id) { return orphan[id] })
  var removed = targets.length ? deleteRowsWhere_(SHEET_MEMBER_EMAILS, function (o) { return targets.indexOf(String(o.id)) >= 0 }) : 0
  if (removed) {
    bumpMemberEmailsVersion_()
    appendOrgAudit_(actorId, 'deleteOrphanEmails', '', { ids: targets, rows: removed })
  }
  return { deleted: removed, skipped: Object.keys(wanted).length - targets.length }
}

// 毎日の処理から(ロックを取る)
function purgeExpiredPersonalDataLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return purgeExpiredPersonalData_(nowMs, 'system')
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

function pendingEntryOf_(kind, id) {
  var found = null
  pendingPersonalData_(personalDataRetentionDays_()).forEach(function (p) { if (p.kind === kind && p.id === String(id)) found = p })
  if (!found) throw userError_('消す前の人の一覧に見つかりません。画面を読み直してください。')
  return found
}

// 代表: 特定の人だけ、すぐ消す
function purgePersonalDataNow_(kind, id, actorId, nowMs) {
  var p = pendingEntryOf_(kind, id)
  if (kind === 'member') purgeMember_(p.id, nowMs)
  else deleteRowsWhere_(SHEET_CANDIDATES, function (o) { return String(o.id) === p.id })
  appendOrgAudit_(actorId, 'purgePersonalDataNow', kind + ':' + p.id, {})
  return { purged: { kind: kind, id: p.id } }
}

// 代表: 消す日を、保存期間の分だけ延ばす(今から PERSONAL_DATA_RETENTION.max 日まで)
function extendPersonalData_(kind, id, actorId, nowMs) {
  var p = pendingEntryOf_(kind, id)
  var days = personalDataRetentionDays_()
  var base = Math.max(Date.parse(p.purgeAt) || nowMs, nowMs)
  var next = Math.min(base + days * 24 * 3600 * 1000, nowMs + PERSONAL_DATA_RETENTION.max * 24 * 3600 * 1000)
  var iso = new Date(next).toISOString()
  if (kind === 'member') updateRowFields_(SHEET_MEMBERS, p.id, { purge_at: iso })
  else { ensureCandidatesSheet_(); updateRowFields_(SHEET_CANDIDATES, p.id, { purge_at: iso }) }
  appendOrgAudit_(actorId, 'extendPersonalData', kind + ':' + p.id, { before: p.purgeAt, after: iso })
  return { purgeAt: iso }
}

// 代表: 退会を取り消す(個人情報を消す前だけ)。未アサインに戻したタスクは、戻らない。
// 退会の時に未アサインに戻したタスク(今もあるもの)の一覧を返す(画面が「○件あります」と出す。担当は代表が付け直す)
function cancelWithdrawal_(memberId, actorId) {
  var p = pendingEntryOf_('member', memberId)
  var row = findRow_(SHEET_MEMBERS, p.id) || {}
  var ids = String(row.withdrawal_unassigned_task_ids || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var tasks = []
  if (ids.length) {
    sheetRowsAsObjects_(SHEET_TASKS).forEach(function (t) {
      if (ids.indexOf(String(t.id)) < 0) return
      var assignees = String(t.assignee_id || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
      tasks.push({ id: String(t.id), title: String(t.title || ''), status: normalizeCode_('status', t.status), assigneeIds: assignees })
    })
  }
  updateRowFields_(SHEET_MEMBERS, p.id, { withdrawn_at: '', purge_at: '', inactive: '', withdrawal_unassigned_task_ids: '' })
  bumpMemberEmailsVersion_()
  appendOrgAudit_(actorId, 'cancelWithdrawal', p.id, { unassignedTasks: tasks.length })
  return { restored: p.id, unassignedTasks: tasks }
}

// ---- 毎日・毎時の処理の見張り ------------------------------------------------------------
//
// dailyMaintenance(毎朝)・sendBatchNotifications(毎時)が最後まで動いた時刻を JOB_STATE に記録する。
// レジストリへの確認(checkIn)で伝え、毎日の処理が DAILY_JOB_STALE_HOURS 時間以上成功していなければ、
// 代表の管理画面・レジストリの管理画面・監視の毎朝のまとめに出す(トリガーが消えた・権限が切れた・毎回失敗している時など)。
// setupOhsumi を実行した時刻から数え始める(installedAt)。どちらも無い団体(この版より前から使っていて、
// setupOhsumi をまだ実行していない団体)は、判定しない
var JOB_STATE_KEY = 'JOB_STATE'
var DAILY_JOB_STALE_HOURS = 26
var HOURLY_JOB_STALE_HOURS = 3

function readJobState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(JOB_STATE_KEY) || '{}') || {} } catch (e) { return {} }
}

function writeJobState_(s) {
  try { PropertiesService.getScriptProperties().setProperty(JOB_STATE_KEY, JSON.stringify(s)) } catch (e) { console.error('処理の記録を書けませんでした: ' + e) }
}

function recordJobRun_(kind, ok, err) {
  if (!ok) appendErrorLog_('job', kind === 'daily' ? 'dailyMaintenance' : 'sendBatchNotifications', errorKind_(err))
  var s = readJobState_()
  var now = new Date().toISOString()
  if (ok) {
    s[kind + 'At'] = now
  } else {
    s[kind + 'FailedAt'] = now
    s[kind + 'Error'] = maskEmailsIn_(String((err && err.message) || err || '')).slice(0, 300)
  }
  writeJobState_(s)
}

function recordJobsInstalled_(nowMs) {
  var s = readJobState_()
  s.installedAt = new Date(nowMs).toISOString()
  writeJobState_(s)
}

// 画面・レジストリに伝える形。stale: 最後に成功した時刻(無ければ setupOhsumi の時刻)から、決めた時間を過ぎた
function jobStatus_(nowMs) {
  var s = readJobState_()
  var staleOf = function (at, hours) {
    var base = Math.max(Date.parse(at || '') || 0, Date.parse(s.installedAt || '') || 0)
    return base > 0 ? nowMs - base > hours * 3600 * 1000 : false
  }
  return {
    dailyAt: String(s.dailyAt || ''), hourlyAt: String(s.hourlyAt || ''), installedAt: String(s.installedAt || ''),
    dailyFailedAt: String(s.dailyFailedAt || ''), dailyError: String(s.dailyError || ''),
    hourlyFailedAt: String(s.hourlyFailedAt || ''), hourlyError: String(s.hourlyError || ''),
    dailyStale: staleOf(s.dailyAt, tunable_('dailyJobStaleHours', DAILY_JOB_STALE_HOURS)),
    hourlyStale: staleOf(s.hourlyAt, tunable_('hourlyJobStaleHours', HOURLY_JOB_STALE_HOURS)),
    staleHours: tunable_('dailyJobStaleHours', DAILY_JOB_STALE_HOURS),
  }
}

// ---- スプレッドシート・フォルダの共有の確認 ------------------------------------------------
//
// setupOhsumi と毎日の処理で、団体のスプレッドシート・アップロード用のフォルダ・バックアップ用のフォルダの共有を確かめる。
// 許すのは、GAS のアカウント(持ち主)と、代表への「閲覧者」の共有だけ。次の時は SHARING_STATE に残し、代表の管理画面に
// 警告と直し方を出す(getOpsStatus):
//   link: リンクを知っている人・組織の全員などに共有している / editor: GAS のアカウント以外が編集者になっている
//   viewer: 代表以外の人に共有している(閲覧者・コメント可) / unknown: 確かめられなかった
var SHARING_STATE_KEY = 'SHARING_STATE'

function sharingTargets_() {
  var props = PropertiesService.getScriptProperties()
  var out = [{ key: 'spreadsheet', open: function () { return DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()) } }]
  var uploads = props.getProperty(UPLOAD_FOLDER_PROPERTY_KEY)
  if (uploads) out.push({ key: 'uploads', open: function () { return DriveApp.getFolderById(uploads) } })
  var backups = props.getProperty(BACKUP_FOLDER_PROPERTY_KEY)
  if (backups) out.push({ key: 'backups', open: function () { return DriveApp.getFolderById(backups) } })
  return out
}

function userEmailOf_(u) {
  try { return String((u && u.getEmail && u.getEmail()) || '').trim().toLowerCase() } catch (e) { return '' }
}

// 代表のメールアドレス(小文字。1人が複数持つ時はすべて)
function topEmailSet_() {
  var emails = getAllMemberEmails_()
  var set = {}
  topMemberIds_().forEach(function (id) {
    splitEmails_([emails[id] || '']).forEach(function (e) { set[e.toLowerCase()] = true })
  })
  return set
}

function checkSharing_(nowMs) {
  var me = ''
  try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase() } catch (e) { me = '' }
  var tops = topEmailSet_()
  var problems = []
  sharingTargets_().forEach(function (t) {
    try {
      var f = t.open()
      var access = String(f.getSharingAccess())
      if (access && access !== 'PRIVATE') problems.push({ target: t.key, kind: 'link', detail: access })
      f.getEditors().forEach(function (u) {
        var email = userEmailOf_(u)
        if (email && email !== me) problems.push({ target: t.key, kind: 'editor', detail: email })
      })
      f.getViewers().forEach(function (u) {
        var email = userEmailOf_(u)
        if (email && email !== me && !tops[email]) problems.push({ target: t.key, kind: 'viewer', detail: email })
      })
    } catch (e) {
      problems.push({ target: t.key, kind: 'unknown', detail: String((e && e.message) || e).slice(0, 200) })
    }
  })
  var state = { checkedAt: new Date(nowMs).toISOString(), problems: problems }
  try { PropertiesService.getScriptProperties().setProperty(SHARING_STATE_KEY, JSON.stringify(state)) } catch (e) { console.error('共有の確認の結果を書けませんでした: ' + e) }
  return state
}

function readSharingState_() {
  var s = null
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty(SHARING_STATE_KEY) || 'null') } catch (e) { s = null }
  return s && Array.isArray(s.problems) ? s : { checkedAt: '', problems: [] }
}

function sharingProblemText_(p) {
  var target = { spreadsheet: '団体のスプレッドシート', uploads: 'アップロード用のフォルダ', backups: 'バックアップ用のフォルダ' }[p.target] || p.target
  if (p.kind === 'link') return target + ': リンクを知っている人などに共有しています(' + p.detail + ')'
  if (p.kind === 'editor') return target + ': ' + p.detail + ' が編集者です'
  if (p.kind === 'viewer') return target + ': ' + p.detail + ' に共有しています'
  return target + ': 共有を確かめられませんでした(' + p.detail + ')'
}

// ---- 毎日・毎時の処理の中身(dailyMaintenance・sendBatchNotifications が、記録を付けて呼ぶ) ----

function sendBatchNotificationsUnrecorded_() {
  // 毎時のトリガーのついでに、書き込み待ちの最終ログイン日時をシートに書く
  try { flushPendingLastLogins_() } catch (e) { console.error('flushPendingLastLogins failed: ' + e) }
  // 提供停止中は、通知を送らない(機能停止中は送る)
  if (contractSuspendedNow_()) return
  // バックアップから戻している間は、通知のキューを書き換えない
  if (restoreInProgress_()) return
  var props = PropertiesService.getScriptProperties()
  var allProps = props.getProperties()
  var now = new Date()
  Object.keys(allProps).forEach(function(key) {
    if (!key.startsWith('notif_queue_')) return
    var memberId = key.replace('notif_queue_', '')
    var queue = JSON.parse(allProps[key] || '[]')
    if (queue.length === 0) return

    var emails = memberEmailsByIds_([memberId])
    if (emails.length === 0) {
      props.deleteProperty(key)
      return
    }
    // このキューは1メンバー分なので、locale判定も1回で済む
    var locales = localesByEmails_(emails)
    var loc = locales[emails[0]] || 'ja'

    // Filter by whether enough time has passed for each item based on member frequency
    var toSend = []
    var toKeep = []
    queue.forEach(function(item) {
      var freq = getNotifyFrequency_(memberId, item.kind)
      if (freq === 'none') return
      // 以前の版でキューに入った、急ぎでない種類・「1日ごと」のものは、毎日のまとめに移す
      if (!URGENT_NOTIFY_KINDS[item.kind] || freq === '1d') {
        var t = item.templates[loc] || item.templates.ja
        splitEmails_(emails).forEach(function (e) { addToDigest_(e, loc, t.subject, t.body) })
        return
      }
      if (freq === 'immediate') { toSend.push(item); return }
      var hours = freq === '3h' ? 3 : freq === '6h' ? 6 : 24
      var itemTime = new Date(item.ts)
      var elapsed = (now - itemTime) / 3600000
      if (elapsed >= hours) { toSend.push(item) } else { toKeep.push(item) }
    })

    if (toSend.length > 0) {
      var combined = toSend
        .map(function(i) {
          var tpl = i.templates[loc] || i.templates.ja
          return '【' + tpl.subject + '】\n' + tpl.body
        })
        .join('\n\n---\n\n')
      var subject = loc === 'en'
        ? 'Ohsumi Notification Summary (' + toSend.length + ')'
        : 'Ohsumi 通知まとめ (' + toSend.length + '件)'
      sendMail_({ to: emails.join(','), subject: subject, body: combined })
    }
    if (toKeep.length > 0) {
      props.setProperty(key, JSON.stringify(toKeep))
    } else {
      props.deleteProperty(key)
    }
  })
}

function dailyMaintenanceUnrecorded_() {
  // 提供停止中は、定期の処理を止める(機能停止中は続ける)
  if (contractSuspendedNow_()) return
  // バックアップから戻している間は、書き込む処理を止める
  if (restoreInProgress_()) return
  // 最初にバックアップを作る(この後の処理が失敗しても、今日のコピーは残る)
  dailyBackup_(Date.now())
  // 保存期間を過ぎた個人情報(退会したメンバー・採用しなかった候補者)を消す
  try { purgeExpiredPersonalDataLocked_(Date.now()) } catch (err) { console.error('個人情報を消せませんでした: ' + maskEmailsIn_(String(err))) }
  try {
    generateRecurringTasksLocked_()
  } catch (err) {
    // best-effort — still run the overdue sweep below
  }
  notifyOverdueTasksToDiscord_()
  notifyOverdueTasksToAssignees_()
  // 活動のないメンバーの判定より前に、書き込み待ちの最終ログイン日時を書く
  try { flushPendingLastLogins_() } catch (err) { }
  try { notifyInactiveMembers_() } catch (err) { }
  // 毎日のまとめ(1人1日1通)。上の処理で入れたものも、ここで送る
  try { flushDailyDigests_() } catch (err) { console.error('毎日のまとめを送れませんでした: ' + maskEmailsIn_(String(err))) }
  // スプレッドシート・フォルダの共有を確かめる(問題があれば代表の管理画面に出す)
  try { checkSharing_(Date.now()) } catch (err) { console.error('共有を確かめられませんでした: ' + maskEmailsIn_(String(err))) }
  // 定期タスクの生成などでシートが変わるため、読み取りキャッシュを無効にする
  bumpDataVersion()
}

// ---- 読み取り性能の計測(measureReadPerformance)の判定 ----

function kb_(chars) {
  return Math.round(chars / 1024)
}

// 計測の結果から、判定に使う値を出す(Google のサービスを使わない)
//   sizes: { jsonChars, gzipChars, viewerChars, readSheetsMs, cached }
function readPerformanceMetrics_(data, sizes) {
  var tasks = data.Tasks || { headers: [], rows: [] }
  var statusCol = tasks.headers.indexOf('status')
  var doneRows = (tasks.rows || []).filter(function (r) { return statusCol >= 0 && normalizeCode_('status', r[statusCol]) === 'done' })
  var tasksChars = JSON.stringify(tasks.rows || []).length
  var doneChars = JSON.stringify(doneRows).length
  // 1つのセルの長さ: シートと列ごとの最大と、8割を超えた件数(長い順に5つ)
  var fields = {}
  var maxLength = 0
  SNAPSHOT_SHEETS.forEach(function (name) {
    var table = data[name]
    if (!table || !table.headers) return
    ;(table.rows || []).forEach(function (row) {
      row.forEach(function (v, col) {
        var length = String(v === null || v === undefined ? '' : v).length
        var key = name + '.' + table.headers[col]
        var f = fields[key] || (fields[key] = { sheet: name, field: table.headers[col], maxLength: 0, over: 0 })
        if (length > f.maxLength) f.maxLength = length
        if (length > CELL_WARN_CHARS) f.over++
        if (length > maxLength) maxLength = length
      })
    })
  })
  var top = Object.keys(fields).map(function (k) { return fields[k] })
    .filter(function (f) { return f.maxLength > 0 })
    .sort(function (a, b) { return b.maxLength - a.maxLength })
    .slice(0, 5)
  var chunks = Math.ceil(sizes.gzipChars / SNAPSHOT_CHUNK_SIZE)
  return {
    tasks: (tasks.rows || []).length,
    doneTasks: doneRows.length,
    doneSharePercent: tasksChars > 2 ? Math.round(doneChars / tasksChars * 100) : 0,
    jsonChars: sizes.jsonChars,
    gzipChars: sizes.gzipChars,
    gzipPercent: sizes.jsonChars ? Math.round(sizes.gzipChars / sizes.jsonChars * 100) : 0,
    chunks: chunks,
    chunkPercent: Math.round(chunks / SNAPSHOT_MAX_CHUNKS * 100),
    viewerChars: sizes.viewerChars,
    readSheetsMs: sizes.readSheetsMs,
    cached: sizes.cached,
    cells: { maxLength: maxLength, maxPercent: Math.round(maxLength / CELL_MAX_CHARS * 100), top: top },
  }
}

// 移行の前に「完了から一定期間が過ぎたタスクを最初の読み込みから外す」が要るかの目安。
// 移行の後に増える分(1年ほど)を見込み、それぞれの限界の手前に置く
//   - タスクの件数: 画面が1回で受け取れるのは 3,000 件ほど → 2,000 件
//   - 閲覧者ごとの読み込みの大きさ: 3MB
//   - キャッシュの分割: 上限 60 個の 75%(45 個)。超えるとキャッシュできず、毎回シートから読む
//   - キャッシュなしのシート読み込み: 画面の読み込みの待ち時間(20秒)の、ほかの処理を除いた残り → 8秒
var READ_LIMIT_TASKS = 2000
var READ_LIMIT_VIEWER_CHARS = 3 * 1024 * 1024
var READ_LIMIT_CHUNK_PERCENT = 75
var READ_LIMIT_SHEETS_MS = 8000

function readPerformanceVerdict_(m) {
  var reasons = []
  if (m.tasks >= READ_LIMIT_TASKS) reasons.push('タスクが ' + m.tasks + ' 件(目安 ' + READ_LIMIT_TASKS + ' 件)')
  if (m.viewerChars >= READ_LIMIT_VIEWER_CHARS) reasons.push('閲覧者ごとの読み込みが ' + kb_(m.viewerChars) + ' KB(目安 ' + kb_(READ_LIMIT_VIEWER_CHARS) + ' KB)')
  if (!m.cached || m.chunkPercent >= READ_LIMIT_CHUNK_PERCENT) reasons.push('キャッシュの分割が ' + m.chunks + ' / ' + SNAPSHOT_MAX_CHUNKS + ' 個(目安 ' + READ_LIMIT_CHUNK_PERCENT + '%)')
  if (m.readSheetsMs >= READ_LIMIT_SHEETS_MS) reasons.push('キャッシュなしのシート読み込みが ' + m.readSheetsMs + ' ms(目安 ' + READ_LIMIT_SHEETS_MS + ' ms)')
  var lines = ['🧭 判定(完了から一定期間が過ぎたタスクを最初の読み込みから外す)']
  if (reasons.length) {
    lines.push('  移行の前に作る必要があります: ' + reasons.join('、'))
    lines.push('  完了のタスクの行は全体の ' + m.doneSharePercent + '% です' +
      (m.doneSharePercent < 30 ? '(外しても減る量が少ないため、ほかの方法も検討してください)' : '(外すと読み込みが減ります)'))
  } else {
    lines.push('  移行の前には要りません(すべての目安を下回っています)。移行の後も、毎月この計測で見直してください')
  }
  lines.push('🧭 判定(1つのセルの記録の長さ)')
  if (m.cells.maxLength > CELL_WARN_CHARS) {
    lines.push('  上限の8割(' + CELL_WARN_CHARS + ' 文字)を超えた記録があります。移行の前に、古い記録の整理を代表と相談してください')
  } else {
    lines.push('  上限の8割を超えた記録はありません')
  }
  return lines
}

// ---- 利用の集計とエラーの記録 ----
//
// 利用の集計(UsageDaily シート: date, kind, count): ログイン(login)・画面の読み込み(open)・書き込みの操作(操作の名前)の、
// 日ごとの回数だけを残す。誰の操作かは残さない。団体の外には送らない。
//   - リクエストごとに、キャッシュの1時間ごとの箱(usage:yyyy-MM-dd-HH)に足し、毎時の処理で前の時間の箱をシートに移す
//   - 同時に来た読み込みは数え漏れることがある(おおよその回数)
// エラーの記録(ErrorLog シート: at, source, action, kind): GAS と画面のエラーを、日時・操作の名前・エラーの種類だけ、
// 直近 ERROR_LOG_KEEP 件まで残す。リクエストの中身・エラーの文・個人情報は残さない。
var USAGE_SHEET = 'UsageDaily'
var USAGE_HEADERS = ['date', 'kind', 'count']
var USAGE_KEEP_DAYS = 400
var ERROR_LOG_SHEET = 'ErrorLog'
var ERROR_LOG_HEADERS = ['at', 'source', 'action', 'kind']
var ERROR_LOG_KEEP = 500
var USAGE_NOT_COUNTED = ['ping', 'getLoginConfig', 'reportClientError', 'getUsageStatus']

function usageBucketKey_(ms) {
  return 'usage:' + Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd-HH')
}

// このリクエストで数える種類(ログイン・読み込み・成功した書き込みの操作)。送り直しの応答は数えない
function usageKindsOf_(body, out) {
  if (!body || !out || out.replayed || !out.ok) return []
  var a = String(body.action || '')
  if (USAGE_NOT_COUNTED.indexOf(a) >= 0) return []
  if (a === 'exchangeIdToken') return out.result && out.result.memberId ? ['login'] : []
  if (a === 'getInitialData') return ['open']
  if (a === 'batch') {
    var results = (out.result && out.result.results) || []
    return (body.ops || []).filter(function (op, i) { return op && results[i] && results[i].ok }).map(function (op) { return String(op.action) })
  }
  if (READ_ONLY_ACTIONS.indexOf(a) >= 0 || LOCK_EXEMPT_ACTIONS.indexOf(a) >= 0) return []
  return [a]
}

function noteRequestUsage_(body, out) {
  try {
    var kinds = usageKindsOf_(body, out)
    if (!kinds.length) return
    var cache = CacheService.getScriptCache()
    var key = usageBucketKey_(Date.now())
    var counts = {}
    try { counts = JSON.parse(cache.get(key) || '{}') || {} } catch (e) { counts = {} }
    kinds.forEach(function (k) { counts[k] = (Number(counts[k]) || 0) + 1 })
    cache.put(key, JSON.stringify(counts), 21600)
  } catch (e) {
    // 数えられなくても応答は返す
  }
}

// 前の時間(今の時間より前、6時間以内)の箱を読む。{ 'yyyy-MM-dd': { kind: n } }
function pendingUsage_(nowMs, includeCurrent) {
  var keys = []
  for (var h = includeCurrent ? 0 : 1; h <= 6; h++) keys.push(usageBucketKey_(nowMs - h * 3600 * 1000))
  var got = CacheService.getScriptCache().getAll(keys) || {}
  var byDate = {}
  Object.keys(got).forEach(function (key) {
    var date = key.slice('usage:'.length, 'usage:'.length + 10)
    var counts = {}
    try { counts = JSON.parse(got[key] || '{}') || {} } catch (e) { counts = {} }
    var d = byDate[date] || (byDate[date] = {})
    Object.keys(counts).forEach(function (k) { d[k] = (d[k] || 0) + (Number(counts[k]) || 0) })
  })
  return { keys: Object.keys(got), byDate: byDate }
}

function readUsageSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USAGE_SHEET)
  var map = {}
  if (!sheet || sheet.getLastRow() < 2) return map
  var values = sheet.getDataRange().getValues()
  var headers = values[0].map(String)
  var dc = headers.indexOf('date'), kc = headers.indexOf('kind'), cc = headers.indexOf('count')
  for (var i = 1; i < values.length; i++) {
    var date = values[i][dc] instanceof Date ? Utilities.formatDate(values[i][dc], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(values[i][dc])
    var d = map[date] || (map[date] = {})
    d[String(values[i][kc])] = (d[String(values[i][kc])] || 0) + (Number(values[i][cc]) || 0)
  }
  return map
}

// 前の時間の箱をシートに移す(毎時の処理)。シートは日付の新しい順に書き直し、USAGE_KEEP_DAYS より古い日は消す
function flushUsage_(nowMs) {
  var pending = pendingUsage_(nowMs, false)
  if (!pending.keys.length) return 0
  var map = readUsageSheet_()
  Object.keys(pending.byDate).forEach(function (date) {
    var d = map[date] || (map[date] = {})
    Object.keys(pending.byDate[date]).forEach(function (k) { d[k] = (d[k] || 0) + pending.byDate[date][k] })
  })
  var oldest = Utilities.formatDate(new Date(nowMs - USAGE_KEEP_DAYS * 24 * 3600 * 1000), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var rows = []
  Object.keys(map).sort().reverse().forEach(function (date) {
    if (date < oldest) return
    Object.keys(map[date]).sort().forEach(function (k) { rows.push([date, k, map[date][k]]) })
  })
  var sheet = getOrCreateSheet_(USAGE_SHEET, USAGE_HEADERS)
  sheet.clearContents()
  sheet.getRange(1, 1, 1, USAGE_HEADERS.length).setValues([USAGE_HEADERS])
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@')
    sheet.getRange(2, 1, rows.length, USAGE_HEADERS.length).setValues(rows)
  }
  CacheService.getScriptCache().removeAll(pending.keys)
  return rows.length
}

// エラーの種類(文は残さない)。業務上の断り(userError_)は、競合・長すぎるなどの目印のあるものだけ
function errorKind_(err) {
  if (!err) return 'unknown'
  if (err.conflict) return 'conflict'
  if (err.cellTooLong) return 'cellTooLong'
  var quota = quotaKind_(err)
  if (quota) return 'quota:' + quota
  if (isPermissionError_(err)) return 'permission'
  if (err.isUserError) return ''
  return 'unexpected:' + String(err.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)
}

function logGasError_(err, action) {
  var kind = errorKind_(err)
  if (kind) appendErrorLog_('gas', action, kind)
}

function appendErrorLog_(source, action, kind) {
  try {
    var safeAction = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(String(action || '')) ? String(action) : ''
    var safeKind = String(kind || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || 'unknown'
    var sheet = getOrCreateSheet_(ERROR_LOG_SHEET, ERROR_LOG_HEADERS)
    var values = { at: new Date().toISOString(), source: String(source), action: safeAction, kind: safeKind }
    var headers = headerRow_(sheet)
    sheet.appendRow(headers.map(function (h) { return values[h] === undefined ? '' : values[h] }))
    var extra = sheet.getLastRow() - 1 - ERROR_LOG_KEEP
    // 多くなったら、古い行をまとめて消す(毎回は消さない)
    if (extra >= 100) sheet.deleteRows(2, extra)
  } catch (e) {
    // 記録できなくても、元の処理は続ける
  }
}

// 画面のエラーの記録。種類と操作の名前だけを受け取る(文・中身は受け取らない)。1人1時間 RATE_LIMITS.clientError 件まで
function reportClientError_(body, actorId) {
  var kind = String((body && body.kind) || '')
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(kind)) throw userError_('エラーの種類の形式が不正です。')
  if (!takeRateLimit_('clientError', actorId, 1)) return false
  appendErrorLog_('client', body.errorAction, kind)
  return true
}

// 代表の管理画面に出す、利用の集計(直近14日の毎日と、30日の操作の上位)とエラーの件数
function usageStatus_(nowMs) {
  var map = readUsageSheet_()
  var pending = pendingUsage_(nowMs, true).byDate
  Object.keys(pending).forEach(function (date) {
    var d = map[date] || (map[date] = {})
    Object.keys(pending[date]).forEach(function (k) { d[k] = (d[k] || 0) + pending[date][k] })
  })
  var tz = Session.getScriptTimeZone()
  var dayOf = function (back) { return Utilities.formatDate(new Date(nowMs - back * 24 * 3600 * 1000), tz, 'yyyy-MM-dd') }
  var days = []
  for (var i = 13; i >= 0; i--) {
    var date = dayOf(i)
    var d = map[date] || {}
    var writes = 0
    Object.keys(d).forEach(function (k) { if (k !== 'login' && k !== 'open') writes += d[k] })
    days.push({ date: date, login: d.login || 0, open: d.open || 0, writes: writes })
  }
  var since30 = dayOf(29)
  var actions = {}
  Object.keys(map).forEach(function (date) {
    if (date < since30) return
    Object.keys(map[date]).forEach(function (k) { if (k !== 'login' && k !== 'open') actions[k] = (actions[k] || 0) + map[date][k] })
  })
  var topActions = Object.keys(actions).map(function (k) { return { action: k, count: actions[k] } })
    .sort(function (a, b) { return b.count - a.count }).slice(0, 10)
  // エラー
  var recent = []
  var byKind = {}
  var last7 = 0
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ERROR_LOG_SHEET)
  if (sheet && sheet.getLastRow() >= 2) {
    var values = sheet.getDataRange().getValues()
    var h = values[0].map(String)
    var since7 = nowMs - 7 * 24 * 3600 * 1000
    for (var r = values.length - 1; r >= 1; r--) {
      var at = values[r][h.indexOf('at')]
      var atIso = at instanceof Date ? at.toISOString() : String(at)
      var row = { at: atIso, source: String(values[r][h.indexOf('source')]), action: String(values[r][h.indexOf('action')]), kind: String(values[r][h.indexOf('kind')]) }
      if (recent.length < 20) recent.push(row)
      if (Date.parse(atIso) >= since7) {
        last7++
        byKind[row.kind] = (byKind[row.kind] || 0) + 1
      }
    }
  }
  return {
    days: days,
    topActions: topActions,
    errors: {
      last7Days: last7,
      byKind: Object.keys(byKind).map(function (k) { return { kind: k, count: byKind[k] } }).sort(function (a, b) { return b.count - a.count }),
      recent: recent,
    },
  }
}

// ---- 実行ログにメールアドレスを出さない ----
// 文の中のメールアドレスを、先頭の1文字とドメインだけ残して伏せる(a***@example.com)。実行ログ・エラーの記録に使う
function maskEmailsIn_(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, '$1***@$2')
}

// ---- Google の許可(マニフェストの oauthScopes) ----
// gas/appsscript.json の oauthScopes に書いた許可だけを使う(コードが使うサービスから自動で決めない)。
// 許可が足りない時は、その操作だけを止め、直し方を返す(通知・カレンダー・共有の確かめなど、操作の一部だけのものは、
// これまでどおり、その部分だけを飛ばして操作は済ませる)
var PERMISSION_MESSAGE = 'この機能に必要な Google の許可がありません。GAS を動かしているアカウントで Apps Script エディタを開き、setupOhsumi を実行して許可してください。'

function isPermissionError_(err) {
  var msg = String((err && err.message) || err || '')
  return /You do not have permission to call|Required permissions:|Authorization is required|権限がありません.*(必要な権限|許可)/i.test(msg)
}

// ---- 定量データ(個人を特定しない集計値)を週1回 FSIF に送る ----
//
// 送るかはプランで決まる(レジストリの checkIn が伝える CONTRACT_STATE.plan):
//   ohsumi(Ohsumiプラン): 必須(いつも送る) / cosmo_base(Cosmo Baseプラン): 代表が選ぶ(初期値は送る) /
//   paid(有償プラン): 代表が選ぶ(初期値は送らない) / 未設定: 代表が選ぶ(初期値は送らない)
// 代表の選択はスクリプトプロパティ METRICS_CHOICE(on / off)。送っているかは Settings の metrics_sharing_notice に書き、
// メンバーにも画面の下に出す。各指標の定義は gas/README.md の「4.18」(定義の版 METRICS_VERSION)
// 送る曜日・時刻は団体ID から決めて、団体ごとにずらす。期間はその週(月曜日から)。失敗したら1・2・4・8時間…(最長24時間)を
// 置いて送り直す。レジストリは同じ団体・同じ期間を1件として扱う(送り直しは上書き)
var METRICS_VERSION = 1
var METRICS_HISTORY_KEEP = 12
var METRICS_RETRY_MAX_HOURS = 24

function metricsPlan_() {
  var state = null
  try { state = JSON.parse(PropertiesService.getScriptProperties().getProperty('CONTRACT_STATE') || 'null') } catch (e) { state = null }
  return state && state.plan ? String(state.plan) : ''
}

// { plan, mandatory, defaultOn, choice, enabled }
function metricsSharing_() {
  var plan = metricsPlan_()
  var choice = String(PropertiesService.getScriptProperties().getProperty('METRICS_CHOICE') || '')
  var mandatory = plan === 'ohsumi'
  var defaultOn = plan === 'ohsumi' || plan === 'cosmo_base'
  var enabled = mandatory ? true : choice === 'on' ? true : choice === 'off' ? false : defaultOn
  return { plan: plan, mandatory: mandatory, defaultOn: defaultOn, choice: choice, enabled: enabled }
}

// 団体ごとの送る曜日(0=日曜日)と時刻(1〜22時)
function metricsSlot_(orgId) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'metrics-slot:' + String(orgId || ''), Utilities.Charset.UTF_8)
  var h = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff)
  return { dow: h % 7, hour: 1 + (Math.floor(h / 7) % 22) }
}

// その時刻を含む週の月曜日(YYYY-MM-DD。スクリプトのタイムゾーン)と、その週の送る時刻(ミリ秒)
function metricsWeek_(nowMs, slot) {
  var tz = Session.getScriptTimeZone()
  var dow = Number(Utilities.formatDate(new Date(nowMs), tz, 'u')) % 7 // 1=月曜日 … 7=日曜日 → 0=日曜日
  var daysFromMonday = (dow + 6) % 7
  var monday = Utilities.formatDate(new Date(nowMs - daysFromMonday * 86400000), tz, 'yyyy-MM-dd')
  var hourNow = Number(Utilities.formatDate(new Date(nowMs), tz, 'H'))
  var minuteNow = Number(Utilities.formatDate(new Date(nowMs), tz, 'm'))
  var startOfToday = nowMs - (hourNow * 60 + minuteNow) * 60000 - (nowMs % 60000)
  var slotDays = (slot.dow + 6) % 7 // 月曜日から何日目
  var slotAt = startOfToday + (slotDays - daysFromMonday) * 86400000 + slot.hour * 3600000
  return { period: monday, slotAt: slotAt }
}

function readMetricsState_() {
  var s = null
  try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty('METRICS_STATE') || 'null') } catch (e) { s = null }
  s = s && typeof s === 'object' ? s : {}
  if (!Array.isArray(s.history)) s.history = []
  if (!s.sent || typeof s.sent !== 'object') s.sent = {}
  return s
}

function writeMetricsState_(s) {
  s.history = s.history.slice(0, METRICS_HISTORY_KEEP)
  var periods = Object.keys(s.sent).sort().reverse().slice(0, METRICS_HISTORY_KEEP)
  var sent = {}
  periods.forEach(function (p) { sent[p] = s.sent[p] })
  s.sent = sent
  PropertiesService.getScriptProperties().setProperty('METRICS_STATE', JSON.stringify(s))
}

function cellTimeMs_(v) {
  if (v instanceof Date) return v.getTime()
  var t = Date.parse(String(v || ''))
  return isFinite(t) ? t : NaN
}

// 送る集計値(定義は gas/README.md の「4.18」)。個人を特定しない数だけ
function metricsSnapshot_(nowMs) {
  var day = 86400000
  var within = function (v, days) { var t = cellTimeMs_(v); return isFinite(t) && t <= nowMs && nowMs - t < days * day }
  var table = function (name) {
    var t = snapshotTableOrSheet_(name)
    return (t.rows || []).map(function (r) { var o = {}; t.headers.forEach(function (h, i) { o[h] = r[i] }); return o })
  }
  var members = table(SHEET_MEMBERS).filter(function (m) {
    return String(m.id || '') && !boolCellValue_(m.inactive) && !String(m.withdrawn_at || '') && !String(m.personal_data_purged_at || '')
  })
  var tasks = table(SHEET_TASKS).filter(function (t) { return String(t.id || '') })
  var projects = table(SHEET_PROJECTS).filter(function (p) { return String(p.id || '') && !boolCellValue_(p.archived) })
  var today = Utilities.formatDate(new Date(nowMs), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var isDone = function (t) { return normalizeCode_('status', t.status) === 'done' }
  // ログイン・読み込み・書き込みの回数(利用の集計。直近7日)
  var usage = usageStatus_(nowMs)
  var last7 = usage.days.slice(-7)
  var sum = function (k) { return last7.reduce(function (n, d) { return n + d[k] }, 0) }
  return {
    version: METRICS_VERSION,
    members: members.length,
    active_7d: members.filter(function (m) { return within(m.last_login, 7) }).length,
    active_30d: members.filter(function (m) { return within(m.last_login, 30) }).length,
    logins_7d: sum('login'),
    opens_7d: sum('open'),
    writes_7d: sum('writes'),
    tasks: tasks.length,
    tasks_open: tasks.filter(function (t) { return !isDone(t) }).length,
    tasks_done: tasks.filter(isDone).length,
    tasks_overdue: tasks.filter(function (t) { var d = String(t.due_date || '').slice(0, 10); return !isDone(t) && d && d < today }).length,
    tasks_created_7d: tasks.filter(function (t) { return within(t.created_at, 7) }).length,
    tasks_completed_7d: tasks.filter(function (t) { return isDone(t) && within(String(t.completed_date || '').slice(0, 10) + 'T00:00:00', 7) }).length,
    projects: projects.length,
    errors_7d: usage.errors.last7Days,
  }
}

function boolCellValue_(v) {
  return v === true || /^(true|1|yes)$/i.test(String(v === undefined || v === null ? '' : v).trim())
}

// 毎時の処理から呼ぶ。送る時刻を過ぎ、その週の分をまだ送っていなければ送る(失敗したら時間を置いて送り直す)
function maybeSendMetrics_(nowMs, deps) {
  var props = PropertiesService.getScriptProperties()
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!orgId) return 'noOrg'
  var sharing = metricsSharing_()
  syncMetricsNotice_(sharing.enabled)
  if (!sharing.enabled) return 'disabled'
  if (featureDisabled_('metricsSend')) return 'featureDisabled'
  var week = metricsWeek_(nowMs, metricsSlot_(orgId))
  var state = readMetricsState_()
  if (state.sent[week.period]) return 'alreadySent'
  if (nowMs < week.slotAt) return 'notYet'
  if (state.retry && state.retry.period === week.period && nowMs < Number(state.retry.nextAt)) return 'waitingRetry'
  return sendMetricsNow_(nowMs, week.period, state, deps)
}

function sendMetricsNow_(nowMs, period, state, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = String(props.getProperty('REGISTRY_URL') || '').trim()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  var attempts = state.retry && state.retry.period === period ? Number(state.retry.attempts) + 1 : 1
  var error = ''
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) {
    error = 'レジストリに登録していません'
  } else {
    try {
      var metrics = metricsSnapshot_(nowMs)
      var ts = Math.floor(nowMs / 1000)
      var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('metrics.' + orgId + '.' + ts + '.' + period + '.' + JSON.stringify(metrics), key))
      var payload = JSON.stringify({ action: 'reportMetrics', orgId: orgId, ts: ts, period: period, metrics: metrics, sig: sig })
      var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: payload, muteHttpExceptions: true, followRedirects: true })
      var res = JSON.parse(r.getContentText())
      if (!res || !res.ok) error = String((res && res.error) || '応答の形が違います').slice(0, 200)
    } catch (e) {
      error = maskEmailsIn_(String((e && e.message) || e)).slice(0, 200)
    }
  }
  var at = new Date(nowMs).toISOString()
  state.history.unshift({ period: period, at: at, ok: !error, error: error, attempt: attempts })
  if (!error) {
    state.sent[period] = at
    delete state.retry
  } else {
    var waitHours = Math.min(tunable_('metricsRetryMaxHours', METRICS_RETRY_MAX_HOURS), Math.pow(2, attempts - 1))
    state.retry = { period: period, attempts: attempts, nextAt: nowMs + waitHours * 3600000 }
    appendErrorLog_('job', 'reportMetrics', 'metricsFailed')
  }
  writeMetricsState_(state)
  return error ? 'failed' : 'sent'
}

// 送っているかを Settings に書く(メンバーの画面の下の表示。変わった時だけ書く)
function syncMetricsNotice_(enabled) {
  var want = enabled ? 'on' : 'off'
  try {
    if (String(getSettingValue_('metrics_sharing_notice') || '') === want) return
    updateSetting_('metrics_sharing_notice', want)
    bumpDataVersion()
  } catch (e) {
    console.warn('集計値の表示を書けませんでした: ' + maskEmailsIn_(String(e)))
  }
}

// 代表の管理画面: プラン・送るか・次に送る時刻・次に送る内容(プレビュー)・送信の履歴
function metricsStatus_(nowMs) {
  var orgId = String(PropertiesService.getScriptProperties().getProperty('ORG_ID') || '')
  var sharing = metricsSharing_()
  var slot = metricsSlot_(orgId)
  var week = metricsWeek_(nowMs, slot)
  var state = readMetricsState_()
  var nextAt = week.slotAt
  if (state.sent[week.period] || nowMs >= week.slotAt) nextAt = week.slotAt + 7 * 86400000
  if (!state.sent[week.period] && state.retry && state.retry.period === week.period) nextAt = Number(state.retry.nextAt)
  else if (!state.sent[week.period] && nowMs >= week.slotAt) nextAt = nowMs
  return {
    plan: sharing.plan,
    mandatory: sharing.mandatory,
    defaultOn: sharing.defaultOn,
    enabled: sharing.enabled,
    slot: slot,
    nextAt: sharing.enabled ? new Date(nextAt).toISOString() : '',
    definitionsVersion: METRICS_VERSION,
    preview: metricsSnapshot_(nowMs),
    history: state.history,
  }
}

function setMetricsSharing_(enabled, actorId, nowMs) {
  var sharing = metricsSharing_()
  if (sharing.mandatory && !enabled) throw userError_('Ohsumiプランでは、集計値の送信は必須のため止められません。')
  PropertiesService.getScriptProperties().setProperty('METRICS_CHOICE', enabled ? 'on' : 'off')
  syncMetricsNotice_(enabled)
  appendOrgAudit_(actorId, 'setMetricsSharing', '', { before: sharing.enabled, after: enabled })
  return metricsStatus_(nowMs)
}

// ---- 診断情報(PR Q) ----------------------------------------------------------------------
//
// 代表の管理画面で、個人情報を含まない診断情報(版・設定の状態・上限の状況・直近のエラーの件数など)を見せ(getDiagnostics)、
// 確認の後にレジストリへ送って受付番号をもらう(sendDiagnostics)。
//   - 名前・メールアドレス・メンバーID・タスクの内容・エラーの文は入れない(数・あり/なし・日時・操作の名前だけ)。
//     念のため、文の中のメールアドレスは「(メールアドレス)」に置き換える
//   - 見せたものと同じものを送る(見せた時に診断ID を付けて10分覚える。過ぎたら、表示し直してもらう)
//   - 送り直しは、同じ診断ID なら同じ受付番号になる(レジストリが1件として扱う)
//   - 送った記録(受付番号・日時)は、スクリプトプロパティ DIAGNOSTICS_HISTORY に直近10件を残す
var DIAGNOSTICS_CACHE_SEC = 600
var DIAGNOSTICS_HISTORY_MAX = 10
var DIAGNOSTICS_MAX_CHARS = 30000
// スプレッドシートのセルの数の上限(Google の決まり)・スクリプトプロパティの上限(合計の目安)
var SPREADSHEET_CELL_LIMIT = 10000000
var SCRIPT_PROPERTIES_LIMIT_BYTES = 500 * 1024

function hideEmails_(text) {
  return String(text).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, '(メールアドレス)')
}

// 1つの項目で失敗しても、ほかの項目は出す(失敗した項目には、エラーの種類だけを入れる)
function diagnosticsPart_(fn) {
  try {
    return fn()
  } catch (e) {
    return { unavailable: isPermissionError_(e) ? 'permission' : (quotaKind_(e) ? 'quota' : 'error') }
  }
}

// Ohsumi が作るシートの名前(診断情報で、名前と行数を出すもの)
function ohsumiSheetNames_() {
  return Object.keys(SHEET_HEADERS).concat(['AuditLog', USAGE_SHEET, ERROR_LOG_SHEET])
}

function diagnosticsSnapshot_(nowMs) {
  var props = PropertiesService.getScriptProperties()
  var contract = readContractState_() || {}
  var snap = {
    version: OHSUMI_GAS_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    timeZone: diagnosticsPart_(function () { return Session.getScriptTimeZone() }),
    registry: diagnosticsPart_(function () {
      return {
        registered: REGISTRY_URL_PATTERN.test(String(props.getProperty('REGISTRY_URL') || '').trim()) && !!props.getProperty('REGISTRY_SHARED_KEY') && !!props.getProperty('ORG_ID'),
        plan: String(contract.plan || ''),
        contractPhase: String(contract.phase || ''),
        contractKind: String(contract.kind || ''),
        checkedAt: String(contract.checkedAt || ''),
        siteOrigins: Array.isArray(contract.siteOrigins) ? contract.siteOrigins.length : 0,
        openSurveys: Array.isArray(contract.surveys) ? contract.surveys.length : 0,
        // レジストリから止めている機能・既定と違う上限としきい値(PR W・X)
        disabledFeatures: disabledFeatures_(),
        tunables: tunablesForClient_().map(function (t) { return t.key + '=' + t.value }),
      }
    }),
    gasUpdate: diagnosticsPart_(function () { var u = gasUpdateStatus_(); return { known: u.known, required: u.required, outdated: u.outdated, latest: u.latest } }),
    settings: diagnosticsPart_(function () {
      var w = getWebhookStatus_()
      var emails = String(getSettingValue_('org_notification_emails') || '').split(/[,\s]+/).filter(Boolean)
      var sharing = metricsSharing_()
      return {
        discordWebhook: !!w.discord.configured,
        slackWebhook: !!w.slack.configured,
        orgNotificationEmails: emails.length,
        metricsSharing: !!sharing.enabled,
        triggers: diagnosticsPart_(function () { return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction() }).sort() }),
      }
    }),
    limits: diagnosticsPart_(function () {
      var q = mailQuotaStatus_()
      var long = longRecordsNow_()
      var propsText = JSON.stringify(props.getProperties() || {})
      var ss = SpreadsheetApp.getActiveSpreadsheet()
      var cells = 0
      var rows = {}
      // Ohsumi が作るシートは名前と行数。それ以外(団体が作ったシート)は名前を入れず、「その他」の枚数と行数の合計にまとめる
      var other = { sheets: 0, rows: 0 }
      var ohsumiSheets = ohsumiSheetNames_()
      ss.getSheets().forEach(function (sh) {
        cells += (Number(sh.getMaxRows()) || 0) * (Number(sh.getMaxColumns()) || 0)
        var n = Math.max(0, (Number(sh.getLastRow()) || 0) - 1)
        var name = String(sh.getName())
        if (ohsumiSheets.indexOf(name) >= 0) rows[name] = n
        else { other.sheets++; other.rows += n }
      })
      return {
        mail: { remaining: q.remaining, skippedToday: q.skipped, lastReachedDate: q.lastReachedDate },
        longRecords: { count: long.groups.reduce(function (n, g) { return n + g.count }, 0), maxLength: long.maxLength, warnAt: long.warnAt, max: long.max },
        spreadsheetCells: { used: cells, limit: SPREADSHEET_CELL_LIMIT },
        scriptProperties: { bytes: propsText.length, limit: SCRIPT_PROPERTIES_LIMIT_BYTES, keys: Object.keys(props.getProperties() || {}).length },
        rows: rows,
        otherSheets: other,
      }
    }),
    jobs: diagnosticsPart_(function () {
      var j = jobStatus_(nowMs)
      return { dailyAt: j.dailyAt, hourlyAt: j.hourlyAt, dailyStale: j.dailyStale, hourlyStale: j.hourlyStale, dailyFailedAt: j.dailyFailedAt, hourlyFailedAt: j.hourlyFailedAt }
    }),
    sharing: diagnosticsPart_(function () {
      var s = readSharingState_()
      // 誰と共有しているか(detail)は入れない。対象と種類だけ
      return { checkedAt: s.checkedAt, problems: s.problems.map(function (p) { return p.target + ':' + p.kind }) }
    }),
    backup: diagnosticsPart_(function () { var b = backupStatus_(); return { lastSuccessAt: b.lastSuccessAt, failed: b.failed, failedAt: b.failedAt } }),
    errors: diagnosticsPart_(function () {
      var u = usageStatus_(nowMs)
      var byAction = {}
      u.errors.recent.forEach(function (r) { if (Date.parse(r.at) >= nowMs - 7 * 24 * 3600 * 1000) byAction[r.action] = (byAction[r.action] || 0) + 1 })
      return { last7Days: u.errors.last7Days, byKind: u.errors.byKind, recentByAction: byAction }
    }),
  }
  return JSON.parse(hideEmails_(JSON.stringify(snap)))
}

function readDiagnosticsHistory_() {
  try {
    var list = JSON.parse(PropertiesService.getScriptProperties().getProperty('DIAGNOSTICS_HISTORY') || '[]')
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

// 代表の管理画面: 送る内容を見せる。返事: { diagId, diagnostics, history }
function diagnosticsPreview_(nowMs) {
  var diag = diagnosticsSnapshot_(nowMs)
  var diagId = 'dg_' + Utilities.getUuid().replace(/[^A-Za-z0-9]/g, '').slice(0, 20)
  try { CacheService.getScriptCache().put('diag:' + diagId, JSON.stringify(diag), DIAGNOSTICS_CACHE_SEC) } catch (e) { /* 送る時に、表示し直してもらう */ }
  return { diagId: diagId, diagnostics: diag, history: readDiagnosticsHistory_() }
}

// 代表の管理画面: 見せたものを送り、受付番号を返す。{ diagId }
function sendDiagnostics_(diagId, nowMs, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = String(props.getProperty('REGISTRY_URL') || '').trim()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) throw userError_('この団体は、レジストリに登録していないため、診断情報を送れません。表示した内容を FSIF にお伝えください。')
  if (!/^dg_[A-Za-z0-9]{8,40}$/.test(String(diagId || ''))) throw userError_('送る内容を、もう一度表示してください。')
  var text = CacheService.getScriptCache().get('diag:' + diagId)
  if (!text) throw userError_('表示してから10分を過ぎました。送る内容を、もう一度表示してください。')
  if (text.length > DIAGNOSTICS_MAX_CHARS) throw userError_('診断情報が大きすぎて送れません。FSIF にお問い合わせください。')
  var ts = Math.floor(nowMs / 1000)
  var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('diagnostics.' + orgId + '.' + ts + '.' + diagId + '.' + text, key))
  var res
  try {
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', muteHttpExceptions: true, followRedirects: true,
      payload: JSON.stringify({ action: 'receiveDiagnostics', orgId: orgId, ts: ts, diagId: diagId, diagnostics: text, sig: sig }) })
    res = JSON.parse(r.getContentText())
  } catch (e) {
    throw userError_('FSIF(レジストリ)に送れませんでした。少し待ってから、もう一度送ってください。')
  }
  if (!res || !res.ok || !res.result || !/^D\d{6}-[A-Z0-9]{4}$/.test(String(res.result.receiptNo || ''))) {
    throw userError_('FSIF(レジストリ)が受け付けませんでした(' + String((res && res.error) || '応答の形が違います').slice(0, 100) + ')。')
  }
  var entry = { receiptNo: String(res.result.receiptNo), at: new Date(nowMs).toISOString(), diagId: diagId }
  var history = readDiagnosticsHistory_().filter(function (h) { return h.diagId !== diagId })
  history.unshift(entry)
  props.setProperty('DIAGNOSTICS_HISTORY', JSON.stringify(history.slice(0, DIAGNOSTICS_HISTORY_MAX)))
  return { receiptNo: entry.receiptNo, at: entry.at, history: history.slice(0, DIAGNOSTICS_HISTORY_MAX) }
}
