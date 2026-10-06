'use client'

// 管理画面(ADMIN)。タブはグループ(状況・仕事・人と組織・育成・申請と記録・設定)ごとに並べる(lib/ohsumi/admin-sections.ts)。
// パソコンは左のメニューにグループの見出し(見られるタブが無いグループは見出しごと出さない)、スマートフォンは上のタブを同じ順番で並べる。
// 各タブは、見出し(タブの名前)と1行の説明、まとまりごとの見出し、長い画面は上に目次(AdminBlocks)
import { useEffect, type ReactNode } from 'react'
import { useNav } from '@/lib/ohsumi/nav'
import { AdminDashboard } from './admin-dashboard'
import { AdminAssignments } from './admin-assignments'
import { AdminApprovals } from './admin-approvals'
import { AdminProjects } from './admin-projects'
import { AdminMembers } from './admin-members'
import { AdminAnalytics } from './admin-analytics'
import {
  CustomMemberColumnsEditor, FieldCompositionEditor, OneOnOneQuestionsEditor, PositionRequirementsEditor, RolesEditor,
  RoleVisibilityEditor, SkillOptionsEditor, SurveyInviteEditor, SurveyQuestionsEditor,
} from './admin-tags'
import { SkillLevelRulesEditor } from './skill-level-rules-editor'
import { AdminOrgTree } from './admin-org-tree'
import { AdminQuiz } from './admin-quiz'
import { AdminLearningContent } from './admin-learning-content'
import { AdminRadarAxes } from './admin-radar-axes'
import { AdminExpenses } from './admin-expenses'
import { AdminFormBuilder } from './admin-form-builder'
import { AdminMemberDb } from './admin-member-db'
import { LeadershipOverview, SuccessorSuggestions } from './admin-leadership'
import { AdminRecruiting } from './admin-recruiting'
import { AdminDailyReports } from './admin-daily-reports'
import { AdminBlocks, AdminPageHeader } from './admin-page'
import { SurveyAllResponses } from '../survey-screen'
import { OrgSettingsScreen } from '../org-settings-screen'
import { MailQuotaBanner } from './mail-quota-banner'
import { GasUpdateBanner } from './gas-update-banner'
import { BackupBanner } from './backup-banner'
import { PersonalDataBanner } from './personal-data-banner'
import { OpsBanner } from './ops-banner'
import { AnnouncementsBanner } from './announcements-banner'
import { useOhsumi } from '@/lib/ohsumi/store'
import { AdminAccessNote, OhsumiMark } from '../primitives'
import type { AdminSection } from '@/lib/ohsumi/types'
import { ADMIN_GROUPS } from '@/lib/ohsumi/admin-sections'
import { adminGroupTitleKey, adminSectionDescKey, adminSectionTitleKey } from '@/lib/ohsumi/admin-section-labels'
import {
  LayoutDashboard, UserPlus, FileClock, FolderPlus, Users, BarChart3, ListChecks, Network, GraduationCap, BookOpen,
  Receipt, FileText, Database, Briefcase, NotebookPen, Sparkles, MessagesSquare, Building2,
} from 'lucide-react'
import { useI18n } from '@/lib/ohsumi/i18n'
import { cn } from '@/lib/utils'

const ICONS: Record<AdminSection, ReactNode> = {
  dashboard: <LayoutDashboard className="size-4" />,
  analytics: <BarChart3 className="size-4" />,
  approvals: <FileClock className="size-4" />,
  assignments: <UserPlus className="size-4" />,
  projects: <FolderPlus className="size-4" />,
  taskSettings: <ListChecks className="size-4" />,
  members: <Users className="size-4" />,
  orgRoles: <Network className="size-4" />,
  memberdb: <Database className="size-4" />,
  recruiting: <Briefcase className="size-4" />,
  skillRules: <Sparkles className="size-4" />,
  quiz: <GraduationCap className="size-4" />,
  learning: <BookOpen className="size-4" />,
  oneOnOneSurvey: <MessagesSquare className="size-4" />,
  expenses: <Receipt className="size-4" />,
  forms: <FileText className="size-4" />,
  dailyReports: <NotebookPen className="size-4" />,
  orgSettings: <Building2 className="size-4" />,
}

function Plain({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
}

function SectionBody({ section }: { section: AdminSection }) {
  const { t } = useI18n()
  const { isFullAdmin } = useOhsumi()
  // 団体全体の設定(updateSetting。全権管理者だけが保存できる)を含むタブの注記
  const fullAdminNote = <AdminAccessNote level="fullAdmin" />
  switch (section) {
    case 'dashboard':
      return (
        <AdminBlocks
          blocks={[
            { id: 'home-now', title: t('admin.home.now'), content: <AdminDashboard /> },
            { id: 'home-org', title: t('admin.home.org'), desc: t(isFullAdmin ? 'admin.home.orgDescFull' : 'admin.home.orgDescScoped'), content: <LeadershipOverview /> },
          ]}
        />
      )
    case 'analytics':
      return (
        <AdminBlocks
          blocks={[
            { id: 'analytics-trends', title: t('admin.analytics.trendsTitle'), content: <AdminAnalytics /> },
            { id: 'analytics-team-radar', title: t('admin.radarAxes.team.title'), content: <AdminRadarAxes part="team" /> },
          ]}
        />
      )
    case 'approvals': return <Plain><AdminApprovals /></Plain>
    case 'assignments': return <Plain><AdminAssignments /></Plain>
    case 'projects': return <Plain><AdminProjects part="projects" /></Plain>
    case 'taskSettings': return <AdminProjects part="taskSettings" />
    case 'members': return <Plain><AdminMembers /></Plain>
    case 'orgRoles':
      return (
        <AdminBlocks
          blocks={[
            { id: 'org-tree', title: t('admin.orgRoles.treeTitle'), content: <AdminOrgTree /> },
            { id: 'org-roles', title: t('admin.tags.permissionLevels'), content: <><AdminAccessNote level="fullAdmin" className="mb-2" /><RolesEditor /></> },
            { id: 'org-role-visibility', title: t('admin.tags.visibilityByLevel'), content: <RoleVisibilityEditor /> },
            { id: 'org-successors', title: t('admin.leadership.successor.title'), content: <SuccessorSuggestions /> },
          ]}
        />
      )
    case 'memberdb':
      return (
        <AdminBlocks
          blocks={[
            { id: 'memberdb-list', title: t('admin.memberDb.title'), content: <AdminMemberDb /> },
            { id: 'memberdb-columns', title: t('admin.tags.customColumns.title'), content: <><AdminAccessNote level="fullAdmin" className="mb-2" /><CustomMemberColumnsEditor /></> },
          ]}
        />
      )
    case 'recruiting': return <Plain><AdminRecruiting /></Plain>
    case 'skillRules':
      return (
        <AdminBlocks
          note={fullAdminNote}
          blocks={[
            { id: 'skill-options', title: t('admin.skillRules.optionsTitle'), content: <SkillOptionsEditor /> },
            { id: 'skill-field-composition', title: t('admin.tags.fieldComposition'), content: <FieldCompositionEditor /> },
            { id: 'skill-position', title: t('admin.tags.positionRequirements'), content: <PositionRequirementsEditor /> },
            { id: 'skill-levels', title: t('admin.skillRules.title'), content: <SkillLevelRulesEditor /> },
            { id: 'skill-radar-axes', title: t('admin.radarAxes.title'), content: <AdminRadarAxes part="axes" /> },
          ]}
        />
      )
    case 'quiz': return <Plain><AdminQuiz /></Plain>
    case 'learning': return <Plain><AdminLearningContent /></Plain>
    case 'oneOnOneSurvey':
      return (
        <AdminBlocks
          note={fullAdminNote}
          blocks={[
            { id: 'one-on-one-questions', title: t('admin.tags.oneOnOne.title'), content: <OneOnOneQuestionsEditor /> },
            { id: 'survey-questions', title: t('admin.tags.surveyQuestions.title'), content: <SurveyQuestionsEditor /> },
            { id: 'survey-invite', title: t('admin.tags.surveyInvite.title'), content: <SurveyInviteEditor /> },
            { id: 'survey-responses', title: t('survey.tab.admin'), content: <SurveyAllResponses /> },
          ]}
        />
      )
    case 'expenses': return <Plain><AdminExpenses /></Plain>
    case 'forms': return <Plain><AdminFormBuilder /></Plain>
    case 'dailyReports': return <Plain><AdminDailyReports /></Plain>
    case 'orgSettings': return <OrgSettingsScreen embedded />
  }
}

export function AdminScreen({ section }: { section: AdminSection }) {
  const { go } = useNav()
  const { t } = useI18n()
  const { pendingTasks, visibleAdminSections, dataReady, isFullAdmin, currentUser, isTopRef, isAdminRef } = useOhsumi()
  // 採用（recruiting）はrolePermissions/visibleAdminSectionsのロール単位制御
  // とは独立に、permission_overrides(targetType:'recruiting')を個別に持つ
  // メンバーだけがアクセスできる（ロール自体には一切依存しない）
  const canAccessRecruiting =
    isFullAdmin ||
    (currentUser?.permissionOverrides ?? []).some(
      (ov) => ov.targetType === 'recruiting' && (ov.access === 'edit' || ov.access === 'approve'),
    )
  // 団体設定は、全権管理者だけ(右上のメニューの「団体設定」と同じ)
  const canSee = (key: AdminSection) =>
    key === 'recruiting' ? canAccessRecruiting : key === 'orgSettings' ? isFullAdmin && visibleAdminSections.includes(key) : visibleAdminSections.includes(key)
  const groups = ADMIN_GROUPS.map((g) => ({ key: g.key, sections: g.sections.filter(canSee) })).filter((g) => g.sections.length > 0)
  const allowed = canSee(section)

  // a scoped admin landing on a section they can't see (stale link, direct
  // nav) bounces to the dashboard instead of rendering it — but only once
  // dataReady, so this doesn't fire off of a still-empty/default
  // visibleAdminSections while the spreadsheet fetch is in flight
  useEffect(() => {
    if (dataReady && !allowed) {
      go({ name: 'admin', section: 'dashboard' })
    }
  }, [dataReady, allowed, go])

  if (!dataReady) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3">
        <OhsumiMark size={28} />
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span className="relative flex size-3">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40" />
            <span className="relative inline-flex size-3 rounded-full bg-primary" />
          </span>
          {t('app.loading')}
        </div>
      </div>
    )
  }

  if (!allowed) return null

  const badge = (key: AdminSection, className: string) =>
    key === 'approvals' && pendingTasks.length > 0 ? (
      <span className={cn('rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground', className)}>
        {pendingTasks.length}
      </span>
    ) : null

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      {/* パソコン: 左のメニュー(グループの見出し付き) */}
      <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 self-start overflow-y-auto border-r border-border bg-card md:block">
        <nav aria-label={t('admin.nav.section')} className="space-y-4 px-2 py-4">
          {groups.map((g) => (
            <div key={g.key} data-admin-group={g.key}>
              <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t(adminGroupTitleKey(g.key))}
              </div>
              <div className="space-y-0.5">
                {g.sections.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => go({ name: 'admin', section: key })}
                    aria-current={key === section ? 'page' : undefined}
                    data-admin-section={key}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      key === section ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    {ICONS[key]}
                    <span className="min-w-0 flex-1">{t(adminSectionTitleKey(key))}</span>
                    {badge(key, 'ml-auto')}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        {/* スマートフォン: 上のタブ(パソコンのメニューと同じ順番) */}
        <nav aria-label={t('admin.nav.section')} className="flex gap-1 overflow-x-auto border-b border-border bg-card px-4 py-2 md:hidden">
          {groups.flatMap((g) => g.sections).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => go({ name: 'admin', section: key })}
              aria-current={key === section ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors',
                key === section ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground',
              )}
            >
              {ICONS[key]}
              {t(adminSectionTitleKey(key))}
              {badge(key, '')}
            </button>
          ))}
        </nav>

        {isAdminRef(currentUser?.role) && <AnnouncementsBanner />}
        {isFullAdmin && <GasUpdateBanner />}
        {isTopRef(currentUser?.role) && <OpsBanner />}
        {isTopRef(currentUser?.role) && <BackupBanner />}
        {isTopRef(currentUser?.role) && <PersonalDataBanner />}
        {isFullAdmin && <MailQuotaBanner />}
        <div className="bg-background pb-10">
          <AdminPageHeader title={t(adminSectionTitleKey(section))} desc={t(adminSectionDescKey(section))} />
          <SectionBody section={section} />
        </div>
      </div>
    </div>
  )
}
