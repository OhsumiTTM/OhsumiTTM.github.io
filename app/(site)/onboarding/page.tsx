import type { Metadata } from 'next'
import { CTASection, FlowSteps, PageHero } from '@/components/site/blocks'
import { Em, PrimaryCta, Section, SectionHeader } from '@/components/site/primitives'
import { ONBOARDING_STEPS, PRICING } from '@/lib/site/content'

export const metadata: Metadata = {
  title: '導入について',
  description: 'Ohsumiの導入の流れ。問い合わせ・ヒアリング・ご契約・立ち上げ・利用開始・改善の6つのステップで、組織に合わせて導入を進めます。',
  alternates: { canonical: '/onboarding' },
}

const CHECKLIST = [
  { label: '対象組織', value: '企業、学生団体、NPO、研究機関など、プロジェクト単位で仕事を進める組織を想定しています。適合するかはヒアリングで一緒に確認します。' },
  { label: '想定利用人数', value: '数人〜100人程度です(30人以上は Google Workspace のアカウントをおすすめします。101人以上はご相談ください)。' },
  { label: '必要な準備', value: 'メンバー・役職・プロジェクトの情報があると、初期設定がスムーズです。必要な情報はヒアリングでご案内します。' },
  { label: 'サポート範囲', value: '立ち上げの手順書・利用マニュアルのご提供と立ち上げのご案内、不具合の対応(画面の「診断情報」の受付番号でお問い合わせいただけます)、改善のご要望の受付、更新の配布とご案内を行います。' },
  { label: '料金・契約条件', value: PRICING },
  { label: '利用開始目安', value: 'ご契約の後、立ち上げは15〜20分、最初の代表の設定は30分ほどです。当日からメンバーを招待できます。' },
]

export default function OnboardingPage() {
  return (
    <>
      <PageHero
        eyebrow="Onboarding"
        title={
          <>
            Ohsumiを、
            <br />
            <Em>あなたの組織</Em>に合わせて。
          </>
        }
        description="いきなり全体で使い始める必要はありません。対象のチームやプロジェクトから始め、利用状況にあわせて調整していきます。"
      />

      <Section>
        <SectionHeader eyebrow="Flow" title="導入の流れ" />
        <div className="mt-12 max-w-3xl">
          <FlowSteps steps={ONBOARDING_STEPS} variant="detailed" />
        </div>
      </Section>

      <Section tone="surface">
        <SectionHeader eyebrow="Checklist" title="導入前に確認できること" description="このほかのご質問は、お問い合わせの際に個別にご案内します。" />
        <dl className="mt-12 grid overflow-hidden rounded-xl border border-border bg-card md:grid-cols-2">
          {CHECKLIST.map((c) => (
            <div key={c.label} className="flex flex-col gap-2 border-b border-border p-6 md:odd:border-r md:[&:nth-last-child(-n+2)]:border-b-0 last:border-b-0">
              <dt className="text-sm font-extrabold text-foreground">{c.label}</dt>
              <dd className="text-sm leading-relaxed text-muted-foreground">
                {c.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-10">
          <PrimaryCta />
        </div>
      </Section>

      <CTASection />
    </>
  )
}
