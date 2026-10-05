'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Screen } from '@/lib/site/content'
import { ProductScreenshot } from './product-screenshot'

export function ScreenTabs({ screens }: { screens: Screen[] }) {
  return (
    <Tabs defaultValue={screens[0].key} className="gap-6">
      <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0">
        <TabsList className="h-auto gap-1 rounded-xl border border-border bg-background p-1">
          {screens.map((s) => (
            <TabsTrigger
              key={s.key}
              value={s.key}
              className="min-h-10 flex-none px-4 text-sm font-bold data-active:bg-primary data-active:text-primary-foreground data-active:shadow-none"
            >
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {screens.map((s) => (
        <TabsContent key={s.key} value={s.key} className="flex flex-col gap-5">
          <ProductScreenshot screen={s} />
          <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:gap-6">
            <h3 className="shrink-0 text-base font-bold text-foreground">{s.title}</h3>
            <p className="text-pretty text-base leading-relaxed text-muted-foreground">{s.caption}</p>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  )
}
