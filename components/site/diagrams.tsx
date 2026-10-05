import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { VALUE_CYCLE } from '@/lib/site/content'

export function ValueCycle({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-2xl bg-pale p-6 md:p-10', className)}>
      <ol className="relative flex flex-col gap-6 md:flex-row md:gap-0" aria-label="Ohsumiの価値循環">
        <span
          className="absolute top-5 bottom-5 left-5 w-0.5 bg-primary/30 md:top-5 md:right-[8.33%] md:bottom-auto md:left-[8.33%] md:h-0.5 md:w-auto"
          aria-hidden
        />
        {VALUE_CYCLE.map((label, i) => {
          const last = i === VALUE_CYCLE.length - 1
          return (
            <li key={label} className="relative flex items-center gap-4 md:flex-1 md:flex-col md:gap-4 md:text-center">
              <span
                className={cn(
                  'relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold',
                  last
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-primary bg-background text-primary',
                )}
                aria-hidden
              >
                {i + 1}
              </span>
              <span className="text-pretty text-sm font-bold leading-snug text-foreground md:px-2 md:text-base">
                {label}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="mt-8 flex items-center gap-3 border-t border-primary/20 pt-6 md:justify-center">
        <RotateCcw className="size-5 shrink-0 text-primary" aria-hidden />
        <p className="text-sm font-medium text-foreground md:text-base">
          蓄積された経験が、また次の仕事の判断材料になる。
        </p>
      </div>
    </div>
  )
}

const HUB_NODES = [
  { en: 'PEOPLE', jp: '人', pos: 'col-start-1 row-start-1' },
  { en: 'PROJECT', jp: 'プロジェクト', pos: 'col-start-3 row-start-1' },
  { en: 'ORGANIZATION', jp: '組織', pos: 'col-start-1 row-start-3' },
  { en: 'KNOWLEDGE', jp: '知識', pos: 'col-start-3 row-start-3' },
]

export function WorkHub({ className }: { className?: string }) {
  return (
    <div className={cn('relative mx-auto aspect-square w-full max-w-md', className)} role="img" aria-label="WORK（仕事）を中心に、人・プロジェクト・組織・知識が線でつながる図">
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" strokeWidth="0.4" strokeDasharray="1.5 1.5" className="text-primary/40" />
        {[
          [16.7, 16.7],
          [83.3, 16.7],
          [16.7, 83.3],
          [83.3, 83.3],
        ].map(([x, y]) => (
          <line key={`${x}-${y}`} x1="50" y1="50" x2={x} y2={y} stroke="currentColor" strokeWidth="0.6" className="text-primary" />
        ))}
      </svg>
      <div className="relative grid size-full grid-cols-3 grid-rows-3">
        {HUB_NODES.map((n) => (
          <div key={n.en} className={cn('flex items-center justify-center', n.pos)}>
            <div className="flex size-full max-h-28 max-w-28 flex-col items-center justify-center rounded-full border border-primary/30 bg-background text-center shadow-sm">
              <span className="text-[10px] font-bold tracking-[0.14em] text-primary sm:text-xs">{n.en}</span>
              <span className="text-xs font-bold text-foreground sm:text-sm">{n.jp}</span>
            </div>
          </div>
        ))}
        <div className="col-start-2 row-start-2 flex items-center justify-center">
          <div className="flex size-full max-h-32 max-w-32 scale-110 flex-col items-center justify-center rounded-full bg-primary text-center text-primary-foreground shadow-[0_12px_30px_-10px_rgb(41_72_232/0.6)]">
            <span className="text-sm font-extrabold tracking-[0.16em] sm:text-base">WORK</span>
            <span className="text-xs font-bold sm:text-sm">仕事</span>
          </div>
        </div>
      </div>
    </div>
  )
}
