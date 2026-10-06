// ---- できる操作(capability) ------------------------------------------------------
//
// 「代表だけ」「全権管理者だけ」だった操作を、まとまり(capability)ごとに役職へ渡せるようにする。
// 役職の設定(Settings の roles)の各役職に capabilities: [キー] を持つ。持たない役職は既定:
//   最上位: すべて(設定に関係なく、いつもすべて)
//   管理者で制限なし(全権管理者): org.rules・trash(今までの全権管理者と同じ)
//   管理者で制限あり・一般: なし
// 一般の役職には渡せない(設定に書いてあっても使わない)。
// 画面はこの一覧(memberCapabilities_)だけを見て、ボタン・入力欄を出す。
// lib/ohsumi/capabilities.ts と同じ内容(一致することを lib/ohsumi/capabilities.test.ts で確かめる)。
//
// どの設定でも渡さないもの(最上位だけ): バックアップ・個人情報の削除・利用の状況・集計値・診断情報、
// 役職の種類・できる操作の設定そのもの、人ごとの権限の例外の編集(TOP_ONLY_ACTIONS と authorizeAction_ の前半)。

var CAPABILITY_ACTIONS = {
  'members.add': ['addMember'],
  'members.role': ['updateRole'],
  'members.remove': ['removeMember'],
  'members.hr': ['updateReportsTo', 'updateMentor', 'updateJoinedAt', 'updateEmail', 'updateMemberProjects'],
  'members.training': ['notifyTrainingDecision'],
  'recruiting': ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember'],
  'projects.remove': ['removeProject'],
  'trash': ['restoreTask', 'purgeTask'],
  'org.rules': ['updateSetting', 'updateRoles', 'deleteRole', 'updateDepartments', 'deleteDepartment', 'moveDepartmentTasks',
    'unarchiveTasks', 'updateDiscordWebhookUrl', 'updateSlackWebhookUrl', 'testDiscordWebhook', 'testSlackWebhook',
    'getWebhookStatus', 'getMailQuotaStatus', 'getGasUpdateStatus', 'updateProjectHealth', 'revokeMemberSessions'],
  'org.logo': ['uploadOrgLogo'],
}
// まとまりの順(画面のチェックの並び)
var CAPABILITY_KEYS = ['members.add', 'members.role', 'members.remove', 'members.hr', 'members.training', 'recruiting',
  'projects.remove', 'trash', 'org.rules', 'org.logo']
// 制限なしの管理者の既定
var FULL_ADMIN_DEFAULT_CAPABILITIES = ['org.rules', 'trash']
// 最上位だけの操作(どの設定でも渡さない)。人ごとの権限の例外の編集
var TOP_ONLY_ACTIONS = ['updatePermissionOverrides']

var CAPABILITY_BY_ACTION = (function () {
  var map = {}
  Object.keys(CAPABILITY_ACTIONS).forEach(function (key) {
    CAPABILITY_ACTIONS[key].forEach(function (action) { map[action] = key })
  })
  return map
})()

var CAPABILITY_LABELS = {
  'members.add': 'メンバーの登録・招待',
  'members.role': 'メンバーの役職の変更',
  'members.remove': 'メンバーの退会',
  'members.hr': '報告先・メンター・所属開始日・メールアドレス・担当プロジェクトの変更',
  'members.training': '研修の承認',
  'recruiting': '採用',
  'projects.remove': 'プロジェクトの削除',
  'trash': 'タスクのゴミ箱',
  'org.rules': '団体のルールの変更',
  'org.logo': '団体のロゴの変更',
}

// 知っているキーだけを、決まった順で(重複なし)
function normalizeCapabilities_(list) {
  var seen = {}
  ;(Array.isArray(list) ? list : []).forEach(function (k) { if (CAPABILITY_ACTIONS[String(k)]) seen[String(k)] = true })
  return CAPABILITY_KEYS.filter(function (k) { return seen[k] })
}

// 役職のできる操作(人ごとの例外は含まない)。一覧に無い役職は、今までと同じく制限なしの管理者として扱う
function roleCapabilities_(roles, ref) {
  var tier = roleTier_(roles, ref)
  if (tier === 'top') return CAPABILITY_KEYS.slice()
  if (tier === 'base') return []
  var role = findRole_(roles, ref)
  if (role && Array.isArray(role.capabilities)) return normalizeCapabilities_(role.capabilities)
  return role && role.restricted ? [] : normalizeCapabilities_(FULL_ADMIN_DEFAULT_CAPABILITIES)
}

function roleHasCapability_(roles, ref, key) {
  return roleCapabilities_(roles, ref).indexOf(key) >= 0
}

// ログインした人のできる操作(画面に渡す)。役職の分と、人ごとの権限の例外の分(採用の例外は
// 「編集」以上で recruiting)を合わせる。overrides は permission_overrides の配列
function memberCapabilities_(roles, roleRef, overrides) {
  var caps = roleCapabilities_(roles, roleRef)
  var list = Array.isArray(overrides) ? overrides : []
  var recruitingOverride = list.some(function (ov) {
    return ov && ov.targetType === 'recruiting' && (OVERRIDE_ACCESS_LEVELS[ov.access] || 0) >= OVERRIDE_ACCESS_LEVELS.edit
  })
  if (recruitingOverride && caps.indexOf('recruiting') < 0) caps = normalizeCapabilities_(caps.concat(['recruiting']))
  return caps
}

// スナップショットから、そのメンバーのできる操作
function memberCapabilitiesFromSnapshot_(data, memberId) {
  var row = findMemberInSnapshot_(data, memberId)
  if (!row) return []
  var overrides = []
  try { overrides = JSON.parse(String(row.permission_overrides_json || '[]')) } catch (e) { overrides = [] }
  return memberCapabilities_(rolesFromSnapshot_(data), row.role, overrides)
}

function capabilityDeniedMessage_(key) {
  return 'この操作(' + (CAPABILITY_LABELS[key] || key) + ')をする権限がありません。代表に、役職の「できる操作」で許可してもらってください。'
}

function containsAll_(have, need) {
  return need.every(function (k) { return have.indexOf(k) >= 0 })
}

// ---- 昇権の防止 -----------------------------------------------------------------
//
// 最上位でない人が役職を付ける時(updateRole・役職を付けた addMember・convertCandidateToMember)の決まり。
// 最上位の人はこの確認を通らない(authorizeAction_ の始めで許可する)。
//   - 最上位の役職は付けられない
//   - 自分の持っていない操作を持つ役職、自分より範囲の広い役職(制限なし)は付けられない
//   - targetId があれば: 自分の役職は変えられない/最上位の人の役職は変えられない/
//     自分の持っていない操作を持つ人(制限なしの人を含む)の役職は変えられない
function assertRoleAssignable_(acting, roleRef, targetId) {
  var roles = getRoles_()
  var actorCaps = roleCapabilities_(roles, acting.role)
  var actorFull = isFullAdminRoleRef_(roles, acting.role)
  if (targetId !== undefined && targetId !== null) {
    var tid = String(targetId)
    if (tid === String(acting.id)) throw userError_('自分の役職は変えられません。ほかの人に頼んでください。')
    var target = null
    try { target = authFindRow_(SHEET_MEMBERS, tid) } catch (e) { target = null }
    if (!target) throw userError_('メンバーが見つかりません。')
    if (isTopRoleRef_(roles, target.role)) throw userError_('最上位の役職の人の役職は、最上位の役職の人だけが変えられます。')
    if (!containsAll_(actorCaps, roleCapabilities_(roles, target.role)) || (!actorFull && isFullAdminRoleRef_(roles, target.role))) {
      throw userError_('自分が持っていない操作ができる人の役職は変えられません。')
    }
  }
  var ref = String(roleRef === null || roleRef === undefined ? '' : roleRef).trim()
  if (!ref) return
  var role = findRole_(roles, ref)
  if (!role) throw userError_('役職が見つかりません: ' + ref)
  if (role.tier === 'top') throw userError_('最上位の役職は、最上位の役職の人だけが付けられます。')
  if (!containsAll_(actorCaps, roleCapabilities_(roles, role.id)) || (!actorFull && isFullAdminRoleRef_(roles, role.id))) {
    throw userError_('自分が持っていない操作ができる役職は付けられません: ' + role.name)
  }
}

// 最上位でない人が役職の一覧を保存する時(updateRoles)の決まり。
//   - 役職ごとのできる操作は変えられない(できる操作の設定は最上位だけ)。
//     既定のままの役職の制限を変えた時に既定が変わるのは今までと同じ(全権管理者が役職を制限なしにする等)。
//     ただし、自分の持っていない操作が増える時は、変える前のできる操作を書いて残す
//   - 新しい役職は、自分の持っている操作の範囲だけ
//   - 制限なしでない人は、役職の制限を変えられず、制限なしの役職を作れない
// 直した一覧を返す(変えてはいけない所を変えていれば userError_)
function guardRolesChangeByNonTop_(acting, current, parsed) {
  var actorCaps = roleCapabilities_(current, acting.role)
  var actorFull = isFullAdminRoleRef_(current, acting.role)
  var byId = {}
  current.forEach(function (r) { byId[r.id] = r })
  return parsed.map(function (r) {
    var before = byId[r.id]
    var next = {}
    Object.keys(r).forEach(function (k) { next[k] = r[k] })
    if (before) {
      if (!actorFull && r.tier === 'admin' && before.tier === 'admin' && !!r.restricted !== !!before.restricted) {
        throw userError_('役職の制限(制限なし・制限あり)は、制限なしの管理者か最上位の役職の人だけが変えられます。')
      }
      var beforeCaps = roleCapabilities_(current, before.id)
      if (Array.isArray(r.capabilities) && normalizeCapabilities_(r.capabilities).join(',') !== beforeCaps.join(',')) {
        throw userError_('役職のできる操作は、最上位の役職の人だけが変えられます。')
      }
      if (r.tier === 'admin' && !Array.isArray(r.capabilities)) {
        if (Array.isArray(before.capabilities)) {
          // 画面が送らなかった時も、書いてあったできる操作はそのまま残す
          next.capabilities = beforeCaps
        } else {
          // どちらも既定のまま: 制限の変更で既定が変わるのは今までと同じ。ただし自分の持っていない
          // 操作が増える時は、変える前のできる操作を書いて残す
          var afterCaps = roleCapabilities_([next], r.id)
          if (afterCaps.join(',') !== beforeCaps.join(',') && !containsAll_(actorCaps, afterCaps)) next.capabilities = beforeCaps
        }
      }
    } else {
      if (!actorFull && r.tier === 'admin' && !r.restricted) throw userError_('制限なしの役職は、制限なしの管理者か最上位の役職の人だけが作れます。')
      if (r.tier === 'admin' && !containsAll_(actorCaps, roleCapabilities_([next], r.id))) {
        throw userError_('自分が持っていない操作ができる役職は作れません: ' + r.name)
      }
    }
    return next
  })
}
