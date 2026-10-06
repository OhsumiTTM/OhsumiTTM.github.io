'use client'

import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useNav } from '@/lib/ohsumi/nav'
import { useToast } from '@/components/ohsumi/toast'
import { Avatar, CapabilityNote } from '@/components/ohsumi/primitives'
import { EditableTags } from '@/components/ohsumi/editable-tags'
import { Modal } from '@/components/ohsumi/modal'
import { Button } from '@/components/ui/button'
import { Search, Bell, UserMinus, UserPlus, FolderKanban, Check, Upload, Pause, Play, LogOut } from 'lucide-react'
import { isRemoteConfigured } from '@/lib/ohsumi/remote'
import { useSiteLinkStatus } from '@/lib/ohsumi/use-site-link-status'
import { getActiveOrg, inviteLink } from '@/lib/ohsumi/org-directory'
import { findRole, roleAssignBlock, type RoleAssignBlock, type RoleDef } from '@/lib/ohsumi/roles'
import { useRoleLabel } from '@/lib/ohsumi/use-role-label'
import type { Member, Role } from '@/lib/ohsumi/types'
import { tenureYears, formatDepartmentPath, memberWorkloadCapacity } from '@/lib/ohsumi/utils'
import { WorkloadBadge } from '@/components/ohsumi/workload-badge'
import { PermissionOverridesButton } from './admin-permission-overrides'
import { useI18n, type TranslationKey } from '@/lib/ohsumi/i18n'
import { isValidEmail, needsGoogleAccountCheck } from '@/lib/ohsumi/member-email'

// HRD-009: CSV/xlsxのどちらも、同じ「行=[氏名,メール,所属,ロール]」の
// 2次元配列に正規化してから、この共通ロジックでプレビュー配列に変換する
function parseBulkMemberRows(
  rows2d: string[][],
  roles: RoleDef[],
  baseRoleId: string,
): { name: string; email: string; affiliation: string; role: Role }[] {
  if (rows2d.length < 2) return []
  // detect if first row is a header (contains 氏名 or name-like text)
  const startIdx = /氏名|name|名前/i.test(rows2d[0]?.[0] ?? '') ? 1 : 0
  return rows2d
    .slice(startIdx)
    .map((cols) => {
      const name = cols[0] ?? ''
      const email = cols[1] ?? ''
      const affiliation = cols[2] ?? ''
      // 役職は名前・ID のどちらで書かれていてもよい。一覧に無ければ一般
      const role = findRole(roles, cols[3])?.id ?? baseRoleId
      return { name, email, affiliation, role }
    })
    .filter((r) => r.name)
}

export function AdminMembers() {
  const {
    members,
    projects,
    visibleTasks: tasks,
    updateNotify,
    removeMember,
    updateRole,
    updateReportsTo,
    updateMemberProjects,
    updateJudgment,
    skillOptions,
    addSkillOption,
    roles,
    baseRoleId,
    isAdminRef,
    restrictedRoles,
    addMember,
    isFullAdmin,
    toggleMemberInactive,
    currentUser,
    revokeMemberSessions,
    can,
    workloadTasks,
    workloadRules,
  } = useOhsumi()
  // 「代表だけ」だった操作は、できる操作(capabilities.ts)ごとに出し分ける。GAS も同じ一覧で判定する
  const canAdd = can('members.add')
  const canChangeRole = can('members.role')
  const canRemove = can('members.remove')
  const canHr = can('members.hr')
  const canRules = can('org.rules')
  // 自分が付けられる役職か(最上位でない人は、最上位・自分より広い役職を付けられない。GAS の assertRoleAssignable_ と同じ)
  const me = { id: currentUser?.id ?? '', role: currentUser?.role }
  const assignableRoleIds = (target?: Member) =>
    roles.filter((r) => roleAssignBlock(roles, me, r.id, target ? { id: target.id, role: target.role } : undefined) === null).map((r) => r.id)
  const roleChangeBlock = (target: Member): RoleAssignBlock | null => roleAssignBlock(roles, me, undefined, { id: target.id, role: target.role })
  const ROLE_BLOCK_KEY: Partial<Record<RoleAssignBlock, TranslationKey>> = {
    self: 'admin.roles.assign.self',
    targetTop: 'admin.roles.assign.targetTop',
    targetStronger: 'admin.roles.assign.targetStronger',
  }
  const roleName = useRoleLabel()
  // メンバーの役職の ID(移行の途中で役職名のまま残っていても、一覧の ID にそろえる)
  const roleIdOf = (ref: string) => findRole(roles, ref)?.id ?? ref
  const { go } = useNav()
  const toast = useToast()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [removing, setRemoving] = useState<Member | null>(null)
  const [assigningProjects, setAssigningProjects] = useState<Member | null>(null)
  // 人材検索: filters beyond the free-text query, using the talent-management
  // fields set on the person page's 経歴・キャリア tab。経験年数（自己申告の
  // 概数）ではなく、正確な所属日(joinedAt)ベースの所属歴で絞り込む
  const [minTenureYears, setMinTenureYears] = useState('')
  const [managementOnly, setManagementOnly] = useState(false)
  const [desiredArea, setDesiredArea] = useState('')
  // MAT-003: 経歴(careerHistory)のrole/affiliation/descriptionから検索する
  const [experienceQuery, setExperienceQuery] = useState('')
  // HRD-006: 休止中メンバーはデフォルトで一覧から除外する
  const [showInactive, setShowInactive] = useState(false)
  const ROLES: Role[] = roles.map((r) => r.id)

  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newAffiliation, setNewAffiliation] = useState('')
  const [newRole, setNewRole] = useState<Role>(baseRoleId)
  // 招待メールを送る(初期値は送る。レジストリに確かめていない団体では選べない)
  const [sendInvite, setSendInvite] = useState(true)
  const inviteMail = useSiteLinkStatus(canAdd)
  const addableRoles = assignableRoleIds()

  const [csvPreview, setCsvPreview] = useState<{ name: string; email: string; affiliation: string; role: Role }[] | null>(null)

  // HRD-009: 拡張子で分岐 — .xlsxはSheetJS(xlsx)で最初のシートを読み込み、
  // .csvは既存のテキスト解析のまま。どちらも同じparseBulkMemberRowsに渡す
  const handleBulkFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (/\.xlsx$/i.test(file.name)) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const data = ev.target?.result as ArrayBuffer
        const wb = XLSX.read(data, { type: 'array' })
        const sheet = wb.Sheets[wb.SheetNames[0]]
        if (!sheet) return
        const rows2d = XLSX.utils
          .sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
          .map((cols) => cols.map((c) => String(c ?? '').trim()))
        const rows = parseBulkMemberRows(rows2d, roles, baseRoleId)
        if (rows.length) setCsvPreview(rows)
      }
      reader.readAsArrayBuffer(file)
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const rows2d = text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
      const rows = parseBulkMemberRows(rows2d, roles, baseRoleId)
      if (rows.length) setCsvPreview(rows)
    }
    reader.readAsText(file)
  }

  const handleBulkAdd = () => {
    if (!csvPreview) return
    // メールアドレスの無い・形の違う行は追加しない(メールアドレスが無いとログインできないため)。
    // 付けられない役職の行も追加しない(GAS も断る)
    const rows = csvPreview.filter((r) => isValidEmail(r.email) && addableRoles.includes(r.role))
    const skipped = csvPreview.length - rows.length
    setCsvPreview(null)
    if (skipped > 0) toast(t('admin.members.bulkSkippedNoEmail', { count: skipped }))
    if (rows.length === 0) return
    Promise.allSettled(rows.map((r) => addMember(r.name, r.email.trim(), r.affiliation, r.role, sendInvite && inviteMail.available))).then(
      (results) => {
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed > 0) {
          const firstErr = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
          toast(t('admin.members.bulkFailToast', { count: failed, error: firstErr instanceof Error ? firstErr.message : String(firstErr) }))
        } else {
          toast(t('admin.members.bulkSuccessToast', { count: rows.length }))
        }
      },
    )
  }

  const handleAddMember = () => {
    const name = newName.trim()
    if (!name || !isValidEmail(newEmail)) return
    setNewName('')
    setNewEmail('')
    setNewAffiliation('')
    setNewRole(baseRoleId)
    const email = newEmail.trim()
    addMember(name, email, newAffiliation.trim(), newRole, sendInvite && inviteMail.available && !!email)
      .then((invite) => {
        toast(t('admin.members.addedToast', { name }))
        if (invite) toast(t(invite.sent ? 'admin.members.invite.mailSent' : invite.reason === 'mailQuota' ? 'admin.members.invite.mailQuota' : 'admin.members.invite.mailNotSent'))
      })
      .catch((err: unknown) => {
        toast(t('admin.members.addFailToast', { error: err instanceof Error ? err.message : String(err) }))
      })
  }

  const activeCount = (m: Member) =>
    tasks.filter((t) => t.assigneeIds.includes(m.id) && t.status !== 'done').length

  // 全メンバーが持つ「成長したい領域」の一覧 — 詳細検索の選択肢に使う
  const allDesiredAreas = useMemo(
    () => Array.from(new Set(members.flatMap((m) => m.desiredAreas ?? []))).sort(),
    [members],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const minTenure = minTenureYears.trim() ? Number(minTenureYears) : null
    return members.filter((m) => {
      // 退会したメンバーは出さない(団体設定の「個人情報の削除」に出る)
      if (m.withdrawnAt) return false
      if (!showInactive && m.inactive) return false
      if (q) {
        const matchesText = [
          m.name,
          m.displayName ?? '',
          m.affiliation,
          ...m.will,
          ...m.judgment,
          ...m.skills,
        ].some((v) => v.toLowerCase().includes(q))
        if (!matchesText) return false
      }
      if (minTenure !== null && (!m.joinedAt || tenureYears(m.joinedAt) < minTenure)) return false
      if (managementOnly && !m.hasManagementExperience) return false
      if (desiredArea && !(m.desiredAreas ?? []).includes(desiredArea)) return false
      if (experienceQuery.trim()) {
        const eq = experienceQuery.trim().toLowerCase()
        const matches = (m.careerHistory ?? []).some((entry) =>
          [entry.role, entry.affiliation, entry.description]
            .filter((v): v is string => !!v)
            .some((v) => v.toLowerCase().includes(eq)),
        )
        if (!matches) return false
      }
      return true
    })
  }, [members, query, minTenureYears, managementOnly, desiredArea, experienceQuery, showInactive])

  return (
    <div>
      <p className="text-sm text-muted-foreground">
        {t('admin.members.subtitle')}
      </p>
      <InviteLinkCard />

      {/* メンバーの登録・招待(できる操作 members.add の人だけ) */}
      {!canAdd && <CapabilityNote cap="members.add" className="mt-6" />}
      {canAdd && (
      <div className="mt-6 rounded-lg border border-border bg-card p-4" data-gas-action="addMember">
        <div className="text-sm font-medium">{t('admin.members.register.title')}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('admin.members.register.hint')}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1.2fr_1.2fr_1fr_0.8fr_auto]">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('admin.members.register.namePlaceholder')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder={t('admin.members.register.emailPlaceholder')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <input
            value={newAffiliation}
            onChange={(e) => setNewAffiliation(e.target.value)}
            placeholder={t('admin.members.register.affiliationPlaceholder')}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="h-9 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-primary"
          >
            {addableRoles.map((r) => (
              <option key={r} value={r}>
                {roleName(r)}
              </option>
            ))}
          </select>
          <Button className="h-9" disabled={!newName.trim() || !isValidEmail(newEmail) || !addableRoles.includes(newRole)} onClick={handleAddMember}>
            <UserPlus className="size-4" />
            {t('admin.members.register.submit')}
          </Button>
        </div>
        {newEmail.trim() !== '' && !isValidEmail(newEmail) && (
          <p className="mt-2 text-xs text-destructive">{t('admin.members.register.emailInvalid')}</p>
        )}
        {needsGoogleAccountCheck(newEmail) && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t('admin.members.register.nonGmailWarning')}</p>
        )}
        {/* 招待メール: 登録したアドレスに、団体の招待リンクを送る(リンクは GAS が作る。レジストリに確かめた団体だけ) */}
        <label className="mt-3 flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={sendInvite && inviteMail.available}
            disabled={!inviteMail.available}
            onChange={(e) => setSendInvite(e.target.checked)}
          />
          <span>
            {t('admin.members.invite.mailOption')}
            <span className="block text-muted-foreground">
              {inviteMail.available ? t('admin.members.invite.mailHint') : inviteMail.checking ? t('otherDevice.mailChecking') : t('admin.members.invite.mailUnavailable')}
            </span>
          </span>
        </label>
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border-strong px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary">
            <Upload className="size-3.5" />
            {t('admin.members.register.csvBulk')}
            <input
              type="file"
              accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={handleBulkFileUpload}
            />
          </label>
          <span className="text-xs text-muted-foreground">{t('admin.members.register.csvFormat')}</span>
        </div>
        {addableRoles.length < ROLES.length && <p className="mt-2 text-xs text-muted-foreground">{t('admin.roles.assign.limited')}</p>}
      </div>
      )}

      {csvPreview && (
        <Modal open={!!csvPreview} onClose={() => setCsvPreview(null)}>
          <div className="flex flex-col gap-4 p-5">
            <div className="text-sm font-semibold">{t('admin.members.csv.previewTitle', { count: csvPreview.length })}</div>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="pb-1 pr-3 text-left font-medium">{t('admin.members.csv.colName')}</th>
                    <th className="pb-1 pr-3 text-left font-medium">{t('admin.members.csv.colEmail')}</th>
                    <th className="pb-1 pr-3 text-left font-medium">{t('admin.members.csv.colAffiliation')}</th>
                    <th className="pb-1 text-left font-medium">{t('admin.members.csv.colRole')}</th>
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.map((r, i) => (
                    <tr key={i} className="border-b border-border/40">
                      <td className="py-1 pr-3">{r.name}</td>
                      <td className={isValidEmail(r.email) ? 'py-1 pr-3 text-muted-foreground' : 'py-1 pr-3 text-destructive'}>
                        {isValidEmail(r.email) ? r.email : t('admin.members.csv.emailRequired')}
                      </td>
                      <td className="py-1 pr-3 text-muted-foreground">{r.affiliation || '—'}</td>
                      <td className={addableRoles.includes(r.role) ? 'py-1 text-muted-foreground' : 'py-1 text-destructive'}>
                        {roleName(r.role)}
                        {!addableRoles.includes(r.role) && <span className="block">{t('admin.roles.assign.limited')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCsvPreview(null)}>{t('admin.members.csv.cancel')}</Button>
              <Button onClick={handleBulkAdd} disabled={!canAdd}>
                <UserPlus className="size-4" />
                {t('admin.members.csv.submit', { count: csvPreview.length })}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            data-read-only-ok
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('admin.members.search.placeholder')}
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        <input
          type="number"
          min={0}
          value={minTenureYears}
          data-read-only-ok
          onChange={(e) => setMinTenureYears(e.target.value)}
          placeholder={t('admin.members.search.tenurePlaceholder')}
          title={t('admin.members.search.tenureTitle')}
          className="h-9 w-28 rounded-lg border border-border bg-card px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <input
          value={experienceQuery}
          data-read-only-ok
          onChange={(e) => setExperienceQuery(e.target.value)}
          placeholder={t('admin.members.search.experiencePlaceholder')}
          title={t('admin.members.search.experienceTitle')}
          className="h-9 w-40 rounded-lg border border-border bg-card px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <label className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm">
          <input
            type="checkbox"
            checked={managementOnly}
            onChange={(e) => setManagementOnly(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          {t('admin.members.search.managementOnly')}
        </label>
        <label className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          {t('admin.members.search.showInactive')}
        </label>
        {allDesiredAreas.length > 0 && (
          <select
            value={desiredArea}
            onChange={(e) => setDesiredArea(e.target.value)}
            className="h-9 cursor-pointer rounded-lg border border-border bg-card px-2.5 text-sm outline-none focus:border-primary"
          >
            <option value="">{t('admin.members.search.desiredAreaAll')}</option>
            {allDesiredAreas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t('admin.members.colMember')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.members.colRole')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.members.colReportsTo')}</th>
                {isFullAdmin && <th className="px-4 py-3 font-medium">{t('admin.members.colProjects')}</th>}
                <th className="px-4 py-3 font-medium">{t('admin.members.colActive')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.members.colWill')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.members.colJudgment')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.members.colStatus')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.members.colNotify')}</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((m) => {
                const count = activeCount(m)
                // 稼働の目安は担当者を選ぶ画面のバッジと同じ計算(団体の設定 workload_rules)
                const capacity = memberWorkloadCapacity(m.id, workloadTasks, undefined, workloadRules)
                return (
                  <tr key={m.id} className="transition-colors hover:bg-accent/40">
                    <td className="cursor-pointer px-4 py-3" onClick={() => go({ name: 'person', id: m.id })}>
                      <div className="flex items-center gap-2.5">
                        <Avatar member={m} size={30} />
                        <div>
                          <div className="font-medium">{m.displayName || m.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.departmentPaths && m.departmentPaths.length > 0
                              ? m.departmentPaths.map(formatDepartmentPath).join('　/　')
                              : m.affiliation}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        // 役職の変更(members.role)。自分・最上位の人・自分より広い人の役職は変えられない(理由を1行出す)
                        const block = canChangeRole ? roleChangeBlock(m) : null
                        if (!canChangeRole || block) {
                          const reason = block ? ROLE_BLOCK_KEY[block] : undefined
                          return (
                            <span className="text-xs text-muted-foreground">
                              {roleName(m.role)}
                              {reason && <span className="mt-0.5 block text-[11px]">{t(reason)}</span>}
                            </span>
                          )
                        }
                        const options = assignableRoleIds(m)
                        const current = roleIdOf(m.role)
                        return (
                          <select
                            value={current}
                            data-gas-action="updateRole"
                            data-member-id={m.id}
                            onChange={(e) => updateRole(m.id, e.target.value as Role)}
                            className="h-8 cursor-pointer rounded-md border border-border bg-background px-1.5 text-xs outline-none focus:border-primary"
                          >
                            {(options.includes(current) ? options : [current, ...options]).map((r) => (
                              <option key={r} value={r} disabled={r === current && !options.includes(r)}>
                                {roleName(r)}
                              </option>
                            ))}
                          </select>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {canHr ? (
                        <select
                          value={m.reportsToId ?? ''}
                          data-gas-action="updateReportsTo"
                          onChange={(e) => updateReportsTo(m.id, e.target.value || null)}
                          className="h-8 w-32 cursor-pointer rounded-md border border-border bg-background px-1.5 text-xs outline-none focus:border-primary"
                        >
                          <option value="">{t('admin.members.reportsToDefault')}</option>
                          {members
                            .filter((cand) => cand.id !== m.id && isAdminRef(cand.role))
                            .map((cand) => (
                              <option key={cand.id} value={cand.id}>
                                {cand.displayName || cand.name}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {members.find((cand) => cand.id === m.reportsToId)?.displayName ??
                            members.find((cand) => cand.id === m.reportsToId)?.name ??
                            t('admin.members.reportsToDefault')}
                        </span>
                      )}
                    </td>
                    {isFullAdmin && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {restrictedRoles.includes(roleIdOf(m.role)) ? (
                          canHr ? (
                            <button
                              onClick={() => setAssigningProjects(m)}
                              data-gas-action="updateMemberProjects"
                              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-secondary"
                            >
                              <FolderKanban className="size-3.5" />
                              {t('admin.members.projectsCount', { count: (m.projectIds ?? []).length })}
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t('admin.members.projectsCount', { count: (m.projectIds ?? []).length })}</span>
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {!isAdminRef(m.role) ? '—' : t('admin.members.projectsAll')}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <span className="font-mono tabular-nums">{count}</span>
                    </td>
                    <td className="max-w-[200px] px-4 py-3 text-xs text-muted-foreground">
                      {m.will.length > 0 ? m.will.join(' / ') : '—'}
                    </td>
                    <td className="min-w-[220px] max-w-[280px] px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <EditableTags
                        tags={m.judgment}
                        editable
                        onChange={(next) => updateJudgment(m.id, next)}
                        emptyText="—"
                        placeholder={t('admin.members.judgmentPlaceholder')}
                        variant="judgment"
                        options={skillOptions}
                        onNewOption={canRules ? addSkillOption : undefined}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <WorkloadBadge capacity={capacity} className="text-xs" />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => updateNotify(m.id, !m.notify)}
                        className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                          m.notify
                            ? 'border-primary/30 bg-primary-muted text-accent-foreground'
                            : 'border-border text-muted-foreground hover:bg-secondary'
                        }`}
                      >
                        <Bell className="size-3.5" />
                        {m.notify ? 'ON' : 'OFF'}
                      </button>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleMemberInactive(m.id)}
                          title={m.inactive ? t('admin.members.resumeActivity') : t('admin.members.pauseActivity')}
                          className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                            m.inactive
                              ? 'border-amber-300/50 bg-amber-50 text-amber-600 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-400'
                              : 'border-border text-muted-foreground hover:bg-secondary'
                          }`}
                        >
                          {m.inactive ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                          {m.inactive ? t('admin.members.resume') : t('admin.members.pause')}
                        </button>
                        {isFullAdmin && <PermissionOverridesButton member={m} />}
                        {/* 全端末でログアウトさせる(スマートフォンの紛失・退会時など) */}
                        {canRules && isRemoteConfigured && m.id !== currentUser?.id && (
                          <button
                            data-gas-action="revokeMemberSessions"
                            onClick={async () => {
                              const name = m.displayName || m.name
                              if (!window.confirm(t('admin.members.revokeSessionsConfirm', { name }))) return
                              try {
                                await revokeMemberSessions(m.id)
                                toast(t('admin.members.revokeSessionsDone', { name }))
                              } catch (e) {
                                toast(t('admin.members.revokeSessionsFailed', { error: e instanceof Error ? e.message : String(e) }))
                              }
                            }}
                            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                          >
                            <LogOut className="size-3.5" />
                            {t('admin.members.revokeSessions')}
                          </button>
                        )}
                        {canRemove && (
                          <button
                            onClick={() => setRemoving(m)}
                            data-gas-action="removeMember"
                            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                          >
                            <UserMinus className="size-3.5" />
                            {t('admin.members.remove')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={isFullAdmin ? 10 : 9}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
                    {t('admin.members.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={!!removing} onClose={() => setRemoving(null)}>
        <h2 className="text-base font-semibold">{t('admin.members.removeConfirmTitle', { name: removing?.name ?? '' })}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('admin.members.removeConfirmDesc')}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" className="h-9" onClick={() => setRemoving(null)}>
            {t('admin.members.cancel')}
          </Button>
          <Button
            variant="destructive"
            className="h-9"
            disabled={!canRemove}
            onClick={() => {
              if (removing) {
                removeMember(removing.id)
                toast(t('admin.members.removedToast', { name: removing.name }))
              }
              setRemoving(null)
            }}
          >
            {t('admin.members.removeSubmit')}
          </Button>
        </div>
      </Modal>

      <Modal open={!!assigningProjects} onClose={() => setAssigningProjects(null)}>
        <h2 className="text-base font-semibold">
          {t('admin.members.assignProjectsTitle', { name: assigningProjects?.displayName || assigningProjects?.name || '' })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('admin.members.assignProjectsDesc')}
        </p>
        <div className="mt-3 flex max-h-80 flex-col gap-1 overflow-auto ohsumi-scroll">
          {projects.map((p) => {
            const checked = !!assigningProjects?.projectIds?.includes(p.id)
            return (
              <button
                key={p.id}
                onClick={() => {
                  if (!assigningProjects) return
                  const cur = assigningProjects.projectIds ?? []
                  const next = checked ? cur.filter((id) => id !== p.id) : [...cur, p.id]
                  updateMemberProjects(assigningProjects.id, next)
                  setAssigningProjects({ ...assigningProjects, projectIds: next })
                }}
                className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-secondary ${
                  checked ? 'bg-primary-muted' : ''
                }`}
              >
                {p.name}
                {checked && <Check className="size-4 shrink-0 text-primary" strokeWidth={3} />}
              </button>
            )
          })}
          {projects.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t('admin.members.noProjects')}</p>
          )}
        </div>
        <div className="mt-5 flex justify-end">
          <Button className="h-9" onClick={() => setAssigningProjects(null)}>
            {t('admin.members.close')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

// 招待リンク(<サイトの URL>/?org=<団体ID>)。メンバーは初めての端末でこのリンクから開く(R1-d)。
// 団体ID は秘密ではないが、リンクはメンバーにだけ伝える(ログインはメンバーとして登録した Google アカウントだけができる)
function InviteLinkCard() {
  const { t } = useI18n()
  const toast = useToast()
  const orgId = getActiveOrg().orgId
  if (!isRemoteConfigured || !orgId || typeof window === 'undefined') return null
  const link = inviteLink(window.location.origin, '', orgId)
  const copy = () => {
    navigator.clipboard?.writeText(link).then(
      () => toast(t('admin.members.invite.copied')),
      () => toast(t('admin.members.invite.copyFailed')),
    )
  }
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-4">
      <div className="text-sm font-medium">{t('admin.members.invite.title')}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.members.invite.hint')}</p>
      <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs"
          aria-label={t('admin.members.invite.title')}
        />
        <Button type="button" size="sm" variant="outline" onClick={copy} className="shrink-0">
          {t('admin.members.invite.copy')}
        </Button>
      </div>
    </div>
  )
}
