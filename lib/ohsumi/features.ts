// 機能の有効・無効(ビルド時の環境変数で切り替える)。
//
// Googleカレンダーの予定の表示と、日程候補の空き時間の確認は、機密のスコープ
// (google-sheet-sync.ts の CALENDAR_SCOPE)が必要なため、Google の審査を
// 受けるまで停止している。コードは残してあり、NEXT_PUBLIC_GOOGLE_CALENDAR_READ を
// 'true' にしてビルドすると有効になる(OAuth クライアントに calendar スコープを
// 追加し、審査を通過している必要がある)。
export const isGoogleCalendarReadEnabled = process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_READ === 'true'

// Googleカレンダーとの連携のボタン(予定に追加するリンク・カレンダーの読み込み・空き時間の確認と、
// その「使えません」の表示)。いったん隠している。NEXT_PUBLIC_GOOGLE_CALENDAR_BUTTONS を
// 'true' にしてビルドすると出る(予定の表示・空き時間の確認は isGoogleCalendarReadEnabled も要る)
export const isGoogleCalendarButtonsEnabled = process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_BUTTONS === 'true'
