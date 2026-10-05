# Ohsumi のブランド(ブランドガイドライン v0.4 の画面への当てはめ)

## 1. 色

`app/globals.css` の `:root` に、ブランドの基本の色を変数として定義し、画面の色はこれを基にしています。

| 名前 | 色 | 変数 | 画面で使うところ |
|---|---|---|---|
| Ohsumi Navy | `#0C1B32` | `--ohsumi-navy` | 見出し・本文(`--foreground`)・ロゴの文字 |
| Ohsumi Blue | `#2948E8` | `--ohsumi-blue` | ロゴのシンボル・重要語・線・CTA(`--primary`・`--ring`) |
| Pale Blue | `#EEF3FF` | `--ohsumi-pale-blue` | カード(`--card`)・選んだ項目の背景(`--accent`) |
| Off White | `#F6F8FC` | `--ohsumi-off-white` | 背景(`--background`)・ホーム画面のアイコンの背景 |

- 補助の色(枠線・薄い文字など)は、Navy と Blue の間の色にしています(`--border` `#D6DEED`・`--muted-foreground` `#4E5D75` など)。
- 状態の色(完了・期限超過など)は、意味が伝わるよう、これまでの色のままです(進行中だけ Ohsumi Blue)。
- 団体のテーマの色(団体の設定)は、`--primary`(ボタンなど)だけを変えます。**ロゴは `--ohsumi-blue`・`--ohsumi-wordmark` を使うので変わりません。**

## 2. ロゴ

- **形:** 円形のシンボル(縦横比 1:1。輪と、右側の点)+「Ohsumi」の文字。
- **実装:** `components/ohsumi/primitives.tsx` の `OhsumiMark`(シンボルだけ)と `OhsumiLogo`(シンボル + 文字)。
  - シンボルの幅と高さは、いつも同じにします(`width`・`height`・`aspect-ratio: 1 / 1`・縮まない)。
  - 回転・影・フィルターなどの効果は付けません。
- **確かめ:** `pnpm check:layout` で、表示されるすべてのシンボルについて、次を確かめます。
  - 縦横比が 1:1 であること
  - 色が Ohsumi Blue であること
  - 回転・影・フィルターが付いていないこと
  - 団体のテーマの色に変えても、シンボルの色が変わらないこと

### 2.1. 暗い表示の時のロゴ(案)

画面は今は明るい表示だけです(`colorScheme: 'light'`)。暗い表示を入れる時のために、次の案を用意しました。

| 案 | シンボル | 文字 | 向いている所 |
|---|---|---|---|
| **A(推奨。`.dark` に実装済み)** | Ohsumi Blue `#2948E8` のまま | 白 `#FFFFFF` | 画面の暗い表示。シンボルの色を変えないので、ブランドの色が保てる。暗い背景(`#08111F`)との明るさの比は約 2.9:1 で、図形に要る 3:1 をわずかに下回る(v0.9 の色。暗い表示を出す時は案 C も検討) |
| B | 白 | 白 | 写真・濃い色の背景の上(印刷物・スライド)。どの背景でも読みやすい |
| C | 明るい青 `#7D9BFF` | 白 | 暗い背景で、シンボルをもっと目立たせたい時。ブランドの色から外れるので、使う場所を決めてから |

A は、文字の色を変数 `--ohsumi-wordmark` で切り替えます(`.dark` で白)。B・C を使う時は、ガイドラインに足してから実装します。

## 3. アイコン

| 何 | ファイル | 形 |
|---|---|---|
| ブラウザのタブ | `app/icon.svg`・`app/favicon.ico`(16・32・48px) | シンボルだけ(背景は透明) |
| ホーム画面(iPhone・iPad) | `app/apple-icon.png`(180px) | シンボルだけ。背景は Off White(iOS は透明な部分を黒にするため) |
| ホーム画面(Android) | `app/manifest.ts` → `public/icons/icon-192.png`・`icon-512.png`・`icon-maskable-512.png` | シンボルだけ。背景は Off White。円に切り抜かれる用は余白を広く |

ロゴの形を変えた時は、`app/icon.svg` を直してから `node scripts/brand-icons.mjs` を実行すると、PNG・ICO を作り直します(ヘッドレスの Chrome で描きます)。

## 4. 旧名(Osumi・Orbit)

画面・README・docs で、「Osumi」は 0 件です。「Orbit」は、次の意図して残すものだけです(画面には出ません)。

| 場所 | 何か | 残す理由 |
|---|---|---|
| `registry/README.md` | `FSIFofficial/Orbit` | 実在するリポジトリの名前(変えない決まりのリポジトリを指す) |

ビルドした画面(`out/`)に「Orbit」「Osumi」が入っていないことも確かめました(`grep -ri 'orbit\|osumi' out/` が 0 件)。
