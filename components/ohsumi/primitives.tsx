'use client'

import { useDepartmentLabel } from '@/lib/ohsumi/use-department-label'
import { cn } from '@/lib/utils'
import { isSafeHttpUrl } from '@/lib/ohsumi/utils'
import { TriangleAlert } from 'lucide-react'
import {
  STATUS_COLOR,
  PRIORITY_LINE,
  type Difficulty,
  type Priority,
  type TaskStatus,
  } from '@/lib/ohsumi/types'
import type { Member, Department, Task } from '@/lib/ohsumi/types'
import { useI18n, STATUS_KEY, DIFFICULTY_KEY, PRIORITY_KEY, departmentLabel } from '@/lib/ohsumi/i18n'
import { useOhsumi } from '@/lib/ohsumi/store'
import { useFileUrl } from '@/lib/ohsumi/files'

export function Avatar({
  member,
  size = 28,
  className,
}: {
  member?: Member | null
  size?: number
  className?: string
}) {
  // アップロードした画像は非公開のため GAS 経由で取得する(取得できるまでは
  // 色とイニシャルを表示する)
  const avatarSrc = useFileUrl(member?.avatarUrl)
  if (!member) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-muted-foreground',
          className,
        )}
        style={{ width: size, height: size, fontSize: size * 0.36 }}
        aria-hidden
      >
        ?
      </span>
    )
  }
  if (avatarSrc) {
    return (
      <img
        src={avatarSrc}
        alt={member.displayName || member.name}
        title={member.displayName || member.name}
        className={cn('inline-block shrink-0 rounded-full object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className={cn(
        // イニシャル(漢字2文字など)が小さな丸の中で2行に折り返さないようにする
        'inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-full font-medium leading-none text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: member.avatarColor,
      }}
      title={member.displayName || member.name}
    >
      {member.initials}
    </span>
  )
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const color = STATUS_COLOR[status]
  const { t } = useI18n()
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
      <span
        className="inline-block size-2 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      {t(STATUS_KEY[status])}
    </span>
  )
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className="inline-block size-2 rounded-full"
      style={{ backgroundColor: STATUS_COLOR[status] }}
      aria-hidden
    />
  )
}

const difficultyStyles: Record<Difficulty, string> = {
  anyone: 'bg-primary/10 text-primary border-primary/20',
  beginner: 'bg-success-muted text-success border-success-border',
  some_exp: 'bg-warning-muted text-warning border-warning-border',
  experienced: 'bg-danger-muted text-danger border-danger-border',
  advanced: 'bg-purple-500/10 text-purple-600 border-purple-300 dark:text-purple-400 dark:border-purple-700',
}

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
        difficultyStyles[difficulty],
      )}
    >
      {t(DIFFICULTY_KEY[difficulty])}
    </span>
  )
}

export function Tag({
  children,
  className,
  onRemove,
}: {
  children: React.ReactNode
  className?: string
  onRemove?: () => void
}) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground',
        className,
      )}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground"
          aria-label={t('primitives.removeAria')}
        >
          ×
        </button>
      )}
    </span>
  )
}

export function ProjectTag({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span className="inline-block size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
      <span className="truncate" title={name}>{name}</span>
    </span>
  )
}

export function DepartmentTag({ name }: { name: Department }) {
  const { t } = useI18n()
  const deptLabel = useDepartmentLabel()
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-md border border-info-border bg-info-muted px-1.5 py-0.5 text-[11px] font-medium text-info">
      {deptLabel(name)}
    </span>
  )
}

export function UnassignedBadge({ className }: { className?: string }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md bg-warning-muted px-1.5 py-0.5 text-[11px] font-medium text-warning',
        className,
      )}
    >
      {t('output.list.unassigned')}
    </span>
  )
}

// Small priority indicator: filled dot + label. High priority is emphasized.
export function PriorityBadge({ priority }: { priority: Priority }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium',
        priority === 'high' ? 'text-danger' : 'text-muted-foreground',
      )}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: PRIORITY_LINE[priority] }}
        aria-hidden
      />
      {t('primitives.priorityLabel', { priority: t(PRIORITY_KEY[priority]) })}
    </span>
  )
}

export function Card({
  children,
  className,
  onClick,
  as: As = 'div',
}: {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  as?: 'div' | 'button'
}) {
  return (
    <As
      onClick={onClick}
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
        onClick &&
          'cursor-pointer text-left transition-all hover:border-border-strong hover:shadow-[0_2px_8px_rgba(16,24,40,0.06)]',
        className,
      )}
    >
      {children}
    </As>
  )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

// 権限モデル整理（gas/Code.gsのauthorizeAction）に合わせたUI注記。
// 「画面は見えるが実行するとGAS側で拒否される」ケースを事前に示す。
// - fullAdmin: updateSetting系(スキル/カテゴリ/役職レベル/団体名・ロゴURL
//   テキスト入力/テーマカラー/Webhook URL等)。isActingFullAdmin基準なので
//   restricted_rolesの設定次第でロールが変わる — 必ずisFullAdminを使う
//   （role==='代表'固定にしないこと。事業責任者等もtrueになりうる）。
// - daihyo: 常にisDaihyo固定のアクション（メンバー削除・ロール変更・
//   権限例外編集・採用管理など）。isFullAdminとは無関係に代表のみ。
export function AdminAccessNote({ level, className }: { level: 'fullAdmin' | 'daihyo'; className?: string }) {
  const { isTopRef, isFullAdmin, currentUser } = useOhsumi()
  const { t } = useI18n()
  const blocked = level === 'fullAdmin' ? !isFullAdmin : !isTopRef(currentUser?.role)
  if (!blocked) return null
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-warning', className)}>
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      {level === 'fullAdmin' ? t('admin.accessNote.fullAdmin') : t('admin.accessNote.daihyo')}
    </p>
  )
}

// TSK-064: 類似タスクの振り返り・成果物・実績工数をまとめて表示する共通
// コンポーネント。parsed-task-card.tsx(入力時の類似タスク警告)と
// admin-approvals.tsx(承認時の類似タスク警告)の両方で使う想定
export function SimilarTaskSummary({ task }: { task: Task }) {
  const { t } = useI18n()
  const note =
    task.status === 'done' && task.retrospective
      ? task.retrospective.improve || task.retrospective.bad || task.retrospective.good
      : null
  // http/https 以外(javascript: など)のリンクは出さない
  const deliverables = (task.deliverables ?? []).filter((d) => isSafeHttpUrl(d.url)).slice(0, 3)
  return (
    <li className="text-xs text-muted-foreground">
      ・{task.name}
      {note && <span className="block pl-3 text-[11px] italic">{note}</span>}
      {task.actualHours != null && (
        <span className="block pl-3 text-[11px]">
          {t('similarTask.actualHoursLabel', { hours: task.actualHours })}
        </span>
      )}
      {deliverables.length > 0 && (
        <span className="mt-0.5 flex flex-wrap gap-x-2 pl-3 text-[11px]">
          {deliverables.map((d) => (
            <a
              key={d.id}
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {d.label || d.url}
            </a>
          ))}
        </span>
      )}
    </li>
  )
}

// Ohsumi のロゴ(ブランドガイドライン v0.4)。docs/brand.md
//   - シンボル: 円形(縦横比 1:1)。輪と、右側の点。Ohsumi Blue(--ohsumi-blue)
//   - 文字: 「Ohsumi」。Ohsumi Navy(暗い表示では白。--ohsumi-wordmark)
//   - どの大きさでも縦横比を変えない(width と height を同じにし、縮まないようにする)。回転・影などの効果は付けない
//   - 団体のテーマの色(--primary の上書き)では変えない(--primary ではなく、ブランドの変数を使う)
// 輪と点の形は app/icon.svg・scripts/brand-icons.mjs と同じ
export const OHSUMI_SYMBOL_PATHS = { ring: { cx: 11, cy: 12, r: 8.4, strokeWidth: 2.1 }, dot: { cx: 19.4, cy: 12, r: 2.7 } }

export function OhsumiMark({ size = 22 }: { size?: number }) {
  const { ring, dot } = OHSUMI_SYMBOL_PATHS
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      data-ohsumi-symbol
      style={{ width: size, height: size, minWidth: size, flexShrink: 0, aspectRatio: '1 / 1', color: 'var(--ohsumi-blue)' }}
    >
      <circle cx={ring.cx} cy={ring.cy} r={ring.r} stroke="currentColor" strokeWidth={ring.strokeWidth} />
      <circle cx={dot.cx} cy={dot.cy} r={dot.r} fill="currentColor" />
    </svg>
  )
}

/** シンボル + 「Ohsumi」の文字。text: 文字を出すか('sm' は幅の広い画面だけ) */
export function OhsumiLogo({ size = 22, text = true, className = '' }: { size?: number; text?: boolean | 'sm'; className?: string }) {
  return (
    <span className={'inline-flex shrink-0 items-center ' + className} style={{ gap: Math.round(size * 0.36) }} data-ohsumi-logo>
      <OhsumiMark size={size} />
      {text && (
        <span
          className={(text === 'sm' ? 'hidden sm:inline ' : '') + 'font-bold leading-none tracking-tight'}
          style={{ fontSize: Math.round(size * 0.82), color: 'var(--ohsumi-wordmark)' }}
        >
          Ohsumi
        </span>
      )}
    </span>
  )
}

// アップロードした画像(団体ロゴ・アンケート画像など)を表示する <img>。
// 非公開のファイルは GAS 経由で取得し、取得できるまでは何も表示しない
export function StoredImage({ url, alt, className }: { url: string | undefined; alt: string; className?: string }) {
  const src = useFileUrl(url)
  if (!src) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} />
}
