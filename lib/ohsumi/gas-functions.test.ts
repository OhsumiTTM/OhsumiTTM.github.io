// GAS(団体の gas/Code.gs・レジストリの registry/Code.gs・監視の registry/monitor/Monitor.gs)の関数の決まりを確かめる:
// - エディタから実行する関数・ウェブアプリの入口・メニュー・トリガーから呼ばれる関数だけが、名前の最後に _ が無い
//   (それ以外は中で使うだけの関数なので _ を付け、エディタの「実行」の一覧に出さない)
// - エディタから実行する関数は、ファイルの先頭のコメントの一覧にあり、その順に並ぶ
// - 並び: setup → エディタから実行する関数 → 入口・メニュー・トリガー → 中で使うだけの関数
// - 使われていない関数が無い
// - setup は最初に、今のコードに無い関数を指すトリガーを消す
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const FILES = [
  { path: 'gas/Code.gs', setup: 'setupOhsumi' },
  { path: 'registry/Code.gs', setup: 'setupRegistry' },
  { path: 'registry/monitor/Monitor.gs', setup: 'setupMonitor' },
]

// 先頭のコメントの「■ 見出し」の下にある名前(// の後に空白3つで始まる行。「・」で区切って複数書ける)
function listedNames(source: string, heading: string): string[] {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => l.startsWith('// ■ ' + heading))
  if (start < 0) return []
  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('//') || line.startsWith('// ■')) break
    const m = line.match(/^\/\/ {3}([A-Za-z][\w・]*\w)/)
    if (m) names.push(...m[1].split('・'))
  }
  return names
}

function analyze(path: string) {
  const source = readFileSync(join(ROOT, path), 'utf8')
  const sf = ts.createSourceFile(path + '.js', source, ts.ScriptTarget.ES2019, true, ts.ScriptKind.JS)
  const functions = sf.statements.filter(ts.isFunctionDeclaration).map((f) => f.name!.text)
  const declared = new Set(functions)
  // 関数ごとに、中で参照している関数(名前・文字列)
  const refs = new Map<string, Set<string>>()
  const topRefs = new Set<string>()
  const collect = (node: ts.Node, out: Set<string>) => {
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && declared.has(n.text)) {
        const p = n.parent
        const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) ||
          (ts.isFunctionDeclaration(p) && p.name === n)
        if (!isName) out.add(n.text)
      }
      if (ts.isStringLiteral(n) && declared.has(n.text)) out.add(n.text)
      ts.forEachChild(n, visit)
    }
    visit(node)
  }
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      const out = new Set<string>()
      collect(st, out)
      refs.set(st.name!.text, out)
    } else {
      collect(st, topRefs)
    }
  }
  const triggers = [...source.matchAll(/newTrigger\('(\w+)'\)/g)].map((m) => m[1])
  const menus = [...source.matchAll(/addItem\('[^']*',\s*'(\w+)'\)/g)].map((m) => m[1])
  return {
    source,
    functions,
    refs,
    topRefs,
    triggers,
    menus,
    editor: listedNames(source, 'エディタから実行する関数'),
    entries: listedNames(source, 'ほかから呼ばれる関数'),
  }
}

describe.each(FILES)('$path の関数', ({ path, setup }) => {
  const a = analyze(path)

  it('先頭のコメントに、エディタから実行する関数の一覧がある(最初は setup)', () => {
    expect(a.source.split('\n').slice(0, 3).join('\n')).toMatch(/^\/\//)
    expect(a.editor[0]).toBe(setup)
    for (const name of [...a.editor, ...a.entries]) {
      expect(a.functions, name).toContain(name)
      expect(name.endsWith('_'), name).toBe(false)
    }
  })

  it('名前の最後に _ が無いのは、一覧にある関数(エディタ・入口・メニュー・トリガー)だけ', () => {
    const allowed = new Set([...a.editor, ...a.entries])
    const unlisted = a.functions.filter((f) => !f.endsWith('_') && !allowed.has(f))
    expect(unlisted, '中で使うだけの関数は、名前の最後に _ を付けてください(エディタから実行する関数なら、先頭のコメントの一覧に足してください)').toEqual([])
  })

  it('トリガー・メニューから呼ぶ関数は、一覧の「ほかから呼ばれる関数」にあり、_ が無い', () => {
    for (const name of [...a.triggers, ...a.menus]) {
      expect(a.entries, name).toContain(name)
      expect(name.endsWith('_'), name).toBe(false)
    }
  })

  it('並び: setup → エディタから実行する関数(一覧の順) → 入口・メニュー・トリガー(一覧の順) → 中で使うだけの関数', () => {
    const head = [...a.editor, ...a.entries]
    expect(a.functions.slice(0, head.length)).toEqual(head)
    expect(a.functions.slice(head.length).every((f) => f.endsWith('_'))).toBe(true)
  })

  it('使われていない関数が無い(一覧の関数から呼び出しをたどって、すべてに届く)', () => {
    const reached = new Set<string>()
    const stack = [...a.editor, ...a.entries, ...a.topRefs]
    while (stack.length) {
      const f = stack.pop()!
      if (reached.has(f)) continue
      reached.add(f)
      for (const r of a.refs.get(f) ?? []) stack.push(r)
    }
    expect(a.functions.filter((f) => !reached.has(f))).toEqual([])
  })

  it(`${setup} は最初に、今のコードに無い関数を指すトリガーを消す`, () => {
    const body = a.source.slice(a.source.indexOf(`function ${setup}(`))
    const firstStatement = body.slice(body.indexOf('{') + 1).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))
    expect(firstStatement).toBe('removeOrphanTriggers_()')

    // 以前の版の関数名(今は無い・_ を付けた)を指すトリガーだけを消す
    const triggers = [
      ...a.entries.filter((n) => a.triggers.includes(n)).map((n) => ({ handler: n })),
      { handler: 'removedLongAgo' },
      { handler: a.functions.find((f) => f.endsWith('_'))!.replace(/_$/, '') },
    ]
    const deleted: string[] = []
    const logs: string[] = []
    const ctx = vm.createContext({
      console: { log: (m: string) => logs.push(m), warn() {}, error() {} },
      ScriptApp: {
        getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler })),
        deleteTrigger: (t: { getHandlerFunction: () => string }) => deleted.push(t.getHandlerFunction()),
      },
    })
    vm.runInContext(a.source, ctx)
    const removed = (ctx as unknown as { removeOrphanTriggers_: () => string[] }).removeOrphanTriggers_()
    expect(deleted.sort()).toEqual(triggers.slice(-2).map((t) => t.handler).sort())
    expect([...removed].sort()).toEqual(deleted)
    expect(logs.join('\n')).toContain('removedLongAgo')
  })
})

describe('README', () => {
  it('README でエディタから実行するよう書いた関数は、名前に _ が無い関数', () => {
    const readme = readFileSync(join(ROOT, 'gas', 'README.md'), 'utf8') + readFileSync(join(ROOT, 'registry', 'README.md'), 'utf8')
    const all = new Map(FILES.flatMap((f) => analyze(f.path).functions.map((n) => [n, f.path] as const)))
    // `name()` の形で書いた関数(エディタから実行する書き方)
    for (const m of readme.matchAll(/`(\w+)\(\)`/g)) {
      if (!all.has(m[1])) continue
      expect(m[1].endsWith('_'), m[1]).toBe(false)
    }
  })
})
