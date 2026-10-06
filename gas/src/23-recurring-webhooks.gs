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

