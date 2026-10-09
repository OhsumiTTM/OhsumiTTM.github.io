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
//   setupOhsumiFromMenu・registerWithRegistryFromMenu・showInviteLinkFromMenu・regenerateInitialSetupCodeFromMenu  「Ohsumi」メニューから呼ばれる
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

