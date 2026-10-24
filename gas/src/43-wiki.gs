// ---- ナレッジのページ(手順書・Wiki。v1.2) --------------------------------------------------
//
// 1ページ1行で WikiPages に持つ(本文は Markdown。WIKI_BODY_MAX 文字まで)。前の版は WikiRevisions に1ページ WIKI_REVISIONS_KEEP 版まで残す。
// 直す・作る時は、ページを見られる人なら誰でも「提案」できる(WikiProposals)。提案は、ナレッジの管理の権限(capability: knowledge)を
// 持つ人が承認すると反映する。管理の権限を持つ人が自分で直す時は、提案を経ずにすぐ反映する。
// 提案の後にほかの人がページを直していたら(版が違う)、承認せずに断る(上書きしない。提案した人に出し直してもらう)。
// ページごとの公開範囲(audience_json): { kind: 'all' | 'leaders' | 'projects' | 'departments', ids: [...] }
//   all          ログインしている全員
//   leaders      管理者の役職の人(代表を含む)
//   projects     そのプロジェクト(子プロジェクトも)に入っている人・責任者
//   departments  その部署(下の部署も)の人
// 管理の権限を持つ人・最上位の役職の人は、すべてのページを見られる(承認するため)。判定は、この GAS が読み取りの時に行う。
// フォルダは '>' でつないだ階層(folder 列。WIKI_FOLDER_DEPTH 段まで)。画像は wiki_image_ で始まる名前でアップロード用フォルダに置き、
// 本文には ![説明](wiki:<ファイルID>) と書く。画像は、そのファイルIDを本文に含むページを見られる人(と、自分の提案・管理の権限を持つ人)だけが読める
var SHEET_WIKI_PAGES = 'WikiPages'
var SHEET_WIKI_REVISIONS = 'WikiRevisions'
var SHEET_WIKI_PROPOSALS = 'WikiProposals'
var WIKI_PAGES_HEADERS = ['id', 'folder', 'title', 'body', 'tags', 'audience_json', 'version', 'created_by', 'created_at', 'updated_by', 'updated_at', 'deleted_at']
var WIKI_REVISIONS_HEADERS = ['id', 'page_id', 'version', 'folder', 'title', 'body', 'tags', 'audience_json', 'by_id', 'approved_by', 'at']
var WIKI_PROPOSALS_HEADERS = ['id', 'page_id', 'base_version', 'folder', 'title', 'body', 'tags', 'audience_json', 'by_id', 'at', 'status', 'decided_by', 'decided_at', 'reason']
var WIKI_TITLE_MAX = 120
var WIKI_BODY_MAX = 45000
var WIKI_FOLDER_DEPTH = 5
var WIKI_FOLDER_PART_MAX = 40
var WIKI_TAGS_MAX = 10
var WIKI_TAG_MAX = 30
var WIKI_AUDIENCE_IDS_MAX = 50
var WIKI_REVISIONS_KEEP = 20
var WIKI_PENDING_PER_MEMBER = 20
var WIKI_REASON_MAX = 500
var WIKI_SEARCH_MAX = 50
var WIKI_AUDIENCE_KINDS = ['all', 'leaders', 'projects', 'departments']
var WIKI_IMAGE_REF = /wiki:([A-Za-z0-9_-]{10,200})/g
var WIKI_CONFLICT_MESSAGE = '提案の後に、ほかの人がこのページを直しました。今のページを読み込み直して、もう一度提案してください。'

// ---- シート ----

function wikiSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  ensureSheetHeaders_(ss, name, headers)
  return ss.getSheetByName(name)
}

// シートの行をオブジェクトの一覧にする(行番号 _row を付ける)。シートが無ければ空
function wikiRows_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)
  if (!sheet || sheet.getLastRow() < 2) return []
  var values = sheet.getDataRange().getValues()
  var headers = (values[0] || []).map(function (h) { return String(h).trim() })
  var out = []
  for (var r = 1; r < values.length; r++) {
    var obj = { _row: r + 1 }
    headers.forEach(function (h, c) { if (h) obj[h] = values[r][c] })
    if (String(obj.id || '') !== '') out.push(obj)
  }
  return out
}

function wikiAppend_(name, headers, obj) {
  appendRowByHeaders_(wikiSheet_(name, headers), name, obj)
}

function wikiUpdate_(name, headers, rowNumber, fields) {
  var sheet = wikiSheet_(name, headers)
  var cols = headerRow_(sheet)
  Object.keys(fields).forEach(function (k) {
    var c = cols.indexOf(k)
    if (c < 0) return
    assertCellLength_(name, k, fields[k], '')
    sheet.getRange(rowNumber, c + 1).setValue(fields[k])
  })
}

// ---- 値の確かめ ----

function wikiCleanFolder_(v) {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v !== 'string') throw userError_('フォルダの形が正しくありません。')
  var parts = v.split('>').map(function (p) { return p.trim() }).filter(Boolean)
  if (parts.length > WIKI_FOLDER_DEPTH) throw userError_('フォルダは' + WIKI_FOLDER_DEPTH + '段までにしてください。')
  parts.forEach(function (p) {
    if (p.length > WIKI_FOLDER_PART_MAX) throw userError_('フォルダの名前は' + WIKI_FOLDER_PART_MAX + '文字までにしてください。')
  })
  return parts.join(' > ')
}

function wikiCleanTags_(v) {
  if (v === undefined || v === null) return ''
  if (!Array.isArray(v)) throw userError_('タグの形が正しくありません。')
  var seen = {}
  var out = []
  v.forEach(function (t) {
    if (typeof t !== 'string') throw userError_('タグの形が正しくありません。')
    var s = t.trim().replace(/,/g, '')
    if (!s) return
    if (s.length > WIKI_TAG_MAX) throw userError_('タグは' + WIKI_TAG_MAX + '文字までにしてください。')
    if (seen[s]) return
    seen[s] = true
    out.push(s)
  })
  if (out.length > WIKI_TAGS_MAX) throw userError_('タグは' + WIKI_TAGS_MAX + '個までにしてください。')
  return out.join(',')
}

function wikiCleanAudience_(v) {
  if (v === undefined || v === null) return JSON.stringify({ kind: 'all', ids: [] })
  if (!isPlainObject_(v) || WIKI_AUDIENCE_KINDS.indexOf(v.kind) < 0) throw userError_('公開範囲の形が正しくありません。')
  var ids = v.ids === undefined ? [] : v.ids
  if (!Array.isArray(ids) || ids.length > WIKI_AUDIENCE_IDS_MAX) throw userError_('公開範囲の形が正しくありません。')
  ids = ids.map(function (x) {
    if (typeof x !== 'string' || !x.trim() || x.length > 200) throw userError_('公開範囲の形が正しくありません。')
    return x.trim()
  })
  if ((v.kind === 'projects' || v.kind === 'departments') && !ids.length) throw userError_('公開するプロジェクト・部署を選んでください。')
  return JSON.stringify({ kind: v.kind, ids: v.kind === 'all' || v.kind === 'leaders' ? [] : ids })
}

function wikiParseAudience_(raw) {
  var a = null
  try { a = JSON.parse(String(raw || '')) } catch (e) { a = null }
  if (!a || WIKI_AUDIENCE_KINDS.indexOf(a.kind) < 0) return { kind: 'all', ids: [] }
  return { kind: a.kind, ids: Array.isArray(a.ids) ? a.ids.map(String) : [] }
}

function wikiCleanContent_(input) {
  if (!isPlainObject_(input)) throw userError_('ページの形が正しくありません。')
  var title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw userError_('タイトルを入れてください。')
  if (title.length > WIKI_TITLE_MAX) throw userError_('タイトルは' + WIKI_TITLE_MAX + '文字までにしてください。')
  var body = input.body === undefined || input.body === null ? '' : input.body
  if (typeof body !== 'string') throw userError_('本文の形が正しくありません。')
  if (body.length > WIKI_BODY_MAX) throw userError_('本文は' + WIKI_BODY_MAX + '文字までにしてください(長い時は、ページを分けてください)。')
  return {
    title: title,
    body: body,
    folder: wikiCleanFolder_(input.folder),
    tags: wikiCleanTags_(input.tags),
    audience_json: wikiCleanAudience_(input.audience),
  }
}

// ---- 見られる人 ----

// 閲覧者の情報(スナップショットから。所属の部署・入っているプロジェクト・管理の権限)
function wikiViewer_(acting) {
  var data = { Members: snapshotTableOrSheet_(SHEET_MEMBERS), Projects: snapshotTableOrSheet_(SHEET_PROJECTS), Settings: snapshotTableOrSheet_(SHEET_SETTINGS) }
  var roles = getRoles_()
  var row = findMemberInSnapshot_(data, String(acting.id)) || {}
  var overrides = []
  try { overrides = JSON.parse(String(row.permission_overrides_json || '[]')) } catch (e) { overrides = [] }
  var caps = memberCapabilities_(roles, acting.role, overrides)
  var projectIds = {}
  var p = data.Projects || { headers: [], rows: [] }
  var ph = p.headers || []
  var pid = ph.indexOf('id'), pmem = ph.indexOf('member_ids'), pown = ph.indexOf('owner_id'), ppar = ph.indexOf('parent_id')
  var parentOf = {}
  ;(p.rows || []).forEach(function (r) {
    var id = String(r[pid] || '')
    if (!id) return
    parentOf[id] = ppar >= 0 ? String(r[ppar] || '') : ''
    var members = pmem >= 0 ? splitCsvList_(r[pmem]) : []
    if (members.indexOf(String(acting.id)) >= 0 || (pown >= 0 && String(r[pown] || '') === String(acting.id))) projectIds[id] = true
  })
  return {
    id: String(acting.id),
    top: isTopRoleRef_(roles, acting.role),
    leader: isAdminRoleRef_(roles, acting.role),
    manager: isTopRoleRef_(roles, acting.role) || caps.indexOf('knowledge') >= 0,
    projectIds: projectIds,
    parentOf: parentOf,
    departments: String(row.department_path || '').split(',').map(departmentPathParts_).filter(function (x) { return x.length }),
  }
}

// プロジェクトの公開: 選んだプロジェクト(か、その子プロジェクト)に入っていれば見られる
function wikiInProject_(viewer, projectId) {
  var target = String(projectId)
  return Object.keys(viewer.projectIds).some(function (id) {
    var cur = id
    for (var hop = 0; cur && hop < 20; hop++) {
      if (cur === target) return true
      cur = viewer.parentOf[cur] || ''
    }
    return false
  })
}

function wikiCanView_(viewer, audienceRaw) {
  if (viewer.manager) return true
  var a = wikiParseAudience_(audienceRaw)
  if (a.kind === 'all') return true
  if (a.kind === 'leaders') return viewer.leader
  if (a.kind === 'projects') return a.ids.some(function (id) { return wikiInProject_(viewer, id) })
  return a.ids.some(function (path) {
    var head = departmentPathParts_(path)
    return head.length && viewer.departments.some(function (mine) {
      if (mine.length < head.length) return false
      for (var i = 0; i < head.length; i++) if (mine[i] !== head[i]) return false
      return true
    })
  })
}

function wikiLivePages_() {
  return wikiRows_(SHEET_WIKI_PAGES).filter(function (p) { return String(p.deleted_at || '') === '' })
}

function wikiPageSummary_(p, viewer) {
  var out = {
    id: String(p.id), folder: String(p.folder || ''), title: String(p.title || ''),
    tags: splitCsvList_(p.tags), version: Number(p.version) || 1,
    updatedAt: isoOrEmpty_(p.updated_at), updatedBy: String(p.updated_by || ''),
  }
  // 公開範囲は、管理の権限を持つ人にだけ返す(ほかの人は、見られるページだけが届く)
  if (viewer.manager) out.audience = wikiParseAudience_(p.audience_json)
  return out
}

function isoOrEmpty_(v) {
  if (!v) return ''
  var d = v instanceof Date ? v : new Date(String(v))
  return isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function wikiProposalSummary_(q) {
  return {
    id: String(q.id), pageId: String(q.page_id || ''), baseVersion: Number(q.base_version) || 0, title: String(q.title || ''),
    folder: String(q.folder || ''), byId: String(q.by_id || ''), at: isoOrEmpty_(q.at), status: String(q.status || ''),
    decidedBy: String(q.decided_by || ''), decidedAt: isoOrEmpty_(q.decided_at), reason: String(q.reason || ''),
  }
}

// ---- 読み取り ----

// ページの一覧(見られるページだけ。本文は返さない)・自分の提案・承認待ち(管理の権限を持つ人だけ)
function listWikiPages_(acting) {
  var viewer = wikiViewer_(acting)
  var pages = wikiLivePages_().filter(function (p) { return wikiCanView_(viewer, p.audience_json) })
  var proposals = wikiRows_(SHEET_WIKI_PROPOSALS)
  var mine = proposals.filter(function (q) { return String(q.by_id) === viewer.id })
    .map(wikiProposalSummary_).sort(function (a, b) { return b.at.localeCompare(a.at) }).slice(0, 50)
  var out = { pages: pages.map(function (p) { return wikiPageSummary_(p, viewer) }), myProposals: mine, manager: viewer.manager }
  if (viewer.manager) out.pending = proposals.filter(function (q) { return String(q.status) === 'pending' }).map(wikiProposalSummary_)
  return out
}

function wikiFindPage_(pageId) {
  var id = String(pageId || '')
  var hit = wikiLivePages_().filter(function (p) { return String(p.id) === id })[0]
  return hit || null
}

// 1ページ(本文と、前の版の一覧)
function getWikiPage_(acting, pageId) {
  var viewer = wikiViewer_(acting)
  var p = wikiFindPage_(pageId)
  if (!p || !wikiCanView_(viewer, p.audience_json)) throw userError_('このページは見つからないか、見る権限がありません。')
  var out = wikiPageSummary_(p, viewer)
  out.body = String(p.body || '')
  out.createdBy = String(p.created_by || '')
  out.createdAt = isoOrEmpty_(p.created_at)
  out.audience = wikiParseAudience_(p.audience_json)
  out.revisions = wikiRows_(SHEET_WIKI_REVISIONS).filter(function (r) { return String(r.page_id) === String(p.id) })
    .map(function (r) { return { version: Number(r.version) || 0, byId: String(r.by_id || ''), approvedBy: String(r.approved_by || ''), at: isoOrEmpty_(r.at) } })
    .sort(function (a, b) { return b.version - a.version })
  return out
}

// 前の版(ページを今見られる人だけ)
function getWikiRevision_(acting, pageId, version) {
  var viewer = wikiViewer_(acting)
  var p = wikiFindPage_(pageId)
  if (!p || !wikiCanView_(viewer, p.audience_json)) throw userError_('このページは見つからないか、見る権限がありません。')
  var r = wikiRows_(SHEET_WIKI_REVISIONS).filter(function (x) { return String(x.page_id) === String(p.id) && Number(x.version) === Number(version) })[0]
  if (!r) throw userError_('その版は見つかりません(古い版は' + WIKI_REVISIONS_KEEP + '版まで残します)。')
  return { pageId: String(p.id), version: Number(r.version), title: String(r.title || ''), folder: String(r.folder || ''), body: String(r.body || ''),
    tags: splitCsvList_(r.tags), byId: String(r.by_id || ''), approvedBy: String(r.approved_by || ''), at: isoOrEmpty_(r.at) }
}

// 提案(出した人と、管理の権限を持つ人だけ)。比べるために、今のページの本文も返す
function getWikiProposal_(acting, proposalId) {
  var viewer = wikiViewer_(acting)
  var q = wikiRows_(SHEET_WIKI_PROPOSALS).filter(function (x) { return String(x.id) === String(proposalId || '') })[0]
  if (!q || (!viewer.manager && String(q.by_id) !== viewer.id)) throw userError_('この提案は見つからないか、見る権限がありません。')
  var out = wikiProposalSummary_(q)
  out.body = String(q.body || '')
  out.tags = splitCsvList_(q.tags)
  out.audience = wikiParseAudience_(q.audience_json)
  var p = out.pageId ? wikiFindPage_(out.pageId) : null
  if (p && wikiCanView_(viewer, p.audience_json)) {
    out.current = { title: String(p.title || ''), folder: String(p.folder || ''), body: String(p.body || ''), version: Number(p.version) || 1,
      tags: splitCsvList_(p.tags), audience: wikiParseAudience_(p.audience_json) }
  }
  return out
}

// タイトル・本文・タグ・フォルダで探す(見られるページだけ。大文字と小文字は区別しない)
function searchWiki_(acting, query) {
  var q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return { results: [] }
  if (q.length > 100) throw userError_('探す言葉は100文字までにしてください。')
  var viewer = wikiViewer_(acting)
  var words = q.split(/\s+/).filter(Boolean)
  var results = []
  wikiLivePages_().forEach(function (p) {
    if (results.length >= WIKI_SEARCH_MAX || !wikiCanView_(viewer, p.audience_json)) return
    var title = String(p.title || '')
    var body = String(p.body || '')
    var hay = (title + '\n' + body + '\n' + String(p.tags || '') + '\n' + String(p.folder || '')).toLowerCase()
    if (!words.every(function (w) { return hay.indexOf(w) >= 0 })) return
    var at = body.toLowerCase().indexOf(words[0])
    var snippet = at >= 0 ? body.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ') : body.slice(0, 120).replace(/\s+/g, ' ')
    results.push({ id: String(p.id), title: title, folder: String(p.folder || ''), snippet: snippet, titleHit: title.toLowerCase().indexOf(words[0]) >= 0 })
  })
  results.sort(function (a, b) { return (b.titleHit ? 1 : 0) - (a.titleHit ? 1 : 0) })
  return { results: results }
}

// ---- 書き込み ----

// 反映する(新しいページは作る。今のページは前の版を残して直す)。base はページの今の版(新しいページは 0)
function wikiApply_(pageId, content, authorId, approverId, nowIso) {
  if (!pageId) {
    var id = 'wp-' + Utilities.getUuid().slice(0, 8)
    wikiAppend_(SHEET_WIKI_PAGES, WIKI_PAGES_HEADERS, {
      id: id, folder: content.folder, title: content.title, body: content.body, tags: content.tags, audience_json: content.audience_json,
      version: 1, created_by: authorId, created_at: nowIso, updated_by: authorId, updated_at: nowIso, deleted_at: '',
    })
    return { id: id, version: 1 }
  }
  var p = wikiFindPage_(pageId)
  if (!p) throw userError_('このページは見つかりません(消された可能性があります)。')
  var version = Number(p.version) || 1
  wikiAppend_(SHEET_WIKI_REVISIONS, WIKI_REVISIONS_HEADERS, {
    id: 'wr-' + Utilities.getUuid().slice(0, 8), page_id: String(p.id), version: version, folder: String(p.folder || ''), title: String(p.title || ''),
    body: String(p.body || ''), tags: String(p.tags || ''), audience_json: String(p.audience_json || ''), by_id: String(p.updated_by || ''),
    approved_by: '', at: isoOrEmpty_(p.updated_at) || nowIso,
  })
  wikiTrimRevisions_(String(p.id))
  wikiUpdate_(SHEET_WIKI_PAGES, WIKI_PAGES_HEADERS, p._row, {
    folder: content.folder, title: content.title, body: content.body, tags: content.tags, audience_json: content.audience_json,
    version: version + 1, updated_by: authorId, updated_at: nowIso,
  })
  return { id: String(p.id), version: version + 1, approvedBy: approverId }
}

// 前の版は1ページ WIKI_REVISIONS_KEEP 版まで(古いものから消す。行番号の大きい方から消す)
function wikiTrimRevisions_(pageId) {
  var rows = wikiRows_(SHEET_WIKI_REVISIONS).filter(function (r) { return String(r.page_id) === pageId })
  if (rows.length <= WIKI_REVISIONS_KEEP) return
  rows.sort(function (a, b) { return (Number(a.version) || 0) - (Number(b.version) || 0) })
  var drop = rows.slice(0, rows.length - WIKI_REVISIONS_KEEP).map(function (r) { return r._row }).sort(function (a, b) { return b - a })
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_WIKI_REVISIONS)
  drop.forEach(function (rowNumber) { sheet.deleteRow(rowNumber) })
}

// 提案する(管理の権限を持つ人は、すぐ反映する)。input: { pageId?, baseVersion, title, folder, tags, audience, body }
function proposeWikiEdit_(acting, input) {
  var viewer = wikiViewer_(acting)
  var content = wikiCleanContent_(input)
  var pageId = String((input && input.pageId) || '')
  var baseVersion = 0
  if (pageId) {
    var p = wikiFindPage_(pageId)
    if (!p || !wikiCanView_(viewer, p.audience_json)) throw userError_('このページは見つからないか、見る権限がありません。')
    baseVersion = Number(input.baseVersion)
    if (!(baseVersion >= 1) || Math.floor(baseVersion) !== baseVersion) throw userError_('ページの版の形が正しくありません。')
    if (baseVersion !== (Number(p.version) || 1)) throw userError_('ほかの人が先にこのページを直しました。今のページを読み込み直して、もう一度直してください。')
  }
  var nowIso = new Date().toISOString()
  if (viewer.manager) {
    var applied = wikiApply_(pageId, content, viewer.id, viewer.id, nowIso)
    return { applied: true, pageId: applied.id, version: applied.version }
  }
  var pending = wikiRows_(SHEET_WIKI_PROPOSALS).filter(function (q) { return String(q.by_id) === viewer.id && String(q.status) === 'pending' })
  if (pending.length >= WIKI_PENDING_PER_MEMBER) throw userError_('承認待ちの提案は' + WIKI_PENDING_PER_MEMBER + '件までです。承認を待つか、取り下げてから出してください。')
  var id = 'wq-' + Utilities.getUuid().slice(0, 8)
  wikiAppend_(SHEET_WIKI_PROPOSALS, WIKI_PROPOSALS_HEADERS, {
    id: id, page_id: pageId, base_version: baseVersion, folder: content.folder, title: content.title, body: content.body,
    tags: content.tags, audience_json: content.audience_json, by_id: viewer.id, at: nowIso, status: 'pending',
    decided_by: '', decided_at: '', reason: '',
  })
  wikiNotifyManagers_(acting, content.title, !pageId)
  return { applied: false, proposalId: id }
}

// 承認・却下(管理の権限を持つ人)。承認の時、提案の後にページが直されていたら断る(上書きしない)
function decideWikiProposal_(acting, proposalId, approve, reason) {
  var viewer = wikiViewer_(acting)
  if (!viewer.manager) throw userError_(capabilityDeniedMessage_('knowledge'))
  reason = typeof reason === 'string' ? reason.trim() : ''
  if (reason.length > WIKI_REASON_MAX) throw userError_('理由は' + WIKI_REASON_MAX + '文字までにしてください。')
  var q = wikiRows_(SHEET_WIKI_PROPOSALS).filter(function (x) { return String(x.id) === String(proposalId || '') })[0]
  if (!q) throw userError_('この提案は見つかりません。')
  if (String(q.status) !== 'pending') throw userError_('この提案は、もう承認・却下・取り下げされています。')
  var nowIso = new Date().toISOString()
  var result = { approved: !!approve }
  if (approve) {
    var pageId = String(q.page_id || '')
    if (pageId) {
      var p = wikiFindPage_(pageId)
      if (!p) throw userError_('このページは消されています。提案を却下してください。')
      if ((Number(p.version) || 1) !== Number(q.base_version)) throw userError_(WIKI_CONFLICT_MESSAGE)
    }
    var content = { title: String(q.title || ''), body: String(q.body || ''), folder: String(q.folder || ''), tags: String(q.tags || ''), audience_json: String(q.audience_json || '') }
    var applied = wikiApply_(pageId, content, String(q.by_id || ''), viewer.id, nowIso)
    result.pageId = applied.id
    result.version = applied.version
  }
  wikiUpdate_(SHEET_WIKI_PROPOSALS, WIKI_PROPOSALS_HEADERS, q._row, { status: approve ? 'approved' : 'rejected', decided_by: viewer.id, decided_at: nowIso, reason: reason })
  wikiNotifyProposer_(String(q.by_id || ''), String(q.title || ''), !!approve, reason)
  return result
}

// 自分の提案を取り下げる(承認待ちのものだけ)
function withdrawWikiProposal_(acting, proposalId) {
  var q = wikiRows_(SHEET_WIKI_PROPOSALS).filter(function (x) { return String(x.id) === String(proposalId || '') })[0]
  if (!q || String(q.by_id) !== String(acting.id)) throw userError_('この提案は見つからないか、取り下げる権限がありません。')
  if (String(q.status) !== 'pending') throw userError_('この提案は、もう承認・却下・取り下げされています。')
  wikiUpdate_(SHEET_WIKI_PROPOSALS, WIKI_PROPOSALS_HEADERS, q._row, { status: 'withdrawn', decided_by: String(acting.id), decided_at: new Date().toISOString() })
  return { ok: true }
}

// ページを消す(管理の権限を持つ人。行は残して印を付ける。一覧・検索・読み取りに出さない)
function deleteWikiPage_(acting, pageId) {
  var viewer = wikiViewer_(acting)
  if (!viewer.manager) throw userError_(capabilityDeniedMessage_('knowledge'))
  var p = wikiFindPage_(pageId)
  if (!p) throw userError_('このページは見つかりません。')
  wikiUpdate_(SHEET_WIKI_PAGES, WIKI_PAGES_HEADERS, p._row, { deleted_at: new Date().toISOString(), updated_by: viewer.id })
  return { ok: true }
}

// 画像を置く(ページを直す・提案する人。名前は wiki_image_ で始める)。本文に書く ID を返す
function uploadWikiImage_(dataUrl, filename) {
  var img = parseImageDataUrl_(dataUrl)
  var folder = getUploadFolder_()
  var file = folder.createFile(Utilities.newBlob(img.bytes, img.mimeType, String(filename || 'image').slice(0, 100)))
  file.setName('wiki_image_' + Date.now())
  applyUploadSharing_(file)
  return { fileId: file.getId() }
}

// この人が読める画像のファイルID(見られるページの本文・自分の提案の本文に書かれたもの。管理の権限を持つ人は、すべての提案も)
function wikiImageIdsFor_(acting) {
  var viewer = wikiViewer_(acting)
  var ids = {}
  var collect = function (text) {
    var m
    var re = new RegExp(WIKI_IMAGE_REF.source, 'g')
    while ((m = re.exec(String(text || '')))) ids[m[1]] = true
  }
  wikiLivePages_().forEach(function (p) { if (wikiCanView_(viewer, p.audience_json)) collect(p.body) })
  wikiRows_(SHEET_WIKI_PROPOSALS).forEach(function (q) { if (viewer.manager || String(q.by_id) === viewer.id) collect(q.body) })
  // 前の版の画像も、ページを見られる人は読める
  var visible = {}
  wikiLivePages_().forEach(function (p) { if (wikiCanView_(viewer, p.audience_json)) visible[String(p.id)] = true })
  wikiRows_(SHEET_WIKI_REVISIONS).forEach(function (r) { if (visible[String(r.page_id)]) collect(r.body) })
  return ids
}

// ---- 知らせ ----

// 管理の権限を持つ人(最上位の役職を含む)のメンバーID
function wikiManagerIds_() {
  var data = { Members: snapshotTableOrSheet_(SHEET_MEMBERS) }
  var roles = getRoles_()
  var m = data.Members
  var h = m.headers || []
  var idCol = h.indexOf('id'), roleCol = h.indexOf('role'), ovCol = h.indexOf('permission_overrides_json'), inCol = h.indexOf('inactive'), wdCol = h.indexOf('withdrawn_at')
  return (m.rows || []).filter(function (r) {
    if (inCol >= 0 && /^(true|1|yes)$/i.test(String(r[inCol] || ''))) return false
    if (wdCol >= 0 && String(r[wdCol] || '') !== '') return false
    var ov = []
    try { ov = JSON.parse(String((ovCol >= 0 && r[ovCol]) || '[]')) } catch (e) { ov = [] }
    return isTopRoleRef_(roles, r[roleCol]) || memberCapabilities_(roles, r[roleCol], ov).indexOf('knowledge') >= 0
  }).map(function (r) { return String(r[idCol]) })
}

function wikiNotifyManagers_(acting, title, isNew) {
  try {
    var to = memberEmailsByIds_(wikiManagerIds_().filter(function (id) { return id !== String(acting.id) }))
    if (!to.length) return
    var who = String(acting.display_name || acting.name || '')
    sendMailChecked_({
      to: to.join(','),
      subject: '[Ohsumi] ナレッジの' + (isNew ? '新しいページ' : '変更') + 'の提案「' + title + '」',
      body: who + 'さんから、ナレッジの' + (isNew ? '新しいページ' : 'ページの変更') + 'の提案がありました。\n\n「' + title + '」\n\n' +
        'Ohsumi の「ナレッジ」の「承認待ち」で、内容を確かめて承認・却下してください。',
    })
  } catch (e) {
    console.error('ナレッジの提案を知らせられませんでした: ' + maskEmailsIn_(String(e)))
  }
}

function wikiNotifyProposer_(memberId, title, approved, reason) {
  try {
    var to = memberEmailsByIds_([memberId])
    if (!to.length) return
    sendMailChecked_({
      to: to.join(','),
      subject: '[Ohsumi] ナレッジの提案「' + title + '」が' + (approved ? '承認されました' : '却下されました'),
      body: 'ナレッジの提案「' + title + '」が' + (approved ? '承認され、ページに反映されました。' : '却下されました。') +
        (reason ? '\n\n理由: ' + reason : ''),
    })
  } catch (e) {
    console.error('ナレッジの提案の結果を知らせられませんでした: ' + maskEmailsIn_(String(e)))
  }
}
