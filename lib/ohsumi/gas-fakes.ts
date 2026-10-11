// 偽の Google のサービス(スプレッドシートのシート)。テスト(gas-guard-harness.ts・e2e/world.ts)と、
// ブラウザの中で団体の GAS を動かすデモ(lib/demo)で使う。node の機能を使わない(ブラウザでも動く)

export type Cell = string | number | boolean

// 偽のシート。Code.gs が使う呼び出しだけを実装し、知らない呼び出しは何もしない関数にする
export class FakeSheet {
  constructor(public name: string, public rows: Cell[][]) {}
  getName() { return this.name }
  getLastRow() { return this.rows.length }
  getLastColumn() { return this.rows[0]?.length ?? 0 }
  getMaxColumns() { return this.rows[0]?.length ?? 0 }
  getMaxRows() { return this.rows.length }
  getDataRange() { return this.getRange(1, 1, Math.max(this.rows.length, 1), Math.max(this.rows[0]?.length ?? 0, 1)) }
  appendRow(row: Cell[]) { this.rows.push(row.slice()) }
  clearContents() { this.rows = [] }
  deleteRow(r: number) { this.rows.splice(r - 1, 1) }
  deleteRows(r: number, n: number) { this.rows.splice(r - 1, n) }
  getRange(a: number | string, col = 1, numRows = 1, numCols = 1) {
    const row = typeof a === 'number' ? a : 1
    const get = () => Array.from({ length: numRows }, (_, r) => Array.from({ length: numCols }, (_, c) => this.rows[row - 1 + r]?.[col - 1 + c] ?? ''))
    const set = (vs: Cell[][]) => vs.forEach((line, r) => line.forEach((v, c) => {
      while (this.rows.length < row + r) this.rows.push(new Array(this.getLastColumn()).fill(''))
      this.rows[row - 1 + r][col - 1 + c] = v
    }))
    return noop({
      getValues: get,
      getNumberFormats: () => get().map((l) => l.map(() => '@')),
      getDisplayValues: () => get().map((l) => l.map(String)),
      getValue: () => get()[0][0],
      setValue: (v: Cell) => set([[v]]),
      setValues: set,
    })
  }
}

// 知らない呼び出しには、何もしない関数(自分を返す)を返す
export function noop<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k]
      if (k === 'then') return undefined
      const f = () => noop({})
      return f
    },
  })
}
