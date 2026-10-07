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

