// ---- 役職 ------------------------------------------------------------------------
//
// 役職は Settings の roles(JSON)に、上下関係の順(一般 → … → 最上位)で持つ。
//   { id, name, tier: 'top' | 'admin' | 'base', restricted?, sections?, requiredSkills?, capabilities? }
// 移行(VALUE_FORMAT=codes)の前は roles が無く、今までの設定(role_levels・
// restricted_roles・role_permissions・job_requirements)から組み立てる(ID は役職名)。
// 役職は ID でも名前でも引ける(findRole_)ので、移行の途中でも判定は変わらない。
// lib/ohsumi/roles.ts と同じ内容(一致することを lib/ohsumi/roles.test.ts で確かめる)。

var TOP_ROLE_ID = 'top'
var BASE_ROLE_ID = 'base'
var DEFAULT_TOP_ROLE_NAME = '代表'
var DEFAULT_BASE_ROLE_NAME = '一般'
// role_levels も roles も無い、今までの形式の団体の既定(一般より上、低い順)。既にある団体の役職を変えないため、そのままにする。
// 新しく導入する団体の最初の役職は defaultRoles_(班長・代表)
var DEFAULT_ROLE_LEVELS = ['班長', '事業責任者', '代表']
// Settings のうち役職の設定
var ROLE_SETTING_KEYS = ['roles', 'role_levels', 'restricted_roles', 'role_permissions', 'job_requirements']

// 新しく導入する団体の最初の役職(setupOhsumi が Settings の roles に書く)。班長は設定例で、名前を変えたり役職を足したりしてよい。
// 既に roles がある団体・今までの役職の設定がある団体には使わない(setupRolesSetting_)
function defaultRoles_() {
  return [
    { id: BASE_ROLE_ID, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' },
    { id: 'r_leader', name: '班長', tier: 'admin', restricted: false },
    { id: TOP_ROLE_ID, name: DEFAULT_TOP_ROLE_NAME, tier: 'top' },
  ]
}

function roleParseObject_(value) {
  try {
    var parsed = value ? JSON.parse(value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (e) {
    return {}
  }
}

function roleStringArray_(v) {
  return Array.isArray(v) ? v.map(String) : undefined
}

function rolesFromLegacy_(settings) {
  var levels = splitCsvList_(settings.role_levels)
  var names = (levels.length ? levels : DEFAULT_ROLE_LEVELS).filter(function (n) { return n !== DEFAULT_BASE_ROLE_NAME })
  if (names.indexOf(DEFAULT_TOP_ROLE_NAME) < 0) names.push(DEFAULT_TOP_ROLE_NAME)
  var restricted = splitCsvList_(settings.restricted_roles)
  // restricted_roles にだけある役職も、今までどおり制限付きの管理者として扱う
  restricted.forEach(function (n) {
    if (names.indexOf(n) < 0 && n !== DEFAULT_BASE_ROLE_NAME && n !== DEFAULT_TOP_ROLE_NAME) names.splice(names.indexOf(DEFAULT_TOP_ROLE_NAME), 0, n)
  })
  var permissions = roleParseObject_(settings.role_permissions)
  var requirements = roleParseObject_(settings.job_requirements)
  var roles = [{ id: DEFAULT_BASE_ROLE_NAME, name: DEFAULT_BASE_ROLE_NAME, tier: 'base' }]
  var baseSkills = roleStringArray_(requirements[DEFAULT_BASE_ROLE_NAME])
  if (baseSkills) roles[0].requiredSkills = baseSkills
  var seen = {}
  names.forEach(function (name) {
    if (seen[name]) return
    seen[name] = true
    var role = { id: name, name: name, tier: name === DEFAULT_TOP_ROLE_NAME ? 'top' : 'admin' }
    if (role.tier === 'admin') role.restricted = restricted.indexOf(name) >= 0
    var sections = roleStringArray_(permissions[name])
    if (sections) role.sections = sections
    var skills = roleStringArray_(requirements[name])
    if (skills) role.requiredSkills = skills
    roles.push(role)
  })
  return roles
}

function parseRolesSetting_(value) {
  if (!value) return null
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var roles = []
  for (var i = 0; i < parsed.length; i++) {
    var o = parsed[i]
    if (!o || typeof o !== 'object') return null
    var tier = o.tier
    if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !o.name) return null
    if (tier !== 'top' && tier !== 'admin' && tier !== 'base') return null
    var role = { id: o.id, name: o.name, tier: tier }
    if (tier === 'admin') role.restricted = o.restricted === true
    var sections = roleStringArray_(o.sections)
    if (sections) role.sections = sections
    var skills = roleStringArray_(o.requiredSkills)
    if (skills) role.requiredSkills = skills
    // できる操作(38-capabilities.gs)。管理者の役職だけ。無ければ既定
    var caps = roleStringArray_(o.capabilities)
    if (caps && tier === 'admin') role.capabilities = normalizeCapabilities_(caps)
    roles.push(role)
  }
  return validateRoles_(roles).length === 0 ? roles : null
}

function rolesFromSettings_(settings) {
  return parseRolesSetting_(settings.roles) || rolesFromLegacy_(settings)
}

function validateRoles_(roles) {
  var errors = []
  var ids = {}
  var names = {}
  roles.forEach(function (r) {
    if (ids[r.id]) errors.push('役職のIDが重複しています: ' + r.id)
    if (names[r.name]) errors.push('役職の名前が重複しています: ' + r.name)
    ids[r.id] = true
    names[r.name] = true
  })
  if (roles.filter(function (r) { return r.tier === 'base' }).length !== 1) errors.push('一般の役職はちょうど1つ必要です')
  if (roles.filter(function (r) { return r.tier === 'top' }).length < 1) errors.push('最上位の役職が1つ以上必要です')
  return errors
}

function findRole_(roles, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v) return undefined
  for (var i = 0; i < roles.length; i++) if (roles[i].id === v) return roles[i]
  for (var j = 0; j < roles.length; j++) if (roles[j].name === v) return roles[j]
  return undefined
}

function roleTier_(roles, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v) return 'base'
  var role = findRole_(roles, v)
  return role ? role.tier : 'admin'
}

function isTopRoleRef_(roles, ref) { return roleTier_(roles, ref) === 'top' }
function isAdminRoleRef_(roles, ref) { return roleTier_(roles, ref) !== 'base' }

function isFullAdminRoleRef_(roles, ref) {
  var tier = roleTier_(roles, ref)
  if (tier === 'top') return true
  if (tier === 'base') return false
  var role = findRole_(roles, ref)
  return !(role && role.restricted)
}

function sameRole_(roles, a, b) {
  var x = String(a === null || a === undefined ? '' : a).trim()
  var y = String(b === null || b === undefined ? '' : b).trim()
  if (!x || !y) return false
  if (x === y) return true
  var rx = findRole_(roles, x)
  var ry = findRole_(roles, y)
  return !!rx && !!ry && rx.id === ry.id
}

function rolesToLegacySettings_(roles) {
  var nonBase = roles.filter(function (r) { return r.tier !== 'base' })
  var permissions = {}
  var requirements = {}
  roles.forEach(function (r) {
    if (r.sections) permissions[r.name] = r.sections
    if (r.requiredSkills) requirements[r.name] = r.requiredSkills
  })
  return {
    role_levels: nonBase.map(function (r) { return r.name }).join(','),
    restricted_roles: nonBase.filter(function (r) { return r.tier === 'admin' && r.restricted }).map(function (r) { return r.name }).join(','),
    role_permissions: JSON.stringify(permissions),
    job_requirements: JSON.stringify(requirements),
  }
}

// Settings の key → value(役職の設定だけ)。1回の読み込みで全部取る
function readRoleSettings_() {
  var out = {}
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
  if (!sheet || sheet.getLastRow() < 2) return out
  var headers = headerRow_(sheet)
  var keyCol = headers.indexOf('key')
  var valueCol = headers.indexOf('value')
  if (keyCol === -1 || valueCol === -1) return out
  sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
    var key = String(r[keyCol])
    if (ROLE_SETTING_KEYS.indexOf(key) >= 0) out[key] = String(r[valueCol] || '')
  })
  return out
}

// このリクエストでの役職の一覧(1回だけ読む。役職の設定を変えたら invalidateRoles_)
var _requestRoles = null
function requestRolesFrom_(settings) {
  var parsed = parseRolesSetting_(settings.roles)
  return { roles: parsed || rolesFromLegacy_(settings), fromSetting: !!parsed }
}
function getRoles_() {
  if (!_requestRoles) _requestRoles = requestRolesFrom_(readRoleSettings_())
  return _requestRoles.roles
}
function invalidateRoles_() { _requestRoles = null }

// Settings の roles を使っているか(移行の後・新しく導入した団体)。使っていなければ、
// 今までの設定から組み立てた役職(ID は役職名)
function hasRolesSetting_() {
  getRoles_()
  return _requestRoles.fromSetting
}

// メンバーの role 列に書く値。役職の ID(roles が無い間は、ID は役職名そのもの)
function sheetRoleRef_(ref) {
  var role = findRole_(getRoles_(), ref)
  return role ? role.id : String(ref || '').trim()
}

// roles が無い団体の役職(ID は役職名)に、移行後と同じ ID を付ける。
// 一般 → base、代表 → top、ほかは新しい ID(メンバーの role 列の役職名は、名前で引けるのでそのままでよい)
function rolesWithCodeIds_(roles) {
  return roles.map(function (r) {
    var copy = {}
    Object.keys(r).forEach(function (k) { copy[k] = r[k] })
    if (r.tier === 'base') copy.id = BASE_ROLE_ID
    else if (r.name === DEFAULT_TOP_ROLE_NAME) copy.id = TOP_ROLE_ID
    else copy.id = newRoleId_()
    return copy
  })
}

function newRoleId_() {
  return 'r_' + Math.random().toString(36).slice(2, 8)
}

// ---- 部門 ----------------------------------------------------------------------
//
// Settings の departments(JSON)に [{ id, name, archived? }]。未設定なら既定の7部門。未分類は空。
// タスクなどの部門の値は、移行(VALUE_FORMAT=codes)の前は部門名、後は部門 ID。ID でも名前でも引ける。
// lib/ohsumi/departments.ts と同じ内容(一致することを lib/ohsumi/departments.test.ts で確かめる)。

var UNCATEGORIZED_NAME = '未分類'

function defaultDepartments_() {
  return VALUE_CODES.department.codes.filter(function (c) { return c !== '' }).map(function (id) {
    return { id: id, name: VALUE_CODES.department.sheetLabels[id] }
  })
}

function validateDepartments_(list) {
  var errors = []
  var ids = {}
  var names = {}
  list.forEach(function (d) {
    if (!d.id || !d.name) errors.push('領域の ID と名前は空にできません')
    if (d.name === UNCATEGORIZED_NAME) errors.push('「未分類」は領域の名前に使えません')
    if (ids[d.id]) errors.push('領域の ID が重複しています: ' + d.id)
    if (names[d.name]) errors.push('領域の名前が重複しています: ' + d.name)
    ids[d.id] = true
    names[d.name] = true
  })
  return errors
}

function parseDepartmentsSetting_(value) {
  if (!value) return null
  var parsed
  try { parsed = JSON.parse(value) } catch (e) { return null }
  if (!Array.isArray(parsed)) return null
  var list = []
  for (var i = 0; i < parsed.length; i++) {
    var o = parsed[i]
    if (!o || typeof o !== 'object') return null
    if (typeof o.id !== 'string' || typeof o.name !== 'string') return null
    var dept = { id: o.id, name: o.name }
    if (o.archived === true) dept.archived = true
    list.push(dept)
  }
  return validateDepartments_(list).length === 0 ? list : null
}

function findDepartment_(list, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v || v === UNCATEGORIZED_NAME) return undefined
  var i
  for (i = 0; i < list.length; i++) if (list[i].id === v) return list[i]
  for (i = 0; i < list.length; i++) if (list[i].name === v) return list[i]
  var labels = VALUE_CODES.department.sheetLabels
  var ids = Object.keys(labels)
  for (i = 0; i < ids.length; i++) {
    if (ids[i] && labels[ids[i]] === v) {
      for (var j = 0; j < list.length; j++) if (list[j].id === ids[i]) return list[j]
      return undefined
    }
  }
  return undefined
}

function normalizeDepartment_(list, ref) {
  var v = String(ref === null || ref === undefined ? '' : ref).trim()
  if (!v || v === UNCATEGORIZED_NAME) return ''
  var dept = findDepartment_(list, v)
  return dept ? dept.id : v
}

function sheetDepartmentRef_(list, ref, codes) {
  var id = normalizeDepartment_(list, ref)
  if (!id) return codes ? '' : UNCATEGORIZED_NAME
  var dept = findDepartment_(list, id)
  if (!dept) return id
  return codes ? dept.id : dept.name
}

// このリクエストでの部門の一覧(1回だけ読む。シートが無い時は既定)
var _requestDepartments = null
function getDepartments_() {
  if (!_requestDepartments) {
    var raw = ''
    var fromSetting = false
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS)
      if (sheet && sheet.getLastRow() > 1) {
        var headers = headerRow_(sheet)
        var keyCol = headers.indexOf('key')
        var valueCol = headers.indexOf('value')
        sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().forEach(function (r) {
          if (String(r[keyCol]) === 'departments') raw = String(r[valueCol] || '')
        })
      }
    } catch (e) {
      // シートを読めない(テストなど)時は既定の部門
    }
    var parsed = parseDepartmentsSetting_(raw)
    fromSetting = !!parsed
    _requestDepartments = { list: parsed || defaultDepartments_(), fromSetting: fromSetting }
  }
  return _requestDepartments.list
}
function invalidateDepartments_() { _requestDepartments = null }

// 選択肢の値を読む時・書く時の変換(部門だけは部門の一覧を使う)
function normalizeValue_(kind, value) {
  return kind === 'department' ? normalizeDepartment_(getDepartments_(), value) : normalizeCode_(kind, value)
}
function sheetValue_(kind, value) {
  return kind === 'department' ? sheetDepartmentRef_(getDepartments_(), value, isCodesFormat_()) : sheetCode_(kind, value)
}

// ---- 部門の編集(updateDepartments・deleteDepartment・moveDepartmentTasks) ---------

function writeDepartments_(list) {
  updateSetting_('departments', JSON.stringify(list))
  invalidateDepartments_()
}

// 部門の一覧を保存する(追加・名前・並び順・アーカイブの解除)。削除は deleteDepartment
function updateDepartments_(newList) {
  if (!Array.isArray(newList)) throw userError_('領域の一覧の形式が正しくありません。')
  var parsed = parseDepartmentsSetting_(JSON.stringify(newList))
  if (!parsed) throw userError_('領域の一覧が正しくありません: ' + validateDepartments_(newList.filter(Boolean)).join(' / '))
  var current = getDepartments_()
  var byId = {}
  current.forEach(function (d) { byId[d.id] = d })
  var newIds = {}
  parsed.forEach(function (d) { newIds[d.id] = true })
  current.forEach(function (d) {
    if (!newIds[d.id]) throw userError_('領域「' + d.name + '」を消すには、領域の削除を使ってください。')
  })
  if (!isCodesFormat_()) {
    parsed.forEach(function (d) {
      // 移行前はタスクの部門を部門名で持つため、名前を変えると引けなくなる
      if (byId[d.id] && byId[d.id].name !== d.name) throw userError_('領域の名前の変更は、内部コードへの移行の後にできるようになります。')
    })
  }
  writeDepartments_(parsed)
  return { departments: parsed }
}

// 部門が使われている数(タスク・テンプレート・定期タスク・権限の例外)
function departmentUsage_(deptId) {
  var list = getDepartments_()
  var usage = { tasks: 0, settings: 0, overrides: 0 }
  var tasks = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TASKS)
  if (tasks && tasks.getLastRow() > 1) {
    var h = headerRow_(tasks)
    var col = h.indexOf('department')
    if (col >= 0) {
      tasks.getRange(2, col + 1, tasks.getLastRow() - 1, 1).getValues().forEach(function (r) {
        if (normalizeDepartment_(list, r[0]) === deptId) usage.tasks++
      })
    }
  }
  ;['project_templates', 'task_set_templates', 'recurring_rules'].forEach(function (key) {
    var raw = getSettingValue_(key)
    if (!raw) return
    var found = 0
    JSON.stringify(parseJsonOr_(raw, null), function (k, v) {
      if (k === 'department' && normalizeDepartment_(list, v) === deptId) found++
      return v
    })
    usage.settings += found
  })
  var members = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MEMBERS)
  if (members && members.getLastRow() > 1) {
    var mh = headerRow_(members)
    var ocol = mh.indexOf('permission_overrides_json')
    if (ocol >= 0) {
      members.getRange(2, ocol + 1, members.getLastRow() - 1, 1).getValues().forEach(function (r) {
        parseJsonOr_(r[0], []).forEach(function (ov) {
          if (ov && ov.targetType === 'department' && normalizeDepartment_(list, ov.targetId) === deptId) usage.overrides++
        })
      })
    }
  }
  return usage
}

// 部門を削除する。使われていればアーカイブ(archived)にし、どこでも使われていなければ一覧から消す
function deleteDepartment_(deptId) {
  var list = getDepartments_()
  var dept = findDepartment_(list, deptId)
  if (!dept) throw userError_('領域が見つかりません: ' + deptId)
  var usage = departmentUsage_(dept.id)
  var used = usage.tasks + usage.settings + usage.overrides > 0
  var next = used
    ? list.map(function (d) { return d.id === dept.id ? { id: d.id, name: d.name, archived: true } : d })
    : list.filter(function (d) { return d.id !== dept.id })
  writeDepartments_(next)
  return { departments: next, archived: used, usage: usage }
}

// ある部門のタスクを、別の部門(空は未分類)へ移す。返り値は移したタスクの数
function moveDepartmentTasks_(fromId, toId) {
  var list = getDepartments_()
  var from = findDepartment_(list, fromId)
  if (!from) throw userError_('領域が見つかりません: ' + fromId)
  if (toId && !findDepartment_(list, toId)) throw userError_('移す先の領域が見つかりません: ' + toId)
  var sheet = getSheet_(SHEET_TASKS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var col = headers.indexOf('department')
  if (col < 0 || sheet.getLastRow() < 2) return { moved: 0 }
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var value = sheetDepartmentRef_(list, toId || '', isCodesFormat_())
  var moved = 0
  rows.forEach(function (r) {
    if (normalizeDepartment_(list, r[col]) !== from.id) return
    updateTaskFields_(String(r[idCol]), { department: value })
    moved++
  })
  return { moved: moved }
}

// ---- 役職の編集(updateRoles・deleteRole)と、最上位の締め出しの防止 ----------------

function baseRoleRef_() {
  var roles = getRoles_()
  for (var i = 0; i < roles.length; i++) if (roles[i].tier === 'base') return roles[i].id
  return DEFAULT_BASE_ROLE_NAME
}

// 一覧に無い役職は受け付けない(役職の付け間違いで管理者扱いにならないように)
function requireKnownRole_(ref) {
  var role = findRole_(getRoles_(), ref)
  if (!role) throw userError_('役職が見つかりません: ' + ref)
  return role
}

// 変更の後に、最上位の役職を持つ有効な(休止中でない)メンバーが1人以上残るか確かめる。
// change: { roles?: 変更後の役職の一覧, members?: { メンバーID: { role?, inactive?, removed? } } }
function assertTopRemains_(change) {
  var roles = change.roles || getRoles_()
  var overrides = change.members || {}
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var inactiveCol = headers.indexOf('inactive')
  var withdrawnCol = headers.indexOf('withdrawn_at')
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
  var count = 0
  rows.forEach(function (r) {
    var o = overrides[String(r[idCol])] || {}
    if (o.removed) return
    var inactive = o.inactive !== undefined ? o.inactive : String(inactiveCol >= 0 ? r[inactiveCol] : '').trim().toUpperCase() === 'TRUE'
    if (inactive) return
    var role = o.role !== undefined ? o.role : r[roleCol]
    if (isTopRoleRef_(roles, role)) count++
  })
  if (count === 0) {
    throw userError_('最上位の役職を持つ有効なメンバーが0人になるため、この操作はできません。先に別のメンバーを最上位の役職にしてください。')
  }
}

// 役職の一覧を保存する(並び順・種類・制限・セクション・必要スキル・名前)。
// 役職の削除は deleteRole で行う(使っているメンバーを移す必要があるため)。
// 団体のルール(org.rules)を持つ人が行える。最上位の役職にかかわる変更・できる操作の設定は、最上位の役職を持つ人だけ
function updateRoles_(acting, newRoles) {
  if (!Array.isArray(newRoles)) throw userError_('役職の一覧の形式が正しくありません。')
  var parsed = parseRolesSetting_(JSON.stringify(newRoles))
  if (!parsed) throw userError_('役職の一覧が正しくありません: ' + validateRoles_(newRoles.filter(Boolean)).join(' / '))
  var current = getRoles_()
  var byId = {}
  current.forEach(function (r) { byId[r.id] = r })
  var newIds = {}
  parsed.forEach(function (r) { newIds[r.id] = true })
  current.forEach(function (r) {
    if (!newIds[r.id]) throw userError_('役職「' + r.name + '」を消すには、役職の削除を使ってください。')
  })
  var topOf = function (list) { return list.filter(function (r) { return r.tier === 'top' }).map(function (r) { return r.id }).sort().join(',') }
  if (topOf(current) !== topOf(parsed) && !isTopRoleRef_(current, acting.role)) {
    throw userError_('最上位の役職にかかわる変更は、最上位の役職を持つメンバーだけが行えます。')
  }
  // できる操作の設定は最上位の役職の人だけ。ほかの人は、できる操作が増えない変更だけ(38-capabilities.gs)
  if (!isTopRoleRef_(current, acting.role)) parsed = guardRolesChangeByNonTop_(acting, current, parsed)
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.tier === 'base' && r.tier !== 'base') throw userError_('一般の役職の種類は変えられません。')
    if (before && before.tier !== 'base' && r.tier === 'base') throw userError_('一般の役職は1つだけです。')
    if (!hasRolesSetting_()) {
      // 移行の前は役職名が ID を兼ねるため、名前の変更と、代表以外の最上位の役職は作れない
      if (r.name !== r.id) throw userError_('役職の名前の変更は、内部コードへの移行の後にできるようになります。')
      if (r.tier === 'top' && r.name !== DEFAULT_TOP_ROLE_NAME) throw userError_('代表以外の最上位の役職は、内部コードへの移行の後に作れるようになります。')
      // 移行の前の保存先(今までの設定)には、できる操作を書けない
      if (Array.isArray(r.capabilities) && normalizeCapabilities_(r.capabilities).join(',') !== roleCapabilities_([{ id: r.id, name: r.name, tier: r.tier, restricted: r.restricted }], r.id).join(',')) {
        throw userError_('役職のできる操作は、内部コードへの移行の後に設定できるようになります。')
      }
    }
  })
  assertTopRemains_({ roles: parsed })
  // 名前を変えた役職を、古い名前のまま持っているメンバー(移行の漏れなど)は、役職の ID にそろえる
  // (名前を変えると、古い名前ではもう引けないため)
  var renamed = {}
  parsed.forEach(function (r) {
    var before = byId[r.id]
    if (before && before.name !== r.name) renamed[before.name] = r.id
  })
  if (Object.keys(renamed).length) {
    var sheet = getSheet_(SHEET_MEMBERS)
    var headers = headerRow_(sheet)
    var idCol = headers.indexOf('id')
    var roleCol = headers.indexOf('role')
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
    rows.forEach(function (r) {
      var name = String(r[roleCol] || '').trim()
      if (Object.prototype.hasOwnProperty.call(renamed, name)) updateMemberFields_(String(r[idCol]), { role: renamed[name] })
    })
  }
  writeRoles_(parsed)
  return { roles: parsed }
}

// 役職を削除する。使っているメンバー(休止中を含む)は moveToRoleId の役職に移す。
// 最上位(top)・一般の役職は削除できない。メンバーを移す場合は最上位の役職を持つ人だけ
function deleteRole_(acting, roleId, moveToRoleId) {
  var roles = getRoles_()
  var target = requireKnownRole_(roleId)
  if (target.tier === 'base' || target.id === TOP_ROLE_ID || (!hasRolesSetting_() && target.name === DEFAULT_TOP_ROLE_NAME)) {
    throw userError_('この役職は削除できません: ' + target.name)
  }
  var sheet = getSheet_(SHEET_MEMBERS)
  var headers = headerRow_(sheet)
  var idCol = headers.indexOf('id')
  var roleCol = headers.indexOf('role')
  var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : []
  var holders = rows.filter(function (r) { return sameRole_(roles, r[roleCol], target.id) }).map(function (r) { return String(r[idCol]) })
  var moveTo = null
  if (holders.length > 0) {
    if (!isTopRoleRef_(roles, acting.role)) throw userError_('メンバーのいる役職を削除する(メンバーを別の役職に移す)のは、最上位の役職を持つメンバーだけが行えます。')
    moveTo = requireKnownRole_(moveToRoleId)
    if (moveTo.id === target.id) throw userError_('移す先の役職が、削除する役職と同じです。')
  }
  var remaining = roles.filter(function (r) { return r.id !== target.id })
  var memberChanges = {}
  holders.forEach(function (id) { memberChanges[id] = { role: moveTo.id } })
  assertTopRemains_({ roles: remaining, members: memberChanges })
  holders.forEach(function (id) {
    updateMemberFields_(id, { role: moveTo.id })
  })
  writeRoles_(remaining)
  return { roles: remaining, moved: holders.length }
}

// 役職の一覧を、今の保存先に書く(roles が無い間は今までの設定、ある時は roles)
function writeRoles_(roles) {
  if (hasRolesSetting_()) {
    updateSetting_('roles', JSON.stringify(roles))
  } else {
    var legacy = rolesToLegacySettings_(roles)
    Object.keys(legacy).forEach(function (key) { updateSetting_(key, legacy[key]) })
  }
  invalidateRoles_()
}

// コードで書く団体(VALUE_FORMAT=codes)で役職の設定(roles)がまだ無ければ作る。
// 今までの役職の設定があればそれを元に、無ければ既定の役職で作る
function setupRolesSetting_() {
  if (!isCodesFormat_()) return 'legacy'
  invalidateRoles_()
  if (hasRolesSetting_()) return 'already'
  var legacy = readRoleSettings_()
  var hasLegacy = ['role_levels', 'restricted_roles', 'role_permissions', 'job_requirements'].some(function (k) { return !!legacy[k] })
  var roles = hasLegacy ? rolesWithCodeIds_(getRoles_()) : defaultRoles_()
  updateSetting_('roles', JSON.stringify(roles))
  invalidateRoles_()
  console.log('🆕 役職の設定(roles)を作成しました: ' + roles.map(function (r) { return r.name }).join('・'))
  return 'created'
}

// Settings のうち、中に選択肢の値を持つキー(sheetSettingValue_ で形式を変えるもの)
var CODE_SETTING_KEYS = ['project_templates', 'task_set_templates', 'recurring_rules', 'skill_level_thresholds']

// 選択肢の値を持ちうるデータがあるシートの名前の一覧。Settings は、setupOhsumi が
// 作る初期キー(団体名など)を除き、CODE_SETTING_KEYS に値がある場合だけ数える
function sheetsWithData_(ss) {
  var found = []
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sheet = ss.getSheetByName(name)
    if (!sheet || sheet.getLastRow() < 2) return
    if (name !== SHEET_SETTINGS) { found.push(name); return }
    var headers = headerRow_(sheet)
    var keyCol = headers.indexOf('key')
    var valueCol = headers.indexOf('value')
    if (keyCol === -1 || valueCol === -1) return
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
    var hasCodeSetting = rows.some(function (r) {
      return CODE_SETTING_KEYS.indexOf(String(r[keyCol])) >= 0 && String(r[valueCol] || '').trim() !== ''
    })
    if (hasCodeSetting) found.push(name)
  })
  return found
}

// 新しく導入する団体(データ行が1行も無い)では VALUE_FORMAT を codes にして、
// 最初からコードで書く。データが既にある場合は変えない(日本語のまま書き、
// 移行の関数で移行する)。既に codes の場合もそのまま。
// 返り値: 'already'(既に codes)/ 'set'(codes にした)/ 'hasData'(変えなかった)
function setupValueFormat_(ss) {
  var props = PropertiesService.getScriptProperties()
  if (props.getProperty('VALUE_FORMAT') === 'codes') {
    console.log('✅ 選択肢の値の形式: コード(VALUE_FORMAT=codes)')
    return 'already'
  }
  var withData = sheetsWithData_(ss)
  if (withData.length === 0) {
    setRequestProp_('VALUE_FORMAT', 'codes')
    console.log('🆕 データが無いため、選択肢の値を最初からコードで書き込みます(VALUE_FORMAT=codes に設定しました)')
    return 'set'
  }
  console.log(
    'ℹ️ 選択肢の値の形式: 日本語のまま書き込みます(既にデータがあるシート: ' + withData.join('・') + ')。' +
      'VALUE_FORMAT は変えていません(読み込みは日本語・コードのどちらにも対応しています)。VALUE_FORMAT を手で設定しないでください',
  )
  return 'hasData'
}

