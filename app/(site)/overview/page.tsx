import type { Metadata } from 'next'
import { ComparisonTable, CTASection, PageHero } from '@/components/site/blocks'
import { ValueCycle, WorkHub } from '@/components/site/diagrams'
import { Em, Section, SectionHeader, TextLink } from '@/components/site/primitives'
import { CTA } from '@/lib/site/config'

export const metadata: Metadata = {
  title: 'Ohsumiとは',
  description:
    'Ohsumi（オオスミ）は、仕事を中心に人・プロジェクト・組織・知識をつなぐ組織運営プラットフォームです。一般的なタスク管理との違い、開発コンセプト、価値循環を紹介します。',
  alternates: { canonical: '/overview/' },
}

const CONNECTED = ['要求スキル', '成果物', '進捗', '登録の承認', '完了の確認', '実績', '経験', '人材情報', 'プロジェクト情報', '組織情報']

const COMPARISON = [
  { aspect: '中心', general: 'タスク・期限・担当', ohsumi: '仕事を中心に、人・プロジェクト・組織・知識をつなぐ' },
  { aspect: '完了後', general: '履歴として残る', ohsumi: '実績・経験・スキルへ接続' },
  { aspect: '担当者選定', general: '担当可能性・現在の状況', ohsumi: '実績・スキル・負荷など判断材料を揃える' },
  { aspect: '育成', general: '別管理になりやすい', ohsumi: '実務そのものを育成機会につなげる' },
  { aspect: '引継ぎ', general: '資料・口頭に依存', ohsumi: 'タスク・成果物・経験を組織に残す' },
]

const TARGETS = [
  { title: '複数のプロジェクトが並行する組織', body: 'プロジェクトごとに管理方法が分かれ、全体の状況を比べにくい組織。' },
  { title: 'メンバーの入れ替わりがある組織', body: '異動・卒業・代替わりのたびに、経験やノウハウが失われやすい組織。' },
  { title: '仕事を通じて人を育てたい組織', body: '研修だけでなく、日々の実務を成長の機会として活かしたい組織。' },
]

export default function OverviewPage() {
  return (
    <>
      <PageHero
        eyebrow="About Ohsumi"
        title={
          <>
            仕事を中心に、
            <br />
            <Em>人・プロジェクト・組織・知識</Em>をつなぐ。
          </>
        }
        description="Ohsumiとは、仕事の実行を組織のデータと次の成長につなげる、組織運営プラットフォームです。"
      />

      <Section>
        <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
          <SectionHeader
            eyebrow="Concept"
            title={
              <>
                タスクを管理するだけでなく、
                <br />
                仕事を<Em>組織に残す</Em>。
              </>
            }
            description="一般的なタスク管理では、タスク・担当者・期限を管理します。Ohsumiではそれに加えて、仕事に関わる情報を接続し、完了した仕事を次の判断に使える形で残します。"
          />
          <div className="rounded-2xl bg-pale p-6 md:p-8">
            <p className="text-sm font-bold text-foreground">仕事と接続する情報</p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {CONNECTED.map((c) => (
                <li key={c} className="rounded-lg border border-primary/20 bg-background px-3 py-2 text-sm font-bold text-foreground">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section tone="surface">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <SectionHeader
            eyebrow="Structure"
            title={
              <>
                すべての情報は、
                <br />
                仕事から始まる。
              </>
            }
            description="人もプロジェクトも組織も知識も、仕事を介してつながります。管理のための入力を増やすのではなく、仕事を進めることで情報がそろう構造です。"
          />
          <WorkHub />
        </div>
      </Section>

      <Section>
        <SectionHeader
          eyebrow="Difference"
          title="一般的なタスク管理との違い"
          description="違いは、仕事が終わったあとにあります。"
        />
        <div className="mt-12">
          <ComparisonTable rows={COMPARISON} caption="一般的なタスク管理とOhsumiの比較" />
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeader
          eyebrow="Value cycle"
          title={
            <>
              仕事をするほど、
              <br />
              <Em>組織のデータが育つ。</Em>
            </>
          }
          description="仕事の発生から実行、実績・経験の蓄積、そして次の仕事・人材配置・育成へ。仕事が循環するほど、組織の判断材料がそろっていきます。"
        />
        <ValueCycle className="mt-12 bg-background" />
      </Section>

      <Section>
        <SectionHeader eyebrow="For" title="こんな組織のために" />
        <ul className="mt-12 grid gap-4 md:grid-cols-3">
          {TARGETS.map((t) => (
            <li key={t.title} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
              <h3 className="text-lg font-extrabold text-foreground">{t.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{t.body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
          <TextLink href={CTA.features.href}>{CTA.features.label}</TextLink>
          <TextLink href="/use-cases">利用シーンを見る</TextLink>
        </div>
      </Section>

      <CTASection />
    </>
  )
}
