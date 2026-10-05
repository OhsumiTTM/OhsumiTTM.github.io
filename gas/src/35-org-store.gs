
// ---- 団体の保存(getOrgStorage・setOrgStorage) -----------------------------------
//
// 本人だけの保存(PersonalStore)と同じしくみで、団体に1つの値をキーごとに持つ(OrgStore シート)。
// キー(英小文字・数字・. _ -、64文字まで)ごとに、読める役職・書ける役職を Settings の org_storage_access に
// {キー: {read: 範囲, write: 範囲}} で決める(設定できるのは代表・全権管理者。updateSetting の権限)。範囲は次のどれか:
//   'all'        ログインしている全員
//   'adminRole'  一般以外の役職
//   'fullAdmin'  代表・全権管理者
//   'top'        代表だけ
//   [役職, ...]  一覧の役職(役職の ID・名前)と、代表・全権管理者
// 設定の無いキー・読めない設定は、代表・全権管理者だけが読み書きできる。
// 1つのキー ORG_STORE_MAX_CHARS_PER_KEY 文字・合わせて ORG_STORE_MAX_CHARS 文字・ORG_STORE_MAX_KEYS 個まで。
// 値は ORG_STORE_CHUNK 文字ずつの行に分ける。初期データ・スナップショットには入れない(読める人にだけ返す)
var SHEET_ORG_STORE = 'OrgStore'
var ORG_STORE_ACCESS_KEY = 'org_storage_access'
var ORG_STORE_CHUNK = 40000
var ORG_STORE_MAX_CHARS_PER_KEY = 100000
var ORG_STORE_MAX_CHARS = 1000000
var ORG_STORE_MAX_KEYS = 200
var ORG_STORE_LEVELS = ['all', 'adminRole', 'fullAdmin', 'top']

function validOrgStoreLevel_(level) {
  if (typeof level === 'string') return ORG_STORE_LEVELS.indexOf(level) >= 0
  if (!Array.isArray(level) || level.length === 0 || level.length > 50) return false
  return level.every(function (r) { return typeof r === 'string' && r.trim() !== '' && r.length <= 100 })
}

// updateSetting で保存する前に確かめる
function checkOrgStorageAccess_(value) {
  if (value === '' || value === null || value === undefined) return
  var parsed
  try { parsed = JSON.parse(String(value)) } catch (e) { throw userError_('団体の保存の権限の設定を読めませんでした。') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw userError_('団体の保存の権限の設定の形が正しくありません。')
  var keys = Object.keys(parsed)
  if (keys.length > ORG_STORE_MAX_KEYS) throw userError_('団体の保存の権限は ' + ORG_STORE_MAX_KEYS + ' 個のキーまで設定できます。')
  keys.forEach(function (k) {
    if (!PERSONAL_STORE_KEY_RE.test(k)) throw userError_('団体の保存のキーが正しくありません: ' + String(k).slice(0, 70))
    var rule = parsed[k]
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw userError_('団体の保存の権限は {read, write} で設定してください。')
    Object.keys(rule).forEach(function (op) { if (op !== 'read' && op !== 'write') throw userError_('団体の保存の権限は read と write だけを設定できます。') })
    ;['read', 'write'].forEach(function (op) {
      if (rule[op] !== undefined && !validOrgStoreLevel_(rule[op])) throw userError_('団体の保存の権限の範囲が正しくありません: ' + k + ' の ' + op)
    })
  })
}

function orgStoreAccess_() {
  var parsed = {}
  try { parsed = JSON.parse(getSettingValue_(ORG_STORE_ACCESS_KEY) || '{}') || {} } catch (e) { parsed = {} }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function orgStoreAllowed_(acting, access, key, op) {
  var roles = getRoles_()
  if (isFullAdminRoleRef_(roles, acting.role)) return true
  var rule = Object.prototype.hasOwnProperty.call(access, key) ? access[key] : null
  var level = rule && typeof rule === 'object' ? rule[op] : undefined
  if (!validOrgStoreLevel_(level)) return false
  if (level === 'all') return true
  if (level === 'adminRole') return isAdminRoleRef_(roles, acting.role)
  if (level === 'fullAdmin' || level === 'top') return false
  return level.some(function (r) { return sameRole_(roles, r, acting.role) })
}

function orgStoreSheet_(create) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORG_STORE)
  if (!sheet && create) sheet = getOrCreateSheet_(SHEET_ORG_STORE, ORG_STORE_HEADERS)
  return sheet
}

// 全部の行(行番号・キー・何番目か・値)
function orgStoreRows_(sheet) {
  var last = sheet ? sheet.getLastRow() : 0
  if (last < 2) return []
  var headers = headerRow_(sheet)
  var col = function (h) { return headers.indexOf(h) }
  return sheet.getRange(2, 1, last - 1, headers.length).getValues().map(function (r, i) {
    return { row: i + 2, key: String(r[col('id')]), part: Number(r[col('part')]) || 0, value: String(r[col('value')] == null ? '' : r[col('value')]) }
  })
}

function getOrgStorage_(acting, keys) {
  var access = orgStoreAccess_()
  var values = personalStoreValues_(orgStoreRows_(orgStoreSheet_(false)))
  var out = {}
  Object.keys(values).forEach(function (k) {
    if (Array.isArray(keys) && keys.map(String).indexOf(k) < 0) return
    if (orgStoreAllowed_(acting, access, k, 'read')) out[k] = values[k]
  })
  return { values: out }
}

// value: 文字列(画面が JSON にして送る)。null・空の文字列はキーを消す
function setOrgStorage_(acting, key, value) {
  key = String(key || '')
  if (!PERSONAL_STORE_KEY_RE.test(key)) throw userError_('保存のキーが正しくありません。')
  if (value !== null && value !== undefined && typeof value !== 'string') throw userError_('保存する値は文字列にしてください。')
  if (!orgStoreAllowed_(acting, orgStoreAccess_(), key, 'write')) throw userError_('この保存のキーを書き換える権限がありません。')
  var text = value == null ? '' : value
  if (text.length > ORG_STORE_MAX_CHARS_PER_KEY) throw userError_('1つのキーに保存できるのは ' + ORG_STORE_MAX_CHARS_PER_KEY + ' 文字までです。')
  var sheet = orgStoreSheet_(true)
  var rows = orgStoreRows_(sheet)
  var current = personalStoreValues_(rows)
  var others = Object.keys(current).filter(function (k) { return k !== key })
  if (text) {
    if (others.length + 1 > ORG_STORE_MAX_KEYS) throw userError_('団体の保存のキーは ' + ORG_STORE_MAX_KEYS + ' 個までです。')
    var total = text.length + others.reduce(function (n, k) { return n + current[k].length }, 0)
    if (total > ORG_STORE_MAX_CHARS) throw userError_('団体の保存の大きさ(合わせて ' + ORG_STORE_MAX_CHARS + ' 文字)を超えています。')
  }
  var chunks = []
  for (var i = 0; i < text.length; i += ORG_STORE_CHUNK) chunks.push(text.slice(i, i + ORG_STORE_CHUNK))
  var mine = rows.filter(function (r) { return r.key === key }).sort(function (a, b) { return a.part - b.part })
  var headers = headerRow_(sheet)
  var now = new Date().toISOString()
  chunks.forEach(function (chunk, part) {
    var o = { id: key, part: part, value: chunk, updated_at: now, updated_by: String(acting.id) }
    var target = mine[part] ? mine[part].row : sheet.getLastRow() + 1
    // 数式として扱われないよう、書式なしテキストにしてから書く
    sheet.getRange(target, 1, 1, headers.length).setNumberFormat('@')
    sheet.getRange(target, 1, 1, headers.length).setValues([headers.map(function (h) { return Object.prototype.hasOwnProperty.call(o, h) ? o[h] : '' })])
  })
  mine.slice(chunks.length).map(function (r) { return r.row }).sort(function (a, b) { return b - a }).forEach(function (r) { sheet.deleteRow(r) })
  return { key: key, size: text.length }
}
