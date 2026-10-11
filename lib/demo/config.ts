// デモ(<サイト>/demo/。営業で「こんな感じ」と触ってもらうためのもの)の設定。
// デモは、本番と同じ画面を、NEXT_PUBLIC_OHSUMI_DEMO=1 で別にビルドしたもの(scripts/build-demo.mjs)。
// 団体の GAS は、ブラウザの中で偽のスプレッドシートの上で動かす(lib/demo/engine.ts)。本物のレジストリ・団体の GAS・
// Google には一切つながない。下の URL は、画面の中で受け止める目印で、実在しない。
export const IS_DEMO = process.env.NEXT_PUBLIC_OHSUMI_DEMO === '1'
export const DEMO_BASE_PATH = '/demo'
export const DEMO_REGISTRY_URL = 'https://script.google.com/macros/s/OHSUMI_DEMO_REGISTRY/exec'
export const DEMO_GAS_URL = 'https://script.google.com/macros/s/OHSUMI_DEMO_ORG/exec'
export const DEMO_CLIENT_ID = 'ohsumi-demo.apps.googleusercontent.com'
// デモの団体の団体ID(gas の ORG_ID。決まった値にして、画面の団体の一覧に最初から入れておく)
export const DEMO_ORG_ID = 'org_OhsumiDemoTsubasa01'
// ブラウザの本物の sessionStorage に、デモの状態を置く時の名前の頭(本番の保存とぶつからないように)
export const DEMO_STORAGE_PREFIX = 'ohsumi-demo:'
