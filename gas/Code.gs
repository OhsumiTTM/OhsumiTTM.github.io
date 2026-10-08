// Ohsumi — 団体の Apps Script(スプレッドシートの「データベース」の読み書き・ログイン・通知)
//
// 団体のスプレッドシートの「拡張機能」→「Apps Script」に、このファイルをそのまま貼り付け、ウェブアプリとして
// デプロイする(次のユーザーとして実行: 自分、アクセスできるユーザー: 全員)。手順は gas/README.md を参照。
// 画面(Ohsumi のサイト)は、読み取りも書き込みもこの GAS に POST で送る(doPost の action で分ける)。
//
// ■ このファイルは、リポジトリの gas/src/*.gs をファイル名の順につなげて作る(pnpm gas:build)。直すのは gas/src の方。
//   団体に配るのは、つなげたこの1つのファイル。サイトの /gas/Code.gs にも同じものを置く(代表の管理画面の「コードをコピー」)。
//   サンプル・見本のデータを作るコードは入れない(サンプル・デモの団体だけが、別のファイル gas/SampleData.gs を足す)。
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
//   makeUploadsPrivate              アップロードしたファイル(画像・領収書)を非公開にする
//   auditUploadSharing              アップロードしたファイルの公開・非公開の件数を実行ログに出す
//   protectAllExistingRows          既存の行の、数式として読まれうる列を書式なしテキストにする(値は変えない)
//   auditFormulaInjectionRisks      数式として解釈されうるセルを点検する
//   debugNotifyTest                 通知メールの宛先の登録状況を実行ログに出し、テストメールを送る
//   testPersonalDataPurge           (テスト環境だけ)TEST_DAYS_AHEAD 日だけ日付を進めて、個人情報の削除を実行する
//
// ■ ほかから呼ばれる関数(名前を変えない)
//   doGet・doPost                   ウェブアプリの入口
//   onOpen                          スプレッドシートを開いた時に「Ohsumi」メニューを出す
//   setupOhsumiFromMenu・registerWithRegistryFromMenu・regenerateInitialSetupCodeFromMenu  「Ohsumi」メニューから呼ばれる
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
  // テンプレートのコードの既定値(レジストリの URL・ログインのクライアント ID)を、プロパティが無ければ保存する
  var savedDefaults = saveCodeDefaultsToProps_(PropertiesService.getScriptProperties())
  if (savedDefaults.length) console.log('✅ コードの既定値をスクリプトプロパティに保存しました: ' + savedDefaults.join(', '))
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

  // --- コメント・1on1 などの記録を1件1行で持つシート(39-record-rows.gs)。新しい団体は最初から行に持つ ---
  var recordState = startRecordRowsIfEmpty_()
  console.log(recordState.state === 'done' ? '✅ 記録は1件1行のシート(TaskRecords・MemberRecords)に持ちます' : 'ℹ️ 記録はまだセルに持っています。ADMIN の「データの持ち方」から移せます(代表)')

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

  // --- 役職・選択肢の初期値(無い時だけ入れる。上書きはしない)---
  // 新しい団体(メンバーがまだいない)は、どの団体にも当てはまる最小限の形にする。
  // すでに動いている団体は、今の画面の既定値をそのまま保存しておく(後で画面の既定値を変えても、今の選択肢が変わらないように)
  try {
    var membersSheet = ss.getSheetByName(SHEET_MEMBERS)
    var fresh = !membersSheet || membersSheet.getLastRow() <= 1
    var seeds = fresh ? NEW_ORG_SETTINGS : EXISTING_ORG_SETTINGS
    Object.keys(seeds).forEach(function (key) {
      if (settingsData.indexOf(key) !== -1) return
      appendRowByHeaders_(settingsSheet, SHEET_SETTINGS, { key: key, value: seeds[key] })
      settingsData.push(key)
      console.log('➕ Settings 初期値追加: ' + key + (fresh ? '(新しい団体)' : '(今の既定値を保存)'))
    })
  } catch (e) { console.error('❌ 役職・選択肢の初期値: ' + e) }

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
    // 毎日の処理(バックアップ・定期タスク・個人情報の削除・期限切れの知らせ・メールのまとめなど。毎朝6時台)。
    // 以前は setupDailyTrigger でしか作られず、テンプレートから立ち上げた団体で一度も動かなかった
    var hasDaily = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'dailyMaintenance' })
    if (!hasDaily) {
      ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(6).create()
      console.log('✅ dailyMaintenance トリガー作成')
    } else {
      console.log('✅ dailyMaintenance トリガー既存')
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

  // --- 必要なトリガーがすべてそろっているか(足りなければ実行ログに出す) ---
  try {
    var have = ScriptApp.getProjectTriggers().map(function(t) { return t.getHandlerFunction() })
    var missing = REQUIRED_TRIGGERS.filter(function(name) { return have.indexOf(name) < 0 })
    if (missing.length) console.error('❌ 足りないトリガー: ' + missing.join('・') + '(もう一度 setupOhsumi を実行し、権限を許可してください)')
    else console.log('✅ トリガー: ' + REQUIRED_TRIGGERS.join('・') + ' がそろっています')
  } catch (e) { console.error('❌ トリガーの確認: ' + e) }

  console.log('🚀 setupOhsumi 完了')
}

// 新しい団体の役職・選択肢の初期値(FSIF 向けのものを外した、どの団体にも当てはまる最小限の形)
var NEW_ORG_SETTINGS = {
  roles: JSON.stringify([
    { id: 'base', name: '一般', tier: 'base' },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: 'top', name: '代表', tier: 'top' },
  ]),
  skill_options: ['企画', 'デザイン', 'ライティング', 'リサーチ', '広報', 'SNS', 'コミュニケーション', 'イベント運営', 'データ分析', '開発'].join(','),
  category_options: ['未分類', '企画', 'デザイン', '広報', 'イベント', 'リサーチ', '開発', '事務'].join(','),
  // 要求分野と、分野ごとのスキル(上の skill_options のスキルだけを使う)
  skill_field_options: ['企画', 'デザイン', '広報', '運営', 'データ・開発'].join(','),
  skill_field_skills: JSON.stringify({
    '企画': ['企画', 'リサーチ'],
    'デザイン': ['デザイン'],
    '広報': ['広報', 'SNS', 'ライティング'],
    '運営': ['イベント運営', 'コミュニケーション'],
    'データ・開発': ['データ分析', '開発'],
  }),
}
// すでに動いている団体には、今の画面の既定値を保存しておく(画面の既定値を後で変えても選択肢が変わらないように)
var EXISTING_ORG_SETTINGS = {
  skill_options: ['デザイン', 'Canva', 'PowerPoint', 'ライティング', 'リサーチ', 'SNS', '広報', 'コミュニケーション',
    'イベント運営', 'メール', 'UI/UX', '実装', '企画', '要件定義', 'プロダクト設計', '校閲', 'Claude', 'V0'].join(','),
  category_options: ['未分類', 'デザイン', '渉外', 'イベント', '広報', 'ライティング', '企画', 'リサーチ', '開発', '物品調達'].join(','),
  // 要求分野: 設定が無い時に画面が出している値(lib/ohsumi/store.tsx の DEFAULT_SKILL_FIELD_OPTIONS)。
  // 分野ごとのスキルは、設定が無い時の画面では空(GAS から読んだ設定で、画面の初期値を置き換えるため)なので、空のまま保存する
  skill_field_options: ['デザイン', '営業', 'AI活用'].join(','),
  skill_field_skills: '{}',
}

// setupOhsumi が作る、団体の GAS に必要なトリガー
var REQUIRED_TRIGGERS = ['dailyMaintenance', 'sendBatchNotifications', 'checkContractStatus', 'onSpreadsheetChange', 'onSpreadsheetEdit']

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
    console.warn('MemberEmailsシートにメールが1件も登録されていません。「個人設定」(右上のメニュー)のメールアドレスで、メンバー各自が登録する必要があります。')
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
  rememberWebAppUrl_()
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
      .addItem('初期設定', 'setupOhsumiFromMenu')
      .addItem('レジストリに登録する…', 'registerWithRegistryFromMenu')
      .addItem('初期設定コードを作り直す', 'regenerateInitialSetupCodeFromMenu')
      .addToUi()
  } catch (e) {
    // スプレッドシートを開いた時以外(エディタからの実行など)は何もしない
  }
}

// メニューの「初期設定」: エディタを開かずに setupOhsumi を実行する(初めての時は Google の許可の画面が出る)
function setupOhsumiFromMenu() {
  var ui = SpreadsheetApp.getUi()
  try {
    setupOhsumi()
    ui.alert('Ohsumi', '初期設定が終わりました。\n\n次は「デプロイ → 新しいデプロイ」でウェブアプリとして公開し、' +
      'メニューの「Ohsumi → レジストリに登録する…」に進んでください(手順は Ohsumi の案内のとおりです)。', ui.ButtonSet.OK)
  } catch (e) {
    ui.alert('Ohsumi', '初期設定を最後まで実行できませんでした: ' + toErrorMessage_(e) +
      '\n\nもう一度「Ohsumi → 初期設定」を選んでください。続く時は、表示された内容を FSIF にお伝えください。', ui.ButtonSet.OK)
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
// 停止の予定があれば、14日前・7日前・1日前に代表へメールで知らせる。レジストリに頼まれたメール(アンケートなど)も送る
function checkContractStatus() {
  var state = refreshContractState_() || readContractState_()
  // レジストリに頼まれたメール(アンケート・停止の予告など。担当者と代表あて)を、ほかのメールより先に送る
  try {
    sendRegistryMailTasks_(state)
  } catch (e) {
    console.error('レジストリからのメールを送れませんでした: ' + maskEmailsIn_(String(e)))
  }
  // 停止の予告は、レジストリが mailTasks を返す時は、そちらで代表にも届く(古いレジストリの時だけ、ここで代表に送る)
  if (!(state && Array.isArray(state.mailTasks))) {
    try {
      sendContractNotices_(state, Date.now())
    } catch (e) {
      console.error('停止の予告のメールを送れませんでした: ' + e)
    }
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
  'quiz_passes_json',         // 検定の合格の記録 [{"quizId","skill","level","at"}](スキルのレベルの条件に使う)
  'skill_approvals_json',     // スキルのレベルの承認 [{"id","skill","level","reason","byId","at"}](スキルのレベルの条件に使う)
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
  'calendar_event_id', // カレンダーの予定の ID(syncCalendarForTask_ が書く。画面には返さない)
  'deleted_at',        // ゴミ箱に入れた日時(ISO)。空なら使っているタスク。30日後に毎日の処理が行を消す
  'deleted_by',        // ゴミ箱に入れた人(メンバーID)
  'row_version', 'row_updated_by', // 書き込みの競合チェック(「行の版」)
]
var SETTINGS_HEADERS = ['key', 'value']
var EXPENSES_HEADERS = ['id', 'applicant_id', 'amount', 'category_id', 'receipt_url', 'justification', 'purpose', 'custom_field_answers_json', 'approval_steps_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var FORM_SUBMISSIONS_HEADERS = ['id', 'form_id', 'submitter_id', 'answers_json', 'approvals_json', 'current_step_index', 'status', 'created_at', 'rejection_reason']
var DAILY_REPORTS_HEADERS = ['id', 'member_id', 'type', 'report_date', 'done_text', 'todo_text', 'issues_text', 'created_at']
var CANDIDATES_HEADERS = ['id', 'name', 'email', 'phone', 'resume_text', 'interview_notes', 'status', 'created_at', 'updated_at',
  // 採用しなかった日時と、消す日時を延ばした時の日時(「個人情報の削除」)
  'rejected_at', 'purge_at']

// 本人だけが読み書きできる保存(getMyStorage・setMyStorage)。画面が決めたキーごとに、値を40000文字ずつの行に分けて持つ
var PERSONAL_STORE_HEADERS = ['id', 'key', 'part', 'value', 'updated_at'] // id はメンバーID(1人に何行もある)
// 団体の保存(getOrgStorage・setOrgStorage)。キーごとに、値を40000文字ずつの行に分けて持つ
var ORG_STORE_HEADERS = ['id', 'part', 'value', 'updated_at', 'updated_by'] // id は保存のキー(1つのキーに何行もある)
// 完了してから日数がたったタスクを移すシート(36-task-archive.gs)。Tasks と同じ列 + 移した日時
var TASKS_ARCHIVE_HEADERS = TASKS_HEADERS.concat(['archived_at'])
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
  PersonalStore: PERSONAL_STORE_HEADERS,
  OrgStore: ORG_STORE_HEADERS,
  TasksArchive: TASKS_ARCHIVE_HEADERS,
}

var SETTINGS_KEY_RECURRING_RULES = 'recurring_rules'
// NOT a Settings-sheet key (that sheet is published as a public CSV) — this
// is the PropertiesService key the Discord webhook URL is stored under
// instead. See getDiscordWebhookUrl_()/updateDiscordWebhookUrl() below.
var DISCORD_WEBHOOK_PROPERTY_KEY = 'discord_webhook_url'

// ---- 選択肢の値の内部コード ------------------------------------------------------
//
// タスクのステータス・難易度・優先度などは、画面の言語によらない内部コードで
// 扱う。以前の団体のシート・手で直したシート・古いバックアップには日本語の値が入って
// いることがある。読む時はどちらの形式でもコードにそろえ(normalizeCode_)、書く時は
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

// 以前のスキルのレベルアップの閾値(skill_level_thresholds)で、既定値を表すキー(移行前は「デフォルト」)。
// レベルの計算には使わなくなった(skill_level_rules)が、保存されている値の移行のために残す
var DEFAULT_THRESHOLD_KEY = '_default'
var LEGACY_DEFAULT_THRESHOLD_KEY = 'デフォルト'

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
//   { id, name, tier: 'top' | 'admin' | 'base', restricted?, sections?, requiredSkills?, capabilities? }
// 移行(VALUE_FORMAT=codes)の前は roles が無く、今までの設定(role_levels・
// restricted_roles・role_permissions・job_requirements)から組み立てる(ID は役職名)。
// 役職は ID でも名前でも引ける(findRole_)ので、移行の途中でも判定は変わらない。
// lib/ohsumi/roles.ts と同じ内容(一致することを lib/ohsumi/roles.test.ts で確かめる)。

var TOP_ROLE_ID = 'top'
var BASE_ROLE_ID = 'base'
var DEFAULT_TOP_ROLE_NAME = '代表'
var DEFAULT_BASE_ROLE_NAME = '一般'
var DEFAULT_ROLE_LEVELS = ['班長', '事業責任者', '代表']
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
    // できる操作(38-capabilities.gs)。管理者の役職だけ。無ければ既定
    var caps = roleStringArray_(o.capabilities)
    if (caps && tier === 'admin') role.capabilities = normalizeCapabilities_(caps)
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
    if (!d.id || !d.name) errors.push('領域の ID と名前は空にできません')
    if (d.name === UNCATEGORIZED_NAME) errors.push('「未分類」は領域の名前に使えません')
    if (ids[d.id]) errors.push('領域の ID が重複しています: ' + d.id)
    if (names[d.name]) errors.push('領域の名前が重複しています: ' + d.name)
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
  if (!Array.isArray(newList)) throw userError_('領域の一覧の形式が正しくありません。')
  var parsed = parseDepartmentsSetting_(JSON.stringify(newList))
  if (!parsed) throw userError_('領域の一覧が正しくありません: ' + validateDepartments_(newList.filter(Boolean)).join(' / '))
  var current = getDepartments_()
  var byId = {}
  current.forEach(function (d) { byId[d.id] = d })
  var newIds = {}
  parsed.forEach(function (d) { newIds[d.id] = true })
  current.forEach(function (d) {
    if (!newIds[d.id]) throw userError_('領域「' + d.name + '」を消すには、領域の削除を使ってください。')
  })
  if (!isCodesFormat_()) {
    parsed.forEach(function (d) {
      // 移行前はタスクの部門を部門名で持つため、名前を変えると引けなくなる
      if (byId[d.id] && byId[d.id].name !== d.name) throw userError_('領域の名前の変更は、内部コードへの移行の後にできるようになります。')
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
  if (!dept) throw userError_('領域が見つかりません: ' + deptId)
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
  if (!from) throw userError_('領域が見つかりません: ' + fromId)
  if (toId && !findDepartment_(list, toId)) throw userError_('移す先の領域が見つかりません: ' + toId)
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
  var withdrawnCol = headers.indexOf('withdrawn_at')
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
// 団体のルール(org.rules)を持つ人が行える。最上位の役職にかかわる変更・できる操作の設定は、最上位の役職を持つ人だけ
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
  // できる操作の設定は最上位の役職の人だけ。ほかの人は、できる操作が増えない変更だけ(38-capabilities.gs)
  if (!isTopRoleRef_(current, acting.role)) parsed = guardRolesChangeByNonTop_(acting, current, parsed)
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.tier === 'base' && r.tier !== 'base') throw userError_('一般の役職の種類は変えられません。')
    if (before && before.tier !== 'base' && r.tier === 'base') throw userError_('一般の役職は1つだけです。')
    if (!hasRolesSetting_()) {
      // 移行の前は役職名が ID を兼ねるため、名前の変更と、代表以外の最上位の役職は作れない
      if (r.name !== r.id) throw userError_('役職の名前の変更は、内部コードへの移行の後にできるようになります。')
      if (r.tier === 'top' && r.name !== DEFAULT_TOP_ROLE_NAME) throw userError_('代表以外の最上位の役職は、内部コードへの移行の後に作れるようになります。')
      // 移行の前の保存先(今までの設定)には、できる操作を書けない
      if (Array.isArray(r.capabilities) && normalizeCapabilities_(r.capabilities).join(',') !== roleCapabilities_([{ id: r.id, name: r.name, tier: r.tier, restricted: r.restricted }], r.id).join(',')) {
        throw userError_('役職のできる操作は、内部コードへの移行の後に設定できるようになります。')
      }
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
      'VALUE_FORMAT は変えていません(読み込みは日本語・コードのどちらにも対応しています)。VALUE_FORMAT を手で設定しないでください',
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
  // 記録を行に持っている時は、一覧の列は記録のシートに書く(39-record-rows.gs)
  var recordFields = null
  if (recordListsOf_(sheetName).length && recordRowsOn_() && obj.id !== undefined && obj.id !== '') {
    recordFields = {}
    Object.keys(obj).forEach(function (k) { if (isRecordColumn_(sheetName, k)) recordFields[k] = obj[k] })
  }
  var row = headers.map(function (h) { return obj[h] !== undefined && !(recordFields && h in recordFields) ? obj[h] : '' })
  assertRowCellLengths_(sheetName, headers, row)
  protectRowFromFormulaInjection_(sheet, headers, sheet.getLastRow() + 1, sheetName)
  sheet.appendRow(row)
  if (recordFields && Object.keys(recordFields).length) splitRecordFields_(sheetName, String(obj.id), recordFields)
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
  var withdrawnCol = headers.indexOf('withdrawn_at')
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
        withdrawn: withdrawnCol >= 0 && String(data[i][withdrawnCol] || '') !== '',
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
  'getMailQuotaStatus', 'getGasUpdateStatus', 'getMyStorage', 'getOrgStorage', 'searchArchivedTasks',
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
  var withdrawnCol = h.indexOf('withdrawn_at')
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
      withdrawn: withdrawnCol >= 0 && String(row[withdrawnCol] || '') !== '',
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
  'revokeMemberSessions', 'restoreTask', 'purgeTask', 'unarchiveTasks',
  // メンバーの状態・部門・プロジェクトの担当(班長の担当範囲の判定に使う)
  'updateMemberInactive', 'updateMemberDepartmentPath', 'updateProjectMembers',
]

// 権限の判定に使ったスナップショットの版(シートから判定した時は null)
var _authSnapshotVersion = null

// 操作するメンバーを引く。権限そのものを変える操作(SHEET_AUTH_ACTIONS)はシートから、
// それ以外(読み取り・普通の書き込み)はスナップショットから(役職の設定もそこから)。
// スナップショットに見つからない・読めない時はシートから
// ---- 休止中のメンバー --------------------------------------------------------
// 休止中(Members の inactive が TRUE)のメンバーも、ログイン・操作はできる(2026年10月に変更。以前はログインを止めていた)。
// 担当の候補・おすすめ・招待・人数の集計などからは外れる。ログインを止めるのは退会(withdrawn_at がある)の時だけ

function isInactiveValue_(v) {
  return v === true || String(v || '').trim().toUpperCase() === 'TRUE'
}

// 退会したか(退会したメンバーはログインも操作もできない)
function memberIsWithdrawn_(memberId) {
  var row = snapshotRowOrSheet_(SHEET_MEMBERS, memberId)
  return !!row && String(row.withdrawn_at || '') !== ''
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
  var clientId = googleOAuthClientIdOf_(props)
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
var OHSUMI_GAS_VERSION = '2026.10.08-4'

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
    var added = addMember_(String(email).split('@')[0], email, '', topRoleRef_(), { firstLeader: true })
    // メンバーが増えたので、読み取りのキャッシュ(スナップショット)を作り直させる
    bumpSnapshotVersion_()
    console.log('初期設定コードで、最初の代表を登録しました(メンバーID: ' + added.id + ')')
    return added.id
  } finally {
    lock.releaseLock()
  }
}

// ---- テンプレートから作る団体の既定値 ----
// スプレッドシートを「コピーを作成」しても、スクリプトプロパティはコピーされない。そこで、FSIF の共通の値
// (レジストリの URL・ログインの OAuth クライアント ID)をコードの既定値として持ち、スクリプトプロパティがあればそちらを使う。
// 値はどちらもサイトの画面に入っている公開の値なので、ここに書く(gas/README.md の「2.2.」)。
// setupOhsumi は、プロパティが無ければ既定値をプロパティに保存する(後でコードを貼り替えて既定値が空になっても動くように)
var DEFAULT_REGISTRY_URL = 'https://script.google.com/macros/s/AKfycbx2P-V2NINgmX3oxI-4cgBrCe5vYqjfUzFj9X26TiEZJGBJjOhPYF4kOiaTP8tS3Hm2/exec'
var DEFAULT_GOOGLE_OAUTH_CLIENT_ID = '367437999259-qpqdq6nakl8vmsg9fdociscv1i3m0rk9.apps.googleusercontent.com'

function registryUrlOf_(all) {
  return String((all || {}).REGISTRY_URL || DEFAULT_REGISTRY_URL || '').trim()
}
function registryUrl_() {
  return registryUrlOf_({ REGISTRY_URL: PropertiesService.getScriptProperties().getProperty('REGISTRY_URL') })
}
function googleOAuthClientIdOf_(all) {
  return String((all || {}).GOOGLE_OAUTH_CLIENT_ID || DEFAULT_GOOGLE_OAUTH_CLIENT_ID || '').trim()
}

// プロパティが無い時に、コードの既定値をプロパティに保存する(setupOhsumi から)
function saveCodeDefaultsToProps_(props) {
  var saved = []
  if (!props.getProperty('REGISTRY_URL') && REGISTRY_URL_PATTERN.test(DEFAULT_REGISTRY_URL)) {
    props.setProperty('REGISTRY_URL', DEFAULT_REGISTRY_URL)
    saved.push('REGISTRY_URL')
  }
  if (!props.getProperty('GOOGLE_OAUTH_CLIENT_ID') && /\.apps\.googleusercontent\.com$/.test(DEFAULT_GOOGLE_OAUTH_CLIENT_ID)) {
    props.setProperty('GOOGLE_OAUTH_CLIENT_ID', DEFAULT_GOOGLE_OAUTH_CLIENT_ID)
    saved.push('GOOGLE_OAUTH_CLIENT_ID')
  }
  return saved
}

// この GAS のウェブアプリの URL(レジストリに伝える接続先)。
//   1. スクリプトプロパティ OHSUMI_WEBAPP_URL
//   2. ScriptApp.getService().getUrl() が …/exec の形なら、それ
//   3. ウェブアプリの URL をブラウザで開いた時に覚えた URL(DETECTED_WEBAPP_URL。doGet が覚える)
// メニュー・エディタから実行すると、getService().getUrl() は /dev(エディタで試すための URL)を返すことがある
function ownWebAppUrl_(all) {
  all = all || {}
  var url = String(all.OHSUMI_WEBAPP_URL || '').trim()
  if (url) return url
  var live = ''
  try { live = String(ScriptApp.getService().getUrl() || '') } catch (e) { live = '' }
  if (REGISTRY_URL_PATTERN.test(live)) return live
  var seen = String(all.DETECTED_WEBAPP_URL || '').trim()
  if (REGISTRY_URL_PATTERN.test(seen)) return seen
  return live
}

// ウェブアプリとして開かれた時(doGet)に、その URL を覚える(…/exec の形の時だけ)
function rememberWebAppUrl_() {
  try {
    var url = String(ScriptApp.getService().getUrl() || '')
    if (!REGISTRY_URL_PATTERN.test(url)) return
    if (requestProps_().DETECTED_WEBAPP_URL === url) return
    setRequestProp_('DETECTED_WEBAPP_URL', url)
  } catch (e) { /* 覚えられなくても、GET の応答は返す */ }
}

// レジストリに伝えてよい URL か。問題があれば、直し方の文を返す(無ければ '')
function checkOwnWebAppUrl_(url) {
  var how = 'デプロイの画面(デプロイ → デプロイを管理)に出るウェブアプリの URL(https://script.google.com/macros/s/…/exec)を' +
    'ブラウザで一度開いてから、もう一度試してください(開くと、この GAS がその URL を覚えます)。' +
    'うまくいかない時は、その URL をスクリプトプロパティ OHSUMI_WEBAPP_URL に入れてください。'
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
  var registryUrl = registryUrlOf_(all)
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
  'exchangeIdToken', 'getInitialData', 'getBackgroundData', 'getMyEmails', 'getMyStorage', 'getExpenses', 'getFiles',
  // 団体の保存を読む・移した古いタスクを探す(読み取りだけ)
  'getOrgStorage', 'searchArchivedTasks',
  'getWebhookStatus', 'getCandidates', 'getFormSubmissions', 'fetchDailyReports', 'translateText',
  'revokeMySessions', 'revokeMemberSessions', 'updateLastLogin',
  // ほかの端末で開く: 本人あての招待リンクのメール(データを書き換えない)
  'getInviteMailStatus', 'sendInviteLinkToMe',
  // メールの1日の上限の状態・この GAS の版の更新(代表の管理画面に出す)
  'getMailQuotaStatus', 'getGasUpdateStatus',
  // バックアップの状態・一覧・戻す前の確かめ(戻すのは書き込みなので、機能停止中は断る)
  'getBackupStatus', 'listBackups', 'previewRestore', 'searchBackupTasks',
  // 今すぐバックアップを作る(シートは書き換えない。Drive にコピーを作り、スクリプトプロパティに記録するだけ)
  'createBackupNow',
  // 個人情報の削除の予定(消す・延ばすのは書き込み)
  'getPersonalDataStatus',
  // 記録の持ち方の状態(移す・戻すのは書き込み)
  'getRecordRowsStatus',
  // 兼部の統合表示(本人の分だけを読む)
  'getMyDigest',
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
  skills: { label: 'スキル・ポイント・クイズ', actions: ['awardSkillPoints', 'importPortableRecord', 'submitQuizResult', 'bulkUpdateSkills', 'updateSkillLevels', 'approveSkillLevel'] },
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
  // 完了してからこの日数がたったタスクを、毎日の処理で TasksArchive に移す
  taskArchiveDays: { def: 365, min: 90, max: 3650, label: '完了したタスクを移すまでの日数' },
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
  var registryUrl = registryUrl_()
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

// ---- レジストリに頼まれて送るメール(アンケートの送付・リマインド・28日目の機能停止の知らせ・停止の予告) ----
//
// 団体あてのメールは、レジストリの代わりに、この団体の Gmail で送る(レジストリのメールの1日の上限に数えないため)。
// checkIn の返事の mailTasks を、担当者(レジストリの Contacts)と代表に送り、送った key をスクリプトプロパティ
// REGISTRY_MAIL_TASKS_SENT に残す(直近の分)。次の checkIn で mailDone として伝え、レジストリが記録する(二重に送らない)。
// メールの1日の上限で送れなかった時は送ったことにせず、次の1時間ごとの確認で送り直す。
// 1時間ごとの checkContractStatus で、ほかのメール(更新の知らせ・緊急のお知らせ)より先に送る。まとめのメール
// (digestMailReserve の分を残して止まる)とは違い、残りを最後まで使える
var REGISTRY_MAIL_SENT_KEEP = 100
var REGISTRY_MAIL_DONE_REPORT = 30
var REGISTRY_MAIL_KEY_PATTERN = /^(sv|sn|sr)\.[A-Za-z0-9_]{1,40}\.\d{1,14}$/

function parseRegistryMailTasks_(list) {
  if (!Array.isArray(list)) return null
  return list.slice(0, 10).map(function (t) {
    if (!t || typeof t !== 'object') return null
    var key = String(t.key || '')
    if (!REGISTRY_MAIL_KEY_PATTERN.test(key)) return null
    var to = (Array.isArray(t.to) ? t.to : []).map(function (e) { return String(e).trim() })
      .filter(function (e) { return /^[^@\s,]+@[^@\s,]+$/.test(e) }).slice(0, 10)
    return { key: key, to: to, subject: String(t.subject || '').slice(0, 300), body: String(t.body || '').slice(0, 5000) }
  }).filter(function (t) { return t && t.subject && t.body })
}

function registryMailTasksSent_() {
  var list = []
  try { list = JSON.parse(PropertiesService.getScriptProperties().getProperty('REGISTRY_MAIL_TASKS_SENT') || '[]') } catch (e) { list = [] }
  return Array.isArray(list) ? list.map(String).filter(function (k) { return REGISTRY_MAIL_KEY_PATTERN.test(k) }) : []
}

// 送った key の一覧を返す
function sendRegistryMailTasks_(state) {
  var tasks = state && Array.isArray(state.mailTasks) ? state.mailTasks : []
  if (!tasks.length) return []
  var sent = registryMailTasksSent_()
  var pending = tasks.filter(function (t) { return sent.indexOf(t.key) < 0 })
  if (!pending.length) return []
  var emails = getAllMemberEmails_()
  var tops = topMemberIds_().map(function (id) { return emails[id] }).filter(Boolean)
  var done = []
  for (var i = 0; i < pending.length; i++) {
    var t = pending[i]
    var to = []
    t.to.concat(tops).forEach(function (e) { if (to.map(function (x) { return x.toLowerCase() }).indexOf(e.toLowerCase()) < 0) to.push(e) })
    if (!to.length) {
      console.warn('レジストリからのメールを送る宛先(担当者・代表)がありません: ' + t.subject)
      continue
    }
    // 送れなかった時(メールの1日の上限など)は、残りも次の確認に回す(送る順を守る)
    if (!sendMail_({ to: to.join(','), subject: t.subject, body: t.body })) break
    sent.push(t.key)
    done.push(t.key)
  }
  if (done.length) PropertiesService.getScriptProperties().setProperty('REGISTRY_MAIL_TASKS_SENT', JSON.stringify(sent.slice(-REGISTRY_MAIL_SENT_KEEP)))
  return done
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
      '1. Ohsumi にログインし、管理画面の上部の知らせの「コードをコピー」を押す\n' +
      '2. スプレッドシートの「拡張機能」→「Apps Script」で、Code.gs の中身をすべて消して貼り付け、保存する\n' +
      '3. スプレッドシートのメニュー「Ohsumi」→「初期設定」を選ぶ\n' +
      '4. 「デプロイ」→「デプロイを管理」→ ウェブアプリの編集(鉛筆)→「バージョン: 新バージョン」で更新する(URL は変わりません)\n\n' +
      'このメールは、新しい版ごとに1回だけ送ります。',
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
  var registryUrl = registryUrl_()
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
  // レジストリから頼まれて送ったメール(sendRegistryMailTasks_)の key。レジストリが記録し、二重に送らない
  var mailDone = registryMailTasksSent_().slice(-REGISTRY_MAIL_DONE_REPORT)
  var payload = JSON.stringify({ action: 'checkIn', orgId: orgId, ts: ts, sig: sig, gasVersion: OHSUMI_GAS_VERSION, mail: mail, jobs: jobs, mailDone: mailDone })
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
    // レジストリに頼まれて送るメール(アンケート・停止の予告など)。古いレジストリは返さない(null)
    mailTasks: parseRegistryMailTasks_(out.mailTasks),
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
  if (link) return '団体ID: ' + orgId + '\n招待リンク: ' + link + '\n(メンバーには、初めての端末でこのリンクから開くよう伝えてください。代表は、ログインした後にADMIN の「メンバー」でも確かめられます)'
  return '団体ID: ' + orgId + '\n招待リンク: Ohsumi のサイトの URL の後ろに /?org=' + orgId +
    ' を付けたもの(レジストリからサイトの URL を受け取れませんでした。代表は、ログインした後にADMIN の「メンバー」でも確かめられます)'
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
  // 退会したメンバーはログインできない(休止中のメンバーはログインできる)
  if (memberIsWithdrawn_(memberId)) throw userError_(WITHDRAWN_MEMBER_MESSAGE)
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

// ---- スキルのレベルの決め方(PR Z) ----------------------------------------------
//
// 画面(lib/ohsumi/skill-levels.ts)と同じ決まり(lib/ohsumi/skill-levels.test.ts が、同じ入力で同じ結果になることを確かめる)。
// レベル L になるのは、累計の点数がそのレベルの点数以上で、そのレベルの条件をすべて満たした時(満たすうちで、いちばん高いレベル)。
//   点数: スキルごとの一覧 → 団体の既定の一覧 → 組み込みの [50, 150, 350, 550, 750]
//   条件: レベルごとに、スキルごと → 団体の既定 → 組み込み(Lv.4: 関連する資格1件以上・Lv.5: 外部評価の資格3件以上)
//   条件の種類: qualification(資格 min 件以上。external で外部評価だけ)・quiz(このスキル・このレベル以上の検定に合格)・
//               tasksDone(このスキルを含む、担当して完了したタスクが min 件以上)・
//               approval(見る立場の人・代表が、このスキルをこのレベル以上と認めている。approveSkillLevel)
// 設定は Settings の skill_level_rules(代表・全権管理者が設定の画面で変える)。以前の skill_level_thresholds は使わない。
// 保存されたレベルは下げない(上がる時だけ書き換える)
var BUILTIN_LEVEL_POINTS = [50, 150, 350, 550, 750]
var BUILTIN_LEVEL_CONDITIONS = {
  '4': [{ type: 'qualification', min: 1 }],
  '5': [{ type: 'qualification', min: 3, external: true }],
}

function validLevelPoints_(v) {
  if (!Array.isArray(v) || v.length !== 5) return false
  for (var i = 0; i < 5; i++) {
    var n = v[i]
    if (typeof n !== 'number' || Math.floor(n) !== n || n < 0 || n > 1000000) return false
    if (i > 0 && n <= v[i - 1]) return false
  }
  return true
}

function validLevelCondition_(c) {
  if (!c || typeof c !== 'object') return false
  if (c.type === 'quiz' || c.type === 'approval') return true
  if (c.type === 'qualification' || c.type === 'tasksDone') return typeof c.min === 'number' && Math.floor(c.min) === c.min && c.min >= 1 && c.min <= 1000
  return false
}

// 設定の JSON を、使える形だけにする(壊れた部分は捨てる)
function parseSkillLevelRules_(raw) {
  var obj = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}') } catch (e) { obj = {} }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  var rule = function (r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null
    var out = {}
    if (validLevelPoints_(r.points)) out.points = r.points.slice()
    if (r.conditions && typeof r.conditions === 'object' && !Array.isArray(r.conditions)) {
      var conds = {}
      var any = false
      ;['1', '2', '3', '4', '5'].forEach(function (l) {
        var list = r.conditions[l]
        if (Array.isArray(list)) {
          conds[l] = list.filter(validLevelCondition_).map(function (c) { return JSON.parse(JSON.stringify(c)) })
          any = true
        }
      })
      if (any) out.conditions = conds
    }
    return out.points || out.conditions ? out : null
  }
  var result = {}
  var d = rule(obj['default'])
  if (d) result['default'] = d
  if (obj.skills && typeof obj.skills === 'object' && !Array.isArray(obj.skills)) {
    var skills = {}
    var anySkill = false
    Object.keys(obj.skills).forEach(function (name) {
      var parsed = rule(obj.skills[name])
      var key = String(name).trim().slice(0, 100)
      if (parsed && key) { skills[key] = parsed; anySkill = true }
    })
    if (anySkill) result.skills = skills
  }
  return result
}

function getSkillLevelRules_() {
  return parseSkillLevelRules_(getSettingValue_('skill_level_rules'))
}

function levelPointsFor_(rules, skill) {
  var s = rules.skills && rules.skills[skill]
  if (s && s.points) return s.points
  if (rules['default'] && rules['default'].points) return rules['default'].points
  return BUILTIN_LEVEL_POINTS.slice()
}

function levelConditionsFor_(rules, skill, level) {
  var key = String(level)
  var s = rules.skills && rules.skills[skill]
  if (s && s.conditions && s.conditions[key]) return s.conditions[key]
  var d = rules['default']
  if (d && d.conditions && d.conditions[key]) return d.conditions[key]
  return BUILTIN_LEVEL_CONDITIONS[key] || []
}

function levelConditionMet_(c, skill, level, ev) {
  if (c.type === 'qualification') {
    var related = (ev.qualifications || []).filter(function (q) {
      return q && Array.isArray(q.relatedSkills) && q.relatedSkills.indexOf(skill) >= 0 && (!c.external || q.external)
    })
    return related.length >= c.min
  }
  if (c.type === 'quiz') return (ev.quizPasses || []).some(function (p) { return p && p.skill === skill && Number(p.level) >= level })
  if (c.type === 'approval') return (ev.approvals || []).some(function (a) { return a && a.skill === skill && Number(a.level) >= level })
  return ((ev.doneTaskCounts || {})[skill] || 0) >= c.min
}

// 点数と記録から決まるレベル(どのレベルにも届かなければ 0)
function skillLevelOf_(points, skill, ev, rules) {
  rules = rules || {}
  var table = levelPointsFor_(rules, skill)
  for (var level = 5; level >= 1; level--) {
    if (points < table[level - 1]) continue
    var ok = levelConditionsFor_(rules, skill, level).every(function (c) { return levelConditionMet_(c, skill, level, ev) })
    if (ok) return level
  }
  return 0
}

function parseJsonListSafe_(v) {
  try { var a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch (e) { return [] }
}

// 条件を確かめるための、その人の記録(資格・検定の合格・担当して完了したタスクの数・スキルのレベルの承認)。
// 完了したタスクの数には、TasksArchive に移した古いタスクも数える
function skillEvidenceOf_(memberRow, memberId) {
  var counts = {}
  try {
    var t = snapshotTableOrSheet_(SHEET_TASKS)
    var col = function (name) { return t.headers.indexOf(name) }
    var aCol = col('assignee_id'), sCol = col('status'), kCol = col('skills'), delCol = col('deleted_at')
    ;(t.rows || []).forEach(function (r) {
      if (normalizeCode_('status', r[sCol]) !== 'done') return
      if (delCol >= 0 && String(r[delCol] || '') !== '') return
      var assignees = String(r[aCol] || '').split(',').map(function (x) { return x.trim() })
      if (assignees.indexOf(String(memberId)) < 0) return
      String(r[kCol] || '').split(',').map(function (x) { return x.trim() }).filter(Boolean).forEach(function (s) { counts[s] = (counts[s] || 0) + 1 })
    })
    archivedDoneTaskSkills_(memberId).forEach(function (s) { counts[s] = (counts[s] || 0) + 1 })
  } catch (e) { counts = {} }
  return {
    qualifications: parseJsonListSafe_(memberRow && memberRow.qualifications_json),
    quizPasses: parseJsonListSafe_(memberRow && memberRow.quiz_passes_json),
    doneTaskCounts: counts,
    approvals: parseJsonListSafe_(memberRow && memberRow.skill_approvals_json),
  }
}

/**
 * 累計の点数と記録から、レベルを上げた一覧を返す(下げない。acquiredAt などほかの項目は残す)。
 * 点数のあるスキルだけを計算し直す
 */
function computeAutoLevels_(currentLevels, cumulativePoints, rules, evidence) {
  var out = (currentLevels || []).map(function (l) { return JSON.parse(JSON.stringify(l)) })
  Object.keys(cumulativePoints || {}).forEach(function (skill) {
    var earned = skillLevelOf_(Number(cumulativePoints[skill]) || 0, skill, evidence || {}, rules || {})
    if (!earned) return
    var idx = -1
    for (var i = 0; i < out.length; i++) if (out[i] && out[i].skill === skill) { idx = i; break }
    if (idx < 0) out.push({ skill: skill, level: earned, acquiredAt: new Date().toISOString() })
    else if (earned > (Number(out[idx].level) || 0)) out[idx].level = earned
  })
  return out
}

/**
 * 他団体で積んだ実績(共通スキルのポイント・資格)の持ち込み。本人が自分の
 * ページからエクスポートしたファイルを、新しい団体で自分のページから
 * インポートする想定(lib/ohsumi/portable-record.ts)。awardSkillPointsと同じ
 * 「累計加算→レベル自動繰り上げ」ロジックだが、タスクには紐付けない。
 * 資格は名前+取得日が一致するものは重複とみなしスキップして追記する。
 */
// 他の団体の実績の持ち込み。点数は0以上の整数だけ(負の点数は断る)。
// 本人が自分の分を持ち込む時は、点数を足さない(資格だけ「外部」の印なしで足す)。点数は管理者が持ち込む
function importPortableRecord_(memberId, skillPoints, qualifications, acting) {
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません: ' + memberId)
  if (!skillPoints || typeof skillPoints !== 'object' || Array.isArray(skillPoints)) throw userError_('点数の形式が不正です。')
  Object.keys(skillPoints).forEach(function (k) {
    var v = Number(skillPoints[k])
    if (typeof skillPoints[k] === 'boolean' || !isFinite(v) || v < 0 || Math.floor(v) !== v) throw userError_('持ち込む点数は0以上の整数で入れてください。')
  })
  var pointsSkipped = false
  if (acting && selfRestricted_(acting, memberId) && Object.keys(skillPoints).length) {
    skillPoints = {}
    pointsSkipped = true
  }

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

  // 持ち込んだ資格も、レベルの条件に数える
  var evidence = skillEvidenceOf_(memberRow, memberId)
  evidence.qualifications = currentQualifications
  var newLevels = computeAutoLevels_(currentLevels, currentPoints, getSkillLevelRules_(), evidence)

  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
    qualifications_json: JSON.stringify(currentQualifications),
  })
  return { ok: true, newPoints: currentPoints, newLevels: newLevels, qualifications: currentQualifications, pointsSkipped: pointsSkipped }
}

/**
 * Awards skill points to a member on task completion.
 * Updates skill_points_json and auto-levels skill_levels_json.
 * Also saves awarded_points_json on the task for future avg calculations.
 */
// 完了したタスクのスキルの点数を付ける。画面から送られた値を、GAS でも確かめる:
//   ・タスクが完了している ・受け取る人がそのタスクの担当者 ・点数を付けるスキルがタスクの必要スキル
//   ・1つのタスクにつき1人1回だけ(付けた人の一覧は awarded_points_json の __awardedTo に記録する)
//   ・1回にスキルごと AWARD_MAX_POINTS_PER_SKILL 点まで(0以上の整数) ・自分自身には付けられない
var AWARD_MAX_POINTS_PER_SKILL = 100
function awardSkillPoints_(taskId, memberId, points, acting) {
  taskId = String(taskId || '')
  memberId = String(memberId || '')
  if (!taskId) throw userError_('タスクを指定してください。')
  if (acting && memberId === String(acting.id)) throw userError_('自分自身にはスキルの点数を付けられません。ほかの管理者に依頼してください。')
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('タスクが見つかりません。')
  if (normalizeCode_('status', task.status) !== 'done') throw userError_('完了したタスクにだけ、スキルの点数を付けられます。')
  if (String(task.awarded_points_json || '').indexOf('"__noAward":true') >= 0) throw userError_('完了として取り込んだタスクには、スキルの点数を付けられません。')
  var assignees = splitCsvList_(task.assignee_id)
  if (assignees.indexOf(memberId) < 0) throw userError_('このタスクの担当者にだけ、スキルの点数を付けられます。')
  var taskSkills = String(task.skills || '').split(',').map(function (x) { return x.trim() }).filter(Boolean)
  var clean = {}
  Object.keys(points || {}).forEach(function (skill) {
    var v = Number(points[skill])
    if (taskSkills.indexOf(skill) < 0) throw userError_('「' + skill + '」はこのタスクの必要スキルではありません。')
    if (!(v >= 0) || Math.floor(v) !== v) throw userError_('点数は0以上の整数で入れてください。')
    if (v > AWARD_MAX_POINTS_PER_SKILL) throw userError_('1回に付けられる点数は、スキルごとに' + AWARD_MAX_POINTS_PER_SKILL + '点までです。')
    clean[skill] = v
  })
  if (!Object.keys(clean).length) throw userError_('点数を付けるスキルがありません。')
  var awarded = {}
  try { awarded = JSON.parse(task.awarded_points_json || '{}') || {} } catch (_) { awarded = {} }
  var awardedTo = Array.isArray(awarded.__awardedTo) ? awarded.__awardedTo.map(String) : []
  if (awardedTo.indexOf(memberId) >= 0) throw userError_('このメンバーには、このタスクの点数をもう付けています。')
  points = clean
  var added = addSkillPoints_(memberId, points)

  // タスクには、付けた点数(画面の「似たタスクの平均」に使う)と、付けた人の一覧を残す
  var record = {}
  Object.keys(points).forEach(function (k) { record[k] = points[k] })
  record.__awardedTo = awardedTo.concat([memberId])
  record.__awardedBy = acting ? String(acting.id) : ''
  record.__awardedAt = new Date().toISOString()
  updateTaskFields_(taskId, { awarded_points_json: JSON.stringify(record) })
  return { ok: true, newPoints: added.newPoints, newLevels: added.newLevels }
}

// メンバーのスキルの点数を足し、レベルを決め直して保存する(確かめは呼ぶ側で行う)
function addSkillPoints_(memberId, points) {
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

  // レベルを上げる(skill_level_rules と、資格・検定・完了したタスクの条件で決める)
  var newLevels = computeAutoLevels_(currentLevels, currentPoints, getSkillLevelRules_(), skillEvidenceOf_(memberRow, memberId))

  // Persist
  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(currentPoints),
    skill_levels_json: JSON.stringify(newLevels),
  })
  return { newPoints: currentPoints, newLevels: newLevels }
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
    var currentLevels = parseJsonListSafe_(memberRow && memberRow.skill_levels_json)
    var targetSkill = quiz.targetSkill
    var targetLevel = Number(quiz.targetLevel) || 1
    // 合格を記録する(レベルの条件「検定の合格」に使う。同じ検定は最新の1件だけ残す)
    var passes = parseJsonListSafe_(memberRow && memberRow.quiz_passes_json).filter(function (p) { return p && p.quizId !== quiz.id })
    passes.push({ quizId: quiz.id, skill: targetSkill, level: targetLevel, at: new Date().toISOString() })
    var fields = { quiz_passes_json: JSON.stringify(passes.slice(-100)) }
    var existing = currentLevels.find(function(sl) { return sl.skill === targetSkill })
    if (!existing || existing.level < targetLevel) {
      // 検定の合格で、目標のレベルにする(acquiredAt などは残す)
      var nextLevels = currentLevels.map(function (sl) { return sl.skill === targetSkill ? Object.assign({}, sl, { level: targetLevel }) : sl })
      if (!existing) nextLevels.push({ skill: targetSkill, level: targetLevel, acquiredAt: new Date().toISOString() })
      // SKL-009: 累計の点数もレベルにそろえる(そのレベルに必要な点数まで底上げする。画面と同じ)
      var currentPoints = {}
      try { currentPoints = JSON.parse((memberRow && memberRow.skill_points_json) || '{}') } catch (_) {}
      var minPointsForLevel = levelPointsFor_(getSkillLevelRules_(), targetSkill)[targetLevel - 1]
      if ((currentPoints[targetSkill] || 0) < minPointsForLevel) {
        currentPoints[targetSkill] = minPointsForLevel
      }
      fields.skill_levels_json = JSON.stringify(nextLevels)
      fields.skill_points_json = JSON.stringify(currentPoints)
      newLevel = targetLevel
    }
    updateMemberFields_(memberId, fields)
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
  // 記録の持ち方を移す・戻す(39-record-rows.gs)も代表だけ
  var recordRowsActions = ['getRecordRowsStatus', 'migrateRecordsToRows', 'revertRecordRows']
  if (recordRowsActions.indexOf(action) >= 0) throw userError_('データの持ち方の移行は、代表だけが使えます。')
  var privacyActions = ['getPersonalDataStatus', 'setPersonalDataRetention', 'purgePersonalDataNow', 'extendPersonalData', 'cancelWithdrawal', 'deleteOrphanEmails']
  if (privacyActions.indexOf(action) >= 0) throw userError_('個人情報の削除は代表だけが使えます。')

  // --- 最上位だけ(どの設定でも渡さない): 人ごとの権限の例外の編集 ---
  if (TOP_ONLY_ACTIONS.indexOf(action) >= 0) throw userError_('この操作は代表だけが使えます。')

  // --- できる操作(capability)のまとまりに入る操作(38-capabilities.gs) ---
  // 役職のできる操作で判定する。既定は、最上位: すべて、制限なしの管理者: org.rules・trash、ほか: なし
  // (今までの「代表のみ」「代表または全権管理者のみ」と同じ人)。
  // 役職で断られても、人ごとの権限の例外(OVERRIDE_SCOPE_BY_ACTION — 採用の例外・プロジェクトの例外)が
  // あれば許可するのは今までと同じ。役職を付ける操作は、最上位でなければ昇権の防止を確かめる
  var capability = CAPABILITY_BY_ACTION[action]
  if (capability) {
    if (roleHasCapability_(getRoles_(), role, capability)) {
      if (action === 'updateRole') assertRoleAssignable_(acting, body.role, body.memberId)
      if (action === 'addMember' && body.role) assertRoleAssignable_(acting, body.role, null)
      if (action === 'convertCandidateToMember' && roleTier_(getRoles_(), body.role) !== 'base') {
        // 候補者を一般以外の役職で登録するのは役職の付与にあたる(メンバーの登録・役職の付与と同じ確認)
        if (!roleHasCapability_(getRoles_(), role, 'members.add')) throw userError_(capabilityDeniedMessage_('members.add'))
        assertRoleAssignable_(acting, body.role, null)
      }
      return
    }
    if (checkPermissionOverride_(acting, action, body)) return
    throw userError_(capabilityDeniedMessage_(capability))
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
    'getMyDigest',             // 兼部の統合表示: 本人の担当・確認待ち・回答待ちだけ(常に acting.id が対象。見えるタスクだけ)
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
    // updateTaskStatus: 全権管理者は制限なし。それ以外は担当者・確認者だけ。
    // 「完了」: 確認する人(確認者 → 報告先 → 全権管理者。reviewTargets_)はそのまま完了にできる。
    // 担当者は確認待ちに変わる(doneStatusFor_。13-write-actions.gs)
    if (action === 'updateTaskStatus') {
      if (!isActingFullAdmin_(acting)) {
        var taskId = String(body.taskId || '')
        var task = authFindRow_(SHEET_TASKS, taskId)
        if (body.status === 'done') {
          if (!task || doneStatusFor_(task, acting) === null) {
            throw userError_('「完了」にできるのは、このタスクの担当者・確認者・管理者だけです。')
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

// 確認待ちが届く人(確認する人)。タスクの確認者 → いなければ担当者の報告先 → それもいなければ全権管理者(代表を含む)。
// 退会した人は除く。担当者自身は報告先・全権管理者の候補から除く(全員が担当者なら除かない)。
// 画面の lib/ohsumi/permissions.ts の reviewTargets と同じ決まり
function reviewTargets_(task) {
  var split = function (v) { return String(v || '').split(',').map(function (s) { return s.trim() }).filter(Boolean) }
  var reviewerIds = split(task.reviewer_ids || task.reviewer_id)
  if (reviewerIds.length > 0) return { kind: 'reviewers', ids: reviewerIds }
  var assigneeIds = split(task.assignee_id)
  var members = snapshotTableOrSheet_(SHEET_MEMBERS)
  var col = function (name) { return members.headers.indexOf(name) }
  var idCol = col('id'), reportsCol = col('reports_to_id'), roleCol = col('role'), withdrawnCol = col('withdrawn_at')
  var active = {}
  members.rows.forEach(function (r) {
    if (withdrawnCol >= 0 && String(r[withdrawnCol] || '').trim()) return
    active[String(r[idCol])] = r
  })
  var managers = []
  assigneeIds.forEach(function (aid) {
    var row = active[aid]
    var managerId = row && reportsCol >= 0 ? String(row[reportsCol] || '').trim() : ''
    if (managerId && active[managerId] && assigneeIds.indexOf(managerId) < 0 && managers.indexOf(managerId) < 0) managers.push(managerId)
  })
  if (managers.length > 0) return { kind: 'reportsTo', ids: managers }
  var roles = getRoles_()
  var admins = Object.keys(active).filter(function (id) { return roleCol >= 0 && isFullAdminRoleRef_(roles, active[id][roleCol]) })
  var others = admins.filter(function (id) { return assigneeIds.indexOf(id) < 0 })
  return { kind: 'fullAdmins', ids: others.length > 0 ? others : admins }
}

// 「完了」を選んだ時に、実際に入る状態。全権管理者・確認する人(reviewTargets_)は 'done'。
// 担当者(確認する人でない人)は 'review'(確認する人の承認で完了になる)。それ以外の人は null(完了にできない)。
// 画面の lib/ohsumi/permissions.ts の doneTransition と同じ決まり
function doneStatusFor_(task, acting) {
  var split = function (v) { return String(v || '').split(',').map(function (s) { return s.trim() }).filter(Boolean) }
  if (isActingFullAdmin_(acting)) return 'done'
  var targets = reviewTargets_(task)
  if (targets.ids.indexOf(String(acting.id)) >= 0) return 'done'
  if (split(task.assignee_id).indexOf(String(acting.id)) >= 0) return targets.ids.length > 0 ? 'review' : 'done'
  return null
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
// 記録を行に持った後(39-record-rows.gs)は500件。使う時は historyCap_() で今の上限を読む
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

  newComments.forEach(function (c) { if (c && c.id) newIds[c.id] = true })
  newComments.forEach(function (c) {
    if (!c || !c.id) throw userError_('コメントの形式が不正です。')
    var old = oldById[c.id]
    // 新しいコメントの値を確かめる(本文・返信の元・メンションした人)。既存のコメントは、これまでの値のまま通す
    if (!old) checkNewComment_(c, newIds)
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

// 新しいコメントの値: 本文は空でない文字(長さは、1つのセルの長さの確かめで断る。書いた文章を画面に返せるように)。
// 返信の元(replyToId)は、同じタスクのほかのコメント。メンションした人(mentionedIds)は ID の一覧
// (通知の宛先は GAS が本文から決めるので、ここでは形だけ)
function checkNewComment_(c, idsInList) {
  if (typeof c.id !== 'string' || c.id.length > 100) throw userError_('コメントの ID が正しくありません。')
  if (typeof c.text !== 'string' || !c.text.trim()) throw userError_('コメントの本文を入れてください。')
  if (c.at !== undefined && (typeof c.at !== 'string' || c.at.length > 40)) throw userError_('コメントの時刻の形が正しくありません。')
  if (c.replyToId !== undefined && c.replyToId !== null && c.replyToId !== '') {
    if (typeof c.replyToId !== 'string' || c.replyToId === c.id || !idsInList[c.replyToId]) throw userError_('返信の元のコメントが見つかりません。')
  }
  if (c.mentionedIds !== undefined && c.mentionedIds !== null) {
    if (!Array.isArray(c.mentionedIds) || c.mentionedIds.length > 100) throw userError_('メンションの形が正しくありません。')
    c.mentionedIds.forEach(function (id) { if (typeof id !== 'string' || id.length > 100) throw userError_('メンションの形が正しくありません。') })
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

  var expectedKeepCount = Math.max(historyCap_() - addedCount, 0)
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
  // 記録の持ち方の状態(シートを読むだけ)
  'getRecordRowsStatus',
  // 兼部の統合表示(スナップショットを読むだけ)
  'getMyDigest',
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
    // データの持ち方を移している間は、記録の一覧への書き込みを断る(39-record-rows.gs)
    if (listOpsList.some(function (op) { var cfg = op && LIST_ACTIONS[op.action]; return cfg && isRecordColumn_(cfg.sheet, cfg.column) }) && recordRowsBusy_(Date.now())) {
      endTiming_('authMs', authStart)
      return ({ ok: false, error: RECORD_ROWS_BUSY_MESSAGE, session: renewedSession || undefined })
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
    // 兼部の統合表示(40-my-digest.gs)。本人の分だけ
    case 'getMyDigest':
      result = myDigest_(actingMember.id, body)
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
    // 記録の持ち方(39-record-rows.gs。代表だけ)
    case 'getRecordRowsStatus':
      result = recordRowsStatus_()
      break
    case 'migrateRecordsToRows':
      result = migrateRecordsToRows_(actingMember.id, { dryRun: body.dryRun === true }, Date.now())
      break
    case 'revertRecordRows':
      result = revertRecordRows_(actingMember.id, { dryRun: body.dryRun === true }, Date.now())
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
// 宛先は reviewTargets_(確認者 → 担当者の報告先 → 全権管理者)。
function notifyReview_(taskId) {
  try {
    // (スナップショットは書き込みの前の内容なので使わない。表に無ければシートを読む)
    var grid = _sheetGrids[SHEET_TASKS]
    var task = grid && grid.rowOf[String(taskId)] ? requestRow_(SHEET_TASKS, taskId) : findRow_(SHEET_TASKS, taskId)
    if (!task) return
    // 確認する人(確認者 → 担当者の報告先 → 全権管理者。reviewTargets_)に送る
    var preferredEmails = memberEmailsByIds_(reviewTargets_(task).ids)
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
  // 返信は「メンション」の頻度に従う(画面の設定は「メンション・返信」で1つ)
  if (kind === 'reply') kind = 'mention'
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
  // 兼部の統合表示の読み込み(getMyDigest。1人1時間)
  digest: { limit: 120, windowSec: 3600 },
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
// reply: コメントへの返信・メンションした相手のコメント(メンションと同じく急ぎ。頻度はメンションの設定を使う)
var URGENT_NOTIFY_KINDS = { mention: true, reply: true, review: true, new_task: true }

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

// Ohsumi が作るカレンダーの予定の名前の先頭
var CALENDAR_PREFIX_OHSUMI = '[Ohsumi] '
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
function assertProjectRemovable_(projectId) {
  var count = function (sheetName, col) {
    var t = snapshotTableOrSheet_(sheetName) || { headers: [], rows: [] }
    var c = (t.headers || []).indexOf(col)
    if (c < 0) return 0
    return (t.rows || []).filter(function (r) { return String(r[c] || '') === projectId }).length
  }
  var tasks = count(SHEET_TASKS, 'project_id') + archivedTaskCountOfProject_(projectId), children = count(SHEET_PROJECTS, 'parent_id')
  if (tasks > 0 || children > 0) {
    throw userError_('このプロジェクトには、タスクが ' + tasks + ' 件(ゴミ箱・移した古いタスクを含む)・子プロジェクトが ' + children + ' 件あるため削除できません。終わったプロジェクトは「アーカイブ」にしてください。')
  }
}

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
    var taskIdCol = taskHeaders.indexOf('id') + 1
    var taskIds = taskIdCol > 0 && taskLastRow > 1 ? tasks.getRange(2, taskIdCol, taskLastRow - 1, 1).getValues() : []
    var removedTaskIds = []
    for (var j = projectIds.length - 1; j >= 0; j--) {
      if (String(projectIds[j][0]) === String(projectId)) {
        if (taskIds[j]) removedTaskIds.push(String(taskIds[j][0]))
        tasks.deleteRow(j + 2)
        forgetSheetGrid_()
      }
    }
    // 記録を1件1行で持っている時は、消したタスクの記録の行も消す(39-record-rows.gs)
    deleteRecordsOfParents_(SHEET_TASKS, removedTaskIds)
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
// ---- タスクのゴミ箱 ----
//
// 削除(removeTask)は、行を消さずに deleted_at・deleted_by を書いてゴミ箱に入れる(画面・検索・集計・通知・カレンダーから外す)。
// ゴミ箱のタスクは、代表・全権管理者だけに返し、元に戻す(restoreTask)・すぐに完全に消す(purgeTask)ことができる。
// 毎日の処理が、入れてから TRASH_RETENTION_DAYS 日たったタスクを完全に消す。前提タスクの一覧からは、完全に消す時に外す。
// deleted_at の列が無い古いシート(setupOhsumi を実行していない)では、これまでどおりすぐに消す
var TRASH_RETENTION_DAYS = 30
var TRASH_ACTIONS = ['restoreTask', 'purgeTask']
var TRASHED_TASK_MESSAGE = 'このタスクはゴミ箱にあります。元に戻してから変えてください。'

function trashTask_(taskId, actorId) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task) throw userError_('タスクが見つかりません。')
  if (!Object.prototype.hasOwnProperty.call(task, 'deleted_at')) return removeTask_(taskId)
  if (String(task.deleted_at || '') !== '') throw userError_(TRASHED_TASK_MESSAGE)
  updateRowFields_(SHEET_TASKS, taskId, { deleted_at: new Date().toISOString(), deleted_by: String(actorId || '') })
  return { trashed: taskId }
}

function restoreTrashedTask_(taskId) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task || String(task.deleted_at || '') === '') throw userError_('ゴミ箱にこのタスクはありません。')
  updateRowFields_(SHEET_TASKS, taskId, { deleted_at: '', deleted_by: '' })
  return { restored: taskId }
}

function purgeTrashedTask_(taskId) {
  var task = findRow_(SHEET_TASKS, taskId)
  if (!task || String(task.deleted_at || '') === '') throw userError_('ゴミ箱にこのタスクはありません。')
  return removeTask_(taskId)
}

// 毎日の処理: ゴミ箱に入れてから TRASH_RETENTION_DAYS 日たったタスクを完全に消す
function purgeExpiredTrashLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    var limit = nowMs - TRASH_RETENTION_DAYS * 24 * 3600 * 1000
    var ids = sheetRowsAsObjects_(SHEET_TASKS).filter(function (t) {
      var at = cellTimeMs_(t.deleted_at)
      return String(t.deleted_at || '') !== '' && isFinite(at) && at <= limit
    }).map(function (t) { return String(t.id) })
    ids.forEach(function (id) { removeTask_(id) })
    if (ids.length) bumpSnapshotVersion_()
    return ids
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

function isTrashedTask_(t) {
  return !!t && String(t.deleted_at || '') !== ''
}

function removeTask_(taskId) {
  // カレンダーの予定を消してから、行を消す
  syncCalendarForTask_(taskId, { remove: true })
  var tasks = getSheet_(SHEET_TASKS)
  var taskHeaders = headerRow_(tasks)
  var idCol = taskHeaders.indexOf('id') + 1
  var lastRow = tasks.getLastRow()
  var ids = idCol > 0 ? tasks.getRange(2, idCol, Math.max(lastRow - 1, 0), 1).getValues() : []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(taskId)) {
      tasks.deleteRow(i + 2)
      forgetSheetGrid_()
      // 記録を1件1行で持っている時は、そのタスクの記録の行も消す(39-record-rows.gs)
      deleteRecordsOfParents_(SHEET_TASKS, [String(taskId)])
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
function addMember_(name, email, affiliation, role, opts) {
  // メンバーにはメールアドレスが要る(メールアドレスで本人を照合してログインさせるため)
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(email || '').trim())) {
    throw userError_('メールアドレスが無い・形が正しくないため、メンバーを追加できません(メールアドレスが無いとログインできません)。')
  }
  email = String(email).trim()
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
  // 初期タスク(メンバーを作った時に1回だけ。失敗してもメンバーの追加は止めない)
  try { createInitialTasksForMember_(id, !!(opts && opts.firstLeader)) } catch (e) { console.error('初期タスクを作れませんでした: ' + maskEmailsIn_(String(e))) }
  return { id: id }
}

// ---- 初期タスク(メンバーを作った時に GAS で作る) ----
//
// メンバーを作った時(メンバーの追加・候補者のメンバー化・初期設定コードで最初の代表が入った時)に1回だけ作る。
// ログインの時には作らない(以前は画面だけで作っていたため、保存されず端末ごとに何度も付いた)。すでにいるメンバーには作らない。
//   新しいメンバー: Settings の initial_tasks_json([{ name, description }])があればそれ、無ければ INITIAL_MEMBER_TASKS
//   最初の代表: INITIAL_LEADER_TASKS(団体を使い始めるためにやること)
// タスクは「はじめに」のプロジェクトに入れる(無ければ作る)。承認待ちにせず、担当は本人
var INITIAL_TASKS_PROJECT_NAME = 'はじめに'
var INITIAL_TASKS_MAX = 20
var INITIAL_MEMBER_TASKS = [
  { name: 'Ohsumiの使い方を確認する', description: 'INPUT の画面で「今日やること」を入れて、承認を受けてみましょう。' },
  { name: 'プロフィールを設定する', description: '右上のアカウントのメニュー →「プロフィール」で、やりたいことと、スキルを登録しましょう。' },
  { name: 'チームメンバーのタスクを確認する', description: 'OUTPUT →「一覧」で、団体のタスク全体を見てみましょう。' },
]
var INITIAL_LEADER_TASKS = [
  { name: '団体の情報を設定する', description: 'ADMIN →「団体設定」で、団体名・ロゴ・テーマの色を入れます。' },
  { name: '役職と部署を決める', description: 'ADMIN →「部署と役職」で、役職(班長など)と部署を作ります。タスクの領域は「タスクの設定」で決めます。' },
  { name: 'メンバーを追加して招待する', description: 'ADMIN →「メンバー」の「メンバーを登録」で、名前とメールアドレスを入れ、「招待メールを送る」を選びます。' },
  { name: '最初のプロジェクトを作る', description: 'ADMIN →「プロジェクト」で、プロジェクトを1つ作ります(このタスクの「はじめに」とは別に作ります)。' },
  { name: '最初のタスクを作って担当を決める', description: 'INPUT の画面でタスクを入れ、担当者と期限を決めます。' },
  { name: '通知の受け取り方を決める', description: 'ADMIN →「団体設定」で Discord・Slack の通知先を、各自の「個人設定」(右上のメニュー)の通知でメールのまとめを決めます。' },
  { name: '安全の設定を確かめる', description: 'スプレッドシートを誰とも共有していないか、管理画面の上部の知らせ・団体の設定の「バックアップ」、団体のアカウントの2段階認証を確かめます。' },
  { name: '引き継ぎの準備をする', description: '団体の Google アカウントを誰が持ち、代替わりの時に誰に渡すかを決めて、メモに残します。' },
]

function initialTaskDefs_(firstLeader) {
  if (firstLeader) return INITIAL_LEADER_TASKS
  var custom = null
  try { custom = JSON.parse(String(getSettingValue_('initial_tasks_json') || '') || 'null') } catch (e) { custom = null }
  if (Array.isArray(custom)) {
    var list = custom.filter(function (t) { return t && String(t.name || '').trim() }).slice(0, INITIAL_TASKS_MAX).map(function (t) {
      return { name: String(t.name).trim().slice(0, 200), description: String(t.description || '').slice(0, 2000) }
    })
    if (list.length) return list
  }
  return INITIAL_MEMBER_TASKS
}

// 「はじめに」のプロジェクトの ID(無ければ作る)
function initialTasksProjectId_() {
  var table = snapshotTableOrSheet_(SHEET_PROJECTS) || { headers: [], rows: [] }
  var idCol = table.headers.indexOf('id'), nameCol = table.headers.indexOf('name')
  for (var i = 0; i < (table.rows || []).length; i++) {
    if (String(table.rows[i][nameCol] || '').trim() === INITIAL_TASKS_PROJECT_NAME) return String(table.rows[i][idCol])
  }
  // スナップショットが古い時のため、シートでも探す
  var sheet = getSheet_(SHEET_PROJECTS)
  var values = sheet.getDataRange().getValues()
  var h = (values[0] || []).map(function (x) { return String(x).trim() })
  for (var j = 1; j < values.length; j++) {
    if (String(values[j][h.indexOf('name')] || '').trim() === INITIAL_TASKS_PROJECT_NAME) return String(values[j][h.indexOf('id')])
  }
  return createProject_(INITIAL_TASKS_PROJECT_NAME, '新しいメンバー・代表が最初にやることのタスクを入れるプロジェクトです。', '').id
}

function createInitialTasksForMember_(memberId, firstLeader) {
  var defs = initialTaskDefs_(firstLeader)
  if (!defs.length) return []
  var projectId = initialTasksProjectId_()
  return createTasks_(defs.map(function (t, i) {
    return { tempId: 'init-' + i, projectId: projectId, title: t.name, description: t.description, assigneeIds: [String(memberId)],
      visibility: firstLeader ? 'leaders' : 'all', pendingApproval: false, difficulty: 'beginner', priority: 'medium' }
  }), String(memberId))
}

// ---- MemberEmails (非公開シート) ---------------------------------------------
//
// メールアドレスはMembersシート(公開CSV)には置かず、こちらの非公開シートに
// id(=Members.idと同じ値)をキーとして1人1行で保持する。読み書きは必ず
// このセクションの関数経由で行い、Membersシート側に書き戻さないこと。

// ---- 本人だけの保存(getMyStorage・setMyStorage) ----
//
// 画面が決めたキー(英小文字・数字・. _ -、64文字まで)ごとに、文字列の値を保存する。
// 読み書きできるのは本人の分だけ(メンバーID は認証済みの acting.id。画面が送るメンバーID は使わない)。
// 1人あたり PERSONAL_STORE_MAX_KEYS 個のキー・合わせて PERSONAL_STORE_MAX_CHARS 文字まで。
// 値は1つのセルの上限を超えないよう、PERSONAL_STORE_CHUNK 文字ずつの行に分ける。
// 初期データ・スナップショットには入れない(ほかの人には返さない)。個人情報の削除で消す
var SHEET_PERSONAL_STORE = 'PersonalStore'
var PERSONAL_STORE_CHUNK = 40000
var PERSONAL_STORE_MAX_CHARS = 150000
var PERSONAL_STORE_MAX_KEYS = 20
var PERSONAL_STORE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function personalStoreSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(SHEET_PERSONAL_STORE)
  if (!sheet && create) sheet = getOrCreateSheet_(SHEET_PERSONAL_STORE, PERSONAL_STORE_HEADERS)
  return sheet
}

// 本人の行(行番号・キー・何番目か・値)。メンバーID の列だけを読んで探し、本人の行だけを読む
function personalStoreRows_(sheet, memberId) {
  var last = sheet ? sheet.getLastRow() : 0
  if (last < 2) return []
  var headers = headerRow_(sheet)
  var col = function (h) { return headers.indexOf(h) }
  var ids = sheet.getRange(2, col('id') + 1, last - 1, 1).getValues()
  var out = []
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== String(memberId)) continue
    var r = sheet.getRange(i + 2, 1, 1, headers.length).getValues()[0]
    out.push({ row: i + 2, key: String(r[col('key')]), part: Number(r[col('part')]) || 0, value: String(r[col('value')] == null ? '' : r[col('value')]) })
  }
  return out
}

function personalStoreValues_(rows) {
  var byKey = {}
  rows.forEach(function (r) { (byKey[r.key] = byKey[r.key] || []).push(r) })
  var out = {}
  Object.keys(byKey).forEach(function (k) {
    out[k] = byKey[k].sort(function (a, b) { return a.part - b.part }).map(function (r) { return r.value }).join('')
  })
  return out
}

function getMyStorage_(memberId, keys) {
  var values = personalStoreValues_(personalStoreRows_(personalStoreSheet_(false), memberId))
  if (Array.isArray(keys)) {
    var picked = {}
    keys.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(values, String(k))) picked[String(k)] = values[String(k)] })
    values = picked
  }
  return { values: values }
}

// value: 文字列(画面が JSON にして送る)。null・空の文字列はキーを消す
function setMyStorage_(memberId, key, value) {
  key = String(key || '')
  if (!PERSONAL_STORE_KEY_RE.test(key)) throw userError_('保存のキーが正しくありません。')
  if (value !== null && value !== undefined && typeof value !== 'string') throw userError_('保存する値は文字列にしてください。')
  var text = value == null ? '' : value
  var sheet = personalStoreSheet_(true)
  var rows = personalStoreRows_(sheet, memberId)
  var current = personalStoreValues_(rows)
  var others = Object.keys(current).filter(function (k) { return k !== key })
  if (text) {
    if (others.length + 1 > PERSONAL_STORE_MAX_KEYS) throw userError_('保存できるキーは1人' + PERSONAL_STORE_MAX_KEYS + '個までです。')
    var total = text.length + others.reduce(function (n, k) { return n + current[k].length }, 0)
    if (total > PERSONAL_STORE_MAX_CHARS) throw userError_('保存できる大きさ(1人' + PERSONAL_STORE_MAX_CHARS + '文字)を超えています。')
  }
  var chunks = []
  for (var i = 0; i < text.length; i += PERSONAL_STORE_CHUNK) chunks.push(text.slice(i, i + PERSONAL_STORE_CHUNK))
  var mine = rows.filter(function (r) { return r.key === key }).sort(function (a, b) { return a.part - b.part })
  var headers = headerRow_(sheet)
  var now = new Date().toISOString()
  var rowOf = function (part, chunk) {
    var o = { id: String(memberId), key: key, part: part, value: chunk, updated_at: now }
    return headers.map(function (h) { return Object.prototype.hasOwnProperty.call(o, h) ? o[h] : '' })
  }
  chunks.forEach(function (chunk, part) {
    var target = mine[part] ? mine[part].row : sheet.getLastRow() + 1
    // 数式として扱われないよう、書式なしテキストにしてから書く
    sheet.getRange(target, 1, 1, headers.length).setNumberFormat('@')
    sheet.getRange(target, 1, 1, headers.length).setValues([rowOf(part, chunk)])
  })
  // 余った行は下から消す(行番号がずれないように)
  mine.slice(chunks.length).map(function (r) { return r.row }).sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  return { key: key, size: text.length }
}

// 個人情報の削除: 本人だけの保存を消す
function deletePersonalStore_(memberId) {
  var sheet = personalStoreSheet_(false)
  if (!sheet) return 0
  var rows = personalStoreRows_(sheet, memberId).map(function (r) { return r.row }).sort(function (a, b) { return b - a })
  rows.forEach(function (r) { sheet.deleteRow(r) })
  return rows.length
}

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
  fillRecordColumnsOfValues_(name, values)
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
  var img = parseImageDataUrl_(dataUrl)
  var mimeType = img.mimeType

  var folder = getUploadFolder_()
  var namePrefix = 'avatar_' + memberId + '_'

  // 前の画像は、メンバーの行に記録した URL のファイルだけを消す(フォルダ全体は調べない。
  // 領収書などが増えると遅くなるため)
  try {
    var prev = findRow_(SHEET_MEMBERS, memberId)
    trashUploadedImageByUrl_(prev && prev.avatar_url, namePrefix)
  } catch (e) { console.error('前のプロフィール画像を消せませんでした: ' + e) }

  var blob = Utilities.newBlob(img.bytes, mimeType, filename)
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

// 画像のアップロードの確かめ: 種類は jpeg・png・gif・webp だけ、大きさは IMAGE_UPLOAD_MAX_BYTES まで
var IMAGE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
var IMAGE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024
function parseImageDataUrl_(dataUrl) {
  var match = String(dataUrl || '').match(/^data:([^;]+);base64,(.*)$/)
  if (!match) throw userError_('画像を読み取れませんでした。')
  var mimeType = String(match[1]).toLowerCase()
  if (IMAGE_UPLOAD_TYPES.indexOf(mimeType) < 0) throw userError_('画像は JPEG・PNG・GIF・WebP のどれかを選んでください。')
  // base64 の長さから、元の大きさを先に見積もって断る(大きなデータを読み込む前に)
  if (match[2].length * 3 / 4 > IMAGE_UPLOAD_MAX_BYTES + 4) throw userError_('画像が大きすぎます(2MB まで)。')
  var bytes = Utilities.base64Decode(match[2])
  if (bytes.length > IMAGE_UPLOAD_MAX_BYTES) throw userError_('画像が大きすぎます(2MB まで)。')
  return { mimeType: mimeType, bytes: bytes }
}

// アップロードした画像の URL(https://lh3.googleusercontent.com/d/<ファイルID>=...)から、そのファイルだけをゴミ箱に移す。
// 名前が namePrefix で始まる、アップロード用のフォルダのファイルだけを消す(ほかのファイルを消さないため)
function trashUploadedImageByUrl_(url, namePrefix) {
  var m = String(url || '').match(/\/d\/([A-Za-z0-9_-]{10,})/)
  if (!m) return
  var file = DriveApp.getFileById(m[1])
  if (String(file.getName()).indexOf(namePrefix) === 0) file.setTrashed(true)
}

// 団体ロゴをDriveにアップロードし、Settingsシートのorg_logo_urlを更新する。
// uploadAvatarと異なりMembersシートは変更しない。
function uploadOrgLogo_(dataUrl, filename) {
  var img = parseImageDataUrl_(dataUrl)
  var mimeType = img.mimeType

  var folder = getUploadFolder_()
  var namePrefix = 'org_logo_'

  // 前のロゴは、設定に記録した URL のファイルだけを消す
  try { trashUploadedImageByUrl_(getSettingValue_('org_logo_url'), namePrefix) } catch (e) { console.error('前のロゴを消せませんでした: ' + e) }

  var blob = Utilities.newBlob(img.bytes, mimeType, filename)
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
  var img = parseImageDataUrl_(dataUrl)
  var mimeType = img.mimeType

  var folder = getUploadFolder_()
  var namePrefix = 'survey_image_'

  var blob = Utilities.newBlob(img.bytes, mimeType, filename)
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
  var cleanup = withdrawCleanupRoles_(String(memberId))
  var withdrawnAt = new Date(nowMs).toISOString()
  // 未アサインに戻したタスク(退会を取り消した時に、代表に一覧を出す)
  updateMemberFields_(memberId, { inactive: 'TRUE', withdrawn_at: withdrawnAt, purge_at: '', withdrawal_unassigned_task_ids: unassigned.join(',') })
  // ログイン用の対応表のキャッシュを無効にし、退会したメンバーのログイン(全端末)を無効にする
  bumpMemberEmailsVersion_()
  bumpSessionGeneration_(memberId)
  var purgeAt = new Date(nowMs + personalDataRetentionDays_() * 24 * 3600 * 1000).toISOString()
  appendOrgAudit_(actorId, 'removeMember', String(memberId), { withdrawnAt: withdrawnAt, purgeAt: purgeAt })
  notifyWithdrawCleanup_(member, cleanup)
  return { removed: String(memberId), withdrawnAt: withdrawnAt, purgeAt: purgeAt, cleanup: cleanup }
}

// 退会したメンバーの、担当以外の役割を外す(確認者・ほかのメンバーの報告先とメンター・プロジェクトの責任者とメンバー)。
// 外したものを返す(代表への知らせに使う)。経費・申請フォームの承認の段は変えない(進行中のものは代表が確かめる)
function withdrawCleanupRoles_(memberId) {
  var out = { reviewerTasks: [], reviewShort: [], reportsTo: [], mentees: [], ownerProjects: [], memberProjects: [] }
  var dropId = function (csv) {
    var list = splitCsvList_(csv)
    var next = list.filter(function (id) { return id !== memberId })
    return next.length === list.length ? null : next.join(',')
  }
  // タスクの確認者(完了したタスクは記録として残す)
  try {
    var ts = getSheet_(SHEET_TASKS), th = headerRow_(ts), tv = ts.getDataRange().getValues()
    var c = function (n) { return th.indexOf(n) }
    for (var i = 1; i < tv.length; i++) {
      var row = tv[i]
      if (normalizeCode_('status', row[c('status')]) === 'done') continue
      var changed = false
      if (c('reviewer_ids') >= 0) {
        var next = dropId(row[c('reviewer_ids')])
        if (next !== null) { ts.getRange(i + 1, c('reviewer_ids') + 1).setValue(next); changed = true; row[c('reviewer_ids')] = next }
      }
      if (c('reviewer_id') >= 0 && String(row[c('reviewer_id')] || '') === memberId) { ts.getRange(i + 1, c('reviewer_id') + 1).setValue(''); changed = true; row[c('reviewer_id')] = '' }
      if (!changed) continue
      var title = String(row[c('title')] || '')
      out.reviewerTasks.push(title)
      // 確認待ちで、残りの確認者が必要な承認の数に届かない
      if (normalizeCode_('status', row[c('status')]) === 'review') {
        var left = splitCsvList_(row[c('reviewer_ids')]).concat(splitCsvList_(row[c('reviewer_id')])).filter(function (v, k, a) { return a.indexOf(v) === k }).length
        var need = c('required_approvals') >= 0 ? String(row[c('required_approvals')] || '1') : '1'
        if (left === 0 || (need !== 'all' && left < Number(need))) out.reviewShort.push(title)
      }
    }
  } catch (e) { console.error('退会: 確認者を外せませんでした: ' + e) }
  // ほかのメンバーの報告先・メンター
  try {
    var ms = getSheet_(SHEET_MEMBERS), mh = headerRow_(ms), mv = ms.getDataRange().getValues()
    var name = function (r) { return String(r[mh.indexOf('display_name')] || r[mh.indexOf('name')] || '') }
    for (var j = 1; j < mv.length; j++) {
      if (mh.indexOf('reports_to_id') >= 0 && String(mv[j][mh.indexOf('reports_to_id')] || '') === memberId) {
        ms.getRange(j + 1, mh.indexOf('reports_to_id') + 1).setValue(''); out.reportsTo.push(name(mv[j]))
      }
      if (mh.indexOf('mentor_id') >= 0 && String(mv[j][mh.indexOf('mentor_id')] || '') === memberId) {
        ms.getRange(j + 1, mh.indexOf('mentor_id') + 1).setValue(''); out.mentees.push(name(mv[j]))
      }
    }
  } catch (e) { console.error('退会: 報告先・メンターを外せませんでした: ' + e) }
  // プロジェクトの責任者・メンバー
  try {
    var ps = getSheet_(SHEET_PROJECTS), ph = headerRow_(ps), pv = ps.getDataRange().getValues()
    for (var k = 1; k < pv.length; k++) {
      var pname = String(pv[k][ph.indexOf('name')] || '')
      if (ph.indexOf('owner_id') >= 0 && String(pv[k][ph.indexOf('owner_id')] || '') === memberId) {
        ps.getRange(k + 1, ph.indexOf('owner_id') + 1).setValue(''); out.ownerProjects.push(pname)
      }
      if (ph.indexOf('member_ids') >= 0) {
        var nm = dropId(pv[k][ph.indexOf('member_ids')])
        if (nm !== null) { ps.getRange(k + 1, ph.indexOf('member_ids') + 1).setValue(nm); out.memberProjects.push(pname) }
      }
    }
  } catch (e) { console.error('退会: プロジェクトから外せませんでした: ' + e) }
  return out
}

// 退会の後に、設定し直しが要るものを代表・管理者に知らせる(1日のまとめのメール)
function notifyWithdrawCleanup_(member, cleanup) {
  try {
    var who = String((member && (member.display_name || member.name)) || '')
    var lines = []
    if (cleanup.reviewShort.length) lines.push('・確認者が足りなくなった確認待ちのタスク: ' + cleanup.reviewShort.join('、'))
    if (cleanup.reportsTo.length) lines.push('・報告先(上長)の設定が必要なメンバー: ' + cleanup.reportsTo.join('、'))
    if (cleanup.mentees.length) lines.push('・メンターの設定が必要なメンバー: ' + cleanup.mentees.join('、'))
    if (cleanup.ownerProjects.length) lines.push('・責任者がいなくなったプロジェクト: ' + cleanup.ownerProjects.join('、'))
    lines.push('・進行中の経費・申請フォームで、' + who + 'さんが承認の段に指定されているものがあれば、承認の段を見直してください')
    notifyAdmins_('[Ohsumi] 退会したメンバーの役割の引き継ぎ', who + 'さんが退会しました。次の設定を見直してください。\n\n' + lines.join('\n') + '\n\nOhsumiで確認してください。')
  } catch (e) { console.error('退会の知らせを送れませんでした: ' + maskEmailsIn_(String(e))) }
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
  // タスクは、TasksArchive に移したタスクの ID も使わない(戻した時にぶつからないように)
  max = Math.max(max, archivedMaxIdFor_(sheet))
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
      fillRecordColumnsOfRow_(sheetName, headers, values[i])
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
  // タスクの期限・担当者・名前・完了などを変えた時は、カレンダーの予定を合わせる(syncCalendarForTask_)
  var calendarHints = null
  if (sheetName === SHEET_TASKS) {
    var beforeRow = null
    try {
      // 書き込みで読む表(このリクエストで覚えている表)から、書き換える前の値を取る
      var at = sheetGridRow_(SHEET_TASKS, rowId)
      var vals = at.row > 0 ? at.grid.values[at.row - 1] : null
      if (vals) beforeRow = { status: vals[at.grid.headers.indexOf('status')], due_date: vals[at.grid.headers.indexOf('due_date')], title: vals[at.grid.headers.indexOf('title')] }
    } catch (e) { beforeRow = null }
    calendarHints = calendarSyncHints_(fields, beforeRow)
  }
  // 記録の一覧の列は、行に持っている時は記録のシートに書く(39-record-rows.gs)。移している間は断る
  assertRecordWritable_(sheetName, fields)
  var recordFields = null
  var cellFields = fields
  if (recordRowsOn_() && recordListsOf_(sheetName).length) {
    recordFields = {}
    cellFields = {}
    Object.keys(fields).forEach(function (k) { (isRecordColumn_(sheetName, k) ? recordFields : cellFields)[k] = fields[k] })
  }
  var result = measureAction_('sheetWriteMs', function () { return updateRowFieldsUnmeasured_(sheetName, rowId, cellFields) })
  if (recordFields && Object.keys(recordFields).length) {
    measureAction_('sheetWriteMs', function () { splitRecordFields_(sheetName, rowId, recordFields) })
    noteRecordFieldsInGrid_(sheetName, rowId, recordFields)
    result.updated = Object.keys(fields)
  }
  if (calendarHints) syncCalendarForTask_(rowId, calendarHints)
  return result
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
  // 記録を行に持っている時は、一覧の列に行から組み立てた一覧を入れる(39-record-rows.gs)
  fillRecordColumnsOfValues_(sheetName, values)
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
  'last_login', 'last_inactive_notified', 'last_notified_health', 'last_activity', 'calendar_event_id',
  // 項目ごとの差分で確かめる記録の一覧と、GAS が足し算でまとめる列
  'comments_json', 'progress_history_json', 'history_json', 'deliverables_json',
  'career_history_json', 'qualifications_json', 'evaluation_history_json', 'transfer_history_json',
  'skill_levels_json', 'competencies_json', 'training_history_json', 'development_plan_json', 'one_on_ones_json',
  'survey_responses_json', 'skill_points_json', 'awarded_points_json', 'quiz_passes_json',
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
  var cap = cfg.column === 'history_json' ? historyCap_() : cfg.cap
  if (cap && list.length > cap) list = list.slice(0, cap)
  return list
}

// 差分(listOps)を、今の一覧に当てた一覧(body の一覧の項目: comments・entries など)にする。
// locked: ロックを取った後(今のシートの値に当て、競合を確かめる)。そうでなければ権限の判定に使うスナップショットに当てる
function expandListOps_(body, locked) {
  var cfg = body && LIST_ACTIONS[body.action]
  if (!cfg || body.listOps === undefined) return
  if (isRecordColumn_(cfg.sheet, cfg.column) && recordRowsBusy_(Date.now())) throw userError_(RECORD_ROWS_BUSY_MESSAGE)
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
  // 記録を行に持っている時は、組み立てた一覧はセルに入っていないので数えない
  var rowsOn = false
  try { rowsOn = recordRowsOn_() } catch (e) { rowsOn = false }
  SNAPSHOT_SHEETS.forEach(function (name) {
    var table = data[name]
    if (!table || !table.headers) return
    var idCol = table.headers.indexOf(name === SHEET_SETTINGS ? 'key' : 'id')
    ;(table.rows || []).forEach(function (row) {
      row.forEach(function (v, col) {
        if (rowsOn && isRecordColumn_(name, table.headers[col])) return
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
  resetRecordRowsMemo_()
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
  var changed = false
  var generated = []

  rules.forEach(function (rule) {
    if (!rule.active || rule.lastGeneratedDate === today) return
    // 作る日: 前回作った日の次の日から今日まで(最大31日さかのぼる)のうち、規則に合う日。
    // 毎朝の処理が動かなかった日の分も作る。初めての規則は今日の分だけ。
    // 毎月の規則で指定の日(29〜31日)が無い月は、その月の最終日に作る
    var dates = recurringDueDates_(rule, rule.lastGeneratedDate || '', today)
    if (!dates.length) return

    // isolate each rule — one bad rule (e.g. a stale projectId, a transient
    // Sheets error) must not abort the whole daily trigger and skip both
    // the remaining rules' lastGeneratedDate writes and the overdue-task
    // Discord sweep that runs after this function in dailyMaintenance()
    dates.forEach(function (onDate) {
    try {
      var deadline = null
      if (rule.dueInDays != null) {
        var base = new Date(onDate + 'T12:00:00')
        var d = new Date(base.getTime() + rule.dueInDays * 86400000)
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
      rule.lastGeneratedDate = onDate === dates[dates.length - 1] ? today : onDate
      changed = true
    } catch (err) {
      // best-effort — skip this rule today, try again on the next run
    }
    })
  })

  if (changed) updateSetting_(SETTINGS_KEY_RECURRING_RULES, JSON.stringify(rules))
  return { generated: generated }
}

// 定期タスクを作る日(YYYY-MM-DD)の一覧。lastDate の次の日から today まで(最大31日)のうち、規則に合う日。
// lastDate が空(初めての規則)なら、今日が規則に合う時だけ今日。
// 毎月の規則で dayOfMonth がその月に無い(29〜31日)時は、その月の最終日を作る日にする
function recurringDueDates_(rule, lastDate, today) {
  var DAY = 86400000
  var toDate = function (str) { return new Date(str + 'T12:00:00') }
  var fmt = function (d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') }
  var end = toDate(today)
  var start = lastDate ? new Date(toDate(lastDate).getTime() + DAY) : end
  if (end.getTime() - start.getTime() > 31 * DAY) start = new Date(end.getTime() - 31 * DAY)
  var out = []
  for (var t = start.getTime(); t <= end.getTime(); t += DAY) {
    var d = new Date(t)
    var hit
    if (rule.frequency === 'weekly') {
      hit = d.getDay() === Number(rule.dayOfWeek)
    } else {
      var lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      hit = d.getDate() === Math.min(Number(rule.dayOfMonth), lastDom)
    }
    if (hit) out.push(fmt(d))
  }
  return out
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
  var withdrawnCol = headers.indexOf('withdrawn_at')
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
      if (headers.indexOf('deleted_at') >= 0 && String(r[headers.indexOf('deleted_at')] || '') !== '') return
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
      '\n\n心当たりがない場合は ADMIN →「団体設定」から確認してください。',
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
      '\n\n心当たりがない場合は ADMIN →「団体設定」から確認してください。',
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

// チャンネル(Discord・Slack)に出すタスクの名前。チャンネルにはメンバー全員(や団体の外の人)が
// 入っていることがあるので、幹部限定のタスク・承認待ちのタスクは名前を出さない
function chatTaskLabel_(task) {
  if (normalizeCode_('visibility', task && task.visibility) === 'leaders') return '幹部限定のタスク'
  if (normalizeCode_('approval', task && task.approval_status) === 'pending') return '承認待ちのタスク'
  return '「' + String((task && task.title) || '') + '」'
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
    var visCol = headers.indexOf('visibility')
    var apprCol = headers.indexOf('approval_status')
    if (titleCol === -1 || dueCol === -1 || statusCol === -1) return
    var lastRow = sheet.getLastRow()
    if (lastRow < 2) return
    var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
    var today = todayStr_()
    var overdue = rows
      .map(function (r) {
        return {
          title: r[titleCol], due: cellDateStr_(r[dueCol]), status: String(r[statusCol] || ''),
          visibility: visCol >= 0 ? r[visCol] : '', approval_status: apprCol >= 0 ? r[apprCol] : '',
          deleted_at: headers.indexOf('deleted_at') >= 0 ? r[headers.indexOf('deleted_at')] : '',
        }
      })
      .filter(function (t) {
        if (isTrashedTask_(t)) return false
        // 承認待ち(まだ承認されていない)のタスクは、チャンネルには出さない
        if (normalizeCode_('approval', t.approval_status) === 'pending') return false
        return t.due && t.due < today && normalizeCode_('status', t.status) !== 'done'
      })
    if (overdue.length === 0) return
    var lines = overdue.map(function (t) {
      return '・' + chatTaskLabel_(t) + '（期限: ' + t.due + '）'
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
var SNAPSHOT_UNTOUCHED_ACTIONS = ['addCandidate', 'removeCandidate', 'updateEmail', 'rejectFormSubmission', 'submitDailyReport', 'setMyStorage', 'setOrgStorage']

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
  // 記録の行(39-record-rows.gs)は、スナップショットの Tasks・Members に組み立てて返す
  TaskRecords: bumpSnapshotVersion_,
  MemberRecords: bumpSnapshotVersion_,
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
  // 記録を行に持っている時は、Tasks・Members の一覧の列に、行から組み立てた一覧を入れる(39-record-rows.gs)
  var data = fillRecordColumnsOfSnapshot_(readSheetTables_(SNAPSHOT_SHEETS))
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
      quiz_passes_json: 'selfOrAdminRole',
      // スキルのレベルの承認(誰が・いつ・何を認めたか)。見る立場の人と本人
      skill_approvals_json: 'selfOrSupervisor',
      evaluation_history_json: 'selfOrSupervisor',
      transfer_history_json: 'selfOrAdminRole',
      competencies_json: 'selfOrAdminRole',
      training_history_json: 'selfOrAdminRole',
      development_plan_json: 'selfOrSupervisor',
      one_on_ones_json: 'selfOrSupervisor',
      career_aspiration: 'selfOrSupervisor',
      desired_future_role: 'selfOrSupervisor',
      career_plan: 'selfOrSupervisor',
      university: 'selfOrAdminRole',
      faculty: 'selfOrAdminRole',
      department_name: 'selfOrAdminRole',
      grade_year: 'selfOrAdminRole',
      custom_fields_json: 'selfOrAdminRole',
      skill_points_json: 'selfOrAdminRole',
      survey_responses_json: 'selfOrSupervisor',
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
      open_bid_applicant_ids: 'all', related_review_task_id: 'all', calendar_event_id: 'none',
      deleted_at: 'all', deleted_by: 'all',
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
      skill_level_rules: 'all',
      // 稼働の目安の決め方(37-value-checks.gs の checkWorkloadRules_ で確かめてから保存する)
      workload_rules: 'all',
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
      // 人材データの項目ごとの閲覧範囲(33-member-field-visibility.gs)。どの範囲かは、全員に見せてよい
      member_field_visibility: 'all',
      // 団体の保存の、キーごとの読み書きの役職(35-org-store.gs)
      org_storage_access: 'fullAdmin',
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
    isTop: roleTier_(roles, role) === 'top',
    // 評価・1on1 などを見られる相手(buildViewerData_ が報告先・メンター・プロジェクトの責任者から作る)
    supervisedIds: {},
    // Members の列ごとの規則の上書き(Settings の member_field_visibility から buildViewerData_ が入れる)
    memberColumnRules: {},
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
    // 本人・代表・その人を見る立場の人(報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者)
    case 'selfOrSupervisor': return (!!ownerId && ownerId === viewer.id) || !!viewer.isTop || !!(viewer.supervisedIds && viewer.supervisedIds[ownerId])
    default: return false
  }
}

// タスクの行の規則(画面の visibleTasks / pendingTasks の表示範囲を再現する)
//   幹部限定: 一般以外の役職のみ
//   承認待ち: 一般以外の役職と、作成者・担当者
function canViewTaskRow_(viewer, task) {
  // ゴミ箱のタスクは、元に戻す・完全に消すことのできる代表・全権管理者だけに返す
  if (String(task.deleted_at || '') !== '' && !viewer.isFullAdmin) return false
  // 値は移行前の日本語・コードのどちらでもよい
  // 幹部限定のタスクも、担当者・確認者・作成者には見せる(自分の担当のタスクが見えなくならないように)
  if (normalizeCode_('visibility', task.visibility) === 'leaders' && !viewer.isAdminRole) {
    var involved = splitCsvList_(task.assignee_id).concat(splitCsvList_(task.reviewer_ids), splitCsvList_(task.reviewer_id), [String(task.creator_id || '')])
    if (involved.indexOf(viewer.id) < 0) return false
  }
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
    var overrides = sheetName === 'Members' ? (viewer.memberColumnRules || {}) : {}
    outRows.push(keepCols.map(function (c) {
      var rule = overrides[headers[c]] || policy.columns[headers[c]]
      return checkReadRule_(rule, viewer, ownerId) ? row[c] : ''
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

// 閲覧者が「見る立場」にあるメンバーの ID(評価・1on1 などの読み取りに使う)。
//   ・報告先(reports_to_id)をたどって、閲覧者が上にいるメンバー
//   ・メンター(mentor_id)が閲覧者のメンバー
//   ・閲覧者が責任者(owner_id)のプロジェクト(その子プロジェクトも含む)に入っているメンバー
function supervisedMemberIds_(data, viewerId) {
  var out = {}
  if (!viewerId) return out
  var members = data.Members || { headers: [], rows: [] }
  var mh = members.headers || []
  var idCol = mh.indexOf('id'), repCol = mh.indexOf('reports_to_id'), mentorCol = mh.indexOf('mentor_id')
  var reportsTo = {}
  ;(members.rows || []).forEach(function (r) {
    var id = String(r[idCol] || '')
    if (!id) return
    reportsTo[id] = repCol >= 0 ? String(r[repCol] || '') : ''
    if (mentorCol >= 0 && String(r[mentorCol] || '') === viewerId) out[id] = true
  })
  Object.keys(reportsTo).forEach(function (id) {
    var cur = reportsTo[id]
    for (var hop = 0; cur && hop < 20; hop++) {
      if (cur === viewerId) { out[id] = true; break }
      cur = reportsTo[cur]
    }
  })
  var projects = data.Projects || { headers: [], rows: [] }
  var ph = projects.headers || []
  var pid = ph.indexOf('id'), owner = ph.indexOf('owner_id'), mem = ph.indexOf('member_ids'), parent = ph.indexOf('parent_id')
  if (pid >= 0 && owner >= 0 && mem >= 0) {
    var byId = {}, children = {}
    ;(projects.rows || []).forEach(function (r) {
      var id = String(r[pid] || '')
      if (!id) return
      byId[id] = r
      var p = parent >= 0 ? String(r[parent] || '') : ''
      if (p) (children[p] = children[p] || []).push(id)
    })
    var stack = Object.keys(byId).filter(function (id) { return String(byId[id][owner] || '') === viewerId })
    var seen = {}
    while (stack.length) {
      var cur = stack.pop()
      if (seen[cur]) continue
      seen[cur] = true
      splitCsvList_(byId[cur][mem]).forEach(function (m) { out[m] = true })
      ;(children[cur] || []).forEach(function (c) { stack.push(c) })
    }
  }
  delete out[viewerId]
  return out
}

// スナップショット全体を閲覧者に合わせて絞り込む(getInitialData の本体。
// Google のサービスを使わない純粋な関数なのでテストから直接呼べる)
function buildViewerData_(data, memberId) {
  var memberRow = findMemberInSnapshot_(data, memberId)
  if (!memberRow) return null
  var viewer = makeViewer_(memberRow, rolesFromSnapshot_(data))
  viewer.supervisedIds = supervisedMemberIds_(data, viewer.id)
  viewer.memberColumnRules = memberColumnRulesFromSnapshot_(data)
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
  // ログインした人のできる操作(役職の分と人ごとの例外の分。画面はこれだけを見て操作の部品を出す)
  var capabilities = memberCapabilitiesFromSnapshot_(snapshot.data, memberId)
  var out = { memberId: memberId, version: snapshot.version, sheets: sheets, capabilities: capabilities }
  // 記録の持ち方(none / migrating / done。39-record-rows.gs)。古い GAS には無い(画面はこれで見分ける)
  out.recordRows = recordRowsStateOfSnapshot_(snapshot.data).state
  // 最上位の役職の人にだけ、団体のスプレッドシートと Apps Script の編集画面の URL を渡す(GAS の更新・確かめ用)
  var member = findMemberInSnapshot_(snapshot.data, memberId)
  if (member && isTopRoleRef_(rolesFromSnapshot_(snapshot.data), member.role)) {
    var links = orgAdminLinks_()
    if (links) out.adminLinks = links
  }
  return out
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


// 団体のスプレッドシートと Apps Script の編集画面の URL(最上位の役職の人の画面に出す)。取れなければ null
function orgAdminLinks_() {
  try {
    var spreadsheetUrl = String(SpreadsheetApp.getActive().getUrl() || '')
    var scriptId = String(ScriptApp.getScriptId() || '')
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(spreadsheetUrl) || !/^[\w-]+$/.test(scriptId)) return null
    return { spreadsheetUrl: spreadsheetUrl, scriptEditUrl: 'https://script.google.com/d/' + scriptId + '/edit' }
  } catch (e) {
    return null
  }
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

function assertTestEnvironment_() {
  if (!isTestEnvironment_()) {
    throw userError_('テスト環境ではないため実行できません。スクリプトプロパティ TEST_ENVIRONMENT を true にしてから実行してください。')
  }
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
// 自動で取るバックアップの名前の末尾(記録の移行・戻すの前は 39-record-rows.gs)
var BACKUP_KIND_SUFFIXES = { beforeRestore: BACKUP_BEFORE_RESTORE_SUFFIX, beforeMigration: '(移行の前)', beforeRevert: '(移行を戻す前)' }
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
    (BACKUP_KIND_SUFFIXES[kind] || '')
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

// 代表が管理画面から「今すぐバックアップを作る」。作りすぎないよう、前に手で作ってから10分は断る。
// 作った後は、毎日の分と同じく残す数を超えた古いものを片付ける
var BACKUP_MANUAL_INTERVAL_MS = 10 * 60 * 1000
function createBackupNow_(actorId, nowMs) {
  nowMs = nowMs || Date.now()
  if (restoreInProgress_()) throw userError_('バックアップから戻している間は、バックアップを作れません。')
  var state = readBackupState_()
  var last = Date.parse(state.lastManualAt || '')
  if (last && nowMs - last < BACKUP_MANUAL_INTERVAL_MS) {
    throw userError_('少し前にバックアップを作ったばかりです。10分ほど待ってから、もう一度お試しください。')
  }
  var made
  try {
    made = createBackup_('manual', nowMs)
  } catch (e) {
    var message = String((e && e.message) || e).slice(0, 300)
    writeBackupState_({ lastFailureAt: new Date(nowMs).toISOString(), lastError: message })
    throw userError_('バックアップを作れませんでした: ' + message)
  }
  writeBackupState_({ lastSuccessAt: made.at, lastName: made.name, lastManualAt: made.at, lastFailureAt: '', lastError: '' })
  try { pruneBackups_(nowMs) } catch (e) { console.error('古いバックアップを片付けられませんでした: ' + e) }
  try { appendOrgAudit_(actorId, 'createBackupNow', made.name, { backupId: made.id }) } catch (e) { console.error('操作の記録: ' + e) }
  return { backup: made, status: backupStatus_(), backups: listBackups_() }
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
    // 記録のシート: 移行の前のバックアップには無いので、今の分を空にする(印は Settings と一緒に戻っている)
    afterFullRestoreRecordRows_(restored)
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
  // TasksArchive に移したタスクは、移した内容と比べる(archived: true。戻すと Tasks に戻る)
  var archivedIds = {}
  archivedTaskRows_().forEach(function (t) {
    var id = String(t.id)
    if (current.rows[id]) return
    current.rows[id] = t
    archivedIds[id] = true
  })
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
    var item = { id: id, title: String(bt.title || ''), currentTitle: ct ? String(ct.title || '') : '', state: !ct ? 'missing' : diffs.length ? 'changed' : 'same', diffs: diffs }
    if (archivedIds[id]) item.archived = true
    out.push(item)
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
  var src = SpreadsheetApp.openById(b.id)
  var srcSheet = src.getSheetByName(SHEET_TASKS)
  // 記録を1件1行で持っている時は、バックアップ・今の、それぞれの記録のシートから一覧を組み立てて合わせる(39-record-rows.gs)
  var srcValues = fillRecordColumnsFromSpreadsheet_(src, SHEET_TASKS, srcSheet.getDataRange().getValues())
  var backup = taskTableOf_(srcValues)
  var sheet = getSheet_(SHEET_TASKS)
  var liveValues = sheet.getDataRange().getValues()
  fillRecordColumnsOfValues_(SHEET_TASKS, liveValues)
  var rowsOn = recordRowsOn_()
  var headers = (liveValues[0] || []).map(function (h) { return String(h).trim() })
  var idCol = headers.indexOf('id')
  var rowOf = {}
  for (var i = 1; i < liveValues.length; i++) rowOf[String(liveValues[i][idCol])] = i
  var label = Utilities.formatDate(new Date(b.at), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
  // TasksArchive に移したタスクは、移した内容を今の内容として合わせ、Tasks に戻す(TasksArchive からは消す)
  var archived = {}
  archivedTaskRows_().forEach(function (t) { if (rowOf[String(t.id)] === undefined) archived[String(t.id)] = t })
  var unarchived = []
  var done = []
  ids.forEach(function (id) {
    var bt = backup.rows[id]
    if (!bt) return
    var cur = rowOf[id] !== undefined ? liveValues[rowOf[id]] : null
    if (!cur && archived[id]) {
      cur = headers.map(function (h) { return archived[id][h] === undefined ? '' : archived[id][h] })
      unarchived.push(id)
    }
    var isLive = rowOf[id] !== undefined
    var row = headers.map(function (h, c) {
      if (RESTORE_MERGED_TASK_LISTS.indexOf(h) < 0) return bt[h] === undefined ? (cur ? cur[c] : '') : bt[h]
      var merged = mergeTaskList_(parseJsonList_(bt[h]), parseJsonList_(cur ? cur[c] : '[]'), h === 'history_json')
      if (h === 'history_json') {
        merged.unshift({ id: 'h-restore-' + Utilities.getUuid(), at: new Date(nowMs).toISOString(), byId: String(actorId), field: 'restored', from: label, to: '' })
        merged = merged.slice(0, historyCap_())
      }
      return JSON.stringify(merged)
    })
    var rowNumber = isLive ? rowOf[id] + 1 : sheet.getLastRow() + 1
    var target = sheet.getRange(rowNumber, 1, 1, headers.length)
    // 記録を行に持っている時は、一覧の列はセルを空にして、記録のシートに書く
    var recordFields = {}
    if (rowsOn) headers.forEach(function (h, c) { if (isRecordColumn_(SHEET_TASKS, h)) { recordFields[h] = row[c]; row[c] = '' } })
    // 文字として扱う列は、値を書く前に書式を文字にする(数式として扱われないように)
    protectRowFromFormulaInjection_(sheet, headers, rowNumber, SHEET_TASKS)
    target.setValues([row])
    if (rowsOn) splitRecordFields_(SHEET_TASKS, id, recordFields)
    if (!isLive) rowOf[id] = rowNumber - 1
    done.push({ id: id, title: String(bt.title || ''), state: isLive ? 'restored' : archived[id] ? 'unarchived' : 'recreated' })
  })
  if (unarchived.length) deleteRowsById_(tasksArchiveSheet_(false), unarchived)
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
  deletePersonalStore_(memberId)
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
// 以前の退会(行を消していた)で残った行のほか、メンバーID の対応がずれている時にも出る。
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
  // ゴミ箱に入れてから30日たったタスクを消す
  try { purgeExpiredTrashLocked_(Date.now()) } catch (err) { console.error('ゴミ箱のタスクを消せませんでした: ' + String(err)) }
  // 完了してから日数がたったタスクを TasksArchive に移す
  try { archiveOldTasksLocked_(Date.now()) } catch (err) { console.error('古いタスクを移せませんでした: ' + String(err)) }
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
// 版 2(PR X の後): 将来使いそうな指標を、今のうちから数えて送る(過去の分は後から作れないため)
var METRICS_VERSION = 2
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
  var tasks = table(SHEET_TASKS).filter(function (t) { return String(t.id || '') && !isTrashedTask_(t) })
  var projects = table(SHEET_PROJECTS).filter(function (p) { return String(p.id || '') && !boolCellValue_(p.archived) })
  var today = Utilities.formatDate(new Date(nowMs), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var isDone = function (t) { return normalizeCode_('status', t.status) === 'done' }
  // ログイン・読み込み・書き込みの回数(利用の集計。直近7日)
  var usage = usageStatus_(nowMs)
  var last7 = usage.days.slice(-7)
  var sum = function (k) { return last7.reduce(function (n, d) { return n + d[k] }, 0) }
  var parseList = function (v) { try { var a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch (e) { return [] } }
  var parseObj = function (v) { try { var o = JSON.parse(String(v || '{}')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch (e) { return {} } }
  // 期限を過ぎた日数(完了していないタスク。今日より前の期限だけ)
  var overdueDays = tasks.filter(function (t) { var d = String(t.due_date || '').slice(0, 10); return !isDone(t) && d && d < today }).map(function (t) {
    return Math.max(1, Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(String(t.due_date).slice(0, 10) + 'T00:00:00Z')) / day))
  }).filter(function (n) { return isFinite(n) })
  // 1on1 は両方のメンバーの記録に入ることがあるので、記録の ID で1回だけ数える
  var oneOnOnes = {}
  members.forEach(function (m) {
    parseList(m.one_on_ones_json).forEach(function (r) { if (r && r.id && within(String(r.date || '').slice(0, 10) + 'T00:00:00', 30)) oneOnOnes[String(r.id)] = true })
  })
  var applications = table(SHEET_EXPENSES).concat(table(SHEET_FORM_SUBMISSIONS)).filter(function (a) { return String(a.id || '') })
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
    // ---- 版 2 ----
    // 一度でもログインした人数(立ち上げの進み具合)
    members_logged_in: members.filter(function (m) { return isFinite(cellTimeMs_(m.last_login)) }).length,
    comments_7d: tasks.reduce(function (n, t) { return n + parseList(t.comments_json).filter(function (c) { return c && within(c.at, 7) }).length }, 0),
    reviews_approved_7d: tasks.reduce(function (n, t) { return n + parseList(t.review_approvals_json).filter(function (a) { return a && within(a.at, 7) }).length }, 0),
    tasks_overdue_days_avg: overdueDays.length ? Math.round(overdueDays.reduce(function (n, d) { return n + d }, 0) / overdueDays.length) : 0,
    skill_points_total: Math.floor(members.reduce(function (n, m) {
      var pts = parseObj(m.skill_points_json)
      return n + Object.keys(pts).reduce(function (k, key) { var v = Number(pts[key]); return k + (isFinite(v) && v > 0 ? v : 0) }, 0)
    }, 0)),
    daily_reports_7d: table(SHEET_DAILY_REPORTS).filter(function (r) { return String(r.id || '') && within(r.created_at, 7) }).length,
    one_on_ones_30d: Object.keys(oneOnOnes).length,
    expenses_7d: table(SHEET_EXPENSES).filter(function (r) { return String(r.id || '') && within(r.created_at, 7) }).length,
    form_submissions_7d: table(SHEET_FORM_SUBMISSIONS).filter(function (r) { return String(r.id || '') && within(r.created_at, 7) }).length,
    // 直近30日に出された経費・フォームの申請のうち、差し戻した(rejected)もの(差し戻した日時は残らないため、出した日で数える)
    applications_rejected_30d: applications.filter(function (a) { return String(a.status) === 'rejected' && within(a.created_at, 30) }).length,
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
  var registryUrl = registryUrl_()
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
        registered: REGISTRY_URL_PATTERN.test(registryUrl_()) && !!props.getProperty('REGISTRY_SHARED_KEY') && !!props.getProperty('ORG_ID'),
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
  var registryUrl = registryUrl_()
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

// ---- 人材データの項目ごとの閲覧範囲 ---------------------------------------------
//
// Settings の member_field_visibility に {列名: 範囲} の JSON を入れると、その列の閲覧範囲を変える
// (READ_POLICY の Members の規則を、閲覧者ごとに上書きする)。設定の無い列は、今までどおり READ_POLICY の規則。
// 設定できるのは代表・全権管理者だけ(updateSetting の権限)。範囲は次の4つ:
//   all         ログインしている全員
//   supervisor  本人・代表・その人を見る立場の人(報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者)
//   admin       本人と、一般以外の役職
//   self        本人だけ
// 評価・1on1・育成計画・キャリアの希望・アンケートの回答は、「見る立場の人」より広くできない
// (MEMBER_FIELD_NARROW_ONLY。広い範囲が保存されていても、今までどおりの範囲で返す)。
// 管理用の列(id・名前・役職・通知の設定・権限の上書き など)は、この設定では変えない。
var MEMBER_FIELD_VISIBILITY_KEY = 'member_field_visibility'
var MEMBER_FIELD_VISIBILITY_RULES = { all: 'all', supervisor: 'selfOrSupervisor', admin: 'selfOrAdminRole', self: 'self' }
var MEMBER_FIELD_VISIBILITY_COLUMNS = [
  'will_tags', 'judgment_tags', 'joined_at', 'department_path', 'unavailable_dates', 'absent_dates',
  'available_hours_json', 'skill_levels_json', 'timezone', 'mentor_id', 'has_management_experience',
  'desired_areas', 'desired_skills', 'career_history_json', 'qualifications_json', 'quiz_passes_json',
  'evaluation_history_json', 'transfer_history_json', 'competencies_json', 'training_history_json',
  'development_plan_json', 'one_on_ones_json', 'career_aspiration', 'desired_future_role', 'career_plan',
  'university', 'faculty', 'department_name', 'grade_year', 'custom_fields_json', 'skill_points_json',
  'survey_responses_json', 'last_login', 'skill_approvals_json',
]
var MEMBER_FIELD_NARROW_ONLY = [
  'evaluation_history_json', 'one_on_ones_json', 'development_plan_json',
  'career_aspiration', 'desired_future_role', 'career_plan', 'survey_responses_json',
]

// 保存された設定(JSON の文字列)を、列ごとの規則にする。読めない値・決まった範囲でない値・
// 狭めることしかできない列を広げる値は使わない(今までどおりの規則になる)
function memberColumnRulesFromValue_(value) {
  var out = {}
  var parsed
  try { parsed = typeof value === 'string' ? (value ? JSON.parse(value) : null) : value } catch (e) { return out }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  Object.keys(parsed).forEach(function (col) {
    if (MEMBER_FIELD_VISIBILITY_COLUMNS.indexOf(col) < 0) return
    var level = parsed[col]
    if (!Object.prototype.hasOwnProperty.call(MEMBER_FIELD_VISIBILITY_RULES, level)) return
    if (MEMBER_FIELD_NARROW_ONLY.indexOf(col) >= 0 && level !== 'supervisor' && level !== 'self') return
    out[col] = MEMBER_FIELD_VISIBILITY_RULES[level]
  })
  return out
}

function memberColumnRulesFromSnapshot_(data) {
  var settings = data.Settings || { headers: [], rows: [] }
  var keyCol = (settings.headers || []).indexOf('key')
  var valueCol = (settings.headers || []).indexOf('value')
  if (keyCol < 0 || valueCol < 0) return {}
  for (var i = 0; i < (settings.rows || []).length; i++) {
    if (String(settings.rows[i][keyCol]) === MEMBER_FIELD_VISIBILITY_KEY) return memberColumnRulesFromValue_(settings.rows[i][valueCol])
  }
  return {}
}

// updateSetting で保存する前に確かめる(おかしな値は保存しない)
function checkMemberFieldVisibility_(value) {
  if (value === '' || value === null || value === undefined) return
  var parsed
  try { parsed = JSON.parse(String(value)) } catch (e) { throw userError_('項目ごとの閲覧範囲の設定を読めませんでした。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw userError_('項目ごとの閲覧範囲の設定の形が正しくありません。')
  Object.keys(parsed).forEach(function (col) {
    if (MEMBER_FIELD_VISIBILITY_COLUMNS.indexOf(col) < 0) throw userError_('閲覧範囲を設定できない項目です: ' + String(col).slice(0, 60))
    var level = parsed[col]
    if (!Object.prototype.hasOwnProperty.call(MEMBER_FIELD_VISIBILITY_RULES, level)) throw userError_('閲覧範囲は 全員・見る立場の人・管理者・本人 のどれかにしてください。')
    if (MEMBER_FIELD_NARROW_ONLY.indexOf(col) >= 0 && level !== 'supervisor' && level !== 'self') {
      throw userError_('評価・1on1・育成計画・キャリアの希望・アンケートの回答は、見る立場の人より広くできません。')
    }
  })
}

// ---- スキルのレベルの承認(評価をスキルの証拠にする) -----------------------------
//
// approveSkillLevel { memberId, skill, level(1〜5), reason }: 「スキル○○を Lv.○ と認める」を、理由の文と一緒に記録する。
// 記録できるのは、代表と、その人を見る立場の人(報告先をたどった上の人・メンター・その人が入るプロジェクトの責任者。
// 評価・1on1 を読める人と同じ supervisedMemberIds_)。自分自身には記録できない(代表も)。
// 記録は Members の skill_approvals_json に {id, skill, level, reason, byId, at} で残す(誰が・いつ・何を)。
// skill_level_rules の条件 {type:'approval'} は、このスキルをそのレベル以上と認めた記録があれば満たす。
// 記録した後に、レベルを決め直す(点数と、ほかの条件も要る。保存されたレベルは下げない)
var SKILL_APPROVAL_REASON_MAX = 500
var SKILL_APPROVAL_MAX = 200

function canApproveSkillOf_(acting, memberId) {
  if (String(acting.id) === String(memberId)) return false
  if (isTopRoleRef_(getRoles_(), acting.role)) return true
  var data = { Members: snapshotTableOrSheet_(SHEET_MEMBERS), Projects: snapshotTableOrSheet_(SHEET_PROJECTS) }
  return !!supervisedMemberIds_(data, String(acting.id))[String(memberId)]
}

function approveSkillLevel_(acting, memberId, skill, level, reason) {
  memberId = String(memberId || '')
  skill = typeof skill === 'string' ? skill.trim() : ''
  reason = typeof reason === 'string' ? reason.trim() : ''
  if (!memberId) throw userError_('メンバーを指定してください。')
  if (memberId === String(acting.id)) throw userError_('自分自身のスキルのレベルは認められません。見る立場の人に依頼してください。')
  if (!skill || skill.length > 100) throw userError_('スキルの名前を100文字以内で入れてください。')
  if (typeof level !== 'number' || [1, 2, 3, 4, 5].indexOf(level) < 0) throw userError_('レベルは 1〜5 で指定してください。')
  if (!reason) throw userError_('認める理由を書いてください。')
  if (reason.length > SKILL_APPROVAL_REASON_MAX) throw userError_('理由は' + SKILL_APPROVAL_REASON_MAX + '文字以内にしてください。')
  if (!canApproveSkillOf_(acting, memberId)) throw userError_('スキルのレベルを認められるのは、代表と、その人を見る立場の人(上長・メンター・プロジェクトの責任者)だけです。')
  checkActiveMember_(memberId, '認める相手')
  // 列が無い古いシートには足す(初期設定を実行し直さなくても記録できるように)
  ensureSheetHeaders_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_MEMBERS, ['skill_approvals_json'])
  forgetSheetGrid_(SHEET_MEMBERS)
  var memberRow = findRow_(SHEET_MEMBERS, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません。')
  var record = { id: 'sa-' + Utilities.getUuid().slice(0, 8), skill: skill, level: level, reason: reason, byId: String(acting.id), at: new Date().toISOString() }
  var approvals = parseJsonListSafe_(memberRow.skill_approvals_json).concat([record]).slice(-SKILL_APPROVAL_MAX)
  var points = {}
  try { points = JSON.parse(memberRow.skill_points_json || '{}') || {} } catch (e) { points = {} }
  var evidence = skillEvidenceOf_(memberRow, memberId)
  evidence.approvals = approvals
  var newLevels = computeAutoLevels_(parseJsonListSafe_(memberRow.skill_levels_json), points, getSkillLevelRules_(), evidence)
  updateMemberFields_(memberId, { skill_approvals_json: JSON.stringify(approvals), skill_levels_json: JSON.stringify(newLevels) })
  return { approval: record, newLevels: newLevels }
}

// ---- 団体の保存(getOrgStorage・setOrgStorage) -----------------------------------
//
// 本人だけの保存(PersonalStore)と同じしくみで、団体に1つの値をキーごとに持つ(OrgStore シート)。
// キー(英小文字・数字・. _ -、64文字まで)ごとに、読める役職・書ける役職を Settings の org_storage_access に
// {キー: {read: 範囲, write: 範囲}} で決める(設定できるのは代表・全権管理者。updateSetting の権限)。範囲は次のどれか:
//   'all'        ログインしている全員
//   'adminRole'  一般以外の役職
//   'fullAdmin'  代表・全権管理者
//   'top'        代表だけ
//   [役職, ...]  一覧の役職(役職の ID・名前)と、代表・全権管理者
// 設定の無いキー・読めない設定は、代表・全権管理者だけが読み書きできる。
// 1つのキー ORG_STORE_MAX_CHARS_PER_KEY 文字・合わせて ORG_STORE_MAX_CHARS 文字・ORG_STORE_MAX_KEYS 個まで。
// 値は ORG_STORE_CHUNK 文字ずつの行に分ける。初期データ・スナップショットには入れない(読める人にだけ返す)
var SHEET_ORG_STORE = 'OrgStore'
var ORG_STORE_ACCESS_KEY = 'org_storage_access'
var ORG_STORE_CHUNK = 40000
var ORG_STORE_MAX_CHARS_PER_KEY = 100000
var ORG_STORE_MAX_CHARS = 1000000
var ORG_STORE_MAX_KEYS = 200
var ORG_STORE_LEVELS = ['all', 'adminRole', 'fullAdmin', 'top']

function validOrgStoreLevel_(level) {
  if (typeof level === 'string') return ORG_STORE_LEVELS.indexOf(level) >= 0
  if (!Array.isArray(level) || level.length === 0 || level.length > 50) return false
  return level.every(function (r) { return typeof r === 'string' && r.trim() !== '' && r.length <= 100 })
}

// updateSetting で保存する前に確かめる
function checkOrgStorageAccess_(value) {
  if (value === '' || value === null || value === undefined) return
  var parsed
  try { parsed = JSON.parse(String(value)) } catch (e) { throw userError_('団体の保存の権限の設定を読めませんでした。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw userError_('団体の保存の権限の設定の形が正しくありません。')
  var keys = Object.keys(parsed)
  if (keys.length > ORG_STORE_MAX_KEYS) throw userError_('団体の保存の権限は ' + ORG_STORE_MAX_KEYS + ' 個のキーまで設定できます。')
  keys.forEach(function (k) {
    if (!PERSONAL_STORE_KEY_RE.test(k)) throw userError_('団体の保存のキーが正しくありません: ' + String(k).slice(0, 70))
    var rule = parsed[k]
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw userError_('団体の保存の権限は {read, write} で設定してください。')
    Object.keys(rule).forEach(function (op) { if (op !== 'read' && op !== 'write') throw userError_('団体の保存の権限は read と write だけを設定できます。') })
    ;['read', 'write'].forEach(function (op) {
      if (rule[op] !== undefined && !validOrgStoreLevel_(rule[op])) throw userError_('団体の保存の権限の範囲が正しくありません: ' + k + ' の ' + op)
    })
  })
}

function orgStoreAccess_() {
  var parsed = {}
  try { parsed = JSON.parse(getSettingValue_(ORG_STORE_ACCESS_KEY) || '{}') || {} } catch (e) { parsed = {} }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function orgStoreAllowed_(acting, access, key, op) {
  var roles = getRoles_()
  if (isFullAdminRoleRef_(roles, acting.role)) return true
  var rule = Object.prototype.hasOwnProperty.call(access, key) ? access[key] : null
  var level = rule && typeof rule === 'object' ? rule[op] : undefined
  if (!validOrgStoreLevel_(level)) return false
  if (level === 'all') return true
  if (level === 'adminRole') return isAdminRoleRef_(roles, acting.role)
  if (level === 'fullAdmin' || level === 'top') return false
  return level.some(function (r) { return sameRole_(roles, r, acting.role) })
}

function orgStoreSheet_(create) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORG_STORE)
  if (!sheet && create) sheet = getOrCreateSheet_(SHEET_ORG_STORE, ORG_STORE_HEADERS)
  return sheet
}

// 全部の行(行番号・キー・何番目か・値)
function orgStoreRows_(sheet) {
  var last = sheet ? sheet.getLastRow() : 0
  if (last < 2) return []
  var headers = headerRow_(sheet)
  var col = function (h) { return headers.indexOf(h) }
  return sheet.getRange(2, 1, last - 1, headers.length).getValues().map(function (r, i) {
    return { row: i + 2, key: String(r[col('id')]), part: Number(r[col('part')]) || 0, value: String(r[col('value')] == null ? '' : r[col('value')]) }
  })
}

function getOrgStorage_(acting, keys) {
  var access = orgStoreAccess_()
  var values = personalStoreValues_(orgStoreRows_(orgStoreSheet_(false)))
  var out = {}
  Object.keys(values).forEach(function (k) {
    if (Array.isArray(keys) && keys.map(String).indexOf(k) < 0) return
    if (orgStoreAllowed_(acting, access, k, 'read')) out[k] = values[k]
  })
  return { values: out }
}

// value: 文字列(画面が JSON にして送る)。null・空の文字列はキーを消す
function setOrgStorage_(acting, key, value) {
  key = String(key || '')
  if (!PERSONAL_STORE_KEY_RE.test(key)) throw userError_('保存のキーが正しくありません。')
  if (value !== null && value !== undefined && typeof value !== 'string') throw userError_('保存する値は文字列にしてください。')
  if (!orgStoreAllowed_(acting, orgStoreAccess_(), key, 'write')) throw userError_('この保存のキーを書き換える権限がありません。')
  var text = value == null ? '' : value
  if (text.length > ORG_STORE_MAX_CHARS_PER_KEY) throw userError_('1つのキーに保存できるのは ' + ORG_STORE_MAX_CHARS_PER_KEY + ' 文字までです。')
  var sheet = orgStoreSheet_(true)
  var rows = orgStoreRows_(sheet)
  var current = personalStoreValues_(rows)
  var others = Object.keys(current).filter(function (k) { return k !== key })
  if (text) {
    if (others.length + 1 > ORG_STORE_MAX_KEYS) throw userError_('団体の保存のキーは ' + ORG_STORE_MAX_KEYS + ' 個までです。')
    var total = text.length + others.reduce(function (n, k) { return n + current[k].length }, 0)
    if (total > ORG_STORE_MAX_CHARS) throw userError_('団体の保存の大きさ(合わせて ' + ORG_STORE_MAX_CHARS + ' 文字)を超えています。')
  }
  var chunks = []
  for (var i = 0; i < text.length; i += ORG_STORE_CHUNK) chunks.push(text.slice(i, i + ORG_STORE_CHUNK))
  var mine = rows.filter(function (r) { return r.key === key }).sort(function (a, b) { return a.part - b.part })
  var headers = headerRow_(sheet)
  var now = new Date().toISOString()
  chunks.forEach(function (chunk, part) {
    var o = { id: key, part: part, value: chunk, updated_at: now, updated_by: String(acting.id) }
    var target = mine[part] ? mine[part].row : sheet.getLastRow() + 1
    // 数式として扱われないよう、書式なしテキストにしてから書く
    sheet.getRange(target, 1, 1, headers.length).setNumberFormat('@')
    sheet.getRange(target, 1, 1, headers.length).setValues([headers.map(function (h) { return Object.prototype.hasOwnProperty.call(o, h) ? o[h] : '' })])
  })
  mine.slice(chunks.length).map(function (r) { return r.row }).sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  return { key: key, size: text.length }
}

// ---- 古いタスクを移す(TasksArchive) -------------------------------------------
//
// 完了してから決めた日数(レジストリから配る taskArchiveDays。既定は365日)がたったタスクを、毎日の処理で
// TasksArchive シートに移す(Tasks から行を消し、同じ列 + archived_at で TasksArchive に足す)。
//   ・ふだんの読み込み(初期データ・スナップショット)には入れない(Tasks だけを読む)
//   ・検索(searchArchivedTasks。見てよいタスクだけ)・スキルの条件の「完了したタスクの数」・バックアップから戻す、に使う
//   ・戻す(unarchiveTasks。代表・全権管理者)で Tasks に戻す
// 移さないもの: ゴミ箱のタスク・完了の日が分からないタスク・まだ Tasks にあるタスクから前提タスク・確認タスクとして
// 参照されているタスク(画面で前提タスクが見えなくならないように)。1回に TASK_ARCHIVE_MAX_PER_RUN 件まで。
// 先に TasksArchive に足してから Tasks の行を消す(途中で止まっても、次の回に同じ ID を足し直さずに消すだけにする)
var SHEET_TASKS_ARCHIVE = 'TasksArchive'
var TASK_ARCHIVE_MAX_PER_RUN = 500
var ARCHIVE_SEARCH_MAX = 200
var UNARCHIVE_MAX = 100

function tasksArchiveSheet_(create) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS_ARCHIVE)
  if (!sheet && create) sheet = getOrCreateSheet_(SHEET_TASKS_ARCHIVE, TASKS_ARCHIVE_HEADERS)
  if (sheet && create) ensureSheetHeaders_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_TASKS_ARCHIVE, TASKS_ARCHIVE_HEADERS)
  return sheet
}

function archivedTaskRows_() {
  return sheetRowsAsObjects_(SHEET_TASKS_ARCHIVE)
}

// 移したタスクの ID の最大値(新しいタスクに同じ ID を使わないように。nextIntId_ が Tasks の時だけ数える)。
// 読むだけ(シートを作らない)
function archivedMaxIdFor_(sheet) {
  if (!sheet || !sheet.getName || sheet.getName() !== SHEET_TASKS) return 0
  var archive = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS_ARCHIVE)
  if (!archive || archive.getLastRow() < 2) return 0
  var headers = headerRow_(archive)
  var idCol = headers.indexOf('id')
  if (idCol < 0) return 0
  var max = 0
  archive.getRange(2, idCol + 1, archive.getLastRow() - 1, 1).getValues().forEach(function (r) {
    var n = parseInt(r[0], 10)
    if (!isNaN(n) && n > max) max = n
  })
  return max
}

// 移した完了のタスクのうち、その人が担当したもののスキル(1タスクにつき、スキルごとに1つ)
function archivedDoneTaskSkills_(memberId) {
  var out = []
  archivedTaskRows_().forEach(function (t) {
    if (normalizeCode_('status', t.status) !== 'done') return
    if (splitCsvList_(t.assignee_id).indexOf(String(memberId)) < 0) return
    splitCsvList_(t.skills).forEach(function (s) { out.push(s) })
  })
  return out
}

function archivedTaskCountOfProject_(projectId) {
  return archivedTaskRows_().filter(function (t) { return String(t.project_id || '') === String(projectId) }).length
}

function taskDoneAtMs_(t) {
  var at = cellTimeMs_(t.completed_date)
  if (!isFinite(at)) at = cellTimeMs_(t.last_activity)
  return at
}

// 移すタスク(Tasks の行のオブジェクトの一覧から選ぶ)
function tasksToArchive_(rows, nowMs, days) {
  var limit = nowMs - days * 24 * 3600 * 1000
  var referenced = {}
  var candidates = rows.filter(function (t) {
    return normalizeCode_('status', t.status) === 'done' && !isTrashedTask_(t) && isFinite(taskDoneAtMs_(t)) && taskDoneAtMs_(t) <= limit
  })
  var moving = {}
  candidates.forEach(function (t) { moving[String(t.id)] = true })
  rows.forEach(function (t) {
    if (moving[String(t.id)]) return
    splitCsvList_(t.depends_on_ids).forEach(function (id) { referenced[id] = true })
    if (String(t.related_review_task_id || '')) referenced[String(t.related_review_task_id)] = true
  })
  return candidates.filter(function (t) { return !referenced[String(t.id)] }).slice(0, TASK_ARCHIVE_MAX_PER_RUN)
}

// 行を Tasks から TasksArchive へ移す(ロックを取った中で呼ぶ)。移した ID を返す
function moveTasksToArchive_(tasks, nowMs) {
  if (!tasks.length) return []
  var archive = tasksArchiveSheet_(true)
  var aHeaders = headerRow_(archive)
  var already = {}
  archivedTaskRows_().forEach(function (t) { already[String(t.id)] = true })
  var at = new Date(nowMs).toISOString()
  tasks.forEach(function (t) {
    if (already[String(t.id)]) return
    var row = aHeaders.map(function (h) { return h === 'archived_at' ? at : (t[h] === undefined ? '' : t[h]) })
    var rowNumber = archive.getLastRow() + 1
    protectRowFromFormulaInjection_(archive, aHeaders, rowNumber, SHEET_TASKS)
    archive.getRange(rowNumber, 1, 1, aHeaders.length).setValues([row])
  })
  deleteRowsById_(getSheet_(SHEET_TASKS), tasks.map(function (t) { return String(t.id) }))
  forgetSheetGrid_(SHEET_TASKS)
  return tasks.map(function (t) { return String(t.id) })
}

// シートから、ID が一覧にある行を消す(下から消す)
function deleteRowsById_(sheet, ids) {
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  if (idCol < 0 || sheet.getLastRow() < 2) return 0
  var want = {}
  ids.forEach(function (id) { want[String(id)] = true })
  var values = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues()
  var rows = []
  values.forEach(function (r, i) { if (want[String(r[0])]) rows.push(i + 2) })
  rows.sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  return rows.length
}

// 毎日の処理から呼ぶ
function archiveOldTasksLocked_(nowMs) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    var moved = moveTasksToArchive_(tasksToArchive_(sheetRowsAsObjects_(SHEET_TASKS), nowMs, tunable_('taskArchiveDays')), nowMs)
    if (moved.length) bumpSnapshotVersion_()
    return moved
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

// 移したタスクを探す(名前の一部・担当者)。見てよいタスクだけを、新しく移した順に ARCHIVE_SEARCH_MAX 件まで返す。
// 列は READ_POLICY の Tasks と同じ(規則の無い列は返さない)に、移した日時(archivedAt)を足す
function searchArchivedTasks_(acting, query, memberId) {
  var q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  var who = typeof memberId === 'string' ? memberId.trim() : ''
  if (q.length > 200) throw userError_('探す文字は200文字までにしてください。')
  var sheet = tasksArchiveSheet_(false)
  if (!sheet || sheet.getLastRow() < 2) return { headers: [], rows: [], archivedAt: {}, total: 0 }
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var col = function (h) { return headers.indexOf(h) }
  var matched = values.slice(1).filter(function (r) {
    if (!String(r[col('id')] || '')) return false
    if (q && String(r[col('title')] || '').toLowerCase().indexOf(q) < 0) return false
    if (who && splitCsvList_(r[col('assignee_id')]).indexOf(who) < 0) return false
    return true
  })
  var viewer = makeViewer_({ id: acting.id, role: acting.role }, getRoles_())
  var filtered = filterTableForViewer_('Tasks', { headers: headers, rows: matched }, viewer)
  var archivedAt = {}
  var visibleIds = {}
  var idOut = filtered.headers.indexOf('id')
  filtered.rows.forEach(function (r) { visibleIds[String(r[idOut])] = true })
  matched.forEach(function (r) {
    var id = String(r[col('id')])
    if (visibleIds[id]) archivedAt[id] = col('archived_at') >= 0 ? String(r[col('archived_at')] || '') : ''
  })
  var rows = filtered.rows.slice().sort(function (a, b) {
    var x = archivedAt[String(a[idOut])], y = archivedAt[String(b[idOut])]
    return x < y ? 1 : x > y ? -1 : 0
  })
  return { headers: filtered.headers, rows: rows.slice(0, ARCHIVE_SEARCH_MAX), archivedAt: archivedAt, total: rows.length }
}

// 移したタスクを Tasks に戻す(代表・全権管理者。ロックを取った書き込みの中で呼ぶ)
function unarchiveTasks_(taskIds) {
  var ids = []
  ;(Array.isArray(taskIds) ? taskIds : []).forEach(function (id) {
    var s = String(id || '')
    if (s && ids.indexOf(s) < 0) ids.push(s)
  })
  if (!ids.length) throw userError_('戻すタスクを選んでください。')
  if (ids.length > UNARCHIVE_MAX) throw userError_('一度に戻せるタスクは ' + UNARCHIVE_MAX + ' 件までです。')
  var byId = {}
  archivedTaskRows_().forEach(function (t) { byId[String(t.id)] = t })
  var missing = ids.filter(function (id) { return !byId[id] })
  if (missing.length) throw userError_('移したタスクに見つかりません: ' + missing.slice(0, 5).join(', '))
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var live = {}
  sheetRowsAsObjects_(SHEET_TASKS).forEach(function (t) { live[String(t.id)] = true })
  ids.forEach(function (id) {
    if (live[id]) return
    var t = byId[id]
    var row = headers.map(function (h) { return t[h] === undefined ? '' : t[h] })
    // 記録を1件1行で持っている時: 移行の前に移したタスクは、セルの一覧を記録のシートに書く(39-record-rows.gs)。
    // 移行の後に移したタスクの記録は、記録のシートに残っている(セルは空)
    var recordFields = {}
    if (recordRowsOn_()) {
      headers.forEach(function (h, c) {
        if (!isRecordColumn_(SHEET_TASKS, h)) return
        var raw = String(row[c] || '')
        if (raw && raw !== '[]') recordFields[h] = raw
        row[c] = ''
      })
    }
    var rowNumber = sheet.getLastRow() + 1
    protectRowFromFormulaInjection_(sheet, headers, rowNumber, SHEET_TASKS)
    sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row])
    if (Object.keys(recordFields).length) splitRecordFields_(SHEET_TASKS, id, recordFields)
  })
  deleteRowsById_(tasksArchiveSheet_(false), ids)
  forgetSheetGrid_(SHEET_TASKS)
  return { restored: ids }
}

// ---- 残りの値の確かめ(形と大きさ) ---------------------------------------------
//
// 画面が送る値のうち、まだ確かめていなかったものを、保存する前に確かめる(おかしな値は保存せずに断る)。
// 画面が今送る値はすべて通す(画面の選択肢・入力の上限と同じか、それより広くしてある)。
//   ・本人の設定: 通知の設定・タイムゾーン・表示言語・アイコンの色と文字・学歴・カスタム列
//   ・プロジェクトの健康状態(手動の上書き・自動判定の記録)
//   ・採用の候補者の項目
//   ・updateSetting の値: フォームの定義と承認の段・検定・定期タスクの規則・項目ごとの閲覧範囲・団体の保存の権限・
//     スキルのレベルの決め方・稼働の目安の決め方
var NOTIFY_KINDS = ['new_task', 'review', 'mention', 'rejected', 'deadline']
var NOTIFY_FREQUENCIES = ['immediate', '3h', '6h', '1d', 'none']
var TIMEZONE_RE = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+\-]+){1,2})$/
var LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/
var AVATAR_COLOR_RE = /^#[0-9a-fA-F]{6}$/
var CUSTOM_FIELDS_MAX_KEYS = 100
var CUSTOM_FIELD_VALUE_MAX = 2000
var CANDIDATE_STATUSES = ['candidate', 'hired', 'rejected']
var CANDIDATE_TEXT_MAX = 50000

function isPlainObject_(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function checkText_(v, max, label, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw userError_(label + 'を入れてください。')
    return ''
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw userError_(label + 'の形が正しくありません。')
  var s = String(v)
  if (s.length > max) throw userError_(label + 'は' + max + '文字以内にしてください。')
  if (required && !s.trim()) throw userError_(label + 'を入れてください。')
  return s
}

// ベルの通知(画面の中のお知らせ)の種類(lib/ohsumi/bell-kinds.ts の BELL_KINDS と同じ)。値は true / false
var BELL_KINDS = ['approval', 'review', 'staleReview', 'staleProgress', 'deadline', 'mention', 'lowWorkload', 'inactive', 'expense', 'invite']

function checkNotifySettings_(settings) {
  if (!isPlainObject_(settings)) throw userError_('通知の設定の形が正しくありません。')
  Object.keys(settings).forEach(function (k) {
    if (k === 'bell') {
      var bell = settings.bell
      if (!isPlainObject_(bell)) throw userError_('ベルの通知の設定の形が正しくありません。')
      Object.keys(bell).forEach(function (b) {
        if (BELL_KINDS.indexOf(b) < 0) throw userError_('ベルの通知の種類が正しくありません。')
        if (typeof bell[b] !== 'boolean') throw userError_('ベルの通知のオン・オフの形が正しくありません。')
      })
      return
    }
    if (NOTIFY_KINDS.indexOf(k) < 0) throw userError_('通知の種類が正しくありません。')
    if (NOTIFY_FREQUENCIES.indexOf(settings[k]) < 0) throw userError_('通知の頻度が正しくありません。')
  })
  return settings
}

function checkTimezone_(tz) {
  if (tz === undefined || tz === null || tz === '') return ''
  if (typeof tz !== 'string' || tz.length > 64 || !TIMEZONE_RE.test(tz)) throw userError_('タイムゾーンの形が正しくありません。')
  return tz
}

function checkLocale_(locale) {
  if (locale === undefined || locale === null || locale === '') return ''
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) throw userError_('表示言語の形が正しくありません。')
  return locale
}

function checkAvatar_(color, initials) {
  if (color !== undefined && color !== null && color !== '' && (typeof color !== 'string' || !AVATAR_COLOR_RE.test(color))) {
    throw userError_('アイコンの色の形が正しくありません。')
  }
  checkText_(initials, 4, 'アイコンの文字')
}

function checkEducationInfo_(body) {
  checkText_(body.university, 200, '大学名')
  checkText_(body.faculty, 200, '学部')
  checkText_(body.departmentName, 200, '学科')
  checkText_(body.gradeYear, 50, '学年')
}

function checkCustomFields_(fields) {
  if (fields === undefined || fields === null) return {}
  if (!isPlainObject_(fields)) throw userError_('カスタム列の値の形が正しくありません。')
  var keys = Object.keys(fields)
  if (keys.length > CUSTOM_FIELDS_MAX_KEYS) throw userError_('カスタム列は ' + CUSTOM_FIELDS_MAX_KEYS + ' 個までです。')
  keys.forEach(function (k) {
    if (!k || k.length > 100) throw userError_('カスタム列のキーが正しくありません。')
    var v = fields[k]
    if (v === null || v === undefined) return
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw userError_('カスタム列の値の形が正しくありません。')
    if (String(v).length > CUSTOM_FIELD_VALUE_MAX) throw userError_('カスタム列の値は ' + CUSTOM_FIELD_VALUE_MAX + ' 文字以内にしてください。')
  })
  return fields
}

// 健康状態: good / watch / attention。allowEmpty の時は空(手動の上書きを外す)も通す
function checkProjectHealth_(health, allowEmpty) {
  if ((health === '' || health === null || health === undefined) && allowEmpty) return ''
  if (PROJECT_HEALTH_LEVELS.indexOf(health) < 0) throw userError_('健康状態は good・watch・attention のどれかにしてください。')
  return health
}

function checkCandidateFields_(c, isNew) {
  if (!isPlainObject_(c)) throw userError_('候補者の項目の形が正しくありません。')
  if (isNew || c.name !== undefined) checkText_(c.name, 200, '候補者の名前', true)
  if (c.email !== undefined && c.email !== '' && c.email !== null) {
    if (typeof c.email !== 'string' || c.email.length > 254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(c.email.trim())) throw userError_('候補者のメールアドレスの形が正しくありません。')
  }
  if (c.phone !== undefined && c.phone !== '' && c.phone !== null) {
    if (typeof c.phone !== 'string' || c.phone.length > 50 || /[\r\n]/.test(c.phone)) throw userError_('候補者の電話番号は1行・50文字以内にしてください。')
  }
  checkText_(c.resumeText, CANDIDATE_TEXT_MAX, '経歴')
  checkText_(c.interviewNotes, CANDIDATE_TEXT_MAX, '面接のメモ')
  if (c.status !== undefined && CANDIDATE_STATUSES.indexOf(c.status) < 0) throw userError_('候補者の状態が正しくありません。')
}

// ---- updateSetting の値 ----

function parseSettingJson_(value, label) {
  if (typeof value !== 'string') throw userError_(label + 'の形が正しくありません。')
  try { return JSON.parse(value) } catch (e) { throw userError_(label + 'を読めませんでした。') }
}

function checkList_(v, max, label) {
  if (!Array.isArray(v)) throw userError_(label + 'の形が正しくありません。')
  if (v.length > max) throw userError_(label + 'は ' + max + ' 件までです。')
  return v
}

function checkApprovalSteps_(steps, label) {
  checkList_(steps, 20, label)
  steps.forEach(function (s) {
    if (!isPlainObject_(s)) throw userError_(label + 'の形が正しくありません。')
    checkText_(s.id, 100, label + 'の ID', true)
    if (s.type !== 'member' && s.type !== 'role') throw userError_(label + 'の種類は member か role にしてください。')
    if (s.type === 'member') checkText_(s.memberId, 100, label + 'のメンバー', true)
    if (s.type === 'role') checkText_(s.role, 100, label + 'の役職', true)
    checkText_(s.department, 200, label + 'の部署')
    if (s.requiredCount !== undefined && s.requiredCount !== null && s.requiredCount !== 'all' && s.requiredCount !== 'any') {
      if (typeof s.requiredCount !== 'number' || Math.floor(s.requiredCount) !== s.requiredCount || s.requiredCount < 1 || s.requiredCount > 100) {
        throw userError_(label + 'の必要な人数が正しくありません。')
      }
    }
  })
}

function checkCustomFormDefs_(value) {
  var defs = checkList_(parseSettingJson_(value, 'フォームの定義'), 100, 'フォームの定義')
  defs.forEach(function (d) {
    if (!isPlainObject_(d)) throw userError_('フォームの定義の形が正しくありません。')
    checkText_(d.id, 100, 'フォームの ID', true)
    checkText_(d.title, 200, 'フォームの名前')
    checkText_(d.description, 5000, 'フォームの説明')
    checkList_(d.fields || [], 100, 'フォームの項目').forEach(function (f) {
      if (!isPlainObject_(f)) throw userError_('フォームの項目の形が正しくありません。')
      checkText_(f.id, 100, '項目の ID', true)
      checkText_(f.label, 500, '項目の名前')
      if (['text', 'number', 'select', 'date'].indexOf(f.type) < 0) throw userError_('項目の種類が正しくありません。')
      if (f.options !== undefined) checkList_(f.options, 100, '項目の選択肢').forEach(function (o) { checkText_(o, 200, '選択肢') })
      if (f.required !== undefined && typeof f.required !== 'boolean') throw userError_('項目の「必須」の形が正しくありません。')
      checkText_(f.description, 2000, '項目の説明')
    })
    checkApprovalSteps_(d.approvalSteps || [], 'フォームの承認の段')
  })
}

function checkQuizDefinitions_(value) {
  var quizzes = checkList_(parseSettingJson_(value, '検定の定義'), 200, '検定の定義')
  quizzes.forEach(function (q) {
    if (!isPlainObject_(q)) throw userError_('検定の定義の形が正しくありません。')
    checkText_(q.id, 100, '検定の ID', true)
    checkText_(q.title, 200, '検定の名前')
    checkText_(q.targetSkill, 100, '検定のスキル')
    if (q.targetLevel !== undefined && [1, 2, 3, 4, 5].indexOf(q.targetLevel) < 0) throw userError_('検定の目標のレベルは 1〜5 にしてください。')
    if (q.passRate !== undefined && (typeof q.passRate !== 'number' || !(q.passRate >= 0 && q.passRate <= 100))) throw userError_('検定の合格ラインは 0〜100 にしてください。')
    checkList_(q.questions || [], 200, '検定の設問').forEach(function (question) {
      if (!isPlainObject_(question)) throw userError_('検定の設問の形が正しくありません。')
      checkText_(question.id, 100, '設問の ID')
      checkText_(question.text, 5000, '設問の文')
      var choices = checkList_(question.choices || [], 20, '設問の選択肢')
      choices.forEach(function (c) { checkText_(c, 1000, '選択肢') })
      if (question.correctIndex !== undefined) {
        var ci = question.correctIndex
        if (typeof ci !== 'number' || Math.floor(ci) !== ci || ci < 0 || ci >= Math.max(choices.length, 1)) throw userError_('設問の正解の番号が正しくありません。')
      }
    })
  })
}

function checkRecurringRules_(value) {
  var rules = checkList_(parseSettingJson_(value, '定期タスクの規則'), 200, '定期タスクの規則')
  rules.forEach(function (r) {
    if (!isPlainObject_(r)) throw userError_('定期タスクの規則の形が正しくありません。')
    checkText_(r.id, 100, '規則の ID', true)
    checkText_(r.name, 200, '定期タスクの名前')
    checkText_(r.projectId, 100, '定期タスクのプロジェクト')
    ;['department', 'category', 'difficulty', 'priority', 'triggerOnStatus'].forEach(function (k) { checkText_(r[k], 100, '定期タスクの項目') })
    if (r.skills !== undefined) checkList_(r.skills, 50, '定期タスクのスキル').forEach(function (s) { checkText_(s, 100, 'スキル') })
    if (r.frequency !== undefined && ['weekly', 'monthly'].indexOf(r.frequency) < 0) throw userError_('定期タスクの頻度は weekly か monthly にしてください。')
    var intIn = function (v, lo, hi, label) {
      if (v === undefined || v === null || v === '') return
      if (typeof v !== 'number' || Math.floor(v) !== v || v < lo || v > hi) throw userError_(label + 'が正しくありません。')
    }
    intIn(r.dayOfWeek, 0, 6, '曜日')
    intIn(r.dayOfMonth, 1, 31, '日にち')
    intIn(r.dueInDays, 0, 3650, '期限までの日数')
    if (r.active !== undefined && typeof r.active !== 'boolean') throw userError_('定期タスクの「有効」の形が正しくありません。')
    if (r.lastGeneratedDate !== undefined && r.lastGeneratedDate !== '') checkDate_(r.lastGeneratedDate, '最後に作った日')
    if (r.skipDates !== undefined) checkList_(r.skipDates, 366, '作らない日').forEach(function (d) { checkDate_(d, '作らない日') })
  })
}

// スキルのレベルの決め方: 形が正しいか(壊れた部分を捨てる parseSkillLevelRules_ より厳しく、知らない条件は断る)
function checkSkillLevelRules_(value) {
  var obj = parseSettingJson_(value, 'スキルのレベルの決め方')
  if (!isPlainObject_(obj)) throw userError_('スキルのレベルの決め方の形が正しくありません。')
  var rule = function (r) {
    if (!isPlainObject_(r)) throw userError_('スキルのレベルの決め方の形が正しくありません。')
    if (r.points !== undefined && !validLevelPoints_(r.points)) throw userError_('レベルの点数は、増えていく5つの整数にしてください。')
    if (r.conditions !== undefined) {
      if (!isPlainObject_(r.conditions)) throw userError_('レベルの条件の形が正しくありません。')
      Object.keys(r.conditions).forEach(function (l) {
        if (['1', '2', '3', '4', '5'].indexOf(l) < 0) throw userError_('レベルは 1〜5 にしてください。')
        checkList_(r.conditions[l], 10, 'レベルの条件').forEach(function (c) {
          if (!validLevelCondition_(c)) throw userError_('レベルの条件が正しくありません。')
        })
      })
    }
  }
  if (obj['default'] !== undefined) rule(obj['default'])
  if (obj.skills !== undefined) {
    if (!isPlainObject_(obj.skills)) throw userError_('スキルごとの決め方の形が正しくありません。')
    var names = Object.keys(obj.skills)
    if (names.length > 500) throw userError_('スキルごとの決め方は 500 件までです。')
    names.forEach(function (n) { rule(obj.skills[n]) })
  }
}

// 稼働の目安の決め方(lib/ohsumi/workload-rules.ts の WORKLOAD_RULE_RANGES と同じ範囲)。
// 書いていない項目は既定のまま。知らない項目・範囲の外・full_ratio が available_ratio 以下は断る
var WORKLOAD_RULE_RANGES = {
  available_ratio: { min: 0.05, max: 5, label: '「余力あり」の上限' },
  full_ratio: { min: 0.1, max: 10, label: '「余力なし」の下限' },
  window_days: { min: 14, max: 365, integer: true, label: '普段のペースを数える期間' },
  fallback_hours: { min: 0.5, max: 40, label: '想定時間が空のタスクの時間' },
  no_history_normal_max_hours: { min: 0, max: 200, label: '完了したタスクが無い人の「普通」の上限' },
  low_workload_task_threshold: { min: 0, max: 10, integer: true, label: '低稼働を知らせるタスクの件数' },
}
var WORKLOAD_RULE_DEFAULTS = { available_ratio: 0.6, full_ratio: 1.2 }

function checkWorkloadRules_(value) {
  var obj = parseSettingJson_(value, '稼働の目安の決め方')
  if (!isPlainObject_(obj)) throw userError_('稼働の目安の決め方の形が正しくありません。')
  Object.keys(obj).forEach(function (k) {
    if (k === 'count_hold_and_review') {
      if (typeof obj[k] !== 'boolean') throw userError_('「保留・確認待ちを含める」の形が正しくありません。')
      return
    }
    var r = WORKLOAD_RULE_RANGES[k]
    if (!r) throw userError_('稼働の目安の決め方に、知らない項目があります。')
    var v = obj[k]
    if (typeof v !== 'number' || !isFinite(v) || (r.integer && Math.floor(v) !== v) || v < r.min || v > r.max) {
      throw userError_(r.label + 'は ' + r.min + '〜' + r.max + (r.integer ? ' の整数' : '') + ' にしてください。')
    }
  })
  var available = obj.available_ratio !== undefined ? obj.available_ratio : WORKLOAD_RULE_DEFAULTS.available_ratio
  var full = obj.full_ratio !== undefined ? obj.full_ratio : WORKLOAD_RULE_DEFAULTS.full_ratio
  if (!(full > available)) throw userError_('「余力なし」の下限は、「余力あり」の上限より大きくしてください。')
}

// updateSetting の値を、キーごとに確かめる(空の値は「設定を消す」なので通す)
var SETTING_VALUE_CHECKS = {
  custom_form_defs: checkCustomFormDefs_,
  quiz_definitions: checkQuizDefinitions_,
  recurring_rules: checkRecurringRules_,
  skill_level_rules: checkSkillLevelRules_,
  workload_rules: checkWorkloadRules_,
  member_field_visibility: checkMemberFieldVisibility_,
  org_storage_access: checkOrgStorageAccess_,
}

function checkSettingValue_(key, value) {
  var check = SETTING_VALUE_CHECKS[key]
  if (!check || value === '' || value === null || value === undefined) return
  check(value)
}
// ---- できる操作(capability) ------------------------------------------------------
//
// 「代表だけ」「全権管理者だけ」だった操作を、まとまり(capability)ごとに役職へ渡せるようにする。
// 役職の設定(Settings の roles)の各役職に capabilities: [キー] を持つ。持たない役職は既定:
//   最上位: すべて(設定に関係なく、いつもすべて)
//   管理者で制限なし(全権管理者): org.rules・trash(今までの全権管理者と同じ)
//   管理者で制限あり・一般: なし
// 一般の役職には渡せない(設定に書いてあっても使わない)。
// 画面はこの一覧(memberCapabilities_)だけを見て、ボタン・入力欄を出す。
// lib/ohsumi/capabilities.ts と同じ内容(一致することを lib/ohsumi/capabilities.test.ts で確かめる)。
//
// どの設定でも渡さないもの(最上位だけ): バックアップ・個人情報の削除・利用の状況・集計値・診断情報、
// 役職の種類・できる操作の設定そのもの、人ごとの権限の例外の編集(TOP_ONLY_ACTIONS と authorizeAction_ の前半)。

var CAPABILITY_ACTIONS = {
  'members.add': ['addMember'],
  'members.role': ['updateRole'],
  'members.remove': ['removeMember'],
  'members.hr': ['updateReportsTo', 'updateMentor', 'updateJoinedAt', 'updateEmail', 'updateMemberProjects'],
  'members.training': ['notifyTrainingDecision'],
  'recruiting': ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember'],
  'projects.remove': ['removeProject'],
  'trash': ['restoreTask', 'purgeTask'],
  'org.rules': ['updateSetting', 'updateRoles', 'deleteRole', 'updateDepartments', 'deleteDepartment', 'moveDepartmentTasks',
    'unarchiveTasks', 'updateDiscordWebhookUrl', 'updateSlackWebhookUrl', 'testDiscordWebhook', 'testSlackWebhook',
    'getWebhookStatus', 'getMailQuotaStatus', 'getGasUpdateStatus', 'updateProjectHealth', 'revokeMemberSessions'],
  'org.logo': ['uploadOrgLogo'],
}
// まとまりの順(画面のチェックの並び)
var CAPABILITY_KEYS = ['members.add', 'members.role', 'members.remove', 'members.hr', 'members.training', 'recruiting',
  'projects.remove', 'trash', 'org.rules', 'org.logo']
// 制限なしの管理者の既定
var FULL_ADMIN_DEFAULT_CAPABILITIES = ['org.rules', 'trash']
// 最上位だけの操作(どの設定でも渡さない)。人ごとの権限の例外の編集
var TOP_ONLY_ACTIONS = ['updatePermissionOverrides']

var CAPABILITY_BY_ACTION = (function () {
  var map = {}
  Object.keys(CAPABILITY_ACTIONS).forEach(function (key) {
    CAPABILITY_ACTIONS[key].forEach(function (action) { map[action] = key })
  })
  return map
})()

var CAPABILITY_LABELS = {
  'members.add': 'メンバーの登録・招待',
  'members.role': 'メンバーの役職の変更',
  'members.remove': 'メンバーの退会',
  'members.hr': '報告先・メンター・所属開始日・メールアドレス・担当プロジェクトの変更',
  'members.training': '研修の承認',
  'recruiting': '採用',
  'projects.remove': 'プロジェクトの削除',
  'trash': 'タスクのゴミ箱',
  'org.rules': '団体のルールの変更',
  'org.logo': '団体のロゴの変更',
}

// 知っているキーだけを、決まった順で(重複なし)
function normalizeCapabilities_(list) {
  var seen = {}
  ;(Array.isArray(list) ? list : []).forEach(function (k) { if (CAPABILITY_ACTIONS[String(k)]) seen[String(k)] = true })
  return CAPABILITY_KEYS.filter(function (k) { return seen[k] })
}

// 役職のできる操作(人ごとの例外は含まない)。一覧に無い役職は、今までと同じく制限なしの管理者として扱う
function roleCapabilities_(roles, ref) {
  var tier = roleTier_(roles, ref)
  if (tier === 'top') return CAPABILITY_KEYS.slice()
  if (tier === 'base') return []
  var role = findRole_(roles, ref)
  if (role && Array.isArray(role.capabilities)) return normalizeCapabilities_(role.capabilities)
  return role && role.restricted ? [] : normalizeCapabilities_(FULL_ADMIN_DEFAULT_CAPABILITIES)
}

function roleHasCapability_(roles, ref, key) {
  return roleCapabilities_(roles, ref).indexOf(key) >= 0
}

// ログインした人のできる操作(画面に渡す)。役職の分と、人ごとの権限の例外の分(採用の例外は
// 「編集」以上で recruiting)を合わせる。overrides は permission_overrides の配列
function memberCapabilities_(roles, roleRef, overrides) {
  var caps = roleCapabilities_(roles, roleRef)
  var list = Array.isArray(overrides) ? overrides : []
  var recruitingOverride = list.some(function (ov) {
    return ov && ov.targetType === 'recruiting' && (OVERRIDE_ACCESS_LEVELS[ov.access] || 0) >= OVERRIDE_ACCESS_LEVELS.edit
  })
  if (recruitingOverride && caps.indexOf('recruiting') < 0) caps = normalizeCapabilities_(caps.concat(['recruiting']))
  return caps
}

// スナップショットから、そのメンバーのできる操作
function memberCapabilitiesFromSnapshot_(data, memberId) {
  var row = findMemberInSnapshot_(data, memberId)
  if (!row) return []
  var overrides = []
  try { overrides = JSON.parse(String(row.permission_overrides_json || '[]')) } catch (e) { overrides = [] }
  return memberCapabilities_(rolesFromSnapshot_(data), row.role, overrides)
}

function capabilityDeniedMessage_(key) {
  return 'この操作(' + (CAPABILITY_LABELS[key] || key) + ')をする権限がありません。代表に、役職の「できる操作」で許可してもらってください。'
}

function containsAll_(have, need) {
  return need.every(function (k) { return have.indexOf(k) >= 0 })
}

// ---- 昇権の防止 -----------------------------------------------------------------
//
// 最上位でない人が役職を付ける時(updateRole・役職を付けた addMember・convertCandidateToMember)の決まり。
// 最上位の人はこの確認を通らない(authorizeAction_ の始めで許可する)。
//   - 最上位の役職は付けられない
//   - 自分の持っていない操作を持つ役職、自分より範囲の広い役職(制限なし)は付けられない
//   - targetId があれば: 自分の役職は変えられない/最上位の人の役職は変えられない/
//     自分の持っていない操作を持つ人(制限なしの人を含む)の役職は変えられない
function assertRoleAssignable_(acting, roleRef, targetId) {
  var roles = getRoles_()
  var actorCaps = roleCapabilities_(roles, acting.role)
  var actorFull = isFullAdminRoleRef_(roles, acting.role)
  if (targetId !== undefined && targetId !== null) {
    var tid = String(targetId)
    if (tid === String(acting.id)) throw userError_('自分の役職は変えられません。ほかの人に頼んでください。')
    var target = null
    try { target = authFindRow_(SHEET_MEMBERS, tid) } catch (e) { target = null }
    if (!target) throw userError_('メンバーが見つかりません。')
    if (isTopRoleRef_(roles, target.role)) throw userError_('最上位の役職の人の役職は、最上位の役職の人だけが変えられます。')
    if (!containsAll_(actorCaps, roleCapabilities_(roles, target.role)) || (!actorFull && isFullAdminRoleRef_(roles, target.role))) {
      throw userError_('自分が持っていない操作ができる人の役職は変えられません。')
    }
  }
  var ref = String(roleRef === null || roleRef === undefined ? '' : roleRef).trim()
  if (!ref) return
  var role = findRole_(roles, ref)
  if (!role) throw userError_('役職が見つかりません: ' + ref)
  if (role.tier === 'top') throw userError_('最上位の役職は、最上位の役職の人だけが付けられます。')
  if (!containsAll_(actorCaps, roleCapabilities_(roles, role.id)) || (!actorFull && isFullAdminRoleRef_(roles, role.id))) {
    throw userError_('自分が持っていない操作ができる役職は付けられません: ' + role.name)
  }
}

// 最上位でない人が役職の一覧を保存する時(updateRoles)の決まり。
//   - 役職ごとのできる操作は変えられない(できる操作の設定は最上位だけ)。
//     既定のままの役職の制限を変えた時に既定が変わるのは今までと同じ(全権管理者が役職を制限なしにする等)。
//     ただし、自分の持っていない操作が増える時は、変える前のできる操作を書いて残す
//   - 新しい役職は、自分の持っている操作の範囲だけ
//   - 制限なしでない人は、役職の制限を変えられず、制限なしの役職を作れない
// 直した一覧を返す(変えてはいけない所を変えていれば userError_)
function guardRolesChangeByNonTop_(acting, current, parsed) {
  var actorCaps = roleCapabilities_(current, acting.role)
  var actorFull = isFullAdminRoleRef_(current, acting.role)
  var byId = {}
  current.forEach(function (r) { byId[r.id] = r })
  return parsed.map(function (r) {
    var before = byId[r.id]
    var next = {}
    Object.keys(r).forEach(function (k) { next[k] = r[k] })
    if (before) {
      if (!actorFull && r.tier === 'admin' && before.tier === 'admin' && !!r.restricted !== !!before.restricted) {
        throw userError_('役職の制限(制限なし・制限あり)は、制限なしの管理者か最上位の役職の人だけが変えられます。')
      }
      var beforeCaps = roleCapabilities_(current, before.id)
      if (Array.isArray(r.capabilities) && normalizeCapabilities_(r.capabilities).join(',') !== beforeCaps.join(',')) {
        throw userError_('役職のできる操作は、最上位の役職の人だけが変えられます。')
      }
      if (r.tier === 'admin' && !Array.isArray(r.capabilities)) {
        if (Array.isArray(before.capabilities)) {
          // 画面が送らなかった時も、書いてあったできる操作はそのまま残す
          next.capabilities = beforeCaps
        } else {
          // どちらも既定のまま: 制限の変更で既定が変わるのは今までと同じ。ただし自分の持っていない
          // 操作が増える時は、変える前のできる操作を書いて残す
          var afterCaps = roleCapabilities_([next], r.id)
          if (afterCaps.join(',') !== beforeCaps.join(',') && !containsAll_(actorCaps, afterCaps)) next.capabilities = beforeCaps
        }
      }
    } else {
      if (!actorFull && r.tier === 'admin' && !r.restricted) throw userError_('制限なしの役職は、制限なしの管理者か最上位の役職の人だけが作れます。')
      if (r.tier === 'admin' && !containsAll_(actorCaps, roleCapabilities_([next], r.id))) {
        throw userError_('自分が持っていない操作ができる役職は作れません: ' + r.name)
      }
    }
    return next
  })
}
// ---- 記録を1件1行のシートに持つ(TaskRecords・MemberRecords) ----------------------------------
//
// タスクのコメント・進み具合の記録・変更の記録と、メンバーの 1on1 の記録・評価は、以前は1つのセルに一覧(JSON)で
// 持っていた(1つのセルは5万文字まで)。移行(migrateRecordsToRows。下)の後は、1件1行で次のシートに持つ:
//   TaskRecords   key, task_id, kind(comment / progress / history), entry_id, seq(一覧の中の順番), at, by_id, body_json, updated_at
//   MemberRecords key, member_id, kind(one_on_one / evaluation), entry_id, seq, at, with_id, body_json, updated_at
// body_json は一覧の1項目をそのまま JSON にしたもの(1件は5万文字まで)。key は <親のID>:<kind>:<entry_id>。
//
// どちらに持っているかは、Settings のキー record_rows_state(JSON の state: none / migrating / done)で決める
// (バックアップから戻した時に、データと一緒に戻るように、シートの中に置く)。READ_POLICY に書かないので画面には返さない。
//   none / migrating  これまでどおりセルに持つ(migrating は、移している間。記録の一覧への書き込みを止める)
//   done              行に持つ。Tasks・Members の一覧の列は空にし、読む時に行から今と同じ一覧(JSON)を組み立てる
// 組み立てる場所(読み取りの入口): スナップショット(loadSnapshot_)・書き込みの表(loadSheetGrid_)・findRow_・
// snapshotTableOrSheet_ の予備の読み方。書く場所: updateRowFields_・appendRowByHeaders_ が、一覧の列を行に書き分ける。
// 画面は、初期データの recordRows(状態)で見分ける(古い GAS には無い)
var SHEET_TASK_RECORDS = 'TaskRecords'
var SHEET_MEMBER_RECORDS = 'MemberRecords'
var TASK_RECORDS_HEADERS = ['key', 'task_id', 'kind', 'entry_id', 'seq', 'at', 'by_id', 'body_json', 'updated_at']
var MEMBER_RECORDS_HEADERS = ['key', 'member_id', 'kind', 'entry_id', 'seq', 'at', 'with_id', 'body_json', 'updated_at']
var RECORD_ROWS_STATE_KEY = 'record_rows_state'
// 行に移す一覧(シートと列 → 移す先と kind)
var RECORD_LISTS = [
  { sheet: 'Tasks', column: 'comments_json', kind: 'comment', target: 'TaskRecords', parentCol: 'task_id' },
  { sheet: 'Tasks', column: 'progress_history_json', kind: 'progress', target: 'TaskRecords', parentCol: 'task_id' },
  { sheet: 'Tasks', column: 'history_json', kind: 'history', target: 'TaskRecords', parentCol: 'task_id' },
  { sheet: 'Members', column: 'one_on_ones_json', kind: 'one_on_one', target: 'MemberRecords', parentCol: 'member_id' },
  { sheet: 'Members', column: 'evaluation_history_json', kind: 'evaluation', target: 'MemberRecords', parentCol: 'member_id' },
]
// 変更の記録の上限(セルに持つ間は、5万文字に入るよう50件。行に持った後は500件)
var HISTORY_CAP_CELLS = 50
var HISTORY_CAP_ROWS = 500
var RECORD_ROWS_BUSY_MESSAGE = 'データの持ち方を移しています。数分たってから、もう一度お試しください。書いた文章は消えていないので、コピーして残してください。'
// 移している印が残ったまま(途中で止まった時)でも、これを過ぎたら記録の書き込みを受け付ける(セルが正のまま)
var RECORD_ROWS_STALE_MS = 30 * 60 * 1000

var _recordRowsStateMemo = null
var _recordGrids = {}

function resetRecordRowsMemo_() {
  _recordRowsStateMemo = null
  _recordGrids = {}
}

function parseRecordRowsState_(raw) {
  var s = null
  try { s = JSON.parse(String(raw || '')) } catch (e) { s = null }
  if (!s || typeof s !== 'object') return { state: 'none' }
  if (['none', 'migrating', 'done', 'reverting', 'failed'].indexOf(s.state) < 0) s.state = 'none'
  return s
}

// 今の状態。このリクエストで読んだスナップショットがあれば、その Settings から読む(書き込みのたびにシートを読まない)。
// 読めない時は none(セルに持つ)
function recordRowsState_() {
  if (_recordRowsStateMemo) return _recordRowsStateMemo
  var s
  try {
    s = _requestSnapshot && _requestSnapshot.data ? recordRowsStateOfSnapshot_(_requestSnapshot.data) : parseRecordRowsState_(getSettingValue_(RECORD_ROWS_STATE_KEY))
  } catch (e) {
    s = { state: 'none' }
  }
  _recordRowsStateMemo = s
  return s
}

function setRecordRowsState_(fields) {
  var s = Object.assign({}, fields)
  updateSetting_(RECORD_ROWS_STATE_KEY, JSON.stringify(s))
  _recordRowsStateMemo = s
  return s
}

// 行が正か(done と、戻している間 reverting)。none・migrating・failed はセルが正
function recordRowsOn_() {
  var s = recordRowsState_().state
  return s === 'done' || s === 'reverting'
}

// 移している間か(止まってから RECORD_ROWS_STALE_MS を過ぎたものは数えない)
function recordRowsBusy_(nowMs) {
  var s = recordRowsState_()
  if (s.state !== 'migrating' && s.state !== 'reverting') return false
  var at = Date.parse(String(s.touchedAt || s.since || ''))
  return !(isFinite(at) && (nowMs || Date.now()) - at > RECORD_ROWS_STALE_MS)
}

function historyCap_() {
  return recordRowsOn_() ? HISTORY_CAP_ROWS : HISTORY_CAP_CELLS
}

function recordListsOf_(sheetName) {
  return RECORD_LISTS.filter(function (c) { return c.sheet === sheetName })
}

function recordListOf_(sheetName, column) {
  for (var i = 0; i < RECORD_LISTS.length; i++) {
    if (RECORD_LISTS[i].sheet === sheetName && RECORD_LISTS[i].column === column) return RECORD_LISTS[i]
  }
  return null
}

function isRecordColumn_(sheetName, column) {
  return !!recordListOf_(sheetName, column)
}

function recordHeadersOf_(target) {
  return target === SHEET_TASK_RECORDS ? TASK_RECORDS_HEADERS : MEMBER_RECORDS_HEADERS
}

// 記録のシートを作る(無ければ)。値は文字のまま持つ(日付・数に変えられないように、書式なしテキストにする)
function ensureRecordSheet_(target) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(target)
  var headers = recordHeadersOf_(target)
  if (!sheet) {
    sheet = ss.insertSheet(target)
    sheet.appendRow(headers)
  } else {
    ensureSheetHeaders_(ss, target, headers)
  }
  try { sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), recordHeadersOf_(target).length).setNumberFormat('@') } catch (e) { /* 形式を変えられない時 */ }
  return sheet
}

// ---- 読む ----

// 記録のシートを読み、親ごと・kind ごとにまとめる(このリクエストの中で覚える)。values は getValues の形
function recordIndexFromValues_(values) {
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var col = {}
  headers.forEach(function (h, i) { col[h] = i })
  var parentCol = col.task_id !== undefined ? col.task_id : col.member_id
  var byParent = {}
  for (var r = 1; r < values.length; r++) {
    var v = values[r]
    var key = String(v[col.key] === undefined ? '' : v[col.key])
    if (!key) continue
    var parent = String(v[parentCol])
    var kind = String(v[col.kind])
    var list = (byParent[parent] = byParent[parent] || {})
    ;(list[kind] = list[kind] || []).push({
      row: r + 1, key: key, entryId: String(v[col.entry_id]), seq: Number(v[col.seq]) || 0, body: String(v[col.body_json] || ''),
    })
  }
  Object.keys(byParent).forEach(function (p) {
    Object.keys(byParent[p]).forEach(function (k) { byParent[p][k].sort(function (a, b) { return a.seq - b.seq }) })
  })
  return { headers: headers, col: col, byParent: byParent }
}

function loadRecordIndex_(target) {
  if (_recordGrids[target]) return _recordGrids[target]
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(target)
  var values = sheet ? sheet.getDataRange().getValues() : [recordHeadersOf_(target)]
  if (!values.length || !values[0].length || String(values[0][0]) === '') values = [recordHeadersOf_(target)]
  var index = recordIndexFromValues_(values)
  index.sheet = sheet
  _recordGrids[target] = index
  return index
}

function forgetRecordIndex_(target) {
  if (target) delete _recordGrids[target]
  else _recordGrids = {}
}

function parseRecordBody_(body) {
  try { return JSON.parse(body) } catch (e) { return null }
}

// 親の1つの一覧(順番どおり)
function recordListFromIndex_(index, parentId, kind) {
  var items = ((index.byParent[String(parentId)] || {})[kind]) || []
  var out = []
  items.forEach(function (it) {
    var v = parseRecordBody_(it.body)
    if (v !== null) out.push(v)
  })
  return out
}

// 行の値(見出しの順の配列)の一覧の列に、行から組み立てた一覧(JSON)を入れる
function fillRecordColumns_(sheetName, headers, rowValues, indexOf) {
  var lists = recordListsOf_(sheetName)
  if (!lists.length) return
  var idCol = headers.indexOf('id')
  if (idCol < 0) return
  var id = String(rowValues[idCol])
  if (!id) return
  lists.forEach(function (cfg) {
    var c = headers.indexOf(cfg.column)
    if (c < 0) return
    rowValues[c] = JSON.stringify(recordListFromIndex_(indexOf(cfg.target), id, cfg.kind))
  })
}

// 表(headers・rows)の全部の行に組み立てる(行に持っている時だけ)
function fillRecordColumnsOfTable_(sheetName, table, indexOf) {
  if (!table || !table.headers || !recordListsOf_(sheetName).length) return
  ;(table.rows || []).forEach(function (row) { fillRecordColumns_(sheetName, table.headers, row, indexOf) })
}

// スナップショットの Settings から読んだ状態
function recordRowsStateOfSnapshot_(data) {
  var settings = data && data[SHEET_SETTINGS]
  var raw = ''
  if (settings && settings.headers) {
    var k = settings.headers.indexOf('key'), v = settings.headers.indexOf('value')
    ;(settings.rows || []).forEach(function (r) { if (String(r[k]) === RECORD_ROWS_STATE_KEY) raw = r[v] })
  }
  return parseRecordRowsState_(raw)
}

// スナップショット(Members・Projects・Tasks・Settings)に組み立てる。状態はスナップショットの Settings から読む
function fillRecordColumnsOfSnapshot_(data) {
  if (recordRowsStateOfSnapshot_(data).state !== 'done') return data
  var tables = readSheetTables_([SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS])
  var indexes = {}
  var indexOf = function (target) {
    if (!indexes[target]) {
      var t = tables[target] || { headers: [], rows: [] }
      indexes[target] = recordIndexFromValues_([t.headers && t.headers.length ? t.headers : recordHeadersOf_(target)].concat(t.rows || []))
    }
    return indexes[target]
  }
  fillRecordColumnsOfTable_(SHEET_TASKS, data[SHEET_TASKS], indexOf)
  fillRecordColumnsOfTable_(SHEET_MEMBERS, data[SHEET_MEMBERS], indexOf)
  return data
}

// 書き込みの表・1行の読み取り(getValues の形)に組み立てる
function fillRecordColumnsOfValues_(sheetName, values) {
  if (!recordListsOf_(sheetName).length || !recordRowsOn_()) return
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  for (var i = 1; i < values.length; i++) fillRecordColumns_(sheetName, headers, values[i], loadRecordIndex_)
}

function fillRecordColumnsOfRow_(sheetName, headers, rowValues) {
  if (!recordListsOf_(sheetName).length || !recordRowsOn_()) return
  fillRecordColumns_(sheetName, headers, rowValues, loadRecordIndex_)
}

// ---- 書く ----

// 1件の記録の行(見出しの順の配列)
function recordRowValues_(cfg, parentId, entry, seq, entryId, nowIso) {
  var body = JSON.stringify(entry)
  if (body.length > CELL_MAX_CHARS) throw cellTooLongError_(cfg.target, cfg.column, body, null)
  var o = {
    key: String(parentId) + ':' + cfg.kind + ':' + entryId,
    task_id: String(parentId), member_id: String(parentId), kind: cfg.kind, entry_id: entryId, seq: String(seq),
    at: String((entry && (entry.at || entry.date)) || ''),
    by_id: String((entry && (entry.byId || entry.by)) || ''),
    with_id: String((entry && (entry.withId || entry.evaluatorId || entry.byId)) || ''),
    body_json: body, updated_at: nowIso,
  }
  return recordHeadersOf_(cfg.target).map(function (h) { return o[h] === undefined ? '' : o[h] })
}

function recordEntryId_(entry, seq) {
  var id = entry && typeof entry === 'object' && entry.id !== undefined && entry.id !== null ? String(entry.id) : ''
  return id || 'noid-' + seq
}

// 親の1つの一覧を、list(配列)と同じ中身・順番にする(足す・変える・消す)。何も変わらなければ書かない
function writeRecordList_(cfg, parentId, list) {
  return syncRecordListsBulk_(cfg.target, [{ cfg: cfg, parentId: parentId, list: list }]) > 0
}

// 記録のシート1枚について、いくつもの(親・kind)の一覧をまとめて、渡した一覧と同じにする。変えた行の数を返す。
// items: [{ cfg, parentId, list }]。シートは1回だけ読み、足す行はまとめて1回で書く
function syncRecordListsBulk_(target, items) {
  var sheet = ensureRecordSheet_(target)
  forgetRecordIndex_(target)
  var index = loadRecordIndex_(target)
  var nowIso = new Date().toISOString()
  var width = recordHeadersOf_(target).length
  var updates = []
  var appends = []
  var removes = []
  items.forEach(function (item) {
    var cfg = item.cfg
    var list = Array.isArray(item.list) ? item.list : []
    var current = ((index.byParent[String(item.parentId)] || {})[cfg.kind]) || []
    var byKey = {}
    current.forEach(function (it) { byKey[it.key] = it })
    var keep = {}
    list.forEach(function (entry, seq) {
      var row = recordRowValues_(cfg, item.parentId, entry, seq, recordEntryId_(entry, seq), nowIso)
      var key = row[0]
      if (keep[key]) return // 同じ ID が2つある時は、最初の1つだけ
      keep[key] = true
      var old = byKey[key]
      if (!old) { appends.push(row); return }
      if (old.body === row[index.col.body_json] && old.seq === seq) return
      updates.push({ row: old.row, values: row })
    })
    current.forEach(function (it) { if (!keep[it.key]) removes.push(it.row) })
  })
  if (!updates.length && !appends.length && !removes.length) return 0
  updates.forEach(function (u) { sheet.getRange(u.row, 1, 1, width).setValues([u.values]) })
  removes.sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  if (appends.length) {
    var start = sheet.getLastRow() + 1
    var need = start + appends.length - 1 - sheet.getMaxRows()
    if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need)
    var range = sheet.getRange(start, 1, appends.length, width)
    try { range.setNumberFormat('@') } catch (e) { /* 形式を変えられない時 */ }
    range.setValues(appends)
  }
  forgetRecordIndex_(target)
  return updates.length + appends.length + removes.length
}

// 書き込み(列の名前 → 値)のうち、一覧の列を行に書き、残りの列だけを返す。行に持っていない時はそのまま返す
function splitRecordFields_(sheetName, rowId, fields) {
  if (!recordListsOf_(sheetName).length || !recordRowsOn_()) return fields
  var rest = {}
  Object.keys(fields).forEach(function (k) {
    var cfg = recordListOf_(sheetName, k)
    if (!cfg) { rest[k] = fields[k]; return }
    var list = []
    var v = fields[k]
    if (Array.isArray(v)) list = v
    else if (v !== '' && v !== null && v !== undefined) {
      try { list = JSON.parse(String(v)) } catch (e) { throw userError_('記録の形式が不正です。') }
      if (!Array.isArray(list)) throw userError_('記録の形式が不正です。')
    }
    writeRecordList_(cfg, rowId, list)
  })
  return rest
}

// 書き込みの表(このリクエストで覚えている Tasks・Members)の一覧の列を、書いた値にする(続けて読む処理のため)
function noteRecordFieldsInGrid_(sheetName, rowId, recordFields) {
  var grid = _sheetGrids[sheetName]
  if (!grid) return
  var r = grid.rowOf[String(rowId)]
  if (!r || !grid.values[r - 1]) return
  Object.keys(recordFields).forEach(function (k) {
    var c = grid.headers.indexOf(k)
    if (c < 0) return
    var v = recordFields[k]
    grid.values[r - 1][c] = Array.isArray(v) ? JSON.stringify(v) : String(v === null || v === undefined || v === '' ? '[]' : v)
  })
}

// 記録の一覧への書き込みを、移している間は断る
function assertRecordWritable_(sheetName, fields) {
  if (!recordListsOf_(sheetName).length) return
  var touches = Object.keys(fields).some(function (k) { return isRecordColumn_(sheetName, k) })
  if (touches && recordRowsBusy_(Date.now())) throw userError_(RECORD_ROWS_BUSY_MESSAGE)
}

// 親(タスク・メンバー)の行を消した時に、その記録の行も消す
function deleteRecordsOfParents_(sheetName, ids) {
  if (!ids || !ids.length || !recordRowsOn_()) return
  var targets = {}
  recordListsOf_(sheetName).forEach(function (c) { targets[c.target] = true })
  var wanted = {}
  ids.forEach(function (id) { wanted[String(id)] = true })
  Object.keys(targets).forEach(function (target) {
    var index = loadRecordIndex_(target)
    if (!index.sheet) return
    var rows = []
    Object.keys(index.byParent).forEach(function (p) {
      if (!wanted[p]) return
      Object.keys(index.byParent[p]).forEach(function (k) { index.byParent[p][k].forEach(function (it) { rows.push(it.row) }) })
    })
    rows.sort(function (a, b) { return b - a }).forEach(function (r) { index.sheet.deleteRow(r) })
    forgetRecordIndex_(target)
  })
}

// 新しい団体(setupOhsumi)は、最初から行に持つ。一覧の列にまだ何も入っていなければ、印を done にする
function startRecordRowsIfEmpty_() {
  var s = recordRowsState_()
  if (s.state !== 'none' || s.decided) return s
  ensureRecordSheet_(SHEET_TASK_RECORDS)
  ensureRecordSheet_(SHEET_MEMBER_RECORDS)
  if (countCellRecords_().entries > 0) return s
  return setRecordRowsState_({ state: 'done', since: new Date().toISOString(), by: 'setup', version: 1 })
}

// セルに入っている記録の数(移行の試しと、新しい団体の見分けに使う)
function countCellRecords_() {
  var out = { entries: 0, parents: 0, unreadable: [], duplicates: [], tooLong: [], perList: {} }
  ;['Tasks', 'Members'].forEach(function (sheetName) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
    if (!sheet || sheet.getLastRow() < 2) return
    var values = sheet.getDataRange().getValues()
    var headers = (values[0] || []).map(function (h) { return String(h).trim() })
    var idCol = headers.indexOf('id')
    recordListsOf_(sheetName).forEach(function (cfg) {
      var c = headers.indexOf(cfg.column)
      var n = 0
      if (c < 0) { out.perList[cfg.kind] = 0; return }
      for (var i = 1; i < values.length; i++) {
        var raw = String(values[i][c] || '')
        if (!raw || raw === '[]') continue
        var list = null
        try { list = JSON.parse(raw) } catch (e) { list = null }
        var id = String(values[i][idCol])
        if (!Array.isArray(list)) { out.unreadable.push(sheetName + ':' + id + ':' + cfg.column); continue }
        out.parents++
        var seen = {}
        list.forEach(function (entry, seq) {
          var eid = recordEntryId_(entry, seq)
          if (seen[eid]) out.duplicates.push(sheetName + ':' + id + ':' + cfg.kind + ':' + eid)
          seen[eid] = true
          if (JSON.stringify(entry).length > CELL_MAX_CHARS) out.tooLong.push(sheetName + ':' + id + ':' + cfg.kind + ':' + eid)
        })
        n += list.length
      }
      out.perList[cfg.kind] = n
      out.entries += n
    })
  })
  return out
}

// ---- バックアップから戻す時 ----

// ほかのスプレッドシート(バックアップ)の Tasks・Members の値に、そのスプレッドシートの記録のシートから一覧を組み立てる
function fillRecordColumnsFromSpreadsheet_(spreadsheet, sheetName, values) {
  if (!recordListsOf_(sheetName).length) return values
  var settings = spreadsheet.getSheetByName(SHEET_SETTINGS)
  var raw = ''
  if (settings && settings.getLastRow() > 1) {
    settings.getDataRange().getValues().forEach(function (r) { if (String(r[0]) === RECORD_ROWS_STATE_KEY) raw = r[1] })
  }
  if (parseRecordRowsState_(raw).state !== 'done') return values
  var indexes = {}
  var indexOf = function (target) {
    if (!indexes[target]) {
      var s = spreadsheet.getSheetByName(target)
      var v = s ? s.getDataRange().getValues() : [recordHeadersOf_(target)]
      indexes[target] = recordIndexFromValues_(v.length && v[0].length ? v : [recordHeadersOf_(target)])
    }
    return indexes[target]
  }
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  for (var i = 1; i < values.length; i++) fillRecordColumns_(sheetName, headers, values[i], indexOf)
  return values
}

// 全体を戻した後: バックアップに無かった記録のシート(移行の前のバックアップ)は空にする
function afterFullRestoreRecordRows_(restoredNames) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ;[SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS].forEach(function (name) {
    if (restoredNames.indexOf(name) >= 0) return
    var sheet = ss.getSheetByName(name)
    if (!sheet) return
    sheet.clearContents()
    sheet.getRange(1, 1, 1, recordHeadersOf_(name).length).setValues([recordHeadersOf_(name)])
  })
  resetRecordRowsMemo_()
}

// ---- 移す・照合する・戻す(代表だけ。ADMIN の「データの持ち方」から1回ずつ呼ぶ) -------------------------
//
// migrateRecordsToRows_(試す / 進める):
//   試す(dryRun)   書かずに、一覧ごとの件数・読めない一覧・同じ ID の重なり・1件が長すぎる記録を返す
//   1回目           問題があれば止める。実行の前に自動でバックアップを取り(「(移行の前)」)、印を migrating にする
//                   (移している間は、記録の一覧への書き込みを断る。30分止まったままなら受け付ける)
//   移す(copy)      Tasks → Members の順に、親の行を MIGRATE_BATCH 件ずつ記録のシートに写す。進んだ位置(cursor)を
//                   印に残すので、途中で止まっても続きから。写すのは「セルと同じにする」なので、何度やっても重ならない
//   照合(verify)    すべての親について、セルの一覧と行から組み立てた一覧を比べる(件数と中身)。違う親は写し直して
//                   もう一度比べ、それでも違えば failed にして止める(セルが正のまま。何も変わらない)
//   切り替え        印を done にしてから、セルの一覧の列を空にする。版を上げ、操作の記録(AuditLog)に残す
// revertRecordRows_(試す / 戻す):
//   行から今の形の一覧を組み立て、5万文字を超える親があれば止める。実行の前に自動でバックアップを取り
//   (「(移行を戻す前)」)、セルに書き、照合してから印を none にし、記録のシートを空にする
var MIGRATE_BATCH = 100
var MIGRATE_TIME_BUDGET_MS = 4 * 60 * 1000

function recordCellTables_(names) {
  var out = {}
  ;(names || ['Tasks', 'Members']).forEach(function (sheetName) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)
    var values = sheet ? sheet.getDataRange().getValues() : [[]]
    out[sheetName] = { sheet: sheet, values: values, headers: (values[0] || []).map(function (h) { return String(h).trim() }) }
  })
  return out
}

function cellListOf_(table, rowValues, cfg) {
  var c = table.headers.indexOf(cfg.column)
  if (c < 0) return []
  var raw = String(rowValues[c] || '')
  if (!raw) return []
  var v = null
  try { v = JSON.parse(raw) } catch (e) { v = null }
  return Array.isArray(v) ? v : []
}

// 今の状態と件数(ADMIN の「データの持ち方」)
function recordRowsStatus_() {
  resetRecordRowsMemo_()
  var s = recordRowsState_()
  var out = { state: s.state, since: s.since || '', phase: s.phase || '', cursor: s.cursor || null, backup: s.backupName || '', counts: s.counts || null, message: s.message || '' }
  if (s.state === 'done') {
    var rows = {}
    ;[SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS].forEach(function (target) {
      var index = loadRecordIndex_(target)
      Object.keys(index.byParent).forEach(function (p) {
        Object.keys(index.byParent[p]).forEach(function (k) { rows[k] = (rows[k] || 0) + index.byParent[p][k].length })
      })
    })
    out.rows = rows
  } else {
    var c = countCellRecords_()
    out.cells = c.perList
    out.problems = { unreadable: c.unreadable.slice(0, 20), duplicates: c.duplicates.slice(0, 20), tooLong: c.tooLong.slice(0, 20) }
  }
  return out
}

function touchRecordRowsState_(fields) {
  var s = Object.assign({}, recordRowsState_(), fields, { touchedAt: new Date().toISOString() })
  return setRecordRowsState_(s)
}

function migrateRecordsToRows_(actorId, opts, nowMs) {
  opts = opts || {}
  nowMs = nowMs || Date.now()
  var started = Date.now()
  resetRecordRowsMemo_()
  var s = recordRowsState_()
  if (s.state === 'done') return { state: 'done', done: true }
  if (s.state === 'reverting') throw userError_('戻している途中です。先に「戻す」を最後まで進めてください。')
  if (opts.dryRun) {
    var c = countCellRecords_()
    return { dryRun: true, state: s.state, counts: c.perList, entries: c.entries, parents: c.parents,
      problems: { unreadable: c.unreadable.slice(0, 50), duplicates: c.duplicates.slice(0, 50), tooLong: c.tooLong.slice(0, 50) },
      ok: !c.unreadable.length && !c.tooLong.length }
  }
  if (s.state !== 'migrating') {
    // 1回目: 確かめて、バックアップを取ってから始める
    var check = countCellRecords_()
    if (check.unreadable.length || check.tooLong.length) {
      throw userError_('移せない記録があります(読めない一覧 ' + check.unreadable.length + ' 件・長すぎる記録 ' + check.tooLong.length +
        ' 件)。「試す」で場所を確かめてください: ' + check.unreadable.concat(check.tooLong).slice(0, 5).join('、'))
    }
    var backup = createBackup_('beforeMigration', nowMs)
    ensureRecordSheet_(SHEET_TASK_RECORDS)
    ensureRecordSheet_(SHEET_MEMBER_RECORDS)
    s = setRecordRowsState_({ state: 'migrating', since: new Date(nowMs).toISOString(), touchedAt: new Date(nowMs).toISOString(), by: String(actorId),
      backupId: backup.id, backupName: backup.name, phase: 'copy', cursor: { sheet: 'Tasks', index: 0 }, counts: check.perList, version: 1 })
    appendOrgAudit_(actorId, 'migrateRecordsToRows', 'start', { backup: backup.name, counts: check.perList })
  }
  var tables = recordCellTables_()
  // 移す(続きから)
  while (s.phase === 'copy') {
    var cur = s.cursor || { sheet: 'Tasks', index: 0 }
    var table = tables[cur.sheet]
    var rows = table.values.slice(1)
    var idCol = table.headers.indexOf('id')
    var end = Math.min(rows.length, cur.index + MIGRATE_BATCH)
    var byTarget = {}
    for (var i = cur.index; i < end; i++) {
      var id = String(rows[i][idCol] || '')
      if (!id) continue
      recordListsOf_(cur.sheet).forEach(function (cfg) {
        ;(byTarget[cfg.target] = byTarget[cfg.target] || []).push({ cfg: cfg, parentId: id, list: cellListOf_(table, rows[i], cfg) })
      })
    }
    Object.keys(byTarget).forEach(function (target) { syncRecordListsBulk_(target, byTarget[target]) })
    var next = end >= rows.length
      ? (cur.sheet === 'Tasks' ? { phase: 'copy', cursor: { sheet: 'Members', index: 0 } } : { phase: 'verify', cursor: null })
      : { phase: 'copy', cursor: { sheet: cur.sheet, index: end } }
    s = touchRecordRowsState_(next)
    if (s.phase === 'copy' && Date.now() - started > MIGRATE_TIME_BUDGET_MS) {
      return { state: 'migrating', phase: 'copy', cursor: s.cursor, done: false }
    }
  }
  // 照合する(違う親は1回だけ写し直す)
  var result = verifyRecordRows_(tables)
  if (result.mismatches.length) {
    var byT = {}
    result.mismatches.forEach(function (m) {
      ;(byT[m.cfg.target] = byT[m.cfg.target] || []).push({ cfg: m.cfg, parentId: m.parentId, list: m.cellList })
    })
    Object.keys(byT).forEach(function (target) { syncRecordListsBulk_(target, byT[target]) })
    result = verifyRecordRows_(tables)
  }
  if (result.mismatches.length) {
    var where = result.mismatches.slice(0, 10).map(function (m) { return m.cfg.sheet + ':' + m.parentId + ':' + m.cfg.kind })
    setRecordRowsState_(Object.assign({}, s, { state: 'failed', phase: 'verify', message: '照合が合いませんでした: ' + where.join('、') }))
    appendOrgAudit_(actorId, 'migrateRecordsToRows', 'failed', { mismatches: where })
    return { state: 'failed', done: false, mismatches: where }
  }
  // 切り替える: 先に印を done にしてから、セルの一覧の列を空にする(途中で止まっても、行が正になっている)
  s = setRecordRowsState_({ state: 'done', since: new Date().toISOString(), by: String(actorId), backupId: s.backupId, backupName: s.backupName,
    counts: result.counts, version: 1 })
  clearRecordCells_(tables)
  forgetSheetGrid_()
  bumpDataVersion()
  appendOrgAudit_(actorId, 'migrateRecordsToRows', 'done', { counts: result.counts, backup: s.backupName })
  return { state: 'done', done: true, counts: result.counts, backup: s.backupName }
}

// セルの一覧と、行から組み立てた一覧を比べる(件数と中身)。tables はセルの値(recordCellTables_)
function verifyRecordRows_(tables) {
  forgetRecordIndex_()
  var mismatches = []
  var counts = {}
  ;['Tasks', 'Members'].forEach(function (sheetName) {
    var table = tables[sheetName]
    var idCol = table.headers.indexOf('id')
    var seen = {}
    table.values.slice(1).forEach(function (row) {
      var id = String(row[idCol] || '')
      if (!id) return
      seen[id] = true
      recordListsOf_(sheetName).forEach(function (cfg) {
        var cellList = cellListOf_(table, row, cfg)
        var rowList = recordListFromIndex_(loadRecordIndex_(cfg.target), id, cfg.kind)
        counts[cfg.kind] = (counts[cfg.kind] || 0) + rowList.length
        if (cellList.length !== rowList.length || canonicalJson_(cellList) !== canonicalJson_(rowList)) {
          mismatches.push({ cfg: cfg, parentId: id, cellList: cellList })
        }
      })
    })
    // 親の行が無い記録(消したタスクの残りなど)も、違いとして消す
    recordListsOf_(sheetName).forEach(function (cfg) {
      var index = loadRecordIndex_(cfg.target)
      Object.keys(index.byParent).forEach(function (p) {
        if (seen[p] || !(index.byParent[p][cfg.kind] || []).length) return
        if (sheetName === 'Tasks' && isArchivedTaskId_(p)) return
        mismatches.push({ cfg: cfg, parentId: p, cellList: [] })
      })
    })
  })
  return { mismatches: mismatches, counts: counts }
}

// TasksArchive に移したタスクか(その記録は、TaskRecords に残してよい)
function isArchivedTaskId_(id) {
  if (!_archivedTaskIds) {
    _archivedTaskIds = {}
    try { archivedTaskRows_().forEach(function (t) { _archivedTaskIds[String(t.id)] = true }) } catch (e) { /* シートが無い */ }
  }
  return !!_archivedTaskIds[String(id)]
}
var _archivedTaskIds = null

function clearRecordCells_(tables) {
  ;['Tasks', 'Members'].forEach(function (sheetName) {
    var table = tables[sheetName]
    if (!table.sheet || table.values.length < 2) return
    recordListsOf_(sheetName).forEach(function (cfg) {
      var c = table.headers.indexOf(cfg.column)
      if (c < 0) return
      var blank = table.values.slice(1).map(function () { return [''] })
      table.sheet.getRange(2, c + 1, blank.length, 1).setValues(blank)
    })
  })
}

function revertRecordRows_(actorId, opts, nowMs) {
  opts = opts || {}
  nowMs = nowMs || Date.now()
  resetRecordRowsMemo_()
  var s = recordRowsState_()
  if (s.state === 'none') return { state: 'none', done: true }
  if (s.state === 'migrating' || s.state === 'failed') {
    // 移している途中・照合が合わなかった時: セルが正のままなので、記録のシートを空にして none に戻す
    if (opts.dryRun) return { dryRun: true, state: s.state, ok: true, tooLong: [] }
    clearRecordSheets_()
    setRecordRowsState_({ state: 'none', since: new Date(nowMs).toISOString(), by: String(actorId), decided: true })
    appendOrgAudit_(actorId, 'revertRecordRows', 'cancel', { from: s.state })
    bumpDataVersion()
    return { state: 'none', done: true }
  }
  // TasksArchive(移したタスク): 移行の後に移したタスクの記録は行にしか無いので、それもセルに戻す
  // (移行の前に移したタスクは、セルに一覧が残っていて行が無いので、そのままにする)
  var sheets = ['Tasks', 'Members', SHEET_TASKS_ARCHIVE]
  var tables = recordCellTables_(sheets)
  var listSheetOf = function (name) { return name === SHEET_TASKS_ARCHIVE ? 'Tasks' : name }
  forgetRecordIndex_()
  // 行から、今の形の一覧を組み立てる
  var built = []
  var tooLong = []
  sheets.forEach(function (sheetName) {
    var table = tables[sheetName]
    if (!table.sheet) return
    var idCol = table.headers.indexOf('id')
    table.values.slice(1).forEach(function (row, i) {
      var id = String(row[idCol] || '')
      if (!id) return
      recordListsOf_(listSheetOf(sheetName)).forEach(function (cfg) {
        var c = table.headers.indexOf(cfg.column)
        if (c < 0) return
        var list = recordListFromIndex_(loadRecordIndex_(cfg.target), id, cfg.kind)
        if (sheetName === SHEET_TASKS_ARCHIVE && !list.length) list = cellListOf_(table, row, cfg)
        var json = list.length ? JSON.stringify(list) : ''
        if (json.length > CELL_MAX_CHARS) tooLong.push(sheetName + ':' + id + ':' + cfg.kind + '(' + json.length + '文字)')
        built.push({ sheetName: sheetName, row: i + 2, col: c + 1, json: json, list: list })
      })
    })
  })
  if (opts.dryRun) return { dryRun: true, state: s.state, ok: !tooLong.length, tooLong: tooLong.slice(0, 50), parents: built.filter(function (b) { return b.list.length }).length }
  if (tooLong.length) throw userError_('セルに入らない(5万文字を超える)記録があるため、戻せません: ' + tooLong.slice(0, 5).join('、'))
  var backup = createBackup_('beforeRevert', nowMs)
  setRecordRowsState_(Object.assign({}, s, { state: 'reverting', touchedAt: new Date(nowMs).toISOString(), revertBackupName: backup.name }))
  // 列ごとに1回で書く
  sheets.forEach(function (sheetName) {
    var table = tables[sheetName]
    if (!table.sheet || table.values.length < 2) return
    recordListsOf_(listSheetOf(sheetName)).forEach(function (cfg) {
      var c = table.headers.indexOf(cfg.column)
      if (c < 0) return
      var col = table.values.slice(1).map(function () { return [''] })
      built.forEach(function (b) { if (b.sheetName === sheetName && b.col === c + 1) col[b.row - 2] = [b.json] })
      var range = table.sheet.getRange(2, c + 1, col.length, 1)
      try { range.setNumberFormat('@') } catch (e) { /* 形式を変えられない時 */ }
      range.setValues(col)
    })
  })
  // 照合: 書いたセルを読み直し、行から組み立てた一覧と同じか
  var after = recordCellTables_(sheets)
  var bad = built.filter(function (b) {
    var table = after[b.sheetName]
    var raw = String(table.values[b.row - 1][b.col - 1] || '')
    var got = raw ? JSON.parse(raw) : []
    return canonicalJson_(got) !== canonicalJson_(b.list)
  })
  if (bad.length) {
    setRecordRowsState_(Object.assign({}, s, { state: 'done' }))
    throw userError_('戻した記録の照合が合わなかったため、行に持ったままにしました(' + bad.length + ' 件)。')
  }
  setRecordRowsState_({ state: 'none', since: new Date().toISOString(), by: String(actorId), decided: true, revertBackupName: backup.name })
  clearRecordSheets_()
  forgetSheetGrid_()
  bumpDataVersion()
  appendOrgAudit_(actorId, 'revertRecordRows', 'done', { backup: backup.name })
  return { state: 'none', done: true, backup: backup.name }
}

function clearRecordSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ;[SHEET_TASK_RECORDS, SHEET_MEMBER_RECORDS].forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet) return
    sheet.clearContents()
    sheet.getRange(1, 1, 1, recordHeadersOf_(name).length).setValues([recordHeadersOf_(name)])
  })
  forgetRecordIndex_()
}
// ---- 兼部の統合表示のための、本人に関係する分だけの読み取り(getMyDigest) -------------------------
//
// 画面は、端末に保存している団体ごとのログインで、各団体の GAS にこの操作を送り、答えを画面の中でだけまとめる
// (サーバーを足さない。docs/design-multi-org-view.md)。返すのは本人の分だけ:
//   tasks     本人が担当で完了していない(assignee)・確認待ちで本人が確認する人(reviewTarget)・
//             日程調整・フォームに招待されていて答えていない(invitee。日程調整は候補も)タスク
//             (件名・状態・日付・優先度・重要度・プロジェクト名だけ。説明・コメント・ほかの人の名前は返さない)
//   counts    担当・確認待ち・期限切れ・回答待ちの数
//   団体の名前・テーマの色(統合表示で団体を見分ける)・本人の名前・機能停止の状態
// ほかの人のタスク・メンバーの一覧・団体の設定・人材の情報は返さない。見えるかは canViewTaskRow_ を通す。
// 担当のタスクは、期限が to より後のものを返さない(期限の無いもの・期限切れは返す)。期間は62日まで。
// 結果は データの版・本人・期間 ごとに5分キャッシュする。knownVersion が今の版と同じなら unchanged だけを返す。
// 1人1時間 RATE_LIMITS.digest 回まで(超えたら、キャッシュがあればそれを返す)
var DIGEST_MAX_TASKS = 200
var DIGEST_MAX_DAYS = 62
var DIGEST_CACHE_TTL = 300
var DIGEST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function digestRange_(body, todayStr) {
  var from = String((body && body.from) || todayStr)
  var to = String((body && body.to) || '')
  if (!DIGEST_DATE_PATTERN.test(from)) throw userError_('期間の形が正しくありません。')
  if (!to) to = Utilities.formatDate(new Date(Date.parse(from + 'T00:00:00Z') + 27 * 86400000), 'UTC', 'yyyy-MM-dd')
  if (!DIGEST_DATE_PATTERN.test(to)) throw userError_('期間の形が正しくありません。')
  var days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000
  if (!(days >= 0) || days > DIGEST_MAX_DAYS) throw userError_('期間は ' + DIGEST_MAX_DAYS + ' 日までにしてください。')
  return { from: from, to: to }
}

function myDigest_(memberId, body) {
  var snapshot = loadSnapshot_()
  var version = snapshot.version
  if (body && body.knownVersion && String(body.knownVersion) === version) return { version: version, unchanged: true }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  var range = digestRange_(body, today)
  var cache = CacheService.getScriptCache()
  var key = 'digest:' + version + ':' + memberId + ':' + range.from + ':' + range.to
  var cached = null
  try { var raw = cache.get(key); if (raw) cached = JSON.parse(raw) } catch (e) { cached = null }
  if (!takeRateLimit_('digest', memberId, 1)) {
    if (cached) return cached
    throw userError_('まとめて表示する読み込みが多すぎます。しばらくしてから、もう一度お試しください。')
  }
  if (cached) return cached
  var out = buildMyDigest_(snapshot.data, memberId, range, today)
  out.version = version
  try { cache.put(key, JSON.stringify(out), DIGEST_CACHE_TTL) } catch (e) { /* 大きすぎる時は毎回作る */ }
  return out
}

function buildMyDigest_(data, memberId, range, today) {
  var memberRow = findMemberInSnapshot_(data, memberId)
  if (!memberRow) throw userError_('メンバーが見つかりません。')
  var viewer = makeViewer_(memberRow, rolesFromSnapshot_(data))
  var me = String(memberId)
  var table = data[SHEET_TASKS] || { headers: [], rows: [] }
  var projects = {}
  var pt = data[SHEET_PROJECTS] || { headers: [], rows: [] }
  var pId = pt.headers.indexOf('id'), pName = pt.headers.indexOf('name')
  ;(pt.rows || []).forEach(function (r) { projects[String(r[pId])] = String(r[pName] || '') })
  var tasks = []
  var counts = { assigned: 0, reviewWaiting: 0, overdue: 0, unanswered: 0 }
  ;(table.rows || []).forEach(function (r) {
    var t = {}
    table.headers.forEach(function (h, i) { t[h] = r[i] })
    if (!String(t.id || '') || String(t.deleted_at || '') !== '') return
    if (!canViewTaskRow_(viewer, t)) return
    var status = normalizeCode_('status', t.status)
    if (status === 'done') return
    var due = String(t.due_date || '').slice(0, 10)
    var role = null
    var invite = digestInviteOf_(t, me)
    if (invite) role = 'invitee'
    else if (status === 'review' && digestIsReviewTarget_(t, me)) role = 'reviewTarget'
    else if (splitCsvList_(t.assignee_id).indexOf(me) >= 0) {
      if (due && due > range.to) return
      role = 'assignee'
    }
    if (!role) return
    var overdue = !!due && due < today
    if (role === 'assignee') counts.assigned++
    if (role === 'reviewTarget') counts.reviewWaiting++
    if (role === 'invitee') counts.unanswered++
    if (overdue && role !== 'invitee') counts.overdue++
    var item = {
      id: String(t.id), title: String(t.title || ''), status: status, role: role, overdue: overdue,
      dueDate: due, dueTime: String(t.due_time || ''), startDate: String(t.start_date || '').slice(0, 10),
      priority: normalizeCode_('priority', t.priority), importance: normalizeCode_('importance', t.importance),
      projectName: projects[String(t.project_id || '')] || '',
    }
    if (invite && invite.candidates) item.candidates = invite.candidates
    if (invite) item.inviteKind = invite.kind
    tasks.push(item)
  })
  tasks.sort(function (a, b) {
    var x = a.dueDate || '9999-99-99', y = b.dueDate || '9999-99-99'
    return x < y ? -1 : x > y ? 1 : 0
  })
  var settingOf = function (k) {
    var s = data[SHEET_SETTINGS] || { headers: [], rows: [] }
    var kc = s.headers.indexOf('key'), vc = s.headers.indexOf('value')
    for (var i = 0; i < (s.rows || []).length; i++) if (String(s.rows[i][kc]) === k) return String(s.rows[i][vc] || '')
    return ''
  }
  var contract = currentContract_(Date.now())
  return {
    orgName: settingOf('org_name'),
    themeColor: /^#[0-9a-fA-F]{6}$/.test(settingOf('theme_color')) ? settingOf('theme_color') : '',
    memberId: me,
    memberName: String(memberRow.display_name || memberRow.name || ''),
    contract: { phase: String(contract.phase || ''), kind: String(contract.kind || '') },
    tasks: tasks.slice(0, DIGEST_MAX_TASKS),
    truncated: tasks.length > DIGEST_MAX_TASKS,
    counts: counts,
  }
}

// 確認待ちのタスクで、本人が確認する人か(確認者 → 担当者の報告先 → 全権管理者。担当者本人は除く)
function digestIsReviewTarget_(task, me) {
  if (splitCsvList_(task.assignee_id).indexOf(me) >= 0) return false
  try { return reviewTargets_(task).ids.indexOf(me) >= 0 } catch (e) { return false }
}

// 日程調整・フォームに招待されていて、まだ答えていないか。日程調整は候補(ID・表示・日付・時刻)も返す
function digestInviteOf_(task, me) {
  var parse = function (v) { try { var o = JSON.parse(String(v || '')); return o && typeof o === 'object' ? o : null } catch (e) { return null } }
  var schedule = parse(task.schedule_json)
  if (schedule && Array.isArray(schedule.invitedIds) && schedule.invitedIds.map(String).indexOf(me) >= 0) {
    var answered = schedule.responses && schedule.responses[me] && Object.keys(schedule.responses[me]).length > 0
    if (!answered) {
      return { kind: 'schedule', candidates: (Array.isArray(schedule.candidates) ? schedule.candidates : []).slice(0, 20).map(function (c) {
        return { id: String(c.id || ''), label: String(c.label || '').slice(0, 100), date: String(c.date || ''), startTime: String(c.startTime || ''), endTime: String(c.endTime || '') }
      }) }
    }
  }
  var form = parse(task.form_json)
  if (form && Array.isArray(form.invitedIds) && form.invitedIds.map(String).indexOf(me) >= 0) {
    var done = form.responses && form.responses[me]
    if (!done) return { kind: 'form', candidates: null }
  }
  return null
}
