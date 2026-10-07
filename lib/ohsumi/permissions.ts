// Pure, framework-free permission/routing logic pulled out of store.tsx and
// the admin components so it can be unit-tested (see permissions.test.ts)
// without mounting the whole React context. These are the actual functions
// the app calls, not a parallel reimplementation — keep them in sync by
// editing here, not by re-inlining the logic elsewhere.
import { ADMIN_SECTIONS, STATUS_ORDER } from './types'
import { migrateAdminSections } from './admin-sections'
import { isAdminRoleRef, isFullAdminRoleRef, restrictedSections, type RoleDef } from './roles'
import type { AdminSection, Member, Role, Task, TaskImportance, TaskStatus } from './types'

// 全権管理者: 最上位の役職、または制限の無い管理者の役職(roles.ts)。
// See store.tsx's isFullAdminMember for the Member-object wrapper.
export function isFullAdminRole(roles: RoleDef[], role: Role | null | undefined): boolean {
  return isFullAdminRoleRef(roles, role)
}

// Which admin-screen sections a role can see — falls back to
// DEFAULT_NON_TOP_SECTIONS (everything but Members/Tags/Analytics) when no
// explicit per-role choice was configured. See store.tsx's
// visibleAdminSections for the currentUser-bound wrapper.
export function resolveVisibleAdminSections(roles: RoleDef[], role: Role | null | undefined): AdminSection[] {
  if (isFullAdminRoleRef(roles, role)) return ADMIN_SECTIONS.map((s) => s.key)
  if (!isAdminRoleRef(roles, role)) return []
  // 以前のタブのキーで保存されていても、今のタブに読み替える(lib/ohsumi/admin-sections.ts)
  const sections = migrateAdminSections(restrictedSections(roles, role))
  // dashboard is the redirect target for a disallowed section, so it must
  // always stay reachable to avoid a redirect loop
  return sections.includes('dashboard') ? sections : ['dashboard', ...sections]
}

// ---- タスクのステータス遷移 --------------------------------------------------

// Only a full admin (isActingFullAdmin) or the task's own assignee may
// change its status at all — matches gas/Code.gs's updateTaskStatus,
// which requires isActingFullAdmin OR assignee for any non-完了 change.
// A merely non-一般 admin role (isAdminRole) is NOT sufficient on its own.
export function canChangeTaskStatus(isFullAdmin: boolean, isAssignee: boolean): boolean {
  return isFullAdmin || isAssignee
}

// Which status an assignee/full-admin/reviewer may set the task to. Every
// status is reachable from every other status (no from-state restriction)
// except 完了, which only a full admin (isActingFullAdmin) or reviewer can
// set — matches gas/Code.gs's updateTaskStatus. An assignee's own "I'm done"
// signal is 確認待ち, which a reviewer/full-admin then confirms into 完了.
// When the task has one or more reviewers assigned (hasReviewers), 完了 is
// excluded entirely from this direct-status-change list — it can then only
// be reached via the dedicated approval flow (approveTaskReview), which
// tracks who has approved and enforces requiredApprovals. See
// task-detail-drawer.tsx's statusOptions and list-view.tsx's inline status
// dropdown.
export function allowedStatusOptions(
  isFullAdmin: boolean,
  isReviewer?: boolean,
  hasReviewers?: boolean,
  // 担当者(確認する人でない人)は「完了」を選べる(選ぶと確認待ちになる。doneTransition)
  isAssignee?: boolean,
  // 確認者がいないタスクの、確認する人(報告先・全権管理者。reviewTargets)
  isReviewTarget?: boolean,
): TaskStatus[] {
  return STATUS_ORDER.filter((s) => {
    if (s !== 'done') return true
    if (hasReviewers) return !!isAssignee && !isReviewer && !isFullAdmin
    return isFullAdmin || !!isReviewer || !!isReviewTarget || !!isAssignee
  })
}

// ---- 確認する人と、「完了」を選んだ時の状態(gas/src/10-authorize.gs の reviewTargets_・doneStatusFor_ と同じ決まり) ----

export type ReviewTargetKind = 'reviewers' | 'reportsTo' | 'fullAdmins'

/**
 * 確認待ちが届く人(確認する人)。タスクの確認者 → いなければ担当者の報告先 → それもいなければ全権管理者(代表を含む)。
 * 退会した人は除く。担当者自身は報告先・全権管理者の候補から除く(全員が担当者なら除かない)
 */
export function reviewTargets(
  task: Pick<Task, 'reviewerIds' | 'reviewerId' | 'assigneeIds'>,
  members: Pick<Member, 'id' | 'role' | 'reportsToId' | 'withdrawnAt'>[],
  roles: RoleDef[],
): { kind: ReviewTargetKind; ids: string[] } {
  const reviewerIds = task.reviewerIds ?? (task.reviewerId ? [task.reviewerId] : [])
  if (reviewerIds.length > 0) return { kind: 'reviewers', ids: reviewerIds }
  const assigneeIds = task.assigneeIds ?? []
  const active = new Map(members.filter((m) => !m.withdrawnAt).map((m) => [m.id, m]))
  const managers: string[] = []
  for (const aid of assigneeIds) {
    const managerId = active.get(aid)?.reportsToId
    if (managerId && active.has(managerId) && !assigneeIds.includes(managerId) && !managers.includes(managerId)) managers.push(managerId)
  }
  if (managers.length > 0) return { kind: 'reportsTo', ids: managers }
  const admins = [...active.values()].filter((m) => isFullAdminRoleRef(roles, m.role)).map((m) => m.id)
  const others = admins.filter((id) => !assigneeIds.includes(id))
  return { kind: 'fullAdmins', ids: others.length > 0 ? others : admins }
}

/**
 * 「完了」を選んだ時に実際に入る状態。全権管理者・確認する人は 'done'、担当者は 'review'(確認する人の承認で完了になる)、
 * それ以外の人は null(完了にできない)
 */
export function doneTransition(
  task: Pick<Task, 'reviewerIds' | 'reviewerId' | 'assigneeIds'>,
  userId: string | null | undefined,
  isFullAdmin: boolean,
  members: Pick<Member, 'id' | 'role' | 'reportsToId' | 'withdrawnAt'>[],
  roles: RoleDef[],
): 'done' | 'review' | null {
  if (isFullAdmin) return 'done'
  if (!userId) return null
  const targets = reviewTargets(task, members, roles)
  if (targets.ids.includes(userId)) return 'done'
  if ((task.assigneeIds ?? []).includes(userId)) return targets.ids.length > 0 ? 'review' : 'done'
  return null
}

// ---- 承認ルート（importanceに応じた承認者判定）------------------------------

// 重要/対外公開 タスクは登録者の報告先チェーンを経由せず、最上位の管理者
// （isFullAdmin）のみが承認できる（item 9: 承認ルートの拡張）。
export function isEscalatedTask(importance: TaskImportance | undefined): boolean {
  return importance === 'important' || importance === 'external'
}

// Mirrors admin-approvals.tsx's canApprove: a full admin can always
// approve. Otherwise, an escalated (重要/対外公開) task can only be
// approved by a full admin — nobody else, regardless of reportsToId.
// A non-escalated task can be approved by anyone unless the task
// creator's reportsToId names a specific approver, in which case only
// that approver (or a full admin) may approve it.
export function canApproveTask(
  isFullAdmin: boolean,
  importance: TaskImportance | undefined,
  approverId: string | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (isFullAdmin) return true
  if (isEscalatedTask(importance)) return false
  return !approverId || approverId === currentUserId
}
