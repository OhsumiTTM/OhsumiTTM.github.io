import type { Metadata } from 'next'
import { Building2, Database, KeyRound, LifeBuoy } from 'lucide-react'
import { CTASection, PageHero } from '@/components/site/blocks'
import { Em, PendingNote, Section, SectionHeader } from '@/components/site/primitives'

export const metadata: Metadata = {
  title: 'セキュリティ',
  description:
    'Ohsumiの情報管理について。認証・権限管理・閲覧範囲・データ分離・保存先・監査・責任範囲・インシデント対応の各項目を、正式提供内容に合わせて公開します。',
  alternates: { canonical: '/security' },
}

const GROUPS = [
  {
    id: 'access',
    icon: KeyRound,
    title: 'アクセス管理',
    lead: '誰が、どの情報にアクセスできるか。',
    items: [
      { name: '認証方式', scope: 'ログインに使用する認証の仕組み' },
      { name: 'アカウント / ログイン', scope: 'アカウントの発行・停止とログインの管理方法' },
      { name: '役職・権限管理', scope: '役職ごとに設定できる閲覧・編集の範囲' },
      { name: 'タスク・PJの閲覧範囲', scope: 'タスクやプロジェクト単位での公開範囲の設定' },
    ],
  },
  {
    id: 'data',
    icon: Database,
    title: 'データ管理',
    lead: 'データが、どこに、どのように扱われるか。',
    items: [
      { name: '組織単位のデータ分離', scope: '利用団体ごとのデータの分け方' },
      { name: '保存先', scope: 'データを保存する環境と地域' },
      { name: 'データフロー', scope: '入力されたデータが保存・表示されるまでの経路' },
      { name: '変更履歴 / 監査', scope: '操作や変更の記録と確認方法' },
    ],
  },
  {
    id: 'responsibility',
    icon: Building2,
    title: '責任範囲',
    lead: '誰が、何を管理するか。',
    items: [
      { name: 'FSIFが管理する範囲', scope: 'サービスの提供・運用においてFSIFが責任を持つ範囲' },
      { name: '利用団体が管理する範囲', scope: 'アカウント・権限・入力データなど利用団体が管理する範囲' },
    ],
  },
  {
    id: 'operation',
    icon: LifeBuoy,
    title: '運用',
    lead: '問題が起きたとき、どう対応するか。',
    items: [
      { name: '障害時の連絡', scope: '障害発生時の連絡手段と連絡のタイミング' },
      { name: 'インシデント対応', scope: 'セキュリティインシデント発生時の対応手順' },
    ],
  },
]

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title={
          <>
            Ohsumiの
            <br />
            <Em>情報管理</Em>について。
          </>
        }
        description="「安全です」という言葉ではなく、具体的な管理の構造をお伝えするためのページです。各項目の詳細は、正式提供内容に合わせて順次公開します。"
      >
        <PendingNote />
      </PageHero>

      {GROUPS.map((g, i) => {
        const Icon = g.icon
        return (
          <Section key={g.id} id={g.id} tone={i % 2 === 1 ? 'surface' : 'white'}>
            <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr]">
              <div className="flex flex-col gap-5">
                <span className="flex size-11 items-center justify-center rounded-lg bg-pale text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <SectionHeader title={g.title} description={g.lead} />
              </div>
              <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                {g.items.map((it) => (
                  <li key={it.name} className="flex flex-col gap-3 border-b border-border p-6 last:border-b-0 md:flex-row md:items-start md:justify-between md:gap-8">
                    <div className="flex flex-col gap-1">
                      <h3 className="text-base font-extrabold text-foreground">{it.name}</h3>
                      <p className="text-sm leading-relaxed text-muted-foreground">{`掲載予定：${it.scope}`}</p>
                    </div>
                    <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/50 px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
                      <span className="size-1.5 rounded-full border border-muted-foreground" aria-hidden />
                      準備中
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        )
      })}

      <CTASection
        title={
          <>
            セキュリティについて、
            <br />
            個別にご説明します。
          </>
        }
        description="現時点で公開していない項目についても、導入相談の際にご質問ください。"
      />
    </>
  )
}
