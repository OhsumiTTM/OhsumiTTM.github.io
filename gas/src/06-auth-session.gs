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
  'getMailQuotaStatus', 'getGasUpdateStatus', 'getMyStorage',
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
  'revokeMemberSessions', 'restoreTask', 'purgeTask',
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

