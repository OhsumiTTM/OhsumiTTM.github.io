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

