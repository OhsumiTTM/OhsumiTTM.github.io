// ---- 団体をまたいだスキルの引き継ぎ(v1.2) --------------------------------------------------
//
// 本人の共通スキル(COMMON_SKILL_NAMES)の実績(点数・レベル・資格)を、レジストリを通して別の団体に引き継ぐ。
// 名前・メールアドレス・評価・コメントは送らない。レジストリは中身を受け取られるまで(最長180日)だけ持つ。
//   送る: createSkillTransferCode(本人)。引き継ぎコードを画面に出し、本人の登録済みのアドレスにも送る。
//         管理者が退会させた時(removeMember_)は、その人の分を自動で作って本人に送る(退会した人はログインできないため)
//   受け取る: claimSkillTransferCode(本人)。新しい団体で、本人がコードを入れる
//   取り消す: cancelSkillTransferCode(本人。まだ受け取られていないコード)・removeTransferredSkills(本人・代表。受け取った分を出どころごとに消す)
// 受け取った分は Members の external_skills_json に、出どころ(最初に送った受け渡しの transferId)ごとに持ち、
// skill_points_json(合計)に足す。レベルの計算に入るが、「承認」の条件は満たさない(承認の記録は引き継がない)。
// 送る時は、その団体で得た分(合計 − 受け取った分)と、受け取った分をそのまま(carried)送る。
// 出どころの印(originKey)は、元の団体が本人ごとに団体の鍵で作る仮の印(だれかは分からない)で、レジストリが覚えて返す。
// 受け取る側は、同じ出どころの分が既にあれば、新しく書き出した方に置き換える(足し重ねない。A→B→C と A→C の両方で届いても1つ)
var COMMON_SKILL_NAMES = ['デザイン', 'Canva', 'PowerPoint', 'ライティング', 'リサーチ', 'SNS', '広報', 'コミュニケーション',
  'イベント運営', 'メール', 'UI/UX', '実装', '企画', '要件定義', 'プロダクト設計', '校閲', 'Claude', 'V0']
var SKILL_TRANSFER_LEDGER_MAX = 30
var SKILL_TRANSFER_LOG_MAX = 20
var SKILL_TRANSFER_UNAVAILABLE = 'この団体はレジストリに登録していないため、スキルの引き継ぎを使えません。'

function parseJsonCell_(v, fallback) {
  try { var x = JSON.parse(String(v || '')); return x === null || x === undefined ? fallback : x } catch (e) { return fallback }
}

function skillLedgerOf_(row) {
  var l = parseJsonCell_(row && row.external_skills_json, [])
  return Array.isArray(l) ? l.filter(function (e) { return e && e.transferId }) : []
}

// 本人の今の実績から、送る中身を作る(own: その団体で得た分 / carried: 前に受け取った分)
function buildSkillTransferRecord_(row) {
  var total = parseJsonCell_(row.skill_points_json, {})
  var ledger = skillLedgerOf_(row)
  var received = {}
  ledger.forEach(function (e) {
    Object.keys(e.points || {}).forEach(function (k) { received[k] = (received[k] || 0) + (Number(e.points[k]) || 0) })
  })
  var points = {}
  COMMON_SKILL_NAMES.forEach(function (k) {
    var own = Math.max(0, Math.floor((Number(total && total[k]) || 0) - (received[k] || 0)))
    if (own > 0) points[k] = own
  })
  var levels = (parseJsonCell_(row.skill_levels_json, []) || []).filter(function (l) {
    return l && COMMON_SKILL_NAMES.indexOf(String(l.skill)) >= 0 && [1, 2, 3, 4, 5].indexOf(Number(l.level)) >= 0
  }).map(function (l) { return { skill: String(l.skill), level: Number(l.level) } })
  var qualifications = (parseJsonCell_(row.qualifications_json, []) || []).filter(function (q) { return q && q.name && !q.transferId })
    .map(function (q) { return { name: String(q.name), acquiredDate: String(q.acquiredDate || ''), issuer: String(q.issuer || '') } })
  var carried = ledger.map(function (e) {
    return { transferId: String(e.transferId), points: e.points || {}, levels: e.levels || [], qualifications: e.qualifications || [] }
  })
  return { originKey: skillOriginKey_(row.id), own: { points: points, levels: levels, qualifications: qualifications }, carried: carried }
}

// 本人ごとの仮の印(団体の共有鍵とメンバーID から作る。レジストリやほかの団体には、だれかは分からない)
function skillOriginKey_(memberId) {
  var key = String(PropertiesService.getScriptProperties().getProperty('REGISTRY_SHARED_KEY') || '')
  return base64UrlEncode_(Utilities.computeHmacSha256Signature('skillOrigin.' + String(memberId), key)).slice(0, 32)
}

function skillTransferIsEmpty_(rec) {
  return !Object.keys(rec.own.points).length && !rec.own.levels.length && !rec.own.qualifications.length && !rec.carried.length
}

// レジストリに署名付きで送る。kind: create / claim / cancel。extra は署名に含める値
function skillTransferRegistry_(action, kind, extra, fields, deps) {
  deps = deps || {}
  var fetch = deps.fetch || function (url, options) { return UrlFetchApp.fetch(url, options) }
  var props = PropertiesService.getScriptProperties()
  var registryUrl = registryUrl_()
  var key = String(props.getProperty('REGISTRY_SHARED_KEY') || '')
  var orgId = String(props.getProperty('ORG_ID') || '')
  if (!REGISTRY_URL_PATTERN.test(registryUrl) || !key || !orgId) throw userError_(SKILL_TRANSFER_UNAVAILABLE)
  var ts = nowSec_()
  var sig = base64UrlEncode_(Utilities.computeHmacSha256Signature('skillTransfer.' + kind + '.' + orgId + '.' + ts + '.' + extra, key))
  var payload = { action: action, orgId: orgId, ts: ts, sig: sig }
  Object.keys(fields).forEach(function (k) { payload[k] = fields[k] })
  var res
  try {
    var r = fetch(registryUrl, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: true })
    res = JSON.parse(r.getContentText())
  } catch (e) {
    throw userError_('FSIF(レジストリ)につながりませんでした。少し待ってから、もう一度お試しください。')
  }
  if (!res || !res.ok || !res.result) throw userError_(String((res && res.error) || 'FSIF(レジストリ)が受け付けませんでした。').slice(0, 200))
  return res.result
}

function skillTransferMailText_(orgName, code, expiresAt, auto) {
  var until = String(expiresAt || '').slice(0, 10)
  return {
    subject: '[Ohsumi] ' + orgName + ': スキルの引き継ぎコード',
    body: (auto
      ? orgName + 'を退会したため、Ohsumi で積んだスキルの実績を、ほかの団体に引き継ぐためのコードを作りました。\n\n'
      : orgName + 'で、スキルの実績をほかの団体に引き継ぐためのコードを作りました。\n\n') +
      '引き継ぎコード: ' + code + '\n使える期限: ' + until + 'まで(1回だけ使えます)\n\n' +
      '新しい団体の Ohsumi で、自分のページの「経歴・キャリア」>「ほかの団体からの引き継ぎ」にこのコードを入れてください。\n' +
      '引き継ぐのは、共通スキルの点数・レベルと資格だけです(名前・メールアドレス・評価は送りません)。\n\n' +
      'このコードは、ほかの人に教えないでください。心当たりが無ければ、このメールは無視してください。',
  }
}

// コードを作る。opts.auto: 退会の時に自動で作る(実績が無ければ作らない・失敗しても退会は止めない)
function createSkillTransferCode_(memberId, opts, deps) {
  opts = opts || {}
  var row = findRow_(SHEET_MEMBERS, String(memberId || ''))
  if (!row) throw userError_('メンバーが見つかりません。')
  if (!String(PropertiesService.getScriptProperties().getProperty('REGISTRY_SHARED_KEY') || '')) throw userError_(SKILL_TRANSFER_UNAVAILABLE)
  var rec = buildSkillTransferRecord_(row)
  if (skillTransferIsEmpty_(rec)) {
    if (opts.auto) return null
    throw userError_('引き継げる実績(共通スキルの点数・レベル・資格)がまだありません。')
  }
  var text = JSON.stringify(rec)
  var res = skillTransferRegistry_('createSkillTransfer', 'create', text, { record: text }, deps)
  var log = parseJsonCell_(row.skill_transfers_json, [])
  if (!Array.isArray(log)) log = []
  log.unshift({ transferId: String(res.transferId), at: new Date().toISOString(), expiresAt: String(res.expiresAt), status: 'pending', auto: !!opts.auto })
  ensureMemberColumns_(['skill_transfers_json'])
  updateMemberFields_(memberId, { skill_transfers_json: JSON.stringify(log.slice(0, SKILL_TRANSFER_LOG_MAX)) })
  var mailed = false
  var emails = registeredEmailsOf_(memberId)
  if (emails.length) {
    var mail = skillTransferMailText_(getSettingValue_('org_name') || 'Ohsumi', String(res.code), res.expiresAt, !!opts.auto)
    mailed = sendMailChecked_({ to: emails.join(','), subject: mail.subject, body: mail.body }) === 'sent'
  }
  return { transferId: String(res.transferId), code: String(res.code), expiresAt: String(res.expiresAt), mailed: mailed }
}

function cancelSkillTransferCode_(memberId, transferId, deps) {
  var row = findRow_(SHEET_MEMBERS, String(memberId || ''))
  if (!row) throw userError_('メンバーが見つかりません。')
  var log = parseJsonCell_(row.skill_transfers_json, [])
  var hit = (Array.isArray(log) ? log : []).filter(function (e) { return e && e.transferId === String(transferId || '') })[0]
  if (!hit) throw userError_('その引き継ぎコードは見つかりません。')
  var res = skillTransferRegistry_('cancelSkillTransfer', 'cancel', String(transferId), { transferId: String(transferId) }, deps)
  hit.status = String(res.status || 'cancelled')
  updateMemberFields_(memberId, { skill_transfers_json: JSON.stringify(log) })
  return { transferId: String(transferId), status: hit.status }
}

// 受け取る。同じ受け渡し(transferId)の分は足さない。同じ出どころ(originKey)の分が既にあれば、新しく書き出した方に置き換える
function claimSkillTransferCode_(memberId, code, deps) {
  var input = String(code || '').trim()
  if (!input || input.length > 40) throw userError_('引き継ぎコードを入れてください。')
  var row = findRow_(SHEET_MEMBERS, String(memberId || ''))
  if (!row) throw userError_('メンバーが見つかりません。')
  var norm = input.toUpperCase().replace(/[\s\-_]/g, '')
  var res = skillTransferRegistry_('claimSkillTransfer', 'claim', norm, { code: input }, deps)
  var entries = Array.isArray(res.entries) ? res.entries : []
  var ledger = skillLedgerOf_(row)
  var have = {}
  ledger.forEach(function (e) { have[String(e.transferId)] = true })
  var points = parseJsonCell_(row.skill_points_json, {})
  if (!points || typeof points !== 'object' || Array.isArray(points)) points = {}
  var quals = parseJsonCell_(row.qualifications_json, [])
  if (!Array.isArray(quals)) quals = []
  var qualKeys = {}
  quals.forEach(function (q) { if (q) qualKeys[(q.name || '') + '|' + (q.acquiredDate || '')] = true })
  var added = []
  var skipped = 0
  var receivedAt = new Date().toISOString()
  // 置き換える古い分を外す(点数を引き、その分の資格を外す)
  var dropEntry = function (old) {
    Object.keys(old.points || {}).forEach(function (k) { points[k] = Math.max(0, (Number(points[k]) || 0) - (Number(old.points[k]) || 0)) })
    quals = quals.filter(function (q) { return !(q && q.transferId === old.transferId) })
    qualKeys = {}
    quals.forEach(function (q) { if (q) qualKeys[(q.name || '') + '|' + (q.acquiredDate || '')] = true })
    ledger = ledger.filter(function (x) { return x !== old })
  }
  entries.forEach(function (e) {
    var id = String((e && e.transferId) || '')
    if (!id || have[id]) { skipped++; return }
    var originKey = String(e.originKey || '')
    var same = originKey ? ledger.filter(function (x) { return x.originKey === originKey })[0] : null
    if (same) {
      if (String(e.exportedAt || '') <= String(same.exportedAt || '')) { skipped++; return }
      dropEntry(same)
    }
    have[id] = true
    var p = {}
    Object.keys(e.points || {}).forEach(function (k) {
      var v = Number(e.points[k])
      if (COMMON_SKILL_NAMES.indexOf(k) < 0 || !isFinite(v) || v <= 0 || Math.floor(v) !== v) return
      p[k] = v
      points[k] = (Number(points[k]) || 0) + v
    })
    var qs = (Array.isArray(e.qualifications) ? e.qualifications : []).filter(function (q) { return q && q.name })
    qs.forEach(function (q) {
      var k = q.name + '|' + (q.acquiredDate || '')
      if (qualKeys[k]) return
      qualKeys[k] = true
      quals.push({ id: 'q-' + Utilities.getUuid().slice(0, 8), name: String(q.name), acquiredDate: q.acquiredDate || undefined, issuer: q.issuer || undefined, transferId: id })
    })
    var entry = { transferId: id, originKey: originKey, originOrgName: String(e.originOrgName || ''), via: String(e.via || ''), exportedAt: String(e.exportedAt || ''),
      receivedAt: receivedAt, points: p, levels: Array.isArray(e.levels) ? e.levels : [], qualifications: qs }
    ledger.push(entry)
    added.push(entry)
  })
  if (!added.length) return { added: [], skipped: skipped }
  if (ledger.length > SKILL_TRANSFER_LEDGER_MAX) throw userError_('ほかの団体から引き継いだ実績が多すぎます(' + SKILL_TRANSFER_LEDGER_MAX + '件まで)。いらない分を消してから受け取ってください。')
  // 受け取った点数もレベルの計算に入れる(下げない。承認の記録は引き継がないので、「承認」の条件は満たさない)
  var evidence = skillEvidenceOf_(row, memberId)
  evidence.qualifications = quals
  var levels = computeAutoLevels_(parseJsonCell_(row.skill_levels_json, []) || [], points, getSkillLevelRules_(), evidence)
  ensureMemberColumns_(['external_skills_json'])
  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(points),
    skill_levels_json: JSON.stringify(levels),
    qualifications_json: JSON.stringify(quals),
    external_skills_json: JSON.stringify(ledger),
  })
  return { added: added.map(function (e) { return { transferId: e.transferId, originOrgName: e.originOrgName, via: e.via } }), skipped: skipped }
}

// 受け取った分を出どころごとに消す(点数を引き、その出どころの資格を外す。レベルは下げない)
function removeTransferredSkills_(memberId, transferId) {
  var row = findRow_(SHEET_MEMBERS, String(memberId || ''))
  if (!row) throw userError_('メンバーが見つかりません。')
  var ledger = skillLedgerOf_(row)
  var hit = ledger.filter(function (e) { return String(e.transferId) === String(transferId || '') })[0]
  if (!hit) throw userError_('その引き継いだ実績は見つかりません。')
  var points = parseJsonCell_(row.skill_points_json, {})
  if (!points || typeof points !== 'object' || Array.isArray(points)) points = {}
  Object.keys(hit.points || {}).forEach(function (k) {
    points[k] = Math.max(0, (Number(points[k]) || 0) - (Number(hit.points[k]) || 0))
  })
  var quals = (parseJsonCell_(row.qualifications_json, []) || []).filter(function (q) { return !(q && q.transferId === hit.transferId) })
  updateMemberFields_(memberId, {
    skill_points_json: JSON.stringify(points),
    qualifications_json: JSON.stringify(quals),
    external_skills_json: JSON.stringify(ledger.filter(function (e) { return e !== hit })),
  })
  return { removed: String(hit.transferId) }
}
