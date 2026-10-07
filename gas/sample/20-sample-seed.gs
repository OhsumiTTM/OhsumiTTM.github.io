// ---- エディタから実行する関数(サンプル・見本のデータを入れる・消す) --------------------------------
//
// サンプル(崩れ確認用。'sample-')と見本(デモ・画面写真用。'demo-')は、同じ仕組みで入れて・消す。違いは kind に書く:
//   prefix        id の印。消す時は、id(または作った人の id)がこれで始まる行だけを消す
//   stateKey      Settings に足した分を覚えておくスクリプトプロパティ(消す時に、足した分だけを取り除く)
//   slots         ログインできる枠(TEST_ACCOUNTS の名前)と、その枠のメンバー
//   accountsProps ログインできるアカウントを読むスクリプトプロパティ(前にあるものから)
//   files         ダミー画像を作るか

function sampleKind_() {
  return {
    label: 'サンプルのデータ', icon: '🧪', prefix: SAMPLE_ID_PREFIX, stateKey: SAMPLE_SETTINGS_STATE_KEY, slots: SAMPLE_ACCOUNT_SLOTS,
    accountsProps: ['TEST_ACCOUNTS'], files: true, build: buildSampleData_, withRoles: sampleSettingsWithRoles_,
  }
}

function showcaseKind_() {
  return {
    label: '見本データ', icon: '🌱', prefix: SHOWCASE_ID_PREFIX, stateKey: SHOWCASE_SETTINGS_STATE_KEY, slots: SHOWCASE_ACCOUNT_SLOTS,
    accountsProps: ['DEMO_ACCOUNTS', 'TEST_ACCOUNTS'], files: false, build: buildShowcaseData_, withRoles: null,
  }
}

// 見本データは、テスト環境か、デモの団体(スクリプトプロパティ DEMO_ORG が true)だけで入れられる
function assertShowcaseAllowed_() {
  var demo = String(PropertiesService.getScriptProperties().getProperty('DEMO_ORG') || '').trim().toLowerCase() === 'true'
  if (!isTestEnvironment_() && !demo) {
    throw userError_('テスト環境かデモの団体ではないため実行できません。スクリプトプロパティ TEST_ENVIRONMENT か DEMO_ORG を true にしてから実行してください。')
  }
}

// サンプルのデータを作る(テスト環境専用)。既にサンプルがあれば、消してから作り直す
function seedSampleData() {
  assertSampleDataMatchesCode_()
  assertTestEnvironment_()
  return seedDataOfKind_(sampleKind_())
}

// サンプルのデータを消し、Settings を元に戻す(テスト環境専用)
function deleteSampleData() {
  assertSampleDataMatchesCode_()
  assertTestEnvironment_()
  return deleteDataOfKind_(sampleKind_())
}

// 見本データを作る(テスト環境・デモの団体)。既に見本があれば、消してから作り直す
function seedShowcaseData() {
  assertSampleDataMatchesCode_()
  assertShowcaseAllowed_()
  return seedDataOfKind_(showcaseKind_())
}

// 見本データを消し、Settings を元に戻す(テスト環境・デモの団体)
function deleteShowcaseData() {
  assertSampleDataMatchesCode_()
  assertShowcaseAllowed_()
  return deleteDataOfKind_(showcaseKind_())
}

function sampleAccountsOf_(kind) {
  var props = PropertiesService.getScriptProperties()
  for (var i = 0; i < kind.accountsProps.length; i++) {
    var raw = props.getProperty(kind.accountsProps[i])
    if (raw) return parseSampleTestAccounts_(raw, kind.slots)
  }
  return {}
}

function seedDataOfKind_(kind) {
  var props = PropertiesService.getScriptProperties()
  var accounts = sampleAccountsOf_(kind)
  var emailSheet = getMemberEmailsSheet_()
  var emailRows = emailSheet.getLastRow() > 1 ? emailSheet.getRange(2, 1, emailSheet.getLastRow() - 1, 2).getValues() : []
  assertSampleAccountsUnregistered_(accounts, emailRows, kind.prefix)

  if (getDiscordWebhookUrl_() || getSlackWebhookUrl_()) {
    console.warn('⚠ Discord・Slack の Webhook が設定されています。テスト環境では投稿せずログだけにします' +
      '(スクリプトプロパティ TEST_ALLOW_CHAT を true にすると、実際に投稿します)。')
  }

  return withSampleLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheetHeaders_(ss, name, SHEET_HEADERS[name]) })
    var removed = deleteSampleDataUnlocked_(kind)

    var files = kind.files ? createSampleFiles_() : {}
    var data = kind.build(todayStr_(), files)
    var counts = {}
    // 選択肢の値は、今のシートの形式(移行の前は日本語、後はコード)で書く
    data.sheets[SHEET_TASKS] = (data.sheets[SHEET_TASKS] || []).map(sheetSampleTaskRow_)
    Object.keys(data.sheets).forEach(function (name) { counts[name] = appendSampleRows_(name, data.sheets[name]) })

    // ログインできる枠のメンバーだけメールアドレスを登録する(ほかのメンバーには登録しない)
    Object.keys(accounts).forEach(function (slot) {
      appendRowByHeaders_(emailSheet, SHEET_MEMBER_EMAILS, { id: kind.slots[slot], email: accounts[slot] })
    })

    // 役職の設定(roles)を使っている団体では、サンプルの役職を roles に足す
    var settings = kind.withRoles && hasRolesSetting_() ? kind.withRoles(data.settings) : data.settings
    var merged = mergeSampleSettings_(readSettingsValues_(sampleSettingKeys_(settings)), settings, kind.prefix)
    Object.keys(merged.values).forEach(function (k) { updateSetting_(k, sheetSettingValue_(k, merged.values[k])) })
    props.setProperty(kind.stateKey, JSON.stringify(merged.state))

    bumpDataVersion()
    bumpMemberEmailsVersion_()
    var assigned = Object.keys(accounts).map(function (slot) { return slot + ' → ' + kind.slots[slot] + '(' + accounts[slot] + ')' })
    var msg = kind.icon + ' ' + kind.label + 'を作成しました(基準日: ' + todayStr_() + ')。' +
      Object.keys(counts).map(function (k) { return k + ' ' + counts[k] + ' 行' }).join('、') +
      (kind.files ? '、ダミー画像 ' + Object.keys(files).length + ' 件。' : '。') +
      (assigned.length ? ' ログインできるアカウント: ' + assigned.join('、') : ' ' + kind.accountsProps.join(' / ') + ' が未設定のため、ログインできるメンバーはいません。') +
      (removed.Tasks || removed.Members ? '(前回の分は削除してから作り直しました)' : '')
    console.log(msg)
    return msg
  })
}

function deleteDataOfKind_(kind) {
  return withSampleLock_(function () {
    var counts = deleteSampleDataUnlocked_(kind)
    bumpDataVersion()
    bumpMemberEmailsVersion_()
    var msg = '🧹 ' + kind.label + 'を削除しました: ' + Object.keys(counts).map(function (k) { return k + ' ' + counts[k] }).join('、') +
      '。Settings は足した分を取り除き、値が1つの設定は元の値に戻しました。'
    console.log(msg)
    return msg
  })
}
