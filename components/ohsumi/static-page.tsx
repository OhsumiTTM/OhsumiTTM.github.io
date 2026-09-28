// 紹介ページ・プライバシーポリシー・利用規約の共通の枠(中身は後で入れる)
export function StaticPage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-background px-4 py-12">
      <a href="/" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
        ← Ohsumi
      </a>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
      <nav className="mt-12 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
        <a href="/about/" className="hover:underline">Ohsumi について</a>
        <a href="/privacy/" className="hover:underline">プライバシーポリシー</a>
        <a href="/terms/" className="hover:underline">利用規約</a>
      </nav>
    </main>
  )
}
