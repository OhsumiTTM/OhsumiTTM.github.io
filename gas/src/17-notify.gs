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

