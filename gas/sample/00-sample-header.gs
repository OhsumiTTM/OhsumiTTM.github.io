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

var OHSUMI_SAMPLE_DATA_VERSION = '2026.10.09-2'
// 組になる Code.gs の版。pnpm gas:build が、Code.gs の版に合わせて書き換える(手で直さない)
var SAMPLE_DATA_FOR_GAS_VERSION = ''

// Code.gs と組の版でなければ止める(Code.gs の関数の名前・引数が変わっていると、データを壊すことがあるため)
function assertSampleDataMatchesCode_() {
  var code = typeof OHSUMI_GAS_VERSION === 'undefined' ? '(見つかりません)' : OHSUMI_GAS_VERSION
  if (code !== SAMPLE_DATA_FOR_GAS_VERSION) {
    throw new Error('SampleData.gs(版 ' + OHSUMI_SAMPLE_DATA_VERSION + ')は Code.gs の版 ' + SAMPLE_DATA_FOR_GAS_VERSION +
      ' と組で使うものです。今の Code.gs の版は ' + code + ' です。SampleData.gs も貼り替えてください(リポジトリの gas/SampleData.gs)。')
  }
}
