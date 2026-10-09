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
  // ブラウザで URL を開いた人にも分かる文にする(getReceived・bounced の値は画面の判定に使うので変えない)
  return jsonOutput_({
    ok: false,
    getReceived: true,
    bounced: true,
    error: 'Ohsumi の GAS です。URL を確かめました。この画面は閉じてかまいません。' +
      '(画面からの通信でこの応答になった時は、GAS に GET で届きました。結果の受け渡しの途中で送り返されたか、POST の本文が転送の途中で失われたためで、何も処理していません。)',
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
      .addItem('招待リンクを表示', 'showInviteLinkFromMenu')
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
    ui.alert('Ohsumi', '初期設定が終わりました。\n\n次にやること(利用マニュアル 3.3〜3.5):\n' +
      '1. 「拡張機能」→「Apps Script」を開き、「デプロイ」→「新しいデプロイ」でウェブアプリとして公開して、URL をコピーする(3.3)\n' +
      '2. コピーした URL を、ブラウザで一度開く(3.4)。「Ohsumi の GAS です。URL を確かめました。」と出れば大丈夫です\n' +
      '3. このスプレッドシートを再読み込みし、「Ohsumi」→「レジストリに登録する…」で、FSIF から受け取った登録コードを入れる(3.5)', ui.ButtonSet.OK)
  } catch (e) {
    ui.alert('Ohsumi', '初期設定を最後まで実行できませんでした: ' + toErrorMessage_(e) +
      '\n\nもう一度「Ohsumi → 初期設定」を選んでください。続く時は、表示された内容を FSIF にお伝えください。', ui.ButtonSet.OK)
  }
}

function registerWithRegistryFromMenu() {
  var ui = SpreadsheetApp.getUi()
  // 送る前に、登録する接続先(この GAS の URL)を決める。OHSUMI_WEBAPP_URL も、ブラウザで開いた時に覚えた URL も
  // 無ければ止める(getService().getUrl() は、デプロイを管理の URL とは別の …/exec を返すことがあるため使わない)
  var gasUrl
  try {
    gasUrl = registrableWebAppUrl_(PropertiesService.getScriptProperties().getProperties())
  } catch (e) {
    ui.alert('登録できませんでした', toErrorMessage_(e), ui.ButtonSet.OK)
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
  var intro = '団体「' + out.displayName + '」をレジストリに' + (out.kind === 'reissue' ? '再登録' : '登録') + 'しました。'
  // 招待リンク(R1-d): メンバーは、初めての端末でこのリンクから開く。サイトの URL は、レジストリに確かめて受け取る(SITE_ORIGINS)
  var orgId = PropertiesService.getScriptProperties().getProperty('ORG_ID')
  var sections = [inviteLinkSection_('① 招待リンク', orgId)]
  if (out.setupCode) sections.push(setupCodeSection_('② 初期設定コード', out.setupCode, out.setupExpiresAt))
  sections.push({
    heading: out.setupCode ? '③ 次にやること' : '② 次にやること',
    notes: out.setupCode
      ? ['最初の代表になる人に、招待リンクと初期設定コードを伝えてください。',
         '最初の代表は、招待リンクを開き、ログイン画面の「初期設定コード」の欄にコードを入れてから、Google でログインします(利用マニュアル 3.6)。']
      : ['メンバーは、これまでどおりログインできます。'],
  })
  showMenuResultDialog_('登録しました', intro, sections)
}

// メニューの「招待リンクを表示」: 登録した後なら、いつでも招待リンクを出す(秘密の値は含まない)
function showInviteLinkFromMenu() {
  var ui = SpreadsheetApp.getUi()
  var props = PropertiesService.getScriptProperties()
  if (!props.getProperty('REGISTRY_SHARED_KEY')) {
    ui.alert('招待リンク', '先に「レジストリに登録する…」で登録してください。', ui.ButtonSet.OK)
    return
  }
  showMenuResultDialog_('招待リンク', '', [inviteLinkSection_('招待リンク', props.getProperty('ORG_ID'))])
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
  showMenuResultDialog_('初期設定コードを作り直しました', '前のコードは使えなくなりました。',
    [setupCodeSection_('初期設定コード', setup.code, setup.expiresAt)])
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

