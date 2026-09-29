import { describe, it, expect } from 'vitest'
import {
  isFullAdminRole,
  resolveVisibleAdminSections,
  canChangeTaskStatus,
  allowedStatusOptions,
  isEscalatedTask,
  canApproveTask,
} from './permissions'
import { STATUS_ORDER } from './types'
import { rolesFromLegacy } from './roles'

// 役職の一覧(移行前の設定から組み立てたもの)。この中では '班長' だけが制限付き
const ROLES = rolesFromLegacy({ restricted_roles: '班長' })
const UNRESTRICTED = rolesFromLegacy({})
// 移行後の役職の一覧(ID で持つ。名前を変えても判定は変わらない)
const CODED = [
  { id: 'base', name: 'Member', tier: 'base' as const },
  { id: 'r_leader', name: 'Team lead', tier: 'admin' as const, restricted: true, sections: ['projects' as const] },
  { id: 'top', name: 'President', tier: 'top' as const },
]

describe('isFullAdminRole', () => {
  it('一般 is never full admin', () => {
    expect(isFullAdminRole(ROLES, '一般')).toBe(false)
  })

  it('null/undefined role is never full admin', () => {
    expect(isFullAdminRole(ROLES, null)).toBe(false)
    expect(isFullAdminRole(ROLES, undefined)).toBe(false)
  })

  it('a restricted role is not full admin', () => {
    expect(isFullAdminRole(ROLES, '班長')).toBe(false)
  })

  it('unrestricted admin roles and the top role are full admin', () => {
    expect(isFullAdminRole(ROLES, '事業責任者')).toBe(true)
    expect(isFullAdminRole(ROLES, '代表')).toBe(true)
  })

  it('with no restricted roles, any non-一般 role is full admin', () => {
    expect(isFullAdminRole(UNRESTRICTED, '班長')).toBe(true)
    expect(isFullAdminRole(UNRESTRICTED, '代表')).toBe(true)
    expect(isFullAdminRole(UNRESTRICTED, '一般')).toBe(false)
  })

  it('a role name not in the list is still full admin (as before)', () => {
    expect(isFullAdminRole(ROLES, '未知の役職')).toBe(true)
  })

  it('after migration, roles are judged by their type, whatever their names are', () => {
    expect(isFullAdminRole(CODED, 'top')).toBe(true)
    expect(isFullAdminRole(CODED, 'President')).toBe(true)
    expect(isFullAdminRole(CODED, 'r_leader')).toBe(false)
    expect(isFullAdminRole(CODED, 'base')).toBe(false)
  })
})

describe('resolveVisibleAdminSections', () => {
  it('a full admin sees every admin section', () => {
    const sections = resolveVisibleAdminSections(ROLES, '代表')
    expect(sections).toEqual(
      expect.arrayContaining(['dashboard', 'approvals', 'assignments', 'projects', 'members', 'analytics', 'tags']),
    )
  })

  it('一般 sees no admin sections at all', () => {
    expect(resolveVisibleAdminSections(ROLES, '一般')).toEqual([])
  })

  it('a restricted role falls back to DEFAULT_NON_TOP_SECTIONS when unconfigured', () => {
    const sections = resolveVisibleAdminSections(ROLES, '班長')
    expect(sections).toEqual(expect.arrayContaining(['dashboard', 'approvals', 'assignments', 'projects']))
    expect(sections).not.toContain('members')
    expect(sections).not.toContain('tags')
  })

  it('an explicit sections entry overrides the default for a restricted role', () => {
    const roles = rolesFromLegacy({ restricted_roles: '班長', role_permissions: JSON.stringify({ 班長: ['projects'] }) })
    const sections = resolveVisibleAdminSections(roles, '班長')
    expect(sections).toEqual(expect.arrayContaining(['projects', 'dashboard']))
    expect(sections).not.toContain('approvals')
  })

  it('always includes dashboard even if the configured list omits it, to avoid a redirect loop', () => {
    expect(resolveVisibleAdminSections(CODED, 'r_leader')).toEqual(['dashboard', 'projects'])
  })
})

describe('canChangeTaskStatus', () => {
  it('a full admin can always change status', () => {
    expect(canChangeTaskStatus(true, false)).toBe(true)
  })

  it('the assignee can change status', () => {
    expect(canChangeTaskStatus(false, true)).toBe(true)
  })

  it('neither a full admin nor the assignee cannot change status — this also covers a restricted admin role (isAdminRole true but not isActingFullAdmin, e.g. a 班長 in restrictedRoles), since merely being a non-一般 admin role is not sufficient on its own, matching gas/Code.gs requiring isActingFullAdmin OR assignee', () => {
    expect(canChangeTaskStatus(false, false)).toBe(false)
  })
})

describe('allowedStatusOptions', () => {
  it('a non-full-admin cannot set 完了 (done) directly', () => {
    const options = allowedStatusOptions(false)
    expect(options).not.toContain('done')
    // every other status stays reachable
    expect(options).toEqual(STATUS_ORDER.filter((s) => s !== 'done'))
  })

  it('a full admin can set every status, including 完了', () => {
    expect(allowedStatusOptions(true)).toEqual(STATUS_ORDER)
  })

  it('when the task has reviewers, 完了 is excluded even for a full admin — only the dedicated approval flow can complete it', () => {
    expect(allowedStatusOptions(true, false, true)).not.toContain('done')
    expect(allowedStatusOptions(true, true, true)).not.toContain('done')
  })

  it('a reviewer (not full admin) can set 完了 only when the task has no reviewers list gating it via hasReviewers=false', () => {
    expect(allowedStatusOptions(false, true, false)).toContain('done')
    expect(allowedStatusOptions(false, false, false)).not.toContain('done')
  })
})

describe('isEscalatedTask', () => {
  it('重要 and 対外公開 are escalated', () => {
    expect(isEscalatedTask('important')).toBe(true)
    expect(isEscalatedTask('external')).toBe(true)
  })

  it('一般 and unset are not escalated', () => {
    expect(isEscalatedTask('normal')).toBe(false)
    expect(isEscalatedTask(undefined)).toBe(false)
  })
})

describe('canApproveTask', () => {
  it('a full admin can approve anything, escalated or not', () => {
    expect(canApproveTask(true, 'external', 'm-someone-else', 'm-me')).toBe(true)
    expect(canApproveTask(true, 'normal', undefined, 'm-me')).toBe(true)
  })

  it('a non-admin can never approve an escalated task, even if named as the approver', () => {
    expect(canApproveTask(false, 'important', 'm-me', 'm-me')).toBe(false)
    expect(canApproveTask(false, 'external', undefined, 'm-me')).toBe(false)
  })

  it('a non-admin can approve a non-escalated task with no designated approver', () => {
    expect(canApproveTask(false, 'normal', undefined, 'm-me')).toBe(true)
    expect(canApproveTask(false, undefined, undefined, 'm-me')).toBe(true)
  })

  it('a non-admin can approve a non-escalated task only if they are the designated approver', () => {
    expect(canApproveTask(false, 'normal', 'm-me', 'm-me')).toBe(true)
    expect(canApproveTask(false, 'normal', 'm-other', 'm-me')).toBe(false)
  })

  it('a non-admin with no current user id cannot match a designated approver', () => {
    expect(canApproveTask(false, 'normal', 'm-other', null)).toBe(false)
    expect(canApproveTask(false, 'normal', 'm-other', undefined)).toBe(false)
  })
})
