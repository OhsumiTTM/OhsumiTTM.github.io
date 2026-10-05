'use client'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import type { FaqItem } from '@/lib/site/content'

export function FAQAccordion({ items }: { items: FaqItem[] }) {
  return (
    <Accordion className="rounded-xl border border-border bg-card">
      {items.map((item) => (
        <AccordionItem key={item.q} value={item.q} className="border-border px-5 md:px-6">
          <AccordionTrigger className="min-h-14 items-center gap-4 py-4 text-base font-bold text-foreground hover:no-underline">
            <span className="flex items-start gap-3">
              <span className="font-extrabold text-primary" aria-hidden>
                Q
              </span>
              {item.q}
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <p className="flex gap-3 pb-3 text-base leading-relaxed text-muted-foreground">
              <span className="font-extrabold text-foreground" aria-hidden>
                A
              </span>
              {item.a}
            </p>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
