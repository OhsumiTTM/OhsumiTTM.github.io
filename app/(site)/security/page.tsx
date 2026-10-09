import type { Metadata } from 'next'
import { Building2, Database, KeyRound, LifeBuoy } from 'lucide-react'
import { CTASection, PageHero } from '@/components/site/blocks'
import { Em, Section, SectionHeader } from '@/components/site/primitives'

export const metadata: Metadata = {
  title: 'セキュリティ',
  description:
    'Ohsumiの情報管理について。認証・権限管理・閲覧範囲・データ分離・保存先・監査・責任範囲・インシデント対応の各項目の、今の仕組みをご説明します。',
  alternates: { canonical: '/security/' },
}

const GROUPS = [
  {
    id: 'access',
    icon: KeyRound,
    title: 'アクセス管理',
    lead: '誰が、どの情報にアクセスできるか。',
    items: [
      { name: '認証方式', detail: 'Google アカウントでログインします。Google が発行する本人確認の情報を、団体の Google Apps Script(GAS)が確かめます。ログインを端末に保存する時は、使っている間は14日ごとに延び、最長30日です。保存しない時は12時間です。' },
      { name: 'アカウント / ログイン', detail: 'メンバーは団体の管理者が登録し、登録したメールアドレスの Google アカウントだけがログインできます。退会にすると、その時点でログインできなくなります。本人と管理者は「全端末でログアウト」できます。' },
      { name: '役職・権限管理', detail: '役職の種類(最上位・管理者(制限なし/制限あり)・一般)と、役職ごとに見られるタブ・できる操作を決められます。人ごとに権限の例外を足すこともできます。許可の判断は団体の GAS が行い、画面には、その人ができる操作だけを出します。' },
      { name: 'タスク・PJの閲覧範囲', detail: 'タスクには公開範囲(全員/幹部限定)があります。承認前のタスクは、管理者と、登録した人・担当者だけが見られます。制限ありの管理者は、担当プロジェクトの範囲を扱います。評価・1on1 などは、本人・上長など決められた人だけが見られます。' },
    ],
  },
  {
    id: 'data',
    icon: Database,
    title: 'データ管理',
    lead: 'データが、どこに、どのように扱われるか。',
    items: [
      { name: '組織単位のデータ分離', detail: '団体ごとに、別の Google アカウント・スプレッドシート・GAS で動きます。団体どうしでデータを共有しません。' },
      { name: '保存先', detail: '団体の Google アカウントの Google スプレッドシート(Google の環境)に保存します。画面は GitHub Pages から配信し、団体のデータは FSIF のサーバーを通りません。' },
      { name: 'データフロー', detail: '利用者の端末 → 団体の GAS(HTTPS)→ 団体のスプレッドシート の順に流れます。FSIF のレジストリが持つのは、団体の接続先・契約の状態などです。プランに応じて、個人を特定しない集計値を週1回 FSIF に送ります。' },
      { name: '変更履歴 / 監査', detail: 'タスクごとの変更の記録、承認・差し戻し・経費の承認の記録を残します。利用の状況(回数とエラーの件数。誰の操作かは記録しません)を確かめられます。データは毎日バックアップします。' },
    ],
  },
  {
    id: 'responsibility',
    icon: Building2,
    title: '責任範囲',
    lead: '誰が、何を管理するか。',
    items: [
      { name: 'FSIFが管理する範囲', detail: '画面と GAS のプログラム、レジストリ、更新の配布、不具合の対応を担います。' },
      { name: '利用団体が管理する範囲', detail: '団体の Google アカウント(2段階認証の設定を含む)、メンバー・役職・権限、スプレッドシートを共有しないこと、GAS の更新を管理していただきます。' },
    ],
  },
  {
    id: 'operation',
    icon: LifeBuoy,
    title: '運用',
    lead: '問題が起きたとき、どう対応するか。',
    items: [
      { name: '障害時の連絡', detail: '管理画面の「FSIF からのお知らせ」(緊急のものはメールでも)と、担当者へのメールでお知らせします。' },
      { name: 'インシデント対応', detail: '診断情報(個人情報を含みません)と受付番号で原因を調べます。必要な時は、FSIF が一部の機能を一時的に止めて影響を抑え、原因と対応をお知らせします。' },
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
        description="「安全です」という言葉ではなく、具体的な管理の構造をお伝えするためのページです。各項目には、今の仕組みを書いています。仕組みが変わった時は、このページも更新します。"
      />

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
                  <li key={it.name} className="flex flex-col gap-1 border-b border-border p-6 last:border-b-0">
                    <h3 className="text-base font-extrabold text-foreground">{it.name}</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">{it.detail}</p>
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
        description="このページにない項目や、より詳しい仕組みについても、導入相談の際にご質問ください。"
      />
    </>
  )
}
