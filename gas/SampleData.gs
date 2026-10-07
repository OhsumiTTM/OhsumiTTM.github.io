// Ohsumi — 見本データ(SampleData.gs)。サンプル(テスト環境)とデモの団体だけが、Code.gs に加えて足すファイル
//
// ■ 団体に配る Code.gs(テンプレート・サイトの /gas/Code.gs)には、サンプル・見本のデータを作るコードを入れない。
//   このファイルも、テンプレートには足さない。サイトの /gas/ にも出さない(リポジトリの gas/SampleData.gs から貼る)。
// ■ このファイルは、リポジトリの gas/sample/*.gs をファイル名の順につなげて作る(pnpm gas:build)。直すのは gas/sample の方。
// ■ 足し方: Apps Script エディタの「ファイル」の ＋ →「スクリプト」で SampleData という名前のファイルを作り、
//   gas/SampleData.gs の中身をそのまま貼って保存する。Code.gs の関数(appendRowByHeaders_・SHEET_HEADERS など)を使う。
// ■ Code.gs を貼り替えた時は、SampleData.gs も同じ時のものに貼り替える。組になる Code.gs の版(SAMPLE_DATA_FOR_GAS_VERSION)と
//   今の Code.gs の版(OHSUMI_GAS_VERSION)が違うと、どの関数も実行の最初に止まる。
//
// ■ エディタから実行する関数
//   seedSampleData      (TEST_ENVIRONMENT が true の時だけ)画面の崩れを確かめるためのデータを入れる(id は 'sample-')
//   deleteSampleData    (同上)崩れ確認用のデータを消す
//   seedShowcaseData    (TEST_ENVIRONMENT か DEMO_ORG が true の時だけ)見本データを入れる(id は 'demo-')。
//                       学生団体らしい自然な名前・部署・プロジェクト・タスク。画面写真・デモに使う
//   deleteShowcaseData  (同上)見本データを消す
//   どれも、決まった印('sample-' / 'demo-')で始まる id の行だけを消す。本物のデータは消さない。
//   何度実行しても重複しない(前の分を消してから作り直す)。日付は実行した日を基準にする。
// ■ ログインできるメンバー: スクリプトプロパティ TEST_ACCOUNTS(デモの団体は DEMO_ACCOUNTS でもよい)に、枠ごとの
//   Google アカウントを書く。例: top=a@gmail.com, admin=b@gmail.com, restricted=c@gmail.com, base=d@gmail.com, base_en=e@gmail.com

var OHSUMI_SAMPLE_DATA_VERSION = '2026.10.07-4'
// 組になる Code.gs の版。pnpm gas:build が、Code.gs の版に合わせて書き換える(手で直さない)
var SAMPLE_DATA_FOR_GAS_VERSION = '2026.10.07-6'

// Code.gs と組の版でなければ止める(Code.gs の関数の名前・引数が変わっていると、データを壊すことがあるため)
function assertSampleDataMatchesCode_() {
  var code = typeof OHSUMI_GAS_VERSION === 'undefined' ? '(見つかりません)' : OHSUMI_GAS_VERSION
  if (code !== SAMPLE_DATA_FOR_GAS_VERSION) {
    throw new Error('SampleData.gs(版 ' + OHSUMI_SAMPLE_DATA_VERSION + ')は Code.gs の版 ' + SAMPLE_DATA_FOR_GAS_VERSION +
      ' と組で使うものです。今の Code.gs の版は ' + code + ' です。SampleData.gs も貼り替えてください(リポジトリの gas/SampleData.gs)。')
  }
}
// ---- 画面確認用のサンプルのデータ(テスト環境専用) --------------------------------
//
// すべての機能が実際に使われている状態を再現し、画面が実際のデータでどう表示されるかを
// 確かめるためのデータ。規模は
// メンバー約20人・プロジェクト約8件・タスク約150件。
//   - TEST_ENVIRONMENT が true の時だけ動く
//   - 何度実行しても重複しない(既存のサンプルを消してから作り直す)
//   - 日付はすべて実行した日を基準にする(いつ実行しても、期限切れ・今週締切・来月開始・
//     完了から日が経ってアーカイブされたもの などが再現される)
//   - id はすべて 'sample-' で始まり、deleteSampleData() でまとめて消せる
//   - Settings は既存の設定を上書きせずに追加し、deleteSampleData() で元に戻す
//
// 使い方(Apps Script エディタで実行。SampleData.gs を足した団体だけ):
//   1. スクリプトプロパティ TEST_ENVIRONMENT を true にする
//   2. (任意)スクリプトプロパティ TEST_ACCOUNTS に、テスト用の Google アカウントを枠ごとに書く
//        例: top=a@gmail.com, admin=b@gmail.com, restricted=c@gmail.com, base=d@gmail.com, base_en=e@gmail.com
//   3. seedSampleData() を実行する
//   4. 確認が終わったら deleteSampleData() を実行する

var SAMPLE_ID_PREFIX = 'sample-'

// ダミー画像(小さな PNG。アップロード用フォルダに非公開で保存する)
var SAMPLE_IMAGES = {
  avatar1: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUXo1sX8reO6NiaLzA+4NBXBWzNC2/Rj6NAAAAAAAAAAAAAAArkd3jQHQU6UBeldRgHoqB1B/hQD6GgALgP4FAAAAAKsDeMiYhZhGZ9kHZtjIZtiJ+VYBAAAAAAAAGObWWWhkURpAdiUAZF0oQD4FAeSZO0D+OQIUFYDU23cZlgEoIwAAAACoDzgBVUlksz1wI6MAAAAASUVORK5CYII=',
  avatar2: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUbqxRIu1mOfemCg6P+DeUABnxQzt2PahTwMAAAAAAAAAAAAA4Hp01xgAPVUaoHcVBaincgD1VwigrwGwAOhfAAAAALA6gIeMWYhpdJZ9YIaNbIadmG8VAAAAAAAAgGFunYVGFqUBZFcCQNaFAuRTEECeuQPknyNAUQFIvX2XYRmAMgIAAACA+oATz4ZJzMMhujMAAAAASUVORK5CYII=',
  avatar3: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUTYWa0O2+9wbE0XnB9wbCuCsmKFtxz70aQAAAAAAAAAAAAAAXI/uGgOgp0oD9K6iAPVUDqD+CgH0NQAWAP0LAAAAAFYH8JAxCzGNzrIPzLCRzbAT860CAAAAAAAAMMyts9DIojSA7EoAyLpQgHwKAsgzd4D8cwQoKgCpt+8yLANQRgAAAABQH3AC6Dey8NVVlbYAAAAASUVORK5CYII=',
  avatar4: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAmElEQVR42u3Yyw2AIBBFUVa2bK1W89wbE0XnB9wbCuCsmKEd+zb0aQAAAAAAAAAAAAAAXI/uGgOgp0oD9K6iAPVUDqD+CgH0NQAWAP0LAAAAAFYH8JAxCzGNzrIPzLCRzbAT860CAAAAAAAAMMyts9DIojSA7EoAyLpQgHwKAsgzd4D8cwQoKgCpt+8yLANQRgAAAABQH3ACJUedwPg9QmMAAAAASUVORK5CYII=',
  logo: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACK0lEQVR42u3d0W3DMBCDYe4aoPtngnaEIoisI3l/wefUpy+OL7Es6fXzJoMRQwAAAAQAAAgAABAAACAAAEAAAIAAAAABAAACAAAEAAAIAAAQAAAgAABAAADg//x+/gfAwKAv95Dn0O/BkP/Qd2PowtCbvGwbwLUB6pbQE4My1VltAXAYghqGkwAjBaQzqKbgUAaV1RnHoMryghi+BXB+c0UwNANEHHM/gPmRa8PoO5ewC8CwinUAbrV8dQ2I/hXMxGAvgElF2wHGTwUAhkvb8j3A1kBxH5plBgAMn+WpAE//0HatTMW1blOTAQAYmLFyoVIFNQwjk7eerjQGYHAC3aPFKqJjG5/E+FyxAAzXK/8+wWcmrx3AHQNPgFOvDMBwvfJv1NweJjj7+vJv1Ayf5jj4L+TfqAEw2SR4Ahw0kH+nbPI94KF6Zd4kABBsEHEHTebXqPFfQyMBxg2CbiPL/CNy8I5YPMD9vihxLoUuH9yGiRReAMwmsgBYNa3xo+oUdL2qPAkU9GYBgFOhBaDvVMgD4KGzeYAmhmCA1+4nkNXRTfM9YDVDFcArcM2fNoAshi+PU3Fnd9kCXQq9ytmuUtcJcLBgt4NRQccdvWpp6gYONUv3xu+gkb6Edc8WJqFLubftIRO3mUHzJj4R+0hs2UXJdguPpdtY+Uz1ZR+x4QAAAAAEAAAIAAAQAAAgAABAAACAAAAAAQAAAgAABAAACAAAEAAAIAAAQA7mD0B1Q6FafX4vAAAAAElFTkSuQmCC',
  receipt: 'iVBORw0KGgoAAAANSUhEUgAAAMgAAAEECAIAAADiZ+yyAAACc0lEQVR42u3cwQ2EMAwAwVRCJdRJrTzyoAP4xEmMx5oKotXJQta13m8YrnkChIWwEBYIC2EhLBAWwkJYICx+HdZpZo2wjLCEJSxhCUtYRljCEpawhOU7Fr5jeQWEhbAQFggLYSEsEBbCQlggLISFsEBYCAthgbAQFsICYSEshAXCQlgIC4SFsBAWCAthISwQFsJCWDA5rMvkGWGZZA0JS0N2LCzvICyEhbBAWAgLYYGwEBbCAmEhLIQFwsI9lsl2pyUsDQlLQ3Ys7FheAWEhLIQFwkJYCAuEhbAQFggLYSEsEBYuSE21Oy1haUhYGrJjYcfyCggLYSEsEBbCQlggLISFsEBYCAthgbBwj2Wq3WkJS0PC0pAdCzuWV0BYCAthgbAQFsICYSEshAXCQlgIC4SFeyxT7U5LWBoSlobsWNixvALCQlgIC4SFsBAWCAthISwQFsJCWCAs3GOZandawtKQsEye7u1YWN4RFsLyCggLYSEsEBbCQlggLISFsEBYCAthucdy6ycss3H3wjIhv512LCzvCAtheQWEhbAQFggLYSEsEBbCQlggLISFsNxjmTF3WsIyIbd+wtKQHQvLO8LyCggLYSEsEBbCQlggLISFsEBYCAthgXsss/GdlrA05BfL5PlvZjsWwkJYCMsrICyEhbBAWAgLYYGwEBbCAmEhLITlHsudlrDMxrd+wtKQHQvLO8LyCggLYSEsEBbCQlggLISFsPhw1BthCUtYwhIWwnKPZd5GWGZNQ8IyIQ3ZsfAdC2GBsBAWwgJhISyEBcJCWAgLhIWwEBasDMs5lP/1E5aGhGVSNWTHQlgIC4SFsMjsAVooUljkMTzyAAAAAElFTkSuQmCC',
  survey: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABbUlEQVR42u3cuxHCQAwFQPdKTkxAREwKZdAGndDGowd88sl436iDHY/vI91yen5K63qvrcettl6X2nqfa2sBDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAjwGcXwN4B8BZF8CtgTMigJsCZ1wAtwPO6ABuBJyaAG4BnMoAngyc+gCeBpytAngCcLYN4E2BMyOANwLOvAAuB87sAC4ETo8ALgFOpwAeDJx+ATwMOF0D+J91hxgfHTh7COB/1l1pfFzg7C2AfcGA/YOtoq2i7YPtg51kOclyFu0s2m0SYPfBgHV0ANaTpatSV6W+aH3RJhtMNphNAmy6ELD5YMAm/AF7o8MrO2t1AXsnC7CX7gADBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgx4d8BfqAF1isqXnKAAAAAASUVORK5CYII=',
}

// テスト用のアカウントを割り当てる枠(TEST_ACCOUNTS の名前)と、その枠のサンプルのメンバー
var SAMPLE_ACCOUNT_SLOTS = {
  top: 'sample-m-01',        // 最上位(代表)
  admin: 'sample-m-02',      // 全権管理者(事業責任者)
  restricted: 'sample-m-03', // 制限付きの管理者(サンプル班長)
  base: 'sample-m-05',       // 一般
  base_en: 'sample-m-06',    // 一般・英語表示
}

// サンプルで使う役職名(内部コード化で役職がIDになったら、ここも合わせて変える)
var SAMPLE_ROLES = { top: '代表', admin: '事業責任者', restricted: 'サンプル班長', base: '一般' }

// フロント(lib/ohsumi/store.tsx)の既定の選択肢。Settings の値が空の団体では画面がこの
// 既定値を使うため、サンプルの値を足す時はこの既定値に足す(テストで一致を確かめる)
var SAMPLE_LIST_DEFAULTS = {
  skill_options: ['デザイン', 'Canva', 'PowerPoint', 'ライティング', 'リサーチ', 'SNS', '広報', 'コミュニケーション',
    'イベント運営', 'メール', 'UI/UX', '実装', '企画', '要件定義', 'プロダクト設計', '校閲', 'Claude', 'V0'],
  category_options: ['未分類', 'デザイン', '渉外', 'イベント', '広報', 'ライティング', '企画', 'リサーチ', '開発', '物品調達'],
  skill_field_options: ['デザイン', '営業', 'AI活用'],
  role_levels: ['班長', '事業責任者', '代表'],
  restricted_roles: [],
}

// ---- 日付(実行した日を基準にする。Google のサービスを使わない) ----

function sampleDay_(today, offset) {
  var p = String(today).split('-')
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + offset * 86400000)
  return d.toISOString().slice(0, 10)
}

// その日の日本時間の時刻(ISO 形式)
function sampleAt_(today, offset, hhmm) {
  var t = String(hhmm || '10:00').split(':')
  var utcHour = (Number(t[0]) + 24 - 9) % 24
  var day = Number(t[0]) < 9 ? sampleDay_(today, offset - 1) : sampleDay_(today, offset)
  var hh = utcHour < 10 ? '0' + utcHour : String(utcHour)
  return day + 'T' + hh + ':' + t[1] + ':00.000Z'
}

// 同じ結果を再現できるよう、乱数は種を固定した簡易な生成器を使う
function sampleRandom_(seed) {
  var state = seed >>> 0
  var next = function () {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  return {
    next: next,
    int: function (min, max) { return min + Math.floor(next() * (max - min + 1)) },
    pick: function (list) { return list[Math.floor(next() * list.length)] },
    chance: function (p) { return next() < p },
    sample: function (list, n) {
      var copy = list.slice()
      var out = []
      while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0])
      return out
    },
  }
}

function samplePad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s }

function sampleJson_(v) { return v == null ? '' : JSON.stringify(v) }

// ---- メンバー ----

// 役割の違うメンバー(人格)。files はアップロードしたダミー画像の URL(キー → URL)
function buildSampleMembers_(today, files) {
  var R = SAMPLE_ROLES
  var d = function (n) { return sampleDay_(today, n) }
  var people = [
    // 01 代表: 経歴・スキル・評価がすべて豊富
    { n: 1, name: '高橋 誠', role: R.top, avatar: 'avatar1', joined: -1400, will: '企画,コミュニケーション,広報', judgment: '企画,要件定義,リサーチ',
      rich: true, management: true, dept: 'サンプル本部>運営', locale: 'ja' },
    // 02 全権管理者
    { n: 2, name: '伊藤 さくら', role: R.admin, avatar: 'avatar2', joined: -1000, will: 'デザイン,UI/UX,Canva', judgment: 'デザイン,Canva,PowerPoint',
      rich: true, management: true, dept: 'サンプル本部>デザイン', reportsTo: 1, locale: 'ja' },
    // 03 制限付きの管理者(担当プロジェクトだけを管理する)
    { n: 3, name: '渡辺 大輔', role: R.restricted, avatar: 'avatar3', joined: -700, will: 'イベント運営,企画', judgment: 'イベント運営,メール',
      rich: true, dept: 'サンプル本部>イベント', reportsTo: 2, projects: [2, 3], locale: 'ja' },
    // 04 制限付きの管理者(もう1人)
    { n: 4, name: '中村 優子', role: R.restricted, joined: -500, will: 'ライティング,広報,SNS', judgment: 'ライティング,校閲',
      dept: 'サンプル本部>広報', reportsTo: 2, projects: [4], locale: 'ja' },
    // 05 一般(テスト用アカウントの一般の枠): ほどほどにデータがある
    { n: 5, name: '小林 陽太', role: R.base, avatar: 'avatar4', joined: -300, will: 'デザイン,SNS,Canva', judgment: 'Canva',
      dept: 'サンプル本部>デザイン', reportsTo: 3, mentor: 2, locale: 'ja', medium: true },
    // 06 一般・英語表示
    { n: 6, name: 'Emily Carter', display: 'Emily', role: R.base, joined: -200, will: 'リサーチ,ライティング,コミュニケーション', judgment: 'リサーチ,ライティング',
      dept: 'サンプル本部>リサーチ', reportsTo: 3, locale: 'en', timezone: 'America/Los_Angeles', medium: true },
    // 07 ほぼ空(新しく入ったばかりで、何も入力していない)
    { n: 7, name: '加藤 蓮', role: R.base, joined: -3, empty: true },
    // 08 休止中
    { n: 8, name: '吉田 美咲', role: R.base, joined: -900, will: 'イベント運営', judgment: 'イベント運営,コミュニケーション', inactive: true,
      dept: 'サンプル本部>イベント', lastLogin: -60 },
    // 09 とても長い名前(表示の崩れの確認)
    { n: 9, name: '長谷川 アレクサンドラ 由紀子 ヴィクトリア シャーロット', display: '長谷川アレクサンドラ由紀子ヴィクトリアシャーロット(広報・デザイン・イベント担当)',
      role: R.base, joined: -150, will: 'デザイン,広報,イベント運営,SNS,Canva,PowerPoint,ライティング', judgment: 'デザイン,広報,SNS',
      dept: 'サンプル本部>広報>SNS チーム>とても長い部署名のグループ', reportsTo: 4 },
    // 10 所属3日目(Will だけ入力済み)
    { n: 10, name: '山本 健', role: R.base, joined: -2, will: '実装,Claude', judgment: '' },
  ]
  var others = [
    ['佐々木 翔', '実装,要件定義', '実装,プロダクト設計,Claude', 'サンプル本部>開発'],
    ['山口 真央', 'リサーチ,企画', 'リサーチ', 'サンプル本部>リサーチ'],
    ['松本 拓海', 'イベント運営,メール', 'イベント運営', 'サンプル本部>イベント'],
    ['井上 楓', '広報,SNS,ライティング', 'SNS,広報', 'サンプル本部>広報'],
    ['木村 悠斗', 'デザイン,UI/UX', 'UI/UX,デザイン', 'サンプル本部>デザイン'],
    ['林 結衣', '企画,コミュニケーション', 'コミュニケーション', 'サンプル本部>運営'],
    ['清水 颯', '実装,V0,Claude', 'V0,実装', 'サンプル本部>開発'],
    ['森 美月', 'ライティング,校閲', '校閲,ライティング', 'サンプル本部>広報'],
    ['池田 陸', 'PowerPoint,企画', 'PowerPoint', 'サンプル本部>運営'],
    ['橋本 七海', 'リサーチ,データ分析', 'リサーチ,データ分析', 'サンプル本部>リサーチ'],
  ]
  others.forEach(function (o, i) {
    people.push({ n: 11 + i, name: o[0], role: R.base, joined: -60 - i * 45, will: o[1], judgment: o[2], dept: o[3], reportsTo: i % 2 ? 3 : 4 })
  })

  var id = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  var colors = ['#6366f1', '#db2777', '#059669', '#d97706', '#0ea5e9', '#8b5cf6', '#dc2626', '#16a34a']
  return people.map(function (p) {
    var skills = (p.will + ',' + p.judgment).split(',').filter(Boolean)
    var uniq = skills.filter(function (s, i) { return skills.indexOf(s) === i })
    var row = {
      id: id(p.n),
      name: p.name,
      display_name: p.display || '',
      role: p.role,
      notify_new_task: p.n <= 4 ? 'TRUE' : 'FALSE',
      avatar_url: p.avatar && files[p.avatar] ? files[p.avatar] : '',
      avatar_color: colors[p.n % colors.length],
      avatar_initials: '',
      will_tags: p.empty ? '' : p.will,
      judgment_tags: p.empty ? '' : p.judgment,
      reports_to_id: p.reportsTo ? id(p.reportsTo) : '',
      mentor_id: p.mentor ? id(p.mentor) : '',
      joined_at: d(p.joined),
      project_ids: (p.projects || []).map(function (x) { return SAMPLE_ID_PREFIX + 'p-' + samplePad_(x, 2) }).join(','),
      department_path: p.dept || '',
      inactive: p.inactive ? 'TRUE' : '',
      last_login: p.empty ? '' : sampleAt_(today, p.lastLogin != null ? p.lastLogin : -(p.n % 5), '09:30'),
      locale: p.locale || '',
      timezone: p.timezone || (p.empty ? '' : 'Asia/Tokyo'),
    }
    if (p.empty) return row
    // Fact(実績)とレベルの表示のため、スキルのレベル・ポイントは全員に少しずつ入れる
    row.skill_levels_json = sampleJson_(uniq.slice(0, 5).map(function (s, i) {
      return { skill: s, level: Math.max(1, Math.min(5, (p.rich ? 4 : 2) + (i % 2) - (i > 2 ? 1 : 0))), acquiredAt: d(p.joined + 30) }
    }))
    var points = {}
    uniq.forEach(function (s, i) { points[s] = (p.rich ? 320 : p.medium ? 140 : 60) - i * 20 })
    row.skill_points_json = sampleJson_(points)
    row.desired_areas = p.n % 3 === 0 ? '' : 'マネジメント,新規事業'
    row.desired_skills = p.n % 2 ? 'データ分析,UI/UX' : 'Claude'
    row.unavailable_dates = p.n % 4 === 0 ? [d(3), d(4), d(10)].join(',') : ''
    row.absent_dates = p.n % 5 === 0 ? [d(1), d(8)].join(',') : ''
    row.available_hours_json = p.n % 3 === 0 ? sampleJson_({ start: '10:00', end: '18:00' }) : ''
    row.has_management_experience = p.management ? 'TRUE' : ''
    row.university = p.locale === 'en' ? 'University of Washington' : p.n % 2 ? 'サンプル大学' : ''
    row.faculty = p.n % 2 ? '経済学部' : ''
    row.department_name = p.n % 2 ? '経営学科' : ''
    row.grade_year = p.n % 2 ? String(1 + (p.n % 4)) : ''
    row.custom_fields_json = sampleJson_({ sample_slack: '@' + ('member' + p.n), sample_shirt: p.n % 2 ? 'M' : 'L' })
    row.notify_settings = p.n === 5 ? sampleJson_({ new_task: 'immediate', review: '1d', mention: 'immediate', deadline: 'none' }) : ''
    if (p.rich || p.medium) {
      row.career_history_json = sampleJson_([
        { id: 'ch1', startDate: d(p.joined), affiliation: 'サンプル団体', role: p.role, description: '団体の運営全体を担当' },
        { id: 'ch2', startDate: d(p.joined - 700), endDate: d(p.joined - 1), affiliation: '前職の株式会社サンプル', role: 'マーケティング担当', description: 'Web 広告の運用と分析' },
      ])
      row.qualifications_json = sampleJson_([
        { id: 'q1', name: 'ITパスポート', acquiredDate: d(-400), issuer: 'IPA', relatedSkills: ['実装'], external: true },
        { id: 'q2', name: '社内デザイン検定 2級', acquiredDate: d(-100), relatedSkills: ['デザイン'] },
      ])
      row.evaluation_history_json = sampleJson_([
        { id: 'e1', date: d(-180), evaluatorId: id(1), rating: 'B', comment: '着実に成果を出している' },
        { id: 'e2', date: d(-30), evaluatorId: id(2), rating: 'A', comment: '周囲を巻き込んで大型イベントを成功させた。次期はリーダーを任せたい。' },
      ])
      row.transfer_history_json = sampleJson_([{ id: 't1', date: d(-200), fromAffiliation: '広報', toAffiliation: p.dept || '運営', reason: '本人の希望' }])
      row.competencies_json = sampleJson_([{ name: 'リーダーシップ', level: p.rich ? 4 : 2 }, { name: '問題解決', level: 3 }])
      row.career_aspiration = p.locale === 'en' ? 'I want to lead a research team and publish our findings.' : '将来は団体の運営を任される立場になりたい'
      row.desired_future_role = p.locale === 'en' ? 'Research Lead' : '事業責任者'
      row.career_plan = p.locale === 'en' ? 'Year 1: learn the basics. Year 2: run small projects. Year 3: lead the research team.' : '1年目: 基礎を学ぶ / 2年目: 小さなプロジェクトを回す / 3年目: 班をまとめる'
      row.training_history_json = sampleJson_([
        { id: 'tr1', name: 'リーダー研修', date: d(-90), provider: 'サンプル研修会社', status: 'approved', attendanceStatus: 'attended' },
        { id: 'tr2', name: 'デザイン思考ワークショップ', date: d(20), status: 'pending' },
        { id: 'tr3', name: '会計の基礎', date: d(-10), status: 'rejected' },
      ])
      row.development_plan_json = sampleJson_([
        { id: 'dp1', goal: 'イベントを1人で企画・運営できるようになる', targetDate: d(90), status: 'in_progress' },
        { id: 'dp2', goal: 'デザイン検定2級に合格する', targetDate: d(-5), status: 'done' },
        { id: 'dp3', goal: '後輩のメンターを務める', targetDate: d(180), status: 'not_started' },
      ])
      row.one_on_ones_json = sampleJson_([
        { id: 'o1', date: d(-35), withId: id(p.reportsTo || 2), notes: '最近の困りごと: 作業の優先順位が分からない → 週初めに一緒に整理する' },
        { id: 'o2', date: d(-7), withId: id(p.reportsTo || 2), notes: '先月の目標はおおむね達成。次はイベントの企画に挑戦したい。' },
      ])
      row.survey_responses_json = sampleJson_([
        { id: 'sr1', submittedAt: sampleAt_(today, -20, '20:00'), answers: { 'sample-sq-1': 4, 'sample-sq-2': 3, 'sample-sq-3': '連絡の手段が多くて迷うことがある' } },
      ])
      row.permission_overrides_json = p.n === 5 ? sampleJson_([{ targetType: 'project', targetId: SAMPLE_ID_PREFIX + 'p-02', access: 'view' }]) : ''
    }
    return row
  })
}

// ---- プロジェクト ----

function buildSampleProjects_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var P = function (n) { return SAMPLE_ID_PREFIX + 'p-' + samplePad_(n, 2) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  return [
    { id: P(1), name: '団体運営', description: '日々の運営業務(会計・連絡・定例)', type: '運営', owner_id: M(1), member_ids: [M(1), M(2), M(16), M(19)].join(','),
      goal: '運営の仕組みを整え、1人に負担が偏らないようにする', start_date: d(-400), archived: 'FALSE' },
    { id: P(2), name: '秋のイベント 2026', description: '学外向けの大型イベント。来場者300人を目標に準備する。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(5), M(8), M(13), M(9)].join(','), goal: '来場者300人・満足度4以上', start_date: d(-45), end_date: d(40), archived: 'FALSE' },
    // 親子関係(秋のイベントの子プロジェクト)
    { id: P(3), name: '秋のイベント 2026 / 広報チーム', description: 'SNS とポスターでの告知', type: 'イベント', parent_id: P(2), owner_id: M(3),
      member_ids: [M(3), M(9), M(14)].join(','), start_date: d(-30), end_date: d(35), archived: 'FALSE' },
    { id: P(4), name: 'Webサイトのリニューアル', description: '団体の Web サイトを作り直す。期限が迫っているが、作業が遅れている。', type: '開発', owner_id: M(4),
      member_ids: [M(4), M(11), M(15), M(17)].join(','), goal: '来月末に公開する', start_date: d(-90), end_date: d(-3), archived: 'FALSE',
      health_override: '' },
    { id: P(5), name: '新歓 2027', description: '来月から始まる新入生の勧誘の準備', type: 'イベント', owner_id: M(2), member_ids: [M(2), M(12), M(20)].join(','),
      start_date: d(35), end_date: d(120), archived: 'FALSE' },
    { id: P(6), name: 'Community Research', description: 'Interview members of partner organizations and summarize what they need from us. The report will be shared at the general meeting.',
      type: 'Research', owner_id: M(6), member_ids: [M(6), M(12), M(20)].join(','), goal: 'Publish the research report by the end of next month',
      start_date: d(-20), end_date: d(45), archived: 'FALSE', health_override: 'watch' },
    { id: P(7), name: '春のイベント 2026(終了)', description: '終了したイベント。記録のために残している。', type: 'イベント', owner_id: M(3),
      member_ids: [M(3), M(8), M(13)].join(','), start_date: d(-200), end_date: d(-120), archived: 'TRUE' },
    { id: P(8), name: 'とても長い名前のプロジェクト:地域の子ども向けプログラミング教室と保護者向け説明会の合同開催(2026年度・第3期)',
      description: 'プロジェクト名や説明が長い場合の表示を確かめるためのプロジェクト。' + new Array(15).join('説明の文章がとても長く続く場合でも、画面が崩れないことを確かめます。'),
      type: '教育', owner_id: M(9), member_ids: [M(9), M(11), M(17)].join(','), start_date: d(-10), end_date: d(80), archived: 'FALSE' },
  ]
}

// ---- タスク ----

// 変更の記録(今の形式: ステータスは日本語の表示名)
function sampleHistory_(today, byId, entries) {
  return entries.map(function (e, i) {
    return { id: 'h' + (i + 1), at: sampleAt_(today, e[0], '11:00'), byId: byId, field: e[1], from: e[2], to: e[3] }
  })
}

function buildSampleTasks_(today) {
  var d = function (n) { return sampleDay_(today, n) }
  var at = function (n, t) { return sampleAt_(today, n, t) }
  var P = function (n) { return SAMPLE_ID_PREFIX + 'p-' + samplePad_(n, 2) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  var tasks = []
  var seq = 0
  var add = function (t) {
    seq++
    var row = {
      id: SAMPLE_ID_PREFIX + 't-' + samplePad_(seq, 3),
      project_id: P(1), title: '', description: '', status: '未着手', assign_type: 'open_bid', assignee_id: '',
      creator_id: M(1), created_at: d(-10), start_date: '', due_date: '', due_time: '', visibility: '全員', department: '運営',
      category: '企画', skills: '', difficulty: '新人歓迎', priority: '中', last_activity: d(-1), original_input_id: '',
      approval_status: '承認済み', estimated_hours: '', importance: '一般',
    }
    Object.keys(t).forEach(function (k) { row[k] = t[k] })
    tasks.push(row)
    return row.id
  }

  // -- 期限・状態の典型例(実行した日を基準にする) --
  add({ title: '会計報告書の提出', project_id: P(1), status: '進行中', assignee_id: M(16), due_date: d(-5), priority: '高', skills: '企画',
    description: '期限を過ぎているタスク。', history_json: sampleJson_(sampleHistory_(today, M(1), [[-12, 'status', '未着手', '進行中']])) })
  add({ title: 'ポスターのデザイン案を3つ作る', project_id: P(3), department: 'デザイン', category: 'デザイン', status: '進行中', assignee_id: M(5), start_date: d(-4),
    due_date: d(2), priority: '高', skills: 'デザイン,Canva', difficulty: '少し経験必要', progress_percent: '60', progress_note: '2案できた。3案目を作成中。',
    progress_history_json: sampleJson_([{ id: 'pg1', text: '1案目を共有しました', at: at(-3), byId: M(5) }, { id: 'pg2', text: '2案目を共有しました', at: at(-1), byId: M(5) }]) })
  add({ title: '当日の受付マニュアルを作る', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', assignee_id: M(13), due_date: d(0),
    due_time: '18:00', skills: 'イベント運営,ライティング', description: '今日が締切(時刻つき)。' })
  add({ title: '新歓チラシの原稿', project_id: P(5), department: '広報', category: 'ライティング', status: '未着手', assignee_id: M(14), start_date: d(35),
    due_date: d(50), skills: 'ライティング,広報', description: '来月から始まるタスク。' })
  var doneRecent = add({ title: '会場の予約', project_id: P(2), department: 'イベント', category: 'イベント', status: '完了', assignee_id: M(3), due_date: d(-6),
    completed_date: d(-3), skills: 'イベント運営,メール', estimated_hours: '3', actual_hours: '4.5', awarded_points_json: sampleJson_({ 'イベント運営': 30 }),
    retrospective_json: sampleJson_({ good: '早めに候補を3つ押さえられた', bad: '見積もりの比較に時間がかかった', improve: '次回は比較表のひな形を使う' }),
    deliverables_json: sampleJson_([{ id: 'dl1', label: '予約確認メール', url: 'https://example.com/booking' }, { id: 'dl2', label: '会場の図面', url: 'https://example.com/floor' }]) })
  add({ title: '春のイベントのアンケート集計', project_id: P(7), department: 'リサーチ', category: 'リサーチ', status: '完了', assignee_id: M(12), due_date: d(-130),
    completed_date: d(-125), skills: 'リサーチ,データ分析', description: '完了から日が経ち、アーカイブに入るタスク。', awarded_points_json: sampleJson_({ 'リサーチ': 40 }),
    retrospective_json: sampleJson_({ good: '回収率が高かった', bad: '自由記述の集計に手間取った', improve: '選択式の設問を増やす' }) })
  add({ title: '過去の議事録の整理', project_id: P(1), status: '完了', assignee_id: M(19), due_date: d(-25), completed_date: d(-20), skills: '企画', description: '完了から14日を過ぎたタスク(アーカイブ)。' })

  // -- 公募 --
  add({ title: '当日のカメラマン(公募)', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', due_date: d(30), skills: 'デザイン',
    difficulty: '誰でも可', open_bid_applicant_ids: [M(5), M(15)].join(','), description: '応募者が2人いる公募のタスク。' })
  add({ title: 'SNS 投稿の文章チェック(公募)', project_id: P(3), department: '広報', category: '広報', status: '未着手', due_date: d(12), skills: '校閲,SNS', difficulty: '新人歓迎' })

  // -- 承認待ち(一般のメンバーが登録したもの。重要度ごと) --
  add({ title: '備品の購入(承認待ち)', project_id: P(2), creator_id: M(5), approval_status: '承認待ち', assignee_id: M(5), due_date: d(9), category: '物品調達' })
  add({ title: 'スポンサーへの依頼文(重要・承認待ち)', project_id: P(2), creator_id: M(13), approval_status: '承認待ち', importance: '重要', department: '渉外',
    category: '渉外', due_date: d(7), skills: 'ライティング,コミュニケーション' })
  add({ title: 'プレスリリースの公開(対外公開・承認待ち)', project_id: P(3), creator_id: M(14), approval_status: '承認待ち', importance: '対外公開', department: '広報',
    category: '広報', due_date: d(14), skills: '広報,ライティング' })

  // -- 幹部限定 --
  add({ title: '来年度の予算案(幹部限定)', project_id: P(1), visibility: '幹部', status: '進行中', assignee_id: [M(1), M(2)].join(','), due_date: d(20), priority: '高',
    description: '幹部だけが見られるタスク。一般のメンバーには表示されない。' })

  // -- 確認(複数の確認者・確認タスク) --
  var reviewed = add({ title: 'Web サイトのトップページ', project_id: P(4), department: '開発', category: '開発', status: '確認待ち', assignee_id: M(15), due_date: d(1),
    skills: 'UI/UX,実装', reviewer_ids: [M(2), M(4)].join(','), reviewer_id: M(2), required_approvals: 'all',
    review_approvals_json: sampleJson_([{ memberId: M(4), at: at(-1), comment: 'レイアウトは問題なし。画像の差し替えだけお願いします。' }]),
    history_json: sampleJson_(sampleHistory_(today, M(15), [[-8, 'status', '未着手', '進行中'], [-1, 'status', '進行中', '確認待ち']])) })
  add({ title: '「Web サイトのトップページ」の確認', project_id: P(4), department: '開発', category: '開発', status: '未着手', assignee_id: M(2), due_date: d(2),
    related_review_task_id: reviewed, creator_id: M(15) })
  add({ title: 'お知らせページの文章', project_id: P(4), department: '広報', category: 'ライティング', status: '修正中', assignee_id: M(18), due_date: d(4), reviewer_id: M(4),
    reviewer_ids: M(4), required_approvals: '1', skills: 'ライティング,校閲',
    history_json: sampleJson_(sampleHistory_(today, M(4), [[-6, 'status', '進行中', '確認待ち'], [-2, 'status', '確認待ち', '修正中']])) })

  // -- 依存関係 --
  var dep1 = add({ title: 'サイトの構成を決める', project_id: P(4), department: '開発', category: '開発', status: '完了', assignee_id: M(11), due_date: d(-20), completed_date: d(-18),
    skills: '要件定義,プロダクト設計', awarded_points_json: sampleJson_({ '要件定義': 25 }) })
  var dep2 = add({ title: 'デザインのカンプ', project_id: P(4), department: 'デザイン', category: 'デザイン', status: '進行中', assignee_id: M(15), due_date: d(-2),
    skills: 'デザイン,UI/UX', depends_on_ids: dep1, blocker_note: '素材の写真がまだ届いていない', blocker_since: d(-4), priority: '高' })
  add({ title: 'サイトの実装', project_id: P(4), department: '開発', category: '開発', status: '未着手', assignee_id: [M(11), M(17)].join(','), due_date: d(10),
    skills: '実装,V0', depends_on_ids: [dep1, dep2].join(','), difficulty: '経験者向け', required_skill_levels_json: sampleJson_({ '実装': 4, 'UI/UX': 3 }) })

  // -- サポート必要・保留 --
  add({ title: '協賛企業のリストアップ', project_id: P(2), department: '渉外', category: '渉外', status: 'サポート必要', assignee_id: M(10), due_date: d(6),
    blocker_note: '何から手を付ければよいか分からない', blocker_since: d(-2), difficulty: '新人歓迎' })
  add({ title: 'ノベルティの発注', project_id: P(2), department: 'イベント', category: '物品調達', status: '保留', assignee_id: M(8), due_date: d(25),
    hold_reason_note: '予算が確定するまで保留', hold_reason_since: d(-7) })

  // -- 日程調整・フォーム --
  add({ title: '打ち上げの日程調整', project_id: P(2), department: 'イベント', category: 'イベント', status: '進行中', assignee_id: M(3), due_date: d(5),
    schedule_json: sampleJson_({
      candidates: [
        { id: 'c1', label: d(12) + ' 18:00-20:00', date: d(12), startTime: '18:00', endTime: '20:00' },
        { id: 'c2', label: d(13) + ' 19:00-21:00', date: d(13), startTime: '19:00', endTime: '21:00' },
        { id: 'c3', label: '週末のどこか(自由記述の候補)' },
      ],
      invitedIds: [M(3), M(5), M(13), M(9)],
      responses: { 'sample-m-03': { c1: '○', c2: '△', c3: '×' }, 'sample-m-05': { c1: '○', c2: '○', c3: '△' } },
    }) })
  add({ title: 'Tシャツのサイズ調査', project_id: P(2), department: 'イベント', category: 'イベント', status: '進行中', assignee_id: M(13), due_date: d(8),
    form_json: sampleJson_({
      fields: [
        { id: 'f1', label: 'サイズ', type: 'select', options: ['S', 'M', 'L', 'XL'], required: true },
        { id: 'f2', label: '色の希望', type: 'checkbox', options: ['白', '黒', '紺'] },
        { id: 'f3', label: '備考', type: 'textarea' },
      ],
      invitedIds: [M(5), M(9), M(13), M(14)],
      responses: { 'sample-m-05': { f1: 'M', f2: ['白', '紺'], f3: '' }, 'sample-m-14': { f1: 'L', f2: ['黒'], f3: '当日は遅れて参加します' } },
    }) })

  // -- 表示の崩れの確認(極端な例) --
  add({ title: 'とても長いタスク名の例:来場者アンケートの設問の見直しと、回答しやすい順番への並べ替え、および前回の自由記述の回答をもとにした選択肢の追加(第2版)',
    project_id: P(8), department: 'リサーチ', category: 'リサーチ', status: '進行中', assignee_id: M(9), due_date: d(15), skills: 'リサーチ,企画,ライティング,データ分析',
    description: new Array(40).join('説明がとても長い場合の表示を確かめるための文章です。改行が無く続く場合と、\n改行を含む場合の両方を確かめます。') })
  var comments = []
  for (var c = 0; c < 150; c++) {
    var by = M(1 + (c % 9))
    var mention = c % 10 === 0 ? ' @渡辺 大輔 確認をお願いします' : ''
    comments.push({ id: 'cm' + c, byId: by, at: at(-20 + Math.floor(c / 8), (9 + (c % 10)) + ':' + samplePad_((c * 7) % 60, 2)),
      text: 'コメント ' + (c + 1) + ' 件目。進み具合の共有です。' + mention, mentionedIds: mention ? [M(3)] : undefined })
  }
  add({ title: 'コメントがとても多いタスク(150件)', project_id: P(2), status: '進行中', assignee_id: M(3), due_date: d(18), comments_json: sampleJson_(comments) })
  add({ title: '担当者が多いタスク(12人)', project_id: P(2), department: 'イベント', category: 'イベント', status: '未着手', due_date: d(30),
    assignee_id: [2, 3, 5, 9, 11, 12, 13, 14, 15, 16, 17, 18].map(M).join(','), skills: 'イベント運営' })

  // -- 英語表示の人が担当するタスク(英語の文章) --
  add({ title: 'Interview five partner organizations', project_id: P(6), department: 'リサーチ', category: 'リサーチ', status: '進行中', assignee_id: M(6), due_date: d(9),
    skills: 'リサーチ,コミュニケーション', description: 'Schedule 30-minute interviews, record the key points, and share a short summary in the comments after each interview.',
    comments_json: sampleJson_([{ id: 'en1', byId: M(12), at: at(-2), text: 'I can join the interview on Thursday if you need a note-taker.' },
      { id: 'en2', byId: M(6), at: at(-1), text: 'Thanks! That would be really helpful.' }]) })
  add({ title: 'Draft the research report (very long English title to check how the layout wraps across several lines)', project_id: P(6), department: 'リサーチ',
    category: 'ライティング', status: '未着手', assignee_id: M(6), start_date: d(10), due_date: d(40), skills: 'ライティング,リサーチ', difficulty: '経験者向け',
    description: 'Summarize the interviews into a report with three sections: background, findings, and recommendations. Keep it under ten pages.' })
  add({ title: 'Translate the survey into Japanese', project_id: P(6), department: 'リサーチ', category: 'ライティング', status: '完了', assignee_id: M(6), due_date: d(-8),
    completed_date: d(-6), skills: 'ライティング', awarded_points_json: sampleJson_({ 'ライティング': 20 }),
    retrospective_json: sampleJson_({ good: 'Finished two days early', bad: 'Some terms were hard to translate', improve: 'Keep a glossary for next time' }) })

  // -- 定期タスクから作られたように見えるタスク(定期タスクのルールは停止中) --
  for (var w = 3; w >= 0; w--) {
    add({ title: '週次定例の議事録', project_id: P(1), category: '企画', skills: 'ライティング', creator_id: '', assignee_id: M(19),
      created_at: d(-7 * w), due_date: d(-7 * w + 2), status: w === 0 ? '未着手' : '完了', completed_date: w === 0 ? '' : d(-7 * w + 1), difficulty: '誰でも可' })
  }

  // -- 普通のタスク(推薦・集計・一覧の件数のため。スキルは担当者の Will・Judgment と合わせる) --
  var rng = sampleRandom_(20261001)
  // テスト用のアカウントの枠のメンバー(1・2・3・5)にも、自分のタスクの画面で確かめられるよう割り当てる
  var regularMembers = [5, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 1, 2, 3, 5]
  var skillOf = { 1: '企画,リサーチ', 2: 'デザイン,UI/UX', 3: 'イベント運営,メール', 5: 'デザイン,Canva', 9: '広報,SNS', 11: '実装,要件定義', 12: 'リサーチ,データ分析', 13: 'イベント運営,メール', 14: 'SNS,広報',
    15: 'UI/UX,デザイン', 16: '企画,コミュニケーション', 17: '実装,V0', 18: 'ライティング,校閲', 19: 'PowerPoint,企画', 20: 'リサーチ,データ分析' }
  var deptOf = { 'デザイン': 'デザイン', '広報': '広報', 'SNS': '広報', '実装': '開発', 'UI/UX': 'デザイン', 'リサーチ': 'リサーチ', 'イベント運営': 'イベント',
    '企画': '運営', 'ライティング': '広報', 'PowerPoint': '運営', '校閲': '広報' }
  var verbs = ['資料の作成', '進め方の相談', '候補の洗い出し', '見積もりの確認', '下書きの作成', '関係者への連絡', '結果のまとめ', 'チェックリストの更新']
  var statuses = ['未着手', '未着手', '進行中', '進行中', '進行中', '確認待ち', '完了', '完了', '完了', '保留']
  var activeProjects = [1, 2, 3, 4, 5, 8]
  for (var i = 0; i < 115; i++) {
    var mNo = regularMembers[i % regularMembers.length]
    var skills = skillOf[mNo]
    var status = rng.pick(statuses)
    var project = activeProjects[i % activeProjects.length]
    var done = status === '完了'
    // 終わっていないタスクの期限は、多くを先の日付にする(期限切れは1割ほど)
    var due = done ? rng.int(-60, -2) : rng.chance(0.12) ? rng.int(-15, -1) : rng.int(1, 45)
    var startOffset = due - rng.int(3, 25)
    var completed = done ? Math.min(-1, due - rng.int(0, 5)) : null
    add({
      title: skills.split(',')[0] + 'の' + verbs[i % verbs.length] + '(' + (i + 1) + ')',
      project_id: P(project), department: deptOf[skills.split(',')[0]] || '運営', category: rng.pick(['企画', 'デザイン', '広報', 'リサーチ', 'イベント', '開発']),
      status: status, assignee_id: rng.chance(0.15) ? '' : M(mNo), creator_id: M(rng.pick([1, 2, 3, 4])), created_at: d(startOffset - 3),
      start_date: d(startOffset), due_date: d(due), completed_date: done ? d(completed) : '', skills: skills,
      difficulty: rng.pick(['誰でも可', '新人歓迎', '少し経験必要', '経験者向け', '上級者向け']), priority: rng.pick(['高', '中', '中', '低']),
      estimated_hours: String(rng.int(1, 8)), actual_hours: done ? String(rng.int(1, 10)) : '',
      awarded_points_json: done ? sampleJson_(JSON.parse('{"' + skills.split(',')[0] + '":' + (10 + rng.int(0, 30)) + '}')) : '',
      progress_percent: done ? '100' : String(rng.int(0, 90)),
      hold_reason_note: status === '保留' ? '他のタスクの結果待ち' : '', hold_reason_since: status === '保留' ? d(-rng.int(1, 10)) : '',
      last_activity: d(done ? completed : -rng.int(0, 20)),
      history_json: rng.chance(0.4) ? sampleJson_(sampleHistory_(today, M(mNo), [[startOffset, 'status', '未着手', '進行中']])) : '',
    })
  }
  return tasks
}

// ---- 経費・フォーム・日報・採用 ----

function buildSampleOtherSheets_(today, files) {
  var d = function (n) { return sampleDay_(today, n) }
  var at = function (n, t) { return sampleAt_(today, n, t) }
  var M = function (n) { return SAMPLE_ID_PREFIX + 'm-' + samplePad_(n, 2) }
  var S = SAMPLE_ID_PREFIX
  var steps = [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }]
  var expense = function (n, o) {
    return {
      id: S + 'exp-' + samplePad_(n, 2), applicant_id: o.by, amount: String(o.amount), category_id: o.cat || S + 'expcat-transport',
      receipt_url: o.receipt || '', justification: o.justification || '', purpose: o.purpose, custom_field_answers_json: sampleJson_(o.custom || {}),
      approval_steps_json: sampleJson_(steps), approvals_json: sampleJson_(o.approvals || []), current_step_index: String(o.step || 0),
      status: o.status, created_at: at(o.day, '12:00'), rejection_reason: o.reason || '',
    }
  }
  var approved = function (stepId, by, day) { return { stepId: stepId, memberId: by, at: at(day, '15:00'), action: 'approved' } }
  var Expenses = [
    expense(1, { by: M(5), amount: 1280, purpose: 'ポスター印刷用の紙', status: 'pending', day: -1, receipt: files.receipt_png, custom: { destination: '文具店' } }),
    expense(2, { by: M(6), amount: 3400, purpose: 'Transportation to the partner interview', status: 'pending', step: 1, day: -4, receipt: files.receipt_pdf,
      approvals: [approved('s1', M(3), -3)], custom: { destination: 'Shibuya' } }),
    expense(3, { by: M(13), amount: 15800, purpose: '会場の下見の交通費', status: 'approved', step: 2, day: -20, receipt: files.receipt_png,
      approvals: [approved('s1', M(3), -19), approved('s2', M(1), -18)] }),
    expense(4, { by: M(9), amount: 52000, cat: S + 'expcat-goods', purpose: 'カメラの購入', justification: 'イベントの撮影に使うため', status: 'rejected', day: -15,
      approvals: [{ stepId: 's1', memberId: M(3), at: at(-14, '10:00'), action: 'rejected', comment: 'レンタルで足りるため' }], reason: 'レンタルで足りるため' }),
    expense(5, { by: M(14), amount: 2200, purpose: '打ち合わせの飲み物代', status: 'returned', day: -6, reason: '領収書の画像を添付してください' }),
    expense(6, { by: M(5), amount: 800, purpose: '(取り下げ)重複して申請したもの', status: 'withdrawn', day: -9 }),
    expense(7, { by: M(9), amount: 1234567, cat: S + 'expcat-goods', status: 'pending', day: -2, receipt: files.receipt_png,
      purpose: '金額と説明がとても長い場合の表示の確認:' + new Array(8).join('音響機材・照明機材・ステージの設営一式のレンタルと運搬費用。'), justification: new Array(6).join('大型イベントのため、例年より規模が大きい。') }),
  ]
  var formSteps = [{ id: 'fs1', type: 'role', role: SAMPLE_ROLES.admin }]
  var submission = function (n, o) {
    return {
      id: S + 'fsub-' + samplePad_(n, 2), form_id: S + 'form-equipment', submitter_id: o.by, answers_json: sampleJson_(o.answers),
      approvals_json: sampleJson_(o.approvals || []), current_step_index: String(o.step || 0), status: o.status, created_at: at(o.day, '13:00'),
      rejection_reason: o.reason || '',
    }
  }
  var FormSubmissions = [
    submission(1, { by: M(5), answers: { item: 'プロジェクター', from: d(10), qty: 1 }, status: 'pending', day: -1 }),
    submission(2, { by: M(13), answers: { item: '延長コード', from: d(-5), qty: 3 }, status: 'approved', step: 1, day: -8,
      approvals: [{ stepId: 'fs1', memberId: M(2), at: at(-7, '10:00'), action: 'approved' }] }),
    submission(3, { by: M(6), answers: { item: 'Camera tripod', from: d(3), qty: 2 }, status: 'rejected', day: -3,
      approvals: [{ stepId: 'fs1', memberId: M(2), at: at(-2, '10:00'), action: 'rejected', comment: '同じ日に別の予約があるため' }], reason: '同じ日に別の予約があるため' }),
  ]
  var DailyReports = []
  var reporters = [[5, 'ja'], [6, 'en'], [11, 'ja'], [13, 'ja']]
  reporters.forEach(function (r) {
    for (var day = -9; day <= 0; day++) {
      if ((day + r[0]) % 3 === 0) continue
      var en = r[1] === 'en'
      DailyReports.push({
        id: S + 'dr-' + samplePad_(r[0], 2) + '-' + samplePad_(-day, 2), member_id: M(r[0]), type: 'daily', report_date: d(day),
        done_text: en ? 'Finished the interview notes for two organizations.' : '担当のタスクを進めました。資料を半分まで作成。',
        todo_text: en ? 'Start drafting the summary.' : '明日は資料の残りを仕上げる。',
        issues_text: day % 4 === 0 ? (en ? 'Waiting for a reply from one partner.' : '先方からの返事待ちで止まっている作業がある。') : '',
        created_at: at(day, '21:00'),
      })
    }
    DailyReports.push({ id: S + 'dr-' + samplePad_(r[0], 2) + '-w', member_id: M(r[0]), type: 'weekly', report_date: d(-7),
      done_text: r[1] === 'en' ? 'Completed three interviews this week.' : '今週はタスクを3件完了しました。', todo_text: r[1] === 'en' ? 'Two more interviews next week.' : '来週はイベントの準備に集中する。',
      issues_text: '', created_at: at(-7, '20:00') })
  })
  var Candidates = [
    { id: S + 'c-01', name: '候補 一郎', email: '', phone: '', resume_text: '大学2年。イベント運営に興味がある。', interview_notes: '明るく話しやすい。', status: 'candidate', created_at: at(-5), updated_at: at(-2) },
    { id: S + 'c-02', name: '候補 花子', resume_text: 'デザインの経験あり(ポートフォリオあり)。', interview_notes: '次回は実技の課題を出す。', status: 'candidate', created_at: at(-12), updated_at: at(-4) },
    { id: S + 'c-03', name: '候補 次郎', resume_text: '', interview_notes: '日程が合わず辞退。', status: 'rejected', created_at: at(-40), updated_at: at(-30) },
    { id: S + 'c-04', name: '候補 三郎', resume_text: '大学1年。', interview_notes: '入会が決まった。', status: 'hired', created_at: at(-60), updated_at: at(-50) },
    { id: S + 'c-05', name: 'とても長い名前の候補者 ジョナサン・アレクサンダー・ウィリアムズ 三世', resume_text: new Array(20).join('自己紹介の文章がとても長い場合。'),
      interview_notes: new Array(10).join('面接のメモがとても長い場合。'), status: 'candidate', created_at: at(-3), updated_at: at(-1) },
  ]
  return { Expenses: Expenses, FormSubmissions: FormSubmissions, DailyReports: DailyReports, Candidates: Candidates }
}

// ---- Settings に足すもの ----
//   lists  カンマ区切りの一覧に足す値(既にある値は足さない)
//   items  id を持つ配列に足す要素(id は 'sample-' で始める)
//   values 文字列の配列に足す値
//   maps   キーで引く設定に足すキー(既にあるキーは変えない)
//   scalars 値が1つの設定(元の値を退避してから書き、削除の時に戻す)
function buildSampleSettings_(today, files) {
  var d = function (n) { return sampleDay_(today, n) }
  var S = SAMPLE_ID_PREFIX
  var M = function (n) { return S + 'm-' + samplePad_(n, 2) }
  var tpl = function (id, name, dept, cat, skills, diff, prio, dependsOn) {
    return { id: id, name: name, department: dept, category: cat, skills: skills, difficulty: diff, priority: prio, dependsOn: dependsOn || [] }
  }
  return {
    lists: {
      skill_options: ['データ分析'],
      category_options: ['定例'],
      skill_field_options: ['分析'],
      role_levels: [SAMPLE_ROLES.admin, SAMPLE_ROLES.restricted],
      restricted_roles: [SAMPLE_ROLES.restricted],
    },
    items: {
      task_set_templates: [{ id: S + 'tst-event', name: 'イベント開催(サンプル)', description: 'イベントを開く時の定番のタスク一式',
        items: [tpl('a', '会場の予約', 'イベント', 'イベント', ['イベント運営'], '新人歓迎', '高'), tpl('b', '告知ポスター', 'デザイン', 'デザイン', ['デザイン', 'Canva'], '少し経験必要', '中', ['a']),
          tpl('c', '当日の運営マニュアル', 'イベント', 'イベント', ['ライティング'], '新人歓迎', '中', ['a'])] }],
      recurring_rules: [
        { id: S + 'rr-weekly', name: '週次定例の議事録', projectId: S + 'p-01', department: '運営', category: '企画', skills: ['ライティング'], difficulty: '誰でも可',
          priority: '中', frequency: 'weekly', dayOfWeek: 1, dueInDays: 2, active: false, lastGeneratedDate: d(0), skipDates: [d(14)] },
        { id: S + 'rr-monthly', name: '月次の会計チェック', projectId: S + 'p-01', department: '運営', category: '企画', skills: ['企画'], difficulty: '少し経験必要',
          priority: '高', frequency: 'monthly', dayOfMonth: 25, dueInDays: 5, active: false },
      ],
      quiz_definitions: [{ id: S + 'quiz-design', title: 'デザインの基礎(サンプル)', targetSkill: 'デザイン', targetLevel: 3, passRate: 70, questions: [
        { id: 'q1', text: '余白を広く取る主な目的は?', choices: ['読みやすくするため', '印刷代を節約するため', '文字を小さくするため'], correctIndex: 0 },
        { id: 'q2', text: '1つのポスターで使う書体の数は?', choices: ['できるだけ多く', '2〜3種類まで', '10種類以上'], correctIndex: 1 },
      ] }],
      learning_contents: [
        { id: S + 'lc-1', title: 'Canva の使い方(動画)', url: 'https://www.example.com/canva', contentType: 'video', relatedSkill: 'Canva', relatedQuizId: S + 'quiz-design', createdAt: d(-30) },
        { id: S + 'lc-2', title: 'イベント運営マニュアル', description: '会場の予約から撤収までの手順', url: 'https://www.example.com/manual', contentType: 'manual', relatedSkill: 'イベント運営', createdAt: d(-20) },
        { id: S + 'lc-3', title: 'How to run a user interview', url: 'https://www.example.com/interview', contentType: 'link', relatedSkill: 'リサーチ', createdAt: d(-10) },
      ],
      learning_courses: [{ id: S + 'course-new', title: '新入生向けコース(サンプル)', description: '入ったばかりの人が最初に見る資料', contentIds: [S + 'lc-2', S + 'lc-1'], relatedQuizId: S + 'quiz-design' }],
      training_programs: [
        { id: S + 'tp-leader', name: 'リーダー研修', description: '班をまとめる人向け', targetSegments: ['管理職候補'] },
        { id: S + 'tp-basic', name: '新人研修', targetSegments: ['新人'] },
      ],
      survey_questions: [
        { id: S + 'sq-1', text: '今の活動に満足していますか?', type: 'scale', scaleMinLabel: '不満', scaleMaxLabel: '満足', imageUrl: files.survey_image || undefined },
        { id: S + 'sq-2', text: '自分の成長を感じますか?', type: 'scale', scaleMinLabel: '感じない', scaleMaxLabel: '感じる' },
        { id: S + 'sq-3', text: '困っていることがあれば教えてください', type: 'text' },
      ],
      custom_form_defs: [{ id: S + 'form-equipment', title: '備品の貸し出し申請(サンプル)', description: '団体の備品を借りる時に使います',
        fields: [{ id: 'item', label: '借りるもの', type: 'text', required: true }, { id: 'from', label: '借りる日', type: 'date', required: true },
          { id: 'qty', label: '数', type: 'number', required: true }], approvalSteps: [{ id: 'fs1', type: 'role', role: SAMPLE_ROLES.admin }] }],
      expense_categories: [
        { id: S + 'expcat-transport', label: '交通費(サンプル)', approvalSteps: [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }],
          customFields: [{ key: 'destination', label: '行き先', type: 'text' }] },
        { id: S + 'expcat-goods', label: '物品購入(サンプル)', approvalSteps: [{ id: 's1', type: 'role', role: SAMPLE_ROLES.restricted }, { id: 's2', type: 'member', memberId: M(1) }] },
      ],
      custom_member_columns_json: [{ key: 'sample_slack', label: 'Slack の名前(サンプル)', type: 'text' }, { key: 'sample_shirt', label: 'Tシャツのサイズ(サンプル)', type: 'text' }],
    },
    // id を持たない配列: 足した値だけを消す
    values: {
      one_on_one_questions: ['(サンプル)最近うれしかったことは?', '(サンプル)手伝ってほしいことは?'],
      radar_axes: [{ skill: 'データ分析', label: 'データ分析(サンプル)' }],
      department_tree_config: [{ path: 'サンプル本部' }, { path: 'サンプル本部>イベント' }, { path: 'サンプル本部>広報>SNS チーム' }],
    },
    maps: {
      project_templates: { 'サンプル: イベント': [tpl('a', '会場の予約', 'イベント', 'イベント', ['イベント運営'], '新人歓迎', '高'), tpl('b', '振り返り会', 'イベント', 'イベント', ['企画'], '誰でも可', '低', ['a'])] },
      role_permissions: (function () { var o = {}; o[SAMPLE_ROLES.restricted] = ['dashboard', 'assignments', 'approvals', 'projects', 'dailyReports']; return o })(),
      job_requirements: (function () { var o = {}; o[SAMPLE_ROLES.restricted] = ['イベント運営', 'コミュニケーション']; return o })(),
      skill_field_skills: { '分析': ['データ分析', 'リサーチ'] },
      skill_level_thresholds: { 'データ分析': 150 },
    },
    scalars: {
      org_name: 'サンプル団体',
      org_logo_url: files.org_logo || '',
      theme_color: '#6366f1',
    },
  }
}

// アップロード用フォルダに作るダミー画像(ファイル名の先頭は、画面が種類を見分けるのに使う)
function sampleFileSpecs_() {
  return [
    { key: 'avatar1', name: 'avatar_sample-m-01_', png: 'avatar1', url: 'image' },
    { key: 'avatar2', name: 'avatar_sample-m-02_', png: 'avatar2', url: 'image' },
    { key: 'avatar3', name: 'avatar_sample-m-03_', png: 'avatar3', url: 'image' },
    { key: 'avatar4', name: 'avatar_sample-m-05_', png: 'avatar4', url: 'image' },
    { key: 'org_logo', name: 'org_logo_sample_', png: 'logo', url: 'image' },
    { key: 'survey_image', name: 'survey_image_sample_', png: 'survey', url: 'image512' },
    { key: 'receipt_png', name: 'expense_receipt_sample_png_', png: 'receipt', url: 'file' },
    { key: 'receipt_pdf', name: 'expense_receipt_sample_pdf_', pdf: true, url: 'file' },
  ]
}

// サンプルのデータ一式を作る(Google のサービスを使わない純粋な関数)。
// today は 'YYYY-MM-DD'(スクリプトのタイムゾーンの今日)、files はダミー画像の URL
function buildSampleData_(today, files) {
  files = files || {}
  var other = buildSampleOtherSheets_(today, files)
  return {
    sheets: {
      Members: buildSampleMembers_(today, files),
      Projects: buildSampleProjects_(today),
      Tasks: buildSampleTasks_(today),
      Expenses: other.Expenses,
      FormSubmissions: other.FormSubmissions,
      DailyReports: other.DailyReports,
      Candidates: other.Candidates,
    },
    settings: buildSampleSettings_(today, files),
  }
}

// ---- テスト用のアカウント(TEST_ACCOUNTS) ----

// 'top=a@gmail.com, admin=b@gmail.com' を { top: 'a@gmail.com', ... } にする。
// 知らない枠の名前・メールアドレスの形でないもの・同じアドレスの重複はエラー
function parseSampleTestAccounts_(raw, slots) {
  slots = slots || SAMPLE_ACCOUNT_SLOTS
  var out = {}
  var seen = {}
  String(raw || '').split(/[,\n]/).map(function (s) { return s.trim() }).filter(Boolean).forEach(function (pair) {
    var i = pair.indexOf('=')
    var slot = (i < 0 ? pair : pair.slice(0, i)).trim()
    var email = (i < 0 ? '' : pair.slice(i + 1)).trim().toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(slots, slot)) {
      throw userError_('TEST_ACCOUNTS に知らない枠の名前があります: ' + slot + '(使える枠: ' + Object.keys(slots).join(', ') + ')')
    }
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) throw userError_('TEST_ACCOUNTS の ' + slot + ' のメールアドレスが正しくありません: ' + email)
    if (out[slot]) throw userError_('TEST_ACCOUNTS で同じ枠が2回指定されています: ' + slot)
    if (seen[email]) throw userError_('TEST_ACCOUNTS で同じメールアドレスが2つの枠に指定されています: ' + email)
    seen[email] = true
    out[slot] = email
  })
  return out
}

// サンプル以外のメンバーに登録されているアドレスが無いか確かめる(rows は MemberEmails の [id, email])
function assertSampleAccountsUnregistered_(accounts, rows, prefix) {
  prefix = prefix || SAMPLE_ID_PREFIX
  var wanted = {}
  Object.keys(accounts).forEach(function (slot) { wanted[accounts[slot]] = slot })
  rows.forEach(function (r) {
    var id = String(r[0] || '')
    if (id.indexOf(prefix) === 0) return
    String(r[1] || '').split(',').map(function (e) { return e.trim().toLowerCase() }).forEach(function (e) {
      if (wanted[e]) {
        throw userError_('TEST_ACCOUNTS の ' + wanted[e] + ' のアドレス(' + e + ')は、サンプル以外のメンバー(id: ' + id +
          ')に登録されています。そのままではそのメンバーとしてログインしてしまうため、別のアカウントを指定してください。')
      }
    })
  })
}

// ---- Settings の追加と、元に戻す処理(Google のサービスを使わない純粋な関数) ----

function sampleParseJson_(raw, fallback) {
  if (!raw) return fallback
  try { var v = JSON.parse(raw); return v == null ? fallback : v } catch (e) { return fallback }
}

// current: { キー: 今の値(文字列) } → { values: { キー: 書き込む値 }, state: 元に戻すための記録 }
// 役職の設定(roles)を使う団体向けに、サンプルの役職(サンプル班長)を今までの設定
// (role_levels など)ではなく roles の1件として足す形に変える
function sampleSettingsWithRoles_(settings) {
  var out = JSON.parse(JSON.stringify(settings))
  var name = SAMPLE_ROLES.restricted
  var role = { id: SAMPLE_ID_PREFIX + 'role-restricted', name: name, tier: 'admin', restricted: true }
  if (out.maps.role_permissions && out.maps.role_permissions[name]) role.sections = out.maps.role_permissions[name]
  if (out.maps.job_requirements && out.maps.job_requirements[name]) role.requiredSkills = out.maps.job_requirements[name]
  delete out.lists.role_levels
  delete out.lists.restricted_roles
  delete out.maps.role_permissions
  delete out.maps.job_requirements
  out.items.roles = [role]
  return out
}

function mergeSampleSettings_(current, additions, prefix) {
  prefix = prefix || SAMPLE_ID_PREFIX
  var values = {}
  var state = { lists: {}, items: {}, values: {}, maps: {}, scalars: {} }
  Object.keys(additions.lists).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = splitCsvList_(raw)
    var wasEmpty = base.length === 0
    if (wasEmpty && SAMPLE_LIST_DEFAULTS[key]) base = SAMPLE_LIST_DEFAULTS[key].slice()
    var added = additions.lists[key].filter(function (v) { return base.indexOf(v) === -1 })
    if (added.length === 0) return
    values[key] = base.concat(added).join(',')
    state.lists[key] = { wasEmpty: wasEmpty, added: added }
  })
  Object.keys(additions.items).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson_(raw, []).filter(function (x) { return !(x && String(x.id || '').indexOf(prefix) === 0) })
    values[key] = JSON.stringify(base.concat(additions.items[key]))
    state.items[key] = { wasEmpty: !raw, ids: additions.items[key].map(function (x) { return x.id }) }
  })
  Object.keys(additions.values).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson_(raw, [])
    var have = base.map(function (x) { return JSON.stringify(x) })
    var added = additions.values[key].filter(function (x) { return have.indexOf(JSON.stringify(x)) === -1 })
    if (added.length === 0) return
    values[key] = JSON.stringify(base.concat(added))
    state.values[key] = { wasEmpty: !raw, added: added.map(function (x) { return JSON.stringify(x) }) }
  })
  Object.keys(additions.maps).forEach(function (key) {
    var raw = String(current[key] || '')
    var base = sampleParseJson_(raw, {})
    var addedKeys = Object.keys(additions.maps[key]).filter(function (k) { return !Object.prototype.hasOwnProperty.call(base, k) })
    if (addedKeys.length === 0) return
    addedKeys.forEach(function (k) { base[k] = additions.maps[key][k] })
    values[key] = JSON.stringify(base)
    state.maps[key] = { wasEmpty: !raw, keys: addedKeys }
  })
  Object.keys(additions.scalars).forEach(function (key) {
    state.scalars[key] = { value: String(current[key] || '') }
    values[key] = String(additions.scalars[key])
  })
  return { values: values, state: state }
}

// mergeSampleSettings_ の記録をもとに、サンプルの分だけを取り除いた値を返す。
// サンプルを入れた後に画面から足した設定は残す
function restoreSampleSettings_(current, state) {
  var values = {}
  Object.keys(state.lists || {}).forEach(function (key) {
    var s = state.lists[key]
    var rest = splitCsvList_(current[key]).filter(function (v) { return s.added.indexOf(v) === -1 })
    var defaults = SAMPLE_LIST_DEFAULTS[key]
    var same = defaults && rest.length === defaults.length && rest.every(function (v, i) { return v === defaults[i] })
    values[key] = s.wasEmpty && (same || rest.length === 0) ? '' : rest.join(',')
  })
  Object.keys(state.items || {}).forEach(function (key) {
    var s = state.items[key]
    var rest = sampleParseJson_(current[key], []).filter(function (x) { return !(x && s.ids.indexOf(x.id) !== -1) })
    values[key] = s.wasEmpty && rest.length === 0 ? '' : JSON.stringify(rest)
  })
  Object.keys(state.values || {}).forEach(function (key) {
    var s = state.values[key]
    var remaining = s.added.slice()
    var rest = sampleParseJson_(current[key], []).filter(function (x) {
      var i = remaining.indexOf(JSON.stringify(x))
      if (i === -1) return true
      remaining.splice(i, 1)
      return false
    })
    values[key] = s.wasEmpty && rest.length === 0 ? '' : JSON.stringify(rest)
  })
  Object.keys(state.maps || {}).forEach(function (key) {
    var s = state.maps[key]
    var obj = sampleParseJson_(current[key], {})
    s.keys.forEach(function (k) { delete obj[k] })
    values[key] = s.wasEmpty && Object.keys(obj).length === 0 ? '' : JSON.stringify(obj)
  })
  Object.keys(state.scalars || {}).forEach(function (key) { values[key] = state.scalars[key].value })
  return values
}

// ---- シートへの書き込み・削除 ----

var SAMPLE_SETTINGS_STATE_KEY = 'SAMPLE_SETTINGS_STATE'
var SAMPLE_FILE_IDS_KEY = 'SAMPLE_FILE_IDS'
// サンプルのメンバーが作った行(テスト用のアカウントで操作して増えた行)を見分ける列
var SAMPLE_OWNER_COLUMNS = { Tasks: 'creator_id', Expenses: 'applicant_id', FormSubmissions: 'submitter_id', DailyReports: 'member_id' }

function isSampleId_(v, prefix) { return String(v || '').indexOf(prefix || SAMPLE_ID_PREFIX) === 0 }

// 行を見出しに合わせて末尾に一括で書き込む(書式なしテキストにして、日付の自動変換を避ける)
// サンプルのタスクの行の選択肢の値を、今のシートの形式にする
function sheetSampleTaskRow_(o) {
  var out = {}
  Object.keys(o).forEach(function (k) { out[k] = o[k] })
  ;['status', 'difficulty', 'priority', 'importance', 'visibility', 'department'].forEach(function (k) {
    if (o[k] !== undefined && o[k] !== '') out[k] = sheetValue_(k, o[k])
  })
  if (o.approval_status) out.approval_status = sheetCode_('approval', o.approval_status)
  if (o.history_json) {
    try { out.history_json = JSON.stringify(JSON.parse(o.history_json).map(sheetHistoryEntry_)) } catch (e) {}
  }
  if (o.schedule_json) {
    try { out.schedule_json = JSON.stringify(mapScheduleCodes_(JSON.parse(o.schedule_json), sheetCode_)) } catch (e) {}
  }
  return out
}

function appendSampleRows_(sheetName, objects) {
  if (objects.length === 0) return 0
  var sheet = getSheet_(sheetName)
  var headers = headerRow_(sheet)
  var unknown = {}
  objects.forEach(function (o) { Object.keys(o).forEach(function (k) { if (headers.indexOf(k) === -1) unknown[k] = true }) })
  if (Object.keys(unknown).length) {
    throw userError_(sheetName + 'シートに列が見つかりません: ' + Object.keys(unknown).join(', ') + '。setupOhsumi() を実行してください。')
  }
  var values = objects.map(function (o) { return headers.map(function (h) { return o[h] != null ? String(o[h]) : '' }) })
  var range = sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length)
  range.setNumberFormat('@')
  range.setValues(values)
  return values.length
}

// 条件に合う行を下から削除する(連続した行はまとめて削除する)
function deleteSampleRows_(sheetName, match) {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sheet = ss.getSheetByName(sheetName)
  if (!sheet || sheet.getLastRow() < 2) return 0
  var headers = headerRow_(sheet)
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues()
  var hit = rows.map(function (r) {
    var o = {}
    headers.forEach(function (h, i) { o[h] = r[i] })
    return match(o)
  })
  var deleted = 0
  var i = hit.length - 1
  while (i >= 0) {
    if (!hit[i]) { i--; continue }
    var end = i
    while (i >= 0 && hit[i]) i--
    sheet.deleteRows(i + 3, end - i)
    forgetSheetGrid_()
    deleted += end - i
  }
  return deleted
}

function createSampleFiles_() {
  var folder = getUploadFolder_()
  var stamp = Date.now()
  var ids = []
  var urls = {}
  sampleFileSpecs_().forEach(function (spec) {
    var blob = spec.pdf
      ? Utilities.newBlob('<html><body style="font-family:sans-serif"><h2>領収書(サンプル)</h2><p>交通費 3,400円</p><p>サンプル交通株式会社</p></body></html>', 'text/html', 'receipt.html').getAs('application/pdf')
      : Utilities.newBlob(Utilities.base64Decode(SAMPLE_IMAGES[spec.png]), 'image/png', spec.key + '.png')
    var file = folder.createFile(blob)
    file.setName(spec.name + stamp)
    // 元のスプレッドシートと同じく、誰とも共有しない
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)
    ids.push(file.getId())
    urls[spec.key] = spec.url === 'file' ? file.getUrl()
      : 'https://lh3.googleusercontent.com/d/' + file.getId() + (spec.url === 'image512' ? '=w512-h512-c' : '=w256-h256-c')
  })
  PropertiesService.getScriptProperties().setProperty(SAMPLE_FILE_IDS_KEY, JSON.stringify(ids))
  return urls
}

function trashSampleFiles_() {
  var props = PropertiesService.getScriptProperties()
  var ids = sampleParseJson_(props.getProperty(SAMPLE_FILE_IDS_KEY), [])
  var count = 0
  ids.forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); count++ } catch (e) { /* 既に削除済み */ }
  })
  // 記録に無いもの(途中で失敗した場合など)も、名前で探して消す
  try {
    var prefixes = sampleFileSpecs_().map(function (s) { return s.name })
    var files = getUploadFolder_().getFiles()
    while (files.hasNext()) {
      var f = files.next()
      var name = f.getName()
      if (prefixes.some(function (p) { return name.indexOf(p) === 0 }) && ids.indexOf(f.getId()) === -1) { f.setTrashed(true); count++ }
    }
  } catch (e) { /* アップロード用フォルダが無い */ }
  props.deleteProperty(SAMPLE_FILE_IDS_KEY)
  return count
}

function readSettingsValues_(keys) {
  var out = {}
  keys.forEach(function (k) { out[k] = getSettingValue_(k) || '' })
  return out
}

function sampleSettingKeys_(settings) {
  var keys = []
  ;['lists', 'items', 'values', 'maps', 'scalars'].forEach(function (g) { keys = keys.concat(Object.keys(settings[g] || {})) })
  return keys
}

// サンプル(または見本)を消す(ロックを取った中で呼ぶ)。kind は sampleKind_()・showcaseKind_()(省略するとサンプル)。
// 消すのは id(または作った人の id)が kind.prefix で始まる行だけ。返り値は削除した件数
function deleteSampleDataUnlocked_(kind) {
  kind = kind || sampleKind_()
  var prefix = kind.prefix
  var props = PropertiesService.getScriptProperties()
  var counts = {}
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    if (name === 'Settings') return
    var owner = SAMPLE_OWNER_COLUMNS[name]
    counts[name] = deleteSampleRows_(name, function (o) { return isSampleId_(o.id, prefix) || (owner && isSampleId_(o[owner], prefix)) })
  })
  // Settings: 足した分だけを取り除き、値が1つの設定は元の値に戻す
  var state = sampleParseJson_(props.getProperty(kind.stateKey), null)
  if (state) {
    var keys = sampleSettingKeys_(state)
    var restored = restoreSampleSettings_(readSettingsValues_(keys), state)
    Object.keys(restored).forEach(function (k) { updateSetting_(k, restored[k]) })
    props.deleteProperty(kind.stateKey)
  }
  // 画面で並べ替えた時などに残る、id の参照を外す
  ;['project_order', 'survey_invited_ids'].forEach(function (k) {
    var list = splitCsvList_(getSettingValue_(k))
    var rest = list.filter(function (v) { return !isSampleId_(v, prefix) })
    if (rest.length !== list.length) updateSetting_(k, rest.join(','))
  })
  // メンバーの通知の待ち行列・ログインの世代番号
  var all = props.getProperties()
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('notif_queue_' + prefix) === 0 || k.indexOf(SESSION_GEN_PREFIX + prefix) === 0) props.deleteProperty(k)
  })
  if (kind.files) counts.files = trashSampleFiles_()
  resetRequestProps_()
  return counts
}

function withSampleLock_(fn) {
  var lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    return fn()
  } finally {
    SpreadsheetApp.flush()
    lock.releaseLock()
  }
}

// ---- エディタから実行する関数(サンプル・見本のデータを入れる・消す) --------------------------------
//
// サンプル(崩れ確認用。'sample-')と見本(デモ・画面写真用。'demo-')は、同じ仕組みで入れて・消す。違いは kind に書く:
//   prefix        id の印。消す時は、id(または作った人の id)がこれで始まる行だけを消す
//   stateKey      Settings に足した分を覚えておくスクリプトプロパティ(消す時に、足した分だけを取り除く)
//   slots         ログインできる枠(TEST_ACCOUNTS の名前)と、その枠のメンバー
//   accountsProps ログインできるアカウントを読むスクリプトプロパティ(前にあるものから)
//   files         ダミー画像を作るか

function sampleKind_() {
  return {
    label: 'サンプルのデータ', icon: '🧪', prefix: SAMPLE_ID_PREFIX, stateKey: SAMPLE_SETTINGS_STATE_KEY, slots: SAMPLE_ACCOUNT_SLOTS,
    accountsProps: ['TEST_ACCOUNTS'], files: true, build: buildSampleData_, withRoles: sampleSettingsWithRoles_,
  }
}

function showcaseKind_() {
  return {
    label: '見本データ', icon: '🌱', prefix: SHOWCASE_ID_PREFIX, stateKey: SHOWCASE_SETTINGS_STATE_KEY, slots: SHOWCASE_ACCOUNT_SLOTS,
    accountsProps: ['DEMO_ACCOUNTS', 'TEST_ACCOUNTS'], files: false, build: buildShowcaseData_, withRoles: null,
  }
}

// 見本データは、テスト環境か、デモの団体(スクリプトプロパティ DEMO_ORG が true)だけで入れられる
function assertShowcaseAllowed_() {
  var demo = String(PropertiesService.getScriptProperties().getProperty('DEMO_ORG') || '').trim().toLowerCase() === 'true'
  if (!isTestEnvironment_() && !demo) {
    throw userError_('テスト環境かデモの団体ではないため実行できません。スクリプトプロパティ TEST_ENVIRONMENT か DEMO_ORG を true にしてから実行してください。')
  }
}

// サンプルのデータを作る(テスト環境専用)。既にサンプルがあれば、消してから作り直す
function seedSampleData() {
  assertSampleDataMatchesCode_()
  assertTestEnvironment_()
  return seedDataOfKind_(sampleKind_())
}

// サンプルのデータを消し、Settings を元に戻す(テスト環境専用)
function deleteSampleData() {
  assertSampleDataMatchesCode_()
  assertTestEnvironment_()
  return deleteDataOfKind_(sampleKind_())
}

// 見本データを作る(テスト環境・デモの団体)。既に見本があれば、消してから作り直す
function seedShowcaseData() {
  assertSampleDataMatchesCode_()
  assertShowcaseAllowed_()
  return seedDataOfKind_(showcaseKind_())
}

// 見本データを消し、Settings を元に戻す(テスト環境・デモの団体)
function deleteShowcaseData() {
  assertSampleDataMatchesCode_()
  assertShowcaseAllowed_()
  return deleteDataOfKind_(showcaseKind_())
}

function sampleAccountsOf_(kind) {
  var props = PropertiesService.getScriptProperties()
  for (var i = 0; i < kind.accountsProps.length; i++) {
    var raw = props.getProperty(kind.accountsProps[i])
    if (raw) return parseSampleTestAccounts_(raw, kind.slots)
  }
  return {}
}

function seedDataOfKind_(kind) {
  var props = PropertiesService.getScriptProperties()
  var accounts = sampleAccountsOf_(kind)
  var emailSheet = getMemberEmailsSheet_()
  var emailRows = emailSheet.getLastRow() > 1 ? emailSheet.getRange(2, 1, emailSheet.getLastRow() - 1, 2).getValues() : []
  assertSampleAccountsUnregistered_(accounts, emailRows, kind.prefix)

  if (getDiscordWebhookUrl_() || getSlackWebhookUrl_()) {
    console.warn('⚠ Discord・Slack の Webhook が設定されています。テスト環境では投稿せずログだけにします' +
      '(スクリプトプロパティ TEST_ALLOW_CHAT を true にすると、実際に投稿します)。')
  }

  return withSampleLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet()
    Object.keys(SHEET_HEADERS).forEach(function (name) { ensureSheetHeaders_(ss, name, SHEET_HEADERS[name]) })
    var removed = deleteSampleDataUnlocked_(kind)

    var files = kind.files ? createSampleFiles_() : {}
    var data = kind.build(todayStr_(), files)
    var counts = {}
    // 選択肢の値は、今のシートの形式(移行の前は日本語、後はコード)で書く
    data.sheets[SHEET_TASKS] = (data.sheets[SHEET_TASKS] || []).map(sheetSampleTaskRow_)
    Object.keys(data.sheets).forEach(function (name) { counts[name] = appendSampleRows_(name, data.sheets[name]) })

    // ログインできる枠のメンバーだけメールアドレスを登録する(ほかのメンバーには登録しない)
    Object.keys(accounts).forEach(function (slot) {
      appendRowByHeaders_(emailSheet, SHEET_MEMBER_EMAILS, { id: kind.slots[slot], email: accounts[slot] })
    })

    // 役職の設定(roles)を使っている団体では、サンプルの役職を roles に足す
    var settings = kind.withRoles && hasRolesSetting_() ? kind.withRoles(data.settings) : data.settings
    var merged = mergeSampleSettings_(readSettingsValues_(sampleSettingKeys_(settings)), settings, kind.prefix)
    Object.keys(merged.values).forEach(function (k) { updateSetting_(k, sheetSettingValue_(k, merged.values[k])) })
    props.setProperty(kind.stateKey, JSON.stringify(merged.state))

    bumpDataVersion()
    bumpMemberEmailsVersion_()
    var assigned = Object.keys(accounts).map(function (slot) { return slot + ' → ' + kind.slots[slot] + '(' + accounts[slot] + ')' })
    var msg = kind.icon + ' ' + kind.label + 'を作成しました(基準日: ' + todayStr_() + ')。' +
      Object.keys(counts).map(function (k) { return k + ' ' + counts[k] + ' 行' }).join('、') +
      (kind.files ? '、ダミー画像 ' + Object.keys(files).length + ' 件。' : '。') +
      (assigned.length ? ' ログインできるアカウント: ' + assigned.join('、') : ' ' + kind.accountsProps.join(' / ') + ' が未設定のため、ログインできるメンバーはいません。') +
      (removed.Tasks || removed.Members ? '(前回の分は削除してから作り直しました)' : '')
    console.log(msg)
    return msg
  })
}

function deleteDataOfKind_(kind) {
  return withSampleLock_(function () {
    var counts = deleteSampleDataUnlocked_(kind)
    bumpDataVersion()
    bumpMemberEmailsVersion_()
    var msg = '🧹 ' + kind.label + 'を削除しました: ' + Object.keys(counts).map(function (k) { return k + ' ' + counts[k] }).join('、') +
      '。Settings は足した分を取り除き、値が1つの設定は元の値に戻しました。'
    console.log(msg)
    return msg
  })
}
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
