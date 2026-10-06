'use client'

// 切り替えタブ(セグメント)。OUTPUT の表示・ヘッダーのモード・日報・学習コンテンツ・フォームの編集/プレビューで使う。
//   ・選んでいるタブ: 浮き上がった地(--background)に、団体の色(--primary)の太い枠と、太字の文字(--foreground)。
//     色だけでなく、地・枠・太さでも分かる。文字は団体の色に関わらず読める(明るい表示 16:1・暗い表示 17:1)
//   ・選んでいないタブ: 地(--secondary)の上の --muted-foreground(明るい表示 5.7:1・暗い表示 7.4:1)
//   ・aria-pressed で、選んでいるタブを読み上げに伝える
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SegmentedControl({
  children,
  ariaLabel,
  className,
}: {
  children: ReactNode
  ariaLabel?: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        // 縮めずに横に並べ、入りきらない分は枠の中で横にスクロールする
        'ohsumi-scroll inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-secondary p-0.5',
        className,
      )}
      data-segmented
    >
      {children}
    </div>
  )
}

export function SegmentedButton({
  active,
  onClick,
  children,
  className,
  disabled,
  title,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  className?: string
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-secondary',
        'disabled:pointer-events-none disabled:opacity-40',
        active
          ? 'bg-background font-semibold text-foreground shadow-sm ring-2 ring-inset ring-primary'
          : 'font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground',
        className,
      )}
      data-segment-active={active ? 'true' : undefined}
    >
      {children}
    </button>
  )
}
