// 書き出す値が Excel・Google スプレッドシートで数式として動かないようにする(CSV インジェクション対策)。
// = + - @ タブ 改行 で始まる文字は、先頭に ' を付けて文字として扱わせる。
// ただし、数(-5・+3.2・50% など)と「-」だけの値は、そのままにする(見た目を変えないため)
export function neutralizeFormula(value: unknown): string {
  const str = value == null ? '' : String(value)
  if (typeof value === 'number' || typeof value === 'boolean') return str
  if (str === '-' || /^[-+]?\d+(\.\d+)?%?$/.test(str)) return str
  return /^[=+\-@\t\r\n]/.test(str) ? "'" + str : str
}

// CSV の1つの欄を作る(数式の対策をしてから、必要なら " で囲む)
export function csvField(value: unknown): string {
  const str = neutralizeFormula(value)
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}
