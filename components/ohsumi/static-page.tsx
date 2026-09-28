// 紹介ページ・プライバシーポリシー・利用規約の共通の枠。本文は content/legal/<name>.md を
// ビルド時に読み込んで表示する(静的な HTML になるため、ログインしていなくても見られる)。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Markdown } from '@/lib/ohsumi/simple-markdown'

export type LegalPageName = 'about' | 'privacy' | 'terms'

export function readLegalMarkdown(name: LegalPageName): string {
  return readFileSync(join(process.cwd(), 'content', 'legal', `${name}.md`), 'utf8')
}

export function StaticPage({ name }: { name: LegalPageName }) {
  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl bg-background px-4 py-10 sm:px-6 sm:py-12">
      <a href="/" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
        ← Ohsumi
      </a>
      <article className="mt-6 break-words">
        <Markdown source={readLegalMarkdown(name)} />
      </article>
      <nav className="mt-12 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
        <a href="/about/" className="hover:underline">Ohsumi について</a>
        <a href="/privacy/" className="hover:underline">プライバシーポリシー</a>
        <a href="/terms/" className="hover:underline">利用規約</a>
      </nav>
    </main>
  )
}
