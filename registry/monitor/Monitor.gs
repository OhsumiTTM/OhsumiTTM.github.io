// Ohsumi レジストリの監視(レジストリとは別の Google アカウントに置く Apps Script)
//
// 15分ごとにレジストリの health に問い合わせ、次の時にメールと Discord に知らせる。
//   - 2回続けて応答がない・応答がおかしい(止まった)。直ったら「復旧しました」と止まっていた時間
//   - 最後のバックアップから26時間を超えた
//   - 記録の無い直接の編集(Orgs)が見つかった
//   - 回数の上限で断ったリクエストが、1時間に REJECTED_ALERT 回を超えた(攻撃の疑い)
// それぞれ、起きた時に1回、解消した時に1回だけ知らせる。
// 毎朝1回、Discord に「監視は動いています」を送る(監視自身が止まったことに気付けるように)。
//
// スクリプトプロパティ(コードには書かない):
//   REGISTRY_URL         レジストリのウェブアプリの URL
//   HEALTH_KEY           レジストリの setupRegistry() が作った鍵
//   ALERT_EMAILS         知らせる先のメールアドレス(カンマ区切り)
//   DISCORD_WEBHOOK_URL  知らせる先の Discord の Webhook の URL
// 設定の手順は registry/README.md を参照。

var BACKUP_STALE_HOURS = 26
var REJECTED_ALERT = 1000
var MONITOR_STATE_KEY = 'MONITOR_STATE'

// ---- 判定(Google のサービスを使わない純粋な関数) ----

// health の応答(または通信の失敗)を、{ reachable, problems: { キー: 説明 } } にする
var KEY_MISMATCH_REASON = '鍵(HEALTH_KEY)が違います。監視の GAS のスクリプトプロパティ HEALTH_KEY を、レジストリの HEALTH_KEY と同じにしてください'

function evaluateHealth(res, now) {
  if (!res || !res.ok || !res.version) return { reachable: false, reason: res && res.error ? String(res.error) : '応答がありません', problems: {} }
  // レジストリは動いているが、鍵が合わず状態(バックアップなど)を受け取れない。
  // 状態を確かめられないので、応答が無い時と同じく2回続いたら知らせる
  if (res.keyValid === false) return { reachable: false, keyMismatch: true, reason: KEY_MISMATCH_REASON, problems: {} }
  var problems = {}
  if (!res.lastBackupAt) problems.backup = 'バックアップがまだ一度も作られていません'
  else {
    var hours = (now - Date.parse(res.lastBackupAt)) / 3600000
    if (!(hours <= BACKUP_STALE_HOURS)) problems.backup = '最後のバックアップから ' + Math.floor(hours) + ' 時間たっています'
  }
  if (Number(res.unrecordedEdits) > 0) problems.unrecorded = '記録の無い変更(スプレッドシートの直接の編集)が ' + Number(res.unrecordedEdits) + ' 団体にあります'
  if (Number(res.rejectedLastHour) > REJECTED_ALERT) problems.rejected = '回数の上限で断ったリクエストが、この1時間で ' + Number(res.rejectedLastHour) + ' 回あります(攻撃の疑い)'
  return { reachable: true, problems: problems }
}

function formatDuration(ms) {
  var min = Math.max(0, Math.round(ms / 60000))
  if (min < 60) return min + '分'
  return Math.floor(min / 60) + '時間' + (min % 60) + '分'
}

// 前の状態と今回の結果から、次の状態と知らせる文を決める
// state: { failures, firstFailureAt, down, downSince, keyMismatch(鍵が違って止まったか), problems: { キー: 説明 } }
function nextMonitorState(state, result, now) {
  state = state || { failures: 0, firstFailureAt: null, down: false, downSince: null, problems: {} }
  var next = { failures: state.failures, firstFailureAt: state.firstFailureAt, down: state.down, downSince: state.downSince, problems: state.problems || {} }
  var messages = []
  if (!result.reachable) {
    next.failures = state.failures + 1
    if (next.failures === 1) next.firstFailureAt = now
    if (next.failures >= 2 && !state.down) {
      next.down = true
      next.downSince = next.firstFailureAt
      next.keyMismatch = !!result.keyMismatch
      messages.push(result.keyMismatch
        ? '🔴 レジストリの状態を確かめられません(2回続けて。原因: ' + result.reason + ')'
        : '🔴 レジストリが応答しません(2回続けて失敗。原因: ' + result.reason + ')')
    } else if (state.down) {
      next.keyMismatch = state.keyMismatch
    }
    return { state: next, messages: messages }
  }
  if (state.down) {
    messages.push(state.keyMismatch
      ? '🟢 レジストリの状態を確かめられるようになりました(確かめられなかった時間: ' + formatDuration(now - state.downSince) + ')'
      : '🟢 レジストリが復旧しました(止まっていた時間: ' + formatDuration(now - state.downSince) + ')')
  }
  next.keyMismatch = false
  next.failures = 0
  next.firstFailureAt = null
  next.down = false
  next.downSince = null
  var problems = {}
  Object.keys(result.problems).forEach(function (k) {
    problems[k] = result.problems[k]
    if (!next.problems[k]) messages.push('🟠 ' + result.problems[k])
  })
  Object.keys(next.problems).forEach(function (k) {
    if (!result.problems[k]) messages.push('✅ 解消しました: ' + next.problems[k])
  })
  next.problems = problems
  return { state: next, messages: messages }
}

// ---- 実行 ----

function monitorProps() {
  return PropertiesService.getScriptProperties().getProperties() || {}
}

// レジストリの URL は、デプロイの「ウェブアプリの URL」そのもの(/macros/s/<ID>/exec)を使う。
// /u/1/ を含む URL や /dev の URL では、転送で POST の本文が失われる
var REGISTRY_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/

// JSON ではない応答の本文の先頭(タグを除き、鍵のような文字列は伏せる。JSON の断片は出さない)
function responseSnippet(text) {
  var t = String(text || '').trim()
  if (!t) return '(空)'
  if (/^[{[]/.test(t)) return '(JSON の途中で切れた可能性。' + t.length + '文字)'
  return t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[A-Za-z0-9_-]{32,}/g, '[伏せた値]').slice(0, 120)
}

function fetchHealth(props) {
  if (!REGISTRY_URL_PATTERN.test(String(props.REGISTRY_URL || ''))) {
    return { ok: false, error: 'REGISTRY_URL の形が正しくありません(デプロイの「ウェブアプリの URL」…/macros/s/…/exec をそのまま入れてください)' }
  }
  try {
    var res = UrlFetchApp.fetch(props.REGISTRY_URL, {
      method: 'post',
      contentType: 'text/plain;charset=utf-8',
      payload: JSON.stringify({ action: 'health', key: props.HEALTH_KEY }),
      muteHttpExceptions: true,
      followRedirects: true,
    })
    var text = res.getContentText()
    var json
    try { json = JSON.parse(text) } catch (e) { return { ok: false, error: 'JSON ではない応答(HTTP ' + res.getResponseCode() + '。本文の先頭: ' + responseSnippet(text) + ')' } }
    if (json && json.getReceived) return { ok: false, error: 'レジストリに GET で届きました(POST の本文が転送の途中で失われた)' }
    if (res.getResponseCode() !== 200) return { ok: false, error: 'HTTP ' + res.getResponseCode() }
    return json
  } catch (e) {
    return { ok: false, error: '通信エラー(' + (e && e.message ? e.message : e) + ')' }
  }
}

// 時間主導のトリガー(15分ごと)から呼ぶ
function checkRegistry() {
  var props = monitorProps()
  if (!props.REGISTRY_URL || !props.HEALTH_KEY) throw new Error('スクリプトプロパティ REGISTRY_URL と HEALTH_KEY を設定してください')
  var now = Date.now()
  var result = evaluateHealth(fetchHealth(props), now)
  var prev = null
  try { prev = props[MONITOR_STATE_KEY] ? JSON.parse(props[MONITOR_STATE_KEY]) : null } catch (e) { prev = null }
  var out = nextMonitorState(prev, result, now)
  PropertiesService.getScriptProperties().setProperty(MONITOR_STATE_KEY, JSON.stringify(out.state))
  if (out.messages.length) notifyAll(out.messages.join('\n'), props)
  return out
}

// 時間主導のトリガー(毎朝)から呼ぶ。Discord にだけ送る
function monitorHeartbeat() {
  var props = monitorProps()
  var state = null
  try { state = props[MONITOR_STATE_KEY] ? JSON.parse(props[MONITOR_STATE_KEY]) : null } catch (e) { state = null }
  var now = state && state.down ? '停止中' : '正常'
  postDiscord('監視は動いています(レジストリ: ' + now + ')', props)
}

function notifyAll(text, props) {
  var emails = String(props.ALERT_EMAILS || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
  if (emails.length) {
    try { MailApp.sendEmail(emails.join(','), '[Ohsumi レジストリ] ' + text.split('\n')[0], text) } catch (e) { console.error('メールを送れませんでした: ' + e) }
  }
  postDiscord(text, props)
}

function postDiscord(text, props) {
  if (!props.DISCORD_WEBHOOK_URL) return
  try {
    UrlFetchApp.fetch(props.DISCORD_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: '[Ohsumi レジストリ] ' + text }),
      muteHttpExceptions: true,
    })
  } catch (e) {
    console.error('Discord に送れませんでした: ' + e)
  }
}

// ---- 最初の設定(エディタから実行する) ----

// 15分ごとの確認と、毎朝の「動いています」のトリガーを作る。何度実行しても同じ結果になる。
// 最後に1回確認し、知らせる先に試しの通知を送る
function setupMonitor() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var name = t.getHandlerFunction()
    if (name === 'checkRegistry' || name === 'monitorHeartbeat') ScriptApp.deleteTrigger(t)
  })
  ScriptApp.newTrigger('checkRegistry').timeBased().everyMinutes(15).create()
  ScriptApp.newTrigger('monitorHeartbeat').timeBased().everyDays(1).atHour(8).create()
  var props = monitorProps()
  var result = evaluateHealth(fetchHealth(props), Date.now())
  notifyAll('監視を設定しました(今の状態: ' + (result.reachable ? '応答あり' : '応答なし(' + result.reason + ')') + ')', props)
  console.log('トリガーを作りました。メールと Discord に試しの通知を送りました')
}
