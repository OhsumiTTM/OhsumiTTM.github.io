# Ohsumi

学生団体などの組織運営を支える、タスク管理×人材育成のサービスです。未来宇宙産業フォーラム(FSIF)が開発・提供しています。

- サイト: https://ohsumi.fsif.jp
- 団体の導入・使い方は、利用マニュアル(FSIF が団体に渡します)を見てください。この README は、開発する人向けです。

## 仕組み

```
ブラウザ(Next.js の静的サイト・GitHub Pages)
   │  招待リンクの団体ID → レジストリが団体の GAS の URL を答える
   ▼
団体の GAS(gas/Code.gs。団体の Google アカウントで動く) ──▶ 団体のスプレッドシート(データ)
   │  状態の確認・週1回の集計値
   ▼
レジストリ(registry/Code.gs。FSIF のアカウントで動く) ◀── 監視(registry/monitor/Monitor.gs)
```

- **サイト**は静的な画面だけで、サーバーもデータベースも持ちません。団体のデータは FSIF を通りません。
- **団体の GAS** が、ログイン(Google の ID トークン → 団体のセッション)・読み書き・閲覧権限の絞り込み・通知・毎日の処理を受け持ちます。
- **レジストリ**は、団体ID・接続先・版・プラン・機能停止と提供停止の状態、アンケート、集計値を管理します。
- **監視**は、レジストリの状態を確かめ、異常を知らせます。

## ディレクトリ

| パス | 内容 |
|---|---|
| `app/` | 画面(Next.js App Router)。`(site)/` は紹介サイト、`registry-admin/` はレジストリの管理画面 |
| `components/ohsumi/` | アプリの画面(INPUT・OUTPUT・ADMIN・団体設定など) |
| `components/site/` | 紹介サイトの部品(申請フォームなど) |
| `lib/ohsumi/` | 状態管理・GAS との通信・型・翻訳(i18n)と、そのテスト |
| `lib/site/` | 紹介サイトの処理(申請フォームなど) |
| `content/legal/` | 利用規約・プライバシーポリシー・紹介ページの文 |
| `gas/src/` | 団体の GAS のソース(機能ごとのファイル)。`gas/Code.gs` はビルドで作る |
| `gas/sample/` | サンプル・見本のデータを作るコード(`gas/SampleData.gs` にまとめる。デモ・テストの団体だけで使う) |
| `registry/` | レジストリ(`Code.gs`)と監視(`monitor/Monitor.gs`) |
| `scripts/` | ビルド・CSP・GAS のまとめ・版・レイアウトの確認 |
| `e2e/` | ブラウザの通しテスト |
| `docs/features.md` | 機能一覧(実装済み・開発予定・将来構想) |

詳しい仕様は、[`gas/README.md`](gas/README.md)(団体の GAS)と [`registry/README.md`](registry/README.md)(レジストリ・監視)にあります。

## 開発

```bash
pnpm install
cp .env.local.example .env.local   # 空欄のままなら、ローカルのサンプルのデータで動く
pnpm dev                           # http://localhost:3000
```

団体の GAS につないで確かめる時は、`.env.local` に `NEXT_PUBLIC_REGISTRY_URL`(テスト用のレジストリ)と `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` を入れ、テスト用の団体の招待リンク(`http://localhost:3000/?org=<団体ID>`)から開きます。

### 確かめること(プッシュの前)

```bash
pnpm test           # ユニットテスト(Vitest。GAS・レジストリのテストも含む)
pnpm build          # 本番のビルド(CSP の挿入・GAS のそろい方の確認を含む)
pnpm check:layout   # スマホ・PC の幅で、はみ出しが無いか
pnpm test:e2e       # ブラウザの通しテスト
```

## 団体の GAS・レジストリを変える時

1. `gas/src/` を直す(`gas/Code.gs` は直接直さない)
2. `pnpm gas:build` で `gas/Code.gs`・`gas/SampleData.gs` を作り直す
3. `pnpm gas:version` で版を上げる(中身が変わったファイルだけ上がる)
4. `registry/Code.gs` の `KNOWN_GAS_VERSIONS` に新しい版を足す。安全の修正なら `security`、古い版を使わせないなら `required` を付ける
5. マージした後の入れ替えの順: レジストリ → FSIF の団体 → デモの団体(`SampleData.gs` も) → テンプレート

団体の GAS の更新は、団体ごとに担当者がコードを貼り替える必要があります。変更は、なるべく月1回にまとめてください。
止めたい機能や上限の調整は、GAS を変えずにレジストリの管理画面からできるものがあります(`gas/README.md`)。

## デプロイ

`main` にマージすると、`.github/workflows/deploy.yml` がビルドして GitHub Pages に公開します。

| Secret | 内容 |
|---|---|
| `REGISTRY_URL` | レジストリのウェブアプリの URL(必須) |
| `GOOGLE_OAUTH_CLIENT_ID` | 団体のログインの OAuth クライアントID(必須) |
| `REGISTRY_OAUTH_CLIENT_ID` | レジストリの管理画面のログインの OAuth クライアントID |
| `SUPABASE_URL`・`SUPABASE_ANON_KEY` | 申請フォームのロゴの保存先(無ければロゴ欄は出ない) |
| `FEEDBACK_FORM_URL` | フィードバックの送り先(任意) |
| `GOOGLE_CALENDAR_READ` | カレンダーの予定の表示(入れない。入れるとプライバシーポリシーの変更と Google の審査が要る) |

団体の GAS の URL は Secrets に入れません(招待リンクの団体ID から、レジストリが答えます)。

## 守ること

- **CSP を緩めない。** `pnpm build` の最後に `scripts/csp.mjs` が各 HTML に CSP を入れます。インラインのスクリプトはハッシュで許可し、`'unsafe-inline'`・iframe・外部のスクリプト・解析ツールは使いません。新しい接続先が要る時は、`scripts/csp.mjs` の一覧に用途と一緒に足します。
- **OhsumiTTM のアカウントで、ほかのリポジトリを GitHub Pages で公開しない。** 同じオリジンになり、ブラウザに保存したログイン情報を読まれるおそれがあります。
- **実在の人の名前・メールアドレスを、画面の見本・テストのデータ・スクリーンショットに入れない。**
- **Secrets の値・共有鍵・登録コードを、コード・ログ・PR に書かない。**

## ライセンス

[MIT License](LICENSE)(Copyright (c) 2026 FSIF)
