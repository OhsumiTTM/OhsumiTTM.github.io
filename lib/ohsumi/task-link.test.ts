// タスクのリンク(lib/ohsumi/task-link.ts): 作り方・読み方と、詳細を開いている間のアドレスバー
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTaskParam, readTaskParam, setTaskParam, taskLink } from './task-link'

const ORG = 'org_AAAAAAAAAAAAAAAAAAAA'
let href = ''
const replaceState = vi.fn((_s: unknown, _t: string, url: string) => { href = 'https://site.example' + url })

beforeEach(() => {
  replaceState.mockClear()
  vi.stubGlobal('window', {
    get location() { return { href } },
    history: { state: null, replaceState },
  })
})
afterEach(() => vi.unstubAllGlobals())

const setUrl = (search: string) => { href = 'https://site.example/' + search }

describe('タスクのリンク', () => {
  it('形: 団体ID とタスクID だけを入れる', () => {
    expect(taskLink('https://site.example', '', ORG, '12')).toBe(`https://site.example/?org=${ORG}&task=12`)
    expect(taskLink('https://site.example', '/base', ORG, 't-1')).toBe(`https://site.example/base/?org=${ORG}&task=t-1`)
  })

  it('読み方: 形の違うタスクID は無視する', () => {
    expect(readTaskParam(`?org=${ORG}&task=12`)).toBe('12')
    expect(readTaskParam(`?org=${ORG}`)).toBeNull()
    for (const bad of ['?task=', '?task=a%2Fb', '?task=' + 'x'.repeat(65), '?task=<script>', '?task=1%20OR%201']) expect(readTaskParam(bad), bad).toBeNull()
  })

  it('開いている間は &task= を付け、閉じたら消す。ほかのパラメーターは残す', () => {
    setUrl(`?org=${ORG}&lang=en`)
    setTaskParam('12')
    expect(href).toBe(`https://site.example/?org=${ORG}&lang=en&task=12`)
    // 同じなら書き換えない
    replaceState.mockClear()
    setTaskParam('12')
    expect(replaceState).not.toHaveBeenCalled()
    clearTaskParam('12')
    expect(href).toBe(`https://site.example/?org=${ORG}&lang=en`)
  })

  it('?org= が無い時は付けない(どの団体のタスクか分からないリンクを作らない)', () => {
    setUrl('?lang=en')
    setTaskParam('12')
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('ほかの詳細が付けた &task= は消さない(ID を渡した時は、その ID の時だけ消す)', () => {
    setUrl(`?org=${ORG}&task=34`)
    clearTaskParam('12')
    expect(replaceState).not.toHaveBeenCalled()
    clearTaskParam()
    expect(href).toBe(`https://site.example/?org=${ORG}`)
  })
})
