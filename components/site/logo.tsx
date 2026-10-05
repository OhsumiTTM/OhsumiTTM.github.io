import { OhsumiMark as BrandMark } from '@/components/ohsumi/primitives'
import { cn } from '@/lib/utils'

// ホームページのロゴ。シンボルは Ohsumi の画面と同じもの(ブランドガイドライン v0.9: 正円・Ohsumi Blue・回転や効果なし)
export function OhsumiMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex', className)} aria-hidden>
      <BrandMark size={28} />
    </span>
  )
}

// inverted: 暗い背景の上では、文字を白にする(シンボルの色は変えない)
export function OhsumiLogo({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} data-ohsumi-logo>
      <BrandMark size={28} />
      <span className={cn('text-xl font-extrabold tracking-tight', inverted ? 'text-white' : 'text-foreground')}>Ohsumi</span>
    </span>
  )
}
