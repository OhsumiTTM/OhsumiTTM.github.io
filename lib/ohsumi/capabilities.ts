// できる操作(capability)。「代表だけ」「全権管理者だけ」だった操作のまとまりで、役職ごとに団体が決める。
//
// GAS(gas/src/38-capabilities.gs)と同じ定義(一致することを lib/ohsumi/capabilities.test.ts で確かめる)。
// 判定は GAS がする。画面は、GAS が起動時のデータで渡す「ログインした人のできる操作」の一覧だけを見て、
// ボタン・入力欄・タブを出す(store の can)。役職ごとの既定・人ごとの例外の分の計算は roles.ts の
// roleCapabilities・memberCapabilities(GAS と同じ。画面だけで動く時に使う)。

export const CAPABILITY_KEYS = [
  'members.add',
  'members.role',
  'members.remove',
  'members.hr',
  'members.training',
  'recruiting',
  'projects.remove',
  'trash',
  'org.rules',
  'org.logo',
] as const

export type Capability = (typeof CAPABILITY_KEYS)[number]

// まとまりごとの GAS の操作(gas/src/38-capabilities.gs の CAPABILITY_ACTIONS と同じ)
export const CAPABILITY_ACTIONS: Record<Capability, readonly string[]> = {
  'members.add': ['addMember'],
  'members.role': ['updateRole'],
  'members.remove': ['removeMember'],
  'members.hr': ['updateReportsTo', 'updateMentor', 'updateJoinedAt', 'updateEmail', 'updateMemberProjects'],
  'members.training': ['notifyTrainingDecision'],
  recruiting: ['addCandidate', 'updateCandidate', 'removeCandidate', 'convertCandidateToMember'],
  'projects.remove': ['removeProject'],
  trash: ['restoreTask', 'purgeTask'],
  'org.rules': [
    'updateSetting', 'updateRoles', 'deleteRole', 'updateDepartments', 'deleteDepartment', 'moveDepartmentTasks',
    'unarchiveTasks', 'updateDiscordWebhookUrl', 'updateSlackWebhookUrl', 'testDiscordWebhook', 'testSlackWebhook',
    'getWebhookStatus', 'getMailQuotaStatus', 'getGasUpdateStatus', 'updateProjectHealth', 'revokeMemberSessions',
  ],
  'org.logo': ['uploadOrgLogo'],
}

// 制限なしの管理者(全権管理者)の既定。今までの「代表または全権管理者のみ」の操作
export const FULL_ADMIN_DEFAULT_CAPABILITIES: readonly Capability[] = ['org.rules', 'trash']

// 最上位の役職だけの操作(どの設定でも渡さない)。GAS の TOP_ONLY_ACTIONS と、authorizeAction_ の
// バックアップ・個人情報の削除・利用の状況・集計値・診断情報(backupActions・privacyActions・opsActions)
export const TOP_ONLY_ACTIONS = ['updatePermissionOverrides'] as const

const CAPABILITY_BY_ACTION: Record<string, Capability> = Object.fromEntries(
  CAPABILITY_KEYS.flatMap((key) => CAPABILITY_ACTIONS[key].map((action) => [action, key])),
)

/** GAS の操作が入るまとまり(まとまりに入らない操作は undefined) */
export function capabilityOfAction(action: string): Capability | undefined {
  return CAPABILITY_BY_ACTION[action]
}

/** 知っているキーだけを、決まった順で(重複なし) */
export function normalizeCapabilities(list: readonly unknown[] | undefined | null): Capability[] {
  const seen = new Set((list ?? []).map(String))
  return CAPABILITY_KEYS.filter((k) => seen.has(k))
}

// ---- 画面の操作と capability の対応表 ------------------------------------------------
//
// 画面の部品が呼ぶ store の関数(lib/ohsumi/store.tsx)と、その関数が送る GAS の操作のまとまり。
// GAS がまとまりで判定する操作を送る関数は、すべてここに書く(store の中で別の関数を通して送るものも)。
// 画面のファイルがこの関数を使う時は、同じファイルで can('まとまり') を確かめ、無い人には部品を出さない
// (見せた方が分かりやすい所は押せない状態にして、CapabilityNote で理由を1行出す)。
// lib/ohsumi/capabilities-ui.test.ts が、store から作った対応とこの表が同じこと・画面のファイルが
// can で確かめていることを調べる。e2e(e2e/browser.e2e.ts)は、5人の役職で ADMIN の全タブを開き、
// data-gas-action の付いた部品が GAS で通ること・通らない操作の部品が出ていないことを確かめる。
export const STORE_ACTION_CAPABILITIES: Record<string, Capability> = {
  addCandidate: 'recruiting',
  addCategoryOption: 'org.rules',
  addDepartment: 'org.rules',
  addMember: 'members.add',
  addOrgNotificationEmail: 'org.rules',
  addRecurringRule: 'org.rules',
  addRoleLevel: 'org.rules',
  addSkillFieldOption: 'org.rules',
  addSkillOption: 'org.rules',
  addTaskSetTemplate: 'org.rules',
  convertCandidateToMember: 'recruiting',
  moveDepartmentTasks: 'org.rules',
  notifyTrainingDecision: 'members.training',
  purgeTask: 'trash',
  refreshWebhookStatus: 'org.rules',
  removeCandidate: 'recruiting',
  removeCategoryOption: 'org.rules',
  removeDepartment: 'org.rules',
  removeMember: 'members.remove',
  removeOrgNotificationEmail: 'org.rules',
  removeProject: 'projects.remove',
  removeProjectType: 'org.rules',
  removeRecurringRule: 'org.rules',
  removeRoleLevel: 'org.rules',
  removeSkillFieldOption: 'org.rules',
  removeSkillOption: 'org.rules',
  removeTaskSetTemplate: 'org.rules',
  renameDepartment: 'org.rules',
  renameRole: 'org.rules',
  reorderDepartment: 'org.rules',
  reorderRoleLevel: 'org.rules',
  restoreDepartment: 'org.rules',
  restoreTask: 'trash',
  revokeMemberSessions: 'org.rules',
  saveDepartments: 'org.rules',
  saveRoles: 'org.rules',
  setDiscordWebhookUrl: 'org.rules',
  setJobRequirements: 'org.rules',
  setOneOnOneQuestions: 'org.rules',
  setOrgLogoUrl: 'org.rules',
  setOrgName: 'org.rules',
  setProjectOrder: 'org.rules',
  setProjectTemplateTasks: 'org.rules',
  setRoleCapabilities: 'org.rules',
  setRolePermissions: 'org.rules',
  setRoleTier: 'org.rules',
  setSkillFieldSkills: 'org.rules',
  setSkillFieldThreshold: 'org.rules',
  setSlackWebhookUrl: 'org.rules',
  setThemeColor: 'org.rules',
  testWebhook: 'org.rules',
  toggleRecurringRule: 'org.rules',
  toggleRestrictedRole: 'org.rules',
  updateCandidate: 'recruiting',
  updateCustomFormDefs: 'org.rules',
  updateCustomMemberColumns: 'org.rules',
  updateDepartmentTreeConfig: 'org.rules',
  updateEmail: 'members.hr',
  updateExpenseCategories: 'org.rules',
  updateJoinedAt: 'members.hr',
  updateLearningContents: 'org.rules',
  updateLearningCourses: 'org.rules',
  updateMemberProjects: 'members.hr',
  updateMentor: 'members.hr',
  updateProjectHealth: 'org.rules',
  updateQuizDefinitions: 'org.rules',
  updateRadarAxes: 'org.rules',
  updateRecurringRule: 'org.rules',
  updateReportsTo: 'members.hr',
  updateRole: 'members.role',
  updateRoleDef: 'org.rules',
  updateSkillLevelRules: 'org.rules',
  updateSkillLevelThresholds: 'org.rules',
  updateSurveyInvitedIds: 'org.rules',
  updateSurveyQuestions: 'org.rules',
  updateTaskSetTemplateItems: 'org.rules',
  updateTrainingPrograms: 'org.rules',
  uploadOrgLogo: 'org.logo',
}
