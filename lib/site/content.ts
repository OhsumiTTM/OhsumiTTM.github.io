import {
  BarChart3,
  Bell,
  CheckCircle2,
  FolderKanban,
  GitBranch,
  GraduationCap,
  ListChecks,
  Receipt,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'

/**
 * Provision status. Mark a feature or capability "available" only when it can be used today.
 * Update here only.
 */
export type ProvisionStatus = 'available' | 'developing' | 'concept'

export const STATUS_META: Record<ProvisionStatus, { label: string; description: string }> = {
  available: { label: '提供中', description: '現在ご利用いただける機能です。' },
  developing: { label: '開発中', description: '現在開発中の機能です。仕様は変更される可能性があります。' },
  concept: { label: '構想', description: '今後の提供を検討している機能です。仕様は変更される可能性があります。' },
}

export type ScreenKey =
  | 'dashboard'
  | 'tasks'
  | 'workflow'
  | 'task-detail'
  | 'project'
  | 'calendar'
  | 'people'
  | 'member-profile'
  | 'skills'
  | 'archive'
  | 'approvals'
  | 'requests'
  | 'notifications'
  | 'analytics'
  | 'development'
  | 'admin'

export type Screen = { key: ScreenKey; label: string; src: string; title: string; caption: string }

export const SCREENS: Record<ScreenKey, Screen> = {
  dashboard: {
    key: 'dashboard',
    label: 'Dashboard',
    src: '/home/screens/dashboard.png',
    title: 'ダッシュボード',
    caption: '今日やること、期限が近い仕事、確認待ちの仕事を一画面で把握できます。ログイン直後に「次に何をするか」が分かります。',
  },
  tasks: {
    key: 'tasks',
    label: 'Task',
    src: '/home/screens/tasks.png',
    title: 'タスク一覧',
    caption: '担当・期限・進捗・必要スキルを並べて確認できます。リスト・ボード・カレンダーなど、目的に応じて表示を切り替えられます。',
  },
  workflow: {
    key: 'workflow',
    label: 'Workflow',
    src: '/home/screens/workflow.png',
    title: 'ワークフロー',
    caption: '前提タスクと後続タスクのつながりを図で確認できます。どの仕事が止まると全体が遅れるのかが分かります。',
  },
  'task-detail': {
    key: 'task-detail',
    label: 'Task Detail',
    src: '/home/screens/task-detail.png',
    title: 'タスク詳細',
    caption: '説明・成果物・必要スキル・コメント・振り返りを1つのタスクにまとめます。引継ぎ時も、仕事の背景がそのまま残ります。',
  },
  project: {
    key: 'project',
    label: 'Project',
    src: '/home/screens/projects-p1.png',
    title: 'プロジェクト',
    caption: 'プロジェクトごとの進捗、メンバー、健全性を確認できます。複数のプロジェクトを同じ形式で比較できます。',
  },
  calendar: {
    key: 'calendar',
    label: 'Calendar',
    src: '/home/screens/calendar.png',
    title: 'カレンダー',
    caption: '期限や予定を月単位で確認できます。期限の集中や、空いている期間が見えます。',
  },
  people: {
    key: 'people',
    label: 'People',
    src: '/home/screens/people.png',
    title: 'メンバー一覧',
    caption: 'メンバーごとの担当数・負荷・スキルを確認できます。仕事を任せる前の判断材料をそろえます。',
  },
  'member-profile': {
    key: 'member-profile',
    label: 'Profile',
    src: '/home/screens/people-m1.png',
    title: '個人プロフィール',
    caption: '担当してきた仕事、身につけたスキル、本人のやりたいことを一人ずつ確認できます。',
  },
  skills: {
    key: 'skills',
    label: 'Skills',
    src: '/home/screens/skills.png',
    title: 'スキル',
    caption: '組織にあるスキルと、そのスキルを持つメンバーを確認できます。不足しているスキルも見えます。',
  },
  archive: {
    key: 'archive',
    label: 'Records',
    src: '/home/screens/archive.png',
    title: '実績',
    caption: '完了した仕事と成果物を、あとから探せる形で残します。過去の仕事を次の仕事の参考にできます。',
  },
  approvals: {
    key: 'approvals',
    label: 'Approval',
    src: '/home/screens/approvals.png',
    title: '承認',
    caption: 'メンバーが登録したタスクを、承認してからワークスペースに出します。承認しない時は、理由が登録した人にメールで届きます。',
  },
  requests: {
    key: 'requests',
    label: 'Requests',
    src: '/home/screens/requests.png',
    title: '経費申請',
    caption: 'カテゴリ・金額・領収書を入れて申請。カテゴリごとに決めた段階の順に承認されます。',
  },
  notifications: {
    key: 'notifications',
    label: 'Notifications',
    src: '/home/screens/notifications.png',
    title: '通知の設定',
    caption: 'ベルに出す通知を種類ごとに選び、メールは種類ごとに頻度を選べます。',
  },
  analytics: {
    key: 'analytics',
    label: 'Analytics',
    src: '/home/screens/analytics.png',
    title: '分析',
    caption: '進捗・負荷・スキルの分布を、組織やプロジェクトの単位で確認できます。',
  },
  development: {
    key: 'development',
    label: 'Development',
    src: '/home/screens/development.png',
    title: '人材育成',
    caption: 'メンバーの成長目標と、目標につながる実務を並べて確認できます。',
  },
  admin: {
    key: 'admin',
    label: 'Admin',
    src: '/home/screens/admin.png',
    title: '管理・権限',
    caption: '組織・役職・権限を設定します。誰がどの情報を見られるかを管理できます。',
  },
}

export const HOME_SCREEN_TABS: ScreenKey[] = ['dashboard', 'tasks', 'project', 'people', 'approvals']

export type Capability = { text: string; status?: ProvisionStatus }

export type Feature = {
  slug: string
  name: string
  jpName: string
  icon: LucideIcon
  summary: string
  status: ProvisionStatus
  problem: string
  capabilities: Capability[]
  screens: ScreenKey[]
  example: string
  connections: string[]
}

export const FEATURES: Feature[] = [
  {
    slug: 'task',
    name: 'Task Management',
    jpName: 'タスク管理',
    icon: ListChecks,
    summary: '仕事、担当、期限、進捗、成果物をまとめて管理。',
    status: 'available',
    problem: '仕事の目的や完了条件が担当者の頭の中にしかなく、進捗や成果物の場所が人によってばらばらになっている。',
    capabilities: [
      { text: '担当者・期限・優先度・進捗の管理' },
      { text: '説明・成果物・振り返りをタスクに記録' },
      { text: '必要スキルと難易度の設定' },
      { text: 'リスト・ボード・カレンダーなど複数の表示' },
      { text: '文章(議事録やメモ)からタスク案を作成' },
    ],
    screens: ['tasks', 'task-detail'],
    example: '定例会議のあと、決まった作業をタスクとして登録。担当と期限、やることの説明を書いておくことで、確認時に認識のずれが起きにくくなります。',
    connections: ['workflow', 'review', 'people'],
  },
  {
    slug: 'project',
    name: 'Project Management',
    jpName: 'プロジェクト管理',
    icon: FolderKanban,
    summary: '複数プロジェクトの進行状況を横断して把握。',
    status: 'available',
    problem: 'プロジェクトごとに管理方法が違い、組織全体でどこが遅れているのかを比べられない。',
    capabilities: [
      { text: 'プロジェクトごとの進捗・メンバー・期間の管理' },
      { text: 'プロジェクトの健全性(期限超過・確認待ち・ブロック)の確認' },
      { text: '複数プロジェクトを同じ形式で一覧' },
      { text: 'プロジェクトに紐づくタスクの集約' },
    ],
    screens: ['project', 'calendar'],
    example: '複数のプロジェクトが同時に動く組織で、週次の確認をプロジェクト一覧から行う。遅れているプロジェクトの原因タスクまでたどれます。',
    connections: ['task', 'workflow', 'analytics'],
  },
  {
    slug: 'workflow',
    name: 'Workflow',
    jpName: 'ワークフロー・依存関係',
    icon: GitBranch,
    summary: '前提タスクや依存関係を可視化。',
    status: 'available',
    problem: 'ある仕事が止まると、どの仕事に影響が出るのかが分からず、遅れに気づくのが後になる。',
    capabilities: [
      { text: '前提タスク・後続タスクの設定' },
      { text: '依存関係の図による表示' },
      { text: '止まっている仕事と影響範囲の確認' },
    ],
    screens: ['workflow'],
    example: 'イベント準備で「会場確定」が遅れたとき、その後の告知・備品手配にどう影響するかを図で確認できます。',
    connections: ['task', 'project'],
  },
  {
    slug: 'review',
    name: 'Review & Approval',
    jpName: '承認・確認',
    icon: CheckCircle2,
    summary: 'タスクの登録の承認から、完了の確認まで。仕事の入口と出口に、人の目を通す。',
    status: 'available',
    problem: '誰でも仕事を登録できると重複や抜けが増え、終わった仕事も誰が確認したのか分からない。確認の依頼はチャットやメールに埋もれ、どこで止まっているのか見えない。',
    capabilities: [
      { text: '登録の承認: メンバーが登録したタスクは、管理者が承認してからワークスペースに出る' },
      { text: '重要・対外公開のタスクは、制限なしの管理者と代表だけが承認できる' },
      { text: '似たタスクが既にある時は、承認の画面で知らせる' },
      { text: '完了の確認: 担当者が完了を選ぶと確認待ちになり、確認者(いなければ報告先)の承認で完了になる' },
      { text: '修正を頼む時は「修正中」に戻し、理由をコメントに残す' },
      { text: '承認・差し戻しの記録をタスクの変更履歴に保存' },
    ],
    screens: ['approvals', 'task-detail'],
    example: '新入生が登録した「新歓チラシの作成」を、班長が内容を確かめて承認。チラシができたら確認待ちになり、班長が見て、直してほしい点をコメントで返す。直ったら承認して完了になります。',
    connections: ['task', 'admin'],
  },
  {
    slug: 'requests',
    name: 'Reports & Requests',
    jpName: '日報・申請',
    icon: Receipt,
    summary: '日報・週報、経費申請、申請フォーム、日程調整を、仕事と同じ場所で。',
    status: 'available',
    problem: '経費の精算や備品の申請が、紙・チャット・個人のメールに散らばり、誰の承認で止まっているのか分からない。日々の報告も、書く場所が人によって違う。',
    capabilities: [
      { text: '日報・週報(やったこと・次にやること・課題)を書いて、履歴を見返せる' },
      { text: '経費申請: 領収書(画像・PDF)を付けて申請し、カテゴリごとに決めた段階の順に承認' },
      { text: '差し戻し・却下・取り下げ、承認の進み具合(承認 ○/○)の確認' },
      { text: '申請フォーム: 備品の購入・施設の利用など、団体が作ったフォームで申請と承認' },
      { text: '日程調整・フォームのタスク: 候補に○△×で答え、全員が答えると自動で完了' },
    ],
    screens: ['requests'],
    example: 'イベントの備品を立て替えたメンバーが、領収書の写真を付けて経費申請。会計担当、代表の順に承認され、進み具合は申請履歴で確かめられます。',
    connections: ['review', 'admin'],
  },
  {
    slug: 'notifications',
    name: 'Notifications',
    jpName: '通知',
    icon: Bell,
    summary: '必要な知らせを、必要な人に。ベル・メール・Discord・Slack で届ける。',
    status: 'available',
    problem: '確認の依頼やメンションに気づかず、仕事が止まる。逆に通知が多すぎて、大事なものが埋もれる。',
    capabilities: [
      { text: '画面のベルに、承認依頼・確認待ち・メンション・返信・期限などが届く(90日分の履歴)' },
      { text: 'ベルの通知は種類ごとにオン・オフできる' },
      { text: 'メールは種類ごとに、その都度・3時間・6時間・1日まとめて・送らない から選べる' },
      { text: 'コメントへの返信は、元のコメントを書いた人とメンションされていた人に届く' },
      { text: '団体の Discord・Slack に通知を流せる(幹部限定・承認待ちのタスクの中身は流さない)' },
    ],
    screens: ['notifications'],
    example: '確認待ちのタスクが出ると、確認者にすぐメールとベルで届く。チームの連絡は Slack にまとめ、個人のメールは1日1回のまとめにする、といった使い分けができます。',
    connections: ['task', 'review'],
  },
  {
    slug: 'people',
    name: 'People & Talent',
    jpName: '人材情報',
    icon: Users,
    summary: '実績やスキルを仕事とつなげて蓄積。',
    status: 'available',
    problem: '誰がどんな経験を持っているかが記録されておらず、仕事を任せる相手をいつも同じ人に頼ってしまう。',
    capabilities: [
      { text: 'メンバーごとの担当・実績・スキルの確認' },
      { text: '完了した仕事から経験を蓄積' },
      { text: '現在の負荷の確認' },
      { text: '仕事に必要なスキルから担当候補を表示' },
    ],
    screens: ['people', 'member-profile', 'skills'],
    example: '新しい仕事の担当を決めるとき、似た仕事の経験がある人と、いま余裕がある人を並べて比較する。最終的な判断はリーダーが行います。',
    connections: ['task', 'development', 'analytics'],
  },
  {
    slug: 'development',
    name: 'Human Development',
    jpName: '人材育成',
    icon: GraduationCap,
    summary: '実務経験を人材育成につなげる。',
    status: 'available',
    problem: '育成が研修や面談の中だけで完結し、日々の仕事と成長目標がつながっていない。',
    capabilities: [
      { text: 'スキル・経験・やりたいことの記録' },
      { text: '成長目標につながる仕事の確認' },
      { text: '仕事を通じたスキルの変化の確認' },
    ],
    screens: ['development', 'member-profile'],
    example: '「対外発信の経験を積みたい」というやりたいことを持つメンバーに、完了の確認付きで広報系の仕事を任せる。実務そのものを育成機会にできます。',
    connections: ['people', 'task'],
  },
  {
    slug: 'analytics',
    name: 'Analytics',
    jpName: '分析',
    icon: BarChart3,
    summary: '進捗・負荷・スキル・組織状況を分析。',
    status: 'available',
    problem: '組織の状況を把握するために、毎回スプレッドシートで集計し直している。',
    capabilities: [
      { text: '進捗と期限の状況の集計' },
      { text: 'メンバーごとの負荷の確認' },
      { text: '組織のスキル分布の確認' },
    ],
    screens: ['analytics'],
    example: '月次の振り返りで、負荷が特定のメンバーに偏っていないか、不足しているスキルがないかを確認します。',
    connections: ['project', 'people'],
  },
  {
    slug: 'admin',
    name: 'Permission & Admin',
    jpName: '管理・権限',
    icon: ShieldCheck,
    summary: '役職や組織構造に合わせた権限管理。',
    status: 'available',
    problem: 'すべての情報が全員に見えてしまう、または必要な人に必要な情報が届かない。',
    capabilities: [
      { text: '組織・チーム・役職の設定' },
      { text: '役職に応じた閲覧・編集の権限' },
      { text: 'メンバーの招待と管理' },
    ],
    screens: ['admin'],
    example: '年度替わりの役職変更にあわせて権限を更新。新しいリーダーが担当プロジェクトの情報を確認できるようにします。',
    connections: ['review', 'project'],
  },
]

export const PROBLEMS = [
  { title: '誰が何をしているか分からない', body: '担当と進捗がチャットや個人のメモに散らばり、全体を把握できない。' },
  { title: '確認待ちの仕事がどこか分からない', body: '登録の承認や完了の確認の依頼が埋もれ、止まっている仕事に気づけない。' },
  { title: '成果物や過去の仕事が散らばっている', body: '似た仕事をするたびに、資料や経緯を一から探し直している。' },
  { title: '誰に仕事を任せればよいか分からない', body: '経験やスキルが見えず、いつも同じ人に仕事が集まる。' },
  { title: '仕事の経験が人材情報として残らない', body: 'メンバーが入れ替わると、経験もノウハウも一緒に失われる。' },
]

export const VALUE_CYCLE = [
  '仕事が生まれる',
  '担当する',
  '実行する',
  '成果物・実績が残る',
  '経験・スキルが蓄積される',
  '次の仕事・配置・育成へ',
]

export type UseCase = {
  slug: string
  role: string
  summary: string
  points: string[]
  scenario: string
  cta: { label: string; href: string }
  screen: ScreenKey
}

export const USE_CASES: UseCase[] = [
  {
    slug: 'member',
    role: '一般メンバー',
    summary: '今日やること、期限、成果物、実績が分かる。',
    points: ['今日やる仕事', '期限', '成果物', '実績'],
    scenario: '朝ダッシュボードを開くと、今日の仕事と期限が近い仕事が並んでいます。完了した仕事は実績として自分のプロフィールに残ります。',
    cta: { label: '自分のタスク管理を見る', href: '/features#task' },
    screen: 'dashboard',
  },
  {
    slug: 'leader',
    role: 'PJリーダー',
    summary: '進捗、依存関係、負荷、確認待ちを確認。',
    points: ['進捗', '負荷', '依存関係', '確認待ち'],
    scenario: 'プロジェクトの遅れを、依存関係の図から原因のタスクまでたどれます。メンバーの負荷を見ながら担当を調整できます。',
    cta: { label: 'プロジェクト管理を見る', href: '/features#project' },
    screen: 'project',
  },
  {
    slug: 'admin',
    role: '管理者',
    summary: '複数PJ、登録の承認、権限、人材配置を管理。',
    points: ['複数PJ', '権限', '登録の承認', '人材配置'],
    scenario: '組織全体のプロジェクトを同じ形式で比較し、登録の承認や完了の確認が滞っている箇所を確認します。役職変更にあわせて権限を更新できます。',
    cta: { label: '管理機能を見る', href: '/features#admin' },
    screen: 'admin',
  },
  {
    slug: 'development',
    role: '育成担当',
    summary: 'スキル・経験・やりたいことを仕事と接続。',
    points: ['スキル', '経験', 'やりたいこと', '成長タスク'],
    scenario: 'メンバーのやりたいことと、これまでの経験を確認したうえで、成長につながる仕事を一緒に選べます。',
    cta: { label: '人材育成機能を見る', href: '/features#development' },
    screen: 'development',
  },
  {
    slug: 'project-org',
    role: '学生団体・PJ型組織',
    summary: 'メンバーが入れ替わっても、仕事と経験が残る。',
    points: ['メンバー交代', '引継ぎ', '経験差', '複数PJ'],
    scenario: '代替わりのたびに引継ぎ資料を作り直す必要がありません。過去のタスク・成果物・経緯がそのまま次の代に残ります。',
    cta: { label: '導入について見る', href: '/onboarding' },
    screen: 'archive',
  },
]

export const ONBOARDING_STEPS = [
  { title: '問い合わせ', body: '利用目的、組織規模、現在の管理方法を確認します。' },
  { title: 'ヒアリング', body: '課題、組織構造、権限、プロジェクト、必要な機能を整理します。' },
  { title: 'ご契約', body: '利用契約書・申込書を取り交わし、プランを確定します。' },
  {
    title: '立ち上げ',
    body: 'テンプレートのコピー・初期設定・登録を行います(15〜20分)。その後、組織に合わせて基本情報を設定します。',
    items: ['組織', 'メンバー', '役職', 'プロジェクト', 'スキル', '権限'],
  },
  { title: '利用開始', body: '対象のチームやプロジェクトから利用を始めます。' },
  { title: '改善', body: '利用状況とフィードバックを踏まえて、設定や運用を調整します。' },
]

export type FaqItem = { q: string; a: string }
export type FaqCategory = { id: string; label: string; items: FaqItem[] }

/** 料金・契約条件(FAQ と導入のページで同じ文を使う) */
export const PRICING =
  '現在は、Cosmo Baseプラン・Ohsumiプラン(どちらも無償。プランに応じてアンケートと、個人を特定しない集計値のご提供をお願いしています)でご利用いただけます。有償プランは、一般社団法人の設立後に受付を始めます。'

export const FAQ: FaqCategory[] = [
  {
    id: 'about',
    label: 'Ohsumiについて',
    items: [
      { q: 'Ohsumiとは何ですか？', a: 'Ohsumi（オオスミ）は、仕事を中心に人・プロジェクト・組織・知識をつなぐ組織運営プラットフォームです。タスクの管理に加えて、成果物・実績・スキルなどを仕事と接続し、仕事の実行を組織のデータと次の成長につなげます。',},
      { q: '一般的なタスク管理ツールとの違いは？', a: '一般的なタスク管理はタスク・担当・期限の管理が中心です。Ohsumiでは、完了した仕事を実績・経験・スキルとして残し、担当者の選定や人材育成の判断材料として使えるようにすることを重視しています。',},
      { q: 'どんな組織に向いていますか？', a: '複数のプロジェクトが並行して動く組織、メンバーの入れ替わりがある組織、仕事を通じた育成を重視する組織に向いています。具体的な適合性は、導入相談でお伺いした内容をもとに一緒に確認します。',},
      { q: '何人程度から利用できますか？', a: '数人の団体から利用できます。目安は100人程度までです。団体の Google アカウントが個人の Gmail の場合はメールの送信数に上限があるため、30人以上の団体は Google Workspace のアカウントをおすすめします。101人以上の団体はご相談ください。' },
    ],
  },
  {
    id: 'usage',
    label: '利用について',
    items: [
      { q: 'Googleアカウントは必要ですか？', a: '必要です。メンバーは、登録したメールアドレスの Google アカウントでログインします。会社・大学などのアドレスは、Google アカウントになっていればそのまま使えます。また、Ohsumi のデータと仕組みを置くための、団体の運用用の Google アカウントを1つご用意いただきます。' },
      { q: 'スマートフォンから利用できますか？', a: 'はい。アプリのインストールは不要で、スマートフォンのブラウザから使えます。ホーム画面に追加すると、次からすぐ開けます。管理画面の一部や Excel での取り込み・書き出しなど、画面が狭いと使いにくい機能もあるため、管理の作業はパソコンでの利用をおすすめします。' },
      { q: 'Google Drive等と併用できますか？', a: 'はい。Ohsumi のデータは団体の Google スプレッドシートに保存され、成果物には Google ドライブなどのリンクをそのまま付けられます。期限のあるタスクは、担当者の Google カレンダーに予定の招待が届き、自分のカレンダーに追加するボタンもあります。通知は Discord・Slack・メールで受け取れます。' },
      { q: 'デモを見ることはできますか？', a: 'はい。お問い合わせフォームから「デモ希望」としてご連絡ください。サンプルのデータを入れた環境で、組織に合わせて実際の画面をご案内します。' },
    ],
  },
  {
    id: 'onboarding',
    label: '導入について',
    items: [
      { q: '初期設定は必要ですか？', a: 'はい。FSIF がお渡しするテンプレートをコピーし、メニューから初期設定を実行して、Ohsumi に登録します。所要時間は15〜20分(最初の代表の設定は30分ほど)です。最初の代表が入ると、団体の情報・役職・メンバーの招待など、最初にやることがタスクとして用意されるので、順に進めていただけます。手順書もお渡しし、FSIF がご案内します。' },
      { q: '導入までどれくらいかかりますか？', a: 'ご契約の後、立ち上げは15〜20分ほど、メンバーの招待は当日から行えます。最初は1つのプロジェクトから始め、1か月ほどで使い方を定着させる進め方をおすすめしています。' },
      { q: 'カスタマイズできますか？', a: '役職・部署・領域・スキル・カテゴリ・スキルのレベルの決め方・申請フォーム・団体のロゴやテーマの色・通知の受け取り方などは、団体ごとに設定できます。仕組みそのものはすべての団体で共通のため、団体ごとの個別の改造はお受けしていません。改善のご要望は、画面の「改善を要望する」からお寄せください。' },
      { q: '料金はいくらですか？', a: PRICING },
    ],
  },
  {
    id: 'data',
    label: 'データ・セキュリティ',
    items: [
      { q: 'データはどこに保存されますか？', a: '団体の Google アカウントの中です。タスク・人材・申請などのデータは団体の Google スプレッドシートに保存され、仕組み(Google Apps Script)も団体のアカウントの中で動きます。FSIF のサーバーに団体の運用データは集めません。FSIF が受け取るのは、団体の登録の情報、プランに応じたアンケートの回答、個人を特定しない集計値だけです。' },
      { q: '退会・契約終了時のデータはどうなりますか？', a: 'データは団体の Google アカウントの中にあるため、契約が終わってもそのまま団体の手元に残り、FSIF が消したり持ち出したりすることはありません。終了の後は Ohsumi の画面からは使えなくなりますが、スプレッドシートや、事前に Excel で書き出したデータはそのままお使いいただけます。FSIF が持つ登録の情報は、プライバシーポリシーに沿って扱います。' },    ],
  },
]

export type NewsCategory = '新機能' | '改善' | 'お知らせ' | '導入事例' | 'イベント' | 'Security'

export type NewsPost = {
  slug: string
  date: string
  category: NewsCategory
  title: string
  excerpt: string
  body: string[]
}

export const NEWS: NewsPost[] = [
  {
    slug: 'official-site-launch',
    date: '2026-10-10',
    category: 'お知らせ',
    title: 'Ohsumi公式サイトを公開しました',
    excerpt: '組織運営プラットフォーム「Ohsumi」の公式サイトを公開しました。機能・導入方法・セキュリティについての情報を掲載しています。',
    body: [
      '未来宇宙産業フォーラム（FSIF）が開発・運営する組織運営プラットフォーム「Ohsumi（オオスミ）」の公式サイトを公開しました。',
      '本サイトでは、Ohsumiの考え方や機能、導入の流れ、セキュリティに関する情報を順次掲載していきます。',
      '画面のご紹介やデモのご依頼、導入に関するご相談は、お問い合わせフォームから受け付けています。',
    ],
  },
]

export function getFeature(slug: string) {
  return FEATURES.find((f) => f.slug === slug)
}

export function formatDate(iso: string) {
  const [y, m, d] = iso.split('-')
  return `${y}.${m}.${d}`
}
