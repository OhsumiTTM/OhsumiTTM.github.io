// ---- 見本データ(デモの団体・画面写真用) ----------------------------------------------
//
// 学生団体らしい、自然な名前・部署・役職・プロジェクト・タスク。崩れ確認用のサンプル(10-sample-data.gs)とは別に入れる。
// 連番・長すぎる名前・テスト用と分かる文字は使わない。人の名前は架空のもの。
// 規模はメンバー11人・プロジェクト5件・タスク約50件。期限超過・確認待ち・承認待ち・公募・ブロック・保留・完了などを
// ばらけさせ、どの画面にも何か出るようにする。id はすべて 'demo-' で始まり、deleteShowcaseData() でまとめて消せる。

var SHOWCASE_ID_PREFIX = 'demo-'
var SHOWCASE_SETTINGS_STATE_KEY = 'SHOWCASE_SETTINGS_STATE'

// ログインできる枠(TEST_ACCOUNTS / DEMO_ACCOUNTS の名前)と、その枠の見本のメンバー
var SHOWCASE_ACCOUNT_SLOTS = {
  top: 'demo-m-01',        // 代表
  admin: 'demo-m-02',      // 副代表(班長の役職)
  restricted: 'demo-m-03', // 班長
  base: 'demo-m-05',       // 一般
  base_en: 'demo-m-06',    // 一般・英語表示
}

// 見本の役職名(新しい団体の初期の役職と同じ名前)
var SHOWCASE_ROLES = { top: '代表', leader: '班長', base: '一般' }

function showcaseId_(kind, n) { return SHOWCASE_ID_PREFIX + kind + '-' + samplePad_(n, 2) }

function buildShowcaseMembers_(today) {
  var R = SHOWCASE_ROLES
  var d = function (n) { return sampleDay_(today, n) }
  var M = function (n) { return showcaseId_('m', n) }
  var people = [
    { n: 1, name: '森田 葵', role: R.top, dept: '運営', joined: -720, will: '企画,コミュニケーション', judgment: '企画,リサーチ', grade: '3' },
    { n: 2, name: '石井 拓真', role: R.leader, dept: '運営', joined: -700, will: 'イベント運営,企画', judgment: 'イベント運営,コミュニケーション', reportsTo: 1, grade: '3' },
    { n: 3, name: '岡田 美咲', role: R.leader, dept: 'イベント', joined: -400, will: 'イベント運営,コミュニケーション', judgment: 'イベント運営', reportsTo: 2, grade: '2', projects: [1, 2] },
    { n: 4, name: '前田 翔太', role: R.leader, dept: '広報', joined: -380, will: '広報,SNS,デザイン', judgment: '広報,SNS', reportsTo: 2, grade: '2', projects: [3] },
    { n: 5, name: '藤井 ひなた', role: R.base, dept: '広報', joined: -200, will: 'デザイン,SNS', judgment: 'デザイン', reportsTo: 4, grade: '2' },
    { n: 6, name: 'Lena Fischer', display: 'Lena', role: R.base, dept: '渉外', joined: -150, will: 'リサーチ,コミュニケーション', judgment: 'リサーチ', reportsTo: 2, grade: '2', locale: 'en' },
    { n: 7, name: '村上 大地', role: R.base, dept: 'イベント', joined: -180, will: 'イベント運営', judgment: 'イベント運営', reportsTo: 3, grade: '1' },
    { n: 8, name: '近藤 さくら', role: R.base, dept: '渉外', joined: -160, will: 'ライティング,コミュニケーション', judgment: 'ライティング', reportsTo: 2, grade: '1' },
    { n: 9, name: '坂本 悠', role: R.base, dept: '広報', joined: -120, will: 'ライティング,広報', judgment: 'ライティング', reportsTo: 4, grade: '1' },
    { n: 10, name: '遠藤 結菜', role: R.base, dept: 'イベント', joined: -40, will: 'デザイン,イベント運営', judgment: '', reportsTo: 3, grade: '1' },
    { n: 11, name: '青木 蒼', role: R.base, dept: '運営', joined: -20, will: 'リサーチ,企画', judgment: '', grade: '1' },
  ]
  var colors = ['#0ea5e9', '#16a34a', '#d97706', '#db2777', '#6366f1', '#059669', '#8b5cf6', '#dc2626']
  return people.map(function (p) {
    var skills = (p.will + ',' + p.judgment).split(',').filter(Boolean)
    var uniq = skills.filter(function (s, i) { return skills.indexOf(s) === i })
    var points = {}
    uniq.forEach(function (s, i) { points[s] = Math.max(20, Math.round((-p.joined) / 4) - i * 30) })
    return {
      id: M(p.n),
      name: p.name,
      display_name: p.display || '',
      role: p.role,
      notify_new_task: p.role === R.base ? 'FALSE' : 'TRUE',
      avatar_url: '',
      avatar_color: colors[p.n % colors.length],
      avatar_initials: '',
      will_tags: p.will,
      judgment_tags: p.judgment,
      reports_to_id: p.reportsTo ? M(p.reportsTo) : '',
      mentor_id: '',
      joined_at: d(p.joined),
      project_ids: (p.projects || []).map(function (x) { return showcaseId_('p', x) }).join(','),
      department_path: p.dept,
      inactive: '',
      last_login: sampleAt_(today, -(p.n % 4), '20:30'),
      locale: p.locale || 'ja',
      timezone: 'Asia/Tokyo',
      skill_levels_json: sampleJson_(uniq.slice(0, 3).map(function (s, i) {
        return { skill: s, level: Math.max(1, Math.min(4, Math.round(-p.joined / 200) + 1 - i)), acquiredAt: d(p.joined + 30) }
      })),
      skill_points_json: sampleJson_(points),
      university: '',
      grade_year: p.grade,
      career_aspiration: p.locale === 'en' ? 'I want to build long-term partnerships with local companies.' : '',
    }
  })
}

function buildShowcaseProjects_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var P = function (n) { return showcaseId_('p', n) }
  var M = function (n) { return showcaseId_('m', n) }
  return [
    { id: P(1), name: '新歓 2027', description: '春の新入生歓迎。説明会と体験イベントで、新しいメンバーを迎える。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(5), M(7), M(10)].join(','), goal: '説明会の参加者80人・入会30人', start_date: d(-10), end_date: d(150), archived: 'FALSE' },
    { id: P(2), name: '学園祭の模擬店', description: '学園祭での模擬店の出店。メニュー・仕入れ・当日のシフトを決める。', type: 'イベント', owner_id: M(2),
      member_ids: [M(2), M(3), M(7), M(10), M(11)].join(','), goal: '売上の目標を達成し、収益を活動費にあてる', start_date: d(-30), end_date: d(25), archived: 'FALSE' },
    { id: P(3), name: '広報(SNS・Webサイト)', description: '団体の SNS と Web サイトの更新。活動の様子を定期的に発信する。', type: '広報', owner_id: M(4),
      member_ids: [M(4), M(5), M(9)].join(','), goal: '週2回の投稿を続ける', start_date: d(-200), archived: 'FALSE' },
    { id: P(4), name: '協賛企業との連携', description: '地域の企業に協賛をお願いし、イベントの運営費と景品を集める。', type: '渉外', owner_id: M(2),
      member_ids: [M(2), M(6), M(8)].join(','), goal: '協賛企業5社', start_date: d(-45), end_date: d(30), archived: 'FALSE' },
    { id: P(5), name: '団体運営', description: '定例会・会計・名簿の管理など、日々の運営。', type: '運営', owner_id: M(1),
      member_ids: [M(1), M(2), M(11)].join(','), goal: '1人に負担が偏らない運営', start_date: d(-700), archived: 'FALSE' },
  ]
}

function buildShowcaseTasks_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var at = function (n, t) { return sampleAt_(today, n, t) }
  var P = function (n) { return showcaseId_('p', n) }
  var M = function (n) { return showcaseId_('m', n) }
  var tasks = []
  var seq = 0
  // t(プロジェクト, タスク名, 状態, 担当者の番号(0 は担当なし), 期限(今日からの日数), そのほかの列)
  var t = function (p, title, status, who, due, extra) {
    seq++
    var done = status === '完了'
    var row = {
      id: SHOWCASE_ID_PREFIX + 't-' + samplePad_(seq, 3),
      project_id: P(p), title: title, description: '', status: status, assign_type: who ? 'manager_assign' : 'open_bid',
      assignee_id: who ? (Array.isArray(who) ? who.map(M).join(',') : M(who)) : '',
      creator_id: M(p === 5 ? 1 : p === 3 ? 4 : p === 1 ? 3 : 2), created_at: d(due - 14), start_date: d(due - 10), due_date: d(due), due_time: '',
      completed_date: done ? d(Math.min(-1, due)) : '', visibility: '全員', department: ['', 'イベント', 'イベント', '広報', '渉外', '運営'][p],
      category: ['', 'イベント', 'イベント', '広報', '企画', '企画'][p], skills: '', difficulty: '新人歓迎', priority: '中',
      last_activity: d(done ? Math.min(-1, due) : -1), original_input_id: '', approval_status: '承認済み', estimated_hours: '2', importance: '一般',
      progress_percent: done ? '100' : status === '進行中' ? '40' : status === '確認待ち' ? '100' : '0',
    }
    Object.keys(extra || {}).forEach(function (k) { row[k] = extra[k] })
    tasks.push(row)
    return row.id
  }

  // -- 新歓 2027 --
  var venue = t(1, '説明会の教室を予約する', '完了', 3, -6, { skills: 'イベント運営', estimated_hours: '1', actual_hours: '1',
    retrospective_json: sampleJson_({ good: '早めに大きい教室を押さえられた', bad: '', improve: '次は学期の初めに予約する' }) })
  t(1, '新歓ポスターのデザイン', '確認待ち', 5, 2, { skills: 'デザイン', category: 'デザイン', difficulty: '少し経験必要', reviewer_ids: M(4), reviewer_id: M(4), required_approvals: '1',
    deliverables_json: sampleJson_([{ id: 'dl1', label: 'ポスター案(第2版)', url: 'https://example.com/poster-v2' }]),
    history_json: sampleJson_(sampleHistory_(today, M(5), [[-5, 'status', '未着手', '進行中'], [-1, 'status', '進行中', '確認待ち']])) })
  t(1, '説明会のスライドを作る', '進行中', 3, 9, { skills: '企画,ライティング', depends_on_ids: venue, progress_note: '活動紹介のページまでできた' })
  t(1, '体験イベントの企画', '未着手', [7, 10], 20, { skills: 'イベント運営,企画', difficulty: '少し経験必要' })
  t(1, '新歓用の SNS 投稿の予定を立てる', '未着手', 9, 12, { skills: '広報,SNS', department: '広報', category: '広報' })
  t(1, '説明会の当日の受付係', '未着手', 0, 30, { difficulty: '誰でも可', open_bid_applicant_ids: [M(10), M(11)].join(','), description: '説明会の当日、受付で名簿のチェックをします。1時間ほどです。' })
  t(1, 'ビラ配りのシフト表', '未着手', 7, 25, { skills: 'コミュニケーション' })
  t(1, '新入生向けの Q&A をまとめる', '進行中', 10, 15, { skills: 'ライティング', category: '広報' })

  // -- 学園祭の模擬店 --
  var menu = t(2, 'メニューと価格を決める', '完了', [2, 3], -12, { skills: '企画', priority: '高' })
  var supplier = t(2, '仕入れ先の見積もりを比べる', '進行中', 11, -2, { skills: 'リサーチ', priority: '高', depends_on_ids: menu,
    description: '3つのお店から見積もりをもらい、価格と配達の条件を比べる。', progress_note: '2店から返事あり。1店の返事待ち' })
  t(2, '食材の発注', '未着手', 2, 10, { skills: '企画', depends_on_ids: supplier, priority: '高' })
  t(2, '保健所への出店の届け出', 'サポート必要', 7, 3, { priority: '高', skills: 'ライティング',
    blocker_note: '届け出の書き方が分からない。去年の控えがあれば見たい', blocker_since: d(-2) })
  t(2, '当日のシフト表を作る', '進行中', 3, 8, { skills: 'イベント運営,コミュニケーション' })
  t(2, '看板とメニュー表のデザイン', '修正中', 10, 6, { skills: 'デザイン', category: 'デザイン', reviewer_ids: M(3), reviewer_id: M(3), required_approvals: '1',
    history_json: sampleJson_(sampleHistory_(today, M(3), [[-4, 'status', '進行中', '確認待ち'], [-2, 'status', '確認待ち', '修正中']])),
    comments_json: sampleJson_([{ id: 'c1', byId: M(3), at: at(-2, '21:10'), text: '文字をもう少し大きくすると、遠くからでも読めると思います!' },
      { id: 'c2', byId: M(10), at: at(-2, '22:00'), text: 'ありがとうございます。直してもう一度出します。', replyToId: 'c1' }]) })
  t(2, '調理器具の貸し出し申請', '保留', 2, 14, { hold_reason_note: '学校の貸し出し表が出るまで待つ', hold_reason_since: d(-5) })
  t(2, '売上の記録用シートを用意する', '未着手', 11, 18, { skills: 'リサーチ' })
  t(2, '模擬店の衛生チェックリスト', '完了', 7, -4, { skills: 'イベント運営' })
  t(2, '前日の買い出し', '未着手', 0, 24, { difficulty: '誰でも可', open_bid_applicant_ids: M(7), description: '前日の夕方、2人で買い出しに行きます。' })
  t(2, '模擬店の備品の購入', '未着手', 3, 9, { approval_status: '承認待ち', creator_id: M(3), description: '紙皿・割り箸・ゴミ袋など。見積もりは1万円ほど。' })

  // -- 広報(SNS・Webサイト) --
  t(3, '学園祭の告知投稿', '進行中', 5, 4, { skills: 'SNS,デザイン', category: '広報' })
  t(3, 'Web サイトの活動報告を更新', '未着手', 9, -3, { skills: 'ライティング', description: '先月の活動の写真と文章を載せる。' })
  t(3, '活動紹介の動画の台本', '確認待ち', 9, 1, { skills: 'ライティング,広報', reviewer_ids: M(4), reviewer_id: M(4), required_approvals: '1' })
  t(3, 'Instagram の投稿のテンプレート', '完了', 5, -15, { skills: 'デザイン,SNS', category: 'デザイン',
    retrospective_json: sampleJson_({ good: '色と文字の決まりができて、投稿が速くなった', bad: '', improve: '' }) })
  t(3, '先月の投稿の振り返り', '完了', 4, -8, { skills: '広報,リサーチ' })
  t(3, '学園祭のプレスリリースを出す', '未着手', 4, 11, { approval_status: '承認待ち', importance: '対外公開', creator_id: M(4), skills: '広報,ライティング' })
  t(3, 'イベントの写真の整理', '未着手', 0, 16, { difficulty: '誰でも可', description: 'イベントの写真を、使ってよいものとそうでないものに分けます。' })
  t(3, '週2回の投稿', '進行中', [5, 9], 6, { skills: 'SNS', difficulty: '誰でも可' })

  // -- 協賛企業との連携 --
  var list = t(4, '協賛をお願いする企業のリスト', '完了', 8, -20, { skills: 'リサーチ' })
  t(4, '協賛のお願いの文書', '完了', 8, -14, { skills: 'ライティング', depends_on_ids: list })
  t(4, 'Reach out to five local companies', '進行中', 6, 5, { skills: 'コミュニケーション', depends_on_ids: list,
    description: 'Send the sponsorship letter, then follow up by phone a week later. Record each reply in the comments.',
    comments_json: sampleJson_([{ id: 'e1', byId: M(6), at: at(-1, '19:00'), text: 'Two companies replied. One wants to talk next week.' }]) })
  t(4, '協賛企業へのお礼状', '未着手', 8, 28, { skills: 'ライティング' })
  t(4, '協賛の金額のまとめ', '進行中', [1, 2], 7, { visibility: '幹部', priority: '高', description: '協賛の金額と条件。幹部だけが見られる。' })
  t(4, '景品の受け取りの日程調整', '進行中', 6, 9, {
    schedule_json: sampleJson_({
      candidates: [{ id: 'c1', label: d(10) + ' 16:00', date: d(10), startTime: '16:00', endTime: '17:00' }, { id: 'c2', label: d(11) + ' 13:00', date: d(11), startTime: '13:00', endTime: '14:00' }],
      invitedIds: [M(2), M(6), M(8)],
      responses: (function () { var r = {}; r[M(6)] = { c1: '○', c2: '△' }; r[M(8)] = { c1: '×', c2: '○' }; return r })(),
    }) })
  t(4, 'スポンサー企業の打ち合わせ資料', '未着手', 2, -1, { skills: '企画', priority: '高' })

  // -- 団体運営 --
  for (var w = 3; w >= 0; w--) {
    t(5, '定例会の議事録', w === 0 ? '未着手' : '完了', 11, -7 * w + 2, { skills: 'ライティング', difficulty: '誰でも可', creator_id: '', created_at: d(-7 * w) })
  }
  t(5, '前期の会計報告', '確認待ち', 2, -1, { skills: '企画', priority: '高' })
  t(5, '名簿の更新', '進行中', 1, -5, { description: '退会した人と新しく入った人を反映する。' })
  t(5, '来年度の役割分担の案', '未着手', 1, 40, { visibility: '幹部', skills: '企画' })
  t(5, '部室の掃除当番表', '完了', 11, -10, { difficulty: '誰でも可' })
  t(5, '新しいメンバーへの使い方の案内', '未着手', 2, 7, { skills: 'コミュニケーション' })
  t(5, '活動費の申請', '進行中', 1, 12, { skills: '企画' })
  return tasks
}

function buildShowcaseOtherSheets_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var at = function (n, t) { return sampleAt_(today, n, t) }
  var M = function (n) { return showcaseId_('m', n) }
  var S = SHOWCASE_ID_PREFIX
  var steps = [{ id: 's1', type: 'role', role: SHOWCASE_ROLES.leader }, { id: 's2', type: 'member', memberId: M(1) }]
  var expense = function (n, o) {
    return {
      id: S + 'exp-' + samplePad_(n, 2), applicant_id: o.by, amount: String(o.amount), category_id: S + 'expcat-event', receipt_url: '',
      justification: '', purpose: o.purpose, custom_field_answers_json: sampleJson_({}), approval_steps_json: sampleJson_(steps),
      approvals_json: sampleJson_(o.approvals || []), current_step_index: String(o.step || 0), status: o.status, created_at: at(o.day, '12:00'), rejection_reason: '',
    }
  }
  var Expenses = [
    expense(1, { by: M(3), amount: 2480, purpose: '新歓ポスターの印刷代', status: 'pending', day: -1 }),
    expense(2, { by: M(7), amount: 1320, purpose: '模擬店の試作の材料', status: 'approved', step: 2, day: -9,
      approvals: [{ stepId: 's1', memberId: M(2), at: at(-8, '18:00'), action: 'approved' }, { stepId: 's2', memberId: M(1), at: at(-7, '12:00'), action: 'approved' }] }),
  ]
  var DailyReports = []
  ;[[5, 'ポスターの修正をした。', '色の確認をもらう'], [7, '衛生チェックリストを仕上げた。', '届け出の書き方を調べる'], [9, '活動報告の下書きを書いた。', '写真を選ぶ']].forEach(function (r) {
    for (var day = -4; day <= 0; day++) {
      if ((day + r[0]) % 2 === 0) continue
      DailyReports.push({ id: S + 'dr-' + samplePad_(r[0], 2) + '-' + samplePad_(-day, 2), member_id: M(r[0]), type: 'daily', report_date: d(day),
        done_text: r[1], todo_text: r[2], issues_text: '', created_at: at(day, '22:00') })
    }
  })
  return { Expenses: Expenses, DailyReports: DailyReports }
}

function buildShowcaseSettings_() {
  return {
    lists: {},
    items: {
      expense_categories: [{ id: SHOWCASE_ID_PREFIX + 'expcat-event', label: 'イベントの費用',
        approvalSteps: [{ id: 's1', type: 'role', role: SHOWCASE_ROLES.leader }, { id: 's2', type: 'member', memberId: showcaseId_('m', 1) }] }],
    },
    values: {
      department_tree_config: [{ path: '運営' }, { path: 'イベント' }, { path: '広報' }, { path: '渉外' }],
    },
    maps: {},
    scalars: {},
  }
}

// 見本データ一式を作る(Google のサービスを使わない純粋な関数)。today は 'YYYY-MM-DD'
function buildShowcaseData_(today) {
  var other = buildShowcaseOtherSheets_(today)
  return {
    sheets: {
      Members: buildShowcaseMembers_(today),
      Projects: buildShowcaseProjects_(today),
      Tasks: buildShowcaseTasks_(today),
      Expenses: other.Expenses,
      DailyReports: other.DailyReports,
    },
    settings: buildShowcaseSettings_(),
  }
}
