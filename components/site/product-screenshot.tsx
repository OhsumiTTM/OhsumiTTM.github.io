'use client'

import Image from 'next/image'
import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Screen } from '@/lib/site/content'

function BrowserFrame({ screen, priority, className }: { screen: Screen; priority?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_60px_-28px_rgb(12_27_50/0.35)]',
        className,
      )}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-border bg-surface px-3" aria-hidden>
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="ml-3 truncate rounded bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {`ohsumi / ${screen.title}`}
        </span>
      </div>
      {failed ? (
        // 写真がまだ置かれていない時(public/home/screens/ に本物の画面の写真を置く)
        <div className="flex aspect-[16/10] w-full items-center justify-center bg-pale text-sm text-muted-foreground">
          {`${screen.title}の画面(写真を準備中)`}
        </div>
      ) : (
      <Image
        onError={() => setFailed(true)}
        src={screen.src}
        alt={`Ohsumiの${screen.title}画面(サンプルのデータ)`}
        width={1440}
        height={900}
        priority={priority}
        sizes="(min-width: 1024px) 720px, 100vw"
        className="h-auto w-full"
      />
      )}
    </div>
  )
}

export function ProductScreenshot({
  screen,
  priority,
  className,
}: {
  screen: Screen
  priority?: boolean
  className?: string
}) {
  return (
    <Dialog>
      <DialogTrigger
        className={cn(
          'group relative block w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
          className,
        )}
        aria-label={`${screen.title}画面を拡大して見る`}
      >
        <BrowserFrame screen={screen} priority={priority} />
        <span className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-md bg-navy/85 px-2.5 py-1.5 text-xs font-bold text-navy-foreground opacity-90 transition-opacity group-hover:opacity-100">
          <Maximize2 className="size-3.5" aria-hidden />
          拡大
        </span>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1280px)] max-w-none gap-3 overflow-auto p-3 sm:max-w-none md:p-4">
        <DialogTitle className="pr-10 text-base font-bold">{screen.title}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{screen.caption}</DialogDescription>
        <div className="overflow-x-auto">
          <Image
            src={screen.src}
            alt={`Ohsumiの${screen.title}画面(サンプルのデータ)`}
            width={1440}
            height={900}
            sizes="96vw"
            className="h-auto w-full min-w-[720px] rounded-md border border-border"
          />
        </div>
        <p className="text-xs text-muted-foreground">表示されているデータは、すべてサンプルのデータです。</p>
      </DialogContent>
    </Dialog>
  )
}

export function ScreenFigure({ screen, priority }: { screen: Screen; priority?: boolean }) {
  return (
    <figure className="flex flex-col gap-3">
      <ProductScreenshot screen={screen} priority={priority} />
      <figcaption className="flex flex-col gap-1">
        <span className="text-sm font-bold text-foreground">{screen.title}</span>
        <span className="text-sm leading-relaxed text-muted-foreground">{screen.caption}</span>
      </figcaption>
    </figure>
  )
}
