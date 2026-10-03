// スマホの幅(375px)で主な画面を開き、横にはみ出す箇所が無いことを確かめる(CI で実行する)。
//
//   1. テスト用の設定(GAS の URL など)でビルドする(--no-build で省略)
//   2. gas/Code.gs のサンプルのデータ(buildSampleData_)を、GAS の読み取りの絞り込み
//      (buildViewerData)に通して、そのメンバーが受け取るデータを作る。
//      一般のメンバー(OUTPUT・タスク詳細・個人ページ)と、代表(管理画面のすべてのセクション)の2回開く
//   3. out/ を配信し、ヘッドレスの Chrome で開く。GAS・Google への通信は偽の応答を返す
//   4. 画面ごとに、ページの幅が画面より広くなっていないか・画面の外にはみ出した要素が無いか・
//      ボタンの文字が1文字ずつ折り返していないか・依存関係のカードの中身が切れていないかを調べる
//
// 使い方: node scripts/check-layout.mjs [--no-build]
// Chrome の場所は CHROME_PATH で指定できる(未指定なら、よくある場所を探す)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
export const WIDTH = Number(process.env.LAYOUT_WIDTH || 375)
const GAS_URL = 'https://script.google.com/macros/s/LAYOUT_CHECK/exec'
const ORG = 'org_LAYOUTLAYOUTLAYOUT01'
// 招待リンクで開く、レジストリに無い団体
const MISSING_ORG = 'org_MISSINGMISSINGMISS01'
const MEMBER = 'sample-m-05' // 一般のメンバー(サンプルのデータの base の枠)
export const ADMIN_MEMBER = 'sample-m-01' // 代表(サンプルのデータの top の枠)

// ほかの端末で開く の手順で押すボタン・確かめる文(ja.ts にあることを lib/ohsumi/check-layout.test.ts で確かめる)
export const OTHER_DEVICE_LABELS = ['ほかの端末で開く', '共有', '自分のメールに送る']
export const OTHER_DEVICE_TEXTS = ['ホーム画面に追加', 'まだメールで送れません', '読み取り専用のため、保存できません']

// 画面を開く手順。ラベルは日本語の画面の表示(lib/ohsumi/i18n/ja.ts)と同じ文字にする
// (lib/ohsumi/check-layout.test.ts で、ja.ts にあることを確かめる)
export const STEPS = [
  // テスト用の団体(ORG)を、招待リンクから開く(レジストリの偽物が接続先を答える。ビルド時の既定の団体は無い)
  { name: 'ログイン画面', do: 'login' },
  { name: 'ログイン画面(招待リンクなし)', do: 'loginNoOrg' },
  { name: 'ログイン画面(招待リンクなし・この端末の団体から選ぶ)', do: 'loginNoOrgPick' },
  { name: 'ログイン画面(団体を選ぶ)', do: 'loginOrgs' },
  { name: 'ログイン画面(招待リンクの団体が見つからない)', do: 'loginMissingOrg' },
  // 団体に登録されていない Google アカウントでログインした時: 団体名と対処を出し、初期設定コードの欄は開かない
  { name: 'ログイン画面(登録されていないアカウント)', do: 'loginNotMember' },
  // この端末に保存した団体は、団体ID の確認(getLoginConfig)の答えを待たずにログインボタンを出す
  { name: 'ログイン画面(保存した団体・確認が遅い)', do: 'loginSlowConfig' },
  { name: 'OUTPUT(自分)', do: 'home' },
  { name: 'OUTPUT(一覧)', do: 'click', text: '一覧' },
  { name: 'ワークフロー', do: 'click', text: 'ワークフロー' },
  { name: 'リスト', do: 'click', text: 'リスト' },
  { name: 'カレンダー', do: 'click', text: 'カレンダー' },
  { name: '難易度', do: 'click', text: '難易度' },
  { name: '依存関係', do: 'click', text: '依存関係', dependencyCards: true },
  { name: 'ガント', do: 'click', text: 'ガント' },
  { name: '公募', do: 'click', text: '公募' },
  { name: 'タスク詳細(担当者が多い)', do: 'openTask', view: 'リスト', text: '担当者が多いタスク' },
  { name: 'タスク詳細(長い名前・説明)', do: 'openTask', view: 'リスト', text: 'とても長いタスク名の例' },
  { name: '個人ページ(タスク)', do: 'profile' },
  { name: '個人ページ(人材育成)', do: 'click', text: '人材育成' },
  { name: '個人ページ(経歴・キャリア)', do: 'click', text: '経歴・キャリア' },
  { name: '個人ページ(設定)', do: 'click', text: '設定' },
  // ほかの端末で開く(メニュー): 招待リンク・QR コード・コピー・共有・自分のメールに送る。スマホの幅とパソコンの幅の両方で開く
  // (ラベルは ja.ts の header.menu.otherDevice・otherDevice.*)
  { name: 'ほかの端末で開く', do: 'otherDevice', labels: OTHER_DEVICE_LABELS },
  { name: 'ほかの端末で開く(パソコンの幅・共有あり)', do: 'otherDevice', width: 1280, share: true, labels: OTHER_DEVICE_LABELS },
  { name: 'ほかの端末で開く(レジストリに未確認の団体)', do: 'otherDevice', mail: 'notChecked', labels: OTHER_DEVICE_LABELS },
  // 提供停止・機能停止(R1-e): 画面の上部の知らせ(文は ja.ts の app.contract*)
  { name: 'OUTPUT(機能停止中の知らせ)', do: 'contract', contract: { phase: 'inEffect', kind: 'restrict', suspendAt: '2026-10-01T00:00:00.000Z' }, expect: 'アンケートへの回答をお願いします' },
  { name: 'OUTPUT(提供停止の予告)', do: 'contract', contract: { phase: 'scheduled', kind: 'suspend', days: 6 }, expect: '提供を停止します' },
  // 書きかけを守る(PR C): ログインが切れた・画面が古い時は、送れなかった文章をコピーできるように出し、INPUT の書きかけは残す。
  // 権限が足りない時はデータを読み直す。ログインの期限が近づいたら、先に知らせる
  { name: 'ログインが切れた時(送れなかったコメントを出す・書きかけを残す)', do: 'unsaved', fail: 'authError', view: 'リスト', text: '担当者が多いタスク' },
  { name: '画面が古い時(送れなかったコメントを出す・読み込み直す)', do: 'unsaved', fail: 'reloadRequired', view: 'リスト', text: '担当者が多いタスク' },
  { name: '権限が足りない時(データを読み直す)', do: 'unsaved', fail: 'forbidden', view: 'リスト', text: '担当者が多いタスク' },
  // 1つの記録が長くなりすぎた時(PR I): 断られたコメントをコピーできるように出す
  { name: '記録が長くなりすぎた時(送れなかったコメントを出す)', do: 'unsaved', fail: 'cellTooLong', view: 'リスト', text: '担当者が多いタスク' },
  // ほかの人が先に変えていた時(PR J): 書いたコメントをコピーできるように出し、最新の内容に読み直す
  { name: 'ほかの人が先に変えていた時(送れなかったコメントを出す・読み直す)', do: 'unsaved', fail: 'conflict', view: 'リスト', text: '担当者が多いタスク' },
  { name: 'ログインの期限が近い時の知らせ', do: 'sessionExpiry' },
]

// 代表で開く管理画面。ラベルは管理画面の左のメニュー(components/ohsumi/admin/admin-screen.tsx の
// buildNav と、ja.ts の admin.nav.*)と同じ文字にする(lib/ohsumi/check-layout.test.ts で確かめる)
export const ADMIN_STEPS = [
  { name: '管理画面(Dashboard)', do: 'admin' },
  ...['幹部 View', 'Approvals', 'Assignments', 'Projects', 'Members', 'Analytics', 'Tags', 'Org Tree', '検定', '学習コンテンツ',
    'レーダー', '経費申請', 'フォーム', '人材DB', '日報・週報', '採用'].map((text) => ({ name: `管理画面(${text})`, do: 'click', text, from: 'aside nav button' })),
  // スキルのレベルの決め方(PR Z): 団体の既定を変える欄(5つのレベルの点数・条件)を開いた状態
  { name: '管理画面(Tags・スキルのレベルの決め方の入力欄)', do: 'skillRules' },
  // バックアップから戻す(団体設定。代表だけ): 全体を戻す前の件数の差と、一部のタスクだけ戻す時の違い
  { name: '団体設定(バックアップ・全体を戻す)', do: 'backup', mode: 'full' },
  { name: '団体設定(バックアップ・一部のタスクだけ戻す)', do: 'backup', mode: 'tasks' },
]

// 機能停止中(読み取り専用。R1-e)に、閲覧のための欄・ボタンと書き出しが使えること、書く欄が止まることを確かめる。
// ラベルは日本語の表示(ja.ts)と同じ文字にする(lib/ohsumi/check-layout.test.ts で確かめる)
export const READ_ONLY_CONTRACT = { phase: 'inEffect', kind: 'restrict', suspendAt: '2026-10-01T00:00:00.000Z' }
export const READ_ONLY_STEPS = [
  { name: '機能停止中: ワークスペース(期間・プロジェクト・表示・並び替え・表示項目)', do: 'readOnlyWorkspace',
    labels: ['一覧', 'すべてのプロジェクト', '表示項目', '表示順', 'ワークフロー', 'リスト', 'カレンダー', 'ガント'] },
  { name: '機能停止中: リスト(検索・Excel 出力)', do: 'readOnlyList', labels: ['リスト', 'Excel出力'] },
  { name: '機能停止中: タスク詳細(書く欄は使えない)', do: 'readOnlyTask', view: 'リスト', text: '担当者が多いタスク' },
  { name: '機能停止中: 管理画面(検索・絞り込み・書き出し)', do: 'readOnlyAdmin', labels: ['全データをExcel出力', 'Members', '日報・週報', '人材DB'] },
  // 主な作成の操作が、保存の手前で止まること(GAS に書き込みを送らない。止めた知らせを出し、書いた文章を残す)。
  // 偽の GAS は書き込みも受け付けるので、画面の止め方に漏れがあれば、送った書き込みとして見つかる
  { name: '機能停止中: タスクの追加が保存の手前で止まる', do: 'readOnlyAddTask', labels: ['INPUT', 'イベント準備の4タスクを入力', 'タスクを整理する', '選択したタスクを登録'] },
  { name: '機能停止中: コメントが保存の手前で止まる', do: 'readOnlyComment', view: 'リスト', text: '担当者が多いタスク', labels: ['送信'] },
  { name: '機能停止中: 経費申請が保存の手前で止まる', do: 'readOnlyExpense', labels: ['経費申請', '申請する'] },
  { name: '機能停止中: 承認が保存の手前で止まる', do: 'readOnlyApprove', labels: ['Approvals', '承認する'] },
  // 書き込みではないので、機能停止中も自分のメールに送れる
  { name: '機能停止中: ほかの端末で開く(メールも送れる)', do: 'otherDevice', readOnly: true, labels: OTHER_DEVICE_LABELS },
]

// 読み取り(GAS の READ_ONLY_ACTIONS と同じ)。これ以外を画面が送ったら、書き込みとして数える
export const LAYOUT_READ_ACTIONS = ['ping', 'getLoginConfig', 'exchangeIdToken', 'getInitialData', 'getBackgroundData', 'getMyEmails', 'getExpenses',
  'getFiles', 'getWebhookStatus', 'getMailQuotaStatus', 'getGasUpdateStatus', 'getBackupStatus', 'listBackups', 'createBackupNow', 'previewRestore', 'searchBackupTasks', 'getPersonalDataStatus', 'getOpsStatus', 'getUsageStatus', 'getMetricsStatus', 'getAnnouncements', 'getDiagnostics', 'sendDiagnostics', 'getCandidates', 'getFormSubmissions', 'fetchDailyReports', 'translateText', 'revokeMySessions',
  'revokeMemberSessions', 'updateLastLogin', 'getInviteMailStatus', 'sendInviteLinkToMe']

// レジストリの管理画面(/registry-admin/)。ラベルは components/registry/registry-admin.tsx の TABS と同じ文字にする
// (lib/ohsumi/check-layout.test.ts で確かめる)
export const REGISTRY_URL = 'https://script.google.com/macros/s/LAYOUT_REGISTRY/exec'
export const REGISTRY_STEPS = [
  { name: 'レジストリ管理(ログイン)', do: 'registryLogin' },
  { name: 'レジストリ管理(団体)', do: 'registry' },
  { name: 'レジストリ管理(停止の予定を入れる)', do: 'registrySuspend' },
  { name: 'レジストリ管理(当日の提供停止の確認)', do: 'registrySuspendNow' },
  { name: 'レジストリ管理(プランを変える)', do: 'registryPlan' },
  { name: 'レジストリ管理(登録コード)', do: 'click', text: '登録コード', from: '[role=tab]' },
  { name: 'レジストリ管理(登録コードを発行した後)', do: 'registryIssue' },
  { name: 'レジストリ管理(アンケート)', do: 'click', text: 'アンケート', from: '[role=tab]' },
  { name: 'レジストリ管理(アンケートの送り先を選ぶ)', do: 'registrySurveys' },
  { name: 'レジストリ管理(お知らせ)', do: 'click', text: 'お知らせ', from: '[role=tab]' },
  { name: 'レジストリ管理(お知らせの出す団体を選ぶ)', do: 'registryAnnouncements' },
  { name: 'レジストリ管理(診断情報)', do: 'click', text: '診断情報', from: '[role=tab]' },
  { name: 'レジストリ管理(診断情報の中身)', do: 'registryDiagnostics' },
  { name: 'レジストリ管理(操作の記録)', do: 'click', text: '操作の記録', from: '[role=tab]' },
]

// レジストリの偽の応答(長い団体名・URL・メールで、はみ出しを確かめる)
export function registryResponse(body) {
  const long = 'とても長い名前の特定非営利活動法人テスト団体ロングネームの会'
  const iso = (d) => new Date(Date.UTC(2026, 9, d)).toISOString()
  switch (body.action) {
    case 'adminOverview':
      return {
        me: { email: 'registry.admin.with.a.long.address@example.com', authAt: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 1800 },
        codeTtlDays: 14,
        gasVersions: [
          { version: '2026.11.01-1', security: false, required: false, note: '', updatedAt: '', updatedBy: '' },
          { version: '2026.10.01-1', security: true, required: true, note: '通知・タスクの書き換えを GAS が守る修正(PR A)を含む最初の版。'.repeat(2), updatedAt: '', updatedBy: '' },
        ],
        orgs: [
          { orgId: 'org_' + 'x'.repeat(40), displayName: long, status: 'active', state: 'active', checkState: 'ok', contractStatus: 'active', contractUntil: iso(31), contractNote: '', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: '', suspendReason: '', suspendKind: 'suspend', suspendScheduledBy: '', noticesSent: [], plan: 'cosmo_base', channel: 'standard', gasUrl: 'https://script.google.com/macros/s/' + 'A'.repeat(70) + '/exec', gasVersion: '2026.10.01-1',
            gasStatus: { current: '2026.10.01-1', latest: '2026.10.01-1', minimum: '2026.10.01-1', security: false, versionState: 'latest', noCheck: false, judgement: 'latest' } },
          { orgId: 'org_b', displayName: '停止予定の団体', status: 'active', state: 'scheduled', checkState: 'stale', contractStatus: 'ending', contractUntil: '', contractNote: '契約の更新なし', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: iso(15), suspendReason: '契約の終了', suspendKind: 'suspend', suspendScheduledBy: 'registry.admin.with.a.long.address@example.com', noticesSent: [14, 7], plan: '', channel: 'standard', gasUrl: '', gasVersion: '', mail: { remaining: 8, skipped: 0, date: '2026-10-01', limitDate: '2026-09-28', level: 'low' },
            gasStatus: { current: '', latest: '2026.10.01-1', minimum: '2026.10.01-1', security: true, versionState: 'updateRequired', noCheck: true, judgement: 'noCheck' } },
          { orgId: 'org_r', displayName: '機能停止中の団体', status: 'active', state: 'restricted', checkState: 'ok', contractStatus: 'active', contractUntil: '', contractNote: '', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: iso(2), suspendReason: 'アンケートの未回答'.repeat(4), suspendKind: 'restrict', suspendScheduledBy: 'registry.admin.with.a.long.address@example.com', noticesSent: [14, 7, 1], plan: 'ohsumi', channel: 'standard', gasUrl: '', gasVersion: 'r1e-1', mail: { remaining: 0, skipped: 37, date: '2026-10-01', limitDate: '2026-10-01', level: 'reached' },
            jobs: { dailyAt: iso(-3), hourlyAt: iso(-1), reported: true, dailyStale: true },
            gasStatus: { current: 'r1e-1', latest: '2026.10.01-1', minimum: '2026.10.01-1', security: true, versionState: 'updateRequired', noCheck: false, judgement: 'updateRequired' } },
          { orgId: 'org_demo', displayName: 'デモ団体(立ち上げのテスト)', status: 'active', state: 'active', checkState: 'ok', contractStatus: 'active', contractUntil: '', contractNote: '', lastCheckAt: iso(1), createdAt: iso(1), suspendAt: '', suspendReason: '', suspendKind: 'suspend', suspendScheduledBy: '', noticesSent: [], plan: 'ohsumi', channel: 'standard', gasUrl: '', gasVersion: '2026.10.01-1', demo: true, disabledFeatures: ['dailyReports', 'webhookSettings', 'calendarSync'], tunables: { inviteMailPerHour: 1, contractRecheckIdleSec: 1800 } },
          { orgId: 'org_c', displayName: '停止中の団体', status: 'suspended', state: 'suspended', checkState: 'never', contractStatus: 'ended', contractUntil: '', contractNote: '', lastCheckAt: '', createdAt: iso(1), suspendAt: iso(1), suspendReason: '契約の終了', suspendKind: 'suspend', suspendScheduledBy: '', noticesSent: [0], plan: 'paid', channel: '', gasUrl: '', gasVersion: '' },
        ],
        codes: ['unused', 'used', 'expired', 'revoked'].map((state, i) => ({
          codeId: 'rc_' + i + 'abcdefghij', kind: 'new', orgName: i ? '団体' + i : long, contactName: '担当 太郎', contactEmail: 'contact.person.long.address@example.org', note: i ? '' : 'とても長いメモ'.repeat(8),
          state, expiresAt: iso(14), issuedBy: 'registry.admin.with.a.long.address@example.com', issuedAt: iso(1), usedAt: state === 'used' ? iso(2) : '', usedOrgId: state === 'used' ? 'org_' + 'y'.repeat(40) : '', revokedAt: state === 'revoked' ? iso(3) : '', revokedBy: state === 'revoked' ? 'registry.admin.with.a.long.address@example.com' : '',
        })),
        kpis: { activeOrgs: 3, byPlan: { ohsumi: 1, cosmo_base: 1, paid: 0, '': 1 }, demoOrgs: 1, metrics: { reportingOrgs: 2, latestPeriod: '2026-09-28', totals: { members: 52, active_7d: 31, tasks: 1240, tasks_done: 980, tasks_overdue: 12 } } },
        mailQueue: { pending: 23, recipients: 31, byKind: { reminder: 15, send: 8 }, oldestAt: iso(1), remainingToday: 0 },
        // 機能のスイッチ(全団体で止めている機能・止められる機能の一覧)
        // 上限・しきい値(項目の一覧と、全団体の値)
        tunables: { catalog: [['notifyPerHour','通知(1人1時間)',60,10,300],['mentionPerHour','メンションの通知の宛先(1人1時間)',30,5,100],['resultNotifyPerHour','結果の通知(1人1時間)',10,3,50],['translatePerHour','翻訳する文(1人1時間)',500,50,2000],['clientErrorPerHour','画面のエラーの記録(1人1時間)',30,5,100],['inviteMailPerHour','本人あての招待リンクのメール(1人1時間)',3,1,10],['digestMailReserve','まとめて送る分に回すメールの残り',10,5,50],['dailyJobStaleHours','毎日の処理が止まったとみなす時間',26,25,72],['hourlyJobStaleHours','毎時の処理が止まったとみなす時間',3,2,24],['personalDataNoticeDays','個人情報を消す前に知らせる日数',7,3,30],['metricsRetryMaxHours','集計値の送り直しの間隔の上限(時間)',24,6,72],['contractRecheckIdleSec','書き込みの前にレジストリへ確かめ直す間隔(秒)',600,120,1800],['announcementsCacheSec','お知らせを覚えておく時間(秒)',600,60,3600]].map(([key, label, def, min, max]) => ({ key, label, def, min, max })), global: { translatePerHour: 1000 } },
        features: { catalog: [['uploads','ファイルのアップロード'],['expenses','経費の申請・承認'],['forms','フォーム・アンケートの回答と承認'],['schedule','日程調整'],['dailyReports','日報の提出'],['recruiting','採用の候補者'],['skills','スキル・ポイント・クイズ'],['projectHealth','プロジェクトの健康状態'],['training','研修の申請'],['memberSurvey','メンバーのアンケートの回答'],['restore','バックアップから戻す'],['personalData','個人情報の削除の操作'],['webhookSettings','Discord・Slack の設定と接続テスト'],['chatNotify','Discord・Slack への通知'],['calendarSync','Google カレンダーへの登録'],['recurringTasks','定期タスクの作成'],['metricsSend','FSIF への集計値の送信']].map(([id, label]) => ({ id, label })), globalDisabled: ['chatNotify'] },
        diagnostics: [
          { receiptNo: 'D261001-AB2C', orgId: 'org_' + 'x'.repeat(40), orgName: long, receivedAt: iso(1), gasVersion: '2026.10.01-13' },
        ],
        announcements: [
          { announcementId: 'an_1', title: 'とても長い題のお知らせ'.repeat(3), body: '1行目\n' + 'とても長い本文の例です。'.repeat(10), importance: 'urgent', targetKind: 'orgs', targetPlan: '', targetOrgIds: ['org_' + 'x'.repeat(40), 'org_b'],
            publishedAt: iso(1), expiresAt: iso(31), createdBy: 'registry.admin.with.a.long.address@example.com', state: 'active', withdrawnAt: '', withdrawnBy: '' },
          { announcementId: 'an_2', title: 'Ohsumiプランの団体へ', body: '本文', importance: 'normal', targetKind: 'plan', targetPlan: 'ohsumi', targetOrgIds: [],
            publishedAt: iso(1), expiresAt: iso(2), createdBy: 'registry.admin.with.a.long.address@example.com', state: 'expired', withdrawnAt: '', withdrawnBy: '' },
        ],
        surveyLimits: { ohsumi: 24, cosmo_base: 12, paid: 4 },
        survey12mCounts: { ['org_' + 'x'.repeat(40)]: 12, org_b: 0, org_r: 3, org_c: 4 },
        surveys: [
          { surveyId: 'sv_1', orgId: 'org_r', orgName: '機能停止中の団体', plan: 'ohsumi', title: '2026年秋の利用状況のアンケート(とても長い名前の例です)'.repeat(2), formUrl: 'https://docs.google.com/forms/d/e/' + 'F'.repeat(56) + '/viewform',
            sendDate: '2026-09-01', dueDate: '2026-09-15', state: 'overdue', day: 30, remindersSent: [0, 7, 10, 14, 15, 21, 26, 27], answeredAt: '', answeredBy: '', createdBy: 'registry.admin.with.a.long.address@example.com', createdAt: iso(1), restrictAt: iso(2), canRestrict: false },
          { surveyId: 'sv_2', orgId: 'org_' + 'x'.repeat(40), orgName: long, plan: 'cosmo_base', title: '秋のアンケート', formUrl: 'https://forms.gle/abcdefghijk',
            sendDate: '2026-09-10', dueDate: '2026-09-24', state: 'overdue', day: 21, remindersSent: [0, 7, 10, 14, 15, 21], answeredAt: '', answeredBy: '', createdBy: 'registry.admin.with.a.long.address@example.com', createdAt: iso(1), restrictAt: '', canRestrict: true },
          { surveyId: 'sv_3', orgId: 'org_c', orgName: '停止中の団体', plan: 'paid', title: '秋のアンケート', formUrl: 'https://forms.gle/abcdefghijk',
            sendDate: '2026-09-10', dueDate: '2026-09-24', state: 'overdue', day: 21, remindersSent: [0, 7, 10, 14, 15, 21], answeredAt: '', answeredBy: '', createdBy: 'registry.admin.with.a.long.address@example.com', createdAt: iso(1), restrictAt: '', canRestrict: false },
          { surveyId: 'sv_4', orgId: 'org_b', orgName: '停止予定の団体', plan: '', title: '冬のアンケート', formUrl: 'https://forms.gle/zzz',
            sendDate: '2026-10-20', dueDate: '2026-11-03', state: 'scheduled', day: -19, remindersSent: [], answeredAt: '', answeredBy: '', createdBy: 'registry.admin.with.a.long.address@example.com', createdAt: iso(1), restrictAt: '', canRestrict: false },
        ],
        audit: [
          { at: iso(4), actor: 'registry.admin.with.a.long.address@example.com', action: 'scheduleSuspension', target: 'org_r', before: '', after: JSON.stringify({ kind: 'restrict', suspendAt: iso(2) }), reason: 'アンケートの未回答' },
          { at: iso(3), actor: 'registry.admin.with.a.long.address@example.com', action: 'issueRegistrationCode', target: 'rc_0abcdefghij', before: '', after: JSON.stringify({ orgName: long, contactEmail: 'contact.person.long.address@example.org', expiresAt: iso(14) }), reason: '' },
          { at: iso(2), actor: 'stranger@example.com', action: 'adminLoginDenied', target: '', before: '', after: '', reason: '許可リスト(ADMIN_EMAILS)に無いアカウント' },
        ],
      }
    case 'getDiagnosticsReport':
      return { receiptNo: 'D261001-AB2C', orgId: 'org_' + 'x'.repeat(40), orgName: long, receivedAt: iso(1), gasVersion: '2026.10.01-13',
        diagnostics: { version: '2026.10.01-13', settings: { triggers: ['sendBatchNotifications'.repeat(4)] }, limits: { rows: { Tasks: 1200 } } } }
    case 'issueRegistrationCode':
      return { code: 'ABCD-EFGH-JKMN-PQRS', codeId: 'rc_new', expiresAt: new Date(Date.UTC(2026, 9, 15)).toISOString(), orgName: body.orgName }
    default:
      return {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ヘッドレスの Chrome を起動し、操作の窓口(remote debugging)が開くまで待つ。
// CI のランナーでは起動が遅いことがあるので、1回に30秒まで待ち、開かなければ別のポートで起動し直す(3回まで)
async function launchChrome(chromePath) {
  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = 9300 + Math.floor(Math.random() * 500)
    const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
    let exited = null
    chrome.on('exit', (code) => { exited = code })
    for (let i = 0; i < 150 && exited === null; i++) {
      await sleep(200)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) return { chrome, targets }
      } catch { /* 起動中 */ }
    }
    lastError = exited !== null ? `Chrome が終了しました(終了コード ${exited})` : '30秒待っても操作の窓口が開きません'
    chrome.kill()
    console.warn(`Chrome の起動に失敗しました(${attempt}回目: ${lastError})`)
  }
  throw new Error(`Chrome を起動できませんでした(${lastError})`)
}

// ---- サンプルのデータ(一般のメンバーが受け取る分) ----
export function viewerData(memberId = MEMBER) {
  const code = readFileSync(join(ROOT, 'gas', 'Code.gs'), 'utf8')
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } })
  vm.runInContext(code, ctx)
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
  const data = ctx.buildSampleData_(today, {})
  const settings = ctx.mergeSampleSettings_({}, data.settings).values
  const table = (name, rows) => {
    const headers = ctx.SHEET_HEADERS[name]
    return { headers, rows: rows.map((r) => headers.map((h) => (r[h] == null ? '' : String(r[h])))) }
  }
  const snapshot = {
    Members: table('Members', data.sheets.Members),
    Projects: table('Projects', data.sheets.Projects),
    Tasks: table('Tasks', data.sheets.Tasks),
    Settings: { headers: ['key', 'value'], rows: Object.entries(settings).map(([k, v]) => [k, v]) },
  }
  return ctx.buildViewerData_(JSON.parse(JSON.stringify(snapshot)), memberId)
}

// ---- out/ の配信 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' }
function serve(dir) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = join(dir, p)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) && existsSync(file + '.html')) file += '.html'
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  try { return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim() || null } catch { return null }
}

// ---- 画面の中で実行する調査(はみ出し・つぶれたボタン・切れたカード) ----
const MEASURE = `(() => {
  const W = document.documentElement.clientWidth
  const cls = (el) => (el && typeof el.className === 'string' ? el.className.split(' ').slice(0, 5).join('.') : '')
  const desc = (el) => el.tagName.toLowerCase() + '.' + cls(el) + ' "' + (el.textContent || '').trim().slice(0, 30) + '" (親: ' + cls(el.parentElement) + ' "' + (el.parentElement?.textContent || '').trim().slice(0, 30) + '")'
  const off = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height || r.right <= W + 1) continue
    if (getComputedStyle(el).position === 'fixed') continue
    let p = el.parentElement, clipped = false
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p.getBoundingClientRect().right <= W + 1) { clipped = true; break }
      if (cs.position === 'fixed') { clipped = true; break }
      p = p.parentElement
    }
    if (!clipped) off.push(desc(el) + ' (右端 ' + Math.round(r.right) + 'px)')
  }
  // 短いラベル(ボタン・タブ・バッジ・名前。8文字まで)の文字が、2行以上に折り返していないか
  const lines = (node) => {
    const range = document.createRange(); range.selectNodeContents(node)
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size
  }
  const squashed = [...document.querySelectorAll('button, a, [role=tab], span.rounded-md, span.rounded-full')].filter((b) => {
    const r = b.getBoundingClientRect()
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight * 3) return false
    const texts = []
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
    while (walk.nextNode()) { const t = walk.currentNode.textContent.trim(); if (t.length >= 2 && t.length <= 8) texts.push(walk.currentNode) }
    const wrapped = texts.find((t) => lines(t) > 1)
    if (wrapped) b.dataset.wrappedText = wrapped.textContent.trim()
    return !!wrapped
  }).map((b) => '「' + b.dataset.wrappedText + '」 in ' + desc(b))
  // Ohsumi のロゴのシンボル(ブランドガイドライン v0.4): 縦横比 1:1・回転や影などの効果なし・Ohsumi Blue(団体のテーマの色では変わらない)
  const logos = [...document.querySelectorAll('[data-ohsumi-symbol]')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
    const r = el.getBoundingClientRect()
    const effects = []
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.transform !== 'none') effects.push('transform ' + cs.transform)
      if (e === el && cs.filter !== 'none') effects.push('filter ' + cs.filter)
      if (e === el && cs.boxShadow !== 'none') effects.push('box-shadow')
    }
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, color: getComputedStyle(el).color, effects }
  })
  return JSON.stringify({ page: document.documentElement.scrollWidth, window: window.innerWidth, off: off.slice(0, 5), squashed: squashed.slice(0, 5), logos })
})()`
// ロゴのシンボルの色(Ohsumi Blue #2F5BEA)
const LOGO_BLUE = 'rgb(47, 91, 234)'
let logoChecks = 0
// カード全体、またはカードの中の行(文字が入ったもの)が、縦に押しつぶされて切れていないか
const MEASURE_CARDS = `JSON.stringify([...document.querySelectorAll('.cursor-grab.absolute')].filter((c) =>
  c.scrollHeight > c.clientHeight + 1 ||
  [...c.querySelectorAll('*')].some((k) => (k.textContent || '').trim() && k.getBoundingClientRect().height > 0 && k.scrollHeight > k.clientHeight + 1)
).map((c) => (c.textContent || '').trim().slice(0, 30)))`

async function run({ build = true } = {}) {
  if (build) {
    console.log('テスト用の設定でビルドします…')
    const env = { ...process.env, NEXT_PUBLIC_GAS_URL: '', NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: '000000000000-layout.apps.googleusercontent.com',
      NEXT_PUBLIC_REGISTRY_URL: REGISTRY_URL, NEXT_PUBLIC_REGISTRY_OAUTH_CLIENT_ID: '000000000000-registry.apps.googleusercontent.com' }
    const b = spawnSync('pnpm', ['exec', 'next', 'build'], { cwd: ROOT, env, stdio: 'inherit' })
    if (b.status !== 0) throw new Error('ビルドに失敗しました')
    const c = spawnSync('node', ['scripts/csp.mjs'], { cwd: ROOT, stdio: 'inherit' })
    if (c.status !== 0) throw new Error('CSP の確認に失敗しました')
  }
  const chromePath = findChrome()
  if (!chromePath) {
    if (process.env.CI) throw new Error('Chrome が見つかりません(CHROME_PATH で指定してください)')
    console.warn('Chrome が見つからないため、確認をとばしました')
    return []
  }
  // 開いているメンバーと、そのメンバーが受け取るデータ(2回目は代表に切り替える)
  let member = MEMBER
  let view = viewerData(MEMBER)
  const server = await serve(join(ROOT, 'out'))
  const base = `http://127.0.0.1:${server.address().port}`
  const { chrome, targets } = await launchChrome(chromePath)
  const failures = []
  try {
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r))
    let id = 0
    const pending = new Map()
    const listeners = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) listeners.forEach((l) => l(m))
    })
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expression, userGesture = false) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
      return r.result?.result?.value
    }

    // 画面の上部の知らせを確かめる時に、GAS の応答に付ける停止の状態(R1-e)
    let contract = null
    // 画面が送った書き込み(読み取りの一覧に無い操作)
    let sentWrites = []
    // 書き込みに返す失敗(authError・reloadRequired・forbidden)と、初期データを読んだ回数
    let failWrites = ''
    let initialDataCalls = 0
    // ほかの端末で開く: getInviteMailStatus の答え(available / notChecked)と、送った sendInviteLinkToMe の本文
    let inviteMail = 'available'
    // exchangeIdToken に、団体に登録されていないアカウントとして答える
    let notMember = false
    let inviteBodies = []
    // getLoginConfig の答えを遅らせる時間(ミリ秒)と、送られた回数
    let slowConfigMs = 0
    let configCalls = 0
    // GAS・Google への通信には偽の応答を返す(外には出さない)
    const gas = (body) => {
      if (!LAYOUT_READ_ACTIONS.includes(body.action)) {
        sentWrites.push(body.action === 'batch' ? 'batch(' + (body.ops || []).map((o) => o.action).join(',') + ')' : body.action)
      }
      switch (body.action) {
        case 'getLoginConfig': return { orgId: ORG }
        case 'exchangeIdToken': return notMember ? { memberId: null, email: 'stranger@example.com', orgName: 'サンプル団体' } : {}
        case 'getInitialData': return { memberId: member, version: 'layout', sheets: view }
        case 'getExpenses': case 'fetchDailyReports': case 'getFiles': case 'getFormSubmissions': case 'getCandidates': return []
        case 'getMyEmails': return { email: 'member@example.com' }
        case 'getInviteMailStatus': return inviteMail === 'available' ? { available: true, remaining: 3 } : { available: false, reason: inviteMail, remaining: 3 }
        case 'sendInviteLinkToMe': inviteBodies.push(body); return { sent: true, count: 1, remaining: 2 }
        case 'checkAndGenerateRecurringTasks': return { generated: [] }
        // 管理画面の上部に、メールの上限の知らせを出す
        // 毎日の処理の止まり・共有の警告
        case 'getOpsStatus': return {
          jobs: { dailyAt: '2026-09-28T21:00:00.000Z', hourlyAt: '2026-09-30T23:00:00.000Z', installedAt: '2026-09-01T00:00:00.000Z', dailyFailedAt: '2026-09-30T21:00:00.000Z',
            dailyError: 'Exception: You do not have permission to call DriveApp.getFileById. Required permissions: https://www.googleapis.com/auth/drive', hourlyFailedAt: '', hourlyError: '', dailyStale: true, hourlyStale: false, staleHours: 26 },
          sharing: { checkedAt: '2026-09-30T21:00:00.000Z', problems: [
            { target: 'spreadsheet', kind: 'link', detail: 'ANYONE_WITH_LINK' },
            { target: 'spreadsheet', kind: 'editor', detail: 'former.leader.with.a.long.address@example.com' },
            { target: 'uploads', kind: 'viewer', detail: 'member@example.com' },
          ] },
          // FSIF がレジストリから止めている機能(知らない ID は GAS が付けた名前を出す)
          disabledFeatures: [{ id: 'dailyReports', label: '日報の提出' }, { id: 'futureFeature', label: 'これから足す機能(とても長い名前の機能の説明が続きます)'.repeat(2) }],
          // 1つのセルの上限の8割を超えている記録
          longRecords: { warnAt: 40000, max: 50000, maxLength: 47210, groups: [
            { sheet: 'Members', field: 'one_on_ones_json', label: '1on1 の記録', count: 2, items: [
              { id: 'm1', name: 'とても長い名前のメンバーさん'.repeat(2), length: 47210 }, { id: 'm2', name: '', length: 41000 }] },
            { sheet: 'Tasks', field: 'comments_json', label: 'コメント', count: 1, items: [{ id: 't1', name: 'コメントが多いタスク', length: 40500 }] },
          ] },
          // FSIF からの回答待ちのアンケート(期限を過ぎて、機能停止の予定が入ったもの)
          surveys: [
            { surveyId: 'sv_1', title: '2026年秋の利用状況のアンケート(とても長い名前の例です)'.repeat(2), formUrl: 'https://docs.google.com/forms/d/e/' + 'F'.repeat(56) + '/viewform', sendDate: '2026-09-10', dueDate: '2026-09-24', overdue: true, restrictAt: '2026-10-07T15:00:00.000Z' },
            { surveyId: 'sv_2', title: 'javascript の URL は出さない', formUrl: 'javascript:alert(1)', sendDate: '2026-09-10', dueDate: '2026-09-24', overdue: false, restrictAt: '' },
          ] }
        // 診断情報(長い値・入れ子で、はみ出しを確かめる)
        case 'getDiagnostics': return { diagId: 'dg_layoutcheck0001', history: [{ receiptNo: 'D260930-AB2C', at: '2026-09-30T03:00:00.000Z' }], diagnostics: {
          version: '2026.10.01-13', generatedAt: '2026-10-01T03:00:00.000Z', timeZone: 'Asia/Tokyo',
          registry: { registered: true, plan: 'ohsumi', contractPhase: 'none', checkedAt: '2026-10-01T02:00:00.000Z' },
          settings: { discordWebhook: true, slackWebhook: false, orgNotificationEmails: 2, triggers: ['checkContractStatus', 'dailyMaintenance', 'sendBatchNotifications'.repeat(3)] },
          limits: { mail: { remaining: 87, skippedToday: 0 }, spreadsheetCells: { used: 123456, limit: 10000000 }, rows: { Members: 42, Tasks: 1200, FormSubmissions: 3 }, otherSheets: { sheets: 2, rows: 31 } },
          errors: { last7Days: 4, byKind: [{ kind: 'conflict', count: 3 }] },
        } }
        case 'sendDiagnostics': return { receiptNo: 'D261001-XY7Z', at: '2026-10-01T03:01:00.000Z', history: [{ receiptNo: 'D261001-XY7Z', at: '2026-10-01T03:01:00.000Z' }, { receiptNo: 'D260930-AB2C', at: '2026-09-30T03:00:00.000Z' }] }
        // FSIF からのお知らせ(緊急・重要・通常。長い題と本文で、はみ出しを確かめる)
        case 'getAnnouncements': return { registered: true, stale: false, fetchedAt: '2026-10-01T03:00:00.000Z', announcements: [
          { announcementId: 'an_1', title: '通常のお知らせ', body: '通常の本文', importance: 'normal', publishedAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-10-20T00:00:00.000Z' },
          { announcementId: 'an_2', title: '緊急: とても長い題のお知らせ'.repeat(3), body: '1行目\n' + 'とても長い本文の例です。https://example.com/a/very/long/url/that/should/wrap/' + 'x'.repeat(60), importance: 'urgent', publishedAt: '2026-09-30T00:00:00.000Z', expiresAt: '2026-10-30T00:00:00.000Z' },
          { announcementId: 'an_3', title: '重要なお知らせ', body: '重要な本文', importance: 'important', publishedAt: '2026-09-25T00:00:00.000Z', expiresAt: '2026-10-25T00:00:00.000Z' },
        ] }
        // FSIF に送る集計値(プレビューと履歴)
        case 'getMetricsStatus': return { plan: 'cosmo_base', mandatory: false, defaultOn: true, enabled: true, slot: { dow: 3, hour: 14 },
          nextAt: '2026-10-07T05:00:00.000Z', definitionsVersion: 2,
          preview: { version: 2, members: 42, active_7d: 30, active_30d: 38, logins_7d: 120, opens_7d: 900, writes_7d: 450, tasks: 640, tasks_open: 80, tasks_done: 560, tasks_overdue: 7, tasks_created_7d: 25, tasks_completed_7d: 31, projects: 12, errors_7d: 2, members_logged_in: 40, comments_7d: 210, reviews_approved_7d: 18, tasks_overdue_days_avg: 6, skill_points_total: 123456, daily_reports_7d: 95, one_on_ones_30d: 14, expenses_7d: 9, form_submissions_7d: 22, applications_rejected_30d: 3 },
          history: [{ period: '2026-09-28', at: '2026-09-30T05:00:00.000Z', ok: true, error: '', attempt: 1 },
            { period: '2026-09-21', at: '2026-09-23T05:00:00.000Z', ok: false, error: 'レジストリに届きませんでした(とても長いエラーの文がここに入っても、画面の幅からはみ出さないことを確かめます)', attempt: 2 }] }
        // 利用の状況(日ごとの回数・多い操作・エラー)
        case 'getUsageStatus': return {
          days: Array.from({ length: 14 }, (_, i) => ({ date: '2026-09-' + String(18 + i).padStart(2, '0'), login: i, open: i * 3, writes: i * 5 })),
          topActions: [{ action: 'updateTaskStatus', count: 120 }, { action: 'updateComments', count: 80 }, { action: 'aVeryLongActionNameThatShouldWrapInsideTheNarrowScreen', count: 3 }],
          errors: { last7Days: 4, byKind: [{ kind: 'conflict', count: 3 }, { kind: 'client:TypeError', count: 1 }],
            recent: [{ at: '2026-09-30T10:00:00.000Z', source: 'gas', action: 'updateComments', kind: 'conflict' }, { at: '2026-09-30T09:00:00.000Z', source: 'client', action: 'window', kind: 'client:TypeError' }] } }
        // 個人情報の削除(7日以内に消す人数・消す前の人)
        case 'getPersonalDataStatus': return { retentionDays: 30, min: 7, max: 365, noticeDays: 7,
          upcoming: [{ date: '2026-10-05', count: 2 }],
          orphanEmails: [{ id: 'm-old-1', email: 'old.member.with.a.long.address@example.com' }, { id: 'old-' + 'x'.repeat(30), email: 'shifted@example.com' }],
          pending: [
            { kind: 'member', id: 'm-left', name: 'とても長い名前の退会したメンバーさん'.repeat(2), since: '2026-09-05T00:00:00.000Z', purgeAt: '2026-10-05T00:00:00.000Z', extended: false },
            { kind: 'candidate', id: 'cand-1', name: '採用しなかった候補者', since: '2026-09-05T00:00:00.000Z', purgeAt: '2026-10-05T00:00:00.000Z', extended: true },
          ] }
        // バックアップ(作れなかった日・一覧・戻す前の件数・タスクの違い)
        case 'getBackupStatus': case 'listBackups': {
          const status = { lastSuccessAt: '2026-09-29T21:00:00.000Z', failed: true, failedAt: '2026-09-30T21:00:00.000Z', error: 'Drive の容量が足りません' }
          if (body.action === 'getBackupStatus') return status
          return { status, keep: { daily: 7, weekly: 4, monthly: 3 }, backups: [
            { id: 'bk2', name: 'Ohsumi バックアップ 2026-09-30 06:00(戻す前)', at: '2026-09-30T09:00:00.000Z', kind: 'beforeRestore' },
            { id: 'bk1', name: 'Ohsumi バックアップ 2026-09-29 06:00', at: '2026-09-28T21:00:00.000Z', kind: 'daily' },
          ] }
        }
        case 'previewRestore': return { backup: { id: 'bk1', name: 'Ohsumi バックアップ 2026-09-29 06:00', at: '2026-09-28T21:00:00.000Z', kind: 'daily' },
          sheets: [{ name: 'Tasks', current: 12, backup: 10 }, { name: 'Members', current: 5, backup: 5 }, { name: 'とても長い名前のシート'.repeat(3), current: 3, backup: null }] }
        case 'searchBackupTasks': return { backup: { id: 'bk1', name: '', at: '2026-09-28T21:00:00.000Z', kind: 'daily' }, tasks: [
          { id: 't1', title: 'とても長いタスク名の例'.repeat(4), currentTitle: 'とても長いタスク名の例', state: 'changed',
            diffs: [{ field: 'description', current: 'とても長い説明'.repeat(20), backup: 'https://example.com/' + 'x'.repeat(80) }, { field: 'comments_json', current: '3件', backup: '2件' }] },
          { id: 't2', title: '消えたタスク', currentTitle: '', state: 'missing', diffs: [] },
          { id: 't3', title: '同じタスク', currentTitle: '同じタスク', state: 'same', diffs: [] },
        ] }
        // 管理画面の上部に、GAS の更新が要る知らせを出す
        case 'getGasUpdateStatus': return { current: 'r1e-2', known: true, required: true, outdated: true, latest: '2026.10.01-1', minimum: '2026.10.01-1', security: true, checkedAt: '2026-10-01T03:00:00.000Z' }
        case 'getMailQuotaStatus': return { remaining: 0, date: '2026-10-01', skipped: 12, reachedAt: '2026-10-01T03:00:00.000Z', lastReachedDate: '2026-10-01' }
        default: return {}
      }
    }
    const b64 = (s) => Buffer.from(s).toString('base64')
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    listeners.push((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      const url = new URL(request.url)
      if (url.origin === base) return send('Fetch.continueRequest', { requestId })
      const fulfill = (type, body) => send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: b64(body),
        responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }] })
      if (url.href.startsWith(GAS_URL) && slowConfigMs && JSON.parse(request.postData || '{}').action === 'getLoginConfig') {
        configCalls++
        return sleep(slowConfigMs).then(() => fulfill('application/json', JSON.stringify({ ok: true, result: { orgId: ORG } })))
      }
      if (url.href.startsWith(GAS_URL)) {
        const body = JSON.parse(request.postData || '{}')
        if (body.action === 'getInitialData') initialDataCalls++
        // 書き込みを断る(ログインが切れた・画面が古い・権限が足りない)
        if (failWrites && !LAYOUT_READ_ACTIONS.includes(body.action)) {
          const failValue = failWrites === 'cellTooLong' ? { sheet: 'Tasks', field: 'comments_json', length: 50120, max: 50000, texts: null }
            : failWrites === 'conflict' ? { sheet: 'Tasks', id: 't1' } : true
          return fulfill('application/json', JSON.stringify({ ok: false, [failWrites]: failValue, error: '断りました(' + failWrites + ')' }))
        }
        return fulfill('application/json', JSON.stringify({ ok: true, result: gas(body), ...(contract ? { contract } : {}) }))
      }
      if (url.href.startsWith(REGISTRY_URL)) {
        const body = JSON.parse(request.postData || '{}')
        // 接続先の解決: テスト用の団体(ORG)だけを答える。ほかは見つからない(招待リンクの団体が見つからない画面)
        if (body.action === 'resolveOrg') {
          return fulfill('application/json', JSON.stringify(body.orgId === ORG
            ? { ok: true, result: { orgId: ORG, gasUrl: GAS_URL, status: 'active', channel: 'standard', checkedAt: new Date().toISOString(), maxAgeSec: 86400 } }
            : { ok: false, notFound: true, error: '団体が見つかりません。' }))
        }
        return fulfill('application/json', JSON.stringify({ ok: true, result: registryResponse(body) }))
      }
      if (url.href.startsWith('https://accounts.google.com/gsi/client')) {
        return fulfill('text/javascript', 'window.google={accounts:{id:{initialize(c){window.__gsiConfig=c},renderButton(e){e.setAttribute(\'data-layout-gsi\',\'1\')},prompt(){},disableAutoSelect(){},cancel(){}},oauth2:{initTokenClient(){return{requestAccessToken(){}}}}}}')
      }
      return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
    })
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: WIDTH < 600 ? 2 : 1, mobile: WIDTH < 600 })

    const navigate = async (path = '/') => { await send('Page.navigate', { url: base + path }); await sleep(3000) }
    // gesture: 人が押した時と同じ扱いにする(機能停止中の知らせは、人が操作した時だけ出る)
    const clickText = (text, from = 'button, a, [role=tab]', gesture = false) => evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(from)})]
      const el = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)}) || els.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))
      if (!el) throw new Error('見つかりません: ' + ${JSON.stringify(text)})
      el.click(); return true })()`, gesture)
    // この端末の団体の一覧(lib/ohsumi/org-directory.ts)。2つ目は名前がとても長い団体
    // withCurrent: 今の団体にする(false なら、招待リンクなしで開いた時に一覧から選ぶ画面になる)
    const saveOrgs = (withSecond, withCurrent = true) => evaluate(`localStorage.setItem('ohsumi-orgs', JSON.stringify([
        { orgId: '${ORG}', gasUrl: '${GAS_URL}', source: 'registry', checkedAt: Date.now(), maxAgeSec: 86400, name: 'サンプル団体' },
        ${withSecond ? `{ orgId: 'org_SECONDSECONDSECOND01', gasUrl: 'https://script.google.com/macros/s/SECOND/exec', source: 'registry', checkedAt: Date.now(), maxAgeSec: 86400,
          name: 'とても長い名前の特定非営利活動法人テスト団体ロングネームの会' },` : ''}
      ]))${withCurrent ? `; localStorage.setItem('ohsumi-current-org', '${ORG}')` : ''}`)
    // expSec: セッションの残りの秒数(ログインの期限が近い時の知らせを確かめる時に短くする)
    const signIn = async (expSec = 86400) => {
      await saveOrgs(false)
      await evaluate(`localStorage.setItem('ohsumi-session-${ORG}', JSON.stringify({ token: 'v1.layout.check', exp: Math.floor(Date.now() / 1000) + ${expSec} }))`)
    }
    // INPUT の書きかけ(ログインが切れても消えないこと)
    const DRAFT_KEY = 'ohsumi-input-draft-' + MEMBER

    await navigate('/')
    const passes = [
      { member: MEMBER, steps: STEPS },
      { member: ADMIN_MEMBER, steps: ADMIN_STEPS },
      { member: ADMIN_MEMBER, steps: REGISTRY_STEPS },
      { member: ADMIN_MEMBER, steps: READ_ONLY_STEPS, contract: READ_ONLY_CONTRACT },
    ]
    const registrySession = () => evaluate(`sessionStorage.setItem('ohsumi-registry-admin-session', JSON.stringify({ token: 'ra1.layout.check', exp: Math.floor(Date.now() / 1000) + 1800, email: 'registry.admin.with.a.long.address@example.com', authAt: Math.floor(Date.now() / 1000) }))`)
    for (const pass of passes) {
    member = pass.member
    view = viewerData(pass.member)
    for (const step of pass.steps) {
      try {
        if (step.do === 'login') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/?org=' + ORG)
          if (!(await evaluate(`localStorage.getItem('ohsumi-current-org') === '${ORG}'`))) throw new Error('招待リンクの団体が、この端末の団体になりません')
          // アドレスバーに団体を残す(ブックマーク・ホーム画面に追加したアイコンに団体が残る)
          if ((await evaluate('location.search')) !== '?org=' + ORG) throw new Error('アドレスバーから ?org= が消えました')
        }
        if (step.do === 'loginNotMember') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/?org=' + ORG)
          notMember = true
          try {
            // Google のボタンで、団体に登録されていないアカウントを選んだことにする(nonce は画面が initialize に渡したもの)
            await evaluate(`(() => {
              const c = window.__gsiConfig
              if (!c) throw new Error('Google のログインが準備されていません')
              const b64 = (o) => btoa(JSON.stringify(o)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
              c.callback({ credential: b64({ alg: 'RS256' }) + '.' + b64({ nonce: c.nonce, email: 'stranger@example.com' }) + '.sig' })
              return true })()`)
            // 失敗した後は、読み込み直したページで知らせる
            await sleep(3500)
            const text = await evaluate('document.body.textContent')
            if (!text.includes('stranger@example.com は「サンプル団体」のメンバーとして登録されていません')) throw new Error('どの団体に・どのアカウントで入ろうとしたかが出ません')
            if (!text.includes('代表に、このアドレスの登録を頼んでください')) throw new Error('どうすればよいかが出ません')
            if (text.includes('このアカウントが団体の代表になります')) throw new Error('初期設定コードの欄が開いています')
          } finally {
            notMember = false
          }
        }
        if (step.do === 'loginNoOrg' || step.do === 'loginNoOrgPick') {
          await evaluate('localStorage.clear(); sessionStorage.clear()')
          if (step.do === 'loginNoOrgPick') await saveOrgs(true, false)
          await navigate('/')
          if (!(await evaluate(`document.body.textContent.includes('団体から届いた招待リンクを開いてください')`))) throw new Error('「団体から届いた招待リンクを開いてください」が表示されません')
          const options = await evaluate(`[...document.querySelectorAll('select option')].map((o) => o.value).filter(Boolean)`)
          const want = step.do === 'loginNoOrgPick' ? [ORG, 'org_SECONDSECONDSECOND01'] : []
          if (JSON.stringify(options) !== JSON.stringify(want)) throw new Error('団体を選ぶ欄が違います: ' + options.join(', '))
        }
        if (step.do === 'loginOrgs') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await saveOrgs(true); await navigate('/')
          const shown = await evaluate(`!!document.querySelector('select option[value="org_SECONDSECONDSECOND01"]')`)
          if (!shown) throw new Error('団体を選ぶ欄が表示されません')
        }
        if (step.do === 'loginMissingOrg') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/?org=' + MISSING_ORG)
          const shown = await evaluate(`document.body.textContent.includes('団体が見つかりません')`)
          if (!shown) throw new Error('「団体が見つかりません」が表示されません')
        }
        if (step.do === 'loginSlowConfig') {
          await evaluate('localStorage.clear(); sessionStorage.clear()'); await saveOrgs(false)
          slowConfigMs = 8000; configCalls = 0
          try {
            await send('Page.navigate', { url: base + '/' })
            // 答え(8秒後)より前に、ログインボタンが出ていること
            const started = Date.now()
            let shown = false
            while (Date.now() - started < 4000 && !shown) {
              await sleep(200)
              shown = await evaluate(`!!document.querySelector('[data-layout-gsi]') && !document.body.textContent.includes('準備中')`).catch(() => false)
            }
            if (!shown) throw new Error('保存した団体なのに、団体ID の確認の答えを待ってからログインボタンが出ます')
            if (configCalls !== 1) throw new Error('団体ID の確認が裏で送られていません(' + configCalls + '回)')
            await sleep(slowConfigMs)
            if (!(await evaluate(`!!document.querySelector('[data-layout-gsi]')`))) throw new Error('確認の答えを受け取った後に、ログインボタンが消えました')
          } finally {
            slowConfigMs = 0
          }
        }
        if (step.do === 'home' || step.do === 'admin') contract = null
        if (step.do.startsWith('readOnly')) {
          contract = pass.contract
          // 経費申請には、カテゴリが1つ要る(サンプルのデータには無いので、設定に足す)
          if (step.do === 'readOnlyExpense' && !view.Settings.rows.some((r) => r[0] === 'expense_categories')) {
            view.Settings.rows.push(['expense_categories', JSON.stringify([{ id: 'travel', label: '交通費', approvalSteps: [] }])])
          }
          if (step.do !== 'readOnlyTask') {
            await signIn(); await navigate('/')
            await clickText('あとで設定する').catch(() => {})
            await sleep(800)
            // 書き出しの数を数える(ファイルは実際には保存しない)
            await evaluate(`(() => { window.__exports = 0; URL.createObjectURL = () => { window.__exports++; return 'blob:layout-check' }; HTMLAnchorElement.prototype.click = function () {}; return true })()`)
            if (!(await evaluate(`document.body.textContent.includes('アンケートへの回答をお願いします')`))) throw new Error('機能停止中の知らせが表示されません')
          }
          // 閲覧のための欄が使えて、値を変えられること
          const usable = (selector) => evaluate(`(() => {
            const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
            if (!els.length) throw new Error('見つかりません: ' + ${JSON.stringify(selector)})
            const off = els.filter((e) => e.disabled)
            if (off.length) throw new Error('使えない欄があります: ' + ${JSON.stringify(selector)})
            return els.length })()`)
          const setValue = (selector, value) => evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)})
            const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true })()`)
          const noNotice = async (what) => {
            if (await evaluate(`!!document.getElementById('read-only-notice-title')`)) throw new Error(what + 'で「読み取り専用のため、保存できません」が出ました')
          }
          const exported = async (label) => {
            const before = await evaluate('window.__exports')
            await clickText(label); await sleep(1500)
            if ((await evaluate('window.__exports')) <= before) throw new Error(label + ' で書き出せません')
            await noNotice(label)
          }
          if (step.do === 'readOnlyWorkspace') {
            await clickText('一覧'); await sleep(800)
            // 期間(年/月/日)・プロジェクトの選択
            await usable('input[type=date]')
            await setValue('input[type=date]', '2026-01-01'); await sleep(300)
            if ((await evaluate(`document.querySelector('input[type=date]').value`)) !== '2026-01-01') throw new Error('期間を入れられません')
            const select = `[...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.text === 'すべてのプロジェクト'))`
            if (await evaluate(`${select}.disabled`)) throw new Error('プロジェクトを選べません')
            await evaluate(`(() => { const s = ${select}; s.value = s.options[s.options.length - 1].value; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
            await sleep(300)
            // 表示項目・表示順(並び替え)
            await clickText('表示項目'); await sleep(300)
            await clickText('担当者', 'div.absolute button').catch(() => clickText('期限', 'div.absolute button')); await sleep(300)
            await noNotice('表示項目')
            await clickText('表示順'); await sleep(300)
            await clickText('優先度', 'div.absolute button'); await sleep(300)
            await noNotice('表示順')
            // 表示の切り替え
            for (const view of ['リスト', 'カレンダー', 'ガント', 'ワークフロー']) { await clickText(view); await sleep(600) }
            await noNotice('表示の切り替え')
          }
          if (step.do === 'readOnlyList') {
            await clickText('一覧'); await sleep(500)
            await clickText('リスト'); await sleep(800)
            await usable('input[placeholder]:not([type])[data-read-only-ok]')
            await exported('Excel出力')
          }
          if (step.do === 'readOnlyTask') {
            await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
            await clickText(step.view); await sleep(800)
            await clickText(step.text, 'td, span, div, button'); await sleep(1200)
            // 書く欄(コメント・説明など)は止まっている
            const open = await evaluate(`[...document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=number], input[type=file]')]
              .filter((e) => !e.closest('[data-read-only-ok]') && !e.disabled).map((e) => e.outerHTML.slice(0, 80))`)
            if (open.length) throw new Error('書く欄が使えます: ' + open.join(' / '))
            if (!(await evaluate(`document.querySelectorAll('textarea[disabled], input[data-read-only-disabled]').length`))) throw new Error('止まった書く欄がありません')
            // 編集の操作(優先度を変える)は、画面を変えずに止まり、知らせが出る(人が操作した時)
            const priority = `[...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'high') && [...s.options].some((o) => o.value === 'low'))`
            const before = await evaluate(`${priority}.value`)
            await evaluate(`(() => { const s = ${priority}; s.value = s.value === 'low' ? 'high' : 'low'; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`, true)
            await sleep(500)
            if (!(await evaluate(`!!document.getElementById('read-only-notice-title')`))) throw new Error('編集の操作で「読み取り専用のため、保存できません」が出ません')
            if ((await evaluate(`${priority}.value`)) !== before) throw new Error('編集の操作で画面が変わりました')
            await clickText('閉じる', '[role=dialog] button'); await sleep(300)
          }
          // 止まった書く欄にも、画面の状態として文章を入れる(止まる前に書いていた時と同じ)
          const forceText = (finder, value) => evaluate(`(() => {
            const el = ${finder}
            if (!el) throw new Error('書く欄が見つかりません')
            if (!el.disabled) throw new Error('書く欄が使えます(止まっていません)')
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true })()`)
          // 保存の手前で止まったか: 知らせが出て、書いた文章を残し、GAS に書き込みを送らず、「保存しました」を出さない
          const expectBlocked = async (what, text) => {
            await sleep(1200)
            if (!(await evaluate(`!!document.getElementById('read-only-notice-title')`))) throw new Error(what + 'で「読み取り専用のため、保存できません」が出ません')
            if (text && !(await evaluate(`[...document.getElementById('read-only-notice-title').closest('[role=dialog]').querySelectorAll('textarea')].some((t) => t.value.includes(${JSON.stringify(text)}))`))) {
              throw new Error(what + 'で、書いた文章が知らせに残っていません')
            }
            if (sentWrites.length) throw new Error(what + 'で、GAS に書き込みを送りました: ' + sentWrites.join(', '))
            const toasts = await evaluate(`[...document.querySelectorAll('.fixed.bottom-6 > div')].map((d) => d.textContent)`)
            if (toasts.length) throw new Error(what + 'で、保存したかのような知らせが出ました: ' + toasts.join(' / '))
            await evaluate(`(() => { const d = document.getElementById('read-only-notice-title').closest('[role=dialog]'); [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '閉じる').click(); return true })()`)
            await sleep(300)
          }
          sentWrites = []
          if (step.do === 'readOnlyAddTask') {
            await clickText('INPUT'); await sleep(1000)
            if (!(await evaluate(`[...document.querySelectorAll('main textarea')].every((t) => t.disabled)`))) throw new Error('タスクを書く欄が使えます')
            await clickText('イベント準備の4タスクを入力'); await sleep(300)
            await clickText('タスクを整理する'); await sleep(2500)
            await clickText('選択したタスクを登録', 'button', true)
            await expectBlocked('タスクの追加', '')
          }
          if (step.do === 'readOnlyComment') {
            await clickText('一覧'); await sleep(500)
            await clickText(step.view); await sleep(800)
            await clickText(step.text, 'td, span, div, button'); await sleep(1200)
            const comment = 'コメントの本文です。保存できなくても消えないこと'
            await forceText(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '送信').parentElement.querySelector('textarea')`, comment)
            await sleep(300)
            await clickText('送信', 'button', true)
            await expectBlocked('コメント', comment)
          }
          if (step.do === 'readOnlyExpense') {
            await clickText('経費申請'); await sleep(1000)
            const modal = `[...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes('申請する'))`
            await evaluate(`(() => { const s = ${modal}.querySelector('select'); if (!s || !s.options.length) throw new Error('経費のカテゴリがありません'); s.value = s.options[0].value; s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
            await forceText(`${modal}.querySelector('input[type=number], input[inputmode=numeric]') || [...${modal}.querySelectorAll('input')].find((i) => i.placeholder && i.placeholder.includes('3500'))`, '3500')
            const why = '会場の下見の交通費です(領収書がありません)'
            await forceText(`${modal}.querySelector('textarea')`, why)
            await sleep(300)
            await evaluate(`(() => { [...${modal}.querySelectorAll('button')].find((b) => b.textContent.trim() === '申請する').click(); return true })()`, true)
            await expectBlocked('経費申請', why)
          }
          if (step.do === 'readOnlyApprove') {
            await clickText('ADMIN'); await sleep(1500)
            await clickText('Approvals', 'aside nav button'); await sleep(1000)
            await clickText('承認する', 'button', true)
            await expectBlocked('承認', '')
          }
          if (step.do === 'readOnlyAdmin') {
            await clickText('ADMIN'); await sleep(1500)
            await exported('全データをExcel出力')
            await clickText('Members', 'aside nav button'); await sleep(1000)
            await usable('input[data-read-only-ok]')
            await clickText('日報・週報', 'aside nav button'); await sleep(1000)
            await usable('input[type=date][data-read-only-ok]')
            await clickText('人材DB', 'aside nav button'); await sleep(1000)
            await usable('th input[data-read-only-ok]')
          }
        }
        if (step.do === 'contract') {
          const c = step.contract
          contract = c.days ? { phase: c.phase, kind: c.kind, suspendAt: new Date(Date.now() + c.days * 24 * 3600 * 1000).toISOString() } : c
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          const shown = await evaluate(`document.body.textContent.includes(${JSON.stringify(step.expect)})`)
          if (!shown) throw new Error('停止の知らせが表示されません')
        }
        if (step.do === 'home') {
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          // ?org= の無い URL で開いても、アドレスバーを今の団体の /?org=<団体ID> にする(ホーム画面に追加しても団体が残る)
          if ((await evaluate('location.search')) !== '?org=' + ORG) throw new Error('アドレスバーが /?org=<団体ID> になりません')
        }
        if (step.do === 'admin') {
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          await clickText('ADMIN'); await sleep(1500)
          // メールの1日の上限の知らせ(代表の管理画面の上部。getMailQuotaStatus の偽の答えは「12件が送れていません」)
          const quota = await evaluate(`document.querySelector('[data-mail-quota-banner]')?.textContent ?? ''`)
          if (!quota.includes('今日はメールの上限に達しました。12件が送れていません')) throw new Error('管理画面に、メールの上限の知らせが出ません: ' + quota)
          const backupBanner = await evaluate(`document.querySelector('[data-backup-banner]')?.textContent ?? ''`)
          if (!backupBanner.includes('のバックアップを作れませんでした(Drive の容量が足りません)')) throw new Error('管理画面に、バックアップを作れなかった知らせが出ません: ' + backupBanner)
          const ops = await evaluate(`(document.querySelector('[data-ops-jobs]')?.textContent ?? '') + '|' + (document.querySelector('[data-ops-sharing]')?.textContent ?? '')`)
          for (const want of ['毎日の処理が 26 時間以上成功していません', 'setupOhsumi を実行', 'スプレッドシート・フォルダの共有を直してください(3 件)', '「制限付き」', 'former.leader.with.a.long.address@example.com を外して', '直したので確かめ直す']) {
            if (!ops.includes(want)) throw new Error('管理画面に「' + want + '」が出ません: ' + ops)
          }
          const long = await evaluate(`document.querySelector('[data-ops-long-records]')?.textContent ?? ''`)
          for (const want of ['長くなっている記録があります(3 件)', '1on1 の記録: 2 件', 'コメント: 1 件', '47,210 文字', 'm2(41,000 文字)']) {
            if (!long.includes(want)) throw new Error('管理画面に「' + want + '」が出ません: ' + long)
          }
          // FSIF からのお知らせ: 緊急・重要・通常の順に出る
          const order = await evaluate(`[...document.querySelectorAll('[data-announcements] [data-announcement]')].map((e) => e.getAttribute('data-announcement')).join(',')`)
          if (order !== 'urgent,important,normal') throw new Error('お知らせが緊急・重要・通常の順に出ません: ' + order)
          if (!(await evaluate(`document.querySelector('[data-announcements]').textContent`)).includes('FSIF からのお知らせ')) throw new Error('お知らせの見出しが出ません')
          const surveys = await evaluate(`(document.querySelector('[data-ops-surveys]')?.textContent ?? '') + '|' + [...document.querySelectorAll('[data-ops-surveys] a')].map((a) => a.getAttribute('href')).join(',')`)
          for (const want of ['FSIF からのアンケートへの回答をお願いします(1 件)', '回答期限(2026/09/24)を過ぎています', 'から読み取り専用になります', '回答する', 'https://docs.google.com/forms/d/e/']) {
            if (!surveys.includes(want)) throw new Error('管理画面に「' + want + '」が出ません: ' + surveys)
          }
          if (surveys.includes('javascript')) throw new Error('Google フォームでない URL のアンケートを出しています')
          const features = await evaluate(`document.querySelector('[data-ops-features]')?.textContent ?? ''`)
          for (const want of ['一部の機能を一時的に止めています(2 件)', '日報の提出', 'これから足す機能']) {
            if (!features.includes(want)) throw new Error('管理画面に、止めている機能「' + want + '」が出ません: ' + features)
          }
          const privacyBanner = await evaluate(`document.querySelector('[data-personal-data-banner]')?.textContent ?? ''`)
          if (!privacyBanner.includes('2人分の個人情報を')) throw new Error('管理画面に、個人情報を消す7日前の知らせが出ません: ' + privacyBanner)
          if (!privacyBanner.includes('対応するメンバーがいないメールアドレスの行が 2 件あります')) throw new Error('管理画面に、対応するメンバーがいないメールアドレスの行の知らせが出ません: ' + privacyBanner)
          const gasUpdate = await evaluate(`document.querySelector('[data-gas-update-banner]')?.textContent ?? ''`)
          if (!gasUpdate.includes('この団体の GAS の更新が要ります(今の版: r1e-2 → 最新の版: 2026.10.01-1)') || !gasUpdate.includes('安全の修正')) throw new Error('管理画面に、GAS の更新の知らせが出ません: ' + gasUpdate)
        }
        if (step.do === 'registryLogin') { await evaluate('localStorage.clear(); sessionStorage.clear()'); await navigate('/registry-admin/') }
        if (step.do === 'registry') {
          await registrySession(); await navigate('/registry-admin/')
          // メールの上限に達した・近い団体が分かる(一覧の上の数と、団体ごとの印)
          const mail = await evaluate(`(document.querySelector('[data-mail-level-summary]')?.textContent ?? '') + '|' + document.body.textContent`)
          if (!(await evaluate(`document.querySelector('[data-mail-queue]')?.textContent ?? ''`)).includes('1日の上限のため送れていないもの: 23 通')) throw new Error('レジストリのメールで送れていない件数が出ません')
          // 機能のスイッチ: 全団体・団体ごとに止めている機能が出る。全団体の選ぶ欄を開くと、17の機能が並ぶ
          if (!(await evaluate(`document.querySelector('[data-feature-switches]')?.textContent ?? ''`)).includes('止めている機能: Discord・Slack への通知')) throw new Error('全団体で止めている機能が出ません')
          if (!(await evaluate(`document.querySelector('[data-org-demo] [data-org-features]')?.textContent ?? ''`)).includes('止めている機能: 日報の提出・Discord・Slack の設定と接続テスト・Google カレンダーへの登録')) throw new Error('団体で止めている機能が出ません')
          await evaluate(`[...document.querySelectorAll('[data-feature-switches] button')].find((b) => b.textContent.includes('全団体の機能を止める'))?.click()`)
          await sleep(100)
          if ((await evaluate(`document.querySelectorAll('[data-feature-switches] [data-feature-options] input').length`)) !== 17) throw new Error('止められる機能の一覧が出ません')
          // 上限・しきい値: 全団体・団体ごとの既定と違う値が出る。全団体の入力欄を開くと、13の項目が並ぶ
          if (!(await evaluate(`document.querySelector('[data-tunables]')?.textContent ?? ''`)).includes('既定と違う値: 翻訳する文(1人1時間) 1000')) throw new Error('全団体の上限・しきい値が出ません')
          if (!(await evaluate(`document.querySelector('[data-org-demo] [data-org-tunables]')?.textContent ?? ''`)).includes('本人あての招待リンクのメール(1人1時間) 1')) throw new Error('団体の上限・しきい値が出ません')
          await evaluate(`[...document.querySelectorAll('[data-tunables] button')].find((b) => b.textContent.includes('全団体の上限・しきい値を変える'))?.click()`)
          await sleep(100)
          if ((await evaluate(`document.querySelectorAll('[data-tunables] [data-tunable-fields] input').length`)) !== 13) throw new Error('上限・しきい値の入力欄が出ません')
          // デモの団体: 印が出て、停止の予定を入れるボタンが無い。KPI はデモを除く
          const demo = await evaluate(`document.querySelector('[data-org-demo]')?.textContent ?? ''`)
          if (!demo.includes('デモ') || !demo.includes('デモの団体には、停止の予定を入れられません') || demo.includes('停止の予定を入れる…') || !demo.includes('デモの印を外す…')) throw new Error('デモの団体の表示が違います: ' + demo)
          if (!(await evaluate(`document.querySelector('[data-kpis]')?.textContent ?? ''`)).includes('利用中の団体: 3(プラン別: Ohsumiプラン 1・Cosmo Baseプラン 1・有償プラン 0・未設定 1)。デモの団体: 1')) throw new Error('KPI が出ません')
          for (const want of ['メールの上限に達した団体: 1', 'メールの残りが少ない団体: 1', 'メールの残り 8', 'GAS: 更新が要る', 'GAS: 24時間以上確認が無い', 'GAS: 最新', '担当者に更新のお願いを送る…', '毎日の処理が26時間以上成功していない', '毎日・毎時の処理']) {
            if (!mail.includes(want)) throw new Error('レジストリの管理画面に「' + want + '」が出ません')
          }
          // 「更新が要る団体だけ」で絞り込む(24時間以上確認が無くても、最後の版で更新が要る団体は入る)
          const cards = () => evaluate(`document.querySelectorAll('[data-gas-version]').length`)
          const all = await cards()
          await evaluate(`document.querySelector('[data-gas-update-filter] input').click()`)
          await sleep(200)
          const filtered = await cards()
          if (!(await evaluate(`document.querySelector('[data-gas-update-filter]').textContent`)).includes('GAS の更新が要る団体だけ(2)') || filtered !== 2) {
            throw new Error('「GAS の更新が要る団体だけ」で絞り込めません(' + all + ' → ' + filtered + ')')
          }
          await evaluate(`document.querySelector('[data-gas-update-filter] input').click()`)
          // 版の一覧を開いた状態で、はみ出しを確かめる
          await evaluate(`document.querySelector('[data-gas-versions] button').click()`)
          await sleep(200)
          if (!(await evaluate(`document.querySelector('[data-gas-versions]').textContent`)).includes('これより古ければ更新が要る')) throw new Error('版の一覧に印が出ません')
        }
        if (step.do === 'registrySuspend') {
          await clickText('停止の予定を入れる…'); await sleep(500)
          const shown = await evaluate(`!!document.querySelector('input[type=datetime-local]')`)
          if (!shown) throw new Error('停止の予定を入れる欄が表示されません')
        }
        if (step.do === 'registrySuspendNow') {
          // 停止の予定の欄(前の手順で開いたもの)で、提供停止・当日を選び、理由を入れて進むと、確認の画面が出る
          await evaluate(`(() => {
            const form = document.querySelector('input[type=datetime-local]').closest('form')
            form.querySelectorAll('input[type=radio]')[0].click()
            return true })()`)
          await sleep(200)
          await evaluate(`(() => {
            const form = document.querySelector('input[type=datetime-local]').closest('form')
            form.querySelector('input[type=checkbox]').click()
            const reason = [...form.querySelectorAll('label')].find((l) => l.textContent.startsWith('理由')).querySelector('input')
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(reason, 'とても長い理由の例です。'.repeat(6))
            reason.dispatchEvent(new Event('input', { bubbles: true }))
            return true })()`)
          await sleep(300)
          await clickText('当日の提供停止へ進む…'); await sleep(500)
          if (!(await evaluate(`!!document.querySelector('[role=alertdialog]') && document.body.textContent.includes('今すぐ提供停止にする')`))) throw new Error('当日の提供停止の確認の画面が出ません')
        }
        if (step.do === 'registryPlan') {
          await clickText('プランを変える…'); await sleep(500)
          if (!(await evaluate(`[...document.querySelectorAll('select option')].some((o) => o.textContent === '有償プラン')`))) throw new Error('プランを選ぶ欄が出ません')
        }
        if (step.do === 'registrySurveys') {
          const text = await evaluate(`document.body.textContent`)
          for (const want of ['アンケートを送る', 'Ohsumiプラン 24件・Cosmo Baseプラン 12件・有償プラン 4件', '期限を過ぎて回答が無い団体(2)', '28日目に機能停止を入れる', '機能停止の予定:', '送付前']) {
            if (!text.includes(want)) throw new Error('アンケートのタブに「' + want + '」が出ません')
          }
          // 有償プランの団体は、期限を過ぎた一覧に出さない
          if ((await evaluate(`[...document.querySelectorAll('[data-survey-overdue] li')].map((li) => li.textContent).join('|')`)).includes('有償プラン')) throw new Error('有償プランの団体を、期限を過ぎた一覧に出しています')
          // 団体を選ぶ(今年の数と上限を出す)
          await evaluate(`[...document.querySelectorAll('[data-survey-send] input[type=radio]')][2].click()`)
          await sleep(300)
          if (!(await evaluate(`document.querySelector('[data-survey-send]').textContent`)).includes('直近12か月 12 / 12件')) throw new Error('団体を選ぶ欄に、今年の数と上限が出ません')
        }
        if (step.do === 'registryAnnouncements') {
          const text = await evaluate(`document.body.textContent`)
          for (const want of ['お知らせを出す', '重要度', '掲載中', '緊急']) {
            if (!text.includes(want)) throw new Error('お知らせのタブに「' + want + '」が出ません')
          }
          await evaluate(`[...document.querySelectorAll('[data-announcement-form] input[name=announcement-target]')][2].click()`)
          await sleep(300)
        }
        if (step.do === 'registryDiagnostics') {
          await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('D261001-AB2C')).click()`)
          await sleep(600)
          if (!(await evaluate(`document.querySelector('[data-diagnostics-report]')?.textContent ?? ''`)).includes('2026.10.01-13')) throw new Error('受付番号から診断情報の中身が出ません')
        }
        if (step.do === 'registryIssue') {
          // 団体名を入れて発行する(React の入力は、値を直接変えた後に input を送る)
          await evaluate(`(() => {
            const el = [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith('団体名')).querySelector('input')
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'とても長い名前の特定非営利活動法人テスト団体ロングネームの会')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return true })()`)
          await sleep(300); await clickText('発行する'); await sleep(1500)
          const shown = await evaluate(`document.body.textContent.includes('ABCD-EFGH-JKMN-PQRS')`)
          if (!shown) throw new Error('発行した登録コードが表示されません')
        }
        if (step.do === 'unsaved') {
          contract = null
          await signIn()
          await evaluate(`localStorage.setItem('${'${DRAFT_KEY}'}', JSON.stringify({ text: 'INPUT の書きかけです' }))`.replace('${DRAFT_KEY}', DRAFT_KEY))
          await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          await clickText(step.view); await sleep(800)
          await clickText(step.text, 'td, span, div, button'); await sleep(1200)
          const comment = '送れなかったコメントです(' + step.fail + ')'
          await evaluate(`(() => {
            const ta = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '送信').parentElement.querySelector('textarea')
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(comment)})
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            return true })()`)
          await sleep(300)
          const readsBefore = initialDataCalls
          failWrites = step.fail
          try {
            await clickText('送信', 'button', true)
            await sleep(step.fail === 'authError' ? 4000 : 2500)
          } finally {
            failWrites = ''
          }
          if (step.fail === 'forbidden') {
            if (initialDataCalls <= readsBefore) throw new Error('権限が足りないと断られても、データを読み直しません')
          } else {
            const notice = await evaluate(`(() => {
              const d = document.querySelector('[data-unsaved-notice]')
              return d ? { kind: d.getAttribute('data-unsaved-notice'), texts: [...d.querySelectorAll('textarea')].map((t) => t.value), text: d.textContent } : null })()`)
            const wantKind = step.fail === 'authError' ? 'sessionEnded' : step.fail
            if (!notice || notice.kind !== wantKind) throw new Error('保存できなかった知らせが出ません(' + JSON.stringify(notice) + ')')
            if (!notice.texts.some((t) => t.includes(comment))) throw new Error('送れなかったコメントが、知らせに残っていません')
            if (step.fail === 'reloadRequired' && !notice.text.includes('読み込み直す')) throw new Error('「読み込み直す」がありません')
            if (step.fail === 'cellTooLong' && initialDataCalls <= readsBefore) throw new Error('記録が長くなりすぎて断られても、保存されている内容に戻しません')
            if (step.fail === 'conflict' && initialDataCalls <= readsBefore) throw new Error('ほかの人が先に変えていたと断られても、最新の内容を読み直しません')
            if (step.fail === 'authError') {
              if (!(await evaluate(`!!document.querySelector('[data-layout-gsi]')`))) throw new Error('ログイン画面に戻りません')
              if (!(await evaluate(`!!localStorage.getItem('${'${DRAFT_KEY}'}')`.replace('${DRAFT_KEY}', DRAFT_KEY)))) throw new Error('ログインが切れた時に、INPUT の書きかけが消えました')
            }
          }
        }
        if (step.do === 'sessionExpiry') {
          contract = null
          await signIn(5 * 60)
          await evaluate(`localStorage.setItem('${'${DRAFT_KEY}'}', JSON.stringify({ text: 'INPUT の書きかけです' }))`.replace('${DRAFT_KEY}', DRAFT_KEY))
          await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          const banner = await evaluate(`document.querySelector('[data-session-expiry]')?.textContent ?? ''`)
          if (!banner.includes('ログインの期限まで、あと5分です')) throw new Error('ログインの期限が近いことを知らせません: ' + banner)
          await clickText('ログインし直す', '[data-session-expiry] button'); await sleep(3000)
          if (!(await evaluate(`!!document.querySelector('[data-layout-gsi]')`))) throw new Error('「ログインし直す」でログイン画面に戻りません')
          if (!(await evaluate(`!!localStorage.getItem('${'${DRAFT_KEY}'}')`.replace('${DRAFT_KEY}', DRAFT_KEY)))) throw new Error('ログインし直す時に、INPUT の書きかけが消えました')
        }
        if (step.do === 'otherDevice') {
          inviteMail = step.mail || 'available'
          inviteBodies = []
          contract = step.readOnly ? pass.contract : null
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          if (step.width) await send('Emulation.setDeviceMetricsOverride', { width: step.width, height: 900, deviceScaleFactor: 1, mobile: false })
          await sleep(500)
          // 共有の画面(Web Share API): 使える端末の代わりに記録する関数を置く。使えない端末は無くす
          await evaluate(step.share
            ? `(() => { window.__shared = []; Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared.push(d) } }); return true })()`
            : `(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); return true })()`)
          await evaluate(`(() => { const bs = [...document.querySelectorAll('button[aria-expanded]')].filter((b) => b.querySelector('img, span.rounded-full')); bs[bs.length - 1].click() })()`)
          await sleep(500); await clickText('ほかの端末で開く'); await sleep(1200)
          const want = base + '/?org=' + ORG
          const got = await evaluate(`(() => { const d = document.getElementById('other-device-title').closest('[role=dialog]'); return { link: d.querySelector('input').value, qr: !!d.querySelector('svg[data-other-device-qr] path'), share: [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === '共有'), mailDisabled: d.querySelector('[data-other-device-mail]').disabled, note: d.querySelector('[data-other-device-mail-note]').textContent, home: d.textContent.includes('ホーム画面に追加') } })()`)
          if (got.link !== want) throw new Error('招待リンクが違います: ' + got.link)
          if (!got.qr) throw new Error('QR コードが表示されません')
          if (!got.home) throw new Error('ホーム画面に追加の案内がありません')
          if (got.share !== !!step.share) throw new Error(step.share ? '共有のボタンがありません' : '共有の画面が使えないのに、共有のボタンがあります')
          if (step.share) {
            await clickText('共有', '[role=dialog] button'); await sleep(300)
            const shared = await evaluate('window.__shared')
            if (shared.length !== 1 || shared[0].url !== want) throw new Error('共有の画面に招待リンクが渡りません')
          }
          if (inviteMail === 'available') {
            if (got.mailDisabled) throw new Error('自分のメールに送るボタンが使えません')
            await clickText('自分のメールに送る', '[role=dialog] button', true); await sleep(1200)
            if (inviteBodies.length !== 1) throw new Error('自分のメールに送れません')
            const sent = inviteBodies[0]
            if (sent.siteOrigin !== base || 'to' in sent || 'email' in sent || 'link' in sent) throw new Error('メールの依頼に、宛先・リンクが入っています: ' + Object.keys(sent).join(','))
            if (step.readOnly && (await evaluate(`!!document.getElementById('read-only-notice-title')`))) throw new Error('機能停止中に「読み取り専用のため、保存できません」が出ました')
          } else {
            if (!got.mailDisabled) throw new Error('レジストリに未確認の団体なのに、自分のメールに送るボタンが使えます')
            if (!got.note.includes('まだメールで送れません')) throw new Error('メールで送れない理由が表示されません: ' + got.note)
          }
        }
        if (step.do === 'backup') {
          contract = null
          await signIn(); await navigate('/')
          await clickText('あとで設定する').catch(() => {})
          await sleep(800)
          await evaluate(`(() => { const bs = [...document.querySelectorAll('button[aria-expanded]')].filter((b) => b.querySelector('img, span.rounded-full')); bs[bs.length - 1].click() })()`)
          await sleep(500); await clickText('団体設定'); await sleep(1500)
          const pick = (id) => evaluate(`(() => { const s = document.querySelector('[data-backup-select]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '${id}'); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
          if (!(await evaluate(`!!document.querySelector('[data-backup-panel] [data-backup-select]')`))) throw new Error('団体設定に、バックアップの一覧が出ません')
          await pick('bk1'); await sleep(800)
          if (step.mode === 'full') {
            // 同じ画面の「個人情報の削除」: 保存期間と、消す前の人(すぐ消す・延長・退会を取り消す)
            const privacy = await evaluate(`document.querySelector('[data-personal-data-panel]')?.textContent ?? ''`)
            for (const want of ['保存期間', 'すぐ消す', '30 日延長', '退会を取り消す', '(延長済み)', '対応するメンバーがいないメールアドレスの行が 2 件あります', 'old.member.with.a.long.address@example.com']) {
              if (!privacy.includes(want)) throw new Error('個人情報の削除に「' + want + '」が出ません')
            }
            // 同じ画面の「利用の状況」: 直近7日の回数・多い操作・エラー
            const usage = await evaluate(`document.querySelector('[data-usage-panel]')?.textContent ?? ''`)
            for (const want of ['利用の状況', '直近7日: ログイン 70 回・画面の読み込み 210 回・書き込み 350 回', 'updateTaskStatus', '直近7日のエラー: 4 件', 'conflict 3']) {
              if (!usage.includes(want)) throw new Error('利用の状況に「' + want + '」が出ません: ' + usage)
            }
            // 同じ画面の「FSIF に送る集計値」: プランと選べるか・次に送る内容・履歴
            const metrics = await evaluate(`document.querySelector('[data-metrics-panel]')?.textContent ?? ''`)
            for (const want of ['FSIF に送る集計値', 'Cosmo Baseプラン', '送るかを選べます(初期値は送る)', '今は送っています', 'メンバーの人数', '42', '2026-09-28 の週の分を送りました', '2 回目']) {
              if (!metrics.includes(want)) throw new Error('FSIF に送る集計値に「' + want + '」が出ません: ' + metrics)
            }
            // 同じ画面の「診断情報」: 表示 → 確認して送る → 受付番号
            await evaluate(`document.querySelector('[data-diagnostics-panel] [data-diagnostics-show]').click()`)
            await sleep(600)
            const diag = await evaluate(`document.querySelector('[data-diagnostics-panel]')?.textContent ?? ''`)
            for (const want of ['診断情報', '2026.10.01-13', 'D260930-AB2C', 'FSIF に送る']) {
              if (!diag.includes(want)) throw new Error('診断情報に「' + want + '」が出ません: ' + diag)
            }
            await evaluate(`document.querySelector('[data-diagnostics-panel] [data-diagnostics-send]').click()`)
            await sleep(600)
            if (!(await evaluate(`document.querySelector('[data-diagnostics-receipt]')?.textContent ?? ''`)).includes('D261001-XY7Z')) throw new Error('診断情報を送った後に、受付番号が出ません')
            const text = await evaluate(`document.querySelector('[data-backup-preview]')?.textContent ?? ''`)
            if (!text.includes('Tasks') || !text.includes('12') || !text.includes('10')) throw new Error('戻す前の件数の差が出ません: ' + text)
            if (!(await evaluate(`document.querySelector('[data-backup-restore-all]').disabled`))) throw new Error('確かめる前に「このバックアップに戻す」が押せます')
          } else {
            await clickText('一部のタスクだけ戻す'); await sleep(400)
            await evaluate(`(() => { const i = document.querySelector('[data-backup-tasks] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'タスク'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
            await sleep(200); await clickText('探す'); await sleep(800)
            const text = await evaluate(`document.querySelector('[data-backup-tasks]')?.textContent ?? ''`)
            for (const want of ['復元', '変更あり', '同じ', '今: ']) if (!text.includes(want)) throw new Error('タスクの違いに「' + want + '」が出ません')
          }
        }
        if (step.do === 'click') { await clickText(step.text, step.from); await sleep(1200) }
        if (step.do === 'skillRules') {
          await clickText('Tags', 'aside nav button'); await sleep(1200)
          await clickText('団体の既定を変える', 'button'); await sleep(600)
          const fields = await evaluate(`document.querySelectorAll('[data-skill-level-rules] [data-skill-rule-level] input').length`)
          if (fields < 25) throw new Error('スキルのレベルの決め方の入力欄が出ません: ' + fields)
        }
        if (step.do === 'openTask') {
          await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
          await clickText(step.view); await sleep(800)
          await clickText(step.text, 'td, span, div, button'); await sleep(1200)
        }
        if (step.do === 'profile') {
          await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(400)
          await evaluate(`(() => { const bs = [...document.querySelectorAll('button[aria-expanded]')].filter((b) => b.querySelector('img, span.rounded-full')); bs[bs.length - 1].click() })()`)
          await sleep(500); await clickText('プロフィール'); await sleep(1500)
        }
        const m = JSON.parse(await evaluate(MEASURE))
        const problems = []
        const width = step.width || WIDTH
        if (step.width) await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: WIDTH < 600 ? 2 : 1, mobile: WIDTH < 600 })
        if (m.page > width + 1 || m.window > width + 1) problems.push(`ページの幅が ${Math.max(m.page, m.window)}px(画面は ${width}px)`)
        m.off.forEach((o) => problems.push('はみ出し: ' + o))
        m.squashed.forEach((o) => problems.push('文字が折り返した短いラベル: ' + o))
        if (step.dependencyCards) JSON.parse(await evaluate(MEASURE_CARDS)).forEach((c) => problems.push('中身が切れたカード: ' + c))
        for (const l of m.logos) {
          logoChecks++
          if (Math.abs(l.w - l.h) > 0.5) problems.push(`ロゴの円の縦横比が 1:1 ではありません(${l.w} × ${l.h}px)`)
          if (l.color !== LOGO_BLUE) problems.push(`ロゴのシンボルの色が Ohsumi Blue ではありません(${l.color})`)
          l.effects.forEach((e) => problems.push('ロゴに効果が付いています: ' + e))
        }
        console.log(`${problems.length ? '✗' : '✓'} ${step.name}`)
        problems.forEach((p) => failures.push(`${step.name}: ${p}`))
      } catch (e) {
        console.log(`✗ ${step.name}`)
        failures.push(`${step.name}: 画面を開けませんでした(${e.message})`)
      }
    }
    }
    // ロゴ: どこかの画面で確かめたこと。団体がテーマの色(--primary)を変えても、シンボルの色は変わらないこと
    if (!logoChecks) failures.push('ロゴ: どの画面でも Ohsumi のロゴ(data-ohsumi-symbol)を確かめられませんでした')
    const themed = await evaluate(`(() => {
      document.documentElement.style.setProperty('--primary', '#ff0000')
      const el = document.querySelector('[data-ohsumi-symbol]')
      const color = el ? getComputedStyle(el).color : ''
      document.documentElement.style.removeProperty('--primary')
      return color })()`)
    if (themed && themed !== LOGO_BLUE) failures.push(`ロゴ: 団体のテーマの色でシンボルの色が変わりました(${themed})`)
    console.log(`${logoChecks && (!themed || themed === LOGO_BLUE) ? '✓' : '✗'} ロゴ(${logoChecks} か所で縦横比 1:1・Ohsumi Blue・効果なし。テーマの色で変わらない)`)
    ws.close()
  } finally {
    chrome.kill()
    server.close()
  }
  return failures
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run({ build: !process.argv.includes('--no-build') }).then(
    (failures) => {
      if (failures.length) {
        console.error(`\n画面の幅 ${WIDTH}px で表示が崩れています:\n  ${failures.join('\n  ')}`)
        process.exit(1)
      }
      console.log(`\n画面の幅 ${WIDTH}px で、主な画面に横のはみ出しはありません`)
    },
    (e) => { console.error(e); process.exit(1) },
  )
}
