// デモ(/demo/)のビルドで、団体の GAS(gas/Code.gs)と見本データ(gas/SampleData.gs)を、ブラウザで読める1つの
// スクリプト(demo-gas.js)にまとめる。
//
// GAS のコードは、関数の宣言を並べただけの「ふつうのスクリプト」(strict モードではない)なので、モジュールにはせず、
// 1つの関数の中に入れて、偽の Google のサービス(lib/demo/google-env.ts)を引数で渡す。eval・new Function は使わない
// (CSP の script-src は 'self' のまま。このファイルは同じサイトから読む)。
// 画面の部品(lib/demo/engine.ts)は、self.__ohsumiDemoGas(env) を呼んで、決まった関数だけを受け取る。
//
// 使い方: node scripts/demo-gas.mjs <出力ファイル>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 偽のサービスとして渡す名前(lib/demo/google-env.ts の env のキーと同じ)
export const DEMO_GAS_GLOBALS = [
  'console', 'Logger', 'PropertiesService', 'ContentService', 'HtmlService', 'CacheService', 'LockService', 'SpreadsheetApp',
  'MailApp', 'LanguageApp', 'Session', 'DriveApp', 'CalendarApp', 'ScriptApp', 'UrlFetchApp', 'Utilities',
]
// 画面の部品が使う関数
export const DEMO_GAS_EXPORTS = ['doPost', 'setupOhsumi', 'seedShowcaseData']

/** @param {string} code gas/Code.gs @param {string} sample gas/SampleData.gs */
export function buildDemoGasScript(code, sample) {
  for (const name of DEMO_GAS_EXPORTS) {
    if (!new RegExp(`^function ${name}\\(`, 'm').test(code + '\n' + sample)) throw new Error(`demo-gas: ${name} が見つかりません`)
  }
  const params = DEMO_GAS_GLOBALS.map((g) => `var ${g} = env.${g};`).join('\n')
  // globalThis[name](古いトリガーの掃除)は、この中の関数を見ないので、空の入れ物にする
  return `/* Ohsumi デモ: 団体の GAS をブラウザの中で動かす(scripts/demo-gas.mjs が作る。直接直さない) */
self.__ohsumiDemoGas = function (env) {
${params}
var globalThis = {};
${code}
;
${sample}
;
return { ${DEMO_GAS_EXPORTS.map((n) => `${n}: ${n}`).join(', ')} };
};
`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(import.meta.dirname, '..')
  const out = process.argv[2]
  if (!out) throw new Error('使い方: node scripts/demo-gas.mjs <出力ファイル>')
  const script = buildDemoGasScript(readFileSync(join(root, 'gas', 'Code.gs'), 'utf8'), readFileSync(join(root, 'gas', 'SampleData.gs'), 'utf8'))
  writeFileSync(out, script)
  console.log(`demo-gas: ${out}(${Math.round(script.length / 1024)} KB)`)
}
